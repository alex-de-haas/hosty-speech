import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_MODEL, MODELS } from '../src/catalog.js';
import type { NativeEngine } from '../src/engine.js';
import type { EngineStatus, LoadOptions, RecognitionResult } from '../src/native-types.js';
import { SpeechService } from '../src/service.js';

const russian = MODELS.find((model) => model.languages.length === 1 && model.languages[0] === 'ru')!;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeEngine extends EventEmitter {
  current: EngineStatus = { phase: 'idle', modelId: null, backend: null, device: null, busy: false };
  loads: LoadOptions[] = [];
  calls: { samples: Float32Array; language: string; signal: AbortSignal }[] = [];
  beforeLoad?: (options: LoadOptions) => Promise<void>;
  beforeUnload?: () => Promise<void>;
  recognize?: (signal: AbortSignal) => Promise<RecognitionResult>;
  failure?: Error;
  unloads = 0;
  closeCalls = 0;
  onClose?: () => void;
  closed = false;
  status() { return { ...this.current }; }
  async devices() { return [{ id: 'cpu:0', backend: 'cpu', name: 'Fixture CPU', available: true }]; }
  async load(options: LoadOptions) {
    this.loads.push({ ...options });
    const previous = this.status();
    this.current = { ...previous, phase: 'loading', busy: true }; this.emit('status');
    try {
      await this.beforeLoad?.(options);
      if (this.closed) throw new Error('The engine is closed.');
      if (this.failure) throw this.failure;
      this.current = { phase: 'ready', modelId: options.modelId, backend: options.backend === 'auto' ? 'cpu' : options.backend, device: 'Fixture CPU', busy: false };
    } catch (error) { if (!this.closed) this.current = previous; throw error; }
    finally { this.emit('status'); }
  }
  async transcribe(samples: Float32Array, language: string, signal: AbortSignal) {
    if (this.current.busy) throw Object.assign(new Error('Busy'), { code: 'BUSY' });
    signal.throwIfAborted();
    this.current.busy = true; this.emit('status');
    this.calls.push({ samples, language, signal });
    try { return await this.recognize?.(signal) ?? { text: '  Пример текста.  ', language: 'ru' }; }
    finally { this.current.busy = false; this.emit('status'); }
  }
  async unload() {
    this.unloads++;
    await this.beforeUnload?.();
    this.current = { phase: 'idle', modelId: null, backend: null, device: null, busy: false };
    this.emit('status');
  }
  async close() {
    this.closeCalls++; this.closed = true;
    this.current = { phase: 'idle', modelId: null, backend: null, device: null, busy: false };
    this.onClose?.();
  }
}

async function fixture(t: TestContext, installed = true) {
  const path = await mkdtemp(join(tmpdir(), 'hosty-speech-service-test-'));
  const engine = new FakeEngine();
  const service = new SpeechService(join(path, 'data'), join(path, 'cache'), engine as unknown as NativeEngine);
  t.after(async () => { await service.close(); await rm(path, { recursive: true, force: true }); });
  const installedModels = new Set(installed ? MODELS.map(model => model.id) : []);
  service.downloads.isInstalled = (id) => installedModels.has(id);
  await service.initialize();
  return { service, engine, path, settingsPath: join(path, 'data/settings.json'), installedModels };
}

function recording(voiced = true, samples = 1_600) {
  const result = Buffer.alloc(44 + samples * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVE', 8);
  result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22); result.writeUInt32LE(16_000, 24); result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(samples * 2, 40);
  if (voiced) for (let i = 0; i < samples; i++) result.writeInt16LE(Math.round(Math.sin(i / 10) * 80), 44 + i * 2);
  return result;
}

test('service exposes process health separately from absent model readiness and requires installed models', async (t) => {
  const { service, engine } = await fixture(t, false);
  assert.equal(service.capabilities().ready, false);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(engine.loads.length, 0);
  assert.throws(() => service.activate({ revision: 0, modelId: russian.id, backend: 'auto' }), { status: 409, code: 'model_not_installed' });
  await assert.rejects(service.transcribe(recording(), 'auto', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
});

test('one shared selection persists and stale settings revisions cannot overwrite it', async (t) => {
  const { service, engine, path, settingsPath } = await fixture(t);
  service.activate({ revision: 0, modelId: russian.id, backend: 'cpu' });
  await service.waitForActivation();
  assert.deepEqual(service.snapshot().settings, { modelId: russian.id, backend: 'cpu', recordingLimitSeconds: null });
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.capabilities().ready, true);
  assert.equal(service.snapshot().effective.modelId, russian.id);
  assert.throws(() => service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' }), { status: 409, code: 'settings_conflict' });
  assert.equal(engine.loads.length, 2);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { revision: 1, settings: { modelId: russian.id, backend: 'cpu', recordingLimitSeconds: null } });

  const restoredEngine = new FakeEngine();
  const restored = new SpeechService(join(path, 'data'), join(path, 'cache'), restoredEngine as unknown as NativeEngine);
  restored.downloads.isInstalled = () => true;
  t.after(() => restored.close());
  await restored.initialize();
  assert.deepEqual(restored.snapshot().settings, service.snapshot().settings);
  assert.equal(restored.snapshot().revision, 1);
  assert.equal(restoredEngine.loads[0]?.modelId, russian.id);
});

test('a pending model switch is visible and blocks other switches and recognition until committed', async (t) => {
  const { service, engine } = await fixture(t);
  const load = deferred();
  engine.beforeLoad = () => load.promise;
  service.activate({ revision: 0, modelId: russian.id, backend: 'auto' });
  assert.equal(service.snapshot().activation.state, 'loading');
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(service.capabilities().ready, false);
  assert.throws(() => service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' }), { status: 429, code: 'speech_busy' });
  await assert.rejects(service.transcribe(recording(), 'auto', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
  load.resolve();
  await service.waitForActivation();
  assert.equal(service.snapshot().settings.modelId, russian.id);
  assert.equal(service.capabilities().ready, true);
});

test('native load failure preserves the previous shared model, revision, disk state and readiness', async (t) => {
  const { service, engine, settingsPath } = await fixture(t);
  service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' });
  await service.waitForActivation();
  const previous = await readFile(settingsPath, 'utf8');
  engine.failure = new Error('The requested accelerator is unavailable.');
  service.activate({ revision: 1, modelId: russian.id, backend: 'metal' });
  await service.waitForActivation();
  assert.equal(service.snapshot().activation.state, 'failed');
  assert.match(service.snapshot().activation.error ?? '', /accelerator.*unavailable/);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(service.snapshot().effective.modelId, DEFAULT_MODEL);
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.capabilities().ready, true);
  assert.equal(await readFile(settingsPath, 'utf8'), previous);
});

test('failure to persist a loaded candidate restores the prior effective selection and cleans temporary config', async (t) => {
  const { service, engine, settingsPath, path } = await fixture(t);
  service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' });
  await service.waitForActivation();
  await rm(settingsPath);
  await mkdir(settingsPath);
  service.activate({ revision: 1, modelId: russian.id, backend: 'cpu' });
  await service.waitForActivation();
  assert.equal(service.snapshot().activation.state, 'failed');
  assert.match(service.snapshot().activation.error ?? '', /could not be saved/);
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(service.snapshot().effective.modelId, DEFAULT_MODEL);
  assert.deepEqual(engine.loads.slice(-2).map((options) => options.modelId), [russian.id, DEFAULT_MODEL]);
  assert.equal((await readdir(join(path, 'data'))).includes('settings.json.tmp'), false);
});

test('save and rollback failure unload the uncommitted model, preserve disk settings and allow later recovery', async (t) => {
  const { service, engine, settingsPath } = await fixture(t);
  service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' });
  await service.waitForActivation();
  const saved = await readFile(settingsPath, 'utf8');
  // An unwritable temporary destination causes a real filesystem write failure
  // without damaging the last saved configuration.
  await mkdir(settingsPath + '.tmp');
  engine.beforeLoad = async (options) => {
    if (options.modelId === DEFAULT_MODEL) throw new Error('The previous model cannot be loaded.');
  };
  service.activate({ revision: 1, modelId: russian.id, backend: 'cpu' });
  await service.waitForActivation();
  assert.equal(service.snapshot().activation.state, 'failed');
  assert.match(service.snapshot().activation.error ?? '', /could not be saved.*could not be restored/);
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
  assert.deepEqual(engine.loads.slice(-2).map((options) => options.modelId), [russian.id, DEFAULT_MODEL]);
  assert.equal(engine.unloads, 1);
  assert.equal(engine.closed, false, 'Unloading a bad candidate must keep the engine reusable');
  assert.equal(service.snapshot().effective.modelId, null);
  assert.equal(service.capabilities().ready, false);
  await assert.rejects(service.transcribe(recording(), 'ru', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
  assert.equal(engine.calls.length, 0);

  await rm(settingsPath + '.tmp', { recursive: true });
  engine.beforeLoad = undefined;
  service.activate({ revision: 1, modelId: DEFAULT_MODEL, backend: 'auto' });
  await service.waitForActivation();
  assert.equal(service.snapshot().revision, 2);
  assert.equal(service.snapshot().activation.state, 'idle');
  assert.equal(service.capabilities().ready, true);
  assert.deepEqual(await service.transcribe(recording(), 'ru', new AbortController().signal), { text: 'Пример текста.', language: 'ru' });
});

test('first activation save failure unloads the only candidate and a later apply succeeds without restarting', async (t) => {
  const { service, engine, settingsPath, path } = await fixture(t, false);
  service.downloads.isInstalled = (id) => id === russian.id;
  await mkdir(settingsPath);
  service.activate({ revision: 0, modelId: russian.id, backend: 'auto' });
  await service.waitForActivation();
  assert.equal(service.snapshot().activation.state, 'failed');
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(service.snapshot().revision, 0);
  assert.equal(engine.loads.length, 1);
  assert.equal(engine.unloads, 1);
  assert.equal(engine.closed, false);
  assert.equal(service.capabilities().ready, false);
  assert.equal(service.snapshot().effective.modelId, null);
  assert.equal((await readdir(join(path, 'data'))).includes('settings.json.tmp'), false);
  await assert.rejects(service.transcribe(recording(), 'ru', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
  assert.equal(engine.calls.length, 0);

  await rm(settingsPath, { recursive: true });
  service.activate({ revision: 0, modelId: russian.id, backend: 'auto' });
  await service.waitForActivation();
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.snapshot().activation.state, 'idle');
  assert.equal(service.capabilities().ready, true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { revision: 1, settings: { modelId: russian.id, backend: 'auto', recordingLimitSeconds: null } });
  assert.deepEqual(await service.transcribe(recording(), 'ru', new AbortController().signal), { text: 'Пример текста.', language: 'ru' });
});

test('a ready worker for the wrong model cannot serve audio and applying the configured model restores readiness', async (t) => {
  const { service, engine } = await fixture(t);
  engine.current.modelId = russian.id;
  assert.equal(engine.status().phase, 'ready');
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(service.capabilities().ready, false);
  await assert.rejects(service.transcribe(recording(), 'en', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
  await assert.rejects(service.transcribe(recording(false), 'auto', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
  assert.equal(engine.calls.length, 0);
  service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' });
  await service.waitForActivation();
  assert.equal(service.capabilities().ready, true);
  assert.equal(service.snapshot().effective.modelId, DEFAULT_MODEL);
  assert.deepEqual(await service.transcribe(recording(), 'ru', new AbortController().signal), { text: 'Пример текста.', language: 'ru' });
});

test('shutdown stops a pending native load before waiting, preserves persisted settings and is idempotent', { timeout: 5_000 }, async (t) => {
  const { service, engine, settingsPath, path } = await fixture(t);
  service.activate({ revision: 0, modelId: DEFAULT_MODEL, backend: 'auto' });
  await service.waitForActivation();
  const saved = await readFile(settingsPath, 'utf8');
  const pending = deferred();
  engine.beforeLoad = () => pending.promise;
  engine.onClose = () => pending.reject(new Error('The worker stopped during model load.'));
  service.activate({ revision: 1, modelId: russian.id, backend: 'cpu' });
  assert.equal(service.snapshot().activation.state, 'loading');
  const firstClose = service.close();
  const repeatedClose = service.close();
  assert.equal(firstClose, repeatedClose, 'Every caller must await the same completed shutdown');
  await Promise.all([firstClose, repeatedClose]);
  assert.equal(engine.closeCalls, 1);
  assert.equal(engine.closed, true);
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
  assert.equal((await readdir(join(path, 'data'))).includes('settings.json.tmp'), false);
  assert.equal(service.capabilities().ready, false);
  assert.throws(() => service.activate({ revision: 1, modelId: russian.id, backend: 'auto' }), { status: 503, code: 'speech_stopping' });
  await assert.rejects(service.transcribe(recording(), 'ru', new AbortController().signal), { status: 503, code: 'speech_stopping' });
});

test('a model load completing concurrently with shutdown cannot persist its candidate settings', async (t) => {
  const { service, engine, settingsPath, path } = await fixture(t);
  const pending = deferred();
  // Simulate an already completed native result whose promise settles while
  // close begins, rather than cancellation rejecting the native request.
  engine.load = async (options) => { engine.loads.push(options); await pending.promise; };
  engine.onClose = () => pending.resolve();
  service.activate({ revision: 0, modelId: russian.id, backend: 'cpu' });
  await service.close();
  assert.equal(engine.closeCalls, 1);
  assert.equal(service.snapshot().revision, 0);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  await assert.rejects(readFile(settingsPath), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(path, 'data')), []);
});

test('language constraints reject unsupported requests before inference while silence remains empty', async (t) => {
  const { service, engine } = await fixture(t);
  service.activate({ revision: 0, modelId: russian.id, backend: 'auto' });
  await service.waitForActivation();
  await assert.rejects(service.transcribe(recording(), 'en', new AbortController().signal), { status: 400, code: 'speech_language_invalid' });
  assert.equal(engine.calls.length, 0);
  assert.deepEqual(await service.transcribe(recording(false), 'ru', new AbortController().signal), { text: '', language: 'ru' });
  assert.deepEqual(await service.transcribe(recording(false), 'auto', new AbortController().signal), { text: '', language: null });
  assert.equal(engine.calls.length, 0);
  assert.deepEqual(await service.transcribe(recording(), 'auto', new AbortController().signal), { text: 'Пример текста.', language: 'ru' });
  assert.equal(engine.calls[0]?.language, 'auto');
  assert.equal(engine.calls[0]?.samples.length, 1_600);
});

test('a running transcription blocks model mutation and cancellation reaches the worker', async (t) => {
  const { service, engine } = await fixture(t);
  const invoked = deferred();
  engine.recognize = (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    invoked.resolve();
  });
  const abort = new AbortController();
  const result = service.transcribe(recording(), 'ru', abort.signal);
  const rejection = assert.rejects(result, { name: 'AbortError' });
  await invoked.promise;
  assert.throws(() => service.activate({ revision: 0, modelId: russian.id, backend: 'auto' }), { status: 429, code: 'speech_busy' });
  abort.abort();
  await rejection;
  assert.equal(engine.calls[0]?.signal, abort.signal);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL);
  assert.equal(service.snapshot().revision, 0);
});

test('corrupt persisted settings fail startup clearly instead of silently resetting the shared selection', async (t) => {
  const path = await mkdtemp(join(tmpdir(), 'hosty-speech-settings-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await writeFile(join(path, 'settings.json'), '{"revision":1,"settings":{"modelId":"removed-model","backend":"auto"}}');
  const engine = new FakeEngine();
  const service = new SpeechService(path, join(path, 'cache'), engine as unknown as NativeEngine);
  t.after(() => service.close());
  await assert.rejects(service.initialize(), { status: 503, code: 'settings_invalid' });
  assert.equal(engine.loads.length, 0);
});

test('active model removal unloads the worker before deleting weights and leaves recognition unavailable', async (t) => {
  const { service, engine, installedModels } = await fixture(t);
  const operations: string[] = [];
  engine.beforeUnload = async () => { operations.push('unload'); };
  service.downloads.remove = async (id) => {
    operations.push('remove');
    assert.equal(engine.status().modelId, null);
    assert.equal(engine.status().phase, 'idle');
    installedModels.delete(id);
  };
  await service.removeModel(DEFAULT_MODEL);
  assert.deepEqual(operations, ['unload', 'remove']);
  assert.equal(service.downloads.isInstalled(DEFAULT_MODEL), false);
  assert.equal(service.snapshot().effective.modelId, null);
  assert.equal(service.snapshot().settings.modelId, DEFAULT_MODEL, 'Deletion must not silently select another recognition model');
  assert.equal(service.capabilities().ready, false);
  await assert.rejects(service.transcribe(recording(), 'auto', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
});

test('inactive model removal preserves the resident worker and its configured model', async (t) => {
  const { service, engine, installedModels } = await fixture(t);
  service.downloads.remove = async (id) => { installedModels.delete(id); };
  await service.removeModel(russian.id);
  assert.equal(engine.unloads, 0);
  assert.equal(service.downloads.isInstalled(russian.id), false);
  assert.equal(service.snapshot().effective.modelId, DEFAULT_MODEL);
  assert.equal(service.capabilities().ready, true);
  await assert.rejects(async () => service.removeModel('../outside'), { status: 404, code: 'model_unknown' });
});

test('active removal blocks recognition and competing settings changes until unloading and deletion finish', async (t) => {
  const { service, engine, installedModels } = await fixture(t);
  const unloading = deferred();
  engine.beforeUnload = () => unloading.promise;
  service.downloads.remove = async (id) => { installedModels.delete(id); };
  const removing = service.removeModel(DEFAULT_MODEL);
  try {
    assert.equal(service.capabilities().ready, false);
    await assert.rejects(service.transcribe(recording(), 'auto', new AbortController().signal), { status: 503, code: 'speech_not_ready' });
    await assert.rejects(async () => service.removeModel(russian.id), { status: 429, code: 'speech_busy' });
    await assert.rejects(async () => service.configureRecording({ revision: 0, recordingLimitSeconds: 120 }), { status: 429, code: 'speech_busy' });
    assert.throws(() => service.activate({ revision: 0, modelId: russian.id, backend: 'auto' }), { status: 429, code: 'speech_busy' });
  } finally { unloading.resolve(); await removing; }
  assert.equal(engine.calls.length, 0);
});

test('model removal and recording settings refuse inference and activation concurrency', async (t) => {
  const { service, engine } = await fixture(t);
  engine.current.busy = true;
  await assert.rejects(async () => service.removeModel(russian.id), { status: 429, code: 'speech_busy' });
  await assert.rejects(async () => service.configureRecording({ revision: 0, recordingLimitSeconds: 120 }), { status: 429, code: 'speech_busy' });
  engine.current.busy = false;
  const loading = deferred();
  engine.beforeLoad = () => loading.promise;
  service.activate({ revision: 0, modelId: russian.id, backend: 'auto' });
  try {
    await assert.rejects(async () => service.removeModel(DEFAULT_MODEL), { status: 429, code: 'speech_busy' });
    await assert.rejects(async () => service.configureRecording({ revision: 0, recordingLimitSeconds: 120 }), { status: 429, code: 'speech_busy' });
  } finally { loading.resolve(); await service.waitForActivation(); }
  assert.equal(engine.unloads, 0);
});

test('recording limits persist without an installed model or native reload and reject stale settings', async (t) => {
  const { service, engine, path, settingsPath } = await fixture(t, false);
  await service.configureRecording({ revision: 0, recordingLimitSeconds: 120 });
  assert.equal(engine.loads.length, 0);
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.snapshot().settings.recordingLimitSeconds, 120);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { revision: 1, settings: { modelId: DEFAULT_MODEL, backend: 'auto', recordingLimitSeconds: 120 } });
  await assert.rejects(async () => service.configureRecording({ revision: 0, recordingLimitSeconds: null }), { status: 409, code: 'settings_conflict' });
  const restoredEngine = new FakeEngine();
  const restored = new SpeechService(join(path, 'data'), join(path, 'cache'), restoredEngine as unknown as NativeEngine);
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.snapshot().settings.recordingLimitSeconds, 120);
  assert.equal(restored.snapshot().revision, 1);
  assert.equal(restoredEngine.loads.length, 0);
});

test('legacy settings without a recording limit normalize to automatic limits', async (t) => {
  const { path, settingsPath } = await fixture(t, false);
  await writeFile(settingsPath, JSON.stringify({ revision: 7, settings: { modelId: DEFAULT_MODEL, backend: 'auto' } }));
  const engine = new FakeEngine();
  const restored = new SpeechService(join(path, 'data'), join(path, 'cache'), engine as unknown as NativeEngine);
  t.after(() => restored.close());
  await restored.initialize();
  assert.equal(restored.snapshot().settings.recordingLimitSeconds, null);
  assert.equal(restored.snapshot().revision, 7);
  assert.equal(restored.capabilities().maxDurationSeconds, 600);
});

test('recording settings validate integer limits and serialize writes against activation and removal', async (t) => {
  const { service, engine } = await fixture(t);
  for (const limit of [14, 601, 15.5, '60', undefined, Number.NaN]) {
    await assert.rejects(async () => service.configureRecording({ revision: 0, recordingLimitSeconds: limit }), { status: 400 });
  }
  assert.equal(service.snapshot().revision, 0);
  const writing = service.configureRecording({ revision: 0, recordingLimitSeconds: 15 });
  try {
    await assert.rejects(async () => service.configureRecording({ revision: 0, recordingLimitSeconds: 60 }), { status: 429, code: 'speech_busy' });
    await assert.rejects(async () => service.removeModel(russian.id), { status: 429, code: 'speech_busy' });
    assert.throws(() => service.activate({ revision: 0, modelId: russian.id, backend: 'auto' }), { status: 429, code: 'speech_busy' });
  } finally { await writing; }
  assert.equal(engine.loads.length, 1, 'Only startup loads the existing recognition model');
  assert.equal(service.snapshot().settings.recordingLimitSeconds, 15);
});

test('failed recording persistence preserves the previous limit and revision and releases its write gate', async (t) => {
  const { service, settingsPath } = await fixture(t, false);
  await service.configureRecording({ revision: 0, recordingLimitSeconds: 60 });
  const saved = await readFile(settingsPath, 'utf8');
  await mkdir(settingsPath + '.tmp');
  await assert.rejects(async () => service.configureRecording({ revision: 1, recordingLimitSeconds: 120 }));
  assert.equal(service.snapshot().revision, 1);
  assert.equal(service.snapshot().settings.recordingLimitSeconds, 60);
  assert.equal(await readFile(settingsPath, 'utf8'), saved);
  await rm(settingsPath + '.tmp', { recursive: true });
  await service.configureRecording({ revision: 1, recordingLimitSeconds: null });
  assert.equal(service.snapshot().settings.recordingLimitSeconds, null);
  assert.equal(service.snapshot().revision, 2);
});

test('effective recording capabilities combine app and native model limits and survive model-only activation', async (t) => {
  const { service, engine } = await fixture(t);
  engine.current.modelMaxDurationSeconds = 0;
  assert.equal(service.capabilities().maxDurationSeconds, 600);
  engine.current.modelMaxDurationSeconds = 120.9;
  assert.equal(service.capabilities().maxDurationSeconds, 120);
  await service.configureRecording({ revision: 0, recordingLimitSeconds: 240 });
  assert.equal(service.capabilities().maxDurationSeconds, 120);
  assert.equal(service.capabilities().maxBytes, 120 * 32_000 + 4_096);
  await service.configureRecording({ revision: 1, recordingLimitSeconds: 60 });
  assert.equal(service.capabilities().maxDurationSeconds, 60);
  engine.current.modelMaxDurationSeconds = 0;
  assert.equal(service.capabilities().maxDurationSeconds, 60);
  service.activate({ revision: 2, modelId: russian.id, backend: 'auto' });
  await service.waitForActivation();
  assert.equal(service.snapshot().settings.recordingLimitSeconds, 60, 'Selecting a model must retain the app recording limit');
  assert.equal(service.capabilities().maxBytes, 60 * 32_000 + 4_096);
});

test('WAV duration and body size obey the same effective limit exposed to consumers', async (t) => {
  const { service, engine } = await fixture(t);
  await service.configureRecording({ revision: 0, recordingLimitSeconds: 15 });
  assert.equal(service.capabilities().maxDurationSeconds, 15);
  assert.deepEqual(await service.transcribe(recording(false, 15 * 16_000), 'auto', new AbortController().signal), { text: '', language: null });
  await assert.rejects(service.transcribe(recording(false, 15 * 16_000 + 1), 'auto', new AbortController().signal), { status: 413 });
  await assert.rejects(service.transcribe(Buffer.alloc(service.capabilities().maxBytes + 1), 'auto', new AbortController().signal), { status: 413 });
  assert.equal(engine.calls.length, 0, 'Silence and oversized audio must never reach native inference');
});
