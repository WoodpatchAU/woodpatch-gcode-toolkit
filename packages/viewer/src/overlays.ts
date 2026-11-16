// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

/**
 * What the 3D view draws besides the path (ADR-0054): the operator's stock, and the
 * path's measurements. Plain three.js objects, built in scene coordinates (relative to
 * the scene's origin, the program's centre), and freed by `disposeGroup`.
 */

import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
} from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Box } from '@woodpatch/gcode-core';
import type { StockShape } from '@woodpatch/gcode-core';

/** A piece of stock as the view shows it. */
export interface StockItem {
  readonly shape: StockShape;
  /** Default true. A hidden shape isn't drawn and isn't framed by the views. */
  readonly visible?: boolean;
  /** 0xRRGGBB. Default: the palette's stock colour. */
  readonly color?: number;
  /** 0..1 for the faces (edges are solid). Default 0.18: the path stays visible. */
  readonly opacity?: number;
}

type Origin = readonly [number, number, number];

/** The stock's bounds (visible shapes only), for framing. Null if none is visible. */
export function stockBounds(items: readonly StockItem[]): Box | null {
  let box: { min: [number, number, number]; max: [number, number, number] } | null = null;
  for (const it of items) {
    if (it.visible === false) continue;
    const { min, size } = it.shape;
    const lo: [number, number, number] = [min.X, min.Y, min.Z];
    const hi: [number, number, number] = [min.X + size.X, min.Y + size.Y, min.Z + size.Z];
    if (!box) box = { min: lo, max: hi };
    else
      for (let i = 0; i < 3; i++) {
        box.min[i] = Math.min(box.min[i] as number, lo[i] as number);
        box.max[i] = Math.max(box.max[i] as number, hi[i] as number);
      }
  }
  if (!box) return null;
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  return { min: { X: x0, Y: y0, Z: z0 }, max: { X: x1, Y: y1, Z: z1 } };
}

/** Translucent faces and solid edges for each visible box. */
export function buildStock(items: readonly StockItem[], origin: Origin, color: number): Group {
  const group = new Group();
  group.name = 'stock';
  for (const it of items) {
    if (it.visible === false) continue;
    const { min, size } = it.shape;
    const c = it.color ?? color;
    const geometry = new BoxGeometry(size.X, size.Y, size.Z);
    const faces = new Mesh(
      geometry,
      new MeshBasicMaterial({
        color: c,
        transparent: true,
        opacity: it.opacity ?? 0.18,
        depthWrite: false,
      }),
    );
    const edges = new LineSegments(
      new EdgesGeometry(geometry),
      new LineBasicMaterial({ color: c }),
    );
    const holder = new Group();
    holder.name = it.shape.id;
    holder.position.set(
      min.X + size.X / 2 - origin[0],
      min.Y + size.Y / 2 - origin[1],
      min.Z + size.Z / 2 - origin[2],
    );
    holder.add(faces, edges);
    group.add(holder);
  }
  return group;
}

/** A length or coordinate as a label: up to 3 decimals, no trailing zeros. */
export const fmt = (v: number): string => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

function label(text: string, color: number): CSS2DObject {
  const el = document.createElement('div');
  el.textContent = text; // never HTML: the text is numbers, but keep the rule
  el.className = 'gcv-dimension';
  const s = el.style;
  s.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  s.color = `#${color.toString(16).padStart(6, '0')}`;
  s.background = 'rgba(0, 0, 0, 0.55)';
  s.padding = '1px 4px';
  s.borderRadius = '3px';
  s.whiteSpace = 'nowrap';
  s.pointerEvents = 'none';
  return new CSS2DObject(el);
}

function lines(points: number[], material: LineBasicMaterial | LineDashedMaterial): LineSegments {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(points, 3));
  const l = new LineSegments(g, material);
  if (material instanceof LineDashedMaterial) l.computeLineDistances();
  return l;
}

/**
 * The box round the path, with its length along X, Y and Z on dimension lines set off
 * from it, and the coordinates of its lowest and highest corners.
 */
export function buildDimensions(b: Box, origin: Origin, color: number): Group {
  const group = new Group();
  group.name = 'dimensions';
  const [ox, oy, oz] = origin;
  const x0 = b.min.X - ox;
  const y0 = b.min.Y - oy;
  const z0 = b.min.Z - oz;
  const x1 = b.max.X - ox;
  const y1 = b.max.Y - oy;
  const z1 = b.max.Z - oz;
  const span = Math.max(b.max.X - b.min.X, b.max.Y - b.min.Y, b.max.Z - b.min.Z, 1);
  const gap = span * 0.06; // dimension lines stand off the box by this
  const tick = span * 0.02;

  // The box itself, dashed.
  const c = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ] as const;
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const boxPts: number[] = [];
  for (const [a, e] of edges)
    boxPts.push(...(c[a as number] as readonly number[]), ...(c[e as number] as readonly number[]));
  const dashed = new LineDashedMaterial({ color, dashSize: span * 0.02, gapSize: span * 0.015 });
  group.add(lines(boxPts, dashed));

  // Dimension lines: X in front (below min Y), Y and Z to the right (beyond max X).
  const solid = new LineBasicMaterial({ color });
  const dim: number[] = [];
  const seg = (a: number[], e: number[]) => dim.push(...a, ...e);
  // X: along y0 - gap, z0, with ticks and extension lines from the box's corners.
  const yx = y0 - gap;
  seg([x0, yx, z0], [x1, yx, z0]);
  seg([x0, y0, z0], [x0, yx - tick, z0]);
  seg([x1, y0, z0], [x1, yx - tick, z0]);
  // Y: along x1 + gap, z0.
  const xy = x1 + gap;
  seg([xy, y0, z0], [xy, y1, z0]);
  seg([x1, y0, z0], [xy + tick, y0, z0]);
  seg([x1, y1, z0], [xy + tick, y1, z0]);
  // Z: up the corner (x1 + gap, y0 - gap).
  seg([xy, yx, z0], [xy, yx, z1]);
  seg([x1, y0, z1], [xy + tick, yx - tick, z1]);
  group.add(lines(dim, solid));

  const put = (o: Object3D, x: number, y: number, z: number) => {
    o.position.set(x, y, z);
    group.add(o);
  };
  put(label(`X ${fmt(b.max.X - b.min.X)}`, color), (x0 + x1) / 2, yx - tick, z0);
  put(label(`Y ${fmt(b.max.Y - b.min.Y)}`, color), xy + tick, (y0 + y1) / 2, z0);
  put(label(`Z ${fmt(b.max.Z - b.min.Z)}`, color), xy + tick, yx - tick, (z0 + z1) / 2);
  put(label(`${fmt(b.min.X)}, ${fmt(b.min.Y)}, ${fmt(b.min.Z)}`, color), x0, y0, z0);
  put(label(`${fmt(b.max.X)}, ${fmt(b.max.Y)}, ${fmt(b.max.Z)}`, color), x1, y1, z1);
  return group;
}

/** Frees a group's geometries and materials and removes its labels' elements. */
export function disposeGroup(group: Group): void {
  group.traverse((o) => {
    const m = o as Partial<Mesh>;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else mat?.dispose();
    if (o instanceof CSS2DObject) o.element.remove();
  });
  group.removeFromParent();
}
