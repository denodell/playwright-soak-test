import v8 from 'node:v8';
import { expect, test } from '@playwright/test';
import { oversizeReason, parseBudgetBytes } from '../../src/heap-capture.js';

test.describe('oversizeReason', () => {
  const MB = 1024 * 1024;

  test('a pair the budget covers is fine', () => {
    expect(oversizeReason([50 * MB, 120 * MB], { budgetBytes: 200 * MB })).toBeNull();
  });

  test('a pair too big to parse says so, and points at the files', () => {
    // Parsing takes around four times the file size in heap, so past the budget
    // the worker runs out of memory and takes the whole test run with it. Better
    // to skip the diagnosis than to lose the run.
    const reason = oversizeReason([10 * MB, 400 * MB], {
      budgetBytes: 200 * MB,
      keepSnapshots: true,
    });
    expect(reason).toContain('400MB');
    expect(reason).toContain('200MB');
    expect(reason).toContain('attached');
  });

  test('and with the files going, says how to hang on to them instead', () => {
    // Nothing was read, so the snapshots are the only thing left to look at.
    const reason = oversizeReason([640 * MB], { budgetBytes: 200 * MB });
    expect(reason).toContain('keepSnapshots');
    expect(reason).not.toContain('Both are attached');
  });

  test('past the longest string Node can hold, more heap would not help, so it says that', () => {
    // A worker started with a large --max-old-space-size can have the heap to
    // parse a snapshot that Node still can't read into one string.
    const reason = oversizeReason([700 * MB], { budgetBytes: 1500 * MB, maxTextBytes: 512 * MB });
    expect(reason).toContain('700MB');
    expect(reason).toContain('512MB Node can read into one string');
    expect(reason).not.toContain('heap');
  });

  test('the budget comes from the heap this worker has left, not a fixed number', () => {
    const budget = parseBudgetBytes();
    // Node's own limit is the ceiling, so the budget has to sit under it however
    // the worker was launched.
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(v8.getHeapStatistics().heap_size_limit);
    expect(oversizeReason([budget * 2])).not.toBeNull();
    expect(oversizeReason([budget / 2])).toBeNull();
  });
});
