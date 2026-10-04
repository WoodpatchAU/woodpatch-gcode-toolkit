// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import { interpret } from '../interp/interpret.js';
import { editLine, parse, write, type LineEdit } from '../syntax/program.js';
import type { ModalState, Position, Step } from '../interp/types.js';
import { arcPoint, startAngle } from '../path/path.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatConverted, MAX_WRITTEN, writable } from './format.js';

/**
 * Units conversion (parcel 4b, ADR-0034): every length and feed the program writes,
 * converted between millimetres and inches, and every G20/G21 rewritten. Nothing moves.
 *
 * The rule, from the review of toolkit #37: the only safe failure is a refusal. Every
 * word must be KNOWN, in its context, to be a length, a feed, or not a length at all;
 * anything else refuses. Operator decisions (2026-09-28): values are rounded to 5
 * decimals in inches or 3 in millimetres; a program that states no units is read in
 * the user's units preference (`assume`).
 */

/**
 * G codes this conversion understands, whose words are lengths or not coordinates at
 * all. G10 is further limited to setting work offsets (L2, L20, and Masso's L2.1, L20.1).
 * Not here, so refused: G41.1/G42.1 (D is a diameter), G43.1, G38.3–5 (not modelled),
 * G96 (surface speed), G68 (an angle), G76, G87 and every other code.
 */
const UNITS_G = new Set([
  0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 28.1, 30, 30.1, 38.2, 40, 41, 42, 43, 49, 52, 53, 54,
  55, 56, 57, 58, 59, 59.1, 59.2, 59.3, 61, 61.1, 64, 73, 80, 81, 82, 83, 84, 85, 86, 89, 90, 90.1,
  91, 91.1, 92, 92.1, 92.2, 92.3, 93, 94, 95, 97, 98, 99,
]);
const CYCLES = new Set([73, 81, 82, 83, 84, 85, 86, 89]);
/** Codes that set a mode the conversion reads: units, distance, feed mode, retract mode. */
const MODE_G = new Set([20, 21, 90, 91, 93, 94, 95, 98, 99]);
/** M codes that read no letters of their own (M6 reads T, which is never converted). */
const M_NO_WORDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 48, 49, 60]);
/** G codes that read neither P nor Q: beside them, G64's P and Q are G64's alone. */
const NO_PQ_READER = new Set([
  0, 1, 17, 18, 19, 20, 21, 40, 49, 54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3, 61, 61.1, 64, 80, 90,
  90.1, 91, 91.1, 93, 94, 95, 97,
]);
const MOTION = new Set([0, 1, 2, 3, 38.2, 73, 80, 81, 82, 83, 84, 85, 86, 89]);
/**
 * Codes that take some of the line's words themselves, and which ones: those words are
 * not the modal motion's. Only those: G4 takes only P, so X/Y/Z/Q on a G4 line still
 * belong to the modal motion, which runs after the dwell (review of #37).
 */
const OWN_WORDS: ReadonlyMap<number, string> = new Map([
  [4, 'P'],
  [64, 'PQ'],
  [10, 'XYZLPR'],
  [28, 'XYZ'],
  [30, 'XYZ'],
  [52, 'XYZ'],
  [92, 'XYZ'],
]);
/** Letters that are never lengths. */
const NOT_LENGTH = new Set(['G', 'M', 'N', 'T', 'H', 'D', 'S', 'A', 'B', 'C', 'L', 'O']);

type Units = 'mm' | 'inch';
type Axis = 'X' | 'Y' | 'Z';
type FeedMode = 'per-minute' | 'inverse-time' | 'per-revolution';
/** The modes a line is converted under, as the text above it sets them. */
interface TextState {
  readonly units: Units;
  readonly absolute: boolean;
  readonly feedMode: FeedMode;
  readonly motion: number | null;
  /** G99 (cycles end at R) rather than G98: decides what of a G91 cycle carries. */
  readonly retractToR: boolean;
}

export function convertUnits(
  program: Program,
  to: Units,
  assume: Units,
  dialect: Dialect,
): { ok: boolean; program: Program; diagnostics: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const notes: Diagnostic[] = [];
  const error = (line: number, code: string, message: string) => {
    if (errors.length < 200) errors.push({ severity: 'error', code, message, line });
  };
  const places = to === 'inch' ? 5 : 3;
  const repeatLetter = dialect.interpreter.cycleRepeat.letter;
  const feedAtEndOfLine = dialect.interpreter.feedUnits === 'end-of-line';

  // Parameters and expressions anywhere make a program's lengths unknowable: a loop
  // condition like [#5422 GT -10] compares a position with a number in the old units.
  // Control flow (O-words, M98/M99) means lines run out of text order.
  let flow = false;
  const defined = new Set<string>();
  const calls: { name: string; line: number }[] = [];
  const inFileM98 = dialect.interpreter.subprograms.m98 !== 'file';
  const oWords = dialect.interpreter.subprograms.oWord;
  let flowErrors = 0;
  /** Per-line control-flow refusals: the first 20 named, the rest counted at the end. */
  const flowError = (line: number, message: string) => {
    if (++flowErrors <= 20) error(line, 'TRANSFORM_CONTROL_FLOW', message);
  };
  // A program number ALONE on the first line of code (Masso's O1234 header, comments
  // aside) is harmless. With anything else on its line, the preview drops the whole line.
  const first0 = program.lines.find((l) =>
    l.tokens.some((t) => t.kind === 'word' || t.kind === 'oword'),
  );
  const firstCode = first0?.tokens.every((t) => t.kind === 'oword' || t.kind === 'comment')
    ? first0.lineNo
    : undefined;
  for (const line of program.lines)
    for (const t of line.tokens) {
      // Without O-words, the controller (and the preview) skips these lines and runs a
      // "sub" body inline, where the units line inserted above it doesn't reach.
      if (t.kind === 'oword' && !oWords && !(t.keyword === null && line.lineNo === firstCode))
        flowError(
          line.lineNo,
          "This controller has no O-word subroutines: it skips this line and runs a 'sub' body in place, so the conversion can't place its units safely. Refusing",
        );
      if (t.kind === 'oword' && (t.keyword === 'sub' || t.keyword === 'call')) {
        const name = line.text.slice(t.label.start, t.label.end).toLowerCase().replace(/\s+/g, '');
        if (t.keyword === 'sub') defined.add(name);
        else calls.push({ name, line: line.lineNo });
      }
      if (
        inFileM98 &&
        t.kind === 'word' &&
        t.letter === 'M' &&
        t.value?.kind === 'number' &&
        (t.value.value === 98 || t.value.value === 99)
      )
        flowError(
          line.lineNo,
          `M${t.value.value} (a subprogram in this file, Fanuc style) isn't run by the preview on this controller, so the modes its body runs in can't be checked. Refusing`,
        );
      // Masso's M99 ends a subprogram FILE: this file runs in its caller's units, and the
      // units line added here would carry back into the caller.
      if (
        !inFileM98 &&
        t.kind === 'word' &&
        t.letter === 'M' &&
        t.value?.kind === 'number' &&
        t.value.value === 99
      )
        flowError(
          line.lineNo,
          "M99: this is a subprogram file. It runs in its caller's units, and a units line added here would carry back into the caller. Convert the program that calls it, with it",
        );
      if (
        t.kind === 'assignment' ||
        t.kind === 'argument' ||
        (t.kind === 'word' && t.value?.kind === 'expression')
      )
        error(
          line.lineNo,
          'TRANSFORM_EXPRESSION',
          "Parameters and expressions can hold lengths in the old units, which a conversion can't rewrite faithfully, so it stopped here",
        );
      if (t.kind === 'oword' && t.keyword !== null) flow = true;
      if (
        t.kind === 'word' &&
        t.letter === 'M' &&
        t.value?.kind === 'number' &&
        (t.value.value === 98 || t.value.value === 99)
      )
        flow = true;
      if (
        t.kind === 'word' &&
        t.letter === 'M' &&
        t.value?.kind === 'number' &&
        t.value.value === 98 &&
        dialect.interpreter.subprograms.m98 === 'file'
      )
        error(
          line.lineNo,
          'TRANSFORM_CONTROL_FLOW',
          'M98 calls a subprogram in another file, which a conversion of this file would leave in the old units',
        );
    }

  // A call to a subroutine that isn't in this file runs another file, which a
  // conversion of this one would leave in the old units.
  for (const c of calls)
    if (!defined.has(c.name))
      flowError(
        c.line,
        `o${c.name} isn't defined in this file: it calls a subroutine in another file, which would stay in the old units`,
      );
  // A subroutine never called here is a library for other files: its body runs in
  // their modes, which this file can't check.
  const called = new Set(calls.map((c) => c.name));
  for (const name of defined)
    if (!called.has(name))
      flowError(
        0,
        `o${name} is defined but never called in this file: it's a library for other programs, whose modes can't be checked here. Refusing`,
      );

  let units: Units = assume;
  // Masso's `M66 … S<n>` skips the next n lines when its input condition is met. The
  // preview never takes that skip, so those lines are like block-deletable ones: a mode
  // word among them is refused (its effect would depend on the input), and their G91
  // rounding has its own carry chain (review of #37). Counted generously: up to the n-th
  // line of code after, so blank and comment lines can't shorten the range.
  const skipFrom = new Map<number, number>(); // a line in a range → its M66 line
  let skipRanges = 0;
  if (dialect.interpreter.m66 === 'masso-wait')
    program.lines.forEach((line, i) => {
      const ws = line.tokens.filter((t): t is WordToken => t.kind === 'word');
      if (!ws.some((w) => w.letter === 'M' && num0(w) === 66)) return;
      const sWord = ws.find((w) => w.letter === 'S');
      let left = sWord ? Math.round(num0(sWord) ?? 0) : 0;
      if (left > 0) skipRanges++;
      for (let j = i + 1; j < program.lines.length && left > 0; j++) {
        const l = program.lines[j] as Line;
        skipFrom.set(l.lineNo, line.lineNo);
        // A line of code counts; one holding only an N number doesn't (generous).
        if (l.tokens.some((t) => t.kind === 'word' && t.letter !== 'N')) left--;
      }
    });

  let absolute = true;
  let feedMode: FeedMode = 'per-minute';
  let motion: number | null = null;
  // G98 (back to the initial Z) or G99 (to R) after a canned cycle: decides how much
  // of a G91 cycle's Z is a net move, and so what feeds the rounding carry.
  let retractToR = false;
  // Two carry chains: lines that always run, and block-deletable ones (see skippable).
  const carries: [Record<Axis, number>, Record<Axis, number>] = [
    { X: 0, Y: 0, Z: 0 },
    { X: 0, Y: 0, Z: 0 },
  ];
  const seen = new Set<Units>();
  let converted = 0;

  // The modes each line is converted under, read from the text above it: checked
  // against the run below.
  const textState = new Map<number, TextState>();
  const lines: Line[] = [];
  for (const line of program.lines) {
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    const n = line.lineNo;
    const num = (w: WordToken | undefined) => (w?.value?.kind === 'number' ? w.value.value : null);
    const edits: LineEdit[] = [];
    const before = units;
    textState.set(n, { units, absolute, feedMode, motion, retractToR });
    const gs = new Set<number>();
    let ownMotion: number | null = null;
    for (const w of words) {
      if (w.letter !== 'G') continue;
      const g = num(w);
      if (g === null) continue; // an expression: already refused
      gs.add(g);
      if (!UNITS_G.has(g)) {
        error(
          n,
          'TRANSFORM_UNSUPPORTED_CODE',
          `G${g}'s words aren't all known to be lengths (or it isn't modelled), so its units can't be converted safely`,
        );
        continue;
      }
      if (g === 20) units = 'inch';
      else if (g === 21) units = 'mm';
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 98) retractToR = false;
      else if (g === 99) retractToR = true;
      else if (g === 93) feedMode = 'inverse-time';
      else if (g === 94) feedMode = 'per-minute';
      else if (g === 95) feedMode = 'per-revolution';
      else if (MOTION.has(g)) ownMotion = g;
      if ((g === 20 || g === 21) && w.value?.kind === 'number') {
        const src = line.text.slice(w.value.span.start, w.value.span.end);
        const text = src.replace(/2[01](?=(\.0*)?$)/, to === 'inch' ? '20' : '21');
        if (text !== src) edits.push({ span: w.value.span, text });
      }
    }
    if (ownMotion !== null) motion = ownMotion;
    if (words.length) seen.add(units);

    const has = (l: string) => words.some((w) => w.letter === l);
    const g10 = gs.has(10);
    if (g10) {
      const L = num(words.find((w) => w.letter === 'L'));
      const offsets =
        L === 2 || L === 20 || (dialect.interpreter.g10 === 'masso' && (L === 2.1 || L === 20.1));
      if (!offsets)
        error(
          n,
          'TRANSFORM_UNSUPPORTED_CODE',
          `G10 L${L ?? '?'} isn't a work offset: its words aren't known to be lengths`,
        );
      else if (has('R'))
        error(
          n,
          'TRANSFORM_UNSUPPORTED_WORD',
          'G10 L2/L20 R is a rotation in degrees, not a length: refusing rather than guessing',
        );
    }
    const offsetLine = g10 || gs.has(52) || gs.has(92) || gs.has(53) || gs.has(28) || gs.has(30);
    const axes = has('X') || has('Y') || has('Z');
    const arc =
      !offsetLine &&
      (motion === 2 || motion === 3) &&
      (axes || has('I') || has('J') || has('K') || has('R'));
    const m66 = words.some((w) => w.letter === 'M' && num0(w) === 66);
    // G64's P and Q are converted only where G64 is their ONLY reader on the line: an
    // allow-list, so a reader nobody thought of is refused, not converted (review of #37:
    // an arc's turns, M64's output number and G10's P all read the same P).
    const g64Shared = (): boolean =>
      gs.has(64) &&
      (words.some((w) => w.letter === 'M') ||
        [...gs].some((g) => !NO_PQ_READER.has(g)) ||
        arc ||
        cycleRuns);
    const cycleRuns = !offsetLine && motion !== null && CYCLES.has(motion) && axes;
    // An M code that reads letters of its own (M66's P/L/Q, M19's R as an angle, user
    // M-codes' P/Q): a letter converted for the motion must have no second reader on the
    // line, or it's refused (review of #37: the allow-list rule, for every converted letter).
    const mReader = words.find((w) => w.letter === 'M' && !M_NO_WORDS.has(num0(w) ?? -1));
    const sharedWithM = (L: string) => {
      if (!mReader) return false;
      error(
        n,
        'TRANSFORM_UNSUPPORTED_WORD',
        `M${num0(mReader) ?? '?'} on this line may read ${L} too, so no one conversion of it is right. Put the M code on a line of its own`,
      );
      return true;
    };
    const lengthFactor = factor(units, to);
    // F is read in the units in force before the line (or, on end-of-line controllers,
    // after it). In the OUTPUT that's always the target: the units are stated first.
    const feedFactor = factor(feedAtEndOfLine ? units : before, to);
    // A repeat that steps in G91 re-applies each rounded increment.
    // A block-deletable line may not run (where "/" is a switch). So such lines carry
    // their rounding in a chain of their own: the lines that always run sum exactly
    // whether they run or not, and so do they (review of #37). An absolute word on a line
    // that always runs fixes the position for both chains.
    const skippedBy = skipFrom.get(n);
    const skippable =
      (dialect.interpreter.blockDelete === 'switch' &&
        line.tokens.some((t) => t.kind === 'block-delete')) ||
      skippedBy !== undefined;
    if (skippedBy !== undefined && [...gs].some((g) => MODE_G.has(g)))
      error(
        n,
        'TRANSFORM_CONTROL_FLOW',
        `M66 at line ${skippedBy} skips this line when its input condition is met, and this line changes a mode: the result would depend on the input. Refusing`,
      );
    const carry = carries[skippable ? 1 : 0];
    const repeats =
      cycleRuns &&
      !absolute &&
      repeatLetter === 'L' &&
      dialect.interpreter.cycleRepeat.stepInIncremental &&
      (num(words.find((w) => w.letter === 'L')) ?? 1) > 1;

    let changed = false;
    for (const w of words) {
      // An expression was refused above; a word with no value (`Y-.`) is a syntax error
      // both runs share, so there's nothing to convert.
      if (w.value?.kind !== 'number') continue;
      const L = w.letter;
      let f: number;
      let axis: Axis | undefined;
      if (L === 'X' || L === 'Y' || L === 'Z') {
        f = lengthFactor;
        // A G91 canned cycle's Z isn't a net move (G98 returns to the initial Z), so it
        // takes no part in the carry: written as it rounds, no drift (review of #37).
        if (!absolute && !offsetLine && !(L === 'Z' && cycleRuns)) axis = L;
        else if (absolute) {
          carry[L] = 0;
          if (!skippable) carries[1][L] = 0;
        }
      } else if (L === 'I' || L === 'J' || L === 'K') {
        if (L === 'K' && cycleRuns && repeatLetter === 'K') continue; // Masso's repeat count
        if (!arc) {
          error(
            n,
            'TRANSFORM_UNSUPPORTED_WORD',
            `${L} here isn't an arc centre, and isn't known to be a length`,
          );
          continue;
        }
        f = lengthFactor;
      } else if (L === 'R') {
        if (!arc && !cycleRuns) {
          // An M code's own R (M19's angle), with no motion reading it: not a length.
          if (mReader) continue;
          if (!g10)
            error(
              n,
              'TRANSFORM_UNSUPPORTED_WORD',
              'R here is neither an arc radius nor a cycle retract height, so its meaning is unknown',
            );
          continue;
        }
        if (sharedWithM('R')) continue;
        f = lengthFactor;
        // Under G99 a G91 cycle ends at R: that IS a net Z move, and carries. So it is
        // under G98 when R is above the start (it returns to the higher of the two).
        if (!absolute && cycleRuns && (retractToR || w.value.value > 0)) axis = 'Z';
      } else if (L === 'Q') {
        if (gs.has(64) && g64Shared()) {
          error(
            n,
            'TRANSFORM_UNSUPPORTED_WORD',
            "Q here is G64's naive-CAM tolerance, but something else on this line reads Q too (a cycle's peck, an M code…). Put G64 on a line of its own",
          );
          continue;
        }
        if (!cycleRuns && !gs.has(64)) {
          // M66's timeout isn't a length. On other lines a Q is the modal motion's, which
          // the run-time check compares (a cycle's peck), or ignored by it (a G1).
          if (m66 || !offsetLine) continue;
          // G10/G28/G30/G52/G92 take the axes and suspend the motion: nothing on the line
          // reads this Q, so refuse rather than leave a length unconverted (review of #37).
          error(
            n,
            'TRANSFORM_UNSUPPORTED_WORD',
            "Q here isn't read by a cycle, G64 or M66, so what it means is unknown. Refusing rather than guess",
          );
          continue;
        }
        if (sharedWithM('Q')) continue;
        f = lengthFactor;
      } else if (L === 'P') {
        if (!gs.has(64)) continue; // dwell, turns, an index…
        // LinuxCNC reads one P for both G64's tolerance (a length) and a dwell (seconds)
        // on the same line: no conversion of it is right (review of #37).
        if (g64Shared()) {
          error(
            n,
            'TRANSFORM_UNSUPPORTED_WORD',
            "P here is G64's blending tolerance, but something else on this line reads P too (a dwell, an arc's turns, an M code…): no one conversion of it is right. Put G64 on a line of its own",
          );
          continue;
        }
        f = lengthFactor;
      } else if (L === 'F') {
        if (feedMode === 'inverse-time') continue;
        f = feedFactor;
      } else if (NOT_LENGTH.has(L)) continue;
      else {
        error(
          n,
          'TRANSFORM_UNSUPPORTED_WORD',
          `${L} words aren't known to this conversion (U/V/W and E axes aren't modelled), so it stopped rather than guess`,
        );
        continue;
      }
      if (f === 1) continue;
      const src = line.text.slice(w.value.span.start, w.value.span.end);
      const exact = w.value.value * f;
      // An incremental word absorbs the rounding carried along its axis, so a long G91
      // program doesn't drift. Where it would repeat (a loop, a sub, a stepping cycle),
      // a carry can't work: refuse unless the value converts exactly.
      let target = exact;
      if (axis) {
        const loose =
          writable(exact) && Math.abs(Number(formatConverted(exact, src, places)) - exact) > 1e-9;
        if (loose && (flow || repeats)) {
          error(
            n,
            'TRANSFORM_UNITS_DRIFT',
            `This incremental ${L} doesn't convert exactly, and runs repeatedly (a loop, subroutine or repeated cycle), so its rounding would add up. Refusing`,
          );
          continue;
        }
        // Each M66 skip range is met (or not) on its own, so one carry chain can't serve
        // several: an inexact increment inside one is refused when there are more.
        if (loose && skippedBy !== undefined && skipRanges > 1) {
          error(
            n,
            'TRANSFORM_UNITS_DRIFT',
            `This incremental ${L} doesn't convert exactly, inside one of several M66 skip ranges that are each met on their own, so their rounding can't be carried. Refusing`,
          );
          continue;
        }
        target = exact + carry[axis];
      }
      // Beyond what any controller reads (ADR-0033's MAX_WRITTEN): refuse, never write
      // an exponent (review of #37, after the same fix to the other transforms).
      if (!writable(target)) {
        error(
          n,
          'TRANSFORM_OUT_OF_RANGE',
          `${L} would be ${Number.isFinite(target) ? String(target) : 'infinite'}: beyond ±${MAX_WRITTEN.toLocaleString('en-AU')}, no controller reads it. Refusing`,
        );
        continue;
      }
      // A feed per revolution is small (0.1 mm/rev is 0.003937 in/rev): two more places
      // keep it within 0.01% (review of #37), where 5 inch decimals were 0.08% off.
      // A feed keeps enough digits to stay within 0.01% (five significant): a feed per
      // revolution is small (0.1 mm/rev is 0.003937 in/rev), and so is a slow feed.
      const fPlaces =
        L === 'F' && target > 0 ? Math.max(places, Math.ceil(4 - Math.log10(target))) : places;
      const text = formatConverted(target, src, fPlaces);
      // A feed, a peck (Q) or a blending tolerance (G64 P/Q) that rounds to zero means
      // something else at zero: no feed, an endless peck, no blending (review of #37).
      if ((L === 'F' || L === 'Q' || L === 'P') && w.value.value !== 0 && Number(text) === 0) {
        error(
          n,
          'TRANSFORM_UNITS_PRECISION',
          `${L}${src} would round to zero in ${to === 'inch' ? 'inches' : 'mm'}, where it means something else. Refusing`,
        );
        continue;
      }
      if (axis) carry[axis] = target - Number(text);
      if (text !== src) {
        edits.push({ span: w.value.span, text });
        changed = true;
      }
    }
    if (changed) converted++;
    lines.push(edits.length ? editLine(line, edits) : line);
  }

  // The text-order modes must be the ones each line RUNS under (review of #37). A
  // subroutine body runs in its caller's modes, and a block-deleted line that changes a
  // mode may not run: either way a line would be converted for modes it doesn't have.
  // So every executed line of this file, with block delete on and off, is checked.
  // Block delete OFF first: every line runs, so a difference there is control flow.
  // One that appears only with it ON comes from a skipped "/" line.
  let assumed = false;
  const originalRuns: (ReturnType<typeof interpret> | undefined)[] = [undefined, undefined];
  const refused = new Set<number>();
  const MAX_MODE_ERRORS = 20;
  // Only worth running when nothing else refused: a refused loop may never end.
  for (const blockDelete of errors.length ? [] : [false, true]) {
    const run = interpret(program, {
      dialect,
      units: assume,
      blockDelete,
      onBlock: ({ line: n, file, state }) => {
        if (file !== undefined || refused.has(n)) return;
        const t = textState.get(n);
        if (!t) return;
        const differs = modeDifference(t, state, program.lines[n - 1]);
        if (!differs) return;
        refused.add(n);
        // One cause usually refuses many lines: name the first few, count the rest.
        if (refused.size > MAX_MODE_ERRORS) return;
        error(
          n,
          'TRANSFORM_CONTROL_FLOW',
          `This line runs ${differs}, not as the lines above it set. ${
            blockDelete
              ? 'A block-deleted ("/") line above it changes a mode, so the result would depend on the block-delete switch'
              : 'A subroutine runs in the modes of the line that calls it'
          }: refusing rather than converting it for the wrong modes`,
        );
      },
    });
    if (blockDelete) assumed = run.diagnostics.some((d) => d.code === 'SEMANTIC_UNITS_ASSUMED');
    originalRuns[blockDelete ? 1 : 0] = run; // reused by the final check
    // A run that stopped never checked the lines after the stop (review of #37).
    if (!run.completed) {
      const why = [...run.diagnostics].reverse().find((d) => d.severity === 'error');
      error(
        why?.line ?? 0,
        'TRANSFORM_CONTROL_FLOW',
        `The preview's run stopped here${why ? ` (${why.message})` : ''}, so the modes of the lines after it can't be checked. Refusing`,
      );
      break;
    }
  }
  if (flowErrors > 20)
    error(0, 'TRANSFORM_CONTROL_FLOW', `…and ${flowErrors - 20} more subroutine lines like these`);
  if (refused.size > MAX_MODE_ERRORS)
    error(
      0,
      'TRANSFORM_CONTROL_FLOW',
      `…and ${refused.size - MAX_MODE_ERRORS} more lines run in other modes than their text says`,
    );

  if (seen.size > 1 && flow)
    error(
      0,
      'TRANSFORM_CONTROL_FLOW',
      "This program switches units and uses subroutines or loops: a subroutine runs in the units its caller is in, which a line-by-line conversion can't know",
    );
  if (errors.length) return { ok: false, program, diagnostics: errors };

  // State the target units on a line of their own, before the first line of the main
  // program, unless that line already does so cleanly (a units word, no F, not
  // block-deletable). On a line of its own, F on the next line is read in the target
  // units, whatever the controller's default (review of #37: F read 25.4x off).
  const first = firstMainLine(program);
  let stated = false;
  let result: Program = { ...program, lines, diagnostics: lines.flatMap((l) => l.diagnostics) };
  if (first) {
    const words = first.tokens.filter((t): t is WordToken => t.kind === 'word');
    const clean =
      words.some((w) => w.letter === 'G' && (num0(w) === 20 || num0(w) === 21)) &&
      !words.some((w) => w.letter === 'F') &&
      !first.tokens.some((t) => t.kind === 'block-delete');
    if (!clean) {
      const index = first.lineNo - 1;
      const text = write({
        ...result,
        lines: [
          ...lines.slice(0, index),
          {
            ...(lines[index] as Line),
            text: `${to === 'inch' ? 'G20' : 'G21'}${first.eol || '\n'}${(lines[index] as Line).text}`,
          },
          ...lines.slice(index + 1),
        ],
      });
      result = parse(text);
      stated = true;
    }
  }
  // Finally, the result must RUN as the original did, line for line, both ways round:
  // every line either run has, the same steps in the same order, ending in the same
  // places (2 µm), arcs with the same turns, sweep (1 mrad), centre and radius (2 µm),
  // dwells and waits the same. It catches what no word rule can see: a rounded peck
  // depth that adds a peck, a sliver of arc whose rounded end lands on its start and
  // becomes a full circle, a near-semicircle R arc whose centre jumps, an off-radius arc
  // that only runs in the looser units (review of #37). The tolerances are the corpus
  // check's; one output quantum in inches is 0.25 µm.
  const steps = (list: readonly Step[]) => {
    const m = new Map<number, Step[]>();
    for (const st of list)
      if (!st.file) (m.get(st.line) ?? m.set(st.line, []).get(st.line))?.push(st);
    return m;
  };
  // With block delete off AND on: a mode or carry that differs only when "/" lines are
  // skipped shows only there (review of #37).
  for (const blockDelete of [false, true]) {
    const was = steps(
      originalRuns[blockDelete ? 1 : 0]?.steps ??
        interpret(program, { dialect, units: assume, blockDelete }).steps,
    );
    const now = steps(interpret(result, { dialect, units: to, blockDelete }).steps);
    const shift = stated && first ? first.lineNo : Infinity;
    const back = (n: number) => (n > shift ? n - 1 : n); // a result line, as an original one
    const ran = new Set([...was.keys(), ...[...now.keys()].filter((n) => n !== shift).map(back)]);
    for (const n of [...ran].sort((x, y) => x - y)) {
      const a = was.get(n) ?? [];
      const b = now.get(n >= shift ? n + 1 : n) ?? [];
      const why = runDifference(a, b);
      if (!why) continue;
      if (errors.some((e) => e.line === n && e.code === 'TRANSFORM_UNITS_CHANGED')) continue;
      // An R-format arc near a half circle is ill-conditioned: rounding its end moves
      // its centre a long way (25 µm for a 2.5 mm half circle in inches), or collapses a
      // sliver.
      const rArc =
        a.some((st) => st.kind === 'arc') &&
        (/arc|°/.test(why) || !b.some((st) => st.kind === 'arc')) &&
        (program.lines[n - 1]?.tokens ?? []).some((t) => t.kind === 'word' && t.letter === 'R');
      error(
        n,
        'TRANSFORM_UNITS_CHANGED',
        `This line runs differently once converted${blockDelete ? ' with block delete on' : ''} (${why}). ${rArc ? 'An R-format arc near a half circle moves its centre when its end is rounded: give the centre with I/J instead. ' : ''}Refusing`,
      );
    }
  }
  if (errors.length) return { ok: false, program, diagnostics: errors };

  // Warn when the ORIGINAL relied on the preference (the interpreter's own rule).
  if (assumed)
    notes.push({
      severity: 'warning',
      code: 'TRANSFORM_UNITS_ASSUMED',
      message: `The program moved before it stated its units: it was read as ${assume === 'inch' ? 'inches' : 'millimetres'} (your units preference). Check the original was meant that way`,
      line: first?.lineNo ?? 0,
    });
  const from = [...seen].filter((u) => u !== to);
  const name = (u: Units) => (u === 'inch' ? 'inches' : 'millimetres');
  if (from.length)
    notes.push({
      severity: 'info',
      code: 'TRANSFORM_UNITS_CONVERTED',
      message: `Converted from ${from.map(name).join(' and ')} to ${name(to)} (${converted} lines)`,
      line: 0,
    });
  else if (stated)
    notes.push({
      severity: 'info',
      code: 'TRANSFORM_UNITS_STATED',
      message: `Already in ${name(to)}: added ${to === 'inch' ? 'G20' : 'G21'} on a line of its own, so the file states its units`,
      line: 0,
    });
  else
    notes.push({
      severity: 'info',
      code: 'TRANSFORM_UNITS_ALREADY',
      message: `Already in ${name(to)}: nothing to convert`,
      line: 0,
    });
  return { ok: true, program: result, diagnostics: notes };
}

function num0(w: WordToken): number | null {
  return w.value?.kind === 'number' ? w.value.value : null;
}

function factor(from: Units, to: Units): number {
  return from === to ? 1 : to === 'inch' ? 1 / 25.4 : 25.4;
}

/**
 * The first line the main program runs: outside any O-word subroutine definition, with
 * a word on it that isn't just the program number. Leading %, comments and an O-number
 * line come before it.
 */
function firstMainLine(program: Program): Line | undefined {
  let inSub = 0;
  for (const line of program.lines) {
    for (const t of line.tokens)
      if (t.kind === 'oword') {
        if (t.keyword === 'sub') inSub++;
        else if (t.keyword === 'endsub') inSub = Math.max(0, inSub - 1);
      }
    if (inSub > 0) continue;
    const code = line.tokens.some(
      (t) =>
        t.kind === 'word' || (t.kind === 'oword' && t.keyword !== null && t.keyword !== 'endsub'),
    );
    if (code) return line;
  }
  return undefined;
}

/**
 * How the modes a line runs under differ from the text's, in words, or null if they
 * don't. Only the modes the line READS are compared (review of #37): units for any
 * length or feed, distance mode for X/Y/Z/R, feed mode for F, and the modal motion
 * where the line relies on it (no motion code of its own, but words a motion reads).
 * Relied-on motion the text doesn't know, or the interpreter doesn't model (none yet,
 * G80, G38.x…), counts as different: unknown is never assumed to match.
 */
function modeDifference(t: TextState, run: ModalState, line: Line | undefined): string | null {
  const words = (line?.tokens ?? []).filter((x): x is WordToken => x.kind === 'word');
  const has = (letters: string) => words.some((w) => letters.includes(w.letter));
  const g64 = words.some((w) => w.letter === 'G' && num0(w) === 64);
  const diffs: string[] = [];
  if (has('XYZIJKRQF') || (g64 && has('P')))
    if (run.units !== t.units) diffs.push(`in ${run.units === 'inch' ? 'inches' : 'mm'}`);
  if (has('XYZR') && (run.distance === 'absolute') !== t.absolute)
    diffs.push(`in ${run.distance} mode`);
  if (has('F') && run.feedMode !== t.feedMode) diffs.push(`with ${run.feedMode} feed`);
  // A canned cycle reads the retract mode (it decides what of a G91 cycle carries).
  const cycle =
    words.some((w) => w.letter === 'G' && CYCLES.has(num0(w) ?? -1)) ||
    (t.motion !== null && CYCLES.has(t.motion) && has('XYZ'));
  if (cycle && (run.retract === 'r-plane') !== t.retractToR)
    diffs.push(`with ${run.retract === 'r-plane' ? 'G99' : 'G98'} retract`);
  // The words a modal motion would read: those no code on the line takes for itself.
  const ownMotion = words.some((w) => w.letter === 'G' && MOTION.has(num0(w) ?? -1));
  const owned = words
    .filter((w) => w.letter === 'G')
    .map((w) => OWN_WORDS.get(num0(w) ?? -1) ?? '')
    .join('');
  // A modal motion only runs, and reads the line's words, when the line moves: axis
  // words, or an arc's centre (a full circle). Without them (`M66 P0 L3 Q5`) nothing
  // is the motion's.
  const moves =
    words.some((w) => 'XYZ'.includes(w.letter) && !owned.includes(w.letter)) ||
    ((t.motion === 2 || t.motion === 3) && has('IJK'));
  const motionReads =
    moves && words.some((w) => 'XYZIJKRQP'.includes(w.letter) && !owned.includes(w.letter));
  if (!ownMotion && motionReads) {
    const modelled = ['G0', 'G1', 'G2', 'G3', 'G73', 'G81', 'G82', 'G83'];
    const text = t.motion === null ? null : `G${t.motion}`;
    if (text === null || !modelled.includes(text) || text !== run.motion)
      diffs.push(`under ${run.motion}${text === null ? '' : ` (the text says ${text})`}`);
  }
  return diffs.length ? diffs.join(', ') : null;
}

/** The point halfway along an arc, in machine coordinates. */
function midpoint(a: Extract<Step, { kind: 'arc' }>): Position {
  const p = new Float64Array(3);
  arcPoint(a, startAngle(a), 0.5, p, 0);
  return { ...a.to, X: p[0] as number, Y: p[1] as number, Z: p[2] as number };
}

/** How two runs of one line differ, in words, or null if they don't (see the final check). */
export function runDifference(a: readonly Step[], b: readonly Step[]): string | null {
  if (a.length !== b.length) return `${a.length} steps, then ${b.length}`;
  const far = (p: Position, q: Position) => Math.hypot(p.X - q.X, p.Y - q.Y, p.Z - q.Z) > 0.002;
  for (let i = 0; i < a.length; i++) {
    const s = a[i] as Step;
    const t = b[i] as Step;
    if (s.kind !== t.kind) return `a ${s.kind}, then a ${t.kind}`;
    if ((s.kind === 'linear' || s.kind === 'arc') && (t.kind === 'linear' || t.kind === 'arc'))
      if (far(s.to, t.to)) return 'it ends somewhere else';
    if (s.kind === 'arc' && t.kind === 'arc') {
      if (s.turns !== t.turns) return `${s.turns} turns, then ${t.turns}`;
      // Coarse, so a sliver can never become a full circle; the fine test is WHERE the
      // arc goes (its midpoint, centre and radius, 2 µm). An absolute sweep tolerance
      // refused most small arcs, whose sweep moves a lot for a micrometre (review of #37).
      if (Math.abs(s.sweep - t.sweep) > 0.1)
        return `an arc of ${((Math.abs(s.sweep) * 180) / Math.PI).toFixed(3)}°, then ${((Math.abs(t.sweep) * 180) / Math.PI).toFixed(3)}°`;
      if (far(midpoint(s), midpoint(t))) return 'its arc bulges somewhere else';
      if (far(s.centre, t.centre) || Math.abs(s.radius - t.radius) > 0.002)
        return 'its arc centre or radius moves';
    }
    // Feeds: the same mode, and the same rate within 0.01% (relative only: a slow feed
    // keeps five significant digits, so an absolute allowance would hide +97%).
    const feed = (st: Step) =>
      st.kind === 'arc' || (st.kind === 'linear' && !st.rapid) ? st.feed : null;
    const fs = feed(s);
    const ft = feed(t);
    if (fs && ft) {
      if (fs.mode !== ft.mode) return `a ${fs.mode} feed, then ${ft.mode}`;
      const v = (f: NonNullable<typeof fs>) =>
        f.mode === 'per-minute'
          ? f.mmPerMinute
          : f.mode === 'inverse-time'
            ? f.perMinute
            : f.mode === 'per-revolution'
              ? f.mmPerRevolution
              : 0; // unspecified: no rate to compare
      const [x, y] = [v(fs), v(ft)];
      const slack = 1e-4 * Math.abs(x);
      if (Math.abs(x - y) > slack) return `a feed of ${x}, then ${y}`;
    }
    if (s.kind === 'spindle' && t.kind === 'spindle' && (s.state !== t.state || s.rpm !== t.rpm))
      return 'its spindle speed changes';
    if (s.kind === 'dwell' && t.kind === 'dwell' && s.seconds !== t.seconds)
      return `a dwell of ${s.seconds} s, then ${t.seconds} s`;
    if (
      s.kind === 'wait' &&
      t.kind === 'wait' &&
      (s.input !== t.input || s.timeoutSeconds !== t.timeoutSeconds || s.skipLines !== t.skipLines)
    )
      return 'its wait changes';
  }
  return null;
}
