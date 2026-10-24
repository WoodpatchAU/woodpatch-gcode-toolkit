// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERRORS, REQUEST_FIELDS, SCOPE, parseRequest } from './contract.js';
import { handleEstimate } from './handle.js';

type Schema = Record<string, unknown>;
const load = (name: string): Schema =>
  JSON.parse(readFileSync(new URL(`../schema/${name}.schema.json`, import.meta.url), 'utf8'));
const REQUEST = load('estimate-request-v1');
const RESPONSE = load('estimate-response-v1');
const ERROR = load('estimate-error-v1');

const KNOWN = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'oneOf',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'maxItems',
  'minimum',
  'maximum',
  'pattern',
  'maxLength',
  'if',
  'then',
  'else',
]);

/**
 * Validates `v` against the subset of JSON Schema these files use, and returns the
 * failures. Any other keyword fails the test, so none can be silently ignored.
 */
function check(s: Schema, v: unknown, path = ''): string[] {
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) return [`${path}: keyword ${k}`];
  const out: string[] = [];
  const t = s.type as string | undefined;
  const typeOf = (x: unknown): string =>
    x === null ? 'null' : Array.isArray(x) ? 'array' : Number.isInteger(x) ? 'integer' : typeof x;
  if (t !== undefined) {
    const actual = typeOf(v);
    if (!(actual === t || (t === 'number' && actual === 'integer')))
      return [`${path}: ${actual}, not ${t}`];
  }
  if ('const' in s && v !== s.const) out.push(`${path}: not the constant`);
  if (s.enum && !(s.enum as unknown[]).includes(v)) out.push(`${path}: not in enum`);
  if (s.oneOf) {
    const ok = (s.oneOf as Schema[]).filter((o) => check(o, v, path).length === 0).length;
    if (ok !== 1) out.push(`${path}: matches ${ok} of oneOf`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${path}: below minimum`);
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${path}: above maximum`);
  }
  if (typeof v === 'string' && s.pattern && !new RegExp(s.pattern as string, 'u').test(v)) {
    out.push(`${path}: pattern`);
  }
  // JSON Schema counts code points.
  if (typeof v === 'string' && typeof s.maxLength === 'number') {
    if (Array.from(v).length > s.maxLength) out.push(`${path}: too long`);
  }
  if (s.if) {
    const branch = check(s.if as Schema, v, path).length === 0 ? s.then : s.else;
    if (branch) out.push(...check(branch as Schema, v, path));
  }
  if (Array.isArray(v)) {
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${path}: too long`);
    if (s.items) v.forEach((x, i) => out.push(...check(s.items as Schema, x, `${path}[${i}]`)));
  }
  // Applied to any object value, as JSON Schema does, with or without "type" (if/then).
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) {
      if (!Object.hasOwn(v, r)) out.push(`${path}.${r}: missing`);
    }
    for (const [k, x] of Object.entries(v)) {
      if (props[k]) out.push(...check(props[k], x, `${path}.${k}`));
      else if (s.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
    }
  }
  return out;
}

/** Every object schema in a file is closed. */
function objects(s: unknown, path = '', out: [string, Schema][] = []): [string, Schema][] {
  if (typeof s !== 'object' || s === null) return out;
  const o = s as Schema;
  if (o.type === 'object') out.push([path, o]);
  for (const [k, v] of Object.entries(o)) objects(v, `${path}/${k}`, out);
  return out;
}

const RECORD = readFileSync(
  new URL('../../db-schema/examples/example-router.json', import.meta.url),
  'utf8',
);
const body = (gcode: string, extra: object = {}) =>
  JSON.stringify({ v: 1, scope: 'contact:1', gcode, machine: RECORD, ...extra });

const PROGRAMS = [
  'G21 G90\nM3 S12000\nG0 X0 Y0 Z5\nG1 Z-1 F300\nG1 X100 F1500\nT2 M6\nG4 P1\nM5\nM30\n',
  'G1 X1 Q1\n'.repeat(150),
  'G0 X0\nG0 X3000\nG1 X5 F0\n',
  '',
];

describe('the JSON Schemas', () => {
  it('are draft 2020-12, with every object closed', () => {
    for (const s of [REQUEST, RESPONSE, ERROR]) {
      expect(s.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      for (const [path, o] of objects(s)) {
        expect(o.additionalProperties, path).toBe(false);
        expect(Object.keys(o.properties as object), path).toEqual(
          expect.arrayContaining(o.required as string[]),
        );
      }
    }
  });

  it('bound every string in a response or an error body', () => {
    // The request's strings are bounded by the code's byte caps instead (ADR-0044).
    const strings = (o: unknown, path = ''): [string, Schema][] => {
      if (typeof o !== 'object' || o === null) return [];
      const node = o as Schema;
      const here: [string, Schema][] = node.type === 'string' ? [[path, node]] : [];
      return here.concat(Object.entries(node).flatMap(([k, v]) => strings(v, `${path}/${k}`)));
    };
    for (const s of [RESPONSE, ERROR]) {
      const all = strings(s);
      expect(all.length).toBeGreaterThan(3);
      for (const [path, node] of all) {
        expect(node.maxLength, path).toBeTypeOf('number');
        expect(node.maxLength as number, path).toBeLessThanOrEqual(500);
      }
    }
  });

  it('describe the request the parser takes', () => {
    expect(REQUEST.required).toEqual([...REQUEST_FIELDS]);
    expect(Object.keys(REQUEST.properties as object)).toEqual([...REQUEST_FIELDS]);
    expect(((REQUEST.properties as Record<string, Schema>).scope as Schema).pattern).toBe(
      SCOPE.source,
    );
    for (const g of PROGRAMS) expect(check(REQUEST, JSON.parse(body(g)))).toEqual([]);
  });

  it('describe every response the handler gives', () => {
    for (const g of PROGRAMS) {
      const r = parseRequest(body(g));
      if (!r.ok) throw new Error(r.error.error.code);
      const res = JSON.parse(JSON.stringify(handleEstimate(r.request, 'b')));
      expect(check(RESPONSE, res), g.slice(0, 20)).toEqual([]);
    }
  });

  it('refuse a time that is not a whole millisecond, and any field they do not list', () => {
    const r = parseRequest(body(PROGRAMS[0] as string));
    if (!r.ok) throw new Error(r.error.error.code);
    const res = JSON.parse(JSON.stringify(handleEstimate(r.request, 'b')));
    expect(check(RESPONSE, { ...res, estimate: { ...res.estimate, knownMs: 1.5 } })).not.toEqual(
      [],
    );
    expect(check(RESPONSE, { ...res, estimate: { ...res.estimate, totalMs: 2.5 } })).not.toEqual(
      [],
    );
    expect(check(RESPONSE, { ...res, extra: 1 })).not.toEqual([]);
    expect(check(RESPONSE, { ...res, build: 'has a space' })).not.toEqual([]);
    expect(check(RESPONSE, { ...res, build: 'b'.repeat(129) })).not.toEqual([]);
  });

  it("express ADR-0044's two biconditionals", () => {
    const r = parseRequest(body(PROGRAMS[0] as string));
    if (!r.ok) throw new Error(r.error.error.code);
    const res = JSON.parse(JSON.stringify(handleEstimate(r.request, 'b')));
    expect(res.estimate.complete).toBe(true);
    expect(check(RESPONSE, res)).toEqual([]);
    const est = (o: object) => ({ ...res, estimate: { ...res.estimate, ...o } });
    // A total exactly when complete.
    expect(check(RESPONSE, est({ totalMs: null }))).not.toEqual([]);
    expect(check(RESPONSE, est({ complete: false }))).not.toEqual([]);
    expect(check(RESPONSE, est({ complete: false, totalMs: null }))).toEqual([]);
    // Calibrated exactly when the record says so.
    expect(check(RESPONSE, est({ calibrated: true }))).not.toEqual([]);
    const rec = { ...res.record, calibration: 'calibrated' };
    expect(check(RESPONSE, { ...res, record: rec })).not.toEqual([]);
    expect(check(RESPONSE, { ...est({ calibrated: true }), record: rec })).toEqual([]);
  });

  it('list exactly the error codes, and describe the error bodies', () => {
    const errorProps = (ERROR.properties as Record<string, Schema>).error as Schema;
    const code = (errorProps.properties as Record<string, Schema>).code as Schema;
    expect(code.enum).toEqual(Object.keys(ERRORS));
    for (const text of [
      '{',
      '[]',
      body('', { v: 2 }),
      body('', { toolId: '1' }),
      body('', { machine: '{' }),
    ]) {
      const r = parseRequest(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(check(ERROR, JSON.parse(JSON.stringify(r.error))), text).toEqual([]);
    }
  });
});
