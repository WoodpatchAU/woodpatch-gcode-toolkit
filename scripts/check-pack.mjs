// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
//
// What we publish to npm is exactly what we meant to publish (ADR-0051).
//
// Packs every publishable package with `pnpm pack` (which turns `workspace:` ranges into
// exact versions, as npm will see them) and checks the TARBALLS, not the source tree:
//
//   - the set of publishable packages is exactly PUBLIC, and every other package under
//     packages/ is "private": true (the estimate server and the db schema never ship);
//   - each tarball's file list matches its committed allowlist, scripts/pack-manifests/,
//     exactly: a new file ships only through a reviewed change to that list;
//   - nothing on the denylist is in it, whatever the allowlist says;
//   - its package.json: the right name, the lockstep version (all four the same), MIT,
//     public with provenance, no `workspace:` left, no install-time lifecycle scripts;
//   - LICENSE and NOTICE are byte-identical to the repo root's, and every entry point
//     in `exports` is in the tarball and carries the notice;
//   - no source map names an absolute path, and no file carries a home or build path.
//
// It prints one line per package (name, version, file, SHA-256, npm integrity) and, with
// --summary, writes them to a file: the release workflow publishes from those lines.
//
//   node scripts/check-pack.mjs --out <dir> [--summary <file>]   pack and check
//   node scripts/check-pack.mjs --out <dir> --write              rewrite the allowlists
//
// Run after `pnpm build`. Exits non-zero, listing every failure.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The packages we publish, in dependency order: the order they are published in. */
export const PUBLIC = [
  '@woodpatch/gcode-core',
  '@woodpatch/gcode-viewer',
  '@woodpatch/gcode-editor',
  '@woodpatch/gcode-svelte',
];

/** Never in a tarball, whatever an allowlist says. Paths are relative to `package/`. */
export const DENY = [
  [/(^|\/)\.npmrc$/, 'an .npmrc (registry credentials)'],
  [/(^|\/)\.env/, 'an .env file'],
  [/(^|\/)fixtures?(\/|$)/i, 'test fixtures'],
  [/\.test\.|\.spec\.|(^|\/)__tests__\//, 'a test file'],
  [/(^|\/)(server|db-schema|db)\//, 'the server or db package'],
  [/(^|\/)\.git(\/|$)|(^|\/)node_modules\//, 'git or node_modules content'],
];

/** Paths that would leak a machine's layout. Checked in every text file shipped. */
const ABSOLUTE_PATH = /(^|["'\s(])(\/home\/|\/srv\/|\/tmp\/|\/Users\/|\/root\/|[A-Za-z]:\\)/;

/** Lifecycle scripts a consumer's install would run. None may ship. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish'];

const NOTICE_STRING = 'Nicolas Raynaud';

/** The tarball's entries, each as `package/...`, must be in the allowlist and only there. */
export function checkEntries(name, entries, allowlist) {
  const problems = [];
  for (const e of entries) {
    if (!e.startsWith('package/') || e.split('/').includes('..'))
      problems.push(`${e}: outside package/`);
    const rel = e.slice('package/'.length);
    for (const [re, what] of DENY) if (re.test(rel)) problems.push(`${e}: ${what}`);
  }
  const have = new Set(entries);
  const want = new Set(allowlist);
  for (const e of entries) if (!want.has(e)) problems.push(`${e}: not in the allowlist`);
  for (const e of allowlist) if (!have.has(e)) problems.push(`${e}: in the allowlist, not packed`);
  if (have.size !== entries.length) problems.push('a name appears twice');
  return problems.map((p) => `${name}: ${p}`);
}

/** The packed package.json. */
export function checkManifest(name, pkg, version) {
  const problems = [];
  if (pkg.name !== name) problems.push(`name is ${JSON.stringify(pkg.name)}`);
  if (pkg.version !== version) problems.push(`version ${pkg.version}, not the lockstep ${version}`);
  if (pkg.private) problems.push('is private');
  if (pkg.license !== 'MIT') problems.push(`license is ${JSON.stringify(pkg.license)}`);
  if (pkg.publishConfig?.access !== 'public') problems.push('publishConfig.access isn\'t "public"');
  if (pkg.publishConfig?.provenance !== true) problems.push("publishConfig.provenance isn't true");
  if (JSON.stringify(pkg).includes('workspace:')) problems.push('a workspace: range survived');
  for (const s of INSTALL_SCRIPTS)
    if (pkg.scripts?.[s] !== undefined) problems.push(`ships a "${s}" script`);
  return problems.map((p) => `${name}: package.json ${p}`);
}

/** A source map's sources are relative paths: no absolute or file: path, no drive. */
export function checkMap(name, file, text) {
  let map;
  try {
    map = JSON.parse(text);
  } catch {
    return [`${name}: ${file} isn't JSON`];
  }
  const bad = [map.sourceRoot ?? '', ...(map.sources ?? [])].filter(
    (s) => s.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(s) || /^[A-Za-z]:[\\/]/.test(s),
  );
  return bad.map((s) => `${name}: ${file} names an absolute source ${JSON.stringify(s)}`);
}

/** The entry points a package's `exports` names, as tarball paths. */
export function entryPoints(pkg) {
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (!v.endsWith('.d.ts')) out.add(`package/${v.replace(/^\.\//, '')}`);
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pkg.exports);
  return [...out].sort();
}

export const integrity = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`;
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Reads the allowlist file: one entry per line, `#` comments and blank lines ignored. */
export function readAllowlist(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

const manifestPath = (name) =>
  join(repoRoot, 'scripts', 'pack-manifests', `${name.split('/')[1]}.txt`);

const ALLOWLIST_HEADER = `# SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
# SPDX-License-Identifier: MIT
#
# Every file this package's npm tarball may hold, and must hold (ADR-0051). Checked by
# scripts/check-pack.mjs; regenerate with --write, and review the difference.
`;

function main(argv) {
  const args = { out: null, summary: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--summary') args.summary = argv[++i];
    else if (a === '--write') args.write = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.out) throw new Error('--out <dir> is required');
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });

  const failures = [];
  const packagesDir = join(repoRoot, 'packages');
  const found = new Map();
  for (const dir of readdirSync(packagesDir).sort()) {
    const p = join(packagesDir, dir, 'package.json');
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    if (pkg.private === true) {
      if (PUBLIC.includes(pkg.name)) failures.push(`${pkg.name}: is private but is published`);
      continue;
    }
    if (!PUBLIC.includes(pkg.name))
      failures.push(
        `${pkg.name ?? dir}: isn't private and isn't in PUBLIC (publish it on purpose, or mark it private)`,
      );
    else found.set(pkg.name, { dir: join(packagesDir, dir), pkg });
  }
  for (const n of PUBLIC) if (!found.has(n)) failures.push(`${n}: not found under packages/`);
  if (failures.length) return report(failures);

  // Lockstep: one version for all of them (ADR-0051's changesets `fixed` group).
  const versions = new Set([...found.values()].map((f) => f.pkg.version));
  if (versions.size !== 1) return report([`versions differ: ${[...versions].join(', ')}`]);
  const [version] = versions;

  const rootLicence = readFileSync(join(repoRoot, 'LICENSE'));
  const rootNotice = readFileSync(join(repoRoot, 'NOTICE'));
  const lines = [];
  for (const name of PUBLIC) {
    const { dir } = found.get(name);
    const file = `${name.slice(1).replace('/', '-')}-${version}.tgz`;
    execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const tgz = join(out, file);
    if (!existsSync(tgz)) {
      failures.push(`${name}: pnpm pack didn't write ${file}`);
      continue;
    }
    const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    const types = execFileSync('tar', ['-tvzf', tgz], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    for (const t of types)
      if (t[0] !== '-') failures.push(`${name}: ${t.split(/\s+/).pop()} isn't a plain file`);

    if (args.write) {
      writeFileSync(manifestPath(name), `${ALLOWLIST_HEADER}${[...entries].sort().join('\n')}\n`);
    } else if (!existsSync(manifestPath(name))) {
      failures.push(
        `${name}: no allowlist at ${manifestPath(name)} (run with --write and review it)`,
      );
    } else {
      failures.push(
        ...checkEntries(name, entries, readAllowlist(readFileSync(manifestPath(name), 'utf8'))),
      );
    }

    const x = mkdtempSync(join(tmpdir(), 'pack-'));
    execFileSync('tar', ['-xzf', tgz, '-C', x]);
    const pkg = JSON.parse(readFileSync(join(x, 'package', 'package.json'), 'utf8'));
    failures.push(...checkManifest(name, pkg, version));
    for (const [f, root] of [
      ['LICENSE', rootLicence],
      ['NOTICE', rootNotice],
    ]) {
      const p = join(x, 'package', f);
      if (!existsSync(p) || !readFileSync(p).equals(root))
        failures.push(`${name}: ${f} missing or not the repo root's`);
    }
    for (const e of entryPoints(pkg)) {
      const p = join(x, e);
      if (!existsSync(p)) failures.push(`${name}: entry point ${e} isn't in the tarball`);
      else if (!readFileSync(p, 'utf8').includes(NOTICE_STRING))
        failures.push(`${name}: entry point ${e} doesn't carry the notice`);
    }
    for (const e of entries) {
      const text = readFileSync(join(x, e), 'utf8');
      if (e.endsWith('.map')) failures.push(...checkMap(name, e, text));
      // Maps embed the original sources, which may quote paths in comments: check
      // their `sources`, above; every other file must carry no build path at all.
      else if (ABSOLUTE_PATH.test(text)) failures.push(`${name}: ${e} contains an absolute path`);
    }

    const buf = readFileSync(tgz);
    lines.push(`${name} ${version} ${file} ${sha256(buf)} ${integrity(buf)}`);
  }

  if (failures.length) return report(failures);
  // The release workflow passes the tarballs between jobs as base64 job outputs, which
  // hold about 480,000 characters (ADR-0051). Logged on every run, so growth shows.
  const bytes = PUBLIC.reduce(
    (n, name) =>
      n + readFileSync(join(out, lines.find((l) => l.startsWith(`${name} `)).split(' ')[2])).length,
    0,
  );
  console.error(
    `Tarballs: ${bytes} bytes, about ${Math.ceil((bytes + 512 * (PUBLIC.length + 3)) / 3) * 4} base64 characters of the release job's 480000.`,
  );
  const summary = `${lines.join('\n')}\n`;
  process.stdout.write(summary);
  if (args.summary) writeFileSync(args.summary, summary);
  console.error(
    args.write
      ? 'Allowlists rewritten: review the difference.'
      : `Pack check passed for ${lines.length} package(s).`,
  );
  return 0;
}

function report(failures) {
  console.error(`Pack check FAILED:\n  - ${failures.join('\n  - ')}`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
