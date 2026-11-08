---
'@woodpatch/gcode-core': minor
---

`estimateTime`: arcs are planned in pieces of at most 2 degrees, each with its own speed, acceleration and centripetal limits (the centripetal one from the arc's normal), so an arc runs fast where its fast axis carries it. Arcs out of the XY plane on a machine with a slow axis were estimated up to about 200o long. Look-ahead and the block-rate floor still count an arc as one block (ADR-0052).
