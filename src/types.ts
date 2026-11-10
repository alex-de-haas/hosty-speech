import type { BackendChoice, EngineStatus, DeviceInfo } from "./engine.js";
export type { BackendChoice, EngineStatus, DeviceInfo } from "./engine.js";
export type ModelInfo = { id: string; name: string; description: string; languageLabel: string; languages: string[]; bytes: number; license: string; installed: boolean };
export type DownloadInfo = { state: "idle" | "downloading" | "verifying" | "installed" | "failed"; received: number; total: number; error?: string };
export type SpeechConfig = { modelId: string; backend: BackendChoice; recordingLimitSeconds?: number | null };
export type RecordingLimits = { maxDurationSeconds: number; maxBytes: number; configuredLimitSeconds: number | null; modelLimitSeconds: number | null; hardLimitSeconds: number };
export type ActivationState = { state: "idle" | "loading" | "failed"; modelId?: string; backend?: BackendChoice; error?: string };
export type SpeechSnapshot = { revision: number; settings: SpeechConfig; effective: { modelId: string | null; backend: string | null; device: string | null }; engine: EngineStatus; activation: ActivationState; models: ModelInfo[]; downloads: Record<string, DownloadInfo>; devices: DeviceInfo[]; recording?: RecordingLimits; removingModelId?: string | null };

