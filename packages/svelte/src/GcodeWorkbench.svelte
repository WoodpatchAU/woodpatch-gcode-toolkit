<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->
<!--
  @component
  The editor and the viewer in sync, reading the program in a worker: the playground's
  core, as one component. The cursor highlights its path, and a click on the path marks
  its line. Edits are re-read `delay` ms after typing stops; a newer read cancels the
  older one.

  The host supplies the worker, because only the host's bundler can build it:

      // src/gcode-worker.ts (one line)
      import '@woodpatch/gcode-svelte/worker';

      <GcodeWorkbench
        createWorker={() => new Worker(new URL('./gcode-worker.ts', import.meta.url), { type: 'module' })}
        bind:value bind:program />
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { LoadedProgram, PickEvent, ProgramLoader, ViewName } from '@woodpatch/gcode-viewer';
  import GcodeEditor from './GcodeEditor.svelte';
  import GcodeViewer from './GcodeViewer.svelte';

  interface Props {
    /** The program text. Bindable. */
    value?: string;
    /** The controller dialect id: 'generic' (default), 'linuxcnc-2.9', 'masso-g3-5.13'. */
    dialect?: string;
    /** Makes the worker that reads programs. See the component's doc comment. */
    createWorker: () => Worker;
    /** The last program read. Bindable, read-only from outside. */
    program?: LoadedProgram | null;
    mode?: '3d' | 'plan';
    view?: ViewName;
    /** ms after the last edit before it's re-read. Default 400. */
    delay?: number;
    /** A read's time budget in ms. Default 30 s (the loader's). */
    timeoutMs?: number;
    /** A read finished: the program and how long it took (ms). */
    onload?: (program: LoadedProgram, ms: number) => void;
    /**
     * A read failed or took too long (not when a newer read superseded it), or a part
     * of the workbench failed to load.
     */
    onerror?: (error: Error) => void;
    /** Passed to the editor: see GcodeEditor. */
    readonly?: boolean;
    dark?: boolean;
    maxLength?: number;
    ontoolarge?: (length: number) => void;
    class?: string;
  }

  let {
    value = $bindable(''),
    dialect = 'generic',
    createWorker,
    program = $bindable(null),
    mode = '3d',
    view = 'iso',
    delay = 400,
    timeoutMs,
    onload,
    onerror,
    readonly = false,
    dark = true,
    maxLength,
    ontoolarge,
    class: className = '',
  }: Props = $props();

  let loader = $state.raw<ProgramLoader | null>(null);
  let cursor = $state<number | null>(null);
  let picked = $state<number | null>(null);
  let editorRef: GcodeEditor;
  let viewerRef: GcodeViewer;

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
      ({ ProgramLoader }) => {
        if (!live) return;
        loader = new ProgramLoader(createWorker, timeoutMs === undefined ? {} : { timeoutMs });
      },
      (e: unknown) => {
        if (live) onerror?.(e instanceof Error ? e : new Error(String(e)));
      },
    );
    return () => {
      live = false;
      loader?.dispose();
    };
  });

  // Re-read the program a moment after the text or the dialect last changed.
  $effect(() => {
    const text = value;
    const d = dialect;
    const l = loader;
    if (!l) return;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      l.load(text, { dialect: d }).then(
        (p) => {
          program = p;
          picked = null;
          onload?.(p, performance.now() - t0);
        },
        (e: Error) => {
          if (e.name !== 'AbortError') onerror?.(e);
        },
      );
    }, delay);
    return () => clearTimeout(timer);
  });

  function onpick(e: PickEvent): void {
    if (e.line < 1) return;
    picked = e.line;
    cursor = e.line;
  }

  /** Moves the editor to a line (for example, a diagnostic's). */
  export function goToLine(n: number): void {
    editorRef?.goToLine(n);
  }
  /** Frames the whole path in the current view. */
  export function fit(): void {
    viewerRef?.fit();
  }
</script>

<div class="gcode-workbench {className}">
  <GcodeEditor
    bind:this={editorRef}
    bind:value
    diagnostics={program?.diagnostics ?? []}
    pathLine={picked}
    oncursorline={(n) => (cursor = n)}
    {readonly}
    {dark}
    {maxLength}
    {ontoolarge}
    {onerror}
  />
  <GcodeViewer
    bind:this={viewerRef}
    {program}
    {mode}
    {view}
    highlightLine={cursor}
    {onpick}
    {onerror}
  />
</div>

<style>
  .gcode-workbench {
    display: grid;
    grid-template-columns: var(--gcode-columns, minmax(16rem, 2fr) 3fr);
    min-height: 0;
    height: 100%;
  }
</style>
