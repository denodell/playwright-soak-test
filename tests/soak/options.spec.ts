import { expect, test } from '../../src/index.js';
import { PAUSE_AFTER_MS } from '../../src/clock.js';

function openAndClose(page: import('@playwright/test').Page): Promise<void> {
  return page.evaluate(() => {
    window.__drawer.open();
    window.__drawer.close();
  });
}

test.describe('a run with the clock turned off', () => {
  test.use({ soakOptions: { passes: 8, warmup: 2 } });

  test('the clock stays pinned at the pause point', async ({ page, soak }) => {
    await page.goto('/fixed/');
    await page.waitForFunction(() => window.__drawer !== undefined);

    const result = await soak.measure(() => openAndClose(page), { clock: false });

    expect(result.clock.enabled).toBe(false);
    expect(result.clock.virtualElapsedMs).toBe(PAUSE_AFTER_MS);
  });
});

test.describe('waitForResponse with the clock off', () => {
  test.use({
    soakOptions: { clock: false, passes: 6, warmup: 2, waitForResponseTimeout: 150 },
  });

  test('every pass waits, and every timeout is counted', async ({ page, soak }) => {
    await page.goto('/fixed/');
    await page.waitForFunction(() => window.__drawer !== undefined);

    const result = await soak.measure(() => openAndClose(page), {
      waitForResponse: '**/a-request-this-app-never-makes',
    });

    expect(result.responseTimeouts).toBe(6);
  });
});

test.describe('progress on a long run', () => {
  test.use({ soakOptions: { clock: false, passes: 12, warmup: 3, progressEveryMs: 1 } });

  test('progress lines report the pass count, and 0 turns them off', async ({ page, soak }) => {
    await page.goto('/fixed/');
    await page.waitForFunction(() => window.__drawer !== undefined);

    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    try {
      await soak.measure(() => openAndClose(page));
      await soak.measure(() => openAndClose(page), { progressEveryMs: 0 });
    } finally {
      console.log = original;
    }

    const reported = lines.filter((l) => l.includes('[playwright-soak-test]') && l.includes('passes,'));
    expect(reported.length).toBeGreaterThan(0);
    expect(reported[0]).toContain('warming up');
    expect(reported.at(-1)).toContain('12/12 passes');
    expect(reported.at(-1)).toContain('nodes +0');
    expect(reported.filter((l) => l.includes(': 1/12 passes')).length).toBe(1);
    expect(reported.filter((l) => l.includes(': 12/12 passes')).length).toBe(1);
  });
});
