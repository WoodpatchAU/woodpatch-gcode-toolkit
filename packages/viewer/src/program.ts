// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import {
  DIALECTS,
  GENERIC,
  interpret,
  parse,
  pathBounds,
  summarise,
  tessellate,
  type Diagnostic,
  type InterpretLimits,
  type PathBounds,
  type PathOptions,
  type ProgramSummary,
} from '@woodpatch/gcode-core';

/**
 * A program, ready to draw (parcel 3a, ADR-0026): the core's parse → interpret →
 * tessellate, flattened into plain data. Everything here is either a typed array or
 * a structured-cloneable object, so it can cross from a worker to the page with the
 * big arrays transferred, not copied.
 */
export interface LoadedProgram {
  /** Vertex count of the one continuous polyline (vertex 0 is the start). */
  readonly count: number;
  /** x, y, z per vertex, machine coordinates, mm (Float64: exact). */
  readonly positions: Float64Array;
  /** Per vertex: VERTEX_RAPID, VERTEX_FEED or VERTEX_ARC (core). Vertex 0 unused. */
  readonly kind: Uint8Array;
  /**
   * Per vertex: the 1-based main-program line of the move it ends; 0 for vertex 0 and
   * for moves from subprogram files (they belong to another file's lines).
   */
  readonly vertexLine: Uint32Array;
  readonly bounds: PathBounds;
  /**
   * The program at a glance: per-axis extents for cut and rapid moves (work
   * coordinates), feeds, spindle speeds, tools, distances and Z levels. Computed here,
   * in the worker, so the page gets it for free.
   */
  readonly summary: ProgramSummary;
  readonly diagnostics: readonly Diagnostic[];
  /** The path was coarsened or truncated to fit the vertex budget (core tessellate). */
  readonly coarsened: boolean;
  readonly truncated: boolean;
  /** The dialect actually used. */
  readonly dialect: string;
}

export interface LoadOptions {
  /** A dialect id from the core's DIALECTS ("generic", "masso-g3-5.13", "linuxcnc-2.9"). Default: generic. */
  readonly dialect?: string;
  readonly path?: PathOptions;
  readonly limits?: Partial<InterpretLimits>;
}

/** A path larger than this (mm) is flagged: 100 m, far beyond any router. */
const MAX_PLAUSIBLE_SPAN = 100_000;

/** Parse, interpret and tessellate. Synchronous; the worker entry runs exactly this. */
export function loadProgram(text: string, options: LoadOptions = {}): LoadedProgram {
  const dialect = DIALECTS.find((d) => d.id === options.dialect) ?? GENERIC;
  const program = parse(text);
  const result = interpret(program, {
    dialect,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  const buffers = tessellate(result.steps, options.path);
  const vertexLine = new Uint32Array(buffers.count);
  for (let v = 1; v < buffers.count; v++) {
    const s = result.steps[buffers.step[v] as number];
    if (s && s.file === undefined) vertexLine[v] = s.line;
  }
  const bounds = pathBounds(result.steps);
  const diagnostics: Diagnostic[] = [...program.diagnostics, ...result.diagnostics];
  const b = bounds.all;
  if (b && Math.max(b.max.X - b.min.X, b.max.Y - b.min.Y, b.max.Z - b.min.Z) > MAX_PLAUSIBLE_SPAN)
    diagnostics.push({
      severity: 'warning',
      code: 'VIEW_SPAN_IMPLAUSIBLE',
      message: `The path spans more than ${MAX_PLAUSIBLE_SPAN / 1000} m, larger than any real machine; check the units and coordinates`,
      line: 0,
    });
  return {
    count: buffers.count,
    positions: buffers.positions,
    kind: buffers.kind,
    vertexLine,
    bounds,
    summary: summarise(result.steps),
    // Syntax findings live on the parsed program, the interpreter's on its result.
    diagnostics,
    coarsened: buffers.coarsened,
    truncated: buffers.truncated,
    dialect: dialect.id,
  };
}

/** The ArrayBuffers of a LoadedProgram, for postMessage's transfer list. */
export function transferables(p: LoadedProgram): ArrayBuffer[] {
  return [p.positions.buffer, p.kind.buffer, p.vertexLine.buffer] as ArrayBuffer[];
}
