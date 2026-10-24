# 02. API Architecture & Specification

## 1. Overview & Protocol Architecture

The Voxa Voice AI Platform API is composed of three interconnected communication layers:
1. **PSTN Telephony & Media Streams (Low Latency):** Webhooks and duplex audio WebSockets interfacing directly with Smartflo and Twilio.
2. **RESTful Management & Analytics API (Stateless):** Secure CRUD operations for calls, contacts, campaigns, agent configurations, and appointments.
3. **Real-time Admin WebSocket Protocol (Event-Driven):** Streaming telemetry, live waveforms, and audio monitoring for the frontend dashboard.

```
Caller (PSTN) ──► Smartflo/Twilio ──► WSS /ws/media ──► MediaStreamHandler ──► CallSession
                                                             │
Dashboard UI  ◄── WSS /ws/admin   ◄── Redis Pub/Sub   ◄──────┤ (Telemetry & Turns)
                                                             │
Dashboard UI  ──► REST API        ──► Fastify/Express  ──► PostgreSQL + S3
```

---

## 2. Telephony & Media Stream Specification

### 2.1 Webhooks (Inbound & Status)

#### `POST /api/v1/telephony/incoming`
Called by the telephony provider when a caller dials the platform DID.

* **Headers:** `Content-Type: application/json` or `application/x-www-form-urlencoded`
* **Request Payload (Smartflo format):**
  ```json
  {
    "call_id": "HYD13-T11-1789976951.70159",
    "caller_id_number": "+919876543210",
    "destination_number": "+918045678900",
    "timestamp": "2026-10-18T09:30:00Z"
  }
  ```
* **Smartflo Response (200 OK):**
  ```json
  {
    "success": true,
    "wss_url": "wss://api.voxa.ai/ws/media"
  }
  ```
* **Twilio Response (200 OK - TwiML):**
  ```xml
  <Response>
    <Connect>
      <Stream url="wss://api.voxa.ai/ws/media">
        <Parameter name="callerNumber" value="+919876543210" />
      </Stream>
    </Connect>
  </Response>
  ```

#### `POST /api/v1/telephony/status`
CDR (Call Detail Record) webhook for call termination.

* **Request Payload:**
  ```json
  {
    "callSid": "HYD13-T11-1789976951.70159",
    "callStatus": "completed",
    "duration": 128,
    "hangupCause": "normal_clearing"
  }
  ```
* **Response:** `200 OK`

---

### 2.2 Duplex Media Stream (`WSS /ws/media`)
Handles raw audio packet exchange between the telephony trunk and the speech engine.

* **Inbound Audio Format:** G.711 $\mu$-law 8kHz, base64-encoded in 20ms frames (160 bytes raw per chunk).
* **Outbound Audio Format:** ElevenLabs PCM 16kHz $\rightarrow$ downsampled 2:1 in JS $\rightarrow$ G.711 $\mu$-law 8kHz $\rightarrow$ base64.

#### WebSocket Frame Protocol:
1. **Connection Start:**
   ```json
   {
     "event": "start",
     "sequenceNumber": "1",
     "start": {
       "streamSid": "MZ12345",
       "callSid": "HYD13-T11-1789976951.70159",
       "from": "+919876543210",
       "to": "+918045678900",
       "mediaFormat": { "encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1 }
     }
   }
   ```
2. **Audio Packet Exchange:**
   ```json
   {
     "event": "media",
     "sequenceNumber": "42",
     "media": {
       "track": "inbound",
       "chunk": "1",
       "timestamp": "840",
       "payload": "7v7+/f39/f3+/v/+"
     }
   }
   ```
3. **Barge-in / Interrupt Clear (Outbound to Telephony):**
   When user interrupts while TTS is playing:
   ```json
   {
     "event": "clear",
     "streamSid": "MZ12345"
   }
   ```

---

## 3. RESTful Management & Intelligence API

All management endpoints require standard Bearer JWT authentication:  
`Authorization: Bearer <jwt_token>`

### 3.1 Call Sessions & Transcripts

#### `GET /api/v1/calls`
Retrieve paginated, filterable call history.
* **Query Parameters:**
  * `page` (default: 1), `limit` (default: 20, max: 100)
  * `status`: `COMPLETED` | `IN_PROGRESS` | `FAILED` | `BUSY` | `NO_ANSWER`
  * `direction`: `INBOUND` | `OUTBOUND`
  * `fromNumber`, `toNumber`, `agentId`, `campaignId`
  * `startDate`, `endDate` (ISO 8601)
  * `search`: text query across caller name, phone number, and transcripts
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": [
      {
        "id": "c7a8b92d-9471-482a-a92e-32fa4c023d81",
        "callSid": "HYD13-T11-1789976951.70159",
        "direction": "INBOUND",
        "status": "COMPLETED",
        "fromNumber": "+919876543210",
        "toNumber": "+918045678900",
        "durationSec": 138,
        "startedAt": "2026-10-18T09:30:00.000Z",
        "avgLatencyMs": 680,
        "contactName": "Amit Sharma",
        "hasRecording": true,
        "summary": "Caller enquired about Voxa24 pricing and booked a 30-min demo for Tuesday at 10 AM."
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 1420, "totalPages": 71 }
  }
  ```

#### `GET /api/v1/calls/:id`
Full inspection of a call, including granular turn performance and tool calls.
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "id": "c7a8b92d-9471-482a-a92e-32fa4c023d81",
      "callSid": "HYD13-T11-1789976951.70159",
      "direction": "INBOUND",
      "status": "COMPLETED",
      "fromNumber": "+919876543210",
      "toNumber": "+918045678900",
      "durationSec": 138,
      "startedAt": "2026-10-18T09:30:00.000Z",
      "endedAt": "2026-10-18T09:32:18.000Z",
      "metrics": {
        "avgLatencyMs": 680,
        "sttLagAvgMs": 180,
        "llmTtftAvgMs": 240,
        "ttsLatencyAvgMs": 260,
        "bargeInCount": 1
      },
      "turns": [
        {
          "seq": 1,
          "role": "agent",
          "speakerName": "Priya",
          "text": "Hey, I'm Priya. How can I help you today?",
          "sttDurationMs": null,
          "llmLatencyMs": null,
          "ttsLatencyMs": 210,
          "totalLatencyMs": 210,
          "wasInterrupted": false
        },
        {
          "seq": 2,
          "role": "user",
          "speakerName": "caller",
          "text": "I want to schedule a demo for Voxa24.",
          "sttDurationMs": 190,
          "llmLatencyMs": 230,
          "ttsLatencyMs": 220,
          "totalLatencyMs": 640,
          "wasInterrupted": false
        }
      ],
      "toolExecutions": [
        {
          "toolName": "check_availability",
          "durationMs": 310,
          "isSuccess": true,
          "inputParams": { "date": "2026-10-20" },
          "outputResult": { "available": true, "slots": ["10:00 AM", "02:00 PM"] }
        }
      ],
      "recording": {
        "audioUrl": "/api/v1/calls/c7a8b92d-9471-482a-a92e-32fa4c023d81/recording",
        "durationMs": 138000,
        "channelLayout": "stereo"
      }
    }
  }
  ```

#### `GET /api/v1/calls/:id/recording`
Streams the stereo WAV recording. Supports HTTP Range requests for instant in-browser audio scrubbing (Safari/Chrome compliant).
* **Headers Supported:** `Range: bytes=0-1024`
* **Response:**
  * `206 Partial Content` (when Range is sent)
  * `200 OK` (when full download is requested)
  * `Content-Type: audio/wav`
  * `Content-Disposition: inline; filename="call-HYD13-xxx.wav"`

---

### 3.2 Outbound Campaigns & Dialer API

#### `POST /api/v1/outbound/dial`
Direct single-call dispatch. Guarded by `OUTBOUND_API_KEY` or admin JWT.
* **Request:**
  ```json
  {
    "phoneNumber": "+919876543210",
    "agentId": "agent_rahul_01",
    "contactName": "Rahul Verma",
    "metadata": { "leadSource": "Website Inbound" }
  }
  ```
* **Response (202 Accepted):**
  ```json
  {
    "success": true,
    "message": "Call initiated",
    "callSid": "HYD13-T11-1789976999.11223"
  }
  ```

#### `POST /api/v1/campaigns`
Creates an automated outbound calling campaign.
* **Request:**
  ```json
  {
    "name": "Oct Enterprise Outreach",
    "agentId": "agent_rahul_01",
    "callingHoursStart": "09:30",
    "callingHoursEnd": "19:00",
    "concurrencyLimit": 3,
    "retryLimit": 2,
    "retryIntervalMins": 30
  }
  ```

#### `POST /api/v1/campaigns/:id/leads`
Bulk imports leads into the campaign queue.
* **Payload:** Accepts `multipart/form-data` with a CSV or a JSON array:
  ```json
  {
    "leads": [
      { "name": "Amit Sharma", "phoneNumber": "+919876543210", "company": "Acme Corp" },
      { "name": "Deepak Singh", "phoneNumber": "+919876543211", "company": "Global Tech" }
    ]
  }
  ```

#### `POST /api/v1/campaigns/:id/control`
Start, pause, or stop a campaign.
* **Request:** `{ "action": "start" }` | `{ "action": "pause" }` | `{ "action": "stop" }`

---

### 3.3 Contacts & Long-Term Memory (CRM)

#### `GET /api/v1/contacts/:id`
Retrieves a contact 360 profile with all remembered preferences and facts.
* **Response (200 OK):**
  ```json
  {
    "success": true,
    "data": {
      "id": "cnt_99812",
      "phoneNumber": "+919876543210",
      "name": "Amit Sharma",
      "email": "amit.sharma@gmail.com",
      "company": "Acme Corp",
      "status": "qualified",
      "callCount": 3,
      "lastCallAt": "2026-10-18T09:30:00Z",
      "memories": [
        { "key": "interested_product", "value": "Voxa24 Customer Engagement", "confidence": 1.0 },
        { "key": "team_size", "value": "25 agents", "confidence": 0.95 }
      ]
    }
  }
  ```

#### `PUT /api/v1/contacts/:id/memories`
Add or update a persistent fact manually.
* **Request:** `{ "key": "preferred_time", "value": "Afternoon after 3 PM" }`

---

## 4. Real-time Supervisor WebSocket Protocol (`WSS /ws/admin`)

Used by the frontend Live Monitor wallboard to visualize in-flight phone calls without polling.

* **Connection Handshake:** `wss://api.voxa.ai/ws/admin?token=<jwt_token>`

### Broadcast Events:

#### 1. Call Started (`call:started`)
```json
{
  "event": "call:started",
  "data": {
    "callSid": "HYD13-T11-1789976951.70159",
    "fromNumber": "+919876543210",
    "toNumber": "+918045678900",
    "direction": "INBOUND",
    "agentName": "Priya",
    "startedAt": "2026-10-18T09:30:00Z"
  }
}
```

#### 2. Live Spoken Turn (`call:turn`)
Broadcast immediately as each turn is completed.
```json
{
  "event": "call:turn",
  "data": {
    "callSid": "HYD13-T11-1789976951.70159",
    "seq": 3,
    "role": "agent",
    "text": "Sure, Tuesday at 10:00 AM works. Shall I book that for you?",
    "latency": {
      "sttLagMs": 190,
      "llmTtftMs": 240,
      "ttsMs": 210,
      "totalMs": 640
    }
  }
}
```

#### 3. Real-time Audio Level RMS (`call:audio_level`)
Pulsed every 100ms for live VU meters:
```json
{
  "event": "call:audio_level",
  "data": {
    "callSid": "HYD13-T11-1789976951.70159",
    "callerRms": 0.72,
    "agentRms": 0.00
  }
}
```

#### 4. Barge-In Detected (`call:barge_in`)
```json
{
  "event": "call:barge_in",
  "data": {
    "callSid": "HYD13-T11-1789976951.70159",
    "interruptedTurnSeq": 3,
    "discardedAudioMs": 850
  }
}
```

#### 5. Call Ended (`call:ended`)
```json
{
  "event": "call:ended",
  "data": {
    "callSid": "HYD13-T11-1789976951.70159",
    "durationSec": 138,
    "status": "COMPLETED",
    "summary": "Demo scheduled for Tuesday at 10 AM."
  }
}
```

---

## 5. Security, Rate Limiting & Auth Architecture

1. **Telephony Endpoints (`/api/v1/telephony/*`):**
   * Smartflo does not sign webhooks; security relies on **IP Allowlisting** at the firewall/ingress layer for Tata Smartflo egress subnets.
   * Twilio routes enforce HMAC SHA-256 signature validation (`x-twilio-signature`).
2. **Outbound Dispatch (`/api/v1/outbound/*`):**
   * Requires constant-time evaluated `x-api-key` header (`OUTBOUND_API_KEY`) to prevent unauthorized DIDs dialing.
3. **Admin & Management REST Endpoints:**
   * JWT Bearer token signed with RS256.
   * Rate limited at 100 requests / minute / IP via Redis token bucket.
4. **Recordings Route (`/recordings/:id`):**
   * Authenticated via short-lived pre-signed tokens or `x-api-key`.
