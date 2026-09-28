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

const check = (src: string, dialect: Dialect = GENERIC) => {
  const p = parse(src);
  return programChecks(p, interpret(p, { dialect }).steps, dialect);
};
const codes = (src: string, dialect?: Dialect) =>
  check(src, dialect).map((d) => `${d.code}@${d.line}`);
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
    expect(none[0]?.message).toContain('without ever starting the spindle');
    const stopped = check('G21 G90\nM3 S1000\nG1 X1 F100\nM5\nG1 X2\nM30');
    expect(stopped[0]?.message).toContain('stopped (M5 at line 4)');
    // Rapids don't count: moving with the spindle off is normal.
    expect(codes('G21 G90\nG0 X10 Y10\nM3 S1000\nG1 Z-1 F100\nM5\nM30')).toEqual([]);
  });
});
