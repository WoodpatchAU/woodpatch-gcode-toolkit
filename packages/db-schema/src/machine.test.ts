// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { DIALECTS } from '@woodpatch/gcode-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentHash } from './jcs.js';
import { parseStrictJson, type JsonValue } from './json.js';
import {
  MACHINE_DIALECTS,
  MACHINE_FIELDS,
  MAX_RECORD_BYTES,
  readMachine,
  utf8Length,
  validateMachine,
  type MachineProblem,
} from './machine.js';

const EXAMPLE_TEXT = readFileSync(
  new URL('../examples/example-router.json', import.meta.url),
  'utf8',
);
const SCHEMA = JSON.parse(
  readFileSync(new URL('../schema/machine-record-v1.schema.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

type Rec = Record<string, unknown>;
/** A fresh, mutable copy of the example record. */
const example = (): Rec => JSON.parse(EXAMPLE_TEXT) as Rec;
const p = (value: number, source = 'manual'): Rec => ({ value, source });

/** Sets a dotted path on a copy of the example, or deletes it for `undefined`. */
function withField(path: string, value: unknown, base: Rec = example()): Rec {
  const keys = path.split('.');
  let o = base;
  for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Rec;
  const last = keys.at(-1) as string;
  if (value === undefined) Reflect.deleteProperty(o, last);
  else o[last] = value;
  return base;
}

const codes = (problems: MachineProblem[]): string[] => problems.map((x) => `${x.code} ${x.path}`);

/** A calibrated copy of the example, with no seed values left. */
function calibrated(): Rec {
  const text = EXAMPLE_TEXT.replaceAll('"seed"', '"fitted"');
  const r = JSON.parse(text) as Rec;
  r['calibration'] = {
    status: 'calibrated',
    fittedOn: '2026-10-22',
    timeFactor: 1.04,
    accelFactor: 0.9,
    residuals: { jobs: 12, meanAbsPercent: 2.1, maxAbsPercent: 4.8 },
  };
  return r;
}

describe('the example record', () => {
  it('is valid, and reads with its content hash', () => {
    expect(validateMachine(example())).toEqual([]);
    const r = readMachine(EXAMPLE_TEXT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.hash).toBe(contentHash(JSON.parse(EXAMPLE_TEXT) as JsonValue));
    }
  });

  it('is clearly fictional, and uncalibrated with seed values', () => {
    const r = example();
    expect(r['name']).toMatch(/fictional/);
    expect(r['calibration']).toEqual({ status: 'uncalibrated' });
    expect(EXAMPLE_TEXT).not.toMatch(/"(manual|measured|fitted)"/);
  });
});

describe('validateMachine: shape', () => {
  it.each([
    'format',
    'version',
    'revision',
    'id',
    'name',
    'dialect',
    'axes',
    'axes.X',
    'axes.Z.acceleration',
    'axes.Y.min',
    'planner',
    'planner.junctionDeviation',
    'spindle',
    'spindle.maxRpm',
    'spindle.spinUpSeconds',
    'calibration',
  ])('refuses a record without %s, never reading it as zero', (path) => {
    expect(codes(validateMachine(withField(path, undefined)))).toContain(`MACHINE_MISSING ${path}`);
  });

  it.each(['', 'axes', 'axes.X', 'axes.X.max', 'planner', 'spindle', 'overheads', 'calibration'])(
    'refuses an unknown field in "%s"',
    (path) => {
      const r = example();
      const target = path === '' ? r : withField(`${path}.stray`, 1, r);
      if (path === '') target['stray'] = 1;
      const problems = validateMachine(target);
      expect(codes(problems)).toContain(`MACHINE_UNKNOWN_FIELD ${path}`);
    },
  );

  it('refuses a misspelt optional field instead of ignoring it', () => {
    const r = withField('rapidrate', p(5000));
    expect(codes(validateMachine(r))).toEqual(['MACHINE_UNKNOWN_FIELD ']);
  });

  it('refuses __proto__ as an unknown field, and is not fooled by it', () => {
    const text = EXAMPLE_TEXT.replace('"planner": {', '"planner": {"__proto__": {"blockRate": 5},');
    const parsed = parseStrictJson(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(codes(validateMachine(parsed.value))).toEqual(['MACHINE_UNKNOWN_FIELD planner']);
  });

  it('ignores inherited fields: only own fields count', () => {
    const r = example();
    const axes = r['axes'] as Rec;
    axes['X'] = Object.setPrototypeOf({}, axes['X'] as object);
    expect(codes(validateMachine(r))).toEqual(
      ['min', 'max', 'maxVelocity', 'acceleration'].map((k) => `MACHINE_MISSING axes.X.${k}`),
    );
  });

  it('refuses a P with a bad source, an extra field or a non-number value', () => {
    expect(codes(validateMachine(withField('axes.X.max', { value: 1, source: 'guess' })))).toEqual([
      'MACHINE_VALUE axes.X.max.source',
    ]);
    expect(
      codes(validateMachine(withField('axes.X.max', { value: 1, source: 'seed', unit: 'in' }))),
    ).toEqual(['MACHINE_UNKNOWN_FIELD axes.X.max']);
    expect(codes(validateMachine(withField('axes.X.max', { value: '1', source: 'seed' })))).toEqual(
      ['MACHINE_TYPE axes.X.max.value'],
    );
    expect(codes(validateMachine(withField('axes.X.max', 2440)))).toEqual([
      'MACHINE_TYPE axes.X.max',
    ]);
  });

  it('never throws, whatever it is given', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        expect(() => validateMachine(v)).not.toThrow();
      }),
    );
    for (const v of [null, undefined, 1, 'x', [], [example()]]) {
      expect(codes(validateMachine(v))).toEqual(['MACHINE_TYPE ']);
    }
  });
});

describe('validateMachine: identity fields', () => {
  it('reads only version 1, and stops there on any other', () => {
    expect(codes(validateMachine(withField('version', 2)))).toEqual(['MACHINE_VERSION version']);
    expect(codes(validateMachine(withField('format', 'other')))).toEqual(['MACHINE_VALUE format']);
  });

  it('refuses a revision newer than it knows, and a non-integer one', () => {
    expect(codes(validateMachine(withField('revision', 2)))).toEqual(['MACHINE_VERSION revision']);
    expect(codes(validateMachine(withField('revision', 1.5)))).toEqual(['MACHINE_TYPE revision']);
    expect(codes(validateMachine(withField('revision', 0)))).toEqual(['MACHINE_RANGE revision']);
  });

  it('takes an id of 1–64 safe characters, as a string only', () => {
    for (const ok of ['a', '17', 'prism:machine.17_rev-2', 'x'.repeat(64)]) {
      expect(validateMachine(withField('id', ok))).toEqual([]);
    }
    for (const bad of [17, '', 'x'.repeat(65), 'a b', 'a/b', 'a\nb']) {
      expect(codes(validateMachine(withField('id', bad)))).toEqual(['MACHINE_VALUE id']);
    }
  });

  it('counts the name in code points, not UTF-16 units', () => {
    const emoji = String.fromCodePoint(0x1f528); // two UTF-16 units, one code point
    expect(validateMachine(withField('name', emoji.repeat(200)))).toEqual([]);
    expect(codes(validateMachine(withField('name', emoji.repeat(201))))).toEqual([
      'MACHINE_RANGE name',
    ]);
    expect(codes(validateMachine(withField('name', '')))).toEqual(['MACHINE_RANGE name']);
  });

  it('refuses control, format and separator characters in the name', () => {
    for (const cp of [
      0x00, 0x0a, 0x1b, 0x7f, 0x85, 0x200b, 0x200e, 0x202e, 0x2066, 0xfeff, 0x2028, 0x2029,
    ]) {
      const name = `Router ${String.fromCodePoint(cp)} one`;
      expect(codes(validateMachine(withField('name', name))), cp.toString(16)).toEqual([
        'MACHINE_VALUE name',
      ]);
    }
    expect(codes(validateMachine(withField('name', `a${String.fromCharCode(0xd800)}`)))).toEqual([
      'MACHINE_VALUE name',
    ]);
    // Right-to-left text itself is allowed: only overrides are refused.
    expect(validateMachine(withField('name', 'נתב ראשי'))).toEqual([]);
  });

  it("takes only the built-in dialects, which are exactly core's profiles", () => {
    expect([...MACHINE_DIALECTS].sort()).toEqual(DIALECTS.map((d) => d.id).sort());
    for (const d of MACHINE_DIALECTS) expect(validateMachine(withField('dialect', d))).toEqual([]);
    for (const bad of ['masso-g3', 'MASSO-G3-5.13', 'grbl', 3]) {
      expect(codes(validateMachine(withField('dialect', bad)))).toEqual(['MACHINE_VALUE dialect']);
    }
  });

  it('never quotes a value from the record in a message', () => {
    const secret = 'Customer-Secret-Name';
    const r = withField('name', `${secret}${String.fromCodePoint(0x202e)}`);
    withField('id', `${secret} x`, r);
    withField(`axes.X.${secret}`, 1, r);
    const problems = validateMachine(r);
    expect(problems.length).toBe(3);
    // The unknown field's NAME is shown (escaped and short); values never are.
    expect(problems.filter((x) => x.message.includes(secret)).map((x) => x.code)).toEqual([
      'MACHINE_UNKNOWN_FIELD',
    ]);
  });
});

describe('messages are printable ASCII, whatever the record holds', () => {
  const PRINTABLE = /^[\x20-\x7e]*$/;
  const cp = (...points: number[]): string => String.fromCodePoint(...points);
  // Line and paragraph separators, NEL, newline, bidi overrides and isolates, a
  // zero-width space, an astral character, and a forged log prefix.
  const hostile = [
    `x [ERROR] forged${cp(0x202e)}${cp(0x85)}`,
    `k${cp(0x2028)}next${cp(0x2029)}`,
    `a${cp(0x0a)}[WARN] fake line`,
    `${cp(0x2066)}rtl${cp(0x2069)}${cp(0x200b)}`,
    `emoji ${cp(0x1f528)} "quoted" back\\slash`,
    'z'.repeat(500),
  ];

  it.each(hostile)('an unknown field named %j', (key) => {
    const r = example();
    (r['planner'] as Rec)[key] = 1;
    const problems = validateMachine(r);
    expect(problems.map((x) => x.code)).toEqual(['MACHINE_UNKNOWN_FIELD']);
    for (const x of problems) expect(x.message).toMatch(PRINTABLE);
    expect(problems[0]?.message.length).toBeLessThan(200);
  });

  it.each(hostile)('a repeated key named %j', (key) => {
    const k = JSON.stringify(key);
    const r = readMachine(EXAMPLE_TEXT.replace('"planner": {', `"planner": {${k}: 1, ${k}: 2,`));
    expect(r.ok ? [] : codes(r.problems)).toEqual(['MACHINE_JSON ']);
    if (!r.ok) for (const x of r.problems) expect(x.message).toMatch(PRINTABLE);
  });

  it('for any key, and for every problem a broken record can produce', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), fc.anything(), (key, v) => {
        const r = example();
        (r['axes'] as Rec)[key] = v;
        r['name'] = key;
        r['id'] = key;
        for (const x of validateMachine(r)) expect(x.message).toMatch(PRINTABLE);
      }),
    );
  });
});

describe('validateMachine: numbers', () => {
  it.each([
    ['axes.X.maxVelocity', 200_000, 200_000.01, 0],
    ['axes.Z.acceleration', 50_000, 50_001, 0],
    ['rapidRate', 200_000, 200_001, 0],
    ['planner.junctionDeviation', 10, 10.001, 0],
    ['planner.blockRate', 100_000, 100_001, 0],
    ['spindle.maxRpm', 100_000, 100_001, 0],
  ])('%s: at most %d, and greater than 0', (path, max, over, zero) => {
    expect(validateMachine(withField(path, p(max)))).toEqual([]);
    expect(codes(validateMachine(withField(path, p(over))))).toEqual([
      `MACHINE_RANGE ${path}.value`,
    ]);
    expect(codes(validateMachine(withField(path, p(zero))))).toEqual([
      `MACHINE_RANGE ${path}.value`,
    ]);
    expect(codes(validateMachine(withField(path, p(-1))))).toEqual([`MACHINE_RANGE ${path}.value`]);
  });

  it.each([
    ['spindle.spinUpSeconds', 600],
    ['spindle.spinDownSeconds', 600],
    ['overheads.toolChangeSeconds', 86_400],
    ['overheads.programStartSeconds', 86_400],
    ['overheads.pauseSeconds', 86_400],
  ])('%s: 0 to %d', (path, max) => {
    expect(validateMachine(withField(path, p(0)))).toEqual([]);
    expect(validateMachine(withField(path, p(max)))).toEqual([]);
    expect(codes(validateMachine(withField(path, p(max + 1))))).toEqual([
      `MACHINE_RANGE ${path}.value`,
    ]);
    expect(codes(validateMachine(withField(path, p(-0.5))))).toEqual([
      `MACHINE_RANGE ${path}.value`,
    ]);
  });

  it('lookahead is a positive integer, at most 10,000', () => {
    expect(validateMachine(withField('planner.lookahead', p(10_000)))).toEqual([]);
    expect(codes(validateMachine(withField('planner.lookahead', p(2.5))))).toEqual([
      'MACHINE_TYPE planner.lookahead.value',
    ]);
    expect(codes(validateMachine(withField('planner.lookahead', p(0))))).toEqual([
      'MACHINE_RANGE planner.lookahead.value',
    ]);
  });

  it('travel: min below max, within ±100,000, negatives allowed', () => {
    expect(validateMachine(withField('axes.Z.min', p(-100_000)))).toEqual([]);
    expect(codes(validateMachine(withField('axes.X.max', p(0))))).toEqual(['MACHINE_RANGE axes.X']);
    expect(codes(validateMachine(withField('axes.X.max', p(-5))))).toEqual([
      'MACHINE_RANGE axes.X',
    ]);
    expect(codes(validateMachine(withField('axes.Y.max', p(100_001))))).toEqual([
      'MACHINE_RANGE axes.Y.max.value',
    ]);
  });

  it('spindle: minRpm defaults to absent, and may not exceed maxRpm', () => {
    expect(validateMachine(withField('spindle.minRpm', p(0)))).toEqual([]);
    expect(validateMachine(withField('spindle.minRpm', p(18_000)))).toEqual([]);
    expect(codes(validateMachine(withField('spindle.minRpm', p(18_001))))).toEqual([
      'MACHINE_RANGE spindle',
    ]);
  });

  it('rotary axes: degrees, wider velocity, min and max both or neither', () => {
    const rotary = { maxVelocity: p(1_000_000), acceleration: p(5000) };
    expect(validateMachine(withField('axes.A', rotary))).toEqual([]);
    expect(validateMachine(withField('axes.A', { ...rotary, min: p(-90), max: p(90) }))).toEqual(
      [],
    );
    expect(codes(validateMachine(withField('axes.A', { ...rotary, min: p(-90) })))).toEqual([
      'MACHINE_MISSING axes.A',
    ]);
    expect(codes(validateMachine(withField('axes.A', { ...rotary, max: p(90) })))).toEqual([
      'MACHINE_MISSING axes.A',
    ]);
  });

  it('jerk is optional on any axis, and positive', () => {
    expect(validateMachine(withField('axes.X.jerk', p(5000)))).toEqual([]);
    expect(codes(validateMachine(withField('axes.X.jerk', p(0))))).toEqual([
      'MACHINE_RANGE axes.X.jerk.value',
    ]);
  });

  it('refuses non-finite numbers given directly (the parser refuses them in text)', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(codes(validateMachine(withField('axes.X.max', p(v))))).toEqual([
        'MACHINE_TYPE axes.X.max.value',
      ]);
    }
  });
});

describe('validateMachine: calibration', () => {
  it('takes a calibrated record with no seed values', () => {
    expect(validateMachine(calibrated())).toEqual([]);
  });

  it('refuses a calibrated record that still holds a seed value', () => {
    const r = withField('axes.Z.acceleration', p(200, 'seed'), calibrated());
    expect(codes(validateMachine(r))).toEqual(['MACHINE_VALUE calibration']);
  });

  it('refuses extra or missing fields in either state', () => {
    expect(codes(validateMachine(withField('calibration.fittedOn', '2026-10-22')))).toEqual([
      'MACHINE_UNKNOWN_FIELD calibration',
    ]);
    expect(
      codes(validateMachine(withField('calibration.residuals', undefined, calibrated()))),
    ).toEqual(['MACHINE_MISSING calibration.residuals']);
    expect(codes(validateMachine(withField('calibration.status', 'pending')))).toEqual([
      'MACHINE_VALUE calibration.status',
    ]);
  });

  it('fittedOn is a real date', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '26-10-22', '2026-10-22T00:00:00Z', 20261022]) {
      expect(codes(validateMachine(withField('calibration.fittedOn', bad, calibrated())))).toEqual([
        'MACHINE_VALUE calibration.fittedOn',
      ]);
    }
    expect(validateMachine(withField('calibration.fittedOn', '2028-02-29', calibrated()))).toEqual(
      [],
    );
  });

  it.each([
    ['timeFactor', 0.5, 2, 0.49, 2.01],
    ['accelFactor', 0.25, 4, 0.24, 4.01],
  ])('%s: %d to %d', (k, lo, hi, under, over) => {
    const path = `calibration.${k}`;
    expect(validateMachine(withField(path, lo, calibrated()))).toEqual([]);
    expect(validateMachine(withField(path, hi, calibrated()))).toEqual([]);
    expect(codes(validateMachine(withField(path, under, calibrated())))).toEqual([
      `MACHINE_RANGE ${path}`,
    ]);
    expect(codes(validateMachine(withField(path, over, calibrated())))).toEqual([
      `MACHINE_RANGE ${path}`,
    ]);
  });

  it('residuals: jobs a positive integer; 0 <= mean <= max <= 100', () => {
    const at = (k: string, v: unknown): string[] =>
      codes(validateMachine(withField(`calibration.residuals.${k}`, v, calibrated())));
    expect(at('jobs', 0)).toEqual(['MACHINE_RANGE calibration.residuals.jobs']);
    expect(at('jobs', 1.5)).toEqual(['MACHINE_TYPE calibration.residuals.jobs']);
    expect(at('maxAbsPercent', 100.5)).toEqual([
      'MACHINE_RANGE calibration.residuals.maxAbsPercent',
    ]);
    expect(at('maxAbsPercent', 2)).toEqual(['MACHINE_RANGE calibration.residuals']);
    expect(at('meanAbsPercent', -1)).toEqual([
      'MACHINE_RANGE calibration.residuals.meanAbsPercent',
    ]);
  });
});

describe('readMachine', () => {
  it('caps the text at 16,384 UTF-8 bytes, before parsing', () => {
    const pad = (n: number): string => EXAMPLE_TEXT + ' '.repeat(n - utf8Length(EXAMPLE_TEXT));
    expect(readMachine(pad(MAX_RECORD_BYTES)).ok).toBe(true);
    const over = readMachine(pad(MAX_RECORD_BYTES + 1));
    expect(over.ok ? [] : codes(over.problems)).toEqual(['MACHINE_TOO_LARGE ']);
    // Not even parsed: an over-size text of garbage gets the size problem only.
    const junk = readMachine('{'.repeat(MAX_RECORD_BYTES + 1));
    expect(junk.ok ? [] : codes(junk.problems)).toEqual(['MACHINE_TOO_LARGE ']);
  });

  it('caps by bytes, not UTF-16 units', () => {
    // Under the cap in UTF-16 units, over it in UTF-8 bytes (each € is 1 unit, 3 bytes).
    const text = EXAMPLE_TEXT + ' '.repeat(MAX_RECORD_BYTES - EXAMPLE_TEXT.length - 10);
    const euros = text.replace(
      '"Example router (fictional)"',
      `"Example router (fictional) ${'€'.repeat(9)}"`,
    );
    expect(euros.length).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    const r = readMachine(euros);
    expect(r.ok ? [] : codes(r.problems)).toEqual(['MACHINE_TOO_LARGE ']);
  });

  it('counts bytes, not UTF-16 units', () => {
    expect(utf8Length('aé€' + String.fromCodePoint(0x1f528))).toBe(1 + 2 + 3 + 4);
    expect(utf8Length(String.fromCharCode(0xd800))).toBe(3);
    // A lone high surrogate before an ordinary character: 3 bytes for the surrogate's
    // replacement, then the character's own.
    expect(utf8Length(`${String.fromCharCode(0xd800)}a`)).toBe(3 + 1);
    expect(utf8Length(String.fromCharCode(0xdc00, 0xd800))).toBe(3 + 3);
  });

  it('refuses a repeated key as a JSON problem', () => {
    const r = readMachine(EXAMPLE_TEXT.replace('"revision": 1,', '"revision": 1, "revision": 1,'));
    expect(r.ok ? [] : codes(r.problems)).toEqual(['MACHINE_JSON ']);
  });

  it('hashes the record as received: spelling never matters, values always do', () => {
    const a = readMachine(EXAMPLE_TEXT);
    const b = readMachine(JSON.stringify(JSON.parse(EXAMPLE_TEXT)));
    const c = readMachine(EXAMPLE_TEXT.replace('"value": 2440', '"value": 2440.5'));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.hash).toBe(b.hash);
      expect(a.hash).not.toBe(c.hash);
    }
  });
});

describe('the JSON Schema', () => {
  type S = { [k: string]: unknown };
  const props = (s: unknown): string[] => Object.keys(((s as S)['properties'] ?? {}) as S).sort();
  const at = (...keys: string[]): S => {
    let s: unknown = SCHEMA;
    for (const k of keys) s = ((s as S)['properties'] as S)[k];
    return s as S;
  };

  it('is draft 2020-12, and closed at every level', () => {
    expect(SCHEMA['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    const walk = (s: unknown, path: string): void => {
      if (typeof s !== 'object' || s === null) return;
      const o = s as S;
      // A physical field is closed through its $ref to P, which is closed itself.
      if (o['type'] === 'object' && o['$ref'] !== '#/$defs/P') {
        expect(o['additionalProperties'], path).toBe(false);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}/${k}`);
    };
    walk(SCHEMA, '');
  });

  /**
   * A record with every optional field present, valid. The parity tests below start
   * from it, so a field the schema lists is checked in a record the code accepts.
   */
  function full(): Rec {
    const r = example();
    const axes = r['axes'] as Rec;
    for (const a of ['X', 'Y', 'Z']) (axes[a] as Rec)['jerk'] = p(5000);
    for (const a of ['A', 'B', 'C']) {
      axes[a] = {
        min: p(-90),
        max: p(90),
        maxVelocity: p(3600),
        acceleration: p(500),
        jerk: p(5000),
      };
    }
    r['rapidRate'] = p(10_000);
    r['planner'] = { junctionDeviation: p(0.02), blockRate: p(500), lookahead: p(200) };
    (r['spindle'] as Rec)['minRpm'] = p(6000);
    r['overheads'] = { toolChangeSeconds: p(60), programStartSeconds: p(30), pauseSeconds: p(120) };
    return r;
  }
  function fullCalibrated(): Rec {
    const r = JSON.parse(JSON.stringify(full()).replaceAll('"seed"', '"fitted"')) as Rec;
    r['calibration'] = calibrated()['calibration'];
    return r;
  }

  /**
   * Every closed object in the schema, paired with the path of the same object in a
   * record. `P` is reached through each physical field.
   */
  function closedObjects(): {
    schemaPath: string;
    recordPath: string;
    schema: S;
    record: () => Rec;
  }[] {
    const out: { schemaPath: string; recordPath: string; schema: S; record: () => Rec }[] = [];
    const visit = (s: S, schemaPath: string, recordPath: string, record: () => Rec): void => {
      const target = s['$ref'] === '#/$defs/P' ? ((SCHEMA['$defs'] as S)['P'] as S) : s;
      if (target['additionalProperties'] === false) {
        out.push({ schemaPath, recordPath, schema: target, record });
      }
      for (const [k, v] of Object.entries((s['properties'] ?? {}) as S)) {
        if (s['$ref'] !== undefined && k === 'value') continue; // a P's own value
        visit(v as S, `${schemaPath}/${k}`, recordPath === '' ? k : `${recordPath}.${k}`, record);
      }
      const branches = s['oneOf'] as S[] | undefined;
      branches?.forEach((b, i) =>
        visit(b, `${schemaPath}/oneOf/${i}`, recordPath, i === 0 ? record : fullCalibrated),
      );
    };
    visit(SCHEMA, '', '', full);
    return out;
  }

  const get = (r: Rec, path: string): unknown =>
    path === '' ? r : path.split('.').reduce<unknown>((o, k) => (o as Rec)[k], r);

  it('the full records are valid, so the parity tests start from accepted input', () => {
    expect(validateMachine(full())).toEqual([]);
    expect(validateMachine(fullCalibrated())).toEqual([]);
  });

  it('every field the schema lists is present in the full records, and accepted', () => {
    const objects = closedObjects();
    expect(objects.length).toBeGreaterThan(40);
    for (const o of objects) {
      const record = o.record();
      const here = get(record, o.recordPath) as Rec;
      // The record holds exactly the schema's fields at this object: nothing the
      // schema lists is missing, and nothing the code accepts is unlisted.
      expect(Object.keys(here).sort(), o.schemaPath).toEqual(
        Object.keys(o.schema['properties'] as S).sort(),
      );
      expect(validateMachine(record), o.schemaPath).toEqual([]);
    }
  });

  it("each schema object lists exactly the code's fields, with the same required set", () => {
    const def = (s: S): S => (s['$ref'] === '#/$defs/P' ? ((SCHEMA['$defs'] as S)['P'] as S) : s);
    const axes = at('axes');
    const cal = (at('calibration')['oneOf'] as S[]).map(def);
    const pairs: [keyof typeof MACHINE_FIELDS, S][] = [
      ['record', SCHEMA],
      ['axes', axes],
      ['linearAxis', at('axes', 'X')],
      ['rotaryAxis', at('axes', 'A')],
      ['planner', at('planner')],
      ['spindle', at('spindle')],
      ['overheads', at('overheads')],
      ['uncalibrated', cal[0] as S],
      ['calibrated', cal[1] as S],
      ['residuals', ((cal[1] as S)['properties'] as S)['residuals'] as S],
      ['p', def(at('rapidRate'))],
    ];
    for (const [name, schema] of pairs) {
      const fields = MACHINE_FIELDS[name];
      expect(props(schema), name).toEqual([...fields.required, ...fields.optional].sort());
      expect([...((schema['required'] ?? []) as string[])].sort(), name).toEqual(
        [...fields.required].sort(),
      );
    }
    for (const a of ['Y', 'Z']) expect(at('axes', a)).toEqual(at('axes', 'X'));
    for (const a of ['B', 'C']) expect(at('axes', a)).toEqual(at('axes', 'A'));
  });

  it('every closed object in the schema is closed in the code too', () => {
    for (const o of closedObjects()) {
      const record = o.record();
      (get(record, o.recordPath) as Rec)['stray'] = 1;
      expect(codes(validateMachine(record)), o.schemaPath).toEqual([
        `MACHINE_UNKNOWN_FIELD ${o.recordPath}`,
      ]);
    }
  });

  it("every numeric bound in the schema is the code's bound", () => {
    // Fields in a cross-field rule (min < max, minRpm <= maxRpm): the partner is moved
    // to the far extreme first, so only the field's own bound decides. A travel min at
    // its maximum (or max at its minimum) can't satisfy min < max at all, so for those
    // only the refusal side is tested.
    const partnerOf = (path: string): [string, number] | undefined => {
      if (/^axes\.[A-Z]\.min$/.test(path)) return [path.replace(/min$/, 'max'), 100_000];
      if (/^axes\.[A-Z]\.max$/.test(path)) return [path.replace(/max$/, 'min'), -100_000];
      if (path === 'spindle.minRpm') return ['spindle.maxRpm', 100_000];
      if (path === 'spindle.maxRpm') return ['spindle.minRpm', 0];
      const res = 'calibration.residuals.';
      if (path === `${res}meanAbsPercent`) return [`${res}maxAbsPercent`, 100];
      if (path === `${res}maxAbsPercent`) return [`${res}meanAbsPercent`, 0];
      return undefined;
    };
    const unreachable = (path: string, side: 'hi' | 'lo'): boolean =>
      (side === 'hi' && /^axes\.[A-Z]\.min$/.test(path)) ||
      (side === 'lo' && /^axes\.[A-Z]\.max$/.test(path));
    let checked = 0;
    for (const o of closedObjects()) {
      for (const [k, raw] of Object.entries(o.schema['properties'] as S)) {
        const field = raw as S;
        const isP = field['$ref'] === '#/$defs/P';
        const bounds = (isP ? (field['properties'] as S)['value'] : field) as S;
        if (bounds['type'] !== 'number' && bounds['type'] !== 'integer') continue;
        const path = o.recordPath === '' ? k : `${o.recordPath}.${k}`;
        const shape = (v: number): unknown =>
          isP ? p(v, o.record === full ? 'seed' : 'fitted') : v;
        const at = (v: number): string[] => {
          const r = o.record();
          const pair = partnerOf(path);
          if (pair) withField(pair[0], shape(pair[1]), r);
          withField(path, shape(v), r);
          return codes(validateMachine(r));
        };
        // Out of range, or (for revision) newer than this toolkit reads.
        const refusal = (w: string): unknown =>
          expect.stringMatching(
            new RegExp(`^MACHINE_(RANGE|VERSION) ${w.replaceAll('.', '\\.')}$`),
          );
        const tiny = (x: number): number => Math.max(Math.abs(x) * 1e-9, 1e-9);
        // A small step past a bound: 1 for an integer, tiny(x) otherwise. So a bound that
        // drifts between the schema and the code by more than tiny(x) is caught (a drift
        // smaller than that passes).
        const step = (x: number): number => (bounds['type'] === 'integer' ? 1 : tiny(x));
        const hi = bounds['maximum'] as number | undefined;
        const lo = bounds['minimum'] as number | undefined;
        const gt = bounds['exclusiveMinimum'] as number | undefined;
        const where = isP ? `${path}.value` : path;
        if (hi !== undefined) {
          if (!unreachable(path, 'hi')) expect(at(hi), `${path} at its maximum`).toEqual([]);
          // Past MAX_SAFE_INTEGER an integer is no longer safe: the code refuses its type.
          const over = hi === Number.MAX_SAFE_INTEGER ? `MACHINE_TYPE ${where}` : refusal(where);
          expect(at(hi + step(hi)), `${path} over`).toContainEqual(over);
        }
        if (lo !== undefined) {
          if (!unreachable(path, 'lo')) expect(at(lo), `${path} at its minimum`).toEqual([]);
          expect(at(lo - step(lo)), `${path} under`).toContainEqual(refusal(where));
        }
        if (gt !== undefined) {
          expect(at(gt), `${path} at its exclusive minimum`).toContainEqual(refusal(where));
          expect(at(gt + step(gt)), `${path} just above`).toEqual([]);
        }
        if (bounds['type'] === 'integer') {
          // Near MAX_SAFE_INTEGER, x - 0.5 rounds to an integer: test the fraction lower down.
          const f = Math.min(hi ?? 10, 10) - 0.5;
          expect(at(f), `${path} a fraction`).toContain(`MACHINE_TYPE ${where}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("the dialects are the code's", () => {
    expect((at('dialect')['enum'] as string[]).sort()).toEqual([...MACHINE_DIALECTS].sort());
  });

  it('names a unit in every physical field’s description', () => {
    const fields = [
      ...['X', 'Y', 'Z', 'A'].flatMap((a) => props(at('axes', a)).map((k) => at('axes', a, k))),
      at('rapidRate'),
      ...props(at('planner')).map((k) => at('planner', k)),
      ...props(at('spindle')).map((k) => at('spindle', k)),
      ...props(at('overheads')).map((k) => at('overheads', k)),
    ];
    for (const f of fields) {
      const value = (f['properties'] as S)['value'] as S;
      expect(value['description']).toMatch(/^In \S/);
    }
  });
});
