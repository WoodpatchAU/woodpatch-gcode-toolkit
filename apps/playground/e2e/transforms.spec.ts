// SPDX-FileCopyrightText: 2026 Promotional Notions Pty Ltd trading as Woodpatch House & Garden
// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// The transform panel (parcel 4e, ADR-0038), in a real browser.

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  return problems;
}

const PART = 'G21 G90\nG0 X0 Y0\nG1 X10 Y5 F300\nM2\n';
const code = (page: Page) => page.locator('.cm-content');
const status = (page: Page) => page.locator('#status');

/** Opens `text` as a file, and the transform panel. */
async function openPart(page: Page, text = PART, name = 'part.nc'): Promise<void> {
  await page.goto('/');
  await expect(status(page)).toContainText('Read in', { timeout: 30_000 });
  await page.setInputFiles('#file', { name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expect(code(page)).toContainText(text.split('\n')[2] as string, { timeout: 30_000 });
  await page.locator('#transform-box > summary').click();
}

async function move(page: Page, x: string): Promise<void> {
  await page.selectOption('#op', 'translate');
  await page.fill('input[name="tx"]', x);
  await page.click('#apply');
}

test('a move is applied, undone and redone, and listed in the recipe', async ({ page }) => {
  const problems = watch(page);
  await openPart(page);
  await move(page, '5');
  await expect(status(page)).toContainText('Move X 5, Y 0, Z 0 mm: 2 lines changed');
  await expect(code(page)).toContainText('G1 X15 Y5 F300');
  await expect(page.locator('#recipe')).toContainText('Move X 5, Y 0, Z 0 mm');

  await page.click('#undo');
  await expect(code(page)).toContainText('G1 X10 Y5 F300');
  await expect(page.locator('#recipe li')).toHaveCount(0);
  await expect(page.locator('#undo')).toBeDisabled();
  await page.click('#redo');
  await expect(code(page)).toContainText('G1 X15 Y5 F300');
  expect(problems).toEqual([]);
});

test('the original is drawn behind the result, and can be hidden', async ({ page }) => {
  const problems = watch(page);
  await openPart(page);
  await page.click('[data-view="plan"]');
  await move(page, '50');
  await expect(code(page)).toContainText('G1 X60 Y5 F300');
  const plan = page.locator('#plan');
  // Let the original load and draw.
  await page.waitForTimeout(1500);
  const withGhost = await plan.screenshot();
  await page.uncheck('#ghost');
  await page.waitForTimeout(500);
  const without = await plan.screenshot();
  expect(withGhost.equals(without)).toBe(false);
  expect(problems).toEqual([]);
});

test('a refused transform changes nothing, and says why, by line', async ({ page }) => {
  const problems = watch(page);
  const text = 'G21 G90\n#1=5\nG1 X#1 Y0 F100\nM2\n';
  await openPart(page, text);
  await page.selectOption('#op', 'rotate');
  await page.fill('input[name="deg"]', '90');
  await page.click('#apply');
  await expect(status(page)).toContainText('refused, nothing changed');
  await expect(page.locator('#transform-notes')).toContainText('TRANSFORM_EXPRESSION');
  await expect(code(page)).toContainText('G1 X#1 Y0 F100');
  await expect(page.locator('#undo')).toBeDisabled();
  expect(problems).toEqual([]);
});

test('an edit by hand starts the history again', async ({ page }) => {
  const problems = watch(page);
  await openPart(page);
  await move(page, '5');
  await expect(page.locator('#undo')).toBeEnabled();
  await code(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('(note)');
  await expect(status(page)).toContainText('Edited by hand');
  await expect(page.locator('#undo')).toBeDisabled();
  await expect(page.locator('#recipe li')).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the recipe and the result are saved, and a recipe applies to another file', async ({
  page,
}) => {
  const problems = watch(page);
  await openPart(page);
  await move(page, '5');
  await expect(code(page)).toContainText('G1 X15 Y5 F300');

  const [recipe] = await Promise.all([page.waitForEvent('download'), page.click('#export-recipe')]);
  expect(recipe.suggestedFilename()).toBe('part.recipe.json');
  const json = readFileSync((await recipe.path()) as string, 'utf8');
  expect(JSON.parse(json)).toEqual({
    format: 'woodpatch-gcode-recipe',
    version: 1,
    dialect: 'generic',
    ops: [{ op: 'translate', x: 5, y: 0, z: 0 }],
  });

  const [saved] = await Promise.all([page.waitForEvent('download'), page.click('#save-gcode')]);
  expect(saved.suggestedFilename()).toBe('part-transformed.nc');
  expect(readFileSync((await saved.path()) as string, 'utf8')).toContain('G1 X15 Y5 F300');

  // Another file, and the saved recipe applied to it.
  await page.setInputFiles('#file', {
    name: 'other.nc',
    mimeType: 'text/plain',
    buffer: Buffer.from('G21 G90\nG1 X1 Y2 F100\nM2\n'),
  });
  await expect(code(page)).toContainText('G1 X1 Y2 F100');
  await expect(page.locator('#recipe li')).toHaveCount(0);
  await page.setInputFiles('#import-recipe', {
    name: 'part.recipe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  });
  await expect(code(page)).toContainText('G1 X6 Y2 F100');
  await expect(status(page)).toContainText('part.recipe.json: 1 steps applied');

  // A recipe with a misspelt field is refused, naming the step.
  await page.setInputFiles('#import-recipe', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      '{"format":"woodpatch-gcode-recipe","version":1,"ops":[{"op":"rotate","degree":90}]}',
    ),
  });
  await expect(page.locator('#transform-notes')).toContainText('Step 1: unknown field degree');
  await expect(code(page)).toContainText('G1 X6 Y2 F100');
  expect(problems).toEqual([]);
});
