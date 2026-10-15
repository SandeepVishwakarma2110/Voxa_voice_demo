#!/usr/bin/env node
//
// scripts/check-outbound.js
//
// Proves the whole outbound sequence without ringing anyone.
//
//   node scripts/check-outbound.js              dry run, end to end
//   node scripts/check-outbound.js --scan       dry-run a real sheet scan
//   node scripts/check-outbound.js --call 9876543210   place ONE REAL call
//
// It checks, in the order things actually fail:
//   1. credentials present, and the right ones in the right places
//   2. the spreadsheet opens, with the service account's own permissions
//   3. the columns are found, and every phone number parses
//   4. the Smartflo endpoint accepts the request shape
//   5. the status write-back works — on a row the dialer created itself
//
// Step 5 matters most: a sheet shared as VIEWER passes every read check and
// then fails on the first write, AFTER the call has been placed.

import 'dotenv/config';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i === -1 ? null : args[i + 1];
};

let pass = 0, fail = 0, warned = 0;
const fails = [];

const ok = (m, d = '') => { pass++; console.log(`  ${C.green}PASS${C.reset}  ${m}${d ? ` ${C.dim}${d}${C.reset}` : ''}`); };
const bad = (m, d = '') => { fail++; fails.push(m); console.log(`  ${C.red}FAIL${C.reset}  ${m}${d ? `\n        ${C.dim}${d}${C.reset}` : ''}`); };
const warn = (m, d = '') => { warned++; console.log(`  ${C.yellow}WARN${C.reset}  ${m}${d ? `\n        ${C.dim}${d}${C.reset}` : ''}`); };
const info = (m) => console.log(`  ${C.dim}·     ${m}${C.reset}`);
const head = (m) => console.log(`\n${C.bold}${C.cyan}── ${m}${C.reset}`);
const check = (cond, m, d = '', detail = '') => (cond ? ok(m, detail) : bad(m, d), cond);

// ─────────────────────────────────────────────────────────────────────────────
head('Credentials');

const { config } = await import('../src/config/index.js');
const o = config.outbound;

// The single most common mistake: using the account API token as the api_key,
// or vice versa. They are different credentials from different screens.
check(Boolean(o.apiToken), 'SMARTFLO_API_TOKEN is set (Authorization header)',
  'the header became mandatory on 2026-09-30, so a missing token now fails every call');
check(Boolean(o.ctcApiKey), 'SMARTFLO_CTC_API_KEY is set (request body "api_key")',
  'API Connect -> Click to Call Support API -> Generate New API Key. This is NOT the ' +
  'account API token, and it is the field that routes the call to your Voice Streaming endpoint.');

if (o.apiToken && o.ctcApiKey && o.apiToken === o.ctcApiKey) {
  bad('the two credentials are identical',
    'SMARTFLO_API_TOKEN and SMARTFLO_CTC_API_KEY must be different values — one is the ' +
    'account token, the other the Click to Call key');
} else if (o.apiToken && o.ctcApiKey) {
  ok('the two credentials are different values');
}

if (!o.callerId) {
  warn('SMARTFLO_CALLER_ID is not set',
    'Smartflo will pick a DID. Pinning the one your leads recognise improves answer rates.');
} else {
  const digits = o.callerId.replace(/\D/g, '');
  check(digits.length >= 10, 'SMARTFLO_CALLER_ID looks like a DID',
    `"${o.callerId}" has ${digits.length} digits`, o.callerId);
}

check(Boolean(o.apiKey), 'OUTBOUND_API_KEY is set',
  'without it the /outbound/* routes refuse to serve — they can dial any number from your DID');

info(`dry run        ${o.dryRun ? 'ON (no calls will be placed)' : `${C.red}OFF — real calls${C.reset}`}`);
info(`watcher        ${o.watch ? 'starts with the server' : 'off'}`);
info(`poll / batch   every ${Math.round(o.pollMs / 1000)}s, max ${o.maxPerScan} per pass, ${o.concurrency} at a time`);
info(`calling hours  ${o.hours || 'any time (consider setting OUTBOUND_HOURS=09:30-19:00)'}`);
info(`number format  ${o.numberFormat}`);

if (!o.hours) {
  warn('OUTBOUND_HOURS is not set',
    'a watcher left running will dial at 3am and over the weekend');
}
if (o.ringTimeoutSec < 10 || o.ringTimeoutSec > 30) {
  warn(`OUTBOUND_RING_TIMEOUT_SEC=${o.ringTimeoutSec} is outside Smartflo's documented 10-30`,
    'it is clamped before the request, so the call still goes out');
}

// ─────────────────────────────────────────────────────────────────────────────
head('Phone number handling');

const { normalizePhone, toDialFormat } = await import('../src/utils/phone.js');

const cases = [
  ['9876543210', '9876543210'],
  ['+91 98765 43210', '9876543210'],
  ['09876543210', '9876543210'],
  ['919876543210', '9876543210'],
  ['+919876543210', '9876543210'],
  ['98765-43210', '9876543210'],
  ['  9876543210  ', '9876543210'],
];
let phoneOk = true;
for (const [raw, want] of cases) {
  const got = normalizePhone(raw);
  if (got.national !== want) { phoneOk = false; bad(`"${raw}" normalises wrong`, `got "${got.national}" want "${want}"`); }
}
if (phoneOk) ok('every way a human writes an Indian mobile normalises the same', `${cases.length} forms`);

// All of these have burned someone. A sheet cell formatted as a number is the
// worst, because it silently becomes a DIFFERENT, real phone number.
const rejects = [
  ['1234567890', 'starts with 1'],
  ['98765', 'too short'],
  ['', 'empty'],
  ['abcdefghij', 'no digits'],
  // The STRING form is the dangerous one. A cell Sheets DISPLAYS as
  // "9.87654321E9" strips to the digits 9876543219 — a different, real number.
  ['9.87654321E9', 'displayed in exponential form'],
  // A numeric cell that lost precision: the digits can no longer be trusted.
  [9.8765432105e9, 'numeric cell past safe-integer precision'],
];
let rejectOk = true;
for (const [raw, why] of rejects) {
  const got = normalizePhone(raw);
  if (got.valid) { rejectOk = false; bad(`"${raw}" (${why}) was accepted`, `normalised to ${got.national}`); }
}
if (rejectOk) ok('unusable numbers are refused rather than guessed at', `${rejects.length} kinds`);

// An exact numeric cell is NOT a problem and must not be rejected: 9.87654321e9
// IS precisely 9876543210, and Number.isSafeInteger proves nothing was lost.
// An earlier version of this script asserted the opposite and failed on a
// perfectly good number.
check(normalizePhone(9876543210).national === '9876543210',
  'an exact numeric sheet cell is accepted', 'it is the same number, just typed as a number');

info(`a sheet value of 9876543210 is dialled as "${toDialFormat('9876543210', o.numberFormat)}"`);

// ─────────────────────────────────────────────────────────────────────────────
head('Google Sheet');

if (!config.sheet.id) {
  bad('SHEET_ID is not set',
    'copy it from the sheet URL: docs.google.com/spreadsheets/d/<SHEET_ID>/edit');
} else {
  const { describeSheet, readLeads, serviceAccountEmail, columnLetter } =
    await import('../src/tools/leadSheet.js');

  const email = await serviceAccountEmail();
  if (email) info(`service account ${email}`);
  else warn('could not read the service account email', `check ${config.google.keyFile} exists`);

  let described = null;
  try {
    described = await describeSheet();
    ok('the spreadsheet opens', `"${described.title}"`);
    info(`tabs: ${described.tabs.join(', ')}`);
  } catch (err) {
    bad('cannot open the spreadsheet', err.message);
  }

  if (described) {
    check(described.tabs.includes(config.sheet.tab),
      `SHEET_TAB "${config.sheet.tab}" exists`,
      `this spreadsheet has: ${described.tabs.join(', ')}`);
  }

  if (described && described.tabs.includes(config.sheet.tab)) {
    try {
      const sheet = await readLeads();
      ok('the header row parsed', sheet.headers.join(' | '));

      for (const field of ['phone', 'status']) {
        check(sheet.index[field] !== null, `a "${field}" column was found`,
          'required — the dialer cannot work without it',
          sheet.index[field] !== null ? `column ${columnLetter(sheet.index[field])}` : '');
      }
      for (const field of ['name', 'calledAt', 'refId', 'attempts', 'notes']) {
        if (sheet.index[field] === null) {
          info(`no "${field}" column — optional, that field will not be written`);
        } else {
          info(`"${field}" -> column ${columnLetter(sheet.index[field])}`);
        }
      }
      if (sheet.index.attempts === null) {
        warn('no "Attempts" column',
          'retry counting is disabled, so a number that keeps failing is retried on every pass. ' +
          'Add an Attempts column to cap it at OUTBOUND_MAX_ATTEMPTS.');
      }

      const want = String(config.sheet.statusNew).toLowerCase();
      const due = sheet.rows.filter((r) => r.status.toLowerCase() === want);
      const unparseable = sheet.rows.filter((r) => !r.phone);

      info(`${sheet.rows.length} data row(s), ${due.length} with status "${config.sheet.statusNew}"`);

      if (!sheet.rows.length) {
        warn('the sheet has no data rows');
      } else if (!due.length) {
        const seen = [...new Set(sheet.rows.map((r) => r.status || '(blank)'))];
        warn(`nothing is "${config.sheet.statusNew}" — nothing would be called`,
          `statuses present: ${seen.join(', ')}. SHEET_STATUS_NEW is "${config.sheet.statusNew}" (matched case-insensitively).`);
      } else {
        ok(`${due.length} row(s) would be called`,
          due.slice(0, 5).map((r) => `${r.name || '?'} ${r.phone}`).join(', '));
      }

      // Only a row the dialer would actually CALL can block the run.
      //
      // A sheet normally has trailing blanks and half-filled rows, and the
      // dialer never looks at them — it filters by status first. Failing the
      // whole check on a blank row at the bottom told you not to start, over
      // something that cannot affect a call.
      const dueBroken = unparseable.filter((r) => r.status.toLowerCase() === want);
      const idleBroken = unparseable.filter((r) => r.status.toLowerCase() !== want && !r.isBlank);
      const blanks = unparseable.filter((r) => r.isBlank);

      if (dueBroken.length) {
        bad(`${dueBroken.length} row(s) are "${config.sheet.statusNew}" but have an unusable number`,
          dueBroken.slice(0, 5).map((r) => `row ${r.rowNumber}: "${r.phoneRaw}" — ${r.phoneError}`).join('\n        ') +
          `\n        These will be marked "${config.sheet.statusInvalid}" and never dialled.`);
      } else if (due.length) {
        ok('every row that would be called has a usable number');
      }

      if (idleBroken.length) {
        warn(`${idleBroken.length} row(s) have no usable number, but are not "${config.sheet.statusNew}"`,
          idleBroken.slice(0, 5).map((r) => `row ${r.rowNumber}: name="${r.name}" phone="${r.phoneRaw}" status="${r.status}"`).join('\n        ') +
          '\n        The dialer ignores these — it filters by status before it looks at the number.');
      }
      if (blanks.length) {
        info(`${blanks.length} blank row(s) (${blanks.map((r) => r.rowNumber).join(', ')}) — ignored`);
      }

      const stuck = sheet.rows.filter((r) => r.status.toLowerCase() === String(config.sheet.statusCalling).toLowerCase());
      if (stuck.length) {
        warn(`${stuck.length} row(s) are stuck in "${config.sheet.statusCalling}"`,
          `rows ${stuck.map((r) => r.rowNumber).join(', ')} — a previous run was interrupted after ` +
          'claiming them. They will NOT be retried. Reset them to "New" by hand if they should be.');
      }

      // ── Write access, proven on a row we add and remove ourselves ───────
      //
      // A Viewer share passes every check above and fails on the first write —
      // which happens AFTER a call has been placed. So test it for real, on a
      // throwaway row, rather than inferring it.
      head('Sheet write access');
      const { google } = await import('googleapis');
      const auth = new google.auth.GoogleAuth({
        keyFile: config.google.keyFile,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const api = google.sheets({ version: 'v4', auth });
      const probeRow = sheet.rows.length + 2;
      const statusCell = `'${config.sheet.tab.replace(/'/g, "''")}'!${columnLetter(sheet.index.status)}${probeRow}`;

      try {
        await api.spreadsheets.values.update({
          spreadsheetId: config.sheet.id,
          range: statusCell,
          valueInputOption: 'RAW',
          requestBody: { values: [['__preflight__']] },
        });
        ok('the service account can WRITE to the sheet', `row ${probeRow}, cleaned up`);
        await api.spreadsheets.values.clear({ spreadsheetId: config.sheet.id, range: statusCell });
      } catch (err) {
        const detail = err.response?.data?.error?.message ?? err.message;
        bad('the service account CANNOT write to the sheet',
          `Share the sheet with ${email ?? 'the service account'} as an EDITOR, not a Viewer.\n        ` +
          'Without this every call is placed and then its status write fails, so the same ' +
          `person is called again on the next pass.\n        Detail: ${detail}`);
      }
    } catch (err) {
      bad('cannot read the lead rows', err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
head('Smartflo Click to Call');

const { OUTBOUND_ENDPOINT, placeOutboundCall } = await import('../src/services/smartfloOutbound.js');
info(`POST ${OUTBOUND_ENDPOINT}`);

// Validation runs before the network, so a dry run proves the request shape and
// the credential checks without touching the API.
const dry = await placeOutboundCall({ customerNumber: '9876543210', dryRun: true });
check(dry.ok, 'the request passes our own validation (dry run)', dry.message);

const badNum = await placeOutboundCall({ customerNumber: '123', dryRun: true });
check(!badNum.ok, 'a bad number is refused before any request is made', 'validation is not reached');

const realCall = valueOf('--call');
if (realCall) {
  head('REAL CALL');
  console.log(`  ${C.red}${C.bold}This will actually ring ${realCall}.${C.reset}`);
  const { dialOne } = await import('../src/services/outboundDialer.js');
  const res = await dialOne({ phone: realCall, name: valueOf('--name') ?? '', dryRun: false });
  if (res.ok) {
    ok('Smartflo accepted the call', `ref_id=${res.refId ?? 'none'}`);
    info('"queued" means accepted, NOT answered — watch the server log for the stream');
    info('you should see: [ws] OUTBOUND call connected');
  } else {
    bad('Smartflo refused the call', res.message);
  }
} else if (has('--scan')) {
  head('Sheet scan (dry run)');
  const { scanOnce } = await import('../src/services/outboundDialer.js');
  const result = await scanOnce({ dryRun: true });
  if (result.skipped) {
    warn(`scan skipped — ${result.reason}`);
  } else if (result.error) {
    bad('scan failed', result.error);
  } else {
    ok(`scan completed`, `${result.considered} due, ${result.called.length} would be called`);
    for (const c of result.called) info(`row ${c.row}: ${c.name || c.phone} -> would dial ${c.phone}`);
    for (const x of result.invalid) bad(`row ${x.row} marked Invalid`, x.reason);
    for (const x of result.failed) bad(`row ${x.row} failed`, x.reason);
    if (result.called.length) {
      warn('a dry-run scan DID write statuses to the sheet',
        'those rows now say "Called" with a "dry run" note. Reset them to "New" before the real run.');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(
  `${fail ? C.red : C.green}${C.bold}${pass} passed${C.reset}  ` +
  `${C.dim}${warned} warning(s)${C.reset}  ` +
  `${fail ? `${C.red}${fail} failed${C.reset}` : `${C.dim}0 failed${C.reset}`}`,
);

if (fail) {
  console.log(`\n${C.red}${C.bold}Do not start the dialer yet.${C.reset}`);
  for (const f of fails) console.log(`  ${C.dim}· ${f}${C.reset}`);
  process.exit(1);
}

console.log(`\n${C.green}${C.bold}Outbound path looks wired.${C.reset}`);
if (!has('--scan') && !valueOf('--call')) {
  console.log(`\nNext:\n  ${C.bold}node scripts/check-outbound.js --scan${C.reset}        dry-run a real sheet pass`);
  console.log(`  ${C.bold}node scripts/check-outbound.js --call <number>${C.reset}  place ONE real call`);
}
if (o.dryRun) {
  console.log(`\n${C.yellow}OUTBOUND_DRY_RUN is on. Set it to false when you want real calls.${C.reset}`);
}