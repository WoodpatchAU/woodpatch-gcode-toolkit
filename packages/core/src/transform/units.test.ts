// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { GENERIC, interpret, MASSO_G3, parse, transformText, type Dialect } from '../index.js';

// Parcel 4b (ADR-0034): units conversion. Operator decisions, 2026-09-28: inches get
// at least 5 decimals; a program that states no units is read in the user's preference.

const u = (src: string, to: 'mm' | 'inch', assume?: 'mm' | 'inch', dialect: Dialect = GENERIC) =>
  transformText(src, [{ op: 'units', to, ...(assume ? { assume } : {}) }], { dialect });
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe('units', () => {
  it('converts lengths and feeds, and the units word, keeping exact values short', () => {
    const r = u('G21 G90\nG1 X25.4 Y12.7 Z-1 F254\nG2 X50.8 Y0 R12.7', 'inch');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('G20 G90\nG1 X1.0 Y0.5 Z-0.03937 F10\nG2 X2.0 Y0 R0.5');
    expect(r.diagnostics.find((d) => d.code === 'TRANSFORM_UNITS_CONVERTED')?.message).toContain(
      'from millimetres to inches',
    );
  });

  it('writes inches to 5 decimals, so mm → inch → mm lands within a micrometre', () => {
    const inch = u('G21 G90\nG1 X12.345 F100', 'inch');
    expect(inch.text).toBe('G20 G90\nG1 X0.48602 F3.93701');
    const back = u(inch.text, 'mm');
    // Back within a micrometre; a converted value keeps one decimal where its source had a point.
    expect(back.text).toBe('G21 G90\nG1 X12.345 F100.0');
  });

  it('leaves what is not a length alone: dwell, turns, speeds, tools, Masso repeats', () => {
    expect(u('G21\nG4 P2\nS12000 M3 T2\nG2 X10 I5 P2 F100', 'inch').text).toBe(
      'G20\nG4 P2\nS12000 M3 T2\nG2 X0.3937 I0.19685 P2 F3.93701',
    );
    expect(u('G21 G90\nG81 X10 Y10 Z-2 R1 Q0.5 K3 F100', 'inch', undefined, MASSO_G3).text).toBe(
      'G20 G90\nG81 X0.3937 Y0.3937 Z-0.07874 R0.03937 Q0.01969 K3 F3.93701',
    );
    expect(u('G21\nG64 P0.254', 'inch').text).toBe('G20\nG64 P0.01');
    // Inverse-time feed is a rate, not a length.
    expect(u('G21 G93\nG1 X25.4 F2', 'inch').text).toBe('G20 G93\nG1 X1.0 F2');
  });

  it('converts machine positions, offsets and homes: the controller reads them in program units', () => {
    expect(u('G21\nG53 G0 Z-25.4\nG10 L2 P1 X254\nG28 G91 Z0', 'inch').text).toBe(
      'G20\nG53 G0 Z-1.0\nG10 L2 P1 X10\nG28 G91 Z0',
    );
  });

  it('converts each line from its own units, so a mixed program comes out in one', () => {
    expect(u('G21 G1 X25.4 F100\nG20 G1 X2', 'mm').text).toBe('G21 G1 X25.4 F100\nG21 G1 X50.8');
  });

  it('reads a program that states no units in the preference, says so, and states them', () => {
    const r = u('(part)\nG90 G1 X1 F10', 'mm', 'inch');
    expect(r.text).toBe('(part)\nG21 G90 G1 X25.4 F254');
    expect(r.diagnostics.find((d) => d.code === 'TRANSFORM_UNITS_ASSUMED')?.line).toBe(2);
    expect(codes(r)).toContain('TRANSFORM_UNITS_CONVERTED');
  });

  it('reports a program already in the target units, unchanged', () => {
    const r = u('G21 G1 X1 F100', 'mm');
    expect(r.text).toBe('G21 G1 X1 F100');
    expect(codes(r)).toContain('TRANSFORM_UNITS_ALREADY');
  });

  it("refuses what it can't convert faithfully", () => {
    expect(codes(u('G21\nG68 X0 Y0 R30', 'inch', undefined, MASSO_G3))).toContain(
      'TRANSFORM_UNSUPPORTED_CODE',
    );
    expect(codes(u('G21\nM98 P100', 'inch', undefined, MASSO_G3))).toContain(
      'TRANSFORM_CONTROL_FLOW',
    );
    expect(codes(u('G21\n#1=5\nG1 X[#1*2] F10', 'inch'))).toContain('TRANSFORM_EXPRESSION');
    expect(codes(u('G21\no100 sub\nG1 X1\no100 endsub\nG20\no100 call', 'mm'))).toContain(
      'TRANSFORM_CONTROL_FLOW',
    );
    // An O-word program that stays in one unit converts: each word is the same wherever it runs.
    expect(u('G21\no100 sub\nG1 X25.4 F100\no100 endsub\no100 call', 'inch').ok).toBe(true);
  });
});

describe('the units preference in the interpreter', () => {
  it('reads a program that states no units in the preference, and warns', () => {
    const r = interpret(parse('G90 G1 X1 F10'), { units: 'inch' });
    const move = r.steps.find((s) => s.kind === 'linear');
    expect(move?.kind === 'linear' && move.to.X).toBeCloseTo(25.4, 9);
    expect(r.diagnostics.find((d) => d.code === 'SEMANTIC_UNITS_ASSUMED')?.line).toBe(1);
  });

  it('says nothing when the program states its units, or no preference is given', () => {
    expect(
      interpret(parse('G21 G1 X1 F10'), { units: 'inch' }).diagnostics.map((d) => d.code),
    ).not.toContain('SEMANTIC_UNITS_ASSUMED');
    expect(interpret(parse('G1 X1 F10')).diagnostics.map((d) => d.code)).not.toContain(
      'SEMANTIC_UNITS_ASSUMED',
    );
  });
});
