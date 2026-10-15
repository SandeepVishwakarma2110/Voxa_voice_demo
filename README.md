# PSTN Voice Agent — Xverse Technologies

A low-latency PSTN voice AI system built on Twilio Media Streams.  
Callers ring a Twilio number and speak directly to **Rahul** — a single unified AI agent that handles greetings, product questions, and meeting bookings.

**Target latency: 600–800 ms end-to-end**

---

## Architecture

```
Caller (PSTN)
    │
    ▼
Twilio (phone number)
    │ TwiML → /call/incoming
    │ Media Stream WebSocket → /ws/media
    │ μ-law 8kHz audio chunks
    ▼
mediaStreamHandler.js
    │
    ▼
CallSession.js  (one instance per call)
    │
    ├── pushAudio()
    │       │ buffer until Deepgram ready
    │       ▼
    │   Deepgram Nova-2 (STT)
    │       │ μ-law 8kHz direct (no conversion)
    │       │ VAD endpointing: 400ms silence
    │       ▼
    │   utterance_end → _handleUtteranceEnd()
    │       │
    │       ▼
    │   agentService.processMessage()
    │       │
    │       ▼
    │   LangGraph (MemorySaver)
    │       │
    │       ▼
    │   rahulNode  ←──────────────────────┐
    │   (GPT-4o-mini)                     │
    │       │ tool_calls?                 │
    │       ▼                             │
    │   ToolNode                          │
    │   ├── check_availability            │
    │   ├── book_appointment              │
    │   └── send_meeting_email ───────────┘
    │       │ final text response
    │       ▼
    │   _speakResponse()
    │       │ splitIntoSentences()
    │       ▼
    │   ElevenLabs TTS (eleven_turbo_v2_5)
    │       │ output_format: pcm_16000
    │       │ downsample 16kHz → 8kHz
    │       │ linearToMulaw() encode
    │       ▼
    │   Twilio WebSocket
    │   {"event":"media", payload: base64(μ-law)}
    │
    ▼
Caller hears Rahul's response
```

---
## Agent — Rahul

Single unified agent replacing the previous Rahul / Priya / Ansh three-agent setup.

| Capability | How |
|---|---|
| Greetings & general chat | GPT-4o-mini with RAHUL_PERSONA prompt |
| Product questions | Inline knowledge in persona prompt |
| Meeting booking | `check_availability` + `book_appointment` tools |
| Email confirmation | `send_meeting_email` tool (nodemailer) |
| Returning caller memory | MongoDB UserProfile + userSummary context |
| Lead data extraction | Parallel mini LLM call per turn |

---

## Audio Pipeline Detail

```
Twilio  ──μ-law 8kHz──►  Deepgram     (no conversion — native mulaw encoding)
Deepgram transcript ──►  GPT-4o-mini  (text only)
GPT-4o-mini text ──►     ElevenLabs   (pcm_16000 output)
ElevenLabs PCM16 ──►     downsampleToMulaw()  16kHz→8kHz + G.711 encode
μ-law 8kHz ──►           Twilio base64 media message
```

**Why `pcm_16000` not `ulaw_8000`:**  
ElevenLabs `ulaw_8000` and `pcm_8000` are not reliably supported by `eleven_turbo_v2_5` — they silently fall back to MP3 which sounds like static on a phone line. `pcm_16000` is universally supported. We downsample 2:1 in pure JS (averaging adjacent sample pairs as a low-pass filter) then G.711 μ-law encode before sending to Twilio.

**Why audio buffering in CallSession:**  
Twilio starts sending audio ~200ms before Deepgram's WebSocket opens. Without buffering, those early chunks are dropped and the first word of every utterance is missed. `_audioQueue` holds chunks until the Deepgram `Open` event fires, then flushes them all.

**Barge-in:**  
When Deepgram fires `SpeechStarted` or a `is_final` transcript while `isSpeaking === true`, `CallSession` sets `ttsAborted = true` and sends `{"event":"clear"}` to Twilio, which immediately stops audio playback. The caller's new utterance is processed from scratch.

---

## Project Structure

```
src/
├── index.js                    # HTTP + WS server bootstrap
├── app.js                      # Express app
├── config/index.js             # All env config
│
├── agents/
│   ├── companyAgents.js        # Rahul node — GPT-4o-mini + tool loop + lead extractor
│   └── state.js                # LangGraph AgentState (messages, userSummary, leadData)
│
├── graph/
│   └── index.js                # LangGraph: rahul → tools → rahul loop
│
├── services/
│   ├── callSession.js          # Per-call orchestrator: VAD → STT → Agent → TTS
│   ├── speechService.js        # Deepgram STT + ElevenLabs TTS + PCM conversion
│   └── agentService.js         # LangGraph wrapper + MongoDB profile hydration
│
├── tools/
│   ├── calendar.js             # check_availability + book_appointment
│   └── email.js                # send_meeting_email (nodemailer)
│
├── constants/
│   └── prompts.js              # Unified Rahul persona
│
├── models/
│   ├── UserProfile.js          # Mongoose: caller memory across calls
│   └── Log.js                  # Mongoose: per-call transcripts
│
├── utils/
│   ├── audioUtils.js           # μ-law encode/decode helpers + Twilio message builders
│   ├── sessionManager.js       # In-memory callSid → CallSession map
│   ├── cleanup.js              # 10-min idle → DB flush + RAM wipe (node-cron)
│   ├── db.js                   # MongoDB connect with retry
│   └── logger.js               # Winston logger
│
├── websocket/
│   └── mediaStreamHandler.js   # Twilio WS events → CallSession binding
│
├── middleware/
│   ├── twilioAuth.js           # HMAC signature validation
│   └── errorHandler.js
│
├── routes/callRoutes.js
└── controllers/callController.js
```

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
# Fill in all values
```

### 2. Expose locally

```bash
npx ngrok http 80
# or: npx ngrok http 3000
# Copy the https URL → paste as BASE_URL in .env
```

### 3. Configure Twilio

In the Twilio Console → Phone Numbers → your number:

| Field | Value |
|---|---|
| Voice webhook (POST) | `https://YOUR_NGROK/call/incoming` |
| Status callback (POST) | `https://YOUR_NGROK/call/status` |

### 4. Run

```bash
npm run dev    # development (--watch auto-restart)
npm start      # production
```

---

## Environment Variables

```env
# Server
PORT=80
BASE_URL=https://your-ngrok-url.ngrok-free.app

# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# Deepgram (STT)
DEEPGRAM_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ElevenLabs (TTS)
ELEVENLABS_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ELEVENLABS_VOICE_RAHUL=pNInz6obpgDQGcFmaJgB
ELEVENLABS_MODEL=eleven_turbo_v2_5

# OpenAI (LLM)
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_MODEL=gpt-4o-mini

# MongoDB
MONGODB_URI=mongodb://localhost:27017/voiceagent

# Email / SMTP
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=Rahul at Xverse <your@gmail.com>

# Session
SESSION_TIMEOUT_MINUTES=10
```

---

## Dependencies

```json
"dependencies": {
  "@deepgram/sdk": "^3.3.0",
  "@langchain/core": "^0.2.10",
  "@langchain/langgraph": "^0.0.34",
  "@langchain/openai": "^0.2.8",
  "dotenv": "^16.4.5",
  "express": "^4.19.2",
  "mongoose": "^8.4.1",
  "node-cron": "^3.0.3",
  "nodemailer": "^6.9.13",
  "openai": "^4.52.0",
  "twilio": "^5.0.4",
  "winston": "^3.13.0",
  "ws": "^8.17.0"
}
```

Node.js >= 20 required (native `fetch` API used for ElevenLabs).

---

## Debug Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Server health check |
| `GET /call/sessions` | Active sessions in RAM (disable in production) |

---

## Known Issues & Fixes Applied

| Issue | Fix |
|---|---|
| TTS static / noise | ElevenLabs `ulaw_8000` not supported by turbo model — switched to `pcm_16000` + in-process downsample |
| Deepgram not transcribing | Audio arriving before WebSocket open — added `_audioQueue` buffer + `onOpen` flush |
| Deepgram dropping after silence | Added `keepAlive()` ping every 5 seconds |
| First call 2000ms TTS latency | Added `warmElevenLabs()` call at server startup |
| `onChunk is not a function` | `streamTTS` signature mismatch — removed `agentName` param |
| `NaNms` E2E latency log | `t0` is `null` for greeting — guarded with `t0 !== null` check |

---

## Reducing Latency Further

1. **Partial transcript prefill** — fire LLM on `interim_results` before `utterance_end`. Cancel and retry if the partial was wrong. Saves 100–200ms.
2. **Groq inference** — swap `@langchain/openai` for `@langchain/groq`. Llama 3.1 70B on Groq averages ~90ms TTFFT vs ~200ms for GPT-4o-mini.
3. **Edge deployment** — host on Fly.io or Railway in the same region as your callers to cut network RTT.
4. **Reduce `endpointing`** — lower from `400ms` to `200ms` for snappier turn-taking. Risk: may cut off slow speakers.


echo "# Pstn-DG-Agent-EL" >> README.md
git init
git add README.md
git commit -m "first commit"
git branch -M main
git remote add origin https://github.com/SandeepVishwakarma2110/Pstn-DG-Agent-EL.git
git push -u origin main



https://index.docker.io

docker build -t pstn-sv-agent-el-smartflo:0.0.2 .

docker run -p 80:80 --env-file .env pstn-sv-agent-el-smartflo:0.0.2

docker tag pstn-sv-agent-el-smartflo:0.0.2 sandeepvishwakarma2110/pstn-sv-agent-el-smartflo:second

docker push sandeepvishwakarma2110/pstn-sv-agent-el-smartflo:second




curl -o test-recording.wav http://localhost:80/callrecordings/recordings/HYD13-T11-1789976951.70159

curl -o call.wav http://localhost:80/calls/recordings/HYD13-T11-1789976951.70159


https://smartflo-dzhva6f6bgc3d2ek.southindia-01.azurewebsites.net