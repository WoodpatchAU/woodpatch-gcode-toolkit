// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The HTTP layer (ADR-0044, ADR-0045): `POST /estimate`, one JSON body in, one out.
 *
 * Every answer is either a 200 with an estimate or an error body with a code from
 * ADR-0044's closed table. ANY throw on the way becomes INTERNAL with a fixed message:
 * an error's own message or stack may quote the input, so neither is ever sent or logged.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { LARGE_BODY_BYTES, LARGE_IN_FLIGHT, type Budgets } from './budgets.js';
import type { ResponseCache } from './cache.js';
import {
  ERRORS,
  MAX_REQUEST_BYTES,
  errorBody,
  parseRequest,
  utcDay,
  type ErrorCode,
} from './contract.js';
import type { Logger, RequestLog } from './log.js';
import type { WorkerPool } from './pool.js';

export interface ServerParts {
  pool: WorkerPool;
  logger: Logger;
  cache: ResponseCache;
  budgets: Budgets;
  /** ADR-0044's `build`, already checked against its pattern. */
  build: string;
  /**
   * True once the server is stopping: every answer from then on closes its connection,
   * so keep-alive sockets don't hold `server.close()` open until they time out.
   */
  draining?: () => boolean;
  /** The clock, in ms since the epoch: the day decides the calibration age notes. */
  now?: () => number;
}

/** The fixed message for each code the HTTP layer gives itself (the parser words its own). */
const MESSAGES: Partial<Record<ErrorCode, string>> = {
  REQUEST_TOO_LARGE: `The request is over ${MAX_REQUEST_BYTES} bytes`,
  REQUEST_MALFORMED: 'The request is not UTF-8',
  ESTIMATE_BUDGET_EXCEEDED: 'The estimate ran out of time or memory',
  SERVER_BUSY: 'The server is busy: retry after the time given',
  SCOPE_BUSY: 'This scope has its share of the server: retry after the time given',
  METHOD_NOT_ALLOWED: 'Only POST is allowed',
  NOT_FOUND: 'The only path is /estimate',
  UNSUPPORTED_MEDIA_TYPE: 'The body must be application/json in UTF-8',
  INTERNAL: 'The server could not complete this estimate',
};

function send(
  res: ServerResponse,
  status: number,
  body: string,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

/** Only `application/json`, with no charset or `charset=utf-8`. */
function jsonType(header: string | undefined): boolean {
  if (header === undefined) return false;
  const [type, ...params] = header.split(';').map((p) => p.trim().toLowerCase());
  if (type !== 'application/json') return false;
  return params.every((p) => p === 'charset=utf-8' || p === 'charset="utf-8"');
}

/**
 * The body; or 'too-large' as soon as it passes the cap, or 'busy' if it grows past
 * LARGE_BODY_BYTES and `admitLarge` says no. Either way nothing more is read.
 */
function readBody(
  req: IncomingMessage,
  admitLarge: () => boolean,
): Promise<Buffer | 'too-large' | 'busy'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const stop = (why: 'too-large' | 'busy'): void => {
      req.off('data', onData);
      req.pause();
      resolve(why);
    };
    const onData = (c: Buffer): void => {
      const before = n;
      n += c.length;
      if (n > MAX_REQUEST_BYTES) return stop('too-large');
      if (before <= LARGE_BODY_BYTES && n > LARGE_BODY_BYTES && !admitLarge()) return stop('busy');
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks, n)));
    req.on('error', reject);
  });
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Requests in flight, from the moment one arrives: every worker busy, and a full queue. */
export function inFlightCap(b: Budgets): number {
  return b.workers + b.queue;
}

export function createEstimateServer(parts: ServerParts): Server {
  const { pool, logger, cache, budgets, build, draining = () => false, now = Date.now } = parts;
  const reply = (
    res: ServerResponse,
    status: number,
    body: string,
    extra: Record<string, string> = {},
  ): void => send(res, status, body, draining() ? { ...extra, connection: 'close' } : extra);
  const cap = inFlightCap(budgets);
  let inFlight = 0;
  // Large bodies (over LARGE_BODY_BYTES) between arriving and their parse finishing: at
  // most LARGE_IN_FLIGHT, so a request never waits behind more than one other big parse
  // on the main thread (ADR-0045's contended bound).
  let largeInFlight = 0;
  const server = createServer(
    {
      headersTimeout: budgets.headersMs,
      requestTimeout: budgets.requestMs,
      // Node checks both timeouts only this often (30 s by default): without it a slow
      // sender could hold a request for 40 s, not 10, and break the budget chain.
      connectionsCheckingInterval: budgets.checkMs,
    },
    (req, res) => {
      const log: RequestLog = { status: 0, bytes: 0 };
      const fail = (code: ErrorCode, closeAfter = false): void => {
        const { status, retriable } = ERRORS[code];
        const extra: Record<string, string> = {};
        if (retriable) {
          const seconds =
            code === 'SCOPE_BUSY' ? budgets.scopeRetrySeconds : budgets.busyRetrySeconds;
          extra['retry-after'] = String(seconds);
        }
        if (closeAfter) extra['connection'] = 'close';
        reply(res, status, JSON.stringify(errorBody(code, MESSAGES[code] ?? 'Error')), extra);
        log.status = status;
        log.code = code;
        // A body past the cap is never read to its end: the connection goes.
        if (closeAfter) res.on('finish', () => req.destroy());
      };
      // Bounded across connections BEFORE any body is read: otherwise many 25 MB uploads
      // at once would all be buffered and parsed on the main thread, which has no heap
      // limit of its own, and its timers (the job budgets) would run late.
      if (inFlight >= cap) {
        fail('SERVER_BUSY', true);
        logger.request(log);
        return;
      }
      inFlight++;
      // Released exactly once, at the FIRST of the response closing or its socket
      // closing: a response queued behind a pipelined request has no socket of its own,
      // so if the client goes it never closes, and a slot freed only there would leak.
      // A client gone before its answer also drops its job if that's still waiting.
      const gone = new AbortController();
      const socket = req.socket;
      let large = false;
      let released = false;
      const releaseLarge = (): void => {
        if (large) largeInFlight--;
        large = false;
      };
      const release = (): void => {
        if (released) return;
        released = true;
        inFlight--;
        releaseLarge();
        socket.off('close', release);
        if (!res.writableFinished) gone.abort();
      };
      res.once('close', release);
      socket.once('close', release);
      // One listener per request in flight on this socket, so pipelining can't trip
      // Node's listener-leak warning.
      if (socket.getMaxListeners() < cap + 10) socket.setMaxListeners(cap + 10);
      const admitLarge = (): boolean => {
        if (large) return true;
        if (largeInFlight >= LARGE_IN_FLIGHT) return false;
        largeInFlight++;
        large = true;
        return true;
      };
      let clientGone = false;
      handle(req, res, log, fail, gone.signal, admitLarge, releaseLarge)
        .catch(() => {
          // A client that went mid-request isn't an internal error: nobody to answer.
          if (gone.signal.aborted || socket.destroyed) {
            clientGone = true;
            return;
          }
          if (!res.headersSent) fail('INTERNAL');
          else res.destroy();
        })
        .finally(() => (clientGone ? logger.event('client-gone') : logger.request(log)));
    },
  );

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    log: RequestLog,
    fail: (code: ErrorCode, closeAfter?: boolean) => void,
    gone: AbortSignal,
    admitLarge: () => boolean,
    releaseLarge: () => void,
  ): Promise<void> {
    if (req.url !== '/estimate') return fail('NOT_FOUND');
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return fail('METHOD_NOT_ALLOWED');
    }
    if (!jsonType(req.headers['content-type'])) return fail('UNSUPPORTED_MEDIA_TYPE');
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > MAX_REQUEST_BYTES) {
      return fail('REQUEST_TOO_LARGE', true);
    }
    // A declared large body is admitted (or not) before anything is read; a chunked one
    // when it grows past the threshold.
    if (declared !== undefined && Number(declared) > LARGE_BODY_BYTES && !admitLarge()) {
      return fail('SERVER_BUSY', true);
    }

    // From here, every way out that won't parse frees the large slot AT ONCE: its answer
    // may wait behind a pipelined request, and the slot would be held until then.
    const body = await readBody(req, admitLarge);
    if (body === 'too-large') {
      releaseLarge();
      return fail('REQUEST_TOO_LARGE', true);
    }
    if (body === 'busy') return fail('SERVER_BUSY', true);
    log.bytes = body.length;
    let text: string;
    try {
      text = decoder.decode(body);
    } catch {
      releaseLarge();
      return fail('REQUEST_MALFORMED');
    }

    const t0 = performance.now();
    const parsed = parseRequest(text);
    log.parseMs = performance.now() - t0;
    // Its main-thread work is done: another large body may come in.
    releaseLarge();
    if (!parsed.ok) {
      const { status } = ERRORS[parsed.error.error.code];
      reply(res, status, JSON.stringify(parsed.error));
      log.status = status;
      log.code = parsed.error.error.code;
      return;
    }
    const { scope, gcode, record, recordHash } = parsed.request;
    log.scope = scope;
    log.gcode = gcode;

    // Read once, so the cache key and the response are for the same day.
    const today = utcDay(now());
    const key = cache.key({ scope, gcode, recordHash, build, today });
    const hit = cache.get(key);
    if (hit !== undefined) {
      reply(res, 200, hit);
      log.status = 200;
      log.cached = true;
      return;
    }

    // The record goes as JSON text: its content hash is of the parsed values, so the
    // worker reads the same record and checks it gets the same hash.
    const done = await pool.submit(
      { scope, gcode, machine: JSON.stringify(record), recordHash, build, today },
      gone,
    );
    log.queueMs = done.queueMs;
    log.runMs = done.runMs;
    if (done.outcome.kind === 'error') return fail(done.outcome.code);
    cache.set(key, done.outcome.body);
    reply(res, 200, done.outcome.body);
    log.status = 200;
    log.cached = false;
  }

  // A backstop below the in-flight cap's own answer: idle keep-alive connections count
  // too, so a little room above it.
  server.maxConnections = cap + 4;
  return server;
}
