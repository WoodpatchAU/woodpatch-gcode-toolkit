// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import { interpret } from '../interp/interpret.js';
import { editLine, type LineEdit } from '../syntax/program.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatLike } from './format.js';
import type { LineRange } from './map.js';

/**
 * Feed and spindle overrides (parcel 4c, ADR-0036): scale F or S by a percentage,
 * written into the program, as a controller's override knob would at run time.
 *
 * F is MODAL, which is what makes a per-move-type override work at all. A program often
 * sets one F for plunges and cuts alike, so overriding only the plunges means giving
 * each plunge line its own F and restoring the original on the next cut. The walker
 * tracks the F the controller actually has at each line (after these edits), and writes
 * or inserts an F only where that would otherwise be wrong. Untouched lines stay
 * byte-for-byte.
 */

type MoveKind = 'cut' | 'plunge';

/** Each line's feed moves: plunge if all are vertical (Z only), cut if any isn't. */
function feedMoves(
  program: Program,
  dialect: Dialect,
): { moves: Map<number, MoveKind>; completed: boolean } {
  const out = new Map<number, MoveKind>();
  // Block delete off, so "/" lines are classified too.
  const run = interpret(program, { dialect, blockDelete: false });
  for (const s of run.steps) {
    if (s.file) continue;
    if (s.kind === 'arc') out.set(s.line, 'cut');
    else if (s.kind === 'linear' && !s.rapid) {
      // Vertical feed moves (plunges, and a boring cycle's feed back out) are 'plunge';
      // anything that moves in X/Y, ramps included, is 'cut'.
      const flat = Math.hypot(s.to.X - s.from.X, s.to.Y - s.from.Y) < 1e-9;
      const vertical = flat && s.to.Z !== s.from.Z;
      if (!vertical) out.set(s.line, 'cut');
      else if (out.get(s.line) !== 'cut') out.set(s.line, 'plunge');
    }
  }
  return { moves: out, completed: run.completed };
}

const inRange = (n: number, r: LineRange | undefined) => !r || (n >= r.from && n <= r.to);
const hasFlow = (program: Program) =>
  program.lines.some((l) =>
    l.tokens.some(
      (t) =>
        (t.kind === 'oword' && t.keyword !== null) ||
        (t.kind === 'word' &&
          t.letter === 'M' &&
          t.value?.kind === 'number' &&
          (t.value.value === 98 || t.value.value === 99)),
    ),
  );

export function overrideFeed(
  program: Program,
  percent: number,
  only: MoveKind | undefined,
  lines: LineRange | undefined,
  dialect: Dialect,
): { ok: boolean; program: Program; diagnostics: Diagnostic[] } {
  const k = percent / 100;
  const errors: Diagnostic[] = [];
  const notes: Diagnostic[] = [];
  // A plain, global override scales every F word the same, wherever it runs. A
  // per-type or per-range one depends on which lines run as what, which control flow
  // makes unknowable.
  const selective = only !== undefined || lines !== undefined;
  if (selective && hasFlow(program))
    errors.push({
      severity: 'error',
      code: 'TRANSFORM_CONTROL_FLOW',
      message:
        'An override limited to plunges, cuts or a range of lines needs each line to run once, in order: subroutines, calls and loops make that unknowable. A plain override of every feed works',
      line: 0,
    });
  const classified = selective ? feedMoves(program, dialect) : null;
  const moves = classified?.moves ?? new Map<number, MoveKind>();
  // A run that stopped early never classified the lines after the stop. Defensive:
  // the causes of a stop other than the safety limits (2 million steps and the like)
  // are control flow, which a selective override has refused already.
  if (classified && !classified.completed)
    errors.push({
      severity: 'error',
      code: 'TRANSFORM_CONTROL_FLOW',
      message:
        "The preview's run stopped before the end, so which later lines are plunges or cuts is unknown: an override limited to plunges, cuts or lines can't be applied. A plain override of every feed works",
      line: 0,
    });
  // The walker tracks F in text order. Where "/" is an operator's switch, a block-
  // deletable line that feeds or sets the feed may not run, and the F in force after
  // it then differs from the one tracked (as the second review of #37 found for units).
  if (selective && dialect.interpreter.blockDelete === 'switch')
    for (const line of program.lines) {
      if (!line.tokens.some((t) => t.kind === 'block-delete')) continue;
      const feedWord = line.tokens.some(
        (t) =>
          t.kind === 'word' &&
          (t.letter === 'F' ||
            (t.letter === 'G' &&
              t.value?.kind === 'number' &&
              [93, 94, 95].includes(t.value.value))),
      );
      if (feedWord || moves.has(line.lineNo))
        errors.push({
          severity: 'error',
          code: 'TRANSFORM_BLOCK_DELETE',
          message:
            'This block-deletable ("/") line feeds or sets the feed, and whether it runs is the block-delete switch: the feed in force after it depends on that, so an override limited to plunges, cuts or lines can\'t be right both ways. A plain override of every feed works',
          line: line.lineNo,
        });
    }

  let inch = false;
  let original: number | null = null; // the program's F, in its own terms
  let written: number | null = null; // the F the controller has after our edits
  let changed = 0;
  let unset = false;
  const out: Line[] = [];
  for (const line of program.lines) {
    const n = line.lineNo;
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    for (const w of words)
      if (w.letter === 'G' && w.value?.kind === 'number') {
        if (w.value.value === 20) inch = true;
        if (w.value.value === 21) inch = false;
      }
    const F = words.find((w) => w.letter === 'F');
    if (F) {
      if (F.value?.kind !== 'number') {
        errors.push({
          severity: 'error',
          code: 'TRANSFORM_EXPRESSION',
          message: `${line.text.slice(F.span.start, F.span.end)} is an expression or parameter: an override can't rewrite it faithfully`,
          line: n,
        });
        out.push(line);
        continue;
      }
      original = F.value.value;
    }
    const kind = selective ? moves.get(n) : undefined;
    // What this line's feed should be, and whether it feeds at all.
    const applies = inRange(n, lines) && (!only || kind === only);
    const feeds = selective ? kind !== undefined : true;
    const want = original === null ? null : applies ? original * k : original;
    const edits: LineEdit[] = [];
    const minDecimals = inch ? 2 : 1;
    if (F && F.value?.kind === 'number') {
      // An F word here: write what this line (or, on a line without a feed move, the
      // next ones by default) should have.
      const value = selective && !feeds ? original : want;
      const src = line.text.slice(F.value.span.start, F.value.span.end);
      const text = formatLike(value as number, src, minDecimals);
      if (text !== src) edits.push({ span: F.value.span, text });
      written = Number(text);
    } else if (
      feeds &&
      selective &&
      want !== null &&
      written !== null &&
      Math.abs(want - written) > 1e-9
    ) {
      // No F here, but the controller's F is wrong for this line: say it explicitly.
      const last = words[words.length - 1] as WordToken;
      const text = formatLike(want, String(original), minDecimals);
      edits.push({ span: { start: last.span.end, end: last.span.end }, text: ` F${text}` });
      written = Number(text);
    }
    if (feeds && selective && kind && original === null && applies) unset = true;
    if (edits.length) changed++;
    out.push(edits.length ? editLine(line, edits) : line);
  }
  if (errors.length) return { ok: false, program, diagnostics: errors };
  if (unset)
    notes.push({
      severity: 'warning',
      code: 'TRANSFORM_FEED_UNSET',
      message:
        "Some moves run before any F is given, at the machine's own rate: an override in the program can't reach them",
      line: 0,
    });
  notes.push({
    severity: 'info',
    code: 'TRANSFORM_FEED_OVERRIDE',
    message: `Feed ${only ? `(${only === 'cut' ? 'cutting moves' : 'plunges'}) ` : ''}set to ${percent}%${lines ? ` on lines ${lines.from}–${lines.to}` : ''}: ${changed} lines changed`,
    line: 0,
  });
  return {
    ok: true,
    program: { ...program, lines: out, diagnostics: out.flatMap((l) => l.diagnostics) },
    diagnostics: notes,
  };
}

export function overrideSpindle(
  program: Program,
  percent: number,
  lines: LineRange | undefined,
): { ok: boolean; program: Program; diagnostics: Diagnostic[] } {
  const k = percent / 100;
  const errors: Diagnostic[] = [];
  let changed = 0;
  const out: Line[] = [];
  for (const line of program.lines) {
    const n = line.lineNo;
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    // Masso's M66 uses S for the number of lines to skip, not a speed.
    const m66 = words.some(
      (w) => w.letter === 'M' && w.value?.kind === 'number' && w.value.value === 66,
    );
    const S = words.find((w) => w.letter === 'S');
    if (!S || m66 || !inRange(n, lines)) {
      out.push(line);
      continue;
    }
    if (S.value?.kind !== 'number') {
      errors.push({
        severity: 'error',
        code: 'TRANSFORM_EXPRESSION',
        message: `${line.text.slice(S.span.start, S.span.end)} is an expression or parameter: an override can't rewrite it faithfully`,
        line: n,
      });
      out.push(line);
      continue;
    }
    const src = line.text.slice(S.value.span.start, S.value.span.end);
    const text = formatLike(Math.round(S.value.value * k * 10) / 10, src, 0);
    if (text === src) {
      out.push(line);
      continue;
    }
    changed++;
    out.push(editLine(line, [{ span: S.value.span, text }]));
  }
  if (errors.length) return { ok: false, program, diagnostics: errors };
  return {
    ok: true,
    program: { ...program, lines: out, diagnostics: out.flatMap((l) => l.diagnostics) },
    diagnostics: [
      {
        severity: 'info',
        code: 'TRANSFORM_SPINDLE_OVERRIDE',
        message: `Spindle speed set to ${percent}%${lines ? ` on lines ${lines.from}–${lines.to}` : ''}: ${changed} lines changed`,
        line: 0,
      },
    ],
  };
}
