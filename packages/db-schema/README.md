<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# @woodpatch/gcode-db

The machine record's format (`docs/DECISIONS.md`, ADR-0041), shared by the toolkit and
the applications that store machine records. Zero runtime dependencies.

- `readMachine(text)`: the whole path for a record's text as received: the
  16,384-byte cap, the strict parse, validation, and the content hash.
- `validateMachine(record)`: every rule of ADR-0041. Returns a list of problems (empty
  means valid); messages are printable ASCII and never quote a value from the record.
- `parseStrictJson(text)`: a JSON parser for untrusted records. It refuses repeated
  keys (compared after unescaping), lone surrogates, numbers that overflow and deep
  nesting, and builds null-prototype objects, so `__proto__` is an ordinary key.
- `contentHash(value)`: SHA-256 of the record's RFC 8785 (JCS) canonical form. Only the
  toolkit computes it; a storing application keeps the hash the server echoes.
- `schema/machine-record-v1.schema.json`: JSON Schema draft 2020-12 for other
  languages. It's a subset of `validateMachine`, which is authoritative.
- `examples/example-router.json`: a fictional, uncalibrated example record.

It stays `"private": true` until the release pipeline exists.
