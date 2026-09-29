# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-29

### Added

- Heap snapshots at the baseline pass and after the last reading, compared to find what leaked
- `diagnosis` on `SoakResult`, with what the snapshots found:
  - `detached`: each kind of detached DOM node whose count went up, largest first, with a `retainerPath` showing the chain of references from the root down to the leaked object. A step in the chain that's a function has `kind: 'closure'`
  - `objects`: the JS constructors and named functions whose object counts grew the most
- The diagnosis in the reporter output under the box, and in the `SoakLeakError` message
- Detached nodes that share a chain are reported as one finding, so a container and the elements inside it aren't listed separately. Different kinds of element held by the same array or object are one finding too
- The chain looks for a path through the page before it uses V8's own roots, which are often fewer steps away than your code
- A chain that runs through the virtual clock shows a single `a pending timer` step. It has `kind: 'timer'`, so code can check for it without depending on the wording
- The `Module` and `Generator` objects a code-split chunk adds are left out of the chain
- Plain objects are left out of the chain too, and the property they held the next step in joins the name above, so `store` then `items` reads `store.items`
- An array, map or set stored straight on `window` is named as one: ``An array at `window.cache` keeps growing``
- The sentence names the function nearest the leaked object, since functions nearer the root usually belong to a framework or library. When that function is itself still in a set or an array, the sentence says so, because that usually means a subscription that was never undone
- Element names in the report keep the tag, `id`, `role` and first class, and drop the rest, so a long list of utility classes or an inline style doesn't swamp the sentence
- A chain longer than eight steps loses its middle near the root, where the framework's steps are, and keeps the steps nearest the leak
- When only Chrome's own objects are keeping the leaked elements, the report says so instead of pointing at your code. Typing into an editable area does this, through Chrome's undo history, and so does logging an event or an element with `console.log` while Playwright is connected. Chrome's own objects in a chain are marked `kind: 'browser'`
- `diagnose` option, `'on-failure'` by default. `'always'` reports on passing runs too, and `'off'` skips the snapshots
- `keepSnapshots` option, off by default. When it's on, both snapshots are attached to the test result as `soak-heap-baseline` and `soak-heap-after` instead of being deleted
- `diagnoseTimeout` option, `60000` by default. If the snapshot work takes longer, the diagnosis is dropped and the result gets a note
- The snapshot work also stops 5 seconds before the test's own timeout, so a slow diagnosis doesn't turn a leak report into a timeout
- Only one snapshot is in memory at a time. The baseline is reduced to the counts and IDs the comparison needs, then dropped before the second one is read
- A snapshot too big for the memory the test worker has left, or bigger than the most Node can read into one string, isn't read. The result gets a note saying which, and the run carries on
- `formatSoakReport(result)`, which returns the report as text. For a leak it's the same text as the `SoakLeakError` message, so a `soak.measure()` result can be logged the same way
- Types `SoakDiagnosis`, `SoakDiagnoseMode`, `SoakDetachedClass`, `SoakRetainerHop` and `SoakGrowth`

### Changed

- When the snapshots find the cause of a leak, the report no longer adds its own guess at one
- A trend that climbed and then stopped now reads `climbed early, then leveled off`, in US spelling

### Fixed

- A long run that climbed and then stopped partway could be called noisy instead of `climbed early, then leveled off`. The halfway point was found by counting readings, and the first 25 passes are each read, so on a long run it landed near the start. It's now found by pass
- A reading taken the moment a flow ended could count elements the flow had just removed, so an app could read a whole component high on the odd pass. Each reading now has Chrome update the page's layout first, which lets those elements go
- Chromium is installed on `postinstall`, so the tests run in a fresh clone without installing the browser by hand ([#1](https://github.com/denodell/playwright-soak-test/pull/1), thanks [@brentguf](https://github.com/brentguf))

A test suite upgrading from 0.1.0 gets the diagnosis on failing runs without any changes. Every run takes a heap snapshot at the baseline pass, because nobody knows yet whether the run will fail, and a failing run takes a second one. Both are deleted afterwards unless `keepSnapshots` is on. `diagnose: 'off'` goes back to the 0.1.0 behavior. Readings can come out slightly lower than in 0.1.0, where a pass used to count elements a flow had just removed.

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
