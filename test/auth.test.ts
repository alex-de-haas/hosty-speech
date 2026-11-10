import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test, { type TestContext } from 'node:test';
import { identityCookieName, readAppCredential, readIdentityCookie, resolveAppSession } from '../auth.js';

function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
  }
}

function configured(t: TestContext) {
  environment(t, { HOSTY_APP_ID: 'fixture.speech', HOSTY_CORE_ORIGIN: 'https://core.example.test', HOSTY_APP_SERVICE_TOKEN: 'fixture_service_credential' });
}

const identity = { active: true, appId: 'fixture.speech', userId: 'fixture-user', hostRole: 'host.admin', activeUntil: '2030-01-01T00:00:00Z' };

test('session revalidation checks the own app and uses a bounded, nonredirecting service request', async (t) => {
  configured(t);
  let requestCount = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    requestCount++;
    assert.equal(String(url), 'https://core.example.test/api/auth/apps/revalidate');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture_service_credential');
    assert.deepEqual(JSON.parse(String(init.body)), { accessToken: 'fixture_app_session' });
    return Response.json(identity);
  });
  const result = await resolveAppSession('fixture_app_session');
  assert.equal(result.status, 'active');
  if (result.status === 'active') {
    assert.equal(result.identity.userId, identity.userId);
    assert.equal(result.identity.hostRole, 'host.admin');
  }
  assert.equal(requestCount, 1);
});

for (const [name, payload] of [
  ['inactive identity', { ...identity, active: false }],
  ['wrong application identity', { ...identity, appId: 'another.app' }],
  ['missing user identity', { ...identity, userId: '' }],
  ['missing active confirmation', { ...identity, active: undefined }],
  ['malformed response', null],
] as const) {
  test(`session revalidation rejects ${name} even on HTTP 200`, async (t) => {
    configured(t);
    t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
    assert.equal((await resolveAppSession('fixture_app_session')).status, 'unavailable');
  });
}

for (const [status, expected] of [[401, 'expired'], [403, 'forbidden'], [500, 'unavailable'], [503, 'unavailable']] as const) {
  test(`session revalidation classifies HTTP ${status} independently of Core error-code wording`, async (t) => {
    configured(t);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'future_core_code', message: 'Fixture failure' } }, { status }));
    const result = await resolveAppSession('fixture_app_session');
    assert.equal(result.status, expected);
  });
}

test('missing or misconfigured sessions avoid network calls', async (t) => {
  environment(t, { HOSTY_CORE_ORIGIN: undefined, HOSTY_APP_SERVICE_TOKEN: undefined });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Unexpected network call'); });
  assert.deepEqual(await resolveAppSession(null), { status: 'not-present' });
  assert.deepEqual(await resolveAppSession('fixture_app_session'), { status: 'misconfigured' });
  assert.equal(calls, 0);
});

test('missing app identity is a configuration failure rather than accepting an unscoped Core identity', async (t) => {
  configured(t);
  environment(t, { HOSTY_APP_ID: undefined });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ ...identity, appId: undefined }); });
  assert.deepEqual(await resolveAppSession('fixture_app_session'), { status: 'misconfigured' });
  assert.equal(calls, 0);
});

test('network and redirect failures stay unavailable without logging credentials or transport errors', async (t) => {
  configured(t);
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture_transport_error_with_credential'); });
  assert.deepEqual(await resolveAppSession('fixture_app_session'), { status: 'unavailable' });
  assert.deepEqual(logs, []);
});

test('browser credential reading accepts only own-app bearer or the dedicated cookie', () => {
  const request = (headers: Record<string, string>) => ({ headers }) as IncomingMessage;
  assert.equal(readAppCredential(request({ authorization: 'Bearer hostyg_fixture_session' })), 'hostyg_fixture_session');
  assert.equal(readAppCredential(request({ authorization: 'Bearer fixture_provider_invocation' })), null);
  assert.equal(readAppCredential(request({ cookie: `${identityCookieName}=fixture%20cookie` })), 'fixture cookie');
  assert.equal(readIdentityCookie(request({ cookie: `${identityCookieName}=%broken` })), null);
  assert.equal(readIdentityCookie(request({ cookie: 'another_identity=fixture_cookie' })), null);
});
