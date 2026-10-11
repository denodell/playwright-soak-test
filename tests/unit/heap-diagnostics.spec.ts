import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { HeapDiagnostics } from '../../src/heap-capture.js';
import { FakeCdp, fakeTestInfo } from './fakes.js';

// The snapshot work against a fake CDP session, so the ways it can fail can be
// made to happen on purpose rather than waited for.

const fixtureText = (name: string): string =>
  fs.readFileSync(
    fileURLToPath(new URL(`../fixtures/${name}.heapsnapshot`, import.meta.url)),
    'utf8',
  );

const BASELINE = fixtureText('retained-drawer-baseline');
const AFTER = fixtureText('retained-drawer');

/** Streams the baseline fixture first and the leaky one after it. */
function cdpForRun(): FakeCdp {
  const cdp = new FakeCdp();
  let taken = 0;
  cdp.handlers['HeapProfiler.takeHeapSnapshot'] = () => {
    const text = taken++ === 0 ? BASELINE : AFTER;
    cdp.emit('HeapProfiler.addHeapSnapshotChunk', { chunk: text });
    return {};
  };
  return cdp;
}

let dir: string;
test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-diagnostics-'));
});
test.afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const tempDirOf = (heap: HeapDiagnostics): string | null =>
  (heap as unknown as { tempDir: string | null }).tempDir;

async function fullRun(heap: HeapDiagnostics) {
  await heap.captureBaseline();
  await heap.captureAfter();
  return heap.build();
}

test('outside a test it works in a temporary folder and removes it afterwards', async () => {
  const heap = new HeapDiagnostics(cdpForRun().asSession(), { label: 'no test', timeoutMs: 60_000 });
  await heap.captureBaseline();
  const temp = tempDirOf(heap)!;
  expect(fs.readdirSync(temp)).toEqual(['soak-no-test-baseline.heapsnapshot']);

  await heap.captureAfter();
  const diagnosis = await heap.build();

  expect(diagnosis.note).toBeUndefined();
  expect(diagnosis.detached.map((d) => d.className)).toContain('Detached <div>');
  expect(fs.existsSync(temp)).toBe(false);
});

test('keepSnapshots outside a test has nowhere to attach them, so they go too', async () => {
  const heap = new HeapDiagnostics(cdpForRun().asSession(), {
    label: 'kept',
    timeoutMs: 60_000,
    keepSnapshots: true,
  });
  await heap.captureBaseline();
  const temp = tempDirOf(heap)!;
  await heap.captureAfter();
  const diagnosis = await heap.build();
  expect(diagnosis.snapshots).toBeUndefined();
  expect(fs.existsSync(temp)).toBe(false);
});

test('kept snapshots are attached under a name made from the label, and stay put', async () => {
  const { testInfo, attached } = fakeTestInfo(dir);
  // Nothing in this label survives as a file name, and the first name is taken.
  fs.writeFileSync(path.join(dir, 'soak-run-after.heapsnapshot'), '');
  const heap = new HeapDiagnostics(cdpForRun().asSession(), {
    label: '!!!',
    timeoutMs: 60_000,
    keepSnapshots: true,
    testInfo,
  });
  const diagnosis = await fullRun(heap);
  await heap.discard();

  expect(diagnosis.snapshots).toEqual({
    baseline: path.join(dir, 'soak-run-2-baseline.heapsnapshot'),
    after: path.join(dir, 'soak-run-2-after.heapsnapshot'),
  });
  expect(attached.map((a) => a.name)).toEqual(['soak-heap-baseline', 'soak-heap-after']);
  expect(fs.existsSync(diagnosis.snapshots!.after)).toBe(true);
});

test('when attaching fails, the snapshots are deleted rather than left behind', async () => {
  const { testInfo } = fakeTestInfo(dir, {
    attach: async () => {
      throw new Error('attachments are closed');
    },
  });
  const heap = new HeapDiagnostics(cdpForRun().asSession(), {
    label: 'unattached',
    timeoutMs: 60_000,
    keepSnapshots: true,
    testInfo,
  });
  const diagnosis = await fullRun(heap);
  expect(diagnosis.snapshots).toBeUndefined();
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('the second snapshot without a first is a note, not a crash', async () => {
  const heap = new HeapDiagnostics(cdpForRun().asSession(), { label: 'out of order', timeoutMs: 60_000 });
  await heap.captureAfter();
  expect((await heap.build()).note).toBe('Diagnosis stopped: the baseline snapshot was not taken');
});

test('a diff with no snapshots at all is a note too', async () => {
  const heap = new HeapDiagnostics(cdpForRun().asSession(), { label: 'nothing', timeoutMs: 60_000 });
  expect(await heap.build()).toEqual({
    detached: [],
    objects: [],
    note: 'Diagnosis stopped: both snapshots are needed for a diff',
  });
});

test('a failure that is not an Error still reads as a note', async () => {
  const cdp = cdpForRun();
  cdp.handlers['HeapProfiler.enable'] = () => Promise.reject('the target crashed');
  const heap = new HeapDiagnostics(cdp.asSession(), { label: 'crashed', timeoutMs: 60_000 });
  expect((await fullRun(heap)).note).toBe('Diagnosis stopped: the target crashed');
});

test('a folder that disappears mid-write stops the diagnosis with the reason', async () => {
  const cdp = cdpForRun();
  const { testInfo } = fakeTestInfo(dir);
  // Gone between the folder being made and the file being opened.
  cdp.handlers['HeapProfiler.collectGarbage'] = () => fs.rmSync(dir, { recursive: true, force: true });
  const take = cdp.handlers['HeapProfiler.takeHeapSnapshot']!;
  cdp.handlers['HeapProfiler.takeHeapSnapshot'] = async () => {
    // Long enough for the file to fail to open before any chunk is written.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return take();
  };
  const heap = new HeapDiagnostics(cdp.asSession(), { label: 'vanished', timeoutMs: 60_000, testInfo });
  const diagnosis = await fullRun(heap);
  expect(diagnosis.note).toMatch(/^Diagnosis stopped: ENOENT/);
});

test('a snapshot that never finishes runs into the time limit', async () => {
  const cdp = cdpForRun();
  cdp.handlers['HeapProfiler.takeHeapSnapshot'] = () => new Promise(() => { });
  const heap = new HeapDiagnostics(cdp.asSession(), { label: 'stuck', timeoutMs: 50 });
  expect((await fullRun(heap)).note).toBe(
    'Diagnosis stopped: Taking a heap snapshot ran past diagnoseTimeout',
  );
});

test('with no time left at the start, it names whichever limit ran out', async () => {
  const own = new HeapDiagnostics(cdpForRun().asSession(), { label: 'own', timeoutMs: 0 });
  expect((await fullRun(own)).note).toBe('Diagnosis stopped after 0ms (diagnoseTimeout).');

  const test = new HeapDiagnostics(cdpForRun().asSession(), {
    label: 'test',
    timeoutMs: 60_000,
    testTimeLeftMs: () => 0,
  });
  expect((await fullRun(test)).note).toBe(
    'Diagnosis stopped, to leave the test time to finish before its timeout.',
  );
});

test('time that runs out between parsing the two snapshots stops the diff there', async () => {
  const heap = new HeapDiagnostics(cdpForRun().asSession(), { label: 'slow parse', timeoutMs: 60_000 });
  await heap.captureBaseline();
  await heap.captureAfter();

  // Every reading of the clock moves it on a minute, so the first check is already late.
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => realNow() + 60_000 * calls++;
  try {
    expect((await heap.build()).note).toBe(
      'Diagnosis stopped: Parsing the baseline snapshot ran past diagnoseTimeout',
    );
  } finally {
    Date.now = realNow;
  }
});

test('a snapshot too big to read is left unread, with the reason', async () => {
  const { testInfo } = fakeTestInfo(dir);
  const heap = new HeapDiagnostics(cdpForRun().asSession(), { label: 'huge', timeoutMs: 60_000, testInfo });
  await heap.captureBaseline();
  await heap.captureAfter();
  // A sparse file reports the size without taking up the disk.
  fs.truncateSync(path.join(dir, 'soak-huge-after.heapsnapshot'), 2 ** 40);

  const diagnosis = await heap.build();
  expect(diagnosis.note).toMatch(/^Diagnosis stopped: a snapshot of 1048576MB is over the/);
  expect(fs.readdirSync(dir)).toEqual([]);
});
