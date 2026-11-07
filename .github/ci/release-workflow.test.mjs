// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// The npm release workflow keeps its shape (ADR-0051): the credential lives only in a
// job that runs no repository or dependency code, and its pins agree with CI's. Read
// as text: the workflow's shape is the claim, and there is no YAML parser in the tree.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { URL } from 'node:url';

const WF = readFileSync(new URL('../workflows/release.yml', import.meta.url), 'utf8');
const TOOLCHAIN = readFileSync(new URL('./setup-toolchain.sh', import.meta.url), 'utf8');

// The two jobs' text, by their keys under `jobs:`.
const jobsAt = WF.indexOf('\njobs:\n');
const buildAt = WF.indexOf('\n  build:\n');
const publishAt = WF.indexOf('\n  publish:\n');
const head = WF.slice(0, jobsAt);
const build = WF.slice(buildAt, publishAt);
const publish = WF.slice(publishAt);
// Code only: comments may name what the code must not do.
const code = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const value = (text, key) => new RegExp(`^\\s*${key}[=:] *(\\S+)`, 'm').exec(text)?.[1];

it('has exactly the two jobs, in order', () => {
  assert.ok(jobsAt > 0 && buildAt > jobsAt && publishAt > buildAt);
  assert.deepEqual(
    [...WF.slice(jobsAt).matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]),
    ['build', 'publish'],
  );
});

it('runs only by hand, and grants nothing by default', () => {
  assert.match(head, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(head, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(head, /^permissions: \{\}$/m);
});

it('uses no actions anywhere (ADR-0006)', () => {
  assert.doesNotMatch(code(WF), /\buses:/);
});

it('build: read-only, no environment, no secrets', () => {
  const b = code(build);
  assert.match(b, /permissions:\n\s+contents: read\n\s+checks: read\n\s+outputs:/);
  assert.doesNotMatch(b, /id-token|environment:|secrets\./);
});

it('publish: the environment, id-token only, and no repository or dependency code', () => {
  const p = code(publish);
  assert.match(p, /\n {4}environment: npm-release\n/);
  assert.match(p, /\n {4}permissions:\n {6}id-token: write\n {4}env:/);
  assert.doesNotMatch(p, /contents:|checks:/);
  for (const banned of [
    'git ',
    'git\n',
    'pnpm',
    'setup-toolchain',
    'scripts/',
    '.github/ci',
    'npx',
    'npm install',
    'npm ci',
  ]) {
    assert.ok(!p.includes(banned), `publish job mentions ${JSON.stringify(banned)}`);
  }
  // npm only ever as the pinned CLI under the pinned Node.
  for (const m of p.matchAll(/\bnpm\b(?![-_.\w/])[^\n]*/g)) {
    assert.ok(!/^npm (publish|view|install|ci|exec|run)\b/.test(m[0]), m[0]);
  }
});

it('the only secret is the bootstrap token, and only in publish', () => {
  const all = [...code(WF).matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(all, ['NPM_BOOTSTRAP_TOKEN']);
  assert.ok(code(publish).includes('secrets.NPM_BOOTSTRAP_TOKEN'));
});

it("publish's Node is CI's Node", () => {
  assert.equal(value(publish, 'NODE_VERSION'), value(TOOLCHAIN, 'NODE_VERSION'));
  assert.equal(value(publish, 'NODE_SHA256'), value(TOOLCHAIN, 'NODE_SHA256'));
});

it('npm is pinned at >= 11.5.1 with a full sha512', () => {
  const v = value(publish, 'NPM_VERSION');
  const [maj, min, pat] = v.split('.').map(Number);
  assert.ok(maj > 11 || (maj === 11 && (min > 5 || (min === 5 && pat >= 1))), v);
  assert.match(value(publish, 'NPM_SHA512'), /^sha512-[A-Za-z0-9+/]{86}==$/);
});

it('both jobs refuse anything but main and the releasers', () => {
  for (const job of [build, publish]) {
    assert.ok(job.includes('refs/heads/main'));
    assert.ok(job.includes('$TRIGGERING_ACTOR'));
  }
});

it('dry run by default', () => {
  assert.match(head, /dry_run:\n(\s+[a-z]+:.*\n)*?\s+default: true\n/);
});
