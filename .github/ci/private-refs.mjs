// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The matcher behind check-private-refs.sh: which lines refer to Woodpatch's private
// work. Reads "where<TAB>text" lines on stdin and prints each `where` that does, once.
//
// Links are unambiguous. Refused: any link into another repository of the organisation
// (all private; deliberately not named here, since this file is public), the
// organisation's owner/repo#NNNN form, and a link to an issue or PR numbered in the
// thousands unless it's on github.com under another owner (an upstream project's).
//
// A bare "#" and 4-5 digits is not: in a G-code toolkit it is also a G-code parameter
// (`#5221`, [#5422 GT -10]) or an upstream project's issue. Six or more digits are
// colours (#232329). So such a number is refused unless IT (not its line) shows which:
// - G-code syntax: inside brackets, followed by a sign or comparison and an operand
//   ([#5422 GT -10], [#5420 * SIN[30]]), or a 5000s parameter closing them ([#5221]);
//   assigned a value (#1000=5); or assigned from another parameter (#100=#5221);
// - an outside project's reference: LinuxCNC or grbl (public trackers that reach four
//   digits) named right before it, "LinuxCNC issues #1528/#2169", or another owner's
//   owner/repo#NNNN;
// - a system parameter (the 5000s) in backticks or quotes, or on a line about G-code.
// Known gaps, accepted in review (so they're deliberate): a private number in the 5000s
// on a line about G-code; glued forms (issue#NNNN, PR#NNNN, a private repo's name glued
// to #NNNN); a fullwidth or zero-width "#", or &#35;; another owner's x/y#NNNN; and a
// private number smuggled into an outside list ("LinuxCNC #1528/#NNNN").
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const NUMBER = /(^|[^0-9A-Za-z&])#([0-9]{4,5})(?![0-9A-Za-z])/g;
const NUMBERED_LINK = /([a-z0-9.-]*\/[^\s/]*\/[^\s/]*)?\/(issues|pull)\/[0-9]{4,}/gi;
const GITHUB_ISSUE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([a-z0-9-]+)\//i;
const ORG_LINK = /github\.com[/:]woodpatchau\/([a-z0-9._-]+)/gi;
const ORG_RAW = /raw\.githubusercontent\.com\/woodpatchau\/([a-z0-9._-]+)/gi;
const OWN_REPO = 'woodpatch-gcode-toolkit';
// An outside project's issue: its name RIGHT BEFORE the number (optionally "issue(s)",
// "PR(s)" or "bug(s)" between), and a "/#NNNN" list continuing it, as in
//   LinuxCNC issues #1528/#2169
// Only projects whose public trackers reach four digits: after any other name, such a
// number can only be ours. A line merely naming the project exempts nothing else on it.
const OUTSIDE_REF = /\b(linuxcnc|grbl)\b(\s+(issues?|prs?|bugs?))?\s+#[0-9]{4,5}(\/#[0-9]{4,5})*/gi;
// The owner/repo#NNNN form.
const REPO_REF = /\b([A-Za-z0-9-]+)\/[A-Za-z0-9._-]+#[0-9]{4,5}/g;
// What may follow a parameter inside an expression: a sign or a comparison.
// ...and an operand after it: a number, a parameter, a bracket or a function (SIN[…]).
const EXPR_NEXT =
  /^\s*([-+*/]|\*\*|(EQ|NE|GT|GE|LT|LE|AND|OR|XOR|MOD)\b)\s*([-+]?[0-9.]|#|\[|[A-Z]+\[)/i;
const ABOUT_GCODE = /\b[GM][0-9]|param|coordinate|offset|\bhome\b|\baxis\b|position/i;

/** Whether one line of text refers to private work. */
export function leaks(text) {
  for (const m of text.matchAll(ORG_LINK))
    if ((m[1] ?? '').toLowerCase().replace(/\.git$/, '') !== OWN_REPO) return true;
  for (const m of text.matchAll(ORG_RAW)) if ((m[1] ?? '').toLowerCase() !== OWN_REPO) return true;
  for (const m of text.matchAll(NUMBERED_LINK)) {
    const owner = GITHUB_ISSUE.exec(m[1] ?? '')?.[1]?.toLowerCase();
    if (owner === undefined || owner === 'woodpatchau') return true;
  }
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
    const hash = (m.index ?? 0) + (m[1] ?? '').length;
    if (outside.some(([from, to]) => hash >= from && hash < to)) continue;
    const before = m[1] ?? '';
    const end = (m.index ?? 0) + m[0].length;
    const rest = text.slice(end);
    const n = Number(m[2]);
    const parameter = n >= 5000 && n <= 5999;
    // In an expression: a sign or comparison follows, or a system parameter closes it.
    if (before === '[' && (EXPR_NEXT.test(rest) || (parameter && /^\s*\]/.test(rest)))) continue;
    // Assigned to: #1000=5. Assigned from another parameter: #100=#5221.
    if (/^\s*=\s*([-+]?[0-9.]|#|\[)/.test(rest)) continue;
    if (before === '=' && /#([0-9]+|<[^>]*>)\s*$/.test(text.slice(0, hash - 1))) continue;
    // Prose writes a parameter, and a reference, in backticks or quotes: only the 5000s.
    if (parameter && ((before !== '' && '`\'"'.includes(before)) || rest[0] === '`')) continue;
    if (parameter && ABOUT_GCODE.test(text)) continue;
    return true;
  }
  return false;
}

// Run as a command (not imported). Compared through realpath, so a path with spaces or
// a symlink (the pre-push hook's copy) can't silently skip the scan (review of #44).
const self = realpathSync(fileURLToPath(import.meta.url));
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (self === invoked) {
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
