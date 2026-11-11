import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, test, type TestContext } from 'node:test';
import { NativeEngine, type EngineStatus } from '../src/engine.js';
import { MAX_RECORDING_SECONDS } from '../src/limits.js';

let temporary: string;
let workerUrl: URL;

// A process fixture, rather than a mocked fork, exercises IPC typed-array
// transport, actual exit confirmation, escalation, and the child environment.
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'hosty-speech-engine-'));
  const file = join(temporary, 'worker.mjs');
  await writeFile(file, `
let model = '';
let running;
const devices = [{ id: 'metal:0', backend: 'metal', available: true,
  name: JSON.stringify({ secret: 'HOSTY_ENGINE_TEST_SECRET' in process.env, options: 'NODE_OPTIONS' in process.env }) },
  { id: 'cpu:0', backend: 'cpu', name: 'Test CPU', available: true }];
const send = value => process.send(value);
const ok = (id, result) => send({ id, ok: true, result });
const fail = (id, code) => send({ id, ok: false, error: { code, message: code } });
process.on('SIGTERM', () => {});
process.on('disconnect', () => process.exit(0));
process.on('message', message => {
  const { id, op } = message;
  if (op === 'devices') return ok(id, devices);
  if (op === 'cancel') {
    if (running && running.id === message.targetId && !running.ignore) {
      clearTimeout(running.timer); running = undefined; fail(message.targetId, 'ABORTED');
    }
    return;
  }
  if (op === 'close') {
    if (running?.ignore || model.startsWith('sticky-')) return;
    if (running) { clearTimeout(running.timer); fail(running.id, 'ABORTED'); }
    return process.exit(0);
  }
  if (op === 'load') {
    if (message.modelPath.includes('fail')) return fail(id, 'MODEL_LOAD');
    model = message.modelId;
    const result = { version: '0.4.1', backend: message.modelPath.includes('mismatch') ? 'cpu' : message.backend === 'auto' ? 'metal' : message.backend,
      device: 'Test device', devices };
    const limits = { 'limit-zero': 0, 'limit-finite': 1.5, 'limit-large': 5218.56,
      'limit-negative': -1, 'limit-nan': NaN, 'limit-infinite': Infinity, 'limit-string': '30', 'limit-null': null };
    if (Object.hasOwn(limits, model)) result.modelMaxDurationSeconds = limits[model];
    if (message.modelPath.includes('slow')) return setTimeout(() => ok(id, result), 300);
    return ok(id, result);
  }
  if (op === 'transcribe') {
    if (!(message.samples instanceof Float32Array)) return fail(id, 'WRONG_PCM');
    const value = Math.round(message.samples[0] * 10);
    if (value === -5) return process.exit(17);
    if (value === 1 || value === 2) {
      running = { id, ignore: value === 2, timer: setTimeout(() => {
        running = undefined; ok(id, { text: model + ':' + process.pid, language: message.language });
      }, value === 2 ? 30000 : 150) };
      return;
    }
    return ok(id, { text: model + ':' + process.pid, language: message.language });
  }
});
send({ type: 'ready' });
`);
  workerUrl = pathToFileURL(file);
});

after(async () => { await rm(temporary, { recursive: true, force: true }); });

function engineFor(t: TestContext): NativeEngine {
  const engine = new NativeEngine({ workerUrl, startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 60, cancellationGraceMs: 30, loadTimeoutMs: 5_000 });
  t.after(() => engine.close());
  return engine;
}

const selection = (name = 'first', backend: 'auto' | 'metal' | 'cpu' = 'auto') => ({
  modelId: name, modelPath: join(temporary, `${name}.gguf`), backend,
});
const signal = () => new AbortController().signal;
const pcm = (value = 0.5) => new Float32Array([value, 0]);
const pidFrom = (text: string) => Number(text.split(':')[1]);

test('keeps one resident model, reports effective device, and confirms retirement on switch', async (t) => {
  const engine = engineFor(t);
  const statuses: EngineStatus[] = [];
  engine.on('status', (status) => statuses.push(status));
  await engine.load(selection());
  assert.deepEqual(engine.status(), { phase: 'ready', modelId: 'first', backend: 'metal', device: 'Test device', busy: false });
  const first = await engine.transcribe(pcm(), 'en', signal());
  const second = await engine.transcribe(pcm(), 'en', signal());
  assert.equal(second.text, first.text);
  await engine.load(selection('second', 'cpu'));
  const changed = await engine.transcribe(pcm(), 'en', signal());
  assert.notEqual(pidFrom(first.text), pidFrom(changed.text));
  assert.throws(() => process.kill(pidFrom(first.text), 0), { code: 'ESRCH' });
  assert.equal(engine.status().backend, 'cpu');
  assert.ok(statuses.some((status) => status.phase === 'loading'));
  assert.ok(statuses.some((status) => status.busy));
});

test('failed candidate and mismatched explicit backend preserve the working model', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const before = await engine.transcribe(pcm(), 'en', signal());
  await assert.rejects(engine.load(selection('fail')), { code: 'MODEL_LOAD' });
  assert.equal(engine.status().phase, 'ready');
  assert.equal(engine.status().modelId, 'first');
  await assert.rejects(engine.load(selection('mismatch', 'metal')), { code: 'BACKEND_MISMATCH' });
  assert.equal((await engine.transcribe(pcm(), 'en', signal())).text, before.text);
});

test('refuses concurrent inference and switching without interrupting accepted audio', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const recognition = engine.transcribe(pcm(0.1), 'en', signal());
  assert.equal(engine.status().busy, true);
  await assert.rejects(engine.transcribe(pcm(), 'en', signal()), { code: 'BUSY' });
  await assert.rejects(engine.load(selection('second')), { code: 'BUSY' });
  assert.match((await recognition).text, /^first:/);
  assert.equal(engine.status().busy, false);
});

test('cooperative cancellation keeps the loaded model usable', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const before = await engine.transcribe(pcm(), 'en', signal());
  const controller = new AbortController();
  const recognition = engine.transcribe(pcm(0.1), 'en', controller.signal);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(recognition, { name: 'AbortError', code: 'ABORTED' });
  assert.equal(engine.status().phase, 'ready');
  assert.equal((await engine.transcribe(pcm(), 'en', signal())).text, before.text);
});

test('uncooperative cancellation confirms worker death before rejection and recovers the saved model', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const before = await engine.transcribe(pcm(), 'en', signal());
  const controller = new AbortController();
  const recognition = engine.transcribe(pcm(0.2), 'en', controller.signal);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(recognition, { name: 'AbortError', code: 'ABORTED' });
  assert.throws(() => process.kill(pidFrom(before.text), 0), { code: 'ESRCH' });
  assert.equal(engine.status().phase, 'failed');
  const recovered = await engine.transcribe(pcm(), 'en', signal());
  assert.match(recovered.text, /^first:/);
  assert.notEqual(pidFrom(before.text), pidFrom(recovered.text));
  assert.equal(engine.status().phase, 'ready');
});

test('native crash is observable and the next request loads the saved selection', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  await assert.rejects(engine.transcribe(pcm(-0.5), 'en', signal()), { code: 'WORKER_EXITED' });
  assert.equal(engine.status().phase, 'failed');
  assert.equal(engine.status().backend, null);
  assert.equal(engine.status().modelId, 'first');
  assert.match((await engine.transcribe(pcm(), 'en', signal())).text, /^first:/);
});

test('aborting a candidate load preserves the previous process', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const before = await engine.transcribe(pcm(), 'en', signal());
  const controller = new AbortController();
  const loading = engine.load(selection('slow'), controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(loading, { name: 'AbortError' });
  assert.equal(engine.status().modelId, 'first');
  assert.equal((await engine.transcribe(pcm(), 'en', signal())).text, before.text);
});

test('device discovery sanitizes child credentials and Node injection settings', async (t) => {
  const previousSecret = process.env.HOSTY_ENGINE_TEST_SECRET;
  const previousOptions = process.env.NODE_OPTIONS;
  process.env.HOSTY_ENGINE_TEST_SECRET = 'synthetic-sentinel';
  process.env.NODE_OPTIONS = '--no-warnings';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.HOSTY_ENGINE_TEST_SECRET;
    else process.env.HOSTY_ENGINE_TEST_SECRET = previousSecret;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousOptions;
  });
  const engine = engineFor(t);
  const [first, second] = await Promise.all([engine.devices(), engine.devices()]);
  assert.deepEqual(JSON.parse(first[0].name), { secret: false, options: false });
  first[0].name = 'caller mutation';
  assert.notEqual((await engine.devices())[0].name, 'caller mutation');
  assert.equal(second.length, 2);
});

test('close waits for uncooperative native exit and remains idempotent', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const before = await engine.transcribe(pcm(), 'en', signal());
  const recognition = engine.transcribe(pcm(0.2), 'en', signal());
  const rejection = assert.rejects(recognition, { code: 'WORKER_EXITED' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  await engine.close();
  await rejection;
  assert.throws(() => process.kill(pidFrom(before.text), 0), { code: 'ESRCH' });
  assert.equal(engine.status().phase, 'idle');
  await engine.close();
  await assert.rejects(engine.load(selection()), { code: 'CLOSED' });
});

for (const failingStage of ['retiring the previous worker', 'cleaning up a rejected candidate'] as const) {
  test(`unconfirmed exit while ${failingStage} reports failure and never advertises a ready worker`, async (t) => {
    const engine = new NativeEngine({ workerUrl, startupTimeoutMs: 5_000, loadTimeoutMs: 5_000, shutdownTimeoutMs: 30 });
    let withheldChild: ChildProcess | undefined;
    let restoreKill = () => {};
    const actualKill = ChildProcess.prototype.kill;
    t.after(async () => {
      restoreKill();
      // A withheld close models the platform failing to confirm termination. The
      // test still stops its own real fixture child and observes its exit.
      await engine.close().catch((error: { code?: string }) => { assert.equal(error.code, 'WORKER_STOP_FAILED'); });
      if (withheldChild && withheldChild.exitCode === null && withheldChild.signalCode === null) {
        const exited = once(withheldChild, 'close');
        actualKill.call(withheldChild, 'SIGKILL');
        await exited;
      }
    });
    const retiring = failingStage === 'retiring the previous worker';
    await engine.load(selection(retiring ? 'sticky-previous' : 'first'));
    const previousPid = pidFrom((await engine.transcribe(pcm(), 'en', signal())).text);
    const kill = t.mock.method(ChildProcess.prototype, 'kill', function (this: ChildProcess, requestedSignal?: NodeJS.Signals | number) {
      if (requestedSignal === 'SIGKILL' && (retiring ? this.pid === previousPid : this.pid !== previousPid)) {
        withheldChild = this;
        return false;
      }
      return actualKill.call(this, requestedSignal);
    });
    restoreKill = () => kill.mock.restore();
    const states: EngineStatus[] = [];
    engine.on('status', (status) => states.push(status));
    await assert.rejects(engine.load(selection(retiring ? 'second' : 'sticky-mismatch', 'metal')), { code: 'WORKER_STOP_FAILED' });
    assert.ok(withheldChild, 'The fixture must exercise the unconfirmed native exit path');
    assert.equal(engine.status().phase, 'failed');
    assert.equal(engine.status().busy, false);
    assert.equal(engine.status().backend, null);
    assert.equal(engine.status().device, null);
    assert.match(engine.status().error ?? '', /exit could not be confirmed/);
    const failedAt = states.findIndex((status) => status.phase === 'failed');
    assert.ok(failedAt >= 0, 'An unconfirmed worker exit must publish its failure');
    assert.equal(states.slice(failedAt).some((status) => status.phase === 'ready'), false, 'Failure cleanup must not overwrite the fatal state with ready');
    await assert.rejects(engine.transcribe(pcm(), 'en', signal()), { code: 'WORKER_STOP_FAILED' });
    await assert.rejects(engine.load(selection('third')), { code: 'WORKER_STOP_FAILED' });
  });
}

test('unload confirms exit, clears readiness and permits later activation', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection());
  const before = await engine.transcribe(pcm(), 'en', signal());
  await engine.unload();
  assert.throws(() => process.kill(pidFrom(before.text), 0), { code: 'ESRCH' });
  assert.deepEqual(engine.status(), { phase: 'idle', modelId: null, backend: null, device: null, busy: false });
  await assert.rejects(engine.transcribe(pcm(), 'en', signal()), { code: 'NOT_READY' });
  await engine.load(selection('second'));
  assert.match((await engine.transcribe(pcm(), 'en', signal())).text, /^second:/);
});

test('aborting worker startup does not wait for native initialization', async (t) => {
  const delayed = join(temporary, 'delayed.mjs');
  await writeFile(delayed, "setTimeout(() => process.send({ type: 'ready' }), 30000);");
  const engine = new NativeEngine({ workerUrl: pathToFileURL(delayed), shutdownTimeoutMs: 100 });
  t.after(() => engine.close());
  const controller = new AbortController();
  const started = Date.now();
  const loading = engine.load(selection(), controller.signal);
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(loading, { name: 'AbortError' });
  assert.ok(Date.now() - started < 2000, 'Cancelled startup should release its process promptly');
  assert.equal(engine.status().busy, false);
});

test('publishes native unlimited duration and accepts the application boundary, not more', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection('limit-zero'));
  assert.equal(engine.status().modelMaxDurationSeconds, 0);
  const samples = new Float32Array(MAX_RECORDING_SECONDS * 16_000);
  assert.match((await engine.transcribe(samples, 'en', signal())).text, /^limit-zero:/);
  await assert.rejects(engine.transcribe(new Float32Array(samples.length + 1), 'en', signal()), { code: 'INVALID_AUDIO' });
  assert.equal(engine.status().phase, 'ready');
});

test('enforces a positive model limit in seconds without rounding it up', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection('limit-finite'));
  assert.equal(engine.status().modelMaxDurationSeconds, 1.5);
  const samples = new Float32Array(1.5 * 16_000);
  assert.match((await engine.transcribe(samples, 'en', signal())).text, /^limit-finite:/);
  await assert.rejects(engine.transcribe(new Float32Array(samples.length + 1), 'en', signal()), { code: 'INVALID_AUDIO' });
  await engine.load(selection('limit-large'));
  assert.equal(engine.status().modelMaxDurationSeconds, 5218.56);
  await assert.rejects(engine.transcribe(new Float32Array((MAX_RECORDING_SECONDS + 1) * 16_000), 'en', signal()), { code: 'INVALID_AUDIO' });
});

test('rejects invalid duration metadata before retiring the working model', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection('limit-finite'));
  const before = await engine.transcribe(pcm(), 'en', signal());
  for (const name of ['limit-negative', 'limit-nan', 'limit-infinite', 'limit-string', 'limit-null']) {
    await assert.rejects(engine.load(selection(name)), { code: 'WORKER_PROTOCOL' });
    assert.equal(engine.status().phase, 'ready');
    assert.equal(engine.status().modelId, 'limit-finite');
    assert.equal(engine.status().modelMaxDurationSeconds, 1.5);
    assert.equal((await engine.transcribe(pcm(), 'en', signal())).text, before.text);
  }
});

test('removes duration metadata for legacy loads, unloaded state and closed state', async (t) => {
  const engine = engineFor(t);
  await engine.load(selection('limit-finite'));
  await engine.load(selection('legacy'));
  assert.equal(Object.hasOwn(engine.status(), 'modelMaxDurationSeconds'), false);
  await engine.load(selection('limit-zero'));
  assert.equal(engine.status().modelMaxDurationSeconds, 0);
  await engine.unload();
  assert.equal(Object.hasOwn(engine.status(), 'modelMaxDurationSeconds'), false);
  await engine.load(selection('limit-finite'));
  await engine.close();
  assert.equal(Object.hasOwn(engine.status(), 'modelMaxDurationSeconds'), false);
});
