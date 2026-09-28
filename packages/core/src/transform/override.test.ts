// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { GENERIC, interpret, MASSO_G3, parse, transformText, type TransformOp } from '../index.js';

// Parcel 4c (ADR-0036): feed and spindle overrides.

const o = (src: string, op: TransformOp, dialect = GENERIC) =>
  transformText(src, [op], { dialect });
const codes = (r: { diagnostics: readonly { code: string }[] }) => r.diagnostics.map((d) => d.code);
/** The feed each feed move actually runs at, mm/min, as the interpreter reads the result. */
const feeds = (src: string) =>
  interpret(parse(src))
    .steps.filter((s) => (s.kind === 'linear' && !s.rapid) || s.kind === 'arc')
    .map((s) =>
      (s.kind === 'linear' || s.kind === 'arc') && s.feed?.mode === 'per-minute'
        ? s.feed.mmPerMinute
        : null,
    );

const JOB =
  'G21 G90\nG0 X0 Y0 Z5\nG1 Z-1 F200\nG1 X10 F800\nG1 Y10\nG0 Z5\nG0 X20\nG1 Z-1 F200\nG1 X30 F800';

describe('feed override', () => {
  it('scales every F word for a plain override', () => {
    const r = o(JOB, { op: 'feed', percent: 90 });
    expect(r.text).toBe(JOB.replace(/F200/g, 'F180').replace(/F800/g, 'F720'));
    expect(feeds(r.text)).toEqual([180, 720, 720, 180, 720]);
  });

  it('overrides only plunges, restoring the cutting feed after each', () => {
    const src = 'G21 G90\nG0 X0 Y0 Z5\nF600\nG1 Z-1\nG1 X10\nG1 Z-2\nG1 Y10';
    const r = o(src, { op: 'feed', percent: 50, only: 'plunge' });
    expect(r.text).toBe(
      'G21 G90\nG0 X0 Y0 Z5\nF600\nG1 Z-1 F300\nG1 X10 F600\nG1 Z-2 F300\nG1 Y10 F600',
    );
    expect(feeds(r.text)).toEqual([300, 600, 300, 600]);
    // Cuts only: the plunges keep 600.
    expect(feeds(o(src, { op: 'feed', percent: 120, only: 'cut' }).text)).toEqual([
      600, 720, 600, 720,
    ]);
  });

  it('overrides a range of lines, and restores the feed after it', () => {
    const r = o(JOB, { op: 'feed', percent: 50, lines: { from: 4, to: 5 } });
    expect(feeds(r.text)).toEqual([200, 400, 400, 200, 800]);
    expect(r.text.split('\n')[7]).toBe('G1 Z-1 F200');
  });

  it('counts drilling cycles as plunges', () => {
    const src = 'G21 G90\nG0 X0 Y0 Z5\nF300\nG81 X5 Y5 Z-3 R2\nG80\nG1 X10 F800';
    expect(o(src, { op: 'feed', percent: 50, only: 'plunge' }).text).toBe(
      'G21 G90\nG0 X0 Y0 Z5\nF300\nG81 X5 Y5 Z-3 R2 F150\nG80\nG1 X10 F800',
    );
  });

  it('keeps inch feeds to 2 decimals and inverse time scaled too', () => {
    expect(o('G20 G1 X1 F33', { op: 'feed', percent: 90 }).text).toBe('G20 G1 X1 F29.70');
    expect(o('G21 G93 G1 X1 F2', { op: 'feed', percent: 50 }).text).toBe('G21 G93 G1 X1 F1');
  });

  it('refuses a selective override behind control flow; a plain one is fine', () => {
    const src = 'G21\no100 sub\nG1 Z-1 F100\no100 endsub\no100 call';
    expect(codes(o(src, { op: 'feed', percent: 50, only: 'plunge' }))).toContain(
      'TRANSFORM_CONTROL_FLOW',
    );
    expect(o(src, { op: 'feed', percent: 50 }).text).toContain('G1 Z-1 F50');
  });

  it('says when moves run before any F (the machine rate)', () => {
    expect(
      codes(o('G21\nG1 X1\nG1 Z-1 F100', { op: 'feed', percent: 50, only: 'cut' }, MASSO_G3)),
    ).toContain('TRANSFORM_FEED_UNSET');
  });
});

describe('spindle override', () => {
  it("scales S, except Masso M66's S (a line count)", () => {
    expect(o('M3 S18000\nG1 X1 F100\nS12000', { op: 'spindle', percent: 90 }).text).toBe(
      'M3 S16200\nG1 X1 F100\nS10800',
    );
    expect(o('M66 P1 L3 S2', { op: 'spindle', percent: 50 }, MASSO_G3).text).toBe('M66 P1 L3 S2');
    expect(
      o('M3 S18000\nS12000', { op: 'spindle', percent: 50, lines: { from: 2, to: 2 } }).text,
    ).toBe('M3 S18000\nS6000');
  });
});

describe('override ops are validated', () => {
  it.each([
    { op: 'feed' },
    { op: 'feed', percent: 0 },
    { op: 'feed', percent: 90, only: 'rapid' },
    { op: 'feed', percent: 90, lines: { from: 5, to: 2 } },
    { op: 'spindle', percent: 90, only: 'cut' },
  ])('refuses %j', (op) => {
    expect(codes(o('G1 X1 F100', op as unknown as TransformOp))).toContain('TRANSFORM_BAD_OP');
  });

  it('refuses a selective override past a block-deletable feed line, where "/" is a switch', () => {
    // With block delete on, line 2 is skipped and line 3 would run at F300, not 100.
    const src = 'G21 G90\nG1 X1 F300\n/G1 Z-1 F100\nG1 Z-2\nG1 X2\nM2';
    const r = transformText(src, [{ op: 'feed', percent: 50, only: 'plunge' }]);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => `${d.code}@${d.line}`)).toEqual(['TRANSFORM_BLOCK_DELETE@3']);
    // A plain override is right either way; so is Masso, which runs "/" lines.
    expect(transformText(src, [{ op: 'feed', percent: 50 }]).ok).toBe(true);
    expect(
      transformText(src, [{ op: 'feed', percent: 50, only: 'plunge' }], { dialect: MASSO_G3 }).ok,
    ).toBe(true);
    // A block-deletable line that doesn't feed is fine.
    expect(
      transformText('G21\nG1 X1 F300\n/M8\nG1 Z-1\nM2', [
        { op: 'feed', percent: 50, only: 'plunge' },
      ]).ok,
    ).toBe(true);
  });
});
