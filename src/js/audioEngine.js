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
 * Resolves the combined 10-band EQ gain array (manual EQ + acoustic device profile offsets).
 * @param {object} [state={}] - Audio engine DSP state.
 * @returns {number[]} 10 band gains in [-12, 12] dB.
 */
export function computeEffectiveEqGains(state = {}) {
  const profileOffsets = DEVICE_EQ_PROFILES[state.deviceProfile] || DEVICE_EQ_PROFILES['Bit-Perfect (Flat)'];
  const useProfile =
    Boolean(state.deviceProfile) &&
    state.deviceProfile !== 'Bit-Perfect (Flat)' &&
    state.deviceProfile !== 'Studio Monitors';
  const gains = Array.isArray(state.gains) ? state.gains : [];
  return EQ_FREQUENCIES.map((_, idx) => {
    const bandGain = state.eqEnabled ? (Number(gains[idx]) || 0) : 0;
    const profileGain = useProfile ? (Number(profileOffsets[idx]) || 0) : 0;
    return Math.max(-12, Math.min(12, bandGain + profileGain));
  });
}

/**
 * Returns true only when active DSP features require Chromium Web Audio Studio DSP
 * (Spatial 3D, Exciter, Reverb, Karaoke, Vinyl/Tube, Night Compressor, Pitch, Speed, Crossfade).
 * PurePath 64 features (10-Band EQ, Profiles, Sub-Bass, Bauer Crossfeed, Limiter, EBU R128)
 * execute natively in 64-bit float inside the C++ WASAPI engine.
 * @param {object} [state={}] - Audio engine DSP state.
 * @returns {boolean}
 */
export function requiresStudioDsp(state = {}) {
  return Boolean(
    state.spatial ||
      state.exciter ||
      state.reverb ||
      state.karaoke ||
      state.vinyl ||
      state.saturation ||
      state.nightMode ||
      Math.abs(Number(state.pitchSemitones) || 0) >= 0.05 ||
      Math.abs((Number(state.playbackRate) || 1) - 1) >= 0.001 ||
      (Number(state.crossfadeSeconds) || 0) > 0
  );
}

/**
 * Computes the linear WASAPI output gain multiplier honoring Volume Mode (`auto` | `software` | `fixed0db`),
 * EBU R128 ReplayGain, Mute state, and hardware endpoint volume capability.
 * @param {object} [opts={}] - Gain calculation inputs.
 * @returns {number} Combined linear gain multiplier in [0, 4.0].
 */
export function computeWasapiGainFactor(opts = {}) {
  const volumeMode = ['auto', 'software', 'fixed0db'].includes(opts.volumeMode) ? opts.volumeMode : 'auto';
  const r128Gain = Number.isFinite(Number(opts.replayGainLinear)) ? Math.max(0, Math.min(4.0, Number(opts.replayGainLinear))) : 1.0;
  if (volumeMode === 'fixed0db') {
    return opts.isMuted ? 0 : r128Gain;
  }
  if (opts.isMuted) {
    return 0;
  }
  const masterLin = Number.isFinite(Number(opts.masterVolumeLinear)) ? Math.max(0, Math.min(1.0, Number(opts.masterVolumeLinear))) : 1.0;
  if (volumeMode === 'software') {
    return r128Gain * masterLin;
  }
  const hwScalesExclusive = Boolean(opts.windowsVolumeLinked) && ((Number(opts.deviceHwVolumeSupport) || 0) & 1) !== 0;
  const volFactor = hwScalesExclusive ? 1.0 : masterLin;
  return r128Gain * volFactor;
}

/**
 * Resolves startup audio engine & transport preferences cleanly, defaulting fresh installs to
 * `WASAPI + Bit-Perfect Pure` (`lufs: false`, `limiter: false`, `holdWasapiOnPause: false`)
 * while preserving explicit user choices across restarts and migrating legacy implicit defaults.
 * @param {string|object|null} savedPrefsRaw - Raw JSON or parsed object from `vanta_audio_prefs_v2`.
 * @param {string|object|null} savedLegacyDspRaw - Raw JSON or parsed object from `vanta_pro_dsp_v1`.
 * @returns {{ engineMode: string, holdWasapiOnPause: boolean, wasapiPushMode: boolean, wasapiBufferMs: number, clockSwitchPreRollMs: number, fixedRateLock: boolean, fixedTargetRate: number, migratePureDspDefaults: boolean }}
 */
export function resolveStartupAudioPrefs(savedPrefsRaw = null, savedLegacyDspRaw = null) {
  const defaults = {
    engineMode: 'wasapi',
    outputBackend: 'wasapi',
    asioDriver: '',
    asioRawDsd: false,
    holdWasapiOnPause: false,
    wasapiPushMode: false,
    wasapiBufferMs: 0,
    clockSwitchPreRollMs: 0,
    fixedRateLock: false,
    fixedTargetRate: 48000,
    migratePureDspDefaults: false
  };

  let prefs = null;
  try {
    prefs = typeof savedPrefsRaw === 'string' ? JSON.parse(savedPrefsRaw) : (savedPrefsRaw && typeof savedPrefsRaw === 'object' ? savedPrefsRaw : null);
  } catch {
    prefs = null;
  }

  let legacyDsp = null;
  try {
    legacyDsp = typeof savedLegacyDspRaw === 'string' ? JSON.parse(savedLegacyDspRaw) : (savedLegacyDspRaw && typeof savedLegacyDspRaw === 'object' ? savedLegacyDspRaw : null);
  } catch {
    legacyDsp = null;
  }

  if (prefs && Number(prefs.version) >= 2) {
    return {
      engineMode: prefs.preferredAudioEngineMode === 'dsp' ? 'dsp' : 'wasapi',
      outputBackend: prefs.outputBackend === 'asio' ? 'asio' : 'wasapi',
      asioDriver: typeof prefs.asioDriver === 'string' ? prefs.asioDriver : '',
      asioRawDsd: Boolean(prefs.asioRawDsd),
      holdWasapiOnPause: Boolean(prefs.holdWasapiOnPause),
      wasapiPushMode: Boolean(prefs.wasapiPushMode),
      wasapiBufferMs: Math.max(0, Math.min(200, Math.round(Number(prefs.wasapiBufferMs) || 0))),
      clockSwitchPreRollMs: [0, 50, 150].includes(Number(prefs.clockSwitchPreRollMs)) ? Number(prefs.clockSwitchPreRollMs) : 0,
      fixedRateLock: Boolean(prefs.fixedRateLock),
      fixedTargetRate: [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000].includes(Number(prefs.fixedTargetRate))
        ? Number(prefs.fixedTargetRate)
        : 48000,
      migratePureDspDefaults: false
    };
  }

  if (legacyDsp) {
    const gainsFlat = !Array.isArray(legacyDsp.gains) || legacyDsp.gains.every((v) => Math.abs(Number(v) || 0) < 0.01);
    const hasCustomFx = Boolean(
      legacyDsp.eqEnabled ||
      legacyDsp.spatial ||
      legacyDsp.crossfeed ||
      legacyDsp.exciter ||
      legacyDsp.nightMode ||
      legacyDsp.karaoke ||
      legacyDsp.vinyl ||
      legacyDsp.reverb ||
      legacyDsp.bassBoost ||
      Math.abs(Number(legacyDsp.pitchSemitones) || 0) > 0 ||
      (legacyDsp.deviceProfile && legacyDsp.deviceProfile !== 'Bit-Perfect (Flat)') ||
      !gainsFlat
    );
    const hasStudioOnly = Boolean(
      legacyDsp.spatial ||
      legacyDsp.exciter ||
      legacyDsp.reverb ||
      legacyDsp.karaoke ||
      legacyDsp.vinyl ||
      legacyDsp.nightMode ||
      Math.abs(Number(legacyDsp.pitchSemitones) || 0) > 0
    );
    return {
      ...defaults,
      engineMode: hasStudioOnly ? 'dsp' : 'wasapi',
      migratePureDspDefaults: !hasCustomFx
    };
  }

  return defaults;
}

/**
 * Resolves the effective ReplayGain 2.0 multiplier given Track vs Album mode, target LUFS (-18 vs -14),
 * embedded ID3/Vorbis ReplayGain tags, and measured EBU R128 loudness data.
 * Standard ReplayGain tags are referenced to -18.0 LUFS.
 * @param {object} [opts={}] - ReplayGain context (`mode`, `targetLufs`, `tags`, `r128`, `clipProtect`).
 * @returns {{ linearGain: number, appliedDb: number, source: string, peakLinear: number|null, referenceLufs: number }}
 */
export function resolveReplayGain2(opts = {}) {
  const targetLufs = Number(opts.targetLufs) === -14 ? -14.0 : -18.0;
  const clipProtect = opts.clipProtect !== false;
  if (opts.enabled === false) {
    return { linearGain: 1.0, appliedDb: 0, source: 'off', peakLinear: null, referenceLufs: targetLufs };
  }
  const mode = ['off', 'track', 'album'].includes(opts.mode) ? opts.mode : (opts.enabled ? 'track' : 'off');
  if (mode === 'off') {
    return { linearGain: 1.0, appliedDb: 0, source: 'off', peakLinear: null, referenceLufs: targetLufs };
  }

  const tags = opts.tags || null;
  const r128 = opts.r128 || null;
  const refOffsetDb = targetLufs - (-18.0);

  let rawGainDb = null;
  let peakLin = null;
  let source = 'none';

  if (mode === 'album') {
    if (Number.isFinite(tags?.replayGainAlbumGainDb)) {
      rawGainDb = Number(tags.replayGainAlbumGainDb) + refOffsetDb;
      peakLin = Number.isFinite(tags.replayGainAlbumPeak)
        ? Number(tags.replayGainAlbumPeak)
        : (Number.isFinite(tags.replayGainTrackPeak) ? Number(tags.replayGainTrackPeak) : null);
      source = 'tag_album';
    } else if (Number.isFinite(r128?.albumLufs)) {
      rawGainDb = targetLufs - Number(r128.albumLufs);
      peakLin = Number.isFinite(r128.albumTruePeakDbfs) ? Math.pow(10, Number(r128.albumTruePeakDbfs) / 20) : null;
      source = 'ebur128_album';
    }
  }

  if (rawGainDb === null) {
    if (Number.isFinite(tags?.replayGainTrackGainDb)) {
      rawGainDb = Number(tags.replayGainTrackGainDb) + refOffsetDb;
      peakLin = Number.isFinite(tags.replayGainTrackPeak) ? Number(tags.replayGainTrackPeak) : null;
      source = 'tag_track';
    } else if (Number.isFinite(r128?.integratedLufs)) {
      rawGainDb = targetLufs - Number(r128.integratedLufs);
      peakLin = Number.isFinite(r128.truePeakDbfs) ? Math.pow(10, Number(r128.truePeakDbfs) / 20) : null;
      source = 'ebur128_track';
    } else if (Number.isFinite(r128?.replayGainDb)) {
      const measuredTarget = Number(r128.targetLufs) || -14.0;
      rawGainDb = Number(r128.replayGainDb) + (targetLufs - measuredTarget);
      peakLin = Number.isFinite(r128.truePeakDbfs) ? Math.pow(10, Number(r128.truePeakDbfs) / 20) : null;
      source = 'ebur128_cached';
    }
  }

  if (rawGainDb === null || !Number.isFinite(rawGainDb)) {
    return { linearGain: 1.0, appliedDb: 0, source: 'unmeasured', peakLinear: null, referenceLufs: targetLufs };
  }

  let clampedDb = Math.max(-18, Math.min(12, rawGainDb));
  if (clipProtect && peakLin && peakLin > 0) {
    const maxSafeBoostDb = 20 * Math.log10(0.944061 / peakLin);
    clampedDb = Math.min(clampedDb, maxSafeBoostDb);
  }
  clampedDb = Math.max(-18, Math.min(12, Number(clampedDb.toFixed(2))));
  const linearGain = Number(Math.pow(10, clampedDb / 20).toFixed(4));
  return { linearGain, appliedDb: clampedDb, source, peakLinear: peakLin, referenceLufs: targetLufs };
}

/**
 * Determines whether Studio DSP / HTML5 playback for a track requires an FFmpeg live stream pipe
 * instead of direct Chromium HTTP 206 byte-range seeking.
 * @param {object|null} [track=null] - Track metadata object.
 * @param {'direct'|'remux-copy'|'transcode-h264'} [videoStrategy='direct'] - Active video delivery strategy.
 * @returns {boolean} True when FFmpeg piped transcoding/remuxing is required.
 */
export function requiresStudioFfmpegStream(track = null, videoStrategy = 'direct') {
  if (!track) return false;
  if (Number(track.sacdTrack) >= 1) return true;
  if (track.isVideo) return videoStrategy !== 'direct';
  const filePath = String(track.filePath || '');
  if (/\.(?:w64|aiff?|alac|ape|wv|dsf|dff|wma|iso)$/i.test(filePath)) return true;
  const codec = String(track.audioCodec || track.codec || '').toUpperCase();
  return /^(?:ALAC|APE|WAVPACK|WMAV2|WMAPRO)$/.test(codec) || codec.includes('DSD');
}

/**
 * Serializes AudioEngine DSP state into the PurePath 64 native C++ wire format.
 * @param {object} [state={}] - Audio engine DSP state.
 * @returns {string} Compact wire string (`b0,...,b9|bass|bassDb|xf|xfPct|limiter`).
 */
export function serializeNativeDspSpecFromState(state = {}) {
  const fmt = (n) => Number(Number(n).toFixed(2)).toString();
  const effectiveBands = computeEffectiveEqGains(state).map((g) => fmt(g));
  const bass = state.bassBoost ? 1 : 0;
  const bassDb = fmt(Math.max(0, Math.min(9, Number(state.bassBoostDb ?? 5.5) || 0)));
  const crossfeed = state.crossfeed ? 1 : 0;
  const xfPct = fmt(Math.max(0, Math.min(100, Number(state.crossfeedLevelPct ?? 55) || 0)));
  const limiter = state.limiter ? 1 : 0;
  return `${effectiveBands.join(',')}|${bass}|${bassDb}|${crossfeed}|${xfPct}|${limiter}`;
}

const AUTOEQ_TYPE_ALIASES = Object.freeze({
  PK: 'PK',
  PEAKING: 'PK',
  LSC: 'LSC',
  LS: 'LSC',
  HSC: 'HSC',
  HS: 'HSC',
  LPQ: 'LPQ',
  LP: 'LPQ',
  HPQ: 'HPQ',
  HP: 'HPQ',
  NO: 'NO',
  AP: 'AP'
});

/**
 * Parses an EqualizerAPO / AutoEQ / Oratory1990 / Crinacle `.txt` profile cleanly.
 * Extracts Preamp and up to 32 parametric filters (`PK`, `LSC`, `HSC`, `LPQ`, `HPQ`, `NO`, `AP`).
 * @param {string} rawText - Contents of the `.txt` profile.
 * @returns {{ ok: boolean, preampDb: number, bands: Array<object>, skippedLines: number, error?: string }}
 */
export function parseAutoEqTxt(rawText = '') {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, preampDb: 0, bands: [], skippedLines: 0, error: 'Empty AutoEQ text file' };
  }
  const lines = rawText.split(/\r?\n/);
  let preampDb = 0;
  let hasPreamp = false;
  const bands = [];
  let skippedLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const preampMatch = /^Preamp\s*:\s*([-+]?\d+(?:\.\d+)?)\s*(?:dB)?/i.exec(line);
    if (preampMatch) {
      const val = Number(preampMatch[1]);
      if (Number.isFinite(val)) {
        preampDb = Math.max(-30, Math.min(18, Number(val.toFixed(3))));
        hasPreamp = true;
      }
      continue;
    }

    const colonIdx = line.indexOf(':');
    const hdrPrefix = colonIdx > 0 ? line.slice(0, colonIdx).trim() : '';
    const hdrRest = colonIdx > 0 ? line.slice(colonIdx + 1).trim() : '';
    if (!/^Filter(?:\s+\d+)?$/i.test(hdrPrefix)) {
      skippedLines++;
      continue;
    }

    const tokens = hdrRest.split(/\s+/);
    const stateTok = (tokens[0] || '').toUpperCase();
    const rawType = (tokens[1] || '').toUpperCase();
    if (!['ON', 'OFF'].includes(stateTok) || !/^[A-Za-z]{2,12}$/.test(rawType)) {
      skippedLines++;
      continue;
    }
    if (stateTok !== 'ON' || rawType === 'NONE') {
      continue;
    }
    const canonType = AUTOEQ_TYPE_ALIASES[rawType];
    if (!canonType) {
      skippedLines++;
      continue;
    }

    const rest = tokens.slice(2).join(' ');
    const fcMatch = /\bFc\s+([-+]?\d+(?:\.\d+)?)\s*(?:Hz)?/i.exec(rest);
    if (!fcMatch) {
      skippedLines++;
      continue;
    }
    const freqHz = Number(fcMatch[1]);
    if (!Number.isFinite(freqHz) || freqHz < 10 || freqHz > 96000) {
      skippedLines++;
      continue;
    }

    const gainMatch = /\bGain\s+([-+]?\d+(?:\.\d+)?)\s*(?:dB)?/i.exec(rest);
    const rawGain = gainMatch ? Number(gainMatch[1]) : 0;
    const gainDb = Number.isFinite(rawGain) ? Math.max(-30, Math.min(30, Number(rawGain.toFixed(3)))) : 0;

    const qMatch = /\bQ\s+([-+]?\d+(?:\.\d+)?)/i.exec(rest);
    const rawQ = qMatch ? Number(qMatch[1]) : 0.7071;
    if (!Number.isFinite(rawQ) || rawQ <= 0) {
      skippedLines++;
      continue;
    }
    const q = Math.max(0.05, Math.min(30, Number(rawQ.toFixed(4))));

    if (bands.length >= 32) break;
    bands.push({
      index: bands.length + 1,
      enabled: true,
      type: canonType,
      freqHz: Number(freqHz.toFixed(2)),
      gainDb,
      q
    });
  }

  if (!bands.length && !hasPreamp) {
    return {
      ok: false,
      preampDb: 0,
      bands: [],
      skippedLines,
      error: 'No valid EqualizerAPO Filter or Preamp lines found'
    };
  }
  return { ok: true, preampDb, bands, skippedLines };
}

/**
 * Serializes AutoEQ / Parametric EQ config to the native C++ engine `PEQ_SPEC` wire string.
 * @param {object} [peqConfig={}] - PEQ settings (`enabled`, `preampDb`, `bands`).
 * @returns {string} Wire spec or empty string when disabled.
 */
export function serializePeqWireSpec(peqConfig = {}) {
  if (!peqConfig) return '';
  const enabledFlag = peqConfig.enabled !== undefined ? peqConfig.enabled : peqConfig.peqEnabled;
  if (enabledFlag === false) return '';
  const rawBands = Array.isArray(peqConfig.bands) ? peqConfig.bands : peqConfig.peqBands;
  const bands = Array.isArray(rawBands) ? rawBands.slice(0, 32) : [];
  const rawPreamp = peqConfig.preampDb !== undefined ? peqConfig.preampDb : peqConfig.peqPreampDb;
  const preamp = Number.isFinite(Number(rawPreamp))
    ? Math.max(-30, Math.min(18, Number(rawPreamp)))
    : 0;
  if (!bands.length && Math.abs(preamp) < 0.01) return '';
  const fmt = (n) => Number(Number(n).toFixed(4)).toString();
  const parts = [fmt(preamp)];
  for (const b of bands) {
    const t = AUTOEQ_TYPE_ALIASES[String(b?.type || '').toUpperCase()];
    const fc = Number(b?.freqHz);
    const q = Number(b?.q ?? 0.7071);
    const g = Number(b?.gainDb ?? 0);
    if (!t || !Number.isFinite(fc) || fc < 10 || !Number.isFinite(q) || q <= 0 || !Number.isFinite(g)) continue;
    parts.push(`${t},${fmt(Math.min(96000, fc))},${fmt(Math.max(0.05, Math.min(30, q)))},${fmt(Math.max(-30, Math.min(30, g)))}`);
  }
  return parts.join(';');
}

/**
 * Computes exact one-tailed binomial p-value P(X >= correct | n = total, p = 0.5)
 * safely in log-domain without factorial overflow even at high trial counts.
 * @param {number} correct - Number of correct X identifications [0..total].
 * @param {number} total - Total trials (>= 1).
 * @returns {number} Exact p-value in [0, 1].
 */
export function computeAbxBinomialPValue(correct, total) {
  const n = Math.floor(Number(total) || 0);
  const c = Math.floor(Number(correct) || 0);
  if (n <= 0) return 1.0;
  if (c <= 0) return 1.0;
  if (c > n) return 0.0;

  const logFact = [0];
  for (let i = 1; i <= n; i++) {
    logFact[i] = logFact[i - 1] + Math.log(i);
  }
  const nLn2 = n * Math.LN2;
  let sum = 0;
  for (let k = c; k <= n; k++) {
    const logProb = logFact[n] - logFact[k] - logFact[n - k] - nLn2;
    sum += Math.exp(logProb);
  }
  return Math.max(0, Math.min(1, Number(sum.toFixed(6))));
}

/**
 * Summarizes completed or live ABX double-blind listening statistics.
 * @param {{ correct: number, total: number, labelA?: string, labelB?: string }} opts - ABX tallies.
 * @returns {{ correct: number, total: number, accuracyPct: number, pValue: number, confidencePct: number, significant: boolean, summary: string }}
 */
export function evaluateAbxVerdict({ correct = 0, total = 0, labelA = 'A', labelB = 'B' } = {}) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const c = Math.max(0, Math.min(n, Math.floor(Number(correct) || 0)));
  if (n === 0) {
    return { correct: 0, total: 0, accuracyPct: 0, pValue: 1.0, confidencePct: 0, significant: false, summary: 'No completed trials yet' };
  }
  const pValue = computeAbxBinomialPValue(c, n);
  const accuracyPct = Number(((c / n) * 100).toFixed(1));
  const confidencePct = Number(((1 - pValue) * 100).toFixed(2));
  const significant = pValue < 0.05;
  const summary = significant
    ? `Audible difference detected between ${labelA} and ${labelB} (p=${pValue}, ${confidencePct}% confidence)`
    : `No statistically significant difference detected (p=${pValue}, guessing threshold >= 0.05)`;
  return { correct: c, total: n, accuracyPct, pValue, confidencePct, significant, summary };
}

/**
 * Generates a cryptographically uniform sequence of 'A' / 'B' target assignments for ABX blind tests.
 * @param {number} [totalTrials=12] - Number of trials [1..50].
 * @param {Function|null} [rngBytesFn=null] - Optional deterministic RNG byte provider for unit tests.
 * @returns {Array<'A' | 'B'>}
 */
export function generateAbxTrialSequence(totalTrials = 12, rngBytesFn = null) {
  const count = Math.max(1, Math.min(50, Math.round(Number(totalTrials) || 12)));
  const bytes = new Uint8Array(count);
  if (typeof rngBytesFn === 'function') {
    const provided = rngBytesFn(count);
    for (let i = 0; i < count; i++) bytes[i] = Number(provided[i]) & 0xff;
  } else if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    throw new Error('Cryptographic RNG unavailable for blind ABX trial generation');
  }
  return Array.from(bytes, (b) => ((b & 1) === 0 ? 'A' : 'B'));
}

/**
 * Builds human-readable Bit-Audit, True-Peak dBTP, and Crest/DR summary badges from live C++ telemetry.
 * @param {object} [opts={}] - Live engine telemetry, probe, and signal mode context.
 * @returns {{ truePeakText: string, crestDrText: string, bitAuditText: string, bitAuditTone: string }}
 */
export function computeLiveBitAuditSummary({ telemetry = null, probe = null, wasapiEvt = null, isDsd = false } = {}) {
  const tp = Number(telemetry?.truePeakDbtp);
  const crest = Number(telemetry?.crestDb);
  const dr = Number(telemetry?.drDb);
  const truePeakText = Number.isFinite(tp) && tp > -119 ? `${tp >= 0 ? '+' : ''}${tp.toFixed(1)} dBTP` : '-- dBTP';
  const crestDrText = Number.isFinite(dr) && dr > 0
    ? `DR ${dr.toFixed(1)} dB (Crest ${(Number.isFinite(crest) ? crest : dr).toFixed(1)} dB)`
    : (Number.isFinite(crest) && crest > 0 ? `Crest ${crest.toFixed(1)} dB` : 'DR --');

  if (isDsd || wasapiEvt?.mode === 'dop_exclusive' || wasapiEvt?.mode === 'asio_dsd_raw') {
    return { truePeakText, crestDrText, bitAuditText: 'Bit-Audit: 1-bit DSD Stream', bitAuditTone: 'dop' };
  }
  const activeBits = Number(telemetry?.activeBits) || 0;
  const srcActiveBits = Number(telemetry?.srcActiveBits) || 0;
  const nominalSrcBits = Number(probe?.bitDepth) || 0;
  const inFmt = String(wasapiEvt?.inFmt || '').toLowerCase();

  let bitAuditText = 'Bit-Audit: Idle';
  let bitAuditTone = 'neutral';
  if (inFmt === 'f64le' || inFmt === 'f32le') {
    const outTag = activeBits > 0 ? `${activeBits}-bit Wire` : 'Precision Wire';
    bitAuditText = `Bit-Audit: 64f Pipe -> ${outTag}`;
    bitAuditTone = 'purepath';
  } else if (srcActiveBits > 0) {
    if (nominalSrcBits >= 24 && srcActiveBits <= 16) {
      bitAuditText = `Bit-Audit: 16-in-${nominalSrcBits} Padded`;
      bitAuditTone = 'warn';
    } else {
      bitAuditText = `Bit-Audit: ${srcActiveBits}-bit Active -> ${activeBits || srcActiveBits}-bit Wire`;
      bitAuditTone = wasapiEvt?.bitExact ? 'bit_exact' : 'purepath';
    }
  } else if (wasapiEvt?.validBits || wasapiEvt?.bitsPerSample) {
    const wb = wasapiEvt.validBits || wasapiEvt.bitsPerSample;
    bitAuditText = `Bit-Audit: ${wb}-bit Wire Ready`;
    bitAuditTone = wasapiEvt?.bitExact ? 'bit_exact' : 'purepath';
  }
  return { truePeakText, crestDrText, bitAuditText, bitAuditTone };
}

/**
 * Builds structured Live Signal Path stages for audiophile telemetry and popover inspection.
 * @param {object} [ctx={}] - Active playback telemetry context.
 * @returns {{ qualityBadge: string, qualityTone: string, summaryLabel: string, stages: Array<object> }}
 */
export function buildSignalPathDescriptor(ctx = {}) {
  const engineMode = ctx.engineMode === 'wasapi' && !ctx.isVideo ? 'wasapi' : 'dsp';
  const probe = ctx.probe || null;
  const r128 = ctx.r128 || null;
  const wasapiEvt = ctx.wasapiEvent || null;
  const dsp = ctx.dspState || {};
  const gain = Number(ctx.linearGain);
  const effectiveGain = Number.isFinite(gain) ? gain : 1.0;

  const srcRate = Number(probe?.sampleRate) || 48000;
  const srcRateKhz = `${(srcRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
  const srcBits = probe?.bitDepth ? `${probe.bitDepth}-bit` : '16-bit';
  const srcCh = Number(probe?.channels) || 2;
  const srcChText = srcCh > 2 ? (srcCh === 6 ? '5.1' : srcCh === 8 ? '7.1' : `${srcCh}ch`) : '2.0 Stereo';
  const isSacdIso = Boolean(
    ctx.sacdTrack ||
      probe?.sacdTrack ||
      (probe?.codec && /SACD/i.test(probe.codec)) ||
      (ctx.filePath && /\.iso$/i.test(ctx.filePath) && (ctx.sacdArea || probe?.sacdArea))
  );
  const isWvDsd = Boolean(
    (probe?.codec && /DSD_WAVPACK/i.test(probe.codec)) ||
      (ctx.filePath && /\.wv$/i.test(ctx.filePath) && /DSD/i.test(probe?.codec || ''))
  );
  const isDsdSource = Boolean(
    isSacdIso ||
      isWvDsd ||
      (probe?.codec && /DSD/i.test(probe.codec)) ||
      (ctx.filePath && /\.(?:dsf|dff)$/i.test(ctx.filePath))
  );

  const stages = [];
  stages.push({
    key: 'source',
    title: isSacdIso ? 'SACD ISO ScarletBook Container' : (isWvDsd ? 'WavPack DSD Lossless Container' : 'Source Media Stream'),
    detail: probe
      ? `${probe.codec || (isSacdIso ? 'SACD DST/DSD' : 'PCM')} · ${isDsdSource ? '1-bit DSD' : srcBits} · ${srcRateKhz} · ${srcChText}`
      : (isSacdIso ? `SACD Track #${ctx.sacdTrack || 1} (${ctx.trackTitle || '1-bit DSD'})` : (ctx.trackTitle || 'Idle / No Media Loaded')),
    spec: isSacdIso
      ? `ScarletBook Area ${probe?.sacdArea || ctx.sacdArea || 1} · Trk ${probe?.sacdTrack || ctx.sacdTrack || 1}`
      : (r128?.integratedLufs !== undefined ? `EBU R128 ${r128.integratedLufs.toFixed(1)} LUFS` : 'Direct Storage Read'),
    status: isDsdSource || (probe?.bitDepth >= 24) || srcRate > 48000 ? 'bit_exact' : 'enhanced'
  });

  const eqGains = computeEffectiveEqGains(dsp);
  const eqActive = eqGains.some((v) => Math.abs(v) >= 0.01);
  const peqActive = Boolean(dsp.peqEnabled && Array.isArray(dsp.peqBands) && dsp.peqBands.length > 0);
  const convolverActive = Boolean(ctx.convolverActive || (dsp.convolverEnabled && dsp.convolverPath));
  const rgInfo = ctx.replayGainInfo || null;
  const rgMode = dsp.replayGainMode || 'track';
  const rgTargetLufs = Number(dsp.replayGainTargetLufs) === -14 ? -14 : -18;
  const rgActive = Boolean(dsp.lufs && rgMode !== 'off' && ((rgInfo && !['off', 'none', 'unmeasured', 'bypassed'].includes(rgInfo.source)) || r128?.integratedLufs !== undefined));
  const rgLabel = rgActive
    ? `ReplayGain 2.0 (${(rgInfo?.source?.includes('album') || rgMode === 'album') ? 'Album' : 'Track'} @ ${rgTargetLufs} LUFS, ${(rgInfo?.appliedDb !== undefined ? rgInfo.appliedDb : 20 * Math.log10(Math.max(0.05, r128?.linearGain || 1))).toFixed(1)} dB)`
    : null;
  const anyPurePathDsp = Boolean(eqActive || peqActive || convolverActive || dsp.bassBoost || dsp.crossfeed || dsp.limiter || Math.abs(effectiveGain - 1.0) >= 1e-4);
  const bitAudit = computeLiveBitAuditSummary({
    telemetry: ctx.liveTelemetry || null,
    probe,
    wasapiEvt,
    isDsd: isDsdSource
  });

  if (engineMode === 'wasapi') {
    const outRate = Number(wasapiEvt?.sampleRate) || Number(ctx.ratePlan?.targetRate) || (isDsdSource ? 352800 : Math.min(768000, srcRate));
    const outRateKhz = `${(outRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
    const isAsioRawDsd = wasapiEvt?.mode === 'asio_dsd_raw';
    const isAsioPcm = wasapiEvt?.mode === 'asio';
    const isDop = wasapiEvt?.mode === 'dop_exclusive';
    const isSharedMode = wasapiEvt?.mode === 'shared' || ctx.ratePlan?.useExclusive === false;
    const isSharedFallback = isSharedMode || ctx.ratePlan?.reason === 'shared_fallback_endpoint';
    const isPush = Boolean(wasapiEvt?.pushMode ?? ctx.pushMode);
    const inFmt = String(wasapiEvt?.inFmt || ctx.inFmt || '').toLowerCase();
    const xrunCount = Math.max(0, Number(ctx.xrunCount ?? wasapiEvt?.xrunCount ?? 0) || 0);
    const volMode = ctx.volumeMode || 'auto';
    const hwSupportsVol = Boolean((Number(ctx.caps?.hwVolumeSupport) || 0) & 1);
    const swVolActive = Math.abs(effectiveGain - 1.0) >= 1e-4;
    const isBitExact = !isSharedMode && !peqActive && !convolverActive && (
      wasapiEvt?.bitExact !== undefined
        ? Boolean(wasapiEvt.bitExact)
        : (!isDop && !isAsioRawDsd && !anyPurePathDsp && inFmt !== 'f64le' && inFmt !== 'f32le' && !(probe && outRate !== srcRate))
    );

    if (isAsioRawDsd) {
      stages.push({
        key: 'decoder',
        title: isSacdIso ? 'SACD ScarletBook -> Raw DSD Extractor' : 'Native Raw DSD Octet Demuxer',
        detail: `Raw 1-bit DSD octets streamed natively (${wasapiEvt?.dsdRate || 'DSD512'}) — zero DoP packing, zero PCM conversion`,
        spec: 'Native 1-bit DSD512/1024 · Zero Resampling',
        status: 'dop'
      });
      stages.push({
        key: 'processing',
        title: 'ASIO Direct DSD Transport',
        detail: 'Pure 0 dBFS Unity Bypass · Native 1-bit octets routed straight to ASIO ASIOSTDSDInt8 hardware buffer',
        spec: 'Zero PCM Math · Native DSD Clock',
        status: 'dop'
      });
    } else if (isDop) {
      stages.push({
        key: 'decoder',
        title: isSacdIso ? 'SACD ScarletBook -> DoP v1.1 Packer' : 'DoP v1.1 Bitstream Packer',
        detail: `Raw DSD frames packed directly into 24-bit PCM DoP markers (${wasapiEvt?.dsdRate || 'DSD'})`,
        spec: 'Zero PCM Conversion · Zero Resampling',
        status: 'dop'
      });
      stages.push({
        key: 'processing',
        title: 'Direct Bitstream Transport',
        detail: 'Pure 0 dBFS Unity Bypass · DSP disabled to protect DSD integrity',
        spec: 'Integer Marker-Exact',
        status: 'dop'
      });
    } else {
      const rateConverted = isDsdSource || Boolean(ctx.ratePlan?.resampled) || (probe && outRate !== srcRate);
      const isFloatPipe = inFmt === 'f64le' || inFmt === 'f32le';
      stages.push({
        key: 'decoder',
        title: rateConverted
          ? '64-Bit Kaiser-Sinc Resampler'
          : (isFloatPipe ? '64-Bit Float Headroom Decoder' : 'Lossless PCM Decoder'),
        detail: isDsdSource
          ? `FFmpeg${isSacdIso ? ' ScarletBook + DST' : isWvDsd ? ' WavPack DSD' : ''} 64-bit dblp Kaiser-Sinc (256-tap, beta=16) DSD -> DXD ${outRateKhz}`
          : (rateConverted
            ? `FFmpeg 64-bit dblp Kaiser-Sinc (256-tap, beta=16) ${srcRateKhz} -> ${outRateKhz}`
            : (isFloatPipe
              ? `FFmpeg 64-bit IEEE float (pcm_f64le) @ ${outRateKhz} (inter-sample headroom preserved)`
              : `FFmpeg native PCM pass-through at ${outRateKhz} (32-bit MSB aligned)`)),
        spec: rateConverted
          ? 'tsf=dblp · cutoff=0.95 · exact_rational=1'
          : (isFloatPipe ? 'Zero Clipping Lossy/Float Pipe' : 'Zero Resampling · Native Clock'),
        status: (rateConverted || isFloatPipe) ? 'purepath' : 'bit_exact'
      });

      const activeModules = [];
      if (eqActive) {
        activeModules.push(
          dsp.deviceProfile && dsp.deviceProfile !== 'Bit-Perfect (Flat)' && dsp.deviceProfile !== 'Studio Monitors'
            ? `10-Band EQ + ${dsp.deviceProfile}`
            : '10-Band Parametric EQ'
        );
      }
      if (peqActive) {
        activeModules.push(`AutoEQ PEQ (${dsp.peqName ? `${dsp.peqName} · ` : ''}${dsp.peqBands.length} bands)`);
      }
      if (convolverActive) {
        const taps = ctx.convolverTaps || dsp.convolverTaps;
        const irName = ctx.convolverName || dsp.convolverName || 'Room/HP IR';
        const wet = Math.round(ctx.convolverWetPct ?? dsp.convolverWetPct ?? 100);
        activeModules.push(`64-Bit FFT Convolver (${irName}${taps ? ` · ${taps}t` : ''} · ${wet}%)`);
      }
      if (dsp.bassBoost) activeModules.push(`Sub-Bass +${Number(dsp.bassBoostDb ?? 5.5).toFixed(1)} dB`);
      if (dsp.crossfeed) activeModules.push(`Bauer Crossfeed ${Math.round(dsp.crossfeedLevelPct ?? 55)}%`);
      if (rgLabel) activeModules.push(rgLabel);
      if (swVolActive) {
        activeModules.push(`64-Bit Software Volume (${(20 * Math.log10(Math.max(0.0001, effectiveGain))).toFixed(1)} dB)`);
      } else if (volMode === 'fixed0db') {
        activeModules.push('Fixed 0 dBFS Output');
      } else if (hwSupportsVol && !isAsioPcm) {
        activeModules.push('Hardware Endpoint Volume');
      }

      stages.push({
        key: 'processing',
        title: isBitExact
          ? (volMode === 'fixed0db' ? 'Fixed 0 dBFS Bit-Exact Bypass' : (isAsioPcm ? 'ASIO Bit-Exact Hardware Output' : 'Hardware Volume · Bit-Exact'))
          : 'PurePath 64 Audio Engine',
        detail: isBitExact
          ? 'All EQ, software gain, and DSP bypassed — untouched source integer bits'
          : `64-bit IEEE-754 double TDF-II chain: ${activeModules.join(' · ') || '64-Bit Precision Path'}`,
        spec: isBitExact ? 'Zero Math · Bit-For-Bit' : (swVolActive ? '64-Bit SW Volume + TPDF' : '64-Bit Float Precision'),
        status: isBitExact ? 'bit_exact' : 'purepath'
      });

      const wireBitsNow = wasapiEvt?.validBits || wasapiEvt?.bitsPerSample || 24;
      const smart24To16Dither = !isBitExact && wireBitsNow === 16 && ((probe?.bitDepth || 0) > 16 || isFloatPipe || rateConverted);
      stages.push({
        key: 'quantizer',
        title: isBitExact
          ? 'Bit-Exact Frame Aligner'
          : (smart24To16Dither ? '24->16 TPDF Dither & Limiter' : 'True-Peak Limiter & TPDF Dither'),
        detail: isBitExact
          ? `Raw ${wireBitsNow}-bit container copy (zero truncation, zero dither)`
          : `${dsp.limiter ? '4x Oversampled True-Peak Limiter (-0.3 dBFS)' : 'Auto Inter-Sample Guard'} + ${smart24To16Dither ? '16-Bit TPDF Dither' : 'TPDF Dither'}`,
        spec: isBitExact
          ? '100% Original LSBs'
          : (Number(ctx.preRollMs) > 0 ? `Zero-Harmonic Quantization · Pre-Roll ${ctx.preRollMs} ms` : 'Zero-Harmonic Quantization'),
        status: isBitExact ? 'bit_exact' : 'purepath'
      });
    }

    const modeLabel = isAsioRawDsd
      ? `Isolated ASIO Host · Native Raw DSD (${wasapiEvt?.dsdRate || 'DSD'})`
      : (isAsioPcm
        ? 'Isolated ASIO Host · Direct Driver Buffer'
        : (isSharedMode
          ? 'WASAPI Shared Fallback (OS Mixer)'
          : `WASAPI Exclusive · ${isPush ? 'Push Timer' : 'Event-Driven (MMCSS Pro Audio)'}`));
    const devLabel = wasapiEvt?.deviceName || ctx.deviceName || (isAsioRawDsd || isAsioPcm ? 'Active ASIO Driver' : 'Default Windows Audio Endpoint');
    const wireBits = wasapiEvt?.validBits || wasapiEvt?.bitsPerSample || (isAsioRawDsd ? 1 : 24);
    const xrunTag = `XRUNs: ${xrunCount}`;
    const gaplessTag = ctx.gaplessQueued
      ? (ctx.gaplessCrossFormat ? ' · Cross-Rate Preload Primed' : ' · 0 ms Gapless Primed')
      : '';
    stages.push({
      key: 'output',
      title: devLabel,
      detail: isAsioRawDsd
        ? `${modeLabel} · 1-bit Native @ ${outRateKhz}${gaplessTag}`
        : `${modeLabel} · ${outRateKhz} / ${wireBits}-bit${gaplessTag}`,
      spec: `${wasapiEvt?.bufferFrames ? `Buffer ${wasapiEvt.bufferFrames} frames` : 'Direct DAC Lock'} · ${xrunTag}`,
      status: isSharedFallback ? 'enhanced' : ((isDop || isAsioRawDsd) ? 'dop' : (isBitExact ? 'bit_exact' : 'purepath'))
    });

    const qualityTone = isSharedFallback ? 'shared' : ((isDop || isAsioRawDsd) ? 'dop' : (isBitExact ? 'bit_exact' : 'purepath'));
    const qualityBadge = isSharedFallback
      ? 'WASAPI SHARED FALLBACK'
      : (isAsioRawDsd
        ? 'ASIO NATIVE RAW DSD BITSTREAM'
        : (isDop
          ? 'NATIVE DoP v1.1 BITSTREAM'
          : (isAsioPcm
            ? (isBitExact ? 'ASIO BIT-EXACT LOSSLESS' : 'PUREPATH 64 · ASIO HOST')
            : (isBitExact ? 'BIT-EXACT LOSSLESS PATH' : 'PUREPATH 64 (64-BIT FLOAT)'))));
    const shortRate = `${(outRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz`;
    const summaryLabel = isSharedFallback
      ? `SHARED FALLBACK · ${shortRate}/${wireBits}bit`
      : (isAsioRawDsd
        ? `ASIO RAW ${wasapiEvt?.dsdRate || 'DSD'}`
        : (isDop
          ? `DoP v1.1 (${wasapiEvt?.dsdRate || 'DSD'})`
          : (isAsioPcm
            ? (isBitExact ? `BIT-EXACT · ASIO (${shortRate}/${wireBits}bit)` : `PUREPATH 64 · ASIO (${shortRate}/${wireBits}bit)`)
            : (isBitExact
              ? `BIT-EXACT · WASAPI (${shortRate}/${wireBits}bit)`
              : `PUREPATH 64 · WASAPI (${shortRate}/${wireBits}bit)`))));

    return { qualityBadge, qualityTone, summaryLabel, stages, xrunCount, bitAudit };
  }

  // Studio DSP (Web Audio 32-bit Float) path
  stages.push({
    key: 'decoder',
    title: isDsdSource ? '64-Bit Kaiser-Sinc + Shibata PCM' : 'Studio Media Decoder',
    detail: isDsdSource
      ? `FFmpeg${isSacdIso ? ' ScarletBook + DST' : isWvDsd ? ' WavPack DSD' : ''} 64-bit dblp Kaiser-Sinc -> 176.4 kHz / 24-bit WAV (Shibata dither)`
      : `Direct Chromium / FFmpeg ${ctx.isVideo ? 'A/V Sync' : '24-bit PCM'} feed`,
    spec: isDsdSource ? '128-Tap Sinc · Shibata Dither' : 'Lossless Input Bus',
    status: isDsdSource ? 'purepath' : 'enhanced'
  });

  const studioFx = [];
  if (rgLabel) studioFx.push(rgLabel);
  if (peqActive) studioFx.push(`AutoEQ PEQ (${dsp.peqBands.length} bands)`);
  if (convolverActive) studioFx.push(`FFT Convolver (${ctx.convolverName || dsp.convolverName || 'IR'})`);
  if (Math.abs(Number(dsp.pitchSemitones) || 0) >= 0.05) studioFx.push(`Hermite/Hann Pitch (${dsp.pitchSemitones} st)`);
  if (eqActive) studioFx.push('10-Band EQ');
  if (dsp.bassBoost) studioFx.push(`Sub-Bass +${Number(dsp.bassBoostDb ?? 5.5).toFixed(1)} dB`);
  if (dsp.spatial) studioFx.push(`LR4 3D Spatial (${Math.round(dsp.spatialWidthPct ?? 135)}%)`);
  if (dsp.crossfeed) studioFx.push(`Bauer Crossfeed`);
  if (dsp.exciter) studioFx.push('Harmonic Exciter');
  if (dsp.reverb) studioFx.push('Hall Reverb');
  if (dsp.vinyl || dsp.saturation) studioFx.push(dsp.vinyl ? 'Vinyl Soul' : 'Tube Warmth');
  if (dsp.karaoke) studioFx.push('Vocal Cancel');
  if (dsp.nightMode) studioFx.push('Night Dynamics');
  if ((Number(dsp.crossfadeSeconds) || 0) > 0) studioFx.push(`Crossfade ${dsp.crossfadeSeconds}s`);

  stages.push({
    key: 'processing',
    title: 'Studio DSP Graph (32-Bit Float)',
    detail: studioFx.length ? studioFx.join(' · ') : 'Transparent Unity Web Audio Graph',
    spec: dsp.limiter !== false ? 'Limiter (-1.5 dBFS) Engaged' : 'Uncompressed Bus',
    status: 'dsp'
  });

  stages.push({
    key: 'output',
    title: ctx.deviceName || 'Windows Audio Mixer',
    detail: 'Shared Audio Output (32-bit Float)',
    spec: ctx.isVideo ? 'Direct GPU Video Synced' : 'Low-Latency Deck',
    status: 'dsp'
  });

  return {
    qualityBadge: 'STUDIO DSP (32-BIT FLOAT)',
    qualityTone: 'dsp',
    summaryLabel: 'STUDIO DSP (32-BIT FLOAT)',
    stages,
    bitAudit
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
    this.peqPreampNode = null;
    this.peqNodes = [];
    this.subBassLowShelf = null;
    this.subBassPunch = null;
    this.irConvolverNode = null;
    this.irDryGain = null;
    this.irWetGain = null;
    this.irBusIn = null;
    this.irBusOut = null;
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
    this.preMasterBus = null;
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
      limiter: false,
      nightMode: false,
      eqEnabled: false,
      karaoke: false,
      vinyl: false,
      lufs: false, // Bit-Perfect Pure default; enabled in Studio DSP preset
      replayGainMode: 'track', // 'off' | 'track' | 'album' (active when `lufs` is true)
      replayGainTargetLufs: -18, // -18 (Audiophile ReplayGain 2.0) | -14 (Modern Streaming)
      volumeMode: 'auto', // 'auto' | 'software' | 'fixed0db'
      reverb: false,
      reverbMixPct: 22,
      saturation: false,
      bassBoost: false,
      bassBoostDb: 5.5,
      pitchSemitones: 0,
      playbackRate: 1.0,
      crossfadeSeconds: 0.0, // Default Gapless (0s), switchable to 3s/6s/10s
      replayGainLinear: 1.0,
      volume: 1.0,
      peqEnabled: false,
      peqName: '',
      peqPreampDb: 0,
      peqBands: [],
      convolverEnabled: false,
      convolverPath: '',
      convolverName: '',
      convolverWetPct: 100,
      convolverTaps: 0,
      convolverSampleRate: 0,
      convolverChannels: 0
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
      this.peqPreampNode = null;
      this.peqNodes = [];
      this.subBassLowShelf = null;
      this.subBassPunch = null;
      this.irConvolverNode = null;
      this.irDryGain = null;
      this.irWetGain = null;
      this.irBusIn = null;
      this.irBusOut = null;
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
      this.preMasterBus = null;
      this.masterGain = null;

      const needsClone = hadConnectedNodes || Boolean(this.deckAEl?.error) || Boolean(this.deckBEl?.error);
      if (needsClone) {
        this._recreateMediaElements(true);
      }
    }
  }

  /**
   * Clones deck/video elements cleanly without src or stale listener guard attributes,
   * then notifies app orchestration to re-attach timeline/ended listeners.
   * @param {boolean} [resetDeck=false] - Whether to reset activeDeck back to 'A'.
   */
  _recreateMediaElements(resetDeck = false) {
    const cloneClean = (el) => {
      if (!el || !el.parentNode) return el;
      el.pause();
      const clone = el.cloneNode(false);
      clone.removeAttribute('src');
      clone.removeAttribute('data-vanta-bound');
      clone.removeAttribute('data-vanta-theater-bound');
      el.replaceWith(clone);
      return clone;
    };
    this.deckAEl = cloneClean(this.deckAEl);
    this.deckBEl = cloneClean(this.deckBEl);
    this.videoEl = cloneClean(this.videoEl);
    if (resetDeck) {
      this.activeDeck = 'A';
    }
    if (typeof this.onElementsRecreated === 'function') {
      this.onElementsRecreated({
        deckAEl: this.deckAEl,
        deckBEl: this.deckBEl,
        videoEl: this.videoEl
      });
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
        this._recreateMediaElements(false);
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

    // 9. Master Gain & Pre-Volume 60 FPS FFT AnalyserNode
    this.preMasterBus = this.ctx.createGain();
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.state.volume;

    this.analyserNode = this.ctx.createAnalyser();
    this.analyserNode.fftSize = 1024;
    this.analyserNode.smoothingTimeConstant = 0.62;

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

    this.peqPreampNode = this.ctx.createGain();
    this.peqPreampNode.gain.value = 1.0;

    this.irBusIn = this.ctx.createGain();
    this.irBusOut = this.ctx.createGain();
    this.irDryGain = this.ctx.createGain();
    this.irWetGain = this.ctx.createGain();
    this.irDryGain.gain.value = 1.0;
    this.irWetGain.gain.value = 0.0;
    this.irConvolverNode = this.ctx.createConvolver();
    this.irConvolverNode.normalize = false;

    const eqExit = this.eqNodes[this.eqNodes.length - 1];
    eqExit.connect(this.peqPreampNode);
    this._rebuildStudioPeqGraph();
    this.subBassLowShelf.connect(this.subBassPunch);

    // Saturation -> Custom Room/HP FFT IR Convolver dry/wet -> Reverb dry/wet -> Limiter dry/wet -> Master
    this.saturationNode.connect(this.irBusIn);
    this.irBusIn.connect(this.irDryGain);
    this.irDryGain.connect(this.irBusOut);
    this.irBusIn.connect(this.irConvolverNode);
    this.irConvolverNode.connect(this.irWetGain);
    this.irWetGain.connect(this.irBusOut);

    const reverbSum = this.ctx.createGain();
    this.irBusOut.connect(this.reverbDryGain);
    this.irBusOut.connect(this.reverbPreDelay);
    this.reverbPreDelay.connect(this.convolverNode);
    this.convolverNode.connect(this.reverbWetGain);
    this.reverbDryGain.connect(reverbSum);
    this.reverbWetGain.connect(reverbSum);

    reverbSum.connect(this.compDryGain);
    reverbSum.connect(this.compressorNode);
    this.compressorNode.connect(this.compWetGain);
    this.compDryGain.connect(this.preMasterBus);
    this.compWetGain.connect(this.preMasterBus);

    // Side-tap FFT analyser BEFORE masterGain so low volume does not starve visualizers or Stage FX
    this.preMasterBus.connect(this.analyserNode);
    this.preMasterBus.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);

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

    // 4th-Order Linkwitz-Riley (LR4) crossover at 160 Hz keeps sub-bass anchored in center
    // while matching Mid/Side phase via a 2nd-order allpass compensation filter on the Mid bus.
    const lrQ = Math.SQRT1_2;
    const midPhaseAlign = this.ctx.createBiquadFilter();
    midPhaseAlign.type = 'allpass';
    midPhaseAlign.frequency.value = 160;
    midPhaseAlign.Q.value = lrQ;

    const sideHighPass1 = this.ctx.createBiquadFilter();
    sideHighPass1.type = 'highpass';
    sideHighPass1.frequency.value = 160;
    sideHighPass1.Q.value = lrQ;
    const sideHighPass2 = this.ctx.createBiquadFilter();
    sideHighPass2.type = 'highpass';
    sideHighPass2.frequency.value = 160;
    sideHighPass2.Q.value = lrQ;

    const sideLowPass1 = this.ctx.createBiquadFilter();
    sideLowPass1.type = 'lowpass';
    sideLowPass1.frequency.value = 160;
    sideLowPass1.Q.value = lrQ;
    const sideLowPass2 = this.ctx.createBiquadFilter();
    sideLowPass2.type = 'lowpass';
    sideLowPass2.frequency.value = 160;
    sideLowPass2.Q.value = lrQ;

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
    lMid.connect(midPhaseAlign);
    rMid.connect(midPhaseAlign);
    midPhaseAlign.connect(this.spatialMidGain);

    spSplit.connect(lSide, 0);
    spSplit.connect(rSideNeg, 1);
    lSide.connect(sideHighPass1);
    rSideNeg.connect(sideHighPass1);
    sideHighPass1.connect(sideHighPass2);
    lSide.connect(sideLowPass1);
    rSideNeg.connect(sideLowPass1);
    sideLowPass1.connect(sideLowPass2);

    sideHighPass2.connect(this.spatialSideGain);
    this.spatialSideGain.connect(this.spatialHaasDelay);
    this.spatialHaasDelay.connect(sideBus);
    sideLowPass2.connect(sideLowUnity);
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
  /**
   * Rebuilds the Web Audio Studio DSP BiquadFilterNode chain for AutoEQ 32-band PEQ profiles.
   */
  _rebuildStudioPeqGraph() {
    if (!this.ctx || !this.peqPreampNode || !this.subBassLowShelf) return;
    try { this.peqPreampNode.disconnect(); } catch { /* ignore */ }
    for (const n of this.peqNodes) {
      try { n.disconnect(); } catch { /* ignore */ }
    }
    this.peqNodes = [];

    const typeMap = { PK: 'peaking', LSC: 'lowshelf', HSC: 'highshelf', LPQ: 'lowpass', HPQ: 'highpass', NO: 'notch', AP: 'allpass' };
    const bands = (this.state.peqEnabled && Array.isArray(this.state.peqBands)) ? this.state.peqBands.slice(0, 32) : [];
    let prev = this.peqPreampNode;
    for (const band of bands) {
      const wType = typeMap[String(band.type || 'PK').toUpperCase()];
      if (!wType) continue;
      const node = this.ctx.createBiquadFilter();
      node.type = wType;
      const maxFreq = Math.min(22000, (this.ctx.sampleRate || 48000) * 0.48);
      node.frequency.value = Math.max(10, Math.min(maxFreq, Number(band.freqHz) || 1000));
      node.Q.value = Math.max(0.05, Math.min(30, Number(band.q) || 0.7071));
      node.gain.value = Math.max(-30, Math.min(30, Number(band.gainDb) || 0));
      prev.connect(node);
      prev = node;
      this.peqNodes.push(node);
    }
    prev.connect(this.subBassLowShelf);
  }

  /**
   * Applies an AutoEQ / EqualizerAPO Parametric EQ configuration and rebuilds the filter graph.
   * @param {{ enabled?: boolean, name?: string, preampDb?: number, bands?: Array<object> }} cfg - PEQ profile.
   */
  applyAutoEqProfile(cfg = {}) {
    this.state.peqEnabled = cfg.enabled !== false && (Array.isArray(cfg.bands) && cfg.bands.length > 0 || Math.abs(Number(cfg.preampDb) || 0) >= 0.01);
    this.state.peqName = typeof cfg.name === 'string' ? cfg.name : '';
    this.state.peqPreampDb = Number.isFinite(Number(cfg.preampDb)) ? Math.max(-30, Math.min(18, Number(cfg.preampDb))) : 0;
    this.state.peqBands = Array.isArray(cfg.bands) ? cfg.bands.slice(0, 32) : [];
    this._rebuildStudioPeqGraph();
    this.syncDspState();
  }

  /**
   * Decodes and attaches a custom WAV Impulse Response buffer for Studio DSP convolution.
   * @param {ArrayBuffer} wavBytes - Raw WAV binary bytes.
   */
  async setStudioConvolverIrBytes(wavBytes) {
    if (!this.ctx || !this.irConvolverNode || !wavBytes) return false;
    try {
      const decoded = await this.ctx.decodeAudioData(wavBytes.slice(0));
      this.irConvolverNode.buffer = decoded;
      this.syncDspState();
      return true;
    } catch {
      return false;
    }
  }

  syncDspState() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    const now = this.ctx.currentTime;

    let maxPositiveBoost = 0;
    const effectiveEqGains = computeEffectiveEqGains(this.state);
    this.eqNodes.forEach((node, idx) => {
      const targetGain = effectiveEqGains[idx] ?? 0;
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

    if (this.peqPreampNode) {
      const peqGain = this.state.peqEnabled ? Math.pow(10, Math.max(-30, Math.min(18, Number(this.state.peqPreampDb) || 0)) / 20) : 1.0;
      this.peqPreampNode.gain.setTargetAtTime(peqGain, now, 0.02);
    }

    if (this.irDryGain && this.irWetGain) {
      const useIr = Boolean(this.state.convolverEnabled && this.irConvolverNode?.buffer);
      const rawWet = this.state.convolverWetPct ?? 100;
      const wetNum = Number.isFinite(Number(rawWet)) ? Number(rawWet) : 100;
      const irWet = useIr ? Math.max(0, Math.min(1, wetNum / 100)) : 0.0;
      this.irWetGain.gain.setTargetAtTime(irWet, now, 0.025);
      this.irDryGain.gain.setTargetAtTime(useIr ? (1.0 - irWet) : 1.0, now, 0.025);
    }

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
   * Resets all coloring/spatial FX back to strict Bit-Perfect Pure transparency (zero DSP/LUFS/limiter).
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
    this.state.limiter = false;
    this.state.lufs = false;
    this.state.peqEnabled = false;
    this.state.convolverEnabled = false;
    this._rebuildStudioPeqGraph();
    this.syncDspState();
  }

  /**
   * Applies the one-click Studio DSP mastering profile (LUFS ReplayGain + True-Peak Limiter).
   */
  applyStudioDspPreset() {
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
      replayGainMode: this.state.replayGainMode,
      replayGainTargetLufs: this.state.replayGainTargetLufs,
      volumeMode: this.state.volumeMode,
      reverb: this.state.reverb,
      reverbMixPct: this.state.reverbMixPct,
      bassBoost: this.state.bassBoost,
      bassBoostDb: this.state.bassBoostDb,
      pitchSemitones: this.state.pitchSemitones,
      peqEnabled: Boolean(this.state.peqEnabled),
      peqName: String(this.state.peqName || ''),
      peqPreampDb: Number(this.state.peqPreampDb) || 0,
      peqBands: Array.isArray(this.state.peqBands) ? this.state.peqBands.slice(0, 32) : [],
      convolverEnabled: Boolean(this.state.convolverEnabled),
      convolverPath: String(this.state.convolverPath || ''),
      convolverName: String(this.state.convolverName || ''),
      convolverWetPct: Number.isFinite(Number(this.state.convolverWetPct)) ? Number(this.state.convolverWetPct) : 100,
      convolverTaps: Number(this.state.convolverTaps) || 0,
      convolverSampleRate: Number(this.state.convolverSampleRate) || 0,
      convolverChannels: Number(this.state.convolverChannels) || 0
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
    if (typeof saved.volumeMode === 'string' && ['auto', 'software', 'fixed0db'].includes(saved.volumeMode)) {
      this.state.volumeMode = saved.volumeMode;
    }
    if (typeof saved.replayGainMode === 'string' && ['off', 'track', 'album'].includes(saved.replayGainMode)) {
      this.state.replayGainMode = saved.replayGainMode;
    }
    if ([ -18, -14 ].includes(Number(saved.replayGainTargetLufs))) {
      this.state.replayGainTargetLufs = Number(saved.replayGainTargetLufs);
    }
    const numKeys = ['spatialWidthPct', 'crossfeedLevelPct', 'exciterMixPct', 'reverbMixPct', 'bassBoostDb', 'pitchSemitones'];
    for (const k of numKeys) {
      if (Number.isFinite(Number(saved[k]))) this.setDspParam(k, Number(saved[k]));
    }
    if (saved.deviceProfile && DEVICE_EQ_PROFILES[saved.deviceProfile]) {
      this.state.deviceProfile = saved.deviceProfile;
    }
    if (Array.isArray(saved.peqBands)) {
      this.state.peqBands = saved.peqBands.slice(0, 32);
    }
    if (typeof saved.peqName === 'string') this.state.peqName = saved.peqName;
    if (Number.isFinite(Number(saved.peqPreampDb))) this.state.peqPreampDb = Math.max(-30, Math.min(18, Number(saved.peqPreampDb)));
    if (typeof saved.peqEnabled === 'boolean') this.state.peqEnabled = saved.peqEnabled;
    if (typeof saved.convolverPath === 'string') this.state.convolverPath = saved.convolverPath;
    if (typeof saved.convolverName === 'string') this.state.convolverName = saved.convolverName;
    if (Number.isFinite(Number(saved.convolverWetPct))) this.state.convolverWetPct = Math.max(0, Math.min(100, Number(saved.convolverWetPct)));
    if (Number.isFinite(Number(saved.convolverTaps))) this.state.convolverTaps = Number(saved.convolverTaps);
    if (Number.isFinite(Number(saved.convolverSampleRate))) this.state.convolverSampleRate = Number(saved.convolverSampleRate);
    if (Number.isFinite(Number(saved.convolverChannels))) this.state.convolverChannels = Number(saved.convolverChannels);
    if (typeof saved.convolverEnabled === 'boolean') this.state.convolverEnabled = saved.convolverEnabled && Boolean(this.state.convolverPath);
    this._rebuildStudioPeqGraph();
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
