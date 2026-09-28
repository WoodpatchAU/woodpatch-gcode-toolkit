// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { ExpressionRules } from '../expr/rules.js';
import type { InterpreterRules } from './rules.js';
import type { Dialect } from '../dialect/profiles.js';
import type { Diagnostic } from '../syntax/types.js';

/** The axes the interpreter tracks. XYZ move the tool; ABC are tracked but not simulated. */
export const AXES = ['X', 'Y', 'Z', 'A', 'B', 'C'] as const;
export type Axis = (typeof AXES)[number];

/** A position on every tracked axis, in millimetres (ABC in degrees). */
export type Position = Readonly<Record<Axis, number>>;

export type Plane = 'XY' | 'ZX' | 'YZ';

/**
 * How a motion's feed is expressed (G94 / G93 / G95), converted to millimetres
 * where it's a length. `null` feed on a rapid: rapids run at the machine's rate,
 * which is Phase 5's business, not the program's.
 */
export type Feed =
  | { readonly mode: 'per-minute'; readonly mmPerMinute: number }
  | { readonly mode: 'inverse-time'; readonly perMinute: number }
  | { readonly mode: 'per-revolution'; readonly mmPerRevolution: number }
  /**
   * No F was ever given, and the controller runs the move anyway at a rate the
   * operator sets on the machine (Masso). Its time can't be known from the program.
   */
  | { readonly mode: 'unspecified' };

/**
 * One thing the program makes the machine do, in execution order.
 *
 * Positions are MACHINE coordinates in millimetres (ADR-0019). `offset` is the total
 * work offset in force (coordinate system + G92/G52), so work coordinates are
 * `position - offset`. That lets G53, G10, G92 and coordinate-system changes compose
 * exactly, while a viewer can still draw in work coordinates.
 */
export type Step = StepKind & {
  /**
   * The subprogram file the step came from, as the program resolver named it; absent
   * for the main program. `line` is a line of that file.
   */
  readonly file?: string;
};

type StepKind =
  | {
      readonly kind: 'linear';
      readonly line: number;
      readonly rapid: boolean;
      readonly from: Position;
      readonly to: Position;
      readonly feed: Feed | null;
      readonly offset: Position;
    }
  | {
      readonly kind: 'arc';
      readonly line: number;
      readonly from: Position;
      readonly to: Position;
      readonly plane: Plane;
      readonly clockwise: boolean;
      /**
       * Centre in machine coordinates, resolved for both I/J/K and R format (ADR-0022).
       * Only the plane's two axes are meaningful; the others are the start's.
       */
      readonly centre: Position;
      /** Radius at the start, in mm. */
      readonly radius: number;
      /**
       * Radius at the end, in mm. It differs from `radius` only when the controller
       * tolerated a mismatch: the tool then spirals, the radius changing evenly with angle.
       */
      readonly endRadius: number;
      /**
       * Signed sweep in radians, full turns included. Positive is counter-clockwise
       * seen from the plane's positive normal (G17 +Z, G18 +Y, G19 +X), turning from
       * the plane's first axis to its second (XY, ZX, YZ).
       */
      readonly sweep: number;
      /** Full turns from P (default 1). */
      readonly turns: number;
      readonly feed: Feed;
      readonly offset: Position;
    }
  | { readonly kind: 'dwell'; readonly line: number; readonly seconds: number }
  | { readonly kind: 'tool-change'; readonly line: number; readonly tool: number | null }
  | {
      readonly kind: 'spindle';
      readonly line: number;
      readonly state: 'cw' | 'ccw' | 'off';
      readonly rpm: number | null;
    }
  | {
      readonly kind: 'coolant';
      readonly line: number;
      readonly mist: boolean;
      readonly flood: boolean;
    }
  | { readonly kind: 'pause'; readonly line: number; readonly optional: boolean }
  /**
   * Waiting for a machine input (Masso M66). Its time is unknown: up to the timeout,
   * or until the input changes. `skipLines` are the lines the controller skips if the
   * input condition is met; the preview draws them, as if it wasn't.
   */
  | {
      readonly kind: 'wait';
      readonly line: number;
      readonly input: number | null;
      readonly timeoutSeconds: number | null;
      readonly skipLines: number;
    }
  /** An operator message (Masso MSG line, LinuxCNC (MSG, …) comment). '' clears it. */
  | {
      readonly kind: 'message';
      readonly line: number;
      readonly text: string;
      readonly target: 'screen' | 'workshop' | 'both';
    }
  | { readonly kind: 'end'; readonly line: number; readonly by: 'M2' | 'M30' | 'M99' | '%' };

export interface InterpretOptions {
  /**
   * The controller the program is for (parcel 2e-1, ADR-0023): MASSO_G3, GENERIC or
   * LINUXCNC. `rules` and `interpreterRules` override its parts. Default: LinuxCNC 2.9.
   */
  readonly dialect?: Dialect;
  /** Expression rules (ADR-0018). Default: LINUXCNC_RULES. */
  readonly rules?: ExpressionRules;
  /** Controller-dependent interpreter behaviour (ADR-0019). Default: LINUXCNC_INTERPRETER_RULES. */
  readonly interpreterRules?: InterpreterRules;
  /** The block-delete ("optional skip") switch: when on, lines starting "/" are skipped. Default: on. */
  readonly blockDelete?: boolean;
  /** Machine position before the first line. Default: all zeros. */
  readonly start?: Partial<Position>;
  /**
   * The units in force before the program states any (G20/G21): the user's units
   * preference (operator decision, 2026-09-28). Default mm. Given explicitly, a program
   * that moves before stating its units also gets a warning (SEMANTIC_UNITS_ASSUMED),
   * since a controller would read it in whatever units IT defaults to.
   */
  readonly units?: 'mm' | 'inch';
  /**
   * Supplies a subprogram that lives in its own file (parcel 2c-3, ADR-0021): LinuxCNC
   * `o<name> call` (name lower-cased, e.g. "myfile" for myfile.ngc) or Masso
   * `M98 P<n>` (name "10" for 10.nc). Return the file's text, or undefined if there is
   * no such file. The core never reads files itself, so it runs the same in a browser
   * and on a server; the caller decides where subprograms come from. Must be
   * synchronous: fetch asynchronously beforehand if needed.
   */
  readonly resolveProgram?: (request: ProgramRequest) => string | undefined;
  /**
   * The machine's own positions, in machine coordinates (mm), for controllers that go
   * to them (Masso G28/G30, parcel 2e-2). Missing axes: `home` defaults to the machine
   * origin; an unknown `park` is reported and the move isn't drawn.
   */
  readonly machine?: {
    readonly home?: Partial<Position>;
    readonly park?: Partial<Position>;
  };
  /** Safety caps for untrusted input. Hitting one stops the run with an error. */
  readonly limits?: Partial<InterpretLimits>;
  /**
   * Called before each block that executes, with the modal state it runs under: the
   * state the controller is in at that line, whatever the text above it says. A
   * transform that reads modes from the text uses it to check that the run agrees
   * (review of toolkit #37: a subroutine runs in its caller's modes; a block-deleted
   * line may not run). Not called for skipped lines or O-word flow lines.
   */
  readonly onBlock?: (block: {
    readonly line: number;
    readonly file?: string;
    readonly state: ModalState;
  }) => void;
}

export interface ProgramRequest {
  readonly kind: 'o-word' | 'm98';
  readonly name: string;
}

/**
 * Resource limits, independent of any controller (ADR-0021). A controller's own limit
 * (e.g. call depth) says "this won't run on the machine"; these say "too large to
 * process", so a hostile or broken file cannot hang a server.
 */
export interface InterpretLimits {
  /** Loop iterations (while, do, repeat, M98 L) across the whole run. Default 1,000,000. */
  readonly maxLoopIterations: number;
  /** Blocks executed, counting each loop pass and canned-cycle repeat. Default 20,000,000. */
  readonly maxBlocks: number;
  /** Call nesting, whatever the dialect allows. Default 64. */
  readonly maxCallDepth: number;
  /**
   * Steps kept, each a few hundred bytes. This is what bounds memory: a loop can emit
   * many steps per iteration. Default 2,000,000 (aztec, a 224k-line job, needs 224k).
   */
  readonly maxSteps: number;
  /** Diagnostics kept; beyond this they're counted, not stored. Default 10,000. */
  readonly maxDiagnostics: number;
  /**
   * Pecks in one G73/G83 hole: ceil(depth / Q). Beyond it the line is refused, not
   * looped. A tiny Q (or one below the float resolution of the depth) would otherwise
   * never end. Default 10,000 (1 m deep at Q0.1).
   */
  readonly maxPecks: number;
}

export const DEFAULT_LIMITS: InterpretLimits = Object.freeze({
  maxLoopIterations: 1_000_000,
  maxBlocks: 20_000_000,
  maxCallDepth: 64,
  maxSteps: 2_000_000,
  maxDiagnostics: 10_000,
  maxPecks: 10_000,
});

/** The modal state after the last line: useful for tests, editors and resuming. */
export interface ModalState {
  readonly motion: 'G0' | 'G1' | 'G2' | 'G3' | 'G80' | 'G73' | 'G81' | 'G82' | 'G83';
  readonly plane: Plane;
  readonly units: 'mm' | 'inch';
  readonly distance: 'absolute' | 'incremental';
  readonly arcDistance: 'absolute' | 'incremental';
  readonly feedMode: 'per-minute' | 'inverse-time' | 'per-revolution';
  /** 1-9: G54-G59.3. 101-200: G54.1 P1-P100 (Masso's extended offsets). */
  readonly coordinateSystem: number;
  readonly cutterCompensation: 'off' | 'left' | 'right';
  readonly toolLengthOffset: boolean;
  readonly retract: 'initial' | 'r-plane';
  readonly pathControl: 'G61' | 'G61.1' | 'G64';
  readonly position: Position;
  /** Feed rate in mm/min, (inverse time: per minute; per rev: mm/rev), or null if never set. */
  readonly feedRate: number | null;
  readonly spindle: { readonly state: 'cw' | 'ccw' | 'off'; readonly rpm: number | null };
  readonly tool: number | null;
}

export interface InterpretResult {
  readonly steps: readonly Step[];
  /**
   * The interpreter's own findings, including expression-evaluation errors. Syntax
   * findings stay on the {@link Program} they came from; show both together.
   */
  readonly diagnostics: readonly Diagnostic[];
  readonly state: ModalState;
  /**
   * False when the run was cut short: a call to a missing subprogram, or a safety
   * limit (the error says which). The steps then stop where the run did, so whatever
   * judges the whole job (its end, the spindle at the end) has not seen all of it.
   */
  readonly completed: boolean;
}
