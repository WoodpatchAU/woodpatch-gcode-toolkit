// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { invalidOp, type TransformOp } from '@woodpatch/gcode-core';

/**
 * The transform panel's history (parcel 4e, ADR-0038): the transforms applied to the
 * text as it was opened, with undo and redo, and the recipe that reproduces them.
 *
 * The recipe always means "these ops, applied to the ORIGINAL, give the text in the
 * editor". So an edit by hand starts again: it resets the history, and the edited text
 * becomes the next original. (Keeping the old recipe would export one that no longer
 * gives what's on screen.)
 */
export class TransformHistory {
  /** The text before the first transform, while there is one. */
  private base: string | null = null;
  private steps: { readonly op: TransformOp; readonly text: string }[] = [];
  /** How many steps are in effect (the rest can be redone). */
  private at = 0;

  /** Forgets everything: a new file, or an edit by hand. */
  reset(): void {
    this.base = null;
    this.steps = [];
    this.at = 0;
  }

  /** Records a transform that took `before` to `after`. Discards anything undone. */
  push(before: string, op: TransformOp, after: string): void {
    if (this.at === 0) this.base = before;
    this.steps = this.steps.slice(0, this.at);
    this.steps.push({ op, text: after });
    this.at++;
  }

  /** Steps back one transform, returning the text to show, or null if there's none. */
  undo(): string | null {
    if (this.at === 0) return null;
    this.at--;
    return this.at === 0 ? this.base : (this.steps[this.at - 1]?.text ?? null);
  }

  /** Re-applies an undone transform, returning the text to show, or null. */
  redo(): string | null {
    if (this.at >= this.steps.length) return null;
    this.at++;
    return this.steps[this.at - 1]?.text ?? null;
  }

  get canUndo(): boolean {
    return this.at > 0;
  }

  get canRedo(): boolean {
    return this.at < this.steps.length;
  }

  /** The text the transforms started from, while any are in effect: what the ghost shows. */
  get original(): string | null {
    return this.at > 0 ? this.base : null;
  }

  /** The transforms in effect, in order: the recipe. */
  get ops(): TransformOp[] {
    return this.steps.slice(0, this.at).map((s) => s.op);
  }
}

// ── Recipes ────────────────────────────────────────────────────────────────

const FORMAT = 'woodpatch-gcode-recipe';

/** A recipe as a file: the ops, and the controller they were applied for. */
export function recipeJson(ops: readonly TransformOp[], dialect: string): string {
  return `${JSON.stringify({ format: FORMAT, version: 1, dialect, ops }, null, 2)}\n`;
}

/**
 * Reads a recipe file. Every op is checked as the core checks it (a misspelt field is
 * refused, never read as zero), so a hand-edited recipe can't apply something else.
 */
export function parseRecipe(
  text: string,
): { ok: true; ops: TransformOp[]; dialect: string | null } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This isn't a recipe: it isn't JSON" };
  }
  const r = data as Record<string, unknown>;
  if (typeof r !== 'object' || r === null || r['format'] !== FORMAT)
    return { ok: false, error: "This isn't a G-code recipe file" };
  if (r['version'] !== 1)
    return { ok: false, error: `Recipe version ${String(r['version'])} isn't supported (1 is)` };
  const ops = r['ops'];
  if (!Array.isArray(ops) || ops.length === 0)
    return { ok: false, error: 'The recipe has no operations' };
  for (const [i, op] of ops.entries()) {
    const bad =
      typeof op === 'object' && op !== null ? invalidOp(op as TransformOp) : 'not an operation';
    if (bad) return { ok: false, error: `Step ${i + 1}: ${bad}` };
  }
  const dialect = typeof r['dialect'] === 'string' ? r['dialect'] : null;
  return { ok: true, ops: ops as TransformOp[], dialect };
}

/** An op in words, for the recipe list. Lengths are mm. */
export function describeOp(op: TransformOp): string {
  const n = (v: number | undefined) => String(v ?? 0);
  switch (op.op) {
    case 'translate':
      return `Move X ${n(op.x)}, Y ${n(op.y)}, Z ${n(op.z)} mm`;
    case 'rotate':
      return `Rotate ${op.degrees}° about (${n(op.about?.x)}, ${n(op.about?.y)})`;
    case 'mirror':
      return `Mirror ${op.axis.toUpperCase()} about ${op.axis.toUpperCase()} = ${n(op.about)}`;
    case 'scale': {
      const y = op.y ?? op.x;
      const z = op.z ?? 1;
      const factors = y === op.x && z === 1 ? `× ${op.x} in XY` : `X × ${op.x}, Y × ${y}, Z × ${z}`;
      return `Scale ${factors} about (${n(op.about?.x)}, ${n(op.about?.y)}, ${n(op.about?.z)})`;
    }
    default:
      return JSON.stringify(op);
  }
}
