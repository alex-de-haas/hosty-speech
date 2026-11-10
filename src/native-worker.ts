import { BACKEND_CHOICES, type DeviceInfo, type ParentMessage, type WorkerRequest } from './native-types.js';
import { MAX_RECORDING_SECONDS } from './limits.js';
import {
  TranscribeModel,
  getAvailableBackendsAsync,
  setLogHandler,
  version,
} from 'transcribe-cpp';

// Native diagnostics can include decoded tokens. They never belong in app logs.
setLogHandler(() => {});

let model: TranscribeModel | undefined;
let active: { id: string; abort: AbortController } | undefined;
let running: Promise<void> | undefined;
let closing = false;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

async function devices(): Promise<DeviceInfo[]> {
  const native = await getAvailableBackendsAsync();
  return native.map((device, index) => ({
    id: device.deviceId ?? `${device.kind}:${device.index ?? index}`,
    backend: device.kind.toLowerCase(),
    name: device.description || device.name,
    available: true,
  }));
}

function send(value: unknown, callback?: () => void): void {
  if (!process.connected || !process.send) return;
  process.send(value, undefined, undefined, (error: Error | null) => {
    if (error) process.exitCode = 1;
    callback?.();
  });
}

function errorResult(error: unknown): { code: string; message: string } {
  const value = error as { code?: unknown; name?: unknown; message?: unknown };
  const aborted = value?.name === 'AbortError' || value?.name === 'Aborted';
  return {
    code: aborted ? 'ABORTED' : typeof value?.code === 'string' ? value.code : 'NATIVE_ERROR',
    message: aborted ? 'Speech recognition was cancelled.'
      : typeof value?.message === 'string' ? value.message.slice(0, 600) : 'Native speech operation failed.',
  };
}

async function execute(request: WorkerRequest, signal: AbortSignal): Promise<unknown> {
  if (request.op === 'devices') return devices();
  if (request.op === 'load') {
    if (model) fail('ALREADY_LOADED', 'This worker already owns a recognition model.');
    if (!BACKEND_CHOICES.includes(request.backend)) fail('INVALID_BACKEND', 'Unknown acceleration backend.');
    if (version().version !== '0.4.1') fail('VERSION_MISMATCH', 'The native runtime must match transcribe-cpp 0.4.1.');
    const available = await devices();
    if (signal.aborted) fail('ABORTED', 'Model loading was cancelled.');
    if (request.backend !== 'auto' && !available.some((device) => device.backend === request.backend)) {
      fail('BACKEND_UNAVAILABLE', `The ${request.backend} backend is unavailable in this runtime or on this device.`);
    }
    model = await TranscribeModel.load(request.modelPath, { backend: request.backend });
    if (signal.aborted) fail('ABORTED', 'Model loading was cancelled.');
    const capabilities = model.capabilities;
    if (!model.roles.includes('asr') || capabilities.nativeSampleRate !== 16_000) {
      fail('INCOMPATIBLE_MODEL', 'The selected file is not a compatible 16 kHz recognition model.');
    }
    const modelMaxDurationSeconds = capabilities.maxAudioMs / 1000;
    if (!Number.isFinite(modelMaxDurationSeconds) || modelMaxDurationSeconds < 0) {
      fail('INCOMPATIBLE_MODEL', 'The recognition model did not report a valid input duration limit.');
    }
    const device = model.device;
    const backend = device.kind.toLowerCase();
    if (!BACKEND_CHOICES.includes(backend as typeof request.backend) || backend === 'auto') {
      fail('BACKEND_UNKNOWN', 'The runtime did not report a supported effective backend.');
    }
    if (request.backend !== 'auto' && backend !== request.backend) {
      fail('BACKEND_MISMATCH', 'The runtime did not use the explicitly selected backend.');
    }
    const name = device.description || device.name;
    if (!name) fail('DEVICE_UNKNOWN', 'The runtime did not report its effective compute device.');
    return { backend, device: name, devices: available, version: version().version, modelMaxDurationSeconds };
  }
  if (request.op === 'transcribe') {
    if (!model) fail('NOT_READY', 'No recognition model is loaded.');
    const capabilities = model.capabilities;
    const nativeLimitSeconds = capabilities.maxAudioMs / 1000;
    if (!Number.isFinite(nativeLimitSeconds) || nativeLimitSeconds < 0) {
      fail('INCOMPATIBLE_MODEL', 'The recognition model did not report a valid input duration limit.');
    }
    const maxDurationSeconds = Math.min(MAX_RECORDING_SECONDS, nativeLimitSeconds > 0 ? nativeLimitSeconds : MAX_RECORDING_SECONDS);
    if (!(request.samples instanceof Float32Array) || request.samples.length === 0 || request.samples.length > Math.floor(maxDurationSeconds * 16_000)) {
      fail('INVALID_AUDIO', `Expected between one sample and ${maxDurationSeconds} seconds of 16 kHz mono PCM.`);
    }
    for (const sample of request.samples) {
      if (!Number.isFinite(sample) || Math.abs(sample) > 1) fail('INVALID_AUDIO', 'PCM samples must be finite and normalized.');
    }
    const language = request.language === 'auto' ? '' : request.language;
    if (typeof language !== 'string' || (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language))) {
      fail('INVALID_LANGUAGE', 'Invalid recognition language.');
    }
    const languages = capabilities.languages;
    if (language && !languages.some((supported) => supported.split('-')[0].toLowerCase() === language.split('-')[0].toLowerCase())) {
      fail('UNSUPPORTED_LANGUAGE', 'The active recognition model does not support the requested language.');
    }
    const result = await model.transcribe(request.samples, { language: language || undefined, timestamps: 'none', signal });
    if (signal.aborted || result.aborted) fail('ABORTED', 'Speech recognition was cancelled.');
    if (result.truncated) fail('OUTPUT_TRUNCATED', 'The recognition model could not complete this recording.');
    return { text: result.text, language: result.language || language || (languages.length === 1 ? languages[0] : null) };
  }
  fail('INVALID_OPERATION', 'Unknown native operation.');
}

async function close(requestId: string): Promise<void> {
  closing = true;
  active?.abort.abort();
  await running;
  model?.dispose();
  model = undefined;
  // Let the binding's queued native disposals drain before disconnecting IPC.
  await new Promise<void>((resolve) => setImmediate(resolve));
  send({ id: requestId, ok: true, result: null }, () => process.disconnect());
}

process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object' || !('op' in raw)) return;
  const message = raw as ParentMessage;
  if (message.op === 'cancel') {
    if (active?.id === message.targetId) active.abort.abort();
    return;
  }
  if (typeof message.id !== 'string') return;
  if (message.op === 'close') {
    if (!closing) void close(message.id).catch(() => process.exit(1));
    return;
  }
  if (closing || active) {
    send({ id: message.id, ok: false, error: { code: 'BUSY', message: 'The native worker is busy.' } });
    return;
  }
  const abort = new AbortController();
  active = { id: message.id, abort };
  running = execute(message, abort.signal).then(
    (result) => send({ id: message.id, ok: true, result }),
    (error: unknown) => send({ id: message.id, ok: false, error: errorResult(error) }),
  ).finally(() => { active = undefined; });
});

// Abrupt parent exit cannot leave an orphan native worker behind.
process.once('disconnect', () => {
  // With no parent there is no observer left to complete cooperative shutdown.
  // Avoid freeing native buffers while an FFI compute still uses them.
  if (active) process.kill(process.pid, 'SIGKILL');
  else process.exit(0);
});
process.once('SIGTERM', () => {
  active?.abort.abort();
  if (!active) {
    model?.dispose();
    process.exit(0);
  }
  // The parent uses SIGKILL if native code cannot finish cooperative shutdown.
});

send({ type: 'ready' });
