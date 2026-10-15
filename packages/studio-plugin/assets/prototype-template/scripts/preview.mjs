import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length && !((args.length === 2 || args.length === 4) && args[0] === '--port' && (args.length !== 4 || args[2] === '--instance'))) throw new Error('Usage: preview [--port 1024..65535 [--instance id]]');
const instance = args.length === 4 ? args[3] : 'manual';
if (!/^[a-zA-Z0-9-]{1,80}$/.test(instance)) throw new Error('Invalid preview instance');
const port = args.length ? Number(args[1]) : 4173;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../dist'));
await Promise.all(['index.html', 'prototype-guard.js'].map((name) => stat(resolve(root, name))));
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors 'none'";
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (request.headers.host !== `127.0.0.1:${port}` || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(403).end('Forbidden'); return;
    }
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (path === '/__eadp_preview_ready') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ready: true, mode: 'synthetic-only', outputDirectory: 'dist', instance })); return;
    }
    const file = await realpath(resolve(root, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`));
    const rel = relative(root, file);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !(await stat(file)).isFile()) {
      response.writeHead(403).end('Forbidden'); return;
    }
    response.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch { response.writeHead(404).end('Not found'); }
});
server.listen(port, '127.0.0.1', () => { console.log(`EADP_PREVIEW_READY http://127.0.0.1:${port}`); });
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
