// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Diagnostic, Span } from '../syntax/types.js';
import type { BinaryOperator, ExpressionRules } from './rules.js';

/**
 * Expression syntax tree. Every node keeps its span (offsets in the LINE's text),
 * so an evaluation error can point at the exact sub-expression.
 */
export type Expr =
  | { readonly kind: 'number'; readonly span: Span; readonly value: number }
  | { readonly kind: 'parameter'; readonly span: Span; readonly ref: ParameterRef }
  | { readonly kind: 'unary'; readonly span: Span; readonly op: '+' | '-'; readonly arg: Expr }
  | {
      readonly kind: 'call';
      readonly span: Span;
      readonly fn: FunctionName;
      readonly arg: Expr;
      /** Only for ATAN[y]/[x]: the x. */
      readonly divisor?: Expr;
    }
  | {
      readonly kind: 'binary';
      readonly span: Span;
      readonly op: BinaryOperator;
      readonly left: Expr;
      readonly right: Expr;
    };

/** `#123` (index), `#<name>` (name, lower-cased), or `#[expr]` / `##2` (computed index). */
export type ParameterRef =
  { readonly by: 'name'; readonly name: string } | { readonly by: 'index'; readonly index: Expr };

export type FunctionName =
  | 'ABS'
  | 'ACOS'
  | 'ASIN'
  | 'ATAN'
  | 'COS'
  | 'EXISTS'
  | 'EXP'
  | 'FIX'
  | 'FUP'
  | 'LN'
  | 'ROUND'
  | 'SIN'
  | 'SQRT'
  | 'TAN';

const FUNCTIONS = new Set<string>([
  'ABS',
  'ACOS',
  'ASIN',
  'ATAN',
  'COS',
  'EXISTS',
  'EXP',
  'FIX',
  'FUP',
  'LN',
  'ROUND',
  'SIN',
  'SQRT',
  'TAN',
]);

/** Word operators, longest first so e.g. `MOD` is not read as something shorter. */
const WORD_OPERATORS: readonly BinaryOperator[] = [
  'MOD',
  'AND',
  'XOR',
  'EQ',
  'NE',
  'GT',
  'GE',
  'LT',
  'LE',
  'OR',
];

/**
 * Parses the value source in `span` of `text` (a word's value, an assignment's
 * right-hand side, or an O-word argument): a number, `[expr]`, a parameter
 * reference, or a function call, optionally signed.
 *
 * Never throws and never recurses without bound: nesting deeper than
 * `rules.maxDepth` is a diagnostic. Upstream overflowed the stack on any
 * malformed expression, and on the live page that hung the simulator (R1).
 */
export function parseExpression(
  text: string,
  span: Span,
  line: number,
  rules: ExpressionRules,
): { expr: Expr | null; diagnostics: Diagnostic[] } {
  const p = new ExprParser(text, span, line, rules);
  const expr = p.value(0);
  if (expr && p.skipWs() < span.end) {
    p.error('EXPR_TRAILING_TEXT', 'Unexpected text after the value', {
      start: p.pos,
      end: span.end,
    });
  }
  return { expr: p.failed ? null : expr, diagnostics: p.diagnostics };
}

class ExprParser {
  readonly diagnostics: Diagnostic[] = [];
  failed = false;
  pos: number;
  private readonly end: number;
  private readonly levels: readonly (readonly BinaryOperator[])[];

  constructor(
    private readonly text: string,
    span: Span,
    private readonly line: number,
    private readonly rules: ExpressionRules,
  ) {
    this.pos = span.start;
    this.end = span.end;
    this.levels = rules.precedence;
  }

  /** real_value: [+-] ( number | [expr] | #param | FUNC[..] ). */
  value(depth: number): Expr | null {
    if (depth > this.rules.maxDepth) {
      this.error('EXPR_TOO_DEEP', `Expression nested more than ${this.rules.maxDepth} deep`, {
        start: this.pos,
        end: this.end,
      });
      this.pos = this.end;
      return null;
    }
    this.skipWs();
    const start = this.pos;
    const c = this.text[this.pos];

    // A sign directly before digits is part of the number; otherwise it is unary.
    if ((c === '+' || c === '-') && !this.isNumberStart(this.pos + 1)) {
      this.pos++;
      const arg = this.value(depth + 1);
      return arg ? { kind: 'unary', span: { start, end: arg.span.end }, op: c, arg } : null;
    }
    if (c === '[') return this.bracketed(depth);
    if (c === '#') return this.parameter(depth);
    if (c !== undefined && /[A-Za-z]/.test(c)) return this.call(depth);
    return this.number();
  }

  private bracketed(depth: number): Expr | null {
    const open = this.pos;
    this.pos++; // [
    const inner = this.binary(this.levels.length - 1, depth + 1);
    if (!inner) return null;
    this.skipWs();
    if (this.text[this.pos] !== ']') {
      this.error('EXPR_EXPECTED_CLOSE', 'Expected "]"', { start: open, end: this.pos });
      return null;
    }
    this.pos++;
    // The brackets are part of the span, so errors can point at the whole group.
    return { ...inner, span: { start: open, end: this.pos } };
  }

  /** Precedence climbing over the dialect's levels, left-associative. */
  private binary(level: number, depth: number): Expr | null {
    if (level < 0) return this.value(depth);
    let left = this.binary(level - 1, depth);
    if (!left) return null;
    for (;;) {
      const ops = this.levels[level];
      if (!ops) return left;
      const op = this.peekOperator(ops);
      if (!op) return left;
      this.pos += op.length;
      const right = this.binary(level - 1, depth);
      if (!right) return null;
      left = {
        kind: 'binary',
        span: { start: left.span.start, end: right.span.end },
        op,
        left,
        right,
      };
    }
  }

  private peekOperator(allowed: readonly BinaryOperator[]): BinaryOperator | null {
    this.skipWs();
    const rest = this.text.slice(this.pos, Math.min(this.end, this.pos + 3)).toUpperCase();
    // '**' must win over '*'.
    for (const sym of ['**', '*', '/', '+', '-'] as const) {
      if (rest.startsWith(sym)) return allowed.includes(sym) ? sym : null;
    }
    for (const w of WORD_OPERATORS) {
      if (rest.startsWith(w)) return allowed.includes(w) ? w : null;
    }
    return null;
  }

  private parameter(depth: number): Expr | null {
    // ##…# is indirection, one level per "#": bounded like any nesting (a run of ten
    // thousand overflowed the stack, and the core never throws).
    if (depth > this.rules.maxDepth) {
      this.error('EXPR_TOO_DEEP', `Expression nested more than ${this.rules.maxDepth} deep`, {
        start: this.pos,
        end: this.end,
      });
      this.pos = this.end;
      return null;
    }
    const start = this.pos;
    this.pos++; // #
    this.skipWs();
    const c = this.text[this.pos];
    if (c === '<') {
      const close = this.text.indexOf('>', this.pos);
      if (close === -1 || close >= this.end) {
        this.error('EXPR_UNTERMINATED_NAME', 'Parameter name "<" is never closed', {
          start,
          end: this.end,
        });
        return null;
      }
      const name = this.text
        .slice(this.pos + 1, close)
        .replace(/[ \t]/g, '')
        .toLowerCase();
      this.pos = close + 1;
      return { kind: 'parameter', span: { start, end: this.pos }, ref: { by: 'name', name } };
    }
    // #123, #[expr] or ##2: the index is itself a value.
    const index =
      c === '#' ? this.parameter(depth + 1) : c === '[' ? this.bracketed(depth + 1) : this.number();
    if (!index) {
      if (!this.failed)
        this.error(
          'EXPR_BAD_PARAMETER',
          '"#" must be followed by a number, <name> or [expression]',
          { start, end: this.pos + 1 },
        );
      return null;
    }
    return { kind: 'parameter', span: { start, end: index.span.end }, ref: { by: 'index', index } };
  }

  private call(depth: number): Expr | null {
    const start = this.pos;
    let j = this.pos;
    while (j < this.end && /[A-Za-z]/.test(this.text.charAt(j))) j++;
    const name = this.text.slice(start, j).toUpperCase();
    if (!FUNCTIONS.has(name)) {
      this.error('EXPR_UNKNOWN_FUNCTION', `Unknown function "${name}"`, { start, end: j });
      return null;
    }
    this.pos = j;
    this.skipWs();
    if (this.text[this.pos] !== '[') {
      this.error('EXPR_EXPECTED_OPEN', `Expected "[" after ${name}`, { start, end: this.pos });
      return null;
    }
    const arg = this.bracketed(depth + 1);
    if (!arg) return null;
    if (name !== 'ATAN') {
      return { kind: 'call', span: { start, end: this.pos }, fn: name as FunctionName, arg };
    }
    // ATAN[y]/[x] is a two-argument call, not a division.
    this.skipWs();
    if (this.text[this.pos] !== '/') {
      this.error('EXPR_ATAN_FORM', 'ATAN must be written ATAN[y]/[x]', { start, end: this.pos });
      return null;
    }
    this.pos++;
    this.skipWs();
    if (this.text[this.pos] !== '[') {
      this.error('EXPR_ATAN_FORM', 'ATAN must be written ATAN[y]/[x]', { start, end: this.pos });
      return null;
    }
    const divisor = this.bracketed(depth + 1);
    if (!divisor) return null;
    return { kind: 'call', span: { start, end: this.pos }, fn: 'ATAN', arg, divisor };
  }

  private number(): Expr | null {
    const start = this.pos;
    let j = this.pos;
    let chars = '';
    const sign = this.text[j];
    if (sign === '+' || sign === '-') {
      chars += sign;
      j++;
    }
    let digits = 0;
    let dot = false;
    for (;;) {
      while (j < this.end && (this.text[j] === ' ' || this.text[j] === '\t')) j++;
      const c = this.text[j];
      if (c !== undefined && j < this.end && c >= '0' && c <= '9') digits++;
      else if (c === '.' && !dot && j < this.end) dot = true;
      else break;
      chars += c;
      j++;
    }
    if (digits === 0) {
      this.error('EXPR_EXPECTED_VALUE', 'Expected a number, [expression], parameter or function', {
        start,
        end: Math.min(this.end, start + 1),
      });
      return null;
    }
    this.pos = j;
    return { kind: 'number', span: { start, end: j }, value: Number(chars) };
  }

  private isNumberStart(i: number): boolean {
    let j = i;
    while (j < this.end && (this.text[j] === ' ' || this.text[j] === '\t')) j++;
    const c = this.text[j];
    return c !== undefined && j < this.end && ((c >= '0' && c <= '9') || c === '.');
  }

  skipWs(): number {
    while (this.pos < this.end && (this.text[this.pos] === ' ' || this.text[this.pos] === '\t'))
      this.pos++;
    return this.pos;
  }

  error(code: string, message: string, span: Span): void {
    this.failed = true;
    this.diagnostics.push({ severity: 'error', code, message, line: this.line, span });
  }
}
