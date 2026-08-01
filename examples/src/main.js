import { openDrawer, closeDrawer } from './drawer.js';
import { startPolling } from './poller.js';
import { openTicker, closeTicker } from './ticker.js';
import { openFeed, closeFeed } from './feed.js';
import { showRows } from './pool.js';
import { openShortcuts, closeShortcuts } from './shortcuts.js';

const toggle = document.getElementById('toggle-drawer');
let shown = false;

toggle.addEventListener('click', () => {
  shown = !shown;
  if (shown) {
    openDrawer();
  } else {
    closeDrawer();
  }
});

// Delegated from the host, which stays in the page, so one listener covers
// every drawer that opens inside it.
document.getElementById('drawer-host').addEventListener('click', (event) => {
  if (event.target.id !== 'drawer-close') return;
  shown = false;
  closeDrawer();
});

const feedToggle = document.getElementById('toggle-feed');
let feedShown = false;

feedToggle.addEventListener('click', async () => {
  feedShown = !feedShown;
  if (feedShown) await openFeed();
  else closeFeed();
});

const tickerToggle = document.getElementById('toggle-ticker');
let tickerShown = false;

tickerToggle.addEventListener('click', () => {
  tickerShown = !tickerShown;
  if (tickerShown) openTicker();
  else closeTicker();
});

// Exposed so the soak tests can call open and close directly, instead of going
// through click dispatch and the buttons' own state.
window.__drawer = { open: openDrawer, close: closeDrawer };
window.__ticker = { open: openTicker, close: closeTicker };
window.__feed = { open: openFeed, close: closeFeed };
window.__shortcuts = { open: openShortcuts, close: closeShortcuts };
window.__shortcutHits = 0;
window.__shortcutPanels = 0;
window.__pool = { show: showRows };
window.__poolSize = 0;
window.__feedRows = 0;
window.__feedHistory = 0;
window.__tickCount = 0;
window.__build = __LEAK__ ? 'leak' : 'fixed';

startPolling();
