// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The `/estimate` wire contract, version 1 (ADR-0044): the request, its strict parser,
 * the response, and the closed list of error codes.
 *
 * The caller branches on an error's `code`, never on its message, and retries only the
 * codes marked retriable. Messages never quote the request's content: an unknown field's
 * name is the one exception, escaped by `quoteKey` (printable ASCII, cut at 64), and it
 * goes back to the caller only. Error messages aren't logged (ADR-0040).
 */

import {
  parseStrictJson,
  quoteKey,
  readMachine,
  utf8Length,
  type JsonErrorCode,
  type MachineProblem,
  type MachineRecord,
} from '@woodpatch/gcode-db';

export const REQUEST_VERSION = 1;

/**
 * The whole request body, in bytes. The HTTP layer enforces it at the socket read: a
 * declared length over it is refused before anything is read, and a body that grows
 * past it is refused without buffering further. Room for the G-code cap, the record
 * and JSON's escaping of a typical program.
 */
export const MAX_REQUEST_BYTES = 25_000_000;
/** The G-code, as UTF-8 bytes once the envelope is decoded (ADR-0040's 20 MB). */
export const MAX_GCODE_BYTES = 20_000_000;
/** The G-code's lines, counted as core's parser counts them ({@link countLines}). */
export const MAX_GCODE_LINES = 2_000_000;
/** At most this many entries of any list in a response; each list says how many there were. */
export const MAX_LISTED = 100;

/** The longest text in a response, in code points: messages, notes, paths. */
export const MAX_TEXT = 500;
/** `build`: printable ASCII, no spaces, at most 128 characters. */
export const BUILD = /^[\x21-\x7e]{1,128}$/;

/**
 * `text`, cut to MAX_TEXT code points with "..." at the end. Cut by code point, so a
 * surrogate pair is never split into a lone surrogate (which has no UTF-8 form).
 */
export function boundText(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  const points = Array.from(text);
  return points.length <= MAX_TEXT ? text : `${points.slice(0, MAX_TEXT - 3).join('')}...`;
}

/**
 * An opaque caller-chosen token: never parsed, never logged raw (ADR-0040's HMAC).
 * JavaScript's `$` matches only at the end; a PCRE client copying this pattern must
 * use `\z` or the `D` modifier, or its `$` also matches before a final newline.
 */
export const SCOPE = /^[A-Za-z0-9:_-]{1,64}$/;

/** The request's fields: all required. Anything else is refused. */
export const REQUEST_FIELDS = ['v', 'scope', 'gcode', 'machine'] as const;
/** Named now so a caller can't use them early: a later version of the request adds them. */
export const RESERVED_FIELDS = ['toolId', 'materialId'] as const;

/**
 * Every error the server answers with: its HTTP status, and whether the same request
 * may succeed later. This list is closed: a new code is a new version of the contract.
 * A retriable answer carries `Retry-After` (seconds).
 */
export const ERRORS = {
  /** The body, or its declared length, is over MAX_REQUEST_BYTES. */
  REQUEST_TOO_LARGE: { status: 413, retriable: false },
  /** The body isn't one strict JSON value in UTF-8 (a repeated key, a lone surrogate, ...). */
  REQUEST_MALFORMED: { status: 400, retriable: false },
  /** The envelope's shape is wrong: a missing, unknown or reserved field, a bad scope. */
  REQUEST_INVALID: { status: 400, retriable: false },
  /** `v` is a version of the request this server doesn't read. */
  REQUEST_VERSION: { status: 400, retriable: false },
  /** The machine record was refused; `problems` lists why (ADR-0041). */
  MACHINE_INVALID: { status: 422, retriable: false },
  /** The G-code is over MAX_GCODE_BYTES or MAX_GCODE_LINES. */
  PROGRAM_TOO_LARGE: { status: 413, retriable: false },
  /** The work ran out of time or memory. The same request would again. */
  ESTIMATE_BUDGET_EXCEEDED: { status: 422, retriable: false },
  /** Every worker is busy and the queue is full. */
  SERVER_BUSY: { status: 503, retriable: true },
  /** This scope already has its share of the workers. */
  SCOPE_BUSY: { status: 429, retriable: true },
  /** Not POST. */
  METHOD_NOT_ALLOWED: { status: 405, retriable: false },
  /** Not /estimate. */
  NOT_FOUND: { status: 404, retriable: false },
  /** Not `application/json`. */
  UNSUPPORTED_MEDIA_TYPE: { status: 415, retriable: false },
  /** A bug. Deterministic, so a retry would meet it again. */
  INTERNAL: { status: 500, retriable: false },
} as const satisfies Record<string, { status: number; retriable: boolean }>;

export type ErrorCode = keyof typeof ERRORS;

export interface ErrorBody {
  v: typeof REQUEST_VERSION;
  error: {
    code: ErrorCode;
    message: string;
    /** MACHINE_INVALID only: the first MAX_LISTED of the record's problems. */
    problems?: MachineProblem[];
  };
}

/** A request that passed every check. */
export interface EstimateRequest {
  scope: string;
  gcode: string;
  record: MachineRecord;
  /** ADR-0041's content hash of the record as received. Never supplied by the caller. */
  recordHash: string;
}

export type ParseResult = { ok: true; request: EstimateRequest } | { ok: false; error: ErrorBody };

const fail = (code: ErrorCode, message: string, problems?: MachineProblem[]): ParseResult => {
  // At most MAX_LISTED problems (a 16 KB record can hold hundreds of unknown fields),
  // each with bounded text.
  const listed = problems?.slice(0, MAX_LISTED).map((p) => ({
    code: p.code,
    path: boundText(p.path),
    message: boundText(p.message),
  }));
  const error = { code, message: boundText(message) };
  return {
    ok: false,
    error: { v: REQUEST_VERSION, error: listed ? { ...error, problems: listed } : error },
  };
};

const JSON_MESSAGES: Record<JsonErrorCode, string> = {
  JSON_SYNTAX: 'is not valid JSON',
  JSON_DUPLICATE_KEY: 'has an object with a repeated key',
  JSON_LONE_SURROGATE: 'has a string holding a lone surrogate',
  JSON_NUMBER_RANGE: 'has a number out of range',
  JSON_TOO_DEEP: 'is nested too deeply',
};

/** Lines as core's parser counts them: one more than the line breaks (CR LF, CR or LF). */
export function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a || (c === 0x0d && text.charCodeAt(i + 1) !== 0x0a)) n++;
  }
  return n;
}

/**
 * Parses a request body (already decoded from UTF-8, which the HTTP layer does with a
 * fatal decoder). Never throws. The checks run in a fixed order, so one request always
 * gets the same code: envelope, version, fields, scope, G-code size, then the record.
 */
export function parseRequest(text: string): ParseResult {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    const { code, offset } = parsed.error;
    return fail('REQUEST_MALFORMED', `The request ${JSON_MESSAGES[code]} (at offset ${offset})`);
  }
  const body = parsed.value;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail('REQUEST_INVALID', 'The request must be a JSON object');
  }

  // The version first: a request of another version is judged by that version's rules.
  // (JSON's 1.0 and 1e0 are the number 1, so they're version 1 too.)
  if (!Object.hasOwn(body, 'v')) return fail('REQUEST_INVALID', 'The request needs "v"');
  if (body.v !== REQUEST_VERSION) {
    return fail('REQUEST_VERSION', `This server reads version ${REQUEST_VERSION} of the request`);
  }

  for (const k of Object.keys(body)) {
    if ((RESERVED_FIELDS as readonly string[]).includes(k)) {
      return fail('REQUEST_INVALID', `"${k}" is reserved for a later version of the request`);
    }
    if (!(REQUEST_FIELDS as readonly string[]).includes(k)) {
      return fail('REQUEST_INVALID', `The request has an unknown field ${quoteKey(k)}`);
    }
  }
  for (const k of REQUEST_FIELDS) {
    if (!Object.hasOwn(body, k)) return fail('REQUEST_INVALID', `The request needs "${k}"`);
  }

  const { scope, gcode, machine } = body;
  if (typeof scope !== 'string' || !SCOPE.test(scope)) {
    return fail('REQUEST_INVALID', '"scope" must be 1-64 characters from A-Z a-z 0-9 : _ -');
  }
  if (typeof gcode !== 'string') return fail('REQUEST_INVALID', '"gcode" must be a string');
  if (typeof machine !== 'string') {
    // ADR-0041's wire form: the record travels as its own text, so "as received" has a
    // meaning for its hash.
    return fail('REQUEST_INVALID', '"machine" must be a string holding the record\'s JSON text');
  }

  if (utf8Length(gcode) > MAX_GCODE_BYTES) {
    return fail('PROGRAM_TOO_LARGE', `The G-code is over ${MAX_GCODE_BYTES} bytes`);
  }
  if (countLines(gcode) > MAX_GCODE_LINES) {
    return fail('PROGRAM_TOO_LARGE', `The G-code is over ${MAX_GCODE_LINES} lines`);
  }

  const record = readMachine(machine);
  if (!record.ok) return fail('MACHINE_INVALID', 'The machine record was refused', record.problems);
  return { ok: true, request: { scope, gcode, record: record.record, recordHash: record.hash } };
}
