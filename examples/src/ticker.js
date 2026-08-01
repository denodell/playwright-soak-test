/**
 * Live tile.
 *
 * Opening it starts a self-scheduling timer on a 30-second interval, and each
 * time it fires it appends a row to the tile. Closing takes the tile out of the
 * page.
 *
 * When `__LEAK__` is set, closing leaves the timer running. It carries on
 * appending rows to a tile that is off the page, and the timer keeps the whole
 * thing referenced. Otherwise closing clears it.
 *
 * This leak only appears once time moves. A few hundred passes run in a couple
 * of seconds, so the 30-second timer stays pending and only the tile roots pile
 * up. Advance the clock 30 seconds a pass and every leaked timer fires on every
 * pass.
 */

const INTERVAL_MS = 30_000;

// Per fired tick: div + span + its text node.
const NODES_PER_TICK = 3;

let open = null;
let ticks = 0;

export function openTicker() {
  if (open) return;

  const host = document.getElementById('ticker-host');
  const root = document.createElement('section');
  root.className = 'live-tile';
  host.appendChild(root);

  const state = { root, timer: 0 };

  const tick = () => {
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `tick ${++ticks}`;
    row.appendChild(label);
    state.root.appendChild(row);
    window.__tickCount = ticks;
    state.timer = setTimeout(tick, INTERVAL_MS);
  };

  state.timer = setTimeout(tick, INTERVAL_MS);
  open = state;
}

export function closeTicker() {
  if (!open) return;

  open.root.remove();

  if (!__LEAK__) {
    clearTimeout(open.timer);
  }

  open = null;
}

export const TICKER_INTERVAL_MS = INTERVAL_MS;
export const TICKER_NODES_PER_TICK = NODES_PER_TICK;
