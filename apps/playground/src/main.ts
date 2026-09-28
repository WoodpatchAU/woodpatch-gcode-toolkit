// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { Annotation, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { DIALECTS, GENERIC, type Diagnostic } from '@woodpatch/gcode-core';
import { gcode, showDiagnostics, showPathLine } from '@woodpatch/gcode-editor';
import {
  GcodeView2D,
  GcodeViewer,
  ProgramLoader,
  type LoadedProgram,
  type ViewName,
} from '@woodpatch/gcode-viewer';
import { installStats } from './stats.js';
import { renderSummary } from './summary.js';
import { installTransformPanel } from './transforms.js';

/**
 * The public playground (parcel 3c, ADR-0028): the viewer and the editor in sync.
 * Everything runs in the browser; nothing is uploaded. User-supplied text only ever
 * reaches the page through textContent, never as HTML.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');
const statsEl = $('stats');
const diagList = $<HTMLOListElement>('diagnostics');
const dialectSel = $<HTMLSelectElement>('dialect');
const sampleSel = $<HTMLSelectElement>('sample');

// Controllers: generic by default (operator decision, Phase 3), Masso one click away.
for (const d of [GENERIC, ...DIALECTS.filter((x) => x !== GENERIC)]) {
  const o = document.createElement('option');
  o.value = d.id;
  o.textContent = d.name;
  dialectSel.append(o);
}
dialectSel.value = GENERIC.id;

const viewer = new GcodeViewer($('view'));
const recordLoad = installStats(viewer, $('view'));
// The 2D plan (parcel 3d, ADR-0029) sits over the 3D view and is shown by the "2D"
// button. Both views get every program and highlight, so switching is instant.
const planEl = $('plan');
const plan = new GcodeView2D(planEl);
const highlight = (n: number | null) => {
  viewer.highlightLine(n);
  plan.highlightLine(n);
};
// One worker script, written once here so the bundler emits it once: the loader, the
// transform panel and the original's loader each run their own instance of it.
const makeWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const loader = new ProgramLoader(makeWorker);
/** Marks the editor changes the page makes itself (a file opened, a transform). */
const programmatic = Annotation.define<boolean>();
let currentName = 'program.nc';
let currentView: ViewName = 'iso';

/**
 * The core's own limit for public input is 20 MB (plan §4.8). It applies to every way
 * in: opened and dropped files (by size, before reading), and anything that would make
 * the editor's document bigger (paste, a text drop, typing), by length.
 */
const MAX_INPUT = 20 * 1024 * 1024;

const editor = new EditorView({
  parent: $('editor'),
  state: EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
      // The page is dark, so the editor is too. `dark: true` also selects the editor
      // package's dark token colours; without it, CodeMirror used the light ones and
      // plain words were near-black on the dark background.
      EditorView.theme(
        {
          '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-content': { caretColor: 'var(--text)' },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
            { backgroundColor: '#3a4a6b' },
          '.cm-activeLine': { backgroundColor: '#ffffff0a' },
          '.cm-gutters': {
            backgroundColor: 'var(--panel)',
            color: 'var(--muted)',
            borderRight: '1px solid var(--line)',
          },
          '.cm-activeLineGutter': { backgroundColor: '#ffffff12', color: 'var(--text)' },
          '.cm-foldPlaceholder': {
            backgroundColor: 'var(--panel)',
            color: 'var(--muted)',
            border: '1px solid var(--line)',
          },
          '.cm-tooltip': {
            backgroundColor: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--line)',
          },
        },
        { dark: true },
      ),
      gcode({ onCursorLine: highlight }),
      // Refuse any edit that would take the document over the cap.
      EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged || tr.newDoc.length <= MAX_INPUT) return tr;
        queueMicrotask(() => (status.textContent = 'Over 20 MB; not inserted'));
        return [];
      }),
      // Re-read the program a moment after the user stops typing.
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        if (!u.transactions.some((t) => t.annotation(programmatic))) panel.handEdited();
        scheduleReload();
      }),
    ],
  }),
});

const onPick = ({ line }: { line: number }) => {
  if (line < 1) return;
  highlight(line);
  showPathLine(editor, line);
};
viewer.onPick(onPick);
plan.onPick(onPick);

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void reload(), 400);
}

/** Parses the editor's text in the worker, then updates the view and the panels. */
async function reload(): Promise<void> {
  const text = editor.state.doc.toString();
  status.textContent = 'Reading…';
  const t0 = performance.now();
  let program: LoadedProgram;
  try {
    program = await loader.load(text, { dialect: dialectSel.value });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') return; // superseded by a newer edit
    status.textContent =
      err.name === 'TimeoutError' ? 'Took too long; stopped.' : `Failed: ${err.message}`;
    return;
  }
  const ms = performance.now() - t0;
  const t1 = performance.now();
  viewer.setProgram(program); // builds the 3D geometry on this thread
  const buildMs = performance.now() - t1;
  plan.setProgram(program);
  recordLoad?.(ms, buildMs);
  const hidden = showDiagnostics(editor, program.diagnostics);
  renderDiagnostics(program.diagnostics);
  renderSummary($('summary'), program.summary, goToLine);
  renderStats(program, ms, hidden);
}

function renderStats(p: LoadedProgram, ms: number, hidden: number): void {
  const b = p.bounds.all;
  const size = b
    ? `${(b.max.X - b.min.X).toFixed(1)} × ${(b.max.Y - b.min.Y).toFixed(1)} × ${(b.max.Z - b.min.Z).toFixed(1)} mm`
    : 'no motion';
  const count = (sev: string) => p.diagnostics.filter((d) => d.severity === sev).length;
  const parts = [
    `${editor.state.doc.lines.toLocaleString()} lines`,
    `${(p.count - 1).toLocaleString()} segments`,
    `extent ${size}`,
    `${count('error')} errors, ${count('warning')} warnings, ${count('info')} notes`,
  ];
  if (p.coarsened) parts.push('some arcs drawn coarser to fit');
  if (p.truncated) parts.push('path truncated (too many moves)');
  if (hidden > 0) parts.push(`${hidden} from subprogram files`);
  statsEl.textContent = parts.join(' · ');
  status.textContent = `Read in ${Math.round(ms)} ms`;
}

/** The diagnostics as a list. Clicking one moves the editor to its line. */
function renderDiagnostics(diags: readonly Diagnostic[]): void {
  diagList.replaceChildren();
  for (const d of diags.slice(0, 500)) {
    const li = document.createElement('li');
    li.className = `diag diag-${d.severity}`;
    const where = document.createElement('button');
    where.textContent = d.line > 0 ? `Line ${d.line}` : 'Program';
    where.disabled = d.line < 1 || d.file !== undefined;
    where.addEventListener('click', () => goToLine(d.line));
    const msg = document.createElement('span');
    msg.textContent = `${d.message} (${d.code})`; // text, never HTML: it can quote G-code
    li.append(where, msg);
    diagList.append(li);
  }
  if (diags.length > 500) {
    const li = document.createElement('li');
    li.textContent = `… and ${(diags.length - 500).toLocaleString()} more`;
    diagList.append(li);
  }
}

function goToLine(n: number): void {
  if (n < 1 || n > editor.state.doc.lines) return;
  const pos = editor.state.doc.line(n).from;
  editor.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  editor.focus();
  highlight(n);
}

/** Replaces the editor's text and reads it at once. Not an edit by hand. */
function replaceText(text: string): void {
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: text },
    annotations: programmatic.of(true),
  });
  clearTimeout(timer);
  void reload();
}

/** Opens a file or a sample: new text, and a new transform history. */
function open(text: string, name: string): void {
  currentName = name;
  document.title = `${name} · G-code Playground`;
  panel.reset();
  replaceText(text);
}

async function openSample(name: string): Promise<void> {
  status.textContent = `Fetching ${name}…`;
  const res = await fetch(`./samples/${name}`);
  if (!res.ok) {
    status.textContent = `Couldn't fetch ${name}`;
    return;
  }
  open(await res.text(), name);
}

async function openFile(file: File): Promise<void> {
  if (file.size > MAX_INPUT) {
    status.textContent = `${file.name} is over 20 MB; not opened`;
    return;
  }
  open(await file.text(), file.name);
}

$<HTMLInputElement>('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void openFile(f);
});
sampleSel.addEventListener('change', () => {
  if (sampleSel.value) void openSample(sampleSel.value);
});
dialectSel.addEventListener('change', () => {
  panel.dialectChanged();
  void reload();
});
const viewButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-view]')];
for (const b of viewButtons)
  b.addEventListener('click', () => {
    const name = b.dataset['view'];
    if (name === 'plan') {
      if (planEl.hidden) planEl.hidden = false;
      else plan.fit(); // already showing: a second click re-frames
    } else {
      planEl.hidden = true;
      currentView = name as ViewName;
      viewer.setView(currentView);
    }
    for (const x of viewButtons) x.setAttribute('aria-pressed', String(x === b));
  });

// Drop a file anywhere on the page, the editor included. The listener runs in the
// capture phase and stops the event, so CodeMirror's own drop handler never sees a file
// (it would read it uncapped, and the file would open twice). Dragging text within the
// editor carries no files, and is left to CodeMirror.
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
document.addEventListener(
  'dragover',
  (e) => {
    if (hasFiles(e)) e.preventDefault();
  },
  { capture: true },
);
document.addEventListener(
  'drop',
  (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files[0];
    if (f) void openFile(f);
  },
  { capture: true },
);

// The transform panel (parcel 4e, ADR-0038).
const panel = installTransformPanel(
  {
    getText: () => editor.state.doc.toString(),
    setText: replaceText,
    dialect: () => dialectSel.value,
    setGhost: (p) => {
      viewer.setGhost(p);
      plan.setGhost(p);
      // Frame the original too, when it appears.
      if (p) {
        viewer.setView(currentView);
        plan.fit();
      }
    },
    goToLine,
    fileName: () => currentName,
    status: (m) => (status.textContent = m),
  },
  makeWorker,
);

sampleSel.value = 'tux.ngc';
void openSample('tux.ngc');
