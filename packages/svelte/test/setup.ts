// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

// jsdom lays nothing out, and lacks the Range geometry CodeMirror measures with.
// Empty rectangles are enough: the tests check content and state, not positions.
const empty = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
// The package checks run in the node environment, which has no Range at all.
if (typeof Range !== 'undefined') {
  Range.prototype.getClientRects ??= () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => ({ ...empty(), toJSON: empty }) as DOMRect;
}
