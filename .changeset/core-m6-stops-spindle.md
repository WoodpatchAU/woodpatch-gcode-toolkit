---
'@woodpatch/gcode-core': minor
---

A tool change (M6) stops the spindle in the interpreter's own state, on dialects where it
does (`toolChangeStopsSpindle`): a spindle `off` step with `by: 'tool-change'`, before
any M3/M4 on the same line. The summary's cutting-with-the-spindle-off and the whole-job
checks see it.
