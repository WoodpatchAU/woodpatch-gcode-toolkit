// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  fitTransform,
  gridLines,
  gridSpacing,
  loadProgram,
  MAX_SCALE,
  nearestSegment,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
  type Transform,
} from './index.js';

// Parcel 3d (ADR-0029): the 2D plan view's maths, without a canvas.

const W = 800;
const H = 600;

describe('transform', () => {
  it('puts the centre in the middle, with Y up', () => {
    const t: Transform = { scale: 2, cx: 10, cy: 20 };
    expect(toScreen(t, W, H, 10, 20)).toEqual([400, 300]);
    expect(toScreen(t, W, H, 11, 21)).toEqual([402, 298]);
  });

  it('round-trips screen and world', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: -1e4, max: 1e4, noNaN: true }),
        fc.double({ min: 0, max: W, noNaN: true }),
        fc.double({ min: 0, max: H, noNaN: true }),
        (scale, cx, cy, sx, sy) => {
          const t = { scale, cx, cy };
          const [x, y] = toWorld(t, W, H, sx, sy);
          const [bx, by] = toScreen(t, W, H, x, y);
          expect(bx).toBeCloseTo(sx, 6);
          expect(by).toBeCloseTo(sy, 6);
        },
      ),
    );
  });
});

describe('fitTransform', () => {
  it('frames a ghost too: the original behind a transformed program', () => {
    // Both start at the machine origin: the original spans X-100..0, the result 0..110.
    const p = loadProgram('G21 G90 F100\nG0 X-100 Y0\nG1 X-90 Y10');
    const moved = loadProgram('G21 G90 F100\nG0 X100 Y0\nG1 X110 Y10');
    const t = fitTransform(moved, W, H, p);
    expect(t.cx).toBeCloseTo(5, 9);
    expect(t.cy).toBeCloseTo(5, 9);
    // Without the ghost, only the program itself.
    expect(fitTransform(moved, W, H, null).cx).toBeCloseTo(55, 9);
  });

  it('frames the XY box with a margin, whatever the aspect', () => {
    const p = loadProgram('G21 G90 F100\nG0 X-50 Y0\nG1 X150 Y50 Z-3');
    const t = fitTransform(p, W, H);
    expect(t.cx).toBeCloseTo(50, 9);
    expect(t.cy).toBeCloseTo(25, 9);
    expect(t.scale).toBeCloseTo((W / 200) * 0.9, 9); // X-limited
    const [l] = toScreen(t, W, H, -50, 0);
    const [r] = toScreen(t, W, H, 150, 0);
    expect(l).toBeGreaterThan(0);
    expect(r).toBeLessThan(W);
  });

  it('is sane for nothing, and for a program that only moves in Z', () => {
    expect(fitTransform(null, W, H)).toEqual({ scale: 1, cx: 0, cy: 0 });
    const t = fitTransform(loadProgram('G0 Z10'), W, H);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(t.scale).toBeLessThanOrEqual(MAX_SCALE);
  });
});

describe('zoomAt and panBy', () => {
  it('keeps the point under the pointer fixed', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: W, noNaN: true }),
        fc.double({ min: 0, max: H, noNaN: true }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        (sx, sy, factor) => {
          const t = { scale: 3, cx: 12, cy: -7 };
          const before = toWorld(t, W, H, sx, sy);
          const after = toWorld(zoomAt(t, W, H, sx, sy, factor), W, H, sx, sy);
          expect(after[0]).toBeCloseTo(before[0], 6);
          expect(after[1]).toBeCloseTo(before[1], 6);
        },
      ),
    );
  });

  it('clamps the zoom', () => {
    expect(zoomAt({ scale: 1, cx: 0, cy: 0 }, W, H, 0, 0, 1e12).scale).toBe(MAX_SCALE);
  });

  it('moves the drawing with the drag', () => {
    const t = { scale: 2, cx: 0, cy: 0 };
    const p = panBy(t, 10, 20);
    // The world point that was at the centre is now 10 px right and 20 px down.
    expect(toScreen(p, W, H, 0, 0)).toEqual([410, 320]);
  });
});

describe('grid', () => {
  it('picks 1, 2 or 5 × 10ⁿ mm, at least the minimum pixels apart', () => {
    expect(gridSpacing(1, 40)).toBe(50);
    expect(gridSpacing(4, 40)).toBe(10);
    expect(gridSpacing(10, 40)).toBe(5);
    expect(gridSpacing(100, 40)).toBeCloseTo(0.5, 12);
    fc.assert(
      fc.property(fc.double({ min: 1e-4, max: 1e4, noNaN: true }), (scale) => {
        const s = gridSpacing(scale, 40);
        expect(s * scale).toBeGreaterThanOrEqual(40 * (1 - 1e-9));
        expect(s * scale).toBeLessThan(40 * 2.5 + 1e-9); // never coarser than the next step
        const m = s / 10 ** Math.floor(Math.log10(s) + 1e-12);
        expect([1, 2, 5].some((k) => Math.abs(m - k) < 1e-9)).toBe(true);
      }),
    );
  });

  it('lists the lines in range, and caps them', () => {
    expect(gridLines(-12, 31, 10)).toEqual([-10, 0, 10, 20, 30]);
    expect(gridLines(0, 1e9, 1, 50)).toHaveLength(50);
  });
});

describe('nearestSegment', () => {
  const p = loadProgram('G21 G90 F100\nG0 X10\nG1 Y10\nG1 X0');
  // Segments: 0 (0,0)→(10,0), 1 (10,0)→(10,10), 2 (10,10)→(0,10).

  it('finds the closest segment in plan', () => {
    expect(nearestSegment(p, 5, 0.5, 1)).toBe(0);
    expect(nearestSegment(p, 9.6, 5, 1)).toBe(1);
    expect(nearestSegment(p, 3, 10.2, 1)).toBe(2);
  });

  it('measures to the segment, not its line, and honours the radius', () => {
    expect(nearestSegment(p, 15, 5, 1)).toBe(-1);
    expect(nearestSegment(p, 20, 0, 5)).toBe(-1); // on segment 0's line, past its end
    expect(nearestSegment(p, 5, 5, 1)).toBe(-1);
  });

  it('picks what is drawn on top where a rapid crosses a cut', () => {
    // A rapid across X=5 from Y-5 to Y5, then LATER a feed along Y=0 from X0 to X10, so
    // "the later segment wins" alone would pick the feed at the crossing.
    const q = loadProgram('G21 G90 F100\nG0 X5 Y-5\nG0 Y5\nG1 X0 Y0\nG1 X10');
    // Segments: 0 rapid (0,0)->(5,-5); 1 rapid (5,-5)->(5,5); 2 feed (5,5)->(0,0);
    // 3 feed (0,0)->(10,0). At the crossing (5,0), segments 1 and 3 are both at 0.
    expect(nearestSegment(q, 5, 0, 1, 0.1)).toBe(1); // the rapid, drawn on top
    // Along the feed, beyond the tie allowance from the rapid, the feed wins.
    expect(nearestSegment(q, 8, 0.05, 1, 0.1)).toBe(3);
    // Even with no tie allowance, an EXACT tie goes to what is drawn on top.
    expect(nearestSegment(q, 5, 0, 1)).toBe(1);
  });

  it('is -1 for a program with no segments', () => {
    expect(nearestSegment(loadProgram(''), 0, 0, 100)).toBe(-1);
  });
});
