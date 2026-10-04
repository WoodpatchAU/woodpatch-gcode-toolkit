// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LINUXCNC_INTERPRETER_RULES,
  interpret,
  parse,
  type InterpretOptions,
  type Step,
} from '../index.js';

const run = (src: string, options?: InterpretOptions) => interpret(parse(src), options);
const moves = (steps: readonly Step[]) =>
  steps.flatMap((s) => (s.kind === 'linear' || s.kind === 'arc' ? [s] : []));
const ends = (src: string, options?: InterpretOptions) =>
  moves(run(src, options).steps).map((s) => [s.to.X, s.to.Y, s.to.Z]);
const codes = (src: string, options?: InterpretOptions) =>
  run(src, options).diagnostics.map((d) => d.code);

describe('motion basics', () => {
  it('produces rapid and feed moves in machine coordinates', () => {
    const r = run('G21 G90\nG0 X10 Y5\nG1 Z-1 F600\nX20');
    const m = moves(r.steps);
    expect(m.map((s) => s.kind === 'linear' && s.rapid)).toEqual([true, false, false]);
    expect(m.map((s) => [s.to.X, s.to.Y, s.to.Z])).toEqual([
      [10, 5, 0],
      [10, 5, -1],
      [20, 5, -1],
    ]);
    expect(m[1]).toMatchObject({ feed: { mode: 'per-minute', mmPerMinute: 600 } });
    expect(r.diagnostics).toEqual([]);
  });

  it('keeps every move, even a tiny or zero-length one (fixes R9)', () => {
    expect(ends('G21 G90 G1 F100\nX0.005\nX0.010\nX0.010')).toEqual([
      [0.005, 0, 0],
      [0.01, 0, 0],
      [0.01, 0, 0],
    ]);
  });

  it('converts inches to millimetres', () => {
    expect(ends('G20 G90\nG0 X1 Y0.5')).toEqual([[25.4, 12.7, 0]]);
  });

  it('moves incrementally in G91', () => {
    expect(ends('G21 G91\nG0 X10\nX10\nY-5')).toEqual([
      [10, 0, 0],
      [20, 0, 0],
      [20, -5, 0],
    ]);
  });

  it('refuses a feed move with no feed rate, and leaves the tool where it was (fixes N10)', () => {
    const r = run('G21 G90\nG1 X10\nG0 Y5');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_NO_FEED_RATE']);
    expect(moves(r.steps).map((s) => [s.to.X, s.to.Y])).toEqual([[0, 5]]);
  });
});

describe('order of execution (RS274/NGC, not line order)', () => {
  it("reads F BEFORE the line's G20/G21, as RS274 and LinuxCNC do, and warns that controllers differ", () => {
    // LinuxCNC: execute_block runs convert_feed_rate (step 3) before convert_length_units (step 12).
    const r = run('G21\nG20 G1 X1 F10');
    expect(moves(r.steps)[0]).toMatchObject({ feed: { mmPerMinute: 10 }, to: { X: 25.4 } });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_FEED_UNITS_AMBIGUOUS']);
    expect(r.diagnostics[0]!.message).toContain('mm/min');
  });

  it("reads F in the line's final units when the dialect says so", () => {
    const r = run('G21\nG20 G1 X1 F10', {
      interpreterRules: { ...LINUXCNC_INTERPRETER_RULES, feedUnits: 'end-of-line' },
    });
    expect(moves(r.steps)[0]).toMatchObject({ feed: { mmPerMinute: 254 } });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_FEED_UNITS_AMBIGUOUS']);
  });

  it('does not warn when the G20/G21 on the F line does not change units (the usual CAM header)', () => {
    expect(codes('G21 G90 G94 F1000\nG1 X10')).toEqual([]);
  });

  it('keeps an earlier feed physically the same across a unit change', () => {
    // As LinuxCNC re-reads the external feed on G20: the speed carries over; only the number is re-expressed.
    const [m] = moves(run('G21 F600\nG20\nG1 X1').steps);
    expect(m).toMatchObject({ feed: { mmPerMinute: 600 } });
  });

  it('applies plane, units and distance mode before the motion on the same line', () => {
    expect(ends('G21 G90\nG0 X10\nG1 F100 X5 G91')).toEqual([
      [10, 0, 0],
      [15, 0, 0],
    ]);
  });

  it("applies parameter assignments AFTER the line (LinuxCNC's own example)", () => {
    // "if parameter 3 has been previously set to 15 and the line #3=6 G1 X#3 is
    // interpreted, a straight move to a point where X equals 15 will occur"
    const r = run('G21 G90 F100\n#3=15\n#3=6 G1 X#3\nG1 X#3');
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([15, 6]);
  });
});

describe('work offsets, G53, G92, homes', () => {
  it('does not re-add a work offset on each incremental move (fixes R5)', () => {
    // The machine starts at machine X0. In G91, X1 means "1 mm from here", whatever the
    // offset, so the moves end at machine 1, 2, 3. Upstream re-added the offset each time
    // (101, 202, 303). Note: plan §2.2's "expected 101, 102, 103" assumed the tool starts
    // at work zero, which is not what this program says.
    expect(ends('G21\nG10 L2 P1 X100\nG54 G91 G1 F100\nX1\nX1\nX1').map((p) => p[0])).toEqual([
      1, 2, 3,
    ]);
    // From work zero (machine 100), the plan's numbers do come out:
    expect(
      ends('G21\nG10 L2 P1 X100\nG54 G90 G0 X0\nG91 G1 F100\nX1\nX1\nX1').map((p) => p[0]),
    ).toEqual([100, 101, 102, 103]);
  });

  it("switches coordinate systems and reports each move's offset", () => {
    const r = run('G21 G90\nG10 L2 P2 X50 Y10\nG55 G0 X0 Y0\nG54 G0 X0 Y0');
    const m = moves(r.steps);
    expect(m.map((s) => [s.to.X, s.to.Y])).toEqual([
      [50, 10],
      [0, 0],
    ]);
    expect(m[0]!.offset).toMatchObject({ X: 50, Y: 10 });
  });

  it('G10 L20 sets the offset that makes the current position read the given value', () => {
    const r = run('G21 G90\nG0 X30\nG10 L20 P1 X0\nG0 X5');
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([30, 35]);
  });

  it('G53 moves in MACHINE coordinates, ignoring offsets (fixes N5)', () => {
    const r = run('G21 G90\nG10 L2 P1 X50\nG54\nG53 G0 X0\nG0 X0');
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([0, 50]);
    expect(r.diagnostics).toEqual([]);
  });

  it.todo(
    'G92 and G10 L20 subtract the tool length offset on Z once tool tables exist (LinuxCNC convert_axis_offsets)',
  );

  it('G92 offsets, and G92.1 cancels them', () => {
    const r = run('G21 G90\nG0 X10\nG92 X0\nG0 X5\nG92.1\nG0 X5');
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([10, 15, 5]);
  });

  it('G28 rapids via the intermediate point to the stored home, and says when home was never set (fixes N6)', () => {
    const r = run('G21 G90\nG0 X10 Z10\nG28 Z20');
    expect(moves(r.steps).map((s) => [s.to.X, s.to.Z])).toEqual([
      [10, 10],
      [10, 20], // intermediate point
      [10, 0], // stored home for Z only (unset: machine origin)
    ]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_HOME_UNSET_5161']);
  });

  it('G28.1 stores home, and G28 with no axis words returns every axis there', () => {
    const r = run('G21 G90\nG0 X5 Y6 Z7\nG28.1\nG0 X0 Y0 Z0\nG28');
    expect(moves(r.steps).at(-1)!.to).toMatchObject({ X: 5, Y: 6, Z: 7 });
    expect(r.diagnostics).toEqual([]);
  });

  it("exposes offsets through LinuxCNC's parameter numbers", () => {
    const r = run('G21 G90 F100\nG10 L2 P1 X12\n#100=#5221\nG1 X#100');
    // G54 X offset 12, and moving to work X12 is machine X24.
    expect(moves(r.steps)[0]!.to.X).toBe(24);
  });
});

describe('arcs (described here; resolved and validated by the geometry layer)', () => {
  it('turns I/J into an absolute centre, incremental by default', () => {
    const [a] = moves(run('G21 G90 F100\nG0 X10\nG2 X0 Y10 I-10 J0').steps).slice(1);
    expect(a).toMatchObject({
      kind: 'arc',
      clockwise: true,
      plane: 'XY',
      centre: { X: 0, Y: 0 },
      radius: 10,
      endRadius: 10,
      turns: 1,
    });
    // Clockwise from 0° round to 90°: three quarters of a turn.
    expect(a?.kind === 'arc' && a.sweep).toBeCloseTo((-3 * Math.PI) / 2, 12);
  });

  it('reads absolute centres in G90.1', () => {
    const [, a] = moves(run('G21 G90 G90.1 F100\nG0 X10\nG3 X0 Y0 I5 J0').steps);
    expect(a).toMatchObject({ centre: { X: 5, Y: 0 }, clockwise: false, radius: 5 });
    expect(a?.kind === 'arc' && a.sweep).toBeCloseTo(Math.PI, 12);
  });

  it('resolves R arcs: positive R the minor arc, negative the major (Masso T16)', () => {
    const arc = (r: number) => moves(run(`G21 G90 F100\nG0 X10\nG2 X0 Y10 R${r}`).steps)[1];
    const minor = arc(10);
    const major = arc(-10);
    expect(minor?.kind === 'arc' && [minor.centre.X, minor.centre.Y]).toEqual([10, 10]);
    expect(minor?.kind === 'arc' && minor.sweep).toBeCloseTo(-Math.PI / 2, 12);
    expect(major?.kind === 'arc' && major.centre.X).toBeCloseTo(0, 12);
    expect(major?.kind === 'arc' && major.centre.Y).toBeCloseTo(0, 12);
    expect(major?.kind === 'arc' && major.sweep).toBeCloseTo((-3 * Math.PI) / 2, 12);
    expect(major).toMatchObject({ radius: 10 });
  });

  it('runs a centre-format full circle with no axis words (fixes R3)', () => {
    const [, a] = moves(run('G21 G90 F100\nG1 X10\nG2 I-5').steps);
    expect(a).toMatchObject({ kind: 'arc', from: { X: 10 }, to: { X: 10 }, centre: { X: 5 } });
  });

  it("uses the plane's own offset letters", () => {
    const [, a] = moves(run('G21 G90 G18 F100\nG1 X10\nG2 X0 Z10 I-10 K0').steps);
    expect(a).toMatchObject({ plane: 'ZX', centre: { X: 0, Z: 0 } });
  });

  it('reports arcs it cannot describe', () => {
    expect(codes('G21 G90 F100\nG2 X10 Y0')).toContain('SEMANTIC_ARC_NO_CENTRE');
    expect(codes('G21 G90 F100\nG2 X10 R5 I5')).toContain('SEMANTIC_ARC_R_AND_IJK');
    expect(codes('G21 G90 F100\nG2 R5')).toContain('SEMANTIC_ARC_R_FULL_CIRCLE');
  });

  it('takes P as full turns', () => {
    expect(moves(run('G21 G90 F100\nG2 X0 Y0 I5 P3').steps)[0]).toMatchObject({ turns: 3 });
  });
});

describe('lines that cannot run are reported, and the tool stays put', () => {
  it('rejects repeated words (fixes N3)', () => {
    const r = run('G21 G90 F100\nG1 X5 X10');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_REPEATED_WORD']);
    expect(moves(r.steps)).toEqual([]);
  });

  it('rejects unsupported codes, instead of moving anyway (fixes N5/N6 behaviour)', () => {
    const r = run('G21 G90\nG0 X10\nG12 X20');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_UNSUPPORTED_CODE']);
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([10]);
  });

  it('names what is not implemented yet (G84-G89) instead of drawing something wrong', () => {
    const r = run('G21 G90\nG0 Z5\nG85 X10 Y10 Z-5 R1 F100');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_NOT_YET_SUPPORTED']);
    expect(moves(r.steps)).toHaveLength(1);
  });

  it('rejects two codes from one modal group, and a group-0/motion clash', () => {
    expect(codes('G0 G1 X1')).toEqual(['SEMANTIC_MODAL_GROUP_CONFLICT']);
    expect(codes('G92 X0 G1 Y1 F100')).toEqual(['SEMANTIC_AXIS_WORDS_CONFLICT']);
  });

  it('rejects E, with a hint about exponents (fixes R6)', () => {
    const program = parse('G21 G90 F100\nG1 X1e3');
    expect(program.diagnostics.map((d) => d.code)).toEqual(['SYNTAX_POSSIBLE_EXPONENT']);
    const r = interpret(program); // syntax findings stay on the Program; these are the interpreter's own
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_UNSUPPORTED_WORD']);
    expect(moves(r.steps)).toEqual([]);
  });

  it('does not run a line with syntax errors or evaluation errors', () => {
    expect(codes('G1 X[1/0] F100')).toContain('SEMANTIC_LINE_NOT_RUN');
    expect(codes('G1 X[1+ F100')).toContain('SEMANTIC_LINE_NOT_RUN');
  });

  it('never throws on the whole corpus', () => {
    const dir = fileURLToPath(new URL('../../../../fixtures/', import.meta.url));
    for (const sub of ['synthetic', 'upstream']) {
      for (const f of readdirSync(join(dir, sub)).filter((x) => /\.(ngc|nc)$/.test(x))) {
        expect(() => run(readFileSync(join(dir, sub, f), 'utf8'))).not.toThrow();
      }
    }
  });
});

describe('events and program end', () => {
  it('emits spindle, coolant, tool change, dwell and pause steps', () => {
    const r = run('G21\nT2 M6\nS12000 M3\nM7 M8\nG4 P1.5\nM1\nM9 M5');
    expect(r.steps.map((s) => s.kind)).toEqual([
      'tool-change',
      'spindle',
      'coolant',
      'dwell',
      'pause',
      'spindle',
      'coolant',
    ]);
    expect(r.steps[0]).toMatchObject({ tool: 2 });
    expect(r.steps[1]).toMatchObject({ state: 'cw', rpm: 12000 });
    expect(r.steps[2]).toMatchObject({ mist: true, flood: true });
    expect(r.steps[3]).toMatchObject({ seconds: 1.5 });
    expect(r.diagnostics).toEqual([]);
  });

  it('a tool change stops the spindle; M6 M3 on one line ends with it running', () => {
    const r = run('G21\nT1 M6\nS12000 M3\nT2 M6\nM3\nT3 M6 M3');
    expect(r.steps.map((s) => (s.kind === 'spindle' ? `spindle ${s.state}` : s.kind))).toEqual([
      'tool-change',
      'spindle cw',
      'tool-change',
      'spindle off',
      'spindle cw',
      'tool-change',
      'spindle off',
      'spindle cw',
    ]);
    expect(r.steps[3]).toMatchObject({ by: 'tool-change', rpm: 12000 });
    expect(r.state.spindle.state).toBe('cw');
    // Stopped already: no extra step.
    expect(run('G21\nT1 M6\nT2 M6').steps.map((s) => s.kind)).toEqual([
      'tool-change',
      'tool-change',
    ]);
  });

  it('stops at M2/M30 and reports what was not run (fixes R8)', () => {
    const r = run('G21 G90 F100\nG1 X10\nM30\nG1 X20\nG1 X30');
    expect(moves(r.steps).map((s) => s.to.X)).toEqual([10]);
    expect(r.steps.at(-1)).toMatchObject({ kind: 'end', by: 'M30' });
    expect(r.diagnostics).toMatchObject([{ code: 'SEMANTIC_AFTER_PROGRAM_END', line: 4 }]);
  });

  it('skips block-deleted lines when the switch is on (default), and runs them when off', () => {
    expect(ends('G21 G90 F100\n/G1 X20\nG1 X30').map((p) => p[0])).toEqual([30]);
    expect(ends('G21 G90 F100\n/G1 X20\nG1 X30', { blockDelete: false }).map((p) => p[0])).toEqual([
      20, 30,
    ]);
  });

  it('warns that cutter compensation is not simulated (ADR-0016)', () => {
    const r = run('G21 G90 F100\nG41 D1\nG1 X10\nG40');
    expect(r.diagnostics.map((d) => d.code)).toEqual(['SEMANTIC_CUTTER_COMP_NOT_APPLIED']);
    expect(moves(r.steps)[0]!.to.X).toBe(10);
  });

  it('warns about words that have no effect', () => {
    expect(codes('G21 G90 F100\nG1 X1 R5')).toEqual(['SEMANTIC_UNUSED_WORD']);
  });

  it('needs F on every feed move in inverse-time mode', () => {
    expect(codes('G21 G90 G93\nG1 X1 F2\nG1 X2')).toEqual(['SEMANTIC_NO_FEED_RATE']);
  });
});

/** Canned-cycle moves as [rapid|feed, X, Y, Z] rows, for comparison with LinuxCNC's worked examples. */
const path = (src: string, options?: InterpretOptions) =>
  moves(run(src, options).steps).map((m) => [
    m.kind === 'linear' && m.rapid ? 'rapid' : 'feed',
    +m.to.X.toFixed(4),
    +m.to.Y.toFixed(4),
    +m.to.Z.toFixed(4),
  ]);
const start = { X: 1, Y: 2, Z: 3 };

describe('canned cycles (LinuxCNC interp_cycles.cc; fixes R4)', () => {
  it('G81, LinuxCNC example 1: absolute, G98', () => {
    // "A rapid move parallel to the XY plane to (X4, Y5); a rapid move parallel to the Z-axis
    // to (Z2.8); move ... at the feed rate to (Z1.5); a rapid move ... to (Z3)"
    expect(path('G21 F100\nG90 G98 G81 X4 Y5 Z1.5 R2.8', { start })).toEqual([
      ['rapid', 4, 5, 3],
      ['rapid', 4, 5, 2.8],
      ['feed', 4, 5, 1.5],
      ['rapid', 4, 5, 3],
    ]);
  });

  it('G81, LinuxCNC example 2: incremental, G98, L3, move for move', () => {
    expect(path('G21 F100\nG91 G98 G81 X4 Y5 Z-0.6 R1.8 L3', { start })).toEqual([
      ['rapid', 1, 2, 4.8], // preliminary: OLD_Z < clear Z
      ['rapid', 5, 7, 4.8],
      ['feed', 5, 7, 4.2],
      ['rapid', 5, 7, 4.8],
      ['rapid', 9, 12, 4.8],
      ['feed', 9, 12, 4.2],
      ['rapid', 9, 12, 4.8],
      ['rapid', 13, 17, 4.8],
      ['feed', 13, 17, 4.2],
      ['rapid', 13, 17, 4.8],
    ]);
  });

  it('G99 retracts to R; later lines reuse the sticky R and Z', () => {
    expect(path('G21 G90 F100\nG0 Z10\nG99 G81 X0 Y0 Z-2 R2\nX5').slice(1)).toEqual([
      ['rapid', 0, 0, 10],
      ['rapid', 0, 0, 2],
      ['feed', 0, 0, -2],
      ['rapid', 0, 0, 2], // G99: back to R
      ['rapid', 5, 0, 2], // next hole: traverse at the clearance plane (R)
      ['feed', 5, 0, -2],
      ['rapid', 5, 0, 2],
    ]);
  });

  it('G82 dwells at the bottom (P in seconds; in ms under a Masso-style rule)', () => {
    const src = 'G21 G90 F100\nG0 Z5\nG98 G82 X0 Y0 Z-1 R1 P2';
    expect(run(src).steps.find((s) => s.kind === 'dwell')).toMatchObject({ seconds: 2 });
    const ms = {
      interpreterRules: { ...LINUXCNC_INTERPRETER_RULES, dwellUnits: 'milliseconds' as const },
    };
    expect(
      run('G21 G90 F100\nG0 Z5\nG98 G82 X0 Y0 Z-1 R1 P2000', ms).steps.find(
        (s) => s.kind === 'dwell',
      ),
    ).toMatchObject({ seconds: 2 });
    expect(run('G21\nG4 P1500', ms).steps[0]).toMatchObject({ kind: 'dwell', seconds: 1.5 });
  });

  it('G83 pecks: feed Q, rapid out to R, rapid back to just above the last depth', () => {
    expect(path('G21 G90 F100\nG0 Z5\nG98 G83 X0 Y0 Z-5 R2 Q2').slice(1)).toEqual([
      ['rapid', 0, 0, 5],
      ['rapid', 0, 0, 2],
      ['feed', 0, 0, 0],
      ['rapid', 0, 0, 2],
      ['rapid', 0, 0, 0.254],
      ['feed', 0, 0, -2],
      ['rapid', 0, 0, 2],
      ['rapid', 0, 0, -1.746],
      ['feed', 0, 0, -4],
      ['rapid', 0, 0, 2],
      ['rapid', 0, 0, -3.746],
      ['feed', 0, 0, -5],
      ['rapid', 0, 0, 5], // G98: back to the initial level
    ]);
  });

  it('G73 pecks with a small back-off (0.254 mm LinuxCNC; 1.0 mm under a Masso-style rule)', () => {
    const src = 'G21 G90 F100\nG0 Z5\nG99 G73 X0 Y0 Z-3 R1 Q2';
    expect(path(src).slice(3)).toEqual([
      ['feed', 0, 0, -1],
      ['rapid', 0, 0, -0.746],
      ['feed', 0, 0, -3],
      ['rapid', 0, 0, 1],
    ]);
    const masso = { interpreterRules: { ...LINUXCNC_INTERPRETER_RULES, g73Retract: 1 } };
    expect(path(src, masso)[4]).toEqual(['rapid', 0, 0, 0]);
  });

  it('repeats at the same position when the dialect says so (Masso K)', () => {
    const masso = {
      interpreterRules: {
        ...LINUXCNC_INTERPRETER_RULES,
        cycleRepeat: { letter: 'K' as const, stepInIncremental: false },
      },
    };
    const holes = path('G21 F100\nG91 G98 G81 X4 Y5 Z-0.6 R1.8 K3', { start, ...masso }).filter(
      (m) => m[0] === 'feed',
    );
    expect(holes.map((m) => [m[1], m[2]])).toEqual([
      [5, 7],
      [5, 7],
      [5, 7],
    ]);
  });

  it('starts a new initial level after an ordinary move', () => {
    const p = path('G21 G90 F100\nG0 Z5\nG98 G81 X0 Y0 Z-1 R1\nG0 Z8\nG81 X5 Y0 Z-1 R1');
    expect(p.at(-1)).toEqual(['rapid', 5, 0, 8]); // G98 now returns to 8, not 5
  });

  it.each([
    ['G21 G90 F100\nG81 X0 Y0 Z-1', 'SEMANTIC_CYCLE_NO_R'],
    ['G21 G90 F100\nG81 X0 Y0 R1', 'SEMANTIC_CYCLE_NO_Z'],
    ['G21 G90 F100\nG81 X0 Y0 Z2 R1', 'SEMANTIC_CYCLE_R_BELOW_Z'],
    ['G21 G90 F100\nG83 X0 Y0 Z-1 R1', 'SEMANTIC_CYCLE_NO_Q'],
    ['G21 G90 F100\nG83 X0 Y0 Z-1 R1 Q0', 'SEMANTIC_CYCLE_BAD_Q'],
    ['G21 G90 F100\nG82 X0 Y0 Z-1 R1', 'SEMANTIC_CYCLE_NO_P'],
    ['G21 G90\nG81 X0 Y0 Z-1 R1', 'SEMANTIC_NO_FEED_RATE'],
    ['G21 G90 G93\nG81 X0 Y0 Z-1 R1 F2', 'SEMANTIC_CYCLE_INVERSE_TIME'],
    ['G21 G90 F100 G41 D1\nG81 X0 Y0 Z-1 R1', 'SEMANTIC_CYCLE_CUTTER_COMP'],
    ['G21 G90 F100 G18\nG81 X0 Y0 Z-1 R1', 'SEMANTIC_CYCLE_PLANE'],
    ['G21 G90 F100\nG81 X0 Y0 Z-1 R1 L0', 'SEMANTIC_CYCLE_REPEAT'],
  ])('%s → %s, and no motion', (src, code) => {
    const r = run(src);
    expect(r.diagnostics.map((d) => d.code)).toContain(code);
    expect(moves(r.steps)).toEqual([]);
  });
});

describe('fast path', () => {
  // Bracketing every axis and feed number ([1.5] for 1.5) means the same thing but
  // forces the general path, so the two paths must give identical results.
  const bracketed = (src: string) => src.replace(/([XYZABCF])(-?[0-9.]+)/gi, '$1[$2]');
  const dir = fileURLToPath(new URL('../../../../fixtures/upstream/', import.meta.url));

  it.each(['tux.ngc', 'webgcode.ngc', 'test_pycam.ngc', 'aztec_calendar.ngc'])(
    'gives the same steps and diagnostics as the general path: %s',
    (f) => {
      const src = readFileSync(join(dir, f), 'utf8').split('\n').slice(0, 30000).join('\n');
      const fast = run(src);
      const general = run(bracketed(src));
      expect(general.steps.length).toBe(fast.steps.length);
      expect(general.steps).toEqual(fast.steps);
      expect(general.diagnostics).toEqual(fast.diagnostics);
      expect(general.state).toEqual(fast.state);
    },
  );

  it('ends a run of canned cycles, as the general path does', () => {
    // After G1 on the fast path, the next G81 must start a new initial level.
    const src = 'G0 Z10\nG98 G81 X1 Z-1 R2 F100\nG1 Z5\nG81 X2 Z-1 R2';
    expect(ends(src).at(-1)).toEqual([2, 0, 5]);
    expect(ends(bracketed(src)).at(-1)).toEqual([2, 0, 5]);
  });
});
