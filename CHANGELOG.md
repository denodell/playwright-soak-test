# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/denodell/playwright-soak-test/releases/tag/v0.1.0
