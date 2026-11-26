/**
 * @fileoverview VANTA 60 FPS Multi-Mode Pro Studio Audio Visualizer.
 * Supports 3 studio-grade reactive visualizations fed by both
 * Native WASAPI 1024-pt FFT and Web Audio Studio DSP AnalyserNodes:
 * - 'prism' : VANTA Aurora Prism (3D Perspective Frequency Topography)
 * - 'rta'   : RTA Spectrum + Peak Hold (logarithmic Hz grid + gravity-decay peak caps)
 * - 'vu'    : Stereo L/R VU & True Peak Meter (segmented bar + live dBFS readout)
 */

export const VISUALIZER_MODES = ['prism', 'rta', 'vu'];

export class VantaVisualizer {
  /**
   * @param {HTMLCanvasElement} canvas - Target canvas element.
   * @param {import('./audioEngine.js').VantaAudioEngine} audioEngine - Audio engine instance.
   */
  constructor(canvas, audioEngine) {
    this.canvas = canvas;
    this.audioEngine = audioEngine;
    this.mode = this._loadSavedMode();
    this.phase = 0;
    this.progressRatio = 0.0;
    this.isPlaying = false;
    this.rafId = null;

    // Temporal smoothing & peak-hold state for 60 FPS fluid motion
    this.smoothedBars = new Float32Array(24).fill(0.06);
    this.peakCaps = new Float32Array(24).fill(0.08);
    this.peakHoldTimers = new Float32Array(24).fill(0);
    this.smoothedVuL = 0;
    this.smoothedVuR = 0;
    this.peakHoldL = 0;
    this.peakHoldR = 0;
    this.peakTimerL = 0;
    this.peakTimerR = 0;

    // 7-slice x 24-band Z-depth buffer for VANTA Aurora Prism (3D Perspective Topography)
    this.prismCols = 24;
    this.prismDepth = 7;
    this.prismLayers = Array.from({ length: this.prismDepth }, () => new Float32Array(this.prismCols));
    this.prismTick = 0;
    this._prismX = new Float32Array(this.prismCols);
    this._prismY = new Float32Array(this.prismCols);
  }

  _loadSavedMode() {
    try {
      const saved = globalThis.localStorage?.getItem('vanta_viz_mode_v1');
      return VISUALIZER_MODES.includes(saved) ? saved : 'prism';
    } catch {
      return 'prism';
    }
  }

  /**
   * Switches the active visualization mode and persists preference.
   * @param {'prism'|'rta'|'vu'} mode - Target mode.
   */
  setMode(mode) {
    if (!VISUALIZER_MODES.includes(mode)) return;
    this.mode = mode;
    try {
      globalThis.localStorage?.setItem('vanta_viz_mode_v1', mode);
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Updates playback progress ratio [0..1] for dual-tone played/unplayed coloring.
   * @param {number} ratio - Normalized progress.
   */
  setProgress(ratio) {
    this.progressRatio = Math.max(0.0, Math.min(1.0, Number(ratio) || 0));
  }

  /**
   * Starts the 60 FPS requestAnimationFrame render loop.
   */
  start() {
    if (this.rafId) return;
    const loop = () => {
      this.drawFrame();
      if (typeof this.onFrame === 'function') {
        const raw = this.audioEngine ? this.audioEngine.getSpectrumBars(24) : [];
        const hasReal = this.isPlaying && raw.some((v) => v > 0.02);
        this.onFrame(hasReal ? raw : this.smoothedBars);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  _readSmoothedBars(barCount = 24) {
    const raw = this.audioEngine ? this.audioEngine.getSpectrumBars(barCount) : [];
    const hasLive = this.isPlaying && raw.some((v) => v > 0.07);
    if (this.isPlaying) {
      this.phase += 0.082 * (this.audioEngine?.state?.playbackRate || 1.0);
    }

    for (let i = 0; i < barCount; i++) {
      const target = hasLive
        ? raw[i]
        : this.isPlaying
          ? Math.max(
              0.08,
              Math.min(
                0.85,
                Math.sin(i * 0.45 + this.phase) * 0.25 +
                  Math.cos(i * 0.27 - this.phase * 0.7) * 0.18 +
                  0.38
              )
            )
          : 0.06;

      // Fast attack, smooth exponential release
      const alpha = target > this.smoothedBars[i] ? 0.52 : 0.22;
      this.smoothedBars[i] += (target - this.smoothedBars[i]) * alpha;

      if (this.smoothedBars[i] >= this.peakCaps[i]) {
        this.peakCaps[i] = this.smoothedBars[i];
        this.peakHoldTimers[i] = 18;
      } else if (this.peakHoldTimers[i] > 0) {
        this.peakHoldTimers[i] -= 1;
      } else {
        this.peakCaps[i] = Math.max(0.06, this.peakCaps[i] - 0.012);
      }
    }
    return this.smoothedBars;
  }

  /**
   * Draws the active visualization mode onto the studio canvas.
   */
  drawFrame() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const styles = getComputedStyle(document.body);
    const palette = {
      a1: styles.getPropertyValue('--a1').trim() || '#2f6fed',
      a2: styles.getPropertyValue('--a2').trim() || '#06b6d4',
      a3: styles.getPropertyValue('--a3').trim() || '#ec4899',
      emerald: styles.getPropertyValue('--emerald').trim() || '#4ade80',
      amber: styles.getPropertyValue('--amber').trim() || '#fbbf24',
      rose: styles.getPropertyValue('--rose').trim() || '#f43f5e',
      text: styles.getPropertyValue('--text').trim() || '#0f172a',
      muted: styles.getPropertyValue('--muted').trim() || '#64748b'
    };

    switch (this.mode) {
      case 'rta':
        this._drawRtaPeakHold(ctx, w, h, palette);
        break;
      case 'vu':
        this._drawStereoVuMeter(ctx, w, h, palette);
        break;
      case 'prism':
      default:
        this._drawAuroraPrism(ctx, w, h, palette);
        break;
    }
  }

  /**
   * Converts a CSS hex or rgb(...) color string into rgba(..., alpha) for depth layering.
   * @param {string} color
   * @param {number} alpha
   * @returns {string}
   */
  _withAlpha(color, alpha) {
    if (!color || typeof color !== 'string') return `rgba(56, 189, 248, ${alpha})`;
    const c = color.trim();
    if (c.startsWith('#')) {
      const hex = c.slice(1);
      if (hex.length === 3) {
        const r = parseInt(hex[0] + hex[0], 16);
        const g = parseInt(hex[1] + hex[1], 16);
        const b = parseInt(hex[2] + hex[2], 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
      if (hex.length >= 6) {
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
    }
    const match = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (match) return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
    return c;
  }

  /**
   * VANTA Aurora Prism: 3D perspective frequency topography rendered back-to-front
   * with converging perspective rails, stacked translucent prism curtains, and spline ridges.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} w
   * @param {number} h
   * @param {{ a1: string, a2: string, a3: string }} pal
   */
  _drawAuroraPrism(ctx, w, h, pal) {
    const cols = this.prismCols;
    const depth = this.prismDepth;
    const bars = this._readSmoothedBars(cols);

    // Advance history slices deeper into Z-space every 2 frames for silky flow
    this.prismTick = (this.prismTick + 1) % 2;
    if (this.prismTick === 0) {
      for (let d = depth - 1; d > 0; d--) {
        this.prismLayers[d].set(this.prismLayers[d - 1]);
      }
    }
    this.prismLayers[0].set(bars);

    const frontW = Math.max(40, w - 16);
    const frontLeft = (w - frontW) * 0.5;
    const frontRight = frontLeft + frontW;
    const frontY = h - 7;
    const backPersp = 0.56;
    const backW = frontW * backPersp;
    const backLeft = (w - backW) * 0.5;
    const backRight = backLeft + backW;
    const backY = Math.round(h * 0.3);

    // 1. Subtle 3D perspective coordinate grid floor receding toward horizon
    ctx.save();
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = this._withAlpha(pal.a1, 0.14);
    for (let r = 0; r <= 4; r++) {
      const u = r / 4;
      ctx.beginPath();
      ctx.moveTo(frontLeft + u * frontW, frontY);
      ctx.lineTo(backLeft + u * backW, backY);
      ctx.stroke();
    }

    // Horizon baseline accent
    const horizonGrad = ctx.createLinearGradient(backLeft - 6, 0, backRight + 6, 0);
    horizonGrad.addColorStop(0, this._withAlpha(pal.a2, 0));
    horizonGrad.addColorStop(0.5, this._withAlpha(pal.a1, 0.28));
    horizonGrad.addColorStop(1, this._withAlpha(pal.a3, 0));
    ctx.strokeStyle = horizonGrad;
    ctx.beginPath();
    ctx.moveTo(backLeft - 6, backY);
    ctx.lineTo(backRight + 6, backY);
    ctx.stroke();

    const xs = this._prismX;
    const ys = this._prismY;

    // 2. Painter's algorithm back-to-front rendering of stacked prism topography sheets
    for (let d = depth - 1; d >= 0; d--) {
      const t = d / (depth - 1); // 1 = farthest horizon, 0 = closest foreground
      const persp = 1 - t * (1 - backPersp);
      const sliceW = frontW * persp;
      const leftX = (w - sliceW) * 0.5;
      const rightX = leftX + sliceW;
      const baseY = frontY - t * (frontY - backY);
      const maxPeak = h * 0.46 * (0.44 + 0.56 * persp);
      const layer = this.prismLayers[d];

      // Blend a subtle calm geometric prism silhouette only near silence (layerMax <= 0.11)
      let layerMax = 0;
      for (let c = 0; c < cols; c++) {
        if (layer[c] > layerMax) layerMax = layer[c];
      }
      const idleWeight = Math.max(0, Math.min(1, (0.11 - layerMax) / 0.05));

      let minY = baseY;
      for (let c = 0; c < cols; c++) {
        const u = c / (cols - 1);
        const prev = layer[Math.max(0, c - 1)];
        const curr = layer[c];
        const next = layer[Math.min(cols - 1, c + 1)];
        const rawAmp = 0.22 * prev + 0.56 * curr + 0.22 * next;
        const idleRelief = idleWeight > 0
          ? idleWeight * 0.14 * Math.sin(u * Math.PI) * (0.62 + 0.38 * Math.sin(u * Math.PI * 3.0 + d * 0.8))
          : 0;
        const amp = Math.max(0.03, Math.min(1, rawAmp + idleRelief));
        const px = leftX + u * sliceW;
        const py = Math.max(4, baseY - amp * maxPeak);
        xs[c] = px;
        ys[c] = py;
        if (py < minY) minY = py;
      }

      const traceCrest = () => {
        ctx.moveTo(xs[0], ys[0]);
        for (let c = 0; c < cols - 1; c++) {
          const xc = (xs[c] + xs[c + 1]) * 0.5;
          const yc = (ys[c] + ys[c + 1]) * 0.5;
          ctx.quadraticCurveTo(xs[c], ys[c], xc, yc);
        }
        ctx.lineTo(xs[cols - 1], ys[cols - 1]);
      };

      // Translucent aurora prism curtain beneath the crest
      ctx.beginPath();
      traceCrest();
      ctx.lineTo(rightX, baseY);
      ctx.lineTo(leftX, baseY);
      ctx.closePath();

      const fillTopAlpha = 0.08 + (1 - t) * 0.24;
      const fillMidAlpha = 0.03 + (1 - t) * 0.11;
      const curtainGrad = ctx.createLinearGradient(0, minY - 2, 0, baseY + 1);
      curtainGrad.addColorStop(0, this._withAlpha(pal.a2, fillTopAlpha));
      curtainGrad.addColorStop(0.55, this._withAlpha(pal.a1, fillMidAlpha));
      curtainGrad.addColorStop(1, this._withAlpha(pal.a3, 0.015));
      ctx.fillStyle = curtainGrad;
      ctx.fill();

      // Subtle foreground crest aura before sharp prism edge
      const strokeAlpha = 0.24 + (1 - t) * 0.72;
      const ridgeGrad = ctx.createLinearGradient(leftX, 0, rightX, 0);
      ridgeGrad.addColorStop(0, this._withAlpha(pal.a2, strokeAlpha));
      ridgeGrad.addColorStop(0.5, this._withAlpha(pal.a1, strokeAlpha));
      ridgeGrad.addColorStop(1, this._withAlpha(pal.a3, strokeAlpha));

      if (d === 0) {
        ctx.beginPath();
        traceCrest();
        ctx.strokeStyle = this._withAlpha(pal.a1, 0.22);
        ctx.lineWidth = 3.4;
        ctx.stroke();
      }

      ctx.beginPath();
      traceCrest();
      ctx.strokeStyle = ridgeGrad;
      ctx.lineWidth = d === 0 ? 1.8 : 0.85 + (1 - t) * 0.55;
      ctx.stroke();
    }

    // 3. Sleek foreground playback progress rail
    const railY = h - 3.5;
    ctx.fillStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.fillRect(frontLeft, railY, frontW, 1.5);
    const progW = Math.max(0, Math.min(frontW, this.progressRatio * frontW));
    if (progW > 0.5) {
      const railGrad = ctx.createLinearGradient(frontLeft, 0, frontRight, 0);
      railGrad.addColorStop(0, pal.a2);
      railGrad.addColorStop(0.55, pal.a1);
      railGrad.addColorStop(1, pal.a3);
      ctx.fillStyle = railGrad;
      ctx.fillRect(frontLeft, railY, progW, 1.5);
      ctx.beginPath();
      ctx.arc(frontLeft + progW, railY + 0.75, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = pal.a3;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawRtaPeakHold(ctx, w, h, pal) {
    const barCount = 24;
    const gap = 3;
    const topPad = 8;
    const botPad = 12;
    const usableH = h - topPad - botPad;
    const barWidth = (w - gap * (barCount + 1)) / barCount;
    const bars = this._readSmoothedBars(barCount);

    // Subtle dB reference grid lines
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.lineWidth = 1;
    [0.25, 0.55, 0.85].forEach((f) => {
      const gy = Math.round(topPad + usableH * (1 - f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(4, gy);
      ctx.lineTo(w - 4, gy);
      ctx.stroke();
    });

    for (let i = 0; i < barCount; i++) {
      const x = gap + i * (barWidth + gap);
      const bh = Math.max(3, Math.min(usableH, bars[i] * usableH));
      const y = topPad + usableH - bh;

      const grad = ctx.createLinearGradient(0, topPad, 0, topPad + usableH);
      grad.addColorStop(0, pal.a3);
      grad.addColorStop(0.35, pal.a2);
      grad.addColorStop(1, pal.a1);
      ctx.fillStyle = grad;

      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, barWidth, bh, [2, 2, 1, 1]);
      } else {
        ctx.rect(x, y, barWidth, bh);
      }
      ctx.fill();

      // Gravity-decaying Peak Hold cap
      const capY = topPad + usableH - Math.max(3, Math.min(usableH, this.peakCaps[i] * usableH));
      ctx.fillStyle = pal.a3;
      ctx.fillRect(x, capY - 2.5, barWidth, 2);
    }

    // Frequency band axis labels
    ctx.fillStyle = pal.muted;
    ctx.font = '600 8.5px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('40Hz', 4, h - 2);
    ctx.textAlign = 'center';
    ctx.fillText('1kHz', w / 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText('18kHz', w - 4, h - 2);
  }

  _drawStereoVuMeter(ctx, w, h, pal) {
    const levels = this.audioEngine ? this.audioEngine.getStereoLevels() : { lPeak: 0, rPeak: 0, lRms: 0, rRms: 0 };
    const activeL = this.isPlaying ? Math.min(1, Math.max(levels.lRms * 1.9, levels.lPeak * 0.85)) : 0;
    const activeR = this.isPlaying ? Math.min(1, Math.max(levels.rRms * 1.9, levels.rPeak * 0.85)) : 0;

    this.smoothedVuL += (activeL - this.smoothedVuL) * (activeL > this.smoothedVuL ? 0.55 : 0.2);
    this.smoothedVuR += (activeR - this.smoothedVuR) * (activeR > this.smoothedVuR ? 0.55 : 0.2);

    if (this.smoothedVuL >= this.peakHoldL) {
      this.peakHoldL = this.smoothedVuL;
      this.peakTimerL = 24;
    } else if (this.peakTimerL > 0) {
      this.peakTimerL -= 1;
    } else {
      this.peakHoldL = Math.max(0, this.peakHoldL - 0.015);
    }

    if (this.smoothedVuR >= this.peakHoldR) {
      this.peakHoldR = this.smoothedVuR;
      this.peakTimerR = 24;
    } else if (this.peakTimerR > 0) {
      this.peakTimerR -= 1;
    } else {
      this.peakHoldR = Math.max(0, this.peakHoldR - 0.015);
    }

    const toDbText = (lin) => {
      if (lin <= 0.002) return '-∞ dB';
      const db = Math.max(-60, 20 * Math.log10(lin));
      return `${db.toFixed(1)} dB`;
    };

    const drawChannel = (label, yTop, val, peakHold, rawPeak) => {
      const labelW = 16;
      const dbW = 46;
      const barX = labelW + 4;
      const barW = w - barX - dbW - 6;
      const barH = 14;

      ctx.fillStyle = pal.text;
      ctx.font = '800 10px Inter, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 2, yTop + barH / 2);

      // Recessed track
      ctx.fillStyle = 'rgba(148, 163, 184, 0.2)';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(barX, yTop, barW, barH, 4);
      else ctx.rect(barX, yTop, barW, barH);
      ctx.fill();

      // Segmented / gradient fill
      const fillW = Math.max(0, Math.min(barW, val * barW));
      if (fillW > 1) {
        const grad = ctx.createLinearGradient(barX, 0, barX + barW, 0);
        grad.addColorStop(0, pal.a1);
        grad.addColorStop(0.55, pal.emerald);
        grad.addColorStop(0.84, pal.amber);
        grad.addColorStop(1.0, pal.rose);
        ctx.fillStyle = grad;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(barX, yTop, fillW, barH, 4);
        else ctx.rect(barX, yTop, fillW, barH);
        ctx.fill();
      }

      // Peak hold tick
      if (peakHold > 0.02) {
        const px = barX + Math.min(barW - 2, peakHold * barW);
        ctx.fillStyle = peakHold > 0.88 ? pal.rose : pal.text;
        ctx.fillRect(px, yTop - 1, 2.2, barH + 2);
      }

      ctx.fillStyle = pal.muted;
      ctx.font = '700 9.5px Consolas, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(toDbText(rawPeak), w - 2, yTop + barH / 2);
    };

    const cy = Math.floor(h / 2);
    drawChannel('L', cy - 22, this.smoothedVuL, this.peakHoldL, levels.lPeak);
    drawChannel('R', cy + 6, this.smoothedVuR, this.peakHoldR, levels.rPeak);

    // Subtle dB scale at bottom
    ctx.fillStyle = pal.muted;
    ctx.font = '600 8px Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('-48dB        -24dB        -12dB     -3dB   0dB', 20, h - 2);
  }
}
