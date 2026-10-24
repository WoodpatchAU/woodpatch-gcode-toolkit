// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ResponseCache, type CacheInput } from './cache.js';

const IN: CacheInput = {
  scope: 'staff:1',
  gcode: 'G0 X1',
  recordHash: 'a'.repeat(64),
  build: 'b1',
};

describe('ResponseCache', () => {
  it('keys on every input, the scope included', () => {
    const c = new ResponseCache(10, 1e6);
    const base = c.key(IN);
    expect(c.key({ ...IN })).toBe(base);
    for (const k of ['scope', 'gcode', 'recordHash', 'build'] as const) {
      expect(c.key({ ...IN, [k]: `${IN[k]}x` }), k).not.toBe(base);
    }
  });

  it('never runs two inputs together into one key', () => {
    const c = new ResponseCache(10, 1e6);
    expect(c.key({ ...IN, scope: 'ab', build: 'c' })).not.toBe(
      c.key({ ...IN, scope: 'a', build: 'bc' }),
    );
  });

  it("uses a key of its own: another process's cache keys differently", () => {
    expect(new ResponseCache(10, 1e6).key(IN)).not.toBe(new ResponseCache(10, 1e6).key(IN));
  });

  it('evicts the least recently used, by count and by bytes', () => {
    const c = new ResponseCache(2, 1e6);
    c.set('a', '1');
    c.set('b', '2');
    expect(c.get('a')).toBe('1'); // a is now the most recent
    c.set('c', '3');
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual(['1', undefined, '3']);

    const bytes = new ResponseCache(100, 4000);
    bytes.set('x', 'x'.repeat(400)); // 800 bytes as UTF-16
    bytes.set('y', 'y'.repeat(400));
    bytes.set('z', 'z'.repeat(400));
    bytes.set('w', 'w'.repeat(400)); // 3,200: still fits
    bytes.set('v', 'v'.repeat(400)); // 4,000
    bytes.set('u', 'u'.repeat(400)); // past it: x goes
    expect(bytes.get('x')).toBeUndefined();
    expect(bytes.size).toBe(5);
  });

  it('never lets one response take more than a quarter of it', () => {
    const c = new ResponseCache(10, 4000);
    c.set('big', 'b'.repeat(600)); // 1,200 bytes > 1,000
    expect(c.get('big')).toBeUndefined();
  });
});
