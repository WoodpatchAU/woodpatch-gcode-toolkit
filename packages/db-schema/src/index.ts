// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * @woodpatch/gcode-db: the machine record's format (ADR-0041), shared by the toolkit
 * and the applications that store records. Zero runtime dependencies.
 */

export {
  MAX_DEPTH,
  hasLoneSurrogate,
  parseStrictJson,
  type JsonError,
  type JsonErrorCode,
  type JsonObject,
  type JsonResult,
  type JsonValue,
} from './json.js';
export { CanonicalJsonError, canonicalJson, contentHash, sha256Hex, utf8 } from './jcs.js';
