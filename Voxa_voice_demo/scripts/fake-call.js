#!/usr/bin/env node
/**
 * scripts/fake-call.js
 *
 * Impersonates Tata Smartflo bi-directional audio streaming against your
 * running server: opens the same websocket, speaks the same protocol, and
 * behaves like a real phone in the two ways that matter — it plays audio back
 * in real time, and it echoes `mark` events only after that audio would have
 * finished playing.
 *
 * It also mirrors one Smartflo-specific behaviour: on `clear`, Smartflo replies
 * with the marks for the audio it discarded. Twilio stays silent, so a client
 * that only models Twilio would never exercise that path.
 *
 * Start the server first, then:
 *
 *   node scripts/fake-call.js
 *   node scripts/fake-call.js --say "मुझे कल मीटिंग बुक करनी है"
 *   node scripts/fake-call.js --say "hello" --say "what does xverse do"
 *   node scripts/fake-call.js --barge-in
 *   node scripts/fake-call.js --url ws://localhost:3000/ws/media
 *
 * The caller's voice is synthesized with a different Sarvam speaker so STT is
 * transcribing genuinely different audio, not the bot's own voice.
 */

import 'dotenv/config';
import WebSocket from 'ws';
import { performance } from 'perf_hooks';
import { config } from '../src/config/index.js';
import { stripRiffContainer, wavToMulaw8k } from '../src/utils/audioUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const multi = (name) => {
  const out = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
};

const WS_URL = opt('url', `ws://localhost:${config.port}/ws/media`);
// Deliberately not the bot's voice, so STT is transcribing genuinely different
// audio. Speaker availability varies by model, so this is a preference list
// rather than a single name — the first one the model accepts wins.
const CALLER_VOICE = opt('speaker', null);
const CALLER_VOICE_CANDIDATES = ['ritu', 'priya', 'neha', 'shreya', 'kavya', 'pooja'];
const PHONE = opt('from', '+919999900000');
const TO_NUMBER = opt('to', '+911140000000');
const BARGE_IN = flag('barge-in');
// Two turns by default. One turn is not enough: a session that never closes its
// turn still delivers audio for the first response, and only reveals itself on
// the second, which sits behind the 20s watchdog.
// Default script exercises the three things that were broken on live calls:
//   1. a plain question
//   2. a request that triggers a TOOL — proves the filler covers the wait
//   3. TWO questions in one breath — proves neither is silently dropped
const UTTERANCES = multi('say').length
  ? multi('say')
  : [
      'Hello, what does Xverse do?',
      'कल के लिए available slots बताओ।',
      'What is the price? And when can we start?',
    ];

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', mag: '\x1b[35m',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SILENCE = Buffer.alloc(160, 0xff); // μ-law silence, one 20ms frame

let problems = 0;
const bad = (m) => { problems++; console.log(`  ${C.red}✗ ${m}${C.reset}`); };
const good = (m) => console.log(`  ${C.green}✓ ${m}${C.reset}`);
const note = (m) => console.log(`  ${C.dim}${m}${C.reset}`);

// ─────────────────────────────────────────────────────────────────────────────
// Synthesize the caller's voice
// ─────────────────────────────────────────────────────────────────────────────

// Resolved once, then reused for the rest of the run.
let callerVoice = CALLER_VOICE;

async function requestCallerAudio(text, speaker) {
  return fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': config.sarvam.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      language_code: config.sarvam.tts.language,
      speaker,
      model: config.sarvam.tts.model,
      output_audio_codec: 'mulaw',
      speech_sample_rate: 8000,
    }),
  });
}

/**
 * Pick a caller voice the configured model actually supports.
 *
 * Speaker lists differ between bulbul versions, so rather than hardcoding a
 * name that may not exist, try candidates and — if the API rejects one — read
 * the list of valid speakers straight out of the error and pick from that.
 */
async function resolveCallerVoice() {
  if (callerVoice) return callerVoice;

  // The bot now speaks through ElevenLabs, so any Sarvam voice is already a
  // different speaker. This only avoids an accidental clash if that changes.
  const botVoice = String(config.elevenlabs?.voiceId || '').toLowerCase();
  const tried = [];

  for (const candidate of CALLER_VOICE_CANDIDATES) {
    if (candidate === botVoice) continue;
    tried.push(candidate);

    const res = await requestCallerAudio('परीक्षण', candidate);
    if (res.ok) { callerVoice = candidate; return callerVoice; }

    const body = await res.text();

    // "Available speakers for bulbul:v3 are: aditya, ritu, ..."
    // Anchored on "are:" rather than the first colon, because the model name
    // itself contains one ("bulbul:v3").
    const listed = /Available speakers.*?\bare:\s*([^"}\n]+)/i.exec(body)?.[1];
    if (listed) {
      const valid = listed.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
      const pick = CALLER_VOICE_CANDIDATES.find((c) => c !== botVoice && valid.includes(c))
        ?? valid.find((v) => v !== botVoice);
      if (pick) {
        note(`speaker "${candidate}" unsupported by ${config.sarvam.tts.model}; using "${pick}"`);
        callerVoice = pick;
        return callerVoice;
      }
    }

    if (res.status !== 400 && res.status !== 422) {
      throw new Error(`caller TTS ${res.status}: ${body}`);
    }
  }

  throw new Error(`no usable caller voice (tried ${tried.join(', ')})`);
}

async function synthCaller(text) {
  const speaker = await resolveCallerVoice();
  const res = await requestCallerAudio(text, speaker);

  if (!res.ok) throw new Error(`caller TTS ${res.status}: ${await res.text()}`);

  const buf = Buffer.from((await res.json()).audios[0], 'base64');
  // Same normalisation the server does: μ-law may or may not be RIFF-wrapped.
  const mulaw = stripRiffContainer(buf);
  const bytes = mulaw.length % 160 ? mulaw.subarray(0, mulaw.length - (mulaw.length % 160)) : mulaw;

  const frames = [];
  for (let i = 0; i < bytes.length; i += 160) frames.push(bytes.subarray(i, i + 160));
  return frames;
}

// ─────────────────────────────────────────────────────────────────────────────
// The fake phone
// ─────────────────────────────────────────────────────────────────────────────

class FakePhone {
  constructor(ws) {
    this.ws = ws;
    this.streamSid = `MZ${Date.now()}`;
    this.callSid = `CA${Date.now()}`;
    this.accountSid = `AC${Date.now()}`;
    this.seq = 0;

    this.rxFrames = 0;          // audio frames received since the last mark
    this.rxTotal = 0;
    this.marksReceived = [];
    this.marksAcked = [];
    this.clears = 0;

    this.lastRxAt = 0;
    this.firstRxAt = 0;         // first audio of the current bot response
    this.playingUntil = 0;      // wall-clock when buffered audio finishes
    this.bursts = [];           // [{ start, end, frames }] groups of media

    this._onQuiet = null;
  }

  send(obj) {
    this.ws.send(JSON.stringify({ ...obj, sequenceNumber: String(++this.seq) }));
  }

  start() {
    this.send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    // Smartflo start frame: the caller is `from`, not a customParameter.
    this.send({
      event: 'start',
      streamSid: this.streamSid,
      start: {
        streamSid: this.streamSid,
        accountSid: this.accountSid,
        callSid: this.callSid,
        from: PHONE,
        to: TO_NUMBER,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    });
  }

  handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { bad(`server sent non-JSON: ${String(raw).slice(0, 80)}`); return; }

    switch (msg.event) {
      case 'media': {
        const payload = msg.media?.payload;
        if (!payload) { bad('media message with no payload'); break; }
        const buf = Buffer.from(payload, 'base64');
        if (buf.length !== 160) bad(`frame is ${buf.length} bytes, expected 160`);

        const now = performance.now();
        if (!this.firstRxAt) this.firstRxAt = now;

        // Group frames into bursts. A gap means the server had nothing ready —
        // either it was still synthesizing, or this is a second turn entirely.
        const last = this.bursts[this.bursts.length - 1];
        if (!last || now - last.end > 600) {
          this.bursts.push({ start: now, end: now, frames: 1 });
        } else {
          last.end = now;
          last.frames++;
        }

        this.rxFrames++;
        this.rxTotal++;
        this.lastRxAt = now;
        // Model playback: audio queues up and drains at 1x.
        this.playingUntil = Math.max(this.playingUntil, now) + 20;
        break;
      }

      case 'mark': {
        const name = msg.mark?.name;
        this.marksReceived.push(name);
        // Real Twilio only echoes the mark once everything queued before it has
        // actually been played. Emulating that delay is the whole point.
        const delay = Math.max(0, this.playingUntil - performance.now());
        setTimeout(() => {
          this.marksAcked.push(name);
          this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
          this._checkQuiet();
        }, delay);
        break;
      }

      case 'clear': {
        this.clears++;
        this.rxFrames = 0;
        this.playingUntil = performance.now(); // buffered audio discarded

        // Smartflo behaviour: the marks for the discarded audio come straight
        // back rather than being dropped. The server must ignore them as stale;
        // if it does not, they will end the turn that replaced this one.
        const outstanding = this.marksReceived.filter((n) => !this.marksAcked.includes(n));
        for (const name of outstanding) {
          this.marksAcked.push(name);
          this.send({ event: 'mark', streamSid: this.streamSid, mark: { name } });
        }
        console.log(`  ${C.mag}← clear (barge-in acknowledged, ` +
          `${outstanding.length} mark(s) returned)${C.reset}`);
        break;
      }

      default:
        note(`← unexpected event "${msg.event}"`);
    }
  }

  _checkQuiet() { if (this._onQuiet) this._onQuiet(); }

  /** Stream caller audio in real time, 20ms per frame. */
  async speak(frames, { leadSilenceMs = 300, trailSilenceMs = 900 } = {}) {
    const emit = (f) => this.send({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: f.toString('base64') },
    });

    let next = performance.now();
    const pace = async () => {
      next += 20;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    };

    for (let i = 0; i < leadSilenceMs / 20; i++) { emit(SILENCE); await pace(); }
    for (const f of frames) { emit(f); await pace(); }
    const doneSpeaking = performance.now();

    // A fast server answers during the trailing silence. Start listening now,
    // not when waitForResponse is called, or that audio is discarded and the
    // NEXT burst gets timed instead — which reported 3755ms for a turn the
    // server actually answered in 507ms.
    this.firstRxAt = 0;
    this.bursts = [];
    this._armedAt = doneSpeaking;

    for (let i = 0; i < trailSilenceMs / 20; i++) { emit(SILENCE); await pace(); }

    return doneSpeaking;
  }

  /** Keep sending silence until the bot has been quiet for `quietMs`. */
  async waitForResponse({ quietMs = 700, timeoutMs = 25_000 } = {}) {
    // Deliberately does NOT reset firstRxAt — speak() already armed the window
    // when the caller stopped, so anything that arrived since then counts.
    if (this._armedAt === undefined) { this.firstRxAt = 0; this.bursts = []; }
    this._armedAt = undefined;
    this.rxFrames = 0;
    const startFrames = this.rxTotal;
    const t0 = performance.now();

    let next = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      this.send({
        event: 'media',
        streamSid: this.streamSid,
        media: { payload: SILENCE.toString('base64') },
      });
      next += 20;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);

      const gotSomething = this.rxTotal > startFrames;
      const quiet = this.lastRxAt && performance.now() - this.lastRxAt > quietMs;
      const marksSettled = this.marksReceived.length === this.marksAcked.length;
      if (gotSomething && quiet && marksSettled) {
        return {
          frames: this.rxTotal - startFrames,
          firstAudioAt: this.firstRxAt,
          bursts: this.bursts,
          timedOut: false,
        };
      }
    }
    return {
      frames: this.rxTotal - startFrames,
      firstAudioAt: this.firstRxAt,
      bursts: this.bursts,
      timedOut: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

console.log(`${C.bold}${C.cyan}Fake Smartflo call${C.reset} → ${WS_URL}`);
console.log(`${C.dim}from: ${PHONE}${C.reset}\n`);

console.log(`${C.dim}Synthesizing caller audio…${C.reset}`);
const utteranceAudio = [];
try {
  for (const text of UTTERANCES) {
    const frames = await synthCaller(text);
    utteranceAudio.push({ text, frames });
    note(`"${text}" → ${frames.length} frames (${(frames.length * 20 / 1000).toFixed(1)}s)`);
  }
  note(`caller voice: sarvam/${callerVoice} · bot: elevenlabs/${config.elevenlabs.model}`);
} catch (err) {
  // Fail with a readable message instead of an unhandled rejection, which on
  // Windows also trips a libuv assertion on the way out.
  bad(`could not synthesize the caller's voice: ${err.message}`);
  console.log(`${C.dim}Try: node scripts/fake-call.js --speaker <name>${C.reset}`);
  process.exitCode = 1;
  process.exit(1);
}

const ws = new WebSocket(WS_URL);
const phone = new FakePhone(ws);

ws.on('message', (raw) => phone.handle(raw.toString()));
ws.on('error', (err) => { bad(`websocket error: ${err.message}`); process.exit(1); });
ws.on('unexpected-response', (_req, res) => {
  bad(`handshake rejected: HTTP ${res.statusCode} — is the server running and is the path right?`);
  process.exit(1);
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('connect timeout — is the server running?')), 8000);
  ws.on('open', () => { clearTimeout(t); resolve(); });
});

good('websocket connected');
phone.start();
good('sent connected + start');

// ── Greeting ────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}Greeting${C.reset}`);
const greeting = await phone.waitForResponse({ quietMs: 800, timeoutMs: 20_000 });

if (greeting.timedOut && greeting.frames === 0) {
  bad('no greeting audio — session never started speaking');
} else {
  good(`greeting: ${greeting.frames} frames (${(greeting.frames * 20 / 1000).toFixed(1)}s audio)`);
}

if (phone.marksReceived.length === 0) {
  bad('server sent NO mark events — mediaStreamHandler is missing the `mark` case, ' +
      'or callSession is not sending marks. Turns will hang on the watchdog.');
} else {
  good(`received ${phone.marksReceived.length} mark(s), acked ${phone.marksAcked.length}`);
}

// ── Turns ───────────────────────────────────────────────────────────────────
const timings = [];

for (const { text, frames } of utteranceAudio) {
  console.log(`\n${C.bold}Caller:${C.reset} "${text}"`);

  const marksBefore = phone.marksReceived.length;
  const doneSpeakingAt = await phone.speak(frames);
  const res = await phone.waitForResponse();

  // Both timestamps must be derived from the same monotonic anchor. Reading the
  // wall clock after speak() returns includes the trailing silence, which made
  // the printed times disagree with the reported latency by ~900ms.
  const toWall = (perfMs) => new Date(Date.now() - (performance.now() - perfMs));

  if (res.frames === 0) {
    bad('no response audio within 25s');
    continue;
  }

  const e2e = res.firstAudioAt - doneSpeakingAt;
  timings.push(e2e);

  good(`response: ${res.frames} frames (${(res.frames * 20 / 1000).toFixed(1)}s audio), ` +
       `${phone.marksReceived.length - marksBefore} segment(s)`);
  console.log(`  ${C.bold}${C.cyan}time to first audio: ${Math.round(e2e)}ms${C.reset} ` +
              `${C.dim}(end of caller speech → first frame out)${C.reset}`);

  // ~20s is the watchdog timeout in callSession, not a slow model. It means the
  // previous turn never closed, so this one sat queued until the watchdog
  // force-unlocked it — almost always a broken mark round-trip.
  if (e2e > 15_000) {
    bad('~20s delay is the watchdog signature: the previous turn never closed. ' +
        'The server is sending marks but not acting on the acks — check the ' +
        '`case \'mark\'` branch in mediaStreamHandler.js.');
  } else if (e2e > 5_000) {
    bad(`${Math.round(e2e)}ms is far too slow for a phone call — check the server LATENCY logs`);
  }

  if (phone.marksReceived.length - marksBefore > 1) {
    good('response arrived in multiple segments — streaming is working end to end');
  } else {
    note('single segment this turn (short reply, or streaming not chunking)');
  }

  // Timestamps to line up against the server's [LATENCY] lines, which use the
  // same HH:MM:SS.mmm format. Guessing which stage owns a slow turn is not
  // necessary when both sides can be read side by side.
  const hhmmss = (d) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  note(`caller stopped ${hhmmss(toWall(doneSpeakingAt))} · ` +
       `first frame ${hhmmss(toWall(res.firstAudioAt))} · ` +
       `grep the server log between these two times`);

  // Bursts separated by real gaps mean the server was not ready. More than one
  // burst usually means STT split the utterance and the server took two turns.
  // A tool turn should arrive as: short filler, gap while the tool runs, then
  // the real answer. That gap is the point — the caller hears a phrase instead
  // of silence — so it must NOT be reported as dead air.
  if (res.bursts?.length > 1) {
    const first = res.bursts[0];
    const gapAfterFirst = Math.round(res.bursts[1].start - first.end);
    const firstMs = first.frames * 20;
    if (firstMs < 3000 && gapAfterFirst > 700) {
      good(`looks like a filler: ${(firstMs / 1000).toFixed(1)}s phrase, then ` +
        `${(gapAfterFirst / 1000).toFixed(1)}s of tool time — caller was not left in silence`);
    }
  }

  if (res.bursts?.length > 1) {
    const gaps = res.bursts.slice(1).map((b, i) => Math.round(b.start - res.bursts[i].end));
    note(`${res.bursts.length} audio bursts, gaps of ${gaps.join(', ')}ms ` +
         `(${res.bursts.map((b) => b.frames).join('+')} frames)`);
    if (gaps.some((g) => g > 2000)) {
      bad('a gap over 2s mid-response — the server likely handled this as two ' +
          'separate turns because STT split the utterance');
    }
  }

  if (res.timedOut) bad('response never went quiet — turn may not have closed');
}

// ── Barge-in ────────────────────────────────────────────────────────────────
if (BARGE_IN) {
  console.log(`\n${C.bold}Barge-in test${C.reset}`);
  const long = await synthCaller('Please tell me everything about all of your products in detail.');
  const interrupt = await synthCaller('रुकिए, एक मिनट।');

  const clearsBefore = phone.clears;
  await phone.speak(long);

  // Wait until the bot is genuinely mid-sentence, then talk over it.
  const t0 = performance.now();
  while (performance.now() - t0 < 20_000) {
    await sleep(20);
    phone.send({
      event: 'media', streamSid: phone.streamSid,
      media: { payload: SILENCE.toString('base64') },
    });
    if (phone.lastRxAt && performance.now() - phone.lastRxAt < 100 && phone.rxTotal > 0) break;
  }

  await sleep(400); // let it get a little way in
  console.log(`  ${C.dim}interrupting…${C.reset}`);
  await phone.speak(interrupt, { leadSilenceMs: 0, trailSilenceMs: 900 });

  await sleep(1500);

  if (phone.clears > clearsBefore) {
    good('server sent `clear` — barge-in path works');
  } else {
    bad('no `clear` received — barge-in did not fire. Check that Sarvam STT is ' +
        'emitting START_SPEECH (vad_signals=true) and that audio had begun playing.');
  }

  const after = await phone.waitForResponse({ quietMs: 900, timeoutMs: 20_000 });
  after.frames > 0
    ? good(`recovered: new response of ${after.frames} frames after the interrupt`)
    : bad('no response after barge-in — session may be stuck');
}

// ── Hang up ─────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}Hanging up${C.reset}`);
phone.send({ event: 'stop', streamSid: phone.streamSid, stop: { callSid: phone.callSid } });
await sleep(600);
ws.close();
good('stop sent (check the server log for "Flushed N turns")');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${C.bold}${'─'.repeat(56)}${C.reset}`);
if (timings.length) {
  const avg = timings.reduce((a, b) => a + b, 0) / timings.length;
  console.log(`time to first audio: ${timings.map((t) => Math.round(t) + 'ms').join(', ')}` +
              `  ${C.dim}avg ${Math.round(avg)}ms${C.reset}`);
  if (avg > 1500) {
    console.log(`${C.yellow}Higher than expected. Compare llm.firstSentence and tts.total ` +
                `in the server log to see which stage owns it.${C.reset}`);
  }
}
console.log(`marks: ${phone.marksReceived.length} received / ${phone.marksAcked.length} acked` +
            `   clears: ${phone.clears}   audio frames in: ${phone.rxTotal}`);

console.log(`\n${C.dim}Check the server log for these, which this client cannot see:\n` +
  `  [Rahul] filler for check_availability   — the phrase covering the tool wait\n` +
  `  queued transcript (merged N: ...)       — both questions kept, not overwritten\n` +
  `  [TURN n] ...then queued                 — time waiting on the previous reply\n` +
  `  recording saved                         — stereo WAV written${C.reset}`);

if (problems) {
  console.log(`\n${C.red}${C.bold}${problems} problem(s) — see above.${C.reset}`);
  process.exit(1);
}
console.log(`\n${C.green}${C.bold}Call completed cleanly. Safe to dial for real.${C.reset}`);
process.exit(0);