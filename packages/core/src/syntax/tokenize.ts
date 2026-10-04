// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type {
  Diagnostic,
  ExpressionValue,
  NumberValue,
  Severity,
  Span,
  Token,
  Value,
} from './types.js';

/**
 * Tokenizes one line of G-code (without its line ending).
 *
 * Contract:
 * - **Never throws**, whatever the input. Every problem is a {@link Diagnostic} with a span.
 * - **Never loses the words around a problem.** A bad character is reported and
 *   skipped, and the rest of the line is still tokenized. An unterminated `(`
 *   comment runs to the end of the line, and the words before it are kept.
 *   Upstream failed the whole line instead (R7).
 * - Tokens are returned in source order and never overlap.
 * - Letter-agnostic: `E`, `A`, `D` and so on are all words here. Whether a letter
 *   means anything is for the dialect and the interpreter.
 *
 * Whitespace (space, tab) is insignificant outside comments, as in RS274/NGC. That
 * includes whitespace INSIDE a number (`X1 0` is `X10`); this is legal but rare
 * enough to deserve an info diagnostic.
 */
export function tokenizeLine(
  text: string,
  lineNo: number,
): { tokens: Token[]; diagnostics: Diagnostic[] } {
  return new LineScanner(text, lineNo).run();
}

/** Unary functions allowed as a word value or inside expressions (RS274/NGC, LinuxCNC). */
const FUNCTIONS = [
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
];

/** The longest function name: a run of letters longer than this can't be one. */
const LONGEST_FUNCTION = Math.max(...FUNCTIONS.map((f) => f.length));

/** LinuxCNC O-word control keywords. Anything else after an O label is not a keyword. */
const OWORD_KEYWORDS = new Set([
  'sub',
  'endsub',
  'call',
  'return',
  'if',
  'elseif',
  'else',
  'endif',
  'while',
  'endwhile',
  'do',
  'repeat',
  'endrepeat',
  'break',
  'continue',
]);

const SPACE = 0x20;
const TAB = 0x09;

const isWs = (c: number) => c === SPACE || c === TAB;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isLetter = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

class LineScanner {
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private i = 0;
  private afterOWord = false;
  /** How many tokens message() has checked, and whether all were a block delete or N. */
  private prefixScanned = 0;
  private prefixOnlyN = true;

  constructor(
    private readonly text: string,
    private readonly lineNo: number,
  ) {}

  run(): { tokens: Token[]; diagnostics: Diagnostic[] } {
    const { text } = this;
    let first = true;
    while (this.skipWs() < text.length) {
      const start = this.i;
      const c = text.charCodeAt(start);

      if (first && c === 0x25 /* % */) {
        this.percent();
        break;
      }
      if (first && c === 0x2f /* / */) {
        this.tokens.push({ kind: 'block-delete', span: { start, end: start + 1 } });
        this.i++;
        first = false;
        continue;
      }
      first = false;

      if (c === 0x28 /* ( */) this.parenComment();
      else if (c === 0x3b /* ; */) this.semicolonComment();
      else if (c === 0x23 /* # */) this.assignment();
      else if (c === 0x2a /* * */) this.checksum();
      else if (c === 0x5b /* [ */) this.bracketOutsideWord();
      else if (isLetter(c)) {
        if ((c | 0x20) === 0x6d /* m */ && this.message()) break;
        if ((c | 0x20) === 0x6f /* o */) this.oword();
        else this.word();
      } else {
        // Step by code point, so an astral character (e.g. an emoji) is one
        // diagnostic, not two lone surrogate halves.
        const cp = text.codePointAt(start) ?? c;
        const width = cp > 0xffff ? 2 : 1;
        this.report(
          'error',
          'SYNTAX_UNEXPECTED_CHARACTER',
          `Unexpected character "${String.fromCodePoint(cp)}"`,
          { start, end: start + width },
        );
        this.i += width;
      }
    }
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  // ── Statements ─────────────────────────────────────────────────────────

  /**
   * A Masso message line: MSG, MSG_S, MSG_W or MSG_SW followed by a space or the end
   * of the line, at the start of the line or after its N word (Masso docs, "MSG").
   * The rest of the line is the message. Returns false, consuming nothing, otherwise.
   */
  private message(): boolean {
    // Only new tokens are checked: re-walking them all on every M word made a line of
    // many M words quadratic (a 40k-letter line took seconds).
    for (; this.prefixOnlyN && this.prefixScanned < this.tokens.length; this.prefixScanned++) {
      const t = this.tokens[this.prefixScanned] as Token;
      if (t.kind !== 'block-delete' && !(t.kind === 'word' && t.letter === 'N'))
        this.prefixOnlyN = false;
    }
    if (!this.prefixOnlyN) return false;
    const m = /^msg(_sw|_s|_w)?(?=[ \t]|$)/i.exec(this.text.slice(this.i, this.i + 7));
    if (!m) return false;
    const start = this.i;
    const suffix = (m[1] ?? '').toLowerCase();
    let j = start + m[0].length;
    while (j < this.text.length && isWs(this.text.charCodeAt(j))) j++;
    this.tokens.push({
      kind: 'message',
      span: { start, end: this.text.length },
      target: suffix === '_w' ? 'workshop' : suffix === '_sw' ? 'both' : 'screen',
      text: this.text.slice(j),
    });
    this.i = this.text.length;
    return true;
  }

  private percent(): void {
    const start = this.i;
    const end = this.text.length;
    this.tokens.push({ kind: 'percent', span: { start, end } });
    if (this.text.slice(start + 1).trim() !== '') {
      this.report(
        'warning',
        'SYNTAX_PERCENT_TRAILING',
        'Text after a "%" program delimiter is ignored',
        { start: start + 1, end },
      );
    }
    this.i = end;
  }

  private parenComment(): void {
    const start = this.i;
    const close = this.text.indexOf(')', start + 1);
    if (close === -1) {
      const end = this.text.length;
      this.tokens.push({
        kind: 'comment',
        span: { start, end },
        style: 'paren',
        text: this.text.slice(start + 1),
        terminated: false,
      });
      this.report(
        'error',
        'SYNTAX_UNTERMINATED_COMMENT',
        'Comment "(" is never closed; the rest of the line is treated as a comment',
        { start, end },
      );
      this.i = end;
      return;
    }
    this.tokens.push({
      kind: 'comment',
      span: { start, end: close + 1 },
      style: 'paren',
      text: this.text.slice(start + 1, close),
      terminated: true,
    });
    this.i = close + 1;
  }

  private semicolonComment(): void {
    const start = this.i;
    const end = this.text.length;
    this.tokens.push({
      kind: 'comment',
      span: { start, end },
      style: 'semicolon',
      text: this.text.slice(start + 1),
      terminated: true,
    });
    this.i = end;
  }

  private assignment(): void {
    const start = this.i;
    const target = this.parameterRef();
    if (!target) return; // parameterRef reported it
    this.skipWs();
    if (this.text.charCodeAt(this.i) !== 0x3d /* = */) {
      this.report(
        'error',
        'SYNTAX_PARAMETER_WITHOUT_ASSIGNMENT',
        'A parameter reference on its own is not a statement; expected "=" and a value',
        target,
      );
      return;
    }
    this.i++;
    const value = this.value();
    if (!value) {
      this.report('error', 'SYNTAX_MISSING_VALUE', 'Parameter assignment has no value', {
        start,
        end: this.i,
      });
    }
    this.tokens.push({
      kind: 'assignment',
      span: { start, end: value ? value.span.end : this.i },
      target,
      value,
    });
  }

  private checksum(): void {
    const start = this.i;
    let j = start + 1;
    while (j < this.text.length && isDigit(this.text.charCodeAt(j))) j++;
    if (j === start + 1) {
      this.report('error', 'SYNTAX_UNEXPECTED_CHARACTER', 'Unexpected character "*"', {
        start,
        end: start + 1,
      });
      this.i++;
      return;
    }
    this.tokens.push({
      kind: 'checksum',
      span: { start, end: j },
      value: Number(this.text.slice(start + 1, j)),
    });
    this.i = j;
  }

  private bracketOutsideWord(): void {
    const start = this.i;
    const end = this.balancedBracket(start);
    const value: ExpressionValue = { kind: 'expression', span: { start, end } };
    if (this.afterOWord) {
      this.tokens.push({ kind: 'argument', span: { start, end }, value });
    } else {
      this.report(
        'error',
        'SYNTAX_UNEXPECTED_EXPRESSION',
        'An expression must be the value of a word (e.g. X[1+2]) or follow an O-word',
        { start, end },
      );
    }
    this.i = end;
  }

  private oword(): void {
    const start = this.i;
    this.i++; // the O
    this.skipWs();
    const labelStart = this.i;
    const c = this.text.charCodeAt(labelStart);
    if (c === 0x3c /* < */) {
      const close = this.text.indexOf('>', labelStart + 1);
      if (close === -1) {
        this.report('error', 'SYNTAX_UNTERMINATED_NAME', 'O-word name "<" is never closed', {
          start: labelStart,
          end: this.text.length,
        });
        this.i = this.text.length;
        return;
      }
      this.i = close + 1;
    } else if (isDigit(c)) {
      while (this.i < this.text.length && isDigit(this.text.charCodeAt(this.i))) this.i++;
    } else {
      this.report('error', 'SYNTAX_MISSING_VALUE', 'O-word has no number or <name>', {
        start,
        end: this.i,
      });
      return;
    }
    const label = { start: labelStart, end: this.i };

    // Optional keyword: a run of letters that is a known O-word keyword.
    const save = this.i;
    this.skipWs();
    const kwStart = this.i;
    while (this.i < this.text.length && isLetter(this.text.charCodeAt(this.i))) this.i++;
    const kw = this.text.slice(kwStart, this.i).toLowerCase();
    let keyword: string | null = null;
    if (OWORD_KEYWORDS.has(kw)) keyword = kw;
    else this.i = save; // not a keyword: leave the letters to be read as words

    this.tokens.push({
      kind: 'oword',
      span: { start, end: keyword ? this.i : label.end },
      label,
      keyword,
    });
    this.afterOWord = true;
  }

  private word(): void {
    const start = this.i;
    const letter = this.text.charAt(start).toUpperCase();
    this.i++;
    const value = this.value();
    if (!value) {
      this.report('error', 'SYNTAX_MISSING_VALUE', `"${letter}" has no value`, {
        start,
        end: start + 1,
      });
    }
    this.tokens.push({
      kind: 'word',
      span: { start, end: value ? value.span.end : start + 1 },
      letter,
      value,
    });
  }

  // ── Values ─────────────────────────────────────────────────────────────

  /** A number, bracketed expression, parameter reference or unary function call. */
  private value(): Value | null {
    this.skipWs();
    const start = this.i;
    // Signs before a parameter, bracket or function (X-#1, X-[#2*2], X+SIN[30], X--#1):
    // LinuxCNC's read_real_value negates the value that follows. A sign before digits
    // is a number's own. Read as a loop, not recursion, so a line of ten thousand signs
    // can't overflow the stack (the tokenizer never throws).
    let j = start;
    for (;;) {
      const c = this.text.charCodeAt(j);
      if (c !== 0x2b /* + */ && c !== 0x2d /* - */) break;
      let k = j + 1;
      while (k < this.text.length && isWs(this.text.charCodeAt(k))) k++;
      const next = this.text.charCodeAt(k);
      if (next === 0x5b || next === 0x23 || isLetter(next) || next === 0x2b || next === 0x2d) {
        j = k;
        continue;
      }
      break;
    }
    if (j > start) {
      this.i = j;
      const inner = this.unsignedValue();
      if (inner) return { kind: 'expression', span: { start, end: inner.span.end } };
      this.i = start;
      return null;
    }
    return this.unsignedValue();
  }

  /** value() after any leading signs: a number (with its own sign), bracket, ref or function. */
  private unsignedValue(): Value | null {
    const start = this.i;
    const c = this.text.charCodeAt(start);
    if (c === 0x5b /* [ */) {
      const end = this.balancedBracket(start);
      this.i = end;
      return { kind: 'expression', span: { start, end } };
    }
    if (c === 0x23 /* # */) {
      const span = this.parameterRef();
      return span ? { kind: 'expression', span } : null;
    }
    if (isLetter(c)) return this.functionCall();
    return this.number();
  }

  /** `SIN[…]`, `ATAN[…]/[…]` and so on. Returns null (consuming nothing) if not a function. */
  private functionCall(): ExpressionValue | null {
    const start = this.i;
    let j = start;
    // At most one letter more than the longest name: scanning every following letter
    // for each word made a line of letters quadratic.
    while (
      j < this.text.length &&
      j - start <= LONGEST_FUNCTION &&
      isLetter(this.text.charCodeAt(j))
    )
      j++;
    const name = this.text.slice(start, j).toUpperCase();
    if (!FUNCTIONS.includes(name)) return null;
    let k = j;
    while (k < this.text.length && isWs(this.text.charCodeAt(k))) k++;
    if (this.text.charCodeAt(k) !== 0x5b /* [ */) return null;
    let end = this.balancedBracket(k);
    if (name === 'ATAN') {
      // ATAN[y]/[x]: the divisor is part of the call.
      let m = end;
      while (m < this.text.length && isWs(this.text.charCodeAt(m))) m++;
      if (this.text.charCodeAt(m) === 0x2f /* / */) {
        m++;
        while (m < this.text.length && isWs(this.text.charCodeAt(m))) m++;
        if (this.text.charCodeAt(m) === 0x5b) end = this.balancedBracket(m);
      }
    }
    this.i = end;
    return { kind: 'expression', span: { start, end } };
  }

  /**
   * `[+-]? digits [. digits?] | [+-]? . digits`, with whitespace tolerated anywhere
   * inside (RS274/NGC). Returns null, consuming nothing, if there are no digits.
   */
  private number(): NumberValue | null {
    const { text } = this;
    const start = this.i;
    let j = start;
    let chars = '';
    let digits = 0;
    let sawDot = false;
    let spaceInside = false;
    let end = start;

    const c0 = text.charCodeAt(j);
    const signed = c0 === 0x2b /* + */ || c0 === 0x2d; /* - */
    if (signed) {
      chars += text.charAt(j);
      j++;
      end = j;
    }
    for (;;) {
      let k = j;
      while (k < text.length && isWs(text.charCodeAt(k))) k++;
      const c = text.charCodeAt(k);
      const accept = isDigit(c) || (c === 0x2e /* . */ && !sawDot);
      if (!accept) break;
      // A space after a sign counts too: `X+ 2` reads as X2.
      if (k !== j && (digits > 0 || sawDot || signed)) spaceInside = true;
      if (c === 0x2e) sawDot = true;
      else digits++;
      chars += text[k];
      j = k + 1;
      end = j;
    }
    if (digits === 0) return null;

    this.i = end;
    const span = { start, end };
    if (spaceInside) {
      this.report(
        'info',
        'SYNTAX_SPACE_IN_NUMBER',
        `Spaces inside a number are ignored: read as ${chars}`,
        span,
      );
    }
    // X1e3 reads as X1 then a separate E3 word, which is rarely what was meant (R6).
    const e = text.charCodeAt(end) | 0x20;
    const n1 = text.charCodeAt(end + 1);
    const n2 = text.charCodeAt(end + 2);
    if (e === 0x65 && (isDigit(n1) || ((n1 === 0x2b || n1 === 0x2d) && isDigit(n2)))) {
      this.report(
        'warning',
        'SYNTAX_POSSIBLE_EXPONENT',
        `"${text.slice(start, end + 2)}…" is read as a number followed by an E word; G-code has no exponent notation`,
        { start, end: end + 1 },
      );
    }
    return { kind: 'number', span, value: Number(chars) };
  }

  /** `#123`, `#<name>`, `#[expr]`, `##2`. Reports and returns null if malformed. */
  private parameterRef(): Span | null {
    const { text } = this;
    const start = this.i;
    // `##2` (and deeper): a run of "#", read as a loop, not recursion, so a long run
    // can't overflow the stack.
    let c: number;
    do {
      this.i++; // #
      this.skipWs();
      c = text.charCodeAt(this.i);
    } while (c === 0x23 /* # */);
    if (c === 0x3c /* < */) {
      const close = text.indexOf('>', this.i + 1);
      if (close === -1) {
        this.report('error', 'SYNTAX_UNTERMINATED_NAME', 'Parameter name "<" is never closed', {
          start,
          end: text.length,
        });
        this.i = text.length;
        return null;
      }
      this.i = close + 1;
      return { start, end: this.i };
    }
    if (c === 0x5b /* [ */) {
      this.i = this.balancedBracket(this.i);
      return { start, end: this.i };
    }
    if (isDigit(c)) {
      while (this.i < text.length && isDigit(text.charCodeAt(this.i))) this.i++;
      return { start, end: this.i };
    }
    this.report(
      'error',
      'SYNTAX_MISSING_VALUE',
      '"#" is not followed by a parameter number or name',
      {
        start,
        end: this.i,
      },
    );
    return null;
  }

  /** Index just past the `]` matching the `[` at `open`; reports and runs to end of line if unbalanced. */
  private balancedBracket(open: number): number {
    const { text } = this;
    let depth = 0;
    for (let j = open; j < text.length; j++) {
      const c = text.charCodeAt(j);
      if (c === 0x5b) depth++;
      else if (c === 0x5d && --depth === 0) return j + 1;
    }
    this.report('error', 'SYNTAX_UNBALANCED_BRACKET', '"[" is never closed', {
      start: open,
      end: text.length,
    });
    return text.length;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private skipWs(): number {
    while (this.i < this.text.length && isWs(this.text.charCodeAt(this.i))) this.i++;
    return this.i;
  }

  private report(severity: Severity, code: string, message: string, span: Span): void {
    this.diagnostics.push({ severity, code, message, line: this.lineNo, span });
  }
}
