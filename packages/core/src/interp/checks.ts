// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import type { Diagnostic, Program } from '../syntax/types.js';
import { LINUXCNC_INTERPRETER_RULES } from './rules.js';
import type { Step } from './types.js';

/**
 * Whole-program checks (operator request, 2026-09-28; ADR-0035): does the program end
 * the way the controller needs, and run the spindle while it cuts? Warnings only, and
 * each reported once, at the first line it applies to. Main-file steps only.
 *
 * Separate from `interpret`, which reports what each line does: these judge a whole
 * JOB, so a host that loads jobs (the viewer's `loadProgram`) runs them, while a
 * snippet (a test, a transform, a parity check) isn't told it lacks an M30.
 */
export function programChecks(
  program: Program,
  steps: readonly Step[],
  dialect?: Dialect,
): Diagnostic[] {
  const checks = (dialect?.interpreter ?? LINUXCNC_INTERPRETER_RULES).programChecks;
  const controller = dialect?.name ?? 'this controller';
  const out: Diagnostic[] = [];
  const warn = (line: number, code: string, message: string) =>
    out.push({ severity: 'warning', code, message, line });

  let on = false;
  let everOn = false;
  let rpm: number | null = null;
  let offAt = 0;
  let speedWarned = false;
  let cutWarned = false;
  let end: Extract<Step, { kind: 'end' }> | undefined;
  for (const s of steps) {
    if (s.file) continue;
    if (s.kind === 'spindle') {
      if (s.rpm !== null) rpm = s.rpm;
      if (s.state === 'off') {
        on = false;
        offAt = s.line;
        continue;
      }
      on = true;
      everOn = true;
      if (checks.spindleSpeed && !speedWarned && (rpm === null || rpm === 0)) {
        speedWarned = true;
        warn(
          s.line,
          'PROGRAM_SPINDLE_NO_SPEED',
          rpm === 0
            ? `The spindle is started at S0: it won't turn. Give a speed (S) with M${s.state === 'cw' ? 3 : 4}`
            : `M${s.state === 'cw' ? 3 : 4} starts the spindle with no speed programmed (no S yet). It runs at whatever speed the controller last had, or not at all; if the speed is set by hand on the spindle, this is expected`,
        );
      }
    } else if (s.kind === 'end') {
      end = s;
      break;
    } else if (
      checks.spindleOnToCut &&
      !cutWarned &&
      ((s.kind === 'linear' && !s.rapid) || s.kind === 'arc') &&
      !(on && rpm !== 0)
    ) {
      cutWarned = true;
      warn(
        s.line,
        'PROGRAM_CUT_SPINDLE_OFF',
        !everOn
          ? 'The program cuts without ever starting the spindle (no M3 or M4). If this is an air cut or a test, that may be intended'
          : on
            ? 'The program cuts here with the spindle at S0'
            : `The program cuts here with the spindle stopped (M5 at line ${offAt})`,
      );
    }
  }

  const lastCode = [...program.lines]
    .reverse()
    .find((l) => l.tokens.some((t) => t.kind === 'word'));
  const lastLine = lastCode?.lineNo ?? 0;
  if (checks.end === 'M30') {
    if (!end || end.by !== 'M30')
      warn(
        end?.line ?? lastLine,
        'PROGRAM_END',
        end
          ? `The program ends with ${end.by}, but ${controller} finishes a job only on M30: the job won't finish. End it with M30`
          : `The program never ends with M30: on ${controller} the job won't finish. Add M30 at the end`,
      );
  } else if (checks.end === 'M2-or-M30' && (!end || (end.by !== 'M2' && end.by !== 'M30')))
    warn(
      end?.line ?? lastLine,
      'PROGRAM_END',
      'The program has no end code (M2 or M30). Add M30 at the end',
    );
  if (checks.spindleOffAtEnd && end && on)
    warn(
      end.line,
      'PROGRAM_SPINDLE_ON_AT_END',
      `The spindle is still on when the program ends: ${controller} expects M5 before ${end.by}`,
    );
  return out;
}
