// src/controllers/callController.js
import { config } from '../config/index.js';
import { sessionManager } from '../utils/sessionManager.js';
import { logger } from '../utils/logger.js';

/**
 * POST /calls/incoming
 *
 * Smartflo Dynamic endpoint. Unlike Twilio, this does NOT return TwiML — the
 * platform expects a JSON body naming the WebSocket to connect to, and will
 * drop the call on any other shape:
 *
 *   { "success": true, "wss_url": "wss://host/ws/media" }
 *
 * The caller's number is not passed through here; it arrives on the `start`
 * frame of the stream itself as `start.from`.
 */
export function handleIncomingCall(req, res) {
  try {
    const from = req.body?.from ?? req.body?.fromNumber ?? 'unknown';
    logger.info(`[callController] Smartflo incoming call from ${from}`);

    const wssUrl = config.baseUrl
      .replace('https://', 'wss://')
      .replace('http://', 'ws://') + '/ws/media';

    res.status(200).json({ success: true, wss_url: wssUrl });
  } catch (err) {
    logger.error(`[callController] incoming failed: ${err.message}`, { stack: err.stack });
    // Still JSON — an HTML error page would be unparseable to Smartflo.
    res.status(500).json({ success: false });
  }
}

/**
 * POST /calls/status
 * Smartflo status / CDR callback. Field names are lower-camel, not Twilio's
 * PascalCase, so both are accepted to survive a payload change.
 */
export function handleStatusCallback(req, res) {
  const body = req.body ?? {};
  const callSid = body.callSid ?? body.CallSid ?? body.call_id;
  const callStatus = String(body.callStatus ?? body.CallStatus ?? '').toLowerCase();
  const duration = body.duration ?? body.CallDuration;

  logger.info(`[callController] Smartflo status: ${callSid} -> ${callStatus} (${duration}s)`);

  if (['completed', 'failed', 'no-answer', 'busy', 'canceled'].includes(callStatus)) {
    const session = sessionManager.get(callSid);
    if (session) {
      // flush() is idempotent, so overlapping with the stream teardown is safe.
      session.flush()
        .then(() => {
          session.destroy();
          sessionManager.delete(callSid);
        })
        .catch((err) => logger.error(`[callController] status flush: ${err.message}`));
    }
  }

  res.sendStatus(200);
}

/**
 * GET /calls/sessions — debug only; disable or protect in production.
 */
export function getActiveSessions(req, res) {
  const sessions = [];
  for (const [callSid, session] of sessionManager.all()) {
    sessions.push({
      callSid,
      accountSid:  session.accountSid ?? null,
      phoneNumber: session.phoneNumber,
      startedAt:   new Date(session.startedAt).toISOString(),
      turns:       session.turns.length,
    });
  }
  res.json({ count: sessions.length, sessions });
}