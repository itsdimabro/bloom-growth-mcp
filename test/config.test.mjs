import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig } from '../src/config.js';
import { tempDir } from './fake-bloom.mjs';

test('defaults: read-only, every toolset, Bloom over https', () => {
  const config = readConfig({});

  assert.equal(config.allowWrites, false);
  assert.equal(config.toolsets, null);
  assert.equal(config.baseUrl, 'https://app.bloomgrowth.com');
  assert.equal(config.maxResponseChars, 200_000);
});

test('credentials come from the environment first', (t) => {
  const file = join(tempDir(t), 'login.env');
  writeFileSync(file, 'BLOOM_GROWTH_EMAIL=file@example.com\nBLOOM_GROWTH_PASSWORD=from-file\n');
  const config = readConfig({ BLOOM_GROWTH_EMAIL: 'env@example.com', BLOOM_GROWTH_PASSWORD: 'from-env', BLOOM_GROWTH_LOGIN_FILE: file });

  assert.deepEqual(config.readCredentials(), { email: 'env@example.com', password: 'from-env' });
});

test('a login file is read on every sign-in, with the usual file quirks', (t) => {
  const file = join(tempDir(t), 'login.env');
  const config = readConfig({ BLOOM_GROWTH_LOGIN_FILE: file });

  writeFileSync(file, '﻿# login\r\nexport BLOOM_GROWTH_EMAIL=a@example.com\r\nBLOOM_GROWTH_PASSWORD="p=ss word"\r\n');
  assert.deepEqual(config.readCredentials(), { email: 'a@example.com', password: 'p=ss word' });

  writeFileSync(file, "BLOOM_GROWTH_EMAIL = b@example.com\nBLOOM_GROWTH_PASSWORD='second'\n");
  assert.deepEqual(config.readCredentials(), { email: 'b@example.com', password: 'second' });
});

test('a missing login says which settings to fill and where it looked', (t) => {
  assert.throws(() => readConfig({}).readCredentials(), /missing in the environment\. Set BLOOM_GROWTH_EMAIL and BLOOM_GROWTH_PASSWORD/);

  const file = join(tempDir(t), 'login.env');
  writeFileSync(file, 'BLOOM_GROWTH_EMAIL=a@example.com\nBLOOM_GROWTH_PASSWORD=\n');
  assert.throws(() => readConfig({ BLOOM_GROWTH_LOGIN_FILE: file }).readCredentials(), (error) => error.message.includes(file));

  const gone = join(tempDir(t), 'gone.env');
  assert.throws(() => readConfig({ BLOOM_GROWTH_LOGIN_FILE: gone }).readCredentials(), /cannot be read \(ENOENT\)/);
});

test('an error about the login never repeats the password', (t) => {
  const file = join(tempDir(t), 'login.env');
  writeFileSync(file, 'BLOOM_GROWTH_PASSWORD=hunter2\n');

  assert.throws(() => readConfig({ BLOOM_GROWTH_LOGIN_FILE: file }).readCredentials(), (error) => !error.message.includes('hunter2'));
});

test('the token cache is one file per account and server, outside the package', (t) => {
  const cache = tempDir(t);
  const env = { XDG_CACHE_HOME: cache, LOCALAPPDATA: cache };
  const config = readConfig(env);
  const first = config.tokenFileFor('A@example.com');

  assert.equal(first, config.tokenFileFor('a@example.com'));
  assert.notEqual(first, config.tokenFileFor('b@example.com'));
  assert.notEqual(first, readConfig({ ...env, BLOOM_GROWTH_BASE_URL: 'http://localhost:9' }).tokenFileFor('a@example.com'));
  assert.ok(first.startsWith(join(cache, 'bloom-growth-mcp')));
  assert.equal(first.includes('example.com'), false);

  const chosen = join(cache, 'chosen.json');
  assert.equal(readConfig({ BLOOM_GROWTH_TOKEN_FILE: chosen }).tokenFileFor('a@example.com'), chosen);
});

test('the password is only ever sent over https, or to this computer', () => {
  assert.throws(() => readConfig({ BLOOM_GROWTH_BASE_URL: 'http://app.bloomgrowth.com' }), /must use https/);
  assert.throws(() => readConfig({ BLOOM_GROWTH_BASE_URL: 'ftp://localhost' }), /must use https/);
  assert.throws(() => readConfig({ BLOOM_GROWTH_BASE_URL: 'nonsense' }), /not a URL/);
  assert.equal(readConfig({ BLOOM_GROWTH_BASE_URL: 'http://127.0.0.1:8080/x' }).baseUrl, 'http://127.0.0.1:8080');
});

test('switches and lists are parsed strictly', () => {
  assert.equal(readConfig({ BLOOM_GROWTH_WRITES: '1' }).allowWrites, true);
  assert.equal(readConfig({ BLOOM_GROWTH_WRITES: 'true' }).allowWrites, true);
  assert.equal(readConfig({ BLOOM_GROWTH_WRITES: '0' }).allowWrites, false);
  assert.throws(() => readConfig({ BLOOM_GROWTH_WRITES: 'yes please' }), /BLOOM_GROWTH_WRITES must be 1 or 0/);

  assert.deepEqual(readConfig({ BLOOM_GROWTH_TOOLSETS: ' Todos, rocks ,' }).toolsets, ['todos', 'rocks']);
  assert.equal(readConfig({ BLOOM_GROWTH_TOOLSETS: 'all' }).toolsets, null);

  assert.equal(readConfig({ BLOOM_GROWTH_MAX_RESPONSE_CHARS: '5000' }).maxResponseChars, 5000);
  assert.throws(() => readConfig({ BLOOM_GROWTH_MAX_RESPONSE_CHARS: 'lots' }), /whole number/);
});
