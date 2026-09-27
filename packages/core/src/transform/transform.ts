// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { GENERIC, type Dialect } from '../dialect/profiles.js';
import { editLine, parse, write, type LineEdit } from '../syntax/program.js';
import type { Diagnostic, Line, Program, WordToken } from '../syntax/types.js';
import { formatLike } from './format.js';
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
const MOTION = new Set([
  0, 1, 2, 3, 38.2, 38.3, 38.4, 38.5, 73, 76, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
]);
const CYCLES = new Set([73, 81, 82, 83, 84, 85, 86, 87, 88, 89]);

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
  const f: Findings = { errors: [], warnings: new Map() };
  const error = (line: number, code: string, message: string) => {
    if (f.errors.length < 200) f.errors.push({ severity: 'error', code, message, line });
  };
  const warn = (line: number, code: string, message: string) => {
    const w = f.warnings.get(code);
    if (w) w.count++;
    else f.warnings.set(code, { line, count: 1, message });
  };

  // Modal state, as the program sets it (LinuxCNC defaults).
  let absolute = true; // G90 / G91
  let arcAbsolute = false; // G90.1 / G91.1
  let plane: Plane = 'XY';
  let inch = false; // G20 / G21
  let motion: number | null = null;
  /** Whether the G2/G3 word now in force was flipped (null: none seen yet). */
  let arcWordFlipped: boolean | null = null;
  /** Commanded X/Y before each line, in mm (only tracked for a general rotation). */
  let cur: { X: number | null; Y: number | null } = { X: null, Y: null };
  let sawAbsoluteXY = false;
  const repeatLetter = dialect.interpreter.cycleRepeat.letter;

  const flipFor = (p: Plane) => (p === 'XY' ? det < 0 : p === 'ZX' ? m.a < 0 : m.d < 0);

  const lines: Line[] = [];
  for (const line of program.lines) {
    const words = line.tokens.filter((t): t is WordToken => t.kind === 'word');
    const edits: LineEdit[] = [];
    const n = line.lineNo;
    const num = (w: WordToken) => (w.value?.kind === 'number' ? w.value.value : null);
    const gs = words.filter((w) => w.letter === 'G').map(num);

    if (!m.axisAligned && line.tokens.some((t) => t.kind === 'oword'))
      error(
        n,
        'TRANSFORM_CONTROL_FLOW',
        'A rotation by an angle other than a multiple of 90° needs the position before every line, which O-word subroutines and loops make unknowable',
      );
    if (!m.axisAligned && words.some((w) => w.letter === 'M' && num(w) === 98))
      error(
        n,
        'TRANSFORM_CONTROL_FLOW',
        'A rotation by an angle other than a multiple of 90° needs the position before every line, which an M98 subprogram call makes unknowable',
      );

    // Modal and one-shot codes on this line take effect before its motion.
    let ownMotion: number | null = null;
    let skip: 'G10' | 'G53' | 'set' | null = null;
    let home = false;
    for (const g of gs) {
      if (g === null) continue;
      if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 90.1) arcAbsolute = true;
      else if (g === 91.1) arcAbsolute = false;
      else if (g === 17) plane = 'XY';
      else if (g === 18) plane = 'ZX';
      else if (g === 19) plane = 'YZ';
      else if (g === 20) inch = true;
      else if (g === 21) inch = false;
      else if (g === 10) skip = 'G10';
      else if (g === 53) skip = 'G53';
      else if (g === 28.1 || g === 30.1) skip = 'set';
      else if (g === 28 || g === 30) home = true;
      else if (g === 92 || g === 92.1 || g === 92.2 || g === 92.3)
        error(
          n,
          'TRANSFORM_G92',
          `G${g} shifts the coordinate system inside the program: transforming around it would be wrong. Remove it, or set the offset on the machine`,
        );
      else if (MOTION.has(g)) ownMotion = g;
    }
    if (ownMotion !== null) motion = ownMotion;
    const unit = inch ? 25.4 : 1;
    const minDecimals = inch ? 4 : 3;
    const tx = m.tx / unit;
    const ty = m.ty / unit;
    const tz = m.tz / unit;

    const first = (letter: string) => words.find((w) => w.letter === letter);
    const X = first('X');
    const Y = first('Y');
    const Z = first('Z');
    const hasAxes = !!(X || Y || Z);

    // A repeated coordinate word ("X0 X1") is an error to the controller, which
    // rejects the line: which one would the transform change? Fix the line first.
    if (!identityXY || m.sz !== 1 || m.tz !== 0) {
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
      if (hasAxes)
        warn(
          n,
          'TRANSFORM_G10',
          'G10 sets offsets in machine terms: its axis words were left as they are',
        );
      lines.push(line);
      continue;
    }
    if (skip === 'G53') {
      if (hasAxes)
        warn(
          n,
          'TRANSFORM_G53',
          'G53 moves are in machine coordinates: they were left as they are, and still go to the same machine position',
        );
      cur = { X: null, Y: null };
      lines.push(line);
      continue;
    }
    if (skip === 'set') {
      lines.push(line);
      continue;
    }
    if (home && hasAxes && !identityXY)
      warn(
        n,
        'TRANSFORM_HOME',
        "G28/G30: the intermediate points were transformed; the home positions themselves are the machine's and did not move",
      );

    if (!identityXY && words.some((w) => w.letter === 'A' || w.letter === 'B' || w.letter === 'C'))
      warn(
        n,
        'TRANSFORM_ROTARY',
        'Rotary axis words (A/B/C) were left as they are: this transform is of X, Y and Z only',
      );

    // ── Words, by role ──
    // An arc runs on a G2/G3 line with axis words, or with only a centre or radius: a
    // full circle ("G2 I5") has no axis words at all, and its centre still transforms.
    const arc =
      !home &&
      (motion === 2 || motion === 3) &&
      (hasAxes || words.some((w) => 'IJKR'.includes(w.letter)));
    const cycle = !home && motion !== null && CYCLES.has(motion);

    /** Rewrites `w` as `letter` (same case) with `value`, if either changed. */
    /**
     * Rewrites `w` as `letter` (same case) with `value`, if either changed. `like` is
     * the word the value came from, whose decimals it keeps (default `w` itself).
     */
    const rewrite = (w: WordToken, letter: string, value: number, like: WordToken = w) => {
      if (w.value?.kind !== 'number' || like.value?.kind !== 'number') return;
      // Unchanged (same letter, same value): leave it exactly as written, "-0.0000"
      // and all. A transform touches only what it changes.
      const old = w.value.value;
      if (letter === w.letter && Math.abs(value - old) <= 1e-12 * Math.max(1, Math.abs(old)))
        return;
      const src = line.text.slice(w.value.span.start, w.value.span.end);
      const text = formatLike(
        value,
        line.text.slice(like.value.span.start, like.value.span.end),
        minDecimals,
      );
      if (letter !== w.letter) {
        const own = line.text[w.span.start] ?? letter;
        edits.push({
          span: { start: w.span.start, end: w.span.start + 1 },
          text: own === own.toLowerCase() ? letter.toLowerCase() : letter,
        });
      }
      if (text !== src) edits.push({ span: w.value.span, text });
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
    const insert = (after: WordToken, letter: string, value: number) => {
      const sep = after.value ? line.text.slice(after.span.start + 1, after.value.span.start) : '';
      const own = line.text[after.span.start] ?? letter;
      const l = own === own.toLowerCase() ? letter.toLowerCase() : letter;
      edits.push({
        span: { start: after.span.end, end: after.span.end },
        text: ` ${l}${sep}${formatLike(value, after.value ? line.text.slice(after.value.span.start, after.value.span.end) : '', minDecimals)}`,
      });
    };

    /**
     * An X/Y pair: a point (translation applies) or a vector (it doesn't). `missing`
     * gives an absent component's value, for a general rotation; null if unknown.
     */
    const pair = (
      wx: WordToken | undefined,
      wy: WordToken | undefined,
      lx: string,
      ly: string,
      point: boolean,
      missing: (axis: 'x' | 'y') => number | null,
    ) => {
      if (!wx && !wy) return;
      const ox = point ? tx : 0;
      const oy = point ? ty : 0;
      if (m.axisAligned) {
        if (diag) {
          if (wx && needsNumber(wx, !(m.a === 1 && ox === 0)) && num(wx) !== null)
            rewrite(wx, lx, m.a * (num(wx) as number) + ox);
          if (wy && needsNumber(wy, !(m.d === 1 && oy === 0)) && num(wy) !== null)
            rewrite(wy, ly, m.d * (num(wy) as number) + oy);
        } else {
          // A quarter turn: X feeds Y' and Y feeds X'.
          if (!needsNumber(wx, true) || !needsNumber(wy, true)) return;
          const x = wx ? num(wx) : null;
          const y = wy ? num(wy) : null;
          if (wx && wy && x !== null && y !== null) {
            // Both written: keep each letter where it is and swap the values between
            // them (X-8 Y98, not Y98 X-8), each keeping the decimals it came with.
            rewrite(wx, lx, m.b * y + ox, wy);
            rewrite(wy, ly, m.c * x + oy, wx);
          } else if (wx && x !== null) rewrite(wx, ly, m.c * x + oy);
          else if (wy && y !== null) rewrite(wy, lx, m.b * y + ox);
        }
        return;
      }
      // A general rotation: both components, whichever is written.
      if (!needsNumber(wx, true) || !needsNumber(wy, true)) return;
      const x = wx ? num(wx) : missing('x');
      const y = wy ? num(wy) : missing('y');
      if (x === null || y === null) {
        error(
          n,
          'TRANSFORM_UNKNOWN_POSITION',
          `The ${x === null ? lx : ly} this line starts from isn't known here (no earlier ${x === null ? lx : ly}, or after a machine-coordinate or home move), so it can't be rotated. Give it explicitly`,
        );
        return;
      }
      const nx = m.a * x + m.b * y + ox;
      const ny = m.c * x + m.d * y + oy;
      if (wx) rewrite(wx, lx, nx);
      if (wy) rewrite(wy, ly, ny);
      if (!wx && wy) insert(wy, lx, nx);
      if (wx && !wy) insert(wx, ly, ny);
    };
    const zWord = (w: WordToken | undefined, point: boolean) => {
      if (!w) return;
      const oz = point ? tz : 0;
      if (needsNumber(w, !(m.sz === 1 && oz === 0)) && num(w) !== null)
        rewrite(w, 'Z', m.sz * (num(w) as number) + oz);
    };

    // A program that moves incrementally before it gives any absolute X/Y is placed by
    // wherever the machine starts: say so, since translating can't move that part.
    if ((X || Y) && !identityXY) {
      if (absolute && !home) sawAbsoluteXY = true;
      else if (!absolute && !sawAbsoluteXY)
        warn(
          n,
          'TRANSFORM_RELATIVE_START',
          "This program moves incrementally (G91) before it gives an absolute X/Y: that part is placed relative to where the machine starts, so it rotates, mirrors and scales about that point, and a translation doesn't move it",
        );
    }

    // Axis words.
    pair(X, Y, 'X', 'Y', absolute, (axis) => {
      const v = axis === 'x' ? cur.X : cur.Y;
      return v === null ? null : v / unit;
    });
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
        if (plane === 'XY') pair(I, J, 'I', 'J', arcAbsolute, () => (arcAbsolute ? null : 0));
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
      function zCentre(K: WordToken | undefined) {
        const oz = arcAbsolute ? tz : 0;
        if (K && needsNumber(K, !(m.sz === 1 && oz === 0)) && num(K) !== null)
          rewrite(K, 'K', m.sz * (num(K) as number) + oz);
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

    // Track the ORIGINAL commanded position (mm) for a general rotation.
    if (!m.axisAligned) {
      if (home) cur = { X: null, Y: null };
      else {
        const repeat = cycle && !absolute ? first(repeatLetter) : undefined;
        const reps = repeat ? Math.max(1, Math.round(num(repeat) ?? 1)) : 1;
        for (const [w, axis] of [
          [X, 'X'],
          [Y, 'Y'],
        ] as const) {
          const v = w ? num(w) : null;
          if (v === null) continue;
          cur[axis] = absolute
            ? v * unit
            : cur[axis] === null
              ? null
              : (cur[axis] as number) + reps * v * unit;
        }
      }
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
  for (const [code, w] of f.warnings) {
    diagnostics.push({
      severity: 'warning',
      code,
      message: w.count > 1 ? `${w.message} (${w.count} lines)` : w.message,
      line: w.line,
    });
  }
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
