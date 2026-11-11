/** Application policy; browsers do not impose a universal ten-minute recording limit. */
export const MAX_RECORDING_SECONDS = 600;
export const INFERENCE_TIMEOUT_MS = 900_000;
export const bytesForDuration = (seconds: number) => Math.floor(seconds * 16_000) * 2 + 4096;

export function effectiveRecordingSeconds(configured: number | null | undefined, modelMaximum?: number): number {
  // Native zero means unlimited. Missing metadata is bounded by the application policy.
  const modelLimit = typeof modelMaximum === "number" && Number.isFinite(modelMaximum) && modelMaximum > 0
    ? Math.floor(modelMaximum) : MAX_RECORDING_SECONDS;
  return Math.min(configured ?? MAX_RECORDING_SECONDS, MAX_RECORDING_SECONDS, modelLimit);
}
