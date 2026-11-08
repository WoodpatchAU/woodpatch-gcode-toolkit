// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Writes the PLANES calibration programs (ADR-0053): arcs, and the same paths as dense
// straight lines, in each of the XY, ZX and YZ planes, and steep straight lines in the
// two vertical planes. They test the arc model (ADR-0052) out of the XY plane, and how
// fast Z really accelerates when it moves with X or Y.
//
//   node tools/calibration/programs-planes.mjs --record <record.json> --out <new dir>
//        --envelope-x <mm> --envelope-y <mm> [--plunge <mm>] [--clearance <mm>]
//        [--target <s>]
//
// A separate command from programs.mjs, with its own file prefix (cal-v-), because these
// programs break that generator's first rule: Z moves together with X or Y, in arcs and
// diagonals. What keeps them safe instead:
//
//   - Z still never depends on the operator's work offset. Each program SETS work offset
//     G54.1 P100 itself: X and Y copied from G54 (the envelope's corner), and Z0 at the
//     safe height in MACHINE coordinates. P100 is overwritten on every run.
//   - That offset is checked with NOTHING moving: the program sets it at P100 X0 Y0 Z0
//     (where the spindle already is), then stops with M0 for the operator to read the
//     WORK readout (X0 Y0 Z0) and the MACHINE Z. A wrong G10 is caught before any move.
//   - Under P100, every move is a feed move, so the first lap's low feed override governs
//     all of them. The only rapid is the final G53 return to the safe height.
//   - Every point, and every arc's whole circle, stays in the slab from the safe height
//     down to --plunge below it, and inside the envelope.
//   - Each program opens with G17 G54 and closes with G17 G54, so the plane and offset are
//     restored; one stopped part-way is reset by the next calibration program.
//   - No segment asks for more blocks per second than cal-05 has run without slowing.
//
// All checked on the WRITTEN G-code, read back through the interpreter; nothing is
// written unless every program passes. Private, like programs.mjs: --out is outside
// this repository.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkOut,
  comment,
  num,
  ProgramsError,
  readSetup,
  RUNS_FILE,
  runsTemplate,
  SAFETY,
} from './programs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const core = await import(join(REPO, 'packages/core/dist/index.js'));

/** Every program of this set is named with it, so the operator sees what it does. */
export const PREFIX = 'cal-v-';
/** The work offset these programs set and use. Overwritten on every run. */
export const OFFSET_P = 100;
/**
 * Blocks per second no segment may ask for: what cal-05 ran (0.25 mm segments at
 * 10,000 mm/min) with no slowdown on the router. Past it, the fit couldn't tell the
 * block rate from Z's acceleration.
 */
export const BLOCK_RATE_GUARD = 667;
/** Chord tolerances (mm) of the straight-line programs: CAM-like, and the dense stress. */
export const TOLERANCES = { lines: 0.01, dense: 0.002 };

/** Feeds, the same in every plane so the planes compare: half and all of the slowest axis. */
const planeFeeds = (s) => {
  const max = Math.min(s.maxXY, s.maxZ);
  return [Math.max(10, Math.floor(max / 2 / 10) * 10), Math.floor(max / 10) * 10];
};

/**
 * The planes: the horizontal axis u, the vertical (or second) axis w, the fixed one, and
 * the G-code plane. The toolkit's arc frame is (a1, a2): XY, ZX (Z first), YZ.
 */
const PLANES = {
  XY: { g: 'G17', u: 'X', w: 'Y', fixed: 'Z', a1: 'X', a2: 'Y' },
  ZX: { g: 'G18', u: 'X', w: 'Z', fixed: 'Y', a1: 'Z', a2: 'X' },
  YZ: { g: 'G19', u: 'Y', w: 'Z', fixed: 'X', a1: 'Y', a2: 'Z' },
};
const OFFSET_WORD = { X: 'I', Y: 'J', Z: 'K' };

/**
 * One plane's geometry: shapes at three radii and two feeds, as a list of moves:
 * { kind: 'line', to } or { kind: 'arc', centre, r, from, sweep } in (u, w), with the
 * angle phi measured from +u towards +w.
 */
function shapes(s, plane) {
  const pl = PLANES[plane];
  const vertical = pl.w === 'Z';
  const top = vertical ? -1 : s.envY / 2 + 15; // the shapes' highest w
  const rMax = Math.min(14, Math.floor((s.plunge - 2) / 2));
  const uc = pl.u === 'X' ? s.envX / 2 : s.envY / 2;
  const moves = [];
  const at = (phi, c, r) => ({ u: c.u + r * Math.cos(phi), w: c.w + r * Math.sin(phi) });
  for (const f of planeFeeds(s)) {
    for (const r of [3, 7, rMax]) {
      // Every shape hangs from the same top, so a full circle fits the slab.
      const c = { u: uc, w: top - r };
      const deg = Math.PI / 180;
      // The roundover: a quarter from level (top) to vertical (side), and back.
      moves.push({ kind: 'line', to: at(90 * deg, c, r), f });
      moves.push({ kind: 'arc', centre: c, r, from: 90 * deg, sweep: -90 * deg, f });
      moves.push({ kind: 'arc', centre: c, r, from: 0, sweep: 90 * deg, f });
      // A semicircle over the top, and back.
      moves.push({ kind: 'line', to: at(180 * deg, c, r), f });
      moves.push({ kind: 'arc', centre: c, r, from: 180 * deg, sweep: -180 * deg, f });
      moves.push({ kind: 'arc', centre: c, r, from: 0, sweep: 180 * deg, f });
      // A full circle each way.
      moves.push({ kind: 'arc', centre: c, r, from: 180 * deg, sweep: -360 * deg, f });
      moves.push({ kind: 'arc', centre: c, r, from: 180 * deg, sweep: 360 * deg, f });
    }
  }
  return moves;
}

/** Steep straight lines down from the top at 15, 45 and 75 degrees, short and long. */
function diagonals(s) {
  const moves = [];
  const u0 = 100; // well inside the envelope, clear of its edge
  const top = -1;
  for (const f of planeFeeds(s)) {
    for (const a of [15, 45, 75]) {
      const rad = (a * Math.PI) / 180;
      const longest = Math.min(60, (s.plunge - 2) / Math.sin(rad));
      for (const L of [2, 5, longest]) {
        moves.push({ kind: 'line', to: { u: u0, w: top }, f });
        moves.push({
          kind: 'line',
          to: { u: u0 + L * Math.cos(rad), w: top - L * Math.sin(rad) },
          f,
        });
        moves.push({ kind: 'line', to: { u: u0, w: top }, f });
      }
    }
  }
  return moves;
}

/** The fixed coordinate of a plane's moves: the envelope's middle, or the slab's top. */
const fixedValue = (s, pl) => (pl.fixed === 'Z' ? 0 : pl.fixed === 'X' ? s.envX / 2 : s.envY / 2);

/** G-code for the moves: arcs as G2/G3, or (tolerance set) as chords of that tolerance. */
function render(s, plane, moves, tolerance) {
  const pl = PLANES[plane];
  const out = [];
  let lastF = null;
  const fw = (f) => {
    if (f === lastF) return '';
    lastF = f;
    return ` F${f}`;
  };
  const words = (p) => {
    const xyz = { [pl.u]: p.u, [pl.w]: p.w, [pl.fixed]: fixedValue(s, pl) };
    return `X${num(xyz.X)} Y${num(xyz.Y)} Z${num(xyz.Z)}`;
  };
  for (const m of moves) {
    if (m.kind === 'line') {
      out.push(`G1 ${words(m.to)}${fw(m.f)}`);
      continue;
    }
    const pt = (phi) => ({
      u: m.centre.u + m.r * Math.cos(phi),
      w: m.centre.w + m.r * Math.sin(phi),
    });
    if (tolerance !== null) {
      const step = 2 * Math.acos(1 - tolerance / m.r);
      const n = Math.ceil(Math.abs(m.sweep) / step);
      for (let k = 1; k <= n; k++)
        out.push(`G1 ${words(pt(m.from + (m.sweep * k) / n))}${fw(m.f)}`);
      continue;
    }
    const start = pt(m.from);
    const end = pt(m.from + m.sweep);
    // The sweep in the toolkit's (a1, a2) frame: (u, w) for XY and YZ, flipped for ZX.
    const flipped = pl.a1 !== pl.u;
    const ccw = flipped ? m.sweep < 0 : m.sweep > 0;
    const off = { [pl.u]: m.centre.u - start.u, [pl.w]: m.centre.w - start.w };
    out.push(
      `${ccw ? 'G3' : 'G2'} ${words(end)} ${OFFSET_WORD[pl.u]}${num(off[pl.u])} ${OFFSET_WORD[pl.w]}${num(off[pl.w])}${fw(m.f)}`,
    );
  }
  return out;
}

/** The programs: name, what each isolates, plane, and body. */
export function planeBodies(s) {
  const list = [];
  let i = 1;
  const name = (what) => `${PREFIX}${String(i++).padStart(2, '0')}-${what}`;
  for (const plane of ['XY', 'ZX', 'YZ']) {
    const moves = shapes(s, plane);
    const lower = plane.toLowerCase();
    list.push({
      name: name(`arcs-${lower}`),
      isolates: `arcs in ${plane} (${PLANES[plane].g}): quarters, semicircles and circles, three radii, two feeds`,
      plane,
      body: render(s, plane, moves, null),
    });
    list.push({
      name: name(`lines-${lower}`),
      isolates: `the same paths in ${plane} as straight lines, chord tolerance ${TOLERANCES.lines} mm (CAM-like)`,
      plane,
      body: render(s, plane, moves, TOLERANCES.lines),
    });
    list.push({
      name: name(`dense-${lower}`),
      isolates: `the same paths in ${plane} as straight lines, chord tolerance ${TOLERANCES.dense} mm (the densest likely)`,
      plane,
      body: render(s, plane, moves, TOLERANCES.dense),
    });
    if (plane !== 'XY') {
      list.push({
        name: name(`diagonals-${lower}`),
        isolates: `steep straight lines in ${plane}: 15, 45 and 75 degrees from level, short and long`,
        plane,
        body: render(s, plane, diagonals(s), null),
      });
    }
  }
  return list;
}

/** The header lines particular to this set, before the shared air-cut ones. */
export function planesHeader(s) {
  return [
    `THIS PROGRAM SETS WORK OFFSET G54.1 P${OFFSET_P}, overwriting it, on every run.`,
    `It moves X or Y TOGETHER WITH Z, at feed, from the safe height to ${num(s.plunge)} mm below it.`,
    `Clear the WHOLE envelope of clamps and stock from the safe height down ${num(s.plunge)} mm.`,
    'If you stop it part-way the machine may be left in G54.1 and G18/G19:',
    'run G17 G54 before any other job.',
    'At the M0: the WORK readout must show X0 Y0 Z0, and the MACHINE Z the safe height.',
  ];
}

/** The program's text. The prologue and epilogue are fixed; the checker holds them exact. */
export function planesText(s, p, repeats) {
  const pl = PLANES[p.plane];
  const head = [
    `${p.name}: ${p.isolates}`,
    ...planesHeader(s),
    ...SAFETY,
    `Work origin: X0 Y0 at the envelope's corner. Every XY point stays within X0-${num(s.envX)} Y0-${num(s.envY)}.`,
    `Record ${s.record.id} revision ${s.record.revision}, content hash ${s.hash.slice(0, 12)}. Planes set. Body x${repeats}.`,
  ].map(comment);
  const lines = [...head, ...prologue(s)];
  lines.push(pl.g);
  for (let i = 0; i < repeats; i++) lines.push(...p.body);
  lines.push(...epilogue(s), '');
  return lines.join('\n');
}

/** Sets and checks the offset, with nothing moving under it. */
export const prologue = (s) => [
  'G21 G90 G17 G94 G54',
  'M5',
  `G53 G0 Z${num(s.safeZ)}`,
  'G0 X0 Y0',
  `G10 L20.1 P${OFFSET_P} X0 Y0`,
  `G10 L20 P${OFFSET_P} Z${num(s.safeZ)}`,
  `G54.1 P${OFFSET_P}`,
  comment(
    `CHECK NOW: WORK readout X0.000 Y0.000 Z0.000, MACHINE Z ${num(s.safeZ)}. If any differs, STOP.`,
  ),
  'M0',
];

/** Back to the safe height (the one rapid), the XY plane and the operator's offset. */
export const epilogue = (s) => [`G53 G0 Z${num(s.safeZ)}`, 'G17 G54', 'G0 X10 Y10', 'M5', 'M30'];

/**
 * Checks one written program of this set by reading it back. Returns the problems
 * (none: safe to write) and its estimate in seconds.
 */
export function checkPlanesProgram(s, p, gcode) {
  const problems = [];
  const program = core.parse(gcode);
  const result = core.interpret(program, { dialect: s.dialect });
  for (const d of [...program.diagnostics, ...result.diagnostics]) {
    if (d.severity === 'error') problems.push(`line ${d.line}: ${d.code}`);
  }
  if (!result.completed) problems.push("the interpreter didn't run it to its end");
  for (const d of core.programChecks(program, result, s.dialect)) {
    if (d.code !== 'PROGRAM_CUT_SPINDLE_OFF') problems.push(`line ${d.line}: ${d.code}`);
  }
  for (const d of core.checkTravel(result.steps, s.travel)) {
    problems.push(`line ${d.line}: travel: ${d.code}`);
  }

  // The prologue and epilogue, exactly (no comments, no blank lines): the order is the
  // safety argument (offset set and checked before anything moves under it).
  const code = gcode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('('));
  const pro = prologue(s).filter((l) => !l.startsWith('('));
  const epi = epilogue(s);
  const plane = PLANES[p.plane].g;
  if (code.slice(0, pro.length).join('\n') !== pro.join('\n'))
    problems.push("the prologue isn't exactly the one that sets and checks the offset");
  if (code[pro.length] !== plane) problems.push(`the plane (${plane}) isn't selected after the M0`);
  if (code.slice(-epi.length).join('\n') !== epi.join('\n'))
    problems.push("the epilogue isn't exactly the one that restores the plane and offset");
  const body = code.slice(pro.length + 1, code.length - epi.length);
  for (const [i, l] of body.entries()) {
    // The body: feed moves only, in this program's plane. Plain words, as written.
    if (!/^G[123] X-?[\d.]+ Y-?[\d.]+ Z-?[\d.]+( [IJK]-?[\d.]+ [IJK]-?[\d.]+)?( F\d+)?$/.test(l))
      problems.push(`body line ${i + 1}: ${JSON.stringify(l)} isn't a plain feed move`);
  }

  // The motion, in machine coordinates.
  const eps = 1e-6;
  const zTop = s.safeZ;
  const zBottom = s.safeZ - s.plunge;
  const inSlab = (z) => z <= zTop + eps && z >= zBottom - eps;
  const inEnvelope = (x, y) => x >= -eps && x <= s.envX + eps && y >= -eps && y <= s.envY + eps;
  const cap = (axes) => Math.min(...axes.map((a) => (a === 'Z' ? s.maxZ : s.maxXY)));
  let paused = false;
  let rapidsAfter = 0;
  for (const st of result.steps) {
    if (st.kind === 'pause') {
      paused = true;
      continue;
    }
    if (st.kind === 'spindle' && st.state !== 'off')
      problems.push(`line ${st.line}: the spindle starts`);
    if (st.kind === 'tool-change') problems.push(`line ${st.line}: a tool change`);
    if (st.kind !== 'linear' && st.kind !== 'arc') continue;
    const movesZ = Math.abs(st.to.Z - st.from.Z) > eps;
    const movesXY =
      st.kind === 'arc' ||
      Math.abs(st.to.X - st.from.X) > eps ||
      Math.abs(st.to.Y - st.from.Y) > eps;
    if (!paused) {
      // Before the check: only the G53 retract and the XY move at the safe height.
      if (movesZ && !(st.kind === 'linear' && st.frame?.pinned.includes('Z')))
        problems.push(`line ${st.line}: Z moves before the offset is checked`);
      if (Math.abs(st.to.Z - zTop) > eps && movesXY)
        problems.push(`line ${st.line}: X or Y moves below the safe height before the check`);
      if (st.offset.Z !== 0)
        problems.push(`line ${st.line}: a move under P${OFFSET_P} before the check`);
      continue;
    }
    if (st.kind === 'linear' && st.rapid) {
      // Back on G54 at the safe height, after the return: the epilogue's park move.
      if (rapidsAfter > 0 && st.offset.Z === 0 && !movesZ && Math.abs(st.to.Z - zTop) <= eps)
        continue;
      // The one rapid under P100: the final G53 return, straight up.
      rapidsAfter++;
      if (!(st.frame?.pinned.includes('Z') && !movesXY && Math.abs(st.to.Z - zTop) <= eps))
        problems.push(
          `line ${st.line}: a rapid under P${OFFSET_P} (only the final G53 return may be)`,
        );
      continue;
    }
    if (rapidsAfter > 0 && movesZ) problems.push(`line ${st.line}: Z moves after the return`);
    if (rapidsAfter === 0 && Math.abs(st.offset.Z - zTop) > eps)
      problems.push(`line ${st.line}: a body move isn't under P${OFFSET_P}`);
    const w = { X: st.to.X - st.offset.X, Y: st.to.Y - st.offset.Y };
    if (!inSlab(st.to.Z)) problems.push(`line ${st.line}: Z ${num(st.to.Z)} leaves the slab`);
    if (!inEnvelope(w.X, w.Y))
      problems.push(`line ${st.line}: X${num(w.X)} Y${num(w.Y)} is outside the envelope`);
    if (st.kind === 'arc') {
      // The whole circle, not just the swept part: an arc's bulge can leave the slab
      // while its chord stays inside.
      const [a1, a2] = { XY: ['X', 'Y'], ZX: ['Z', 'X'], YZ: ['Y', 'Z'] }[st.plane];
      const r = Math.max(st.radius, st.endRadius);
      for (const a of [a1, a2]) {
        const lo = st.centre[a] - r;
        const hi = st.centre[a] + r;
        if (
          a === 'Z'
            ? !(inSlab(lo) && inSlab(hi))
            : !inEnvelope(
                a === 'X' ? lo - st.offset.X : s.envX / 2,
                a === 'Y' ? lo - st.offset.Y : s.envY / 2,
              ) ||
              !inEnvelope(
                a === 'X' ? hi - st.offset.X : s.envX / 2,
                a === 'Y' ? hi - st.offset.Y : s.envY / 2,
              )
        )
          problems.push(`line ${st.line}: the arc's circle leaves the slab or the envelope`);
      }
    }
    const f = st.feed;
    if (!f || f.mode !== 'per-minute') {
      problems.push(`line ${st.line}: a feed move without a feed in mm/min`);
      continue;
    }
    const axes =
      st.kind === 'arc'
        ? [...{ XY: ['X', 'Y'], ZX: ['Z', 'X'], YZ: ['Y', 'Z'] }[st.plane]]
        : ['X', 'Y', 'Z'].filter((a) => Math.abs(st.to[a] - st.from[a]) > eps);
    if (f.mmPerMinute > cap(axes) + eps)
      problems.push(
        `line ${st.line}: F${num(f.mmPerMinute)} is over the axes' max (${num(cap(axes))})`,
      );
    if (st.kind === 'linear') {
      const L = Math.hypot(st.to.X - st.from.X, st.to.Y - st.from.Y, st.to.Z - st.from.Z);
      if (L > eps && f.mmPerMinute / 60 / L > BLOCK_RATE_GUARD)
        problems.push(
          `line ${st.line}: ${Math.round(f.mmPerMinute / 60 / L)} blocks/s is over the guard (${BLOCK_RATE_GUARD})`,
        );
    }
  }
  if (!paused) problems.push('no M0 offset check');
  if (rapidsAfter !== 1)
    problems.push(`${rapidsAfter} rapids after the check (exactly 1: the final return)`);
  const e = core.estimateTime(result, s.machine);
  if (!e.complete) problems.push('its estimate is incomplete');
  return { problems, seconds: e.complete ? e.totalMs / 1000 : null };
}

/**
 * Refuses a machine whose controller reads G10 L20 another way. On Masso, L20 SETS an
 * extended offset and L20.1 adds to the active one; on LinuxCNC, L20 makes the current
 * position read the value, which would put Z0 somewhere else entirely.
 */
export function checkDialect(s) {
  if (s.dialect.interpreter.g10 !== 'masso') {
    throw new ProgramsError(
      `the planes programs set their offset with Masso's G10 L20/L20.1; ${s.dialect.id} reads G10 differently`,
    );
  }
}

/** Every program of the set, sized to about --target seconds each, checked. */
export function generatePlanes(s) {
  checkDialect(s);
  const out = [];
  for (const p of planeBodies(s)) {
    const one = checkPlanesProgram(s, p, planesText(s, p, 1));
    const two = checkPlanesProgram(s, p, planesText(s, p, 2));
    for (const c of [one, two]) {
      if (c.problems.length)
        throw new ProgramsError(`${p.name}: ${c.problems.slice(0, 5).join('; ')}`);
    }
    const per = two.seconds - one.seconds;
    const repeats = Math.max(1, Math.ceil((s.target - (one.seconds - per)) / per));
    const gcode = planesText(s, p, repeats);
    const c = checkPlanesProgram(s, p, gcode);
    if (c.problems.length)
      throw new ProgramsError(`${p.name}: ${c.problems.slice(0, 5).join('; ')}`);
    out.push({ name: p.name, isolates: p.isolates, gcode, repeats, estimateSeconds: c.seconds });
  }
  return out;
}

/**
 * The runs file: as programs.mjs's, but timed by STOPWATCH from pressing cycle start
 * after the M0 to the end. The M0's wait is the operator's (the estimate counts it as
 * nothing), and a stopwatch is the same whether or not the controller's timer stops at
 * an M0. The whole set is timed one way, as the fit requires.
 */
export function planesRunsTemplate(s, programs) {
  const t = runsTemplate(s, programs);
  return {
    ...t,
    description:
      "Measured times of the planes calibration programs. PRIVATE: the machine's. Time each by STOPWATCH, from pressing cycle start after the M0 check to the end of the program, at 100% feed and rapid overrides.",
    runs: t.runs.map((r) => ({ ...r, method: 'stopwatch' })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const n = (name) => (opt(name) === undefined ? undefined : Number(opt(name)));
  try {
    const recordPath = opt('--record');
    const outArg = opt('--out');
    if (
      !recordPath ||
      !outArg ||
      n('--envelope-x') === undefined ||
      n('--envelope-y') === undefined
    ) {
      throw new ProgramsError(
        'usage: programs-planes.mjs --record <record.json> --out <new dir> --envelope-x <mm> --envelope-y <mm> [--plunge <mm>] [--clearance <mm>] [--target <s>]',
      );
    }
    const out = checkOut(outArg);
    const s = readSetup(readFileSync(recordPath, 'utf8'), {
      envelopeX: n('--envelope-x'),
      envelopeY: n('--envelope-y'),
      plunge: n('--plunge'),
      clearance: n('--clearance'),
      target: n('--target'),
    });
    const programs = generatePlanes(s);
    mkdirSync(out, { recursive: true });
    for (const p of programs) writeFileSync(join(out, `${p.name}.nc`), p.gcode, { flag: 'wx' });
    writeFileSync(
      join(out, RUNS_FILE),
      `${JSON.stringify(planesRunsTemplate(s, programs), null, 2)}\n`,
      {
        flag: 'wx',
      },
    );
    for (const p of programs) {
      process.stdout.write(
        `${p.name}.nc  x${p.repeats}  ~${Math.round(p.estimateSeconds)} s  ${p.isolates}\n`,
      );
    }
    process.stdout.write(`${RUNS_FILE}: fill in measuredSeconds for each\n`);
  } catch (e) {
    process.stderr.write(
      `programs-planes: ${e instanceof ProgramsError ? e.message : String(e?.stack ?? e)}\n`,
    );
    process.exit(1);
  }
}
