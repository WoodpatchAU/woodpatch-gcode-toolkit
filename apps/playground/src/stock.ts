// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { validateStock, type Diagnostic, type StockBox } from '@woodpatch/gcode-core';
import { stockCollisions, type LoadedProgram, type StockItem } from '@woodpatch/gcode-viewer';

/**
 * The Stock panel (ADR-0054): boxes on the table, each with its own visibility and
 * colour, and the rapids that reach into them. Kept in this browser (localStorage);
 * saved and loaded as a small JSON file. A loaded file is untrusted input: size-capped,
 * parsed, and checked field by field before anything uses it.
 */

/** One box as the panel keeps it. */
export interface PanelBox {
  readonly id: string;
  readonly name: string;
  readonly min: { readonly X: number; readonly Y: number; readonly Z: number };
  readonly size: { readonly X: number; readonly Y: number; readonly Z: number };
  /** "#rrggbb" */
  readonly color: string;
  readonly visible: boolean;
}

export interface StockState {
  readonly toolRadius: number;
  readonly boxes: readonly PanelBox[];
}

export const MAX_BOXES = 50;
export const MAX_NAME = 80;
/** A saved stock file is tiny; anything bigger isn't one. */
export const MAX_FILE_BYTES = 64 * 1024;
const STORAGE_KEY = 'gcode-playground:stock:v1';
const DEFAULT_COLOR = '#c8a165';
const EMPTY: StockState = { toolRadius: 0, boxes: [] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const xyz = (v: unknown): { X: number; Y: number; Z: number } | null =>
  isObj(v) && [v['X'], v['Y'], v['Z']].every((n) => typeof n === 'number' && Number.isFinite(n))
    ? { X: v['X'] as number, Y: v['Y'] as number, Z: v['Z'] as number }
    : null;

/**
 * Reads a stock state from parsed JSON (a saved file, or localStorage), refusing
 * anything that isn't exactly one. Returns the state or the reason.
 */
export function parseStock(data: unknown): StockState | string {
  if (!isObj(data) || data['format'] !== 'woodpatch-stock' || data['version'] !== 1) {
    return "it isn't a stock file (format woodpatch-stock, version 1)";
  }
  const r = data['toolRadius'];
  if (typeof r !== 'number' || !Number.isFinite(r) || r < 0 || r > 1000) {
    return 'its tool radius must be a number from 0 to 1000';
  }
  const list = data['boxes'];
  if (!Array.isArray(list)) return 'it has no list of boxes';
  if (list.length > MAX_BOXES) return `it has over ${MAX_BOXES} boxes`;
  const boxes: PanelBox[] = [];
  for (const [i, b] of list.entries()) {
    const at = `box ${i + 1}`;
    if (!isObj(b)) return `${at} isn't an object`;
    const { id, name, color, visible } = b;
    const min = xyz(b['min']);
    const size = xyz(b['size']);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) return `${at}: bad id`;
    if (typeof name !== 'string' || name.length > MAX_NAME) {
      return `${at}: its name must be text, at most ${MAX_NAME} characters`;
    }
    if (!min || !size) return `${at}: its corner and size must be three numbers each`;
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      return `${at}: its colour must be #rrggbb`;
    }
    if (typeof visible !== 'boolean') return `${at}: visible must be true or false`;
    boxes.push({ id, name, min, size, color: color.toLowerCase(), visible });
  }
  const problems = validateStock(boxes.map(toShape));
  if (problems.length > 0) return problems[0] as string;
  return { toolRadius: r, boxes };
}

/** The state as a file's JSON. */
export function serialiseStock(s: StockState): string {
  return `${JSON.stringify({ format: 'woodpatch-stock', version: 1, ...s }, null, 2)}\n`;
}

export const toShape = (b: PanelBox): StockBox => ({
  kind: 'box',
  id: b.id,
  name: b.name || 'Box',
  min: b.min,
  size: b.size,
});

const toItem = (b: PanelBox): StockItem => ({
  shape: toShape(b),
  visible: b.visible,
  color: Number.parseInt(b.color.slice(1), 16),
});

/** The next free id: "s" and a number one above the largest in use. */
export function nextId(boxes: readonly PanelBox[]): string {
  const n = Math.max(0, ...boxes.map((b) => Number(/^s(\d+)$/.exec(b.id)?.[1] ?? 0)));
  return `s${n + 1}`;
}

export interface StockHost {
  setStock(items: readonly StockItem[]): void;
  showCollisions(lines: readonly number[]): void;
  /** The program now shown, or null. */
  program(): LoadedProgram | null;
  /** The collisions changed: the page lists them with the other diagnostics. */
  collisionsChanged(diags: readonly Diagnostic[]): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);

/** Wires the panel's elements (by id, in index.html) to the host. */
export function installStockPanel(host: StockHost): {
  programChanged(): void;
  collisions(): readonly Diagnostic[];
} {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const list = $<HTMLOListElement>('stock-list');
  const radius = $<HTMLInputElement>('stock-radius');
  const msg = $('stock-msg');
  const summary = $('stock-count');

  let state = load();
  let found: readonly Diagnostic[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function load(): StockState {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      if (!raw || raw.length > MAX_FILE_BYTES) return EMPTY;
      const s = parseStock(JSON.parse(raw));
      return typeof s === 'string' ? EMPTY : s;
    } catch {
      return EMPTY; // storage blocked, or a corrupt entry: start empty
    }
  }

  function save(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, serialiseStock(state));
    } catch {
      // Storage full or blocked: the panel still works for this visit.
    }
  }

  /** Re-checks the rapids against the visible boxes, shortly after the last change. */
  function check(now = false): void {
    clearTimeout(timer);
    const run = () => {
      const p = host.program();
      const shapes = state.boxes.filter((b) => b.visible).map(toShape);
      found =
        p && shapes.length > 0 ? stockCollisions(p, shapes, { toolRadius: state.toolRadius }) : [];
      host.showCollisions(
        found.filter((d) => d.code === 'STOCK_RAPID_COLLISION').map((d) => d.line),
      );
      host.collisionsChanged(found);
      const n = found.filter((d) => d.code === 'STOCK_RAPID_COLLISION').length;
      const more = found.find((d) => d.code === 'STOCK_RAPID_COLLISION_MORE');
      msg.textContent =
        shapes.length === 0
          ? ''
          : n === 0
            ? 'No rapid reaches into the visible stock.'
            : `${n}${more ? '+' : ''} ${n === 1 && !more ? 'rapid reaches' : 'rapids reach'} into the stock: see the diagnostics.`;
      if (p?.truncated && shapes.length > 0)
        msg.textContent += ' (The path was truncated: only what is drawn is checked.)';
    };
    if (now) run();
    else timer = setTimeout(run, 150);
  }

  function changed(redraw: boolean): void {
    save();
    host.setStock(state.boxes.map(toItem));
    summary.textContent = state.boxes.length > 0 ? ` (${state.boxes.length})` : '';
    if (redraw) render();
    check();
  }

  function update(id: string, patch: Partial<PanelBox>): void {
    state = { ...state, boxes: state.boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)) };
  }

  function numberInput(label: string, value: number, onSet: (v: number) => void, positive = false) {
    const input = el('input', { type: 'number', step: 'any', value: String(value) });
    input.setAttribute('aria-label', label);
    if (positive) input.min = '0';
    input.addEventListener('input', () => {
      const v = input.valueAsNumber;
      const ok = Number.isFinite(v) && (!positive || v > 0);
      input.setAttribute('aria-invalid', String(!ok));
      if (!ok) return; // keep the last good value until this one is
      onSet(v);
      changed(false);
    });
    const wrap = el('label', { textContent: label.split(' ').pop() ?? label });
    wrap.append(input);
    return wrap;
  }

  function render(): void {
    list.replaceChildren();
    for (const b of state.boxes) {
      const li = el('li', { className: 'stock-item' });
      const head = el('div', { className: 'stock-head' });
      const visible = el('input', { type: 'checkbox', checked: b.visible });
      visible.setAttribute('aria-label', `Show ${b.name || 'box'}`);
      visible.addEventListener('change', () => {
        update(b.id, { visible: visible.checked });
        changed(false);
      });
      const name = el('input', { type: 'text', value: b.name, maxLength: MAX_NAME });
      name.setAttribute('aria-label', 'Name');
      name.addEventListener('input', () => {
        update(b.id, { name: name.value });
        changed(false);
      });
      const color = el('input', { type: 'color', value: b.color });
      color.setAttribute('aria-label', 'Colour');
      color.addEventListener('input', () => {
        update(b.id, { color: color.value.toLowerCase() });
        changed(false);
      });
      const remove = el('button', { type: 'button', textContent: 'Delete' });
      remove.addEventListener('click', () => {
        state = { ...state, boxes: state.boxes.filter((x) => x.id !== b.id) };
        changed(true);
      });
      head.append(visible, name, color, remove);
      const corner = el('div', { className: 'stock-row' });
      corner.append(
        el('span', { textContent: 'Corner' }),
        ...(['X', 'Y', 'Z'] as const).map((a) =>
          numberInput(`Lowest corner ${a}`, b.min[a], (v) =>
            update(b.id, { min: { ...current(b.id).min, [a]: v } }),
          ),
        ),
      );
      const size = el('div', { className: 'stock-row' });
      size.append(
        el('span', { textContent: 'Size' }),
        ...(
          [
            ['X', 'Length X'],
            ['Y', 'Width Y'],
            ['Z', 'Height Z'],
          ] as const
        ).map(([a, label]) =>
          numberInput(
            label,
            b.size[a],
            (v) => update(b.id, { size: { ...current(b.id).size, [a]: v } }),
            true,
          ),
        ),
      );
      li.append(head, corner, size);
      list.append(li);
    }
  }

  const current = (id: string): PanelBox => state.boxes.find((b) => b.id === id) as PanelBox;

  function add(box: Omit<PanelBox, 'id' | 'color' | 'visible'>): void {
    if (state.boxes.length >= MAX_BOXES) {
      msg.textContent = `At most ${MAX_BOXES} boxes.`;
      return;
    }
    const b: PanelBox = { ...box, id: nextId(state.boxes), color: DEFAULT_COLOR, visible: true };
    state = { ...state, boxes: [...state.boxes, b] };
    changed(true);
  }

  $('stock-add').addEventListener('click', () =>
    add({
      name: `Box ${state.boxes.length + 1}`,
      min: { X: 0, Y: 0, Z: -20 },
      size: { X: 100, Y: 100, Z: 20 },
    }),
  );
  $('stock-fit').addEventListener('click', () => {
    const b = host.program()?.bounds.all;
    if (!b) {
      msg.textContent = 'No path to put a box round.';
      return;
    }
    const size = { X: b.max.X - b.min.X, Y: b.max.Y - b.min.Y, Z: b.max.Z - b.min.Z };
    if (!(size.X > 0 && size.Y > 0 && size.Z > 0)) {
      msg.textContent = 'The path is flat along an axis: give the box a size by hand.';
      return;
    }
    add({ name: 'Round the path', min: b.min, size });
  });
  radius.value = String(state.toolRadius);
  radius.addEventListener('input', () => {
    const v = radius.valueAsNumber;
    const ok = Number.isFinite(v) && v >= 0 && v <= 1000;
    radius.setAttribute('aria-invalid', String(!ok));
    if (!ok) return;
    state = { ...state, toolRadius: v };
    changed(false);
  });
  $('stock-export').addEventListener('click', () => {
    const url = URL.createObjectURL(
      new Blob([serialiseStock(state)], { type: 'application/json' }),
    );
    const a = el('a', { href: url, download: 'stock.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $<HTMLInputElement>('stock-import').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = ''; // the same file can be chosen again
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      msg.textContent = `${f.name} is too big for a stock file; not loaded.`;
      return;
    }
    void f.text().then((text) => {
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        msg.textContent = `${f.name} isn't JSON; not loaded.`;
        return;
      }
      const s = parseStock(data);
      if (typeof s === 'string') {
        msg.textContent = `${f.name}: ${s}; not loaded.`;
        return;
      }
      state = s;
      radius.value = String(state.toolRadius);
      changed(true);
    });
  });

  // First paint: whatever this browser kept.
  host.setStock(state.boxes.map(toItem));
  summary.textContent = state.boxes.length > 0 ? ` (${state.boxes.length})` : '';
  render();

  return {
    programChanged: () => check(true),
    collisions: () => found,
  };
}
