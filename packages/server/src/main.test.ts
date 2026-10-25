// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));
if (!existsSync(MAIN)) throw new Error('build the server first: pnpm build');
vi.setConfig({ testTimeout: 30_000 });

const dir = mkdtempSync(join(tmpdir(), 'gcode-main-'));
const creds = join(dir, 'creds');
const shortCreds = join(dir, 'short');
for (const [d, n] of [
  [creds, 32],
  [shortCreds, 31],
] as const) {
  spawnSync('mkdir', ['-p', d]);
  writeFileSync(join(d, 'log-key'), Buffer.alloc(n, 1));
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const GOOD_ENV = { WP_GCODE_BUILD: 'test-1', CREDENTIALS_DIRECTORY: creds };

/**
 * Runs main.js with LISTEN_PID set to its own pid (a shell that execs it keeps the pid),
 * so the startup checks after it can be tested without a socket.
 */
function runAsActivated(
  env: Record<string, string>,
  fd3: 'ignore' | 'pipe' | number = 'ignore',
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-c', `LISTEN_PID=$$ exec "${process.execPath}" "${MAIN}"`], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe', fd3],
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('main.js refuses to start', () => {
  it('without a socket from systemd for this very process', () => {
    const none = spawnSync(process.execPath, [MAIN], { env: GOOD_ENV, encoding: 'utf8' });
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/LISTEN_PID/);
    // A LISTEN_PID for another process (systemd's rule: ignore it).
    const other = spawnSync(process.execPath, [MAIN], {
      env: { ...GOOD_ENV, LISTEN_PID: '1', LISTEN_FDS: '1' },
      encoding: 'utf8',
    });
    expect(other.status).toBe(1);
    expect(other.stderr).toMatch(/LISTEN_PID/);
  });

  it('unless exactly one socket is passed', () => {
    for (const fds of ['0', '2', '']) {
      const r = runAsActivated({ ...GOOD_ENV, LISTEN_FDS: fds });
      expect(r.status, fds).toBe(1);
      expect(r.stderr).toMatch(/LISTEN_FDS=1/);
    }
  });

  it('without a valid build, log key or worker count', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ CREDENTIALS_DIRECTORY: creds }, /WP_GCODE_BUILD/],
      [{ ...GOOD_ENV, WP_GCODE_BUILD: 'has space' }, /WP_GCODE_BUILD/],
      [{ WP_GCODE_BUILD: 'b' }, /credentials directory/],
      [{ ...GOOD_ENV, CREDENTIALS_DIRECTORY: join(dir, 'missing') }, /could not be read/],
      [{ ...GOOD_ENV, CREDENTIALS_DIRECTORY: shortCreds }, /at least 32 bytes/],
      [{ ...GOOD_ENV, WP_GCODE_WORKERS: '0' }, /WP_GCODE_WORKERS/],
      [{ ...GOOD_ENV, WP_GCODE_WORKERS: '1.5' }, /WP_GCODE_WORKERS/],
      [{ ...GOOD_ENV, WP_GCODE_HEAP_MB: '32' }, /WP_GCODE_HEAP_MB/],
      [{ ...GOOD_ENV, WP_GCODE_HEAP_MB: 'lots' }, /WP_GCODE_HEAP_MB/],
      [{ ...GOOD_ENV, WP_GCODE_YOUNG_MB: '2048' }, /WP_GCODE_YOUNG_MB/],
    ];
    for (const [env, message] of cases) {
      const r = runAsActivated({ ...env, LISTEN_FDS: '1' });
      expect(r.status, JSON.stringify(env)).toBe(1);
      expect(r.stderr).toMatch(message);
    }
  });

  it('when fd 3 is no listening socket: closed, a regular file, or a pipe', () => {
    const file = join(dir, 'not-a-socket');
    writeFileSync(file, '');
    const fd = openSync(file, 'r');
    try {
      for (const fd3 of ['ignore', fd, 'pipe'] as const) {
        const r = runAsActivated({ ...GOOD_ENV, LISTEN_FDS: '1' }, fd3);
        expect(r.status, String(fd3)).toBe(1);
        expect(r.stderr).not.toMatch(/at |Error/);
        expect(r.stdout).not.toMatch(/"start"/);
      }
    } finally {
      closeSync(fd);
    }
  });
});

// systemd's own tool for running a socket-activated service by hand.
const ACTIVATE = spawnSync('sh', ['-c', 'command -v systemd-socket-activate'], {
  encoding: 'utf8',
}).stdout.trim();
// CI's runners have it; a developer machine without systemd skips, and says so.
const hasActivate = ACTIVATE !== '' || process.env['CI'] !== undefined;

describe.skipIf(!hasActivate)('main.js under socket activation', () => {
  it('serves /estimate on the socket it is given, and stops cleanly on SIGTERM', async () => {
    const sock = join(dir, 'gcode.sock');
    const child = spawn(
      ACTIVATE,
      [
        '-l',
        sock,
        '-E',
        'WP_GCODE_BUILD=test-1',
        '-E',
        `CREDENTIALS_DIRECTORY=${creds}`,
        process.execPath,
        MAIN,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const out: string[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));

    const record = readFileSync(
      new URL('../../db-schema/examples/example-router.json', import.meta.url),
      'utf8',
    );
    const body = JSON.stringify({ v: 1, scope: 'staff:1', gcode: 'G0 X1\nM30\n', machine: record });
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          socketPath: sock,
          method: 'POST',
          path: '/estimate',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).build).toBe('test-1');

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    const events = out
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event);
    expect(events).toEqual(['start', 'request', 'stop']);
  });

  it('runs its workers with the heap the units set', async () => {
    // A 64 MB heap (the least allowed) can't hold this program: if the setting reached the
    // workers, the estimate runs out of heap; at the default 1.5 GB it would succeed.
    const sock = join(dir, 'heap.sock');
    const env = ['-E', 'WP_GCODE_BUILD=test-1', '-E', `CREDENTIALS_DIRECTORY=${creds}`];
    const heap = ['-E', 'WP_GCODE_HEAP_MB=64', '-E', 'WP_GCODE_YOUNG_MB=8'];
    const child = spawn(ACTIVATE, ['-l', sock, ...env, ...heap, process.execPath, MAIN], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    for (let i = 0; i < 100 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
    const record = readFileSync(
      new URL('../../db-schema/examples/example-router.json', import.meta.url),
      'utf8',
    );
    const gcode = 'G1 X1 Y1 F1000\nG1 X2 Y2\n'.repeat(600_000);
    const body = JSON.stringify({ v: 1, scope: 'staff:1', gcode, machine: record });
    const status = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          socketPath: sock,
          method: 'POST',
          path: '/estimate',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve(JSON.parse(Buffer.concat(chunks).toString()).error?.code ?? 'ok'),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe('ESTIMATE_BUDGET_EXCEEDED');
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    const start = out
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((l) => l.event === 'start');
    expect(start).toMatchObject({ workers: 2, heapMb: 64, youngMb: 8 });
  });

  it('refuses a TCP socket, which is no part of ADR-0040', async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const env = ['-E', 'WP_GCODE_BUILD=test-1', '-E', `CREDENTIALS_DIRECTORY=${creds}`];
    const child = spawn(ACTIVATE, ['-l', `127.0.0.1:${port}`, ...env, process.execPath, MAIN], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: string[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c.toString()));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    // systemd-socket-activate starts the service on the first connection.
    for (let i = 0; i < 50; i++) {
      const ok = await new Promise<boolean>((r) => {
        const c = connect(port, '127.0.0.1', () => r(true)).on('error', () => r(false));
        c.on('connect', () => c.destroy());
      });
      if (ok) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await exited).toBe(1);
    const events = out
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event);
    expect(events).toEqual(['not-a-unix-socket']);
  });
});
