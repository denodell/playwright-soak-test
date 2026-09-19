// Reads a pair of heap snapshots and turns "+7,800 nodes" into a class name and
// the chain of things still pointing at it. Nothing here touches the disk or the
// browser, so it can be tested against a fixture on its own.

import {
  detachedClassOf,
  HeapSnapshot,
  ROOT_NODE,
  type RetainerStep,
} from './heap-snapshot.js';
import type {
  SoakDetachedClass,
  SoakDiagnosis,
  SoakGrowth,
  SoakRetainerHop,
} from './types.js';

// One leak usually spans several classes, and each needs a path before they can
// be grouped, so walk more than the three the report prints.
const RETAINER_PATHS = 12;

const GROWTH_NAMES = 5;

/** A growth of one is too easy to hit by chance. */
const GROWTH_FLOOR = 2;

// `installSoakClock` keeps pending timers inside the injected clock, so the path
// to a leaked timer runs through Playwright's objects rather than your app's.
// Matched by name, so this needs updating if `page.clock` changes.
const CLOCK_ANCHOR = '__pwClock';

/**
 * What the chain prints in place of the injected clock's own objects. Only the
 * wording: the report finds these hops by their `kind`, so this can be reworded.
 */
const PENDING_TIMER = 'a pending timer';

/** The name to count a node under, or null for V8's own objects, which come and go. */
export function growthNameOf(snapshot: HeapSnapshot, node: number): string | null {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);

  if (type === 'closure') return `closure ${name || '(anonymous)'}`;
  if (type !== 'object') return null;
  if (!name || name.startsWith('system /') || name.startsWith('(')) return null;
  if (detachedClassOf(snapshot, node) !== null) return null;

  return name;
}

/**
 * Everything the diff needs from the baseline snapshot: counts by name, and the
 * node ids behind each detached class. Small enough to keep while the second
 * snapshot is parsed, which is the point of having it.
 */
export interface BaselineDigest {
  detached: Map<string, number>;
  growth: Map<string, number>;
  detachedIds: Map<string, Set<number>>;
}

function countNames(snapshot: HeapSnapshot, collectIds: boolean): BaselineDigest {
  const detached = new Map<string, number>();
  const growth = new Map<string, number>();
  const detachedIds = new Map<string, Set<number>>();

  for (let node = 0; node < snapshot.nodeCount; node++) {
    const className = detachedClassOf(snapshot, node);
    if (className !== null) {
      detached.set(className, (detached.get(className) ?? 0) + 1);
      if (collectIds) {
        let ids = detachedIds.get(className);
        if (!ids) detachedIds.set(className, (ids = new Set()));
        ids.add(snapshot.nodeId(node));
      }
      continue;
    }
    const name = growthNameOf(snapshot, node);
    if (name !== null) growth.set(name, (growth.get(name) ?? 0) + 1);
  }

  return { detached, growth, detachedIds };
}

/** Reduces the baseline to the digest above, so the snapshot itself can be dropped. */
export function digestBaseline(baseline: HeapSnapshot): BaselineDigest {
  return countNames(baseline, true);
}

// Blink puts these between a listener and the function it calls. Every
// registration goes through the same ones, so they lengthen the chain without
// naming anything in your code. `EventListener` stays: it tells you the
// reference came from a listener.
const PLUMBING = new Set(['InternalNode', 'V8EventListener', 'Detached InternalNode']);

/**
 * Contexts, backing stores and the root buckets. Real links in the chain, but
 * there is nothing in your code to change at any of them, so they collapse and
 * give their edge name to the node above.
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
 * detached element, and it points at DevTools rather than at your app.
 */
function isDetachedGrouping(snapshot: HeapSnapshot, node: number): boolean {
  const name = snapshot.nodeName(node);
  return name.startsWith('Detached DOM tree') || name.startsWith('(Detached');
}

/**
 * V8's own root buckets, `(GC roots)` and `(Global handles)` among them. A
 * wrapper held by a global handle is two or three hops from the root, which
 * beats any route through your own code on hop count, and `isBookkeeping` then
 * collapses the lot and leaves the element on its own. DevTools has the same
 * problem and looks for a path through the page first.
 */
function isSyntheticRoot(snapshot: HeapSnapshot, node: number): boolean {
  return snapshot.nodeType(node) === 'synthetic';
}

function describeNode(snapshot: HeapSnapshot, node: number): string {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);
  if (type === 'closure') return `closure ${name || '(anonymous)'}`;
  return name.replace(/ \/ \w+:\/\/\S*$/, '') || `(${type})`;
}

/**
 * Root first, leaked object last. A collapsed hop gives its edge name to the node
 * above it, so a closure keeps the name of the variable it captured.
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
    // A DOM wrapper and the JS object behind it share a name, so the chain would
    // otherwise read `Window, Window`.
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

  return collapseClock(dropModuleWrapper(dropAnonymous(hops)));
}

/**
 * An object literal has no name, so a hop through one prints as `Object`.
 * Skipping it keeps each surviving hop's own edge, which turns
 * `window .__drawer-> Object .open-> fn` into `window.__drawer -> fn`.
 */
function dropAnonymous(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  return hops.filter((hop, i) => hop.node !== 'Object' || i === hops.length - 1);
}

/**
 * A code-split chunk sits between the file that imported it and anything the
 * imported one holds: the namespace object, then the module's own scope. Neither
 * is yours to change, and the name worth keeping is the variable the scope
 * holds, so it moves up to the hop above, which is in your code.
 */
function dropModuleWrapper(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  const out: SoakRetainerHop[] = [];

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    if (hop.node !== 'Module') {
      out.push(hop);
      continue;
    }

    // A `Generator` on its own can be a suspended async function worth seeing,
    // so only the one a module holds goes with it.
    let end = i;
    if (hops[end + 1]?.node === 'Generator') end++;

    const carried = hops[end]!.edge;
    const previous = out.pop();
    if (previous) out.push(carried ? { node: previous.node, edge: carried } : { node: previous.node });
    i = end;
  }

  return out;
}

/** Folds the injected clock into one hop, stopping at your own callback. */
function collapseClock(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  const start = hops.findIndex((h) => h.edge?.name === CLOCK_ANCHOR);
  if (start < 0) return hops;

  let end = start;
  while (end + 1 < hops.length && !isAppCode(hops[end + 1]!.node)) end++;

  const last = hops[end]!;
  const timer: SoakRetainerHop = last.edge
    ? { node: PENDING_TIMER, kind: 'timer', edge: last.edge }
    : { node: PENDING_TIMER, kind: 'timer' };
  return [...hops.slice(0, start), timer, ...hops.slice(end + 1)];
}

function isAppCode(node: string): boolean {
  return node.startsWith('closure ') || node.startsWith('<');
}

/** Keeps the edge only when its name is something you would find in your source. */
function namedEdge(
  snapshot: HeapSnapshot,
  holder: number,
  edge: RetainerStep['edge'],
): SoakRetainerHop['edge'] {
  if (!edge) return undefined;
  if (edge.type === 'element') {
    // Between two DOM nodes this index is Blink's own tree order rather than
    // anything your code wrote, so the index is not worth printing.
    if (snapshot.nodeType(holder) === 'native') return undefined;
    return { type: 'element', name: edge.name };
  }
  if (edge.type === 'property' || edge.type === 'shortcut') return { type: 'property', name: edge.name };
  if (edge.type === 'context') return { type: 'context', name: edge.name };
  return undefined;
}

/** Prefers a node that wasn't in the baseline, so the path leads to something this run made. */
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

export function pathForClass(
  after: HeapSnapshot,
  baselineIds: Map<string, Set<number>>,
  className: string,
): SoakRetainerHop[] {
  const node = representativeNode(after, baselineIds.get(className), className);
  if (node === null) return [];

  // Each attempt bans a shortcut that wins on hop count but says nothing about
  // your code. Most classes come back on the first one, and the last takes
  // whatever reaches the root.
  const attempts: Array<((holder: number) => boolean) | null> = [
    (holder) => isDetachedGrouping(after, holder) || isSyntheticRoot(after, holder),
    (holder) => isDetachedGrouping(after, holder),
    null,
  ];

  for (const skipRetainer of attempts) {
    const steps = after.retainerPath(node, skipRetainer ? { skipRetainer } : {});
    if (steps) return buildRetainerPath(after, steps);
  }
  return [];
}

/** Both snapshots in memory at once. `diffDigest` is the one the runner uses. */
export function diffSnapshots(
  baseline: HeapSnapshot,
  after: HeapSnapshot,
  options: { outOfTime?: () => boolean } = {},
): SoakDiagnosis {
  return diffDigest(digestBaseline(baseline), after, options);
}

export function diffDigest(
  before: BaselineDigest,
  after: HeapSnapshot,
  { outOfTime }: { outOfTime?: () => boolean } = {},
): SoakDiagnosis {
  const now = countNames(after, false);

  const detached: SoakDetachedClass[] = [];
  for (const [className, count] of now.detached) {
    const was = before.detached.get(className) ?? 0;
    if (count - was > 0) {
      detached.push({ className, baseline: was, after: count, delta: count - was, retainerPath: [] });
    }
  }
  detached.sort((a, b) => b.delta - a.delta);

  let ranOut = false;
  for (const entry of detached.slice(0, RETAINER_PATHS)) {
    // Each walk is a pass over the whole graph, so on a big snapshot the budget
    // can run out partway down the list.
    if (outOfTime?.()) {
      ranOut = true;
      break;
    }
    entry.retainerPath = pathForClass(after, before.detachedIds, entry.className);
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
