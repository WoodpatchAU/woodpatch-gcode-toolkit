// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import type { Diagnostic, TransformOp } from '@woodpatch/gcode-core';

/** A transform, run in the worker (parcel 4e). */
export interface TransformRequest {
  readonly kind: 'transform';
  readonly id: number;
  readonly text: string;
  readonly ops: readonly TransformOp[];
  /** A dialect id, e.g. 'generic'. */
  readonly dialect: string;
}

export interface TransformResponse {
  readonly kind: 'transform';
  readonly id: number;
  readonly ok: boolean;
  /** The result, or the input unchanged when refused. */
  readonly text: string;
  readonly changedLines: number;
  readonly diagnostics: readonly Diagnostic[];
}
