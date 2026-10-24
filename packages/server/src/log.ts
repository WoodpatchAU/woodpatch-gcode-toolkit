// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The server's log (ADR-0040): one JSON object per line, to stdout (journald). What it
 * may hold is fixed here, field by field. It never holds the G-code, a diagnostic, an
 * error's message, or a scope as sent:
 * - the G-code appears only as an HMAC, keyed per scope, so someone who can read the
 *   logs can't confirm a guessed file; the key is HKDF of one secret with the scope;
 * - a scope appears only as a pseudonym (an HMAC under its own derived key), so one
 *   scope's requests can be followed without saying whose they are.
 */

import { createHmac, hkdfSync } from 'node:crypto';
import type { ErrorCode } from './contract.js';

/** A request, as the log may record it. */
export interface RequestLog {
  /** HTTP status sent. */
  status: number;
  /** The error code, when it was an error. */
  code?: ErrorCode;
  /** Body bytes received. */
  bytes: number;
  /** Known only once the request parsed: they key the two HMACs. */
  scope?: string;
  gcode?: string;
  parseMs?: number;
  queueMs?: number;
  runMs?: number;
  cached?: boolean;
}

/** At least this many bytes of secret (SHA-256's block of entropy). */
export const MIN_SECRET_BYTES = 32;

export class Logger {
  readonly #secret: Buffer;
  readonly #sink: (line: string) => void;
  readonly #scopeKey: Buffer;

  constructor(secret: Buffer, sink: (line: string) => void) {
    if (secret.length < MIN_SECRET_BYTES) {
      throw new RangeError(`the log secret must be at least ${MIN_SECRET_BYTES} bytes`);
    }
    this.#secret = Buffer.from(secret);
    this.#sink = sink;
    this.#scopeKey = this.#derive('scope-id');
  }

  // Each purpose gets its own key. Every per-scope info starts with the fixed "gcode:",
  // and the pseudonyms' info is exactly "scope-id", which doesn't: so no scope's key can
  // be the pseudonyms' key. (A scope may itself contain ":", as in "staff:1".)
  #derive(info: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.#secret, Buffer.alloc(0), info, 32));
  }

  /** The G-code's HMAC under its scope's key: 32 hex digits. */
  gcodeMac(scope: string, gcode: string): string {
    const key = this.#derive(`gcode:${scope}`);
    return createHmac('sha256', key).update(gcode, 'utf8').digest('hex').slice(0, 32);
  }

  /** A scope's pseudonym: 16 hex digits, the same for every request of that scope. */
  scopeId(scope: string): string {
    return createHmac('sha256', this.#scopeKey).update(scope, 'utf8').digest('hex').slice(0, 16);
  }

  request(r: RequestLog): void {
    this.#write({
      event: 'request',
      status: r.status,
      ...(r.code !== undefined ? { code: r.code } : {}),
      bytes: r.bytes,
      ...(r.scope !== undefined ? { scope: this.scopeId(r.scope) } : {}),
      ...(r.scope !== undefined && r.gcode !== undefined
        ? { gcode: this.gcodeMac(r.scope, r.gcode), gcodeBytes: Buffer.byteLength(r.gcode) }
        : {}),
      ...(r.parseMs !== undefined ? { parseMs: Math.round(r.parseMs) } : {}),
      ...(r.queueMs !== undefined ? { queueMs: Math.round(r.queueMs) } : {}),
      ...(r.runMs !== undefined ? { runMs: Math.round(r.runMs) } : {}),
      ...(r.cached !== undefined ? { cached: r.cached } : {}),
    });
  }

  /** A server event: its name and numbers only (never text from a request). */
  event(name: string, fields: Record<string, number | boolean> = {}): void {
    this.#write({ event: name, ...fields });
  }

  #write(o: Record<string, unknown>): void {
    this.#sink(JSON.stringify({ time: new Date().toISOString(), ...o }));
  }
}
