// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse, tokenizeLine, write } from '../index.js';

// Tokenizer hardening for public input (plan §4.8): it never throws, and it runs in time
// linear in the line's length, whatever the line.

describe('the tokenizer on hostile lines', () => {
  it('reads a 10,000-deep sign chain and "#" chain without throwing', () => {
    const signs = `X${'-'.repeat(10_000)}#1`;
    const r = tokenizeLine(signs, 1);
    expect(r.tokens[0]).toMatchObject({ kind: 'word', letter: 'X', value: { kind: 'expression' } });
    expect(r.tokens[0]?.span).toEqual({ start: 0, end: signs.length });
    const hashes = `#${'#'.repeat(10_000)}1=2`;
    const h = tokenizeLine(hashes, 1);
    expect(h.tokens[0]).toMatchObject({ kind: 'assignment' });
    expect(h.tokens[0]?.span.end).toBe(hashes.length);
    // Signs that end in nothing: an error, not a throw.
    expect(tokenizeLine(`X${'+'.repeat(10_000)}`, 1).diagnostics.map((d) => d.code)).toContain(
      'SYNTAX_MISSING_VALUE',
    );
    expect(tokenizeLine('#'.repeat(10_000), 1).diagnostics.map((d) => d.code)).toContain(
      'SYNTAX_MISSING_VALUE',
    );
  });

  it('reads what it read before: signs, ## and functions', () => {
    const value = (src: string) => {
      const t = tokenizeLine(src, 1).tokens[0];
      return t?.kind === 'word' && t.value ? src.slice(t.value.span.start, t.value.span.end) : null;
    };
    expect(value('X-#1')).toBe('-#1');
    expect(value('X - [#2*2]')).toBe('- [#2*2]');
    expect(value('X+SIN[30]')).toBe('+SIN[30]');
    expect(value('X--#1')).toBe('--#1');
    expect(value('X--5')).toBe('--5');
    expect(value('X-5')).toBe('-5');
    expect(value('X##2')).toBe('##2');
    expect(value('X# #2')).toBe('# #2');
    expect(value('XATAN[1]/[2]')).toBe('ATAN[1]/[2]');
    expect(value('XSQRTY')).toBeNull(); // not a function: X has no value
  });

  it('property: no line makes it throw, and every line writes back as it was', () => {
    const piece = fc.constantFrom(
      '-',
      '+',
      '#',
      '##',
      '[',
      ']',
      'X',
      'M',
      'N1',
      'M3',
      'MSG ',
      'SIN[',
      'O100',
      '<',
      '>',
      '(',
      ')',
      ';',
      ' ',
      '1',
      '.',
      '=',
      'e',
      '%',
      '/',
      '*',
      '\u{1F600}',
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 400 }), (parts) => {
        const line = parts.join('');
        expect(() => tokenizeLine(line, 1)).not.toThrow();
        expect(write(parse(line))).toBe(line);
      }),
      { numRuns: 500 },
    );
  });

  it('runs in time linear in the line length on the patterns that were quadratic', () => {
    // Each was quadratic before: M words re-walking every earlier token, a word's value
    // scanning every following letter, long sign and "#" chains (recursive).
    const lines = (n: number) => [
      'N1 '.repeat(n / 2) + 'M3 '.repeat(n / 2),
      'X'.repeat(n),
      `X${'-'.repeat(n)}#1`,
      `#${'#'.repeat(n)}1=2`,
    ];
    const time = (n: number) =>
      lines(n).map((l) => {
        let best = Infinity;
        for (let k = 0; k < 3; k++) {
          const t0 = performance.now();
          tokenizeLine(l, 1);
          best = Math.min(best, performance.now() - t0);
        }
        return best;
      });
    const small = time(20_000);
    const large = time(80_000);
    // Four times the length: about four times the time if linear, sixteen if quadratic.
    // The bound is loose for noisy CI machines, and a floor ignores sub-millisecond runs.
    large.forEach((t, i) =>
      expect(t, `pattern ${i}: ${small[i]} ms → ${t} ms`).toBeLessThan(
        Math.max(10 * (small[i] as number), 20),
      ),
    );
  }, 60_000);
});
