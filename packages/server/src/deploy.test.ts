// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, without types
import { RenderError, fill, placeholders, readValues, render } from '../deploy/render.mjs';

const DEPLOY = fileURLToPath(new URL('../deploy/', import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(join(DEPLOY, 'values.example.json'), 'utf8'));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake bundle (BUILD, tripwire, main.js) under a prefix, and an empty --out dir. */
function workspace(build = 'gcode-server-1.2.3+0123456789ab', track = true) {
  const base = mkdtempSync(join(tmpdir(), 'render-'));
  if (track) dirs.push(base);
  const bundle = join(base, 'prefix', 'bundle');
  const out = join(base, 'out');
  mkdirSync(bundle, { recursive: true });
  mkdirSync(out);
  writeFileSync(join(bundle, 'BUILD'), `${build}\n`);
  writeFileSync(join(bundle, 'main.js'), '');
  copyFileSync(join(DEPLOY, 'tripwire.sh'), join(bundle, 'tripwire.sh'));
  chmodSync(join(bundle, 'tripwire.sh'), 0o755);
  return { base, bundle, out, prefix: join(base, 'prefix') };
}

const unit = (out: string, name: string) => readFileSync(join(out, name), 'utf8');

describe('the values file', () => {
  it('takes the example, with defaults for what it leaves out', () => {
    const v = readValues(EXAMPLE);
    expect(v).toMatchObject({ workers: 2, heapMb: 1536, youngMb: 64, mainMb: 512, tasksMax: 256 });
  });

  const bad: [string, Record<string, unknown>][] = [
    ['an unknown field', { extra: 1 }],
    ['a group name with a space', { group: 'wp gcode' }],
    ['an upper-case caller', { callerUser: 'App' }],
    ["a gid in DynamicUser's range", { gid: 61184 }],
    ["a gid in homed's range", { gid: 60513 }],
    ['a fractional gid', { gid: 960.5 }],
    ['a relative prefix', { prefix: 'opt/wp-gcode' }],
    ['a prefix with ..', { prefix: '/opt/../etc' }],
    ['a path with a trailing slash', { credFile: '/etc/wp-gcode/' }],
    ['a path with a space', { node: '/opt/my node' }],
    ['a path that would end a unit line', { node: '/opt/node\nExecStart=/bin/sh' }],
    ['the root as a path', { prefix: '/' }],
    ['no inaccessible paths', { inaccessible: [] }],
    ['17 workers', { workers: 17 }],
    ['a heap of 32 MB', { heapMb: 32 }],
  ];
  it.each(bad)('refuses %s', (_, change) => {
    expect(() => readValues({ ...EXAMPLE, ...change })).toThrow(RenderError);
  });

  it('needs every required field', () => {
    for (const k of ['group', 'gid', 'callerUser', 'prefix', 'credFile', 'node', 'inaccessible']) {
      const v = Object.fromEntries(Object.entries(EXAMPLE).filter(([key]) => key !== k));
      expect(() => readValues(v), k).toThrow(/needs/);
    }
  });
});

describe('rendering', () => {
  it('fills every placeholder, and refuses one it does not know', () => {
    const map = placeholders(readValues(EXAMPLE), 'b1');
    expect(fill('@GROUP@:@GID@', map)).toBe('wpgcode:960');
    expect(() => fill('@NOPE@', map)).toThrow(/unknown placeholder/);
    expect(() => placeholders(readValues(EXAMPLE), 'has space')).toThrow(/BUILD/);
  });

  it("writes the three files, 0644, with the bundle's build, and no placeholder left", () => {
    const w = workspace();
    const written = render({
      values: { ...EXAMPLE, prefix: w.prefix },
      bundle: w.bundle,
      out: w.out,
    });
    expect(written.map((p: string) => p.slice(w.out.length + 1)).sort()).toEqual([
      'wp-gcode-tmpfiles.conf',
      'wp-gcode.service',
      'wp-gcode.socket',
    ]);
    for (const p of written) {
      expect(statSync(p).mode & 0o777).toBe(0o644);
      expect(readFileSync(p, 'utf8')).not.toMatch(/@[A-Z_]+@/);
    }
    const service = unit(w.out, 'wp-gcode.service');
    expect(service).toContain('Environment=WP_GCODE_BUILD=gcode-server-1.2.3+0123456789ab');
    expect(service).toContain('--build gcode-server-1.2.3+0123456789ab');
    // (workers + 1) x (heap + young) + main = 3 x 1600 + 512.
    expect(service).toContain('MemoryMax=5312M');
    expect(unit(w.out, 'wp-gcode-tmpfiles.conf')).toContain('d /run/wp-gcode 0750 root wpgcode -');
  });

  it('never replaces a file without --force', () => {
    const w = workspace();
    const values = { ...EXAMPLE, prefix: w.prefix };
    render({ values, bundle: w.bundle, out: w.out });
    expect(() => render({ values, bundle: w.bundle, out: w.out })).toThrow(/--force/);
    expect(() => render({ values, bundle: w.bundle, out: w.out, force: true })).not.toThrow();
  });

  it("refuses a bundle whose BUILD isn't a build string", () => {
    const w = workspace('not a build');
    expect(() =>
      render({ values: { ...EXAMPLE, prefix: w.prefix }, bundle: w.bundle, out: w.out }),
    ).toThrow(/BUILD/);
  });

  it('exits 1 from the command line on a bad values file, writing nothing', () => {
    const w = workspace();
    writeFileSync(join(w.base, 'v.json'), JSON.stringify({ ...EXAMPLE, gid: 'x' }));
    const r = spawnSync(
      process.execPath,
      [
        join(DEPLOY, 'render.mjs'),
        '--values',
        join(w.base, 'v.json'),
        '--bundle',
        w.bundle,
        '--out',
        w.out,
      ],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/"gid"/);
    expect(spawnSync('ls', [w.out], { encoding: 'utf8' }).stdout).toBe('');
  });
});

describe('the rendered units (ADR-0040)', () => {
  // Shared by the tests below, so removed only after them all.
  const w = workspace(undefined, false);
  afterAll(() => rmSync(w.base, { recursive: true, force: true }));
  const values = { ...EXAMPLE, prefix: w.prefix, node: process.execPath };
  render({ values, bundle: w.bundle, out: w.out });
  const service = unit(w.out, 'wp-gcode.service');
  const socket = unit(w.out, 'wp-gcode.socket');
  const lines = (text: string) => new Set(text.split('\n').map((l) => l.trim()));

  it('hold every line of the sandbox, so a later edit cannot drop one', () => {
    const want = [
      'DynamicUser=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'NoNewPrivileges=yes',
      'InaccessiblePaths=/srv/example-app /etc/example-app',
      'PrivateNetwork=yes',
      'RestrictAddressFamilies=AF_UNIX',
      'SystemCallFilter=@system-service',
      'SystemCallArchitectures=native',
      'CapabilityBoundingSet=',
      'PrivateDevices=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectKernelLogs=yes',
      'ProtectControlGroups=yes',
      'RestrictNamespaces=yes',
      'LockPersonality=yes',
      'RestrictSUIDSGID=yes',
      'ProtectClock=yes',
      'ProtectHostname=yes',
      'ProtectProc=invisible',
      'UMask=0077',
      'LoadCredential=log-key:/etc/wp-gcode/log-key',
      'TimeoutStopSec=60',
    ];
    const have = lines(service);
    for (const l of want) expect(have.has(l), l).toBe(true);
    // Deliberately absent: V8's JIT needs writable executable memory.
    expect(service).not.toMatch(/^MemoryDenyWriteExecute=/m);
    // The tripwire runs outside the sandbox (+), as root.
    expect(service).toMatch(/^ExecStartPre=\+\S+\/bundle\/tripwire\.sh service /m);
  });

  it('give the socket to root and the group only, on one Unix path', () => {
    const have = lines(socket);
    for (const l of [
      'ListenStream=/run/wp-gcode/gcode.sock',
      'Accept=no',
      'SocketUser=root',
      'SocketGroup=wpgcode',
      'SocketMode=0660',
      'RemoveOnStop=yes',
    ]) {
      expect(have.has(l), l).toBe(true);
    }
    expect(socket.match(/^Listen/gm)).toHaveLength(1);
    expect(socket).toMatch(/^ExecStartPre=\S+ socket-pre /m);
    expect(socket).toMatch(
      /^ExecStartPost=\S+ socket-post .*--socket \/run\/wp-gcode\/gcode\.sock/m,
    );
  });

  // systemd's own check, which CI's runners have. It warns (exit 0) on a misspelt key,
  // so any output at all fails.
  const analyze = spawnSync('sh', ['-c', 'command -v systemd-analyze'], {
    encoding: 'utf8',
  }).stdout.trim();
  it.skipIf(analyze === '' && process.env['CI'] === undefined)(
    'pass systemd-analyze verify with no warnings',
    () => {
      // The group must resolve on the verifying host; the real one is the target host's.
      const v = mkdtempSync(join(tmpdir(), 'verify-'));
      dirs.push(v);
      render({ values: { ...values, group: 'root' }, bundle: w.bundle, out: v });
      const r = spawnSync(
        analyze,
        ['verify', '--man=no', join(v, 'wp-gcode.socket'), join(v, 'wp-gcode.service')],
        {
          encoding: 'utf8',
        },
      );
      expect([r.status, `${r.stdout}${r.stderr}`]).toEqual([0, '']);
    },
  );
});

describe('the bundle (deploy/build.mjs)', () => {
  it('holds the server alone, with its notice, build and manifest', async () => {
    // @ts-expect-error: a plain .mjs script, without types
    const { buildBundle } = await import('../deploy/build.mjs');
    const base = mkdtempSync(join(tmpdir(), 'bundle-'));
    dirs.push(base);
    const out = join(base, 'bundle');
    const id: string = await buildBundle(out, { dev: true });
    expect(id).toMatch(/^gcode-server-\d+\.\d+\.\d+\+[0-9a-f]{12}-dev$/);
    expect(readFileSync(join(out, 'BUILD'), 'utf8')).toBe(`${id}\n`);
    for (const f of ['main.js', 'worker.js']) {
      const js = readFileSync(join(out, f), 'utf8');
      expect(js, f).toContain('Nicolas Raynaud');
      // Everything inlined: nothing to resolve from node_modules.
      expect(js, f).not.toMatch(/from ["']@woodpatch\//);
    }
    expect(statSync(join(out, 'tripwire.sh')).mode & 0o111).not.toBe(0);
    const check = spawnSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], {
      cwd: out,
      encoding: 'utf8',
    });
    expect([check.status, check.stdout]).toEqual([0, '']);
    // A new directory each time: never over an old bundle.
    await expect(buildBundle(out, { dev: true })).rejects.toThrow(/already exists/);
  });
});
