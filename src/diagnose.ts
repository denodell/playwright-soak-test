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
  const { trends, allowances, baseline, after } = result;
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
      `(allowance ${formatCount(allowances.listeners)})`,
      spark('listeners'),
      trendSuffix(trends.listeners),
    ],
    [
      'DOM nodes',
      formatSigned(trends.nodes.total),
      `(allowance ${formatCount(allowances.nodes)})`,
      spark('nodes'),
      trendSuffix(trends.nodes),
    ],
    [
      'Heap',
      formatPercent(heapPct),
      allowances.heap === null ? '(reported only)' : `(allowance ${allowances.heap}%)`,
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
      `${which} jumped once at pass ${stepped.stepAtPass} and stayed flat afterwards. That's` +
      ' one-off retention, not a leak: something rendered or registered once and stuck around.',
      `Raise the allowance above ${formatCount(Math.abs(stepped.total))} if that's expected.`,
    );
    return lines;
  }

  const levelled = [listeners, nodes].find((t) => t.shape === 'settled' && t.total > 0);
  if (levelled) {
    const which = levelled === nodes ? 'DOM nodes' : 'Listeners';
    lines.push(
      `${which} climbed over the early passes and levelled off well before the end. A leak keeps` +
      ' going, so this is more likely a cache filling or another one-off task.',
      `Raise the allowance above ${formatCount(Math.abs(levelled.total))} if that's expected.`,
    );
    return lines;
  }

  const listenersLeak = listeners.total > 0 && listeners.shape === 'linear';
  const nodesLeak = nodes.total > 0 && nodes.shape === 'linear';

  if (listenersLeak && nodesLeak) {
    lines.push(
      `Every pass leaks ${formatPerPass(nodes.perPass).replace('+', '')} nodes and` +
      ` ${formatPerPass(listeners.perPass).replace('+', '')} listeners, from the first pass onwards.`,
      'A listener holding a closure over the subtree it was created for is the usual shape:',
      'the listener keeps the closure, and the closure keeps the whole subtree alive.',
    );
  } else if (listenersLeak) {
    lines.push(
      'A listener count that only ever rises means a listener is still registered after the' +
      ' flow ends. It goes up when your code adds one and down when it removes one, so this is' +
      ' a real registration that outlived the flow.',
    );
  } else if (nodesLeak) {
    lines.push(
      'DOM nodes climbing with a flat listener count means detached elements are still' +
      ' referenced by JavaScript: an array or a closure that outlives them.',
    );
  } else if (nodes.shape === 'noisy' || listeners.shape === 'noisy') {
    lines.push(
      'Growth is uneven, so this may be jitter. Re-run before acting on it.',
    );
  }

  lines.push(
    'This works when the flow returns the app to the screen it started on. Anything else grows' +
    ' by design.',
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
      `${formatCount(result.responseTimeouts)} expected responses timed out.` +
      ' Only the counts above that point are comparable.',
    );
  }

  if (!result.exposeGc) {
    lines.push(
      'Collection was advisory, so counts can wobble between reads. Adding' +
      ' `launchOptions: soakLaunchOptions` to your config makes it exact.',
    );
  }

  return lines;
}

export function buildReport(result: SoakResult, heading: string): string {
  const blocks: string[][] = [
    [heading, ''],
    describeMetrics(result).map((l) => `  ${l}`),
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
    ? `"${result.label}" grew past its allowance, then stopped.`
    : `Memory leak detected in "${result.label}".`;
  return buildReport(result, heading);
}
