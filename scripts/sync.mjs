import { chromium } from 'playwright';
import { config as loadEnv } from 'dotenv';
import { mkdir, access, readFile, writeFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const STATE_DIR = join(ROOT, 'state');
const SHOT_DIR = join(ROOT, 'state', 'screenshots');
const REPORTS_DIR = join(ROOT, 'state', 'reports');

const EMAIL = process.env.LOGIN_EMAIL;
const PASSWORD = process.env.LOGIN_PASSWORD;
const DIAGNOSTIC = process.argv.includes('--diagnostic');
const DRY_RUN = process.argv.includes('--dry-run') || DIAGNOSTIC;

const LEGACY_OVERRIDES_MULTINET = {
  BTC: '1NiScrQddTHU1Us91AEvjpLdF6TFfcrTL7',
};

const dIdx = process.argv.findIndex(a => a === '--domain' || a === '--only');
const DOMAIN_FILTER = dIdx !== -1 && process.argv[dIdx + 1]
  ? process.argv[dIdx + 1].split(',').map(s => s.trim()).filter(Boolean)
  : null;

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: LOGIN_EMAIL and LOGIN_PASSWORD must be set in .env');
  process.exit(1);
}

const fileExists = async p => { try { await access(p); return true; } catch { return false; } };

function resolveCreds(domain) {
  return {
    email: domain.email && domain.email.trim() ? domain.email : EMAIL,
    password: domain.password && domain.password.trim() ? domain.password : PASSWORD,
    source: domain.email && domain.email.trim() ? 'per-domain' : 'env',
  };
}

function isLoginUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.includes('/login');
  } catch {
    return url.includes('/login');
  }
}

async function findLoginField(page) {
  const candidates = [
    'input[name="email"]', 'input[name="username"]', 'input[type="email"]',
    'input[name="login"]', 'input[name="identity"]', 'input[autocomplete="username"]',
  ];
  for (const sel of candidates) if (await page.$(sel)) return sel;
  const handle = await page.$('input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])');
  if (handle) {
    const name = await handle.getAttribute('name');
    if (name) return `input[name="${name}"]`;
  }
  return null;
}
async function findPasswordField(page) {
  for (const sel of ['input[name="password"]', 'input[type="password"]']) if (await page.$(sel)) return sel;
  return null;
}
async function findSubmitButton(page) {
  for (const sel of ['button:has-text("Login")', 'button:has-text("Sign in")', 'button:has-text("Sign In")', 'button[type="submit"]', 'input[type="submit"]']) {
    if (await page.$(sel)) return sel;
  }
  return null;
}

async function loginIfNeeded(page, context, domain) {
  if (!isLoginUrl(page.url())) return false;
  console.log(`[${domain.name}] Redirected to login — logging in...`);
  const emailSel  = await findLoginField(page);
  const passSel   = await findPasswordField(page);
  const submitSel = await findSubmitButton(page);
  if (!emailSel || !passSel || !submitSel) throw new Error(`login_fields_not_found (email=${emailSel}, pass=${passSel}, submit=${submitSel})`);

  const creds = resolveCreds(domain);
  console.log(`[${domain.name}] Login selectors: ${emailSel} / ${passSel} / ${submitSel}`);
  console.log(`[${domain.name}] Using ${creds.source} credentials for ${creds.email}`);

  await page.fill(emailSel, creds.email);
  await page.fill(passSel, creds.password);
  if (await page.$('input[name="remember"]')) {
    await page.check('input[name="remember"]', { force: true }).catch(() => {});
  }

  const urlBefore = page.url();
  await Promise.all([
    page.waitForURL(u => !isLoginUrl(u.toString()), { timeout: 30000 }),
    page.click(submitSel),
  ]).catch(() => {});

  const urlAfter = page.url();
  if (isLoginUrl(urlAfter)) {
    const errText = await page.evaluate(() => {
      const sels = ['.alert', '.toast', '.error', '.text-danger', '.invalid-feedback', '[role="alert"]'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          const t = (el.textContent || '').trim();
          if (t && t.length > 2 && t.length < 300) return t;
        }
      }
      return null;
    }).catch(() => null);
    if (errText) console.log(`[${domain.name}] Login error from page: ${JSON.stringify(errText)}`);
    console.log(`[${domain.name}] URL before: ${urlBefore}`);
    console.log(`[${domain.name}] URL after:  ${urlAfter}`);
    try { await page.screenshot({ path: join(SHOT_DIR, `${domain.name}-login-failed.png`), fullPage: true }); } catch {}
    throw new Error(`login_failed${errText ? ` — ${errText}` : ''}`);
  }

  await context.storageState({ path: domain.stateFilePath });
  console.log(`[${domain.name}] ✅ Login OK. Cookies saved.`);
  return true;
}

async function detectTemplate(page) {
  return page.evaluate(() => {
    const form = document.querySelector('form[action*="crypto-wallet"]');
    if (!form) return 'unknown';
    if (form.querySelector('input[name*="[networks][0][address]"]')) return 'multinet';
    return 'standard';
  });
}

async function readFormState(page) {
  return page.evaluate(() => {
    const addresses = {};
    const active = {};
    const multiNet = {};
    for (const input of document.querySelectorAll('input[name*="[address]"]')) {
      const mnetMatch = input.name.match(/^config\[wallet\]\[([A-Za-z0-9_]+)\]\[networks\]\[(\d+)\]\[address\]$/);
      if (mnetMatch) {
        const [, coin, idx] = mnetMatch;
        if (!multiNet[coin]) multiNet[coin] = [];
        multiNet[coin].push({ index: idx, address: input.value });
        if (addresses[coin] === undefined) addresses[coin] = input.value;
        continue;
      }
      const stdMatch = input.name.match(/^config\[wallet\]\[([A-Za-z0-9_]+)\]\[address\]$/);
      if (stdMatch) addresses[stdMatch[1]] = input.value;
    }
    for (const cb of document.querySelectorAll('input[name="currencies[]"]')) {
      const cur = cb.value;
      if (cur) active[cur] = cb.checked && !cb.disabled;
    }
    return { addresses, active, multiNet };
  });
}

async function fillAddress(page, currency, value, networkIndex = null) {
  const sel = networkIndex !== null
    ? `input[name="config[wallet][${currency}][networks][${networkIndex}][address]"]`
    : `input[name="config[wallet][${currency}][address]"]`;
  await page.fill(sel, value);
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return;
    for (const t of ['input', 'change', 'keyup', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
  }, sel);
}

async function waitForButtonReady(page, template, timeoutMs = 5000) {
  const sel = template === 'multinet' ? '.submit-crypto-wallet' : '.submit-settings';
  await page.waitForSelector(sel, { state: 'visible', timeout: timeoutMs });
  if (template === 'standard') {
    await page.waitForFunction(() => {
      const b = document.querySelector('.submit-settings');
      return b && !b.disabled;
    }, { timeout: timeoutMs });
  }
  return sel;
}

async function attemptSubmit(page, domain, toChange, template) {
  const submitSel = template === 'multinet' ? '.submit-crypto-wallet' : '.submit-settings';
  const domainRoot = new URL(domain.formUrl).origin;

  const responsePromise = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().startsWith(domainRoot),
    { timeout: 20000 }
  ).catch(() => null);

  await page.evaluate(() => {
    window.__toastLog = [];
    window.__toastObserver = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== 1) continue;
          const txt = (node.textContent || '').trim();
          if (!txt || txt.length < 3 || txt.length > 500) continue;
          window.__toastLog.push({ text: txt, time: Date.now() });
        }
      }
    });
    window.__toastObserver.observe(document.body, { childList: true, subtree: true });
  });

  await page.click(submitSel);

  let responseBody = null;
  let responseStatus = null;
  try {
    const response = await responsePromise;
    if (response) {
      responseStatus = response.status();
      try { responseBody = await response.json(); }
      catch { try { responseBody = await response.text(); } catch {} }
    }
  } catch {}

  await page.waitForTimeout(500);

  const toastLog = await page.evaluate(() => window.__toastLog || []).catch(() => []);

  let msg = null, type = null, source = 'none';

  if (responseBody && typeof responseBody === 'object') {
    const bodyMsg = responseBody.msg || responseBody.message;
    if (bodyMsg) {
      msg = String(bodyMsg);
      type = responseBody.type || (responseStatus && responseStatus < 400 ? 'success' : 'error');
      const lower = msg.toLowerCase();
      if (/error|fail|expired|invalid|denied|cannot|not\s+allowed|wrong|sorry/i.test(lower)) type = 'error';
      source = 'ajax';
    } else if (responseBody.errors) {
      const flat = Object.values(responseBody.errors).flat();
      msg = String(flat[0] || 'validation error');
      type = 'error';
      source = 'ajax-errors';
    }
  } else if (typeof responseBody === 'string' && responseBody.length > 0 && responseBody.length < 500) {
    msg = responseBody.trim();
    type = responseStatus && responseStatus < 400 ? 'success' : 'error';
    source = 'ajax-text';
  }

  if (!msg && toastLog.length > 0) {
    const indicators = /(success|successful|updated|saved|error|fail|expired|invalid|419|missing|required|denied|cannot|wrong|complete|payment|sorry)/i;
    const candidates = toastLog
      .map(t => ({ text: t.text.replace(/\s*[×✕⨯]\s*$/, '').replace(/^Close/i, '').trim() }))
      .filter(t => t.text && indicators.test(t.text));
    if (candidates.length > 0) {
      const atomic = candidates.filter((t1, i) =>
        !candidates.some((t2, j) => i !== j && t2.text.includes(t1.text) && t2.text.length > t1.text.length)
      );
      atomic.sort((a, b) => a.text.length - b.text.length);
      msg = atomic[0].text;
      const lower = msg.toLowerCase();
      type = /success|updated|saved|complete/i.test(lower) ? 'success'
           : /sorry|wrong|error|fail/i.test(lower) ? 'error'
           : 'unknown';
      source = 'dom-observer';
    }
  }

  if (!msg) {
    const domText = await page.evaluate(() => {
      const sels = ['.jq-toast-single', '.jq-toast-heading', '.toast', '.alert', '[role="alert"]', '.iziToast', '.swal2-popup'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          const t = (el.textContent || '').trim();
          if (t && t.length > 3) return t;
        }
      }
      return null;
    }).catch(() => null);
    if (domText) {
      msg = domText.replace(/\s*[×✕⨯]\s*$/, '').replace(/^Close/i, '').trim();
      const lower = msg.toLowerCase();
      type = /success|updated|saved|complete/i.test(lower) ? 'success'
           : /sorry|wrong|error|fail/i.test(lower) ? 'error'
           : 'unknown';
      source = 'dom-selector';
    }
  }

  await page.evaluate(() => {
    if (window.__toastObserver) {
      window.__toastObserver.disconnect();
      window.__toastObserver = null;
    }
  }).catch(() => {});

  try {
    await page.screenshot({ path: join(SHOT_DIR, `${domain.name}-after-submit.png`), fullPage: true });
  } catch {}

  return { detected: !!msg, text: msg, type, source, responseStatus };
}

async function verifyPersisted(page, domain, toChange) {
  try {
    await page.goto(domain.formUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('form[action*="crypto-wallet"]', { timeout: 10000 });
    const { addresses: after } = await readFormState(page);
    const stillWrong = Object.entries(toChange).filter(([cur, { to }]) => after[cur] !== to);
    if (stillWrong.length === 0) {
      return {
        detected: true,
        text: `verified via reload (${Object.keys(toChange).length} field(s) confirmed saved on server)`,
        type: 'success',
        source: 'reload-verify',
      };
    }
    return {
      detected: true,
      text: `reload-verify: ${stillWrong.map(([c]) => c).join(', ')} still incorrect on server`,
      type: 'error',
      source: 'reload-verify',
    };
  } catch (e) {
    return { detected: false, text: null, type: null, source: 'reload-verify-error', error: e.message };
  }
}

async function clickAndVerify(page, domain, toChange, template) {
  let attempt = await attemptSubmit(page, domain, toChange, template);
  console.log(`[${domain.name}] Attempt 1: ${JSON.stringify(attempt)}`);

  if (attempt.type !== 'success') {
    console.log(`[${domain.name}] Attempt 1 not success — running reload-verify to check server state`);
    const verify = await verifyPersisted(page, domain, toChange);
    console.log(`[${domain.name}] Reload-verify: ${JSON.stringify(verify)}`);
    if (verify.detected && verify.type === 'success') {
      return { ...verify, note: `ajax_said_${attempt.type || 'nothing'}_but_data_persisted` };
    }
    if (attempt.type === 'error' || !attempt.detected) {
      console.log(`[${domain.name}] Retrying submit once...`);
      await page.goto(domain.formUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('form[action*="crypto-wallet"]', { timeout: 10000 });
      const { active: activeNow } = await readFormState(page);
      for (const [cur, { to, networkIndex }] of Object.entries(toChange)) {
        if (!activeNow[cur]) continue;
        await fillAddress(page, cur, to, networkIndex);
      }
      try {
        await waitForButtonReady(page, template, 5000);
      } catch {}
      attempt = await attemptSubmit(page, domain, toChange, template);
      console.log(`[${domain.name}] Attempt 2: ${JSON.stringify(attempt)}`);
      if (attempt.type === 'success') return attempt;
      const verify2 = await verifyPersisted(page, domain, toChange);
      console.log(`[${domain.name}] Reload-verify 2: ${JSON.stringify(verify2)}`);
      return verify2;
    }
  }
  return attempt;
}

async function syncDomain(browser, domain, desired) {
  const log = m => console.log(`[${domain.name}] ${m}`);
  const result = {
    name: domain.name, status: 'unknown', changes: {}, skippedInactive: [], error: null,
    template: 'unknown', freshLogin: 'cookie', fieldCount: 0,
    activeList: [], inactiveList: [], notOnDomain: [], ambiguous: [],
  };

  const hasState = await fileExists(domain.stateFilePath);
  if (!hasState) {
    log('No saved cookies — will log in fresh.');
    result.freshLogin = 'fresh-attempt';
  }

  const context = hasState
    ? await browser.newContext({ storageState: domain.stateFilePath })
    : await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    log(`→ ${domain.formUrl}`);
    await page.goto(domain.formUrl, { waitUntil: 'domcontentloaded' });

    const didLogin = await loginIfNeeded(page, context, domain);
    if (didLogin) {
      result.freshLogin = 'fresh';
      await page.goto(domain.formUrl, { waitUntil: 'domcontentloaded' });
    }

    await page.waitForSelector('form[action*="crypto-wallet"]', { timeout: 10000 });
    log('✅ Form loaded');

    const template = await detectTemplate(page);
    result.template = template;
    log(`Template: ${template}`);

    const { addresses: current, active, multiNet } = await readFormState(page);
    result.fieldCount = Object.keys(current).length;

    const activeList = Object.entries(active).filter(([,v]) => v).map(([k]) => k);
    const inactiveList = Object.entries(active).filter(([,v]) => !v).map(([k]) => k);
    result.activeList = activeList;
    result.inactiveList = inactiveList;

    log(`Read ${result.fieldCount} address fields: ${Object.keys(current).join(', ') || '(none)'}`);
    log(`Active currencies: ${activeList.join(', ') || '(none)'}`);
    if (inactiveList.length > 0) log(`Inactive currencies (will NOT touch): ${inactiveList.join(', ')}`);

    if (result.fieldCount === 0) {
      log('⚠️  Form loaded but has no crypto address fields — skipping domain.');
      result.status = 'no_address_fields';
      return result;
    }

    const effectiveDesired = {
      ...desired,
      ...(template === 'multinet' ? LEGACY_OVERRIDES_MULTINET : {}),
      ...(domain.addressOverrides || {}),
    };
    if (template === 'multinet') {
      log(`Multi-net template → BTC override: ${LEGACY_OVERRIDES_MULTINET.BTC}`);
    }

    const toChange = {};
    const skippedInactive = [];
    const notOnDomain = [];
    const ambiguous = [];

    for (const [cur, want] of Object.entries(effectiveDesired)) {
      if (current[cur] === undefined) { notOnDomain.push(cur); continue; }
      if (!active[cur]) { skippedInactive.push(cur); continue; }
      if (template === 'multinet' && multiNet[cur] && multiNet[cur].length > 1) {
        ambiguous.push(`${cur}(${multiNet[cur].length})`);
        continue;
      }
      if (current[cur] !== want) {
        toChange[cur] = {
          from: current[cur], to: want,
          networkIndex: template === 'multinet' ? multiNet[cur][0].index : null,
        };
      }
    }

    result.skippedInactive = skippedInactive;
    result.notOnDomain = notOnDomain;
    result.ambiguous = ambiguous;

    if (ambiguous.length > 0)       log(`⚠️  Ambiguous (multiple networks, skipping): ${ambiguous.join(', ')}`);
    if (skippedInactive.length > 0) log(`⏭  Skipped (inactive, will not activate): ${skippedInactive.join(', ')}`);
    if (notOnDomain.length > 0)     log(`⏭  Skipped (not present on domain): ${notOnDomain.join(', ')}`);

    if (Object.keys(toChange).length === 0) {
      log('✅ All active currencies already correct — nothing to do');
      result.status = 'noop';
      return result;
    }

    log(`⚠️  ${Object.keys(toChange).length} active mismatch(es):`);
    for (const [cur, { from, to, networkIndex }] of Object.entries(toChange)) {
      const netSuffix = networkIndex !== null ? ` [net#${networkIndex}]` : '';
      log(`    ${cur}${netSuffix}: ${from || '(empty)'}  →  ${to}`);
    }

    if (DRY_RUN) {
      log('DRY RUN — not filling or submitting.');
      result.status = 'would_update';
      result.changes = Object.fromEntries(Object.entries(toChange).map(([k, v]) => [k, v.to]));
      return result;
    }

    for (const [cur, { to, networkIndex }] of Object.entries(toChange)) {
      await fillAddress(page, cur, to, networkIndex);
    }

    const { active: activeAfter } = await readFormState(page);
    const flipped = Object.keys(active).filter(c => active[c] !== activeAfter[c]);
    if (flipped.length > 0) {
      log(`❌ Checkbox state changed unexpectedly for: ${flipped.join(', ')} — ABORTING`);
      await page.screenshot({ path: join(SHOT_DIR, `${domain.name}-checkbox-changed.png`), fullPage: true });
      result.status = 'checkbox_changed';
      return result;
    }
    log('✅ Checkbox states unchanged (no activation/deactivation)');

    try {
      await waitForButtonReady(page, template, 5000);
      log('✅ Submit button ready');
    } catch {
      log('❌ Submit button not ready — aborting');
      await page.screenshot({ path: join(SHOT_DIR, `${domain.name}-button-disabled.png`), fullPage: true });
      result.status = 'button_not_ready';
      return result;
    }

    log('Clicking Update...');
    const toast = await clickAndVerify(page, domain, toChange, template);
    log(`Final result: ${JSON.stringify(toast)}`);

    if (!toast.detected) { result.status = 'unverified'; result.error = `source=${toast.source}`; return result; }
    if (toast.type !== 'success') { result.status = 'submit_failed'; result.error = toast.text; return result; }

    result.status = 'ok';
    result.changes = Object.fromEntries(Object.entries(toChange).map(([k, v]) => [k, v.to]));
    log('✅ Update succeeded');
    return result;

  } catch (err) {
    log(`❌ FATAL: ${err.message}`);
    result.status = 'error';
    result.error = err.message;
    try { await page.screenshot({ path: join(SHOT_DIR, `${domain.name}-error.png`), fullPage: true }); } catch {}
    return result;
  } finally {
    await context.close();
  }
}

function shortAddr(a) {
  if (!a) return '(empty)';
  return a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;
}

function printDiagnosticTable(results) {
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║  DIAGNOSTIC REPORT                                                                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════════════╝');
  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
  console.log(`${pad('Domain', 30)} ${pad('Template', 10)} ${pad('Status', 20)} ${pad('Field', 6)} ${pad('Act', 4)} ${pad('Inact', 6)} ${pad('Miss', 5)} ${pad('Login', 12)} ${pad('Time', 7)}`);
  console.log('─'.repeat(114));
  for (const r of results) {
    const t = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.log(`${pad(r.name, 30)} ${pad(r.template, 10)} ${pad(r.status, 20)} ${pad(r.fieldCount, 6)} ${pad(r.activeList.length, 4)} ${pad(r.inactiveList.length, 6)} ${pad(Object.keys(r.changes).length, 5)} ${pad(r.freshLogin, 12)} ${pad(t, 7)}`);
  }
  const counts = {
    ok: results.filter(r => r.status === 'ok').length,
    noop: results.filter(r => r.status === 'noop').length,
    would_update: results.filter(r => r.status === 'would_update').length,
    no_address_fields: results.filter(r => r.status === 'no_address_fields').length,
    failed: results.filter(r => !['ok', 'noop', 'would_update', 'no_address_fields'].includes(r.status)).length,
  };
  console.log('\nCounts:');
  console.log(`  ✅ ok / would_update:   ${counts.ok + counts.would_update}`);
  console.log(`  ℹ️  noop:               ${counts.noop}`);
  console.log(`  ⚪ no_address_fields:   ${counts.no_address_fields}`);
  console.log(`  ❌ failed:              ${counts.failed}`);
  const multinetDomains = results.filter(r => r.template === 'multinet').map(r => r.name);
  if (multinetDomains.length > 0) console.log(`\n  Multinet domains: ${multinetDomains.join(', ')}`);
  const failedDomains = results.filter(r => !['ok', 'noop', 'would_update', 'no_address_fields'].includes(r.status));
  if (failedDomains.length > 0) {
    console.log('\nFailed domains — details:');
    for (const r of failedDomains) {
      console.log(`\n  ❌ ${r.name}`);
      console.log(`     template: ${r.template}`);
      console.log(`     status:   ${r.status}`);
      if (r.error) console.log(`     error:    ${r.error}`);
      console.log(`     screenshot: state/screenshots/${r.name}-error.png`);
    }
  }
  const wouldUpdate = results.filter(r => r.status === 'would_update');
  if (wouldUpdate.length > 0) {
    console.log('\nWould update (active mismatches only):');
    for (const r of wouldUpdate) {
      console.log(`\n  🟡 ${r.name} (${r.template})`);
      for (const [cur, addr] of Object.entries(r.changes)) {
        console.log(`     ${cur.padEnd(7)} → ${shortAddr(addr)}`);
      }
    }
  }
}

async function writeDiagnosticReport(results) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(REPORTS_DIR, `diagnostic-${ts}.json`);
  const report = {
    timestamp: new Date().toISOString(),
    mode: 'diagnostic',
    domains: results.map(r => ({
      name: r.name,
      template: r.template,
      status: r.status,
      durationMs: r.durationMs,
      freshLogin: r.freshLogin,
      fieldCount: r.fieldCount,
      active: r.activeList,
      inactive: r.inactiveList,
      notOnDomain: r.notOnDomain,
      ambiguous: r.ambiguous,
      mismatches: Object.fromEntries(Object.entries(r.changes).map(([k, v]) => [k, { to: shortAddr(v) }])),
      error: r.error,
    })),
    summary: {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      noop: results.filter(r => r.status === 'noop').length,
      would_update: results.filter(r => r.status === 'would_update').length,
      no_address_fields: results.filter(r => r.status === 'no_address_fields').length,
      failed: results.filter(r => !['ok', 'noop', 'would_update', 'no_address_fields'].includes(r.status)).length,
      templates: {
        standard: results.filter(r => r.template === 'standard').length,
        multinet: results.filter(r => r.template === 'multinet').length,
        unknown: results.filter(r => r.template === 'unknown').length,
      },
    },
  };
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`\n📄 Report written: ${path}`);
}

async function main() {
  await mkdir(STATE_DIR, { recursive: true });
  await mkdir(SHOT_DIR, { recursive: true });
  await mkdir(REPORTS_DIR, { recursive: true });

  const desired = JSON.parse(await readFile(join(ROOT, 'config', 'addresses.json'), 'utf8'));
  const cfg     = JSON.parse(await readFile(join(ROOT, 'config', 'domains.json'), 'utf8'));
  let domains = cfg.domains.map(d => ({ ...d, stateFilePath: join(ROOT, d.stateFile) }));

  if (DOMAIN_FILTER) {
    const wanted = new Set(DOMAIN_FILTER);
    domains = domains.filter(d => wanted.has(d.name));
    if (domains.length === 0) {
      console.error(`No matching domains for: ${DOMAIN_FILTER.join(', ')}`);
      console.error(`Available: ${cfg.domains.map(d => d.name).join(', ')}`);
      process.exit(1);
    }
  }

  console.log(`[sync] mode=${DRY_RUN ? 'DRY-RUN' : 'LIVE'}${DIAGNOSTIC ? ' (DIAGNOSTIC)' : ''}  domains=${domains.length}/${cfg.domains.length}  addresses=${Object.keys(desired).length}`);
  if (DOMAIN_FILTER) console.log(`[sync] filter: ${DOMAIN_FILTER.join(', ')}`);
  console.log('');

  // Edit A: headless when HEADLESS=true (set by GitHub Actions)
  const browser = await chromium.launch({ headless: process.env.HEADLESS === 'true' });
  const results = [];
  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    if (DIAGNOSTIC || domains.length > 1) console.log(`\n━━━ [${i + 1}/${domains.length}] ${domain.name} ━━━`);
    const start = Date.now();
    const result = await syncDomain(browser, domain, desired);
    result.durationMs = Date.now() - start;
    results.push(result);
    if (i < domains.length - 1) await new Promise(r => setTimeout(r, 1500));
    console.log('');
  }
  await browser.close();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                                     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅'
              : r.status === 'noop' ? 'ℹ️ '
              : r.status === 'would_update' ? '🟡'
              : r.status === 'no_address_fields' ? '⚪'
              : '❌';
    console.log(`${icon} ${r.name.padEnd(32)} ${r.status}`);
    for (const [cur, addr] of Object.entries(r.changes)) console.log(`     ${cur.padEnd(6)} → ${addr}`);
    if (r.skippedInactive?.length) console.log(`     skipped inactive: ${r.skippedInactive.join(', ')}`);
    if (r.error) console.log(`     error: ${r.error}`);
  }

  if (DIAGNOSTIC) {
    printDiagnosticTable(results);
    await writeDiagnosticReport(results);
  }

  // Edit B — last-run report for situation page
  const lastRun = {
    timestamp: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    summary: {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      noop: results.filter(r => r.status === 'noop').length,
      would_update: results.filter(r => r.status === 'would_update').length,
      no_address_fields: results.filter(r => r.status === 'no_address_fields').length,
      failed: results.filter(r => !['ok', 'noop', 'would_update', 'no_address_fields'].includes(r.status)).length,
    },
    domains: results.map(r => ({
      name: r.name,
      status: r.status,
      template: r.template,
      changes: r.changes,
      skippedInactive: r.skippedInactive,
      error: r.error,
      durationMs: r.durationMs,
    })),
  };
  try {
    await writeFile(join(REPORTS_DIR, 'last-run.json'), JSON.stringify(lastRun, null, 2));
    console.log(`\n📄 Last-run report: state/reports/last-run.json`);
  } catch (e) {
    console.error(`Failed to write last-run report: ${e.message}`);
  }

  // Edit B — GitHub Actions step summary (rendered on the run page)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const s = lastRun.summary;
    const lines = [];
    lines.push(`## Crypto sync — ${lastRun.timestamp}`);
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| ✅ ok | ${s.ok} |`);
    lines.push(`| ℹ️ noop | ${s.noop} |`);
    lines.push(`| 🟡 would_update | ${s.would_update} |`);
    lines.push(`| ⚪ no_address_fields | ${s.no_address_fields} |`);
    lines.push(`| ❌ failed | ${s.failed} |`);
    lines.push(`| **Total** | **${s.total}** |`);
    lines.push('');
    const failed = lastRun.domains.filter(d => !['ok', 'noop', 'would_update', 'no_address_fields'].includes(d.status));
    if (failed.length > 0) {
      lines.push('### ❌ Failed');
      for (const d of failed) {
        lines.push(`- **${d.name}** — \`${d.status}\`${d.error ? ` — ${d.error}` : ''}`);
      }
      lines.push('');
    }
    const changed = lastRun.domains.filter(d => d.status === 'ok' && Object.keys(d.changes).length > 0);
    if (changed.length > 0) {
      lines.push('### ✏️ Changed');
      for (const d of changed) {
        const list = Object.entries(d.changes).map(([c]) => c).join(', ');
        lines.push(`- **${d.name}** — fixed: ${list}`);
      }
      lines.push('');
    }
    const skipped = lastRun.domains.filter(d => d.skippedInactive.length > 0);
    if (skipped.length > 0) {
      lines.push('### ⏭ Skipped inactive currencies');
      for (const d of skipped) {
        lines.push(`- **${d.name}** — ${d.skippedInactive.join(', ')}`);
      }
      lines.push('');
    }
    try {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
    } catch {}
  }

  process.exit(results.some(r => !['ok', 'noop', 'would_update', 'no_address_fields'].includes(r.status)) ? 1 : 0);
}

main().catch(err => { console.error('[sync] FATAL:', err); process.exit(1); });