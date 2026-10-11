# playwright-soak-test

[![ci](https://github.com/denodell/playwright-soak-test/actions/workflows/ci.yml/badge.svg)](https://github.com/denodell/playwright-soak-test/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/denodell/playwright-soak-test)](https://github.com/denodell/playwright-soak-test/blob/main/LICENSE)

Find memory leaks in your single-page web app in minutes rather than hours.

It repeats a user flow a few hundred times in Playwright and counts the DOM nodes and event listeners on the page as it goes. The flow has to end where it started, like opening a drawer and closing it again, or filtering a table and clearing the filter, so those counts should be the same after every pass. If they keep going up, something is leaking, and the test fails.

Most leaks only cause trouble after hours of use. This finds them in minutes. Between passes, a virtual clock skips ahead, so your app's timers and polling still run, but the test doesn't wait for them. With `page.route` answering your app's requests from fixture data, the test doesn't wait on a server either. The default 200 passes cover an hour of your app's time.

When it finds a leak, it tells you what's keeping the leaked elements in memory, like a listener on `window` that was never removed.

The [blog post](https://denodell.com/blog/your-spa-is-leaking-memory-soak-test-it?utm_source=github&utm_medium=playwright-soak-test&utm_campaign=readme) explains how it works and where the defaults come from.

## Install

```sh
npm install --save-dev playwright-soak-test
```

You'll need `@playwright/test` 1.45 or newer. The counts come from the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), so it only runs on Chromium. Soak tests are skipped on Firefox and WebKit.

## Quick start

Import `test` from `playwright-soak-test` instead of `@playwright/test`. It's Playwright's `test` with a `soak` fixture added. Then wrap the flow you want to check in `soak.run()`:

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

The flow runs 200 times. After 5 warmup passes it takes a baseline reading, and if the node or listener count has grown past its threshold by the end, the test fails.

If you only want the numbers, `soak.measure()` takes the same arguments and returns the result without failing the test. It's also the one to use for a flow that adds to the page on purpose, like an infinite scroll feed, because its counts will always go up.

```ts
const result = await soak.measure(openAndCloseDrawer);
console.log(result.trends.nodes.perPass);
```

## Set up a soak project

Soak tests take longer than your normal tests, so give them a project of their own in `playwright.config.ts`:

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
        // Tracing and video keep big buffers in the renderer, which throws off the counts
        trace: 'off',
        video: 'off',
      },
    },
  ],
});
```

Name your soak specs `*.soak.spec.ts` so the two projects don't pick up each other's tests. `soakLaunchOptions` turns on the Chromium flag that lets a test force garbage collection. Keep `list` in the reporters, because setting `reporter` replaces Playwright's defaults rather than adding to them.

Then run the soak project on its own:

```sh
npx playwright test --project=soak
```

## Reports

When a run fails, the reporter prints something like this:

```
Memory leak detected in "the dashboard drawer does not leak".

  Listeners     +195  (threshold 0)    ▁▁▁▁▁▁▁▂▂▂▂▂▂▂▃▃▄▅▅▆▆▇██  +1.0 per pass, R²=1.00

  DOM nodes   +7,801  (threshold 100)  ▁▁▁▁▁▁▁▂▂▂▂▂▂▂▃▃▄▅▅▆▆▇██  +40.0 per pass, R²=1.00

  Heap       +10.88%  (reported only)  ▁▁▂▂▂▂▃▃▃▃▃▃▃▅▄▄▅▅▆▆▇▇██  1.09 MB → 1.21 MB

  Every pass leaks 40.0 nodes and 1.0 listeners.
  This all assumes your flow ends where it started. If it adds to the page on purpose, it
  will grow no matter what.

  A listener on window is still registered. Its callback `onResize` still references the
  <section class="report-drawer"> element.

    window → EventListener → onResize() → <section class="report-drawer">

  Find it: DevTools → Memory → take a heap snapshot, then filter the class list for
  "Detached". Clicking a node shows its retainers, so you can see what still references it.

  200 passes x 18s of virtual time = 1h of app time.
```

Each graph shows the readings taken across the run. The per-pass number is the slope of a line fitted through them, and R² is how well that line fits.

The part under the graphs comes from comparing two heap snapshots, one taken at the baseline and one at the end. Here, `onResize` is the function to look at. `window` keeps the listener, the listener calls `onResize`, and `onResize` still references a section that's no longer on the page. [How the diagnosis works](docs/diagnosis.md) has more examples, and explains what to do when the chain names a function you don't expect.

If the counts went up and then stopped, like a single jump or an early climb that leveled off, the report says `OVER THRESHOLD` instead of `LEAK DETECTED`, and suggests what to raise the threshold to.

The reporter also prints a summary table at the end of the run. On GitHub Actions it adds an error annotation and a job summary too. `NO_COLOR` turns color off and `FORCE_COLOR` turns it on.

## Clock and network

By default the clock moves 18 seconds between passes. Set `advanceMs` to match how often your app polls. For a feed that calls `/api/feed` every 30 seconds, move the clock 30 seconds a pass, and answer the request from fixture data so the test never waits on the network:

```ts
test.use({ soakOptions: { clock: { advanceMs: 30_000 } } });

test('the dashboard drawer does not leak', async ({ page, soak }) => {
  await page.route('**/api/feed', route => route.fulfill({ json: feed }));
  await page.goto('/dashboard');

  await soak.run(openAndCloseDrawer, { waitForResponse: '**/api/feed' });
});
```

`waitForResponse` makes each pass wait for the request the clock sets off, so the next pass doesn't start before the response arrives. If it doesn't arrive within `waitForResponseTimeout`, the pass moves on and `result.responseTimeouts` goes up by one.

Make the fixture data the same size as a real response. A one-item stub can come back clean when the real response leaks.

`page.routeWebSocket()` does the same for WebSockets, on Playwright 1.48 and later. Streamed responses can't be faked this way, because `route.fulfill()` only takes a string or a buffer.

The clock is also paused while your flow runs. If the flow waits on a timer, like a tooltip that opens after a 500ms hover, move the clock yourself with `page.clock.runFor()`:

```ts
await soak.run(async () => {
  await button.hover();
  await page.clock.runFor(500);
  await expect(page.getByRole('tooltip')).toBeVisible();

  await page.mouse.move(0, 0);
  await page.clock.runFor(500);
  await expect(page.getByRole('tooltip')).toBeHidden();
});
```

To turn the clock off:

```ts
test.use({ soakOptions: { clock: false } });
```

## Options

Set defaults with `use: { soakOptions }` in your config, or with `test.use` in a spec. You can also pass any of them as the second argument to `soak.run()` or `soak.measure()`.

| Option | Default | What it does |
| --- | --- | --- |
| `passes` | `200` | Total passes, including warmup. |
| `warmup` | `5` | Passes to run before the baseline reading, so code and data loaded the first time are already in memory. |
| `nodeThreshold` | `100` | How much the DOM node count can grow. Raise it for components that keep nodes around on purpose. |
| `listenerThreshold` | `0` | How much the listener count can grow. A listener left behind after a round trip is almost always a bug, so leave this at `0`. |
| `heapThresholdPercent` | `null` | How much the JS heap can grow, as a percentage. `null` reports the heap but doesn't fail on it. |
| `clock` | `{ advanceMs: 18_000 }` | How far the virtual clock moves each pass, in ms. `false` turns it off. |
| `waitForResponse` | unset | URL glob to wait for after each clock move. |
| `waitForResponseTimeout` | `5000` | How long to wait for that response, in ms. |
| `gcPasses` | `2` | Garbage collections forced before each reading. |
| `progressEveryMs` | `30000` | How often a long run prints its progress. `0` turns it off. |
| `tracePasses` | `25` | Number of passes at the start that all get a reading. |
| `sampleEvery` | derived | After that, read every Nth pass. |
| `label` | test title | Name shown in the report. |
| `diagnose` | `'on-failure'` | When to take heap snapshots and name what leaked: `'on-failure'`, `'always'` or `'off'`. |
| `keepSnapshots` | `false` | Attach both heap snapshots to the test result, so you can open them in DevTools. |
| `diagnoseTimeout` | `60000` | How long the snapshot work can take, in ms, before it's skipped. |

With `diagnose` on, every run takes a snapshot at the baseline, because it can't know yet whether the run will fail. On a real app that adds a few seconds to each run. Set `diagnose: 'off'` if you don't need it.

## Long runs

Playwright's default test timeout is 30 seconds. If your runs take longer, raise it:

```ts
test.setTimeout(2 * 60 * 60 * 1000);
test.use({ soakOptions: { passes: 10_000 } });
```

Long runs print their progress every 30 seconds:

```
[playwright-soak-test] the dashboard drawer does not leak: 4,000/10,000 passes, 12m, nodes +0, listeners +1
```

## Limitations

- The counts vary a little from run to run, so run soak tests nightly rather than on every pull request. `workers: 1` and `retries: 0` give each run a browser to itself.
- Only the DOM node and listener counts fail a run by default. A leak that never touches the DOM, like a poller that keeps every response in an array, needs `heapThresholdPercent`.
- Typing into a `contenteditable` element or a rich text editor adds to Chrome's undo history, which keeps deleted text so Ctrl+Z can bring it back. The counts go up a little every pass until the history is full at 1,000 steps.
- Logging an event or an element with `console.log` keeps it in memory while Playwright is connected, because Chrome builds a preview of anything logged. Log a string, like `event.type`, instead.

[How the diagnosis works](docs/diagnosis.md) covers a few more Chromium quirks, and the limits on snapshot size.

## Docs

- [How the diagnosis works](docs/diagnosis.md)
- [API reference](docs/api.md), including the full result object
- [Changelog](CHANGELOG.md)

## Other leak finders

[fuite](https://github.com/nolanlawson/fuite) and Meta's [memlab](https://github.com/facebook/memlab) also find memory leaks in web apps. Both run outside your test suite and drive Chrome through Puppeteer. fuite repeats a scenario 7 times by default, and memlab compares snapshots from before and after a single action.

`playwright-soak-test` runs inside the Playwright tests you already have, so a leak fails your CI run like any other test. It repeats a flow a few hundred times rather than a handful, and the virtual clock lets a run cover an hour or more of your app's time.

## Running the tests

The repo includes a small demo app in `examples/`, built twice: once with its leaks in place and once with them fixed. `npm test` builds the package and both versions of the app, then runs the unit tests, the package tests, and the soak tests against the app:

```sh
npm install
npm test
```

`npm run test:coverage` runs the same tests and checks how much of the code in `src/` they run. It fails if lines, statements, functions or branches drop under 99%, and writes a report to `coverage/index.html`.

## Contributing

Pull requests are welcome. So are bug reports, questions and results from your own app, in [issues](https://github.com/denodell/playwright-soak-test/issues). For a bug, a small repo that shows the problem helps the most.

## License

MIT
