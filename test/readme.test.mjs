import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadSpecs } from '../src/api-specs.js';
import { buildTools, listToolsets } from '../src/tools.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const specs = loadSpecs();

test('the README states the real tool counts', () => {
  const reading = buildTools(specs).length;
  const all = buildTools(specs, { allowWrites: true }).length;

  assert.ok(readme.includes(`${reading} reading tools, and ${all} tools with changes switched on`));
});

test('the README lists every toolset with its real counts', () => {
  const rows = [...readme.matchAll(/^\| `([a-z0-9]+)` \| [^|]+ \| (\d+) \| (\d+) \|$/gm)].map(([, name, reading, all]) => [name, Number(reading), Number(all)]);
  const expected = listToolsets(specs).map((name) => [
    name,
    buildTools(specs, { toolsets: [name] }).length,
    buildTools(specs, { toolsets: [name], allowWrites: true }).length,
  ]);

  assert.deepEqual(rows, expected);
});

test('the README lists every setting the server reads', () => {
  const source = ['config.js', 'server.js'].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n');
  const settings = new Set(source.match(/BLOOM_GROWTH_[A-Z_]+/g));

  assert.ok(settings.size >= 7);
  for (const name of settings) assert.ok(readme.includes(`\`${name}\``), name);
});
