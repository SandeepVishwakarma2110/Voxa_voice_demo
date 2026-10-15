#!/usr/bin/env node
/**
 * scripts/check-google-auth.js
 *
 * Works out WHY Google rejects the service account — "invalid_grant: Invalid
 * JWT Signature" has several causes that look identical in the error.
 *
 *   node scripts/check-google-auth.js
 *   node scripts/check-google-auth.js path/to/service-account.json
 *
 * Prints only non-secret fields (email, project, key id). The private key is
 * never printed.
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import crypto from 'crypto';
import path from 'path';

const KEY_FILE = path.resolve(process.argv[2] || './service-account.json');
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = (m, d = '') => console.log(`  ${C.g}PASS${C.x}  ${m}${d ? `  ${C.d}${d}${C.x}` : ''}`);
const bad = (m, d = '') => console.log(`  ${C.r}FAIL${C.x}  ${m}${d ? `\n        ${d}` : ''}`);
const info = (m) => console.log(`  ${C.d}·     ${m}${C.x}`);
const verdict = (m, fix) => {
  console.log(`\n${C.b}Diagnosis:${C.x} ${m}\n`);
  if (fix) console.log(`${C.b}Fix:${C.x}\n${fix}\n`);
  process.exit(1);
};

console.log(`\n${C.b}Google service account check${C.x}\n`);

// ── 1. The file itself ──────────────────────────────────────────────────────
if (!existsSync(KEY_FILE)) {
  bad('key file exists', KEY_FILE);
  verdict('The key file is missing from this project folder.',
    '  Copy service-account.json into the project root (next to package.json).');
}
let sa;
try {
  sa = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
  ok('key file is valid JSON', path.relative(process.cwd(), KEY_FILE));
} catch (e) {
  bad('key file is valid JSON', e.message);
  verdict('service-account.json is not valid JSON — it was damaged when copied.',
    '  Download a fresh key (see below) rather than repairing this one.');
}

const { client_email: email, private_key_id: keyId, private_key: pem, project_id: project } = sa;
info(`account:  ${email}`);
info(`project:  ${project}`);
info(`key id:   ${keyId}`);
if (!email || !keyId || !pem) {
  bad('file has client_email, private_key_id and private_key');
  verdict('This is not a complete service-account key file.',
    '  Download a JSON key for the service account from Google Cloud Console.');
}

// ── 2. The private key parses ───────────────────────────────────────────────
let privateKey;
try {
  privateKey = crypto.createPrivateKey(pem);
  ok('private key is a readable RSA key');
} catch (e) {
  bad('private key is a readable RSA key', e.message);
  const literal = pem.includes('\\n') && !pem.includes('\n');
  verdict(
    literal
      ? 'The private key contains literal "\\n" text instead of line breaks — it was mangled when copied.'
      : 'The private key is corrupted.',
    '  Download a fresh JSON key and use the file exactly as downloaded.');
}

// ── 3. The clock ────────────────────────────────────────────────────────────
// A JWT is only valid for a short window around its issue time, so a PC clock
// that is minutes off gets tokens rejected.
try {
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'GET', signal: AbortSignal.timeout(8000) });
  const serverTime = Date.parse(res.headers.get('date'));
  const skew = Math.round((Date.now() - serverTime) / 1000);
  if (Math.abs(skew) > 60) {
    bad('this PC\'s clock matches Google\'s', `off by ${skew} seconds`);
    verdict(`This PC's clock is ${Math.abs(skew)} seconds ${skew > 0 ? 'ahead' : 'behind'}.`,
      '  Windows: Settings -> Time & language -> Date & time -> "Sync now".\n' +
      '  Or in an admin terminal:  w32tm /resync');
  }
  ok('this PC\'s clock matches Google\'s', `${skew}s difference`);
} catch (e) {
  info(`could not reach Google to compare clocks (${e.message}) — skipping`);
}

// ── 4. Is this key still registered with Google? ────────────────────────────
// Google publishes the currently valid public certificates for every service
// account. A deleted or disabled key is not on the list.
let certs;
try {
  const url = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${encodeURIComponent(email)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) {
    bad('service account exists');
    verdict(`The service account ${email} no longer exists — it was deleted.`,
      '  Create a new service account (or restore it within 30 days), give it access\n' +
      '  to the calendar, and download a new JSON key.');
  }
  certs = await res.json();
  ok('service account exists', `${Object.keys(certs).length} active key(s)`);
} catch (e) {
  info(`could not fetch Google's key list (${e.message}) — skipping`);
}

if (certs) {
  if (!certs[keyId]) {
    bad('this key is still active', `key ${keyId} is not among the account's active keys`);
    verdict(
      'THIS KEY HAS BEEN DELETED OR DISABLED. The file is fine; Google no longer accepts it.\n' +
      '  Common reasons: someone deleted it, an org policy expired it, or Google disabled it\n' +
      '  automatically after finding it exposed (for example in a public GitHub repo).',
      `  1. Google Cloud Console -> IAM & Admin -> Service Accounts -> ${email}\n` +
      '  2. Keys tab -> Add key -> Create new key -> JSON\n' +
      '  3. Replace service-account.json with the downloaded file\n' +
      '  4. node scripts/check-google-auth.js\n' +
      '  Keep the key out of git: add service-account.json to .gitignore.');
  }
  ok('this key is still active');

  // ── 5. Does the private key actually match that registered key? ──────────
  const data = Buffer.from('xverse-key-check');
  const signature = crypto.sign('RSA-SHA256', data, privateKey);
  const matches = crypto.verify('RSA-SHA256', data, certs[keyId], signature);
  if (!matches) {
    bad('private key matches the registered key');
    verdict('The key ID is valid, but the private key in this file does not belong to it — the\n' +
      '  file was edited or assembled from two different keys.',
      '  Download a fresh JSON key and use it unedited.');
  }
  ok('private key matches the registered key');
}

// ── 6. Get a token and read the calendar ────────────────────────────────────
const { google } = await import('googleapis');
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE, scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  await auth.getAccessToken();
  ok('Google issued an access token');

  const calendarId = process.env.CALENDAR_ID;
  if (!calendarId) {
    info('CALENDAR_ID not set in .env — skipping the calendar read');
  } else {
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.list({ calendarId, maxResults: 1, timeMin: new Date().toISOString() });
    ok('can read the calendar', calendarId);
  }
} catch (e) {
  const code = e.code ?? e.response?.status;
  const desc = e.response?.data?.error_description ?? e.response?.data?.error?.message ?? e.message;
  if (code === 404) {
    bad('can read the calendar', desc);
    verdict('Authentication works, but CALENDAR_ID does not exist or the account cannot see it.',
      `  Check CALENDAR_ID in .env, and share that calendar with ${email}\n` +
      '  ("Make changes to events").');
  }
  if (code === 403) {
    bad('can read the calendar', desc);
    verdict('Authentication works, but the service account has no permission on this calendar.',
      `  In Google Calendar: calendar settings -> Share with specific people -> add\n  ${email} with "Make changes to events".`);
  }
  bad('Google issued an access token', desc);
  verdict(`Google rejected the credentials: ${desc}`,
    '  Download a fresh JSON key for the service account and replace service-account.json.');
}

console.log(`\n${C.g}${C.b}Google Calendar access is working.${C.x}\n`);
