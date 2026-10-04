// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { EditorState, Text } from '@codemirror/state';
import { interpret, parse, type Diagnostic } from '@woodpatch/gcode-core';
import { describe, expect, it } from 'vitest';
import {
  buildHighlights,
  cursorLine,
  gcode,
  lineSpans,
  MAX_STYLED_CHARS,
  oWordFoldRange,
  pathLineField,
  setPathLine,
  styledSpans,
  toLintDiagnostics,
} from './index.js';

const classes = (text: string) =>
  lineSpans(text).map((s) => `${text.slice(s.from, s.to)}:${s.cls}`);

describe('lineSpans (from the core tokenizer)', () => {
  it('styles words by role', () => {
    expect(classes('N10 G1 X10.5 Y-2 I3 F600 S12000 T2 M3 P5')).toEqual([
      'N10:gc-lineno',
      'G1:gc-g',
      'X10.5:gc-axis',
      'Y-2:gc-axis',
      'I3:gc-centre',
      'F600:gc-feed',
      'S12000:gc-speed',
      'T2:gc-tool',
      'M3:gc-m',
      'P5:gc-param',
    ]);
  });

  it('styles comments, expressions, assignments, O-words and Masso messages', () => {
    expect(classes('G0 X[1+2] (note) ; tail')).toEqual([
      'G0:gc-g',
      'X[1+2]:gc-axis',
      '[1+2]:gc-expr',
      '(note):gc-comment',
      '; tail:gc-comment',
    ]);
    expect(classes('#1=[#2*3]')).toEqual(['#1=[#2*3]:gc-assign']);
    expect(classes('o100 if [#1 GT 0]')).toEqual(['o100 if:gc-oword', '[#1 GT 0]:gc-expr']);
    expect(classes('N10 MSG Load Material')).toEqual([
      'N10:gc-lineno',
      'MSG Load Material:gc-message',
    ]);
    expect(classes('/G0 X1')).toEqual(['/:gc-blockdelete', 'G0:gc-g', 'X1:gc-axis']);
  });

  it('never throws, whatever the line', () => {
    for (const t of ['', '(', '((((', '[[[', 'G', '🎉 X1', '%', 'X1*12', 'o<', '#'])
      expect(() => lineSpans(t)).not.toThrow();
  });
});

describe('toLintDiagnostics', () => {
  const diag = (d: Partial<Diagnostic>): Diagnostic => ({
    severity: 'error',
    code: 'X',
    message: 'm',
    line: 1,
    ...d,
  });

  it('maps line + span to document offsets, or the whole line without a span', () => {
    const doc = Text.of(['G0 X1', 'G1 Q5 X2']);
    const { diagnostics } = toLintDiagnostics(doc, [
      diag({ line: 2, span: { start: 3, end: 5 }, code: 'A', severity: 'warning' }),
      diag({ line: 1, code: 'B' }),
    ]);
    expect(diagnostics).toEqual([
      { from: 9, to: 11, severity: 'warning', message: 'm', source: 'A' },
      { from: 0, to: 5, severity: 'error', message: 'm', source: 'B' },
    ]);
  });

  it('shifts past a byte-order mark on line 1, clamps spans, and puts line 0 on line 1', () => {
    const doc = Text.of(['﻿G0 X1']);
    const { diagnostics } = toLintDiagnostics(doc, [
      diag({ span: { start: 3, end: 5 } }),
      diag({ span: { start: 3, end: 99 } }),
      diag({ line: 0 }),
    ]);
    expect(diagnostics.map((d) => [d.from, d.to])).toEqual([
      [4, 6],
      [4, 6],
      [1, 6],
    ]);
  });

  it('leaves out diagnostics from subprogram files, and counts them', () => {
    const r = toLintDiagnostics(Text.of(['G0 X1']), [diag({ file: 'sub' }), diag({})]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });

  it('agrees with the core on a real program (every offset lands on its line)', () => {
    const src = 'G21 G90\nG1 X10\nG2 X5 R1\nG1 X1e3 F100\nG0 X1 (open';
    const program = parse(src);
    const all = [...program.diagnostics, ...interpret(program).diagnostics];
    const doc = Text.of(src.split('\n'));
    const { diagnostics } = toLintDiagnostics(doc, all);
    expect(diagnostics.length).toBe(all.length);
    diagnostics.forEach((d, k) => {
      const want = doc.line(Math.max(1, all[k]?.line ?? 1));
      expect(d.from).toBeGreaterThanOrEqual(want.from);
      expect(d.to).toBeLessThanOrEqual(want.to);
    });
  });
});

describe('O-word folding', () => {
  const state = (lines: string[]) => EditorState.create({ doc: lines.join('\n') });

  it('folds a block up to the line before its closer', () => {
    const s = state(['o1 sub', 'G0 X1', 'G0 X2', 'o1 endsub', 'o1 call']);
    expect(oWordFoldRange(s, 1)).toEqual({ from: s.doc.line(1).to, to: s.doc.line(3).to });
    expect(oWordFoldRange(s, 2)).toBeNull();
    expect(oWordFoldRange(s, 5)).toBeNull(); // call opens nothing
  });

  it('pairs do with its closing while, and if/while/repeat with their ends', () => {
    const s = state([
      'o2 do',
      'G0 X1',
      'o2 while [0]',
      'o3 if [1]',
      'G0 X2',
      'o3 endif',
      'o4 repeat [2]',
      'G0 X3',
      'o4 endrepeat',
    ]);
    expect(oWordFoldRange(s, 1)?.to).toBe(s.doc.line(2).to);
    expect(oWordFoldRange(s, 3)).toBeNull(); // the closing while opens nothing
    expect(oWordFoldRange(s, 4)?.to).toBe(s.doc.line(5).to);
    expect(oWordFoldRange(s, 7)?.to).toBe(s.doc.line(8).to);
  });

  it('matches by normalised label and skips other labels; no closer, no fold', () => {
    const s = state(['o0100 if [1]', 'o200 if [1]', 'o200 endif', 'G0 X1', 'o100 endif']);
    expect(oWordFoldRange(s, 1)?.to).toBe(s.doc.line(4).to);
    expect(oWordFoldRange(state(['o1 while [1]', 'G0 X1']), 1)).toBeNull();
    expect(oWordFoldRange(state(['o1 if [1]', 'o1 endif']), 1)).toBeNull(); // empty body
  });
});

describe('line ↔ path sync (state level)', () => {
  it('marks one path line, moves it, clears it, and maps it through edits', () => {
    let s = EditorState.create({
      doc: 'G0 X1\nG0 X2\nG0 X3',
      extensions: gcode({ gutter: false }),
    });
    const marked = () => {
      const out: number[] = [];
      s.field(pathLineField).between(0, s.doc.length, (from) => {
        out.push(s.doc.lineAt(from).number);
      });
      return out;
    };
    s = s.update({ effects: setPathLine.of(2) }).state;
    expect(marked()).toEqual([2]);
    s = s.update({ changes: { from: 0, insert: 'G21\n' } }).state;
    expect(marked()).toEqual([3]); // follows its line through an insertion above
    s = s.update({ effects: setPathLine.of(99) }).state;
    expect(marked()).toEqual([]);
    s = s.update({ effects: setPathLine.of(1) }).state;
    s = s.update({ effects: setPathLine.of(null) }).state;
    expect(marked()).toEqual([]);
  });

  it('reports the cursor line', () => {
    const s = EditorState.create({ doc: 'a\nb\nc', selection: { anchor: 3 } });
    expect(cursorLine(s)).toBe(2);
  });
});

describe('review findings on #21, pinned', () => {
  it('styles a long line split into several visible ranges ONCE (was a crash)', () => {
    const long = 'G1 ' + Array.from({ length: 800 }, (_, i) => `X${i}`).join(' ');
    const state = EditorState.create({ doc: `G0 X1\n${long}\nG0 Y2` });
    const l2 = state.doc.line(2);
    const fake = {
      state,
      // CodeMirror's long-line gap: the visible part of line 2 arrives as two ranges,
      // plus a cursor window that starts inside the same line.
      visibleRanges: [
        { from: 0, to: l2.from + 100 },
        { from: l2.from + 3000, to: l2.from + 3100 },
        { from: l2.from + 3050, to: state.doc.length },
      ],
    };
    expect(() => buildHighlights(fake)).not.toThrow();
    const set = buildHighlights(fake);
    let marks = 0;
    set.between(l2.from, l2.to, () => {
      marks++;
    });
    expect(marks).toBeGreaterThan(0);
  });

  it('never throws on pathological lines, and styles at most MAX_STYLED_CHARS', () => {
    const t0 = performance.now();
    expect(() => styledSpans('X' + '-'.repeat(10_000), 5)).not.toThrow();
    expect(() => styledSpans('X' + '#'.repeat(10_000), 5)).not.toThrow();
    const huge = 'N1'.repeat(50_000);
    const spans = styledSpans(huge, 5);
    expect(spans.every((s) => s.to <= MAX_STYLED_CHARS)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('skips line 1’s byte-order mark, as the core does', () => {
    expect(styledSpans('﻿%', 1)).toEqual([{ from: 1, to: 2, cls: 'gc-percent' }]);
    expect(styledSpans('﻿/G0', 1).map((s) => s.cls)).toEqual(['gc-blockdelete', 'gc-g']);
  });

  it('folds from a one-pass index: 150 unclosed openers cost next to nothing', () => {
    const lines: string[] = [];
    for (let i = 0; i < 150; i++) lines.push(`o${i} while [1]`, 'G0 X1');
    for (let i = 0; i < 20_000; i++) lines.push('G1 X1 Y2');
    const s = EditorState.create({ doc: lines.join('\n') });
    const t0 = performance.now();
    for (let pass = 0; pass < 20; pass++) for (let n = 1; n <= 300; n++) oWordFoldRange(s, n);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(oWordFoldRange(s, 1)).toBeNull();
  });

  it('pairs blocks through nesting and a do’s closing while', () => {
    const s = EditorState.create({
      doc: [
        'o1 if [1]',
        'o1 if [1]',
        'G0 X1',
        'o1 endif',
        'G0 X2',
        'o1 endif',
        'o2 do',
        'G0',
        'o2 while [0]',
      ].join('\n'),
    });
    expect(oWordFoldRange(s, 1)?.to).toBe(s.doc.line(5).to);
    expect(oWordFoldRange(s, 2)?.to).toBe(s.doc.line(3).to);
    expect(oWordFoldRange(s, 7)?.to).toBe(s.doc.line(8).to);
    expect(oWordFoldRange(s, 9)).toBeNull();
  });

  it('toLintDiagnostics tolerates a reversed span and a non-finite line', () => {
    const doc = Text.of(['G0 X1']);
    const d = (x: Partial<Diagnostic>): Diagnostic => ({
      severity: 'error',
      code: 'X',
      message: 'm',
      line: 1,
      ...x,
    });
    const r = toLintDiagnostics(doc, [d({ span: { start: 4, end: 1 } }), d({ line: Number.NaN })]);
    expect(r.diagnostics.map((x) => [x.from, x.to])).toEqual([
      [4, 4],
      [0, 5],
    ]);
  });

  it('marks only whole line numbers', () => {
    let s = EditorState.create({ doc: 'a\nb\nc', extensions: gcode({ gutter: false }) });
    s = s.update({ effects: setPathLine.of(2.5) }).state;
    let count = 0;
    s.field(pathLineField).between(0, s.doc.length, () => {
      count++;
    });
    expect(count).toBe(0);
  });
});

describe('lineSpans is guarded itself (it is public)', () => {
  it('never throws on a pathological line, and tokenizes at most maxChars', () => {
    expect(() => lineSpans('X' + '-'.repeat(100_000))).not.toThrow();
    expect(lineSpans('X' + '-'.repeat(100_000))).toBeInstanceOf(Array);
    expect(lineSpans('G0 X1 Y2', 5).map((s) => s.cls)).toEqual(['gc-g', 'gc-axis']);
    // With no cap, the core reads it: since the tokenizer hardening it neither overflows
    // its stack nor throws (the guard stays, as defence in depth).
    const spans = lineSpans('X' + '-'.repeat(100_000), Infinity);
    expect(spans[0]).toMatchObject({ from: 0, to: 1, cls: 'gc-axis' });
  });
});
