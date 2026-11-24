import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBloomClient, toRequest } from '../src/bloom-client.js';
import { LOGIN, startFakeBloom, tempDir } from './fake-bloom.mjs';

const posix = process.platform !== 'win32';

function setUp(t, bloom, { password = LOGIN.password, ...options } = {}) {
  const tokenFile = join(tempDir(t), 'cache', 'token.json');
  const warnings = [];
  const client = createBloomClient({
    baseUrl: bloom.baseUrl,
    readCredentials: () => ({ email: LOGIN.email, password }),
    tokenFileFor: () => tokenFile,
    warn: (message) => warnings.push(message),
    wait: async () => {},
    ...options,
  });
  return { client, tokenFile, warnings };
}

const me = { method: 'GET', path: '/api/v1/users/mine' };

test('signs in with the credentials, then sends the token', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom);

  const payload = await client.request(me);

  assert.deepEqual(bloom.tokenCalls()[0].form, { grant_type: 'password', userName: LOGIN.email, password: LOGIN.password });
  assert.equal(payload.echo.authorization, 'Bearer token-1');
});

test('keeps the token between requests and between processes', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client, tokenFile } = setUp(t, bloom);

  await client.request(me);
  await client.request({ method: 'GET', path: '/api/v1/weeks/current' });
  const second = createBloomClient({ baseUrl: bloom.baseUrl, readCredentials: () => LOGIN, tokenFileFor: () => tokenFile });
  await second.request(me);

  assert.equal(bloom.tokenCalls().length, 1);
  assert.equal(JSON.parse(readFileSync(tokenFile, 'utf8')).accessToken, 'token-1');
  assert.deepEqual(readdirSync(join(tokenFile, '..')), ['token.json']);
});

test('the token file and its folder are private to the user', { skip: !posix }, async (t) => {
  const bloom = await startFakeBloom(t);
  const { client, tokenFile } = setUp(t, bloom);

  await client.request(me);

  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(tokenFile, '..')).mode & 0o777, 0o700);
});

test('a saved token that others could read becomes private when it is reused', { skip: !posix }, async (t) => {
  const bloom = await startFakeBloom(t);
  const { client, tokenFile } = setUp(t, bloom);
  await client.request(me);
  chmodSync(tokenFile, 0o644);

  const fresh = createBloomClient({ baseUrl: bloom.baseUrl, readCredentials: () => LOGIN, tokenFileFor: () => tokenFile });
  await fresh.request(me);

  assert.equal(bloom.tokenCalls().length, 1);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
});

test('a saved token of another user or another server is not used', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client, tokenFile } = setUp(t, bloom);
  await client.request(me);
  const saved = JSON.parse(readFileSync(tokenFile, 'utf8'));

  for (const change of [{ email: 'someone-else@example.com' }, { baseUrl: 'https://other.example.com' }, { email: undefined }]) {
    writeFileSync(tokenFile, JSON.stringify({ ...saved, accessToken: 'not-mine', ...change }));
    const fresh = createBloomClient({ baseUrl: bloom.baseUrl, readCredentials: () => LOGIN, tokenFileFor: () => tokenFile });
    const payload = await fresh.request(me);
    assert.notEqual(payload.echo.authorization, 'Bearer not-mine');
  }
  assert.equal(bloom.tokenCalls().length, 4);
});

test('calls that start together share one sign-in', async (t) => {
  const bloom = await startFakeBloom(t, { tokenDelayMs: 50 });
  const { client } = setUp(t, bloom);

  const results = await Promise.all([client.request(me), client.request(me), client.request(me)]);

  assert.equal(bloom.tokenCalls().length, 1);
  assert.ok(results.every((payload) => payload.echo.authorization === 'Bearer token-1'));
});

test('calls rejected together share one new sign-in', async (t) => {
  const bloom = await startFakeBloom(t, { tokenDelayMs: 50 });
  const { client } = setUp(t, bloom);
  await client.request(me);
  bloom.state.replies.push({ status: 401 }, { status: 401 });

  const results = await Promise.all([client.request(me), client.request(me)]);

  assert.equal(bloom.tokenCalls().length, 2);
  assert.ok(results.every((payload) => payload.echo.authorization === 'Bearer token-2'));
});

test('a saved token near its end is replaced', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client, tokenFile } = setUp(t, bloom);
  await client.request(me);
  const saved = JSON.parse(readFileSync(tokenFile, 'utf8'));
  writeFileSync(tokenFile, JSON.stringify({ ...saved, accessToken: 'old', issuedAt: Date.now() - 14 * 24 * 60 * 60 * 1000, expiresAt: Date.now() + 60_000 }));

  const fresh = createBloomClient({ baseUrl: bloom.baseUrl, readCredentials: () => LOGIN, tokenFileFor: () => tokenFile });
  const payload = await fresh.request(me);

  assert.equal(payload.echo.authorization, 'Bearer token-2');
});

for (const expiresIn of [3600, 120]) {
  test(`a token that lasts ${expiresIn} seconds is reused, not requested again on every call`, async (t) => {
    const bloom = await startFakeBloom(t, { expiresIn });
    const { client } = setUp(t, bloom);

    await client.request(me);
    await client.request(me);

    assert.equal(bloom.tokenCalls().length, 1);
  });
}

test('a token past its end is replaced before it is sent', async (t) => {
  const bloom = await startFakeBloom(t, { expiresIn: 120 });
  let clock = Date.now();
  const { client } = setUp(t, bloom, { now: () => clock });

  await client.request(me);
  clock += 119_000;
  const payload = await client.request(me);

  assert.equal(payload.echo.authorization, 'Bearer token-2');
  assert.equal(bloom.apiCalls().length, 2);
});

for (const rejection of [{ status: 400, payload: { error: true, message: 'Token invalid' } }, { status: 401 }]) {
  test(`signs in once more when Bloom rejects the token with ${rejection.status}`, async (t) => {
    const bloom = await startFakeBloom(t);
    const { client } = setUp(t, bloom);
    await client.request(me);
    bloom.state.replies.push(rejection);

    const payload = await client.request(me);

    assert.equal(bloom.tokenCalls().length, 2);
    assert.equal(payload.echo.authorization, 'Bearer token-2');
  });
}

test('a token rejected twice in a row fails instead of looping', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom);
  bloom.state.replies.push({ status: 401 }, { status: 401 });

  await assert.rejects(client.request(me), /Bloom Growth answered 401/);
  assert.equal(bloom.tokenCalls().length, 2);
  assert.equal(bloom.apiCalls().length, 2);
});

test('the request still works when the token cannot be cached', async (t) => {
  const bloom = await startFakeBloom(t);
  const blocker = join(tempDir(t), 'not-a-folder');
  writeFileSync(blocker, '');
  const { client, warnings } = setUp(t, bloom, { tokenFileFor: () => join(blocker, 'token.json') });

  const payload = await client.request(me);
  await client.request(me);

  assert.equal(payload.echo.authorization, 'Bearer token-1');
  assert.equal(bloom.tokenCalls().length, 1);
  assert.match(warnings[0], /not cached/);
});

test("reports Bloom's own message when a request fails", async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom);
  bloom.state.replies.push({ status: 400, payload: { error: true, message: 'Cannot view measurable' } });

  await assert.rejects(client.request(me), /Bloom Growth answered 400: Cannot view measurable/);
  assert.equal(bloom.tokenCalls().length, 1);
});

test("a wrong password fails with Bloom's message and saves nothing", async (t) => {
  const bloom = await startFakeBloom(t);
  const { client, tokenFile } = setUp(t, bloom, { password: 'wrong' });

  await assert.rejects(client.request(me), /sign-in failed \(400\): Authentication failed/);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(bloom.apiCalls().length, 0);
});

test('a failed sign-in can be retried by the next call', async (t) => {
  const bloom = await startFakeBloom(t);
  let password = 'wrong';
  const { client } = setUp(t, bloom, { readCredentials: () => ({ email: LOGIN.email, password }) });

  await assert.rejects(client.request(me), /sign-in failed/);
  password = LOGIN.password;
  const payload = await client.request(me);

  assert.equal(payload.echo.authorization, 'Bearer token-1');
});

test('waits and tries again when Bloom says it is busy', async (t) => {
  const bloom = await startFakeBloom(t);
  const waits = [];
  const { client } = setUp(t, bloom, { wait: async (ms) => waits.push(ms) });
  bloom.state.replies.push({ status: 429, headers: { 'Retry-After': '3' } }, { status: 429 });

  const payload = await client.request(me);

  assert.equal(payload.echo.path, '/api/v1/users/mine');
  assert.deepEqual(waits, [3000, 2000]);
});

test('gives up after three busy answers', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom);
  bloom.state.replies.push({ status: 429 }, { status: 429 }, { status: 429 });

  await assert.rejects(client.request(me), /Bloom Growth answered 429/);
  assert.equal(bloom.apiCalls().length, 3);
});

test('stops waiting for an answer after the time limit', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom, { timeoutMs: 100 });
  await client.request(me);
  bloom.state.replies.push({ delayMs: 2000 });

  await assert.rejects(client.request(me), /Could not reach Bloom Growth \(no answer in 0\.1 s\)/);
});

test('the time limit also covers a body that never finishes', async (t) => {
  const { client } = setUp(t, { baseUrl: 'https://bloom.invalid' }, {
    timeoutMs: 100,
    fetch: async (url, { signal }) => {
      if (String(url).endsWith('/token')) return Response.json({ access_token: 'token-1', expires_in: 3600 });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"slow":'));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        },
      });
      return new Response(body);
    },
  });

  await assert.rejects(client.request(me), /Could not reach Bloom Growth \(no answer in 0\.1 s\)/);
});

test('an answer larger than the limit is refused, not held in memory', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom, { maxBodyBytes: 1000 });
  await client.request(me);
  bloom.state.replies.push({ payload: { text: 'x'.repeat(5000) } });

  await assert.rejects(client.request(me), /answer is larger than 1000 bytes/);
});

test('names the cause when Bloom cannot be reached', async (t) => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { client } = setUp(t, { baseUrl: `http://127.0.0.1:${port}` });

  await assert.rejects(client.request(me), /Could not reach Bloom Growth \(ECONNREFUSED\)/);
});

test('an empty answer is null and a non-JSON answer is its text', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom);
  bloom.state.replies.push({ status: 204, raw: '' }, { status: 200, raw: 'plain words' });

  assert.equal(await client.request(me), null);
  assert.equal(await client.request(me), 'plain words');
});

test('sends query values and a JSON body', async (t) => {
  const bloom = await startFakeBloom(t);
  const { client } = setUp(t, bloom);

  const payload = await client.request({
    method: 'PUT',
    path: '/api/v1/measurables/7/week/2900',
    query: { INCLUDE_ORIGIN: true, skipped: undefined },
    body: { value: null },
  });

  assert.deepEqual(payload.echo.query, { INCLUDE_ORIGIN: 'true' });
  assert.deepEqual(payload.echo.body, { value: null });
  assert.equal(payload.echo.contentType, 'application/json');
});

const shape = { method: 'PUT', path: '/api/v1/l10/{MEETING_ID}/users/{USER_ID}/todos', queryParams: ['INCLUDE_CLOSED'], hasBody: true, bodyRequired: true };

test('toRequest fills the path, picks the query inputs and keeps the body', () => {
  assert.deepEqual(toRequest(shape, { MEETING_ID: 12, USER_ID: 'a/b', INCLUDE_CLOSED: false, other: 1, body: { x: 1 } }), {
    method: 'PUT',
    path: '/api/v1/l10/12/users/a%2Fb/todos',
    query: { INCLUDE_CLOSED: false },
    body: { x: 1 },
  });
});

test('toRequest refuses a missing input', () => {
  assert.throws(() => toRequest(shape, { MEETING_ID: 12, body: {} }), /Missing or unusable input: USER_ID/);
  assert.throws(() => toRequest(shape, { MEETING_ID: 12, USER_ID: 3 }), /Missing required input: body/);
});

test('toRequest refuses a path value that would reach another endpoint', () => {
  for (const value of ['..', '.', 'a\nb', { id: 1 }, [1], null]) {
    assert.throws(() => toRequest(shape, { MEETING_ID: value, USER_ID: 3, body: {} }), /MEETING_ID/, JSON.stringify(value));
  }
  assert.equal(toRequest(shape, { MEETING_ID: '../x', USER_ID: 3, body: {} }).path, '/api/v1/l10/..%2Fx/users/3/todos');
});

test('toRequest leaves an optional body out when none is given', () => {
  const optional = { method: 'POST', path: '/api/v1/issues/{ISSUE_ID}/complete', queryParams: [], hasBody: true, bodyRequired: false };

  assert.deepEqual(toRequest(optional, { ISSUE_ID: 5 }), { method: 'POST', path: '/api/v1/issues/5/complete', query: {} });
  assert.deepEqual(toRequest(optional, { ISSUE_ID: 5, body: { complete: true } }).body, { complete: true });
});
