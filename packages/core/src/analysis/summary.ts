// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Feed, Position, Step } from '../interp/types.js';
import { pathBounds, type Box } from '../path/path.js';

/**
 * A program at a glance (plan §4.2 item 8; operator request, 2026-09-27): where it
 * goes, how fast, at what spindle speeds, with which tools. Pure, from the
 * interpreter's steps.
 *
 * Everything is in WORK coordinates and millimetres (mm/min for feeds), whatever units
 * the program is written in. The interpreter keeps machine coordinates and the work
 * offset in force (ADR-0019); the summary reports what the program says, in the frame
 * each move was commanded in.
 */
export interface ProgramSummary {
  /**
   * Min/max per axis, exact for arcs (their extremes, not just their ends). `cut` is
   * every feed move and arc, `rapid` every G0. Null where there are none.
   */
  readonly extent: {
    readonly all: Box | null;
    readonly cut: Box | null;
    readonly rapid: Box | null;
  };
  /** Distances travelled, mm. `plunge` is the part of `cut` that went straight down. */
  readonly distance: { readonly cut: number; readonly rapid: number; readonly plunge: number };
  readonly moves: { readonly rapid: number; readonly linear: number; readonly arc: number };
  readonly feed: FeedSummary;
  readonly spindle: SpindleSummary;
  /** Tools in order of first use (from tool changes), with the distance cut by each. */
  readonly tools: readonly { readonly tool: number | null; readonly cut: number }[];
  readonly toolChanges: number;
  /**
   * The heights the program cuts at: Z of every level cutting move (horizontal feed
   * moves and XY-plane arcs without a helix), highest first, with the distance cut
   * there. At most {@link MAX_Z_LEVELS}; `zLevelsMore` counts the rest.
   */
  readonly zLevels: readonly { readonly z: number; readonly cut: number }[];
  readonly zLevelsMore: number;
  readonly dwell: { readonly count: number; readonly seconds: number };
  /** M0 / M1 stops. */
  readonly pauses: number;
  readonly coolant: boolean;
}

export interface FeedSummary {
  /** Per-minute feeds (G94) of cutting moves (not plunges), mm/min. Null if none. */
  readonly cut: Range | null;
  /** Per-minute feeds of plunges (straight down), mm/min. Null if none. */
  readonly plunge: Range | null;
  /** Each per-minute feed used, with the distance fed at it, most-used first. */
  readonly byValue: readonly { readonly mmPerMinute: number; readonly distance: number }[];
  /** Moves fed in inverse time (G93) or per revolution (G95): no single mm/min. */
  readonly otherModes: number;
  /** Moves with no feed ever given, run at the machine's set rate (Masso). */
  readonly unspecified: number;
}

export interface SpindleSummary {
  /** RPM range while cutting with the spindle on. Null if it never was. */
  readonly rpm: Range | null;
  /** Each speed, with the distance cut at it, most-used first. */
  readonly byRpm: readonly { readonly rpm: number | null; readonly distance: number }[];
  readonly directions: readonly ('cw' | 'ccw')[];
  /** Spindle commands (M3/M4/M5 and speed changes). */
  readonly changes: number;
  /**
   * Cutting with the spindle OFF: usually a missing M3. Null if never. `firstLine` is
   * the first such move's line.
   */
  readonly cutWhileOff: {
    readonly moves: number;
    readonly distance: number;
    readonly firstLine: number;
  } | null;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export const MAX_Z_LEVELS = 50;

const EPS = 1e-9;
type Arc = Extract<Step, { kind: 'arc' }>;

const sub = (a: Position, o: Position): Position => ({
  X: a.X - o.X,
  Y: a.Y - o.Y,
  Z: a.Z - o.Z,
  A: a.A - o.A,
  B: a.B - o.B,
  C: a.C - o.C,
});
// Plain square roots: Math.hypot is several times slower in V8, and runs per move.
const len2 = (a: number, b: number) => Math.sqrt(a * a + b * b);
const len3 = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);
const zero = (o: Position) => o.X === 0 && o.Y === 0 && o.Z === 0;
const widen = (r: Range | null, v: number): Range =>
  r ? { min: Math.min(r.min, v), max: Math.max(r.max, v) } : { min: v, max: v };
/**
 * Totals by key. Consecutive moves almost always share a key (the same tool, speed,
 * feed and height for long runs), so the last entry is cached: one Map lookup per
 * CHANGE of key, not per move. That keeps a 226k-step summary to a few tens of ms.
 */
class Tally<K> {
  readonly totals = new Map<K, { total: number }>();
  private lastKey: K | undefined;
  private last: { total: number } | undefined;
  add(key: K, d: number): void {
    if (this.last === undefined || key !== this.lastKey) {
      let e = this.totals.get(key);
      if (!e) this.totals.set(key, (e = { total: 0 }));
      this.last = e;
      this.lastKey = key;
    }
    this.last.total += d;
  }
  /** Most-used first. */
  ranked(): [K, number][] {
    return [...this.totals.entries()]
      .map(([k, e]): [K, number] => [k, e.total])
      .sort((a, b) => b[1] - a[1]);
  }
  entries(): [K, number][] {
    return [...this.totals.entries()].map(([k, e]): [K, number] => [k, e.total]);
  }
}

/** An arc's length: its in-plane length (mean radius, for a tolerated spiral) and its
 *  travel along the plane's normal (a helix), combined. */
function arcLength(s: Arc): number {
  const planar = (Math.abs(s.sweep) * (s.radius + s.endRadius)) / 2;
  const n = s.plane === 'XY' ? 'Z' : s.plane === 'ZX' ? 'Y' : 'X';
  return len2(planar, s.to[n] - s.from[n]);
}

/** Summarises a program from its steps (from `interpret`), in one pass. */
export function summarise(steps: readonly Step[]): ProgramSummary {
  const work: Step[] = []; // the motions in work coordinates, for the exact bounds
  const distance = { cut: 0, rapid: 0, plunge: 0 };
  const moves = { rapid: 0, linear: 0, arc: 0 };
  let cutFeed: Range | null = null;
  let plungeFeed: Range | null = null;
  const byFeed = new Tally<number>();
  let otherModes = 0;
  let unspecified = 0;

  // Modal machine state, as the steps change it.
  let spindleOn = false;
  let rpm: number | null = null;
  let tool: number | null = null;

  let rpmRange: Range | null = null;
  const byRpm = new Tally<number | null>();
  const directions = new Set<'cw' | 'ccw'>();
  let spindleChanges = 0;
  let off: { moves: number; distance: number; firstLine: number } | null = null;
  const toolCut = new Tally<number | null>();
  let toolChanges = 0;
  const zLevel = new Tally<number>();
  const dwell = { count: 0, seconds: 0 };
  let pauses = 0;
  let coolant = false;

  const feedAt = (f: Feed | null, length: number, down: boolean) => {
    if (f?.mode === 'per-minute') {
      if (down) plungeFeed = widen(plungeFeed, f.mmPerMinute);
      else cutFeed = widen(cutFeed, f.mmPerMinute);
      byFeed.add(Math.round(f.mmPerMinute * 100) / 100, length);
    } else if (f?.mode === 'unspecified') unspecified++;
    else if (f) otherModes++;
  };
  const cutting = (length: number, line: number) => {
    distance.cut += length;
    toolCut.add(tool, length);
    if (spindleOn) {
      byRpm.add(rpm, length);
      if (rpm !== null) rpmRange = widen(rpmRange, rpm);
    } else {
      off ??= { moves: 0, distance: 0, firstLine: line };
      off.moves++;
      off.distance += length;
    }
  };
  const level = (z: number, length: number) => zLevel.add(Math.round(z * 1e4) / 1e4, length);

  for (const s of steps) {
    switch (s.kind) {
      case 'linear': {
        // Copy into work coordinates only when an offset is in force: most programs
        // run without one, and a copy per step doubles the time on a large file.
        const shifted = zero(s.offset)
          ? s
          : { ...s, from: sub(s.from, s.offset), to: sub(s.to, s.offset) };
        work.push(shifted);
        const { from, to } = shifted;
        const dx = to.X - from.X;
        const dy = to.Y - from.Y;
        const dz = to.Z - from.Z;
        const length = len3(dx, dy, dz);
        if (s.rapid) {
          moves.rapid++;
          distance.rapid += length;
          break;
        }
        moves.linear++;
        if (length < EPS) break;
        const horizontal = len2(dx, dy);
        const down = horizontal < EPS && dz < 0;
        if (down) distance.plunge += length;
        if (horizontal >= EPS && Math.abs(dz) < EPS) level(from.Z, length);
        cutting(length, s.line);
        feedAt(s.feed, length, down);
        break;
      }
      case 'arc': {
        const shifted = zero(s.offset)
          ? s
          : {
              ...s,
              from: sub(s.from, s.offset),
              to: sub(s.to, s.offset),
              centre: sub(s.centre, s.offset),
            };
        work.push(shifted);
        const { from } = shifted;
        moves.arc++;
        const length = arcLength(s);
        if (s.plane === 'XY' && Math.abs(s.to.Z - s.from.Z) < EPS) level(from.Z, length);
        cutting(length, s.line);
        feedAt(s.feed, length, false);
        break;
      }
      case 'spindle':
        spindleChanges++;
        spindleOn = s.state !== 'off';
        if (s.state !== 'off') directions.add(s.state);
        if (s.rpm !== null) rpm = s.rpm;
        break;
      case 'tool-change':
        toolChanges++;
        tool = s.tool;
        break;
      case 'dwell':
        dwell.count++;
        dwell.seconds += s.seconds;
        break;
      case 'pause':
        pauses++;
        break;
      case 'coolant':
        if (s.mist || s.flood) coolant = true;
        break;
      default:
        break;
    }
  }

  const levels = zLevel.entries().sort((a, b) => b[0] - a[0]);
  const bounds = pathBounds(work);
  return {
    extent: { all: bounds.all, cut: bounds.feed, rapid: bounds.rapid },
    distance,
    moves,
    feed: {
      cut: cutFeed,
      plunge: plungeFeed,
      byValue: byFeed.ranked().map(([mmPerMinute, d]) => ({ mmPerMinute, distance: d })),
      otherModes,
      unspecified,
    },
    spindle: {
      rpm: rpmRange,
      byRpm: byRpm.ranked().map(([r, d]) => ({ rpm: r, distance: d })),
      directions: [...directions],
      changes: spindleChanges,
      cutWhileOff: off,
    },
    tools: toolCut.entries().map(([t, c]) => ({ tool: t, cut: c })),
    toolChanges,
    zLevels: levels.slice(0, MAX_Z_LEVELS).map(([z, c]) => ({ z, cut: c })),
    zLevelsMore: Math.max(0, levels.length - MAX_Z_LEVELS),
    dwell,
    pauses,
    coolant,
  };
}
