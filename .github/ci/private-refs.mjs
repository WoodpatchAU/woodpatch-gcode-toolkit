// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The matcher behind check-private-refs.sh: which lines refer to Woodpatch's private
// work. Reads "where<TAB>text" lines on stdin and prints each `where` that does, once.
//
// A link is unambiguous: one into another repository of the organisation (all private;
// deliberately not named here, since this file is public), or to an issue or PR
// numbered in the thousands.
//
// A bare "#" and 4-5 digits is not: in a G-code toolkit it is also a G-code parameter
// (`#5221`, [#5422 GT -10]) or an upstream project's issue ("LinuxCNC issues #1528"). Six
// or more digits are colours (#232329). So such a number is refused unless IT (not just
// its line) shows it's one of those:
// - it sits in G-code syntax: right after "[" or "=", or right before "=" or "]";
// - it's an outside project's reference: the project named right before it
//   ("LinuxCNC issues #1528/#2169"), or the owner/repo#NNNN form;
// - it's a system parameter number (the 5000s) in backticks or quotes, or on a line
//   about G-code. Backticks and quotes alone don't exempt: prose writes refs that way.
// Known gap, accepted: a private number in the 5000s on a line about G-code passes.
import process from 'node:process';
import { createInterface } from 'node:readline';

const NUMBER = /(^|[^0-9A-Za-z&])#([0-9]{4,5})(?![0-9A-Za-z])/g;
const NUMBERED_LINK = /\/(issues|pull)\/[0-9]{4,}/;
const ORG_LINK = /github\.com\/woodpatchau\/([a-z0-9._-]+)/gi;
const OWN_REPO = 'woodpatch-gcode-toolkit';
// An outside project's issue: its name RIGHT BEFORE the number (optionally "issue(s)",
// "PR(s)" or "bug(s)" between), and a "/#NNNN" list continuing it, as in
//   LinuxCNC issues #1528/#2169
// A line merely naming the project exempts nothing else on it.
const OUTSIDE_REF =
  /\b(linuxcnc|masso|grbl|webgcode)\b(\s+(issues?|prs?|bugs?))?\s+#[0-9]{4,5}(\/#[0-9]{4,5})*/gi;
// The owner/repo#NNNN form, for any owner but the organisation itself.
const REPO_REF = /\b([A-Za-z0-9-]+)\/[A-Za-z0-9._-]+#[0-9]{4,5}/g;
const ABOUT_GCODE = /\b[GM][0-9]|param|coordinate|offset|\bhome\b|\baxis\b|position/i;

/** Whether one line of text refers to private work. */
export function leaks(text) {
  if (NUMBERED_LINK.test(text)) return true;
  for (const m of text.matchAll(ORG_LINK))
    if ((m[1] ?? '').toLowerCase().replace(/\.git$/, '') !== OWN_REPO) return true;
  // Spans of text that are an outside project's own references.
  const outside = [];
  for (const m of text.matchAll(OUTSIDE_REF)) outside.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(REPO_REF)) {
    // The organisation's own owner/repo#NNNN is private work (this repo's numbers are
    // two-digit); any other owner's is an outside project's.
    if ((m[1] ?? '').toLowerCase() === 'woodpatchau') return true;
    outside.push([m.index, m.index + m[0].length]);
  }
  for (const m of text.matchAll(NUMBER)) {
    const at = (m.index ?? 0) + (m[1] ?? '').length; // the '#'
    if (outside.some(([from, to]) => at >= from && at < to)) continue;
    const before = m[1] ?? '';
    const after = text[(m.index ?? 0) + m[0].length] ?? '';
    const n = Number(m[2]);
    const parameter = n >= 5000 && n <= 5999;
    // G-code syntax: "[#5422 …]", "#100=…", "=#5221". Backticks and quotes are how prose
    // writes a reference too, so they only exempt a system parameter (the 5000s).
    if ((before !== '' && '[='.includes(before)) || (after !== '' && '=]'.includes(after)))
      continue;
    if (parameter && ((before !== '' && '`\'"'.includes(before)) || after === '`')) continue;
    if (parameter && ABOUT_GCODE.test(text)) continue;
    return true;
  }
  return false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seen = new Set();
  for await (const line of createInterface({ input: process.stdin })) {
    const tab = line.indexOf('\t');
    const where = tab < 0 ? '' : line.slice(0, tab);
    if (!seen.has(where) && leaks(tab < 0 ? line : line.slice(tab + 1))) {
      seen.add(where);
      process.stdout.write(`${where}\n`);
    }
  }
}
