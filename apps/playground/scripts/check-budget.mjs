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

// The worker is its own chunk (Vite names it after its entry, worker.ts); every other
// chunk is the page's, split or not.
const worker = js.filter((f) => f.startsWith('worker-'));
const page = js.filter((f) => !f.startsWith('worker-'));
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
