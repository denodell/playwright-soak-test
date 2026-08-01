import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Two builds of the demo app from one source tree.
 *
 *   --mode leak   → __LEAK__ true  → the drawer never removes its resize listener
 *   --mode fixed  → __LEAK__ false → the drawer removes it on close (the control)
 *
 */
export default defineConfig(({ mode }) => {
  const leak = mode === 'leak';
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    // Both builds are served from one origin, so a single server hosts the
    // leaking build, the control build and /api/feed together.
    base: leak ? '/leak/' : '/fixed/',
    define: {
      __LEAK__: JSON.stringify(leak),
    },
    build: {
      outDir: leak ? 'dist/leak' : 'dist/fixed',
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
    },
  };
});
