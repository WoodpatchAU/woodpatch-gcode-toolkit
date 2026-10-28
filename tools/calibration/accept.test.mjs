// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The acceptance check (ADR-0050), on the FICTIONAL example record. The "production jobs"
// are small programs written here, timed by the estimator at known factors, so each pass
// and each refusal can be built on purpose.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AcceptError,
  RULES,
  motionHash,
  normalise,
  runAcceptance,
  seedPaths,
  summary,
} from './accept.mjs';
import { FIT_FORMAT, FIT_VERSION, runFit } from './fit.mjs';
import { SAFETY, generatePrograms, readSetup, runsTemplate } from './programs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../..');
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const db = await import(join(REPO, 'packages/db-schema/dist/index.js'));
const server = await import(join(REPO, 'packages/server/dist/index.js'));
const sha = (x) => createHash('sha256').update(x).digest('hex');

// The example, as a router part-way to calibration: every value entered by a person
// except the junction deviation, which is still a seed (as on a real Masso, which
// doesn't show it), and a measured tool change.
function recordWith(edit = () => {}) {
  const r = JSON.parse(
    readFileSync(join(REPO, 'packages/db-schema/examples/example-router.json'), 'utf8'),
  );
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (o.source === 'seed') o.source = 'manual';
      else Object.values(o).forEach(walk);
    }
  };
  walk(r);
  r.planner.junctionDeviation.source = 'seed';
  r.overheads.toolChangeSeconds.source = 'measured';
  edit(r);
  return `${JSON.stringify(r, null, 2)}\n`;
}
const RECORD = recordWith();
const HASH = db.readMachine(RECORD).hash;

// Calibration programs stand-ins: acceptance only needs their bytes and hashes.
const CAL = {
  'cal-01-rapids.nc': 'G21 G90\nG0 X100 Y100\nG0 X0 Y0\nM2\n',
  'cal-03-corners.nc': 'G21 G90\nG1 X50 Y0 F3000\nG1 X50 Y50\nG1 X0 Y50\nG1 X0 Y0\nM2\n',
};
const RUNS = `${JSON.stringify({
  record: { hash: HASH },
  runs: [
    { file: 'cal-01-rapids.nc', measuredSeconds: 250, date: '2026-10-26' },
    { file: 'cal-03-corners.nc', measuredSeconds: 280, date: '2026-10-27' },
    { file: 'cal-03-corners.nc', measuredSeconds: null, date: null },
  ],
})}\n`;

// Production stand-ins: pockets, profiles with corners, arcs, a zigzag, peck plunges.
function square(size, laps, feed) {
  const s = ['G21 G90', `G0 X0 Y0`, 'G0 Z5', `G1 Z-3 F600`];
  for (let i = 0; i < laps; i++) {
    s.push(`G1 X${size} Y0 F${feed}`, `G1 X${size} Y${size}`, `G1 X0 Y${size}`, 'G1 X0 Y0');
  }
  s.push('G0 Z5', 'M2');
  return `${s.join('\n')}\n`;
}
function zigzag(width, rows, feed) {
  const s = ['G21 G90', 'G0 X0 Y0', `G1 Z-2 F500`];
  for (let i = 0; i < rows; i++) s.push(`G1 X${i % 2 ? 0 : width} Y${(i + 1) * 4} F${feed}`);
  s.push('G0 Z5', 'M2');
  return `${s.join('\n')}\n`;
}
function arcs(r, laps, feed) {
  const s = ['G21 G90', `G0 X${r} Y0`, 'G1 Z-2 F500'];
  for (let i = 0; i < laps; i++) s.push(`G3 X${-r} Y0 I${-r} J0 F${feed}`, `G3 X${r} Y0 I${r} J0`);
  s.push('G0 Z5', 'M2');
  return `${s.join('\n')}\n`;
}
function pecks(n) {
  const s = ['G21 G90'];
  for (let i = 0; i < n; i++)
    s.push(`G0 X${(i % 10) * 30} Y${Math.floor(i / 10) * 30}`, 'G1 Z-10 F300', 'G0 Z5');
  s.push('M2');
  return `${s.join('\n')}\n`;
}
const JOBS = {
  'jobs/pocket.nc': square(300, 12, 4000),
  'jobs/profile.nc': square(800, 4, 6000),
  'jobs/zigzag.nc': zigzag(400, 60, 5000),
  'jobs/arcs.nc': arcs(150, 10, 3000),
  'jobs/pecks.nc': pecks(30),
};

const TRUTH = { timeFactor: 1.05, accelFactor: 0.9, junctionDeviation: 0.03 };
function trueSeconds(text, truth = TRUTH) {
  const read = db.readMachine(RECORD);
  const { machine, dialect } = server.mapRecord(read.record);
  const e = core.estimateTime(core.interpret(core.parse(text), { dialect }), {
    ...machine,
    junctionDeviation: truth.junctionDeviation,
    calibration: { timeFactor: truth.timeFactor, accelFactor: truth.accelFactor },
  });
  return e.totalMs / 1000;
}
// A small, fixed scatter, as a stopwatch gives.
const WOBBLE = [0.004, -0.006, 0.002, 0.008, -0.003, 0.005];

function timings(
  files = Object.keys(JOBS),
  { scale = {}, extra = [], method = 'controller-timer', truth = TRUTH, jobs = JOBS } = {},
) {
  return `${JSON.stringify({
    schema: 1,
    timings: [
      ...files.map((file, i) => ({
        file,
        sha256: sha(jobs[file] ?? CAL[file.replace(/^jobs\//, '')] ?? ''),
        measuredSeconds:
          Math.round(
            trueSeconds(jobs[file] ?? '', truth) * (1 + WOBBLE[i % 6]) * (scale[file] ?? 1) * 10,
          ) / 10,
        method,
        date: '2026-10-28',
        overrides: { feedPercent: 100, rapidPercent: 100 },
      })),
      ...extra,
    ],
  })}\n`;
}

function fitJson({
  factors = TRUTH,
  undetermined = [],
  status = 'fitted',
  dirty = false,
  hash = HASH,
  runsText = RUNS,
} = {}) {
  return `${JSON.stringify({
    format: FIT_FORMAT,
    version: FIT_VERSION,
    status,
    provenance: {
      toolkitDirty: dirty,
      record: { id: 'example-1', revision: 1, hash },
      runsSha256: sha(runsText),
      timerResolutionSeconds: 1,
      programs: Object.entries(CAL).map(([file, text]) => ({ file, sha256: sha(text) })),
    },
    factors,
    undetermined,
  })}\n`;
}

const CLEAN = { commit: 'test', dirty: false };
// The fit re-run is a stand-in that gives back fit.json's own content, so these tests can
// build each fit on purpose. "the fit, made again" below runs the real one.
function accept(over = {}) {
  const jobs = { ...JOBS, ...(over.jobs ?? {}) };
  const fitText = over.fitText ?? fitJson();
  return runAcceptance({
    recordText: over.recordText ?? RECORD,
    fitText,
    fitter: over.fitter ?? (() => JSON.parse(fitText)),
    runsText: over.runsText ?? RUNS,
    jobsText: over.jobsText ?? timings(),
    readJob: (f) => Buffer.from(jobs[f] ?? CAL[f.replace(/^jobs\//, '')] ?? ''),
    readProgram: (f) => {
      if (!(f in CAL)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      return Buffer.from(CAL[f]);
    },
    toolkit: over.toolkit ?? CLEAN,
    keep: over.keep ?? null,
    rules: over.rules ?? RULES,
  });
}
const KEEP = { field: 'junctionDeviation', operator: 'Test Operator', decidedOn: '2026-10-28' };

describe('acceptance, on production jobs', () => {
  it('accepts a fit that predicts every job within ±5%, and writes a candidate record', () => {
    const { report, recordOut } = accept();
    assert.deepEqual(report.refusals, []);
    assert.equal(report.status, 'accepted');
    const back = db.readMachine(recordOut);
    assert.ok(back.ok, JSON.stringify(back.problems));
    const r = back.record;
    // The same machine and schema revision: the content hash tells the two apart.
    assert.equal(r.id, 'example-1');
    assert.equal(r.revision, 1);
    assert.equal(report.provenance.record.hashBefore, HASH);
    assert.equal(report.provenance.record.hashAfter, back.hash);
    assert.notEqual(back.hash, HASH);
    assert.equal(r.calibration.status, 'calibrated');
    assert.equal(r.calibration.timeFactor, TRUTH.timeFactor);
    assert.equal(r.calibration.accelFactor, TRUTH.accelFactor);
    assert.deepEqual({ ...r.planner.junctionDeviation }, { value: 0.03, source: 'fitted' });
    assert.equal(r.calibration.residuals.jobs, 5);
    assert.ok(r.calibration.residuals.maxAbsPercent < 1.5, JSON.stringify(r.calibration));
    // The latest calibration run it rests on: never the clock, never a job's date.
    assert.equal(r.calibration.fittedOn, '2026-10-27');
    assert.deepEqual(seedPaths(r), []);
    assert.match(summary(report), /^Calibration acceptance .*: ACCEPTED/);
  });

  it('is deterministic: the same inputs give the same bytes', () => {
    const a = accept();
    const b = accept();
    assert.equal(JSON.stringify(a.report), JSON.stringify(b.report));
    assert.equal(a.recordOut, b.recordOut);
  });

  it('refuses a job outside ±5%, and writes no record', () => {
    const { report, recordOut } = accept({
      jobsText: timings(undefined, { scale: { 'jobs/arcs.nc': 1.07 } }),
    });
    assert.equal(report.status, 'refused');
    assert.equal(recordOut, null);
    assert.ok(
      report.refusals.some(
        (x) => x.startsWith('jobs/arcs.nc: the estimate is') && x.includes('outside ±5%'),
      ),
      report.refusals.join('\n'),
    );
  });

  it('counts distinct programs by what they do, not by file name', () => {
    // pocket.nc saved again as a "-v2" copy by a CAM re-post: other text, the same motion.
    const repost = JOBS['jobs/pocket.nc']
      .split('\n')
      .filter(Boolean)
      .map((l, i) => `N${(i + 1) * 10} ${l.replace(/^G1 /, 'G01 ').replace(/X(\d+)/g, 'X$1.000')}`)
      .join('\n');
    const jobs = { 'jobs/pocket-v2.nc': `${repost}\n` };
    const files = [...Object.keys(JOBS).slice(0, 4), 'jobs/pocket-v2.nc'];
    const { report, recordOut } = accept({
      jobs,
      jobsText: timings(files, { jobs: { ...JOBS, ...jobs } }),
    });
    assert.equal(report.status, 'refused');
    assert.equal(recordOut, null);
    assert.ok(
      report.refusals.includes(
        'jobs/pocket-v2.nc, jobs/pocket.nc are the same program (the same motion): time it under one name, and enter repeats as more timings of that file',
      ),
      report.refusals.join('\n'),
    );
    assert.ok(
      report.refusals.includes('4 production jobs: acceptance needs at least 5 distinct programs'),
      report.refusals.join('\n'),
    );
  });

  it('refuses fewer than 5 distinct jobs (a repeat counts once)', () => {
    const files = Object.keys(JOBS).slice(0, 4);
    const { report } = accept({ jobsText: timings([...files, files[0]]) });
    assert.ok(
      report.refusals.includes('4 production jobs: acceptance needs at least 5 distinct programs'),
      report.refusals.join('\n'),
    );
  });

  it('refuses a job whose repeat timings spread past the tolerance', () => {
    const t = JSON.parse(timings());
    t.timings.push({
      ...t.timings[0],
      measuredSeconds: Math.round(t.timings[0].measuredSeconds * 1.08),
    });
    const { report } = accept({ jobsText: `${JSON.stringify(t)}\n` });
    assert.ok(
      report.refusals.some((x) => x.startsWith('jobs/pocket.nc: its timings spread')),
      report.refusals.join('\n'),
    );
    const j = report.jobs.find((x) => x.file === 'jobs/pocket.nc');
    assert.equal(j.measuredSeconds.length, 2);
    assert.ok(j.spreadPercent > 5);
  });

  it('refuses a calibration program passed off as a job, even saved again', () => {
    // Raw bytes, and the same program re-saved: CRLF, a comment, other case and spacing.
    const resaved = `(re-saved)\r\n${CAL['cal-03-corners.nc'].replaceAll('\n', ' ; ok\r\n').toLowerCase()}`;
    assert.equal(normalise(resaved), normalise(CAL['cal-03-corners.nc']));
    for (const text of [CAL['cal-03-corners.nc'], resaved]) {
      const jobs = { ...JOBS, 'jobs/cal-03-corners.nc': text };
      const t = JSON.parse(timings());
      t.timings.push({
        ...t.timings[0],
        file: 'jobs/cal-03-corners.nc',
        sha256: sha(text),
        measuredSeconds: 280,
      });
      const { report } = accept({ jobs, jobsText: `${JSON.stringify(t)}\n` });
      assert.ok(
        report.refusals.includes(
          'jobs/cal-03-corners.nc is the calibration program cal-03-corners.nc: acceptance never grades the fit on its own programs',
        ),
        report.refusals.join('\n'),
      );
    }
  });

  it('refuses a calibration program re-posted by CAM or a controller', () => {
    // The six re-post variants the reviewer probed: none of them survives normalise().
    const base = CAL['cal-03-corners.nc'];
    const variants = {
      'N numbers': base.replace(/^/gm, (_, o) => `N${o + 1} `),
      'G01 for G1': base.replaceAll('G1 ', 'G01 '),
      'X50.000': base.replaceAll('X50', 'X50.000'),
      'word order': base.replace('G1 X50 Y0 F3000', 'G1 F3000 Y0 X50'),
      'an O-number': `O1234\n${base}`,
      'a split modal line': base.replace('G1 X50 Y50', 'G1\nX50 Y50'),
    };
    const dialect = server.mapRecord(db.readMachine(RECORD).record).dialect;
    for (const [name, text] of Object.entries(variants)) {
      assert.notEqual(normalise(text), normalise(base), name);
      assert.equal(motionHash(text, dialect), motionHash(base, dialect), name);
      const t = JSON.parse(timings());
      t.timings.push({ ...t.timings[0], file: 'jobs/x.nc', sha256: sha(text) });
      const { report } = accept({
        jobs: { 'jobs/x.nc': text },
        jobsText: `${JSON.stringify(t)}\n`,
      });
      assert.ok(
        report.refusals.includes(
          'jobs/x.nc is the calibration program cal-03-corners.nc: acceptance never grades the fit on its own programs',
        ),
        `${name}: ${report.refusals.join('\n')}`,
      );
    }
  });

  it("refuses a job carrying the generator's air-cut header", () => {
    const text = `(${SAFETY[0].toLowerCase()})\n${JOBS['jobs/arcs.nc']}`;
    const t = JSON.parse(timings());
    t.timings[3] = { ...t.timings[3], sha256: sha(text) };
    const { report } = accept({
      jobs: { 'jobs/arcs.nc': text },
      jobsText: `${JSON.stringify(t)}\n`,
    });
    assert.ok(
      report.refusals.includes(
        "jobs/arcs.nc carries the calibration programs' air-cut header: acceptance never grades the fit on its own programs",
      ),
      report.refusals.join('\n'),
    );
  });

  it('refuses a job timed before the calibration runs, and a job date never sets fittedOn', () => {
    const early = JSON.parse(timings());
    early.timings[2].date = '2019-03-01';
    const { report } = accept({ jobsText: `${JSON.stringify(early)}\n` });
    assert.ok(
      report.refusals.includes(
        'jobs/zigzag.nc: timed on 2019-03-01, before the calibration runs (2026-10-26): it grades an earlier state of the machine; time it again',
      ),
      report.refusals.join('\n'),
    );
    const late = JSON.parse(timings());
    late.timings[2].date = '2099-12-31';
    const ok = accept({ jobsText: `${JSON.stringify(late)}\n` });
    assert.deepEqual(ok.report.refusals, []);
    assert.equal(ok.report.fittedOn, '2026-10-27');
  });

  it('refuses a seed left in the record: measured, never relabelled', () => {
    const recordText = recordWith((r) => {
      r.overheads.toolChangeSeconds.source = 'seed';
    });
    const hash = db.readMachine(recordText).hash;
    const { report, recordOut } = accept({ recordText, fitText: fitJson({ hash }) });
    assert.equal(report.status, 'refused');
    assert.equal(recordOut, null);
    assert.ok(
      report.refusals.includes(
        'overheads.toolChangeSeconds is still a seed: measure it and enter it as "measured"',
      ),
      report.refusals.join('\n'),
    );
  });
});

describe('the inputs it refuses outright', () => {
  const cases = [
    ['a fit that was refused', { fitText: fitJson({ status: 'refused' }) }, /only a fitted fit/],
    ['a fit from a tree with changes', { fitText: fitJson({ dirty: true }) }, /tree with changes/],
    [
      "a fit that doesn't say whether its tree had changes",
      {
        fitText: (() => {
          const f = JSON.parse(fitJson());
          delete f.provenance.toolkitDirty;
          return JSON.stringify(f);
        })(),
      },
      /tree with changes/,
    ],
    [
      "a fit.json that isn't what the fit makes (an undetermined entry taken out)",
      {
        fitText: fitJson(),
        fitter: () =>
          JSON.parse(
            fitJson({ undetermined: [{ factor: 'junctionDeviation', standardErrorPercent: 55 }] }),
          ),
      },
      /isn't what the fit makes/,
    ],
    [
      'a calibration program that is missing',
      {
        fitText: (() => {
          const f = JSON.parse(fitJson());
          f.provenance.programs.push({ file: 'cal-09-gone.nc', sha256: 'a'.repeat(64) });
          return JSON.stringify(f);
        })(),
      },
      /cal-09-gone.nc: the calibration program can't be read \(ENOENT\)/,
    ],
    [
      'a timed run without a real date',
      (() => {
        const runs = JSON.parse(RUNS);
        runs.runs[0].date = '2026-13-01';
        const runsText = JSON.stringify(runs);
        return { runsText, fitText: fitJson({ runsText }) };
      })(),
      /needs a real date/,
    ],
    [
      'a measured time that overflows',
      { jobsText: timings().replace(/"measuredSeconds":[0-9.]+/, '"measuredSeconds":1e400') },
      /positive number of seconds/,
    ],
    ['a fit of another record', { fitText: fitJson({ hash: 'f'.repeat(64) }) }, /another record/],
    [
      'a toolkit tree with changes',
      { toolkit: { commit: 'x', dirty: true } },
      /accept from a clean tree/,
    ],
    ['another runs file', { runsText: `${RUNS} ` }, /isn't the one the fit read/],
    [
      'mixed timing methods',
      {
        jobsText: (() => {
          const t = JSON.parse(timings());
          t.timings[1].method = 'stopwatch';
          return `${JSON.stringify(t)}\n`;
        })(),
      },
      /mix timing methods/,
    ],
    [
      'a job at another override',
      {
        jobsText: (() => {
          const t = JSON.parse(timings());
          t.timings[0].overrides.feedPercent = 90;
          return `${JSON.stringify(t)}\n`;
        })(),
      },
      /100% feed and rapid/,
    ],
    [
      'a job path that climbs out',
      {
        jobsText: (() => {
          const t = JSON.parse(timings());
          t.timings[0].file = '../secret.nc';
          return `${JSON.stringify(t)}\n`;
        })(),
      },
      /plain relative path/,
    ],
    [
      'a job whose bytes changed',
      { jobs: { 'jobs/arcs.nc': `${JOBS['jobs/arcs.nc']}G0 X1\n` } },
      /SHA-256 isn't the one recorded/,
    ],
    ['--keep on a fitted junction deviation', { keep: KEEP }, /only to an undetermined/],
    [
      '--keep on a junction deviation that is not a seed',
      {
        recordText: recordWith((r) => {
          r.planner.junctionDeviation.source = 'manual';
        }),
        fitText: (() => {
          const recordText = recordWith((r) => {
            r.planner.junctionDeviation.source = 'manual';
          });
          return fitJson({
            hash: db.readMachine(recordText).hash,
            factors: { ...TRUTH, junctionDeviation: 0.025 },
            undetermined: [{ factor: 'junctionDeviation', standardErrorPercent: 30 }],
          });
        })(),
        keep: KEEP,
      },
      /not a seed \(it is "manual"\): there is nothing to keep/,
    ],
  ];
  for (const [name, over, re] of cases) {
    it(name, () =>
      assert.throws(
        () => accept(over),
        (e) => e instanceof AcceptError && re.test(e.message),
      ),
    );
  }
});

describe('an undetermined factor', () => {
  const und = (se) =>
    fitJson({
      factors: { ...TRUTH, junctionDeviation: 0.025 },
      undetermined: [{ factor: 'junctionDeviation', standardErrorPercent: se }],
    });

  it('keeps the record value when it does not matter, but only by an explicit --keep', () => {
    const without = accept({ fitText: und(30) });
    assert.ok(
      without.report.refusals.some((x) =>
        x.startsWith('junctionDeviation is undetermined and still a seed'),
      ),
      without.report.refusals.join('\n'),
    );
    const { report, recordOut } = accept({ fitText: und(30), keep: KEEP });
    assert.deepEqual(report.refusals, []);
    const r = db.readMachine(recordOut).record;
    // The record's value, kept, now a person's decision: never "fitted".
    assert.deepEqual({ ...r.planner.junctionDeviation }, { value: 0.02, source: 'manual' });
    assert.equal(report.keep.operator, 'Test Operator');
    assert.equal(report.keep.decidedOn, '2026-10-28');
    assert.equal(report.keep.justifiedBy.factor, 'junctionDeviation');
    // Tested at ±2 SE in log space, both ends shown for every job.
    const s = report.sensitivity;
    assert.ok(Math.abs(s.range[0] - 0.02 / 1.3 ** 2) < 1e-6, JSON.stringify(s.range));
    assert.ok(Math.abs(s.range[1] - 0.02 * 1.3 ** 2) < 1e-6, JSON.stringify(s.range));
    assert.equal(s.jobs.length, 5);
    assert.ok(s.exercised);
    assert.ok(s.worstPercent <= 1, JSON.stringify(s));
  });

  it('refuses it when it matters for these jobs', () => {
    const { report } = accept({ fitText: und(300), keep: KEEP });
    assert.equal(report.status, 'refused');
    assert.ok(
      report.refusals.some((x) => x.startsWith('junctionDeviation matters for these jobs')),
      report.refusals.join('\n'),
    );
  });

  it("tests the whole ±2 SE range, clamped to the fit's box", () => {
    // ±1000%: 0.02 × 11² is past the box's 1 mm, 0.02 / 11² under its 0.001 mm.
    const { report } = accept({ fitText: und(1000), keep: KEEP });
    assert.deepEqual(report.sensitivity.range, [0.001, 1]);
  });

  it('counts a move at either end: corners slowed only at the low end', () => {
    // At 300 mm/min the corners are slowed below the kept 0.02 mm, never above it: every
    // high end is 0, so only the low end shows the factor is exercised, and how much.
    const sq = (size) =>
      `G21 G90\nG0 X0 Y0\nG1 X${size} Y0 F300\nG1 X${size} Y${size}\nG1 X0 Y${size}\nG1 X0 Y0\nM2\n`;
    const jobs = Object.fromEntries(
      [100, 110, 120, 130, 140].map((n) => [`jobs/sq-${n}.nc`, sq(n)]),
    );
    const { report } = accept({
      jobs,
      jobsText: timings(Object.keys(jobs), { jobs }),
      fitText: und(30),
      keep: KEEP,
    });
    const s = report.sensitivity;
    assert.ok(
      s.jobs.every((r) => r.highPercent === 0),
      JSON.stringify(s.jobs),
    );
    assert.ok(
      s.jobs.some((r) => r.lowPercent !== 0),
      JSON.stringify(s.jobs),
    );
    assert.equal(s.exercised, true);
    assert.equal(s.worstPercent, Math.max(...s.jobs.map((r) => Math.abs(r.lowPercent))));
    assert.deepEqual(report.refusals, []);
    assert.equal(report.keep.operator, 'Test Operator');
  });

  it('on a refused run, keeps nothing and reports no --keep', () => {
    const { report, recordOut } = accept({
      fitText: und(30),
      keep: KEEP,
      jobsText: timings(undefined, { scale: { 'jobs/arcs.nc': 1.07 } }),
    });
    assert.equal(report.status, 'refused');
    assert.equal(recordOut, null);
    assert.equal(report.keep, null);
    assert.deepEqual(
      { ...report.factors.junctionDeviation.before },
      { value: 0.02, source: 'seed' },
    );
    assert.equal(report.factors.junctionDeviation.source, 'seed');
  });

  it('refuses an undetermined accelFactor: there is no record value to keep', () => {
    const fitText = fitJson({
      undetermined: [{ factor: 'accelFactor', standardErrorPercent: 40 }],
    });
    const { report } = accept({ fitText });
    assert.ok(
      report.refusals.some((x) => x.startsWith('accelFactor is undetermined')),
      report.refusals.join('\n'),
    );
  });

  it('refuses to keep a seed that no job exercises', () => {
    // Single straight moves: no junction, so the junction deviation never shows.
    const line = (n) => `G21 G90\nG1 X${n * 100} Y${n * 50} F2000\nM2\n`;
    const jobs = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`jobs/line-${n}.nc`, line(n)]));
    const t = {
      schema: 1,
      timings: Object.entries(jobs).map(([file, text]) => ({
        file,
        sha256: sha(text),
        measuredSeconds: Math.round(trueSeconds(text) * 10) / 10,
        method: 'controller-timer',
        date: '2026-10-28',
        overrides: { feedPercent: 100, rapidPercent: 100 },
      })),
    };
    const { report } = accept({
      jobs,
      jobsText: `${JSON.stringify(t)}\n`,
      fitText: und(30),
      keep: KEEP,
    });
    assert.equal(report.sensitivity.exercised, false);
    assert.ok(
      report.refusals.includes(
        'junctionDeviation is a seed no job exercises: there is no evidence to keep it, so it must be measured',
      ),
      report.refusals.join('\n'),
    );
  });

  it("refuses a kept value the fit's runs place elsewhere", () => {
    const fitText = fitJson({
      factors: { ...TRUTH, junctionDeviation: 0.2 },
      undetermined: [{ factor: 'junctionDeviation', standardErrorPercent: 30 }],
    });
    const { report } = accept({ fitText, keep: KEEP });
    assert.ok(
      report.refusals.some((x) => x.includes('the runs place it elsewhere')),
      report.refusals.join('\n'),
    );
  });

  it('refuses an undetermined timeFactor: there is no record value to keep', () => {
    const fitText = fitJson({ undetermined: [{ factor: 'timeFactor', standardErrorPercent: 40 }] });
    const { report } = accept({ fitText });
    assert.ok(
      report.refusals.some((x) => x.startsWith('timeFactor is undetermined')),
      report.refusals.join('\n'),
    );
  });

  it('needs the operator and the date on a --keep', () => {
    assert.throws(
      () => accept({ fitText: und(30), keep: { ...KEEP, operator: '' } }),
      /--operator/,
    );
    assert.throws(
      () => accept({ fitText: und(30), keep: { ...KEEP, decidedOn: '2026-02-30' } }),
      /--decided-on/,
    );
  });
});

// A real fit, made once: the fictional example's calibration programs, timed by the
// estimator at known factors, as fit.test.mjs does. Its junction deviation comes out
// undetermined, as a real router's can. The fit takes about half a minute, so the
// in-process tests hand this result back as the re-run; the command line runs it for real.
const REAL_TRUTH = { timeFactor: 1.08, accelFactor: 0.8, junctionDeviation: 0.05 };
const REAL = (() => {
  const s = readSetup(RECORD, { envelopeX: 1000, envelopeY: 800, target: 120 });
  const programs = generatePrograms(s, { events: true });
  const runs = runsTemplate(s, programs);
  const bytes = new Map(programs.map((p) => [`${p.name}.nc`, Buffer.from(p.gcode)]));
  runs.runs.forEach((r, i) => {
    r.measuredSeconds =
      Math.round(
        trueSeconds(bytes.get(r.file).toString(), REAL_TRUTH) * (1 + WOBBLE[i % 6] / 4) * 10,
      ) / 10;
    r.date = '2026-10-27';
    r.method = 'controller-timer';
  });
  const corners = runs.runs.find((r) => r.file === 'cal-03-corners.nc');
  runs.runs.push({
    ...corners,
    measuredSeconds: Math.round(corners.measuredSeconds * 1.001 * 10) / 10,
  });
  const runsText = `${JSON.stringify(runs, null, 2)}\n`;
  const readProgram = (f) => bytes.get(f);
  const fit = runFit({ recordText: RECORD, runsText, readProgram });
  // As fit.mjs would write it on a clean tree.
  fit.provenance.toolkitDirty = false;
  const sq = (size) =>
    `G21 G90\nG0 X0 Y0\nG1 X${size} Y0 F300\nG1 X${size} Y${size}\nG1 X0 Y${size}\nG1 X0 Y0\nM2\n`;
  const jobs = Object.fromEntries([100, 110, 120, 130, 140].map((n) => [`jobs/sq-${n}.nc`, sq(n)]));
  return {
    bytes,
    runsText,
    readProgram,
    fit,
    fitText: `${JSON.stringify(fit, null, 2)}\n`,
    jobs,
    jobsText: timings(Object.keys(jobs), { jobs, truth: REAL_TRUTH }),
  };
})();

describe('the fit, made again', () => {
  const acceptReal = (fitText, over = {}) =>
    runAcceptance({
      recordText: RECORD,
      fitText,
      runsText: REAL.runsText,
      jobsText: REAL.jobsText,
      readJob: (f) => Buffer.from(REAL.jobs[f]),
      readProgram: REAL.readProgram,
      toolkit: CLEAN,
      keep: KEEP,
      fitter: () => structuredClone(REAL.fit),
      ...over,
    });

  it('accepts fit.json as the fit made it', () => {
    assert.equal(REAL.fit.status, 'fitted');
    assert.deepEqual(
      REAL.fit.undetermined.map((u) => u.factor),
      ['junctionDeviation'],
    );
    const { report, recordOut } = acceptReal(REAL.fitText);
    assert.deepEqual(report.refusals, []);
    const r = db.readMachine(recordOut).record;
    assert.equal(r.calibration.timeFactor, REAL.fit.factors.timeFactor);
    assert.deepEqual({ ...r.planner.junctionDeviation }, { value: 0.02, source: 'manual' });
  });

  // Each edit would once have changed what acceptance checked (reviewer, #84).
  const edits = {
    'its programs emptied (no calibration program to refuse)': (f) => {
      f.provenance.programs = [];
    },
    'junctionDeviation taken out of undetermined (written as "fitted")': (f) => {
      f.undetermined = [];
    },
    'a factor moved': (f) => {
      f.factors.timeFactor = 1;
    },
    'a standard error shrunk': (f) => {
      f.undetermined[0].standardErrorPercent = 1;
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    it(`refuses fit.json with ${name}`, () => {
      const f = JSON.parse(REAL.fitText);
      edit(f);
      assert.throws(
        () => acceptReal(JSON.stringify(f)),
        (e) => e instanceof AcceptError && /isn't what the fit makes/.test(e.message),
      );
    });
  }

  it("turns the fit's own refusal of its input into an AcceptError", () => {
    assert.throws(
      () =>
        acceptReal(REAL.fitText, {
          fitter: (input) => runFit({ ...input, recordText: recordWith((r) => (r.id = 'other')) }),
        }),
      (e) => e instanceof AcceptError && /^fitting again from the runs: /.test(e.message),
    );
  });
});

describe('the command line', () => {
  const run = (args) =>
    spawnSync(process.execPath, [join(HERE, 'accept.mjs'), ...args], { encoding: 'utf8' });

  it('fits again, and writes the same bytes as the check in process (or refuses a tree with changes)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'accept-'));
    try {
      const put = (name, text) => {
        const p = join(dir, name);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
        return p;
      };
      for (const [f, b] of REAL.bytes) put(join('programs', f), b);
      for (const [f, t] of Object.entries(REAL.jobs)) put(join('root', f), t);
      const r = run([
        '--record',
        put('record.json', RECORD),
        '--fit',
        put('fit.json', REAL.fitText),
        '--runs',
        put('runs.json', REAL.runsText),
        '--programs',
        join(dir, 'programs'),
        '--jobs',
        put('timings.json', REAL.jobsText),
        '--jobs-root',
        join(dir, 'root'),
        '--out',
        join(dir, 'out'),
        '--keep',
        KEEP.field,
        '--operator',
        KEEP.operator,
        '--decided-on',
        KEEP.decidedOn,
      ]);
      const dirty =
        spawnSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' }).stdout
          .length > 0;
      if (dirty) {
        // Locally, mid-edit. CI always checks out a clean tree, so there it's a failure.
        assert.ok(!process.env.CI, 'CI ran the acceptance tests on a tree with changes');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /accept from a clean tree/);
        return;
      }
      assert.equal(r.status, 0, r.stderr);
      const commit = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).stdout.trim();
      const { report, recordOut } = runAcceptance({
        recordText: RECORD,
        fitText: REAL.fitText,
        runsText: REAL.runsText,
        jobsText: REAL.jobsText,
        readJob: (f) => Buffer.from(REAL.jobs[f]),
        readProgram: REAL.readProgram,
        toolkit: { commit, dirty: false },
        keep: KEEP,
        fitter: () => structuredClone(REAL.fit),
      });
      const out = (f) => readFileSync(join(dir, 'out', f), 'utf8');
      assert.equal(out('accept.json'), `${JSON.stringify(report, null, 2)}\n`);
      assert.equal(out('accept.txt'), summary(report));
      assert.equal(out('record.json'), recordOut);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const BASE = ['--record', 'x', '--fit', 'x', '--runs', 'x', '--programs', 'x', '--jobs', 'x'];
  const REST = ['--jobs-root', 'x', '--out', join(tmpdir(), 'accept-never')];

  it('refuses a flag given twice, and --operator without --keep', () => {
    const twice = run([...BASE, ...REST, '--fit', 'y']);
    assert.equal(twice.status, 1);
    assert.match(twice.stderr, /--fit is given twice/);
    const stray = run([...BASE, ...REST, '--operator', 'Someone']);
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /go with --keep, and only with it/);
  });

  it('refuses an --out inside the repository', () => {
    const r = run([...BASE, '--jobs-root', 'x', '--out', join(REPO, 'nope')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /inside the toolkit repository/);
  });
});
