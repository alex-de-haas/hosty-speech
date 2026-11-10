/** Opt-in hardware verification. Uses only the supplied public/synthetic fixture. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NativeEngine } from '../src/engine.js';
import { modelById } from '../src/catalog.js';
import { decodeWave } from '../src/wave.js';

const [modelPath, fixturePath, modelId = 'native-smoke', language = 'en'] = process.argv.slice(2);
if (!modelPath || !fixturePath) throw new Error('Usage: node --import tsx scripts/native-smoke.ts MODEL.gguf PUBLIC_FIXTURE.wav [MODEL_ID] [LANGUAGE]');

const engine = new NativeEngine();
const samples = decodeWave(await readFile(fixturePath));
const milliseconds = (start: number) => Math.round((performance.now() - start) * 10) / 10;
const report: Record<string, unknown> = { platform: platform(), architecture: arch(), node: process.version,
  modelId, samples: samples.length, audioSeconds: samples.length / 16_000 };

try {
  report.devices = await engine.devices();
  let started = performance.now();
  await engine.load({ modelPath: resolve(modelPath), modelId, backend: 'auto' });
  report.autoLoadMs = milliseconds(started);
  report.auto = engine.status();
  assert.equal(engine.status().phase, 'ready');
  if (platform() === 'darwin' && arch() === 'arm64') assert.equal(engine.status().backend, 'metal');
  const runs: { milliseconds: number; text: string; language?: string | null }[] = [];
  for (let run = 0; run < 3; run++) {
    started = performance.now();
    const result = await engine.transcribe(samples, language, new AbortController().signal);
    runs.push({ milliseconds: milliseconds(started), ...result });
    assert.ok(result.text.trim(), 'Speech fixture should produce text');
  }
  assert.equal(runs[0].text, runs[1].text);
  assert.equal(runs[1].text, runs[2].text);
  report.repeatedRuns = runs;
  const descriptor = modelById(modelId);
  if (descriptor) {
    const unsupported = ['en', 'ru', 'zh', 'ja', 'uk', 'xx'].find((candidate) => !descriptor.languages.includes(candidate));
    if (unsupported) {
      await assert.rejects(engine.transcribe(samples, unsupported, new AbortController().signal), { code: 'UNSUPPORTED_LANGUAGE' });
      assert.equal(engine.status().phase, 'ready');
      report.unsupportedLanguage = { language: unsupported, rejected: true };
    }
  }

  const long = new Float32Array(Math.min(120 * 16_000, samples.length * 10));
  for (let offset = 0; offset < long.length; offset += samples.length) long.set(samples.subarray(0, Math.min(samples.length, long.length - offset)), offset);
  const controller = new AbortController();
  started = performance.now();
  const recognition = engine.transcribe(long, language, controller.signal);
  await assert.rejects(engine.transcribe(samples, language, new AbortController().signal), { code: 'BUSY' });
  const timer = setTimeout(() => controller.abort(), 25);
  try { await assert.rejects(recognition, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
  report.cancellationMs = milliseconds(started);
  report.afterCancellation = engine.status();
  const recovered = await engine.transcribe(samples, language, new AbortController().signal);
  assert.equal(recovered.text, runs[0].text);
  report.recovered = engine.status();

  const unavailable = (['cuda', 'rocm', 'vulkan'] as const).find((backend) =>
    !(report.devices as { backend: string }[]).some((device) => device.backend === backend));
  if (unavailable) {
    await assert.rejects(engine.load({ modelPath: resolve(modelPath), modelId, backend: unavailable }), { code: 'BACKEND_UNAVAILABLE' });
    assert.equal(engine.status().phase, 'ready');
    report.unavailableOverride = { backend: unavailable, previousModelPreserved: true };
  }
  started = performance.now();
  await engine.load({ modelPath: resolve(modelPath), modelId, backend: 'cpu' });
  report.cpuLoadMs = milliseconds(started);
  started = performance.now();
  const cpu = await engine.transcribe(samples, language, new AbortController().signal);
  assert.ok(cpu.text.trim());
  assert.equal(engine.status().backend, 'cpu');
  report.cpuRun = { milliseconds: milliseconds(started), ...cpu, status: engine.status() };
} finally {
  const started = performance.now();
  await engine.close();
  report.closeMs = milliseconds(started);
  report.closed = engine.status();
}
console.log(JSON.stringify(report, null, 2));
