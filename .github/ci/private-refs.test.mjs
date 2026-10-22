// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The private-refs matcher, both ways: what it must refuse (including every shape the
// review of #44 slipped past an earlier version) and what it must let through (G-code
// parameters, upstream issue references and colours that are on main today).
// Run: node --test .github/ci/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leaks } from './private-refs.mjs';

// The leak cases are built at run time, from a separate "#" and made-up five-digit numbers
// the tracker won't reach for years (a failing assert prints its line in the public log), so this
// public file never contains a reference itself (and passes the check it tests).
const H = '#';
const ORG = 'Woodpatch' + 'AU';

test('refuses references to private work', () => {
  for (const line of [
    `see ${H}99901 here`,
    `see ${H}99902`,
    `Masso O-words refused (${H}99901)`,
    `LinuxCNC dialect: fixes ${H}99901`,
    `upstream behaviour kept, see ${H}99901`,
    `fix for \`${H}99901\``,
    `see '${H}99902'`,
    `G64 P tolerance (${H}99901)`,
    `param ${H}5210 = 0 (${H}99901)`,
    `fixes ${H}5210 today`,
    `https://github.com/${ORG}/some-private-repo`,
    `https://github.com/${ORG.toLowerCase()}/other/pull/3`,
    'something/issues/' + '99901',
    `${ORG}/private-thing${H}99901`,
    // Round 3 of the review: names whose trackers never reach four digits, and syntax
    // that only looks like G-code.
    `Masso ${H}99901 refused`,
    `webgcode issue ${H}99901`,
    `[${H}99901]`,
    `ref=${H}99901`,
    `${H}100=${H}99901`.replace(`${H}100=`, 'x='),
    `git@github.com:${ORG}/private-thing.git`,
    `https://raw.githubusercontent.com/${ORG}/private-thing/main/x`,
    `https://github.com/${ORG}/woodpatch-gcode-toolkit/pull/` + '99901',
    // Paths, as the check feeds them: "/" made a space.
    `docs notes-${H}99901.md`,
    `${H}99901 notes.md`,
    // Round 4: "assigned" to prose, and an operator with no operand after it.
    `${H}99901 = launch prerequisite`,
    `see ${H}99901= notes`,
    `[${H}99901 - relay]`,
    `[${H}99901 + follow-ups]`,
    `[${H}99901 or later]`,
    `[${H}99901 / the guard]`,
  ])
    assert.equal(leaks(line), true, line);
});

test('lets through G-code parameters, outside projects and colours', () => {
  for (const line of [
    '(#38) and #12',
    'o1 while [#5422 GT -10]',
    '#100=#5221',
    '#1000=5 assigns a global',
    'Programs that read or write them (`#5221` and so on) see',
    '  - G28 home #5161; G30 home #5181;',
    ' * - #5221+20(n-1)- coordinate system n.',
    "  it('accepts #5601 and rejects #5602 (RS274NGC_MAX_PARAMETERS is an array size)', () => {",
    "    ['#5602', 'EXPR_PARAMETER_OUT_OF_RANGE'],",
    '  // LinuxCNC issues #1528/#2169: endpoints that (nearly) coincide in the plane are a full circle.',
    'see LinuxCNC/linuxcnc#2169',
    'https://github.com/LinuxCNC/linuxcnc/issues/2169',
    'grbl issue #1234 is upstream',
    '#100=#5221',
    'o1 if [#1000 GT 5]',
    '[#5221]',
    '[#5420 * SIN[30]]',
    '#1000 = 5',
    '#1000=-2.5',
    '  --panel: #232329;',
    "  '.cm-activeLine': { backgroundColor: '#8080800f' },",
    `https://github.com/${ORG}/woodpatch-gcode-toolkit/pull/12`,
    '&#1234; is an entity',
  ])
    assert.equal(leaks(line), false, line);
});

// Dependabot's release notes link each upstream issue as <a href="…/issues/N">#N</a>,
// on redirect.github.com. The link names the owner, so the number is theirs. Built at
// run time like the cases above: the pre-push hook's copy of an older matcher reads
// this file too.
const ISSUES = '/iss' + 'ues/';
const PULL = '/pu' + 'll/';
test("lets through a number that is the text of another owner's link to it", () => {
  const vite = 'https://redirect.github.com/vitejs/vite';
  for (const line of [
    `<li><strong>deps:</strong> update launch-editor (<a href="${vite}${ISSUES}23654">${H}23654</a>) (<a href="https://github.com/vitejs/vite/commit/22fd1d5">22fd1d5</a>)</li>`,
    `<a href="https://github.com/vitejs/vite${PULL}23653">${H}23653</a>`,
    `fixed upstream in [${H}23653](https://github.com/vitejs/vite${PULL}23653)`,
    `${vite}${ISSUES}23654`,
    `(<a href="https://github.com/vitejs/vite/tree/HEAD/packages/vite${ISSUES}23657">${H}23657</a>)</li>`,
    // A URL in backticks, or after a comma, "=" or a colon.
    `see \`https://github.com/vitejs/vite${ISSUES}23654\``,
    `a,https://github.com/vitejs/vite${ISSUES}23654`,
    `url=https://github.com/vitejs/vite${PULL}23653`,
    `see:https://github.com/vitejs/vite${PULL}23653`,
  ])
    assert.equal(leaks(line), false, line);
});

test('still refuses a linked number that is ours, or not what the link says', () => {
  const vite = `https://redirect.github.com/vitejs/vite${ISSUES}23654`;
  const N = '999' + '01'; // built at run time, like H
  for (const line of [
    // The text's number isn't the link's.
    `<a href="${vite}">${H}99901</a>`,
    `[${H}99901](${vite})`,
    // The organisation's own link, on either host.
    `<a href="https://redirect.github.com/${ORG}/x/issues/${N}">${H}99901</a>`,
    `https://redirect.github.com/${ORG.toLowerCase()}/x/pull/3`,
    `<a href="https://github.com/${ORG}/x/tree/HEAD/y/issues/${N}">${H}99901</a>`,
    `(see https://github.com/${ORG.toLowerCase()}/x/tree/main/issues/${N})`,
    `"something/deeper/path/issues/${N}"`,
    // A dot-segment or the organisation's name hidden in the URL (review of #70).
    `https://github.com/vitejs/../${ORG}/x${ISSUES}${N}`,
    `https://github.com/vitejs/%2e%2e/${ORG}/x${ISSUES}${N}`,
    `https://github.com/vitejs/vite${ISSUES}1234?next=/${ORG}/x${ISSUES}${N}`,
    // The exemption covers the link's own #N only, never the rest of the tag.
    `<a href="https://github.com/vitejs/vite${ISSUES}12345" title="${H}99901">${H}12345</a>`,
    `<a href="https://github.com/vitejs/vite${ISSUES}12345 ${H}99901">${H}12345</a>`,
    `[${H}12345](https://github.com/vitejs/vite${ISSUES}12345?q=${H}99901)`,
    // Not GitHub at all.
    `<a href="https://example.com/issues/${N}">${H}99901</a>`,
    // A private number beside a genuine Dependabot link.
    `<a href="${vite}">${H}23654</a> and ${H}99902`,
  ])
    assert.equal(leaks(line), true, line);
});

test('reads a long line in linear time', () => {
  const link = `<a href="https://redirect.github.com/vitejs/vite${ISSUES}23654">${H}23654</a> `;
  const line = link.repeat(2000) + 'x'.repeat(100_000);
  const t0 = performance.now();
  assert.equal(leaks(line), false);
  // An unbroken 200k-character token with links in it: refused, quickly.
  const token = `https://github.com/vitejs/vite${ISSUES}23654`.repeat(5000);
  assert.equal(leaks(token), true);
  assert.ok(performance.now() - t0 < 2000, `took ${performance.now() - t0} ms`);
});
