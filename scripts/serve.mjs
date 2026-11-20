// Tiny zero-dependency static server for local use. Listens on localhost only.
//   node scripts/serve.mjs          serve the project folder
//   node scripts/serve.mjs dist     serve the built site
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2] || '.');
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
};

const BLOCKED = ['node_modules', '.git', 'scripts', '.github'];

http
  .createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    const top = file.slice(root.length + 1).split(sep)[0];
    if (!file.startsWith(root + sep) || BLOCKED.includes(top)) {
      res.writeHead(404).end('Not found');
      return;
    }
    let stat;
    try {
      stat = statSync(file);
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  })
  .listen(port, host, () => {
    console.log(`Passport Photo running at http://localhost:${port}/  (serving ${root})`);
  });
