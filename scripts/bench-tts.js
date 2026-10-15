#!/usr/bin/env node
/**
 * scripts/bench-tts.js
 *
 * Measures TIME TO FIRST AUDIO BYTE from *your* network, for:
 *
 *   1. Sarvam REST        — what you run today (waits for the whole clip)
 *   2. Sarvam WebSocket   — same voice, same model, streamed
 *   3. ElevenLabs Flash   — only if ELEVENLABS_API_KEY is set
 *
 * It also reports the TLS handshake time to each host separately, because you
 * are in India and two of these vendors are not. Network distance is a real
 * part of the comparison and it is invisible in a vendor's published latency.
 *
 *   node scripts/bench-tts.js
 *   node scripts/bench-tts.js --runs 5
 *   node scripts/bench-tts.js --text "आपके products के बारे में बताओ।"
 *
 * Nothing here touches your call path. It is measurement only.
 */

import 'dotenv/config';
import https from 'https';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';
import { config } from '../src/config/index.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const RUNS = Number(opt('runs', 3));
const DEBUG = argv.includes('--debug');
// A realistic first segment: this is the length that actually gates first audio.
const TEXT = opt('text', 'नमस्ते! मैं राहुल बात कर रहा हूँ।');

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
            dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m' };

const ms = (n) => `${Math.round(n)}ms`;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};

// ─────────────────────────────────────────────────────────────────────────────
// Network baseline: how much of any number below is just distance?
// ─────────────────────────────────────────────────────────────────────────────

function tlsHandshake(host) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let connectedAt = null;
    const req = https.request({ host, port: 443, method: 'HEAD', path: '/' }, (res) => {
      res.resume();
      resolve({ tcpTls: connectedAt - t0, total: performance.now() - t0 });
    });
    req.on('socket', (s) => s.on('secureConnect', () => { connectedAt = performance.now(); }));
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Sarvam REST — current behaviour
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 1b. Sarvam HTTP stream — POST /text-to-speech/stream
//
// Returns raw binary progressively, so first-byte arrives before synthesis
// finishes. No handshake, no config message, no connection to keep alive — a
// drop-in replacement for the REST call rather than a new subsystem.
// ─────────────────────────────────────────────────────────────────────────────

async function sarvamHttpStream(text) {
  const t0 = performance.now();
  const res = await fetch('https://api.sarvam.ai/text-to-speech/stream', {
    method: 'POST',
    headers: { 'api-subscription-key': config.sarvam.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      language_code: config.sarvam.tts.language,
      speaker: config.sarvam.tts.voice,
      model: config.sarvam.tts.model,
      output_audio_codec: 'mulaw',
      speech_sample_rate: 8000,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`);

  let firstAudio = null, bytes = 0;
  for await (const chunk of res.body) {
    if (firstAudio === null) firstAudio = performance.now() - t0;
    bytes += chunk.length;
  }
  if (firstAudio === null) throw new Error('stream produced no bytes');
  return { firstAudio, complete: performance.now() - t0, bytes };
}

async function sarvamRest(text) {
  const t0 = performance.now();
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': config.sarvam.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      language_code: config.sarvam.tts.language,
      speaker: config.sarvam.tts.voice,
      model: config.sarvam.tts.model,
      output_audio_codec: 'mulaw',
      speech_sample_rate: 8000,
    }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);
  const body = await res.json();
  const bytes = Buffer.from(body.audios?.[0] ?? '', 'base64').length;
  // REST has no "first byte" — the whole clip arrives at once, by definition.
  return { firstAudio: performance.now() - t0, complete: performance.now() - t0, bytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Sarvam WebSocket — same voice, streamed
//
// Message shapes follow docs.sarvam.ai/api-reference-docs/text-to-speech/stream.
// If the names change, the raw first frames are printed with --debug so you can
// see exactly what came back rather than guessing.
// ─────────────────────────────────────────────────────────────────────────────

function sarvamWs(text, { reuse = null, debug = false } = {}) {
  return new Promise((resolve, reject) => {
    const url = `wss://api.sarvam.ai/text-to-speech/ws?model=${encodeURIComponent(config.sarvam.tts.model)}`;
    const ws = reuse ?? new WebSocket(url, { headers: { 'api-subscription-key': config.sarvam.apiKey } });

    let t0 = null, firstAudio = null, bytes = 0, settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('no audio within 15s')); }
    }, 15000);

    const send = () => {
      // Keys per docs.sarvam.ai .../text-to-speech/streaming-api/web-socket:
      // `language_code` (not target_language_code), and no speech_sample_rate —
      // the WS config exposes codec and bitrate only.
      ws.send(JSON.stringify({
        type: 'config',
        data: {
          speaker: config.sarvam.tts.voice,
          language_code: config.sarvam.tts.language,
          output_audio_codec: 'mulaw',
          min_buffer_size: 20,   // smallest buffer that still triggers synthesis
          max_chunk_length: 200,
        },
      }));
      t0 = performance.now();
      ws.send(JSON.stringify({ type: 'text', data: { text } }));
      ws.send(JSON.stringify({ type: 'flush' }));
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (debug) console.log(`      ${C.dim}<- ${JSON.stringify(msg).slice(0, 160)}${C.reset}`);

      const b64 = msg?.data?.audio ?? msg?.audio;
      if (msg?.type === 'audio' && b64) {
        if (firstAudio === null) firstAudio = performance.now() - t0;
        bytes += Buffer.from(b64, 'base64').length;
      }
      const done = msg?.type === 'events' || msg?.type === 'event' || msg?.type === 'complete';
      if (done && firstAudio !== null && !settled) {
        settled = true; clearTimeout(timer);
        resolve({ firstAudio, complete: performance.now() - t0, bytes, ws });
      }
    });

    ws.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    ws.on('close', (code, r) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (firstAudio !== null) resolve({ firstAudio, complete: performance.now() - t0, bytes, ws: null });
      else {
        const reason = String(r || '').slice(0, 200);
        reject(new Error(`closed ${code}${reason ? ' — ' + reason : ' with no reason given'}` +
          `${DEBUG ? '' : ' (re-run with --debug to see the frames)'}`));
      }
    });

    if (reuse && ws.readyState === 1) send(); else ws.on('open', send);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ElevenLabs Flash v2.5 — streaming endpoint, mu-law 8k straight to Twilio
// ─────────────────────────────────────────────────────────────────────────────

async function elevenFlash(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return null;

  const t0 = performance.now();
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=ulaw_8000`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        // Lowest setting still produces audio; higher values buffer more text
        // before starting, which is exactly what we are measuring against.
        optimize_streaming_latency: 3,
      }),
    },
  );
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);

  let firstAudio = null, bytes = 0;
  for await (const chunk of res.body) {
    if (firstAudio === null) firstAudio = performance.now() - t0;
    bytes += chunk.length;
  }
  return { firstAudio, complete: performance.now() - t0, bytes };
}

// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${C.bold}TTS time-to-first-audio${C.reset}`);
console.log(`${C.dim}text: "${TEXT}" (${TEXT.length} chars) · ${RUNS} runs each${C.reset}\n`);

console.log(`${C.bold}Network distance (TLS handshake)${C.reset}`);
for (const host of ['api.sarvam.ai', 'api.elevenlabs.io', 'api.deepgram.com', 'api.openai.com']) {
  const r = await tlsHandshake(host);
  console.log(`  ${host.padEnd(22)} ${r ? ms(r.tcpTls).padStart(7) : '   n/a'}` +
    `${C.dim}  ${r ? 'connect + TLS' : 'unreachable'}${C.reset}`);
}
console.log(`${C.dim}  Every request below pays this once per new connection. It is the\n` +
  `  floor for any vendor, and it is why a "75ms model" is never 75ms.${C.reset}\n`);

const results = {};

async function bench(label, fn, note = '') {
  const times = [], completes = [];
  let bytes = 0, err = null;
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = await fn();
      if (r === null) return;                 // not configured
      times.push(r.firstAudio); completes.push(r.complete); bytes = r.bytes;
    } catch (e) { err = e; break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (err) { console.log(`  ${C.red}${label.padEnd(26)} failed${C.reset}  ${C.dim}${err.message}${C.reset}`); return; }
  if (!times.length) return;

  const s = stats(times);
  results[label] = s.med;
  console.log(`  ${label.padEnd(26)} ${ms(s.med).padStart(7)}  ` +
    `${C.dim}min ${ms(s.min)} max ${ms(s.max)} · full clip ${ms(stats(completes).med)} · ${bytes}B` +
    `${note ? ' · ' + note : ''}${C.reset}`);
}

console.log(`${C.bold}Time to FIRST audio byte${C.reset}`);
await bench('Sarvam REST (current)', () => sarvamRest(TEXT), 'no first byte — whole clip');
await bench('Sarvam HTTP stream', () => sarvamHttpStream(TEXT));
await bench('Sarvam WebSocket', async () => {
  const r = await sarvamWs(TEXT, { debug: DEBUG });
  try { r.ws?.close(); } catch {}
  return r;
});
await bench('ElevenLabs Flash v2.5', () => elevenFlash(TEXT),
  process.env.ELEVENLABS_API_KEY ? '' : 'set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID');

// ─────────────────────────────────────────────────────────────────────────────

const base = results['Sarvam REST (current)'];
if (base) {
  console.log(`\n${C.bold}Versus what you run today${C.reset}`);
  for (const [k, v] of Object.entries(results)) {
    if (k === 'Sarvam REST (current)') continue;
    const delta = base - v;
    const tag = delta > 0 ? `${C.green}${ms(delta)} faster${C.reset}` : `${C.red}${ms(-delta)} slower${C.reset}`;
    console.log(`  ${k.padEnd(26)} ${tag}`);
  }
  console.log(`\n${C.dim}  Subtract these from the "tts" row in your [TURN] report to see the\n` +
    `  first-audio number you would actually ship.${C.reset}`);
}

if (!process.env.ELEVENLABS_API_KEY) {
  console.log(`\n${C.yellow}ElevenLabs was skipped.${C.reset} A free key is enough to get a real number ` +
    `for\nyour own network rather than a published one.`);
}
console.log('');
process.exit(0);
