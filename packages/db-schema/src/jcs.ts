// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The machine record's content hash (ADR-0041): SHA-256 of the record's JSON
 * Canonicalization Scheme form (RFC 8785, JCS), as lowercase hex.
 *
 * Only the toolkit computes this hash. The storing application keeps the hash the
 * server echoes and never recomputes it, so this file is the one definition.
 *
 * Why JCS can lean on `JSON.stringify` for leaves: RFC 8785 defines its number
 * form as ECMAScript's Number-to-String (shortest round-trip; `-0` → `0`), and its
 * string escaping as ECMAScript's `JSON.stringify` for well-formed strings. What
 * `JSON.stringify` does NOT do is sort keys, so objects are written here, with keys
 * in UTF-16 code-unit order (the default `Array.prototype.sort` order).
 *
 * Pure TypeScript with no platform API (no `crypto`, no `TextEncoder`), so it runs
 * the same in Node, browsers and workers, synchronously.
 */

import { hasLoneSurrogate, type JsonValue } from './json.js';

/** Thrown for a value JCS can't represent. Callers validate first, so it's a bug. */
export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

/** Returns the RFC 8785 canonical form of `value`. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalJsonError('a number is not finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return str(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  // Own keys only: a record from parseStrictJson has a null prototype, and nothing
  // inherited may reach the hash.
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${str(k)}:${canonicalJson(value[k] as JsonValue)}`).join(',')}}`;
}

function str(s: string): string {
  if (hasLoneSurrogate(s)) throw new CanonicalJsonError('a string holds a lone surrogate');
  return JSON.stringify(s);
}

/** SHA-256 of the canonical form's UTF-8 bytes, as 64 lowercase hex digits. */
export function contentHash(value: JsonValue): string {
  return sha256Hex(utf8(canonicalJson(value)));
}

/** UTF-8 bytes of a well-formed string (no lone surrogates: canonicalJson refused them). */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return Uint8Array.from(out);
}

// SHA-256 (FIPS 180-4). Tested against Node's crypto on random inputs.
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of `bytes`, as 64 lowercase hex digits. */
export function sha256Hex(bytes: Uint8Array): string {
  // Pad: a 1 bit, zeros, then the bit length as a 64-bit big-endian integer.
  const len = bytes.length;
  const padded = new Uint8Array((((len + 9 + 63) >> 6) << 6) >>> 0);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  view.setUint32(padded.length - 4, (len << 3) >>> 0);

  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  // Indexes are always in range here; `?? 0` only satisfies noUncheckedIndexedAccess.
  const at = (arr: Uint32Array, i: number): number => arr[i] ?? 0;

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = at(w, i - 15);
      const b = at(w, i - 2);
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) >>> 0;
    }
    let a = at(h, 0);
    let b = at(h, 1);
    let c = at(h, 2);
    let d = at(h, 3);
    let e = at(h, 4);
    let f = at(h, 5);
    let g = at(h, 6);
    let hh = at(h, 7);
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + at(K, i) + at(w, i)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    // A Uint32Array store wraps modulo 2^32, as SHA-256's additions require.
    const v = Uint32Array.of(a, b, c, d, e, f, g, hh);
    for (let i = 0; i < 8; i++) h[i] = at(h, i) + at(v, i);
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
