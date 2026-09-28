// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GENERIC,
  interpret,
  LINUXCNC,
  MASSO_G3,
  parse,
  transformText,
  type Dialect,
} from '../index.js';

// Parcel 4b (ADR-0034): units conversion. Operator decisions, 2026-09-28: inches get
// at least 5 decimals; a program that states no units is read in the user's preference.

const u = (src: string, to: 'mm' | 'inch', assume?: 'mm' | 'inch', dialect: Dialect = GENERIC) =>
  transformText(src, [{ op: 'units', to, ...(assume ? { assume } : {}) }], { dialect });
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe('units', () => {
  it('converts lengths and feeds, and the units word, keeping exact values short', () => {
    const r = u('G21 G90\nG1 X25.4 Y12.7 Z-1 F254\nG2 X50.8 Y0 R12.7', 'inch');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('G20 G90\nG1 X1.0 Y0.5 Z-0.03937 F10\nG2 X2.0 Y0 R0.5');
    expect(r.diagnostics.find((d) => d.code === 'TRANSFORM_UNITS_CONVERTED')?.message).toContain(
      'from millimetres to inches',
    );
  });

  it('writes inches to 5 decimals, so mm → inch → mm lands within a micrometre', () => {
    const inch = u('G21 G90\nG1 X12.345 F100', 'inch');
    expect(inch.text).toBe('G20 G90\nG1 X0.48602 F3.93701');
    const back = u(inch.text, 'mm');
    // Back within a micrometre; a converted value keeps one decimal where its source had a point.
    expect(back.text).toBe('G21 G90\nG1 X12.345 F100.0');
  });

  it('leaves what is not a length alone: dwell, turns, speeds, tools, Masso repeats', () => {
    expect(u('G21\nG4 P2\nS12000 M3 T2\nG2 X10 I5 P2 F100', 'inch').text).toBe(
      'G20\nG4 P2\nS12000 M3 T2\nG2 X0.3937 I0.19685 P2 F3.93701',
    );
    expect(u('G21 G90\nG81 X10 Y10 Z-2 R1 Q0.5 K3 F100', 'inch', undefined, MASSO_G3).text).toBe(
      'G20 G90\nG81 X0.3937 Y0.3937 Z-0.07874 R0.03937 Q0.01969 K3 F3.93701',
    );
    expect(u('G21\nG64 P0.254', 'inch').text).toBe('G20\nG64 P0.01');
    // Inverse-time feed is a rate, not a length.
    expect(u('G21 G93\nG1 X25.4 F2', 'inch').text).toBe('G20 G93\nG1 X1.0 F2');
  });

  it('converts machine positions, offsets and homes: the controller reads them in program units', () => {
    expect(u('G21\nG53 G0 Z-25.4\nG10 L2 P1 X254\nG28 G91 Z0', 'inch').text).toBe(
      'G20\nG53 G0 Z-1.0\nG10 L2 P1 X10\nG28 G91 Z0',
    );
  });

  it('converts each line from its own units, so a mixed program comes out in one', () => {
    // (Its first line has an F, so the units are stated on a line of their own first.)
    expect(u('G21 G1 X25.4 F100\nG20 G1 X2', 'mm').text).toBe(
      'G21\nG21 G1 X25.4 F100\nG21 G1 X50.8',
    );
  });

  it('reads a program that states no units in the preference, says so, and states them', () => {
    const r = u('(part)\nG90 G1 X1 F10', 'mm', 'inch');
    // Its own line, so the F254 after it is read in mm (review of #37: on the same line,
    // an at-feed-step controller read it in its default units, 25.4x off).
    expect(r.text).toBe('(part)\nG21\nG90 G1 X25.4 F254');
    expect(r.diagnostics.find((d) => d.code === 'TRANSFORM_UNITS_ASSUMED')?.line).toBe(2);
    expect(codes(r)).toContain('TRANSFORM_UNITS_CONVERTED');
  });

  it('reports a program already in the target units, stating them cleanly if it must', () => {
    const r = u('G21\nG1 X1 F100', 'mm');
    expect(r.text).toBe('G21\nG1 X1 F100');
    expect(codes(r)).toContain('TRANSFORM_UNITS_ALREADY');
    const s = u('G21 G1 X1 F100', 'mm');
    expect(s.text).toBe('G21\nG21 G1 X1 F100');
    expect(codes(s)).toContain('TRANSFORM_UNITS_STATED');
  });

  it("refuses what it can't convert faithfully", () => {
    expect(codes(u('G21\nG68 X0 Y0 R30', 'inch', undefined, MASSO_G3))).toContain(
      'TRANSFORM_UNSUPPORTED_CODE',
    );
    expect(codes(u('G21\nM98 P100', 'inch', undefined, MASSO_G3))).toContain(
      'TRANSFORM_CONTROL_FLOW',
    );
    expect(codes(u('G21\n#1=5\nG1 X1 F10', 'inch'))).toContain('TRANSFORM_EXPRESSION');
    expect(codes(u('G21\no100 sub\nG1 X1\no100 endsub\nG20\no100 call', 'mm'))).toContain(
      'TRANSFORM_CONTROL_FLOW',
    );
    // An O-word program that stays in one unit converts: each word is the same wherever it runs.
    expect(u('G21\no100 sub\nG1 X25.4 F100\no100 endsub\no100 call', 'inch').ok).toBe(true);
  });
});

describe('the units preference in the interpreter', () => {
  it('reads a program that states no units in the preference, and warns', () => {
    const r = interpret(parse('G90 G1 X1 F10'), { units: 'inch' });
    const move = r.steps.find((s) => s.kind === 'linear');
    expect(move?.kind === 'linear' && move.to.X).toBeCloseTo(25.4, 9);
    expect(r.diagnostics.find((d) => d.code === 'SEMANTIC_UNITS_ASSUMED')?.line).toBe(1);
  });

  it('says nothing when the program states its units, or no preference is given', () => {
    expect(
      interpret(parse('G21 G1 X1 F10'), { units: 'inch' }).diagnostics.map((d) => d.code),
    ).not.toContain('SEMANTIC_UNITS_ASSUMED');
    expect(interpret(parse('G1 X1 F10')).diagnostics.map((d) => d.code)).not.toContain(
      'SEMANTIC_UNITS_ASSUMED',
    );
  });
});

// ── Review of #37: each of these came back ok with changed motion or feed ──

/** Every feed move's feed and end point, as the interpreter reads them. */
const run = (src: string, units?: 'mm' | 'inch', dialect: Dialect = GENERIC) =>
  interpret(parse(src), { dialect, ...(units ? { units } : {}) })
    .steps.filter((s) => s.kind === 'linear' || s.kind === 'arc')
    .map((s) => ({
      to: [s.to.X, s.to.Y, s.to.Z],
      feed:
        s.kind === 'arc' || !s.rapid
          ? s.feed?.mode === 'per-minute'
            ? s.feed.mmPerMinute
            : null
          : null,
    }));
/** The converted program runs the same moves at the same feeds as the original did. */
function same(
  src: string,
  to: 'mm' | 'inch',
  assume: 'mm' | 'inch' = 'mm',
  dialect: Dialect = GENERIC,
) {
  const r = u(src, to, assume, dialect);
  expect(r.ok).toBe(true);
  const a = run(src, assume, dialect);
  const b = run(r.text, undefined, dialect);
  expect(b.length).toBe(a.length);
  a.forEach((m, i) => {
    m.to.forEach((v, k) => expect(Math.abs((b[i]?.to[k] as number) - v)).toBeLessThan(0.002));
    if (m.feed !== null) expect(Math.abs((b[i]?.feed as number) - m.feed)).toBeLessThan(0.2);
  });
  return r;
}

describe('units: the review of #37', () => {
  it('reads F on the first line in the units it was written in (not 25.4x off)', () => {
    expect(same('G21 G1 X10 F100', 'mm', 'inch').text).toBe('G21\nG21 G1 X10 F2540');
    same('(part)\nG90 G1 X1 F10', 'mm', 'inch');
    same('G90 G1 X10 F100', 'inch', 'mm');
  });

  it('states the units before the first MAIN-program line: not in a sub, not block-deletable', () => {
    const sub = u('o100 sub\nG1 X1 F10\no100 endsub\nG1 X5 F10\no100 call', 'mm', 'inch');
    expect(sub.text).toBe('o100 sub\nG1 X25.4 F254\no100 endsub\nG21\nG1 X127 F254\no100 call');
    expect(u('/G90 G1 X1 F10', 'mm', 'inch').text).toBe('G21\n/G90 G1 X25.4 F254');
    expect(u('N10 G90 G1 X1 F10', 'mm', 'inch').text).toBe('G21\nN10 G90 G1 X25.4 F254');
    expect(u('%\n(header)\nO1234\nG90 G1 X1 F10', 'mm', 'inch').text).toBe(
      '%\n(header)\nO1234\nG21\nG90 G1 X25.4 F254',
    );
  });

  it('carries rounding along G91 axes: no drift over 10,000 steps', () => {
    const src = [
      'G21 G90 G0 X0 Y0 Z0',
      'G91 G1 F100',
      ...Array.from({ length: 10_000 }, () => 'G1 X0.01 Z-0.0005'),
    ];
    const r = u(src.join('\n'), 'inch');
    const end = run(r.text).at(-1)?.to;
    expect(Math.abs((end?.[0] as number) - 100)).toBeLessThan(0.001);
    expect(Math.abs((end?.[2] as number) + 5)).toBeLessThan(0.001);
  });

  it('refuses inexact increments that repeat (a stepping cycle, a loop)', () => {
    expect(codes(u('G21 G91 G81 X0.01 Y0 Z-1 R1 L3 F100', 'inch'))).toContain(
      'TRANSFORM_UNITS_DRIFT',
    );
    expect(codes(u('G21\no1 sub\nG91 G1 X0.01 F10\no1 endsub\no1 call', 'inch'))).toContain(
      'TRANSFORM_UNITS_DRIFT',
    );
    // Exact increments are fine anywhere: 25.4 mm is exactly 1 inch.
    expect(u('G21\no1 sub\nG91 G1 X25.4 F10\no1 endsub\no1 call', 'inch').ok).toBe(true);
  });

  it("refuses words that aren't lengths, or aren't known to be", () => {
    for (const [src, code] of [
      ['G21\nG10 L2 P1 R30', 'TRANSFORM_UNSUPPORTED_WORD'], // a rotation in degrees
      ['G21\nG10 L1 P1 I30 J60', 'TRANSFORM_UNSUPPORTED_CODE'], // tool table: lathe angles
      ['G21\nG41.1 D6.35', 'TRANSFORM_UNSUPPORTED_CODE'], // a cutter diameter
      ['G21\nG96 S150', 'TRANSFORM_UNSUPPORTED_CODE'], // surface speed
      ['G21\nG1 X1 U2 F10', 'TRANSFORM_UNSUPPORTED_WORD'],
      ['G21\no1 while [#5422 GT -10]\nG91 G1 Z-1 F10\no1 endwhile', 'TRANSFORM_EXPRESSION'],
    ] as const)
      expect(codes(u(src, 'inch')), src).toContain(code);
  });

  it("converts Q only on lines that run a cycle (or G64): M66's Q is a timeout", () => {
    expect(
      u('G21 G90\nG81 X1 Y1 Z-1 R1 Q0.5 F100\nM66 P0 L3 Q5', 'inch', 'mm', MASSO_G3).text,
    ).toBe('G20 G90\nG81 X0.03937 Y0.03937 Z-0.03937 R0.03937 Q0.01969 F3.93701\nM66 P0 L3 Q5');
  });

  it('warns about assumed units exactly as the interpreter does', () => {
    // G21 on line 2 runs before the first move: nothing assumed.
    expect(codes(u('G90\nG21\nG1 X1 F10', 'inch', 'mm'))).not.toContain('TRANSFORM_UNITS_ASSUMED');
    expect(codes(u('G90\nG1 X1 F10\nG21', 'inch', 'mm'))).toContain('TRANSFORM_UNITS_ASSUMED');
  });
});

describe('the exact units-assumed warning (interpreter)', () => {
  it('follows execution: a G21 in a sub called before the first move counts; one in a skipped branch does not', () => {
    const called = 'o100 sub\nG21\no100 endsub\no100 call\nG1 X1 F10';
    expect(
      interpret(parse(called), { units: 'inch' }).diagnostics.map((d) => d.code),
    ).not.toContain('SEMANTIC_UNITS_ASSUMED');
    const skipped = 'o1 if [0]\nG21\no1 endif\nG1 X1 F10';
    expect(interpret(parse(skipped), { units: 'inch' }).diagnostics.map((d) => d.code)).toContain(
      'SEMANTIC_UNITS_ASSUMED',
    );
  });
});

describe('units: long incremental programs (property)', () => {
  it('any G91 walk converts without drift, both ways', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            x: fc.integer({ min: -2000, max: 2000 }),
            y: fc.integer({ min: -2000, max: 2000 }),
            z: fc.integer({ min: -500, max: 500 }),
          }),
          { minLength: 200, maxLength: 2000 },
        ),
        fc.constantFrom('mm', 'inch'),
        (moves, from) => {
          // 3 decimals in mm, 4 in inches: typical CAM output.
          const d = from === 'mm' ? 1000 : 10000;
          const f = (v: number) => (v / d).toFixed(from === 'mm' ? 3 : 4);
          const src = [
            `${from === 'mm' ? 'G21' : 'G20'} G90 G0 X0 Y0 Z0`,
            'G91 G1 F100',
            ...moves.map((m) => `G1 X${f(m.x)} Y${f(m.y)} Z${f(m.z)}`),
          ].join('\n');
          const to = from === 'mm' ? 'inch' : 'mm';
          const r = u(src, to);
          expect(r.ok).toBe(true);
          const a = run(src).at(-1)?.to as number[];
          const b = run(r.text).at(-1)?.to as number[];
          // Error-diffused: the end is within one output rounding step of exact, not
          // the sum of 2,000 of them.
          for (let k = 0; k < 3; k++)
            expect(Math.abs((b[k] as number) - (a[k] as number))).toBeLessThan(0.001);
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('units: the second review of #37 (modes the text says vs modes the line runs in)', () => {
  const refused = (
    src: string,
    to: 'mm' | 'inch',
    at: number,
    why: string,
    d: Dialect = GENERIC,
  ) => {
    const r = u(src, to, 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    const e = r.diagnostics.find((x) => x.code === 'TRANSFORM_CONTROL_FLOW');
    expect(e?.line, src).toBe(at);
    expect(e?.message, src).toContain(why);
  };

  it('refuses a mode word on a block-deletable line where "/" is a switch', () => {
    for (const d of [GENERIC, LINUXCNC]) {
      refused('/G20\nG1 X1 F10', 'mm', 2, 'block-delete switch', d);
      refused('G20\nG1 X1 F10\n/G21\nG1 X2', 'inch', 4, 'block-delete switch', d);
      refused('G21\nG1 X1 F10\n/G93\nG1 X2 F10', 'inch', 4, 'block-delete switch', d);
      refused('G21 G90\nG1 X1 F10\n/G91\nG1 X2', 'inch', 4, 'block-delete switch', d);
    }
    // Masso runs "/" lines: nothing depends on a switch.
    expect(u('/G20\nG1 X1 F10', 'mm', 'mm', MASSO_G3).text).toBe('G21\n/G21\nG1 X25.4 F254');
    // A block-deletable line that changes no mode is fine.
    expect(u('G21\n/G1 X1 F100\nG1 X2\nM2', 'inch').ok).toBe(true);
  });

  it("refuses a subroutine body that runs in modes other than the text's", () => {
    // Feed mode, both ways round.
    refused(
      'G20\no100 sub\nG93 G1 X1 F2\no100 endsub\nG1 X5 F10\no100 call\nM2',
      'mm',
      5,
      'subroutine',
    );
    refused('G20\no100 sub\nG1 X1 F2\no100 endsub\nG93\no100 call\nM2', 'mm', 3, 'subroutine');
    // Distance: read as absolute, called under G91.
    refused(
      'G20 G90\no100 sub\nG1 X0.01\no100 endsub\nG1 X0 F10\nG91\no100 call\nM2',
      'mm',
      3,
      'incremental',
    );
    // Motion: read under G2, run under G83 (so Q is a peck, not ignored).
    refused(
      'G20 G90\nG2 X1 Y0 I0.5 F10\no100 sub\nX2 Y0 Z-0.5 R0.1 Q0.1\no100 endsub\nG83 X0 Y0 Z-1 R1 Q0.1\no100 call\nG80\nM2',
      'mm',
      4,
      'G83',
    );
    // Called in the modes the text says: converted.
    expect(
      u('G21 G90\no100 sub\nG1 X1 F100\no100 endsub\no100 call\no100 call\nM2', 'inch').ok,
    ).toBe(true);
  });
});
