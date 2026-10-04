// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PARAMETERS,
  LINUXCNC_RULES,
  evaluate,
  interpret,
  parse,
  parseExpression,
  type ExpressionRules,
  type ParameterReader,
} from '../index.js';

const params = (
  numbered: Record<number, number> = {},
  named: Record<string, number> = {},
): ParameterReader => ({
  numbered: (i) => numbered[i] ?? 0,
  named: (n) => named[n],
});

/** Parse and evaluate `src` as a whole value; returns the number or the diagnostic codes. */
function run(
  src: string,
  p: ParameterReader = EMPTY_PARAMETERS,
  rules: ExpressionRules = LINUXCNC_RULES,
) {
  const parsed = parseExpression(src, { start: 0, end: src.length }, 1, rules);
  if (!parsed.expr)
    return {
      codes: parsed.diagnostics.map((d) => d.code),
      spans: parsed.diagnostics.map((d) => d.span),
    };
  const r = evaluate(parsed.expr, p, rules, 1);
  return r.value === null
    ? { codes: r.diagnostics.map((d) => d.code), spans: r.diagnostics.map((d) => d.span) }
    : r.value;
}
const close = (v: unknown, want: number) => {
  expect(typeof v).toBe('number');
  expect(v as number).toBeCloseTo(want, 9);
};

describe('values', () => {
  it('reads plain numbers, signed and dotted', () => {
    expect(run('1.5')).toBe(1.5);
    expect(run('-.5')).toBe(-0.5);
    expect(run('+2.')).toBe(2);
  });

  it('applies unary minus and plus to any value, as LinuxCNC does', () => {
    expect(run('-#1', params({ 1: 4 }))).toBe(-4);
    expect(run('-[2+3]')).toBe(-5);
    expect(run('--2')).toBe(2);
    expect(run('-SIN[90]')).toBeCloseTo(-1, 12);
  });

  it('reads numbered, named, computed and indirect parameters', () => {
    const p = params({ 1: 7, 2: 3, 3: 11 }, { depth: -2 });
    expect(run('#1', p)).toBe(7);
    expect(run('#<depth>', p)).toBe(-2);
    expect(run('#<DePtH>', p)).toBe(-2); // names are case-insensitive
    expect(run('#[1+2]', p)).toBe(11);
    expect(run('##2', p)).toBe(11); // #2 = 3, so ##2 is #3
    expect(run('#9', p)).toBe(0); // unset numbered parameters are 0
  });
});

describe('operators (LinuxCNC precedence, verified against its docs)', () => {
  it('evaluates the documented example as [[2.0/3]*1.5]-[5.5/11.0] = 0.5', () => {
    close(run('[2.0 / 3 * 1.5 - 5.5 / 11.0]'), 0.5);
  });

  it('orders ** > * / MOD > + - > comparisons > logic, left-associative', () => {
    expect(run('[2 + 3 * 4]')).toBe(14);
    expect(run('[2 ** 3 ** 2]')).toBe(64); // left-associative: [2**3]**2
    expect(run('[1 + 1 EQ 2]')).toBe(1);
    expect(run('[1 LT 2 AND 3 GT 2]')).toBe(1);
    expect(run('[10 - 4 - 3]')).toBe(3);
  });

  it('is case-insensitive for word operators', () => {
    expect(run('[7 mod 3]')).toBe(1);
    expect(run('[1 and 0]')).toBe(0);
  });

  it('compares with LinuxCNC tolerance: [0.1+0.2] EQ 0.3 is true (upstream: false)', () => {
    expect(run('[[0.1+0.2] EQ 0.3]')).toBe(1);
    expect(run('[[0.1+0.2] NE 0.3]')).toBe(0);
    expect(run('[[0.1+0.2] GT 0.3]')).toBe(1); // 0.30000000000000004 > 0.3: GT is plain
    expect(run('[[0.1+0.2] LE 0.3]')).toBe(1);
  });

  it("pins LinuxCNC's corner: within the tolerance band, EQ, GE, LE and GT are ALL true", () => {
    // l = r + 5e-7: GT and LT are plain comparisons in LinuxCNC; only EQ/NE/GE/LE use the tolerance.
    const l = '[0.3 + 0.0000005]';
    expect(run(`[${l} EQ 0.3]`)).toBe(1);
    expect(run(`[${l} GE 0.3]`)).toBe(1);
    expect(run(`[${l} LE 0.3]`)).toBe(1);
    expect(run(`[${l} GT 0.3]`)).toBe(1);
    expect(run(`[${l} LT 0.3]`)).toBe(0);
    expect(run(`[${l} NE 0.3]`)).toBe(0);
  });

  it('compares exactly when the dialect says so', () => {
    expect(
      run('[[0.1+0.2] EQ 0.3]', EMPTY_PARAMETERS, { ...LINUXCNC_RULES, equalityTolerance: 0 }),
    ).toBe(0);
  });

  it('MOD is always positive, as LinuxCNC: -7 MOD 3 = 2 (upstream: -1)', () => {
    expect(run('[-7 MOD 3]')).toBe(2);
    expect(run('[-7 MOD 3]', EMPTY_PARAMETERS, { ...LINUXCNC_RULES, mod: 'truncated' })).toBe(-1);
  });

  it('XOR and logic treat any non-zero value as true', () => {
    expect(run('[2 XOR 0]')).toBe(1);
    expect(run('[2 XOR 3]')).toBe(0);
    expect(run('[0 OR -1]')).toBe(1);
  });
});

describe('functions (degrees, per RS274/NGC and LinuxCNC)', () => {
  it('takes and returns degrees: SIN[30] = 0.5 (upstream: -0.988, radians; N13)', () => {
    close(run('SIN[30]'), 0.5);
    close(run('COS[60]'), 0.5);
    close(run('TAN[45]'), 1);
    close(run('ASIN[0.5]'), 30);
    close(run('ACOS[0.5]'), 60);
    close(run('ATAN[1]/[1]'), 45);
    close(run('ATAN[1]/[-1]'), 135); // two-argument: quadrant-correct
  });

  it('uses radians when the dialect says so', () => {
    close(
      run('SIN[1]', EMPTY_PARAMETERS, { ...LINUXCNC_RULES, angleUnit: 'radians' }),
      Math.sin(1),
    );
  });

  it('rounds half away from zero, as LinuxCNC: ROUND[-2.5] = -3 (upstream: -2)', () => {
    expect(run('ROUND[2.5]')).toBe(3);
    expect(run('ROUND[-2.5]')).toBe(-3);
    expect(run('ROUND[-2.5]', EMPTY_PARAMETERS, { ...LINUXCNC_RULES, round: 'half-up' })).toBe(-2);
  });

  it('computes the rest', () => {
    expect(run('ABS[-3]')).toBe(3);
    expect(run('FIX[-2.5]')).toBe(-3);
    expect(run('FUP[-2.5]')).toBe(-2);
    close(run('LN[EXP[2]]'), 2);
    expect(run('SQRT[16]')).toBe(4);
  });

  it('EXISTS tests whether a named parameter is set', () => {
    const p = params({}, { depth: 1 });
    expect(run('EXISTS[#<depth>]', p)).toBe(1);
    expect(run('EXISTS[#<width>]', p)).toBe(0);
  });
});

describe('errors are diagnostics with spans, never exceptions', () => {
  it.each([
    ['[1/0]', 'EXPR_DIVIDE_BY_ZERO'],
    ['[1 MOD 0]', 'EXPR_DIVIDE_BY_ZERO'],
    ['SQRT[-1]', 'EXPR_DOMAIN'],
    ['LN[0]', 'EXPR_DOMAIN'],
    ['ASIN[2]', 'EXPR_DOMAIN'],
    ['#<nope>', 'EXPR_UNDEFINED_PARAMETER'],
    ['#1.5', 'EXPR_PARAMETER_NOT_INTEGER'],
    ['#0', 'EXPR_PARAMETER_OUT_OF_RANGE'],
    ['#5602', 'EXPR_PARAMETER_OUT_OF_RANGE'],
    ['[10 ** 400]', 'EXPR_NOT_FINITE'],
    ['FOO[1]', 'EXPR_UNKNOWN_FUNCTION'],
    ['[1+]', 'EXPR_EXPECTED_VALUE'],
    ['[1+2', 'EXPR_EXPECTED_CLOSE'],
    ['ATAN[1]', 'EXPR_ATAN_FORM'],
    ['EXISTS[#1]', 'EXPR_EXISTS_ARGUMENT'],
  ])('%s → %s', (src, code) => {
    expect(run(src)).toMatchObject({ codes: [code] });
  });

  it('points at the failing sub-expression', () => {
    const src = '[2 + [1/0]]';
    expect(run(src)).toMatchObject({ spans: [{ start: 5, end: 10 }] });
  });

  it('accepts #5601 and rejects #5602 (RS274NGC_MAX_PARAMETERS is an array size)', () => {
    expect(run('#5601')).toBe(0);
  });

  it('reads an undefined named parameter as 0 when the dialect says so', () => {
    expect(
      run('#<nope>', EMPTY_PARAMETERS, { ...LINUXCNC_RULES, undefinedNamedParameter: 'zero' }),
    ).toBe(0);
  });
});

describe('robustness (fixes R1)', () => {
  it("reports the inputs that overflowed upstream's stack, instead of recursing", () => {
    expect(run('[FOO]')).toMatchObject({ codes: ['EXPR_UNKNOWN_FUNCTION'] });
    expect(run('[1+]')).toMatchObject({ codes: ['EXPR_EXPECTED_VALUE'] });
    close(run('[SIN[0]+10]'), 10); // R1's own example now simply works
  });

  it('bounds nesting depth with a diagnostic', () => {
    const deep = '['.repeat(500) + '1' + ']'.repeat(500);
    expect(run(deep)).toMatchObject({ codes: ['EXPR_TOO_DEEP'] });
    expect(run('-'.repeat(500) + '1')).toMatchObject({ codes: ['EXPR_TOO_DEEP'] });
  });

  it('never throws on arbitrary input, and finishes quickly', () => {
    const unit = fc.constantFrom(...'[]#<>+-*/.0123456789 MODANDXORLTGEQSINCOSATAN'.split(''));
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 120 }), (src) => {
        const parsed = parseExpression(src, { start: 0, end: src.length }, 1, LINUXCNC_RULES);
        if (parsed.expr) evaluate(parsed.expr, EMPTY_PARAMETERS, LINUXCNC_RULES, 1);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('the interpreter on hostile expressions never throws (core: never throws)', () => {
  const run = (src: string) => interpret(parse(src));

  it('bounds "#" indirection like any nesting, with a diagnostic', () => {
    const r = run('X' + '#'.repeat(10_000) + '1');
    expect(r.diagnostics.map((d) => d.code)).toContain('EXPR_TOO_DEEP');
    expect(() => run('#'.repeat(10_001) + '1=2')).not.toThrow();
    // Ordinary indirection still works: #2 = 1, ##2 = #1 = 7.
    const ok = run('G21 G90\n#1=7\n#2=1\nG1 X##2 F100');
    expect(ok.steps.find((s) => s.kind === 'linear')).toMatchObject({ to: { X: 7 } });
  });

  it('evaluates a flat chain of any length, left to right', () => {
    const plus = run(`G21 G90\nG1 X[${'1+'.repeat(20_000)}1] F100`);
    expect(plus.steps.find((s) => s.kind === 'linear')).toMatchObject({ to: { X: 20_001 } });
    // Left-associative: 10-10-…-1 (20,000 terms) = 10 - 10×19,999 - 1.
    const minus = run(`G21 G90\nG1 X[${'10-'.repeat(20_000)}1] F100`);
    expect(minus.steps.find((s) => s.kind === 'linear')).toMatchObject({ to: { X: -199_981 } });
  });

  it('property: no expression shape makes it throw', () => {
    const piece = fc.constantFrom(
      '#',
      '[',
      ']',
      '1',
      '+',
      '-',
      '*',
      '/',
      '**',
      'SIN',
      ' MOD ',
      ' GT ',
      '<a>',
      '.',
    );
    fc.assert(
      fc.property(
        fc.array(piece, { maxLength: 300 }),
        fc.integer({ min: 0, max: 3000 }),
        (parts, n) => {
          const expr = parts.join('') + '1+'.repeat(n) + '1';
          expect(() => run(`G21 G90\nG1 X[${expr}] F100\n#1=${expr}`)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});
