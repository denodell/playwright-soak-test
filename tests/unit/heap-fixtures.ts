import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHeapSnapshot, type HeapSnapshot } from '../../src/heap-snapshot.js';

// See tests/fixtures/README.md for the graphs these describe.
export function fixture(name: string): HeapSnapshot {
  const file = fileURLToPath(new URL(`../fixtures/${name}.heapsnapshot`, import.meta.url));
  return parseHeapSnapshot(fs.readFileSync(file, 'utf8'));
}

export function nodeNamed(snapshot: HeapSnapshot, name: string): number {
  for (let node = 0; node < snapshot.nodeCount; node++) {
    if (snapshot.nodeName(node) === name) return node;
  }
  throw new Error(`no node named ${name}`);
}
