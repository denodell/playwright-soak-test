# Heap snapshot fixtures

Three hand-built snapshots in V8's format, small enough to read and check by eye,
so the parser and the diff can be tested without launching a browser.

`retained-drawer-baseline.heapsnapshot` holds only the root and a window.

`retained-drawer.heapsnapshot` is the same page after a leak. Three chains lead
out of the root:

```
Window → .__sink → Array → (object elements) → AuditEntry, three of them
Window → EventListener → closure handleClick → system / Context → el → <div class="card"> → <span>
WeakHolder → <div class="card">, by a weak edge
```

Both `<div class="card">` and `<span>` are marked detached. The weak edge is why
`WeakHolder` is in there. It is the shortest way back to the root from the div,
and the walk has to refuse it, since a weak reference keeps nothing alive.

`pending-timer.heapsnapshot` is a timer still sitting in the injected clock:

```
Window → .__pwClock → Object → ClockController → Map → .func → closure tick → state → <div class="tile">
```

`installSoakClock` puts everything between the window and `tick` there, so the
report collapses that run to `a pending timer`.
