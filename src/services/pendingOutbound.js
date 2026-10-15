// src/services/pendingOutbound.js
//
// Links "the call we just placed" to "the stream that just opened".
//
// Smartflo's Click to Call response carries `ref_id` and nothing else — no call
// id. The `start` frame on the websocket carries callSid, streamSid, from and
// to. Those two sets have NOTHING in common, so there is no identifier to join
// on. The only thing both sides know is the phone number.
//
// So: the dialer records what it dialled, keyed by the normalised number, and
// the stream handler claims that entry when the call lands. Without this the
// agent cannot tell an outbound call from an inbound one, and would open an
// outbound call with "Thank you for calling Xverse" — to someone who did not
// call.
//
// Entries expire. A call that rings out never produces a stream, and a stale
// entry would make the NEXT inbound call from that person look outbound.

import { logger } from '../utils/logger.js';
import { phoneKey } from '../utils/phone.js';

const TTL_MS = Number(process.env.OUTBOUND_PENDING_TTL_MS ?? 120_000);

/** key -> { name, rowNumber, refId, dialedAt, attempts } */
const pending = new Map();

function sweep() {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now - entry.dialedAt > TTL_MS) {
      pending.delete(key);
      logger.debug(`[outbound] pending entry for ${key} expired unanswered`);
    }
  }
}

/**
 * @param {object} entry
 * @param {string} entry.phone  Any format; normalised here.
 * @returns {string|null} the key it was stored under, or null if unparseable
 */
export function registerPending({ phone, name = '', rowNumber = null, refId = null, attempts = 0 }) {
  sweep();
  const key = phoneKey(phone);
  if (!key) {
    logger.warn(`[outbound] cannot track "${phone}" — not a usable number`);
    return null;
  }
  pending.set(key, { name, rowNumber, refId, attempts, dialedAt: Date.now() });
  logger.debug(`[outbound] tracking ${key}${name ? ` (${name})` : ''} row=${rowNumber} ref=${refId}`);
  return key;
}

/**
 * Take the entry for this number, if there is a live one.
 *
 * Claiming REMOVES it, so a second stream from the same number in the same
 * window is treated as inbound. That is the safe direction to be wrong in: a
 * person who calls back after we rang them is an inbound caller.
 *
 * @param {...string} candidates Numbers from the start frame — `from` and `to`
 *        both, because which leg carries the customer depends on how the
 *        destination is configured, and reading only one would miss half the
 *        calls.
 * @returns {{name: string, rowNumber: number|null, refId: string|null, attempts: number, dialedAt: number, matchedOn: string}|null}
 */
export function claimPending(...candidates) {
  sweep();
  for (const raw of candidates) {
    const key = phoneKey(raw);
    if (!key) continue;
    const entry = pending.get(key);
    if (!entry) continue;
    pending.delete(key);
    logger.info(
      `[outbound] stream matched the call we placed to ${key}` +
      `${entry.name ? ` (${entry.name})` : ''} — treating as OUTBOUND`,
    );
    return { ...entry, matchedOn: key };
  }
  return null;
}

/** Look without claiming — for the status endpoint. */
export function peekPending(phone) {
  sweep();
  const key = phoneKey(phone);
  return key ? (pending.get(key) ?? null) : null;
}

/** Drop an entry whose call we know never happened (the API refused it). */
export function dropPending(phone) {
  const key = phoneKey(phone);
  if (key) pending.delete(key);
}

export function pendingCount() {
  sweep();
  return pending.size;
}

export function listPending() {
  sweep();
  return [...pending.entries()].map(([key, e]) => ({
    phone: key,
    name: e.name,
    rowNumber: e.rowNumber,
    refId: e.refId,
    waitingMs: Date.now() - e.dialedAt,
  }));
}

/** Tests only. */
export function _clearPending() {
  pending.clear();
}