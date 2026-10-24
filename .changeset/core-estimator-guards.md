---
'@woodpatch/gcode-core': patch
---

`estimateTime` names what a JavaScript caller got wrong: a `rapidModel` other than
`'coordinated'` or `'per-axis'` (which would otherwise run as coordinated), a
`rapidModelConfirmed` that isn't a boolean, and a required field left out. Each throws a
`RangeError` naming the field, where before it could fail later as "the estimate is not
finite".
