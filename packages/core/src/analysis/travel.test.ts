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
    // Z only when the caller says no tool length offset is in force.
    expect(check('G0 Z-110\n', G54)).toEqual([]);
    const noTlo = { ...G54, toolLengthOffsetAtStart: 'off' as const };
    expect(codes(check('G0 Z-110\n', noTlo))).toEqual(['TRAVEL_OUTSIDE_LIMITS 1']); // -160
    expect(codes(check('G49\nG0 Z-110\n', G54))).toEqual(['TRAVEL_OUTSIDE_LIMITS 2']);
  });

  it('ignores a key that is not a coordinate system', () => {
    // Its parameters (5401 up) would otherwise be seeded and marked known: 10 isn't a system.
    expect(check('G0 X5000\n', { workOffsets: { 10: { X: 0 } } })).toEqual([]);
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

// The eight programs from the review of #71, each of which produced a false "certain"
// result. TRAVEL: X 0..1000, Y 0..800, Z -150..0.
describe('checkTravel: the review of #71', () => {
  const G54 = (o: Record<string, number>) => ({ workOffsets: { 1: o } });

  it('1. G10 L20 derives the offset from a position: unknown unless that is known', () => {
    expect(check('G92.1\nG10 L20 P1 X0\nG0 X-500\n')).toEqual([]);
    // Masso L2.1 adds to an unknown offset; a parameter write derives from one.
    expect(check('G92.1\nG10 L2.1 P1 X10\nG0 X-500\n', { dialect: MASSO_G3 })).toEqual([]);
    expect(check('G92.1\n#5221=[#5221+10]\nG0 X-500\n')).toEqual([]);
    // From a pinned position with G92 known off, L20 IS known.
    expect(codes(check('G92.1\nG53 G0 X100\nG10 L20 P1 X0\nG0 X-500\n'))).toEqual([
      'TRAVEL_OUTSIDE_LIMITS 4',
    ]);
  });

  it('2. a G92 derived under a tool length offset is unknown on Z', () => {
    const src = 'G53 G0 Z0\nG43 H1\nG92 Z0\nG49\nG0 Z5\n';
    expect(check(src, { ...G54({ X: 0, Y: 0, Z: 0 }), toolLengthOffsetAtStart: 'off' })).toEqual(
      [],
    );
  });

  it('3. supplied offsets mean G92 is off, not that its stored values are known', () => {
    expect(check('G92.3\nG0 X1100\n', G54({ X: 0, Y: 0, Z: 0 }))).toEqual([]);
  });

  it('4. a tool length offset at the start is unknown by default', () => {
    expect(check('G0 Z-110\n', G54({ Z: -50 }))).toEqual([]);
  });

  it('5. a cycle whose initial level equals R in another frame is ambiguous', () => {
    const src = 'F100\nG91 G0 Z-140\nG91 G0 Z140\nG90 G99 G81 X0 Y0 R0 Z-1\nG80\nG91 G0 Z20\n';
    expect(check(src)).toEqual([]);
  });

  it('6. Masso G30 with no park position still moves: the axes are lost', () => {
    expect(check('G53 G0 X500\nG30\nG91 G0 X600\n', { dialect: MASSO_G3 })).toEqual([]);
  });

  it('7. a move under cutter compensation is never stamped from before it', () => {
    const ds = check('G53 G0 X0\nG42 D1\nG91 G1 X-2 Y100 F100\n');
    expect(codes(ds)).toEqual(['TRAVEL_COMPENSATION_SKIPPED 3']);
  });

  it('8. an arc counts its interior only when every plane axis is known alike', () => {
    expect(check('G92.1\nG0 X5\nG17 G2 X105 Y0 R-60 F100\n', G54({ X: 0 }))).toEqual([]);
  });

  it('a rotated system (G10 ... R) leaves X and Y unknown', () => {
    expect(check('G92.1\nG10 L2 P1 X0 Y0 R90\nG0 X-500 Y-100\n', G54({ X: 0, Y: 0 }))).toEqual([]);
  });

  it('a refused line forgets everything known before it', () => {
    // G43.1 isn't supported here, but a controller would run it.
    const src = 'G92.1\nG10 L2 P1 Z0\nG43.1 Z50\nG0 Z5\n';
    expect(
      check(src, { toolLengthOffsetAtStart: 'off' }).filter((d) => d.code.startsWith('TRAVEL_')),
    ).toEqual([]);
  });

  it('the compensation note carries the file', () => {
    const ds = checkTravel(
      interpret(parse('o<c> call\n'), {
        resolveProgram: () => 'o<c> sub\nG41 D1\nG1 X10 F100\nG40\no<c> endsub\n',
      }).steps,
      TRAVEL,
    );
    expect(ds.find((d) => d.code === 'TRAVEL_COMPENSATION_SKIPPED')?.file).toBe('c');
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
 * The definition of "certain": whatever the unknowns are, a warning is true. A random
 * program runs twice. Once as the check sees it: offsets, a leftover G92, stored homes
 * and the park position unknown. Once as one possible truth: random offsets SUPPLIED,
 * a random start inside the travel, sometimes a random G92 left on the controller,
 * random stored G28/G30 positions and a Masso park position. Every warning must hold in
 * that truth: its axis really leaves the travel, up to the first line where the two
 * runs' errors differ (the start can decide whether an arc's line runs at all).
 *
 * What this can't model, because the interpreter doesn't apply them (ADR-0016): tool
 * lengths and cutter radii. Their truth here is 0 and no compensation, one possible
 * truth among many; their rules are pinned by unit tests above.
 */
const PLANE: Readonly<Record<'XY' | 'ZX' | 'YZ', readonly ['X' | 'Y' | 'Z', 'X' | 'Y' | 'Z']>> = {
  XY: ['X', 'Y'],
  ZX: ['Z', 'X'],
  YZ: ['Y', 'Z'],
};

/** An arc's position at every quarter-turn angle it passes, and densely between. */
function arcPoints(s: Extract<Step, { kind: 'arc' }>): Record<'X' | 'Y' | 'Z', number>[] {
  const [a1, a2] = PLANE[s.plane];
  const normal = (['X', 'Y', 'Z'] as const).find((a) => a !== a1 && a !== a2) as 'X' | 'Y' | 'Z';
  const a0 = Math.atan2(s.from[a2] - s.centre[a2], s.from[a1] - s.centre[a1]);
  const ts: number[] = [];
  for (let k = 1; k < 64; k++) ts.push(k / 64);
  const lo = Math.min(a0, a0 + s.sweep);
  const hi = Math.max(a0, a0 + s.sweep);
  for (let k = Math.ceil(lo / (Math.PI / 2)); k * (Math.PI / 2) <= hi; k++) {
    ts.push((k * (Math.PI / 2) - a0) / (s.sweep || 1));
  }
  return ts
    .filter((t) => t > 0 && t < 1)
    .map((t) => {
      const angle = a0 + s.sweep * t;
      const r = s.radius + (s.endRadius - s.radius) * t;
      const p = { X: 0, Y: 0, Z: 0 };
      p[a1] = s.centre[a1] + r * Math.cos(angle);
      p[a2] = s.centre[a2] + r * Math.sin(angle);
      p[normal] = s.from[normal] + (s.to[normal] - s.from[normal]) * t;
      return p;
    });
}

describe('checkTravel: every warning holds, whatever the unknowns', () => {
  const axis = fc.constantFrom('X', 'Y', 'Z');
  const v = fc.integer({ min: -2500, max: 2500 });
  const small = fc.integer({ min: 1, max: 600 });
  const common = [
    fc.tuple(fc.constantFrom('G0', 'G1'), axis, v).map(([g, a, x]) => `${g} ${a}${x}`),
    fc.tuple(v, v, v).map(([x, y, z]) => `G1 X${x} Y${y} Z${z}`),
    fc.tuple(axis, v).map(([a, x]) => `G53 G0 ${a}${x}`),
    fc.constantFrom(
      'G90',
      'G91',
      'G54',
      'G55',
      'G56',
      'G17',
      'G18',
      'G19',
      'G43 H1',
      'G49',
      'T1 M6',
    ),
    fc.constantFrom('G28', 'G28 Z0', 'G30', 'G80', 'G98', 'G99'),
    fc.tuple(fc.integer({ min: 0, max: 3 }), axis, v).map(([p, a, x]) => `G10 L2 P${p} ${a}${x}`),
    // Canned cycles (R above Z), with pecks.
    fc
      .tuple(fc.constantFrom('G81', 'G83', 'G73'), v, v, fc.integer({ min: -300, max: 300 }), small)
      .map(([g, x, y, r, d]) => `${g} X${x} Y${y} R${r} Z${r - d}${g === 'G81' ? '' : ' Q5'}`),
    // Arcs: incremental half circles in any plane, R-form, and a helix.
    fc
      .tuple(fc.constantFrom('G2', 'G3'), small, fc.constantFrom('XY', 'ZX', 'YZ'))
      .map(([g, rad, pl]) => {
        const [a1, a2] = PLANE[pl as 'XY'];
        const plane = pl === 'XY' ? 'G17' : pl === 'ZX' ? 'G18' : 'G19';
        const off = (a: string) => (a === 'X' ? 'I' : a === 'Y' ? 'J' : 'K');
        return `${plane} G91 ${g} ${a1}${2 * rad} ${a2}0 ${off(a1)}${rad} ${off(a2)}0`;
      }),
    fc
      .tuple(fc.constantFrom('G2', 'G3'), v, v)
      .map(([g, x, y]) => `G17 ${g} X${x} Y${y} R${g === 'G2' ? 2000 : -2000}`),
    fc
      .tuple(small, fc.integer({ min: -100, max: 100 }))
      .map(([rad, dz]) => `G17 G91 G2 X${2 * rad} Y0 Z${dz} I${rad} J0`),
  ];
  const linuxcnc = fc.oneof(
    ...common,
    fc.constantFrom('G92.1', 'G92.2', 'G92.3', 'G28.1', 'G30.1'),
    fc.tuple(axis, v).map(([a, x]) => `G92 ${a}${x}`),
    fc.tuple(axis, v).map(([a, x]) => `G52 ${a}${x}`),
    fc.tuple(fc.integer({ min: 0, max: 3 }), axis, v).map(([p, a, x]) => `G10 L20 P${p} ${a}${x}`),
    fc.tuple(fc.integer({ min: 0, max: 2 }), v).map(([k, x]) => `#${5221 + k}=[#${5221 + k}+${x}]`),
    fc.constantFrom('G10 L2 P1 X0 R30'),
  );
  const masso = fc.oneof(
    ...common,
    fc.tuple(fc.integer({ min: 1, max: 3 })).map(([k]) => `G54.1 P${k}`),
    fc
      .tuple(fc.constantFrom('2.1', '20', '20.1'), fc.integer({ min: 0, max: 3 }), axis, v)
      .map(([l, p, a, x]) => `G10 L${l} P${p} ${a}${x}`),
  );
  const inside = fc.record({
    X: fc.integer({ min: 0, max: 1000 }),
    Y: fc.integer({ min: 0, max: 800 }),
    Z: fc.integer({ min: -150, max: 0 }),
  });
  const offset = fc.record({
    X: fc.integer({ min: -2000, max: 2000 }),
    Y: fc.integer({ min: -2000, max: 2000 }),
    Z: fc.integer({ min: -2000, max: 2000 }),
  });
  const scenario = fc.oneof(
    fc.record({
      dialect: fc.constant('linuxcnc' as const),
      lines: fc.array(linuxcnc, { minLength: 1, maxLength: 25 }),
    }),
    fc.record({
      dialect: fc.constant('masso' as const),
      lines: fc.array(masso, { minLength: 1, maxLength: 25 }),
    }),
  );

  it('holds for random programs and unknowns', () => {
    let compared = 0;
    let truncated = 0;
    let warned = 0;
    const runs = Number(process.env['TRAVEL_RUNS'] ?? 2000);
    fc.assert(
      fc.property(
        scenario,
        fc.array(offset, { minLength: 6, maxLength: 6 }),
        fc.tuple(inside, inside, inside, inside),
        fc.option(offset, { nil: undefined }),
        ({ dialect, lines }, w, [start, home, g28, g30], leftover) => {
          const src = `F100\n${lines.join('\n')}\n`;
          const masso = dialect === 'masso';
          const workOffsets = Object.fromEntries(
            (masso ? [1, 2, 3, 101, 102, 103] : [1, 2, 3, 4, 5, 6]).map((cs, i) => [
              cs,
              w[i] ?? { X: 0, Y: 0, Z: 0 },
            ]),
          );
          const seenOptions: InterpretOptions = masso
            ? { dialect: MASSO_G3, machine: { home } }
            : {};
          const seen = interpret(parse(src), seenOptions);
          // LinuxCNC's truth: stored G28/G30 positions, and maybe a G92 left on, set by
          // parameter lines ahead of the program (so its lines shift by that many).
          const prefix = masso
            ? ''
            : [
                ...(['X', 'Y', 'Z'] as const).map((a, i) => `#${5161 + i}=${g28[a]}`),
                ...(['X', 'Y', 'Z'] as const).map((a, i) => `#${5181 + i}=${g30[a]}`),
                ...(leftover
                  ? [
                      ...(['X', 'Y', 'Z'] as const).map((a, i) => `#${5211 + i}=${leftover[a]}`),
                      '#5210=1',
                    ]
                  : []),
              ].join('\n') + '\n';
          const shift = prefix === '' ? 0 : prefix.split('\n').length - 1;
          const real = interpret(parse(prefix + src), {
            ...(masso ? { dialect: MASSO_G3, machine: { home, park: g30 } } : {}),
            workOffsets,
            start,
          });
          // Compare up to the first line where the two runs' errors differ.
          const errs = (ds: readonly Diagnostic[], by: number) =>
            ds
              .filter((d) => d.severity === 'error')
              .map((d) => ({ line: d.line - by, code: d.code }));
          const a = errs(seen.diagnostics, 0);
          const b = errs(real.diagnostics, shift).filter((e) => e.line > 0);
          let cutoff = Infinity;
          for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i]?.line !== b[i]?.line || a[i]?.code !== b[i]?.code) {
              cutoff = Math.min(a[i]?.line ?? Infinity, b[i]?.line ?? Infinity);
              break;
            }
          }
          if (cutoff !== Infinity) truncated++;
          compared++;
          const warnings = checkTravel(seen.steps, TRAVEL).filter(
            (d) => d.severity === 'warning' && d.line < cutoff,
          );
          warned += warnings.length;
          // Every place the machine really is, before the cutoff.
          const places: Record<'X' | 'Y' | 'Z', number>[] = [start];
          for (const s of real.steps) {
            if (s.kind !== 'linear' && s.kind !== 'arc') continue;
            if (s.line - shift >= cutoff) break;
            places.push(s.to);
            if (s.kind === 'arc') places.push(...arcPoints(s));
          }
          for (const d of warnings) {
            const ax = d.message[0] as 'X' | 'Y' | 'Z';
            const t = TRAVEL[ax] as { min: number; max: number };
            const leaves = places.some((p) => p[ax] < t.min - 1e-6 || p[ax] > t.max + 1e-6);
            expect(leaves, `${d.code} at ${d.line}: ${d.message}\n${dialect}\n${src}`).toBe(true);
          }
        },
      ),
      { numRuns: runs },
    );
    // Not vacuous: most cases compare whole, and there are warnings to test.
    expect(compared).toBe(runs);
    expect(truncated).toBeLessThan(runs * 0.5);
    expect(warned).toBeGreaterThan(runs / 4);
    if (process.env['TRAVEL_STATS']) {
      process.stderr.write(
        `travel property: ${runs} runs, ${truncated} truncated, ${warned} warnings\n`,
      );
    }
  }, 300_000);
});
