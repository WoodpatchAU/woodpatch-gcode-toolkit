// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import type { Diagnostic, Program } from '../syntax/types.js';
import { LINUXCNC_INTERPRETER_RULES } from './rules.js';
import type { InterpretResult, Step } from './types.js';

/** Where a step ran: a line of the main program, or of a subprogram file. */
type At = { readonly line: number; readonly file?: string | undefined };
const where = (at: At) => (at.file ? `line ${at.line} of ${at.file}` : `line ${at.line}`);

/**
 * Whole-program checks (operator request, 2026-09-28; ADR-0035): does the program end
 * the way the controller needs, and run the spindle while it cuts? Warnings only.
 *
 * Separate from `interpret`, which reports what each line does: these judge a whole
 * JOB, so a host that loads jobs (the viewer's `loadProgram`) runs them, while a
 * snippet (a test, a transform, a parity check) isn't told it lacks an M30.
 *
 * They follow the run, subprogram files included (a Masso M98 is always a file), and a
 * warning raised in a subprogram names its file. When the run was cut short
 * (`completed` false: a missing subprogram, a safety limit), the job's end was never
 * reached, so the end checks are skipped rather than reported against a line the run
 * didn't get to.
 */
export function programChecks(
  program: Program,
  result: Pick<InterpretResult, 'steps' | 'completed'>,
  dialect?: Dialect,
): Diagnostic[] {
  // Defaults fill any field a dialect built before a check existed doesn't have.
  const checks = {
    ...LINUXCNC_INTERPRETER_RULES.programChecks,
    ...dialect?.interpreter?.programChecks,
  };
  const controller = dialect?.name ?? 'this controller';
  const out: Diagnostic[] = [];
  const warn = (at: At, code: string, message: string) =>
    out.push({
      severity: 'warning',
      code,
      message,
      line: at.line,
      ...(at.file === undefined ? {} : { file: at.file }),
    });

  let on = false;
  let everOn = false;
  let rpm: number | null = null;
  // What last stopped the spindle, for the message.
  let stoppedBy: (At & { by: 'M5' | 'M6' }) | null = null;
  let speedWarned = false;
  // Cutting with the spindle off is reported once per spindle state: every M3/M4, M5
  // or tool change re-arms it, so a harmless move early on can't hide a plunge after
  // the next tool change.
  let cutArmed = true;
  let end: Extract<Step, { kind: 'end' }> | undefined;
  for (const s of result.steps) {
    if (s.kind === 'spindle') {
      const wasOn = on;
      if (s.rpm !== null) rpm = s.rpm;
      cutArmed = true;
      if (s.state === 'off') {
        on = false;
        stoppedBy = { line: s.line, file: s.file, by: s.by === 'tool-change' ? 'M6' : 'M5' };
        continue;
      }
      on = true;
      everOn = true;
      if (checks.spindleSpeed && !speedWarned && (rpm === null || rpm === 0)) {
        speedWarned = true;
        const m = `M${s.state === 'cw' ? 3 : 4}`;
        warn(
          s,
          'PROGRAM_SPINDLE_NO_SPEED',
          rpm === null
            ? `${m} starts the spindle with no speed programmed (no S yet). It runs at whatever speed the controller last had, or not at all; if the speed is set by hand on the spindle, or this is a plasma or laser, this is expected`
            : wasOn
              ? "S0 here stops the spindle turning while it's still switched on"
              : `The spindle is started at S0: it won't turn. Give a speed (S) with ${m}`,
        );
      }
    } else if (s.kind === 'tool-change') {
      // Whether it stopped the spindle is the interpreter's call (a spindle step marked
      // by: 'tool-change', just before this one): one source of truth with the summary.
      cutArmed = true;
    } else if (s.kind === 'end') {
      end = s;
      break;
    } else if (checks.spindleOnToCut && cutArmed && cuts(s, program) && !(on && rpm !== 0)) {
      cutArmed = false;
      warn(
        s,
        'PROGRAM_CUT_SPINDLE_OFF',
        !everOn
          ? 'The program cuts before any M3 or M4 has started the spindle. If this is an air cut or a test, that may be intended'
          : on
            ? 'The program cuts here with the spindle at S0'
            : stoppedBy?.by === 'M6'
              ? `The program cuts here with the spindle stopped: the tool change at ${where(stoppedBy)} stops it. Start it again (M3/M4) after the tool change`
              : `The program cuts here with the spindle stopped (M5 at ${stoppedBy ? where(stoppedBy) : 'an earlier line'})`,
      );
    }
  }

  // A run that stopped early never reached the end: the error that stopped it says so.
  if (!result.completed) return out;
  let lastLine = 0;
  let lastIsM99 = false;
  for (let i = program.lines.length - 1; i >= 0 && !lastLine; i--) {
    const l = program.lines[i];
    if (!l?.tokens.some((t) => t.kind === 'word')) continue;
    lastLine = l.lineNo;
    // An M99 the dialect doesn't run in a main program leaves no end step.
    lastIsM99 = l.tokens.some(
      (t) =>
        t.kind === 'word' && t.letter === 'M' && t.value?.kind === 'number' && t.value.value === 99,
    );
  }
  // An empty program is not a job.
  if (!lastLine && !end) return out;
  const endAt: At = end ?? { line: lastLine };
  const endedBy = (e: NonNullable<typeof end>) =>
    e.by === '%' ? 'at the closing %' : `with ${e.by}`;
  if (checks.end === 'M30') {
    if (!end || end.by !== 'M30')
      warn(
        endAt,
        'PROGRAM_END',
        end
          ? `The program ends ${endedBy(end)}, but ${controller} finishes a job only on M30: the job won't finish. End it with M30`
          : `The program never ends with M30: on ${controller} the job won't finish. Add M30 at the end`,
      );
  } else if (checks.end === 'M2-or-M30' && (!end || (end.by !== 'M2' && end.by !== 'M30')))
    warn(
      endAt,
      'PROGRAM_END',
      !end && !lastIsM99
        ? 'The program has no end code (M2 or M30). Add M30 at the end'
        : end?.by === '%'
          ? "The program ends at the closing %, with no M2 or M30: the run ends, but the machine isn't reset, so the spindle and coolant may stay on. Add M30 before the %"
          : 'The program ends with M99, which returns from a subprogram; in a main program it may restart the job or be an error. End the job with M30',
    );
  if (checks.spindleOffAtEnd && end && on)
    warn(
      end,
      'PROGRAM_SPINDLE_ON_AT_END',
      `The spindle is still on when the program ends: ${controller} expects M5 before ${end.by === '%' ? 'the end' : end.by}`,
    );
  return out;
}

/**
 * Whether a step cuts, for the spindle check: a feed move or an arc, except a feed
 * move that only raises Z (a retract at feed after M5 is harmless) and a G53 move in
 * the main program (machine-coordinate positioning, e.g. to a tool-change spot).
 */
function cuts(s: Step, program: Program): boolean {
  if (s.kind === 'arc') return true;
  if (s.kind !== 'linear' || s.rapid) return false;
  const axes = Object.keys(s.to) as (keyof typeof s.to)[];
  if (s.to.Z >= s.from.Z && axes.every((a) => a === 'Z' || s.to[a] === s.from[a])) return false;
  if (!s.file) {
    const line = program.lines[s.line - 1];
    if (
      line?.lineNo === s.line &&
      line.tokens.some(
        (t) =>
          t.kind === 'word' &&
          t.letter === 'G' &&
          t.value?.kind === 'number' &&
          t.value.value === 53,
      )
    )
      return false;
  }
  return true;
}
