/** Values crossing the private parent/worker IPC channel. Audio is never logged. */
export const BACKEND_CHOICES = ['auto', 'cpu', 'metal', 'vulkan', 'cuda', 'rocm'] as const;
export type BackendChoice = (typeof BACKEND_CHOICES)[number];

export interface EngineStatus {
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  modelId: string | null;
  backend: string | null;
  device: string | null;
  /** Native full-input limit in seconds; 0 means unbounded, absent means unknown. */
  modelMaxDurationSeconds?: number;
  busy: boolean;
  error?: string;
}

export interface DeviceInfo {
  id: string;
  backend: string;
  name: string;
  available: boolean;
}

export interface LoadOptions {
  modelPath: string;
  modelId: string;
  backend: BackendChoice;
}

export interface LoadResult {
  backend: string;
  device: string;
  devices: DeviceInfo[];
  version: string;
  /** Native full-input limit in seconds; 0 means unbounded, absent means unknown. */
  modelMaxDurationSeconds?: number;
}

export interface RecognitionResult {
  text: string;
  language?: string | null;
}

export type WorkerCommand =
  | { op: 'devices' }
  | ({ op: 'load' } & LoadOptions)
  | { op: 'transcribe'; samples: Float32Array; language: string }
  | { op: 'close' };

export type WorkerRequest = WorkerCommand & { id: string };
export type ParentMessage = WorkerRequest | { op: 'cancel'; targetId: string };
export type WorkerMessage =
  | { type: 'ready' }
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };
