// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Dialect } from '../dialect/profiles.js';
import { interpret } from '../interp/interpret.js';
import type { ModalState, Plane, Step } from '../interp/types.js';
import { arcPoint, chordsNeeded, startAngle } from '../path/path.js';
import { editLine, parse, type LineEdit } from '../syntax/program.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatLike } from './format.js';
import type { LineRange } from './map.js';

/**
 * Arc to line conversion (parcel 4d, ADR-0037): every G2/G3 arc becomes a run of G1
 * chords that stay within `tolerance` of the true arc, for controllers or tools that
 * handle arcs badly. Operator decisions (2026-09-28): 0.01 mm by default; every arc,
 * or only those in a line range and/or radius band; G91 arcs carry each chord's
 * rounding into the next, so the arc ends exactly where it did.
 *
 * The geometry is the interpreter's: the same arc (centre, sweep, helix, spiral) the
 * viewer draws, sampled with the viewer's own arc function. Each converted line
 * becomes several: the first keeps everything else on the line (its N number, F, S,
 * M codes, comments), with G1 for G2/G3 and the first chord's end for the arc words;
 * the rest carry only the chord ends. The last chord ends exactly at the arc's end.
 *
 * A line that runs more than once must convert the same every time: a subroutine
 * called from different places, or a line after a block-deleted move, would need
 * different chords, so it's refused. So is anything that can't be written as chords
 * faithfully (expressions, inverse-time feed, other axes on the line, cutter
 * compensation). A coordinate rotation (G68, G10 R) needs nothing: it rotates the
 * chords as it would the arc.
 */

type Units = 'mm' | 'inch';
type Axis3 = 'X' | 'Y' | 'Z';
type Arc = Extract<Step, { kind: 'arc' }>;

export interface ArcsOptions {
  /** Maximum distance from a chord to the true arc, in mm. Default 0.01. */
  readonly tolerance?: number;
  /** Only arcs on these source lines. */
  readonly lines?: LineRange | undefined;
  /** Only arcs with a radius in this band, mm (inclusive). */
  readonly radius?: { readonly min?: number; readonly max?: number } | undefined;
  /** The units of a program that states none (the user's units preference). */
  readonly assume?: Units | undefined;
}

/** The plane's axes, in word order (X, Y, Z), with its normal last. */
const PLANE_AXES: Readonly<Record<Plane, readonly [Axis3, Axis3, Axis3]>> = {
  XY: ['X', 'Y', 'Z'],
  ZX: ['Z', 'X', 'Y'],
  YZ: ['Y', 'Z', 'X'],
};
const ORDER: readonly Axis3[] = ['X', 'Y', 'Z'];
/** Words an arc line may carry besides its own: anything else is refused. */
const ARC_WORDS = new Set(['X', 'Y', 'Z', 'I', 'J', 'K', 'R', 'P']);
const KEPT_WORDS = new Set(['G', 'M', 'N', 'F', 'S', 'T', 'H', 'D']);
/** M codes that act AFTER the line's motion: they'd end up after the first chord. */
const AFTER_MOTION_M = new Set([0, 1, 2, 30, 60, 98, 99]);
const MOTION_G = new Set([0, 1, 2, 3, 33, 38.2, 38.3, 38.4, 38.5, 73, 76, 80, 81, 82, 83, 84, 85]);
/** Caps, so a tiny tolerance on a huge arc can't produce a file nothing can load. */
const MAX_CHORDS_PER_ARC = 100_000;
const MAX_OUTPUT_LINES = 2_000_000;

const num = (w: WordToken | undefined) => (w?.value?.kind === 'number' ? w.value.value : null);

export function arcsToLines(
  program: Program,
  options: ArcsOptions,
  dialect: Dialect,
): { ok: boolean; program: Program; diagnostics: Diagnostic[] } {
  const tolerance = options.tolerance ?? 0.01;
  const assume = options.assume ?? 'mm';
  const errors: Diagnostic[] = [];
  const notes: Diagnostic[] = [];
  const error = (line: number, code: string, message: string) => {
    if (errors.length < 200) errors.push({ severity: 'error', code, message, line });
  };

  // Every run the controller could make of this file: block delete on and off. A line
  // must convert the same in each (unless it only runs in one). The modes each arc
  // line RUNS in come from the interpreter, not the text above it: a subroutine runs in
  // its caller's modes, and a block-deleted mode word may not run (review of #37).
  const executions = new Map<number, Arc[]>();
  const modes = new Map<number, Map<string, Modes>>();
  const lineAt = (n: number) => program.lines[n - 1];
  for (const blockDelete of [true, false]) {
    const run = interpret(program, {
      dialect,
      units: assume,
      blockDelete,
      onBlock: ({ line, file, state }) => {
        if (file !== undefined) return;
        const m = runModes(state, lineAt(line));
        (modes.get(line) ?? modes.set(line, new Map()).get(line))?.set(key(m), m);
      },
    });
    for (const s of run.steps) {
      if (s.file) continue;
      if (s.kind === 'arc')
        (executions.get(s.line) ?? executions.set(s.line, []).get(s.line))?.push(s);
    }
  }
  // Control flow, for the modal G2/G3 rule below.
  const flow = program.lines.some((l) =>
    l.tokens.some(
      (t) =>
        (t.kind === 'oword' && t.keyword !== null) ||
        (t.kind === 'word' &&
          t.letter === 'M' &&
          t.value?.kind === 'number' &&
          (t.value.value === 98 || t.value.value === 99)),
    ),
  );

  const selects = (n: number, runs: readonly Arc[]) =>
    runs.length > 0 &&
    inRange(n, options.lines) &&
    runs.every((a) => inBand(Math.max(a.radius, a.endRadius), options.radius));
  const anySelected = [...executions].some(([n, runs]) => selects(n, runs));
  const eolDefault = program.lines.find((l) => l.eol)?.eol ?? '\n';
  const places = { mm: 3, inch: 4 };
  // Whether the motion mode in force (in text order) was set by a converted arc, which
  // now leaves G1 behind: a following arc line that relies on G2/G3 being modal must say so.
  let modalFromConverted = false;
  let converted = 0;
  let written = 0;
  const out: string[] = [];
  const skipped: number[] = [];

  for (const line of program.lines) {
    const n = line.lineNo;
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    let ownMotion: number | null = null;
    for (const w of words) {
      const g = w.letter === 'G' ? num(w) : null;
      if (g !== null && MOTION_G.has(g)) ownMotion = g;
    }
    const runs = executions.get(n) ?? [];
    const explicitArc = ownMotion === 2 || ownMotion === 3;
    const selected = selects(n, runs);

    if (!selected) {
      if (explicitArc && !runs.length) skipped.push(n);
      let text = line.text;
      // An arc left as it is, relying on G2/G3 from a converted line: now explicit.
      // With control flow the line before it in the TEXT may not be the one before it
      // in the RUN, so then any conversion at all makes it explicit.
      if (runs.length && ownMotion === null && (flow ? anySelected : modalFromConverted)) {
        const first = words.find((w) => ARC_WORDS.has(w.letter.toUpperCase()));
        const at = first?.span.start ?? 0;
        const g = runs[0]?.clockwise ? 'G2' : 'G3';
        text = `${text.slice(0, at)}${g}${separator(line)}${text.slice(at)}`;
        modalFromConverted = false;
      }
      if (ownMotion !== null) modalFromConverted = false;
      out.push(text + line.eol);
      continue;
    }

    // ── Refusals for this line ──
    const before = errors.length;
    for (const t of line.tokens) {
      if (t.kind === 'assignment' || t.kind === 'argument')
        error(
          n,
          'TRANSFORM_EXPRESSION',
          "A parameter set on an arc's line can't be split across chords",
        );
      if (t.kind === 'word' && t.value?.kind === 'expression')
        error(
          n,
          'TRANSFORM_EXPRESSION',
          `${line.text.slice(t.span.start, t.span.end)} is an expression or parameter: chords can't be written from it faithfully`,
        );
    }
    for (const w of words) {
      const L = w.letter.toUpperCase();
      if (!ARC_WORDS.has(L) && !KEPT_WORDS.has(L))
        error(
          n,
          'TRANSFORM_UNSUPPORTED_WORD',
          `${L} on an arc's line moves another axis (or isn't modelled) along with the arc: chords can't carry it faithfully`,
        );
      if (L === 'M' && AFTER_MOTION_M.has(num(w) ?? -1))
        error(
          n,
          'TRANSFORM_ARC_LINE_WORDS',
          `M${num(w)} on an arc's line acts after the move, so it would run after the first chord. Put it on a line of its own`,
        );
    }
    if (runs.some((a) => a.feed.mode === 'inverse-time'))
      error(
        n,
        'TRANSFORM_INVERSE_TIME',
        "Under inverse-time feed (G93) each chord would need its own F: not supported, so it's refused",
      );
    const lineModes = [...(modes.get(n)?.values() ?? [])];
    if (lineModes.length > 1)
      error(
        n,
        'TRANSFORM_CONTROL_FLOW',
        `This arc runs in different modes on different runs (${lineModes.map(describe).join('; ')}): a subroutine called under different modes, or a block-deleted ("/") mode change before it. No one set of chords is right. Refusing`,
      );
    const { units, absolute, comp } = lineModes[0] ?? {
      units: assume,
      absolute: true,
      comp: false,
    };
    if (comp)
      error(
        n,
        'TRANSFORM_CUTTER_COMP',
        'Cutter compensation (G41/G42) is on here: the controller would offset the chords, not the arc, and short chords can stop it on an inside corner. Refusing',
      );

    // ── The chords, in this line's units and coordinates ──
    const k = units === 'inch' ? 1 / 25.4 : 1;
    const tol = tolerance * k;
    // Room for the written numbers' rounding (half a unit in the last place, on up to
    // three axes), so chord plus rounding stays within the tolerance.
    const minPlaces = Math.max(places[units], Math.ceil(-Math.log10(tol / (2 * Math.sqrt(3)))));
    const rounding = (Math.sqrt(3) / 2) * 10 ** -minPlaces;
    const sagitta = (tol - rounding) / k;
    const texts = runs.map((a) =>
      chordLines(a, line, words, {
        k,
        absolute,
        minPlaces,
        sagitta,
        motionWord: explicitArc,
      }),
    );
    const ref = texts[0] as { count: number; lines: string[] };
    if (ref.count > MAX_CHORDS_PER_ARC)
      error(
        n,
        'TRANSFORM_TOO_LARGE',
        `This arc needs ${ref.count > 1e9 ? 'too many' : ref.count.toLocaleString('en-AU')} chords at ${tolerance} mm: more than ${MAX_CHORDS_PER_ARC.toLocaleString('en-AU')}. Use a larger tolerance`,
      );
    else if (texts.some((t) => t.lines.join('\n') !== ref.lines.join('\n')))
      error(
        n,
        'TRANSFORM_CONTROL_FLOW',
        'This arc runs more than once from different places (a subroutine, a loop, or a block-deleted line before it), so no one set of chords is right. Refusing',
      );
    if (errors.length > before) {
      out.push(line.text + line.eol);
      continue;
    }

    const eol = line.eol || eolDefault;
    ref.lines.forEach((text, i) => out.push(text + (i === ref.lines.length - 1 ? line.eol : eol)));
    converted++;
    written += ref.lines.length;
    modalFromConverted = true;
    if (written > MAX_OUTPUT_LINES) {
      error(
        n,
        'TRANSFORM_TOO_LARGE',
        `The converted program would pass ${MAX_OUTPUT_LINES.toLocaleString('en-AU')} lines. Use a larger tolerance, or convert fewer arcs`,
      );
      break;
    }
  }

  if (errors.length) return { ok: false, program, diagnostics: errors };
  for (const n of skipped)
    notes.push({
      severity: 'warning',
      code: 'TRANSFORM_ARC_NOT_RUN',
      message:
        "This arc never runs as an arc in the preview (a branch not taken, after the program's end, or it has an error), so it was left as it is",
      line: n,
    });
  notes.push({
    severity: 'info',
    code: 'TRANSFORM_ARCS_CONVERTED',
    message: converted
      ? `Converted ${converted} arc${converted === 1 ? '' : 's'} into ${written.toLocaleString('en-AU')} lines, within ${tolerance} mm`
      : 'No arcs to convert',
    line: 0,
  });
  const text = (program.bom ? '﻿' : '') + out.join('');
  return { ok: true, program: converted ? parse(text) : program, diagnostics: notes };
}

/** The modes an arc line runs in: the state before it, with its own words applied. */
interface Modes {
  readonly units: Units;
  readonly absolute: boolean;
  readonly comp: boolean;
}
const key = (m: Modes) => `${m.units}|${m.absolute}|${m.comp}`;
const describe = (m: Modes) =>
  `${m.units === 'inch' ? 'inches' : 'mm'}, ${m.absolute ? 'absolute' : 'incremental'}${m.comp ? ', compensated' : ''}`;
function runModes(state: ModalState, line: Line | undefined): Modes {
  let units: Units = state.units;
  let absolute = state.distance === 'absolute';
  let comp = state.cutterCompensation !== 'off';
  for (const t of line?.tokens ?? []) {
    if (t.kind !== 'word' || t.letter !== 'G' || t.value?.kind !== 'number') continue;
    const g = t.value.value;
    if (g === 20 || g === 21) units = g === 20 ? 'inch' : 'mm';
    else if (g === 90 || g === 91) absolute = g === 90;
    else if (g === 40) comp = false;
    else if (g === 41 || g === 42 || g === 41.1 || g === 42.1) comp = true;
  }
  return { units, absolute, comp };
}

const inRange = (n: number, r: LineRange | undefined) => !r || (n >= r.from && n <= r.to);
const inBand = (r: number, band: ArcsOptions['radius']) =>
  !band || ((band.min === undefined || r >= band.min) && (band.max === undefined || r <= band.max));

/** A space between words if the line has any, else none (as "G1X10Y5"). */
function separator(line: Line): string {
  const words = line.tokens.filter((t) => t.kind === 'word');
  for (let i = 1; i < words.length; i++) {
    const gap = line.text.slice(
      (words[i - 1] as WordToken).span.end,
      (words[i] as WordToken).span.start,
    );
    if (/\s/.test(gap)) return ' ';
  }
  return words.length > 1 ? '' : ' ';
}

/**
 * One execution of an arc line, as chord lines. `k` converts mm to the line's units;
 * positions are written in its work coordinates (machine minus offset), absolute or
 * incremental as the line is.
 */
function chordLines(
  arc: Arc,
  line: Line,
  words: readonly WordToken[],
  o: {
    k: number;
    absolute: boolean;
    minPlaces: number;
    sagitta: number;
    motionWord: boolean;
  },
): { count: number; lines: string[] } {
  const count = chordsNeeded(arc, o.sagitta);
  if (!Number.isFinite(count) || count > MAX_CHORDS_PER_ARC) return { count, lines: [] };
  const [a, b, normal] = PLANE_AXES[arc.plane];
  const helical = arc.to[normal] !== arc.from[normal];
  const axes = ORDER.filter((x) => x === a || x === b || (helical && x === normal));
  const work = (p: Record<Axis3, number>, x: Axis3) => (p[x] - arc.offset[x]) * o.k;

  // The chord ends, exact; the last is the arc's own end.
  const points: Record<Axis3, number>[] = [];
  const start = startAngle(arc);
  const buf = new Float64Array(3);
  for (let i = 1; i < count; i++) {
    arcPoint(arc, start, i / count, buf, 0);
    points.push({ X: buf[0] as number, Y: buf[1] as number, Z: buf[2] as number });
  }
  points.push({ X: arc.to.X, Y: arc.to.Y, Z: arc.to.Z });

  const firstArcWord = words.find((w) => ARC_WORDS.has(w.letter.toUpperCase()));
  // Letters are upper-cased by the tokenizer: the case is the source's.
  const firstLetter = firstArcWord ? (line.text[firstArcWord.span.start] ?? 'X') : 'X';
  const lower = firstLetter !== firstLetter.toUpperCase();
  const letter = (x: Axis3) => (lower ? x.toLowerCase() : x);
  const source = (x: Axis3) => {
    const w = words.find((v) => v.letter.toUpperCase() === x) ?? firstArcWord;
    return w?.value?.kind === 'number'
      ? line.text.slice(w.value.span.start, w.value.span.end)
      : '0';
  };
  const carry: Record<Axis3, number> = { X: 0, Y: 0, Z: 0 };
  let previous: Record<Axis3, number> = { X: arc.from.X, Y: arc.from.Y, Z: arc.from.Z };
  const sep = separator(line);
  const chords = points.map((p, i) => {
    const last = i === points.length - 1;
    const parts = axes.map((x) => {
      const src = source(x);
      // The last chord in G90 ends on the line's own word, verbatim, where it has one.
      const own = words.find((v) => v.letter.toUpperCase() === x);
      if (last && o.absolute && own?.value?.kind === 'number')
        return line.text.slice(own.span.start, own.span.end);
      // Incremental: this chord's step plus the rounding carried so far.
      const value = o.absolute ? work(p, x) : (p[x] - previous[x]) * o.k + carry[x];
      // The last chord's end, on an axis the line doesn't name (a full circle's start),
      // is written exactly where it can be, so the tool ends where the arc did.
      const text = formatLike(
        value,
        src,
        last && o.absolute ? exactPlaces(value, o.minPlaces) : o.minPlaces,
      );
      if (!o.absolute) carry[x] = value - Number(text);
      return `${letter(x)}${text}`;
    });
    previous = p;
    return parts.join(sep);
  });

  // The first chord replaces the arc's words on the original line, in place of the
  // first of them; G2/G3 becomes G1 (or G1 is added, if the arc motion was modal).
  const arcWords = words.filter((w) => ARC_WORDS.has(w.letter.toUpperCase()));
  const edits: LineEdit[] = [];
  const motionWord = words.find((w) => {
    const g = num(w);
    return w.letter.toUpperCase() === 'G' && (g === 2 || g === 3);
  });
  if (motionWord?.value?.kind === 'number') edits.push({ span: motionWord.value.span, text: '1' });
  arcWords.forEach((w, i) => {
    if (i === 0) {
      const prefix = o.motionWord ? '' : `${lower ? 'g' : 'G'}1${sep}`;
      edits.push({ span: w.span, text: `${prefix}${chords[0]}` });
    } else {
      // Remove the word and the space before it.
      let s = w.span.start;
      while (s > 0 && /[ \t]/.test(line.text[s - 1] as string)) s--;
      edits.push({ span: { start: s, end: w.span.end }, text: '' });
    }
  });
  const first = editLine(line, edits).text;
  const blockDelete = line.tokens.some((t) => t.kind === 'block-delete') ? '/' : '';
  return { count, lines: [first, ...chords.slice(1).map((c) => `${blockDelete}${c}`)] };
}

/** The fewest places, from `min` up to 6, at which `v` is exact (else 6). */
function exactPlaces(v: number, min: number): number {
  for (let p = min; p < 6; p++)
    if (Math.abs(Math.round(v * 10 ** p) / 10 ** p - v) <= 1e-9 * Math.max(1, Math.abs(v)))
      return p;
  return 6;
}
