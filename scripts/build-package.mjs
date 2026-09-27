// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Builds one publishable package. Run from the package directory (each
// package's `build` script calls this), so every package builds the same way.
//
//   1. esbuild bundles src/index.ts to dist/index.js (ESM) with the MIT legal
//      banner prepended.
//   2. tsc emits the .d.ts declarations.
//   3. The repo-root LICENSE and NOTICE are copied into the package, so the
//      published tarball carries them. npm packs only files inside the package
//      directory, so the root copies would not travel otherwise.
//
// WHY THE BANNER. MIT's single condition is that the copyright and permission
// notice go with "all copies or substantial portions of the Software", and that
// includes built and minified artefacts, not just source (NOTICE, ADR-0009). The
// banner is generated from LICENSE itself, so it can never drift from it. It
// uses the `/*!` legal-comment form, which esbuild, terser and most minifiers
// keep when configured to preserve legal comments. scripts/check-package-licences.mjs
// proves in CI that it survives.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenceBanner } from './licence-banner.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = process.cwd();
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

rmSync(join(pkgDir, 'dist'), { recursive: true, force: true });

// Entry points: `woodpatch.entries` in package.json (default: just "index"), each
// src/<name>.ts → dist/<name>.js. Runtime and peer dependencies stay EXTERNAL: a
// package must never carry its own copy of three.js or of another toolkit package,
// or a host app would ship two (plan §4.1).
const entries = pkg.woodpatch?.entries ?? ['index'];
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
].flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: Object.fromEntries(entries.map((e) => [e, join(pkgDir, `src/${e}.ts`)])),
  outdir: join(pkgDir, 'dist'),
  external,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  banner: { js: licenceBanner(pkg.name) },
  // Keep any legal comments from our own sources in place as well.
  legalComments: 'inline',
  logLevel: 'warning',
});

// Declarations only; esbuild already produced the JavaScript.
execFileSync(
  join(repoRoot, 'node_modules/.bin/tsc'),
  ['-p', 'tsconfig.build.json', '--emitDeclarationOnly'],
  { cwd: pkgDir, stdio: 'inherit' },
);

for (const file of ['LICENSE', 'NOTICE']) {
  copyFileSync(join(repoRoot, file), join(pkgDir, file));
}

console.log(`built ${pkg.name}`);
