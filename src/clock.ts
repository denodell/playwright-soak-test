import type { Page } from '@playwright/test';

export const SOAK_START = new Date();

export const PAUSE_AFTER_MS = 10_000;

const installedPages = new WeakSet<Page>();
const pausedPages = new WeakSet<Page>();

export async function installSoakClock(page: Page): Promise<void> {
  if (installedPages.has(page)) return;

  await page.clock.install({ time: SOAK_START });

  installedPages.add(page);
}

export function isSoakClockInstalled(page: Page): boolean {
  return installedPages.has(page);
}

export async function pauseSoakClock(page: Page): Promise<void> {
  if (pausedPages.has(page)) return;

  await page.clock.pauseAt(new Date(SOAK_START.getTime() + PAUSE_AFTER_MS));

  pausedPages.add(page);
}

export async function advanceSoakClock(page: Page, ms: number): Promise<void> {
  await page.clock.runFor(ms);
}

export async function virtualElapsedMs(page: Page): Promise<number | null> {
  try {
    const now = await page.evaluate(() => Date.now());
    return now - SOAK_START.getTime();
  } catch {
    return null;
  }
}
