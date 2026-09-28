// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { evaluate, type ParameterReader } from '../expr/evaluate.js';
import { parseExpression } from '../expr/parse.js';
import { LINUXCNC_RULES, type ExpressionRules } from '../expr/rules.js';
import { parse } from '../syntax/program.js';
import type { Diagnostic, Line, Program, Severity, Span, Value } from '../syntax/types.js';
import { G_CODES, M_CODES, codeKey } from './codes.js';
import { arcFromCentre, arcFromRadius } from './arcs.js';
import { buildFlowIndex, type FlowIndex, type FlowOp, type SubDefinition } from './flow.js';
import { LINUXCNC_INTERPRETER_RULES, type InterpreterRules } from './rules.js';
import { cycleOps, type CycleCode } from './cycles.js';
import {
  AXES,
  DEFAULT_LIMITS,
  type Axis,
  type Feed,
  type InterpretLimits,
  type InterpretOptions,
  type InterpretResult,
  type ModalState,
  type Plane,
  type Position,
  type ProgramRequest,
  type Step,
} from './types.js';

/**
 * Interprets a parsed program into machine steps (parcel 2c-1, ADR-0019).
 *
 * Each line runs in RS274/NGC's **order of execution** (LinuxCNC G-code overview,
 * "Order of Execution"), not in the order its words are written. Upstream used
 * line order (ANALYSIS §4).
 *
 * A line that cannot be executed is reported, and its motion is skipped, so the tool
 * stays where it was: an unknown or not-yet-supported code, two codes from one modal
 * group, a repeated word, an expression error, or a missing feed. Upstream reported
 * such lines and then moved anyway (N5, N6). Never throws.
 *
 * Work offsets live in LinuxCNC's parameter layout, so a program that reads or
 * writes them sees consistent values:
 * - #5161- G28 home, #5181- G30 home;
 * - #5210/#5211- G92/G52 offset;
 * - #5220 the active coordinate system;
 * - #5221+20(n-1)- coordinate system n.
 * Values are stored in millimetres.
 */
export function interpret(program: Program, options: InterpretOptions = {}): InterpretResult {
  return new Interpreter(options).run(program);
}

const AXIS_INDEX: Readonly<Record<Axis, number>> = { X: 0, Y: 1, Z: 2, A: 3, B: 4, C: 5 };
const LINEAR: ReadonlySet<Axis> = new Set(['X', 'Y', 'Z']);
const ZERO: Position = Object.freeze({ X: 0, Y: 0, Z: 0, A: 0, B: 0, C: 0 });

/** Letters with a meaning somewhere in this interpreter. N is a line number, and ignored. */
const KNOWN_LETTERS = new Set('GMFSTXYZABCIJKRPQLHDN'.split(''));

/** Group-0 codes that consume the line's axis words, suspending group-1 motion. */
const AXIS_GROUP0 = new Set(['10', '28', '30', '52', '92']);

const PLANE_AXES: Readonly<Record<Plane, readonly [Axis, Axis]>> = {
  XY: ['X', 'Y'],
  ZX: ['Z', 'X'],
  YZ: ['Y', 'Z'],
};
const OFFSET_LETTER: Readonly<Record<Axis, string>> = {
  X: 'I',
  Y: 'J',
  Z: 'K',
  A: '',
  B: '',
  C: '',
};

const SPINDLE_CODES = [
  ['3', 'cw'],
  ['4', 'ccw'],
  ['5', 'off'],
] as const;
/** Machine I/O with no effect on the path (Masso adds clamps, door and plasma THC). */
const IO_CODES = [
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '10',
  '11',
  '85',
  '86',
  '666',
  '667',
] as const;
const WCS_CODES = [
  ['54', 1],
  ['55', 2],
  ['56', 3],
  ['57', 4],
  ['58', 5],
  ['59', 6],
  ['59.1', 7],
  ['59.2', 8],
  ['59.3', 9],
] as const;
const MOTION_CODES = ['0', '1', '2', '3', '80', '73', '81', '82', '83'] as const;
const CYCLES: ReadonlySet<string> = new Set(['G73', 'G81', 'G82', 'G83']);

/** Letters the fast path accepts, as bits (any other letter takes the general path). */
const FAST_LETTERS: Readonly<Record<string, number>> = {
  X: 1,
  Y: 2,
  Z: 4,
  A: 8,
  B: 16,
  C: 32,
  F: 64,
  N: 128,
  G: 256,
};
/** The fast path has nothing to report as unused, so its "used" set is a no-op. */
const NO_USED = { add: (): void => {} };

/** Word letters as bits, for a cheap per-line "which letters were used" set. */
const bit = (letter: string) => 1 << (letter.charCodeAt(0) - 65);

interface Word {
  readonly letter: string;
  readonly value: number;
  readonly span: Span;
}

/** A program the interpreter can run lines of: the main one, or a subprogram file. */
interface Loaded {
  /** The resolver's name for a subprogram file; null for the main program. */
  readonly name: string | null;
  readonly lines: readonly Line[];
  /** Built on first use: a program with no O-words never pays for it. */
  flow: FlowIndex | null;
}

/** One level of the call stack (parcel 2c-3, ADR-0021). */
interface Frame {
  readonly program: Loaded;
  /** Index of the next line to run. */
  pc: number;
  readonly kind: 'main' | 'o-sub' | 'm98';
  readonly label: string;
  /** The caller's #1-#30, restored on return (o-word calls only; M98 shares them). */
  readonly saved: readonly number[] | null;
  /** Local named parameters: those not starting with "_" (LinuxCNC scoping). */
  readonly named: Map<string, number>;
  /** Passes left of each active repeat loop, by the repeat line's index. */
  repeats: Map<number, number> | null;
  /** M98 L: further runs of this subprogram after the current one. */
  m98Left: number;
  /** A first `%` was seen in this frame's file (the second one ends the program). */
  percentSeen: boolean;
}

/** LinuxCNC round_to_int: std::nearbyint, which rounds halves to even (2.5 → 2). */
function nearbyint(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** LinuxCNC: `o<name> call` passes up to 30 arguments as #1-#30. */
const SUB_PARAMS = 30;

class Interpreter {
  private readonly rules: ExpressionRules;
  private readonly behaviour: InterpreterRules;
  private readonly blockDelete: boolean;
  private readonly onBlock: InterpretOptions['onBlock'];
  private readonly steps: Step[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly numbered = new Map<number, number>();
  /** Global named parameters: names starting with "_" (LinuxCNC). */
  private readonly globalNamed = new Map<string, number>();
  private readonly params: ParameterReader;
  private readonly once = new Set<string>();
  /** Canned cycles: sticky R, Q, P and Z (program units converted to mm; P in seconds). */
  private cycleR: number | null = null;
  private cycleQ: number | null = null;
  private cycleP: number | null = null;
  private cycleZ: number | null = null;
  /** The level (machine Z) when the current run of canned cycles began; G98 returns here. */
  private cycleInitial: number | null = null;
  private offsetCache: Position | null = null;

  /** Immutable: replaced on every move, never mutated, so steps can share it safely. */
  private position: Position;
  private motion: ModalState['motion'] = 'G0';
  private plane: Plane = 'XY';
  private units: 'mm' | 'inch' = 'mm';
  /** The host's units preference, if it gave one (then relying on it is warned about). */
  private readonly unitsPreference: 'mm' | 'inch' | undefined;
  /** How many steps existed when a G20/G21 first ran; null until one does. */
  private unitsStatedAt: number | null = null;
  private distance: 'absolute' | 'incremental' = 'absolute';
  private arcDistance: 'absolute' | 'incremental' = 'incremental';
  private feedMode: ModalState['feedMode'] = 'per-minute';
  private feedRate: number | null = null;
  private cutterComp: ModalState['cutterCompensation'] = 'off';
  private toolLength = false;
  private retract: ModalState['retract'] = 'initial';
  private pathControl: ModalState['pathControl'] = 'G64';
  private spindle: { state: 'cw' | 'ccw' | 'off'; rpm: number | null } = {
    state: 'off',
    rpm: null,
  };
  private mist = false;
  private flood = false;
  private tool: number | null = null;
  private selectedTool: number | null = null;
  private ended = false;
  /** A hard stop: broken O-word structure or a safety limit. */
  private stopped = false;

  // Subprograms and flow (parcel 2c-3).
  private readonly resolve: ((request: ProgramRequest) => string | undefined) | undefined;
  private readonly limits: InterpretLimits;
  private readonly frames: Frame[] = [];
  private frame!: Frame;
  /** Every subroutine defined so far, from any file (LinuxCNC: global labels). */
  private readonly subs = new Map<string, { program: Loaded; def: SubDefinition }>();
  /** Subprogram files by request, null when the resolver had none. */
  private readonly files = new Map<string, Loaded | null>();
  private iterations = 0;
  private blocks = 0;
  /**
   * Sub definitions already recorded, by program and line index: LinuxCNC's offset
   * table (control_save_offset). Flow reaching one again is an error.
   */
  private readonly savedSubs = new Map<Loaded, Set<number>>();
  /** Diagnostics dropped after `limits.maxDiagnostics`. */
  private suppressed = 0;
  /** An M98 or M99 on the current line, run after the rest of it. */
  private pendingCall: { readonly p: Word | undefined; readonly l: Word | undefined } | null = null;
  private pendingReturn = false;
  /** Machine positions for Masso G28/G30 (parcel 2e-2). */
  private readonly machineHome: Partial<Position>;
  private readonly machinePark: Partial<Position> | undefined;
  /** The line of a spindle-speed change not yet settled by a dwell (Masso advice). */
  private settleLine: number | null = null;

  constructor(options: InterpretOptions) {
    this.rules = options.rules ?? options.dialect?.expressions ?? LINUXCNC_RULES;
    this.behaviour =
      options.interpreterRules ?? options.dialect?.interpreter ?? LINUXCNC_INTERPRETER_RULES;
    this.blockDelete = options.blockDelete ?? true;
    this.onBlock = options.onBlock;
    this.position = { ...ZERO, ...options.start };
    this.units = options.units ?? 'mm';
    this.unitsPreference = options.units;
    this.machineHome = options.machine?.home ?? {};
    this.machinePark = options.machine?.park;
    this.resolve = options.resolveProgram;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.numbered.set(5220, 1);
    // Predefined, read-only (LinuxCNC): the last subroutine's return value.
    this.globalNamed.set('_value', 0);
    this.globalNamed.set('_value_returned', 0);
    this.params = {
      numbered: (i) => this.numbered.get(i) ?? 0,
      named: (n) => (n.startsWith('_') ? this.globalNamed : this.frame.named).get(n),
    };
  }

  run(program: Program): InterpretResult {
    const main: Frame = {
      program: { name: null, lines: program.lines, flow: null },
      pc: 0,
      kind: 'main',
      label: '',
      saved: null,
      named: new Map(),
      repeats: null,
      m98Left: 0,
      percentSeen: false,
    };
    this.frames.push(main);
    this.frame = main;
    this.loop();

    let skippedAfterEnd = 0;
    let firstSkipped = 0;
    if (this.ended) {
      for (let i = main.pc; i < program.lines.length; i++) {
        const line = program.lines[i] as Line;
        if (line.tokens.some((t) => t.kind !== 'comment' && t.kind !== 'percent')) {
          skippedAfterEnd++;
          firstSkipped ||= line.lineNo;
        }
      }
    }
    if (skippedAfterEnd > 0) {
      this.add({
        severity: 'info',
        code: 'SEMANTIC_AFTER_PROGRAM_END',
        message: `${skippedAfterEnd} line(s) after the program end were not run`,
        line: firstSkipped,
      });
    }
    // A program that moves before any G20/G21 runs relies on the units preference.
    if (this.unitsPreference !== undefined) {
      const first = this.steps.findIndex((s) => s.kind === 'linear' || s.kind === 'arc');
      const move = this.steps[first];
      if (move && (this.unitsStatedAt === null || this.unitsStatedAt > first))
        this.add({
          severity: 'warning',
          code: 'SEMANTIC_UNITS_ASSUMED',
          message: `The program moves before it states its units (G20/G21): read as ${this.unitsPreference === 'inch' ? 'inches' : 'millimetres'}, your units preference. A controller reads it in its own default units, so check that matches`,
          line: move.line,
          ...(move.file ? { file: move.file } : {}),
        });
    }
    if (this.suppressed > 0)
      this.diagnostics.push({
        severity: 'info',
        code: 'SEMANTIC_DIAGNOSTICS_TRUNCATED',
        message: `${this.suppressed} further diagnostic(s) not kept (limit ${this.limits.maxDiagnostics})`,
        line: 0,
      });
    return {
      steps: this.steps,
      diagnostics: this.diagnostics,
      state: this.state(),
      completed: !this.stopped,
    };
  }

  /**
   * Runs lines until the program ends, stops, or runs out. Each pass of the outer loop
   * runs one frame's lines; a call or return switches frame and starts a new pass.
   */
  private loop(): void {
    const maxBlocks = this.limits.maxBlocks;
    for (;;) {
      const f = this.frame;
      const lines = f.program.lines;
      const file = f.program.name;
      while (f.pc < lines.length) {
        const line = lines[f.pc] as Line;
        f.pc++;
        if (++this.blocks > maxBlocks) {
          this.stop(line.lineNo, 'SEMANTIC_LIMIT_BLOCKS', `more than ${maxBlocks} blocks run`);
          return;
        }
        if (file === null) this.line(line, f.pc - 1);
        else {
          const s0 = this.steps.length;
          const d0 = this.diagnostics.length;
          this.line(line, f.pc - 1);
          this.attribute(s0, d0, file);
        }
        if (this.steps.length > this.limits.maxSteps) {
          this.stop(line.lineNo, 'SEMANTIC_LIMIT_STEPS', `more than ${this.limits.maxSteps} steps`);
          return;
        }
        if (this.ended || this.stopped) return;
        if (this.frame !== f) break;
      }
      if (this.frame === f) {
        // Ran off the end of the frame's file.
        if (this.frames.length === 1) return;
        const last = lines[lines.length - 1];
        this.report(
          last?.lineNo ?? 0,
          'warning',
          'SEMANTIC_SUB_NO_RETURN',
          f.kind === 'm98'
            ? 'Subprogram file ends without M99; returning'
            : `Subroutine o${f.label} ends without endsub; returning`,
        );
        if (file !== null) this.attribute(this.steps.length, this.diagnostics.length - 1, file);
        this.leave();
      }
    }
  }

  /**
   * Tags the steps and diagnostics since (s0, d0) with the subprogram file they came
   * from. Entries already tagged keep their file: loading another file from this one
   * reports that file's own findings under its name.
   */
  private attribute(s0: number, d0: number, file: string): void {
    for (let i = s0; i < this.steps.length; i++) {
      const step = this.steps[i] as Step;
      if (step.file === undefined) this.steps[i] = { ...step, file };
    }
    for (let i = d0; i < this.diagnostics.length; i++) {
      const d = this.diagnostics[i] as Diagnostic;
      if (d.file === undefined) this.diagnostics[i] = { ...d, file };
    }
  }

  // ── One line ────────────────────────────────────────────────────────────

  private line(line: Line, index: number): void {
    // The fast path does what the general one does, minus the hook: skip it when watched.
    if (!this.onBlock && this.fastLine(line)) return;
    const n = line.lineNo;
    const tokens = line.tokens;
    if (tokens.length === 0) return;

    // Syntax errors make the line unsafe to execute.
    if (line.diagnostics.some((d) => d.severity === 'error')) {
      this.report(n, 'error', 'SEMANTIC_LINE_NOT_RUN', 'Line not run: it has syntax errors');
      return;
    }

    if (tokens[0]?.kind === 'percent') {
      // Per file: a %-wrapped subprogram file must not end the whole run.
      if (this.frame.percentSeen) this.end(n, '%');
      this.frame.percentSeen = true;
      return;
    }
    if (tokens[0]?.kind === 'block-delete') {
      if (this.behaviour.blockDelete === 'ignored') {
        this.reportOnce(
          n,
          'info',
          'SEMANTIC_BLOCK_DELETE_IGNORED',
          'This controller ignores "/" (block delete): such lines run',
        );
      } else if (this.blockDelete) {
        this.report(n, 'info', 'SEMANTIC_BLOCK_DELETED', 'Skipped: block delete ("/") is on');
        return;
      }
    }
    const message = tokens.find((t) => t.kind === 'message');
    if (message) {
      if (this.behaviour.messages.lines)
        this.steps.push({ kind: 'message', line: n, text: message.text, target: message.target });
      else
        this.report(
          n,
          'warning',
          'SEMANTIC_MSG_NOT_SUPPORTED',
          'MSG lines are Masso syntax; this controller would not read it as a message. Ignored',
          message.span,
        );
      return;
    }
    if (this.behaviour.messages.comments) this.commentMessages(line);
    if (
      !this.behaviour.parameters &&
      tokens.some(
        (t) => t.kind === 'assignment' || (t.kind === 'word' && t.value?.kind === 'expression'),
      )
    ) {
      this.report(
        n,
        'error',
        'SEMANTIC_PARAMETERS_UNSUPPORTED',
        'This controller has no expressions or parameters (#, [ ]); line not run',
      );
      return;
    }
    if (tokens.some((t) => t.kind === 'oword')) {
      this.flowLine(line, index);
      return;
    }
    for (const t of tokens) {
      if (t.kind === 'checksum')
        this.report(n, 'warning', 'SEMANTIC_CHECKSUM_IGNORED', 'Line checksum ignored', t.span);
    }

    // 1. Evaluate every value with the parameters as they were BEFORE this line.
    const words: Word[] = [];
    const assignments: { target: string; value: number }[] = [];
    let bad = false;
    for (const t of tokens) {
      if (t.kind === 'word' && t.value) {
        const v = this.value(line, t.value);
        if (v === null) bad = true;
        else words.push({ letter: t.letter, value: v, span: t.span });
      } else if (t.kind === 'assignment' && t.value) {
        const v = this.value(line, t.value);
        const target = line.text.slice(t.target.start, t.target.end);
        if (v === null) bad = true;
        else assignments.push({ target, value: v });
      }
    }
    if (bad) {
      this.report(
        n,
        'error',
        'SEMANTIC_LINE_NOT_RUN',
        'Line not run: a value could not be evaluated',
      );
      return;
    }
    if (!this.checkLine(n, words)) return;

    if (this.onBlock) {
      const file = this.frame.program.name;
      this.onBlock({ line: n, ...(file === null ? {} : { file }), state: this.state() });
    }
    this.execute(n, words);
    for (const a of assignments) this.assign(line, a.target, a.value);
    // M98/M99 act after the rest of the line (their parameters are already set).
    if (this.pendingCall) {
      const { p, l } = this.pendingCall;
      this.pendingCall = null;
      this.m98(n, p, l);
    }
    if (this.pendingReturn) {
      this.pendingReturn = false;
      this.m99(n);
    }
  }

  /**
   * Fast path for the overwhelmingly common CAM line: plain-number X/Y/Z/A/B/C/F/N
   * words under a modal G0 or G1 (e.g. `X12.5 Y3.2 Z-1`). It does exactly what the
   * general path would, without that path's per-line allocations (ADR-0014 budget).
   * Anything else (G/M codes, expressions, repeats, arcs, syntax errors, negative F)
   * returns false and takes the general path, so behaviour cannot diverge.
   */
  private fastLine(line: Line): boolean {
    const tokens = line.tokens;
    if (tokens.length === 0 || line.diagnostics.length > 0) return false;
    let seen = 0;
    let f: number | undefined;
    let g: 'G0' | 'G1' | undefined;
    let axes = 0;
    for (const t of tokens) {
      if (t.kind === 'comment') {
        // A (MSG, …) comment is a message on some controllers: take the general path.
        if (this.behaviour.messages.comments && /^\s*msg\s*,/i.test(t.text)) return false;
        continue;
      }
      if (t.kind !== 'word' || t.value?.kind !== 'number') return false;
      const b = FAST_LETTERS[t.letter];
      if (b === undefined || (seen & b) !== 0) return false;
      seen |= b;
      const v = t.value.value;
      if (t.letter === 'G') {
        // Only a lone G0 or G1: it just sets the motion mode, as the general path would.
        if (v === 0) g = 'G0';
        else if (v === 1) g = 'G1';
        else return false;
      } else if (t.letter === 'F') {
        if (v < 0) return false;
        f = v;
      } else if (t.letter !== 'N') axes++;
    }
    const motion = g ?? this.motion;
    if (motion !== 'G0' && motion !== 'G1') return false;
    this.motion = motion;
    // An ordinary motion ends a run of canned cycles (as the general path does).
    this.cycleInitial = null;
    if (f !== undefined) {
      this.feedRate = this.feedMode === 'inverse-time' ? f : f * (this.units === 'inch' ? 25.4 : 1);
    }
    if (axes === 0) return true;
    const words: Word[] = [];
    for (const t of tokens) {
      if (t.kind === 'word' && t.value?.kind === 'number' && t.letter !== 'N' && t.letter !== 'G') {
        words.push({ letter: t.letter, value: t.value.value, span: t.span });
      }
    }
    if (this.settleLine !== null && motion === 'G1') this.adviseSettle(line.lineNo);
    this.move(line.lineNo, words, false, NO_USED);
    return true;
  }

  /** Letters, repeats and modal groups. False means: do not run the line. */
  private checkLine(n: number, words: readonly Word[]): boolean {
    let ok = true;
    let seenBits = 0;
    // Group → code, as small parallel arrays: most lines have no G or M word.
    const gGroups: number[] = [];
    const gGroupCodes: string[] = [];
    const mGroups: number[] = [];
    const mGroupCodes: string[] = [];
    for (const w of words) {
      if (!KNOWN_LETTERS.has(w.letter)) {
        const hint =
          w.letter === 'E' ? ' (G-code has no exponent notation: X1e3 is X1 then E3)' : '';
        this.report(
          n,
          'error',
          'SEMANTIC_UNSUPPORTED_WORD',
          `"${w.letter}" is not a word this dialect understands${hint}`,
          w.span,
        );
        ok = false;
        continue;
      }
      if (w.letter === 'G' || w.letter === 'M') {
        const table = w.letter === 'G' ? G_CODES : M_CODES;
        const key = codeKey(w.value);
        const info = table.get(key);
        if (!info) {
          this.report(
            n,
            'error',
            'SEMANTIC_UNSUPPORTED_CODE',
            `${w.letter}${key} is not supported; line not run`,
            w.span,
          );
          ok = false;
          continue;
        }
        const allowed = this.behaviour.codes;
        if (allowed && !(w.letter === 'G' ? allowed.g : allowed.m).includes(key)) {
          this.report(
            n,
            'error',
            'SEMANTIC_UNSUPPORTED_CODE',
            `${w.letter}${key} is not supported by this controller; line not run`,
            w.span,
          );
          ok = false;
          continue;
        }
        const pending = allowed?.later?.[`${w.letter}${key}`];
        if (pending) {
          this.report(
            n,
            'error',
            'SEMANTIC_NOT_YET_SUPPORTED',
            `${w.letter}${key} is not interpreted yet for this controller: ${pending}; line not run`,
            w.span,
          );
          ok = false;
          continue;
        }
        if (
          w.letter === 'M' &&
          (key === '98' || key === '99') &&
          this.behaviour.subprograms.m98 === 'in-file'
        ) {
          this.report(
            n,
            'error',
            'SEMANTIC_NOT_YET_SUPPORTED',
            `M${key}: numbered subprograms within the file (Fanuc style) are not interpreted yet; line not run`,
            w.span,
          );
          ok = false;
          continue;
        }
        if (info.later) {
          this.report(
            n,
            'error',
            'SEMANTIC_NOT_YET_SUPPORTED',
            `${w.letter}${key} is not interpreted yet: ${info.later}; line not run`,
            w.span,
          );
          ok = false;
          continue;
        }
        const groups = w.letter === 'G' ? gGroups : mGroups;
        const groupCodes = w.letter === 'G' ? gGroupCodes : mGroupCodes;
        const at = groups.indexOf(info.group);
        const prev = at === -1 ? undefined : groupCodes[at];
        // M7 and M8 may both be on (LinuxCNC Table 6).
        const coolantPair =
          w.letter === 'M' && info.group === 8 && [prev, key].sort().join() === '7,8';
        if (prev !== undefined && info.group !== 0 && !coolantPair) {
          this.report(
            n,
            'error',
            'SEMANTIC_MODAL_GROUP_CONFLICT',
            `${w.letter}${prev} and ${w.letter}${key} are in the same modal group; line not run`,
            w.span,
          );
          ok = false;
        }
        groups.push(info.group);
        groupCodes.push(key);
        continue;
      }
      if (w.letter === 'N') continue;
      if ((seenBits & bit(w.letter)) !== 0) {
        this.report(
          n,
          'error',
          'SEMANTIC_REPEATED_WORD',
          `"${w.letter}" appears more than once; line not run`,
          w.span,
        );
        ok = false;
      }
      seenBits |= bit(w.letter);
    }
    return ok;
  }

  // ── Execution in RS274 order ────────────────────────────────────────────

  private execute(n: number, words: readonly Word[]): void {
    const get = (letter: string) => words.find((w) => w.letter === letter);
    // One pass; most lines have no G or M word at all, so no set is built for them.
    const gCodes: string[] = [];
    const mCodes: string[] = [];
    for (const w of words) {
      if (w.letter === 'G') gCodes.push(codeKey(w.value));
      else if (w.letter === 'M') mCodes.push(codeKey(w.value));
    }
    const g = {
      has: (c: string) => gCodes.includes(c),
      [Symbol.iterator]: () => gCodes[Symbol.iterator](),
    };
    const m = { has: (c: string) => mCodes.includes(c) };
    let usedBits = bit('G') | bit('M') | bit('N') | bit('F') | bit('S') | bit('T');
    const used = {
      add: (l: string) => (usedBits |= bit(l)),
      has: (l: string) => (usedBits & bit(l)) !== 0,
    };

    // Feed rate mode (G93/G94/G95), then feed (F), spindle speed (S), tool select (T).
    if (g.has('93')) this.feedMode = 'inverse-time';
    if (g.has('94')) this.feedMode = 'per-minute';
    if (g.has('95')) this.feedMode = 'per-revolution';
    // Units (G20/G21) are step 12 and F is step 3, so by RS274 order F is read in the
    // units in force before this line's G20/G21. Controllers disagree on this, so it's
    // dialect data (InterpreterRules.feedUnits), and a line that actually changes units
    // alongside an F word gets a warning either way.
    const unitsAfter = g.has('20') ? 'inch' : g.has('21') ? 'mm' : this.units;
    const f = get('F');
    const feedUnits = this.behaviour.feedUnits === 'end-of-line' ? unitsAfter : this.units;
    if (f && unitsAfter !== this.units) {
      this.report(
        n,
        'warning',
        'SEMANTIC_FEED_UNITS_AMBIGUOUS',
        `F and a unit change (G${unitsAfter === 'inch' ? 20 : 21}) on one line: controllers disagree about F's units. Read here as ${feedUnits === 'inch' ? 'in' : 'mm'}/min`,
        f.span,
      );
    }
    if (f) {
      if (f.value < 0)
        this.report(n, 'error', 'SEMANTIC_NEGATIVE_FEED', 'Feed rate cannot be negative', f.span);
      else
        this.feedRate =
          this.feedMode === 'inverse-time' ? f.value : f.value * (feedUnits === 'inch' ? 25.4 : 1);
    }
    // Masso M66: S is the number of lines to skip, not a spindle speed.
    const m66Wait = this.behaviour.m66 === 'masso-wait' && m.has('66');
    const s = m66Wait ? undefined : get('S');
    if (s) {
      if (s.value < 0)
        this.report(
          n,
          'error',
          'SEMANTIC_NEGATIVE_SPEED',
          'Spindle speed cannot be negative',
          s.span,
        );
      else {
        // A speed change while running isn't waited for (spindleSettleAdvice).
        if (
          this.behaviour.spindleSettleAdvice &&
          this.spindle.state !== 'off' &&
          this.spindle.rpm !== s.value &&
          !m.has('5')
        )
          this.settleLine = n;
        this.spindle = { ...this.spindle, rpm: s.value };
        if (this.spindle.state !== 'off' && !m.has('3') && !m.has('4') && !m.has('5')) {
          this.steps.push({ kind: 'spindle', line: n, state: this.spindle.state, rpm: s.value });
        }
      }
    }
    const t = get('T');
    if (t) this.selectedTool = Math.round(t.value);

    // Tool change (M6), spindle (M3/M4/M5), coolant (M7/M8/M9), overrides (M48/M49).
    if (m.has('6') && this.behaviour.toolChangeChecks) {
      const tAt = words.findIndex((w) => w.letter === 'T');
      const mAt = words.findIndex((w) => w.letter === 'M' && codeKey(w.value) === '6');
      if (tAt > mAt && mAt >= 0)
        this.report(
          n,
          'warning',
          'SEMANTIC_TOOL_AFTER_M6',
          'T comes after M06 on this line: this controller loads the tool differently then (Masso docs: T must precede M06)',
        );
      if (this.spindle.state !== 'off' && !m.has('5'))
        this.report(
          n,
          'warning',
          'SEMANTIC_M6_SPINDLE_ON',
          'Tool change with the spindle running: this controller requires M05 before M06',
        );
    }
    if (m.has('6.1')) {
      // Masso M6.1: unload the tool from the spindle.
      this.tool = null;
      this.steps.push({ kind: 'tool-change', line: n, tool: null });
    }
    if (m.has('6')) {
      if (this.selectedTool === null)
        this.report(
          n,
          'warning',
          'SEMANTIC_TOOL_CHANGE_NO_TOOL',
          'M6 with no tool selected (no T word yet)',
        );
      this.tool = this.selectedTool;
      this.steps.push({ kind: 'tool-change', line: n, tool: this.tool });
    }
    for (const [code, state] of SPINDLE_CODES) {
      if (m.has(code)) {
        // Starting from stopped, the controller waits for spin-up itself; stopping ends it.
        if (state === 'off' || this.spindle.state === 'off') this.settleLine = null;
        this.spindle = { ...this.spindle, state };
        this.steps.push({ kind: 'spindle', line: n, state, rpm: this.spindle.rpm });
      }
    }
    if (m.has('7') || m.has('8') || m.has('9')) {
      if (m.has('9')) this.mist = this.flood = false;
      if (m.has('7')) this.mist = true;
      if (m.has('8')) this.flood = true;
      this.steps.push({ kind: 'coolant', line: n, mist: this.mist, flood: this.flood });
    }
    if (m66Wait) {
      for (const l of ['P', 'L', 'Q', 'S']) used.add(l);
      const p = get('P');
      const q = get('Q');
      const skip = Math.max(0, Math.round(get('S')?.value ?? 0));
      this.steps.push({
        kind: 'wait',
        line: n,
        input: p ? Math.round(p.value) : null,
        timeoutSeconds: q ? q.value / 1000 : null,
        skipLines: skip,
      });
      if (skip > 0)
        this.report(
          n,
          'warning',
          'SEMANTIC_WAIT_MAY_SKIP',
          `If the input condition is met, the controller skips the next ${skip} line(s); the preview runs them`,
        );
    }
    for (const code of IO_CODES) {
      if (code === '66' && m66Wait) continue;
      if (m.has(code))
        this.report(
          n,
          'warning',
          'SEMANTIC_IO_IGNORED',
          `M${code} (machine I/O) has no effect on the path; ignored`,
        );
    }

    // Dwell (G4).
    if (g.has('4')) {
      used.add('P');
      const p = get('P');
      if (!p) this.report(n, 'error', 'SEMANTIC_DWELL_WITHOUT_P', 'G4 needs a P word (seconds)');
      else if (p.value < 0)
        this.report(n, 'error', 'SEMANTIC_NEGATIVE_DWELL', 'Dwell time cannot be negative', p.span);
      else {
        this.steps.push({ kind: 'dwell', line: n, seconds: this.dwellSeconds(p.value) });
        this.settleLine = null;
      }
    }

    // Plane, units, cutter compensation, tool length offset, coordinate system,
    // path control, distance modes, retract mode.
    if (g.has('17')) this.plane = 'XY';
    if (g.has('18')) this.plane = 'ZX';
    if (g.has('19')) this.plane = 'YZ';
    // The first G20/G21 that actually runs, by step: exact under subroutines, skipped
    // branches and block delete (SEMANTIC_UNITS_ASSUMED, review of toolkit #37).
    if ((g.has('20') || g.has('21')) && this.unitsStatedAt === null)
      this.unitsStatedAt = this.steps.length;
    this.units = unitsAfter;
    if (g.has('40')) this.cutterComp = 'off';
    if (g.has('41') || g.has('42')) {
      used.add('D');
      this.cutterComp = g.has('41') ? 'left' : 'right';
      const d = get('D');
      this.report(
        n,
        'warning',
        'SEMANTIC_CUTTER_COMP_NOT_APPLIED',
        `Cutter compensation (G${g.has('41') ? 41 : 42}${d ? ` D${d.value}` : ''}) is not simulated: the path is drawn uncompensated (ADR-0016)`,
      );
    }
    if (g.has('43')) {
      used.add('H');
      this.toolLength = true;
      this.reportOnce(
        n,
        'info',
        'SEMANTIC_TOOL_LENGTH_NOT_APPLIED',
        'Tool length offsets are not applied (no tool table): Z is drawn as programmed',
      );
    }
    if (g.has('49')) this.toolLength = false;
    for (const [code, cs] of WCS_CODES) {
      if (g.has(code)) this.setParam(5220, cs);
    }
    if (g.has('54.1')) {
      // Masso extended offsets G54.1 P1-P100, stored as coordinate systems 101-200.
      used.add('P');
      const p = get('P');
      const k = p ? Math.round(p.value) : NaN;
      if (!p || Math.abs(p.value - k) > 1e-4 || !(k >= 1 && k <= 100))
        this.report(
          n,
          'error',
          'SEMANTIC_G54_1_P',
          'G54.1 needs P1 to P100 (the extended work offset)',
        );
      else this.setParam(5220, 100 + k);
    }
    if (g.has('61')) this.pathControl = 'G61';
    if (g.has('61.1')) this.pathControl = 'G61.1';
    if (g.has('64')) this.pathControl = 'G64';
    if (g.has('90')) this.distance = 'absolute';
    if (g.has('91')) this.distance = 'incremental';
    if (g.has('90.1')) this.arcDistance = 'absolute';
    if (g.has('91.1')) this.arcDistance = 'incremental';
    if (g.has('98')) this.retract = 'initial';
    if (g.has('99')) this.retract = 'r-plane';

    // Group-0 codes: home (G28/G30), coordinate data (G10), offsets (G52/G92).
    const axisWords = words.filter((w) => w.letter in AXIS_INDEX);
    const group0WithAxes = [...g].filter((c) => AXIS_GROUP0.has(c));
    const explicitMotion = MOTION_CODES.filter((c) => g.has(c));
    if (group0WithAxes.length > 1) {
      this.report(
        n,
        'error',
        'SEMANTIC_MODAL_GROUP_CONFLICT',
        `G${group0WithAxes.join(' and G')} both use axis words; line not run`,
      );
      return;
    }
    if (group0WithAxes.length === 1 && explicitMotion.length > 0 && axisWords.length > 0) {
      this.report(
        n,
        'error',
        'SEMANTIC_AXIS_WORDS_CONFLICT',
        `G${group0WithAxes[0]} and G${explicitMotion[0]} both want the axis words; line not run`,
      );
      return;
    }
    let motionSuspended = group0WithAxes.length === 1;
    if (motionSuspended) for (const w of axisWords) used.add(w.letter);
    if (g.has('28.1') || g.has('30.1')) this.storeHome(g.has('28.1') ? 5161 : 5181);
    if (g.has('10')) {
      used.add('L');
      used.add('P');
      used.add('R');
      if (this.behaviour.g10 === 'masso') this.g10Masso(n, words);
      else this.g10(n, words);
    }
    if (g.has('92')) this.g92(words);
    if (g.has('52')) this.g52(words);
    if (g.has('92.1') || g.has('92.2')) {
      this.setParam(5210, 0);
      if (g.has('92.1')) for (const a of AXES) this.setParam(5211 + AXIS_INDEX[a], 0);
    }
    if (g.has('92.3')) this.setParam(5210, 1);
    if (g.has('28') || g.has('30')) {
      if (this.behaviour.homing === 'masso') this.homeMasso(n, g.has('28') ? 28 : 30, words);
      else this.home(n, g.has('28') ? 5161 : 5181, words);
      motionSuspended = true;
    }

    // Motion (G0–G3, G80), possibly modified by G53.
    const priorMotion = this.motion;
    for (const c of explicitMotion) this.motion = `G${c}` as ModalState['motion'];
    // Masso: "after G80 … the controller automatically returns to G00 rapid motion".
    if (this.motion === 'G80' && this.behaviour.afterG80 === 'rapid') this.motion = 'G0';
    // The cycle's initial level (LinuxCNC cycle_il) ends when any other motion runs.
    if (!CYCLES.has(this.motion)) this.cycleInitial = null;
    if (!motionSuspended && CYCLES.has(this.motion)) {
      if (axisWords.length > 0) this.cycle(n, words, priorMotion, used);
      else if (explicitMotion.length > 0)
        this.report(
          n,
          'error',
          'SEMANTIC_CYCLE_NO_AXES',
          `${this.motion} needs X, Y or Z; line not run`,
        );
    } else if (!motionSuspended) {
      const arcWords = words.some((w) => 'IJKR'.includes(w.letter));
      if (axisWords.length > 0 || (arcWords && (this.motion === 'G2' || this.motion === 'G3'))) {
        for (const w of axisWords) used.add(w.letter);
        this.move(n, words, g.has('53'), used);
      } else if (explicitMotion.includes('2') || explicitMotion.includes('3')) {
        // 2.9 convert_arc: a G2/G3 block with no I/J/K/R is an error, even with no axes.
        this.report(
          n,
          'error',
          'SEMANTIC_ARC_NO_CENTRE',
          `${this.motion} needs R or centre offsets; line not run`,
        );
      } else if (g.has('53')) {
        this.report(
          n,
          'warning',
          'SEMANTIC_G53_WITHOUT_MOTION',
          'G53 has no effect without axis words',
        );
      }
    }

    // Subprogram call and return (M98/M99): queued to run after the line (see line()).
    if (m.has('98')) {
      used.add('P');
      used.add('L');
      this.pendingCall = { p: get('P'), l: get('L') };
    }
    if (m.has('99')) this.pendingReturn = true;

    // Stop (M0, M1, M2, M30, M60).
    if (m.has('0') || m.has('60')) this.steps.push({ kind: 'pause', line: n, optional: false });
    if (m.has('1')) this.steps.push({ kind: 'pause', line: n, optional: true });
    if (m.has('2')) this.end(n, 'M2');
    if (m.has('30')) this.end(n, 'M30');

    for (const w of words) {
      if (!used.has(w.letter)) {
        this.report(
          n,
          'warning',
          'SEMANTIC_UNUSED_WORD',
          `"${w.letter}${w.value}" has no effect on this line`,
          w.span,
        );
      }
    }
  }

  // ── Program flow and subprograms (parcel 2c-3, ADR-0021) ───────────────

  /** An O-word line: follows the structure matched by {@link buildFlowIndex}. */
  private flowLine(line: Line, index: number): void {
    const n = line.lineNo;
    if (!this.behaviour.subprograms.oWord) {
      this.report(
        n,
        'error',
        'SEMANTIC_UNSUPPORTED_OWORD',
        'O-words (subroutines, loops, conditions) are not supported by this dialect; line not run',
      );
      return;
    }
    const f = this.frame;
    const op = this.flowOf(f.program).ops[index];
    if (!op) return;
    if (op.broken) {
      this.stop(n, 'SEMANTIC_FLOW_STOPPED', 'the O-word structure is broken at this line');
      return;
    }
    if (op.extraWords) {
      // LinuxCNC 2.9 read_o: "nothing is allowed except comments".
      this.stop(
        n,
        'SEMANTIC_OWORD_EXTRA_WORDS',
        'only comments may follow an O-word and its [arguments] ("Unexpected character after O-word")',
      );
      return;
    }
    const lines = f.program.lines;
    switch (op.kind) {
      case 'program':
      case 'do':
      case 'endif':
        return;
      case 'sub': {
        // Reached in sequence, this is a definition: its body runs only when called.
        // Reaching one already recorded (by an earlier pass, or a forward call) is
        // LinuxCNC's "sub ... found in illegal location" (control_save_offset).
        const saved = this.savedSubs.get(f.program) ?? new Set<number>();
        this.savedSubs.set(f.program, saved);
        if (saved.has(index)) {
          this.stop(
            n,
            'SEMANTIC_OWORD_SUB_ILLEGAL_LOCATION',
            `the definition of o${op.label} is reached again after it was defined or called`,
          );
          return;
        }
        saved.add(index);
        f.pc = op.target + 1;
        return;
      }
      case 'call':
        this.call(line, op);
        return;
      case 'endsub':
      case 'return':
        this.subReturn(line, op);
        return;
      case 'if': {
        // Test the if, then each elseif in turn; run the first true branch, or the else.
        let at = index;
        let cur: FlowOp = op;
        for (;;) {
          if (cur.kind === 'else') break;
          const c = this.condition(lines[at] as Line, cur);
          if (c === null) return;
          if (c) break;
          at = cur.target;
          const next = this.flowOf(f.program).ops[at];
          if (!next || next.kind === 'endif') break;
          cur = next;
        }
        f.pc = at + 1;
        return;
      }
      case 'elseif':
      case 'else':
        // Reached in sequence: the branch before it ran, so the chain is done. LinuxCNC
        // still evaluates an elseif's condition here (read_o skips evaluation only for
        // other labels), so one that can't be evaluated stops the run.
        if (op.kind === 'elseif' && this.condition(line, op) === null) return;
        f.pc = op.end + 1;
        return;
      case 'while': {
        const c = this.condition(line, op);
        if (c === null) return;
        if (!c) f.pc = op.end + 1;
        return;
      }
      case 'endwhile':
        if (this.iterate(n)) f.pc = op.target;
        return;
      case 'do-while': {
        const c = this.condition(line, op);
        if (c === null) return;
        if (c && this.iterate(n)) f.pc = op.target + 1;
        return;
      }
      case 'repeat': {
        // Only reached on entry: endrepeat jumps back past it. The count is read once
        // and rounded half to even (LinuxCNC round_to_int is nearbyint); zero or less
        // skips the body.
        const arg = op.args[0];
        if (!arg) {
          this.stop(n, 'SEMANTIC_OWORD_NO_ARGUMENT', `o${op.label} repeat needs a count, e.g. [5]`);
          return;
        }
        const v = this.value(line, arg);
        if (v === null) {
          this.stop(n, 'SEMANTIC_FLOW_STOPPED', 'the repeat count could not be evaluated');
          return;
        }
        const count = nearbyint(v);
        if (count <= 0) f.pc = op.end + 1;
        else (f.repeats ??= new Map()).set(index, count - 1);
        return;
      }
      case 'endrepeat': {
        const left = f.repeats?.get(op.target) ?? 0;
        if (left > 0 && this.iterate(n)) {
          f.repeats?.set(op.target, left - 1);
          f.pc = op.target + 1;
        } else f.repeats?.delete(op.target);
        return;
      }
      case 'break': {
        // A do loop's closing while is still read, so its condition is evaluated.
        const loop = this.flowOf(f.program).ops[op.target];
        const close = this.flowOf(f.program).ops[op.end];
        if (loop?.kind === 'do' && close && this.condition(lines[op.end] as Line, close) === null)
          return;
        f.pc = op.end + 1;
        return;
      }
      case 'continue': {
        // A while re-tests at its top; a do tests at its closing while.
        // (The do's closing while counts its own iteration; a while's top does not.)
        const loop = this.flowOf(f.program).ops[op.target];
        if (loop?.kind === 'do') f.pc = op.end;
        else if (this.iterate(n)) f.pc = op.target;
        return;
      }
    }
  }

  /** The flow index of a program, built on first use; registers its subroutines. */
  private flowOf(program: Loaded): FlowIndex {
    if (program.flow) return program.flow;
    const flow = buildFlowIndex(program.lines);
    program.flow = flow;
    for (const d of flow.diagnostics)
      this.add(program.name === null ? d : { ...d, file: program.name });
    for (const [label, def] of flow.subs) {
      if (!this.subs.has(label)) this.subs.set(label, { program, def });
    }
    return flow;
  }

  /**
   * A condition's truth (LinuxCNC: any non-zero value is true), or null after stopping
   * the run: when a condition can't be evaluated, which branch runs is unknowable.
   */
  private condition(line: Line, op: FlowOp): boolean | null {
    const arg = op.args[0];
    if (!arg) {
      this.stop(
        line.lineNo,
        'SEMANTIC_OWORD_NO_ARGUMENT',
        `o${op.label} ${op.kind === 'do-while' ? 'while' : op.kind} needs a condition, e.g. [#1 LT 3]`,
      );
      return null;
    }
    const v = this.value(line, arg);
    if (v === null) {
      this.stop(line.lineNo, 'SEMANTIC_FLOW_STOPPED', 'the condition could not be evaluated');
      return null;
    }
    return v !== 0;
  }

  /** Counts one loop iteration against the safety limit. False (and stopped) when over it. */
  private iterate(n: number): boolean {
    if (++this.iterations <= this.limits.maxLoopIterations) return true;
    this.stop(
      n,
      'SEMANTIC_LIMIT_ITERATIONS',
      `more than ${this.limits.maxLoopIterations} loop iterations`,
    );
    return false;
  }

  /** Whether one more call level is allowed; stops the run if not (the controller aborts). */
  private canNest(n: number, what: string): boolean {
    const depth = this.frames.length; // the new frame's depth below the main program
    const dialect = this.behaviour.subprograms.maxCallDepth;
    if (depth > this.limits.maxCallDepth) {
      this.stop(
        n,
        'SEMANTIC_LIMIT_CALL_DEPTH',
        `calls nested more than ${this.limits.maxCallDepth} deep`,
      );
      return false;
    }
    if (depth > dialect) {
      this.stop(
        n,
        'SEMANTIC_CALL_TOO_DEEP',
        `${what} would nest calls ${depth} deep; this controller allows ${dialect}, so the program fails here on the machine`,
      );
      return false;
    }
    return true;
  }

  /** `o<label> call [a] [b] …` (LinuxCNC `execute_call`, CT_NGC_OWORD_SUB). */
  private call(line: Line, op: FlowOp): void {
    const n = line.lineNo;
    // A failed call aborts the program on the controller (LinuxCNC 2.9), so it stops
    // the run: drawing on would show a path the machine won't take.
    const sub = this.findSub(op.label, n);
    if (!sub) {
      this.stopped = true;
      return;
    }
    if (!this.canNest(n, `o${op.label} call`)) return;
    if (op.args.length > SUB_PARAMS) {
      this.stop(n, 'SEMANTIC_CALL_ARGUMENTS', `a call takes at most ${SUB_PARAMS} arguments`);
      return;
    }
    // Arguments are evaluated in the caller, before anything changes.
    const args: number[] = [];
    for (const a of op.args) {
      const v = this.value(line, a);
      if (v === null) {
        this.stop(n, 'SEMANTIC_FLOW_STOPPED', 'a call argument could not be evaluated');
        return;
      }
      args.push(v);
    }
    // #1-#30 are local: save the caller's, pass the arguments, and ZERO the rest
    // (LinuxCNC 2.9 read_o: "zero the remaining params"; execute_call copies all 30).
    // So `o<sub> if [#3 EQ 0]` reliably detects an argument that wasn't passed.
    const saved: number[] = [];
    for (let i = 1; i <= SUB_PARAMS; i++) saved.push(this.numbered.get(i) ?? 0);
    for (let k = 0; k < SUB_PARAMS; k++) this.numbered.set(k + 1, args[k] ?? 0);
    // Recorded in the offset table: flow reaching the definition later is an error.
    const saved2 = this.savedSubs.get(sub.program) ?? new Set<number>();
    saved2.add(sub.def.start);
    this.savedSubs.set(sub.program, saved2);
    this.enter({
      program: sub.program,
      pc: sub.def.start + 1,
      kind: 'o-sub',
      label: op.label,
      saved,
      named: new Map(),
      repeats: null,
      m98Left: 0,
      percentSeen: false,
    });
  }

  /** `o<label> endsub [v]` or `o<label> return [v]`: back to the caller, with an optional value. */
  private subReturn(line: Line, op: FlowOp): void {
    const n = line.lineNo;
    if (this.frame.kind !== 'o-sub') {
      this.stop(n, 'SEMANTIC_FLOW_STOPPED', `o${op.label} ${op.kind} outside a subroutine call`);
      return;
    }
    // LinuxCNC 2.9 read_o: a value sets #<_value> and #<_value_returned>; no value
    // zeroes both.
    const arg = op.args[0];
    let v = 0;
    if (arg) {
      const r = this.value(line, arg);
      if (r === null) {
        this.stop(n, 'SEMANTIC_FLOW_STOPPED', 'the return value could not be evaluated');
        return;
      }
      v = r;
    }
    this.globalNamed.set('_value', v);
    this.globalNamed.set('_value_returned', arg ? 1 : 0);
    this.leave();
  }

  /** Masso-style `M98 P<n> [L<runs>]`: runs the separate file n, L times (default once). */
  private m98(n: number, p: Word | undefined, l: Word | undefined): void {
    if (!p) {
      this.report(
        n,
        'error',
        'SEMANTIC_M98_NO_P',
        'M98 needs a P word (the subprogram number); call not run',
      );
      return;
    }
    // LinuxCNC's integer check (read_o): within 0.0001 of a whole number.
    const num = Math.round(p.value);
    if (Math.abs(p.value - num) > 0.0001 || num < 1) {
      this.report(
        n,
        'error',
        'SEMANTIC_M98_BAD_P',
        'M98 P must be a positive whole number; call not run',
        p.span,
      );
      return;
    }
    const runs = l ? Math.round(l.value) : 1;
    if (l && (Math.abs(l.value - runs) > 0.0001 || runs < 0)) {
      this.report(
        n,
        'error',
        'SEMANTIC_M98_BAD_L',
        'M98 L (runs) must be a whole number, 0 or more; call not run',
        l.span,
      );
      return;
    }
    if (runs === 0) return; // M98 L0: the subprogram is not run
    const name = String(num);
    const program = this.load('m98', name, n);
    if (!program) {
      // Masso: "an error message is displayed and the program enters Feed Hold".
      this.stopped = true;
      return;
    }
    if (!this.canNest(n, `M98 P${name}`)) return;
    // Loop passes after the first count against the iteration limit up front.
    if (runs - 1 > this.limits.maxLoopIterations - this.iterations) {
      this.stop(
        n,
        'SEMANTIC_LIMIT_ITERATIONS',
        `more than ${this.limits.maxLoopIterations} loop iterations`,
      );
      return;
    }
    this.iterations += runs - 1;
    this.enter({
      program,
      pc: 0,
      kind: 'm98',
      label: name,
      saved: null,
      // #1-#30 are shared with the caller (M98 doesn't save them); named locals are
      // fresh, as in LinuxCNC 2.9 (Masso has no parameters at all).
      named: new Map(),
      repeats: null,
      m98Left: runs - 1,
      percentSeen: false,
    });
  }

  /** M99: the end of an M98 subprogram. */
  private m99(n: number): void {
    const f = this.frame;
    if (f.kind === 'm98') {
      this.leave();
      return;
    }
    if (f.kind === 'o-sub') {
      this.stop(n, 'SEMANTIC_FLOW_STOPPED', `M99 cannot end subroutine o${f.label} (use endsub)`);
      return;
    }
    // In the main program, LinuxCNC restarts the program from the top, forever.
    this.report(
      n,
      'warning',
      'SEMANTIC_M99_IN_MAIN',
      'M99 in the main program: drawn as the program end (LinuxCNC ends there unless set to loop; untested on Masso)',
    );
    this.end(n, 'M99');
  }

  private enter(frame: Frame): void {
    this.frames.push(frame);
    this.frame = frame;
  }

  /** Returns from the current frame, or starts its next M98 L run. */
  private leave(): void {
    const f = this.frame;
    if (f.kind === 'm98' && f.m98Left > 0) {
      f.m98Left--;
      f.pc = 0;
      return;
    }
    this.frames.pop();
    this.frame = this.frames[this.frames.length - 1] as Frame;
    if (f.saved) f.saved.forEach((v, k) => this.numbered.set(k + 1, v));
  }

  /** A subroutine by label: defined in a program already seen, or in a file of its own. */
  private findSub(label: string, n: number): { program: Loaded; def: SubDefinition } | null {
    const known = this.subs.get(label);
    if (known) return known;
    const program = this.load('o-word', label, n);
    if (!program) return null;
    this.flowOf(program);
    const found = this.subs.get(label);
    if (!found) {
      this.report(
        n,
        'error',
        'SEMANTIC_SUB_NOT_FOUND',
        `The file for o<${label}> does not define o<${label}> sub; call not run`,
      );
      return null;
    }
    return found;
  }

  /** A subprogram file from the resolver, parsed once; null (reported) if there is none. */
  private load(kind: ProgramRequest['kind'], name: string, n: number): Loaded | null {
    const key = `${kind}:${name}`;
    const cached = this.files.get(key);
    if (cached !== undefined) {
      if (cached === null) this.notFound(kind, name, n);
      return cached;
    }
    let text: string | undefined;
    try {
      text = this.resolve?.({ kind, name });
    } catch (e) {
      this.report(
        n,
        'error',
        'SEMANTIC_RESOLVER_FAILED',
        `Loading subprogram ${name} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (text === undefined) {
      this.files.set(key, null);
      this.notFound(kind, name, n);
      return null;
    }
    const parsed = parse(text);
    for (const d of parsed.diagnostics) this.add({ ...d, file: name });
    const loaded: Loaded = { name, lines: parsed.lines, flow: null };
    this.files.set(key, loaded);
    return loaded;
  }

  private notFound(kind: ProgramRequest['kind'], name: string, n: number): void {
    const what = kind === 'm98' ? `Subprogram ${name} (M98 P${name})` : `Subroutine o<${name}>`;
    const why = this.resolve
      ? 'is not defined in this program and no file was found for it'
      : 'is not defined in this program (separate files need a program resolver)';
    this.report(n, 'error', 'SEMANTIC_SUB_NOT_FOUND', `${what} ${why}; call not run`);
  }

  /** Stops the whole run: continuing would draw a path the machine would not take. */
  private stop(n: number, code: string, why: string): void {
    this.report(n, 'error', code, `Stopped: ${why}`);
    this.stopped = true;
  }

  // ── Motion ──────────────────────────────────────────────────────────────

  private move(
    n: number,
    words: readonly Word[],
    g53: boolean,
    used: { add(l: string): void },
  ): void {
    if (this.motion === 'G80') {
      this.report(
        n,
        'error',
        'SEMANTIC_AXIS_WORDS_WITHOUT_MOTION',
        'Axis words with G80 (no motion mode); line not run',
      );
      return;
    }
    if (g53 && (this.motion === 'G2' || this.motion === 'G3')) {
      this.report(
        n,
        'error',
        'SEMANTIC_G53_WITH_ARC',
        'G53 can only be used with G0 or G1; line not run',
      );
      return;
    }
    if (g53 && this.distance === 'incremental') {
      this.report(
        n,
        'error',
        'SEMANTIC_G53_INCREMENTAL',
        'G53 cannot be used in incremental mode (G91); line not run',
      );
      return;
    }
    const target = this.target(words, g53);
    if (!AXES.every((a) => Number.isFinite(target[a]))) {
      // e.g. G20 with a huge value overflows the x25.4 conversion (reviewer, toolkit #14).
      this.report(
        n,
        'error',
        'SEMANTIC_NOT_FINITE',
        'A coordinate is too large to be a number; line not run',
      );
      return;
    }
    const offset = this.offset();
    const from = this.position;

    if (this.motion === 'G0') {
      this.steps.push({
        kind: 'linear',
        line: n,
        rapid: true,
        from,
        to: target,
        feed: null,
        offset,
      });
      this.position = target;
      return;
    }
    const feed = this.feed(n, words);
    if (!feed) return;
    if (this.settleLine !== null) this.adviseSettle(n);
    if (this.motion === 'G1') {
      this.steps.push({ kind: 'linear', line: n, rapid: false, from, to: target, feed, offset });
      this.position = target;
      return;
    }

    // G2/G3: resolved and validated as LinuxCNC does (arcs.ts, ADR-0022).
    const [a1, a2] = PLANE_AXES[this.plane];
    const r = words.find((w) => w.letter === 'R');
    const offsetLetters = [a1, a2].map((a) => OFFSET_LETTER[a]);
    const centreWords = words.filter((w) => offsetLetters.includes(w.letter));
    const wrongOffset = words.filter(
      (w) => 'IJK'.includes(w.letter) && !offsetLetters.includes(w.letter),
    );
    // LinuxCNC 2.9 convert_arc: a centre word for another plane (K in G17) is an error.
    if (wrongOffset.length > 0) {
      for (const w of wrongOffset)
        this.report(
          n,
          'error',
          'SEMANTIC_OFFSET_NOT_IN_PLANE',
          `${w.letter} is not a centre offset in the ${this.plane} plane; line not run`,
          w.span,
        );
      return;
    }
    if (r && centreWords.length > 0) {
      this.report(
        n,
        'error',
        'SEMANTIC_ARC_R_AND_IJK',
        'An arc cannot use both R and centre offsets; line not run',
      );
      return;
    }
    if (!r && centreWords.length === 0) {
      this.report(
        n,
        'error',
        'SEMANTIC_ARC_NO_CENTRE',
        `Arc needs R or ${offsetLetters.join('/')} centre offsets; line not run`,
      );
      return;
    }
    // Under G90.1 both centre words are required (2.9: "%c word missing in absolute
    // center arc"); under G91.1 a missing one is 0.
    if (!r && this.arcDistance === 'absolute' && centreWords.length < 2) {
      const missing = offsetLetters.find((l) => !centreWords.some((w) => w.letter === l));
      this.report(
        n,
        'error',
        'SEMANTIC_ARC_CENTRE_MISSING',
        `${missing ?? '?'} word missing in an absolute-centre arc (G90.1); line not run`,
      );
      return;
    }
    const p = words.find((w) => w.letter === 'P');
    let turns = 1;
    if (p) {
      used.add('P');
      // 2.9 interp_check: P must be within 0.001 of a whole number, then rounded.
      const k = Math.round(p.value);
      if (!(Math.abs(k - p.value) <= 0.001) || k < 1) {
        this.report(
          n,
          'error',
          'SEMANTIC_ARC_TURNS',
          'P (turns) must be a positive integer; line not run',
          p.span,
        );
        return;
      }
      turns = k;
    }
    const u = this.units === 'inch' ? 25.4 : 1;
    const inch = this.units === 'inch';
    const clockwise = this.motion === 'G2';
    const tol = this.behaviour.arcTolerance;
    let result;
    if (!r) {
      for (const w of centreWords) used.add(w.letter);
      // Centre: I/J/K are offsets from the start (G91.1), or work positions (G90.1).
      const centreOf = (a: Axis) => {
        const w = centreWords.find((x) => x.letter === OFFSET_LETTER[a]);
        const v = (w?.value ?? 0) * u;
        return this.arcDistance === 'incremental' ? from[a] + v : v + offset[a];
      };
      result = arcFromCentre(
        from[a1],
        from[a2],
        target[a1],
        target[a2],
        centreOf(a1),
        centreOf(a2),
        clockwise,
        turns,
        tol,
        inch,
      );
    } else {
      used.add('R');
      // LinuxCNC: a radius-format arc needs an in-plane axis word (a full circle can't
      // be given by R); arc_data_r separately refuses an end point equal to the start.
      if (!words.some((w) => w.letter === a1 || w.letter === a2)) {
        this.report(
          n,
          'error',
          'SEMANTIC_ARC_R_FULL_CIRCLE',
          `A radius-format arc needs ${a1} or ${a2}: a full circle can't be given by R; line not run`,
        );
        return;
      }
      result = arcFromRadius(
        from[a1],
        from[a2],
        target[a1],
        target[a2],
        r.value * u,
        clockwise,
        turns,
        tol,
        inch,
      );
    }
    if (!result.ok) {
      // R2: upstream drew nothing and said nothing, then drew the next move from the
      // previous point. Here the line is refused, and the tool stays where it was.
      this.report(n, 'error', result.code, result.message);
      return;
    }
    if (result.warning) this.report(n, 'warning', result.warning.code, result.warning.message);
    const arc = result.arc;
    this.steps.push({
      kind: 'arc',
      line: n,
      from,
      to: target,
      plane: this.plane,
      clockwise,
      centre: { ...from, [a1]: arc.ca, [a2]: arc.cb },
      radius: arc.radius,
      endRadius: arc.endRadius,
      sweep: arc.sweep,
      turns,
      feed,
      offset,
    });
    this.position = target;
  }

  /**
   * A canned-cycle block (G73/G81/G82/G83, XY plane): resolve the values the way
   * LinuxCNC's convert_cycle_xy does, then emit the motions from cycleOps (ADR-0020).
   */
  private cycle(
    n: number,
    words: readonly Word[],
    prior: ModalState['motion'],
    used: { add(l: string): void },
  ): void {
    const code = this.motion as CycleCode;
    const same = prior === code;
    if (CYCLES.has(prior) && !same && this.behaviour.cycleSwitch === 'warn') {
      this.report(
        n,
        'warning',
        'SEMANTIC_CYCLE_SWITCH_WITHOUT_G80',
        `${prior} is still active: this controller's docs require G80 before starting ${code}`,
      );
    }
    const fail = (c: string, m: string) => this.report(n, 'error', c, `${m}; line not run`);
    const get = (l: string) => words.find((w) => w.letter === l);
    if (this.plane !== 'XY')
      return fail('SEMANTIC_CYCLE_PLANE', 'Canned cycles are supported in the XY plane (G17) only');
    if (this.feedMode === 'inverse-time')
      return fail(
        'SEMANTIC_CYCLE_INVERSE_TIME',
        'Canned cycles cannot run in inverse-time feed (G93)',
      );
    if (this.cutterComp !== 'off')
      return fail(
        'SEMANTIC_CYCLE_CUTTER_COMP',
        'Canned cycles cannot run with cutter compensation on',
      );
    if (this.feedRate === null || this.feedRate <= 0)
      return fail('SEMANTIC_NO_FEED_RATE', 'Canned cycle with no feed rate set');
    for (const l of ['A', 'B', 'C'])
      if (get(l))
        return fail('SEMANTIC_CYCLE_ROTARY', 'Rotary axis words cannot be used in a canned cycle');

    const u = this.units === 'inch' ? 25.4 : 1;
    const rw = get('R');
    const r0 = rw ? rw.value * u : same ? this.cycleR : null;
    if (r0 === null)
      return fail('SEMANTIC_CYCLE_NO_R', `${code} needs an R (retract plane) on its first line`);
    const zw = get('Z');
    const z0 = zw ? zw.value * u : same ? this.cycleZ : null;
    if (z0 === null)
      return fail('SEMANTIC_CYCLE_NO_Z', `${code} needs a Z (hole bottom) on its first line`);
    let q: number | null = null;
    if (code === 'G73' || code === 'G83') {
      const qw = get('Q');
      q = qw ? qw.value * u : same ? this.cycleQ : null;
      if (q === null)
        return fail('SEMANTIC_CYCLE_NO_Q', `${code} needs a Q (peck depth) on its first line`);
      if (q <= 0) return fail('SEMANTIC_CYCLE_BAD_Q', 'Q (peck depth) must be positive');
    }
    let p: number | null = null;
    if (code === 'G82') {
      const pw = get('P');
      p = pw ? this.dwellSeconds(pw.value) : same ? this.cycleP : null;
      if (p === null) return fail('SEMANTIC_CYCLE_NO_P', 'G82 needs a P (dwell) on its first line');
      if (p < 0) return fail('SEMANTIC_NEGATIVE_DWELL', 'Dwell time cannot be negative');
    }
    const rep = get(this.behaviour.cycleRepeat.letter);
    const repeats = rep ? rep.value : 1;
    if (!Number.isInteger(repeats) || repeats < 1) {
      return fail(
        'SEMANTIC_CYCLE_REPEAT',
        `${this.behaviour.cycleRepeat.letter} (repeats) must be a positive integer`,
      );
    }

    // Each repeat counts as a block against the safety limit, before anything is built.
    if (repeats > this.limits.maxBlocks - this.blocks) {
      this.stop(n, 'SEMANTIC_LIMIT_BLOCKS', `more than ${this.limits.maxBlocks} blocks run`);
      return;
    }
    this.blocks += repeats - 1;

    const pos = this.position;
    const offset = this.offset();
    if (this.cycleInitial === null) this.cycleInitial = pos.Z;
    let initial = this.cycleInitial;
    const incremental = this.distance === 'incremental';
    const x = get('X');
    const y = get('Y');
    // G90: R and Z are work Z levels. G91: R is relative to the initial level, and Z to R.
    const r = incremental ? initial + r0 : r0 + offset.Z;
    const bottom = incremental ? r + z0 : z0 + offset.Z;
    if (r < bottom)
      return fail('SEMANTIC_CYCLE_R_BELOW_Z', 'R (retract plane) is below Z (hole bottom)');

    // G73/G83: the number of pecks is known up front. Refuse the line rather than loop
    // (reviewer, toolkit #12: with a tiny Q, d -= Q stops changing d and never ends).
    const pecks = q !== null ? Math.ceil((r - bottom) / q) : 1;
    if (!(pecks <= this.limits.maxPecks)) {
      return fail(
        'SEMANTIC_CYCLE_TOO_MANY_PECKS',
        `${code} would take ${Number.isFinite(pecks) ? pecks : 'endless'} pecks per hole (Q is too small for the depth; limit ${this.limits.maxPecks})`,
      );
    }
    // The steps this line adds (up to 3 per peck, plus 5 around each hole), checked
    // against the step limit before anything is built.
    if (this.steps.length + repeats * (pecks * 3 + 5) > this.limits.maxSteps) {
      this.stop(n, 'SEMANTIC_LIMIT_STEPS', `more than ${this.limits.maxSteps} steps`);
      return;
    }

    const holes: { x: number; y: number }[] = [];
    let hx = pos.X;
    let hy = pos.Y;
    for (let k = 0; k < repeats; k++) {
      if (incremental) {
        if (k === 0 || this.behaviour.cycleRepeat.stepInIncremental) {
          hx += x ? x.value * u : 0;
          hy += y ? y.value * u : 0;
        }
      } else {
        hx = x ? x.value * u + offset.X : pos.X;
        hy = y ? y.value * u + offset.Y : pos.Y;
      }
      holes.push({ x: hx, y: hy });
    }

    // Preliminary motion: from below R, rise to R once (convert_cycle_xy).
    let zNow = pos.Z;
    const steps: Step[] = [];
    const at = (px: number, py: number, pz: number): Position => ({ ...pos, X: px, Y: py, Z: pz });
    let from: Position = pos;
    const feed: Feed = { mode: 'per-minute', mmPerMinute: this.feedRate };
    if (this.settleLine !== null) this.adviseSettle(n);
    if (initial < r) {
      const to = at(pos.X, pos.Y, r);
      steps.push({ kind: 'linear', line: n, rapid: true, from, to, feed: null, offset });
      from = to;
      zNow = r;
      initial = r;
    }
    const clear = this.retract === 'r-plane' ? r : initial;
    for (const op of cycleOps({
      code,
      x: from.X,
      y: from.Y,
      z: zNow,
      holes,
      r,
      bottom,
      clear,
      ...(q !== null ? { peck: q } : {}),
      ...(p !== null ? { dwellSeconds: p } : {}),
      g73Retract: this.behaviour.g73Retract,
      g83Clearance: this.behaviour.g83Clearance,
    })) {
      if (op.kind === 'dwell') {
        steps.push({ kind: 'dwell', line: n, seconds: op.seconds });
        continue;
      }
      const to = at(op.x, op.y, op.z);
      steps.push({
        kind: 'linear',
        line: n,
        rapid: op.kind === 'rapid',
        from,
        to,
        feed: op.kind === 'feed' ? feed : null,
        offset,
      });
      from = to;
    }
    this.steps.push(...steps);
    this.position = from;
    this.cycleR = r0;
    this.cycleZ = z0;
    if (q !== null) this.cycleQ = q;
    if (p !== null) this.cycleP = p;
    for (const l of ['X', 'Y', 'Z', 'R', 'Q', 'P', this.behaviour.cycleRepeat.letter]) used.add(l);
  }

  /** A P dwell value in seconds, per the dialect's dwell units. */
  private dwellSeconds(p: number): number {
    return this.behaviour.dwellUnits === 'milliseconds' ? p / 1000 : p;
  }

  /** Target machine position from the line's axis words. */
  private target(words: readonly Word[], g53: boolean): Position {
    const out: Record<Axis, number> = { ...this.position };
    const offset = this.offset();
    const u = this.units === 'inch' ? 25.4 : 1;
    for (const w of words) {
      if (!(w.letter in AXIS_INDEX)) continue;
      const a = w.letter as Axis;
      const v = LINEAR.has(a) ? w.value * u : w.value;
      if (g53) out[a] = v;
      else if (this.distance === 'incremental') out[a] = this.position[a] + v;
      else out[a] = v + offset[a];
    }
    return out;
  }

  private feed(n: number, words: readonly Word[]): Feed | null {
    const hasF = words.some((w) => w.letter === 'F');
    if (this.feedMode === 'inverse-time') {
      if (!hasF || this.feedRate === null || this.feedRate <= 0) {
        this.report(
          n,
          'error',
          'SEMANTIC_NO_FEED_RATE',
          'Inverse-time mode (G93) needs an F word on every feed move; line not run',
        );
        return null;
      }
      return { mode: 'inverse-time', perMinute: this.feedRate };
    }
    if (this.feedRate === null && this.behaviour.missingFeed === 'machine-rate') {
      // Masso runs it at the operator's percentage of the maximum rate (machine test T1).
      this.reportOnce(
        n,
        'warning',
        'SEMANTIC_FEED_UNSPECIFIED',
        'Feed move before any F: the controller runs it at a rate set on the machine, so its time is unknown',
      );
      return { mode: 'unspecified' };
    }
    if (this.feedRate === null || this.feedRate <= 0) {
      // Upstream silently used 200 mm/min (N10). A real controller refuses.
      this.report(
        n,
        'error',
        'SEMANTIC_NO_FEED_RATE',
        'Feed move with no feed rate set (no F word yet); line not run',
      );
      return null;
    }
    return this.feedMode === 'per-minute'
      ? { mode: 'per-minute', mmPerMinute: this.feedRate }
      : { mode: 'per-revolution', mmPerRevolution: this.feedRate };
  }

  // ── Offsets and homes (in LinuxCNC's parameter layout, millimetres) ─────

  private coordinateSystem(): number {
    return this.numbered.get(5220) ?? 1;
  }

  private wcsBase(cs: number): number {
    return 5221 + 20 * (cs - 1);
  }

  /** Writes a parameter; any write from #5210 up (offsets) invalidates the cached offset. */
  private setParam(i: number, v: number): void {
    this.numbered.set(i, v);
    // #5210 up: G92 and every coordinate system, including Masso's extended 101-200.
    if (i >= 5210) this.offsetCache = null;
  }

  private offset(): Position {
    if (this.offsetCache) return this.offsetCache;
    const base = this.wcsBase(this.coordinateSystem());
    const g92On = (this.numbered.get(5210) ?? 0) !== 0;
    const o = {} as Record<Axis, number>;
    for (const a of AXES) {
      const i = AXIS_INDEX[a];
      o[a] = (this.numbered.get(base + i) ?? 0) + (g92On ? (this.numbered.get(5211 + i) ?? 0) : 0);
    }
    this.offsetCache = o;
    return o;
  }

  private axisValue(w: Word): number {
    return LINEAR.has(w.letter as Axis) && this.units === 'inch' ? w.value * 25.4 : w.value;
  }

  private g10(n: number, words: readonly Word[]): void {
    const l = words.find((w) => w.letter === 'L');
    const p = words.find((w) => w.letter === 'P');
    if (!l || (l.value !== 2 && l.value !== 20)) {
      this.report(
        n,
        'error',
        'SEMANTIC_G10_FORM',
        'Only G10 L2 and G10 L20 (coordinate system data) are supported',
      );
      return;
    }
    const cs = p ? Math.round(p.value) : NaN;
    if (!(cs >= 0 && cs <= 9)) {
      this.report(
        n,
        'error',
        'SEMANTIC_G10_P',
        'G10 needs P0-P9 (P0 is the active coordinate system)',
      );
      return;
    }
    if (words.some((w) => w.letter === 'R')) {
      this.report(
        n,
        'warning',
        'SEMANTIC_ROTATION_NOT_SUPPORTED',
        'Coordinate system rotation (R) is not simulated; ignored',
      );
    }
    const base = this.wcsBase(cs === 0 ? this.coordinateSystem() : cs);
    const current = this.offset();
    const g92 = this.subtract(current, this.wcsOffsetOf(this.coordinateSystem()));
    for (const w of words) {
      if (!(w.letter in AXIS_INDEX)) continue;
      const a = w.letter as Axis;
      const v = this.axisValue(w);
      // L2: the offset itself. L20: the offset that makes the current position read v.
      const value = l.value === 2 ? v : this.position[a] - g92[a] - v;
      this.setParam(base + AXIS_INDEX[a], value);
    }
  }

  private wcsOffsetOf(cs: number): Position {
    const base = this.wcsBase(cs);
    const o = {} as Record<Axis, number>;
    for (const a of AXES) o[a] = this.numbered.get(base + AXIS_INDEX[a]) ?? 0;
    return o;
  }

  private subtract(p: Position, q: Position): Position {
    const o = {} as Record<Axis, number>;
    for (const a of AXES) o[a] = p[a] - q[a];
    return o;
  }

  private g92(words: readonly Word[]): void {
    const wcs = this.wcsOffsetOf(this.coordinateSystem());
    const on = (this.numbered.get(5210) ?? 0) !== 0;
    for (const a of AXES) if (!on) this.setParam(5211 + AXIS_INDEX[a], 0);
    for (const w of words) {
      if (!(w.letter in AXIS_INDEX)) continue;
      const a = w.letter as Axis;
      this.setParam(5211 + AXIS_INDEX[a], this.position[a] - wcs[a] - this.axisValue(w));
    }
    this.setParam(5210, 1);
  }

  private g52(words: readonly Word[]): void {
    const on = (this.numbered.get(5210) ?? 0) !== 0;
    for (const a of AXES) if (!on) this.setParam(5211 + AXIS_INDEX[a], 0);
    for (const w of words) {
      if (w.letter in AXIS_INDEX)
        this.setParam(5211 + AXIS_INDEX[w.letter as Axis], this.axisValue(w));
    }
    this.setParam(5210, 1);
  }

  private storeHome(base: number): void {
    for (const a of AXES) this.setParam(base + AXIS_INDEX[a], this.position[a]);
  }

  /** G28/G30: rapid to an optional intermediate point, then to the stored position. */
  private home(n: number, base: number, words: readonly Word[]): void {
    const axisWords = words.filter((w) => w.letter in AXIS_INDEX);
    const stored = AXES.some((a) => this.numbered.has(base + AXIS_INDEX[a]));
    if (!stored) {
      this.reportOnce(
        n,
        'info',
        `SEMANTIC_HOME_UNSET_${base}`,
        `G${base === 5161 ? 28 : 30} goes to its stored position, which this program never set: using the machine origin`,
      );
    }
    const offset = this.offset();
    if (axisWords.length > 0) {
      const via = this.target(words, false);
      this.steps.push({
        kind: 'linear',
        line: n,
        rapid: true,
        from: this.position,
        to: via,
        feed: null,
        offset,
      });
      this.position = via;
    }
    const to: Record<Axis, number> = { ...this.position };
    const axes = axisWords.length > 0 ? axisWords.map((w) => w.letter as Axis) : [...AXES];
    for (const a of axes) to[a] = this.numbered.get(base + AXIS_INDEX[a]) ?? 0;
    this.steps.push({
      kind: 'linear',
      line: n,
      rapid: true,
      from: { ...this.position },
      to,
      feed: null,
      offset,
    });
    this.position = to;
  }

  /**
   * Masso G10 (docs, "G10"). L2: the offset is the value. L2.1: the ACTIVE offset plus
   * the value. L20 and L20.1: the same for the extended offsets G54.1 P1-P100. P0 is
   * the active offset, whichever kind it is.
   */
  private g10Masso(n: number, words: readonly Word[]): void {
    const l = words.find((w) => w.letter === 'L');
    const p = words.find((w) => w.letter === 'P');
    const form = l ? codeKey(l.value) : '';
    if (!['2', '2.1', '20', '20.1'].includes(form)) {
      this.report(n, 'error', 'SEMANTIC_G10_FORM', 'G10 needs L2, L2.1, L20 or L20.1');
      return;
    }
    const extended = form.startsWith('20');
    const k = p ? Math.round(p.value) : NaN;
    const max = extended ? 100 : 6;
    if (!p || Math.abs(p.value - k) > 1e-4 || !(k >= 0 && k <= max)) {
      this.report(
        n,
        'error',
        'SEMANTIC_G10_P',
        `G10 L${form} needs P0 to P${max} (P0 is the active work offset)`,
      );
      return;
    }
    const active = this.coordinateSystem();
    const cs = k === 0 ? active : extended ? 100 + k : k;
    const base = this.wcsBase(cs);
    const relative = form.endsWith('.1');
    const activeOffset = this.wcsOffsetOf(active);
    for (const w of words) {
      if (!(w.letter in AXIS_INDEX)) continue;
      const a = w.letter as Axis;
      const v = this.axisValue(w);
      this.setParam(base + AXIS_INDEX[a], relative ? activeOffset[a] + v : v);
    }
  }

  /**
   * Masso G28 and G30 (docs, v5.13). G28: to machine home, optionally via an
   * intermediate point (work coordinates, or incremental under G91); only the named
   * axes move, or all of them if none is named. G30: to the parking position set on
   * the machine. Either way Z goes first, then the other axes together.
   */
  private homeMasso(n: number, which: 28 | 30, words: readonly Word[]): void {
    const axisWords = words.filter((w) => w.letter in AXIS_INDEX);
    const offset = this.offset();
    let dest: Partial<Position>;
    let axes: Axis[];
    if (which === 28) {
      if (axisWords.length > 0) {
        const via = this.target(words, false);
        this.steps.push({
          kind: 'linear',
          line: n,
          rapid: true,
          from: this.position,
          to: via,
          feed: null,
          offset,
        });
        this.position = via;
      }
      axes = axisWords.length > 0 ? axisWords.map((w) => w.letter as Axis) : [...AXES];
      dest = Object.fromEntries(axes.map((a) => [a, this.machineHome[a] ?? 0]));
    } else {
      if (axisWords.length > 0)
        this.report(
          n,
          'warning',
          'SEMANTIC_G30_AXES_IGNORED',
          "Axis words with G30 aren't defined by this controller's docs; ignored",
        );
      if (!this.machinePark) {
        this.report(
          n,
          'warning',
          'SEMANTIC_PARK_UNKNOWN',
          'G30 goes to the parking position set on the machine, which is not known here (pass machine.park); the move is not drawn',
        );
        return;
      }
      dest = this.machinePark;
      axes = AXES.filter((a) => dest[a] !== undefined);
    }
    // Z first, then the rest together.
    const order: Axis[][] = axes.includes('Z') ? [['Z'], axes.filter((a) => a !== 'Z')] : [axes];
    for (const group of order) {
      const to: Record<Axis, number> = { ...this.position };
      let moved = false;
      for (const a of group) {
        const v = dest[a];
        if (v !== undefined && v !== to[a]) {
          to[a] = v;
          moved = true;
        }
      }
      if (!moved) continue;
      this.steps.push({
        kind: 'linear',
        line: n,
        rapid: true,
        from: this.position,
        to,
        feed: null,
        offset,
      });
      this.position = to;
    }
  }

  /** A feed move right after an unsettled spindle-speed change: suggest a dwell. */
  private adviseSettle(n: number): void {
    const at = this.settleLine as number;
    this.settleLine = null;
    this.report(
      at,
      'info',
      'SEMANTIC_SPINDLE_NOT_SETTLED',
      `Spindle speed changed while running, and the feed move at line ${n} starts before it settles: this controller doesn't wait for the new speed. Consider a dwell (G4) after this line`,
    );
  }

  // ── Parameters ──────────────────────────────────────────────────────────

  private value(line: Line, v: Value): number | null {
    if (v.kind === 'number') return v.value;
    const parsed = parseExpression(line.text, v.span, line.lineNo, this.rules);
    for (const d of parsed.diagnostics) this.add(d);
    if (!parsed.expr) return null;
    const r = evaluate(parsed.expr, this.params, this.rules, line.lineNo);
    for (const d of r.diagnostics) this.add(d);
    return r.value;
  }

  /** Assignments take effect after the whole line (RS274/NGC; LinuxCNC "Numbered Parameters"). */
  private assign(line: Line, target: string, value: number): void {
    const t = target.replace(/[ \t]/g, '');
    const nameMatch = /^#<(.*)>$/.exec(t);
    if (nameMatch) {
      const name = (nameMatch[1] ?? '').toLowerCase();
      if (name === '_value' || name === '_value_returned') {
        this.report(line.lineNo, 'error', 'SEMANTIC_BAD_ASSIGNMENT', `#<${name}> is read-only`);
        return;
      }
      (name.startsWith('_') ? this.globalNamed : this.frame.named).set(name, value);
      return;
    }
    // #n, #[expr] or ##n: evaluate the index expression (without the leading #).
    const indexSrc = t.slice(1);
    const parsed = parseExpression(
      indexSrc,
      { start: 0, end: indexSrc.length },
      line.lineNo,
      this.rules,
    );
    const idx = parsed.expr
      ? evaluate(parsed.expr, this.params, this.rules, line.lineNo).value
      : null;
    if (idx === null || !Number.isInteger(idx) || idx < 1 || idx > this.rules.maxParameter) {
      this.report(line.lineNo, 'error', 'SEMANTIC_BAD_ASSIGNMENT', `Cannot assign to ${target}`);
      return;
    }
    this.setParam(idx, value);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private end(n: number, by: 'M2' | 'M30' | 'M99' | '%'): void {
    this.steps.push({ kind: 'end', line: n, by });
    this.ended = true;
  }

  private report(
    line: number,
    severity: Severity,
    code: string,
    message: string,
    span?: Span,
  ): void {
    this.add(span ? { severity, code, message, line, span } : { severity, code, message, line });
  }

  /**
   * Every diagnostic goes through here. After `limits.maxDiagnostics` they're counted,
   * not kept: a warning inside a million-pass loop mustn't exhaust memory.
   */
  private add(d: Diagnostic): void {
    if (this.diagnostics.length < this.limits.maxDiagnostics) this.diagnostics.push(d);
    else this.suppressed++;
  }

  /** LinuxCNC `(MSG, text)` comments: an operator message. */
  private commentMessages(line: Line): void {
    for (const t of line.tokens) {
      if (t.kind !== 'comment' || t.style !== 'paren') continue;
      const m = /^\s*msg\s*,(.*)$/is.exec(t.text);
      if (m)
        this.steps.push({
          kind: 'message',
          line: line.lineNo,
          text: (m[1] ?? '').trim(),
          target: 'screen',
        });
    }
  }

  private reportOnce(line: number, severity: Severity, code: string, message: string): void {
    if (this.once.has(code)) return;
    this.once.add(code);
    this.report(line, severity, code, message);
  }

  private state(): ModalState {
    return {
      motion: this.motion,
      plane: this.plane,
      units: this.units,
      distance: this.distance,
      arcDistance: this.arcDistance,
      feedMode: this.feedMode,
      coordinateSystem: this.coordinateSystem(),
      cutterCompensation: this.cutterComp,
      toolLengthOffset: this.toolLength,
      retract: this.retract,
      pathControl: this.pathControl,
      position: { ...this.position },
      feedRate: this.feedRate,
      spindle: { ...this.spindle },
      tool: this.tool,
    };
  }
}
