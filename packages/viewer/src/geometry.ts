// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { VERTEX_ARC, VERTEX_RAPID } from '@woodpatch/gcode-core';
import type { LoadedProgram } from './program.js';

/** Colours as 0xRRGGBB. Defaults keep upstream's language: white cuts, red rapids, yellow highlight. */
export interface Palette {
  readonly feed: number;
  readonly arc: number;
  readonly rapid: number;
  readonly highlight: number;
  /** The original program, drawn faintly behind a transformed one (`setGhost`). */
  readonly ghost: number;
  readonly grid: number;
  readonly background: number;
}

export const DEFAULT_PALETTE: Palette = Object.freeze({
  feed: 0xffffff,
  arc: 0xffffff,
  rapid: 0xff0000,
  highlight: 0xffff00,
  ghost: 0x5b8def,
  grid: 0xff7f2a,
  background: 0x1b1b1f,
});

/**
 * Line-segment buffers for the GPU (LineSegmentsGeometry). Segment i joins vertex i to
 * vertex i + 1 of the polyline, and takes vertex i + 1's kind and line.
 *
 * Positions are Float32, which has about 7 significant digits: at 4000 mm that's
 * 0.0005 mm, fine for display but not after adding the machine offsets of a big
 * router. So they're stored RELATIVE TO `origin`, the centre of the path's box, and
 * the scene places the mesh at `origin`.
 */
export interface SegmentBuffers {
  readonly segments: number;
  /** 6 floats per segment: start xyz, end xyz, relative to origin. */
  readonly positions: Float32Array;
  /** 6 floats per segment: start rgb, end rgb (0..1). */
  readonly colors: Float32Array;
  readonly origin: readonly [number, number, number];
}

/** Scene coordinates are clamped to ±1e9 mm (1,000 km): finite in Float32, beyond any machine. */
const MAX_COORD = 1e9;

const rgb = (c: number): [number, number, number] => [
  ((c >> 16) & 0xff) / 255,
  ((c >> 8) & 0xff) / 255,
  (c & 0xff) / 255,
];

export function buildSegments(
  p: LoadedProgram,
  palette: Palette = DEFAULT_PALETTE,
): SegmentBuffers {
  const n = Math.max(0, p.count - 1);
  const b = p.bounds.all;
  const origin: [number, number, number] = b
    ? [(b.min.X + b.max.X) / 2, (b.min.Y + b.max.Y) / 2, (b.min.Z + b.max.Z) / 2]
    : [0, 0, 0];
  const positions = new Float32Array(n * 6);
  const colors = new Float32Array(n * 6);
  const colour = {
    [VERTEX_RAPID]: rgb(palette.rapid),
    [VERTEX_ARC]: rgb(palette.arc),
    feed: rgb(palette.feed),
  };
  const src = p.positions;
  // Coordinates finite in Float64 can overflow Float32 after the shift (reviewer,
  // toolkit #20): clamp so the GPU never sees Infinity. loadProgram warns about such a
  // span, and no real machine comes near it.
  const clamp = (v: number) => (v > MAX_COORD ? MAX_COORD : v < -MAX_COORD ? -MAX_COORD : v);
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const o = i * 6;
    positions[o] = clamp((src[a] as number) - origin[0]);
    positions[o + 1] = clamp((src[a + 1] as number) - origin[1]);
    positions[o + 2] = clamp((src[a + 2] as number) - origin[2]);
    positions[o + 3] = clamp((src[a + 3] as number) - origin[0]);
    positions[o + 4] = clamp((src[a + 4] as number) - origin[1]);
    positions[o + 5] = clamp((src[a + 5] as number) - origin[2]);
    const k = p.kind[i + 1];
    const c =
      k === VERTEX_RAPID
        ? colour[VERTEX_RAPID]
        : k === VERTEX_ARC
          ? colour[VERTEX_ARC]
          : colour.feed;
    colors[o] = colors[o + 3] = c[0];
    colors[o + 1] = colors[o + 4] = c[1];
    colors[o + 2] = colors[o + 5] = c[2];
  }
  return { segments: n, positions, colors, origin };
}
