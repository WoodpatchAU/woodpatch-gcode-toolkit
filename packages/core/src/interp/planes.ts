// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { Plane } from './types.js';

/** The three axes that move the tool. */
export type LinearAxis = 'X' | 'Y' | 'Z';

/**
 * A plane's two axes in arc order (a counter-clockwise arc turns from the first toward
 * the second, seen from the normal's positive side), and the normal. The one definition:
 * the interpreter, the estimator, the travel check and the arc transform all read it.
 * Internal: interp/index.ts doesn't re-export this file.
 */
export const PLANE_AXES: Readonly<Record<Plane, readonly [LinearAxis, LinearAxis]>> = {
  XY: ['X', 'Y'],
  ZX: ['Z', 'X'],
  YZ: ['Y', 'Z'],
};
export const PLANE_NORMAL: Readonly<Record<Plane, LinearAxis>> = { XY: 'Z', ZX: 'Y', YZ: 'X' };
