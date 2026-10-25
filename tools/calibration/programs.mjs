// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Writes the calibration reference programs (plan §4.3, parcel 5c) for one machine:
//
//   node tools/calibration/programs.mjs --record <record.json> --out <new dir>
//        --envelope-x <mm> --envelope-y <mm> [--plunge <mm>] [--clearance <mm>]
//        [--target <s>] [--events]
//
// The programs are AIR CUTS, run on a real machine with the operator at it, so safety
// comes before everything else here:
//
//   - Every Z move is in MACHINE coordinates (G53), at or just below the top of Z
//     travel: where Z is never depends on the work offset the operator sets. Only the
//     plunge program moves Z at all, and only within --plunge of that height.
//   - XY moves stay inside the envelope, from the work origin, and the travel check
//     (ADR-0042) must find nothing.
//   - No feed exceeds the record's max velocity for the axes it moves.
//   - The spindle stays off, except in the events program, which is written only
//     with --events.
//
// These are checked on the WRITTEN G-code, read back through the interpreter, and
// nothing is written unless every program passes. The record and the programs are the
// machine's, so they stay private: --out must be outside this repository, and the
// repository holds only this generator (its input never enters it).
//
// --out also gets calibration-runs.json: one entry per program, for the operator's
// measured times, which the fit tool reads.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const db = await import(join(REPO, 'packages/db-schema/dist/index.js'));
const server = await import(join(REPO, 'packages/server/dist/index.js'));

export const GENERATOR_VERSION = 1;
/** What the fit tool reads, beside the programs. Its name is in the CI guard. */
export const RUNS_FILE = 'calibration-runs.json';

export class ProgramsError extends Error {}

/** The air-cut header every program starts with (reviewer's condition 1, 5c outline). */
export const SAFETY = [
  'CALIBRATION AIR CUT: NOTHING IS CUT. NOTHING MAY BE IN THE PATH.',
  'Remove the tool, or retract it fully. Clear the workholding and the bed.',
  'Spindle OFF throughout (the events program is the only exception).',
  'Keep a hand on the E-stop for the whole run.',
  'Run it first at a reduced feed override, watching. Then time it at 100% feed and rapid.',
  'Record the overrides used if they were not 100%: they change the time.',
  "This program doesn't replace the operator's judgement at the machine.",
];

const num = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Readable record and setup, checked. Throws ProgramsError naming what's wrong. */
export function readSetup(recordText, opts) {
  const read = db.readMachine(recordText);
  if (!read.ok) {
    throw new ProgramsError(
      `the record isn't valid: ${read.problems.map((p) => `${p.code} ${p.path}`).join('; ')}`,
    );
  }
  const record = read.record;
  const { machine, travel, dialect } = server.mapRecord(record);
  const span = (a) => travel[a].max - travel[a].min;

  const positive = (name, v, min, max) => {
    if (!Number.isFinite(v) || v < min || v > max) {
      throw new ProgramsError(`--${name} must be a number from ${min} to ${num(max)} (it is ${v})`);
    }
    return v;
  };
  const envX = positive('envelope-x', opts.envelopeX, 100, span('X'));
  const envY = positive('envelope-y', opts.envelopeY, 100, span('Y'));
  const clearance = positive('clearance', opts.clearance ?? 5, 1, span('Z') / 2);
  const plunge = positive('plunge', opts.plunge ?? 30, 5, span('Z') - clearance);
  const target = positive('target', opts.target ?? 240, 30, 1800);

  return {
    record,
    hash: read.hash,
    machine,
    travel,
    dialect,
    envX,
    envY,
    // The top of the plunge program's range, and the only Z the others use: machine Z.
    safeZ: travel.Z.max - clearance,
    plunge,
    target,
    // XY feeds never exceed the slower of the two axes.
    maxXY: Math.min(machine.axes.X.maxVelocity, machine.axes.Y.maxVelocity),
    maxZ: machine.axes.Z.maxVelocity,
    maxRpm: record.spindle.maxRpm.value,
  };
}

/** Feeds as fractions of a maximum, rounded DOWN to 10 mm/min so they never exceed it. */
const feeds = (max, fractions) =>
  fractions.map((f) => Math.max(10, Math.floor((max * f) / 10) * 10));

/** One program's body (repeated) and what it isolates. */
function bodies(s) {
  const m = 10; // margin inside the envelope
  const x0 = m;
  const y0 = m;
  const x1 = s.envX - m;
  const y1 = s.envY - m;
  const cx = s.envX / 2;
  const cy = s.envY / 2;
  const fXY = feeds(s.maxXY, [0.25, 0.5, 1]);
  const mid = fXY[1];
  const fZ = feeds(s.maxZ, [0.25, 0.5, 1]);

  // Back-and-forth hops along X, Y and the diagonal: short ones never reach full speed
  // (acceleration), long ones mostly cruise (velocity).
  const hops = (word, f) => {
    const out = [];
    const lengths = [20, 50, 100, 200, Math.min(x1 - x0, y1 - y0)];
    for (const L of lengths) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [Math.SQRT1_2, Math.SQRT1_2],
      ]) {
        out.push(`${word} X${num(x0 + dx * L)} Y${num(y0 + dy * L)}${f}`);
        out.push(`${word} X${num(x0)} Y${num(y0)}${f}`);
      }
    }
    // The full width and height.
    out.push(`${word} X${num(x1)} Y${num(y0)}${f}`, `${word} X${num(x0)} Y${num(y0)}${f}`);
    out.push(`${word} X${num(x0)} Y${num(y1)}${f}`, `${word} X${num(x0)} Y${num(y0)}${f}`);
    return out;
  };

  const squares = () => {
    const out = [];
    for (const side of [20, 100, Math.min(400, x1 - x0, y1 - y0)]) {
      out.push(`G0 X${num(x0)} Y${num(y0)}`);
      for (let lap = 0; lap < 3; lap++) {
        out.push(
          `G1 X${num(x0 + side)} Y${num(y0)} F${mid}`,
          `G1 X${num(x0 + side)} Y${num(y0 + side)}`,
          `G1 X${num(x0)} Y${num(y0 + side)}`,
          `G1 X${num(x0)} Y${num(y0)}`,
        );
      }
    }
    return out;
  };

  // A zigzag whose every corner turns by `turn` degrees, along X from the left edge.
  const zigzag = (turn) => {
    const L = 40;
    const half = ((turn / 2) * Math.PI) / 180;
    const step = L * Math.cos(half);
    const rise = L * Math.sin(half);
    const ybase = cy - rise / 2;
    const out = [`G0 X${num(x0)} Y${num(ybase)}`];
    let x = x0;
    let up = true;
    while (x + step <= x1) {
      x += step;
      out.push(`G1 X${num(x)} Y${num(up ? ybase + rise : ybase)} F${mid}`);
      up = !up;
    }
    return out;
  };

  const circles = () => {
    const out = [];
    for (const r of [5, 25, Math.min(100, (x1 - x0) / 2, (y1 - y0) / 2)]) {
      out.push(`G0 X${num(cx + r)} Y${num(cy)}`);
      out.push(`G2 X${num(cx + r)} Y${num(cy)} I${num(-r)} J0 F${mid}`);
      out.push(`G3 X${num(cx + r)} Y${num(cy)} I${num(-r)} J0`);
    }
    return out;
  };

  // A circle drawn as short straight segments, as CAM output often is.
  const polyline = () => {
    const out = [];
    const r = Math.min(50, (x1 - x0) / 2, (y1 - y0) / 2);
    for (const seg of [1, 0.25]) {
      const n = Math.ceil((2 * Math.PI * r) / seg);
      out.push(`G0 X${num(cx + r)} Y${num(cy)}`);
      for (let i = 1; i <= n; i++) {
        const a = (2 * Math.PI * i) / n;
        out.push(
          `G1 X${num(cx + r * Math.cos(a))} Y${num(cy + r * Math.sin(a))}${i === 1 ? ` F${mid}` : ''}`,
        );
      }
    }
    return out;
  };

  // Z only, in machine coordinates, never below the plunge depth under the safe height.
  const plunges = () => {
    const out = [];
    const bottom = s.safeZ - s.plunge;
    for (const f of fZ) {
      for (const d of [2, 10, s.plunge]) {
        out.push(`G53 G1 Z${num(s.safeZ - d)} F${f}`, `G53 G1 Z${num(s.safeZ)}`);
      }
    }
    for (const d of [2, 10, s.plunge])
      out.push(`G53 G0 Z${num(s.safeZ - d)}`, `G53 G0 Z${num(s.safeZ)}`);
    if (bottom < s.travel.Z.min) throw new ProgramsError('the plunge would pass the bottom of Z');
    return out;
  };

  // Spindle on and off, and dwells: the controller's waits. Opt-in only.
  const events = () => {
    const rpm = Math.floor(s.maxRpm / 2 / 100) * 100;
    // G4 P is milliseconds on some controllers (Masso), seconds on others: the dialect's.
    const ms = s.dialect.interpreter.dwellUnits === 'milliseconds';
    const dwell = (sec) => `G4 P${ms ? sec * 1000 : sec}`;
    return [`M3 S${rpm}`, dwell(2), 'M5', dwell(1)];
  };

  return [
    { name: 'cal-01-rapids', isolates: 'rapid rate and acceleration', body: hops('G0', '') },
    {
      name: 'cal-02-feeds',
      isolates: 'feed moves at three feeds: acceleration and velocity',
      body: fXY.flatMap((f) => hops('G1', ` F${f}`)),
    },
    {
      name: 'cal-03-corners',
      isolates: 'cornering (junction deviation): squares, then zigzags turning 30-150 degrees',
      body: [...squares(), ...[30, 60, 90, 120, 150].flatMap(zigzag)],
    },
    { name: 'cal-04-arcs', isolates: 'arcs: full circles at three radii', body: circles() },
    {
      name: 'cal-05-polyline',
      isolates: 'dense short segments (1 mm and 0.25 mm): the planner and block rate',
      body: polyline(),
    },
    {
      name: 'cal-06-plunge',
      isolates: 'Z alone, in machine coordinates, at three Z feeds and at rapid',
      body: plunges(),
      // Z moves, over the envelope's centre: cleared, and away from its edges.
      zMoves: true,
      start: [cx, cy],
    },
    {
      name: 'cal-07-events',
      isolates: 'spindle start and stop waits, and dwells (SPINDLE ON: opt-in)',
      body: events(),
      events: true,
      start: [cx, cy],
    },
  ];
}

/** A comment line: G-code comments can't nest, so inner brackets become square. */
const comment = (t) => `(${t.replaceAll('(', '[').replaceAll(')', ']')})`;

function text(s, p, repeats) {
  const lines = [
    `${p.name}: ${p.isolates}`,
    ...SAFETY,
    `Work origin: X0 Y0 at the envelope's corner. Every XY move stays within X0-${num(s.envX)} Y0-${num(s.envY)}.`,
    p.zMoves
      ? `Z moves only in machine coordinates (G53), between Z${num(s.safeZ - s.plunge)} and Z${num(s.safeZ)}: never relative to the work.`
      : `Z stays at Z${num(s.safeZ)} in machine coordinates (G53), never relative to the work.`,
    `Record ${s.record.id} revision ${s.record.revision}, content hash ${s.hash.slice(0, 12)}. Generator v${GENERATOR_VERSION}. Body x${repeats}.`,
  ].map(comment);
  lines.push('G21 G90 G17 G94', 'M5', `G53 G0 Z${num(s.safeZ)}`);
  // Every program first goes, at the safe height, to a known place inside the envelope.
  const [sx, sy] = p.start ?? [10, 10];
  lines.push(`G0 X${num(sx)} Y${num(sy)}`);
  for (let i = 0; i < repeats; i++) lines.push(...p.body);
  lines.push(`G53 G0 Z${num(s.safeZ)}`, `G0 X10 Y10`);
  lines.push('M5', 'M30', '');
  return lines.join('\n');
}

/**
 * Checks one written program against the safety rules, by reading it back. Returns the
 * problems (none: safe to write) and its estimate in seconds.
 */
export function checkProgram(s, p, gcode) {
  const problems = [];
  const program = core.parse(gcode);
  const result = core.interpret(program, { dialect: s.dialect });
  for (const d of [...program.diagnostics, ...result.diagnostics]) {
    if (d.severity === 'error') problems.push(`line ${d.line}: ${d.code}`);
  }
  if (!result.completed) problems.push("the interpreter didn't run it to its end");
  // What the controller needs to run a job to its end (M30, the spindle off before it).
  // Only "cuts with the spindle off" is expected: these are air cuts.
  for (const d of core.programChecks(program, result, s.dialect)) {
    if (d.code !== 'PROGRAM_CUT_SPINDLE_OFF') problems.push(`line ${d.line}: ${d.code}`);
  }
  for (const d of core.checkTravel(result.steps, s.travel)) {
    problems.push(`line ${d.line}: travel: ${d.code}`);
  }
  // On the text too: the interpreter assumes a zero work offset, so a work-coordinate
  // "G0 Z-5" at Z-5 looks like no move at all, but on the machine it moves by the
  // offset. Z only on G53 lines, and nothing that changes an offset or homes.
  gcode.split('\n').forEach((raw, i) => {
    const code = raw
      .replace(/\([^)]*\)/g, '')
      .replace(/;.*$/, '')
      .toUpperCase();
    if (/Z/.test(code) && !/^\s*G53\b/.test(code)) {
      problems.push(`line ${i + 1}: a Z word outside a G53 line`);
    }
    if (/G\s*(10|28|30|52|92|5[4-9])(\.\d)?\b/.test(code)) {
      problems.push(`line ${i + 1}: an offset change, or a homing move`);
    }
    if (/G\s*91\b/.test(code)) problems.push(`line ${i + 1}: incremental moves (G91)`);
  });
  const eps = 1e-6;
  let zSet = false;
  for (const st of result.steps) {
    if (st.kind === 'spindle' && st.state !== 'off' && !p.events) {
      problems.push(`line ${st.line}: the spindle starts outside the events program`);
    }
    if (st.kind === 'tool-change') problems.push(`line ${st.line}: a tool change`);
    if (st.kind !== 'linear' && st.kind !== 'arc') continue;
    const movesZ = Math.abs(st.to.Z - st.from.Z) > eps;
    // An arc always moves in its plane, even a full circle that ends where it began.
    const movesXY =
      st.kind === 'arc' ||
      Math.abs(st.to.X - st.from.X) > eps ||
      Math.abs(st.to.Y - st.from.Y) > eps;
    if (!zSet) {
      // The first motion is the retract to the safe height, in machine coordinates.
      if (!(st.kind === 'linear' && st.frame?.pinned.includes('Z') && !movesXY)) {
        problems.push(`line ${st.line}: the first move isn't G53 Z to the safe height`);
      }
      if (Math.abs(st.to.Z - s.safeZ) > eps)
        problems.push(`line ${st.line}: the first Z isn't the safe height`);
      zSet = true;
      continue;
    }
    if (movesZ) {
      if (!(st.kind === 'linear' && st.frame?.pinned.includes('Z'))) {
        problems.push(`line ${st.line}: Z moves outside machine coordinates`);
      }
      if (movesXY) problems.push(`line ${st.line}: Z moves together with X or Y`);
      if (!p.zMoves && Math.abs(st.to.Z - s.safeZ) > eps) {
        problems.push(`line ${st.line}: Z leaves the safe height outside the plunge program`);
      }
    }
    if (st.to.Z > s.safeZ + eps || st.to.Z < s.safeZ - s.plunge - eps) {
      problems.push(`line ${st.line}: Z ${num(st.to.Z)} is outside the plunge range`);
    }
    if (movesXY) {
      if (Math.abs(st.to.Z - s.safeZ) > eps)
        problems.push(`line ${st.line}: X or Y moves below the safe height`);
      const w = { X: st.to.X - st.offset.X, Y: st.to.Y - st.offset.Y };
      if (w.X < -eps || w.X > s.envX + eps || w.Y < -eps || w.Y > s.envY + eps) {
        problems.push(`line ${st.line}: X${num(w.X)} Y${num(w.Y)} is outside the envelope`);
      }
      if (st.kind === 'arc') {
        const r = st.radius;
        const c = { X: st.centre.X - st.offset.X, Y: st.centre.Y - st.offset.Y };
        if (c.X - r < -eps || c.X + r > s.envX + eps || c.Y - r < -eps || c.Y + r > s.envY + eps) {
          problems.push(`line ${st.line}: the arc leaves the envelope`);
        }
      }
    }
    if (!(st.kind === 'linear' && st.rapid)) {
      const f = st.feed;
      if (!f || f.mode !== 'per-minute') {
        problems.push(`line ${st.line}: a feed move without a feed in mm/min`);
      } else {
        const cap = movesZ ? s.maxZ : s.maxXY;
        if (f.mmPerMinute > cap + eps) {
          problems.push(
            `line ${st.line}: F${num(f.mmPerMinute)} is over the axes' max (${num(cap)})`,
          );
        }
      }
    }
  }
  const e = core.estimateTime(result, s.machine);
  if (!e.complete) problems.push('its estimate is incomplete');
  return { problems, seconds: e.complete ? e.totalMs / 1000 : null };
}

/** Every program, sized to about --target seconds each, checked. Throws on any problem. */
export function generatePrograms(s, { events = false } = {}) {
  const out = [];
  for (const p of bodies(s)) {
    if (p.events && !events) continue;
    // Size the repeats from the estimates of one and two bodies.
    const one = checkProgram(s, p, text(s, p, 1));
    const two = checkProgram(s, p, text(s, p, 2));
    for (const c of [one, two]) {
      if (c.problems.length)
        throw new ProgramsError(`${p.name}: ${c.problems.slice(0, 5).join('; ')}`);
    }
    const per = two.seconds - one.seconds;
    const repeats = Math.max(1, Math.ceil((s.target - (one.seconds - per)) / per));
    const gcode = text(s, p, repeats);
    const c = checkProgram(s, p, gcode);
    if (c.problems.length)
      throw new ProgramsError(`${p.name}: ${c.problems.slice(0, 5).join('; ')}`);
    out.push({ name: p.name, isolates: p.isolates, gcode, repeats, estimateSeconds: c.seconds });
  }
  return out;
}

/** The runs file's skeleton: the operator fills in each measured time. */
export function runsTemplate(s, programs) {
  return {
    schema: 1,
    description:
      "Measured times of the calibration programs. PRIVATE: the machine's. Fill in measuredSeconds from the controller's job timer, at 100% feed and rapid overrides (or record the ones used).",
    record: { id: s.record.id, revision: s.record.revision, hash: s.hash },
    generator: GENERATOR_VERSION,
    setup: { envelopeX: s.envX, envelopeY: s.envY, safeZ: s.safeZ, plunge: s.plunge },
    runs: programs.map((p) => ({
      file: `${p.name}.nc`,
      sha256: createHash('sha256').update(p.gcode).digest('hex'),
      estimateSeconds: Math.round(p.estimateSeconds * 10) / 10,
      measuredSeconds: null,
      method: 'controller-timer',
      overrides: { feedPercent: 100, rapidPercent: 100 },
      date: null,
      notes: '',
    })),
  };
}

/** A path's real form, through the nearest parent that exists (it may not exist yet). */
function realish(abs) {
  for (let p = abs; ; p = dirname(p)) {
    try {
      return join(realpathSync(p), relative(p, abs));
    } catch (e) {
      if (p === dirname(p)) throw e;
    }
  }
}

/** Refuses an --out inside this repository, or one that isn't new or empty. */
export function checkOut(out) {
  const real = realish(resolve(out));
  const repo = realpathSync(REPO);
  if (real === repo || real.startsWith(repo + sep)) {
    throw new ProgramsError(
      "--out is inside the toolkit repository: the programs are the machine's, and private",
    );
  }
  try {
    if (readdirSync(real).length > 0) throw new ProgramsError(`${out} isn't empty`);
  } catch (e) {
    if (e instanceof ProgramsError) throw e;
  }
  return real;
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
      opt('--envelope-x') === undefined ||
      opt('--envelope-y') === undefined
    ) {
      throw new ProgramsError(
        'usage: programs.mjs --record <record.json> --out <new dir> --envelope-x <mm> --envelope-y <mm> [--plunge <mm>] [--clearance <mm>] [--target <s>] [--events]',
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
    const programs = generatePrograms(s, { events: args.includes('--events') });
    mkdirSync(out, { recursive: true });
    for (const p of programs) writeFileSync(join(out, `${p.name}.nc`), p.gcode, { flag: 'wx' });
    writeFileSync(join(out, RUNS_FILE), `${JSON.stringify(runsTemplate(s, programs), null, 2)}\n`, {
      flag: 'wx',
    });
    for (const p of programs) {
      process.stdout.write(
        `${p.name}.nc  x${p.repeats}  ~${Math.round(p.estimateSeconds)} s  ${p.isolates}\n`,
      );
    }
    process.stdout.write(`${RUNS_FILE}: fill in measuredSeconds for each\n`);
  } catch (e) {
    process.stderr.write(
      `programs: ${e instanceof ProgramsError ? e.message : String(e?.stack ?? e)}\n`,
    );
    process.exit(1);
  }
}
