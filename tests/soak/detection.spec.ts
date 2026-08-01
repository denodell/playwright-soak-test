import type { Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';
import { SoakLeakError } from '../../src/soak.js';

test.use({ soakOptions: { clock: false } });

const MEASURED = 200 - 5;

function openAndClose(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__drawer.open();
    window.__drawer.close();
  });
}

test('the fixed build ends with the same counts it started with', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.run(() => openAndClose(page));

  expect(result.leaking).toBe(false);
  expect(result.trends.nodes.total).toBe(0);
  expect(result.trends.listeners.total).toBe(0);
  expect(result.trends.nodes.shape).toBe('flat');
});

test('the leak build fails the run and reports 40 nodes and a listener a pass', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const error = await soak.run(() => openAndClose(page)).then(
    () => null,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;

  expect(result.trends.nodes.total).toBe(MEASURED * 40);
  expect(result.trends.listeners.total).toBe(MEASURED);
  expect(result.trends.nodes.perPass).toBeCloseTo(40, 6);
  expect(result.trends.listeners.perPass).toBeCloseTo(1, 6);
  expect(result.trends.nodes.shape).toBe('linear');
  expect(result.trends.listeners.shape).toBe('linear');

  expect(message).toContain('Memory leak detected');
  expect(message).toContain('Listeners');
  expect(message).toContain('Detached');
});

test('listeners flag the leak while the heap is only reported', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.measure(() => openAndClose(page), { nodeAllowance: 1_000_000 });
  const heapGrowthPercent = ((result.after.heap - result.baseline.heap) / result.baseline.heap) * 100;

  expect(result.allowances.heap).toBeNull();
  expect(result.failures.map((f) => f.metric)).toEqual(['listeners']);
  expect(heapGrowthPercent).toBeLessThan(100);
});
