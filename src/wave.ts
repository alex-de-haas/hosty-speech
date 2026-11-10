import { SpeechError } from "./errors.js";
import { MAX_RECORDING_SECONDS, bytesForDuration } from "./limits.js";
export const MAX_SECONDS = MAX_RECORDING_SECONDS;
export const MAX_BYTES = bytesForDuration(MAX_SECONDS);
const bad = (message = "Use a nonempty 16 kHz mono PCM16 WAV recording.") => new SpeechError(400, "speech_audio_invalid", message);
export function decodeWave(wave: Buffer, maximumSeconds = MAX_SECONDS): Float32Array {
  const duration = Math.min(MAX_SECONDS, maximumSeconds);
  if (!Number.isFinite(duration) || duration <= 0) throw new SpeechError(503, "speech_limits_unavailable", "Recording limits are unavailable.");
  if (wave.length > bytesForDuration(duration)) throw new SpeechError(413, "speech_audio_too_large", `Recordings may be up to ${duration} seconds.`);
  if (wave.length < 44 || wave.toString("ascii", 0, 4) !== "RIFF" || wave.toString("ascii", 8, 12) !== "WAVE" || wave.readUInt32LE(4) !== wave.length - 8) throw bad();
  let at = 12, format = false, data: Buffer | undefined;
  while (at + 8 <= wave.length) {
    const size = wave.readUInt32LE(at + 4), end = at + 8 + size;
    if (end > wave.length) throw bad("The WAV recording is truncated.");
    const kind = wave.toString("ascii", at, at + 4), chunk = wave.subarray(at + 8, end);
    if (kind === "fmt ") {
      if (format || size < 16 || chunk.readUInt16LE(0) !== 1 || chunk.readUInt16LE(2) !== 1 || chunk.readUInt32LE(4) !== 16000 || chunk.readUInt32LE(8) !== 32000 || chunk.readUInt16LE(12) !== 2 || chunk.readUInt16LE(14) !== 16) throw bad();
      format = true;
    }
    if (kind === "data") { if (data) throw bad("Use one WAV data chunk."); data = chunk; }
    at = end + (size & 1);
  }
  if (at !== wave.length || !format || !data?.length || data.length % 2 !== 0) throw bad();
  if (data.length / 2 > duration * 16000) throw new SpeechError(413, "speech_audio_too_large", `Recordings may be up to ${duration} seconds.`);
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return samples;
}
/** Conservative frame-energy gate: recognizes sustained quiet speech and drops silence/noise-floor clips. */
export function hasVoiceActivity(samples: Float32Array): boolean {
  const frameSize = 320;
  let voicedFrames = 0;
  for (let at = 0; at < samples.length; at += frameSize) {
    let square = 0, peak = 0; const end = Math.min(samples.length, at + frameSize);
    for (let i = at; i < end; i++) { square += samples[i]! ** 2; peak = Math.max(peak, Math.abs(samples[i]!)); }
    if (Math.sqrt(square / (end - at)) >= 0.0003 && peak >= 0.0006) voicedFrames++;
    if (voicedFrames >= 2) return true;
  }
  return false;
}
