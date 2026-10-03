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

// The leak cases are built at run time, from a separate "#" and made-up numbers, so this
// public file never contains a reference itself (and passes the check it tests).
const H = '#';
const ORG = 'Woodpatch' + 'AU';

test('refuses references to private work', () => {
  for (const line of [
    `see ${H}1999 here`,
    `see ${H}2001`,
    `Masso O-words refused (${H}1999)`,
    `LinuxCNC dialect: fixes ${H}1999`,
    `upstream behaviour kept, see ${H}1999`,
    `fix for \`${H}1999\``,
    `see '${H}2001'`,
    `G64 P tolerance (${H}1999)`,
    `param ${H}5210 = 0 (${H}1999)`,
    `fixes ${H}5210 today`,
    `https://github.com/${ORG}/some-private-repo`,
    `https://github.com/${ORG.toLowerCase()}/other/pull/3`,
    'something/issues/' + '1999',
    `${ORG}/private-thing${H}1999`,
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
    '  --panel: #232329;',
    "  '.cm-activeLine': { backgroundColor: '#8080800f' },",
    `https://github.com/${ORG}/woodpatch-gcode-toolkit/pull/12`,
    '&#1234; is an entity',
  ])
    assert.equal(leaks(line), false, line);
});
