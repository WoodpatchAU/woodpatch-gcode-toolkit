// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * A fixed pool of worker threads behind a bounded, fair queue (ADR-0040, ADR-0045).
 *
 * - Admission is decided at once: a scope already holding its share gets SCOPE_BUSY, and
 *   a full queue gets SERVER_BUSY. Nothing queues without limit.
 * - A request waits at most `queueMs` for a worker, then gets SERVER_BUSY.
 * - A job past `jobMs` has its worker TERMINATED, not merely abandoned: the thread and
 *   its heap go. A worker that runs out of heap is terminated by Node. Either way the
 *   job answers ESTIMATE_BUDGET_EXCEEDED, and a new worker takes the slot.
 * - A worker that throws, crashes or exits unasked answers INTERNAL, and is replaced.
 * - If MAX_START_FAILURES workers in a row die before coming online, the pool gives up
 *   (the event `workers-failing`) and answers INTERNAL: the entry point then exits, and
 *   systemd's start limits take over.
 */

import { Worker } from 'node:worker_threads';
import type { Budgets } from './budgets.js';
import type { Job, JobResult, Ready } from './worker.js';

export type Outcome =
  | { kind: 'ok'; body: string }
  | { kind: 'error'; code: 'ESTIMATE_BUDGET_EXCEEDED' | 'INTERNAL' | 'SERVER_BUSY' | 'SCOPE_BUSY' };

export interface Done {
  outcome: Outcome;
  /** Time waiting for a worker, and running in it, ms. */
  queueMs: number;
  runMs: number;
}

interface Pending {
  job: Job;
  queuedAt: number;
  startedAt: number;
  resolve: (d: Done) => void;
  /** The queue deadline, while it waits. */
  timer: NodeJS.Timeout | undefined;
}

interface Slot {
  worker: Worker;
  /** The worker has loaded and can take a job. A job's budget starts there. */
  ready: boolean;
  pending: Pending | undefined;
  timer: NodeJS.Timeout | undefined;
}

/** Workers in a row that die before coming online, before the pool gives up. */
export const MAX_START_FAILURES = 3;

export class WorkerPool {
  readonly #url: URL;
  readonly #b: Budgets;
  readonly #event: (name: string, fields?: Record<string, number | boolean>) => void;
  readonly #slots: Slot[] = [];
  readonly #queue: Pending[] = [];
  readonly #perScope = new Map<string, number>();
  #nextId = 1;
  #closed = false;
  /** Workers in a row that died before coming online; at MAX_START_FAILURES, give up. */
  #startFailures = 0;
  #broken = false;

  constructor(
    workerUrl: URL,
    budgets: Budgets,
    event: (name: string, fields?: Record<string, number | boolean>) => void = () => {},
  ) {
    this.#url = workerUrl;
    this.#b = budgets;
    this.#event = event;
    for (let i = 0; i < budgets.workers; i++) this.#slots.push(this.#spawn());
  }

  #newWorker(): Worker {
    const worker = new Worker(this.#url, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.#b.heapMb,
        maxYoungGenerationSizeMb: this.#b.youngMb,
        stackSizeMb: this.#b.stackMb,
      },
      // Nothing of the server's environment (the credentials directory's path, say).
      env: {},
      // A worker writes nothing anywhere: anything it printed is discarded, not logged.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return worker;
  }

  #spawn(): Slot {
    const slot: Slot = {
      worker: this.#newWorker(),
      ready: false,
      pending: undefined,
      timer: undefined,
    };
    this.#attach(slot);
    return slot;
  }

  /** Listens to the slot's current worker. Events from a worker since replaced are ignored. */
  #attach(slot: Slot): void {
    const worker = slot.worker;
    worker.on('message', (r: JobResult | Ready) => {
      if ('ready' in r) {
        // Its module has loaded (Node's 'online' comes before that, so a worker.js that
        // throws while loading would look online). A job's budget starts from here.
        if (slot.worker !== worker || this.#closed) return;
        slot.ready = true;
        this.#startFailures = 0;
        this.#drain();
        return;
      }
      const p = slot.pending;
      if (slot.worker !== worker || !p || r.id !== p.job.id) return;
      this.#finish(slot, r.ok ? { kind: 'ok', body: r.body } : { kind: 'error', code: 'INTERNAL' });
    });
    worker.on('error', (e: Error & { code?: string }) => {
      if (slot.worker !== worker || this.#closed) return;
      const oom = e.code === 'ERR_WORKER_OUT_OF_MEMORY';
      this.#event(oom ? 'worker-out-of-memory' : 'worker-error');
      this.#replace(slot, oom ? 'ESTIMATE_BUDGET_EXCEEDED' : 'INTERNAL');
    });
    // A reply that can't be deserialised is a bug, not a budget: INTERNAL.
    worker.on('messageerror', () => {
      if (slot.worker !== worker || this.#closed) return;
      this.#event('worker-message-error');
      this.#replace(slot, 'INTERNAL');
    });
    worker.on('exit', () => {
      // Exits we caused (a replacement, close) are from a worker no longer the slot's.
      if (slot.worker !== worker || this.#closed) return;
      this.#event('worker-exit');
      this.#replace(slot, 'INTERNAL');
    });
  }

  /** Swaps in a new worker, answering the job the old one held (if any) with `code`. */
  #replace(slot: Slot, code: 'ESTIMATE_BUDGET_EXCEEDED' | 'INTERNAL'): void {
    const old = slot.worker;
    // A worker that never came online can't run anything (a broken worker.js, say):
    // respawning it forever would only spin. After a few in a row, stop and say so.
    if (!slot.ready && ++this.#startFailures >= MAX_START_FAILURES) {
      this.#broken = true;
      this.#event('workers-failing');
      // ADR-0045: a pool that gave up answers INTERNAL, queued or running alike.
      void this.close('INTERNAL');
      return;
    }
    slot.ready = false;
    slot.worker = this.#newWorker();
    this.#attach(slot);
    void old.terminate();
    this.#event('worker-replaced');
    if (slot.pending) this.#finish(slot, { kind: 'error', code });
  }

  #finish(slot: Slot, outcome: Outcome): void {
    const p = slot.pending;
    if (!p) return;
    clearTimeout(slot.timer);
    slot.pending = undefined;
    slot.timer = undefined;
    this.#release(p.job.scope);
    p.resolve({ outcome, queueMs: p.startedAt - p.queuedAt, runMs: Date.now() - p.startedAt });
    this.#drain();
  }

  #release(scope: string): void {
    const n = (this.#perScope.get(scope) ?? 1) - 1;
    if (n <= 0) this.#perScope.delete(scope);
    else this.#perScope.set(scope, n);
  }

  #start(slot: Slot, p: Pending): void {
    clearTimeout(p.timer);
    p.timer = undefined;
    p.startedAt = Date.now();
    slot.pending = p;
    slot.timer = setTimeout(() => {
      this.#event('job-budget-exceeded', { jobMs: this.#b.jobMs });
      this.#replace(slot, 'ESTIMATE_BUDGET_EXCEEDED');
    }, this.#b.jobMs);
    slot.worker.postMessage(p.job);
  }

  #drain(): void {
    for (const slot of this.#slots) {
      if (slot.pending || !slot.ready) continue;
      const next = this.#queue.shift();
      if (!next) return;
      this.#start(slot, next);
    }
  }

  /** Resolves once every worker is online, or the pool has given up or closed. */
  async ready(): Promise<void> {
    while (!this.#closed && this.#slots.some((s) => !s.ready)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Runs one estimate, or says at once why it can't. Never rejects. If `gone` aborts
   * while the job still waits for a worker (its client left), the job is dropped: it
   * would only hold a worker for an answer nobody reads. A running job finishes.
   */
  submit(job: Omit<Job, 'id'>, gone?: AbortSignal): Promise<Done> {
    const now = Date.now();
    const busy = (code: 'SERVER_BUSY' | 'SCOPE_BUSY'): Promise<Done> =>
      Promise.resolve({ outcome: { kind: 'error', code }, queueMs: 0, runMs: 0 });
    if (this.#broken) {
      return Promise.resolve({
        outcome: { kind: 'error', code: 'INTERNAL' },
        queueMs: 0,
        runMs: 0,
      });
    }
    if (this.#closed) return busy('SERVER_BUSY');
    // Its client already left: nothing to queue for.
    if (gone?.aborted) return busy('SERVER_BUSY');
    if ((this.#perScope.get(job.scope) ?? 0) >= this.#b.perScope) return busy('SCOPE_BUSY');
    const idle = this.#slots.find((s) => s.ready && !s.pending);
    if (!idle && this.#queue.length >= this.#b.queue) return busy('SERVER_BUSY');

    this.#perScope.set(job.scope, (this.#perScope.get(job.scope) ?? 0) + 1);
    return new Promise<Done>((resolve) => {
      const p: Pending = {
        job: { ...job, id: this.#nextId++ },
        queuedAt: now,
        startedAt: now,
        resolve,
        timer: undefined,
      };
      if (idle) {
        this.#start(idle, p);
        return;
      }
      const unqueue = (): void => {
        const at = this.#queue.indexOf(p);
        if (at === -1) return;
        this.#queue.splice(at, 1);
        clearTimeout(p.timer);
        this.#release(job.scope);
        resolve({
          outcome: { kind: 'error', code: 'SERVER_BUSY' },
          queueMs: Date.now() - now,
          runMs: 0,
        });
      };
      p.timer = setTimeout(unqueue, this.#b.queueMs);
      gone?.addEventListener('abort', () => {
        if (this.#queue.includes(p)) this.#event('job-dropped');
        unqueue();
      });
      this.#queue.push(p);
    });
  }

  /**
   * Stops taking work and ends the workers. Anything queued or still running answers
   * `code`: SERVER_BUSY on a stop (the caller may retry), INTERNAL when the pool gave up.
   * No request is left without an answer.
   */
  async close(code: 'SERVER_BUSY' | 'INTERNAL' = 'SERVER_BUSY'): Promise<void> {
    this.#closed = true;
    for (const p of this.#queue.splice(0)) {
      clearTimeout(p.timer);
      this.#release(p.job.scope);
      p.resolve({ outcome: { kind: 'error', code }, queueMs: 0, runMs: 0 });
    }
    for (const slot of this.#slots) {
      if (slot.pending) this.#finish(slot, { kind: 'error', code });
    }
    await Promise.all(this.#slots.map((s) => s.worker.terminate()));
  }
}
