---
'@woodpatch/gcode-core': minor
---

`estimateTime(result, machine)`: the machining-time estimate (ADR-0043). It uses a
trapezoidal planner with per-axis limits projected onto each move, GRBL's junction
deviation at corners, arcs with their centripetal limit, an exact look-ahead window, and
a block-rate floor. Spindle delays, tool changes, pauses and dwells are added. Time it
can't work out (a feed it can't turn into a speed, a wait, a refused line) is listed,
never guessed, and marks the estimate incomplete. The output is integer milliseconds.
