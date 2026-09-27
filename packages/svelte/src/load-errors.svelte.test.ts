// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Parcel 3e (ADR-0030): when a lazily loaded package fails to load (a chunk error, a
// CSP block), each component reports it through `onerror` instead of an unhandled
// rejection and a silently blank box. Here every lazy import fails.

vi.mock('@woodpatch/gcode-viewer', () => {
  throw new Error('viewer chunk failed');
});
vi.mock('@woodpatch/gcode-editor', () => {
  throw new Error('editor chunk failed');
});

let app: Record<string, unknown> | undefined;
afterEach(() => {
  if (app) unmount(app);
  app = undefined;
});

const mounted = async (name: 'GcodeViewer' | 'GcodeEditor' | 'GcodeWorkbench') => {
  const lib = await import('./index.js');
  const errors: string[] = [];
  app = mount(lib[name] as never, {
    target: document.body,
    props: {
      // Vitest wraps a failing mock's error; the original is its cause.
      onerror: (e: Error) => errors.push(`${e.message} ${String((e.cause as Error)?.message)}`),
      createWorker: () => ({}) as Worker,
    },
  });
  await vi.dynamicImportSettled();
  return errors;
};

describe('a lazy import that fails reaches onerror', () => {
  it('GcodeViewer', async () => {
    const errors = await mounted('GcodeViewer');
    await vi.waitFor(() => expect(errors.join()).toContain('viewer chunk failed'));
  });
  it('GcodeEditor', async () => {
    const errors = await mounted('GcodeEditor');
    await vi.waitFor(() => expect(errors.join()).toContain('editor chunk failed'));
  });
  it('GcodeWorkbench (its own import and its children)', async () => {
    const errors = await mounted('GcodeWorkbench');
    await vi.waitFor(() => {
      expect(errors.join()).toContain('viewer chunk failed');
      expect(errors.join()).toContain('editor chunk failed');
    });
  });
});
