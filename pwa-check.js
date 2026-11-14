// PWA check: starts serve.js over HTTP and HTTPS, confirms manifest, icons and service worker,
// then reloads the page offline and checks it still renders. Run: npm run test:pwa
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(label, url, env) {
  const server = spawn('node', [path.join(root, 'serve.js')], { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false, log = '';
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { log += d; if (!started && /Portal at/.test(log)) { started = true; resolve(); } });
    server.stderr.on('data', (d) => { log += d; });
    server.on('exit', (code) => { if (!started) reject(new Error('server exited: ' + log)); });
    setTimeout(() => { if (!started) reject(new Error('server did not start: ' + log)); }, 8000);
  });
  const results = [];
  const ok = (name, cond) => results.push([name, !!cond]);
  const browser = await chromium.launch({ args: env.HTTPS === '1' ? ['--ignore-certificate-errors'] : [] });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const res = await page.goto(url);
    ok('page loads', res && res.status() === 200);
    await page.waitForSelector('#tabs button', { timeout: 5000 });

    const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
    ok('manifest parses with name and 4 icons', manifest.name && manifest.icons.length === 4 && manifest.display === 'standalone');
    const iconStatus = await page.evaluate(async (icons) => Promise.all(icons.map(async (i) => (await fetch(i.src)).status)), manifest.icons);
    ok('all manifest icons return 200', iconStatus.every((s) => s === 200));
    ok('favicon and apple icon linked', await page.evaluate(() => !!document.querySelector('link[rel=icon]') && !!document.querySelector('link[rel=apple-touch-icon]')));
    ok('theme colour set', await page.evaluate(() => !!document.querySelector('meta[name=theme-color]')));

    const swState = await page.evaluate(() => Promise.race([
      navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 6000))
    ]));
    ok('service worker active', swState);
    await page.reload();
    await page.waitForSelector('#tabs button', { timeout: 5000 });
    ok('page controlled by service worker after reload', await page.evaluate(() => !!navigator.serviceWorker.controller));

    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#tabs button', { timeout: 5000 });
    const offlineText = await page.textContent('#view');
    ok('renders offline from cache', await page.$$eval('#tabs button', (b) => b.length) === 10 && offlineText.length > 40);
    await ctx.setOffline(false);

    const home = await page.textContent('#view');
    ok('demo codes show fault, tip-off and access code', /Demo codes/.test(home) && /FLT-\d{5}/.test(home) && /RPU-\d{5}/.test(home) && /DEMO42/.test(home));
    ok('no page or console errors', errors.length === 0);
    if (errors.length) console.log(errors.join('\n'));
    await ctx.close();
  } finally {
    await browser.close();
    server.kill();
  }
  let fail = 0;
  for (const [name, pass] of results) { if (!pass) fail++; console.log((pass ? 'PASS ' : 'FAIL ') + label + ': ' + name); }
  return fail;
}

(async () => {
  let fails = 0;
  fails += await check('http', 'http://localhost:8091/', { PORT: '8091' });
  const cert = path.join(root, 'certs', 'local.crt');
  if (fs.existsSync(cert)) {
    fails += await check('https', 'https://localhost:8444/', { HTTPS: '1', PORT: '8444' });
  } else {
    console.log('SKIP https: no certs/local.crt (run npm run cert)');
  }
  console.log(fails ? 'PWA CHECK FAILED' : 'PWA CHECK PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
