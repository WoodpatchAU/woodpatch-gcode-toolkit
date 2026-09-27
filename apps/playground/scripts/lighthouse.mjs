// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Phase 3's Lighthouse gate (parcel 3f-2, ADR-0031; operator decision 2026-09-27):
// the built playground's Lighthouse PERFORMANCE score must be at least 90, as the
// median of three runs (one run is noisy). Lighthouse's defaults are used: mobile
// emulation with simulated throttling, which is what PageSpeed Insights reports.
// Accessibility and best practices are printed but don't gate.
//
//   CHROME_PATH=/path/to/chrome node scripts/lighthouse.mjs    (after `pnpm build`)
//
// CI runs it on the runner's preinstalled Chrome, as the Playwright tests do.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_PERFORMANCE = 90;
const RUNS = 3;
const PORT = 4175;
const URL_ = `http://127.0.0.1:${PORT}/`;

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(app, 'dist/index.html'))) {
  console.error('::error::lighthouse: build the playground first (dist/index.html missing)');
  process.exit(1);
}
if (!process.env.CHROME_PATH) {
  console.error('::error::lighthouse: set CHROME_PATH to a Chrome binary');
  process.exit(1);
}

// Serve the build exactly as it will be deployed.
const server = spawn(
  join(app, 'node_modules/.bin/vite'),
  ['preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] },
);
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(URL_)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`preview server did not start on ${URL_}`);
}

function runOnce() {
  const out = execFileSync(
    join(app, 'node_modules/.bin/lighthouse'),
    [
      URL_,
      '--output=json',
      '--output-path=stdout',
      '--only-categories=performance,accessibility,best-practices',
      '--chrome-flags=--headless=new --no-sandbox',
      // Lighthouse bundles an error reporter (Sentry). It's off in CI today only because
      // CI is non-interactive; say so explicitly, so no environment change can turn on
      // telemetry from this public repo's pipeline (review of toolkit #31).
      '--no-enable-error-reporting',
      '--quiet',
    ],
    { cwd: app, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

const score = (r, c) => Math.round((r.categories[c]?.score ?? 0) * 100);
const METRICS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
];

try {
  await waitForServer();
  const reports = [];
  for (let i = 1; i <= RUNS; i++) {
    const r = runOnce();
    reports.push(r);
    const m = METRICS.map((id) => `${id} ${r.audits[id]?.displayValue ?? '?'}`).join(', ');
    console.log(
      `run ${i}: performance ${score(r, 'performance')}, accessibility ${score(r, 'accessibility')}, ` +
        `best practices ${score(r, 'best-practices')} (Lighthouse ${r.lighthouseVersion}; ${m})`,
    );
    // Name what moved, so a layout-shift regression says where it is.
    const shifts = r.audits['layout-shifts']?.details?.items ?? [];
    for (const s of shifts.slice(0, 5))
      console.log(`  layout shift ${Number(s.score ?? 0).toFixed(3)}: ${s.node?.selector ?? '?'}`);
  }
  reports.sort((a, b) => score(a, 'performance') - score(b, 'performance'));
  const median = reports[Math.floor(RUNS / 2)];
  const perf = score(median, 'performance');
  if (perf < MIN_PERFORMANCE) {
    console.error(
      `::error::Lighthouse performance ${perf} (median of ${RUNS}) is below ${MIN_PERFORMANCE}`,
    );
    // What would help most, from the median run.
    const opportunities = Object.values(median.audits)
      .filter((a) => a.score !== null && a.score < 0.9 && a.details?.type === 'opportunity')
      .map((a) => `  - ${a.title}: ${a.displayValue ?? ''}`);
    if (opportunities.length) console.error(opportunities.join('\n'));
    process.exitCode = 1;
  } else
    console.log(
      `Lighthouse performance ${perf} (median of ${RUNS}): ok (at least ${MIN_PERFORMANCE})`,
    );
} finally {
  stop();
}
