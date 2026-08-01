/**
 * Feed panel.
 *
 * Opening it fetches /api/feed and adds one row per item, 3 nodes each. Closing
 * takes the panel out of the page and pushes the entry onto `history`.
 *
 * When `__LEAK__` is set, `history` keeps every entry. Each entry refers to
 * `root` and to the parsed response body, and `root` contains its rows, so both
 * the panel and the JSON it came from stay in memory. Otherwise `history` is
 * trimmed back to the most recent entry.
 *
 * Response size decides how visible this is. The demo server sends 196 items,
 * so one cycle leaks 588 nodes. A 5-item mock would leak 15, which is easy
 * to miss.
 */

const history = [];
let open = null;

export async function openFeed() {
  if (open) return;

  const host = document.getElementById('feed-host');
  const root = document.createElement('section');
  root.className = 'feed-panel';
  host.appendChild(root);

  const res = await fetch('/api/feed', { cache: 'no-store' });
  const body = await res.json();
  const items = body.items ?? [];

  for (const item of items) {
    // 3 nodes each: the row, its label, and the label's text.
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = item.id;
    row.appendChild(label);
    root.appendChild(row);
  }

  window.__feedRows = (window.__feedRows ?? 0) + items.length;
  open = { root, body };
}

export function closeFeed() {
  if (!open) return;

  open.root.remove();
  history.push(open);

  if (!__LEAK__) {
    history.splice(0, history.length - 1);
  }

  window.__feedHistory = history.length;
  open = null;
}
