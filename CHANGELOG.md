# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-15

### Added

- `diagnosis` on `SoakResult`: what a failing run leaked, and what is holding it
- Heap snapshots taken at the baseline pass and after the final reading, diffed by node name
- `detached`, every class of detached DOM node whose count went up, largest first
- `retainerPath`, the chain of holders from the root down to the leaked object, as `{ node, edge }` hops, with internal hops collapsed and a captured variable's name kept against the closure that captured it
- Detached classes that share a chain reported as one leak rather than one finding per class, named in a sentence with the chain underneath as evidence
- Retainer chains through the virtual clock reported as `a pending timer`, so a leak is never blamed on the plumbing this library installed
- `SoakRetainerHop`
- `growth`, the JS constructors and named closures that grew most, so a leak that never touches the DOM is still named
- `diagnose` option: `'on-failure'` (default), `'always'` or `'off'`
- `diagnoseTimeoutMs` option, default 60,000. Running past it abandons the diagnosis with a note rather than failing the test
- Both snapshots attached to the test result as `soak-heap-baseline` and `soak-heap-after`, ready to drag into DevTools → Memory
- The diagnosis printed under the reporter's box, and in the `SoakLeakError` message
- Types `SoakDiagnosis`, `SoakDiagnoseMode`, `SoakDetachedClass`, `SoakRetainerHop` and `SoakGrowth`

### Changed

- The report stops guessing at a cause once the snapshots have named one, so a failing run no longer says the same thing twice. The counts and the per-pass rate stay in the box and the trend line, and the diagnosis sentence does not repeat them
- A passing run takes one heap snapshot rather than two: the second waits until the thresholds have been checked, since nothing between the last reading and the verdict touches the page
- A run with diagnosis on takes two heap snapshots, which adds to how long it takes. Passing runs print and return exactly what they did before, and `diagnose: 'off'` restores the old cost.

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
