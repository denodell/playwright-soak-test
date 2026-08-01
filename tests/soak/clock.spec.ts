import { expect, test } from '../../src/index.js';
import { PAUSE_AFTER_MS } from '../../src/clock.js';

const PASSES = 200;
const STEP_MS = 30_000;

test.use({ soakOptions: { passes: PASSES, clock: { advanceMs: STEP_MS } } });

test('the poller fires once a pass, and the route handler handles them all', async ({
  page,
  soak,
  request,
}) => {
  const feed = await (await request.get('/api/feed')).text();
  await request.get('/__counter/reset');

  let routeHits = 0;
  await page.route('**/api/feed', async (route) => {
    routeHits++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: feed,
    });
  });

  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.run(
    () =>
      page.evaluate(() => {
        window.__drawer.open();
        window.__drawer.close();
      }),
    { waitForResponse: '**/api/feed' },
  );

  expect(result.responseTimeouts).toBe(0);
  expect(routeHits).toBe(PASSES + 1);
  expect(result.clock.virtualElapsedMs).toBe(PAUSE_AFTER_MS + PASSES * STEP_MS);

  const counter = await (await request.get('/__counter')).json();
  expect(counter.feedRequests).toBe(0);

  expect(result.leaking).toBe(false);
  expect(result.trends.listeners.total).toBe(0);
});

test('the default 200 passes add up to an hour of app time', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__drawer !== undefined);

  const result = await soak.run(
    () =>
      page.evaluate(() => {
        window.__drawer.open();
        window.__drawer.close();
      }),
    { passes: 200, clock: { advanceMs: 18_000 } },
  );

  expect(result.clock.virtualElapsedMs).toBe(PAUSE_AFTER_MS + 200 * 18_000);
  expect((result.clock.virtualElapsedMs ?? 0) - PAUSE_AFTER_MS).toBe(60 * 60 * 1000);
});
