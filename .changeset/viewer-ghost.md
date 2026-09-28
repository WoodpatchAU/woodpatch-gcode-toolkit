---
'@woodpatch/gcode-viewer': minor
---

`setGhost(program | null)` on `GcodeViewer` and `GcodeView2D`: draws another program
faintly behind the current one (the original under a transformed result), never
pickable, and framed together with it. New palette colour `ghost`.
