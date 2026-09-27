// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  formatLike,
  GENERIC,
  interpret,
  MASSO_G3,
  mapOf,
  parse,
  transformText,
  type Dialect,
  type TransformOp,
} from '../index.js';

// Parcel 4a (ADR-0033): translate, rotate, mirror, scale.

const t = (src: string, ops: TransformOp[], dialect: Dialect = GENERIC) =>
  transformText(src, ops, { dialect });
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);

describe('formatLike', () => {
  it('keeps the source decimals when exact, else at least the minimum', () => {
    expect(formatLike(10, '10', 3)).toBe('10');
    expect(formatLike(-10, '10', 3)).toBe('-10');
    expect(formatLike(10.25, '10', 3)).toBe('10.250');
    expect(formatLike(10.75, '10.5', 3)).toBe('10.750');
    expect(formatLike(1.2345678, '1.000000', 3)).toBe('1.234568');
    expect(formatLike(-0, '0.000', 3)).toBe('0.000');
    expect(formatLike(-0.0001, '0.000', 3)).toBe('0.000'); // no negative zero
    expect(formatLike(-0.5, '.5', 3)).toBe('-.5');
    expect(formatLike(3, '2.', 3)).toBe('3.');
    expect(formatLike(1.23456, '1', 4)).toBe('1.2346');
  });
});

describe('translate', () => {
  it('moves absolute coordinates and leaves incremental ones alone', () => {
    expect(t('G90 G1 X10 Y5 Z-1', [{ op: 'translate', x: 0.25, y: -5, z: 1 }]).text).toBe(
      'G90 G1 X10.250 Y0 Z0',
    );
    expect(t('G91 G1 X10 Y5', [{ op: 'translate', x: 3, y: 4 }]).text).toBe('G91 G1 X10 Y5');
  });

  it("works in the program's units: mm in the op, inches in the file", () => {
    expect(t('G20 G90 G0 X1 Y2.5', [{ op: 'translate', x: 25.4, y: 1 }]).text).toBe(
      'G20 G90 G0 X2 Y2.5394',
    );
  });

  it("touches nothing it needn't: comments, spacing, case, other lines", () => {
    const src = '%\n(header) N10 g1 x 5.0 y2 (keep)\r\nM30\n%';
    expect(t(src, [{ op: 'translate', x: 1 }]).text).toBe(
      '%\n(header) N10 g1 x 6.0 y2 (keep)\r\nM30\n%',
    );
  });
});

describe('rotate', () => {
  it('turns a quarter exactly: values move between X and Y, letters stay put', () => {
    expect(t('G90 G1 X10 Y5', [{ op: 'rotate', degrees: 90 }]).text).toBe('G90 G1 X-5 Y10');
    expect(t('G1 X 9.843750 Y 0.100000', [{ op: 'rotate', degrees: -90 }]).text).toBe(
      'G1 X 0.100000 Y -9.843750',
    );
    // A single-axis move stays single-axis: X feeds only Y'.
    expect(t('G90 G1 X10', [{ op: 'rotate', degrees: 90 }]).text).toBe('G90 G1 Y10');
  });

  it('rotates arc centres as vectors (G91.1) and keeps R', () => {
    expect(t('G17 G2 X10 Y0 I5 J0', [{ op: 'rotate', degrees: 90 }]).text).toBe(
      'G17 G2 X0 Y10 I0 J5',
    );
    expect(t('G2 X10 Y0 R5', [{ op: 'rotate', degrees: 180 }]).text).toBe('G2 X-10 Y0 R5');
  });

  it('rotates about a point', () => {
    expect(t('G0 X10 Y0', [{ op: 'rotate', degrees: 90, about: { x: 10, y: 0 } }]).text).toBe(
      'G0 X10 Y0',
    );
  });

  it('at any angle writes both X and Y, from the position it knows', () => {
    const r = t('G90 G0 X10 Y0\nG1 X20 F100', [{ op: 'rotate', degrees: 30 }]);
    expect(r.ok).toBe(true);
    // 10·sin 30° is 5 to within rounding: exact at Y0's decimals, so written Y5.
    expect(r.text).toBe('G90 G0 X8.660 Y5\nG1 X17.321 Y10 F100');
  });

  it('refuses a general rotation where the position is unknown, or behind control flow', () => {
    const r = t('G90 G1 X10 F100', [{ op: 'rotate', degrees: 30 }]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('TRANSFORM_UNKNOWN_POSITION');
    expect(r.text).toBe('G90 G1 X10 F100'); // unchanged
    const o = t('G0 X0 Y0\no100 sub\nG1 X1 F10\no100 endsub', [{ op: 'rotate', degrees: 30 }]);
    expect(codes(o)).toContain('TRANSFORM_CONTROL_FLOW');
  });

  it('refuses to turn an XZ/YZ-plane arc out of its plane', () => {
    expect(codes(t('G18 G2 X10 Z0 I5 K0', [{ op: 'rotate', degrees: 90 }]))).toContain(
      'TRANSFORM_PLANE_ARC',
    );
    expect(t('G18 G2 X10 Z0 I5 K0', [{ op: 'rotate', degrees: 180 }]).text).toBe(
      'G18 G3 X-10 Z0 I-5 K0',
    ); // X reversed in the ZX plane: the arc turns the other way
  });
});

describe('mirror', () => {
  it('negates the axis, flips arc direction and cutter compensation, and warns', () => {
    const r = t('G41 G2 X10 Y0 I5 J0', [{ op: 'mirror', axis: 'x' }]);
    expect(r.text).toBe('G42 G3 X-10 Y0 I-5 J0');
    expect(codes(r)).toContain('TRANSFORM_MIRROR_DIRECTION');
  });

  it('about a line, keeping leading zeros in G02', () => {
    expect(t('G02 X10 Y2 R3', [{ op: 'mirror', axis: 'y', about: 1 }]).text).toBe('G03 X10 Y0 R3');
  });

  it('flips an arc only in the planes the mirrored axis lies in', () => {
    expect(t('G19 G2 Y10 Z0 J5 K0', [{ op: 'mirror', axis: 'x' }]).text).toBe(
      'G19 G2 Y10 Z0 J5 K0',
    );
    expect(t('G19 G2 Y10 Z0 J5 K0', [{ op: 'mirror', axis: 'y' }]).text).toBe(
      'G19 G3 Y-10 Z0 J-5 K0',
    );
  });

  it('refuses a modal arc direction carried into a plane that needs the other handling', () => {
    // G2 set in XY (flipped by a Y mirror), then carried into YZ... also flipped there
    // (Y is in YZ): consistent. Into ZX (not flipped by a Y mirror): refused.
    const r = t('G17 G2 X1 Y1 I1 J0\nG18\nX2 Z1 I1 K0', [{ op: 'mirror', axis: 'y' }]);
    expect(codes(r)).toContain('TRANSFORM_ARC_DIRECTION_MODAL');
  });
});

describe('scale', () => {
  it('scales about a point; depths kept unless asked', () => {
    expect(t('G1 X10 Y4 Z-2', [{ op: 'scale', x: 2, about: { x: 5, y: 0 } }]).text).toBe(
      'G1 X15 Y8 Z-2',
    );
    expect(t('G1 X10 Y4 Z-2', [{ op: 'scale', x: 0.5, z: 0.5 }]).text).toBe('G1 X5 Y2 Z-1');
  });

  it('scales arcs evenly (R too), and refuses to make an ellipse', () => {
    expect(t('G2 X10 Y0 R5', [{ op: 'scale', x: 2 }]).text).toBe('G2 X20 Y0 R10');
    expect(codes(t('G2 X10 Y0 R5', [{ op: 'scale', x: 2, y: 1 }]))).toContain(
      'TRANSFORM_ARC_SCALE',
    );
    expect(t('G1 X10 Y10', [{ op: 'scale', x: 2, y: 1 }]).text).toBe('G1 X20 Y10');
  });

  it('refuses non-positive factors', () => {
    expect(codes(t('G1 X1', [{ op: 'scale', x: -1 }]))).toContain('TRANSFORM_BAD_OP');
  });
});

describe('what a transform leaves alone, and what stops it', () => {
  // ── Review of #33: each of these came back ok with a silently wrong toolpath ──

  it("fills an incremental move's missing axis with 0, not the absolute position", () => {
    const r = t('G90 G0 X10 Y20\nG91 G1 X5 F100', [{ op: 'rotate', degrees: 30 }]);
    expect(r.ok).toBe(true);
    // The vector (5, 0) rotated 30°: (4.330, 2.500). Not X-5.670 Y19.821.
    expect(r.text.split('\n')[1]).toBe('G91 G1 X4.330 Y2.500 F100');
  });

  it('carries rounding between incremental words: no drift over 10,000 steps', () => {
    const src = [
      'G21 G90 G0 X0 Y0',
      'G91 G1 F100',
      ...Array.from({ length: 10_000 }, () => 'G1 X0.1'),
    ];
    for (const op of [
      { op: 'rotate', degrees: 30 },
      { op: 'rotate', degrees: 10 },
      { op: 'scale', x: 1 / 3, z: 1 / 3 },
    ] as TransformOp[]) {
      const r = t(src.join('\n'), [op]);
      expect(r.ok).toBe(true);
      const steps = interpret(parse(r.text)).steps.filter((s) => s.kind === 'linear');
      const end = steps[steps.length - 1]?.to;
      const m = mapOf(op);
      // The exact end: (1000, 0) mapped as a vector from the origin (the start is 0,0).
      expect(Math.abs((end?.X ?? 0) - m.a * 1000)).toBeLessThan(0.001);
      expect(Math.abs((end?.Y ?? 0) - m.c * 1000)).toBeLessThan(0.001);
    }
  });

  it('refuses G10 L20 except on Masso, where L20 means something else', () => {
    expect(codes(t('G10 L20 P1 X0\nG1 X1', [{ op: 'translate', x: 1 }]))).toContain(
      'TRANSFORM_UNSUPPORTED_CODE',
    );
    expect(t('G10 L20 P1 X0\nG1 X1', [{ op: 'translate', x: 1 }], MASSO_G3).ok).toBe(true);
  });

  it.each([
    'G68 X0 Y0 R30',
    'G5 X1 Y1 I1 J0 P1 Q0',
    'G43.1 Z2',
    'G87 X1 Y1 Z-1 R1 I1 J1 K1',
    'G38.2 Z-10 F10',
  ])("refuses a code it doesn't model: %s", (line) => {
    const r = t(`G21 G90 G0 X0 Y0\n${line}\nG1 X1 F10`, [{ op: 'mirror', axis: 'x' }]);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain('TRANSFORM_UNSUPPORTED_CODE');
  });

  it('refuses control flow under every op, but not a bare program number', () => {
    const sub = 'G0 X0 Y0\no100 sub\nG91 G1 X1 F10\no100 endsub\no100 call';
    for (const op of [
      { op: 'rotate', degrees: 90 },
      { op: 'translate', x: 1 },
    ] as TransformOp[])
      expect(codes(t(sub, [op]))).toContain('TRANSFORM_CONTROL_FLOW');
    expect(
      codes(t('G0 X0 Y0\nM98 P100\nG1 X1 F10', [{ op: 'rotate', degrees: 90 }], MASSO_G3)),
    ).toContain('TRANSFORM_CONTROL_FLOW');
    expect(t('O1234\nG0 X1 Y1', [{ op: 'rotate', degrees: 90 }], MASSO_G3).ok).toBe(true);
  });

  it('refuses a move from a machine position the transform left as written', () => {
    // G53 X50 Y70 is untouched; G0 X30 alone would leave Y at the machine's 70.
    const r = t('G21 G90\nG53 G0 X50 Y70\nG0 X30\nG1 Z-1 F100', [{ op: 'rotate', degrees: 90 }]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'TRANSFORM_UNKNOWN_POSITION')?.line).toBe(3);
    // Re-commanding both axes absolutely is fine.
    expect(
      t('G21 G90\nG53 G0 X50 Y70\nG0 X30 Y5\nG1 Z-1 F100', [{ op: 'rotate', degrees: 90 }]).ok,
    ).toBe(true);
    // A Z-only retract taints only Z: an XY-only transform carries on.
    expect(
      t('G21 G90\nG0 X1 Y1\nG53 G0 Z0\nG0 X2 Y2\nG0 Z5', [{ op: 'rotate', degrees: 90 }]).ok,
    ).toBe(true);
    expect(t('G21 G90\nG0 X1 Y1\nG28 G91 Z0\nG90 G0 X2 Y2', [{ op: 'mirror', axis: 'x' }]).ok).toBe(
      true,
    );
  });

  it('leaves G28/G30 as written: a quarter turn must not home a different axis', () => {
    const r = t('G21 G90 G0 X1 Y1\nG28 G91 X0\nG90 G0 X2 Y2', [{ op: 'rotate', degrees: 90 }]);
    expect(r.ok).toBe(true);
    expect(r.text.split('\n')[1]).toBe('G28 G91 X0');
    expect(codes(r)).toContain('TRANSFORM_HOME');
  });

  it('refuses ops with missing, misspelt or extra fields', () => {
    for (const op of [
      { op: 'rotate', deg: 90 },
      { op: 'rotate', degrees: 90, about: { x: 1 } },
      { op: 'translate', x: 1, w: 2 },
      { op: 'scale' },
      { op: 'mirror', axis: 'z' },
      { op: 'spin', degrees: 90 },
    ])
      expect(codes(t('G1 X1', [op as unknown as TransformOp]))).toContain('TRANSFORM_BAD_OP');
  });

  it('refuses expressions and parameters in words it would change', () => {
    const r = t('#1=5\nG1 X[#1+2] Y3', [{ op: 'rotate', degrees: 90 }]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'TRANSFORM_EXPRESSION')?.line).toBe(2);
    // …but not in words it wouldn't: a translation along X leaves Y[...] alone.
    expect(t('G1 X1 Y[#1]', [{ op: 'translate', x: 1 }]).text).toBe('G1 X2 Y[#1]');
  });

  it('refuses G92 and G52, leaves G53 and G10 alone with warnings', () => {
    expect(codes(t('G92 X0\nG1 X1', [{ op: 'translate', x: 1 }]))).toContain('TRANSFORM_OFFSET');
    expect(codes(t('G52 X10\nG1 X1', [{ op: 'translate', x: 1 }]))).toContain('TRANSFORM_OFFSET');
    const r = t('G53 G0 X0 Y0\nG10 L2 P1 X5\nG1 X1 Y1', [{ op: 'translate', x: 1 }]);
    expect(r.text).toBe('G53 G0 X0 Y0\nG10 L2 P1 X5\nG1 X2 Y1');
    expect(codes(r)).toEqual(expect.arrayContaining(['TRANSFORM_G53', 'TRANSFORM_G10']));
  });

  it("knows Masso's K is a cycle repeat count, not a coordinate", () => {
    expect(t('G90 G81 X10 Y10 Z-2 R1 K3', [{ op: 'translate', x: 1, z: -1 }], MASSO_G3).text).toBe(
      'G90 G81 X11 Y10 Z-3 R0 K3',
    );
  });
});
