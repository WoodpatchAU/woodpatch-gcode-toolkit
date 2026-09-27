// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { expect, test, type Locator, type Page } from '@playwright/test';

// Phase 3 acceptance (parcel 3f, ADR-0031). Operator decisions, 2026-09-27:
// - Visual checks are STRUCTURAL, not pixel baselines: a GPU or driver change on the
//   runner would break a baseline without anything being wrong. Instead, each sample's
//   rendering is decoded and checked. Is the path framed and in view? Are the feed,
//   rapid and highlight colours there when they should be?
// - Performance: CI gates the proxies (read time, geometry build time, draw calls) on
//   the largest sample. 60 fps itself is measured by a person with `?stats`.

// motionLine: an early line that CUTS in X/Y (a plunge would be invisible from above),
// at least 2 mm, which is a few pixels at the fitted zoom. For Aztec it's null: its
// first such line is line 150, and 149 cursor moves each re-render 226k segments in
// the runner's software GL (minutes). It checks the other direction instead: a click
// on its plan marks the line in the editor. planRapids: whether any rapid
// moves in X/Y (Tux's only rapids are vertical, so its plan has none to show). Both
// were computed from the programs themselves.
const SAMPLES = [
  { file: 'tux.ngc', dialect: 'generic', motionLine: 11, planRapids: false },
  { file: 'webgcode.ngc', dialect: 'generic', motionLine: 53, planRapids: true },
  { file: 'test_pycam.ngc', dialect: 'generic', motionLine: 48, planRapids: true },
  { file: 'aztec_calendar.ngc', dialect: 'generic', motionLine: null, planRapids: true },
  { file: 'masso-dialect-test-v1.nc', dialect: 'masso-g3-5.13', motionLine: 15, planRapids: true },
] as const;

interface PixelStats {
  w: number;
  h: number;
  /** Pixels in the path's colours: feed/arc (white), rapid (red), highlight (yellow). */
  white: number;
  red: number;
  yellow: number;
  /** The bounding box of every path-coloured pixel, or null if there are none. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** A feed-coloured pixel nearest the centre: somewhere a click will pick the path. */
  feedAt: { x: number; y: number } | null;
}

/**
 * Screenshots an element and classifies its pixels, in the page (no image library).
 * Colours are matched loosely: lines are antialiased. The grid (orange) and the
 * background match none of the classes.
 */
async function pixels(page: Page, el: Locator): Promise<PixelStats> {
  const png = (await el.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const s = {
      w: bmp.width,
      h: bmp.height,
      white: 0,
      red: 0,
      yellow: 0,
      box: null as PixelStats['box'],
      feedAt: null as PixelStats['feedAt'],
    };
    let best = Infinity;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] as number;
      const g = d[i + 1] as number;
      const b = d[i + 2] as number;
      let hit = true;
      if (r > 200 && g > 200 && b > 200) {
        s.white++;
        const p = i / 4;
        const dx = (p % bmp.width) - bmp.width / 2;
        const dy = Math.floor(p / bmp.width) - bmp.height / 2;
        if (dx * dx + dy * dy < best) {
          best = dx * dx + dy * dy;
          s.feedAt = { x: p % bmp.width, y: Math.floor(p / bmp.width) };
        }
      } else if (r > 200 && g > 200 && b < 90) s.yellow++;
      else if (r > 200 && g < 70 && b < 70) s.red++;
      else hit = false;
      if (!hit) continue;
      const p = i / 4;
      const x = p % bmp.width;
      const y = Math.floor(p / bmp.width);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (x1 >= 0) s.box = { x0, y0, x1, y1 };
    return s;
  }, png);
}

/** The path is in view, roughly centred, and big enough to be the fitted whole. */
function expectFramed(s: PixelStats, minFill: number, label: string): void {
  const b = s.box;
  if (!b) throw new Error(`${label}: nothing drawn`);
  const fill = Math.max((b.x1 - b.x0 + 1) / s.w, (b.y1 - b.y0 + 1) / s.h);
  const cx = (b.x0 + b.x1) / 2 / s.w - 0.5;
  const cy = (b.y0 + b.y1) / 2 / s.h - 0.5;
  console.log(`${label}: fill ${fill.toFixed(2)} centre ${cx.toFixed(2)},${cy.toFixed(2)}`);
  expect(fill, `${label}: fitted path fills too little of the view`).toBeGreaterThanOrEqual(
    minFill,
  );
  expect(Math.abs(cx), `${label}: not centred horizontally`).toBeLessThan(0.2);
  expect(Math.abs(cy), `${label}: not centred vertically`).toBeLessThan(0.2);
}

async function openSample(page: Page, file: string, dialect: string): Promise<void> {
  await page.selectOption('#dialect', dialect);
  await page.selectOption('#sample', file);
  await expect(page).toHaveTitle(new RegExp(file.replace('.', '\\.')));
  await expect(page.locator('#status')).toContainText('Read in', { timeout: 60_000 });
}

/** Puts the editor's cursor on a line (1-based) with the keyboard, as a person would. */
async function cursorTo(page: Page, line: number): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText(String(line));
}

for (const s of SAMPLES) {
  test(`${s.file}: framed in 3D and 2D, in the path colours, and highlights the cursor's line`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('Read in', { timeout: 60_000 });
    await openSample(page, s.file, s.dialect);

    const view = page.locator('#view');
    const plan = page.locator('#plan');
    const iso = await pixels(page, view);
    expectFramed(iso, 0.3, `${s.file} 3D`);
    expect(iso.white, `${s.file} 3D: feed moves`).toBeGreaterThan(300);
    expect(iso.red, `${s.file} 3D: rapid moves`).toBeGreaterThan(2);
    expect(iso.yellow, `${s.file} 3D: nothing highlighted yet`).toBe(0);

    await page.click('[data-view="plan"]');
    await expect(plan).toBeVisible();
    const top = await pixels(page, plan);
    expectFramed(top, 0.6, `${s.file} 2D`);
    expect(top.white, `${s.file} 2D: feed moves`).toBeGreaterThan(300);
    // Rapids travel above the cuts, so the plan draws them on top: they must show.
    if (s.planRapids) expect(top.red, `${s.file} 2D: rapid moves`).toBeGreaterThan(2);
    else expect(top.red, `${s.file} 2D: no rapid moves in X/Y`).toBe(0);

    if (s.motionLine !== null) {
      // Editor → path: the cursor's line lights up in both views.
      await cursorTo(page, s.motionLine);
    } else {
      // Path → editor: a click on a drawn cut marks its line in the editor.
      const at = top.feedAt;
      const box = await plan.boundingBox();
      if (!at || !box) throw new Error(`${s.file}: nowhere to click`);
      await expect(page.locator('.gc-path-line')).toHaveCount(0);
      await page.mouse.click(box.x + at.x, box.y + at.y);
      await expect(page.locator('.gc-path-line')).toHaveCount(1);
    }
    await expect.poll(async () => (await pixels(page, plan)).yellow).toBeGreaterThan(0);
    await page.click('[data-view="iso"]');
    await expect.poll(async () => (await pixels(page, view)).yellow).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

test('the largest sample stays within the performance proxies', async ({ page }) => {
  // aztec_calendar.ngc: 223,857 lines, 226,632 vertices. Budgets are generous multiples
  // of what the CI runner measured (ADR-0031): they catch a regression of kind (a
  // quadratic step, geometry per segment), not a noisy few percent.
  test.setTimeout(120_000);
  await page.goto('/?stats');
  await expect(page.locator('#status')).toContainText('Read in', { timeout: 60_000 });
  const before = await page.evaluate(() => window.__gcodeStats?.loads ?? 0);
  await openSample(page, 'aztec_calendar.ngc', 'generic');
  await expect
    .poll(() => page.evaluate(() => window.__gcodeStats?.loads ?? 0))
    .toBeGreaterThan(before);
  await expect
    .poll(() => page.evaluate(() => window.__gcodeStats?.segments ?? 0))
    .toBeGreaterThan(200_000);

  // Orbit for a second. Under the runner's software GL a frame of 226k segments can
  // take most of that, so the check is that it drew at all, not how often.
  const rendersBefore = await page.evaluate(() => window.__gcodeStats?.renders ?? 0);
  const box = await page.locator('#view > canvas').boundingBox();
  if (!box) throw new Error('no 3D canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 1000; i++)
    await page.mouse.move(box.x + box.width / 2 + ((i * 7) % 200) - 100, box.y + box.height / 2);
  await page.mouse.up();
  const stats = await page.evaluate(() => window.__gcodeStats);
  if (!stats) throw new Error('no stats');
  console.log(
    `aztec: read ${Math.round(stats.readMs)} ms, build ${Math.round(stats.buildMs)} ms, ` +
      `${stats.drawCalls} draw calls, ${stats.segments} segments, ` +
      `${stats.renders - rendersBefore} frames drawn while orbiting, last ${stats.renderMs.toFixed(1)} ms ` +
      '(headless, software GL: not the fps target)',
  );
  // Budgets: about 10x the runner's measurement on 2026-09-27 (read 474 ms, build 61 ms,
  // 2 draw calls). They catch a regression of KIND (a quadratic step, a draw call per
  // segment), not noise.
  expect(stats.drawCalls, 'draw calls per frame').toBeLessThanOrEqual(4);
  expect(stats.readMs, 'worker read (parse, interpret, tessellate)').toBeLessThan(5_000);
  expect(stats.buildMs, '3D geometry build on the page').toBeLessThan(1_000);
  await expect
    .poll(() => page.evaluate(() => window.__gcodeStats?.renders ?? 0), { timeout: 10_000 })
    .toBeGreaterThan(rendersBefore);
});
