// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Builds the estimate server's deployable bundle (ADR-0046):
//
//   node build.mjs --out <new dir> [--dev]
//
// One directory, needing nothing but the pinned Node:
//   main.js, worker.js  the server, with core and the record package inlined (no
//                       node_modules), each carrying the MIT legal banner;
//   package.json        { "type": "module" };
//   tripwire.sh         the units' start check;
//   BUILD               gcode-server-<version>+<commit>, ADR-0044's `build`;
//   LICENSE, NOTICE;
//   SHA256SUMS          every other file's SHA-256, for `sha256sum -c`.
//
// Only CI builds a bundle that is installed, from a tagged commit (DEPLOY.md). It refuses
// a working tree with uncommitted changes, unless --dev (for local runs), which marks the
// build "-dev" so it can never pass for a release.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenceBanner } from '../../../scripts/licence-banner.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const REPO = resolve(PKG, '../..');

export async function buildBundle(out, { dev = false } = {}) {
  if (existsSync(out))
    throw new Error(`${out} already exists: the bundle is built into a new directory`);
  const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
  const status = git('status', '--porcelain');
  const dirty = status !== '';
  if (dirty && !dev) {
    // Named, so a CI step that leaves files behind is found at once.
    throw new Error(
      `the working tree has uncommitted changes (pass --dev for a local build):\n${status}`,
    );
  }
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
  const id = `gcode-server-${pkg.version}+${git('rev-parse', '--short=12', 'HEAD')}${dev ? '-dev' : ''}`;

  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: { main: join(PKG, 'src/main.ts'), worker: join(PKG, 'src/worker.ts') },
    outdir: out,
    bundle: true, // core and the record package inlined: nothing to install beside it
    format: 'esm',
    platform: 'node',
    target: 'node22',
    banner: { js: licenceBanner(pkg.name) },
    legalComments: 'inline',
    logLevel: 'warning',
  });
  writeFileSync(
    join(out, 'package.json'),
    `${JSON.stringify({ type: 'module', private: true })}\n`,
  );
  copyFileSync(join(HERE, 'tripwire.sh'), join(out, 'tripwire.sh'));
  chmodSync(join(out, 'tripwire.sh'), 0o755);
  for (const f of ['LICENSE', 'NOTICE']) copyFileSync(join(REPO, f), join(out, f));
  writeFileSync(join(out, 'BUILD'), `${id}\n`);

  const sums = readdirSync(out)
    .sort()
    .map(
      (f) =>
        `${createHash('sha256')
          .update(readFileSync(join(out, f)))
          .digest('hex')}  ${f}`,
    );
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  return id;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i === -1 ? undefined : args[i + 1];
  if (!out) {
    process.stderr.write('usage: build.mjs --out <new dir> [--dev]\n');
    process.exit(1);
  }
  buildBundle(resolve(out), { dev: args.includes('--dev') }).then(
    (id) => process.stdout.write(`built ${id} in ${out}\n`),
    (e) => {
      process.stderr.write(`build: ${e.message}\n`);
      process.exit(1);
    },
  );
}
