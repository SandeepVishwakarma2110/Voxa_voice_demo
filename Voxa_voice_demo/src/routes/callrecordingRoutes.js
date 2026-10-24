// src/routes/callRecordingRoutes.js
//
// Serves a call's stereo WAV (caller left, agent right) straight out of the
// Log document.
//
//   GET  /calls/recordings/:callSid        full file, or a byte range
//   HEAD /calls/recordings/:callSid        headers only (Express derives it)
//
// Call recordings are customer PII. Set RECORDINGS_API_KEY and every request
// must present it, either as an `x-api-key` header or a `?key=` query param
// (the query form exists because an <audio src> tag cannot send headers).

import express from 'express';
import { timingSafeEqual } from 'crypto';
import { Log } from '../models/Log.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const API_KEY = (process.env.RECORDINGS_API_KEY || '').trim();

if (!API_KEY) {
  logger.warn(
    '[recordings] RECORDINGS_API_KEY is not set — call recordings are served ' +
    'to anyone who can reach this endpoint. Set it before exposing the server.'
  );
}

/** Constant-time compare, so the key cannot be recovered by timing responses. */
function keyMatches(given) {
  if (!API_KEY) return true;
  if (typeof given !== 'string' || !given) return false;
  const trimmedGiven = given.trim();
  const a = Buffer.from(trimmedGiven);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireKey(req, res, next) {
  if (keyMatches(req.get('x-api-key') ?? req.query.key)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Smartflo and Twilio ids are alphanumeric with a few separators. Rejecting
// anything else keeps odd input out of the query and out of the filename.
const CALL_SID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Mongoose returns a Buffer for a Buffer path, but `.lean()` or a raw driver
 * query hands back a BSON Binary instead. Sending a Binary with res.send()
 * serialises it as JSON, so normalise either shape to a real Buffer.
 */
function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (data.buffer && Buffer.isBuffer(data.buffer)) return data.buffer;
  if (typeof data.value === 'function') return Buffer.from(data.value(true));
  return null;
}

router.get('/recordings/:callSid', requireKey, async (req, res) => {
  const { callSid } = req.params;
  if (!CALL_SID.test(callSid)) {
    return res.status(400).json({ error: 'Invalid callSid' });
  }

  try {
    // audioData is select:false on the schema so that ordinary Log queries do
    // not drag megabytes of audio back. It has to be requested explicitly —
    // without this line the field is simply absent and every request 404s.
    // const log = await Log.findOne({ callSid })
    //   .select('+recording.audioData recording callSid');

    const log = await Log.findOne({ callSid }).select('+recording.audioData');

    if (!log) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Say WHY there is no audio. "Not found" for a call that exists but ran
    // past the length cap sends people looking for a bug that is not there.
    if (log.recording?.skippedReason) {
      return res.status(404).json({
        error: 'Recording not stored',
        reason: log.recording.skippedReason,
        durationMs: log.recording.durationMs,
      });
    }

    const audio = toBuffer(log.recording?.audioData);
    if (!audio?.length) {
      return res.status(404).json({ error: 'No recording for this call' });
    }

    const total = audio.length;
    const contentType = log.recording.contentType || 'audio/wav';

    // Content-Length comes from the bytes actually being sent. The stored
    // `bytes` field is metadata; if it ever disagrees with the buffer, a
    // too-large value makes the client wait forever for bytes that never come.
    res.set({
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename="call-${callSid}.wav"`,
      'Cache-Control': 'private, max-age=0, no-store',
    });

    // Range requests. Browsers ask for byte ranges to seek inside an <audio>
    // element, and Safari will not play audio at all from a server that does
    // not answer them — it treats a plain 200 as unseekable.
    const range = req.get('range');
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.set('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }

      let start, end;
      if (m[1] === '') {
        // "bytes=-500" means the LAST 500 bytes.
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
      }

      if (start >= total || start > end) {
        res.set('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }

      res.status(206).set({
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      return res.end(audio.subarray(start, end + 1));
    }

    res.set('Content-Length', total);
    return res.end(audio);
  } catch (err) {
    logger.error(`[recordings] ${callSid}: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;