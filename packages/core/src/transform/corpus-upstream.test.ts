// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { CORPUS, corpusSuite } from '../../test/transform-corpus.js';

// Transform corpus: the real jobs other than the largest (see test/transform-corpus.ts).
corpusSuite(CORPUS.filter(([f]) => !f.startsWith('synthetic/') && !f.includes('aztec')));
