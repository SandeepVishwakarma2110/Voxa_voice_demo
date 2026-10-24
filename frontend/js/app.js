// ─────────────────────────────────────────────────────────────────────────────
// VOXA VOICE AI PLATFORM — MAIN APP CONTROLLER
// Handles Tab Routing, Real Call Logs (MongoDB), Outbound Campaigns & Telemetry
// ─────────────────────────────────────────────────────────────────────────────

import { mockData } from './mockData.js';
import { rechargeController } from './recharge.js';
import { liveWallboard } from './liveWallboard.js';
import { callPlayer } from './player.js';
import { liquidEngine } from './liquidEffects.js';
import { outboundDialer } from './outboundDialer.js';

const API_BASE = 'http://localhost:80';

class App {
  constructor() {
    this.activeTab = 'recharge'; // Default tab
    this.calls = [...mockData.calls];
    this.rawDbLogs = [];
    this.campaigns = [...mockData.campaigns];
    this.contacts = [...mockData.contacts];
    this.agents = [...mockData.agents];
    this.callFilter = 'ALL'; // 'ALL' | 'INBOUND' | 'OUTBOUND' | 'RECORDINGS'
    this.callSearchQuery = '';
    this.isLoadingLogs = false;
  }

  init() {
    this.bindNavigation();
    this.renderCampaigns();
    this.renderContacts();
    this.renderAgents();

    // Initialize Submodules
    rechargeController.init();
    liveWallboard.init();
    callPlayer.init();
    liquidEngine.init();
    outboundDialer.init();

    // Fetch Real Call Logs from MongoDB
    this.loadRealCallLogs();

    // Bind Search & Filters
    this.bindCallFilters();

    // Set initial tab
    this.switchTab('recharge');
  }

  bindNavigation() {
    document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        this.switchTab(tab);
      });
    });
  }

  switchTab(tabName) {
    this.activeTab = tabName;

    // Update Nav UI
    document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-tab') === tabName);
    });

    // Update View Sections
    document.querySelectorAll('.view-section').forEach(sec => {
      sec.classList.remove('active');
    });

    const activeSec = document.getElementById(`view-${tabName}`);
    if (activeSec) activeSec.classList.add('active');

    // Update Topbar Title
    const titleEl = document.getElementById('topbarPageTitle');
    const titles = {
      recharge: 'Billing, Wallet & Recharge Hub',
      wallboard: 'Live Operations Wallboard',
      calls: 'Call Logs & Turn Intelligence',
      campaigns: 'Outbound Dialing Campaigns',
      crm: 'Contact CRM & Memory Vault',
      agents: 'Voice Agent Studio & Personas',
    };
    if (titleEl) titleEl.textContent = titles[tabName] || 'Dashboard';

    // If switching to calls tab, refresh real logs
    if (tabName === 'calls') {
      this.loadRealCallLogs();
    }
  }

  async loadRealCallLogs() {
    this.isLoadingLogs = true;
    const syncStatusEl = document.getElementById('realLogsSyncStatus');
    if (syncStatusEl) {
      syncStatusEl.innerHTML = `<span class="pulse-dot"></span> <span>Syncing MongoDB Logs...</span>`;
    }

    try {
      const res = await fetch(`${API_BASE}/calls/logs?limit=100`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      if (data.success && Array.isArray(data.logs)) {
        this.rawDbLogs = data.logs;

        // Transform real documents into rich UI format
        this.calls = data.logs.map(log => {
          const startedDate = log.startedAt ? new Date(log.startedAt) : new Date();
          const startedFormatted = startedDate.toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          });

          // Match contact name from CRM if known
          const matchedContact = this.contacts.find(c => 
            c.phone && log.phoneNumber && c.phone.replace(/[^0-9]/g, '').slice(-10) === log.phoneNumber.replace(/[^0-9]/g, '').slice(-10)
          );

          const callerName = matchedContact ? matchedContact.name : 'Inbound Telecom Caller';

          return {
            id: log.id || log.callSid,
            callSid: log.callSid,
            callerName,
            from: log.phoneNumber || 'Carrier Line',
            phoneNumber: log.phoneNumber,
            direction: log.direction || 'INBOUND',
            agent: 'Priya',
            startedAt: log.startedAt,
            startedAtFormatted: startedFormatted,
            duration: log.durationFormatted || `${log.durationSec || 0}s`,
            durationSec: log.durationSec || 0,
            avgLatency: '620ms',
            hasRecording: log.hasRecording,
            recordingBytes: log.recordingBytes,
            recordingUrl: log.recordingUrl,
            turnsCount: log.turnsCount || (log.turns ? log.turns.length : 0),
            turns: log.turns || [],
            transcript: log.transcript || '',
            summary: log.summary,
            appointment: null,
            isReal: true,
          };
        });

        if (syncStatusEl) {
          syncStatusEl.innerHTML = `
            <span class="pulse-dot"></span>
            <span>MongoDB Connected: ${data.total || data.logs.length} Real Records Synced</span>
          `;
        }

        this.renderCallsTable();
      }
    } catch (err) {
      console.warn('Real logs load fallback to mock data:', err.message);
      if (syncStatusEl) {
        syncStatusEl.innerHTML = `
          <span style="color:var(--text-subtle);">● Offline Cache (Showing Demo Logs)</span>
        `;
      }
      this.renderCallsTable();
    } finally {
      this.isLoadingLogs = false;
    }
  }

  bindCallFilters() {
    // Search input
    const searchInput = document.getElementById('callsSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.callSearchQuery = e.target.value.toLowerCase().trim();
        this.renderCallsTable();
      });
    }

    // Refresh button
    const refreshBtn = document.getElementById('btnRefreshLogs');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        this.showToast('Refreshing real call logs from MongoDB...', 'info');
        this.loadRealCallLogs();
      });
    }

    // Filter pills
    document.querySelectorAll('.filter-pill[data-filter]').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill[data-filter]').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.callFilter = pill.getAttribute('data-filter');
        this.renderCallsTable();
      });
    });
  }

  renderCallsTable() {
    const tableBody = document.getElementById('callsTableBody');
    if (!tableBody) return;

    // Filter calls
    let list = this.calls;

    if (this.callFilter === 'INBOUND') {
      list = list.filter(c => c.direction === 'INBOUND');
    } else if (this.callFilter === 'OUTBOUND') {
      list = list.filter(c => c.direction === 'OUTBOUND');
    } else if (this.callFilter === 'RECORDINGS') {
      list = list.filter(c => c.hasRecording);
    }

    if (this.callSearchQuery) {
      list = list.filter(c => 
        (c.callSid && c.callSid.toLowerCase().includes(this.callSearchQuery)) ||
        (c.from && c.from.toLowerCase().includes(this.callSearchQuery)) ||
        (c.callerName && c.callerName.toLowerCase().includes(this.callSearchQuery))
      );
    }

    if (list.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center; padding:48px 20px; color:var(--text-muted);">
            No call records matching current filter "${this.callFilter}".
          </td>
        </tr>
      `;
      return;
    }

    tableBody.innerHTML = list.map(c => {
      const isOutbound = c.direction === 'OUTBOUND';
      const dirBadgeClass = isOutbound ? 'debit' : 'credit';
      const audioTagHtml = c.hasRecording 
        ? `<span class="audio-tag"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18v-6a9 9 0 0 1 18 0v6"></path><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"></path></svg> ${(c.recordingBytes ? (c.recordingBytes/1024).toFixed(0) : '150')} KB</span>`
        : `<span style="font-size:0.75rem; color:var(--text-subtle);">No Audio</span>`;

      return `
        <tr>
          <td class="mono" style="font-weight:700; color:#fff; font-size:0.82rem;">
            ${c.callSid}
            ${c.isReal ? '<span style="font-size:0.65rem; color:var(--emerald-liquid); margin-left:4px;">● DB</span>' : ''}
          </td>
          <td>
            <div style="font-weight:600; color:#fff;">${c.callerName}</div>
            <div class="mono" style="font-size:0.75rem; color:var(--cyan-liquid);">${c.from}</div>
          </td>
          <td><span class="badge ${dirBadgeClass}">${c.direction}</span></td>
          <td><strong>${c.agent}</strong></td>
          <td class="mono">${c.duration}</td>
          <td>${audioTagHtml}</td>
          <td style="font-size:0.8rem; color:var(--text-muted);">${c.startedAtFormatted || c.startedAt || 'Recent'}</td>
          <td>
            <button class="btn-invoice-download" onclick="window.callPlayer.openCallInspector('${c.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>
              Inspect Audio
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  renderCampaigns() {
    const container = document.getElementById('campaignsListContainer');
    if (!container) return;

    // Top: Quick Outbound Dialer Dispatcher Box
    const quickDialHtml = `
      <div class="kpi-card" style="margin-bottom: 28px; background: linear-gradient(135deg, rgba(15, 23, 42, 0.8) 0%, rgba(30, 41, 59, 0.7) 100%); border: 1px solid var(--glass-border); padding: 24px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; flex-wrap:wrap; gap:12px;">
          <div>
            <div style="font-size:0.78rem; text-transform:uppercase; font-weight:800; color:var(--emerald-liquid); letter-spacing:0.05em; margin-bottom:4px;">
              ● Smartflo Click-to-Call (CTC) Engine
            </div>
            <h3 style="font-size:1.3rem; font-weight:800; color:#fff;">Direct Outbound Telecom Dispatcher</h3>
            <p style="font-size:0.85rem; color:var(--text-muted); margin-top:2px;">
              Place instantaneous phone calls through your carrier trunk to any mobile number with Rahul or Priya.
            </p>
          </div>
          <button class="btn-outbound-dial" onclick="window.outboundDialer.openModal()">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
            <span>Open Keypad Dialer</span>
          </button>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:16px; margin-bottom:18px;">
          <div>
            <label style="font-size:0.75rem; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">Phone Number</label>
            <input type="text" id="campaignQuickPhone" class="currency-input" placeholder="e.g. 9876543210" style="padding:12px 16px; font-size:0.95rem; font-family:'JetBrains Mono', monospace; font-weight:700; margin-top:6px;" value="">
          </div>

          <div>
            <label style="font-size:0.75rem; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">Lead / Contact Name</label>
            <input type="text" id="campaignQuickName" class="currency-input" placeholder="e.g. Vikram Malhotra" style="padding:12px 16px; font-size:0.95rem; font-weight:600; margin-top:6px;" value="">
          </div>

          <div>
            <label style="font-size:0.75rem; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">Assigned Agent Persona</label>
            <select id="campaignQuickAgent" class="currency-input" style="padding:12px 16px; font-size:0.95rem; font-weight:600; margin-top:6px;">
              <option value="Rahul">Rahul (Sales & Real Estate AI)</option>
              <option value="Priya">Priya (Consultation & Inbound AI)</option>
            </select>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px; border-top:1px solid var(--glass-border); padding-top:16px;">
          <div style="font-size:0.8rem; color:var(--emerald-liquid); font-weight:600;">
            ● Smartflo CTC Trunk Ready: Caller ID configured
          </div>
          <div style="display:flex; gap:12px;">
            <button class="filter-pill" onclick="window.app.triggerQuickOutbound(true)" style="padding:10px 20px; font-weight:700;">
              Dry Run Test
            </button>
            <button class="btn-outbound-dial" onclick="window.app.triggerQuickOutbound(false)" style="padding:10px 24px; font-size:0.95rem;">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>Place Live Call</span>
            </button>
          </div>
        </div>
      </div>
    `;

    // Existing campaign list cards
    const campaignsHtml = this.campaigns.map(camp => `
      <div class="kpi-card" style="margin-bottom: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px;">
          <div>
            <h3 style="font-size:1.1rem; font-weight:700; color:#fff; margin-bottom:4px;">${camp.name}</h3>
            <div style="font-size:0.8rem; color:var(--text-subtle);">Agent: <strong>${camp.agent}</strong> · Calling Window: <strong>${camp.callingHours}</strong></div>
          </div>
          <span class="badge ${camp.status === 'Running' ? 'credit' : 'debit'}">${camp.status}</span>
        </div>

        <div style="margin: 16px 0;">
          <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:6px; color:var(--text-muted);">
            <span>Progress (${camp.contacted}/${camp.totalLeads} Leads)</span>
            <span class="mono font-bold">${camp.progress}%</span>
          </div>
          <div style="height:8px; background:var(--bg-tertiary); border-radius:4px; overflow:hidden;">
            <div style="height:100%; width:${camp.progress}%; background:linear-gradient(90deg, var(--indigo-primary), var(--cyan-accent));"></div>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; font-size:0.85rem; color:var(--text-muted); border-top:1px solid var(--border-subtle); padding-top:12px;">
          <span>Converted: <strong style="color:var(--emerald-success);">${camp.converted}</strong></span>
          <span>Failed/Busy: <strong style="color:var(--rose-danger);">${camp.failed}</strong></span>
          <span>Concurrency: <strong>${camp.concurrency} lines</strong></span>
          <button class="btn-quick-recharge" style="padding:4px 10px; font-size:0.75rem;" onclick="window.app.toggleCampaignStatus('${camp.id}')">
            ${camp.status === 'Running' ? 'Pause' : 'Resume'}
          </button>
        </div>
      </div>
    `).join('');

    container.innerHTML = quickDialHtml + campaignsHtml;
  }

  triggerQuickOutbound(isDryRun = false) {
    const phoneInput = document.getElementById('campaignQuickPhone');
    const nameInput = document.getElementById('campaignQuickName');
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const name = nameInput ? nameInput.value.trim() : '';

    if (!phone) {
      this.showToast('Please enter a phone number in the quick dialer.', 'error');
      if (phoneInput) phoneInput.focus();
      return;
    }

    outboundDialer.openModal(phone, name);
    if (isDryRun) {
      const modeDryBtn = document.getElementById('modeBtnDry');
      if (modeDryBtn) modeDryBtn.click();
    } else {
      const modeLiveBtn = document.getElementById('modeBtnLive');
      if (modeLiveBtn) modeLiveBtn.click();
    }
  }

  toggleCampaignStatus(campId) {
    const camp = this.campaigns.find(c => c.id === campId);
    if (!camp) return;
    camp.status = camp.status === 'Running' ? 'Paused' : 'Running';
    this.renderCampaigns();
    this.showToast(`Campaign "${camp.name}" is now ${camp.status}.`, 'info');
  }

  renderContacts() {
    const container = document.getElementById('contactsListContainer');
    if (!container) return;

    container.innerHTML = this.contacts.map(c => `
      <div class="kpi-card" style="margin-bottom: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
          <div>
            <h4 style="font-size:1.05rem; font-weight:700; color:#fff;">${c.name}</h4>
            <div class="mono" style="font-size:0.8rem; color:var(--cyan-accent);">${c.phone} · ${c.company}</div>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            <button class="btn-outbound-dial" style="padding:4px 12px; font-size:0.75rem;" onclick="window.outboundDialer.openModal('${c.phone}', '${c.name}')">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              <span>Call Lead</span>
            </button>
            <span class="badge credit">${c.status}</span>
          </div>
        </div>

        <div style="background:var(--bg-secondary); border-radius:var(--radius-sm); padding:12px; margin-top:8px; border:1px solid var(--border-subtle);">
          <div style="font-size:0.72rem; font-weight:700; text-transform:uppercase; color:var(--text-subtle); margin-bottom:6px;">Long-Term Memory Facts</div>
          <div style="display:flex; flex-wrap:wrap; gap:8px;">
            ${c.memories.map(m => `
              <span style="font-size:0.78rem; background:var(--bg-tertiary); padding:4px 10px; border-radius:12px; border:1px solid var(--border-subtle); color:#cbd5e1;">
                <strong style="color:var(--indigo-primary);">${m.key}:</strong> ${m.value}
              </span>
            `).join('')}
          </div>
        </div>
      </div>
    `).join('');
  }

  renderAgents() {
    const container = document.getElementById('agentsListContainer');
    if (!container) return;

    container.innerHTML = this.agents.map(a => `
      <div class="kpi-card" style="margin-bottom: 20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <div>
            <h3 style="font-size:1.2rem; font-weight:800; color:#fff;">${a.name}</h3>
            <div style="font-size:0.82rem; color:var(--text-subtle);">${a.role}</div>
          </div>
          <button class="btn-quick-recharge" onclick="window.app.saveAgentPrompt('${a.id}')">Save Changes</button>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
          <div>
            <label style="font-size:0.75rem; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">STT Pipeline</label>
            <input type="text" value="${a.sttProvider}" readonly style="width:100%; padding:8px 12px; background:var(--bg-secondary); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); color:#fff; font-size:0.85rem; margin-top:4px;">
          </div>
          <div>
            <label style="font-size:0.75rem; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">TTS Voice</label>
            <input type="text" value="${a.ttsVoice}" readonly style="width:100%; padding:8px 12px; background:var(--bg-secondary); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); color:#fff; font-size:0.85rem; margin-top:4px;">
          </div>
        </div>

        <div>
          <label style="font-size:0.75rem; font-weight:700; color:var(--text-subtle); text-transform:uppercase;">System Persona Prompt</label>
          <textarea id="prompt-${a.id}" rows="4" style="width:100%; padding:12px; background:var(--bg-secondary); border:1px solid var(--border-medium); border-radius:var(--radius-sm); color:#cbd5e1; font-family:'JetBrains Mono', monospace; font-size:0.82rem; margin-top:6px; line-height:1.4; resize:vertical;">${a.systemPrompt}</textarea>
        </div>
      </div>
    `).join('');
  }

  saveAgentPrompt(agentId) {
    const textarea = document.getElementById(`prompt-${agentId}`);
    if (textarea) {
      const agent = this.agents.find(a => a.id === agentId);
      if (agent) agent.systemPrompt = textarea.value;
      this.showToast(`Saved updated prompt for ${agent.name}. New version committed!`, 'success');
    }
  }

  triggerSimulatedInboundCall() {
    liveWallboard.addSimulatedCall();
    this.switchTab('wallboard');
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        ${type === 'success' ? '<polyline points="20 6 9 17 4 12"></polyline>' : (type === 'error' ? '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>' : '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line>')}
      </svg>
      <span>${message}</span>
    `;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }
}

export const app = new App();
window.app = app;

document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
