// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Copies the five reference programs into public/samples/ for the sample picker
// (operator decision, Phase 3): upstream's four samples, which carry upstream's
// licence, plus our own Masso machine-test program. Generated, so it's gitignored.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(app, '../..');
const out = join(app, 'public/samples');
mkdirSync(out, { recursive: true });
const samples = [
  'upstream/tux.ngc',
  'upstream/webgcode.ngc',
  'upstream/test_pycam.ngc',
  'upstream/aztec_calendar.ngc',
  'machine/masso-dialect-test-v1.nc',
];
for (const s of samples) copyFileSync(join(root, 'fixtures', s), join(out, s.split('/')[1]));
writeFileSync(
  join(out, 'NOTICE.txt'),
  [
    'Sample programs',
    '',
    "tux.ngc, webgcode.ngc, test_pycam.ngc and aztec_calendar.ngc are webgcode's own",
    "samples. Copyright (c) 2016 Nicolas Raynaud; MIT OR AGPL-3.0-only (webgcode's",
    'LICENSE.txt). aztec_calendar.ngc credits its origin in its own header.',
    '',
    'masso-dialect-test-v1.nc: Copyright (c) 2026 Promotional Notions Pty Ltd trading as',
    'Woodpatch House & Garden; MIT.',
    '',
  ].join('\n'),
);
console.log(`copied ${samples.length} samples`);
