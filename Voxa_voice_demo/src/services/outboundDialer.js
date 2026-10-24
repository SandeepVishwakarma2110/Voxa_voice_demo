// src/services/outboundDialer.js
//
// Watches the lead sheet and calls every row whose Status is "New".
//
//   New  ->  Calling  ->  Called      (the API accepted the call)
//                     ->  Failed      (it did not, and the reason is in Notes)
//                     ->  Invalid     (the number is not dialable at all)
//
// The ordering of those writes is the whole design.
//
// The obvious implementation — read the row, place the call, write "Called" —
// is wrong, and wrong in the expensive direction. If the write fails after the
// call is placed (a 403 because the sheet was shared read-only, a network blip,
// a restart, a quota error) the row is still "New", so the next poll calls the
// same person again. And the one after that. The failure mode is ringing a
// lead every thirty seconds until someone notices.
//
// So the row is CLAIMED first: status goes to "Calling" before the API is
// touched. A crash then leaves a row stuck in "Calling" — visible, countable,
// and fixable by a human editing one cell — instead of a dialling loop. Being
// stuck is a far better failure than being repeated.
//
// Single instance only. Sheets has no compare-and-set, so two servers polling
// the same tab can both claim the same row in the gap between read and write.
// If you ever run two, point them at different tabs or disable the watcher on
// one — OUTBOUND_WATCH=false.

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { readLeads, updateRow, claimRow } from '../tools/leadSheet.js';
import { placeOutboundCall } from './smartfloOutbound.js';
import { registerPending, dropPending, pendingCount } from './pendingOutbound.js';

const state = {
  running: false,
  timer: null,
  scanning: false,
  lastScanAt: null,
  lastScanError: null,
  lastScan: null,
  totals: { scanned: 0, called: 0, failed: 0, invalid: 0, skipped: 0 },
  // Rows this process is working on right now. Closes the read-to-write gap
  // that claimRow cannot, for a single instance.
  inFlight: new Set(),
};

function nowIst() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

/**
 * Outside calling hours? Cold-calling someone at 02:00 is the kind of mistake
 * that gets a DID blocked, and a watcher left running over a weekend will do it
 * without being asked. Off by default only because the window is a business
 * decision; set OUTBOUND_HOURS to enable, e.g. "09:30-19:00".
 */
function outsideCallingHours() {
  const window = config.outbound.hours;
  if (!window) return null;

  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) {
    logger.warn(`[dialer] OUTBOUND_HOURS="${window}" is not HH:MM-HH:MM — ignoring it`);
    return null;
  }
  const [, h1, m1, h2, m2] = m.map(Number);
  const ist = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const d = new Date(ist);
  const mins = d.getHours() * 60 + d.getMinutes();
  const from = h1 * 60 + m1;
  const to = h2 * 60 + m2;

  if (mins >= from && mins < to) return null;
  return `outside calling hours (${window} IST, now ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')})`;
}

/** One pass over the sheet. Safe to call directly; the watcher just repeats it. */
export async function scanOnce({ limit = null, dryRun = undefined } = {}) {
  if (state.scanning) {
    return { skipped: true, reason: 'a scan is already running' };
  }

  const blocked = outsideCallingHours();
  if (blocked) {
    logger.info(`[dialer] skipping scan — ${blocked}`);
    return { skipped: true, reason: blocked };
  }

  state.scanning = true;
  const result = {
    at: nowIst(), considered: 0, called: [], failed: [], invalid: [], skipped: [],
    dryRun: dryRun ?? config.outbound.dryRun,
  };

  try {
    const sheet = await readLeads();
    const ctx = { tab: sheet.tab, index: sheet.index };
    const want = String(config.sheet.statusNew).toLowerCase();

    // isBlank first: if SHEET_STATUS_NEW were ever set to an empty string, a
    // status match alone would select every trailing blank row in the sheet and
    // the dialer would try to call them.
    const due = sheet.rows.filter((r) => !r.isBlank && r.status.toLowerCase() === want);
    result.considered = due.length;
    state.totals.scanned += due.length;

    const cap = limit ?? config.outbound.maxPerScan;
    const batch = due.slice(0, cap);
    if (due.length > batch.length) {
      logger.info(`[dialer] ${due.length} rows are "${config.sheet.statusNew}", taking ${batch.length} this pass`);
    }

    // Sequential on purpose. These are phone calls: a burst of twenty at once
    // is a worse experience for everyone and harder to reason about than a
    // steady trickle. concurrency is here for when that is genuinely wanted.
    const slots = Math.max(1, config.outbound.concurrency);
    for (let i = 0; i < batch.length; i += slots) {
      const slice = batch.slice(i, i + slots);
      await Promise.all(slice.map((row) => dialRow(row, ctx, result, dryRun)));
      if (i + slots < batch.length && config.outbound.gapMs) {
        await new Promise((r) => setTimeout(r, config.outbound.gapMs));
      }
    }

    state.lastScanError = null;
  } catch (err) {
    state.lastScanError = err.message;
    logger.error(`[dialer] scan failed — ${err.message}`);
    result.error = err.message;
  } finally {
    state.scanning = false;
    state.lastScanAt = nowIst();
    state.lastScan = result;
  }

  return result;
}

async function dialRow(row, ctx, result, dryRun) {
  // A number nobody can dial is a data problem, not a call attempt. Marking it
  // rather than retrying it stops the same bad cell being reconsidered on every
  // single pass, forever.
  if (!row.phone) {
    logger.warn(`[dialer] row ${row.rowNumber} "${row.phoneRaw}" — ${row.phoneError}`);
    await safeUpdate(row.rowNumber, {
      status: config.sheet.statusInvalid,
      notes: row.phoneError,
    }, ctx);
    result.invalid.push({ row: row.rowNumber, phone: row.phoneRaw, reason: row.phoneError });
    state.totals.invalid++;
    return;
  }

  if (state.inFlight.has(row.rowNumber)) {
    result.skipped.push({ row: row.rowNumber, reason: 'already in flight' });
    return;
  }

  if (row.attempts >= config.outbound.maxAttempts) {
    await safeUpdate(row.rowNumber, {
      status: config.sheet.statusFailed,
      notes: `gave up after ${row.attempts} attempts`,
    }, ctx);
    result.skipped.push({ row: row.rowNumber, reason: `attempts exhausted (${row.attempts})` });
    state.totals.skipped++;
    return;
  }

  state.inFlight.add(row.rowNumber);
  try {
    // ── Claim BEFORE dialling. See the note at the top of this file. ───────
    const claim = await claimRow(row.rowNumber, config.sheet.statusNew, config.sheet.statusCalling, ctx);
    if (!claim.claimed) {
      logger.info(`[dialer] row ${row.rowNumber} changed to "${claim.actual}" before we claimed it — leaving it`);
      result.skipped.push({ row: row.rowNumber, reason: `status is now "${claim.actual}"` });
      state.totals.skipped++;
      return;
    }

    const attempts = row.attempts + 1;

    // Registered BEFORE the call, because on a fast connect the websocket
    // `start` frame can arrive before the HTTP response does. Registering
    // afterwards would lose the race, and the call would open with the inbound
    // greeting.
    registerPending({
      phone: row.phone,
      name: row.name,
      rowNumber: row.rowNumber,
      attempts,
    });

    const res = await placeOutboundCall({
      customerNumber: row.phone,
      customIdentifier: {
        row: String(row.rowNumber),
        name: row.name,
      },
      dryRun,
    });

    if (res.ok) {
      await safeUpdate(row.rowNumber, {
        status: config.sheet.statusCalled,
        calledAt: nowIst(),
        refId: res.refId ?? '',
        attempts,
        notes: res.dryRun ? 'dry run — no call placed' : '',
      }, ctx);
      result.called.push({ row: row.rowNumber, phone: row.phone, name: row.name, refId: res.refId });
      state.totals.called++;
      logger.info(`[dialer] row ${row.rowNumber} ${row.name || row.phone} -> ${config.sheet.statusCalled}`);
    } else {
      // The call never happened, so the pending entry must go — otherwise the
      // next genuine INBOUND call from this person would look like ours.
      dropPending(row.phone);

      // Back to New when there are attempts left, so a transient failure
      // retries on a later pass; Failed when there are not, so it stops.
      const exhausted = attempts >= config.outbound.maxAttempts;
      await safeUpdate(row.rowNumber, {
        status: exhausted ? config.sheet.statusFailed : config.sheet.statusNew,
        attempts,
        notes: res.message.slice(0, 250),
      }, ctx);
      result.failed.push({ row: row.rowNumber, phone: row.phone, reason: res.message, willRetry: !exhausted });
      state.totals.failed++;
    }
  } catch (err) {
    // The claim itself failed, or a write did. The row may be stuck in
    // "Calling" — which is the intended failure: visible and not self-repeating.
    dropPending(row.phone);
    logger.error(`[dialer] row ${row.rowNumber} — ${err.message}`);
    result.failed.push({ row: row.rowNumber, phone: row.phone, reason: err.message, willRetry: false });
    state.totals.failed++;
  } finally {
    state.inFlight.delete(row.rowNumber);
  }
}

/**
 * A failed status write must not throw out of the dial path. The call has
 * already been placed by this point, and letting the error propagate would skip
 * the rest of the batch for a bookkeeping problem.
 */
async function safeUpdate(rowNumber, patch, ctx) {
  try {
    await updateRow(rowNumber, patch, ctx);
  } catch (err) {
    logger.error(
      `[dialer] row ${rowNumber} was dialled but its status could not be written — ${err.message}. ` +
      'It is left in "Calling" and will NOT be retried automatically.',
    );
  }
}

/** Dial one number directly, outside the sheet. For testing and for the API. */
export async function dialOne({ phone, name = '', dryRun = undefined } = {}) {
  const key = registerPending({ phone, name, rowNumber: null });
  if (!key) return { ok: false, message: `"${phone}" is not a dialable number` };

  const res = await placeOutboundCall({
    customerNumber: phone,
    customIdentifier: name ? { name } : undefined,
    dryRun,
  });
  if (!res.ok) dropPending(phone);
  return res;
}

export function startWatching() {
  if (state.running) return { running: true, alreadyRunning: true };

  const every = Math.max(5_000, config.outbound.pollMs);
  state.running = true;
  logger.info(
    `[dialer] watching "${config.sheet.tab}" every ${Math.round(every / 1000)}s` +
    `${config.outbound.dryRun ? ' (DRY RUN — no calls will be placed)' : ''}`,
  );

  const tick = () => {
    scanOnce().catch((err) => logger.error(`[dialer] tick — ${err.message}`));
  };

  // unref() so a running watcher never holds the process open during shutdown.
  state.timer = setInterval(tick, every);
  state.timer.unref?.();
  tick();

  return { running: true, everyMs: every };
}

export function stopWatching() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
  logger.info('[dialer] stopped watching');
  return { running: false };
}

export function dialerStatus() {
  return {
    running: state.running,
    scanning: state.scanning,
    dryRun: config.outbound.dryRun,
    pollMs: config.outbound.pollMs,
    callingHours: config.outbound.hours || 'any',
    sheet: { id: config.sheet.id ? `${config.sheet.id.slice(0, 8)}…` : null, tab: config.sheet.tab },
    statuses: config.sheet,
    lastScanAt: state.lastScanAt,
    lastScanError: state.lastScanError,
    lastScan: state.lastScan,
    totals: state.totals,
    awaitingConnect: pendingCount(),
    inFlightRows: [...state.inFlight],
  };
}

/** Tests only. */
export function _resetDialer() {
  stopWatching();
  state.totals = { scanned: 0, called: 0, failed: 0, invalid: 0, skipped: 0 };
  state.lastScan = null;
  state.lastScanAt = null;
  state.lastScanError = null;
  state.inFlight.clear();
}