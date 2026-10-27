// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// A machine's calibration stays private (ADR-0047): its record, the programs generated
// from it, its measured times and its fitted factors. This repository holds only the
// tools. Fails, naming each path, if a tracked file looks like one of those. By NAME
// (any case, any extension): a runs file (calibration-runs, runs.json), a generated
// program (cal-N-...) or a fit's output (fit.json, fit.txt). By CONTENT, which survives
// a rename: the generator's air-cut header, a measured time (measuredSeconds), a fit
// (its format name, ADR-0049), or a machine record (its format name) in
// any file but the code that defines it; and the one allowed record, the example, must
// stay fictional (its id, its name, and every value a seed).
//
//   node .github/ci/calibration-private.mjs     checks `git ls-files`
//
// What it can't catch, so review still does: a record or a runs file rewritten without
// its format name, header or field names (as CSV, say); a machine's numbers pasted into
// prose or a test; anything already in history, or only in a branch or PR it never runs
// on; and a file in a MAY_MENTION path (the code and docs are trusted to name these
// things, not to hold a machine's data). It's a net for the likely slip, a generated
// file or a record copied in whole, not a proof that nothing private is here.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE = 'packages/db-schema/examples/example-router.json';
const HEADER = 'CALIBRATION AIR CUT';
const FORMAT = 'woodpatch-gcode-machine';
const FIT_FORMAT = 'woodpatch-gcode-fit';

/**
 * Files that may NAME these things, because they define or check them: the generator
 * and its tests, this guard and its test, the schema package's code and schema, the
 * server's code and tests, the docs. Data files are never on this list.
 */
const MAY_MENTION = [
  /^tools\/calibration\/[^/]+\.mjs$/,
  /^\.github\/ci\/calibration-private(\.test)?\.mjs$/,
  /^packages\/db-schema\/(src\/[^/]+\.ts|schema\/[^/]+\.schema\.json)$/,
  /^packages\/server\/src\/[^/]+\.ts$/,
  /^docs\/[^/]+\.md$/,
];

/** The example record must stay the fictional one. */
function exampleProblems(text) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return ["isn't JSON"];
  }
  const out = [];
  if (r.id !== 'example-1') out.push('its id changed from example-1');
  if (!/fictional/i.test(String(r.name))) out.push('its name no longer says fictional');
  const sources = [];
  const walk = (v) => {
    if (v && typeof v === 'object') {
      if ('source' in v && 'value' in v) sources.push(v.source);
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(r);
  if (sources.some((s) => s !== 'seed')) out.push('it holds a value that is not a seed');
  if (r.calibration?.status !== 'uncalibrated') out.push('it is calibrated');
  return out;
}

/** The offending paths, with why. `read` returns a file's text. */
export function findPrivate(paths, read) {
  const out = [];
  for (const p of paths) {
    const base = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    if (/calibration[-_. ]?runs|(^|[-_.])runs\.(json|ya?ml)$/.test(base)) {
      out.push(`${p}: named like a calibration runs file`);
      continue;
    }
    if (/^cal-\d+-/.test(base)) {
      out.push(`${p}: named like a generated calibration program`);
      continue;
    }
    if (/^fit\.(json|txt)$/.test(base)) {
      out.push(`${p}: named like a calibration fit's output`);
      continue;
    }
    if (p === EXAMPLE) {
      for (const why of exampleProblems(read(p))) out.push(`${p}: the example record: ${why}`);
      continue;
    }
    if (MAY_MENTION.some((re) => re.test(p))) continue;
    let text;
    try {
      text = read(p);
    } catch {
      continue;
    }
    if (text.includes(HEADER)) out.push(`${p}: carries the calibration programs' header`);
    else if (text.includes('measuredSeconds')) out.push(`${p}: holds measured times`);
    else if (text.includes(FIT_FORMAT)) out.push(`${p}: holds a calibration fit`);
    else if (text.includes(FORMAT)) out.push(`${p}: holds a machine record`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hits = findPrivate(paths, (p) => readFileSync(p, 'utf8'));
  for (const h of hits) {
    process.stderr.write(`::error::${h} (a machine's calibration stays private, ADR-0047)\n`);
  }
  process.exit(hits.length ? 1 : 0);
}
