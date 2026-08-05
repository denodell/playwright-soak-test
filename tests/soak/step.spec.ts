import { expect, test } from '../../src/index.js';
import { SoakLeakError } from '../../src/soak.js';

const PASSES = 30;
const WARMUP = 5;
const BUSY_PASS = 15;
const SMALL = 2;
const BUSY = 60;

const STEP_NODES = (BUSY - SMALL) * 3;

function flow(page: import('@playwright/test').Page, rows: number): Promise<void> {
  return page.evaluate((count) => {
    window.__pool.show(count);
    window.__pool.show(0);
  }, rows);
}

test.use({ soakOptions: { passes: PASSES, warmup: WARMUP, clock: false } });

test('calls a single jump a one-off and names the threshold to raise', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__pool !== undefined);

  let pass = 0;
  const error = await soak
    .run(() => flow(page, ++pass === BUSY_PASS ? BUSY : SMALL))
    .then(
      () => null,
      (e: unknown) => e,
    );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result, message } = error as SoakLeakError;

  expect(Math.abs(result.trends.nodes.total - STEP_NODES)).toBeLessThanOrEqual(2);
  expect(result.trends.nodes.shape).toBe('step');
  expect(result.trends.nodes.stepAtPass).toBe(BUSY_PASS - WARMUP);

  expect(message).toContain('grew past its threshold, then stopped');
  expect(message).not.toContain('Memory leak detected');
  expect(message).toContain('jumped once at pass');
  expect(message).toContain('and the count has been flat since');
  expect(message).toContain(`Raise the threshold above ${result.trends.nodes.total}`);

  expect(message).not.toMatch(/\u001b\[/);
});

test('raising the threshold to the size of the jump lets the run pass', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__pool !== undefined);

  let pass = 0;
  const result = await soak.measure(
    () => flow(page, ++pass === BUSY_PASS ? BUSY : SMALL),
    { nodeThreshold: STEP_NODES },
  );

  expect(result.leaking).toBe(false);
  expect(Math.abs(result.trends.nodes.total - STEP_NODES)).toBeLessThanOrEqual(2);
});
