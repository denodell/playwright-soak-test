import type { CDPSession, Page } from '@playwright/test';
import type { SoakMetrics } from './types.js';

const sessions = new WeakMap<Page, CDPSession>();

export async function attachCdp(page: Page): Promise<CDPSession> {
  const existing = sessions.get(page);
  if (existing) return existing;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  sessions.set(page, cdp);

  return cdp;
}

export async function detachCdp(page: Page): Promise<void> {
  const cdp = sessions.get(page);
  if (!cdp) return;

  sessions.delete(page);

  try {
    await cdp.detach();
  } catch { }
}

export async function readMetrics(
  cdp: CDPSession,
  options: { gcPasses: number },
): Promise<SoakMetrics> {
  // I found React apps need this garbage collection to happen twice
  for (let i = 0; i < options.gcPasses; i++) {
    await cdp.send('HeapProfiler.collectGarbage');
  }

  const { metrics } = await cdp.send('Performance.getMetrics');
  const read = (name: string): number => metrics.find((m) => m.name === name)?.value ?? 0;

  return {
    heap: read('JSHeapUsedSize'),
    nodes: read('Nodes'),
    listeners: read('JSEventListeners'),
    documents: read('Documents'),
  };
}

export async function hasExposeGc(page: Page): Promise<boolean> {
  try {
    // Tells us if Chromium launched with `--js-flags=--expose-gc`
    return await page.evaluate(() => typeof (globalThis as { gc?: unknown }).gc === 'function');
  } catch {
    return false;
  }
}
