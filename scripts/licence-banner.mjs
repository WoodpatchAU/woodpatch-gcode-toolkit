// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The `/*! … */` legal banner every published artefact carries (ADR-0009): the package
// name, the upstream credit, and the full LICENSE text. Generated from LICENSE itself,
// so it can never drift from it. Shared by the build (built packages get it prepended)
// and by the checks on source packages (each .svelte file carries it verbatim).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The `/*! … *\/` banner: package name, upstream credit, and the full LICENSE text.
 * @param {string} packageName
 * @returns {string}
 */
export function licenceBanner(packageName) {
  const licence = readFileSync(join(repoRoot, 'LICENSE'), 'utf8').trimEnd();
  if (licence.includes('*/')) throw new Error('LICENSE text would terminate the banner comment');
  const body = [
    `${packageName}: Woodpatch G-code Toolkit`,
    'Based on webgcode by Nicolas Raynaud (https://github.com/nraynaud/webgcode).',
    '',
    ...licence.split('\n'),
  ];
  return ['/*!', ...body.map((l) => (l ? ` * ${l}` : ' *')), ' */'].join('\n');
}
