<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# @woodpatch/gcode-svelte

Svelte 5 components for G-code: the toolkit's editor and viewer (3D and 2D plan), in
sync (ADR-0030). **Shipped as source.** Your Svelte compiles the `.svelte` files, so they
work with whichever Vite and Svelte 5 your app uses.

| Component        | What it is                                                                           |
| ---------------- | ------------------------------------------------------------------------------------ |
| `GcodeWorkbench` | Editor + viewer in sync, reading the program in a worker. The playground's core.     |
| `GcodeViewer`    | The toolpath: `mode` `'3d'` (three.js) or `'plan'` (Canvas 2D).                      |
| `GcodeEditor`    | CodeMirror 6 with G-code highlighting, diagnostics and folding. `value` is bindable. |

```svelte
<script lang="ts">
  import { GcodeWorkbench, type LoadedProgram } from '@woodpatch/gcode-svelte';

  let value = $state('G21 G90\nG0 X10 Y10\nG1 Z-1 F100\nG2 X20 Y10 R5');
  let program = $state.raw<LoadedProgram | null>(null); // raw: see below
</script>

<GcodeWorkbench
  bind:value
  bind:program
  dialect="masso-g3-5.13"
  createWorker={() =>
    new Worker(new URL('./gcode-worker.ts', import.meta.url), { type: 'module' })}
/>
```

```ts
// src/gcode-worker.ts: one line. Your bundler builds the worker; a package can't.
import '@woodpatch/gcode-svelte/worker';
```

## What your app must provide

- **Peer dependencies:** `svelte` `^5.56.4`, `three` `>=0.186.0 <0.187.0`, and
  `@codemirror/{commands,language,lint,state,view}`. Pin exact versions in the app.
- **Keep legal comments in your production build.** Each component carries the MIT
  notice in a `/*!` comment, and MIT requires it in built copies too. Tested with these
  components (2026-09-27):
  - **Vite 8 (rolldown) drops them by default.** Set
    `build.rolldownOptions.output.comments = { legal: true }`.
  - Vite 6.4 (Rollup + the esbuild minifier) keeps them with its defaults.
  - Either way, grep your built chunks for `Nicolas Raynaud` in CI, as the playground
    does. A toolchain upgrade can change this silently.
- **A CSP that allows inline styles** (`style-src 'self' 'unsafe-inline'` or a nonce):
  CodeMirror injects its styles at run time. No `unsafe-eval` is needed.

## Behaviour worth knowing

- **Nothing heavy loads until mount.** Importing the package loads no three.js and no
  CodeMirror: each component imports them dynamically when it mounts, and never during
  server rendering. A prerendered page carrying the component pays for it only when the
  island hydrates. (A test fails if a component ever imports them statically.)
- **Bind `program` to `$state.raw`.** A loaded program holds large typed arrays. Plain
  `$state` would wrap it in Svelte's deep proxy for no benefit.
- **Input is capped** at 20 Mi characters (`maxLength`: UTF-16 code units, not bytes).
  An edit past it is refused. So is a longer `value` from your app: the editor keeps its
  text and `value` is set back to it. Either way, `ontoolarge(length)` is called. Cap
  files your app opens by size before reading them, as the playground does.
- **`onerror`** reports a part that failed to load (a chunk error, a CSP block), and on
  the workbench, a program that failed to read or took too long.
- `readonly` and `dark` can change at any time. `extensions`, `options3d` and `options2d`
  are read once, at mount.
- **Colours:** dark by default. Override with CSS custom properties on an ancestor:
  `--gcode-bg`, `--gcode-text`, `--gcode-panel`, `--gcode-muted`, `--gcode-line`,
  `--gcode-selection`; `--gcode-columns` sets the workbench's grid columns. Pass
  `dark={false}` to `GcodeEditor` for the light token colours.
- **Imperative bits** via `bind:this`: `GcodeViewer.fit()`, `GcodeEditor.goToLine(n)`,
  `GcodeWorkbench.fit()` and `.goToLine(n)` (for example, from a diagnostics list).
- Render diagnostics as text, never HTML: a message can quote the G-code it's about.
