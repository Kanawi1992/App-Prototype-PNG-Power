// Builds dist/index.html: one self-contained file, no CDN, no network calls.
const fs = require('fs');
const path = require('path');
const root = __dirname;
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const engine = ['engine.p1.js', 'engine.p2.js', 'engine.p3.js', 'engine.p4.js', 'engine.p5.js']
  .map((p) => src('src/' + p)).join('');
fs.writeFileSync(path.join(root, 'engine.js'), engine);

const css = src('src/app.css');
const assistant = src('src/assistant.js');
const ui = ['src/ui-core.js', 'src/ui-public.js', 'src/ui-staff.js'].map(src).join('\n');
let html = src('src/app.html');

const parts = { '/*CSS*/': css, '/*ENGINE*/': engine, '/*ASSISTANT*/': assistant, '/*UI*/': ui };
for (const k of Object.keys(parts)) {
  if (!html.includes(k)) throw new Error('template missing ' + k);
  html = html.replace(k, () => parts[k]); // function form: no $& substitution surprises
}
for (const code of [engine, assistant, ui]) {
  if (/<\/script/i.test(code)) throw new Error('inline script contains a closing script tag');
}
if (/https?:\/\/(?!www\.w3\.org)/.test(css + engine + assistant + ui)) {
  // only the W3C namespace is allowed; there are no external URLs in the demo
  throw new Error('external URL found in code');
}
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'index.html'), html);
// Artifact publish: the platform supplies the document skeleton, so strip ours.
const artifact = html
  .replace(/<!DOCTYPE[^>]*>/i, '')
  .replace(/<\/?(html|head|body)(\s[^>]*)?>/gi, '')
  .replace(/<meta charset[^>]*>|<meta name="viewport"[^>]*>/gi, '');
if (/<\/?(html|head|body)[\s>]/i.test(artifact)) throw new Error('document wrapper not fully stripped');
fs.writeFileSync(path.join(root, 'dist', 'artifact.html'), artifact);
console.log('dist/index.html (' + Buffer.byteLength(html) + ' bytes), dist/artifact.html (' + Buffer.byteLength(artifact) + ' bytes)');
