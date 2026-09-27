<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->

# @woodpatch/gcode-viewer

The 3D view of a G-code program: three.js, framework-free, worker-backed (ADR-0026).

```ts
import { GcodeViewer, ProgramLoader } from '@woodpatch/gcode-viewer';

const loader = new ProgramLoader(
  () => new Worker(new URL('@woodpatch/gcode-viewer/worker', import.meta.url), { type: 'module' }),
);
const viewer = new GcodeViewer(document.getElementById('view')!);

viewer.setProgram(await loader.load(text, { dialect: 'generic' }));
viewer.onPick(({ line }) => console.log('clicked line', line));
viewer.highlightLine(42);
```

- **three.js is a peer dependency** (`>=0.186.0 <0.187.0`): your app provides it, so a
  page never carries two copies.
- Lines are drawn at a real width (`lineWidth`, CSS px), not WebGL's fixed 1 px.
- Rendering happens only after a change. An idle view costs nothing.
- **Cancellation and the time budget.** A new `load()`, an abort, or the loader's time
  budget (`new ProgramLoader(factory, { timeoutMs })`, default 30 s) terminates the busy
  worker, so a huge or hostile file can't hold the page. To give one load a shorter
  budget, pass `AbortSignal.timeout(ms)` as its signal.
- **Render diagnostics as text, never HTML.** A diagnostic's message can quote the
  G-code it's about, and a public file can contain anything.
- `dispose()` frees the WebGL context too, so views can be mounted and unmounted freely.
- If you write your own worker file, `import '@woodpatch/gcode-viewer/worker'` is kept
  by bundlers: the package declares that entry as having side effects.

## The 2D plan view

`GcodeView2D` draws the same `LoadedProgram` from above (machine X/Y) on a Canvas 2D,
without WebGL (ADR-0029). It has the same `setProgram`, `highlightLine`, `onPick`, `fit`
and `dispose`, so a host can offer both views and switch between them.

```ts
import { GcodeView2D } from '@woodpatch/gcode-viewer';

const plan = new GcodeView2D(document.getElementById('plan')!);
plan.setProgram(program); // the same program the 3D view shows
plan.onPick(({ line }) => editor.showPathLine(line));
```

- Drag to pan, scroll to zoom about the pointer, `fit()` to frame the path.
- The grid adapts to the zoom (1, 2 or 5 × 10ⁿ mm) and is labelled in mm. The
  machine's X and Y axes are drawn through the origin.
- A click picks the nearest segment within `pickRadius` CSS px (default 6), in plan.
  Rapids are drawn on top of cuts (they travel above them). Among segments within a
  pixel of the nearest, the one drawn on top is picked: a rapid over a cut, then the
  later segment. So a click picks what it lands on.
- It doesn't import three.js, so a bundler drops the 3D view if you only use this one.
  three.js is still a peer dependency of the package.

## Frame statistics

`viewer.onRender(info => …)` on the 3D view (`GcodeViewer`; the 2D plan has none) reports
each frame drawn: `ms` (the CPU time of three.js's
render call; the GPU finishes asynchronously), `drawCalls` and `segments`. The view
draws on demand, so frames arrive only while something changes. Count them while
orbiting to get a frame rate. The playground's `?stats` overlay is built on it
(ADR-0031).
