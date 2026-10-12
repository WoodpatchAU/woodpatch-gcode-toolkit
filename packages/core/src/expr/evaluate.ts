// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Diagnostic, Span } from '../syntax/types.js';
import type { Expr, ParameterRef } from './parse.js';
import type { ExpressionRules } from './rules.js';

/**
 * Read access to the parameter store. The interpreter (parcel 2c) owns the store,
 * including subroutine-local scopes and the rule that assignments take effect
 * after the line. Evaluation only reads.
 */
export interface ParameterReader {
  /** Value of numbered parameter `index`; unset numbered parameters are 0 in RS274. */
  numbered(index: number): number;
  /** Value of named parameter `name` (lower-cased), or undefined if never set. */
  named(name: string): number | undefined;
}

/** A store with no parameters set: numbered read as 0, named are undefined. */
export const EMPTY_PARAMETERS: ParameterReader = Object.freeze({
  numbered: () => 0,
  named: () => undefined,
});

/**
 * Evaluates an expression. Never throws: every failure (division by zero, a
 * domain error, an undefined parameter, a non-finite result) is an error
 * diagnostic pointing at the sub-expression responsible, and the value is null.
 * Domain checks follow LinuxCNC's interpreter.
 */
export function evaluate(
  expr: Expr,
  params: ParameterReader,
  rules: ExpressionRules,
  line: number,
): { value: number | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const fail = (code: string, message: string, span: Span): null => {
    diagnostics.push({ severity: 'error', code, message, line, span });
    return null;
  };
  const toRad = rules.angleUnit === 'degrees' ? Math.PI / 180 : 1;
  const tol = rules.equalityTolerance;

  const readParameter = (ref: ParameterRef, span: Span): number | null => {
    if (ref.by === 'name') {
      const v = params.named(ref.name);
      if (v !== undefined) return v;
      if (rules.undefinedNamedParameter === 'zero') return 0;
      return fail(
        'EXPR_UNDEFINED_PARAMETER',
        `Named parameter #<${ref.name}> is not defined`,
        span,
      );
    }
    const raw = ev(ref.index);
    if (raw === null) return null;
    const index = Math.round(raw);
    if (Math.abs(raw - index) > tol) {
      return fail('EXPR_PARAMETER_NOT_INTEGER', `Parameter number ${raw} is not an integer`, span);
    }
    if (index < 1 || index > rules.maxParameter) {
      return fail(
        'EXPR_PARAMETER_OUT_OF_RANGE',
        `Parameter number ${index} is outside 1-${rules.maxParameter}`,
        span,
      );
    }
    return params.numbered(index);
  };

  const ev = (e: Expr): number | null => {
    switch (e.kind) {
      case 'number':
        return e.value;
      case 'parameter':
        return readParameter(e.ref, e.span);
      case 'unary': {
        const v = ev(e.arg);
        return v === null ? null : e.op === '-' ? -v : v;
      }
      case 'binary': {
        // A flat chain (1+1+1+…, any length) is a left-leaning tree as deep as it is
        // long: walk its left spine in a loop, so it can't overflow the stack. A right
        // operand is a higher-precedence term, bounded by the levels and by maxDepth.
        const spine: Extract<Expr, { kind: 'binary' }>[] = [];
        let left: Expr = e;
        while (left.kind === 'binary') {
          spine.push(left);
          left = left.left;
        }
        let acc = ev(left);
        for (let i = spine.length - 1; i >= 0 && acc !== null; i--) {
          const node = spine[i] as Extract<Expr, { kind: 'binary' }>;
          const r = ev(node.right);
          if (r === null) return null;
          acc = binary(node.op, acc, r, node.span);
        }
        return acc;
      }
      case 'call':
        return call(e);
    }
  };

  const binary = (op: string, l: number, r: number, span: Span): number | null => {
    const truth = (b: boolean) => (b ? 1 : 0);
    const diff = Math.abs(l - r);
    switch (op) {
      case '**':
        return l ** r;
      case '*':
        return l * r;
      case '/':
        return r === 0 ? fail('EXPR_DIVIDE_BY_ZERO', 'Division by zero', span) : l / r;
      case 'MOD': {
        if (r === 0) return fail('EXPR_DIVIDE_BY_ZERO', 'MOD by zero', span);
        const m = l % r;
        return rules.mod === 'positive' && m < 0 ? m + Math.abs(r) : m;
      }
      case '+':
        return l + r;
      case '-':
        return l - r;
      case 'EQ':
        return truth(tol > 0 ? diff < tol : l === r);
      case 'NE':
        return truth(tol > 0 ? diff >= tol : l !== r);
      // GT and LT are PLAIN comparisons in LinuxCNC (execute_binary2, interp_execute.cc:156/175);
      // only EQ, NE, GE and LE use the tolerance. So within the tolerance band, EQ and GT
      // can both be 1. That's odd, but faithful (ADR-0018).
      case 'GT':
        return truth(l > r);
      case 'GE':
        return truth(l >= r || (tol > 0 && diff < tol));
      case 'LT':
        return truth(l < r);
      case 'LE':
        return truth(l <= r || (tol > 0 && diff < tol));
      case 'AND':
        return truth(l !== 0 && r !== 0);
      case 'OR':
        return truth(l !== 0 || r !== 0);
      case 'XOR':
        return truth((l !== 0) !== (r !== 0));
    }
    return fail('EXPR_UNKNOWN_OPERATOR', `Unknown operator ${op}`, span);
  };

  const call = (e: Extract<Expr, { kind: 'call' }>): number | null => {
    if (e.fn === 'EXISTS') {
      const arg = e.arg;
      if (arg.kind !== 'parameter' || arg.ref.by !== 'name') {
        return fail(
          'EXPR_EXISTS_ARGUMENT',
          'EXISTS takes a named parameter, e.g. EXISTS[#<depth>]',
          e.span,
        );
      }
      return params.named(arg.ref.name) === undefined ? 0 : 1;
    }
    const x = ev(e.arg);
    if (x === null) return null;
    switch (e.fn) {
      case 'ABS':
        return Math.abs(x);
      case 'ACOS':
        return x < -1 || x > 1
          ? fail('EXPR_DOMAIN', `ACOS of ${x} is outside -1 to 1`, e.span)
          : Math.acos(x) / toRad;
      case 'ASIN':
        return x < -1 || x > 1
          ? fail('EXPR_DOMAIN', `ASIN of ${x} is outside -1 to 1`, e.span)
          : Math.asin(x) / toRad;
      case 'ATAN': {
        if (!e.divisor) return fail('EXPR_ATAN_FORM', 'ATAN must be written ATAN[y]/[x]', e.span);
        const d = ev(e.divisor);
        return d === null ? null : Math.atan2(x, d) / toRad;
      }
      case 'COS':
        return Math.cos(x * toRad);
      case 'EXP':
        return Math.exp(x);
      case 'FIX':
        return Math.floor(x);
      case 'FUP':
        return Math.ceil(x);
      case 'LN':
        return x <= 0
          ? fail('EXPR_DOMAIN', `LN of ${x}: the argument must be positive`, e.span)
          : Math.log(x);
      case 'ROUND':
        return rules.round === 'half-away' ? Math.sign(x) * Math.round(Math.abs(x)) : Math.round(x);
      case 'SIN':
        return Math.sin(x * toRad);
      case 'SQRT':
        return x < 0
          ? fail('EXPR_DOMAIN', `SQRT of ${x}: the argument is negative`, e.span)
          : Math.sqrt(x);
      case 'TAN':
        return Math.tan(x * toRad);
    }
    return null;
  };

  const value = ev(expr);
  if (value !== null && !Number.isFinite(value)) {
    fail('EXPR_NOT_FINITE', `The result is ${value}`, expr.span);
    return { value: null, diagnostics };
  }
  return { value, diagnostics };
}
