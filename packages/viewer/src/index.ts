// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * @woodpatch/gcode-viewer: the 3D view (parcel 3a, ADR-0026) and the 2D plan view
 * (parcel 3d, ADR-0029) of a G-code program.
 * Framework-free. three.js is a peer dependency: the host app provides it, so a page
 * never carries two copies.
 */
export { GcodeViewer, type PickEvent, type RenderInfo, type ViewerOptions } from './viewer.js';
export { GcodeView2D, type View2DOptions } from './view2d.js';
export {
  fitTransform,
  gridLines,
  gridSpacing,
  MAX_SCALE,
  MIN_SCALE,
  nearestSegment,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
  type Transform,
} from './plane.js';
export { ProgramLoader, type WorkerLike } from './client.js';
export { loadProgram, transferables, type LoadOptions, type LoadedProgram } from './program.js';
export { buildSegments, DEFAULT_PALETTE, type Palette, type SegmentBuffers } from './geometry.js';
export { buildLineIndex, type LineIndex } from './lineIndex.js';
export { fitDistance, gridSpec, VIEW_DIRECTIONS, type ViewName } from './view.js';
export type { LoadRequest, LoadResponse } from './worker.js';
