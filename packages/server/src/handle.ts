// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * One estimate, from a parsed request to the response body (ADR-0044). Pure and
 * synchronous: the HTTP layer (5d-2) runs it in a worker, inside its budgets.
 */

import {
  checkTravel,
  estimateTime,
  interpret,
  parse,
  type Diagnostic,
  type EstimateUnknown,
  type Severity,
} from '@woodpatch/gcode-core';
import { MAX_LISTED, REQUEST_VERSION, type EstimateRequest } from './contract.js';
import { echoRecord, mapRecord, type RecordEcho } from './map.js';

/** A list cut at MAX_LISTED entries, with how many there were. */
export interface Listed<T> {
  count: number;
  items: T[];
}

/** A finding, without its character span. */
export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  line: number;
  file?: string;
}

export interface EstimateResponse {
  v: typeof REQUEST_VERSION;
  /** The deployed server and core build that computed this. Opaque; store it with the estimate. */
  build: string;
  /** ADR-0041's echo: what the estimate was computed for. */
  record: RecordEcho & { hash: string };
  estimate: {
    /**
     * Integer milliseconds: the figure to price from. NULL unless `complete`. Never
     * price from `knownMs`, and never price automatically when `calibrated` is false.
     */
    totalMs: number | null;
    /** The time that is known, complete or not: an "at least", never a price input. */
    knownMs: number;
    cutMs: number;
    rapidMs: number;
    eventMs: number;
    dwellMs: number;
    complete: boolean;
    calibrated: boolean;
    perTool: Listed<{ tool: number | null; ms: number }>;
    unknowns: Listed<EstimateUnknown>;
    notes: string[];
  };
  /** The travel check's warnings (ADR-0042): each one certain. None means only that. */
  travel: Listed<Finding>;
  /** The parser's and the interpreter's findings, in line order. They may quote the G-code. */
  diagnostics: Listed<Finding>;
}

function listed<T, U>(all: readonly T[], map: (t: T) => U): Listed<U> {
  return { count: all.length, items: all.slice(0, MAX_LISTED).map(map) };
}

const finding = (d: Diagnostic): Finding => ({
  severity: d.severity,
  code: d.code,
  message: d.message,
  line: d.line,
  ...(d.file !== undefined ? { file: d.file } : {}),
});

export function handleEstimate(request: EstimateRequest, build: string): EstimateResponse {
  const { machine, travel, dialect } = mapRecord(request.record);
  const program = parse(request.gcode);
  // No resolveProgram: a request is one file, so a call to another file is refused,
  // and the estimate is incomplete.
  const result = interpret(program, { dialect });
  const e = estimateTime(result, machine);
  // A run cut short always reports the error that cut it, so it's never complete.
  // Checked rather than assumed: an estimate priced from half a job is the costly bug.
  if (!result.completed && e.complete) throw new Error('a cut-short run gave a complete estimate');

  const diagnostics = [...program.diagnostics, ...result.diagnostics].sort(
    (a, b) => a.line - b.line,
  );
  return {
    v: REQUEST_VERSION,
    build,
    record: { ...echoRecord(request.record), hash: request.recordHash },
    estimate: {
      totalMs: e.totalMs,
      knownMs: e.knownMs,
      cutMs: e.cutMs,
      rapidMs: e.rapidMs,
      eventMs: e.eventMs,
      dwellMs: e.dwellMs,
      complete: e.complete,
      calibrated: e.calibrated,
      perTool: listed(e.perTool, (t) => ({ tool: t.tool, ms: t.ms })),
      unknowns: listed(e.unknowns, (u) => ({ ...u })),
      notes: [...e.notes],
    },
    travel: listed(checkTravel(result.steps, travel), finding),
    diagnostics: listed(diagnostics, finding),
  };
}
