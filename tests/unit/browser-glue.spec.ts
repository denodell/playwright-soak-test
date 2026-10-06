import { expect, test } from '@playwright/test';
import { attachCdp, detachCdp, hasExposeGc, readMetrics } from '../../src/cdp.js';
import {
  installSoakClock,
  isSoakClockInstalled,
  pauseSoakClock,
  SOAK_START,
  virtualElapsedMs,
} from '../../src/clock.js';
import { FakeCdp, fakePage } from './fakes.js';

// The thin layer over Playwright and CDP, with the browser swapped for fakes so
// the failures a real browser rarely produces can be made on purpose.

test.describe('the CDP session', () => {
  test('opens once per page and turns on what the readings need', async () => {
    const { page, cdp, sessionsOpened } = fakePage();
    expect(await attachCdp(page)).toBe(cdp);
    expect(await attachCdp(page)).toBe(cdp);
    expect(sessionsOpened()).toBe(1);
    expect(cdp.sent).toEqual(['Performance.enable', 'HeapProfiler.enable']);
  });

  test('detaching a page that never attached, or a session already gone, is fine', async () => {
    const { page: never } = fakePage();
    await expect(detachCdp(never)).resolves.toBeUndefined();

    const cdp = new FakeCdp();
    cdp.detachError = new Error('Target page, context or browser has been closed');
    const { page } = fakePage({ cdp });
    await attachCdp(page);
    await expect(detachCdp(page)).resolves.toBeUndefined();
    // Gone from the cache, so a later run opens a new session.
    await attachCdp(page);
    expect(cdp.sent.filter((m) => m === 'Performance.enable')).toHaveLength(2);
  });

  test('a reading collects as many times as asked and counts a missing metric as zero', async () => {
    const cdp = new FakeCdp().metrics(() => ({ Nodes: 120, JSEventListeners: 4 }));
    const metrics = await readMetrics(cdp.asSession(), { gcPasses: 3 });
    expect(metrics).toEqual({ heap: 0, nodes: 120, listeners: 4, documents: 0 });
    expect(cdp.sent.filter((m) => m === 'HeapProfiler.collectGarbage')).toHaveLength(3);
  });

  test('a layout update that fails does not stop the reading', async () => {
    const cdp = new FakeCdp().metrics(() => ({ Nodes: 7 }));
    cdp.handlers['Runtime.evaluate'] = () => {
      throw new Error('Execution context was destroyed');
    };
    expect((await readMetrics(cdp.asSession(), { gcPasses: 0 })).nodes).toBe(7);
  });

  test('a page that cannot be asked about gc counts as not having it', async () => {
    const yes = fakePage({ evaluate: async () => true });
    const no = fakePage({ evaluate: async () => false });
    const gone = fakePage({ evaluate: async () => Promise.reject(new Error('page closed')) });
    expect(await hasExposeGc(yes.page)).toBe(true);
    expect(await hasExposeGc(no.page)).toBe(false);
    expect(await hasExposeGc(gone.page)).toBe(false);
  });
});

test.describe('the virtual clock', () => {
  test('installs and pauses once per page, however often it is asked', async () => {
    const { page, clockCalls } = fakePage();
    expect(isSoakClockInstalled(page)).toBe(false);
    await installSoakClock(page);
    await installSoakClock(page);
    await pauseSoakClock(page);
    await pauseSoakClock(page);
    expect(isSoakClockInstalled(page)).toBe(true);
    expect(clockCalls).toEqual(['install', 'pauseAt']);
  });

  test('reads elapsed time from the page, and nothing from a page it cannot reach', async () => {
    const { page } = fakePage({ evaluate: async () => SOAK_START.getTime() + 36_000 });
    expect(await virtualElapsedMs(page)).toBe(36_000);

    const { page: gone } = fakePage({ evaluate: async () => Promise.reject(new Error('page closed')) });
    expect(await virtualElapsedMs(gone)).toBeNull();
  });
});
