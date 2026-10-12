// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { ProgramLoader, type LoadedProgram, type WorkerLike } from '@woodpatch/gcode-viewer';
import { loadIfCurrent } from './fresh.js';

// The playground's "still the current document" guard, against a real ProgramLoader and
// a stand-in worker that holds its replies until the test releases them: so an edit can
// land while a load is in flight, deterministically (the e2e smoke test can only hope
// to hit that 400 ms window).

class HeldWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  readonly posted: number[] = [];
  terminated = false;
  postMessage(m: { id: number }): void {
    this.posted.push(m.id);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Releases the reply to the last request: a program, or an error message. */
  reply(result: { program: unknown } | { error: string }): void {
    const id = this.posted.at(-1) as number;
    const data =
      'error' in result ? { id, ok: false, error: result.error } : { id, ok: true, ...result };
    this.onmessage?.({ data } as MessageEvent);
  }
}

const setup = () => {
  const workers: HeldWorker[] = [];
  const loader = new ProgramLoader(() => {
    const w = new HeldWorker();
    workers.push(w);
    return w;
  });
  // The editor's document: an object, compared by identity, like CodeMirror's.
  const editor = { doc: { text: 'G0 X1' } };
  const read = () => {
    const doc = editor.doc;
    return loadIfCurrent(
      doc,
      () => editor.doc,
      () => loader.load(doc.text),
    );
  };
  return { workers, editor, read };
};
const PROGRAM = { count: 1 } as unknown as LoadedProgram;

describe('loadIfCurrent with the ProgramLoader', () => {
  it('shows a load whose document is still the current one', async () => {
    const { workers, read } = setup();
    const out = read();
    workers[0]?.reply({ program: PROGRAM });
    expect(await out).toEqual({ kind: 'show', value: PROGRAM });
  });

  it('drops a load that finishes after an edit (the race the e2e test can only hope for)', async () => {
    const { workers, editor, read } = setup();
    const out = read();
    editor.doc = { text: 'G0 X2' }; // typed while the worker was busy
    workers[0]?.reply({ program: PROGRAM });
    expect(await out).toEqual({ kind: 'stale' });
  });

  it('reports a failure only for the current document', async () => {
    const { workers, editor, read } = setup();
    const failed = read();
    workers[0]?.reply({ error: 'boom' });
    expect(await failed).toMatchObject({ kind: 'failed', error: { message: 'boom' } });
    // The same failure after an edit is stale: the newer read will say how it went.
    const late = read();
    editor.doc = { text: 'G0 X3' };
    workers[0]?.reply({ error: 'boom' });
    expect(await late).toEqual({ kind: 'stale' });
  });

  it('treats a load superseded by a newer one as stale, and shows the newer', async () => {
    const { workers, editor, read } = setup();
    const first = read();
    editor.doc = { text: 'G0 X4' };
    const second = read(); // terminates the first worker, starts a fresh one
    expect(await first).toEqual({ kind: 'stale' });
    expect(workers[0]?.terminated).toBe(true);
    workers[1]?.reply({ program: PROGRAM });
    expect(await second).toEqual({ kind: 'show', value: PROGRAM });
  });
});
