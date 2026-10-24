// src/services/smartfloOutbound.js
//
// Places a single outbound call through Smartflo's Click to Call Support API.
//
//   POST https://api-smartflo.tatateleservices.com/v1/click_to_call_support
//   Authorization: Bearer <SMARTFLO_API_TOKEN>
//   { customer_number, api_key, caller_id, async: 1, ... }
//
// TWO different credentials, which is the easiest thing to get wrong here:
//
//   SMARTFLO_API_TOKEN   the account API token, in the Authorization header.
//   SMARTFLO_CTC_API_KEY the Click to Call Support API key, in the BODY as
//                        `api_key`. This is the one that carries the
//                        destination — it is what points the call at the Voice
//                        Streaming endpoint, which is how the audio reaches
//                        our /ws/media. Smartflo's own docs say plainly: "The
//                        Click to Call Support API Key is different from the
//                        Smartflo API Token."
//
// Get the second one from the portal: API Connect → Click to Call Support API →
// Generate New API Key, set Destination Type to Voice Streaming, and select the
// voice bot / streaming endpoint. Without that destination the call connects to
// nothing and the caller hears silence.

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { normalizePhone, toDialFormat } from '../utils/phone.js';

const ENDPOINT = 'https://api-smartflo.tatateleservices.com/v1/click_to_call_support';

/**
 * Smartflo returns `ref_id`, NOT `call_id`.
 *
 * This matters more than it looks. There is no call identifier to correlate the
 * API response with the `start` frame that arrives on the websocket moments
 * later, so the only handle linking "the call we placed" to "the stream that
 * opened" is the phone number. That is why pendingOutbound keys by number.
 *
 * `ref_id` is still worth keeping: it is what Smartflo support and the CDR
 * records are searched by when a call goes missing.
 */
function parseSuccess(body) {
  return {
    refId: body?.ref_id ?? body?.refId ?? null,
    message: body?.message ?? 'queued',
  };
}

/**
 * Smartflo has two different error shapes.
 *
 *   { "success": false, "message": "Invalid details provided." }
 *   { "customer_number": ["The customer number must be between 10 and 12 digits."] }
 *
 * The second has no `success` and no `message` — only field keys — so reading
 * `body.message` alone reports "undefined" for the errors that are actually
 * actionable.
 */
function parseError(status, body) {
  if (body && typeof body === 'object') {
    if (typeof body.message === 'string' && body.message) return body.message;

    const fieldErrors = Object.entries(body)
      .filter(([k, v]) => k !== 'success' && (Array.isArray(v) || typeof v === 'string'))
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`);
    if (fieldErrors.length) return fieldErrors.join(' | ');
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 200);
  return `HTTP ${status}`;
}

/**
 * Place one call.
 *
 * @param {object}  opts
 * @param {string}  opts.customerNumber  The person to call, in any format.
 * @param {object}  [opts.customIdentifier] Up to 10 keys, alphanumeric values,
 *        512 characters of JSON in total, no "$". Smartflo echoes these back on
 *        the CDR, which is how a call is traced to its spreadsheet row.
 * @param {boolean} [opts.dryRun] Overrides config. Validates and logs, places
 *        no call, returns a synthetic ref id.
 * @returns {Promise<{ok: boolean, refId: string|null, message: string, status: number|null, dryRun: boolean}>}
 */
export async function placeOutboundCall({ customerNumber, customIdentifier, dryRun } = {}) {
  const o = config.outbound;
  const isDry = dryRun ?? o.dryRun;

  // ── Validate before spending anything ────────────────────────────────────
  const phone = normalizePhone(customerNumber);
  if (!phone.valid) {
    return { ok: false, refId: null, message: `bad number — ${phone.reason}`, status: null, dryRun: isDry };
  }
  if (!o.ctcApiKey) {
    return {
      ok: false, refId: null, status: null, dryRun: isDry,
      message: 'SMARTFLO_CTC_API_KEY is not set — this is the Click to Call Support API key from ' +
        'API Connect, not the account API token, and it is what routes the call to the voice stream',
    };
  }
  // The Authorization header was optional until 30 September 2026 and is
  // mandatory now, so a missing token is a hard failure rather than a warning.
  if (!o.apiToken) {
    return {
      ok: false, refId: null, status: null, dryRun: isDry,
      message: 'SMARTFLO_API_TOKEN is not set — the Authorization header became mandatory on 2026-09-30',
    };
  }

  const dialNumber = toDialFormat(customerNumber, o.numberFormat);

  const payload = {
    customer_number: dialNumber,
    api_key: o.ctcApiKey,
    // Documented as required and "must be 1" — synchronous mode is not
    // supported, so this is not configurable.
    async: 1,
    // Documented range 10-30, default 30. Out-of-range values are rejected by
    // the API, so clamp rather than letting a typo in .env fail every call.
    customer_ring_timeout: Math.min(30, Math.max(10, o.ringTimeoutSec)),
  };
  if (o.callerId) payload.caller_id = o.callerId;
  if (o.callTimeoutSec) payload.call_timeout = o.callTimeoutSec;
  if (customIdentifier && Object.keys(customIdentifier).length) {
    payload.custom_identifier = sanitizeIdentifier(customIdentifier);
  }

  if (isDry) {
    logger.info(
      `[outbound] DRY RUN — would call ${dialNumber}` +
      `${o.callerId ? ` from ${o.callerId}` : ''}` +
      `${payload.custom_identifier ? ` id=${JSON.stringify(payload.custom_identifier)}` : ''}`,
    );
    return { ok: true, refId: `dry-${Date.now()}`, message: 'dry run — no call placed', status: null, dryRun: true };
  }

  // ── Call it ──────────────────────────────────────────────────────────────
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.requestTimeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${o.apiToken}`,
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });

    const raw = await res.text();
    let body;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }

    if (!res.ok || body?.success === false) {
      const message = parseError(res.status, body);
      logger.error(`[outbound] ${dialNumber} refused — ${message}`);
      return { ok: false, refId: null, message, status: res.status, dryRun: false };
    }

    const { refId, message } = parseSuccess(body);
    // "Originate successfully queued" means accepted, NOT answered. The call
    // may still ring out, be rejected, or fail on the destination leg — the
    // status webhook and the CDR are what say whether it connected.
    logger.info(`[outbound] queued ${dialNumber} ref_id=${refId ?? 'none'} — ${message}`);
    return { ok: true, refId, message, status: res.status, dryRun: false };

  } catch (err) {
    const message = err.name === 'AbortError'
      ? `timed out after ${o.requestTimeoutMs}ms`
      : err.message;
    logger.error(`[outbound] ${dialNumber} failed — ${message}`);
    return { ok: false, refId: null, message, status: null, dryRun: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * custom_identifier has documented limits: at most 10 keys, alphanumeric
 * values, no "$", and 512 characters of JSON in total. Exceeding any of them
 * fails the whole request, so a long lead name must not be able to stop a call
 * going out.
 */
function sanitizeIdentifier(obj) {
  const out = {};
  let count = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (count >= 10) break;
    if (v === null || v === undefined || v === '') continue;
    const key = String(k).replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
    const val = String(v).replace(/[^A-Za-z0-9 ]/g, '').trim().slice(0, 48);
    if (!key || !val) continue;
    out[key] = val;
    count++;
  }
  // Trim whole keys until the serialized form fits, rather than sending
  // something the API will reject outright.
  while (JSON.stringify(out).length > 512) {
    const last = Object.keys(out).pop();
    if (!last) break;
    delete out[last];
  }
  return out;
}

export const OUTBOUND_ENDPOINT = ENDPOINT;