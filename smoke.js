// Browser smoke test. Run: node tests/smoke.js   (needs playwright + chrome; uses dist/index.html)
const path = require('path');
const { chromium } = require('playwright');
const url = 'file://' + path.join(__dirname, '..', 'dist', 'index.html');
const VIEWS = ['dashboard', 'easipay', 'tracker', 'grid', 'news', 'offices', 'fraud', 'safety', 'chat', 'staff'];
const shots = process.env.SHOTS ? path.join(__dirname, '..', 'shots') : null;

(async () => {
  const errors = [];
  let browser;
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' }); }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('dialog', (d) => d.accept());

  await page.goto(url);
  await page.waitForSelector('#tabs button');
  const results = [];
  for (const v of VIEWS) {
    await page.evaluate((x) => { location.hash = x; }, v);
    await page.waitForTimeout(150);
    const txt = (await page.textContent('#view')) || '';
    const ok = txt.trim().length > 40 && !/could not load/i.test(txt);
    results.push([v, ok]);
    if (shots) await page.screenshot({ path: path.join(shots, v + '.png'), fullPage: false });
  }

  // EasiPay: check meter, buy a token through the simulated provider
  await page.evaluate(() => { location.hash = 'easipay'; });
  const creds = await page.evaluate(() => window.StepwiseUI.api.demoCredentials().meters[0]);
  await page.fill('#ep-meter', creds.meter_number);
  await page.click('text=Check meter');
  await page.fill('#ep-amount', '20');
  await page.waitForTimeout(100);
  await page.click('button:has-text("Pay K")');
  await page.click('[role=dialog] button:has-text("Approve")');
  await page.waitForSelector('text=Your token', { timeout: 3000 });
  const tokenText = (await page.textContent('.token')) || '';
  results.push(['token purchase', /^\d{4}(-\d{4}){4}$/.test(tokenText.trim())]);
  if (shots) await page.screenshot({ path: path.join(shots, 'easipay-receipt.png'), fullPage: true });

  // Tracker: submit a fault
  await page.evaluate(() => { location.hash = 'tracker'; });
  await page.fill('textarea', 'Street light and power out since 6am');
  await page.click('button:has-text("Submit report")');
  await page.waitForSelector('text=ticket number is', { timeout: 3000 }).catch(() => null);
  results.push(['fault submitted', /ticket number is|matches an open report/.test(await page.textContent('#view'))]);

  // Tampering report returns an access code once, and tracking it shows only the stage
  await page.evaluate(() => { location.hash = 'fraud'; });
  await page.fill('textarea', 'Visible bypass wire at the back of the house');
  await page.fill('input[placeholder^="Street"]', 'Lot 7 Sec 3');
  await page.click('button:has-text("Submit confidentially")');
  await page.waitForSelector('text=Save your access code', { timeout: 3000 }).catch(() => null);
  const code = (await page.textContent('.card .token')) || '';
  const tid = ((await page.textContent('#view')).match(/RPU-\d{5}/) || [''])[0];
  results.push(['tip returns access code', /^[A-Z2-9]{6}$/.test(code.trim()) && !!tid]);
  await page.fill('input[placeholder^="Ticket number"]', tid);
  await page.fill('input[placeholder="Access code"]', code.trim());
  await page.click('button:has-text("Check progress")');
  const chk = await page.textContent('#view');
  results.push(['tip tracking shows stage only', /Received/.test(chk) && !/Lot 7 Sec 3/.test(chk)]);

  // Postpaid: unlock the statement with its PIN
  await page.evaluate(() => { location.hash = 'easipay'; });
  const acc = await page.evaluate(() => window.StepwiseUI.api.demoCredentials().account);
  await page.fill('input[placeholder="Account number"]', acc.account);
  await page.fill('input[placeholder="Account PIN"]', acc.pin);
  await page.click('button:has-text("Unlock statement")');
  await page.waitForSelector('text=total due', { timeout: 3000 }).catch(() => null);
  results.push(['postpaid statement unlocks', /total due/.test(await page.textContent('#view'))]);

  // Assistant: fallen wire
  await page.evaluate(() => { location.hash = 'chat'; });
  await page.fill('input[aria-label="Message"]', 'fallen wire in Boroko');
  await page.press('input[aria-label="Message"]', 'Enter');
  await page.waitForTimeout(100);
  const chat = await page.textContent('.chat');
  results.push(['assistant hazard reply', /10 metres/.test(chat) && /P1/.test(chat)]);

  // Staff login and queue
  await page.evaluate(() => { location.hash = 'staff'; });
  await page.fill('input[autocomplete=username]', 'supervisor');
  await page.fill('input[type=password]', 'super123');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('text=Staff console', { timeout: 3000 }).catch(() => null);
  const staffTxt = await page.textContent('#view');
  results.push(['staff login', /Staff console/.test(staffTxt)]);
  results.push(['staff queue has tickets', /Dispatch queue|Ticket/.test(staffTxt)]);
  const panelCheck = async (label, expect) => {
    await page.click('[role=tab]:has-text("' + label + '")');
    await page.waitForTimeout(80);
    results.push(['staff panel: ' + label, expect.test(await page.textContent('#view'))]);
  };
  await panelCheck('Payments & finance', /Reconciliation clean|Reconciliation:/);
  await panelCheck('Notices', /Post a notice/);
  await panelCheck('Grid control', /Apply/);
  await panelCheck('Brand & settings', /Save brand/);
  await panelCheck('Data & audit', /Audit log/);
  await panelCheck('Dispatch queue', /Dispatch queue|Crew/);

  // Mobile layout: no horizontal scroll at 390px
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { location.hash = 'dashboard'; });
  await page.waitForTimeout(100);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  results.push(['no horizontal scroll at 390px', !overflow]);
  if (shots) await page.screenshot({ path: path.join(shots, 'mobile-home.png'), fullPage: false });

  await browser.close();
  let fail = 0;
  for (const [name, ok] of results) { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + name); }
  for (const e of errors) console.log('ERR  ' + e);
  console.log(fail || errors.length ? 'SMOKE FAILED' : 'SMOKE PASSED');
  process.exit(fail || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
