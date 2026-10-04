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

  it('reports a malformed "##" from its innermost "#", as it did before the loop', () => {
    const at = (src: string) =>
      tokenizeLine(src, 1)
        .diagnostics.filter((d) => d.code !== 'SYNTAX_UNEXPECTED_CHARACTER')
        .map((d) => `${d.code} ${d.span?.start}-${d.span?.end}`);
    expect(at('X##')).toContain('SYNTAX_MISSING_VALUE 2-3');
    expect(at('X# #')).toContain('SYNTAX_MISSING_VALUE 3-4');
    expect(at('##<abc')).toEqual(['SYNTAX_UNTERMINATED_NAME 1-6']);
    expect(at('X-##')).toContain('SYNTAX_MISSING_VALUE 3-4');
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
    // Both were quadratic before: M words re-walking every earlier token, and a word's
    // value scanning every following letter. (The sign and "#" chains were recursive,
    // not slow: the no-throw test above covers them.)
    const lines = (n: number) => ['N1 '.repeat(n / 2) + 'M3 '.repeat(n / 2), 'X'.repeat(n)];
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
    const small = time(10_000);
    const large = time(80_000);
    // Eight times the length: about 8x the time if linear, 64x if quadratic. A bound of
    // 32x leaves room for a busy CI machine (the review saw up to 8.4x on 4x lengths
    // under load) and still fails a quadratic scan. The floor ignores sub-ms runs.
    large.forEach((t, i) =>
      expect(t, `pattern ${i}: ${small[i]} ms → ${t} ms`).toBeLessThan(
        Math.max(32 * (small[i] as number), 40),
      ),
    );
  }, 60_000);
});

describe('the tokenizer keeps its diagnostics bounded', () => {
  it('merges a run of the same unexpected character, caps distinct ones, reports each once', () => {
    const run = tokenizeLine('G1 X1 $$$ Y2 @', 1).diagnostics;
    expect(run.map((d) => `${d.span?.start}-${d.span?.end}`)).toEqual(['6-9', '13-14']);
    expect(run[0]?.message).toContain('3 of them');
    expect(tokenizeLine('!'.repeat(2_000_000), 1).diagnostics).toHaveLength(1);
    let mixed = '';
    for (let i = 0; i < 1000; i++) mixed += '!@$%'[i % 4];
    const capped = tokenizeLine(mixed, 1).diagnostics;
    expect(capped).toHaveLength(101);
    expect(capped.at(-1)?.message).toContain('not listed');
    // X-## once read "##" twice (after the failed sign chain): one report now.
    const twice = tokenizeLine('X-##', 1).diagnostics.filter(
      (d) => d.code === 'SYNTAX_MISSING_VALUE' && d.span?.start !== 0,
    );
    expect(twice).toHaveLength(1);
  });
});
