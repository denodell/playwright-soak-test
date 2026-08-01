/**
 * Keyboard shortcuts panel.
 *
 * Opening it adds a keydown listener on window and renders a small panel.
 * Closing takes the panel out of the page and drops the last reference to it,
 * so the nodes are collected either way.
 *
 * When `__LEAK__` is set, closing leaves the listener in place. The listener is
 * the only thing this widget leaks, so it moves the listener count while the
 * node count stays flat.
 *
 * The handler comes from a factory so its scope holds just the counter. Built
 * inline it would share a scope with the panel, and the panel could be captured
 * along with it.
 */

let open = null;
let opened = 0;

function makeHandler(id) {
  return () => {
    window.__shortcutHits = (window.__shortcutHits ?? 0) + id;
  };
}

export function openShortcuts() {
  if (open) return;

  const host = document.getElementById('shortcuts-host');
  const root = document.createElement('section');
  const hint = document.createElement('span');
  hint.textContent = 'press ? for shortcuts';
  root.appendChild(hint);
  host.appendChild(root);

  const onKey = makeHandler(++opened);
  window.addEventListener('keydown', onKey);

  open = { root, onKey };
  window.__shortcutPanels = opened;
}

export function closeShortcuts() {
  if (!open) return;

  open.root.remove();

  if (!__LEAK__) {
    window.removeEventListener('keydown', open.onKey);
  }

  open = null;
}
