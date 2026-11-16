---
'@woodpatch/gcode-core': minor
---

`checkStock(steps, shapes, { toolRadius, startKnown })`: rapids that reach into the
stock. The operator supplies the stock as boxes (`StockBox`: lowest corner and size, in
the path's coordinates). A rapid is flagged where the tool, a vertical cylinder from
its tip up, is below a box's top over its footprint (`STOCK_RAPID_COLLISION`). Feed
moves are cutting and are never flagged; touching isn't a collision. Also
`validateStock` and `rapidHitsBox` (ADR-0054).
