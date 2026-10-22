// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkTravel,
  interpret,
  MASSO_G3,
  parse,
  type Diagnostic,
  type InterpretOptions,
  type Step,
  type TravelLimits,
} from '../index.js';

// A fictional machine: 1000 x 800 mm, 150 mm of Z below its top.
const TRAVEL: TravelLimits = {
  X: { min: 0, max: 1000 },
  Y: { min: 0, max: 800 },
  Z: { min: -150, max: 0 },
};

const run = (src: string, options: InterpretOptions = {}): readonly Step[] =>
  interpret(parse(src), options).steps;
const check = (src: string, options: InterpretOptions = {}, travel = TRAVEL): Diagnostic[] =>
  checkTravel(run(src, options), travel);
const codes = (ds: Diagnostic[]): string[] => ds.map((d) => `${d.code} ${d.line}`);

describe('checkTravel: pinned positions', () => {
  it('checks a G53 move against the limits directly', () => {
    expect(codes(check('G53 G0 X1200\n'))).toEqual(['TRAVEL_OUTSIDE_LIMITS 1']);
    expect(check('G53 G0 X1000 Z0\nG53 G0 X0 Z-150\n')).toEqual([]);
  });

  it('reports each axis once, at its first move outside, with a count', () => {
    const ds = check('G53 G0 Z5\nG53 G0 Z6\nG53 G0 X-1\n');
    expect(codes(ds)).toEqual(['TRAVEL_OUTSIDE_LIMITS 1', 'TRAVEL_OUTSIDE_LIMITS 3']);
    expect(ds[0]?.message).toContain('and 2 more points'); // every move ending outside
  });

  it('keeps an axis pinned through incremental moves', () => {
    expect(codes(check('G53 G0 X900\nG91 G0 X200\n'))).toEqual(['TRAVEL_OUTSIDE_LIMITS 2']);
  });

  it('unpins an axis on an absolute work move', () => {
    // X900 in machine terms, then X5000 in work terms: the second is an unknown place.
    expect(check('G53 G0 X900\nG90 G0 X5000\n')).toEqual([]);
  });

  it('pins Masso G28 axes only where the caller supplied the home', () => {
    const src = 'G28\n';
    expect(check(src, { dialect: MASSO_G3, machine: { home: { X: 0, Y: 0, Z: 0 } } })).toEqual([]);
    const far = { dialect: MASSO_G3, machine: { home: { X: 2000 } } };
    expect(codes(check('G0 X1\nG28 X0\n', far))).toEqual(['TRAVEL_OUTSIDE_LIMITS 2']);
    // Not supplied: the default (machine origin) is a guess, so nothing is claimed.
    expect(check('G0 X1\nG28 X0\n', { dialect: MASSO_G3 }, { X: { min: 5, max: 10 } })).toEqual([]);
  });

  it('never pins a LinuxCNC G28/G30 destination (stored on the machine)', () => {
    expect(check('G28.1\nG0 X50\nG28\n', {}, { X: { min: 5, max: 10 } })).toEqual([]);
  });
});

describe('checkTravel: extent', () => {
  it('warns when work moves span more than the travel', () => {
    expect(codes(check('G0 X0\nG1 X1000.5 F100\n'))).toEqual(['TRAVEL_EXTENT 2']);
    expect(check('G0 X-200\nG1 X800 F100\n')).toEqual([]);
  });

  it('counts an arc by its true extremes, not just its ends', () => {
    // Endpoints 600 apart in Y, but the semicircle bulges to 600 above the centre.
    const src = 'G0 X0 Y0\nG17 G2 X0 Y600 I0 J300 F100\nG2 X0 Y0 I0 J-300\n';
    expect(check(src)).toEqual([]);
    // X spans 600 (from -300 to 300) only along the arcs: every endpoint is at X0.
    const tight = { X: { min: 0, max: 500 }, Y: { min: 0, max: 800 } };
    expect(codes(check(src, {}, tight))).toEqual(['TRAVEL_EXTENT 3']);
  });

  it('compares in millimetres after G20', () => {
    expect(codes(check('G20\nG0 X0\nG1 X40 F10\n'))).toEqual(['TRAVEL_EXTENT 3']); // 1016 mm
    expect(check('G20\nG0 X0\nG1 X39 F10\n')).toEqual([]); // 990.6 mm
  });

  it('counts incremental moves from the start among themselves only', () => {
    // The start is wherever the machine is: its moves aren't comparable to work moves.
    expect(check('G91 G0 X-900\nG90 G0 X200\n')).toEqual([]);
    expect(codes(check('G91 G0 X600\nG0 X600\n'))).toEqual(['TRAVEL_EXTENT 2']);
  });

  it.each([
    ['a coordinate system change', 'G0 X0\nG55\nG0 X1500\n'],
    ['G92', 'G0 X0\nG92 X0\nG0 X1500\n'],
    ['G52', 'G0 X0\nG52 X10\nG0 X1500\n'],
    ['G92.1', 'G92 X5\nG0 X0\nG92.1\nG0 X1500\n'],
    ['G10 L2 to the active system', 'G0 X0\nG10 L2 P1 X10\nG0 X1500\n'],
    ['G10 L2 P0', 'G0 X0\nG10 L2 P0 X10\nG0 X1500\n'],
  ])('starts a new frame on %s', (_, src) => {
    expect(check(src)).toEqual([]);
  });

  it('starts a new frame on a G92 while G92 is already on', () => {
    // The first G92 makes the offset the start position, say machine 900: X-800 is then
    // machine 100. The second, at machine 500, makes it 500: X0 is machine 500. That
    // fits, but the two points' computed positions (-800 and 500) span 1300.
    expect(check('G92 X0\nG0 X-800\nG53 G0 X500\nG92 X0\nG0 X0\n')).toEqual([]);
  });

  it('a G10 to another system leaves the active frame alone', () => {
    expect(codes(check('G0 X0\nG10 L2 P2 X10\nG0 X1500\n'))).toEqual(['TRAVEL_EXTENT 3']);
  });

  it('an incremental move after an offset change stays in its own frame', () => {
    expect(codes(check('G0 X0\nG55\nG91 G0 X1500\n'))).toEqual(['TRAVEL_EXTENT 3']);
  });

  it.each([
    ['G43', 'G0 Z0\nG43 H1\nG0 Z-200\n'],
    ['G49', 'G43 H1\nG0 Z0\nG49\nG0 Z-200\n'],
    ['a tool change', 'G0 Z0\nT2 M6\nG0 Z-200\n'],
  ])('starts a new Z frame on %s, and only Z', (_, src) => {
    expect(check(src)).toEqual([]);
    expect(codes(check(src.replace(/Z-200/, 'Z-200 X0').replace('G0 Z0', 'G0 Z0 X-1500')))).toEqual(
      [`TRAVEL_EXTENT ${src.split('\n').length - 1}`],
    );
  });

  it('warns once per axis and frame', () => {
    const ds = check('G0 X0\nG0 X1500\nG0 X2000\nG55\nG0 X0\nG0 X1500\n');
    expect(codes(ds)).toEqual(['TRAVEL_EXTENT 2', 'TRAVEL_EXTENT 6']);
  });
});

describe('checkTravel: cutter compensation', () => {
  it("skips the plane's axes under G41/G42, says so, and still checks Z", () => {
    const src = 'G0 X0 Z0\nG41 D1\nG1 X1500 F100\nG1 Z-200\nG40\n';
    const ds = check(src);
    expect(codes(ds)).toEqual(['TRAVEL_COMPENSATION_SKIPPED 3', 'TRAVEL_EXTENT 4']);
  });
});

describe('checkTravel: supplied work offsets', () => {
  const G54 = { workOffsets: { 1: { X: 100, Y: 100, Z: -50 } } };

  it('pins absolute moves under a supplied system', () => {
    expect(codes(check('G0 X950\n', G54))).toEqual(['TRAVEL_OUTSIDE_LIMITS 1']); // 1050
    expect(check('G0 X850 Z-90\n', G54)).toEqual([]);
    expect(codes(check('G0 Z-110\n', G54))).toEqual(['TRAVEL_OUTSIDE_LIMITS 1']); // -160
  });

  it('falls back to the unknown rules in a system not supplied', () => {
    // G55 wasn't supplied: X5000 there is an unknown place, not 5000 + 0.
    expect(check('G55\nG0 X5000\n', G54)).toEqual([]);
  });

  it('never mixes a supplied axis with one that is not', () => {
    // Only X was supplied: Y stays unknown.
    expect(check('G0 Y5000\n', { workOffsets: { 1: { X: 0 } } })).toEqual([]);
  });

  it('a tool length offset makes Z unknown again', () => {
    expect(check('G43 H1\nG0 Z-110\n', G54)).toEqual([]);
  });
});

describe('checkTravel: canned cycles', () => {
  it('keeps the initial level as known as it was, and the hole in work terms', () => {
    // Z starts pinned at machine 0; the holes go 50 below a work R plane.
    const src = 'G53 G0 Z0\nG0 X10 Y10\nG98 G81 X20 Y20 Z-50 R-1 F100\n';
    expect(check(src)).toEqual([]);
    // A pinned initial level above the machine's top is caught at the cycle's line.
    const high = 'G53 G0 Z10\nG0 X10 Y10\nG98 G81 X20 Y20 Z-50 R-1 F100\n';
    expect(codes(check(high))).toEqual(['TRAVEL_OUTSIDE_LIMITS 1']);
  });

  it('a cycle deeper than the Z travel is certain', () => {
    expect(codes(check('G0 X10 Y10 Z5\nG81 X20 Y20 Z-200 R2 F100\n'))).toEqual(['TRAVEL_EXTENT 2']);
  });
});

describe('checkTravel: messages', () => {
  it('carry the axis, numbers and line, never program text', () => {
    const ds = check('(JOB: Customer Secret Kitchen)\nG53 G0 X1200 (Secret)\nG0 X0\nG0 X2000\n');
    expect(ds.length).toBe(2);
    for (const d of ds) {
      expect(d.message).not.toMatch(/Secret|Customer|JOB/);
      expect(d.message).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('is silent with no limits, and ignores an axis given none', () => {
    expect(check('G53 G0 X5000\n', {}, {})).toEqual([]);
    expect(check('G53 G0 X5000\n', {}, { Y: { min: 0, max: 1 } })).toEqual([]);
  });
});

/**
 * The definition of "certain": whatever the operator's offsets are, a warning is true.
 * A random program is run twice. Once with the offsets unknown, which is what the
 * check sees. Once with random offsets SUPPLIED, which is the machine's truth for that
 * choice. Every warning must hold in the truth: its axis really leaves the travel.
 */
/** An XY arc's X or Y at every quarter-turn angle it passes (its extremes). */
function arcExtremes(s: Extract<Step, { kind: 'arc' }>, a: 'X' | 'Y'): number[] {
  const a0 = Math.atan2(s.from.Y - s.centre.Y, s.from.X - s.centre.X);
  const out: number[] = [];
  const lo = Math.min(a0, a0 + s.sweep);
  const hi = Math.max(a0, a0 + s.sweep);
  for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) {
    const t = k * (Math.PI / 2);
    const r = s.radius + ((s.endRadius - s.radius) * (t - a0)) / (s.sweep || 1);
    out.push(a === 'X' ? s.centre.X + r * Math.cos(t) : s.centre.Y + r * Math.sin(t));
  }
  return out;
}

describe('checkTravel: every warning holds, whatever the offsets', () => {
  const axis = fc.constantFrom('X', 'Y', 'Z');
  const value = fc.integer({ min: -2500, max: 2500 });
  const line = fc.oneof(
    fc.tuple(fc.constantFrom('G0', 'G1'), axis, value).map(([g, a, v]) => `${g} ${a}${v}`),
    fc.tuple(axis, value).map(([a, v]) => `G53 G0 ${a}${v}`),
    fc.constantFrom('G90', 'G91', 'G54', 'G55', 'G56', 'G92.1', 'G92.2', 'G92.3'),
    fc.tuple(axis, value).map(([a, v]) => `G92 ${a}${v}`),
    fc.tuple(axis, value).map(([a, v]) => `G52 ${a}${v}`),
    fc
      .tuple(fc.integer({ min: 0, max: 3 }), axis, value)
      .map(([p, a, v]) => `G10 L2 P${p} ${a}${v}`),
    // Canned cycles (R above Z), and the G98/G99 return level.
    fc.constantFrom('G98', 'G99', 'G80'),
    fc
      .tuple(value, value, fc.integer({ min: -300, max: 300 }), fc.integer({ min: 1, max: 400 }))
      .map(([x, y, r, depth]) => `G81 X${x} Y${y} R${r} Z${r - depth}`),
    // Arcs in the XY plane: a half circle to a point 2R away along X.
    fc
      .tuple(fc.constantFrom('G2', 'G3'), fc.integer({ min: 1, max: 900 }))
      .map(([g, rad]) => `G17 ${g} X${2 * rad} I${rad} J0`),
  );
  const offset = fc.record({
    X: fc.integer({ min: -2000, max: 2000 }),
    Y: fc.integer({ min: -2000, max: 2000 }),
    Z: fc.integer({ min: -2000, max: 2000 }),
  });

  it('holds for random programs and offsets', () => {
    // Not vacuous: count what was actually checked.
    let checked = 0;
    let warned = 0;
    fc.assert(
      fc.property(
        fc.array(line, { minLength: 1, maxLength: 25 }),
        fc.tuple(offset, offset, offset, offset),
        (lines, [w1, w2, w3, start]) => {
          const src = `F100\n${lines.join('\n')}\n`;
          const seen = interpret(parse(src));
          const warnings = checkTravel(seen.steps, TRAVEL).filter((d) => d.severity === 'warning');
          // The truth: these offsets, and the machine starting wherever it happens to be.
          const real = interpret(parse(src), { workOffsets: { 1: w1, 2: w2, 3: w3 }, start });
          const truth = real.steps;
          // Only the same program: where the start decides whether a line runs at all
          // (an arc whose radii then disagree), the two runs aren't comparable.
          const errors = (r: typeof seen): string =>
            r.diagnostics
              .filter((d) => d.severity === 'error')
              .map((d) => `${d.code}@${d.line}`)
              .join();
          fc.pre(errors(seen) === errors(real));
          checked++;
          warned += warnings.length;
          for (const w of warnings) {
            const a = w.message[0] as 'X' | 'Y' | 'Z';
            const t = TRAVEL[a] as { min: number; max: number };
            // Every place the machine is: where it starts, where each move ends, and an
            // arc's extremes (worked out here independently: every quarter turn passed).
            const values: number[] = [];
            truth.forEach((s, i) => {
              if (s.kind !== 'linear' && s.kind !== 'arc') return;
              if (values.length === 0) values.push(s.from[a]);
              values.push(s.to[a]);
              if (s.kind === 'arc' && a !== 'Z') values.push(...arcExtremes(s, a));
              void i;
            });
            const leaves = values.some((v) => v < t.min - 1e-6 || v > t.max + 1e-6);
            expect(leaves, `${w.code} at ${w.line}: ${w.message}\n${src}`).toBe(true);
          }
        },
      ),
      { numRuns: Number(process.env['TRAVEL_RUNS'] ?? 2000) },
    );
    expect(checked).toBeGreaterThan(Number(process.env['TRAVEL_RUNS'] ?? 2000) * 0.8);
    expect(warned).toBeGreaterThan(checked / 10);
  }, 120_000);
});
