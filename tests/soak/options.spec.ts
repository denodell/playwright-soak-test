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

  test('each pass waits for the response and counts the timeout', async ({ page, soak }) => {
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

    // Captured per run, so the second one can be checked for silence on its own.
    // A pass that finishes inside a millisecond reports nothing even at
    // `progressEveryMs: 1`, so the count of lines is not fixed.
    const reporting: string[] = [];
    const silent: string[] = [];
    let sink = reporting;
    const original = console.log;
    console.log = (...args: unknown[]) => void sink.push(args.join(' '));
    try {
      await soak.measure(() => openAndClose(page));
      sink = silent;
      await soak.measure(() => openAndClose(page), { progressEveryMs: 0 });
    } finally {
      console.log = original;
    }

    const progress = (out: string[]): string[] =>
      out.filter((l) => l.includes('[playwright-soak-test]') && l.includes('passes,'));

    const reported = progress(reporting);
    expect(reported.length).toBeGreaterThan(0);
    // Which passes report depends on how long each one takes, so both the number
    // of lines and the pass the last one lands on are free to vary.
    for (const line of reported) {
      expect(line).toMatch(/: \d+\/12 passes, \d+s, /);
    }
    expect(reported.at(-1)).toMatch(/nodes [+-]\d+, listeners [+-]\d+$/);
    expect(progress(silent)).toHaveLength(0);
  });
});
