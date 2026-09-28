// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { GENERIC, type Dialect } from '../dialect/profiles.js';
import { editLine, parse, write, type LineEdit } from '../syntax/program.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatLike, MAX_WRITTEN, writable } from './format.js';
import { invalidOp, mapOf, type TransformOp } from './map.js';

/**
 * Transforms (parcel 4a, ADR-0033): translate, rotate, mirror and scale a program by
 * editing its words in place. Every line the transform doesn't need to change stays
 * byte-for-byte as it was, and so do the parts of changed lines it doesn't touch:
 * comments, spacing, letter case, line numbers and line endings.
 *
 * A transform that can't be done faithfully is REFUSED, not approximated: the result
 * is the original program, with errors naming each line that stopped it. Warnings
 * report what was deliberately left alone (G53 and G10 lines, home positions) and what
 * a correct transform still changes about the job (a mirror reverses the cutting
 * direction).
 */
export interface TransformOptions {
  /** The controller the program is for: its canned-cycle repeat letter matters. */
  readonly dialect?: Dialect;
}

export interface TransformResult {
  /** The transformed program, or the original if `ok` is false. */
  readonly program: Program;
  readonly diagnostics: readonly Diagnostic[];
  /** Lines whose text differs from the original. */
  readonly changedLines: number;
  readonly ok: boolean;
}

/** Applies `ops` in order. Lengths in ops are millimetres. */
export function transform(
  program: Program,
  ops: readonly TransformOp[],
  options: TransformOptions = {},
): TransformResult {
  const dialect = options.dialect ?? GENERIC;
  const diagnostics: Diagnostic[] = [];
  let current = program;
  for (const op of ops) {
    const bad = invalidOp(op);
    if (bad) {
      diagnostics.push({
        severity: 'error',
        code: 'TRANSFORM_BAD_OP',
        message: `Can't ${op.op}: ${bad}`,
        line: 0,
      });
      return { program, diagnostics, changedLines: 0, ok: false };
    }
    const r = applyOne(current, op, dialect);
    diagnostics.push(...r.diagnostics);
    if (!r.ok) return { program, diagnostics, changedLines: 0, ok: false };
    current = r.program;
  }
  let changedLines = 0;
  for (let i = 0; i < program.lines.length; i++)
    if (program.lines[i]?.text !== current.lines[i]?.text) changedLines++;
  return { program: current, diagnostics, changedLines, ok: true };
}

/** Convenience: transform text, returning text. */
export function transformText(
  source: string,
  ops: readonly TransformOp[],
  options: TransformOptions = {},
): { readonly text: string } & Omit<TransformResult, 'program'> {
  const r = transform(parse(source), ops, options);
  return {
    text: write(r.program),
    diagnostics: r.diagnostics,
    changedLines: r.changedLines,
    ok: r.ok,
  };
}

// ── One op ──────────────────────────────────────────────────────────────────

type Plane = 'XY' | 'ZX' | 'YZ';
type Axis = 'X' | 'Y' | 'Z';

/**
 * The G codes whose words this transform models (review of toolkit #33). Any other G
 * code refuses the op: an unmodelled code's words would be treated as a plain move,
 * which is exactly how a transform goes silently wrong (G68's angle, G5 spline
 * vectors, G43.1's offset, G87's I/J/K, G52's offset…).
 */
const MODELLED_G = new Set([
  0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 28.1, 30, 30.1, 40, 41, 41.1, 42, 42.1, 43, 49, 53, 54,
  55, 56, 57, 58, 59, 59.1, 59.2, 59.3, 61, 61.1, 64, 73, 80, 81, 82, 83, 84, 85, 86, 89, 90, 90.1,
  91, 91.1, 93, 94, 95, 96, 97, 98, 99,
]);
const MOTION = new Set([0, 1, 2, 3, 73, 80, 81, 82, 83, 84, 85, 86, 89]);
const CYCLES = new Set([73, 81, 82, 83, 84, 85, 86, 89]);

interface Findings {
  errors: Diagnostic[];
  /** One warning per code, with the first line and a count. */
  warnings: Map<string, { line: number; count: number; message: string }>;
}

function applyOne(program: Program, op: TransformOp, dialect: Dialect) {
  const m = mapOf(op);
  const det = m.a * m.d - m.b * m.c;
  const diag = m.b === 0 && m.c === 0; // each axis maps to itself
  const identityXY = diag && m.a === 1 && m.d === 1 && m.tx === 0 && m.ty === 0;
  const identityZ = m.sz === 1 && m.tz === 0;
  const f: Findings = { errors: [], warnings: new Map() };
  const error = (line: number, code: string, message: string) => {
    if (f.errors.length < 200) f.errors.push({ severity: 'error', code, message, line });
  };
  const warn = (line: number, code: string, message: string) => {
    const w = f.warnings.get(code);
    if (w) w.count++;
    else f.warnings.set(code, { line, count: 1, message });
  };
  /** Whether the op changes an axis's coordinates (X and Y rotate together). */
  const touches = (axis: Axis) => (axis === 'Z' ? !identityZ : !identityXY);

  // Modal state, as the program sets it (LinuxCNC defaults).
  let absolute = true; // G90 / G91
  let arcAbsolute = false; // G90.1 / G91.1
  let plane: Plane = 'XY';
  let inch = false; // G20 / G21
  let motion: number | null = null;
  /** Whether the G2/G3 word now in force was flipped (null: none seen yet). */
  let arcWordFlipped: boolean | null = null;
  /** The ORIGINAL commanded X/Y before each line, in mm; null where unknown. */
  const cur: Record<Axis, number | null> = { X: null, Y: null, Z: null };
  /**
   * Axes whose position was last set by a line the transform leaves as written
   * (G53, G28, G30: machine positions). Until the program commands them again in
   * absolute terms, the tool there is NOT where the transformed program would put it,
   * so a move while such an axis is one the op changes is refused.
   */
  const untransformed = new Set<Axis>();
  /**
   * Rounding carried between incremental words, per OUTPUT axis, in mm: what the
   * exact transformed moves total minus what the written ones do. Each incremental
   * word absorbs it, so 10,000 small steps don't drift (review of toolkit #33).
   */
  const carry: Record<Axis, number> = { X: 0, Y: 0, Z: 0 };
  let sawAbsoluteXY = false;
  const repeatLetter = dialect.interpreter.cycleRepeat.letter;

  const flipFor = (p: Plane) => (p === 'XY' ? det < 0 : p === 'ZX' ? m.a < 0 : m.d < 0);

  const lines: Line[] = [];
  for (const line of program.lines) {
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    const edits: LineEdit[] = [];
    const n = line.lineNo;
    const num = (w: WordToken | undefined) => (w?.value?.kind === 'number' ? w.value.value : null);
    const first = (letter: string) => words.find((w) => w.letter === letter);

    // Control flow: a line may run many times, in another order, or in another file.
    // Transforming the text in order is then wrong for EVERY op (review of #33).
    for (const t of line.tokens)
      if (t.kind === 'oword' && t.keyword !== null)
        error(
          n,
          'TRANSFORM_CONTROL_FLOW',
          `O-word ${t.keyword}: subroutines, calls and loops run lines out of order (or from other files), so this program can't be transformed line by line`,
        );
    for (const w of words)
      if (w.letter === 'M' && (num(w) === 98 || num(w) === 99))
        error(
          n,
          'TRANSFORM_CONTROL_FLOW',
          `M${num(w)}: a subprogram call runs lines from elsewhere, which this transform can't follow`,
        );

    // Modal and one-shot codes on this line take effect before its motion.
    let ownMotion: number | null = null;
    let skip: 'G10' | 'machine' | 'home' | 'set' | null = null;
    for (const w of words) {
      if (w.letter !== 'G') continue;
      const g = num(w);
      if (g === null) {
        error(
          n,
          'TRANSFORM_EXPRESSION',
          `${line.text.slice(w.span.start, w.span.end)}: a G code written as an expression can't be checked, so the transform stopped here`,
        );
        continue;
      }
      if (!MODELLED_G.has(g)) {
        const shifts = g === 52 || (g >= 92 && g < 93);
        error(
          n,
          shifts ? 'TRANSFORM_OFFSET' : 'TRANSFORM_UNSUPPORTED_CODE',
          shifts
            ? `G${g} shifts the coordinate system inside the program: transforming around it would be wrong. Remove it, or set the offset on the machine`
            : `G${g} isn't one the transform models, so its words might not be plain coordinates: transforming around it would be wrong`,
        );
        continue;
      }
      if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 90.1) arcAbsolute = true;
      else if (g === 91.1) arcAbsolute = false;
      else if (g === 17) plane = 'XY';
      else if (g === 18) plane = 'ZX';
      else if (g === 19) plane = 'YZ';
      else if (g === 20 || g === 21) {
        const nowInch = g === 20;
        if (nowInch !== inch) inch = nowInch;
      } else if (g === 10) skip = 'G10';
      else if (g === 53) skip = 'machine';
      else if (g === 28 || g === 30) skip = 'home';
      else if (g === 28.1 || g === 30.1) skip = 'set';
      else if (MOTION.has(g)) ownMotion = g;
    }
    if (ownMotion !== null) motion = ownMotion;
    const unit = inch ? 25.4 : 1;
    const minDecimals = inch ? 4 : 3;
    const tx = m.tx / unit;
    const ty = m.ty / unit;
    const tz = m.tz / unit;

    const X = first('X');
    const Y = first('Y');
    const Z = first('Z');
    const hasAxes = !!(X || Y || Z);
    const axisWords: [Axis, WordToken | undefined][] = [
      ['X', X],
      ['Y', Y],
      ['Z', Z],
    ];

    // A repeated coordinate word ("X0 X1") is an error to the controller, which
    // rejects the line: which one would the transform change? Fix the line first.
    if (!identityXY || !identityZ) {
      const seen = new Set<string>();
      for (const w of words) {
        if (!'XYZIJKRQ'.includes(w.letter)) continue;
        if (seen.has(w.letter)) {
          error(
            n,
            'TRANSFORM_REPEATED_WORD',
            `This line gives ${w.letter} more than once, which the controller rejects: fix the line before transforming`,
          );
          break;
        }
        seen.add(w.letter);
      }
    }

    if (skip === 'G10') {
      const L = num(first('L'));
      if (L === 20 && dialect.interpreter.g10 !== 'masso')
        error(
          n,
          'TRANSFORM_UNSUPPORTED_CODE',
          'G10 L20 sets a work offset so the CURRENT position reads as the given values: that depends on where the untransformed program has the tool, so the transform stopped here',
        );
      else if (hasAxes)
        warn(
          n,
          'TRANSFORM_G10',
          'G10 sets offsets in machine terms: its axis words were left as they are',
        );
      lines.push(line);
      continue;
    }
    if (skip === 'machine' || skip === 'home') {
      // Machine positions (G53) and homes (G28/G30, and their intermediate points) are
      // left as written: a transform can't move the machine's home, and renaming a
      // homed axis (a quarter turn's X → Y) would home the wrong one. Each axis they
      // move is now somewhere the transformed program doesn't expect.
      const moved: Axis[] =
        skip === 'home' && !hasAxes
          ? ['X', 'Y', 'Z']
          : axisWords.filter(([, w]) => w).map(([a]) => a);
      for (const a of moved) {
        untransformed.add(a);
        cur[a] = null;
      }
      if (moved.some(touches))
        warn(
          n,
          skip === 'machine' ? 'TRANSFORM_G53' : 'TRANSFORM_HOME',
          skip === 'machine'
            ? 'G53 moves are in machine coordinates: left as written; they still go to the same machine position'
            : "G28/G30 go to the machine's home positions: left as written, intermediate points included",
        );
      lines.push(line);
      continue;
    }
    if (skip === 'set') {
      lines.push(line);
      continue;
    }

    if (!identityXY && words.some((w) => w.letter === 'A' || w.letter === 'B' || w.letter === 'C'))
      warn(
        n,
        'TRANSFORM_ROTARY',
        'Rotary axis words (A/B/C) were left as they are: this transform is of X, Y and Z only',
      );

    // ── Words, by role ──
    const arc =
      (motion === 2 || motion === 3) && (hasAxes || words.some((w) => 'IJKR'.includes(w.letter)));
    const cycle = motion !== null && CYCLES.has(motion) && hasAxes;
    const moves = hasAxes || arc;
    const repeat = cycle ? first(repeatLetter) : undefined;
    // A repeated cycle in G91 steps by its increment each time only where the
    // controller does (LinuxCNC L). Masso's K repeats in place (review of #33).
    const steps = dialect.interpreter.cycleRepeat.stepInIncremental;
    const reps =
      cycle && !absolute && steps && repeat ? Math.max(1, Math.round(num(repeat) ?? 1)) : 1;

    // A move while an axis the op changes sits at an untransformed machine position.
    if (moves) {
      // An absolute word states where the tool goes, except a canned cycle's Z: that's
      // the hole's bottom, and the cycle rapids across at (and may return to) the
      // height it started from.
      const recommanded = absolute
        ? new Set(axisWords.filter(([a, w]) => w && !(cycle && a === 'Z')).map(([a]) => a))
        : new Set<Axis>();
      const stale = [...untransformed].filter((a) => !recommanded.has(a) && touches(a));
      // The usual tool-change pattern: a machine or home retract in Z only, then rapids
      // to the next position. A rapid with no Z word travels at that retract height in
      // BOTH programs, which is physically what's intended, so it's allowed (review of
      // #33). A feed move, a cycle, or any Z word before Z is given again absolutely is
      // still refused: it would cut, or step from, a height the map doesn't account for.
      const retractTravel =
        stale.length === 1 && stale[0] === 'Z' && motion === 0 && !arc && !cycle && !Z;
      if (retractTravel)
        warn(
          n,
          'TRANSFORM_RETRACT_TRAVEL',
          'Rapids after a machine-coordinate or home Z retract travel at that retract height, which the Z translation or scale leaves where it is. The first absolute Z after it is transformed',
        );
      // X and Y move together under a rotation: a re-commanded X with a stale Y is stale.
      else if (stale.length)
        error(
          n,
          'TRANSFORM_UNKNOWN_POSITION',
          `${stale.join('/')} was last set by a machine-coordinate or home move (left as written), so this move would start from a position the transform can't account for. Give ${stale.join(' and ')} explicitly (in G90) first`,
        );
      for (const a of recommanded) untransformed.delete(a);
    }

    /**
     * Rewrites `w` as `letter` (same case) with `value`, if either changed. `like` is
     * the word the value came from, whose decimals it keeps. `carryAxis` marks an
     * incremental word: it absorbs the rounding carried on that output axis (× `times`
     * for a repeated cycle), and passes on its own.
     */
    const rewrite = (
      w: WordToken,
      letter: string,
      value: number,
      like: WordToken = w,
      carryAxis?: Axis,
      times = 1,
    ) => {
      if (w.value?.kind !== 'number' || like.value?.kind !== 'number') return;
      const target = carryAxis ? value + carry[carryAxis] / unit / times : value;
      if (!inRange(letter, target)) return;
      const old = w.value.value;
      const src = line.text.slice(w.value.span.start, w.value.span.end);
      let written = old;
      if (!(letter === w.letter && Math.abs(target - old) <= 1e-12 * Math.max(1, Math.abs(old)))) {
        const text = formatLike(
          target,
          line.text.slice(like.value.span.start, like.value.span.end),
          minDecimals,
        );
        written = Number(text);
        if (letter !== w.letter) {
          const own = line.text[w.span.start] ?? letter;
          edits.push({
            span: { start: w.span.start, end: w.span.start + 1 },
            text: own === own.toLowerCase() ? letter.toLowerCase() : letter,
          });
        }
        if (text !== src) edits.push({ span: w.value.span, text });
      }
      if (carryAxis) carry[carryAxis] = (target - written) * unit * times;
    };
    /** Refuses a result no controller could read: non-finite, or past MAX_WRITTEN. */
    const inRange = (letter: string, v: number): boolean => {
      if (writable(v)) return true;
      error(
        n,
        'TRANSFORM_OUT_OF_RANGE',
        `${letter} would be ${Number.isFinite(v) ? String(v) : 'infinite'}: beyond ±${MAX_WRITTEN.toLocaleString('en-AU')}, no machine goes there and no controller reads it. Refusing`,
      );
      return false;
    };
    /** A coordinate word written as an expression can't be rewritten (decision 2). */
    const needsNumber = (w: WordToken | undefined, changes: boolean): boolean => {
      if (!w || !changes || w.value?.kind !== 'expression') return true;
      error(
        n,
        'TRANSFORM_EXPRESSION',
        `${line.text.slice(w.span.start, w.span.end)} is an expression or parameter: a transform can't rewrite it faithfully, so it stopped here`,
      );
      return false;
    };
    /** Inserts a missing word after `after`, spaced like it. */
    const insert = (
      after: WordToken,
      letter: string,
      value: number,
      carryAxis?: Axis,
      times = 1,
    ) => {
      const sep = after.value ? line.text.slice(after.span.start + 1, after.value.span.start) : '';
      const own = line.text[after.span.start] ?? letter;
      const l = own === own.toLowerCase() ? letter.toLowerCase() : letter;
      const target = carryAxis ? value + carry[carryAxis] / unit / times : value;
      if (!inRange(letter, target)) return;
      const text = formatLike(
        target,
        after.value ? line.text.slice(after.value.span.start, after.value.span.end) : '',
        minDecimals,
      );
      if (carryAxis) carry[carryAxis] = (target - Number(text)) * unit * times;
      edits.push({
        span: { start: after.span.end, end: after.span.end },
        text: ` ${l}${sep}${text}`,
      });
    };

    /**
     * An X/Y (or I/J) pair: a point (translation applies) or a vector (it doesn't). An
     * absent component of a VECTOR is 0; of a point, it's the current position (only
     * a general rotation needs it). `axes` marks the pair as axis words, whose
     * incremental values carry rounding.
     */
    const pair = (
      wx: WordToken | undefined,
      wy: WordToken | undefined,
      lx: string,
      ly: string,
      point: boolean,
      axes: boolean,
    ) => {
      if (!wx && !wy) return;
      const ox = point ? tx : 0;
      const oy = point ? ty : 0;
      const carryX: Axis | undefined = axes && !point ? 'X' : undefined;
      const carryY: Axis | undefined = axes && !point ? 'Y' : undefined;
      // An absolute word written on an output axis resets that axis's carried rounding
      // (it states the position outright). Which output axes get written: under a
      // quarter turn X feeds Y', and a general rotation writes both.
      if (axes && point) {
        const out = new Set<Axis>();
        if (!m.axisAligned) {
          out.add('X');
          out.add('Y');
        } else if (diag) {
          if (wx) out.add('X');
          if (wy) out.add('Y');
        } else {
          if (wx) out.add('Y');
          if (wy) out.add('X');
        }
        for (const a of out) carry[a] = 0;
      }
      if (m.axisAligned) {
        if (diag) {
          if (wx && needsNumber(wx, !(m.a === 1 && ox === 0)) && num(wx) !== null)
            rewrite(wx, lx, m.a * (num(wx) as number) + ox, wx, carryX, reps);
          if (wy && needsNumber(wy, !(m.d === 1 && oy === 0)) && num(wy) !== null)
            rewrite(wy, ly, m.d * (num(wy) as number) + oy, wy, carryY, reps);
          return;
        }
        // A quarter turn: X feeds Y' and Y feeds X'.
        if (!needsNumber(wx, true) || !needsNumber(wy, true)) return;
        const x = num(wx);
        const y = num(wy);
        if (wx && wy && x !== null && y !== null) {
          // Both written: keep each letter where it is and swap the values between
          // them (X-8 Y98, not Y98 X-8), each keeping the decimals it came with.
          rewrite(wx, lx, m.b * y + ox, wy, carryX, reps);
          rewrite(wy, ly, m.c * x + oy, wx, carryY, reps);
        } else if (wx && x !== null) rewrite(wx, ly, m.c * x + oy, wx, carryY, reps);
        else if (wy && y !== null) rewrite(wy, lx, m.b * y + ox, wy, carryX, reps);
        return;
      }
      // A general rotation: both components, whichever is written.
      if (!needsNumber(wx, true) || !needsNumber(wy, true)) return;
      const missing = (axis: 'X' | 'Y'): number | null => {
        if (!point) return 0; // an absent incremental component didn't move
        if (!axes) return arcAbsolute ? null : 0;
        const v = cur[axis];
        return v === null ? null : v / unit;
      };
      const x = wx ? num(wx) : missing('X');
      const y = wy ? num(wy) : missing('Y');
      if (x === null || y === null) {
        const which = x === null ? lx : ly;
        error(
          n,
          'TRANSFORM_UNKNOWN_POSITION',
          `The ${which} this line starts from isn't known here (no earlier ${which}, or after a machine-coordinate or home move), so it can't be rotated. Give it explicitly`,
        );
        return;
      }
      const nx = m.a * x + m.b * y + ox;
      const ny = m.c * x + m.d * y + oy;
      if (wx) rewrite(wx, lx, nx, wx, carryX, reps);
      if (wy) rewrite(wy, ly, ny, wy, carryY, reps);
      if (!wx && wy) insert(wy, lx, nx, carryX, reps);
      if (wx && !wy) insert(wx, ly, ny, carryY, reps);
    };
    const zWord = (w: WordToken | undefined, point: boolean) => {
      if (!w) return;
      const oz = point ? tz : 0;
      if (point) carry.Z = 0;
      if (needsNumber(w, !(m.sz === 1 && oz === 0)) && num(w) !== null)
        rewrite(w, 'Z', m.sz * (num(w) as number) + oz, w, point ? undefined : 'Z', reps);
    };

    // A program that moves incrementally before it gives any absolute X/Y is placed by
    // wherever the machine starts: say so, since translating can't move that part.
    if ((X || Y) && !identityXY) {
      if (absolute) sawAbsoluteXY = true;
      else if (!sawAbsoluteXY)
        warn(
          n,
          'TRANSFORM_RELATIVE_START',
          "This program moves incrementally (G91) before it gives an absolute X/Y: that part is placed relative to where the machine starts, so it rotates, mirrors and scales about that point, and a translation doesn't move it",
        );
    }

    // Axis words.
    pair(X, Y, 'X', 'Y', absolute, true);
    zWord(Z, absolute);

    // Arcs: centre words per plane, R, and the direction words.
    if (arc) {
      // An arc stays a circle only if its plane is scaled evenly: a rotation-scale
      // (a = d, b = -c) or a reflection-scale (a = -d, b = c) in XY; |a| (X) or |d| (Y)
      // equal to the Z scale in ZX or YZ.
      const eq = (p: number, q: number) =>
        Math.abs(p - q) <= 1e-12 * Math.max(1, Math.abs(p), Math.abs(q));
      const similar =
        plane === 'XY'
          ? (eq(m.a, m.d) && eq(m.b, -m.c)) || (eq(m.a, -m.d) && eq(m.b, m.c))
          : plane === 'ZX'
            ? eq(Math.abs(m.a), m.sz)
            : eq(Math.abs(m.d), m.sz);
      if (plane !== 'XY' && !m.axisAligned)
        error(
          n,
          'TRANSFORM_PLANE_ARC',
          `This arc is in the ${plane} plane: rotating by an angle other than 0° or 180° would move it out of its plane`,
        );
      else if (plane !== 'XY' && !diag)
        error(
          n,
          'TRANSFORM_PLANE_ARC',
          `This arc is in the ${plane} plane: a quarter turn would move it into another plane`,
        );
      else if (!similar)
        error(
          n,
          'TRANSFORM_ARC_SCALE',
          "Scaling an arc unevenly would make it an ellipse, which G-code arcs can't be: convert arcs to lines first, or scale evenly",
        );
      else {
        const I = first('I');
        const J = first('J');
        const K = first('K');
        const zCentre = (w: WordToken | undefined) => {
          const oz = arcAbsolute ? tz : 0;
          if (w && needsNumber(w, !(m.sz === 1 && oz === 0)) && num(w) !== null)
            rewrite(w, 'K', m.sz * (num(w) as number) + oz);
        };
        if (plane === 'XY') pair(I, J, 'I', 'J', arcAbsolute, false);
        else if (plane === 'ZX') {
          // I is along X, K along Z.
          if (I && needsNumber(I, !(m.a === 1 && (!arcAbsolute || tx === 0))) && num(I) !== null)
            rewrite(I, 'I', m.a * (num(I) as number) + (arcAbsolute ? tx : 0));
          zCentre(K);
        } else {
          if (J && needsNumber(J, !(m.d === 1 && (!arcAbsolute || ty === 0))) && num(J) !== null)
            rewrite(J, 'J', m.d * (num(J) as number) + (arcAbsolute ? ty : 0));
          zCentre(K);
        }
        const R = first('R');
        const k = plane === 'XY' ? Math.sqrt(Math.abs(det)) : m.sz;
        if (R && needsNumber(R, k !== 1) && num(R) !== null)
          rewrite(R, 'R', k * (num(R) as number));
      }
    }
    // The arc direction: flip each G2/G3 where the plane's orientation reverses.
    for (const w of words) {
      const g = w.letter === 'G' ? num(w) : null;
      if ((g === 2 || g === 3) && w.value?.kind === 'number') {
        const flip = flipFor(plane);
        arcWordFlipped = flip;
        if (flip) {
          const src = line.text.slice(w.value.span.start, w.value.span.end);
          edits.push({
            span: w.value.span,
            text: src.replace(/[23](?=(\.0*)?$)/, g === 2 ? '3' : '2'),
          });
        }
      }
      // Cutter compensation swaps sides in a mirror image.
      if (
        det < 0 &&
        (g === 41 || g === 42 || g === 41.1 || g === 42.1) &&
        w.value?.kind === 'number'
      ) {
        const src = line.text.slice(w.value.span.start, w.value.span.end);
        edits.push({
          span: w.value.span,
          text: src.replace(/4([12])/, (_, s: string) => `4${s === '1' ? '2' : '1'}`),
        });
      }
    }
    if (
      arc &&
      ownMotion !== 2 &&
      ownMotion !== 3 &&
      arcWordFlipped !== null &&
      arcWordFlipped !== flipFor(plane)
    )
      error(
        n,
        'TRANSFORM_ARC_DIRECTION_MODAL',
        'This arc takes its G2/G3 from an earlier line in another plane, and the two need different handling: add an explicit G2 or G3 here',
      );

    // Canned cycles: R is the retract height (a Z), Q the peck depth (a Z length).
    if (cycle) {
      const R = first('R');
      const Q = first('Q');
      if (R) {
        const oz = absolute ? tz : 0;
        if (needsNumber(R, !(m.sz === 1 && oz === 0)) && num(R) !== null)
          rewrite(R, 'R', m.sz * (num(R) as number) + oz);
      }
      if (Q && needsNumber(Q, m.sz !== 1) && num(Q) !== null)
        rewrite(Q, 'Q', m.sz * (num(Q) as number));
    }

    // Track the ORIGINAL commanded position (mm), for a general rotation's missing words.
    for (const [a, w] of axisWords) {
      const v = num(w);
      if (v === null) continue;
      cur[a] = absolute ? v * unit : cur[a] === null ? null : (cur[a] as number) + reps * v * unit;
    }

    lines.push(edits.length ? editLine(line, dedupe(edits)) : line);
  }

  const diagnostics: Diagnostic[] = [...f.errors];
  if (det < 0 && program.lines.length)
    diagnostics.push({
      severity: 'warning',
      code: 'TRANSFORM_MIRROR_DIRECTION',
      message:
        'A mirror image reverses the cutting direction: climb milling becomes conventional, and conventional becomes climb. Check the finish and the tool load before running it',
      line: 0,
    });
  for (const [code, w] of f.warnings)
    diagnostics.push({
      severity: 'warning',
      code,
      message: w.count > 1 ? `${w.message} (${w.count} lines)` : w.message,
      line: w.line,
    });
  if (f.errors.length) return { ok: false as const, program, diagnostics };
  return {
    ok: true as const,
    program: { ...program, lines, diagnostics: lines.flatMap((l) => l.diagnostics) },
    diagnostics,
  };
}

/** Drops exact duplicate edits (a word touched twice by overlapping roles). */
function dedupe(edits: LineEdit[]): LineEdit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    const k = `${e.span.start}:${e.span.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
