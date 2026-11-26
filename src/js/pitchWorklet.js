/**
 * @fileoverview VANTA Offline Real-Time Pitch Shifter AudioWorkletProcessor.
 * Uses dual crossfaded fractional delay taps over a circular buffer to transpose pitch
 * in semitones (-6 to +6) without altering playback tempo. Passes bit-exact audio when 0 st.
 */

class VantaPitchShifterProcessor extends AudioWorkletProcessor {
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
    this.bufSize = 4096;
    this.mask = this.bufSize - 1;
    this.windowSamples = 1536;
    this.buffers = [];
    this.writeIndex = 0;
    this.phase = 0;
  }

  _ensureChannelBuffers(count) {
    while (this.buffers.length < count) {
      this.buffers.push(new Float32Array(this.bufSize));
    }
  }

  _readLinear(buf, delaySamples) {
    const pos = this.writeIndex - delaySamples;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const idx0 = ((i0 % this.bufSize) + this.bufSize) % this.bufSize;
    const idx1 = (idx0 + 1) & this.mask;
    return buf[idx0] + (buf[idx1] - buf[idx0]) * frac;
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
      const wA = 1 - Math.abs(2 * phA - 1);
      const wB = 1 - wA;

      for (let ch = 0; ch < chCount; ch++) {
        const buf = this.buffers[ch];
        const a = this._readLinear(buf, delayA);
        const b = this._readLinear(buf, delayB);
        output[ch][i] = a * wA + b * wB;
      }

      this.writeIndex++;
      this.phase = (this.phase + phaseStep) % 1;
      if (this.phase < 0) this.phase += 1;
    }

    return true;
  }
}

registerProcessor('vanta-pitch-shifter', VantaPitchShifterProcessor);
