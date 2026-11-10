import { chromium } from 'playwright';
import { config } from 'dotenv';
import { mkdir, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(__dirname, '..', 'state');
const STATE_FILE = join(STATE_DIR, 'bitscrest.json');

const FORM_URL  = 'https://bitscrest.com/user/admin/settings/gateway/payment-method/crypto-wallet';
const EMAIL     = process.env.LOGIN_EMAIL;
const PASSWORD  = process.env.LOGIN_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: LOGIN_EMAIL and LOGIN_PASSWORD must be set in .env');
  process.exit(1);
}

const fileExists = async p => { try { await access(p); return true; } catch { return false; } };

async function main() {
  await mkdir(STATE_DIR, { recursive: true });

  const hasState = await fileExists(STATE_FILE);
  console.log(`[pilot] Saved cookies present: ${hasState}`);

  const browser = await chromium.launch({ headless: false });
  const context = hasState
    ? await browser.newContext({ storageState: STATE_FILE })
    : await browser.newContext();

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  console.log(`[pilot] → ${FORM_URL}`);
  await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });

  if (page.url().includes('/login')) {
    console.log('[pilot] Redirected to login. Logging in...');
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.check('input[name="remember"]', { force: true });
    console.log('[pilot] Remember-me checked. Submitting...');

    await Promise.all([
      page.waitForURL(u => !u.toString().includes('/login'), { timeout: 30000 }),
      page.click('button:has-text("Login")'),
    ]).catch(() => {});

    if (page.url().includes('/login')) {
      await page.screenshot({ path: join(STATE_DIR, 'login-failed.png'), fullPage: true });
      console.error('[pilot] ❌ Login FAILED. Still on login page.');
      console.error('[pilot] Body text:', (await page.textContent('body'))?.slice(0, 400));
      await browser.close();
      process.exit(2);
    }

    await context.storageState({ path: STATE_FILE });
    console.log(`[pilot] ✅ Login OK. Cookies saved → ${STATE_FILE}`);

    console.log(`[pilot] → ${FORM_URL}`);
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
  } else {
    console.log('[pilot] ✅ Saved cookies valid — no login needed.');
  }

  await page.waitForSelector('form[action*="crypto-wallet"]', { timeout: 10000 });
  console.log('[pilot] ✅ Form found on page.');

  const snapshot = await page.evaluate(() => {
    const addresses = {};
    for (const input of document.querySelectorAll('input[name*="[address]"]')) {
      const m = input.name.match(/config\[wallet\]\[([A-Z0-9]+)\]\[address\]/);
      if (m) addresses[m[1]] = input.value;
    }
    const submitBtn = document.querySelector('.submit-settings');
    const csrfToken = document.querySelector('input[name="_token"]')?.value ?? null;
    return {
      addresses,
      submitBtn: submitBtn ? {
        found: true,
        disabled: submitBtn.disabled,
        text: submitBtn.textContent.trim(),
      } : { found: false },
      csrfTokenPresent: Boolean(csrfToken),
    };
  });

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  CURRENT ADDRESSES ON bitscrest.com                  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (Object.keys(snapshot.addresses).length === 0) {
    console.log('  ⚠️  No address fields found!');
  } else {
    for (const [cur, addr] of Object.entries(snapshot.addresses)) {
      console.log(`  ${cur.padEnd(7)} ${addr}`);
    }
  }
  console.log('\n  Submit button :', JSON.stringify(snapshot.submitBtn));
  console.log('  CSRF token    :', snapshot.csrfTokenPresent ? 'present ✅' : 'MISSING ⚠️');

  await page.screenshot({ path: join(STATE_DIR, 'form-loaded.png'), fullPage: true });
  console.log(`\n[pilot] Screenshot → state/form-loaded.png`);

  console.log('\n👉 Look at the browser window. Verify:');
  console.log('   1. Form is the Crypto Wallet Payment Method page');
  console.log('   2. Addresses above match what you see on the page');
  console.log('   3. No unexpected dialogs / modals / human-check screens');
  console.log('\nPress ENTER here to close the browser.\n');

  await new Promise(r => process.stdin.once('data', r));
  await browser.close();
  console.log('[pilot] Done.');
}

main().catch(err => {
  console.error('[pilot] FATAL:', err);
  process.exit(1);
});