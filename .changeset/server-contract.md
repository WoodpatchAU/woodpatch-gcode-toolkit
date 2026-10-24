---
'@woodpatch/gcode-server': minor
'@woodpatch/gcode-db': patch
---

The `/estimate` wire contract, version 1 (ADR-0044): `parseRequest` (strict, with the
size caps and a closed list of error codes), `mapRecord` (a machine record onto the
estimator and the travel check, with every field accounted for), `handleEstimate` (one
estimate, with every list capped), and JSON Schemas for the request, the response and
the error body. `@woodpatch/gcode-db` now exports `quoteKey`, and its schema gives
`residuals.jobs` the code's maximum (`Number.MAX_SAFE_INTEGER`).
