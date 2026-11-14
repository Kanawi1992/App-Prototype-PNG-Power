// Builds the portal into dist/:
//   dist/index.html        standalone page (offline support, icons, manifest). Serve over https or localhost.
//   dist/artifact.html     publish-ready page for the Artifact viewer (no service worker or manifest).
//   dist/manifest.webmanifest, dist/sw.js, dist/icons/*
const fs = require('fs');
const path = require('path');
const root = __dirname;
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const dist = path.join(root, 'dist');

const engine = ['engine.p1.js', 'engine.p2.js', 'engine.p3.js', 'engine.p4.js', 'engine.p5.js']
  .map((p) => src('src/' + p)).join('');
fs.writeFileSync(path.join(root, 'engine.js'), engine);

const css = src('src/app.css');
const assistant = src('src/assistant.js');
const ui = ['src/ui-core.js', 'src/ui-public.js', 'src/ui-staff.js'].map(src).join('\n');
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(root, 'assets', 'logo-256.png')).toString('base64');
const template = src('src/app.html');

const parts = { '/*CSS*/': css, '/*ENGINE*/': engine, '/*ASSISTANT*/': assistant, '/*UI*/': ui, '/*LOGO*/': logo };
let html = template;
for (const k of Object.keys(parts)) {
  if (!html.includes(k)) throw new Error('template missing ' + k);
  html = html.split(k).join(parts[k]); // split/join: no replacement-pattern surprises
}
for (const code of [engine, assistant, ui]) {
  if (/<\/script/i.test(code)) throw new Error('inline script contains a closing script tag');
}
if (/https?:\/\/(?!www\.w3\.org)/.test(css + engine + assistant + ui)) throw new Error('external URL found in code');

const version = Date.now().toString(36);
fs.mkdirSync(dist, { recursive: true });

// 1. standalone page: keep PWA tags, drop only the marker comments
const standalone = html.replace(/<!--PWA:(start|end)-->\n?/g, '');
fs.writeFileSync(path.join(dist, 'index.html'), standalone);

// 2. artifact page: remove the PWA blocks, then strip the document wrapper (the platform supplies it)
const artifact = html
  .replace(/<!--PWA:start-->[\s\S]*?<!--PWA:end-->\n?/g, '')
  .replace(/<!DOCTYPE[^>]*>/i, '')
  .replace(/<\/?(html|head|body)(\s[^>]*)?>/gi, '')
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/gi, '');
if (/<\/?(html|head|body)[\s>]/i.test(artifact)) throw new Error('document wrapper not fully stripped');
if (/serviceWorker|manifest\.webmanifest/.test(artifact)) throw new Error('PWA code leaked into artifact build');
fs.writeFileSync(path.join(dist, 'artifact.html'), artifact);

// 3. PWA files
fs.copyFileSync(path.join(root, 'src', 'pwa', 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));
fs.writeFileSync(path.join(dist, 'sw.js'), src('src/pwa/sw.js').replace('__CACHE_VERSION__', version));
fs.mkdirSync(path.join(dist, 'icons'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'assets', 'icons'))) {
  fs.copyFileSync(path.join(root, 'assets', 'icons', f), path.join(dist, 'icons', f));
}

console.log('built dist/ (index.html ' + Buffer.byteLength(standalone) + ' bytes, artifact.html ' + Buffer.byteLength(artifact) + ' bytes, cache ' + version + ')');
