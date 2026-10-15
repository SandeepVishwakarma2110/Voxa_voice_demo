// src/tools/leadSheet.js
//
// The call list, read from a Google Sheet.
//
//   | Name  | Phone      | Status |
//   | Rahul | 9876543210 | New    |
//   | Amit  | 9876543211 | Called |
//
// Same service account as the calendar, so setup is the same two steps: add
// SHEET_ID to .env, and SHARE THE SHEET with the service account's email as an
// Editor. Editor, not Viewer — the dialer writes the status back, and a Viewer
// share fails at the first write with a 403 after the call has already gone
// out. The preflight checks for write access specifically.
//
// Columns are found BY HEADER NAME, not by position, so inserting a column does
// not silently start dialling the Status column. Names are matched
// case-insensitively with a few aliases.

import { google } from 'googleapis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { normalizePhone } from '../utils/phone.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

const auth = new google.auth.GoogleAuth({
  keyFile: config.google.keyFile,
  scopes: SCOPES,
});
const sheets = google.sheets({ version: 'v4', auth });

// Header → the aliases a human might have typed.
const COLUMNS = {
  phone:    ['phone', 'phone number', 'mobile', 'mobile number', 'number', 'contact', 'contact number'],
  status:   ['status', 'call status', 'state'],
  name:     ['name', 'lead name', 'full name', 'customer name', 'contact name'],
  // Optional. Written only if the header exists, so an existing sheet keeps
  // working untouched.
  calledAt: ['called at', 'calledat', 'call time', 'called on', 'timestamp'],
  refId:    ['ref id', 'refid', 'ref_id', 'reference', 'call ref'],
  attempts: ['attempts', 'attempt', 'tries', 'retry', 'retries'],
  notes:    ['notes', 'note', 'remark', 'remarks', 'error'],
};

/** 0 -> A, 25 -> Z, 26 -> AA. Sheets runs past Z more often than people expect. */
export function columnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function a1(tab, letter, row) {
  // A tab name with a space or a quote has to be quoted, or the range silently
  // refers to something else.
  const safeTab = `'${String(tab).replace(/'/g, "''")}'`;
  return `${safeTab}!${letter}${row}`;
}

function sheetFailure(err, action) {
  const status = err.code ?? err.response?.status;
  const detail = err.response?.data?.error?.message ?? err.message;

  if (status === 403) {
    return new Error(
      `${action}: access denied. Share the sheet with the service account as an EDITOR ` +
      `(the client_email in ${config.google.keyFile}). Detail: ${detail}`,
    );
  }
  if (status === 404) {
    return new Error(`${action}: sheet not found. Check SHEET_ID. Detail: ${detail}`);
  }
  if (status === 400 && /Unable to parse range/i.test(detail)) {
    return new Error(`${action}: tab "${config.sheet.tab}" does not exist in this spreadsheet. Detail: ${detail}`);
  }
  return new Error(`${action}: ${detail}`);
}

/**
 * Read the header row and work out which column is which.
 * @returns {Promise<{tab: string, headers: string[], index: Record<string, number|null>}>}
 */
export async function readHeaders() {
  const tab = config.sheet.tab;
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheet.id,
      range: `${`'${tab.replace(/'/g, "''")}'`}!1:1`,
    });
  } catch (err) {
    throw sheetFailure(err, 'reading the header row');
  }

  const headers = (res.data.values?.[0] ?? []).map((h) => String(h ?? '').trim());
  const lower = headers.map((h) => h.toLowerCase());

  const index = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    index[field] = null;
    for (const alias of aliases) {
      const at = lower.indexOf(alias);
      if (at !== -1) { index[field] = at; break; }
    }
  }

  return { tab, headers, index };
}

/**
 * Every data row, with the fields the dialer needs.
 *
 * `rowNumber` is the 1-based SHEET row, header included — so the first data row
 * is 2. It is what every write goes back to, and getting it wrong would update
 * the wrong person's status, so it is carried explicitly rather than recomputed.
 */
export async function readLeads() {
  const { tab, headers, index } = await readHeaders();

  const missing = ['phone', 'status'].filter((f) => index[f] === null);
  if (missing.length) {
    throw new Error(
      `the sheet needs ${missing.map((m) => `a "${m}"`).join(' and ')} column. ` +
      `Found: ${headers.length ? headers.join(', ') : '(no header row)'}`,
    );
  }

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheet.id,
      range: `${`'${tab.replace(/'/g, "''")}'`}!A2:ZZ`,
      // Phone numbers must come back as they are displayed, not as the floats
      // Sheets keeps underneath. UNFORMATTED_VALUE turns 9876543210 into
      // 9876543210 the number, which is fine, but a longer one into 9.87e9.
      valueRenderOption: 'FORMATTED_VALUE',
    });
  } catch (err) {
    throw sheetFailure(err, 'reading the lead rows');
  }

  const rows = (res.data.values ?? []).map((cells, i) => {
    const at = (field) => (index[field] === null ? '' : String(cells[index[field]] ?? '').trim());
    const phoneRaw = at('phone');
    const phone = normalizePhone(phoneRaw);
    const name = at('name');
    const status = at('status');
    return {
      rowNumber: i + 2,
      name,
      phoneRaw,
      phone: phone.valid ? phone.national : '',
      phoneKey: phone.key,
      phoneError: phone.valid ? null : phone.reason,
      status,
      attempts: Number(at('attempts') || 0) || 0,
      // Nothing in any of the three columns that matter. Sheets hands back a
      // trailing blank row or two more often than not, and they must never be
      // treated as leads — not reported as data errors, and not matched by an
      // empty SHEET_STATUS_NEW.
      isBlank: !phoneRaw && !name && !status,
    };
  });

  return { tab, headers, index, rows };
}

/**
 * Write one or more fields back to a row.
 *
 * Fields with no column in the sheet are skipped silently — the only required
 * one is status, and a sheet with just Name/Phone/Status stays supported.
 */
export async function updateRow(rowNumber, patch, ctx = null) {
  const { tab, index } = ctx ?? await readHeaders();

  const data = [];
  for (const [field, value] of Object.entries(patch)) {
    const col = index[field];
    if (col === null || col === undefined) continue;
    data.push({ range: a1(tab, columnLetter(col), rowNumber), values: [[value]] });
  }
  if (!data.length) return { updated: 0, skipped: Object.keys(patch) };

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.sheet.id,
      requestBody: { valueInputOption: 'RAW', data },
    });
  } catch (err) {
    throw sheetFailure(err, `updating row ${rowNumber}`);
  }
  return { updated: data.length, skipped: [] };
}

/**
 * Take ownership of a row before dialling it.
 *
 * Re-reads just the status cell and writes the new value only if it still holds
 * `expected`. Google Sheets has no compare-and-set, so this is not a true
 * atomic claim — but the window between the read and the write is a few
 * milliseconds, against a poll interval of seconds, and the dialer also holds
 * an in-process lock on the row.
 *
 * What this protects against is the thing that actually matters: the status
 * being written AFTER the call rather than before. If the call is placed first
 * and the write then fails — a 403, a network blip, a restart — the row stays
 * "New" and the next poll calls the same person again. And again. Claiming
 * first means a crash leaves the row stuck in "Calling", which a human can see
 * and reset, instead of a lead being dialled every thirty seconds.
 *
 * It is NOT safe against two server instances polling the same sheet. If you
 * ever run two, give each one its own tab or turn the watcher off on one.
 *
 * @returns {Promise<{claimed: boolean, actual: string}>}
 */
export async function claimRow(rowNumber, expected, next, ctx = null) {
  const c = ctx ?? await readHeaders();
  const col = c.index.status;
  if (col === null) throw new Error('no status column to claim');

  const cell = a1(c.tab, columnLetter(col), rowNumber);

  let current;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheet.id,
      range: cell,
    });
    current = String(res.data.values?.[0]?.[0] ?? '').trim();
  } catch (err) {
    throw sheetFailure(err, `re-reading row ${rowNumber} before claiming it`);
  }

  if (current.toLowerCase() !== String(expected).toLowerCase()) {
    return { claimed: false, actual: current };
  }

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheet.id,
      range: cell,
      valueInputOption: 'RAW',
      requestBody: { values: [[next]] },
    });
  } catch (err) {
    throw sheetFailure(err, `claiming row ${rowNumber}`);
  }

  return { claimed: true, actual: current };
}

/** The service account that has to be given Editor access. */
export async function serviceAccountEmail() {
  try {
    const client = await auth.getClient();
    return client.email ?? client.credentials?.client_email ?? null;
  } catch (err) {
    logger.warn(`[leadSheet] could not read the service account email: ${err.message}`);
    return null;
  }
}

/** Title and tab names, for the preflight to print so a wrong SHEET_ID is obvious. */
export async function describeSheet() {
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId: config.sheet.id,
      fields: 'properties.title,sheets.properties.title',
    });
    return {
      title: res.data.properties?.title ?? '(untitled)',
      tabs: (res.data.sheets ?? []).map((s) => s.properties?.title).filter(Boolean),
    };
  } catch (err) {
    throw sheetFailure(err, 'opening the spreadsheet');
  }
}