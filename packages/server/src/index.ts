// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * @woodpatch/gcode-server: the machining-time estimate service. This part is its wire
 * contract (ADR-0044) and the mapping from a machine record to core; the HTTP layer
 * and its deployment follow (5d-2, 5d-3).
 */

export {
  ERRORS,
  MAX_GCODE_BYTES,
  MAX_GCODE_LINES,
  MAX_LISTED,
  MAX_REQUEST_BYTES,
  REQUEST_FIELDS,
  REQUEST_VERSION,
  RESERVED_FIELDS,
  SCOPE,
  countLines,
  parseRequest,
  type ErrorBody,
  type ErrorCode,
  type EstimateRequest,
  type ParseResult,
} from './contract.js';
export { echoRecord, mapRecord, type Mapped, type RecordEcho } from './map.js';
export { handleEstimate, type EstimateResponse, type Finding, type Listed } from './handle.js';
