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
import type { Step } from '../interp/types.js';
import { runDifference } from './units.js';

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

describe('units: the third review of #37 (what the run-time guard cannot see)', () => {
  const refusedAt = (src: string, d: Dialect = GENERIC) => {
    const r = u(src, 'inch', 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    return r.diagnostics.filter((x) => x.severity === 'error');
  };

  it('relied-on motion the text does not know counts as different', () => {
    // Text motion: none yet. Run motion: the caller's G83, so Q is a peck depth.
    const none = refusedAt(
      'o100 sub\nX1 Y1 Q0.2\no100 endsub\nG21 G90 G83 X0 Y0 Z-1 R1 Q0.5 F100\no100 call\nG80\nM2',
    );
    expect(none.map((d) => `${d.code}@${d.line}`)).toContain('TRANSFORM_CONTROL_FLOW@2');
    expect(none[0]?.message).toContain('under G83');
    // Text motion: G80 (not a motion at all).
    const g80 = refusedAt(
      'G21 G90\nG80\no100 sub\nX1 Y1 Q0.2\no100 endsub\nG83 X0 Y0 Z-1 R1 Q0.5 F100\no100 call\nG80\nM2',
    );
    expect(g80[0]?.message).toContain('the text says G80');
  });

  it('refuses subprograms the preview does not run: in-file M98/M99, another file', () => {
    const m98 = refusedAt('G21\nG93\nM98 P100\nM2\nO100\nG1 X1 F2\nM99', LINUXCNC);
    expect(m98.map((d) => d.line)).toEqual([3, 7]);
    expect(m98[0]?.message).toContain('Fanuc style');
    const ext = refusedAt('G21\no<ext> call\nG1 X1 F10\nM2');
    expect(ext[0]?.message).toContain("o<ext> isn't defined in this file");
  });

  it('refuses when the run stops before the end', () => {
    const deep = refusedAt('G21\no100 sub\no100 call\no100 endsub\no100 call\nM2');
    expect(deep.at(-1)?.message).toContain("The preview's run stopped here");
  });

  it('compares only the modes a line reads', () => {
    // A body with only M9 and a dwell, called under G91 and under G93: nothing to convert.
    expect(
      u('G21\no100 sub\nM9\nG4 P1\no100 endsub\nG91\no100 call\nG93\no100 call\nG94\nM2', 'inch')
        .ok,
    ).toBe(true);
  });

  it('names the first 20 lines one cause refuses, and counts the rest', () => {
    const src = `G21 G90\n/G91\n${'G1 X1 F10\n'.repeat(30)}M2`;
    const errs = refusedAt(src);
    expect(errs.filter((d) => d.line > 0)).toHaveLength(20);
    expect(errs.at(-1)?.message).toContain('and 10 more lines');
  });

  it('block-deletable G91 lines carry their rounding in a chain of their own', () => {
    // 1,000 skippable inexact moves between plain ones: with block delete on or off,
    // the program ends within 0.1 µm of exact (measured: 0.02 and 0.04 µm; one shared
    // chain was 0.23 µm off with block delete on).
    const src = `G21 G91\n${'G1 X0.01 F100\n/G1 X0.01\n'.repeat(1000)}M2`;
    const r = u(src, 'inch');
    expect(r.ok).toBe(true);
    for (const blockDelete of [true, false]) {
      const end = interpret(parse(r.text), { blockDelete })
        .steps.filter((s) => s.kind === 'linear')
        .at(-1);
      const want = blockDelete ? 10 : 20;
      expect(Math.abs((end?.to.X ?? 0) - want), `blockDelete ${blockDelete}`).toBeLessThan(0.0001);
    }
  });
});

describe('units: the fourth review of #37', () => {
  const errs = (src: string, to: 'mm' | 'inch', d: Dialect = LINUXCNC) => {
    const r = u(src, to, 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    return r.diagnostics.filter((x) => x.severity === 'error');
  };

  it('G4 takes only P: X/Y/Q on its line are the modal motion’s', () => {
    const e = errs(
      'G21 G90 G17 F100\nG1 X0 Y0\no100 sub\nG4 P0.1 X1 Y1 Q0.2\no100 endsub\nG83 X0 Y0 Z-2 R1 Q0.5\no100 call\nG80\nM2',
      'inch',
    );
    expect(e[0]?.line).toBe(4);
    expect(e[0]?.message).toContain('under G83');
    // A dwell alone still converts: P is its own.
    expect(u('G21\nG4 P2\nG1 X1 F10\nM2', 'inch').ok).toBe(true);
  });

  it('refuses O-words on a controller without them (Masso runs the body inline)', () => {
    const e = errs('o100 sub\nG1 X1 F10\no100 endsub\nG20\no100 call\nM30', 'mm', MASSO_G3);
    expect(e.map((d) => d.line)).toEqual(expect.arrayContaining([1, 3, 5]));
    expect(e[0]?.message).toContain('no O-word subroutines');
  });

  it('refuses a blending tolerance that would round to zero; a slow feed keeps its digits', () => {
    const e = errs('G21\nG64 P0.0001\nG1 X1 F100\nM2', 'inch');
    expect(e.map((d) => `${d.code}@${d.line}`)).toEqual(['TRANSFORM_UNITS_PRECISION@2']);
    // A feed keeps five significant digits (the ninth review), so it never rounds to zero.
    expect(u('G21\nG1 X1 F0.0001\nM2', 'inch').text).toBe('G20\nG1 X0.03937 F0.000003937\nM2');
  });

  it('refuses subprogram files: a Masso file ending M99, a LinuxCNC library', () => {
    expect(errs('G20\nG1 X1 F10\nM99', 'mm', MASSO_G3)[0]?.message).toContain(
      'this is a subprogram file',
    );
    expect(errs('G21\no<lib> sub\nG1 X1 F10\no<lib> endsub\nM2', 'inch')[0]?.message).toContain(
      'o<lib> is defined but never called',
    );
  });
});

describe('units: the fifth review of #37', () => {
  it('refuses a P that is both G64 tolerance and a dwell', () => {
    for (const src of ['G21\nG4 G64 P1\nM2', 'G21 G90\nG64 G82 X0 Y0 Z-2 R1 P1 F100\nM2']) {
      const r = u(src, 'inch', 'mm', LINUXCNC);
      expect(r.ok, src).toBe(false);
      expect(r.diagnostics[0]?.message).toContain('something else on this line reads P');
    }
    // Apart, both are fine: G64 P converts, the dwell stays.
    expect(u('G21\nG64 P0.254\nG4 P1\nM2', 'inch').text).toBe('G20\nG64 P0.01\nG4 P1\nM2');
  });

  it('refuses a Q nothing reads', () => {
    const r = u('G21 G90\nG83 X0 Y0 Z-2 R1 Q0.5 F100\nG80\nG28 X0 Q0.2\nM2', 'inch');
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => `${d.code}@${d.line}`)).toContain(
      'TRANSFORM_UNSUPPORTED_WORD@4',
    );
  });

  it('allows a Masso program-number header, and no other O-word', () => {
    expect(u('O1234\nG21 G90\nG1 X1 F100\nM30', 'inch', 'mm', MASSO_G3).ok).toBe(true);
    expect(u('G21 G90\nO1234\nG1 X1 F100\nM30', 'inch', 'mm', MASSO_G3).ok).toBe(false);
  });
});

describe('units: the sixth review of #37', () => {
  const refused = (
    src: string,
    to: 'mm' | 'inch',
    code: string,
    line: number,
    d: Dialect = LINUXCNC,
  ) => {
    const r = u(src, to, 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    expect(
      r.diagnostics.map((x) => `${x.code}@${x.line}`),
      src,
    ).toContain(`${code}@${line}`);
  };

  it("converts G64's P and Q only where nothing else on the line reads them", () => {
    // An arc's turns (explicit and modal), an output number, G10's P, M66's input and timeout.
    refused(
      'G20 G90 G17\nG0 X0 Y0\nG64 G2 X0.2 Y0 I-0.2 J0 P5 F10\nM2',
      'mm',
      'TRANSFORM_UNSUPPORTED_WORD',
      3,
    );
    refused(
      'G21 G90\nG0 X0 Y0\nG2 X10 Y0 I-5 J0 F100\nG64 X20 Y0 I-5 J0 P2\nM2',
      'inch',
      'TRANSFORM_UNSUPPORTED_WORD',
      4,
    );
    refused('G21\nG64 M64 P1\nM2', 'inch', 'TRANSFORM_UNSUPPORTED_WORD', 2);
    refused('G21\nG64 G10 L20 P2 X0\nM2', 'inch', 'TRANSFORM_UNSUPPORTED_WORD', 2);
    refused('G21\nG64 M66 P1 L3 Q5\nM2', 'inch', 'TRANSFORM_UNSUPPORTED_WORD', 2);
    // Alone, or beside codes that read neither, it converts.
    expect(u('G21\nG64 P0.254 Q0.0254\nM2', 'inch').text).toBe('G20\nG64 P0.01 Q0.001\nM2');
    expect(u('G21 G90\nG1 G64 P0.254 X1 F100\nM2', 'inch').ok).toBe(true);
  });

  it('a Masso header must be alone on its line (comments aside)', () => {
    refused('O1234 G20\nG1 X1 F10\nM30', 'mm', 'TRANSFORM_CONTROL_FLOW', 1, MASSO_G3);
    refused('N10 O1234 G21\nG1 X1 F10\nM30', 'inch', 'TRANSFORM_CONTROL_FLOW', 1, MASSO_G3);
    expect(u('O1234 (part)\nG21 G90\nG1 X1 F100\nM30', 'inch', 'mm', MASSO_G3).ok).toBe(true);
  });

  it('refuses a line that runs differently once converted: a rounded peck adds a peck', () => {
    refused(
      'G20 G90\nG0 X0 Y0 Z0.1\nG83 X0 Y0 Z-0.123 R0 Q0.0123 F10\nG80\nM2',
      'mm',
      'TRANSFORM_UNITS_CHANGED',
      3,
    );
  });

  it('refuses a converted value no controller reads (after the fix to the other transforms)', () => {
    refused('G20\nG1 X99999999999999999999 F10\nM2', 'mm', 'TRANSFORM_OUT_OF_RANGE', 2);
  });
});

describe('units: the seventh review of #37 (the final check, both ways)', () => {
  const refusedWith = (src: string, to: 'mm' | 'inch', text: string, d: Dialect = LINUXCNC) => {
    const r = u(src, to, 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    expect(r.diagnostics.map((x) => x.message).join('\n'), src).toContain(text);
  };

  it('a sliver of arc whose rounded end lands on its start is not a full circle', () => {
    refusedWith('G20 G90\nG1 X1 Y0 F10\nG2 X1 Y-0.00001 I-1 J0\nM2', 'mm', 'then 360.000°');
    refusedWith('G21 G90\nG1 X10 Y0 F100\nG3 X10 Y0.0001 I-10\nM2', 'inch', 'then 360.000°');
  });

  it('an R-format half circle whose centre moves when rounded is refused, with a hint', () => {
    refusedWith('G21 G91\nG1 X1 F100\nG2 X-3 Y4 R2.5\nM2', 'inch', 'give the centre with I/J');
    // A big one: the arc bulges 0.8 mm elsewhere while its sweep changes under 1 mrad.
    refusedWith(
      'G21 G90\nG1 X0 Y0 F100\nG2 X5000 Y0 R2500\nM2',
      'inch',
      'its arc bulges somewhere else',
    );
  });

  it('a line that runs only once converted (an off-radius arc) is refused', () => {
    refusedWith('G21 G90\nG1 X0 Y0 F100\nG2 X10 Y0 I5.025 J0\nM2', 'inch', '0 steps, then 1');
  });

  it('a letter an M code also reads is refused, on cycle and arc lines too', () => {
    refusedWith(
      'G21 G90\nG83 X0 Y0 Z-2 R1 Q0.5 F100\nX1 M66 P1 L3 Q5\nG80\nM30',
      'inch',
      'M66 on this line may read Q',
      MASSO_G3,
    );
    refusedWith(
      'G21 G90\nG81 X0 Y0 Z-1 R1 F100\nX1 R2 M19\nG80\nM2',
      'inch',
      'M19 on this line may read R',
    );
    refusedWith(
      'G21 G90\nG83 X0 Y0 Z-2 R1 Q0.5 F100\nX1 Q0.4 M101\nG80\nM2',
      'inch',
      'M101 on this line may read Q',
    );
    // An M66 line that doesn't move reads its own words only: it converts.
    expect(u('G21 G90\nM66 P0 L3 Q5\nG1 X1 F100\nM2', 'inch').text).toBe(
      'G20 G90\nM66 P0 L3 Q5\nG1 X0.03937 F3.93701\nM2',
    );
  });

  it('a feed per revolution keeps two more places', () => {
    expect(u('G21 G95\nG1 X1 F0.1\nM2', 'inch').text).toBe('G20 G95\nG1 X0.03937 F0.003937\nM2');
  });
});

describe('units: the eighth review of #37', () => {
  const refusedWith = (src: string, to: 'mm' | 'inch', text: string, d: Dialect = LINUXCNC) => {
    const r = u(src, to, 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    expect(r.diagnostics.map((x) => x.message).join('\n'), src).toContain(text);
  };

  it("refuses a mode change inside a Masso M66 skip range (the met path isn't previewed)", () => {
    refusedWith(
      'G21 G90\nM66 P1 L3 Q5000 S1\nG20\nG1 X1 F10\nM30',
      'mm',
      'M66 at line 2 skips this line',
      MASSO_G3,
    );
    refusedWith(
      'G21 G90 G94\nG1 X0 F100\nM66 P1 L3 Q5000 S1\nG93\nG1 X10 F2\nM30',
      'inch',
      'M66 at line 3 skips this line',
      MASSO_G3,
    );
    // A range of moves only: converts (their rounding has its own carry chain).
    expect(
      u('G21 G90\nM66 P1 L3 Q5000 S2\nG1 X1 F100\nG1 X2\nM30', 'inch', 'mm', MASSO_G3).ok,
    ).toBe(true);
    // An M66 with no skip count is just a wait.
    expect(u('G21 G90\nM66 P1 L3 Q5000\nG20\nG1 X1 F10\nM30', 'mm', 'mm', MASSO_G3).ok).toBe(true);
  });

  it('G91 canned cycles convert without drift: their Z is not a net move', () => {
    let src = 'G21 G90 G98\nG0 X0 Y0 Z5\nG91 G1 F100\n';
    for (let i = 0; i < 120; i++) src += 'G81 X1 Z-0.3 R-0.1\nG80\nG1 Z0.3\n';
    const r = u(src + 'M2', 'inch');
    expect(r.ok).toBe(true);
    const end = interpret(parse(r.text))
      .steps.filter((s) => s.kind === 'linear')
      .at(-1);
    expect(Math.abs((end?.to.Z ?? 0) - (5 + 120 * 0.3))).toBeLessThan(0.001);
    // Under G99 the cycle ends at R: that's a net move, and it carries.
    let g99 = 'G21 G90 G99\nG0 X0 Y0 Z5\nG91 G1 F100\n';
    for (let i = 0; i < 120; i++) g99 += 'G81 X1 Z-0.3 R-0.1\nG80\nG1 Z0.1\n';
    expect(u(g99 + 'M2', 'inch').ok).toBe(true);
  });

  it('small arcs convert: where an arc goes is compared, not its sweep to 1 mrad', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
        (r, a) => {
          const x0 = 5;
          const y0 = 5;
          const cx = x0 - r * Math.cos(a);
          const cy = y0 - r * Math.sin(a);
          const b = a - Math.PI / 2;
          const f = (v: number) => v.toFixed(4);
          const src = `G21 G90\nG1 X${x0} Y${y0} F100\nG2 X${f(cx + r * Math.cos(b))} Y${f(cy + r * Math.sin(b))} I${f(cx - x0)} J${f(cy - y0)}\nM2`;
          const out = u(src, 'inch');
          // The interpreter may reject the input arc (radius mismatch from the 4 places);
          // otherwise the conversion must not be refused for the arc's shape.
          expect(
            out.diagnostics.some((d) => d.code === 'TRANSFORM_UNITS_CHANGED'),
            src,
          ).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the final check compares feeds, spindle speeds and the arc itself (direct)', () => {
    const at = (X: number, Y = 0) => ({ X, Y, Z: 0, A: 0, B: 0, C: 0 });
    const line = (f: number, mode: 'per-minute' | 'per-revolution' = 'per-minute') =>
      ({
        kind: 'linear',
        line: 1,
        rapid: false,
        from: at(0),
        to: at(1),
        feed: mode === 'per-minute' ? { mode, mmPerMinute: f } : { mode, mmPerRevolution: f },
        offset: at(0),
      }) as Step;
    expect(runDifference([line(100)], [line(100.005)])).toBeNull();
    expect(runDifference([line(100)], [line(100.5)])).toContain('a feed of 100');
    expect(
      runDifference([line(0.1, 'per-revolution')], [line(0.1001, 'per-revolution')]),
    ).toContain('feed');
    expect(runDifference([line(100)], [line(100, 'per-revolution')])).toContain('per-revolution');
    const spin = (rpm: number) => ({ kind: 'spindle', line: 1, state: 'cw', rpm }) as Step;
    expect(runDifference([spin(18000)], [spin(17999)])).toBe('its spindle speed changes');
    const arc = (cy: number) =>
      ({
        kind: 'arc',
        line: 1,
        from: at(0),
        to: at(2),
        plane: 'XY',
        clockwise: true,
        centre: at(1, cy),
        radius: Math.hypot(1, cy),
        endRadius: Math.hypot(1, cy),
        sweep: -2 * Math.atan2(1, -cy),
        turns: 1,
        feed: { mode: 'per-minute', mmPerMinute: 100 },
        offset: at(0),
      }) as Step;
    expect(runDifference([arc(0)], [arc(0)])).toBeNull();
    expect(runDifference([arc(0)], [arc(0.01)])).toBe('its arc bulges somewhere else');
  });
});

describe('units: the ninth review of #37', () => {
  const refusedWith = (src: string, to: 'mm' | 'inch', text: string, d: Dialect = LINUXCNC) => {
    const r = u(src, to, 'mm', d);
    expect(r.ok, src).toBe(false);
    expect(r.text).toBe(src);
    expect(r.diagnostics.map((x) => x.message).join('\n'), src).toContain(text);
  };
  const cycles = (head: string, body: string, n: number, tail: string) =>
    head + body.repeat(n) + tail;

  it('a retract-mode change (G98/G99) in a "/" line or an M66 range is refused', () => {
    refusedWith(
      cycles(
        'G20 G90 G98 G17 G94\nG0 X0 Y0 Z1\nG1 F10\n/G99\nG91\n',
        'G81 X0.05 Z-0.012 R-0.004\nG80\nG1 Z0.004\n',
        10,
        'G90\nM2',
      ),
      'mm',
      'G98 retract',
    );
    refusedWith(
      cycles(
        'G21 G90\nG0 X0 Y0 Z5\nG91 G1 F100\nM66 P1 L3 Q5000 S1\nG99\n',
        'G81 X1 Z-0.3 R-0.1\nG80\nG1 Z0.1\n',
        5,
        'M30',
      ),
      'inch',
      'M66 at line 4 skips this line',
      MASSO_G3,
    );
  });

  it('several M66 skip ranges: an inexact increment inside one is refused', () => {
    refusedWith(
      cycles(
        'G21 G90\nG0 X0 Y0\nG91 G1 F100\n',
        'M66 P1 L3 Q5000 S1\nG1 X0.0007\nG1 Y0.0007\n',
        20,
        'M30',
      ),
      'inch',
      'several M66 skip ranges',
      MASSO_G3,
    );
    // One range, or exact increments: fine.
    expect(
      u('G21 G90\nG91 G1 F100\nM66 P1 L3 Q5000 S1\nG1 X0.0007\nM30', 'inch', 'mm', MASSO_G3).ok,
    ).toBe(true);
  });

  it('a bare N line does not count toward an M66 range (generous)', () => {
    refusedWith(
      'G21 G90\nM66 P1 L3 Q5000 S1\nN20\nG20\nG1 X1 F10\nM30',
      'mm',
      'M66 at line 2 skips this line',
      MASSO_G3,
    );
  });

  it('G98 with R above the start: R is a net move, and converts', () => {
    const src = cycles(
      'G21 G90 G98\nG0 X0 Y0 Z5\nG91 G1 F100\n',
      'G81 X1 Z-1 R0.513\nG80\nG1 Z-0.513\n',
      120,
      'M2',
    );
    expect(u(src, 'inch').ok).toBe(true);
  });
});

describe('units: the tenth review of #37', () => {
  it('a motion code inside an M66 range, with G91 cycles, is refused (series would merge)', () => {
    let src = 'G20 G90 G17 G94\nG0 X0 Y0 Z1.5\nG1 F4\nG91 G98\n';
    for (let i = 0; i < 20; i++)
      src +=
        'G81 X0 Z-0.0400 R0.0003\nM66 P1 L3 Q5000 S1\nG80\nG81 X0 Z-0.0400 R0.0100\nG80\nG1 Z-0.0103\n';
    const r = u(src + 'M30', 'mm', 'mm', MASSO_G3);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain('would then not end a G91 cycle series');
    // Without G91 cycles in the file, a motion code in a range is just a move.
    expect(u('G21 G90\nM66 P1 L3 Q5000 S1\nG80\nG1 X1 F100\nM30', 'inch', 'mm', MASSO_G3).ok).toBe(
      true,
    );
  });

  it('only a range that moves counts toward "several ranges"', () => {
    const src =
      'G21 G90\nG0 X0 Y0\nG91 G1 F100\nM66 P1 L3 Q5000 S1\nG1 X0.0007\nM66 P1 L3 Q5000 S1\nG4 P0.5\nM30';
    expect(u(src, 'inch', 'mm', MASSO_G3).ok).toBe(true);
  });
});
