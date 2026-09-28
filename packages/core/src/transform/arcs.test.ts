// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { arcPoint, startAngle } from '../path/path.js';
import {
  GENERIC,
  interpret,
  MASSO_G3,
  parse,
  transformText,
  type Dialect,
  type Step,
  type TransformOp,
} from '../index.js';

// Arc to line conversion (parcel 4d, ADR-0037).

type Arc = Extract<Step, { kind: 'arc' }>;
type Linear = Extract<Step, { kind: 'linear' }>;
const arcs = (
  src: string,
  op: Partial<Extract<TransformOp, { op: 'arcs' }>> = {},
  dialect: Dialect = GENERIC,
) => transformText(src, [{ op: 'arcs', ...op }], { dialect });
const codes = (r: ReturnType<typeof arcs>) => r.diagnostics.map((d) => `${d.code}@${d.line}`);
const motion = (src: string, dialect: Dialect = GENERIC) =>
  interpret(parse(src), { dialect }).steps.filter(
    (s): s is Arc | Linear => s.kind === 'arc' || s.kind === 'linear',
  );

/**
 * The largest distance from the chords to the arc: each chord is compared, at five
 * points along it, with the arc at the same fraction of its sweep. That bounds the
 * distance to the curve from above, so a pass is conclusive.
 */
function deviation(arc: Arc, chords: readonly Linear[]): number {
  const n = chords.length;
  const start = startAngle(arc);
  const p = new Float64Array(3);
  let worst = 0;
  chords.forEach((c, i) => {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      arcPoint(arc, start, (i + u) / n, p, 0);
      const q = [0, 1, 2].map((j) => {
        const k = (['X', 'Y', 'Z'] as const)[j] as 'X' | 'Y' | 'Z';
        return c.from[k] + (c.to[k] - c.from[k]) * u - (p[j] as number);
      });
      worst = Math.max(worst, Math.hypot(...q));
    }
  });
  return worst;
}

describe('arcsToLines', () => {
  it('turns an arc into chords within the tolerance, keeping the rest of the line', () => {
    const r = arcs('G21 G90\nG0 X0 Y0\nN20 G2 X10 Y0 I5 J0 F300 (half)\nG1 X20\nM30\n', {
      tolerance: 0.5,
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(
      'G21 G90\nG0 X0 Y0\nN20 G1 X1.464 Y3.536 F300 (half)\nX5 Y5\nX8.536 Y3.536\nX10 Y0\nG1 X20\nM30\n',
    );
    expect(codes(r)).toEqual(['TRANSFORM_ARCS_CONVERTED@0']);
    expect(r.diagnostics[0]?.message).toBe('Converted 1 arc into 4 lines, within 0.5 mm');
  });

  it('defaults to 0.01 mm, and every chord is within it', () => {
    const src = 'G21 G90\nG0 X0 Y0\nG2 X10 Y0 I5 J0 F300\nM30\n';
    const r = arcs(src);
    const [arc] = motion(src).filter((s): s is Arc => s.kind === 'arc');
    const chords = motion(r.text).filter((s): s is Linear => s.kind === 'linear' && !s.rapid);
    expect(chords.length).toBe(26);
    expect(deviation(arc as Arc, chords)).toBeLessThanOrEqual(0.01);
  });

  it('ends exactly on the arc: its own end words verbatim, a full circle back at its start', () => {
    const own = arcs('G21 G90\nG0 X0 Y0\nG2 X10.0000 Y0.0 I5 F300\nM30', { tolerance: 0.5 });
    expect(own.text.split('\n')[5]).toBe('X10.0000 Y0.0');
    // Verbatim, spelling and all: the formatter would drop the sign and the -0.
    const spelt = arcs('G21 G90\nG0 X0 Y0\nG2 X+10 Y-0.0 I5 F300\nM30', { tolerance: 0.5 });
    expect(spelt.text.split('\n')[5]).toBe('X+10 Y-0.0');
    // A full circle names no end: the last chord returns to X1.23456, exactly.
    const full = arcs('G21 G90\nG0 X1.23456 Y0\nG3 I5 F300\nG91 G1 X1\nM30', { tolerance: 0.5 });
    const steps = motion(full.text);
    expect(steps.at(-2)?.to.X).toBe(1.23456);
    expect(steps.at(-1)?.to.X).toBeCloseTo(2.23456, 12);
  });

  it('G91: each chord carries the last one’s rounding, so the arc ends exactly', () => {
    const r = arcs('G21 G91\nG0 X0 Y0\nG2 X10 Y0 I5 J0 F300\nM30', { tolerance: 0.001 });
    const steps = motion(r.text);
    expect(steps.at(-1)?.to.X).toBeCloseTo(10, 9);
    expect(steps.at(-1)?.to.Y).toBeCloseTo(0, 9);
    // 10,000 small G91 arcs don't drift.
    const many = `G21 G91\n${'G2 X0.3 Y0 I0.15 J0 F300\n'.repeat(10_000)}M30`;
    const out = motion(arcs(many, { tolerance: 0.001 }).text);
    expect(Math.abs((out.at(-1)?.to.X ?? 0) - 3000)).toBeLessThan(1e-6);
  });

  it('helices, other planes, and inches', () => {
    const helix = arcs('G21 G90\nG0 X0 Y0 Z0\nG2 X10 Y0 Z-2 I5 F300\nM30', { tolerance: 0.5 });
    expect(helix.text).toContain('G1 X1.464 Y3.536 Z-0.500 F300');
    expect(helix.text).toContain('\nX10 Y0 Z-2\n');
    for (const [plane, words] of [
      ['G18', 'X10 Z0 I5'],
      ['G19', 'Y10 Z0 J5'],
    ] as const) {
      const src = `G21 G90 ${plane}\nG0 X0 Y0 Z0\nG2 ${words} F300\nM30`;
      const [arc] = motion(src).filter((s): s is Arc => s.kind === 'arc');
      const r = arcs(src);
      expect(r.ok).toBe(true);
      const chords = motion(r.text).filter((s): s is Linear => s.kind === 'linear' && !s.rapid);
      expect(deviation(arc as Arc, chords)).toBeLessThanOrEqual(0.01);
      expect(chords.at(-1)?.to).toEqual(arc?.to);
    }
    // Inches: the tolerance is still mm, and numbers get 4 decimals or more.
    const inch = 'G20 G90\nG0 X0 Y0\nG2 X1 Y0 I0.5 F10\nM30';
    const [arc] = motion(inch).filter((s): s is Arc => s.kind === 'arc');
    const r = arcs(inch);
    expect(r.text).toMatch(/\nG1 X0\.\d{4} Y0\.\d{4} F10\n/);
    const chords = motion(r.text).filter((s): s is Linear => s.kind === 'linear' && !s.rapid);
    expect(deviation(arc as Arc, chords)).toBeLessThanOrEqual(0.01);
  });

  it('R-format arcs, a modal arc motion, lowercase with no spaces', () => {
    expect(arcs('G21 G90\nG0 X0 Y0\nG2 X10 Y0 R5 F300\nM30', { tolerance: 0.5 }).text).toContain(
      'G1 X1.464 Y3.536 F300\nX5 Y5',
    );
    // "X20 Y0 I5" relies on G2 being modal: converted too, with G1 added.
    expect(
      arcs('G21 G90\nG0 X0 Y0\nG2 X10 Y0 I5 F300\nX20 Y0 I5\nM30', { tolerance: 0.5 }).text,
    ).toContain('X10 Y0\nG1 X11.464 Y3.536\n');
    expect(arcs('g21g90\ng0x0y0\ng2x10y0i5j0f300\nm30', { tolerance: 0.5 }).text).toBe(
      'g21g90\ng0x0y0\ng1x1.464y3.536f300\nx5y5\nx8.536y3.536\nx10y0\nm30',
    );
  });

  it('filters: a line range, a radius band; a modal arc left out says G2 again', () => {
    const src = 'G21 G90\nG0 X0 Y0\nG2 X10 Y0 I5 F300\nX20 Y0 I5\nG2 X120 Y0 I50\nM30';
    const only3 = arcs(src, { tolerance: 0.5, lines: { from: 3, to: 3 } });
    expect(only3.text).toContain('X10 Y0\nG2 X20 Y0 I5\nG2 X120 Y0 I50\n');
    const small = arcs(src, { tolerance: 0.5, radius: { max: 10 } });
    expect(small.text).toContain('\nG2 X120 Y0 I50\n');
    expect(small.diagnostics[0]?.message).toContain('Converted 2 arcs');
    const big = arcs(src, { tolerance: 0.5, radius: { min: 10 } });
    expect(big.text).toContain('\nG2 X10 Y0 I5 F300\nX20 Y0 I5\nG1 X');
  });

  it('block delete: every chord of a block-deleted arc is block-deleted', () => {
    expect(arcs('G21 G90\nG0 X0 Y0\n/G2 X10 Y0 I5 F300\nM30', { tolerance: 0.5 }).text).toBe(
      'G21 G90\nG0 X0 Y0\n/G1 X1.464 Y3.536 F300\n/X5 Y5\n/X8.536 Y3.536\n/X10 Y0\nM30',
    );
    // An arc after a block-deleted move starts from two different places.
    const r = arcs('G21 G90\nG0 X0 Y0\n/G0 X1\nG2 X10 Y0 R6 F300\nM30', { tolerance: 0.5 });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(['TRANSFORM_CONTROL_FLOW@4']);
  });

  it('control flow: an arc must convert the same every time it runs', () => {
    // Called from two places: two different sets of chords.
    const two = arcs(
      'G21 G90\no100 sub\nG2 X10 Y0 R6 F300\no100 endsub\nG0 X0 Y0\no100 call\nG0 X-1 Y0\no100 call\nM2',
      { tolerance: 0.5 },
    );
    expect(two.ok).toBe(false);
    expect(codes(two)).toEqual(['TRANSFORM_CONTROL_FLOW@3']);
    // G91 in a loop: the same relative chords every time.
    const loop = arcs(
      'G21 G91\n#1=0\no1 while [#1 LT 3]\nG2 X10 Y0 I5 F300\n#1=[#1+1]\no1 endwhile\nM2',
      { tolerance: 0.5 },
    );
    expect(loop.ok).toBe(true);
    expect(motion(loop.text).at(-1)?.to.X).toBeCloseTo(30, 9);
    // Units or distance mode switching under control flow: unknowable from the text.
    const mixed = arcs('G21 G91\no1 sub\nG2 X10 Y0 I5 F300\no1 endsub\no1 call\nG90\nM2', {
      tolerance: 0.5,
    });
    expect(codes(mixed)).toContain('TRANSFORM_CONTROL_FLOW@0');
  });

  it('refuses what chords can’t carry faithfully', () => {
    const refused = (src: string, code: string, line: number, tolerance = 0.5) => {
      const r = arcs(src, { tolerance });
      expect(r.ok, src).toBe(false);
      expect(codes(r)).toContain(`${code}@${line}`);
      expect(r.text).toBe(src);
    };
    refused('G21 G90\n#1=5\nG2 X10 Y0 I#1 F300\nM30', 'TRANSFORM_EXPRESSION', 3);
    refused('G21 G90\nG2 X10 Y0 I5 A90 F300\nM30', 'TRANSFORM_UNSUPPORTED_WORD', 2);
    refused('G21 G90\nG2 X10 Y0 I5 F300 M30', 'TRANSFORM_ARC_LINE_WORDS', 2);
    refused('G21 G90 G93\nG2 X10 Y0 I5 F2\nM30', 'TRANSFORM_INVERSE_TIME', 2);
    refused('G21 G90\nG41 D1\nG1 X0 Y0 F300\nG2 X10 Y0 I5\nG40\nM30', 'TRANSFORM_CUTTER_COMP', 4);
    refused('G21 G90\nG2 X20000 Y0 I10000 F300\nM30', 'TRANSFORM_TOO_LARGE', 2, 1e-6);
  });

  it('reports an arc it never ran, and a program with none', () => {
    const r = arcs('G21 G90\nG2 X10 Y0 I5 F300\nM30\nG2 X20 Y0 I5\n', { tolerance: 0.5 });
    expect(codes(r)).toEqual(['TRANSFORM_ARC_NOT_RUN@4', 'TRANSFORM_ARCS_CONVERTED@0']);
    expect(r.text.endsWith('M30\nG2 X20 Y0 I5\n')).toBe(true);
    const none = arcs('G21 G90\nG1 X10 F300\nM30');
    expect(none.text).toBe('G21 G90\nG1 X10 F300\nM30');
    expect(none.diagnostics[0]?.message).toBe('No arcs to convert');
  });

  it('checks its options', () => {
    const bad = (op: Record<string, unknown>) =>
      transformText('G2 X1 I1', [{ op: 'arcs', ...op } as TransformOp]).diagnostics[0]?.message;
    expect(bad({ tolerance: 0 })).toContain('positive');
    expect(bad({ tolerance: '0.01' })).toContain('positive');
    expect(bad({ radius: { min: 5, max: 1 } })).toContain('more than max');
    expect(bad({ radius: { mni: 5 } })).toContain('radius is');
    expect(bad({ lines: { from: 0, to: 1 } })).toContain('lines is');
    expect(bad({ tolernce: 1 })).toContain('unknown field');
  });

  it('Masso: its arcs and repeats convert the same way', () => {
    const r = arcs('G21 G90\nG0 X0 Y0\nG2 X10 Y0 I5 F300\nM5\nM30', { tolerance: 0.5 }, MASSO_G3);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('G1 X1.464 Y3.536 F300');
  });

  it('property: random arcs, any plane, helical or not, G90 or G91, mm or inch', () => {
    fc.assert(
      fc.property(
        fc.record({
          plane: fc.constantFrom('G17', 'G18', 'G19'),
          dir: fc.constantFrom('G2', 'G3'),
          inch: fc.boolean(),
          inc: fc.boolean(),
          r: fc.integer({ min: 1, max: 5000 }),
          end: fc.integer({ min: 0, max: 359 }),
          depth: fc.integer({ min: -200, max: 0 }),
          tol: fc.constantFrom(0.001, 0.005, 0.01, 0.05, 0.2),
          x0: fc.integer({ min: -999, max: 999 }),
        }),
        (p) => {
          // A start on the circle about (x0, 0): centre offset I/J/K = r along the first
          // plane axis, and an end `end` degrees round, in 1/100 units.
          const r = p.r / 100;
          const a = (p.end * Math.PI) / 180;
          const [ax, bx, nx, ic] = {
            G17: ['X', 'Y', 'Z', 'I'],
            G18: ['Z', 'X', 'Y', 'K'],
            G19: ['Y', 'Z', 'X', 'J'],
          }[p.plane] as [string, string, string, string];
          const ea = r - r * Math.cos(a);
          const eb = r * Math.sin(a) * (p.dir === 'G3' ? 1 : -1);
          const f = (v: number) => v.toFixed(4);
          const start = `G0 X${p.x0 / 100} Y0 Z0`;
          const endWords = p.inc
            ? `${ax}${f(ea)} ${bx}${f(eb)} ${nx}${f(p.depth / 100)}`
            : `${ax}${f((ax === 'X' ? p.x0 / 100 : 0) + ea)} ${bx}${f((bx === 'X' ? p.x0 / 100 : 0) + eb)} ${nx}${f((nx === 'X' ? p.x0 / 100 : 0) + p.depth / 100)}`;
          const src = `${p.inch ? 'G20' : 'G21'} G90 ${p.plane}\n${start}\n${p.inc ? 'G91 ' : ''}${p.dir} ${endWords} ${ic}${r} F10\nG90 G0 X0\nM30\n`;
          const before = motion(src);
          const arc = before.find((s): s is Arc => s.kind === 'arc');
          if (!arc) return; // the interpreter refused it (e.g. a zero-length arc)
          const res = arcs(src, { tolerance: p.tol });
          if (!res.ok) {
            expect(codes(res)).toContain('TRANSFORM_TOO_LARGE@3');
            return;
          }
          const after = motion(res.text);
          const chords = after.filter((s): s is Linear => s.kind === 'linear' && !s.rapid);
          expect(deviation(arc, chords)).toBeLessThanOrEqual(p.tol * (1 + 1e-9));
          const last = chords.at(-1) as Linear;
          for (const k of ['X', 'Y', 'Z'] as const)
            expect(Math.abs(last.to[k] - arc.to[k])).toBeLessThan(1e-6);
          // The move after it lands where it did.
          for (const k of ['X', 'Y', 'Z'] as const)
            expect(
              Math.abs((after.at(-1)?.to[k] ?? NaN) - (before.at(-1)?.to[k] ?? NaN)),
            ).toBeLessThan(1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });
});
