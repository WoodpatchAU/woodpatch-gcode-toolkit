// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import { editLine, type LineEdit } from '../syntax/program.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatConverted } from './format.js';

/**
 * Units conversion (parcel 4b, ADR-0034): every length and feed the program writes,
 * converted between millimetres and inches, and every G20/G21 word rewritten. Nothing
 * moves: interpreting the result gives the same toolpath to within a micrometre.
 *
 * Each line converts from the units IT is in, so a program that switches units part
 * way through comes out consistently in one. Operator decisions (2026-09-28):
 * - inch values get at least 5 decimals (0.00001 in, about 0.25 µm), so mm → inch →
 *   mm round-trips within 1 µm; millimetres at least 3; exact values stay short
 *   (25.4 mm is written 1, not 1.00000);
 * - a program that moves before stating its units is read in the user's units
 *   preference (`assume`), warned about, and given an explicit G20/G21.
 */

/**
 * G codes whose words are all lengths (or not coordinates at all), so scaling their
 * lengths is right. Wider than the geometric transforms' list: an offset (G52, G92,
 * G10 L20), a probe target or a tool-length offset is a length in the program's units,
 * and converts like any other. Anything else refuses: G68's R is an angle, G33's K a
 * pitch in a mode this doesn't model, and so on.
 */
const LENGTH_G = new Set([
  0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 28.1, 30, 30.1, 38.2, 38.3, 38.4, 38.5, 40, 41, 41.1,
  42, 42.1, 43, 43.1, 49, 52, 53, 54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3, 61, 61.1, 64, 73, 80,
  81, 82, 83, 84, 85, 86, 89, 90, 90.1, 91, 91.1, 92, 92.1, 92.2, 92.3, 93, 94, 95, 96, 97, 98, 99,
]);
const CYCLES = new Set([73, 81, 82, 83, 84, 85, 86, 89]);
const MOTION = new Set([0, 1, 2, 3, 38.2, 38.3, 38.4, 38.5, 73, 80, 81, 82, 83, 84, 85, 86, 89]);

type Units = 'mm' | 'inch';

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
  const minDecimals = to === 'inch' ? 5 : 3; // places, per the operator's decision
  const repeatLetter = dialect.interpreter.cycleRepeat.letter;
  const feedAtEndOfLine = dialect.interpreter.feedUnits === 'end-of-line';

  // Does the program state its units before the first line with G-code on it?
  let firstCode: WordToken | undefined;
  let firstCodeLine: Line | undefined;
  let statedBeforeCode = false;
  for (const line of program.lines) {
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    const unitsWord = words.some(
      (w) =>
        w.letter === 'G' &&
        w.value?.kind === 'number' &&
        (w.value.value === 20 || w.value.value === 21),
    );
    if (words.length === 0) continue;
    firstCode = words[0];
    firstCodeLine = line;
    statedBeforeCode = unitsWord;
    break;
  }

  let units: Units = assume;
  let feedMode: 'per-minute' | 'inverse-time' | 'per-revolution' = 'per-minute';
  let motion: number | null = null;
  let converted = 0;
  let mixed = false;
  const seen = new Set<Units>();

  const lines: Line[] = [];
  for (const line of program.lines) {
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    const n = line.lineNo;
    const num = (w: WordToken | undefined) => (w?.value?.kind === 'number' ? w.value.value : null);
    const edits: LineEdit[] = [];

    for (const w of words)
      if (w.letter === 'M' && num(w) === 98 && dialect.interpreter.subprograms.m98 === 'file')
        error(
          n,
          'TRANSFORM_CONTROL_FLOW',
          'M98 calls a subprogram in another file, which a conversion of this file would leave in the old units',
        );

    const before = units;
    let ownMotion: number | null = null;
    const gs = new Set<number>();
    for (const w of words) {
      if (w.letter !== 'G') continue;
      const g = num(w);
      if (g === null) {
        error(
          n,
          'TRANSFORM_EXPRESSION',
          `${line.text.slice(w.span.start, w.span.end)}: a G code written as an expression can't be checked`,
        );
        continue;
      }
      gs.add(g);
      if (!LENGTH_G.has(g)) {
        error(
          n,
          'TRANSFORM_UNSUPPORTED_CODE',
          `G${g}'s words aren't all lengths (or aren't modelled), so its units can't be converted safely`,
        );
        continue;
      }
      if (g === 20) units = 'inch';
      else if (g === 21) units = 'mm';
      else if (g === 93) feedMode = 'inverse-time';
      else if (g === 94) feedMode = 'per-minute';
      else if (g === 95) feedMode = 'per-revolution';
      else if (MOTION.has(g)) ownMotion = g;
      // The units word itself now names the target.
      if ((g === 20 || g === 21) && w.value?.kind === 'number') {
        const src = line.text.slice(w.value.span.start, w.value.span.end);
        const text = src.replace(/2[01](?=(\.0*)?$)/, to === 'inch' ? '20' : '21');
        if (text !== src) edits.push({ span: w.value.span, text });
      }
    }
    if (ownMotion !== null) motion = ownMotion;
    if (words.length) seen.add(units);
    if (seen.size > 1) mixed = true;

    // The first line of G-code, when nothing stated the units: say which were assumed,
    // and state the target units from here on.
    if (line === firstCodeLine && !statedBeforeCode && firstCode) {
      edits.push({
        span: { start: firstCode.span.start, end: firstCode.span.start },
        text: `${to === 'inch' ? 'G20' : 'G21'} `,
      });
      notes.push({
        severity: 'warning',
        code: 'TRANSFORM_UNITS_ASSUMED',
        message: `The program didn't state its units before it started: read as ${assume === 'inch' ? 'inches' : 'millimetres'} (your units preference), and it now states ${to === 'inch' ? 'G20' : 'G21'}. Check the original was meant that way`,
        line: n,
      });
    }

    const lengthFactor = factor(units, to);
    const feedFactor = factor(feedAtEndOfLine ? units : before, to);
    const cycle = motion !== null && CYCLES.has(motion);
    const lengthy = (w: WordToken): boolean => {
      switch (w.letter) {
        case 'X':
        case 'Y':
        case 'Z':
        case 'I':
        case 'J':
        case 'R':
          return true;
        case 'K':
          return !(cycle && repeatLetter === 'K'); // Masso's cycle repeat count
        case 'Q':
          return cycle || gs.has(64); // peck depth; naive-CAM tolerance
        case 'P':
          return gs.has(64); // path tolerance (G4's P is time, G10's an index, ...)
        default:
          return false;
      }
    };
    let changed = false;
    for (const w of words) {
      const isFeed = w.letter === 'F' && feedMode !== 'inverse-time';
      const f = isFeed ? feedFactor : lengthy(w) ? lengthFactor : 1;
      if (f === 1) continue;
      if (w.value?.kind !== 'number') {
        error(
          n,
          'TRANSFORM_EXPRESSION',
          `${line.text.slice(w.span.start, w.span.end)} is an expression or parameter: its units can't be converted faithfully`,
        );
        continue;
      }
      const src = line.text.slice(w.value.span.start, w.value.span.end);
      const text = formatConverted(w.value.value * f, src, minDecimals);
      if (text !== src) {
        edits.push({ span: w.value.span, text });
        changed = true;
      }
    }
    if (changed) converted++;
    lines.push(edits.length ? editLine(line, edits) : line);
  }

  // O-word subroutines and loops are fine for a conversion (each word converts the same
  // wherever it runs), unless the program switches units, when a sub's words would be
  // read in whichever units the CALLER is in.
  if (
    mixed &&
    program.lines.some((l) => l.tokens.some((t) => t.kind === 'oword' && t.keyword !== null))
  )
    error(
      0,
      'TRANSFORM_CONTROL_FLOW',
      "This program switches units and uses O-word subroutines or loops: a subroutine runs in the units its caller is in, which a line-by-line conversion can't know",
    );

  if (errors.length) return { ok: false, program, diagnostics: [...errors, ...notes] };
  const from = [...seen].filter((u) => u !== to);
  notes.push(
    from.length === 0
      ? {
          severity: 'info',
          code: 'TRANSFORM_UNITS_ALREADY',
          message: `Already in ${to === 'inch' ? 'inches' : 'millimetres'}: nothing to convert`,
          line: 0,
        }
      : {
          severity: 'info',
          code: 'TRANSFORM_UNITS_CONVERTED',
          message: `Converted from ${from.map((u) => (u === 'inch' ? 'inches' : 'millimetres')).join(' and ')} to ${to === 'inch' ? 'inches' : 'millimetres'} (${converted} lines)`,
          line: 0,
        },
  );
  return {
    ok: true,
    program: { ...program, lines, diagnostics: lines.flatMap((l) => l.diagnostics) },
    diagnostics: notes,
  };
}

function factor(from: Units, to: Units): number {
  return from === to ? 1 : to === 'inch' ? 1 / 25.4 : 25.4;
}
