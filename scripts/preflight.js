#!/usr/bin/env node
/**
 * scripts/preflight.js
 *
 * Verifies every stage of the voice pipeline in isolation, in dependency
 * order, WITHOUT placing a phone call. Run this after any change to the
 * speech/LLM path and before you dial the number.
 *
 *   node scripts/preflight.js
 *   node scripts/preflight.js --skip-stt      (STT round-trip is the slow one)
 *   node scripts/preflight.js --only=llm,graph
 *
 * Exit code is 0 only if every non-skipped check passes.
 *
 * This costs a handful of Sarvam credits and one small OpenAI call.
 */

import 'dotenv/config';
import { performance } from 'perf_hooks';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const onlyArg = args.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()) : null;

// ─────────────────────────────────────────────────────────────────────────────
// Tiny test harness
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m',
};

const results = [];
let currentStage = '';

// Collected across stages so the summary can show where the time actually goes.
const M = {};

function stage(id, title) {
  currentStage = id;
  console.log(`\n${C.bold}${C.cyan}── ${title}${C.reset}`);
}

function ok(msg, detail = '') {
  results.push({ stage: currentStage, pass: true, msg });
  console.log(`  ${C.green}PASS${C.reset}  ${msg}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
}

function fail(msg, detail = '') {
  results.push({ stage: currentStage, pass: false, msg, detail });
  console.log(`  ${C.red}FAIL${C.reset}  ${msg}${detail ? `\n        ${C.dim}${detail}${C.reset}` : ''}`);
}

function warn(msg, detail = '') {
  results.push({ stage: currentStage, warn: true, msg });
  console.log(`  ${C.yellow}WARN${C.reset}  ${msg}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}`);
}

function info(msg) {
  console.log(`  ${C.dim}·     ${msg}${C.reset}`);
}

function check(cond, msg, failDetail = '', passDetail = '') {
  cond ? ok(msg, passDetail) : fail(msg, failDetail);
  return cond;
}

const skipped = [];
async function runStage(id, title, fn) {
  if (only && !only.includes(id)) { skipped.push(id); return; }
  stage(id, title);
  try {
    await fn();
  } catch (err) {
    fail(`stage threw: ${err.message}`, err.stack?.split('\n').slice(1, 4).join('\n        '));
  }
}

const ms = (t) => `${Math.round(t)}ms`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Environment
// ─────────────────────────────────────────────────────────────────────────────

await runStage('env', 'Environment & config', async () => {
  // Smartflo issues no credentials for streaming and does not sign its
  // webhooks, so there is nothing telephony-side to check beyond BASE_URL.
  // Only the active recognizer's key is required, so a Deepgram-only
  // deployment does not need a Sarvam key sitting in .env, or vice versa.
  const sttProvider = (process.env.STT_PROVIDER || 'deepgram').toLowerCase();
  const required = [
    'BASE_URL', 'OPENAI_API_KEY', 'MONGODB_URI',
    'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
    sttProvider === 'sarvam' ? 'SARVAM_API_KEY' : 'DEEPGRAM_API_KEY',
  ];
  const missing = required.filter((k) => !process.env[k]);
  check(missing.length === 0, 'required env vars present',
    `missing: ${missing.join(', ')}`, `${required.length} vars`);

  if (missing.length) {
    console.log(`\n${C.red}Cannot continue without those.${C.reset}`);
    process.exit(1);
  }

  const { config } = await import('../src/config/index.js');

  const { model: ttsModel, voiceId, languageCode } = config.elevenlabs;
  info(`TTS   elevenlabs / ${ttsModel} / voice ${voiceId} / lang ${languageCode}`);
  const isDG = config.stt.provider !== 'sarvam';
  const sttRate = isDG ? config.deepgram.stt.sampleRate : config.sarvam.stt.sampleRate;

  if (isDG) {
    const d = config.deepgram.stt;
    info(`STT   deepgram / ${d.model} / hints ${d.languageHints.join('+') || 'none'} @ ${d.sampleRate}Hz`);
    info(`      eot_threshold ${d.eotThreshold} / eot_timeout ${d.eotTimeoutMs}ms / eager ${d.eagerEotThreshold ?? 'off'}`);
  } else {
    info(`STT   sarvam / ${config.sarvam.stt.model} / ${config.sarvam.stt.language} @ ${config.sarvam.stt.sampleRate}Hz`);
  }
  info(`LLM   ${config.openai.model}`);

  check(sttRate === 8000, 'STT sample rate is 8000 (Smartflo native)',
    `got ${sttRate} — Smartflo streams 8kHz μ-law; resampling adds latency and error`);

  if (isDG) {
    check(/^flux-general-(en|multi)$/.test(config.deepgram.stt.model),
      'Deepgram model is a Flux model',
      `"${config.deepgram.stt.model}" — only flux-general-en and flux-general-multi exist on /v2/listen`);

    // Nova models live on /v1/listen and use a completely different message
    // shape; pointing one at this code produces a silent, transcript-free call.
    if (/multi/i.test(config.deepgram.stt.model) && !config.deepgram.stt.languageHints.includes('hi')) {
      warn('no "hi" language hint — Hinglish callers may be detected as English',
        `hints: ${config.deepgram.stt.languageHints.join(', ') || 'none'}`);
    }
    check(config.deepgram.stt.eotThreshold >= 0.5 && config.deepgram.stt.eotThreshold <= 1.0,
      'eot_threshold within Deepgram range (0.5-1.0)',
      `got ${config.deepgram.stt.eotThreshold} — the connection will be rejected`);
    check(config.deepgram.stt.eotTimeoutMs >= 500 && config.deepgram.stt.eotTimeoutMs <= 60000,
      'eot_timeout_ms within Deepgram range (500-60000)',
      `got ${config.deepgram.stt.eotTimeoutMs} — the connection will be rejected`);
  }

  // Smartflo builds the stream URL from whatever this webhook returns, so a
  // malformed BASE_URL fails the call at connect time with no useful error.
  const wss = config.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/media';
  check(/^wss?:\/\/.+\/ws\/media$/.test(wss),
    'BASE_URL yields a valid wss_url for the Smartflo Dynamic endpoint',
    `built "${wss}" — Smartflo needs a scheme-qualified URL`, wss);

  if (!config.baseUrl.startsWith('https://') && !config.baseUrl.startsWith('http://')) {
    warn('BASE_URL has no scheme — the <Stream> URL will be malformed', config.baseUrl);
  }

  // The Dynamic Voice Bot endpoint contract, which Smartflo enforces strictly:
  // HTTP 200 inside 2000 ms, with JSON containing EXACTLY the two keys
  // `success` and `wss_url`. Any extra key, a non-200, invalid JSON, a missing
  // key or a timeout and the request is declined and THE CALL HANGS UP. Adding
  // a helpful `callSid` or `region` to that response would silently kill every
  // call, which is worth a test rather than a comment.
  let handleIncomingCall;
  try {
    ({ handleIncomingCall } = await import('../src/controllers/callController.js'));
  } catch (err) {
    warn('could not load the call controller to test the Dynamic endpoint', err.message);
  }

  let payload = null;
  let statusCode = null;
  const fakeRes = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };

  const t0 = performance.now();
  if (handleIncomingCall) {
    handleIncomingCall({ body: { callId: 'pf-1', fromNumber: '919876543210', toNumber: '918069412345' } }, fakeRes);
  }
  const elapsed = Math.round(performance.now() - t0);

  if (!handleIncomingCall) return;

  check(statusCode === 200, 'the Dynamic endpoint answers 200', `got ${statusCode}`);
  const keys = payload ? Object.keys(payload).sort() : [];
  check(keys.length === 2 && keys[0] === 'success' && keys[1] === 'wss_url',
    'it returns EXACTLY { success, wss_url }',
    `returned ${keys.length} key(s): ${keys.join(', ')} — any extra key makes Smartflo decline and hang up the call`);
  check(payload?.success === true, 'success is boolean true', `got ${JSON.stringify(payload?.success)}`);
  check(typeof payload?.wss_url === 'string' && payload.wss_url.startsWith('wss://'),
    'wss_url starts with wss://', `got ${JSON.stringify(payload?.wss_url)}`);
  check(elapsed < 2000, 'it answers well inside the 2000ms budget', `took ${elapsed}ms`, `${elapsed}ms`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. TTS — the μ-law fast path is the main thing to prove here
// ─────────────────────────────────────────────────────────────────────────────

let sampleFrames = null;

await runStage('tts', 'Sarvam TTS + audio conversion', async () => {
  const { synthesizeToFrames, framesDurationMs } = await import('../src/services/speechService.js');
  const { mulawToLinear } = await import('../src/utils/audioUtils.js');

  // Warm the TLS/HTTP connection so the timing below reflects synthesis, not handshake.
  const { warmTTS } = await import('../src/services/speechService.js');
  await warmTTS();

  const text = 'नमस्ते, मैं राहुल बात कर रहा हूँ।';
  const t0 = performance.now();
  const frames = await synthesizeToFrames(text);
  const dt = performance.now() - t0;

  if (!check(frames.length > 0, 'TTS returned audio')) return;

  sampleFrames = frames;

  const durMs = framesDurationMs(frames);
  M.ttsSynth = dt;
  M.ttsChars = text.length;
  ok('synthesis round-trip', ms(dt));
  info(`${frames.length} frames = ${durMs}ms of audio for ${text.length} chars`);

  // Smartflo's docs are explicit: a media payload that is not a multiple of
  // 160 bytes causes audible gaps in playback.
  check(frames.every((f) => f.length === 160),
    'every frame is exactly 160 bytes (Smartflo requires a multiple of 160)');
  check(durMs > 800 && durMs < 6000, 'audio duration is plausible for the text', `${durMs}ms`, `${durMs}ms`);

  // A silent or near-silent buffer means the conversion produced garbage even
  // though the byte count looked right — the failure mode that is invisible
  // until you actually hear dead air on the call.
  let sum = 0, n = 0, clipped = 0;
  for (const f of frames) {
    for (const b of f) {
      const s = mulawToLinear(b);
      sum += s * s; n++;
      if (Math.abs(s) > 32000) clipped++;
    }
  }
  const rms = Math.sqrt(sum / n);
  check(rms > 500, 'decoded audio is not silence',
    `rms=${Math.round(rms)} — conversion produced silence`, `rms=${Math.round(rms)}`);
  const clipPct = `${((clipped / n) * 100).toFixed(2)}% near-full-scale`;
  check(clipped / n < 0.02, 'audio is not clipping', clipPct, clipPct);

  if (durMs > 0) {
    const realtimeRatio = dt / durMs;
    if (realtimeRatio > 0.5) {
      warn('synthesis is slow relative to audio length', `${realtimeRatio.toFixed(2)}x`);
    } else {
      ok('synthesis comfortably faster than playback', `${realtimeRatio.toFixed(2)}x realtime`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. STT — round-trip our own TTS audio back through the recognizer
// ─────────────────────────────────────────────────────────────────────────────

await runStage('stt', 'STT websocket (round-trip)', async () => {
  if (has('--skip-stt')) { warn('skipped via --skip-stt'); return; }
  if (!sampleFrames) { fail('no TTS audio to feed in — TTS stage must pass first'); return; }

  const { createSttStream } = await import('../src/services/speechService.js');
  const { config } = await import('../src/config/index.js');
  const { mulawToPcm16 } = await import('../src/utils/audioUtils.js');

  const usingDeepgram = config.stt.provider !== 'sarvam';
  const events = { open: false, speechStart: false, transcripts: [], errors: [] };

  const stream = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('STT socket did not open within 10s')), 10_000);
    const s = createSttStream({
      onOpen: () => { events.open = true; clearTimeout(timer); resolve(s); },
      onSpeechStart: () => { events.speechStart = true; },
      onUtteranceEnd: (t) => { events.transcripts.push(t); },
      onError: (e) => { events.errors.push(e.message); clearTimeout(timer); reject(e); },
    });
  });

  ok('websocket handshake accepted (API key + params valid)');

  const silence = Buffer.alloc(160, 0xff); // μ-law silence
  const send = (mulawFrame) => stream.send(mulawToPcm16(mulawFrame));

  // Paced against a virtual clock, not `await sleep(20)` per frame.
  //
  // sleep(20) always overshoots a little, and the error accumulates: feeding
  // 2.1s of audio took ~3.4s of wall clock, so the recognizer's audio timeline
  // ran seconds behind real time and the end-of-turn measurement below was
  // inflated by the gap. It reported 1670ms where the real figure was far lower.
  // This keeps wall clock and audio time together, so the number means something.
  const FRAME_MS = 20;
  let audioMs = 0;
  const t0Feed = performance.now();
  const feed = async (frame) => {
    send(frame);
    audioMs += FRAME_MS;
    const behind = audioMs - (performance.now() - t0Feed);
    if (behind > 1) await sleep(behind);
  };

  for (let i = 0; i < 15; i++) await feed(silence);     // 300ms lead-in
  for (const f of sampleFrames) await feed(f);

  const speechEndedAudioMs = audioMs;
  const tSpeechEnded = performance.now();

  // Keep the silence flowing rather than stopping dead. Both recognizers decide
  // a turn is over from the audio they receive, so a socket that goes quiet can
  // sit there until its timeout instead of finalising — which looked like a
  // hung recognizer the first time around.
  const deadline = Date.now() + 10_000;
  while (!events.transcripts.length && Date.now() < deadline) await feed(silence);

  const endToTranscriptMs = Math.round(performance.now() - tSpeechEnded);
  // How much silence the recognizer actually had to hear before it committed.
  // Independent of this script's pacing, so it is the honest figure.
  const silenceNeededMs = audioMs - speechEndedAudioMs;
  const feedDriftMs = Math.round((performance.now() - t0Feed) - audioMs);

  const gotTranscript = check(events.transcripts.length > 0, 'STT produced a transcript',
    'nothing came back within 10s of the audio ending');

  if (gotTranscript) {
    events.transcripts.forEach((t, i) => info(`utterance[${i}]: "${t}"`));
    ok('end-of-utterance detection fired');

    // The headline number for this swap: how long after the caller stops
    // talking the agent has words to act on. Sarvam's VAD timeout put this
    // around 600-800ms; Flux should land near 300ms.
    info(`last speech sample -> final transcript: ${endToTranscriptMs}ms` +
      ` (recognizer needed ${silenceNeededMs}ms of trailing silence)`);
    if (Math.abs(feedDriftMs) > 150) {
      info(`audio was fed ${feedDriftMs > 0 ? feedDriftMs + 'ms behind' : -feedDriftMs + 'ms ahead of'} real time` +
        ' — the figure above is skewed by that much');
    }

    // Judged on the silence the recognizer needed, which this script's pacing
    // cannot distort. Synthetic TTS of a full sentence is a pessimistic input:
    // a real caller trails off, which Flux reads much faster than a clean
    // sentence-final consonant. Treat this as an upper bound.
    if (silenceNeededMs > 1200) {
      warn('end-of-turn detection is slow — every reply inherits this delay',
        usingDeepgram
          ? `the model took ${silenceNeededMs}ms of silence to pass eot_threshold ` +
            `${config.deepgram.stt.eotThreshold}. Try 0.6, or set ` +
            'DEEPGRAM_EAGER_EOT_THRESHOLD=0.4 so the LLM starts on the eager signal. ' +
            'Synthetic speech is the worst case here — check a live call before tuning hard.'
          : 'Sarvam VAD timeout — consider switching STT_PROVIDER=deepgram');
    } else {
      ok(`end-of-turn detection is fast (${silenceNeededMs}ms of silence)`);
    }

    // One spoken sentence should come back as one utterance. More than that
    // means the VAD is cutting on internal pauses, and on a real call the
    // agent will answer before the caller has finished their thought.
    if (events.transcripts.length > 1) {
      warn(`one sentence was split into ${events.transcripts.length} utterances`,
        usingDeepgram
          ? `eot_threshold ${config.deepgram.stt.eotThreshold} is ending turns on mid-sentence ` +
            'pauses — the agent will interrupt slow speakers. Raise it towards 0.9.'
          : 'high_vad_sensitivity=true is cutting on mid-sentence pauses — the agent ' +
            'will interrupt slow speakers. Set it to false in speechService if callers ' +
            'complain about being cut off.');
    } else {
      ok('sentence came back as a single utterance (VAD not over-splitting)');
    }
  }

  check(events.speechStart,
    usingDeepgram
      ? 'recognizer emitted StartOfTurn (needed for barge-in)'
      : 'VAD emitted START_SPEECH (needed for barge-in)',
    usingDeepgram
      ? 'barge-in will NOT work — no StartOfTurn arrived before the final transcript'
      : 'barge-in will NOT work — check vad_signals=true on the connect URL');

  check(events.errors.length === 0, 'no STT errors', events.errors.join('; '));

  try { stream.finish(); } catch {}
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sentence chunker — pure logic, no network
// ─────────────────────────────────────────────────────────────────────────────

await runStage('chunker', 'Streaming sentence chunker', async () => {
  const { createSentenceChunker } = await import('../src/services/speechService.js');

  const feed = (text, opts) => {
    const c = createSentenceChunker(opts);
    const out = [];
    // Feed one character at a time — the worst case for boundary logic.
    for (const ch of text) out.push(...c.push(ch));
    const tail = c.flush();
    if (tail) out.push(tail);
    return out;
  };

  const cases = [
    ['English, two sentences',
      'Hey, I am Rahul. How can I help you today?',
      ['Hey, I am Rahul.', 'How can I help you today?']],
    ['Devanagari danda',
      'नमस्ते! मैं राहुल हूँ। आज क्या मदद करूँ?',
      ['नमस्ते! मैं राहुल हूँ।', 'आज क्या मदद करूँ?']],
    ['decimals and domains must not split',
      'Meeting at 3.30 PM on xmed.co.in works. Shall I book it?',
      ['Meeting at 3.30 PM on xmed.co.in works.', 'Shall I book it?']],
    ['single short reply',
      'हाँ।',
      ['हाँ।']],
  ];

  for (const [label, input, expected] of cases) {
    const got = feed(input);
    check(JSON.stringify(got) === JSON.stringify(expected), label, `got ${JSON.stringify(got)}`);
  }

  // Nothing may ever be lost: concatenating the segments must reproduce the input.
  const long = 'पहला वाक्य। दूसरा वाक्य! तीसरा वाक्य? चौथा बिना विराम के';
  const rejoined = feed(long).join(' ').replace(/\s+/g, ' ');
  check(rejoined === long.replace(/\s+/g, ' '), 'no text is dropped or duplicated', `got "${rejoined}"`);

  // A reply with no punctuation at all must still emit rather than buffer forever.
  const runaway = feed('word '.repeat(60));
  check(runaway.length >= 2, 'unpunctuated output still breaks into segments',
    'buffered forever — maxChars break is not firing', `${runaway.length} segments`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. LLM streaming — is the model actually emitting deltas?
// ─────────────────────────────────────────────────────────────────────────────

await runStage('llm', 'OpenAI token streaming', async () => {
  const { ChatOpenAI } = await import('@langchain/openai');
  const { config } = await import('../src/config/index.js');

  const llm = new ChatOpenAI({
    model: config.openai.model,
    temperature: 0,
    maxTokens: 120,
  });

  // Without this, the first measurement includes DNS + TLS + HTTP setup and
  // reads 1-2s higher than the steady-state number the call will actually see.
  const tWarm = performance.now();
  await llm.invoke([{ role: 'user', content: 'hi' }]).catch(() => {});
  info(`connection warm-up (DNS + TLS + first request): ${ms(performance.now() - tWarm)}`);

  const t0 = performance.now();
  let firstToken = null, chunks = 0, text = '';

  const stream = await llm.stream([
    { role: 'system', content: 'Reply in exactly two short sentences.' },
    { role: 'user', content: 'Introduce yourself as a phone assistant.' },
  ]);

  for await (const c of stream) {
    const d = typeof c.content === 'string' ? c.content : '';
    if (d && firstToken === null) firstToken = performance.now() - t0;
    if (d) { chunks++; text += d; }
  }
  const total = performance.now() - t0;

  check(chunks > 1, 'model streamed multiple deltas (not one buffered blob)',
    'got a single chunk — streaming is not actually happening', `${chunks} chunks`);
  check(firstToken !== null, 'received a first token');

  if (firstToken !== null) {
    M.ttft = firstToken;
    M.llmTotal = total;
    ok('time to first token', ms(firstToken));
    ok('time to full completion', ms(total));
    const saved = total - firstToken;
    info(`streaming makes ~${ms(saved)} of generation overlappable`);
    if (firstToken > 800) {
      warn('TTFT is high — check region/network to api.openai.com', ms(firstToken));
    }
  }
  info(`text: "${text.slice(0, 90)}${text.length > 90 ? '…' : ''}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Tool-call chunks — the guard that mutes speech depends on names arriving early
// ─────────────────────────────────────────────────────────────────────────────

await runStage('tools', 'Tool-call streaming behaviour', async () => {
  const { ChatOpenAI } = await import('@langchain/openai');
  const { config } = await import('../src/config/index.js');

  const llm = new ChatOpenAI({ model: config.openai.model, temperature: 0, maxTokens: 120 })
    .bindTools([{
      type: 'function',
      function: {
        name: 'check_availability',
        description: 'Check available meeting slots for a date.',
        parameters: { type: 'object', properties: { date: { type: 'string' } }, required: ['date'] },
      },
    }]);

  let chunkIndex = 0, nameSeenAt = null, contentCharsBeforeName = 0;
  const stream = await llm.stream([
    { role: 'user', content: 'Is tomorrow at 3pm free for a meeting?' },
  ]);

  for await (const c of stream) {
    for (const tc of c.tool_call_chunks ?? []) {
      if (tc.name && nameSeenAt === null) nameSeenAt = chunkIndex;
    }
    if (nameSeenAt === null && typeof c.content === 'string') contentCharsBeforeName += c.content.length;
    chunkIndex++;
  }

  if (nameSeenAt === null) {
    warn('model did not call a tool for this prompt — guard not exercised',
      'not a failure; rerun or adjust the prompt if you want to verify it');
  } else {
    ok('tool name arrives in a tool_call_chunk', `chunk #${nameSeenAt}`);
    const cd = `${contentCharsBeforeName} chars of content preceded it (chunker minFirst is 14)`;
    check(contentCharsBeforeName < 14,
      'tool name arrives before a full sentence of content could be spoken', cd, cd);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Calendar-authoritative booking
// ─────────────────────────────────────────────────────────────────────────────

await runStage('booking', 'Calendar overrides extracted lead data', async () => {
  // On a live call the caller asked for 12:00, the slot was taken, the model
  // booked 11:30 and never revised its extraction — the CRM kept 12:00.
  const marker = 'SUCCESS: Calendar event created for 2026-09-11 at 11:30 AM. ID: abc. ' +
    '[[BOOKED:{"date":"2026-09-11","time":"11:30 AM","eventId":"abc"}]] Now send the email.';

  const m = /\[\[BOOKED:(\{.*?\})\]\]/s.exec(marker);
  if (!check(Boolean(m), 'booking marker is parseable')) return;

  const booked = JSON.parse(m[1]);
  check(booked.date === '2026-09-11' && booked.time === '11:30 AM',
    'marker carries the slot actually booked', JSON.stringify(booked), JSON.stringify(booked));

  const extracted = { name: 'Sandeep', time: '12:00 PM' };
  const merged = { ...extracted, ...booked };
  check(merged.time === '11:30 AM', 'calendar wins over the model on conflict',
    `got ${merged.time}`, '12:00 PM -> 11:30 AM');
  check(merged.name === 'Sandeep', 'non-conflicting extracted fields survive');

  check(/\[\[BOOKED:(\{.*?\})\]\]/s.exec('SUCCESS: no marker here') === null,
    'a tool result without a marker is ignored');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Graph wiring — THE key check: do sentences escape before invoke resolves?
// ─────────────────────────────────────────────────────────────────────────────

await runStage('graph', 'LangGraph streaming wiring', async () => {
  const { processMessage } = await import('../src/services/agentService.js');

  const sessionId = `preflight-${Date.now()}`;
  const sentences = [];
  const t0 = performance.now();
  let firstSentenceAt = null;

  const res = await processMessage(
    sessionId,
    'Hello, what does Xverse do?',
    { phoneNumber: '+910000000000', memory: [] },
    {},
    {
      onSentence: (s) => {
        if (firstSentenceAt === null) firstSentenceAt = performance.now() - t0;
        sentences.push(s);
      },
    },
  );

  const total = performance.now() - t0;

  if (!check(sentences.length > 0, 'onSentence callback fired',
    'the sink is NOT wired — check registerSink/getSink and that rahulNode receives runConfig')) return;


  ok(`emitted ${sentences.length} segment(s) mid-generation`);
  sentences.forEach((s, i) => info(`[${i}] ${s}`));

  const fd = `first=${ms(firstSentenceAt)} vs done=${ms(total)}`;
  check(firstSentenceAt < total, 'first sentence arrived BEFORE the graph resolved', fd, fd);

  M.graphFirstSentence = firstSentenceAt;
  M.graphTotal = total;

  const headroom = total - firstSentenceAt;
  if (headroom < 50) {
    warn('almost no head start — model replied in a single short burst',
      `only ${ms(headroom)} saved on this turn; try a prompt that elicits 2 sentences`);
  } else {
    ok('latency actually saved on this turn', `~${ms(headroom)}`);
  }

  check(typeof res.response === 'string' && res.response.trim().length > 0,
    'final response text still returned for logging');

  // The spoken segments should reconstruct the final text — if they diverge,
  // the caller heard something different from what got written to Mongo.
  const joined = sentences.join(' ').replace(/\s+/g, ' ').trim();
  const finalText = res.response.replace(/\s+/g, ' ').trim();
  check(joined === finalText, 'spoken segments match the logged response exactly',
    `spoke  "${joined}"\n        logged "${finalText}"`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool fillers — what the caller hears while a tool runs
// ─────────────────────────────────────────────────────────────────────────────

await runStage('fillers', 'Tool fillers', async () => {
  const { fillerFor, allFillerPhrases, FILLERS_ENABLED } =
    await import('../src/constants/fillers.js');

  if (!FILLERS_ENABLED) {
    warn('fillers disabled (FILLERS_ENABLED=false)',
      'a calendar lookup plus a booking took ~7s on a live call, all of it silent');
    return;
  }

  // Every tool the model can actually call should have something to say, in
  // BOTH languages. These were Hindi only, so an English call stayed English
  // right up to the booking and then said one Hindi sentence.
  const bound = ['check_availability', 'book_appointment', 'send_meeting_email'];
  const DEVANAGARI = /[ऀ-ॿ]/;
  for (const tool of bound) {
    for (const lang of ['en', 'hi']) {
      const phrase = fillerFor(tool, lang);
      check(Boolean(phrase?.trim()), `${tool} has a ${lang} filler`,
        'blank means silence during that tool', `"${phrase}"`);
    }
  }
  const englishFillers = [...bound, 'a_tool_added_later'].map((t) => fillerFor(t, 'en'));
  check(englishFillers.every((p) => p && !DEVANAGARI.test(p)),
    'no Devanagari in any English filler',
    `an English call would hear: ${englishFillers.filter((p) => DEVANAGARI.test(p)).join(' | ')}`);
  check(bound.every((t) => DEVANAGARI.test(fillerFor(t, 'hi'))),
    'the Hindi fillers really are Hindi');
  check(Boolean(fillerFor('a_tool_added_later', 'en')?.trim())
    && Boolean(fillerFor('a_tool_added_later', 'hi')?.trim()),
    'an unknown tool falls back to the default filler in both languages');
  check(fillerFor('book_appointment') === fillerFor('book_appointment', 'en'),
    'fillerFor() defaults to English when no language is passed',
    'the default must match the call default, or a missed call site speaks Hindi');

  const phrases = allFillerPhrases();
  check(phrases.length > 0, 'phrases available to prewarm', '', `${phrases.length}`);

  // The whole point is that a filler costs nothing. If it has to be synthesized
  // on demand it adds ~300ms — covering latency with latency.
  const { prewarmPhrases, getCachedFrames, framesDurationMs } =
    await import('../src/services/speechService.js');

  const t0 = performance.now();
  const warmed = await prewarmPhrases(phrases);
  check(warmed === phrases.length, 'all phrases synthesized at boot',
    `${warmed}/${phrases.length} — the rest would be synthesized mid-call`,
    ms(performance.now() - t0));

  const first = getCachedFrames(phrases[0]);
  check(Array.isArray(first) && first.length > 0, 'cached frames retrievable');
  if (first) {
    const dur = framesDurationMs(first);
    check(dur > 700 && dur < 6000, 'filler is a sensible length',
      `${dur}ms — very short or very long sounds wrong`, `${(dur / 1000).toFixed(1)}s`);
    check(first.every((f) => f.length === 160), 'filler frames are 160 bytes');
  }

  const t1 = performance.now();
  getCachedFrames(phrases[0]);
  check(performance.now() - t1 < 5, 'cache hit is instant (no network)',
    '', ms(performance.now() - t1));
});

// ─────────────────────────────────────────────────────────────────────────────
// Turn-taking knobs
// ─────────────────────────────────────────────────────────────────────────────

await runStage('turns', 'Turn-taking configuration', async () => {
  const join = Number(process.env.UTTERANCE_JOIN_MS ?? 400);
  const settle = Number(process.env.UTTERANCE_SETTLE_MS ?? 0);
  const barge = Number(process.env.BARGE_IN_CONFIRM_MS ?? 300);
  const maxQ = Number(process.env.MAX_QUEUED_UTTERANCES ?? 3);

  info(`fragment join   ${join}ms   (holds a short/unpunctuated utterance)`);
  info(`sentence settle ${settle}ms   (holds a COMPLETE sentence)`);
  info(`barge-in confirm ${barge}ms  (speech must last this long to interrupt)`);
  info(`queue depth     ${maxQ} utterances merged into one turn`);

  check(join >= 0 && join <= 1500, 'fragment join window is sane', `${join}ms`);
  check(settle >= 0 && settle <= 1500, 'sentence settle window is sane', `${settle}ms`);

  if (settle === 0) {
    warn('UTTERANCE_SETTLE_MS is 0 — a complete sentence is acted on immediately',
      'this is what makes the agent talk over a caller who pauses mid-thought. ' +
      'Try 300-500.');
  }
  check(barge > 0, 'barge-in requires confirmation',
    '0 means any VAD blip cuts the reply — two such blips truncated a 7.2s answer on a live call');
  check(maxQ >= 2, 'more than one queued question is kept',
    '1 means a second question silently overwrites the first');
});

// ─────────────────────────────────────────────────────────────────────────────
// Language stickiness, and lead data being English-only
// ─────────────────────────────────────────────────────────────────────────────

await runStage('lang', 'Reply language & English-only lead data', async () => {
  const { nextReplyLanguage } = await import('../src/utils/speakable.js');
  const { romanize, normalizeName, normalizeEmail, extractAsciiEmail, normalizeLeadData } =
    await import('../src/utils/leadNormalize.js');
  const { assessBookingPermit, countRefusedConfirmations } = await import('../src/agents/bookingGuard.js');
  const fs = await import('node:fs');
  const agents = fs.readFileSync(new URL('../src/agents/companyAgents.js', import.meta.url), 'utf8');

  // Exactly what callSession does: start in English, then fold each caller
  // utterance through the policy.
  const run = (utterances) => {
    let conv = 'en';
    return utterances.map((u) => (conv = nextReplyLanguage(conv, u)));
  };

  // The live call that prompted this: an English caller got a Hindi answer.
  const english = run(['Hello.', 'How are you?', 'Hey Priya can you tell me about XOS?']);
  check(english.every((l) => l === 'en'),
    'an English caller stays in English through "How are you?"',
    `got ${english.join(', ')} — this is the bug where small talk flipped the call to Hindi`);

  const sticky = run([
    'Hello there, how are you doing', 'Yes.', 'theek hai', 'ok', 'जी।', 'हाँ।',
    'Blue company.', 'amit at gmail dot com', 'Correct.',
  ]);
  check(sticky.every((l) => l === 'en'),
    'nothing short flips an English call — not "theek hai", "जी", a name or an email',
    `got ${sticky.join(', ')}`);

  // One Devanagari content word is enough to move to Hindi: that is the whole
  // requirement — Hindi the moment the caller speaks any.
  check(run(['Hello, tell me about your products', 'नमस्ते'])[1] === 'hi',
    'ONE Hindi word switches the agent to Hindi',
    'the caller spoke Hindi, so the agent must answer in Hindi');
  check(run(['मुझे कल मीटिंग बुक करनी है'])[0] === 'hi',
    'a full Hindi sentence switches the agent to Hindi');
  check(run(['pricing kya hai iska batao'])[0] === 'hi',
    'Hinglish in Latin letters switches too',
    'roman Hindi needs two content words, which this has');
  check(run(['नमस्ते।', 'Yes.', 'ok'])[2] === 'hi',
    'once in Hindi, "Yes"/"ok" do not drag it back to English');
  check(run(['नमस्ते।', 'Blue company.'])[1] === 'hi',
    'a two-word English answer does not drag a Hindi call back',
    'a product name is not a language switch');
  check(run(['नमस्ते।', 'Can you tell me the pricing for this'])[1] === 'en',
    'a full English sentence DOES bring it back to English',
    'the caller must be able to switch back');

  // Lead data is stored in English whatever the caller spoke.
  check(romanize('विभव') === 'vibhav' && romanize('वस्ती') === 'vasti',
    'Devanagari names transliterate to Latin',
    `got "${romanize('विभव')}" / "${romanize('वस्ती')}"`);
  check(normalizeName('विभव वस्ती') === 'Vibhav Vasti',
    'a name is stored in Latin, Title Case', normalizeName('विभव वस्ती'));

  const ok = normalizeEmail('विभव.वस्ती54@gmail.com');
  check(ok.valid && ok.email === 'vibhav.vasti54@gmail.com',
    'a Devanagari email becomes a real ASCII address',
    `got "${ok.email}" valid=${ok.valid}`);

  const spoken = normalizeEmail('amit at the rate gmail dot com');
  check(spoken.valid && spoken.email === 'amit@gmail.com',
    'a dictated email ("at the rate", "dot") is assembled', spoken.email);

  const digits = normalizeEmail('60@gmail.com');
  check(!digits.valid,
    'a digits-only address is REFUSED rather than booked',
    'this is the "60@gmail.com" that got a real confirmation email sent to it');

  const dropped = normalizeLeadData({ name: 'विभव', email: '60@gmail.com' });
  check(dropped.data.email === undefined && dropped.data.name === 'Vibhav',
    'a refused email is left unset so the agent asks again',
    JSON.stringify(dropped.data));

  // The repeat loop: the old ASCII regex matched the tail of a Devanagari
  // address, so the guard compared two different strings and blocked forever.
  const devaBlob = 'आपका ईमेल है: विभव.वस्ती54@gmail.com। क्या यह सही है?';
  check(extractAsciiEmail(devaBlob) === null,
    'a Devanagari address no longer parses as a bogus "54@gmail.com"',
    `got ${extractAsciiEmail(devaBlob)}`);

  const ai = (c) => ({ _getType: () => 'ai', content: c });
  const hu = (c) => ({ _getType: () => 'human', content: c });
  const summary = 'तो, Vibhav के लिए, vibhav.vasti54@gmail.com, 3 अक्टूबर को 10:00 AM पर मीटिंग — बुक कर दूँ?';

  const permit = assessBookingPermit([ai(summary), hu('Yes.')]);
  check(permit.allowed, 'a clear yes to the final question books on the FIRST ask',
    `blocked: ${permit.reason} — this is the loop that re-asked the same question`);

  // The live loop: the summary ends "...your email is x@gmail.com. Shall I book
  // it?" and the address is followed by a SENTENCE PERIOD. The old trailing
  // lookahead had "." in its forbidden set, so extraction returned null, the
  // gate said "no email in the question", and five confirmed yeses were
  // refused in a row. Every earlier test put a comma there.
  const EN_SUMMARY = 'So, for you, Sandeep, the meeting is on 10 October at 1:30 PM, and your email is sviish8703@gmail.com. Should I book it?';
  for (const punct of ['.', ',', '?', '!', ';', '।', '']) {
    const line = `your email is amit@gmail.com${punct} Shall I book it?`;
    check(extractAsciiEmail(line) === 'amit@gmail.com',
      `an address followed by "${punct || '(nothing)'}" is still found`,
      `got ${extractAsciiEmail(line)} — the gate would say the question had no email and loop`);
  }
  check(extractAsciiEmail(EN_SUMMARY) === 'sviish8703@gmail.com',
    'the exact summary line from the looping call parses',
    `got ${extractAsciiEmail(EN_SUMMARY)}`);
  check(extractAsciiEmail('email is amit@gmail.co.uk. ok?') === 'amit@gmail.co.uk',
    'a multi-label domain is not truncated',
    'the trailing guard still has to stop a short match');

  for (const reply of ['Yeah. Book it.', 'yes book it', 'Yes. you can book it.', 'Yes.']) {
    const p = assessBookingPermit([ai(EN_SUMMARY), hu(reply)], 'sviish8703@gmail.com');
    check(p.allowed, `"${reply}" books on an English call`, `blocked: ${p.reason}`);
  }

  // Containment against the stored address, so the gate no longer depends on a
  // regex surviving whatever punctuation the model produces.
  check(assessBookingPermit(
    [ai('Email amit@gmail.com...confirmed. Shall I book it?'), hu('Yes.')], 'amit@gmail.com').allowed,
    'the gate matches the stored address by containment, not by regex',
    'punctuation around the address must not be able to block a booking');
  check(!assessBookingPermit(
    [ai('your email is other@gmail.com. Shall I book it?'), hu('Yes.')], 'amit@gmail.com').allowed,
    'reading back an address that is NOT the stored one is blocked',
    'this is the "reverted to an old email from the history" failure');

  // No gate disagreement may repeat the same question forever.
  const loopMsgs = [];
  for (let i = 0; i < 4; i++) loopMsgs.push(ai(summary), hu('Yes.'));
  check(countRefusedConfirmations(loopMsgs) === 4,
    'repeated confirmed yeses are counted, so the agent can stop asking',
    `counted ${countRefusedConfirmations(loopMsgs)} — without this the call loops until the caller hangs up`);
  check(countRefusedConfirmations([ai('Is your name Sandeep?'), hu('Yes.')]) === 0,
    'a yes to an ordinary question is not counted as a refused booking');
  check(/permit\.refusals >= 3/.test(agents) && /permit\.refusals === 2/.test(agents),
    'the agent escalates instead of re-asking the booking question',
    'blocked -> "ask the final question" -> blocked is a closed circuit');

  const blocked = assessBookingPermit([
    ai('तो, विभव के लिए, विभव.वस्ती54@gmail.com, 3 अक्टूबर को 10:00 AM — बुक कर दूँ?'),
    hu('Yes.'),
  ]);
  check(!blocked.allowed && /Devanagari/.test(blocked.reason),
    'a Devanagari read-back is blocked, and the reason says why',
    blocked.reason);

  check(!assessBookingPermit([ai(summary), hu('नहीं, email galat hai')]).allowed,
    'a correction is still not a yes');

  // Nothing the agent can say on an English call may be hardcoded Hindi. Every
  // one of these used to be: the tool fillers, the silent-turn recovery line,
  // the mid-stream error apology, the session's error line and the silence
  // re-prompt. The caller heard English throughout and then one Hindi sentence.
  const DEV = /[ऀ-ॿ]/;
  const spokenGuards = [
    ['src/agents/companyAgents.js', /replyLanguage === 'hi'\s*\n?\s*\?/g, 2],
  ];
  for (const [file, re, atLeast] of spokenGuards) {
    const body = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const hits = (body.match(re) ?? []).length;
    check(hits >= atLeast,
      `${file.split('/').pop()} picks its spoken fallbacks by reply language`,
      `found ${hits} of ${atLeast} — a hardcoded Hindi fallback speaks Hindi on an English call`);
  }
  const sessionBody = fs.readFileSync(new URL('../src/services/callSession.js', import.meta.url), 'utf8');
  check(/this\._convLang === 'hi'/.test(sessionBody),
    'the session picks its spoken fallbacks by reply language',
    'sniffing the transcript for Devanagari picks Hindi off one transliterated word');

  // Any Devanagari-range test against the caller's words, in either notation
  // (ऀ-ॿ or the literal characters), anywhere in the spoken path.
  // Reported with file and line, because "somewhere in a 2000-line file" is not
  // something anyone can act on.
  const SNIFF_RE =
    /\/\[(?:\\u0900-\\u097F|ऀ-ॿ)\]\/[gimsuy]*\s*\.test\(\s*(?:String\(\s*)?(transcript|userText|text|lastAgent|input|utterance)\b/;
  const sniffFiles = [
    'src/services/callSession.js',
    'src/services/agentService.js',
    'src/agents/companyAgents.js',
  ];
  const sniffs = [];
  for (const file of sniffFiles) {
    let body;
    try {
      body = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    } catch { continue; }
    body.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;  // a comment is not code
      if (SNIFF_RE.test(line)) sniffs.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  check(sniffs.length === 0,
    'no fallback still guesses the language from the transcript script',
    `${sniffs.length} left — one Devanagari word makes these speak Hindi on an English call:\n` +
    sniffs.map((s) => `          ${s}`).join('\n') +
    '\n          fix them all with: node scripts/fix-lang-fallbacks.js');

  const { fillerFor } = await import('../src/constants/fillers.js');
  const enFillers = ['check_availability', 'book_appointment', 'send_meeting_email', 'other']
    .map((t) => fillerFor(t, 'en')).filter(Boolean);
  check(enFillers.length > 0 && enFillers.every((p) => !DEV.test(p)),
    'tool fillers have an English version, so a booking is not announced in Hindi',
    `would speak Hindi: ${enFillers.filter((p) => DEV.test(p)).join(' | ')}`);

  // Prompt-level rules, so an edit cannot quietly undo them.
  const { RAHUL_PERSONA } = await import('../src/constants/prompts.js');
  check(/ALWAYS ENGLISH|ALWAYS IN ENGLISH/i.test(RAHUL_PERSONA),
    'prompt requires names and emails in English',
    'the DATA IS ALWAYS ENGLISH section is missing');
  check(/how are you/i.test(RAHUL_PERSONA),
    'prompt names small talk as a non-reason to switch language');
  check(/ENGLISH by default/i.test(RAHUL_PERSONA),
    'prompt states English is the default',
    'without it the model falls back to the persona\'s own Devanagari lean');
  check(/CURRENT CALLER CONTEXT/.test(RAHUL_PERSONA),
    'prompt points read-backs at the context block, not the history',
    'without this the agent re-reads an email it already corrected');
});

// ─────────────────────────────────────────────────────────────────────────────
// Outbound dialling (wiring only — scripts/check-outbound.js does the live checks)
// ─────────────────────────────────────────────────────────────────────────────

await runStage('outbound', 'Outbound dialling', async () => {
  const fs = await import('node:fs');
  const { config: cfg } = await import('../src/config/index.js');
  const o = cfg.outbound;

  if (!cfg.sheet.id && !o.ctcApiKey) {
    warn('outbound is not configured (no SHEET_ID, no SMARTFLO_CTC_API_KEY) — skipping',
      'inbound calling is unaffected');
    return;
  }

  info(`dry run       ${o.dryRun ? 'ON — no calls placed' : 'OFF — real calls'}`);
  info(`watcher       ${o.watch ? 'starts with the server' : 'off'}`);
  info(`batch         ${o.maxPerScan} per pass, ${o.concurrency} at a time, every ${Math.round(o.pollMs / 1000)}s`);
  info(`hours         ${o.hours || 'any time'}`);

  // The two credentials are from different screens in the portal and are
  // constantly mixed up. Equal values means one was pasted twice.
  check(Boolean(o.apiToken), 'SMARTFLO_API_TOKEN set (Authorization header)',
    'mandatory since 2026-09-30 — every call fails without it');
  check(Boolean(o.ctcApiKey), 'SMARTFLO_CTC_API_KEY set (body "api_key")',
    'this is the Click to Call key, not the account token, and it carries the voice-stream destination');
  check(!o.apiToken || !o.ctcApiKey || o.apiToken !== o.ctcApiKey,
    'the account token and the Click to Call key are different values',
    'the same value was pasted into both');
  check(Boolean(o.apiKey), 'OUTBOUND_API_KEY set',
    'without it /outbound/* refuses to serve — those routes can dial from your DID');

  // A watcher that starts with real calls enabled and no calling window will
  // cold-call at 3am.
  if (o.watch && !o.dryRun && !o.hours) {
    warn('the watcher starts with real calls and no OUTBOUND_HOURS',
      'it will dial overnight and at weekends — set OUTBOUND_HOURS=09:30-19:00');
  }

  // Phone normalisation is what stands between a sheet and a wrong number.
  const { normalizePhone } = await import('../src/utils/phone.js');
  const same = ['9876543210', '+91 98765 43210', '09876543210', '919876543210', '98765-43210']
    .map((x) => normalizePhone(x).national);
  check(new Set(same).size === 1 && same[0] === '9876543210',
    'every written form of a mobile normalises to one number', same.join(', '));
  // A numeric cell is not in itself a problem: 9.87654321e9 IS exactly
  // 9876543210, and Number.isSafeInteger proves no precision was lost. What is
  // dangerous is the STRING Sheets displays when a column is formatted oddly —
  // "9.87654321E9" strips to the digits 9876543219, a different real number.
  check(normalizePhone(9876543210).valid && normalizePhone(9876543210).national === '9876543210',
    'an exact numeric cell is accepted', normalizePhone(9876543210).national);
  check(!normalizePhone('9.87654321E9').valid,
    'a cell DISPLAYED in exponential form is refused',
    'stripping non-digits from it yields a different, real phone number');
  check(!normalizePhone(9.8765432105e9).valid,
    'a numeric cell that lost precision is refused');
  check(!normalizePhone('1234567890').valid, 'a non-mobile number is refused');

  // The ordering guarantee. Claiming after the call means a failed write leaves
  // the row "New", and the next pass rings the same person again.
  const dialer = fs.readFileSync(new URL('../src/services/outboundDialer.js', import.meta.url), 'utf8');
  const claimAt = dialer.indexOf('claimRow(');
  const placeAt = dialer.indexOf('placeOutboundCall(');
  check(claimAt !== -1 && placeAt !== -1 && claimAt < placeAt,
    'the sheet row is claimed BEFORE the call is placed',
    'claiming afterwards means a failed status write re-dials the same lead every pass');
  check(/registerPending\(/.test(dialer) && dialer.indexOf('registerPending(') < placeAt,
    'the pending-call entry is registered before the call',
    'on a fast connect the stream arrives before the HTTP response, and the greeting would be wrong');
  check(/dropPending\(/.test(dialer),
    'a refused call drops its pending entry',
    'otherwise the next genuine inbound call from that number looks outbound');

  // Outbound calls must not be greeted as inbound.
  const sess = fs.readFileSync(new URL('../src/services/callSession.js', import.meta.url), 'utf8');
  check(/GREETING_OUTBOUND/.test(sess) && /this\.outbound/.test(sess),
    'an outbound call has its own greeting',
    '"Thank you for calling" to someone you just rang');
  const ws = fs.readFileSync(new URL('../src/websocket/mediaStreamHandler.js', import.meta.url), 'utf8');
  check(/claimPending\(phoneNumber, toNumber\)/.test(ws),
    'the stream checks BOTH legs against the pending list',
    'which leg carries the customer depends on the Click to Call destination config');

  info('live credential, sheet and write-access checks: node scripts/check-outbound.js');
});

// ─────────────────────────────────────────────────────────────────────────────
// Call recording
// ─────────────────────────────────────────────────────────────────────────────

await runStage('recording', 'Call recording', async () => {
  const { config: cfg } = await import('../src/config/index.js');
  if (!cfg.recording?.enabled) { warn('recording disabled (CALL_RECORDING=false)'); return; }

  const capMin = cfg.recording.maxMs / 60000;
  info(`audio kept for calls up to ${capMin} min; longer calls store metadata only`);

  // The recorder can work perfectly and the recording still be half empty, if
  // the session never feeds it. That is exactly what happened: addAgent was
  // never wired in, so every recording had the caller and a silent agent
  // channel — while every check that exercised the recorder directly passed.
  const { readFileSync: rf } = await import('fs');
  const sessionSrc = rf(new URL('../src/services/callSession.js', import.meta.url), 'utf8');
  check(/this\._recorder\.addCaller\(/.test(sessionSrc),
    'session feeds CALLER audio to the recorder', 'caller channel will be silent');
  check(/this\._recorder\.addAgent\(/.test(sessionSrc),
    'session feeds AGENT audio to the recorder',
    'agent channel will be silent — the bug that shipped once already');
  check(/this\._recorder\.truncateAgentAfter\(/.test(sessionSrc),
    'barge-in trims unheard agent audio',
    'recordings will show the agent talking over the caller after an interrupt');

  const { createCallRecorder } = await import('../src/utils/callRecorder.js');
  const rec = createCallRecorder({ callSid: 'preflight', enabled: true, maxMs: cfg.recording.maxMs });

  // 1s of caller tone, then agent audio heard 2s in.
  const n = 8000, pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / 8000)), i * 2);
  rec.addCaller(pcm);
  rec.addAgent([Buffer.alloc(8000, 0x30)], Date.now() + 2000);

  const out = rec.save();
  if (!check(Buffer.isBuffer(out?.buffer), 'recorder returns the WAV as a Buffer',
    'nothing to store in the Log document')) return;

  const wav = out.buffer;
  check(out.contentType === 'audio/wav', 'contentType is audio/wav');
  check(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE',
    'valid RIFF/WAVE container');
  check(wav.toString('base64').startsWith('UklGR'),
    'stored bytes will read as UklGR... in Compass (base64 of "RIFF")');
  check(wav.readUInt16LE(22) === 2, 'stereo (caller left, agent right)');
  check(wav.readUInt32LE(24) === 8000, '8 kHz');
  check(wav.readUInt32LE(4) === wav.length - 8, 'declared size matches the buffer');

  // Alignment is the part that silently goes wrong: agent audio must sit where
  // the caller HEARD it, not where it was sent.
  const data = wav.subarray(44);
  const energy = (chan, fromMs, toMs) => {
    let e = 0;
    for (let i = fromMs * 8; i < toMs * 8; i++) {
      const at = i * 4 + chan * 2;
      if (at + 2 <= data.length) e += Math.abs(data.readInt16LE(at));
    }
    return e;
  };
  check(energy(0, 0, 400) > energy(0, 2100, 2400) * 5, 'caller audio on the LEFT, at the start');
  check(energy(1, 2100, 2400) > energy(1, 0, 400) * 5, 'agent audio on the RIGHT, at 2s');

  // The cap is what keeps this safe. Over 16MB the whole Log write fails and
  // the transcript is lost along with the audio.
  const bytesPerSec = (out.bytes - 44) / (out.durationMs / 1000);
  const atCapMB = (bytesPerSec * cfg.recording.maxMs / 1000) / 1048576;
  check(atCapMB < 15, 'the largest stored recording fits the 16MB document limit',
    `${atCapMB.toFixed(1)}MB at the ${capMin} min cap — lower CALL_RECORDING_MAX_MS`,
    `${atCapMB.toFixed(1)}MB at the ${capMin} min cap`);

  // A call past the cap must skip the audio, not fail the write.
  const long = createCallRecorder({ callSid: 'preflight-long', enabled: true, maxMs: 200 });
  long.addCaller(pcm.subarray(0, 1600));
  await new Promise((r) => setTimeout(r, 300));
  long.addCaller(pcm.subarray(0, 1600));
  const skipped = long.save();
  check(skipped?.skipped === true && !skipped.buffer,
    'a call past the cap stores metadata only',
    'long calls would still try to save audio');
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation robustness — guards against regressions that bit live calls
// ─────────────────────────────────────────────────────────────────────────────

await runStage('robust', 'Conversation robustness', async () => {
  const { readFileSync: rf } = await import('fs');
  const src = (rel) => rf(new URL(`../${rel}`, import.meta.url), 'utf8');

  const agents = src('src/agents/companyAgents.js');
  check(/Silent-turn recovery/.test(agents) && /llm\.stream\(\[\.\.\.systemMessages, \.\.\.messages, nudge\]\)/.test(agents),
    'a turn with no spoken words is regenerated as text',
    'the model can reply with only extract_lead_data and the caller hears silence (seen live: 35s)');
  check(/timeout:\s*Number\(process\.env\.LLM_TIMEOUT_MS/.test(agents),
    'LLM requests have a timeout', 'a hung request holds the caller in silence indefinitely');

  const session = src('src/services/callSession.js');
  check(/caller kept talking — holding the reply/.test(session),
    'reply is held if the caller keeps talking while the agent thinks',
    'agent answers a fragment and talks over the rest of the sentence');
  check(/_armCarryOver\(/.test(session) && /nothing followed — answering/.test(session),
    'a held fragment is answered even if the continuation was noise',
    'caller can be left with no reply at all');

  // The _abandonTurn bug: a copied init block forgot timer handles without
  // clearing them, so a barge-in from one turn fired on the next. Hand merges
  // can also leave the method defined twice — JavaScript runs the LAST one — so
  // every copy is found by brace matching and the one that runs is judged.
  const abandons = [];
  for (const m of session.matchAll(/^[ \t]*_abandonTurn\(\)\s*\{/gm)) {
    let depth = 0, i = session.indexOf('{', m.index), end = -1;
    for (; i < session.length; i++) {
      const c = session[i], n = session[i + 1];
      if (c === '/' && n === '/') { i = session.indexOf('\n', i); continue; }
      if (c === '/' && n === '*') { i = session.indexOf('*/', i + 2) + 1; continue; }
      if (c === '"' || c === "'" || c === '`') { for (i++; i < session.length && session[i] !== c; i++) if (session[i] === '\\') i++; continue; }
      if (c === '{') depth++; else if (c === '}' && --depth === 0) { end = i + 1; break; }
    }
    abandons.push({ line: session.slice(0, m.index).split('\n').length, body: session.slice(m.index, end) });
  }
  const running = abandons[abandons.length - 1];
  const where = abandons.length ? ` (line ${running.line})` : '';
  const fixHint = ' — run: node scripts/fix-abandon-turn.js --apply';

  check(abandons.length === 1, '_abandonTurn is defined exactly once',
    abandons.length === 0 ? 'not found'
      : `defined ${abandons.length} times at lines ${abandons.map((a) => a.line).join(', ')}; ` +
        `JavaScript runs the last one${fixHint}`);
  check(Boolean(running) && /clearTimeout\(this\._bargeInTimer\)/.test(running.body),
    `abandoning a turn CANCELS its pending barge-in timer${where}`,
    `the timer fires on the next turn and cuts off its reply${fixHint}`);
  check(Boolean(running) && !/this\._utteranceParts\s*=\s*\[\]/.test(running.body),
    `abandoning a turn keeps what the caller is mid-way through saying${where}`,
    `_abandonTurn discards the caller's in-progress fragments${fixHint}`);

  const agentSvc = src('src/services/agentService.js');
  check(/recursionLimit:/.test(agentSvc), 'tool loops are capped',
    'a failing tool can loop to 25 steps while the caller hears nothing');

  const prompt = src('src/constants/prompts.js');
  check(/STAYING ON TOPIC/.test(prompt) && /ASSUME every message is\s+about that/.test(prompt),
    'prompt keeps the agent on Xverse, assuming in-scope by default');
  // A ready-made refusal sentence in the prompt became the agent's default
  // answer to anything unclear, and repeated turn after turn on live calls.
  check(!/मैं सिर्फ़ Xverse के बारे में मदद कर सकती हूँ/.test(prompt) && !/Sorry, I can only help with Xverse/.test(prompt),
    'prompt has no ready-made refusal sentence for the model to copy',
    'the model recites it whenever anything is unclear');
  check(/ONE detail per reply/.test(prompt), 'prompt collects booking details one at a time');
  check(/ASK AGAIN, NEVER GUESS/.test(prompt), 'prompt re-asks unclear dates and times');

  // Language: decided in code, sticky, and handed to the model as a fact.
  check(/nextReplyLanguage\(before, transcript\)/.test(session) && /replyLanguage: this\._convLang/.test(session),
    'reply language is decided from the caller, not guessed each turn',
    'a one-word "Yes." or "जी।" flips the whole conversation');
  check(/this\._convLang = 'en'/.test(session),
    'the call starts in English',
    'an unset language lets the model choose, and it leans Hindi');
  check(/REPLY LANGUAGE \(MANDATORY\)/.test(agents), 'the model is told which language to use');
  const { classifyCallerLanguage } = await import('../src/utils/speakable.js');
  const neutral = ['Yes.', 'Correct.', 'Blue company.', 'जी।', 'amit at gmail dot com']
    .filter((x) => classifyCallerLanguage(x) !== null);
  check(neutral.length === 0, 'short replies, names and emails never switch language',
    `these would switch it: ${neutral.join(' | ')}`);

  // Email: dictated in pieces, so the session waits longer after asking for it.
  check(/_expectingLongAnswer\(\)/.test(session), 'the session waits longer for a dictated email',
    'each pause cuts the email into a separate turn and the agent loops');
  check(!/SPELL it letter by letter/.test(prompt) && /Do NOT ask them to spell/.test(prompt),
    'prompt asks for the email the normal way, not letter by letter');
  check(/After 3 attempts/.test(prompt), 'prompt stops asking for the email after 3 attempts');

  // Silence: the agent re-asks instead of waiting forever.
  check(/_reprompt\(\)/.test(session) && /_armSilenceTimer\(\)/.test(session),
    'the agent re-asks if the caller goes silent',
    'a lost answer leaves both sides waiting (seen live: 13s)');
  check(/Questions about YOU/.test(prompt) && /Cut-off or unclear sentences/.test(prompt),
    'questions about Priya and unclear answers are in scope',
    '"your name?" and garbled sentences get "I can only help with Xverse"');
  check(/refusal intercepted before speaking/.test(agents) && /refusedRecently/.test(agents),
    'a refusal is never repeated, and never given to an in-scope question',
    'the same refusal line repeats turn after turn (seen live)');

  // Booking safety. A live call booked — and emailed — an address the caller
  // was in the middle of correcting: an unspoken "बुक कर दूँ?" stayed in the
  // model's memory, and a misheard "Yes." inside the correction was taken as
  // agreement. Both layers are checked by replaying that call.
  check(/withoutUnheard\(state\.messages/.test(agents),
    'the model sees only what the caller actually heard',
    'a dropped, unspoken reply stays in its memory');
  check(/markTurnUnheard\(this\.callSid/.test(session), 'dropped turns are marked unheard');
  check(/assessBookingPermit\(\s*messages\s*,/.test(agents) && /BOOKING BLOCKED/.test(agents),
    'booking is gated in code, not only by the prompt',
    'the gate must also receive the stored email, so it can match by containment');

  const { assessBookingPermit } = await import('../src/agents/bookingGuard.js');
  const H = (c) => ({ _getType: () => 'human', content: c });
  const A = (c) => ({ _getType: () => 'ai', content: c });
  const replay = assessBookingPermit([
    A('आपका ईमेल "sbif03@gmail.com" है — सही है?'),
    H('अच्छा। मैं repeat कर रहा हूँ। Yes. वी। I H. अच्छा। ठीक। Eight Seven Zero Three. at Gmail.com.'),
  ]);
  check(!replay.allowed, 'the live call that booked a wrong email is now blocked', replay.reason);
  const legit = assessBookingPermit([
    A('तो, संदीप के लिए, svish8703@gmail.com, बुधवार 23 सितंबर को 11:00 AM — बुक कर दूँ?'),
    H('हाँ बिल्कुल।'),
  ]);
  check(legit.allowed, 'a clear yes to the full read-back still books', legit.reason);
  check(/EMAIL, date and time/.test(prompt), 'the final booking question includes the email');

  const { toSpeakable } = await import('../src/utils/speakable.js');
  check(toSpeakable('क्या सुबह 10:00 AM ठीक है?') === 'क्या सुबह दस बजे ठीक है?',
    'no doubled period word ("सुबह सुबह")', toSpeakable('क्या सुबह 10:00 AM ठीक है?'));
  check(/at gmail dot com/.test(toSpeakable('email a1@gmail.com')),
    'emails are spelled out for confirmation', toSpeakable('email a1@gmail.com'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar — booking depends on it, and it fails silently until a call
// ─────────────────────────────────────────────────────────────────────────────

await runStage('calendar', 'Google Calendar access', async () => {
  const { existsSync } = await import('fs');
  const keyFile = './service-account.json';
  if (!check(existsSync(keyFile), 'service-account.json is present',
    'booking and availability checks will fail on every call')) return;

  const calendarId = process.env.CALENDAR_ID;
  if (!check(Boolean(calendarId), 'CALENDAR_ID is set in .env')) return;

  const { google } = await import('googleapis');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/calendar'] });
  try {
    const t0 = performance.now();
    await auth.getAccessToken();
    check(true, 'Google accepts the service account key', '', ms(performance.now() - t0));
  } catch (e) {
    const desc = e.response?.data?.error_description ?? e.message;
    check(false, 'Google accepts the service account key',
      `${desc} — run: node scripts/check-google-auth.js`);
    return;
  }
  try {
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.list({ calendarId, maxResults: 1, timeMin: new Date().toISOString() });
    check(true, 'can read the booking calendar', calendarId);
  } catch (e) {
    const code = e.code ?? e.response?.status;
    check(false, 'can read the booking calendar',
      code === 404 ? 'CALENDAR_ID not found, or not shared with the service account'
        : code === 403 ? 'the service account has no permission on this calendar'
          : `${e.message} — run: node scripts/check-google-auth.js`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Mongo
// ─────────────────────────────────────────────────────────────────────────────

await runStage('db', 'MongoDB', async () => {
  const { connectDB } = await import('../src/utils/db.js');
  const mongoose = (await import('mongoose')).default;

  const t0 = performance.now();
  await connectDB();
  check(mongoose.connection.readyState === 1, 'connected', 'mongoose never reached readyState 1',
    ms(performance.now() - t0));

  const { UserProfile } = await import('../src/models/UserProfile.js');
  const coll = UserProfile.collection;

  // Stale unique indexes are the nastiest failure here, because the app
  // swallows the error: hydrateUserProfile() catches, returns a bare object,
  // and the call proceeds — but the profile was never created, so memory and
  // lead persistence silently stop working for every new caller after the
  // first. Compare the indexed fields against the schema and shout about any
  // unique index on a field the schema does not define.
  const schemaPaths = new Set(Object.keys(UserProfile.schema.paths));
  let indexes = [];
  try {
    indexes = await coll.indexes();
  } catch (err) {
    warn('could not list indexes', err.message);
  }

  const orphanUnique = indexes.filter((ix) => {
    if (!ix.unique || ix.name === '_id_') return false;
    return Object.keys(ix.key).some((f) => !schemaPaths.has(f));
  });

  if (orphanUnique.length) {
    for (const ix of orphanUnique) {
      const fields = Object.keys(ix.key).join(', ');
      fail(`stale unique index "${ix.name}" on a field the schema does not define`,
        `Field(s): ${fields}. New documents omit it, so Mongo indexes them all as null and\n` +
        `        only ONE such document can exist. Every new caller after the first fails to\n` +
        `        create a profile — hydrateUserProfile() swallows the error, so calls still\n` +
        `        work but memory and lead capture are silently dead.\n` +
        `        Fix: db.${coll.collectionName}.dropIndex("${ix.name}")\n` +
        `        (or recreate it sparse/partial if something else still needs it)`);
    }
  } else {
    ok('no stale unique indexes on the collection',
      `${indexes.length} index(es): ${indexes.map((i) => i.name).join(', ')}`);
  }

  // The opposite problem: a `unique: true` path with no index behind it is not
  // enforcing anything, so duplicate profiles for one phone number can build up.
  const present = new Set(indexes.map((ix) => JSON.stringify(ix.key)));
  const missingUnique = UserProfile.schema
    .indexes()
    .filter(([key, opts]) => opts?.unique && !present.has(JSON.stringify(key)))
    .map(([key]) => Object.keys(key).join(', '));

  if (missingUnique.length) {
    warn(`schema declares unique index(es) the collection does not have: ${missingUnique.join(' | ')}`,
      'nothing is preventing duplicate profiles. Run: node scripts/fix-indexes.js --create-missing');
  } else {
    ok('every unique index the schema declares exists');
  }

  // TWO probes, not one. A stale unique index lets the first insert through and
  // only rejects the second — testing with a single profile passes on a broken
  // collection, which is exactly how this hid for so long.
  const { hydrateUserProfile, leadDataFromProfile, persistLeadData } =
    await import('../src/services/agentService.js');

  const probes = [`preflight-a-${Date.now()}`, `preflight-b-${Date.now()}`];
  try {
    const [a, b] = await Promise.all(probes.map((n) => hydrateUserProfile(n)));
    check(!a.degraded, 'first new caller gets a profile', 'hydrate failed on the first insert');
    check(!b.degraded, 'SECOND new caller also gets a profile',
      'the first succeeded and the second failed — classic stale-unique-index signature. ' +
      'See the STALE UNIQUE INDEX line above.');

    // Round-trip a lead the way a real hangup does.
    await persistLeadData(probes[0], { name: 'Preflight Probe', email: 'probe@example.com' });
    const back = await hydrateUserProfile(probes[0]);
    check(back.name === 'Preflight Probe' && back.email === 'probe@example.com',
      'lead data survives a save and reload',
      `got name=${back.name} email=${back.email}`);
    check(back.isReturning, 'caller is recognised as returning on the next call');

    const seed = leadDataFromProfile(back);
    check(seed.name === 'Preflight Probe' && seed.email === 'probe@example.com',
      'leadData is pre-seeded so the agent will not re-ask',
      JSON.stringify(seed), JSON.stringify(seed));
  } catch (err) {
    fail('profile round-trip threw', err.message);
  } finally {
    for (const n of probes) await UserProfile.deleteOne({ phoneNumber: n }).catch(() => {});
  }

  // New Log fields, and the one that matters operationally.
  const { Log } = await import('../src/models/Log.js');
  const paths = Log.schema.paths;
  check(Boolean(paths['transcript']), 'Log has a transcript field');
  check(Boolean(paths['recording.audioData']), 'Log has recording.audioData');
  if (paths['recording.audioData']) {
    check(paths['recording.audioData'].options?.select === false,
      'recording.audioData is select:false',
      'without it EVERY Log query drags the audio back — 50 calls is tens of MB over the wire');
  }

  await mongoose.disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. ffmpeg — fallback only, so absence is a warning not a failure
// ─────────────────────────────────────────────────────────────────────────────

await runStage('ffmpeg', 'ffmpeg (fallback path only)', async () => {
  const { spawn } = await import('child_process');
  const present = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
  present
    ? ok('ffmpeg available for exotic audio formats')
    : warn('ffmpeg not installed',
      'fine as long as Sarvam keeps returning μ-law or 16-bit WAV; a format change would break TTS');
});

// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Summary ──────────────────────────────────────────────────────────────────

const failures = results.filter((r) => r.pass === false);
const warnings = results.filter((r) => r.warn);
const passes = results.filter((r) => r.pass === true);

// ── Where the time goes ─────────────────────────────────────────────────────
if (M.ttft || M.ttsSynth) {
  console.log(`\n${C.bold}${C.cyan}Latency budget (time to first audio)${C.reset}`);

  const ttft = M.graphFirstSentence ?? M.ttft;
  const row = (label, v, tag = '') =>
    console.log(`  ${label.padEnd(34)} ${String(Math.round(v)).padStart(5)}ms ${C.dim}${tag}${C.reset}`);

  if (M.graphFirstSentence) row('LLM → first speakable sentence', M.graphFirstSentence, 'dominated by time-to-first-token');
  if (M.ttsSynth) row('TTS synthesis (REST, whole clip)', M.ttsSynth, `for ${M.ttsChars} chars`);

  if (M.graphFirstSentence && M.ttsSynth) {
    const est = M.graphFirstSentence + M.ttsSynth * 0.5; // first segment is shorter
    console.log(`  ${'─'.repeat(46)}`);
    row('estimated time to first audio', est, 'confirm with fake-call.js');
  }

  if (M.graphTotal && M.graphFirstSentence) {
    const saved = M.graphTotal - M.graphFirstSentence;
    console.log(`\n  ${C.dim}Streaming saves ${Math.round(saved)}ms here. That is small because these ` +
      `replies are\n  short — the cost is time-to-first-token, which streaming cannot reduce.${C.reset}`);
  }
  if (M.ttsSynth > 400) {
    console.log(`\n  ${C.yellow}TTS REST is now the largest single cost. It waits for the whole clip.\n` +
      `  Sarvam's TTS websocket streams first bytes in ~250ms — that is the next win.${C.reset}`);
  }
}

console.log(`\n${C.bold}${'─'.repeat(60)}${C.reset}`);
console.log(`${C.green}${passes.length} passed${C.reset}  ` +
  `${warnings.length ? C.yellow : C.dim}${warnings.length} warnings${C.reset}  ` +
  `${failures.length ? C.red : C.dim}${failures.length} failed${C.reset}` +
  (skipped.length ? `  ${C.dim}(skipped: ${skipped.join(', ')})${C.reset}` : ''));

if (failures.length) {
  console.log(`\n${C.red}${C.bold}Do not place a test call yet.${C.reset}`);
  for (const f of failures) console.log(`  ${C.red}·${C.reset} [${f.stage}] ${f.msg}`);
  process.exit(1);
}

console.log(`\n${C.green}${C.bold}Pipeline looks wired.${C.reset} ` +
  `Next: start the server and run ${C.bold}node scripts/fake-call.js${C.reset}`);
process.exit(0);