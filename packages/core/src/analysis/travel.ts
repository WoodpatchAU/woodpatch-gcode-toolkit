// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The travel check (ADR-0041): does a program stay inside the machine's travel?
 *
 * A preview doesn't know the work offsets the operator will set, the tool lengths or
 * the cutter radii, so it says only what is CERTAIN, whatever those turn out to be.
 * Silence is not "fits": it means nothing certain was wrong.
 *
 * - **Pinned positions.** Where a move ends at a known machine position (G53, a
 *   supplied home, or a supplied work offset: see `TravelFrame.pinned`), that position
 *   is checked against the axis's limits directly.
 * - **Extent.** Positions sharing an unknown shift (the same `TravelFrame.ids` entry)
 *   differ by exactly what they say. If they span more than an axis's travel, the
 *   program can't fit, wherever the shift is.
 *
 * Positions are in machine millimetres (degrees for A, B and C) after units: an inch
 * program is checked against millimetre limits correctly. Messages give the axis,
 * numbers and the line, never program text.
 */

import { arcPoint, cardinalFractions, startAngle } from '../path/path.js';
import type { Diagnostic } from '../syntax/types.js';
import { AXES, type Axis, type Plane, type Step } from '../interp/types.js';

/** One axis's travel, in machine coordinates. */
export interface AxisTravel {
  readonly min: number;
  readonly max: number;
}

/** The machine's travel per axis. An axis not given isn't checked. */
export type TravelLimits = Partial<Readonly<Record<Axis, AxisTravel>>>;

/** Rounding slack, so a move exactly to a limit never warns. */
const EPS = 1e-6;

const PLANE_AXES: Readonly<Record<Plane, readonly Axis[]>> = {
  XY: ['X', 'Y'],
  ZX: ['Z', 'X'],
  YZ: ['Y', 'Z'],
};

const unit = (a: Axis): string => (a === 'A' || a === 'B' || a === 'C' ? 'deg' : 'mm');
const num = (v: number): string => String(Math.round(v * 1000) / 1000);

interface Span {
  min: number;
  max: number;
  firstLine: number;
}

/**
 * Checks a program's steps (from `interpret`) against the machine's travel. Returns
 * warnings only: the controller's soft limits are what stop the machine.
 */
export function checkTravel(steps: readonly Step[], travel: TravelLimits): Diagnostic[] {
  const out: Diagnostic[] = [];
  const axes = AXES.filter((a) => {
    const t = travel[a];
    return t !== undefined && Number.isFinite(t.min) && Number.isFinite(t.max) && t.min < t.max;
  });
  if (axes.length === 0) return out;

  // Per axis: what was known where the previous move ended (an arc's interior is
  // only as known as both its ends).
  const prev = new Map<Axis, { pinned: boolean; id: number } | null>();
  // Per axis and frame id: the span of positions seen.
  const spans = new Map<string, Span>();
  const warnedExtent = new Set<string>();
  const outside = new Map<Axis, { step: Step; value: number; count: number }>();
  const point = new Float64Array(3);
  let compensatedSkipped = false;

  const extent = (step: Step & { line: number }, a: Axis, id: number, v: number): void => {
    const t = travel[a] as AxisTravel;
    const key = `${a}:${id}`;
    let s = spans.get(key);
    if (!s) {
      s = { min: v, max: v, firstLine: step.line };
      spans.set(key, s);
    }
    s.min = Math.min(s.min, v);
    s.max = Math.max(s.max, v);
    const need = s.max - s.min;
    const have = t.max - t.min;
    if (need > have + EPS && !warnedExtent.has(key)) {
      warnedExtent.add(key);
      out.push({
        severity: 'warning',
        code: 'TRAVEL_EXTENT',
        message: `${a} needs at least ${num(need)} ${unit(a)} of travel (from line ${s.firstLine} to here), and the machine has ${num(have)} ${unit(a)}: it can't fit, wherever the work offset is set`,
        line: step.line,
        ...(step.file !== undefined ? { file: step.file } : {}),
      });
    }
  };

  const pinnedAt = (step: Step, a: Axis, v: number): void => {
    const t = travel[a] as AxisTravel;
    if (v >= t.min - EPS && v <= t.max + EPS) return;
    const seen = outside.get(a);
    if (seen) seen.count++;
    else outside.set(a, { step, value: v, count: 0 });
  };

  let first = true;
  for (const step of steps) {
    if (step.kind !== 'linear' && step.kind !== 'arc') continue;
    const frame = step.frame;
    // The start is a real place too, wherever the machine happens to be: its own
    // unknown shift (id 0), and where incremental moves from it are measured.
    if (first) {
      first = false;
      const uncertainAtStart = frame?.compensated ? PLANE_AXES[frame.compensated] : [];
      for (const a of axes) {
        if (uncertainAtStart.includes(a)) continue;
        extent(step, a, 0, step.from[a]);
        prev.set(a, { pinned: false, id: 0 });
      }
    }
    if (!frame) {
      // Unknown: forget what came before, so nothing mixes across it.
      prev.clear();
      continue;
    }
    const uncertain = frame.compensated ? PLANE_AXES[frame.compensated] : [];
    if (uncertain.length > 0) compensatedSkipped = true;

    // An arc's extremes along the way, machine coordinates (X, Y, Z).
    const interior: number[][] = [];
    if (step.kind === 'arc') {
      const a0 = startAngle(step);
      for (const f of cardinalFractions(a0, step.sweep)) {
        if (f <= 0 || f >= 1) continue;
        arcPoint(step, a0, f, point, 0);
        interior.push([point[0] as number, point[1] as number, point[2] as number]);
      }
    }

    for (const a of axes) {
      const pinned = frame.pinned.includes(a);
      const now = { pinned, id: frame.ids[a] };
      const before = prev.get(a) ?? null;
      prev.set(a, uncertain.includes(a) ? null : now);
      if (uncertain.includes(a)) continue;

      const values = [step.to[a]];
      // Interior points count only when both ends are known alike.
      const k = a === 'X' ? 0 : a === 'Y' ? 1 : a === 'Z' ? 2 : -1;
      const sameAtBothEnds =
        before !== null && before.pinned === now.pinned && (pinned || before.id === now.id);
      if (k >= 0 && sameAtBothEnds) for (const p of interior) values.push(p[k] as number);

      for (const v of values) {
        if (pinned) pinnedAt(step, a, v);
        else extent(step, a, now.id, v);
      }
    }
  }

  for (const [a, { step, value, count }] of outside) {
    const t = travel[a] as AxisTravel;
    const more = count > 0 ? ` (and ${count} more point${count === 1 ? '' : 's'} after it)` : '';
    out.push({
      severity: 'warning',
      code: 'TRAVEL_OUTSIDE_LIMITS',
      message: `${a} goes to ${num(value)} ${unit(a)} in machine coordinates, outside the machine's travel (${num(t.min)} to ${num(t.max)} ${unit(a)})${more}`,
      line: step.line,
      ...(step.file !== undefined ? { file: step.file } : {}),
    });
  }
  if (compensatedSkipped) {
    out.push({
      severity: 'info',
      code: 'TRAVEL_COMPENSATION_SKIPPED',
      message:
        "Moves under cutter compensation (G41/G42) aren't travel-checked in their plane: the tool radius isn't known here",
      line: firstCompensatedLine(steps),
    });
  }
  return out.sort((x, y) => x.line - y.line);
}

function firstCompensatedLine(steps: readonly Step[]): number {
  for (const s of steps) {
    if ((s.kind === 'linear' || s.kind === 'arc') && s.frame?.compensated) return s.line;
  }
  return 1;
}
