---
'@woodpatch/gcode-viewer': patch
---

`GcodeView2D` picks what a click lands on. Among segments within a pixel of the nearest,
the one drawn on top wins (a rapid over a cut). `nearestSegment` takes an optional
`tie` distance for this.
