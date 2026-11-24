import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

const TOKEN_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const EXPIRED_TOKEN_MESSAGE = 'Token invalid';
const BUSY_STATUS = 429;
const BUSY_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/**
 * Sends requests to the Bloom Growth API as the user readCredentials returns. It signs in when
 * it has no usable token, caches the token in the file tokenFileFor names, and signs in again
 * once when Bloom rejects the token. Calls that need a sign-in at the same time share one.
 */
export function createBloomClient({
  baseUrl,
  readCredentials,
  tokenFileFor,
  fetch = globalThis.fetch,
  now = Date.now,
  timeoutMs = 30_000,
  maxBodyBytes = MAX_BODY_BYTES,
  wait = pause,
  warn = (message) => process.stderr.write(`bloom-growth-mcp: ${message}\n`),
}) {
  let token = null;
  let signingIn = null;

  function usable(candidate) {
    if (typeof candidate?.accessToken !== 'string') return false;
    if (!Number.isFinite(candidate.issuedAt) || !Number.isFinite(candidate.expiresAt)) return false;
    const margin = Math.min(EXPIRY_MARGIN_MS, (candidate.expiresAt - candidate.issuedAt) / 10);
    return candidate.expiresAt - now() > margin;
  }

  async function call(url, init) {
    let response;
    let text;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      text = await readText(response, maxBodyBytes);
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? `no answer in ${timeoutMs / 1000} s` : (error.cause?.code ?? error.cause?.message ?? error.message);
      throw new Error(`Could not reach Bloom Growth (${reason})`);
    }
    if (text === null) throw new Error(`Bloom Growth's answer is larger than ${maxBodyBytes} bytes`);
    return { response, payload: parsePayload(text) };
  }

  function readSavedToken(file, email) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.email !== email.toLowerCase() || saved.baseUrl !== baseUrl) return null;
      chmodSync(file, 0o600);
      return saved;
    } catch {
      return null;
    }
  }

  function saveToken(file, value) {
    const draft = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(draft, JSON.stringify(value), { mode: 0o600 });
      chmodSync(draft, 0o600);
      renameSync(draft, file);
    } catch (error) {
      if (existsSync(draft)) rmSync(draft, { force: true });
      warn(`the sign-in token was not cached (${error.code ?? error.message}); it stays in memory`);
    }
  }

  async function signInOnce() {
    const { email, password } = readCredentials();
    const { response, payload } = await call(new URL('/token', baseUrl), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'password', userName: email, password }),
    });
    if (!response.ok || typeof payload?.access_token !== 'string') {
      throw new Error(`Bloom Growth sign-in failed (${response.status}): ${messageOf(payload)}`);
    }
    const issuedAt = now();
    token = { accessToken: payload.access_token, issuedAt, expiresAt: expiryOf(payload, issuedAt), email: email.toLowerCase(), baseUrl };
    saveToken(tokenFileFor(email), token);
    return token;
  }

  function signIn() {
    signingIn ??= signInOnce().finally(() => {
      signingIn = null;
    });
    return signingIn;
  }

  async function currentToken() {
    if (usable(token)) return token;
    if (signingIn) return signingIn;
    const { email } = readCredentials();
    const saved = readSavedToken(tokenFileFor(email), email);
    if (usable(saved)) return (token = saved);
    return signIn();
  }

  async function send(request, accessToken) {
    const url = new URL(request.path, baseUrl);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    }
    const hasBody = request.body !== undefined;
    for (let attempt = 0; ; attempt += 1) {
      const result = await call(url, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      });
      if (result.response.status !== BUSY_STATUS || attempt === BUSY_RETRIES) return result;
      await wait(retryWaitOf(result.response, attempt));
    }
  }

  async function request(details) {
    let current = await currentToken();
    let result = await send(details, current.accessToken);
    if (rejectedToken(result)) {
      if (token?.accessToken === current.accessToken) token = null;
      current = usable(token) ? token : await signIn();
      result = await send(details, current.accessToken);
    }
    if (!result.response.ok) {
      throw new Error(`Bloom Growth answered ${result.response.status}: ${messageOf(result.payload)}`);
    }
    return result.payload;
  }

  return { request };
}

/**
 * Builds the request for one tool call from the tool's request shape and the caller's
 * arguments. Refuses a path value that would change which endpoint the request reaches.
 */
export function toRequest(shape, args = {}) {
  const path = shape.path.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = args[name];
    if (!['string', 'number', 'boolean'].includes(typeof value) || value === '') {
      throw new Error(`Missing or unusable input: ${name}`);
    }
    const text = String(value);
    if (text === '.' || text === '..' || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error(`Unusable value for ${name}: ${JSON.stringify(text)}`);
    }
    return encodeURIComponent(text);
  });
  const query = Object.fromEntries(shape.queryParams.map((name) => [name, args[name]]));
  if (shape.bodyRequired && args.body === undefined) throw new Error('Missing required input: body');
  return { method: shape.method, path, query, ...(args.body !== undefined && shape.hasBody ? { body: args.body } : {}) };
}

function rejectedToken({ response, payload }) {
  return response.status === 401 || (response.status === 400 && payload?.message === EXPIRED_TOKEN_MESSAGE);
}

function retryWaitOf(response, attempt) {
  const seconds = Number(response.headers.get('retry-after'));
  const waitMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(waitMs, MAX_RETRY_WAIT_MS);
}

async function readText(response, maxBytes) {
  if (!response.body) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parsePayload(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageOf(payload) {
  if (payload === null || payload === undefined) return 'no details';
  if (typeof payload === 'string') return payload.slice(0, 500);
  const message = payload.message ?? payload.error_description ?? payload.error;
  return typeof message === 'string' ? message : JSON.stringify(payload).slice(0, 500);
}

function expiryOf(payload, issuedAt) {
  const seconds = Number(payload.expires_in);
  return issuedAt + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : TOKEN_LIFETIME_MS);
}
