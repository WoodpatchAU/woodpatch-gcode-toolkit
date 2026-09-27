// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The playground's bundle budget (parcel 3f, ADR-0031; operator decision 2026-09-27):
// gzipped, the page's JavaScript must stay within 300 kB and the worker's within 40 kB.
// Fails the build otherwise. Real growth (a new heavy dependency, say) has to be a
// deliberate budget change in the same PR, not something that just happens.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = { page: 300, worker: 40 };

const assets = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'dist/assets');
const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
const gz = (f) => gzipSync(readFileSync(join(assets, f)), { level: 9 }).length;
const kb = (bytes) => (bytes / 1000).toFixed(1);

// The page's code is what its entry loads: the entry chunk plus everything reachable
// through its static and dynamic imports, per Vite's manifest. Every other JS chunk is
// the worker's, however many chunks the worker is split into. (File names would guess;
// the manifest knows.)
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(assets, '../.vite/manifest.json'), 'utf8'));
} catch {
  console.error('::error::bundle budget: dist/.vite/manifest.json missing (build.manifest)');
  process.exit(1);
}
const pageFiles = new Set();
const visit = (key) => {
  const chunk = manifest[key];
  if (!chunk || pageFiles.has(chunk.file)) return;
  pageFiles.add(chunk.file);
  for (const k of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(k);
};
for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
const page = js.filter((f) => pageFiles.has(`assets/${f}`));
const worker = js.filter((f) => !pageFiles.has(`assets/${f}`));
if (worker.length === 0 || page.length === 0) {
  console.error(`::error::bundle budget: expected page and worker chunks, found ${js.join(', ')}`);
  process.exit(1);
}
let failed = false;
for (const [name, files] of [
  ['page', page],
  ['worker', worker],
]) {
  const size = files.reduce((sum, f) => sum + gz(f), 0);
  const limit = BUDGET_KB[name] * 1000;
  const line = `${name}: ${kb(size)} kB gzipped of ${BUDGET_KB[name]} kB (${files.join(', ')})`;
  if (size > limit) {
    failed = true;
    console.error(`::error::bundle budget exceeded, ${line}`);
  } else console.log(`bundle budget ok, ${line}`);
}
process.exitCode = failed ? 1 : 0;
