// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { parse } from '@woodpatch/gcode-core';
import { contentHash, parseStrictJson } from '@woodpatch/gcode-db';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ERRORS,
  MAX_GCODE_BYTES,
  MAX_GCODE_LINES,
  countLines,
  parseRequest,
  type ErrorCode,
} from './contract.js';

const RECORD = readFileSync(
  new URL('../../db-schema/examples/example-router.json', import.meta.url),
  'utf8',
);
const GOOD = { v: 1, scope: 'contact:3f2a-11', gcode: 'G0 X1\n', machine: RECORD };
const body = (o: Record<string, unknown>): string => JSON.stringify(o);
const codeOf = (text: string): ErrorCode | 'ok' => {
  const r = parseRequest(text);
  return r.ok ? 'ok' : r.error.error.code;
};

describe('parseRequest', () => {
  it('accepts a good request, and hashes the record as received', () => {
    const r = parseRequest(body(GOOD));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.scope).toBe(GOOD.scope);
    expect(r.request.gcode).toBe(GOOD.gcode);
    const parsed = parseStrictJson(RECORD);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(r.request.recordHash).toBe(contentHash(parsed.value));
  });

  it('refuses a body that is not strict JSON', () => {
    expect(codeOf('{')).toBe('REQUEST_MALFORMED');
    expect(codeOf('{"v":1,"v":1}')).toBe('REQUEST_MALFORMED');
    // Equal after escapes are decoded: still a repeated key.
    expect(codeOf('{"v":1,"\\u0076":1}')).toBe('REQUEST_MALFORMED');
    expect(codeOf('{"v":1,"scope":"\\ud800"}')).toBe('REQUEST_MALFORMED');
  });

  it('reads the version before anything else', () => {
    expect(codeOf('[]')).toBe('REQUEST_INVALID');
    expect(codeOf(body({ ...GOOD, v: undefined }))).toBe('REQUEST_INVALID');
    for (const v of [2, 0, '1', null, 1.5]) {
      expect(codeOf(body({ ...GOOD, v })), String(v)).toBe('REQUEST_VERSION');
    }
    // A request of another version is judged by that version, not this one's fields.
    expect(codeOf(body({ v: 2, other: true }))).toBe('REQUEST_VERSION');
  });

  it('refuses unknown and reserved fields, and a hash the caller supplies', () => {
    for (const extra of ['toolId', 'materialId', 'hash', 'recordHash', 'dialect', '__proto__']) {
      const text = body({ ...GOOD }).replace(/}$/, `,${JSON.stringify(extra)}:"1"}`);
      expect(codeOf(text), extra).toBe('REQUEST_INVALID');
    }
    for (const missing of ['scope', 'gcode', 'machine']) {
      expect(codeOf(body({ ...GOOD, [missing]: undefined })), missing).toBe('REQUEST_INVALID');
    }
  });

  it('takes scope as an opaque token, 1-64 of A-Z a-z 0-9 : _ -', () => {
    for (const scope of ['a', 'staff:0b9e-77', 'A_b-C:9', 'x'.repeat(64)]) {
      expect(codeOf(body({ ...GOOD, scope })), scope).toBe('ok');
    }
    for (const scope of ['', 'x'.repeat(65), 'a b', 'a/b', 'a.b', 'é', 'a\n', 1, null]) {
      expect(codeOf(body({ ...GOOD, scope })), String(scope)).toBe('REQUEST_INVALID');
    }
  });

  it('takes the G-code and the record as strings', () => {
    expect(codeOf(body({ ...GOOD, gcode: ['G0'] }))).toBe('REQUEST_INVALID');
    // The record travels as its own text (ADR-0041's wire form), never as an object.
    expect(codeOf(body({ ...GOOD, machine: JSON.parse(RECORD) }))).toBe('REQUEST_INVALID');
  });

  it('refuses G-code over its byte or line cap, at the cap itself accepted', () => {
    expect(codeOf(body({ ...GOOD, gcode: 'G'.repeat(MAX_GCODE_BYTES) }))).toBe('ok');
    expect(codeOf(body({ ...GOOD, gcode: 'G'.repeat(MAX_GCODE_BYTES + 1) }))).toBe(
      'PROGRAM_TOO_LARGE',
    );
    // Bytes, not characters: é is two.
    expect(codeOf(body({ ...GOOD, gcode: 'é'.repeat(MAX_GCODE_BYTES / 2 + 1) }))).toBe(
      'PROGRAM_TOO_LARGE',
    );
    // n line breaks are n + 1 lines, as core reads them.
    expect(codeOf(body({ ...GOOD, gcode: '\n'.repeat(MAX_GCODE_LINES - 1) }))).toBe('ok');
    expect(codeOf(body({ ...GOOD, gcode: '\n'.repeat(MAX_GCODE_LINES) }))).toBe(
      'PROGRAM_TOO_LARGE',
    );
  });

  it('refuses a bad record, listing why', () => {
    const r = parseRequest(body({ ...GOOD, machine: RECORD.replace('"generic"', '"grbl"') }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.error.code).toBe('MACHINE_INVALID');
    expect(r.error.error.problems?.map((p) => p.path)).toEqual(['dialect']);
    expect(codeOf(body({ ...GOOD, machine: '{' }))).toBe('MACHINE_INVALID');
  });

  it("never quotes the request's content in a message", () => {
    const secret = 'SECRET-JOB-7';
    const cases: string[] = [
      body({ ...GOOD, v: secret }),
      body({ ...GOOD, scope: `${secret} x` }),
      body({ ...GOOD, gcode: [secret] }),
      body({ ...GOOD, gcode: `(${secret})${'G'.repeat(MAX_GCODE_BYTES)}` }),
      body({ ...GOOD, machine: RECORD.replace('"Example router (fictional)"', `"${secret}\n"`) }),
      `{"v":1,"scope":"${secret}`,
    ];
    for (const text of cases) {
      const r = parseRequest(text);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
    // A field name is the exception, escaped to printable ASCII.
    const r = parseRequest(body({ ...GOOD }).replace(/}$/, ',"a\\u2028b":1}'));
    expect(r.ok ? '' : r.error.error.message).toContain('"a\\u2028b"');
  });
});

describe('countLines', () => {
  it("counts lines as core's parser does", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a\r\n]{0,30}$/), (text) => {
        expect(countLines(text)).toBe(parse(text).lines.length);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('ERRORS', () => {
  it('only busy answers are retriable, and every status is an HTTP error status', () => {
    const retriable = Object.entries(ERRORS)
      .filter(([, e]) => e.retriable)
      .map(([c]) => c);
    expect(retriable.sort()).toEqual(['SCOPE_BUSY', 'SERVER_BUSY']);
    for (const e of Object.values(ERRORS)) expect(e.status).toBeGreaterThanOrEqual(400);
  });
});
