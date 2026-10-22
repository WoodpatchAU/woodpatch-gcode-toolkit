// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The machine record, version 1 (ADR-0041): its types and `validateMachine()`.
 *
 * This code is the authoritative definition. The JSON Schema in
 * `schema/machine-record-v1.schema.json` describes the same shape for other
 * languages, but can't express every rule here, so it is a subset of this file.
 *
 * Every field is read with `Object.hasOwn`, never through the prototype chain, so a
 * record from `parseStrictJson` (null-prototype objects) or anywhere else is judged
 * on exactly its own fields. A missing field is a problem, never read as zero.
 */

import { hasLoneSurrogate, parseStrictJson, type JsonError } from './json.js';
import { contentHash } from './jcs.js';

export const MACHINE_FORMAT = 'woodpatch-gcode-machine';
export const MACHINE_VERSION = 1;
/** The newest revision of version 1 this toolkit knows. Older ones are accepted. */
export const MACHINE_REVISION = 1;
/** The cap on a record's text, in UTF-8 bytes, checked before it's parsed. */
export const MAX_RECORD_BYTES = 16_384;

/**
 * The built-in dialect profiles a record may name. These are core's profile ids
 * (`packages/core/src/dialect/profiles.ts`), and a test keeps the two lists equal.
 * They carry the controller's firmware line, so a firmware upgrade that changes
 * behaviour is a new id, and the record has to say which one the machine runs.
 */
export const MACHINE_DIALECTS = ['generic', 'linuxcnc-2.9', 'masso-g3-5.13'] as const;
export type MachineDialect = (typeof MACHINE_DIALECTS)[number];

export const SOURCES = ['seed', 'manual', 'measured', 'fitted'] as const;
/** Where a value came from: unchecked, entered, measured, or set by calibration. */
export type Source = (typeof SOURCES)[number];

/** A physical value with its provenance. */
export interface P {
  value: number;
  source: Source;
}

export interface LinearAxis {
  /** Travel, machine coordinates, mm. */
  min: P;
  max: P;
  /** mm/min. */
  maxVelocity: P;
  /** mm/s². */
  acceleration: P;
  /** mm/s³. Reserved for an S-curve planner. */
  jerk?: P;
}

/** A rotary axis, in degrees. No `min`/`max` means continuous rotation. */
export interface RotaryAxis {
  min?: P;
  max?: P;
  /** °/min. */
  maxVelocity: P;
  /** °/s². */
  acceleration: P;
  /** °/s³. Reserved for an S-curve planner. */
  jerk?: P;
}

export interface Calibrated {
  status: 'calibrated';
  /** YYYY-MM-DD. */
  fittedOn: string;
  timeFactor: number;
  accelFactor: number;
  residuals: { jobs: number; meanAbsPercent: number; maxAbsPercent: number };
}

export interface MachineRecord {
  format: typeof MACHINE_FORMAT;
  version: 1;
  revision: number;
  id: string;
  name: string;
  dialect: MachineDialect;
  axes: {
    X: LinearAxis;
    Y: LinearAxis;
    Z: LinearAxis;
    A?: RotaryAxis;
    B?: RotaryAxis;
    C?: RotaryAxis;
  };
  /** mm/min, linear axes only. Absent: each axis's maxVelocity. */
  rapidRate?: P;
  planner: { junctionDeviation: P; blockRate?: P; lookahead?: P };
  spindle: { minRpm?: P; maxRpm: P; spinUpSeconds: P; spinDownSeconds: P };
  overheads?: { toolChangeSeconds?: P; programStartSeconds?: P; pauseSeconds?: P };
  calibration: { status: 'uncalibrated' } | Calibrated;
}

export type MachineProblemCode =
  | 'MACHINE_TOO_LARGE'
  | 'MACHINE_JSON'
  | 'MACHINE_MISSING'
  | 'MACHINE_UNKNOWN_FIELD'
  | 'MACHINE_TYPE'
  | 'MACHINE_VALUE'
  | 'MACHINE_RANGE'
  | 'MACHINE_VERSION';

export interface MachineProblem {
  code: MachineProblemCode;
  /** Where, as dotted field names (`axes.X.maxVelocity.value`); `''` is the record. */
  path: string;
  /** Plain English. Never quotes a value from the record, only field names and rules. */
  message: string;
}

export type MachineResult =
  { ok: true; record: MachineRecord; hash: string } | { ok: false; problems: MachineProblem[] };

// ---------------------------------------------------------------------------
// The checks. Each helper adds problems and returns whether its field was usable,
// so later cross-field rules (min < max) run only on values that passed.

type Obj = { [key: string]: unknown };

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const join = (path: string, k: string): string => (path === '' ? k : `${path}.${k}`);

/** A field name from the record, made safe to put in a message: escaped and short. */
const shown = (k: string): string => JSON.stringify(k.length > 40 ? `${k.slice(0, 40)}…` : k);

class Checker {
  readonly problems: MachineProblem[] = [];

  add(code: MachineProblemCode, path: string, message: string): void {
    this.problems.push({ code, path, message });
  }

  /** An object with exactly the allowed keys. Missing required keys are reported. */
  object(
    v: unknown,
    path: string,
    required: readonly string[],
    optional: readonly string[],
  ): v is Obj {
    if (!isObj(v)) {
      this.add('MACHINE_TYPE', path, 'must be an object');
      return false;
    }
    for (const k of Object.keys(v)) {
      if (!required.includes(k) && !optional.includes(k)) {
        this.add('MACHINE_UNKNOWN_FIELD', path, `has an unknown field ${shown(k)}`);
      }
    }
    for (const k of required) {
      if (!Object.hasOwn(v, k)) this.add('MACHINE_MISSING', join(path, k), 'is required');
    }
    return true;
  }

  /** A finite number, optionally a safe integer, within [min, max] (or above `gt`). */
  number(
    v: unknown,
    path: string,
    rule: { gt?: number; min?: number; max?: number; integer?: boolean; unit?: string },
  ): v is number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.add('MACHINE_TYPE', path, 'must be a finite number');
      return false;
    }
    if (rule.integer && !Number.isSafeInteger(v)) {
      this.add('MACHINE_TYPE', path, 'must be an integer');
      return false;
    }
    const unit = rule.unit ? ` ${rule.unit}` : '';
    if (rule.gt !== undefined && !(v > rule.gt)) {
      this.add('MACHINE_RANGE', path, `must be greater than ${rule.gt}${unit}`);
      return false;
    }
    if (rule.min !== undefined && v < rule.min) {
      this.add('MACHINE_RANGE', path, `must be at least ${rule.min}${unit}`);
      return false;
    }
    if (rule.max !== undefined && v > rule.max) {
      this.add('MACHINE_RANGE', path, `must be at most ${rule.max}${unit}`);
      return false;
    }
    return true;
  }

  /** A `P` (`{ value, source }`), returning its value if usable. */
  p(
    v: unknown,
    path: string,
    rule: Parameters<Checker['number']>[2],
    sources: Source[],
  ): number | undefined {
    if (!this.object(v, path, ['value', 'source'], [])) return undefined;
    const source = own(v, 'source');
    if (Object.hasOwn(v, 'source')) {
      if (typeof source === 'string' && (SOURCES as readonly string[]).includes(source)) {
        sources.push(source as Source);
      } else {
        this.add('MACHINE_VALUE', join(path, 'source'), `must be one of ${SOURCES.join(', ')}`);
      }
    }
    if (!Object.hasOwn(v, 'value')) return undefined;
    const value = own(v, 'value');
    return this.number(value, join(path, 'value'), rule) ? value : undefined;
  }
}

const TRAVEL = 100_000;
const LINEAR = { velocity: 200_000, unit: 'mm' } as const;
const ROTARY = { velocity: 1_000_000, unit: '°' } as const;
const ACCELERATION = 50_000;

/** True if `s` is a real calendar date written YYYY-MM-DD. */
function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** Counts Unicode code points (a surrogate pair is one). */
function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Control and format characters, and the two line/paragraph separators. */
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * Checks a parsed record against ADR-0041. Returns every problem found (an empty
 * list means valid). Never throws, whatever it's given.
 */
export function validateMachine(record: unknown): MachineProblem[] {
  const c = new Checker();
  const sources: Source[] = [];

  if (
    !c.object(
      record,
      '',
      [
        'format',
        'version',
        'revision',
        'id',
        'name',
        'dialect',
        'axes',
        'planner',
        'spindle',
        'calibration',
      ],
      ['rapidRate', 'overheads'],
    )
  ) {
    return c.problems;
  }
  const r = record;

  // Format and version first: on a record of another format or version, the
  // field rules below would only add noise.
  if (Object.hasOwn(r, 'format') && own(r, 'format') !== MACHINE_FORMAT) {
    c.add('MACHINE_VALUE', 'format', `must be "${MACHINE_FORMAT}"`);
    return c.problems;
  }
  if (Object.hasOwn(r, 'version')) {
    const v = own(r, 'version');
    if (c.number(v, 'version', { min: 1, integer: true }) && v !== MACHINE_VERSION) {
      c.add(
        'MACHINE_VERSION',
        'version',
        `version ${MACHINE_VERSION} is the only one this toolkit reads`,
      );
      return c.problems;
    }
  }
  if (Object.hasOwn(r, 'revision')) {
    const v = own(r, 'revision');
    if (c.number(v, 'revision', { min: 1, integer: true }) && v > MACHINE_REVISION) {
      c.add(
        'MACHINE_VERSION',
        'revision',
        `is newer than this toolkit reads (revision ${MACHINE_REVISION}): deploy the toolkit first`,
      );
    }
  }

  if (Object.hasOwn(r, 'id')) {
    const id = own(r, 'id');
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) {
      c.add('MACHINE_VALUE', 'id', 'must be 1–64 characters from A–Z a–z 0–9 . _ : -');
    }
  }

  if (Object.hasOwn(r, 'name')) {
    const name = own(r, 'name');
    if (typeof name !== 'string') {
      c.add('MACHINE_TYPE', 'name', 'must be a string');
    } else if (hasLoneSurrogate(name) || FORBIDDEN_IN_NAME.test(name)) {
      c.add('MACHINE_VALUE', 'name', 'must not contain control, format or separator characters');
    } else {
      const n = codePoints(name);
      if (n < 1 || n > 200) c.add('MACHINE_RANGE', 'name', 'must be 1–200 characters');
    }
  }

  if (Object.hasOwn(r, 'dialect')) {
    const d = own(r, 'dialect');
    if (typeof d !== 'string' || !(MACHINE_DIALECTS as readonly string[]).includes(d)) {
      c.add('MACHINE_VALUE', 'dialect', `must be one of ${MACHINE_DIALECTS.join(', ')}`);
    }
  }

  // Axes.
  const axes = own(r, 'axes');
  if (Object.hasOwn(r, 'axes') && c.object(axes, 'axes', ['X', 'Y', 'Z'], ['A', 'B', 'C'])) {
    for (const name of ['X', 'Y', 'Z', 'A', 'B', 'C'] as const) {
      if (!Object.hasOwn(axes, name)) continue;
      const rotary = name === 'A' || name === 'B' || name === 'C';
      const kind = rotary ? ROTARY : LINEAR;
      const path = join('axes', name);
      const axis = own(axes, name);
      const required = rotary
        ? ['maxVelocity', 'acceleration']
        : ['min', 'max', 'maxVelocity', 'acceleration'];
      const optional = rotary ? ['min', 'max', 'jerk'] : ['jerk'];
      if (!c.object(axis, path, required, optional)) continue;

      const field = (k: string, rule: Parameters<Checker['number']>[2]): number | undefined =>
        Object.hasOwn(axis, k) ? c.p(own(axis, k), join(path, k), rule, sources) : undefined;
      const travel = { min: -TRAVEL, max: TRAVEL, unit: kind.unit };
      const min = field('min', travel);
      const max = field('max', travel);
      field('maxVelocity', { gt: 0, max: kind.velocity, unit: `${kind.unit}/min` });
      field('acceleration', { gt: 0, max: ACCELERATION, unit: `${kind.unit}/s²` });
      field('jerk', { gt: 0, unit: `${kind.unit}/s³` });

      if (rotary && Object.hasOwn(axis, 'min') !== Object.hasOwn(axis, 'max')) {
        c.add('MACHINE_MISSING', path, 'a rotary axis needs both min and max, or neither');
      }
      if (min !== undefined && max !== undefined && !(min < max)) {
        c.add('MACHINE_RANGE', path, 'min must be less than max');
      }
    }
  }

  if (Object.hasOwn(r, 'rapidRate')) {
    c.p(own(r, 'rapidRate'), 'rapidRate', { gt: 0, max: LINEAR.velocity, unit: 'mm/min' }, sources);
  }

  // Planner.
  const planner = own(r, 'planner');
  if (
    Object.hasOwn(r, 'planner') &&
    c.object(planner, 'planner', ['junctionDeviation'], ['blockRate', 'lookahead'])
  ) {
    const field = (k: string, rule: Parameters<Checker['number']>[2]): void => {
      if (Object.hasOwn(planner, k)) c.p(own(planner, k), join('planner', k), rule, sources);
    };
    field('junctionDeviation', { gt: 0, max: 10, unit: 'mm' });
    field('blockRate', { gt: 0, max: 100_000, unit: 'blocks/s' });
    field('lookahead', { gt: 0, max: 10_000, integer: true, unit: 'blocks' });
  }

  // Spindle.
  const spindle = own(r, 'spindle');
  if (
    Object.hasOwn(r, 'spindle') &&
    c.object(spindle, 'spindle', ['maxRpm', 'spinUpSeconds', 'spinDownSeconds'], ['minRpm'])
  ) {
    const field = (k: string, rule: Parameters<Checker['number']>[2]): number | undefined =>
      Object.hasOwn(spindle, k)
        ? c.p(own(spindle, k), join('spindle', k), rule, sources)
        : undefined;
    const maxRpm = field('maxRpm', { gt: 0, max: 100_000, unit: 'rpm' });
    const minRpm = field('minRpm', { min: 0, max: 100_000, unit: 'rpm' });
    field('spinUpSeconds', { min: 0, max: 600, unit: 's' });
    field('spinDownSeconds', { min: 0, max: 600, unit: 's' });
    if (minRpm !== undefined && maxRpm !== undefined && minRpm > maxRpm) {
      c.add('MACHINE_RANGE', 'spindle', 'minRpm must not exceed maxRpm');
    }
  }

  // Overheads.
  const overheads = own(r, 'overheads');
  const overheadFields = ['toolChangeSeconds', 'programStartSeconds', 'pauseSeconds'];
  if (Object.hasOwn(r, 'overheads') && c.object(overheads, 'overheads', [], overheadFields)) {
    for (const k of overheadFields) {
      if (Object.hasOwn(overheads, k)) {
        c.p(own(overheads, k), join('overheads', k), { min: 0, max: 86_400, unit: 's' }, sources);
      }
    }
  }

  // Calibration, last: its no-seed rule needs every P's source.
  const cal = own(r, 'calibration');
  if (Object.hasOwn(r, 'calibration')) {
    if (!isObj(cal)) {
      c.add('MACHINE_TYPE', 'calibration', 'must be an object');
    } else {
      const status = own(cal, 'status');
      if (status === 'uncalibrated') {
        c.object(cal, 'calibration', ['status'], []);
      } else if (status === 'calibrated') {
        if (
          c.object(
            cal,
            'calibration',
            ['status', 'fittedOn', 'timeFactor', 'accelFactor', 'residuals'],
            [],
          )
        ) {
          if (Object.hasOwn(cal, 'fittedOn')) {
            const d = own(cal, 'fittedOn');
            if (typeof d !== 'string' || !isIsoDate(d)) {
              c.add('MACHINE_VALUE', 'calibration.fittedOn', 'must be a real date, YYYY-MM-DD');
            }
          }
          if (Object.hasOwn(cal, 'timeFactor')) {
            c.number(own(cal, 'timeFactor'), 'calibration.timeFactor', { min: 0.5, max: 2 });
          }
          if (Object.hasOwn(cal, 'accelFactor')) {
            c.number(own(cal, 'accelFactor'), 'calibration.accelFactor', { min: 0.25, max: 4 });
          }
          const res = own(cal, 'residuals');
          const rp = 'calibration.residuals';
          if (
            Object.hasOwn(cal, 'residuals') &&
            c.object(res, rp, ['jobs', 'meanAbsPercent', 'maxAbsPercent'], [])
          ) {
            if (Object.hasOwn(res, 'jobs')) {
              c.number(own(res, 'jobs'), join(rp, 'jobs'), { min: 1, integer: true });
            }
            const pct = { min: 0, max: 100, unit: '%' };
            const mean = own(res, 'meanAbsPercent');
            const max = own(res, 'maxAbsPercent');
            const meanOk =
              Object.hasOwn(res, 'meanAbsPercent') &&
              c.number(mean, join(rp, 'meanAbsPercent'), pct);
            const maxOk =
              Object.hasOwn(res, 'maxAbsPercent') && c.number(max, join(rp, 'maxAbsPercent'), pct);
            if (meanOk && maxOk && (mean as number) > (max as number)) {
              c.add('MACHINE_RANGE', rp, 'meanAbsPercent must not exceed maxAbsPercent');
            }
          }
        }
        if (sources.includes('seed')) {
          c.add('MACHINE_VALUE', 'calibration', 'a calibrated record must not hold any seed value');
        }
      } else {
        c.add('MACHINE_VALUE', 'calibration.status', 'must be "uncalibrated" or "calibrated"');
      }
    }
  }

  return c.problems;
}

/** UTF-8 length of a string, counting a lone surrogate as the 3 bytes it'd be replaced by. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const u = s.charCodeAt(i);
    if (u < 0x80) n += 1;
    else if (u < 0x800) n += 2;
    else if (u >= 0xd800 && u <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/**
 * The whole path for a record's text, as received: the size cap, the strict parse,
 * validation, then the content hash. The hash is of the record as received, before
 * any default is applied. This is what the estimate server calls.
 */
export function readMachine(text: string): MachineResult {
  if (utf8Length(text) > MAX_RECORD_BYTES) {
    return {
      ok: false,
      problems: [
        { code: 'MACHINE_TOO_LARGE', path: '', message: `is over ${MAX_RECORD_BYTES} bytes` },
      ],
    };
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, problems: [jsonProblem(parsed.error)] };
  const problems = validateMachine(parsed.value);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    record: parsed.value as unknown as MachineRecord,
    hash: contentHash(parsed.value),
  };
}

function jsonProblem(e: JsonError): MachineProblem {
  return {
    code: 'MACHINE_JSON',
    path: '',
    message: `isn't valid JSON (${e.code}, at ${e.offset}): ${e.message}`,
  };
}
