// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The playground's one worker script. It answers the viewer's load requests (the
// viewer's own handler) and the transform panel's requests (parcel 4e, ADR-0038). One
// script, so the core is bundled once for both: the page runs a second instance of it
// for transforms, and a long transform never holds up reading the program.
import { DIALECTS, GENERIC, transformText, type TransformOp } from '@woodpatch/gcode-core';
import { handle, type LoadRequest } from '@woodpatch/gcode-viewer/worker';
import type { TransformRequest, TransformResponse } from './transformTypes.js';

interface Scope {
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as Scope;

function transformOne(req: TransformRequest): TransformResponse {
  try {
    const dialect = DIALECTS.find((d) => d.id === req.dialect) ?? GENERIC;
    const r = transformText(req.text, req.ops as TransformOp[], { dialect });
    return { kind: 'transform', id: req.id, ...r };
  } catch (e) {
    // The core refuses rather than throws; this is for a genuine bug.
    return {
      kind: 'transform',
      id: req.id,
      ok: false,
      text: req.text,
      changedLines: 0,
      diagnostics: [
        {
          severity: 'error',
          code: 'TRANSFORM_FAILED',
          message: e instanceof Error ? e.message : String(e),
          line: 0,
        },
      ],
    };
  }
}

// Importing the viewer's entry installed its handler; this one replaces it, and hands
// load requests back to the same `handle`.
scope.onmessage = (e) => {
  const data: unknown = e.data;
  if (typeof data !== 'object' || data === null) return; // not ours: ignore
  const kind = (data as { kind?: unknown }).kind;
  if (kind === 'transform') {
    scope.postMessage(transformOne(data as TransformRequest));
    return;
  }
  // The viewer's load requests carry no kind; anything else isn't a request.
  if (kind !== undefined) return;
  const { response, transfer } = handle(data as LoadRequest);
  scope.postMessage(response, transfer);
};
