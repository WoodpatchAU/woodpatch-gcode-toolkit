// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * Arc resolution and validation (parcel 2d, ADR-0022), transcribed from LinuxCNC's
 * interpreter: `arc_data_ijk`, `arc_data_r` (interp_arc.cc) and `find_turn`
 * (interp_find.cc). Pure functions on the two in-plane coordinates, so each rule can
 * be checked against the source directly.
 *
 * "a" and "b" are the plane's first and second axes in LinuxCNC's order: XY for G17,
 * ZX for G18, YZ for G19. A positive sweep turns from a towards b (counter-clockwise
 * seen from the positive normal axis).
 */

/** How far an arc's geometry may be off before it's an error. Per controller. */
export interface ArcTolerance {
  /**
   * Centre format: how much the radius to the end may differ from the radius to the
   * start (LinuxCNC `center_arc_radius_tolerance`, in program units). Always an error
   * above 100x this; above 1x it's an error only if the relative difference exceeds
   * `spiralRelative` too.
   */
  readonly spiralMm: number;
  readonly spiralInch: number;
  /** LinuxCNC SPIRAL_RELATIVE_TOLERANCE. */
  readonly spiralRelative: number;
  /**
   * The minimum radius, and how far short an R-format radius may fall of reaching
   * the end point (LinuxCNC RADIUS_TOLERANCE_*).
   */
  readonly radiusMm: number;
  readonly radiusInch: number;
  /**
   * What a mismatch beyond the tolerance is. `error` (default): the line is refused.
   * `warn`: the controller's real limit is unmeasured, so an arc between the tolerance
   * and 100x it is drawn, with a warning (Masso, parcel 2e-2). Beyond 100x it's still
   * refused.
   */
  readonly beyond?: 'error' | 'warn';
}

/** LinuxCNC's defaults (interp_internal.hh). */
export const LINUXCNC_ARC_TOLERANCE: ArcTolerance = Object.freeze({
  spiralMm: 2 * 0.01 * Math.SQRT2,
  spiralInch: 2 * 0.001 * Math.SQRT2,
  spiralRelative: 0.001,
  radiusMm: 0.00005 * 25.4,
  radiusInch: 0.00005,
});

export interface ArcGeometry {
  /** Centre, in the plane's two axes. */
  readonly ca: number;
  readonly cb: number;
  /** Radius at the start. */
  readonly radius: number;
  /** Radius at the end: differs from `radius` for a (tolerated) spiral. */
  readonly endRadius: number;
  /** Signed sweep in radians, positive counter-clockwise; includes full turns. */
  readonly sweep: number;
}

export type ArcResult =
  | {
      readonly ok: true;
      readonly arc: ArcGeometry;
      /** Set when the arc is beyond a tolerance whose real limit is unmeasured. */
      readonly warning?: { readonly code: string; readonly message: string };
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

const TAU = 2 * Math.PI;
/** LinuxCNC TINY, for the semicircle allowance in arc_data_r. */
const TINY = 1e-12;

/**
 * The signed angle from start to end around the centre, for `turns` turns in the
 * given direction (LinuxCNC find_turn). With start and end at the same angle, a turn
 * is a full circle. LinuxCNC uses this for arc LENGTH and inverse time only; the path
 * the machine cuts follows {@link motionSweep}.
 */
export function findTurn(
  a1: number,
  b1: number,
  ca: number,
  cb: number,
  clockwise: boolean,
  turns: number,
  a2: number,
  b2: number,
): number {
  let alpha = Math.atan2(b1 - cb, a1 - ca);
  let beta = Math.atan2(b2 - cb, a2 - ca);
  if (!clockwise) {
    if (beta <= alpha) beta += TAU;
    return beta - alpha + (turns - 1) * TAU;
  }
  if (alpha <= beta) alpha += TAU;
  return beta - alpha - (turns - 1) * TAU;
}

/** posemath.h CART_FUZZ: below this, LinuxCNC's motion treats lengths as equal. */
const CART_FUZZ = 1e-8;
/** posemath.h CIRCLE_FUZZ: pmCircleInit's floor for a zero angle. */
const CIRCLE_FUZZ = 1e-6;

/**
 * The signed sweep the MACHINE cuts: LinuxCNC 2.9's motion planner, pmCircleInit
 * (_posemath.c), not the interpreter's find_turn (reviewer, toolkit #14). find_turn
 * only feeds arc length and inverse time; the path cut comes from pmCircleInit, and
 * the two disagree in one important case. pmCircleInit makes it a FULL circle when the
 * start and end, projected onto the plane, are within CART_FUZZ (1e-8), as after a
 * run of incremental moves that returns to the start with rounding noise. find_turn
 * would compare the angles exactly and give a sweep of zero or 2π by the noise's sign.
 *
 * Transcribed in plane coordinates: rTan = start - centre; rEnd = (end - centre)
 * scaled to the start radius; the angle is acos(rTan·rEnd / r²) (computed as the
 * equivalent, better-conditioned atan2), taken the long way
 * round when (rTan × rEnd)·normal < CART_FUZZ; the normal points along +normal axis
 * for G3 and is reversed for G2; extra turns add 2π each.
 */
export function motionSweep(
  a1: number,
  b1: number,
  ca: number,
  cb: number,
  clockwise: boolean,
  turns: number,
  a2: number,
  b2: number,
): number {
  const ta = a1 - ca;
  const tb = b1 - cb;
  const r = Math.hypot(ta, tb);
  const ea0 = a2 - ca;
  const eb0 = b2 - cb;
  const len = Math.hypot(ea0, eb0);
  const ea = len > 0 ? (ea0 * r) / len : 0;
  const eb = len > 0 ? (eb0 * r) / len : 0;
  const dot = ta * ea + tb * eb;
  const cross = ta * eb - tb * ea;
  // pmCircleInit takes acos(dot / r²), in 0..π. atan2(|cross|, dot) is the same angle,
  // but stays accurate for tiny angles: for a 10 mm chord at radius 1e14 the acos
  // argument rounds to exactly 1, the angle to 0, and CIRCLE_FUZZ would then turn it
  // into a 50 km arc. The fuzz rules below are pmCircleInit's, unchanged.
  let angle = Math.atan2(Math.abs(cross), dot);
  const s = clockwise ? -1 : 1;
  if (s * cross < CART_FUZZ) angle = TAU - angle;
  // LinuxCNC issues #1528/#2169: endpoints that (nearly) coincide in the plane are a full circle.
  if (Math.hypot(a2 - a1, b2 - b1) < CART_FUZZ) angle = TAU;
  angle += (turns - 1) * TAU;
  if (angle === 0) angle = CIRCLE_FUZZ / 2;
  return s * angle;
}

const finite = (...v: number[]) => v.every((x) => Number.isFinite(x));
const NOT_FINITE: ArcResult = {
  ok: false,
  code: 'SEMANTIC_ARC_NOT_FINITE',
  message:
    'An arc value is too large to be a number (e.g. an overflow in unit conversion); line not run',
};

/**
 * Tolerances are in program units in LinuxCNC; these values are in mm. `scale` is
 * 25.4 for an inch program and 1 for mm, so the inch tolerances apply to inch programs.
 */
function tolerances(t: ArcTolerance, inch: boolean) {
  return inch
    ? { spiral: t.spiralInch * 25.4, radius: t.radiusInch * 25.4 }
    : { spiral: t.spiralMm, radius: t.radiusMm };
}

/** Centre format (I/J/K), with the centre already resolved (LinuxCNC arc_data_ijk). */
export function arcFromCentre(
  a1: number,
  b1: number,
  a2: number,
  b2: number,
  ca: number,
  cb: number,
  clockwise: boolean,
  turns: number,
  tol: ArcTolerance,
  inch: boolean,
): ArcResult {
  const t = tolerances(tol, inch);
  if (!finite(a1, b1, a2, b2, ca, cb)) return NOT_FINITE;
  const radius = Math.hypot(ca - a1, cb - b1);
  const endRadius = Math.hypot(ca - a2, cb - b2);
  if (!finite(radius, endRadius)) return NOT_FINITE;
  // Written fail-closed (reviewer, toolkit #14): a NaN makes every comparison false,
  // so each check asks "is it within?" and refuses otherwise.
  if (!(radius >= t.radius) || !(endRadius >= t.radius)) {
    return {
      ok: false,
      code: 'SEMANTIC_ARC_ZERO_RADIUS',
      message: 'Zero-radius arc: the centre is on the start or end point; line not run',
    };
  }
  const absErr = Math.abs(radius - endRadius);
  const relErr = absErr / Math.max(radius, endRadius);
  const sweep = motionSweep(a1, b1, ca, cb, clockwise, turns, a2, b2);
  if (!(absErr <= t.spiral * 100) || (!(relErr <= tol.spiralRelative) && !(absErr <= t.spiral))) {
    const f = (v: number) => (inch ? v / 25.4 : v).toFixed(4);
    // The warning band covers only the untested range, up to the 100x gross limit.
    // Beyond that the mismatch is almost certainly a mistyped I/J, which the machine
    // would refuse too, so it's refused here (reviewer, toolkit #17).
    if (tol.beyond === 'warn' && absErr <= t.spiral * 100) {
      return {
        ok: true,
        arc: { ca, cb, radius, endRadius, sweep },
        warning: {
          code: 'SEMANTIC_ARC_RADIUS_MISMATCH_UNTESTED',
          message: `Radius to the end of the arc (${f(endRadius)}) differs from the radius to the start (${f(radius)}) by more than this controller is known to accept; it may refuse the line`,
        },
      };
    }
    return {
      ok: false,
      code: 'SEMANTIC_ARC_RADIUS_MISMATCH',
      message: `Radius to the end of the arc (${f(endRadius)}) differs from the radius to the start (${f(radius)}) by more than this controller allows; line not run`,
    };
  }
  return {
    ok: true,
    arc: { ca, cb, radius, endRadius, sweep },
  };
}

/**
 * Radius format (R), LinuxCNC arc_data_r: the centre is on the perpendicular bisector
 * of the chord. A negative R takes the arc larger than a semicircle.
 */
export function arcFromRadius(
  a1: number,
  b1: number,
  a2: number,
  b2: number,
  r: number,
  clockwise: boolean,
  turns: number,
  tol: ArcTolerance,
  inch: boolean,
): ArcResult {
  const t = tolerances(tol, inch);
  if (!finite(a1, b1, a2, b2, r)) return NOT_FINITE;
  if (a1 === a2 && b1 === b2) {
    return {
      ok: false,
      code: 'SEMANTIC_ARC_R_SAME_POINT',
      message:
        'A radius-format arc cannot end where it starts (the centre is undefined); line not run',
    };
  }
  const absR = Math.abs(r);
  // R0 (or below the radius tolerance): LinuxCNC computes asin(0/0) and moves on a NaN
  // arc; refusing it keeps "no silent NaN" true (reviewer, toolkit #14).
  if (!(absR >= t.radius)) {
    return {
      ok: false,
      code: 'SEMANTIC_ARC_ZERO_RADIUS',
      message: 'Zero-radius arc (R is 0, or too small to be a radius); line not run',
    };
  }
  const midA = (a1 + a2) / 2;
  const midB = (b1 + b2) / 2;
  let half = Math.hypot(midA - a2, midB - b2);
  if (!(half - absR <= t.radius)) {
    // R2: upstream computed a NaN centre and drew nothing, silently.
    return {
      ok: false,
      code: 'SEMANTIC_ARC_R_TOO_SMALL',
      message: `Arc radius ${(inch ? absR / 25.4 : absR).toFixed(4)} is too small to reach the end point; line not run`,
    };
  }
  if (half / absR > 1 - TINY) half = absR; // allow a small error for a semicircle
  const toward = Math.atan2(b2 - b1, a2 - a1);
  const theta =
    (clockwise && r > 0) || (!clockwise && r < 0) ? toward - Math.PI / 2 : toward + Math.PI / 2;
  const offset = absR * Math.cos(Math.asin(half / absR));
  const ca = midA + offset * Math.cos(theta);
  const cb = midB + offset * Math.sin(theta);
  const radius = Math.hypot(ca - a1, cb - b1);
  const endRadius = Math.hypot(ca - a2, cb - b2);
  if (!finite(ca, cb, radius, endRadius)) return NOT_FINITE;
  return {
    ok: true,
    arc: {
      ca,
      cb,
      radius,
      endRadius,
      sweep: motionSweep(a1, b1, ca, cb, clockwise, turns, a2, b2),
    },
  };
}
