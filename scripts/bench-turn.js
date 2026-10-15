#!/usr/bin/env node
/**
 * scripts/bench-turn.js
 *
 * Simulates ONE REAL TURN through each TTS provider and compares them.
 *
 * Synthesizing three strings back to back is not the same thing. In a real turn
 * the sentences arrive staggered from the LLM, synthesis is serialized, and
 * playback runs at 1x — so the questions that actually matter are:
 *
 *   - how long before the caller hears anything?
 *   - does the caller ever hear SILENCE mid-reply because the next segment
 *     was not ready? (that is what a provider being "fast enough" really means)
 *   - when has the whole reply finished playing?
 *
 * Providers compared:
 *   sarvam-stream   POST /text-to-speech/stream   (what the code now uses)
 *   sarvam-rest     POST /text-to-speech          (what it used before)
 *   elevenlabs      Flash v2.5 streaming, ulaw_8000
 *                   (needs ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID)
 *
 *   node scripts/bench-turn.js
 *   node scripts/bench-turn.js --runs 5 --gap 250
 *   node scripts/bench-turn.js --only sarvam-stream,elevenlabs
 *
 * Every provider is framed through the SAME μ-law framer the call path uses, so
 * the frame counts are directly comparable.
 */

import 'dotenv/config';
import { performance } from 'perf_hooks';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { config } from '../src/config/index.js';
import { createMulawFramer } from '../src/services/speechService.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const RUNS = Number(opt('runs', 3));
// Gap between sentences leaving the LLM. Measured on the live call:
// llm.firstSentence -> next queue was ~120-260ms.
const LLM_GAP_MS = Number(opt('gap', 200));
const ONLY = opt('only', null)?.split(',').map((s) => s.trim());
// Write each segment out as a playable WAV so the voices can be compared by
// ear. Once the timings are this close, quality is the deciding factor and no
// number answers it.
const SAVE = argv.includes('--save') ? opt('save', 'tts-samples') : null;

// Sarvam tuning, applied by setting the env vars speechService reads. Lets you
// test whether bulbul can match ElevenLabs on speech length and consistency
// before considering a vendor change.
if (opt('pace', null)) process.env.SARVAM_TTS_PACE = opt('pace');
if (opt('temperature', null)) process.env.SARVAM_TTS_TEMPERATURE = opt('temperature');

// Three ~30-char sentences, the shape Rahul actually produces.
const SENTENCES = argv.includes('--sentences')
  ? opt('sentences', '').split('|')
  : [
      'हम AI प्रोडक्ट्स बनाते हैं।',
      'मेडिकल रिसर्च और ऑटोमेशन भी।',
      'आपको कौन सा प्रोडक्ट चाहिए?',
    ];

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
            dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => `${Math.round(n)}ms`;
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const spread = (xs) => ({ min: Math.min(...xs), med: med(xs), max: Math.max(...xs) });

/**
 * Wrap raw 8kHz mono μ-law in a WAV container so it plays in any media player.
 * Format 7 is WAVE_FORMAT_MULAW — no transcoding, just a 58-byte header.
 */
function mulawToWav(mulaw) {
  const fact = 12;                       // 'fact' chunk is required for non-PCM
  const h = Buffer.alloc(46 + fact);
  h.write('RIFF', 0); h.writeUInt32LE(38 + fact + mulaw.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(18, 16);
  h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.writeUInt16LE(0, 36);
  h.write('fact', 38); h.writeUInt32LE(4, 42); h.writeUInt32LE(mulaw.length, 46);
  h.write('data', 50); h.writeUInt32LE(mulaw.length, 54);
  return Buffer.concat([h.subarray(0, 58), mulaw]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Providers — each takes (text, onFrames) and resolves when done
// ─────────────────────────────────────────────────────────────────────────────

let elevenRegionLogged = false;

// Sarvam is implemented here rather than imported: speechService is now
// ElevenLabs-only, so importing its synthesize functions would compare
// ElevenLabs against itself.
const SARVAM_BASE = 'https://api.sarvam.ai';

function sarvamBody(text) {
  const body = {
    text,
    language_code: config.sarvam.tts.language,
    speaker: config.sarvam.tts.voice,
    model: config.sarvam.tts.model,
    output_audio_codec: 'mulaw',
    speech_sample_rate: 8000,
  };
  if (process.env.SARVAM_TTS_PACE) body.pace = Number(process.env.SARVAM_TTS_PACE);
  if (process.env.SARVAM_TTS_TEMPERATURE) body.temperature = Number(process.env.SARVAM_TTS_TEMPERATURE);
  return body;
}

const sarvamHeaders = () => ({
  'api-subscription-key': config.sarvam.apiKey,
  'Content-Type': 'application/json',
});

const providers = {
  'sarvam-stream': async (text, onFrames) => {
    const res = await fetch(`${SARVAM_BASE}/text-to-speech/stream`, {
      method: 'POST', headers: sarvamHeaders(), body: JSON.stringify(sarvamBody(text)),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);

    const framer = createMulawFramer();
    let total = 0;
    for await (const chunk of res.body) {
      const frames = framer.push(Buffer.from(chunk));
      if (frames.length) { total += frames.length; onFrames(frames); }
    }
    const tail = framer.flush();
    if (tail.length) { total += tail.length; onFrames(tail); }
    return total;
  },

  'sarvam-rest': async (text, onFrames) => {
    const res = await fetch(`${SARVAM_BASE}/text-to-speech`, {
      method: 'POST', headers: sarvamHeaders(), body: JSON.stringify(sarvamBody(text)),
    });
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);

    const buf = Buffer.from((await res.json()).audios[0], 'base64');
    const framer = createMulawFramer();
    const frames = framer.push(buf).concat(framer.flush());
    onFrames(frames);           // arrives all at once, by definition
    return frames.length;
  },

  elevenlabs: async (text, onFrames) => {
    const key = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.ELEVENLABS_VOICE_ID;
    if (!key || !voice) throw new Error('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set');

    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=ulaw_8000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5',
          // optimize_streaming_latency is deprecated and ignored on current
          // API versions; the streaming endpoint already returns progressively.
        }),
      },
    );
    if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);

    // ElevenLabs serves from several regions and picks one per request. If you
    // are being routed somewhere distant, that is a fixed tax on every call and
    // it is invisible unless you look. Reported once per process.
    if (!elevenRegionLogged) {
      elevenRegionLogged = true;
      const region = res.headers.get('x-region');
      if (region) console.log(`  ${C.dim}served from region: ${region}${C.reset}`);
    }

    // Same framer as the call path, so frame counts compare like for like.
    const framer = createMulawFramer();
    let total = 0;
    for await (const chunk of res.body) {
      const frames = framer.push(Buffer.from(chunk));
      if (frames.length) { total += frames.length; onFrames(frames); }
    }
    const tail = framer.flush();
    if (tail.length) { total += tail.length; onFrames(tail); }
    return total;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// One simulated turn
//
// Mirrors callSession: sentences are queued as the LLM emits them, synthesis is
// serialized (TTS_LOOKAHEAD=1), frames are forwarded in order, and a playback
// clock advances 20ms per frame so starvation is detectable.
// ─────────────────────────────────────────────────────────────────────────────

async function runTurn(synth) {
  const t0 = performance.now();
  const queue = [];
  let producerDone = false;

  // The "LLM": emits sentences on a stagger, exactly as the graph does.
  const producer = (async () => {
    for (let i = 0; i < SENTENCES.length; i++) {
      if (i > 0) await sleep(LLM_GAP_MS);
      queue.push({ seq: i, text: SENTENCES[i], queuedAt: performance.now() - t0 });
    }
    producerDone = true;
  })();

  let firstAudioAt = null;
  let playbackEndsAt = null;   // wall-clock, relative to t0
  let starvedMs = 0;
  let speechMs = 0;
  const segments = [];

  // Consumer: strictly serial synthesis, ordered delivery.
  let next = 0;
  while (!producerDone || next < queue.length) {
    if (next >= queue.length) { await sleep(5); continue; }

    const item = queue[next++];
    const synthStart = performance.now() - t0;
    let firstByte = null;
    let frames = 0;
    const captured = SAVE ? [] : null;

    try {
      await synth(item.text, (fr) => {
        if (captured) captured.push(...fr);
        const now = performance.now() - t0;
        if (firstByte === null) firstByte = now;
        if (firstAudioAt === null) firstAudioAt = now;

        // Twilio plays what it has and then waits. If frames land after
        // everything queued before has already played out, that gap is silence
        // the caller actually heard.
        if (playbackEndsAt !== null && now > playbackEndsAt) starvedMs += now - playbackEndsAt;
        playbackEndsAt = Math.max(playbackEndsAt ?? now, now) + fr.length * 20;

        frames += fr.length;
        speechMs += fr.length * 20;
      });
    } catch (err) {
      return { error: err.message };
    }

    segments.push({
      seq: item.seq, chars: item.text.length, queuedAt: item.queuedAt,
      synthStart, firstByte, doneAt: performance.now() - t0, frames,
      audio: captured ? Buffer.concat(captured) : null,
    });
  }

  await producer;

  return {
    firstAudioAt,
    lastFrameAt: performance.now() - t0,
    playbackEndsAt,
    starvedMs,
    speechMs,
    segments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const names = Object.keys(providers).filter((n) => !ONLY || ONLY.includes(n));

console.log(`\n${C.bold}Simulated turn${C.reset}  ${C.dim}${SENTENCES.length} sentences ` +
  `(${SENTENCES.map((s) => s.length).join('/')} chars) · LLM gap ${LLM_GAP_MS}ms · ${RUNS} runs${C.reset}`);
if (process.env.SARVAM_TTS_PACE || process.env.SARVAM_TTS_TEMPERATURE) {
  console.log(`  ${C.dim}sarvam tuning: pace=${process.env.SARVAM_TTS_PACE ?? 'default'} ` +
    `temperature=${process.env.SARVAM_TTS_TEMPERATURE ?? 'default'}${C.reset}`);
}
SENTENCES.forEach((s, i) => console.log(`  ${C.dim}s${i}${C.reset} ${s}`));

const summary = {};

for (const name of names) {
  console.log(`\n${C.bold}${C.cyan}${name}${C.reset}`);
  const firsts = [], lasts = [], starved = [], heard = [], speech = [];
  let skipped = null;

  for (let r = 0; r < RUNS; r++) {
    const out = await runTurn(providers[name]);
    if (out.error) { skipped = out.error; break; }

    if (r === 0) {
      for (const sg of out.segments) {
        console.log(
          `  s${sg.seq}  queued ${String(Math.round(sg.queuedAt)).padStart(4)}ms` +
          `  synth ${String(Math.round(sg.synthStart)).padStart(4)}ms` +
          `  1st byte ${sg.firstByte === null ? '   —' : String(Math.round(sg.firstByte - sg.synthStart)).padStart(4) + 'ms'}` +
          `  ${sg.frames} frames (${(sg.frames * 20 / 1000).toFixed(1)}s)`
        );
      }
    }

    if (r === 0 && SAVE) {
      const dir = path.resolve(process.cwd(), SAVE);
      mkdirSync(dir, { recursive: true });
      for (const sg of out.segments) {
        if (!sg.audio?.length) continue;
        const file = path.join(dir, `${name}-s${sg.seq}.wav`);
        writeFileSync(file, mulawToWav(sg.audio));
      }
      console.log(`  ${C.dim}saved ${out.segments.length} sample(s) to ${SAVE}/${C.reset}`);
    }

    firsts.push(out.firstAudioAt);
    lasts.push(out.lastFrameAt);
    starved.push(out.starvedMs);
    heard.push(out.playbackEndsAt);
    speech.push(out.speechMs);
    await sleep(250);
  }

  if (skipped) { console.log(`  ${C.yellow}skipped — ${skipped}${C.reset}`); continue; }

  const fs_ = spread(firsts);
  const sp = spread(speech);
  const s = {
    first: fs_.med, firstMax: fs_.max, cold: firsts[0],
    last: med(lasts), starved: med(starved), heard: med(heard),
    speechMed: sp.med, speechMin: sp.min, speechMax: sp.max,
  };
  summary[name] = s;

  console.log(`  ${'─'.repeat(56)}`);
  console.log(`  ${C.bold}FIRST AUDIO${C.reset}          ${ms(fs_.med).padStart(7)}   ` +
    `${C.dim}min ${ms(fs_.min)} max ${ms(fs_.max)} · caller waits this${C.reset}`);
  // The median hides the first request of the process, which pays DNS + TLS.
  // On a real call that cost lands on the caller, so it is reported separately.
  if (fs_.med > 0 && firsts[0] > fs_.med * 1.8) {
    console.log(`  ${C.yellow}first request (cold)  ${ms(firsts[0]).padStart(7)}   ` +
      `warm up at startup or the first caller pays this${C.reset}`);
  }
  console.log(`  all audio delivered   ${ms(s.last).padStart(7)}`);
  console.log(`  reply fully heard     ${ms(s.heard).padStart(7)}`);
  console.log(`  speech produced       ${(sp.med / 1000).toFixed(1)}s`.padEnd(31) +
    `   ${C.dim}min ${(sp.min / 1000).toFixed(1)}s max ${(sp.max / 1000).toFixed(1)}s` +
    (sp.min > 0 && (sp.max - sp.min) / sp.min > 0.25
      ? ` — ${Math.round((sp.max - sp.min) / sp.min * 100)}% swing on identical text` : '') +
    `${C.reset}`);
  console.log(`  dead air mid-reply    ${ms(s.starved).padStart(7)}` +
    (s.starved > 150 ? `   ${C.red}caller heard silence${C.reset}` : `   ${C.green}none${C.reset}`));
}

// ─────────────────────────────────────────────────────────────────────────────

const entries = Object.entries(summary);
if (entries.length > 1) {
  console.log(`\n${C.bold}Comparison${C.reset}  ${C.dim}(median of ${RUNS} runs)${C.reset}`);
  console.log(`  ${'provider'.padEnd(16)}${'first audio'.padStart(13)}${'all out'.padStart(11)}${'dead air'.padStart(11)}`);
  const best = Math.min(...entries.map(([, v]) => v.first));
  for (const [n, v] of entries) {
    const tag = v.first === best ? ` ${C.green}fastest${C.reset}` : ` ${C.dim}+${ms(v.first - best)}${C.reset}`;
    console.log(`  ${n.padEnd(16)}${ms(v.first).padStart(13)}${ms(v.last).padStart(11)}${ms(v.starved).padStart(11)}${tag}`);
  }
  console.log(`\n${C.dim}  Dead air matters as much as first audio: a provider that wins on\n` +
    `  time-to-first-byte but starves mid-reply sounds worse on a call.\n` +
    `  Speech length matters too — a shorter reply for the same words ends\n` +
    `  the turn sooner, but only if it still sounds right. Use --save.${C.reset}`);
}

if (!process.env.ELEVENLABS_API_KEY) {
  console.log(`\n${C.yellow}ElevenLabs skipped.${C.reset} Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID ` +
    `to include it.\n${C.dim}A free key is enough for a real number on your own network.${C.reset}`);
}
console.log('');
process.exit(0);
