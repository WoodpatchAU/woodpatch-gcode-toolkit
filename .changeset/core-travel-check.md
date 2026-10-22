---
'@woodpatch/gcode-core': minor
---

`checkTravel(steps, travel)`: does a program stay inside the machine's travel? It warns
only when that's certain whatever the operator's work offsets, tool lengths and cutter
radii are: a move to a known machine position outside the limits, or positions sharing
one unknown offset that span more than an axis's travel. Linear and arc steps carry a
`frame` (what's known of where they end). `interpret` takes `workOffsets`, the
operator's offsets when they're known (supplying them states that G92 is off), and
`toolLengthOffsetAtStart`; with both, every move under the offsets is checked exactly.
