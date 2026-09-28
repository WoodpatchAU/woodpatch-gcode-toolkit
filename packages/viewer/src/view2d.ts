// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import { VERTEX_ARC, VERTEX_RAPID } from '@woodpatch/gcode-core';
import { DEFAULT_PALETTE, type Palette } from './geometry.js';
import { buildLineIndex, type LineIndex } from './lineIndex.js';
import {
  fitTransform,
  gridLines,
  gridSpacing,
  nearestSegment,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
  type Transform,
} from './plane.js';
import type { LoadedProgram } from './program.js';
import type { PickEvent } from './viewer.js';

export interface View2DOptions {
  readonly palette?: Partial<Palette>;
  /** Path line width in CSS pixels. Default 1. */
  readonly lineWidth?: number;
  /** Highlighted line width in CSS pixels. Default 3. */
  readonly highlightWidth?: number;
  /** How close (CSS px) a click must be to a segment to pick it. Default 6. */
  readonly pickRadius?: number;
}

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/**
 * The 2D plan view (parcel 3d, ADR-0029): machine X/Y from above, on a Canvas 2D.
 * No three.js. The same {@link LoadedProgram}, colours, highlight and pick as the 3D
 * view, so a host can offer both.
 *
 * - Drag to pan, wheel to zoom about the pointer, `fit()` to frame the path.
 * - An adaptive grid (1/2/5 × 10ⁿ mm) with labels, and the machine's X/Y axes.
 * - Sharp on high-DPI screens; renders on demand, after a change.
 */
export class GcodeView2D {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly palette: Palette;
  private readonly observer: ResizeObserver;
  private readonly pickListeners = new Set<(e: PickEvent) => void>();
  private program: LoadedProgram | null = null;
  private ghost: LoadedProgram | null = null;
  private index: LineIndex | null = null;
  private highlighted: number | null = null;
  private t: Transform = { scale: 1, cx: 0, cy: 0 };
  private w = 1;
  private h = 1;
  private frame = 0;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  /** Whether the current program has been fitted to a real (visible) size yet. */
  private fitted = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: View2DOptions = {},
  ) {
    this.palette = { ...DEFAULT_PALETTE, ...options.palette };
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    Object.assign(this.canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      touchAction: 'none',
    });
    container.appendChild(this.canvas);
    this.canvas.addEventListener('pointerdown', this.onDown);
    this.canvas.addEventListener('pointermove', this.onMove);
    this.canvas.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('pointercancel', this.onCancel);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  /** Shows a program, replacing any previous one, and fits the view to it. */
  setProgram(program: LoadedProgram): void {
    if (this.disposed) return;
    this.program = program;
    this.index = buildLineIndex(program);
    this.highlighted = null;
    this.fit();
  }

  /**
   * Draws another program faintly behind this one, in one colour (the original under a
   * transformed result). It can't be picked, and `fit` frames both. Null clears it. The
   * view isn't re-framed: `setProgram` or `fit` does that.
   */
  setGhost(program: LoadedProgram | null): void {
    if (this.disposed) return;
    this.ghost = program;
    this.requestRender();
  }

  /** Frames the whole path, and the ghost if there is one. */
  fit(): void {
    if (this.disposed) return;
    this.t = fitTransform(this.program, this.w, this.h, this.ghost);
    // A fit while hidden (no size) doesn't count: fit again once there's a size.
    this.fitted = this.program !== null && this.hasSize();
    this.requestRender();
  }

  /** Draws one source line's segments highlighted, or clears the highlight (null). */
  highlightLine(line: number | null): void {
    if (this.disposed) return;
    this.highlighted = line;
    this.requestRender();
  }

  /** Listens for clicks on the path. Returns a function that stops listening. */
  onPick(listener: (e: PickEvent) => void): () => void {
    this.pickListeners.add(listener);
    return () => this.pickListeners.delete(listener);
  }

  /** Call if the container's size changed without the ResizeObserver seeing it. */
  resize(): void {
    if (this.disposed) return;
    this.w = Math.max(1, this.container.clientWidth);
    this.h = Math.max(1, this.container.clientHeight);
    const dpr = globalThis.devicePixelRatio ?? 1;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A program set while the view was hidden is fitted when it first gets a size.
    // After that, hiding and showing the view keeps the user's pan and zoom.
    if (!this.fitted && this.program && this.hasSize()) this.fit();
    else this.requestRender();
  }

  private hasSize(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0;
  }

  dispose(): void {
    if (this.disposed) return;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.remove();
    this.pickListeners.clear();
    this.program = null;
    this.ghost = null;
    this.index = null;
    this.disposed = true;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────

  private requestRender(): void {
    if (this.frame || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const { ctx, w, h, palette } = this;
    ctx.fillStyle = css(palette.background);
    ctx.fillRect(0, 0, w, h);
    this.drawGrid();
    const g = this.ghost;
    if (g && g.count >= 2) {
      // Under everything, one faint stroke.
      ctx.beginPath();
      for (let i = 0; i + 1 < g.count; i++) this.segment(g, i);
      ctx.strokeStyle = css(palette.ghost);
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = this.options.lineWidth ?? 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const p = this.program;
    if (!p || p.count < 2) return;
    // One path per colour: three strokes for the whole program, not one per segment.
    // Rapids go LAST, on top. This is a view from above, and rapids travel at a safe
    // height above the cuts. Drawn first, every traverse that crossed the cut area was
    // painted over and vanished from the plan (found by the Phase 3 acceptance checks).
    const width = this.options.lineWidth ?? 1;
    for (const [kind, colour] of [
      [-1, palette.feed], // feed: anything that isn't a rapid or an arc
      [VERTEX_ARC, palette.arc],
      [VERTEX_RAPID, palette.rapid],
    ] as const) {
      ctx.beginPath();
      for (let i = 0; i + 1 < p.count; i++) {
        const k = p.kind[i + 1];
        const mine = kind === -1 ? k !== VERTEX_RAPID && k !== VERTEX_ARC : k === kind;
        if (!mine) continue;
        this.segment(p, i);
      }
      ctx.strokeStyle = css(colour);
      ctx.lineWidth = width;
      ctx.stroke();
    }
    if (this.highlighted && this.index) {
      const runs = this.index.segmentsOf(this.highlighted);
      if (runs.length) {
        ctx.beginPath();
        for (const [a, b] of runs) for (let i = a; i < b; i++) this.segment(p, i);
        ctx.strokeStyle = css(palette.highlight);
        ctx.lineWidth = this.options.highlightWidth ?? 3;
        ctx.stroke();
      }
    }
  }

  private segment(p: LoadedProgram, i: number): void {
    const pos = p.positions;
    const [x1, y1] = toScreen(
      this.t,
      this.w,
      this.h,
      pos[i * 3] as number,
      pos[i * 3 + 1] as number,
    );
    const [x2, y2] = toScreen(
      this.t,
      this.w,
      this.h,
      pos[i * 3 + 3] as number,
      pos[i * 3 + 4] as number,
    );
    this.ctx.moveTo(x1, y1);
    this.ctx.lineTo(x2, y2);
  }

  /** The adaptive grid, its labels, and the machine X/Y axes through the origin. */
  private drawGrid(): void {
    const { ctx, w, h, t, palette } = this;
    const spacing = gridSpacing(t.scale);
    const [x0, y1] = toWorld(t, w, h, 0, 0);
    const [x1, y0] = toWorld(t, w, h, w, h);
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = css(palette.grid);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of gridLines(x0, x1, spacing)) {
      const [sx] = toScreen(t, w, h, x, 0);
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, h);
    }
    for (const y of gridLines(y0, y1, spacing)) {
      const [, sy] = toScreen(t, w, h, 0, y);
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(w, Math.round(sy) + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    const [ox, oy] = toScreen(t, w, h, 0, 0);
    ctx.moveTo(ox, 0);
    ctx.lineTo(ox, h);
    ctx.moveTo(0, oy);
    ctx.lineTo(w, oy);
    ctx.stroke();
    // Labels along the bottom and left edges.
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = css(palette.grid);
    ctx.font = '11px system-ui, sans-serif';
    const fmt = (v: number) => `${Number(v.toPrecision(6))}`;
    for (const x of gridLines(x0, x1, spacing, 60)) {
      const [sx] = toScreen(t, w, h, x, 0);
      ctx.fillText(fmt(x), sx + 3, h - 4);
    }
    for (const y of gridLines(y0, y1, spacing, 60)) {
      const [, sy] = toScreen(t, w, h, 0, y);
      ctx.fillText(fmt(y), 3, sy - 3);
    }
    ctx.restore();
  }

  // ── Interaction ─────────────────────────────────────────────────────────

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private readonly onDown = (e: PointerEvent) => {
    this.drag = { x: e.clientX, y: e.clientY, moved: false };
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private readonly onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    d.moved = true;
    this.t = panBy(this.t, dx, dy);
    d.x = e.clientX;
    d.y = e.clientY;
    this.requestRender();
  };

  /** A click (not a drag) picks the nearest segment within `pickRadius` pixels. */
  private readonly onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved || !this.program || !this.index) return;
    const [sx, sy] = this.local(e);
    const [x, y] = toWorld(this.t, this.w, this.h, sx, sy);
    const radius = (this.options.pickRadius ?? 6) / this.t.scale;
    // Within a pixel of the nearest, what's drawn on top wins (a rapid over a cut).
    const segment = nearestSegment(this.program, x, y, radius, 1 / this.t.scale);
    if (segment < 0) return;
    const event = { segment, line: this.index.lineOf(segment) };
    for (const l of this.pickListeners) l(event);
  };

  private readonly onCancel = () => {
    this.drag = null;
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [sx, sy] = this.local(e);
    this.t = zoomAt(this.t, this.w, this.h, sx, sy, Math.exp(-e.deltaY * 0.0015));
    this.requestRender();
  };
}
