# Heap snapshot fixtures

Four hand-built snapshots in V8's format, small enough to read and check by eye,
so the parser and the diff can be tested without launching a browser.

`retained-drawer-baseline.heapsnapshot` holds only the root and a window.

`retained-drawer.heapsnapshot` is the same page after a leak. Three chains lead
out of the root:

```
Window → .__sink → Array → (object elements) → AuditEntry, three of them
Window → EventListener → closure handleClick → system / Context → el → <div class="card"> → <span>
WeakHolder → <div class="card">, by a weak edge
```

Both `<div class="card">` and `<span>` are marked detached. `WeakHolder` is there
for the weak edge. It is the shortest way back to the root from the div, and the
walk has to ignore it, since a weak reference keeps nothing alive.

`pending-timer.heapsnapshot` is a timer still sitting in the injected clock:

```
Window → .__pwClock → Object → ClockController → Map → .func → closure tick → state → <div class="tile">
```

`installSoakClock` puts everything between the window and `tick` there, so the
report collapses that run to `a pending timer`.

`global-handle.heapsnapshot` is a detached `<section>` that two things point at:

```
Window → .__panel → closure openPanel → context panel → <section class="panel">
(GC roots) → (Global handles) → <section class="panel">
```

The second is two hops and the first is four, so the plain shortest walk takes
the second and collapsing leaves the section on its own, with nothing to act on.
`pathForClass` asks for a route that avoids V8's own root buckets first, which is
what makes it come back with `openPanel`.
