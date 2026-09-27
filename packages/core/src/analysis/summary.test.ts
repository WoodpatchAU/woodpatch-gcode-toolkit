// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { interpret, MASSO_G3, parse, pathBounds, summarise } from '../index.js';

// The program summary: each figure checked against a program worked by hand,
// then invariants over the whole corpus.

const steps = (src: string, dialect = MASSO_G3) => interpret(parse(src), { dialect }).steps;
const sum = (src: string) => summarise(steps(src));

describe('summarise', () => {
  const s = sum(
    [
      'G21 G90 G17',
      'T2 M6',
      'G0 Z5',
      'M3 S12000',
      'G0 X0 Y0',
      'G1 Z-2 F200', // a 7 mm plunge at 200
      'G1 X10 F800', // 10 mm at Z-2, at 800
      'G2 X20 Y0 I5 J0', // a half circle, radius 5, over the top: 5π mm at Z-2
      'G4 P500', // Masso dwells in ms
      'G0 Z5',
      'M0',
      'M5',
      'M30',
    ].join('\n'),
  );

  it('separates cut and rapid extents, exact for arcs', () => {
    expect(s.extent.rapid?.max.Z).toBe(5);
    expect(s.extent.cut?.min.Z).toBe(-2);
    // The half circle's top, not just its ends: Y reaches 5.
    expect(s.extent.cut?.max.Y).toBeCloseTo(5, 9);
    expect(s.extent.cut?.max.X).toBeCloseTo(20, 9);
    expect(s.extent.all?.max.Z).toBe(5);
  });

  it('measures distances and counts moves', () => {
    expect(s.distance.plunge).toBeCloseTo(7, 9);
    expect(s.distance.cut).toBeCloseTo(7 + 10 + 5 * Math.PI, 9);
    expect(s.distance.rapid).toBeCloseTo(5 + 7, 9); // up to Z5 from 0, then back up
    expect(s.moves).toEqual({ rapid: 3, linear: 2, arc: 1 });
  });

  it('reports cutting and plunge feeds separately, and the distance at each', () => {
    expect(s.feed.cut).toEqual({ min: 800, max: 800 });
    expect(s.feed.plunge).toEqual({ min: 200, max: 200 });
    // Cutting and plunge feeds are tallied apart: "most used" is never a plunge feed.
    expect(s.feed.byValue).toHaveLength(1);
    expect(s.feed.byValue[0]?.mmPerMinute).toBe(800);
    expect(s.feed.byValue[0]?.distance).toBeCloseTo(10 + 5 * Math.PI, 9);
    expect(s.feed.plungeByValue).toEqual([{ mmPerMinute: 200, distance: 7 }]);
  });

  it('reports the spindle, tools, Z levels, dwells and stops', () => {
    expect(s.spindle.rpm).toEqual({ min: 12000, max: 12000 });
    expect(s.spindle.directions).toEqual(['cw']);
    expect(s.spindle.changes).toBe(2); // M3, M5
    expect(s.spindle.cutWhileOff).toBeNull();
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]?.tool).toBe(2);
    expect(s.toolChanges).toBe(1);
    expect(s.zLevels).toHaveLength(1);
    expect(s.zLevels[0]?.z).toBe(-2);
    expect(s.zLevels[0]?.cut).toBeCloseTo(10 + 5 * Math.PI, 9);
    expect(s.dwell).toEqual({ count: 1, seconds: 0.5 });
    expect(s.pauses).toBe(1);
  });

  it('flags cutting with the spindle off, from the first such line', () => {
    const t = sum('G21 G90\nG1 X10 F500\nG1 X20\nM3 S10000\nG1 X30');
    expect(t.spindle.cutWhileOff).toEqual({ moves: 2, distance: 20, firstLine: 2 });
    expect(t.spindle.byRpm).toEqual([{ rpm: 10000, distance: 10 }]);
  });

  it('reports work coordinates, not machine ones, under a work offset', () => {
    // G54 moved to X100 Y50: the program's X0..10 is machine X100..110.
    const t = summarise(
      interpret(parse('G21 G90\nG10 L2 P1 X100 Y50\nG54\nG0 X0 Y0\nM3 S1000\nG1 X10 F100')).steps,
    );
    expect(t.extent.cut?.min.X).toBe(0);
    expect(t.extent.cut?.max.X).toBe(10);
    expect(t.extent.cut?.min.Y).toBe(0);
    // Review of #32: the interpreter's assumed start (machine zero) is never counted,
    // so no phantom point at minus the offset.
    expect(t.extent.rapid).toEqual({ min: { X: 0, Y: 0, Z: 0 }, max: { X: 0, Y: 0, Z: 0 } });
    expect(t.extent.all?.min.X).toBe(0);
  });

  it('separates rapid from cut extents on Z: a rapid at depth shows (review of #32)', () => {
    // Normal: retract to Z5 before moving. Rapids never go below 5.
    const ok = sum('G21 G90\nG0 Z5\nM3 S1000\nG1 Z-2 F100\nG1 X10\nG0 Z5\nG0 X20');
    expect(ok.extent.rapid?.min.Z).toBe(5);
    expect(ok.extent.cut?.max.Z).toBe(-2); // the plunge ENDS at -2: clearance isn't a cut
    // Dangerous: a rapid across at cut depth. It must stand out.
    const bad = sum('G21 G90\nG0 Z5\nM3 S1000\nG1 Z-2 F100\nG0 X10\nG0 Z5');
    expect(bad.extent.rapid?.min.Z).toBe(-2);
  });

  it('measures full circles, turns, helixes and tolerated spirals', () => {
    const circle = sum('G21 G90\nM3 S1000\nG0 X10 Y0\nG2 I-5 F100');
    expect(circle.extent.cut?.min.X).toBeCloseTo(0, 9);
    expect(circle.extent.cut?.max.Y).toBeCloseTo(5, 9);
    expect(circle.extent.cut?.min.Y).toBeCloseTo(-5, 9);
    expect(circle.distance.cut).toBeCloseTo(10 * Math.PI, 9);
    const turns = sum('G21 G90\nM3 S1000\nG0 X10 Y0\nG2 I-5 P3 F100');
    expect(turns.distance.cut).toBeCloseTo(30 * Math.PI, 9);
    const helix = sum('G21 G90\nM3 S1000\nG0 X10 Y0 Z0\nG2 I-5 Z-4 F100');
    expect(helix.distance.cut).toBeCloseTo(Math.hypot(10 * Math.PI, 4), 9);
    expect(helix.zLevels).toEqual([]); // a helix is not a level
    // A spiral the controller tolerates: radius 5 → 5.0004. Length at the mean radius.
    const spiral = sum('G21 G90\nM3 S1000\nG0 X10 Y0\nG3 X-0.0004 Y0 I-5 J0 F100');
    expect(spiral.distance.cut).toBeCloseTo(Math.PI * 5.0002, 6);
  });

  it('reports inch programs in mm and mm/min, and follows G91', () => {
    const inch = sum('G20 G90\nM3 S1000\nG0 X1 Y0\nG1 X2 F10');
    expect(inch.extent.cut?.max.X).toBeCloseTo(50.8, 9);
    expect(inch.feed.cut).toEqual({ min: 254, max: 254 });
    const inc = sum('G21 G90\nG0 X10 Y10\nG91\nM3 S1000\nG1 X5 F100\nG1 Y-20');
    // X/Y over the cuts' whole path: from (10,10) to (15,10) to (15,-10).
    expect(inc.extent.cut).toEqual({ min: { X: 10, Y: -10, Z: 0 }, max: { X: 15, Y: 10, Z: 0 } });
  });

  it('shifts an arc (and its extremes) into work coordinates under an offset', () => {
    const t = summarise(
      interpret(parse('G21 G90\nG10 L2 P1 X100 Y50\nG54\nM3 S1000\nG0 X10 Y0\nG2 I-5 F100')).steps,
    );
    expect(t.extent.cut?.min.X).toBeCloseTo(0, 9);
    expect(t.extent.cut?.max.Y).toBeCloseTo(5, 9);
  });

  it('caps the Z levels at 50, counting the rest', () => {
    const src = ['G21 G90', 'M3 S1000', 'G0 X0 Y0 Z1'];
    for (let i = 1; i <= 60; i++) src.push(`G1 Z-${i} F100`, `G1 X${i % 2 ? 10 : 0}`);
    const t = sum(src.join('\n'));
    expect(t.zLevels).toHaveLength(50);
    expect(t.zLevels[0]?.z).toBe(-1); // highest first
    expect(t.zLevelsMore).toBe(10);
  });

  it('treats S0 as the spindle off, and M3 without S as on at an unprogrammed speed', () => {
    const s0 = sum('G21 G90\nM3 S0\nG1 X10 F100');
    expect(s0.spindle.cutWhileOff?.moves).toBe(1);
    const noS = sum('G21 G90\nM3\nG1 X10 F100');
    expect(noS.spindle.cutWhileOff).toBeNull();
    expect(noS.spindle.rpm).toBeNull();
    expect(noS.spindle.byRpm).toEqual([{ rpm: null, distance: 10 }]);
  });

  it('is empty-safe', () => {
    const e = sum('M3 S1000\nM5');
    expect(e.extent.all).toBeNull();
    expect(e.feed.cut).toBeNull();
    expect(e.spindle.rpm).toBeNull();
    expect(e.distance).toEqual({ cut: 0, rapid: 0, plunge: 0 });
  });
});

describe('summarise on the corpus', () => {
  it.each(['tux', 'webgcode', 'test_pycam', 'aztec_calendar'])('%s: figures agree', (f) => {
    const src = readFileSync(
      new URL(`../../../../fixtures/upstream/${f}.ngc`, import.meta.url),
      'utf8',
    );
    const st = interpret(parse(src)).steps;
    const s = summarise(st);
    // No work offsets in these: the extent is pathBounds's.
    // End points and arc extremes only: inside the path's full bounds (which also count
    // every start), and the rapids never reach the cut floor of these programs.
    const b = pathBounds(st).all;
    const e = s.extent.all;
    if (b && e)
      for (const a of ['X', 'Y', 'Z'] as const) {
        expect(e.min[a]).toBeGreaterThanOrEqual(b.min[a] - 1e-9);
        expect(e.max[a]).toBeLessThanOrEqual(b.max[a] + 1e-9);
      }
    // Distance fed at each per-minute feed adds up to the distance cut.
    const fed = [...s.feed.byValue, ...s.feed.plungeByValue].reduce((a, b) => a + b.distance, 0);
    if (s.feed.otherModes === 0 && s.feed.unspecified === 0)
      expect(fed).toBeCloseTo(s.distance.cut, 3);
    // Per-tool distances add up too.
    expect(s.tools.reduce((a, b) => a + b.cut, 0)).toBeCloseTo(s.distance.cut, 3);
    expect(s.moves.rapid + s.moves.linear + s.moves.arc).toBeGreaterThan(0);
    expect(s.zLevels.length).toBeLessThanOrEqual(50);
    // No rapid in these programs goes below its clearance height (review of #32: with
    // start points counted, Aztec's rapids appeared to reach -12.885).
    if (f === 'aztec_calendar') expect(s.extent.rapid?.min.Z).toBeCloseTo(5.08, 9);
  });
});
