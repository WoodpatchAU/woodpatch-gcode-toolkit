// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import {
  checkStockMoves,
  VERTEX_RAPID,
  type Diagnostic,
  type StockCheckOptions,
  type StockMove,
  type StockShape,
} from '@woodpatch/gcode-core';
import type { LoadedProgram } from './program.js';

/**
 * The core's stock check (ADR-0054) on a loaded program's path, so a page holding the
 * path (not the interpreter's steps) can re-check as the stock changes, without
 * loading the program again. The path is in the same coordinates the stock is drawn
 * in. Vertex 0 is the interpreter's assumed start, so the first move is checked only
 * where it ends, unless `startKnown`. Moves from subprogram files (line 0) are
 * reported on line 0 with `file: 'subprogram'`.
 */
export function stockCollisions(
  p: LoadedProgram,
  shapes: readonly StockShape[],
  options: StockCheckOptions = {},
): Diagnostic[] {
  function* moves(): Generator<StockMove> {
    const pos = p.positions;
    for (let v = 1; v < p.count; v++) {
      const a = (v - 1) * 3;
      const b = v * 3;
      const line = p.vertexLine[v] as number;
      yield {
        rapid: p.kind[v] === VERTEX_RAPID,
        from: { X: pos[a] as number, Y: pos[a + 1] as number, Z: pos[a + 2] as number },
        to: { X: pos[b] as number, Y: pos[b + 1] as number, Z: pos[b + 2] as number },
        line,
        ...(line === 0 ? { file: 'subprogram' } : {}),
      };
    }
  }
  return checkStockMoves(moves(), shapes, options);
}
