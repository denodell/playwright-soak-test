/**
 * Turns two heap snapshots into an answer to "what is leaking, and who is
 * holding it".
 *
 * The counts a soak run watches say a leak exists. They cannot say what kind,
 * because `Nodes` and `JSEventListeners` are totals with no names attached. A
 * heap snapshot has the names, so taking one at the baseline pass and another
 * at the end, then diffing them by node name, turns "+7,800 nodes" into
 * "+2,340 Detached HTMLDivElement, held by a resize listener on window".
 */

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

/**
 * Detached classes we walk a retainer path for. One leak usually shows up as
 * several classes -- a container and its contents -- and they are only groupable
 * back into one finding if each has a path, so this is well above the three the
 * report shows. The reverse index is built once and shared, so each extra walk
 * is a breadth-first pass rather than another parse.
 */
const RETAINER_PATHS = 12;

/** Growing JS names carried in the result. */
const GROWTH_NAMES = 5;

/** One more of something is a coincidence, not a trend. */
const GROWTH_FLOOR = 2;

/**
 * `installSoakClock` injects Playwright's clock, which stores pending timers in
 * its own object graph. A timer that was never cleared is therefore reached
 * through our plumbing rather than the app's, and reporting `ClockController` to
 * someone debugging their own code is worse than useless. The run collapses to
 * what it means: a pending timer. Kept in step with `page.clock` by name.
 */
const CLOCK_ANCHOR = '__pwClock';
const PENDING_TIMER = 'a pending timer';

const BASELINE_FILE = 'baseline';
const AFTER_FILE = 'after';

// ------------------------------------------------------------------ counting

/**
 * The name a growing JS object is reported under. Closures are named for their
 * function, so a listener that is never removed shows up as the line of code
 * that registered it. Anything V8 keeps for itself is left out: it moves for
 * reasons that have nothing to do with the flow under test.
 */
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

// ------------------------------------------------------------ retainer paths

/**
 * Blink's own plumbing between a listener and the function it calls. Every
 * registration goes through the same nodes, so they add hops without adding
 * anything a reader can act on. `EventListener` survives, since that one says
 * how the reference was made.
 */
const PLUMBING = new Set(['InternalNode', 'V8EventListener', 'Detached InternalNode']);

/**
 * Nodes that exist so the snapshot can describe itself: contexts, backing
 * stores, the root buckets. They are real links in the chain but they are never
 * the answer, so they collapse and hand their edge name to the node above.
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
 * DevTools groups detached wrappers under a tree node so the Memory panel can
 * list them. That node is rooted, so it is the shortest path back from every
 * detached element and it tells you nothing. Walking past it finds the code.
 */
function isDetachedGrouping(snapshot: HeapSnapshot, node: number): boolean {
  const name = snapshot.nodeName(node);
  return name.startsWith('Detached DOM tree') || name.startsWith('(Detached');
}

function describeNode(snapshot: HeapSnapshot, node: number): string {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);
  if (type === 'closure') return `closure ${name || '(anonymous)'}`;
  // `Window / https://example.com` and `Document / https://example.com` say the
  // page's own address back to it, which is the one thing a reader already knows.
  return name.replace(/ \/ \w+:\/\/\S*$/, '') || `(${type})`;
}

/**
 * The chain as something a reader can act on, root first and the leaked object
 * last. Bookkeeping hops collapse, and the edge name from the lowest collapsed
 * hop moves up to the node that survives, so a closure keeps the variable it
 * captured.
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
    // A DOM wrapper and the JS object behind it are two nodes with one name, so
    // the chain would otherwise read `... Window, Window`.
    if (name === previous) {
      carried = null;
      continue;
    }

    kept.push({ name, edge: namedEdge(snapshot, step.node, carried ?? step.edge) });
    previous = name;
    carried = null;
  }

  // Reversing leaves each hop holding the edge to the hop after it, which is the
  // direction the report reads in.
  const hops: SoakRetainerHop[] = kept
    .reverse()
    .map(({ name, edge }) => (edge ? { node: name, edge } : { node: name }));

  return collapseClock(dropAnonymous(hops));
}

/**
 * An object literal has no name of its own, so a hop through one reads as
 * `Object` and says nothing. Skipping it keeps each surviving hop's own edge,
 * which is a real property of that hop: `window .__drawer-> Object .open-> fn`
 * becomes `window.__drawer -> fn`, and the anchor stays the one worth searching.
 */
function dropAnonymous(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  return hops.filter((hop, i) => hop.node !== 'Object' || i === hops.length - 1);
}

/**
 * Everything from the hop that reaches the injected clock up to the app's own
 * callback is our plumbing, so it becomes one hop. The app's callback is the
 * first closure or element after it, which is where the app's code starts again.
 */
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

/** The edge, when it names something a reader could search for. */
function namedEdge(
  snapshot: HeapSnapshot,
  holder: number,
  edge: RetainerStep['edge'],
): SoakRetainerHop['edge'] {
  if (!edge) return undefined;
  if (edge.type === 'element') {
    // An index into a JS array points at the entry that is holding on. The same
    // edge between two DOM nodes is Blink's own tree order, and saying
    // "element 7" about a sibling helps nobody.
    if (snapshot.nodeType(holder) === 'native') return undefined;
    return { type: 'element', name: edge.name };
  }
  if (edge.type === 'property' || edge.type === 'shortcut') return { type: 'property', name: edge.name };
  if (edge.type === 'context') return { type: 'context', name: edge.name };
  return undefined;
}

/**
 * A node of `className` that was not in the baseline, so the path leads to
 * something this run created rather than something the page always had. Falls
 * back to any node of that class when ids cannot be told apart.
 */
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

  // The grouping node is skipped first, since the path through it is always the
  // shortest and never useful. If nothing else reaches the root, take it.
  const steps =
    after.retainerPath(node, { skipRetainer: (holder) => isDetachedGrouping(after, holder) }) ??
    after.retainerPath(node);

  return steps ? buildRetainerPath(after, steps) : [];
}

// -------------------------------------------------------------------- diffing

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
      // Each walk is a breadth-first pass over the whole graph, so on a big
      // snapshot the budget can run out partway through the list.
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

// ------------------------------------------------------------------ capturing

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  // The loser of the race keeps running, so its rejection is swallowed rather
  // than left to surface as an unhandled one after we have moved on.
  work.catch(() => { });
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} ran past diagnoseTimeoutMs`)), ms);
  });
  return Promise.race([work, guard]).finally(() => clearTimeout(timer));
}

/**
 * A snapshot straight to disk. The chunks arrive as strings over CDP and a real
 * app's snapshot runs to hundreds of megabytes, so they are appended as they
 * come rather than joined into one string first.
 */
async function captureSnapshot(cdp: CDPSession, file: string, timeoutMs: number): Promise<void> {
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');

  const stream = fs.createWriteStream(file);
  // A write that fails, on a full disk or into an output directory that has been
  // removed, emits `error`. An unhandled one on a stream is an uncaughtException,
  // which takes the Playwright worker down rather than leaving a note, so it is
  // collected here and rethrown where the caller can turn it into one.
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
 * test title, so the names would collide: the second run would write over the
 * first run's snapshots and then, if it passed, delete the files the first
 * run's result still points at. The first of a name keeps the plain filename so
 * the usual case stays predictable.
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
  /** Budget for the snapshot work alone. The passes in between do not spend it. */
  timeoutMs: number;
  testInfo?: TestInfo;
}

/**
 * Holds the two snapshots for one run.
 *
 * The baseline has to be taken before anyone knows whether the run fails, so it
 * is taken whenever diagnosis is on at all and thrown away afterwards if it
 * turns out not to be wanted.
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

  /** Runs a stage against the shared budget, recording a note instead of throwing. */
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

  /** Parses, diffs, attaches the snapshots, and hands back what it found. */
  async build(): Promise<SoakDiagnosis> {
    const diff = await this.stage(async (budget) => {
      if (!this.captured.baseline || !this.captured.after) {
        throw new Error('both snapshots are needed for a diff');
      }

      // `JSON.parse` is synchronous and cannot be interrupted, so the budget is
      // checked between the steps instead. That bounds everything except one
      // parse, which is the piece a streaming reader would take over.
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

  /** Attaches both snapshots so they can be dragged into DevTools → Memory. */
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

  /** Drops both files, for a run that passed with `diagnose: 'on-failure'`. */
  async discard(): Promise<void> {
    await Promise.all([
      fsp.rm(this.files.baseline, { force: true }),
      fsp.rm(this.files.after, { force: true }),
    ]).catch(() => { });
    if (this.tempDir) await fsp.rm(this.tempDir, { recursive: true, force: true }).catch(() => { });
  }
}
