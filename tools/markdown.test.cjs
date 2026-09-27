// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cell } = require('./markdown.cjs');

/** Splits one Markdown table row into cells, as a renderer does: `|` not after a `\`. */
function cells(row) {
  const out = [];
  let cur = '';
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && i + 1 < row.length) {
      cur += c + row[++i];
    } else if (c === '|') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.slice(1, -1); // the leading and trailing pipes
}

// Rows are built with no padding around the pipes: the strictest case, where a value's
// trailing backslash sits right against the next delimiter.
const row = (esc, v) => `|${esc(v)}|next|`;
const VALUES = ['plain', 'a|b', 'ends in \\', '\\|', '\\\\|x', 'two\nlines', 42];

test('a value stays in its own cell, whatever it contains', () => {
  for (const v of VALUES) {
    const r = row(cell, v);
    assert.deepEqual(cells(r).length, 2, `${JSON.stringify(v)} → ${r}`);
    assert.equal(cells(r)[1], 'next');
  }
});

test('escaping | alone breaks rows (the CodeQL finding this fixes)', () => {
  const old = (s) => String(s).replace(/\|/g, '\\|');
  // A trailing backslash escapes the delimiter after it: two cells become one.
  assert.equal(cells(row(old, 'ends in \\')).length, 1);
  // An escaped pipe in the value: `\|` becomes `\\|`, a literal backslash, then a break.
  assert.equal(cells(row(old, 'x\\|y')).length, 3);
  for (const v of ['ends in \\', 'x\\|y']) assert.equal(cells(row(cell, v)).length, 2);
});
