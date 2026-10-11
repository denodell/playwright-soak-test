import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { TestCase, TestResult } from '@playwright/test/reporter';
import SoakReporter from '../../src/reporter.js';
import type { SoakFailure, SoakResult, SoakTrend } from '../../src/types.js';

const flat: SoakTrend = { perPass: 0, r2: 1, total: 0, shape: 'flat' };
const climbing: SoakTrend = { perPass: 2, r2: 0.99, total: 40, shape: 'linear' };
const stepped: SoakTrend = { perPass: 0, r2: 0, total: 150, shape: 'step', stepAtPass: 3 };

function soakResult(label: string, failures: SoakFailure[] = []): SoakResult {
  const trendFor = (metric: SoakFailure['metric']): SoakTrend =>
    failures.find((f) => f.metric === metric)?.trend ?? flat;
  return {
    label,
    passes: 25,
    warmup: 5,
    baseline: { heap: 1_000_000, nodes: 500, listeners: 10, documents: 1 },
    after: { heap: 1_100_000, nodes: 500, listeners: 10, documents: 1 },
    samples: [],
    trends: { nodes: trendFor('nodes'), listeners: trendFor('listeners'), heap: trendFor('heap') },
    failures,
    leaking: failures.length > 0,
    thresholds: { nodes: 100, listeners: 0, heap: null },
    clock: { enabled: false, advanceMs: 0, virtualElapsedMs: null },
    exposeGc: true,
    responseTimeouts: 0,
  };
}

const passing = (label = 'a clean run'): SoakResult => soakResult(label);
const leaking = (label = 'a leaky run'): SoakResult =>
  soakResult(label, [{ metric: 'listeners', growth: 40, threshold: 0, trend: climbing }]);
const oneOff = (label = 'a one-off'): SoakResult =>
  soakResult(label, [{ metric: 'nodes', growth: 150, threshold: 100, trend: stepped }]);

type Attachment = TestResult['attachments'][number];

const attachmentOf = (result: SoakResult): Attachment => ({
  name: 'soak-metrics',
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(result)),
});

function report(
  reporter: SoakReporter,
  title: string,
  attachments: Attachment[],
): void {
  reporter.onTestEnd({ title } as TestCase, { attachments } as TestResult);
}

// The reporter writes to the console and reads a few environment variables, so
// each test runs with a clean slate of both and gets back what was printed.
async function capture(
  env: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<string> {
  const keys = ['NO_COLOR', 'FORCE_COLOR', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);

  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    await run();
  } finally {
    console.log = original;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  return lines.join('\n');
}

test.describe('SoakReporter', () => {
  test('boxes a passing run with no diagnosis under it', async () => {
    const out = await capture({}, () => {
      const reporter = new SoakReporter();
      report(reporter, 'clean', [attachmentOf(passing())]);
      reporter.onEnd({} as never);
    });

    expect(out).toContain('a clean run');
    expect(out).toContain('PASS');
    expect(out).not.toContain('passes, warmup');
    // One row is already in its box, so there's no summary table to add.
    expect(out).not.toContain('SOAK SUMMARY');
  });

  test('calls a steady climb a leak, says how long the run was, and prints the diagnosis', async () => {
    const result: SoakResult = {
      ...leaking(),
      diagnosis: {
        detached: [],
        objects: [{ name: 'AuditEntry', delta: 40 }],
        note: 'Diagnosis stopped after 60000ms (diagnoseTimeout).',
      },
    };
    const out = await capture({}, () => {
      report(new SoakReporter(), 'leaky', [attachmentOf(result)]);
    });

    expect(out).toContain('LEAK DETECTED');
    expect(out).toContain('25 passes, warmup 5');
    // Under the box, indented, with the blank line between paragraphs left blank.
    expect(out).toContain('┘\n  Nothing leaked from the DOM. The growth is in AuditEntry +40.\n\n  Diagnosis stopped');
  });

  test('calls growth that came all at once over the threshold, not a leak', async () => {
    const out = await capture({}, () => {
      report(new SoakReporter(), 'one-off', [attachmentOf(oneOff())]);
    });

    expect(out).toContain('OVER THRESHOLD');
    expect(out).not.toContain('LEAK DETECTED');
  });

  test('tabulates two or more runs with a verdict each', async () => {
    const out = await capture({}, () => {
      const reporter = new SoakReporter();
      report(reporter, 'first', [attachmentOf(passing())]);
      report(reporter, 'second', [attachmentOf(leaking())]);
      report(reporter, 'third', [attachmentOf(oneOff())]);
      reporter.onEnd({} as never);
    });

    const summary = out.slice(out.indexOf('SOAK SUMMARY'));
    expect(summary).toMatch(/first\s+\+0\s+\+0\s+\+10\.00%\s+PASS/);
    expect(summary).toMatch(/second\s+\+0\s+\+40\s+\+10\.00%\s+LEAK/);
    expect(summary).toMatch(/third\s+\+150\s+\+0\s+\+10\.00%\s+OVER/);
  });

  test('stays quiet at the end when no test ran a soak', async () => {
    const out = await capture({}, () => {
      const reporter = new SoakReporter();
      report(reporter, 'not a soak', [
        { name: 'screenshot', contentType: 'image/png', body: Buffer.from('') },
      ]);
      reporter.onEnd({} as never);
    });

    expect(out).toBe('');
  });

  test('reads an attachment saved to disk, and skips one it cannot read', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-reporter-'));
    try {
      const saved = path.join(dir, 'soak-metrics.json');
      fs.writeFileSync(saved, JSON.stringify(passing('from disk')));

      const out = await capture({}, () => {
        report(new SoakReporter(), 'mixed', [
          { name: 'soak-metrics', contentType: 'application/json', path: saved },
          { name: 'soak-metrics', contentType: 'application/json', path: path.join(dir, 'gone.json') },
          { name: 'soak-metrics', contentType: 'application/json', body: Buffer.from('{not json') },
          { name: 'soak-metrics', contentType: 'application/json' },
        ]);
      });

      expect(out).toContain('from disk');
      expect(out.match(/┌/g)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('colors the output on a terminal that asks for it, and not under NO_COLOR', async () => {
    const run = (): void => {
      const reporter = new SoakReporter();
      report(reporter, 'first', [attachmentOf(passing())]);
      report(reporter, 'second', [attachmentOf(leaking())]);
      report(reporter, 'third', [attachmentOf(oneOff())]);
      reporter.onEnd({} as never);
    };

    const colored = await capture({ FORCE_COLOR: '1' }, run);
    expect(colored).toContain('\u001b[32mPASS');
    expect(colored).toContain('\u001b[31mLEAK DETECTED');
    expect(colored).toContain('\u001b[33mOVER THRESHOLD');
    expect(colored).toContain('\u001b[33mOVER\u001b[0m');
    expect(colored).toContain('\u001b[31mLEAK\u001b[0m');

    const plain = await capture({ FORCE_COLOR: '1', NO_COLOR: '1' }, run);
    expect(plain).not.toContain('\u001b[');
  });

  test('on GitHub Actions, a leak becomes an error annotation on one line', async () => {
    const out = await capture({ GITHUB_ACTIONS: 'true' }, () => {
      const reporter = new SoakReporter();
      report(reporter, 'clean', [attachmentOf(passing())]);
      report(reporter, 'leaky', [attachmentOf(leaking('100% leaky'))]);
    });

    const annotations = out.split('\n').filter((l) => l.startsWith('::error'));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain('::error title=Soak: 100% leaky::');
    // Newlines and percent signs are escaped, so the whole report fits the one line.
    expect(annotations[0]).toContain('%0A');
    expect(annotations[0]).toContain('100%25 leaky');
  });

  test('writes a results table to the GitHub step summary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-summary-'));
    try {
      const summary = path.join(dir, 'summary.md');
      await capture({ GITHUB_STEP_SUMMARY: summary }, () => {
        const reporter = new SoakReporter();
        report(reporter, 'clean', [attachmentOf(passing())]);
        report(reporter, 'leaky', [attachmentOf(leaking())]);
        reporter.onEnd({} as never);
      });

      const written = fs.readFileSync(summary, 'utf8');
      expect(written).toContain('## Soak test results');
      expect(written).toContain('| clean | +0 | +0 | +10.00% | pass |');
      expect(written).toContain('| leaky | +0 | +40 | +10.00% | **leak** |');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a step summary it cannot write does not fail the run', async () => {
    const out = await capture(
      { GITHUB_STEP_SUMMARY: path.join(os.tmpdir(), 'no-such-dir', 'summary.md') },
      () => {
        const reporter = new SoakReporter();
        report(reporter, 'clean', [attachmentOf(passing())]);
        expect(() => reporter.onEnd({} as never)).not.toThrow();
      },
    );

    expect(out).toContain('PASS');
  });
});
