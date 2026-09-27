---
'@woodpatch/gcode-svelte': minor
---

First release: `GcodeWorkbench`, `GcodeViewer` and `GcodeEditor`, Svelte 5 components
shipped as source (Svelte `^5.56.4` peer). three.js and CodeMirror load on mount, never
during server rendering. The `./worker` entry is the one-line worker a host builds.
