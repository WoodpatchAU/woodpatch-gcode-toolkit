// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * A strict JSON parser for untrusted records (ADR-0041).
 *
 * `JSON.parse` is not enough, for three reasons:
 * - it silently keeps the LAST of two equal keys, so two parties can read different
 *   records from one text. This parser refuses any object with a repeated key,
 *   comparing keys after their escapes are decoded (`"a"` and `"\u0061"` are equal);
 * - with a plain object, `obj["__proto__"] = v` sets the prototype instead of an own
 *   key. Every object here has a null prototype, so `__proto__` is an ordinary key;
 * - it accepts lone surrogates (`"\ud800"`), which have no UTF-8 form, so the record
 *   would have no canonical form to hash. They're refused here.
 *
 * It also refuses numbers that overflow to infinity and nesting deeper than
 * {@link MAX_DEPTH}, so no input can exhaust the stack. Errors are values, never
 * exceptions: a record is data to report on, not a reason to crash.
 */

/** Deep enough for any machine record; shallow enough that recursion is safe. */
export const MAX_DEPTH = 32;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
/** A null-prototype object: read it with `Object.hasOwn` only. */
export type JsonObject = { [key: string]: JsonValue };

export type JsonErrorCode =
  | 'JSON_SYNTAX'
  | 'JSON_DUPLICATE_KEY'
  | 'JSON_LONE_SURROGATE'
  | 'JSON_NUMBER_RANGE'
  | 'JSON_TOO_DEEP';

export interface JsonError {
  code: JsonErrorCode;
  /** UTF-16 offset into the text where the problem was found. */
  offset: number;
  message: string;
}

export type JsonResult = { ok: true; value: JsonValue } | { ok: false; error: JsonError };

/** Thrown internally only, and always caught by {@link parseStrictJson}. */
class Fail {
  constructor(readonly error: JsonError) {}
}

/** True if the string holds a surrogate that isn't half of a valid pair. */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Parses `text` as one JSON value (RFC 8259), strictly. Never throws. */
export function parseStrictJson(text: string): JsonResult {
  let pos = 0;

  const fail = (code: JsonErrorCode, message: string, at = pos): never => {
    throw new Fail({ code, offset: at, message });
  };

  const ws = (): void => {
    while (pos < text.length) {
      const c = text.charCodeAt(pos);
      // The four whitespace characters RFC 8259 allows: space, tab, LF, CR.
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
      else break;
    }
  };

  const literal = (word: string, value: JsonValue): JsonValue => {
    if (!text.startsWith(word, pos)) fail('JSON_SYNTAX', 'unexpected token');
    pos += word.length;
    return value;
  };

  const string = (): string => {
    const start = pos;
    pos++; // the opening quote
    let out = '';
    let run = pos;
    for (;;) {
      if (pos >= text.length) fail('JSON_SYNTAX', 'unterminated string', start);
      const c = text.charCodeAt(pos);
      if (c === 0x22) break;
      if (c < 0x20) fail('JSON_SYNTAX', 'unescaped control character in a string');
      if (c !== 0x5c) {
        pos++;
        continue;
      }
      out += text.slice(run, pos);
      const e = text[pos + 1];
      if (e === 'u') {
        const hex = text.slice(pos + 2, pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('JSON_SYNTAX', 'bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        pos += 6;
      } else if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
        pos += 2;
      } else {
        fail('JSON_SYNTAX', 'bad escape');
      }
      run = pos;
    }
    out += text.slice(run, pos);
    pos++; // the closing quote
    if (hasLoneSurrogate(out)) {
      fail('JSON_LONE_SURROGATE', 'a string holds a lone surrogate', start);
    }
    return out;
  };

  const number = (): number => {
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (m === null) return fail('JSON_SYNTAX', 'unexpected token');
    const start = pos;
    pos = NUMBER.lastIndex;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail('JSON_NUMBER_RANGE', 'a number is out of range', start);
    return n;
  };

  const value = (depth: number): JsonValue => {
    ws();
    const c = text[pos];
    if (c === '{' || c === '[') {
      if (depth >= MAX_DEPTH) fail('JSON_TOO_DEEP', `nested deeper than ${MAX_DEPTH}`);
      return c === '{' ? object(depth + 1) : array(depth + 1);
    }
    if (c === '"') return string();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    return fail('JSON_SYNTAX', c === undefined ? 'unexpected end of input' : 'unexpected token');
  };

  const object = (depth: number): JsonObject => {
    pos++; // {
    const out = Object.create(null) as JsonObject;
    ws();
    if (text[pos] === '}') {
      pos++;
      return out;
    }
    for (;;) {
      ws();
      if (text[pos] !== '"') fail('JSON_SYNTAX', 'expected a key');
      const at = pos;
      const key = string();
      if (Object.hasOwn(out, key)) {
        // The key is untrusted: quote it escaped and short, never raw.
        const shown = JSON.stringify(key.length > 64 ? `${key.slice(0, 64)}…` : key);
        fail('JSON_DUPLICATE_KEY', `the key ${shown} appears more than once`, at);
      }
      ws();
      if (text[pos] !== ':') fail('JSON_SYNTAX', "expected ':'");
      pos++;
      out[key] = value(depth);
      ws();
      if (text[pos] === ',') {
        pos++;
        continue;
      }
      if (text[pos] === '}') {
        pos++;
        return out;
      }
      fail('JSON_SYNTAX', "expected ',' or '}'");
    }
  };

  const array = (depth: number): JsonValue[] => {
    pos++; // [
    const out: JsonValue[] = [];
    ws();
    if (text[pos] === ']') {
      pos++;
      return out;
    }
    for (;;) {
      out.push(value(depth));
      ws();
      if (text[pos] === ',') {
        pos++;
        continue;
      }
      if (text[pos] === ']') {
        pos++;
        return out;
      }
      fail('JSON_SYNTAX', "expected ',' or ']'");
    }
  };

  try {
    const v = value(0);
    ws();
    if (pos !== text.length) fail('JSON_SYNTAX', 'text after the value');
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.error };
    throw e;
  }
}
