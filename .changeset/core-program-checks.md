---
'@woodpatch/gcode-core': minor
'@woodpatch/gcode-viewer': minor
---

Whole-job checks: `programChecks(program, result, dialect)` warns when a job doesn't end
the way the controller needs (Masso: M30, with M5 first; others: M2 or M30), when M3/M4
has no speed, and when it cuts with the spindle off (a tool change stops it).
`InterpretResult.completed` says whether the run reached the end. Per-dialect rules
(`InterpreterRules.programChecks`). `loadProgram` includes them in its diagnostics.
