# API reference

## Exports

| Export | What it is |
| --- | --- |
| `test` | Playwright's `test` with the `soak` fixture added. Most tests only need this. |
| `expect` | Playwright's `expect`, re-exported so both come from the same import. |
| `soak.run(flow, options?)` | Repeats the flow, and throws `SoakLeakError` if a count grew past its threshold. |
| `soak.measure(flow, options?)` | The same run, but it returns the `SoakResult` instead of throwing. |
| `soakFixtures` | The fixture on its own, for a `test` you've already extended: `base.extend(myFixtures).extend(soakFixtures)`. |
| `runSoak(page, flow, options?)` | `soak.run` without the fixture, for when you can't use `soak`, like Playwright run as a library, or a run started from a page object. Pass `testInfo` in the options to send the numbers to the reporter. |
| `measureSoak(page, flow, options?)` | `soak.measure` without the fixture. |
| `installSoakClock(page)` | Installs the virtual clock. It has to run before the app loads. The fixture does this for you, so you only need it with `runSoak` and `measureSoak`. |
| `soakLaunchOptions` | `launchOptions` with `--js-flags=--expose-gc` set, so a test can force garbage collection. |
| `SoakLeakError` | Thrown by `soak.run` and `runSoak`. Its `result` property is the full `SoakResult`. |
| `formatSoakReport(result)` | The report for a `SoakResult` as text. For a leak it's the same text as the `SoakLeakError` message, so you can log a `soak.measure()` result the same way. |

The types are exported too: `Soak`, `SoakAction`, `SoakOptions`, `SoakRunOptions`, `SoakClockOptions`, `SoakResult`, `SoakSample`, `SoakTrend`, `SoakMetrics`, `SoakFailure`, `SoakDiagnosis`, `SoakDiagnoseMode`, `SoakDetachedClass`, `SoakRetainerHop`, `SoakGrowth`, `SoakFixtures` and `SoakTestOptions`.

## The result

Every run returns a `SoakResult`, and `SoakLeakError` has the same object on its `result` property. This is the one from the leaking drawer in the README:

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

`perPass` is the slope of the line fitted through the readings, and `total` is the last reading minus the baseline. `r2` is how well that line fits, and `shape` says how the count grew: `flat`, `linear`, `step`, `settled` or `noisy`. A `step` trend also has `stepAtPass`, the pass where the jump happened.

`diagnosis` is what the heap snapshots found. It's only there on a run that failed, or on one with `diagnose: 'always'`. `detached` is sorted largest first, so the `<div>` and `<span>` inside the drawer come before the `<section>` shown here. `diagnosis.snapshots` has the paths to the two snapshot files when `keepSnapshots` is on, and `diagnosis.note` says why the diagnosis stopped, if it did. [How the diagnosis works](diagnosis.md) explains the rest.
