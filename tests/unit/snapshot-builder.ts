import { HeapSnapshot, type RawHeapSnapshot } from '../../src/heap-snapshot.js';

const NODE_TYPES = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number',
  'native', 'synthetic'];
const EDGE_TYPES = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'];

/** `[type, property name or element index, key of the node it points at]` */
export type EdgeSpec = [type: string, name: string | number, to: string];

export interface NodeSpec {
  type: string;
  name: string;
  /** Defaults to the node's position, so two graphs share ids only when asked to. */
  id?: number;
  detached?: boolean;
  edges?: EdgeSpec[];
}

/**
 * Lays a graph written as an object out in V8's flat format, the first entry
 * being the root. Shorter to read than a hand-written fixture for a graph made
 * to reach one branch.
 */
export function rawSnapshot(graph: Record<string, NodeSpec>): RawHeapSnapshot {
  const keys = Object.keys(graph);
  const FIELDS = 6;
  const strings: string[] = [''];
  const stringIndex = (s: string): number => {
    const at = strings.indexOf(s);
    if (at >= 0) return at;
    strings.push(s);
    return strings.length - 1;
  };
  const nodes: number[] = [];
  const edges: number[] = [];

  keys.forEach((key, i) => {
    const spec = graph[key]!;
    const specEdges = spec.edges ?? [];
    nodes.push(
      NODE_TYPES.indexOf(spec.type),
      stringIndex(spec.name),
      spec.id ?? i + 1,
      0,
      specEdges.length,
      spec.detached ? 2 : 1,
    );
    for (const [type, name, to] of specEdges) {
      const target = keys.indexOf(to);
      if (target < 0) throw new Error(`no node ${to}`);
      const isIndex = type === 'element' || type === 'hidden';
      edges.push(
        EDGE_TYPES.indexOf(type),
        isIndex ? Number(name) : stringIndex(String(name)),
        target * FIELDS,
      );
    }
  });

  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
        node_types: [NODE_TYPES, 'string', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [EDGE_TYPES, 'string_or_number', 'node'],
      },
    },
    nodes,
    edges,
    strings,
  };
}

export function snapshot(graph: Record<string, NodeSpec>): HeapSnapshot {
  return new HeapSnapshot(rawSnapshot(graph));
}

/** The ordinal of a node by its key in the graph it was built from. */
export function ordinal(graph: Record<string, NodeSpec>, key: string): number {
  return Object.keys(graph).indexOf(key);
}

export const root: NodeSpec = { type: 'synthetic', name: '(GC roots)' };
