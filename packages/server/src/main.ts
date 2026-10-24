// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * The server's entry point, run by systemd with socket activation (ADR-0040, ADR-0045):
 * `node main.js`. It refuses to start unless systemd passed it exactly one listening
 * socket, meant for this process (LISTEN_FDS=1, LISTEN_PID = its pid). It never creates
 * a socket and never binds a port, so there is no fallback to fall into.
 *
 * Also required:
 * - WP_GCODE_BUILD: ADR-0044's `build` (1-128 printable ASCII);
 * - $CREDENTIALS_DIRECTORY/log-key: the log's HMAC secret, at least 32 bytes
 *   (systemd's LoadCredential=, from a root-only file).
 * Optional: WP_GCODE_WORKERS, 1 to 16 (default 2).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BUDGETS } from './budgets.js';
import { ResponseCache } from './cache.js';
import { BUILD } from './contract.js';
import { createEstimateServer } from './http.js';
import { Logger, MIN_SECRET_BYTES } from './log.js';
import { WorkerPool } from './pool.js';

/** systemd passes sockets from fd 3 (SD_LISTEN_FDS_START). */
const SD_LISTEN_FDS_START = 3;

function refuse(why: string): never {
  process.stderr.write(`woodpatch-gcode-server: not starting: ${why}\n`);
  process.exit(1);
}

const env = process.env;
if (env['LISTEN_PID'] !== String(process.pid)) {
  refuse('no socket from systemd for this process (LISTEN_PID); it never opens one itself');
}
if (env['LISTEN_FDS'] !== '1') refuse('systemd must pass exactly one socket (LISTEN_FDS=1)');
// sd_listen_fds() unsets these, so nothing started from here inherits them.
delete env['LISTEN_PID'];
delete env['LISTEN_FDS'];
delete env['LISTEN_FDNAMES'];

const build = env['WP_GCODE_BUILD'] ?? '';
if (!BUILD.test(build)) refuse('WP_GCODE_BUILD must be 1-128 printable ASCII characters');

const credentials = env['CREDENTIALS_DIRECTORY'];
if (!credentials) refuse('no credentials directory (LoadCredential=log-key:...)');
let secret: Buffer;
try {
  secret = readFileSync(join(credentials, 'log-key'));
} catch {
  refuse('the log-key credential could not be read');
}
if (secret.length < MIN_SECRET_BYTES)
  refuse(`the log key must be at least ${MIN_SECRET_BYTES} bytes`);

const workersText = env['WP_GCODE_WORKERS'];
const workers = workersText === undefined ? DEFAULT_BUDGETS.workers : Number(workersText);
if (!Number.isInteger(workers) || workers < 1 || workers > 16) {
  refuse('WP_GCODE_WORKERS must be a whole number from 1 to 16');
}
const budgets = { ...DEFAULT_BUDGETS, workers };

const logger = new Logger(secret, (line) => process.stdout.write(`${line}\n`));
secret.fill(0);
const pool = new WorkerPool(new URL('./worker.js', import.meta.url), budgets, (name, fields) => {
  logger.event(name, fields);
  // Workers that can't start: exit, so systemd restarts us under its start limits.
  if (name === 'workers-failing') process.exit(1);
});
const cache = new ResponseCache(budgets.cacheEntries, budgets.cacheBytes);
const server = createEstimateServer({ pool, logger, cache, budgets, build });

server.on('error', () => {
  logger.event('server-error');
  process.exit(1);
});
// Listen once the workers are up: systemd holds connections on the socket until then.
void pool
  .ready()
  .then(() => server.listen({ fd: SD_LISTEN_FDS_START }, () => logger.event('start', { workers })));

// A stop: no new connections; what's in flight finishes (or answers SERVER_BUSY), then
// the workers end. The outer bound is every budget in turn, plus a margin.
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  logger.event('stop');
  const limit = budgets.requestMs + budgets.queueMs + budgets.jobMs + 5_000;
  setTimeout(() => process.exit(0), limit).unref();
  server.close(() => {
    void pool.close().then(() => process.exit(0));
  });
  server.closeIdleConnections();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// Never a message or a stack: either may quote a request (ADR-0044). systemd restarts it.
process.on('uncaughtException', () => {
  logger.event('fatal');
  process.exit(1);
});
process.on('unhandledRejection', () => {
  logger.event('fatal');
  process.exit(1);
});
