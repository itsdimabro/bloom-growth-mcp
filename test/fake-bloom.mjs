import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOGIN = { email: 'integrations@example.com', password: 'correct-horse' };

/** A temp folder that is removed when the test ends. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bgm-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/**
 * A local stand-in for Bloom Growth: the token endpoint plus an echo of every API request.
 * state.replies is a queue of { status, payload, headers, raw, delayMs } served before the echo.
 */
export async function startFakeBloom(t, { tokens = ['token-1', 'token-2', 'token-3'], expiresIn = 14 * 24 * 60 * 60, tokenDelayMs = 0 } = {}) {
  const calls = [];
  const state = { issued: 0, replies: [] };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://fake');
    const reply = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload));
    };

    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      calls.push({ kind: 'token', form: Object.fromEntries(form) });
      if (tokenDelayMs) await new Promise((resolve) => setTimeout(resolve, tokenDelayMs));
      if (form.get('userName') !== LOGIN.email || form.get('password') !== LOGIN.password) {
        return reply(400, { error: true, message: 'Authentication failed' });
      }
      const accessToken = tokens[Math.min(state.issued, tokens.length - 1)];
      state.issued += 1;
      return reply(200, { access_token: accessToken, token_type: 'bearer', expires_in: expiresIn });
    }

    const call = {
      kind: 'api',
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: req.headers.authorization,
      contentType: req.headers['content-type'],
      body: body ? JSON.parse(body) : undefined,
    };
    calls.push(call);
    const queued = state.replies.shift();
    if (queued) {
      if (queued.delayMs) await new Promise((resolve) => setTimeout(resolve, queued.delayMs));
      return reply(queued.status ?? 200, queued.raw ?? queued.payload, queued.headers);
    }
    return reply(200, { echo: call });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    state,
    apiCalls: () => calls.filter((call) => call.kind === 'api'),
    tokenCalls: () => calls.filter((call) => call.kind === 'token'),
  };
}
