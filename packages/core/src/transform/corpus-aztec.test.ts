// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { CORPUS, corpusSuite } from '../../test/transform-corpus.js';

// Transform corpus: the 224k-line sample, in a file of its own so it runs in parallel.
corpusSuite(CORPUS.filter(([f]) => f.includes('aztec')));
