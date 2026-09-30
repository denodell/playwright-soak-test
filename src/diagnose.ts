import {
  formatBytes,
  formatCount,
  formatPercent,
  formatPerPass,
  formatSigned,
  percentGrowth,
  sparkline,
} from './stats.js';
import type {
  SoakDetachedClass,
  SoakResult,
  SoakRetainerHop,
  SoakTrend,
} from './types.js';

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes}m`;
}

function trendSuffix(trend: SoakTrend): string {
  if (trend.total === 0) return 'flat';
  if (trend.total < 0) return 'no growth';
  if (trend.shape === 'step') return `all at once, at pass ${trend.stepAtPass}`;
  if (trend.shape === 'settled') return 'climbed early, then leveled off';
  return `${formatPerPass(trend.perPass)} per pass, R²=${trend.r2.toFixed(2)}`;
}

export function isOneOff(result: SoakResult): boolean {
  return (
    result.failures.length > 0 &&
    result.failures.every((f) => f.trend.shape === 'step' || f.trend.shape === 'settled')
  );
}

export function describeMetrics(result: SoakResult): string[] {
  const { trends, thresholds, baseline, after } = result;
  const heapPct = percentGrowth(baseline.heap, after.heap);

  const spark = (key: 'nodes' | 'listeners' | 'heap'): string =>
    sparkline(
      result.samples.map((s) => s[key]),
      { floor: key === 'heap' ? baseline.heap * 0.05 : 3 },
    );

  const rows: Array<[string, string, string, string, string]> = [
    [
      'Listeners',
      formatSigned(trends.listeners.total),
      `(threshold ${formatCount(thresholds.listeners)})`,
      spark('listeners'),
      trendSuffix(trends.listeners),
    ],
    [
      'DOM nodes',
      formatSigned(trends.nodes.total),
      `(threshold ${formatCount(thresholds.nodes)})`,
      spark('nodes'),
      trendSuffix(trends.nodes),
    ],
    [
      'Heap',
      formatPercent(heapPct),
      thresholds.heap === null ? '(reported only)' : `(threshold ${thresholds.heap}%)`,
      spark('heap'),
      `${formatBytes(baseline.heap)} → ${formatBytes(after.heap)}`,
    ],
  ];

  const widths = [0, 1, 2, 3].map((i) =>
    Math.max(...rows.map((r) => r[i as 0 | 1 | 2 | 3].length)),
  );
  return rows.map(
    (r) =>
      `${r[0].padEnd(widths[0]!)}  ${r[1].padStart(widths[1]!)}  ${r[2].padEnd(widths[2]!)}` +
      `  ${r[3].padEnd(widths[3]!)}  ${r[4]}`,
  );
}

// The counts say a leak exists. This says which kind.
export function interpret(result: SoakResult): string[] {
  const { trends } = result;
  const guessing = !hasNamedCause(result);
  const nodes = trends.nodes;
  const listeners = trends.listeners;
  const lines: string[] = [];

  const stepped = [listeners, nodes].find((t) => t.shape === 'step' && t.total > 0);
  if (stepped) {
    const which = stepped === nodes ? 'DOM nodes' : 'Listeners';
    lines.push(
      ...sentence(`${which} jumped once at pass ${stepped.stepAtPass} and have stayed there.`),
      ...sentence(`Raise the threshold above ${formatCount(Math.abs(stepped.total))} if that's expected.`),
    );
    return lines;
  }

  const leveled = [listeners, nodes].find((t) => t.shape === 'settled' && t.total > 0);
  if (leveled) {
    const which = leveled === nodes ? 'DOM nodes' : 'Listeners';
    lines.push(
      ...sentence(
        `${which} climbed early on and have been flat since. A leak would still be climbing, so`
        + ' this looks more like a cache filling up.',
      ),
      ...sentence(`Raise the threshold above ${formatCount(Math.abs(leveled.total))} if that's expected.`),
    );
    return lines;
  }

  const listenersLeak = listeners.total > 0 && listeners.shape === 'linear';
  const nodesLeak = nodes.total > 0 && nodes.shape === 'linear';

  if (listenersLeak && nodesLeak) {
    lines.push(
      ...sentence(
        `Every pass leaks ${formatPerPass(nodes.perPass).replace('+', '')} nodes and`
        + ` ${formatPerPass(listeners.perPass).replace('+', '')} listeners.`,
      ),
    );
    if (guessing) {
      lines.push(
        ...sentence('The listeners are probably what is keeping those nodes in memory.'),
      );
    }
  } else if (listenersLeak) {
    lines.push(...sentence('Your app adds a listener every pass and never removes it.'));
  } else if (nodesLeak) {
    lines.push(
      ...sentence(
        (allHeldByChrome(result)
          ? 'Elements are leaving the page and staying in memory.'
          : 'Elements are leaving the page but your code still references them.')
        + (guessing ? ' Usually an array that keeps growing, or a closure that captured them.' : ''),
      ),
    );
  } else if (nodes.shape === 'noisy' || listeners.shape === 'noisy') {
    lines.push(
      ...sentence('The growth is uneven, so this might just be noise. Another run would tell you.'),
    );
  }

  lines.push(
    ...sentence(
      'This all assumes your flow ends where it started. If it adds to the page on purpose, it'
      + ' will grow no matter what.',
    ),
  );

  return lines;
}

/** How many leaks the report describes. */
const SHOWN = 3;

/** Longest chain printed before the middle is replaced with an ellipsis. The data keeps every hop. */
const MAX_HOPS = 8;

/** One leak, from the detached classes that share a retainer chain. */
interface Leak {
  /** The leaked objects, e.g. `<section class="report-drawer">`, largest first. */
  what: string[];
  delta: number;
  /** The chain of retainers, root first, ending on the first of `what`. */
  path: SoakRetainerHop[];
}

/**
 * The chain up to the leaked object, for spotting siblings held by the same thing.
 * The last holder's slot is left out, since siblings sit in different slots of it.
 */
function holderKey(path: SoakRetainerHop[]): string | null {
  const holders = path.slice(0, -1);
  if (!holders.length) return null;
  return JSON.stringify(
    holders.map((hop, i) =>
      i === holders.length - 1 ? [hop.node] : [hop.node, hop.kind, hop.edge?.type, hop.edge?.name],
    ),
  );
}

function groupLeaks(detached: SoakDetachedClass[]): Leak[] {
  const walked = detached.filter((d) => d.retainerPath.length);
  const leaks: Leak[] = [];

  // Another leak's contents share its whole chain. Matching one depth would merge unrelated leaks.
  const inside = (candidate: SoakRetainerHop[], other: SoakRetainerHop[]): boolean =>
    candidate.length > other.length
    && other.every((hop, i) => hop.node === candidate[i]?.node && hop.kind === candidate[i]?.kind);

  const roots = walked.filter(
    (candidate) =>
      !walked.some((other) => other !== candidate && inside(candidate.retainerPath, other.retainerPath)),
  );

  const byHolder = new Map<string, Leak>();
  for (const root of [...roots].sort((a, b) => b.delta - a.delta)) {
    const what = root.retainerPath.at(-1)?.node ?? root.className;
    const key = holderKey(root.retainerPath);
    const sibling = key === null ? undefined : byHolder.get(key);
    if (sibling) {
      sibling.what.push(what);
      sibling.delta += root.delta;
      continue;
    }
    const leak = { what: [what], delta: root.delta, path: root.retainerPath };
    if (key !== null) byHolder.set(key, leak);
    leaks.push(leak);
  }

  return leaks.sort((a, b) => b.delta - a.delta);
}

/** What the chain is anchored on, which decides the opening sentence. */
type Anchor = 'timer' | 'listener' | 'container' | 'global' | 'browser' | 'other';

interface Culprit {
  anchor: Anchor;
  /** The function whose scope keeps it alive, without the `closure` prefix. */
  fn?: string;
  variable?: string;
  /** What that variable is, when it is not the leaked object itself. */
  container?: string;
  /** The collection the function itself is kept in, so it was added and never removed. */
  heldIn?: string;
  /** The property the whole chain hangs off, when it hangs off a global. */
  global?: string;
  /** What the listener is registered on, which is not always the window. */
  listenerTarget?: string;
}

function readChain(path: SoakRetainerHop[]): Culprit {
  const out: Culprit = { anchor: 'other' };

  // The function nearest the leaked object. Nearer the root it's usually a framework's.
  let closureAt = -1;
  for (let i = path.length - 1; i >= 0 && closureAt < 0; i--) {
    if (path[i]!.kind === 'closure') closureAt = i;
  }
  if (closureAt >= 0) {
    const closure = path[closureAt]!;
    out.fn = closure.node;
    if (closure.edge?.type === 'context') out.variable = closure.edge.name;

    const next = path[closureAt + 1]?.node;
    const isLast = next === path.at(-1)?.node;
    if (next && !isLast && Object.hasOwn(COLLECTIONS, next)) out.container = next;

    const before = path[closureAt - 1];
    if (before && !before.kind && Object.hasOwn(COLLECTIONS, before.node)) out.heldIn = before.node;
  }

  const root = path[0];
  if (root?.node === 'Window' && root.edge?.type === 'property') {
    out.global = `window.${root.edge.name}`;
    // An array hung straight off the window, with no closure in between.
    const next = path[1]?.node;
    const isLast = path.length === 2;
    if (closureAt < 0 && next && !isLast && Object.hasOwn(COLLECTIONS, next)) out.container = next;
  }

  const listenerAt = path.findIndex((hop) => hop.node === 'EventListener');
  if (heldByChrome(path)) out.anchor = 'browser';
  else if (path.some((hop) => hop.kind === 'timer')) out.anchor = 'timer';
  else if (listenerAt >= 0) {
    out.anchor = 'listener';
    const target = path[listenerAt - 1];
    if (target) out.listenerTarget = target.node === 'Window' ? 'window' : target.node;
  } else if (out.container) out.anchor = 'container';
  else if (out.global) out.anchor = 'global';

  return out;
}

/** Prints `onResize()` for a closure, and lower-cases `Window`. */
function hopLabel(hop: SoakRetainerHop, first: boolean): string {
  if (hop.kind === 'closure') return `${hop.node}()`;
  if (hop.node === 'Window') {
    return first && hop.edge?.type === 'property' ? `window.${hop.edge.name}` : 'window';
  }
  if (hop.node === 'HTMLDocument') return 'document';
  return hop.node;
}

function chainLine(path: SoakRetainerHop[]): string {
  const labels = path.map((hop, i) => hopLabel(hop, i === 0));
  // Elided here and not in the data. `groupLeaks` matches chains hop by hop, and
  // two truncated chains stop matching. The middle of the chain near the root is
  // usually a framework's, so that's the part that goes.
  const shown =
    labels.length <= MAX_HOPS
      ? labels
      : [labels[0]!, '\u2026', ...labels.slice(-(MAX_HOPS - 2))];
  return shown.join(' \u2192 ');
}

/** Wraps to the same width as the fixed lines in this file. */
function sentence(text: string, width = 88): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (!current) current = word;
    else if (current.length + word.length + 1 <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const COLLECTIONS: Record<string, string> = { Array: 'an array', Map: 'a map', Set: 'a set' };

/** How many leaked objects one sentence names before it gives a count instead. */
const NAMED = 3;

/** `the <li> element`, `the <li> and <p> elements`, `the <li>, <p>, and 2 more elements`. */
function nameLeaked(what: string[]): string {
  const named = what.filter((w) => w !== 'Text');
  const shown = named.length > NAMED
    ? [...named.slice(0, NAMED - 1), `${named.length - NAMED + 1} more`]
    : named;
  const list = shown.length < 3
    ? shown.join(' and ')
    : `${shown.slice(0, -1).join(', ')}, and ${shown.at(-1)}`;
  const elements = named.every((w) => w.startsWith('<'));
  const phrase = named.length
    ? `the ${list}${elements ? (named.length > 1 ? ' elements' : ' element') : ''}`
    : '';
  if (named.length === what.length) return phrase;
  return phrase ? `${phrase} and a text node` : 'a text node';
}

// Parts of the page that can sit in a chain Chrome is holding without your code being in it.
const PAGE_HOPS = new Set(['Text', 'HTMLDocument', 'ShadowRoot', 'DocumentFragment']);

/**
 * True when the chain is just the window, the page and Chrome's own objects. Your
 * code can only keep an element through its own objects and functions, and none
 * are in the chain.
 */
function heldByChrome(path: SoakRetainerHop[]): boolean {
  const [root, ...rest] = path;
  if (!root || root.node !== 'Window' || root.edge || root.kind || !rest.length) return false;
  return rest.every((hop) =>
    hop.kind === 'browser' || (!hop.kind && (hop.node.startsWith('<') || PAGE_HOPS.has(hop.node))));
}

function allHeldByChrome(result: SoakResult): boolean {
  const leaks = groupLeaks(result.diagnosis?.detached ?? []);
  return leaks.length > 0 && leaks.every((leak) => heldByChrome(leak.path));
}

function describeLeak(leak: Leak, result: SoakResult): string[] {
  const { anchor, fn, variable, container, heldIn, global, listenerTarget } = readChain(leak.path);
  const what = nameLeaked(leak.what);
  const collection = container ? COLLECTIONS[container] : undefined;

  // Delegated listeners stay registered by design, so only a count that grew means one leaked.
  const listenerLeaked = anchor === 'listener' && result.trends.listeners.total > 0;

  const anchored =
    anchor === 'timer'
      ? 'A timer is still pending. '
      : listenerLeaked
        ? `A listener${listenerTarget ? ` on ${listenerTarget}` : ''} is still registered. `
        : '';

  let cause: string;
  if (anchor === 'browser') {
    const them = leak.what.length > 1 ? 'them' : 'it';
    cause = `Only Chrome's own objects still reference ${what}, so your code isn't keeping`
      + ` ${them}. Typing into an editable area does this, because Chrome's undo history keeps`
      + ' the text it removes, for up to 1,000 steps. So does logging an object that refers to'
      + ' the element, like an event, with `console.log` while Playwright is connected.';
  } else if (collection) {
    // The variable, not the function: V8 can name a bundle's scope after any function in it.
    const named = variable ? ` called \`${variable}\`` : global ? ` at \`${global}\`` : '';
    cause = `${collection[0]!.toUpperCase()}${collection.slice(1)}${named} keeps growing, and`
      + ` ${what} ${leak.what.length > 1 ? 'are' : 'is'} still in it.`;
  } else if (fn && heldIn) {
    // Usually a subscription that was never undone, so that's the thing to look for.
    cause = `\`${fn}\` is still in ${COLLECTIONS[heldIn]}, and it still references ${what}.`;
  } else if (fn) {
    cause = anchored
      ? `Its callback \`${fn}\` still references ${what}.`
      : `\`${fn}\` still references ${what}.`;
  } else if (global) {
    cause = `Something on \`${global}\` still references ${what}.`;
  } else {
    cause = `Something still references ${what}.`;
  }

  return [...sentence(`${anchored}${cause}`), '', `  ${chainLine(leak.path)}`];
}

/** The cause in a sentence, then its chain. Empty when there's nothing to report. */
export function describeDiagnosis(result: SoakResult): string[] {
  const diagnosis = result.diagnosis;
  if (!diagnosis) return [];

  const leaks = groupLeaks(diagnosis.detached);
  const lines: string[] = [];

  for (const leak of leaks.slice(0, SHOWN)) {
    if (lines.length) lines.push('');
    lines.push(...describeLeak(leak, result));
  }

  const rest = leaks.length - SHOWN;
  if (rest > 0) {
    const more = rest === 1 ? 'One more leak looks' : `${formatCount(rest)} more leaks look`;
    lines.push('', `${more} like this one.`);
  }

  const growth = diagnosis.objects
    .map((g) => `${g.kind === 'closure' ? `${g.name}()` : g.name} ${formatSigned(g.delta)}`)
    .join(', ');

  if (!leaks.length && diagnosis.detached.length) {
    // Detached classes grew but no chain reached a root, so only the counts are left.
    const classes = diagnosis.detached
      .slice(0, SHOWN)
      .map((d) => `${d.className.replace('Detached ', '')} ${formatSigned(d.delta)}`)
      .join(', ');
    lines.push(
      ...sentence(
        `Elements are coming off the page and staying in memory: ${classes}. Nothing turned up` +
        ' that still references them.',
      ),
    );
  } else if (!leaks.length && diagnosis.objects.length) {
    lines.push(
      ...sentence(
        `Nothing leaked from the DOM. The growth is in ${growth}.`,
      ),
    );
  }

  if (diagnosis.note) {
    if (lines.length) lines.push('');
    lines.push(diagnosis.note);
  }

  return lines;
}

/** True when the snapshots found a cause, which is when `interpret` stops guessing. */
export function hasNamedCause(result: SoakResult): boolean {
  return groupLeaks(result.diagnosis?.detached ?? []).length > 0;
}

function notes(result: SoakResult): string[] {
  const lines: string[] = [];

  if (result.clock.enabled) {
    const virtual = result.clock.virtualElapsedMs ?? result.clock.advanceMs * result.passes;
    lines.push(
      `${formatCount(result.passes)} passes x ${result.clock.advanceMs / 1000}s of virtual time` +
      ` = ${formatDuration(virtual)} of app time.`,
    );
  }

  if (result.responseTimeouts > 0) {
    lines.push(
      `${formatCount(result.responseTimeouts)} waits for a response timed out, so those passes` +
      ' did less work than the rest.',
    );
  }

  if (!result.exposeGc) {
    lines.push(
      'Chromium was started without `--expose-gc`, so garbage collection is a hint the browser' +
      ' can ignore and the counts move between readings. Adding' +
      ' `launchOptions: soakLaunchOptions` to your config fixes it.',
    );
  }

  return lines;
}

export function buildReport(result: SoakResult, heading: string): string {
  const blocks: string[][] = [
    [heading, ''],
    describeMetrics(result).flatMap((l, i) => (i === 0 ? [`  ${l}`] : ['', `  ${l}`])),
  ];
  if (result.leaking) blocks.push([''], interpret(result).map((l) => `  ${l}`));

  // A passing run has a diagnosis too when `diagnose` is `'always'`.
  const diagnosis = describeDiagnosis(result);
  if (diagnosis.length) blocks.push([''], diagnosis.map((l) => (l ? `  ${l}` : '')));

  if (result.leaking) {
    const findIt = [
      '  Find it: DevTools → Memory → take a heap snapshot, then filter the class list for',
      '  "Detached". Clicking a node shows its retainers, so you can see what still references it.',
    ];
    if (result.diagnosis?.snapshots) {
      findIt.push("  Both snapshots from this run are attached, so they can be dragged straight in.");
    }
    blocks.push([''], findIt);
  }

  const trailing = notes(result);
  if (trailing.length) blocks.push([''], trailing.map((l) => `  ${l}`));

  return blocks.flat().join('\n');
}

/** The report as text. For a leak it's the `SoakLeakError` message. */
export function formatSoakReport(result: SoakResult): string {
  return result.leaking
    ? buildFailureMessage(result)
    : buildReport(result, `No leak found in "${result.label}".`);
}

export function buildFailureMessage(result: SoakResult): string {
  const heading = isOneOff(result)
    ? `"${result.label}" grew past its threshold, then stopped.`
    : `Memory leak detected in "${result.label}".`;
  return buildReport(result, heading);
}
