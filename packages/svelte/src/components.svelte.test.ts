// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import type { LoadedProgram, PickEvent } from '@woodpatch/gcode-viewer';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Parcel 3e (ADR-0030): the components' behaviour in jsdom. jsdom has no WebGL or
// Canvas 2D, so the viewer package is replaced with recording fakes. CodeMirror is
// real. The fakes also count how often the viewer package is imported, which proves
// the components load it on mount and not before.

const fx = vi.hoisted(() => {
  const state = { imports: 0, views: [] as FakeView[], loaders: [] as FakeLoader[] };
  class FakeView {
    calls: unknown[][] = [];
    picks = new Set<(e: { segment: number; line: number }) => void>();
    constructor(
      readonly kind: '3d' | '2d',
      readonly el: HTMLElement,
      readonly options: unknown,
    ) {
      state.views.push(this);
    }
    setProgram(p: unknown) {
      this.calls.push(['setProgram', p]);
    }
    highlightLine(n: number | null) {
      this.calls.push(['highlightLine', n]);
    }
    setView(v: string) {
      this.calls.push(['setView', v]);
    }
    fit() {
      this.calls.push(['fit']);
    }
    onPick(l: (e: { segment: number; line: number }) => void) {
      this.picks.add(l);
      return () => this.picks.delete(l);
    }
    dispose() {
      this.calls.push(['dispose']);
    }
    pick(line: number) {
      for (const l of this.picks) l({ segment: 0, line });
    }
    named(name: string) {
      return this.calls.filter((c) => c[0] === name);
    }
  }
  class FakeLoader {
    loads: {
      text: string;
      dialect: unknown;
      resolve: (p: unknown) => void;
      reject: (e: Error) => void;
    }[] = [];
    disposed = false;
    constructor(
      readonly factory: () => unknown,
      readonly options: unknown,
    ) {
      state.loaders.push(this);
    }
    load(text: string, options: { dialect?: string }) {
      return new Promise((resolve, reject) =>
        this.loads.push({ text, dialect: options.dialect, resolve, reject }),
      );
    }
    dispose() {
      this.disposed = true;
    }
  }
  return { state, FakeView, FakeLoader };
});

vi.mock('@woodpatch/gcode-viewer', () => {
  fx.state.imports++;
  return {
    GcodeViewer: class extends fx.FakeView {
      constructor(el: HTMLElement, o: unknown) {
        super('3d', el, o);
      }
    },
    GcodeView2D: class extends fx.FakeView {
      constructor(el: HTMLElement, o: unknown) {
        super('2d', el, o);
      }
    },
    ProgramLoader: fx.FakeLoader,
  };
});

const program = (tag: string, diagnostics: unknown[] = []) =>
  ({ tag, diagnostics }) as unknown as LoadedProgram;
const settle = async () => {
  await vi.dynamicImportSettled();
  flushSync();
};
const views = (kind: '3d' | '2d') => fx.state.views.filter((v) => v.kind === kind);

let target: HTMLElement;
let app: Record<string, unknown> | undefined;
beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
  fx.state.views.length = 0;
  fx.state.loaders.length = 0;
});
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  target.remove();
});

describe('GcodeViewer', () => {
  it('imports the viewer package only when mounted', async () => {
    const before = fx.state.imports;
    const { GcodeViewer } = await import('./index.js');
    expect(fx.state.imports).toBe(before); // importing the package loads nothing heavy
    app = mount(GcodeViewer, { target, props: {} });
    await settle();
    expect(fx.state.imports).toBeGreaterThanOrEqual(1);
  });

  it('creates each view the first time its mode is shown, and keeps both in step', async () => {
    const { GcodeViewer } = await import('./index.js');
    const picks: PickEvent[] = [];
    const props = $state({
      program: program('a') as LoadedProgram | null,
      mode: '3d' as '3d' | 'plan',
      highlightLine: null as number | null,
      onpick: (e: PickEvent) => picks.push(e),
    });
    app = mount(GcodeViewer, { target, props });
    await settle();
    expect(views('3d')).toHaveLength(1);
    expect(views('2d')).toHaveLength(0);
    const [v3] = views('3d');
    expect(v3?.named('setProgram')).toEqual([['setProgram', props.program]]);
    expect(v3?.named('setView')).toEqual([['setView', 'iso']]);

    props.mode = 'plan';
    flushSync();
    const [v2] = views('2d');
    expect(v2?.named('setProgram')).toEqual([['setProgram', props.program]]);
    expect(v3?.named('setProgram')).toHaveLength(1); // the 3D camera wasn't reset
    expect(v2?.el.hidden).toBe(false);
    expect(v3?.el.hidden).toBe(true);

    props.highlightLine = 7;
    flushSync();
    expect(v3?.calls.at(-1)).toEqual(['highlightLine', 7]);
    expect(v2?.calls.at(-1)).toEqual(['highlightLine', 7]);

    props.program = program('b');
    flushSync();
    expect(v3?.named('setProgram')).toHaveLength(2);
    expect(v2?.named('setProgram')).toHaveLength(2);

    v2?.pick(12);
    v3?.pick(13);
    expect(picks.map((p) => p.line)).toEqual([12, 13]);

    unmount(app);
    app = undefined;
    expect(v3?.named('dispose')).toHaveLength(1);
    expect(v2?.named('dispose')).toHaveLength(1);
  });

  it('creates nothing if unmounted before the viewer package has loaded', async () => {
    const { GcodeViewer } = await import('./index.js');
    app = mount(GcodeViewer, { target, props: { program: program('a') } });
    flushSync(); // onMount has run: its import is in flight
    unmount(app);
    app = undefined;
    await settle();
    expect(fx.state.views).toHaveLength(0);
  });

  it('fit() frames the current view', async () => {
    const { GcodeViewer } = await import('./index.js');
    const props = $state({ program: program('a'), mode: 'plan' as '3d' | 'plan' });
    const c = mount(GcodeViewer, { target, props }) as { fit(): void };
    app = c as unknown as Record<string, unknown>;
    await settle();
    c.fit();
    expect(views('2d')[0]?.named('fit')).toHaveLength(1);
  });
});

describe('GcodeEditor', () => {
  const content = () => target.querySelector('.cm-content')?.textContent ?? '';
  const view = async () => {
    const { EditorView } = await import('@codemirror/view');
    const el = target.querySelector<HTMLElement>('.cm-editor');
    if (!el) throw new Error('no editor');
    const v = EditorView.findFromDOM(el);
    if (!v) throw new Error('no view');
    return v;
  };

  it('shows the value, takes new values, and binds edits back out', async () => {
    const { GcodeEditor } = await import('./index.js');
    const props = $state({ value: 'G0 X1' });
    app = mount(GcodeEditor, { target, props });
    await vi.waitFor(() => expect(content()).toContain('G0 X1'));

    props.value = 'G1 Y2 F100';
    flushSync();
    expect(content()).toContain('G1 Y2 F100');

    const v = await view();
    v.dispatch({ changes: { from: v.state.doc.length, insert: '\nM30' } });
    flushSync();
    expect(props.value).toBe('G1 Y2 F100\nM30');
  });

  it('refuses an edit past maxLength, and says so', async () => {
    const { GcodeEditor } = await import('./index.js');
    const refused: number[] = [];
    const props = $state({
      value: 'G0',
      maxLength: 10,
      ontoolarge: (n: number) => refused.push(n),
    });
    app = mount(GcodeEditor, { target, props });
    await vi.waitFor(() => expect(content()).toContain('G0'));
    const v = await view();
    v.dispatch({ changes: { from: 2, insert: ' X123456789' } });
    flushSync();
    expect(v.state.doc.toString()).toBe('G0');
    expect(props.value).toBe('G0');
    await vi.waitFor(() => expect(refused).toEqual([13]));
  });

  it('refuses an oversized value from the host, keeping editor and value in step', async () => {
    // Review of #27: the cap filtered the host's own replace too, so the editor kept
    // its text while `value` (and anything parsing it) moved on.
    const { GcodeEditor } = await import('./index.js');
    const refused: number[] = [];
    const props = $state({
      value: 'G0',
      maxLength: 10,
      ontoolarge: (n: number) => refused.push(n),
    });
    app = mount(GcodeEditor, { target, props });
    await vi.waitFor(() => expect(content()).toContain('G0'));
    props.value = 'G1 X123456789';
    flushSync();
    expect((await view()).state.doc.toString()).toBe('G0');
    expect(props.value).toBe('G0');
    expect(refused).toEqual([13]);
    // Within the cap, the host's value always lands (the cap filter doesn't eat it).
    props.value = 'G1 X1';
    flushSync();
    expect((await view()).state.doc.toString()).toBe('G1 X1');
  });

  it('applies the cap to the first value too', async () => {
    const { GcodeEditor } = await import('./index.js');
    const refused: number[] = [];
    const props = $state({
      value: 'G1 X123456789',
      maxLength: 10,
      ontoolarge: (n: number) => refused.push(n),
    });
    app = mount(GcodeEditor, { target, props });
    await vi.waitFor(() => expect(target.querySelector('.cm-editor')).not.toBeNull());
    expect((await view()).state.doc.toString()).toBe('');
    expect(props.value).toBe('');
    expect(refused).toEqual([13]);
  });

  it('follows readonly and dark after mount', async () => {
    const { GcodeEditor } = await import('./index.js');
    const { EditorView } = await import('@codemirror/view');
    const props = $state({ value: 'G0', readonly: false, dark: true });
    app = mount(GcodeEditor, { target, props });
    await vi.waitFor(() => expect(content()).toContain('G0'));
    const v = await view();
    expect(v.state.readOnly).toBe(false);
    expect(v.state.facet(EditorView.darkTheme)).toBe(true);
    props.readonly = true;
    props.dark = false;
    flushSync();
    expect(v.state.readOnly).toBe(true);
    expect(v.state.facet(EditorView.darkTheme)).toBe(false);
  });

  it('creates no editor if unmounted before CodeMirror has loaded', async () => {
    // Svelte nulls the host element on unmount, so a late editor would leave no trace
    // in the DOM, yet would never be destroyed. A plugin counts editors created.
    const { GcodeEditor } = await import('./index.js');
    const { ViewPlugin } = await import('@codemirror/view');
    let created = 0;
    const counter = ViewPlugin.define(() => {
      created++;
      return {};
    });
    app = mount(GcodeEditor, { target, props: { value: 'G0', extensions: [counter] } });
    flushSync(); // onMount has run: its import is in flight
    unmount(app);
    app = undefined;
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toBe(0);
  });

  it('marks the picked path line and reports the cursor line', async () => {
    const { GcodeEditor } = await import('./index.js');
    const lines: number[] = [];
    const props = $state({
      value: 'G0 X1\nG1 X2 F100\nG1 X3',
      pathLine: null as number | null,
      oncursorline: (n: number) => lines.push(n),
    });
    const c = mount(GcodeEditor, { target, props }) as { goToLine(n: number): void };
    app = c as unknown as Record<string, unknown>;
    await vi.waitFor(() => expect(content()).toContain('G1 X3'));
    props.pathLine = 2;
    flushSync();
    expect(target.querySelector('.gc-path-line')?.textContent).toBe('G1 X2 F100');
    c.goToLine(3);
    expect(lines.at(-1)).toBe(3);
    c.goToLine(99); // out of range: ignored
    expect((await view()).state.doc.lineAt((await view()).state.selection.main.head).number).toBe(
      3,
    );
  });
});

describe('GcodeWorkbench', () => {
  it('makes no loader if unmounted before the viewer package has loaded', async () => {
    const { GcodeWorkbench } = await import('./index.js');
    app = mount(GcodeWorkbench, { target, props: { createWorker: () => ({}) as Worker } });
    flushSync(); // onMount has run: its import is in flight
    unmount(app);
    app = undefined;
    await settle();
    expect(fx.state.loaders).toHaveLength(0);
  });

  it('reads edits in the worker, binds the program out, and wires pick to the editor', async () => {
    const { GcodeWorkbench } = await import('./index.js');
    const loaded: [unknown, number][] = [];
    const errors: Error[] = [];
    const worker = () => ({}) as Worker;
    const props = $state({
      value: 'G0 X1',
      dialect: 'masso-g3-5.13',
      createWorker: worker,
      program: null as LoadedProgram | null,
      delay: 0,
      onload: (p: LoadedProgram, ms: number) => loaded.push([p, ms]),
      onerror: (e: Error) => errors.push(e),
    });
    app = mount(GcodeWorkbench, { target, props });
    await settle();
    const [loader] = fx.state.loaders;
    expect(loader?.factory).toBe(worker);
    await vi.waitFor(() => expect(loader?.loads).toHaveLength(1));
    expect(loader?.loads[0]).toMatchObject({ text: 'G0 X1', dialect: 'masso-g3-5.13' });

    const p = program('first');
    loader?.loads[0]?.resolve(p);
    // Bound into a $state object, the program comes back as Svelte's proxy of it:
    // equal, not identical. (Hosts should bind it to $state.raw: see the README.)
    await vi.waitFor(() => expect(props.program).toEqual(p));
    expect(loaded[0]?.[0]).toBe(p);
    await vi.waitFor(() => expect(views('3d')[0]?.named('setProgram').at(-1)?.[1]).toEqual(p));

    // A superseded read is quiet; a real failure is reported.
    props.value = 'G0 X2';
    await vi.waitFor(() => expect(loader?.loads).toHaveLength(2));
    loader?.loads[1]?.reject(Object.assign(new Error('superseded'), { name: 'AbortError' }));
    props.dialect = 'generic';
    await vi.waitFor(() => expect(loader?.loads).toHaveLength(3));
    loader?.loads[2]?.reject(Object.assign(new Error('too slow'), { name: 'TimeoutError' }));
    await vi.waitFor(() => expect(errors.map((e) => e.name)).toEqual(['TimeoutError']));

    // A click on the path marks its line in the editor and highlights it in the view.
    await vi.waitFor(() => expect(target.querySelector('.cm-content')).not.toBeNull());
    views('3d')[0]?.pick(1);
    flushSync();
    expect(target.querySelector('.gc-path-line')).not.toBeNull();
    expect(views('3d')[0]?.calls.at(-1)).toEqual(['highlightLine', 1]);

    unmount(app);
    app = undefined;
    expect(loader?.disposed).toBe(true);
  });
});
