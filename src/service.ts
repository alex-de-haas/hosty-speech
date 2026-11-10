import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { MODELS, DEFAULT_MODEL, modelById } from "./catalog.js";
import { Downloads } from "./downloads.js";
import { NativeEngine, type BackendChoice, type DeviceInfo } from "./engine.js";
import { SpeechError } from "./errors.js";
import type { ActivationState, RecordingLimits, SpeechConfig, SpeechSnapshot } from "./types.js";
import { decodeWave, hasVoiceActivity } from "./wave.js";
import { MAX_RECORDING_SECONDS, bytesForDuration, effectiveRecordingSeconds } from "./limits.js";

const BACKENDS = new Set<BackendChoice>(["auto", "cpu", "metal", "vulkan", "cuda", "rocm"]);
export class SpeechService extends EventEmitter {
  readonly downloads: Downloads;
  private settings: SpeechConfig = { modelId: DEFAULT_MODEL, backend: "auto", recordingLimitSeconds: null };
  private revision = 0;
  private activation: ActivationState = { state: "idle" };
  private activationJob: Promise<void> | null = null;
  private recordingJob: Promise<void> | null = null;
  private removalJob: Promise<void> | null = null;
  private removingModelId: string | null = null;
  private devicesList: DeviceInfo[] = [];
  private readonly configPath: string;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(readonly dataDirectory: string, cacheDirectory: string, readonly engine = new NativeEngine({
    nativeLibraryPath: process.env.HOSTY_SPEECH_NATIVE_LIBRARY?.trim() || undefined,
    cudaRuntimeDir: process.env.HOSTY_SPEECH_CUDA_RUNTIME_DIR?.trim() || undefined,
  })) {
    super(); this.configPath = join(dataDirectory, "settings.json"); this.downloads = new Downloads(join(cacheDirectory, "models"));
    this.downloads.on("change", () => this.changed()); engine.on("status", () => this.changed());
  }
  private changed() { if (!this.closed) this.emit("change", this.snapshot()); }
  snapshot(): SpeechSnapshot {
    const engine = this.engine.status();
    return { revision: this.revision, settings: { ...this.settings }, recording: this.recordingLimits(), removingModelId: this.removingModelId, effective: { modelId: engine.modelId, backend: engine.backend, device: engine.device }, engine,
      activation: { ...this.activation }, models: MODELS.map(({ id, name, description, languageLabel, languages, bytes, license }) => ({ id, name, description, languageLabel, languages: [...languages], bytes, license, installed: this.downloads.isInstalled(id) })), downloads: this.downloads.state(), devices: this.devicesList.map(device => ({ ...device })) };
  }
  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.configPath, "utf8"));
      const limit = value.settings?.recordingLimitSeconds ?? null;
      if (!modelById(value.settings?.modelId) || !BACKENDS.has(value.settings?.backend) || !Number.isSafeInteger(value.revision) || value.revision < 0 || !this.validRecordingLimit(limit)) throw new Error("Saved settings are invalid.");
      this.settings = { modelId: value.settings.modelId, backend: value.settings.backend, recordingLimitSeconds: limit }; this.revision = value.revision;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SpeechError(503, "settings_invalid", "Saved speech settings could not be read. Restore the app settings backup."); }
    await this.downloads.initialize();
    try { this.devicesList = await this.engine.devices(); } catch { this.devicesList = []; }
    if (this.downloads.isInstalled(this.settings.modelId)) {
      this.activation = { state: "loading", ...this.settings };
      try { await this.engine.load({ ...this.settings, modelPath: this.downloads.path(this.settings.modelId) }); this.activation = { state: "idle" }; }
      catch { this.activation = { state: "failed", ...this.settings, error: "The saved model or accelerator could not be loaded. Choose another option or retry." }; }
    }
    this.changed();
  }
  activate(input: unknown) {
    if (this.closed) throw new SpeechError(503, "speech_stopping", "Speech is stopping. Retry after it starts again.");
    if (!input || typeof input !== "object") throw new SpeechError(400, "settings_invalid", "Choose a model and acceleration mode.");
    const value = input as Record<string, unknown>;
    if (value.revision !== this.revision) throw new SpeechError(409, "settings_conflict", "Speech settings changed in another tab. Review the current settings and try again.");
    if (typeof value.modelId !== "string" || !modelById(value.modelId) || typeof value.backend !== "string" || !BACKENDS.has(value.backend as BackendChoice)) throw new SpeechError(400, "settings_invalid", "Choose a model and acceleration mode from the lists.");
    this.requireMutationAvailable();
    if (!this.downloads.isInstalled(value.modelId)) throw new SpeechError(409, "model_not_installed", "Download the selected model before using it.");
    const candidate: SpeechConfig = { modelId: value.modelId, backend: value.backend as BackendChoice, recordingLimitSeconds: this.settings.recordingLimitSeconds ?? null };
    this.activation = { state: "loading", ...candidate }; this.changed();
    this.activationJob = this.apply(candidate).finally(() => { this.activationJob = null; this.changed(); });
  }
  private async apply(candidate: SpeechConfig) {
    const previous = { ...this.settings };
    try {
      await this.engine.load({ ...candidate, modelPath: this.downloads.path(candidate.modelId) });
      if (this.closed) return;
      const revision = this.revision + 1;
      const temporary = this.configPath + ".tmp";
      try {
        await writeFile(temporary, JSON.stringify({ revision, settings: candidate }) + "\n", { mode: 0o600 });
        await rename(temporary, this.configPath);
      } catch {
        if (this.closed) return;
        // Keep the persisted and effective selection consistent if saving fails after native load.
        try {
          if (this.downloads.isInstalled(previous.modelId)) await this.engine.load({ ...previous, modelPath: this.downloads.path(previous.modelId) });
          else await this.engine.unload();
        } catch {
          await this.engine.unload();
          throw new Error("The settings could not be saved and the previous model could not be restored. Reload your selected model after checking app storage.");
        }
        throw new Error("The settings could not be saved. The previous selection was restored.");
      } finally { await unlink(temporary).catch(() => {}); }
      this.settings = candidate; this.revision = revision; this.activation = { state: "idle" };
    } catch (error) {
      if (!this.closed) this.activation = { state: "failed", ...candidate, error: error instanceof Error ? error.message : "The model could not be loaded. Try another model or acceleration mode." };
    }
  }
  async waitForActivation() { await this.activationJob; }
  private validRecordingLimit(value: unknown): value is number | null { return value === null || typeof value === "number" && Number.isInteger(value) && value >= 15 && value <= MAX_RECORDING_SECONDS; }
  private requireMutationAvailable() {
    if (this.closed) throw new SpeechError(503, "speech_stopping", "Speech is stopping. Retry after it starts again.");
    if (this.activationJob || this.activation.state === "loading" || this.recordingJob || this.removingModelId || this.engine.status().busy) throw new SpeechError(429, "speech_busy", "Speech recognition is busy. Try again shortly.");
  }
  recordingLimits(): RecordingLimits {
    const nativeLimit = this.engine.status().modelMaxDurationSeconds;
    const maxDurationSeconds = effectiveRecordingSeconds(this.settings.recordingLimitSeconds, nativeLimit);
    return { maxDurationSeconds, maxBytes: bytesForDuration(maxDurationSeconds), configuredLimitSeconds: this.settings.recordingLimitSeconds ?? null,
      modelLimitSeconds: typeof nativeLimit === "number" && nativeLimit > 0 ? nativeLimit : null, hardLimitSeconds: MAX_RECORDING_SECONDS };
  }
  configureRecording(input: unknown): Promise<void> {
    this.requireMutationAvailable();
    if (!input || typeof input !== "object") throw new SpeechError(400, "settings_invalid", "Choose a recording limit.");
    const value = input as Record<string, unknown>;
    if (value.revision !== this.revision) throw new SpeechError(409, "settings_conflict", "Speech settings changed in another tab. Review the current settings and try again.");
    if (!this.validRecordingLimit(value.recordingLimitSeconds)) throw new SpeechError(400, "settings_invalid", "Use Auto or a whole number of seconds between 15 and 600.");
    const candidate = { ...this.settings, recordingLimitSeconds: value.recordingLimitSeconds };
    this.recordingJob = Promise.resolve().then(async () => {
      const temporary = this.configPath + ".tmp", revision = this.revision + 1;
      try {
        if (this.closed) return;
        await writeFile(temporary, JSON.stringify({ revision, settings: candidate }) + "\n", { mode: 0o600 });
        if (this.closed) return;
        await rename(temporary, this.configPath);
        this.settings = candidate; this.revision = revision;
      } catch { throw new SpeechError(503, "settings_storage", "The recording limit could not be saved. Check app storage and retry."); }
      finally { await unlink(temporary).catch(() => {}); }
    }).finally(() => { this.recordingJob = null; this.changed(); });
    return this.recordingJob;
  }
  removeModel(id: string): Promise<void> {
    this.requireMutationAvailable();
    if (!modelById(id)) throw new SpeechError(404, "model_unknown", "Choose a model from the catalog.");
    this.removingModelId = id; this.changed();
    this.removalJob = Promise.resolve().then(async () => {
      if (this.closed) throw new SpeechError(503, "speech_stopping", "Speech is stopping.");
      if (this.engine.status().modelId === id) { await this.engine.unload(); this.activation = { state: "idle" }; }
      if (this.closed) throw new SpeechError(503, "speech_stopping", "Speech is stopping.");
      await this.downloads.remove(id);
    }).finally(() => { this.removingModelId = null; this.removalJob = null; this.changed(); });
    return this.removalJob;
  }
  capabilities() { const state = this.engine.status(), limits = this.recordingLimits(); return { version: 1, mediaTypes: ["audio/wav"], maxBytes: limits.maxBytes, maxDurationSeconds: limits.maxDurationSeconds, backend: state.backend ? `transcribe.cpp/${state.backend}` : "transcribe.cpp", ready: state.phase === "ready" && state.modelId === this.settings.modelId && (this.settings.backend === "auto" || this.settings.backend === state.backend) && this.activation.state !== "loading" && !this.removingModelId }; }
  async transcribe(wave: Buffer, language: string, signal: AbortSignal) {
    if (this.closed) throw new SpeechError(503, "speech_stopping", "Speech is stopping. Retry after it starts again.");
    if (this.activation.state === "loading" || this.removingModelId) throw new SpeechError(503, "speech_not_ready", "The speech model is changing. Try again shortly.");
    const state = this.engine.status();
    if (state.busy) throw new SpeechError(429, "speech_busy", "Speech recognition is busy. Try again shortly.");
    const recoverable = state.phase === "failed" && state.modelId === this.settings.modelId && this.downloads.isInstalled(this.settings.modelId);
    if (!this.capabilities().ready && !recoverable) throw new SpeechError(503, "speech_not_ready", "Choose and load a speech model in Speech Settings.");
    const model = modelById(this.settings.modelId)!;
    if (language !== "auto" && !model.languages.includes(language)) throw new SpeechError(400, "speech_language_invalid", "The selected model does not support this language.");
    const samples = decodeWave(wave, this.recordingLimits().maxDurationSeconds);
    if (!hasVoiceActivity(samples)) return { text: "", language: language === "auto" ? null : language };
    const result = await this.engine.transcribe(samples, language, signal);
    return { text: result.text.trim(), language: language === "auto" ? result.language ?? null : language };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      // Stop candidate/active native processes before awaiting a pending load's settlement.
      const outcomes = await Promise.allSettled([this.downloads.close(), this.engine.close(), this.activationJob, this.recordingJob, this.removalJob]);
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.closing;
  }
}
