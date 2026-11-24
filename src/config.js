import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'https://app.bloomgrowth.com';
const DEFAULT_MAX_RESPONSE_CHARS = 200_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CACHE_FOLDER = 'bloom-growth-mcp';

/**
 * Reads every setting from the environment. Throws on a value it cannot use, so a typo stops
 * the server at startup. Credentials are read on each sign-in, never at startup.
 */
export function readConfig(env = process.env) {
  const baseUrl = parseBaseUrl(env.BLOOM_GROWTH_BASE_URL || DEFAULT_BASE_URL);
  return {
    baseUrl,
    allowWrites: parseFlag('BLOOM_GROWTH_WRITES', env.BLOOM_GROWTH_WRITES),
    toolsets: parseList(env.BLOOM_GROWTH_TOOLSETS),
    maxResponseChars: parseCount('BLOOM_GROWTH_MAX_RESPONSE_CHARS', env.BLOOM_GROWTH_MAX_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS),
    readCredentials: () => readCredentials(env),
    tokenFileFor: (email) =>
      env.BLOOM_GROWTH_TOKEN_FILE ||
      join(cacheDir(env), `token-${createHash('sha256').update(`${baseUrl}\n${email.toLowerCase()}`).digest('hex').slice(0, 16)}.json`),
  };
}

function readCredentials(env) {
  let values = env;
  if (!env.BLOOM_GROWTH_EMAIL && !env.BLOOM_GROWTH_PASSWORD && env.BLOOM_GROWTH_LOGIN_FILE) {
    values = parseLoginFile(env.BLOOM_GROWTH_LOGIN_FILE);
  }
  const email = values.BLOOM_GROWTH_EMAIL;
  const password = values.BLOOM_GROWTH_PASSWORD;
  if (!email || !password) {
    const where = values === env ? 'the environment' : env.BLOOM_GROWTH_LOGIN_FILE;
    throw new Error(
      `Bloom Growth login is missing in ${where}. Set BLOOM_GROWTH_EMAIL and BLOOM_GROWTH_PASSWORD, or point BLOOM_GROWTH_LOGIN_FILE at a file that holds both.`,
    );
  }
  return { email, password };
}

function parseLoginFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Bloom Growth login file cannot be read (${error.code ?? error.message}): ${file}`);
  }
  const values = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    const at = line.indexOf('=');
    if (at < 1 || line.startsWith('#')) continue;
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

function parseBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`BLOOM_GROWTH_BASE_URL is not a URL: ${value}`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new Error('BLOOM_GROWTH_BASE_URL must use https, because the password is sent to it');
  }
  return url.origin;
}

function parseFlag(name, value) {
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error(`${name} must be 1 or 0, got: ${value}`);
}

function parseList(value) {
  const items = (value ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return items.length && !items.includes('all') ? items : null;
}

function parseCount(name, value, fallback) {
  if (value === undefined || value === '') return fallback;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) throw new Error(`${name} must be a whole number above 0, got: ${value}`);
  return count;
}

function cacheDir(env) {
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, CACHE_FOLDER);
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), CACHE_FOLDER);
}
