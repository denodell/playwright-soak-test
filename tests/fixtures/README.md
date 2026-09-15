# Heap snapshot fixtures

Two hand-built snapshots in V8's format, small enough to read and check by eye.
They exist so the parser and the diff can be tested without launching a browser.

`retained-drawer-baseline.heapsnapshot` is the root and a window, and nothing
else. `retained-drawer.heapsnapshot` is the same page after a leak, and its
graph is this:

```
(GC roots)
├── Window / https://example.test
│   ├── .__sink → Array → (object elements) → AuditEntry x3
│   └── EventListener → closure handleClick → system / Context
│                                             └── el → <div class="card">   [detached]
│                                                      └── <span>           [detached]
└── WeakHolder  ~~weak~~>  <div class="card">
```

The weak edge is the point of `WeakHolder`: it is the shortest way back to the
root from the detached div, and a retainer walk has to refuse it, because a weak
reference is not what is keeping the div alive.

`pending-timer.heapsnapshot` is a timer left pending on the injected clock:

```
(GC roots)
└── Window / https://example.test
    └── .__pwClock → Object → ClockController → Map
                                                └── .func → closure tick
                                                            └── state → <div class="tile">   [detached]
```

Everything between the window and `tick` is Playwright's clock, which
`installSoakClock` put there. The report collapses that run to `a pending timer`,
because blaming a leak on this library's own plumbing helps nobody.
