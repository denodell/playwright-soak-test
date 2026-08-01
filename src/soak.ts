import type { Page } from '@playwright/test';
import { attachCdp, hasExposeGc, readMetrics } from './cdp.js';
import {
  advanceSoakClock,
  isSoakClockInstalled,
  pauseSoakClock,
  virtualElapsedMs,
} from './clock.js';
import { buildFailureMessage } from './diagnose.js';
import { formatCount, formatElapsed, formatSigned, percentGrowth, trendOf } from './stats.js';
import type {
  ResolvedSoakOptions,
  SoakAction,
  SoakFailure,
  SoakMetrics,
  SoakOptions,
  SoakResult,
  SoakRunOptions,
  SoakSample,
} from './types.js';

export class SoakLeakError extends Error {
  readonly result: SoakResult;

  constructor(message: string, result: SoakResult) {
    super(message);
    this.name = 'SoakLeakError';
    this.result = result;
  }
}

// Launch options that make collection reliable. Set as `launchOptions` in your config.
export const soakLaunchOptions: { args: string[] } = {
  args: ['--js-flags=--expose-gc'],
};

const DEFAULTS = {
  passes: 200,
  warmup: 5,
  nodeAllowance: 100,
  listenerAllowance: 0,
  heapAllowancePercent: null,
  gcPasses: 2,
  tracePasses: 25,
  waitForResponseTimeout: 5_000,
  progressEveryMs: 30_000,
  clockAdvanceMs: 18_000,
} as const;

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[playwright-soak-test] ${message}`);
}

export function mergeSoakOptions(base: SoakOptions = {}, override: SoakOptions = {}): SoakOptions {
  const merged: SoakOptions = { ...base, ...override };
  if (base.clock === false || override.clock === false) merged.clock = false;
  return merged;
}

export function resolveSoakOptions(
  options: SoakOptions = {},
  fallbackLabel = 'soak run',
): ResolvedSoakOptions {
  const passes = options.passes ?? DEFAULTS.passes;
  const warmup = options.warmup ?? DEFAULTS.warmup;
  const measured = passes - warmup;

  if (measured < 2) {
    throw new Error(
      `[playwright-soak-test] passes (${passes}) must leave at least 2 after the warmup` +
      ` (${warmup}). Raise passes or lower warmup.`,
    );
  }

  return {
    passes,
    warmup,
    nodeAllowance: options.nodeAllowance ?? DEFAULTS.nodeAllowance,
    listenerAllowance: options.listenerAllowance ?? DEFAULTS.listenerAllowance,
    heapAllowancePercent: options.heapAllowancePercent ?? DEFAULTS.heapAllowancePercent,
    gcPasses: options.gcPasses ?? DEFAULTS.gcPasses,
    progressEveryMs: options.progressEveryMs ?? DEFAULTS.progressEveryMs,
    tracePasses: options.tracePasses ?? DEFAULTS.tracePasses,
    sampleEvery: options.sampleEvery ?? Math.max(1, Math.ceil(measured / 25)),
    waitForResponseTimeout: options.waitForResponseTimeout ?? DEFAULTS.waitForResponseTimeout,
    clock:
      options.clock === false
        ? false
        : { advanceMs: options.clock?.advanceMs ?? DEFAULTS.clockAdvanceMs },
    waitForResponse: options.waitForResponse,
    label: options.label ?? fallbackLabel,
  };
}

async function executeSoak(
  page: Page,
  action: SoakAction,
  { testInfo, ...options }: SoakRunOptions,
  throwOnLeak: boolean,
): Promise<SoakResult> {
  const opts = resolveSoakOptions(options, testInfo?.title);
  const clockInstalled = isSoakClockInstalled(page);

  if (opts.clock && !clockInstalled) {
    throw new Error(
      '[playwright-soak-test] The virtual clock has to be installed before the app loads.' +
      ' Use the `soak` fixture, or call `installSoakClock(page)` ahead of your first' +
      ' `page.goto`, or turn the clock off with `soakOptions: { clock: false }`.',
    );
  }

  const cdp = await attachCdp(page);

  if (clockInstalled) await pauseSoakClock(page);

  const exposeGc = await hasExposeGc(page);
  if (!exposeGc) {
    warnOnce(
      'expose-gc',
      'Forced collection is advisory in this browser, so node counts can wobble between reads.' +
      ' Adding `launchOptions: soakLaunchOptions` to your Playwright config makes it exact.',
    );
  }

  let responseTimeouts = 0;
  const read = (): Promise<SoakMetrics> => readMetrics(cdp, { gcPasses: opts.gcPasses });

  const startedAt = Date.now();
  let lastReportAt = startedAt;
  let done = 0;
  let baselineMetrics: SoakMetrics | null = null;
  let latestMetrics: SoakMetrics | null = null;

  const reportProgress = (): void => {
    if (!opts.progressEveryMs) return;
    const now = Date.now();
    if (now - lastReportAt < opts.progressEveryMs) return;
    lastReportAt = now;

    const counts =
      baselineMetrics && latestMetrics
        ? `nodes ${formatSigned(latestMetrics.nodes - baselineMetrics.nodes)},` +
        ` listeners ${formatSigned(latestMetrics.listeners - baselineMetrics.listeners)}`
        : 'warming up';

    console.log(
      `[playwright-soak-test] ${opts.label}: ${formatCount(done)}/${formatCount(opts.passes)}` +
      ` passes, ${formatElapsed(now - startedAt)}, ${counts}`,
    );
  };

  const onePass = async (): Promise<void> => {
    const landed =
      opts.waitForResponse === undefined
        ? null
        : page
          .waitForResponse(opts.waitForResponse, { timeout: opts.waitForResponseTimeout })
          .catch(() => {
            responseTimeouts++;
            return null;
          });

    await action();
    if (opts.clock) await advanceSoakClock(page, opts.clock.advanceMs);
    if (landed) await landed;
  };

  for (let i = 0; i < opts.warmup; i++) {
    await onePass();
    done++;
    reportProgress();
  }

  const baseline = await read();
  baselineMetrics = baseline;
  latestMetrics = baseline;
  const samples: SoakSample[] = [{ pass: 0, ...baseline }];
  const measured = opts.passes - opts.warmup;

  for (let pass = 1; pass <= measured; pass++) {
    await onePass();
    done++;
    const traced = pass <= opts.tracePasses;
    const sampled = pass % opts.sampleEvery === 0;
    if (pass !== measured && (traced || sampled)) {
      const sample = await read();
      latestMetrics = sample;
      samples.push({ pass, ...sample });
    }
    reportProgress();
  }

  const after = await read();
  samples.push({ pass: measured, ...after });

  const trends = {
    nodes: trendOf(samples, 'nodes', baseline.nodes, after.nodes),
    listeners: trendOf(samples, 'listeners', baseline.listeners, after.listeners),
    heap: trendOf(samples, 'heap', baseline.heap, after.heap),
  };

  const failures: SoakFailure[] = [];
  if (trends.listeners.total > opts.listenerAllowance) {
    failures.push({
      metric: 'listeners',
      growth: trends.listeners.total,
      allowance: opts.listenerAllowance,
      trend: trends.listeners,
    });
  }
  if (trends.nodes.total > opts.nodeAllowance) {
    failures.push({
      metric: 'nodes',
      growth: trends.nodes.total,
      allowance: opts.nodeAllowance,
      trend: trends.nodes,
    });
  }
  if (opts.heapAllowancePercent !== null) {
    const pct = percentGrowth(baseline.heap, after.heap);
    if (pct > opts.heapAllowancePercent) {
      failures.push({
        metric: 'heap',
        growth: pct,
        allowance: opts.heapAllowancePercent,
        trend: trends.heap,
      });
    }
  }

  const result: SoakResult = {
    label: opts.label,
    passes: opts.passes,
    warmup: opts.warmup,
    baseline,
    after,
    samples,
    trends,
    failures,
    leaking: failures.length > 0,
    allowances: {
      nodes: opts.nodeAllowance,
      listeners: opts.listenerAllowance,
      heap: opts.heapAllowancePercent,
    },
    clock: {
      enabled: Boolean(opts.clock),
      advanceMs: opts.clock ? opts.clock.advanceMs : 0,
      virtualElapsedMs: clockInstalled ? await virtualElapsedMs(page) : null,
    },
    exposeGc,
    responseTimeouts,
  };

  if (testInfo) {
    await testInfo.attach('soak-metrics', {
      body: JSON.stringify(result),
      contentType: 'application/json',
    });
  }

  if (result.leaking && throwOnLeak) throw new SoakLeakError(buildFailureMessage(result), result);

  return result;
}

export function runSoak(
  page: Page,
  action: SoakAction,
  options: SoakRunOptions = {},
): Promise<SoakResult> {
  return executeSoak(page, action, options, true);
}

export function measureSoak(
  page: Page,
  action: SoakAction,
  options: SoakRunOptions = {},
): Promise<SoakResult> {
  return executeSoak(page, action, options, false);
}
