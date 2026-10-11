// A plain external store, the shape most apps end up with before they reach for
// a library: subscribe returns the function that removes you again.
const listeners = new Set();
let revision = 0;

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish() {
  revision++;
  for (const listener of listeners) listener(revision);
}

export function listenerCount() {
  return listeners.size;
}
