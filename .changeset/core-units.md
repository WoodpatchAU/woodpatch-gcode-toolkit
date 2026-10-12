---
'@woodpatch/gcode-core': minor
---

Units conversion: `{ op: 'units', to: 'mm' | 'inch', assume }` converts every length and
feed, and the G20/G21 words (inches at 5 decimals, so mm → inch → mm is within 1 µm).
`interpret` takes a `units` option: the units assumed for a program that states none
(the user's preference), with a warning when a program relies on it.
`interpret` also takes an `onBlock` hook: the modal state each executed block runs under.
