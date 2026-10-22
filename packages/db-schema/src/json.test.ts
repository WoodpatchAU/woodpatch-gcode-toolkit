// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, parseStrictJson } from './json.js';

const code = (text: string): string | undefined => {
  const r = parseStrictJson(text);
  return r.ok ? undefined : r.error.code;
};

describe('parseStrictJson', () => {
  it('agrees with JSON.parse on any JSON without repeated keys', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 5 }), (v) => {
        const text = JSON.stringify(v);
        const r = parseStrictJson(text);
        expect(r.ok).toBe(true);
        if (r.ok) expect(JSON.stringify(r.value)).toBe(JSON.stringify(JSON.parse(text)));
      }),
    );
  });

  it('refuses a repeated key, compared after unescaping', () => {
    expect(code('{"a":1,"a":2}')).toBe('JSON_DUPLICATE_KEY');
    expect(code('{"a":1,"\\u0061":2}')).toBe('JSON_DUPLICATE_KEY');
    expect(code('{"m":{"a":1},"m":{"b":2}}')).toBe('JSON_DUPLICATE_KEY');
    expect(code('{"a":{"a":1}}')).toBeUndefined();
  });

  it('quotes a repeated key escaped and short', () => {
    const r = parseStrictJson(`{"\\n${'k'.repeat(100)}":1,"\\n${'k'.repeat(100)}":2}`);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).not.toContain('\n');
      expect(r.error.message.length).toBeLessThan(120);
    }
  });

  it('makes __proto__ an ordinary own key on a null-prototype object', () => {
    const r = parseStrictJson('{"__proto__":{"polluted":true},"a":1}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const o = r.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(o)).toBeNull();
    expect(Object.hasOwn(o, '__proto__')).toBe(true);
    expect(Object.keys(o)).toEqual(['__proto__', 'a']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses lone surrogates, escaped or literal, in values and keys', () => {
    expect(code('"\\ud800"')).toBe('JSON_LONE_SURROGATE');
    expect(code('"\\udc00\\ud800"')).toBe('JSON_LONE_SURROGATE');
    expect(code('{"\\ud800":1}')).toBe('JSON_LONE_SURROGATE');
    expect(code('"\ud800"')).toBe('JSON_LONE_SURROGATE');
    expect(code('"\\ud83d\\ude00"')).toBeUndefined();
  });

  it('refuses numbers that overflow', () => {
    expect(code('1e400')).toBe('JSON_NUMBER_RANGE');
    expect(code('-1e400')).toBe('JSON_NUMBER_RANGE');
    expect(code('1e-400')).toBeUndefined(); // underflows to 0, which is finite
  });

  it('refuses nesting past MAX_DEPTH, and allows it up to there', () => {
    expect(code('['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH))).toBeUndefined();
    expect(code('['.repeat(MAX_DEPTH + 1) + ']'.repeat(MAX_DEPTH + 1))).toBe('JSON_TOO_DEEP');
    expect(code('['.repeat(100_000))).toBe('JSON_TOO_DEEP');
  });

  it('refuses what RFC 8259 refuses', () => {
    for (const bad of [
      '',
      ' ',
      '{',
      '{"a"}',
      '{"a":1,}',
      '[1,]',
      '01',
      '1.',
      '.5',
      '+1',
      '0x10',
      'NaN',
      'tru',
      '"a',
      '"\t"',
      '"\\x"',
      '"\\u12"',
      "'a'",
      '1 2',
      '{"a":1}x',
      ' 1',
    ]) {
      expect(code(bad), JSON.stringify(bad)).toBe('JSON_SYNTAX');
    }
  });

  it('never throws, on any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(() => parseStrictJson(s)).not.toThrow();
      }),
    );
  });
});
