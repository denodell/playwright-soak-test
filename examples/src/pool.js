/**
 * Pooled result list.
 *
 * Rows are built as they are needed and kept for reuse, so the pool grows to
 * the largest number of rows it has ever shown and stays there. Virtualised
 * lists work this way.
 *
 * This is the only widget here that ignores `__LEAK__`, because the growth is
 * intended. One screen with more data than the others leaves the pool bigger
 * for the rest of the session. A soak test sees that as growth, and the report
 * calls it a one-off: it climbs once and then holds.
 */

const pool = [];

export function showRows(count) {
  const host = document.getElementById('pool-host');

  while (pool.length < count) {
    // 3 nodes each: the row, its label, and the label's text.
    const row = document.createElement('div');
    const label = document.createElement('span');
    label.textContent = `row ${pool.length}`;
    row.appendChild(label);
    host.appendChild(row);
    pool.push(row);
  }

  for (let i = 0; i < pool.length; i++) {
    pool[i].hidden = i >= count;
  }

  window.__poolSize = pool.length;
}
