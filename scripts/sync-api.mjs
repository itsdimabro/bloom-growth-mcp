#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SPEC_FILES, specPath } from '../src/api-specs.js';
import { buildTools, listOperations } from '../src/tools.js';

const SOURCE = 'https://dev-api.bloomgrowth.com/swagger';
const TIMEOUT_MS = 30_000;

const keysOf = (spec) => new Set(listOperations([spec]).map(({ method, path }) => `${method.toUpperCase()} ${path}`));

/**
 * Fetches Bloom's current API descriptions and reports what changed. It saves them only when
 * every file was fetched, is a usable description and still builds into tools, so a failure
 * never leaves a mix of old and new files. Returns true when anything changed.
 */
export async function syncApi({ fetchText, readSaved, writeSaved, log, check = false }) {
  const fetched = await Promise.all(
    SPEC_FILES.map(async ({ version, file }) => {
      const text = await fetchText(version);
      let spec;
      try {
        spec = JSON.parse(text);
      } catch {
        throw new Error(`${version}: Bloom's answer is not JSON`);
      }
      if (!spec.paths || !Object.keys(spec.paths).length) throw new Error(`${version}: the description has no paths`);
      return { version, file, text, spec };
    }),
  );

  buildTools(fetched.map(({ spec }) => spec), { allowWrites: true });

  let changed = false;
  for (const { version, file, text, spec } of fetched) {
    const saved = readSaved(file);
    const before = keysOf(JSON.parse(saved));
    const after = keysOf(spec);
    if (text === saved) {
      log(`${version}: up to date (${after.size} operations)`);
      continue;
    }
    changed = true;
    const added = [...after].filter((key) => !before.has(key));
    const removed = [...before].filter((key) => !after.has(key));
    log(`${version}: changed (${before.size} -> ${after.size} operations)`);
    for (const key of added) log(`  + ${key}`);
    for (const key of removed) log(`  - ${key}`);
    if (!added.length && !removed.length) log('  same operations, details changed');
  }

  if (changed && !check) {
    for (const { file, text } of fetched) writeSaved(file, text);
  }
  return changed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const changed = await syncApi({
    check,
    log: console.log,
    readSaved: (file) => readFileSync(specPath(file), 'utf8'),
    writeSaved: (file, text) => writeFileSync(specPath(file), text),
    fetchText: async (version) => {
      const response = await fetch(`${SOURCE}/${version}/swagger.json`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error(`${version}: Bloom answered ${response.status}`);
      return response.text();
    },
  });
  if (changed && check) process.exitCode = 1;
}
