/**
 * sessionManager.js
 * Global in-memory map: callSid → CallSession instance.
 * Kept separate so any module can look up a session without circular imports.
 */

/** @type {Map<string, import('../services/callSession.js').CallSession>} */
const sessions = new Map();

export const sessionManager = {
  set(callSid, session) { sessions.set(callSid, session); },
  get(callSid)          { return sessions.get(callSid); },
  delete(callSid)       { sessions.delete(callSid); },
  all()                 { return sessions; },
  size()                { return sessions.size; },
};
