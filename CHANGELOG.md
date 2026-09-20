# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-15

### Added

- A heap snapshot at the baseline pass and another after the final reading, compared by node name
- `diagnosis` on `SoakResult`, holding what the two snapshots found
- `detached`, every class of detached DOM node whose count went up, largest first
- `retainerPath`, the chain from the root down to the leaked object, as `{ node, edge }` hops
- `growth`, the JS constructors and named closures that grew the most
- Detached classes that share a chain are grouped, so a container and the elements inside it are one finding
- A chain through the virtual clock now reads `a pending timer`. That hop carries `kind: 'timer'`, so the wording can change without breaking anything that reads it
- `diagnose`, set to `'on-failure'`. `'always'` reports on a clean run too, and `'off'` skips the snapshots
- `keepSnapshots`, off by default. Turning it on attaches both snapshots for DevTools instead of deleting them once the diff has read them
- `diagnoseTimeoutMs`, default `60000`. If the snapshot work runs over, the diagnosis is dropped and the result gets a note
- A snapshot too big for the memory the worker has left is not parsed at all. The result gets a note instead, and the run carries on
- Both snapshots attached as `soak-heap-baseline` and `soak-heap-after` when `keepSnapshots` is on
- The diagnosis printed under the reporter's box, and in the `SoakLeakError` message
- Types `SoakDiagnosis`, `SoakDiagnoseMode`, `SoakDetachedClass`, `SoakRetainerHop` and `SoakGrowth`

### Changed

- The report stops guessing at a cause once the snapshots have named one
- A retainer walk tries a route through the page before it tries V8's root buckets
- Only one snapshot is in memory at a time. The baseline is reduced to the counts and ids the diff needs, then dropped before the second one is read
- Detached classes are grouped by the whole chain they share. They used to be grouped by the name at one depth, which split some leaks in two
- The `Module` and `Generator` objects a code-split chunk adds come out of the chain, and the name they were carrying moves up to the hop above

### Fixed

- Chromium installed on `postinstall`, so the tests run in a fresh clone without fetching the browser by hand ([#1](https://github.com/denodell/playwright-soak-test/pull/1), thanks [@brentguf](https://github.com/brentguf))

A suite upgrading from 0.1.0 gets the diagnosis on a failing run without changing anything. Every run takes a heap snapshot at the baseline pass, before the outcome is known, and a run that fails takes a second one. Both are deleted afterwards unless `keepSnapshots` is on. `diagnose: 'off'` restores the 0.1.0 behavior.

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
