import { config } from '../config/index.js';
import { sessionManager } from '../utils/sessionManager.js';
import { logger } from '../utils/logger.js';
import { Log } from '../models/Log.js';

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
 * GET /calls/sessions — live active in-memory sessions for the Wallboard.
 */
export function getActiveSessions(req, res) {
  const sessions = [];
  for (const [callSid, session] of sessionManager.all()) {
    const lastTurnObj = session.turns?.[session.turns.length - 1];
    sessions.push({
      callSid,
      accountSid:  session.accountSid ?? null,
      phoneNumber: session.phoneNumber,
      direction:   session.outbound ? 'OUTBOUND' : 'INBOUND',
      agentName:   session.agentName || (session.outbound ? 'Rahul' : 'Priya'),
      startedAt:   new Date(session.startedAt).toISOString(),
      durationSec: Math.floor((Date.now() - session.startedAt) / 1000),
      turnsCount:  session.turns?.length || 0,
      lastTurn:    lastTurnObj ? `${lastTurnObj.role === 'user' ? 'Caller' : 'Agent'}: "${lastTurnObj.text}"` : 'Stream connected, listening...',
    });
  }
  res.json({ success: true, count: sessions.length, sessions });
}

/**
 * GET /calls/logs — historical calls saved in MongoDB.
 */
export async function getCallLogs(req, res) {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const page = Math.max(1, Number(req.query.page) || 1);
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.search) {
      const s = String(req.query.search).trim();
      query.$or = [
        { phoneNumber: { $regex: s, $options: 'i' } },
        { callSid: { $regex: s, $options: 'i' } },
        { transcript: { $regex: s, $options: 'i' } },
      ];
    }

    const [total, logs] = await Promise.all([
      Log.countDocuments(query),
      Log.find(query)
        .select('-recording.audioData')
        .sort({ startedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const formatted = logs.map(doc => {
      const durationSec = doc.durationMs ? Math.round(doc.durationMs / 1000) : 0;
      const mins = Math.floor(durationSec / 60);
      const secs = (durationSec % 60).toString().padStart(2, '0');

      return {
        id: doc._id,
        callSid: doc.callSid,
        phoneNumber: doc.phoneNumber,
        direction: doc.direction ? doc.direction.toUpperCase() : 'INBOUND',
        startedAt: doc.startedAt,
        endedAt: doc.endedAt,
        durationSec,
        durationFormatted: `${mins}m ${secs}s`,
        turnsCount: doc.turns?.length || 0,
        turns: doc.turns || [],
        transcript: doc.transcript || '',
        summary: doc.summary,
        hasRecording: Boolean(doc.recording?.bytes || doc.recording?.durationMs),
        recordingDurationMs: doc.recording?.durationMs || null,
        recordingBytes: doc.recording?.bytes || null,
        recordingUrl: doc.recording?.bytes ? `/calls/recordings/${doc.callSid}` : null,
      };
    });

    res.json({
      success: true,
      total,
      page,
      limit,
      count: formatted.length,
      logs: formatted,
    });
  } catch (err) {
    logger.error(`[callController] getCallLogs error: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /calls/logs/:callSid — single call log detail.
 */
export async function getCallLogBySid(req, res) {
  try {
    const { callSid } = req.params;
    const log = await Log.findOne({ callSid }).select('-recording.audioData').lean();
    if (!log) return res.status(404).json({ success: false, error: 'Call not found' });
    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}