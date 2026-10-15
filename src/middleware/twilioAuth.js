import twilio from 'twilio';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Validate that incoming requests are genuinely from Twilio.
 * Uses the X-Twilio-Signature HMAC header.
 *
 * Skip in development if SKIP_TWILIO_AUTH=true.
 */
export function twilioAuth(req, res, next) {
  if (process.env.SKIP_TWILIO_AUTH === 'true') {
    return next();
  }

  const twilioSignature = req.headers['x-twilio-signature'];
  const url = `${config.baseUrl}${req.originalUrl}`;

  const valid = twilio.validateRequest(
    config.twilio.authToken,
    twilioSignature,
    url,
    req.body,
  );

  if (!valid) {
    logger.warn(`[twilioAuth] Invalid signature from ${req.ip} — url=${url}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}
