// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

/** Page errors and CSP violations fail every test. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return problems;
}

const status = (page: Page) => page.locator('#status');

test('loads the default sample, draws it, and reports its stats', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  await expect(page.locator('#stats')).toContainText('segments');
  await expect(page.locator('.cm-content')).toContainText('G');

  // The 3D view has drawn something: it differs clearly from an empty view.
  const view = page.locator('#view');
  const drawn = (await view.screenshot()).length;
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expect(page.locator('#stats')).toContainText('no motion', { timeout: 10_000 });
  const empty = (await view.screenshot()).length;
  expect(drawn).toBeGreaterThan(empty * 1.3);
  expect(problems).toEqual([]);
});

test('the Masso sample shows diagnostics, and one moves the editor to its line', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  await page.selectOption('#dialect', 'masso-g3-5.13');
  await page.selectOption('#sample', 'masso-dialect-test-v1.nc');
  // Wait for the Masso reading of the Masso program: its T1 (a feed move before any F)
  // is only a warning under Masso. Earlier reads' lists may still be on screen before.
  await expect(page.locator('.cm-content')).toContainText('WOODPATCH MASSO DIALECT TEST', {
    timeout: 30_000,
  });
  await expect(page.locator('#diagnostics')).toContainText('SEMANTIC_FEED_UNSPECIFIED', {
    timeout: 30_000,
  });
  const first = page.locator('#diagnostics li button:not([disabled])').first();
  const label = (await first.textContent()) ?? '';
  const line = Number(label.replace(/\D+/g, ''));
  expect(line).toBeGreaterThan(0);
  await first.click();
  // The editor's active line is the diagnostic's line.
  const active = page.locator('.cm-lineNumbers .cm-activeLineGutter');
  await expect(active).toHaveText(String(line));
  expect(problems).toEqual([]);
});

test('editing the code re-reads it', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  // Inserted in one go: typing key by key once doubled a keystroke on a busy runner
  // (R55 for R5), and the extent check then failed for a reason it couldn't name.
  await page.keyboard.insertText('G21 G90\nG0 X10 Y10\nG1 Z-1 F100\nG2 X20 Y10 R5');
  // The text first, so a failure below is about reading it, not about what was typed.
  await expect(page.locator('.cm-line')).toHaveText([
    'G21 G90',
    'G0 X10 Y10',
    'G1 Z-1 F100',
    'G2 X20 Y10 R5',
  ]);
  await expect(page.locator('#stats')).toContainText('4 lines', { timeout: 10_000 });
  await expect(page.locator('#stats')).toContainText('extent 20.0 × 15.0 × 1.0 mm');
  expect(problems).toEqual([]);
});

/** Drops a file on `selector` as a browser would: a DataTransfer carrying one File. */
async function dropFile(page: Page, selector: string, name: string, text: string, pad = 0) {
  await page.evaluate(
    ([sel, n, t, p]) => {
      const parts: BlobPart[] = [t as string];
      if ((p as number) > 0) parts.push(new Uint8Array(p as number));
      const dt = new DataTransfer();
      dt.items.add(new File(parts, n as string));
      const target = document.querySelector(sel as string);
      if (!target) throw new Error(`no ${sel as string}`);
      for (const type of ['dragenter', 'dragover', 'drop'])
        target.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
    },
    [selector, name, text, pad] as const,
  );
}

test('a file dropped on the editor opens once, through the capped path', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  // Not doubled by CodeMirror's own drop handler inserting it as well (review, #23).
  await dropFile(page, '.cm-content', 'dropped.nc', '(DROPPED)\nG0 X5\nG1 Y5 F100');
  await expect(page).toHaveTitle(/dropped\.nc/);
  await expect(page.locator('#stats')).toContainText('3 lines', { timeout: 10_000 });
  const text = (await page.locator('.cm-content').textContent()) ?? '';
  expect(text.split('(DROPPED)')).toHaveLength(2);

  // Over the cap: refused before it's read, and the editor keeps what it had.
  await dropFile(page, '.cm-content', 'huge.nc', 'G0 X1\n', 21 * 1024 * 1024);
  await expect(status(page)).toContainText('huge.nc is over 20 MB');
  await expect(page.locator('.cm-content')).toContainText('(DROPPED)');
  expect(problems).toEqual([]);
});

/** WCAG relative luminance of an `rgb(…)`/`rgba(…)` colour. */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

test('the editor is readable on the dark page (text was once black on black)', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  const bg = await page.locator('.cm-editor').evaluate((e) => getComputedStyle(e).backgroundColor);
  // Plain text, a position word, and a comment all meet WCAG AA against it.
  for (const sel of ['.cm-content', '.gc-axis', '.gc-comment']) {
    const fg = await page
      .locator(sel)
      .first()
      .evaluate((e) => getComputedStyle(e).color);
    expect(contrast(fg, bg), `${sel}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(problems).toEqual([]);
});

test('the 2D plan draws, picks a line, and keeps its zoom when hidden', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  const plan = page.locator('#plan');
  await expect(plan).toBeHidden();
  await page.click('[data-view="plan"]');
  await expect(plan).toBeVisible();
  await expect(page.locator('[data-view="plan"]')).toHaveAttribute('aria-pressed', 'true');

  // Tux's raster fills the middle of the fitted plan: a click there picks a line, and
  // the editor marks it (and scrolls to it) without moving the cursor.
  const box = await plan.boundingBox();
  if (!box) throw new Error('no plan box');
  await expect(page.locator('.gc-path-line')).toHaveCount(0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator('.gc-path-line')).toHaveCount(1);
  await expect(page.locator('.gc-path-line')).toContainText('G1');

  // Zoom in, switch to 3D and back: the plan is as it was left, not re-fitted.
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 3);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(100);
  const zoomed = await plan.screenshot();
  await page.click('[data-view="iso"]');
  await expect(plan).toBeHidden();
  await page.click('[data-view="plan"]');
  await expect.poll(async () => (await plan.screenshot()).equals(zoomed)).toBe(true);

  // A second click on 2D re-frames the whole path.
  await page.click('[data-view="plan"]');
  await expect.poll(async () => (await plan.screenshot()).equals(zoomed)).toBe(false);

  // The plan has drawn something: it differs clearly from the plan of an empty program.
  const drawn = (await plan.screenshot()).length;
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expect(page.locator('#stats')).toContainText('no motion', { timeout: 10_000 });
  const empty = (await plan.screenshot()).length;
  expect(drawn).toBeGreaterThan(empty * 1.3);
  expect(problems).toEqual([]);
});

test('the summary box above the code shows extents, feeds and spindle, and a spindle-off warning jumps to its line', async ({
  page,
}) => {
  const problems = watch(page);
  await page.goto('/');
  const box = page.locator('#summary-box');
  // Fixed height from the start: filling it in mustn't move the editor (layout shift).
  const before = await box.boundingBox();
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  const after = await box.boundingBox();
  expect(after?.height).toBe(before?.height);
  // Above the editor, in the same column.
  const editor = await page.locator('#editor').boundingBox();
  expect((after?.y ?? 0) + (after?.height ?? 0)).toBeLessThanOrEqual((editor?.y ?? 0) + 1);

  // Tux cuts X 0..10 at 200 mm/min, and never starts the spindle.
  const x = page.locator('.summary-extent tr', { hasText: /^X/ });
  await expect(x.locator('td').nth(0)).toHaveText('0.000');
  await expect(x.locator('td').nth(1)).toHaveText('10.000');
  await expect(page.locator('.summary-facts')).toContainText('200 mm/min');
  await expect(page.locator('.summary-facts')).toContainText('never on while cutting');
  const warning = page.locator('.summary-warning');
  await expect(warning).toContainText('Cuts with the spindle off');
  await warning.getByRole('button', { name: 'line 11' }).click();
  await expect(page.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('11');
  expect(problems).toEqual([]);
});
