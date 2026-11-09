// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The planes calibration programs (ADR-0053), against the FICTIONAL example record only.
// As for programs.mjs: every generated program passes the safety check, and the checker
// refuses a hand-written program that breaks each rule.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readSetup } from './programs.mjs';
import {
  BLOCK_RATE_GUARD,
  OFFSET_P,
  PREFIX,
  checkPlanesProgram,
  epilogue,
  generatePlanes,
  planeBodies,
  planesRunsTemplate,
  planesText,
  prologue,
} from './programs-planes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const EXAMPLE = readFileSync(join(REPO, 'packages/db-schema/examples/example-router.json'), 'utf8');
const MASSO = EXAMPLE.replace('"dialect": "generic"', '"dialect": "masso-g3-5.13"');
const s = readSetup(MASSO, { envelopeX: 1000, envelopeY: 800 });
const programs = generatePlanes(s);
const bodies = Object.fromEntries(planeBodies(s).map((p) => [p.name, p]));

/** A program of the set with its body replaced, for the refusals. */
const withBody = (plane, body) =>
  planesText(s, { name: `${PREFIX}99-test`, isolates: 'test', plane, body }, 1);
const problems = (plane, body) => checkPlanesProgram(s, { plane }, withBody(plane, body)).problems;

describe('the planes programs', () => {
  it('eleven, all named cal-v-, each passing the safety check read back', () => {
    assert.equal(programs.length, 11);
    for (const p of programs) {
      assert.ok(p.name.startsWith(PREFIX), p.name);
      assert.deepEqual(checkPlanesProgram(s, bodies[p.name], p.gcode).problems, [], p.name);
      assert.ok(p.estimateSeconds >= s.target * 0.9, `${p.name}: ${p.estimateSeconds}`);
    }
  });

  it('set the offset and stop for the check before anything moves under it', () => {
    for (const p of programs) {
      const code = p.gcode.split('\n').filter((l) => l && !l.startsWith('('));
      const pro = prologue(s).filter((l) => !l.startsWith('('));
      assert.deepEqual(code.slice(0, pro.length), pro);
      assert.ok(['G17', 'G18', 'G19'].includes(code[pro.length]), 'the plane, after the M0');
      assert.deepEqual(code.slice(-5), epilogue(s));
      assert.ok(p.gcode.includes(`G10 L20 P${OFFSET_P} Z${s.safeZ}`));
      assert.match(p.gcode, /THIS PROGRAM SETS WORK OFFSET G54\.1 P100/);
      assert.match(p.gcode, /run G17 G54 before any other job/);
    }
  });

  it('arcs run over the top, in every plane, and the line programs trace the same paths', () => {
    for (const [arcs, lines, w] of [
      ['cal-v-01-arcs-xy', 'cal-v-02-lines-xy', 'Y'],
      ['cal-v-04-arcs-zx', 'cal-v-05-lines-zx', 'Z'],
      ['cal-v-08-arcs-yz', 'cal-v-09-lines-yz', 'Z'],
    ]) {
      const steps = (name) =>
        core
          .interpret(core.parse(programs.find((p) => p.name === name).gcode), {
            dialect: s.dialect,
          })
          .steps.filter((x) => x.kind === 'arc' || x.kind === 'linear');
      const semi = steps(arcs).find(
        (x) => x.kind === 'arc' && Math.abs(Math.abs(x.sweep) - Math.PI) < 1e-9,
      );
      const [a1, a2] = { XY: ['X', 'Y'], ZX: ['Z', 'X'], YZ: ['Y', 'Z'] }[semi.plane];
      const t0 = Math.atan2(semi.from[a2] - semi.centre[a2], semi.from[a1] - semi.centre[a1]);
      const mid = { [a1]: Math.cos(t0 + semi.sweep / 2), [a2]: Math.sin(t0 + semi.sweep / 2) };
      assert.ok(mid[w] > 0.999, `${arcs}: the semicircle's middle is at its top`);
      const length = (xs) =>
        xs.reduce(
          (n, x) =>
            n +
            (x.kind === 'arc'
              ? Math.abs(x.sweep) * x.radius
              : Math.hypot(x.to.X - x.from.X, x.to.Y - x.from.Y, x.to.Z - x.from.Z)),
          0,
        );
      const ratio = length(steps(lines)) / length(steps(arcs));
      assert.ok(ratio > 0.999 && ratio <= 1, `${lines}: ${ratio}`);
    }
  });

  // That cal-01 to cal-07 are unchanged by this set was pinned here by hash. The
  // version-to-output table in generator-version.test.mjs now covers both sets.

  it('asks for stopwatch times, from cycle start after the M0, for the whole set', () => {
    const t = planesRunsTemplate(s, programs);
    assert.equal(t.runs.length, 11);
    assert.ok(t.runs.every((r) => r.method === 'stopwatch'));
    assert.match(t.description, /after the M0/);
  });

  it('refuses a machine whose controller reads G10 L20 another way', () => {
    assert.throws(
      () => generatePlanes(readSetup(EXAMPLE, { envelopeX: 1000, envelopeY: 800 })),
      /G10/,
    );
  });
});

describe('the planes safety check refuses', () => {
  const ok = ['G1 X500 Y400 Z-1 F1500', 'G2 X510 Y400 Z-11 I0 K-10'];
  it('(the hand-written baseline passes)', () => {
    assert.deepEqual(problems('ZX', ok), []);
  });
  it('a G18 arc whose chord stays in the slab but whose bulge leaves it', () => {
    // Centre at Z-1 (the slab's top is Z0): the circle reaches Z+9, above the safe height.
    const got = problems('ZX', ['G1 X500 Y400 Z-1 F1500', 'G3 X520 Y400 Z-1 I10 K0']);
    assert.ok(
      got.some((m) => m.includes('circle leaves the slab')),
      got.join('; '),
    );
  });
  it('a point below the slab', () => {
    const got = problems('ZX', [`G1 X500 Y400 Z-${s.plunge + 1} F1500`]);
    assert.ok(
      got.some((m) => m.includes('leaves the slab')),
      got.join('; '),
    );
  });
  it('a rapid under P100', () => {
    const got = problems('ZX', ['G0 X500 Y400 Z-1']);
    assert.ok(
      got.some((m) => m.includes('plain feed move') || m.includes('a rapid under')),
      got.join('; '),
    );
  });
  it('a feed over the slowest moving axis', () => {
    const got = problems('ZX', [`G1 X500 Y400 Z-10 F${s.maxZ + 100}`]);
    assert.ok(
      got.some((m) => m.includes("over the axes' max")),
      got.join('; '),
    );
  });
  it('a point outside the envelope', () => {
    const got = problems('XY', ['G1 X1100 Y400 Z0 F1500']);
    assert.ok(
      got.some((m) => m.includes('outside the envelope')),
      got.join('; '),
    );
  });
  it('segments denser than the block-rate guard', () => {
    const body = ['G1 X500 Y400 Z0 F1500'];
    // 0.01 mm at 1500 mm/min is 2500 blocks/s.
    for (let i = 1; i <= 5; i++) body.push(`G1 X${500 + i * 0.01} Y400 Z0`);
    const got = problems('XY', body);
    assert.ok(
      got.some((m) => m.includes(`guard (${BLOCK_RATE_GUARD})`)),
      got.join('; '),
    );
  });
  it('a prologue out of order, or without the M0 check', () => {
    const text = withBody('ZX', ok);
    for (const broken of [
      text.replace('M0\n', ''),
      text.replace(`G54.1 P${OFFSET_P}\n`, '').replace('M0\n', `M0\nG54.1 P${OFFSET_P}\n`),
      text.replace(`G10 L20 P${OFFSET_P} Z${s.safeZ}`, `G10 L20 P${OFFSET_P} Z0`),
    ]) {
      assert.notDeepEqual(checkPlanesProgram(s, { plane: 'ZX' }, broken).problems, []);
    }
  });
  it('an epilogue that leaves the plane or the offset set', () => {
    const text = withBody('ZX', ok).replace('G17 G54\n', 'G54\n');
    assert.notDeepEqual(checkPlanesProgram(s, { plane: 'ZX' }, text).problems, []);
  });
});
