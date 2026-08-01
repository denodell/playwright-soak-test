import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, Record<string, string> | string>;
  files: string[];
};

const built = fs.existsSync(path.join(root, 'dist', 'index.js'));
test.skip(!built, 'Run `npm run build` first; these tests check the resulting output.');

test('every path exists in the exports map', () => {
  const declared = Object.values(pkg.exports).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry),
  );
  expect(declared.length).toBeGreaterThan(0);
  for (const rel of declared) {
    expect(fs.existsSync(path.join(root, rel)), `${rel} is missing`).toBe(true);
  }
});

test('the package entry loads as ESM and as CJS', async () => {
  const esm = await import(path.join(root, 'dist/index.js'));
  const cjs = require(path.join(root, 'dist/index.cjs'));

  const expected = [
    'SoakLeakError',
    'expect',
    'installSoakClock',
    'measureSoak',
    'runSoak',
    'soakFixtures',
    'soakLaunchOptions',
    'test',
  ];
  expect(Object.keys(esm).sort()).toEqual(expected);
  expect(Object.keys(cjs).sort()).toEqual(expected);
});

test('the reporter subpath loads and exports a reporter', async () => {
  const esm = await import(path.join(root, 'dist/reporter.js'));
  const cjs = require(path.join(root, 'dist/reporter.cjs'));
  expect(typeof esm.default).toBe('function');
  expect(typeof (cjs.default ?? cjs)).toBe('function');
  // Playwright calls these two on every run.
  expect(typeof esm.default.prototype.onTestEnd).toBe('function');
  expect(typeof esm.default.prototype.onEnd).toBe('function');
});

test('the tarball carries the built output only', () => {
  expect(pkg.files).toContain('dist');
  expect(pkg.files).toContain('CHANGELOG.md');
  expect(pkg.files).not.toContain('src');
  expect(pkg.files.some((f) => f.includes('examples'))).toBe(false);
});
