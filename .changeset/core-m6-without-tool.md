---
'@woodpatch/gcode-core': minor
---

M6 with no tool selected is an error on LinuxCNC and the generic dialect, as LinuxCNC
refuses the change ("Need tool prepared -Txx- for toolchange"): nothing changes, so the
spindle keeps running and the tool stays loaded. A new interpreter rule,
`toolChangeWithoutTool: 'error' | 'warning'`, sets it per dialect. Masso keeps the
warning and models the change until a machine test confirms what it does.
