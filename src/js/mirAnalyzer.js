/**
 * @fileoverview VANTA Music Information Retrieval (MIR) & Song DNA Engine (Pillar A).
 * Performs PCM onset BPM estimation, Camelot Wheel harmonic key mapping, spectral energy scoring,
 * and multimodal Song DNA embedding vector generation.
 */

export const CAMELOT_KEY_MAP = {
  'A min': { code: '8A', angle: 0.66 },
  'E min': { code: '9A', angle: 0.75 },
  'B min': { code: '10A', angle: 0.83 },
  'F# min': { code: '11A', angle: 0.91 },
  'C# min': { code: '12A', angle: 1.0 },
  'G# min': { code: '1A', angle: 0.08 },
  'D# min': { code: '2A', angle: 0.16 },
  'A# min': { code: '3A', angle: 0.25 },
  'F min': { code: '4A', angle: 0.33 },
  'C min': { code: '5A', angle: 0.41 },
  'G min': { code: '6A', angle: 0.5 },
  'D min': { code: '7A', angle: 0.58 }
};

/**
 * Estimates tempo in Beats Per Minute (BPM) from a mono Float32Array PCM audio buffer
 * using energy envelope onset detection and interval histogramming.
 * @param {Float32Array|number[]} pcmSamples - Mono PCM sample array in [-1, 1].
 * @param {number} [sampleRate=44100] - Audio sample rate in Hz.
 * @returns {number} Estimated BPM rounded to integer in [75, 165].
 */
export function estimateBpmFromPcm(pcmSamples, sampleRate = 44100) {
  if (!pcmSamples || pcmSamples.length < sampleRate * 2) {
    return 124;
  }

  const windowSize = Math.max(50, Math.floor(sampleRate * 0.01)); // 10ms high-precision energy window
  const energies = [];
  for (let i = 0; i + windowSize <= pcmSamples.length; i += windowSize) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const s = pcmSamples[i + j];
      sum += s * s;
    }
    energies.push(Math.sqrt(sum / windowSize));
  }

  const meanEnergy = energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length);
  const threshold = meanEnergy * 1.35;

  const windowDurationSec = windowSize / sampleRate;
  const peakIndices = [];
  const minPeakDistance = Math.max(2, Math.floor(0.28 / windowDurationSec)); // Minimum ~280ms between beats (~214 BPM max)
  let lastPeak = -minPeakDistance;

  for (let i = 1; i < energies.length - 1; i++) {
    if (
      energies[i] > threshold &&
      energies[i] >= energies[i - 1] &&
      energies[i] >= energies[i + 1] &&
      i - lastPeak >= minPeakDistance
    ) {
      peakIndices.push(i);
      lastPeak = i;
    }
  }

  if (peakIndices.length < 4) {
    return 124;
  }

  const bpmHistogram = new Map();

  for (let i = 1; i < peakIndices.length; i++) {
    const deltaWindows = peakIndices[i] - peakIndices[i - 1];
    const deltaSec = deltaWindows * windowDurationSec;
    if (deltaSec <= 0) continue;
    let candidateBpm = 60 / deltaSec;
    while (candidateBpm < 75) candidateBpm *= 2;
    while (candidateBpm > 165) candidateBpm /= 2;
    const rounded = Math.round(candidateBpm);
    bpmHistogram.set(rounded, (bpmHistogram.get(rounded) || 0) + 1);
  }

  let bestBpm = 124;
  let maxCount = -1;
  for (const [bpm, count] of bpmHistogram.entries()) {
    if (count > maxCount) {
      maxCount = count;
      bestBpm = bpm;
    }
  }

  return bestBpm;
}

/**
 * Checks whether two musical keys are harmonically compatible on the Camelot Wheel.
 * @param {string} keyA - First musical key (e.g., 'A min').
 * @param {string} keyB - Second musical key (e.g., 'E min').
 * @returns {{ compatible: boolean, camelotA: string, camelotB: string, distance: number }}
 */
export function evaluateHarmonicCompatibility(keyA, keyB) {
  const entryA = CAMELOT_KEY_MAP[keyA] || CAMELOT_KEY_MAP['A min'];
  const entryB = CAMELOT_KEY_MAP[keyB] || CAMELOT_KEY_MAP['A min'];
  const numA = parseInt(entryA.code, 10);
  const numB = parseInt(entryB.code, 10);
  const rawDiff = Math.abs(numA - numB);
  const circularDistance = Math.min(rawDiff, 12 - rawDiff);

  return {
    compatible: circularDistance <= 1,
    camelotA: entryA.code,
    camelotB: entryB.code,
    distance: circularDistance
  };
}

/**
 * Computes a 6-dimensional Song DNA vector and semantic mood tags for a track.
 * @param {object} track - Catalog track object.
 * @returns {{ vector: number[], camelotCode: string, chips: string[], danceability: number }}
 */
export function computeSongDna(track = {}) {
  const bpm = Math.max(70, Math.min(180, Number(track.bpm) || 124));
  const energy = Math.max(20, Math.min(100, Number(track.energy) || 84));
  const keyInfo = CAMELOT_KEY_MAP[track.key] || CAMELOT_KEY_MAP['A min'];

  const textMeta = `${track.title || ''} ${track.artist || ''} ${track.genre || ''} ${track.mood || ''}`.toLowerCase();

  const normBpm = (bpm - 70) / 110;
  const normEnergy = energy / 100;
  const bassDensity = /phonk|bass|synth|electro|club|sub/.test(textMeta) ? 0.88 : 0.64;
  const vocalPresence = /ambient|instrumental|lo-fi|focus/.test(textMeta) ? 0.32 : 0.76;
  const melancholicScore = /melancholic|rain|night|obsidian|dark|minor|min/.test(textMeta) ? 0.85 : 0.48;
  const danceability = Math.round(Math.min(99, (normBpm * 0.45 + normEnergy * 0.55) * 100));

  const chips = [];
  if (melancholicScore > 0.7) chips.push('Melancholic');
  if (bpm >= 118 && bpm <= 135) chips.push('Night Drive');
  if (bassDensity > 0.8) chips.push('Analog Synth');
  if (energy >= 88) chips.push('High Energy');
  if (vocalPresence < 0.45) chips.push('Low Vocal');
  if (danceability >= 72) chips.push('Danceable');

  return {
    vector: [
      Number(normBpm.toFixed(3)),
      Number(normEnergy.toFixed(3)),
      bassDensity,
      vocalPresence,
      melancholicScore,
      keyInfo.angle
    ],
    camelotCode: keyInfo.code,
    chips: chips.slice(0, 5),
    danceability
  };
}
