// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Fits a machine's calibration factors to timed runs of the calibration programs
// (ADR-0049): timeFactor, accelFactor and the junction deviation. It refuses a fit the
// runs can't support, and says why. Its output, fit.json, is NOT a machine record: a fit
// on its own programs isn't acceptance. 5c-2's acceptance check reads fit.json with the
// production jobs, and only that writes a calibrated record.
//
//   node tools/calibration/fit.mjs --record <record.json> --runs <calibration-runs.json>
//     --programs <dir> --out <new dir> [--timer-resolution <s>]
//
// Everything it reads and writes is the machine's, and private: --out must be outside
// this repository, and the output names programs and their SHA-256s, never their text.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { ProgramsError, checkOut } from './programs.mjs';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const core = await import(join(REPO, 'packages/core/dist/index.js'));
const db = await import(join(REPO, 'packages/db-schema/dist/index.js'));
const server = await import(join(REPO, 'packages/server/dist/index.js'));

export const FIT_FORMAT = 'woodpatch-gcode-fit';
export const FIT_VERSION = 1;

/**
 * The rules' numbers, each with its reason in ADR-0049.
 * - BOX: accelFactor is the record's own range; junction deviation stops at 1 mm, above
 *   which no planner corners, and a fit landing there is refused, never clamped.
 * - GRID: 17 log-spaced steps a side (about 19% a step in accelFactor).
 * - MAX_CORRELATION: past 0.95 (a variance inflation factor of about 10), one factor's
 *   estimate is mostly the other's.
 * - VALLEY_CHI2: Δχ² for the 68% region of two free parameters.
 * - INFORMANT_SHARE: a factor whose information comes this much from one program needs
 *   that program timed twice.
 * - LOO_SE: leaving one run out may move a factor by at most this many standard errors.
 * - AT_BOUND: a refined factor within this (in log) of the box's edge is at the bound.
 * - WEAK_SE: a factor with a standard error over this (%) is reported as weakly
 *   determined: a warning, not a refusal. Its effect on a time may be small, and the
 *   acceptance check (5c-2) measures what matters, the error on real jobs.
 */
export const RULES = {
  box: { accelFactor: [0.25, 4], junctionDeviation: [0.001, 1] },
  grid: 17,
  minExtraRuns: 2,
  maxCorrelation: 0.95,
  maxCondition: 1e8,
  valleyChi2: 2.3,
  informantShare: 0.9,
  looSe: 3,
  atBound: 0.01,
  weakSePercent: 25,
};

const FACTORS = ['timeFactor', 'accelFactor', 'junctionDeviation'];

/** A refusal: the fit can't be supported by these runs, and the message says why. */
export class FitError extends ProgramsError {}

/** Golden-section minimum of f on [lo, hi]. */
function golden(f, lo, hi, iterations) {
  const g = (Math.sqrt(5) - 1) / 2;
  let a = lo;
  let b = hi;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iterations; i++) {
    if (fc <= fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return fc <= fd ? c : d;
}

/** The inverse of a symmetric 3x3 matrix, or null if it's singular. */
function inverse3(m) {
  const [[a, b, c], [, e, f], [, , i]] = m;
  const A = e * i - f * f;
  const B = -(b * i - c * f);
  const C = b * f - c * e;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null;
  const E = a * i - c * c;
  const F = -(a * f - b * c);
  const I = a * e - b * b;
  return [
    [A / det, B / det, C / det],
    [B / det, E / det, F / det],
    [C / det, F / det, I / det],
  ];
}

/** Eigenvalues of a symmetric 3x3 matrix (Jacobi rotations). */
function eigen3(m) {
  const a = m.map((r) => [...r]);
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1);
        const sn = t * cs;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = cs * akp - sn * akq;
          a[k][q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk;
          a[q][k] = sn * apk + cs * aqk;
        }
      }
    }
  }
  return [a[0][0], a[1][1], a[2][2]];
}

/** Rounded for output: the same inputs give the same bytes. */
const r6 = (v) => (v === null || v === undefined ? null : Number(v.toPrecision(6)));
const pct = (lnRatio) => (Math.exp(lnRatio) - 1) * 100;

/**
 * Each run's noise, in log units (ADR-0049): the timer's resolution over its time, or
 * the pooled scatter of the repeats, whichever is larger. Returns the per-run σ and the
 * pooled figure (null without a repeat).
 */
export function noise(runs, resolution) {
  const groups = new Map();
  for (const r of runs) {
    const g = groups.get(r.file) ?? [];
    g.push(Math.log(r.measured));
    groups.set(r.file, g);
  }
  let ss = 0;
  let dof = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const mean = g.reduce((s, x) => s + x, 0) / g.length;
    ss += g.reduce((s, x) => s + (x - mean) ** 2, 0);
    dof += g.length - 1;
  }
  const pooled = dof > 0 ? Math.sqrt(ss / dof) : null;
  return {
    pooled,
    repeatDof: dof,
    sigma: runs.map((r) => Math.max(pooled ?? 0, resolution / r.measured)),
  };
}

/**
 * The fit itself, on any model: `model(i, accelFactor, junctionDeviation)` gives run i's
 * time in seconds at timeFactor 1. `runs` are { file, measured }. Pure and deterministic;
 * throws FitError on any refusal. `rules` overrides RULES (the tests use it).
 */
export function fitFactors(model, runs, resolution, rules = RULES) {
  const n = runs.length;
  const k = FACTORS.length;
  if (n < k + rules.minExtraRuns) {
    throw new FitError(
      `${n} timed runs: the fit needs at least ${k + rules.minExtraRuns} (${k} factors + ${rules.minExtraRuns})`,
    );
  }
  const { pooled, repeatDof, sigma } = noise(runs, resolution);
  if (repeatDof === 0) {
    throw new FitError(
      'no program is timed twice: time one again (the corners program first), so the noise is measured',
    );
  }
  const w = sigma.map((s) => 1 / (s * s));
  const lnM = runs.map((r) => Math.log(r.measured));

  // Every model evaluation, memoised by point: the grid, the refinements and the
  // leave-one-out fits revisit points, and a dense program is slow to estimate.
  const memo = new Map();
  const unscaled = (la, lj) => {
    const key = `${la}:${lj}`;
    let u = memo.get(key);
    if (!u) {
      u = runs.map((_, i) => {
        const t = model(i, Math.exp(la), Math.exp(lj));
        if (!(t > 0)) throw new FitError(`${runs[i].file}: no estimate at these factors`);
        return Math.log(t);
      });
      memo.set(key, u);
    }
    return u;
  };
  // χ² at a point, over the runs in `use`, with ln timeFactor solved exactly.
  const chi2At = (la, lj, use) => {
    const lu = unscaled(la, lj);
    let sw = 0;
    let swd = 0;
    for (const i of use) {
      sw += w[i];
      swd += w[i] * (lnM[i] - lu[i]);
    }
    const lt = swd / sw;
    let c = 0;
    for (const i of use) c += w[i] * (lt + lu[i] - lnM[i]) ** 2;
    return { chi2: c, lt };
  };

  const [aLo, aHi] = rules.box.accelFactor.map(Math.log);
  const [jLo, jHi] = rules.box.junctionDeviation.map(Math.log);
  const G = rules.grid;
  const node = (lo, hi, idx) => lo + ((hi - lo) * idx) / (G - 1);
  const all = runs.map((_, i) => i);

  const gridFit = (use) => {
    const nodes = [];
    for (let a = 0; a < G; a++) {
      for (let j = 0; j < G; j++) {
        const la = node(aLo, aHi, a);
        const lj = node(jLo, jHi, j);
        nodes.push({ a, j, la, lj, chi2: chi2At(la, lj, use).chi2 });
      }
    }
    // Ties broken by grid position, so the order is fixed.
    nodes.sort((x, y) => x.chi2 - y.chi2 || x.a - y.a || x.j - y.j);
    return nodes;
  };
  const refine = (best, use, sweeps, iterations) => {
    const da = (aHi - aLo) / (G - 1);
    const dj = (jHi - jLo) / (G - 1);
    let la = best.la;
    let lj = best.lj;
    for (let s = 0; s < sweeps; s++) {
      la = golden(
        (x) => chi2At(x, lj, use).chi2,
        Math.max(aLo, best.la - da),
        Math.min(aHi, best.la + da),
        iterations,
      );
      lj = golden(
        (x) => chi2At(la, x, use).chi2,
        Math.max(jLo, best.lj - dj),
        Math.min(jHi, best.lj + dj),
        iterations,
      );
    }
    const { chi2, lt } = chi2At(la, lj, use);
    return { lt, la, lj, chi2 };
  };

  const nodes = gridFit(all);
  const best = refine(nodes[0], all, 3, 20);
  const dof = n - k;
  // Model error the noise doesn't cover inflates χ²; scale by it (never down), so the
  // standard errors and the valley test aren't tighter than the misfit allows.
  const scale = Math.max(1, best.chi2 / dof);

  // The Jacobian over all three factors (ln timeFactor's column is exactly 1), weighted.
  const h = 0.05;
  const up = (la, lj) => unscaled(la, lj);
  const da = up(best.la + h, best.lj).map((v, i) => (v - up(best.la - h, best.lj)[i]) / (2 * h));
  const dj = up(best.la, best.lj + h).map((v, i) => (v - up(best.la, best.lj - h)[i]) / (2 * h));
  const J = all.map((i) => [1 / sigma[i], da[i] / sigma[i], dj[i] / sigma[i]]);
  const JtJ = [0, 1, 2].map((p) =>
    [0, 1, 2].map((q) => J.reduce((s, row) => s + row[p] * row[q], 0)),
  );
  const C = inverse3(JtJ);
  const refusals = [];
  let correlations = null;
  let se = null;
  let condition = null;
  if (C === null) {
    refusals.push("the runs can't separate the factors: the fit's matrix is singular");
  } else {
    const d = JtJ.map((r, p) => Math.sqrt(r[p]));
    const norm = JtJ.map((r, p) => r.map((v, q) => v / (d[p] * d[q])));
    const ev = eigen3(norm).map(Math.abs);
    condition = Math.max(...ev) / Math.min(...ev);
    se = [0, 1, 2].map((p) => Math.sqrt(C[p][p] * scale));
    correlations = {};
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const rho = C[p][q] / Math.sqrt(C[p][p] * C[q][q]);
        correlations[`${FACTORS[p]}/${FACTORS[q]}`] = rho;
        if (Math.abs(rho) > rules.maxCorrelation) {
          refusals.push(
            `${FACTORS[p]} and ${FACTORS[q]} trade off (correlation ${rho.toFixed(3)}, over ${rules.maxCorrelation}): these runs can't tell them apart`,
          );
        }
      }
    }
    if (!(condition <= rules.maxCondition)) {
      refusals.push(`the fit is ill-conditioned (condition ${condition.toExponential(2)})`);
    }
  }

  // A single informant: a program, timed once, without which a factor's standard error
  // grows past 1/sqrt(1 - INFORMANT_SHARE) times (at 0.9, about 3.2x: that program held
  // 90% of what the runs say about the factor). Without it the factor would be a guess,
  // so it must be timed twice. A tiny ridge keeps a matrix made singular by the removal
  // invertible, so its factors show as unbounded.
  const informative = (rows) => {
    const M = [0, 1, 2].map((p) =>
      [0, 1, 2].map((q) => rows.reduce((t, i) => t + J[i][p] * J[i][q], 0)),
    );
    const ridge = 1e-12 * (M[0][0] + M[1][1] + M[2][2]);
    for (let p = 0; p < 3; p++) M[p][p] += ridge;
    return inverse3(M);
  };
  const Cfull = informative(all);
  if (Cfull) {
    const limit = 1 / Math.sqrt(1 - rules.informantShare);
    const files = [...new Set(runs.map((r) => r.file))];
    for (const file of files) {
      const own = all.filter((i) => runs[i].file === file);
      if (own.length > 1) continue;
      const Cwithout = informative(all.filter((i) => runs[i].file !== file));
      for (const p of [1, 2]) {
        const grow = Cwithout ? Math.sqrt(Cwithout[p][p] / Cfull[p][p]) : Infinity;
        if (!(grow <= limit))
          refusals.push(`${FACTORS[p]} rests on one run (${file}): time it twice`);
      }
    }
  }

  // A second valley: a node away from the best whose fit is as good, within the noise.
  const bestNode = nodes[0];
  const rival = nodes.find(
    (x) =>
      Math.max(Math.abs(x.a - bestNode.a), Math.abs(x.j - bestNode.j)) > 1 &&
      (x.chi2 - bestNode.chi2) / scale <= rules.valleyChi2,
  );
  if (rival) {
    refusals.push(
      `not separable with these runs: accelFactor ${r6(Math.exp(rival.la))}, junctionDeviation ${r6(Math.exp(rival.lj))} fits as well as the best, within the noise`,
    );
  }

  // At a bound: refused, never clamped.
  for (const [v, lo, hi, name] of [
    [best.la, aLo, aHi, 'accelFactor'],
    [best.lj, jLo, jHi, 'junctionDeviation'],
  ]) {
    if (v - lo < rules.atBound || hi - v < rules.atBound) {
      refusals.push(
        `${name} landed on its bound (${r6(Math.exp(v))}): the real value is outside the fit's range`,
      );
    }
  }
  const lt = best.lt;
  if (Math.exp(lt) < 0.5 || Math.exp(lt) > 2) {
    refusals.push(`timeFactor ${r6(Math.exp(lt))} is outside the record's 0.5-2`);
  }

  // Leave each run out: its predicted error, and how far each factor moves.
  const theta = [lt, best.la, best.lj];
  const loo = all.map((j) => {
    const use = all.filter((i) => i !== j);
    const b = refine(gridFit(use)[0], use, 1, 15);
    const lu = unscaled(b.la, b.lj);
    const moved = se ? [b.lt, b.la, b.lj].map((v, p) => Math.abs(v - theta[p]) / se[p]) : null;
    return { predicted: pct(b.lt + lu[j] - lnM[j]), moved };
  });
  loo.forEach((l, j) => {
    if (!l.moved) return;
    l.moved.forEach((m, p) => {
      if (m > rules.looSe) {
        refusals.push(
          `the fit hangs on one run (${runs[j].file}): without it, ${FACTORS[p]} moves by ${m.toFixed(1)} standard errors`,
        );
      }
    });
  });

  const warnings = [];
  if (se) {
    se.forEach((s, p) => {
      const e = pct(s);
      if (e > rules.weakSePercent) {
        warnings.push(
          `${FACTORS[p]} is weakly determined (±${r6(e)}%): its effect on these programs is small; time its program again to narrow it`,
        );
      }
    });
  }

  const lu = unscaled(best.la, best.lj);
  return {
    status: refusals.length ? 'refused' : 'fitted',
    refusals: [...new Set(refusals)],
    warnings,
    factors: {
      timeFactor: r6(Math.exp(lt)),
      accelFactor: r6(Math.exp(best.la)),
      junctionDeviation: r6(Math.exp(best.lj)),
    },
    standardErrorPercent: se
      ? Object.fromEntries(FACTORS.map((f, p) => [f, r6(pct(se[p]))]))
      : null,
    correlations: correlations
      ? Object.fromEntries(Object.entries(correlations).map(([kk, v]) => [kk, r6(v)]))
      : null,
    condition: r6(condition),
    chi2: r6(best.chi2),
    dof,
    noise: { pooledPercent: r6(pooled === null ? null : pct(pooled)), repeatDof },
    runs: runs.map((r, i) => ({
      file: r.file,
      measuredSeconds: r.measured,
      estimatedSeconds: r6(Math.exp(lt + lu[i])),
      errorPercent: r6(pct(lt + lu[i] - lnM[i])),
      leaveOneOutErrorPercent: r6(loo[i].predicted),
    })),
    candidates: nodes.slice(0, 5).map((x) => ({
      accelFactor: r6(Math.exp(x.la)),
      junctionDeviation: r6(Math.exp(x.lj)),
      chi2: r6(x.chi2),
    })),
  };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The toolkit's commit, and whether its tree had changes (5c-2 refuses a dirty fit). */
function toolkitState() {
  const git = (...args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
  try {
    return {
      commit: git('rev-parse', 'HEAD').trim(),
      dirty: git('status', '--porcelain').length > 0,
    };
  } catch {
    return { commit: null, dirty: true };
  }
}

/**
 * Everything but the writing: reads the record, the runs file and the programs, checks
 * them, fits, and reports what isn't fitted. Returns fit.json's object. Throws FitError
 * on input it can't use (as opposed to a fit it refuses, which is status "refused").
 */
export function runFit({ recordText, runsText, readProgram, resolution = 1 }) {
  const read = db.readMachine(recordText);
  if (!read.ok) {
    throw new FitError(
      `the record isn't valid: ${read.problems.map((p) => `${p.code} ${p.path}`).join('; ')}`,
    );
  }
  const { machine, dialect } = server.mapRecord(read.record);
  let runsFile;
  try {
    runsFile = JSON.parse(runsText);
  } catch {
    throw new FitError("the runs file isn't JSON");
  }
  if (runsFile?.record?.hash !== read.hash) {
    throw new FitError(
      "the runs file was made from another record (its record hash isn't this record's): fit with the record the programs were generated from",
    );
  }
  if (!Array.isArray(runsFile.runs)) throw new FitError('the runs file has no runs');

  const programs = new Map();
  const program = (file, expected) => {
    if (typeof file !== 'string' || !PLAIN_NAME.test(file)) {
      throw new FitError('a run names a program that is not a plain file name');
    }
    let p = programs.get(file);
    if (!p) {
      const bytes = readProgram(file);
      const hash = sha256(bytes);
      const result = core.interpret(core.parse(bytes.toString('utf8')), { dialect });
      const events = result.steps.some((s) => s.kind === 'spindle' && s.state !== 'off');
      p = { file, hash, result, events };
      programs.set(file, p);
    }
    if (p.hash !== expected) {
      throw new FitError(
        `${file}: its SHA-256 isn't the one in the runs file: not the program that was timed`,
      );
    }
    return p;
  };
  const estimate = (p, af, jd, over = {}) => {
    const e = core.estimateTime(p.result, {
      ...machine,
      ...over,
      junctionDeviation: jd,
      calibration: { timeFactor: 1, accelFactor: af },
    });
    if (!e.complete) throw new FitError(`${p.file}: its estimate is incomplete`);
    return e.totalMs / 1000;
  };

  const timed = [];
  const untimed = [];
  for (const r of runsFile.runs) {
    const p = program(r.file, r.sha256);
    if (r.measuredSeconds === null || r.measuredSeconds === undefined) {
      untimed.push(r.file);
      continue;
    }
    if (typeof r.measuredSeconds !== 'number' || !(r.measuredSeconds > 0)) {
      throw new FitError(`${r.file}: measuredSeconds must be a positive number of seconds`);
    }
    const o = r.overrides ?? {};
    timed.push({
      file: r.file,
      program: p,
      measured: r.measuredSeconds,
      method: r.method,
      full: o.feedPercent === 100 && o.rapidPercent === 100,
      overrides: { feedPercent: o.feedPercent ?? null, rapidPercent: o.rapidPercent ?? null },
    });
  }
  const fitted = timed.filter((t) => t.full && !t.program.events);
  const methods = [...new Set(fitted.map((t) => t.method))];
  if (methods.length > 1) {
    throw new FitError(`the runs mix timing methods (${methods.join(', ')}): time them one way`);
  }

  const fit = fitFactors(
    (i, af, jd) => estimate(fitted[i].program, af, jd),
    fitted.map((t) => ({ file: t.file, measured: t.measured })),
    resolution,
  );

  // Reported, not fitted (ADR-0049): a person sets these in the record, as measured.
  const f = fit.factors;
  const at = (p, over) => f.timeFactor * estimate(p, f.accelFactor, f.junctionDeviation, over);
  const fullMean = (file) => {
    const xs = timed.filter((t) => t.file === file && t.full).map((t) => t.measured);
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };
  const overrides = timed
    .filter((t) => !t.full)
    .map((t) => {
      const base = fullMean(t.file);
      return {
        file: t.file,
        overrides: t.overrides,
        measuredSeconds: t.measured,
        ratioToFull: base === null ? null : r6(t.measured / base),
      };
    });
  const rapidModel = fitted
    .filter((t) => t.program.result.steps.some((s) => s.kind === 'linear' && s.rapid))
    .map((t) => ({
      file: t.file,
      coordinatedErrorPercent: r6(
        (at(t.program, { rapidModel: 'coordinated' }) / t.measured - 1) * 100,
      ),
      perAxisErrorPercent: r6((at(t.program, { rapidModel: 'per-axis' }) / t.measured - 1) * 100),
    }));
  const events = timed
    .filter((t) => t.full && t.program.events)
    .map((t) => {
      const starts = t.program.result.steps.filter(
        (s) => s.kind === 'spindle' && s.state !== 'off',
      ).length;
      const delta = t.measured - at(t.program, {});
      return {
        file: t.file,
        measuredSeconds: t.measured,
        estimatedSeconds: r6(at(t.program, {})),
        spindleStarts: starts,
        recordSpinUpPlusDownSeconds: r6(machine.spinUpSeconds + machine.spinDownSeconds),
        impliedSpinUpPlusDownSeconds: starts
          ? r6(machine.spinUpSeconds + machine.spinDownSeconds + delta / starts / f.timeFactor)
          : null,
      };
    });

  const state = toolkitState();
  return {
    format: FIT_FORMAT,
    version: FIT_VERSION,
    notAcceptance:
      'A fit on its own calibration programs is not acceptance. Only the acceptance check against at least 5 production jobs (5c-2) makes a calibrated record.',
    provenance: {
      toolkitCommit: state.commit,
      toolkitDirty: state.dirty,
      fitVersion: FIT_VERSION,
      node: process.version,
      record: { id: read.record.id, revision: read.record.revision, hash: read.hash },
      runsSha256: sha256(runsText),
      method: methods[0] ?? null,
      timerResolutionSeconds: resolution,
      programs: [...programs.values()]
        .map((p) => ({ file: p.file, sha256: p.hash }))
        .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    },
    ...fit,
    notFitted: untimed,
    reported: { overrides, rapidModel, events },
  };
}

/** fit.txt: the same, for a person. Names and numbers only. */
export function summary(r) {
  const out = [
    `Calibration fit (${r.format} v${r.version}): ${r.status.toUpperCase()}`,
    r.notAcceptance,
    '',
  ];
  if (r.refusals.length) out.push('Refused:', ...r.refusals.map((x) => `  - ${x}`), '');
  if (r.warnings.length) out.push('Warnings:', ...r.warnings.map((x) => `  - ${x}`), '');
  out.push(
    `timeFactor ${r.factors.timeFactor}  accelFactor ${r.factors.accelFactor}  junctionDeviation ${r.factors.junctionDeviation} mm`,
  );
  if (r.standardErrorPercent) {
    out.push(
      `standard errors: ${Object.entries(r.standardErrorPercent)
        .map(([k, v]) => `${k} ±${v}%`)
        .join(', ')}`,
    );
  }
  out.push(`chi2 ${r.chi2} on ${r.dof} dof; repeat noise ${r.noise.pooledPercent ?? '-'}%`, '');
  out.push('run                      measured  estimated  error%  leave-one-out%');
  for (const x of r.runs) {
    out.push(
      `${x.file.padEnd(24)} ${String(x.measuredSeconds).padStart(8)}  ${String(x.estimatedSeconds).padStart(9)}  ${String(x.errorPercent).padStart(6)}  ${String(x.leaveOneOutErrorPercent).padStart(6)}`,
    );
  }
  for (const o of r.reported.overrides) {
    out.push(
      `override ${o.file} feed ${o.overrides.feedPercent}% rapid ${o.overrides.rapidPercent}%: ${o.ratioToFull ?? '-'} x the 100/100 time`,
    );
  }
  for (const m of r.reported.rapidModel) {
    out.push(
      `rapids ${m.file}: coordinated ${m.coordinatedErrorPercent}%, per-axis ${m.perAxisErrorPercent}%`,
    );
  }
  for (const e of r.reported.events) {
    out.push(
      `spindle ${e.file}: implied spin-up + spin-down ${e.impliedSpinUpPlusDownSeconds} s (record ${e.recordSpinUpPlusDownSeconds} s)`,
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
    const recordPath = opt('--record');
    const runsPath = opt('--runs');
    const programsDir = opt('--programs');
    const outArg = opt('--out');
    if (!recordPath || !runsPath || !programsDir || !outArg) {
      throw new FitError(
        'usage: fit.mjs --record <record.json> --runs <calibration-runs.json> --programs <dir> --out <new dir> [--timer-resolution <s>]',
      );
    }
    const resolution =
      opt('--timer-resolution') === undefined ? 1 : Number(opt('--timer-resolution'));
    if (!(resolution > 0 && resolution <= 10)) {
      throw new FitError('--timer-resolution must be a number of seconds from 0 to 10');
    }
    const out = checkOut(outArg);
    const result = runFit({
      recordText: readFileSync(recordPath, 'utf8'),
      runsText: readFileSync(runsPath, 'utf8'),
      readProgram: (file) => readFileSync(join(programsDir, file)),
      resolution,
    });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'fit.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(out, 'fit.txt'), summary(result), { flag: 'wx' });
    process.stdout.write(summary(result));
    process.exit(result.status === 'fitted' ? 0 : 1);
  } catch (e) {
    process.stderr.write(
      `fit: ${e instanceof ProgramsError ? e.message : String(e?.stack ?? e)}\n`,
    );
    process.exit(1);
  }
}
