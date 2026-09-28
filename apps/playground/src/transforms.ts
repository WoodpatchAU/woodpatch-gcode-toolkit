// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { invalidOp, type Diagnostic, type TransformOp } from '@woodpatch/gcode-core';
import { ProgramLoader, type LoadedProgram } from '@woodpatch/gcode-viewer';
import { describeOp, parseRecipe, recipeJson, TransformHistory } from './history.js';
import type { TransformRequest, TransformResponse } from './transformTypes.js';

/**
 * The transform panel (parcel 4e, ADR-0038). Transforms run in a worker (an instance
 * of the page's one worker script), so a big file doesn't freeze the page. Each one
 * applied goes on a history: undo, redo, a recipe to save, and the original drawn
 * faintly behind the result. A transform the core refuses changes nothing, and its
 * reasons are listed with their lines.
 */
export interface PanelHost {
  /** The editor's text. */
  getText(): string;
  /** Replaces the editor's text without counting as an edit by hand, and reads it. */
  setText(text: string): void;
  /** The controller's id. */
  dialect(): string;
  /** Shows a program faintly behind the current one, or clears it. */
  setGhost(program: LoadedProgram | null): void;
  goToLine(n: number): void;
  /** The open file's name, for saved files. */
  fileName(): string;
}

export interface Panel {
  /** A new file: forget the history. */
  reset(): void;
  /** The text was edited by hand: the history no longer describes it. */
  handEdited(): void;
  /** The controller changed: redraw the original for it. */
  dialectChanged(): void;
}

/** A recipe file bigger than this isn't a recipe. */
const MAX_RECIPE = 1024 * 1024;
/** A transform taking longer than this is stopped (the core has its own limits too). */
const TIMEOUT_MS = 120_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function installTransformPanel(host: PanelHost, makeWorker: () => Worker): Panel {
  const form = $<HTMLFormElement>('transform');
  const opSel = $<HTMLSelectElement>('op');
  const applyBtn = $<HTMLButtonElement>('apply');
  const undoBtn = $<HTMLButtonElement>('undo');
  const redoBtn = $<HTMLButtonElement>('redo');
  const ghostBox = $<HTMLInputElement>('ghost');
  const recipeList = $<HTMLOListElement>('recipe');
  const notes = $<HTMLOListElement>('transform-notes');
  const exportBtn = $<HTMLButtonElement>('export-recipe');
  const importInput = $<HTMLInputElement>('import-recipe');
  const saveBtn = $<HTMLButtonElement>('save-gcode');
  // The panel's own status line: the page's is overwritten by the re-read that follows
  // every transform, and the outcome would flash past unseen.
  const statusEl = $('transform-status');
  const say = (m: string) => (statusEl.textContent = m);

  const history = new TransformHistory();
  const runner = new TransformRunner(makeWorker);
  const ghostLoader = new ProgramLoader(makeWorker);
  let busy = false;
  let ghostKey = '';

  // ── The form ──
  const fieldsets = [...form.querySelectorAll<HTMLFieldSetElement>('fieldset[data-op]')];
  const showFields = () => {
    for (const f of fieldsets) f.hidden = f.dataset['op'] !== opSel.value;
  };
  opSel.addEventListener('change', showFields);
  showFields();

  /** The op the form describes. Empty optional fields are left out. */
  function readOp(): TransformOp {
    const v = (name: string) => {
      const el = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
      return el.value.trim();
    };
    const num = (name: string, fallback?: number) => {
      const s = v(name);
      return s === '' ? fallback : Number(s);
    };
    switch (opSel.value) {
      case 'rotate':
        return {
          op: 'rotate',
          degrees: num('deg') as number,
          about: { x: num('rx', 0) as number, y: num('ry', 0) as number },
        };
      case 'mirror':
        return {
          op: 'mirror',
          axis: v('axis') === 'y' ? 'y' : 'x',
          about: num('mabout', 0) as number,
        };
      case 'scale': {
        const y = num('sy');
        const z = num('sz');
        return {
          op: 'scale',
          x: num('sx') as number,
          ...(y === undefined ? {} : { y }),
          ...(z === undefined ? {} : { z }),
          about: {
            x: num('ax', 0) as number,
            y: num('ay', 0) as number,
            z: num('az', 0) as number,
          },
        };
      }
      default:
        return {
          op: 'translate',
          x: num('tx', 0) as number,
          y: num('ty', 0) as number,
          z: num('tz', 0) as number,
        };
    }
  }

  // ── Applying ──
  /** Applies one op to the editor's text. True if it was applied. */
  async function apply(op: TransformOp): Promise<boolean> {
    const bad = invalidOp(op);
    if (bad) {
      showNotes([{ severity: 'error', code: 'TRANSFORM_BAD_OP', message: bad, line: 0 }]);
      return false;
    }
    const before = host.getText();
    setBusy(true);
    say('Transforming…');
    let r: TransformResponse;
    try {
      r = await runner.run(before, [op], host.dialect());
    } catch (e) {
      say(`Transform failed: ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
    // Typed into while it ran: the result is for text that's gone.
    if (host.getText() !== before) {
      say('The text changed while transforming; not applied');
      return false;
    }
    showNotes(r.diagnostics);
    if (!r.ok) {
      say(`${describeOp(op)}: refused, nothing changed`);
      return false;
    }
    history.push(before, op, r.text);
    host.setText(r.text);
    say(`${describeOp(op)}: ${r.changedLines.toLocaleString()} lines changed`);
    refresh();
    return true;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!busy) void apply(readOp());
  });
  undoBtn.addEventListener('click', () => step(history.undo()));
  redoBtn.addEventListener('click', () => step(history.redo()));
  function step(text: string | null): void {
    if (text === null) return;
    notes.replaceChildren();
    host.setText(text);
    refresh();
  }
  ghostBox.addEventListener('change', () => void updateGhost());

  // ── Recipes and files ──
  exportBtn.addEventListener('click', () =>
    download(recipeJson(history.ops, host.dialect()), `${stem(host.fileName())}.recipe.json`),
  );
  saveBtn.addEventListener('click', () => {
    const name = host.fileName();
    const dot = name.lastIndexOf('.');
    const out = history.canUndo
      ? `${stem(name)}-transformed${dot > 0 ? name.slice(dot) : '.nc'}`
      : name;
    download(host.getText(), out);
  });
  importInput.addEventListener('change', () => {
    const f = importInput.files?.[0];
    importInput.value = ''; // the same file can be chosen again
    if (f) void applyRecipe(f);
  });
  async function applyRecipe(f: File): Promise<void> {
    if (f.size > MAX_RECIPE) {
      say(`${f.name} is too big to be a recipe`);
      return;
    }
    const parsed = parseRecipe(await f.text());
    if (!parsed.ok) {
      showNotes([{ severity: 'error', code: 'RECIPE_INVALID', message: parsed.error, line: 0 }]);
      say(`${f.name}: not applied`);
      return;
    }
    // Applied one at a time, so each can be undone, stopping at the first refusal.
    for (const [i, op] of parsed.ops.entries())
      if (!(await apply(op))) {
        say(`${f.name}: stopped at step ${i + 1} of ${parsed.ops.length}`);
        return;
      }
    const other =
      parsed.dialect !== null && parsed.dialect !== host.dialect()
        ? ` (it was saved for ${parsed.dialect})`
        : '';
    const n = parsed.ops.length;
    say(`${f.name}: ${n} step${n === 1 ? '' : 's'} applied${other}`);
  }

  // ── Display ──
  function refresh(): void {
    undoBtn.disabled = busy || !history.canUndo;
    redoBtn.disabled = busy || !history.canRedo;
    exportBtn.disabled = !history.canUndo;
    recipeList.replaceChildren(
      ...history.ops.map((op) => {
        const li = document.createElement('li');
        li.textContent = describeOp(op);
        return li;
      }),
    );
    void updateGhost();
  }

  function setBusy(b: boolean): void {
    busy = b;
    applyBtn.disabled = b;
    importInput.disabled = b;
    refresh();
  }

  function showNotes(diags: readonly Diagnostic[]): void {
    notes.replaceChildren();
    for (const d of diags.slice(0, 200)) {
      const li = document.createElement('li');
      li.className = `diag diag-${d.severity}`;
      const where = document.createElement('button');
      where.type = 'button';
      where.textContent = d.line > 0 ? `Line ${d.line}` : 'Program';
      where.disabled = d.line < 1;
      where.addEventListener('click', () => host.goToLine(d.line));
      const msg = document.createElement('span');
      msg.textContent = `${d.message} (${d.code})`; // text, never HTML
      li.append(where, msg);
      notes.append(li);
    }
  }

  /** The original, drawn faintly, while transforms are in effect and the box is ticked. */
  async function updateGhost(): Promise<void> {
    const original = ghostBox.checked ? history.original : null;
    const key = original === null ? '' : `${host.dialect()}\n${original}`;
    if (key === ghostKey) return;
    ghostKey = key;
    if (original === null) {
      host.setGhost(null);
      return;
    }
    try {
      const p = await ghostLoader.load(original, { dialect: host.dialect() });
      if (ghostKey === key) host.setGhost(p);
    } catch {
      // Superseded by a newer ghost, or too slow: the result alone is still right.
    }
  }

  return {
    reset() {
      history.reset();
      notes.replaceChildren();
      say('');
      refresh();
    },
    handEdited() {
      if (!history.canUndo && !history.canRedo) return;
      history.reset();
      notes.replaceChildren();
      refresh();
      say('Edited by hand: the transform history starts again from here');
    },
    dialectChanged() {
      ghostKey = '';
      void updateGhost();
    },
  };
}

/** Runs transforms in a worker, one at a time. */
class TransformRunner {
  private worker: Worker | null = null;
  private id = 0;

  constructor(private readonly make: () => Worker) {}

  run(text: string, ops: readonly TransformOp[], dialect: string): Promise<TransformResponse> {
    const worker = (this.worker ??= this.make());
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Stuck: the only way to stop it is to end the worker.
        worker.terminate();
        this.worker = null;
        cleanup();
        reject(new Error('it took too long, and was stopped'));
      }, TIMEOUT_MS);
      const onMessage = (e: MessageEvent<TransformResponse>) => {
        if (e.data?.kind !== 'transform' || e.data.id !== id) return;
        cleanup();
        resolve(e.data);
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        this.worker?.terminate();
        this.worker = null;
        reject(new Error(e.message || 'the worker failed'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      const req: TransformRequest = { kind: 'transform', id, text, ops, dialect };
      worker.postMessage(req);
    });
  }
}

/** The name without its extension. */
function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Offers text as a file to save. Nothing leaves the browser. */
function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
