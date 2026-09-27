// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// Markdown helpers for the generated reports (docs/PARITY.md).
'use strict';

/**
 * Makes any value safe inside a Markdown table cell. Backslashes are escaped FIRST:
 * escaping `|` alone turned a value ending in `\` into `\\|`, which Markdown reads as
 * a literal backslash followed by a column break, so the table fell apart (CodeQL
 * js/incomplete-sanitization). Line breaks would end the row, so they become spaces.
 */
function cell(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

module.exports = { cell };
