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

test('names the detached class the drawer leaves behind, and the listener holding it', async ({
  page,
  soak,
}) => {
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

  // The drawer is a <section> holding rows of <div><span>, so all three go
  // detached together and each one should be named.
  const classes = diagnosis!.detached.map((d) => d.className);
  expect(classes).toContain('Detached <section>');
  expect(classes).toContain('Detached <div>');
  expect(classes).toContain('Detached <span>');

  const section = diagnosis!.detached.find((d) => d.className === 'Detached <section>')!;
  expect(section.delta).toBe(PASSES - result.warmup);
  expect(section.after).toBeGreaterThan(section.baseline);

  // `onResize` is the listener the leaking build never removes, so it is the
  // line of code the report has to lead back to.
  const paths = diagnosis!.detached.filter((d) => d.retainerPath.length);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.some((d) => d.retainerPath.some((hop) => hop.includes('closure onResize')))).toBe(
    true,
  );
  // Every chain that was walked ends at whatever is rooting it.
  for (const entry of paths) expect(entry.retainerPath.at(-1)).toBe('Window');

  expect(diagnosis!.growth.map((g) => g.name)).toContain('closure onResize');

  expect(message).toContain('Retained by');
  expect(message).toContain('closure onResize');
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

  expect(message).toContain('Growing in the heap');
  expect(message).toContain('AuditEntry');
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
