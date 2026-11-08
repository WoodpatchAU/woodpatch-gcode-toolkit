---
"@woodpatch/gcode-core": patch
"@woodpatch/gcode-viewer": patch
"@woodpatch/gcode-editor": patch
---

The packages no longer ship declaration maps (`*.d.ts.map`): they pointed at `src/`, which the packages don't include. JavaScript source maps, with their sources, still ship.
