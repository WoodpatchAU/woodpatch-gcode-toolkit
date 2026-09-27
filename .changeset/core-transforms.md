---
'@woodpatch/gcode-core': minor
---

Transforms: `transform(program, ops)` and `transformText(source, ops)` apply a recipe of
`translate`, `rotate` (any angle about any point; 90° multiples exact), `mirror` (X or Y,
about a line) and `scale` by editing words in place. Untouched lines stay byte-for-byte.
Anything that can't be transformed faithfully is refused with diagnostics naming the
lines (expressions, G92, planes and uneven arc scales, unknown positions). A mirror warns
that the cut direction reverses.
