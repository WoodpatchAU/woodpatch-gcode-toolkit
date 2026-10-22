<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# @woodpatch/gcode-db

The machine record's format (`docs/DECISIONS.md`, ADR-0041), shared by the toolkit and
the applications that store machine records. Zero runtime dependencies.

- `parseStrictJson(text)`: a JSON parser for untrusted records. It refuses repeated
  keys (compared after unescaping), lone surrogates, numbers that overflow and deep
  nesting, and builds null-prototype objects, so `__proto__` is an ordinary key.
- `contentHash(value)`: SHA-256 of the record's RFC 8785 (JCS) canonical form. Only the
  toolkit computes it; a storing application keeps the hash the server echoes.

Still to come in Phase 5a: `validateMachine()`, the JSON Schema and a fictional example
record. It stays `"private": true` until then.
