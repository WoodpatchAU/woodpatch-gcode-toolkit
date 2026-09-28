---
'@woodpatch/gcode-core': minor
---

Feed and spindle overrides: `{ op: 'feed', percent, only?: 'cut' | 'plunge', lines? }`
and `{ op: 'spindle', percent, lines? }`. A selective feed override gives the affected
lines their own F and restores the original after them, since F is modal.
