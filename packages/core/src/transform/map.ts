// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * Transform operations, and the affine maps they are (parcel 4a, ADR-0033).
 *
 * Every op is a map of the XY plane (x' = a·x + b·y + tx, y' = c·x + d·y + ty) and
 * of Z (z' = sz·z + tz). Lengths in ops are MILLIMETRES; the transform converts them
 * to each line's units. Rotation is counter-clockwise seen from +Z, in degrees.
 */
export type TransformOp =
  | {
      readonly op: 'translate';
      readonly x?: number;
      readonly y?: number;
      readonly z?: number;
    }
  | {
      readonly op: 'rotate';
      readonly degrees: number;
      /** The point rotated about (mm). Default: the origin. */
      readonly about?: { readonly x: number; readonly y: number };
    }
  | {
      readonly op: 'mirror';
      /** 'x' negates X (reflects in a line parallel to Y), 'y' negates Y. */
      readonly axis: 'x' | 'y';
      /** The line mirrored in: X = about (axis 'x') or Y = about (axis 'y'), mm. */
      readonly about?: number;
    }
  | {
      readonly op: 'scale';
      /** Factor for X; Y defaults to the same (uniform in XY), Z to 1 (depths kept). */
      readonly x: number;
      readonly y?: number;
      readonly z?: number;
      /** The point scaled about (mm). Default: the origin. */
      readonly about?: { readonly x?: number; readonly y?: number; readonly z?: number };
    };

export interface AffineMap {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  /** Translation, mm. */
  readonly tx: number;
  readonly ty: number;
  readonly sz: number;
  /** Z translation, mm. */
  readonly tz: number;
  /**
   * The XY matrix is a signed permutation: each output axis takes exactly one input
   * axis (translate, mirror, rotations by multiples of 90°, and scales keep this with
   * other entries). Words then map one to one, and a line never needs a word it
   * doesn't have.
   */
  readonly axisAligned: boolean;
}

/** Why an op can't be applied, or null if it can. */
export function invalidOp(op: TransformOp): string | null {
  const finite = (...v: (number | undefined)[]) =>
    v.every((x) => x === undefined || Number.isFinite(x));
  switch (op.op) {
    case 'translate':
      return finite(op.x, op.y, op.z) ? null : 'a translation must be finite';
    case 'rotate':
      return finite(op.degrees, op.about?.x, op.about?.y) ? null : 'a rotation must be finite';
    case 'mirror':
      if (op.axis !== 'x' && op.axis !== 'y') return "a mirror's axis is 'x' or 'y'";
      return finite(op.about) ? null : 'a mirror line must be finite';
    case 'scale': {
      const f = [op.x, op.y ?? op.x, op.z ?? 1];
      if (!finite(...f, op.about?.x, op.about?.y, op.about?.z)) return 'a scale must be finite';
      if (f.some((v) => v <= 0))
        return 'scale factors must be positive (a negative factor is a mirror: use mirror)';
      return null;
    }
    default:
      return 'unknown operation';
  }
}

/** The op's affine map. Rotations by multiples of 90° use exact 0/±1 entries. */
export function mapOf(op: TransformOp): AffineMap {
  switch (op.op) {
    case 'translate':
      return {
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        tx: op.x ?? 0,
        ty: op.y ?? 0,
        sz: 1,
        tz: op.z ?? 0,
        axisAligned: true,
      };
    case 'rotate': {
      const deg = ((op.degrees % 360) + 360) % 360;
      const quarter = deg % 90 === 0;
      const r = (deg * Math.PI) / 180;
      const cos = quarter ? ([1, 0, -1, 0][deg / 90] ?? 1) : Math.cos(r);
      const sin = quarter ? ([0, 1, 0, -1][deg / 90] ?? 0) : Math.sin(r);
      const cx = op.about?.x ?? 0;
      const cy = op.about?.y ?? 0;
      return {
        a: cos,
        b: -sin,
        c: sin,
        d: cos,
        tx: cx - (cos * cx - sin * cy),
        ty: cy - (sin * cx + cos * cy),
        sz: 1,
        tz: 0,
        axisAligned: quarter,
      };
    }
    case 'mirror': {
      const p = op.about ?? 0;
      return op.axis === 'x'
        ? { a: -1, b: 0, c: 0, d: 1, tx: 2 * p, ty: 0, sz: 1, tz: 0, axisAligned: true }
        : { a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 2 * p, sz: 1, tz: 0, axisAligned: true };
    }
    case 'scale': {
      const sx = op.x;
      const sy = op.y ?? op.x;
      const sz = op.z ?? 1;
      const cx = op.about?.x ?? 0;
      const cy = op.about?.y ?? 0;
      const cz = op.about?.z ?? 0;
      return {
        a: sx,
        b: 0,
        c: 0,
        d: sy,
        tx: cx * (1 - sx),
        ty: cy * (1 - sy),
        sz,
        tz: cz * (1 - sz),
        axisAligned: true,
      };
    }
  }
}
