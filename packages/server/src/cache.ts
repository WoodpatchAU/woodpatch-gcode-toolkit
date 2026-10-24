// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * Cached responses (ADR-0040). The estimate is deterministic, so a cached answer is the
 * answer. The key holds everything that can change it AND the scope: a cache shared
 * across scopes would let one caller tell, by timing, whether another had sent a file.
 *
 * Keys are an HMAC under a key made fresh for each process, so the map never holds
 * anything a memory dump could match against a guessed file.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

export interface CacheInput {
  scope: string;
  gcode: string;
  /** ADR-0041's content hash of the record. */
  recordHash: string;
  build: string;
}

export class ResponseCache {
  readonly #key = randomBytes(32);
  readonly #map = new Map<string, string>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxEntries: number, maxBytes: number) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  /** Each part is length-prefixed, so no two inputs can run together into one key. */
  key(i: CacheInput): string {
    const gcode = createHash('sha256').update(i.gcode, 'utf8').digest('hex');
    const h = createHmac('sha256', this.#key);
    for (const part of [i.scope, gcode, i.recordHash, i.build]) h.update(`${part.length}:${part};`);
    return h.digest('hex');
  }

  get(key: string): string | undefined {
    const v = this.#map.get(key);
    if (v === undefined) return undefined;
    // Most recently used goes last.
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  set(key: string, body: string): void {
    // A response is bounded (ADR-0044), but never let one take the whole cache.
    if (body.length * 2 > this.#maxBytes / 4) return;
    const old = this.#map.get(key);
    if (old !== undefined) {
      this.#bytes -= old.length * 2;
      this.#map.delete(key);
    }
    this.#map.set(key, body);
    this.#bytes += body.length * 2;
    for (const [k, v] of this.#map) {
      if (this.#map.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) break;
      this.#map.delete(k);
      this.#bytes -= v.length * 2;
    }
  }

  get size(): number {
    return this.#map.size;
  }
}
