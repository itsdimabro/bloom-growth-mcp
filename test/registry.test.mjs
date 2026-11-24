import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('server.json names the package the registry will verify', () => {
  const [entry] = server.packages;

  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.equal(entry.registryType, 'npm');
  assert.equal(entry.identifier, pkg.name);
  assert.equal(entry.version, pkg.version);
});

test('server.json stays inside the registry description limit', () => {
  assert.ok(server.description.length <= 100, `${server.description.length} characters`);
});

test('server.json lists only settings the README documents', () => {
  for (const { name } of server.packages[0].environmentVariables) assert.ok(readme.includes(`\`${name}\``), name);
});
