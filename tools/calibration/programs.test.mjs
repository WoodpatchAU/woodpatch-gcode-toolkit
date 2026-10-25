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
  const head = 'G21 G90 G17 G94\nM5\nG53 G0 Z-5\nG0 X10 Y10\n';
  const tail = 'G53 G0 Z-5\nM5\nM30\n';
  const xy = { zMoves: false, events: false };
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
    ['an offset change', xy, `${head}G10 L2 P1 X5\n${tail}`, /offset change/],
    ['a work offset selected', xy, `${head}G55\n${tail}`, /offset change/],
    ['a homing move', xy, `${head}G28\n${tail}`, /homing/],
    ['incremental moves', xy, `${head}G91\nG0 X5\nG90\n${tail}`, /G91/],
    ['a missing M30', xy, `${head}G53 G0 Z-5\nM5\n`, /PROGRAM_END|run it to its end/],
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

describe('the inputs', () => {
  it('refuse an envelope bigger than the travel, or other bad numbers', () => {
    for (const bad of [
      { envelopeX: 2441, envelopeY: 800 },
      { envelopeX: 1000, envelopeY: 1221 },
      { envelopeX: 50, envelopeY: 800 },
      { ...OPTS, plunge: 99 },
      { ...OPTS, clearance: 0 },
      { ...OPTS, target: 5 },
      { envelopeX: Number.NaN, envelopeY: 800 },
    ]) {
      assert.throws(() => readSetup(EXAMPLE, bad), /must be a number/, JSON.stringify(bad));
    }
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
