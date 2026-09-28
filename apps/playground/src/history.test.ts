// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { transformText, type TransformOp } from '@woodpatch/gcode-core';
import { describeOp, parseRecipe, recipeJson, TransformHistory } from './history.js';

const MOVE: TransformOp = { op: 'translate', x: 10 };
const TURN: TransformOp = { op: 'rotate', degrees: 90 };

describe('TransformHistory', () => {
  it('undoes and redoes, and the ghost is the text the transforms started from', () => {
    const h = new TransformHistory();
    expect(h.canUndo).toBe(false);
    expect(h.original).toBeNull();
    h.push('A', MOVE, 'B');
    h.push('B', TURN, 'C');
    expect(h.original).toBe('A');
    expect(h.ops).toEqual([MOVE, TURN]);
    expect(h.undo()).toBe('B');
    expect(h.ops).toEqual([MOVE]);
    expect(h.undo()).toBe('A');
    expect(h.original).toBeNull(); // nothing in effect: no ghost
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('B');
    expect(h.redo()).toBe('C');
    expect(h.redo()).toBeNull();
  });

  it('a new transform after an undo drops what was undone', () => {
    const h = new TransformHistory();
    h.push('A', MOVE, 'B');
    h.push('B', TURN, 'C');
    h.undo();
    h.push('B', MOVE, 'D');
    expect(h.canRedo).toBe(false);
    expect(h.ops).toEqual([MOVE, MOVE]);
    expect(h.original).toBe('A');
  });

  it('starts again from an edit by hand', () => {
    const h = new TransformHistory();
    h.push('A', MOVE, 'B');
    h.reset();
    expect(h.ops).toEqual([]);
    expect(h.canUndo).toBe(false);
    h.push('B edited', TURN, 'E');
    expect(h.original).toBe('B edited');
  });

  it('its recipe, applied to the original, gives what is on screen', () => {
    const src = 'G21 G90\nG0 X0 Y0\nG1 X10 Y5 F300\nM2\n';
    const h = new TransformHistory();
    let text = src;
    for (const op of [MOVE, TURN, { op: 'mirror', axis: 'x' } as TransformOp]) {
      const r = transformText(text, [op]);
      h.push(text, op, r.text);
      text = r.text;
    }
    expect(transformText(src, h.ops).text).toBe(text);
  });
});

describe('recipes', () => {
  it('round-trips through a file', () => {
    const r = parseRecipe(recipeJson([MOVE, TURN], 'generic'));
    expect(r).toEqual({ ok: true, ops: [MOVE, TURN], dialect: 'generic' });
  });

  it('refuses anything else, and a misspelt op, naming the step', () => {
    const bad = (s: string) => {
      const r = parseRecipe(s);
      return r.ok ? '' : r.error;
    };
    expect(bad('not json')).toContain("isn't JSON");
    expect(bad('{"ops":[]}')).toContain("isn't a G-code recipe");
    expect(bad('{"format":"woodpatch-gcode-recipe","version":2,"ops":[]}')).toContain('version 2');
    expect(bad('{"format":"woodpatch-gcode-recipe","version":1,"ops":[]}')).toContain(
      'no operations',
    );
    expect(
      bad(
        '{"format":"woodpatch-gcode-recipe","version":1,"ops":[{"op":"translate","x":1},{"op":"rotate","degree":90}]}',
      ),
    ).toContain('Step 2: unknown field degree');
    expect(bad('{"format":"woodpatch-gcode-recipe","version":1,"ops":[3]}')).toContain(
      'Step 1: not an operation',
    );
  });

  it('describes each op in words', () => {
    expect(describeOp(MOVE)).toBe('Move X 10, Y 0, Z 0 mm');
    expect(describeOp({ op: 'rotate', degrees: 30, about: { x: 5, y: -2 } })).toBe(
      'Rotate 30° about (5, -2)',
    );
    expect(describeOp({ op: 'mirror', axis: 'y', about: 50 })).toBe('Mirror Y about Y = 50');
    expect(describeOp({ op: 'scale', x: 2 })).toBe('Scale × 2 in XY about (0, 0, 0)');
    expect(describeOp({ op: 'scale', x: 2, y: 3, z: 0.5 })).toBe(
      'Scale X × 2, Y × 3, Z × 0.5 about (0, 0, 0)',
    );
  });
});
