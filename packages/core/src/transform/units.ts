// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import { interpret } from '../interp/interpret.js';
import { editLine, parse, write, type LineEdit } from '../syntax/program.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatConverted } from './format.js';

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
const MOTION = new Set([0, 1, 2, 3, 38.2, 73, 80, 81, 82, 83, 84, 85, 86, 89]);
/** Letters that are never lengths. */
const NOT_LENGTH = new Set(['G', 'M', 'N', 'T', 'H', 'D', 'S', 'A', 'B', 'C', 'L', 'O']);

type Units = 'mm' | 'inch';
type Axis = 'X' | 'Y' | 'Z';

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
  for (const line of program.lines)
    for (const t of line.tokens) {
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

  let units: Units = assume;
  let absolute = true;
  let feedMode: 'per-minute' | 'inverse-time' | 'per-revolution' = 'per-minute';
  let motion: number | null = null;
  const carry: Record<Axis, number> = { X: 0, Y: 0, Z: 0 };
  const seen = new Set<Units>();
  let converted = 0;

  const lines: Line[] = [];
  for (const line of program.lines) {
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    const n = line.lineNo;
    const num = (w: WordToken | undefined) => (w?.value?.kind === 'number' ? w.value.value : null);
    const edits: LineEdit[] = [];
    const before = units;
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
    const cycleRuns = !offsetLine && motion !== null && CYCLES.has(motion) && axes;
    const lengthFactor = factor(units, to);
    // F is read in the units in force before the line (or, on end-of-line controllers,
    // after it). In the OUTPUT that's always the target: the units are stated first.
    const feedFactor = factor(feedAtEndOfLine ? units : before, to);
    // A repeat that steps in G91 re-applies each rounded increment.
    const repeats =
      cycleRuns &&
      !absolute &&
      repeatLetter === 'L' &&
      dialect.interpreter.cycleRepeat.stepInIncremental &&
      (num(words.find((w) => w.letter === 'L')) ?? 1) > 1;

    let changed = false;
    for (const w of words) {
      if (w.value?.kind !== 'number') continue; // refused above
      const L = w.letter;
      let f: number;
      let axis: Axis | undefined;
      if (L === 'X' || L === 'Y' || L === 'Z') {
        f = lengthFactor;
        if (!absolute && !offsetLine) axis = L;
        else if (absolute) carry[L] = 0;
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
          if (!g10)
            error(
              n,
              'TRANSFORM_UNSUPPORTED_WORD',
              'R here is neither an arc radius nor a cycle retract height, so its meaning is unknown',
            );
          continue;
        }
        f = lengthFactor;
      } else if (L === 'Q') {
        if (!cycleRuns && !gs.has(64)) continue; // e.g. M66's timeout: not a length
        f = lengthFactor;
      } else if (L === 'P') {
        if (!gs.has(64)) continue; // dwell, turns, an index…
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
        const loose = Math.abs(Number(formatConverted(exact, src, places)) - exact) > 1e-9;
        if (loose && (flow || repeats)) {
          error(
            n,
            'TRANSFORM_UNITS_DRIFT',
            `This incremental ${L} doesn't convert exactly, and runs repeatedly (a loop, subroutine or repeated cycle), so its rounding would add up. Refusing`,
          );
          continue;
        }
        target = exact + carry[axis];
      }
      const text = formatConverted(target, src, places);
      if (axis) carry[axis] = target - Number(text);
      if (text !== src) {
        edits.push({ span: w.value.span, text });
        changed = true;
      }
    }
    if (changed) converted++;
    lines.push(edits.length ? editLine(line, edits) : line);
  }

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
  // Warn when the ORIGINAL relied on the preference (the interpreter's own rule).
  if (
    interpret(program, { dialect, units: assume }).diagnostics.some(
      (d) => d.code === 'SEMANTIC_UNITS_ASSUMED',
    )
  )
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
