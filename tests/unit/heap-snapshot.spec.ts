import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  detachedClassOf,
  parseHeapSnapshot,
  type HeapSnapshot,
} from '../../src/heap-snapshot.js';
import {
  buildRetainerPath,
  diffSnapshots,
  growthNameOf,
} from '../../src/heap-diagnosis.js';

// See tests/fixtures/README.md for the graph these two describe.
function fixture(name: string): HeapSnapshot {
  const file = fileURLToPath(new URL(`../fixtures/${name}.heapsnapshot`, import.meta.url));
  return parseHeapSnapshot(fs.readFileSync(file, 'utf8'));
}

const after = fixture('retained-drawer');
const baseline = fixture('retained-drawer-baseline');
const clock = fixture('pending-timer');

function nodeNamed(snapshot: HeapSnapshot, name: string): number {
  for (let node = 0; node < snapshot.nodeCount; node++) {
    if (snapshot.nodeName(node) === name) return node;
  }
  throw new Error(`no node named ${name}`);
}

test.describe('parseHeapSnapshot', () => {
  test('reads the counts back out of the flat arrays', () => {
    expect(after.nodeCount).toBe(13);
    expect(after.edgeCount).toBe(13);
    expect(baseline.nodeCount).toBe(2);
  });

  test('resolves each node against the type list and the string table', () => {
    const handler = nodeNamed(after, 'handleClick');
    expect(after.nodeType(handler)).toBe('closure');
    expect(after.nodeName(handler)).toBe('handleClick');
    expect(after.nodeSelfSize(handler)).toBe(40);
    expect(after.nodeType(0)).toBe('synthetic');
    expect(after.nodeName(0)).toBe('(GC roots)');
  });

  test('ids are distinct, which is what tells a new object from an old one', () => {
    const ids = new Set<number>();
    for (let node = 0; node < after.nodeCount; node++) ids.add(after.nodeId(node));
    expect(ids.size).toBe(after.nodeCount);
  });

  test('slices the edge array by node rather than by position', () => {
    const elements = nodeNamed(after, '(object elements)');
    expect(after.edgesFrom(elements)).toEqual([
      { type: 'element', name: '3', to: nodeNamed(after, 'AuditEntry') },
      { type: 'element', name: '4', to: expect.any(Number) },
      { type: 'element', name: '5', to: expect.any(Number) },
    ]);
    expect(after.edgesFrom(nodeNamed(after, '<span>'))).toEqual([]);
  });

  test('names an element edge by its index and a property edge by its string', () => {
    const window = nodeNamed(after, 'Window / https://example.test');
    const edges = after.edgesFrom(window);
    expect(edges.map((e) => `${e.type}:${e.name}`)).toEqual(['property:__sink', 'element:1']);
  });

  test('the reverse index finds every holder of a node', () => {
    const card = nodeNamed(after, '<div class="card">');
    expect(after.retainersOf(card).map((r) => `${r.type}:${after.nodeName(r.from)}`).sort()).toEqual(
      ['context:system / Context', 'weak:WeakHolder'],
    );
  });
});

test.describe('retainerPath', () => {
  test('walks back to the root and refuses the weak shortcut', () => {
    const card = nodeNamed(after, '<div class="card">');
    const steps = after.retainerPath(card);
    expect(steps).not.toBeNull();

    expect(steps!.map((s) => after.nodeName(s.node))).toEqual([
      '<div class="card">',
      'system / Context',
      'handleClick',
      'EventListener',
      'Window / https://example.test',
      '(GC roots)',
    ]);
    // The leaked object is first, so nothing points at it from below.
    expect(steps![0]!.edge).toBeNull();
    expect(steps![1]!.edge).toEqual({ type: 'context', name: 'el' });
  });

  test('a node with no holders has no path', () => {
    const lonely = parseHeapSnapshot(
      JSON.stringify({
        snapshot: {
          meta: {
            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
            node_types: [['hidden', 'object'], 'string', 'number', 'number', 'number'],
            edge_fields: ['type', 'name_or_index', 'to_node'],
            edge_types: [['element'], 'string_or_number', 'node'],
          },
        },
        nodes: [1, 1, 1, 0, 0, 1, 2, 3, 0, 0],
        edges: [],
        strings: ['', 'root', 'orphan'],
      }),
    );
    expect(lonely.retainerPath(1)).toBeNull();
  });

  test('skipRetainer walks past a holder rather than through it', () => {
    const card = nodeNamed(after, '<div class="card">');
    const context = nodeNamed(after, 'system / Context');
    expect(after.retainerPath(card, { skipRetainer: (holder) => holder === context })).toBeNull();
  });
});

test.describe('buildRetainerPath', () => {
  test('runs root first and hands the context variable to the closure', () => {
    const card = nodeNamed(after, '<div class="card">');
    expect(buildRetainerPath(after, after.retainerPath(card)!)).toEqual([
      { node: 'Window' },
      { node: 'EventListener' },
      { node: 'closure handleClick', edge: { type: 'context', name: 'el' } },
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
      'closure handleClick',
      '<div class="card">',
      '<span>',
    ]);
  });

  test("collapses the injected clock, so a leak is not blamed on Playwright's plumbing", () => {
    const tile = nodeNamed(clock, '<div class="tile">');
    expect(buildRetainerPath(clock, clock.retainerPath(tile)!)).toEqual([
      { node: 'a pending timer', edge: { type: 'property', name: 'func' } },
      { node: 'closure tick', edge: { type: 'context', name: 'state' } },
      { node: '<div class="tile">' },
    ]);
  });
});

test.describe('detachedClassOf', () => {
  test('groups a detached element by its tag, dropping the attributes', () => {
    expect(detachedClassOf(after, nodeNamed(after, '<div class="card">'))).toBe('Detached <div>');
    expect(detachedClassOf(after, nodeNamed(after, '<span>'))).toBe('Detached <span>');
  });

  test('anything still on the page is not a detached class', () => {
    expect(detachedClassOf(after, nodeNamed(after, 'Array'))).toBeNull();
    expect(detachedClassOf(after, nodeNamed(after, 'Window / https://example.test'))).toBeNull();
  });

  test('reads the older spelling, where the word is in the name', () => {
    const old = parseHeapSnapshot(
      JSON.stringify({
        snapshot: {
          meta: {
            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
            node_types: [['native'], 'string', 'number', 'number', 'number'],
            edge_fields: ['type', 'name_or_index', 'to_node'],
            edge_types: [['element'], 'string_or_number', 'node'],
          },
        },
        nodes: [0, 1, 1, 0, 0],
        edges: [],
        strings: ['', 'Detached HTMLDivElement / 12 entries'],
      }),
    );
    expect(detachedClassOf(old, 0)).toBe('Detached HTMLDivElement');
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
      { node: 'closure handleClick', edge: { type: 'context', name: 'el' } },
      { node: '<div class="card">' },
    ]);
  });

  test('growth covers the JS names, so a leak with no DOM still lands', () => {
    expect(diagnosis.growth).toEqual([{ name: 'AuditEntry', delta: 3 }]);
  });

  test('a snapshot against itself finds nothing', () => {
    expect(diffSnapshots(after, after)).toEqual({ detached: [], growth: [] });
  });
});
