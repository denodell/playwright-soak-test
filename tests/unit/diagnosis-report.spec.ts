import { expect, test } from '@playwright/test';
import { describeDiagnosis, formatSoakReport } from '../../src/diagnose.js';
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
            { node: 'onRowClick', kind: 'closure', edge: { type: 'context', name: 'row' } },
            { node: '<li class="row">' },
          ]),
        ],
        objects: [],
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
    { node: 'onResize', kind: 'closure', edge: { type: 'context', name: 'root' } },
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
      objects: [],
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
      objects: [{ name: 'Object', delta: 90 }],
    }),
  ).join('\n');

  expect(lines).toContain('Elements are coming off the page and staying in memory');
  expect(lines).toContain('<div> +240');
  // Elements did come off the page, so the heap-only wording would be wrong.
  expect(lines).not.toContain('Nothing leaked from the DOM');
});

test('growth with nothing detached reads as a JavaScript leak', () => {
  const lines = describeDiagnosis(
    resultWith({ detached: [], objects: [{ name: 'AuditEntry', delta: 1000 }] }),
  ).join('\n');

  expect(lines).toContain('Nothing leaked from the DOM');
  expect(lines).toContain('AuditEntry +1,000');
});

test('nothing to say means no section at all', () => {
  expect(describeDiagnosis(resultWith({ detached: [], objects: [] }))).toEqual([]);
  expect(describeDiagnosis(resultWith({ detached: [], objects: [], note: 'ran out' }))).toEqual([
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
          { node: 'onRowClick', kind: 'closure', edge: { type: 'context', name: 'seen' } },
          { node: 'Array' },
          { node: '<li class="row">' },
        ]),
      ],
      objects: [],
    }),
  ).join('\n');

  expect(lines).not.toContain('is still registered');
  expect(lines).toContain('An array called `seen` keeps growing');
});

test('two kinds of element in the same array are one leak, not two', () => {
  const inHistory = (element: string): SoakRetainerHop[] => [
    { node: 'Window' },
    { node: 'record', kind: 'closure', edge: { type: 'context', name: 'history' } },
    { node: 'Array', edge: { type: 'element', name: element === '<li>' ? '0' : '1' } },
    { node: element },
  ];
  const lines = describeDiagnosis(
    resultWith({
      detached: [
        detached('Detached <li>', 30, inHistory('<li>')),
        detached('Detached <section>', 20, inHistory('<section>')),
      ],
      objects: [],
    }),
  ).join(' ').replace(/\s+/g, ' ');

  expect(lines).toContain(
    'An array called `history` keeps growing, and the <li> and <section> elements are still in it.',
  );
  expect(lines.match(/keeps growing/g)).toHaveLength(1);
});

test('the same shape of chain through two different variables stays two leaks', () => {
  const held = (variable: string, element: string): SoakRetainerHop[] => [
    { node: 'Window' },
    { node: 'record', kind: 'closure', edge: { type: 'context', name: variable } },
    { node: 'Array', edge: { type: 'element', name: '0' } },
    { node: element },
  ];
  const lines = describeDiagnosis(
    resultWith({
      detached: [
        detached('Detached <li>', 30, held('rows', '<li>')),
        detached('Detached <section>', 20, held('panels', '<section>')),
      ],
      objects: [],
    }),
  ).join(' ').replace(/\s+/g, ' ');

  expect(lines).toContain(
    'An array called `rows` keeps growing, and the <li> element is still in it.',
  );
  expect(lines).toContain(
    'An array called `panels` keeps growing, and the <section> element is still in it.',
  );
});

test('a heap object named like a built-in is not mistaken for a collection', () => {
  const lines = describeDiagnosis(
    resultWith({
      detached: [
        detached('Detached <li>', 30, [
          { node: 'Window' },
          { node: 'record', kind: 'closure', edge: { type: 'context', name: 'store' } },
          { node: 'constructor', edge: { type: 'property', name: 'row' } },
          { node: '<li>' },
        ]),
      ],
      objects: [],
    }),
  ).join(' ').replace(/\s+/g, ' ');

  expect(lines).toContain('`record` still references the <li> element.');
});

test('an array hung straight off the window is called an array', () => {
  const lines = describeDiagnosis(
    resultWith({
      detached: [
        detached('Detached <li>', 30, [
          { node: 'Window', edge: { type: 'property', name: 'cache' } },
          { node: 'Array', edge: { type: 'element', name: '0' } },
          { node: '<li class="row">' },
        ]),
      ],
      objects: [],
    }),
  ).join(' ').replace(/\s+/g, ' ');

  expect(lines).toContain(
    'An array at `window.cache` keeps growing, and the <li class="row"> element is still in it.',
  );
});

test.describe('formatSoakReport', () => {
  const walked = detached('Detached <li>', 30, [
    { node: 'Window', edge: { type: 'property', name: 'cache' } },
    { node: 'Array', edge: { type: 'element', name: '0' } },
    { node: '<li>' },
  ]);

  test('a leak gets the same text as the SoakLeakError message', () => {
    const result = resultWith({ detached: [walked], objects: [] }, climbing);
    result.failures = [{ metric: 'listeners', growth: 20, threshold: 0, trend: climbing }];
    const report = formatSoakReport(result);
    expect(report).toContain('Memory leak detected in "a run".');
    expect(report).toContain('An array at `window.cache` keeps growing');
  });

  test('a pass says so, and still shows a diagnosis when there is one', () => {
    const result = { ...resultWith({ detached: [walked], objects: [] }), leaking: false };
    const report = formatSoakReport(result);
    expect(report).toContain('No leak found in "a run".');
    expect(report).toContain('An array at `window.cache` keeps growing');
    // The explanation of what a leak looks like is only for a run that leaked.
    expect(report).not.toContain('This all assumes');
    expect(report).not.toContain('Find it:');
  });
});

test.describe('a leak in a real library, from Floating UI with its unsubscribe removed', () => {
  // The chain came back from a soak run against Floating UI's own test app. React
  // and the library sit near the root; the function that matters is near the end.
  const toThe = (element: SoakRetainerHop[]): SoakRetainerHop[] => [
    { node: 'Window' },
    { node: 'HTMLDocument' },
    {
      node: '<button class="bg-slate-200/90 …">',
      edge: { type: 'property', name: '__reactFiber$x' },
    },
    { node: 'FiberNode', edge: { type: 'context', name: 'rootContext.emit' } },
    { node: 'emit', kind: 'closure', edge: { type: 'context', name: 'map' } },
    { node: 'Map' },
    { node: 'Set' },
    ...element,
  ];
  const lines = describeDiagnosis(
    resultWith(
      {
        detached: [
          detached('Detached <div>', 195, toThe([
            { node: 'onOpenChange', kind: 'closure', edge: { type: 'context', name: 'floating' } },
            { node: '<div id=":r5:" role="dialog" class="bg-white …">' },
          ])),
          detached('Detached <span>', 195, toThe([
            {
              node: 'onOpenChange',
              kind: 'closure',
              edge: { type: 'context', name: 'fallbackEl' },
            },
            { node: '<span>' },
          ])),
        ],
        objects: [],
      },
      climbing,
    ),
  );
  const text = lines.join(' ').replace(/\s+/g, ' ');

  test('names the function nearest the leak, and the set it was never taken out of', () => {
    expect(text).toContain(
      '`onOpenChange` is still in a set, and it still references the <div id=":r5:" role="dialog"'
      + ' class="bg-white …"> and <span> elements.',
    );
    expect(text).not.toContain('`map`');
  });

  test('a long chain loses its middle near the root, and keeps the end', () => {
    const chain = lines.find((line) => line.includes('→'))!.trim();
    expect(chain).toBe(
      'window → … → FiberNode → emit() → Map → Set → onOpenChange()'
      + ' → <div id=":r5:" role="dialog" class="bg-white …">',
    );
  });
});

test.describe('elements that only Chrome is keeping', () => {
  // From a soak run that typed into Quill's editor. Between the window and the <br>
  // there were only Chrome's own objects, the undo history it keeps for typing.
  const result = resultWith(
    {
      detached: [
        detached('Detached <br>', 195, [{ node: 'Window' }, { node: '<br>' }]),
        detached('Detached Text', 195, [{ node: 'Window' }, { node: 'Text' }]),
      ],
      objects: [],
    },
    flat,
  );
  result.trends.nodes = climbing;
  const text = describeDiagnosis(result).join(' ').replace(/\s+/g, ' ');

  test('says your code is not the one keeping them, and names the likely cause', () => {
    expect(text).toContain(
      "Only Chrome's own objects still reference the <br> element and a text node, so your code"
      + " isn't keeping them. Typing into an editable area does this, because Chrome's undo"
      + ' history keeps the text it removes, for up to 1,000 steps.',
    );
    expect(text).not.toContain('Something still references');
  });

  test('and the summary above it stops saying your code references them', () => {
    const summary = formatSoakReport(result).replace(/\s+/g, ' ');
    expect(summary).toContain('Elements are leaving the page and staying in memory.');
    expect(summary).not.toContain('your code still references them');
  });

  test('Chrome objects in the middle of the chain still count as Chrome', () => {
    // From Ionic's alert test page, which logs every dismiss event with console.log.
    const ionic = describeDiagnosis(
      resultWith({
        detached: [
          detached('Detached <ion-alert>', 195, [
            { node: 'Window' },
            { node: 'HTMLDocument' },
            { node: 'StyleEngine', kind: 'browser' },
            { node: '<ion-alert id="ion-overlay-196" class="sc-ion-alert-md-h …">' },
          ]),
        ],
        objects: [],
      }),
    ).join(' ').replace(/\s+/g, ' ');
    expect(ionic).toContain("Only Chrome's own objects still reference the <ion-alert");
    expect(ionic).toContain('So does logging an object that refers to the element, like an event,');
    expect(ionic).toContain('window → document → StyleEngine →');
  });

  test('a class of yours that shares a name with a Chrome object is still yours', () => {
    const yours = describeDiagnosis(
      resultWith({
        detached: [
          detached('Detached <div>', 30, [
            { node: 'Window' },
            { node: 'StyleEngine' },
            { node: '<div class="panel">' },
          ]),
        ],
        objects: [],
      }),
    ).join(' ');
    expect(yours).not.toContain("Chrome's own objects");
  });

  test('a property on the window is your code, so that chain is not blamed on Chrome', () => {
    const yours = describeDiagnosis(
      resultWith({
        detached: [
          detached('Detached <div>', 30, [
            { node: 'Window', edge: { type: 'property', name: 'lastPanel' } },
            { node: '<div class="panel">' },
          ]),
        ],
        objects: [],
      }),
    ).join(' ');
    expect(yours).not.toContain("Chrome's own objects");
    expect(yours).toContain('window.lastPanel');
  });
});
