// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Source packages (shipped unbuilt, like @woodpatch/gcode-svelte) carry the MIT banner
// in every source file, because there's no build step to prepend it (ADR-0030). This
// writes the current banner (scripts/licence-banner.mjs, generated from LICENSE) over
// the `/*!BANNER*/` placeholder or the banner already there.
//
//   node scripts/stamp-source-banners.mjs <package-dir>
//
// scripts/check-package-licences.mjs fails CI if any file's banner is missing or stale.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { licenceBanner } from './licence-banner.mjs';

export const SOURCE_FILE = /\.(svelte|js)$/;
export const BANNER_RE = /\/\*!(BANNER\*\/|\n[ \t]* \* @woodpatch\/[\s\S]*?\*\/)/;

export function sourceFiles(dir) {
  return readdirSync(join(dir, 'src'), { recursive: true })
    .map(String)
    .filter((f) => SOURCE_FILE.test(f) && !/\.test\./.test(f))
    .map((f) => join(dir, 'src', f));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = resolve(process.argv[2] ?? '.');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const banner = licenceBanner(pkg.name);
  for (const f of sourceFiles(dir)) {
    const s = readFileSync(f, 'utf8');
    if (!BANNER_RE.test(s)) throw new Error(`${f}: no /*!BANNER*/ placeholder or banner`);
    // In a .svelte file the banner sits indented inside the instance <script>, on the
    // onMount call (ADR-0030); keep its indentation.
    const indent = /^([ \t]*)\/\*!/m.exec(s)?.[1] ?? '';
    const next = s.replace(BANNER_RE, () => banner.split('\n').join(`\n${indent}`));
    if (next !== s) writeFileSync(f, next);
    console.log(`${next === s ? 'current' : 'stamped'} ${f}`);
  }
}
