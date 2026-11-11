import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { AppSessionResult } from '../auth.js';
import { createSpeechServer, start } from '../server.js';
import { SpeechError } from '../src/errors.js';
import type { SpeechService } from '../src/service.js';
import { decodeWave, MAX_BYTES } from '../src/wave.js';

const admin: AppSessionResult = { status: 'active', identity: { userId: 'fixture-admin', hostRole: 'host.admin' } };
const user: AppSessionResult = { status: 'active', identity: { userId: 'fixture-user', hostRole: 'host.user' } };
const browserToken = 'hostyg_fixture_own_app_session';
const providerToken = 'fixture_provider_invocation';

class FakeService extends EventEmitter {
  activations: unknown[] = [];
  removals: string[] = [];
  recordingSettings: unknown[] = [];
  limitSeconds = 600;
  recognized = 0;
  initializations = 0;
  closes = 0;
  initializedWorker = false;
  initializationFailure?: Error;
  downloads = { start: (_id: string) => {}, cancel: async (_id: string) => {} };
  async initialize() {
    this.initializations++; this.initializedWorker = true;
    if (this.initializationFailure) throw this.initializationFailure;
  }
  async close() { this.closes++; this.initializedWorker = false; }
  snapshot() { return { revision: this.activations.length + this.recordingSettings.length, settings: { modelId: 'fixture', backend: 'auto', recordingLimitSeconds: null }, activation: { state: 'idle' } }; }
  capabilities() { return { version: 1, mediaTypes: ['audio/wav'], ready: true, maxDurationSeconds: this.limitSeconds, maxBytes: this.limitSeconds * 32_000 + 4_096 }; }
  activate(value: unknown) { this.activations.push(value); }
  async removeModel(id: string) { this.removals.push(id); }
  async configureRecording(input: unknown) { this.recordingSettings.push(input); }
  async transcribe(wave: Buffer, language: string, signal: AbortSignal) {
    signal.throwIfAborted(); decodeWave(wave); this.recognized++;
    return { text: 'Пример.', language: language === 'auto' ? 'ru' : language };
  }
}

async function fixture(t: TestContext, overrides: {
  resolveSession?: (token: string | null) => Promise<AppSessionResult>;
  validateProvider?: (token: string, signal: AbortSignal) => Promise<unknown>;
} = {}) {
  const service = new FakeService();
  const server = createSpeechServer({ service: service as unknown as SpeechService,
    resolveSession: overrides.resolveSession ?? (async (token) => token === browserToken ? admin : { status: 'not-present' }),
    validateProvider: overrides.validateProvider ?? (async (token) => {
      if (token !== providerToken) throw new SpeechError(403, 'provider_forbidden', 'The provider grant is invalid.');
    }),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { service, origin, server };
}

function wave() {
  const result = Buffer.alloc(48);
  result.write('RIFF'); result.writeUInt32LE(40, 4); result.write('WAVE', 8);
  result.write('fmt ', 12); result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22); result.writeUInt32LE(16_000, 24); result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34); result.write('data', 36); result.writeUInt32LE(4, 40);
  return result;
}

test('health is public while provider authority and own-app administrator authority remain separate', async (t) => {
  const { origin } = await fixture(t);
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/api/speech/v1/capabilities`)).status, 401);
  assert.equal((await fetch(`${origin}/api/speech/v1/capabilities`, { headers: { authorization: `Bearer ${browserToken}` } })).status, 403);
  assert.equal((await fetch(`${origin}/api/speech/v1/capabilities`, { headers: { authorization: `Bearer ${providerToken}` } })).status, 200);
  assert.equal((await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer ${providerToken}` } })).status, 401);
  assert.equal((await fetch(`${origin}/api/settings`, { headers: { authorization: `Bearer ${browserToken}` } })).status, 200);
});

test('provider authority is rejected before reading or sizing an audio body', { timeout: 5_000 }, async (t) => {
  const { origin, service } = await fixture(t);
  // Send only headers claiming an oversized body. A server that reads first would
  // answer 413 or wait forever for bytes instead of rejecting the invalid grant.
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(`${origin}/api/speech/v1/transcriptions`, {
      method: 'POST', headers: { authorization: 'Bearer rejected_fixture_grant', 'content-type': 'audio/wav', 'content-length': String(MAX_BYTES + 1) },
    }, (incoming) => {
      let body = ''; incoming.setEncoding('utf8'); incoming.on('data', (part) => { body += part; });
      incoming.on('end', () => { outgoing.destroy(); resolve({ status: incoming.statusCode!, body }); });
    });
    outgoing.on('error', reject); outgoing.flushHeaders();
  });
  assert.equal(response.status, 403);
  assert.equal(JSON.parse(response.body).code, 'provider_forbidden');
  assert.equal(service.recognized, 0);
});

test('provider routes enforce WAV media type and bounded valid audio without browser cookies or CSRF', async (t) => {
  const { origin, service } = await fixture(t);
  const route = `${origin}/api/speech/v1/transcriptions`;
  const headers = { authorization: `Bearer ${providerToken}`, 'content-type': 'audio/wav' };
  assert.equal((await fetch(route, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 415);
  assert.equal((await fetch(route, { method: 'POST', headers, body: new Uint8Array(MAX_BYTES + 1) })).status, 413);
  assert.equal((await fetch(route, { method: 'POST', headers, body: 'not a WAV recording' })).status, 400);
  const accepted = await fetch(`${route}?language=ru`, { method: 'POST', headers, body: new Uint8Array(wave()) });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { text: 'Пример.', language: 'ru' });
  assert.equal(service.recognized, 1);
});

for (const [session, status] of [
  [{ status: 'not-present' }, 401], [{ status: 'expired' }, 401], [{ status: 'forbidden' }, 403],
  [{ status: 'unavailable' }, 503], [{ status: 'misconfigured' }, 503], [user, 403], [admin, 200],
] as const) {
  test(`settings classify ${session.status}${session.status === 'active' ? `/${session.identity.hostRole}` : ''} as HTTP ${status}`, async (t) => {
    const { origin } = await fixture(t, { resolveSession: async () => session });
    const result = await fetch(`${origin}/api/settings`);
    assert.equal(result.status, status);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  });
}

test('administrator settings and downloads require same-origin requests and bounded JSON', async (t) => {
  const { origin, service } = await fixture(t);
  const authorization = `Bearer ${browserToken}`;
  const settings = `${origin}/api/settings`;
  const body = JSON.stringify({ revision: 0, modelId: 'fixture', backend: 'auto' });
  assert.equal((await fetch(settings, { method: 'POST', headers: { authorization }, body })).status, 403);
  assert.equal((await fetch(settings, { method: 'POST', headers: { authorization, origin: 'https://unrelated.example.test' }, body })).status, 403);
  assert.equal(service.activations.length, 0);
  assert.equal((await fetch(settings, { method: 'POST', headers: { authorization, origin }, body: '{invalid' })).status, 400);
  assert.equal((await fetch(settings, { method: 'POST', headers: { authorization, origin }, body: ' '.repeat(8_193) })).status, 413);
  assert.equal((await fetch(settings, { method: 'POST', headers: { authorization, origin }, body })).status, 202);
  assert.equal(service.activations.length, 1);
  assert.equal((await fetch(`${origin}/api/models/fixture/download`, { method: 'POST', headers: { authorization }, body: '{}' })).status, 403);
});

test('null launch-code JSON is a bad request rather than a server availability failure', async (t) => {
  const { origin } = await fixture(t);
  const response = await fetch(`${origin}/api/auth/app-code`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'null' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'app_code_invalid');
});

test('model deletion and recording limits require administrator own-app authority and a same-origin request', async (t) => {
  const { origin, service } = await fixture(t);
  for (const path of ['/api/models/fixture/delete', '/api/recording-settings']) {
    const body = path.endsWith('/delete') ? '{}' : JSON.stringify({ revision: 0, recordingLimitSeconds: 120 });
    assert.equal((await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${browserToken}` }, body })).status, 403);
    assert.equal((await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${browserToken}`, origin: 'https://unrelated.example.test' }, body })).status, 403);
    assert.equal((await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${providerToken}`, origin }, body })).status, 401);
  }
  assert.deepEqual(service.removals, []);
  assert.deepEqual(service.recordingSettings, []);
  const headers = { authorization: `Bearer ${browserToken}`, origin, 'content-type': 'application/json' };
  const deleted = await fetch(`${origin}/api/models/fixture/delete`, { method: 'POST', headers, body: '{}' });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).settings.modelId, 'fixture');
  const limit = await fetch(`${origin}/api/recording-settings`, { method: 'POST', headers, body: JSON.stringify({ revision: 0, recordingLimitSeconds: 120 }) });
  assert.equal(limit.status, 200);
  assert.deepEqual(service.removals, ['fixture']);
  assert.deepEqual(service.recordingSettings, [{ revision: 0, recordingLimitSeconds: 120 }]);
});

test('ordinary assigned users cannot delete models or change shared recording limits', async (t) => {
  const { origin, service } = await fixture(t, { resolveSession: async () => user });
  for (const path of ['/api/models/fixture/delete', '/api/recording-settings']) {
    const response = await fetch(origin + path, { method: 'POST', headers: { origin }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.deepEqual(service.removals, []);
  assert.deepEqual(service.recordingSettings, []);
});

test('provider upload bounds use the current capabilities rather than a fixed global audio limit', async (t) => {
  const { origin, service } = await fixture(t);
  service.limitSeconds = 15;
  const headers = { authorization: `Bearer ${providerToken}`, 'content-type': 'audio/wav' };
  const response = await fetch(`${origin}/api/speech/v1/transcriptions`, { method: 'POST', headers, body: new Uint8Array(service.capabilities().maxBytes + 1) });
  assert.equal(response.status, 413);
  assert.equal(service.recognized, 0);
  const capabilities = await fetch(`${origin}/api/speech/v1/capabilities`, { headers });
  const advertised = await capabilities.json();
  assert.equal(advertised.maxDurationSeconds, 15);
  assert.equal(advertised.maxBytes, 15 * 32_000 + 4_096);
});

function managedEnvironment(t: TestContext) {
  const values = { HOSTY_APP_DATA_DIR: '/fixture/speech/data', HOSTY_APP_CACHE_DIR: '/fixture/speech/cache',
    HOSTY_APP_ID: 'fixture.speech', HOSTY_APP_SERVICE_TOKEN: 'fixture_service_identity', HOSTY_CORE_ORIGIN: 'https://core.example.test' };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

test('listen failure closes the initialized worker instead of leaving a failed app resident', async (t) => {
  managedEnvironment(t);
  const blocker = createServer(); blocker.listen(0, '0.0.0.0'); await once(blocker, 'listening');
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const service = new FakeService();
  await assert.rejects(start({ service: service as unknown as SpeechService, port: (blocker.address() as AddressInfo).port }), { code: 'EADDRINUSE' });
  assert.equal(service.initializations, 1);
  assert.equal(service.closes, 1);
  assert.equal(service.initializedWorker, false);
});

test('initialization failure cleans up any worker prepared before the failure', async (t) => {
  managedEnvironment(t);
  const service = new FakeService();
  service.initializationFailure = new Error('Fixture initialization failed after worker preparation.');
  await assert.rejects(start({ service: service as unknown as SpeechService, port: 0 }), service.initializationFailure);
  assert.equal(service.initializations, 1);
  assert.equal(service.closes, 1);
  assert.equal(service.initializedWorker, false);
});

test('managed start binds a host-gateway reachable interface and stop closes its worker once', async (t) => {
  managedEnvironment(t);
  t.mock.method(console, 'info', () => {});
  const service = new FakeService();
  const previousTerm = process.listenerCount('SIGTERM'), previousInt = process.listenerCount('SIGINT');
  const runtime = await start({ service: service as unknown as SpeechService, port: 0 });
  t.after(() => runtime.stop());
  assert.equal((runtime.server.address() as AddressInfo).address, '0.0.0.0');
  const closed = once(runtime.server, 'close');
  await Promise.all([runtime.stop(), runtime.stop(), closed]);
  assert.equal(service.closes, 1);
  assert.equal(service.initializedWorker, false);
  assert.equal(process.listenerCount('SIGTERM'), previousTerm);
  assert.equal(process.listenerCount('SIGINT'), previousInt);
});

test('unexpected provider failures return a stable 503 message without exposing error details', async (t) => {
  const sensitiveFixture = 'fixture_error_detail_should_not_leave_the_server';
  const { origin } = await fixture(t, { validateProvider: async () => { throw new Error(sensitiveFixture); } });
  const response = await fetch(`${origin}/api/speech/v1/capabilities`, { headers: { authorization: `Bearer ${providerToken}` } });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(sensitiveFixture), false);
});

test('closing an authenticated settings stream removes its change listener', { timeout: 5_000 }, async (t) => {
  const { origin, service } = await fixture(t);
  const cancelled = new AbortController();
  const response = await fetch(`${origin}/api/events`, { headers: { authorization: `Bearer ${browserToken}` }, signal: cancelled.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /event: state/);
  assert.equal(service.listenerCount('change'), 1);
  const removed = once(service, 'removeListener');
  cancelled.abort();
  await reader.cancel().catch(() => {});
  const [event] = await removed;
  assert.equal(event, 'change');
  assert.equal(service.listenerCount('change'), 0);
});
