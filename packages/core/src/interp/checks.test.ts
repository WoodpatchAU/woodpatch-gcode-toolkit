// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  GENERIC,
  interpret,
  LINUXCNC,
  MASSO_G3,
  parse,
  programChecks,
  type Dialect,
} from '../index.js';

// Whole-job checks (operator request, 2026-09-28; ADR-0035).

const check = (src: string, dialect: Dialect = GENERIC, subs: Record<string, string> = {}) => {
  const p = parse(src);
  const r = interpret(p, { dialect, resolveProgram: ({ name }) => subs[name] });
  return programChecks(p, r, dialect);
};
const codes = (src: string, dialect?: Dialect, subs?: Record<string, string>) =>
  check(src, dialect, subs).map((d) => `${d.code}@${d.file ? `${d.file}:` : ''}${d.line}`);
const JOB = 'G21 G90\nT1 M6\nM3 S18000\nG0 X0 Y0 Z5\nG1 Z-1 F300\nG1 X10\nG0 Z5\nM5\nM30';

describe('programChecks', () => {
  it('says nothing about a complete job', () => {
    for (const d of [GENERIC, LINUXCNC, MASSO_G3]) expect(check(JOB, d)).toEqual([]);
  });

  it("Masso: warns when the job doesn't end with M30, or ends with the spindle on", () => {
    expect(codes(JOB.replace('M30', ''), MASSO_G3)).toEqual(['PROGRAM_END@8']);
    expect(codes(JOB.replace('M30', 'M2'), MASSO_G3)).toEqual(['PROGRAM_END@9']);
    expect(check(JOB.replace('M30', 'M2'), MASSO_G3)[0]?.message).toContain('only on M30');
    expect(codes(JOB.replace('M5\n', ''), MASSO_G3)).toEqual(['PROGRAM_SPINDLE_ON_AT_END@8']);
  });

  it('LinuxCNC and generic: M2 or M30 ends a job; M30 with the spindle on is fine', () => {
    expect(codes(JOB.replace('M30', 'M2'))).toEqual([]);
    expect(codes(JOB.replace('M5\n', ''))).toEqual([]);
    expect(codes(JOB.replace('M30', ''), LINUXCNC)).toEqual(['PROGRAM_END@8']);
  });

  it('warns on M3 with no speed, or S0, once', () => {
    expect(codes(JOB.replace('M3 S18000', 'M3'), MASSO_G3)).toEqual(['PROGRAM_SPINDLE_NO_SPEED@3']);
    expect(codes(JOB.replace('M3 S18000', 'M3 S0'))).toEqual([
      'PROGRAM_SPINDLE_NO_SPEED@3',
      'PROGRAM_CUT_SPINDLE_OFF@5',
    ]);
    // A speed given earlier counts.
    expect(codes(JOB.replace('M3 S18000', 'S18000\nM3'))).toEqual([]);
  });

  it('warns when it cuts with the spindle never started, or stopped', () => {
    const none = check(JOB.replace('M3 S18000\n', ''), MASSO_G3);
    expect(none.map((d) => `${d.code}@${d.line}`)).toEqual(['PROGRAM_CUT_SPINDLE_OFF@4']);
    expect(none[0]?.message).toContain('before any M3 or M4 has started the spindle');
    const stopped = check('G21 G90\nM3 S1000\nG1 X1 F100\nM5\nG1 X2\nM30');
    expect(stopped[0]?.message).toContain('stopped (M5 at line 4)');
    // Rapids don't count: moving with the spindle off is normal.
    expect(codes('G21 G90\nG0 X10 Y10\nM3 S1000\nG1 Z-1 F100\nM5\nM30')).toEqual([]);
  });

  // ── The review of #38 ──────────────────────────────────────────────────
  const TWO_TOOLS =
    'G21 G90\nT1 M6\nM3 S18000\nG0 X0 Y0 Z5\nG1 Z-1 F300\nG0 Z5\nT2 M6\nG0 X20\nG1 Z-1 F300\nG0 Z5\nM5\nM30';

  it('a tool change stops the spindle (LinuxCNC docs; assumed on Masso)', () => {
    for (const d of [GENERIC, LINUXCNC, MASSO_G3]) {
      const w = check(TWO_TOOLS, d);
      expect(w.map((x) => `${x.code}@${x.line}`)).toEqual(['PROGRAM_CUT_SPINDLE_OFF@9']);
      expect(w[0]?.message).toContain('the tool change at line 7 stops it');
    }
    // Restarted after the change: fine.
    expect(codes(TWO_TOOLS.replace('T2 M6', 'T2 M6\nM3 S12000'), MASSO_G3)).toEqual([]);
    // A tool change with the spindle already stopped: still off, still warned.
    expect(codes(TWO_TOOLS.replace('T2 M6', 'M5\nT2 M6'), MASSO_G3)).toEqual([
      'PROGRAM_CUT_SPINDLE_OFF@10',
    ]);
  });

  it('follows the run into subprogram files, naming the file', () => {
    // The sub cuts, and nothing ever started the spindle.
    expect(codes('G21 G90\nM98 P12\nM30', MASSO_G3, { '12': 'G1 Z-1 F300\nM99' })).toEqual([
      'PROGRAM_CUT_SPINDLE_OFF@12:1',
    ]);
    // The sub stops the spindle; main then cuts.
    expect(
      codes('G21 G90\nM3 S18000\nM98 P12\nG1 Z-1 F300\nM30', MASSO_G3, { '12': 'M5\nM99' }),
    ).toEqual(['PROGRAM_CUT_SPINDLE_OFF@4']);
    expect(
      check('G21 G90\nM3 S18000\nM98 P12\nG1 Z-1 F300\nM30', MASSO_G3, { '12': 'M5\nM99' })[0]
        ?.message,
    ).toContain('M5 at line 1 of 12');
    // The sub starts the spindle, and stops it: main is fine.
    expect(
      codes('G21 G90\nM98 P12\nG1 Z-1 F300\nM98 P13\nM30', MASSO_G3, {
        '12': 'M3 S18000\nM99',
        '13': 'M5\nM99',
      }),
    ).toEqual([]);
    // M30 inside the sub ends the job.
    expect(codes('G21 G90\nM98 P12', MASSO_G3, { '12': 'M5\nM30' })).toEqual([]);
  });

  it("skips the end checks when the run didn't reach the end", () => {
    // No resolver for P11: the run stops at the call, before the M30.
    const w = codes('G21 G90\nM3 S18000\nM98 P11\nM5\nM30', MASSO_G3);
    expect(w).toEqual([]);
    const p = parse('G21 G90\nM3 S1000\nG1 X1 F100');
    expect(
      programChecks(p, { ...interpret(p, { dialect: LINUXCNC }), completed: false }, LINUXCNC),
    ).toEqual([]);
  });

  it('re-arms the cut warning on each spindle change or tool change', () => {
    expect(
      codes('G21 G90\nG1 Z20 F2000\nT1 M6\nM3 S1000\nG1 Z-1 F300\nM5\nG1 X5\nM30', LINUXCNC),
    ).toEqual(['PROGRAM_CUT_SPINDLE_OFF@7']);
    expect(codes('G21 G90\nG1 X1 F100\nG1 X2\nM3 S1000\nM5\nG1 X3\nG1 X4\nM30')).toEqual([
      'PROGRAM_CUT_SPINDLE_OFF@2',
      'PROGRAM_CUT_SPINDLE_OFF@6',
    ]);
  });

  it("doesn't count a feed move that only raises Z, or a G53 move, as a cut", () => {
    expect(codes('G21 G90\nM3 S1000\nG1 Z-1 F300\nM5\nG1 Z10 F2000\nM30')).toEqual([]);
    expect(codes('G21 G90\nG53 G1 X10 Y10 F2000\nM3 S1000\nG1 Z-1 F300\nM5\nM30')).toEqual([]);
    // Raising Z while moving in X is still a cut.
    expect(codes('G21 G90\nM3 S1000\nG1 Z-1 F300\nM5\nG1 X5 Z10\nM30')).toEqual([
      'PROGRAM_CUT_SPINDLE_OFF@5',
    ]);
  });

  it('% and M99 endings get their own messages', () => {
    const pct = check('%\nG21 G90\nM3 S1000\nG1 X1 F100\nM5\n%', LINUXCNC);
    expect(pct.map((x) => `${x.code}@${x.line}`)).toEqual(['PROGRAM_END@6']);
    expect(pct[0]?.message).toContain('closing %');
    expect(check('%\nG21\nM5\n%', MASSO_G3)[0]?.message).toContain('ends at the closing %');
    const m99 = check('G21 G90\nM3 S1000\nG1 X1 F100\nM5\nM99', LINUXCNC);
    expect(m99.map((x) => x.code)).toEqual(['PROGRAM_END']);
    expect(m99[0]?.message).toContain('M99');
  });

  it('falls back to the LinuxCNC defaults for a dialect without programChecks', () => {
    // No casts: the type allows rules without programChecks, or with only some fields.
    const old: Dialect = {
      ...LINUXCNC,
      interpreter: { ...LINUXCNC.interpreter, programChecks: undefined },
    };
    expect(codes(JOB.replace('M30', ''), old)).toEqual(['PROGRAM_END@8']);
    const some: Dialect = {
      ...LINUXCNC,
      interpreter: { ...LINUXCNC.interpreter, programChecks: { end: 'M30' } },
    };
    expect(codes(JOB.replace('M30', 'M2'), some)).toEqual(['PROGRAM_END@9']);
    // The rest are LinuxCNC's: M30 with the spindle on is fine.
    expect(codes(JOB.replace('M5\n', ''), some)).toEqual([]);
  });

  it('nits: S0 while running, an empty file', () => {
    const w = check('G21 G90\nM3 S1000\nG1 X1 F100\nS0\nG1 X2\nM5\nM30');
    expect(w.map((x) => `${x.code}@${x.line}`)).toEqual([
      'PROGRAM_SPINDLE_NO_SPEED@4',
      'PROGRAM_CUT_SPINDLE_OFF@5',
    ]);
    expect(w[0]?.message).toContain('S0 here stops the spindle turning');
    expect(check('', MASSO_G3)).toEqual([]);
    expect(check('(just a comment)\n', MASSO_G3)).toEqual([]);
  });
});
