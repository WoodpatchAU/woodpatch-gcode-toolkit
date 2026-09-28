// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { coverRadius, fitDistance, gridSpec, unionBox, VIEW_DIRECTIONS } from './view.js';

describe('view helpers', () => {
  it('fits a sphere by the narrower field of view', () => {
    const wide = fitDistance(10, 45, 2);
    const tall = fitDistance(10, 45, 0.5);
    expect(tall).toBeGreaterThan(wide);
    // At the fitted distance the sphere subtends the narrow angle (with 10% margin).
    const v = (45 * Math.PI) / 180;
    expect((10 / Math.sin(v / 2)) * 1.1).toBeCloseTo(wide, 9);
  });

  it('picks round grid cells (1, 2, 5 × 10ⁿ) covering the path', () => {
    expect(gridSpec(100)).toEqual({ size: 120, divisions: 6 });
    expect(gridSpec(1600)).toEqual({ size: 2000, divisions: 10 });
    const g = gridSpec(37);
    expect(g.size).toBeGreaterThanOrEqual(37 * 1.2);
  });

  it('has unit view directions', () => {
    for (const d of Object.values(VIEW_DIRECTIONS)) expect(Math.hypot(...d)).toBeCloseTo(1, 3);
  });
});

describe('framing two paths (setGhost)', () => {
  const box = (a: number[], b: number[]) => ({
    min: { X: a[0] as number, Y: a[1] as number, Z: a[2] as number },
    max: { X: b[0] as number, Y: b[1] as number, Z: b[2] as number },
  });
  it('unions boxes, either of which may be missing', () => {
    const a = box([0, 0, -1], [10, 10, 0]);
    const b = box([100, -5, -3], [110, 5, 1]);
    expect(unionBox(a, b)).toEqual(box([0, -5, -3], [110, 10, 1]));
    expect(unionBox(a, null)).toBe(a);
    expect(unionBox(undefined, b)).toBe(b);
    expect(unionBox(null, null)).toBeNull();
  });
  it('covers a box from a centre that may be off it: the farthest corner', () => {
    const b = box([-1, -2, -3], [1, 2, 3]);
    // About its own centre: half the diagonal, as the viewer always fitted.
    expect(coverRadius(b, [0, 0, 0])).toBeCloseTo(Math.hypot(2, 4, 6) / 2, 12);
    expect(coverRadius(b, [1, 0, 0])).toBeCloseTo(Math.hypot(2, 2, 3), 12);
  });
});
