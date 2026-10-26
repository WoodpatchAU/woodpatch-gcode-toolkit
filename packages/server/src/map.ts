// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * A validated machine record (ADR-0041) as the estimator (ADR-0043) and the travel
 * check (ADR-0042) take it. It lives here, not in core or the record's package, so those
 * two stay independent of each other.
 *
 * Every field of the record is either read here or listed, with its reason, in the
 * every-field-once test (map.test.ts). Change the record, and that test says which.
 */

import {
  DIALECTS,
  type Axis,
  type AxisTravel,
  type Dialect,
  type EstimateAxis,
  type EstimateMachine,
  type TravelLimits,
} from '@woodpatch/gcode-core';
import type { MachineRecord, P } from '@woodpatch/gcode-db';

export interface Mapped {
  readonly machine: EstimateMachine;
  readonly travel: TravelLimits;
  readonly dialect: Dialect;
}

/** What every response echoes of the record (ADR-0041), besides its hash. */
export interface RecordEcho {
  readonly id: string;
  readonly version: 1;
  readonly revision: number;
  readonly calibration: 'calibrated' | 'uncalibrated';
}

const axis = (a: { maxVelocity: P; acceleration: P }): EstimateAxis => ({
  maxVelocity: a.maxVelocity.value,
  acceleration: a.acceleration.value,
});

/** Throws only on a record `validateMachine` would refuse: callers validate first. */
export function mapRecord(r: MachineRecord): Mapped {
  const dialect = DIALECTS.find((d) => d.id === r.dialect);
  // The record's dialect list equals core's profile ids (a db-schema test), so this
  // would be a bug, not bad input.
  if (!dialect) throw new Error('the record names a dialect core has no profile for');

  const axes: Record<'X' | 'Y' | 'Z', EstimateAxis> & Partial<Record<Axis, EstimateAxis>> = {
    X: axis(r.axes.X),
    Y: axis(r.axes.Y),
    Z: axis(r.axes.Z),
  };
  const travel: Partial<Record<Axis, AxisTravel>> = {};
  for (const a of ['X', 'Y', 'Z'] as const) {
    travel[a] = { min: r.axes[a].min.value, max: r.axes[a].max.value };
  }
  for (const a of ['A', 'B', 'C'] as const) {
    const ra = r.axes[a];
    if (!ra) continue;
    axes[a] = axis(ra);
    // No min and max: continuous rotation, so the axis isn't travel-checked.
    if (ra.min && ra.max) travel[a] = { min: ra.min.value, max: ra.max.value };
  }

  const cal = r.calibration;
  // Revision 2 can say how rapids move; only a measured model is confirmed. Without it
  // (revision 1, or left out), 'coordinated' is assumed: what the operator's router does
  // (operator, 2026-10-24). Unconfirmed, every estimate notes the assumption.
  const rapid = r.planner.rapidModel;
  const machine: EstimateMachine = {
    axes,
    ...(r.rapidRate ? { rapidRate: r.rapidRate.value } : {}),
    rapidModel: rapid?.value ?? 'coordinated',
    rapidModelConfirmed: rapid?.source === 'measured',
    junctionDeviation: r.planner.junctionDeviation.value,
    ...(r.planner.blockRate ? { blockRate: r.planner.blockRate.value } : {}),
    ...(r.planner.lookahead ? { lookahead: r.planner.lookahead.value } : {}),
    spinUpSeconds: r.spindle.spinUpSeconds.value,
    spinDownSeconds: r.spindle.spinDownSeconds.value,
    toolChangeSeconds: r.overheads?.toolChangeSeconds?.value ?? 0,
    programStartSeconds: r.overheads?.programStartSeconds?.value ?? 0,
    pauseSeconds: r.overheads?.pauseSeconds?.value ?? 0,
    calibration:
      cal.status === 'calibrated'
        ? { timeFactor: cal.timeFactor, accelFactor: cal.accelFactor }
        : null,
  };
  return { machine, travel, dialect };
}

export function echoRecord(r: MachineRecord): RecordEcho {
  return {
    id: r.id,
    version: r.version,
    revision: r.revision,
    calibration: r.calibration.status,
  };
}
