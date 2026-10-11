import { expect, test } from '@playwright/test';
import {
  buildRetainerPath,
  diffDigest,
  digestBaseline,
  growthNameOf,
  pathForClass,
} from '../../src/heap-analysis.js';
import { detachedClassOf, HeapSnapshot, parseHeapSnapshot } from '../../src/heap-snapshot.js';
import { ordinal, rawSnapshot, root, snapshot, type NodeSpec } from './snapshot-builder.js';

// Small graphs, each built to reach a case the hand-written fixtures don't.

function pathTo(graph: Record<string, NodeSpec>, key: string) {
  const heap = snapshot(graph);
  return buildRetainerPath(heap, heap.retainerPath(ordinal(graph, key))!);
}

test.describe('reading a snapshot', () => {
  test('refuses JSON that is not a heap snapshot', () => {
    expect(() => parseHeapSnapshot('{}')).toThrow('not a V8 heap snapshot');
    expect(() => parseHeapSnapshot('{"snapshot":{"meta":{}},"nodes":{}}')).toThrow(
      'not a V8 heap snapshot',
    );
  });

  test('names the field a snapshot is missing', () => {
    const raw = rawSnapshot({ root });
    raw.snapshot.meta.node_fields = raw.snapshot.meta.node_fields.filter((f) => f !== 'id');
    expect(() => new HeapSnapshot(raw)).toThrow('heap snapshot has no "id" field');
  });

  test('copes with a type list or string table it does not recognize', () => {
    const raw = rawSnapshot({
      root: { ...root, edges: [['property', 'x', 'thing']] },
      thing: { type: 'object', name: 'Thing' },
    });
    raw.snapshot.meta.node_types[0] = 'not a list';
    raw.snapshot.meta.edge_types[0] = 'not a list';
    const heap = new HeapSnapshot(raw);
    // The type falls back to its number, which still tells two types apart.
    expect(heap.nodeType(1)).toBe('3');
    expect(heap.edgeTypeOf(0)).toBe('2');

    const bare = rawSnapshot({ root: { ...root, edges: [['property', 'x', 'thing']] }, thing: root });
    delete (bare as { strings?: string[] }).strings;
    const unnamed = new HeapSnapshot(bare);
    expect(unnamed.nodeName(1)).toBe('');
    expect(unnamed.edgeName(0)).toBe('');
  });

  test('a node outside the snapshot has no path', () => {
    const heap = snapshot({ root });
    expect(heap.retainerPath(-1)).toBeNull();
    expect(heap.retainerPath(5)).toBeNull();
  });

  test('a detached node named in the old style keeps its name, less the entry count', () => {
    const heap = snapshot({
      root,
      old: { type: 'native', name: 'Detached HTMLDivElement / 3 entries', detached: true },
      unnamed: { type: 'native', name: '', detached: true },
      text: { type: 'native', name: 'some text', detached: true },
    });
    expect(detachedClassOf(heap, 1)).toBe('Detached HTMLDivElement');
    expect(detachedClassOf(heap, 2)).toBe('Detached (unnamed)');
    expect(detachedClassOf(heap, 3)).toBe('Detached some text');
  });
});

test.describe('growthNameOf', () => {
  test('counts an unnamed closure as anonymous and leaves a detached object to the DOM count', () => {
    const heap = snapshot({
      root,
      fn: { type: 'closure', name: '' },
      wrapper: { type: 'object', name: 'HTMLDivElement', detached: true },
    });
    expect(growthNameOf(heap, 1)).toBe('closure (anonymous)');
    expect(growthNameOf(heap, 2)).toBeNull();
  });
});

test.describe('buildRetainerPath', () => {
  test('names an unnamed leaked object by its type, and an unnamed function as anonymous', () => {
    // An unnamed function partway along is bookkeeping and folds into the hop above.
    // Only the leaked object itself is always kept, so that's where the fallbacks show.
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: {
        type: 'native',
        name: 'Window / https://example.test',
        edges: [['property', 'cb', 'fn'], ['property', 'onTick', 'callback']],
      },
      fn: { type: 'closure', name: '', edges: [['context', 'held', 'leaf']] },
      leaf: { type: 'object', name: '', detached: true },
      callback: { type: 'closure', name: '' },
    };
    expect(pathTo(graph, 'leaf')).toEqual([
      { node: 'Window', edge: { type: 'context', name: 'held' } },
      { node: '(object)' },
    ]);
    expect(pathTo(graph, 'callback')).toEqual([
      { node: 'Window', edge: { type: 'property', name: 'onTick' } },
      { node: '(anonymous)', kind: 'closure' },
    ]);
  });

  test('a DOM wrapper and the object behind it read as one window, not two', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'native']] },
      native: { type: 'native', name: 'Window / https://example.test', edges: [['internal', 'js', 'js']] },
      js: { type: 'object', name: 'Window', edges: [['property', 'cache', 'leaf']] },
      leaf: { type: 'native', name: '<li>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([
      { node: 'Window', edge: { type: 'property', name: 'cache' } },
      { node: '<li>' },
    ]);
  });

  test('an object literal reached by index joins the name above as [index]', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: { type: 'native', name: 'Window / https://example.test', edges: [['property', 'rows', 'list']] },
      list: { type: 'object', name: 'Object', edges: [['element', 2, 'leaf']] },
      leaf: { type: 'native', name: '<li>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([
      { node: 'Window', edge: { type: 'property', name: 'rows[2]' } },
      { node: '<li>' },
    ]);
  });

  test('an object literal with no name on either side just drops out', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: { type: 'native', name: 'Window / https://example.test', edges: [['internal', 'x', 'a']] },
      a: { type: 'object', name: 'Object', edges: [['property', 'b', 'b']] },
      b: { type: 'object', name: 'Object', edges: [['internal', 'y', 'leaf']] },
      leaf: { type: 'native', name: '<li>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([{ node: 'Window' }, { node: '<li>' }]);
  });

  test('a module with no generator passes its own slot up', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: { type: 'native', name: 'Window / https://example.test', edges: [['property', 'lazy', 'mod']] },
      mod: { type: 'object', name: 'Module', edges: [['property', 'panel', 'leaf']] },
      leaf: { type: 'native', name: '<section>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([
      { node: 'Window', edge: { type: 'property', name: 'panel' } },
      { node: '<section>' },
    ]);
  });

  test('a module held without a name leaves the hop above without one', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: { type: 'native', name: 'Window / https://example.test', edges: [['property', 'lazy', 'mod']] },
      mod: { type: 'object', name: 'Module', edges: [['internal', 'x', 'leaf']] },
      leaf: { type: 'native', name: '<section>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([{ node: 'Window' }, { node: '<section>' }]);
  });

  test('a module straight off the root has nothing above it to pass its slot to', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'mod']] },
      mod: { type: 'object', name: 'Module', edges: [['property', 'panel', 'leaf']] },
      leaf: { type: 'native', name: '<section>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([{ node: '<section>' }]);
  });

  test('a pending timer held without a name has no slot either', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: { type: 'native', name: 'Window / https://example.test', edges: [['property', '__pwClock', 'clock']] },
      clock: { type: 'object', name: 'ClockController', edges: [['internal', 'x', 'fn']] },
      fn: { type: 'closure', name: 'tick', edges: [['context', 'tile', 'leaf']] },
      leaf: { type: 'native', name: '<div>', detached: true },
    };
    expect(pathTo(graph, 'leaf')).toEqual([
      { node: 'a pending timer', kind: 'timer' },
      { node: 'tick', kind: 'closure', edge: { type: 'context', name: 'tile' } },
      { node: '<div>' },
    ]);
  });
});

test.describe('pathForClass', () => {
  test('falls back to a node the baseline had when every one of them is old', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: { type: 'native', name: 'Window / https://example.test', edges: [['property', 'kept', 'leaf']] },
      leaf: { type: 'native', name: '<li>', id: 77, detached: true },
    };
    const heap = snapshot(graph);
    const path = pathForClass(heap, new Map([['Detached <li>', new Set([77])]]), 'Detached <li>');
    expect(path.at(-1)).toEqual({ node: '<li>' });
  });

  test('a class the snapshot does not have, or cannot reach, has no path', () => {
    const heap = snapshot({
      root,
      island: { type: 'native', name: '<li>', detached: true },
    });
    expect(pathForClass(heap, new Map(), 'Detached <p>')).toEqual([]);
    expect(pathForClass(heap, new Map(), 'Detached <li>')).toEqual([]);
  });

  test('takes a path through V8’s own roots when there is no other', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'handles']] },
      handles: { type: 'synthetic', name: '(Global handles)', edges: [['element', 0, 'leaf']] },
      leaf: { type: 'native', name: '<li>', detached: true },
    };
    expect(pathForClass(snapshot(graph), new Map(), 'Detached <li>')).toEqual([{ node: '<li>' }]);
  });

  test('and through DevTools’ detached grouping as a last resort', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'group']] },
      group: { type: 'native', name: 'Detached DOM tree / 1 entries', edges: [['element', 0, 'leaf']] },
      leaf: { type: 'native', name: '<li>', detached: true },
    };
    expect(pathForClass(snapshot(graph), new Map(), 'Detached <li>')).toEqual([
      { node: 'Detached DOM tree / 1 entries', kind: 'browser' },
      { node: '<li>' },
    ]);
  });
});

test.describe('diffDigest', () => {
  test('out of time before the first walk, it keeps the counts and says why the chains are missing', () => {
    const graph: Record<string, NodeSpec> = {
      root: { ...root, edges: [['element', 1, 'window']] },
      window: {
        type: 'native',
        name: 'Window / https://example.test',
        edges: [['property', 'a', 'one'], ['property', 'b', 'two']],
      },
      one: { type: 'native', name: '<li>', detached: true },
      two: { type: 'native', name: '<li>', detached: true },
    };
    const before = digestBaseline(snapshot({ root }));
    const diagnosis = diffDigest(before, snapshot(graph), { outOfTime: () => true, limit: "the test's timeout" });

    expect(diagnosis.detached).toEqual([
      { className: 'Detached <li>', baseline: 0, after: 2, delta: 2, retainerPath: [] },
    ]);
    expect(diagnosis.note).toBe("Diagnosis ran past the test's timeout, so not every chain was walked.");
  });
});
