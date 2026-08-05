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
  expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(2);
  // Listeners are exact here, so this is the count whose shape is worth
  // asserting on. A single node of jitter is enough to make the node count
  // read as a step rather than flat.
  expect(result.trends.listeners.total).toBe(0);
  expect(result.trends.listeners.shape).toBe('flat');
});

test('the leak build fails with 40 nodes and a listener a pass', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const error = await soak.run(() => openAndClose(page)).then(
    () => null,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;

  // Listeners are exact: one per open, and the count only moves when the app
  // adds or removes one. Nodes land a node either side of 40 a pass, depending
  // on what the collection before the final reading got to.
  expect(result.trends.listeners.total).toBe(MEASURED);
  expect(result.trends.listeners.perPass).toBeCloseTo(1, 6);
  expect(Math.abs(result.trends.nodes.total - MEASURED * 40)).toBeLessThanOrEqual(2);
  expect(result.trends.nodes.perPass).toBeCloseTo(40, 1);
  expect(result.trends.nodes.shape).toBe('linear');
  expect(result.trends.listeners.shape).toBe('linear');

  expect(message).toContain('Memory leak detected');
  expect(message).toContain('Listeners');
  expect(message).toContain('Detached');
});

test('listeners flag the leak while the heap is only reported', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.measure(() => openAndClose(page), { nodeThreshold: 1_000_000 });
  const heapGrowthPercent = ((result.after.heap - result.baseline.heap) / result.baseline.heap) * 100;

  expect(result.thresholds.heap).toBeNull();
  expect(result.failures.map((f) => f.metric)).toEqual(['listeners']);
  expect(heapGrowthPercent).toBeLessThan(100);
});
