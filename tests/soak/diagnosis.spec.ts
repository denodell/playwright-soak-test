import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';
import { SoakLeakError } from '../../src/soak.js';

const PASSES = 25;

test.use({ soakOptions: { clock: false, passes: PASSES, diagnose: 'on-failure' } });

function snapshotsIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.heapsnapshot'));
}

function openAndCloseDrawer(page: Page): Promise<void> {
  return page.evaluate(() => {
    window.__drawer.open();
    window.__drawer.close();
  });
}

test('names the drawer as one leak, and the listener holding it', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const error = await soak.run(() => openAndCloseDrawer(page)).then(
    () => null,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;
  const diagnosis = result.diagnosis;

  expect(diagnosis).toBeDefined();

  // The drawer is a <section> of rows, so the section, its divs, its spans and
  // its heading all go detached together and each one is counted.
  const classes = diagnosis!.detached.map((d) => d.className);
  expect(classes).toContain('Detached <section>');
  expect(classes).toContain('Detached <div>');
  expect(classes).toContain('Detached <span>');

  const section = diagnosis!.detached.find((d) => d.className === 'Detached <section>')!;
  expect(section.delta).toBe(PASSES - result.warmup);

  // Every chain runs root first and ends on the thing that leaked.
  const walked = diagnosis!.detached.filter((d) => d.retainerPath.length);
  expect(walked.length).toBeGreaterThan(0);
  for (const entry of walked) expect(entry.retainerPath[0]!.node).toBe('Window');

  // `onResize` is the listener the leaking build never removes, and `root` is the
  // variable it captured, so the report has to name both.
  const chain = section.retainerPath;
  expect(chain.map((hop) => hop.node)).toEqual([
    'Window',
    'EventListener',
    'closure onResize',
    '<section class="report-drawer">',
  ]);
  expect(chain.find((hop) => hop.node === 'closure onResize')!.edge).toEqual({
    type: 'context',
    name: 'root',
  });

  // Four detached classes make one finding, said once in a sentence.
  expect(message).toContain('A listener on window is still registered');
  expect(message).toContain('`onResize` still references');
  // The box and the trend line already give the rate, so the sentence does not.
  expect(message).not.toContain('one per pass');
  // `root` is the variable name for the thing the sentence already describes.
  expect(message).not.toContain('captured `root`');
  expect(message).toContain('window \u2192 EventListener \u2192 onResize()');
  expect(message).not.toContain('Detached <div>');
  // And it stops guessing at a cause once the snapshots have named one.
  expect(message).not.toContain('probably what is keeping those nodes');
});

test('the array on window shows up as heap growth, with nothing detached', async ({
  page,
  soak,
}) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__auditTrail !== undefined);

  const error = await soak
    .run(() => page.evaluate(() => window.__auditTrail.record()), { heapThresholdPercent: 5 })
    .then(
      () => null,
      (e: unknown) => e,
    );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;

  // Nothing reaches the page, so the counts a soak run watches stay put and only
  // the heap threshold fails the run.
  expect(result.failures.map((f) => f.metric)).toEqual(['heap']);
  expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(2);
  expect(result.trends.listeners.total).toBe(0);

  const diagnosis = result.diagnosis!;
  expect(diagnosis.detached).toEqual([]);

  const entries = diagnosis.growth.find((g) => g.name === 'AuditEntry');
  expect(entries).toBeDefined();
  expect(entries!.delta).toBeGreaterThanOrEqual((PASSES - result.warmup) * 50);

  expect(message).toContain('the growth is in plain data rather than DOM');
  expect(message).toContain('AuditEntry');
});

test('a timer leak is not blamed on the clock this library installed', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__ticker !== undefined);

  const error = await soak
    .run(async () => {
      await page.evaluate(() => {
        window.__ticker.open();
        window.__ticker.close();
      });
      await page.clock.runFor(30_000);
    })
    .then(
      () => null,
      (e: unknown) => e,
    );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;

  const tile = result.diagnosis!.detached.find((d) => d.className === 'Detached <section>')!;
  expect(tile.retainerPath.map((hop) => hop.node)).toEqual([
    'a pending timer',
    'closure tick',
    '<section class=\"live-tile\">',
  ]);

  expect(message).toContain('A timer is still pending');
  expect(message).toContain('`tick` still references');
  // None of Playwright's clock reaches the report, or the JSON behind it.
  for (const text of [message, JSON.stringify(result.diagnosis)]) {
    expect(text).not.toContain('ClockController');
    expect(text).not.toContain('__pwClock');
  }
});

test('the fixed build keeps its diagnosis to itself and leaves no snapshots behind', async ({
  page,
  soak,
}, testInfo) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.run(() => openAndCloseDrawer(page));

  expect(result.leaking).toBe(false);
  expect(result.diagnosis).toBeUndefined();
  expect(snapshotsIn(testInfo.outputPath())).toEqual([]);
});

test('diagnose: always reports on a run that passed, and attaches both snapshots', async ({
  page,
  soak,
}, testInfo) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.run(() => openAndCloseDrawer(page), {
    diagnose: 'always',
    keepSnapshots: true,
  });

  expect(result.leaking).toBe(false);
  expect(result.diagnosis).toBeDefined();
  expect(result.diagnosis!.note).toBeUndefined();
  expect(result.diagnosis!.snapshots).toBeDefined();
  expect(fs.existsSync(result.diagnosis!.snapshots!.baseline)).toBe(true);
  expect(fs.existsSync(result.diagnosis!.snapshots!.after)).toBe(true);

  const attached = testInfo.attachments.map((a) => a.name);
  expect(attached).toContain('soak-heap-baseline');
  expect(attached).toContain('soak-heap-after');
});

test('the diagnosis lands, and the snapshots go, unless they are asked for', async ({
  page,
  soak,
}, testInfo) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.measure(() => openAndCloseDrawer(page));

  // The whole finding, from files that no longer exist.
  const diagnosis = result.diagnosis!;
  expect(diagnosis.detached.length).toBeGreaterThan(0);
  expect(diagnosis.detached[0]!.retainerPath.length).toBeGreaterThan(0);
  expect(diagnosis.note).toBeUndefined();

  // Hundreds of megabytes a failing test, on a real app, so they are not kept
  // without being asked for.
  expect(diagnosis.snapshots).toBeUndefined();
  expect(snapshotsIn(testInfo.outputPath())).toEqual([]);
  expect(testInfo.attachments.map((a) => a.name)).not.toContain('soak-heap-after');
});

test('diagnose: off takes no snapshots at all', async ({ page, soak }, testInfo) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.measure(() => openAndCloseDrawer(page), { diagnose: 'off' });

  expect(result.leaking).toBe(true);
  expect(result.diagnosis).toBeUndefined();
  expect(snapshotsIn(testInfo.outputPath())).toEqual([]);
});

test('running out of diagnoseTimeoutMs leaves a note rather than failing the run', async ({
  page,
  soak,
}) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.measure(() => openAndCloseDrawer(page), {
    diagnose: 'always',
    diagnoseTimeoutMs: 1,
  });

  // The run itself is unaffected. The counts and the verdict are the same.
  expect(result.leaking).toBe(true);
  expect(result.trends.listeners.total).toBe(PASSES - result.warmup);

  const diagnosis = result.diagnosis!;
  expect(diagnosis.note).toContain('diagnoseTimeoutMs');
  expect(diagnosis.detached).toEqual([]);
  expect(diagnosis.growth).toEqual([]);
  expect(diagnosis.snapshots).toBeUndefined();
});

test('two runs in one test keep their own snapshots', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const twice = { diagnose: 'always', keepSnapshots: true } as const;
  const first = await soak.run(() => openAndCloseDrawer(page), twice);
  const second = await soak.run(() => openAndCloseDrawer(page), twice);

  const a = first.diagnosis!.snapshots!;
  const b = second.diagnosis!.snapshots!;

  // Same test, same output directory, same label. Sharing a filename would mean
  // the second run wrote over the first, and a discard would delete files the
  // first result still points at.
  expect(a.baseline).not.toBe(b.baseline);
  expect(a.after).not.toBe(b.after);
  for (const file of [a.baseline, a.after, b.baseline, b.after]) {
    expect(fs.existsSync(file), `${file} is missing`).toBe(true);
  }
});

test('a flow that throws does not leave its baseline snapshot behind', async ({
  page,
  soak,
}, testInfo) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  let passes = 0;
  const boom = new Error('the flow gave up');
  const thrown = await soak
    .run(async () => {
      await openAndCloseDrawer(page);
      // Late enough that the baseline snapshot is already on disk.
      if (++passes > 8) throw boom;
    })
    .then(
      () => null,
      (e: unknown) => e,
    );

  expect(thrown).toBe(boom);
  expect(snapshotsIn(testInfo.outputPath())).toEqual([]);
});

test.describe('with diagnosis left alone', () => {
  test.use({ soakOptions: { clock: false, passes: PASSES } });

  test('a failing run says nothing extra until diagnosis is asked for', async ({
    page,
    soak,
  }, testInfo) => {
    await page.goto('/leak/');
    await page.waitForFunction(() => window.__drawer !== undefined);

    const error = await soak.run(() => openAndCloseDrawer(page)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SoakLeakError);
    const { result, message } = error as SoakLeakError;

    // Off is the default, so an existing suite upgrading to this version takes no
    // snapshots and reads exactly as it did before.
    expect(result.diagnosis).toBeUndefined();
    expect(snapshotsIn(testInfo.outputPath())).toEqual([]);
    expect(message).not.toContain('is still registered');
    // And with no snapshots to read, the report falls back to guessing.
    expect(message).toContain('probably what is keeping those nodes');
  });
});
