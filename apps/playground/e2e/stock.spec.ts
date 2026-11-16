// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { expect, test, type Page } from '@playwright/test';

// The stock panel and measurements (ADR-0054), in a real browser.

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return problems;
}

// A rapid at Z-5 straight across where the default box (0..100, 0..100, -20..0) sits.
const PART = 'G21 G90\nG0 X-20 Y50 Z5\nG0 Z-5\nG0 X120\nG0 Z5\nM2\n';
const status = (page: Page) => page.locator('#status');
const diags = (page: Page) => page.locator('#diagnostics');

async function openPart(page: Page): Promise<void> {
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  await page.setInputFiles('#file', {
    name: 'part.nc',
    mimeType: 'text/plain',
    buffer: Buffer.from(PART),
  });
  await expect(page.locator('.cm-content')).toContainText('G0 X120', { timeout: 30_000 });
  await page.locator('#stock-box > summary').click();
}

test('a box flags the rapid through it, hiding it clears the flag, and it is kept', async ({
  page,
}) => {
  const problems = watch(page);
  await openPart(page);
  await page.click('#stock-add');
  await expect(page.locator('#stock-list li')).toHaveCount(1);
  await expect(page.locator('#stock-count')).toHaveText(' (1)');
  await expect(diags(page)).toContainText('STOCK_RAPID_COLLISION');
  await expect(diags(page)).toContainText('Line 4');
  await expect(page.locator('#stock-msg')).toContainText('1 rapid reaches into the stock');

  // Hidden: not checked.
  await page.locator('#stock-list li input[type="checkbox"]').uncheck();
  await expect(diags(page)).not.toContainText('STOCK_RAPID_COLLISION');

  // Shown again and moved clear of the path: still nothing.
  await page.locator('#stock-list li input[type="checkbox"]').check();
  await expect(diags(page)).toContainText('STOCK_RAPID_COLLISION');
  await page.getByRole('spinbutton', { name: 'Lowest corner Z' }).fill('-100');
  await expect(diags(page)).not.toContainText('STOCK_RAPID_COLLISION');

  // Kept in this browser: a reload brings it back.
  await page.reload();
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  await expect(page.locator('#stock-count')).toHaveText(' (1)');
  expect(problems).toEqual([]);
});

test('the tool radius counts: a near miss becomes a graze', async ({ page }) => {
  const problems = watch(page);
  await openPart(page);
  await page.click('#stock-add');
  // Move the box so the rapid's centre line passes 5 mm in front of it (Y 55..155).
  await page.getByRole('spinbutton', { name: 'Lowest corner Y' }).fill('55');
  await expect(diags(page)).not.toContainText('STOCK_RAPID_COLLISION');
  await page.fill('#stock-radius', '6');
  await expect(diags(page)).toContainText('STOCK_RAPID_COLLISION');
  expect(problems).toEqual([]);
});

test('a stock file is saved, and a bad one is refused with the reason', async ({ page }) => {
  const problems = watch(page);
  await openPart(page);
  await page.click('#stock-add');
  const download = page.waitForEvent('download');
  await page.click('#stock-export');
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('stock.json');

  await page.setInputFiles('#stock-import', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      '{"format":"woodpatch-stock","version":1,"toolRadius":0,"boxes":[{"id":"s1","name":"x","min":{"X":0,"Y":0,"Z":0},"size":{"X":0,"Y":1,"Z":1},"color":"#ffffff","visible":true}]}',
    ),
  });
  await expect(page.locator('#stock-msg')).toContainText('bad.json: ');
  await expect(page.locator('#stock-msg')).toContainText('not loaded');
  await expect(page.locator('#stock-list li')).toHaveCount(1); // the old stock stays
  expect(problems).toEqual([]);
});

test('Measure shows the path box with its lengths, and hides it again', async ({ page }) => {
  const problems = watch(page);
  await openPart(page);
  const labels = page.locator('#view .gcv-dimension');
  await expect(labels).toHaveCount(0);
  await page.click('#measure');
  await expect(page.locator('#measure')).toHaveAttribute('aria-pressed', 'true');
  // X from -20 to 120; Z from -5 to 5 (the path starts at the assumed origin, Y 0).
  await expect(labels.filter({ hasText: /^X 140$/ })).toHaveCount(1);
  await expect(labels.filter({ hasText: /^Z 10$/ })).toHaveCount(1);
  await page.click('#measure');
  await expect(labels).toHaveCount(0);
  expect(problems).toEqual([]);
});
