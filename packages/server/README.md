<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# @woodpatch/gcode-server

The machining-time estimate service. Its security boundary is ADR-0040, and its wire
contract is ADR-0044 (`docs/DECISIONS.md`). It has no third-party runtime dependencies.

This part is the contract, without the HTTP layer:

- `parseRequest(text)`: the strict request parser. It applies the size caps and answers
  with a closed list of error codes (`ERRORS`: each code's HTTP status, and whether it is
  retriable).
- `mapRecord(record)`: a validated machine record (`@woodpatch/gcode-db`) as the
  estimator and the travel check take it.
- `handleEstimate(request, build)`: one estimate, as the response body.
- `schema/`: JSON Schemas for the request, the response and the error body. Each is a
  subset of the code, which is authoritative.

The HTTP layer over a systemd-passed Unix socket, the worker pool and its budgets (5d-2),
and the deployment files (5d-3), follow.

**Pricing from an estimate:**

- Price only from `estimate.totalMs`, and automatically only when `estimate.complete`
  and `estimate.calibrated` are both true.
- `knownMs` is an "at least", never a price input.
