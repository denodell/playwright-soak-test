import type { Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';
import { SoakLeakError } from '../../src/soak.js';

const PASSES = 30;
const MEASURED = PASSES - 5;

test.use({ soakOptions: { passes: PASSES, clock: false } });

function openAndClose(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__shortcuts.open();
    window.__shortcuts.close();
  });
}

test('the leak build fails on the listener count while the node count stays flat', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__shortcuts !== undefined);

  const error = await soak.run(() => openAndClose(page)).then(
    () => null,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;

  expect(result.trends.listeners.total).toBe(MEASURED);
  expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(2);
  expect(result.failures.map((f) => f.metric)).toEqual(['listeners']);

  expect(message).toContain('goes up when your code adds a listener');
  expect(message).toContain('adding a listener each pass and it stays registered');
});

test('the fixed build removes the listener and stays flat', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__shortcuts !== undefined);

  const result = await soak.measure(() => openAndClose(page));

  expect(result.leaking).toBe(false);
  expect(result.trends.listeners.total).toBe(0);
  expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(2);
});
