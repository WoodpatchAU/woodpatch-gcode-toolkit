// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ARC_PIECE_DEGREES, arcPieceShares } from './estimate.js';
import {
  estimateTime,
  interpret,
  junctionSpeed,
  MASSO_G3,
  parse,
  segmentTime,
  type EstimateMachine,
  type InterpretOptions,
  type Step,
} from '../index.js';

/** A fictional machine: 10 m/min and 500 mm/s² on every axis, 0.02 mm deviation. */
const AXIS = { maxVelocity: 10_000, acceleration: 500 };
const MACHINE: EstimateMachine = {
  axes: { X: AXIS, Y: AXIS, Z: AXIS },
  rapidModel: 'coordinated',
  rapidModelConfirmed: true,
  junctionDeviation: 0.02,
  spinUpSeconds: 0,
  spinDownSeconds: 0,
  toolChangeSeconds: 0,
  programStartSeconds: 0,
  pauseSeconds: 0,
  calibration: null,
};
const m = (over: Partial<EstimateMachine> = {}): EstimateMachine => ({ ...MACHINE, ...over });
const est = (src: string, machine = MACHINE, opts: InterpretOptions = {}) =>
  estimateTime(interpret(parse(src), opts), machine);
const u = (x: number, y: number) => Float64Array.from([x, y, 0, 0, 0, 0]);

describe('segmentTime: closed form', () => {
  it('a trapezoid: accelerate, cruise, decelerate', () => {
    // 100 mm/s at 500 mm/s²: 10 mm and 0.2 s each way, 980 mm at 100 mm/s.
    expect(segmentTime(1000, 0, 0, 100, 500)).toBeCloseTo(10.2, 12);
  });
  it('a triangle when the top speed is not reached', () => {
    expect(segmentTime(10, 0, 0, 100, 500)).toBeCloseTo((2 * Math.sqrt(5000)) / 500, 12);
  });
  it('from and to a speed', () => {
    expect(segmentTime(1000, 100, 100, 100, 500)).toBeCloseTo(10, 12);
  });
});

describe('junctionSpeed', () => {
  const a = 500;
  const d = 0.02;
  it('straight on is uncapped, a reversal is 0', () => {
    expect(junctionSpeed(u(1, 0), u(1, 0), a, d)).toBe(Infinity);
    expect(junctionSpeed(u(1, 0), u(-1, 0), a, d)).toBe(0);
  });
  it("a right angle at GRBL's formula", () => {
    const s = Math.SQRT1_2;
    expect(junctionSpeed(u(1, 0), u(0, 1), a, d)).toBeCloseTo(Math.sqrt((a * d * s) / (1 - s)), 12);
  });
  it('near-straight and near-reversal turns are finite, ordered and never NaN', () => {
    const turn = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      return junctionSpeed(u(1, 0), u(Math.cos(r), Math.sin(r)), a, d);
    };
    const tiny = turn(0.001);
    const sharp = turn(179.999);
    expect(Number.isNaN(tiny) || Number.isNaN(sharp)).toBe(false);
    expect(sharp).toBeGreaterThanOrEqual(0);
    expect(sharp).toBeLessThan(turn(90));
    expect(tiny).toBeGreaterThan(turn(90));
  });
  it('survives unit vectors a hair over length 1 (cos clamped)', () => {
    const v = Float64Array.from([1 + 1e-15, 0, 0, 0, 0, 0]);
    expect(Number.isNaN(junctionSpeed(v, v, a, d))).toBe(false);
  });
});

describe('estimateTime: motion', () => {
  it('a long straight move', () => {
    const r = est('G1 X1000 F6000\n');
    expect(r.knownMs).toBe(10_200);
    expect(r.totalMs).toBe(10_200); // complete: the total is the known time
  });

  it('collinear pieces take as long as one move', () => {
    const one = est('G1 X1000 F6000\n').knownMs;
    const pieces = est('G1 X100 F6000\nG1 X350\nG1 X700\nG1 X1000\n').knownMs;
    expect(pieces).toBe(one);
  });

  it('a right-angle corner slows to the junction speed', () => {
    const s = Math.SQRT1_2;
    const vj = Math.sqrt((500 * 0.02 * s) / (1 - s));
    const expected = segmentTime(100, 0, vj, 100, 500) + segmentTime(100, vj, 0, 100, 500);
    expect(est('G1 X100 F6000\nG1 Y100\n').knownMs).toBe(Math.floor(expected * 1000 + 0.5));
  });

  it('a reversal stops', () => {
    const expected = 2 * segmentTime(100, 0, 0, 100, 500);
    expect(est('G1 X100 F6000\nG1 X0\n').knownMs).toBe(Math.floor(expected * 1000 + 0.5));
  });

  it('a circle slows to its centripetal limit only where it crosses an axis', () => {
    // r 10, 500 mm/s² per axis, feed 100 mm/s. Where the centripetal acceleration lies
    // along one axis, sqrt(500 * 10) = 70.7 mm/s; at 45 degrees each axis carries
    // 1/sqrt(2) of it, so 84.1 mm/s. The circle runs between the two (ADR-0043).
    const L = 2 * Math.PI * 10;
    const r = est('G0 X-10\nG1 F6000\nG2 X-10 Y0 I10 J0\n');
    const vj = junctionSpeed(u(-1, 0), u(0, 1), 500, 0.02);
    const slowest = segmentTime(L, vj, 0, Math.sqrt(500 * 10), 500);
    const fastest = L / Math.sqrt((500 * 10) / Math.SQRT1_2);
    expect(r.cutMs).toBeLessThan(slowest * 1000);
    expect(r.cutMs).toBeGreaterThan(fastest * 1000);
  });

  it('a block-rate floor slows dense tiny segments', () => {
    const lines = ['G1 F6000'];
    for (let i = 1; i <= 1000; i++) lines.push(`G1 X${(i * 0.01).toFixed(2)}`);
    const src = lines.join('\n') + '\n';
    expect(est(src).knownMs).toBeLessThan(1000);
    expect(est(src, m({ blockRate: 100 })).knownMs).toBeGreaterThanOrEqual(10_000);
  });

  it('rapids: coordinated at the rapid rate, or each axis on its own', () => {
    const coord = est('G0 X1000 Y1000\n', m({ rapidRate: 6000 }));
    // Coordinated along the diagonal at 100 mm/s.
    expect(coord.rapidMs).toBe(
      Math.floor(segmentTime(1000 * Math.SQRT2, 0, 0, 100, 500 * Math.SQRT2) * 1000 + 0.5),
    );
    const perAxis = est('G0 X1000 Y1000\n', m({ rapidModel: 'per-axis' }));
    expect(perAxis.rapidMs).toBe(
      Math.floor(segmentTime(1000, 0, 0, 10_000 / 60, 500) * 1000 + 0.5),
    );
  });

  it('an axis the machine does not describe is unknown', () => {
    const r = est('G1 A90 F100\n');
    expect(r.unknowns.map((x) => x.reason)).toEqual(['AXIS_NOT_DESCRIBED']);
    expect(r.complete).toBe(false);
  });
});

describe('estimateTime: feeds it cannot turn into a speed', () => {
  it('inverse time: 60/F seconds per move', () => {
    expect(est('G93 G1 X10 F6\n').cutMs).toBe(10_000);
  });

  it('per revolution needs the spindle speed', () => {
    expect(est('S1000 M3\nG95 G1 X100 F0.1\n').complete).toBe(true);
    const r = est('G95 G1 X100 F0.1\n');
    expect(r.unknowns.map((x) => x.reason)).toEqual(['RPM_UNKNOWN']);
  });

  it('F0 under inverse time, or a stopped spindle under per-rev, is unknown, never Infinity', () => {
    // The interpreter refuses the line; passed the whole result, the estimate says so.
    const g93 = est('G93 G1 X10 F0\n');
    expect(g93.unknowns.map((x) => x.reason)).toEqual(['LINE_REFUSED']);
    expect(g93.complete).toBe(false);
    expect(Number.isFinite(g93.knownMs)).toBe(true);
    expect(g93.totalMs).toBeNull();
    const g95 = est('S0 M3\nG95 G1 X100 F0.1\n');
    expect(g95.unknowns.map((x) => x.reason)).toEqual(['RPM_UNKNOWN']);
  });

  it('a Masso move before any F is unknown, never guessed', () => {
    const r = est('G1 X100\n', MACHINE, { dialect: MASSO_G3 });
    expect(r.unknowns).toEqual([{ line: 1, reason: 'FEED_UNSPECIFIED' }]);
    expect(r.complete).toBe(false);
    expect(r.cutMs).toBe(0);
  });

  it('a wait for an input is unknown', () => {
    const r = est('M66 P1 L3 Q5\n', MACHINE, { dialect: MASSO_G3 });
    expect(r.unknowns.map((x) => x.reason)).toContain('WAIT_FOR_INPUT');
  });
});

describe('estimateTime: events', () => {
  const ev = m({
    spinUpSeconds: 8,
    spinDownSeconds: 6,
    toolChangeSeconds: 60,
    programStartSeconds: 30,
    pauseSeconds: 20,
  });

  it('adds spin-up, spin-down, tool changes, pauses, dwells and the program start', () => {
    const r = est('T1 M6\nS1000 M3\nG4 P2\nM0\nM5\nM30\n', ev);
    expect(r.eventMs).toBe((30 + 60 + 8 + 20 + 6) * 1000);
    expect(r.dwellMs).toBe(2000);
    expect(r.knownMs).toBe(126_000);
  });

  it('M1 and spindle-speed changes are 0 by default, overridable, and noted', () => {
    const src = 'S1000 M3\nM1\nS2000\nM5\n';
    const r = estimateTime(interpret(parse(src)).steps, MACHINE);
    expect(r.eventMs).toBe(0);
    expect(r.notes.join('\n')).toMatch(/optional stop.*0 s/);
    expect(r.notes.join('\n')).toMatch(/speed change.*0 s/);
    const r2 = estimateTime(interpret(parse(src)).steps, MACHINE, {
      optionalStopSeconds: 15,
      speedChangeSeconds: 3,
    });
    expect(r2.eventMs).toBe(18_000);
  });

  it('notes an unconfirmed rapid model and a machine not calibrated', () => {
    const r = est('G0 X1\n', m({ rapidModelConfirmed: false }));
    expect(r.notes.join('\n')).toMatch(/rapids modelled as coordinated, not yet measured/);
    expect(r.notes.join('\n')).toMatch(/not calibrated/);
    expect(r.calibrated).toBe(false);
  });
});

describe('estimateTime: calibration and rounding', () => {
  it('the time factor scales everything', () => {
    const base = est('G1 X1000 F6000\n').knownMs;
    const cal = est('G1 X1000 F6000\n', m({ calibration: { timeFactor: 1.1, accelFactor: 1 } }));
    expect(cal.knownMs).toBe(Math.floor(base * 1.1 + 0.5));
    expect(cal.calibrated).toBe(true);
  });

  it('the acceleration factor scales acceleration', () => {
    const slow = est('G1 X10 F6000\n', m({ calibration: { timeFactor: 1, accelFactor: 0.5 } }));
    expect(slow.knownMs).toBeGreaterThan(est('G1 X10 F6000\n').knownMs);
  });

  it('rounds once, halves up, and the total from the unrounded sum', () => {
    // Two dwells of 0.0005 s: each rounds to 1 ms alone, the total to 1 ms too.
    const r = est('G4 P0.0005\nG4 P0.0005\n');
    expect(r.dwellMs).toBe(1);
    expect(r.knownMs).toBe(1);
  });

  it('a golden value: the same total on every platform', () => {
    // Arcs, corners, a helix, rapids, a look-ahead window and a block-rate floor. If
    // this changes, the estimator's numbers changed: that must be deliberate.
    const src = [
      'G21 G90 G17 F2400 S18000 M3',
      'G0 X10 Y10 Z5',
      'G1 Z-2',
      'G1 X110 Y10',
      'G2 X110 Y60 I0 J25',
      'G1 X10 Y60',
      'G3 X10 Y10 I0 J-25 Z-4',
      'G0 Z5',
      'M5',
      'M30',
    ].join('\n');
    const machine = m({
      lookahead: 16,
      blockRate: 400,
      rapidRate: 8000,
      spinUpSeconds: 8,
      spinDownSeconds: 8,
      calibration: { timeFactor: 1.05, accelFactor: 0.9 },
    });
    expect(est(src, machine).knownMs).toMatchInlineSnapshot(`27287`);
  });

  it('is deterministic', () => {
    const src = 'G1 X10 Y3 F3000\nG2 X20 Y3 I5 J0\nG1 Z-5\nG0 Z5\n';
    expect(est(src)).toEqual(est(src));
  });
});

describe('estimateTime: guards', () => {
  const steps = interpret(parse('G1 X10 F100\n')).steps;
  it.each([
    [
      'acceleration 0',
      m({ axes: { X: { maxVelocity: 1000, acceleration: 0 }, Y: AXIS, Z: AXIS } }),
    ],
    ['maxVelocity 0', m({ axes: { X: { maxVelocity: 0, acceleration: 500 }, Y: AXIS, Z: AXIS } })],
    ['accelFactor 0', m({ calibration: { timeFactor: 1, accelFactor: 0 } })],
    ['timeFactor NaN', m({ calibration: { timeFactor: Number.NaN, accelFactor: 1 } })],
    ['junctionDeviation below 0', m({ junctionDeviation: -1 })],
    ['lookahead 2.5', m({ lookahead: 2.5 })],
    ['lookahead 0 (say unlimited by leaving it out)', m({ lookahead: 0 })],
    ['blockRate 0', m({ blockRate: 0 })],
    ['a negative event time', m({ pauseSeconds: -1 })],
  ])('refuses %s', (_, machine) => {
    expect(() => estimateTime(steps, machine)).toThrow(RangeError);
  });

  it('names what a JavaScript caller got wrong (review of #72)', () => {
    const asIs = (o: object) => o as unknown as EstimateMachine;
    const cases: [object, RegExp][] = [
      [{ ...m(), rapidModel: 'peraxis' }, /rapidModel must be/],
      [{ ...m(), rapidModelConfirmed: 'yes' }, /rapidModelConfirmed/],
      [{ ...m(), spinUpSeconds: undefined }, /spinUpSeconds is required/],
      [{ ...m(), calibration: undefined }, /calibration is required/],
      [{ ...m(), axes: { X: AXIS, Y: AXIS } }, /axes\.Z is required/],
      [
        { ...m(), axes: { X: { maxVelocity: 1000 }, Y: AXIS, Z: AXIS } },
        /X\.acceleration is required/,
      ],
    ];
    for (const [machine, message] of cases) {
      expect(() => estimateTime(steps, asIs(machine))).toThrow(message);
    }
  });

  it('an incomplete estimate has no total, only the known part', () => {
    const r = est('G1 X100 F6000\nG95 G1 X200 F0.1\n');
    expect(r.complete).toBe(false);
    expect(r.totalMs).toBeNull();
    expect(r.knownMs).toBeGreaterThan(0);
  });

  it('a per-rev feed after M5 is unknown: a stopped spindle has no speed', () => {
    const r = est('S1000 M3\nM5\nG95 G1 X10 F0.1\n');
    expect(r.unknowns.map((x) => x.reason)).toEqual(['RPM_UNKNOWN']);
  });

  it('a per-axis rapid on an axis the machine does not describe is unknown, not a crash', () => {
    const r = est('G0 X100 A0.00000000001\n', m({ rapidModel: 'per-axis' }));
    expect(r.unknowns.map((x) => x.reason)).toEqual(['AXIS_NOT_DESCRIBED']);
  });

  it('per-tool time follows program order', () => {
    const r = est('T1 M6\nG1 X100 F6000\nG4 P1\nT2 M6\nG1 X0\n');
    expect(r.perTool.map((x) => x.tool)).toEqual([1, 2]);
  });
});

// ── Properties (plan §6): more capability is never slower ─────────────────

const program = fc
  .array(
    fc.tuple(
      fc.integer({ min: -300, max: 300 }),
      fc.integer({ min: -300, max: 300 }),
      fc.integer({ min: -20, max: 0 }),
    ),
    { minLength: 1, maxLength: 30 },
  )
  .map((pts) => `G1 F3000\n${pts.map(([x, y, z]) => `G1 X${x} Y${y} Z${z}`).join('\n')}\n`);

const total = (src: string, machine: EstimateMachine) => est(src, machine).knownMs;

describe('estimateTime: monotonic in every capability', () => {
  it.each([
    ['feed', (s: string) => s.replace('F3000', 'F6000'), (x: EstimateMachine) => x],
    [
      'acceleration',
      (s: string) => s,
      (x: EstimateMachine) =>
        m({
          ...x,
          axes: {
            X: { ...AXIS, acceleration: 1000 },
            Y: { ...AXIS, acceleration: 1000 },
            Z: { ...AXIS, acceleration: 1000 },
          },
        }),
    ],
    [
      'junction deviation',
      (s: string) => s,
      (x: EstimateMachine) => m({ ...x, junctionDeviation: 0.1 }),
    ],
    ['lookahead', (s: string) => s, (x: EstimateMachine) => m({ ...x, lookahead: 16 })],
    ['block rate', (s: string) => s, (x: EstimateMachine) => m({ ...x, blockRate: 1000 })],
  ])('more %s is never slower', (_, prog, better) => {
    const worse = m({ lookahead: 4, blockRate: 50 });
    fc.assert(
      fc.property(program, (src) => {
        expect(total(prog(src), better(worse))).toBeLessThanOrEqual(total(src, worse));
      }),
      { numRuns: 300 },
    );
  });
});

// ── The look-ahead approximation against an exact windowed plan ───────────

/**
 * The exact model the estimator approximates: each junction's speed lets the machine
 * stop by the end of the next L segments, honouring every junction cap among them
 * (a backward pass over that window from rest). O(n * L), for small L only.
 */
function exactLookaheadTime(
  pts: readonly (readonly [number, number])[],
  feed: number,
  axisAccel: number,
  delta: number,
  L: number,
): number {
  // Each segment's acceleration is the axis limit projected onto it, as the estimator's.
  const segs: { len: number; u: Float64Array; a: number }[] = [];
  let prev: readonly [number, number] = [0, 0];
  for (const p of pts) {
    const dx = p[0] - prev[0];
    const dy = p[1] - prev[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-12) {
      const ux = dx / len;
      const uy = dy / len;
      segs.push({ len, u: u(ux, uy), a: axisAccel / Math.max(Math.abs(ux), Math.abs(uy)) });
    }
    prev = p;
  }
  const n = segs.length;
  const seg = (i: number) => segs[i] as { len: number; u: Float64Array; a: number };
  const cap = new Float64Array(n + 1);
  for (let j = 1; j < n; j++) {
    const a = Math.min(seg(j - 1).a, seg(j).a);
    cap[j] = Math.min(junctionSpeed(seg(j - 1).u, seg(j).u, a, delta), feed);
  }
  const v = new Float64Array(n + 1);
  // For each junction, a backward pass from rest over its window, honouring every cap.
  for (let j = 1; j < n; j++) {
    const end = Math.min(n, j + L);
    let w = 0;
    for (let k = end - 1; k >= j; k--) {
      w = Math.sqrt(w * w + 2 * seg(k).a * seg(k).len);
      if (k > j) w = Math.min(w, cap[k] as number);
    }
    v[j] = Math.min(cap[j] as number, w);
  }
  // The global passes, as the estimator does.
  for (let j = n - 1; j >= 0; j--)
    v[j] = Math.min(
      v[j] as number,
      Math.sqrt((v[j + 1] as number) ** 2 + 2 * seg(j).a * seg(j).len),
    );
  for (let j = 0; j < n; j++)
    v[j + 1] = Math.min(
      v[j + 1] as number,
      Math.sqrt((v[j] as number) ** 2 + 2 * seg(j).a * seg(j).len),
    );
  let t = 0;
  for (let j = 0; j < n; j++)
    t += segmentTime(seg(j).len, v[j] as number, v[j + 1] as number, feed, seg(j).a);
  return t;
}

describe('estimateTime: the look-ahead window', () => {
  // Dense, nearly straight chains of short pieces at a high feed: the only shape where a
  // window binds (with long segments and slow corners, stopping distances are tiny and
  // the window never matters, which made an earlier version of this test vacuous).
  const chain = fc
    .tuple(
      fc.array(
        fc.tuple(
          fc.double({ min: 0.1, max: 3, noNaN: true }),
          fc.double({ min: -0.08, max: 0.08, noNaN: true }),
        ),
        { minLength: 2, maxLength: 80 },
      ),
      fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
    )
    .map(([pieces, heading]) => {
      let x = 0;
      let y = 0;
      let h = heading;
      return pieces.map(([len, turn]) => {
        h += turn;
        x += len * Math.cos(h);
        y += len * Math.sin(h);
        return [Number(x.toFixed(4)), Number(y.toFixed(4))] as const;
      });
    });
  const fast = { maxVelocity: 1e9, acceleration: 500 };
  const machineL = (L?: number) =>
    m({ ...(L !== undefined ? { lookahead: L } : {}), axes: { X: fast, Y: fast, Z: AXIS } });

  it('equals an exact windowed plan, O(n * L), for L from 1 to 32, and binds', () => {
    let runs = 0;
    let bound = 0;
    fc.assert(
      fc.property(chain, fc.integer({ min: 1, max: 32 }), (pts, L) => {
        const src = `G1 F60000\n${pts.map(([x, y]) => `G1 X${x} Y${y}`).join('\n')}\n`;
        const steps = interpret(parse(src)).steps;
        const windowed = estimateTime(steps, machineL(L)).cutMs / 1000;
        const unlimited = estimateTime(steps, machineL()).cutMs / 1000;
        const exact = exactLookaheadTime(pts, 1000, 500, 0.02, L);
        // Exact up to the estimator's one rounding (to the millisecond).
        expect(Math.abs(windowed - exact)).toBeLessThanOrEqual(0.0005 + 1e-9);
        runs++;
        if (windowed > unlimited + 0.0005) bound++;
      }),
      { numRuns: 1000, seed: 20261024 },
    );
    // Not vacuous: in a fair share of runs the window really slowed the plan.
    expect(bound).toBeGreaterThan(runs * 0.05);
  });
});

describe('estimateTime: performance', () => {
  // Steps built directly (parsing a 160k-line program would dominate the time), with
  // its own timeout: this checks the shape (linear), not the speed of the runner.
  const steps = (n: number): Step[] => {
    const out: Step[] = [];
    const zero = { X: 0, Y: 0, Z: 0, A: 0, B: 0, C: 0 };
    let from = zero;
    for (let i = 0; i < n; i++) {
      const to = { ...zero, X: i % 500, Y: (i * 7) % 400 };
      out.push({
        kind: 'linear',
        line: i + 1,
        rapid: false,
        from,
        to,
        feed: { mode: 'per-minute', mmPerMinute: 6000 },
        offset: zero,
      });
      from = to;
    }
    return out;
  };
  it('is linear in the number of moves', () => {
    const small = steps(10_000);
    const big = steps(160_000);
    const time = (input: Step[], machine: EstimateMachine) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t = performance.now();
        estimateTime(input, machine);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const machine = m({ lookahead: 200 });
    expect(time(big, machine) / time(small, machine)).toBeLessThan(16 * 4);
  }, 60_000);
});

describe('estimateTime: arcs in pieces (ADR-0043)', () => {
  /** A router-like machine: fast X and Y, a slow Z (velocity and acceleration). */
  const ROUTER = m({
    axes: {
      X: { maxVelocity: 20_000, acceleration: 1800 },
      Y: { maxVelocity: 20_000, acceleration: 1200 },
      Z: { maxVelocity: 3000, acceleration: 300 },
    },
  });
  /** G-code for an arc approximated by `deg`-degree chords, for comparison. */
  const chords = (cx: number, cz: number, r: number, from: number, to: number, deg: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(to - from) / deg));
    const out: string[] = [];
    for (let k = 1; k <= n; k++) {
      const t = ((from + ((to - from) * k) / n) * Math.PI) / 180;
      // ZX plane: the angle runs from Z towards X.
      out.push(`G1 X${(cx + r * Math.sin(t)).toFixed(5)} Z${(cz + r * Math.cos(t)).toFixed(5)}`);
    }
    return out.join('\n');
  };

  it('pieces are at most ARC_PIECE_DEGREES', () => {
    expect(ARC_PIECE_DEGREES).toBe(2);
  });

  it("each piece's shares are never below the tangent's and the normal's anywhere in it", () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: 0, max: 0.5, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (lo, width, f) => {
          const hi = lo + width;
          const s = arcPieceShares(lo, hi, f);
          for (let i = 0; i <= 64; i++) {
            const t = lo + (width * i) / 64;
            const tol = 1e-12;
            expect(s.tangent[0] + tol).toBeGreaterThanOrEqual(f * Math.abs(Math.sin(t)));
            expect(s.tangent[1] + tol).toBeGreaterThanOrEqual(f * Math.abs(Math.cos(t)));
            expect(s.normal[0] + tol).toBeGreaterThanOrEqual(Math.abs(Math.cos(t)));
            expect(s.normal[1] + tol).toBeGreaterThanOrEqual(Math.abs(Math.sin(t)));
          }
          // And tight: the max is attained at an end or a peak inside.
          const ends = [lo, hi].map((t) => Math.abs(Math.sin(t)));
          expect(s.tangent[0] / f).toBeGreaterThanOrEqual(Math.max(...ends) - 1e-12);
        },
      ),
    );
  });

  it('a G18 roundover arc runs fast where X carries it: well under the old whole-arc-at-Z figure', () => {
    // R35 from level (top) to near vertical (88.4 degrees), F5400: a roundover stroke.
    const src = 'G18 G90 G0 X88 Y0 Z0\nG1 F5400\nG3 X122.98571 Z-34 I0 K-35\n';
    const r = est(src, ROUTER);
    const L = 35 * Math.acos(1 / 35);
    // The whole arc at Z's 50 mm/s is what the one-limit-set model gave; X's 90 mm/s
    // (the feed) is the bound from below.
    expect(r.cutMs).toBeLessThan((L / 50) * 1000);
    expect(r.cutMs).toBeGreaterThan((L / 90) * 1000);
  });

  it('agrees with fine chords of the same arc (within 1%), and coarse chords only add corners', () => {
    const head = 'G18 G90 G0 X88 Y0 Z0\nG1 F5400\n';
    const arc = est(head + 'G3 X122.98571 Z-34 I0 K-35\n', ROUTER).cutMs;
    const toDeg = (Math.acos(1 / 35) * 180) / Math.PI;
    const fine = est(head + chords(88, -35, 35, 0, toDeg, 0.5) + '\n', ROUTER).cutMs;
    const coarse = est(head + chords(88, -35, 35, 0, toDeg, 10) + '\n', ROUTER).cutMs;
    expect(Math.abs(arc - fine) / fine).toBeLessThan(0.01);
    expect(coarse).toBeGreaterThan(arc);
  });

  it('the centripetal cap uses the NORMAL: at the level end of a G18 arc the load is on Z', () => {
    // r 2, the first 10 degrees from the top: the tangent is on X, the normal on Z.
    // Z's acceleration 100 caps the speed at about sqrt(100 * 2) = 14 mm/s; give Z
    // plenty and the same arc runs at the 100 mm/s feed.
    const src = 'G18 G90 G1 X0 Y0 Z0 F6000\nG2 X0.34730 Z-0.03038 I0 K-2\n';
    const fast = { maxVelocity: 20_000, acceleration: 5000 };
    const slowZ = m({ axes: { X: fast, Y: fast, Z: { maxVelocity: 3000, acceleration: 100 } } });
    const quickZ = m({ axes: { X: fast, Y: fast, Z: { maxVelocity: 3000, acceleration: 5000 } } });
    const L = 2 * ((10 * Math.PI) / 180);
    expect(est(src, slowZ).cutMs).toBeGreaterThanOrEqual(
      Math.floor((L / Math.sqrt(100 * 2)) * 1000),
    );
    expect(est(src, quickZ).cutMs).toBeLessThan(est(src, slowZ).cutMs);
  });

  it('a piece boundary never dips: a long arc at a low feed runs at the feed throughout', () => {
    // r 100, 90 degrees, 10 mm/s: 45 pieces, each capped far above the feed.
    const L = (Math.PI / 2) * 100;
    const r = est('G1 X0 Y0 F600\nG2 X100 Y-100 I0 J-100\n');
    // Only the start and stop ramps (0.01 s each at 500 mm/s²) add to L / v.
    const t = r.cutMs / 1000;
    expect(t).toBeGreaterThanOrEqual(L / 10);
    expect(t).toBeLessThan(L / 10 + 0.05);
  });

  it('an XY arc on equal axes at a binding feed is unchanged by the pieces', () => {
    // The golden program's arcs: F2400, r 25, 500 mm/s²: the feed binds throughout.
    const L = Math.PI * 25;
    const r = est('G1 X0 Y0 F2400\nG2 X0 Y50 I0 J25\n');
    expect(r.cutMs).toBe(Math.floor(segmentTime(L, 0, 0, 40, 500) * 1000 + 0.5));
  });

  it('look-ahead counts blocks: an arc is one, however many pieces', () => {
    const circle = 'G1 X-10 Y0 F6000\nG2 X-10 Y0 I10 J0\n';
    expect(est(circle, m({ lookahead: 1 })).cutMs).toBe(est(circle).cutMs);
  });

  it('the block-rate floor is per arc, not per piece', () => {
    // A full circle is 180 pieces; at 0.1 blocks/s, one block takes 10 s, not 1800 s.
    const circle = 'G2 X0 Y0 I10 J0 F6000\n';
    expect(est(circle, m({ blockRate: 0.1 })).cutMs).toBe(10_000);
  });

  it('a helix: never faster than the same circle flat, and its rise counts on Z', () => {
    const flat = est('G1 X0 Y0 F3000\nG2 X0 Y0 I10 J0\n').cutMs;
    const helix = est('G1 X0 Y0 F3000\nG2 X0 Y0 Z-20 I10 J0\n').cutMs;
    expect(helix).toBeGreaterThan(flat);
  });

  it('a many-turn helix stays bounded (pieces capped) and finite', () => {
    const t0 = Date.now();
    const r = est('G1 X0 Y0 F3000\nG2 X0 Y0 Z-100 I5 J0 P100\n');
    expect(Date.now() - t0).toBeLessThan(2000);
    const L = Math.hypot(100 * 2 * Math.PI * 5, 100);
    expect(r.cutMs).toBeGreaterThanOrEqual(Math.floor((L / 50) * 1000));
    expect(r.complete).toBe(true);
  });
});
