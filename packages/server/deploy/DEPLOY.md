<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# Deploying the estimate server

The checklist for installing `@woodpatch/gcode-server` on a host, beside the application
that calls it (ADR-0040, ADR-0045, ADR-0046 in `docs/DECISIONS.md`).

This repository is public, so it holds no host's values: no user or group names, no gid,
no paths. Those live in the host's **values file**, kept privately by whoever runs the
host, and `render.mjs` turns the templates here into that host's units.

## 1. The values file

One JSON object per host, in a private, reviewed location. `values.example.json` is a
fictional example. `render.mjs` refuses an unknown field, a missing one, or a value
outside its pattern.

| field             | what                                                                        | default |
| ----------------- | --------------------------------------------------------------------------- | ------- |
| `group`           | the dedicated group that may connect (a local group)                        |         |
| `gid`             | its reserved gid (section 2)                                                |         |
| `callerUser`      | the calling application's user: the group's only member                     |         |
| `prefix`          | where the server is installed (`<prefix>/bundle`)                           |         |
| `credFile`        | the log key's file (section 3)                                              |         |
| `node`            | the pinned Node binary (section 4)                                          |         |
| `tripwire`        | where the tripwire is installed (section 5): never inside `prefix`          | †       |
| `inaccessible`    | the calling application's code, config and data: the service can't see them |         |
| `workers`         | worker threads, 1-16                                                        | 2       |
| `heapMb`          | each worker's heap, MB                                                      | 1536    |
| `youngMb`         | each worker's young generation, MB                                          | 64      |
| `mainMb`          | the main thread's allowance, MB                                             | 512     |
| `cpuQuotaPercent` | `CPUQuota=`                                                                 | 200     |
| `tasksMax`        | `TasksMax=`                                                                 | 64      |
| `cpuWeight`       | `CPUWeight=`: the host's own services win                                   | 20      |
| `ioWeight`        | `IOWeight=`                                                                 | 20      |
| `nice`            | `Nice=`                                                                     | 10      |
| `oomScoreAdjust`  | `OOMScoreAdjust=`: the kernel kills this first                              | 900     |

† `/usr/local/libexec/wp-gcode-tripwire`.

`MemoryMax=` is rendered as (workers + 1) × (heap + young) + main, since a replaced worker
briefly overlaps its successor. That's 5,312 MB at the defaults; one worker with a 1,280 MB
heap is 3,200 MB. `MemoryHigh=` is 90% of it, and there's no swap. The server is told the
same heap numbers (`WP_GCODE_HEAP_MB`, `WP_GCODE_YOUNG_MB`), so the two can't disagree.
Check the host has that much to spare.

`inaccessible` should list the calling application's code, config and data, its
backups, other users' homes, and **every Unix socket directory on the host** (the
database's and the cache's, say). The sandbox allows only `AF_UNIX`, so a reachable
socket is the one way out. The service also gets an empty `/var/lib`, so nothing at or
under `/var/lib` goes in `inaccessible` (it wouldn't exist there, and the start would
fail): `render.mjs` refuses one. Check every path exists before rendering, since a missing
one also fails the start.

## 2. The group and its gid

The group's membership IS the access control (ADR-0040), so:

1. **Reserve a gid** that lies outside:
   - every sssd domain's `min_id`-`max_id` range (a domain without both counts as
     covering everything);
   - systemd's DynamicUser range, 61184-65519;
   - systemd-homed's, 60001-60513;
   - and it isn't 0, nobody's 65534, or an overflow id (4294967294, 4294967295).

   It must also be unused: `getent group <gid>` and `getent passwd` show nothing with it.
   Record it in the host's notes, so it's never reused.

2. **Create the group locally** with that gid, and add the calling application's user as
   its only member.
3. **Lock it:** its gshadow password `!`, and no group administrators. Use
   `gpasswd -R <group>` (which sets the password to `!`), then `gpasswd -A '' <group>`.
4. **Check through NSS,** not just the files. `getent group <group>` must show exactly
   that gid and that one member; a directory group of the same name must not shadow or
   extend it.

The tripwire checks all of this at every start, and refuses to start if any of it drifts.

## 3. The log key

At least 32 random bytes, kept wherever the host keeps credentials. Stage it as
`credFile`: a regular file (not a link), `root:root`, mode `0600`, in a directory that
is root-owned and not group- or other-writable all the way up to `/`. Shred any hand-over
copy. To rotate it, replace the file and restart the service. Log lines from before
then can no longer be matched to new ones, which is acceptable for logs.

## 4. Node

The exact Node version CI pins (`.github/ci/setup-toolchain.sh`, `NODE_VERSION`). Check
the official tarball against `NODE_SHA256` there before unpacking it, and install it
root-owned, not writable by its group or others. Every directory above it must be
root-owned and not group- or other-writable too, and its path must be its real path
(no symlink on the way): the tripwire refuses otherwise.

## 5. The bundle: from CI's release, never built on the host

1. **The tag.** Only an admin can create a `server-v*` tag (the repository's tag
   ruleset), so the operator cuts each release, on a commit that has been reviewed and
   merged. Take `gcode-server-vX.Y.Z.tar.gz` and its `.sha256` from the GitHub release of
   that tag. Only `.github/workflows/release-server.yml` makes these.
2. Check the tag before trusting its release:
   - its commit is on `main`'s first-parent line (a merge result, not a commit from
     inside a branch). In a clone:
     `git rev-list --first-parent origin/main | grep -x "$(git rev-parse server-vX.Y.Z^{commit})"`;
   - the release's assets were uploaded by that workflow's run (both its jobs' logs
     print the SHA-256).
3. `sha256sum -c gcode-server-vX.Y.Z.tar.gz.sha256`, then unpack it.
4. Inside the bundle: `sha256sum -c SHA256SUMS`. `BUILD` must end with the tag's commit
   (`git rev-parse --short=12 server-vX.Y.Z`).
5. Install it at `<prefix>/bundle`: the directory `root:root 0755`, its files
   `root:root 0644`, and `tripwire.sh` `0755`. Every directory above it, up to `/`, must
   be root-owned and not group- or other-writable.
6. **Install the tripwire apart from the bundle.** It runs as root, so it never runs from
   the bundle: copy the bundle's `tripwire.sh` to `tripwire`
   (`/usr/local/libexec/wp-gcode-tripwire` by default), `root:root 0755`, in a
   directory that is root-owned and not group- or other-writable all the way up to `/`.
   It checks that about itself at every start. On an upgrade, copy it again only if the
   new bundle's `tripwire.sh` differs (`cmp`).

A build attestation (Sigstore) would need GitHub's `attest-build-provenance` action,
which this repository's Actions policy doesn't allow (ADR-0006). The tag on `main`, the
workflow's log and the two checksums stand in for it (ADR-0046).

## 6. Render and install the units

On a machine that holds the values file:

```bash
node packages/server/deploy/render.mjs --values host.json --bundle <unpacked bundle> --out <empty dir>
```

That writes three files. Install them on the host, `root:root 0644`:

| file                     | goes to                                |
| ------------------------ | -------------------------------------- |
| `wp-gcode.socket`        | `/etc/systemd/system/wp-gcode.socket`  |
| `wp-gcode.service`       | `/etc/systemd/system/wp-gcode.service` |
| `wp-gcode-tmpfiles.conf` | `/etc/tmpfiles.d/wp-gcode.conf`        |

Then:

```bash
systemd-tmpfiles --create /etc/tmpfiles.d/wp-gcode.conf
```

```bash
systemctl daemon-reload
```

```bash
systemctl enable --now wp-gcode.socket
```

The service starts on the first connection.

## 7. Prove it before go-live

1. **The caller can connect,** as `callerUser`: `POST /estimate` on
   `/run/wp-gcode/gcode.sock` answers. Any other user gets "permission denied".
2. **The tripwire refuses.** Make one change at a time, restart the socket unit, and see
   it fail with the tripwire's line in its journal. Then put it back:
   - another member in the group;
   - the directory's mode to `0770`;
   - an ACL on the directory (`setfacl -m u:nobody:rwx /run/wp-gcode`);
   - the log key's mode to `0640`;
   - the bundle's directory group-writable (`chmod g+w <prefix>/bundle`).
3. **The logs** (`journalctl -u wp-gcode.service`) show JSON lines: no G-code, and no
   scope as sent.

## 8. The caller's side

Its configuration, not this repository's:

- the socket's path;
- the four timeouts of ADR-0045's chain: HTTP 55 s, queued job 60 s, queue worker 90 s,
  retry-after 120 s (the server's contended worst is 48 s at two workers, 51.5 s at 16);
- a retry only on SERVER_BUSY and SCOPE_BUSY, honouring Retry-After.

## Upgrading

Ask the operator to cut the new tag, then follow sections 5 and 6 again for it. A new bundle has a new `BUILD`, and the
units name it, so render them again. Then:

```bash
systemctl daemon-reload
```

```bash
systemctl restart wp-gcode.socket wp-gcode.service
```

The tripwire refuses a bundle whose `BUILD` isn't the one the units were rendered for.
