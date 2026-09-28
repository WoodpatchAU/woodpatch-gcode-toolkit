// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { LINUXCNC_RULES, type ExpressionRules } from '../expr/rules.js';
import { LINUXCNC_ARC_TOLERANCE } from '../interp/arcs.js';
import { LINUXCNC_INTERPRETER_RULES, type InterpreterRules } from '../interp/rules.js';

/**
 * Dialect profiles (parcel 2e-1, plan §4.2 item 3, ADR-0023): everything that differs
 * between controllers, gathered into one choice. `interpret(program, { dialect })`.
 *
 * Every value is traced to evidence: the controller's source (LinuxCNC 2.9), its
 * documentation, or a test on the real machine (Masso, 2026-09-26). Untested
 * guesses are marked as such, and the doubtful ones are on the machine-test backlog.
 */
export interface Dialect {
  /** Stable identifier, including the version it describes, e.g. "masso-g3-5.13". */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly expressions: ExpressionRules;
  readonly interpreter: InterpreterRules;
}

/** LinuxCNC 2.9 (stable): its interpreter source is the reference for the whole core. */
export const LINUXCNC: Dialect = Object.freeze({
  id: 'linuxcnc-2.9',
  name: 'LinuxCNC 2.9',
  description: 'LinuxCNC 2.9 (stable), verified against its interpreter source.',
  expressions: LINUXCNC_RULES,
  interpreter: LINUXCNC_INTERPRETER_RULES,
});

/**
 * For a program whose controller is unknown: LinuxCNC's semantics (the fullest open
 * RS274/NGC reference), accepting every code known here rather than only LinuxCNC's.
 */
export const GENERIC: Dialect = Object.freeze({
  id: 'generic',
  name: 'Generic RS274/NGC',
  description:
    'Unknown controller: LinuxCNC 2.9 semantics, accepting every code the toolkit knows.',
  expressions: LINUXCNC_RULES,
  interpreter: Object.freeze({ ...LINUXCNC_INTERPRETER_RULES, codes: null }),
});

/**
 * Masso G3, firmware 5.13 (ADR-0015): Woodpatch's router. Sources: docs.masso.com.au
 * ("Supported G-codes", "Supported M-codes", "Invalid G-codes") and the machine test
 * of 2026-09-26 (T1-T18).
 */
export const MASSO_G3: Dialect = Object.freeze({
  id: 'masso-g3-5.13',
  name: 'Masso G3 (v5.13)',
  description:
    'Masso G3 controller, firmware 5.13, from its documentation and a test on the machine.',
  // No expressions at all (T10-T14); the rules are unused but keep the type simple.
  expressions: LINUXCNC_RULES,
  interpreter: Object.freeze({
    ...LINUXCNC_INTERPRETER_RULES,
    // Untested; LinuxCNC's order is the default.
    feedUnits: 'at-feed-step',
    // Docs: G4 P and G82 P are milliseconds.
    dwellUnits: 'milliseconds',
    // Docs: K repeats "at the same position".
    cycleRepeat: Object.freeze({ letter: 'K', stepInIncremental: false }),
    // Docs: G73 backs off 1 mm. G83's clearance is undocumented: LinuxCNC's value.
    g73Retract: 1.0,
    g83Clearance: 0.254,
    // Docs: M98 P<n> runs the file n.nc, up to 5 levels; no O-words.
    subprograms: Object.freeze({ oWord: false, m98: 'file', maxCallDepth: 5 }),
    // The operator, on the machine: a Masso job only finishes on M30, and expects the
    // spindle stopped (M5) before it. To be confirmed by a machine test, with what M2
    // does there. The docs ask for M5 before M6; whether M6 stops the spindle itself
    // is unconfirmed, so assume it does.
    programChecks: Object.freeze({
      end: 'M30',
      toolChangeStopsSpindle: true,
      spindleOffAtEnd: true,
      spindleSpeed: true,
      spindleOnToCut: true,
    }),
    // T17 accepted 0.5 mm on a 10 mm radius; LinuxCNC refuses that. Anything up to
    // 0.5 mm is accepted here; the real limit is on the machine-test backlog.
    arcTolerance: Object.freeze({
      ...LINUXCNC_ARC_TOLERANCE,
      spiralMm: 0.5,
      spiralInch: 0.5 / 25.4,
      spiralRelative: 0,
      // Beyond 0.5 mm is untested: drawn, with a warning, not refused.
      beyond: 'warn',
    }),
    codes: Object.freeze({
      // docs.masso.com.au "Supported G-codes".
      g: Object.freeze(
        [
          0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 30, 32, 38.2, 38.6, 38.7, 40, 41, 42, 53, 54,
          55, 56, 57, 58, 59, 54.1, 68, 69, 73, 80, 81, 82, 83, 90, 91, 92, 92.1, 93, 94, 95, 96,
          97, 98, 99, 200,
        ].map(String),
      ),
      // docs.masso.com.au "Supported M-codes".
      m: Object.freeze(
        [
          0, 1, 2, 3, 4, 5, 6, 6.1, 7, 8, 9, 10, 11, 30, 62, 63, 64, 65, 66, 85, 86, 98, 99, 666,
          667,
        ].map(String),
      ),
    }),
    parameters: false,
    // T7: a "/" line ran.
    blockDelete: 'ignored',
    messages: Object.freeze({ lines: true, comments: false }),
    // T1: G1 with no F ran at the operator's percentage of the maximum rate.
    missingFeed: 'machine-rate',
    // Docs ("G80"), and T9 moved at rapid.
    afterG80: 'rapid',
    // Docs (G73/G82/G83): "the previous canned cycle must be cancelled using G80".
    cycleSwitch: 'warn',
    // Docs ("G10"): L2.1, and L20/L20.1 for the extended offsets G54.1 P1-P100.
    g10: 'masso',
    // Docs ("G28", "G30", v5.13): machine home / parking position, Z first.
    homing: 'masso',
    // Docs ("M66"): wait for an input; Q in ms; S lines skipped when met.
    m66: 'masso-wait',
    // Docs ("M06"): T before M06, and M05 before M06.
    toolChangeChecks: true,
    // Operator, 2026-09-26: a speed change while running isn't waited for.
    spindleSettleAdvice: true,
  } satisfies InterpreterRules),
});

/** Every profile, the primary one first. */
export const DIALECTS: readonly Dialect[] = Object.freeze([MASSO_G3, GENERIC, LINUXCNC]);
