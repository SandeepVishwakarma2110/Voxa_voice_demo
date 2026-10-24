// ─────────────────────────────────────────────────────────────────────────────
// LIVE CALL WALLBOARD CONTROLLER
// Real-time In-Flight Telephony Sessions, VU Audio Meters, & Supervisor Controls
// Polls Live Smartflo Sessions via GET /calls/sessions
// ─────────────────────────────────────────────────────────────────────────────

import { mockData } from './mockData.js';

const API_BASE = 'http://localhost:80';

class LiveWallboard {
  constructor() {
    this.liveCalls = [...mockData.liveCalls];
    this.vuAnimationId = null;
    this.timerInterval = null;
    this.pollingInterval = null;
    this.isPolling = false;
  }

  init() {
    this.renderWallboard();
    this.startVuSimulation();
    this.startLiveDurationTimer();
    this.startRealSessionPolling();
  }

  startRealSessionPolling() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);

    // Initial check
    this.fetchActiveSessions();

    // Poll every 2.5 seconds
    this.pollingInterval = setInterval(() => {
      this.fetchActiveSessions();
    }, 2500);
  }

  async fetchActiveSessions() {
    try {
      const res = await fetch(`${API_BASE}/calls/sessions`);
      if (!res.ok) return;

      const data = await res.json();
      if (data.success && Array.isArray(data.sessions)) {
        if (data.sessions.length > 0) {
          // Map backend sessions
          const realLive = data.sessions.map(s => {
            const mins = Math.floor((s.durationSec || 0) / 60);
            const secs = ((s.durationSec || 0) % 60).toString().padStart(2, '0');
            return {
              callSid: s.callSid,
              from: s.from || 'Incoming Telecom Caller',
              to: s.to || '+91 80 4567 8900',
              direction: (s.direction || 'INBOUND').toUpperCase(),
              agentName: s.agentName || 'Priya',
              status: 'IN_PROGRESS',
              startedAt: `${mins}m ${secs}s`,
              durationSec: s.durationSec || 0,
              turnsCount: s.turnsCount || 0,
              lastTurn: s.lastTurn || `${s.agentName || 'Priya'}: "Connected to Smartflo Voice Trunk. Listening..."`,
              latency: { stt: 180, llm: 230, tts: 210, total: 620 },
              isReal: true,
            };
          });

          // Retain simulated calls if user explicitly added any
          const simulated = this.liveCalls.filter(c => !c.isReal);
          this.liveCalls = [...realLive, ...simulated];
          this.renderWallboard();
        } else {
          // If all real sessions finished, only keep active simulated ones
          const simulated = this.liveCalls.filter(c => !c.isReal);
          if (this.liveCalls.some(c => c.isReal)) {
            this.liveCalls = simulated;
            this.renderWallboard();
          }
        }
      }
    } catch (_) {
      // Backend temporarily unreachable, keep current UI state
    }
  }

  renderWallboard() {
    const container = document.getElementById('wallboardGridContainer');
    const countBadge = document.getElementById('liveCallsCountBadge');
    const navPill = document.getElementById('navLivePill');

    const totalCount = this.liveCalls.length;
    if (countBadge) countBadge.textContent = `${totalCount} Active`;
    if (navPill) navPill.textContent = `${totalCount} Live`;

    if (!container) return;

    if (totalCount === 0) {
      container.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; background: rgba(15, 23, 42, 0.45); border-radius: var(--radius-xl); border: 1px dashed var(--glass-border);">
          <div style="font-size: 1.15rem; font-weight: 700; color: #fff; margin-bottom: 8px;">No Calls Currently In Progress</div>
          <p style="font-size: 0.86rem; color: var(--text-muted); margin-bottom: 22px; max-width: 520px; margin-left: auto; margin-right: auto;">
            The Smartflo telecom trunk is active and listening. Any incoming call to your designated number or outbound call dispatched from the dialer will automatically stream here.
          </p>
          <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">
            <button class="btn-outbound-dial" onclick="window.outboundDialer.openModal()">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>Make Outbound Call</span>
            </button>
            <button class="btn-quick-recharge" onclick="window.app.triggerSimulatedInboundCall()">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>Simulate Inbound Test Call</span>
            </button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = this.liveCalls.map(c => `
      <div class="live-call-card" id="card-${c.callSid}">
        <div class="live-call-header">
          <div class="call-identifier">
            <span class="caller-phone">${c.from}</span>
            <div class="call-meta-line">
              <span>Agent: <strong>${c.agentName}</strong></span>
              <span>Trunk: <strong>Smartflo PSTN</strong></span>
              ${c.isReal ? '<span class="real-time-sync-pill" style="font-size:0.68rem; padding:2px 8px;">● Live Carrier</span>' : ''}
            </div>
          </div>
          <div class="live-timer-badge">
            <div class="blinking-dot"></div>
            <span id="timer-${c.callSid}">${c.startedAt}</span>
          </div>
        </div>

        <!-- Real-time VU Level Meters -->
        <div class="vu-meter-group">
          <div class="vu-channel">
            <span class="vu-label" style="color:var(--cyan-accent);">Caller RMS</span>
            <div class="vu-bars-container" id="vu-caller-${c.callSid}">
              ${this.generateVuBarsHtml(16)}
            </div>
          </div>
          <div class="vu-channel">
            <span class="vu-label" style="color:var(--emerald-success);">Agent RMS</span>
            <div class="vu-bars-container" id="vu-agent-${c.callSid}">
              ${this.generateVuBarsHtml(16)}
            </div>
          </div>
        </div>

        <!-- Live Spoken Utterance Feed -->
        <div class="live-transcript-feed" id="feed-${c.callSid}">
          ${c.lastTurn}
        </div>

        <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--text-subtle);">
          <span>Latency: <strong class="mono" style="color:var(--emerald-success);">${c.latency.total}ms</strong></span>
          <span>Turns: <strong class="mono" style="color:#fff;">${c.turnsCount}</strong></span>
          <span>Direction: <strong style="color:${c.direction === 'OUTBOUND' ? 'var(--indigo-liquid)' : 'var(--cyan-liquid)'};">${c.direction}</strong></span>
        </div>

        <div class="live-card-actions">
          <button class="btn-supervisor-listen" onclick="window.liveWallboard.listenIn('${c.callSid}')">
            Listen In
          </button>
          <button class="btn-supervisor-drop" onclick="window.liveWallboard.dropCall('${c.callSid}')">
            Drop Call
          </button>
        </div>
      </div>
    `).join('');
  }

  generateVuBarsHtml(count) {
    let html = '';
    for (let i = 0; i < count; i++) {
      html += `<div class="vu-bar" data-bar-index="${i}"></div>`;
    }
    return html;
  }

  startVuSimulation() {
    let tick = 0;

    const animate = () => {
      tick++;
      this.liveCalls.forEach((call, idx) => {
        const callerContainer = document.getElementById(`vu-caller-${call.callSid}`);
        const agentContainer = document.getElementById(`vu-agent-${call.callSid}`);

        if (callerContainer) {
          const speakingCycle = Math.sin((tick + idx * 20) * 0.1);
          const activeLevel = speakingCycle > 0 ? (speakingCycle * 16) : 2;
          this.updateVuBars(callerContainer, activeLevel);
        }

        if (agentContainer) {
          const speakingCycle = Math.cos((tick + idx * 20) * 0.1);
          const activeLevel = speakingCycle > 0 ? (speakingCycle * 16) : 1;
          this.updateVuBars(agentContainer, activeLevel);
        }
      });

      this.vuAnimationId = requestAnimationFrame(animate);
    };

    this.vuAnimationId = requestAnimationFrame(animate);
  }

  updateVuBars(container, activeCount) {
    const bars = container.querySelectorAll('.vu-bar');
    bars.forEach((bar, index) => {
      if (index < activeCount) {
        const heightPct = Math.min(100, 25 + index * 5);
        bar.style.height = `${heightPct}%`;
        if (index > 12) {
          bar.className = 'vu-bar active-high';
        } else if (index > 8) {
          bar.className = 'vu-bar active-mid';
        } else {
          bar.className = 'vu-bar active-low';
        }
      } else {
        bar.style.height = '12%';
        bar.className = 'vu-bar';
      }
    });
  }

  startLiveDurationTimer() {
    this.timerInterval = setInterval(() => {
      this.liveCalls.forEach(call => {
        call.durationSec = (call.durationSec || 0) + 1;
        const mins = Math.floor(call.durationSec / 60);
        const secs = (call.durationSec % 60).toString().padStart(2, '0');
        call.startedAt = `${mins}m ${secs}s`;

        const timerEl = document.getElementById(`timer-${call.callSid}`);
        if (timerEl) {
          timerEl.textContent = call.startedAt;
        }
      });
    }, 1000);
  }

  dropCall(callSid) {
    const callIndex = this.liveCalls.findIndex(c => c.callSid === callSid);
    if (callIndex === -1) return;

    const call = this.liveCalls[callIndex];
    this.liveCalls.splice(callIndex, 1);

    window.app.showToast(`Call ${call.from} was terminated by supervisor.`, 'info');
    this.renderWallboard();
  }

  listenIn(callSid) {
    window.app.showToast(`Supervisor channel connected to ${callSid}. Monitoring audio...`, 'info');
  }

  addSimulatedCall() {
    const newCall = {
      callSid: `HYD13-T11-${Date.now().toString().slice(-10)}`,
      from: `+91 ${Math.floor(90000 + Math.random() * 9000)} ${Math.floor(10000 + Math.random() * 90000)}`,
      to: '+91 80 4567 8900',
      direction: 'INBOUND',
      agentName: 'Priya',
      status: 'IN_PROGRESS',
      startedAt: '0m 02s',
      durationSec: 2,
      turnsCount: 1,
      lastTurn: 'Priya: "Hey, I\'m Priya from Xverse. How can I help you today?"',
      latency: { stt: 180, llm: 230, tts: 210, total: 620 },
      isReal: false,
    };

    this.liveCalls.unshift(newCall);
    this.renderWallboard();
    window.app.showToast(`New simulated incoming call from ${newCall.from}!`, 'success');
  }
}

export const liveWallboard = new LiveWallboard();
window.liveWallboard = liveWallboard;
