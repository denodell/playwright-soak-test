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
      'DOM nodes are climbing while the listener count stays flat.' +
      (guessing
        ? ' Elements are coming off the page but your JavaScript still points at them, so they' +
        ' stay in memory. An array that keeps growing is a common cause, or a variable a' +
        ' long-lived function closed over.'
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
  /** The function whose scope keeps it alive, without the `closure` prefix. */
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
    // collection is the thing that keeps growing. Anything else in between has
    // no name worth putting in a sentence, so it stays in the chain only.
    const next = path[closureAt + 1]?.node;
    if (next && next !== path.at(-1)?.node && next in COLLECTIONS) out.container = next;
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

/** Collections a reader would recognize as the thing that keeps growing. */
const COLLECTIONS: Record<string, string> = { Array: 'an array', Map: 'a map', Set: 'a set' };

/** The sentence a reader acts on. The chain underneath it is the evidence. */
function describeLeak(leak: Leak): string[] {
  const { anchor, fn, variable, container, global } = readChain(leak.path);
  // Blink names a detached wrapper after its markup, so "element" says what the
  // angle brackets are. An older snapshot names it `Detached HTMLDivElement`
  // instead, which already reads as a class and does not want the extra word.
  //
  // Nothing about whose element it is. The whole report is about the flow that
  // was passed to `soak.run`, the markup says which element far better than any
  // phrase would, and all the snapshots show is that the count went up, not what
  // created it.
  const what = `the ${leak.what}${leak.what.startsWith('<') ? ' element' : ''}`;
  const collection = container ? COLLECTIONS[container] : undefined;

  // Only a timer and a listener need a sentence of their own, because the missing
  // `clearTimeout` or `removeEventListener` is the fix and the chain cannot say
  // it. The rest is said once, by the sentence about the code.
  const missing =
    anchor === 'timer'
      ? 'A timer was never cleared. '
      : anchor === 'listener'
        ? 'A listener on window was never removed. '
        : '';

  let cause: string;
  if (collection) {
    // The variable is the answer here rather than the function, because it names
    // the array to go and find. The function stays out of it: a bundler flattens
    // every module into one scope, so the function V8 attributes that scope to is
    // often declared in a different file from the variable, and naming it here
    // would send a reader to the wrong one. It is still in the chain below, where
    // it reads as a hop rather than as a claim about where the array lives.
    const named = variable ? ` called \`${variable}\`` : '';
    cause = `${collection[0]!.toUpperCase()}${collection.slice(1)}${named} keeps growing, and`
      + ` it still references ${what}.`;
  } else if (fn) {
    // No variable name here. When the captured variable is the leaked object, its
    // name is the local one for something the sentence already describes better,
    // and a name like `root` or `state` reads as a term the reader has to look up.
    cause = `${missing ? `Its callback \`${fn}\`` : `\`${fn}\``} still references ${what}.`;
  } else if (global) {
    cause = `Something on \`${global}\` still references ${what}.`;
  } else {
    cause = `Something still references ${what}.`;
  }

  // No count and no rate. The box above has both, and `interpret` says the rate
  // again in words, so a third telling is the one that reads as padding.
  return [...sentence(`${missing}${cause}`), '', `  ${chainLine(leak.path)}`];
}

/**
 * What the heap snapshots found, in the same voice as the rest of the report: the
 * cause in a sentence, then the chain of retainers as the evidence for it.
 *
 * The chain runs all the way to the root rather than stopping at the closure. The
 * root end says what keeps it alive, a listener or a timer or something stored on
 * `window`, and the closure in the middle says which line of code did it.
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
    lines.push(...describeLeak(leak));
  }

  const rest = leaks.length - SHOWN;
  if (rest > 0) {
    lines.push('', `The run found ${formatCount(rest)} more ${rest === 1 ? 'leak' : 'leaks'} like this.`);
  }

  // Nothing detached means the leak never reached the page, so the growing JS
  // names are all there is to go on.
  if (!leaks.length && diagnosis.growth.length) {
    const list = diagnosis.growth.map((g) => `${g.name} ${formatSigned(g.delta)}`).join(', ');
    lines.push(
      ...sentence(
        'Nothing came off the page, so this is data the app keeps rather than DOM it removed' +
        ` and still references. Most of the growth is in ${list}.`,
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
