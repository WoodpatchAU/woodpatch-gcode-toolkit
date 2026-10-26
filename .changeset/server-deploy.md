---
'@woodpatch/gcode-server': minor
---

The estimate server's deployment files (ADR-0046):

- systemd socket, service and tmpfiles templates, rendered from a host's private values
  file by `deploy/render.mjs`;
- a POSIX sh tripwire the units run before starting;
- `deploy/build.mjs`, a self-contained bundle with its build string and SHA256SUMS;
- a release workflow that attaches the bundle to a `server-vX.Y.Z` tag;
- `DEPLOY.md`, the install checklist.
