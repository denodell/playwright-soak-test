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
import { markTestStart, measureSoak, mergeSoakOptions, runSoak } from './soak.js';
import type { Soak, SoakOptions } from './types.js';

export interface SoakFixtures {
  soak: Soak;
}

export interface SoakTestOptions {
  soakOptions: SoakOptions;
}

interface SoakTiming {
  _soakTestStart: void;
}

type SoakFixturesFor<T extends object> = Fixtures<
  T,
  {},
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
>;

const fixtures: SoakFixturesFor<SoakFixtures & SoakTestOptions & SoakTiming> = {
  soakOptions: [{}, { option: true }],

  // Automatic, so it's set up ahead of any beforeEach hook, which the test's timeout also covers.
  _soakTestStart: [
    async ({}, use, testInfo) => {
      markTestStart(testInfo);
      await use();
    },
    { auto: true },
  ],

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

// `_soakTestStart` is internal, so it's left out of the type your editor sees.
export const soakFixtures = fixtures as unknown as SoakFixturesFor<SoakFixtures & SoakTestOptions>;

// Drop-in replacement for `@playwright/test`, with a `soak` fixture added.
export const test = base.extend<SoakFixtures & SoakTestOptions>(soakFixtures);

export { expect };
