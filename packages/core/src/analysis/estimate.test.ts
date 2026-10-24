// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
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

  it('a circle runs at its centripetal limit', () => {
    // r 10: sqrt(500 * 10) = 70.7 mm/s, below the 100 mm/s feed.
    const v = Math.sqrt(500 * 10);
    const L = 2 * Math.PI * 10;
    const r = est('G0 X-10\nG1 F6000\nG2 X-10 Y0 I10 J0\n');
    // The rapid blends in at the 90-degree corner speed; the circle ends at rest.
    const vj = junctionSpeed(u(-1, 0), u(0, 1), 500, 0.02);
    const arcOnly = segmentTime(L, vj, 0, v, 500);
    expect(r.cutMs).toBe(Math.floor(arcOnly * 1000 + 0.5));
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
