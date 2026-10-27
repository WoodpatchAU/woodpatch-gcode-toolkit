// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The fit (ADR-0049). Its rules are tested on analytic models, where the truth is known
// and each refusal can be built on purpose; then end to end, on programs generated from
// the FICTIONAL example record, with times made by the estimator at known factors.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FIT_FORMAT, FitError, RULES, fitFactors, noise, runFit } from './fit.mjs';
import { generatePrograms, readSetup, runsTemplate } from './programs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const EXAMPLE = readFileSync(join(REPO, 'packages/db-schema/examples/example-router.json'), 'utf8');

// Each program's time at timeFactor 1: a fixed part, a part that scales with
// 1/sqrt(accelFactor), and a cornering part that falls as junction deviation grows.
const PROGRAMS = {
  cruise: [200, 30, 0],
  accel: [50, 150, 0],
  corners: [100, 60, 80],
  mixed: [150, 100, 2],
  poly: [230, 2, 1],
};
const TRUTH = { tf: 1.1, af: 0.7, jd: 0.03 };
const time = ([b, a, k], af, jd) => b + a / Math.sqrt(af) + k / (1 + jd / 0.02);
// A small, fixed scatter (under 0.2%), so the repeats differ.
const WOBBLE = [0.001, -0.0015, 0.0005, 0.002, -0.001, 0.0012, -0.0008];

function runsOf(files, truth = TRUTH, programs = PROGRAMS) {
  return files.map((file, i) => ({
    file,
    measured:
      Math.round(truth.tf * time(programs[file], truth.af, truth.jd) * (1 + WOBBLE[i % 7]) * 10) /
      10,
  }));
}
const modelOf =
  (runs, programs = PROGRAMS) =>
  (i, af, jd) =>
    time(programs[runs[i].file], af, jd);
const fit = (runs, programs = PROGRAMS, rules = RULES) =>
  fitFactors(modelOf(runs, programs), runs, 1, rules);
const SET = ['cruise', 'accel', 'corners', 'corners', 'mixed', 'poly'];

describe('the fit, on a model with a known truth', () => {
  it('recovers the factors, and accepts the fit', () => {
    const r = fit(runsOf(SET));
    assert.deepEqual(r.refusals, []);
    assert.equal(r.status, 'fitted');
    assert.ok(Math.abs(r.factors.timeFactor / TRUTH.tf - 1) < 0.01, JSON.stringify(r.factors));
    assert.ok(Math.abs(r.factors.accelFactor / TRUTH.af - 1) < 0.05, JSON.stringify(r.factors));
    assert.ok(
      Math.abs(r.factors.junctionDeviation / TRUTH.jd - 1) < 0.25,
      JSON.stringify(r.factors),
    );
    // Over all three factors, timeFactor included.
    assert.deepEqual(Object.keys(r.correlations).sort(), [
      'accelFactor/junctionDeviation',
      'timeFactor/accelFactor',
      'timeFactor/junctionDeviation',
    ]);
    assert.equal(r.runs.length, SET.length);
    for (const x of r.runs) assert.ok(Math.abs(x.leaveOneOutErrorPercent) < 2, JSON.stringify(x));
    assert.equal(r.candidates.length, 5);
  });

  it('is deterministic: the same inputs give the same bytes', () => {
    const a = JSON.stringify(fit(runsOf(SET)));
    const b = JSON.stringify(fit(runsOf(SET)));
    assert.equal(a, b);
  });

  it('refuses fewer than 5 runs, and a set with no repeat', () => {
    assert.throws(() => fit(runsOf(['cruise', 'accel', 'corners', 'corners'])), /at least 5/);
    assert.throws(
      () => fit(runsOf(['cruise', 'accel', 'corners', 'mixed', 'poly'])),
      /no program is timed twice/,
    );
  });

  it('refuses junction deviation resting on one run: time it twice', () => {
    const r = fit(runsOf(['cruise', 'accel', 'corners', 'mixed', 'mixed', 'poly']));
    assert.equal(r.status, 'refused');
    assert.ok(
      r.refusals.includes('junctionDeviation rests on one run (corners): time it twice'),
      r.refusals.join('\n'),
    );
  });

  it('refuses factors these runs cannot tell apart', () => {
    // Every program's accel and cornering parts move together: no run separates them.
    const tied = {
      a: [200, 10, 10],
      b: [50, 100, 100],
      c: [100, 50, 50],
      d: [150, 30, 30],
      e: [230, 5, 5],
    };
    const runs = runsOf(['a', 'b', 'c', 'c', 'd', 'e'], TRUTH, tied);
    const r = fit(runs, tied);
    assert.equal(r.status, 'refused');
    assert.ok(
      r.refusals.some((x) => /trade off|not separable|singular|ill-conditioned/.test(x)),
      r.refusals.join('\n'),
    );
  });

  it('refuses a second valley as good as the best', () => {
    // Times depend on (ln accelFactor)², so 0.5 and 2 fit exactly as well.
    const sym = Object.fromEntries(Object.entries(PROGRAMS).map(([k, v]) => [k, v]));
    const symTime = ([b, a, kk], af, jd) => b + a * (1 + Math.log(af) ** 2) + kk / (1 + jd / 0.02);
    const runs = SET.map((file, i) => ({
      file,
      measured: Math.round(symTime(sym[file], 2, 0.03) * (1 + WOBBLE[i]) * 10) / 10,
    }));
    const r = fitFactors((i, af, jd) => symTime(sym[runs[i].file], af, jd), runs, 1);
    assert.ok(
      r.refusals.some((x) => x.startsWith('not separable with these runs')),
      r.refusals.join('\n'),
    );
  });

  it('refuses a factor on its bound: never clamped', () => {
    const r = fit(runsOf(SET, { ...TRUTH, af: 0.1 }));
    assert.ok(
      r.refusals.some((x) => x.startsWith('accelFactor landed on its bound')),
      r.refusals.join('\n'),
    );
    const j = fit(runsOf(SET, { ...TRUTH, jd: 3 }));
    assert.ok(
      j.refusals.some((x) => x.startsWith('junctionDeviation landed on its bound')),
      j.refusals.join('\n'),
    );
  });

  it('warns of an undetermined factor, and marks it so acceptance keeps the record value (the rule, at a zero tolerance)', () => {
    const r = fit(runsOf(SET), PROGRAMS, { ...RULES, weakSePercent: 0 });
    assert.equal(r.status, 'fitted');
    assert.equal(r.warnings.length, 3);
    assert.match(r.warnings[2], /^junctionDeviation is undetermined/);
    assert.deepEqual(
      r.undetermined,
      ['timeFactor', 'accelFactor', 'junctionDeviation'].map((factor) => ({
        factor,
        standardErrorPercent: r.standardErrorPercent[factor],
      })),
    );
    const plain = fit(runsOf(SET));
    assert.deepEqual(plain.warnings, []);
    assert.deepEqual(plain.undetermined, []);
  });

  it('scales the errors up for misfit, never down, and says by how much', () => {
    const check = (r) => {
      const ratio = r.chi2 / r.dof;
      assert.equal(r.birge.applied, ratio > 1);
      assert.ok(
        Math.abs(r.birge.factor - Math.sqrt(Math.max(1, ratio))) < 1e-4,
        JSON.stringify(r.birge),
      );
    };
    const good = fit(runsOf(SET));
    check(good);
    // Model error the repeats can't see: one program 4% slow, both its runs.
    const runs = runsOf(SET).map((x) =>
      x.file === 'mixed' ? { ...x, measured: Math.round(x.measured * 1.04 * 10) / 10 } : x,
    );
    const bad = fit(runs);
    check(bad);
    assert.equal(bad.birge.applied, true);
    assert.ok(bad.birge.factor > 1.5, JSON.stringify(bad.birge));
  });

  it('refuses a fit that hangs on one run (the rule, at a zero tolerance)', () => {
    const r = fit(runsOf(SET), PROGRAMS, { ...RULES, looSe: 0 });
    assert.ok(
      r.refusals.some((x) => x.startsWith('the fit hangs on one run')),
      r.refusals.join('\n'),
    );
  });
});

describe('the noise', () => {
  it("floors each run at the timer's resolution over its own time", () => {
    const n = noise(
      [
        { file: 'a', measured: 30 },
        { file: 'b', measured: 300 },
        { file: 'b', measured: 300 },
      ],
      1,
    );
    assert.equal(n.pooled, 0);
    assert.equal(n.repeatDof, 1);
    assert.deepEqual(n.sigma, [1 / 30, 1 / 300, 1 / 300]);
  });

  it('pools the repeats, and uses them where they are larger', () => {
    const n = noise(
      [
        { file: 'a', measured: 100 },
        { file: 'a', measured: 102 },
        { file: 'b', measured: 300 },
      ],
      1,
    );
    const s = Math.abs(Math.log(102) - Math.log(100)) / Math.SQRT2;
    assert.ok(Math.abs(n.pooled - s) < 1e-12);
    assert.ok(n.sigma.every((x) => Math.abs(x - s) < 1e-12));
  });
});

// End to end: programs from the fictional example, timed by the estimator at known
// factors, written as the operator would.
const TRUE_FACTORS = { timeFactor: 1.08, accelFactor: 0.8, junctionDeviation: 0.05 };
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const server = await import(join(REPO, 'packages/server/dist/index.js'));
const db = await import(join(REPO, 'packages/db-schema/dist/index.js'));

function session({ events = true } = {}) {
  const s = readSetup(EXAMPLE, { envelopeX: 1000, envelopeY: 800, target: 120 });
  const programs = generatePrograms(s, { events });
  const runs = runsTemplate(s, programs);
  const { machine, dialect } = server.mapRecord(db.readMachine(EXAMPLE).record);
  const truth = (gcode) =>
    core.estimateTime(core.interpret(core.parse(gcode), { dialect }), {
      ...machine,
      junctionDeviation: TRUE_FACTORS.junctionDeviation,
      calibration: { timeFactor: TRUE_FACTORS.timeFactor, accelFactor: TRUE_FACTORS.accelFactor },
    }).totalMs / 1000;
  const bytes = new Map(programs.map((p) => [`${p.name}.nc`, Buffer.from(p.gcode)]));
  runs.runs.forEach((r, i) => {
    r.measuredSeconds =
      Math.round(truth(bytes.get(r.file).toString()) * (1 + WOBBLE[i % 7] / 4) * 10) / 10;
    r.date = '2026-10-27';
  });
  const corners = runs.runs.find((r) => r.file === 'cal-03-corners.nc');
  runs.runs.push({
    ...corners,
    measuredSeconds: Math.round(corners.measuredSeconds * 1.001 * 10) / 10,
  });
  const rapids = runs.runs.find((r) => r.file === 'cal-01-rapids.nc');
  runs.runs.push({ ...rapids, overrides: { feedPercent: 50, rapidPercent: 100 } });
  return { runs, bytes };
}

describe('runFit, end to end on the fictional example', () => {
  const { runs, bytes } = session();
  const input = (over = {}) => ({
    recordText: EXAMPLE,
    runsText: JSON.stringify(runs),
    readProgram: (f) => {
      const b = bytes.get(f);
      if (!b) throw new Error(`no ${f}`);
      return b;
    },
    ...over,
  });
  const result = runFit(input());

  it('fits the motion programs at 100/100 and recovers the factors', () => {
    assert.equal(result.format, FIT_FORMAT);
    assert.deepEqual(result.refusals, []);
    assert.equal(result.status, 'fitted');
    for (const [k, v] of Object.entries(TRUE_FACTORS)) {
      const tol = k === 'junctionDeviation' ? 0.3 : 0.03;
      assert.ok(Math.abs(result.factors[k] / v - 1) < tol, `${k}: ${result.factors[k]}`);
    }
    // The events program and the override run are reported, never fitted.
    assert.ok(!result.runs.some((r) => r.file === 'cal-07-events.nc'));
    assert.equal(result.runs.length, 7);
    assert.equal(result.reported.events.length, 1);
    assert.equal(result.reported.overrides.length, 1);
    assert.ok(Math.abs(result.reported.overrides[0].ratioToFull - 1) < 0.01);
    assert.ok(result.reported.rapidModel.length > 0);
  });

  it('carries its provenance, and says a fit is not acceptance', () => {
    const p = result.provenance;
    assert.match(p.toolkitCommit, /^[0-9a-f]{40}$/);
    assert.equal(typeof p.toolkitDirty, 'boolean');
    assert.equal(p.record.hash, runs.record.hash);
    assert.equal(p.runsSha256, createHash('sha256').update(JSON.stringify(runs)).digest('hex'));
    assert.equal(p.programs.length, 7);
    for (const x of p.programs) {
      assert.equal(x.sha256, createHash('sha256').update(bytes.get(x.file)).digest('hex'));
    }
    assert.match(result.notAcceptance, /not acceptance/);
  });

  it('names programs and hashes, never their text', () => {
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /CALIBRATION AIR CUT|G53 G0|\bG1 X/);
    // Not a machine record, by its format.
    assert.equal(db.readMachine(text).ok, false);
  });

  it('refuses a program that is not the one timed, or another record', () => {
    const changed = (f) => Buffer.concat([bytes.get(f), Buffer.from('\n')]);
    assert.throws(
      () =>
        runFit(
          input({ readProgram: (f) => (f === 'cal-02-feeds.nc' ? changed(f) : bytes.get(f)) }),
        ),
      /cal-02-feeds.nc: its SHA-256 isn't/,
    );
    const other = EXAMPLE.replace('"example-1"', '"example-2"');
    assert.throws(() => runFit(input({ recordText: other })), /another record/);
    const odd = structuredClone(runs);
    odd.runs[0].file = '../x.nc';
    assert.throws(() => runFit(input({ runsText: JSON.stringify(odd) })), FitError);
  });

  it('refuses mixed timing methods', () => {
    const mixed = structuredClone(runs);
    mixed.runs[1].method = 'stopwatch';
    assert.throws(() => runFit(input({ runsText: JSON.stringify(mixed) })), /mix timing methods/);
  });

  it('writes fit.json and fit.txt from the command line, the same bytes twice, outside the repo only', () => {
    const base = mkdtempSync(join(tmpdir(), 'fit-'));
    const dir = join(base, 'programs');
    mkdirSync(dir);
    for (const [f, b] of bytes) writeFileSync(join(dir, f), b);
    writeFileSync(join(base, 'record.json'), EXAMPLE);
    writeFileSync(join(base, 'runs.json'), JSON.stringify(runs));
    const cli = (out) =>
      spawnSync(
        process.execPath,
        [
          join(HERE, 'fit.mjs'),
          '--record',
          join(base, 'record.json'),
          '--runs',
          join(base, 'runs.json'),
          '--programs',
          dir,
          '--out',
          out,
        ],
        { encoding: 'utf8' },
      );
    const a = cli(join(base, 'a'));
    assert.equal(a.status, 0, a.stderr);
    const b = cli(join(base, 'b'));
    assert.equal(b.status, 0, b.stderr);
    for (const f of ['fit.json', 'fit.txt']) {
      assert.equal(
        readFileSync(join(base, 'a', f), 'utf8'),
        readFileSync(join(base, 'b', f), 'utf8'),
        f,
      );
    }
    const inside = cli(join(REPO, 'fit-out'));
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /inside the toolkit repository/);
    rmSync(base, { recursive: true, force: true });
  });
});
