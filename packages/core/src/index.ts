// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * @woodpatch/gcode-core: public entry point.
 *
 * Phase 2 in progress. The lossless line model, tokenizer and writer (parcel 2a)
 * are here; expressions, the interpreter, the path model and dialects follow.
 */
export { ATTRIBUTION, type Attribution } from './attribution.js';
export * from './syntax/index.js';
export * from './expr/index.js';
export * from './interp/index.js';
export * from './path/index.js';
export * from './dialect/index.js';
export * from './analysis/index.js';
