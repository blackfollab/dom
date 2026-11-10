import fs from 'fs';
import path from 'path';

const STATE_DIR = 'state';
const SHOT_DIR = 'state/screenshots';
const REPORT_DIR = 'state/reports';

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

const cfg = JSON.parse(fs.readFileSync('config/domains.json', 'utf8'));
const lookup = {};
for (const d of cfg.domains) {
  const key = 'COOKIE_' + d.name.replace(/[.:-]/g, '_').toUpperCase();
  lookup[key] = d.name;
}

let restored = 0, missing = 0;
for (const [key, val] of Object.entries(process.env)) {
  if (!key.startsWith('COOKIE_')) continue;
  const domain = lookup[key];
  if (!domain) {
    console.log(`  ? ${key} — no matching domain in config, skipping`);
    continue;
  }
  if (!val || !val.trim()) {
    console.log(`  · ${domain} — empty secret, skipping`);
    missing++;
    continue;
  }
  fs.writeFileSync(path.join(STATE_DIR, `${domain}.json`), val);
  console.log(`  ✓ ${domain}`);
  restored++;
}

console.log(`\nRestored ${restored} cookie files, skipped ${missing} empty, ${Object.keys(lookup).length - restored - missing} not present`);