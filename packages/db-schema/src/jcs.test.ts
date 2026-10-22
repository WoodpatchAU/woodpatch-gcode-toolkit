// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, contentHash, sha256Hex, utf8 } from './jcs.js';
import { parseStrictJson, type JsonValue } from './json.js';

const parse = (text: string): JsonValue => {
  const r = parseStrictJson(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe('canonicalJson (RFC 8785)', () => {
  it("matches the RFC's own example (section 3.2.2)", () => {
    const input = String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`;
    expect(canonicalJson(parse(input))).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it('sorts keys by UTF-16 code units (section 3.2.3)', () => {
    const input = String.raw`{"\u20ac":1,"\r":2,"\ufb33":3,"1":4,"\ud83d\ude00":5,"\u0080":6,"\u00f6":7}`;
    // Read the order from the text: JSON.parse would move the integer-like key "1" first.
    const order = [...canonicalJson(parse(input)).matchAll(/:(\d)/g)].map((m) => m[1]);
    expect(order).toEqual(['2', '4', '6', '7', '1', '5', '3']);
  });

  it('writes numbers in shortest round-trip form', () => {
    expect(canonicalJson(parse('[-0, 2.0, 1e21, 1e-7, 100]'))).toBe('[0,2,1e+21,1e-7,100]');
  });

  it('refuses what JCS cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow('not finite');
    expect(() => canonicalJson('\ud800')).toThrow('lone surrogate');
    expect(() => canonicalJson({ ['\udc00']: 1 })).toThrow('lone surrogate');
  });

  it('reads own keys only', () => {
    const o = Object.create({ inherited: 1 }) as Record<string, JsonValue>;
    o['own'] = 2;
    expect(canonicalJson(o)).toBe('{"own":2}');
  });
});

describe('sha256Hex', () => {
  it('matches the FIPS 180 examples', () => {
    expect(sha256Hex(utf8(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it("matches Node's crypto on any bytes, across block boundaries", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
      }),
      { numRuns: 500 },
    );
  });
});

describe('utf8', () => {
  it("matches Node's encoder on well-formed strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (s) => {
        expect(Buffer.from(utf8(s)).equals(Buffer.from(s, 'utf8'))).toBe(true);
      }),
    );
  });
});

describe('contentHash', () => {
  it('is the same for any spelling of the same record', () => {
    const a = parse('{"b": 1.0, "a": [ "x" ]}');
    const b = parse('{"a":["\\u0078"],"b":1}');
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).toBe(createHash('sha256').update('{"a":["x"],"b":1}').digest('hex'));
  });

  it('changes when any value changes', () => {
    expect(contentHash(parse('{"a":1}'))).not.toBe(contentHash(parse('{"a":1.5}')));
  });
});
