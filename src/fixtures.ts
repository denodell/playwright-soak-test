import {
  test as base,
  expect,
  type Fixtures,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
} from '@playwright/test';
import { detachCdp } from './cdp.js';
import { installSoakClock } from './clock.js';
import { measureSoak, mergeSoakOptions, runSoak } from './soak.js';
import type { Soak, SoakOptions } from './types.js';

export interface SoakFixtures {
  soak: Soak;
}

export interface SoakTestOptions {
  soakOptions: SoakOptions;
}

export const soakFixtures: Fixtures<
  SoakFixtures & SoakTestOptions,
  {},
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = {
  soakOptions: [{}, { option: true }],

  soak: async ({ page, soakOptions, browserName }, use, testInfo) => {
    testInfo.skip(
      browserName !== 'chromium',
      'Soak tests read memory over the Chrome DevTools Protocol, which Playwright only opens on Chromium.',
    );

    if (soakOptions.clock !== false) await installSoakClock(page);

    await use({
      run: (action, options) =>
        runSoak(page, action, { ...mergeSoakOptions(soakOptions, options), testInfo }),
      measure: (action, options) =>
        measureSoak(page, action, { ...mergeSoakOptions(soakOptions, options), testInfo }),
    });

    await detachCdp(page);
  },
};

// Drop-in replacement for `@playwright/test`, with a `soak` fixture added.
export const test = base.extend<SoakFixtures & SoakTestOptions>(soakFixtures);

export { expect };
