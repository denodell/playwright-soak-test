import {
  formatBytes,
  formatCount,
  formatPercent,
  formatPerPass,
  formatSigned,
  percentGrowth,
  sparkline,
} from './stats.js';
import type { SoakResult, SoakTrend } from './types.js';

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
      'Most often a listener stays registered after the flow ends, and its callback still points',
      'at the elements it was created for, so they stay in memory too.',
    );
  } else if (listenersLeak) {
    lines.push(
      'The listener count goes up when your code adds a listener and down when it removes one.' +
      ' This one keeps going up, so something is adding a listener each pass and it stays' +
      ' registered.',
    );
  } else if (nodesLeak) {
    lines.push(
      'DOM nodes are climbing while the listener count stays flat. Elements are coming off the' +
      ' page but your JavaScript still points at them, so they stay in memory. An array that' +
      ' keeps growing is a common cause, or a variable a long-lived function closed over.',
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
    blocks.push(
      [''],
      [
        '  Find it: DevTools → Memory → take a heap snapshot, then filter the class list for',
        '  "Detached". Clicking a node shows its retainers, so you can see what still references it.',
      ],
    );
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
