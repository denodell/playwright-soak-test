import type { Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';

const PASSES = 40;
const MEASURED = PASSES - 5;

const TICKS_WHEN_COMPRESSED = (PASSES * (PASSES + 1)) / 2;

function openAndClose(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__ticker.open();
    window.__ticker.close();
  });
}

const ticksSoFar = (page: Page): Promise<number> => page.evaluate(() => window.__tickCount);

test.describe('with real time', () => {
  test.use({ soakOptions: { passes: PASSES, clock: false } });

  test('the timer stays pending, so only the tile roots pile up', async ({ page, soak }) => {
    await page.goto('/leak/');
    await page.waitForFunction(() => window.__ticker !== undefined);

    const result = await soak.measure(() => openAndClose(page));

    expect(await ticksSoFar(page)).toBe(0);
    expect(result.trends.nodes.total).toBe(MEASURED);
    expect(result.leaking).toBe(false);
  });
});

test.describe('with time compressed', () => {
  test.use({ soakOptions: { passes: PASSES, clock: { advanceMs: 30_000 } } });

  test('compressing time fires every leaked timer and the run fails on nodes', async ({ page, soak }) => {
    await page.goto('/leak/');
    await page.waitForFunction(() => window.__ticker !== undefined);

    const result = await soak.measure(() => openAndClose(page));

    expect(await ticksSoFar(page)).toBe(TICKS_WHEN_COMPRESSED);
    expect(result.leaking).toBe(true);
    expect(result.failures.map((f) => f.metric)).toEqual(['nodes']);
    expect(result.trends.nodes.total).toBeGreaterThan(2_000);
    expect(result.trends.nodes.shape).toBe('linear');
  });

  test('the fixed build clears every timer and ends where it started', async ({ page, soak }) => {
    await page.goto('/fixed/');
    await page.waitForFunction(() => window.__ticker !== undefined);

    const result = await soak.measure(() => openAndClose(page));

    expect(await ticksSoFar(page)).toBe(0);
    expect(result.leaking).toBe(false);
    expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(1);
  });
});
