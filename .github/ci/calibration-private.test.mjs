// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { findPrivate } from './calibration-private.mjs';

const files = {
  'packages/db-schema/examples/example-router.json': '{"format":"woodpatch-gcode-machine"}',
  'packages/db-schema/schema/machine-record-v1.schema.json': 'woodpatch-gcode-machine',
  'fixtures/synthetic/ok-ij-arcs.ngc': 'G2 X1 I1\n',
  'tools/calibration/programs.mjs': 'CALIBRATION AIR CUT',
  'docs/CALIBRATION.md': 'calibration-runs.json',
};
const read = (p) => files[p] ?? '';

it('passes the repository as it should be', () => {
  assert.deepEqual(findPrivate(Object.keys(files), read), []);
});

it('refuses each kind of private calibration file', () => {
  const bad = {
    'calibration-runs.json': '{}',
    'fixtures/x/calibration-runs.json': '{}',
    'fixtures/machine/cal-03-corners.nc': '',
    'tools/calibration/out/anything.nc': '',
    'tools/calibration/router.json': '{}',
    'docs/router-record.json': '{}',
    'fixtures/renamed.ngc': '(CALIBRATION AIR CUT: NOTHING IS CUT.)\nG0 X1\n',
    'packages/server/src/router.json': '{"format": "woodpatch-gcode-machine"}',
  };
  const hits = findPrivate(Object.keys(bad), (p) => bad[p]);
  assert.equal(hits.length, Object.keys(bad).length, hits.join('\n'));
});
