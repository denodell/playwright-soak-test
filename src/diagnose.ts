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

// The counts say a leak exists. This says which kind.
export function interpret(result: SoakResult): string[] {
  const { trends } = result;
  // The snapshots either name the cause or they don't. When they do, the guesses
  // below are not just redundant, they read as hedging next to a certain answer.
  const guessing = !hasNamedCause(result);
  const nodes = trends.nodes;
  const listeners = trends.listeners;
  const lines: string[] = [];

  const stepped = [listeners, nodes].find((t) => t.shape === 'step' && t.total > 0);
  if (stepped) {
    const which = stepped === nodes ? 'DOM nodes' : 'Listeners';
    lines.push(
      `${which} jumped once at pass ${stepped.stepAtPass} and held there. Something created on` +
      ' that pass is still around, and the count has been flat since.',
      `Raise the threshold above ${formatCount(Math.abs(stepped.total))} if that's expected.`,
    );
    return lines;
  }

  const levelled = [listeners, nodes].find((t) => t.shape === 'settled' && t.total > 0);
  if (levelled) {
    const which = levelled === nodes ? 'DOM nodes' : 'Listeners';
    lines.push(
      `${which} climbed over the early passes and has been flat since. A cache filling up or a` +
      ' pool reaching its working size does this. A leak would still be climbing.',
      `Raise the threshold above ${formatCount(Math.abs(levelled.total))} if that's expected.`,
    );
    return lines;
  }

  const listenersLeak = listeners.total > 0 && listeners.shape === 'linear';
  const nodesLeak = nodes.total > 0 && nodes.shape === 'linear';

  if (listenersLeak && nodesLeak) {
    lines.push(
      `Every pass leaks ${formatPerPass(nodes.perPass).replace('+', '')} nodes and` +
      ` ${formatPerPass(listeners.perPass).replace('+', '')} listeners, starting from the first one.`,
    );
    if (guessing) {
      lines.push(
        'Most often a listener stays registered after the flow ends, and its callback still points',
        'at the elements it was created for, so they stay in memory too.',
      );
    }
  } else if (listenersLeak) {
    lines.push(
      'The listener count goes up when your code adds a listener and down when it removes one.' +
      ' This one keeps going up, so something is adding a listener each pass and it stays' +
      ' registered.',
    );
  } else if (nodesLeak) {
    lines.push(
      'DOM nodes are climbing while the listener count stays flat. Elements are coming off the' +
      ' page but your JavaScript still points at them, so they stay in memory.' +
      (guessing
        ? ' An array that keeps growing is a common cause, or a variable a long-lived function' +
        ' closed over.'
        : ''),
    );
  } else if (nodes.shape === 'noisy' || listeners.shape === 'noisy') {
    lines.push(
      'Growth is uneven, so this could be noise. A second run will tell you whether it is real.',
    );
  }

  lines.push(
    'All of this assumes your flow ends on the screen it started on. A flow that adds to the',
    'page on purpose will grow whatever you do.',
  );

  return lines;
}

/** Leaks described in the report. Past three, a failing run has bigger problems. */
const SHOWN = 3;

/**
 * One leak, gathered from the detached classes that share a retainer chain.
 *
 * A drawer that leaks shows up as four classes -- the section, its rows, their
 * spans, its heading -- which is one bug counted four ways. Reading each class's
 * chain from the root, the common prefix ends on the thing that actually leaked;
 * everything past it is that thing's contents.
 */
interface Leak {
  /** The leaked object, e.g. `<section class="report-drawer">`. */
  what: string;
  /** How many more of them than at the baseline. */
  delta: number;
  /** Holders, root first, ending on `what`. */
  path: SoakRetainerHop[];
}

function groupLeaks(detached: SoakDetachedClass[]): Leak[] {
  const walked = detached.filter((d) => d.retainerPath.length);
  const leaks: Leak[] = [];

  // A class whose chain runs through another class's leaked object is that
  // object's contents, so it is folded into the same finding.
  const roots = walked.filter(
    (candidate) =>
      !walked.some(
        (other) =>
          other !== candidate &&
          candidate.retainerPath.length > other.retainerPath.length &&
          candidate.retainerPath[other.retainerPath.length - 1]?.node ===
          other.retainerPath.at(-1)?.node,
      ),
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

/** Where the chain is anchored, which is what the opening sentence turns on. */
type Anchor = 'timer' | 'listener' | 'container' | 'global' | 'other';

interface Culprit {
  anchor: Anchor;
  /** The function whose scope is holding on, without the `closure` prefix. */
  fn?: string;
  /** The variable in that scope. */
  variable?: string;
  /** What that variable is, when it is not the leaked object itself. */
  container?: string;
  /** The property the whole chain hangs off, when it hangs off a global. */
  global?: string;
}

function readChain(path: SoakRetainerHop[]): Culprit {
  const out: Culprit = { anchor: 'other' };

  const closureAt = path.findIndex((hop) => hop.node.startsWith('closure '));
  if (closureAt >= 0) {
    const closure = path[closureAt]!;
    out.fn = closure.node.slice('closure '.length);
    if (closure.edge?.type === 'context') out.variable = closure.edge.name;

    // Whatever the captured variable turns out to be. When it is the leaked
    // object there is nothing in between; when it is a collection, that
    // collection is the thing that never gets emptied.
    const next = path[closureAt + 1]?.node;
    if (next && next !== path.at(-1)?.node) out.container = next;
  }

  const root = path[0];
  if (root?.node === 'Window' && root.edge?.type === 'property') {
    out.global = `window.${root.edge.name}`;
  }

  if (path.some((hop) => hop.node === PENDING_TIMER)) out.anchor = 'timer';
  else if (path.some((hop) => hop.node === 'EventListener')) out.anchor = 'listener';
  else if (out.container) out.anchor = 'container';
  else if (out.global) out.anchor = 'global';

  return out;
}

const PENDING_TIMER = 'a pending timer';

/** `closure onResize` reads as code, and `Window` is spelled the way it is typed. */
function hopLabel(hop: SoakRetainerHop, first: boolean): string {
  if (hop.node.startsWith('closure ')) return `${hop.node.slice('closure '.length)}()`;
  // A property hanging off a global is the one edge name worth spelling out: when
  // a leak is anchored there, that name is what a reader searches for.
  if (hop.node === 'Window') {
    return first && hop.edge?.type === 'property' ? `window.${hop.edge.name}` : 'window';
  }
  return hop.node;
}

function chainLine(path: SoakRetainerHop[]): string {
  return path.map((hop, i) => hopLabel(hop, i === 0)).join(' \u2192 ');
}

/** Wrapped to the width the hand-written lines in this file already sit at. */
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

/** The sentence a reader acts on. The chain underneath it is the evidence. */
function describeLeak(leak: Leak, result: SoakResult): string[] {
  const { anchor, fn, variable, container, global } = readChain(leak.path);

  const opening: string = {
    timer: 'A timer was never cleared.',
    listener: 'A listener on window was never removed.',
    container: `${container === 'Array' ? 'An array' : `A ${container}`} that never gets emptied is`
      + ' holding them.',
    global: `Something reachable from \`${global}\` is holding them.`,
    other: 'Something the page still reaches is holding them.',
  }[anchor];

  const what = `the ${leak.what} your flow built`;
  const middle = !fn
    ? `Nothing removed the last reference to ${what}.`
    : container
      ? `\`${fn}\` captured it${variable ? ` as \`${variable}\`` : ''}, and it still holds ${what}.`
      : `Its callback \`${fn}\` captured${variable ? ` \`${variable}\`, which is` : ''} ${what}.`;

  const perPass = leak.delta === result.passes - result.warmup ? ', one per pass' : '';
  const count = `${formatCount(leak.delta)} of them are off the page and still in memory${perPass}.`;

  return [...sentence(`${opening} ${middle} ${count}`), '', `  ${chainLine(leak.path)}`];
}

/**
 * What the heap snapshots found, in the same voice as the rest of the report: the
 * cause in a sentence, then the chain of holders as the evidence for it.
 *
 * The chain runs all the way to the root rather than stopping at the closure. The
 * root end says who is holding it -- a listener, a timer, something on `window` --
 * and the closure in the middle says which line of code did it.
 *
 * Returns nothing when there is nothing to say, so the caller can skip the whole
 * section rather than print an empty heading.
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
    lines.push('', `${formatCount(rest)} more ${rest === 1 ? 'leak' : 'leaks'} like this were found.`);
  }

  // Nothing detached means the leak never reached the page, so the growing JS
  // names are all there is to go on.
  if (!leaks.length && diagnosis.growth.length) {
    const list = diagnosis.growth.map((g) => `${g.name} ${formatSigned(g.delta)}`).join(', ');
    lines.push(
      ...sentence(
        'Nothing came off the page, so this is data the app is keeping rather than DOM it' +
        ` forgot. Most of the growth is in ${list}.`,
      ),
    );
  }

  if (diagnosis.note) {
    if (lines.length) lines.push('');
    lines.push(diagnosis.note);
  }

  return lines;
}

/** True once the snapshots have named a cause, so the report can stop guessing at one. */
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
      ' `launchOptions: soakLaunchOptions` to your config makes it exact.',
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
