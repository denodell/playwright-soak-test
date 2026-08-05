import { expect, test } from '../../src/index.js';

const PASSES = 60;
const MEASURED = PASSES - 5;

test.use({ soakOptions: { clock: false, passes: PASSES } });

test('the fixed build stays flat over 55 open and close cycles', async ({ page, soak }) => {
  await page.goto('/fixed/');
  const toggle = page.getByRole('button', { name: 'Report' });
  const close = page.locator('#drawer-close');
  await toggle.waitFor();

  const result = await soak.run(async () => {
    await toggle.click();
    await close.click();
  });

  expect(result.leaking).toBe(false);
  expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(2);
  expect(result.trends.listeners.total).toBe(0);
});

test('the leak build gains a listener and 40 nodes every time the drawer opens and closes', async ({ page, soak }) => {
  await page.goto('/leak/');
  const toggle = page.getByRole('button', { name: 'Report' });
  const close = page.locator('#drawer-close');
  await toggle.waitFor();

  const result = await soak.measure(async () => {
    await toggle.click();
    await close.click();
  });

  expect(result.trends.listeners.total).toBe(MEASURED);

  expect(result.trends.nodes.perPass).toBeGreaterThanOrEqual(40);
  expect(result.trends.nodes.shape).toBe('linear');
  expect(result.trends.nodes.total).toBeGreaterThanOrEqual(MEASURED * 40);
});
