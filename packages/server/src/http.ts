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
import type { Budgets } from './budgets.js';
import type { ResponseCache } from './cache.js';
import { ERRORS, MAX_REQUEST_BYTES, errorBody, parseRequest, type ErrorCode } from './contract.js';
import type { Logger, RequestLog } from './log.js';
import type { WorkerPool } from './pool.js';

export interface ServerParts {
  pool: WorkerPool;
  logger: Logger;
  cache: ResponseCache;
  budgets: Budgets;
  /** ADR-0044's `build`, already checked against its pattern. */
  build: string;
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

/** The body, or 'too-large' as soon as it passes the cap (without reading further). */
function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const onData = (c: Buffer): void => {
      n += c.length;
      if (n > MAX_REQUEST_BYTES) {
        req.off('data', onData);
        req.pause();
        resolve('too-large');
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks, n)));
    req.on('error', reject);
  });
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export function createEstimateServer(parts: ServerParts): Server {
  const { pool, logger, cache, budgets, build } = parts;
  const server = createServer(
    {
      headersTimeout: budgets.headersMs,
      requestTimeout: budgets.requestMs,
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
        send(res, status, JSON.stringify(errorBody(code, MESSAGES[code] ?? 'Error')), extra);
        log.status = status;
        log.code = code;
        // A body past the cap is never read to its end: the connection goes.
        if (closeAfter) res.on('finish', () => req.destroy());
      };
      handle(req, res, log, fail)
        .catch(() => {
          if (!res.headersSent) fail('INTERNAL');
          else res.destroy();
        })
        .finally(() => logger.request(log));
    },
  );

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    log: RequestLog,
    fail: (code: ErrorCode, closeAfter?: boolean) => void,
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

    const body = await readBody(req);
    if (body === 'too-large') return fail('REQUEST_TOO_LARGE', true);
    log.bytes = body.length;
    let text: string;
    try {
      text = decoder.decode(body);
    } catch {
      return fail('REQUEST_MALFORMED');
    }

    const t0 = performance.now();
    const parsed = parseRequest(text);
    log.parseMs = performance.now() - t0;
    if (!parsed.ok) {
      const { status } = ERRORS[parsed.error.error.code];
      send(res, status, JSON.stringify(parsed.error));
      log.status = status;
      log.code = parsed.error.error.code;
      return;
    }
    const { scope, gcode, record, recordHash } = parsed.request;
    log.scope = scope;
    log.gcode = gcode;

    const key = cache.key({ scope, gcode, recordHash, build });
    const hit = cache.get(key);
    if (hit !== undefined) {
      send(res, 200, hit);
      log.status = 200;
      log.cached = true;
      return;
    }

    // The record goes as JSON text: its content hash is of the parsed values, so the
    // worker reads the same record and checks it gets the same hash.
    const done = await pool.submit({
      scope,
      gcode,
      machine: JSON.stringify(record),
      recordHash,
      build,
    });
    log.queueMs = done.queueMs;
    log.runMs = done.runMs;
    if (done.outcome.kind === 'error') return fail(done.outcome.code);
    cache.set(key, done.outcome.body);
    send(res, 200, done.outcome.body);
    log.status = 200;
    log.cached = false;
  }

  return server;
}
