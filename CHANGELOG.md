# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-15

### Added

- `diagnosis` on `SoakResult`, naming what leaked and what still references it
- Heap snapshots at the baseline pass and after the final reading, diffed by node name
- `detached`, every class of detached DOM node whose count went up, largest first
- `retainerPath`, the chain of retainers from the root to the leaked object, as `{ node, edge }` hops
- `growth`, the JS constructors and named closures that grew most
- Detached classes that share a chain reported as one leak, not one finding per class
- Retainer chains through the virtual clock reported as `a pending timer`
- `diagnose` option, off by default: `'on-failure'` takes snapshots when a run fails, `'always'` on a clean run too
- `diagnoseTimeoutMs` option, default 60,000, after which the diagnosis is dropped with a note
- Snapshots left unparsed with a note when the worker has not the heap to read one, rather than risk taking the run down
- Both snapshots attached as `soak-heap-baseline` and `soak-heap-after`
- The diagnosis printed under the reporter's box, and in the `SoakLeakError` message
- Types `SoakDiagnosis`, `SoakDiagnoseMode`, `SoakDetachedClass`, `SoakRetainerHop` and `SoakGrowth`

### Changed

- The report stops guessing at a cause once the snapshots have named one
- Retainer walks look for a route through the page before falling back to one through V8's root buckets
- One snapshot held in memory at a time, with the baseline reduced to counts and ids before the second is read
- Detached classes group into one leak by their whole shared chain, not by the name at one depth
- A code-split chunk's `Module` and `Generator` objects collapse out of the chain, keeping the variable name behind them

Diagnosis is off by default, so a suite upgrading from 0.1.0 runs exactly as it did. Turning it on costs two heap snapshots on a failing run and one on a passing run.

## [0.1.0] - 2026-08-05

Initial release. Requires Playwright 1.45 or newer on Node 18 or newer, and runs on Chromium only.

### Added

- `soak` fixture, providing `soak.run()` and `soak.measure()`
- `soakFixtures` for composing onto an existing extended `test`
- `runSoak()` and `measureSoak()` for use without the fixture
- `installSoakClock()` for installing the virtual clock by hand
- `soakLaunchOptions`, setting `--js-flags=--expose-gc`
- `SoakLeakError`, thrown by `soak.run()` and containing the `SoakResult`
- Reporter at `playwright-soak-test/reporter`: a box per test, a summary table, and GitHub Actions annotations and job summary
- DOM node and listener counts asserted against thresholds of 100 and 0, with heap reported only
- Virtual clock advanced 18 seconds per pass
- `waitForResponse` for pollers that re-arm when a response lands
- Trend shapes `flat`, `linear`, `step`, `settled` and `noisy`, with `step` and `settled` reported as over threshold rather than as a leak
- Sparkline per metric row
- Progress lines every 30 seconds
- Options `passes`, `warmup`, `nodeThreshold`, `listenerThreshold`, `heapThresholdPercent`, `clock`, `waitForResponse`, `waitForResponseTimeout`, `gcPasses`, `progressEveryMs`, `tracePasses`, `sampleEvery` and `label`
- TypeScript types for the public API

[0.2.0]: https://github.com/denodell/playwright-soak-test/releases/tag/v0.2.0
[0.1.0]: https://github.com/denodell/playwright-soak-test/releases/tag/v0.1.0
