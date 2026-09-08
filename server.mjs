import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const publicRoot = new URL('./public/', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/updates.js', ['updates.js', 'text/javascript']],
  ['/app-assets.json', ['app-assets.json', 'application/json']],
  ['/refresh.html', ['refresh.html', 'text/html']],
  ['/refresh.js', ['refresh.js', 'text/javascript']],
  ['/stacker.js', ['stacker.js', 'text/javascript']],
  ['/capture.js', ['capture.js', 'text/javascript']],
  ['/preferences.js', ['preferences.js', 'text/javascript']],
  ['/gallery.js', ['gallery.js', 'text/javascript']],
  ['/gallery-ui.js', ['gallery-ui.js', 'text/javascript']],
  ['/moon-core.js', ['moon-core.js', 'text/javascript']],
  ['/moon-simulation.js', ['moon-simulation.js', 'text/javascript']],
  ['/moon-worker.js', ['moon-worker.js', 'text/javascript']],
  ['/moon-media.js', ['moon-media.js', 'text/javascript']],
  ['/moon-ui.js', ['moon-ui.js', 'text/javascript']],
  ['/sw.js', ['sw.js', 'text/javascript']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']]
]);

const server = http.createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const entry = files.get(path);
  if (!entry || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL(entry[0], publicRoot));
    response.writeHead(200, {
      'Content-Type': `${entry[1]}; charset=utf-8`,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Permissions-Policy': 'camera=(self), microphone=()'
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error(`Cannot serve ${entry[0]}: ${error.message}`);
    response.writeHead(500).end('Cannot load app file');
  }
});

server.listen(Number(process.env.PORT || 8080), '127.0.0.1', () => {
  console.log(`Camera app: http://localhost:${server.address().port}`);
  console.log(`Serving only ${fileURLToPath(publicRoot)}`);
});
