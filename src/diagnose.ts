import {
  formatBytes,
  formatCount,
  formatPercent,
  formatPerPass,
  formatSigned,
  percentGrowth,
  sparkline,
} from './stats.js';
import { PENDING_TIMER } from './types.js';
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
  if (trend.shape === 'settled') return 'climbed early, then levelled off';
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

// Reads the shape of each trend and says what kind of leak it looks like.
export function interpret(result: SoakResult): string[] {
  const { trends } = result;
  // When the snapshots have named a cause, there is no need to guess at one below.
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

  const levelled = [listeners, nodes].find((t) => t.shape === 'settled' && t.total > 0);
  if (levelled) {
    const which = levelled === nodes ? 'DOM nodes' : 'Listeners';
    lines.push(
      ...sentence(
        `${which} climbed early on and have been flat since. A leak would still be climbing, so`
        + ' this looks more like a cache filling up.',
      ),
      ...sentence(`Raise the threshold above ${formatCount(Math.abs(levelled.total))} if that's expected.`),
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
        'Elements are leaving the page but your code still references them.'
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

/**
 * One leak, gathered from the detached classes that share a retainer chain. A
 * leaking drawer shows up as four separate classes. Read each chain from the
 * root and the part they all share ends on the thing that leaked.
 */
interface Leak {
  /** The leaked object, e.g. `<section class="report-drawer">`. */
  what: string;
  /** How many more of them than at the baseline. */
  delta: number;
  /** The chain of retainers, root first, ending on `what`. */
  path: SoakRetainerHop[];
}

function groupLeaks(detached: SoakDetachedClass[]): Leak[] {
  const walked = detached.filter((d) => d.retainerPath.length);
  const leaks: Leak[] = [];

  // A chain running through another class's leaked object is that object's
  // contents. It has to share the whole chain down to that object, not just the
  // name at that depth, or two unrelated leaks with a <div> at the same position
  // fold into one.
  const inside = (candidate: SoakRetainerHop[], other: SoakRetainerHop[]): boolean =>
    candidate.length > other.length && other.every((hop, i) => hop.node === candidate[i]?.node);

  const roots = walked.filter(
    (candidate) =>
      !walked.some((other) => other !== candidate && inside(candidate.retainerPath, other.retainerPath)),
  );

  for (const root of roots) {
    leaks.push({
      what: root.retainerPath.at(-1)?.node ?? root.className,
      delta: root.delta,
      path: root.retainerPath,
    });
  }

  return leaks.sort((a, b) => b.delta - a.delta);
}

/** What the chain is anchored on, which decides the opening sentence. */
type Anchor = 'timer' | 'listener' | 'container' | 'global' | 'other';

interface Culprit {
  anchor: Anchor;
  /** The function whose scope keeps it alive, without the `closure` prefix. */
  fn?: string;
  /** The variable in that scope. */
  variable?: string;
  /** What that variable is, when it is not the leaked object itself. */
  container?: string;
  /** The property the whole chain hangs off, when it hangs off a global. */
  global?: string;
  /** What the listener is registered on, which is not always the window. */
  listenerTarget?: string;
}

function readChain(path: SoakRetainerHop[]): Culprit {
  const out: Culprit = { anchor: 'other' };

  const closureAt = path.findIndex((hop) => hop.node.startsWith('closure '));
  if (closureAt >= 0) {
    const closure = path[closureAt]!;
    out.fn = closure.node.slice('closure '.length);
    if (closure.edge?.type === 'context') out.variable = closure.edge.name;

    // Only a collection is worth naming in the sentence. Anything else is left for
    // the chain to show.
    const next = path[closureAt + 1]?.node;
    if (next && next !== path.at(-1)?.node && next in COLLECTIONS) out.container = next;
  }

  const root = path[0];
  if (root?.node === 'Window' && root.edge?.type === 'property') {
    out.global = `window.${root.edge.name}`;
  }

  const listenerAt = path.findIndex((hop) => hop.node === 'EventListener');
  if (path.some((hop) => hop.node === PENDING_TIMER)) out.anchor = 'timer';
  else if (listenerAt >= 0) {
    out.anchor = 'listener';
    // The hop above the listener is what it is registered on, which is not always window.
    const target = path[listenerAt - 1];
    if (target) out.listenerTarget = target.node === 'Window' ? 'window' : target.node;
  } else if (out.container) out.anchor = 'container';
  else if (out.global) out.anchor = 'global';

  return out;
}


/** Prints `onResize()` for a closure, and lower-cases `Window`. */
function hopLabel(hop: SoakRetainerHop, first: boolean): string {
  if (hop.node.startsWith('closure ')) return `${hop.node.slice('closure '.length)}()`;
  // A property off a global is the one name you would search your code for.
  if (hop.node === 'Window') {
    return first && hop.edge?.type === 'property' ? `window.${hop.edge.name}` : 'window';
  }
  return hop.node;
}

function chainLine(path: SoakRetainerHop[]): string {
  const labels = path.map((hop, i) => hopLabel(hop, i === 0));
  // Elided here and not in the data. `groupLeaks` matches chains hop by hop, and
  // two truncated chains stop matching.
  const shown =
    labels.length <= MAX_HOPS
      ? labels
      : [...labels.slice(0, MAX_HOPS - 2), '\u2026', labels[labels.length - 1]!];
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

function describeLeak(leak: Leak, result: SoakResult): string[] {
  const { anchor, fn, variable, container, global, listenerTarget } = readChain(leak.path);
  // `<div>` reads better as "the <div> element". `Detached HTMLDivElement` is
  // already a class name and needs nothing after it.
  const what = `the ${leak.what}${leak.what.startsWith('<') ? ' element' : ''}`;
  const collection = container ? COLLECTIONS[container] : undefined;

  // A delegated listener is meant to stay registered, so it turns up in chains of
  // leaks it did not cause. The count only moves when one is left behind by
  // mistake.
  const listenerLeaked = anchor === 'listener' && result.trends.listeners.total > 0;

  // The snapshot shows a pending timer or a registered listener. Why it is still
  // there would be a guess, so the sentence says what was found instead.
  const anchored =
    anchor === 'timer'
      ? 'A timer is still pending. '
      : listenerLeaked
        ? `A listener${listenerTarget ? ` on ${listenerTarget}` : ''} is still registered. `
        : '';

  let cause: string;
  if (collection) {
    // Name the variable, not the function. A bundler flattens modules into one
    // scope, so V8 often credits that scope to a function from another file.
    const named = variable ? ` called \`${variable}\`` : '';
    cause = `${collection[0]!.toUpperCase()}${collection.slice(1)}${named} keeps growing, and`
      + ` ${what} is still in it.`;
  } else if (fn) {
    // No variable name here. When the variable is the leaked object itself, `root`
    // or `state` adds nothing to the sentence.
    cause = anchored
      ? `Its callback \`${fn}\` still references ${what}.`
      : `\`${fn}\` still references ${what}.`;
  } else if (global) {
    cause = `Something on \`${global}\` still references ${what}.`;
  } else {
    cause = `Something still references ${what}.`;
  }

  // No count and no rate. The box above has both, and `interpret` repeats the rate.
  return [...sentence(`${anchored}${cause}`), '', `  ${chainLine(leak.path)}`];
}

/**
 * The cause in a sentence, then the chain it came from. Returns an empty array
 * when there is nothing to report, so the caller can skip the whole section.
 */
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

  const growth = diagnosis.growth.map((g) => `${g.name} ${formatSigned(g.delta)}`).join(', ');

  if (!leaks.length && diagnosis.detached.length) {
    // Detached classes grew, but no chain reached a root, so the counts are all we
    // have. The heap-only wording below would be wrong here.
    const classes = diagnosis.detached
      .slice(0, SHOWN)
      .map((d) => `${d.className.replace('Detached ', '')} ${formatSigned(d.delta)}`)
      .join(', ');
    lines.push(
      ...sentence(
        `Elements are coming off the page and staying in memory: ${classes}. The snapshot did` +
        ' not show what is keeping them.',
      ),
    );
  } else if (!leaks.length && diagnosis.growth.length) {
    // Nothing came off the page, so the JS names are all there is to report.
    lines.push(
      ...sentence(
        'Nothing came off the page, so the growth is in plain data rather than DOM.' +
        ` Most of it is in ${growth}.`,
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
    [''],
    interpret(result).map((l) => `  ${l}`),
  ];

  if (result.leaking) {
    const diagnosis = describeDiagnosis(result);
    if (diagnosis.length) blocks.push([''], diagnosis.map((l) => (l ? `  ${l}` : '')));

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

export function buildFailureMessage(result: SoakResult): string {
  const heading = isOneOff(result)
    ? `"${result.label}" grew past its threshold, then stopped.`
    : `Memory leak detected in "${result.label}".`;
  return buildReport(result, heading);
}
