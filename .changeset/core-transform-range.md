---
'@woodpatch/gcode-core': patch
---

Transforms refuse results no controller could read (non-finite, or beyond ±1,000,000:
`TRANSFORM_OUT_OF_RANGE`) instead of writing `1e+308` or `Infinity`, and the number
formatter throws rather than emit an exponent. New exports: `MAX_WRITTEN`, `writable`.
