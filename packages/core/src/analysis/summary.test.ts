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
    expect(s.feed.byValue[0]?.mmPerMinute).toBe(800);
    expect(s.feed.byValue[0]?.distance).toBeCloseTo(10 + 5 * Math.PI, 9);
    expect(s.feed.byValue[1]).toEqual({ mmPerMinute: 200, distance: 7 });
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
    const b = pathBounds(st);
    expect(s.extent).toEqual({ all: b.all, cut: b.feed, rapid: b.rapid });
    // Distance fed at each per-minute feed adds up to the distance cut.
    const fed = s.feed.byValue.reduce((a, b) => a + b.distance, 0);
    if (s.feed.otherModes === 0 && s.feed.unspecified === 0)
      expect(fed).toBeCloseTo(s.distance.cut, 3);
    // Per-tool distances add up too.
    expect(s.tools.reduce((a, b) => a + b.cut, 0)).toBeCloseTo(s.distance.cut, 3);
    expect(s.moves.rapid + s.moves.linear + s.moves.arc).toBeGreaterThan(0);
    expect(s.zLevels.length).toBeLessThanOrEqual(50);
  });
});
