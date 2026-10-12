// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Feed, Step } from '../interp/types.js';
import { arcPoint, cardinalFractions, startAngle, type Box } from '../path/path.js';

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
   * Min/max per axis, in work coordinates; `cut` is feed moves and arcs, `rapid` G0.
   * Null where there are none. Z counts only where moves END (and an arc's extremes):
   * a retract starts at cut depth and a plunge at clearance, so counting starts would
   * make every rapid reach the cut depth (hiding a rapid that really does go deep) and
   * every cut reach clearance.
   * - Cuts: X/Y over their whole path (a ramp's start included); Z where they end.
   * - Rapids: end points only.
   * - The interpreter's assumed start, before the first move, is never counted: the
   *   program never commanded it.
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
  /** Each cutting feed (not plunges), with the distance fed at it, most-used first. */
  readonly byValue: readonly FeedUse[];
  /** Each plunge feed, with the distance plunged at it, most-used first. */
  readonly plungeByValue: readonly FeedUse[];
  /** Moves fed in inverse time (G93) or per revolution (G95): no single mm/min. */
  readonly otherModes: number;
  /** Moves with no feed ever given, run at the machine's set rate (Masso). */
  readonly unspecified: number;
}

export interface FeedUse {
  readonly mmPerMinute: number;
  readonly distance: number;
}

export interface SpindleSummary {
  /** RPM range while cutting with the spindle on at a programmed speed. */
  readonly rpm: Range | null;
  /**
   * Each speed cut at, with the distance, most-used first. `rpm: null` is cutting with
   * the spindle on (M3/M4) but no S ever given: a router whose speed is set by hand.
   */
  readonly byRpm: readonly { readonly rpm: number | null; readonly distance: number }[];
  readonly directions: readonly ('cw' | 'ccw')[];
  /** Spindle commands (M3/M4/M5 and speed changes). */
  readonly changes: number;
  /**
   * Cutting with the spindle OFF or at S0: usually a missing M3. Null if never.
   * `firstLine` (and `file`, for a subprogram) is the first such move's.
   */
  readonly cutWhileOff: {
    readonly moves: number;
    readonly distance: number;
    readonly firstLine: number;
    readonly file?: string;
  } | null;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export const MAX_Z_LEVELS = 50;

const EPS = 1e-9;
type Arc = Extract<Step, { kind: 'arc' }>;

// Plain square roots: Math.hypot is several times slower in V8, and runs per move.
const len2 = (a: number, b: number) => Math.sqrt(a * a + b * b);
const len3 = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);
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
    return this.entries().sort((a, b) => b[1] - a[1]);
  }
  entries(): [K, number][] {
    return [...this.totals.entries()].map(([k, e]): [K, number] => [k, e.total]);
  }
}

/** Min/max, with X/Y and Z added separately (see ProgramSummary.extent). */
class Extent {
  minX = Infinity;
  minY = Infinity;
  minZ = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;
  maxZ = -Infinity;
  xy(x: number, y: number): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
  }
  z(z: number): void {
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
  }
  box(): Box | null {
    if (this.minX === Infinity || this.minZ === Infinity) return null;
    return {
      min: { X: this.minX, Y: this.minY, Z: this.minZ },
      max: { X: this.maxX, Y: this.maxY, Z: this.maxZ },
    };
  }
  static union(a: Extent, b: Extent): Box | null {
    const u = new Extent();
    for (const e of [a, b]) {
      if (e.minX !== Infinity) {
        u.xy(e.minX, e.minY);
        u.xy(e.maxX, e.maxY);
      }
      if (e.minZ !== Infinity) {
        u.z(e.minZ);
        u.z(e.maxZ);
      }
    }
    return u.box();
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
  const cutBox = new Extent();
  const rapidBox = new Extent();
  let first = true; // the first motion starts from the interpreter's assumed start
  const point = new Float64Array(3);
  const distance = { cut: 0, rapid: 0, plunge: 0 };
  const moves = { rapid: 0, linear: 0, arc: 0 };
  let cutFeed: Range | null = null;
  let plungeFeed: Range | null = null;
  const byFeed = new Tally<number>();
  const byPlungeFeed = new Tally<number>();
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
  let off: { moves: number; distance: number; firstLine: number; file?: string } | null = null;
  const toolCut = new Tally<number | null>();
  let toolChanges = 0;
  const zLevel = new Tally<number>();
  const dwell = { count: 0, seconds: 0 };
  let pauses = 0;
  let coolant = false;

  const feedAt = (f: Feed | null, length: number, down: boolean) => {
    if (f?.mode === 'per-minute') {
      const key = Math.round(f.mmPerMinute * 100) / 100;
      if (down) {
        plungeFeed = widen(plungeFeed, f.mmPerMinute);
        byPlungeFeed.add(key, length);
      } else {
        cutFeed = widen(cutFeed, f.mmPerMinute);
        byFeed.add(key, length);
      }
    } else if (f?.mode === 'unspecified') unspecified++;
    else if (f) otherModes++;
  };
  const cutting = (length: number, s: Step & { line: number }) => {
    distance.cut += length;
    toolCut.add(tool, length);
    // On at S0 cuts nothing: count it with the spindle off.
    if (spindleOn && rpm !== 0) {
      byRpm.add(rpm, length);
      if (rpm !== null) rpmRange = widen(rpmRange, rpm);
    } else {
      off ??= { moves: 0, distance: 0, firstLine: s.line, ...(s.file ? { file: s.file } : {}) };
      off.moves++;
      off.distance += length;
    }
  };
  const level = (z: number, length: number) => zLevel.add(Math.round(z * 1e4) / 1e4, length);

  for (const s of steps) {
    switch (s.kind) {
      case 'linear': {
        const o = s.offset;
        const x = s.to.X - o.X;
        const y = s.to.Y - o.Y;
        const z = s.to.Z - o.Z;
        const dx = s.to.X - s.from.X;
        const dy = s.to.Y - s.from.Y;
        const dz = s.to.Z - s.from.Z;
        const length = len3(dx, dy, dz);
        const fromHere = !first;
        first = false;
        if (s.rapid) {
          moves.rapid++;
          distance.rapid += length;
          rapidBox.xy(x, y);
          rapidBox.z(z);
          break;
        }
        moves.linear++;
        if (fromHere) cutBox.xy(s.from.X - o.X, s.from.Y - o.Y);
        cutBox.xy(x, y);
        cutBox.z(z);
        if (length < EPS) break;
        const horizontal = len2(dx, dy);
        const down = horizontal < EPS && dz < 0;
        if (down) distance.plunge += length;
        if (horizontal >= EPS && Math.abs(dz) < EPS) level(z, length);
        cutting(length, s);
        feedAt(s.feed, length, down);
        break;
      }
      case 'arc': {
        const o = s.offset;
        moves.arc++;
        if (!first) cutBox.xy(s.from.X - o.X, s.from.Y - o.Y);
        first = false;
        cutBox.xy(s.to.X - o.X, s.to.Y - o.Y);
        cutBox.z(s.to.Z - o.Z);
        // The arc's extremes along the way (its start is the last move's end).
        const a0 = startAngle(s);
        for (const t of cardinalFractions(a0, s.sweep)) {
          if (t <= 0) continue;
          arcPoint(s, a0, t, point, 0);
          cutBox.xy((point[0] as number) - o.X, (point[1] as number) - o.Y);
          cutBox.z((point[2] as number) - o.Z);
        }
        const length = arcLength(s);
        if (s.plane === 'XY' && Math.abs(s.to.Z - s.from.Z) < EPS) level(s.to.Z - o.Z, length);
        cutting(length, s);
        feedAt(s.feed, length, false);
        break;
      }
      case 'spindle':
        // A tool change's stop isn't a command in the program.
        if (s.by !== 'tool-change') spindleChanges++;
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
  const uses = (t: Tally<number>) =>
    t.ranked().map(([mmPerMinute, d]) => ({ mmPerMinute, distance: d }));
  return {
    extent: { all: Extent.union(cutBox, rapidBox), cut: cutBox.box(), rapid: rapidBox.box() },
    distance,
    moves,
    feed: {
      cut: cutFeed,
      plunge: plungeFeed,
      byValue: uses(byFeed),
      plungeByValue: uses(byPlungeFeed),
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
