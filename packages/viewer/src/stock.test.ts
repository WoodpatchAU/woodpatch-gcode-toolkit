// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
import { checkStock, interpret, parse, type StockBox } from '@woodpatch/gcode-core';
import { Mesh } from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { describe, expect, it } from 'vitest';
import { loadProgram, stockBounds, stockCollisions } from './index.js';
import { buildDimensions, buildStock, disposeGroup, fmt } from './overlays.js';

const BLOCK: StockBox = {
  kind: 'box',
  id: 'b1',
  name: 'Block',
  min: { X: 0, Y: 0, Z: -20 },
  size: { X: 100, Y: 50, Z: 20 },
};

describe('stockCollisions: the core check on a loaded path', () => {
  it('agrees with checkStock on the interpreter steps', () => {
    const src = 'G21 G90\nG0 X-10 Y25 Z5\nG0 Z-5\nG0 X110\nG1 X50 F500\nG0 X-10\nG0 Z5\n';
    const fromPath = stockCollisions(loadProgram(src), [BLOCK], { toolRadius: 3 });
    const fromSteps = checkStock(interpret(parse(src)).steps, [BLOCK], { toolRadius: 3 });
    expect(fromPath).toEqual(fromSteps);
    expect(fromPath.map((d) => d.line)).toEqual([4, 6]);
  });

  it("doesn't trust vertex 0, the assumed start", () => {
    // The assumed start (0, 0, 0) is on the block's top edge; the first move leaves it.
    expect(stockCollisions(loadProgram('G0 X50 Y25 Z-5\n'), [BLOCK])).toHaveLength(1);
    expect(stockCollisions(loadProgram('G0 X-10 Y25 Z-5\n'), [BLOCK])).toEqual([]);
  });
});

describe('stockBounds', () => {
  it('frames the visible shapes only', () => {
    const far: StockBox = { ...BLOCK, id: 'b2', min: { X: 500, Y: 0, Z: 0 } };
    expect(stockBounds([{ shape: BLOCK }, { shape: far, visible: false }])).toEqual({
      min: { X: 0, Y: 0, Z: -20 },
      max: { X: 100, Y: 50, Z: 0 },
    });
    expect(stockBounds([{ shape: far, visible: false }])).toBeNull();
  });
});

describe('the overlays', () => {
  it('places each visible box by its centre, relative to the scene origin', () => {
    const g = buildStock(
      [{ shape: BLOCK }, { shape: { ...BLOCK, id: 'h' }, visible: false }],
      [10, 20, 30],
      0xc8a165,
    );
    expect(g.children).toHaveLength(1);
    const holder = g.children[0];
    expect(holder?.name).toBe('b1');
    expect(holder?.position.toArray()).toEqual([50 - 10, 25 - 20, -10 - 30]);
    expect(holder?.children.some((c) => c instanceof Mesh)).toBe(true);
    disposeGroup(g);
  });

  it('labels the lengths and the two corners, as text', () => {
    const box = { min: { X: -98, Y: -20, Z: -75 }, max: { X: 20, Y: 98, Z: 0 } };
    const g = buildDimensions(box, [0, 0, 0], 0x8fd3ff);
    const texts: string[] = [];
    g.traverse((o) => {
      if (o instanceof CSS2DObject) texts.push(o.element.textContent ?? '');
    });
    expect(texts).toEqual(['X 118', 'Y 118', 'Z 75', '-98, -20, -75', '20, 98, 0']);
    disposeGroup(g);
  });

  it('formats numbers to 3 decimals, without trailing zeros or a negative zero', () => {
    expect([fmt(118), fmt(12.3456), fmt(-0.0001), fmt(0.5), fmt(-7.99)]).toEqual([
      '118',
      '12.346',
      '0',
      '0.5',
      '-7.99',
    ]);
  });
});
