<!--
SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
SPDX-License-Identifier: MIT
-->
<!--
  @component
  A CodeMirror 6 editor for G-code: highlighting from the toolkit's own tokenizer,
  diagnostics in the gutter, O-word folding, and line ↔ path sync.

  CodeMirror and the editor package are loaded by a dynamic import when the component
  mounts. Until then (and during server rendering) it's an empty box. `value` is
  bindable. Colours come from CSS custom properties, with dark defaults:
  --gcode-bg, --gcode-text, --gcode-panel, --gcode-muted, --gcode-line,
  --gcode-selection.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Compartment, Extension } from '@codemirror/state';
  import type { EditorView } from '@codemirror/view';
  import type { showDiagnostics, showPathLine } from '@woodpatch/gcode-editor';
  import type { LoadedProgram } from '@woodpatch/gcode-viewer';

  interface Props {
    /** The program text. Bindable: edits flow back out. */
    value?: string;
    /** Diagnostics to show in the gutter (a loaded program's). */
    diagnostics?: LoadedProgram['diagnostics'];
    /** A line to mark as the one picked on the path (scrolled to, cursor unmoved). */
    pathLine?: number | null;
    /** The cursor moved to another line. */
    oncursorline?: (line: number) => void;
    /** Read-only. Can change at any time. */
    readonly?: boolean;
    /** Dark (default) or light token colours. Can change at any time. */
    dark?: boolean;
    /**
     * The longest document allowed, in characters (UTF-16 code units, not bytes).
     * Default 20 Mi. An edit past it (paste, drop, typing) is refused, and so is a longer
     * `value` from the host: the editor keeps its text and `value` is set back to it.
     * Either way, `ontoolarge` is told.
     */
    maxLength?: number | undefined;
    /** Something longer than `maxLength` was refused; its length in characters. */
    ontoolarge?: ((length: number) => void) | undefined;
    /** CodeMirror or the editor package failed to load (a chunk error, a CSP block). */
    onerror?: ((error: Error) => void) | undefined;
    /** More CodeMirror extensions, added after the built-in ones. Read once. */
    extensions?: Extension[];
    class?: string;
  }

  let {
    value = $bindable(''),
    diagnostics = [],
    pathLine = null,
    oncursorline,
    readonly = false,
    dark = true,
    maxLength = 20 * 1024 * 1024,
    ontoolarge,
    onerror,
    extensions = [],
    class: className = '',
  }: Props = $props();

  let host: HTMLDivElement;
  let editor = $state.raw<EditorView | null>(null);
  // The editor package's sync functions, once it has loaded.
  let lib = $state.raw<{
    showDiagnostics: typeof showDiagnostics;
    showPathLine: typeof showPathLine;
  } | null>(null);
  /** The text the editor last reported, so an echo of it isn't dispatched back in. */
  let echoed = '';
  /** Compartments for the settings that can change after mount, and how to fill them. */
  let settings: {
    readOnly: Compartment;
    theme: Compartment;
    readOnlyOf: (on: boolean) => Extension;
    themeOf: (dark: boolean) => Extension;
  } | null = null;

  const themeSpec = {
    '&': {
      height: '100%',
      color: 'var(--gcode-text, #e6e6ea)',
      backgroundColor: 'var(--gcode-bg, #1b1b1f)',
    },
    '.cm-scroller': { overflow: 'auto' },
    '.cm-content': { caretColor: 'var(--gcode-text, #e6e6ea)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--gcode-text, #e6e6ea)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'var(--gcode-selection, #3a4a6b)' },
    '.cm-activeLine': { backgroundColor: '#8080800f' },
    '.cm-gutters': {
      backgroundColor: 'var(--gcode-panel, #232329)',
      color: 'var(--gcode-muted, #a0a0aa)',
      borderRight: '1px solid var(--gcode-line, #34343c)',
    },
    '.cm-activeLineGutter': { backgroundColor: '#8080801f' },
    '.cm-tooltip': {
      backgroundColor: 'var(--gcode-panel, #232329)',
      color: 'var(--gcode-text, #e6e6ea)',
      border: '1px solid var(--gcode-line, #34343c)',
    },
  };

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
    void Promise.all([
      import('@codemirror/state'),
      import('@codemirror/view'),
      import('@codemirror/commands'),
      import('@codemirror/language'),
      import('@woodpatch/gcode-editor'),
    ]).then(([state, cmView, commands, language, gcodeLib]) => {
      if (!live) return;
      const { EditorState, Compartment: C } = state;
      const { EditorView: View, keymap } = cmView;
      settings = {
        readOnly: new C(),
        theme: new C(),
        readOnlyOf: (on) => EditorState.readOnly.of(on),
        themeOf: (d) => View.theme(themeSpec, { dark: d }),
      };
      // The cap applies to the first document too.
      if (value.length > maxLength) {
        ontoolarge?.(value.length);
        value = '';
      }
      echoed = value;
      editor = new View({
        parent: host,
        state: EditorState.create({
          doc: value,
          extensions: [
            cmView.lineNumbers(),
            cmView.highlightActiveLineGutter(),
            language.foldGutter(),
            commands.history(),
            cmView.drawSelection(),
            cmView.highlightActiveLine(),
            keymap.of([...commands.defaultKeymap, ...commands.historyKeymap, ...language.foldKeymap]),
            settings.readOnly.of(settings.readOnlyOf(readonly)),
            gcodeLib.gcode({ onCursorLine: (n) => oncursorline?.(n) }),
            // Refuse any edit that would take the document past the cap. (The host's
            // own replacements bypass this and are checked in the value effect.)
            EditorState.transactionFilter.of((tr) => {
              if (!tr.docChanged || tr.newDoc.length <= maxLength) return tr;
              const length = tr.newDoc.length;
              queueMicrotask(() => ontoolarge?.(length));
              return [];
            }),
            View.updateListener.of((u) => {
              if (!u.docChanged) return;
              echoed = u.state.doc.toString();
              value = echoed;
            }),
            settings.theme.of(settings.themeOf(dark)),
            ...extensions,
          ],
        }),
      });
      lib = { showDiagnostics: gcodeLib.showDiagnostics, showPathLine: gcodeLib.showPathLine };
    }, (e: unknown) => {
      if (live) onerror?.(e instanceof Error ? e : new Error(String(e)));
    });
    return () => {
      live = false;
      editor?.destroy();
    };
  });

  // A new value from outside (a file opened, a sample picked) replaces the document.
  // Past the cap it's refused, and `value` is set back to what the editor shows, so the
  // two never disagree (and a host parsing `value` never reads text nobody can see).
  $effect(() => {
    const v = value;
    if (!editor || v === echoed) return;
    if (v.length > maxLength) {
      ontoolarge?.(v.length);
      value = echoed;
      return;
    }
    echoed = v;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: v },
      filter: false,
    });
  });
  $effect(() => {
    const on = readonly;
    if (editor && settings) editor.dispatch({ effects: settings.readOnly.reconfigure(settings.readOnlyOf(on)) });
  });
  $effect(() => {
    const d = dark;
    if (editor && settings) editor.dispatch({ effects: settings.theme.reconfigure(settings.themeOf(d)) });
  });
  $effect(() => {
    if (editor && lib) lib.showDiagnostics(editor, diagnostics);
  });
  $effect(() => {
    if (editor && lib) lib.showPathLine(editor, pathLine);
  });

  /** Moves the cursor to a line (1-based), scrolls to it and focuses the editor. */
  export function goToLine(n: number): void {
    if (!editor || !Number.isInteger(n) || n < 1 || n > editor.state.doc.lines) return;
    editor.dispatch({ selection: { anchor: editor.state.doc.line(n).from }, scrollIntoView: true });
    editor.focus();
  }
</script>

<div class="gcode-editor {className}" bind:this={host}></div>

<style>
  .gcode-editor {
    min-height: 0;
    height: 100%;
    overflow: hidden;
  }
</style>
