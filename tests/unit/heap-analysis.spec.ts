import { expect, test } from '@playwright/test';
import {
  buildRetainerPath,
  diffSnapshots,
  growthNameOf,
  pathForClass,
  shortElementName,
} from '../../src/heap-analysis.js';
import { parseHeapSnapshot } from '../../src/heap-snapshot.js';
import { fixture, nodeNamed } from './heap-fixtures.js';

const after = fixture('retained-drawer');
const baseline = fixture('retained-drawer-baseline');
const clock = fixture('pending-timer');

test.describe('buildRetainerPath', () => {
  test('runs root first and hands the context variable to the closure', () => {
    const card = nodeNamed(after, '<div class="card">');
    expect(buildRetainerPath(after, after.retainerPath(card)!)).toEqual([
      { node: 'Window' },
      { node: 'EventListener' },
      { node: 'handleClick', kind: 'closure', edge: { type: 'context', name: 'el' } },
      { node: '<div class="card">' },
    ]);
  });

  test('keeps an element index on a JS array and drops it between DOM nodes', () => {
    const entry = nodeNamed(after, 'AuditEntry');
    expect(buildRetainerPath(after, after.retainerPath(entry)!)).toEqual([
      { node: 'Window', edge: { type: 'property', name: '__sink' } },
      { node: 'Array', edge: { type: 'element', name: '3' } },
      { node: 'AuditEntry' },
    ]);

    const label = nodeNamed(after, '<span>');
    expect(buildRetainerPath(after, after.retainerPath(label)!).map((h) => h.node)).toEqual([
      'Window',
      'EventListener',
      'handleClick',
      '<div class="card">',
      '<span>',
    ]);
  });

  test("collapses the injected clock, so a leak is not blamed on Playwright's plumbing", () => {
    const tile = nodeNamed(clock, '<div class="tile">');
    expect(buildRetainerPath(clock, clock.retainerPath(tile)!)).toEqual([
      { node: 'a pending timer', kind: 'timer', edge: { type: 'property', name: 'func' } },
      { node: 'tick', kind: 'closure', edge: { type: 'context', name: 'state' } },
      { node: '<div class="tile">' },
    ]);
  });
});

test.describe('growthNameOf', () => {
  test('names a closure for its function and an object for its constructor', () => {
    expect(growthNameOf(after, nodeNamed(after, 'handleClick'))).toBe('closure handleClick');
    expect(growthNameOf(after, nodeNamed(after, 'AuditEntry'))).toBe('AuditEntry');
    expect(growthNameOf(after, nodeNamed(after, 'Array'))).toBe('Array');
  });

  test('leaves out what V8 keeps for itself', () => {
    expect(growthNameOf(after, nodeNamed(after, 'system / Context'))).toBeNull();
    expect(growthNameOf(after, nodeNamed(after, '(object elements)'))).toBeNull();
    expect(growthNameOf(after, nodeNamed(after, '<span>'))).toBeNull();
  });
});

test.describe('diffSnapshots', () => {
  const diagnosis = diffSnapshots(baseline, after);

  test('reports every detached class that grew, largest first', () => {
    expect(diagnosis.detached.map((d) => [d.className, d.baseline, d.after, d.delta])).toEqual([
      ['Detached <div>', 0, 1, 1],
      ['Detached <span>', 0, 1, 1],
    ]);
  });

  test('each detached class carries the chain that is holding it', () => {
    expect(diagnosis.detached[0]!.retainerPath).toEqual([
      { node: 'Window' },
      { node: 'EventListener' },
      { node: 'handleClick', kind: 'closure', edge: { type: 'context', name: 'el' } },
      { node: '<div class="card">' },
    ]);
  });

  test('growth covers the JS names, so a leak with no DOM still lands', () => {
    expect(diagnosis.objects).toEqual([{ name: 'AuditEntry', delta: 3 }]);
  });

  test('a snapshot against itself finds nothing', () => {
    expect(diffSnapshots(after, after)).toEqual({ detached: [], objects: [] });
  });
});

test.describe('a leak the GC roots reach first', () => {
  const snapshot = fixture('global-handle');
  const SECTION = 5;

  test('the shortest chain is the useless one', () => {
    // Two hops through (Global handles) against four through the page, so the
    // plain walk takes the short one and collapsing leaves nothing to act on.
    expect(buildRetainerPath(snapshot, snapshot.retainerPath(SECTION)!)).toEqual([
      { node: '<section class="panel">' },
    ]);
  });

  test('so the walk asks for a route through the page first', () => {
    expect(pathForClass(snapshot, new Map(), 'Detached <section>')).toEqual([
      { node: 'Window', edge: { type: 'property', name: '__panel' } },
      { node: 'openPanel', kind: 'closure', edge: { type: 'context', name: 'panel' } },
      { node: '<section class="panel">' },
    ]);
  });
});

test.describe('a hop through a plain object', () => {
  // (root) → Window → .store → Object → .items → Array → [0] → <div>
  const names = ['', '(root)', 'Window / https://example.test', 'Object', 'Array', '<div>'];
  const node = (type: number, name: number, id: number, edges: number): number[] =>
    [type, name, id, 0, edges];
  const at = (index: number): number => index * 5;
  const snapshot = parseHeapSnapshot(
    JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
          node_types: [['synthetic', 'object', 'native'], 'string', 'number', 'number', 'number'],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['element', 'property'], 'string_or_number', 'node'],
        },
      },
      nodes: [
        ...node(0, 1, 1, 1),
        ...node(1, 2, 3, 1),
        ...node(1, 3, 5, 1),
        ...node(1, 4, 7, 1),
        ...node(2, 5, 9, 0),
      ],
      edges: [0, 1, at(1), 1, 6, at(2), 1, 7, at(3), 0, 0, at(4)],
      strings: [...names, 'store', 'items'],
    }),
  );

  test('keeps the property name it held, joined onto the one above', () => {
    expect(buildRetainerPath(snapshot, snapshot.retainerPath(4)!)).toEqual([
      { node: 'Window', edge: { type: 'property', name: 'store.items' } },
      { node: 'Array', edge: { type: 'element', name: '0' } },
      { node: '<div>' },
    ]);
  });
});

test.describe('shortElementName', () => {
  test('keeps the id, the role and the first class, and drops the rest', () => {
    expect(
      shortElementName(
        '<div class="bg-white border border-slate-900/10 shadow-md" aria-labelledby=":r6:-label"'
        + ' tabindex="-1" id=":r5:" role="dialog" style="position: absolute; left: 0px;">',
      ),
    ).toBe('<div id=":r5:" role="dialog" class="bg-white …">');
  });

  test('leaves a short name as it is', () => {
    const drawer = '<section class="report-drawer">';
    expect(shortElementName(drawer)).toBe(drawer);
    expect(shortElementName('<span tabindex="-1" aria-hidden="true">')).toBe('<span>');
    expect(shortElementName('Detached HTMLDivElement')).toBe('Detached HTMLDivElement');
  });

  test('cuts a long value short', () => {
    const long = `<input name="${'x'.repeat(50)}">`;
    expect(shortElementName(long)).toBe(`<input name="${'x'.repeat(29)}\u2026">`);
  });
});

test.describe("Chrome's own objects", () => {
  // (root) → Window → HTMLDocument → StyleEngine → InternalNode → <ion-alert>, the chain
  // Ionic's alert test page left behind.
  const names = [
    '', '(root)', 'Window / http://localhost:3333', 'HTMLDocument', 'StyleEngine',
    'InternalNode', '<ion-alert>',
  ];
  const node = (type: number, name: number, id: number, edges: number): number[] =>
    [type, name, id, 0, edges];
  const at = (index: number): number => index * 5;
  const snapshot = parseHeapSnapshot(
    JSON.stringify({
      snapshot: {
        meta: {
          node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
          node_types: [['synthetic', 'object', 'native'], 'string', 'number', 'number', 'number'],
          edge_fields: ['type', 'name_or_index', 'to_node'],
          edge_types: [['element', 'property'], 'string_or_number', 'node'],
        },
      },
      nodes: [
        ...node(0, 1, 1, 1),
        ...node(1, 2, 3, 1),
        ...node(2, 3, 5, 1),
        ...node(2, 4, 7, 1),
        ...node(2, 5, 9, 1),
        ...node(2, 6, 11, 0),
      ],
      edges: [0, 1, at(1), 1, 7, at(2), 0, 9, at(3), 0, 9, at(4), 0, 2, at(5)],
      strings: [...names, '<symbol Window#DocumentCachedAccessor>'],
    }),
  );

  test('are marked, and the page and Chrome\'s symbol-named slots are not', () => {
    expect(buildRetainerPath(snapshot, snapshot.retainerPath(5)!)).toEqual([
      { node: 'Window' },
      { node: 'HTMLDocument' },
      { node: 'StyleEngine', kind: 'browser' },
      { node: '<ion-alert>' },
    ]);
  });
});
