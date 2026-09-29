import { constants as bufferConstants } from 'node:buffer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import type { CDPSession, TestInfo } from '@playwright/test';
import { diffDigest, digestBaseline } from './heap-analysis.js';
import { parseHeapSnapshot } from './heap-snapshot.js';
import type { SoakDiagnosis } from './types.js';

// About four times the file size to parse, plus the text itself while `JSON.parse` runs.
const PARSE_HEAP_FACTOR = 5;

// The page, the fixtures and the test need the other half.
const HEAP_SHARE = 0.5;

// Node can't read a longer file into one string, however much heap is left.
const MAX_TEXT_BYTES = bufferConstants.MAX_STRING_LENGTH;

const BASELINE_FILE = 'baseline';
const AFTER_FILE = 'after';

/** Time a stage may take, and the name of the limit that set it. */
interface Budget {
  ms: number;
  limit: string;
}

function withTimeout<T>(work: Promise<T>, { ms, limit }: Budget, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // The losing promise keeps running, so its rejection is caught here or it goes unhandled.
  work.catch(() => { });
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ran past ${limit}`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/** Streamed to disk, since a real app's snapshot runs to hundreds of megabytes. */
async function captureSnapshot(cdp: CDPSession, file: string, budget: Budget): Promise<void> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');

  const stream = fs.createWriteStream(file);
  // A write can fail on a full disk or a deleted directory, and an unhandled stream
  // `error` would take the Playwright worker down.
  const failures: Error[] = [];
  stream.on('error', (error: Error) => void failures.push(error));

  // CDP can't pause the chunks, so a slow disk buffers them in memory.
  const onChunk = (payload: { chunk: string }): void => {
    if (!failures.length) stream.write(payload.chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);

  try {
    await withTimeout(
      cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }),
      budget,
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

/** Two runs in one test share a label and a directory, so this picks a name not already taken. */
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

/** Largest snapshot this worker can parse, from the heap it has left. */
export function parseBudgetBytes(): number {
  const stats = v8.getHeapStatistics();
  const spare = Math.max(0, stats.heap_size_limit - stats.used_heap_size);
  return (spare * HEAP_SHARE) / PARSE_HEAP_FACTOR;
}

/** Why the pair was left unparsed, or null when they are small enough to read. */
export function oversizeReason(
  bytes: number[],
  {
    budgetBytes = parseBudgetBytes(),
    maxTextBytes = MAX_TEXT_BYTES,
    keepSnapshots = false,
  }: OversizeContext = {},
): string | null {
  const biggest = Math.max(...bytes);
  const tooLong = biggest > maxTextBytes;
  if (!tooLong && biggest <= budgetBytes) return null;
  const mb = (n: number): number => Math.round(n / 1024 / 1024);
  // More heap doesn't help with the string limit, so that one is named first.
  const limit = tooLong
    ? `the ${mb(maxTextBytes)}MB Node can read into one string`
    : `the ${mb(budgetBytes)}MB of heap this worker has left to read one with`;
  const next = keepSnapshots
    ? 'Both are attached, so DevTools → Memory can still open them'
    : 'Set keepSnapshots to attach them, and DevTools → Memory can open them instead';
  return `a snapshot of ${mb(biggest)}MB is over ${limit}. ${next}`;
}

interface OversizeContext {
  budgetBytes?: number;
  maxTextBytes?: number;
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
  /**
   * Time left before the test's own timeout, less what the report needs. Without
   * it, a slow diagnosis could turn a leak report into a test timeout.
   */
  testTimeLeftMs?: () => number;
}

const TEST_TIMEOUT = "the test's timeout";

export class HeapDiagnostics {
  private readonly cdp: CDPSession;
  private readonly options: HeapDiagnosticsOptions;
  private files: { baseline: string; after: string } | null = null;
  private tempDir: string | null = null;

  private spentMs = 0;
  private note: string | null = null;
  private captured = { baseline: false, after: false };
  private kept = false;

  constructor(cdp: CDPSession, options: HeapDiagnosticsOptions) {
    this.cdp = cdp;
    this.options = options;
  }

  // Called inside a stage, so a folder that can't be written leaves a note, not a failed run.
  private async prepareFiles(): Promise<{ baseline: string; after: string }> {
    const { testInfo, label } = this.options;
    let dir: string;
    if (testInfo) {
      dir = testInfo.outputPath();
      await fsp.mkdir(dir, { recursive: true });
    } else {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'playwright-soak-'));
      this.tempDir = dir;
    }
    const stem = await freeStem(dir, label);
    return {
      baseline: snapshotFile(dir, stem, BASELINE_FILE),
      after: snapshotFile(dir, stem, AFTER_FILE),
    };
  }

  private budget(): Budget {
    const own = this.options.timeoutMs - this.spentMs;
    const test = this.options.testTimeLeftMs?.() ?? Infinity;
    return test < own ? { ms: test, limit: TEST_TIMEOUT } : { ms: own, limit: 'diagnoseTimeout' };
  }

  /** Runs a stage against the shared budget, leaving a note rather than throwing. */
  private async stage<T>(work: (budget: Budget) => Promise<T>): Promise<T | null> {
    if (this.note) return null;
    const budget = this.budget();
    if (budget.ms <= 0) {
      this.note = budget.limit === TEST_TIMEOUT
        ? 'Diagnosis stopped, to leave the test time to finish before its timeout.'
        : `Diagnosis stopped after ${this.options.timeoutMs}ms (diagnoseTimeout).`;
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
      this.files = await this.prepareFiles();
      await captureSnapshot(this.cdp, this.files.baseline, budget);
      this.captured.baseline = true;
    });
  }

  captureAfter(): Promise<unknown> {
    return this.stage(async (budget) => {
      if (!this.files || !this.captured.baseline) {
        throw new Error('the baseline snapshot was not taken');
      }
      await captureSnapshot(this.cdp, this.files.after, budget);
      this.captured.after = true;
    });
  }

  async build(): Promise<SoakDiagnosis> {
    const diff = await this.stage(async (budget) => {
      const { files } = this;
      if (!files || !this.captured.baseline || !this.captured.after) {
        throw new Error('both snapshots are needed for a diff');
      }

      // `JSON.parse` can't be interrupted, so the time limit is checked between steps.
      const deadline = Date.now() + budget.ms;
      const outOfTime = (): boolean => Date.now() > deadline;
      const guard = (step: string): void => {
        if (outOfTime()) throw new Error(`${step} ran past ${budget.limit}`);
      };

      const sizes = await Promise.all([
        fsp.stat(files.baseline),
        fsp.stat(files.after),
      ]);
      const oversize = oversizeReason(sizes.map((stat) => stat.size), {
        keepSnapshots: this.options.keepSnapshots,
      });
      if (oversize) throw new Error(oversize);

      // The baseline is reduced to a digest first, so only one snapshot is in memory at a time.
      const before = digestBaseline(
        parseHeapSnapshot(await fsp.readFile(files.baseline, 'utf8')),
      );
      guard('Parsing the baseline snapshot');

      const after = parseHeapSnapshot(await fsp.readFile(files.after, 'utf8'));
      guard('Parsing the second snapshot');

      return diffDigest(before, after, { outOfTime, limit: budget.limit });
    });

    const diagnosis: SoakDiagnosis = diff ?? { detached: [], objects: [] };
    if (this.note) diagnosis.note = this.note;

    const attached = this.options.keepSnapshots ? await this.attach() : null;
    if (attached) {
      diagnosis.snapshots = attached;
      this.kept = true;
    } else {
      await this.discard();
    }

    return diagnosis;
  }

  private async attach(): Promise<{ baseline: string; after: string } | null> {
    const { testInfo } = this.options;
    const { files } = this;
    if (!testInfo || !files || !this.captured.baseline || !this.captured.after) return null;
    try {
      await testInfo.attach('soak-heap-baseline', {
        path: files.baseline,
        contentType: 'application/json',
      });
      await testInfo.attach('soak-heap-after', {
        path: files.after,
        contentType: 'application/json',
      });
      return { baseline: files.baseline, after: files.after };
    } catch {
      return null;
    }
  }

  /** Safe to call more than once. */
  async discard(): Promise<void> {
    if (this.kept) return;
    if (this.files) {
      await Promise.all([
        fsp.rm(this.files.baseline, { force: true }),
        fsp.rm(this.files.after, { force: true }),
      ]).catch(() => { });
    }
    if (this.tempDir) await fsp.rm(this.tempDir, { recursive: true, force: true }).catch(() => { });
  }
}
