// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The tripwire (deploy/tripwire.sh) against fixture /etc trees. The metadata it reads
// (owners, modes, ACLs, NSS, the socket unit's listeners) comes from small shims put
// first on PATH, since a test can't make files root-owned.
const TRIPWIRE = fileURLToPath(new URL('../deploy/tripwire.sh', import.meta.url));

const SHIMS: Record<string, string> = {
  stat: `#!/bin/sh
for p; do :; done
line=$(grep -F -- "$p|" "$TW_FIX/stat" | head -n1) || exit 1
[ -n "$line" ] || exit 1
printf '%s\\n' "\${line#*|}"`,
  getfacl: `#!/bin/sh
for p; do :; done
grep -F -- "$p|" "$TW_FIX/acl" 2>/dev/null | cut -d'|' -f2-
exit 0`,
  getent: `#!/bin/sh
case "$1" in
  group) awk -F: -v k="$2" '$1 == k || $3 == k' "$TW_FIX/nss-group" ;;
  passwd) cat "$TW_FIX/nss-passwd" ;;
esac`,
  systemctl: `#!/bin/sh
cat "$TW_FIX/listen"`,
};

interface Fixture {
  group: string;
  gshadow: string;
  passwd: string;
  nssGroup: string;
  nssPasswd: string;
  sssd: string | null;
  /** path → "uid gid mode size type" */
  stat: Record<string, string>;
  acl: Record<string, string>;
  listen: string;
  build: string;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(change: (f: Fixture, p: Record<string, string>) => void = () => {}) {
  const base = mkdtempSync(join(tmpdir(), 'tripwire-'));
  dirs.push(base);
  const root = join(base, 'root');
  const fix = join(base, 'fix');
  const bin = join(base, 'bin');
  const bundle = join(base, 'bundle');
  for (const d of [join(root, 'etc', 'sssd'), fix, bin, join(bundle, 'lib')]) {
    mkdirSync(d, { recursive: true });
  }
  writeFileSync(join(bundle, 'main.js'), '');
  writeFileSync(join(bundle, 'lib', 'worker.js'), '');
  writeFileSync(join(bundle, 'BUILD'), 'gcode-server-1.0.0+abc\n');

  const p = {
    dir: '/run/wp-gcode',
    socket: '/run/wp-gcode/gcode.sock',
    cred: '/etc/wp-gcode/log-key',
    node: '/opt/node/bin/node',
    bundle,
  };
  const f: Fixture = {
    group: 'root:x:0:\nwpgcode:x:960:bosapp\n',
    gshadow: 'root:::\nwpgcode:!::bosapp\n',
    passwd: 'root:x:0:0::/root:/bin/sh\nbosapp:x:1500:1500::/home/bosapp:/bin/sh\n',
    nssGroup: 'root:x:0:\nwpgcode:x:960:bosapp\n',
    nssPasswd: 'root:x:0:0::/root:/bin/sh\nbosapp:x:1500:1500::/home/bosapp:/bin/sh\n',
    sssd: '[sssd]\ndomains = corp\n[domain/corp]\nmin_id = 100000\nmax_id = 200000\n',
    stat: {
      [p.dir]: '0 960 750 60 directory',
      [p.socket]: '0 960 660 0 socket',
      [p.cred]: '0 0 600 32 regular file',
      [p.node]: '0 0 755 1000 regular file',
      [bundle]: '0 0 755 100 directory',
      [join(bundle, 'lib')]: '0 0 755 100 directory',
      [join(bundle, 'main.js')]: '0 0 644 10 regular file',
      [join(bundle, 'lib', 'worker.js')]: '0 0 644 10 regular file',
      [join(bundle, 'BUILD')]: '0 0 644 24 regular file',
    },
    acl: {},
    listen: '/run/wp-gcode/gcode.sock (Stream)',
    build: 'gcode-server-1.0.0+abc',
  };
  change(f, p);

  writeFileSync(join(root, 'etc', 'group'), f.group);
  writeFileSync(join(root, 'etc', 'gshadow'), f.gshadow);
  writeFileSync(join(root, 'etc', 'passwd'), f.passwd);
  if (f.sssd !== null) writeFileSync(join(root, 'etc', 'sssd', 'sssd.conf'), f.sssd);
  writeFileSync(join(fix, 'nss-group'), f.nssGroup);
  writeFileSync(join(fix, 'nss-passwd'), f.nssPasswd);
  writeFileSync(
    join(fix, 'stat'),
    Object.entries(f.stat)
      .map(([k, v]) => `${k}|${v}\n`)
      .join(''),
  );
  writeFileSync(
    join(fix, 'acl'),
    Object.entries(f.acl)
      .map(([k, v]) => `${k}|${v}\n`)
      .join(''),
  );
  writeFileSync(join(fix, 'listen'), `${f.listen}\n`);
  for (const [name, body] of Object.entries(SHIMS)) {
    writeFileSync(join(bin, name), `${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }

  const run = (mode: 'service' | 'socket-pre' | 'socket-post') => {
    const common = ['--group', 'wpgcode', '--gid', '960', '--caller', 'bosapp', '--dir', p.dir];
    const extra = {
      service: ['--cred', p.cred, '--bundle', p.bundle, '--build', f.build, '--node', p.node],
      'socket-pre': [],
      'socket-post': ['--socket', p.socket, '--unit', 'wp-gcode.socket'],
    }[mode];
    const r = spawnSync('sh', [TRIPWIRE, mode, ...common, ...extra], {
      env: { PATH: `${bin}:/usr/bin:/bin`, TRIPWIRE_ROOT: root, TW_FIX: fix },
      encoding: 'utf8',
    });
    return { status: r.status, stderr: r.stderr };
  };
  return run;
}

const MODES = ['service', 'socket-pre', 'socket-post'] as const;

describe('the tripwire', () => {
  it('passes a host set up as ADR-0040 says, in every mode', () => {
    const run = setup();
    for (const m of MODES) expect(run(m), m).toEqual({ status: 0, stderr: '' });
  });

  // Each case breaks one rule, and must be refused in every mode that checks it.
  const ALL = MODES;
  const cases: [
    string,
    (f: Fixture, p: Record<string, string>) => void,
    readonly string[],
    RegExp,
  ][] = [
    [
      'another member in /etc/group',
      (f) => {
        f.group = f.group.replace('bosapp', 'bosapp,eve');
        f.nssGroup = f.group;
      },
      ALL,
      /members in \/etc\/group/,
    ],
    [
      'another member in gshadow',
      (f) => {
        f.gshadow = f.gshadow.replace(':bosapp', ':bosapp,eve');
      },
      ALL,
      /members in \/etc\/gshadow/,
    ],
    [
      'a usable group password',
      (f) => {
        f.gshadow = f.gshadow.replace('wpgcode:!', 'wpgcode:$6$x');
      },
      ALL,
      /usable password/,
    ],
    [
      'a group administrator',
      (f) => {
        f.gshadow = f.gshadow.replace('wpgcode:!::', 'wpgcode:!:eve:');
      },
      ALL,
      /administrators/,
    ],
    [
      'a directory member NSS adds',
      (f) => {
        f.nssGroup = f.nssGroup.replace(':bosapp', ':bosapp,ldapuser');
      },
      ALL,
      /NSS's group wpgcode differs/,
    ],
    [
      'a same-name directory group shadowing it',
      (f) => {
        f.nssGroup = 'wpgcode:x:5000:ldapuser\n';
      },
      ALL,
      /differs/,
    ],
    [
      'the gid resolving to another group in NSS',
      (f) => {
        f.nssGroup = 'other:x:960:\nwpgcode:x:960:bosapp\n';
      },
      ALL,
      /resolves gid 960 to another group/,
    ],
    [
      'the group missing locally',
      (f) => {
        f.group = 'root:x:0:\n';
      },
      ALL,
      /isn't in \/etc\/group/,
    ],
    [
      'the wrong gid',
      (f) => {
        f.group = f.group.replace(':960:', ':961:');
        f.nssGroup = f.group;
      },
      ALL,
      /has gid 961/,
    ],
    [
      'a second group with the gid',
      (f) => {
        f.group += 'other:x:960:\n';
      },
      ALL,
      /more than one group/,
    ],
    [
      'another user with the gid as primary (files)',
      (f) => {
        f.passwd += 'eve:x:1600:960::/:/bin/sh\n';
      },
      ALL,
      /primary group: eve/,
    ],
    [
      'another user with the gid as primary (NSS)',
      (f) => {
        f.nssPasswd += 'ldapeve:x:200500:960::/:/bin/sh\n';
      },
      ALL,
      /primary group: ldapeve/,
    ],
    [
      "the gid inside sssd's range",
      (f) => {
        f.sssd = '[domain/corp]\nmin_id = 900\nmax_id = 2000\n';
      },
      ALL,
      /inside sssd/,
    ],
    [
      'an sssd domain with no min_id',
      (f) => {
        f.sssd = '[domain/corp]\nmax_id = 2000\n';
      },
      ALL,
      /unbounded/,
    ],
    [
      'an sssd domain with no max_id',
      (f) => {
        f.sssd = '[domain/corp]\nmin_id = 100000\n';
      },
      ALL,
      /unbounded/,
    ],
    [
      'the directory group-writable',
      (f, p) => {
        f.stat[p.dir as string] = '0 960 770 60 directory';
      },
      ALL,
      /mode 750/,
    ],
    [
      "the directory owned by the group's user",
      (f, p) => {
        f.stat[p.dir as string] = '1500 960 750 60 directory';
      },
      ALL,
      /owned by 0:960/,
    ],
    [
      'an ACL on the directory',
      (f, p) => {
        f.acl[p.dir as string] = 'user:eve:rwx';
      },
      ALL,
      /extended ACL/,
    ],
    [
      'the socket world-writable',
      (f, p) => {
        f.stat[p.socket as string] = '0 960 666 0 socket';
      },
      ['socket-post'],
      /mode 660/,
    ],
    [
      'an ACL on the socket',
      (f, p) => {
        f.acl[p.socket as string] = 'user:eve:rw-';
      },
      ['socket-post'],
      /extended ACL/,
    ],
    [
      'a second listener',
      (f) => {
        f.listen = '/run/wp-gcode/gcode.sock (Stream)\n127.0.0.1:9000 (Stream)';
      },
      ['socket-post'],
      /exactly/,
    ],
    [
      'a TCP listener instead',
      (f) => {
        f.listen = '127.0.0.1:9000 (Stream)';
      },
      ['socket-post'],
      /exactly/,
    ],
    [
      'a log key readable by its group',
      (f, p) => {
        f.stat[p.cred as string] = '0 0 640 32 regular file';
      },
      ['service'],
      /mode 0600/,
    ],
    [
      'a log key owned by another',
      (f, p) => {
        f.stat[p.cred as string] = '1500 0 600 32 regular file';
      },
      ['service'],
      /root:root/,
    ],
    [
      'a log key that is a symlink',
      (f, p) => {
        f.stat[p.cred as string] = '0 0 600 32 symbolic link';
      },
      ['service'],
      /regular file/,
    ],
    [
      'a short log key',
      (f, p) => {
        f.stat[p.cred as string] = '0 0 600 31 regular file';
      },
      ['service'],
      /at least 32 bytes/,
    ],
    [
      'a bundle file group-writable',
      (f, p) => {
        f.stat[join(p.bundle as string, 'lib', 'worker.js')] = '0 0 664 10 regular file';
      },
      ['service'],
      /writable/,
    ],
    [
      'a setuid bundle file writable by others',
      (f, p) => {
        f.stat[join(p.bundle as string, 'main.js')] = '0 0 4757 10 regular file';
      },
      ['service'],
      /writable/,
    ],
    [
      'a bundle owned by a user',
      (f, p) => {
        f.stat[p.bundle as string] = '1500 0 755 100 directory';
      },
      ['service'],
      /owned by root/,
    ],
    [
      'node writable by others',
      (f, p) => {
        f.stat[p.node as string] = '0 0 757 1000 regular file';
      },
      ['service'],
      /writable/,
    ],
    [
      "a build the units weren't rendered for",
      (f) => {
        f.build = 'gcode-server-1.0.1+def';
      },
      ['service'],
      /BUILD/,
    ],
  ];

  it.each(cases)('refuses %s', (_, change, modes, message) => {
    const run = setup(change);
    for (const m of MODES) {
      const r = run(m);
      if (modes.includes(m)) {
        expect(r.status, `${m}: ${r.stderr}`).toBe(1);
        expect(r.stderr, m).toMatch(message);
        expect(r.stderr.split('\n').filter(Boolean), m).toHaveLength(1);
      } else {
        expect(r.status, `${m} should pass: ${r.stderr}`).toBe(0);
      }
    }
  });

  it("refuses a gid in systemd's DynamicUser or homed ranges", () => {
    // Checked first, before any file is read.
    for (const gid of ['61184', '65519', '60001', '60513']) {
      const r = spawnSync(
        'sh',
        [
          TRIPWIRE,
          'socket-pre',
          '--group',
          'wpgcode',
          '--gid',
          gid,
          '--caller',
          'bosapp',
          '--dir',
          '/x',
        ],
        {
          env: { PATH: '/usr/bin:/bin', TRIPWIRE_ROOT: '/nonexistent' },
          encoding: 'utf8',
        },
      );
      expect(r.status, gid).toBe(1);
      expect(r.stderr).toMatch(/DynamicUser|homed/);
    }
  });

  it('passes with no sssd at all, and refuses bad arguments', () => {
    expect(
      setup((f) => {
        f.sssd = null;
      })('service').status,
    ).toBe(0);
    for (const args of [
      [],
      ['bogus'],
      ['service', '--gid'],
      ['socket-pre', '--group', 'g'],
      ['socket-pre', '--group', 'g', '--gid', 'x', '--caller', 'c', '--dir', '/d'],
      ['socket-pre', '--group', 'G;rm', '--gid', '1', '--caller', 'c', '--dir', '/d'],
    ]) {
      const r = spawnSync('sh', [TRIPWIRE, ...args], {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
      });
      expect(r.status, args.join(' ')).toBe(1);
    }
  });
});
