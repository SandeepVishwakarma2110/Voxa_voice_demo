import cron from 'node-cron';
import { sessionManager } from './sessionManager.js';
import { config } from '../config/index.js';
import { logger } from './logger.js';

const TIMEOUT_MS = config.session.timeoutMinutes * 60 * 1000;

/**
 * Every 60 seconds, scan all active sessions.
 * If a session has been silent for SESSION_TIMEOUT_MINUTES, flush it to DB and remove from RAM.
 */
export function startCleanupCron() {
  cron.schedule('* * * * *', async () => {
    const now = Date.now();
    for (const [callSid, session] of sessionManager.all()) {
      const idle = now - (session.lastActivityAt || session.startedAt);
      if (idle >= TIMEOUT_MS) {
        logger.info(`[cleanup] Session ${callSid} idle ${Math.round(idle / 1000)}s — flushing`);
        try {
          await session.flush();
          session.destroy();
          sessionManager.delete(callSid);
        } catch (err) {
          logger.error(`[cleanup] Error flushing session ${callSid}: ${err.message}`);
        }
      }
    }
  });
  logger.info(`[cleanup] Cron started — timeout: ${config.session.timeoutMinutes} min`);
}
