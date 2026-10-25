// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * A worker thread: one estimate at a time, inside the heap and stack limits the pool
 * gave it, killed by the pool at its wall-clock budget (ADR-0045).
 *
 * The record arrives as JSON text and is read again here (16 KB at most, so cheap): a
 * record cloned across threads would lose the null prototypes the strict parser gave it.
 * Its content hash is of the parsed values, so it must come out as the main thread's.
 */

import { parentPort } from 'node:worker_threads';
import { readMachine } from '@woodpatch/gcode-db';
import { handleEstimate } from './handle.js';

export interface Job {
  id: number;
  scope: string;
  gcode: string;
  machine: string;
  recordHash: string;
  build: string;
}

/** `body` is the response's JSON text. A throw is reported as `ok: false`, nothing more. */
export type JobResult = { id: number; ok: true; body: string } | { id: number; ok: false };
/** Sent once, when this module has loaded: the pool's signal that the worker can work. */
export interface Ready {
  ready: true;
}

const port = parentPort;
if (!port) throw new Error('worker.js runs only as a worker thread');

port.on('message', (job: Job) => {
  let result: JobResult;
  try {
    const record = readMachine(job.machine);
    // The main thread read the same text before queueing it: a refusal now is a bug.
    if (!record.ok || record.hash !== job.recordHash)
      throw new Error('record differs in the worker');
    const response = handleEstimate(
      { scope: job.scope, gcode: job.gcode, record: record.record, recordHash: record.hash },
      job.build,
    );
    result = { id: job.id, ok: true, body: JSON.stringify(response) };
  } catch {
    // The error's message and stack may quote the input (ADR-0044): neither leaves here.
    result = { id: job.id, ok: false };
  }
  port.postMessage(result);
});

port.postMessage({ ready: true } satisfies Ready);
