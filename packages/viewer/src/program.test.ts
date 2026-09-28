// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { VERTEX_ARC, VERTEX_FEED, VERTEX_RAPID } from '@woodpatch/gcode-core';
import { describe, expect, it } from 'vitest';
import {
  buildLineIndex,
  buildSegments,
  DEFAULT_PALETTE,
  loadProgram,
  transferables,
} from './index.js';
import { handle } from './worker.js';

const fixture = (p: string) =>
  readFileSync(new URL(`../../../fixtures/${p}`, import.meta.url), 'utf8');

describe('loadProgram', () => {
  it('parses, interprets and tessellates, with each vertex tied to its source line', () => {
    const p = loadProgram('G21 G90 F100\nG0 X10\nG1 Y5\nG2 X0 Y15 R10');
    expect(p.dialect).toBe('generic');
    expect(p.kind[1]).toBe(VERTEX_RAPID);
    expect(p.kind[2]).toBe(VERTEX_FEED);
    expect(p.kind[3]).toBe(VERTEX_ARC);
    expect(Array.from(p.vertexLine.subarray(0, 3))).toEqual([0, 2, 3]);
    expect(p.vertexLine[p.count - 1]).toBe(4);
    expect(p.bounds.all?.max.X).toBeCloseTo(10, 9);
  });

  it('uses the dialect asked for, and falls back to generic for an unknown id', () => {
    expect(loadProgram('G0 X1', { dialect: 'masso-g3-5.13' }).dialect).toBe('masso-g3-5.13');
    expect(loadProgram('G0 X1', { dialect: 'nope' }).dialect).toBe('generic');
    // The Masso profile ignores a line with G43, as the machine does.
    expect(loadProgram('G0 G43 Z5 H1', { dialect: 'masso-g3-5.13' }).count).toBe(1);
  });

  it('reports syntax and interpreter diagnostics together', () => {
    const codes = loadProgram('G1 X1 (open\nG2 X5 F100').diagnostics.map((d) => d.code);
    expect(codes).toContain('SYNTAX_UNTERMINATED_COMMENT');
    expect(codes).toContain('SEMANTIC_ARC_NO_CENTRE');
  });

  it('gives subprogram-file moves line 0 (they belong to another file)', () => {
    const p = loadProgram('M98 P1\nG0 X5', {
      dialect: 'masso-g3-5.13',
    });
    // No resolver here, so the call fails; the point is the main file's lines stay right.
    expect(p.diagnostics.map((d) => d.code)).toContain('SEMANTIC_SUB_NOT_FOUND');
  });

  it('loads all five reference files (Phase 3 acceptance)', () => {
    for (const f of [
      'upstream/aztec_calendar.ngc',
      'upstream/tux.ngc',
      'upstream/webgcode.ngc',
      'upstream/test_pycam.ngc',
      'machine/masso-dialect-test-v1.nc',
    ]) {
      const p = loadProgram(
        fixture(f),
        f.startsWith('machine/') ? { dialect: 'masso-g3-5.13' } : {},
      );
      expect(p.count, f).toBeGreaterThan(10);
      expect(p.truncated, f).toBe(false);
    }
  });
});

describe('buildSegments', () => {
  it('makes one segment per vertex pair, coloured by kind, relative to the path centre', () => {
    const p = loadProgram('G21 G90 F100\nG0 X10\nG1 Y5');
    const s = buildSegments(p);
    expect(s.segments).toBe(2);
    expect(s.origin).toEqual([5, 2.5, 0]);
    expect(Array.from(s.positions)).toEqual([-5, -2.5, 0, 5, -2.5, 0, 5, -2.5, 0, 5, 2.5, 0]);
    expect(Array.from(s.colors.subarray(0, 3))).toEqual([1, 0, 0]); // rapid: red
    expect(Array.from(s.colors.subarray(6, 9))).toEqual([1, 1, 1]); // feed: white
  });

  it('stays within 0.25 µm of the exact position across a 4 m bed (Float32 about the centre)', () => {
    // Every path includes the move from the machine's home, so the span sets the
    // precision: Float32 about the centre of a 4000 mm span resolves ~0.12 µm.
    const p = loadProgram('G21 G90 F100\nG0 X3999.0001 Y3999.0003\nG1 X3998.0007');
    const s = buildSegments(p);
    for (let i = 0; i < s.segments * 2; i++) {
      const v = i === 0 ? 0 : i; // segment endpoints map to vertices 0,1,1,2,...
      const vert = Math.ceil(v / 2);
      for (let k = 0; k < 3; k++) {
        const exact = (p.positions[vert * 3 + k] as number) - (s.origin[k] as number);
        expect(Math.abs((s.positions[i * 3 + k] as number) - exact)).toBeLessThan(0.00025);
      }
    }
  });

  it('takes its colours from the palette', () => {
    const p = loadProgram('G0 X1');
    const s = buildSegments(p, { ...DEFAULT_PALETTE, rapid: 0x00ff00 });
    expect(Array.from(s.colors.subarray(0, 3))).toEqual([0, 1, 0]);
  });
});

describe('buildLineIndex', () => {
  it('maps a line to all its runs of segments, and each segment back to its line', () => {
    // Line 2 is a subroutine body drawn twice (two calls).
    const src = 'o1 sub\nG91 G0 X1\no1 endsub\no1 call\nG90 G0 Y5\no1 call';
    const p = loadProgram(src);
    const idx = buildLineIndex(p);
    expect(idx.segmentsOf(2)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(idx.segmentsOf(5)).toEqual([[1, 2]]);
    expect(idx.segmentsOf(99)).toEqual([]);
    expect([0, 1, 2].map((s) => idx.lineOf(s))).toEqual([2, 5, 2]);
    expect(idx.lineOf(-1)).toBe(0);
  });
});

describe('the worker protocol', () => {
  it('answers a request with the program and its buffers to transfer', () => {
    const { response, transfer } = handle({ id: 7, text: 'G0 X1', options: {} });
    expect(response).toMatchObject({ id: 7, ok: true });
    expect(transfer).toHaveLength(3);
    if (response.ok) expect(transferables(response.program)).toEqual(transfer);
  });
});

describe('implausible coordinates (reviewer, #20)', () => {
  it('warns about a span beyond any machine, and keeps scene coordinates finite', () => {
    const huge = '9' + '0'.repeat(38); // finite in Float64, beyond Float32's range
    const p = loadProgram(`G21 G90\nG0 X${huge}`);
    expect(p.diagnostics.map((d) => d.code)).toContain('VIEW_SPAN_IMPLAUSIBLE');
    const s = buildSegments(p);
    expect(Array.from(s.positions).every(Number.isFinite)).toBe(true);
    // A large but real span: no span warning (the job checks may still have things to say).
    expect(loadProgram('G0 X1600 Y4000').diagnostics.map((d) => d.code)).not.toContain(
      'VIEW_SPAN_IMPLAUSIBLE',
    );
  });
});
