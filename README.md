# playwright-soak-test

[![ci](https://github.com/denodell/playwright-soak-test/actions/workflows/ci.yml/badge.svg)](https://github.com/denodell/playwright-soak-test/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/denodell/playwright-soak-test)](https://github.com/denodell/playwright-soak-test/blob/main/LICENSE)

Soak test your single-page web app (SPA) for memory leaks at high speed, using Playwright.

A SPA is long-running, so any memory it leaks builds up gradually as long as the browser tab stays open. Usually this is caused by DOM nodes that get removed from the page but which stay in memory because a listener or timer still has a reference to it. These add up over a long session and result in a poor user experience, and potentially a browser tab crash.

`playwright-soak-test` repeats your provided user flows a few hundred times in a single browser session, watching the DOM node and listener counts as it goes. If they keep climbing, the test fails. It needs you to provide a flow that ends up where it started, where the DOM and listener counts would be expected to be the same at the end as at the start, like opening a drawer and closing it again, or filtering a table and then clearing the filter. Any flow that deliberately ends up with more DOM nodes than it started with, like an infinite scroll feed, won't be ideal for this (though we provided a measurement function you can use if you're curious as to your DOM node and listener count anyway).

> Based on my blog post [Your SPA Is Leaking Memory. Soak Test It](https://denodell.com/blog/your-spa-is-leaking-memory-soak-test-it?utm_source=github&utm_medium=playwright-soak-test&utm_campaign=readme), which goes into detail behind the method and the default values used here.

## Installation

```sh
npm install --save-dev playwright-soak-test
```

`@playwright/test` is a peer dependency, so it uses the version of Playwright you already use, but it must be at least v1.45.

The counts come from the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), which is Chromium only, so the fixture skips running itself on Firefox and WebKit.

## Usage

Use the provided `test`, which includes the soak test fixture, as you would normally. If you've already got a spec that clicks through the flow you want to test, you only need to change the import and wrap it in `soak.run()`:

```ts
import { test } from 'playwright-soak-test';

test('the dashboard drawer does not leak memory', async ({ page, soak }) => {
  await page.goto('/dashboard');

  await soak.run(async () => {
    await page.getByRole('button', { name: 'Report' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
  });
});
```

The flow runs 200 times by default. It takes a baseline reading after 5 warmup passes, and if a count has grown past a given threshold by the end, `soak.run()` throws and the test fails.

`soak.measure()` takes the same arguments and just returns the result instead of throwing, for those who just want to understand their DOM node and listener count:

```ts
const result = await soak.measure(openAndCloseDrawer);
console.log(result.trends.nodes.perPass);
```

## Configuration

The reporter and `soakLaunchOptions`, which sets a Chromium launch flag, both go in `playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { soakLaunchOptions } from 'playwright-soak-test';

export default defineConfig({
  reporter: [
    ['list'],
    ['playwright-soak-test/reporter'],
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /.*\.soak\.spec\.ts/,
    },
    {
      name: 'soak',
      testMatch: /.*\.soak\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: soakLaunchOptions,
        // Both the following keep big buffers in the renderer, which can affect results
        trace: 'off',
        video: 'off',
      },
    },
  ],
});
```

Name your soak specs `*.soak.spec.ts`, and use `testIgnore` on your existing projects to keep them out. A 200-pass run isn't meant to go alongside your normal tests.

`list` is Playwright's usual terminal output. Setting `reporter` replaces the defaults rather than adding to them, so dropping it leaves you with the soak boxes alone.

Then run the soak project on its own:

```sh
npx playwright test --project=soak
```

## Options

Every reading takes three values from Chromium: the DOM node count, the event listener count, and the size of the JS heap. Garbage collection is forced first, so memory the browser was about to free doesn't get counted. Nodes and listeners are asserted on; heap is recorded and printed only.

Defaults go in `use: { soakOptions }` in the config, or at the top of a spec with `test.use`. You can also pass any of them per run, as the second argument to `soak.run` and `soak.measure`.

| Option | Default | What it does |
| --- | --- | --- |
| `passes` | `200` | Passes in total, warmup included. |
| `warmup` | `5` | Passes before the baseline, so first-open code and data land in the heap first. |
| `nodeThreshold` | `100` | How much the node count can grow across the run. Raise it for components that legitimately keep DOM around; a failing run prints the number to raise it to. |
| `listenerThreshold` | `0` | How much the listener count can grow. Best left alone, because a listener still registered after a round trip is most likely a bug. |
| `heapThresholdPercent` | `null` | Heap growth allowed, as a percentage. `null` reports heap and leaves it out of the assertions. Set it to catch a leak that stays out of the DOM entirely, as described under [Limitations](#limitations). |
| `clock` | `{ advanceMs: 18_000 }` | Virtual milliseconds per pass. `false` turns the clock off. |
| `waitForResponse` | unset | A URL glob awaited around each clock advance. |
| `waitForResponseTimeout` | `5000` | How long to wait before counting a response as missing and carrying on. |
| `gcPasses` | `2` | Collections forced before each reading. |
| `progressEveryMs` | `30000` | How often a long run says where it has got to. `0` for silence. |
| `tracePasses` | `25` | Passes read one at a time at the start of the run. |
| `sampleEvery` | derived | Read every Nth pass after that. |
| `label` | test title | Name used in the report and the reporter. |

## Virtual clock

The fixture installs Playwright's virtual clock before your app loads and pauses it once the app is up. From then on time only moves when a pass moves it, and `advanceMs` sets how far, so match it to the interval your app uses.

For a `setTimeout()` that calls `/api/feed` every 30 seconds, advance the clock by 30 seconds a pass to skip the wait. Fulfil the request yourself with realistic-sized fixture data, so a pass isn't waiting on the network either:

```ts
test.use({
  soakOptions: {
    clock: {
      advanceMs: 30_000
    }
  }
});

test('the dashboard drawer does not leak', async ({ page, soak }) => {
  await page.route('**/api/feed', route => route.fulfill({ json: feed }));
  await page.goto('/dashboard');

  await soak.run(openAndCloseDrawer, {
    waitForResponse: '**/api/feed'
  });
});
```

`waitForResponse` is registered before the flow runs and awaited after the clock advances, so a response triggered by the advance is still caught. A wait that times out after `waitForResponseTimeout` ms adds one to `responseTimeouts` on the result, and the pass carries on.

`page.routeWebSocket()` does the same job for sockets, on Playwright 1.48+. Streamed responses can't be faked this way, because `route.fulfill()` only takes a string or a buffer.

To turn the clock off:

```ts
test.use({ soakOptions: { clock: false } });
```

## Reports

A run reads the counts on each of the first 25 passes, then every Nth pass after that, and fits a line through them. The slope of that line is the per-pass figure in the report.

```
Memory leak detected in "the dashboard drawer does not leak".

Listeners     +195  (threshold 0)    ▁▁▁▁▁▁▁▂▂▂▂▂▂▂▃▃▄▅▅▆▆▇██  +1.0 per pass, R²=1.00

DOM nodes   +7,800  (threshold 100)  ▁▁▁▁▁▁▁▂▂▂▂▂▂▂▃▃▄▅▅▆▆▇██  +40.0 per pass, R²=1.00

Heap       +10.37%  (reported only)  ▁▁▁▂▂▂▂▂▂▂▂▃▃▃▃▄▅▅▆▆▇▇██  1.03 MB → 1.13 MB

Every pass leaks 40.0 nodes and 1.0 listeners, starting from the first one.
Most often a listener stays registered after the flow ends, and its callback still points
at the elements it was created for, so they stay in memory too.
All of this assumes your flow ends on the screen it started on. A flow that adds to the
page on purpose will grow whatever you do.

Find it: DevTools → Memory → take a heap snapshot, then filter the class list for
"Detached". Clicking a node shows its retainers, so you can see what still references it.

200 passes x 18s of virtual time = 1h of app time.
```

The graphs are the readings taken across the run, scaled to each row's own range. Small variations are shows as flat lines.

Growth that stopped is reported as `OVER THRESHOLD` rather than `LEAK DETECTED`. A single jump is labeled `all at once, at pass 10`, a climb that levels off early is labeled `climbed early, then levelled off`, and the message also suggests the number to raise the threshold to.

The reporter prints a box per test and a table at the end of the run. On GitHub Actions it also writes an error annotation and a job summary. Failing rows are red where growth continues and amber where it stopped, with the same distinction in the wording. `NO_COLOR` turns color off and `FORCE_COLOR` turns it on.

## API

| Export | Description |
| --- | --- |
| `test` | Playwright's `test` with the `soak` fixture already on it. The usual entry point. |
| `expect` | Playwright's `expect`, re-exported so both come from the same import. |
| `soak.run(flow, options?)` | Repeats the flow and throws `SoakLeakError` if a count grew past its threshold. |
| `soak.measure(flow, options?)` | The same run, returning the `SoakResult` whether or not anything grew. |
| `soakFixtures` | The fixture on its own, for a `test` you have already extended: `base.extend(myFixtures).extend(soakFixtures)`. |
| `runSoak(page, flow, options?)` | `soak.run` without the fixture, for when `soak` is out of scope: Playwright driven as a library, or a run started from inside a page object. Pass `testInfo` in the options to get the numbers to the reporter. |
| `measureSoak(page, flow, options?)` | `soak.measure` without the fixture. |
| `installSoakClock(page)` | Installs the virtual clock, which has to happen before the app loads. The fixture does this for you, so it is only needed alongside `runSoak` and `measureSoak`. |
| `soakLaunchOptions` | `launchOptions` carrying `--js-flags=--expose-gc`. |
| `SoakLeakError` | Thrown by `soak.run` and `runSoak`. Its `result` property holds the full `SoakResult`. |

Every call returns a `SoakResult`, and `SoakLeakError` contains the same object on its `result` property. From the leaking drawer above:

```js
{
  label: 'the dashboard drawer does not leak',
  passes: 200,
  warmup: 5,
  baseline: {
    heap: 1079204,
    nodes: 258,
    listeners: 22,
    documents: 1,
  },
  after: {
    heap: 1190724,
    nodes: 8058,
    listeners: 217,
    documents: 1,
  },
  samples: [
    {
      pass: 0,
      heap: 1079204,
      nodes: 258,
      listeners: 22,
      documents: 1,
    },
    ...
    {
      pass: 195,
      heap: 1190724,
      nodes: 8058,
      listeners: 217,
      documents: 1,
    },
  ],
  trends: {
    nodes: {
      perPass: 40,
      total: 7800,
      shape: 'linear',
      r2: 1,
    },
    listeners: {
      perPass: 1,
      total: 195,
      shape: 'linear',
      r2: 1,
    },
    heap: {
      perPass: 544.57,
      total: 111520,
      shape: 'linear',
      r2: 0.99,
    },
  },
  failures: [
    {
      metric: 'listeners',
      growth: 195,
      threshold: 0,
      trend: {
        perPass: 1,
        total: 195,
        shape: 'linear',
        r2: 1,
      },
    },
    {
      metric: 'nodes',
      growth: 7800,
      threshold: 100,
      trend: {
        perPass: 40,
        total: 7800,
        shape: 'linear',
        r2: 1,
      },
    },
  ],
  leaking: true,
  thresholds: {
    nodes: 100,
    listeners: 0,
    heap: null,
  },
  clock: {
    enabled: true,
    advanceMs: 18000,
    virtualElapsedMs: 3610000,
  },
  exposeGc: true,
  responseTimeouts: 0,
}
```

`perPass` is the slope of the fitted line and `total` is the last reading minus the baseline. `r2` is how well that line fits, and `shape` is derived from it: `flat`, `linear`, `step`, `settled` or `noisy`. A `step` trend also contains `stepAtPass`, the pass the jump landed on.

The types are exported too: `Soak`, `SoakAction`, `SoakOptions`, `SoakRunOptions`, `SoakClockOptions`, `SoakResult`, `SoakSample`, `SoakTrend`, `SoakMetrics`, `SoakFailure`, `SoakFixtures` and `SoakTestOptions`.

## Long runs

200 passes finishes in seconds. Longer runs need Playwright's own test timeout raised, since it defaults to 30 seconds:

```ts
test.setTimeout(2 * 60 * 60 * 1000);
test.use({ soakOptions: { passes: 10_000 } });
```

A run prints its progress every `progressEveryMs`, which defaults to 30 seconds:

```
[playwright-soak-test] the dashboard drawer does not leak: 4,000/10,000 passes, 12m, nodes +0, listeners +1
```

## Limitations

- Readings vary between runs, so this belongs in a nightly job rather than on every pull request. With `workers: 1` and `retries: 0`, each run gets a browser to itself.
- Clicking an element that your flow then removes adds two retained nodes a pass in Chromium. They only turn up on a subtree the app is already keeping, so a clean build still reads exactly 0.
- A `::before` or `::after` with `content` puts a `PseudoElement` and its text into the node count, so a component can read two nodes higher than the elements you actually wrote.
- The counts miss anything that stays out of the DOM. A poller that keeps every response in an array grows the heap by 300% with the counts dead flat, and the run passes. Use `heapThresholdPercent` to catch that case.

## Examples

```sh
npm install
npm test
```

## Changelog

Every release is written up in [CHANGELOG.md](CHANGELOG.md).

## Contributing

PRs welcome.

Bugs, questions and results from your own app are all welcome in [issues](https://github.com/denodell/playwright-soak-test/issues). Please provide as much data as you can, preferably a working minimal reproducable repo for any problems.

## License

MIT
