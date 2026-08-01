// Static host for both builds plus the /api/feed endpoint the poller hits.
//
// The feed handler keeps a request counter that the tests reset at the start of
// a run and read at the end. That counter is the ground truth for "how many
// polls actually happened", independent of anything the test believes.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);

// ---------------------------------------------------------------- feed body

// Deterministic ~50 kB JSON payload, built once at boot.
function buildFeed() {
  const items = [];
  for (let i = 0; i < 196; i++) {
    items.push({
      id: `evt-${String(i).padStart(5, '0')}`,
      ts: 1700000000000 + i * 1000,
      service: `svc-${i % 17}`,
      region: ['us-east-1', 'eu-west-2', 'ap-south-1'][i % 3],
      severity: ['info', 'warn', 'error'][i % 3],
      message: `Sampled event ${i} recorded by the ingest pipeline for review.`,
      tags: [`tag-${i % 7}`, `tag-${i % 11}`, `tag-${i % 13}`],
      metrics: { latencyMs: 10 + (i % 90), bytes: 1024 * (i % 40), retries: i % 4 },
    });
  }
  return JSON.stringify({ generatedAt: 1700000000000, items });
}

const FEED_BODY = buildFeed();
const FEED_BYTES = Buffer.byteLength(FEED_BODY);

// ------------------------------------------------------------------ counter

let feedRequests = 0;

// ------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, urlPath) {
  // urlPath is /leak/... or /fixed/...
  let rel = urlPath.replace(/^\/+/, '');
  let filePath = path.join(ROOT, 'dist', rel);

  if (!filePath.startsWith(path.join(ROOT, 'dist'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end('not found');
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

// -------------------------------------------------------------------- serve

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/feed') {
    feedRequests++;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end(FEED_BODY);
    return;
  }

  if (url.pathname === '/__counter') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ feedRequests, feedBytes: FEED_BYTES }));
    return;
  }

  if (url.pathname === '/__counter/reset') {
    feedRequests = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ feedRequests }));
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(302, { location: '/leak/' });
    res.end();
    return;
  }

  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`soak server on http://localhost:${PORT} (feed body ${FEED_BYTES} bytes)`);
});
