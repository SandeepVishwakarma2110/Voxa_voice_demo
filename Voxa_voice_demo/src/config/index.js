// import 'dotenv/config';

// const required = (key) => {
//   if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
//   return process.env[key];
// };

// export const config = {
//   port:    parseInt(process.env.PORT || '3000', 10),
//   baseUrl: required('BASE_URL'),

//   // Call recording: a stereo WAV (caller left, agent right) stored in the Log
//   // document as Binary.
//   //
//   // maxMs is the longest call whose audio is kept. Past it the audio is dropped
//   // and only metadata is saved. 5 min of stereo PCM16 is ~9.2MB, comfortably
//   // inside MongoDB's 16MB document limit — above ~8.7 min the whole Log write
//   // would fail, costing the transcript as well as the audio.
//   recording: {
//     enabled: process.env.CALL_RECORDING !== 'false',
//     maxMs: Number(process.env.CALL_RECORDING_MAX_MS ?? 5 * 60_000),
//   },

//   // Smartflo does not authenticate its webhooks and issues no API credentials
//   // for streaming, so nothing here is required. The number is informational.
//   smartflo: {
//     phoneNumber: process.env.SMARTFLO_PHONE_NUMBER || '',
//   },

//   // Which recognizer the call path uses. 'deepgram' = Flux (turn-based,
//   // ~260ms end-of-turn); 'sarvam' = saaras:v4. Set STT_PROVIDER=sarvam to go
//   // back without touching code.
//   stt: {
//     provider: (process.env.STT_PROVIDER || 'deepgram').toLowerCase(),
//   },

//   deepgram: {
//     // Only required when it is the active provider, so a Sarvam-only
//     // deployment still boots.
//     apiKey: (process.env.STT_PROVIDER || 'deepgram').toLowerCase() === 'deepgram'
//       ? required('DEEPGRAM_API_KEY')
//       : (process.env.DEEPGRAM_API_KEY || ''),
//     stt: {
//       // flux-general-multi covers Hindi + English code-switching, which is what
//       // this agent hears. flux-general-en is marginally faster if the line ever
//       // becomes English-only.
//       model: process.env.DEEPGRAM_MODEL || 'flux-general-multi',
//       // Repeatable language hints, multilingual model only. Biases detection;
//       // does not lock the recognizer to these.
//       languageHints: (process.env.DEEPGRAM_LANGUAGE_HINTS || 'hi,en')
//         .split(',').map((s) => s.trim()).filter(Boolean),
//       sampleRate: 8000,
//       // 0.5-1.0, default 0.7. Lower ends turns sooner at the risk of cutting
//       // a caller off mid-thought; 1.0 disables model-based detection entirely.
//       eotThreshold: Number(process.env.DEEPGRAM_EOT_THRESHOLD ?? 0.7),
//       // 500-60000, Deepgram's default is 5000. 3000 matches their
//       // rapid-response guidance — this is the silence backstop for when the
//       // model never gets confident, and 5s of dead air on a phone call is a
//       // caller hanging up.
//       eotTimeoutMs: Number(process.env.DEEPGRAM_EOT_TIMEOUT_MS ?? 3000),
//       // 0.3-0.9. Unset = off. Enables EagerEndOfTurn/TurnResumed.
//       eagerEotThreshold: process.env.DEEPGRAM_EAGER_EOT_THRESHOLD
//         ? Number(process.env.DEEPGRAM_EAGER_EOT_THRESHOLD)
//         : null,
//     },
//   },

//   sarvam: {
//     apiKey: process.env.SARVAM_API_KEY || '',
//     stt: {
//       model: 'saaras:v4', // Latest low-latency STT model
//       language: 'hi-IN',  // Change to 'en-IN' for English specifically, or keep 'hi-IN' for Hinglish
//       sampleRate: 8000
//     },
//     // TTS moved to ElevenLabs; this block is kept solely so
//     // scripts/bench-turn.js and scripts/bench-tts.js can still compare against
//     // Sarvam. Nothing in the call path reads it.
//     tts: {
//       model: 'bulbul:v3', // Lowest latency TTS equivalent to ElevenLabs Turbo
//       voice: 'rahul',     // Supported built-in Indian male voice 
//       language: 'hi-IN',  // Target output language
//     }
//   },
  

//   elevenlabs: {
//     // Required: there is no second TTS engine to fall back to, so a missing
//     // key should stop the process at boot rather than surface as silence on a
//     // live call.
//     apiKey:  required('ELEVENLABS_API_KEY'),
//     voiceId: required('ELEVENLABS_VOICE_ID'),
//     // Flash v2.5 is the low-latency model; Turbo v2.5 trades ~150ms for quality.
//     model:   process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
//     // Flash v2.5 accepts an explicit language code — pinning it stops the model
//     // guessing on Hinglish, where a Devanagari/Latin mix is genuinely ambiguous.
//     languageCode: process.env.ELEVENLABS_LANGUAGE_CODE || 'hi',
//     stability:        process.env.ELEVENLABS_STABILITY ? Number(process.env.ELEVENLABS_STABILITY) : null,
//     similarityBoost:  process.env.ELEVENLABS_SIMILARITY ? Number(process.env.ELEVENLABS_SIMILARITY) : null,
//     speed:            process.env.ELEVENLABS_SPEED ? Number(process.env.ELEVENLABS_SPEED) : null,
//   },

//   openai: {
//     apiKey: required('OPENAI_API_KEY'),
//     // gpt-4o-mini for both the agent and the lead extractor — fast + cheap
//     model:  process.env.OPENAI_MODEL || 'gpt-4o-mini',
//   },

//   mongodb: {
//     uri: required('MONGODB_URI'),
//   },

//   smtp: {
//     user: process.env.EMAIL_USER || '',
//     pass: process.env.EMAIL_PASS || '',
//     admin: process.env.EMAIL_ADMIN || '',
//   },

//   calendar: {
//     calendarId: process.env.CALENDAR_ID || '',
//   },

//   session: {
//     timeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES || '10', 10),
//   },
// };



import 'dotenv/config';

const required = (key) => {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  return process.env[key];
};

export const config = {
  port:    parseInt(process.env.PORT || '3000', 10),
  baseUrl: required('BASE_URL'),

  // Call recording: a stereo WAV (caller left, agent right) stored in the Log
  // document as Binary.
  //
  // maxMs is the longest call whose audio is kept. Past it the audio is dropped
  // and only metadata is saved. 5 min of stereo PCM16 is ~9.2MB, comfortably
  // inside MongoDB's 16MB document limit — above ~8.7 min the whole Log write
  // would fail, costing the transcript as well as the audio.
  recording: {
    enabled: process.env.CALL_RECORDING !== 'false',
    maxMs: Number(process.env.CALL_RECORDING_MAX_MS ?? 5 * 60_000),
  },

  // Smartflo does not authenticate its webhooks and issues no API credentials
  // for streaming, so nothing here is required. The number is informational.
  smartflo: {
    phoneNumber: process.env.SMARTFLO_PHONE_NUMBER || '',
  },

  // Which recognizer the call path uses. 'deepgram' = Flux (turn-based,
  // ~260ms end-of-turn); 'sarvam' = saaras:v4. Set STT_PROVIDER=sarvam to go
  // back without touching code.
  stt: {
    provider: (process.env.STT_PROVIDER || 'deepgram').toLowerCase(),
  },

  deepgram: {
    // Only required when it is the active provider, so a Sarvam-only
    // deployment still boots.
    apiKey: (process.env.STT_PROVIDER || 'deepgram').toLowerCase() === 'deepgram'
      ? required('DEEPGRAM_API_KEY')
      : (process.env.DEEPGRAM_API_KEY || ''),
    stt: {
      // flux-general-multi covers Hindi + English code-switching, which is what
      // this agent hears. flux-general-en is marginally faster if the line ever
      // becomes English-only.
      model: process.env.DEEPGRAM_MODEL || 'flux-general-multi',
      // Repeatable language hints, multilingual model only. Biases detection;
      // does not lock the recognizer to these.
      languageHints: (process.env.DEEPGRAM_LANGUAGE_HINTS || 'hi,en')
        .split(',').map((s) => s.trim()).filter(Boolean),
      sampleRate: 8000,
      // 0.5-1.0, default 0.7. Lower ends turns sooner at the risk of cutting
      // a caller off mid-thought; 1.0 disables model-based detection entirely.
      eotThreshold: Number(process.env.DEEPGRAM_EOT_THRESHOLD ?? 0.7),
      // 500-60000, Deepgram's default is 5000. 3000 matches their
      // rapid-response guidance — this is the silence backstop for when the
      // model never gets confident, and 5s of dead air on a phone call is a
      // caller hanging up.
      eotTimeoutMs: Number(process.env.DEEPGRAM_EOT_TIMEOUT_MS ?? 3000),
      // 0.3-0.9. Unset = off. Enables EagerEndOfTurn/TurnResumed.
      eagerEotThreshold: process.env.DEEPGRAM_EAGER_EOT_THRESHOLD
        ? Number(process.env.DEEPGRAM_EAGER_EOT_THRESHOLD)
        : null,
    },
  },

  sarvam: {
    apiKey: process.env.SARVAM_API_KEY || '',
    stt: {
      model: 'saaras:v4', // Latest low-latency STT model
      language: 'hi-IN',  // Change to 'en-IN' for English specifically, or keep 'hi-IN' for Hinglish
      sampleRate: 8000
    },
    // TTS moved to ElevenLabs; this block is kept solely so
    // scripts/bench-turn.js and scripts/bench-tts.js can still compare against
    // Sarvam. Nothing in the call path reads it.
    tts: {
      model: 'bulbul:v3', // Lowest latency TTS equivalent to ElevenLabs Turbo
      voice: 'rahul',     // Supported built-in Indian male voice 
      language: 'hi-IN',  // Target output language
    }
  },
  

  elevenlabs: {
    // Required: there is no second TTS engine to fall back to, so a missing
    // key should stop the process at boot rather than surface as silence on a
    // live call.
    apiKey:  required('ELEVENLABS_API_KEY'),
    voiceId: required('ELEVENLABS_VOICE_ID'),
    // Flash v2.5 is the low-latency model; Turbo v2.5 trades ~150ms for quality.
    model:   process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
    // Flash v2.5 accepts an explicit language code — pinning it stops the model
    // guessing on Hinglish, where a Devanagari/Latin mix is genuinely ambiguous.
    languageCode: process.env.ELEVENLABS_LANGUAGE_CODE || 'hi',
    stability:        process.env.ELEVENLABS_STABILITY ? Number(process.env.ELEVENLABS_STABILITY) : null,
    similarityBoost:  process.env.ELEVENLABS_SIMILARITY ? Number(process.env.ELEVENLABS_SIMILARITY) : null,
    speed:            process.env.ELEVENLABS_SPEED ? Number(process.env.ELEVENLABS_SPEED) : null,
  },

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    // gpt-4o-mini for both the agent and the lead extractor — fast + cheap
    model:  process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  mongodb: {
    uri: required('MONGODB_URI'),
  },

  smtp: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    admin: process.env.EMAIL_ADMIN || '',
  },

  // Shared by the calendar and the lead sheet — one service account, one key
  // file, two scopes. The sheet has to be SHARED with that account's
  // client_email as an Editor, exactly like the calendar.
  google: {
    keyFile: process.env.GOOGLE_KEY_FILE || './service-account.json',
  },

  calendar: {
    calendarId: process.env.CALENDAR_ID || '',
  },

  // The outbound call list.
  sheet: {
    id: process.env.SHEET_ID || '',
    tab: process.env.SHEET_TAB || 'Sheet1',
    // The status values the dialer reads and writes. Configurable because an
    // existing sheet may already use different words, and renaming a column in
    // a live sheet is riskier than setting an env var.
    statusNew: process.env.SHEET_STATUS_NEW || 'New',
    statusCalling: process.env.SHEET_STATUS_CALLING || 'Calling',
    statusCalled: process.env.SHEET_STATUS_CALLED || 'Called',
    statusFailed: process.env.SHEET_STATUS_FAILED || 'Failed',
    statusInvalid: process.env.SHEET_STATUS_INVALID || 'Invalid',
  },

  outbound: {
    // Two DIFFERENT credentials. apiToken is the account API token and goes in
    // the Authorization header; ctcApiKey is the Click to Call Support API key
    // and goes in the request BODY, and it is the one that carries the
    // destination — the Voice Streaming endpoint the audio arrives on.
    apiToken: process.env.SMARTFLO_API_TOKEN || '',
    ctcApiKey: process.env.SMARTFLO_CTC_API_KEY || '',
    // A DID on the account. Optional per the docs, but without it Smartflo
    // picks one, and callers seeing an unfamiliar number answer less.
    callerId: process.env.SMARTFLO_CALLER_ID || '',

    // Guards the /outbound/* routes. No key, no routes — they can dial any
    // number from your DID, so they are never left open.
    apiKey: process.env.OUTBOUND_API_KEY || '',

    // Nothing is dialled while this is true. The default is TRUE: a fresh
    // deployment with a real sheet should not start cold-calling because
    // someone ran the server. Set OUTBOUND_DRY_RUN=false deliberately.
    dryRun: process.env.OUTBOUND_DRY_RUN !== 'false',
    // Whether the sheet watcher starts with the server.
    watch: process.env.OUTBOUND_WATCH === 'true',

    pollMs: Number(process.env.OUTBOUND_POLL_MS ?? 30_000),
    // Per pass, so a sheet pasted with 500 rows does not become 500 calls in
    // one minute.
    maxPerScan: Number(process.env.OUTBOUND_MAX_PER_SCAN ?? 5),
    concurrency: Number(process.env.OUTBOUND_CONCURRENCY ?? 1),
    gapMs: Number(process.env.OUTBOUND_GAP_MS ?? 2_000),
    maxAttempts: Number(process.env.OUTBOUND_MAX_ATTEMPTS ?? 2),

    // "09:30-19:00" IST. Empty means any time, which is rarely what anyone
    // actually wants for cold calls.
    hours: process.env.OUTBOUND_HOURS || '',

    // Documented range is 10-30 seconds; clamped before the request.
    ringTimeoutSec: Number(process.env.OUTBOUND_RING_TIMEOUT_SEC ?? 30),
    callTimeoutSec: Number(process.env.OUTBOUND_CALL_TIMEOUT_SEC ?? 300),
    requestTimeoutMs: Number(process.env.OUTBOUND_REQUEST_TIMEOUT_MS ?? 10_000),

    // Smartflo's docs disagree with themselves on the accepted length (10-12 in
    // one place, 10-15 in another) and the example is a bare 10-digit number.
    // 'national' sends that; 'cc' prefixes 91; 'e164' sends +91.
    numberFormat: (process.env.SMARTFLO_NUMBER_FORMAT || 'national').toLowerCase(),
  },

  session: {
    timeoutMinutes: parseInt(process.env.SESSION_TIMEOUT_MINUTES || '10', 10),
  },
};