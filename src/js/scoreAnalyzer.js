/**
 * @fileoverview VANTA Musical Intelligence Core (Phase 9.2).
 * Deterministic pure-JS engine for:
 * - Harmonic/overtone ghost-note annotation & re-articulation merging
 * - Extended [40, 220] BPM tempo & compound/simple meter (4/4, 3/4, 6/8, 12/8) detection
 * - 24-Key Krumhansl-Schmuckler detection & Viterbi HMM chord symbol extraction
 * - Beat-grid quantization with measure splitting & ties
 * - Dynamic-Programming Grand Staff (Treble / Bass) hand separation
 */

export const PPQ = 480;

export const PITCH_CLASS_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const PITCH_CLASS_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Krumhansl-Schmuckler key profiles
const MAJOR_KEY_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_KEY_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const KEY_SPECS = [
  // Major keys (0..11)
  { tonic: 0, mode: 'major', label: 'C maj', vexKey: 'C', fifths: 0, preferFlats: false },
  { tonic: 1, mode: 'major', label: 'Db maj', vexKey: 'Db', fifths: -5, preferFlats: true },
  { tonic: 2, mode: 'major', label: 'D maj', vexKey: 'D', fifths: 2, preferFlats: false },
  { tonic: 3, mode: 'major', label: 'Eb maj', vexKey: 'Eb', fifths: -3, preferFlats: true },
  { tonic: 4, mode: 'major', label: 'E maj', vexKey: 'E', fifths: 4, preferFlats: false },
  { tonic: 5, mode: 'major', label: 'F maj', vexKey: 'F', fifths: -1, preferFlats: true },
  { tonic: 6, mode: 'major', label: 'F# maj', vexKey: 'F#', fifths: 6, preferFlats: false },
  { tonic: 7, mode: 'major', label: 'G maj', vexKey: 'G', fifths: 1, preferFlats: false },
  { tonic: 8, mode: 'major', label: 'Ab maj', vexKey: 'Ab', fifths: -4, preferFlats: true },
  { tonic: 9, mode: 'major', label: 'A maj', vexKey: 'A', fifths: 3, preferFlats: false },
  { tonic: 10, mode: 'major', label: 'Bb maj', vexKey: 'Bb', fifths: -2, preferFlats: true },
  { tonic: 11, mode: 'major', label: 'B maj', vexKey: 'B', fifths: 5, preferFlats: false },
  // Minor keys (0..11)
  { tonic: 0, mode: 'minor', label: 'C min', vexKey: 'Cm', fifths: -3, preferFlats: true },
  { tonic: 1, mode: 'minor', label: 'C# min', vexKey: 'C#m', fifths: 4, preferFlats: false },
  { tonic: 2, mode: 'minor', label: 'D min', vexKey: 'Dm', fifths: -1, preferFlats: true },
  { tonic: 3, mode: 'minor', label: 'Eb min', vexKey: 'Ebm', fifths: -6, preferFlats: true },
  { tonic: 4, mode: 'minor', label: 'E min', vexKey: 'Em', fifths: 1, preferFlats: false },
  { tonic: 5, mode: 'minor', label: 'F min', vexKey: 'Fm', fifths: -4, preferFlats: true },
  { tonic: 6, mode: 'minor', label: 'F# min', vexKey: 'F#m', fifths: 3, preferFlats: false },
  { tonic: 7, mode: 'minor', label: 'G min', vexKey: 'Gm', fifths: -2, preferFlats: true },
  { tonic: 8, mode: 'minor', label: 'G# min', vexKey: 'G#m', fifths: 5, preferFlats: false },
  { tonic: 9, mode: 'minor', label: 'A min', vexKey: 'Am', fifths: 0, preferFlats: false },
  { tonic: 10, mode: 'minor', label: 'Bb min', vexKey: 'Bbm', fifths: -5, preferFlats: true },
  { tonic: 11, mode: 'minor', label: 'B min', vexKey: 'Bm', fifths: 2, preferFlats: false }
];

const CHORD_QUALITIES = [
  { id: 'maj', suffix: '', intervals: [0, 4, 7], penalty: 0.0 },
  { id: 'min', suffix: 'm', intervals: [0, 3, 7], penalty: 0.02 },
  { id: '7', suffix: '7', intervals: [0, 4, 7, 10], penalty: 0.09 },
  { id: 'maj7', suffix: 'maj7', intervals: [0, 4, 7, 11], penalty: 0.11 },
  { id: 'm7', suffix: 'm7', intervals: [0, 3, 7, 10], penalty: 0.09 },
  { id: 'sus4', suffix: 'sus4', intervals: [0, 5, 7], penalty: 0.14 },
  { id: 'dim', suffix: 'dim', intervals: [0, 3, 6], penalty: 0.16 }
];

const OVERTONE_SEMITONES = new Map([
  [12, { label: 'octave', baseRatio: 0.58 }],
  [19, { label: 'twelfth', baseRatio: 0.45 }],
  [24, { label: 'double-octave', baseRatio: 0.40 }],
  [28, { label: '5th-harmonic', baseRatio: 0.34 }]
]);

const STANDARD_DURATIONS_TICKS = [
  { ticks: 1920, type: 'whole', vf: 'w', dots: 0 },
  { ticks: 1440, type: 'half', vf: 'h', dots: 1 },
  { ticks: 960, type: 'half', vf: 'h', dots: 0 },
  { ticks: 720, type: 'quarter', vf: 'q', dots: 1 },
  { ticks: 480, type: 'quarter', vf: 'q', dots: 0 },
  { ticks: 360, type: 'eighth', vf: '8', dots: 1 },
  { ticks: 240, type: 'eighth', vf: '8', dots: 0 },
  { ticks: 180, type: '16th', vf: '16', dots: 1 },
  { ticks: 120, type: '16th', vf: '16', dots: 0 },
  { ticks: 60, type: '32nd', vf: '32', dots: 0 }
];

/**
 * Converts MIDI pitch integer (21..108) to readable note name.
 * @param {number} midi - MIDI pitch number.
 * @param {boolean} [preferFlats=false] - Use flat spelling instead of sharp.
 * @returns {string}
 */
export function midiToNoteName(midi, preferFlats = false) {
  const m = Math.max(0, Math.min(127, Math.round(Number(midi) || 60)));
  const pc = m % 12;
  const oct = Math.floor(m / 12) - 1;
  const names = preferFlats ? PITCH_CLASS_FLAT : PITCH_CLASS_SHARP;
  return `${names[pc]}${oct}`;
}

/**
 * Converts MIDI pitch integer to VexFlow key string (`c#/4`, `bb/3`).
 * @param {number} midi - MIDI pitch number.
 * @param {boolean} [preferFlats=false] - Prefer flat accidental.
 * @returns {string}
 */
export function midiToVexKey(midi, preferFlats = false) {
  const m = Math.max(0, Math.min(127, Math.round(Number(midi) || 60)));
  const pc = m % 12;
  const oct = Math.floor(m / 12) - 1;
  const names = preferFlats ? PITCH_CLASS_FLAT : PITCH_CLASS_SHARP;
  return `${names[pc].toLowerCase()}/${oct}`;
}

/**
 * Normalizes raw note arrays from basic-pitch-rs or external providers into canonical VANTA Note objects.
 * @param {object[]} rawNotes - Provider note array.
 * @param {object} [options={}] - Normalization options.
 * @returns {object[]} Canonical sorted note events.
 */
export function normalizeRawNotes(rawNotes = [], options = {}) {
  const offsetSec = Number(options.timeOffsetSec) || 0;
  const transpose = Math.round(Number(options.transposeSemitones) || 0);
  const out = [];

  for (let i = 0; i < rawNotes.length; i++) {
    const raw = rawNotes[i];
    if (!raw || typeof raw !== 'object') continue;
    const rawStart = Number(raw.start_s ?? raw.startSec ?? raw.start ?? 0) - offsetSec;
    const rawEnd = Number(raw.end_s ?? raw.endSec ?? raw.end ?? rawStart + 0.1) - offsetSec;
    const startSec = Math.max(0, rawStart);
    const endSec = Math.max(startSec + 0.03, rawEnd);
    const basePitch = Math.round(Number(raw.pitch ?? raw.midi ?? 60));
    const pitch = basePitch + transpose;
    if (pitch < 21 || pitch > 108) continue;

    const amplitude = Number.isFinite(Number(raw.amplitude))
      ? Math.max(0.01, Math.min(1, Number(raw.amplitude)))
      : Math.max(0.01, Math.min(1, (Number(raw.velocity) || 72) / 127));
    const velocity = Number.isFinite(Number(raw.velocity))
      ? Math.max(1, Math.min(127, Math.round(Number(raw.velocity))))
      : Math.max(1, Math.min(127, Math.round(amplitude * 127)));

    out.push({
      id: `n_${i}`,
      pitch,
      startSec,
      endSec,
      durationSec: endSec - startSec,
      amplitude,
      velocity,
      stem: String(raw.stem || 'mix'),
      pitchBends: Array.isArray(raw.pitch_bends_semitones) ? raw.pitch_bends_semitones : null
    });
  }

  out.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);
  return out.map((n, idx) => ({ ...n, id: `n_${idx}` }));
}

/**
 * Merges fragmented same-pitch re-articulations and tags likely harmonic ghost overtones
 * without destroying raw note data (enabling instant non-destructive UI slider filtering).
 * @param {object[]} canonicalNotes - Normalized canonical notes.
 * @param {object} [options={}] - Filtering & cleanup parameters.
 * @returns {{ annotated: object[], active: object[], stats: object }}
 */
export function annotateAndCleanNotes(canonicalNotes = [], options = {}) {
  const minConfidence = Math.max(0, Math.min(0.95, Number(options.minConfidence ?? 0.32)));
  const minDurationSec = Math.max(0.02, Math.min(0.5, Number(options.minDurationSec ?? 0.06)));
  const minPitch = Math.max(21, Math.min(108, Math.round(Number(options.minPitch ?? 21))));
  const maxPitch = Math.max(minPitch, Math.min(108, Math.round(Number(options.maxPitch ?? 108))));
  const harmonicFilterStrength = Math.max(0, Math.min(1, Number(options.harmonicFilterStrength ?? 0.65)));
  const mergeGapSec = Math.max(0, Math.min(0.12, Number(options.mergeGapSec ?? 0.04)));

  // Step 1: Merge tiny gaps between decaying identical pitches (never swallow fresh louder re-strikes)
  const sorted = [...canonicalNotes].sort((a, b) => a.pitch - b.pitch || a.startSec - b.startSec);
  const merged = [];
  for (const note of sorted) {
    const prev = merged[merged.length - 1];
    const isGlitchTail =
      prev &&
      prev.pitch === note.pitch &&
      prev.stem === note.stem &&
      note.startSec - prev.endSec <= mergeGapSec &&
      note.amplitude <= prev.amplitude * (prev.durationSec > 0.45 ? 1.02 : 1.15);
    if (isGlitchTail) {
      prev.endSec = Math.max(prev.endSec, note.endSec);
      prev.durationSec = prev.endSec - prev.startSec;
      prev.amplitude = Math.max(prev.amplitude, note.amplitude);
      prev.velocity = Math.max(prev.velocity, note.velocity);
      prev.mergedCount = (prev.mergedCount || 1) + 1;
    } else {
      merged.push({ ...note, mergedCount: 1 });
    }
  }

  merged.sort((a, b) => a.startSec - b.startSec || a.pitch - b.pitch);

  // Step 2: Tag harmonic ghosts (attack-coupled partials + ultra-faint sustain bleed)
  let overtoneCount = 0;
  let lowConfCount = 0;
  let rangeFilteredCount = 0;

  const annotated = merged.map((hi, idx) => {
    let isLikelyOvertone = false;
    let overtoneOfPitch = null;
    let overtoneReason = '';

    if (harmonicFilterStrength > 0) {
      const checkCandidate = (lo) => {
        const diff = hi.pitch - lo.pitch;
        const spec = OVERTONE_SEMITONES.get(diff);
        if (!spec) return false;
        if (lo.stem !== 'mix' && hi.stem !== 'mix' && lo.stem !== hi.stem) return false;

        const onsetDiff = Math.abs(hi.startSec - lo.startSec);
        const onsetClose = onsetDiff <= 0.085;
        if (onsetClose) {
          const maxAllowedRatio = spec.baseRatio + harmonicFilterStrength * 0.42;
          if (hi.amplitude <= lo.amplitude * maxAllowedRatio && hi.endSec <= lo.endSec + 0.25) {
            isLikelyOvertone = true;
            overtoneOfPitch = lo.pitch;
            overtoneReason = spec.label;
            return true;
          }
          return false;
        }

        // Delayed strikes inside a bass sustain tail are only ghosts if extremely faint sympathetic bleed
        const insideSustain = lo.startSec < hi.startSec && hi.endSec <= lo.endSec + 0.12;
        if (insideSustain) {
          const bleedCap = Math.min(0.24, lo.amplitude * (0.14 + harmonicFilterStrength * 0.14));
          if (hi.amplitude <= bleedCap) {
            isLikelyOvertone = true;
            overtoneOfPitch = lo.pitch;
            overtoneReason = `${spec.label}-bleed`;
            return true;
          }
        }
        return false;
      };

      for (let j = idx - 1; j >= 0; j--) {
        const lo = merged[j];
        if (hi.startSec - lo.startSec > 3.0) break;
        if (hi.startSec - lo.startSec > 0.085 && lo.endSec < hi.startSec - 0.05) continue;
        if (checkCandidate(lo)) break;
      }
      // Also inspect slightly later entries within +/-85ms co-onset jitter window
      if (!isLikelyOvertone) {
        for (let j = idx + 1; j < merged.length; j++) {
          const lo = merged[j];
          if (lo.startSec - hi.startSec > 0.085) break;
          if (checkCandidate(lo)) break;
        }
      }
    }

    const belowConf = hi.amplitude < minConfidence;
    const tooShort = hi.durationSec < minDurationSec;
    const outOfRange = hi.pitch < minPitch || hi.pitch > maxPitch;

    if (isLikelyOvertone) overtoneCount++;
    if (belowConf || tooShort) lowConfCount++;
    if (outOfRange) rangeFilteredCount++;

    const visible = !isLikelyOvertone && !belowConf && !tooShort && !outOfRange;
    return {
      ...hi,
      isLikelyOvertone,
      overtoneOfPitch,
      overtoneReason,
      visible
    };
  });

  const active = annotated.filter((n) => n.visible);
  return {
    annotated,
    active,
    stats: {
      rawCount: canonicalNotes.length,
      mergedCount: merged.length,
      activeCount: active.length,
      overtoneCount,
      lowConfCount,
      rangeFilteredCount
    }
  };
}

/**
 * Evaluates a candidate BPM & meter using local rubato-tolerant beat chunks
 * and bass-root bar-cycle alignment.
 * @param {object[]} notes - Active canonical notes.
 * @param {number} bpm - Candidate BPM.
 * @param {{ num: number, den: number }} meter - Candidate meter.
 * @returns {{ score: number, firstBarPhase: number }} Fitness score and opening downbeat phase.
 */
function scoreTempoMeterCandidate(notes, bpm, meter) {
  if (!notes.length) return { score: 0, firstBarPhase: 0 };
  const isCompound = meter.den === 8 && meter.num % 3 === 0;
  const beatSec = 60 / bpm; // Quarter note for simple meters, dotted-quarter for 6/8 & 12/8
  const subDivSec = isCompound ? beatSec / 3 : beatSec / 2; // Eighth-note grid
  const barSec = isCompound ? beatSec * (meter.num / 3) : beatSec * meter.num;

  const firstT = notes[0].startSec;
  const lastT = notes[notes.length - 1].startSec;
  const totalDur = Math.max(barSec, lastT - firstT);
  const windowDur = 26;
  const maxChunks = Math.min(4, Math.max(1, Math.ceil(totalDur / windowDur)));
  const chunkStep = maxChunks > 1 ? Math.max(barSec, (totalDur - windowDur) / (maxChunks - 1)) : 0;

  let accumFitness = 0;
  let accumTriple = 0;
  let accumDuple = 0;
  let totalWeightCount = 0;
  let firstBarPhase = firstT % barSec;

  for (let c = 0; c < maxChunks; c++) {
    const winStart = maxChunks === 1 ? firstT : firstT + c * chunkStep;
    const winEnd = winStart + windowDur;
    const chunkNotes = maxChunks === 1
      ? notes
      : notes.filter((n) => n.startSec >= winStart && n.startSec <= winEnd);
    if (!chunkNotes.length) continue;

    // Find local best subdivision phase in [0, subDivSec)
    let bestSnap = -Infinity;
    let bestPhase = 0;
    for (let p = 0; p < 12; p++) {
      const phase = (p / 12) * subDivSec;
      let snapScore = 0;
      for (let i = 0; i < chunkNotes.length; i++) {
        const n = chunkNotes[i];
        const t = Math.max(0, n.startSec - phase);
        const pos = t / subDivSec;
        const err = Math.abs(pos - Math.round(pos));
        const weight = n.amplitude * (n.pitch < 55 ? 1.35 : 1.0);
        snapScore += weight * Math.exp(-err * err * 28);
      }
      if (snapScore > bestSnap) {
        bestSnap = snapScore;
        bestPhase = phase;
      }
    }

    // Find local bar downbeat phase modulo barSec
    const stepsPerBar = isCompound ? meter.num : meter.num * 2;
    const stepAccents = new Array(stepsPerBar).fill(0);
    let downbeatWeight = 0;
    let downbeatStepIdx = 0;
    let barPhase = bestPhase;
    for (let b = 0; b < stepsPerBar; b++) {
      const candPhase = bestPhase + b * subDivSec;
      let barAccent = 0;
      for (const n of chunkNotes) {
        const rel = ((n.startSec - candPhase) % barSec + barSec) % barSec;
        if (rel < subDivSec * 0.45 || barSec - rel < subDivSec * 0.45) {
          barAccent += n.amplitude * (n.pitch < 55 ? 1.9 : 1.0);
        }
      }
      stepAccents[b] = barAccent;
      if (barAccent > downbeatWeight) {
        downbeatWeight = barAccent;
        downbeatStepIdx = b;
        barPhase = ((candPhase % barSec) + barSec) % barSec;
      }
    }
    if (c === 0) firstBarPhase = barPhase;

    // Bass root transition & bar-phase alignment inside this local phrase
    const bassEvents = [];
    let prevPc = -1;
    let prevTime = -10;
    for (const n of chunkNotes) {
      if (n.pitch >= 55 || n.amplitude < 0.32) continue;
      const pc = n.pitch % 12;
      if (pc !== prevPc || n.startSec - prevTime >= Math.min(barSec, 1.2) * 0.72) {
        bassEvents.push({ time: n.startSec, pc, weight: n.amplitude });
        prevPc = pc;
        prevTime = n.startSec;
      }
    }
    let bassBarAlign = 0;
    if (bassEvents.length >= 3) {
      let cycleHits = 0;
      const stepBassCounts = new Array(stepsPerBar).fill(0);
      for (let i = 0; i < bassEvents.length; i++) {
        const cur = bassEvents[i];
        const relStep = Math.round((((cur.time - barPhase) % barSec + barSec) % barSec) / subDivSec) % stepsPerBar;
        stepBassCounts[relStep] += cur.weight;
        let matched = 0;
        for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
          const prev = bassEvents[k];
          const dt = cur.time - prev.time;
          if (dt > barSec * 2.25) break;
          if (dt < barSec * 0.75) continue;
          const barsSpanned = dt / barSec;
          const roundedBars = Math.round(barsSpanned);
          const err = Math.abs(barsSpanned - roundedBars);
          if (err < 0.15 && roundedBars === 1) {
            // Prefer recurring same-pitch root or downbeat-aligned bass cycle over mid-bar passing tones
            const w = cur.pc === prev.pc ? 1.0 : (relStep === 0 ? 0.75 : 0.28);
            if (w > matched) matched = w;
          } else if (err < 0.15 && roundedBars === 2 && cur.pc === prev.pc) {
            if (0.45 > matched) matched = 0.45;
          }
        }
        cycleHits += matched;
      }
      const totalBassW = stepBassCounts.reduce((a, b) => a + b, 0);
      const phaseLock = totalBassW > 0
        ? Math.max(0, (stepBassCounts[0] / totalBassW) - (1 / Math.max(2, isCompound ? 2 : meter.num)))
        : 0;
      const halfBarBassFold = meter.num === 12 && meter.den === 8 && stepBassCounts[0] > 0 && stepBassCounts[6] >= stepBassCounts[0] * 0.65 ? 0.45 : 1.0;
      const cycleRate = cycleHits / Math.max(1, bassEvents.length - 1);
      bassBarAlign = Math.min(0.22, (cycleRate * 0.16 + phaseLock * 0.18) * halfBarBassFold);
    }

    for (const n of chunkNotes) {
      const t = Math.max(0, n.startSec - barPhase);
      const eightIdx = Math.round(t / subDivSec);
      const w = n.amplitude * (n.pitch < 58 ? 1.4 : 1.0);
      if (eightIdx % 3 === 0) accumTriple += w;
      if (eightIdx % 2 === 0) accumDuple += w;
    }

    const meanStepAccent = stepAccents.reduce((a, b) => a + b, 0) / Math.max(1, stepsPerBar);
    const downbeatContrast = Math.min(2.6, downbeatWeight / Math.max(1e-3, meanStepAccent));
    const halfBarRatio = meter.num === 12 && meter.den === 8
      ? stepAccents[(downbeatStepIdx + 6) % 12] / Math.max(1e-3, downbeatWeight)
      : 0;
    const contrastScale = meter.num === 12 && meter.den === 8
      ? Math.max(0.25, 1 - halfBarRatio * 0.85)
      : 1;
    const downbeatFactor = 1 + Math.max(0, downbeatContrast - 1) * 0.15 * contrastScale;
    accumFitness += bestSnap * downbeatFactor * (1 + bassBarAlign);
    totalWeightCount += chunkNotes.length;
  }

  // Symmetric slot-density normalized meter affinity: 6/8 & 12/8 accent every 3rd eighth (2/6 slots) vs 2nd eighth (3/6 slots)
  const triplePerSlot = accumTriple / 2;
  const duplePerSlot = accumDuple / 3;
  const meterRatio = isCompound
    ? triplePerSlot / Math.max(1e-3, duplePerSlot)
    : duplePerSlot / Math.max(1e-3, triplePerSlot);
  const meterBias = isCompound
    ? (bpm >= 52 && bpm <= 90 && meterRatio > 1.06 ? Math.min(0.22, (meterRatio - 1.06) * 1.1 + 0.04) : 0)
    : (meterRatio >= 0.98 ? Math.min(0.16, 0.04 + (meterRatio - 0.98) * 0.40) + (meter.num === 4 ? 0.02 : 0) : 0.01);

  // Penalize overly-dense sub-grids
  const totalSpanSec = Math.max(barSec, lastT - firstBarPhase + subDivSec);
  const gridSlotCount = Math.max(1, totalSpanSec / subDivSec);
  const uniqueHitSlots = new Set(
    notes.map((n) => Math.round(Math.max(0, n.startSec - firstBarPhase) / subDivSec))
  ).size;
  const occupancy = Math.min(1, uniqueHitSlots / gridSlotCount);
  const occupancyFactor = 0.68 + 0.32 * Math.sqrt(occupancy);

  // Flat perceptual plateau; compound meters (dotted quarter) cap earlier than simple meters to prevent fast-16th & 2x/3x traps
  const safeBpm = Math.max(40, isCompound && bpm >= 54 && bpm <= 86 ? bpm * 1.4 : bpm);
  const centerDist = Math.log2(safeBpm / 105);
  const compoundMax = isCompound ? 86 : 145;
  const outBand = bpm > compoundMax
    ? Math.log2(bpm / compoundMax)
    : (safeBpm < 58 ? Math.log2(58 / safeBpm) : 0);
  const tempoPrior = Math.exp(-centerDist * centerDist * 0.12 - outBand * outBand * 2.2);
  const baseFitness = accumFitness / Math.max(1, totalWeightCount);
  return {
    score: baseFitness * (1 + meterBias) * occupancyFactor * tempoPrior,
    firstBarPhase
  };
}

/**
 * Estimates BPM in [40, 220] and meter (`4/4`, `3/4`, `6/8`, `12/8`) from note onsets and optional hint.
 * @param {object[]} notes - Active notes.
 * @param {object} [options={}] - Optional overrides or PCM BPM hint.
 * @returns {{ bpm: number, timeSignature: string, num: number, den: number, beatOffsetSec: number, confidence: number }}
 */
export function estimateTempoAndMeter(notes = [], options = {}) {
  const hintBpm = Number(options.bpmHint) || 0;
  const forcedMeter = String(options.timeSignature || '');

  if (!notes.length) {
    const safeBpm = hintBpm >= 40 && hintBpm <= 220 ? Math.round(hintBpm) : 100;
    const [num, den] = (forcedMeter || '4/4').split('/').map(Number);
    return {
      bpm: safeBpm,
      timeSignature: `${num || 4}/${den || 4}`,
      num: num || 4,
      den: den || 4,
      beatOffsetSec: 0,
      confidence: 0.2
    };
  }

  // Cluster near-simultaneous onsets (< 55ms)
  const clusters = [];
  for (const n of notes) {
    const last = clusters[clusters.length - 1];
    if (last && n.startSec - last.time <= 0.055) {
      last.weight = Math.max(last.weight, n.amplitude);
    } else {
      clusters.push({ time: n.startSec, weight: n.amplitude });
    }
  }

  const candidateBpms = new Set();
  if (hintBpm >= 40 && hintBpm <= 220) {
    candidateBpms.add(Math.round(hintBpm));
    if (hintBpm / 2 >= 40) candidateBpms.add(Math.round(hintBpm / 2));
    if (hintBpm * 2 <= 220) candidateBpms.add(Math.round(hintBpm * 2));
  }

  const ioiHist = new Map();
  for (let i = 0; i < clusters.length; i++) {
    for (let j = i + 1; j < Math.min(clusters.length, i + 6); j++) {
      const dt = clusters[j].time - clusters[i].time;
      if (dt < 0.14 || dt > 1.8) continue;
      const rawRate = 60 / dt;
      const w = Math.sqrt(clusters[i].weight * clusters[j].weight);
      for (const mult of [1 / 3, 0.5, 1, 2]) {
        const b = Math.round(rawRate * mult);
        if (b >= 40 && b <= 220) {
          ioiHist.set(b, (ioiHist.get(b) || 0) + w / (mult === 1 ? 1 : 1.3));
        }
      }
    }
  }

  // Add opening bass-change bar-cycle BPM candidates (important for rubato piano without drums)
  const firstNoteSec = notes[0]?.startSec || 0;
  const earlyBass = [];
  let prevEbPc = -1;
  let prevEbT = -10;
  for (const n of notes) {
    if (n.startSec > firstNoteSec + 45) break;
    if (n.pitch < 55 && n.amplitude >= 0.42 && (n.pitch % 12 !== prevEbPc || n.startSec - prevEbT >= 1.3)) {
      earlyBass.push(n.startSec);
      prevEbPc = n.pitch % 12;
      prevEbT = n.startSec;
    }
  }
  for (let i = 1; i < earlyBass.length; i++) {
    const barDt = earlyBass[i] - earlyBass[i - 1];
    if (barDt >= 1.1 && barDt <= 3.6) {
      for (const beatsPerBar of [4, 3, 2]) {
        const cand = Math.round((beatsPerBar * 60) / barDt);
        if (cand >= 40 && cand <= 220) candidateBpms.add(cand);
      }
    }
  }
  // Smooth median bar duration over early bass changes (captures average phrase tempo accurately)
  if (earlyBass.length >= 4) {
    const dts = [];
    for (let i = 1; i < earlyBass.length; i++) {
      const dt = earlyBass[i] - earlyBass[i - 1];
      if (dt >= 1.1 && dt <= 3.4) dts.push(dt);
    }
    if (dts.length >= 3) {
      dts.sort((a, b) => a - b);
      const medDt = dts[Math.floor(dts.length / 2)];
      for (const beatsPerBar of [4, 3, 2]) {
        const cand = Math.round((beatsPerBar * 60) / medDt);
        if (cand >= 40 && cand <= 220) candidateBpms.add(cand);
      }
    }
  }

  const topFromIoi = [...ioiHist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([b]) => b);
  for (const b of topFromIoi) candidateBpms.add(b);
  if (candidateBpms.size === 0) candidateBpms.add(100);

  const meters = forcedMeter
    ? [{ num: Number(forcedMeter.split('/')[0]) || 4, den: Number(forcedMeter.split('/')[1]) || 4 }]
    : [
        { num: 4, den: 4 },
        { num: 3, den: 4 },
        { num: 6, den: 8 },
        { num: 12, den: 8 }
      ];

  let bestScore = -Infinity;
  let bestBpm = 100;
  let bestMeter = meters[0];
  let bestBarPhase = firstNoteSec;

  for (const bpm of candidateBpms) {
    for (const meter of meters) {
      const cand = scoreTempoMeterCandidate(notes, bpm, meter);
      let s = cand.score;
      if (hintBpm >= 40 && hintBpm <= 220 && Math.abs(bpm - hintBpm) <= 3) {
        s *= 1.12;
      }
      if (s > bestScore) {
        bestScore = s;
        bestBpm = bpm;
        bestMeter = meter;
        bestBarPhase = cand.firstBarPhase;
      }
    }
  }

  // Anchor opening downbeat when initial audio contains >0.25s silence (without jumping backwards into silence)
  const isCompound = bestMeter.den === 8 && bestMeter.num % 3 === 0;
  const beatSec = 60 / bestBpm;
  const barSec = isCompound ? beatSec * (bestMeter.num / 3) : beatSec * bestMeter.num;
  let beatOffsetSec = 0;
  if (firstNoteSec >= 0.25) {
    const openingNotes = notes.filter((n) => n.startSec <= firstNoteSec + barSec * 4.5);
    const step = isCompound ? beatSec / 3 : beatSec;
    let bestAnchor = firstNoteSec;
    let bestAnchorScore = -Infinity;
    const anchorCandidates = [firstNoteSec];
    // Test phase candidates starting no earlier than 0.2s before first note (or 1 pickup beat if weak opening)
    const earliestValid = notes[0].pitch < 55 && notes[0].amplitude >= 0.5
      ? firstNoteSec - 0.15
      : Math.max(0, firstNoteSec - step * 1.1);
    for (let k = -2; k <= 3; k++) {
      const p = bestBarPhase + k * barSec;
      if (p >= earliestValid && p <= firstNoteSec + 0.08) anchorCandidates.push(p);
    }
    for (const anchor of anchorCandidates) {
      let sc = 0;
      for (const n of openingNotes) {
        const rel = ((n.startSec - anchor) % barSec + barSec) % barSec;
        const dist = Math.min(rel, barSec - rel);
        if (dist < step * 0.25) {
          sc += n.amplitude * (n.pitch < 55 ? 2.0 : 1.0) * Math.exp(-dist * dist * 40);
        }
      }
      if (sc > bestAnchorScore) {
        bestAnchorScore = sc;
        bestAnchor = anchor;
      }
    }
    beatOffsetSec = Math.min(firstNoteSec, Math.max(0, bestAnchor));
  }

  return {
    bpm: bestBpm,
    timeSignature: `${bestMeter.num}/${bestMeter.den}`,
    num: bestMeter.num,
    den: bestMeter.den,
    beatOffsetSec: Number(beatOffsetSec.toFixed(4)),
    confidence: Number(Math.max(0.25, Math.min(0.99, bestScore)).toFixed(3))
  };
}

/**
 * Detects the musical key (24 major/minor keys) via Krumhansl-Schmuckler pitch-class correlation.
 * @param {object[]} notes - Active canonical notes.
 * @returns {{ tonic: number, mode: string, label: string, vexKey: string, fifths: number, preferFlats: boolean, confidence: number }}
 */
export function detectMusicalKey(notes = []) {
  if (!notes.length) {
    return { ...KEY_SPECS[0], confidence: 0 };
  }

  const hist = new Float64Array(12);
  for (const n of notes) {
    const pc = ((n.pitch % 12) + 12) % 12;
    const bassBoost = n.pitch < 55 ? 1.35 : 1.0;
    hist[pc] += n.durationSec * n.amplitude * bassBoost;
  }

  let meanH = 0;
  for (let i = 0; i < 12; i++) meanH += hist[i];
  meanH /= 12;

  let bestCorr = -Infinity;
  let secondCorr = -Infinity;
  let bestSpec = KEY_SPECS[0];

  for (const spec of KEY_SPECS) {
    const profile = spec.mode === 'major' ? MAJOR_KEY_PROFILE : MINOR_KEY_PROFILE;
    let meanP = 0;
    for (let i = 0; i < 12; i++) meanP += profile[i];
    meanP /= 12;

    let num = 0;
    let denH = 0;
    let denP = 0;
    for (let i = 0; i < 12; i++) {
      const dh = hist[(i + spec.tonic) % 12] - meanH;
      const dp = profile[i] - meanP;
      num += dh * dp;
      denH += dh * dh;
      denP += dp * dp;
    }
    const corr = denH > 0 && denP > 0 ? num / Math.sqrt(denH * denP) : 0;
    if (corr > bestCorr) {
      secondCorr = bestCorr;
      bestCorr = corr;
      bestSpec = spec;
    } else if (corr > secondCorr) {
      secondCorr = corr;
    }
  }

  const margin = Math.max(0, bestCorr - Math.max(0, secondCorr));
  return {
    ...bestSpec,
    confidence: Number(Math.max(0.1, Math.min(0.99, 0.55 + bestCorr * 0.35 + margin * 0.5)).toFixed(3))
  };
}

/**
 * Decodes a smooth chord progression per slot using Viterbi Dynamic Programming.
 * Prevents single passing notes from causing chord flicker while tracking bass roots.
 * @param {object[]} notes - Active canonical notes.
 * @param {object} timing - `{ bpm, num, den, totalDurationSec }`.
 * @param {object} keyInfo - Output from `detectMusicalKey`.
 * @returns {Array<{ slotIndex: number, measureNumber: number, startSec: number, endSec: number, symbol: string, rootPc: number, quality: string, confidence: number }>}
 */
export function recognizeChordsViterbi(notes = [], timing = {}, keyInfo = KEY_SPECS[0]) {
  const bpm = Math.max(40, Math.min(220, Number(timing.bpm) || 100));
  const num = Number(timing.num) || 4;
  const den = Number(timing.den) || 4;
  const isCompound = den === 8 && num % 3 === 0;
  const beatSec = 60 / bpm;
  const barSec = isCompound ? beatSec * (num / 3) : beatSec * num;
  const slotsPerBar = num >= 4 ? 2 : 1; // Half-bar chord resolution in 4/4 and 12/8
  const slotSec = barSec / slotsPerBar;

  const totalSec = Math.max(
    barSec,
    Number(timing.totalDurationSec) || notes.reduce((m, n) => Math.max(m, n.endSec), 0)
  );
  const numSlots = Math.max(1, Math.ceil(totalSec / slotSec));
  const pcNames = keyInfo.preferFlats ? PITCH_CLASS_FLAT : PITCH_CLASS_SHARP;

  // Build candidate chord states (12 roots x qualities)
  const states = [];
  for (let root = 0; root < 12; root++) {
    for (const q of CHORD_QUALITIES) {
      const vec = new Float64Array(12);
      for (let k = 0; k < q.intervals.length; k++) {
        vec[(root + q.intervals[k]) % 12] = k === 0 ? 1.25 : 1.0;
      }
      const norm = Math.hypot(...vec);
      for (let i = 0; i < 12; i++) vec[i] /= norm;
      states.push({
        root,
        quality: q.id,
        symbol: `${pcNames[root]}${q.suffix}`,
        vec,
        penalty: q.penalty
      });
    }
  }

  // Diatonic scale pitch classes for subtle in-key prior
  const scaleOffsets = keyInfo.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const scalePcs = new Set(scaleOffsets.map((o) => (keyInfo.tonic + o) % 12));

  // Compute emission scores per slot
  const emissions = [];
  for (let s = 0; s < numSlots; s++) {
    const t0 = s * slotSec;
    const t1 = (s + 1) * slotSec;
    const chroma = new Float64Array(12);
    let lowestPitch = 128;
    let totalEnergy = 0;

    for (const n of notes) {
      const ov = Math.min(n.endSec, t1) - Math.max(n.startSec, t0);
      if (ov <= 0) continue;
      const pc = ((n.pitch % 12) + 12) % 12;
      const bassW = n.pitch < 55 ? 1.45 : 1.0;
      const e = ov * n.amplitude * bassW;
      chroma[pc] += e;
      totalEnergy += e;
      if (n.pitch < lowestPitch) lowestPitch = n.pitch;
    }

    const chromaNorm = Math.hypot(...chroma);
    const slotScores = new Float64Array(states.length);
    if (chromaNorm > 1e-6) {
      const bassPc = lowestPitch < 128 ? lowestPitch % 12 : -1;
      for (let st = 0; st < states.length; st++) {
        const cand = states[st];
        let dot = 0;
        for (let i = 0; i < 12; i++) dot += (chroma[i] / chromaNorm) * cand.vec[i];
        const bassBonus = bassPc === cand.root ? 0.24 : 0;
        const inKeyBonus = scalePcs.has(cand.root) ? 0.08 : -0.05;
        slotScores[st] = dot + bassBonus + inKeyBonus - cand.penalty;
      }
    }
    emissions.push({ slotScores, hasAudio: totalEnergy > 1e-5 });
  }

  // Viterbi DP
  const nStates = states.length;
  let prevDp = new Float64Array(nStates);
  const backPtr = Array.from({ length: numSlots }, () => new Int16Array(nStates));
  for (let st = 0; st < nStates; st++) {
    prevDp[st] = emissions[0].slotScores[st];
  }

  const switchPenalty = 0.22;
  for (let s = 1; s < numSlots; s++) {
    const curDp = new Float64Array(nStates);
    let bestPrevIdx = 0;
    let bestPrevVal = -Infinity;
    for (let p = 0; p < nStates; p++) {
      if (prevDp[p] > bestPrevVal) {
        bestPrevVal = prevDp[p];
        bestPrevIdx = p;
      }
    }
    for (let st = 0; st < nStates; st++) {
      const stayScore = prevDp[st];
      const switchScore = bestPrevVal - switchPenalty;
      if (stayScore >= switchScore) {
        curDp[st] = stayScore + emissions[s].slotScores[st];
        backPtr[s][st] = st;
      } else {
        curDp[st] = switchScore + emissions[s].slotScores[st];
        backPtr[s][st] = bestPrevIdx;
      }
    }
    prevDp = curDp;
  }

  const path = new Int16Array(numSlots);
  let lastBest = 0;
  for (let st = 1; st < nStates; st++) {
    if (prevDp[st] > prevDp[lastBest]) lastBest = st;
  }
  path[numSlots - 1] = lastBest;
  for (let s = numSlots - 1; s > 0; s--) {
    path[s - 1] = backPtr[s][path[s]];
  }

  return Array.from({ length: numSlots }, (_, s) => {
    const st = states[path[s]];
    return {
      slotIndex: s,
      measureNumber: Math.floor(s / slotsPerBar) + 1,
      beatInMeasure: s % slotsPerBar,
      startSec: Number((s * slotSec).toFixed(4)),
      endSec: Number(((s + 1) * slotSec).toFixed(4)),
      symbol: emissions[s].hasAudio ? st.symbol : 'N.C.',
      rootPc: st.root,
      quality: st.quality,
      confidence: Number(Math.max(0, Math.min(1, emissions[s].slotScores[path[s]])).toFixed(3))
    };
  });
}

/**
 * Splits a single slice of simultaneous pitches cleanly into Bass (LH) and Treble (RH)
 * using Dynamic Programming hand-span + register continuity minimization.
 * @param {object[]} notes - Quantized notes.
 * @param {object} [options={}] - `{ splitMode, fixedSplitMidi }`.
 * @returns {object[]} Notes annotated with `hand: 'treble'|'bass'`.
 */
export function assignGrandStaffHands(notes = [], options = {}) {
  const splitMode = String(options.splitMode || 'smart');
  const fixedSplitMidi = Math.round(Number(options.fixedSplitMidi ?? 60));
  if (!notes.length) return [];

  if (splitMode === 'treble-only') return notes.map((n) => ({ ...n, hand: 'treble' }));
  if (splitMode === 'bass-only') return notes.map((n) => ({ ...n, hand: 'bass' }));
  if (splitMode === 'fixed') {
    return notes.map((n) => ({ ...n, hand: n.pitch >= fixedSplitMidi ? 'treble' : 'bass' }));
  }

  // Group into onset slices by quantized startTick
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const slices = [];
  for (const n of sorted) {
    const last = slices[slices.length - 1];
    if (last && last.tick === n.startTick) {
      last.notes.push(n);
    } else {
      slices.push({ tick: n.startTick, notes: [n] });
    }
  }

  // Enumerate valid split indices k in [0..m] (0..k-1 = bass, k..m-1 = treble)
  const sliceCandidates = slices.map((sl) => {
    const pitches = sl.notes.map((n) => n.pitch);
    const m = pitches.length;
    const cands = [];
    for (let k = 0; k <= m; k++) {
      const bassP = pitches.slice(0, k);
      const trebleP = pitches.slice(k);
      let cost = 0;
      if (bassP.length > 0) {
        const span = bassP[bassP.length - 1] - bassP[0];
        if (span > 14) cost += (span - 14) * 3.5;
        for (const p of bassP) {
          if (p > 60) cost += (p - 60) * 1.2;
          if (p > 64) cost += (p - 64) * 2.5;
        }
      }
      if (trebleP.length > 0) {
        const span = trebleP[trebleP.length - 1] - trebleP[0];
        if (span > 14) cost += (span - 14) * 3.5;
        for (const p of trebleP) {
          if (p < 58) cost += (58 - p) * 1.2;
          if (p < 54) cost += (54 - p) * 2.5;
        }
      }
      const bassMean = bassP.length ? bassP.reduce((a, b) => a + b, 0) / bassP.length : null;
      const trebleMean = trebleP.length ? trebleP.reduce((a, b) => a + b, 0) / trebleP.length : null;
      cands.push({ k, cost, bassMean, trebleMean });
    }
    return cands;
  });

  // DP across slices for smooth melodic continuity
  let prevCosts = sliceCandidates[0].map((c) => c.cost);
  const back = [sliceCandidates[0].map(() => 0)];

  for (let s = 1; s < slices.length; s++) {
    const curCands = sliceCandidates[s];
    const prevCands = sliceCandidates[s - 1];
    const curCosts = new Array(curCands.length).fill(Infinity);
    const curBack = new Array(curCands.length).fill(0);

    for (let ci = 0; ci < curCands.length; ci++) {
      const c = curCands[ci];
      for (let pi = 0; pi < prevCands.length; pi++) {
        const p = prevCands[pi];
        let trans = 0;
        if (c.trebleMean !== null && p.trebleMean !== null) {
          trans += Math.abs(c.trebleMean - p.trebleMean) * 0.18;
        }
        if (c.bassMean !== null && p.bassMean !== null) {
          trans += Math.abs(c.bassMean - p.bassMean) * 0.18;
        }
        const total = prevCosts[pi] + c.cost + trans;
        if (total < curCosts[ci]) {
          curCosts[ci] = total;
          curBack[ci] = pi;
        }
      }
    }
    prevCosts = curCosts;
    back.push(curBack);
  }

  let bestIdx = 0;
  for (let i = 1; i < prevCosts.length; i++) {
    if (prevCosts[i] < prevCosts[bestIdx]) bestIdx = i;
  }

  const chosenK = new Array(slices.length);
  for (let s = slices.length - 1; s >= 0; s--) {
    chosenK[s] = sliceCandidates[s][bestIdx].k;
    bestIdx = back[s][bestIdx];
  }

  const out = [];
  for (let s = 0; s < slices.length; s++) {
    const k = chosenK[s];
    const slNotes = slices[s].notes;
    for (let i = 0; i < slNotes.length; i++) {
      out.push({ ...slNotes[i], hand: i < k ? 'bass' : 'treble' });
    }
  }
  return out;
}

/**
 * Decomposes an arbitrary tick duration inside a bar into standard notation symbols.
 * @param {number} ticks - Remaining ticks within a measure.
 * @returns {Array<{ ticks: number, type: string, vf: string, dots: number }>}
 */
export function decomposeTicksToNotation(ticks) {
  let rem = Math.max(60, Math.round(ticks));
  const parts = [];
  for (const sym of STANDARD_DURATIONS_TICKS) {
    while (rem >= sym.ticks) {
      parts.push({ ...sym });
      rem -= sym.ticks;
    }
  }
  if (!parts.length) {
    parts.push({ ticks: 120, type: '16th', vf: '16', dots: 0 });
  }
  return parts;
}

/**
 * Tracks rubato-adaptive measure boundaries anchored around bass-root / chord salience peaks.
 * Falls back to a uniform grid when timing is manually fixed or too short.
 * @param {object[]} notes - Active canonical notes sorted by `startSec`.
 * @param {number} originSec - Downbeat time of Measure 1 in seconds.
 * @param {number} nominalBarSec - Nominal measure duration from `estimateTempoAndMeter`.
 * @param {number} endLimitSec - Minimum end time to cover.
 * @returns {Array<{ startSec: number, endSec: number }> | null}
 */
function trackAdaptiveMeasureBounds(notes, originSec, nominalBarSec, endLimitSec) {
  if (!notes.length || endLimitSec - originSec < nominalBarSec * 2.4) return null;

  // Cluster onsets (<= 55ms) with bass novelty & harmonic salience
  const clusters = [];
  for (const n of notes) {
    if (n.startSec < originSec - 0.12) continue;
    const last = clusters[clusters.length - 1];
    if (last && n.startSec - last.time <= 0.055) {
      last.maxAmp = Math.max(last.maxAmp, n.amplitude);
      last.noteCount++;
      if (n.pitch < 55) {
        last.hasBass = true;
        last.bassAmp = Math.max(last.bassAmp, n.amplitude);
        if (n.pitch < last.minBassPitch) last.minBassPitch = n.pitch;
      }
    } else {
      clusters.push({
        time: n.startSec,
        maxAmp: n.amplitude,
        noteCount: 1,
        hasBass: n.pitch < 55,
        bassAmp: n.pitch < 55 ? n.amplitude : 0,
        minBassPitch: n.pitch < 55 ? n.pitch : 128
      });
    }
  }
  if (clusters.length < 6) return null;

  // Measure bass-root novelty over the preceding 0.9s window
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    let salience = c.maxAmp * 0.45 + Math.min(0.45, c.noteCount * 0.12);
    if (c.hasBass) {
      const pc = c.minBassPitch % 12;
      let seenRecent = false;
      let strongerRecent = false;
      for (let j = i - 1; j >= 0; j--) {
        const dt = c.time - clusters[j].time;
        if (dt > 0.95) break;
        if (dt > 0.08 && clusters[j].hasBass) {
          if (clusters[j].minBassPitch % 12 === pc) seenRecent = true;
          if (clusters[j].bassAmp > c.bassAmp * 0.95) strongerRecent = true;
        }
      }
      const noveltyMult = !seenRecent ? 1.85 : (!strongerRecent ? 1.35 : 0.75);
      salience += c.bassAmp * noveltyMult;
    }
    c.salience = salience;
  }

  // Look ahead 1..2 measures via narrow forward beam search so rubato intros (e.g. 2.00s + 2.18s)
  // lock onto real harmonic bass-change chains instead of getting trapped by 1 nominal beat step.
  const BEAM_WIDTH = 8;
  let beams = [{ curT: originSec, localBarSec: nominalBarSec, score: 0, bounds: [] }];
  let safetyCounter = 0;

  while (safetyCounter < 1000) {
    safetyCounter++;
    const activeBeams = beams.filter((b) => b.curT < endLimitSec);
    if (!activeBeams.length) break;

    const nextStates = [];
    for (const st of beams) {
      if (st.curT >= endLimitSec) {
        nextStates.push(st);
        continue;
      }

      const predT = st.curT + st.localBarSec;
      const minNext = Math.max(st.curT + nominalBarSec * 0.80, st.curT + st.localBarSec * 0.84);
      const maxNext = Math.min(st.curT + nominalBarSec * 1.26, st.curT + st.localBarSec * 1.24);
      const candidates = [{ nextT: predT, sal: 0.25 }];

      // Pick top-5 highest-salience downbeat clusters within this bar's elastic window
      const inWin = [];
      for (const c of clusters) {
        if (c.time < minNext) continue;
        if (c.time > maxNext) break;
        if (c.salience >= 0.72) inWin.push(c);
      }
      inWin.sort((a, b) => b.salience - a.salience);
      for (const c of inWin.slice(0, 5)) {
        const snapped = Math.abs(c.time - predT) <= 0.036 ? predT : c.time;
        if (!candidates.some((x) => Math.abs(x.nextT - snapped) < 0.03)) {
          candidates.push({ nextT: snapped, sal: c.salience });
        }
      }

      for (const cand of candidates) {
        const barDt = Math.max(nominalBarSec * 0.78, Math.min(nominalBarSec * 1.26, cand.nextT - st.curT));
        const nextEnd = st.curT + barDt;
        const dLocal = (barDt - st.localBarSec) / nominalBarSec;
        const dNom = (barDt - nominalBarSec) / nominalBarSec;
        const driftCost = dLocal * dLocal * 3.8 + dNom * dNom * 1.6;
        const nextLocal = Math.max(
          nominalBarSec * 0.82,
          Math.min(nominalBarSec * 1.24, st.localBarSec * 0.60 + barDt * 0.40)
        );
        nextStates.push({
          curT: nextEnd,
          localBarSec: nextLocal,
          score: st.score + cand.sal - driftCost,
          bounds: [...st.bounds, { startSec: st.curT, endSec: nextEnd }]
        });
      }
    }

    // Deduplicate paths landing within 40ms with matching measure count & keep top BEAM_WIDTH
    nextStates.sort((a, b) => b.score - a.score);
    const pruned = [];
    for (const ns of nextStates) {
      if (pruned.some((p) => p.bounds.length === ns.bounds.length && Math.abs(p.curT - ns.curT) < 0.045)) {
        continue;
      }
      pruned.push(ns);
      if (pruned.length >= BEAM_WIDTH) break;
    }
    beams = pruned;
  }

  return beams[0]?.bounds?.length ? beams[0].bounds : null;
}

/**
 * Quantizes notes onto the rhythmic tick grid (with elastic rubato bar tracking in Auto mode),
 * stabilizes 8th-note phrasing against pedal/timing jitter, assigns Grand Staff hands,
 * slices across barlines with ties, and builds complete measure data for VexFlow, MIDI, and MusicXML.
 * @param {object[]} rawNotes - Provider notes.
 * @param {object} [options={}] - Analysis & quantization configuration.
 * @returns {object} Full structured VANTA Score Model.
 */
export function buildScoreModel(rawNotes = [], options = {}) {
  const canonical = normalizeRawNotes(rawNotes, {
    timeOffsetSec: options.timeOffsetSec || 0,
    transposeSemitones: options.transposeSemitones || 0
  });

  const cleaned = annotateAndCleanNotes(canonical, options);
  const activeNotes = cleaned.active;

  const isManualTiming = Boolean(options.bpm && options.timeSignature);
  const tempoMeter = isManualTiming
    ? {
        bpm: Math.max(40, Math.min(220, Math.round(Number(options.bpm)))),
        timeSignature: options.timeSignature,
        num: Number(options.timeSignature.split('/')[0]) || 4,
        den: Number(options.timeSignature.split('/')[1]) || 4,
        beatOffsetSec: 0,
        confidence: 1.0
      }
    : estimateTempoAndMeter(activeNotes, {
        bpmHint: options.bpmHint || options.bpm,
        timeSignature: options.timeSignature
      });

  const keyInfo = options.forcedKey
    ? (KEY_SPECS.find((k) => k.label === options.forcedKey || k.vexKey === options.forcedKey) || detectMusicalKey(activeNotes))
    : detectMusicalKey(activeNotes);

  const isCompound = tempoMeter.den === 8 && tempoMeter.num % 3 === 0;
  // Quarter-note BPM for MusicXML/MIDI consistency: in compound time, user BPM is dotted-quarter
  const quarterBpm = isCompound ? tempoMeter.bpm * 1.5 : tempoMeter.bpm;
  const secPerQuarter = 60 / quarterBpm;
  const measureTicks = isCompound ? (tempoMeter.num * 240) : (tempoMeter.num * PPQ);
  const nominalBarSec = (measureTicks / PPQ) * secPerQuarter;
  const defaultGridTicks = options.gridResolution === '8' ? 240 : 120;
  const alignOffsetSec = options.timeOffsetSec !== undefined
    ? 0
    : Math.max(0, Number(tempoMeter.beatOffsetSec) || 0);

  const maxNoteEndSec = activeNotes.reduce((m, n) => Math.max(m, n.endSec), alignOffsetSec + nominalBarSec);
  const adaptiveBounds = !isManualTiming && options.timeOffsetSec === undefined
    ? trackAdaptiveMeasureBounds(activeNotes, alignOffsetSec, nominalBarSec, maxNoteEndSec)
    : null;

  const warpSecToAligned = (sec) => {
    if (!adaptiveBounds) return Math.max(0, sec - alignOffsetSec);
    if (sec <= adaptiveBounds[0].startSec) return 0;
    for (let i = 0; i < adaptiveBounds.length; i++) {
      const b = adaptiveBounds[i];
      if (sec < b.endSec || i === adaptiveBounds.length - 1) {
        const span = Math.max(0.05, b.endSec - b.startSec);
        return (i + (sec - b.startSec) / span) * nominalBarSec;
      }
    }
    return Math.max(0, sec - alignOffsetSec);
  };

  const alignedToRealSec = (alignedSec) => {
    if (!adaptiveBounds) return alignOffsetSec + alignedSec;
    if (alignedSec <= 0) return adaptiveBounds[0].startSec;
    const fBar = alignedSec / nominalBarSec;
    const idx = Math.floor(fBar);
    if (idx < adaptiveBounds.length) {
      const b = adaptiveBounds[idx];
      const frac = fBar - idx;
      return b.startSec + frac * (b.endSec - b.startSec);
    }
    const last = adaptiveBounds[adaptiveBounds.length - 1];
    return last.endSec + (fBar - adaptiveBounds.length) * nominalBarSec;
  };

  const quantizedRaw = activeNotes.map((n) => {
    const warpedStart = Math.max(0, warpSecToAligned(n.startSec));
    const warpedEnd = Math.max(warpedStart + 0.04, warpSecToAligned(n.endSec));
    const exactStartTicks = (warpedStart / secPerQuarter) * PPQ;
    const startTick = Math.max(0, Math.round(exactStartTicks / defaultGridTicks) * defaultGridTicks);
    const rawDurTicks = Math.round(((warpedEnd - warpedStart) / secPerQuarter) * PPQ / defaultGridTicks) * defaultGridTicks;
    const durTicks = Math.max(defaultGridTicks, rawDurTicks);
    return {
      ...n,
      exactStartTicks,
      startTick,
      endTick: startTick + durTicks,
      durTicks,
      noteName: midiToNoteName(n.pitch, keyInfo.preferFlats),
      vexKey: midiToVexKey(n.pitch, keyInfo.preferFlats)
    };
  });

  // Stabilize isolated 16th timing jitter onto 8th beats when no true 16th run neighbors exist
  if (defaultGridTicks === 120 && quantizedRaw.length >= 4) {
    const uniqueSortedTicks = [...new Set(quantizedRaw.map((n) => n.startTick))].sort((a, b) => a - b);
    const genuine16thTicks = new Set();
    for (let i = 0; i < uniqueSortedTicks.length; i++) {
      const t = uniqueSortedTicks[i];
      const prevT = i > 0 ? uniqueSortedTicks[i - 1] : -9999;
      const nextT = i + 1 < uniqueSortedTicks.length ? uniqueSortedTicks[i + 1] : 9999999;
      if (t - prevT === 120 || nextT - t === 120) {
        genuine16thTicks.add(t);
      }
    }
    for (const n of quantizedRaw) {
      if (n.startTick % 240 === 120 && !genuine16thTicks.has(n.startTick)) {
        const snapped8 = Math.max(0, Math.round(n.exactStartTicks / 240) * 240);
        n.startTick = snapped8;
        n.durTicks = Math.max(240, Math.round(n.durTicks / 240) * 240);
        n.endTick = n.startTick + n.durTicks;
      }
    }
  }

  // Prevent overlapping identical pitches on same startTick
  const deduped = [];
  const seenKeys = new Set();
  for (const n of quantizedRaw.sort((a, b) => a.startTick - b.startTick || b.amplitude - a.amplitude)) {
    const k = `${n.startTick}_${n.pitch}`;
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    deduped.push(n);
  }

  const handedNotes = assignGrandStaffHands(deduped, {
    splitMode: options.splitMode || 'smart',
    fixedSplitMidi: options.fixedSplitMidi || 60
  });

  const maxEndTick = handedNotes.reduce((m, n) => Math.max(m, n.endTick), measureTicks);
  const totalMeasures = Math.max(1, Math.ceil(maxEndTick / measureTicks));
  const alignedTotalSec = (totalMeasures * measureTicks / PPQ) * secPerQuarter;
  const totalDurationSec = alignedToRealSec(alignedTotalSec);

  const chordInputNotes = activeNotes.map((n) => {
    const ws = warpSecToAligned(n.startSec);
    const we = Math.max(ws + 0.04, warpSecToAligned(n.endSec));
    return { ...n, startSec: ws, endSec: we };
  });

  const chords = recognizeChordsViterbi(
    chordInputNotes,
    { bpm: tempoMeter.bpm, num: tempoMeter.num, den: tempoMeter.den, totalDurationSec: alignedTotalSec },
    keyInfo
  ).map((c) => ({
    ...c,
    startSec: Number(alignedToRealSec(c.startSec).toFixed(4)),
    endSec: Number(alignedToRealSec(c.endSec).toFixed(4))
  }));

  // Split notes across measure boundaries with tie flags (timestamps mapped cleanly to audio timeline)
  const measures = Array.from({ length: totalMeasures }, (_, idx) => {
    const mStartTick = idx * measureTicks;
    const mEndTick = (idx + 1) * measureTicks;
    const barChords = chords.filter((c) => c.measureNumber === idx + 1);
    return {
      measureNumber: idx + 1,
      startTick: mStartTick,
      endTick: mEndTick,
      startSec: Number(alignedToRealSec((mStartTick / PPQ) * secPerQuarter).toFixed(4)),
      endSec: Number(alignedToRealSec((mEndTick / PPQ) * secPerQuarter).toFixed(4)),
      chords: barChords,
      trebleEvents: [],
      bassEvents: []
    };
  });

  for (const n of handedNotes) {
    let curTick = n.startTick;
    let partIdx = 0;
    while (curTick < n.endTick) {
      const mIdx = Math.floor(curTick / measureTicks);
      if (mIdx >= measures.length) break;
      const m = measures[mIdx];
      const segEnd = Math.min(n.endTick, m.endTick);
      const segDur = segEnd - curTick;
      const notationParts = decomposeTicksToNotation(segDur);
      const localOffset = curTick - m.startTick;

      // Primary notation segment for rendering & XML
      const targetArr = n.hand === 'bass' ? m.bassEvents : m.trebleEvents;
      targetArr.push({
        sourceNoteId: n.id,
        pitch: n.pitch,
        noteName: n.noteName,
        vexKey: n.vexKey,
        hand: n.hand,
        velocity: n.velocity,
        amplitude: n.amplitude,
        startTickInMeasure: localOffset,
        durTicks: segDur,
        notation: notationParts[0],
        tieStart: segEnd < n.endTick,
        tieEnd: partIdx > 0,
        startSec: Number(alignedToRealSec((curTick / PPQ) * secPerQuarter).toFixed(4)),
        endSec: Number(alignedToRealSec((segEnd / PPQ) * secPerQuarter).toFixed(4))
      });

      curTick = segEnd;
      partIdx++;
    }
  }

  for (const m of measures) {
    m.trebleEvents.sort((a, b) => a.startTickInMeasure - b.startTickInMeasure || a.pitch - b.pitch);
    m.bassEvents.sort((a, b) => a.startTickInMeasure - b.startTickInMeasure || a.pitch - b.pitch);
  }

  return {
    schemaVersion: 1,
    tempo: tempoMeter.bpm,
    quarterBpm,
    timeSignature: tempoMeter.timeSignature,
    num: tempoMeter.num,
    den: tempoMeter.den,
    beatOffsetSec: Number(alignOffsetSec.toFixed(4)),
    measureTicks,
    secPerQuarter,
    totalMeasures,
    totalDurationSec: Number(totalDurationSec.toFixed(3)),
    key: keyInfo,
    chords,
    notes: handedNotes,
    annotatedRawNotes: cleaned.annotated,
    stats: cleaned.stats,
    measures
  };
}

/**
 * Parses flexible `ss`, `mm:ss`, or `hh:mm:ss` user time input into integer seconds.
 * @param {string|number} rawInput - Raw text or numeric timestamp.
 * @returns {number|null} Non-negative integer seconds, or `null` if invalid.
 */
export function parseTimeWindowInput(rawInput) {
  if (typeof rawInput === 'number') {
    return Number.isFinite(rawInput) && rawInput >= 0 ? Math.round(rawInput) : null;
  }
  const str = String(rawInput ?? '').trim();
  if (!str) return null;

  if (!str.includes(':')) {
    if (!/^\d+(?:\.\d+)?$/.test(str)) return null;
    const sec = Number(str);
    return Number.isFinite(sec) && sec >= 0 ? Math.round(sec) : null;
  }

  const parts = str.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) {
    return null;
  }
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (nums.length === 2) {
    const [mm, ss] = nums;
    if (ss >= 60) return null;
    return Math.round(mm * 60 + ss);
  }
  const [hh, mm, ss] = nums;
  if (mm >= 60 || ss >= 60) return null;
  return Math.round(hh * 3600 + mm * 60 + ss);
}

/**
 * Normalizes UI Start–End time bounds so any slice of a long (>8 min) track can be analyzed
 * while strictly keeping each extraction pass within `[minWindowSec, maxWindowSec]`.
 * @param {object} [params={}] - Window candidate `{ startSec, endSec, trackDurationSec, maxWindowSec, minWindowSec, changedEdge }`.
 * @returns {object} Bounded window state and IPC request parameters.
 */
export function normalizeAnalysisWindowBounds(params = {}) {
  const maxWin = Math.max(30, Math.round(Number(params.maxWindowSec) || 480));
  const minWin = Math.max(1, Math.min(maxWin, Math.round(Number(params.minWindowSec) || 5)));
  const rawTrackDur = Math.round(Number(params.trackDurationSec) || 0);
  const trackDur = rawTrackDur > 0 ? Math.max(minWin, rawTrackDur) : 0;
  const edge = params.changedEdge === 'start' ? 'start' : 'end';

  let s = Math.max(0, Math.round(Number(params.startSec) || 0));
  let e = Math.max(0, Math.round(Number(params.endSec) || 0));

  if (trackDur > 0) {
    s = Math.min(s, Math.max(0, trackDur - minWin));
    if (e <= 0) e = Math.min(trackDur, s + maxWin);
    e = Math.min(e, trackDur);
  } else if (e <= 0) {
    e = s + maxWin;
  }

  const rawSpan = Math.max(0, e - s);
  let exceedsMaxCap = false;

  if (edge === 'start') {
    if (e < s + minWin) {
      e = trackDur > 0 ? Math.min(trackDur, s + minWin) : s + minWin;
    }
    if (e - s > maxWin) {
      e = s + maxWin;
      exceedsMaxCap = true;
    }
  } else {
    if (e < s + minWin) {
      s = Math.max(0, e - minWin);
      if (e - s < minWin) {
        e = trackDur > 0 ? Math.min(trackDur, s + minWin) : s + minWin;
      }
    }
    if (e - s > maxWin) {
      s = Math.max(0, e - maxWin);
      exceedsMaxCap = true;
    }
  }

  const spanSec = Math.max(1, e - s);
  const isLongTrack = trackDur > maxWin;
  const isFullTrack = trackDur > 0 && trackDur <= maxWin && s === 0 && e >= trackDur;
  const requestStartSec = s;
  const requestDurationSec = isFullTrack ? 0 : Math.min(maxWin, spanSec);

  return {
    startSec: s,
    endSec: e,
    spanSec,
    requestStartSec,
    requestDurationSec,
    exceedsMaxCap: exceedsMaxCap || rawSpan > maxWin,
    isLongTrack,
    isFullTrack
  };
}
