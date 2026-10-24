// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The machining-time estimator (ADR-0043). The estimate feeds quotes, so it says what it
 * doesn't know rather than guessing: time it can't work out is listed as unknown, and
 * the estimate is then incomplete (never to be priced automatically).
 *
 * The model is trapezoidal (constant acceleration), as on Masso 5.13:
 * - each move's top speed is its feed, capped by every axis's maximum velocity projected
 *   onto the move, and for an arc by its centripetal limit sqrt(a * r);
 * - its acceleration is every axis's limit projected onto the move, the tightest;
 * - corners slow to GRBL's junction-deviation speed;
 * - a backward pass (every move can still stop where it must, and within the look-ahead)
 *   and a forward pass (every move accelerates from its entry) fix each junction's
 *   speed; each move's time is then closed-form;
 * - a block-rate floor: no move takes less than 1/blockRate s.
 *
 * Pure and deterministic: no clock, no randomness, sums in program order, and junction
 * speeds use only square roots (correctly rounded everywhere).
 */

import {
  AXES,
  type Axis,
  type InterpretResult,
  type Plane,
  type Position,
  type Step,
} from '../interp/types.js';

/** One axis's limits: velocity per minute, acceleration per second squared. */
export interface EstimateAxis {
  /** mm/min (deg/min for A, B and C). */
  readonly maxVelocity: number;
  /** mm/s² (deg/s²). */
  readonly acceleration: number;
}

/**
 * The machine, as plain numbers. The server maps a validated machine record (ADR-0041)
 * onto this; core never reads the record itself.
 */
export interface EstimateMachine {
  /** X, Y and Z are required; a rotary axis a program moves without limits is unknown. */
  readonly axes: Readonly<Record<'X' | 'Y' | 'Z', EstimateAxis>> &
    Partial<Readonly<Record<'A' | 'B' | 'C', EstimateAxis>>>;
  /** mm/min. Absent: each axis's maxVelocity. */
  readonly rapidRate?: number;
  /**
   * How rapids move. 'coordinated': like a G1 at rapidRate, blended with its
   * neighbours. 'per-axis': each axis at its own speed, stopping at both ends.
   */
  readonly rapidModel: 'coordinated' | 'per-axis';
  /** Whether the rapid model was measured on the machine; if not, the estimate says so. */
  readonly rapidModelConfirmed: boolean;
  /** mm. GRBL's cornering model. */
  readonly junctionDeviation: number;
  /** Blocks per second the controller can process. Absent: no floor. */
  readonly blockRate?: number;
  /** Blocks of look-ahead, a positive integer. Absent: unlimited. */
  readonly lookahead?: number;
  readonly spinUpSeconds: number;
  readonly spinDownSeconds: number;
  readonly toolChangeSeconds: number;
  readonly programStartSeconds: number;
  /** Per M0: an assumed operator response. */
  readonly pauseSeconds: number;
  /** Null when the machine isn't calibrated: both factors are then 1. */
  readonly calibration: { readonly timeFactor: number; readonly accelFactor: number } | null;
}

export interface EstimateOptions {
  /** Per M1 (optional stop). Default 0: optional stops usually run switched off. */
  readonly optionalStopSeconds?: number;
  /** Per spindle-speed change while it runs. Default 0: the controller's docs don't say it waits. */
  readonly speedChangeSeconds?: number;
}

/** Why some time isn't known. */
export type UnknownReason =
  | 'LINE_REFUSED'
  | 'FEED_UNSPECIFIED'
  | 'FEED_ZERO'
  | 'RPM_UNKNOWN'
  | 'WAIT_FOR_INPUT'
  | 'AXIS_NOT_DESCRIBED';

export interface EstimateUnknown {
  readonly line: number;
  readonly file?: string;
  readonly reason: UnknownReason;
}

export interface EstimateResult {
  /**
   * Integer milliseconds, rounded once from the unrounded sum: the figure to price from.
   * NULL when the estimate is incomplete, so a partial figure can't be priced by
   * accident (ADR-0043: an incomplete estimate is never priced automatically).
   */
  readonly totalMs: number | null;
  /** The time that IS known, complete or not (equal to totalMs when complete). */
  readonly knownMs: number;
  /** Motion at a programmed feed, and rapids. */
  readonly cutMs: number;
  readonly rapidMs: number;
  /** Spindle delays, tool changes, pauses, program start. */
  readonly eventMs: number;
  readonly dwellMs: number;
  /** Motion and dwell time per tool in the spindle (null: none yet). */
  readonly perTool: readonly { readonly tool: number | null; readonly ms: number }[];
  /** Time this estimate couldn't work out: it isn't in the totals. */
  readonly unknowns: readonly EstimateUnknown[];
  /** False whenever there are unknowns. An incomplete estimate is never priced automatically. */
  readonly complete: boolean;
  readonly calibrated: boolean;
  /** Assumptions a quote should show (e.g. "M1 optional stops counted as 0 s"). */
  readonly notes: readonly string[];
}

// ── Segments ─────────────────────────────────────────────────────────────

/** A move the planner plans through, or a fixed-time one it doesn't. */
interface Segment {
  readonly line: number;
  readonly file: string | undefined;
  readonly rapid: boolean;
  readonly tool: number | null;
  readonly length: number;
  /** Unit direction at the start and the end (they differ on an arc). */
  readonly u0: Float64Array;
  readonly u1: Float64Array;
  /** mm/s. */
  readonly vmax: number;
  /** mm/s². */
  readonly accel: number;
  /** Seconds, for a move whose time is fixed (inverse time, per-axis rapid): not planned. */
  readonly fixed: number | null;
  /** The planner must be at rest before this segment (a stop between). */
  stopBefore: boolean;
}

const DIM = AXES.length;
const PLANE_AXES: Readonly<Record<Plane, readonly [Axis, Axis]>> = {
  XY: ['X', 'Y'],
  ZX: ['Z', 'X'],
  YZ: ['Y', 'Z'],
};
const EPS = 1e-12;

/** The axis an arc's plane is normal to. */
function normalOf(plane: Plane): Axis {
  return plane === 'XY' ? 'Z' : plane === 'ZX' ? 'Y' : 'X';
}

function vector(from: Position, to: Position): Float64Array {
  const d = new Float64Array(DIM);
  for (let i = 0; i < DIM; i++) d[i] = to[AXES[i] as Axis] - from[AXES[i] as Axis];
  return d;
}

function norm(d: Float64Array): number {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += (d[i] as number) * (d[i] as number);
  return Math.sqrt(s);
}

/**
 * Seconds for one move of length L from v0 to v1 (both reachable), top speed vmax,
 * acceleration a: a trapezoid, or a triangle when vmax isn't reached.
 */
export function segmentTime(L: number, v0: number, v1: number, vmax: number, a: number): number {
  if (L <= 0) return 0;
  const peak2 = (2 * a * L + v0 * v0 + v1 * v1) / 2;
  if (peak2 <= vmax * vmax) {
    const peak = Math.sqrt(peak2);
    return (peak - v0) / a + (peak - v1) / a;
  }
  const accelDist = (vmax * vmax - v0 * v0) / (2 * a);
  const decelDist = (vmax * vmax - v1 * v1) / (2 * a);
  return (vmax - v0) / a + (vmax - v1) / a + (L - accelDist - decelDist) / vmax;
}

/**
 * GRBL's junction-deviation speed (mm/s) between two unit directions: the speed at which
 * a circle of deviation `delta`, tangent to both moves, is taken at acceleration `a`.
 * Straight on is uncapped; a reversal is 0.
 */
export function junctionSpeed(
  u1: Float64Array,
  u2: Float64Array,
  a: number,
  delta: number,
): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += (u1[i] as number) * (u2[i] as number);
  const cos = Math.min(1, Math.max(-1, -dot));
  const s = Math.sqrt((1 - cos) / 2); // sin(theta/2), theta the angle between the reversed first and the second
  if (s >= 1 - EPS) return Infinity;
  if (s <= EPS) return 0;
  return Math.sqrt((a * delta * s) / (1 - s));
}

// ── The estimate ─────────────────────────────────────────────────────────

/** Refuses machine numbers that would make the estimate meaningless (NaN, Infinity). */
function checkMachine(machine: EstimateMachine, options: EstimateOptions): void {
  const fail = (what: string): never => {
    throw new RangeError(`EstimateMachine: ${what}`);
  };
  const positive = (v: number | undefined, what: string): void => {
    if (v !== undefined && !(Number.isFinite(v) && v > 0))
      fail(`${what} must be a finite number above 0`);
  };
  const nonNegative = (v: number | undefined, what: string): void => {
    if (v !== undefined && !(Number.isFinite(v) && v >= 0))
      fail(`${what} must be a finite number, 0 or more`);
  };
  for (const [a, lim] of Object.entries(machine.axes)) {
    if (lim === undefined) continue;
    positive(lim.maxVelocity, `${a}.maxVelocity`);
    positive(lim.acceleration, `${a}.acceleration`);
  }
  positive(machine.rapidRate, 'rapidRate');
  nonNegative(machine.junctionDeviation, 'junctionDeviation');
  positive(machine.blockRate, 'blockRate');
  if (
    machine.lookahead !== undefined &&
    !(Number.isSafeInteger(machine.lookahead) && machine.lookahead >= 1)
  )
    fail('lookahead must be a whole number of blocks, 1 or more (absent: unlimited)');
  nonNegative(machine.spinUpSeconds, 'spinUpSeconds');
  nonNegative(machine.spinDownSeconds, 'spinDownSeconds');
  nonNegative(machine.toolChangeSeconds, 'toolChangeSeconds');
  nonNegative(machine.programStartSeconds, 'programStartSeconds');
  nonNegative(machine.pauseSeconds, 'pauseSeconds');
  if (machine.calibration !== null) {
    positive(machine.calibration.timeFactor, 'calibration.timeFactor');
    positive(machine.calibration.accelFactor, 'calibration.accelFactor');
  }
  nonNegative(options.optionalStopSeconds, 'optionalStopSeconds');
  nonNegative(options.speedChangeSeconds, 'speedChangeSeconds');
}

/**
 * Estimates how long the machine takes to run a program. Pass the whole result of
 * `interpret`: a line it refused (an error) is time this estimate can't account for, so
 * each one is listed as an unknown and the estimate is incomplete. Given bare steps, the
 * caller vouches there were no errors.
 */
export function estimateTime(
  input: readonly Step[] | Pick<InterpretResult, 'steps' | 'diagnostics'>,
  machine: EstimateMachine,
  options: EstimateOptions = {},
): EstimateResult {
  const steps = 'steps' in input ? input.steps : input;
  // Validated here too: this is a public export, whatever the caller's mapping did.
  checkMachine(machine, options);
  const accelFactor = machine.calibration?.accelFactor ?? 1;
  const timeFactor = machine.calibration?.timeFactor ?? 1;
  const optionalStop = options.optionalStopSeconds ?? 0;
  const speedChange = options.speedChangeSeconds ?? 0;
  const notes: string[] = [];
  const unknowns: EstimateUnknown[] = [];
  const axisLimit = (a: Axis): EstimateAxis | undefined =>
    (machine.axes as Partial<Record<Axis, EstimateAxis>>)[a];

  // Seconds by category, and per tool, summed in program order.
  let cut = 0;
  let rapid = 0;
  let event = machine.programStartSeconds;
  let dwell = 0;
  const perTool = new Map<number | null, number>();
  const toolAdd = (tool: number | null, s: number): void => {
    perTool.set(tool, (perTool.get(tool) ?? 0) + s);
  };
  let pausesM0 = 0;
  let pausesM1 = 0;
  let speedChanges = 0;

  let tool: number | null = null;
  let spindleOn = false;
  let rpm: number | null = null;
  let segments: Segment[] = [];
  let stopPending = true; // the program starts at rest

  const unknown = (step: Step, reason: UnknownReason): void => {
    unknowns.push({
      line: step.line,
      ...(step.file !== undefined ? { file: step.file } : {}),
      reason,
    });
  };
  if ('diagnostics' in input) {
    for (const d of input.diagnostics) {
      if (d.severity !== 'error') continue;
      unknowns.push({
        line: d.line,
        ...(d.file !== undefined ? { file: d.file } : {}),
        reason: 'LINE_REFUSED',
      });
    }
  }

  /** Plans the run of segments since the last flush, adding their time. */
  const flush = (): void => {
    if (segments.length === 0) return;
    for (const [s, t] of planChain(segments, machine)) {
      const seconds = t;
      if (s.rapid) rapid += seconds;
      else cut += seconds;
      toolAdd(s.tool, seconds);
    }
    segments = [];
  };
  /**
   * A stop: the planner is at rest before the next move, so the moves so far are
   * planned now (a stop is a hard zero anyway). Their time is then added in program
   * order, before whatever the stop adds.
   */
  const stop = (): void => {
    stopPending = true;
    flush();
  };

  for (const step of steps) {
    switch (step.kind) {
      case 'linear':
      case 'arc': {
        // A per-rev feed needs a turning spindle: stopped, its last speed doesn't count.
        const rpmNow = spindleOn ? rpm : null;
        const seg = segmentOf(step, machine, axisLimit, accelFactor, rpmNow, tool, unknown);
        if (seg === null) {
          stop();
          continue;
        }
        if (seg === 'empty') continue;
        seg.stopBefore = stopPending;
        stopPending = seg.fixed !== null; // a fixed-time move ends at rest
        if (seg.fixed !== null) seg.stopBefore = true;
        segments.push(seg);
        break;
      }
      case 'dwell':
        stop();
        dwell += step.seconds;
        toolAdd(tool, step.seconds);
        break;
      case 'tool-change':
        stop();
        event += machine.toolChangeSeconds;
        tool = step.tool;
        break;
      case 'spindle': {
        stop();
        const on = step.state !== 'off';
        if (on && !spindleOn) event += machine.spinUpSeconds;
        else if (!on && spindleOn) event += machine.spinDownSeconds;
        else if (on && spindleOn && step.rpm !== null && step.rpm !== rpm) {
          event += speedChange;
          speedChanges++;
        }
        spindleOn = on;
        if (step.rpm !== null) rpm = step.rpm;
        break;
      }
      case 'pause':
        stop();
        if (step.optional) {
          event += optionalStop;
          pausesM1++;
        } else {
          event += machine.pauseSeconds;
          pausesM0++;
        }
        break;
      case 'wait':
        stop();
        unknown(step, 'WAIT_FOR_INPUT');
        break;
      case 'coolant':
        // Controllers synchronise on coolant changes (GRBL does): motion stops.
        stop();
        break;
      case 'message':
        break;
      case 'end':
        stop();
        break;
    }
  }
  flush();

  if (!machine.rapidModelConfirmed)
    notes.push(`rapids modelled as ${machine.rapidModel}, not yet measured on this machine`);
  if (machine.calibration === null) notes.push('the machine is not calibrated');
  if (pausesM1 > 0)
    notes.push(`${pausesM1} optional stop(s) (M1) counted as ${optionalStop} s each`);
  if (speedChanges > 0)
    notes.push(`${speedChanges} spindle speed change(s) counted as ${speedChange} s each`);
  if (pausesM0 > 0)
    notes.push(`${pausesM0} pause(s) (M0) counted as ${machine.pauseSeconds} s each`);

  const ms = (s: number): number => Math.floor(s * timeFactor * 1000 + 0.5);
  const known = ms(cut + rapid + event + dwell);
  // Validated inputs give finite times; never report a non-finite one as known.
  if (!Number.isFinite(known)) throw new RangeError('estimateTime: the estimate is not finite');
  const complete = unknowns.length === 0;
  return {
    totalMs: complete ? known : null,
    knownMs: known,
    cutMs: ms(cut),
    rapidMs: ms(rapid),
    eventMs: ms(event),
    dwellMs: ms(dwell),
    perTool: [...perTool].map(([t, s]) => ({ tool: t, ms: ms(s) })),
    unknowns,
    complete,
    calibrated: machine.calibration !== null,
    notes,
  };
}

/** The segment for a motion step, 'empty' for a zero-length one, or null if unknown. */
function segmentOf(
  step: Extract<Step, { kind: 'linear' | 'arc' }>,
  machine: EstimateMachine,
  axisLimit: (a: Axis) => EstimateAxis | undefined,
  accelFactor: number,
  rpm: number | null,
  tool: number | null,
  unknown: (s: Step, r: UnknownReason) => void,
): Segment | 'empty' | null {
  const d = vector(step.from, step.to);
  let length: number;
  let u0: Float64Array;
  let u1: Float64Array;
  let radius = Infinity;
  if (step.kind === 'linear') {
    length = norm(d);
    if (length < EPS) return 'empty';
    u0 = d.map((x) => x / length);
    u1 = u0;
  } else {
    const [a1, a2] = PLANE_AXES[step.plane];
    const normal = normalOf(step.plane);
    const planar = (Math.abs(step.sweep) * (step.radius + step.endRadius)) / 2;
    const dn = step.to[normal] - step.from[normal];
    length = Math.sqrt(planar * planar + dn * dn);
    if (length < EPS) return 'empty';
    radius = Math.min(step.radius, step.endRadius);
    const tangent = (p: Position): Float64Array => {
      const r1 = p[a1] - step.centre[a1];
      const r2 = p[a2] - step.centre[a2];
      const r = Math.sqrt(r1 * r1 + r2 * r2) || 1;
      const sign = step.sweep >= 0 ? 1 : -1;
      const u = new Float64Array(DIM);
      u[AXES.indexOf(a1)] = ((-r2 / r) * sign * planar) / length;
      u[AXES.indexOf(a2)] = ((r1 / r) * sign * planar) / length;
      u[AXES.indexOf(normal)] = dn / length;
      return u;
    };
    u0 = tangent(step.from);
    u1 = tangent(step.to);
  }

  // Per-axis limits projected onto the move: the tightest wins. Each axis's share of
  // the motion: on a line, its component of the direction; on an arc, the plane axes
  // take up to the whole in-plane speed as the direction turns, the normal its part.
  const share = new Float64Array(DIM);
  if (step.kind === 'linear') {
    for (let i = 0; i < DIM; i++) share[i] = Math.abs(u0[i] as number);
  } else {
    const [a1, a2] = PLANE_AXES[step.plane];
    const n = AXES.indexOf(normalOf(step.plane));
    const along = Math.abs(u0[n] as number);
    const planarShare = Math.sqrt(Math.max(0, 1 - along * along));
    share[AXES.indexOf(a1)] = planarShare;
    share[AXES.indexOf(a2)] = planarShare;
    share[n] = along;
  }
  let vAxis = Infinity;
  let aAxis = Infinity;
  for (let i = 0; i < DIM; i++) {
    const sh = share[i] as number;
    if (sh < EPS) continue;
    const lim = axisLimit(AXES[i] as Axis);
    if (!lim) {
      unknown(step, 'AXIS_NOT_DESCRIBED');
      return null;
    }
    vAxis = Math.min(vAxis, lim.maxVelocity / 60 / sh);
    aAxis = Math.min(aAxis, (lim.acceleration * accelFactor) / sh);
  }

  const base = {
    line: step.line,
    file: step.file,
    tool,
    length,
    u0,
    u1,
    accel: aAxis,
    stopBefore: false,
  };

  if (step.kind === 'linear' && step.rapid) {
    if (machine.rapidModel === 'per-axis') {
      // Each axis at its own speed, from rest to rest: the slowest decides.
      let t = 0;
      for (let i = 0; i < DIM; i++) {
        const dist = Math.abs(d[i] as number);
        if (dist < EPS) continue;
        const lim = axisLimit(AXES[i] as Axis);
        if (!lim) {
          unknown(step, 'AXIS_NOT_DESCRIBED');
          return null;
        }
        t = Math.max(
          t,
          segmentTime(dist, 0, 0, lim.maxVelocity / 60, lim.acceleration * accelFactor),
        );
      }
      return { ...base, rapid: true, vmax: Infinity, fixed: t };
    }
    const rate = machine.rapidRate !== undefined ? machine.rapidRate / 60 : Infinity;
    return { ...base, rapid: true, vmax: Math.min(rate, vAxis), fixed: null };
  }

  // A feed move. Its feed as a speed, or a fixed time, or unknown.
  const feed = step.feed;
  if (feed === null || feed.mode === 'unspecified') {
    unknown(step, 'FEED_UNSPECIFIED');
    return null;
  }
  let v: number;
  if (feed.mode === 'inverse-time') {
    if (!(feed.perMinute > 0)) {
      unknown(step, 'FEED_ZERO');
      return null;
    }
    return { ...base, rapid: false, vmax: Infinity, fixed: 60 / feed.perMinute };
  } else if (feed.mode === 'per-revolution') {
    if (rpm === null || !(rpm > 0)) {
      unknown(step, 'RPM_UNKNOWN');
      return null;
    }
    v = (feed.mmPerRevolution * rpm) / 60;
  } else {
    v = feed.mmPerMinute / 60;
  }
  if (!(v > 0)) {
    unknown(step, 'FEED_ZERO');
    return null;
  }
  let vmax = Math.min(v, vAxis);
  // An arc's centripetal limit.
  if (step.kind === 'arc') vmax = Math.min(vmax, Math.sqrt(aAxis * radius));
  return { ...base, rapid: false, vmax, fixed: null };
}

/**
 * Plans a list of segments in program order: junction speeds, then the backward and
 * forward passes, then each segment's time. Returns each segment with its seconds.
 */
function planChain(list: readonly Segment[], machine: EstimateMachine): [Segment, number][] {
  const n = list.length;
  const out: [Segment, number][] = [];
  // v[j]: the speed at junction j, before segment j (v[n] is the end, at rest).
  const v = new Float64Array(n + 1);
  const cap = new Float64Array(n + 1);
  cap[0] = 0;
  cap[n] = 0;
  for (let j = 1; j < n; j++) {
    const prev = list[j - 1] as Segment;
    const cur = list[j] as Segment;
    if (cur.stopBefore || prev.fixed !== null || cur.fixed !== null) {
      cap[j] = 0;
      continue;
    }
    const a = Math.min(prev.accel, cur.accel);
    cap[j] = Math.min(
      junctionSpeed(prev.u1, cur.u0, a, machine.junctionDeviation),
      prev.vmax,
      cur.vmax,
    );
  }
  if ((list[0] as Segment).stopBefore) cap[0] = 0;

  // Look-ahead: the machine must be able to stop by the end of the next L segments,
  // honouring every junction cap among them. Unrolled, that backward pass from rest is
  //   v_j^2 <= min( P_end, min over k in (j, end) of (cap_k^2 + P_k) ) - P_j,
  // with P the prefix sums of 2*a*length and end = j + L (at rest there). The global
  // backward pass below already gives min over ALL k > j of (cap_k^2 + P_k) - P_j, and a
  // junction beyond the window can't beat P_end (cap_k^2 + P_k >= P_k >= P_end). So the
  // window adds just one bound, v_j^2 <= P_end - P_j, and the plan is exact, in O(n).
  // (A differential test checks this against an O(n * L) backward pass per junction.)
  const L = machine.lookahead;
  if (L !== undefined) {
    const P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const s = list[i] as Segment;
      P[i + 1] = (P[i] as number) + (s.fixed === null ? 2 * s.accel * s.length : 0);
    }
    for (let j = 1; j < n; j++) {
      const end = Math.min(n, j + L);
      const stopWithin = Math.sqrt(Math.max(0, (P[end] as number) - (P[j] as number)));
      cap[j] = Math.min(cap[j] as number, stopWithin);
    }
  }

  // Backward pass: each junction can still slow to the next within the segment.
  v[n] = 0;
  for (let j = n - 1; j >= 0; j--) {
    const s = list[j] as Segment;
    const next = v[j + 1] as number;
    const reach = s.fixed === null ? Math.sqrt(next * next + 2 * s.accel * s.length) : 0;
    v[j] = Math.min(cap[j] as number, reach);
  }
  // Forward pass: each junction is reachable from the previous one.
  for (let j = 0; j < n; j++) {
    const s = list[j] as Segment;
    const prev = v[j] as number;
    const reach = s.fixed === null ? Math.sqrt(prev * prev + 2 * s.accel * s.length) : 0;
    v[j + 1] = Math.min(v[j + 1] as number, reach);
  }

  const floor =
    machine.blockRate !== undefined && machine.blockRate > 0 ? 1 / machine.blockRate : 0;
  for (let j = 0; j < n; j++) {
    const s = list[j] as Segment;
    const t =
      s.fixed !== null
        ? s.fixed
        : segmentTime(s.length, v[j] as number, v[j + 1] as number, s.vmax, s.accel);
    out.push([s, Math.max(t, floor)]);
  }
  return out;
}
