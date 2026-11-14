#!/usr/bin/env node
// Local host for the portal (serves dist/).
//   npm start                 http://localhost:8080   (service workers work on localhost)
//   npm run start:https       https://localhost:8443  (needs certs: npm run cert)
// Environment: PORT, HOST (default 127.0.0.1), HTTPS=1 to use TLS.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'dist');
const USE_TLS = process.env.HTTPS === '1';
const PORT = Number(process.env.PORT) || (USE_TLS ? 8443 : 8080);
const HOST = process.env.HOST || '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('dist/index.html is missing. Run: npm run build');
  process.exit(1);
}

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

if (USE_TLS) {
  const key = path.join(__dirname, 'certs', 'local.key');
  const cert = path.join(__dirname, 'certs', 'local.crt');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.error('TLS certificate missing. Run: npm run cert');
    process.exit(1);
  }
  https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler)
    .listen(PORT, HOST, () => console.log('Portal at https://localhost:' + PORT + ' (self-signed certificate)'));
} else {
  http.createServer(handler).listen(PORT, HOST, () => console.log('Portal at http://localhost:' + PORT));
}
