# 03. Frontend Architecture (Admin Dashboard & Control Center)

## 1. Overview & Technology Stack

The Voxa Voice AI Dashboard is an enterprise operations console designed for voice AI operators, sales teams, and AI engineers. It provides real-time visibility into active phone calls, deep-dive forensic audio analysis with dual-channel waveforms, campaign dispatch controls, and agent prompt configuration.

### Core Stack
* **Framework:** **Next.js 14+ (App Router)** with TypeScript
* **Styling & UI Kit:** **TailwindCSS** + **Shadcn/ui** (Accessible Radix UI primitives)
* **Icons:** **Lucide-react**
* **Data Fetching & Cache:** **TanStack Query v5** (React Query)
* **Client & Real-time State:** **Zustand** (Audio Player Store, Live Call Socket Store)
* **Audio Waveform Visualization:** **WaveSurfer.js v7** with `RegionsPlugin` & `TimelinePlugin`
* **Charts & Analytics:** **Recharts** / **Tremor**

```
┌────────────────────────────────────────────────────────────────────────┐
│                        NEXT.JS 14 FRONTEND APP                         │
├────────────────────────────────┬───────────────────────────────────────┤
│ 1. APP SHELL & NAVIGATION      │ 2. GLOBAL STATE MANAGERS              │
│  • Dashboard / Overview        │  • Auth / Session (NextAuth)          │
│  • Live Monitor (Wallboard)    │  • Socket Store (Zustand: Admin WSS)  │
│  • Call History & Inspector    │  • Query Client (TanStack Query)      │
│  • Campaign Manager (Dialer)   │  • Audio Player Store (WaveSurfer)    │
│  • Agent Studio & Prompts      │                                       │
│  • Contacts / CRM Memory       │                                       │
├────────────────────────────────┴───────────────────────────────────────┤
│ 3. SPECIALIZED UI MODULES                                              │
│  ┌─────────────────────────┐  ┌─────────────────────────┐              │
│  │ Dual-Track Call Player  │  │ Real-time Live Wallboard│              │
│  │ • Stereo Waveform (L/R) │  │ • Active Calls Grid     │              │
│  │ • Synced Transcript     │  │ • Latency Gauge Meters  │              │
│  │ • Waterfall Latency View│  │ • Live Audio Level VU   │              │
│  └─────────────────────────┘  └─────────────────────────┘              │
│  ┌─────────────────────────┐  ┌─────────────────────────┐              │
│  │ Campaign Control Desk   │  │ Agent Prompt Simulator  │              │
│  │ • CSV Importer / Mapper │  │ • Persona Test Sandbox  │              │
│  │ • Dialing Concurrency   │  │ • Voice Preview Selector│              │
│  └─────────────────────────┘  └─────────────────────────┘              │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Directory & Component Structure

```
frontend/
├── app/
│   ├── (auth)/
│   │   ├── login/page.tsx               # Operator login
│   ├── (dashboard)/
│   │   ├── layout.tsx                   # App shell (Sidebar, Topbar, Global Socket Provider)
│   │   ├── page.tsx                     # KPI Overview (Calls today, AHT, conversion rate)
│   │   ├── live/
│   │   │   └── page.tsx                 # Real-time Live Call Wallboard
│   │   ├── calls/
│   │   │   ├── page.tsx                 # Filterable Call History Data Table
│   │   │   └── [id]/page.tsx            # Deep Call Inspector & Dual Waveform Player
│   │   ├── campaigns/
│   │   │   ├── page.tsx                 # Campaign List & Status
│   │   │   └── [id]/page.tsx            # Campaign Lead Queue & Dialer Controls
│   │   ├── contacts/
│   │   │   ├── page.tsx                 # CRM Contact Directory
│   │   │   └── [id]/page.tsx            # Contact 360 & Memory Vault
│   │   ├── agents/
│   │   │   ├── page.tsx                 # Agent Persona List
│   │   │   └── [id]/page.tsx            # Prompt Editor, Voice Tuner & Test Sandbox
│   │   └── settings/page.tsx            # DID Management, API Keys, Webhook Status
│
├── components/
│   ├── call-player/
│   │   ├── DualTrackWaveform.tsx        # Stereo Player: Left=Caller, Right=Agent
│   │   ├── TranscriptView.tsx           # Auto-scrolling transcript with turn timestamps
│   │   ├── LatencyWaterfall.tsx         # Turn latency breakdown: STT -> LLM -> TTS
│   │   ├── BargeInMarker.tsx            # Visual indicator where caller interrupted agent
│   │   └── ToolExecutionBadge.tsx       # Calendar/Email execution pill
│   ├── live-monitor/
│   │   ├── ActiveCallCard.tsx           # Live status card for in-flight calls
│   │   ├── VUMeter.tsx                  # Real-time audio RMS level meter
│   │   └── LiveTranscriptBubble.tsx     # Real-time streaming text bubbles
│   ├── campaigns/
│   │   ├── LeadUploadModal.tsx          # CSV Drag & Drop Column Mapping Wizard
│   │   └── DialerControls.tsx           # Concurrency slider, Start/Pause buttons
│   ├── contacts/
│   │   ├── MemoryFactCard.tsx           # Key-value persistent memory editor
│   │   └── CallTimeline.tsx             # Lifetime interaction history
│   └── shared/
│       ├── DataTable.tsx                # Generic TanStack Table with pagination & sort
│       └── MetricCard.tsx               # Dashboard KPI card
│
├── hooks/
│   ├── useLiveCalls.ts                  # Subscribes to /ws/admin WebSocket events
│   ├── useAudioPlayer.ts                # Controls WaveSurfer instance & playhead
│   └── useDebounce.ts                   # Debounces search inputs
│
├── store/
│   ├── useAudioStore.ts                 # Playback state, currentTime, activeTurnId
│   └── useLiveStore.ts                  # Active calls map, live turns, RMS levels
│
└── lib/
    ├── api.ts                           # Axios client with automatic Bearer token injection
    └── formatters.ts                    # Duration, IST timestamp, and phone formatters
```

---

## 3. Deep Dive: Key Specialized Components

### 3.1 Dual-Track Call Audio Player (`DualTrackWaveform.tsx`)

Because the recording engine builds stereo WAV files with **Caller on the Left Channel** and **Agent on the Right Channel**, the frontend renders two separate, synchronized waveform ribbons.

#### Functional Specifications:
1. **Stereo Separation:** Uses `WaveSurfer.js` with Web Audio API `ChannelSplitterNode`.
   * **Top Waveform (Blue):** Caller Voice (Left Channel).
   * **Bottom Waveform (Emerald):** Agent Voice (Right Channel).
2. **Bi-directional Transcript Synchronization:**
   * Clicking any sentence in the transcript commands the player to jump to that timestamp (`wavesurfer.seekTo(time / duration)`).
   * As audio plays, the active transcript bubble is highlighted in real-time, and the container automatically scrolls into view.
3. **Barge-in Visual Highlighting:** Uses WaveSurfer `RegionsPlugin` to draw yellow overlay zones where the caller interrupted the agent and TTS audio was truncated.
4. **Scrubbing & Playback Controls:**
   * 0.75x, 1.0x, 1.25x, 1.5x, 2.0x playback rates.
   * Skip forward 5s / backward 5s with keyboard shortcuts (`Space` = Play/Pause, `←` / `→` = Skip).

#### Component Architecture:
```tsx
// components/call-player/DualTrackWaveform.tsx
"use client";

import React, { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { useAudioStore } from "@/store/useAudioStore";

interface Props {
  recordingUrl: string;
  durationMs: number;
  interruptedTurns: Array<{ timestampMs: number; durationMs: number }>;
}

export const DualTrackWaveform: React.FC<Props> = ({
  recordingUrl,
  durationMs,
  interruptedTurns,
}) => {
  const callerRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const { isPlaying, setPlaying, setCurrentTime } = useAudioStore();

  useEffect(() => {
    if (!callerRef.current) return;

    // Initialize WaveSurfer
    const ws = WaveSurfer.create({
      container: callerRef.current,
      waveColor: "#3b82f6", // Blue for caller
      progressColor: "#1d4ed8",
      height: 64,
      splitChannels: [
        {
          waveColor: "#3b82f6",
          progressColor: "#1d4ed8",
        },
        {
          waveColor: "#10b981", // Emerald for agent
          progressColor: "#047857",
        },
      ],
      url: recordingUrl,
    });

    const regions = ws.registerPlugin(RegionsPlugin.create());

    // Highlight barge-ins with yellow overlay
    interruptedTurns.forEach((turn) => {
      regions.addRegion({
        start: turn.timestampMs / 1000,
        end: (turn.timestampMs + turn.durationMs) / 1000,
        color: "rgba(234, 179, 8, 0.25)", // Yellow warning
      });
    });

    ws.on("timeupdate", (currentTime) => setCurrentTime(currentTime));
    ws.on("play", () => setPlaying(true));
    ws.on("pause", () => setPlaying(false));

    wavesurferRef.current = ws;
    return () => ws.destroy();
  }, [recordingUrl]);

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-blue-500">Caller (Left Channel)</span>
        <span className="text-xs font-semibold uppercase text-emerald-500">Agent (Right Channel)</span>
      </div>
      <div ref={callerRef} className="w-full cursor-pointer" />
    </div>
  );
};
```

---

### 3.2 End-to-End Latency Waterfall (`LatencyWaterfall.tsx`)

Visualizes the performance budget for every conversation turn to identify bottlenecks in the voice pipeline.

```
Turn 3 (User Spoke): "Can we meet tomorrow at 4 PM?"
┌──────────────────┬────────────────────┬──────────────────────┬───────────────┐
│ STT Lag: 180ms   │ LLM TTFT: 240ms    │ TTS First Byte: 220ms│ Total: 640ms  │
└──────────────────┴────────────────────┴──────────────────────┴───────────────┘
  [Deepgram Nova2]   [GPT-4o-mini]        [ElevenLabs Turbo]     Target: < 800ms
```

#### Color-coded threshold badges:
* **Green (< 700ms):** Ultra-fast, natural conversation flow.
* **Amber (700ms – 1000ms):** Acceptable telephony turn-taking delay.
* **Red (> 1000ms):** Unacceptable latency; causes caller to talk over the agent or ask *"Hello?"*.

---

### 3.3 Real-Time Operations Wallboard (`/live`)

A dedicated dashboard page displaying in-flight calls connected to the backend.

#### Features:
* **Active Calls Grid:** Cards displaying active caller phone numbers, connected agent (`Priya` or `Rahul`), elapsed duration counter, and current turn count.
* **Real-time VU Meters (`VUMeter.tsx`):** Animated RMS audio meters showing when caller or agent is speaking.
* **Streaming Transcripts:** Text bubbles appear token-by-token or turn-by-turn as received from `/ws/admin`.
* **Supervisor Action Buttons:**
  * **"Drop Call":** Forcefully terminates the telephony session.
  * **"Transfer to Human":** SIP refer/transfer to a human agent queue.

---

### 3.4 Outbound Campaign Desk (`/campaigns/[id]`)

Replaces the manual Google Sheet watcher with an automated control room:
* **CSV Column Mapper:** Drag-and-drop modal mapping uploaded headers (`"Contact No"`, `"Client Name"`, `"Notes"`) to system fields.
* **Dialing Controls:**
  * Interactive concurrency slider (e.g. 1 to 10 simultaneous channels).
  * Safe dialing hours indicator (`Active: 09:30 - 19:00 IST`).
  * Live status donuts (`Pending`, `Calling`, `Answered`, `Converted`).

---

## 4. State Management Architecture

```mermaid
flowchart TD
    subgraph Server State (TanStack Query)
    Q1[Call History List]
    Q2[Contact 360 Details]
    Q3[Campaigns & Leads]
    Q4[Agent Configurations]
    end

    subgraph Client UI State (Zustand)
    A1[useAudioStore: Playhead, Duration, ActiveTurn, Scrub]
    A2[useLiveStore: Active Calls Map, Live VU Levels]
    end

    subgraph External Drivers
    W1[WSS /ws/admin] -->|Pushes Events| A2
    R1[REST API] <-->|Queries & Mutations| Server State
    end
```

### Zustand Live Calls Store (`useLiveStore.ts`)
```typescript
import { create } from "zustand";

export interface ActiveCall {
  callSid: string;
  fromNumber: string;
  agentName: string;
  startedAt: string;
  callerRms: number;
  agentRms: number;
  lastTurnText?: string;
}

interface LiveState {
  activeCalls: Map<string, ActiveCall>;
  addCall: (call: ActiveCall) => void;
  removeCall: (callSid: string) => void;
  updateAudioLevel: (callSid: string, callerRms: number, agentRms: number) => void;
  updateTurn: (callSid: string, text: string) => void;
}

export const useLiveStore = create<LiveState>((set) => ({
  activeCalls: new Map(),
  addCall: (call) =>
    set((state) => {
      const next = new Map(state.activeCalls);
      next.set(call.callSid, call);
      return { activeCalls: next };
    }),
  removeCall: (callSid) =>
    set((state) => {
      const next = new Map(state.activeCalls);
      next.delete(callSid);
      return { activeCalls: next };
    }),
  updateAudioLevel: (callSid, callerRms, agentRms) =>
    set((state) => {
      const call = state.activeCalls.get(callSid);
      if (!call) return state;
      const next = new Map(state.activeCalls);
      next.set(callSid, { ...call, callerRms, agentRms });
      return { activeCalls: next };
    }),
  updateTurn: (callSid, text) =>
    set((state) => {
      const call = state.activeCalls.get(callSid);
      if (!call) return state;
      const next = new Map(state.activeCalls);
      next.set(callSid, { ...call, lastTurnText: text });
      return { activeCalls: next };
    }),
}));
```
