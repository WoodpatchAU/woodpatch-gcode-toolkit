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
import { FIT_FORMAT, FIT_VERSION, RULES as FIT_RULES, runFit, toolkitState } from './fit.mjs';
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
// The first line of the generator's safety header (programs.mjs SAFETY), in any case or
// spacing: a job that carries it is a calibration program, whatever else changed.
const AIR_CUT = /CALIBRATION\s+AIR\s+CUT/i;

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

/**
 * What a program does, not how it's written: the SHA-256 of its interpreted steps with
 * their line numbers dropped. A CAM or controller re-post (N numbers, G01 for G1, X50.000
 * for X50, word order, an O-number, a modal line split in two) changes the text and
 * defeats normalise(), but not this (reviewer, #84). Two jobs with the same motion are
 * one program; a job with a calibration program's motion is that program.
 */
export function motionHash(text, dialect) {
  const steps = core.interpret(core.parse(text), { dialect }).steps.map((step) => {
    const s = { ...step };
    delete s.line;
    return s;
  });
  return sha256(JSON.stringify(steps));
}

/**
 * fit.json as the fit would make it on any tree: without what depends on where and when it
 * ran (the toolkit's commit and state, Node's version), with keys sorted, as one string.
 */
function comparableFit(fit) {
  const copy = JSON.parse(JSON.stringify(fit));
  if (copy?.provenance && typeof copy.provenance === 'object') {
    delete copy.provenance.toolkitCommit;
    delete copy.provenance.toolkitDirty;
    delete copy.provenance.node;
  }
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])]),
          )
        : v;
  return JSON.stringify(sorted(copy));
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
 * `fitter` is runFit; the tests pass a stand-in so each rule can be built on purpose.
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
  fitter = runFit,
}) {
  const refusals = [];
  // A file that can't be read is input the check can't use, never a raw stack.
  const reading = (read, what) => (file) => {
    try {
      return read(file);
    } catch (e) {
      throw new AcceptError(`${file}: the ${what} can't be read (${e?.code ?? e?.message ?? e})`);
    }
  };
  const readJobFile = reading(readJob, 'job');
  const readProgramFile = reading(readProgram, 'calibration program');

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
    // Absent or anything but false is a tree with changes: fail closed.
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

  // The runs file the fit read (its SHA-256 is in fit.json).
  if (sha256(runsText) !== fit.provenance.runsSha256) {
    throw new AcceptError("the runs file isn't the one the fit read (its SHA-256 differs)");
  }

  // fit.json is a claim; the record, the runs file and the programs are the evidence. Fit
  // again from them and use only that: an edited fit.json (no programs, a factor moved, an
  // entry taken out of `undetermined`) can't change what acceptance checks (reviewer, #84).
  const resolution = fit.provenance.timerResolutionSeconds;
  if (typeof resolution !== 'number' || !(resolution > 0 && resolution <= 10)) {
    throw new AcceptError("fit.json's timer resolution isn't a number of seconds from 0 to 10");
  }
  let again;
  try {
    again = fitter({ recordText, runsText, readProgram: readProgramFile, resolution });
  } catch (e) {
    if (e instanceof AcceptError || !(e instanceof ProgramsError)) throw e;
    throw new AcceptError(`fitting again from the runs: ${e.message}`);
  }
  if (comparableFit(fit) !== comparableFit(again)) {
    throw new AcceptError(
      "fit.json isn't what the fit makes of this record, runs file and programs: fit again with this toolkit, and don't edit fit.json",
    );
  }

  // The timed runs' dates: the calibration's date, and the earliest a job may be timed.
  const runsFile = JSON.parse(runsText);
  const runDates = runsFile.runs
    .filter((r) => r.measuredSeconds !== null && r.measuredSeconds !== undefined)
    .map((r) => r.date);
  if (runDates.length === 0 || runDates.some((d) => !realDate(d))) {
    throw new AcceptError('every timed run in the runs file needs a real date (YYYY-MM-DD)');
  }
  const firstRun = [...runDates].sort()[0];

  // The calibration programs, from the runs file (whose hash the fit checked), not from
  // fit.json: raw, normalised and as motion, so no job can be one of them.
  const { dialect } = server.mapRecord(record);
  const calibration = again.provenance.programs.map(({ file, sha256: hash }) => {
    if (typeof file !== 'string' || !PLAIN_NAME.test(file)) {
      throw new AcceptError('the runs file names a program that is not a plain file name');
    }
    const bytes = readProgramFile(file);
    if (sha256(bytes) !== hash) {
      throw new AcceptError(`${file}: its SHA-256 isn't the one in the runs file`);
    }
    const text = bytes.toString('utf8');
    return { file, hash, normal: sha256(normalise(text)), motion: motionHash(text, dialect) };
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
    if (!Number.isFinite(t.measuredSeconds) || !(t.measuredSeconds > 0)) {
      throw new AcceptError(`${t.file}: measuredSeconds must be a positive number of seconds`);
    }
    if (typeof t.method !== 'string' || t.method === '') {
      throw new AcceptError(`${t.file}: each timing needs its method (how it was timed)`);
    }
    if (!realDate(t.date)) throw new AcceptError(`${t.file}: date must be a real YYYY-MM-DD`);
    if (t.date < firstRun) {
      refusals.push(
        `${t.file}: timed on ${t.date}, before the calibration runs (${firstRun}): it grades an earlier state of the machine; time it again`,
      );
    }
    if (t.overrides?.feedPercent !== 100 || t.overrides?.rapidPercent !== 100) {
      throw new AcceptError(`${t.file}: acceptance jobs are timed at 100% feed and rapid`);
    }
    let j = jobs.get(t.file);
    if (!j) {
      const bytes = readJobFile(t.file);
      const hash = sha256(bytes);
      const text = bytes.toString('utf8');
      const motion = motionHash(text, dialect);
      j = { file: t.file, hash, text, motion, times: [], dates: [], methods: new Set() };
      j.sameAs = calibration.find(
        (c) => c.hash === hash || c.normal === sha256(normalise(text)) || c.motion === motion,
      )?.file;
      j.airCut = AIR_CUT.test(text);
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
    } else if (j.airCut) {
      refusals.push(
        `${j.file} carries the calibration programs' air-cut header: acceptance never grades the fit on its own programs`,
      );
    }
  }
  // Distinct programs are distinct motion, not distinct names: one program saved as
  // copy-1.nc … copy-5.nc is one job, and its timings are repeats under one name.
  const byMotion = new Map();
  for (const j of list) byMotion.set(j.motion, [...(byMotion.get(j.motion) ?? []), j.file]);
  for (const files of byMotion.values()) {
    if (files.length > 1) {
      refusals.push(
        `${files.join(', ')} are the same program (the same motion): time it under one name, and enter repeats as more timings of that file`,
      );
    }
  }
  if (byMotion.size < rules.minJobs) {
    refusals.push(
      `${byMotion.size} production jobs: acceptance needs at least ${rules.minJobs} distinct programs`,
    );
  }

  // The candidate: the fit's factors applied, undetermined ones kept at the record's value.
  const factors = again.factors;
  const undetermined = new Map(again.undetermined.map((u) => [u.factor, u]));
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
      value: factors.junctionDeviation,
      source: 'fitted',
    };
  }
  if (keep) {
    if (keep.field !== 'junctionDeviation' || !jdUndetermined) {
      throw new AcceptError(
        '--keep applies only to an undetermined junctionDeviation (fit.json lists it): a field no fit measured is never kept, it is measured',
      );
    }
    if (jdBefore.source !== 'seed') {
      throw new AcceptError(
        `--keep: junctionDeviation is not a seed (it is "${jdBefore.source}"): there is nothing to keep`,
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
      calibration: { timeFactor: factors.timeFactor, accelFactor: factors.accelFactor },
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
  // Set only when a --keep passes its tests; applied only if nothing else is refused.
  let keepable = false;
  if (jdUndetermined) {
    const seLog = Math.log(1 + jdUndetermined.standardErrorPercent / 100);
    const [lo, hi] = FIT_RULES.box.junctionDeviation;
    const clamp = (v) => Math.min(hi, Math.max(lo, v));
    const reach = rules.sensitivitySe * seLog;
    const low = clamp(Math.exp(Math.log(jd) - reach));
    const high = clamp(Math.exp(Math.log(jd) + reach));
    const fitLow = clamp(Math.exp(Math.log(factors.junctionDeviation) - reach));
    const fitHigh = clamp(Math.exp(Math.log(factors.junctionDeviation) + reach));
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
      fitted: factors.junctionDeviation,
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
        keepable = true;
      }
    }
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
  // fittedOn: the latest calibration run the factors rest on. From the data, never a clock,
  // and never a job's date: a mistyped 2099 must not stretch the calibration's age limit.
  const fittedOn = [...runDates].sort().at(-1);

  let recordOut = null;
  let hashAfter = null;
  const unique = [...new Set(refusals)];
  const kept = keepable && unique.length === 0;
  if (unique.length === 0) {
    if (kept) candidate.planner.junctionDeviation = { value: jd, source: 'manual' };
    candidate.calibration = {
      status: 'calibrated',
      fittedOn,
      timeFactor: factors.timeFactor,
      accelFactor: factors.accelFactor,
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
      timeFactor: factors.timeFactor,
      accelFactor: factors.accelFactor,
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
  const USAGE =
    'usage: accept.mjs --record <record.json> --fit <fit.json> --runs <calibration-runs.json> --programs <dir> --jobs <timings.json> --jobs-root <dir> --out <new dir> [--keep junctionDeviation --operator <name> --decided-on <YYYY-MM-DD>]';
  const NEED = ['--record', '--fit', '--runs', '--programs', '--jobs', '--jobs-root', '--out'];
  const KEEP_FLAGS = ['--keep', '--operator', '--decided-on'];
  try {
    // Every flag once, each with its value: a repeated flag or a stray one is a mistake to
    // stop on, not to guess at.
    const opts = new Map();
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const [name, value] = [args[i], args[i + 1]];
      if (![...NEED, ...KEEP_FLAGS].includes(name)) throw new AcceptError(`${name}?\n${USAGE}`);
      if (opts.has(name)) throw new AcceptError(`${name} is given twice`);
      if (value === undefined || value.startsWith('--')) {
        throw new AcceptError(`${name} needs a value`);
      }
      opts.set(name, value);
    }
    const opt = (name) => opts.get(name);
    if (NEED.some((n) => !opts.has(n))) throw new AcceptError(USAGE);
    if (!opts.has('--keep') && KEEP_FLAGS.some((n) => opts.has(n))) {
      throw new AcceptError('--operator and --decided-on go with --keep, and only with it');
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
    // accept.json last: an "accepted" report never exists without its record.json.
    if (recordOut) writeFileSync(join(out, 'record.json'), recordOut, { flag: 'wx' });
    writeFileSync(join(out, 'accept.txt'), summary(report), { flag: 'wx' });
    writeFileSync(join(out, 'accept.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    process.stdout.write(summary(report));
    process.exit(report.status === 'accepted' ? 0 : 1);
  } catch (e) {
    process.stderr.write(
      `accept: ${e instanceof ProgramsError ? e.message : String(e?.stack ?? e)}\n`,
    );
    process.exit(1);
  }
}
