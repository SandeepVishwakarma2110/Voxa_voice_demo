// // src/services/speechService.js
// //
// // Sarvam for speech-to-text, ElevenLabs for text-to-speech.
// //
// // Audio is μ-law 8 kHz end to end — Smartflo's native format — so nothing is
// // transcoded in either direction. No ffmpeg, no resampling.

// import WebSocket from 'ws';
// import { config } from '../config/index.js';
// import { logger } from '../utils/logger.js';

// const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';
// const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 8000);

// // ElevenLabs routes each request to one of several regions. Logged once per
// // process, because a distant region is a fixed tax on every call.
// let elevenRegionLogged = false;
// // Smartflo requires each outbound media payload to be at least 160 bytes and a
// // multiple of 160, or playback develops audible gaps.
// const FRAME_BYTES = 160;   // 20 ms of 8 kHz μ-law

// // ─────────────────────────────────────────────
// // Speech-to-text (Sarvam streaming websocket)
// // ─────────────────────────────────────────────

// // 8 kHz PCM16 mono = 16,000 bytes/sec, so 1600 bytes = 100 ms.
// //
// // This was 3200 (200 ms) because Twilio delivers 20 ms frames and batching cut
// // websocket volume 10x. Smartflo delivers every 100 ms — already batched — so
// // a 200 ms threshold made every second chunk sit in the buffer waiting for a
// // partner, adding up to 100 ms before Sarvam even hears the audio. Matching
// // the provider's cadence forwards each chunk on arrival at no extra cost in
// // message volume.
// const STT_CHUNK_BYTES = Number(process.env.STT_CHUNK_BYTES ?? 1600);

// // Fallback path only. Sarvam's per-message `audio.encoding` is an enum whose
// // only value is 'audio/wav'. Raw PCM is declared on the connection URL via
// // input_audio_codec, and `encoding` is omitted entirely. If the server ever
// // starts rejecting messages for a *missing* encoding field, flip this to true.
// const SEND_WAV_HEADER = true;

// // ─────────────────────────────────────────────
// // WAV header (fallback only)
// // ─────────────────────────────────────────────

// function wavHeader(dataLen, sampleRate = 8000, channels = 1, bits = 16) {
//   const h = Buffer.alloc(44);
//   const byteRate = sampleRate * channels * (bits / 8);
//   const blockAlign = channels * (bits / 8);

//   h.write('RIFF', 0);
//   h.writeUInt32LE(36 + dataLen, 4);
//   h.write('WAVE', 8);
//   h.write('fmt ', 12);
//   h.writeUInt32LE(16, 16);
//   h.writeUInt16LE(1, 20);
//   h.writeUInt16LE(channels, 22);
//   h.writeUInt32LE(sampleRate, 24);
//   h.writeUInt32LE(byteRate, 28);
//   h.writeUInt16LE(blockAlign, 32);
//   h.writeUInt16LE(bits, 34);
//   h.write('data', 36);
//   h.writeUInt32LE(dataLen, 40);
//   return h;
// }

// // ─────────────────────────────────────────────
// // Sarvam STT (streaming WebSocket)
// // ─────────────────────────────────────────────

// export function createSarvamStream({
//   onOpen,
//   onTranscript,
//   onUtteranceEnd,
//   onSpeechStart,
//   onSpeechEnd,
//   onError,
//   onClose,
// } = {}) {
//   const sampleRate = String(config.sarvam.stt.sampleRate || 8000);

//   // Connection params are snake_case. `input_audio_codec` is REQUIRED when
//   // streaming headerless PCM.
//   const params = new URLSearchParams({
//     model: config.sarvam.stt.model || 'saaras:v3',
//     language_code: config.sarvam.stt.language || 'hi-IN',
//     mode: config.sarvam.stt.mode || 'codemix',
//     sample_rate: sampleRate,
//     input_audio_codec: 'pcm_s16le',
//     high_vad_sensitivity: 'true',
//     vad_signals: 'true',
//   });

//   const url = `wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`;

//   const ws = new WebSocket(url, {
//     headers: { 'api-subscription-key': config.sarvam.apiKey },
//   });

//   let closed = false;
//   let pending = [];
//   let pendingBytes = 0;

//   const flushPending = () => {
//     if (!pendingBytes || ws.readyState !== WebSocket.OPEN) return;

//     let chunk = Buffer.concat(pending, pendingBytes);
//     pending = [];
//     pendingBytes = 0;

//     const audio = { data: null, sample_rate: sampleRate };

//     if (SEND_WAV_HEADER) {
//       chunk = Buffer.concat([wavHeader(chunk.length, Number(sampleRate)), chunk]);
//       audio.encoding = 'audio/wav';
//     }

//     audio.data = chunk.toString('base64');

//     try {
//       ws.send(JSON.stringify({ audio }));
//     } catch (err) {
//       logger.error(`[sarvam-stt] send=${err.message}`);
//     }
//   };

//   ws.on('open', () => {
//     logger.info('[sarvam-stt] WebSocket open');
//     onOpen?.();
//   });

//   // Catches HTTP-level handshake failures: 401 bad key, 403 quota, 404 bad path.
//   ws.on('unexpected-response', (_req, res) => {
//     let body = '';
//     res.on('data', (d) => { body += d; });
//     res.on('end', () => {
//       logger.error(`[sarvam-stt] handshake ${res.statusCode} ${body.slice(0, 400)}`);
//       onError?.(new Error(`handshake ${res.statusCode}`));
//     });
//   });

//   ws.on('message', (raw) => {
//     let msg;
//     try {
//       msg = JSON.parse(raw.toString());
//     } catch (err) {
//       logger.error(`[sarvam-stt] parse=${err.message} raw=${raw.toString().slice(0, 200)}`);
//       return;
//     }

//     // Drop this line once the stream is behaving.
//     logger.debug(`[sarvam-stt] <- ${JSON.stringify(msg).slice(0, 300)}`);

//     switch (msg.type) {
//       case 'events': {
//         const signal = msg.data?.signal_type;
//         if (signal === 'START_SPEECH') onSpeechStart?.();
//         else if (signal === 'END_SPEECH') onSpeechEnd?.();
//         return;
//       }

//       case 'error': {
//         const detail = msg.data?.message || JSON.stringify(msg.data || msg);
//         logger.error(`[sarvam-stt] server error: ${detail}`);
//         onError?.(new Error(detail));
//         return;
//       }

//       case 'data': {
//         const transcript = (msg.data?.transcript || '').trim();
//         if (!transcript) return;

//         // There is no `is_final` on this API. Sarvam runs VAD server-side and
//         // only emits a `data` message once an utterance is complete, so every
//         // one of these IS final.
//         logger.info(`[sarvam-stt] utterance="${transcript}"`);
//         onTranscript?.(transcript, true);
//         onUtteranceEnd?.(transcript);
//         return;
//       }

//       default:
//         return;
//     }
//   });

//   ws.on('error', (err) => {
//     logger.error(`[sarvam-stt] ${err.message}`);
//     onError?.(err);
//   });

//   ws.on('close', (code, reason) => {
//     closed = true;
//     pending = [];
//     pendingBytes = 0;
//     const reasonStr = reason?.length ? reason.toString() : '(no reason)';
//     // 1000 is a normal closure — what the server sends after finish(). Logging
//     // it at warn made every clean shutdown look like a fault.
//     if (code === 1000) {
//       logger.debug(`[sarvam-stt] closed cleanly (code 1000)`);
//     } else {
//       logger.warn(`[sarvam-stt] closed unexpectedly | code=${code} | reason=${reasonStr}`);
//     }
//     onClose?.(code, reasonStr);
//   });

//   return {
//     send: (pcm16Buffer) => {
//       if (closed || !pcm16Buffer?.length) return;
//       pending.push(pcm16Buffer);
//       pendingBytes += pcm16Buffer.length;
//       if (pendingBytes >= STT_CHUNK_BYTES) flushPending();
//     },
//     close: () => {
//       if (ws.readyState === WebSocket.OPEN) {
//         flushPending();
//         ws.close(1000);
//       }
//     },
//     finish: () => {
//       if (ws.readyState === WebSocket.OPEN) {
//         flushPending();
//         ws.close(1000);
//       }
//     },
//     get isOpen() {
//       return ws.readyState === WebSocket.OPEN;
//     },
//   };
// }

// // ─────────────────────────────────────────────
// // Warm-up
// // ─────────────────────────────────────────────

// /**
//  * Open the connection to ElevenLabs before the first caller arrives.
//  *
//  * Measured cold: 543-816 ms to first audio, against ~210 ms warm. Without this
//  * the first caller of the process pays the DNS and TLS setup.
//  */
// export async function warmTTS() {
//   try {
//     await fetch(`${ELEVEN_BASE}/models`, {
//       headers: { 'xi-api-key': config.elevenlabs.apiKey },
//     });
//     logger.info(`[elevenlabs] Connection warmed (${config.elevenlabs.model})`);
//   } catch (err) {
//     // An optimisation, never a startup dependency.
//     logger.warn(`[elevenlabs] warm-up failed (harmless): ${err.message}`);
//   }
// }

// // ─────────────────────────────────────────────
// // Text-to-speech (ElevenLabs)
// // ─────────────────────────────────────────────

// /**
//  * Cuts a byte stream into exact 160-byte μ-law frames.
//  *
//  * The provider may or may not prefix a RIFF header, and chunk boundaries fall
//  * wherever the network puts them, so this holds a remainder between pushes and
//  * only ever emits whole frames.
//  */
// export function createMulawFramer() {
//   let containerChecked = false;
//   let buf = Buffer.alloc(0);

//   return {
//     /** @returns {Buffer[]} whole frames available so far */
//     push(chunk) {
//       buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

//       if (!containerChecked) {
//         if (buf.length < 4) return [];
//         if (buf.toString('ascii', 0, 4) === 'RIFF') {
//           const at = buf.indexOf('data', 0, 'ascii');
//           if (at < 0) return [];              // header spans more chunks
//           buf = buf.subarray(at + 8);         // skip 'data' + size field
//         }
//         containerChecked = true;
//       }

//       const whole = Math.floor(buf.length / FRAME_BYTES);
//       if (whole === 0) return [];

//       const out = [];
//       for (let i = 0; i < whole; i++) {
//         // Copy rather than view, so the frames do not pin the whole stream
//         // buffer in memory for the life of the call.
//         out.push(Buffer.from(buf.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)));
//       }
//       buf = buf.subarray(whole * FRAME_BYTES);
//       return out;
//     },

//     /** Pad any trailing partial frame with μ-law silence. */
//     flush() {
//       if (!buf.length) return [];
//       const last = Buffer.alloc(FRAME_BYTES, 0xff);
//       buf.copy(last);
//       buf = Buffer.alloc(0);
//       return [last];
//     },
//   };
// }

// function elevenVoiceSettings() {
//   const { stability, similarityBoost, speed } = config.elevenlabs;
//   const vs = {};
//   if (stability !== null) vs.stability = stability;
//   if (similarityBoost !== null) vs.similarity_boost = similarityBoost;
//   if (speed !== null) vs.speed = speed;
//   return Object.keys(vs).length ? vs : undefined;
// }

// /**
//  * @param {string} text
//  * @param {(frames: Buffer[]) => void} onFrames
//  * @param {object} [opts]
//  * @param {string} [opts.previousText] The segment spoken immediately before.
//  *        Splitting a reply into sentences and synthesizing each in isolation
//  *        loses the prosody that connects them; ElevenLabs uses this for
//  *        continuity across chunks. Costs nothing and is not billed as speech.
//  */
// async function elevenLabsStreamSynth(text, onFrames, { previousText } = {}) {
//   const { apiKey, voiceId, model, languageCode } = config.elevenlabs;
//   if (!apiKey || !voiceId) {
//     throw new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set');
//   }

//   const tStart = Date.now();
//   const body = {
//     text,
//     model_id: model,
//     language_code: languageCode || undefined,
//     previous_text: previousText || undefined,
//   };
//   const vs = elevenVoiceSettings();
//   if (vs) body.voice_settings = vs;

//   const res = await fetch(
//     `${ELEVEN_BASE}/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
//     {
//       method: 'POST',
//       headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
//       body: JSON.stringify(body),
//       // Without this a request that never answers waits forever, and the
//       // caller hears silence with nothing in the log to say why. Covers the
//       // whole response, body included; a normal sentence finishes in <1s.
//       signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
//     },
//   );

//   if (!res.ok || !res.body) {
//     const detail = res.ok ? 'no response body' : (await res.text()).slice(0, 200);
//     const err = new Error(`elevenlabs ${res.status}: ${detail}`);
//     err.status = res.status;
//     throw err;
//   }

//   // ElevenLabs routes each request to one of several regions. A distant region
//   // is a fixed tax on every call and is otherwise invisible.
//   if (!elevenRegionLogged) {
//     elevenRegionLogged = true;
//     const region = res.headers.get('x-region');
//     if (region) logger.info(`[elevenlabs] serving region: ${region}`);
//   }

//   const framer = createMulawFramer();
//   let total = 0;
//   let firstAudioMs = null;

//   for await (const chunk of res.body) {
//     const frames = framer.push(Buffer.from(chunk));
//     if (!frames.length) continue;
//     if (firstAudioMs === null) {
//       firstAudioMs = Date.now() - tStart;
//       logger.info(`[LATENCY] tts.firstAudio = ${firstAudioMs} ms (${text.length} chars, elevenlabs)`);
//     }
//     total += frames.length;
//     onFrames(frames);
//   }

//   const tail = framer.flush();
//   if (tail.length) { total += tail.length; onFrames(tail); }

//   logger.info(
//     `[LATENCY] tts.streamTotal = ${Date.now() - tStart} ms | frames=${total} ` +
//     `| ~${(total * 20) / 1000}s audio | elevenlabs`
//   );
//   return total;
// }

// // ─────────────────────────────────────────────
// // Public synthesis API
// // ─────────────────────────────────────────────

// /**
//  * Synthesize `text`, handing 20 ms μ-law frames to `onFrames` as they arrive
//  * off the wire rather than after the whole clip is ready.
//  *
//  * @param {string} text
//  * @param {(frames: Buffer[]) => void} onFrames
//  * @param {{ previousText?: string }} [opts]
//  * @returns {Promise<number>} frames emitted
//  */
// export async function synthesizeStream(text, onFrames, opts = {}) {
//   if (!text?.trim()) return 0;
//   return elevenLabsStreamSynth(text, onFrames, opts);
// }

// /**
//  * Buffered variant: resolves with every frame at once.
//  * Used for the cached greeting, where there is nothing to overlap with.
//  */
// export async function synthesizeToFrames(text, opts = {}) {
//   const frames = [];
//   await synthesizeStream(text, (fr) => frames.push(...fr), opts);
//   return frames;
// }

// // ─────────────────────────────────────────────
// // Fixed-phrase cache
// //
// // Greetings and tool fillers never change, so they are synthesized once per
// // process and replayed from memory. A filler exists to cover latency; paying
// // 300ms of synthesis to announce a wait would defeat it.
// // ─────────────────────────────────────────────

// const phraseCache = new Map();   // text -> Buffer[] (resolved frames)

// /** Synthesize and cache a set of fixed phrases. Failures are non-fatal. */
// export async function prewarmPhrases(texts = []) {
//   const wanted = texts.filter((t) => t?.trim() && !phraseCache.has(t));
//   if (!wanted.length) return 0;

//   // Sequential on purpose: parallel requests open extra TLS connections, which
//   // measured 4s each on a cold pool.
//   let ok = 0;
//   for (const text of wanted) {
//     try {
//       const frames = await synthesizeToFrames(text);
//       if (frames.length) { phraseCache.set(text, frames); ok++; }
//     } catch (err) {
//       logger.warn(`[tts] could not prewarm "${text.slice(0, 30)}": ${err.message}`);
//     }
//   }
//   if (ok) logger.info(`[tts] prewarmed ${ok} fixed phrase(s)`);
//   return ok;
// }

// /** @returns {Buffer[]|null} cached frames, or null if this phrase is not cached. */
// export function getCachedFrames(text) {
//   return phraseCache.get(text) ?? null;
// }

// /** Estimated playback duration: each frame is 160 bytes @ 8 kHz = exactly 20 ms. */
// export function framesDurationMs(frames) {
//   return frames.length * 20;
// }

// // ─────────────────────────────────────────────
// // Sentence splitting
// // ─────────────────────────────────────────────

// // ─────────────────────────────────────────────

// export function splitIntoSentences(text) {
//   return (
//     text
//       .replace(/\s+/g, ' ')
//       .match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g)
//       ?.map((x) => x.trim())
//       .filter(Boolean)
//   ) || [];
// }

// // ─────────────────────────────────────────────
// // Incremental sentence chunker (for LLM token streaming)
// // ─────────────────────────────────────────────

// // '.' is deliberately excluded from "can end at buffer boundary" — mid-stream
// // a trailing '.' is just as likely to be "Rs." or "3." as a real full stop.
// const HARD_TERMINALS = new Set(['.', '!', '?', '।', '॥']);
// const BOUNDARY_SAFE = new Set(['!', '?', '।', '॥']);
// // Only used to get the *first* fragment out of the door faster.
// const SOFT_TERMINALS = new Set([',', ';', ':', '—', '–']);

// /**
//  * Feeds LLM token deltas in, gets speakable segments out.
//  *
//  * The whole point: TTS for segment 1 should start while the model is still
//  * generating segment 2. Segment size is a tradeoff — too small and prosody
//  * suffers and you burn extra TTS calls, too large and you have given up the
//  * latency win. The defaults below target "first audio out as early as is
//  * still natural-sounding".
//  *
//  * @param {object}  opts
//  * @param {number}  opts.minFirst   Min chars before the first segment may close
//  * @param {number}  opts.minRest    Min chars for subsequent segments
//  * @param {number}  opts.maxChars   Force a break at a space past this length
//  * @param {boolean} opts.softFirst  Allow ',' / ';' to close the first segment
//  */
// export function createSentenceChunker({
//   minFirst = 14,
//   minRest = 30,
//   maxChars = 140,
//   softFirst = true,
// } = {}) {
//   let buf = '';
//   let emitted = 0;

//   const findBreak = () => {
//     const minLen = emitted === 0 ? minFirst : minRest;
//     const allowSoft = softFirst && emitted === 0;

//     for (let i = 0; i < buf.length; i++) {
//       const ch = buf[i];
//       const atEnd = i === buf.length - 1;

//       // A terminal sitting between two digits is part of a number, never a
//       // boundary. This split "कल 3:00 PM" into "कल 3:" and "00 PM", so the
//       // caller heard "three" ... "zero zero PM" as two separate clips.
//       const betweenDigits = /\d/.test(buf[i - 1] || '') && /\d/.test(buf[i + 1] || '');

//       if (HARD_TERMINALS.has(ch)) {
//         // Decimals, times ("3.30"), domains ("xmed.co.in") are not sentence ends.
//         if (betweenDigits) continue;
//         if (ch === '.') {
//           if (atEnd) continue;                       // wait for the next char
//           if (/\d/.test(buf[i - 1] || '') && /\d/.test(buf[i + 1])) continue;
//           if (!/\s/.test(buf[i + 1])) continue;      // no space after => not a stop
//         } else if (atEnd && !BOUNDARY_SAFE.has(ch)) {
//           continue;
//         }
//         if (i + 1 >= minLen) return i;
//         continue;
//       }

//       if (allowSoft && SOFT_TERMINALS.has(ch) && !atEnd && !betweenDigits && i + 1 >= minLen) {
//         return i;
//       }
//     }

//     // Runaway sentence with no punctuation — break on the last space we have.
//     if (buf.length > maxChars) {
//       const sp = buf.lastIndexOf(' ', maxChars);
//       if (sp > minLen) return sp;
//     }

//     return -1;
//   };

//   return {
//     /**
//      * @param {string} delta  Newly arrived token text
//      * @returns {string[]}    Zero or more complete segments, in order
//      */
//     push(delta) {
//       if (!delta) return [];
//       buf += delta;

//       const out = [];
//       for (;;) {
//         const idx = findBreak();
//         if (idx < 0) break;
//         const seg = buf.slice(0, idx + 1).trim();
//         buf = buf.slice(idx + 1);
//         if (seg) {
//           out.push(seg);
//           emitted++;
//         }
//       }
//       return out;
//     },

//     /** Whatever is left when the stream ends. */
//     flush() {
//       const rest = buf.trim();
//       buf = '';
//       if (rest) emitted++;
//       return rest || null;
//     },

//     get emittedCount() {
//       return emitted;
//     },
//   };
// }





























// src/services/speechService.js
//
// Speech-to-text: Deepgram Flux (default) or Sarvam saaras:v4, selected with
// STT_PROVIDER. Text-to-speech: ElevenLabs.
//
// Audio is μ-law 8 kHz end to end — Smartflo's native format — so nothing is
// transcoded in either direction. No ffmpeg, no resampling.

import WebSocket from 'ws';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 8000);

// ElevenLabs routes each request to one of several regions. Logged once per
// process, because a distant region is a fixed tax on every call.
let elevenRegionLogged = false;
// Smartflo requires each outbound media payload to be at least 160 bytes and a
// multiple of 160, or playback develops audible gaps.
const FRAME_BYTES = 160;   // 20 ms of 8 kHz μ-law

// ─────────────────────────────────────────────
// Speech-to-text (streaming websocket)
// ─────────────────────────────────────────────

// 8 kHz PCM16 mono = 16,000 bytes/sec, so 1600 bytes = 100 ms.
//
// This was 3200 (200 ms) because Twilio delivers 20 ms frames and batching cut
// websocket volume 10x. Smartflo delivers every 100 ms — already batched — so
// a 200 ms threshold made every second chunk sit in the buffer waiting for a
// partner, adding up to 100 ms before Sarvam even hears the audio. Matching
// the provider's cadence forwards each chunk on arrival at no extra cost in
// message volume.
const STT_CHUNK_BYTES = Number(process.env.STT_CHUNK_BYTES ?? 1600);

// Fallback path only. Sarvam's per-message `audio.encoding` is an enum whose
// only value is 'audio/wav'. Raw PCM is declared on the connection URL via
// input_audio_codec, and `encoding` is omitted entirely. If the server ever
// starts rejecting messages for a *missing* encoding field, flip this to true.
const SEND_WAV_HEADER = true;

// ─────────────────────────────────────────────
// WAV header (fallback only)
// ─────────────────────────────────────────────

function wavHeader(dataLen, sampleRate = 8000, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bits / 8);
  const blockAlign = channels * (bits / 8);

  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLen, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLen, 40);
  return h;
}

// ─────────────────────────────────────────────
// Deepgram Flux STT (streaming WebSocket)
// ─────────────────────────────────────────────
//
// Flux is Deepgram's turn-based recognizer: it does end-of-turn detection on
// the server with a model rather than a silence timer, which is what makes it
// fast (~260 ms to EndOfTurn against a VAD timeout's 600-800 ms).
//
// Three differences from Sarvam that matter here:
//
//  1. Audio goes over the socket as RAW BINARY frames. No JSON envelope, no
//     base64, no WAV header — about a third fewer bytes on the wire and no
//     JSON parse on their side.
//  2. Every turn signal arrives as one `TurnInfo` message discriminated by an
//     `event` field, not as separate message types.
//  3. `transcript` is CUMULATIVE within a turn. Each `Update` carries the whole
//     turn so far, and `EndOfTurn` carries the final text. Nothing is
//     concatenated on this side.
//
// The callbacks are deliberately the same shape as the Sarvam stream below, so
// callSession.js is untouched: StartOfTurn → onSpeechStart, Update →
// onTranscript(partial), EndOfTurn → onSpeechEnd + onUtteranceEnd(final).

function createDeepgramStream({
  onOpen,
  onTranscript,
  onUtteranceEnd,
  onSpeechStart,
  onSpeechEnd,
  onError,
  onClose,
} = {}) {
  const dg = config.deepgram.stt;
  const sampleRate = Number(dg.sampleRate || 8000);

  const params = new URLSearchParams({
    model: dg.model,
    // Smartflo gives μ-law 8 kHz; callSession already decodes it to PCM16 for
    // the recorder, so linear16 costs nothing extra and is the better-tested
    // path. 8000 is a documented Flux sample rate — no resampling.
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    eot_threshold: String(dg.eotThreshold),
    eot_timeout_ms: String(dg.eotTimeoutMs),
  });

  // Eager end-of-turn lets the agent start thinking before the turn is
  // confirmed, at the cost of a TurnResumed rollback when the caller carries
  // on. Off unless explicitly enabled.
  if (dg.eagerEotThreshold != null) {
    params.set('eager_eot_threshold', String(dg.eagerEotThreshold));
  }

  // language_hint is repeatable and only applies to the multilingual model.
  if (/multi/i.test(dg.model)) {
    for (const hint of dg.languageHints) params.append('language_hint', hint);
  }

  const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${config.deepgram.apiKey}` },
  });

  let closed = false;
  let pending = [];
  let pendingBytes = 0;
  // Guards against a duplicate onSpeechStart if a turn ever re-announces
  // itself; callSession arms a barge-in timer on each one.
  let turnOpen = false;

  const flushPending = () => {
    if (!pendingBytes || ws.readyState !== WebSocket.OPEN) return;

    const chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;

    try {
      ws.send(chunk);               // raw PCM16LE, binary frame
    } catch (err) {
      logger.error(`[deepgram-stt] send=${err.message}`);
    }
  };

  ws.on('open', () => {
    logger.info(`[deepgram-stt] WebSocket open (${dg.model} @ ${sampleRate}Hz)`);
    onOpen?.();
  });

  // HTTP-level handshake failures: 401 bad key, 402/403 quota, 400 bad params.
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      logger.error(`[deepgram-stt] handshake ${res.statusCode} ${body.slice(0, 400)}`);
      onError?.(new Error(`handshake ${res.statusCode}`));
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logger.error(`[deepgram-stt] parse=${err.message} raw=${raw.toString().slice(0, 200)}`);
      return;
    }

    // Drop this line once the stream is behaving.
    logger.debug(`[deepgram-stt] <- ${JSON.stringify(msg).slice(0, 300)}`);

    if (msg.type === 'Connected') {
      logger.debug(`[deepgram-stt] request_id=${msg.request_id}`);
      return;
    }

    // Covers Error / FatalError / anything else they add with that suffix.
    if (typeof msg.type === 'string' && msg.type.endsWith('Error')) {
      const detail = msg.description || msg.message || JSON.stringify(msg);
      logger.error(`[deepgram-stt] server error: ${detail}`);
      onError?.(new Error(detail));
      return;
    }

    if (msg.type !== 'TurnInfo') return;

    const transcript = (msg.transcript || '').trim();

    switch (msg.event) {
      case 'StartOfTurn':
        if (!turnOpen) {
          turnOpen = true;
          onSpeechStart?.();
        }
        return;

      // Cumulative partial for the turn so far. callSession ignores these; they
      // are here so barge-in and future partial-display logic have them.
      case 'Update':
        if (transcript) onTranscript?.(transcript, false);
        return;

      // Only fire with eager_eot_threshold set. The turn is PROBABLY over but
      // may resume, so nothing is committed here.
      case 'EagerEndOfTurn':
        logger.debug(`[deepgram-stt] eager end (conf=${msg.end_of_turn_confidence}) "${transcript}"`);
        return;

      case 'TurnResumed':
        logger.debug('[deepgram-stt] turn resumed — caller kept talking');
        return;

      case 'EndOfTurn': {
        turnOpen = false;
        // Sarvam fired END_SPEECH on VAD and the transcript ~150 ms later.
        // Flux carries both in one message, so endSpeech->transcript collapses
        // to ~0 ms. That is a real saving, not a broken metric.
        onSpeechEnd?.();
        if (!transcript) return;
        logger.info(`[deepgram-stt] utterance="${transcript}" (conf=${msg.end_of_turn_confidence}, ${msg.trigger})`);
        onTranscript?.(transcript, true);
        onUtteranceEnd?.(transcript);
        return;
      }

      default:
        return;
    }
  });

  ws.on('error', (err) => {
    logger.error(`[deepgram-stt] ${err.message}`);
    onError?.(err);
  });

  ws.on('close', (code, reason) => {
    closed = true;
    pending = [];
    pendingBytes = 0;
    turnOpen = false;
    const reasonStr = reason?.length ? reason.toString() : '(no reason)';
    if (code === 1000) {
      logger.debug('[deepgram-stt] closed cleanly (code 1000)');
    } else {
      logger.warn(`[deepgram-stt] closed unexpectedly | code=${code} | reason=${reasonStr}`);
    }
    onClose?.(code, reasonStr);
  });

  const shutdown = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    flushPending();
    // Tells Flux to finalise the turn in flight before the socket drops,
    // instead of discarding whatever the caller was part-way through.
    try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* socket already going */ }
    ws.close(1000);
  };

  return {
    send: (pcm16Buffer) => {
      if (closed || !pcm16Buffer?.length) return;
      pending.push(pcm16Buffer);
      pendingBytes += pcm16Buffer.length;
      if (pendingBytes >= STT_CHUNK_BYTES) flushPending();
    },
    close: shutdown,
    finish: shutdown,
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

// ─────────────────────────────────────────────
// Sarvam STT (streaming WebSocket)
// ─────────────────────────────────────────────

function createSarvamSttStream({
  onOpen,
  onTranscript,
  onUtteranceEnd,
  onSpeechStart,
  onSpeechEnd,
  onError,
  onClose,
} = {}) {
  const sampleRate = String(config.sarvam.stt.sampleRate || 8000);

  // Connection params are snake_case. `input_audio_codec` is REQUIRED when
  // streaming headerless PCM.
  const params = new URLSearchParams({
    model: config.sarvam.stt.model || 'saaras:v3',
    language_code: config.sarvam.stt.language || 'hi-IN',
    mode: config.sarvam.stt.mode || 'codemix',
    sample_rate: sampleRate,
    input_audio_codec: 'pcm_s16le',
    high_vad_sensitivity: 'true',
    vad_signals: 'true',
  });

  const url = `wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`;

  const ws = new WebSocket(url, {
    headers: { 'api-subscription-key': config.sarvam.apiKey },
  });

  let closed = false;
  let pending = [];
  let pendingBytes = 0;

  const flushPending = () => {
    if (!pendingBytes || ws.readyState !== WebSocket.OPEN) return;

    let chunk = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;

    const audio = { data: null, sample_rate: sampleRate };

    if (SEND_WAV_HEADER) {
      chunk = Buffer.concat([wavHeader(chunk.length, Number(sampleRate)), chunk]);
      audio.encoding = 'audio/wav';
    }

    audio.data = chunk.toString('base64');

    try {
      ws.send(JSON.stringify({ audio }));
    } catch (err) {
      logger.error(`[sarvam-stt] send=${err.message}`);
    }
  };

  ws.on('open', () => {
    logger.info('[sarvam-stt] WebSocket open');
    onOpen?.();
  });

  // Catches HTTP-level handshake failures: 401 bad key, 403 quota, 404 bad path.
  ws.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => {
      logger.error(`[sarvam-stt] handshake ${res.statusCode} ${body.slice(0, 400)}`);
      onError?.(new Error(`handshake ${res.statusCode}`));
    });
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      logger.error(`[sarvam-stt] parse=${err.message} raw=${raw.toString().slice(0, 200)}`);
      return;
    }

    // Drop this line once the stream is behaving.
    logger.debug(`[sarvam-stt] <- ${JSON.stringify(msg).slice(0, 300)}`);

    switch (msg.type) {
      case 'events': {
        const signal = msg.data?.signal_type;
        if (signal === 'START_SPEECH') onSpeechStart?.();
        else if (signal === 'END_SPEECH') onSpeechEnd?.();
        return;
      }

      case 'error': {
        const detail = msg.data?.message || JSON.stringify(msg.data || msg);
        logger.error(`[sarvam-stt] server error: ${detail}`);
        onError?.(new Error(detail));
        return;
      }

      case 'data': {
        const transcript = (msg.data?.transcript || '').trim();
        if (!transcript) return;

        // There is no `is_final` on this API. Sarvam runs VAD server-side and
        // only emits a `data` message once an utterance is complete, so every
        // one of these IS final.
        logger.info(`[sarvam-stt] utterance="${transcript}"`);
        onTranscript?.(transcript, true);
        onUtteranceEnd?.(transcript);
        return;
      }

      default:
        return;
    }
  });

  ws.on('error', (err) => {
    logger.error(`[sarvam-stt] ${err.message}`);
    onError?.(err);
  });

  ws.on('close', (code, reason) => {
    closed = true;
    pending = [];
    pendingBytes = 0;
    const reasonStr = reason?.length ? reason.toString() : '(no reason)';
    // 1000 is a normal closure — what the server sends after finish(). Logging
    // it at warn made every clean shutdown look like a fault.
    if (code === 1000) {
      logger.debug(`[sarvam-stt] closed cleanly (code 1000)`);
    } else {
      logger.warn(`[sarvam-stt] closed unexpectedly | code=${code} | reason=${reasonStr}`);
    }
    onClose?.(code, reasonStr);
  });

  return {
    send: (pcm16Buffer) => {
      if (closed || !pcm16Buffer?.length) return;
      pending.push(pcm16Buffer);
      pendingBytes += pcm16Buffer.length;
      if (pendingBytes >= STT_CHUNK_BYTES) flushPending();
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN) {
        flushPending();
        ws.close(1000);
      }
    },
    finish: () => {
      if (ws.readyState === WebSocket.OPEN) {
        flushPending();
        ws.close(1000);
      }
    },
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

// ─────────────────────────────────────────────
// Provider selection
// ─────────────────────────────────────────────

/**
 * Open a streaming recognizer for the configured provider.
 *
 * Both implementations expose the same surface — `{ send(pcm16), finish(),
 * close(), isOpen }` plus the onOpen / onSpeechStart / onTranscript /
 * onSpeechEnd / onUtteranceEnd / onError / onClose callbacks — so switching
 * STT_PROVIDER needs no change anywhere else in the call path.
 */
export function createSttStream(handlers = {}) {
  return config.stt.provider === 'sarvam'
    ? createSarvamSttStream(handlers)
    : createDeepgramStream(handlers);
}

// Legacy name. callSession.js, preflight.js and the bench scripts import this;
// it now dispatches on STT_PROVIDER rather than always meaning Sarvam.
export const createSarvamStream = createSttStream;

// ─────────────────────────────────────────────
// Warm-up
// ─────────────────────────────────────────────

/**
 * Open the connection to ElevenLabs before the first caller arrives.
 *
 * Measured cold: 543-816 ms to first audio, against ~210 ms warm. Without this
 * the first caller of the process pays the DNS and TLS setup.
 */
export async function warmTTS() {
  try {
    await fetch(`${ELEVEN_BASE}/models`, {
      headers: { 'xi-api-key': config.elevenlabs.apiKey },
    });
    logger.info(`[elevenlabs] Connection warmed (${config.elevenlabs.model})`);
  } catch (err) {
    // An optimisation, never a startup dependency.
    logger.warn(`[elevenlabs] warm-up failed (harmless): ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// Text-to-speech (ElevenLabs)
// ─────────────────────────────────────────────

/**
 * Cuts a byte stream into exact 160-byte μ-law frames.
 *
 * The provider may or may not prefix a RIFF header, and chunk boundaries fall
 * wherever the network puts them, so this holds a remainder between pushes and
 * only ever emits whole frames.
 */
export function createMulawFramer() {
  let containerChecked = false;
  let buf = Buffer.alloc(0);

  return {
    /** @returns {Buffer[]} whole frames available so far */
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

      if (!containerChecked) {
        if (buf.length < 4) return [];
        if (buf.toString('ascii', 0, 4) === 'RIFF') {
          const at = buf.indexOf('data', 0, 'ascii');
          if (at < 0) return [];              // header spans more chunks
          buf = buf.subarray(at + 8);         // skip 'data' + size field
        }
        containerChecked = true;
      }

      const whole = Math.floor(buf.length / FRAME_BYTES);
      if (whole === 0) return [];

      const out = [];
      for (let i = 0; i < whole; i++) {
        // Copy rather than view, so the frames do not pin the whole stream
        // buffer in memory for the life of the call.
        out.push(Buffer.from(buf.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES)));
      }
      buf = buf.subarray(whole * FRAME_BYTES);
      return out;
    },

    /** Pad any trailing partial frame with μ-law silence. */
    flush() {
      if (!buf.length) return [];
      const last = Buffer.alloc(FRAME_BYTES, 0xff);
      buf.copy(last);
      buf = Buffer.alloc(0);
      return [last];
    },
  };
}

function elevenVoiceSettings() {
  const { stability, similarityBoost, speed } = config.elevenlabs;
  const vs = {};
  if (stability !== null) vs.stability = stability;
  if (similarityBoost !== null) vs.similarity_boost = similarityBoost;
  if (speed !== null) vs.speed = speed;
  return Object.keys(vs).length ? vs : undefined;
}

/**
 * @param {string} text
 * @param {(frames: Buffer[]) => void} onFrames
 * @param {object} [opts]
 * @param {string} [opts.previousText] The segment spoken immediately before.
 *        Splitting a reply into sentences and synthesizing each in isolation
 *        loses the prosody that connects them; ElevenLabs uses this for
 *        continuity across chunks. Costs nothing and is not billed as speech.
 */
async function elevenLabsStreamSynth(text, onFrames, { previousText } = {}) {
  const { apiKey, voiceId, model, languageCode } = config.elevenlabs;
  if (!apiKey || !voiceId) {
    throw new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set');
  }

  const tStart = Date.now();
  const body = {
    text,
    model_id: model,
    language_code: languageCode || undefined,
    previous_text: previousText || undefined,
  };
  const vs = elevenVoiceSettings();
  if (vs) body.voice_settings = vs;

  const res = await fetch(
    `${ELEVEN_BASE}/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Without this a request that never answers waits forever, and the
      // caller hears silence with nothing in the log to say why. Covers the
      // whole response, body included; a normal sentence finishes in <1s.
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    },
  );

  if (!res.ok || !res.body) {
    const detail = res.ok ? 'no response body' : (await res.text()).slice(0, 200);
    const err = new Error(`elevenlabs ${res.status}: ${detail}`);
    err.status = res.status;
    throw err;
  }

  // ElevenLabs routes each request to one of several regions. A distant region
  // is a fixed tax on every call and is otherwise invisible.
  if (!elevenRegionLogged) {
    elevenRegionLogged = true;
    const region = res.headers.get('x-region');
    if (region) logger.info(`[elevenlabs] serving region: ${region}`);
  }

  const framer = createMulawFramer();
  let total = 0;
  let firstAudioMs = null;

  for await (const chunk of res.body) {
    const frames = framer.push(Buffer.from(chunk));
    if (!frames.length) continue;
    if (firstAudioMs === null) {
      firstAudioMs = Date.now() - tStart;
      logger.info(`[LATENCY] tts.firstAudio = ${firstAudioMs} ms (${text.length} chars, elevenlabs)`);
    }
    total += frames.length;
    onFrames(frames);
  }

  const tail = framer.flush();
  if (tail.length) { total += tail.length; onFrames(tail); }

  logger.info(
    `[LATENCY] tts.streamTotal = ${Date.now() - tStart} ms | frames=${total} ` +
    `| ~${(total * 20) / 1000}s audio | elevenlabs`
  );
  return total;
}

// ─────────────────────────────────────────────
// Public synthesis API
// ─────────────────────────────────────────────

/**
 * Synthesize `text`, handing 20 ms μ-law frames to `onFrames` as they arrive
 * off the wire rather than after the whole clip is ready.
 *
 * @param {string} text
 * @param {(frames: Buffer[]) => void} onFrames
 * @param {{ previousText?: string }} [opts]
 * @returns {Promise<number>} frames emitted
 */
export async function synthesizeStream(text, onFrames, opts = {}) {
  if (!text?.trim()) return 0;
  return elevenLabsStreamSynth(text, onFrames, opts);
}

/**
 * Buffered variant: resolves with every frame at once.
 * Used for the cached greeting, where there is nothing to overlap with.
 */
export async function synthesizeToFrames(text, opts = {}) {
  const frames = [];
  await synthesizeStream(text, (fr) => frames.push(...fr), opts);
  return frames;
}

// ─────────────────────────────────────────────
// Fixed-phrase cache
//
// Greetings and tool fillers never change, so they are synthesized once per
// process and replayed from memory. A filler exists to cover latency; paying
// 300ms of synthesis to announce a wait would defeat it.
// ─────────────────────────────────────────────

const phraseCache = new Map();   // text -> Buffer[] (resolved frames)

/** Synthesize and cache a set of fixed phrases. Failures are non-fatal. */
export async function prewarmPhrases(texts = []) {
  const wanted = texts.filter((t) => t?.trim() && !phraseCache.has(t));
  if (!wanted.length) return 0;

  // Sequential on purpose: parallel requests open extra TLS connections, which
  // measured 4s each on a cold pool.
  let ok = 0;
  for (const text of wanted) {
    try {
      const frames = await synthesizeToFrames(text);
      if (frames.length) { phraseCache.set(text, frames); ok++; }
    } catch (err) {
      logger.warn(`[tts] could not prewarm "${text.slice(0, 30)}": ${err.message}`);
    }
  }
  if (ok) logger.info(`[tts] prewarmed ${ok} fixed phrase(s)`);
  return ok;
}

/** @returns {Buffer[]|null} cached frames, or null if this phrase is not cached. */
export function getCachedFrames(text) {
  return phraseCache.get(text) ?? null;
}

/** Estimated playback duration: each frame is 160 bytes @ 8 kHz = exactly 20 ms. */
export function framesDurationMs(frames) {
  return frames.length * 20;
}

// ─────────────────────────────────────────────
// Sentence splitting
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────

export function splitIntoSentences(text) {
  return (
    text
      .replace(/\s+/g, ' ')
      .match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g)
      ?.map((x) => x.trim())
      .filter(Boolean)
  ) || [];
}

// ─────────────────────────────────────────────
// Incremental sentence chunker (for LLM token streaming)
// ─────────────────────────────────────────────

// '.' is deliberately excluded from "can end at buffer boundary" — mid-stream
// a trailing '.' is just as likely to be "Rs." or "3." as a real full stop.
const HARD_TERMINALS = new Set(['.', '!', '?', '।', '॥']);
const BOUNDARY_SAFE = new Set(['!', '?', '।', '॥']);
// Only used to get the *first* fragment out of the door faster.
const SOFT_TERMINALS = new Set([',', ';', ':', '—', '–']);

/**
 * Feeds LLM token deltas in, gets speakable segments out.
 *
 * The whole point: TTS for segment 1 should start while the model is still
 * generating segment 2. Segment size is a tradeoff — too small and prosody
 * suffers and you burn extra TTS calls, too large and you have given up the
 * latency win. The defaults below target "first audio out as early as is
 * still natural-sounding".
 *
 * @param {object}  opts
 * @param {number}  opts.minFirst   Min chars before the first segment may close
 * @param {number}  opts.minRest    Min chars for subsequent segments
 * @param {number}  opts.maxChars   Force a break at a space past this length
 * @param {boolean} opts.softFirst  Allow ',' / ';' to close the first segment
 */
export function createSentenceChunker({
  minFirst = 14,
  minRest = 30,
  maxChars = 140,
  softFirst = true,
} = {}) {
  let buf = '';
  let emitted = 0;

  const findBreak = () => {
    const minLen = emitted === 0 ? minFirst : minRest;
    const allowSoft = softFirst && emitted === 0;

    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      const atEnd = i === buf.length - 1;

      // A terminal sitting between two digits is part of a number, never a
      // boundary. This split "कल 3:00 PM" into "कल 3:" and "00 PM", so the
      // caller heard "three" ... "zero zero PM" as two separate clips.
      const betweenDigits = /\d/.test(buf[i - 1] || '') && /\d/.test(buf[i + 1] || '');

      if (HARD_TERMINALS.has(ch)) {
        // Decimals, times ("3.30"), domains ("xmed.co.in") are not sentence ends.
        if (betweenDigits) continue;
        if (ch === '.') {
          if (atEnd) continue;                       // wait for the next char
          if (/\d/.test(buf[i - 1] || '') && /\d/.test(buf[i + 1])) continue;
          if (!/\s/.test(buf[i + 1])) continue;      // no space after => not a stop
        } else if (atEnd && !BOUNDARY_SAFE.has(ch)) {
          continue;
        }
        if (i + 1 >= minLen) return i;
        continue;
      }

      if (allowSoft && SOFT_TERMINALS.has(ch) && !atEnd && !betweenDigits && i + 1 >= minLen) {
        return i;
      }
    }

    // Runaway sentence with no punctuation — break on the last space we have.
    if (buf.length > maxChars) {
      const sp = buf.lastIndexOf(' ', maxChars);
      if (sp > minLen) return sp;
    }

    return -1;
  };

  return {
    /**
     * @param {string} delta  Newly arrived token text
     * @returns {string[]}    Zero or more complete segments, in order
     */
    push(delta) {
      if (!delta) return [];
      buf += delta;

      const out = [];
      for (;;) {
        const idx = findBreak();
        if (idx < 0) break;
        const seg = buf.slice(0, idx + 1).trim();
        buf = buf.slice(idx + 1);
        if (seg) {
          out.push(seg);
          emitted++;
        }
      }
      return out;
    },

    /** Whatever is left when the stream ends. */
    flush() {
      const rest = buf.trim();
      buf = '';
      if (rest) emitted++;
      return rest || null;
    },

    get emittedCount() {
      return emitted;
    },
  };
}