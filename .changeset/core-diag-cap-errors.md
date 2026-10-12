---
'@woodpatch/gcode-core': patch
---

The interpreter's diagnostic cap never hides an error: past `limits.maxDiagnostics`, the
first error is still kept, and the `SEMANTIC_DIAGNOSTICS_TRUNCATED` note takes the worst
severity among what it stands for, and says how many of those were errors.
