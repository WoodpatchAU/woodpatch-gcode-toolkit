// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import {
  Color,
  GridHelper,
  Group,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { buildSegments, DEFAULT_PALETTE, type Palette } from './geometry.js';
import { buildLineIndex, type LineIndex } from './lineIndex.js';
import type { LoadedProgram } from './program.js';
import {
  coverRadius,
  fitDistance,
  gridSpec,
  unionBox,
  VIEW_DIRECTIONS,
  type ViewName,
} from './view.js';

export interface ViewerOptions {
  readonly palette?: Partial<Palette>;
  /** Path line width in CSS pixels (real width: upstream's 1.5 was ignored, R12). Default 1.5. */
  readonly lineWidth?: number;
  /** Highlighted line width in CSS pixels. Default 4. */
  readonly highlightWidth?: number;
  /** How close (CSS px) a click must be to a segment to pick it. Default 6. */
  readonly pickRadius?: number;
}

/** A clicked point of the path: the source line that drew it (0: none / another file). */
export interface PickEvent {
  readonly line: number;
  readonly segment: number;
}

/**
 * One frame drawn (parcel 3f, ADR-0031), for a stats overlay or a performance gate.
 * `ms` is the CPU time to issue the frame; the GPU works asynchronously after that, so
 * sustained frame RATE (frames per second while orbiting) is the measure of smoothness.
 */
export interface RenderInfo {
  /** CPU milliseconds spent in three.js's render call. */
  readonly ms: number;
  /** WebGL draw calls issued for the frame. */
  readonly drawCalls: number;
  /** Line segments in the current path (0 before a program is set). */
  readonly segments: number;
}

/**
 * The 3D view (parcel 3a, ADR-0026). Framework-free: give it a container element,
 * then `setProgram()` with a {@link LoadedProgram} (from `loadProgram` or the worker).
 *
 * - WebGL2 via three.js, with LineSegments2 for REAL line widths (fixes R12).
 * - Z up, orbit/pan/zoom, fit to the path, standard views, a grid at machine Z0.
 * - `highlightLine(n)` draws line n's segments on top; clicks report the line picked.
 * - Renders on demand (after a change), not every frame: idle costs nothing.
 */
export class GcodeViewer {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.1, 100_000);
  private readonly controls: OrbitControls;
  private readonly world = new Group();
  private readonly palette: Palette;
  private readonly pathMaterial: LineMaterial;
  private readonly highlightMaterial: LineMaterial;
  private readonly ghostMaterial: LineMaterial;
  private readonly observer: ResizeObserver;
  private readonly raycaster = new Raycaster();
  private readonly pickListeners = new Set<(e: PickEvent) => void>();
  private readonly renderListeners = new Set<(info: RenderInfo) => void>();
  private path: LineSegments2 | null = null;
  private highlight: LineSegments2 | null = null;
  private ghost: LineSegments2 | null = null;
  private ghostProgram: LoadedProgram | null = null;
  /** The program's centre, the scene's origin: positions are relative to it. */
  private origin: readonly [number, number, number] = [0, 0, 0];
  private grid: GridHelper | null = null;
  private index: LineIndex | null = null;
  private program: LoadedProgram | null = null;
  private radius = 100;
  private frame = 0;
  private down: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: ViewerOptions = {},
  ) {
    this.palette = { ...DEFAULT_PALETTE, ...options.palette };
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(globalThis.devicePixelRatio ?? 1);
    this.renderer.setClearColor(new Color(this.palette.background));
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.camera.up.set(0, 0, 1); // CNC convention: Z up
    this.scene.add(this.world);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.requestRender());

    this.pathMaterial = new LineMaterial({
      linewidth: options.lineWidth ?? 1.5,
      vertexColors: true,
      worldUnits: false,
    });
    this.highlightMaterial = new LineMaterial({
      linewidth: options.highlightWidth ?? 4,
      color: this.palette.highlight,
      worldUnits: false,
      depthTest: false, // always visible, even behind other cuts
    });
    this.ghostMaterial = new LineMaterial({
      linewidth: options.lineWidth ?? 1.5,
      color: this.palette.ghost,
      worldUnits: false,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    this.raycaster.params.Line2 = { threshold: options.pickRadius ?? 6 };

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerCancel);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
  }

  /** Shows a program, replacing any previous one, and fits the view to it. */
  setProgram(program: LoadedProgram): void {
    if (this.disposed) return;
    this.program = program;
    this.index = buildLineIndex(program);
    const seg = buildSegments(program, this.palette);
    this.disposePath();
    const geometry = new LineSegmentsGeometry();
    if (seg.segments > 0) {
      geometry.setPositions(seg.positions);
      geometry.setColors(seg.colors);
    }
    this.path = new LineSegments2(geometry, this.pathMaterial);
    this.world.add(this.path);
    this.origin = seg.origin;
    this.buildGhost();
    this.placeGrid(seg.origin);
    this.setView('iso');
  }

  /**
   * Draws another program faintly behind this one, in one colour: the original under a
   * transformed result, say. It can't be picked, and the views frame both. Null clears it.
   * Set it before `setProgram` to have the first framing take it in.
   */
  setGhost(program: LoadedProgram | null): void {
    if (this.disposed) return;
    this.ghostProgram = program;
    this.buildGhost();
    this.requestRender();
  }

  /** Draws one source line's segments highlighted, or clears the highlight (null). */
  highlightLine(line: number | null): void {
    if (this.disposed) return;
    if (this.highlight) {
      this.world.remove(this.highlight);
      this.highlight.geometry.dispose();
      this.highlight = null;
    }
    const runs = line && this.index ? this.index.segmentsOf(line) : [];
    if (runs.length > 0 && this.path) {
      const src = (this.path.geometry as LineSegmentsGeometry).getAttribute('instanceStart');
      const array = (src as unknown as { data: { array: Float32Array } }).data.array;
      const count = runs.reduce((n, [a, b]) => n + (b - a), 0);
      const pos = new Float32Array(count * 6);
      let o = 0;
      for (const [a, b] of runs) {
        pos.set(array.subarray(a * 6, b * 6), o);
        o += (b - a) * 6;
      }
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(pos);
      this.highlight = new LineSegments2(geometry, this.highlightMaterial);
      this.highlight.renderOrder = 1;
      this.world.add(this.highlight);
    }
    this.requestRender();
  }

  /** Listens for clicks on the path. Returns a function that stops listening. */
  onPick(listener: (e: PickEvent) => void): () => void {
    this.pickListeners.add(listener);
    return () => this.pickListeners.delete(listener);
  }

  /** Listens for frames drawn (ADR-0031). Returns a function that stops listening. */
  onRender(listener: (info: RenderInfo) => void): () => void {
    this.renderListeners.add(listener);
    return () => this.renderListeners.delete(listener);
  }

  /** Points the camera along a standard direction, framing the whole path. */
  setView(view: ViewName): void {
    if (this.disposed) return;
    // Everything shown, the ghost included, about the scene's origin (the program's centre).
    const b = unionBox(this.program?.bounds.all, this.ghostProgram?.bounds.all);
    this.radius = Math.max(1, b ? coverRadius(b, this.origin) : Math.hypot(100, 100, 10) / 2);
    const [dx, dy, dz] = VIEW_DIRECTIONS[view];
    const d = fitDistance(this.radius, this.camera.fov, this.camera.aspect);
    this.camera.position.set(dx * d, dy * d, dz * d);
    this.camera.near = Math.max(0.01, d / 1000);
    this.camera.far = d * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.requestRender();
  }

  /** Call if the container's size changed without the ResizeObserver seeing it. */
  resize(): void {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pathMaterial.resolution.set(w, h);
    this.highlightMaterial.resolution.set(w, h);
    this.ghostMaterial.resolution.set(w, h);
    this.requestRender();
  }

  /** Frees everything, including the WebGL context. Later calls are ignored. */
  dispose(): void {
    if (this.disposed) return;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('pointerup', this.onPointerUp);
    el.removeEventListener('pointercancel', this.onPointerCancel);
    this.controls.dispose();
    this.disposePath();
    this.highlight?.geometry.dispose();
    this.grid?.dispose(); // geometry AND material
    this.pathMaterial.dispose();
    this.highlightMaterial.dispose();
    this.disposeGhost();
    this.ghostMaterial.dispose();
    // dispose() alone keeps the WebGL context alive, and browsers cap live contexts
    // (~16): a host mounting and unmounting viewers would start losing old ones.
    this.renderer.forceContextLoss();
    this.renderer.dispose();
    el.remove();
    this.pickListeners.clear();
    this.renderListeners.clear();
    this.disposed = true;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private requestRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const t0 = performance.now();
      this.renderer.render(this.scene, this.camera);
      if (this.renderListeners.size === 0) return;
      const info: RenderInfo = {
        ms: performance.now() - t0,
        drawCalls: this.renderer.info.render.calls,
        segments: this.program ? Math.max(0, this.program.count - 1) : 0,
      };
      for (const l of this.renderListeners) l(info);
    });
  }

  private buildGhost(): void {
    this.disposeGhost();
    const g = this.ghostProgram;
    if (!g || g.count < 2) return;
    const seg = buildSegments(g, this.palette);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(seg.positions);
    this.ghost = new LineSegments2(geometry, this.ghostMaterial);
    // Its own centre, placed relative to the scene's origin.
    this.ghost.position.set(
      seg.origin[0] - this.origin[0],
      seg.origin[1] - this.origin[1],
      seg.origin[2] - this.origin[2],
    );
    this.ghost.renderOrder = -1;
    this.world.add(this.ghost);
  }

  private disposeGhost(): void {
    if (!this.ghost) return;
    this.world.remove(this.ghost);
    this.ghost.geometry.dispose();
    this.ghost = null;
  }

  private disposePath(): void {
    if (this.path) {
      this.world.remove(this.path);
      this.path.geometry.dispose();
      this.path = null;
    }
    this.highlightLine(null);
  }

  /** A grid on the machine's Z0 plane, sized to the path (upstream's orange grid). */
  private placeGrid(origin: readonly [number, number, number]): void {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose(); // geometry AND material
    }
    const b = this.program?.bounds.all;
    const spec = gridSpec(b ? Math.max(b.max.X - b.min.X, b.max.Y - b.min.Y) : 100);
    this.grid = new GridHelper(spec.size, spec.divisions, this.palette.grid, this.palette.grid);
    this.grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; the machine's table is XY
    this.grid.position.set(0, 0, -origin[2]);
    this.scene.add(this.grid);
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };

  private readonly onPointerCancel = () => {
    this.down = null;
  };

  /** A click (not a drag, which orbits) picks the nearest segment under the pointer. */
  private readonly onPointerUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !this.path || !this.index) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.path, false);
    const hit = hits[0];
    if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return;
    const event = { segment: hit.faceIndex, line: this.index.lineOf(hit.faceIndex) };
    for (const l of this.pickListeners) l(event);
  };
}
