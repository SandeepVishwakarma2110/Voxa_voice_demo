// src/controllers/outboundController.js
//
// The outbound-calling API.
//
// Every one of these endpoints can make a phone ring, so they are not in the
// same risk class as the rest of the server. They require OUTBOUND_API_KEY in
// an x-api-key header, and the server refuses to start the watcher — or serve
// these routes — if that key is not set. An unauthenticated endpoint that dials
// arbitrary numbers from your DID is an open relay for nuisance calls.

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import {
  scanOnce, dialOne, startWatching, stopWatching, dialerStatus,
} from '../services/outboundDialer.js';
import { listPending } from '../services/pendingOutbound.js';
import { readLeads, describeSheet, serviceAccountEmail } from '../tools/leadSheet.js';

/** Shared guard. Returns true when the request may proceed. */
function authorized(req, res) {
  const expected = config.outbound.apiKey;
  if (!expected) {
    res.status(503).json({
      success: false,
      error: 'OUTBOUND_API_KEY is not set, so the outbound endpoints are disabled. ' +
        'These routes can place calls from your DID — they are not safe to leave open.',
    });
    return false;
  }
  const given = req.get('x-api-key') ?? req.query.key;
  if (given !== expected) {
    logger.warn(`[outbound] rejected ${req.method} ${req.path} from ${req.ip} — bad key`);
    res.status(401).json({ success: false, error: 'invalid or missing x-api-key' });
    return false;
  }
  return true;
}

/** GET /outbound/status — watcher state, last scan, calls awaiting connect. */
export function getStatus(req, res) {
  if (!authorized(req, res)) return;
  res.json({ success: true, ...dialerStatus(), awaiting: listPending() });
}

/**
 * GET /outbound/leads — what the dialer can see, without calling anyone.
 * The first thing to check when a sheet is not being picked up.
 */
export async function getLeads(req, res) {
  if (!authorized(req, res)) return;
  try {
    const [sheet, info, email] = await Promise.all([
      readLeads(),
      describeSheet().catch(() => null),
      serviceAccountEmail().catch(() => null),
    ]);
    const want = String(config.sheet.statusNew).toLowerCase();
    res.json({
      success: true,
      spreadsheet: info,
      serviceAccount: email,
      tab: sheet.tab,
      headers: sheet.headers,
      columnsFound: sheet.index,
      total: sheet.rows.length,
      due: sheet.rows.filter((r) => r.status.toLowerCase() === want).length,
      rows: sheet.rows,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * POST /outbound/scan — run one pass now.
 * Body: { limit?: number, dryRun?: boolean }
 */
export async function postScan(req, res) {
  if (!authorized(req, res)) return;
  const limit = req.body?.limit ? Number(req.body.limit) : null;
  const dryRun = typeof req.body?.dryRun === 'boolean' ? req.body.dryRun : undefined;
  try {
    const result = await scanOnce({ limit, dryRun });
    res.json({ success: !result.error, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /outbound/call — dial one number, bypassing the sheet.
 * Body: { phone: "9876543210", name?: "Rahul", dryRun?: boolean }
 */
export async function postCall(req, res) {
  if (!authorized(req, res)) return;
  const phone = req.body?.phone ?? req.body?.customer_number;
  if (!phone) {
    return res.status(400).json({ success: false, error: 'phone is required' });
  }
  const dryRun = typeof req.body?.dryRun === 'boolean' ? req.body.dryRun : undefined;
  try {
    const result = await dialOne({ phone, name: req.body?.name ?? '', dryRun });
    res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/** POST /outbound/watch — body { on: true|false } */
export function postWatch(req, res) {
  if (!authorized(req, res)) return;
  const on = req.body?.on;
  if (typeof on !== 'boolean') {
    return res.status(400).json({ success: false, error: 'body must be { "on": true } or { "on": false }' });
  }
  const result = on ? startWatching() : stopWatching();
  res.json({ success: true, ...result, ...dialerStatus() });
}