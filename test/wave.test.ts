import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeWave, hasVoiceActivity, MAX_BYTES, MAX_SECONDS } from '../src/wave.js';

function wave(samples: number[] | Int16Array): Buffer {
  const result = Buffer.alloc(44 + samples.length * 2);
  result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WAVE', 8);
  result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22); result.writeUInt32LE(16_000, 24); result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) result.writeInt16LE(samples[i]!, 44 + i * 2);
  return result;
}

test('PCM16 decode preserves signed amplitude and accepts the exact ten-minute limit', () => {
  assert.deepEqual([...decodeWave(wave([-32768, -16384, 0, 16384, 32767]))], [-1, -0.5, 0, 0.5, 32767 / 32768]);
  assert.equal(decodeWave(wave(new Int16Array(MAX_SECONDS * 16_000))).length, MAX_SECONDS * 16_000);
});

test('WAV parser rejects too-long audio even within the allowed metadata byte allowance', () => {
  assert.throws(() => decodeWave(wave(new Int16Array(MAX_SECONDS * 16_000 + 1))), { status: 413, code: 'speech_audio_too_large' });
  assert.throws(() => decodeWave(Buffer.alloc(MAX_BYTES + 1)), { status: 413, code: 'speech_audio_too_large' });
});

test('WAV validation enforces a lower negotiated duration, including the metadata allowance boundary', () => {
  assert.equal(decodeWave(wave(new Int16Array(60 * 16_000)), 60).length, 60 * 16_000);
  assert.throws(() => decodeWave(wave(new Int16Array(60 * 16_000 + 1)), 60), { status: 413, code: 'speech_audio_too_large' });
  assert.throws(() => decodeWave(wave([100, 200]), 0), { status: 503, code: 'speech_limits_unavailable' });
});

for (const [name, alter] of [
  ['missing RIFF header', (value: Buffer) => value.write('RF64')],
  ['incorrect RIFF size', (value: Buffer) => value.writeUInt32LE(value.length, 4)],
  ['compressed audio', (value: Buffer) => value.writeUInt16LE(3, 20)],
  ['stereo audio', (value: Buffer) => value.writeUInt16LE(2, 22)],
  ['wrong sample rate', (value: Buffer) => value.writeUInt32LE(44_100, 24)],
  ['inconsistent byte rate', (value: Buffer) => value.writeUInt32LE(16_000, 28)],
  ['incorrect block alignment', (value: Buffer) => value.writeUInt16LE(4, 32)],
  ['8-bit samples', (value: Buffer) => value.writeUInt16LE(8, 34)],
  ['truncated data chunk', (value: Buffer) => value.writeUInt32LE(value.length, 40)],
  ['unaligned samples', (value: Buffer) => value.writeUInt32LE(3, 40)],
] as const) {
  test(`WAV parser rejects ${name}`, () => {
    const value = wave([100, 200]);
    alter(value);
    assert.throws(() => decodeWave(value), { status: 400, code: 'speech_audio_invalid' });
  });
}

test('WAV parser handles padded unknown metadata and rejects duplicate audio chunks', () => {
  const source = wave([100, 200]);
  const metadata = Buffer.from([0x4a, 0x55, 0x4e, 0x4b, 1, 0, 0, 0, 7, 0]);
  const padded = Buffer.concat([source.subarray(0, 12), metadata, source.subarray(12)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  assert.deepEqual([...decodeWave(padded)], [100 / 32768, 200 / 32768]);
  const duplicate = Buffer.concat([source, source.subarray(36)]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  assert.throws(() => decodeWave(duplicate), { code: 'speech_audio_invalid' });
  const empty = wave([]);
  assert.throws(() => decodeWave(empty), { code: 'speech_audio_invalid' });
});

test('voice gate accepts quiet, short voiced audio but drops silence, low noise and a single click', () => {
  const quiet = Float32Array.from({ length: 800 }, (_, at) => Math.sin(at * 2 * Math.PI * 180 / 16_000) * 0.001);
  assert.equal(hasVoiceActivity(quiet), true, '50 ms quiet voiced audio should reach recognition');
  assert.equal(hasVoiceActivity(new Float32Array(16_000)), false);
  assert.equal(hasVoiceActivity(Float32Array.from({ length: 16_000 }, (_, at) => Math.sin(at) * 0.0001)), false);
  const click = new Float32Array(16_000); click[1_000] = 0.7;
  assert.equal(hasVoiceActivity(click), false);
});
