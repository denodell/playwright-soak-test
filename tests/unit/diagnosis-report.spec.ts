import { expect, test } from '@playwright/test';
import { describeDiagnosis } from '../../src/diagnose.js';
import type { SoakDiagnosis, SoakResult, SoakRetainerHop } from '../../src/types.js';

const flat = { perPass: 0, r2: 1, total: 0, shape: 'flat' } as const;
const climbing = { perPass: 1, r2: 1, total: 20, shape: 'linear' } as const;

function resultWith(
  diagnosis: SoakDiagnosis,
  listeners: SoakResult['trends']['listeners'] = flat,
): SoakResult {
  return {
    label: 'a run',
    passes: 25,
    warmup: 5,
    baseline: { heap: 0, nodes: 0, listeners: 0, documents: 1 },
    after: { heap: 0, nodes: 0, listeners: 0, documents: 1 },
    samples: [],
    trends: { nodes: flat, listeners, heap: flat },
    failures: [],
    leaking: true,
    thresholds: { nodes: 100, listeners: 0, heap: null },
    clock: { enabled: false, advanceMs: 0, virtualElapsedMs: null },
    exposeGc: true,
    responseTimeouts: 0,
    diagnosis,
  };
}

const detached = (
  className: string,
  delta: number,
  retainerPath: SoakRetainerHop[],
): SoakDiagnosis['detached'][number] => ({
  className,
  baseline: 0,
  after: delta,
  delta,
  retainerPath,
});

test('names what the listener is registered on, rather than assuming window', () => {
  const lines = describeDiagnosis(
    resultWith(
      {
        detached: [
          detached('Detached <li>', 40, [
            { node: 'Window' },
            { node: '<div id="host">' },
            { node: 'EventListener' },
            { node: 'closure onRowClick', edge: { type: 'context', name: 'row' } },
            { node: '<li class="row">' },
          ]),
        ],
        growth: [],
      },
      climbing,
    ),
  ).join('\n');

  expect(lines).toContain('A listener on <div id="host"> is still registered');
  expect(lines).not.toContain('on window');
});

test('a chain longer than the printed cap still folds into one leak', () => {
  // Nine hops, so the printed line is elided. The container and its contents are
  // one bug, and the grouping has to see that on the full chain rather than the
  // truncated one.
  const chain: SoakRetainerHop[] = [
    { node: 'Window' },
    { node: 'EventListener' },
    { node: 'closure onResize', edge: { type: 'context', name: 'root' } },
    { node: 'Wrapper' },
    { node: 'Panel' },
    { node: 'Body' },
    { node: 'Inner' },
    { node: 'Deeper' },
    { node: '<section class="drawer">' },
  ];

  const lines = describeDiagnosis(
    resultWith({
      detached: [
        detached('Detached <div>', 400, [...chain, { node: '<div class="row">' }]),
        detached('Detached <section>', 40, chain),
      ],
      growth: [],
    }, climbing),
  );

  // One sentence, not one per detached class. The phrase appears once even though
  // the sentence itself wraps across lines.
  expect(lines.filter((l) => l.includes('is still registered'))).toHaveLength(1);
  expect(lines.join(' ')).toContain('<section class="drawer">');

  // The printed chain is capped, but both ends survive so it still reads.
  const printed = lines.find((l) => l.includes('→'))!;
  expect(printed).toContain('…');
  expect(printed.trim().startsWith('window')).toBe(true);
  expect(printed).toContain('<section class="drawer">');
});

test('detached classes with no walkable chain are reported, not called clean', () => {
  const lines = describeDiagnosis(
    resultWith({
      detached: [detached('Detached <div>', 240, []), detached('Detached <span>', 220, [])],
      growth: [{ name: 'Object', delta: 90 }],
    }),
  ).join('\n');

  expect(lines).toContain('Elements are coming off the page and staying in memory');
  expect(lines).toContain('<div> +240');
  // Elements did come off the page, so the heap-only wording would be wrong.
  expect(lines).not.toContain('Nothing leaked from the DOM');
});

test('growth with nothing detached reads as a JavaScript leak', () => {
  const lines = describeDiagnosis(
    resultWith({ detached: [], growth: [{ name: 'AuditEntry', delta: 1000 }] }),
  ).join('\n');

  expect(lines).toContain('Nothing leaked from the DOM');
  expect(lines).toContain('AuditEntry +1,000');
});

test('nothing to say means no section at all', () => {
  expect(describeDiagnosis(resultWith({ detached: [], growth: [] }))).toEqual([]);
  expect(describeDiagnosis(resultWith({ detached: [], growth: [], note: 'ran out' }))).toEqual([
    'ran out',
  ]);
});

test('a delegated listener that never leaked is not blamed for the array it holds', () => {
  // One listener, registered once and deliberately never removed, whose handler
  // closes over an array that grows. `EventListener` is in the chain, but the
  // listener count never moved, so the listener is not what leaked.
  const lines = describeDiagnosis(
    resultWith({
      detached: [
        detached('Detached <li>', 400, [
          { node: 'Window' },
          { node: 'EventListener' },
          { node: 'closure onRowClick', edge: { type: 'context', name: 'seen' } },
          { node: 'Array' },
          { node: '<li class="row">' },
        ]),
      ],
      growth: [],
    }),
  ).join('\n');

  expect(lines).not.toContain('is still registered');
  expect(lines).toContain('An array called `seen` keeps growing');
});
