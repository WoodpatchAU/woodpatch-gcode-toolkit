// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { licenceBanner } from '../../../scripts/licence-banner.mjs';

// Parcel 3e (ADR-0030): the package's own guarantees, checked mechanically. The
// three conditions of its review are the first three blocks.

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(pkgDir, f), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  name: string;
  scripts: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  svelte: string;
  sideEffects: string[];
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const srcFiles = readdirSync(join(pkgDir, 'src')).filter((f) => !f.includes('.test.'));
const svelteFiles = srcFiles.filter((f) => f.endsWith('.svelte'));

describe('ships source, never built output', () => {
  it('has no build step and no dist', () => {
    expect(pkg.scripts['build']).toBeUndefined();
    expect(pkg.scripts['prepare']).toBeUndefined();
    expect(pkg.scripts['prepack']).toBeUndefined();
    expect(existsSync(join(pkgDir, 'dist'))).toBe(false);
  });

  it('points every entry at src, and publishes only src, LICENSE and NOTICE', () => {
    const values = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : Object.values(v as object).flatMap(values);
    const targets = [...values(pkg.exports), pkg.svelte, ...pkg.sideEffects];
    expect(targets.length).toBeGreaterThan(3);
    for (const path of targets) expect(path).toMatch(/^\.\/src\//);
    expect(pkg.files).toEqual(['src', '!src/**/*.test.*', 'LICENSE', 'NOTICE']);
  });

  it('holds only source in src: components, plain JS and hand-written types', () => {
    for (const f of srcFiles) expect(f).toMatch(/\.(svelte|js|d\.ts)$/);
    expect(svelteFiles.length).toBeGreaterThan(0);
  });
});

describe('the peer floor', () => {
  it('is the Svelte the package is tested and type-checked against', () => {
    const floor = /^\^(\d+\.\d+\.\d+)$/.exec(pkg.peerDependencies['svelte'] ?? '')?.[1];
    expect(floor).toBeDefined();
    expect(pkg.devDependencies['svelte']).toBe(floor);
    const require = createRequire(join(pkgDir, 'package.json'));
    const installed = (require('svelte/package.json') as { version: string }).version;
    expect(installed).toBe(floor);
  });
});

describe('the MIT notice in every file', () => {
  const banner = licenceBanner(pkg.name);
  const REQUIRED = ['Nicolas Raynaud', 'Permission is hereby granted, free of charge'];

  it.each([...srcFiles.filter((f) => !f.endsWith('.d.ts'))])(
    '%s carries the current banner, generated from LICENSE',
    (f) => {
      const text = read(`src/${f}`);
      const indent = /^([ \t]*)\/\*!/m.exec(text)?.[1] ?? '';
      // Stale or missing: node scripts/stamp-source-banners.mjs packages/svelte
      expect(text).toContain(banner.split('\n').join(`\n${indent}`));
    },
  );

  // Where the banner sits matters (ADR-0030). Svelte drops comments in a
  // <script module>. A bundler keeps a comment only with the statement after it, and
  // tree-shakes an unused one (Vite 6's Rollup lost a banner that preceded an unused
  // declaration). So the banner is on the component's onMount call, which is never
  // removed.
  it.each(svelteFiles)('%s puts it on the onMount call, which no bundler removes', (f) => {
    const { js } = compile(read(`src/${f}`), { generate: 'client', filename: f });
    const end = js.code.indexOf('*/', js.code.indexOf('/*!'));
    expect(js.code.slice(end + 2).trimStart()).toMatch(/^(\$\.)?onMount\(/);
  });

  // Then a minified bundle keeps it in both of esbuild's legal-comment modes. Vite 8
  // needs `output.comments.legal` for the same (the consuming apps' setting, ADR-0009).
  it.each(svelteFiles)('%s keeps it through the Svelte compiler and a minifier', async (f) => {
    for (const generate of ['client', 'server'] as const) {
      const { js } = compile(read(`src/${f}`), { generate, filename: f });
      for (const s of REQUIRED) expect(js.code, `${generate}: ${s}`).toContain(s);
      for (const legalComments of ['inline', 'eof'] as const) {
        const out = await build({
          stdin: { contents: js.code, resolveDir: pkgDir, loader: 'js' },
          bundle: true,
          minify: true,
          format: 'esm',
          write: false,
          legalComments,
          external: ['@woodpatch/*', '@codemirror/*', 'three', '*.svelte'],
          logLevel: 'silent',
        });
        const text = out.outputFiles.map((o) => o.text).join('');
        for (const s of REQUIRED) expect(text, `${generate}/${legalComments}: ${s}`).toContain(s);
      }
    }
  });
});

describe('loads nothing heavy until mounted', () => {
  // three.js, CodeMirror and the toolkit's own packages must only be imported
  // dynamically, on mount. A static import would put them in a prerendered page's
  // shell, and run them during server rendering (plan §4.9).
  // Static `import … from`, bare `import '…'`, and re-exports (`export … from`).
  const staticImports = (code: string) =>
    [...code.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    );

  it.each(svelteFiles)('%s imports only svelte and sibling components statically', (f) => {
    const { js } = compile(read(`src/${f}`), { generate: 'client', filename: f });
    for (const spec of staticImports(js.code))
      expect(spec).toMatch(/^(svelte(\/[\w/-]+)?|\.\/\w+\.svelte)$/);
  });

  it('index.js re-exports the components and nothing else', () => {
    const specs = staticImports(read('src/index.js'));
    expect(specs).toHaveLength(3); // the matcher really sees the re-exports
    for (const spec of specs) expect(spec).toMatch(/^\.\/\w+\.svelte$/);
  });

  it('index.d.ts declares the same components as index.js', () => {
    const names = (s: string) => [...s.matchAll(/default as (\w+)/g)].map((m) => m[1]).sort();
    expect(names(read('src/index.d.ts'))).toEqual(names(read('src/index.js')));
  });
});
