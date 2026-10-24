// //src/websocket/mediaStreamHandler.js
// import { CallSession } from '../services/callSession.js';
// import { sessionManager } from '../utils/sessionManager.js';
// import { logger } from '../utils/logger.js';

// /**
//  * Handles incoming WebSocket connections from Tata Smartflo bi-directional
//  * audio streaming.
//  *
//  * Event flow:
//  *  1. "connected"  — WS handshake OK
//  *  2. "start"      — callSid, streamSid, accountSid, from, to
//  *  3. "media"      — audio chunk (base64 μ-law @ 8 kHz)
//  *  4. "dtmf"       — keypad digit
//  *  5. "mark"       — playback of the preceding audio finished
//  *  6. "stop"       — call ended
//  *
//  * The wire format matches Twilio's, with two differences that matter here:
//  *
//  *  - The caller's number arrives as `start.from`. There is no TwiML step, so
//  *    there are no customParameters to carry it.
//  *  - On `clear`, Smartflo REPLIES with the marks for the audio it discarded,
//  *    where Twilio stays silent. Those late marks carry a stale turn token and
//  *    are rejected by CallSession.onMark.
//  *
//  * @param {import('ws').WebSocket} ws
//  */ 
// export function handleMediaStream(ws) {
//   let session = null;

//   ws.on('message', async (raw) => {
//     let msg;
//     try {
//       msg = JSON.parse(raw);
//     } catch {
//       return;
//     }

//     switch (msg.event) {
//       // ── connected ────────────────────────────────────────────────────────
//       case 'connected':
//         logger.info('[ws] Smartflo connected — waiting for start event');
//         break;

//       // ── start ─────────────────────────────────────────────────────────────
//       case 'start': {
//         const start = msg.start ?? {};
//         const callSid = start.callSid ?? msg.callSid;
//         // streamSid appears on the start body AND the envelope.
//         const streamSid = start.streamSid ?? msg.streamSid;
//         const accountSid = start.accountSid ?? msg.accountSid;

//         // The Smartflo doc contradicts itself on where the caller's number
//         // lives: the property table lists `from` / `to` WITHOUT the `start.`
//         // prefix, while the JSON example nests them inside `start`. Read both,
//         // because guessing one loses the caller's number entirely — and the
//         // profile lookup, memory and lead capture all key off it.
//         const phoneNumber =
//           start.from
//           ?? msg.from
//           ?? start.customParameters?.phoneNumber
//           ?? 'unknown';

//         const toNumber = start.to ?? msg.to ?? 'unknown';
//         const direction = start.direction ?? msg.direction ?? 'inbound';

//         logger.info(
//           `[ws] Smartflo stream started — callSid=${callSid} streamSid=${streamSid} ` +
//           `accountSid=${accountSid} caller=${phoneNumber} to=${toNumber} dir=${direction}`
//         );

//         if (phoneNumber === 'unknown') {
//           logger.warn(
//             '[ws] start frame carried no caller number — profile, memory and ' +
//             'lead capture will be degraded for this call'
//           );
//         }

//         if (!streamSid) {
//           // Every outbound media/mark/clear frame carries streamSid; without it
//           // nothing we send would reach the caller.
//           logger.error('[ws] start frame had no streamSid — cannot send audio back');
//         }

//         session = new CallSession({
//           callSid, streamSid, accountSid, phoneNumber, toNumber, direction, ws,
//         });
//         sessionManager.set(callSid, session);
//         break;
//       }

//       // ── media ─────────────────────────────────────────────────────────────
//       case 'media':
//         if (session) {
//           session.pushAudio(msg.media.payload);
//         }
//         break;

//       // ── mark ──────────────────────────────────────────────────────────────
//       // Smartflo sends this back once it has finished PLAYING all media queued
//       // before the mark. It is the only reliable end-of-speech signal: frames
//       // are written to the socket far faster than they are played.
//       case 'mark':
//         if (session) {
//           session.onMark(msg.mark?.name);
//         }
//         break;

//       // ── dtmf ──────────────────────────────────────────────────────────────
//       case 'dtmf':
//         logger.debug(`[ws] DTMF: ${msg.dtmf?.digit}`);
//         break;

//       // ── stop ──────────────────────────────────────────────────────────────
//       case 'stop': {
//         logger.info(`[ws] Stream stopped — callSid=${msg.stop?.callSid}`);

//         // Claim the session BEFORE awaiting. flush() writes to Mongo and takes
//         // a couple of seconds; the socket usually closes during that await, and
//         // the close handler would set `session` to null underneath us. Reading
//         // `session.callSid` afterwards then crashed the process.
//         const closing = session;
//         session = null;
//         if (closing) {
//           await closing.flush();
//           closing.destroy();
//           sessionManager.delete(closing.callSid);
//         }
//         break;
//       }

//       default:
//         logger.debug(`[ws] Unknown event: ${msg.event}`);
//     }
//   });

//   // ws.on('close', async () => {
//   //   logger.info('[ws] WebSocket closed');
//   //   if (session) {
//   //     await session.flush();
//   //     session.destroy();
//   //     sessionManager.delete(session.callSid);
//   //     session = null;
//   //   }
//   // });
//   ws.on('close', async () => {
//     // Same claim-before-await pattern as `stop`. Whichever fires first owns the
//     // teardown; the other sees null and does nothing. flush() is idempotent, so
//     // a double call is harmless either way.
//     const closing = session;
//     session = null;

//     try {
//       if (closing) {
//         await closing.flush();
//         closing.destroy();
//         sessionManager.delete(closing.callSid);
//       }
//       logger.info('[ws] WebSocket closed');
//     } catch (err) {
//       logger.error(`[ws close] ${err.message}`);
//     }
//   });

//   ws.on('error', (err) => {
//     logger.error(`[ws] WebSocket error: ${err.message}`);
//   });
// }





//src/websocket/mediaStreamHandler.js
import { CallSession } from '../services/callSession.js';
import { sessionManager } from '../utils/sessionManager.js';
import { claimPending } from '../services/pendingOutbound.js';
import { logger } from '../utils/logger.js';

/**
 * Handles incoming WebSocket connections from Tata Smartflo bi-directional
 * audio streaming.
 *
 * Event flow:
 *  1. "connected"  — WS handshake OK
 *  2. "start"      — callSid, streamSid, accountSid, from, to
 *  3. "media"      — audio chunk (base64 μ-law @ 8 kHz)
 *  4. "dtmf"       — keypad digit
 *  5. "mark"       — playback of the preceding audio finished
 *  6. "stop"       — call ended
 *
 * The wire format matches Twilio's, with two differences that matter here:
 *
 *  - The caller's number arrives as `start.from`. There is no TwiML step, so
 *    there are no customParameters to carry it.
 *  - On `clear`, Smartflo REPLIES with the marks for the audio it discarded,
 *    where Twilio stays silent. Those late marks carry a stale turn token and
 *    are rejected by CallSession.onMark.
 *
 * @param {import('ws').WebSocket} ws
 */ 
export function handleMediaStream(ws) {
  let session = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.event) {
      // ── connected ────────────────────────────────────────────────────────
      case 'connected':
        logger.info('[ws] Smartflo connected — waiting for start event');
        break;

      // ── start ─────────────────────────────────────────────────────────────
      case 'start': {
        const start = msg.start ?? {};
        const callSid = start.callSid ?? msg.callSid;
        // streamSid appears on the start body AND the envelope.
        const streamSid = start.streamSid ?? msg.streamSid;
        const accountSid = start.accountSid ?? msg.accountSid;

        // The Smartflo doc contradicts itself on where the caller's number
        // lives: the property table lists `from` / `to` WITHOUT the `start.`
        // prefix, while the JSON example nests them inside `start`. Read both,
        // because guessing one loses the caller's number entirely — and the
        // profile lookup, memory and lead capture all key off it.
        const phoneNumber =
          start.from
          ?? msg.from
          ?? start.customParameters?.phoneNumber
          ?? 'unknown';

        const toNumber = start.to ?? msg.to ?? 'unknown';
        const direction = start.direction ?? msg.direction ?? 'inbound';

        logger.info(
          `[ws] Smartflo stream started — callSid=${callSid} streamSid=${streamSid} ` +
          `accountSid=${accountSid} caller=${phoneNumber} to=${toNumber} dir=${direction}`
        );

        if (phoneNumber === 'unknown') {
          logger.warn(
            '[ws] start frame carried no caller number — profile, memory and ' +
            'lead capture will be degraded for this call'
          );
        }

        if (!streamSid) {
          // Every outbound media/mark/clear frame carries streamSid; without it
          // nothing we send would reach the caller.
          logger.error('[ws] start frame had no streamSid — cannot send audio back');
        }

        // Is this a call WE placed?
        //
        // Smartflo's `direction` field cannot be relied on: it is absent on
        // some payloads and defaults to 'inbound' above. The dialer records
        // every number it rings, so a match there is the authoritative answer —
        // and it is the only one available, because the Click to Call response
        // carries no call id to join on.
        //
        // Both legs are offered, because which of `from`/`to` holds the
        // customer depends on how the Click to Call destination is configured.
        const outbound = claimPending(phoneNumber, toNumber);

        if (outbound) {
          logger.info(
            `[ws] OUTBOUND call connected — ${outbound.matchedOn}` +
            `${outbound.name ? ` (${outbound.name})` : ''} row=${outbound.rowNumber} ` +
            `ref=${outbound.refId} after ${Date.now() - outbound.dialedAt}ms`,
          );
        }

        session = new CallSession({
          callSid,
          streamSid,
          accountSid,
          // On an outbound call the customer is whichever leg the registry
          // matched. Taking `from` blindly would key the profile, the memory
          // and the lead record to our own DID.
          phoneNumber: outbound ? outbound.matchedOn : phoneNumber,
          toNumber,
          direction: outbound ? 'outbound' : direction,
          outbound,
          ws,
        });
        sessionManager.set(callSid, session);
        break;
      }

      // ── media ─────────────────────────────────────────────────────────────
      case 'media':
        if (session) {
          session.pushAudio(msg.media.payload);
        }
        break;

      // ── mark ──────────────────────────────────────────────────────────────
      // Smartflo sends this back once it has finished PLAYING all media queued
      // before the mark. It is the only reliable end-of-speech signal: frames
      // are written to the socket far faster than they are played.
      case 'mark':
        if (session) {
          session.onMark(msg.mark?.name);
        }
        break;

      // ── dtmf ──────────────────────────────────────────────────────────────
      case 'dtmf':
        logger.debug(`[ws] DTMF: ${msg.dtmf?.digit}`);
        break;

      // ── stop ──────────────────────────────────────────────────────────────
      case 'stop': {
        logger.info(`[ws] Stream stopped — callSid=${msg.stop?.callSid}`);

        // Claim the session BEFORE awaiting. flush() writes to Mongo and takes
        // a couple of seconds; the socket usually closes during that await, and
        // the close handler would set `session` to null underneath us. Reading
        // `session.callSid` afterwards then crashed the process.
        const closing = session;
        session = null;
        if (closing) {
          await closing.flush();
          closing.destroy();
          sessionManager.delete(closing.callSid);
        }
        break;
      }

      default:
        logger.debug(`[ws] Unknown event: ${msg.event}`);
    }
  });

  // ws.on('close', async () => {
  //   logger.info('[ws] WebSocket closed');
  //   if (session) {
  //     await session.flush();
  //     session.destroy();
  //     sessionManager.delete(session.callSid);
  //     session = null;
  //   }
  // });
  ws.on('close', async () => {
    // Same claim-before-await pattern as `stop`. Whichever fires first owns the
    // teardown; the other sees null and does nothing. flush() is idempotent, so
    // a double call is harmless either way.
    const closing = session;
    session = null;

    try {
      if (closing) {
        await closing.flush();
        closing.destroy();
        sessionManager.delete(closing.callSid);
      }
      logger.info('[ws] WebSocket closed');
    } catch (err) {
      logger.error(`[ws close] ${err.message}`);
    }
  });

  ws.on('error', (err) => {
    logger.error(`[ws] WebSocket error: ${err.message}`);
  });
}