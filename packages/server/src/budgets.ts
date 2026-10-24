// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The server's budgets (ADR-0045). They nest so the innermost gives up first, and nothing
 * is killed mid-write by an outer one (ADR-0040): the server's whole answer comes inside
 * the caller's HTTP timeout, which comes inside its job's, and so on out. The caller's
 * side of the chain is in ADR-0045, with these numbers.
 */

export interface Budgets {
  /** Workers, each running one estimate at a time. */
  readonly workers: number;
  /** Requests waiting for a worker, across all scopes. Past it: SERVER_BUSY. */
  readonly queue: number;
  /** One scope's requests, running and waiting together. Past it: SCOPE_BUSY. */
  readonly perScope: number;
  /** The longest a request waits for a worker before SERVER_BUSY, ms. */
  readonly queueMs: number;
  /** One estimate's wall clock in its worker, ms. Past it the worker is terminated. */
  readonly jobMs: number;
  /** A worker's heap and stack (Node's `resourceLimits`), MB. */
  readonly heapMb: number;
  readonly youngMb: number;
  readonly stackMb: number;
  /** Retry-After on the two busy answers, seconds. */
  readonly busyRetrySeconds: number;
  readonly scopeRetrySeconds: number;
  /** Node's header and whole-request timeouts, ms: a slow sender can't hold a socket. */
  readonly headersMs: number;
  readonly requestMs: number;
  /** How often Node checks the two above (`connectionsCheckingInterval`), ms. */
  readonly checkMs: number;
  /** Cached responses: at most this many, and this many bytes in all. */
  readonly cacheEntries: number;
  readonly cacheBytes: number;
}

export const DEFAULT_BUDGETS: Budgets = Object.freeze({
  workers: 2,
  queue: 8,
  perScope: 2,
  queueMs: 5_000,
  jobMs: 20_000,
  // 2,000,000 steps (core's cap) at a few hundred bytes each, with room to spare.
  heapMb: 1_536,
  youngMb: 64,
  stackMb: 4,
  busyRetrySeconds: 5,
  scopeRetrySeconds: 10,
  // Receiving the request (25 MB over a local socket takes well under a second), with
  // Node checking the timeouts every checkMs. Then parsing, queueMs and jobMs: the whole
  // answer within 10 + 1 + 5 + 5 + 20 = 41 s, inside the caller's 45 s (ADR-0045).
  headersMs: 10_000,
  requestMs: 10_000,
  checkMs: 1_000,
  cacheEntries: 1_000,
  cacheBytes: 64 * 1024 * 1024,
});

/**
 * The request is parsed on the main thread, so the fair share can be applied before any
 * worker is taken. That's linear in the body, and capped by its size: about 0.8 s for a
 * 20 MB program, and 2.1 s for a body that is nearly all JSON escapes (measured on the
 * development host, 2026-10-24). This allows for a slower host.
 */
export const PARSE_ALLOWANCE_MS = 5_000;

/**
 * The longest the server takes to answer one request, from its first byte: receiving it
 * (Node notices a timeout up to checkMs late), parsing, waiting for a worker, running.
 * Per request: big parses queued ahead of it on the main thread come on top, which the
 * in-flight cap (workers + queue) bounds.
 */
export function serverWorstMs(b: Budgets): number {
  return b.requestMs + b.checkMs + PARSE_ALLOWANCE_MS + b.queueMs + b.jobMs;
}

/**
 * The caller's side of the chain (ADR-0045), each strictly longer than the one inside
 * it: the server's worst answer < the HTTP timeout < the queued job's timeout < the
 * queue worker's timeout < the queue's retry-after. The server can't set these; a test
 * checks the chain holds with this file's numbers, and the caller's configuration
 * states them.
 */
export const CALLER_BUDGETS = Object.freeze({
  httpTimeoutMs: 45_000,
  jobTimeoutMs: 60_000,
  workerTimeoutMs: 90_000,
  retryAfterMs: 120_000,
});
