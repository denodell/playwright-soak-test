/**
 * Report drawer.
 *
 * Opening it adds 40 nodes to the page, plus a resize listener on window that
 * refers to `root`, the drawer's top-level element. Closing takes the nodes
 * back out of the page.
 *
 * When `__LEAK__` is set, closing leaves the listener in place. Window keeps a
 * reference to the listener, the listener refers to `root`, and `root` contains
 * its descendants, so the whole drawer stays in memory. Each open/close cycle
 * leaks 40 nodes and one listener.
 *
 * The 40 nodes are:
 *
 *   section                          1
 *   h2 + its text node               2
 *   ROW_COUNT * (div + span + text)  36
 *   footer div                       1
 *                                   ---
 *                                    40
 */
const ROW_COUNT = 12;

const METRICS = [
  'p50 latency', 'p95 latency', 'p99 latency', 'error rate',
  'requests/s', 'bytes/s', 'queue depth', 'retries',
  'cache hit rate', 'open sockets', 'gc pauses', 'cpu load',
];

let open = null;

function buildDrawer() {
  const root = document.createElement('section');
  root.className = 'report-drawer';

  const heading = document.createElement('h2');
  heading.textContent = 'Report';
  root.appendChild(heading);

  for (let i = 0; i < ROW_COUNT; i++) {
    const row = document.createElement('div');
    row.className = 'report-row';
    const label = document.createElement('span');
    label.textContent = METRICS[i % METRICS.length];
    row.appendChild(label);
    root.appendChild(row);
  }

  const footer = document.createElement('div');
  footer.className = 'report-footer';
  footer.id = 'drawer-close';
  root.appendChild(footer);

  return root;
}

export function openDrawer() {
  if (open) return;
  const host = document.getElementById('drawer-host');
  const root = buildDrawer();
  host.appendChild(root);

  // The leak!
  const onResize = () => {
    root.dataset.width = String(window.innerWidth);
  };
  window.addEventListener('resize', onResize);

  open = { root, host, onResize };
}

export function closeDrawer() {
  if (!open) return;
  const { root, host, onResize } = open;
  host.removeChild(root);

  if (!__LEAK__) {
    window.removeEventListener('resize', onResize);
  }

  open = null;
}
