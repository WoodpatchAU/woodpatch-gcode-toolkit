// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { MACHINE_DIALECTS, validateMachine, type MachineRecord } from '@woodpatch/gcode-db';
import { describe, expect, it } from 'vitest';
import { echoRecord, mapRecord } from './map.js';

// A fictional machine with every optional field, calibrated (so no seed values).
const p = (value: number, source = 'manual') => ({ value, source });
const FULL = {
  format: 'woodpatch-gcode-machine',
  version: 1,
  revision: 2,
  id: 'test-7',
  name: 'Test router (fictional)',
  dialect: 'masso-g3-5.13',
  axes: {
    X: { min: p(-5), max: p(1500), maxVelocity: p(12000), acceleration: p(900), jerk: p(5000) },
    Y: { min: p(0), max: p(3000), maxVelocity: p(11000), acceleration: p(700, 'measured') },
    Z: { min: p(-140), max: p(2), maxVelocity: p(2500), acceleration: p(250, 'fitted') },
    A: { min: p(-90), max: p(90), maxVelocity: p(3600), acceleration: p(180), jerk: p(900) },
    B: { maxVelocity: p(7200), acceleration: p(360) },
    C: { min: p(0), max: p(270), maxVelocity: p(5400), acceleration: p(270) },
  },
  rapidRate: p(15000),
  planner: {
    junctionDeviation: p(0.03, 'fitted'),
    blockRate: p(800),
    lookahead: p(200),
    rapidModel: { value: 'per-axis', source: 'manual' },
  },
  spindle: { minRpm: p(6000), maxRpm: p(20000), spinUpSeconds: p(7), spinDownSeconds: p(6) },
  overheads: { toolChangeSeconds: p(45), programStartSeconds: p(20), pauseSeconds: p(30) },
  calibration: {
    status: 'calibrated',
    fittedOn: '2026-10-01',
    timeFactor: 1.05,
    accelFactor: 0.9,
    residuals: { jobs: 6, meanAbsPercent: 3, maxAbsPercent: 6 },
  },
};

/**
 * Fields the mapping deliberately doesn't read, each with its reason. A field listed
 * here must leave the mapping unchanged, and every entry must match a field, so the
 * list can't grow silently or go stale.
 */
const UNUSED: readonly [RegExp, string][] = [
  [/^name$/, 'display only: not echoed (ADR-0041 echoes id, version, revision, status, hash)'],
  [
    /^(?!planner\.rapidModel\.).*\.source$/,
    "provenance is the storing application's; the estimate uses values, and calibrated:false covers unconfirmed ones",
  ],
  [
    /^axes\.[XYZABC]\.jerk\.value$/,
    'reserved for an S-curve planner; the estimator is trapezoidal (ADR-0043)',
  ],
  [
    /^spindle\.(min|max)Rpm\.value$/,
    "the estimator takes S as programmed; no time in its model depends on the spindle's range",
  ],
  [
    /^calibration\.(fittedOn|residuals\..*)$/,
    "the storing application's pricing rules read them (ADR-0041); the estimate needs only the factors",
  ],
];
/** Fields no valid record can change: tested on their own below, or nothing to vary. */
const FIXED: readonly [RegExp, string][] = [
  [/^format$/, 'one value only'],
  [/^version$/, 'one value only: version 1'],
  [
    /^revision$/,
    'this record holds a revision 2 field, so 2 is its only valid revision; the echo carries it (tested below)',
  ],
  [/^calibration\.status$/, 'it switches the calibration branch: tested below'],
];

const SWAP: Record<string, string> = {
  manual: 'measured',
  measured: 'manual',
  fitted: 'manual',
  'per-axis': 'coordinated',
  'masso-g3-5.13': 'linuxcnc-2.9',
  '2026-10-01': '2026-10-02',
};

/** Every leaf field's dotted path. */
function leaves(o: unknown, path = ''): string[] {
  if (typeof o !== 'object' || o === null) return [path];
  return Object.entries(o).flatMap(([k, v]) => leaves(v, path === '' ? k : `${path}.${k}`));
}

function vary(record: unknown, path: string): unknown {
  const copy = structuredClone(record) as Record<string, unknown>;
  const keys = path.split('.');
  let o = copy;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  const last = keys.at(-1) as string;
  const v = o[last];
  if (typeof v === 'number') {
    // Integers stay integers; a travel minimum goes down, so min < max still holds.
    if (Number.isInteger(v) && /lookahead|jobs/.test(path)) o[last] = v + 1;
    else if (path.endsWith('min.value')) o[last] = v - 1;
    else o[last] = v === 0 ? 1 : v * 1.25;
  } else if (typeof v === 'string') {
    o[last] = SWAP[v] ?? `${v}-other`;
  }
  return copy;
}

const out = (record: unknown) => {
  const m = mapRecord(record as MachineRecord);
  return JSON.stringify({
    machine: m.machine,
    travel: m.travel,
    dialect: m.dialect.id,
    echo: echoRecord(record as MachineRecord),
  });
};

describe('mapRecord', () => {
  it('maps every field of the record, or says why not', () => {
    expect(validateMachine(FULL)).toEqual([]);
    const base = out(FULL);
    const matched = new Set<RegExp>();
    const paths = leaves(FULL);
    for (const path of paths) {
      const fixed = FIXED.find(([re]) => re.test(path));
      if (fixed) {
        matched.add(fixed[0]);
        continue;
      }
      const variant = vary(FULL, path);
      expect(validateMachine(variant), path).toEqual([]);
      const unused = UNUSED.find(([re]) => re.test(path));
      if (unused) {
        matched.add(unused[0]);
        expect(out(variant), `${path} is listed as unused, but the mapping reads it`).toBe(base);
      } else {
        expect(out(variant), `${path} changes nothing: map it, or list it as unused`).not.toBe(
          base,
        );
      }
    }
    for (const [re, why] of [...UNUSED, ...FIXED]) {
      expect(matched.has(re), `stale entry ${String(re)} (${why})`).toBe(true);
    }
    expect(paths.length).toBeGreaterThan(60);
  });

  it('puts each value where the estimator and the travel check read it', () => {
    const m = mapRecord(FULL as MachineRecord);
    expect(m.dialect.id).toBe('masso-g3-5.13');
    expect(m.machine).toEqual({
      axes: {
        X: { maxVelocity: 12000, acceleration: 900 },
        Y: { maxVelocity: 11000, acceleration: 700 },
        Z: { maxVelocity: 2500, acceleration: 250 },
        A: { maxVelocity: 3600, acceleration: 180 },
        B: { maxVelocity: 7200, acceleration: 360 },
        C: { maxVelocity: 5400, acceleration: 270 },
      },
      rapidRate: 15000,
      rapidModel: 'per-axis',
      rapidModelConfirmed: false,
      junctionDeviation: 0.03,
      blockRate: 800,
      lookahead: 200,
      spinUpSeconds: 7,
      spinDownSeconds: 6,
      toolChangeSeconds: 45,
      programStartSeconds: 20,
      pauseSeconds: 30,
      calibration: { timeFactor: 1.05, accelFactor: 0.9 },
    });
    // B has no min and max: continuous, so not travel-checked.
    expect(m.travel).toEqual({
      X: { min: -5, max: 1500 },
      Y: { min: 0, max: 3000 },
      Z: { min: -140, max: 2 },
      A: { min: -90, max: 90 },
      C: { min: 0, max: 270 },
    });
    expect(echoRecord(FULL as MachineRecord)).toEqual({
      id: 'test-7',
      version: 1,
      revision: 2,
      calibration: 'calibrated',
    });
  });

  it('leaves out what the record leaves out, and counts absent overheads as 0', () => {
    const example = JSON.parse(
      readFileSync(
        new URL('../../db-schema/examples/example-router.json', import.meta.url),
        'utf8',
      ),
    );
    expect(validateMachine(example)).toEqual([]);
    const m = mapRecord(example);
    expect(m.machine).not.toHaveProperty('rapidRate');
    expect(m.machine).not.toHaveProperty('blockRate');
    expect(m.machine).not.toHaveProperty('lookahead');
    // Revision 1: no rapid model, so the assumption, unconfirmed.
    expect([m.machine.rapidModel, m.machine.rapidModelConfirmed]).toEqual(['coordinated', false]);
    expect(m.machine.toolChangeSeconds).toBe(60);
    expect(m.machine.programStartSeconds).toBe(0);
    expect(m.machine.pauseSeconds).toBe(0);
    expect(Object.keys(m.machine.axes)).toEqual(['X', 'Y', 'Z']);
    expect(Object.keys(m.travel)).toEqual(['X', 'Y', 'Z']);
    // Uncalibrated: no factors, which the estimator reads as 1 and reports.
    expect(m.machine.calibration).toBeNull();
    expect(echoRecord(example).calibration).toBe('uncalibrated');
  });

  it('takes the rapid model from revision 2, confirmed only when measured', () => {
    const withModel = (rapidModel: unknown) => {
      const r = structuredClone(FULL) as unknown as { planner: Record<string, unknown> };
      if (rapidModel === undefined) Reflect.deleteProperty(r.planner, 'rapidModel');
      else r.planner['rapidModel'] = rapidModel;
      expect(validateMachine(r)).toEqual([]);
      const m = mapRecord(r as unknown as MachineRecord).machine;
      return [m.rapidModel, m.rapidModelConfirmed];
    };
    // Left out: assumed coordinated, unconfirmed, so every estimate notes it.
    expect(withModel(undefined)).toEqual(['coordinated', false]);
    expect(withModel({ value: 'coordinated', source: 'manual' })).toEqual(['coordinated', false]);
    expect(withModel({ value: 'per-axis', source: 'manual' })).toEqual(['per-axis', false]);
    expect(withModel({ value: 'coordinated', source: 'measured' })).toEqual(['coordinated', true]);
    expect(withModel({ value: 'per-axis', source: 'measured' })).toEqual(['per-axis', true]);
  });

  it('maps every dialect a record may name to a core profile', () => {
    for (const dialect of MACHINE_DIALECTS) {
      const r = { ...FULL, dialect };
      expect(validateMachine(r)).toEqual([]);
      expect(mapRecord(r as MachineRecord).dialect.id).toBe(dialect);
    }
  });
});
