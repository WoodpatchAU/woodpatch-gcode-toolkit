// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT

import type { GcodeViewer, RenderInfo } from '@woodpatch/gcode-viewer';

/**
 * The `?stats` overlay (parcel 3f, ADR-0031): what the 60 fps acceptance is measured
 * with. Orbit continuously and read `fps`, the frames the 3D view drew in the last
 * second (it draws on demand, so fps is 0 when nothing moves). The same numbers are
 * published on `window.__gcodeStats` for the CI performance proxies.
 */
export interface PlaygroundStats {
  /** Frames drawn in the last second. */
  fps: number;
  /** The last frame's render call, CPU ms. */
  renderMs: number;
  drawCalls: number;
  segments: number;
  /** The last program: read in the worker, then its 3D geometry built. */
  readMs: number;
  buildMs: number;
  /** Programs shown so far, so a test can wait for the next one. */
  loads: number;
}

declare global {
  interface Window {
    __gcodeStats?: PlaygroundStats;
  }
}

/** Installs the overlay if the page URL has `?stats`. Returns a recorder, or null. */
export function installStats(
  viewer: GcodeViewer,
  host: HTMLElement,
): ((readMs: number, buildMs: number) => void) | null {
  if (!new URLSearchParams(location.search).has('stats')) return null;
  const stats: PlaygroundStats = {
    fps: 0,
    renderMs: 0,
    drawCalls: 0,
    segments: 0,
    readMs: 0,
    buildMs: 0,
    loads: 0,
  };
  window.__gcodeStats = stats;
  const el = document.createElement('pre');
  el.className = 'stats-overlay';
  el.setAttribute('aria-label', 'Rendering statistics');
  host.append(el);

  const frames: number[] = [];
  const show = () => {
    const now = performance.now();
    while (frames.length && (frames[0] as number) < now - 1000) frames.shift();
    stats.fps = frames.length;
    el.textContent =
      `${stats.fps} fps  ${stats.renderMs.toFixed(1)} ms/frame\n` +
      `${stats.drawCalls} draw calls  ${stats.segments.toLocaleString('en-AU')} segments\n` +
      `read ${Math.round(stats.readMs)} ms  build ${Math.round(stats.buildMs)} ms`;
  };
  viewer.onRender((info: RenderInfo) => {
    frames.push(performance.now());
    stats.renderMs = info.ms;
    stats.drawCalls = info.drawCalls;
    stats.segments = info.segments;
  });
  setInterval(show, 250);
  show();
  return (readMs, buildMs) => {
    stats.readMs = readMs;
    stats.buildMs = buildMs;
    stats.loads++;
  };
}
