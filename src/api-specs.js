import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SPEC_FILES = [
  { version: 'v1', file: 'bloom-growth-v1.json' },
  { version: 'v2', file: 'bloom-growth-v2.json' },
];

const apiDir = new URL('../api/', import.meta.url);

export function specPath(file) {
  return fileURLToPath(new URL(file, apiDir));
}

export function loadSpecs() {
  return SPEC_FILES.map(({ file }) => JSON.parse(readFileSync(specPath(file), 'utf8')));
}
