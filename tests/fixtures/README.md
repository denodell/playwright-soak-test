# Heap snapshot fixtures

These are four small heap snapshots in V8's format, written by hand so they can
be read and checked by eye. They let the parser and the comparison be tested
without launching a browser.

`retained-drawer-baseline.heapsnapshot` contains only the root and a window.

`retained-drawer.heapsnapshot` is the same page after a leak. Three chains lead
from the root:

```
Window → .__sink → Array → (object elements) → AuditEntry, three of them
Window → EventListener → closure handleClick → system / Context → el → <div class="card"> → <span>
WeakHolder → <div class="card">, by a weak edge
```

Both `<div class="card">` and `<span>` are marked as detached. `WeakHolder` is
there to test the weak edge. It's the shortest path from the div back to the
root, but a weak reference doesn't keep anything alive, so the walk has to
ignore it.

`pending-timer.heapsnapshot` is a timer still waiting in the fake clock
Playwright adds to the page:

```
Window → .__pwClock → Object → ClockController → Map → .func → closure tick → state → <div class="tile">
```

Everything between the window and `tick` belongs to the clock that
`installSoakClock` sets up, so the report replaces those steps with a single
`a pending timer` step.

`global-handle.heapsnapshot` is a detached `<section>` referenced from two places:

```
Window → .__panel → closure openPanel → context panel → <section class="panel">
(GC roots) → (Global handles) → <section class="panel">
```

The second path is two steps and the first is four, so a plain shortest-path
search picks the second. Once V8's own steps are left out, only the section is
left, which gives you nothing to fix. `pathForClass` looks for a path that
avoids V8's own roots first, which is how it finds `openPanel`.
