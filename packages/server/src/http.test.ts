// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BUDGETS, type Budgets } from './budgets.js';
import { ResponseCache } from './cache.js';
import { MAX_REQUEST_BYTES, parseRequest } from './contract.js';
import { handleEstimate } from './handle.js';
import { createEstimateServer, inFlightCap } from './http.js';
import { Logger } from './log.js';
import { MAX_START_FAILURES, WorkerPool } from './pool.js';

// The workers run the BUILT worker (CI builds before it tests, as for the playground).
const WORKER = new URL('../dist/worker.js', import.meta.url);
// Each test starts workers and runs jobs of up to a few seconds.
vi.setConfig({ testTimeout: 30_000 });
if (!existsSync(WORKER)) throw new Error('build the server first: pnpm build');

const RECORD = readFileSync(
  new URL('../../db-schema/examples/example-router.json', import.meta.url),
  'utf8',
);
const JOB = 'G21 G90\nM3 S12000\nG0 X0 Y0 Z5\nG1 Z-1 F300\nG1 X100 F1500\nM5\nM30\n';
// About a second of interpreting: well past the small job budgets below, well inside 5 s.
const SLOW = 'o100 while [#1 LT 150000]\n#1=[#1+1]\no100 endwhile\nM30\n';
const BUILD = 'test-build-1';
const SECRET = Buffer.alloc(32, 7);

interface Running {
  path: string;
  logs: string[];
  server: Server;
  pool: WorkerPool;
}
const running: Running[] = [];

async function start(over: Partial<Budgets> = {}, build = BUILD): Promise<Running> {
  const budgets = { ...DEFAULT_BUDGETS, workers: 1, heapMb: 256, ...over };
  const dir = mkdtempSync(join(tmpdir(), 'gcode-server-'));
  const path = join(dir, 's.sock');
  const logs: string[] = [];
  const logger = new Logger(SECRET, (l) => logs.push(l));
  const pool = new WorkerPool(WORKER, budgets, (n, f) => logger.event(n, f));
  const cache = new ResponseCache(budgets.cacheEntries, budgets.cacheBytes);
  const server = createEstimateServer({ pool, logger, cache, budgets, build });
  await pool.ready();
  await new Promise<void>((r) => server.listen(path, r));
  const run = { path, logs, server, pool };
  running.push(run);
  return run;
}

afterEach(async () => {
  for (const r of running.splice(0)) {
    await new Promise((res) => r.server.close(res));
    r.server.closeAllConnections();
    await r.pool.close();
    rmSync(join(r.path, '..'), { recursive: true, force: true });
  }
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  path: string,
  o: { method?: string; url?: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath: path,
        method: o.method ?? 'POST',
        path: o.url ?? '/estimate',
        headers: { 'content-type': 'application/json', ...o.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (o.body !== undefined) req.end(o.body);
    else req.end();
  });
}

const body = (gcode: string, scope = 'staff:1') =>
  JSON.stringify({ v: 1, scope, gcode, machine: RECORD });
const code = (r: Reply): string => JSON.parse(r.body).error?.code ?? 'ok';

describe('the HTTP layer', () => {
  it("answers a good request with the handler's response, as JSON that is never cached downstream", async () => {
    const s = await start();
    const r = await send(s.path, { body: body(JOB) });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    const parsed = parseRequest(body(JOB));
    if (!parsed.ok) throw new Error('bad fixture');
    expect(JSON.parse(r.body)).toEqual(
      JSON.parse(JSON.stringify(handleEstimate(parsed.request, BUILD))),
    );
  });

  it('caches per scope: the same request again is a hit, another scope is not', async () => {
    const s = await start();
    const a = await send(s.path, { body: body(JOB) });
    const b = await send(s.path, { body: body(JOB) });
    const c = await send(s.path, { body: body(JOB, 'staff:2') });
    expect(b.body).toBe(a.body);
    expect(c.body).toBe(a.body);
    const cached = s.logs
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === 'request')
      .map((l) => l.cached);
    expect(cached).toEqual([false, true, false]);
  });

  it('refuses another path, method or media type with its code', async () => {
    const s = await start();
    expect(code(await send(s.path, { url: '/other', body: body(JOB) }))).toBe('NOT_FOUND');
    expect(code(await send(s.path, { url: '/estimate?x=1', body: body(JOB) }))).toBe('NOT_FOUND');
    const get = await send(s.path, { method: 'GET' });
    expect([get.status, code(get), get.headers['allow']]).toEqual([
      405,
      'METHOD_NOT_ALLOWED',
      'POST',
    ]);
    for (const type of ['text/plain', 'application/json; charset=latin1', 'application/jsonx']) {
      const r = await send(s.path, { headers: { 'content-type': type }, body: body(JOB) });
      expect([r.status, code(r)], type).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    }
    const ok = await send(s.path, {
      headers: { 'content-type': 'Application/JSON; charset=UTF-8' },
      body: body(JOB),
    });
    expect(ok.status).toBe(200);
  });

  it('refuses a declared length over the cap before reading, and a body that grows past it', async () => {
    const s = await start();
    const declared = await send(s.path, {
      headers: { 'content-length': String(MAX_REQUEST_BYTES + 1) },
    });
    expect([declared.status, code(declared), declared.headers['connection']]).toEqual([
      413,
      'REQUEST_TOO_LARGE',
      'close',
    ]);
    // No declared length (chunked): refused once it passes the cap.
    const big = Buffer.alloc(MAX_REQUEST_BYTES + 1024, 0x20);
    const streamed = await send(s.path, { headers: { 'transfer-encoding': 'chunked' }, body: big });
    expect([streamed.status, code(streamed)]).toEqual([413, 'REQUEST_TOO_LARGE']);
  });

  it("refuses a body that is not UTF-8, and passes the parser's own refusals through", async () => {
    const s = await start();
    // A stray byte inside the G-code's string: a lenient decoder would make it U+FFFD,
    // and estimate a program nobody sent.
    const [head, tail] = body('G0 X1 @').split('@') as [string, string];
    const stray = Buffer.concat([Buffer.from(head), Buffer.from([0xff]), Buffer.from(tail)]);
    const bad = await send(s.path, { body: stray });
    expect([bad.status, code(bad)]).toEqual([400, 'REQUEST_MALFORMED']);
    const v2 = await send(s.path, { body: JSON.stringify({ v: 2 }) });
    expect([v2.status, code(v2)]).toEqual([400, 'REQUEST_VERSION']);
    const rec = await send(s.path, {
      body: JSON.stringify({ v: 1, scope: 'a', gcode: '', machine: '{' }),
    });
    expect([rec.status, code(rec)]).toEqual([422, 'MACHINE_INVALID']);
  });

  it('terminates a job past its budget, answers ESTIMATE_BUDGET_EXCEEDED, and carries on', async () => {
    const s = await start({ jobMs: 100 });
    const slow = await send(s.path, { body: body(SLOW) });
    expect([slow.status, code(slow)]).toEqual([422, 'ESTIMATE_BUDGET_EXCEEDED']);
    const events = s.logs.map((l) => JSON.parse(l).event);
    expect(events).toContain('job-budget-exceeded');
    expect(events).toContain('worker-replaced');
    // The replacement serves the next request.
    expect((await send(s.path, { body: body(JOB) })).status).toBe(200);
  });

  it('answers ESTIMATE_BUDGET_EXCEEDED when a worker runs out of heap', async () => {
    const s = await start({ heapMb: 24, youngMb: 4 });
    const lines = 'G1 X1 Y1 F1000\nG1 X2 Y2\n'.repeat(300_000);
    const r = await send(s.path, { body: body(lines) });
    expect([r.status, code(r)]).toEqual([422, 'ESTIMATE_BUDGET_EXCEEDED']);
    expect(s.logs.map((l) => JSON.parse(l).event)).toContain('worker-out-of-memory');
  });

  /** Sends `first`, then `second` once `first` holds a worker; answers both. */
  async function both(path: string, first: string, second: string): Promise<[Reply, Reply]> {
    const a = send(path, { body: first });
    await new Promise((r) => setTimeout(r, 100));
    const b = send(path, { body: second });
    return [await a, await b];
  }

  it("gives SCOPE_BUSY past a scope's share, with Retry-After", async () => {
    const s = await start({ workers: 2, perScope: 1, jobMs: 5_000 });
    const [a, b] = await both(s.path, body(SLOW), body(JOB));
    expect(a.status).toBe(200);
    expect([b.status, code(b)]).toEqual([429, 'SCOPE_BUSY']);
    expect(b.headers['retry-after']).toBe(String(DEFAULT_BUDGETS.scopeRetrySeconds));
  });

  it('gives SERVER_BUSY when the queue is full, with Retry-After', async () => {
    const s = await start({ workers: 1, queue: 0, jobMs: 5_000 });
    const [a, b] = await both(s.path, body(SLOW, 'staff:a'), body(JOB, 'staff:b'));
    expect(a.status).toBe(200);
    expect([b.status, code(b)]).toEqual([503, 'SERVER_BUSY']);
    expect(b.headers['retry-after']).toBe(String(DEFAULT_BUDGETS.busyRetrySeconds));
  });

  it('gives SERVER_BUSY to a request that waits past queueMs', async () => {
    const s = await start({ workers: 1, queue: 1, queueMs: 50, jobMs: 5_000 });
    const [a, b] = await both(s.path, body(SLOW, 'staff:a'), body(JOB, 'staff:b'));
    expect(a.status).toBe(200);
    expect([b.status, code(b)]).toEqual([503, 'SERVER_BUSY']);
    const waited = s.logs.map((l) => JSON.parse(l)).find((l) => l.code === 'SERVER_BUSY');
    expect(waited.queueMs).toBeGreaterThanOrEqual(50);
  });

  it('answers any throw with INTERNAL and its fixed message only', async () => {
    // An invalid build makes the handler throw in the worker.
    const s = await start({}, 'not a valid build');
    const r = await send(s.path, { body: body(JOB) });
    expect([r.status, JSON.parse(r.body)]).toEqual([
      500,
      { v: 1, error: { code: 'INTERNAL', message: 'The server could not complete this estimate' } },
    ]);
    expect(r.body).not.toMatch(/build|Error|at /);
  });

  it('logs no G-code, no diagnostic, no message and no scope as sent', async () => {
    const s = await start({ jobMs: 100 });
    const scope = 'staff:SECRET-SCOPE';
    // A comment, and a number core quotes back in a diagnostic.
    const gcode = `(SECRET-GCODE)\nG0 X1${' 7'.repeat(40)}\n${JOB}`;
    const ok = await send(s.path, { body: body(gcode, scope) });
    expect(ok.status).toBe(200);
    const diag = JSON.parse(ok.body).diagnostics.items.map((d: { message: string }) => d.message);
    expect(diag.join('')).toContain('7777');
    await send(s.path, { body: body(SLOW, scope) });
    await send(s.path, {
      body: JSON.stringify({ v: 1, scope, gcode: 'SECRET-GCODE', machine: '{' }),
    });
    const all = s.logs.join('\n');
    for (const secret of ['SECRET-SCOPE', 'SECRET-GCODE', '7777', 'record', 'refused']) {
      expect(all, secret).not.toContain(secret);
    }
    // Each line is JSON; a scope appears only as its pseudonym, the same each time.
    const requests = s.logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'request');
    // The last request never parsed, so it has no scope to log.
    const scopes = requests.map((l) => l.scope).filter((x) => x !== undefined);
    expect(scopes).toHaveLength(2);
    expect(new Set(scopes).size).toBe(1);
    expect(requests[0].scope).toMatch(/^[0-9a-f]{16}$/);
    expect(requests[0].gcode).toMatch(/^[0-9a-f]{32}$/);
  });

  it('answers what is still running with SERVER_BUSY when the pool closes', async () => {
    const s = await start({ jobMs: 5_000 });
    const pending = send(s.path, { body: body(SLOW) });
    await new Promise((r) => setTimeout(r, 100));
    await s.pool.close();
    expect(code(await pending)).toBe('SERVER_BUSY');
  });
});

describe('hostile input (ADR-0040, ADR-0045)', () => {
  // Each must answer within its budgets, with a bounded body, and leave the server
  // serving: an estimate, or ESTIMATE_BUDGET_EXCEEDED, never a hang or a crash.
  const JOB_MS = 1_000;
  // Room for a replacement worker to load (about 0.1-0.3 s) before the next request.
  const QUEUE_MS = 2_000;
  const CASES: [string, () => string][] = [
    ['a loop to the iteration cap', () => 'o1 while [1]\n#1=[#1+1]\no1 endwhile\n'],
    [
      'nested loops',
      () => 'o1 repeat [5000]\no2 repeat [5000]\nG1 X[#1] F100\no2 endrepeat\no1 endrepeat\n',
    ],
    ['a canned cycle repeated a million times', () => 'G91 G81 X0.001 Z-1 R1 F100 L1000000\n'],
    ['a peck bomb', () => 'G83 X0 Y0 Z-1000 R1 Q0.00001 F100\n'],
    [
      'a subroutine fan-out',
      () => {
        const subs = Array.from(
          { length: 12 },
          (_, i) =>
            `o${100 + i} sub\n${i < 11 ? `o${101 + i} call\n`.repeat(3) : 'G1 X1 F100\n'}o${100 + i} endsub\n`,
        ).join('');
        return `${subs}o100 call\nM30\n`;
      },
    ],
    ['deep brackets', () => `#1=${'['.repeat(20_000)}1${']'.repeat(20_000)}\n`],
    ['one huge line', () => `G1 X1 F100 ${'(c)'.repeat(5_000_000)}\n`],
    ['a million refused lines', () => 'G1 X1 Q1\n'.repeat(1_000_000)],
    ['many full turns', () => 'G1 X1 F100\nG2 X1 Y0 I-1 J0 P1000000\n'.repeat(1000)],
    [
      'every line a different tool',
      () => Array.from({ length: 200_000 }, (_, i) => `T${i} M6\n`).join(''),
    ],
  ];

  it.each(CASES)('%s', async (_, make) => {
    const s = await start({ jobMs: JOB_MS, queueMs: QUEUE_MS, heapMb: 512 });
    const t0 = Date.now();
    const r = await send(s.path, { body: body(make()) });
    const ms = Date.now() - t0;
    expect(['ok', 'ESTIMATE_BUDGET_EXCEEDED']).toContain(code(r));
    // Parsing (up to 25 MB on the main thread) comes before the worker's budget.
    expect(ms).toBeLessThan(QUEUE_MS + JOB_MS + 5_000);
    expect(Buffer.byteLength(r.body)).toBeLessThan(512 * 1024);
    expect((await send(s.path, { body: body(JOB) })).status).toBe(200);
  });
});

describe('the budget chain (ADR-0045)', () => {
  it('nests: the server answers before every timeout outside it', async () => {
    const { CALLER_BUDGETS, serverWorstMs } = await import('./budgets.js');
    const chain = [
      serverWorstMs(DEFAULT_BUDGETS),
      CALLER_BUDGETS.httpTimeoutMs,
      CALLER_BUDGETS.jobTimeoutMs,
      CALLER_BUDGETS.workerTimeoutMs,
      CALLER_BUDGETS.retryAfterMs,
    ];
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i - 1], `link ${i}`).toBeLessThan(chain[i] as number);
    }
  });

  it('parses the largest bodies within the parse allowance', async () => {
    const { PARSE_ALLOWANCE_MS } = await import('./budgets.js');
    // Ordinary G-code, and a body that is nearly all JSON escapes (the slow case).
    for (const gcode of ['G1 X12.345 Y67.890 F1500\n'.repeat(780_000), '"\\'.repeat(5_000_000)]) {
      const text = body(gcode);
      expect(Buffer.byteLength(text)).toBeLessThan(MAX_REQUEST_BYTES);
      const t0 = performance.now();
      expect(parseRequest(text).ok).toBe(true);
      expect(performance.now() - t0).toBeLessThan(PARSE_ALLOWANCE_MS);
    }
  });
});

describe('a worker that cannot start', () => {
  it('stops respawning after a few, and answers INTERNAL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gcode-bad-worker-'));
    const bad = join(dir, 'worker.mjs');
    writeFileSync(bad, 'throw new Error("broken");\n');
    const events: string[] = [];
    const pool = new WorkerPool(new URL(`file://${bad}`), { ...DEFAULT_BUDGETS, workers: 1 }, (n) =>
      events.push(n),
    );
    // Sent before any worker could load: it waits in the queue, and must not wait forever.
    const job = { scope: 's', gcode: '', machine: '{}', recordHash: '', build: 'b' };
    const waiting = pool.submit(job);
    await pool.ready();
    expect((await waiting).outcome).toEqual({ kind: 'error', code: 'INTERNAL' });
    expect(events.filter((e) => e === 'workers-failing')).toHaveLength(1);
    expect(events.filter((e) => e === 'worker-replaced').length).toBeLessThan(MAX_START_FAILURES);
    const done = await pool.submit({
      scope: 's',
      gcode: '',
      machine: '{}',
      recordHash: '',
      build: 'b',
    });
    expect(done.outcome).toEqual({ kind: 'error', code: 'INTERNAL' });
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/** Opens a raw connection and writes `text`; resolves with everything read until it closes. */
function raw(path: string, text: string): { socket: Socket; reply: Promise<string> } {
  const socket = connect(path);
  const chunks: Buffer[] = [];
  const reply = new Promise<string>((resolve) => {
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', () => {});
  });
  socket.write(text);
  return { socket, reply };
}
const HEADERS_ONLY =
  'POST /estimate HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n';

describe('intake bounds (review of #76)', () => {
  it('cuts off a body that stalls after its headers, at the request timeout', async () => {
    const s = await start({ headersMs: 1_000, requestMs: 1_000, checkMs: 200 });
    const t0 = Date.now();
    const { reply } = raw(s.path, HEADERS_ONLY);
    expect(await reply).toMatch(/^HTTP\/1\.1 408/);
    // requestMs plus at most one check interval, and some slack: never Node's 30 s default.
    expect(Date.now() - t0).toBeLessThan(1_000 + 200 + 1_000);
  });

  it('answers SERVER_BUSY past workers + queue in flight, before reading the body', async () => {
    const s = await start({ workers: 1, queue: 1, jobMs: 5_000 });
    expect(inFlightCap({ ...DEFAULT_BUDGETS, workers: 1, queue: 1 })).toBe(2);
    const a = send(s.path, { body: body(SLOW, 'staff:a') });
    await new Promise((r) => setTimeout(r, 100));
    const b = send(s.path, { body: body(SLOW, 'staff:b') });
    await new Promise((r) => setTimeout(r, 100));
    // The third sends only its headers: it's answered, and closed, without its body.
    const { reply } = raw(s.path, HEADERS_ONLY);
    const third = await reply;
    expect(third).toMatch(/^HTTP\/1\.1 503/);
    expect(third).toMatch(/connection: close/i);
    expect(third).toMatch(/"SERVER_BUSY"/);
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
  });

  it('caps connections a little above the in-flight cap, idle ones included', async () => {
    const s = await start({ workers: 1, queue: 1 });
    expect(s.server.maxConnections).toBe(
      inFlightCap({ ...DEFAULT_BUDGETS, workers: 1, queue: 1 }) + 4,
    );
    const idle = Array.from({ length: s.server.maxConnections }, () => connect(s.path));
    await Promise.all(idle.map((c) => new Promise((r) => c.on('connect', r))));
    await new Promise((r) => setTimeout(r, 50));
    // One more is dropped at once, with no answer.
    const { reply } = raw(s.path, HEADERS_ONLY);
    expect(await reply).toBe('');
    for (const c of idle) c.destroy();
  });

  it('drops a queued job whose client has gone', async () => {
    const s = await start({ workers: 1, queue: 1, jobMs: 5_000 });
    const a = send(s.path, { body: body(SLOW, 'staff:a') });
    await new Promise((r) => setTimeout(r, 100));
    const req = body(JOB, 'staff:b');
    const { socket } = raw(
      s.path,
      `POST /estimate HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`,
    );
    await new Promise((r) => setTimeout(r, 100));
    socket.destroy();
    await a;
    await new Promise((r) => setTimeout(r, 100));
    expect(s.logs.map((l) => JSON.parse(l).event)).toContain('job-dropped');
  });
});
