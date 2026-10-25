// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * @woodpatch/gcode-server: the machining-time estimate service. Its wire contract
 * (ADR-0044), the mapping from a machine record to core, and the HTTP layer with its
 * worker pool (ADR-0045). `dist/main.js` is the entry point systemd runs; its
 * deployment files follow (5d-3).
 */

export {
  BUILD,
  ERRORS,
  MAX_GCODE_BYTES,
  MAX_GCODE_LINES,
  MAX_LISTED,
  MAX_REQUEST_BYTES,
  MAX_TEXT,
  REQUEST_FIELDS,
  REQUEST_VERSION,
  RESERVED_FIELDS,
  SCOPE,
  boundText,
  countLines,
  errorBody,
  parseRequest,
  type ErrorBody,
  type ErrorCode,
  type EstimateRequest,
  type ParseResult,
} from './contract.js';
export { echoRecord, mapRecord, type Mapped, type RecordEcho } from './map.js';
export { handleEstimate, type EstimateResponse, type Finding, type Listed } from './handle.js';
export { DEFAULT_BUDGETS, type Budgets } from './budgets.js';
export { ResponseCache, type CacheInput } from './cache.js';
export { createEstimateServer, type ServerParts } from './http.js';
export { Logger, MIN_SECRET_BYTES, type RequestLog } from './log.js';
export { WorkerPool, type Done, type Outcome } from './pool.js';
