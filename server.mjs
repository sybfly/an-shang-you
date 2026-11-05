import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const server = http.createServer((request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.resolve(root, `.${pathname}`);
    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      fs.createReadStream(filePath).pipe(response);
    });
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
  }
});

server.listen(port, host, () => {
  console.log(`暗上游静态站：http://${host}:${port}`);
  console.log('这是本地静态文件服务，不参与牌局计算。按 Ctrl+C 停止。');
});
