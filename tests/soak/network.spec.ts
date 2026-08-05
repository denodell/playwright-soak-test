import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';

const PASSES = 20;
const MEASURED = PASSES - 5;

test.use({ soakOptions: { passes: PASSES, clock: false } });

function openAndClose(page: Page): Promise<void> {
  return page.evaluate(async () => {
    await window.__feed.open();
    window.__feed.close();
  });
}

async function realFeedBody(request: APIRequestContext): Promise<string> {
  const body = await (await request.get('/api/feed')).text();
  await request.get('/__counter/reset');
  return body;
}

test('the real 196-item feed leaks 589 nodes a pass', async ({ page, soak, request }) => {
  const feed = await realFeedBody(request);
  await page.route('**/api/feed', (route) => route.fulfill({ body: feed, contentType: 'application/json' }));

  await page.goto('/leak/');
  await page.waitForFunction(() => window.__feed !== undefined);

  const result = await soak.measure(() => openAndClose(page));

  expect(Math.abs(result.trends.nodes.total - (MEASURED * (1 + 196 * 3)))).toBeLessThanOrEqual(2);
  expect(result.leaking).toBe(true);
});

test('a one-item stub leaks 4 nodes a pass and comes back clean', async ({ page, soak }) => {
  const stub = JSON.stringify({ items: [{ id: 'evt-00000' }] });
  await page.route('**/api/feed', (route) => route.fulfill({ body: stub, contentType: 'application/json' }));

  await page.goto('/leak/');
  await page.waitForFunction(() => window.__feed !== undefined);

  const result = await soak.measure(() => openAndClose(page));

  expect(Math.abs(result.trends.nodes.total - (MEASURED * (1 + 1 * 3)))).toBeLessThanOrEqual(2);
  expect(result.leaking).toBe(false);
});

test('the fixed build ends with the node count it started with', async ({ page, soak, request }) => {
  const feed = await realFeedBody(request);
  await page.route('**/api/feed', (route) => route.fulfill({ body: feed, contentType: 'application/json' }));

  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__feed !== undefined);

  const result = await soak.measure(() => openAndClose(page));

  expect(Math.abs(result.trends.nodes.total)).toBeLessThanOrEqual(2);
  expect(result.leaking).toBe(false);
});

test('heapThresholdPercent catches a response body kept out of the DOM', async ({ page, soak }) => {
  let n = 0;
  await page.route('**/api/feed', (route) => {
    const blob = String(n++).padStart(6, '0').repeat(8_000);
    route.fulfill({ body: JSON.stringify({ items: [], blob }), contentType: 'application/json' });
  });

  await page.goto('/leak/');
  await page.waitForFunction(() => window.__feed !== undefined);

  const kept = await soak.measure(() => openAndClose(page));
  const heapPercent = ((kept.after.heap - kept.baseline.heap) / kept.baseline.heap) * 100;

  expect(Math.abs(kept.trends.nodes.total - MEASURED)).toBeLessThanOrEqual(2);
  expect(kept.trends.listeners.total).toBe(0);
  expect(heapPercent).toBeGreaterThan(50);
  expect(kept.leaking).toBe(false);

  await page.goto('/leak/');
  await page.waitForFunction(() => window.__feed !== undefined);
  const asserted = await soak.measure(() => openAndClose(page), { heapThresholdPercent: 25 });

  expect(asserted.leaking).toBe(true);
  expect(asserted.failures.map((f) => f.metric)).toEqual(['heap']);
});
