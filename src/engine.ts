import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INFERENCE_TIMEOUT_MS, MAX_RECORDING_SECONDS } from './limits.js';
import {
  BACKEND_CHOICES,
  type BackendChoice,
  type DeviceInfo,
  type EngineStatus,
  type LoadOptions,
  type LoadResult,
  type RecognitionResult,
  type WorkerCommand,
  type WorkerMessage,
} from './native-types.js';

export { BACKEND_CHOICES };
export type { BackendChoice, DeviceInfo, EngineStatus, LoadOptions, RecognitionResult };

export class EngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export class EngineBusyError extends EngineError {
  constructor() { super('BUSY', 'The speech engine is busy. Try again after the current operation.'); }
}

function aborted(): EngineError {
  const error = new EngineError('ABORTED', 'The speech operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
  terminalError?: Error;
}

interface WorkerHandle {
  child: ChildProcess;
  ready: Promise<void>;
  isReady: boolean;
  exited: boolean;
  exit: Promise<void>;
  pending: Map<string, Pending>;
  stopPromise?: Promise<void>;
  failure?: Error;
  retiring?: boolean;
}

export interface NativeEngineOptions {
  /** Private worker override for contract tests or a separately packaged worker. */
  workerUrl?: URL;
  startupTimeoutMs?: number;
  loadTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  cancellationGraceMs?: number;
  shutdownTimeoutMs?: number;
  /** Explicit app-owned native artifact locations; no ambient Core environment is forwarded. */
  nativeLibraryPath?: string;
  cudaRuntimeDir?: string;
}

// The native child needs OS paths/locales, not the parent application's identity,
// provider credentials, NODE_OPTIONS, loader paths, or an unrestricted environment.
const CHILD_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'SYSTEMDRIVE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
]);

function childEnvironment(options: NativeEngineOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (CHILD_ENV_KEYS.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  }
  if (options.nativeLibraryPath) environment.TRANSCRIBE_LIBRARY = options.nativeLibraryPath;
  if (options.cudaRuntimeDir) environment.TRANSCRIBE_CUDA_RUNTIME_DIR = options.cudaRuntimeDir;
  return environment;
}

function isDeviceList(value: unknown): value is DeviceInfo[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item &&
    typeof item.id === 'string' && typeof item.backend === 'string' &&
    typeof item.name === 'string' && typeof item.available === 'boolean');
}

/** One resident isolated model, with a temporary candidate during atomic switches. */
export class NativeEngine extends EventEmitter {
  #options: Required<Pick<NativeEngineOptions, 'startupTimeoutMs' | 'loadTimeoutMs' | 'inferenceTimeoutMs' | 'cancellationGraceMs' | 'shutdownTimeoutMs'>> & NativeEngineOptions;
  #state: EngineStatus = { phase: 'idle', modelId: null, backend: null, device: null, busy: false };
  #active?: WorkerHandle;
  #probe?: WorkerHandle;
  #selection?: LoadOptions;
  #workers = new Set<WorkerHandle>();
  #deviceCache?: DeviceInfo[];
  #devicePromise?: Promise<DeviceInfo[]>;
  #closed = false;
  #fatal?: EngineError;
  #closePromise?: Promise<void>;

  constructor(options: NativeEngineOptions = {}) {
    super();
    this.#options = {
      startupTimeoutMs: 15_000, loadTimeoutMs: 180_000, inferenceTimeoutMs: INFERENCE_TIMEOUT_MS,
      cancellationGraceMs: 1_000, shutdownTimeoutMs: 5_000, ...options,
    };
  }

  status(): EngineStatus { return { ...this.#state }; }

  async devices(): Promise<DeviceInfo[]> {
    this.#assertOpen();
    if (this.#deviceCache) return this.#deviceCache.map((device) => ({ ...device }));
    if (this.#devicePromise) return this.#devicePromise;
    this.#assertFree();
    this.#publish({ busy: true });
    this.#devicePromise = (async () => {
      let handle: WorkerHandle | undefined;
      try {
        handle = this.#active ?? this.#probe ?? this.#spawn();
        if (!this.#active) this.#probe = handle;
        const result = await this.#request(handle, { op: 'devices' }, this.#options.loadTimeoutMs);
        if (!isDeviceList(result)) throw new EngineError('WORKER_PROTOCOL', 'The native worker returned invalid devices.');
        this.#deviceCache = result;
        return result.map((device) => ({ ...device }));
      } catch (error) {
        if (!this.#active) {
          if (handle) await this.#stop(handle, false);
          if (this.#probe === handle) this.#probe = undefined;
          if (!this.#closed) this.#publish({ phase: 'failed', error: this.#message(error) });
        }
        throw error;
      } finally {
        this.#devicePromise = undefined;
        if (!this.#closed) this.#publish({ busy: false });
      }
    })();
    return this.#devicePromise;
  }

  async load(options: LoadOptions, signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    this.#assertFree();
    if (signal?.aborted) throw aborted();
    if (!BACKEND_CHOICES.includes(options.backend) || !isAbsolute(options.modelPath) || !options.modelId?.trim()) {
      throw new EngineError('INVALID_MODEL', 'Expected an absolute model path, model ID and supported backend.');
    }
    if (this.#active && this.#selection && Object.keys(options).every((key) => options[key as keyof LoadOptions] === this.#selection![key as keyof LoadOptions])) return;
    this.#publish({ busy: true });
    try {
      await this.#loadCandidate({ ...options }, signal);
    } finally {
      if (!this.#closed) this.#publish({ busy: false });
    }
  }

  async transcribe(samples: Float32Array, language: string, signal: AbortSignal): Promise<RecognitionResult> {
    this.#assertOpen();
    this.#assertFree();
    if (signal.aborted) throw aborted();
    const modelLimit = this.#state.modelMaxDurationSeconds;
    const maxDurationSeconds = Math.min(MAX_RECORDING_SECONDS, modelLimit && modelLimit > 0 ? modelLimit : MAX_RECORDING_SECONDS);
    if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > Math.floor(maxDurationSeconds * 16_000)) {
      throw new EngineError('INVALID_AUDIO', `Expected between one sample and ${maxDurationSeconds} seconds of 16 kHz mono PCM.`);
    }
    if (!this.#active && !this.#selection) throw new EngineError('NOT_READY', 'No recognition model has been selected.');
    this.#publish({ busy: true, error: undefined });
    try {
      // A crash/forced cancellation invalidates the process. Recover the last
      // successful selection on demand; normal requests keep the resident model.
      if (!this.#active) await this.#loadCandidate(this.#selection!, signal);
      const result = await this.#request(this.#active!, { op: 'transcribe', samples, language }, this.#options.inferenceTimeoutMs, signal);
      if (!result || typeof result !== 'object' || !('text' in result) || typeof result.text !== 'string') {
        throw new EngineError('WORKER_PROTOCOL', 'The native worker returned an invalid transcription.');
      }
      const value = result as RecognitionResult;
      if (value.language !== undefined && value.language !== null && typeof value.language !== 'string') {
        throw new EngineError('WORKER_PROTOCOL', 'The native worker returned an invalid language.');
      }
      return { text: value.text, language: value.language ?? null };
    } finally {
      if (!this.#closed) this.#publish({ busy: false });
    }
  }

  /** Retire the shared model after a failed settings transaction; remain reusable. */
  async unload(): Promise<void> {
    this.#assertOpen();
    this.#assertFree();
    this.#publish({ busy: true });
    try {
      const results = await Promise.allSettled([...this.#workers].map((handle) => {
        handle.retiring = true;
        return this.#stop(handle, true);
      }));
      const failure = results.find((result) => result.status === 'rejected');
      this.#active = this.#probe = undefined;
      this.#selection = undefined;
      this.#publish({ phase: failure ? 'failed' : 'idle', modelId: null, backend: null, device: null, modelMaxDurationSeconds: undefined,
        error: failure?.status === 'rejected' ? this.#message(failure.reason) : undefined });
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      if (!this.#closed) this.#publish({ busy: false });
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      const results = await Promise.allSettled([...this.#workers].map((handle) => this.#stop(handle, true)));
      const failure = results.find((result) => result.status === 'rejected');
      this.#active = this.#probe = undefined;
      this.#selection = undefined;
      this.#publish({ phase: failure ? 'failed' : 'idle', modelId: null, backend: null, device: null, modelMaxDurationSeconds: undefined, busy: false,
        error: failure?.status === 'rejected' ? this.#message(failure.reason) : undefined });
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.#closePromise;
  }

  async #loadCandidate(options: LoadOptions, signal?: AbortSignal): Promise<void> {
    this.#publish({ phase: 'loading', error: undefined });
    let candidate: WorkerHandle | undefined;
    try {
      candidate = this.#probe && !this.#probe.exited ? this.#probe : this.#spawn();
      this.#probe = undefined;
      const raw = await this.#request(candidate, { op: 'load', ...options }, this.#options.loadTimeoutMs, signal);
      const result = raw as LoadResult;
      if (!result || result.version !== '0.4.1' || !BACKEND_CHOICES.includes(result.backend as BackendChoice) ||
        result.backend === 'auto' || !result.device || typeof result.device !== 'string' || !isDeviceList(result.devices)) {
        throw new EngineError('WORKER_PROTOCOL', 'The native worker did not verify its runtime, backend and device.');
      }
      if (result.modelMaxDurationSeconds !== undefined &&
        (typeof result.modelMaxDurationSeconds !== 'number' || !Number.isFinite(result.modelMaxDurationSeconds) || result.modelMaxDurationSeconds < 0)) {
        throw new EngineError('WORKER_PROTOCOL', 'The native worker returned an invalid input duration limit.');
      }
      if (options.backend !== 'auto' && result.backend !== options.backend) {
        throw new EngineError('BACKEND_MISMATCH', 'The native worker did not use the explicitly selected backend.');
      }
      if (signal?.aborted) throw aborted();
      this.#assertOpen();
      const previous = this.#active;
      if (previous) {
        previous.retiring = true;
        await this.#stop(previous, true);
      }
      this.#assertOpen();
      if (candidate.exited) throw new EngineError('WORKER_EXITED', 'The candidate native worker exited before activation.');
      this.#active = candidate;
      this.#selection = options;
      this.#deviceCache = result.devices;
      this.#publish({ phase: 'ready', modelId: options.modelId, backend: result.backend, device: result.device,
        modelMaxDurationSeconds: result.modelMaxDurationSeconds, error: undefined });
    } catch (error) {
      let failure = error;
      if (candidate && this.#active !== candidate) {
        try { await this.#stop(candidate, true); } catch (cleanupError) { failure = cleanupError; }
      }
      if (!this.#closed) this.#publish({ phase: this.#active && !this.#fatal ? 'ready' : 'failed',
        ...(!this.#active || this.#fatal ? { backend: null, device: null } : {}), error: this.#message(this.#fatal ?? failure) });
      throw this.#fatal ?? failure;
    }
  }

  #spawn(): WorkerHandle {
    this.#assertOpen();
    const workerUrl = this.#options.workerUrl ?? new URL(import.meta.url.endsWith('.ts') ? './native-worker.ts' : './native-worker.js', import.meta.url);
    const workerPath = fileURLToPath(workerUrl);
    const child = fork(workerPath, [], {
      execArgv: workerPath.endsWith('.ts') ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href] : [],
      env: childEnvironment(this.#options), serialization: 'advanced',
      // Native stdout/stderr are deliberately not attached to app logs.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    let resolveExit!: () => void;
    const handle: WorkerHandle = {
      child, ready: new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
      isReady: false, exited: false, exit: new Promise<void>((resolve) => { resolveExit = resolve; }), pending: new Map(),
    };
    // Startup failure may occur before the first request attaches its handler.
    void handle.ready.catch(() => {});
    this.#workers.add(handle);
    const startupTimer = setTimeout(() => {
      const error = new EngineError('WORKER_TIMEOUT', 'The native worker did not start in time.');
      handle.failure = error;
      rejectReady(error);
      void this.#stop(handle, false).catch(() => {});
    }, this.#options.startupTimeoutMs);
    child.on('message', (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const message = raw as WorkerMessage;
      if ('type' in message && message.type === 'ready') {
        handle.isReady = true;
        clearTimeout(startupTimer);
        resolveReady();
        return;
      }
      if (!('id' in message) || typeof message.id !== 'string' || handle.stopPromise) return;
      const pending = handle.pending.get(message.id);
      if (!pending) return;
      handle.pending.delete(message.id);
      pending.cleanup();
      if (pending.terminalError) pending.reject(pending.terminalError);
      else if (message.ok === true) pending.resolve(message.result);
      else if (message.ok === false && message.error && typeof message.error.code === 'string' && typeof message.error.message === 'string') {
        pending.reject(message.error.code === 'ABORTED' ? aborted() : new EngineError(message.error.code, message.error.message));
      } else pending.reject(new EngineError('WORKER_PROTOCOL', 'Invalid native worker response.'));
    });
    child.on('error', () => { handle.failure ??= new EngineError('WORKER_FAILED', 'The native worker could not run.'); });
    child.once('close', () => {
      clearTimeout(startupTimer);
      handle.exited = true;
      this.#workers.delete(handle);
      const error = handle.failure ?? new EngineError('WORKER_EXITED', 'The native worker exited. The selected model can be loaded again.');
      rejectReady(error);
      if (this.#probe === handle) this.#probe = undefined;
      if (this.#active === handle) {
        this.#active = undefined;
        if (!this.#closed && !handle.retiring) this.#publish({ phase: 'failed', backend: null, device: null, error: error.message });
      }
      for (const pending of handle.pending.values()) {
        pending.cleanup();
        pending.reject(pending.terminalError ?? error);
      }
      handle.pending.clear();
      resolveExit();
    });
    return handle;
  }

  async #request(handle: WorkerHandle, command: WorkerCommand, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw aborted();
    if (!signal) await handle.ready;
    else await new Promise<void>((resolve, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(aborted()); };
      signal.addEventListener('abort', onAbort, { once: true });
      void handle.ready.then(
        () => { signal.removeEventListener('abort', onAbort); resolve(); },
        (error: Error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
      if (signal.aborted) onAbort();
    });
    if (signal?.aborted) throw aborted();
    if (handle.exited || handle.stopPromise) throw new EngineError('WORKER_EXITED', 'The native worker is unavailable.');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const pending: Pending = {
        resolve, reject,
        cleanup: () => {
          clearTimeout(timeout);
          if (abortTimer) clearTimeout(abortTimer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      const stopAfterFailure = (error: Error): void => {
        pending.terminalError = error;
        handle.failure = error;
        void this.#stop(handle, false).catch((failure: unknown) => {
          if (!handle.pending.delete(id)) return;
          pending.cleanup();
          reject(failure);
        });
      };
      const onAbort = (): void => {
        if (pending.terminalError) return;
        pending.terminalError = aborted();
        if (handle.child.connected) handle.child.send({ op: 'cancel', targetId: id }, () => {});
        abortTimer = setTimeout(() => stopAfterFailure(aborted()), this.#options.cancellationGraceMs);
      };
      const timeout = setTimeout(() => stopAfterFailure(new EngineError('NATIVE_TIMEOUT', 'The native speech operation timed out.')), timeoutMs);
      handle.pending.set(id, pending);
      signal?.addEventListener('abort', onAbort, { once: true });
      handle.child.send({ ...command, id }, (error) => {
        if (error && handle.pending.has(id)) stopAfterFailure(new EngineError('WORKER_IPC', 'The native worker disconnected.'));
      });
      if (signal?.aborted) onAbort();
    });
  }

  #stop(handle: WorkerHandle, graceful: boolean): Promise<void> {
    if (handle.stopPromise) return handle.stopPromise;
    if (handle.exited) return Promise.resolve();
    handle.stopPromise = (async () => {
      if (graceful && handle.isReady && handle.child.connected) {
        handle.child.send({ op: 'close', id: randomUUID() }, () => {});
      } else handle.child.kill('SIGTERM');
      if (await this.#waitForExit(handle, this.#options.shutdownTimeoutMs)) return;
      handle.child.kill('SIGKILL');
      if (await this.#waitForExit(handle, this.#options.shutdownTimeoutMs)) return;
      this.#fatal ??= new EngineError('WORKER_STOP_FAILED', 'The native worker exit could not be confirmed. Restart the speech application before loading another model.');
      if (!this.#closed) this.#publish({ phase: 'failed', backend: null, device: null, error: this.#fatal.message });
      throw this.#fatal;
    })();
    return handle.stopPromise;
  }

  #waitForExit(handle: WorkerHandle, timeoutMs: number): Promise<boolean> {
    if (handle.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void handle.exit.then(() => { clearTimeout(timer); resolve(true); });
    });
  }

  #assertOpen(): void {
    if (this.#closed) throw new EngineError('CLOSED', 'The speech engine has been closed.');
    if (this.#fatal) throw this.#fatal;
  }
  #assertFree(): void { if (this.#state.busy) throw new EngineBusyError(); }
  #message(error: unknown): string { return error instanceof Error ? error.message : 'The native speech operation failed.'; }
  #publish(patch: Partial<EngineStatus>): void {
    this.#state = { ...this.#state, ...patch };
    if (this.#state.error === undefined) delete this.#state.error;
    if (this.#state.modelMaxDurationSeconds === undefined) delete this.#state.modelMaxDurationSeconds;
    this.emit('status', this.status());
  }
}
