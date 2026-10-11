import { expect, test } from '@playwright/test';
import {
  buildFailureMessage,
  describeDiagnosis,
  formatDuration,
  formatSoakReport,
  interpret,
} from '../../src/diagnose.js';
import type {
  SoakDetachedClass,
  SoakDiagnosis,
  SoakResult,
  SoakRetainerHop,
  SoakTrend,
} from '../../src/types.js';

// The sentences the report picks between, one case each.

const flat: SoakTrend = { perPass: 0, r2: 1, total: 0, shape: 'flat' };
const linear = (total: number, perPass = 2): SoakTrend => ({ perPass, r2: 0.99, total, shape: 'linear' });
const settled = (total: number): SoakTrend => ({ perPass: 0, r2: 0.5, total, shape: 'settled' });
const stepped = (total: number, at: number): SoakTrend =>
  ({ perPass: 0, r2: 0, total, shape: 'step', stepAtPass: at });
const noisy = (total: number): SoakTrend => ({ perPass: 1, r2: 0.1, total, shape: 'noisy' });

function result(
  { nodes = flat, listeners = flat }: { nodes?: SoakTrend; listeners?: SoakTrend },
  extra: Partial<SoakResult> = {},
): SoakResult {
  const failures: SoakResult['failures'] = [];
  if (listeners.total > 0) failures.push({ metric: 'listeners', growth: listeners.total, threshold: 0, trend: listeners });
  if (nodes.total > 100) failures.push({ metric: 'nodes', growth: nodes.total, threshold: 100, trend: nodes });
  return {
    label: 'a run',
    passes: 25,
    warmup: 5,
    baseline: { heap: 0, nodes: 0, listeners: 0, documents: 1 },
    after: { heap: 0, nodes: 0, listeners: 0, documents: 1 },
    samples: [],
    trends: { nodes, listeners, heap: flat },
    failures,
    leaking: failures.length > 0,
    thresholds: { nodes: 100, listeners: 0, heap: null },
    clock: { enabled: false, advanceMs: 0, virtualElapsedMs: null },
    exposeGc: true,
    responseTimeouts: 0,
    ...extra,
  };
}

const leakOf = (path: SoakRetainerHop[], delta = 40, className = 'Detached <li>'): SoakDetachedClass => ({
  className,
  baseline: 0,
  after: delta,
  delta,
  retainerPath: path,
});

const diagnosed = (detached: SoakDetachedClass[], objects: SoakDiagnosis['objects'] = []) => ({
  diagnosis: { detached, objects },
});

const text = (lines: string[]): string => lines.join('\n').replace(/\n(?! )/g, ' ');

test.describe('formatDuration', () => {
  test('reads in minutes, hours, or both', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * 60_000)).toBe('45m');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
  });
});

test.describe('interpret', () => {
  test('listeners that jumped once are a one-off, with the threshold to raise', () => {
    const out = text(interpret(result({ listeners: stepped(3, 7) })));
    expect(out).toContain('Listeners jumped once at pass 7 and have stayed there.');
    expect(out).toContain('Raise the threshold above 3');
  });

  test('a count that climbed early and leveled off reads as a cache, for either count', () => {
    expect(text(interpret(result({ nodes: settled(150) })))).toContain(
      'DOM nodes climbed early on and have been flat since.',
    );
    const listeners = text(interpret(result({ listeners: settled(4) })));
    expect(listeners).toContain('Listeners climbed early on');
    expect(listeners).toContain('this looks more like a cache filling up.');
    expect(listeners).toContain('Raise the threshold above 4');
  });

  test('nodes and listeners climbing together point at the listeners, until the snapshots know better', () => {
    const guessing = text(interpret(result({ nodes: linear(200, 8), listeners: linear(25, 1) })));
    expect(guessing).toContain('Every pass leaks 8 nodes and 1 listener.');
    expect(guessing).toContain('The listeners are probably what is keeping those nodes in memory.');

    const named = text(
      interpret(
        result(
          { nodes: linear(200, 8), listeners: linear(25, 1) },
          diagnosed([leakOf([{ node: 'Window' }, { node: 'EventListener' }, { node: '<li>' }])]),
        ),
      ),
    );
    expect(named).toContain('Every pass leaks');
    expect(named).not.toContain('probably');
  });

  test('a leak that isn\'t a whole number a pass is given as an average', () => {
    expect(text(interpret(result({ nodes: linear(200, 39.8), listeners: linear(25, 0.5) })))).toContain(
      'Every pass leaks 39.8 nodes and 0.5 listeners on average.',
    );
    expect(text(interpret(result({ nodes: linear(2000, 1200), listeners: linear(50, 2) })))).toContain(
      'Every pass leaks 1,200 nodes and 2 listeners.',
    );
  });

  test('a listener on its own is one added every pass and never removed', () => {
    expect(text(interpret(result({ listeners: linear(25, 1) })))).toContain(
      'Your app adds a listener every pass and never removes it.',
    );
  });

  test('growing nodes are blamed on your code only when something of yours holds them', () => {
    const guessing = text(interpret(result({ nodes: linear(200) })));
    expect(guessing).toContain('Elements are leaving the page but your code still references them.');
    expect(guessing).toContain('Usually an array that keeps growing');

    const chromeOnly = text(
      interpret(
        result(
          { nodes: linear(200) },
          diagnosed([leakOf([{ node: 'Window' }, { node: 'StyleEngine', kind: 'browser' }, { node: '<li>' }])]),
        ),
      ),
    );
    expect(chromeOnly).toContain('Elements are leaving the page and staying in memory.');
    expect(chromeOnly).not.toContain('Usually');
  });

  test('uneven growth says it might be noise', () => {
    expect(text(interpret(result({ nodes: noisy(150) })))).toContain('this might just be noise');
  });
});

test.describe('describeDiagnosis', () => {
  test('says nothing without a diagnosis', () => {
    expect(describeDiagnosis(result({ nodes: linear(200) }))).toEqual([]);
  });

  test('past the leaks it describes, it counts the rest', () => {
    const at = (name: string): SoakDetachedClass =>
      leakOf(
        [{ node: 'Window', edge: { type: 'property', name } }, { node: `Panel ${name}` }, { node: '<li>' }],
        10,
        `Detached <${name}>`,
      );
    const four = describeDiagnosis(result({ nodes: linear(200) }, diagnosed(['a', 'b', 'c', 'd'].map(at))));
    expect(text(four)).toContain('One more leak looks like this one.');

    const five = describeDiagnosis(result({ nodes: linear(200) }, diagnosed(['a', 'b', 'c', 'd', 'e'].map(at))));
    expect(text(five)).toContain('2 more leaks look like this one.');
  });

  test('detached elements that no chain reached are listed by count', () => {
    const out = text(
      describeDiagnosis(
        result({ nodes: linear(200) }, diagnosed([leakOf([], 30, 'Detached <li>'), leakOf([], 4, 'Detached <p>')])),
      ),
    );
    expect(out).toContain('Elements are coming off the page and staying in memory: <li> +30, <p> +4.');
    expect(out).toContain('Nothing turned up that still references them.');
  });

  test('a note on its own is the whole diagnosis', () => {
    const lines = describeDiagnosis(
      result({ nodes: linear(200) }, {
        diagnosis: { detached: [], objects: [], note: 'Diagnosis stopped: the disk is full' },
      }),
    );
    expect(lines).toEqual(['Diagnosis stopped: the disk is full']);
  });

  test('a function that grew is named with brackets', () => {
    const out = text(
      describeDiagnosis(
        result({ nodes: linear(200) }, diagnosed([], [{ name: 'onTick', kind: 'closure', delta: 9 }])),
      ),
    );
    expect(out).toContain('The growth is in onTick() +9.');
  });
});

test.describe('what holds a leak', () => {
  const describe = (path: SoakRetainerHop[], extra: Partial<SoakResult> = {}, what?: string[]): string => {
    const detached = what
      ? what.map((name, i) => leakOf([...path.slice(0, -1), { node: name }], 10 - i, `Detached ${name}`))
      : [leakOf(path)];
    return text(describeDiagnosis(result({ nodes: linear(200), ...extra.trends }, { ...diagnosed(detached), ...extra })));
  };

  test('a pending timer opens the sentence', () => {
    const out = describe([
      { node: 'Window' },
      { node: 'a pending timer', kind: 'timer' },
      { node: 'tick', kind: 'closure', edge: { type: 'context', name: 'tile' } },
      { node: '<div class="tile">' },
    ]);
    expect(out).toContain('A timer is still pending. Its callback `tick` still references');
  });

  test('a listener whose target is the first thing in the chain is still named as a listener', () => {
    const out = text(
      describeDiagnosis(
        result(
          { nodes: linear(200), listeners: linear(25, 1) },
          diagnosed([
            leakOf([
              { node: 'EventListener' },
              { node: 'onClick', kind: 'closure', edge: { type: 'context', name: 'row' } },
              { node: '<li>' },
            ]),
          ]),
        ),
      ),
    );
    expect(out).toContain('A listener is still registered. Its callback `onClick` still references');
  });

  test('an array hung off a global, with no function in between, is named by where it hangs', () => {
    const out = describe(
      [
        { node: 'Window', edge: { type: 'property', name: 'cache' } },
        { node: 'Array', edge: { type: 'element', name: '3' } },
        { node: '<li>' },
      ],
      {},
      ['<li>', '<p>'],
    );
    expect(out).toContain('An array at `window.cache` keeps growing, and the <li> and <p> elements are still in it.');
  });

  test('a collection with no name to give it is still described', () => {
    const out = describe([
      { node: 'Store' },
      { node: 'update', kind: 'closure' },
      { node: 'Map' },
      { node: '<li>' },
    ]);
    expect(out).toContain('A map keeps growing, and the <li> element is still in it.');
  });

  test('a function with nothing anchoring it is named on its own', () => {
    const out = describe([
      { node: 'Store' },
      { node: 'render', kind: 'closure', edge: { type: 'context', name: 'el' } },
      { node: '<li>' },
    ]);
    expect(out).toContain('`render` still references the <li> element.');
  });

  test('a global with no function is named by its property', () => {
    const out = describe([
      { node: 'Window', edge: { type: 'property', name: '__panel' } },
      { node: 'Panel' },
      { node: '<section>' },
    ]);
    expect(out).toContain('Something on `window.__panel` still references the <section> element.');
  });

  test('with nothing to go on, it says only that something does', () => {
    expect(describe([{ node: 'Store' }, { node: '<li>' }])).toContain(
      'Something still references the <li> element.',
    );
    // A chain that is only the leaked object has no holder to group it by.
    expect(describe([{ node: '<li>' }])).toContain('Something still references the <li> element.');
  });

  test('past three leaked kinds it counts the rest, and leaves text nodes to the end', () => {
    const path: SoakRetainerHop[] = [
      { node: 'Window', edge: { type: 'property', name: 'rows' } },
      { node: 'Array', edge: { type: 'element', name: '0' } },
      { node: '<li>' },
    ];
    const many = describe(path, {}, ['<li>', '<p>', '<span>', '<em>', 'Text']);
    expect(many).toContain('the <li>, <p>, and 2 more elements and a text node are still in it.');

    const textOnly = describe(path, {}, ['Text']);
    expect(textOnly).toContain('and a text node is still in it.');

    const mixed = describe(path, {}, ['<li>', 'Panel']);
    expect(mixed).toContain('the <li> and Panel are still in it.');
  });

  test('the chain prints the document by name', () => {
    const out = describe([
      { node: 'Window' },
      { node: 'HTMLDocument' },
      { node: 'StyleEngine', kind: 'browser' },
      { node: '<li>' },
    ]);
    expect(out).toContain('window → document → StyleEngine → <li>');
  });
});

test.describe('the report around it', () => {
  test('lists the notes about how the run was measured', () => {
    const report = formatSoakReport(
      result(
        {},
        {
          passes: 200,
          clock: { enabled: true, advanceMs: 18_000, virtualElapsedMs: null },
          responseTimeouts: 3,
          exposeGc: false,
        },
      ),
    );
    // With no reading of the virtual clock, it works the time out from the passes.
    expect(report).toContain('200 passes x 18s of virtual time = 1h of app time.');
    expect(report).toContain('3 waits for a response timed out');
    expect(report).toContain('Chromium was started without `--expose-gc`');
  });

  test('each count says how it grew: not at all, all at once, early on, or every pass', () => {
    const shrank: SoakTrend = { perPass: -1, r2: 0.9, total: -20, shape: 'linear' };
    expect(formatSoakReport(result({ nodes: shrank }))).toMatch(/DOM nodes\s+-20 .* no growth/);
    expect(formatSoakReport(result({ nodes: stepped(150, 4) }))).toMatch(/DOM nodes .* all at once, at pass 4/);
    expect(formatSoakReport(result({ nodes: settled(150) }))).toMatch(
      /DOM nodes .* climbed early, then leveled off/,
    );
    expect(formatSoakReport(result({ listeners: linear(25, 1) }))).toMatch(
      /Listeners .* \+1\.0 per pass, R²=0\.99/,
    );
  });

  test('a passing run with nothing to note is the heading and the counts', () => {
    const report = formatSoakReport(result({}));
    expect(report.split('\n')[0]).toBe('No leak found in "a run".');
    expect(report).not.toContain('Find it');
  });

  test('a leak with its snapshots kept says they can be opened', () => {
    const message = buildFailureMessage(
      result(
        { nodes: linear(200) },
        { diagnosis: { detached: [], objects: [], snapshots: { baseline: 'a', after: 'b' } } },
      ),
    );
    expect(message).toContain('Both snapshots from this run are attached');
  });

  test('a one-off gets a heading that says it stopped', () => {
    expect(buildFailureMessage(result({ nodes: stepped(150, 2) })).split('\n')[0]).toBe(
      '"a run" grew past its threshold, then stopped.',
    );
  });
});
