// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Writes each `run: |` block of a workflow to its own .sh file, so CI can shellcheck the
// release workflow's scripts (ADR-0051): that is where its checks live. Each file starts
// with the shell GitHub runs it under (bash -e -o pipefail).
//
//   node .github/ci/workflow-scripts.mjs <workflow.yml> <out-dir>
//
// Refuses a block holding a `${{ ... }}` expression: workflow values reach these
// scripts through env:, never as text spliced into the script.

import console from 'node:console';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const [file, out] = process.argv.slice(2);
if (!file || !out) {
  console.error('usage: workflow-scripts.mjs <workflow.yml> <out-dir>');
  process.exit(2);
}
const lines = readFileSync(file, 'utf8').split('\n');
mkdirSync(out, { recursive: true });
let n = 0;
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)run: \|$/.exec(lines[i]);
  if (!m) continue;
  const indent = m[1].length + 2;
  const body = [];
  for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) >= indent); i++)
    body.push(lines[i].slice(indent));
  i--;
  const text = body.join('\n').trimEnd();
  if (text.includes('${{')) {
    console.error(
      `${file}: a run block near line ${i + 1} splices a \${{ }} expression into the script`,
    );
    process.exit(1);
  }
  n++;
  writeFileSync(
    join(out, `${String(n).padStart(2, '0')}.sh`),
    `#!/bin/bash\nset -eo pipefail\n${text}\n`,
  );
}
if (n === 0) {
  console.error(`${file}: no run blocks found`);
  process.exit(1);
}
console.log(`${n} script(s) written to ${out}`);
