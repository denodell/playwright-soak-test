/**
 * Reader for the V8 heap snapshot format, the same JSON DevTools writes out of
 * Memory → take a heap snapshot.
 *
 * The format is three flat arrays and a dictionary:
 *
 *   snapshot.meta.node_fields   names the fields each node contributes, in order
 *   snapshot.meta.edge_fields   the same for edges
 *   nodes                       every node's fields, end to end, no separators
 *   edges                       every edge's fields, end to end
 *   strings                     names, referenced by index from nodes and edges
 *
 * A node's edges are the next `edge_count` entries after the ones belonging to
 * every node before it, so a prefix sum over the edge counts is what turns a
 * node ordinal into a slice of the edge array. An edge's `to_node` is an offset
 * into `nodes` rather than an ordinal, so it divides back by the field count.
 *
 * No `node:fs` and nothing soak-specific here, so a streaming reader can replace
 * `parseHeapSnapshot` later without the rest of the code noticing.
 */

export type HeapNodeType =
  | 'hidden'
  | 'array'
  | 'string'
  | 'object'
  | 'code'
  | 'closure'
  | 'regexp'
  | 'number'
  | 'native'
  | 'synthetic'
  | 'concatenated string'
  | 'sliced string'
  | 'symbol'
  | 'bigint'
  | (string & {});

export type HeapEdgeType =
  | 'context'
  | 'element'
  | 'property'
  | 'internal'
  | 'hidden'
  | 'shortcut'
  | 'weak'
  | (string & {});

export interface RawHeapSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: Array<string[] | string>;
      edge_fields: string[];
      edge_types: Array<string[] | string>;
    };
    node_count?: number;
    edge_count?: number;
  };
  nodes: number[];
  edges: number[];
  strings: string[];
}

export interface HeapEdge {
  type: HeapEdgeType;
  /** The property, context variable or element index the edge is stored under. */
  name: string;
  /** Ordinal of the node the edge points at. */
  to: number;
}

/** One hop back up a retainer chain. The first step is the leaked object itself. */
export interface RetainerStep {
  node: number;
  edge: { type: HeapEdgeType; name: string } | null;
}

/** The root of every snapshot, and where a retainer walk ends. */
export const ROOT_NODE = 0;

/** What a detached class is called in the report, and in DevTools' own class list. */
export const DETACHED_PREFIX = 'Detached ';

/** The value the `detachedness` node field carries for a node off the page. */
export const DETACHED = 2;

function typeNames(entry: string[] | string | undefined): string[] {
  return Array.isArray(entry) ? entry : [];
}

function fieldOffset(fields: string[], name: string): number {
  const index = fields.indexOf(name);
  if (index < 0) {
    throw new Error(`[playwright-soak-test] heap snapshot has no "${name}" field`);
  }
  return index;
}

export class HeapSnapshot {
  readonly nodeCount: number;
  readonly edgeCount: number;

  private readonly nodes: number[];
  private readonly edges: number[];
  private readonly strings: string[];

  private readonly nodeFieldCount: number;
  private readonly edgeFieldCount: number;
  private readonly nodeTypes: string[];
  private readonly edgeTypes: string[];

  private readonly nodeTypeAt: number;
  private readonly nodeNameAt: number;
  private readonly nodeIdAt: number;
  private readonly nodeSelfSizeAt: number;
  private readonly nodeEdgeCountAt: number;
  /** -1 on snapshots old enough not to carry the field. */
  private readonly nodeDetachedAt: number;

  private readonly edgeTypeAt: number;
  private readonly edgeNameAt: number;
  private readonly edgeTargetAt: number;

  /** First edge ordinal belonging to each node, plus a terminator. */
  private readonly firstEdge: Uint32Array;

  // Built on first use, since a diff over node names never needs them.
  private retainerFirst: Uint32Array | null = null;
  private retainerNode: Uint32Array | null = null;
  private retainerEdge: Uint32Array | null = null;

  constructor(raw: RawHeapSnapshot) {
    const meta = raw.snapshot?.meta;
    if (!meta || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
      throw new Error('[playwright-soak-test] not a V8 heap snapshot');
    }

    this.nodes = raw.nodes;
    this.edges = raw.edges;
    this.strings = raw.strings ?? [];

    this.nodeFieldCount = meta.node_fields.length;
    this.edgeFieldCount = meta.edge_fields.length;
    this.nodeTypes = typeNames(meta.node_types[0]);
    this.edgeTypes = typeNames(meta.edge_types[0]);

    this.nodeTypeAt = fieldOffset(meta.node_fields, 'type');
    this.nodeNameAt = fieldOffset(meta.node_fields, 'name');
    this.nodeIdAt = fieldOffset(meta.node_fields, 'id');
    this.nodeSelfSizeAt = fieldOffset(meta.node_fields, 'self_size');
    this.nodeEdgeCountAt = fieldOffset(meta.node_fields, 'edge_count');
    this.nodeDetachedAt = meta.node_fields.indexOf('detachedness');

    this.edgeTypeAt = fieldOffset(meta.edge_fields, 'type');
    this.edgeNameAt = fieldOffset(meta.edge_fields, 'name_or_index');
    this.edgeTargetAt = fieldOffset(meta.edge_fields, 'to_node');

    this.nodeCount = this.nodes.length / this.nodeFieldCount;
    this.edgeCount = this.edges.length / this.edgeFieldCount;

    this.firstEdge = new Uint32Array(this.nodeCount + 1);
    let running = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      this.firstEdge[i] = running;
      running += this.nodes[i * this.nodeFieldCount + this.nodeEdgeCountAt]!;
    }
    this.firstEdge[this.nodeCount] = running;
  }

  nodeType(node: number): HeapNodeType {
    const index = this.nodes[node * this.nodeFieldCount + this.nodeTypeAt]!;
    return this.nodeTypes[index] ?? String(index);
  }

  nodeName(node: number): string {
    return this.strings[this.nodes[node * this.nodeFieldCount + this.nodeNameAt]!] ?? '';
  }

  /** Stable across snapshots of the same page, which is how "new since baseline" works. */
  nodeId(node: number): number {
    return this.nodes[node * this.nodeFieldCount + this.nodeIdAt]!;
  }

  nodeSelfSize(node: number): number {
    return this.nodes[node * this.nodeFieldCount + this.nodeSelfSizeAt]!;
  }

  /** 0 unknown, 1 attached, 2 detached. Always 0 when the snapshot has no such field. */
  nodeDetachedness(node: number): number {
    if (this.nodeDetachedAt < 0) return 0;
    return this.nodes[node * this.nodeFieldCount + this.nodeDetachedAt]!;
  }

  edgeTypeOf(edge: number): HeapEdgeType {
    const index = this.edges[edge * this.edgeFieldCount + this.edgeTypeAt]!;
    return this.edgeTypes[index] ?? String(index);
  }

  /** Element and hidden edges store an index here; everything else stores a string. */
  edgeName(edge: number): string {
    const raw = this.edges[edge * this.edgeFieldCount + this.edgeNameAt]!;
    const type = this.edgeTypeOf(edge);
    if (type === 'element' || type === 'hidden') return String(raw);
    return this.strings[raw] ?? '';
  }

  edgeTarget(edge: number): number {
    return this.edges[edge * this.edgeFieldCount + this.edgeTargetAt]! / this.nodeFieldCount;
  }

  /** Ordinals of the edges leaving `node`, as a half-open range. */
  edgeRange(node: number): [number, number] {
    return [this.firstEdge[node]!, this.firstEdge[node + 1]!];
  }

  edgesFrom(node: number): HeapEdge[] {
    const [from, to] = this.edgeRange(node);
    const out: HeapEdge[] = [];
    for (let e = from; e < to; e++) {
      out.push({ type: this.edgeTypeOf(e), name: this.edgeName(e), to: this.edgeTarget(e) });
    }
    return out;
  }

  retainersOf(node: number): Array<{ from: number; type: HeapEdgeType; name: string }> {
    this.buildRetainers();
    const first = this.retainerFirst!;
    const out: Array<{ from: number; type: HeapEdgeType; name: string }> = [];
    for (let i = first[node]!; i < first[node + 1]!; i++) {
      const edge = this.retainerEdge![i]!;
      out.push({ from: this.retainerNode![i]!, type: this.edgeTypeOf(edge), name: this.edgeName(edge) });
    }
    return out;
  }

  /** Counting sort of every edge by its target, in typed arrays rather than a map. */
  private buildRetainers(): void {
    if (this.retainerFirst) return;

    const counts = new Uint32Array(this.nodeCount + 1);
    for (let e = 0; e < this.edgeCount; e++) counts[this.edgeTarget(e)]!++;

    const first = new Uint32Array(this.nodeCount + 1);
    let running = 0;
    for (let n = 0; n < this.nodeCount; n++) {
      first[n] = running;
      running += counts[n]!;
    }
    first[this.nodeCount] = running;

    const cursor = first.slice();
    const retainerNode = new Uint32Array(running);
    const retainerEdge = new Uint32Array(running);
    for (let n = 0; n < this.nodeCount; n++) {
      const [from, to] = this.edgeRange(n);
      for (let e = from; e < to; e++) {
        const slot = cursor[this.edgeTarget(e)]!++;
        retainerNode[slot] = n;
        retainerEdge[slot] = e;
      }
    }

    this.retainerFirst = first;
    this.retainerNode = retainerNode;
    this.retainerEdge = retainerEdge;
  }

  /**
   * Shortest chain back to the root, leaf first, or null if nothing reaches it.
   * Weak edges are skipped, since a path through one names a retainer that is
   * not retaining.
   */
  retainerPath(
    node: number,
    { skipRetainer }: { skipRetainer?: (holder: number) => boolean } = {},
  ): RetainerStep[] | null {
    if (node < 0 || node >= this.nodeCount) return null;
    this.buildRetainers();

    const parent = new Int32Array(this.nodeCount).fill(-1);
    const viaEdge = new Int32Array(this.nodeCount).fill(-1);
    const seen = new Uint8Array(this.nodeCount);

    const queue = [node];
    seen[node] = 1;
    let head = 0;
    let found = node === ROOT_NODE;

    while (head < queue.length && !found) {
      const current = queue[head++]!;
      const first = this.retainerFirst!;
      for (let i = first[current]!; i < first[current + 1]!; i++) {
        const holder = this.retainerNode![i]!;
        if (seen[holder]) continue;
        const edge = this.retainerEdge![i]!;
        if (this.edgeTypeOf(edge) === 'weak') continue;
        if (holder !== ROOT_NODE && skipRetainer?.(holder)) continue;

        seen[holder] = 1;
        parent[holder] = current;
        viaEdge[holder] = edge;

        if (holder === ROOT_NODE) {
          found = true;
          break;
        }
        queue.push(holder);
      }
    }

    if (!found) return null;

    // parent[] runs retainer → retained, so walking it from the root and
    // reversing gives the chain leaf first.
    const steps: RetainerStep[] = [];
    for (let current = ROOT_NODE; ; current = parent[current]!) {
      const edge = viaEdge[current]!;
      steps.push({
        node: current,
        edge: edge < 0 ? null : { type: this.edgeTypeOf(edge), name: this.edgeName(edge) },
      });
      if (current === node) break;
    }
    return steps.reverse();
  }
}

/** One `JSON.parse`, and the piece a streaming reader would replace. */
export function parseHeapSnapshot(json: string): HeapSnapshot {
  return new HeapSnapshot(JSON.parse(json) as RawHeapSnapshot);
}

/** Tag only, so `<div class="a">` and `<div id="b">` count as one class. */
function elementClass(name: string): string {
  const tag = /^<([a-zA-Z][\w-]*)/.exec(name);
  return tag ? `<${tag[1]!.toLowerCase()}>` : name || '(unnamed)';
}

/** Some groupings carry a count that moves between snapshots. */
function withoutEntryCount(name: string): string {
  return name.replace(/ \/ \d+ entries$/, '');
}

/**
 * Two spellings, because Chromium changed its mind: current versions set
 * `detachedness` and name the node after its markup, older ones put "Detached"
 * in the name.
 */
export function detachedClassOf(snapshot: HeapSnapshot, node: number): string | null {
  const name = snapshot.nodeName(node);

  if (snapshot.nodeDetachedness(node) === DETACHED) {
    return name.startsWith(DETACHED_PREFIX)
      ? withoutEntryCount(name)
      : `${DETACHED_PREFIX}${elementClass(name)}`;
  }

  if (snapshot.nodeType(node) !== 'native') return null;
  if (!name.startsWith(DETACHED_PREFIX)) return null;
  return withoutEntryCount(name);
}
