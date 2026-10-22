---
'@woodpatch/gcode-core': minor
---

`checkTravel(steps, travel)`: does a program stay inside the machine's travel? It warns
only when that's certain whatever the operator's work offsets, tool lengths and cutter
radii are: a move to a known machine position outside the limits, or positions sharing
one unknown offset that span more than an axis's travel. Linear and arc steps carry a
`frame` (what's known of where they end), and `interpret` takes `workOffsets`, the
operator's offsets when they're known, which makes every move under them checkable.
