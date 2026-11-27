/**
 * @fileoverview VANTA Score Studio Polyphonic Piano Preview Synthesizer (Phase 9.3).
 * Pure Web Audio API warm acoustic/electric piano synthesizer for clicking notes
 * on the Piano Roll / Sheet Music and auditioning extracted MIDI scores in sync.
 */

import { encodePcmToWavBytes } from './scoreExporter.js';

/**
 * Renders the full Score Model offline into a clean warm stereo PCM16 WAV buffer.
 * Uses pure Float32 additive piano synthesis (no heavy OfflineAudioContext node graph bottlenecks),
 * trims opening dead silence, respects `playbackRate`, and applies soft-limiting warmth.
 * @param {object} scoreModel - Output of `buildScoreModel`.
 * @param {object} [opts={}] - `{ playbackRate }`.
 * @returns {Promise<Uint8Array>} Stereo 44.1 kHz RIFF/WAVE buffer.
 */
export async function renderScoreAudioWav(scoreModel, opts = {}) {
  const notes = Array.isArray(scoreModel?.notes) ? scoreModel.notes : [];
  if (!notes.length) {
    throw new Error('No active notes available to synthesize.');
  }

  const rate = Math.max(0.25, Math.min(2.5, Number(opts.playbackRate) || 1.0));
  const trimOrigin = Math.max(0, Number(scoreModel?.beatOffsetSec) || 0);
  const sampleRate = 44100;

  let maxEndSec = 1.5;
  const scheduled = notes.map((n) => {
    const relStart = Math.max(0, Number(n.startSec) - trimOrigin) / rate + 0.06;
    const rawDur = Math.max(0.08, (Number(n.endSec) - Number(n.startSec)) / rate);
    const dur = Math.min(2.6, rawDur);
    if (relStart + dur + 0.25 > maxEndSec) {
      maxEndSec = relStart + dur + 0.25;
    }
    return {
      startSec: relStart,
      pitch: Math.max(21, Math.min(108, Math.round(Number(n.pitch) || 60))),
      dur,
      vel: Math.max(1, Math.min(127, Number(n.velocity) || 80))
    };
  });

  const numFrames = Math.ceil((maxEndSec + 0.2) * sampleRate);
  const chL = new Float32Array(numFrames);
  const chR = new Float32Array(numFrames);
  const TWO_PI = Math.PI * 2;
  const attackFrames = Math.max(1, Math.round(0.009 * sampleRate));

  for (const ev of scheduled) {
    const startIdx = Math.max(0, Math.floor(ev.startSec * sampleRate));
    const releaseFrames = Math.round(0.14 * sampleRate);
    const sustainFrames = Math.round(ev.dur * sampleRate);
    const totalNoteFrames = sustainFrames + releaseFrames;
    const endIdx = Math.min(numFrames, startIdx + totalNoteFrames);
    if (endIdx <= startIdx) continue;

    const freq = 440 * Math.pow(2, (ev.pitch - 69) / 12);
    const omega1 = (TWO_PI * freq) / sampleRate;
    const omega2 = omega1 * 2;
    const omega3 = omega1 * 3;
    const nyquistOk2 = freq * 2 < sampleRate * 0.45;
    const nyquistOk3 = freq * 3 < sampleRate * 0.45;

    const amp = (ev.vel / 127) * 0.20;
    const pan = Math.max(-0.42, Math.min(0.42, ((ev.pitch - 60) / 36) * 0.38));
    const gainL = amp * Math.cos((pan + 1) * Math.PI * 0.25);
    const gainR = amp * Math.sin((pan + 1) * Math.PI * 0.25);

    const decayRate1 = 1.6 / Math.max(0.25, ev.dur);
    const decayRate2 = decayRate1 * 2.1;
    const decayRate3 = decayRate1 * 4.2;

    // Phasor recurrence eliminates costly trig calls inside inner sample loop
    const c1 = Math.cos(omega1), s1 = Math.sin(omega1);
    const c2 = Math.cos(omega2), s2 = Math.sin(omega2);
    const c3 = Math.cos(omega3), s3 = Math.sin(omega3);
    let x1 = 1, y1 = 0;
    let x2 = 1, y2 = 0;
    let x3 = 1, y3 = 0;

    const dec1Step = Math.exp(-decayRate1 / sampleRate);
    const dec2Step = Math.exp(-decayRate2 / sampleRate);
    const dec3Step = Math.exp(-decayRate3 / sampleRate);
    let d1 = 1.0, d2 = 0.34, d3 = 0.12;

    for (let i = startIdx; i < endIdx; i++) {
      const local = i - startIdx;
      const nx1 = x1 * c1 - y1 * s1;
      y1 = x1 * s1 + y1 * c1;
      x1 = nx1;

      let sample = y1 * d1;
      if (nyquistOk2) {
        const nx2 = x2 * c2 - y2 * s2;
        y2 = x2 * s2 + y2 * c2;
        x2 = nx2;
        sample += y2 * d2;
      }
      if (nyquistOk3) {
        const nx3 = x3 * c3 - y3 * s3;
        y3 = x3 * s3 + y3 * c3;
        x3 = nx3;
        sample += y3 * d3;
      }

      d1 *= dec1Step;
      d2 *= dec2Step;
      d3 *= dec3Step;

      let env = 1.0;
      if (local < attackFrames) {
        env = local / attackFrames;
      } else if (local > sustainFrames) {
        const relFrac = (local - sustainFrames) / Math.max(1, releaseFrames);
        env = Math.max(0, 1 - relFrac);
      }

      const v = sample * env;
      chL[i] += v * gainL;
      chR[i] += v * gainR;
    }
  }

  // Soft warm bus limiting to prevent chord summing clipping
  for (let i = 0; i < numFrames; i++) {
    chL[i] = Math.tanh(chL[i] * 0.92);
    chR[i] = Math.tanh(chR[i] * 0.92);
  }

  return encodePcmToWavBytes([chL, chR], sampleRate);
}

export class ScoreSynth {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.activeVoices = new Map();
    this.lastCursorSec = -1;
  }

  _ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.28;
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * Triggers a single warm polyphonic piano-like note for auditioning.
   * @param {number} midiPitch - MIDI pitch in [21, 108].
   * @param {number} [durationSec=0.45] - Note duration in seconds.
   * @param {number} [velocity=80] - MIDI velocity in [1, 127].
   */
  triggerNote(midiPitch, durationSec = 0.45, velocity = 80) {
    const ctx = this._ensureContext();
    if (!ctx || !this.masterGain) return;

    const pitch = Math.max(21, Math.min(108, Math.round(Number(midiPitch) || 60)));
    const dur = Math.max(0.06, Math.min(4.0, Number(durationSec) || 0.45));
    const amp = Math.max(0.05, Math.min(1.0, (Number(velocity) || 80) / 127)) * 0.35;
    const freq = 440 * Math.pow(2, (pitch - 69) / 12);
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(freq, now);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(freq * 2, now);

    const osc2Gain = ctx.createGain();
    osc2Gain.gain.value = 0.22;

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(8000, freq * 6), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(400, freq * 2.2), now + dur);

    env.gain.setValueAtTime(0.0001, now);
    env.gain.linearRampToValueAtTime(amp, now + 0.012);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0008, amp * 0.38), now + dur * 0.65);
    env.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.08);

    osc1.connect(filter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(filter);
    filter.connect(env);
    env.connect(this.masterGain);

    osc1.start(now);
    osc2.start(now);
    const stopTime = now + dur + 0.1;
    osc1.stop(stopTime);
    osc2.stop(stopTime);

    const voiceId = `${midiPitch}_${Math.random()}`;
    this.activeVoices.set(voiceId, { osc1, osc2 });
    osc1.onended = () => {
      this.activeVoices.delete(voiceId);
      try {
        osc1.disconnect();
        osc2.disconnect();
        osc2Gain.disconnect();
        filter.disconnect();
        env.disconnect();
      } catch {
        // Ignore cleanup errors
      }
    };
  }

  /**
   * Synchronizes MIDI synth playback with the active song clock without double-triggering notes.
   * @param {number} prevSec - Previous clock timestamp.
   * @param {number} curSec - Current clock timestamp.
   * @param {object[]} notes - Quantized or canonical active notes.
   */
  syncClockStep(prevSec, curSec, notes = []) {
    if (!Array.isArray(notes) || !notes.length) return;
    if (curSec <= prevSec || curSec - prevSec > 0.35) {
      this.lastCursorSec = curSec;
      return;
    }
    for (const n of notes) {
      const start = Number(n.startSec);
      if (start > prevSec && start <= curSec) {
        const dur = Math.min(2.2, Math.max(0.08, Number(n.endSec) - start));
        this.triggerNote(n.pitch, dur, n.velocity || 78);
      }
    }
    this.lastCursorSec = curSec;
  }

  stopAll() {
    for (const v of this.activeVoices.values()) {
      try {
        v.osc1.stop();
        v.osc2.stop();
      } catch {
        // Ignore already stopped oscillators
      }
    }
    this.activeVoices.clear();
    this.lastCursorSec = -1;
  }
}
