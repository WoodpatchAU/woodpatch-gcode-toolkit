---
'@woodpatch/gcode-core': patch
---

Follow-ups from review:

- The interpreter is the one source of truth for a tool change stopping the spindle:
  Masso's M6.1 (unload) stops it too, and the stop comes before the tool change, as in
  LinuxCNC. The rule also applies to the generic dialect (it inherits LinuxCNC's).
- A malformed `##` parameter reference is reported from its innermost `#` again.
