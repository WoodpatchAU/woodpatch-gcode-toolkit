---
'@woodpatch/gcode-core': minor
---

Arc to line conversion: `{ op: 'arcs', tolerance?, lines?, radius?: { min?, max? }, assume? }`
turns G2/G3 arcs into G1 chords within `tolerance` mm of the true arc (default 0.01).
The rest of each arc's line is kept on its first chord; the last chord ends exactly
where the arc did (G91 arcs carry each chord's rounding into the next). An arc that
would convert differently on different runs (a subroutine called from two places, a
block-deleted move before it), and anything chords can't carry faithfully, is refused.
