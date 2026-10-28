// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { URL } from 'node:url';
import { findPrivate } from './calibration-private.mjs';

const EXAMPLE_PATH = 'packages/db-schema/examples/example-router.json';
const EXAMPLE = readFileSync(new URL(`../../${EXAMPLE_PATH}`, import.meta.url), 'utf8');
const files = {
  [EXAMPLE_PATH]: EXAMPLE,
  'packages/db-schema/schema/machine-record-v1.schema.json': 'woodpatch-gcode-machine',
  'packages/server/src/map.test.ts': '"woodpatch-gcode-machine"',
  'fixtures/synthetic/ok-ij-arcs.ngc': 'G2 X1 I1\n',
  'tools/calibration/programs.mjs': 'CALIBRATION AIR CUT measuredSeconds',
  'tools/calibration/fit.mjs': 'woodpatch-gcode-fit measuredSeconds',
  'tools/calibration/accept.mjs': 'woodpatch-gcode-acceptance measuredSeconds',
  'docs/CALIBRATION.md': 'calibration-runs.json measuredSeconds',
};
const read = (p) => files[p] ?? '';

it('passes the repository as it should be', () => {
  assert.deepEqual(findPrivate(Object.keys(files), read), []);
});

it('refuses each kind of private calibration file, renamed or not', () => {
  const real = EXAMPLE.replace('"example-1"', '"router-1"');
  const bad = {
    'calibration-runs.json': '{}',
    'fixtures/x/Calibration-Runs.JSON': '{}',
    'fixtures/x/runs.json': '{}',
    'fixtures/x/calibration_runs.yaml': '',
    'fixtures/machine/cal-03-corners.nc': '',
    'fixtures/machine/cal-1-rapids.nc': '',
    'fixtures/machine/CAL-01-RAPIDS.NC': '',
    'fixtures/renamed.nc.txt': '(CALIBRATION AIR CUT: NOTHING IS CUT.)\nG0 X1\n',
    'notes/timings.json': '{"measuredSeconds": 412}',
    'packages/server/src/router.json': '{"format": "woodpatch-gcode-machine"}',
    'config/router.yaml': 'format: woodpatch-gcode-machine\n',
    'tools/calibration/out/router.json': '{"format":"woodpatch-gcode-machine"}',
    'notes/fit.json': '{}',
    'notes/FIT.TXT': '',
    'notes/router-fit-2026.json': '{"format": "woodpatch-gcode-fit"}',
    'notes/accept.json': '{}',
    'notes/Accept.TXT': '',
    'notes/router-acceptance.json': '{"format": "woodpatch-gcode-acceptance"}',
  };
  const hits = findPrivate(Object.keys(bad), (p) => bad[p]);
  assert.equal(hits.length, Object.keys(bad).length, hits.join('\n'));
  // A real record copied over the allowed example.
  for (const [what, text] of [
    ['another id', real],
    ['a manual value', EXAMPLE.replace('"seed"', '"manual"')],
    ['a calibrated record', EXAMPLE.replace('"uncalibrated"', '"calibrated"')],
    ['a real name', EXAMPLE.replace('(fictional)', '(router)')],
  ]) {
    assert.equal(findPrivate([EXAMPLE_PATH], () => text).length, 1, what);
  }
});
