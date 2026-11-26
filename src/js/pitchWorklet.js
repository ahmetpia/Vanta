/**
 * @fileoverview VANTA Offline Real-Time Pitch Shifter AudioWorkletProcessor.
 * Uses dual crossfaded fractional delay taps over a circular buffer with 4-point Hermite
 * cubic interpolation and complementary Hann windows to transpose pitch in semitones
 * (-12 to +12) without altering playback tempo. Passes bit-exact audio when 0 st.
 */

export function hermiteInterpolate4(ym1, y0, y1, y2, frac) {
  const c0 = y0;
  const c1 = 0.5 * (y1 - ym1);
  const c2 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
  const c3 = 0.5 * (y2 - ym1) + 1.5 * (y0 - y1);
  return ((c3 * frac + c2) * frac + c1) * frac + c0;
}

export function hannWindowFromPhase(phase) {
  return 0.5 * (1.0 - Math.cos(2.0 * Math.PI * phase));
}

const BaseAudioWorkletProcessor = typeof AudioWorkletProcessor !== 'undefined'
  ? AudioWorkletProcessor
  : class {};

class VantaPitchShifterProcessor extends BaseAudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'semitones',
        defaultValue: 0,
        minValue: -12,
        maxValue: 12,
        automationRate: 'k-rate'
      }
    ];
  }

  constructor() {
    super();
    this.bufSize = 8192;
    this.mask = this.bufSize - 1;
    this.windowSamples = 2048;
    this.buffers = [];
    this.writeIndex = 0;
    this.phase = 0;
  }

  _ensureChannelBuffers(count) {
    while (this.buffers.length < count) {
      this.buffers.push(new Float32Array(this.bufSize));
    }
  }

  _readHermite(buf, delaySamples) {
    const pos = this.writeIndex - delaySamples;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const size = this.bufSize;
    const mask = this.mask;
    const base = ((i0 % size) + size) % size;
    const im1 = (base - 1 + size) & mask;
    const idx0 = base;
    const idx1 = (base + 1) & mask;
    const idx2 = (base + 2) & mask;
    return hermiteInterpolate4(buf[im1], buf[idx0], buf[idx1], buf[idx2], frac);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    if (!input || input.length === 0) {
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
      return true;
    }

    const semitones = parameters.semitones ? parameters.semitones[0] : 0;
    const chCount = Math.min(input.length, output.length);
    this._ensureChannelBuffers(chCount);
    const frameCount = output[0].length;
    const isBypass = Math.abs(semitones) < 0.02;

    if (isBypass) {
      for (let i = 0; i < frameCount; i++) {
        const wIdx = this.writeIndex & this.mask;
        for (let ch = 0; ch < chCount; ch++) {
          const s = input[ch][i] || 0;
          this.buffers[ch][wIdx] = s;
          output[ch][i] = s;
        }
        this.writeIndex++;
      }
      return true;
    }

    const pitchRatio = Math.pow(2, semitones / 12);
    const phaseStep = (1 - pitchRatio) / this.windowSamples;

    for (let i = 0; i < frameCount; i++) {
      const wIdx = this.writeIndex & this.mask;
      for (let ch = 0; ch < chCount; ch++) {
        this.buffers[ch][wIdx] = input[ch][i] || 0;
      }

      let phA = this.phase;
      phA = phA - Math.floor(phA);
      let phB = phA + 0.5;
      if (phB >= 1) phB -= 1;

      const delayA = 64 + phA * this.windowSamples;
      const delayB = 64 + phB * this.windowSamples;
      const wA = hannWindowFromPhase(phA);
      const wB = hannWindowFromPhase(phB);

      for (let ch = 0; ch < chCount; ch++) {
        const buf = this.buffers[ch];
        const a = this._readHermite(buf, delayA);
        const b = this._readHermite(buf, delayB);
        output[ch][i] = a * wA + b * wB;
      }

      this.writeIndex++;
      this.phase = (this.phase + phaseStep) % 1;
      if (this.phase < 0) this.phase += 1;
    }

    return true;
  }
}

if (typeof registerProcessor === 'function') {
  registerProcessor('vanta-pitch-shifter', VantaPitchShifterProcessor);
}
