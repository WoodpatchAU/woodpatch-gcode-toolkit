// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  VERTEX_ARC,
  VERTEX_FEED,
  VERTEX_RAPID,
  interpret,
  parse,
  pathBounds,
  tessellate,
  type Step,
} from '../index.js';

// Parcel 2d (ADR-0022): tessellation into typed arrays, and exact bounds.

const steps = (src: string) => interpret(parse(src)).steps;
const vertex = (p: Float64Array, v: number) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]];

describe('tessellate', () => {
  it('makes one continuous polyline, with the step and kind of each vertex', () => {
    const s = steps('G21 G90 F100\nG0 X10\nG1 Y5\nM3 S1000\nG2 X0 Y15 R10 \nG0 Z5');
    const t = tessellate(s, { chordTolerance: 1 });
    expect(vertex(t.positions, 0)).toEqual([0, 0, 0]);
    expect(vertex(t.positions, 1)).toEqual([10, 0, 0]);
    expect(vertex(t.positions, 2)).toEqual([10, 5, 0]);
    expect(t.kind[1]).toBe(VERTEX_RAPID);
    expect(t.kind[2]).toBe(VERTEX_FEED);
    expect(t.kind[3]).toBe(VERTEX_ARC);
    expect(t.kind[t.count - 1]).toBe(VERTEX_RAPID);
    // Arc vertices point at the arc's step, past the spindle step.
    expect(s[t.step[3] as number]?.kind).toBe('arc');
    // The arc ends exactly at the interpreter's end point.
    expect(vertex(t.positions, t.count - 2)).toEqual([0, 15, 0]);
    expect(t.truncated).toBe(false);
  });

  it('is empty (just a start) for a program with no moves', () => {
    const t = tessellate(steps('M3 S1000'));
    expect(t.count).toBe(1);
    expect(t.positions).toHaveLength(3);
  });

  it('coarsens an arc over the budget instead of dropping the rest of the path', () => {
    const t = tessellate(steps('G21 G90 F100\nG0 X10\nG2 I-10 P1000\nG1 X20'), {
      maxVertices: 500,
    });
    expect(t.truncated).toBe(false);
    expect(t.coarsened).toBe(true);
    expect(t.count).toBeLessThanOrEqual(500);
    expect(vertex(t.positions, t.count - 1)).toEqual([20, 0, 0]); // the move after it survives
  });

  it('truncates only when there are more moves than the budget', () => {
    const src = Array.from({ length: 20 }, (_, i) => `G0 X${i + 1}`).join('\n');
    const t = tessellate(steps(src), { maxVertices: 10 });
    expect(t.truncated).toBe(true);
    expect(t.count).toBe(10);
  });

  it('bounds one arc with a huge P before allocating (reviewer: 574 MB from one line)', () => {
    const t0 = performance.now();
    const t = tessellate(steps('G21 G90 F100\nG0 X5\nG2 I-5 P126000'));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(t.count).toBeLessThanOrEqual(100_001 + 1);
    expect(t.coarsened).toBe(true);
  });

  it('draws a huge-radius arc as one chord, and keeps everything after it', () => {
    const t = tessellate(steps('G21 G90 F100\nG2 X10 Y0 R100000000000000\nG1 X20\nG1 X30'));
    expect(t.truncated).toBe(false);
    expect(t.coarsened).toBe(false);
    expect(t.count).toBe(4);
    expect(vertex(t.positions, 3)).toEqual([30, 0, 0]);
  });

  it('refuses a non-positive tolerance', () => {
    expect(() => tessellate([], { chordTolerance: 0 })).toThrow(RangeError);
  });

  // Property: every chord of a random arc (any plane, direction, turns, helix, spiral
  // within tolerance) stays within the chord tolerance of the true arc.
  it('keeps every chord within the tolerance of the arc', () => {
    fc.assert(
      fc.property(
        fc.record({
          plane: fc.constantFrom('G17', 'G18', 'G19'),
          dir: fc.constantFrom('G2', 'G3'),
          r: fc.double({ min: 0.5, max: 500, noNaN: true }),
          a0: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
          a1: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
          turns: fc.integer({ min: 1, max: 3 }),
          dz: fc.double({ min: -20, max: 20, noNaN: true }),
          tol: fc.constantFrom(0.001, 0.01, 0.1),
        }),
        ({ plane, dir, r, a0, a1, turns, dz, tol }) => {
          const [A, B, N, I, J] =
            plane === 'G17'
              ? ['X', 'Y', 'Z', 'I', 'J']
              : plane === 'G18'
                ? ['Z', 'X', 'Y', 'K', 'I']
                : ['Y', 'Z', 'X', 'J', 'K'];
          const f = (v: number) => v.toFixed(6);
          const sa = r * Math.cos(a0);
          const sb = r * Math.sin(a0);
          const src =
            `G21 G90 ${plane} F100\nG0 ${A}${f(sa)} ${B}${f(sb)}\n` +
            `${dir} ${A}${f(r * Math.cos(a1))} ${B}${f(r * Math.sin(a1))} ${N}${f(dz)} ` +
            `${I}${f(-sa)} ${J}${f(-sb)} P${turns}`;
          const s = steps(src);
          const arc = s.find((x) => x.kind === 'arc');
          if (!arc || arc.kind !== 'arc') return; // refused (e.g. a rounding spiral): fine
          const t = tessellate(s, { chordTolerance: tol });
          const idx = { X: 0, Y: 1, Z: 2 } as const;
          const ia = idx[A as 'X'];
          const ib = idx[B as 'X'];
          const ca = arc.centre[A as 'X'];
          const cb = arc.centre[B as 'X'];
          const rMax = Math.max(arc.radius, arc.endRadius);
          const rMin = Math.min(arc.radius, arc.endRadius);
          for (let v = 2; v < t.count; v++) {
            if (t.kind[v] !== VERTEX_ARC) continue;
            // Each vertex is on the arc, and each chord's midpoint is within tol of it.
            const p = vertex(t.positions, v) as number[];
            const q = vertex(t.positions, v - 1) as number[];
            const rv = Math.hypot((p[ia] as number) - ca, (p[ib] as number) - cb);
            expect(rv).toBeGreaterThan(rMin - 1e-9);
            expect(rv).toBeLessThan(rMax + 1e-9);
            const mid = Math.hypot(
              ((p[ia] as number) + (q[ia] as number)) / 2 - ca,
              ((p[ib] as number) + (q[ib] as number)) / 2 - cb,
            );
            expect(mid).toBeGreaterThan(rMin - tol - 1e-9);
          }
        },
      ),
      { numRuns: 300 },
    );
    // About 4 s alone; more beside the corpus suites, which run in parallel.
  }, 30_000);
});

describe('pathBounds', () => {
  it('includes an arc’s extremes, not just its end points', () => {
    // A half circle over the top: from (10,0) to (-10,0) anticlockwise reaches Y=10.
    const b = pathBounds(steps('G21 G90 F100\nG0 X10\nG3 X-10 Y0 I-10 J0'));
    expect(b.feed?.max.Y).toBeCloseTo(10, 12);
    expect(b.feed?.min.Y).toBeCloseTo(0, 12);
    expect(b.feed?.min.X).toBeCloseTo(-10, 12);
    expect(b.rapid).toEqual({ min: { X: 0, Y: 0, Z: 0 }, max: { X: 10, Y: 0, Z: 0 } });
  });

  it('covers a full circle and a helix', () => {
    const b = pathBounds(steps('G21 G90 F100\nG0 X10\nG2 I-10 Z-5 P3'));
    expect(b.feed?.min.X).toBeCloseTo(-10, 12);
    expect(b.feed?.max.Y).toBeCloseTo(10, 12);
    expect(b.feed?.min.Y).toBeCloseTo(-10, 12);
    expect(b.feed?.min.Z).toBe(-5);
  });

  it('is null when nothing moves', () => {
    expect(pathBounds(steps('M3 S100'))).toEqual({ all: null, feed: null, rapid: null });
  });

  // Property: the exact box contains the tessellated path, and the tessellated
  // path's own box is within the chord tolerance of it (so it's tight).
  it('contains the tessellation and is tight to within the tolerance', () => {
    const files = ['tux.ngc', 'webgcode.ngc', 'test_pycam.ngc'];
    for (const f of files) {
      const src = readFileSync(
        new URL(`../../../../fixtures/upstream/${f}`, import.meta.url),
        'utf8',
      );
      const s: readonly Step[] = steps(src);
      const b = pathBounds(s).all;
      const t = tessellate(s, { chordTolerance: 0.001 });
      expect(b).not.toBeNull();
      if (!b) continue;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < t.count; v++) {
        for (let k = 0; k < 3; k++) {
          const x = t.positions[v * 3 + k] as number;
          lo[k] = Math.min(lo[k] as number, x);
          hi[k] = Math.max(hi[k] as number, x);
        }
      }
      const axes = ['X', 'Y', 'Z'] as const;
      axes.forEach((a, k) => {
        expect(lo[k]).toBeGreaterThanOrEqual(b.min[a] - 1e-9);
        expect(hi[k]).toBeLessThanOrEqual(b.max[a] + 1e-9);
        expect(b.max[a] - (hi[k] as number)).toBeLessThan(0.001 + 1e-9);
        expect((lo[k] as number) - b.min[a]).toBeLessThan(0.001 + 1e-9);
      });
    }
  });
});

describe('parity with upstream (where upstream was right)', () => {
  it.each(['tux', 'webgcode', 'test_pycam', 'aztec_calendar'])(
    'matches the legacy golden bounding box: %s',
    (f) => {
      const read = (p: string) =>
        readFileSync(new URL(`../../../../fixtures/${p}`, import.meta.url), 'utf8');
      const golden = JSON.parse(read(`golden/legacy/upstream/${f}.json`)) as {
        summary: { simulatedBbox: { min: number[]; max: number[] } };
      };
      const b = pathBounds(steps(read(`upstream/${f}.ngc`))).all;
      const ours = b ? [b.min.X, b.min.Y, b.min.Z, b.max.X, b.max.Y, b.max.Z] : [];
      const theirs = [...golden.summary.simulatedBbox.min, ...golden.summary.simulatedBbox.max];
      ours.forEach((v, k) => expect(v).toBeCloseTo(theirs[k] as number, 4));
    },
  );
});

describe('multi-turn spiral bounds', () => {
  it('uses the last occurrence of a direction, where the spiral reaches furthest', () => {
    // Three turns spiralling out from r=10 to r=10.02: the widest point in -X is on the
    // last turn, near the end (radius ~10.02), not the first (~10.003).
    const b = pathBounds(steps('G21 G90 F100\nG0 X10\nG3 X-10.02 Y0 I-10 J0 P3'));
    expect(b.feed?.max.Y).toBeGreaterThan(10.015);
  });
});
