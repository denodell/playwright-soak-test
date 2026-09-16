// Diffs two heap snapshots by node name, so "+7,800 nodes" turns into a class
// name and the chain of things still pointing at it.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CDPSession, TestInfo } from '@playwright/test';
import {
  detachedClassOf,
  HeapSnapshot,
  parseHeapSnapshot,
  ROOT_NODE,
  type RetainerStep,
} from './heap-snapshot.js';
import type {
  SoakDetachedClass,
  SoakDiagnosis,
  SoakGrowth,
  SoakRetainerHop,
} from './types.js';

// One leak usually spans several classes, and they only group back into a
// single finding if each of them has a path, so this sits well above the three
// the report goes on to show.
const RETAINER_PATHS = 12;

/** How many growing JS names the result carries. */
const GROWTH_NAMES = 5;

/** One more of something is a coincidence, so growth starts at two. */
const GROWTH_FLOOR = 2;

// `installSoakClock` keeps pending timers in the injected clock's own object
// graph, so a leaked timer is reached through the clock's objects rather than
// through anything your app wrote. Matched by name, so it wants keeping in step
// with `page.clock`.
const CLOCK_ANCHOR = '__pwClock';
const PENDING_TIMER = 'a pending timer';

const BASELINE_FILE = 'baseline';
const AFTER_FILE = 'after';

/** V8's own objects move for reasons that have nothing to do with your flow. */
export function growthNameOf(snapshot: HeapSnapshot, node: number): string | null {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);

  if (type === 'closure') return `closure ${name || '(anonymous)'}`;
  if (type !== 'object') return null;
  if (!name || name.startsWith('system /') || name.startsWith('(')) return null;
  if (detachedClassOf(snapshot, node) !== null) return null;

  return name;
}

interface NameCounts {
  detached: Map<string, number>;
  growth: Map<string, number>;
}

function countNames(snapshot: HeapSnapshot): NameCounts {
  const detached = new Map<string, number>();
  const growth = new Map<string, number>();

  for (let node = 0; node < snapshot.nodeCount; node++) {
    const className = detachedClassOf(snapshot, node);
    if (className !== null) {
      detached.set(className, (detached.get(className) ?? 0) + 1);
      continue;
    }
    const name = growthNameOf(snapshot, node);
    if (name !== null) growth.set(name, (growth.get(name) ?? 0) + 1);
  }

  return { detached, growth };
}

// Blink puts these between a listener and the function it calls, and every
// registration goes through the same ones, so they add hops without adding
// anything you can act on. `EventListener` stays, since that one says how the
// reference was made.
const PLUMBING = new Set(['InternalNode', 'V8EventListener', 'Detached InternalNode']);

/**
 * Contexts, backing stores and the root buckets. They are real links in the
 * chain, but none of them is ever the thing you need to change, so they collapse
 * and hand their edge name to the node above.
 */
function isBookkeeping(snapshot: HeapSnapshot, node: number): boolean {
  if (node === ROOT_NODE) return true;
  const type = snapshot.nodeType(node);
  if (type === 'hidden' || type === 'synthetic') return true;
  const name = snapshot.nodeName(node);
  if (PLUMBING.has(name)) return true;
  return name === '' || name.startsWith('system /') || name.startsWith('(');
}

/**
 * DevTools groups detached wrappers under a tree node so its Memory panel can
 * list them. That node is rooted, so it is the shortest way back from every
 * detached element, and it tells you nothing.
 */
function isDetachedGrouping(snapshot: HeapSnapshot, node: number): boolean {
  const name = snapshot.nodeName(node);
  return name.startsWith('Detached DOM tree') || name.startsWith('(Detached');
}

function describeNode(snapshot: HeapSnapshot, node: number): string {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);
  if (type === 'closure') return `closure ${name || '(anonymous)'}`;
  return name.replace(/ \/ \w+:\/\/\S*$/, '') || `(${type})`;
}

/**
 * Root first and the leaked object last. A collapsed hop hands its edge name to
 * the node above it, so a closure keeps the name of the variable it captured.
 */
export function buildRetainerPath(
  snapshot: HeapSnapshot,
  steps: RetainerStep[],
): SoakRetainerHop[] {
  // `steps` runs leaf first, and each step's edge points at the step before it.
  const kept: Array<{ name: string; edge: SoakRetainerHop['edge'] }> = [];
  let carried: RetainerStep['edge'] = null;
  let previous = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (i > 0 && isBookkeeping(snapshot, step.node)) {
      carried ??= step.edge;
      continue;
    }

    const name = describeNode(snapshot, step.node);
    // A DOM wrapper and the JS object behind it carry one name between them, so
    // the chain would otherwise read `Window, Window`.
    if (name === previous) {
      carried = null;
      continue;
    }

    kept.push({ name, edge: namedEdge(snapshot, step.node, carried ?? step.edge) });
    previous = name;
    carried = null;
  }

  const hops: SoakRetainerHop[] = kept
    .reverse()
    .map(({ name, edge }) => (edge ? { node: name, edge } : { node: name }));

  return collapseClock(dropAnonymous(hops));
}

/**
 * An object literal has no name of its own, so a hop through one reads as
 * `Object` and says nothing. Skipping it keeps each surviving hop's own edge,
 * which turns `window .__drawer-> Object .open-> fn` into `window.__drawer -> fn`.
 */
function dropAnonymous(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  return hops.filter((hop, i) => hop.node !== 'Object' || i === hops.length - 1);
}

/** Folds the injected clock into one hop, stopping at your own callback. */
function collapseClock(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  const start = hops.findIndex((h) => h.edge?.name === CLOCK_ANCHOR);
  if (start < 0) return hops;

  let end = start;
  while (end + 1 < hops.length && !isAppCode(hops[end + 1]!.node)) end++;

  const last = hops[end]!;
  const timer: SoakRetainerHop = last.edge ? { node: PENDING_TIMER, edge: last.edge } : { node: PENDING_TIMER };
  return [...hops.slice(0, start), timer, ...hops.slice(end + 1)];
}

function isAppCode(node: string): boolean {
  return node.startsWith('closure ') || node.startsWith('<');
}

/** The edge, when its name is something you could search your source for. */
function namedEdge(
  snapshot: HeapSnapshot,
  holder: number,
  edge: RetainerStep['edge'],
): SoakRetainerHop['edge'] {
  if (!edge) return undefined;
  if (edge.type === 'element') {
    // Between two DOM nodes this index is Blink's own tree order rather than
    // anything your code wrote, so saying "element 7" about a sibling helps nobody.
    if (snapshot.nodeType(holder) === 'native') return undefined;
    return { type: 'element', name: edge.name };
  }
  if (edge.type === 'property' || edge.type === 'shortcut') return { type: 'property', name: edge.name };
  if (edge.type === 'context') return { type: 'context', name: edge.name };
  return undefined;
}

/** One that wasn't in the baseline, so the path leads to something this run made. */
function representativeNode(
  after: HeapSnapshot,
  baselineIds: Set<number> | undefined,
  className: string,
): number | null {
  let fallback: number | null = null;
  for (let node = 0; node < after.nodeCount; node++) {
    if (detachedClassOf(after, node) !== className) continue;
    fallback ??= node;
    if (!baselineIds?.has(after.nodeId(node))) return node;
  }
  return fallback;
}

function baselineIdsFor(baseline: HeapSnapshot, classNames: string[]): Map<string, Set<number>> {
  const wanted = new Set(classNames);
  const out = new Map<string, Set<number>>();
  for (const name of classNames) out.set(name, new Set());

  for (let node = 0; node < baseline.nodeCount; node++) {
    const className = detachedClassOf(baseline, node);
    if (className === null || !wanted.has(className)) continue;
    out.get(className)!.add(baseline.nodeId(node));
  }
  return out;
}

export function pathForClass(
  after: HeapSnapshot,
  baselineIds: Map<string, Set<number>>,
  className: string,
): SoakRetainerHop[] {
  const node = representativeNode(after, baselineIds.get(className), className);
  if (node === null) return [];

  // DevTools' grouping node is skipped on the first attempt, since the path
  // through it is always the shortest and never the one you want.
  const steps =
    after.retainerPath(node, { skipRetainer: (holder) => isDetachedGrouping(after, holder) }) ??
    after.retainerPath(node);

  return steps ? buildRetainerPath(after, steps) : [];
}

export function diffSnapshots(
  baseline: HeapSnapshot,
  after: HeapSnapshot,
  { outOfTime }: { outOfTime?: () => boolean } = {},
): SoakDiagnosis {
  const before = countNames(baseline);
  const now = countNames(after);

  const detached: SoakDetachedClass[] = [];
  for (const [className, count] of now.detached) {
    const was = before.detached.get(className) ?? 0;
    if (count - was > 0) {
      detached.push({ className, baseline: was, after: count, delta: count - was, retainerPath: [] });
    }
  }
  detached.sort((a, b) => b.delta - a.delta);

  let ranOut = false;
  const topClasses = detached.slice(0, RETAINER_PATHS).map((d) => d.className);
  if (topClasses.length) {
    const ids = baselineIdsFor(baseline, topClasses);
    for (const entry of detached.slice(0, RETAINER_PATHS)) {
      // Each walk is a pass over the whole graph, so on a big snapshot the budget
      // can run out partway down the list.
      if (outOfTime?.()) {
        ranOut = true;
        break;
      }
      entry.retainerPath = pathForClass(after, ids, entry.className);
    }
  }

  const growth: SoakGrowth[] = [];
  for (const [name, count] of now.growth) {
    const delta = count - (before.growth.get(name) ?? 0);
    if (delta >= GROWTH_FLOOR) growth.push({ name, delta });
  }
  growth.sort((a, b) => b.delta - a.delta);

  const diagnosis: SoakDiagnosis = { detached, growth: growth.slice(0, GROWTH_NAMES) };
  if (ranOut) {
    diagnosis.note = 'Diagnosis ran past diagnoseTimeoutMs, so not every chain was walked.';
  }
  return diagnosis;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // The loser of the race carries on, so its rejection is swallowed rather than
  // left to turn up unhandled once the run has moved on.
  work.catch(() => { });
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ran past diagnoseTimeoutMs`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/** Written as the chunks arrive, since a real app's snapshot runs to hundreds of megabytes. */
async function captureSnapshot(cdp: CDPSession, file: string, timeoutMs: number): Promise<void> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');

  const stream = fs.createWriteStream(file);
  // A write can fail on a full disk or into an output directory that has gone
  // away, and an unhandled `error` on a stream is an uncaughtException, which
  // takes the Playwright worker down instead of leaving you a note.
  const failures: Error[] = [];
  stream.on('error', (error: Error) => void failures.push(error));

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

/**
 * Two runs in one test share an output directory, and a label defaults to the
 * test title, so without this the second run writes over the first and can then
 * delete files the first result still points at.
 */
const taken = new Map<string, number>();

function uniqueStem(dir: string, label: string): string {
  const stem = `soak-${slug(label)}`;
  const key = `${dir}\u0000${stem}`;
  const seen = (taken.get(key) ?? 0) + 1;
  taken.set(key, seen);
  return seen === 1 ? stem : `${stem}-${seen}`;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface HeapDiagnosticsOptions {
  label: string;
  /** Budget for the snapshot work alone, since the passes in between don't spend it. */
  timeoutMs: number;
  testInfo?: TestInfo;
}

/**
 * The baseline snapshot has to be taken before anyone knows whether the run
 * fails, so it goes ahead whenever diagnosis is on at all and is thrown away
 * again if it turns out not to be wanted.
 */
export class HeapDiagnostics {
  private readonly cdp: CDPSession;
  private readonly options: HeapDiagnosticsOptions;
  private readonly files: { baseline: string; after: string };
  private readonly tempDir: string | null;

  private spentMs = 0;
  private note: string | null = null;
  private captured = { baseline: false, after: false };

  private constructor(cdp: CDPSession, options: HeapDiagnosticsOptions, dir: string, temp: boolean) {
    this.cdp = cdp;
    this.options = options;
    this.tempDir = temp ? dir : null;
    const stem = uniqueStem(dir, options.label);
    this.files = {
      baseline: path.join(dir, `${stem}-${BASELINE_FILE}.heapsnapshot`),
      after: path.join(dir, `${stem}-${AFTER_FILE}.heapsnapshot`),
    };
  }

  static async open(cdp: CDPSession, options: HeapDiagnosticsOptions): Promise<HeapDiagnostics> {
    const dir = options.testInfo
      ? options.testInfo.outputPath()
      : await fsp.mkdtemp(path.join(os.tmpdir(), 'playwright-soak-'));
    await fsp.mkdir(dir, { recursive: true });
    return new HeapDiagnostics(cdp, options, dir, !options.testInfo);
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

  /** Parses both snapshots, diffs them, attaches them, and returns what it found. */
  async build(): Promise<SoakDiagnosis> {
    const diff = await this.stage(async (budget) => {
      if (!this.captured.baseline || !this.captured.after) {
        throw new Error('both snapshots are needed for a diff');
      }

      // `JSON.parse` is synchronous and can't be interrupted, so the budget is
      // checked between the steps instead. Everything but one parse is bounded.
      const deadline = Date.now() + budget;
      const outOfTime = (): boolean => Date.now() > deadline;
      const guard = (step: string): void => {
        if (outOfTime()) throw new Error(`${step} ran past diagnoseTimeoutMs`);
      };

      const [baselineText, afterText] = await Promise.all([
        fsp.readFile(this.files.baseline, 'utf8'),
        fsp.readFile(this.files.after, 'utf8'),
      ]);
      guard('Reading the snapshots');

      const baseline = parseHeapSnapshot(baselineText);
      guard('Parsing the baseline snapshot');

      const after = parseHeapSnapshot(afterText);
      guard('Parsing the second snapshot');

      return diffSnapshots(baseline, after, { outOfTime });
    });

    const diagnosis: SoakDiagnosis = diff ?? { detached: [], growth: [] };
    if (this.note) diagnosis.note = this.note;

    const attached = await this.attach();
    if (attached) diagnosis.snapshots = attached;
    else await this.discard();

    return diagnosis;
  }

  /** Attaches both, so you can drag them into DevTools → Memory yourself. */
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

  /** Drops both files, which is what a passing `diagnose: 'on-failure'` run wants. */
  async discard(): Promise<void> {
    await Promise.all([
      fsp.rm(this.files.baseline, { force: true }),
      fsp.rm(this.files.after, { force: true }),
    ]).catch(() => { });
    if (this.tempDir) await fsp.rm(this.tempDir, { recursive: true, force: true }).catch(() => { });
  }
}
