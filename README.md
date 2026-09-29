# playwright-soak-test

[![ci](https://github.com/denodell/playwright-soak-test/actions/workflows/ci.yml/badge.svg)](https://github.com/denodell/playwright-soak-test/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/denodell/playwright-soak-test)](https://github.com/denodell/playwright-soak-test/blob/main/LICENSE)

Soak test your single-page web app (SPA) for memory leaks at high speed, using Playwright.

A SPA keeps running for as long as its browser tab is open, so any memory it leaks keeps building up. The usual cause is DOM nodes that get removed from the page but stay in memory, because a listener or timer still has a reference to them. Over a long session they add up, the page gets slower, and eventually the tab can crash.

`playwright-soak-test` repeats a user flow a few hundred times in one browser session, and watches the DOM node and listener counts as it goes. If they keep climbing, the test fails.

Between passes it advances a virtual clock, so the app's timers fire as if that time had really passed. `page.route` can answer the app's network requests with your own data, so no pass waits on a server. The default 200 passes cover an hour of the app's time and finish in a few seconds. Compressing time like this catches leaks that only build up over a long session, like a feed that polls every 30 seconds and keeps every response, or a timer that never gets cleared.

The flow has to end where it started, so the counts should be the same at the end as at the start. Opening a drawer and closing it again works, and so does filtering a table and then clearing the filter. A flow that's meant to add to the page, like an infinite scroll feed, will keep growing and fail even when nothing is leaking. If you're curious about its counts anyway, `soak.measure()` reports them without failing the test.

> Based on my blog post [Your SPA Is Leaking Memory. Soak Test It](https://denodell.com/blog/your-spa-is-leaking-memory-soak-test-it?utm_source=github&utm_medium=playwright-soak-test&utm_campaign=readme), which goes into detail behind the method and the default values used here.

## Installation

```sh
npm install --save-dev playwright-soak-test
```

`@playwright/test` is a peer dependency, so it works with the Playwright you already have installed, as long as it's version 1.45 or newer.

The counts come from the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/), which only Chromium supports, so tests that use the `soak` fixture are skipped on Firefox and WebKit.

## Usage

Import `test` from `playwright-soak-test` instead of `@playwright/test`. It's the same `test` with a `soak` fixture added. If you already have a spec that clicks through the flow you want to test, change the import and wrap the flow in `soak.run()`:

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

`soak.measure()` takes the same arguments but returns the result instead of throwing, for when you only want to see the DOM node and listener counts:

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

Every reading takes three values from Chromium: the DOM node count, the event listener count, and the size of the JS heap. Garbage collection is forced first, so memory the browser was about to free isn't counted. By default, only the node and listener counts can fail a run. The heap size is recorded and printed, and `heapThresholdPercent` adds it to the check.

Defaults go in `use: { soakOptions }` in the config, or at the top of a spec with `test.use`. You can also pass any of them per run, as the second argument to `soak.run` and `soak.measure`.

| Option | Default | What it does |
| --- | --- | --- |
| `passes` | `200` | Passes in total, warmup included. |
| `warmup` | `5` | Passes before the baseline, so first-open code and data land in the heap first. |
| `nodeThreshold` | `100` | How much the node count can grow across the run. Raise it for components that are meant to keep DOM nodes around. When the growth came all at once or stopped early, the failure message says what to raise it to. |
| `listenerThreshold` | `0` | How much the listener count can grow. Best left alone, because a listener still registered after a round trip is most likely a bug. |
| `heapThresholdPercent` | `null` | Heap growth allowed, as a percentage. `null` reports heap and leaves it out of the assertions. Set it to catch a leak that stays out of the DOM entirely, as described under [Limitations](#limitations). |
| `clock` | `{ advanceMs: 18_000 }` | Virtual milliseconds per pass. `false` turns the clock off. |
| `waitForResponse` | unset | A URL glob awaited around each clock advance. |
| `waitForResponseTimeout` | `5000` | How long to wait before counting a response as missing and carrying on. |
| `gcPasses` | `2` | Garbage collections forced before each reading. Each reading also has Chrome update the page's layout first, since until it does, it keeps some references to elements that were just removed. |
| `progressEveryMs` | `30000` | How often a long run says where it has got to. `0` for silence. |
| `tracePasses` | `25` | Passes read one at a time at the start of the run. |
| `sampleEvery` | derived | Read every Nth pass after that. |
| `label` | test title | Name used in the report and the reporter. |
| `diagnose` | `'on-failure'` | Takes a heap snapshot at the baseline pass and another at the end, and compares them to name what leaked. `'always'` does this on passing runs too, and `'off'` skips it. The baseline snapshot is taken on every run, because nobody knows yet whether the run will fail, and on a real app it takes a few seconds. See [Diagnosis](#diagnosis). |
| `keepSnapshots` | `false` | Attaches both snapshots to the test result so you can open them in DevTools. It's off by default because a real app's two snapshots add up to hundreds of megabytes for each failing test. The diagnosis is the same either way. |
| `diagnoseTimeout` | `60000` | How long the snapshot work can take before the diagnosis is dropped. It also stops 5 seconds before the test's own timeout. If it runs over, the result gets a note, and the run doesn't fail because of it. |

## Virtual clock

The fixture installs Playwright's virtual clock before your app loads and pauses it once the app is up. From then on time only moves when a pass moves it, and `advanceMs` sets how far, so match it to the interval your app uses.

For a `setTimeout()` that calls `/api/feed` every 30 seconds, advance the clock by 30 seconds a pass to skip the wait. Fulfill the request yourself with realistic-sized fixture data, so a pass isn't waiting on the network either:

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

The clock stays paused while the flow runs, too. A flow that waits on a timer partway through, like a tooltip that opens after a 500ms hover delay, never sees that timer fire. `page.clock.runFor()` inside the flow moves the clock past the wait:

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

## Reports

A run reads the counts on each of the first 25 passes, then every Nth pass after that, and fits a line through them. The slope of that line is the per-pass figure in the report.

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

The graphs are the readings taken across the run, scaled to each row's own range. Small variations are shown as flat lines. The sentence and chain under the graphs come from the heap snapshots, and [Diagnosis](#diagnosis) explains them.

Growth that stopped is reported as `OVER THRESHOLD` rather than `LEAK DETECTED`. A single jump is labeled `all at once, at pass 10`, a climb that levels off early is labeled `climbed early, then leveled off`, and the message also suggests the number to raise the threshold to.

The reporter prints a box per test and a table at the end of the run. On GitHub Actions it also writes an error annotation and a job summary. Failing rows are red where growth continues and amber where it stopped, with the same distinction in the wording. `NO_COLOR` turns color off and `FORCE_COLOR` turns it on.

## Diagnosis

A count going up tells you something leaked, but not what. To find out, a run takes a heap snapshot at the baseline pass and another at the end, and compares the two.

Failing runs do this automatically, and print what they found under the box:

```
  A listener on window is still registered. Its callback `onResize` still references the
  <section class="report-drawer"> element.

    window → EventListener → onResize() → <section class="report-drawer">
```

`onResize` is where to look. The chain under the sentence shows why: `window` keeps the listener, the listener calls `onResize`, and `onResize` still references a section that's no longer on the page.

The other two common causes look like this:

```
  An array called `history` keeps growing, and the <section class="feed-panel"> element is
  still in it.

    window.__drawer.open → openDrawer() → Array → <section class="feed-panel">
```

```
  A timer is still pending. Its callback `tick` still references the <section
  class="live-tile"> element.

    a pending timer → tick() → <section class="live-tile">
```

A leak that stays out of the DOM has no element to name, so the report lists the names that grew instead:

```
  Nothing leaked from the DOM. The growth is in Array +850, AuditEntry +850.
```

### Bundled builds

Vite, webpack and Rollup merge your modules into one scope, and V8 labels that scope with whichever function it picks. That means a chain can name a function from a different file than the one with the leak:

```
  A map called `mounted` keeps growing, and the <section class="inspector"> element is
  still in it.

    window.__drawer.open → openDrawer() → Map → <section class="inspector">
```

`mounted` is the name to search for, and it's in `inspector.jsx`. `openDrawer` shows up because it shares the bundle's scope with `mounted`. That's why the sentence names the variable, and why the chain is more useful for seeing how the leak is connected than for finding the file. In an unbundled dev build, the chain names the function you'd expect.

A code-split chunk adds its own `Module` and `Generator` objects between the file that imports it and whatever that file references. These are left out of the chain, so a lazy-loaded panel reads the same as one bundled into the main file.

The same findings are on `result.diagnosis`, under `detached`, `objects` and `snapshots`, along with a `note` if the diagnosis was cut short. In a chain, a step that's a function has `kind: 'closure'`, and its `node` is the function's name. A step that's one of Chrome's own objects, like `StyleEngine`, has `kind: 'browser'`.

### The snapshots

The report is a summary: the top three leaks, one example of each, and a chain of at most eight steps. When you need more, `keepSnapshots` attaches both files to the test result, and you can open either one in DevTools → Memory to see everything that references the leaked object:

```ts
test.use({ soakOptions: { keepSnapshots: true } });
```

```sh
npx playwright show-report
```

Without `keepSnapshots`, both files are deleted once they've been read. A real app's two snapshots add up to hundreds of megabytes, which is a lot to upload from CI for every failing test, and `result.diagnosis` is the same either way.

`'always'` reports on passing runs too, which shows what a flow allocates before anything goes wrong. With `'on-failure'` or `'always'`, the baseline snapshot is taken on every run, because nobody knows yet whether the run will fail, and it's deleted again if the run passes. On a real app that adds a few seconds to each run, and `diagnose: 'off'` skips it.

If the snapshot work takes longer than `diagnoseTimeout`, the diagnosis is dropped, and the run still passes or fails on its counts. The same happens 5 seconds before the test's own timeout, so a slow diagnosis doesn't turn a leak report into a timeout.

If the snapshot files can't be written, the diagnosis is dropped the same way, with a note saying why.

## API

| Export | Description |
| --- | --- |
| `test` | Playwright's `test` with the `soak` fixture already on it. The usual entry point. |
| `expect` | Playwright's `expect`, re-exported so both come from the same import. |
| `soak.run(flow, options?)` | Repeats the flow and throws `SoakLeakError` if a count grew past its threshold. |
| `soak.measure(flow, options?)` | The same run, returning the `SoakResult` whether or not anything grew. |
| `soakFixtures` | The fixture on its own, for a `test` you've already extended: `base.extend(myFixtures).extend(soakFixtures)`. |
| `runSoak(page, flow, options?)` | `soak.run` without the fixture, for when `soak` is out of scope: Playwright driven as a library, or a run started from inside a page object. Pass `testInfo` in the options to get the numbers to the reporter. |
| `measureSoak(page, flow, options?)` | `soak.measure` without the fixture. |
| `installSoakClock(page)` | Installs the virtual clock, which has to happen before the app loads. The fixture does this for you, so it's only needed alongside `runSoak` and `measureSoak`. |
| `soakLaunchOptions` | `launchOptions` carrying `--js-flags=--expose-gc`. |
| `SoakLeakError` | Thrown by `soak.run` and `runSoak`. Its `result` property holds the full `SoakResult`. |
| `formatSoakReport(result)` | The report for a `SoakResult` as text. For a leak it's the same text as the `SoakLeakError` message, so a `soak.measure()` result can be logged the same way. |

Every call returns a `SoakResult`, and `SoakLeakError` contains the same object on its `result` property. From the leaking drawer above:

```js
{
  label: 'the dashboard drawer does not leak',
  passes: 200,
  warmup: 5,
  baseline: {
    heap: 1147340,
    nodes: 259,
    listeners: 22,
    documents: 1,
  },
  after: {
    heap: 1272136,
    nodes: 8060,
    listeners: 217,
    documents: 1,
  },
  samples: [
    {
      pass: 0,
      heap: 1147340,
      nodes: 259,
      listeners: 22,
      documents: 1,
    },
    ...
    {
      pass: 195,
      heap: 1272136,
      nodes: 8060,
      listeners: 217,
      documents: 1,
    },
  ],
  trends: {
    nodes: {
      perPass: 40,
      r2: 1,
      total: 7801,
      shape: 'linear',
    },
    listeners: {
      perPass: 1,
      r2: 1,
      total: 195,
      shape: 'linear',
    },
    heap: {
      perPass: 565.36,
      r2: 0.92,
      total: 124796,
      shape: 'linear',
    },
  },
  failures: [
    {
      metric: 'listeners',
      growth: 195,
      threshold: 0,
      trend: {
        perPass: 1,
        r2: 1,
        total: 195,
        shape: 'linear',
      },
    },
    {
      metric: 'nodes',
      growth: 7801,
      threshold: 100,
      trend: {
        perPass: 40,
        r2: 1,
        total: 7801,
        shape: 'linear',
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
  diagnosis: {
    detached: [
      ...
      {
        className: 'Detached <section>',
        baseline: 5,
        after: 200,
        delta: 195,
        retainerPath: [
          { node: 'Window' },
          { node: 'EventListener' },
          { node: 'onResize', kind: 'closure', edge: { type: 'context', name: 'root' } },
          { node: '<section class="report-drawer">' },
        ],
      },
      ...
    ],
    objects: [
      {
        name: 'onResize',
        kind: 'closure',
        delta: 195,
      },
      {
        name: 'Object',
        delta: 6,
      },
    ],
  },
}
```

`perPass` is the slope of the fitted line and `total` is the last reading minus the baseline. `r2` is how well that line fits, and `shape` is derived from it: `flat`, `linear`, `step`, `settled` or `noisy`. A `step` trend also contains `stepAtPass`, the pass the jump landed on.

`diagnosis` is what the heap snapshots found. It's only there on a run that failed, or on one that set `diagnose: 'always'`. `detached` is sorted largest first, so the `<div>` and `<span>` inside the drawer come before the `<section>` shown here. `diagnosis.snapshots` gives the paths to the two snapshot files when `keepSnapshots` is on. See [Diagnosis](#diagnosis).

The types are exported too: `Soak`, `SoakAction`, `SoakOptions`, `SoakRunOptions`, `SoakClockOptions`, `SoakResult`, `SoakSample`, `SoakTrend`, `SoakMetrics`, `SoakFailure`, `SoakDiagnosis`, `SoakDiagnoseMode`, `SoakDetachedClass`, `SoakRetainerHop`, `SoakGrowth`, `SoakFixtures` and `SoakTestOptions`.

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

## Other leak finders

[fuite](https://github.com/nolanlawson/fuite) and Meta's [memlab](https://github.com/facebook/memlab) also find memory leaks in web apps. Both run on their own, outside your test suite, and drive Chrome through Puppeteer. fuite repeats a scenario 7 times by default, waiting each time until the network and the page are idle, and looks for objects that leaked once per repeat. memlab takes a heap snapshot before an action, after it, and after undoing it, then compares them to find what the action left behind.

`playwright-soak-test` runs inside the Playwright tests you already have, so a leak fails your CI run like any other test failure. It repeats a flow a few hundred times rather than a handful, and on the virtual clock a run covers an hour or more of the app's time. When a run fails, the [diagnosis](#diagnosis) takes its own heap snapshots and names what leaked and what still references it.

## Limitations

- Readings vary between runs, so this belongs in a nightly job rather than on every pull request. With `workers: 1` and `retries: 0`, each run gets a browser to itself.
- Clicking an element that your flow then removes adds two retained nodes a pass in Chromium. They only turn up on a subtree the app is already keeping, so a clean build still reads exactly 0.
- A `::before` or `::after` with `content` puts a `PseudoElement` and its text into the node count, so a component can read two nodes higher than the elements you actually wrote.
- Typing into an editable area, such as a `contenteditable` element or a rich text editor, adds to Chrome's undo history, which keeps the text a flow deletes so Ctrl+Z can bring it back. A flow that types reads a few nodes higher every pass until that history reaches 1,000 steps, then levels off. The diagnosis says when only Chrome's own objects are keeping the elements.
- Logging an event or an element with `console.log` keeps it in memory while Playwright is connected, because Chrome builds a preview of anything logged. An app that logs an event every time an overlay closes reads a whole overlay higher every pass. Logging a string, like `event.type`, doesn't do this.
- The counts miss anything that stays out of the DOM. A poller that keeps every response in an array grows the heap by 300% with the counts dead flat, and the run passes. Use `heapThresholdPercent` to catch that case, and the [diagnosis](#diagnosis) will name what's piling up.
- Diagnosis reads each snapshot with a single `JSON.parse`, which needs about four times the file size in memory. Only one snapshot is in memory at a time: the baseline is reduced to the counts the comparison needs, then dropped before the second one is read. For scale, an 800,000-node snapshot is 43MB and reads in under a second.
- The largest snapshot the diagnosis will read depends on how much heap the test worker has left, so raising `--max-old-space-size` raises the limit too, up to about 512MB, the most Node can read into one string. Past the limit, the snapshots aren't read at all, rather than risk crashing the whole test run. Since nothing was read, the note on the result suggests turning on `keepSnapshots` so you can look at the files yourself.
- The chain is the shortest path from the leaked object back to a root, and V8's own roots, such as `(Global handles)`, are often fewer steps away than your code. The walk looks for a path through the page first, and only falls back to any path if there isn't one. So a chain that shows the element on its own means nothing on the page is referencing it.

## Running the tests

The repo includes a small demo app in `examples/`, built twice: once with its leaks in place and once with them fixed. `npm test` builds the package and both versions of the app, then runs the unit tests, the package tests, and the soak tests against the app:

```sh
npm install
npm test
```

## Changelog

Every release is written up in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Pull requests are welcome. So are bug reports, questions and results from your own app, in [issues](https://github.com/denodell/playwright-soak-test/issues). For a bug, it helps to include as much detail as you can, ideally a small repo that shows the problem.

## License

MIT
