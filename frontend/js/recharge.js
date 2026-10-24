// ─────────────────────────────────────────────────────────────────────────────
// RECHARGE & BILLING WALLET CONTROLLER
// Handles Plans, Checkout Modal, UPI/Card Simulation, Ledger & Cost Calculator
// ─────────────────────────────────────────────────────────────────────────────

import { mockData } from './mockData.js';

class RechargeController {
  constructor() {
    this.wallet = mockData.wallet;
    this.plans = mockData.plans;
    this.transactions = mockData.transactions;
    this.selectedPlan = this.plans.find(p => p.id === 'growth') || this.plans[0];
    this.customAmount = 2500;
    this.appliedDiscount = 0;
    this.appliedCoupon = null;
    this.activePaymentMethod = 'upi'; // 'upi' | 'card' | 'netbanking'
  }

  init() {
    this.renderHeaderBalance();
    this.renderBillingView();
    this.bindEvents();
  }

  renderHeaderBalance() {
    const balanceEl = document.getElementById('topbarWalletBalance');
    const minutesEl = document.getElementById('topbarMinutesEst');
    if (balanceEl) {
      balanceEl.textContent = `${this.wallet.symbol}${this.formatMoney(this.wallet.balance)}`;
    }
    if (minutesEl) {
      const mins = Math.floor(this.wallet.balance / this.wallet.burnRatePerMin);
      minutesEl.textContent = `~${mins} mins`;
    }
  }

  renderBillingView() {
    // 1. Hero balance
    const heroBalanceEl = document.getElementById('heroBalanceAmount');
    const heroMinsEl = document.getElementById('heroMinutesLeft');
    const heroBurnEl = document.getElementById('heroBurnRate');
    const heroRunwayEl = document.getElementById('heroRunwayDays');

    if (heroBalanceEl) {
      heroBalanceEl.innerHTML = `${this.wallet.symbol}${this.formatMoney(this.wallet.balance)} <small>/ ${this.wallet.currency}</small>`;
    }
    if (heroMinsEl) {
      const mins = Math.floor(this.wallet.balance / this.wallet.burnRatePerMin);
      heroMinsEl.textContent = `${mins.toLocaleString()} Mins`;
    }
    if (heroBurnEl) {
      heroBurnEl.textContent = `${this.wallet.symbol}${this.wallet.burnRatePerMin.toFixed(2)} / min`;
    }
    if (heroRunwayEl) {
      // Assuming 60 mins/day usage
      const days = Math.floor((this.wallet.balance / this.wallet.burnRatePerMin) / 60);
      heroRunwayEl.textContent = `~${days} Days`;
    }

    // 2. Render Plans Grid
    const plansContainer = document.getElementById('plansGridContainer');
    if (plansContainer) {
      plansContainer.innerHTML = this.plans.map(plan => `
        <div class="plan-card ${plan.featured ? 'featured' : ''}" data-plan-id="${plan.id}">
          ${plan.badge ? `<div class="plan-badge">${plan.badge}</div>` : ''}
          <div class="plan-name">${plan.name}</div>
          <div class="plan-desc">${plan.desc}</div>
          <div class="plan-price">${this.wallet.symbol}${plan.price.toLocaleString()}</div>
          <div class="plan-rate">${plan.rate} (${plan.minutes} mins)</div>
          <ul class="plan-features">
            ${plan.features.map(f => `
              <li>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                ${f}
              </li>
            `).join('')}
          </ul>
          <button class="btn-select-plan" data-action="buy-plan" data-plan-id="${plan.id}">
            Recharge with ${plan.name}
          </button>
        </div>
      `).join('');
    }

    // 3. Render Transactions Table
    this.renderTransactionsTable();

    // 4. Update Custom Slider Calculator
    this.updateCustomCalculator();
  }

  renderTransactionsTable() {
    const tableBody = document.getElementById('transactionsTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = this.transactions.map(t => {
      const isCredit = t.type === 'credit';
      const amountFormatted = `${isCredit ? '+' : ''}${this.wallet.symbol}${Math.abs(t.amount).toFixed(2)}`;
      const badgeClass = isCredit ? 'badge credit' : 'badge debit';
      const badgeText = isCredit ? 'CREDIT' : 'DEBIT';

      return `
        <tr>
          <td class="mono" style="font-size:0.8rem; color: var(--text-subtle);">${t.date}</td>
          <td>
            <div style="font-weight:600; color: #fff;">${t.title}</div>
            <div class="mono" style="font-size:0.75rem; color: var(--text-subtle);">Ref: ${t.refId}</div>
          </td>
          <td><span class="${badgeClass}">${badgeText}</span></td>
          <td class="mono" style="font-weight:700; color: ${isCredit ? 'var(--emerald-success)' : '#fff'};">${amountFormatted}</td>
          <td class="mono">${this.wallet.symbol}${t.balanceAfter.toFixed(2)}</td>
          <td><span class="badge success">Paid</span></td>
          <td>
            <button class="btn-invoice-download" onclick="window.rechargeCtrl.downloadInvoice('${t.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              Invoice
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  updateCustomCalculator() {
    const inputEl = document.getElementById('customAmountInput');
    const sliderEl = document.getElementById('customAmountSlider');
    const estMinsEl = document.getElementById('calcEstMins');
    const estSubtotalEl = document.getElementById('calcSubtotal');
    const estGstEl = document.getElementById('calcGst');
    const estTotalEl = document.getElementById('calcGrandTotal');

    if (!inputEl) return;

    const amount = Number(inputEl.value) || 1000;
    this.customAmount = amount;
    if (sliderEl) sliderEl.value = amount;

    const rate = amount >= 5000 ? 3.80 : amount >= 2500 ? 4.10 : 4.50;
    const estMins = Math.floor(amount / rate);
    const gst = Math.round(amount * 0.18);
    const total = amount + gst;

    if (estMinsEl) estMinsEl.textContent = `~${estMins} Minutes`;
    if (estSubtotalEl) estSubtotalEl.textContent = `${this.wallet.symbol}${amount.toLocaleString()}`;
    if (estGstEl) estGstEl.textContent = `${this.wallet.symbol}${gst.toLocaleString()}`;
    if (estTotalEl) estTotalEl.textContent = `${this.wallet.symbol}${total.toLocaleString()}`;
  }

  openCheckoutModal(planOrCustom) {
    const modal = document.getElementById('rechargeModal');
    if (!modal) return;

    let baseAmount = 0;
    let title = '';

    if (typeof planOrCustom === 'string') {
      const plan = this.plans.find(p => p.id === planOrCustom);
      if (plan) {
        this.selectedPlan = plan;
        baseAmount = plan.price;
        title = `${plan.name} (${plan.minutes} Mins)`;
      }
    } else {
      baseAmount = Number(planOrCustom) || this.customAmount;
      title = `Custom Top-Up (${this.wallet.symbol}${baseAmount})`;
    }

    this.currentCheckoutBase = baseAmount;
    this.appliedDiscount = 0;
    this.appliedCoupon = null;

    // Reset screens
    document.getElementById('checkoutFormScreen').style.display = 'block';
    document.getElementById('checkoutSuccessScreen').classList.remove('active');
    document.getElementById('checkoutPlanTitle').textContent = title;

    this.updateModalSummary();
    modal.classList.add('active');
  }

  closeCheckoutModal() {
    const modal = document.getElementById('rechargeModal');
    if (modal) modal.classList.remove('active');
  }

  updateModalSummary() {
    const subtotal = this.currentCheckoutBase;
    const discount = this.appliedDiscount;
    const taxable = Math.max(0, subtotal - discount);
    const gst = Math.round(taxable * 0.18);
    const grandTotal = taxable + gst;

    document.getElementById('modalSubtotal').textContent = `${this.wallet.symbol}${subtotal.toLocaleString()}`;
    document.getElementById('modalDiscount').textContent = `-${this.wallet.symbol}${discount.toLocaleString()}`;
    document.getElementById('modalGst').textContent = `${this.wallet.symbol}${gst.toLocaleString()}`;
    document.getElementById('modalGrandTotal').textContent = `${this.wallet.symbol}${grandTotal.toLocaleString()}`;
    document.getElementById('btnPayAmount').textContent = `Pay ${this.wallet.symbol}${grandTotal.toLocaleString()}`;
  }

  applyCouponCode(code) {
    const clean = (code || '').trim().toUpperCase();
    if (!clean) return;

    if (clean === 'VOXA10') {
      this.appliedDiscount = Math.round(this.currentCheckoutBase * 0.10);
      this.appliedCoupon = clean;
      window.app.showToast('10% Discount Coupon Applied!', 'success');
    } else if (clean === 'WELCOME500') {
      this.appliedDiscount = Math.min(500, this.currentCheckoutBase * 0.20);
      this.appliedCoupon = clean;
      window.app.showToast('₹500 Welcome Discount Applied!', 'success');
    } else {
      window.app.showToast('Invalid Coupon Code. Try VOXA10', 'info');
      return;
    }
    this.updateModalSummary();
  }

  executePaymentSimulation() {
    const payBtn = document.getElementById('btnPayAmount');
    payBtn.disabled = true;
    payBtn.innerHTML = `
      <svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 0.8s linear infinite;">
        <circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle>
        <path d="M12 2a10 10 0 0 1 10 10"></path>
      </svg>
      Processing Transaction...
    `;

    setTimeout(() => {
      const previousBalance = this.wallet.balance;
      const amountAdded = this.currentCheckoutBase;
      this.wallet.balance += amountAdded;

      const newTxn = {
        id: `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
        date: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST',
        type: 'credit',
        title: `Wallet Recharge — ${this.activePaymentMethod.toUpperCase()} Pack`,
        refId: `PAY-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
        carrierCost: 0,
        sttCost: 0,
        llmCost: 0,
        ttsCost: 0,
        amount: amountAdded,
        balanceAfter: this.wallet.balance,
        status: 'success',
        invoiceUrl: '#',
      };

      this.transactions.unshift(newTxn);

      // Smooth Liquid Number Rolling on Topbar & Hero Banner
      const topbarEl = document.getElementById('topbarWalletBalance');
      const heroEl = document.getElementById('heroBalanceAmount');
      if (window.liquidEngine) {
        window.liquidEngine.animateValue(topbarEl, previousBalance, this.wallet.balance, 1200, this.wallet.symbol);
        window.liquidEngine.animateValue(heroEl, previousBalance, this.wallet.balance, 1400, this.wallet.symbol, `/ ${this.wallet.currency}`);
      }

      this.renderBillingView();

      // Show Success Screen
      document.getElementById('checkoutFormScreen').style.display = 'none';
      const successScreen = document.getElementById('checkoutSuccessScreen');
      successScreen.style.display = 'flex';

      document.getElementById('successAmountText').textContent = `${this.wallet.symbol}${amountAdded.toLocaleString()}`;
      document.getElementById('successTxnRef').textContent = newTxn.refId;
      document.getElementById('successNewBalance').textContent = `${this.wallet.symbol}${this.formatMoney(this.wallet.balance)}`;

      payBtn.disabled = false;
      payBtn.textContent = 'Pay Now';

      window.app.showToast(`Recharge of ${this.wallet.symbol}${amountAdded.toLocaleString()} was successful!`, 'success');
    }, 1200);
  }

  downloadInvoice(txnId) {
    const txn = this.transactions.find(t => t.id === txnId) || this.transactions[0];
    window.app.showToast(`Downloading Tax Invoice ${txn.id}.pdf...`, 'info');
    setTimeout(() => {
      window.app.showToast(`Invoice ${txn.id} downloaded!`, 'success');
    }, 1000);
  }

  formatMoney(num) {
    return Number(num).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  bindEvents() {
    // Topbar quick recharge button
    const quickBtn = document.getElementById('topbarRechargeBtn');
    if (quickBtn) {
      quickBtn.addEventListener('click', () => this.openCheckoutModal('growth'));
    }

    // Hero banner button
    const heroBtn = document.getElementById('heroRechargeBtn');
    if (heroBtn) {
      heroBtn.addEventListener('click', () => this.openCheckoutModal('growth'));
    }

    // Plan selection buttons
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action="buy-plan"]');
      if (target) {
        const planId = target.getAttribute('data-plan-id');
        this.openCheckoutModal(planId);
      }
    });

    // Custom Recharge Slider & Input
    const slider = document.getElementById('customAmountSlider');
    const input = document.getElementById('customAmountInput');
    if (slider && input) {
      slider.addEventListener('input', (e) => {
        input.value = e.target.value;
        this.updateCustomCalculator();
      });
      input.addEventListener('input', (e) => {
        slider.value = e.target.value;
        this.updateCustomCalculator();
      });
    }

    // Amount chips
    document.querySelectorAll('.chip[data-amount]').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.getAttribute('data-amount');
        if (input) input.value = val;
        this.updateCustomCalculator();
      });
    });

    // Custom Buy Button
    const customBuyBtn = document.getElementById('btnCustomRecharge');
    if (customBuyBtn) {
      customBuyBtn.addEventListener('click', () => {
        this.openCheckoutModal(this.customAmount);
      });
    }

    // Payment Method Switching
    document.querySelectorAll('.method-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.method-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        this.activePaymentMethod = card.getAttribute('data-method');

        // Toggle Views
        const upiView = document.getElementById('methodViewUpi');
        const cardView = document.getElementById('methodViewCard');
        const netView = document.getElementById('methodViewNetbanking');

        if (upiView) upiView.style.display = this.activePaymentMethod === 'upi' ? 'flex' : 'none';
        if (cardView) cardView.style.display = this.activePaymentMethod === 'card' ? 'flex' : 'none';
        if (netView) netView.style.display = this.activePaymentMethod === 'netbanking' ? 'flex' : 'none';
      });
    });

    // Coupon Apply
    const couponBtn = document.getElementById('btnApplyCoupon');
    const couponInput = document.getElementById('couponCodeInput');
    if (couponBtn && couponInput) {
      couponBtn.addEventListener('click', () => this.applyCouponCode(couponInput.value));
    }

    // Complete Pay Button
    const payBtn = document.getElementById('btnPayAmount');
    if (payBtn) {
      payBtn.addEventListener('click', () => this.executePaymentSimulation());
    }

    // Close Modal Button
    const closeBtn = document.getElementById('closeRechargeModal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeCheckoutModal());
    }
  }
}

export const rechargeController = new RechargeController();
window.rechargeCtrl = rechargeController;
