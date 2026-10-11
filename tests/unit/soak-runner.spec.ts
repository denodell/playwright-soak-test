import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { installSoakClock } from '../../src/clock.js';
import { measureSoak, runSoak, SoakLeakError } from '../../src/soak.js';
import { FakeCdp, fakePage, fakeTestInfo } from './fakes.js';

// The runner against a fake page, for the cases the browser tests can't set up:
// no `--expose-gc`, no test around the run, and a clock that was never installed.

// A snapshot the parser rejects, so a run gets all the way to reading it and stops there.
const UNREADABLE_SNAPSHOT =
  '{"snapshot":{"meta":{"node_fields":[],"node_types":[[]],"edge_fields":[],"edge_types":[[]]}},'
  + '"nodes":[],"edges":[],"strings":[]}';

const flatPage = (exposeGc = true) => {
  const cdp = new FakeCdp().metrics(() => ({ Nodes: 500, JSEventListeners: 10, JSHeapUsedSize: 1e6 }));
  return fakePage({ cdp, evaluate: async () => exposeGc });
};

test('the clock has to be installed before a run that uses it', async () => {
  const { page, sessionsOpened } = flatPage();
  await expect(runSoak(page, async () => { })).rejects.toThrow(
    'The virtual clock has to be installed before the app loads.',
  );
  // It stops before touching the page.
  expect(sessionsOpened()).toBe(0);
});

test('outside a test the run is labelled generically and nothing is attached', async () => {
  const { page } = flatPage();
  const result = await measureSoak(page, async () => { }, {
    clock: false,
    passes: 4,
    warmup: 2,
    diagnose: 'off',
  });
  expect(result.label).toBe('soak run');
  expect(result.leaking).toBe(false);
  expect(result.clock).toEqual({ enabled: false, advanceMs: 0, virtualElapsedMs: null });
});

test('outside a test, a failing run still gets its diagnosis', async () => {
  let nodes = 500;
  const cdp = new FakeCdp().metrics(() => ({ Nodes: (nodes += 10) }));
  cdp.streams(UNREADABLE_SNAPSHOT);
  const { page } = fakePage({ cdp });
  const result = await measureSoak(page, async () => { }, {
    clock: false,
    passes: 6,
    warmup: 2,
    nodeThreshold: 5,
  });
  expect(result.leaking).toBe(true);
  // With no test, only diagnoseTimeout limits it, and it ran as far as reading the snapshots.
  expect(result.diagnosis?.note).toContain('heap snapshot has no "type" field');
});

test('without --expose-gc it warns once, however many runs there are', async () => {
  const warnings: string[] = [];
  const counts: number[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  try {
    for (let i = 0; i < 2; i++) {
      const { page } = flatPage(false);
      const result = await measureSoak(page, async () => { }, {
        clock: false,
        passes: 4,
        warmup: 2,
        diagnose: 'off',
      });
      expect(result.exposeGc).toBe(false);
      counts.push(warnings.length);
    }
  } finally {
    console.warn = original;
  }

  // The worker may have warned before this test, so only the second run is sure to be silent.
  expect(counts[1]).toBe(counts[0]);
  for (const warning of warnings) expect(warning).toContain('launchOptions: soakLaunchOptions');
});

test('a run in a test with no timeout leaves the diagnosis its own limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-runner-'));
  try {
    let nodes = 500;
    const cdp = new FakeCdp().metrics(() => ({ Nodes: (nodes += 10) }));
    cdp.streams(UNREADABLE_SNAPSHOT);
    const { page } = fakePage({ cdp });
    await installSoakClock(page);
    const { testInfo, attached } = fakeTestInfo(dir, { timeout: 0, title: 'grows every pass' });

    const error = await runSoak(page, async () => { }, {
      passes: 6,
      warmup: 2,
      nodeThreshold: 5,
      testInfo,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SoakLeakError);
    const { result } = error as SoakLeakError;
    expect(result.label).toBe('grows every pass');
    expect(result.clock.enabled).toBe(true);
    // The snapshots got as far as parsing, which a test with no timeout never cuts short.
    expect(result.diagnosis?.note).toBe(
      'Diagnosis stopped: [playwright-soak-test] heap snapshot has no "type" field',
    );
    expect(attached.map((a) => a.name)).toEqual(['soak-metrics']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
