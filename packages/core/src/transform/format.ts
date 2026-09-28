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
/**
 * The largest magnitude a transform writes: 1,000,000 (1 km in mm, 25 km in inches),
 * far beyond any machine, and no real feed or speed comes near it. Beyond it, `toFixed`
 * drifts into digits a float doesn't hold, and past 1e21 into exponents ("1e+21") and
 * "Infinity", which no controller reads.
 */
export const MAX_WRITTEN = 1_000_000;

/** Whether `value` can be written as a G-code number. */
export function writable(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_WRITTEN;
}

function assertWritable(value: number): void {
  // The transforms refuse such values first; reaching here is a bug, not bad input.
  if (!writable(value))
    throw new RangeError(`${value} is out of range for a G-code number (|v| ≤ ${MAX_WRITTEN})`);
}

export function formatLike(value: number, source: string, minDecimals: number): string {
  assertWritable(value);
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

/**
 * How a converted number is written (units conversion, ADR-0034). The source's decimal
 * places mean nothing across units (0.48602 in is 12.3449… mm), so the value is rounded
 * to `places` (5 for inches, 3 for millimetres) and trailing zeros dropped: 25.4 mm is
 * written 1.0 in, 10 mm 0.3937 in, 254 mm/min 10 in/min. A source with a decimal point
 * keeps at least one decimal; one without none, when the result is whole. Leading-zero
 * style (".5") and no negative zero, as {@link formatLike}.
 */
export function formatConverted(value: number, source: string, places: number): string {
  const f = 10 ** places;
  let text = (Math.round(value * f) / f).toFixed(places);
  if (text.includes('.')) text = text.replace(/0+$/, '');
  if (text.endsWith('.')) text = source.includes('.') ? `${text}0` : text.slice(0, -1);
  if (/^-0(\.0*)?$/.test(text)) text = text.slice(1);
  if (/^[+-]?\./.test(source)) text = text.replace(/^(-?)0\./, '$1.');
  return text;
}
