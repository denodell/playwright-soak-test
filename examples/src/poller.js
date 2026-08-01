/**
 * Self-scheduling poller. The next timer is set once the current response
 * arrives, rather than on a fixed interval.
 *
 * On a virtual clock that means advancing time fires the pending timer, and the
 * request after it waits for that fetch to resolve.
 */

const INTERVAL_MS = 30_000;

let polls = 0;

export function startPolling() {
  const label = document.getElementById('poll-count');

  async function poll() {
    try {
      const res = await fetch('/api/feed', { cache: 'no-store' });
      await res.json();
      polls++;
      if (label) label.textContent = `polls: ${polls}`;
      window.__pollCount = polls;
    } catch { }
    setTimeout(poll, INTERVAL_MS);
  }

  window.__pollCount = 0;
  poll();
}
