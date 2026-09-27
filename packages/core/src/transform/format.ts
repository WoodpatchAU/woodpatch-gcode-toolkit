// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * How a transformed number is written (operator decision, 2026-09-27; ADR-0033).
 *
 * A number keeps its source word's decimal places when the result is exact at them:
 * X10 rotated by 90° is Y10, not Y10.000, so rotating four times gives the file back.
 * When it isn't exact (X10 moved by 0.25, or rotated 30°), it gets at least
 * `minDecimals` (3 in mm, 4 in inches: about a micrometre either way). No exponent,
 * no negative zero. A source that omits the leading zero (".5") or ends in a point
 * ("2.") keeps that style.
 */
export function formatLike(value: number, source: string, minDecimals: number): string {
  const point = source.indexOf('.');
  const decimals = point < 0 ? 0 : source.length - point - 1;
  const exact = Math.abs(roundTo(value, decimals) - value) <= 1e-9 * Math.max(1, Math.abs(value));
  const places = exact ? decimals : Math.max(decimals, minDecimals);
  let text = roundTo(value, places).toFixed(places);
  if (/^-0(\.0*)?$/.test(text)) text = text.slice(1); // no negative zero
  if (places === 0 && point >= 0) text += '.'; // "2." stays "N."
  // No leading zero in the source (".5", "-.5"): none in the result either.
  if (/^[+-]?\./.test(source)) text = text.replace(/^(-?)0\./, '$1.');
  return text;
}

function roundTo(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
