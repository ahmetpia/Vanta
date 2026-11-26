/**
 * @fileoverview VANTA Studio Web Audio DSP Graph & Dual-Deck Gapless/Crossfade Engine (Pillar C).
 * Supports:
 * - Bit-Perfect transparent reference bypass (zero artificial mud, zero clipping)
 * - Dual-Deck (Deck A + Deck B) Gapless (0s) and Equal-Power Crossfade (3s / 6s / 10s)
 * - True EBU R128 linear ReplayGain (-14.0 LUFS target without dynamic compression squashing)
 * - 8-Band Parametric EQ, Warm Low-Pass Convolver Reverb, Mid-Side Karaoke, Vinyl Soul
 * - External Native WASAPI Exclusive spectrum bridge & WebAudio AudioSink routing
 */

export const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const DEVICE_EQ_PROFILES = {
  'Bit-Perfect (Flat)': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Harman Target (In-Ear)': [3.0, 2.5, 1.0, -0.5, 0.0, 0.5, 1.5, 2.5, 1.5, 0.5],
  'TWS / AirPods Clarity': [2.5, 1.8, 0.4, -0.8, 0.5, 1.4, 2.2, 2.4, 1.8, 1.5],
  'Headphones Profile': [2.0, 1.5, 0.5, -0.5, 0.0, 1.0, 1.5, 1.8, 1.2, 2.0],
  'Studio Monitors': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Cinema Spatial': [3.5, 2.5, 1.0, -0.5, 0.5, 1.2, 2.0, 2.5, 2.0, 1.5],
  'Late-Night Car': [3.5, 2.5, 0.8, -1.0, 0.4, 1.2, 1.6, 2.0, 2.0, 2.5],
  'Concert Hall': [1.8, 1.6, 0.6, 0.0, 0.6, 1.2, 2.0, 1.8, 2.2, 2.5]
};

export const EQ_PRESETS = {
  'Flat Reference': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Vanta Mastering': [2.5, 2.0, 1.5, 0.5, -0.5, 0.5, 1.5, 2.2, 2.0, 2.5],
  'Bass & Punch': [5.0, 4.2, 2.5, 0.8, 0.0, 0.0, 0.8, 1.2, 1.5, 1.8],
  'Vocal Clarity': [-2.0, -1.2, -0.5, 0.5, 1.5, 2.5, 3.5, 3.0, 2.0, 1.5],
  'Spatial Cinema': [3.0, 2.2, 0.8, -0.8, 0.0, 0.8, 1.8, 2.8, 2.5, 2.0],
  'Night Listening': [2.5, 1.8, 0.5, 0.0, 0.5, 1.0, 1.2, 0.5, -0.5, -1.0]
};

/**
 * Computes energy-balanced Mid-Side gains & micro Haas offset for Binaural 3D Spatializer.
 * @param {number} [widthPct=135] - Stereo width percentage in [0, 150] (100 = unity stereo).
 * @returns {{ midGain: number, sideGain: number, haasDelaySec: number, earlyWet: number }}
 */
export function computeMidSideSpatialGains(widthPct = 135) {
  const clamped = Math.max(0, Math.min(150, Number(widthPct) || 0));
  const ratio = clamped / 100;
  // Boost side proportionally while gently compensating mid to avoid loudness jumps
  const sideGain = Number((0.85 + ratio * 0.65).toFixed(4));
  const midGain = Number(Math.max(0.78, Math.min(1.15, 1.08 - (ratio - 1) * 0.28)).toFixed(4));
  const haasDelaySec = clamped > 100 ? 0.00065 : 0.0;
  const earlyWet = clamped > 100 ? Number(Math.min(0.14, (ratio - 0.8) * 0.14).toFixed(4)) : 0.0;
  return { midGain, sideGain, haasDelaySec, earlyWet };
}

/**
 * Computes Bauer/Meier headphone crossfeed network coefficients.
 * @param {number} [levelPct=55] - Crossfeed mix percentage in [0, 100].
 * @returns {{ directGain: number, crossGain: number, cutoffHz: number, delaySec: number }}
 */
export function computeBauerCrossfeedParams(levelPct = 55) {
  const t = Math.max(0, Math.min(100, Number(levelPct) || 0)) / 100;
  const crossGain = Number((0.12 + t * 0.34).toFixed(4));
  const directGain = Number(Math.sqrt(Math.max(0.25, 1 - crossGain * crossGain)).toFixed(4));
  return {
    directGain,
    crossGain,
    cutoffHz: 700,
    delaySec: 0.00026
  };
}

/**
 * Computes clean Sub-Bass Shelf & Punch gains with gentle headroom protection.
 * @param {number} [boostDb=5.5] - Target sub-bass boost in dB [0, 9].
 * @returns {{ subShelfDb: number, punchDb: number, headroomLinear: number }}
 */
export function computeSubBassCurveParams(boostDb = 5.5) {
  const subShelfDb = Math.max(0, Math.min(9, Number(boostDb) || 0));
  const punchDb = Number((subShelfDb * 0.45).toFixed(2));
  const headroomDb = -Math.min(3.5, subShelfDb * 0.25);
  return {
    subShelfDb,
    punchDb,
    headroomLinear: Number(Math.pow(10, headroomDb / 20).toFixed(4))
  };
}

/**
 * Generates a soft-clipping harmonic tube saturation curve for a WaveShaperNode.
 * @param {number} [drive=25] - Saturation drive intensity (0 to 100).
 * @param {number} [samples=2048] - Curve lookup table resolution.
 * @returns {Float32Array} Transfer curve array in [-1, 1].
 */
export function buildTubeSaturationCurve(drive = 25, samples = 2048) {
  const curve = new Float32Array(samples);
  const k = Math.max(0, Number(drive) || 0);
  if (k === 0) {
    for (let i = 0; i < samples; i++) {
      curve[i] = (i * 2) / samples - 1;
    }
    return curve;
  }
  const deg = Math.PI / 180;
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / samples - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/**
 * Computes equal-power crossfade gains for Deck A (outgoing) and Deck B (incoming).
 * @param {number} progress - Normalized transition progress in [0, 1].
 * @returns {{ gainA: number, gainB: number }} Equal-power gain multipliers.
 */
export function computeEqualPowerCrossfade(progress) {
  const t = Math.max(0, Math.min(1, Number(progress) || 0));
  return {
    gainA: Math.cos(t * 0.5 * Math.PI),
    gainB: Math.sin(t * 0.5 * Math.PI)
  };
}

/**
 * VantaAudioEngine manages the Dual-Deck Web Audio API graph and external WASAPI spectrum bridge.
 */
export class VantaAudioEngine {
  constructor() {
    this.ctx = null;
    this.deckAEl = null;
    this.deckBEl = null;
    this.videoEl = null;
    this.activeDeck = 'A';

    this.deckAGain = null;
    this.deckBGain = null;
    this.replayGainNode = null;
    this.preGain = null;
    this.eqNodes = [];
    this.subBassLowShelf = null;
    this.subBassPunch = null;
    this.dryVocalGain = null;
    this.karaokeCancelGain = null;
    this.exciterDryGain = null;
    this.exciterWetGain = null;
    this.pitchPassGain = null;
    this.pitchNode = null;
    this.xfDirectGain = null;
    this.xfCrossGainL = null;
    this.xfCrossGainR = null;
    this.spatialDryGain = null;
    this.spatialWetGain = null;
    this.spatialMidGain = null;
    this.spatialSideGain = null;
    this.spatialHaasDelay = null;
    this.spatialEarlyGain = null;
    this.spatialConvolver = null;
    this.saturationNode = null;
    this.convolverNode = null;
    this.reverbPreDelay = null;
    this.reverbWetGain = null;
    this.reverbDryGain = null;
    this.compressorNode = null;
    this.compDryGain = null;
    this.compWetGain = null;
    this.masterGain = null;
    this.analyserNode = null;
    this.leftAnalyser = null;
    this.rightAnalyser = null;

    this.crackleTimer = null;
    this.crossfadeRaf = null;
    this.externalBars = null;
    this.externalTelemetry = null;
    this.externalTimestamp = 0;
    this.onElementsRecreated = null;
    this.preferredSinkId = '';
    this.preferredSinkName = '';

    this.state = {
      gains: [...EQ_PRESETS['Flat Reference']],
      deviceProfile: 'Bit-Perfect (Flat)',
      spatial: false,
      spatialWidthPct: 135,
      crossfeed: false,
      crossfeedLevelPct: 55,
      exciter: false,
      exciterMixPct: 45,
      limiter: true,
      nightMode: false,
      eqEnabled: false,
      karaoke: false,
      vinyl: false,
      lufs: true, // EBU R128 linear ReplayGain (non-destructive)
      reverb: false,
      reverbMixPct: 22,
      saturation: false,
      bassBoost: false,
      bassBoostDb: 5.5,
      pitchSemitones: 0,
      playbackRate: 1.0,
      crossfadeSeconds: 0.0, // Default Gapless (0s), switchable to 3s/6s/10s
      replayGainLinear: 1.0,
      volume: 1.0
    };
  }

  /**
   * Stores media element references without prematurely opening a WebAudio hardware stream
   * while Native WASAPI Exclusive mode is active.
   * @param {HTMLAudioElement} deckAElement - Primary Deck A audio element.
   * @param {HTMLVideoElement} videoElement - Primary HD video element.
   * @param {HTMLAudioElement} [deckBElement=null] - Secondary Deck B audio element.
   */
  bindElements(deckAElement, videoElement, deckBElement = null) {
    this.deckAEl = deckAElement;
    this.videoEl = videoElement;
    this.deckBEl = deckBElement;
  }

  /**
   * Completely closes the Chromium AudioContext and replaces media elements with clean clones
   * so Windows WASAPI Exclusive releases cleanly and subsequent Studio DSP starts fresh.
   * @returns {Promise<void>}
   */
  async teardownEngine() {
    if (this.crossfadeRaf) {
      cancelAnimationFrame(this.crossfadeRaf);
      this.crossfadeRaf = null;
    }
    this._toggleVinylCrackle(false);

    if (this.ctx) {
      const hadConnectedNodes = Boolean(this.ctx);
      try {
        await this.ctx.close();
      } catch {
        // Ignore close errors
      }
      this.ctx = null;
      this.analyserNode = null;
      this.leftAnalyser = null;
      this.rightAnalyser = null;
      this.eqNodes = [];
      this.subBassLowShelf = null;
      this.subBassPunch = null;
      this.deckAGain = null;
      this.deckBGain = null;
      this.replayGainNode = null;
      this.preGain = null;
      this.dryVocalGain = null;
      this.karaokeCancelGain = null;
      this.exciterDryGain = null;
      this.exciterWetGain = null;
      this.pitchPassGain = null;
      this.pitchNode = null;
      this.xfDirectGain = null;
      this.xfCrossGainL = null;
      this.xfCrossGainR = null;
      this.spatialDryGain = null;
      this.spatialWetGain = null;
      this.spatialMidGain = null;
      this.spatialSideGain = null;
      this.spatialHaasDelay = null;
      this.spatialEarlyGain = null;
      this.spatialConvolver = null;
      this.saturationNode = null;
      this.convolverNode = null;
      this.reverbPreDelay = null;
      this.reverbWetGain = null;
      this.reverbDryGain = null;
      this.compressorNode = null;
      this.compDryGain = null;
      this.compWetGain = null;
      this.masterGain = null;

      const needsClone = hadConnectedNodes || Boolean(this.deckAEl?.error) || Boolean(this.deckBEl?.error);
      if (needsClone) {
        const cloneClean = (el) => {
          if (!el || !el.parentNode) return el;
          el.pause();
          const clone = el.cloneNode(false);
          clone.removeAttribute('src');
          el.replaceWith(clone);
          return clone;
        };
        this.deckAEl = cloneClean(this.deckAEl);
        this.deckBEl = cloneClean(this.deckBEl);
        this.videoEl = cloneClean(this.videoEl);
        this.activeDeck = 'A';
        if (typeof this.onElementsRecreated === 'function') {
          this.onElementsRecreated({
            deckAEl: this.deckAEl,
            deckBEl: this.deckBEl,
            videoEl: this.videoEl
          });
        }
      }
    }
  }

  /**
   * Releases the Web Audio hardware stream before Native WASAPI Exclusive claims the DAC.
   */
  async suspendEngine() {
    await this.teardownEngine();
  }

  /**
   * Initializes (or cleanly recovers) the Web Audio Context for Studio DSP / Video playback.
   * @returns {Promise<boolean>} True if AudioContext is running.
   */
  async resumeEngine() {
    if (this.deckAEl?.error || this.deckBEl?.error) {
      if (this.ctx) {
        await this.teardownEngine();
      } else {
        const cloneClean = (el) => {
          if (!el || !el.parentNode) return el;
          el.pause();
          const clone = el.cloneNode(false);
          clone.removeAttribute('src');
          el.replaceWith(clone);
          return clone;
        };
        this.deckAEl = cloneClean(this.deckAEl);
        this.deckBEl = cloneClean(this.deckBEl);
        this.videoEl = cloneClean(this.videoEl);
        if (typeof this.onElementsRecreated === 'function') {
          this.onElementsRecreated({
            deckAEl: this.deckAEl,
            deckBEl: this.deckBEl,
            videoEl: this.videoEl
          });
        }
      }
    }
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        // Recover below via clean teardown + re-init
      }
      if (this.ctx && this.ctx.state !== 'running') {
        await this.teardownEngine();
      }
    }
    if (!this.ctx && this.deckAEl) {
      this.init(this.deckAEl, this.videoEl, this.deckBEl);
    }
    if (!this.ctx) return false;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }
    this.syncDspState();
    if (this.preferredSinkId || this.preferredSinkName) {
      await this.setOutputSinkId(this.preferredSinkId, this.preferredSinkName);
    }
    return this.ctx.state === 'running';
  }

  /**
   * Updates the Dual-Deck Equal-Power Crossfade overlap duration (0 = Gapless cut).
   * @param {number} seconds - Crossfade duration in seconds.
   */
  setCrossfadeSeconds(seconds) {
    this.state.crossfadeSeconds = Math.max(0, Math.min(15, Number(seconds) || 0));
  }

  /**
   * Initializes the Dual-Deck Web Audio API graph.
   * @param {HTMLAudioElement} deckAElement - Primary Deck A audio element.
   * @param {HTMLVideoElement} videoElement - Primary HD video element.
   * @param {HTMLAudioElement} [deckBElement=null] - Secondary Deck B audio element for Gapless/Crossfade.
   */
  init(deckAElement, videoElement, deckBElement = null) {
    this.bindElements(deckAElement, videoElement, deckBElement);
    if (this.ctx) return;
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) return;

    this.ctx = new AudioCtx({ latencyHint: 'playback' });

    this.deckAGain = this.ctx.createGain();
    this.deckAGain.gain.value = 1.0;

    this.deckBGain = this.ctx.createGain();
    this.deckBGain.gain.value = 0.0;

    this.replayGainNode = this.ctx.createGain();
    this.replayGainNode.gain.value = 1.0;

    this.preGain = this.ctx.createGain();
    this.preGain.gain.value = 1.0;

    // 1. 10-Band Parametric Equalizer Cascade + Dynamic Sub-Bass Shelf & Punch
    this.eqNodes = EQ_FREQUENCIES.map((freq, idx) => {
      const filter = this.ctx.createBiquadFilter();
      if (idx === 0) filter.type = 'lowshelf';
      else if (idx === EQ_FREQUENCIES.length - 1) filter.type = 'highshelf';
      else filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = idx > 0 && idx < EQ_FREQUENCIES.length - 1 ? 1.15 : 0.7;
      filter.gain.value = 0;
      return filter;
    });

    this.subBassLowShelf = this.ctx.createBiquadFilter();
    this.subBassLowShelf.type = 'lowshelf';
    this.subBassLowShelf.frequency.value = 70;
    this.subBassLowShelf.gain.value = 0;

    this.subBassPunch = this.ctx.createBiquadFilter();
    this.subBassPunch.type = 'peaking';
    this.subBassPunch.frequency.value = 120;
    this.subBassPunch.Q.value = 1.05;
    this.subBassPunch.gain.value = 0;

    // 2. Mid-Side Karaoke Vocal Cancellation Branch
    this.dryVocalGain = this.ctx.createGain();
    this.dryVocalGain.gain.value = 1.0;

    this.karaokeCancelGain = this.ctx.createGain();
    this.karaokeCancelGain.gain.value = 0.0;

    const splitter = this.ctx.createChannelSplitter(2);
    const rightInverter = this.ctx.createGain();
    rightInverter.gain.value = -1.0;
    const sideSummer = this.ctx.createGain();
    sideSummer.gain.value = 0.85;
    const merger = this.ctx.createChannelMerger(2);

    // 3. Harmonic Exciter Stage (4.5 kHz+ harmonic shimmer)
    const exciterOut = this._wireExciterStage(this.subBassPunch);

    // 4. Pitch Shifter Slot (pass-through gain replaced seamlessly once AudioWorklet registers)
    this.pitchPassGain = this.ctx.createGain();
    this.pitchPassGain.gain.value = 1.0;
    exciterOut.connect(this.pitchPassGain);

    this.crossfeedInput = this.ctx.createGain();
    this.crossfeedInput.gain.value = 1.0;
    this.pitchPassGain.connect(this.crossfeedInput);

    // 5. Bauer Headphone Crossfeed + Binaural 3D M/S Spatializer
    const xfOut = this._wireCrossfeedStage(this.crossfeedInput);
    const spatialOut = this._wireSpatialStage(xfOut);

    // 6. Tube Saturation (true null bypass unless vinyl or saturation is enabled)
    this.saturationNode = this.ctx.createWaveShaper();
    this.saturationNode.curve = null;
    this.saturationNode.oversample = '2x';
    spatialOut.connect(this.saturationNode);

    // 7. Hall Reverb with 18ms Pre-Delay
    this.reverbPreDelay = this.ctx.createDelay(0.1);
    this.reverbPreDelay.delayTime.value = 0.018;
    this.convolverNode = this.ctx.createConvolver();
    this.convolverNode.buffer = this._createWarmImpulseBuffer(1.65, 2.75);
    this.reverbDryGain = this.ctx.createGain();
    this.reverbWetGain = this.ctx.createGain();
    this.reverbDryGain.gain.value = 1.0;
    this.reverbWetGain.gain.value = 0.0;

    // 8. Night Compressor & True-Peak Limiter (-1.5 dBFS Clip Protect)
    this.compressorNode = this.ctx.createDynamicsCompressor();
    this.compressorNode.threshold.value = -1.5;
    this.compressorNode.knee.value = 2.5;
    this.compressorNode.ratio.value = 12;
    this.compressorNode.attack.value = 0.002;
    this.compressorNode.release.value = 0.12;
    this.compDryGain = this.ctx.createGain();
    this.compWetGain = this.ctx.createGain();
    this.compDryGain.gain.value = 0.0;
    this.compWetGain.gain.value = 1.0;

    // 9. Master Gain & 60 FPS FFT AnalyserNode
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.state.volume;

    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 1024;
    this.analyserNode.smoothingTimeConstant = 0.78;

    const meterSplitter = this.ctx.createChannelSplitter(2);
    this.leftAnalyser = this.ctx.createAnalyser();
    this.leftAnalyser.fftSize = 256;
    this.rightAnalyser = this.ctx.createAnalyser();
    this.rightAnalyser.fftSize = 256;
    this.masterGain.connect(meterSplitter);
    meterSplitter.connect(this.leftAnalyser, 0);
    meterSplitter.connect(this.rightAnalyser, 1);

    if (this.deckAEl) {
      const srcA = this.ctx.createMediaElementSource(this.deckAEl);
      srcA.connect(this.deckAGain);
      this.deckAGain.connect(this.replayGainNode);
    }
    if (this.deckBEl) {
      const srcB = this.ctx.createMediaElementSource(this.deckBEl);
      srcB.connect(this.deckBGain);
      this.deckBGain.connect(this.replayGainNode);
    }
    if (this.videoEl) {
      const srcV = this.ctx.createMediaElementSource(this.videoEl);
      srcV.connect(this.replayGainNode);
    }

    this.replayGainNode.connect(this.preGain);

    // Karaoke parallel routing
    this.preGain.connect(this.dryVocalGain);
    this.preGain.connect(splitter);
    splitter.connect(sideSummer, 0);
    splitter.connect(rightInverter, 1);
    rightInverter.connect(sideSummer);
    sideSummer.connect(merger, 0, 0);
    sideSummer.connect(merger, 0, 1);
    merger.connect(this.karaokeCancelGain);

    const eqEntry = this.eqNodes[0];
    this.dryVocalGain.connect(eqEntry);
    this.karaokeCancelGain.connect(eqEntry);

    for (let i = 0; i < this.eqNodes.length - 1; i++) {
      this.eqNodes[i].connect(this.eqNodes[i + 1]);
    }

    const eqExit = this.eqNodes[this.eqNodes.length - 1];
    eqExit.connect(this.subBassLowShelf);
    this.subBassLowShelf.connect(this.subBassPunch);

    // Saturation -> Reverb dry/wet -> Limiter dry/wet -> Master
    const reverbSum = this.ctx.createGain();
    this.saturationNode.connect(this.reverbDryGain);
    this.saturationNode.connect(this.reverbPreDelay);
    this.reverbPreDelay.connect(this.convolverNode);
    this.convolverNode.connect(this.reverbWetGain);
    this.reverbDryGain.connect(reverbSum);
    this.reverbWetGain.connect(reverbSum);

    reverbSum.connect(this.compDryGain);
    reverbSum.connect(this.compressorNode);
    this.compressorNode.connect(this.compWetGain);
    this.compDryGain.connect(this.masterGain);
    this.compWetGain.connect(this.masterGain);

    this.masterGain.connect(this.analyserNode);
    this.analyserNode.connect(this.ctx.destination);

    this._attachPitchWorklet(this.crossfeedInput);
    this.syncDspState();
  }

  _wireExciterStage(inputNode) {
    const out = this.ctx.createGain();
    this.exciterDryGain = this.ctx.createGain();
    this.exciterDryGain.gain.value = 1.0;

    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4500;
    hp.Q.value = 0.7;

    const shaper = this.ctx.createWaveShaper();
    shaper.curve = buildTubeSaturationCurve(38);
    shaper.oversample = '2x';

    this.exciterWetGain = this.ctx.createGain();
    this.exciterWetGain.gain.value = 0.0;

    inputNode.connect(this.exciterDryGain);
    this.exciterDryGain.connect(out);
    inputNode.connect(hp);
    hp.connect(shaper);
    shaper.connect(this.exciterWetGain);
    this.exciterWetGain.connect(out);
    return out;
  }

  _wireCrossfeedStage(inputNode) {
    const out = this.ctx.createGain();
    const split = this.ctx.createChannelSplitter(2);
    const merge = this.ctx.createChannelMerger(2);

    this.xfDirectGain = this.ctx.createGain();
    this.xfDirectGain.gain.value = 1.0;
    const directR = this.ctx.createGain();
    directR.gain.value = 1.0;

    // Keep right direct gain linked via xfDirectGain reference pair
    this._xfDirectGainR = directR;

    const lpL = this.ctx.createBiquadFilter();
    lpL.type = 'lowpass';
    lpL.frequency.value = 700;
    const delayL = this.ctx.createDelay(0.01);
    delayL.delayTime.value = 0.00026;
    this.xfCrossGainL = this.ctx.createGain();
    this.xfCrossGainL.gain.value = 0.0;

    const lpR = this.ctx.createBiquadFilter();
    lpR.type = 'lowpass';
    lpR.frequency.value = 700;
    const delayR = this.ctx.createDelay(0.01);
    delayR.delayTime.value = 0.00026;
    this.xfCrossGainR = this.ctx.createGain();
    this.xfCrossGainR.gain.value = 0.0;

    inputNode.connect(split);
    // Direct L->L, R->R
    split.connect(this.xfDirectGain, 0);
    this.xfDirectGain.connect(merge, 0, 0);
    split.connect(directR, 1);
    directR.connect(merge, 0, 1);

    // Crossfeed L->R and R->L
    split.connect(lpL, 0);
    lpL.connect(delayL);
    delayL.connect(this.xfCrossGainL);
    this.xfCrossGainL.connect(merge, 0, 1);

    split.connect(lpR, 1);
    lpR.connect(delayR);
    delayR.connect(this.xfCrossGainR);
    this.xfCrossGainR.connect(merge, 0, 0);

    merge.connect(out);
    return out;
  }

  _wireSpatialStage(inputNode) {
    const out = this.ctx.createGain();

    // True null bypass branch when Spatial 3D is OFF
    this.spatialDryGain = this.ctx.createGain();
    this.spatialDryGain.gain.value = 1.0;
    inputNode.connect(this.spatialDryGain);
    this.spatialDryGain.connect(out);

    // Active Binaural M/S Spatial branch
    this.spatialWetGain = this.ctx.createGain();
    this.spatialWetGain.gain.value = 0.0;

    const spSplit = this.ctx.createChannelSplitter(2);
    const spMerge = this.ctx.createChannelMerger(2);

    // Mid = 0.5*(L + R), Side = 0.5*(L - R)
    const lMid = this.ctx.createGain();
    const rMid = this.ctx.createGain();
    lMid.gain.value = 0.5;
    rMid.gain.value = 0.5;
    this.spatialMidGain = this.ctx.createGain();
    this.spatialMidGain.gain.value = 1.0;

    const lSide = this.ctx.createGain();
    const rSideNeg = this.ctx.createGain();
    lSide.gain.value = 0.5;
    rSideNeg.gain.value = -0.5;

    // Keep <160 Hz bass anchored in center; widen 160 Hz+ stereo stage
    const sideHighPass = this.ctx.createBiquadFilter();
    sideHighPass.type = 'highpass';
    sideHighPass.frequency.value = 160;
    sideHighPass.Q.value = 0.7;
    const sideLowPass = this.ctx.createBiquadFilter();
    sideLowPass.type = 'lowpass';
    sideLowPass.frequency.value = 160;

    this.spatialSideGain = this.ctx.createGain();
    this.spatialSideGain.gain.value = 1.45;
    const sideLowUnity = this.ctx.createGain();
    sideLowUnity.gain.value = 1.0;

    const sideBus = this.ctx.createGain();
    this.spatialHaasDelay = this.ctx.createDelay(0.01);
    this.spatialHaasDelay.delayTime.value = 0.00065;

    const sideInvert = this.ctx.createGain();
    sideInvert.gain.value = -1.0;

    // Subtle short early-reflection room for Binaural depth
    this.spatialConvolver = this.ctx.createConvolver();
    this.spatialConvolver.buffer = this._createWarmImpulseBuffer(0.32, 6.2);
    this.spatialEarlyGain = this.ctx.createGain();
    this.spatialEarlyGain.gain.value = 0.0;

    inputNode.connect(spSplit);
    spSplit.connect(lMid, 0);
    spSplit.connect(rMid, 1);
    lMid.connect(this.spatialMidGain);
    rMid.connect(this.spatialMidGain);

    spSplit.connect(lSide, 0);
    spSplit.connect(rSideNeg, 1);
    lSide.connect(sideHighPass);
    rSideNeg.connect(sideHighPass);
    lSide.connect(sideLowPass);
    rSideNeg.connect(sideLowPass);

    sideHighPass.connect(this.spatialSideGain);
    this.spatialSideGain.connect(this.spatialHaasDelay);
    this.spatialHaasDelay.connect(sideBus);
    sideLowPass.connect(sideLowUnity);
    sideLowUnity.connect(sideBus);

    // Reconstruct L = Mid + Side, R = Mid - Side
    this.spatialMidGain.connect(spMerge, 0, 0);
    sideBus.connect(spMerge, 0, 0);
    this.spatialMidGain.connect(spMerge, 0, 1);
    sideBus.connect(sideInvert);
    sideInvert.connect(spMerge, 0, 1);

    spMerge.connect(this.spatialWetGain);
    spMerge.connect(this.spatialConvolver);
    this.spatialConvolver.connect(this.spatialEarlyGain);
    this.spatialEarlyGain.connect(this.spatialWetGain);
    this.spatialWetGain.connect(out);
    return out;
  }

  _attachPitchWorklet(targetAfterPitchNode) {
    const capturedCtx = this.ctx;
    if (!capturedCtx?.audioWorklet || typeof AudioWorkletNode === 'undefined') return;
    capturedCtx.audioWorklet
      .addModule('./js/pitchWorklet.js')
      .then(() => {
        if (this.ctx !== capturedCtx || !this.pitchPassGain) return;
        const pNode = new AudioWorkletNode(capturedCtx, 'vanta-pitch-shifter', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2]
        });
        this.pitchNode = pNode;
        const semiParam = pNode.parameters.get('semitones');
        if (semiParam) semiParam.value = Number(this.state.pitchSemitones) || 0;
        // Disconnect pass-through only after worklet connects cleanly
        this.pitchPassGain.connect(pNode);
        pNode.connect(targetAfterPitchNode);
        try {
          this.pitchPassGain.disconnect(targetAfterPitchNode);
        } catch {
          // Ignore if already disconnected
        }
      })
      .catch(() => {
        // Fallback keeps pitchPassGain wired directly without throwing
      });
  }

  /**
   * Returns the currently active HTMLAudioElement ('A' or 'B').
   * @returns {HTMLAudioElement|null}
   */
  getActiveDeckElement() {
    return this.activeDeck === 'B' && this.deckBEl ? this.deckBEl : this.deckAEl;
  }

  /**
   * Returns the standby HTMLAudioElement ('B' or 'A').
   * @returns {HTMLAudioElement|null}
   */
  getStandbyDeckElement() {
    return this.activeDeck === 'B' ? this.deckAEl : this.deckBEl;
  }

  /**
   * Executes a real Dual-Deck Gapless or Equal-Power Crossfade transition to the standby deck.
   * @param {string} nextMediaUrl - vanta-media:// URL for the next track.
   * @param {number} [durationSec=this.state.crossfadeSeconds] - Crossfade duration (0 = Gapless cut).
   * @param {number} [nextReplayGain=1.0] - Linear EBU R128 gain for incoming track.
   */
  async crossfadeToNext(nextMediaUrl, durationSec = this.state.crossfadeSeconds, nextReplayGain = 1.0) {
    if (!this.ctx || !this.deckAEl || !this.deckBEl) return;
    if (this.crossfadeRaf) {
      cancelAnimationFrame(this.crossfadeRaf);
      this.crossfadeRaf = null;
    }

    const outgoingEl = this.getActiveDeckElement();
    const incomingEl = this.getStandbyDeckElement();
    const outgoingGain = this.activeDeck === 'B' ? this.deckBGain : this.deckAGain;
    const incomingGain = this.activeDeck === 'B' ? this.deckAGain : this.deckBGain;

    incomingEl.src = nextMediaUrl;
    incomingEl.playbackRate = this.state.playbackRate;
    incomingEl.currentTime = 0;

    this.activeDeck = this.activeDeck === 'A' ? 'B' : 'A';
    this.state.replayGainLinear = nextReplayGain;
    this.syncDspState();

    const fadeMs = Math.max(0, Number(durationSec) || 0) * 1000;
    if (fadeMs < 50) {
      outgoingGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
      incomingGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
      outgoingEl.pause();
      await incomingEl.play();
      return;
    }

    incomingGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
    await incomingEl.play();

    const startTime = performance.now();
    const step = () => {
      const elapsed = performance.now() - startTime;
      const t = Math.min(1, elapsed / fadeMs);
      const { gainA, gainB } = computeEqualPowerCrossfade(t);
      outgoingGain.gain.setValueAtTime(gainA, this.ctx.currentTime);
      incomingGain.gain.setValueAtTime(gainB, this.ctx.currentTime);
      if (t < 1) {
        this.crossfadeRaf = requestAnimationFrame(step);
      } else {
        this.crossfadeRaf = null;
        outgoingEl.pause();
      }
    };
    this.crossfadeRaf = requestAnimationFrame(step);
  }

  /**
   * Routes Web Audio output to a matching physical hardware sink device ID or friendly Windows endpoint name.
   * Excludes Chromium virtual pseudo-IDs ('default' / 'communications') which fail AudioContext.setSinkId().
   * @param {string} sinkId - WASAPI or Chromium device ID (empty string for default).
   * @param {string} [deviceName=''] - Friendly endpoint label for matching physical audiooutput devices.
   */
  async setOutputSinkId(sinkId = '', deviceName = '') {
    this.preferredSinkId = sinkId || '';
    this.preferredSinkName = deviceName || '';
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return false;
    let resolvedId = '';
    if (sinkId || deviceName) {
      try {
        if (navigator.mediaDevices?.enumerateDevices) {
          const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(
            (d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
          );
          const cleanName = String(deviceName || '').replace(/^[★🎧🔊]\s*/u, '').trim().toLowerCase();
          const exact = outputs.find((d) => d.deviceId === sinkId);
          const byLabel = cleanName
            ? outputs.find((d) => {
                const lbl = (d.label || '').toLowerCase();
                return lbl === cleanName || lbl.includes(cleanName) || cleanName.includes(lbl);
              })
            : null;
          resolvedId = exact?.deviceId || byLabel?.deviceId || '';
        }
      } catch {
        resolvedId = '';
      }
    }
    try {
      await this.ctx.setSinkId(resolvedId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Updates the Studio DSP master volume smoothly (linear 0.0 to 1.0).
   * @param {number} linearVolume - Target volume multiplier in [0, 1].
   */
  setVolume(linearVolume = 1.0) {
    const v = Math.max(0, Math.min(1, Number(linearVolume)));
    this.state.volume = Number.isFinite(v) ? v : 1.0;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.state.volume, this.ctx.currentTime, 0.015);
    }
  }

  /**
   * Updates the linear EBU R128 ReplayGain multiplier for non-destructive loudness matching.
   * @param {number} linear - Linear gain multiplier.
   */
  setReplayGainLinear(linear = 1.0) {
    this.state.replayGainLinear = Math.max(0.15, Math.min(2.2, Number(linear) || 1.0));
    this.syncDspState();
  }

  /**
   * Injects real-time 24-band FFT spectrum, wave & L/R metering from the Native C++ WASAPI engine.
   * @param {number[]|null} bars - Array of 24 normalized bar magnitudes.
   * @param {object|null} [telemetry=null] - Full WASAPI packet ({ wave, lPeak, rPeak, lRms, rRms }).
   */
  setExternalSpectrum(bars, telemetry = null) {
    if (Array.isArray(bars) && bars.length > 0) {
      this.externalBars = bars;
      this.externalTelemetry = telemetry;
      this.externalTimestamp = performance.now();
    } else if (bars === null) {
      this.externalBars = null;
      this.externalTelemetry = null;
    }
  }

  _createWarmImpulseBuffer(durationSeconds = 1.3, decayRate = 3.2) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(rate * durationSeconds);
    const impulse = this.ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const white = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decayRate);
        lp = lp * 0.78 + white * 0.22;
        data[i] = lp;
      }
    }
    return impulse;
  }

  /**
   * Synchronizes all Web Audio DSP parameters.
   */
  syncDspState() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    const now = this.ctx.currentTime;

    const profileOffsets = DEVICE_EQ_PROFILES[this.state.deviceProfile] || DEVICE_EQ_PROFILES['Bit-Perfect (Flat)'];
    const useProfile = this.state.deviceProfile !== 'Bit-Perfect (Flat)' && this.state.deviceProfile !== 'Studio Monitors';

    let maxPositiveBoost = 0;
    this.eqNodes.forEach((node, idx) => {
      const bandGain = this.state.eqEnabled ? (this.state.gains[idx] || 0) : 0;
      const profileGain = useProfile ? (profileOffsets[idx] || 0) : 0;
      const targetGain = Math.max(-12, Math.min(12, bandGain + profileGain));
      if (targetGain > maxPositiveBoost) maxPositiveBoost = targetGain;
      node.gain.setTargetAtTime(targetGain, now, 0.02);
    });

    // Dedicated Sub-Bass Shelf & Punch (does not crush overall volume)
    const bassCfg = this.state.bassBoost
      ? computeSubBassCurveParams(this.state.bassBoostDb)
      : { subShelfDb: 0, punchDb: 0, headroomLinear: 1.0 };
    this.subBassLowShelf?.gain.setTargetAtTime(bassCfg.subShelfDb, now, 0.025);
    this.subBassPunch?.gain.setTargetAtTime(bassCfg.punchDb, now, 0.025);

    const eqHeadroom = maxPositiveBoost > 0.5 ? Math.pow(10, -Math.min(5, maxPositiveBoost * 0.4) / 20) : 1.0;
    const nightMakeup = this.state.nightMode ? 1.38 : 1.0;
    this.preGain.gain.setTargetAtTime(eqHeadroom * bassCfg.headroomLinear * nightMakeup, now, 0.025);

    // Non-destructive EBU R128 ReplayGain
    const rg = this.state.lufs ? (this.state.replayGainLinear || 1.0) : 1.0;
    this.replayGainNode.gain.setTargetAtTime(rg, now, 0.03);

    // Karaoke Vocal Cancellation
    this.dryVocalGain.gain.setTargetAtTime(this.state.karaoke ? 0.12 : 1.0, now, 0.03);
    this.karaokeCancelGain.gain.setTargetAtTime(this.state.karaoke ? 0.95 : 0.0, now, 0.03);

    // Harmonic Exciter (4.5 kHz+ parallel brilliance)
    const excWet = this.state.exciter ? (Math.max(0, Math.min(100, this.state.exciterMixPct)) / 100) * 0.42 : 0.0;
    this.exciterWetGain?.gain.setTargetAtTime(excWet, now, 0.025);
    this.exciterDryGain?.gain.setTargetAtTime(1.0, now, 0.025);

    // Real-time Pitch Shift
    const semiParam = this.pitchNode?.parameters?.get('semitones');
    if (semiParam) {
      semiParam.setTargetAtTime(Math.max(-6, Math.min(6, Number(this.state.pitchSemitones) || 0)), now, 0.02);
    }

    // Bauer Headphone Crossfeed
    if (this.state.crossfeed) {
      const xf = computeBauerCrossfeedParams(this.state.crossfeedLevelPct);
      this.xfDirectGain?.gain.setTargetAtTime(xf.directGain, now, 0.025);
      this._xfDirectGainR?.gain.setTargetAtTime(xf.directGain, now, 0.025);
      this.xfCrossGainL?.gain.setTargetAtTime(xf.crossGain, now, 0.025);
      this.xfCrossGainR?.gain.setTargetAtTime(xf.crossGain, now, 0.025);
    } else {
      this.xfDirectGain?.gain.setTargetAtTime(1.0, now, 0.025);
      this._xfDirectGainR?.gain.setTargetAtTime(1.0, now, 0.025);
      this.xfCrossGainL?.gain.setTargetAtTime(0.0, now, 0.025);
      this.xfCrossGainR?.gain.setTargetAtTime(0.0, now, 0.025);
    }

    // Binaural 3D M/S Spatializer (true null bypass when OFF)
    if (this.state.spatial) {
      const sp = computeMidSideSpatialGains(this.state.spatialWidthPct);
      this.spatialDryGain?.gain.setTargetAtTime(0.0, now, 0.025);
      this.spatialWetGain?.gain.setTargetAtTime(1.0, now, 0.025);
      this.spatialMidGain?.gain.setTargetAtTime(sp.midGain, now, 0.025);
      this.spatialSideGain?.gain.setTargetAtTime(sp.sideGain, now, 0.025);
      this.spatialHaasDelay?.delayTime.setTargetAtTime(sp.haasDelaySec, now, 0.025);
      this.spatialEarlyGain?.gain.setTargetAtTime(sp.earlyWet, now, 0.025);
    } else {
      this.spatialDryGain?.gain.setTargetAtTime(1.0, now, 0.025);
      this.spatialWetGain?.gain.setTargetAtTime(0.0, now, 0.025);
    }

    // Saturation & Vinyl Soul (true null bypass when OFF)
    if (this.state.vinyl || this.state.saturation) {
      this.saturationNode.curve = buildTubeSaturationCurve(this.state.vinyl ? 24 : 18);
    } else {
      this.saturationNode.curve = null;
    }
    this._toggleVinylCrackle(this.state.vinyl);

    // Hall Reverb
    const wet = this.state.reverb ? (Math.max(0, Math.min(45, this.state.reverbMixPct)) / 100) : 0.0;
    this.reverbWetGain.gain.setTargetAtTime(wet, now, 0.03);
    this.reverbDryGain.gain.setTargetAtTime(1.0 - wet * 0.25, now, 0.03);

    // Night Compressor + True-Peak Limiter
    if (this.compressorNode) {
      if (this.state.nightMode) {
        this.compressorNode.threshold.setTargetAtTime(-20, now, 0.03);
        this.compressorNode.knee.setTargetAtTime(14, now, 0.03);
        this.compressorNode.ratio.setTargetAtTime(4.5, now, 0.03);
        this.compressorNode.attack.setTargetAtTime(0.008, now, 0.03);
        this.compressorNode.release.setTargetAtTime(0.22, now, 0.03);
      } else {
        this.compressorNode.threshold.setTargetAtTime(-1.5, now, 0.03);
        this.compressorNode.knee.setTargetAtTime(2.5, now, 0.03);
        this.compressorNode.ratio.setTargetAtTime(12, now, 0.03);
        this.compressorNode.attack.setTargetAtTime(0.002, now, 0.03);
        this.compressorNode.release.setTargetAtTime(0.12, now, 0.03);
      }
    }
    const useComp = Boolean(this.state.limiter || this.state.nightMode);
    this.compWetGain?.gain.setTargetAtTime(useComp ? 1.0 : 0.0, now, 0.02);
    this.compDryGain?.gain.setTargetAtTime(useComp ? 0.0 : 1.0, now, 0.02);
  }

  _toggleVinylCrackle(active) {
    if (this.crackleTimer) {
      clearInterval(this.crackleTimer);
      this.crackleTimer = null;
    }
    if (!active || !this.ctx) return;

    this.crackleTimer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      if (Math.random() > 0.5) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 1800 + Math.random() * 3000;
      gain.gain.setValueAtTime(0.008, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.016);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.02);
    }, 150);
  }

  stopProceduralSynthPreview() {
    // Kept as no-op for clean interface compatibility
  }

  setEqBandGain(bandIndex, dbGain) {
    if (bandIndex >= 0 && bandIndex < this.state.gains.length) {
      this.state.eqEnabled = true;
      this.state.gains[bandIndex] = Math.max(-12, Math.min(12, Number(dbGain) || 0));
      this.syncDspState();
    }
  }

  /**
   * Updates a continuous numeric DSP parameter cleanly within safe bounds.
   * @param {string} key - State key name.
   * @param {number} value - Target numeric value.
   */
  setDspParam(key, value) {
    const bounds = {
      spatialWidthPct: [0, 150],
      crossfeedLevelPct: [0, 100],
      bassBoostDb: [0, 9],
      exciterMixPct: [0, 100],
      reverbMixPct: [0, 45],
      pitchSemitones: [-6, 6]
    };
    const range = bounds[key];
    if (!range) return;
    const clamped = Math.max(range[0], Math.min(range[1], Number(value) || 0));
    this.state[key] = clamped;
    this.syncDspState();
  }

  /**
   * Applies a named 10-band graphic EQ preset.
   * @param {string} presetName - Key in EQ_PRESETS.
   */
  applyEqPreset(presetName) {
    const curve = EQ_PRESETS[presetName];
    if (!curve) return;
    this.state.gains = [...curve];
    this.state.eqEnabled = presetName !== 'Flat Reference';
    this.syncDspState();
  }

  /**
   * Resets all coloring/spatial FX back to Bit-Perfect transparency while preserving safety protection.
   */
  resetBitPerfect() {
    this.state.gains = [...EQ_PRESETS['Flat Reference']];
    this.state.deviceProfile = 'Bit-Perfect (Flat)';
    this.state.eqEnabled = false;
    this.state.spatial = false;
    this.state.crossfeed = false;
    this.state.bassBoost = false;
    this.state.exciter = false;
    this.state.reverb = false;
    this.state.karaoke = false;
    this.state.vinyl = false;
    this.state.saturation = false;
    this.state.nightMode = false;
    this.state.pitchSemitones = 0;
    this.state.limiter = true;
    this.state.lufs = true;
    this.syncDspState();
  }

  /**
   * Serializes user DSP configuration for localStorage persistence.
   * @returns {object} Plain serializable DSP state snapshot.
   */
  exportPersistState() {
    return {
      gains: [...this.state.gains],
      deviceProfile: this.state.deviceProfile,
      spatial: this.state.spatial,
      spatialWidthPct: this.state.spatialWidthPct,
      crossfeed: this.state.crossfeed,
      crossfeedLevelPct: this.state.crossfeedLevelPct,
      exciter: this.state.exciter,
      exciterMixPct: this.state.exciterMixPct,
      limiter: this.state.limiter,
      nightMode: this.state.nightMode,
      eqEnabled: this.state.eqEnabled,
      karaoke: this.state.karaoke,
      vinyl: this.state.vinyl,
      lufs: this.state.lufs,
      reverb: this.state.reverb,
      reverbMixPct: this.state.reverbMixPct,
      bassBoost: this.state.bassBoost,
      bassBoostDb: this.state.bassBoostDb,
      pitchSemitones: this.state.pitchSemitones
    };
  }

  /**
   * Restores persisted DSP settings safely, upgrading legacy 8-band gain arrays to 10-band.
   * @param {object} saved - Parsed object from localStorage.
   */
  importPersistState(saved) {
    if (!saved || typeof saved !== 'object') return;
    if (Array.isArray(saved.gains)) {
      if (saved.gains.length === EQ_FREQUENCIES.length) {
        this.state.gains = saved.gains.map((g) => Math.max(-12, Math.min(12, Number(g) || 0)));
      } else if (saved.gains.length === 8) {
        // Migrate legacy 8-band array cleanly into 10-band slots
        this.state.gains = [
          saved.gains[0] || 0,
          saved.gains[0] || 0,
          saved.gains[1] || 0,
          saved.gains[2] || 0,
          saved.gains[3] || 0,
          saved.gains[4] || 0,
          saved.gains[4] || 0,
          saved.gains[5] || 0,
          saved.gains[6] || 0,
          saved.gains[7] || 0
        ];
      }
    }
    const boolKeys = ['spatial', 'crossfeed', 'exciter', 'limiter', 'nightMode', 'eqEnabled', 'karaoke', 'vinyl', 'lufs', 'reverb', 'bassBoost'];
    for (const k of boolKeys) {
      if (typeof saved[k] === 'boolean') this.state[k] = saved[k];
    }
    const numKeys = ['spatialWidthPct', 'crossfeedLevelPct', 'exciterMixPct', 'reverbMixPct', 'bassBoostDb', 'pitchSemitones'];
    for (const k of numKeys) {
      if (Number.isFinite(Number(saved[k]))) this.setDspParam(k, Number(saved[k]));
    }
    if (saved.deviceProfile && DEVICE_EQ_PROFILES[saved.deviceProfile]) {
      this.state.deviceProfile = saved.deviceProfile;
    }
    this.syncDspState();
  }

  toggleDspFlag(flagName) {
    if (typeof this.state[flagName] === 'boolean') {
      this.state[flagName] = !this.state[flagName];
      this.syncDspState();
    }
    return Boolean(this.state[flagName]);
  }

  /**
   * Reads live logarithmic 24-band spectrum bars from either Native WASAPI FFT or WebAudio AnalyserNode.
   * @param {number} [barCount=24] - Output bar count.
   * @returns {number[]} Array of normalized magnitudes in [0.05, 1].
   */
  getSpectrumBars(barCount = 24) {
    if (this.externalBars && performance.now() - this.externalTimestamp < 350) {
      return this.externalBars.slice(0, barCount);
    }
    if (!this.analyserNode || !this.ctx) {
      return Array.from({ length: barCount }, () => 0.06);
    }
    const bins = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(bins);
    const sr = this.ctx.sampleRate || 48000;
    const binHz = sr / this.analyserNode.fftSize;
    const minHz = 40;
    const maxHz = Math.min(18000, sr * 0.46);
    const out = [];
    for (let i = 0; i < barCount; i++) {
      const f0 = minHz * Math.pow(maxHz / minHz, i / barCount);
      const f1 = minHz * Math.pow(maxHz / minHz, (i + 1) / barCount);
      const b0 = Math.max(1, Math.floor(f0 / binHz));
      const b1 = Math.min(bins.length - 1, Math.max(b0, Math.ceil(f1 / binHz)));
      let peakVal = 0;
      for (let k = b0; k <= b1; k++) {
        if (bins[k] > peakVal) peakVal = bins[k];
      }
      const norm = Math.max(0.05, Math.min(1.0, (peakVal / 255) * (1 + 0.25 * (i / barCount))));
      out.push(norm);
    }
    return out;
  }

  /**
   * Reads live time-domain oscilloscope waveform samples in [-1, 1].
   * @param {number} [sampleCount=32] - Target point count.
   * @returns {number[]} Signed float waveform points.
   */
  getWaveformSamples(sampleCount = 32) {
    if (this.externalTelemetry?.wave && performance.now() - this.externalTimestamp < 350) {
      return this.externalTelemetry.wave;
    }
    if (!this.analyserNode) {
      return Array.from({ length: sampleCount }, () => 0);
    }
    const buf = new Float32Array(this.analyserNode.fftSize);
    this.analyserNode.getFloatTimeDomainData(buf);
    const step = Math.max(1, Math.floor(buf.length / sampleCount));
    const out = [];
    for (let i = 0; i < sampleCount; i++) {
      out.push(buf[Math.min(buf.length - 1, i * step)] || 0);
    }
    return out;
  }

  /**
   * Reads stereo L/R RMS & Peak magnitudes in [0, 1] for VU / True Peak studio metering.
   * @returns {{ lPeak: number, rPeak: number, lRms: number, rRms: number }}
   */
  getStereoLevels() {
    if (this.externalTelemetry && performance.now() - this.externalTimestamp < 350) {
      return {
        lPeak: Number(this.externalTelemetry.lPeak) || 0,
        rPeak: Number(this.externalTelemetry.rPeak) || 0,
        lRms: Number(this.externalTelemetry.lRms) || 0,
        rRms: Number(this.externalTelemetry.rRms) || 0
      };
    }
    const measureChannel = (analyser) => {
      if (!analyser) return { rms: 0, peak: 0 };
      const buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const s = Math.abs(buf[i]);
        if (s > peak) peak = s;
        sum += buf[i] * buf[i];
      }
      return { rms: Math.sqrt(sum / buf.length), peak: Math.min(1, peak) };
    };
    const l = measureChannel(this.leftAnalyser);
    const r = measureChannel(this.rightAnalyser);
    return { lPeak: l.peak, rPeak: r.peak, lRms: l.rms, rRms: r.rms };
  }
}
