// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The acceptance check (ADR-0050): a fit (ADR-0049) graded on real production jobs, not on
// the programs it was fitted to. Every job must come within ±5% of its measured time.
// Only a pass writes a CANDIDATE calibrated record. The storing application's own flow
// adopts it (ADR-0041): the toolkit proposes, it never sets a machine's status itself.
//
//   node tools/calibration/accept.mjs --record <record.json> --fit <fit.json>
//     --runs <calibration-runs.json> --programs <the calibration programs' dir>
//     --jobs <timings.json> --jobs-root <dir> --out <new dir>
//     [--keep junctionDeviation --operator <name> --decided-on <YYYY-MM-DD>]
//
// Everything it reads and writes is the machine's, and private: --out must be outside
// this repository. On a refusal, only the report is written.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { FIT_FORMAT, FIT_VERSION, RULES as FIT_RULES, toolkitState } from './fit.mjs';
import { ProgramsError, checkOut } from './programs.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const db = await import(join(REPO, 'packages/db-schema/dist/index.js'));
const server = await import(join(REPO, 'packages/server/dist/index.js'));

export const ACCEPT_FORMAT = 'woodpatch-gcode-acceptance';
export const ACCEPT_VERSION = 1;

/**
 * The rules' numbers, each with its reason in ADR-0050.
 * - TOLERANCE: every job within ±5% of its measured time (ADR-0041, CALIBRATION.md).
 * - MIN_JOBS: at least 5 distinct production programs.
 * - SENSITIVITY: an undetermined factor kept at the record's value may move no job's
 *   estimate by more than 1% across its ±2 SE range (in log space, about 95%), or it
 *   matters for this work and must be measured.
 * - SPREAD: a job timed more than once whose times spread (max − min, over the mean)
 *   past the tolerance is refused: the timing itself can't decide a ±5% question.
 */
export const RULES = {
  tolerancePercent: 5,
  minJobs: 5,
  sensitivityPercent: 1,
  sensitivitySe: 2,
  spreadPercent: 5,
};

/** Input the check can't use at all, as opposed to a check it refuses ("refused"). */
export class AcceptError extends ProgramsError {}

const r6 = (v) => (v === null || v === undefined ? null : Number(v.toPrecision(6)));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
// A job's path, relative to --jobs-root: plain segments, no "..", nothing absolute.
const JOB_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/){0,8}[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// The operator's name, as recorded with a --keep: printable, one line.
const OPERATOR = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,100}$/u;

/**
 * A program's text with what a re-save can change taken out: line endings, comments
 * ("(...)" and ";..." to the end of the line), all whitespace, blank lines, and case. A
 * calibration program saved again by an editor or a controller still matches its own
 * normal form, so it can't pass as a production job (reviewer's condition 4).
 */
export function normalise(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) =>
      l
        .replace(/\([^)]*\)/g, '')
        .replace(/;.*$/, '')
        .replace(/\s+/g, '')
        .toUpperCase(),
    )
    .filter((l) => l !== '' && l !== '%')
    .join('\n');
}

/** Every path in the record whose source is still "seed". */
export function seedPaths(record) {
  const out = [];
  const walk = (o, path) => {
    if (o === null || typeof o !== 'object') return;
    if (Object.hasOwn(o, 'source') && Object.hasOwn(o, 'value')) {
      if (o.source === 'seed') out.push(path);
      return;
    }
    for (const k of Object.keys(o).sort()) walk(o[k], path ? `${path}.${k}` : k);
  };
  walk(record, '');
  return out;
}

const pctOf = (estimate, measured) => (estimate / measured - 1) * 100;

/**
 * The whole check, pure: the inputs' text and bytes in, the report (and, on a pass, the
 * candidate record's text) out. `readJob(path)` and `readProgram(file)` return Buffers.
 * `toolkit` is { commit, dirty }. `keep` is null or { field, operator, decidedOn }.
 * Throws AcceptError on input it can't use.
 */
export function runAcceptance({
  recordText,
  fitText,
  runsText,
  jobsText,
  readJob,
  readProgram,
  toolkit,
  keep = null,
  rules = RULES,
}) {
  const refusals = [];

  // The record, exactly the one the fit was made from.
  const read = db.readMachine(recordText);
  if (!read.ok) {
    throw new AcceptError(
      `the record isn't valid: ${read.problems.map((p) => `${p.code} ${p.path}`).join('; ')}`,
    );
  }
  const record = read.record;
  if (record.calibration.status !== 'uncalibrated') {
    throw new AcceptError(
      'the record is already calibrated: accept a fit made from the uncalibrated record',
    );
  }

  // fit.json: a fitted fit, from a clean tree, of this record (ADR-0049's provenance).
  let fit;
  try {
    fit = JSON.parse(fitText);
  } catch {
    throw new AcceptError("fit.json isn't JSON");
  }
  if (fit?.format !== FIT_FORMAT || fit?.version !== FIT_VERSION) {
    throw new AcceptError(`fit.json isn't a ${FIT_FORMAT} v${FIT_VERSION} file`);
  }
  if (fit.status !== 'fitted') {
    throw new AcceptError(`fit.json's status is "${fit.status}": only a fitted fit is accepted`);
  }
  if (fit.provenance?.toolkitDirty !== false) {
    throw new AcceptError(
      'fit.json was made from a toolkit tree with changes: fit again from a clean tree',
    );
  }
  if (fit.provenance?.record?.hash !== read.hash) {
    throw new AcceptError(
      "fit.json was made from another record (its record hash isn't this record's)",
    );
  }
  if (toolkit.dirty) {
    throw new AcceptError('the toolkit tree has changes: accept from a clean tree');
  }

  // The runs file the fit read (its SHA-256 is in fit.json): its dates set fittedOn.
  if (sha256(runsText) !== fit.provenance.runsSha256) {
    throw new AcceptError("the runs file isn't the one the fit read (its SHA-256 differs)");
  }
  const runsFile = JSON.parse(runsText);
  const runDates = (runsFile.runs ?? [])
    .filter((r) => typeof r.measuredSeconds === 'number')
    .map((r) => r.date);
  if (runDates.some((d) => !realDate(d))) {
    throw new AcceptError('every timed run in the runs file needs a real date (YYYY-MM-DD)');
  }

  // The calibration programs, raw and normalised, so no job can be one of them.
  const calibration = (fit.provenance.programs ?? []).map(({ file, sha256: hash }) => {
    if (typeof file !== 'string' || !PLAIN_NAME.test(file)) {
      throw new AcceptError('fit.json names a program that is not a plain file name');
    }
    const bytes = readProgram(file);
    if (sha256(bytes) !== hash) {
      throw new AcceptError(`${file}: its SHA-256 isn't the one in fit.json`);
    }
    return { file, hash, normal: sha256(normalise(bytes.toString('utf8'))) };
  });

  // The jobs: production programs with measured times, one method, at 100/100.
  let jobsFile;
  try {
    jobsFile = JSON.parse(jobsText);
  } catch {
    throw new AcceptError("the jobs file isn't JSON");
  }
  const entries = jobsFile?.timings;
  if (!Array.isArray(entries)) throw new AcceptError('the jobs file has no "timings" list');
  const jobs = new Map();
  for (const t of entries) {
    if (typeof t?.file !== 'string' || !JOB_PATH.test(t.file)) {
      throw new AcceptError('a job names a file that is not a plain relative path');
    }
    if (typeof t.measuredSeconds !== 'number' || !(t.measuredSeconds > 0)) {
      throw new AcceptError(`${t.file}: measuredSeconds must be a positive number of seconds`);
    }
    if (typeof t.method !== 'string' || t.method === '') {
      throw new AcceptError(`${t.file}: each timing needs its method (how it was timed)`);
    }
    if (!realDate(t.date)) throw new AcceptError(`${t.file}: date must be a real YYYY-MM-DD`);
    if (t.overrides?.feedPercent !== 100 || t.overrides?.rapidPercent !== 100) {
      throw new AcceptError(`${t.file}: acceptance jobs are timed at 100% feed and rapid`);
    }
    let j = jobs.get(t.file);
    if (!j) {
      const bytes = readJob(t.file);
      const hash = sha256(bytes);
      const text = bytes.toString('utf8');
      j = { file: t.file, hash, text, times: [], dates: [], methods: new Set() };
      j.sameAs = calibration.find(
        (c) => c.hash === hash || c.normal === sha256(normalise(text)),
      )?.file;
      jobs.set(t.file, j);
    }
    if (t.sha256 !== j.hash) {
      throw new AcceptError(`${t.file}: its SHA-256 isn't the one recorded with its timing`);
    }
    j.times.push(t.measuredSeconds);
    j.dates.push(t.date);
    j.methods.add(t.method);
  }
  const list = [...jobs.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const methods = [...new Set(list.flatMap((j) => [...j.methods]))].sort();
  if (methods.length > 1) {
    throw new AcceptError(`the jobs mix timing methods (${methods.join(', ')}): time them one way`);
  }
  for (const j of list) {
    if (j.sameAs) {
      refusals.push(
        `${j.file} is the calibration program ${j.sameAs}: acceptance never grades the fit on its own programs`,
      );
    }
  }
  if (list.length < rules.minJobs) {
    refusals.push(
      `${list.length} production jobs: acceptance needs at least ${rules.minJobs} distinct programs`,
    );
  }

  // The candidate: the fit's factors applied, undetermined ones kept at the record's value.
  const undetermined = new Map((fit.undetermined ?? []).map((u) => [u.factor, u]));
  for (const f of ['timeFactor', 'accelFactor']) {
    if (undetermined.has(f)) {
      refusals.push(
        `${f} is undetermined (±${undetermined.get(f).standardErrorPercent}%): an uncalibrated record has no value of it to keep, so time the calibration programs again`,
      );
    }
  }
  const candidate = structuredClone(record);
  const jdBefore = { ...record.planner.junctionDeviation };
  const jdUndetermined = undetermined.get('junctionDeviation');
  if (!jdUndetermined) {
    candidate.planner.junctionDeviation = {
      value: fit.factors.junctionDeviation,
      source: 'fitted',
    };
  }
  if (keep) {
    if (keep.field !== 'junctionDeviation' || !jdUndetermined) {
      throw new AcceptError(
        '--keep applies only to an undetermined junctionDeviation (fit.json lists it): a field no fit measured is never kept, it is measured',
      );
    }
    if (typeof keep.operator !== 'string' || !OPERATOR.test(keep.operator)) {
      throw new AcceptError('--keep needs --operator: the name of the person who decided it');
    }
    if (!realDate(keep.decidedOn)) {
      throw new AcceptError('--keep needs --decided-on: the date it was decided (YYYY-MM-DD)');
    }
  }

  // Each job estimated with exactly the values the candidate holds.
  const estimateAt = (programText, jd) => {
    const { machine, dialect } = server.mapRecord(candidate);
    const result = core.interpret(core.parse(programText), { dialect });
    const e = core.estimateTime(result, {
      ...machine,
      junctionDeviation: jd,
      calibration: { timeFactor: fit.factors.timeFactor, accelFactor: fit.factors.accelFactor },
    });
    return e.complete ? e.totalMs / 1000 : null;
  };
  const jd = candidate.planner.junctionDeviation.value;
  const graded = list.map((j) => {
    const mean = j.times.reduce((s, x) => s + x, 0) / j.times.length;
    const spread =
      j.times.length > 1 ? ((Math.max(...j.times) - Math.min(...j.times)) / mean) * 100 : null;
    const estimate = estimateAt(j.text, jd);
    if (estimate === null) refusals.push(`${j.file}: its estimate is incomplete`);
    if (spread !== null && spread > rules.spreadPercent) {
      refusals.push(
        `${j.file}: its timings spread ${r6(spread)}%, over ${rules.spreadPercent}%: the timing can't decide a ±${rules.tolerancePercent}% question; time it again`,
      );
    }
    const error = estimate === null ? null : pctOf(estimate, mean);
    if (error !== null && Math.abs(error) > rules.tolerancePercent) {
      refusals.push(
        `${j.file}: the estimate is ${r6(error)}% off its measured time, outside ±${rules.tolerancePercent}%`,
      );
    }
    return { ...j, mean, spread, estimate, error };
  });

  // An undetermined junction deviation, kept: tested, not assumed (reviewer's condition 1).
  let sensitivity = null;
  let kept = false;
  if (jdUndetermined) {
    const seLog = Math.log(1 + jdUndetermined.standardErrorPercent / 100);
    const [lo, hi] = FIT_RULES.box.junctionDeviation;
    const clamp = (v) => Math.min(hi, Math.max(lo, v));
    const reach = rules.sensitivitySe * seLog;
    const low = clamp(Math.exp(Math.log(jd) - reach));
    const high = clamp(Math.exp(Math.log(jd) + reach));
    const fitLow = clamp(Math.exp(Math.log(fit.factors.junctionDeviation) - reach));
    const fitHigh = clamp(Math.exp(Math.log(fit.factors.junctionDeviation) + reach));
    const rows = graded
      .filter((g) => g.estimate !== null)
      .map((g) => ({
        file: g.file,
        lowPercent: r6(pctOf(estimateAt(g.text, low), g.estimate)),
        highPercent: r6(pctOf(estimateAt(g.text, high), g.estimate)),
      }));
    const worst = Math.max(
      0,
      ...rows.flatMap((r) => [Math.abs(r.lowPercent), Math.abs(r.highPercent)]),
    );
    const exercised = rows.some((r) => r.lowPercent !== 0 || r.highPercent !== 0);
    sensitivity = {
      factor: 'junctionDeviation',
      kept: jd,
      fitted: fit.factors.junctionDeviation,
      standardErrorPercent: jdUndetermined.standardErrorPercent,
      range: [r6(low), r6(high)],
      exercised,
      worstPercent: r6(worst),
      jobs: rows,
    };
    if (jd < fitLow || jd > fitHigh) {
      refusals.push(
        `junctionDeviation: the record's ${jd} mm is outside the fit's ±${rules.sensitivitySe} SE range (${r6(fitLow)}-${r6(fitHigh)} mm): the runs place it elsewhere`,
      );
    }
    if (worst > rules.sensitivityPercent) {
      refusals.push(
        `junctionDeviation matters for these jobs: across ±${rules.sensitivitySe} SE a job moves ${r6(worst)}%, over ${rules.sensitivityPercent}%. Time the corners program again to narrow it`,
      );
    }
    if (jdBefore.source === 'seed') {
      if (!exercised) {
        refusals.push(
          'junctionDeviation is a seed no job exercises: there is no evidence to keep it, so it must be measured',
        );
      } else if (!keep) {
        refusals.push(
          'junctionDeviation is undetermined and still a seed: keep it explicitly (--keep junctionDeviation --operator <name> --decided-on <date>), or time the corners program again',
        );
      } else if (worst <= rules.sensitivityPercent) {
        candidate.planner.junctionDeviation = { value: jd, source: 'manual' };
        kept = true;
      }
    }
  } else if (keep) {
    throw new AcceptError('--keep: junctionDeviation was fitted, so there is nothing to keep');
  }

  // A calibrated record holds no seed (ADR-0041). Never relabelled quietly.
  for (const path of seedPaths(candidate)) {
    if (path === 'planner.junctionDeviation') continue; // refused above, with its reason
    refusals.push(`${path} is still a seed: measure it and enter it as "measured"`);
  }

  const errors = graded.filter((g) => g.error !== null).map((g) => Math.abs(g.error));
  const residuals = {
    jobs: graded.length,
    meanAbsPercent: errors.length ? r6(errors.reduce((s, x) => s + x, 0) / errors.length) : null,
    maxAbsPercent: errors.length ? r6(Math.max(...errors)) : null,
  };
  // fittedOn: the latest measurement the calibration rests on. From the data, never a clock.
  const fittedOn = [...runDates, ...graded.flatMap((g) => g.dates)].sort().at(-1) ?? null;

  let recordOut = null;
  let hashAfter = null;
  const unique = [...new Set(refusals)];
  if (unique.length === 0) {
    candidate.calibration = {
      status: 'calibrated',
      fittedOn,
      timeFactor: fit.factors.timeFactor,
      accelFactor: fit.factors.accelFactor,
      residuals,
    };
    recordOut = `${JSON.stringify(candidate, null, 2)}\n`;
    // Read back through the schema: the tool can never emit a record it would refuse.
    const back = db.readMachine(recordOut);
    if (!back.ok) {
      throw new AcceptError(
        `the candidate record isn't valid: ${back.problems.map((p) => `${p.code} ${p.path}`).join('; ')}`,
      );
    }
    hashAfter = back.hash;
  }

  const report = {
    format: ACCEPT_FORMAT,
    version: ACCEPT_VERSION,
    status: unique.length ? 'refused' : 'accepted',
    candidate:
      'A candidate record only: the storing application adopts it through its own calibration flow (ADR-0041), and records who adopted it.',
    refusals: unique,
    provenance: {
      toolkitCommit: toolkit.commit,
      acceptVersion: ACCEPT_VERSION,
      node: process.version,
      record: {
        id: record.id,
        revision: record.revision,
        hashBefore: read.hash,
        hashAfter,
      },
      fitSha256: sha256(fitText),
      runsSha256: fit.provenance.runsSha256,
      jobsSha256: sha256(jobsText),
      method: methods[0] ?? null,
    },
    factors: {
      timeFactor: fit.factors.timeFactor,
      accelFactor: fit.factors.accelFactor,
      junctionDeviation: {
        value: candidate.planner.junctionDeviation.value,
        source: candidate.planner.junctionDeviation.source,
        before: jdBefore,
      },
    },
    fittedOn,
    residuals,
    jobs: graded.map((g) => ({
      file: g.file,
      sha256: g.hash,
      measuredSeconds: g.times,
      meanSeconds: r6(g.mean),
      spreadPercent: r6(g.spread),
      estimatedSeconds: r6(g.estimate),
      errorPercent: r6(g.error),
    })),
    sensitivity,
    keep: kept
      ? {
          field: 'planner.junctionDeviation',
          value: jd,
          operator: keep.operator,
          decidedOn: keep.decidedOn,
          justifiedBy: sensitivity,
        }
      : null,
  };
  return { report, recordOut };
}

/** accept.txt: the same, for a person. Names and numbers only. */
export function summary(r) {
  const out = [
    `Calibration acceptance (${r.format} v${r.version}): ${r.status.toUpperCase()}`,
    r.candidate,
    '',
  ];
  if (r.refusals.length) out.push('Refused:', ...r.refusals.map((x) => `  - ${x}`), '');
  const jd = r.factors.junctionDeviation;
  out.push(
    `timeFactor ${r.factors.timeFactor}  accelFactor ${r.factors.accelFactor}  junctionDeviation ${jd.value} mm (${jd.source}; was ${jd.before.value}, ${jd.before.source})`,
    `residuals over ${r.residuals.jobs} jobs: mean ${r.residuals.meanAbsPercent ?? '-'}%, max ${r.residuals.maxAbsPercent ?? '-'}%; fittedOn ${r.fittedOn ?? '-'}`,
    '',
    'job                                       measured   estimated  error%  spread%',
  );
  for (const j of r.jobs) {
    out.push(
      `${j.file.padEnd(40)} ${String(j.meanSeconds).padStart(9)}  ${String(j.estimatedSeconds).padStart(10)}  ${String(j.errorPercent).padStart(6)}  ${String(j.spreadPercent ?? '-').padStart(7)}`,
    );
  }
  if (r.sensitivity) {
    const s = r.sensitivity;
    out.push(
      '',
      `junctionDeviation kept at ${s.kept} mm, tested at ${s.range[0]}-${s.range[1]} mm (±2 SE): worst move ${s.worstPercent}%`,
    );
    for (const x of s.jobs) out.push(`  ${x.file.padEnd(40)} ${x.lowPercent}% / ${x.highPercent}%`);
  }
  if (r.keep) {
    out.push(
      '',
      `kept by ${r.keep.operator} on ${r.keep.decidedOn}: ${r.keep.field} = ${r.keep.value}`,
    );
  }
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const need = ['--record', '--fit', '--runs', '--programs', '--jobs', '--jobs-root', '--out'];
    if (need.some((n) => !opt(n))) {
      throw new AcceptError(
        'usage: accept.mjs --record <record.json> --fit <fit.json> --runs <calibration-runs.json> --programs <dir> --jobs <timings.json> --jobs-root <dir> --out <new dir> [--keep junctionDeviation --operator <name> --decided-on <YYYY-MM-DD>]',
      );
    }
    const out = checkOut(opt('--out'));
    const root = opt('--jobs-root');
    const programs = opt('--programs');
    const keep =
      opt('--keep') === undefined
        ? null
        : { field: opt('--keep'), operator: opt('--operator'), decidedOn: opt('--decided-on') };
    const { report, recordOut } = runAcceptance({
      recordText: readFileSync(opt('--record'), 'utf8'),
      fitText: readFileSync(opt('--fit'), 'utf8'),
      runsText: readFileSync(opt('--runs'), 'utf8'),
      jobsText: readFileSync(opt('--jobs'), 'utf8'),
      readJob: (file) => readFileSync(join(root, file)),
      readProgram: (file) => readFileSync(join(programs, file)),
      toolkit: toolkitState(),
      keep,
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'accept.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(out, 'accept.txt'), summary(report), { flag: 'wx' });
    if (recordOut) writeFileSync(join(out, 'record.json'), recordOut, { flag: 'wx' });
    process.stdout.write(summary(report));
    process.exit(report.status === 'accepted' ? 0 : 1);
  } catch (e) {
    process.stderr.write(
      `accept: ${e instanceof ProgramsError ? e.message : String(e?.stack ?? e)}\n`,
    );
    process.exit(1);
  }
}
