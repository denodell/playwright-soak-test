/**
 * Audit trail.
 *
 * Every pass records a batch of entries on an array hung off `window`. It never
 * touches the page, so the node and listener counts stay exactly where they
 * were and only the heap moves.
 *
 * When `__LEAK__` is set the array keeps every entry it has ever been given.
 * Otherwise it is trimmed back to the last `RETAINED`, the way a ring buffer
 * would, and the heap holds steady.
 *
 * This is the leak the counts cannot see. `Nodes` and `JSEventListeners` are
 * flat, so only a heap threshold fails the run, and only the snapshot diff can
 * say that `AuditEntry` is the thing piling up.
 */

const RETAINED = 50;
const ENTRIES_PER_BATCH = 50;

// Nothing reads this. Each entry has to weigh something, or a batch of 50 would
// not move the heap far enough to measure.
const DETAIL = 'x'.repeat(155);

class AuditEntry {
  constructor(id) {
    this.id = `audit-${String(id).padStart(6, '0')}`;
    this.at = Date.now();
    this.detail = `${DETAIL} (${id})`;
    this.tags = [`batch-${id % 7}`, `shard-${id % 13}`];
  }
}

// The array the leak hangs from. Named `window.__audit` on purpose, so the
// retainer path in the report shows a name you can grep for.
window.__audit = [];

let recorded = 0;

export function recordBatch() {
  for (let i = 0; i < ENTRIES_PER_BATCH; i++) {
    window.__audit.push(new AuditEntry(++recorded));
  }

  if (!__LEAK__) {
    window.__audit.splice(0, window.__audit.length - RETAINED);
  }

  window.__auditSize = window.__audit.length;
}

export const AUDIT_ENTRIES_PER_BATCH = ENTRIES_PER_BATCH;
