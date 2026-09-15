import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';
import { SoakLeakError } from '../../src/soak.js';

const PASSES = 25;

test.use({ soakOptions: { clock: false, passes: PASSES } });

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
  // variable it captured, so those two are the answer the report has to give.
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

  // Four detached classes, one bug: the report says it once, in a sentence.
  expect(message).toContain('A listener on window was never removed');
  expect(message).toContain('`onResize` captured `root`');
  expect(message).toContain('window \u2192 EventListener \u2192 onResize()');
  expect(message).not.toContain('Detached <div>');
  // And it stops guessing at a cause once it has found one.
  expect(message).not.toContain('Most often a listener stays registered');
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

  expect(message).toContain('this is data the app keeps');
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

  expect(message).toContain('A timer was never cleared');
  expect(message).toContain('`tick` captured `state`');
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

  const result = await soak.run(() => openAndCloseDrawer(page), { diagnose: 'always' });

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

  // The run itself is unaffected: the counts are still the counts.
  expect(result.leaking).toBe(true);
  expect(result.trends.listeners.total).toBe(PASSES - result.warmup);

  const diagnosis = result.diagnosis!;
  expect(diagnosis.note).toContain('diagnoseTimeoutMs');
  expect(diagnosis.detached).toEqual([]);
  expect(diagnosis.growth).toEqual([]);
  expect(diagnosis.snapshots).toBeUndefined();
});
