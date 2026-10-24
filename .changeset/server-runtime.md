---
'@woodpatch/gcode-server': minor
---

The estimate server itself (ADR-0045). `dist/main.js` runs under systemd socket
activation only: one passed socket, or it refuses to start. `POST /estimate` with strict
size, media-type and UTF-8 checks. A pool of worker threads with heap limits, and a
wall-clock budget that terminates the worker. A fair share per scope, a bounded queue
with Retry-After, and a per-scope cache. A log that holds only HMACs of the G-code and
scope. Any throw answers INTERNAL with a fixed message.
