---
'@woodpatch/gcode-core': patch
---

The tokenizer lists at most 100 findings per line of every kind, not just unexpected
characters, and one note stands for the rest with the worst severity among them. A line
of bare letters no longer makes one finding per letter.

Also of note from the change that bounded expressions: `#` indirection now stops at 65
levels (`EXPR_TOO_DEEP`), where deeper chains used to read.
