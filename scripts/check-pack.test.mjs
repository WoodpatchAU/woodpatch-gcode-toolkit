// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { URL } from 'node:url';
import {
  checkEntries,
  checkManifest,
  checkMap,
  entryPoints,
  integrity,
  readAllowlist,
} from './check-pack.mjs';

const GOOD = {
  name: '@woodpatch/gcode-core',
  version: '0.1.0',
  license: 'MIT',
  publishConfig: { access: 'public', provenance: true },
  exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
};

describe('checkEntries: the allowlist, exactly', () => {
  const allow = ['package/LICENSE', 'package/dist/index.js', 'package/package.json'];
  it('passes the allowlist itself', () => {
    assert.deepEqual(checkEntries('p', [...allow], allow), []);
  });
  it('refuses an extra file and a missing one', () => {
    const got = checkEntries(
      'p',
      ['package/LICENSE', 'package/package.json', 'package/x.js'],
      allow,
    );
    assert.ok(got.some((m) => m.includes('package/x.js: not in the allowlist')));
    assert.ok(got.some((m) => m.includes('package/dist/index.js: in the allowlist, not packed')));
  });
  it('refuses a denylisted file even when the allowlist lists it', () => {
    for (const bad of [
      'package/.npmrc',
      'package/.env.local',
      'package/fixtures/job.nc',
      'package/dist/a.test.js',
      'package/server/main.js',
      'package/node_modules/x/index.js',
    ]) {
      const got = checkEntries('p', [...allow, bad], [...allow, bad]);
      assert.equal(got.length, 1, `${bad}: ${got.join('; ')}`);
    }
  });
  it('refuses a path outside package/ or climbing out of it', () => {
    for (const bad of ['other/x', 'package/../x']) {
      const got = checkEntries('p', [...allow, bad], [...allow, bad]);
      assert.ok(
        got.some((m) => m.includes('outside package/')),
        bad,
      );
    }
  });
  it('refuses a name twice', () => {
    const got = checkEntries('p', [...allow, 'package/LICENSE'], allow);
    assert.ok(got.some((m) => m.includes('twice')));
  });
});

describe('checkManifest', () => {
  it('passes a good manifest', () => {
    assert.deepEqual(checkManifest(GOOD.name, GOOD, '0.1.0'), []);
  });
  it('refuses the wrong version, private, a workspace range, an install script', () => {
    const cases = [
      [{ ...GOOD, version: '0.2.0' }, 'lockstep'],
      [{ ...GOOD, private: true }, 'private'],
      [{ ...GOOD, license: 'AGPL-3.0' }, 'license'],
      [{ ...GOOD, publishConfig: { access: 'public' } }, 'provenance'],
      [{ ...GOOD, publishConfig: { provenance: true } }, 'access'],
      [{ ...GOOD, dependencies: { x: 'workspace:*' } }, 'workspace:'],
      [{ ...GOOD, scripts: { postinstall: 'node x' } }, 'postinstall'],
      [{ ...GOOD, scripts: { prepare: 'node x' } }, 'prepare'],
      [{ ...GOOD, name: '@woodpatch/gcode-viewer' }, 'name'],
    ];
    for (const [pkg, word] of cases) {
      const got = checkManifest(GOOD.name, pkg, '0.1.0');
      assert.ok(
        got.some((m) => m.includes(word)),
        `${word}: ${got.join('; ')}`,
      );
    }
  });
  it('allows ordinary scripts (a build script never runs on install)', () => {
    assert.deepEqual(checkManifest(GOOD.name, { ...GOOD, scripts: { build: 'x' } }, '0.1.0'), []);
  });
});

describe('checkMap', () => {
  const map = (sources, extra = {}) => JSON.stringify({ version: 3, sources, ...extra });
  it('passes relative sources', () => {
    assert.deepEqual(checkMap('p', 'a.map', map(['../src/a.ts', 'b.ts'])), []);
  });
  it('refuses absolute, file: and drive-letter sources, and an absolute sourceRoot', () => {
    for (const s of ['/home/me/src/a.ts', 'file:///src/a.ts', 'C:\\src\\a.ts', 'C:/src/a.ts'])
      assert.equal(checkMap('p', 'a.map', map([s])).length, 1, s);
    assert.equal(checkMap('p', 'a.map', map(['a.ts'], { sourceRoot: '/build' })).length, 1);
  });
  it("refuses a map that isn't JSON", () => {
    assert.equal(checkMap('p', 'a.map', 'nope').length, 1);
  });
});

describe('entryPoints', () => {
  it('lists every runtime entry, not the type files', () => {
    const pkg = {
      exports: {
        '.': { types: './src/index.d.ts', svelte: './src/index.js', default: './src/index.js' },
        './worker': { types: './src/worker.d.ts', default: './src/worker.js' },
      },
    };
    assert.deepEqual(entryPoints(pkg), ['package/src/index.js', 'package/src/worker.js']);
  });
});

describe('the rest', () => {
  it("integrity is npm's form", () => {
    assert.equal(
      integrity(Buffer.from('')),
      'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==',
    );
  });
  it('allowlists ignore comments and blanks', () => {
    assert.deepEqual(readAllowlist('# x\n\npackage/a\n  package/b  \n'), [
      'package/a',
      'package/b',
    ]);
  });
  it('every committed allowlist carries its licence header', () => {
    for (const n of ['core', 'viewer', 'editor', 'svelte']) {
      const t = readFileSync(new URL(`./pack-manifests/gcode-${n}.txt`, import.meta.url), 'utf8');
      assert.ok(t.startsWith('# SPDX-FileCopyrightText:'), n);
    }
  });
});
