---
'@woodpatch/gcode-core': patch
---

Transforms: after a machine or home Z retract (G53/G28/G30), rapids with no Z word are
allowed under a Z translation or scale. They travel at the retract height, as intended.
Feed moves, canned cycles and Z words are still refused until Z is given again
absolutely.
