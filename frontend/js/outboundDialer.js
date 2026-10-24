// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND CALL DIALPAD & TELECOM DISPATCH CONTROLLER
// Triggers Real Smartflo Click-to-Call (CTC) Outbound Calls with Audio DTMF Tones
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:80';
const OUTBOUND_API_KEY = 'SDPjJRMrcf4kJlY3EoZXHd24RGJu4F8H';

// Standard Dual-Tone Multi-Frequency (DTMF) frequencies
const DTMF_FREQS = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
};

class OutboundDialer {
  constructor() {
    this.phoneNumber = '';
    this.contactName = '';
    this.agent = 'Rahul';
    this.mode = 'live'; // 'live' | 'dryRun'
    this.isCalling = false;
    this.audioCtx = null;
    this.recentCalls = [];
  }

  init() {
    this.bindEvents();
  }

  bindEvents() {
    // Topbar dial button
    const topbarBtn = document.getElementById('topbarDialBtn');
    if (topbarBtn) {
      topbarBtn.addEventListener('click', () => this.openModal());
    }

    // Modal Close button
    const closeBtn = document.getElementById('closeOutboundModal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeModal());
    }

    // Close on overlay backdrop click
    const modal = document.getElementById('outboundCallModal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeModal();
      });
    }

    // Dialpad digit buttons
    document.querySelectorAll('.dialpad-key[data-digit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const digit = btn.getAttribute('data-digit');
        this.appendDigit(digit);
      });
    });

    // Clear and Backspace
    const backspaceBtn = document.getElementById('dialpadBackspaceBtn');
    if (backspaceBtn) {
      backspaceBtn.addEventListener('click', () => this.backspace());
    }

    const clearBtn = document.getElementById('dialpadClearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearNumber());
    }

    // Number text input syncing
    const numInput = document.getElementById('dialpadNumberInput');
    if (numInput) {
      numInput.addEventListener('input', (e) => {
        this.phoneNumber = e.target.value.replace(/[^0-9*#+]/g, '');
        e.target.value = this.phoneNumber;
      });
      numInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.initiateCall();
        }
      });
    }

    // Contact name input
    const nameInput = document.getElementById('outboundContactName');
    if (nameInput) {
      nameInput.addEventListener('input', (e) => {
        this.contactName = e.target.value;
      });
    }

    // Agent selector buttons
    document.querySelectorAll('.agent-select-chip[data-agent]').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.agent-select-chip[data-agent]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.agent = chip.getAttribute('data-agent');
      });
    });

    // Mode Toggle (Live vs Dry Run)
    const modeLiveBtn = document.getElementById('modeBtnLive');
    const modeDryBtn = document.getElementById('modeBtnDry');
    if (modeLiveBtn && modeDryBtn) {
      modeLiveBtn.addEventListener('click', () => {
        this.mode = 'live';
        modeLiveBtn.classList.add('active');
        modeDryBtn.classList.remove('active');
        document.getElementById('outboundModeNote').textContent = 'Live Call: Rings destination phone via Smartflo Click-to-Call trunk.';
        document.getElementById('outboundModeNote').style.color = 'var(--emerald-liquid)';
      });
      modeDryBtn.addEventListener('click', () => {
        this.mode = 'dryRun';
        modeDryBtn.classList.add('active');
        modeLiveBtn.classList.remove('active');
        document.getElementById('outboundModeNote').textContent = 'Dry Run: Verifies telephony routing without burning Smartflo balance.';
        document.getElementById('outboundModeNote').style.color = 'var(--cyan-liquid)';
      });
    }

    // Call Initiate Button
    const dialBtn = document.getElementById('btnInitiateOutboundCall');
    if (dialBtn) {
      dialBtn.addEventListener('click', () => this.initiateCall());
    }
  }

  playDtmf(digit) {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const freqs = DTMF_FREQS[digit];
      if (!freqs) return;

      const osc1 = this.audioCtx.createOscillator();
      const osc2 = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.value = freqs[0];
      osc2.frequency.value = freqs[1];

      gain.gain.setValueAtTime(0.04, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.audioCtx.currentTime + 0.12);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc1.start();
      osc2.start();
      osc1.stop(this.audioCtx.currentTime + 0.12);
      osc2.stop(this.audioCtx.currentTime + 0.12);
    } catch (_) {
      // Audio tone is non-critical enhancement
    }
  }

  appendDigit(digit) {
    this.playDtmf(digit);
    if (this.phoneNumber.length < 15) {
      this.phoneNumber += digit;
      this.updateDisplay();
    }
  }

  backspace() {
    this.phoneNumber = this.phoneNumber.slice(0, -1);
    this.updateDisplay();
  }

  clearNumber() {
    this.phoneNumber = '';
    this.updateDisplay();
  }

  updateDisplay() {
    const input = document.getElementById('dialpadNumberInput');
    if (input) input.value = this.phoneNumber;
  }

  openModal(prefillNumber = '', prefillName = '') {
    if (prefillNumber) this.phoneNumber = prefillNumber.replace(/[^0-9*#+]/g, '');
    if (prefillName) this.contactName = prefillName;

    this.updateDisplay();

    const nameInput = document.getElementById('outboundContactName');
    if (nameInput) nameInput.value = this.contactName;

    // Reset telemetry box
    const telemetryBox = document.getElementById('outboundTelemetryBox');
    if (telemetryBox) telemetryBox.style.display = 'none';

    const modal = document.getElementById('outboundCallModal');
    if (modal) {
      modal.classList.add('active');
      const input = document.getElementById('dialpadNumberInput');
      if (input) input.focus();
    }
  }

  closeModal() {
    const modal = document.getElementById('outboundCallModal');
    if (modal) modal.classList.remove('active');
  }

  async initiateCall() {
    const cleanPhone = this.phoneNumber.trim().replace(/[^0-9]/g, '');

    if (!cleanPhone || cleanPhone.length < 10) {
      window.app.showToast('Please enter a valid 10-digit mobile number.', 'error');
      const input = document.getElementById('dialpadNumberInput');
      if (input) input.focus();
      return;
    }

    const dialBtn = document.getElementById('btnInitiateOutboundCall');
    const telemetryBox = document.getElementById('outboundTelemetryBox');
    const statusText = document.getElementById('telemetryStatusText');
    const statusDetail = document.getElementById('telemetryDetailText');

    this.isCalling = true;
    if (dialBtn) {
      dialBtn.disabled = true;
      dialBtn.innerHTML = `
        <svg class="spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite;"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10"></path></svg>
        <span>Connecting to Smartflo Trunk...</span>
      `;
    }

    if (telemetryBox) {
      telemetryBox.style.display = 'block';
      if (statusText) statusText.textContent = 'Calling Smartflo Click-to-Call API...';
      if (statusDetail) statusDetail.textContent = `Target: +91 ${cleanPhone} · Agent: ${this.agent} · Mode: ${this.mode.toUpperCase()}`;
    }

    try {
      const isDry = this.mode === 'dryRun';
      const payload = {
        phone: cleanPhone,
        name: this.contactName || 'Outbound Lead',
        dryRun: isDry,
      };

      const response = await fetch(`${API_BASE}/outbound/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': OUTBOUND_API_KEY,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        const refId = data.refId || data.reference_id || 'N/A';
        const msg = data.message || (isDry ? 'Dry Run call queued successfully.' : 'Smartflo call placed. Destination is ringing!');

        if (statusText) {
          statusText.innerHTML = `<span style="color:var(--emerald-liquid)">● Outbound Call Dispatched</span>`;
        }
        if (statusDetail) {
          statusDetail.innerHTML = `
            <strong>Ref ID:</strong> <span class="mono">${refId}</span><br>
            <strong>Status:</strong> ${msg}<br>
            <div style="margin-top:10px; display:flex; gap:10px;">
              <button class="btn-quick-recharge" style="padding:6px 14px; font-size:0.78rem;" onclick="window.outboundDialer.closeModal(); window.app.switchTab('wallboard');">
                Open Live Wallboard
              </button>
              <button class="filter-pill" style="padding:6px 14px; font-size:0.78rem;" onclick="window.app.loadRealCallLogs();">
                Sync Call Logs
              </button>
            </div>
          `;
        }

        window.app.showToast(`Outbound Call Initiated! Ref: ${refId}`, 'success');

        // Add to local recent outbound calls
        this.recentCalls.unshift({
          phone: `+91 ${cleanPhone}`,
          name: this.contactName || 'Outbound Lead',
          agent: this.agent,
          refId,
          timestamp: new Date().toLocaleTimeString(),
          mode: this.mode,
        });

        // Trigger real log refresh after brief propagation
        setTimeout(() => {
          if (window.app && window.app.loadRealCallLogs) {
            window.app.loadRealCallLogs();
          }
        }, 1500);

      } else {
        const errMsg = data.error || data.message || 'Call failed to dispatch';
        if (statusText) {
          statusText.innerHTML = `<span style="color:var(--rose-liquid)">● Trunk Rejection</span>`;
        }
        if (statusDetail) {
          statusDetail.textContent = `Error: ${errMsg}`;
        }
        window.app.showToast(`Smartflo Trunk error: ${errMsg}`, 'error');
      }
    } catch (err) {
      if (statusText) {
        statusText.innerHTML = `<span style="color:var(--rose-liquid)">● Network Error</span>`;
      }
      if (statusDetail) {
        statusDetail.textContent = `Failed to reach voice server: ${err.message}`;
      }
      window.app.showToast(`Failed to connect to backend: ${err.message}`, 'error');
    } finally {
      this.isCalling = false;
      if (dialBtn) {
        dialBtn.disabled = false;
        dialBtn.innerHTML = `
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
          <span>Initiate Outbound Call</span>
        `;
      }
    }
  }
}

export const outboundDialer = new OutboundDialer();
window.outboundDialer = outboundDialer;
