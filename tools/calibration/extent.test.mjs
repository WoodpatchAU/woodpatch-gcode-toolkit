// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Every generated calibration program stays inside [0, envX] x [0, envY] in G54.
//
// originRange() prints the machine range G54 X0 Y0 may be set in, computed from the
// envelope: travel.min to travel.max - env. That range is only honest if the program
// itself never leaves [0, env] on X and Y. The two safety checkers already refuse a feed
// move outside the envelope, but they skip some moves (the planes checker passes the
// prologue and the park move without an envelope check), and a test that re-runs a
// checker only proves the checker agrees with itself. So this reads each program back
// with core.summarise, a separate piece of code, and checks its whole extent: rapids,
// feed moves and the bulge of every arc.
//
// Against the FICTIONAL example record only.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MIN_ENVELOPE, generatePrograms, readSetup } from './programs.mjs';
import { generatePlanes } from './programs-planes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const EXAMPLE = readFileSync(join(REPO, 'packages/db-schema/examples/example-router.json'), 'utf8');
// The planes set needs Masso's G10 (checkDialect); the axes set runs on either.
const MASSO = EXAMPLE.replace('"dialect": "generic"', '"dialect": "masso-g3-5.13"');

const eps = 1e-6;

/**
 * A program's X/Y extent in work coordinates, read back by the core's summary, and
 * whether every motion step ran with a zero X/Y offset. The interpreter assumes G54 is
 * zero, so a zero offset on every step means the work extent IS the G54 extent: the
 * planes set's P100 coincides with G54 in X and Y, as its prologue intends.
 */
function xyExtent(s, gcode) {
  const result = core.interpret(core.parse(gcode), { dialect: s.dialect });
  const box = core.summarise(result.steps).extent.all;
  const offsetXY = result.steps.some(
    (st) =>
      (st.kind === 'linear' || st.kind === 'arc') &&
      (Math.abs(st.offset.X) > eps || Math.abs(st.offset.Y) > eps),
  );
  return { box, offsetXY };
}

/** The problems with one program's extent; none means originRange() is honest for it. */
function extentProblems(s, gcode) {
  const { box, offsetXY } = xyExtent(s, gcode);
  if (!box) return ['no motion'];
  const out = [];
  if (offsetXY) out.push('a move runs with a non-zero X/Y offset (not G54 in X and Y)');
  for (const [a, env] of [
    ['X', s.envX],
    ['Y', s.envY],
  ]) {
    if (box.min[a] < -eps) out.push(`${a} goes to ${box.min[a]}, below 0`);
    if (box.max[a] > env + eps) out.push(`${a} goes to ${box.max[a]}, past the envelope ${env}`);
  }
  return out;
}

// The record's full travel, from a setup at the minimum envelope.
const t = readSetup(MASSO, { envelopeX: MIN_ENVELOPE, envelopeY: MIN_ENVELOPE }).travel;
const span = (a) => t[a].max - t[a].min;
const ENVELOPES = [
  [MIN_ENVELOPE, MIN_ENVELOPE],
  [1000, 800],
  [437, 911],
  [span('X'), span('Y')],
];

describe('every generated program stays within [0, envX] x [0, envY]', () => {
  for (const [envelopeX, envelopeY] of ENVELOPES) {
    const label = `${envelopeX} x ${envelopeY}`;
    for (const [record, name] of [
      [EXAMPLE, 'generic'],
      [MASSO, 'masso'],
    ]) {
      const s = readSetup(record, { envelopeX, envelopeY });
      for (const events of [false, true]) {
        it(`the axes set${events ? ' with --events' : ''}, ${name}, ${label}`, () => {
          const programs = generatePrograms(s, { events });
          assert.ok(programs.length > 0);
          for (const p of programs) assert.deepEqual(extentProblems(s, p.gcode), [], p.name);
        });
      }
    }
    it(`the planes set, ${label}`, () => {
      const s = readSetup(MASSO, { envelopeX, envelopeY });
      const programs = generatePlanes(s);
      assert.equal(programs.length, 11);
      for (const p of programs) assert.deepEqual(extentProblems(s, p.gcode), [], p.name);
    });
  }
});

describe('the extent check itself', () => {
  const s = readSetup(EXAMPLE, { envelopeX: 300, envelopeY: 300 });
  const wrap = (body) => ['G21 G90 G17 G94 G54', ...body, 'M5', 'M30'].join('\n');

  it('passes a program inside the envelope', () => {
    const g = wrap(['G0 X0 Y0', 'G1 X300 Y300 F1000', 'G0 X10 Y10']);
    assert.deepEqual(extentProblems(s, g), []);
  });

  it('refuses a straight move below zero, and a rapid past the envelope', () => {
    assert.match(extentProblems(s, wrap(['G0 X10 Y10', 'G1 X-1 F1000'])).join(), /X .*below 0/);
    assert.match(extentProblems(s, wrap(['G0 X10 Y301'])).join(), /Y .*past the envelope/);
  });

  it('refuses an arc whose bulge leaves, though both its ends are inside', () => {
    // From (0, 5) round the centre (10, 5) counter-clockwise to (20, 5): it passes
    // through (10, -5), below zero, while both endpoints are at Y5.
    const g = wrap(['G0 X0 Y5', 'G3 X20 Y5 I10 J0 F1000']);
    assert.match(extentProblems(s, g).join(), /Y .*below 0/);
  });

  it('refuses a move under a work offset with an X/Y shift', () => {
    const g = wrap(['G10 L2 P2 X5 Y0', 'G55', 'G0 X10 Y10', 'G54']);
    assert.match(extentProblems(s, g).join(), /non-zero X\/Y offset/);
  });
});
