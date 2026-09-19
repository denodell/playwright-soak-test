import type { Response, TestInfo } from '@playwright/test';

/** One reading, taken after a forced collection. */
export interface SoakMetrics {
  /** `JSHeapUsedSize`, in bytes. Recorded for diagnosis, not asserted on by default. */
  heap: number;
  /** `Nodes`, the DOM nodes the renderer still keeps, attached or not. */
  nodes: number;
  /** `JSEventListeners`, the count of registered listeners. */
  listeners: number;
  /** `Documents`, recorded for diagnosis. */
  documents: number;
}

export interface SoakSample extends SoakMetrics {
  /** Passes completed since the baseline reading. The baseline itself is pass 0. */
  pass: number;
}

/** A least-squares fit of one metric against the pass number. */
export interface SoakTrend {
  /** Growth per pass, from the fitted line. */
  perPass: number;
  /** Coefficient of determination. 1 is a perfect straight line. */
  r2: number;
  /** Last reading minus the baseline reading. */
  total: number;
  /** What the samples look like, used to tell a leak from a one-off. */
  shape: 'flat' | 'linear' | 'step' | 'settled' | 'noisy';
  /** For a step, the pass the jump happened on. */
  stepAtPass?: number;
}

export interface SoakClockOptions {
  /** Virtual milliseconds advanced after every pass. 18,000 over 200 passes covers an hour. */
  advanceMs?: number;
}

/**
 * When a run takes heap snapshots. Default `'on-failure'`. The baseline one has to
 * be taken before the outcome is known, so every run takes it and a run that ends
 * up passing throws it away again. On a real app that is a few seconds a run, and
 * `'off'` skips it.
 */
export type SoakDiagnoseMode = 'on-failure' | 'always' | 'off';

export interface SoakOptions {
  /** Total passes, including the warmup. Default 200. */
  passes?: number;
  /** Passes before the baseline reading, so first-open code and data land first. Default 5. */
  warmup?: number;
  /** DOM node growth allowed across the run, fixed rather than a percentage. Default 100. */
  nodeThreshold?: number;
  /** Listener growth allowed across the run. Default 0. */
  listenerThreshold?: number;
  /** Heap growth allowed, as a percentage of the baseline. Default `null`, which reports only. */
  heapThresholdPercent?: number | null;
  /**
   * Milliseconds between progress lines. A run of a few seconds finishes before
   * the first one is due, so short runs stay quiet. Default 30,000; 0 for silence.
   */
  progressEveryMs?: number;
  /** Collections forced before each reading. Default 2; the second matters on framework apps. */
  gcPasses?: number;
  /** Passes read individually at the start of the run. Default 25. */
  tracePasses?: number;
  /** Read every Nth pass after the traced window. Defaults to about 25 samples. */
  sampleEvery?: number;
  /**
   * Virtual clock, on by default. Turning it off has to happen in your config or
   * `test.use`, since installation runs before the app loads.
   */
  clock?: SoakClockOptions | false;
  /**
   * Response awaited around each clock advance. Pair it with `page.route`, since
   * the clock fakes timers and leaves the network alone.
   */
  waitForResponse?: string | RegExp | ((response: Response) => boolean);
  /** Timeout for `waitForResponse`, in ms. Default 5,000. */
  waitForResponseTimeout?: number;
  /** Name used in the failure message and the reporter. Defaults to the test title. */
  label?: string;
  /**
   * Heap snapshots either side of the run, diffed to name what leaked and what
   * still references it. Default `'on-failure'`.
   */
  diagnose?: SoakDiagnoseMode;
  /**
   * Attach both snapshots to the test result, for opening in DevTools → Memory.
   * Default `false`, since a real app's pair runs to hundreds of megabytes per
   * failing test. The diagnosis is worked out either way; this only decides
   * whether the files outlive it.
   */
  keepSnapshots?: boolean;
  /**
   * Budget for the snapshot work, in ms. Default 60,000. Going over abandons the
   * diagnosis with a note on the result rather than failing the test.
   */
  diagnoseTimeoutMs?: number;
}

export type ResolvedSoakOptions = Required<Omit<SoakOptions, 'clock' | 'waitForResponse' | 'label'>> & {
  clock: Required<SoakClockOptions> | false;
  waitForResponse?: SoakOptions['waitForResponse'];
  label: string;
};

export interface SoakFailure {
  metric: 'nodes' | 'listeners' | 'heap';
  growth: number;
  threshold: number;
  trend: SoakTrend;
}

/**
 * One link in a retainer chain, with the name of the slot holding the next one.
 * Structured rather than pre-formatted, because the reporter reads the result
 * back out of a JSON attachment and regroups and relabels it from there.
 */
export interface SoakRetainerHop {
  /** The retainer itself, such as `window`, `EventListener` or `closure onResize`. */
  node: string;
  /** How this link reaches the next one. Absent on the last link and on unnamed edges. */
  edge?: { type: 'property' | 'element' | 'context'; name: string };
  /**
   * Set where several hops were folded into one and `node` is a phrase rather
   * than something from the heap. The report reads this instead of matching on
   * the wording.
   */
  kind?: 'timer';
}

/** One class of detached DOM node, and what is keeping an example of it alive. */
export interface SoakDetachedClass {
  /** The snapshot's own name for it, such as `Detached HTMLDivElement`. */
  className: string;
  baseline: number;
  after: number;
  delta: number;
  /**
   * Retainers of one example, root first and the leaked object last, with the
   * internal hops collapsed. Empty when no path was walked, or none reached the
   * root.
   */
  retainerPath: SoakRetainerHop[];
}

/** A JS constructor or closure whose node count went up across the run. */
export interface SoakGrowth {
  name: string;
  delta: number;
}

export interface SoakDiagnosis {
  /** Every detached class that grew, largest first. */
  detached: SoakDetachedClass[];
  /** The JS names that grew most, for leaks that never touch the DOM. */
  growth: SoakGrowth[];
  /** Where the two snapshots were written, when they were kept. */
  snapshots?: { baseline: string; after: string };
  /** What cut the diagnosis short, when something did. */
  note?: string;
}

export interface SoakResult {
  label: string;
  passes: number;
  warmup: number;
  baseline: SoakMetrics;
  after: SoakMetrics;
  samples: SoakSample[];
  trends: Record<'nodes' | 'listeners' | 'heap', SoakTrend>;
  failures: SoakFailure[];
  leaking: boolean;
  thresholds: { nodes: number; listeners: number; heap: number | null };
  clock: { enabled: boolean; advanceMs: number; virtualElapsedMs: number | null };
  /** Whether `--js-flags=--expose-gc` was present, which is what makes collection reliable. */
  exposeGc: boolean;
  /** Responses that timed out, when `waitForResponse` is set. */
  responseTimeouts: number;
  /** What the heap snapshots found. Absent when diagnosis was off or not wanted. */
  diagnosis?: SoakDiagnosis;
}

export type SoakAction = () => Promise<void> | void;

export interface SoakRunOptions extends SoakOptions {
  /** Playwright's `TestInfo`, so the numbers reach the reporter as an attachment. */
  testInfo?: TestInfo;
}

export interface Soak {
  /** Repeat `action`, and throw `SoakLeakError` when a count grows past its threshold. */
  run(action: SoakAction, options?: SoakOptions): Promise<SoakResult>;
  /** The same run, returning the result whether or not a count grew too far. */
  measure(action: SoakAction, options?: SoakOptions): Promise<SoakResult>;
}
