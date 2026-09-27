// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { CORPUS, corpusSuite } from '../../test/transform-corpus.js';

// Transform corpus: the synthetic fixtures (every awkward case the analysis found).
corpusSuite(CORPUS.filter(([f]) => f.startsWith('synthetic/') || f.startsWith('transform/')));
