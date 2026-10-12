// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/** What became of a load, as far as the page is concerned. */
export type LoadOutcome<T> =
  | { readonly kind: 'show'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: Error }
  /** Superseded by a newer load, or for a document no longer in the editor: show nothing. */
  | { readonly kind: 'stale' };

/**
 * Runs `load` for the document `doc`, and says whether its result may be shown: only if
 * `doc` is still the current document when it settles, success or failure. Otherwise a
 * newer load is already on its way (every edit schedules one), and showing this one
 * would mix the live editor with an older parse: the new line count beside the old
 * extent, or diagnostics on the wrong lines. An AbortError is a load superseded by a
 * newer one, so it's stale too. (Documents are compared by identity: CodeMirror's are
 * immutable, so the same object means the same text.)
 */
export async function loadIfCurrent<D, T>(
  doc: D,
  current: () => D,
  load: () => Promise<T>,
): Promise<LoadOutcome<T>> {
  try {
    const value = await load();
    return current() === doc ? { kind: 'show', value } : { kind: 'stale' };
  } catch (e) {
    const error = e as Error;
    if (error.name === 'AbortError' || current() !== doc) return { kind: 'stale' };
    return { kind: 'failed', error };
  }
}
