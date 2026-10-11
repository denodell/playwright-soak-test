# How the diagnosis works

A count going up tells you something leaked, but not what. To find out, a run takes a heap snapshot at the baseline pass and another at the end, then compares the two. It finds the kinds of element and object that went up, and for each one, the chain of references that's keeping it in memory.

Failing runs do this automatically, and print what they found under the report:

```
  A listener on window is still registered. Its callback `onResize` still references the
  <section class="report-drawer"> element.

    window → EventListener → onResize() → <section class="report-drawer">
```

`onResize` is the function to look at. The chain under the sentence shows why: `window` keeps the listener, the listener calls `onResize`, and `onResize` still references a section that's no longer on the page.

## Other common leaks

An array or map that keeps growing:

```
  An array called `history` keeps growing, and the <section class="feed-panel"> element is
  still in it.

    window.__drawer.open → openDrawer() → Array → <section class="feed-panel">
```

A timer that was never cleared:

```
  A timer is still pending. Its callback `tick` still references the <section
  class="live-tile"> element.

    a pending timer → tick() → <section class="live-tile">
```

A leak that stays out of the DOM has no element to name, so the report lists the kinds of object that went up instead:

```
  Nothing leaked from the DOM. The growth is in Array +850, AuditEntry +850.
```

When only Chrome's own objects are keeping the elements, the report says so, and names the two usual causes: typing into an editable area, and logging an event with `console.log`. Neither one is a leak in your code.

## Bundled builds

Vite, webpack and Rollup merge your modules into one scope, and V8 names that scope after whichever function it picks. So the chain can name a function from a different file than the one with the leak:

```
  A map called `mounted` keeps growing, and the <section class="inspector"> element is
  still in it.

    window.__drawer.open → openDrawer() → Map → <section class="inspector">
```

`mounted` is the name to search for, and it's in `inspector.jsx`. `openDrawer` only shows up because it shares the bundle's scope with `mounted`. That's why the sentence names the variable rather than the function. In an unbundled dev build, the chain names the function you'd expect.

A code-split chunk adds its own `Module` and `Generator` objects between the file that imports it and the code inside it. These are left out of the chain, so a lazy-loaded panel reads the same as one in the main bundle.

## Keeping the snapshots

The report only shows the top three leaks, one example of each, and a chain of up to eight steps. If you need more, turn on `keepSnapshots`. Both snapshot files are attached to the test result, and you can open either one in DevTools → Memory to see everything that references the leaked object:

```ts
test.use({ soakOptions: { keepSnapshots: true } });
```

```sh
npx playwright show-report
```

Without `keepSnapshots`, both files are deleted once they've been read. A real app's two snapshots add up to hundreds of megabytes, which is a lot to upload from CI for every failing test.

## When the diagnosis runs

With `diagnose: 'on-failure'`, the default, a failing run is diagnosed and a passing one isn't. With `'always'`, passing runs are diagnosed too, which shows what a flow creates before anything goes wrong.

Either way, the baseline snapshot is taken on every run, because the run can't know yet whether it will fail. It's deleted again if the run passes. On a real app that adds a few seconds to each run. `diagnose: 'off'` skips it.

If the snapshot work takes longer than `diagnoseTimeout`, the diagnosis is dropped and the run still passes or fails on its counts. The same happens 5 seconds before the test's own timeout, so a slow diagnosis doesn't turn a leak report into a timeout. If the snapshot files can't be written, the diagnosis is dropped too. In each case, `result.diagnosis.note` says why.

## Snapshot size

Each snapshot is read with `JSON.parse`, which needs about four times the file size in memory. Only one snapshot is in memory at a time. The baseline is cut down to the counts the comparison needs before the second one is read. For scale, an 800,000-node snapshot is 43MB and takes under a second to read.

The largest snapshot it will read depends on how much memory the test worker has left. Raising `--max-old-space-size` raises the limit, up to about 512MB, which is the longest string Node can read a file into. Past that, the snapshots aren't read at all, rather than risk crashing the test run. The note says which limit it hit, and if `keepSnapshots` is off, it suggests turning it on so you can open the files in DevTools yourself.

## Chromium quirks

- Clicking an element that your flow then removes adds two nodes a pass in Chromium. They only appear when the app is already keeping that part of the page in memory, so a build without leaks still reads 0.
- A `::before` or `::after` with `content` adds a `PseudoElement` and its text to the node count, so a component can read two nodes higher than the elements you wrote.
- The chain is the shortest path from the leaked object back to a root. V8's own roots, like `(Global handles)`, are often fewer steps away than your code, so the search tries for a path through the page first, and only falls back to any path if there isn't one. A chain that shows the element on its own means nothing on the page references it.

## In the result

The same findings are on `result.diagnosis`. The [API reference](api.md) shows the full shape. In a chain, a step that's a function has `kind: 'closure'` and its `node` is the function's name. A step that's one of Chrome's own objects, like `StyleEngine`, has `kind: 'browser'`.
