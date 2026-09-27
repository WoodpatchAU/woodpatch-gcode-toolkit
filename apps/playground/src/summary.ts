// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { ProgramSummary, Range } from '@woodpatch/gcode-core';

/**
 * The Summary tab: the program at a glance. Built with DOM nodes and
 * textContent only; nothing here is HTML.
 */

const mm = (v: number) => (Math.abs(v) < 5e-4 ? '0.000' : v.toFixed(3));
const metres = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} m` : `${v.toFixed(1)} mm`);
const n = (v: number) => v.toLocaleString('en-AU');
const range = (r: Range | null, unit: string) =>
  !r ? '—' : r.min === r.max ? `${n(r.min)} ${unit}` : `${n(r.min)} – ${n(r.max)} ${unit}`;
const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((100 * part) / whole)}%` : '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** Renders `s` into `host`. `goToLine` moves the editor, for the spindle-off warning. */
export function renderSummary(
  host: HTMLElement,
  s: ProgramSummary,
  goToLine: (line: number) => void,
): void {
  host.replaceChildren();
  if (!s.extent.all) {
    host.append(el('p', 'Nothing moves.', 'summary-note'));
    return;
  }

  // Warnings first: they're why you'd open this.
  const off = s.spindle.cutWhileOff;
  if (off) {
    const p = el('p', undefined, 'summary-warning');
    p.append(
      `Cuts with the spindle off: ${n(off.moves)} moves, ${metres(off.distance)}, first at `,
    );
    const b = el('button', `line ${off.firstLine}`);
    b.addEventListener('click', () => goToLine(off.firstLine));
    p.append(b, '.');
    host.append(p);
  }

  // Extents: cut and rapid side by side.
  const table = el('table', undefined, 'summary-extent');
  const head = el('tr');
  for (const h of ['Work mm', 'Cut min', 'Cut max', 'Rapid min', 'Rapid max'])
    head.append(el('th', h));
  table.append(head);
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const tr = el('tr');
    tr.append(el('th', axis));
    for (const box of [s.extent.cut, s.extent.rapid]) {
      tr.append(el('td', box ? mm(box.min[axis]) : '—'), el('td', box ? mm(box.max[axis]) : '—'));
    }
    table.append(tr);
  }
  host.append(table);

  const dl = el('dl', undefined, 'summary-facts');
  const row = (term: string, value: string) => dl.append(el('dt', term), el('dd', value));
  const top = s.feed.byValue[0];
  row(
    'Cutting feed',
    range(s.feed.cut, 'mm/min') +
      (top && s.feed.byValue.length > 1
        ? ` (most used ${n(top.mmPerMinute)}: ${pct(top.distance, s.distance.cut)} of cutting)`
        : ''),
  );
  row('Plunge feed', range(s.feed.plunge, 'mm/min'));
  if (s.feed.unspecified)
    row('Feed not set', `${n(s.feed.unspecified)} moves run at the machine's set rate`);
  if (s.feed.otherModes) row('Other feed modes', `${n(s.feed.otherModes)} moves (G93/G95)`);
  const dirs = s.spindle.directions.map((d) => d.toUpperCase()).join(', ');
  row(
    'Spindle',
    s.spindle.rpm
      ? `${range(s.spindle.rpm, 'RPM')}${dirs ? ` (${dirs})` : ''}, ${n(s.spindle.changes)} commands`
      : 'never on while cutting',
  );
  row(
    'Tools',
    s.tools
      .map((t) => `${t.tool === null ? 'no tool change' : `T${t.tool}`}: ${metres(t.cut)}`)
      .join(' · ') || '—',
  );
  row(
    'Distance',
    `cut ${metres(s.distance.cut)} (plunging ${metres(s.distance.plunge)}), rapid ${metres(s.distance.rapid)}`,
  );
  row('Moves', `${n(s.moves.linear)} feed, ${n(s.moves.arc)} arcs, ${n(s.moves.rapid)} rapid`);
  const levels = s.zLevels.length + s.zLevelsMore;
  row(
    'Z levels cut',
    levels === 0
      ? '— (no level cuts)'
      : `${n(levels)}: ${s.zLevels
          .slice(0, 8)
          .map((z) => mm(z.z))
          .join(', ')}${levels > 8 ? ', …' : ''}`,
  );
  if (s.dwell.count || s.pauses)
    row(
      'Dwells, stops',
      `${n(s.dwell.count)} dwells (${s.dwell.seconds.toFixed(1)} s), ${n(s.pauses)} stops`,
    );
  row('Coolant', s.coolant ? 'on at some point' : 'never on');
  host.append(dl);
}
