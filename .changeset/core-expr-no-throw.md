---
'@woodpatch/gcode-core': patch
---

The interpreter never throws on hostile expressions: `#` indirection is bounded like any
nesting (`EXPR_TOO_DEEP`), and a flat operator chain of any length evaluates without
recursion. The tokenizer reports a run of the same unexpected character once, at most
100 distinct ones per line, and each finding once.
