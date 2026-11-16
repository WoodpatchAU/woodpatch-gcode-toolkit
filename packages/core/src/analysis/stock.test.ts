// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkStock,
  checkStockMoves,
  interpret,
  parse,
  rapidHitsBox,
  validateStock,
  type Diagnostic,
  type StockBox,
  type StockCheckOptions,
} from '../index.js';

// A fictional block: 100 x 50 x 20, its top at Z0 (the usual work zero on the top face).
const BLOCK: StockBox = {
  kind: 'box',
  id: 'b1',
  name: 'Block',
  min: { X: 0, Y: 0, Z: -20 },
  size: { X: 100, Y: 50, Z: 20 },
};

const check = (
  src: string,
  shapes = [BLOCK],
  options: StockCheckOptions = {},
  start?: { X: number; Y: number; Z: number },
): Diagnostic[] =>
  checkStock(interpret(parse(src), start ? { start } : {}).steps, shapes, {
    ...options,
    ...(start ? { startKnown: true } : {}),
  });
const lines = (ds: Diagnostic[]): number[] => ds.map((d) => d.line);

describe('checkStock: which rapids reach into the stock', () => {
  it('flags a rapid across the block below its top, not one above it', () => {
    const src = 'G0 X-10 Y25 Z5\nG0 Z-5\nG0 X110\nG0 Z5\nG0 X-10\n';
    const ds = check(src);
    expect(lines(ds)).toEqual([3]);
    expect(ds[0]?.code).toBe('STOCK_RAPID_COLLISION');
    expect(ds[0]?.message).toContain('"Block"');
    expect(ds[0]?.message).toContain('5 below its top (Z0)');
  });

  it('never flags feed moves: cutting stock is the point', () => {
    expect(check('G0 X-10 Y25 Z5\nG1 Z-5 F500\nG1 X110\nG2 X110 Y25 I0 J0\n')).toEqual([]);
  });

  it('flags a rapid plunge onto the block, not one that stops on its top face', () => {
    expect(lines(check('G0 X50 Y25 Z10\nG0 Z-1\n'))).toEqual([2]);
    expect(check('G0 X50 Y25 Z10\nG0 Z0\n')).toEqual([]);
  });

  it('counts the shank: a tip under the block, over its footprint, collides', () => {
    expect(lines(check('G0 X-10 Y25 Z-30\nG0 X50\n'))).toEqual([2]);
  });

  it('uses the tool radius: a near miss at the centre line, a graze within the radius', () => {
    // The centre line runs 5 mm off the block's side.
    const src = 'G0 X-10 Y-5 Z-5\nG0 X110\n';
    expect(check(src)).toEqual([]);
    expect(check(src, [BLOCK], { toolRadius: 4.9 })).toEqual([]);
    expect(lines(check(src, [BLOCK], { toolRadius: 5.1 }))).toEqual([2]);
    // Exactly touching is not a collision.
    expect(check(src, [BLOCK], { toolRadius: 5 })).toEqual([]);
  });

  it('measures the radius from a corner, not the side lines extended', () => {
    // The centre line passes (−3, −3) off the corner at (0, 0): 4.24 mm from it.
    const src = 'G0 X-13 Y7 Z-5\nG0 X7 Y-13\n';
    expect(check(src, [BLOCK], { toolRadius: 4.2 })).toEqual([]);
    expect(lines(check(src, [BLOCK], { toolRadius: 4.3 }))).toEqual([2]);
  });

  it('flags a diagonal that clips a corner, and only while the tip is low enough', () => {
    expect(lines(check('G0 X-10 Y20 Z-5\nG0 X20 Y-10\n'))).toEqual([2]);
    // Rising across the corner: through Z0 before it reaches the footprint.
    expect(check('G0 X-10 Y20 Z-5\nG0 X20 Y-10 Z15\n')).toEqual([]);
  });

  it("doesn't trust the interpreter's assumed start, unless it's given one", () => {
    // The first move ends outside the block: without a start, nothing is known before.
    expect(check('G0 X-10 Y25 Z-5\n')).toEqual([]);
    // Parked inside the block's footprint, low: the move out of it crosses the stock.
    const start = { X: 50, Y: 25, Z: -5 };
    expect(lines(check('G0 X-10 Y25 Z-5\n', [BLOCK], {}, start))).toEqual([1]);
    // And a first move ENDING in the stock is flagged either way.
    expect(lines(check('G0 X50 Y25 Z-5\n'))).toEqual([1]);
  });

  it('keeps the stock on the table: a G92 shift moves the program, not the stock', () => {
    // G92 makes here read X-100: the same words now land 100 mm further along X.
    expect(check('G92 X-100\nG0 X50 Y25 Z-5\nG0 X60\n')).toEqual([]);
  });

  it('reports the first shape a rapid meets, once per rapid', () => {
    const other: StockBox = { ...BLOCK, id: 'b2', name: 'Other', min: { X: 200, Y: 0, Z: -20 } };
    const ds = check('G0 X-10 Y25 Z-5\nG0 X310\n', [BLOCK, other]);
    expect(lines(ds)).toEqual([2]);
    expect(ds[0]?.message).toContain('"Block"');
  });

  it('caps the reports and counts the rest', () => {
    const src = 'G0 X-10 Y25 Z-5\n' + 'G0 X110\nG0 X-10\n'.repeat(5);
    const ds = check(src, [BLOCK], { maxReports: 3 });
    expect(ds.map((d) => d.code)).toEqual([
      'STOCK_RAPID_COLLISION',
      'STOCK_RAPID_COLLISION',
      'STOCK_RAPID_COLLISION',
      'STOCK_RAPID_COLLISION_MORE',
    ]);
    expect(ds[3]?.message).toContain('7 more');
  });

  it('a long workpiece the spindle cannot rise above: travel must go round it', () => {
    // A fictional beam along -X whose top stands 10 mm above Z0, the highest the tool
    // can go; the bit parks against its end, at X0 Y50.
    const beam: StockBox = {
      kind: 'box',
      id: 'beam',
      name: 'Beam',
      min: { X: -500, Y: 0, Z: -90 },
      size: { X: 500, Y: 100, Z: 100 },
    };
    const park = { X: 8, Y: 50, Z: 0 };
    // Straight from the park position to the far side of the beam: through it.
    expect(lines(check('G0 Z0\nG0 X-100 Y-10\n', [beam], { toolRadius: 8 }, park))).toEqual([2]);
    // Out in front of the end, along beside the beam, then in: clear all the way.
    const round = 'G0 Z0\nG0 X20 Y50\nG0 Y-20\nG0 X-100\nG0 Y-8\n';
    expect(check(round, [beam], { toolRadius: 8 }, park)).toEqual([]);
  });

  it('a program kept off the stock is silent, at the cutter radius too', () => {
    // Round the block at 10 mm: in front, beside, then down beside it and along.
    const src = 'G0 X-10 Y-10 Z5\nG0 Z-15\nG0 X110\nG0 Y60\nG0 X-10\nG0 Y-10\n';
    expect(check(src, [BLOCK], { toolRadius: 8 })).toEqual([]);
  });
});

describe('checkStockMoves: the same check on moves from anywhere', () => {
  it('gives what checkStock gives on the same program', () => {
    const src = 'G0 X-10 Y25 Z5\nG0 Z-5\nG0 X110\nG1 X50 F500\nG0 X-10 Y25 Z-5\n';
    const steps = interpret(parse(src)).steps;
    const moves = steps.flatMap((s) =>
      s.kind === 'linear' || s.kind === 'arc'
        ? [{ rapid: s.kind === 'linear' && s.rapid, from: s.from, to: s.to, line: s.line }]
        : [],
    );
    expect(checkStockMoves(moves, [BLOCK])).toEqual(checkStock(steps, [BLOCK]));
    expect(lines(checkStockMoves(moves, [BLOCK]))).toEqual([3, 5]);
  });
});

describe('rapidHitsBox: agrees with a brute-force sample along the move', () => {
  it('for random moves and radii', () => {
    const coord = fc.double({ min: -50, max: 150, noNaN: true });
    fc.assert(
      fc.property(
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        fc.double({ min: 0, max: 10, noNaN: true }),
        (ax, ay, az, bx, by, bz, r) => {
          const a = { X: ax, Y: ay, Z: az / 4 };
          const b = { X: bx, Y: by, Z: bz / 4 };
          const hit = rapidHitsBox(a, b, BLOCK, r);
          // Brute force: the deepest overlap over 4,001 points along the move.
          let best = -Infinity;
          for (let i = 0; i <= 4000; i++) {
            const t = i / 4000;
            const x = a.X + (b.X - a.X) * t;
            const y = a.Y + (b.Y - a.Y) * t;
            const z = a.Z + (b.Z - a.Z) * t;
            if (!(z < 0 - 1e-6)) continue;
            const dx = Math.max(0 - x, 0, x - 100);
            const dy = Math.max(0 - y, 0, y - 50);
            const d = dx > 0 || dy > 0 ? Math.hypot(dx, dy) : -Math.min(x, 100 - x, y, 50 - y);
            best = Math.max(best, r - d);
          }
          // Sampling can only miss depth, never invent it: allow its step's worth.
          const step = Math.hypot(b.X - a.X, b.Y - a.Y) / 4000 + 1e-6;
          if (hit) expect(hit.overlap).toBeGreaterThanOrEqual(best - 1e-6);
          if (best > step) expect(hit).not.toBeNull();
          if (!hit) expect(best).toBeLessThanOrEqual(step);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('validateStock', () => {
  it('accepts boxes with finite numbers, positive sizes and unique ids', () => {
    expect(validateStock([BLOCK])).toEqual([]);
  });

  it('names each problem', () => {
    const bad = [
      { ...BLOCK, size: { X: 0, Y: 1, Z: 1 } },
      { ...BLOCK, min: { X: Number.NaN, Y: 0, Z: 0 } },
      { ...BLOCK, kind: 'sphere' } as unknown as StockBox,
    ];
    const p = validateStock(bad);
    expect(p).toHaveLength(4);
    expect(p.join('\n')).toMatch(/above zero/);
    expect(p.join('\n')).toMatch(/used twice/);
    expect(p.join('\n')).toMatch(/finite/);
    expect(p.join('\n')).toMatch(/only boxes/);
  });

  it('checkStock refuses invalid shapes and options rather than guessing', () => {
    const steps = interpret(parse('G0 X1\n')).steps;
    expect(() => checkStock(steps, [{ ...BLOCK, size: { X: -1, Y: 1, Z: 1 } }])).toThrow(TypeError);
    expect(() => checkStock(steps, [BLOCK], { toolRadius: -1 })).toThrow(TypeError);
  });
});
