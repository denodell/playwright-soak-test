import type { Page } from '@playwright/test';
import { expect, test } from '../../src/index.js';
import { describeDiagnosis } from '../../src/diagnose.js';
import { SoakLeakError } from '../../src/soak.js';

const PASSES = 25;

test.use({ soakOptions: { clock: false, passes: PASSES, diagnose: 'on-failure' } });

function openAndCloseInspector(page: Page): Promise<void> {
  return page.evaluate(async () => {
    await window.__inspector.open();
    window.__inspector.close();
  });
}

test('names the component that leaked and the registry holding it', async ({ page, soak }) => {
  await page.goto('/leak/');
  await page.waitForFunction(() => window.__inspector !== undefined);

  const error = await soak.run(() => openAndCloseInspector(page)).then(
    () => null,
    (e: unknown) => e,
  );

  expect(error).toBeInstanceOf(SoakLeakError);
  const { result } = error as SoakLeakError;
  const diagnosis = result.diagnosis!;

  // React unmounts the tree, so nothing is on the page, but the registry still
  // has every section and everything it rendered.
  const classes = diagnosis.detached.map((d) => d.className);
  expect(classes).toContain('Detached <section>');
  expect(classes).toContain('Detached <div>');
  expect(classes).toContain('Detached <span>');

  const section = diagnosis.detached.find((d) => d.className === 'Detached <section>')!;
  expect(section.delta).toBe(PASSES - result.warmup);

  // The panel is a separate chunk, so the raw chain runs through the loader's
  // Module and Generator objects. Neither is the reader's to change, and the name
  // worth keeping, `mounted`, is on the far side of them.
  const chain = section.retainerPath;
  expect(chain).toEqual([
    { node: 'Window', edge: { type: 'property', name: '__drawer' } },
    { node: 'closure openDrawer', edge: { type: 'context', name: 'mounted' } },
    { node: 'Map' },
    { node: '<section class="inspector">' },
  ]);

  // The fiber tree is not in the chain. React detaches it on unmount, so what is
  // left holding the DOM is the app's own registry.
  expect(chain.some((hop) => hop.node.includes('Fiber'))).toBe(false);

  const report = describeDiagnosis(result).join('\n');
  expect(report).toContain('`mounted`');
  expect(report).toContain('<section class="inspector">');

  // Four detached classes, one leak, said once.
  expect(report.match(/still references/g)).toHaveLength(1);
});

test('the fixed build removes itself from the registry and stays flat', async ({ page, soak }) => {
  await page.goto('/fixed/');
  await page.waitForFunction(() => window.__inspector !== undefined);

  const result = await soak.measure(() => openAndCloseInspector(page));

  expect(result.leaking).toBe(false);
  expect(result.trends.nodes.total).toBeLessThanOrEqual(0);
});
