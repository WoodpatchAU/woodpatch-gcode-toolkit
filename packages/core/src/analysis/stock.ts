// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * Stock, and the moves that would crash into it (ADR-0054).
 *
 * The operator describes the stock on the table as shapes in the coordinates the path
 * is drawn in: positions as interpreted, which with no work offsets supplied are G54's
 * (the usual work zero). The stock is fixed to the table, so a G92 or G55 shift moves
 * the program, not the stock. Only boxes for now; the
 * shape type is a tagged union so cylinders, spheres and prisms can follow.
 *
 * `checkStock` flags RAPIDS that reach into stock. A feed move into stock is cutting,
 * which is the point, so it is never flagged. The tool is a vertical cylinder of the
 * given radius from its tip upwards: a rapid collides where, at some point along it,
 * the tip is below a box's top and the tool's circle overlaps the box's footprint.
 * Below a box's bottom counts too, since the shank above the tip would pass through
 * it. Touching is not a collision, so a bit parked against the stock stays quiet.
 *
 * Like the travel check, messages give numbers, the line and the shape's own name,
 * never program text.
 */

import type { Diagnostic } from '../syntax/types.js';
import type { Step } from '../interp/types.js';

/** A point or a size along X, Y and Z, in millimetres. */
export interface Xyz {
  readonly X: number;
  readonly Y: number;
  readonly Z: number;
}

/**
 * A rectangular block, square to the axes: placed by its lowest corner (minimum X, Y
 * and Z) and sized along X (length), Y (width) and Z (height).
 */
export interface StockBox {
  readonly kind: 'box';
  /** The caller's own handle for it (unique among the shapes passed together). */
  readonly id: string;
  /** Shown in messages. */
  readonly name: string;
  readonly min: Xyz;
  readonly size: Xyz;
}

/** A piece of stock. Boxes only for now. */
export type StockShape = StockBox;

export interface StockCheckOptions {
  /** The cutter's radius, mm. 0 (the default) checks the tool's centre line only. */
  readonly toolRadius?: number;
  /**
   * True when the steps were interpreted from where the machine really is when the
   * program starts (`interpret`'s `start` option). The program doesn't say, so by
   * default the first move's start is the interpreter's assumption, and only where
   * that move ENDS is checked.
   */
  readonly startKnown?: boolean;
  /** At most this many collisions are reported one by one; the rest are counted. */
  readonly maxReports?: number;
}

/** Rounding slack, so a move exactly touching stock never warns. */
const EPS = 1e-6;
const DEFAULT_MAX_REPORTS = 100;

const num = (v: number): string => String(Math.round(v * 1000) / 1000);
const finite = (p: Xyz): boolean =>
  Number.isFinite(p.X) && Number.isFinite(p.Y) && Number.isFinite(p.Z);

/**
 * What's wrong with a set of shapes, as messages (empty: fine). Every number must be
 * finite, every size above zero, and ids unique.
 */
export function validateStock(shapes: readonly StockShape[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  shapes.forEach((s, i) => {
    const label = `shape ${i + 1}${s?.name ? ` ("${s.name}")` : ''}`;
    if (!s || s.kind !== 'box') {
      problems.push(`${label}: only boxes are supported`);
      return;
    }
    if (typeof s.id !== 'string' || s.id === '') problems.push(`${label}: no id`);
    else if (ids.has(s.id)) problems.push(`${label}: the id "${s.id}" is used twice`);
    ids.add(s.id);
    if (!s.min || !finite(s.min)) problems.push(`${label}: its corner isn't three finite numbers`);
    if (!s.size || !finite(s.size)) problems.push(`${label}: its size isn't three finite numbers`);
    else if (!(s.size.X > 0 && s.size.Y > 0 && s.size.Z > 0)) {
      problems.push(`${label}: its length, width and height must all be above zero`);
    }
  });
  return problems;
}

/** Signed distance in XY from (x, y) to a box's footprint: negative inside. */
function footprintDistance(b: StockBox, x: number, y: number): number {
  const x0 = b.min.X;
  const x1 = b.min.X + b.size.X;
  const y0 = b.min.Y;
  const y1 = b.min.Y + b.size.Y;
  const dx = Math.max(x0 - x, 0, x - x1);
  const dy = Math.max(y0 - y, 0, y - y1);
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return -Math.min(x - x0, x1 - x, y - y0, y1 - y);
}

/**
 * How a straight move from `a` to `b` (mm) meets a box with a tool of radius
 * `r`: null if it doesn't, else the point of deepest overlap and the tip's Z there.
 */
export function rapidHitsBox(
  a: Xyz,
  b: Xyz,
  box: StockBox,
  r: number,
): { readonly at: Xyz; readonly overlap: number } | null {
  const top = box.min.Z + box.size.Z;
  // The part of the move where the tip is below the top: an interval of t.
  let lo = 0;
  let hi = 1;
  const dz = b.Z - a.Z;
  if (Math.abs(dz) < 1e-12) {
    if (!(a.Z < top - EPS)) return null;
  } else {
    const t = (top - EPS - a.Z) / dz; // where z(t) = top - EPS
    if (dz > 0) hi = Math.min(hi, t);
    else lo = Math.max(lo, t);
    if (lo > hi) return null;
  }
  const at = (t: number): Xyz => ({
    X: a.X + (b.X - a.X) * t,
    Y: a.Y + (b.Y - a.Y) * t,
    Z: a.Z + dz * t,
  });
  // The footprint's signed distance is convex, and so is it along a straight move:
  // a ternary search finds its minimum over [lo, hi] (plateaus included).
  const f = (t: number): number => {
    const p = at(t);
    return footprintDistance(box, p.X, p.Y);
  };
  let l = lo;
  let h = hi;
  for (let i = 0; i < 100 && h - l > 1e-12; i++) {
    const m1 = l + (h - l) / 3;
    const m2 = h - (h - l) / 3;
    if (f(m1) <= f(m2)) h = m2;
    else l = m1;
  }
  const best = (l + h) / 2;
  const d = Math.min(f(best), f(lo), f(hi));
  const tBest = d === f(lo) ? lo : d === f(hi) ? hi : best;
  const overlap = r - d; // how far the tool's circle reaches into the footprint
  if (!(overlap > EPS)) return null;
  return { at: at(tBest), overlap };
}

/**
 * One straight move or arc, as the stock check needs it: where it starts and ends and
 * whether it's a rapid. The first move in a sequence is the program's first motion.
 */
export interface StockMove {
  readonly rapid: boolean;
  readonly from: Xyz;
  readonly to: Xyz;
  readonly line: number;
  readonly file?: string;
}

/**
 * Checks a program's rapids (from `interpret`) against the stock. Returns one warning
 * per rapid that reaches into a shape (the first shape it meets, in the order given),
 * up to `maxReports`, then one more counting the rest. Throws on invalid shapes or
 * options: see `validateStock`.
 */
export function checkStock(
  steps: readonly Step[],
  shapes: readonly StockShape[],
  options: StockCheckOptions = {},
): Diagnostic[] {
  function* moves(): Generator<StockMove> {
    for (const s of steps) {
      if (s.kind === 'linear' || s.kind === 'arc') {
        yield {
          rapid: s.kind === 'linear' && s.rapid,
          from: s.from,
          to: s.to,
          line: s.line,
          ...(s.file !== undefined ? { file: s.file } : {}),
        };
      }
    }
  }
  return checkStockMoves(moves(), shapes, options);
}

/**
 * `checkStock` on moves from anywhere: a drawn path, say, where the interpreter's
 * steps aren't to hand. Arcs can be given as `rapid: false` moves (they never are
 * rapids); only the first move's position in the sequence matters for them.
 */
export function checkStockMoves(
  moves: Iterable<StockMove>,
  shapes: readonly StockShape[],
  options: StockCheckOptions = {},
): Diagnostic[] {
  const problems = validateStock(shapes);
  if (problems.length > 0) throw new TypeError(`checkStock: ${problems.join('; ')}`);
  const r = options.toolRadius ?? 0;
  if (!(Number.isFinite(r) && r >= 0)) {
    throw new TypeError('checkStock: toolRadius must be a finite number, 0 or more');
  }
  const max = options.maxReports ?? DEFAULT_MAX_REPORTS;
  const out: Diagnostic[] = [];
  if (shapes.length === 0) return out;
  let extra = 0;
  let first = true;
  for (const step of moves) {
    const isFirst = first;
    first = false;
    if (!step.rapid) continue;
    const to: Xyz = step.to;
    // The first move's start is the interpreter's assumption unless the caller says
    // it's real: otherwise only where it ends is a known place.
    const from: Xyz = isFirst && !options.startKnown ? to : step.from;
    for (const box of shapes) {
      const hit = rapidHitsBox(from, to, box, r);
      if (!hit) continue;
      if (out.length >= max) {
        extra++;
        break;
      }
      const top = box.min.Z + box.size.Z;
      const reach = r > 0 ? ` (tool radius ${num(r)})` : '';
      out.push({
        severity: 'warning',
        code: 'STOCK_RAPID_COLLISION',
        message: `a rapid reaches into the stock "${box.name}"${reach}: at X${num(hit.at.X)} Y${num(hit.at.Y)} the tip is at Z${num(hit.at.Z)}, ${num(top - hit.at.Z)} below its top (Z${num(top)})`,
        line: step.line,
        ...(step.file !== undefined ? { file: step.file } : {}),
      });
      break;
    }
  }
  if (extra > 0) {
    const last = out[out.length - 1] as Diagnostic;
    out.push({
      severity: 'warning',
      code: 'STOCK_RAPID_COLLISION_MORE',
      message: `and ${extra} more rapids reach into the stock`,
      line: last.line,
      ...(last.file !== undefined ? { file: last.file } : {}),
    });
  }
  return out;
}
