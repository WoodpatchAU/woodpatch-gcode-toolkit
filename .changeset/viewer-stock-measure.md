---
'@woodpatch/gcode-viewer': minor
---

Stock and measurements in the 3D view (ADR-0054). `setStock(items)` draws boxes on the
table (translucent faces, solid edges; each with its own visibility, colour and opacity)
and the views frame the visible stock with the path. `showCollisions(lines)` draws
those lines' segments on top in the collision colour, and `stockCollisions(program,
shapes, options)` runs the core's stock check on a loaded path, so a page can re-check
as the stock changes without loading the program again. `showDimensions(on)` shows the
box round the path with its X, Y and Z lengths and corner coordinates (labels are DOM
elements over the canvas). `Palette` gains `stock`, `collision` and `dimension`.
