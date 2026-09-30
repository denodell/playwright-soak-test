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

// More than the three the report prints, because one leak spans several classes.
const RETAINER_PATHS = 12;

const GROWTH_NAMES = 5;

/** A growth of one is too easy to hit by chance. */
const GROWTH_FLOOR = 2;

// Where `page.clock` keeps pending timers. Breaks if Playwright renames it.
const CLOCK_ANCHOR = '__pwClock';

/** Display text only. The report finds timer hops by their `kind`. */
const PENDING_TIMER = 'a pending timer';

// Keeps a closure and a constructor that share a name apart while they're counted.
const CLOSURE = 'closure ';

/** The name to count a node under, or null for V8's own objects, which come and go. */
export function growthNameOf(snapshot: HeapSnapshot, node: number): string | null {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);

  if (type === 'closure') return `${CLOSURE}${name || '(anonymous)'}`;
  if (type !== 'object') return null;
  if (!name || name.startsWith('system /') || name.startsWith('(')) return null;
  if (detachedClassOf(snapshot, node) !== null) return null;

  return name;
}

/** What the diff needs from the baseline, so the snapshot itself can be dropped. */
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

export function digestBaseline(baseline: HeapSnapshot): BaselineDigest {
  return countNames(baseline, true);
}

// Blink puts these between every listener and its callback. `EventListener` stays,
// since it shows the reference came from a listener.
const PLUMBING = new Set(['InternalNode', 'V8EventListener', 'Detached InternalNode']);

/** Contexts, backing stores and root buckets. They collapse and pass their edge name up. */
function isBookkeeping(snapshot: HeapSnapshot, node: number): boolean {
  if (node === ROOT_NODE) return true;
  const type = snapshot.nodeType(node);
  if (type === 'hidden' || type === 'synthetic') return true;
  const name = snapshot.nodeName(node);
  if (PLUMBING.has(name)) return true;
  return name === '' || name.startsWith('system /') || name.startsWith('(');
}

/** DevTools' rooted grouping node for detached wrappers, the shortest way back from all of them. */
function isDetachedGrouping(snapshot: HeapSnapshot, node: number): boolean {
  const name = snapshot.nodeName(node);
  return name.startsWith('Detached DOM tree') || name.startsWith('(Detached');
}

/** V8's root buckets, like `(Global handles)`, usually closer than any route through the page. */
function isSyntheticRoot(snapshot: HeapSnapshot, node: number): boolean {
  return snapshot.nodeType(node) === 'synthetic';
}

// Kept, in this order, when an element's markup is trimmed. The rest, like `style`, is noise.
const KEPT_ATTRIBUTES = ['id', 'role', 'data-testid', 'aria-label', 'name'];

const MAX_ATTRIBUTE = 30;

/** `<div class="a b c" id="x" style="…">` becomes `<div id="x" class="a …">`. */
export function shortElementName(name: string): string {
  const markup = /^<([a-zA-Z][\w-]*)([^>]*)>$/.exec(name);
  if (!markup) return name;
  const attributes = new Map<string, string>();
  for (const [, key, value] of markup[2]!.matchAll(/([\w:.-]+)="([^"]*)"/g)) {
    attributes.set(key!, value!);
  }

  const clip = (value: string): string =>
    value.length > MAX_ATTRIBUTE ? `${value.slice(0, MAX_ATTRIBUTE - 1)}\u2026` : value;
  const kept = KEPT_ATTRIBUTES.filter((key) => attributes.has(key)).map(
    (key) => `${key}="${clip(attributes.get(key)!)}"`,
  );
  const classes = attributes.get('class')?.split(/\s+/).filter(Boolean) ?? [];
  if (classes.length) {
    kept.push(`class="${clip(classes[0]!)}${classes.length > 1 ? ' \u2026' : ''}"`);
  }

  return kept.length ? `<${markup[1]} ${kept.join(' ')}>` : `<${markup[1]}>`;
}

// Parts of the page itself, which Chrome also reports as its own objects.
const PAGE_NODES = new Set([
  'Text', 'Comment', 'HTMLDocument', 'Document', 'ShadowRoot', 'DocumentFragment', 'Window',
  'EventListener',
]);

/** One of Chrome's own objects, like `StyleEngine`, and not an element or anything of yours. */
function isChromeObject(snapshot: HeapSnapshot, node: number, name: string): boolean {
  return snapshot.nodeType(node) === 'native' && !name.startsWith('<') && !PAGE_NODES.has(name);
}

function describeNode(snapshot: HeapSnapshot, node: number): string {
  const type = snapshot.nodeType(node);
  const name = snapshot.nodeName(node);
  if (type === 'closure') return name || '(anonymous)';
  return shortElementName(name.replace(/ \/ \w+:\/\/\S*$/, '')) || `(${type})`;
}

/** Root first. Collapsed hops pass their edge name up, so a closure keeps its variable's name. */
export function buildRetainerPath(
  snapshot: HeapSnapshot,
  steps: RetainerStep[],
): SoakRetainerHop[] {
  const kept: Array<{
    name: string;
    closure: boolean;
    browser: boolean;
    edge: SoakRetainerHop['edge'];
  }> = [];
  let carried: RetainerStep['edge'] = null;
  let previous = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (i > 0 && isBookkeeping(snapshot, step.node)) {
      carried ??= step.edge;
      continue;
    }

    const name = describeNode(snapshot, step.node);
    const closure = snapshot.nodeType(step.node) === 'closure';
    const browser = isChromeObject(snapshot, step.node, name);
    // A DOM wrapper and the JS object behind it share a name, so the chain would
    // otherwise read `Window, Window`.
    const key = `${closure}:${name}`;
    if (key === previous) {
      carried = null;
      continue;
    }

    const edge = namedEdge(snapshot, step.node, carried ?? step.edge);
    kept.push({ name, closure, browser, edge });
    previous = key;
    carried = null;
  }

  const hops: SoakRetainerHop[] = kept.reverse().map(({ name, closure, browser, edge }) => ({
    node: name,
    ...(closure ? { kind: 'closure' as const } : {}),
    ...(browser ? { kind: 'browser' as const } : {}),
    ...(edge ? { edge } : {}),
  }));

  // The clock is found by its property name, so it's folded before `Object` hops add to that name.
  return dropAnonymous(collapseClock(dropModuleWrapper(hops)));
}

/**
 * Drops hops through unnamed object literals, which print as `Object`. The slot
 * they held the next hop in joins the name above, so `store` then `items` reads
 * `store.items`.
 */
function dropAnonymous(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  const out: SoakRetainerHop[] = [];
  hops.forEach((hop, i) => {
    if (hop.node !== 'Object' || hop.kind || i === hops.length - 1) {
      out.push(hop);
      return;
    }
    const previous = out.at(-1);
    if (!previous?.edge || !hop.edge) return;
    const slot = hop.edge.type === 'element' ? `[${hop.edge.name}]` : `.${hop.edge.name}`;
    out[out.length - 1] = {
      ...previous,
      edge: { type: previous.edge.type, name: `${previous.edge.name}${slot}` },
    };
  });
  return out;
}

/** Drops the namespace object and module scope a code-split chunk adds. */
function dropModuleWrapper(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  const out: SoakRetainerHop[] = [];

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i]!;
    if (hop.node !== 'Module' || hop.kind) {
      out.push(hop);
      continue;
    }

    // A `Generator` on its own can be a suspended async function worth seeing,
    // so only the one a module holds goes with it.
    let end = i;
    const next = hops[end + 1];
    if (next?.node === 'Generator' && !next.kind) end++;

    const carried = hops[end]!.edge;
    const previous = out.pop();
    if (previous) {
      const { edge: _, ...rest } = previous;
      out.push(carried ? { ...rest, edge: carried } : rest);
    }
    i = end;
  }

  return out;
}

/** Folds the injected clock into one hop, stopping at your own callback. */
function collapseClock(hops: SoakRetainerHop[]): SoakRetainerHop[] {
  const start = hops.findIndex((h) => h.edge?.name === CLOCK_ANCHOR);
  if (start < 0) return hops;

  let end = start;
  while (end + 1 < hops.length && !isAppCode(hops[end + 1]!)) end++;

  const last = hops[end]!;
  const timer: SoakRetainerHop = last.edge
    ? { node: PENDING_TIMER, kind: 'timer', edge: last.edge }
    : { node: PENDING_TIMER, kind: 'timer' };
  return [...hops.slice(0, start), timer, ...hops.slice(end + 1)];
}

function isAppCode(hop: SoakRetainerHop): boolean {
  return hop.kind === 'closure' || hop.node.startsWith('<');
}

/** Keeps the edge only when its name is something you would find in your source. */
function namedEdge(
  snapshot: HeapSnapshot,
  holder: number,
  edge: RetainerStep['edge'],
): SoakRetainerHop['edge'] {
  if (!edge) return undefined;
  if (edge.type === 'element') {
    // Between two DOM nodes the index is Blink's tree order, not anything your code wrote.
    if (snapshot.nodeType(holder) === 'native') return undefined;
    return { type: 'element', name: edge.name };
  }
  if (edge.type === 'property' || edge.type === 'shortcut') {
    // Chrome's own symbol-keyed slots, like `<symbol Window#DocumentCachedAccessor>`.
    if (edge.name.startsWith('<symbol')) return undefined;
    return { type: 'property', name: edge.name };
  }
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

  // Each attempt bans a shortcut that wins on hop count. The last allows anything.
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
  options: DiffOptions = {},
): SoakDiagnosis {
  return diffDigest(digestBaseline(baseline), after, options);
}

interface DiffOptions {
  outOfTime?: () => boolean;
  /** The limit `outOfTime` checks, named in the note when it runs out. */
  limit?: string;
}

export function diffDigest(
  before: BaselineDigest,
  after: HeapSnapshot,
  { outOfTime, limit = 'diagnoseTimeout' }: DiffOptions = {},
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
    // Each walk covers the whole graph, so a big snapshot can run out of time partway.
    if (outOfTime?.()) {
      ranOut = true;
      break;
    }
    entry.retainerPath = pathForClass(after, before.detachedIds, entry.className);
  }

  const objects: SoakGrowth[] = [];
  for (const [key, count] of now.growth) {
    const delta = count - (before.growth.get(key) ?? 0);
    if (delta < GROWTH_FLOOR) continue;
    objects.push(key.startsWith(CLOSURE)
      ? { name: key.slice(CLOSURE.length), kind: 'closure', delta }
      : { name: key, delta });
  }
  objects.sort((a, b) => b.delta - a.delta);

  const diagnosis: SoakDiagnosis = { detached, objects: objects.slice(0, GROWTH_NAMES) };
  if (ranOut) {
    diagnosis.note = `Diagnosis ran past ${limit}, so not every chain was walked.`;
  }
  return diagnosis;
}
