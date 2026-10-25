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

`MemoryMax=` is rendered as (workers + 1) × (heap + young) + main, since a replaced worker
briefly overlaps its successor. That's 5,312 MB at the defaults; one worker with a 1,280 MB
heap is 3,200 MB. `MemoryHigh=` is 90% of it, and there's no swap. The server is told the
same heap numbers (`WP_GCODE_HEAP_MB`, `WP_GCODE_YOUNG_MB`), so the two can't disagree.
Check the host has that much to spare.

`inaccessible` should list the calling application's code, config and data, its
backups, other users' homes, and **every Unix socket directory on the host** (the
database's and the cache's, say). The sandbox allows only `AF_UNIX`, so a reachable
socket is the one way out. The service also gets an empty `/var/lib`.

## 2. The group and its gid

The group's membership IS the access control (ADR-0040), so:

1. **Reserve a gid** that lies outside:
   - every sssd domain's `min_id`-`max_id` range (a domain without both counts as
     covering everything);
   - systemd's DynamicUser range, 61184-65519;
   - systemd-homed's, 60001-60513.

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
`credFile`: a regular file (not a link), `root:root`, mode `0600`. Shred any hand-over
copy. To rotate it, replace the file and restart the service. Log lines from before
then can no longer be matched to new ones, which is acceptable for logs.

## 4. Node

The exact Node version CI pins (`.github/ci/setup-toolchain.sh`, `NODE_VERSION`). Check
the official tarball against `NODE_SHA256` there before unpacking it, and install it
root-owned, not writable by its group or others.

## 5. The bundle: from CI's release, never built on the host

1. Take `gcode-server-vX.Y.Z.tar.gz` and its `.sha256` from the GitHub release of tag
   `server-vX.Y.Z`. Only `.github/workflows/release-server.yml` makes these, from a tag
   on a commit that is on `main`.
2. Check the tag before trusting its release:
   - it's signed off in review, and its commit is on `main` (`git merge-base
--is-ancestor server-vX.Y.Z origin/main` in a clone);
   - the release's assets were uploaded by that workflow's run (its log prints the
     SHA-256).
3. `sha256sum -c gcode-server-vX.Y.Z.tar.gz.sha256`, then unpack it.
4. Inside the bundle: `sha256sum -c SHA256SUMS`. `BUILD` must end with the tag's commit
   (`git rev-parse --short=12 server-vX.Y.Z`).
5. Install it at `<prefix>/bundle`: the directory `root:root 0755`, its files
   `root:root 0644`, and `tripwire.sh` `0755`.

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
   - the log key's mode to `0640`.
3. **The logs** (`journalctl -u wp-gcode.service`) show JSON lines: no G-code, and no
   scope as sent.

## 8. The caller's side

Its configuration, not this repository's:

- the socket's path;
- the four timeouts of ADR-0045's chain: HTTP 55 s, queued job 60 s, queue worker 90 s,
  retry-after 120 s;
- a retry only on SERVER_BUSY and SCOPE_BUSY, honouring Retry-After.

## Upgrading

Follow sections 5 and 6 again for the new tag. A new bundle has a new `BUILD`, and the
units name it, so render them again. Then:

```bash
systemctl daemon-reload
```

```bash
systemctl restart wp-gcode.socket wp-gcode.service
```

The tripwire refuses a bundle whose `BUILD` isn't the one the units were rendered for.
