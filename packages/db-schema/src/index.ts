// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * @woodpatch/gcode-db: the machine record's format (ADR-0041), shared by the toolkit
 * and the applications that store records. Zero runtime dependencies.
 */

export {
  MAX_DEPTH,
  MAX_QUOTED_KEY,
  hasLoneSurrogate,
  parseStrictJson,
  quoteKey,
  type JsonError,
  type JsonErrorCode,
  type JsonObject,
  type JsonResult,
  type JsonValue,
} from './json.js';
export { CanonicalJsonError, canonicalJson, contentHash, sha256Hex, utf8 } from './jcs.js';
export {
  MACHINE_DIALECTS,
  MACHINE_FIELDS,
  MACHINE_FORMAT,
  MACHINE_REVISION,
  MACHINE_VERSION,
  MAX_RECORD_BYTES,
  SOURCES,
  readMachine,
  utf8Length,
  validateMachine,
  type Calibrated,
  type FieldSet,
  type LinearAxis,
  type MachineDialect,
  type MachineProblem,
  type MachineProblemCode,
  type MachineRecord,
  type MachineResult,
  type P,
  type RotaryAxis,
  type Source,
} from './machine.js';
