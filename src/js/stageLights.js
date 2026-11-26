/**
 * @fileoverview VANTA Real-Time 60 FPS Beat & Stage Lighting Engine.
 * Drives 7 audio-reactive visual modes + Off from VANTA's live 24-band
 * Studio DSP / Native WASAPI FFT spectrum without layout reflows.
 */

export const STAGE_FX_MODES = [
  { id: 'off', label: 'Off', shortLabel: 'FX: Off', desc: 'Minimal clean studio UI' },
  { id: 'ambient', label: 'Ambient Halo', shortLabel: 'FX: Ambient', desc: 'Subtle reactive glass glow' },
  { id: 'pulse', label: 'Club Pulse', shortLabel: 'FX: Pulse', desc: 'Perimeter beat pulse & glow' },
  { id: 'concert', label: 'DMX Concert Rig', shortLabel: 'FX: Concert Rig', desc: 'Volumetric sweeping stage spots' },
  { id: 'lasers', label: 'Edge Lasers', shortLabel: 'FX: Edge Lasers', desc: 'BPM-synced plasma edge comets' },
  { id: 'shockwave', label: 'Shockwave Ripples', shortLabel: 'FX: Shockwave', desc: 'Acoustic bass shockwave rings' },
  { id: 'aurora', label: 'Liquid Aurora', shortLabel: 'FX: Aurora', desc: 'Bioluminescent aurora clouds' },
  { id: 'video', label: '🎬 Live Video FX', shortLabel: 'FX: Live Video', desc: 'Beat-synced video backdrop' },
  { id: 'hyper', label: '⚡ Hyper-Stage AI', shortLabel: 'FX: Hyper-Stage', desc: 'Auto Verse → Build-Up → Drop' }
];

export const STAGE_PALETTES = {
  cyber: { label: 'Cyber Neon', c1: '#2f6fed', c2: '#00e5ff', c3: '#ec4899', rgb1: '47,111,237', rgb2: '0,229,255', rgb3: '236,72,153' },
  warm: { label: 'Warm Club', c1: '#f97316', c2: '#fbbf24', c3: '#e11d48', rgb1: '249,115,22', rgb2: '251,191,36', rgb3: '225,29,72' },
  aurora: { label: 'Aurora Ice', c1: '#06b6d4', c2: '#10b981', c3: '#6366f1', rgb1: '6,182,212', rgb2: '16,185,129', rgb3: '99,102,241' },
  crimson: { label: 'Crimson Synth', c1: '#ef4444', c2: '#a855f7', c3: '#f43f5e', rgb1: '239,68,68', rgb2: '168,85,247', rgb3: '244,63,94' },
  track: { label: 'Track Key Sync', c1: '#7c5cff', c2: '#00e5ff', c3: '#ff4d8d', rgb1: '124,92,255', rgb2: '0,229,255', rgb3: '255,77,141' }
};

/**
 * Resolves dynamic RGB/Hex palette colors from musical key when Track Key Sync is selected.
 * @param {string} paletteId - Palette identifier.
 * @param {object|null} [track=null] - Currently loaded track metadata.
 * @returns {object} Resolved palette tokens.
 */
export function resolveStagePalette(paletteId, track = null) {
  if (paletteId !== 'track') {
    return STAGE_PALETTES[paletteId] || STAGE_PALETTES.cyber;
  }
  const key = String(track?.key || '').toLowerCase();
  if (key.includes('f min') || key.includes('c min') || key.includes('d#') || key.includes('g#')) {
    return STAGE_PALETTES.warm;
  }
  if (key.includes('g min') || key.includes('d min') || key.includes('c#')) {
    return STAGE_PALETTES.aurora;
  }
  if (key.includes('b min') || key.includes('f#')) {
    return STAGE_PALETTES.crimson;
  }
  return STAGE_PALETTES.cyber;
}

/**
 * Pure 3-band spectral envelope & kick-onset detector over 24-band FFT bars [0..1].
 * Safe to invoke from headless unit tests without DOM dependencies.
 * @param {ArrayLike<number>} bars - 24 normalized spectrum bars [0..1].
 * @param {object} [prev={}] - Prior envelope state.
 * @param {boolean} [isPlaying=true] - Whether audio is currently active.
 * @returns {object} Next envelope state { bass, mid, high, onset, avgBass, rollingEnergy, hyperStage, kickDetected }.
 */
export function computeStageSpectralMetrics(bars = [], prev = {}, isPlaying = true) {
  let bassSum = 0;
  let midSum = 0;
  let highSum = 0;
  const len = bars?.length || 0;

  if (len > 0 && isPlaying) {
    const bassEnd = Math.min(5, len);
    const midEnd = Math.min(14, len);
    for (let i = 0; i < bassEnd; i++) bassSum += Number(bars[i]) || 0;
    for (let i = bassEnd; i < midEnd; i++) midSum += Number(bars[i]) || 0;
    for (let i = midEnd; i < len; i++) highSum += Number(bars[i]) || 0;

    bassSum /= Math.max(1, bassEnd);
    midSum /= Math.max(1, midEnd - bassEnd);
    highSum /= Math.max(1, len - midEnd);
  }

  const prevBass = Number(prev.bass) || 0;
  const prevMid = Number(prev.mid) || 0;
  const prevHigh = Number(prev.high) || 0;
  const prevOnset = Number(prev.onset) || 0;
  const prevAvgBass = Number(prev.avgBass) || 0;
  const prevRawBass = Number(prev.rawBass) || 0;
  const prevRolling = Number(prev.rollingEnergy) || 0;
  const cooldown = Math.max(0, (Number(prev.onsetCooldown) || 0) - 1);

  // Fast attack, smooth exponential decay follower
  const bass = bassSum > prevBass ? prevBass + (bassSum - prevBass) * 0.68 : prevBass * 0.89;
  const mid = midSum > prevMid ? prevMid + (midSum - prevMid) * 0.55 : prevMid * 0.92;
  const high = highSum > prevHigh ? prevHigh + (highSum - prevHigh) * 0.62 : prevHigh * 0.88;

  const avgBass = prevAvgBass * 0.91 + bassSum * 0.09;
  const flux = bassSum - prevAvgBass;
  const stepJump = bassSum - prevRawBass;
  const kickDetected = Boolean(
    isPlaying &&
    cooldown === 0 &&
    bassSum > 0.14 &&
    (flux > 0.036 || (stepJump > 0.042 && bassSum > 0.22))
  );

  const onset = kickDetected ? 1.0 : prevOnset * 0.84;
  const onsetCooldown = kickDetected ? 7 : cooldown;

  const instantEnergy = bass * 0.5 + mid * 0.3 + high * 0.2;
  const rollingEnergy = prevRolling * 0.96 + instantEnergy * 0.04;
  const hyperStage =
    bass > 0.52 || (onset > 0.45 && rollingEnergy > 0.28)
      ? 'DROP'
      : high > 0.34 || instantEnergy > rollingEnergy * 1.15
        ? 'BUILD'
        : 'VERSE';

  return {
    bass: Math.min(1, Math.max(0, bass)),
    mid: Math.min(1, Math.max(0, mid)),
    high: Math.min(1, Math.max(0, high)),
    onset: Math.min(1, Math.max(0, onset)),
    avgBass,
    rawBass: bassSum,
    onsetCooldown,
    rollingEnergy,
    hyperStage,
    kickDetected
  };
}

export class StageLightEngine {
  /**
   * @param {HTMLCanvasElement|null} canvas - Full-window backdrop FX canvas.
   * @param {HTMLElement|null} edgeRingEl - Perimeter laser border overlay.
   * @param {HTMLVideoElement|null} [videoEl=null] - Offscreen muted loop video for Live Video FX.
   */
  constructor(canvas, edgeRingEl, videoEl = null) {
    this.canvas = canvas;
    this.edgeRingEl = edgeRingEl;
    this.videoEl = videoEl;
    this.videoPath = '';
    this.mode = this._loadPref('vanta_stage_fx_v1', 'off', STAGE_FX_MODES.map((m) => m.id));
    this.paletteId = this._loadPref('vanta_stage_palette_v1', 'cyber', Object.keys(STAGE_PALETTES));
    this.videoGlassAlpha = this._loadFloatPref('vanta_fx_glass_alpha_v1', 0.24, 0.06, 0.85);
    this.cinemaMode = false;
    this.state = {
      bass: 0,
      mid: 0,
      high: 0,
      onset: 0,
      avgBass: 0,
      rawBass: 0,
      onsetCooldown: 0,
      rollingEnergy: 0,
      hyperStage: 'VERSE',
      kickDetected: false
    };
    this.laserAngle = 0;
    this.shockwaves = [];
    this.phase = 0;
    this._lastWidth = 0;
    this._lastHeight = 0;
    this._applyDomClasses();
  }

  /**
   * Configures the local loop video file path used by the Live Video FX mode.
   * @param {string} filePath - Host path to video file (e.g. C:\Vanta\VantaVault\effect1.mp4).
   */
  setVideoSource(filePath) {
    const clean = String(filePath || '').trim();
    this.videoPath = clean;
    if (!this.videoEl) return;
    this.videoEl.muted = true;
    this.videoEl.loop = true;
    this.videoEl.playsInline = true;
    if (!clean) {
      this.videoEl.pause();
      this.videoEl.removeAttribute('src');
      return;
    }
    const nextUrl = `vanta-media://local?path=${encodeURIComponent(clean)}`;
    if (this.videoEl.src !== nextUrl) {
      this.videoEl.src = nextUrl;
    }
    if (this.mode === 'video') {
      this.videoEl.play().catch(() => {});
    }
  }

  _loadPref(key, fallback, allowed) {
    try {
      const val = globalThis.localStorage?.getItem(key);
      return allowed.includes(val) ? val : fallback;
    } catch {
      return fallback;
    }
  }

  _loadFloatPref(key, fallback, min, max) {
    try {
      const n = Number(globalThis.localStorage?.getItem(key));
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Adjusts center panel transparency (0.06..0.85) in Live Video FX mode and persists it.
   * @param {number} alpha - Opacity value between 0.06 and 0.85.
   */
  setVideoGlassAlpha(alpha) {
    const clamped = Math.min(0.85, Math.max(0.06, Number(alpha) || 0.24));
    this.videoGlassAlpha = clamped;
    try {
      globalThis.localStorage?.setItem('vanta_fx_glass_alpha_v1', String(clamped));
    } catch {
      // Ignore storage errors
    }
    this._applyDomClasses();
  }

  /**
   * Toggles Cinema Stage mode (hides center playlist panels to reveal full unobstructed stage FX).
   * @param {boolean} enabled - Target Cinema state.
   */
  setCinemaMode(enabled) {
    this.cinemaMode = Boolean(enabled);
    this._applyDomClasses();
  }

  /**
   * Switches the active stage FX mode and persists user preference.
   * @param {string} modeId - Target FX mode ID.
   */
  setMode(modeId) {
    if (!STAGE_FX_MODES.some((m) => m.id === modeId)) return;
    this.mode = modeId;
    try {
      globalThis.localStorage?.setItem('vanta_stage_fx_v1', modeId);
    } catch {
      // Ignore storage errors
    }
    if (modeId === 'off') {
      this.cinemaMode = false;
      this.shockwaves.length = 0;
      this._clearCanvasAndVars();
    }
    if (this.videoEl) {
      if (modeId === 'video' && this.videoPath) {
        this.videoEl.muted = true;
        this.videoEl.loop = true;
        this.videoEl.play().catch(() => {});
      } else if (!this.videoEl.paused) {
        this.videoEl.pause();
      }
    }
    this._applyDomClasses();
  }

  /**
   * Switches the color palette (or Track Key Sync) and persists preference.
   * @param {string} paletteId - Target palette ID.
   */
  setPalette(paletteId) {
    if (!STAGE_PALETTES[paletteId]) return;
    this.paletteId = paletteId;
    try {
      globalThis.localStorage?.setItem('vanta_stage_palette_v1', paletteId);
    } catch {
      // Ignore storage errors
    }
  }

  _applyDomClasses() {
    if (typeof document === 'undefined') return;
    const isActive = this.mode !== 'off';
    document.body.classList.toggle('fx-stage-active', isActive);
    document.body.classList.toggle('fx-pulse-mode', this.mode === 'pulse' || this.mode === 'hyper');
    document.body.classList.toggle('fx-shockwave-mode', this.mode === 'shockwave');
    document.body.classList.toggle('fx-video-mode', this.mode === 'video');
    document.body.classList.toggle('fx-cinema-mode', Boolean(this.cinemaMode && isActive));
    document.documentElement.style.setProperty('--fx-glass-alpha', this.videoGlassAlpha.toFixed(2));
    this.canvas?.classList.toggle('hidden', !isActive);

    const showLasers = this.mode === 'lasers' || this.mode === 'hyper';
    this.edgeRingEl?.classList.toggle('hidden', !showLasers);
  }

  _clearCanvasAndVars() {
    if (this.canvas) {
      const ctx = this.canvas.getContext('2d');
      ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (typeof document !== 'undefined') {
      const s = document.documentElement.style;
      s.setProperty('--beat-bass', '0');
      s.setProperty('--beat-mid', '0');
      s.setProperty('--beat-high', '0');
      s.setProperty('--beat-onset', '0');
      s.setProperty('--light-strength', '0');
      s.setProperty('--laser-opacity', '0');
    }
  }

  _syncCanvasSize() {
    if (!this.canvas) return { w: 0, h: 0 };
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (w !== this._lastWidth || h !== this._lastHeight) {
      this._lastWidth = w;
      this._lastHeight = h;
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  _spawnShockwave(w, h, intensity, palette) {
    const useDockOrigin = this.shockwaves.length % 2 === 1;
    const x = useDockOrigin ? Math.max(200, w - 165) : w * 0.5;
    const y = useDockOrigin ? 190 : Math.max(120, h - 46);
    this.shockwaves.push({
      x,
      y,
      r: 18,
      maxR: Math.max(w, h) * 0.88,
      alpha: Math.min(0.92, 0.55 + intensity * 0.38),
      speed: 7 + intensity * 6,
      rgb: this.shockwaves.length % 2 === 0 ? palette.rgb2 : palette.rgb3
    });
    if (this.shockwaves.length > 10) this.shockwaves.shift();
  }

  /**
   * Advances lighting physics and renders one 60 FPS frame from live 24-band spectrum bars.
   * @param {ArrayLike<number>} bars - 24 smoothed spectrum bars [0..1].
   * @param {boolean} isPlaying - Playback state.
   * @param {number} [bpm=126] - Active track BPM.
   * @param {object|null} [track=null] - Active track metadata.
   * @param {number} [now=performance.now()] - Frame timestamp in ms.
   */
  tick(bars, isPlaying, bpm = 126, track = null, now = performance.now()) {
    if (this.mode === 'off') return;

    this.state = computeStageSpectralMetrics(bars, this.state, isPlaying);
    const palette = resolveStagePalette(this.paletteId, track);
    const { bass, mid, high, onset, hyperStage, kickDetected } = this.state;

    const strength = this.mode === 'ambient' ? 0.55 : 1.0;
    const wantLasers =
      this.mode === 'lasers' ||
      (this.mode === 'hyper' && (hyperStage === 'BUILD' || hyperStage === 'DROP'));

    if (isPlaying && wantLasers) {
      const speed = this.mode === 'lasers' || hyperStage === 'DROP' ? 2.2 + bass * 3.8 : 1.3 + high * 1.8;
      this.laserAngle = (this.laserAngle + speed * (Math.max(70, Number(bpm) || 126) / 126)) % 360;
    }

    const { w, h } = this._syncCanvasSize();
    if (kickDetected && w > 0 && (this.mode === 'shockwave' || this.mode === 'video' || (this.mode === 'hyper' && hyperStage === 'DROP'))) {
      this._spawnShockwave(w, h, Math.max(0.7, bass), palette);
    }

    if (typeof document !== 'undefined') {
      const root = document.documentElement.style;
      root.setProperty('--beat-bass', bass.toFixed(3));
      root.setProperty('--beat-mid', mid.toFixed(3));
      root.setProperty('--beat-high', high.toFixed(3));
      root.setProperty('--beat-onset', onset.toFixed(3));
      root.setProperty('--light-c1', palette.c1);
      root.setProperty('--light-c2', palette.c2);
      root.setProperty('--light-c3', palette.c3);
      root.setProperty('--light-strength', String(strength));
      root.setProperty('--laser-angle', `${this.laserAngle.toFixed(1)}deg`);
      root.setProperty('--laser-opacity', wantLasers && isPlaying ? (0.35 + bass * 0.65).toFixed(2) : '0');
    }

    if (!this.canvas || w <= 0 || h <= 0) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const isIce = typeof document !== 'undefined' && document.body.classList.contains('theme-ice');
    const alphaScale = isIce ? (this.mode === 'shockwave' ? 0.72 : 0.6) : 1.0;

    // Live Beat-Synced Video FX Renderer (supports both portrait 9:16 ambilight wings and 16:9 widescreen)
    if (this.mode === 'video' && this.videoEl) {
      if (this.videoEl.paused && this.videoPath) {
        this.videoEl.play().catch(() => {});
      }
      if (this.videoEl.readyState >= 2 && this.videoEl.videoWidth > 0 && this.videoEl.videoHeight > 0) {
        const targetRate = isPlaying ? Math.min(1.42, Math.max(0.85, 0.92 + bass * 0.36 + high * 0.14)) : 0.65;
        if (Math.abs((this.videoEl.playbackRate || 1) - targetRate) > 0.04) {
          this.videoEl.playbackRate = targetRate;
        }
        const vw = this.videoEl.videoWidth;
        const vh = this.videoEl.videoHeight;
        const zoom = 1 + bass * 0.045 * (isPlaying ? 1 : 0.2);
        const bright = 0.92 + bass * 0.30 + onset * 0.14;
        const sat = 1.12 + mid * 0.45;

        // Compute center main-stage viewport bounds so crisp foreground stays centered in middle pane
        const useDesktopStage = w > 720 && h > 300;
        const stageLeft = useDesktopStage ? 246 : 0;
        const stageRight = useDesktopStage ? w - 334 : w;
        const stageTop = useDesktopStage ? 58 : 0;
        const stageBot = useDesktopStage ? h - 92 : h;
        const stageW = Math.max(120, stageRight - stageLeft);
        const stageH = Math.max(120, stageBot - stageTop);

        if (vw < vh) {
          // Layer 1: Soft ambilight cover fill across entire window (eliminates bars around 9:16 portrait video)
          const coverScale = Math.max(w / vw, h / vh) * (1.06 + bass * 0.04);
          const cw = vw * coverScale;
          const ch = vh * coverScale;
          ctx.save();
          ctx.filter = `blur(34px) saturate(${(sat * 1.25).toFixed(2)}) brightness(${(bright * 0.72).toFixed(2)})`;
          ctx.globalAlpha = isIce ? 0.56 : 0.78;
          ctx.drawImage(this.videoEl, (w - cw) / 2, (h - ch) / 2, cw, ch);
          ctx.restore();

          // Layer 2: Crisp portrait frame centered directly inside middle main-stage bounds with soft feathered sides
          const containScale = Math.min(stageW / vw, stageH / vh) * zoom;
          const dw = Math.max(1, Math.round(vw * containScale));
          const dh = Math.max(1, Math.round(vh * containScale));
          const dx = stageLeft + (stageW - dw) / 2;
          const dy = stageTop + (stageH - dh) / 2;

          if (!this._featherCanvas && typeof document !== 'undefined') {
            this._featherCanvas = document.createElement('canvas');
          }
          if (this._featherCanvas) {
            if (this._featherCanvas.width !== dw || this._featherCanvas.height !== dh) {
              this._featherCanvas.width = dw;
              this._featherCanvas.height = dh;
            }
            const fCtx = this._featherCanvas.getContext('2d');
            if (fCtx) {
              fCtx.clearRect(0, 0, dw, dh);
              fCtx.save();
              fCtx.filter = `saturate(${sat.toFixed(2)}) brightness(${bright.toFixed(2)})`;
              fCtx.drawImage(this.videoEl, 0, 0, dw, dh);
              fCtx.filter = 'none';
              fCtx.globalCompositeOperation = 'destination-in';
              const mask = fCtx.createLinearGradient(0, 0, dw, 0);
              mask.addColorStop(0, 'rgba(0,0,0,0)');
              mask.addColorStop(0.16, 'rgba(0,0,0,1)');
              mask.addColorStop(0.84, 'rgba(0,0,0,1)');
              mask.addColorStop(1, 'rgba(0,0,0,0)');
              fCtx.fillStyle = mask;
              fCtx.fillRect(0, 0, dw, dh);
              fCtx.restore();

              ctx.save();
              ctx.beginPath();
              ctx.rect(stageLeft, stageTop, stageW, stageH);
              ctx.clip();
              ctx.globalAlpha = this.cinemaMode ? 0.98 : (isIce ? 0.88 : 0.94);
              ctx.drawImage(this._featherCanvas, dx, dy, dw, dh);
              ctx.restore();
            }
          }
        } else {
          // Landscape video fills cleanly without blur pass
          const coverScale = Math.max(w / vw, h / vh) * zoom;
          const cw = vw * coverScale;
          const ch = vh * coverScale;
          ctx.save();
          ctx.filter = `saturate(${sat.toFixed(2)}) brightness(${bright.toFixed(2)})`;
          ctx.globalAlpha = this.cinemaMode ? 0.96 : (isIce ? 0.78 : 0.90);
          ctx.drawImage(this.videoEl, (w - cw) / 2, (h - ch) / 2, cw, ch);
          ctx.restore();
        }
      }
    }

    const wantAurora =
      this.mode === 'aurora' ||
      this.mode === 'ambient' ||
      this.mode === 'pulse' ||
      this.mode === 'hyper';
    const wantConcert =
      this.mode === 'concert' ||
      (this.mode === 'hyper' && hyperStage === 'DROP');
    const wantShockwaves =
      this.mode === 'shockwave' ||
      this.mode === 'video' ||
      this.mode === 'hyper';

    ctx.save();
    ctx.globalCompositeOperation = isIce ? 'source-over' : 'screen';

    if (wantAurora) {
      const boost = this.mode === 'aurora' ? 1.15 : this.mode === 'ambient' ? 0.45 : 0.85;
      const idleFloor = isPlaying ? 0.08 : 0.03;
      const blobs = [
        {
          x: w * (0.26 + Math.sin(now * 0.0005) * 0.14),
          y: h * (0.32 + Math.cos(now * 0.0004) * 0.12),
          r: Math.min(w, h) * (0.42 + bass * 0.16),
          rgb: palette.rgb1,
          a: (idleFloor + bass * 0.22) * boost * alphaScale
        },
        {
          x: w * (0.68 + Math.cos(now * 0.00045) * 0.16),
          y: h * (0.46 + Math.sin(now * 0.00058) * 0.15),
          r: Math.min(w, h) * (0.40 + mid * 0.14),
          rgb: palette.rgb3,
          a: (idleFloor + mid * 0.20) * boost * alphaScale
        },
        {
          x: w * (0.50 + Math.sin(now * 0.0007) * 0.18),
          y: h * (0.76 + Math.cos(now * 0.00052) * 0.08),
          r: Math.min(w, h) * (0.36 + high * 0.14),
          rgb: palette.rgb2,
          a: (idleFloor + high * 0.20) * boost * alphaScale
        }
      ];

      for (const b of blobs) {
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        g.addColorStop(0, `rgba(${b.rgb}, ${b.a.toFixed(3)})`);
        g.addColorStop(1, `rgba(${b.rgb}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (wantConcert && isPlaying) {
      const beamCount = 5;
      const safeBpm = Math.max(70, Number(bpm) || 126);
      for (let i = 0; i < beamCount; i++) {
        const topX = w * ((i + 0.5) / beamCount);
        const sway = Math.sin(now * 0.0017 * (safeBpm / 120) + i * 1.35) * (95 + mid * 65);
        const botX = topX + sway;
        const coneHalf = 62 + bass * 82;
        const rgb = i % 3 === 0 ? palette.rgb1 : i % 3 === 1 ? palette.rgb2 : palette.rgb3;
        const beamAlpha = (0.09 + bass * 0.24 + onset * 0.12) * alphaScale;

        const grad = ctx.createLinearGradient(topX, 58, botX, h);
        grad.addColorStop(0, `rgba(${rgb}, ${(beamAlpha * 1.25).toFixed(3)})`);
        grad.addColorStop(0.65, `rgba(${rgb}, ${(beamAlpha * 0.45).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(topX - 8, 58);
        ctx.lineTo(topX + 8, 58);
        ctx.lineTo(botX + coneHalf, h);
        ctx.lineTo(botX - coneHalf, h);
        ctx.closePath();
        ctx.fill();

        const spotG = ctx.createRadialGradient(botX, h - 38, 0, botX, h - 38, coneHalf * 0.9);
        spotG.addColorStop(0, `rgba(${rgb}, ${(beamAlpha * 0.9).toFixed(3)})`);
        spotG.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = spotG;
        ctx.beginPath();
        ctx.ellipse(botX, h - 38, coneHalf * 0.9, 26, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (wantShockwaves && this.shockwaves.length > 0) {
      for (let i = this.shockwaves.length - 1; i >= 0; i--) {
        const sw = this.shockwaves[i];
        sw.r += sw.speed;
        const progress = sw.r / sw.maxR;
        const alpha = sw.alpha * (1 - progress) * alphaScale;
        if (progress >= 1 || alpha <= 0.01) {
          this.shockwaves.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = `rgba(${sw.rgb}, ${alpha.toFixed(3)})`;
        ctx.lineWidth = 3.6 * (1 - progress * 0.55);
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.52).toFixed(3)})`;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, Math.max(4, sw.r - 4), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    ctx.restore();
  }
}
