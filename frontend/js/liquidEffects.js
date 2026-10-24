// ─────────────────────────────────────────────────────────────────────────────
// LIQUID GLASS & FLUID INTERACTIVITY ENGINE
// Specular Glare, 3D Card Tilt, Liquid Ripple, Ambient Voice Wave & Number Easing
// ─────────────────────────────────────────────────────────────────────────────

export class LiquidEffectsEngine {
  constructor() {
    this.mouse = { x: -1000, y: -1000, targetX: -1000, targetY: -1000 };
    this.ambientCanvas = null;
    this.ambientCtx = null;
    this.ambientAnimId = null;
  }

  init() {
    this.initCursorGlow();
    this.init3DTilt();
    this.initLiquidRipples();
    this.initAmbientLiquidWave();
  }

  // ── 1. Interactive Cursor Spotlight on Glass Panels ──────────────────────────
  initCursorGlow() {
    const updateMouse = (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;

      // Update cursor spotlight for all glass panels in viewport
      const panels = document.querySelectorAll(
        '.glass-panel, .kpi-card, .plan-card, .live-call-card, .wallet-hero-banner, .custom-recharge-card, .table-card, .modal-content, .btn-large-recharge, .btn-quick-recharge'
      );

      panels.forEach((panel) => {
        const rect = panel.getBoundingClientRect();
        // Only calculate if visible on screen
        if (
          rect.top < window.innerHeight &&
          rect.bottom > 0 &&
          rect.left < window.innerWidth &&
          rect.right > 0
        ) {
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          panel.style.setProperty('--mouse-x', `${x}px`);
          panel.style.setProperty('--mouse-y', `${y}px`);
        }
      });

      // Update ambient floating cursor glow
      const cursorGlow = document.getElementById('cursorAmbientGlow');
      if (cursorGlow) {
        cursorGlow.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
      }
    };

    window.addEventListener('mousemove', updateMouse, { passive: true });
  }

  // ── 2. Subtle Organic 3D Tilt on Hover ──────────────────────────────────────
  init3DTilt() {
    const tiltElements = document.querySelectorAll(
      '.plan-card, .live-call-card, .kpi-card, .wallet-hero-banner'
    );

    tiltElements.forEach((el) => {
      el.addEventListener('mousemove', (e) => {
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const centerX = rect.width / 2;
        const centerY = rect.height / 2;

        const rotateX = ((y - centerY) / centerY) * -4; // Max 4 deg tilt
        const rotateY = ((x - centerX) / centerX) * 4;

        el.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-4px) scale3d(1.01, 1.01, 1.01)`;
      });

      el.addEventListener('mouseleave', () => {
        el.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) translateY(0) scale3d(1, 1, 1)`;
      });
    });
  }

  // ── 3. Liquid Click Ripple Expansion ─────────────────────────────────────────
  initLiquidRipples() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest(
        'button, .plan-card, .nav-item, .chip, .method-card, .transcript-turn'
      );
      if (!target) return;

      const rect = target.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'liquid-ripple-effect';

      const diameter = Math.max(rect.width, rect.height) * 1.6;
      const radius = diameter / 2;

      ripple.style.width = ripple.style.height = `${diameter}px`;
      ripple.style.left = `${e.clientX - rect.left - radius}px`;
      ripple.style.top = `${e.clientY - rect.top - radius}px`;

      target.appendChild(ripple);
      setTimeout(() => ripple.remove(), 700);
    });
  }

  // ── 4. Ambient Liquid Soundwave Canvas in Hero Banner ─────────────────────────
  initAmbientLiquidWave() {
    this.ambientCanvas = document.getElementById('liquidSoundwaveCanvas');
    if (!this.ambientCanvas) return;
    this.ambientCtx = this.ambientCanvas.getContext('2d');

    const resize = () => {
      if (!this.ambientCanvas) return;
      this.ambientCanvas.width = this.ambientCanvas.parentElement.clientWidth;
      this.ambientCanvas.height = this.ambientCanvas.parentElement.clientHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    let phase = 0;
    const render = () => {
      if (!this.ambientCtx || !this.ambientCanvas) return;
      const ctx = this.ambientCtx;
      const w = this.ambientCanvas.width;
      const h = this.ambientCanvas.height;

      ctx.clearRect(0, 0, w, h);
      phase += 0.025;

      // Draw multi-layered liquid sine waves
      const waves = [
        { color: 'rgba(99, 102, 241, 0.28)', freq: 0.012, amp: 28, speed: 1.0, yOffset: h * 0.55 },
        { color: 'rgba(6, 182, 212, 0.22)', freq: 0.018, amp: 36, speed: -1.2, yOffset: h * 0.5 },
        { color: 'rgba(168, 85, 247, 0.18)', freq: 0.009, amp: 22, speed: 0.8, yOffset: h * 0.62 },
        { color: 'rgba(16, 185, 129, 0.15)', freq: 0.015, amp: 18, speed: -0.6, yOffset: h * 0.45 },
      ];

      waves.forEach((wave) => {
        ctx.beginPath();
        ctx.moveTo(0, h);

        for (let x = 0; x <= w; x += 4) {
          const y =
            wave.yOffset +
            Math.sin(x * wave.freq + phase * wave.speed) * wave.amp +
            Math.cos(x * 0.005 + phase * 0.5) * 12;
          ctx.lineTo(x, y);
        }

        ctx.lineTo(w, h);
        ctx.closePath();

        // Shimmering liquid gradient
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, wave.color);
        grad.addColorStop(1, 'transparent');
        ctx.fillStyle = grad;
        ctx.fill();
      });

      this.ambientAnimId = requestAnimationFrame(render);
    };

    render();
  }

  // ── 5. Fluid Number Counter Interpolation ───────────────────────────────────
  animateValue(element, start, end, duration = 1200, prefix = '₹', suffix = '') {
    if (!element) return;
    const startTime = performance.now();

    // Pulse glow animation on the counter
    element.classList.add('liquid-number-glow');

    const update = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Smooth cubic ease out
      const ease = 1 - Math.pow(1 - progress, 4);

      const current = start + (end - start) * ease;
      element.innerHTML = `${prefix}${current.toLocaleString('en-IN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${suffix ? `<small>${suffix}</small>` : ''}`;

      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        setTimeout(() => element.classList.remove('liquid-number-glow'), 500);
      }
    };

    requestAnimationFrame(update);
  }
}

export const liquidEngine = new LiquidEffectsEngine();
window.liquidEngine = liquidEngine;
