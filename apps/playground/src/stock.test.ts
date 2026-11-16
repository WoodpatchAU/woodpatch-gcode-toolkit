// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { MAX_BOXES, nextId, parseStock, serialiseStock, type StockState } from './stock.js';

const GOOD: StockState = {
  toolRadius: 8,
  boxes: [
    {
      id: 's1',
      name: 'Beam',
      min: { X: -500, Y: 0, Z: -90 },
      size: { X: 500, Y: 90, Z: 100 },
      color: '#c8a165',
      visible: true,
    },
  ],
};
const file = (over: Record<string, unknown> = {}) => ({
  ...(JSON.parse(serialiseStock(GOOD)) as Record<string, unknown>),
  ...over,
});
const withBox = (b: Record<string, unknown>) => file({ boxes: [{ ...GOOD.boxes[0], ...b }] });

describe('a stock file', () => {
  it('round-trips through its JSON', () => {
    expect(parseStock(JSON.parse(serialiseStock(GOOD)))).toEqual(GOOD);
  });

  it('is refused unless it says what it is', () => {
    expect(parseStock({})).toMatch(/isn't a stock file/);
    expect(parseStock(file({ version: 2 }))).toMatch(/isn't a stock file/);
    expect(parseStock([1, 2])).toMatch(/isn't a stock file/);
  });

  it('is refused, with the reason, for any bad field', () => {
    expect(parseStock(file({ toolRadius: -1 }))).toMatch(/tool radius/);
    expect(parseStock(file({ boxes: 'no' }))).toMatch(/no list of boxes/);
    expect(parseStock(file({ boxes: Array(MAX_BOXES + 1).fill(GOOD.boxes[0]) }))).toMatch(
      /over 50/,
    );
    expect(parseStock(withBox({ id: '<img>' }))).toMatch(/bad id/);
    expect(parseStock(withBox({ name: 'x'.repeat(81) }))).toMatch(/at most 80/);
    expect(parseStock(withBox({ min: { X: 0, Y: 0 } }))).toMatch(/three numbers/);
    expect(parseStock(withBox({ size: { X: 1, Y: 1, Z: 'big' } }))).toMatch(/three numbers/);
    expect(parseStock(withBox({ size: { X: 0, Y: 1, Z: 1 } }))).toMatch(/above zero/);
    expect(parseStock(withBox({ color: 'red' }))).toMatch(/#rrggbb/);
    expect(parseStock(withBox({ visible: 'yes' }))).toMatch(/true or false/);
    expect(parseStock(file({ boxes: [GOOD.boxes[0], GOOD.boxes[0]] }))).toMatch(/used twice/);
  });
});

describe('nextId', () => {
  it('is one above the largest in use', () => {
    expect(nextId([])).toBe('s1');
    expect(
      nextId([{ ...GOOD.boxes[0], id: 's7' } as never, { ...GOOD.boxes[0], id: 'x' } as never]),
    ).toBe('s8');
  });
});
