---
'@woodpatch/gcode-core': minor
'@woodpatch/gcode-viewer': minor
---

Whole-job checks: `programChecks(program, steps, dialect)` warns when a job doesn't end
the way the controller needs (Masso: M30, with M5 first; others: M2 or M30), when M3/M4
has no speed, and when it cuts with the spindle off. Per-dialect rules
(`InterpreterRules.programChecks`). `loadProgram` includes them in its diagnostics.
