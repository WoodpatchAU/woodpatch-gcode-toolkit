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
