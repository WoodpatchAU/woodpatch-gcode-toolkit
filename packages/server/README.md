<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# @woodpatch/gcode-server

The machining-time estimate service. Its security boundary is ADR-0040, and its wire
contract is ADR-0044 (`docs/DECISIONS.md`). It has no third-party runtime dependencies.

- **The contract:**
  - `parseRequest(text)`: the strict request parser. It applies the size caps and answers
    with a closed list of error codes (`ERRORS`: each code's HTTP status, and whether it
    is retriable).
  - `mapRecord(record)`: a validated machine record (`@woodpatch/gcode-db`) as the
    estimator and the travel check take it.
  - `handleEstimate(request, build)`: one estimate, as the response body.
  - `schema/`: JSON Schemas for the request, the response and the error body. Each is a
    subset of the code, which is authoritative.
- **The server (ADR-0045):** `dist/main.js`, run by systemd with socket activation. It
  refuses to start without the socket systemd passes, `WP_GCODE_BUILD` and the `log-key`
  credential.
  - A worker pool with heap limits and a wall-clock budget per job, and a fair share
    per scope.
  - A per-scope cache.
  - A log that never holds the G-code or a scope as sent.

  To run it by hand:

  ```bash
  systemd-socket-activate -l /run/wp-gcode/gcode.sock -E WP_GCODE_BUILD=dev -E CREDENTIALS_DIRECTORY=/path/to/creds node dist/main.js
  ```

  The deployment files (5d-3) follow.

**Pricing from an estimate:**

- Price only from `estimate.totalMs`, and automatically only when `estimate.complete`
  and `estimate.calibrated` are both true.
- `knownMs` is an "at least", never a price input.
