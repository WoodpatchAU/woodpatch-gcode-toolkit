<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->
<!--
  @component
  The toolpath of a loaded program, in 3D (three.js) or as a 2D plan (Canvas 2D).

  The viewer package, and three.js with it, is loaded by a dynamic import when the
  component mounts: never during server rendering, and never before the page needs it.
  So a prerendered page that contains this component pays nothing for it until it
  hydrates. Each view is created the first time its mode is shown, and both keep their
  camera when hidden.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    GcodeView2D,
    GcodeViewer,
    LoadedProgram,
    PickEvent,
    View2DOptions,
    ViewerOptions,
    ViewName,
  } from '@woodpatch/gcode-viewer';

  interface Props {
    /** The program to show: from `ProgramLoader` or `loadProgram`. */
    program?: LoadedProgram | null;
    /** '3d' (default) or 'plan', the top-down 2D view. */
    mode?: '3d' | 'plan';
    /** The 3D camera direction. Changing it moves the camera. */
    view?: ViewName;
    /** A source line to highlight in both views, or null. */
    highlightLine?: number | null;
    /** A click on the path: the segment and its source line. */
    onpick?: (e: PickEvent) => void;
    /** Options for the 3D view (palette, line width). Read once, when it's created. */
    options3d?: ViewerOptions;
    /** Options for the 2D view (palette, line width, pick radius). Read once. */
    options2d?: View2DOptions;
    /** The viewer package failed to load (a chunk error, a CSP block). */
    onerror?: ((error: Error) => void) | undefined;
    class?: string;
  }

  let {
    program = null,
    mode = '3d',
    view = 'iso',
    highlightLine = null,
    onpick,
    options3d,
    options2d,
    onerror,
    class: className = '',
  }: Props = $props();

  let el3d: HTMLDivElement;
  let el2d: HTMLDivElement;
  // The two view classes, once the viewer package has loaded.
  let lib = $state.raw<{
    GcodeViewer: typeof GcodeViewer;
    GcodeView2D: typeof GcodeView2D;
  } | null>(null);
  let v3 = $state.raw<GcodeViewer | null>(null);
  let v2 = $state.raw<GcodeView2D | null>(null);

  // The MIT notice (ADR-0030). It sits on the onMount call because a bundler keeps a
  // comment only with the statement after it, and this call is never removed.
  /*!
   * @woodpatch/gcode-svelte: Woodpatch G-code Toolkit
   * Based on webgcode by Nicolas Raynaud (https://github.com/nraynaud/webgcode).
   *
   * MIT License
   *
   * Copyright (c) 2016 Nicolas Raynaud
   * Copyright (c) 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  onMount(() => {
    let live = true;
    void import('@woodpatch/gcode-viewer').then(
      (m) => {
        if (live) lib = { GcodeViewer: m.GcodeViewer, GcodeView2D: m.GcodeView2D };
      },
      (e: unknown) => {
        if (live) onerror?.(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => {
      live = false;
      v3?.dispose();
      v2?.dispose();
    };
  });

  // Create each view the first time its mode is shown.
  $effect(() => {
    if (!lib) return;
    if (mode === '3d' && !v3) {
      const v = new lib.GcodeViewer(el3d, options3d);
      v.onPick((e) => onpick?.(e));
      v3 = v;
    } else if (mode === 'plan' && !v2) {
      const v = new lib.GcodeView2D(el2d, options2d);
      v.onPick((e) => onpick?.(e));
      v2 = v;
    }
  });

  // Each view gets the program separately, so creating one view doesn't reset the other.
  $effect(() => {
    if (v3 && program) v3.setProgram(program);
  });
  $effect(() => {
    if (v2 && program) v2.setProgram(program);
  });
  $effect(() => {
    v3?.highlightLine(highlightLine);
  });
  $effect(() => {
    v2?.highlightLine(highlightLine);
  });
  $effect(() => {
    v3?.setView(view);
  });

  /** Frames the whole path in the current view. */
  export function fit(): void {
    if (mode === 'plan') v2?.fit();
    else v3?.setView(view);
  }
</script>

<div class="gcode-viewer {className}">
  <div class="pane" bind:this={el3d} hidden={mode !== '3d'} aria-label="3D toolpath"></div>
  <div class="pane" bind:this={el2d} hidden={mode !== 'plan'} aria-label="2D plan"></div>
</div>

<style>
  .gcode-viewer {
    position: relative;
    min-height: 0;
    width: 100%;
    height: 100%;
  }
  .pane {
    position: absolute;
    inset: 0;
  }
  .pane[hidden] {
    display: none;
  }
</style>
