// Takes the two heap snapshots over CDP, streams them to disk, and hands the
// pair to the diff. Everything that touches the browser, the clock or the file
// system lives here; `heap-analysis.ts` holds the reading of them.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import type { CDPSession, TestInfo } from '@playwright/test';
import { diffDigest, digestBaseline } from './heap-analysis.js';
import { parseHeapSnapshot } from './heap-snapshot.js';
import type { SoakDiagnosis } from './types.js';

// Parsing a snapshot takes roughly four times the file size in heap, and the
// text stays alive alongside the parsed form while `JSON.parse` runs.
const PARSE_HEAP_FACTOR = 5;

// The rest of the worker needs the other half: the page, the fixtures, and
// whatever the test is holding.
const HEAP_SHARE = 0.5;

const BASELINE_FILE = 'baseline';
const AFTER_FILE = 'after';

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // Whichever promise loses the race keeps running, so catch its rejection here.
  // Otherwise it surfaces as an unhandled rejection later.
  work.catch(() => { });
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ran past diagnoseTimeoutMs`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/** Streamed to disk as the chunks arrive. A real app's snapshot runs to hundreds of megabytes. */
async function captureSnapshot(cdp: CDPSession, file: string, timeoutMs: number): Promise<void> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');

  const stream = fs.createWriteStream(file);
  // A write can fail on a full disk, or into an output directory that has gone
  // away. An unhandled `error` on a stream becomes an uncaughtException, which
  // takes the Playwright worker down instead of leaving you a note.
  const failures: Error[] = [];
  stream.on('error', (error: Error) => void failures.push(error));

  // CDP has no way to pause the chunks, so a slow disk buffers them in memory
  // rather than applying backpressure. Nothing to do about it here.
  const onChunk = (payload: { chunk: string }): void => {
    if (!failures.length) stream.write(payload.chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);

  try {
    await withTimeout(
      cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }),
      timeoutMs,
      'Taking a heap snapshot',
    );
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    if (failures.length) stream.destroy();
    else await new Promise<void>((resolve) => stream.end(() => resolve()));
  }

  if (failures[0]) throw failures[0];
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'run';
}

const snapshotFile = (dir: string, stem: string, which: string): string =>
  path.join(dir, `${stem}-${which}.heapsnapshot`);

/**
 * Two runs in one test share an output directory, and the label defaults to the
 * test title, so the second run would overwrite the first and then delete files
 * the first result still points at. Asking the directory what is already there
 * settles it without a counter to keep, and also steps around whatever an
 * earlier run of the same test left behind.
 */
async function freeStem(dir: string, label: string): Promise<string> {
  const base = `soak-${slug(label)}`;
  for (let n = 1; ; n++) {
    const stem = n === 1 ? base : `${base}-${n}`;
    const inUse = await Promise.all(
      [BASELINE_FILE, AFTER_FILE].map((which) =>
        fsp.access(snapshotFile(dir, stem, which)).then(() => true, () => false),
      ),
    );
    if (!inUse.some(Boolean)) return stem;
  }
}

/**
 * How big one snapshot can be, given the heap this worker has left. A fixed
 * number cannot work: the same 200MB pair is fine under `--max-old-space-size`
 * of 8GB and fatal under Node's 2GB default.
 */
export function parseBudgetBytes(): number {
  const stats = v8.getHeapStatistics();
  const spare = Math.max(0, stats.heap_size_limit - stats.used_heap_size);
  return (spare * HEAP_SHARE) / PARSE_HEAP_FACTOR;
}

/** Why the pair was left unparsed, or null when they are small enough to read. */
export function oversizeReason(
  bytes: number[],
  { budgetBytes = parseBudgetBytes(), keepSnapshots = false }: OversizeContext = {},
): string | null {
  const biggest = Math.max(...bytes);
  if (biggest <= budgetBytes) return null;
  const mb = (n: number): number => Math.round(n / 1024 / 1024);
  // Nothing was read, so the files are all there is. Whether they survive is the
  // one thing the reader can still change, so the message says which it is.
  const next = keepSnapshots
    ? 'Both are attached, so DevTools → Memory can still open them'
    : 'Set keepSnapshots to attach them, and DevTools → Memory can open them instead';
  return (
    `a snapshot of ${mb(biggest)}MB is over the ${mb(budgetBytes)}MB of heap this worker has`
    + ` left to read one with. ${next}`
  );
}

interface OversizeContext {
  budgetBytes?: number;
  keepSnapshots?: boolean;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface HeapDiagnosticsOptions {
  label: string;
  /** Budget for the snapshot work only. The passes in between don't spend it. */
  timeoutMs: number;
  /** Attach the files rather than deleting them once the diff has read them. */
  keepSnapshots?: boolean;
  testInfo?: TestInfo;
}

/**
 * The baseline snapshot has to be taken before the outcome of the run is known,
 * so it is taken whenever diagnosis is on and thrown away again if it turns out
 * not to be needed.
 */
export class HeapDiagnostics {
  private readonly cdp: CDPSession;
  private readonly options: HeapDiagnosticsOptions;
  private readonly files: { baseline: string; after: string };
  private readonly tempDir: string | null;

  private spentMs = 0;
  private note: string | null = null;
  private captured = { baseline: false, after: false };
  private kept = false;

  private constructor(
    cdp: CDPSession,
    options: HeapDiagnosticsOptions,
    dir: string,
    stem: string,
    temp: boolean,
  ) {
    this.cdp = cdp;
    this.options = options;
    this.tempDir = temp ? dir : null;
    this.files = {
      baseline: snapshotFile(dir, stem, BASELINE_FILE),
      after: snapshotFile(dir, stem, AFTER_FILE),
    };
  }

  static async open(cdp: CDPSession, options: HeapDiagnosticsOptions): Promise<HeapDiagnostics> {
    const dir = options.testInfo
      ? options.testInfo.outputPath()
      : await fsp.mkdtemp(path.join(os.tmpdir(), 'playwright-soak-'));
    await fsp.mkdir(dir, { recursive: true });
    const stem = await freeStem(dir, options.label);
    return new HeapDiagnostics(cdp, options, dir, stem, !options.testInfo);
  }

  private remainingMs(): number {
    return this.options.timeoutMs - this.spentMs;
  }

  /** Runs a stage against the shared budget, leaving a note rather than throwing. */
  private async stage<T>(work: (budgetMs: number) => Promise<T>): Promise<T | null> {
    if (this.note) return null;
    const budget = this.remainingMs();
    if (budget <= 0) {
      this.note = `Diagnosis stopped after ${this.options.timeoutMs}ms (diagnoseTimeoutMs).`;
      return null;
    }
    const startedAt = Date.now();
    try {
      return await work(budget);
    } catch (error) {
      this.note = `Diagnosis stopped: ${reason(error)}`;
      return null;
    } finally {
      this.spentMs += Date.now() - startedAt;
    }
  }

  captureBaseline(): Promise<unknown> {
    return this.stage(async (budget) => {
      await captureSnapshot(this.cdp, this.files.baseline, budget);
      this.captured.baseline = true;
    });
  }

  captureAfter(): Promise<unknown> {
    return this.stage(async (budget) => {
      if (!this.captured.baseline) throw new Error('the baseline snapshot was not taken');
      await captureSnapshot(this.cdp, this.files.after, budget);
      this.captured.after = true;
    });
  }

  async build(): Promise<SoakDiagnosis> {
    const diff = await this.stage(async (budget) => {
      if (!this.captured.baseline || !this.captured.after) {
        throw new Error('both snapshots are needed for a diff');
      }

      // `JSON.parse` is synchronous and can't be interrupted, so the budget is
      // checked between steps instead. Everything except a single parse is bounded.
      const deadline = Date.now() + budget;
      const outOfTime = (): boolean => Date.now() > deadline;
      const guard = (step: string): void => {
        if (outOfTime()) throw new Error(`${step} ran past diagnoseTimeoutMs`);
      };

      const sizes = await Promise.all([
        fsp.stat(this.files.baseline),
        fsp.stat(this.files.after),
      ]);
      const oversize = oversizeReason(sizes.map((stat) => stat.size), {
        keepSnapshots: this.options.keepSnapshots,
      });
      if (oversize) throw new Error(oversize);

      // One snapshot in memory at a time. The baseline is reduced to the counts
      // and ids the diff needs, then goes out of scope before the second file is
      // read, which halves what the worker has to hold at the peak.
      const before = digestBaseline(
        parseHeapSnapshot(await fsp.readFile(this.files.baseline, 'utf8')),
      );
      guard('Parsing the baseline snapshot');

      const after = parseHeapSnapshot(await fsp.readFile(this.files.after, 'utf8'));
      guard('Parsing the second snapshot');

      return diffDigest(before, after, { outOfTime });
    });

    const diagnosis: SoakDiagnosis = diff ?? { detached: [], growth: [] };
    if (this.note) diagnosis.note = this.note;

    // The diff has what it needs by now, so the files only matter to whoever
    // wants to open them in DevTools.
    const attached = this.options.keepSnapshots ? await this.attach() : null;
    if (attached) {
      diagnosis.snapshots = attached;
      this.kept = true;
    } else {
      await this.discard();
    }

    return diagnosis;
  }

  /** Attached so you can open them in DevTools → Memory. */
  private async attach(): Promise<{ baseline: string; after: string } | null> {
    const { testInfo } = this.options;
    if (!testInfo || !this.captured.baseline || !this.captured.after) return null;
    try {
      await testInfo.attach('soak-heap-baseline', {
        path: this.files.baseline,
        contentType: 'application/json',
      });
      await testInfo.attach('soak-heap-after', {
        path: this.files.after,
        contentType: 'application/json',
      });
      return { baseline: this.files.baseline, after: this.files.after };
    } catch {
      return null;
    }
  }

  /**
   * Safe to call again after `build`, so the runner can put it in a `finally`
   * without tracking whether the snapshots were wanted in the end.
   */
  async discard(): Promise<void> {
    if (this.kept) return;
    await Promise.all([
      fsp.rm(this.files.baseline, { force: true }),
      fsp.rm(this.files.after, { force: true }),
    ]).catch(() => { });
    if (this.tempDir) await fsp.rm(this.tempDir, { recursive: true, force: true }).catch(() => { });
  }
}
