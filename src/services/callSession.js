// // src/services/callSession.js
// import { EventEmitter } from 'events';
// import {
//   createSarvamStream,
//   synthesizeToFrames,
//   synthesizeStream,
//   getCachedFrames,
//   framesDurationMs,
// } from './speechService.js';

// import {
//   processMessage,
//   hydrateUserProfile,
//   leadDataFromProfile,
//   persistLeadData,
// } from './agentService.js';
// import { decodeMulawPayloadToPcm16 } from '../utils/audioUtils.js';
// import { createCallRecorder } from '../utils/callRecorder.js';
// import { markTurnUnheard, clearUnheardTurns } from '../agents/unheardTurns.js';
// import {
//   toSpeakable,
//   detectLanguage,
//   nextReplyLanguage,
// } from '../utils/speakable.js';
// import { config } from '../config/index.js';

// import { Log } from '../models/Log.js';
// import { logger } from '../utils/logger.js';

// const GREETING = 'Thank you for calling X verse India.';

// // Greeting audio is cached per phrase for the life of the process. The generic
// // line is prewarmed at pickup; the personalised follow-up for a returning
// // caller is cached the first time that name calls, and free thereafter.
// const greetingCache = new Map();
// function getGreetingFrames(text = GREETING) {
//   if (!greetingCache.has(text)) {
//     greetingCache.set(
//       text,
//       synthesizeToFrames(text).catch((err) => {
//         logger.error(`[greeting] synth failed: ${err.message}`);
//         greetingCache.delete(text); // allow a retry on the next call
//         return [];
//       }),
//     );
//   }
//   return greetingCache.get(text);
// }

// // How many TTS requests may be in flight for this call at once.
// //
// // Firing every segment the moment it arrives looked free — synthesis overlaps
// // playback either way — but it is not: concurrent requests contend with each
// // other at the provider, and the one that suffers is segment 1, which is the
// // only one the caller is waiting on. Measured on a 4-segment reply, unbounded
// // parallelism pushed time-to-first-audio from ~1s to 6-8s.
// //
// // Set to 1 after a live call showed the cost is not CPU contention but new
// // HTTPS connections: synthesis runs a steady ~26ms/char, but the two jobs that
// // were second-in-flight during the first two turns took 121 and 129 ms/char —
// // about 4 seconds each — and nothing was slow again once the pool was warm. A
// // second concurrent request opens a second TLS connection, and from India that
// // handshake costs seconds.
// //
// // Serial costs nothing: a segment is 1.5-2.5s of audio and the next synthesizes
// // in well under a second, so it is always ready before the current one ends.
// const TTS_LOOKAHEAD = Number(process.env.TTS_LOOKAHEAD ?? 1);

// // Sarvam's VAD sometimes cuts one spoken phrase into several utterances. On a
// // live call this booked a meeting under the name "संग" — a 0.48s fragment whose
// // START_SPEECH and END_SPEECH were 1.4ms apart — while the caller's actual name
// // arrived 1.2s later as a separate turn. The same split an email into
// // "सी I S S." and "8703@gmail.com.", and the confirmation went to the wrong
// // address.
// //
// // So a fragment is held briefly to see whether the rest of the phrase follows.
// // This does NOT apply to every utterance: anything long enough that ends in
// // terminal punctuation is a complete thought and dispatches immediately, so
// // most turns pay nothing.
// const UTTERANCE_JOIN_MS = Number(process.env.UTTERANCE_JOIN_MS ?? 400);

// // How long a COMPLETE-looking sentence waits before being acted on.
// //
// // UTTERANCE_JOIN_MS above only holds fragments. A long, properly punctuated
// // sentence dispatched immediately — which is exactly when a caller is most
// // likely still mid-thought, because Sarvam endpoints on a pause rather than on
// // meaning. That is why the agent starts talking over people who have not
// // finished.
// //
// // 0 keeps the old behaviour. 300-500 gives the caller room to continue, at the
// // cost of that much added latency on every turn.
// const UTTERANCE_SETTLE_MS = Number(process.env.UTTERANCE_SETTLE_MS ?? 0);

// // Cap on how much gets merged into one turn when a caller asks several things
// // in a row, so a long monologue cannot grow the prompt without bound.
// const MAX_QUEUED_UTTERANCES = Number(process.env.MAX_QUEUED_UTTERANCES ?? 3);
// const MAX_QUEUED_CHARS = Number(process.env.MAX_QUEUED_CHARS ?? 400);

// // Sarvam's VAD fires START_SPEECH on brief noise as well as on real speech. On
// // a live call two such blips — 25ms and 197ms long, both returning an EMPTY
// // transcript — cut the bot off mid-reply, once 0.5s into a 7.2s answer. That is
// // the "breaking up" a caller hears.
// //
// // So a barge-in is now confirmed before acting on it: if END_SPEECH arrives
// // within this window, the "speech" was a blip and the reply continues. Real
// // speech lasts far longer than this, and the cost of waiting is that the bot
// // talks over a genuine interruption for an extra fraction of a second.
// const BARGE_IN_CONFIRM_MS = Number(process.env.BARGE_IN_CONFIRM_MS ?? 300);

// // How long to wait for more speech when the agent has just asked for an email.
// // Addresses are dictated in pieces with pauses; the normal 400ms window cut
// // them into separate turns.
// const LONG_ANSWER_WAIT_MS = Number(process.env.LONG_ANSWER_WAIT_MS ?? 2000);

// // Start-up guards. A profile lookup slower than this is abandoned and the call
// // continues without one; a start-up stalled longer than INIT_STALL_MS is logged
// // with the step it is stuck on.
// const PROFILE_TIMEOUT_MS = Number(process.env.PROFILE_TIMEOUT_MS ?? 4000);
// const INIT_STALL_MS = Number(process.env.INIT_STALL_MS ?? 6000);

// // If the caller says nothing for this long after the agent finishes speaking,
// // ask again. On a live call an answer to "बुक कर दूँ?" never reached the server,
// // and caller and agent both waited in silence for 13 seconds. Whatever the
// // cause, the agent must not wait forever. Long enough to think, or to spell an
// // email: any speech at all resets it.
// const SILENCE_REPROMPT_MS = Number(process.env.SILENCE_REPROMPT_MS ?? 8000);
// const MAX_REPROMPTS = Number(process.env.MAX_REPROMPTS ?? 2);

// // When a reply is dropped because the caller kept talking, how long to wait for
// // the rest of their sentence before answering the fragment on its own.
// const CARRY_OVER_BACKSTOP_MS = Number(process.env.CARRY_OVER_BACKSTOP_MS ?? 4000);

// // Watchdog: how long a turn may go with NO progress before it is force-closed.
// // Covers a model that never answers or marks that never come back. It is
// // re-armed as audio is sent, so a long reply is never mistaken for a stuck one.
// const WATCHDOG_IDLE_MS = Number(process.env.WATCHDOG_IDLE_MS ?? 20_000);
// const WATCHDOG_GRACE_MS = Number(process.env.WATCHDOG_GRACE_MS ?? 5_000);

// // Reconnect policy for the speech-to-text socket.
// const STT_MAX_RETRIES = 4;
// const STT_RETRY_BASE_MS = 300;
// const FRAGMENT_MAX_CHARS = 25;

// /** The final question in a reply — what to repeat if the answer went missing. */
// function lastQuestion(text) {
//   const sentences = String(text).split(/(?<=[?।.!])\s+/).map((x) => x.trim()).filter(Boolean);
//   for (let i = sentences.length - 1; i >= 0; i--) {
//     if (/\?\s*$/.test(sentences[i])) return sentences[i];
//   }
//   return null;
// }

// /** Would acting on this transcript alone be risky? */
// function looksLikeFragment(text) {
//   const t = (text ?? '').trim();
//   if (!t) return true;
//   if (t.length < FRAGMENT_MAX_CHARS) return true;
//   return !/[.!?।॥]$/.test(t);   // cut off mid-phrase
// }

// // Note on barge-in: `speaking` goes true the moment a turn opens, which is
// // well before any audio reaches the caller (the model still has to generate
// // and Sarvam still has to synthesize). A START_SPEECH during that window is
// // not an interrupt — there is nothing playing to interrupt, and killing the
// // turn would just throw away the answer. The caller's words arrive separately
// // via onUtteranceEnd and get queued. So barge-in is gated on _speakingSince,
// // which is stamped when the first frame actually goes out.

// export class CallSession extends EventEmitter {

//   constructor({ callSid, streamSid, accountSid, phoneNumber, toNumber, direction, ws }) {
//     super();

//     this.callSid = callSid;
//     this.streamSid = streamSid;
//     this.accountSid = accountSid ?? null;   // Smartflo sends this on start
//     this.phoneNumber = phoneNumber;
//     this.toNumber = toNumber ?? null;
//     this.direction = direction ?? 'inbound';
//     this.ws = ws;

//     this.userProfile = null;
//     this.leadData = {};

//     this.processing = false;
//     this.speaking = false;
//     this.ttsAborted = false;
//     this.pendingTranscript = null;

//     this.startedAt = Date.now();
//     this.turns = [];

//     this._isDestroyed = false;
//     this._flushed = false;
//     this._mediaChunk = 0;   // outbound media.chunk counter, per the Smartflo doc
//     this._agentPlaybackHead = 0;   // when the caller will HEAR the next agent frame

//     this._recorder = createCallRecorder({
//       callSid,
//       enabled: config.recording.enabled,
//       maxMs: config.recording.maxMs,
//     });
//     this._sttRetries = 0;
//     this._sttRetryTimer = null;
//     this._sttGaveUp = false;
//     this._sarvamLive = null;

//     this.processingTimer = null;

//     // ── Speech pipeline state ────────────────────────────────────────────────
//     // Incremented on every new turn and on every interrupt. Any queued or
//     // in-flight synthesis carrying a stale token is discarded rather than sent,
//     // which is what makes barge-in safe while requests are still on the wire.
//     this._turnToken = 0;
//     this._speechQueue = [];   // [{ token, seq, text, frames: Promise<Buffer[]>|null }]
//     this._speechSeq = 0;
//     this._inFlightTts = 0;
//     this._lastSpokenText = null;
//     this._draining = false;
//     this._producerDone = true; // "the LLM has finished handing us sentences"
//     this._pendingMarks = new Set();
//     this._speakingSince = 0;

//     // The transcript currently being answered. Sarvam's VAD sometimes cuts a
//     // sentence early and then re-emits the whole thing, so we need to know what
//     // we are mid-answer on in order to spot the fuller version arriving.
//     this._activeTranscript = null;

//     // Wall-clock of the last END_SPEECH from Sarvam's VAD. The gap between that
//     // and the transcript arriving is pure recognizer latency — invisible to the
//     // server until now, and the only part of a turn we were not measuring.
//     this._speechEndedAt = 0;

//     // Fragments held back waiting to be joined into one utterance.
//     this._utteranceParts = [];
//     this._utteranceTimer = null;
//     this._utteranceArrivedAt = 0;
//     this._bargeInTimer = null;
//     this._unconfirmedBargeInAt = 0;
//     this._resumeTimer = null;
//     this._carryOver = null;
//     this._carryTimer = null;
//     this._silenceTimer = null;
//     this._reprompts = 0;
//     // The call opens in English, because the greeting is in English. It moves to
//     // Hindi only when the caller actually speaks Hindi — never on a guess, and
//     // never because the model felt like it.
//     this._convLang = 'en';
//     this._activeTurnId = null;
//     this._pendingArrivedAt = 0;
//     this._pendingSpeechEndedAt = 0;
//     this._pendingCount = 0;

//     this._init();
//   }

//   async _init() {
//     // If start-up stalls, say WHERE. A call once sat silent for 73 seconds with
//     // nothing logged between "stream started" and hang-up: no error, because
//     // nothing threw — something simply never answered.
//     this._initStage = 'starting';
//     const stall = setTimeout(() => {
//       logger.error(
//         `[session:${this.callSid}] start-up STALLED at "${this._initStage}" ` +
//         `after ${INIT_STALL_MS}ms — the caller is hearing silence`
//       );
//     }, INIT_STALL_MS);

//     try {
//       // Kick the greeting synthesis off immediately; it overlaps the DB read.
//       this._initStage = 'greeting synthesis';
//       getGreetingFrames();

//       // A slow or unreachable database must not stop the call. Past the limit,
//       // carry on without a profile — the agent just won't know a returning
//       // caller — rather than leave them listening to nothing.
//       this._initStage = 'profile lookup (MongoDB)';
//       const profile = await Promise.race([
//         hydrateUserProfile(this.phoneNumber),
//         new Promise((resolve) => setTimeout(() => {
//           logger.warn(
//             `[session:${this.callSid}] profile lookup took over ${PROFILE_TIMEOUT_MS}ms — ` +
//             `continuing without it`
//           );
//           resolve(null);
//         }, PROFILE_TIMEOUT_MS)),
//       ]);
//       this.userProfile = profile ?? { phoneNumber: this.phoneNumber, degraded: true };

//       // Carry what we already know into this call's leadData, so the agent does
//       // not ask a returning caller for their name and email all over again.
//       // The reducer in state.js merges, so anything extracted this call layers
//       // on top of these rather than replacing them.
//       this.leadData = leadDataFromProfile(this.userProfile);

//       if (this.userProfile?.degraded) {
//         logger.warn(
//           `[session:${this.callSid}] running WITHOUT a profile — memory and lead ` +
//           `capture are degraded for this call`,
//         );
//       }

//       logger.info(`[session:${this.callSid}] initialized`, {
//         returning: this.userProfile?.isReturning ?? false,
//         known: Object.entries(this.leadData)
//           .filter(([, v]) => v)
//           .map(([k]) => k),
//       });

//       this._initStage = 'speech-to-text connection';
//       this._openStt();

//       this._initStage = 'greeting playback';
//       await this._playGreeting();
//       this._initStage = 'done';

//     } catch (err) {
//       logger.error(`[session:${this.callSid}] init failed at "${this._initStage}": ${err.message}`);
//     } finally {
//       clearTimeout(stall);
//     }
//   }

//   /**
//    * Open the speech-to-text socket, and reopen it if it drops mid-call.
//    *
//    * A dropped socket is silent from the caller's side: they keep talking, we
//    * keep sending audio into a closed connection, and nothing ever comes back.
//    * Reconnecting matters more than it looks — the alternative is a call that
//    * appears live but has stopped listening.
//    */
//   _openStt() {
//     if (this._isDestroyed) return;

//     this._sarvamLive = createSarvamStream({

//       onOpen: () => {
//         this._sttRetries = 0;   // a successful open clears the backoff
//         logger.info(`[session:${this.callSid}] Sarvam STT ready`);
//       },

//       // Barge-in comes from Sarvam's own VAD, not from partial text.
//       onSpeechStart: () => {
//         this._speechEndedAt = 0;
//         this._clearSilenceTimer();
//         this._reprompts = 0;

//         // Caller is talking again while we hold a fragment, so the phrase is
//         // still coming. Push the deadline out rather than acting on half.
//         if (this._utteranceTimer) {
//           clearTimeout(this._utteranceTimer);
//           this._utteranceTimer = setTimeout(
//             () => this._flushUtteranceParts(),
//             this._expectingLongAnswer() ? LONG_ANSWER_WAIT_MS : UTTERANCE_JOIN_MS,
//           );
//         }

//         // ── Caller kept talking while we were still THINKING ────────────────
//         //
//         // Sarvam ends a turn on a pause, not on meaning. A caller who pauses
//         // mid-sentence ("कल…") gets a turn started for the fragment; if they
//         // carry on ("…तीन बजे") while the model is still working, the reply to
//         // the fragment — "date and time batao" — then plays OVER them as they
//         // give the date and time. Barge-in cannot catch it: nothing is audible
//         // yet, so there is nothing to interrupt.
//         //
//         // So: if they resume before our first word, and it is real speech
//         // rather than a VAD blip, drop the half-formed reply and fold the
//         // fragment into whatever they say next.
//         if (this.processing && !this._speakingSince && this._activeTranscript) {
//           if (!this._resumeTimer) {
//             this._resumeTimer = setTimeout(() => {
//               this._resumeTimer = null;
//               if (this._isDestroyed || !this.processing || this._speakingSince) return;
//               const carry = this._activeTranscript;
//               logger.info(`[session:${this.callSid}] caller kept talking — holding the reply to "${carry}"`);
//               this._abandonTurn();
//               this._armCarryOver(carry);
//             }, BARGE_IN_CONFIRM_MS);
//           }
//           return;
//         }

//         if (!this.speaking) return;
//         if (!this._speakingSince) return; // nothing audible yet — not an interrupt

//         // Do not cut the reply yet — wait to see whether this is real speech.
//         if (this._bargeInTimer) return;
//         this._bargeInTimer = setTimeout(() => {
//           this._bargeInTimer = null;
//           if (this._isDestroyed || !this.speaking) return;
//           logger.debug(`[session:${this.callSid}] barge-in confirmed`);
//           this._handleInterrupt();
//         }, BARGE_IN_CONFIRM_MS);
//       },

//       onSpeechEnd: () => {
//         this._speechEndedAt = Date.now();

//         // Resumed speech ended inside the confirmation window: a blip, not the
//         // caller continuing. Let the reply we were preparing go ahead.
//         if (this._resumeTimer) {
//           clearTimeout(this._resumeTimer);
//           this._resumeTimer = null;
//         }

//         // Speech ended inside the confirmation window, so on the VAD's account
//         // it was a blip. Stand the interrupt down — but remember it happened,
//         // because a real transcript landing right after proves the VAD was
//         // wrong and the caller genuinely spoke.
//         if (this._bargeInTimer) {
//           clearTimeout(this._bargeInTimer);
//           this._bargeInTimer = null;
//           this._unconfirmedBargeInAt = Date.now();
//           logger.debug(`[session:${this.callSid}] barge-in held — speech too short to confirm`);
//         }
//       },

//       onTranscript: () => { /* no-op — kept for interface compatibility */ },

//       onUtteranceEnd: (text) => this._collectUtterance(text),

//       onError: (err) => {
//         logger.error(`[session:${this.callSid}] sarvam=${err.message}`);
//       },

//       onClose: (code) => {
//         // 1000 after we called finish() is expected. Anything else mid-call
//         // means the socket died and the caller is talking into a void.
//         if (this._isDestroyed || code === 1000) return;
//         this._reopenStt(code);
//       },
//     });
//   }

//   /** Reopen after an unexpected close, backing off so a hard outage does not spin. */
//   _reopenStt(code) {
//     if (this._isDestroyed) return;
//     // A retry is already scheduled; a burst of closes should not stack timers.
//     if (this._sttRetryTimer) return;

//     this._sttRetries = (this._sttRetries ?? 0) + 1;
//     if (this._sttRetries > STT_MAX_RETRIES) {
//       // Report the give-up once, not on every subsequent close event.
//       if (!this._sttGaveUp) {
//         this._sttGaveUp = true;
//         logger.error(
//           `[session:${this.callSid}] STT dropped (code=${code}) and ${STT_MAX_RETRIES} ` +
//           `reconnects failed — this call can no longer hear the caller`,
//         );
//       }
//       return;
//     }

//     // 300ms, 600ms, 1200ms... Anything already buffered in the old socket is
//     // lost either way, so there is nothing to preserve across the gap.
//     const delay = STT_RETRY_BASE_MS * 2 ** (this._sttRetries - 1);
//     logger.warn(
//       `[session:${this.callSid}] STT dropped (code=${code}) — ` +
//       `reconnecting in ${delay}ms (attempt ${this._sttRetries}/${STT_MAX_RETRIES})`,
//     );

//     this._sttRetryTimer = setTimeout(() => {
//       this._sttRetryTimer = null;
//       if (this._isDestroyed) return;
//       try {
//         this._sarvamLive?.finish();
//       } catch { /* already gone */ }
//       this._openStt();
//     }, delay);
//   }

//   pushAudio(base64Payload) {
//     if (this._isDestroyed || !this._sarvamLive) return;

//     try {
//       const pcm = decodeMulawPayloadToPcm16(base64Payload);
//       this._recorder.addCaller(pcm);
//       this._sarvamLive.send(pcm);
//     } catch (err) {
//       logger.error(`[session:${this.callSid}] push=${err.message}`);
//     }
//   }

//   // ───────────────────────────────────────────────────────────────────────────
//   // Turn handling
//   // ───────────────────────────────────────────────────────────────────────────


//   /**
//    * Buffer an incoming transcript, joining it with anything held back.
//    *
//    * A complete-looking sentence goes straight through. A fragment waits
//    * UTTERANCE_JOIN_MS for the rest of the phrase, and any further fragment
//    * arriving in that window restarts the clock.
//    */
//   _collectUtterance(text) {
//     const t = (text ?? "").trim();
//     if (!t) return;   // empty transcripts are VAD noise, never a turn
//     this._clearSilenceTimer();
//     this._reprompts = 0;

//     // Words arrived just after a barge-in we declined to act on. The VAD called
//     // the speech too short, but a transcript proves the caller really did talk
//     // over us — so confirm it now. Deliberately narrow: this only resolves an
//     // interrupt already in question, it never starts one, so the normal
//     // queued-transcript path is untouched.
//     const pending = this._unconfirmedBargeInAt
//       && Date.now() - this._unconfirmedBargeInAt < BARGE_IN_CONFIRM_MS * 2;
//     this._unconfirmedBargeInAt = 0;

//     if (pending && this.speaking && this._speakingSince) {
//       if (this._bargeInTimer) {
//         clearTimeout(this._bargeInTimer);
//         this._bargeInTimer = null;
//       }
//       logger.debug(`[session:${this.callSid}] barge-in confirmed by transcript`);
//       this._handleInterrupt();
//     }

//     // Recognizer lag ends here — when Sarvam hands us the text. Anything after
//     // this is our own queueing, and conflating the two made a 166ms lag look
//     // like 2594ms on a turn that had to wait for the previous reply to finish.
//     if (!this._utteranceParts.length) this._utteranceArrivedAt = Date.now();

//     this._utteranceParts.push(t);
//     if (this._utteranceTimer) clearTimeout(this._utteranceTimer);

//     // A complete sentence still waits UTTERANCE_SETTLE_MS (0 by default) so a
//     // caller who pauses mid-thought is not talked over; a fragment waits the
//     // longer join window for the rest of the phrase.
//     const complete = this._utteranceParts.length === 1 && !looksLikeFragment(t);
//     // Dictating an email comes out in pieces, with pauses. Treating each pause
//     // as the end of the answer made the agent reply after every piece — a live
//     // call looped through "मैं ईमेल नहीं समझ पाई" nine times while the caller
//     // was mid-way through saying it.
//     const wait = this._expectingLongAnswer()
//       ? LONG_ANSWER_WAIT_MS
//       : complete ? UTTERANCE_SETTLE_MS : UTTERANCE_JOIN_MS;

//     if (wait <= 0) {
//       this._flushUtteranceParts();
//       return;
//     }

//     logger.debug(
//       `[session:${this.callSid}] holding ${complete ? 'utterance' : 'fragment'} ` +
//       `"${t}" for ${wait}ms`
//     );
//     this._utteranceTimer = setTimeout(() => this._flushUtteranceParts(), wait);
//   }

//   /**
//    * Hold a fragment whose reply was dropped because the caller kept talking.
//    *
//    * Normally it is merged into their next utterance. But if that utterance
//    * never produces text — the resumed "speech" was noise and Sarvam returns an
//    * empty transcript — the fragment would be stranded and the caller would get
//    * no answer at all. The backstop answers it on its own instead.
//    */
//   _armCarryOver(text) {
//     this._carryOver = text;
//     if (this._carryTimer) clearTimeout(this._carryTimer);
//     this._carryTimer = setTimeout(() => {
//       this._carryTimer = null;
//       if (this._isDestroyed || !this._carryOver) return;
//       if (this.processing || this._utteranceParts.length) return;   // being handled
//       const t = this._carryOver;
//       this._clearCarryOver();
//       logger.info(`[session:${this.callSid}] nothing followed — answering "${t}" on its own`);
//       this._dispatchUtterance(t);
//     }, CARRY_OVER_BACKSTOP_MS);
//   }

//   _clearCarryOver() {
//     this._carryOver = null;
//     if (this._carryTimer) { clearTimeout(this._carryTimer); this._carryTimer = null; }
//   }

//   /** Join everything held back and hand it over as one utterance. */
//   _flushUtteranceParts() {
//     if (this._utteranceTimer) {
//       clearTimeout(this._utteranceTimer);
//       this._utteranceTimer = null;
//     }
//     if (!this._utteranceParts.length) return;

//     const parts = this._utteranceParts;
//     this._utteranceParts = [];
//     let joined = parts.join(" ").replace(/\s+/g, " ").trim();

//     // Prepend what the caller said BEFORE they paused, if we held a reply to it.
//     if (this._carryOver) {
//       joined = `${this._carryOver} ${joined}`.replace(/\s+/g, ' ').trim();
//       logger.info(`[session:${this.callSid}] merged the held fragment -> "${joined}"`);
//       this._clearCarryOver();
//     }

//     if (parts.length > 1) {
//       logger.info(
//         `[session:${this.callSid}] joined ${parts.length} fragments -> "${joined}"`,
//       );
//     }

//     this._dispatchUtterance(joined);
//   }

//   /** Decide whether this utterance runs now, supersedes, or queues. */
//   async _dispatchUtterance(text) {
//         if (this.processing) {
//           // Sarvam re-sent a longer version of the sentence we are already
//           // answering. Answering both means replying twice to one utterance,
//           // the second time to text the caller has already heard us address.
//           if (this._supersedes(text, this._activeTranscript)) {
//             logger.info(
//               `[session:${this.callSid}] transcript superseded: ` +
//               `"${this._activeTranscript}" -> "${text}"`,
//             );
//             this._abandonTurn();
//             await this._handleUtteranceEnd(text);
//             return;
//           }

//           // Same thing, but for a transcript that is only queued, not running.
//           if (this._supersedes(text, this.pendingTranscript)) {
//             logger.info(`[session:${this.callSid}] queued transcript replaced by fuller one`);
//           }
//           // Append rather than replace. A single slot meant a caller who asked
//           // two things while the agent was talking lost the first one outright
//           // — it was silently overwritten and never answered. Merging them into
//           // one turn also gets a coherent reply to both, in order, instead of
//           // two disconnected ones.
//           const parts = this.pendingTranscript ? [this.pendingTranscript, text] : [text];
//           const merged = parts.join(' ').replace(/\s+/g, ' ').trim();

//           if (this.pendingTranscript
//               && (this._pendingCount >= MAX_QUEUED_UTTERANCES || merged.length > MAX_QUEUED_CHARS)) {
//             logger.warn(
//               `[session:${this.callSid}] queue full — dropping "${text.slice(0, 40)}"`
//             );
//             return;
//           }

//           this.pendingTranscript = merged;
//           this._pendingCount = (this._pendingCount ?? 0) + 1;

//           // Carry the arrival time with it. The queued path calls
//           // _handleUtteranceEnd directly, so without this the wait would be
//           // charged to the recognizer instead of to us. Keep the EARLIEST
//           // arrival — that is when the caller actually started waiting.
//           if (!this._pendingArrivedAt) {
//             this._pendingArrivedAt = this._utteranceArrivedAt || Date.now();
//             this._pendingSpeechEndedAt = this._speechEndedAt;
//           }

//           logger.info(
//             `[session:${this.callSid}] queued transcript` +
//             (this._pendingCount > 1 ? ` (merged ${this._pendingCount}: "${merged.slice(0, 60)}")` : '')
//           );
//           return;
//         }
//         await this._handleUtteranceEnd(text);
//   }

//   /**
//    * True when `next` is the same utterance as `prev` with more of it captured.
//    * Compared on letters and digits only, so punctuation and spacing added by
//    * the recognizer on the second pass do not defeat the match.
//    */
//   _supersedes(next, prev) {
//     if (!next || !prev) return false;
//     const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
//     const a = norm(prev);
//     const b = norm(next);
//     return a.length > 0 && b.length > a.length && b.startsWith(a);
//   }

//   /**
//    * Throw away the turn in flight without treating it as a caller interrupt.
//    *
//    * Deliberately does NOT call finishResponse(), because that would kick off
//    * whatever is sitting in pendingTranscript — and the caller of this method is
//    * about to start a better turn itself.
//    */
//   _abandonTurn() {
//     // Nothing of this turn reached the caller. Keep it out of what the model
//     // sees next, or it believes it asked a question nobody heard.
//     if (this._activeTurnId) {
//       markTurnUnheard(this.callSid, this._activeTurnId);
//       logger.debug(`[session:${this.callSid}] turn ${this._activeTurnId} marked unheard`);
//     }
//     this.ttsAborted = true;
//     this._turnToken++;          // stale synthesis and marks are now rejected
//     this._speechQueue = [];
//     this._pendingMarks.clear();

//     // Only clear the provider's buffer if we had actually started playing something.
//     if (this._speakingSince) {
//       this._send({ event: 'clear', streamSid: this.streamSid });
//     }

//     this.speaking = false;
//     this.processing = false;
//     this._speakingSince = 0;
//     this.clearWatchdog();

//     // Drop the partial utterance from the transcript log so the call record
//     // does not show the caller saying a fragment we then ignored.
//     const last = this.turns[this.turns.length - 1];
//     if (last?.role === 'user' && last.text === this._activeTranscript) this.turns.pop();
//     this._activeTranscript = null;

//     // A barge-in or resume check pending on THIS turn must not outlive it.
//     // Forgetting the handle without clearing it (as a copied init block here
//     // once did) let the timer fire on the NEXT turn and interrupt a reply that
//     // had only just started — heard by the caller as the agent going silent.
//     if (this._bargeInTimer) { clearTimeout(this._bargeInTimer); this._bargeInTimer = null; }
//     if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
//     this._unconfirmedBargeInAt = 0;

//     // Deliberately NOT cleared: _utteranceParts and its timer. Those hold what
//     // the caller is saying right now, which is exactly what the next turn needs.
//   }

//   async _handleUtteranceEnd(transcript) {
//     if (this._isDestroyed || !transcript?.trim()) return;

//     this.processing = true;

//     const t0 = Date.now();

//     // How long Sarvam took to hand us text after it decided the caller had
//     // finished. Measured to the transcript ARRIVING, not to this turn starting:
//     // a queued turn starts only once the previous reply has finished playing,
//     // and that wait is ours, not the recognizer's.
//     const arrivedAt = this._utteranceArrivedAt || t0;
//     const sttLagMs = this._speechEndedAt ? Math.max(0, arrivedAt - this._speechEndedAt) : null;
//     const queuedMs = Math.max(0, t0 - arrivedAt);
//     this._speechEndedAt = 0;
//     this._utteranceArrivedAt = 0;

//     this._turnNo = (this._turnNo ?? 0) + 1;
//     this._budget = {
//       turnNo: this._turnNo,
//       transcript,
//       t0,
//       sttLagMs,                    // END_SPEECH -> transcript in hand
//       queuedMs,                    // transcript in hand -> this turn allowed to run
//       firstSegmentQueuedAt: null,  // model produced something speakable
//       llmFirstSentenceMs: null,
//       llmCompleteMs: null,
//       firstAudioAt: null,
//       lastSentAt: null,
//       speechMs: 0,                 // total audio duration produced
//       playbackEndsAt: null,        // wall-clock the caller stops hearing us
//       starvedMs: 0,                // silence because synthesis fell behind
//       segments: [],                // [{ seq, chars, synthMs, audioMs }]
//     };

//     logger.info('[LATENCY] ===== New Turn =====');
//     if (sttLagMs !== null) {
//       logger.info(`[LATENCY] stt.endSpeech->transcript = ${sttLagMs} ms`);
//     }
//     if (queuedMs > 50) {
//       logger.info(`[LATENCY] queued behind previous reply = ${queuedMs} ms`);
//     }
//     this.startWatchdog();
//     logger.info(`[User] ${transcript}`);

//     this._activeTranscript = transcript;
//     this.turns.push({ role: 'user', text: transcript, timestamp: new Date() });

//     // Open a new speech turn BEFORE invoking the model, because sentences will
//     // start arriving while graph.invoke() is still awaiting.
//     this._beginSpeechTurn(t0);

//     // Everything below belongs to THIS turn. If the caller barges in, a new
//     // turn takes over and this token goes stale — at which point the still-
//     // running processMessage() must not be able to push audio into, or close,
//     // the turn that replaced it.
//     const myToken = this._turnToken;

//     try {
//       // The reply language follows the caller, but only on a clear sentence.
//       // Letting it follow their LAST message flipped the call on every "Yes."
//       // or "जी।". Short replies, names and emails leave it where it is.
//       // Every message of this turn is tagged with this id, so if the turn is
//       // dropped unheard the model can be kept from believing it happened.
//       this._activeTurnId = `${this.callSid}:${myToken}`;

//       // English unless the caller speaks Hindi. The old rule was "whatever the
//       // last classifiable utterance was", so an English caller who said "How
//       // are you?" got a Hindi reply: that utterance classified as nothing, the
//       // language stayed unset, and the model chose for itself — leaning Hindi,
//       // because its persona and examples are Devanagari.
//       //
//       // nextReplyLanguage() is asymmetric on purpose: one Devanagari word moves
//       // the call to Hindi, while leaving Hindi needs a full English sentence.
//       // Acknowledgements ("हाँ", "Yes", "theek hai") move it neither way.
//       const before = this._convLang;
//       this._convLang = nextReplyLanguage(before, transcript);
//       if (this._convLang !== before) {
//         logger.info(
//           `[session:${this.callSid}] reply language ${before} -> ${this._convLang} ` +
//           `("${String(transcript).slice(0, 40)}")`,
//         );
//       }
//       this._callLang = this._convLang;   // voice follows too

//       const { response, leadData } = await processMessage(
//         this.callSid,
//         transcript,
//         this.userProfile,
//         this.leadData,
//         {
//           // Called from inside the LangGraph node, mid-generation.
//           onSentence: (sentence) => this._enqueueSpeech(sentence, myToken),
//           replyLanguage: this._convLang,
//           turnId: this._activeTurnId,
//         },
//       );

//       logger.info(`[LATENCY] LLM Total = ${Date.now() - t0} ms`);
//       if (this._budget && myToken === this._turnToken) {
//         this._budget.llmCompleteMs = Date.now() - t0;
//       }

//       // A superseding transcript may have arrived while the model was running.
//       // Its answer was built from a partial sentence, so drop it rather than
//       // logging a reply the caller never heard.
//       if (myToken !== this._turnToken) {
//         logger.info(`[session:${this.callSid}] turn abandoned — discarding stale response`);
//         return;
//       }

//       this.leadData = leadData;
//       this.turns.push({ role: 'agent', text: response, timestamp: new Date() });

//     } catch (err) {
//       logger.error(`[Brain] ${err.message}`);
//       // The call's decided language, not the script of this one transcript. A
//       // single Devanagari word in an English call used to be enough to make this
//       // apology come out in Hindi.
//       this._enqueueSpeech(
//         this._convLang === 'hi'
//           ? 'माफ़ कीजिए, मैं समझ नहीं पाई। क्या आप दोबारा बता सकते हैं?'
//           : 'Sorry, I had trouble understanding. Could you say that again?',
//         myToken,
//       );
//     } finally {
//       // No more sentences are coming. The turn ends once the queue has drained
//       // and Smartflo has played everything back.
//       this._endSpeechProduction(myToken);
//     }
//   }

//   // ───────────────────────────────────────────────────────────────────────────
//   // Speech pipeline
//   //
//   // Three things happen concurrently and must not be conflated:
//   //   1. the model produces sentences   (_enqueueSpeech)
//   //   2. Sarvam synthesizes them        (started eagerly, in parallel)
//   //   3. Smartflo plays them back       (strictly ordered, tracked via marks)
//   // ───────────────────────────────────────────────────────────────────────────

//   _beginSpeechTurn(t0 = null) {
//     // Carry the last turn's language forward: a reply made only of times has no
//     // language of its own and should sound like the conversation it is in.
//     if (this._turnLang) this._callLang = this._turnLang;
//     this._turnLang = null;
//     this._turnToken++;
//     this._speechQueue = [];
//     this._speechSeq = 0;
//     this._pendingMarks.clear();
//     this._producerDone = false;
//     this.ttsAborted = false;
//     this.speaking = true;
//     this._speakingSince = 0;   // set on the first frame actually sent
//     this._turnStartedAt = t0;
//   }

//   /**
//    * Accept one speakable segment. Synthesis starts immediately — sentence 2 is
//    * already on the wire while sentence 1 is being written to Smartflo.
//    */
//   _enqueueSpeech(text, token = this._turnToken) {
//     if (!text?.trim() || this._isDestroyed) return;
//     // Stale producer from an interrupted turn, or this turn was aborted.
//     if (token !== this._turnToken || this.ttsAborted) return;

//     const seq = this._speechSeq++;

//     if (this._budget && this._budget.firstSegmentQueuedAt === null) {
//       this._budget.firstSegmentQueuedAt = Date.now();
//       this._budget.llmFirstSentenceMs = this._turnStartedAt
//         ? Date.now() - this._turnStartedAt
//         : null;
//     }

//     logger.debug(`[session:${this.callSid}] queue seq=${seq} "${text.slice(0, 60)}"`);

//     // Queued without frames — _pumpSynthesis decides when it actually starts.
//     this._speechQueue.push({
//       token, seq, text,
//       frames: [],        // fills as bytes arrive
//       started: false,
//       done: false,
//       error: null,
//       waiters: [],       // resolved on every progress event
//     });
//     this._pumpSynthesis();
//     this._drain();
//   }

//   /**
//    * Start synthesis for queued segments, oldest first, up to TTS_LOOKAHEAD in
//    * flight. Order matters: the head of the queue is always started first, so
//    * the segment the caller is waiting on never queues behind a later one.
//    */
//   _pumpSynthesis() {
//     if (this._isDestroyed) return;

//     for (const item of this._speechQueue) {
//       if (this._inFlightTts >= TTS_LOOKAHEAD) break;
//       if (item.started) continue;
//       if (item.token !== this._turnToken) continue; // stale turn, never synthesize

//       item.started = true;
//       const started = Date.now();
//       item.synthStartedAt = started;

//       // Fixed phrases (greeting, tool fillers) are already in memory. Going
//       // over the network for them would add the very delay they exist to hide.
//       const cached = getCachedFrames(item.text);
//       if (cached) {
//         item.frames.push(...cached);
//         item.done = true;
//         item.synthMs = 0;
//         logger.debug(`[session:${this.callSid}] seq=${item.seq} served from phrase cache`);
//         const w = item.waiters; item.waiters = [];
//         for (const r of w) r();
//         continue;
//       }

//       this._inFlightTts++;

//       const wake = () => {
//         const w = item.waiters;
//         item.waiters = [];
//         for (const r of w) r();
//       };

//       // Splitting a reply into sentences and synthesizing each in isolation
//       // loses the prosody that joins them. Handing over the previous segment
//       // lets the engine carry intonation across the boundary. Sarvam ignores
//       // it; ElevenLabs uses it and does not bill it as speech.
//       const previousText = this._speechQueue.find((q) => q.seq === item.seq - 1)?.text
//         ?? this._lastSpokenText
//         ?? undefined;

//       // Times and dates go to the voice in the reply's own language. The model
//       // writes "3:00 PM" even mid-Hindi, and AM/PM make the voice switch to
//       // English for half a sentence. A segment that is only times ("9:00 AM,
//       // 10:00 AM.") has no language of its own, so it inherits the turn's —
//       // segments are synthesized strictly in order, so earlier ones set it.
//       const lang = detectLanguage(item.text);
//       if (lang) this._turnLang = lang;
//       // The last fallback was 'hi', which read a times-only segment in Hindi
//       // during an English call whose language was not yet established. The call
//       // opens with an English greeting, so English is the honest default.
//       const spoken = toSpeakable(
//         item.text,
//         this._turnLang ?? this._callLang ?? this._convLang ?? 'en',
//       );
//       if (spoken !== item.text) {
//         logger.debug(`[session:${this.callSid}] speakable: "${item.text}" -> "${spoken}"`);
//       }

//       synthesizeStream(spoken, (frames) => {
//         if (item.firstFrameMs === undefined) item.firstFrameMs = Date.now() - started;
//         item.frames.push(...frames);
//         wake();                       // let _drain forward these immediately
//       }, { previousText })
//         .catch((err) => {
//           logger.error(`[session:${this.callSid}] TTS seq=${item.seq}: ${err.message}`);
//           item.error = err;
//         })
//         .finally(() => {
//           this._inFlightTts--;
//           item.done = true;
//           this._lastSpokenText = item.text;
//           item.synthMs = Date.now() - started;
//           logger.debug(
//             `[session:${this.callSid}] tts seq=${item.seq} first=${item.firstFrameMs ?? '?'}ms ` +
//             `done=${item.synthMs}ms`
//           );
//           wake();
//           this._pumpSynthesis();
//         });
//     }
//   }

//   /** Stamp the moment the caller can first hear us this turn. */
//   _markFirstAudio() {
//     if (this._speakingSince) return;

//     this._speakingSince = Date.now();
//     if (this._budget) this._budget.firstAudioAt = this._speakingSince;
//     if (!this._turnStartedAt) return;

//     const b = this._budget ?? {};
//     logger.info(
//       `[TURN ${b.turnNo ?? '?'}] stt=${b.sttLagMs ?? '?'}ms ` +
//       `llm=${b.llmFirstSentenceMs ?? '?'}ms ` +
//       `tts=${this._speakingSince - (b.firstSegmentQueuedAt ?? this._speakingSince)}ms ` +
//       `-> first audio ${this._speakingSince - this._turnStartedAt}ms`
//     );
//   }

//   /** Add a delivered segment to this turn's timing report. */
//   _recordSegment(item, audioMs) {
//     const b = this._budget;
//     if (!b || item.token !== this._turnToken) return;

//     const now = Date.now();
//     // Smartflo plays what it has, then waits. If this segment arrives after
//     // everything queued before it has already played out, the caller heard
//     // silence in between.
//     if (b.playbackEndsAt !== null && now > b.playbackEndsAt) {
//       b.starvedMs += now - b.playbackEndsAt;
//     }
//     b.playbackEndsAt = Math.max(b.playbackEndsAt ?? now, now) + audioMs;

//     // This turn just made progress. Push the watchdog out past the end of
//     // everything queued, so a long reply is not mistaken for a stuck one.
//     this.startWatchdog(Math.max(WATCHDOG_IDLE_MS, b.playbackEndsAt - now + WATCHDOG_GRACE_MS));

//     b.lastSentAt = now;
//     b.speechMs += audioMs;
//     b.segments.push({
//       seq: item.seq,
//       chars: item.text.length,
//       synthMs: item.synthMs ?? null,
//       audioMs,
//     });
//   }

//   /** Resolves the next time `item` gains frames or finishes. */
//   _awaitProgress(item) {
//     if (item.done) return Promise.resolve();
//     return new Promise((resolve) => item.waiters.push(resolve));
//   }

//   /** Called once the model has no more sentences for the given turn. */
//   _endSpeechProduction(token = this._turnToken) {
//     if (token !== this._turnToken) return; // superseded; not ours to close
//     this._producerDone = true;
//     this._maybeFinishTurn();
//   }

//   async _drain() {
//     if (this._draining) return;
//     this._draining = true;

//     try {
//       while (this._speechQueue.length) {
//         // Peek first: the head must have its synthesis started before we commit
//         // to removing it.
//         const head = this._speechQueue[0];
//         if (!head.started) {
//           this._pumpSynthesis();
//           // _pumpSynthesis always starts the head first, so this should never
//           // hold. If it somehow does, back out and let a completing request
//           // re-enter through its finally hook rather than spinning.
//           if (!head.started) break;
//         }

//         // Forward frames AS THEY ARRIVE rather than waiting for the whole
//         // sentence. This is the point of the streaming endpoint: on the
//         // measured network the first bytes land ~480ms before the last ones.
//         let sent = 0;
//         let audioMs = 0;

//         for (;;) {
//           while (sent < head.frames.length) {
//             if (this._isDestroyed || this.ttsAborted || head.token !== this._turnToken) break;

//             const frame = head.frames[sent++];
//             this._markFirstAudio();
//             // The doc's outbound media example includes an incrementing
//             // `chunk`. Twilio has no such field, so it was absent before.
//             this._send({
//               event: 'media',
//               streamSid: this.streamSid,
//               media: { payload: frame.toString('base64'), chunk: ++this._mediaChunk },
//             });
//             audioMs += 20;
//           }

//           if (head.done) break;
//           if (this._isDestroyed || this.ttsAborted || head.token !== this._turnToken) break;
//           await this._awaitProgress(head);
//         }

//         this._speechQueue.shift();

//         // Interrupted, destroyed, or belongs to a turn we already abandoned.
//         if (this._isDestroyed || this.ttsAborted || head.token !== this._turnToken) continue;
//         if (audioMs === 0) continue;

//         this._recordSegment(head, audioMs);

//         // Smartflo echoes this back only after the preceding audio has actually
//         // been played out. Without it we would clear `speaking` the instant the
//         // frames were written to the socket — seconds before the caller hears
//         // them — which breaks both barge-in and the queued-transcript handoff.
//         const markName = `t${head.token}-s${head.seq}`;
//         this._pendingMarks.add(markName);
//         this._send({
//           event: 'mark',
//           streamSid: this.streamSid,
//           mark: { name: markName },
//         });

//         logger.debug(`[session:${this.callSid}] sent seq=${head.seq} (${audioMs}ms audio)`);
//       }
//     } finally {
//       this._draining = false;
//       this._maybeFinishTurn();
//     }
//   }

//   /** Smartflo has finished playing everything up to this mark. */
//   onMark(name) {
//     if (!name) return;

//     // Marks from an interrupted turn may still arrive; ignore them so they
//     // cannot prematurely end the turn that replaced it.
//     const token = Number(String(name).match(/^t(\d+)-/)?.[1]);
//     if (token !== this._turnToken) return;

//     this._pendingMarks.delete(name);
//     this._maybeFinishTurn();
//   }

//   _maybeFinishTurn() {
//     if (this._isDestroyed) return;
//     if (!this._producerDone) return;       // model still generating
//     if (this._draining) return;            // still writing to the socket
//     if (this._speechQueue.length) return;  // more synthesis waiting
//     if (this._pendingMarks.size) return;   // audio still playing out

//     this.finishResponse();
//   }

//   _handleInterrupt() {
//     if (!this.speaking) return;

//     logger.info(`[session:${this.callSid}] interrupted`);

//     this.ttsAborted = true;
//     this.speaking = false;

//     // Invalidate everything queued or in flight for the current turn.
//     this._turnToken++;
//     this._speechQueue = [];
//     this._pendingMarks.clear();

//     // Drops the provider's buffered audio. Smartflo differs from Twilio here:
//     // it REPLIES with the marks for the audio it just discarded. Those arrive
//     // carrying the old turn token and are rejected by onMark, which is why the
//     // pending set is emptied rather than waited on.
//     this._send({ event: 'clear', streamSid: this.streamSid });

//     this.finishResponse();
//   }

//   async _playGreeting() {
//     this._beginSpeechTurn();

//     const lines = [GREETING];

//     // ~2s of cached greeting plays first, which is more than enough time to
//     // synthesize this second line. Zero added latency at pickup.
//     const name = this.userProfile?.name;
//     if (name && this.userProfile?.isReturning) {
//       lines.push(`Welcome back, ${name}.`);
//     }

//     for (const text of lines) {
//       // The greeting comes from the module-level cache rather than the network,
//       // but it has to present the same progressive shape the drain loop expects.
//       const item = {
//         token: this._turnToken,
//         seq: this._speechSeq++,
//         text,
//         frames: [],
//         started: true,
//         done: false,
//         error: null,
//         waiters: [],
//       };
//       this._speechQueue.push(item);

//       getGreetingFrames(text)
//         .then((frames) => { item.frames.push(...frames); })
//         .catch((err) => { item.error = err; })
//         .finally(() => {
//           item.done = true;
//           const waiters = item.waiters;
//           item.waiters = [];
//           for (const resolve of waiters) resolve();
//         });
//     }

//     this._drain();
//     this._endSpeechProduction();
//   }

//   /**
//    * Print the full timing breakdown for the turn that just ended.
//    *
//    * Emitted here rather than at first-audio because only now is everything
//    * known: how many segments there were, how long each took to synthesize, and
//    * when Smartflo finished playing the last one.
//    *
//    * The four rows above the line sum to first-audio. Everything below it
//    * describes the rest of the reply, which the caller hears while the pipeline
//    * has already gone idle.
//    */
//   _reportTurn() {
//     const b = this._budget;
//     if (!b || !b.t0 || !b.firstAudioAt) return;   // greeting or aborted turn

//     const pad = (label, ms, note = '') =>
//       `  ${label.padEnd(34)}${String(Math.round(ms)).padStart(6)} ms${note ? '  ' + note : ''}`;

//     const firstAudio = b.firstAudioAt - b.t0;
//     const ttsMs = b.firstSegmentQueuedAt ? b.firstAudioAt - b.firstSegmentQueuedAt : null;
//     const queuedAll = b.lastSentAt ? b.lastSentAt - b.t0 : null;
//     // Derived from actual send times, so mid-reply silence is counted rather
//     // than assumed away.
//     const heardAll = b.playbackEndsAt ? b.playbackEndsAt - b.t0 : firstAudio + b.speechMs;

//     const lines = [
//       `[TURN ${b.turnNo}] "${String(b.transcript).slice(0, 48)}"`,
//       pad('stt   end-of-speech -> transcript', b.sttLagMs ?? 0,
//         b.sttLagMs === null ? '(no END_SPEECH seen)' : ''),
//       // Only shown when it happened: the caller had already finished speaking,
//       // but we were still playing the previous reply.
//       b.queuedMs > 50
//         ? pad('      ...then queued', b.queuedMs, 'waiting for the previous reply to finish')
//         : null,
//       pad('llm   transcript -> 1st sentence', b.llmFirstSentenceMs ?? 0),
//       pad('tts   1st sentence -> 1st audio', ttsMs ?? 0),
//       `  ${'-'.repeat(34)}${'-'.repeat(9)}`,
//       pad('FIRST AUDIO (caller waits this)', firstAudio),
//       '',
//       pad('llm   full completion', b.llmCompleteMs ?? 0),
//       queuedAll !== null ? pad('all segments queued', queuedAll,
//         `${b.segments.length} segment(s)`) : null,
//       pad('whole reply spoken by', heardAll, `${(b.speechMs / 1000).toFixed(1)}s of speech`),
//       b.starvedMs > 100
//         ? pad('  ...of which dead air', b.starvedMs, 'synthesis fell behind playback')
//         : null,
//     ].filter(Boolean);

//     if (b.segments.length) {
//       lines.push('  segments: ' + b.segments
//         .map((sg) => `s${sg.seq} ${sg.chars}ch/${sg.synthMs ?? '?'}ms->${(sg.audioMs / 1000).toFixed(1)}s`)
//         .join('  '));
//     }

//     logger.info(lines.join('\n'));
//     // Kept for inspection (tests, debugging) but detached so the next turn
//     // starts clean and this one cannot be reported twice.
//     this._lastBudget = b;
//     this._budget = null;
//   }

//   finishResponse() {
//     this._reportTurn();
//     this.speaking = false;
//     this.processing = false;
//     this._producerDone = true;

//     this.clearWatchdog();

//     if (this.pendingTranscript) {
//       const next = this.pendingTranscript;
//       const nextArrivedAt = this._pendingArrivedAt;
//       const nextSpeechEndedAt = this._pendingSpeechEndedAt;
//       this.pendingTranscript = null;
//       this._pendingArrivedAt = 0;
//       this._pendingSpeechEndedAt = 0;
//       this._pendingCount = 0;

//       setTimeout(() => {
//         if (this._isDestroyed) return;
//         // Restore this utterance's own timings so the report attributes the
//         // wait to the queue rather than to Sarvam.
//         this._utteranceArrivedAt = nextArrivedAt || 0;
//         this._speechEndedAt = nextSpeechEndedAt || 0;
//         this._handleUtteranceEnd(next);
//       }, 50);
//     } else {
//       this._armSilenceTimer();
//     }
//   }

//   // ── Silence re-prompt ─────────────────────────────────────────────────────

//   /**
//    * Did the agent just ask for something the caller will say in pieces? An
//    * email address is the case that broke: it arrives in several utterances,
//    * and the caller pauses between them to think or to read it off something.
//    */
//   _expectingLongAnswer() {
//     const lastAgent = [...this.turns].reverse().find((x) => x.role === 'agent')?.text ?? '';
//     return /\?/.test(lastAgent) && /ईमेल|ई-मेल|e-?mail|spell|अक्षर|स्पेल/i.test(lastAgent);
//   }

//   _armSilenceTimer() {
//     this._clearSilenceTimer();
//     if (this._isDestroyed || SILENCE_REPROMPT_MS <= 0) return;
//     if (this._reprompts >= MAX_REPROMPTS) return;     // asked enough; do not nag
//     this._silenceTimer = setTimeout(() => this._reprompt(), SILENCE_REPROMPT_MS);
//   }

//   _clearSilenceTimer() {
//     if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
//   }

//   /** The caller went quiet after we spoke. Say something rather than wait. */
//   _reprompt() {
//     this._silenceTimer = null;
//     if (this._isDestroyed || this.processing || this.speaking) return;
//     if (this._utteranceParts.length || this.pendingTranscript || this._carryOver) return;

//     this._reprompts++;
//     const lastAgent = [...this.turns].reverse().find((t) => t.role === 'agent')?.text ?? '';
//     // _convLang is the call's decided language and is always set, so the old
//     // "sniff the last agent line for Devanagari" branch is gone — it could pick
//     // Hindi off a single transliterated word in an otherwise English reply.
//     const hindi = this._convLang === 'hi';

//     // First time: repeat the question they were asked — their answer may simply
//     // have been lost. Second time: just check the line is still there.
//     let text;
//     const question = lastQuestion(lastAgent);
//     if (this._reprompts === 1 && question) {
//       text = hindi ? `माफ़ कीजिए, मैं सुन नहीं पाई। ${question}` : `Sorry, I didn't catch that. ${question}`;
//     } else {
//       text = hindi ? 'क्या आप मुझे सुन पा रहे हैं?' : 'Are you still there?';
//     }

//     logger.info(`[session:${this.callSid}] caller silent ${SILENCE_REPROMPT_MS}ms — re-prompt ${this._reprompts}/${MAX_REPROMPTS}: "${text}"`);
//     this.turns.push({ role: 'agent', text, reprompt: true, at: new Date() });

//     this._beginSpeechTurn();
//     const token = this._turnToken;
//     this.processing = true;
//     this._enqueueSpeech(text, token);
//     this._endSpeechProduction(token);
//   }

//   /**
//    * Guard against a turn that is STUCK — the model never answers, or the
//    * provider never returns the marks that close a turn.
//    *
//    * It used to fire a flat 20s after the turn began, which cannot tell stuck
//    * from long. A 22.9s reply tripped it with ~5s still playing: the session
//    * marked itself not-speaking, barge-in stopped working, and the caller's next
//    * sentence started a second reply on top of the first.
//    *
//    * It is now re-armed whenever audio goes out, to cover that audio plus a
//    * grace period (see _recordSegment). A turn that keeps making progress never
//    * trips it; one that stops does, shortly after its audio should have ended.
//    *
//    * @param {number} [ms] Deadline from now. Defaults to the idle limit.
//    */
//   startWatchdog(ms = WATCHDOG_IDLE_MS) {
//     this.clearWatchdog();
//     this.processingTimer = setTimeout(() => {
//       logger.warn(`[session:${this.callSid}] watchdog unlock — turn made no progress`);
//       this.finishResponse();
//     }, ms);
//   }

//   clearWatchdog() {
//     if (this.processingTimer) {
//       clearTimeout(this.processingTimer);
//       this.processingTimer = null;
//     }
//   }

//   async flush() {
//     // flush() is wired to four independent triggers: the Smartflo `stop` event,
//     // the socket closing, the call-status webhook, and the cleanup cron. They
//     // routinely all fire for one call, and each was re-running persistLeadData
//     // — inflating callCount and rewriting memory several times per call.
//     if (this._flushed) {
//       logger.debug(`[session:${this.callSid}] flush already done — skipping`);
//       return;
//     }
//     this._flushed = true;

//     // This is the only place the call's captured lead reaches durable storage.
//     // Do it before the Log write so a failure there cannot cost us the lead.
//     await persistLeadData(this.phoneNumber, this.leadData);

//     // Built before the Log update so the audio goes in with it. A failure here
//     // must not cost the transcript, so it is caught separately.
//     let recordingDoc = null;
//     try {
//       const rec = this._recorder.save();

//       if (rec?.skipped) {
//         // Too long to store. Keep the metadata so the record still says a
//         // recording was attempted and why there is no audio, rather than an
//         // absence that looks like a bug.
//         recordingDoc = {
//           audioData: null,
//           contentType: null,
//           durationMs: rec.durationMs,
//           bytes: null,
//           skippedReason: rec.reason,
//         };
//         logger.info(`[session:${this.callSid}] recording not stored — ${rec.reason}`);
//       } else if (rec?.buffer) {
//         recordingDoc = {
//           audioData: rec.buffer,
//           contentType: rec.contentType,
//           durationMs: rec.durationMs,
//           bytes: rec.bytes,
//           skippedReason: null,
//         };
//         logger.info(
//           `[session:${this.callSid}] recording stored in DB — ` +
//           `${(rec.bytes / 1048576).toFixed(2)}MB, ${(rec.durationMs / 1000).toFixed(0)}s`
//         );
//       }
//     } catch (err) {
//       logger.error(`[session:${this.callSid}] recording failed: ${err.message}`);
//     }

//     const transcript = this.turns
//       .map((t) => `${t.role === 'user' ? 'caller' : 'agent'}: ${t.text}`)
//       .join('\n');

//     try {
//       await Log.findOneAndUpdate(
//         { callSid: this.callSid },
//         {
//           callSid: this.callSid,
//           phoneNumber: this.phoneNumber,
//           startedAt: new Date(this.startedAt),
//           endedAt: new Date(),
//           durationMs: Date.now() - this.startedAt,
//           turns: this.turns,
//           transcript,
//           ...(recordingDoc ? { recording: recordingDoc } : {}),
//         },
//         { upsert: true, new: true },
//       );

//       logger.info(`[session:${this.callSid}] Flushed ${this.turns.length} turns`);
//     } catch (err) {
//       logger.error(`[session:${this.callSid}] flush=${err.message}`);
//     }
//   }

//   _send(data) {
//     if (this.ws?.readyState !== 1) return;
//     this.ws.send(JSON.stringify(data));

//     // Agent audio is recorded HERE, at the one point every outbound frame
//     // passes — greeting, tool fillers and replies alike. An earlier version
//     // recorded from the speech queue instead, missed the greeting, and never
//     // actually wired up at all: the agent channel came out silent.
//     if (!this._recorder?.enabled) return;

//     if (data.event === 'clear') {
//       // The provider has just discarded everything still buffered. Remove it
//       // from the recording too — the caller never heard it — and restart the
//       // playhead from now.
//       const now = Date.now();
//       this._recorder.truncateAgentAfter(now);
//       this._agentPlaybackHead = now;
//       return;
//     }

//     if (data.event !== 'media' || !data.media?.payload) return;

//     const frame = Buffer.from(data.media.payload, 'base64');
//     // 8 kHz μ-law is 1 byte per sample: 8 bytes = 1 ms.
//     const frameMs = frame.length / 8;

//     // Frames are written far faster than they play, so the playhead runs
//     // ahead of the clock during a burst. If it has fallen BEHIND the clock the
//     // agent was silent in between, and playback of this frame starts now.
//     const now = Date.now();
//     if (!this._agentPlaybackHead || this._agentPlaybackHead < now) {
//       this._agentPlaybackHead = now;
//     }

//     this._recorder.addAgent([frame], this._agentPlaybackHead);
//     this._agentPlaybackHead += frameMs;
//   }

//   destroy() {
//     if (this._isDestroyed) return;

//     this._isDestroyed = true;
//     this.ttsAborted = true;
//     this._turnToken++;
//     this._speechQueue = [];
//     this._pendingMarks.clear();

//     this.clearWatchdog();
//     if (this._bargeInTimer) clearTimeout(this._bargeInTimer);
//     if (this._resumeTimer) clearTimeout(this._resumeTimer);
//     if (this._carryTimer) clearTimeout(this._carryTimer);
//     if (this._silenceTimer) clearTimeout(this._silenceTimer);
//     clearUnheardTurns(this.callSid);
//     if (this._sttRetryTimer) clearTimeout(this._sttRetryTimer);
//     if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
//     this._utteranceParts = [];

//     try {
//       this._sarvamLive?.finish();
//     } catch { }

//     this.removeAllListeners();

//     logger.info(`[session:${this.callSid}] destroyed`);
//   }
// }




// src/services/callSession.js
import { EventEmitter } from 'events';
import {
  createSarvamStream,
  synthesizeToFrames,
  synthesizeStream,
  getCachedFrames,
  framesDurationMs,
} from './speechService.js';

import {
  processMessage,
  hydrateUserProfile,
  leadDataFromProfile,
  persistLeadData,
} from './agentService.js';
import { decodeMulawPayloadToPcm16 } from '../utils/audioUtils.js';
import { createCallRecorder } from '../utils/callRecorder.js';
import { markTurnUnheard, clearUnheardTurns } from '../agents/unheardTurns.js';
import {
  toSpeakable,
  detectLanguage,
  nextReplyLanguage,
} from '../utils/speakable.js';
import { config } from '../config/index.js';

import { Log } from '../models/Log.js';
import { logger } from '../utils/logger.js';

// Inbound: they rang us. Outbound: we rang them, and "thank you for calling"
// would be nonsense — so an outbound call opens by saying who is calling and
// why, which is also what makes it legible rather than alarming.
const GREETING = process.env.GREETING_INBOUND
  || 'Thank you for calling X verse India.';

const GREETING_OUTBOUND = process.env.GREETING_OUTBOUND
  || 'Hello, this is Priya calling from Xverse Technologies.';

/** Outbound and we know who we rang — worth using their name at hello. */
function outboundGreeting(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  if (!first) return GREETING_OUTBOUND;
  return process.env.GREETING_OUTBOUND_NAMED
    ? process.env.GREETING_OUTBOUND_NAMED.replace('{name}', first)
    : `Hello ${first}, this is Priya calling from Xverse Technologies.`;
}

// Greeting audio is cached per phrase for the life of the process. The generic
// line is prewarmed at pickup; the personalised follow-up for a returning
// caller is cached the first time that name calls, and free thereafter.
const greetingCache = new Map();
function getGreetingFrames(text = GREETING) {
  if (!greetingCache.has(text)) {
    greetingCache.set(
      text,
      synthesizeToFrames(text).catch((err) => {
        logger.error(`[greeting] synth failed: ${err.message}`);
        greetingCache.delete(text); // allow a retry on the next call
        return [];
      }),
    );
  }
  return greetingCache.get(text);
}

// How many TTS requests may be in flight for this call at once.
//
// Firing every segment the moment it arrives looked free — synthesis overlaps
// playback either way — but it is not: concurrent requests contend with each
// other at the provider, and the one that suffers is segment 1, which is the
// only one the caller is waiting on. Measured on a 4-segment reply, unbounded
// parallelism pushed time-to-first-audio from ~1s to 6-8s.
//
// Set to 1 after a live call showed the cost is not CPU contention but new
// HTTPS connections: synthesis runs a steady ~26ms/char, but the two jobs that
// were second-in-flight during the first two turns took 121 and 129 ms/char —
// about 4 seconds each — and nothing was slow again once the pool was warm. A
// second concurrent request opens a second TLS connection, and from India that
// handshake costs seconds.
//
// Serial costs nothing: a segment is 1.5-2.5s of audio and the next synthesizes
// in well under a second, so it is always ready before the current one ends.
const TTS_LOOKAHEAD = Number(process.env.TTS_LOOKAHEAD ?? 1);

// Sarvam's VAD sometimes cuts one spoken phrase into several utterances. On a
// live call this booked a meeting under the name "संग" — a 0.48s fragment whose
// START_SPEECH and END_SPEECH were 1.4ms apart — while the caller's actual name
// arrived 1.2s later as a separate turn. The same split an email into
// "सी I S S." and "8703@gmail.com.", and the confirmation went to the wrong
// address.
//
// So a fragment is held briefly to see whether the rest of the phrase follows.
// This does NOT apply to every utterance: anything long enough that ends in
// terminal punctuation is a complete thought and dispatches immediately, so
// most turns pay nothing.
const UTTERANCE_JOIN_MS = Number(process.env.UTTERANCE_JOIN_MS ?? 400);

// How long a COMPLETE-looking sentence waits before being acted on.
//
// UTTERANCE_JOIN_MS above only holds fragments. A long, properly punctuated
// sentence dispatched immediately — which is exactly when a caller is most
// likely still mid-thought, because Sarvam endpoints on a pause rather than on
// meaning. That is why the agent starts talking over people who have not
// finished.
//
// 0 keeps the old behaviour. 300-500 gives the caller room to continue, at the
// cost of that much added latency on every turn.
const UTTERANCE_SETTLE_MS = Number(process.env.UTTERANCE_SETTLE_MS ?? 0);

// Cap on how much gets merged into one turn when a caller asks several things
// in a row, so a long monologue cannot grow the prompt without bound.
const MAX_QUEUED_UTTERANCES = Number(process.env.MAX_QUEUED_UTTERANCES ?? 3);
const MAX_QUEUED_CHARS = Number(process.env.MAX_QUEUED_CHARS ?? 400);

// Sarvam's VAD fires START_SPEECH on brief noise as well as on real speech. On
// a live call two such blips — 25ms and 197ms long, both returning an EMPTY
// transcript — cut the bot off mid-reply, once 0.5s into a 7.2s answer. That is
// the "breaking up" a caller hears.
//
// So a barge-in is now confirmed before acting on it: if END_SPEECH arrives
// within this window, the "speech" was a blip and the reply continues. Real
// speech lasts far longer than this, and the cost of waiting is that the bot
// talks over a genuine interruption for an extra fraction of a second.
const BARGE_IN_CONFIRM_MS = Number(process.env.BARGE_IN_CONFIRM_MS ?? 300);

// How long to wait for more speech when the agent has just asked for an email.
// Addresses are dictated in pieces with pauses; the normal 400ms window cut
// them into separate turns.
const LONG_ANSWER_WAIT_MS = Number(process.env.LONG_ANSWER_WAIT_MS ?? 2000);

// Start-up guards. A profile lookup slower than this is abandoned and the call
// continues without one; a start-up stalled longer than INIT_STALL_MS is logged
// with the step it is stuck on.
const PROFILE_TIMEOUT_MS = Number(process.env.PROFILE_TIMEOUT_MS ?? 4000);
const INIT_STALL_MS = Number(process.env.INIT_STALL_MS ?? 6000);

// If the caller says nothing for this long after the agent finishes speaking,
// ask again. On a live call an answer to "बुक कर दूँ?" never reached the server,
// and caller and agent both waited in silence for 13 seconds. Whatever the
// cause, the agent must not wait forever. Long enough to think, or to spell an
// email: any speech at all resets it.
const SILENCE_REPROMPT_MS = Number(process.env.SILENCE_REPROMPT_MS ?? 8000);
const MAX_REPROMPTS = Number(process.env.MAX_REPROMPTS ?? 2);

// When a reply is dropped because the caller kept talking, how long to wait for
// the rest of their sentence before answering the fragment on its own.
const CARRY_OVER_BACKSTOP_MS = Number(process.env.CARRY_OVER_BACKSTOP_MS ?? 4000);

// Watchdog: how long a turn may go with NO progress before it is force-closed.
// Covers a model that never answers or marks that never come back. It is
// re-armed as audio is sent, so a long reply is never mistaken for a stuck one.
const WATCHDOG_IDLE_MS = Number(process.env.WATCHDOG_IDLE_MS ?? 20_000);
const WATCHDOG_GRACE_MS = Number(process.env.WATCHDOG_GRACE_MS ?? 5_000);

// Reconnect policy for the speech-to-text socket.
const STT_MAX_RETRIES = 4;
const STT_RETRY_BASE_MS = 300;
const FRAGMENT_MAX_CHARS = 25;

/** The final question in a reply — what to repeat if the answer went missing. */
function lastQuestion(text) {
  const sentences = String(text).split(/(?<=[?।.!])\s+/).map((x) => x.trim()).filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i--) {
    if (/\?\s*$/.test(sentences[i])) return sentences[i];
  }
  return null;
}

/** Would acting on this transcript alone be risky? */
function looksLikeFragment(text) {
  const t = (text ?? '').trim();
  if (!t) return true;
  if (t.length < FRAGMENT_MAX_CHARS) return true;
  return !/[.!?।॥]$/.test(t);   // cut off mid-phrase
}

// Note on barge-in: `speaking` goes true the moment a turn opens, which is
// well before any audio reaches the caller (the model still has to generate
// and Sarvam still has to synthesize). A START_SPEECH during that window is
// not an interrupt — there is nothing playing to interrupt, and killing the
// turn would just throw away the answer. The caller's words arrive separately
// via onUtteranceEnd and get queued. So barge-in is gated on _speakingSince,
// which is stamped when the first frame actually goes out.

export class CallSession extends EventEmitter {

  constructor({ callSid, streamSid, accountSid, phoneNumber, toNumber, direction, outbound, ws }) {
    super();

    this.callSid = callSid;
    this.streamSid = streamSid;
    this.accountSid = accountSid ?? null;   // Smartflo sends this on start
    this.phoneNumber = phoneNumber;
    this.toNumber = toNumber ?? null;
    this.direction = direction ?? 'inbound';
    // Set only when the dialer placed this call: { name, rowNumber, refId }.
    // The lead's name comes from the spreadsheet, which is usually better than
    // anything the profile holds for a number that has never called before.
    this.outbound = outbound ?? null;
    this.ws = ws;

    this.userProfile = null;
    this.leadData = {};

    this.processing = false;
    this.speaking = false;
    this.ttsAborted = false;
    this.pendingTranscript = null;

    this.startedAt = Date.now();
    this.turns = [];

    this._isDestroyed = false;
    this._flushed = false;
    this._mediaChunk = 0;   // outbound media.chunk counter, per the Smartflo doc
    this._agentPlaybackHead = 0;   // when the caller will HEAR the next agent frame

    this._recorder = createCallRecorder({
      callSid,
      enabled: config.recording.enabled,
      maxMs: config.recording.maxMs,
    });
    this._sttRetries = 0;
    this._sttRetryTimer = null;
    this._sttGaveUp = false;
    this._sarvamLive = null;

    this.processingTimer = null;

    // ── Speech pipeline state ────────────────────────────────────────────────
    // Incremented on every new turn and on every interrupt. Any queued or
    // in-flight synthesis carrying a stale token is discarded rather than sent,
    // which is what makes barge-in safe while requests are still on the wire.
    this._turnToken = 0;
    this._speechQueue = [];   // [{ token, seq, text, frames: Promise<Buffer[]>|null }]
    this._speechSeq = 0;
    this._inFlightTts = 0;
    this._lastSpokenText = null;
    this._draining = false;
    this._producerDone = true; // "the LLM has finished handing us sentences"
    this._pendingMarks = new Set();
    this._speakingSince = 0;

    // The transcript currently being answered. Sarvam's VAD sometimes cuts a
    // sentence early and then re-emits the whole thing, so we need to know what
    // we are mid-answer on in order to spot the fuller version arriving.
    this._activeTranscript = null;

    // Wall-clock of the last END_SPEECH from Sarvam's VAD. The gap between that
    // and the transcript arriving is pure recognizer latency — invisible to the
    // server until now, and the only part of a turn we were not measuring.
    this._speechEndedAt = 0;

    // Fragments held back waiting to be joined into one utterance.
    this._utteranceParts = [];
    this._utteranceTimer = null;
    this._utteranceArrivedAt = 0;
    this._bargeInTimer = null;
    this._unconfirmedBargeInAt = 0;
    this._resumeTimer = null;
    this._carryOver = null;
    this._carryTimer = null;
    this._silenceTimer = null;
    this._reprompts = 0;
    // The call opens in English, because the greeting is in English. It moves to
    // Hindi only when the caller actually speaks Hindi — never on a guess, and
    // never because the model felt like it.
    this._convLang = 'en';
    this._activeTurnId = null;
    this._pendingArrivedAt = 0;
    this._pendingSpeechEndedAt = 0;
    this._pendingCount = 0;

    this._init();
  }

  async _init() {
    // If start-up stalls, say WHERE. A call once sat silent for 73 seconds with
    // nothing logged between "stream started" and hang-up: no error, because
    // nothing threw — something simply never answered.
    this._initStage = 'starting';
    const stall = setTimeout(() => {
      logger.error(
        `[session:${this.callSid}] start-up STALLED at "${this._initStage}" ` +
        `after ${INIT_STALL_MS}ms — the caller is hearing silence`
      );
    }, INIT_STALL_MS);

    try {
      // Kick the greeting synthesis off immediately; it overlaps the DB read.
      this._initStage = 'greeting synthesis';
      getGreetingFrames();

      // A slow or unreachable database must not stop the call. Past the limit,
      // carry on without a profile — the agent just won't know a returning
      // caller — rather than leave them listening to nothing.
      this._initStage = 'profile lookup (MongoDB)';
      const profile = await Promise.race([
        hydrateUserProfile(this.phoneNumber),
        new Promise((resolve) => setTimeout(() => {
          logger.warn(
            `[session:${this.callSid}] profile lookup took over ${PROFILE_TIMEOUT_MS}ms — ` +
            `continuing without it`
          );
          resolve(null);
        }, PROFILE_TIMEOUT_MS)),
      ]);
      this.userProfile = profile ?? { phoneNumber: this.phoneNumber, degraded: true };

      // Carry what we already know into this call's leadData, so the agent does
      // not ask a returning caller for their name and email all over again.
      // The reducer in state.js merges, so anything extracted this call layers
      // on top of these rather than replacing them.
      this.leadData = leadDataFromProfile(this.userProfile);

      if (this.userProfile?.degraded) {
        logger.warn(
          `[session:${this.callSid}] running WITHOUT a profile — memory and lead ` +
          `capture are degraded for this call`,
        );
      }

      logger.info(`[session:${this.callSid}] initialized`, {
        returning: this.userProfile?.isReturning ?? false,
        known: Object.entries(this.leadData)
          .filter(([, v]) => v)
          .map(([k]) => k),
      });

      this._initStage = 'speech-to-text connection';
      this._openStt();

      this._initStage = 'greeting playback';
      await this._playGreeting();
      this._initStage = 'done';

    } catch (err) {
      logger.error(`[session:${this.callSid}] init failed at "${this._initStage}": ${err.message}`);
    } finally {
      clearTimeout(stall);
    }
  }

  /**
   * Open the speech-to-text socket, and reopen it if it drops mid-call.
   *
   * A dropped socket is silent from the caller's side: they keep talking, we
   * keep sending audio into a closed connection, and nothing ever comes back.
   * Reconnecting matters more than it looks — the alternative is a call that
   * appears live but has stopped listening.
   */
  _openStt() {
    if (this._isDestroyed) return;

    this._sarvamLive = createSarvamStream({

      onOpen: () => {
        this._sttRetries = 0;   // a successful open clears the backoff
        logger.info(`[session:${this.callSid}] Sarvam STT ready`);
      },

      // Barge-in comes from Sarvam's own VAD, not from partial text.
      onSpeechStart: () => {
        this._speechEndedAt = 0;
        this._clearSilenceTimer();
        this._reprompts = 0;

        // Caller is talking again while we hold a fragment, so the phrase is
        // still coming. Push the deadline out rather than acting on half.
        if (this._utteranceTimer) {
          clearTimeout(this._utteranceTimer);
          this._utteranceTimer = setTimeout(
            () => this._flushUtteranceParts(),
            this._expectingLongAnswer() ? LONG_ANSWER_WAIT_MS : UTTERANCE_JOIN_MS,
          );
        }

        // ── Caller kept talking while we were still THINKING ────────────────
        //
        // Sarvam ends a turn on a pause, not on meaning. A caller who pauses
        // mid-sentence ("कल…") gets a turn started for the fragment; if they
        // carry on ("…तीन बजे") while the model is still working, the reply to
        // the fragment — "date and time batao" — then plays OVER them as they
        // give the date and time. Barge-in cannot catch it: nothing is audible
        // yet, so there is nothing to interrupt.
        //
        // So: if they resume before our first word, and it is real speech
        // rather than a VAD blip, drop the half-formed reply and fold the
        // fragment into whatever they say next.
        if (this.processing && !this._speakingSince && this._activeTranscript) {
          if (!this._resumeTimer) {
            this._resumeTimer = setTimeout(() => {
              this._resumeTimer = null;
              if (this._isDestroyed || !this.processing || this._speakingSince) return;
              const carry = this._activeTranscript;
              logger.info(`[session:${this.callSid}] caller kept talking — holding the reply to "${carry}"`);
              this._abandonTurn();
              this._armCarryOver(carry);
            }, BARGE_IN_CONFIRM_MS);
          }
          return;
        }

        if (!this.speaking) return;
        if (!this._speakingSince) return; // nothing audible yet — not an interrupt

        // Do not cut the reply yet — wait to see whether this is real speech.
        if (this._bargeInTimer) return;
        this._bargeInTimer = setTimeout(() => {
          this._bargeInTimer = null;
          if (this._isDestroyed || !this.speaking) return;
          logger.debug(`[session:${this.callSid}] barge-in confirmed`);
          this._handleInterrupt();
        }, BARGE_IN_CONFIRM_MS);
      },

      onSpeechEnd: () => {
        this._speechEndedAt = Date.now();

        // Resumed speech ended inside the confirmation window: a blip, not the
        // caller continuing. Let the reply we were preparing go ahead.
        if (this._resumeTimer) {
          clearTimeout(this._resumeTimer);
          this._resumeTimer = null;
        }

        // Speech ended inside the confirmation window, so on the VAD's account
        // it was a blip. Stand the interrupt down — but remember it happened,
        // because a real transcript landing right after proves the VAD was
        // wrong and the caller genuinely spoke.
        if (this._bargeInTimer) {
          clearTimeout(this._bargeInTimer);
          this._bargeInTimer = null;
          this._unconfirmedBargeInAt = Date.now();
          logger.debug(`[session:${this.callSid}] barge-in held — speech too short to confirm`);
        }
      },

      onTranscript: () => { /* no-op — kept for interface compatibility */ },

      onUtteranceEnd: (text) => this._collectUtterance(text),

      onError: (err) => {
        logger.error(`[session:${this.callSid}] sarvam=${err.message}`);
      },

      onClose: (code) => {
        // 1000 after we called finish() is expected. Anything else mid-call
        // means the socket died and the caller is talking into a void.
        if (this._isDestroyed || code === 1000) return;
        this._reopenStt(code);
      },
    });
  }

  /** Reopen after an unexpected close, backing off so a hard outage does not spin. */
  _reopenStt(code) {
    if (this._isDestroyed) return;
    // A retry is already scheduled; a burst of closes should not stack timers.
    if (this._sttRetryTimer) return;

    this._sttRetries = (this._sttRetries ?? 0) + 1;
    if (this._sttRetries > STT_MAX_RETRIES) {
      // Report the give-up once, not on every subsequent close event.
      if (!this._sttGaveUp) {
        this._sttGaveUp = true;
        logger.error(
          `[session:${this.callSid}] STT dropped (code=${code}) and ${STT_MAX_RETRIES} ` +
          `reconnects failed — this call can no longer hear the caller`,
        );
      }
      return;
    }

    // 300ms, 600ms, 1200ms... Anything already buffered in the old socket is
    // lost either way, so there is nothing to preserve across the gap.
    const delay = STT_RETRY_BASE_MS * 2 ** (this._sttRetries - 1);
    logger.warn(
      `[session:${this.callSid}] STT dropped (code=${code}) — ` +
      `reconnecting in ${delay}ms (attempt ${this._sttRetries}/${STT_MAX_RETRIES})`,
    );

    this._sttRetryTimer = setTimeout(() => {
      this._sttRetryTimer = null;
      if (this._isDestroyed) return;
      try {
        this._sarvamLive?.finish();
      } catch { /* already gone */ }
      this._openStt();
    }, delay);
  }

  pushAudio(base64Payload) {
    if (this._isDestroyed || !this._sarvamLive) return;

    try {
      const pcm = decodeMulawPayloadToPcm16(base64Payload);
      this._recorder.addCaller(pcm);
      this._sarvamLive.send(pcm);
    } catch (err) {
      logger.error(`[session:${this.callSid}] push=${err.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Turn handling
  // ───────────────────────────────────────────────────────────────────────────


  /**
   * Buffer an incoming transcript, joining it with anything held back.
   *
   * A complete-looking sentence goes straight through. A fragment waits
   * UTTERANCE_JOIN_MS for the rest of the phrase, and any further fragment
   * arriving in that window restarts the clock.
   */
  _collectUtterance(text) {
    const t = (text ?? "").trim();
    if (!t) return;   // empty transcripts are VAD noise, never a turn
    this._clearSilenceTimer();
    this._reprompts = 0;

    // Words arrived just after a barge-in we declined to act on. The VAD called
    // the speech too short, but a transcript proves the caller really did talk
    // over us — so confirm it now. Deliberately narrow: this only resolves an
    // interrupt already in question, it never starts one, so the normal
    // queued-transcript path is untouched.
    const pending = this._unconfirmedBargeInAt
      && Date.now() - this._unconfirmedBargeInAt < BARGE_IN_CONFIRM_MS * 2;
    this._unconfirmedBargeInAt = 0;

    if (pending && this.speaking && this._speakingSince) {
      if (this._bargeInTimer) {
        clearTimeout(this._bargeInTimer);
        this._bargeInTimer = null;
      }
      logger.debug(`[session:${this.callSid}] barge-in confirmed by transcript`);
      this._handleInterrupt();
    }

    // Recognizer lag ends here — when Sarvam hands us the text. Anything after
    // this is our own queueing, and conflating the two made a 166ms lag look
    // like 2594ms on a turn that had to wait for the previous reply to finish.
    if (!this._utteranceParts.length) this._utteranceArrivedAt = Date.now();

    this._utteranceParts.push(t);
    if (this._utteranceTimer) clearTimeout(this._utteranceTimer);

    // A complete sentence still waits UTTERANCE_SETTLE_MS (0 by default) so a
    // caller who pauses mid-thought is not talked over; a fragment waits the
    // longer join window for the rest of the phrase.
    const complete = this._utteranceParts.length === 1 && !looksLikeFragment(t);
    // Dictating an email comes out in pieces, with pauses. Treating each pause
    // as the end of the answer made the agent reply after every piece — a live
    // call looped through "मैं ईमेल नहीं समझ पाई" nine times while the caller
    // was mid-way through saying it.
    const wait = this._expectingLongAnswer()
      ? LONG_ANSWER_WAIT_MS
      : complete ? UTTERANCE_SETTLE_MS : UTTERANCE_JOIN_MS;

    if (wait <= 0) {
      this._flushUtteranceParts();
      return;
    }

    logger.debug(
      `[session:${this.callSid}] holding ${complete ? 'utterance' : 'fragment'} ` +
      `"${t}" for ${wait}ms`
    );
    this._utteranceTimer = setTimeout(() => this._flushUtteranceParts(), wait);
  }

  /**
   * Hold a fragment whose reply was dropped because the caller kept talking.
   *
   * Normally it is merged into their next utterance. But if that utterance
   * never produces text — the resumed "speech" was noise and Sarvam returns an
   * empty transcript — the fragment would be stranded and the caller would get
   * no answer at all. The backstop answers it on its own instead.
   */
  _armCarryOver(text) {
    this._carryOver = text;
    if (this._carryTimer) clearTimeout(this._carryTimer);
    this._carryTimer = setTimeout(() => {
      this._carryTimer = null;
      if (this._isDestroyed || !this._carryOver) return;
      if (this.processing || this._utteranceParts.length) return;   // being handled
      const t = this._carryOver;
      this._clearCarryOver();
      logger.info(`[session:${this.callSid}] nothing followed — answering "${t}" on its own`);
      this._dispatchUtterance(t);
    }, CARRY_OVER_BACKSTOP_MS);
  }

  _clearCarryOver() {
    this._carryOver = null;
    if (this._carryTimer) { clearTimeout(this._carryTimer); this._carryTimer = null; }
  }

  /** Join everything held back and hand it over as one utterance. */
  _flushUtteranceParts() {
    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }
    if (!this._utteranceParts.length) return;

    const parts = this._utteranceParts;
    this._utteranceParts = [];
    let joined = parts.join(" ").replace(/\s+/g, " ").trim();

    // Prepend what the caller said BEFORE they paused, if we held a reply to it.
    if (this._carryOver) {
      joined = `${this._carryOver} ${joined}`.replace(/\s+/g, ' ').trim();
      logger.info(`[session:${this.callSid}] merged the held fragment -> "${joined}"`);
      this._clearCarryOver();
    }

    if (parts.length > 1) {
      logger.info(
        `[session:${this.callSid}] joined ${parts.length} fragments -> "${joined}"`,
      );
    }

    this._dispatchUtterance(joined);
  }

  /** Decide whether this utterance runs now, supersedes, or queues. */
  async _dispatchUtterance(text) {
        if (this.processing) {
          // Sarvam re-sent a longer version of the sentence we are already
          // answering. Answering both means replying twice to one utterance,
          // the second time to text the caller has already heard us address.
          if (this._supersedes(text, this._activeTranscript)) {
            logger.info(
              `[session:${this.callSid}] transcript superseded: ` +
              `"${this._activeTranscript}" -> "${text}"`,
            );
            this._abandonTurn();
            await this._handleUtteranceEnd(text);
            return;
          }

          // Same thing, but for a transcript that is only queued, not running.
          if (this._supersedes(text, this.pendingTranscript)) {
            logger.info(`[session:${this.callSid}] queued transcript replaced by fuller one`);
          }
          // Append rather than replace. A single slot meant a caller who asked
          // two things while the agent was talking lost the first one outright
          // — it was silently overwritten and never answered. Merging them into
          // one turn also gets a coherent reply to both, in order, instead of
          // two disconnected ones.
          const parts = this.pendingTranscript ? [this.pendingTranscript, text] : [text];
          const merged = parts.join(' ').replace(/\s+/g, ' ').trim();

          if (this.pendingTranscript
              && (this._pendingCount >= MAX_QUEUED_UTTERANCES || merged.length > MAX_QUEUED_CHARS)) {
            logger.warn(
              `[session:${this.callSid}] queue full — dropping "${text.slice(0, 40)}"`
            );
            return;
          }

          this.pendingTranscript = merged;
          this._pendingCount = (this._pendingCount ?? 0) + 1;

          // Carry the arrival time with it. The queued path calls
          // _handleUtteranceEnd directly, so without this the wait would be
          // charged to the recognizer instead of to us. Keep the EARLIEST
          // arrival — that is when the caller actually started waiting.
          if (!this._pendingArrivedAt) {
            this._pendingArrivedAt = this._utteranceArrivedAt || Date.now();
            this._pendingSpeechEndedAt = this._speechEndedAt;
          }

          logger.info(
            `[session:${this.callSid}] queued transcript` +
            (this._pendingCount > 1 ? ` (merged ${this._pendingCount}: "${merged.slice(0, 60)}")` : '')
          );
          return;
        }
        await this._handleUtteranceEnd(text);
  }

  /**
   * True when `next` is the same utterance as `prev` with more of it captured.
   * Compared on letters and digits only, so punctuation and spacing added by
   * the recognizer on the second pass do not defeat the match.
   */
  _supersedes(next, prev) {
    if (!next || !prev) return false;
    const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const a = norm(prev);
    const b = norm(next);
    return a.length > 0 && b.length > a.length && b.startsWith(a);
  }

  /**
   * Throw away the turn in flight without treating it as a caller interrupt.
   *
   * Deliberately does NOT call finishResponse(), because that would kick off
   * whatever is sitting in pendingTranscript — and the caller of this method is
   * about to start a better turn itself.
   */
  _abandonTurn() {
    // Nothing of this turn reached the caller. Keep it out of what the model
    // sees next, or it believes it asked a question nobody heard.
    if (this._activeTurnId) {
      markTurnUnheard(this.callSid, this._activeTurnId);
      logger.debug(`[session:${this.callSid}] turn ${this._activeTurnId} marked unheard`);
    }
    this.ttsAborted = true;
    this._turnToken++;          // stale synthesis and marks are now rejected
    this._speechQueue = [];
    this._pendingMarks.clear();

    // Only clear the provider's buffer if we had actually started playing something.
    if (this._speakingSince) {
      this._send({ event: 'clear', streamSid: this.streamSid });
    }

    this.speaking = false;
    this.processing = false;
    this._speakingSince = 0;
    this.clearWatchdog();

    // Drop the partial utterance from the transcript log so the call record
    // does not show the caller saying a fragment we then ignored.
    const last = this.turns[this.turns.length - 1];
    if (last?.role === 'user' && last.text === this._activeTranscript) this.turns.pop();
    this._activeTranscript = null;

    // A barge-in or resume check pending on THIS turn must not outlive it.
    // Forgetting the handle without clearing it (as a copied init block here
    // once did) let the timer fire on the NEXT turn and interrupt a reply that
    // had only just started — heard by the caller as the agent going silent.
    if (this._bargeInTimer) { clearTimeout(this._bargeInTimer); this._bargeInTimer = null; }
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    this._unconfirmedBargeInAt = 0;

    // Deliberately NOT cleared: _utteranceParts and its timer. Those hold what
    // the caller is saying right now, which is exactly what the next turn needs.
  }

  async _handleUtteranceEnd(transcript) {
    if (this._isDestroyed || !transcript?.trim()) return;

    this.processing = true;

    const t0 = Date.now();

    // How long Sarvam took to hand us text after it decided the caller had
    // finished. Measured to the transcript ARRIVING, not to this turn starting:
    // a queued turn starts only once the previous reply has finished playing,
    // and that wait is ours, not the recognizer's.
    const arrivedAt = this._utteranceArrivedAt || t0;
    const sttLagMs = this._speechEndedAt ? Math.max(0, arrivedAt - this._speechEndedAt) : null;
    const queuedMs = Math.max(0, t0 - arrivedAt);
    this._speechEndedAt = 0;
    this._utteranceArrivedAt = 0;

    this._turnNo = (this._turnNo ?? 0) + 1;
    this._budget = {
      turnNo: this._turnNo,
      transcript,
      t0,
      sttLagMs,                    // END_SPEECH -> transcript in hand
      queuedMs,                    // transcript in hand -> this turn allowed to run
      firstSegmentQueuedAt: null,  // model produced something speakable
      llmFirstSentenceMs: null,
      llmCompleteMs: null,
      firstAudioAt: null,
      lastSentAt: null,
      speechMs: 0,                 // total audio duration produced
      playbackEndsAt: null,        // wall-clock the caller stops hearing us
      starvedMs: 0,                // silence because synthesis fell behind
      segments: [],                // [{ seq, chars, synthMs, audioMs }]
    };

    logger.info('[LATENCY] ===== New Turn =====');
    if (sttLagMs !== null) {
      logger.info(`[LATENCY] stt.endSpeech->transcript = ${sttLagMs} ms`);
    }
    if (queuedMs > 50) {
      logger.info(`[LATENCY] queued behind previous reply = ${queuedMs} ms`);
    }
    this.startWatchdog();
    logger.info(`[User] ${transcript}`);

    this._activeTranscript = transcript;
    this.turns.push({ role: 'user', text: transcript, timestamp: new Date() });

    // Open a new speech turn BEFORE invoking the model, because sentences will
    // start arriving while graph.invoke() is still awaiting.
    this._beginSpeechTurn(t0);

    // Everything below belongs to THIS turn. If the caller barges in, a new
    // turn takes over and this token goes stale — at which point the still-
    // running processMessage() must not be able to push audio into, or close,
    // the turn that replaced it.
    const myToken = this._turnToken;

    try {
      // The reply language follows the caller, but only on a clear sentence.
      // Letting it follow their LAST message flipped the call on every "Yes."
      // or "जी।". Short replies, names and emails leave it where it is.
      // Every message of this turn is tagged with this id, so if the turn is
      // dropped unheard the model can be kept from believing it happened.
      this._activeTurnId = `${this.callSid}:${myToken}`;

      // English unless the caller speaks Hindi. The old rule was "whatever the
      // last classifiable utterance was", so an English caller who said "How
      // are you?" got a Hindi reply: that utterance classified as nothing, the
      // language stayed unset, and the model chose for itself — leaning Hindi,
      // because its persona and examples are Devanagari.
      //
      // nextReplyLanguage() is asymmetric on purpose: one Devanagari word moves
      // the call to Hindi, while leaving Hindi needs a full English sentence.
      // Acknowledgements ("हाँ", "Yes", "theek hai") move it neither way.
      const before = this._convLang;
      this._convLang = nextReplyLanguage(before, transcript);
      if (this._convLang !== before) {
        logger.info(
          `[session:${this.callSid}] reply language ${before} -> ${this._convLang} ` +
          `("${String(transcript).slice(0, 40)}")`,
        );
      }
      this._callLang = this._convLang;   // voice follows too

      const { response, leadData } = await processMessage(
        this.callSid,
        transcript,
        this.userProfile,
        this.leadData,
        {
          // Called from inside the LangGraph node, mid-generation.
          onSentence: (sentence) => this._enqueueSpeech(sentence, myToken),
          replyLanguage: this._convLang,
          turnId: this._activeTurnId,
        },
      );

      logger.info(`[LATENCY] LLM Total = ${Date.now() - t0} ms`);
      if (this._budget && myToken === this._turnToken) {
        this._budget.llmCompleteMs = Date.now() - t0;
      }

      // A superseding transcript may have arrived while the model was running.
      // Its answer was built from a partial sentence, so drop it rather than
      // logging a reply the caller never heard.
      if (myToken !== this._turnToken) {
        logger.info(`[session:${this.callSid}] turn abandoned — discarding stale response`);
        return;
      }

      this.leadData = leadData;
      this.turns.push({ role: 'agent', text: response, timestamp: new Date() });

    } catch (err) {
      logger.error(`[Brain] ${err.message}`);
      // The call's decided language, not the script of this one transcript. A
      // single Devanagari word in an English call used to be enough to make this
      // apology come out in Hindi.
      this._enqueueSpeech(
        this._convLang === 'hi'
          ? 'माफ़ कीजिए, मैं समझ नहीं पाई। क्या आप दोबारा बता सकते हैं?'
          : 'Sorry, I had trouble understanding. Could you say that again?',
        myToken,
      );
    } finally {
      // No more sentences are coming. The turn ends once the queue has drained
      // and Smartflo has played everything back.
      this._endSpeechProduction(myToken);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Speech pipeline
  //
  // Three things happen concurrently and must not be conflated:
  //   1. the model produces sentences   (_enqueueSpeech)
  //   2. Sarvam synthesizes them        (started eagerly, in parallel)
  //   3. Smartflo plays them back       (strictly ordered, tracked via marks)
  // ───────────────────────────────────────────────────────────────────────────

  _beginSpeechTurn(t0 = null) {
    // Carry the last turn's language forward: a reply made only of times has no
    // language of its own and should sound like the conversation it is in.
    if (this._turnLang) this._callLang = this._turnLang;
    this._turnLang = null;
    this._turnToken++;
    this._speechQueue = [];
    this._speechSeq = 0;
    this._pendingMarks.clear();
    this._producerDone = false;
    this.ttsAborted = false;
    this.speaking = true;
    this._speakingSince = 0;   // set on the first frame actually sent
    this._turnStartedAt = t0;
  }

  /**
   * Accept one speakable segment. Synthesis starts immediately — sentence 2 is
   * already on the wire while sentence 1 is being written to Smartflo.
   */
  _enqueueSpeech(text, token = this._turnToken) {
    if (!text?.trim() || this._isDestroyed) return;
    // Stale producer from an interrupted turn, or this turn was aborted.
    if (token !== this._turnToken || this.ttsAborted) return;

    const seq = this._speechSeq++;

    if (this._budget && this._budget.firstSegmentQueuedAt === null) {
      this._budget.firstSegmentQueuedAt = Date.now();
      this._budget.llmFirstSentenceMs = this._turnStartedAt
        ? Date.now() - this._turnStartedAt
        : null;
    }

    logger.debug(`[session:${this.callSid}] queue seq=${seq} "${text.slice(0, 60)}"`);

    // Queued without frames — _pumpSynthesis decides when it actually starts.
    this._speechQueue.push({
      token, seq, text,
      frames: [],        // fills as bytes arrive
      started: false,
      done: false,
      error: null,
      waiters: [],       // resolved on every progress event
    });
    this._pumpSynthesis();
    this._drain();
  }

  /**
   * Start synthesis for queued segments, oldest first, up to TTS_LOOKAHEAD in
   * flight. Order matters: the head of the queue is always started first, so
   * the segment the caller is waiting on never queues behind a later one.
   */
  _pumpSynthesis() {
    if (this._isDestroyed) return;

    for (const item of this._speechQueue) {
      if (this._inFlightTts >= TTS_LOOKAHEAD) break;
      if (item.started) continue;
      if (item.token !== this._turnToken) continue; // stale turn, never synthesize

      item.started = true;
      const started = Date.now();
      item.synthStartedAt = started;

      // Fixed phrases (greeting, tool fillers) are already in memory. Going
      // over the network for them would add the very delay they exist to hide.
      const cached = getCachedFrames(item.text);
      if (cached) {
        item.frames.push(...cached);
        item.done = true;
        item.synthMs = 0;
        logger.debug(`[session:${this.callSid}] seq=${item.seq} served from phrase cache`);
        const w = item.waiters; item.waiters = [];
        for (const r of w) r();
        continue;
      }

      this._inFlightTts++;

      const wake = () => {
        const w = item.waiters;
        item.waiters = [];
        for (const r of w) r();
      };

      // Splitting a reply into sentences and synthesizing each in isolation
      // loses the prosody that joins them. Handing over the previous segment
      // lets the engine carry intonation across the boundary. Sarvam ignores
      // it; ElevenLabs uses it and does not bill it as speech.
      const previousText = this._speechQueue.find((q) => q.seq === item.seq - 1)?.text
        ?? this._lastSpokenText
        ?? undefined;

      // Times and dates go to the voice in the reply's own language. The model
      // writes "3:00 PM" even mid-Hindi, and AM/PM make the voice switch to
      // English for half a sentence. A segment that is only times ("9:00 AM,
      // 10:00 AM.") has no language of its own, so it inherits the turn's —
      // segments are synthesized strictly in order, so earlier ones set it.
      const lang = detectLanguage(item.text);
      if (lang) this._turnLang = lang;
      // The last fallback was 'hi', which read a times-only segment in Hindi
      // during an English call whose language was not yet established. The call
      // opens with an English greeting, so English is the honest default.
      const spoken = toSpeakable(
        item.text,
        this._turnLang ?? this._callLang ?? this._convLang ?? 'en',
      );
      if (spoken !== item.text) {
        logger.debug(`[session:${this.callSid}] speakable: "${item.text}" -> "${spoken}"`);
      }

      synthesizeStream(spoken, (frames) => {
        if (item.firstFrameMs === undefined) item.firstFrameMs = Date.now() - started;
        item.frames.push(...frames);
        wake();                       // let _drain forward these immediately
      }, { previousText })
        .catch((err) => {
          logger.error(`[session:${this.callSid}] TTS seq=${item.seq}: ${err.message}`);
          item.error = err;
        })
        .finally(() => {
          this._inFlightTts--;
          item.done = true;
          this._lastSpokenText = item.text;
          item.synthMs = Date.now() - started;
          logger.debug(
            `[session:${this.callSid}] tts seq=${item.seq} first=${item.firstFrameMs ?? '?'}ms ` +
            `done=${item.synthMs}ms`
          );
          wake();
          this._pumpSynthesis();
        });
    }
  }

  /** Stamp the moment the caller can first hear us this turn. */
  _markFirstAudio() {
    if (this._speakingSince) return;

    this._speakingSince = Date.now();
    if (this._budget) this._budget.firstAudioAt = this._speakingSince;
    if (!this._turnStartedAt) return;

    const b = this._budget ?? {};
    logger.info(
      `[TURN ${b.turnNo ?? '?'}] stt=${b.sttLagMs ?? '?'}ms ` +
      `llm=${b.llmFirstSentenceMs ?? '?'}ms ` +
      `tts=${this._speakingSince - (b.firstSegmentQueuedAt ?? this._speakingSince)}ms ` +
      `-> first audio ${this._speakingSince - this._turnStartedAt}ms`
    );
  }

  /** Add a delivered segment to this turn's timing report. */
  _recordSegment(item, audioMs) {
    const b = this._budget;
    if (!b || item.token !== this._turnToken) return;

    const now = Date.now();
    // Smartflo plays what it has, then waits. If this segment arrives after
    // everything queued before it has already played out, the caller heard
    // silence in between.
    if (b.playbackEndsAt !== null && now > b.playbackEndsAt) {
      b.starvedMs += now - b.playbackEndsAt;
    }
    b.playbackEndsAt = Math.max(b.playbackEndsAt ?? now, now) + audioMs;

    // This turn just made progress. Push the watchdog out past the end of
    // everything queued, so a long reply is not mistaken for a stuck one.
    this.startWatchdog(Math.max(WATCHDOG_IDLE_MS, b.playbackEndsAt - now + WATCHDOG_GRACE_MS));

    b.lastSentAt = now;
    b.speechMs += audioMs;
    b.segments.push({
      seq: item.seq,
      chars: item.text.length,
      synthMs: item.synthMs ?? null,
      audioMs,
    });
  }

  /** Resolves the next time `item` gains frames or finishes. */
  _awaitProgress(item) {
    if (item.done) return Promise.resolve();
    return new Promise((resolve) => item.waiters.push(resolve));
  }

  /** Called once the model has no more sentences for the given turn. */
  _endSpeechProduction(token = this._turnToken) {
    if (token !== this._turnToken) return; // superseded; not ours to close
    this._producerDone = true;
    this._maybeFinishTurn();
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;

    try {
      while (this._speechQueue.length) {
        // Peek first: the head must have its synthesis started before we commit
        // to removing it.
        const head = this._speechQueue[0];
        if (!head.started) {
          this._pumpSynthesis();
          // _pumpSynthesis always starts the head first, so this should never
          // hold. If it somehow does, back out and let a completing request
          // re-enter through its finally hook rather than spinning.
          if (!head.started) break;
        }

        // Forward frames AS THEY ARRIVE rather than waiting for the whole
        // sentence. This is the point of the streaming endpoint: on the
        // measured network the first bytes land ~480ms before the last ones.
        let sent = 0;
        let audioMs = 0;

        for (;;) {
          while (sent < head.frames.length) {
            if (this._isDestroyed || this.ttsAborted || head.token !== this._turnToken) break;

            const frame = head.frames[sent++];
            this._markFirstAudio();
            // The doc's outbound media example includes an incrementing
            // `chunk`. Twilio has no such field, so it was absent before.
            this._send({
              event: 'media',
              streamSid: this.streamSid,
              media: { payload: frame.toString('base64'), chunk: ++this._mediaChunk },
            });
            audioMs += 20;
          }

          if (head.done) break;
          if (this._isDestroyed || this.ttsAborted || head.token !== this._turnToken) break;
          await this._awaitProgress(head);
        }

        this._speechQueue.shift();

        // Interrupted, destroyed, or belongs to a turn we already abandoned.
        if (this._isDestroyed || this.ttsAborted || head.token !== this._turnToken) continue;
        if (audioMs === 0) continue;

        this._recordSegment(head, audioMs);

        // Smartflo echoes this back only after the preceding audio has actually
        // been played out. Without it we would clear `speaking` the instant the
        // frames were written to the socket — seconds before the caller hears
        // them — which breaks both barge-in and the queued-transcript handoff.
        const markName = `t${head.token}-s${head.seq}`;
        this._pendingMarks.add(markName);
        this._send({
          event: 'mark',
          streamSid: this.streamSid,
          mark: { name: markName },
        });

        logger.debug(`[session:${this.callSid}] sent seq=${head.seq} (${audioMs}ms audio)`);
      }
    } finally {
      this._draining = false;
      this._maybeFinishTurn();
    }
  }

  /** Smartflo has finished playing everything up to this mark. */
  onMark(name) {
    if (!name) return;

    // Marks from an interrupted turn may still arrive; ignore them so they
    // cannot prematurely end the turn that replaced it.
    const token = Number(String(name).match(/^t(\d+)-/)?.[1]);
    if (token !== this._turnToken) return;

    this._pendingMarks.delete(name);
    this._maybeFinishTurn();
  }

  _maybeFinishTurn() {
    if (this._isDestroyed) return;
    if (!this._producerDone) return;       // model still generating
    if (this._draining) return;            // still writing to the socket
    if (this._speechQueue.length) return;  // more synthesis waiting
    if (this._pendingMarks.size) return;   // audio still playing out

    this.finishResponse();
  }

  _handleInterrupt() {
    if (!this.speaking) return;

    logger.info(`[session:${this.callSid}] interrupted`);

    this.ttsAborted = true;
    this.speaking = false;

    // Invalidate everything queued or in flight for the current turn.
    this._turnToken++;
    this._speechQueue = [];
    this._pendingMarks.clear();

    // Drops the provider's buffered audio. Smartflo differs from Twilio here:
    // it REPLIES with the marks for the audio it just discarded. Those arrive
    // carrying the old turn token and are rejected by onMark, which is why the
    // pending set is emptied rather than waited on.
    this._send({ event: 'clear', streamSid: this.streamSid });

    this.finishResponse();
  }

  async _playGreeting() {
    this._beginSpeechTurn();

    // On an outbound call the lead's name comes from the spreadsheet row, so it
    // is available at hello even for a number that has never called before.
    const lines = this.outbound
      ? [outboundGreeting(this.outbound.name || this.userProfile?.name)]
      : [GREETING];

    // ~2s of cached greeting plays first, which is more than enough time to
    // synthesize this second line. Zero added latency at pickup.
    const name = this.userProfile?.name;
    if (this.outbound) {
      // We rang them, so say why in the same breath — then hand over. Without
      // this the caller hears a name and a company and no reason for the call.
      lines.push(
        process.env.OUTBOUND_OPENER
        || 'Do you have a minute to talk about how our AI products could help your business?',
      );
    } else if (name && this.userProfile?.isReturning) {
      lines.push(`Welcome back, ${name}.`);
    }

    for (const text of lines) {
      // The greeting comes from the module-level cache rather than the network,
      // but it has to present the same progressive shape the drain loop expects.
      const item = {
        token: this._turnToken,
        seq: this._speechSeq++,
        text,
        frames: [],
        started: true,
        done: false,
        error: null,
        waiters: [],
      };
      this._speechQueue.push(item);

      getGreetingFrames(text)
        .then((frames) => { item.frames.push(...frames); })
        .catch((err) => { item.error = err; })
        .finally(() => {
          item.done = true;
          const waiters = item.waiters;
          item.waiters = [];
          for (const resolve of waiters) resolve();
        });
    }

    this._drain();
    this._endSpeechProduction();
  }

  /**
   * Print the full timing breakdown for the turn that just ended.
   *
   * Emitted here rather than at first-audio because only now is everything
   * known: how many segments there were, how long each took to synthesize, and
   * when Smartflo finished playing the last one.
   *
   * The four rows above the line sum to first-audio. Everything below it
   * describes the rest of the reply, which the caller hears while the pipeline
   * has already gone idle.
   */
  _reportTurn() {
    const b = this._budget;
    if (!b || !b.t0 || !b.firstAudioAt) return;   // greeting or aborted turn

    const pad = (label, ms, note = '') =>
      `  ${label.padEnd(34)}${String(Math.round(ms)).padStart(6)} ms${note ? '  ' + note : ''}`;

    const firstAudio = b.firstAudioAt - b.t0;
    const ttsMs = b.firstSegmentQueuedAt ? b.firstAudioAt - b.firstSegmentQueuedAt : null;
    const queuedAll = b.lastSentAt ? b.lastSentAt - b.t0 : null;
    // Derived from actual send times, so mid-reply silence is counted rather
    // than assumed away.
    const heardAll = b.playbackEndsAt ? b.playbackEndsAt - b.t0 : firstAudio + b.speechMs;

    const lines = [
      `[TURN ${b.turnNo}] "${String(b.transcript).slice(0, 48)}"`,
      pad('stt   end-of-speech -> transcript', b.sttLagMs ?? 0,
        b.sttLagMs === null ? '(no END_SPEECH seen)' : ''),
      // Only shown when it happened: the caller had already finished speaking,
      // but we were still playing the previous reply.
      b.queuedMs > 50
        ? pad('      ...then queued', b.queuedMs, 'waiting for the previous reply to finish')
        : null,
      pad('llm   transcript -> 1st sentence', b.llmFirstSentenceMs ?? 0),
      pad('tts   1st sentence -> 1st audio', ttsMs ?? 0),
      `  ${'-'.repeat(34)}${'-'.repeat(9)}`,
      pad('FIRST AUDIO (caller waits this)', firstAudio),
      '',
      pad('llm   full completion', b.llmCompleteMs ?? 0),
      queuedAll !== null ? pad('all segments queued', queuedAll,
        `${b.segments.length} segment(s)`) : null,
      pad('whole reply spoken by', heardAll, `${(b.speechMs / 1000).toFixed(1)}s of speech`),
      b.starvedMs > 100
        ? pad('  ...of which dead air', b.starvedMs, 'synthesis fell behind playback')
        : null,
    ].filter(Boolean);

    if (b.segments.length) {
      lines.push('  segments: ' + b.segments
        .map((sg) => `s${sg.seq} ${sg.chars}ch/${sg.synthMs ?? '?'}ms->${(sg.audioMs / 1000).toFixed(1)}s`)
        .join('  '));
    }

    logger.info(lines.join('\n'));
    // Kept for inspection (tests, debugging) but detached so the next turn
    // starts clean and this one cannot be reported twice.
    this._lastBudget = b;
    this._budget = null;
  }

  finishResponse() {
    this._reportTurn();
    this.speaking = false;
    this.processing = false;
    this._producerDone = true;

    this.clearWatchdog();

    if (this.pendingTranscript) {
      const next = this.pendingTranscript;
      const nextArrivedAt = this._pendingArrivedAt;
      const nextSpeechEndedAt = this._pendingSpeechEndedAt;
      this.pendingTranscript = null;
      this._pendingArrivedAt = 0;
      this._pendingSpeechEndedAt = 0;
      this._pendingCount = 0;

      setTimeout(() => {
        if (this._isDestroyed) return;
        // Restore this utterance's own timings so the report attributes the
        // wait to the queue rather than to Sarvam.
        this._utteranceArrivedAt = nextArrivedAt || 0;
        this._speechEndedAt = nextSpeechEndedAt || 0;
        this._handleUtteranceEnd(next);
      }, 50);
    } else {
      this._armSilenceTimer();
    }
  }

  // ── Silence re-prompt ─────────────────────────────────────────────────────

  /**
   * Did the agent just ask for something the caller will say in pieces? An
   * email address is the case that broke: it arrives in several utterances,
   * and the caller pauses between them to think or to read it off something.
   */
  _expectingLongAnswer() {
    const lastAgent = [...this.turns].reverse().find((x) => x.role === 'agent')?.text ?? '';
    return /\?/.test(lastAgent) && /ईमेल|ई-मेल|e-?mail|spell|अक्षर|स्पेल/i.test(lastAgent);
  }

  _armSilenceTimer() {
    this._clearSilenceTimer();
    if (this._isDestroyed || SILENCE_REPROMPT_MS <= 0) return;
    if (this._reprompts >= MAX_REPROMPTS) return;     // asked enough; do not nag
    this._silenceTimer = setTimeout(() => this._reprompt(), SILENCE_REPROMPT_MS);
  }

  _clearSilenceTimer() {
    if (this._silenceTimer) { clearTimeout(this._silenceTimer); this._silenceTimer = null; }
  }

  /** The caller went quiet after we spoke. Say something rather than wait. */
  _reprompt() {
    this._silenceTimer = null;
    if (this._isDestroyed || this.processing || this.speaking) return;
    if (this._utteranceParts.length || this.pendingTranscript || this._carryOver) return;

    this._reprompts++;
    const lastAgent = [...this.turns].reverse().find((t) => t.role === 'agent')?.text ?? '';
    // _convLang is the call's decided language and is always set, so the old
    // "sniff the last agent line for Devanagari" branch is gone — it could pick
    // Hindi off a single transliterated word in an otherwise English reply.
    const hindi = this._convLang === 'hi';

    // First time: repeat the question they were asked — their answer may simply
    // have been lost. Second time: just check the line is still there.
    let text;
    const question = lastQuestion(lastAgent);
    if (this._reprompts === 1 && question) {
      text = hindi ? `माफ़ कीजिए, मैं सुन नहीं पाई। ${question}` : `Sorry, I didn't catch that. ${question}`;
    } else {
      text = hindi ? 'क्या आप मुझे सुन पा रहे हैं?' : 'Are you still there?';
    }

    logger.info(`[session:${this.callSid}] caller silent ${SILENCE_REPROMPT_MS}ms — re-prompt ${this._reprompts}/${MAX_REPROMPTS}: "${text}"`);
    this.turns.push({ role: 'agent', text, reprompt: true, at: new Date() });

    this._beginSpeechTurn();
    const token = this._turnToken;
    this.processing = true;
    this._enqueueSpeech(text, token);
    this._endSpeechProduction(token);
  }

  /**
   * Guard against a turn that is STUCK — the model never answers, or the
   * provider never returns the marks that close a turn.
   *
   * It used to fire a flat 20s after the turn began, which cannot tell stuck
   * from long. A 22.9s reply tripped it with ~5s still playing: the session
   * marked itself not-speaking, barge-in stopped working, and the caller's next
   * sentence started a second reply on top of the first.
   *
   * It is now re-armed whenever audio goes out, to cover that audio plus a
   * grace period (see _recordSegment). A turn that keeps making progress never
   * trips it; one that stops does, shortly after its audio should have ended.
   *
   * @param {number} [ms] Deadline from now. Defaults to the idle limit.
   */
  startWatchdog(ms = WATCHDOG_IDLE_MS) {
    this.clearWatchdog();
    this.processingTimer = setTimeout(() => {
      logger.warn(`[session:${this.callSid}] watchdog unlock — turn made no progress`);
      this.finishResponse();
    }, ms);
  }

  clearWatchdog() {
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
  }

  async flush() {
    // flush() is wired to four independent triggers: the Smartflo `stop` event,
    // the socket closing, the call-status webhook, and the cleanup cron. They
    // routinely all fire for one call, and each was re-running persistLeadData
    // — inflating callCount and rewriting memory several times per call.
    if (this._flushed) {
      logger.debug(`[session:${this.callSid}] flush already done — skipping`);
      return;
    }
    this._flushed = true;

    // This is the only place the call's captured lead reaches durable storage.
    // Do it before the Log write so a failure there cannot cost us the lead.
    await persistLeadData(this.phoneNumber, this.leadData);

    // Built before the Log update so the audio goes in with it. A failure here
    // must not cost the transcript, so it is caught separately.
    let recordingDoc = null;
    try {
      const rec = this._recorder.save();

      if (rec?.skipped) {
        // Too long to store. Keep the metadata so the record still says a
        // recording was attempted and why there is no audio, rather than an
        // absence that looks like a bug.
        recordingDoc = {
          audioData: null,
          contentType: null,
          durationMs: rec.durationMs,
          bytes: null,
          skippedReason: rec.reason,
        };
        logger.info(`[session:${this.callSid}] recording not stored — ${rec.reason}`);
      } else if (rec?.buffer) {
        recordingDoc = {
          audioData: rec.buffer,
          contentType: rec.contentType,
          durationMs: rec.durationMs,
          bytes: rec.bytes,
          skippedReason: null,
        };
        logger.info(
          `[session:${this.callSid}] recording stored in DB — ` +
          `${(rec.bytes / 1048576).toFixed(2)}MB, ${(rec.durationMs / 1000).toFixed(0)}s`
        );
      }
    } catch (err) {
      logger.error(`[session:${this.callSid}] recording failed: ${err.message}`);
    }

    const transcript = this.turns
      .map((t) => `${t.role === 'user' ? 'caller' : 'agent'}: ${t.text}`)
      .join('\n');

    try {
      await Log.findOneAndUpdate(
        { callSid: this.callSid },
        {
          callSid: this.callSid,
          phoneNumber: this.phoneNumber,
          startedAt: new Date(this.startedAt),
          endedAt: new Date(),
          durationMs: Date.now() - this.startedAt,
          turns: this.turns,
          transcript,
          ...(recordingDoc ? { recording: recordingDoc } : {}),
        },
        { upsert: true, new: true },
      );

      logger.info(`[session:${this.callSid}] Flushed ${this.turns.length} turns`);
    } catch (err) {
      logger.error(`[session:${this.callSid}] flush=${err.message}`);
    }
  }

  _send(data) {
    if (this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify(data));

    // Agent audio is recorded HERE, at the one point every outbound frame
    // passes — greeting, tool fillers and replies alike. An earlier version
    // recorded from the speech queue instead, missed the greeting, and never
    // actually wired up at all: the agent channel came out silent.
    if (!this._recorder?.enabled) return;

    if (data.event === 'clear') {
      // The provider has just discarded everything still buffered. Remove it
      // from the recording too — the caller never heard it — and restart the
      // playhead from now.
      const now = Date.now();
      this._recorder.truncateAgentAfter(now);
      this._agentPlaybackHead = now;
      return;
    }

    if (data.event !== 'media' || !data.media?.payload) return;

    const frame = Buffer.from(data.media.payload, 'base64');
    // 8 kHz μ-law is 1 byte per sample: 8 bytes = 1 ms.
    const frameMs = frame.length / 8;

    // Frames are written far faster than they play, so the playhead runs
    // ahead of the clock during a burst. If it has fallen BEHIND the clock the
    // agent was silent in between, and playback of this frame starts now.
    const now = Date.now();
    if (!this._agentPlaybackHead || this._agentPlaybackHead < now) {
      this._agentPlaybackHead = now;
    }

    this._recorder.addAgent([frame], this._agentPlaybackHead);
    this._agentPlaybackHead += frameMs;
  }

  destroy() {
    if (this._isDestroyed) return;

    this._isDestroyed = true;
    this.ttsAborted = true;
    this._turnToken++;
    this._speechQueue = [];
    this._pendingMarks.clear();

    this.clearWatchdog();
    if (this._bargeInTimer) clearTimeout(this._bargeInTimer);
    if (this._resumeTimer) clearTimeout(this._resumeTimer);
    if (this._carryTimer) clearTimeout(this._carryTimer);
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    clearUnheardTurns(this.callSid);
    if (this._sttRetryTimer) clearTimeout(this._sttRetryTimer);
    if (this._utteranceTimer) clearTimeout(this._utteranceTimer);
    this._utteranceParts = [];

    try {
      this._sarvamLive?.finish();
    } catch { }

    this.removeAllListeners();

    logger.info(`[session:${this.callSid}] destroyed`);
  }
}