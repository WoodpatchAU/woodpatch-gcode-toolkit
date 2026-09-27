// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The transform corpus check (parcel 4a, ADR-0033), shared by three test files so the
// large fixtures run in parallel: every op on every fixture is either refused cleanly
// (the file untouched) or moves every step exactly where the op's map says, and the
// identities (rotate x4, mirror x2) give the file back byte for byte.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GENERIC,
  interpret,
  MASSO_G3,
  mapOf,
  parse,
  transform,
  write,
  type AffineMap,
  type Dialect,
  type Position,
  type Step,
  type TransformOp,
} from '../src/index.js';

// ── The corpus: every transform is either refused cleanly or geometrically right ──

/** A fixture: `transform/…` from this package's own test fixtures, else the repo's. */
export const read = (p: string) =>
  readFileSync(
    new URL(
      p.startsWith('transform/') ? `./fixtures/${p}` : `../../../fixtures/${p}`,
      import.meta.url,
    ),
    'utf8',
  );
export const CORPUS: [string, Dialect][] = [
  ...['tux', 'webgcode', 'test_pycam', 'aztec_calendar'].map((f): [string, Dialect] => [
    `upstream/${f}.ngc`,
    GENERIC,
  ]),
  ['machine/masso-dialect-test-v1.nc', MASSO_G3],
  ...readdirSync(new URL('../../../fixtures/synthetic/', import.meta.url))
    .filter((f) => f.endsWith('.ngc'))
    .map((f): [string, Dialect] => [`synthetic/${f}`, GENERIC]),
  // Programs the transform should ACCEPT, exercising what the review of #33 found:
  // incremental after absolute, machine/home retracts around tool changes, and a
  // Masso job with cycles and K repeats.
  ['transform/abs-then-inc.ngc', GENERIC],
  ['transform/toolchange-retracts.ngc', GENERIC],
  ['transform/masso-job.nc', MASSO_G3],
];

/** Lines a transform leaves as written by design: machine-coordinate and home moves. */
/**
 * Lines a transform leaves as written by design (machine-coordinate and home moves),
 * with the axes each one moves: its axis words, or all three for a bare G28/G30.
 */
function untouchedLines(src: string): Map<number, readonly ('X' | 'Y' | 'Z')[]> {
  const out = new Map<number, readonly ('X' | 'Y' | 'Z')[]>();
  for (const line of parse(src).lines) {
    let home = false;
    let machine = false;
    const axes: ('X' | 'Y' | 'Z')[] = [];
    for (const tok of line.tokens) {
      if (tok.kind !== 'word') continue;
      if (tok.letter === 'X' || tok.letter === 'Y' || tok.letter === 'Z') axes.push(tok.letter);
      if (tok.letter === 'G' && tok.value?.kind === 'number') {
        if (tok.value.value === 53) machine = true;
        if (tok.value.value === 28 || tok.value.value === 30) home = true;
      }
    }
    if (machine) out.set(line.lineNo, axes);
    else if (home) out.set(line.lineNo, axes.length ? axes : ['X', 'Y', 'Z']);
  }
  return out;
}

type Motion = Extract<Step, { kind: 'linear' | 'arc' }>;
const motions = (src: string, dialect: Dialect) =>
  interpret(parse(src), { dialect }).steps.filter(
    (s): s is Motion => s.kind === 'linear' || s.kind === 'arc',
  );
const work = (p: Position, o: Position) => [p.X - o.X, p.Y - o.Y, p.Z - o.Z] as const;
const apply = (m: AffineMap, [x, y, z]: readonly [number, number, number]) =>
  [m.a * x + m.b * y + m.tx, m.c * x + m.d * y + m.ty, m.sz * z + m.tz] as const;
const OPS: TransformOp[] = [
  { op: 'rotate', degrees: 90, about: { x: 3, y: -7 } },
  { op: 'rotate', degrees: 180 },
  { op: 'rotate', degrees: 270 },
  { op: 'mirror', axis: 'x', about: 5 },
  { op: 'mirror', axis: 'y' },
  { op: 'translate', x: 1.25, y: -3.5, z: 0.75 },
  { op: 'scale', x: 2, about: { x: 1, y: 1 } },
  { op: 'rotate', degrees: 30 },
];

/**
 * The first line that gives each axis an ABSOLUTE value and actually moves. Before it,
 * the position on that axis depends on where the machine started (or on incremental
 * moves from there), which the program never wrote, so no transform moves it.
 */
function firstCommanded(src: string, moved: ReadonlySet<number>): Record<'X' | 'Y' | 'Z', number> {
  const first = { X: Infinity, Y: Infinity, Z: Infinity };
  let absolute = true;
  for (const line of parse(src).lines) {
    let machine = false;
    for (const tok of line.tokens)
      if (tok.kind === 'word' && tok.letter === 'G' && tok.value?.kind === 'number') {
        if (tok.value.value === 90) absolute = true;
        if (tok.value.value === 91) absolute = false;
        if ([53, 28, 30, 10, 92].includes(tok.value.value)) machine = true;
      }
    if (!absolute || machine || !moved.has(line.lineNo)) continue;
    for (const tok of line.tokens)
      if (tok.kind === 'word' && (tok.letter === 'X' || tok.letter === 'Y' || tok.letter === 'Z'))
        first[tok.letter] = Math.min(first[tok.letter], line.lineNo);
  }
  return first;
}

/** The corpus suite for `entries` (a slice of {@link CORPUS}). */
export function corpusSuite(entries: [string, Dialect][]): void {
  describe.each(entries)('%s', (file, dialect) => {
    const src = read(file);
    const before = motions(src, dialect);
    const first = firstCommanded(src, new Set(before.map((s) => s.line)));
    const untouched = untouchedLines(src);

    // The 224k-line sample takes several seconds per op (parse, transform, re-parse,
    // interpret twice), so it runs the most telling op, a quarter turn about a point
    // (words renamed and translated), plus rotate ×4. Every other file runs every op, and
    // the smaller real jobs cover the mirror identity.
    const big = file.includes('aztec');
    const ops = big ? ([OPS[0]] as TransformOp[]) : OPS;
    it.each(ops.map((op) => [JSON.stringify(op), op] as const))(
      '%s: refused cleanly, or every move lands where the map says',
      (_, op) => {
        const r = transform(parse(src), [op], { dialect });
        if (!r.ok) {
          expect(r.diagnostics.some((d) => d.severity === 'error')).toBe(true);
          expect(write(r.program)).toBe(src); // refused: untouched
          return;
        }
        const after = motions(write(r.program), dialect);
        expect(after.length).toBe(before.length);
        const m = mapOf(op);
        const det = m.a * m.d - m.b * m.c;
        // Rounding to 3 decimals (mm) or 4 (inch) moves a point by at most ~1.3 µm per
        // axis; a centre derived from rounded I/J, a little more.
        const tol = 0.004;
        for (let i = 0; i < before.length; i++) {
          const b = before[i] as Motion;
          const a = after[i] as Motion;
          expect(a.kind, `step ${i} (line ${b.line})`).toBe(b.kind);
          // A machine or home move is left as written: the axes it names go where they
          // always went; its other axes are wherever the (transformed) tool already was.
          const moved = untouched.get(b.line);
          if (moved) {
            for (const k of moved)
              expect(Math.abs(a.to[k] - b.to[k]), `line ${b.line}: untouched ${k}`).toBeLessThan(
                1e-9,
              );
            continue;
          }
          const want = apply(m, work(b.to, b.offset));
          const got = work(a.to, a.offset);
          // An output axis is comparable once every input axis it depends on is commanded.
          const known = { X: b.line >= first.X, Y: b.line >= first.Y, Z: b.line >= first.Z };
          const comparable = [
            (m.a === 0 || known.X) && (m.b === 0 || known.Y),
            (m.c === 0 || known.X) && (m.d === 0 || known.Y),
            known.Z,
          ];
          for (let k = 0; k < 3; k++)
            if (comparable[k])
              expect(
                Math.abs((got[k] as number) - (want[k] as number)),
                `line ${b.line} axis ${k}`,
              ).toBeLessThan(tol * Math.max(1, m.sz, Math.abs(m.a) + Math.abs(m.b)));
          if (b.kind === 'arc' && a.kind === 'arc') {
            const wc = apply(m, work(b.centre, b.offset));
            const gc = work(a.centre, a.offset);
            const [p, q] = b.plane === 'XY' ? [0, 1] : b.plane === 'ZX' ? [2, 0] : [1, 2];
            // The centre is the start plus I/J/K: comparable where the endpoint is.
            for (const k of [p, q] as const)
              if (comparable[k])
                expect(
                  Math.abs((gc[k] as number) - (wc[k] as number)),
                  `line ${b.line}: arc centre axis ${k}`,
                ).toBeLessThan(tol * 4);
            const flipped = b.plane === 'XY' ? det < 0 : b.plane === 'ZX' ? m.a < 0 : m.d < 0;
            expect(a.clockwise, `line ${b.line}: arc direction`).toBe(
              flipped ? !b.clockwise : b.clockwise,
            );
          }
        }
      },
      60_000,
    );

    it('rotating a quarter turn four times gives the file back, byte for byte', () => {
      let p = parse(src);
      for (let i = 0; i < 4; i++) {
        const r = transform(p, [{ op: 'rotate', degrees: 90 }], { dialect });
        if (!r.ok) return; // refused (e.g. an XZ-plane arc): nothing to compare
        p = r.program;
      }
      expect(write(p)).toBe(src);
    }, 60_000);

    it.skipIf(big)(
      'mirroring twice gives the file back, byte for byte',
      () => {
        // About an axis through the origin: every value stays exact at its own decimals.
        // (About another line, the geometry round-trips, but a value that passes through a
        // non-exact intermediate gains decimals: 1 in → 0.9016 → 1.0000.)
        const r = transform(
          parse(src),
          [
            { op: 'mirror', axis: 'x' },
            { op: 'mirror', axis: 'x' },
          ],
          { dialect },
        );
        if (r.ok) expect(write(r.program)).toBe(src);
      },
      60_000,
    );
  });
}
