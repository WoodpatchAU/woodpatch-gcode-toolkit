// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// A machine's calibration stays private (ADR-0047): its record, the programs generated
// from it, its measured times and its fitted factors. This repository holds only the
// tools. Fails, naming each path, if a tracked file looks like one of those:
//
//   - the generator's runs file (calibration-runs.json), anywhere;
//   - a generated program: named cal-NN-*, or carrying the generator's air-cut header;
//   - any G-code or JSON file under tools/calibration/ or docs/;
//   - a machine record (format "woodpatch-gcode-machine") in a JSON file, other than the
//     fictional example and the schema.
//
//   node .github/ci/calibration-private.mjs     checks `git ls-files`

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The only JSON files that may name the record format. */
const ALLOWED_RECORDS = new Set([
  'packages/db-schema/examples/example-router.json',
  'packages/db-schema/schema/machine-record-v1.schema.json',
]);
const GCODE = /\.(nc|ngc|tap|gcode|cnc)$/i;
const HEADER = 'CALIBRATION AIR CUT';

/** The offending paths, with why. `read` returns a file's text. */
export function findPrivate(paths, read) {
  const out = [];
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    const where = /^(tools\/calibration|docs)\//.test(p);
    if (base === 'calibration-runs.json') out.push(`${p}: a calibration runs file`);
    else if (/^cal-\d\d-/i.test(base) && GCODE.test(base))
      out.push(`${p}: a generated calibration program`);
    else if (where && (GCODE.test(base) || /\.json$/i.test(base))) {
      out.push(`${p}: G-code or JSON under tools/calibration/ or docs/`);
    } else if (GCODE.test(base) || /\.json$/i.test(base)) {
      const text = read(p);
      if (GCODE.test(base) && text.includes(HEADER)) {
        out.push(`${p}: carries the calibration programs' header`);
      } else if (
        /\.json$/i.test(base) &&
        text.includes('woodpatch-gcode-machine') &&
        !ALLOWED_RECORDS.has(p)
      ) {
        out.push(`${p}: a machine record`);
      }
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hits = findPrivate(paths, (p) => readFileSync(p, 'utf8'));
  for (const h of hits)
    process.stderr.write(`::error::${h} (a machine's calibration stays private, ADR-0047)\n`);
  process.exit(hits.length ? 1 : 0);
}
