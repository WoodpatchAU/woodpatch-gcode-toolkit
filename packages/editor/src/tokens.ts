// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { tokenizeLine, type Token } from '@woodpatch/gcode-core';

/** A styled range within one line: [from, to) in UTF-16 units, and a CSS class. */
export interface StyleSpan {
  readonly from: number;
  readonly to: number;
  readonly cls: string;
}

/** Word letters by role. Anything else (P, Q, L, D, H, E, …) is a parameter word. */
const LETTER_CLASS: Readonly<Record<string, string>> = {
  G: 'gc-g',
  M: 'gc-m',
  X: 'gc-axis',
  Y: 'gc-axis',
  Z: 'gc-axis',
  A: 'gc-axis',
  B: 'gc-axis',
  C: 'gc-axis',
  I: 'gc-centre',
  J: 'gc-centre',
  K: 'gc-centre',
  R: 'gc-centre',
  F: 'gc-feed',
  S: 'gc-speed',
  T: 'gc-tool',
  N: 'gc-lineno',
};

function spansOf(t: Token): StyleSpan[] {
  const { start, end } = t.span;
  switch (t.kind) {
    case 'word': {
      const out: StyleSpan[] = [
        { from: start, to: end, cls: LETTER_CLASS[t.letter] ?? 'gc-param' },
      ];
      // An expression value ([1+2], #1, SIN[30]) is also marked, so it reads as computed.
      if (t.value?.kind === 'expression')
        out.push({ from: t.value.span.start, to: t.value.span.end, cls: 'gc-expr' });
      return out;
    }
    case 'comment':
      return [{ from: start, to: end, cls: 'gc-comment' }];
    case 'assignment':
      return [{ from: start, to: end, cls: 'gc-assign' }];
    case 'oword':
      return [{ from: start, to: end, cls: 'gc-oword' }];
    case 'argument':
      return [{ from: start, to: end, cls: 'gc-expr' }];
    case 'message':
      return [{ from: start, to: end, cls: 'gc-message' }];
    case 'block-delete':
      return [{ from: start, to: end, cls: 'gc-blockdelete' }];
    case 'percent':
      return [{ from: start, to: end, cls: 'gc-percent' }];
    case 'checksum':
      return [{ from: start, to: end, cls: 'gc-checksum' }];
  }
}

/**
 * The styled spans of one line, from the CORE's tokenizer (ADR-0027): the editor
 * colours exactly what the interpreter will read, so the two can never disagree.
 *
 * Public, so it's bounded and guarded itself (reviewer, toolkit #21): only the first
 * `maxChars` characters are tokenized, and a tokenizer failure returns no spans rather
 * than throwing. A pathological line (e.g. "X" and 100,000 "-") would otherwise
 * overflow the core tokenizer's stack; a tracked follow-up in the core.
 */
export function lineSpans(text: string, maxChars = 2000): StyleSpan[] {
  try {
    return tokenizeLine(text.slice(0, maxChars), 1).tokens.flatMap(spansOf);
  } catch {
    return [];
  }
}
