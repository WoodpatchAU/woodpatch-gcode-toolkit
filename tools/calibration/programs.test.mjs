// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The calibration programs' generator, against the FICTIONAL example record only. The
// safety rules are tested twice: every generated program passes them, and the checker
// refuses a hand-written program that breaks each one.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MIN_TARGET_SECONDS,
  RUNS_FILE,
  SAFETY,
  checkOut,
  checkProgram,
  generatePrograms,
  readSetup,
  runsTemplate,
} from './programs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const EXAMPLE = readFileSync(join(REPO, 'packages/db-schema/examples/example-router.json'), 'utf8');
const MASSO = EXAMPLE.replace('"dialect": "generic"', '"dialect": "masso-g3-5.13"');
const OPTS = { envelopeX: 1000, envelopeY: 800 };

describe('the generated programs', () => {
  for (const [name, record] of [
    ['generic', EXAMPLE],
    ['masso', MASSO],
  ]) {
    const s = readSetup(record, OPTS);
    const programs = generatePrograms(s, { events: true });

    it(`${name}: every program passes the safety check, read back`, () => {
      assert.equal(programs.length, 7);
      for (const p of programs) {
        assert.deepEqual(
          checkProgram(s, { zMoves: /plunge/.test(p.name), events: /events/.test(p.name) }, p.gcode)
            .problems,
          [],
          p.name,
        );
      }
    });

    it(`${name}: each states the safety rules, and is sized to the target`, () => {
      for (const p of programs) {
        for (const rule of SAFETY) {
          assert.ok(
            p.gcode.includes(rule.replaceAll('(', '[').replaceAll(')', ']')),
            `${p.name}: ${rule}`,
          );
        }
        assert.ok(p.estimateSeconds >= s.target * 0.9, `${p.name}: ${p.estimateSeconds}`);
        assert.ok(p.gcode.trimEnd().endsWith('M5\nM30'), p.name);
        // Short lines: a controller's limit is unknown, and the reviewed headers were short.
        for (const line of p.gcode.split('\n')) assert.ok(line.length <= 100, `${p.name}: ${line}`);
      }
    });
  }

  it('writes the events program (spindle on) only when asked', () => {
    const s = readSetup(EXAMPLE, OPTS);
    const names = generatePrograms(s).map((p) => p.name);
    assert.equal(names.length, 6);
    assert.ok(!names.some((n) => /events/.test(n)));
    for (const p of generatePrograms(s)) assert.doesNotMatch(p.gcode, /^M[34]\b/m, p.name);
  });

  it('never exceeds the max feed, and moves Z only by G53, in the plunge range', () => {
    const s = readSetup(EXAMPLE, OPTS);
    for (const p of generatePrograms(s, { events: true })) {
      for (const line of p.gcode.split('\n')) {
        const f = /F([\d.]+)/.exec(line);
        if (f) {
          const cap = /Z/.test(line) ? s.maxZ : s.maxXY;
          assert.ok(Number(f[1]) <= cap, `${p.name}: ${line}`);
        }
        if (/^[^(]*Z/.test(line)) {
          assert.match(line, /^G53 /, `${p.name}: ${line}`);
          const z = Number(/Z(-?[\d.]+)/.exec(line)[1]);
          assert.ok(z <= s.safeZ && z >= s.safeZ - s.plunge, `${p.name}: ${line}`);
        }
      }
    }
  });

  it('is deterministic', () => {
    const a = generatePrograms(readSetup(EXAMPLE, OPTS), { events: true });
    const b = generatePrograms(readSetup(EXAMPLE, OPTS), { events: true });
    assert.deepEqual(
      a.map((p) => p.gcode),
      b.map((p) => p.gcode),
    );
  });

  it("gives a runs template naming each program's bytes", () => {
    const s = readSetup(EXAMPLE, OPTS);
    const programs = generatePrograms(s);
    const t = runsTemplate(s, programs);
    assert.equal(t.runs.length, programs.length);
    for (const r of t.runs) {
      assert.match(r.sha256, /^[0-9a-f]{64}$/);
      assert.equal(r.measuredSeconds, null);
      assert.equal(r.method, 'controller-timer');
    }
  });
});

describe('the safety check refuses', () => {
  const s = readSetup(EXAMPLE, OPTS);
  const head = 'G21 G90 G17 G94 G54\nM5\nG53 G0 Z-5\nG0 X10 Y10\n';
  const tail = 'G53 G0 Z-5\nM5\nM30\n';
  const xy = { zMoves: false, events: false };
  const ev = { zMoves: false, events: true };
  // The example's dialect is generic, whose G4 P is in seconds.
  const dw = (sec) => sec * (s.dialect.interpreter.dwellUnits === 'milliseconds' ? 1000 : 1);
  const cases = [
    ['a Z move in work coordinates', xy, `${head}G0 Z-5\n${tail}`, /a Z word outside a G53 line/],
    [
      'Z leaving the safe height outside the plunge program',
      xy,
      `${head}G53 G0 Z-10\n${tail}`,
      /leaves the safe height/,
    ],
    [
      'an XY move below the safe height',
      { zMoves: true, events: false },
      `${head}G53 G0 Z-10\nG0 X20 Y20\n${tail}`,
      /X or Y moves below the safe height/,
    ],
    ['a feed over the max', xy, `${head}G1 X100 Y10 F10001\n${tail}`, /over the axes' max/],
    [
      'a Z feed over the max',
      { zMoves: true, events: false },
      `G21 G90 G17 G94\nM5\nG53 G0 Z-5\nG53 G1 Z-10 F2001\n${tail}`,
      /over the axes' max/,
    ],
    ['a move outside the envelope', xy, `${head}G0 X1001 Y10\n${tail}`, /outside the envelope/],
    [
      'an arc leaving the envelope',
      xy,
      `${head}G0 X20 Y400\nG2 X20 Y400 I-15 J0 F1000\n${tail}`,
      /arc leaves the envelope/,
    ],
    ['the spindle started', xy, `${head}M3 S1000\nG4 P1\nM5\n${tail}`, /spindle starts/],
    ['a tool change', xy, `${head}T2 M6\n${tail}`, /tool change/],
    [
      'a first move that is not G53 Z',
      xy,
      `G21 G90 G17 G94\nM5\nG0 X10 Y10\n${tail}`,
      /first move/,
    ],
    [
      'a plunge below the range',
      { zMoves: true, events: false },
      `G21 G90 G17 G94\nM5\nG53 G0 Z-5\nG53 G1 Z-40 F500\n${tail}`,
      /outside the plunge range/,
    ],
    ['an offset change', xy, `${head}G10 L2 P1 X5\n${tail}`, /G10 isn't one/],
    ['another work offset selected', xy, `${head}G55\n${tail}`, /G55 isn't one/],
    ['a homing move', xy, `${head}G28\n${tail}`, /G28 isn't one/],
    ['incremental moves', xy, `${head}G91\nG0 X5\nG90\n${tail}`, /G91 isn't one/],
    // Leading zeros read as the same codes (review of #78).
    ['G030', xy, `${head}G030\n${tail}`, /G30 isn't one/],
    ['G092', xy, `${head}G092 X-900 Y0\n${tail}`, /G92 isn't one/],
    ['G010', xy, `${head}G010 L20 P1 X-900\n${tail}`, /G10 isn't one/],
    ['G055', xy, `${head}G055\n${tail}`, /G55 isn't one/],
    ['machine XY (G53 with X and Y)', xy, `${head}G53 G0 X500 Y500\n${tail}`, /on a G53 line/],
    ['a G18 arc, swinging Z', xy, `${head}G18\nG2 X20 Y10 I5 K0 F1000\n${tail}`, /G18 isn't one/],
    ['K on an arc', xy, `${head}G2 X20 Y10 I5 K0 F1000\n${tail}`, /K0 isn't one/],
    ['T alone', xy, `${head}T2\n${tail}`, /T2 isn't one/],
    ['S alone', xy, `${head}S1000\n${tail}`, /S1000 isn't one/],
    ['M0', xy, `${head}M0\n${tail}`, /M0 isn't one/],
    ['M3 outside the events program', xy, `${head}M3 S1000\nM5\n${tail}`, /M3 isn't one/],
    ['an expression', xy, `${head}G0 X[10+5] Y10\n${tail}`, /no expression/],
    ['a parameter assignment', xy, `${head}#1=5\n${tail}`, /no assignment/],
    ['a line after M30', xy, `${head}${tail}G0 X20 Y20\n`, /after M30/],
    // Two rules the word check also covers: each must still say its own piece.
    [
      'Z together with X and Y',
      { zMoves: true, events: false },
      `${head}G53 G0 X20 Y20 Z-10\n${tail}`,
      /Z moves together with X or Y/,
    ],
    [
      'Z moved in work coordinates',
      { zMoves: true, events: false },
      `${head}G0 Z-10\n${tail}`,
      /Z moves outside machine coordinates/,
    ],
    ['a missing M30', xy, `${head}G53 G0 Z-5\nM5\n`, /PROGRAM_END|run it to its end/],
    // Spelled exactly as written: these read the same to RS-274, unchecked on a controller.
    ['G053', xy, `${head}G053 G0 Z-5\n${tail}`, /"G053" isn't spelled/],
    ['G53.0', xy, `${head}G53.0 G0 Z-5\n${tail}`, /"G53.0" isn't spelled/],
    ['a space inside a word', xy, `${head}G 0 X 2 0 Y10\n${tail}`, /"X 2 0" isn't spelled/],
    ['lower case', xy, `${head}g0 X20 Y10\n${tail}`, /"g0" isn't spelled/],
    ['X+20', xy, `${head}G0 X+20 Y10\n${tail}`, /"X\+20" isn't spelled/],
    // The spindle's speed and the dwell, bounded in the events program too.
    ['S over maxRpm', ev, `${head}M3 S180000\nG4 P${dw(2)}\nM5\n${tail}`, /S180000 is outside/],
    ['S0', ev, `${head}M3 S0\nG4 P${dw(2)}\nM5\n${tail}`, /S0 is outside/],
    ['a dwell over 60 s', ev, `${head}G4 P${dw(61)}\n${tail}`, /dwells over 60 s/],
    ['an hour-long dwell', ev, `${head}G4 P1000000000\n${tail}`, /dwells over 60 s/],
  ];
  for (const [name, p, gcode, re] of cases) {
    it(name, () => {
      const r = checkProgram(s, p, gcode);
      assert.ok(
        r.problems.some((x) => re.test(x)),
        `${name}: ${JSON.stringify(r.problems)}`,
      );
    });
  }
});

describe('the bounds accept what they should', () => {
  it('S up to maxRpm, and dwells up to 60 s, in either dialect', () => {
    for (const record of [EXAMPLE, MASSO]) {
      const s = readSetup(record, OPTS);
      const scale = s.dialect.interpreter.dwellUnits === 'milliseconds' ? 1000 : 1;
      const g = `G21 G90 G17 G94 G54\nM5\nG53 G0 Z-5\nG0 X10 Y10\nM3 S${s.maxRpm}\nG4 P${60 * scale}\nM5\nG4 P0\nG53 G0 Z-5\nM5\nM30\n`;
      const r = checkProgram(s, { zMoves: false, events: true }, g);
      assert.deepEqual(r.problems, [], s.dialect.id);
      const over = g.replace(`P${60 * scale}`, `P${61 * scale}`);
      assert.ok(checkProgram(s, { zMoves: false, events: true }, over).problems.length > 0);
    }
  });
});

describe('the inputs', () => {
  it('refuse an envelope bigger than the travel, or other bad numbers', () => {
    for (const bad of [
      { envelopeX: 2441, envelopeY: 800 },
      { envelopeX: 1000, envelopeY: 1221 },
      { envelopeX: 50, envelopeY: 800 },
      { ...OPTS, plunge: 99 },
      { ...OPTS, clearance: 0 },
      { ...OPTS, target: 5 },
      { ...OPTS, target: 119 },
      { envelopeX: Number.NaN, envelopeY: 800 },
    ]) {
      assert.throws(() => readSetup(EXAMPLE, bad), /must be a number/, JSON.stringify(bad));
    }
  });

  it('accept a target of 120 s, the shortest the fit can separate', () => {
    assert.equal(readSetup(EXAMPLE, { ...OPTS, target: MIN_TARGET_SECONDS }).target, 120);
  });

  it('refuse a record that is not valid', () => {
    const r = JSON.parse(EXAMPLE);
    delete r.axes.X.max;
    assert.throws(() => readSetup(JSON.stringify(r), OPTS), /isn't valid/);
  });

  it('refuse an --out inside this repository, or one not empty', () => {
    assert.throws(() => checkOut(join(REPO, 'cal-out')), /inside the toolkit repository/);
    assert.throws(() => checkOut(join(HERE, 'x', 'y')), /inside the toolkit repository/);
    const d = mkdtempSync(join(tmpdir(), 'cal-'));
    writeFileSync(join(d, 'f'), '');
    assert.throws(() => checkOut(d), /isn't empty/);
    rmSync(d, { recursive: true, force: true });
  });

  it('write the programs and the runs file from the command line, refusing a bad run', () => {
    const base = mkdtempSync(join(tmpdir(), 'cal-'));
    const record = join(base, 'record.json');
    writeFileSync(record, EXAMPLE);
    const run = (out, ...extra) =>
      spawnSync(
        process.execPath,
        [
          join(HERE, 'programs.mjs'),
          '--record',
          record,
          '--out',
          out,
          '--envelope-x',
          '1000',
          '--envelope-y',
          '800',
          ...extra,
        ],
        { encoding: 'utf8' },
      );
    const ok = run(join(base, 'out'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(readdirSync(join(base, 'out')).sort(), [
      'cal-01-rapids.nc',
      'cal-02-feeds.nc',
      'cal-03-corners.nc',
      'cal-04-arcs.nc',
      'cal-05-polyline.nc',
      'cal-06-plunge.nc',
      RUNS_FILE,
    ]);
    const bad = run(join(base, 'out2'), '--plunge', '500');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--plunge/);
    rmSync(base, { recursive: true, force: true });
  });
});
