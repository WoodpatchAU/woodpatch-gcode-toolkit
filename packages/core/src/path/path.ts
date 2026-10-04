// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Plane, Step } from '../interp/types.js';

/**
 * The path model (parcel 2d, plan §4.2 items 5 and 8, ADR-0022): the interpreter's
 * steps turned into what a viewer and an estimator need.
 *
 * - {@link tessellate}: the whole toolpath as ONE polyline in typed arrays. Every move
 *   starts where the previous one ended (a line that can't run doesn't move the tool),
 *   so the path is continuous by construction. Arcs are split into chords no further
 *   than `chordTolerance` from the true arc (default 1 µm, as upstream).
 * - {@link pathBounds}: the exact bounding box, from the true arc geometry, not from
 *   the chords.
 *
 * Positions are machine coordinates in mm (X, Y, Z). Rotary axes are not drawn.
 */

export interface PathOptions {
  /** Maximum distance from a chord to its arc, in mm. Default 0.001 (1 µm). */
  readonly chordTolerance?: number;
  /**
   * The vertex budget, counted before anything is allocated: about 29 bytes per
   * vertex, so the default 2,000,000 is about 58 MB. Over it, arcs are coarsened
   * together to fit; only a program with more moves than the budget is truncated.
   */
  readonly maxVertices?: number;
  /**
   * Chords for any one arc: `G2 I-5 P126000` would otherwise need about 20 million
   * (reviewer, toolkit #14). Over it the arc is coarsened. Default 100,000.
   */
  readonly maxChordsPerArc?: number;
}

/** Vertex kinds, for colouring. */
export const VERTEX_RAPID = 0;
export const VERTEX_FEED = 1;
export const VERTEX_ARC = 2;

export interface PathBuffers {
  /** Number of vertices. Vertex 0 is the start position; each later vertex ends a chord. */
  readonly count: number;
  /** x, y, z per vertex (machine coordinates, mm). */
  readonly positions: Float64Array;
  /** For each vertex after the first: the index into `steps` of the move it belongs to. */
  readonly step: Uint32Array;
  /** For each vertex after the first: VERTEX_RAPID, VERTEX_FEED or VERTEX_ARC. */
  readonly kind: Uint8Array;
  /**
   * True if some arcs have fewer chords than the tolerance needs, because of
   * `maxChordsPerArc` or the vertex budget. They're still drawn, just coarser.
   */
  readonly coarsened: boolean;
  /** True if the program has more moves than `maxVertices`, so the path was cut short. */
  readonly truncated: boolean;
}

export interface Box {
  readonly min: { readonly X: number; readonly Y: number; readonly Z: number };
  readonly max: { readonly X: number; readonly Y: number; readonly Z: number };
}

export interface PathBounds {
  /** Every move. Null if nothing moved. */
  readonly all: Box | null;
  /** Feed moves and arcs only: where the tool cuts (or could). */
  readonly feed: Box | null;
  /** Rapids only. */
  readonly rapid: Box | null;
}

type Arc = Extract<Step, { kind: 'arc' }>;
type Axis3 = 'X' | 'Y' | 'Z';

/** The plane's two axes (LinuxCNC order) and its normal. */
const PLANES: Readonly<Record<Plane, readonly [Axis3, Axis3, Axis3]>> = {
  XY: ['X', 'Y', 'Z'],
  ZX: ['Z', 'X', 'Y'],
  YZ: ['Y', 'Z', 'X'],
};
const HALF_PI = Math.PI / 2;

/**
 * Chords for an arc: enough that none strays more than `tol` from it, but at most
 * `cap`. A chord subtending angle a is r(1 - cos(a/2)) = 2r sin²(a/4) from the arc at
 * most, so a ≤ 4 asin(√(tol / 2r)). That form stays accurate at huge radii, where
 * 2 acos(1 - tol/r) rounds to 0 and the count became infinite (reviewer, toolkit #14).
 */
export function arcChords(arc: Arc, tol: number, cap = 100_000): number {
  return Math.min(chordsNeeded(arc, tol), cap);
}

/** The uncapped chord count for the tolerance (at least 1; Infinity if unbounded). */
export function chordsNeeded(arc: Arc, tol: number): number {
  const r = Math.max(arc.radius, arc.endRadius);
  const sweep = Math.abs(arc.sweep);
  if (!(r > 0) || !(sweep > 0)) return 1;
  const x = tol / (2 * r);
  const maxAngle = x >= 0.5 ? Math.PI : 4 * Math.asin(Math.sqrt(x));
  const n = Math.ceil(sweep / maxAngle);
  return Number.isNaN(n) ? Infinity : Math.max(1, n);
}

/** The plane's axes as indices into an (x, y, z) triple: first, second, normal. */
const PLANE_INDEX: Readonly<Record<Plane, readonly [number, number, number]>> = {
  XY: [0, 1, 2],
  ZX: [2, 0, 1],
  YZ: [1, 2, 0],
};

/** The angle of an arc's start point about its centre, in its plane. */
export function startAngle(arc: Arc): number {
  const [a, b] = PLANES[arc.plane];
  return Math.atan2(arc.from[b] - arc.centre[b], arc.from[a] - arc.centre[a]);
}

/**
 * Writes the point at fraction t of an arc's sweep into out[at..at+2] as x, y, z.
 * The radius and the normal axis change evenly with t (spiral, helix).
 */
export function arcPoint(arc: Arc, start: number, t: number, out: Float64Array, at: number): void {
  const [a, b, n] = PLANES[arc.plane];
  const [ia, ib, inorm] = PLANE_INDEX[arc.plane];
  const angle = start + arc.sweep * t;
  const r = arc.radius + (arc.endRadius - arc.radius) * t;
  out[at + ia] = arc.centre[a] + r * Math.cos(angle);
  out[at + ib] = arc.centre[b] + r * Math.sin(angle);
  out[at + inorm] = arc.from[n] + (arc.to[n] - arc.from[n]) * t;
}

/** The toolpath as one polyline in typed arrays. */
export function tessellate(steps: readonly Step[], options: PathOptions = {}): PathBuffers {
  const tol = options.chordTolerance ?? 0.001;
  const budget = options.maxVertices ?? 2_000_000;
  const perArc = options.maxChordsPerArc ?? 100_000;
  if (!(tol > 0)) throw new RangeError('chordTolerance must be positive');

  // Pass 1: count, so nothing is allocated before the total is known.
  const chords = new Uint32Array(steps.length);
  let straight = 0;
  let arcs = 0;
  let arcChordTotal = 0;
  let coarsened = false;
  let first: Extract<Step, { kind: 'linear' | 'arc' }> | undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] as Step;
    if (s.kind === 'linear') {
      first ??= s;
      straight++;
      chords[i] = 1;
    } else if (s.kind === 'arc') {
      first ??= s;
      arcs++;
      const needed = chordsNeeded(s, tol);
      if (needed > perArc) coarsened = true;
      const n = Math.min(needed, perArc);
      chords[i] = n;
      arcChordTotal += n;
    }
  }
  // Over budget: coarsen the arcs together (each keeps at least one chord) rather
  // than drop the end of the program. Only more MOVES than the budget truncates.
  let truncated = false;
  if (1 + straight + arcChordTotal > budget) {
    const room = budget - 1 - straight;
    if (arcs > 0 && room >= arcs) {
      const factor = room / arcChordTotal;
      for (let i = 0; i < steps.length; i++) {
        if ((steps[i] as Step).kind === 'arc')
          chords[i] = Math.max(1, Math.floor((chords[i] as number) * factor));
      }
      coarsened = true;
    } else truncated = true;
  }
  let count = 1;
  for (let i = 0; i < steps.length; i++) {
    const n = chords[i] as number;
    if (n === 0) continue;
    if (count + n > budget) {
      truncated = true;
      break;
    }
    count += n;
  }
  const positions = new Float64Array(count * 3);
  const step = new Uint32Array(count);
  const kind = new Uint8Array(count);
  if (first) {
    positions[0] = first.from.X;
    positions[1] = first.from.Y;
    positions[2] = first.from.Z;
  }

  // Pass 2: fill.
  let v = 1;
  for (let i = 0; i < steps.length && v < count; i++) {
    const s = steps[i] as Step;
    if (s.kind === 'linear') {
      positions[v * 3] = s.to.X;
      positions[v * 3 + 1] = s.to.Y;
      positions[v * 3 + 2] = s.to.Z;
      step[v] = i;
      kind[v] = s.rapid ? VERTEX_RAPID : VERTEX_FEED;
      v++;
    } else if (s.kind === 'arc') {
      const n = chords[i] as number;
      const start = startAngle(s);
      for (let k = 1; k <= n && v < count; k++) {
        if (k === n) {
          // End exactly where the interpreter says, with no accumulated rounding.
          positions[v * 3] = s.to.X;
          positions[v * 3 + 1] = s.to.Y;
          positions[v * 3 + 2] = s.to.Z;
        } else arcPoint(s, start, k / n, positions, v * 3);
        step[v] = i;
        kind[v] = VERTEX_ARC;
        v++;
      }
    }
  }
  return { count, positions, step, kind, coarsened, truncated };
}

class BoxBuilder {
  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;

  add(x: number, y: number, z: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
  }

  box(): Box | null {
    if (this.minX === Infinity) return null;
    return {
      min: { X: this.minX, Y: this.minY, Z: this.minZ },
      max: { X: this.maxX, Y: this.maxY, Z: this.maxZ },
    };
  }
}

/**
 * The fractions t in [0, 1] of an arc's sweep at which it points along a cardinal
 * direction of its plane (+a, +b, -a, -b): the candidates for its extremes. For each
 * direction, only the first and last occurrence matter: the radius changes evenly with
 * t, so between them the arc reaches no further. That keeps an arc of many turns
 * (P) cheap. For a spiral the true extreme is a hair off the cardinal angle; the
 * error is about (radius change per radian)² / 2r, well under 1 µm at any tolerance a
 * controller accepts.
 */
export function cardinalFractions(start: number, sweep: number): number[] {
  const out: number[] = [];
  if (sweep === 0) return out;
  const dir = Math.sign(sweep);
  const total = Math.abs(sweep);
  for (let c = 0; c < 4; c++) {
    const target = c * HALF_PI;
    // Angle to travel (in the arc's direction) from start to the first occurrence.
    let d = dir > 0 ? target - start : start - target;
    d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (d > total) continue;
    out.push(d / total);
    const lastD = d + Math.floor((total - d) / (2 * Math.PI)) * 2 * Math.PI;
    if (lastD !== d) out.push(lastD / total);
  }
  return out;
}

/** The exact bounding box of the moves, overall and split by feed and rapid. */
export function pathBounds(steps: readonly Step[]): PathBounds {
  const all = new BoxBuilder();
  const feed = new BoxBuilder();
  const rapid = new BoxBuilder();
  const point = new Float64Array(3);
  for (const s of steps) {
    if (s.kind === 'linear') {
      const b = s.rapid ? rapid : feed;
      for (const p of [s.from, s.to]) {
        all.add(p.X, p.Y, p.Z);
        b.add(p.X, p.Y, p.Z);
      }
    } else if (s.kind === 'arc') {
      const start = startAngle(s);
      for (const p of [s.from, s.to]) {
        all.add(p.X, p.Y, p.Z);
        feed.add(p.X, p.Y, p.Z);
      }
      for (const t of cardinalFractions(start, s.sweep)) {
        arcPoint(s, start, t, point, 0);
        all.add(point[0] as number, point[1] as number, point[2] as number);
        feed.add(point[0] as number, point[1] as number, point[2] as number);
      }
    }
  }
  return { all: all.box(), feed: feed.box(), rapid: rapid.box() };
}
