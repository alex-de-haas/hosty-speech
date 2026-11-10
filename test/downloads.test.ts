import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CatalogModel } from '../src/catalog.js';
import { Downloads } from '../src/downloads.js';

const artifact = Buffer.from('small, public test model artifact');
const model: CatalogModel = {
  id: 'test-model', name: 'Test model', description: 'Synthetic fixture',
  languageLabel: 'Russian', languages: ['ru'], bytes: artifact.length,
  sha256: createHash('sha256').update(artifact).digest('hex'), filename: 'test.gguf',
  license: 'mit', revision: 'fixture-v1', repository: 'fixture/model', quantization: 'fixture',
  url: 'https://model.example.test/pinned/test.gguf',
};

async function directory(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'hosty-speech-download-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function respond(body: Uint8Array, headers?: HeadersInit): typeof fetch {
  return (async () => new Response(new Uint8Array(body), { headers })) as typeof fetch;
}

test('downloads install only a complete size- and checksum-verified artifact, then reuse it offline', async (t) => {
  const path = await directory(t);
  let complete!: () => void;
  const finish = new Promise<void>((resolve) => { complete = resolve; });
  let received!: () => void;
  const started = new Promise<void>((resolve) => { received = resolve; });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array(artifact.subarray(0, 5)));
      received();
      await finish;
      controller.enqueue(new Uint8Array(artifact.subarray(5)));
      controller.close();
    },
  });
  let fetches = 0;
  const downloads = new Downloads(path, [model], (async (url, init) => {
    fetches++;
    assert.equal(String(url), model.url);
    assert.equal(init?.redirect, 'manual');
    return new Response(stream, { headers: { 'content-length': String(artifact.length) } });
  }) as typeof fetch);
  t.after(() => downloads.close());
  await downloads.initialize();
  downloads.start(model.id);
  downloads.start(model.id);
  await started;
  assert.equal(downloads.isInstalled(model.id), false);
  await assert.rejects(readFile(downloads.path(model.id)), { code: 'ENOENT' });
  complete();
  await downloads.wait(model.id);
  assert.equal(fetches, 1);
  assert.deepEqual(await readFile(downloads.path(model.id)), artifact);
  assert.deepEqual(downloads.state()[model.id], { state: 'installed', received: artifact.length, total: artifact.length });
  assert.deepEqual(await readdir(path), [downloads.path(model.id).split('/').at(-1)]);
  downloads.start(model.id);
  assert.equal(fetches, 1);

  const restored = new Downloads(path, [model], (async () => { throw new Error('Must remain offline'); }) as typeof fetch);
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.isInstalled(model.id), true);
});

for (const [name, content, headers, message] of [
  ['checksum mismatch', Buffer.alloc(artifact.length, 9), undefined, /checksum/],
  ['truncated body', artifact.subarray(0, artifact.length - 1), undefined, /checksum|size/],
  ['oversized body', Buffer.concat([artifact, Buffer.from('!')]), undefined, /exceeded.*size/],
  ['incorrect declared size', artifact, { 'content-length': String(artifact.length + 1) }, /size/],
] as const) {
  test(`downloads reject ${name} without installing partial weights`, async (t) => {
    const path = await directory(t);
    const downloads = new Downloads(path, [model], respond(content, headers));
    t.after(() => downloads.close());
    await downloads.initialize();
    downloads.start(model.id);
    await downloads.wait(model.id);
    assert.equal(downloads.isInstalled(model.id), false);
    assert.equal(downloads.state()[model.id]?.state, 'failed');
    assert.match(downloads.state()[model.id]?.error ?? '', message);
    assert.deepEqual(await readdir(path), []);
  });
}

test('cancelling a stalled download aborts its request, removes temporary weights and permits retry', { timeout: 5_000 }, async (t) => {
  const path = await directory(t);
  let requested!: () => void;
  const ready = new Promise<void>((resolve) => { requested = resolve; });
  let attempts = 0, aborted = false;
  const downloads = new Downloads(path, [model], (async (_url, init) => {
    attempts++;
    if (attempts > 1) return new Response(new Uint8Array(artifact));
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(artifact.subarray(0, 3)));
        init!.signal!.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('Cancelled', 'AbortError'));
        }, { once: true });
        requested();
      },
    }));
  }) as typeof fetch);
  t.after(() => downloads.close());
  await downloads.initialize();
  downloads.start(model.id);
  await ready;
  await downloads.cancel(model.id);
  assert.equal(aborted, true);
  assert.equal(downloads.state()[model.id]?.state, 'idle');
  assert.equal(downloads.isInstalled(model.id), false);
  assert.deepEqual(await readdir(path), []);
  downloads.start(model.id);
  await downloads.wait(model.id);
  assert.equal(downloads.isInstalled(model.id), true);
  assert.equal(attempts, 2);
});

test('immediate cancellation and shutdown settle downloads without leaving temporary files', { timeout: 5_000 }, async (t) => {
  const path = await directory(t);
  const downloads = new Downloads(path, [model], (async (_url, init) => {
    init!.signal!.throwIfAborted();
    return new Response(new Uint8Array(artifact));
  }) as typeof fetch);
  await downloads.initialize();
  downloads.start(model.id);
  await downloads.close();
  assert.equal(downloads.isInstalled(model.id), false);
  assert.deepEqual(await readdir(path), []);
});

test('existing corrupt weights and abandoned temporary files never count as installed', async (t) => {
  const path = await directory(t);
  const downloads = new Downloads(path, [model], respond(artifact));
  t.after(() => downloads.close());
  await writeFile(downloads.path(model.id), Buffer.alloc(artifact.length, 0));
  await writeFile(downloads.path(model.id) + '.download', Buffer.from('stale partial'));
  await downloads.initialize();
  assert.equal(downloads.isInstalled(model.id), false);
  downloads.start(model.id);
  await downloads.wait(model.id);
  assert.equal(downloads.isInstalled(model.id), true);
  assert.deepEqual(await readFile(downloads.path(model.id)), artifact);
  assert.equal((await readdir(path)).some((name) => name.endsWith('.download')), false);
});

test('downloads reject insecure redirects and unknown model IDs', async (t) => {
  const path = await directory(t);
  let calls = 0;
  const downloads = new Downloads(path, [model], (async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://model.example.test/insecure' } });
  }) as typeof fetch);
  t.after(() => downloads.close());
  await downloads.initialize();
  assert.throws(() => downloads.start('../../outside'), { status: 404, code: 'model_unknown' });
  downloads.start(model.id);
  await downloads.wait(model.id);
  assert.equal(calls, 1);
  assert.match(downloads.state()[model.id]?.error ?? '', /secure/);
  assert.deepEqual(await readdir(path), []);
});

test('removing a downloaded model deletes only its final artifact and reports the change across restart', async (t) => {
  const path = await directory(t);
  const downloads = new Downloads(path, [model], respond(artifact));
  t.after(() => downloads.close());
  await downloads.initialize(); downloads.start(model.id); await downloads.wait(model.id);
  const temporary = downloads.path(model.id) + '.download';
  const unrelated = join(path, 'another-file.gguf');
  await writeFile(temporary, 'abandoned temporary fixture');
  await writeFile(unrelated, 'unrelated artifact');
  let changes = 0;
  downloads.on('change', () => {
    changes++;
    assert.equal(downloads.isInstalled(model.id), false);
    assert.deepEqual(downloads.state()[model.id], { state: 'idle', received: 0, total: artifact.length });
  });
  await downloads.remove(model.id);
  await assert.rejects(readFile(downloads.path(model.id)), { code: 'ENOENT' });
  assert.equal(changes, 1);
  assert.equal(await readFile(temporary, 'utf8'), 'abandoned temporary fixture');
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated artifact');
  const restarted = new Downloads(path, [model], respond(artifact));
  t.after(() => restarted.close());
  await restarted.initialize();
  assert.equal(restarted.isInstalled(model.id), false);
});

test('removing absent artifacts is idempotent and unknown IDs cannot select filesystem paths', async (t) => {
  const path = await directory(t);
  const downloads = new Downloads(path, [model], respond(artifact));
  t.after(() => downloads.close());
  await downloads.initialize();
  await downloads.remove(model.id);
  await downloads.remove(model.id);
  assert.deepEqual(downloads.state()[model.id], { state: 'idle', received: 0, total: artifact.length });
  await assert.rejects(downloads.remove('../outside'), { status: 404, code: 'model_unknown' });
  assert.deepEqual(await readdir(path), []);
});

test('removal refuses both downloading and verifying jobs without interrupting the eventual install', async (t) => {
  const path = await directory(t);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const downloads = new Downloads(path, [model], (async () => new Response(new ReadableStream<Uint8Array>({
    async start(controller) { await gate; controller.enqueue(new Uint8Array(artifact)); controller.close(); },
  }))) as typeof fetch);
  t.after(() => downloads.close());
  await downloads.initialize();
  const rejectedDuringNotification: Promise<void>[] = [];
  downloads.on('change', () => {
    const phase = downloads.state()[model.id]?.state;
    if (phase === 'downloading' || phase === 'verifying') {
      rejectedDuringNotification.push(assert.rejects(downloads.remove(model.id), { status: 409, code: 'model_busy' }));
    }
  });
  downloads.start(model.id);
  await assert.rejects(downloads.remove(model.id), { status: 409, code: 'model_busy' });
  finish();
  await downloads.wait(model.id);
  await Promise.all(rejectedDuringNotification);
  assert.ok(rejectedDuringNotification.length >= 2, 'Both starting and verifying notifications must keep the operation locked');
  assert.equal(downloads.isInstalled(model.id), true);
  assert.deepEqual(await readFile(downloads.path(model.id)), artifact);
});

test('same-model removal is serialized and blocks restart while another model may download independently', async (t) => {
  const path = await directory(t);
  const other: CatalogModel = { ...model, id: 'other-model' };
  const downloads = new Downloads(path, [model, other], respond(artifact));
  t.after(() => downloads.close());
  await downloads.initialize(); downloads.start(model.id); await downloads.wait(model.id);
  const removing = downloads.remove(model.id);
  await assert.rejects(downloads.remove(model.id), { status: 409, code: 'model_busy' });
  assert.throws(() => downloads.start(model.id), { status: 409, code: 'model_busy' });
  downloads.start(other.id);
  await Promise.all([removing, downloads.wait(other.id)]);
  assert.equal(downloads.isInstalled(model.id), false);
  assert.equal(downloads.isInstalled(other.id), true);
  downloads.start(model.id);
  await downloads.wait(model.id);
  assert.equal(downloads.isInstalled(model.id), true);
});

test('filesystem removal failures preserve verified metadata, emit no false change and release the operation lock', async (t) => {
  const path = await directory(t);
  const downloads = new Downloads(path, [model], respond(artifact));
  t.after(() => downloads.close());
  await downloads.initialize(); downloads.start(model.id); await downloads.wait(model.id);
  const previous = downloads.state();
  await rm(downloads.path(model.id));
  await mkdir(downloads.path(model.id));
  let changes = 0; downloads.on('change', () => { changes++; });
  await assert.rejects(downloads.remove(model.id));
  assert.equal(downloads.isInstalled(model.id), true);
  assert.deepEqual(downloads.state(), previous);
  assert.equal(changes, 0);
  await rm(downloads.path(model.id), { recursive: true });
  await downloads.remove(model.id);
  assert.equal(downloads.isInstalled(model.id), false);
  assert.equal(changes, 1);
});
