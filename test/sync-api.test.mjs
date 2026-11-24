import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { syncApi } from '../scripts/sync-api.mjs';
import { SPEC_FILES, specPath } from '../src/api-specs.js';

const saved = Object.fromEntries(SPEC_FILES.map(({ version, file }) => [version, readFileSync(specPath(file), 'utf8')]));
const fileOf = Object.fromEntries(SPEC_FILES.map(({ version, file }) => [version, file]));

function run(texts, { check = false } = {}) {
  const lines = [];
  const written = {};
  const result = syncApi({
    check,
    log: (line) => lines.push(line),
    readSaved: (file) => saved[SPEC_FILES.find((entry) => entry.file === file).version],
    writeSaved: (file, text) => (written[file] = text),
    fetchText: async (version) => texts[version],
  });
  return { result, lines, written };
}

function edit(version, change) {
  const spec = JSON.parse(saved[version]);
  change(spec);
  return JSON.stringify(spec);
}

test('reports up to date and writes nothing when Bloom sends the saved files', async () => {
  const { result, lines, written } = run(saved);

  assert.equal(await result, false);
  assert.deepEqual(written, {});
  assert.ok(lines.every((line) => line.includes('up to date')));
});

test('lists an added and a removed operation and saves every file', async () => {
  const v1 = edit('v1', (spec) => {
    delete spec.paths['/api/v1/weeks/current'];
    spec.paths['/api/v1/brand/new'] = { get: { tags: ['Week_'], summary: 'New', responses: {} } };
  });
  const { result, lines, written } = run({ ...saved, v1 });

  assert.equal(await result, true);
  assert.ok(lines.includes('  + GET /api/v1/brand/new'));
  assert.ok(lines.includes('  - GET /api/v1/weeks/current'));
  assert.equal(written[fileOf.v1], v1);
  assert.equal(written[fileOf.v2], saved.v2);
});

test('with check it reports the change and writes nothing', async () => {
  const v1 = edit('v1', (spec) => delete spec.paths['/api/v1/weeks/current']);
  const { result, written } = run({ ...saved, v1 }, { check: true });

  assert.equal(await result, true);
  assert.deepEqual(written, {});
});

test('a broken answer for one file leaves every saved file alone', async () => {
  const changedV1 = edit('v1', (spec) => delete spec.paths['/api/v1/weeks/current']);

  for (const [bad, message] of [
    ['<html>down</html>', /not JSON/],
    ['{"paths":{}}', /no paths/],
  ]) {
    const { result, written } = run({ v1: changedV1, v2: bad });
    await assert.rejects(result, message);
    assert.deepEqual(written, {});
  }
});

test('a description that cannot become tools is refused before anything is saved', async () => {
  const v1 = edit('v1', (spec) => {
    spec.paths['/api/v1/todo/create'].post.requestBody.content['application/json'].schema = { $ref: '#/components/schemas/Gone' };
  });
  const { result, written } = run({ ...saved, v1 });

  await assert.rejects(result, /schema it does not have/);
  assert.deepEqual(written, {});
});
