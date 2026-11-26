'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const logger = require('./loggerService.cjs');
const { validateSafeFilePath, validateSafeSacdIsoPath } = require('./pathSecurityService.cjs');
const {
  parseReplayGainDbValue,
  parseReplayGainPeakValue,
  formatReplayGainDb,
  formatReplayGainPeak,
  readId3v2FromFile,
  updateMp3MetadataOnDisk,
  readFlacMetadataFromFile,
  updateFlacVorbisTagsOnDisk
} = require('./id3Service.cjs');

const execFileAsync = promisify(execFile);

const BRIDGE_MEDIA_EXTENSIONS = new Set([
  '.mp3', '.flac', '.wav', '.w64', '.aiff', '.aif', '.alac', '.m4a', '.aac',
  '.ogg', '.opus', '.dsf', '.dff', '.ape', '.wv',
  '.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ts', '.mpg', '.mpeg', '.wmv', '.flv', '.3gp', '.ogv'
]);

let pipeSeq = 0;

/**
 * Resolves the bundled ffmpeg-static binary path (handling ASAR unpacking in packaged builds).
 * @returns {string} Absolute path to ffmpeg executable or empty string.
 */
function resolveFfmpegBinary() {
  try {
    let bin = require('ffmpeg-static') || '';
    if (bin.includes('app.asar') && !bin.includes('app.asar.unpacked')) {
      const unpacked = bin.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) {
        bin = unpacked;
      }
    }
    return bin && fs.existsSync(bin) ? bin : '';
  } catch {
    return '';
  }
}

/**
 * Resolves the native C++ WASAPI Exclusive engine executable path (dev or packaged Electron).
 * @returns {string} Absolute path to vanta-audio-engine.exe or empty string.
 */
function resolveWasapiEngineBinary() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'vanta-audio-engine.exe') : '',
    path.join(__dirname, '..', '..', 'bin', 'vanta-audio-engine.exe'),
    'C:\\Vanta\\bin\\vanta-audio-engine.exe'
  ].filter(Boolean);

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * Parses ffmpeg stderr stream information to extract codec, sampleRate, bitDepth, channels, bitrate, and duration.
 * @param {string} stderrText - Output from `ffmpeg -i <file>`.
 * @returns {{ codec: string, sampleRate: number, bitDepth: number, channels: number, bitrateKbps: number, durationSec: number }}
 */
function parseFfmpegProbeOutput(stderrText) {
  const text = String(stderrText || '');
  let durationSec = 0;
  const durMatch = /Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (durMatch) {
    durationSec =
      Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  }

  let codec = 'PCM';
  let sampleRate = 44100;
  let bitDepth = 16;
  let channels = 2;
  let bitrateKbps = 0;

  const lines = text.split(/\r?\n/);
  const audioRawLine = lines.find((ln) => ln.includes('Stream #') && /:\s?Audio:/i.test(ln));
  if (audioRawLine) {
    const audioMarkerIdx = audioRawLine.toLowerCase().indexOf('audio:');
    const info = audioMarkerIdx >= 0 ? audioRawLine.slice(audioMarkerIdx + 6).trim() : '';
    const codecMatch = /^([a-zA-Z0-9_.-]+)/.exec(info);
    if (codecMatch) codec = codecMatch[1].toUpperCase();

    const srMatch = /\b(\d{4,7}) ?Hz\b/i.exec(info);
    if (srMatch) sampleRate = Number(srMatch[1]);

    if (/\b7\.1\b/i.test(info)) channels = 8;
    else if (/\b6\.1\b/i.test(info)) channels = 7;
    else if (/\b5\.1\b/i.test(info)) channels = 6;
    else if (/\b5\.0\b/i.test(info)) channels = 5;
    else if (/\b(?:4\.0|quad|3\.1)\b/i.test(info)) channels = 4;
    else if (/\b(?:3\.0|2\.1)\b/i.test(info)) channels = 3;
    else if (/\bmono\b/i.test(info)) channels = 1;
    else {
      const chMatch = /\b([1-8])\s*channels\b/i.exec(info);
      if (chMatch) channels = Number(chMatch[1]);
    }

    if (/^DSD/i.test(codec)) {
      bitDepth = 1;
    } else if (/wavpack/i.test(codec) && /\bdsd_(?:lsbf|msbf)/i.test(info)) {
      codec = 'DSD_WAVPACK';
      bitDepth = 1;
    } else if (/\bs24\b|\(24 bit\)|24\s*bit|\bpcm_s24/i.test(info)) {
      bitDepth = 24;
    } else if (/\bs32\b|\(32 bit\)|32\s*bit|\bflt\b|\bfltp\b|\bpcm_s32|\bpcm_f32/i.test(info)) {
      bitDepth = 32;
    } else if (/flac|alac|wavpack|ape/i.test(codec)) {
      bitDepth = 24;
    }

    const brMatch = /\b(\d{1,6}) ?kb\/s\b/i.exec(info);
    if (brMatch) bitrateKbps = Number(brMatch[1]);
  }

  let videoCodec = '';
  let videoWidth = 0;
  let videoHeight = 0;
  const videoRawLine = lines.find((ln) => ln.includes('Stream #') && /:\s?Video:/i.test(ln));
  if (videoRawLine) {
    const videoMarkerIdx = videoRawLine.toLowerCase().indexOf('video:');
    const rest = videoMarkerIdx >= 0 ? videoRawLine.slice(videoMarkerIdx + 6).trim() : '';
    const commaIdx = rest.indexOf(',');
    const vHead = commaIdx >= 0 ? rest.slice(0, commaIdx) : rest;
    const vBody = commaIdx >= 0 ? rest.slice(commaIdx + 1) : '';
    let rawVc = vHead.split(/[(\s]+/)[0].trim().toUpperCase();
    if (rawVc === 'AV01') rawVc = 'AV1';
    else if (rawVc === 'H265') rawVc = 'HEVC';
    videoCodec = rawVc;
    const dim = /\b(\d{3,5})x(\d{3,5})\b/.exec(vBody);
    if (dim) {
      videoWidth = Number(dim[1]);
      videoHeight = Number(dim[2]);
    }
  }

  return {
    codec,
    sampleRate,
    bitDepth,
    channels,
    bitrateKbps,
    durationSec,
    videoCodec,
    videoWidth,
    videoHeight
  };
}

/**
 * Inspects a `.wv` file's 32-byte little-endian `wvpk` header for the DSD flag (`flags & 0x80000000`).
 * @param {string} filePath - Path to .wv file.
 * @returns {{ isWvDsd: boolean, blockSamples: number }}
 */
function inspectWavPackDsdHeader(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const hdr = Buffer.alloc(32);
    if (fs.readSync(fd, hdr, 0, 32, 0) === 32 && hdr.toString('ascii', 0, 4) === 'wvpk') {
      const flags = hdr.readUInt32LE(24);
      const isWvDsd = ((flags >>> 31) & 1) === 1;
      const blockSamples = hdr.readUInt32LE(20);
      return { isWvDsd, blockSamples };
    }
  } catch {
    // Ignore header probe errors
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
  return { isWvDsd: false, blockSamples: 0 };
}

/**
 * Probes exact audio technical metadata (codec, sample rate, bit depth, bitrate, duration) via ffmpeg-static.
 * @param {string} filePath - Media file path.
 * @returns {Promise<object>} Probed technical audio metrics.
 */
async function probeAudioStreamInfo(filePath) {
  const ffmpegBin = resolveFfmpegBinary();
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
  if (!ffmpegBin || !safePath) {
    return { codec: 'MP3', sampleRate: 44100, bitDepth: 16, channels: 2, bitrateKbps: 320, durationSec: 0 };
  }

  return new Promise((resolve) => {
    execFile(ffmpegBin, ['-hide_banner', '-i', safePath], { timeout: 8000 }, (_err, _stdout, stderr) => {
      const parsed = parseFfmpegProbeOutput(stderr || '');
      if (path.extname(safePath).toLowerCase() === '.wv') {
        const wvHdr = inspectWavPackDsdHeader(safePath);
        if (wvHdr.isWvDsd || parsed.codec === 'DSD_WAVPACK') {
          parsed.codec = 'DSD_WAVPACK';
          parsed.bitDepth = 1;
          parsed.isWvDsd = true;
          // FFmpeg often reports WavPack DSD stream byte rate (352.8k/705.6k) rather than 1-bit clock
          if (parsed.sampleRate >= 176400 && parsed.sampleRate <= 768000) {
            parsed.dsdClockRate = parsed.sampleRate * 8;
          }
        }
      }
      resolve(parsed);
    });
  });
}

/**
 * Extracts stream index and optional language tag from an ffmpeg `Stream #0:1[0x...](lang):` line.
 * @param {string} line - Single ffmpeg stderr line.
 * @returns {{ streamIndex: number, lang: string }|null}
 */
function parseStreamHeaderMeta(line) {
  const idxMatch = /^\s*Stream #\d+:(\d+)/i.exec(line);
  if (!idxMatch) return null;
  const colonIdx = line.indexOf(':', idxMatch[0].length - idxMatch[1].length);
  const headerSlice = colonIdx >= 0 ? line.slice(idxMatch[0].length, colonIdx) : '';
  const langMatch = /\(([^()\r\n]{1,32})\)/.exec(headerSlice);
  return {
    streamIndex: Number(idxMatch[1]),
    lang: (langMatch?.[1] || 'und').trim()
  };
}

/**
 * Parses full multi-stream video, audio, and subtitle metadata from ffmpeg stderr output.
 * @param {string} stderrText - Output emitted by `ffmpeg -hide_banner -i <file>`.
 * @returns {{ durationSec: number, video: object|null, audioStreams: object[], subtitleStreams: object[] }}
 */
function parseMediaContainerProbe(stderrText) {
  const text = String(stderrText || '');
  let durationSec = 0;
  const durMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(text);
  if (durMatch) {
    durationSec = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3]);
  }

  let video = null;
  const audioStreams = [];
  const subtitleStreams = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const hdr = parseStreamHeaderMeta(line);
    if (!hdr) continue;

    const videoIdx = line.search(/:\s*Video:/i);
    if (!video && videoIdx >= 0) {
      const rest = line.slice(line.indexOf('Video:', videoIdx) + 6).trim();
      const commaIdx = rest.indexOf(',');
      const codecPart = commaIdx >= 0 ? rest.slice(0, commaIdx) : rest;
      const info = commaIdx >= 0 ? rest.slice(commaIdx + 1).trim() : '';
      const codec = codecPart.split(/\s+/)[0].trim().toLowerCase();
      const dimMatch = /\b(\d{3,5})x(\d{3,5})\b/.exec(info);
      const width = dimMatch ? Number(dimMatch[1]) : 0;
      const height = dimMatch ? Number(dimMatch[2]) : 0;
      const fpsMatch = /\b(\d{1,4}(?:\.\d{1,4})?) ?fps\b/i.exec(info) || /\b(\d{1,4}(?:\.\d{1,4})?) ?tbr\b/i.exec(info);
      const fps = fpsMatch ? Number(fpsMatch[1]) : 30;
      const brMatch = /\b(\d{1,6}) ?kb\/s\b/i.exec(info);
      const bitrateKbps = brMatch ? Number(brMatch[1]) : 0;
      const pixMatch = /^([^,(]+)/.exec(info);
      const pixFmt = pixMatch ? pixMatch[1].trim() : '';
      video = {
        streamIndex: hdr.streamIndex,
        codec,
        pixFmt,
        width,
        height,
        fps,
        bitrateKbps,
        is4K: width >= 3500 || height >= 2000,
        isHdr: /10le|12le|p010|bt2020/i.test(info)
      };
      continue;
    }

    const audioIdx = line.search(/:\s*Audio:/i);
    if (audioIdx >= 0) {
      const rest = line.slice(line.indexOf('Audio:', audioIdx) + 6).trim();
      const commaIdx = rest.indexOf(',');
      const codecPart = commaIdx >= 0 ? rest.slice(0, commaIdx) : rest;
      const info = commaIdx >= 0 ? rest.slice(commaIdx + 1).trim() : '';
      const srMatch = /\b(\d{4,7}) ?Hz\b/i.exec(info);
      const channels = /\b7\.1\b/i.test(info) ? 8 : /\b5\.1\b/i.test(info) ? 6 : /\bmono\b/i.test(info) ? 1 : 2;
      audioStreams.push({
        streamIndex: hdr.streamIndex,
        relIndex: audioStreams.length,
        lang: hdr.lang,
        codec: codecPart.split(/\s+/)[0].trim().toLowerCase(),
        sampleRate: srMatch ? Number(srMatch[1]) : 48000,
        channels
      });
      continue;
    }

    const subIdx = line.search(/:\s*Subtitle:/i);
    if (subIdx >= 0) {
      const rest = line.slice(line.indexOf('Subtitle:', subIdx) + 9).trim();
      const codec = rest.split(/[,\s(]+/)[0].trim().toLowerCase();
      subtitleStreams.push({
        streamIndex: hdr.streamIndex,
        relIndex: subtitleStreams.length,
        lang: hdr.lang,
        codec,
        isBitmap: /pgs|dvd_subtitle|dvb_subtitle|xsub/i.test(codec)
      });
    }
  }

  return { durationSec, video, audioStreams, subtitleStreams };
}

/**
 * Probes full video, audio, and subtitle stream metadata via bundled ffmpeg.
 * @param {string} filePath - Video file path.
 * @returns {Promise<object>} Probed container and streams descriptor.
 */
async function probeMediaStreams(filePath) {
  const ffmpegBin = resolveFfmpegBinary();
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
  if (!ffmpegBin || !safePath) {
    return { durationSec: 0, video: null, audioStreams: [], subtitleStreams: [] };
  }
  return new Promise((resolve) => {
    execFile(ffmpegBin, ['-hide_banner', '-i', safePath], { timeout: 8000 }, (_err, _stdout, stderr) => {
      resolve(parseMediaContainerProbe(stderr || ''));
    });
  });
}

/**
 * Selects optimal 4K video playback pipeline:
 * - 'direct': zero-copy native Chromium hardware decode (MP4/WebM + browser-native codecs)
 * - 'remux-copy': zero video re-encode (-c:v copy) with AAC audio bridge for MKV/DTS/AC3/track switch
 * - 'transcode-h264': fallback H.264 stream for legacy non-browser video codecs
 * @param {string} filePath - Media file path.
 * @param {object} [probe] - Output of parseMediaContainerProbe().
 * @param {number} [requestedAudioRelIdx=0] - Selected relative audio stream index.
 * @returns {'direct'|'remux-copy'|'transcode-h264'}
 */
function decideVideoPlaybackStrategy(filePath, probe = {}, requestedAudioRelIdx = 0) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const vCodec = String(probe?.video?.codec || '').toLowerCase();
  const audioList = Array.isArray(probe?.audioStreams) ? probe.audioStreams : [];
  const activeAudio = audioList[requestedAudioRelIdx] || audioList[0];
  const aCodec = String(activeAudio?.codec || '').toLowerCase();

  const browserVideoCodecs = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1', 'hevc', 'h265']);
  const browserAudioCodecs = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', '']);
  const browserContainers = new Set(['.mp4', '.m4v', '.webm']);

  if (!vCodec || browserVideoCodecs.has(vCodec)) {
    if (
      browserContainers.has(ext) &&
      browserAudioCodecs.has(aCodec) &&
      requestedAudioRelIdx === 0 &&
      (activeAudio ? activeAudio.channels <= 2 || ext === '.mp4' : true)
    ) {
      return 'direct';
    }
    return 'remux-copy';
  }
  return 'transcode-h264';
}

/**
 * Converts SubRip (.srt) subtitle text into standard WebVTT format cleanly.
 * @param {string} srtText - Raw .srt contents.
 * @returns {string} WebVTT contents.
 */
function convertSrtToVtt(srtText) {
  const clean = String(srtText || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\s*WEBVTT/i.test(clean)) return clean;
  const converted = clean.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${converted.trim()}\n`;
}

/**
 * Parses ffmpeg EBU R128 loudness summary and calculates a true-peak-safe linear ReplayGain multiplier.
 * @param {string} stderrText - Output from `ffmpeg -af ebur128=framelog=quiet`.
 * @param {number} [targetLufs=-14.0] - Target integrated loudness in LUFS.
 * @returns {{ integratedLufs: number, truePeakDbfs: number, replayGainDb: number, linearGain: number }}
 */
function parseEbuR128Summary(stderrText, targetLufs = -14.0) {
  const text = String(stderrText || '');
  const iMatch = /Summary:[\s\S]*?I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/i.exec(text);
  const tpMatch = /Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/i.exec(text);

  const integratedLufs = iMatch ? Number(iMatch[1]) : targetLufs;
  const truePeakDbfs = tpMatch ? Number(tpMatch[1]) : -1.0;

  let desiredGainDb = targetLufs - integratedLufs;
  // Clamp ReplayGain to [-12 dB, +9 dB] and prevent inter-sample true peak clipping above -0.5 dBFS
  const maxSafeBoostDb = -0.5 - truePeakDbfs;
  desiredGainDb = Math.max(-12, Math.min(9, desiredGainDb, maxSafeBoostDb));

  const linearGain = Number(Math.pow(10, desiredGainDb / 20).toFixed(4));
  return {
    integratedLufs,
    truePeakDbfs,
    targetLufs,
    replayGainDb: Number(desiredGainDb.toFixed(2)),
    linearGain
  };
}

/**
 * Reads ReplayGain 2.0 Track & Album gain/peak tags from MP3 ID3v2 TXXX, FLAC VORBIS_COMMENT,
 * or container metadata (M4A/OGG/Opus/WV) via ffmpeg ffmetadata.
 * @param {string} filePath - Media file path.
 * @returns {Promise<{ replayGainTrackGainDb: number|null, replayGainTrackPeak: number|null, replayGainAlbumGainDb: number|null, replayGainAlbumPeak: number|null }>}
 */
async function readReplayGainTagsForFile(filePath) {
  const empty = {
    replayGainTrackGainDb: null,
    replayGainTrackPeak: null,
    replayGainAlbumGainDb: null,
    replayGainAlbumPeak: null
  };
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
  if (!safePath) return empty;
  const ext = path.extname(safePath).toLowerCase();
  if (ext === '.mp3') {
    const id3 = readId3v2FromFile(safePath);
    return {
      replayGainTrackGainDb: id3.replayGainTrackGainDb ?? null,
      replayGainTrackPeak: id3.replayGainTrackPeak ?? null,
      replayGainAlbumGainDb: id3.replayGainAlbumGainDb ?? null,
      replayGainAlbumPeak: id3.replayGainAlbumPeak ?? null
    };
  }
  if (ext === '.flac') {
    const flac = readFlacMetadataFromFile(safePath);
    return {
      replayGainTrackGainDb: flac.replayGainTrackGainDb ?? null,
      replayGainTrackPeak: flac.replayGainTrackPeak ?? null,
      replayGainAlbumGainDb: flac.replayGainAlbumGainDb ?? null,
      replayGainAlbumPeak: flac.replayGainAlbumPeak ?? null
    };
  }
  const ffmpegBin = resolveFfmpegBinary();
  if (!ffmpegBin) return empty;
  return new Promise((resolve) => {
    execFile(ffmpegBin, ['-hide_banner', '-loglevel', 'error', '-i', safePath, '-f', 'ffmetadata', '-'], { timeout: 6000 }, (_err, stdout) => {
      const out = { ...empty };
      for (const ln of String(stdout || '').split(/\r?\n/)) {
        const eq = ln.indexOf('=');
        if (eq <= 0) continue;
        const k = ln.slice(0, eq).trim().toUpperCase();
        const v = ln.slice(eq + 1).trim();
        if (k === 'REPLAYGAIN_TRACK_GAIN') out.replayGainTrackGainDb = parseReplayGainDbValue(v);
        else if (k === 'REPLAYGAIN_TRACK_PEAK') out.replayGainTrackPeak = parseReplayGainPeakValue(v);
        else if (k === 'REPLAYGAIN_ALBUM_GAIN') out.replayGainAlbumGainDb = parseReplayGainDbValue(v);
        else if (k === 'REPLAYGAIN_ALBUM_PEAK') out.replayGainAlbumPeak = parseReplayGainPeakValue(v);
      }
      resolve(out);
    });
  });
}

/**
 * Computes energy-weighted EBU R128 Album Loudness & Album True Peak from per-track measurements.
 * Follows standard ReplayGain 2.0 (-18.0 LUFS reference by default).
 * @param {Array<{ integratedLufs: number, truePeakDbfs: number, durationSec?: number }>} measurements
 * @param {number} [targetLufs=-18.0]
 * @returns {{ albumLufs: number, albumTruePeakDbfs: number, albumPeakLinear: number, albumGainDb: number }}
 */
function computeAlbumLoudnessSummary(measurements = [], targetLufs = -18.0) {
  const valid = (Array.isArray(measurements) ? measurements : []).filter(
    (m) => m && Number.isFinite(Number(m.integratedLufs)) && Number(m.integratedLufs) > -70
  );
  if (!valid.length) {
    return {
      albumLufs: targetLufs,
      albumTruePeakDbfs: -1.0,
      albumPeakLinear: 0.891251,
      albumGainDb: 0
    };
  }
  let weightedEnergySum = 0;
  let totalWeight = 0;
  let maxTruePeakDbfs = -120;
  for (const m of valid) {
    const dur = Math.max(1, Number(m.durationSec) || 180);
    const lufs = Number(m.integratedLufs);
    weightedEnergySum += dur * Math.pow(10, lufs / 10);
    totalWeight += dur;
    if (Number.isFinite(Number(m.truePeakDbfs))) {
      maxTruePeakDbfs = Math.max(maxTruePeakDbfs, Number(m.truePeakDbfs));
    }
  }
  const albumLufs = totalWeight > 0 ? Number((10 * Math.log10(weightedEnergySum / totalWeight)).toFixed(2)) : targetLufs;
  if (maxTruePeakDbfs <= -100) maxTruePeakDbfs = -1.0;
  const albumPeakLinear = Number(Math.pow(10, maxTruePeakDbfs / 20).toFixed(6));
  const maxSafeBoostDb = -0.5 - maxTruePeakDbfs;
  const rawAlbumGain = targetLufs - albumLufs;
  const albumGainDb = Number(Math.max(-18, Math.min(12, Math.min(rawAlbumGain, maxSafeBoostDb))).toFixed(2));
  return {
    albumLufs,
    albumTruePeakDbfs: Number(maxTruePeakDbfs.toFixed(2)),
    albumPeakLinear,
    albumGainDb
  };
}

/**
 * Measures integrated EBU R128 loudness and true peak for all tracks in an album group,
 * calculates both Track and Album ReplayGain 2.0 values (-18.0 LUFS standard), and
 * optionally embeds REPLAYGAIN_* tags safely on disk.
 * @param {Array<string|{ filePath: string, durationSec?: number }>} entries - Tracks belonging to one album.
 * @param {object} [options={}] - Options (`targetLufs=-18.0`, `writeTags=false`).
 * @returns {Promise<{ ok: boolean, albumSummary: object, tracks: Array<object> }>}
 */
async function analyzeAlbumReplayGain(entries = [], options = {}) {
  const refLufs = Number(options.targetLufs) === -14 ? -14.0 : -18.0;
  const writeTags = Boolean(options.writeTags);
  const measured = [];

  for (const item of Array.isArray(entries) ? entries : []) {
    const rawPath = typeof item === 'string' ? item : item?.filePath;
    const safePath = validateSafeFilePath(rawPath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
    if (!safePath) continue;
    const r128 = await measureEbuR128Loudness(safePath, refLufs);
    const trackPeak = Number(Math.pow(10, (Number(r128.truePeakDbfs) || -1.0) / 20).toFixed(6));
    measured.push({
      filePath: safePath,
      durationSec: typeof item === 'object' ? Number(item.durationSec) || 180 : 180,
      integratedLufs: r128.integratedLufs,
      truePeakDbfs: r128.truePeakDbfs,
      trackGainDb: r128.replayGainDb,
      trackPeakLinear: trackPeak
    });
  }

  const albumSummary = computeAlbumLoudnessSummary(measured, refLufs);
  const results = [];
  for (const t of measured) {
    const tagPatch = {
      replayGainTrackGainDb: t.trackGainDb,
      replayGainTrackPeak: t.trackPeakLinear,
      replayGainAlbumGainDb: albumSummary.albumGainDb,
      replayGainAlbumPeak: albumSummary.albumPeakLinear
    };
    let taggedOk = false;
    if (writeTags) {
      const ext = path.extname(t.filePath).toLowerCase();
      if (ext === '.mp3') {
        taggedOk = Boolean(updateMp3MetadataOnDisk(t.filePath, tagPatch)?.ok);
      } else if (ext === '.flac') {
        taggedOk = Boolean(updateFlacVorbisTagsOnDisk(t.filePath, tagPatch)?.ok);
      } else if (['.m4a', '.ogg', '.opus', '.wv', '.wav', '.aiff', '.aif'].includes(ext)) {
        taggedOk = Boolean((await writeFfmpegMetadataOnDisk(t.filePath, tagPatch))?.ok);
      }
    }
    results.push({
      ...t,
      albumGainDb: albumSummary.albumGainDb,
      albumPeakLinear: albumSummary.albumPeakLinear,
      albumLufs: albumSummary.albumLufs,
      albumTruePeakDbfs: albumSummary.albumTruePeakDbfs,
      taggedOk
    });
  }

  return { ok: true, albumSummary, tracks: results };
}

/**
 * Measures true EBU R128 integrated loudness and true peak for a media file without compressing dynamics.
 * @param {string} filePath - Media file path.
 * @param {number} [targetLufs=-14.0] - Target loudness in LUFS.
 * @returns {Promise<object>} EBU R128 measurement and safe ReplayGain multiplier.
 */
async function measureEbuR128Loudness(filePath, targetLufs = -14.0) {
  const ffmpegBin = resolveFfmpegBinary();
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
  if (!ffmpegBin || !safePath) {
    return { integratedLufs: targetLufs, truePeakDbfs: -1.0, replayGainDb: 0, linearGain: 1.0 };
  }

  return new Promise((resolve) => {
    execFile(
      ffmpegBin,
      ['-hide_banner', '-nostats', '-i', safePath, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024 },
      (_err, _stdout, stderr) => {
        resolve(parseEbuR128Summary(stderr || '', targetLufs));
      }
    );
  });
}

const knownWasapiDeviceIds = new Map();
const knownAsioDriverNames = new Map();
const deviceCapsCache = new Map();
const DEVICE_CAPS_CACHE_TTL_MS = 30000;

/**
 * Clears the cached WASAPI endpoint hardware capability map (e.g., after audio device hot-plug).
 */
function clearDeviceCapsCache() {
  deviceCapsCache.clear();
}

/**
 * Enumerates installed Windows ASIO drivers from `HKLM\SOFTWARE\ASIO` using the native engine.
 * @returns {Promise<Array<{ name: string, clsid: string, description: string }>>}
 */
async function listAsioDevices() {
  const engineBin = resolveWasapiEngineBinary();
  if (!engineBin) return [];
  try {
    const { stdout } = await execFileAsync(engineBin, ['--list-asio-devices'], { timeout: 5000 });
    const parsed = JSON.parse(String(stdout || '[]').trim());
    const drivers = Array.isArray(parsed) ? parsed : [];
    knownAsioDriverNames.clear();
    for (const drv of drivers) {
      if (drv && typeof drv.name === 'string' && drv.name.trim()) {
        knownAsioDriverNames.set(drv.name.trim(), drv.name.trim());
      }
    }
    return drivers;
  } catch (err) {
    logger.warn('AsioBridge', 'Failed enumerating ASIO drivers', { error: err.message });
    return [];
  }
}

/**
 * Parses ScarletBook TOC & tracks from a validated SACD `.iso` file via `vanta-audio-engine.exe --list-sacd`.
 * @param {string} isoPath - Path to candidate SACD `.iso`.
 * @returns {Promise<object>} Parsed SACD disc structure (`ok`, `catalogNumber`, `areas`).
 */
async function listSacdIsoTracks(isoPath) {
  const safeIso = validateSafeSacdIsoPath(isoPath);
  if (!safeIso) {
    return { ok: false, error: 'Rejected non-SACD or unsafe ISO file', areas: [] };
  }
  const engineBin = resolveWasapiEngineBinary();
  if (!engineBin) {
    return { ok: false, error: 'Missing vanta-audio-engine.exe', areas: [] };
  }
  try {
    const { stdout } = await execFileAsync(engineBin, ['--list-sacd', safeIso], { timeout: 10000 });
    const parsed = JSON.parse(String(stdout || '{}').trim());
    return parsed && typeof parsed === 'object'
      ? { ok: Boolean(parsed.ok), safeIso, ...parsed }
      : { ok: false, error: 'Malformed SACD TOC response', areas: [] };
  } catch (err) {
    return { ok: false, error: err.message, areas: [] };
  }
}

/**
 * Converts parsed SACD ISO TOC tracks into VANTA catalog track objects.
 * Prefers the 2-Channel Stereo area first cleanly, plus exposes multichannel if stereo missing.
 * @param {string} safeIso - Canonical validated SACD ISO path.
 * @param {object} sacdInfo - Output from `listSacdIsoTracks`.
 * @returns {Array<object>} Catalog tracks ready for library ingestion.
 */
function buildSacdCatalogTracks(safeIso, sacdInfo) {
  if (!sacdInfo?.ok || !Array.isArray(sacdInfo.areas) || !sacdInfo.areas.length) return [];
  const albumBase = path.basename(safeIso, path.extname(safeIso)).replace(/_/g, ' ');
  const chosenArea = sacdInfo.areas.find((a) => a.areaIndex === 0 && Array.isArray(a.tracks) && a.tracks.length > 0)
    || sacdInfo.areas[0];
  if (!chosenArea || !Array.isArray(chosenArea.tracks)) return [];
  const isoHash = crypto.createHash('sha1').update(safeIso.toLowerCase()).digest('hex').slice(0, 12);

  return chosenArea.tracks.map((t) => ({
    id: `sacd-${isoHash}-a${chosenArea.areaIndex}-t${t.trackNumber}`,
    filePath: safeIso,
    fileName: `${path.basename(safeIso)} [Track ${String(t.trackNumber).padStart(2, '0')}]`,
    ext: 'SACD',
    isVideo: false,
    isSacdIso: true,
    sacdArea: chosenArea.areaIndex,
    sacdTrack: Number(t.trackNumber) || 1,
    sacdDst: Boolean(t.isDst),
    title: t.title || `SACD Track ${t.trackNumber}`,
    artist: t.artist || 'SACD Master Artist',
    album: albumBase,
    genre: 'SACD / DSD',
    bpm: 100,
    key: 'C min',
    year: '',
    energy: 82,
    mood: 'Audiophile SACD',
    durationSec: Number(t.durationSec) || 0,
    sampleRate: Number(t.sampleRate) || 2822400,
    bitDepth: 1,
    channels: Number(t.channels) || 2,
    audioCodec: t.isDst ? 'DST_SACD' : 'DSD_SACD',
    bitrateKbps: t.isDst ? 2800 : 5645,
    provenance: t.isDst ? 'SACD ISO • DST Lossless' : 'SACD ISO • DSD64',
    hasId3: true,
    hasCover: false,
    hasLyrics: false,
    audioHash: `sacd-${isoHash}-a${chosenArea.areaIndex}-t${t.trackNumber}`
  }));
}

/**
 * Enumerates active Windows WASAPI output endpoints via vanta-audio-engine.exe.
 * @returns {Promise<Array<{id: string, name: string, isDefault: boolean}>>}
 */
async function listWasapiDevices() {
  const engineBin = resolveWasapiEngineBinary();
  if (!engineBin) return [];
  try {
    const { stdout } = await execFileAsync(engineBin, ['--list-devices'], { timeout: 5000 });
    const parsed = JSON.parse(String(stdout || '[]').trim());
    const devices = Array.isArray(parsed) ? parsed : [];
    knownWasapiDeviceIds.clear();
    for (const dev of devices) {
      if (dev && typeof dev.id === 'string' && dev.id.trim()) {
        knownWasapiDeviceIds.set(dev.id.trim(), dev.id.trim());
      }
    }
    return devices;
  } catch (err) {
    logger.warn('WasapiBridge', 'Failed enumerating WASAPI devices', { error: err.message });
    return [];
  }
}

/**
 * Probes a Windows WASAPI endpoint's Exclusive/Shared sample rate and bit depth capabilities.
 * @param {string} [deviceId=''] - Target WASAPI endpoint ID (empty = system default).
 * @param {number} [channels=2] - Channel count to probe.
 * @returns {Promise<object>} Endpoint capability descriptor.
 */
async function probeWasapiDeviceCaps(deviceId = '', channels = 2) {
  const safeCh = Math.max(1, Math.min(8, Math.round(Number(channels) || 2)));
  let safeDeviceId = '';
  if (typeof deviceId === 'string' && deviceId.trim()) {
    const requestedId = deviceId.trim();
    if (!knownWasapiDeviceIds.has(requestedId)) {
      await listWasapiDevices();
    }
    safeDeviceId = knownWasapiDeviceIds.get(requestedId) || '';
  }

  const cacheKey = `${safeDeviceId || '__default__'}:${safeCh}`;
  const cached = deviceCapsCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < DEVICE_CAPS_CACHE_TTL_MS) {
    return cached.caps;
  }

  const engineBin = resolveWasapiEngineBinary();
  if (!engineBin) {
    return { ok: false, supportedRates: [], sharedSampleRate: 48000, exclusiveSupported: false, maxBitDepth: 24 };
  }

  try {
    const args = ['--probe-caps', '--channels', String(safeCh)];
    if (safeDeviceId) args.push('--device', safeDeviceId);
    const { stdout } = await execFileAsync(engineBin, args, { timeout: 5000 });
    const parsed = JSON.parse(String(stdout || '{}').trim());
    const caps = {
      ok: Boolean(parsed?.ok),
      deviceId: typeof parsed?.deviceId === 'string' ? parsed.deviceId : safeDeviceId,
      deviceName: typeof parsed?.deviceName === 'string' ? parsed.deviceName : '',
      exclusiveSupported: Boolean(parsed?.exclusiveSupported),
      sharedSampleRate: Number(parsed?.sharedSampleRate) || 48000,
      sharedChannels: Number(parsed?.sharedChannels) || safeCh,
      hwVolumeSupport: Number(parsed?.hwVolumeSupport) || 0,
      maxBitDepth: Number(parsed?.maxBitDepth) || 24,
      supports16Bit: parsed?.supports16Bit !== false,
      supports24Bit: Boolean(parsed?.supports24Bit),
      supports32Bit: Boolean(parsed?.supports32Bit),
      supportedRates: Array.isArray(parsed?.supportedRates)
        ? parsed.supportedRates.map(Number).filter((r) => Number.isFinite(r) && r >= 8000 && r <= 768000)
        : []
    };
    deviceCapsCache.set(cacheKey, { ts: Date.now(), caps });
    return caps;
  } catch (err) {
    logger.warn('WasapiBridge', 'Failed probing WASAPI endpoint capabilities', { error: err.message });
    return { ok: false, supportedRates: [], sharedSampleRate: 48000, exclusiveSupported: false, maxBitDepth: 24 };
  }
}

/**
 * Selects the optimal target sample rate and WASAPI share mode for an audio track,
 * prioritizing WASAPI Exclusive mode with same-clock-family high-precision `swr` resampling
 * over falling back to Windows Shared Mixer.
 * @param {number} rawRate - Source audio sample rate in Hz.
 * @param {object|null} caps - Result from `probeWasapiDeviceCaps`.
 * @param {object} [options={}] - Routing options.
 * @returns {{ targetRate: number, useExclusive: boolean, resampled: boolean, reason: string }}
 */
function selectOptimalExclusiveTargetRate(rawRate, caps, options = {}) {
  const numericRaw = Number(rawRate) || 48000;
  const isDsd = numericRaw > 768000;
  const pcmCandidateRate = isDsd
    ? ((numericRaw % 48000 === 0) ? 384000 : 352800)
    : Math.max(8000, Math.min(768000, Math.round(numericRaw)));
  const exclusivePref = options.exclusivePreferred !== false;

  if (!exclusivePref) {
    const sharedRate = (caps && caps.sharedSampleRate > 0) ? Math.round(caps.sharedSampleRate) : pcmCandidateRate;
    return {
      targetRate: sharedRate,
      useExclusive: false,
      resampled: Math.round(numericRaw) !== sharedRate,
      reason: 'shared_preferred'
    };
  }

  if (!caps || caps.ok === false) {
    return {
      targetRate: pcmCandidateRate,
      useExclusive: true,
      resampled: isDsd,
      reason: isDsd ? 'dsd_to_dxd' : 'no_caps_passthrough'
    };
  }

  if (!caps.exclusiveSupported) {
    const sharedRate = caps.sharedSampleRate > 0 ? Math.round(caps.sharedSampleRate) : 48000;
    return {
      targetRate: sharedRate,
      useExclusive: false,
      resampled: Math.round(numericRaw) !== sharedRate,
      reason: 'shared_fallback_endpoint'
    };
  }

  const supported = [...new Set(
    (Array.isArray(caps.supportedRates) ? caps.supportedRates : [])
      .map(Number)
      .filter((r) => Number.isFinite(r) && r >= 8000 && r <= 768000)
  )].sort((a, b) => a - b);

  if (supported.length === 0) {
    return {
      targetRate: pcmCandidateRate,
      useExclusive: true,
      resampled: isDsd,
      reason: isDsd ? 'dsd_to_dxd' : 'no_caps_passthrough'
    };
  }

  const is44kFamily = (pcmCandidateRate % 11025 === 0) || (isDsd && numericRaw % 44100 === 0);
  const pickFromPool = (pool, target) => {
    const ge = pool.filter((r) => r >= target);
    if (ge.length > 0) return ge[0];
    return pool[pool.length - 1];
  };

  if (options.fixedRateLock && Number(options.fixedTargetRate) > 0) {
    const lockTarget = Math.round(Number(options.fixedTargetRate));
    if (supported.includes(lockTarget)) {
      return {
        targetRate: lockTarget,
        useExclusive: true,
        resampled: Math.round(numericRaw) !== lockTarget,
        reason: 'fixed_rate_lock'
      };
    }
    const closest = supported.reduce((best, r) => (
      Math.abs(r - lockTarget) < Math.abs(best - lockTarget) ? r : best
    ), supported[0]);
    return {
      targetRate: closest,
      useExclusive: true,
      resampled: Math.round(numericRaw) !== closest,
      reason: 'fixed_rate_lock'
    };
  }

  if (supported.includes(pcmCandidateRate)) {
    return {
      targetRate: pcmCandidateRate,
      useExclusive: true,
      resampled: isDsd,
      reason: isDsd ? 'dsd_to_dxd' : 'native_rate_match'
    };
  }

  const sameFamily = supported.filter((r) => (
    is44kFamily ? (r % 11025 === 0) : (r % 48000 === 0 || r % 16000 === 0)
  ));
  const pool = sameFamily.length > 0 ? sameFamily : supported;
  const chosenRate = pickFromPool(pool, pcmCandidateRate);
  return {
    targetRate: chosenRate,
    useExclusive: true,
    resampled: Math.round(numericRaw) !== chosenRate,
    reason: 'exclusive_swr_resample'
  };
}

/**
 * Chooses the optimal FFmpeg-to-C++ PCM pipe wire format (`s32le` for bit-exact integer codecs,
 * `f64le` 64-bit float for lossy codecs, IEEE float PCM, or 64-bit `swr` resampled streams).
 * @param {object} [probe={}] - Audio stream probe metadata.
 * @param {object} [options={}] - Routing context (`resampled`, `needsDsp`, `linearGain`).
 * @returns {{ ffFormat: string, ffCodec: string, inFmt: string, effectiveSrcBits: number, isLossyOrFloat: boolean }}
 */
function selectFfmpegPipeFormat(probe = {}, options = {}) {
  const codec = String(probe?.codec || '').toUpperCase();
  const srcBits = Math.max(0, Math.round(Number(probe?.bitDepth) || 0));
  const integerPcmOrLossless = [
    'PCM', 'FLAC', 'ALAC', 'APE', 'WAVPACK', 'TTA', 'SHN',
    'PCM_S16LE', 'PCM_S16BE', 'PCM_S24LE', 'PCM_S24BE', 'PCM_S32LE', 'PCM_S32BE', 'PCM_U8'
  ].includes(codec);
  const floatOrLossy = !integerPcmOrLossless || codec.startsWith('PCM_F');
  const resampled = Boolean(options.resampled);

  if (floatOrLossy || resampled) {
    return {
      ffFormat: 'f64le',
      ffCodec: 'pcm_f64le',
      inFmt: 'f64le',
      effectiveSrcBits: 32,
      isLossyOrFloat: true
    };
  }

  return {
    ffFormat: 's32le',
    ffCodec: 'pcm_s32le',
    inFmt: 's32le',
    effectiveSrcBits: srcBits > 0 ? srcBits : 24,
    isLossyOrFloat: false
  };
}

/**
 * Checks whether a file is a native 1-bit DSD container (.dsf / .dff) eligible for DoP v1.1 packing.
 * @param {string} filePath - Media path.
 * @returns {boolean}
 */
function isNativeDsdFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return ext === '.dsf' || ext === '.dff';
}

/**
 * Checks whether a media file requires FFmpeg lossless PCM decoding for Chromium Studio DSP mode
 * (e.g., ALAC, AIFF, APE, WavPack, DSD/DSF, WMA).
 * @param {string} filePath - Media path.
 * @param {string} [codec=''] - Probed codec string.
 * @returns {boolean}
 */
function needsLosslessPcmTranscode(filePath, codec = '') {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const c = String(codec || '').toUpperCase();
  if (['.w64', '.aiff', '.aif', '.alac', '.ape', '.wv', '.dsf', '.dff', '.wma'].includes(ext)) return true;
  if (['ALAC', 'APE', 'WAVPACK', 'DSD_LSBF', 'DSD_MSBF', 'DSD_LSBF_PLANAR', 'DSD_MSBF_PLANAR', 'WMAV2', 'WMAPRO'].includes(c)) return true;
  return false;
}

/**
 * Manages a live Native C++ WASAPI Exclusive / Shared playback session fed by ffmpeg-static.
 */
class NativeWasapiPlayer {
  constructor(onEvent) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.extractorProc = null;
    this.ffmpegProc = null;
    this.engineProc = null;
    this.ctrlServer = null;
    this.ctrlSocket = null;
    this.sessionId = 0;
    this.seekOffsetSec = 0;
    this.currentFilePath = '';
    this.currentProbe = null;
    this.currentOptions = {};
    this.activeSampleRate = 0;
    this.activeChannels = 0;
    this.activeUseDop = false;
    this.activeExclusive = true;
    this.activePushMode = false;
    this.activeBufferMs = 0;
    this.activeInFmt = 's32le';
    this.activeBackend = 'wasapi';
    this.activeAsioDriver = '';
    this.activeSacdTrack = false;
    this.activeCaps = null;
    this.nextQueued = null;
  }

  /**
   * Tears down any staged 0 ms gapless next-track FFmpeg process or named-pipe server.
   */
  clearQueuedNext() {
    const q = this.nextQueued;
    this.nextQueued = null;
    if (!q) return;
    if (q.pcmSocket) {
      try {
        q.pcmSocket.destroy();
      } catch {
        // Ignore
      }
    }
    if (q.pcmServer) {
      try {
        q.pcmServer.close();
      } catch {
        // Ignore
      }
    }
    if (q.ffmpegProc) {
      try {
        q.ffmpegProc.kill();
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Stops any active native playback session and cleans up child processes and pipe.
   */
  stop() {
    this.sessionId++;
    this.clearQueuedNext();
    this.activeSampleRate = 0;
    this.activeChannels = 0;
    this.activeUseDop = false;
    if (this.ctrlSocket) {
      try {
        this.ctrlSocket.write('STOP\n');
        this.ctrlSocket.end();
      } catch {
        // Ignore
      }
      this.ctrlSocket = null;
    }
    if (this.ctrlServer) {
      try {
        this.ctrlServer.close();
      } catch {
        // Ignore
      }
      this.ctrlServer = null;
    }
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill();
      } catch {
        // Ignore
      }
      this.ffmpegProc = null;
    }
    if (this.extractorProc) {
      try {
        this.extractorProc.kill();
      } catch {
        // Ignore
      }
      this.extractorProc = null;
    }
    if (this.engineProc) {
      try {
        this.engineProc.kill();
      } catch {
        // Ignore
      }
      this.engineProc = null;
    }
  }

  /**
   * Stops any active native playback session asynchronously and waits until
   * Windows releases the WASAPI Exclusive endpoint handle cleanly, returning exact stop telemetry.
   * @returns {Promise<{ stopped: boolean, positionMs: number|null, positionSec: number|null, xrunCount: number }>}
   */
  async stopAsync() {
    this.sessionId++;
    this.clearQueuedNext();
    const baseSeekSec = this.seekOffsetSec || 0;
    this.activeSampleRate = 0;
    this.activeChannels = 0;
    this.activeUseDop = false;
    const proc = this.engineProc;
    const hadProc = Boolean(proc && proc.exitCode === null && !proc.killed);

    let stoppedTelemetry = null;
    let stdoutAcc = '';
    const onStopStdout = (chunk) => {
      stdoutAcc += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = stdoutAcc.indexOf('\n')) >= 0) {
        const line = stdoutAcc.slice(0, nlIdx).trim();
        stdoutAcc = stdoutAcc.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt && (evt.event === 'stopped' || evt.event === 'ended') && Number.isFinite(Number(evt.positionMs))) {
            stoppedTelemetry = {
              positionMs: Number(evt.positionMs),
              xrunCount: Number(evt.xrunCount) || 0
            };
          }
        } catch {
          // Ignore partial or non-JSON lines
        }
      }
    };
    if (hadProc && proc.stdout) {
      proc.stdout.on('data', onStopStdout);
    }

    if (this.ctrlSocket) {
      try {
        this.ctrlSocket.write('STOP\n');
        this.ctrlSocket.end();
      } catch {
        // Ignore
      }
      this.ctrlSocket = null;
    }
    if (this.ctrlServer) {
      try {
        this.ctrlServer.close();
      } catch {
        // Ignore
      }
      this.ctrlServer = null;
    }
    if (this.ffmpegProc) {
      try {
        this.ffmpegProc.kill();
      } catch {
        // Ignore
      }
      this.ffmpegProc = null;
    }
    if (this.extractorProc) {
      try {
        this.extractorProc.kill();
      } catch {
        // Ignore
      }
      this.extractorProc = null;
    }

    if (hadProc) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (proc.stdout) {
            proc.stdout.removeListener('data', onStopStdout);
          }
          this.engineProc = null;
          setTimeout(resolve, 220);
        };
        proc.once('exit', finish);
        setTimeout(() => {
          if (!settled) {
            try {
              proc.kill();
            } catch {
              // Ignore
            }
          }
        }, 320);
        setTimeout(finish, 550);
      });
    } else {
      this.stop();
    }

    const posMs = stoppedTelemetry ? stoppedTelemetry.positionMs : null;
    return {
      stopped: true,
      positionMs: posMs,
      positionSec: posMs !== null ? baseSeekSec + posMs / 1000 : null,
      xrunCount: stoppedTelemetry ? stoppedTelemetry.xrunCount : 0
    };
  }

  /**
   * Sends a runtime control command ('PAUSE', 'RESUME', 'GAIN 0.85', 'STOP') over the Windows Named Pipe.
   * @param {string} cmd - Command string.
   */
  sendCommand(cmd) {
    if (this.ctrlSocket && !this.ctrlSocket.destroyed) {
      try {
        this.ctrlSocket.write(`${cmd}\n`);
      } catch {
        // Ignore pipe errors
      }
    }
  }

  /**
   * Starts native WASAPI playback of a local audio/video file from `seekSec`.
   * Supports direct bit-exact DoP v1.1 streaming for DSF/DFF files with automatic DXD PCM fallback.
   * @param {string} filePath - Path to audio file.
   * @param {object} [options] - Playback options.
   * @param {boolean} [options.exclusive=true] - Prefer WASAPI Exclusive Mode.
   * @param {boolean} [options.dop=false] - Prefer Native DoP v1.1 for DSF/DFF files.
   * @param {string} [options.deviceId=''] - Target WASAPI endpoint ID.
   * @param {number} [options.linearGain=1.0] - Linear volume/ReplayGain multiplier.
   * @param {number} [options.seekSec=0] - Start position in seconds.
   */
  async play(filePath, options = {}) {
    await this.stopAsync();
    const mySession = ++this.sessionId;

    const sacdTrack = Math.max(0, Math.round(Number(options.sacdTrack) || 0));
    const sacdArea = Math.max(0, Math.min(1, Math.round(Number(options.sacdArea) || 0)));
    const isSacdIsoTrack = sacdTrack >= 1 && path.extname(String(filePath || '')).toLowerCase() === '.iso';
    const safePath = isSacdIsoTrack
      ? validateSafeSacdIsoPath(filePath)
      : validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
    if (!safePath) {
      throw new Error(isSacdIsoTrack ? 'Invalid or rejected SACD ISO path' : 'Invalid or rejected audio file path');
    }

    let safeDeviceId = '';
    if (typeof options.deviceId === 'string' && options.deviceId.trim()) {
      const requestedId = options.deviceId.trim();
      if (!knownWasapiDeviceIds.has(requestedId)) {
        await listWasapiDevices();
      }
      safeDeviceId = knownWasapiDeviceIds.get(requestedId) || '';
    }

    let requestedBackend = options.backend === 'asio' ? 'asio' : 'wasapi';
    let safeAsioDriver = '';
    if (requestedBackend === 'asio') {
      const rawAsio = typeof options.asioDriver === 'string' ? options.asioDriver.trim() : '';
      if (!knownAsioDriverNames.size) {
        await listAsioDevices();
      }
      safeAsioDriver = rawAsio ? (knownAsioDriverNames.get(rawAsio) || '') : (Array.from(knownAsioDriverNames.values())[0] || '');
      if (!safeAsioDriver) {
        requestedBackend = 'wasapi';
      }
    }

    const safeGain = Number.isFinite(Number(options.linearGain))
      ? Math.max(0, Math.min(4.0, Number(options.linearGain)))
      : 1.0;

    const ffmpegBin = resolveFfmpegBinary();
    const engineBin = resolveWasapiEngineBinary();
    if (!engineBin) {
      throw new Error('Missing vanta-audio-engine.exe');
    }

    const safeDspSpec = sanitizeNativeDspSpec(options.dspSpec);
    const safePeqSpec = sanitizePeqWireSpec(options.peqSpec);
    const rawIrPath = typeof options.convolverIrPath === 'string' ? options.convolverIrPath : '';
    const safeWetPct = Number.isFinite(Number(options.convolverWetPct))
      ? Math.max(0, Math.min(100, Number(options.convolverWetPct)))
      : 100;
    this.currentFilePath = safePath;
    this.currentOptions = options;
    this.activeBackend = requestedBackend;
    this.activeAsioDriver = safeAsioDriver;
    this.activeSacdTrack = isSacdIsoTrack;
    this.seekOffsetSec = Math.max(0, Number(options.seekSec) || 0);

    let probe = options.probe || null;
    if (isSacdIsoTrack && !probe) {
      const toc = await listSacdIsoTracks(safePath);
      const areaObj = toc?.areas?.find((a) => a.areaIndex === sacdArea) || toc?.areas?.[0];
      const trkObj = areaObj?.tracks?.find((t) => Number(t.trackNumber) === sacdTrack) || areaObj?.tracks?.[0];
      probe = {
        codec: trkObj?.isDst ? 'DST_SACD' : 'DSD_SACD',
        sampleRate: Number(trkObj?.sampleRate) || 2822400,
        bitDepth: 1,
        channels: Number(trkObj?.channels) || 2,
        bitrateKbps: trkObj?.isDst ? 2800 : 5645,
        durationSec: Number(trkObj?.durationSec) || 0
      };
    } else if (!probe) {
      probe = await probeAudioStreamInfo(safePath);
    }
    if (mySession !== this.sessionId) return;
    this.currentProbe = probe;

    const rawRate = Number(probe.dsdClockRate || probe.sampleRate) || 48000;
    const targetChannels = Math.max(1, Math.min(8, Number(probe.channels) || 2));
    const caps = requestedBackend === 'asio'
      ? { ok: true, exclusiveSupported: true, sharedSampleRate: 48000, maxBitDepth: 32, supports24Bit: true, supports32Bit: true, hwVolumeSupport: 0, supportedRates: [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000] }
      : (options.caps || (await probeWasapiDeviceCaps(safeDeviceId, targetChannels)));
    if (mySession !== this.sessionId) return;
    this.activeCaps = caps;

    const pushMode = Boolean(options.pushMode);
    const bufferMs = Math.max(0, Math.min(200, Math.round(Number(options.bufferMs) || 0)));
    const preRollMs = Math.max(0, Math.min(500, Math.round(Number(options.preRollMs) || 0)));
    const fixedRateLock = Boolean(options.fixedRateLock);
    const fixedTargetRate = Math.max(0, Math.round(Number(options.fixedTargetRate) || 0));

    const isDsd = !isSacdIsoTrack && isNativeDsdFile(safePath);
    const useAsioRawDsd = requestedBackend === 'asio' && Boolean(options.asioRawDsd) && isDsd;
    const dopCarrierRate = rawRate > 2822400 ? 352800 : 176400;
    const capsAllowDop = requestedBackend === 'wasapi' && (!caps?.ok || (
      caps.exclusiveSupported !== false &&
      caps.supports24Bit !== false &&
      (caps.supportedRates.length === 0 || caps.supportedRates.includes(dopCarrierRate))
    ));
    const useNativeDop = !useAsioRawDsd && Boolean(options.dop) && options.exclusive !== false && isDsd && capsAllowDop;
    if (!useNativeDop && !useAsioRawDsd && !ffmpegBin) {
      throw new Error('Missing ffmpeg-static');
    }
    this.activeUseDop = useNativeDop;

    const ratePlan = useAsioRawDsd
      ? { targetRate: rawRate, useExclusive: true, resampled: false, reason: 'asio_raw_dsd' }
      : (useNativeDop
        ? { targetRate: dopCarrierRate, useExclusive: true, resampled: false, reason: 'native_dop' }
        : selectOptimalExclusiveTargetRate(rawRate, caps, {
          exclusivePreferred: options.exclusive !== false,
          fixedRateLock,
          fixedTargetRate
        }));
    this.activeRatePlan = ratePlan;

    const pipeName = `\\\\.\\pipe\\vanta_ctrl_${process.pid}_${++pipeSeq}`;
    this.ctrlServer = net.createServer((socket) => {
      this.ctrlSocket = socket;
    });

    await new Promise((resolve) => {
      this.ctrlServer.listen(pipeName, resolve);
    });
    if (mySession !== this.sessionId) {
      this.stop();
      return;
    }

    let pipeFmt = null;
    if (useAsioRawDsd || useNativeDop) {
      const engArgs = [];
      if (requestedBackend === 'asio') {
        engArgs.push('--asio', '--asio-driver', safeAsioDriver, '--dsd-raw');
      } else {
        engArgs.push('--exclusive', pushMode ? '--push' : '--event');
      }
      engArgs.push(
        '--buffer-ms',
        String(bufferMs),
        '--pre-roll-ms',
        String(preRollMs),
        '--dop-file',
        safePath,
        '--seek-sec',
        String(this.seekOffsetSec.toFixed(3)),
        '--ctrl-pipe',
        pipeName
      );
      if (requestedBackend === 'wasapi' && safeDeviceId) {
        engArgs.push('--device', safeDeviceId);
      }

      logger.info('AudioEngine', useAsioRawDsd ? 'Starting ASIO Native Raw DSD session' : 'Starting Native DoP v1.1 session', {
        filePath: safePath,
        backend: requestedBackend,
        asioDriver: safeAsioDriver,
        sampleRate: probe.sampleRate,
        codec: probe.codec,
        channels: probe.channels,
        seekSec: this.seekOffsetSec
      });

      this.extractorProc = null;
      this.ffmpegProc = null;
      this.activeInFmt = 's32le';
      this.engineProc = spawn(engineBin, engArgs, { windowsHide: true });
    } else {
      const targetRate = ratePlan.targetRate;
      const effectiveProbeForPipe = isSacdIsoTrack ? { codec: 'DSD_SACD', bitDepth: 1, sampleRate: rawRate } : probe;
      pipeFmt = selectFfmpegPipeFormat(effectiveProbeForPipe, {
        resampled: ratePlan.resampled || isSacdIsoTrack,
        linearGain: safeGain,
        needsDsp: Boolean(safeDspSpec)
      });

      const ffArgs = ['-hide_banner', '-loglevel', 'error'];
      if (this.seekOffsetSec > 0) {
        ffArgs.push('-ss', String(this.seekOffsetSec.toFixed(3)));
      }
      const resampleArgs = buildHighPrecisionResampleArgs(rawRate, targetRate);

      if (isSacdIsoTrack) {
        ffArgs.push('-f', 'iff', '-i', '-');
      } else {
        ffArgs.push('-i', safePath);
      }
      ffArgs.push(
        '-vn',
        ...resampleArgs,
        '-f',
        pipeFmt.ffFormat,
        '-acodec',
        pipeFmt.ffCodec,
        '-ac',
        String(targetChannels),
        '-ar',
        String(targetRate),
        '-'
      );

      const engArgs = requestedBackend === 'asio'
        ? ['--asio', '--asio-driver', safeAsioDriver]
        : [ratePlan.useExclusive ? '--exclusive' : '--shared', pushMode ? '--push' : '--event'];
      engArgs.push(
        '--rate',
        String(targetRate),
        '--channels',
        String(targetChannels),
        '--in-fmt',
        pipeFmt.inFmt,
        '--src-bits',
        String(pipeFmt.effectiveSrcBits),
        '--buffer-ms',
        String(bufferMs),
        '--pre-roll-ms',
        String(preRollMs),
        '--gain',
        String(safeGain),
        '--ctrl-pipe',
        pipeName
      );
      if (safeDspSpec) {
        engArgs.push('--dsp', safeDspSpec);
      }
      if (safePeqSpec) {
        engArgs.push('--peq', safePeqSpec);
      }
      if (rawIrPath) {
        const irRes = await prepareConvolutionIrFile(rawIrPath, targetRate);
        if (irRes?.ok && irRes.preparedPath) {
          engArgs.push('--convolver-ir', irRes.preparedPath, '--convolver-wet', String(safeWetPct));
        }
      }
      if (requestedBackend === 'wasapi' && safeDeviceId) {
        engArgs.push('--device', safeDeviceId);
      }

      logger.info('AudioEngine', requestedBackend === 'asio' ? 'Starting isolated ASIO session' : 'Starting native WASAPI session', {
        filePath: safePath,
        backend: requestedBackend,
        asioDriver: safeAsioDriver,
        isSacdIsoTrack,
        sacdArea,
        sacdTrack,
        exclusive: ratePlan.useExclusive,
        inFmt: pipeFmt.inFmt,
        sourceRate: probe.sampleRate,
        targetRate,
        rateReason: ratePlan.reason
      });

      this.activeInFmt = pipeFmt.inFmt;
      if (isSacdIsoTrack) {
        this.extractorProc = spawn(
          engineBin,
          ['--sacd-extract-dff', safePath, '--sacd-area', String(sacdArea), '--sacd-track', String(sacdTrack)],
          { windowsHide: true }
        );
      } else {
        this.extractorProc = null;
      }

      this.ffmpegProc = spawn(ffmpegBin, ffArgs, { windowsHide: true });
      this.engineProc = spawn(engineBin, engArgs, { windowsHide: true });

      if (this.extractorProc) {
        const extProc = this.extractorProc;
        this.extractorProc.stdout.pipe(this.ffmpegProc.stdin);
        this.ffmpegProc.once('close', () => {
          try {
            if (extProc && extProc.exitCode === null) extProc.kill();
          } catch {
            // Ignore cleanup
          }
        });
        this.ffmpegProc.stdin.on('error', () => {
          // Ignore EPIPE on early stop
        });
      }
      this.ffmpegProc.stdout.pipe(this.engineProc.stdin);
      this.engineProc.stdin.on('error', () => {
        // Ignore EPIPE when stopped early
      });
    }

    let receivedReady = false;
    let dopUnsupported = false;
    let fallbackTriggered = false;
    let stdoutBuf = '';
    this.engineProc.stdout.on('data', (chunk) => {
      if (mySession !== this.sessionId) return;
      stdoutBuf += chunk.toString('utf8');
      let nlIdx;
      while ((nlIdx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nlIdx).trim();
        stdoutBuf = stdoutBuf.slice(nlIdx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          const activeProbe = this.currentProbe || probe;
          if (Number.isFinite(Number(evt.positionMs))) {
            evt.positionSec = this.seekOffsetSec + Number(evt.positionMs) / 1000;
            evt.durationSec = activeProbe.durationSec || 0;
          }
          if (evt.event === 'ready') {
            receivedReady = true;
            this.activeSampleRate = Number(evt.sampleRate) || 0;
            this.activeChannels = Number(evt.channels) || 0;
            this.activeExclusive = evt.mode !== 'shared';
            this.activePushMode = Boolean(evt.pushMode);
            if (evt.inFmt) this.activeInFmt = String(evt.inFmt);
            evt.codec = activeProbe.codec;
            evt.bitrateKbps = activeProbe.bitrateKbps;
            evt.durationSec = activeProbe.durationSec;
            evt.sourceSampleRate = activeProbe.sampleRate;
            evt.sourceBitDepth = activeProbe.bitDepth;
            evt.caps = this.activeCaps;
            evt.ratePlan = this.activeRatePlan;
          } else if (evt.event === 'track_advanced') {
            if (this.nextQueued && this.nextQueued.seq === Number(evt.seq)) {
              const promoted = this.nextQueued;
              this.nextQueued = null;
              const prevFfmpeg = this.ffmpegProc;
              this.ffmpegProc = promoted.ffmpegProc;
              this.currentFilePath = promoted.filePath;
              this.currentProbe = promoted.probe;
              this.activeUseDop = Boolean(promoted.useDop);
              this.activeRatePlan = promoted.ratePlan || null;
              this.activeCaps = promoted.caps || this.activeCaps;
              this.activeSampleRate = Number(evt.sampleRate) || promoted.targetRate || this.activeSampleRate;
              this.activeChannels = Number(evt.channels) || promoted.targetChannels || this.activeChannels;
              this.activeExclusive = evt.mode ? evt.mode !== 'shared' : Boolean(promoted.effectiveExclusive);
              if (promoted.inFmt) this.activeInFmt = promoted.inFmt;
              this.seekOffsetSec = 0;
              evt.filePath = promoted.filePath;
              evt.probe = promoted.probe;
              evt.codec = promoted.probe?.codec;
              evt.bitrateKbps = promoted.probe?.bitrateKbps;
              evt.durationSec = promoted.probe?.durationSec;
              evt.sourceSampleRate = promoted.probe?.sampleRate;
              evt.sourceBitDepth = promoted.probe?.bitDepth;
              evt.caps = this.activeCaps;
              evt.ratePlan = this.activeRatePlan;
              evt.inFmt = this.activeInFmt;
              if (prevFfmpeg && prevFfmpeg !== this.ffmpegProc) {
                try {
                  prevFfmpeg.kill();
                } catch {
                  // Ignore cleanup
                }
              }
            }
          } else if (evt.event === 'dop_unsupported') {
            dopUnsupported = true;
            logger.info('WasapiEngine', 'DoP v1.1 unsupported by endpoint; falling back to DXD PCM', {
              filePath,
              reason: evt.reason
            });
            continue;
          } else if (evt.event === 'error') {
            logger.error('WasapiEngine', evt.message || 'WASAPI error', evt);
          }
          this.onEvent(evt);
        } catch {
          // Ignore malformed stdout line
        }
      }
    });

    this.engineProc.on('close', (exitCode) => {
      if (mySession !== this.sessionId) return;
      if (requestedBackend === 'asio' && (!receivedReady || (exitCode !== 0 && exitCode !== null)) && !fallbackTriggered) {
        fallbackTriggered = true;
        logger.warn('AsioEngine', 'Isolated ASIO session ended or failed; falling back to WASAPI Exclusive', {
          driver: safeAsioDriver,
          exitCode
        });
        this.onEvent({
          event: 'asio_fallback',
          driver: safeAsioDriver,
          message: `ASIO (${safeAsioDriver || 'driver'}) unavailable or crashed — routed safely to WASAPI Exclusive`
        });
        this.play(filePath, { ...options, backend: 'wasapi', asioDriver: '', probe }).catch((err) => {
          this.onEvent({ event: 'error', message: err.message });
        });
        return;
      }
      if (useNativeDop && !receivedReady && (dopUnsupported || exitCode === 10) && !fallbackTriggered) {
        fallbackTriggered = true;
        this.play(filePath, { ...options, dop: false, probe, caps }).catch((err) => {
          this.onEvent({ event: 'error', message: err.message });
        });
        return;
      }
      this.onEvent({ event: 'closed' });
    });
  }

  /**
   * Queues the next track inside the persistent C++ engine session (`QUEUE_NEXT_JSON`),
   * achieving 0 ms ring-buffer gapless for matching rates AND seamless in-process `IAudioClient`
   * re-initialization with optional pre-roll for cross-rate, cross-format, and DSD transitions.
   * @param {string} filePath - Next audio file path.
   * @param {object} [options={}] - Playback queue options.
   * @returns {Promise<{ ok: boolean, queued: boolean, crossFormat?: boolean, reason?: string, seq?: number, probe?: object }>}
   */
  async queueNext(filePath, options = {}) {
    if (this.activeBackend === 'asio' || this.activeSacdTrack || Number(options.sacdTrack) >= 1) {
      return { ok: false, queued: false, reason: 'asio_or_sacd_reopen' };
    }
    const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
    if (!safePath) {
      return { ok: false, queued: false, reason: 'invalid_path' };
    }
    if (
      !this.engineProc ||
      this.engineProc.exitCode !== null ||
      this.engineProc.killed ||
      !this.ctrlSocket ||
      this.ctrlSocket.destroyed
    ) {
      return { ok: false, queued: false, reason: 'ineligible' };
    }

    const mySession = this.sessionId;
    const probe = options.probe || (await probeAudioStreamInfo(safePath));
    if (mySession !== this.sessionId) {
      return { ok: false, queued: false, reason: 'session_changed' };
    }

    const rawRate = Number(probe.sampleRate) || 48000;
    const targetChannels = Math.max(1, Math.min(8, Number(probe.channels) || 2));
    const safeDeviceId = knownWasapiDeviceIds.get(String(options.deviceId ?? this.currentOptions?.deviceId ?? '').trim()) || '';
    const caps = options.caps || this.activeCaps || (await probeWasapiDeviceCaps(safeDeviceId, targetChannels));
    if (mySession !== this.sessionId) {
      return { ok: false, queued: false, reason: 'session_changed' };
    }

    const exclusivePref = options.exclusive !== undefined ? options.exclusive !== false : this.currentOptions?.exclusive !== false;
    const pushMode = options.pushMode !== undefined ? Boolean(options.pushMode) : Boolean(this.activePushMode);
    const bufferMs = Math.max(0, Math.min(200, Math.round(Number(options.bufferMs ?? this.currentOptions?.bufferMs ?? 0) || 0)));
    const fixedRateLock = Boolean(options.fixedRateLock ?? this.currentOptions?.fixedRateLock);
    const fixedTargetRate = Math.max(0, Math.round(Number(options.fixedTargetRate ?? this.currentOptions?.fixedTargetRate ?? 0) || 0));
    const safeGain = Number.isFinite(Number(options.linearGain))
      ? Math.max(0, Math.min(4.0, Number(options.linearGain)))
      : (Number.isFinite(Number(this.currentOptions?.linearGain)) ? Math.max(0, Math.min(4.0, Number(this.currentOptions.linearGain))) : 1.0);

    const isDsd = isNativeDsdFile(safePath);
    const dopCarrierRate = rawRate > 2822400 ? 352800 : 176400;
    const capsAllowDop = Boolean(caps?.ok)
      ? (caps.exclusiveSupported !== false && caps.supports24Bit !== false && (caps.supportedRates.length === 0 || caps.supportedRates.includes(dopCarrierRate)))
      : false;
    const useNextDop = Boolean(options.dop ?? this.currentOptions?.dop) && exclusivePref && isDsd && capsAllowDop;

    const ffmpegBin = resolveFfmpegBinary();
    if (!useNextDop && !ffmpegBin) {
      return { ok: false, queued: false, reason: 'no_ffmpeg' };
    }

    const ratePlan = useNextDop
      ? { targetRate: dopCarrierRate, useExclusive: true, resampled: false, reason: 'native_dop' }
      : selectOptimalExclusiveTargetRate(rawRate, caps, {
        exclusivePreferred: exclusivePref,
        fixedRateLock,
        fixedTargetRate
      });

    const targetRate = ratePlan.targetRate;
    const pipeFmt = useNextDop
      ? { ffFormat: 's32le', ffCodec: 'pcm_s32le', inFmt: 's32le', effectiveSrcBits: 24, isLossyOrFloat: false }
      : selectFfmpegPipeFormat(probe, {
        resampled: ratePlan.resampled,
        linearGain: safeGain,
        needsDsp: Boolean(this.currentOptions?.dspSpec)
      });

    const isCrossFormat = useNextDop ||
      this.activeUseDop ||
      targetRate !== this.activeSampleRate ||
      targetChannels !== this.activeChannels ||
      pipeFmt.inFmt !== this.activeInFmt ||
      ratePlan.useExclusive !== this.activeExclusive;
    const preRollMs = isCrossFormat
      ? Math.max(0, Math.min(500, Math.round(Number(options.preRollMs ?? this.currentOptions?.preRollMs ?? 0) || 0)))
      : 0;

    this.clearQueuedNext();
    this.sendCommand('CLEAR_QUEUE');

    const seq = Math.max(1, Number(options.seq) || Date.now());
    if (useNextDop) {
      this.nextQueued = {
        seq,
        filePath: safePath,
        probe,
        ffmpegProc: null,
        pcmServer: null,
        pcmSocket: null,
        useDop: true,
        ratePlan,
        caps,
        inFmt: 's32le',
        targetRate,
        targetChannels,
        effectiveExclusive: true
      };
      const queuePayload = {
        seq,
        isDop: true,
        dopFile: safePath,
        seekSec: 0,
        rate: targetRate,
        ch: targetChannels,
        inFmt: 's32le',
        srcBits: 24,
        exclusive: true,
        push: pushMode,
        bufferMs,
        preRollMs,
        gain: safeGain
      };
      this.sendCommand(`QUEUE_NEXT_JSON ${JSON.stringify(queuePayload)}`);
      logger.info('WasapiEngine', 'Queued in-process DoP v1.1 track transition', {
        filePath: safePath,
        seq,
        carrierRate: targetRate,
        preRollMs
      });
      return { ok: true, queued: true, crossFormat: true, seq, probe, ratePlan };
    }

    const pcmPipeName = `\\\\.\\pipe\\vanta_pcm_${process.pid}_${++pipeSeq}`;
    const resampleArgs = buildHighPrecisionResampleArgs(rawRate, targetRate);
    const ffArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      safePath,
      '-vn',
      ...resampleArgs,
      '-f',
      pipeFmt.ffFormat,
      '-acodec',
      pipeFmt.ffCodec,
      '-ac',
      String(targetChannels),
      '-ar',
      String(targetRate),
      '-'
    ];

    const nextFfmpeg = spawn(ffmpegBin, ffArgs, { windowsHide: true });
    const staged = {
      seq,
      filePath: safePath,
      probe,
      ffmpegProc: nextFfmpeg,
      pcmServer: null,
      pcmSocket: null,
      useDop: false,
      ratePlan,
      caps,
      inFmt: pipeFmt.inFmt,
      targetRate,
      targetChannels,
      effectiveExclusive: ratePlan.useExclusive
    };

    const pcmServer = net.createServer((socket) => {
      staged.pcmSocket = socket;
      socket.on('error', () => {
        // Ignore early EPIPE if user skips track
      });
      nextFfmpeg.stdout.pipe(socket);
      try {
        pcmServer.close();
      } catch {
        // Ignore close after single client handoff
      }
    });
    staged.pcmServer = pcmServer;
    this.nextQueued = staged;

    await new Promise((resolve) => {
      pcmServer.listen(pcmPipeName, resolve);
    });
    if (mySession !== this.sessionId || this.nextQueued !== staged) {
      try {
        nextFfmpeg.kill();
        pcmServer.close();
      } catch {
        // Ignore
      }
      return { ok: false, queued: false, reason: 'cancelled' };
    }

    const queuePayload = {
      seq,
      isDop: false,
      pipe: pcmPipeName,
      rate: targetRate,
      ch: targetChannels,
      inFmt: pipeFmt.inFmt,
      srcBits: pipeFmt.effectiveSrcBits,
      exclusive: ratePlan.useExclusive,
      push: pushMode,
      bufferMs,
      preRollMs,
      gain: safeGain
    };
    this.sendCommand(`QUEUE_NEXT_JSON ${JSON.stringify(queuePayload)}`);
    logger.info('WasapiEngine', isCrossFormat ? 'Queued cross-rate in-process transition' : 'Queued 0 ms gapless next PCM stream', {
      filePath: safePath,
      seq,
      crossFormat: isCrossFormat,
      inFmt: pipeFmt.inFmt,
      srcBits: pipeFmt.effectiveSrcBits,
      sampleRate: targetRate,
      channels: targetChannels,
      preRollMs
    });
    return { ok: true, queued: true, crossFormat: isCrossFormat, seq, probe, ratePlan };
  }
}

/**
 * Bidirectional Windows Core Audio IAudioEndpointVolume bridge (VANTA <-> Windows Taskbar/Keys).
 */
class WindowsVolumeBridge {
  constructor(onVolumeEvent, onDevicesChanged) {
    this.onVolumeEvent = typeof onVolumeEvent === 'function' ? onVolumeEvent : () => {};
    this.onDevicesChanged = typeof onDevicesChanged === 'function' ? onDevicesChanged : () => {};
    this.proc = null;
    this.lastState = { level: 1.0, muted: false, hwSupport: 3, deviceName: '' };
  }

  /**
   * Starts the background `--volume-monitor` native bridge if not already active.
   * @param {string} [deviceId=''] - Optional WASAPI endpoint ID.
   */
  start(deviceId = '') {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    const engineBin = resolveWasapiEngineBinary();
    if (!engineBin) return;

    const args = ['--volume-monitor'];
    if (deviceId) args.push('--device', deviceId);

    this.proc = spawn(engineBin, args, { windowsHide: true });
    this.proc.stdin.on('error', () => {});

    let buf = '';
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.event === 'volume') {
            this.lastState = {
              level: Number.isFinite(evt.level) ? evt.level : this.lastState.level,
              muted: Boolean(evt.muted),
              hwSupport: evt.hwSupport !== undefined ? evt.hwSupport : this.lastState.hwSupport,
              deviceName: evt.deviceName || this.lastState.deviceName
            };
            this.onVolumeEvent(this.lastState);
          } else if (evt.event === 'devices_changed') {
            this.onDevicesChanged();
          }
        } catch {
          // Ignore malformed line
        }
      }
    });
  }

  /**
   * Sets the Windows Master Endpoint Volume level cleanly (0.0 to 1.0).
   * @param {number} level01 - Linear scalar in [0, 1].
   */
  setVolume(level01) {
    const val = Math.max(0, Math.min(1, Number(level01) || 0));
    this.lastState.level = val;
    if (val > 0) this.lastState.muted = false;
    this._send(`VOL ${val.toFixed(4)}`);
  }

  /**
   * Sets the Windows Master Endpoint Mute flag.
   * @param {boolean} muted - Mute state.
   */
  setMute(muted) {
    this.lastState.muted = Boolean(muted);
    this._send(`MUTE ${muted ? '1' : '0'}`);
  }

  /**
   * Switches which WASAPI endpoint ID the volume bridge monitors & adjusts.
   * @param {string} [deviceId=''] - Target WASAPI endpoint ID (empty for OS default).
   */
  setDevice(deviceId = '') {
    this._send(deviceId ? `DEVICE ${deviceId}` : 'DEVICE');
  }

  _send(cmd) {
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null) {
      this.start();
    }
    if (this.proc && !this.proc.stdin.destroyed) {
      try {
        this.proc.stdin.write(`${cmd}\n`);
      } catch {
        // Ignore write error
      }
    }
  }

  /**
   * Terminates the background `--volume-monitor` native helper cleanly.
   */
  stop() {
    if (this.proc) {
      try {
        if (!this.proc.stdin.destroyed) this.proc.stdin.write('QUIT\n');
        this.proc.kill();
      } catch {
        // Ignore
      }
      this.proc = null;
    }
  }
}

/**
 * Losslessly updates container/Vorbis/MP4 metadata tags on non-MP3 media files (.flac, .m4a,
 * .wav, .aiff, .ogg, .opus, .mp4) via bundled ffmpeg `-c copy -map_metadata 0`.
 * @param {string} filePath - Target media file path.
 * @param {object} [patch={}] - Metadata fields to write.
 * @returns {Promise<{ ok: boolean, error?: string }>} Write status.
 */
async function writeFfmpegMetadataOnDisk(filePath, patch = {}) {
  const ffmpegBin = resolveFfmpegBinary();
  if (!ffmpegBin) return { ok: false, error: 'FFmpeg binary not found' };
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
  if (!safePath) return { ok: false, error: 'Media file not found or rejected by path policy' };

  const ext = path.extname(safePath);
  const dir = path.dirname(safePath);
  const stem = path.basename(safePath, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
  const tmpPath = path.join(dir, `.vanta-tagtmp-${stem.slice(0, 24)}-${crypto.randomUUID()}${ext}`);

  const metaArgs = [];
  const pushMeta = (k, v) => {
    if (v !== undefined && v !== null) {
      const cleanVal = String(v).replace(/[\r\n\0]/g, ' ').trim().slice(0, 512);
      metaArgs.push('-metadata', `${k}=${cleanVal}`);
    }
  };
  pushMeta('title', patch.title);
  pushMeta('artist', patch.artist);
  pushMeta('album', patch.album);
  pushMeta('genre', patch.genre);
  if (patch.bpm !== undefined) {
    pushMeta('bpm', patch.bpm);
    pushMeta('TBPM', patch.bpm);
  }
  if (patch.key !== undefined) {
    pushMeta('initial_key', patch.key);
    pushMeta('INITIALKEY', patch.key);
  }
  pushMeta('date', patch.year);
  if (patch.replayGainTrackGainDb !== undefined && patch.replayGainTrackGainDb !== null) {
    pushMeta('REPLAYGAIN_TRACK_GAIN', formatReplayGainDb(patch.replayGainTrackGainDb));
  }
  if (patch.replayGainTrackPeak !== undefined && patch.replayGainTrackPeak !== null) {
    pushMeta('REPLAYGAIN_TRACK_PEAK', formatReplayGainPeak(patch.replayGainTrackPeak));
  }
  if (patch.replayGainAlbumGainDb !== undefined && patch.replayGainAlbumGainDb !== null) {
    pushMeta('REPLAYGAIN_ALBUM_GAIN', formatReplayGainDb(patch.replayGainAlbumGainDb));
  }
  if (patch.replayGainAlbumPeak !== undefined && patch.replayGainAlbumPeak !== null) {
    pushMeta('REPLAYGAIN_ALBUM_PEAK', formatReplayGainPeak(patch.replayGainAlbumPeak));
  }

  if (!metaArgs.length) return { ok: true };

  try {
    await execFileAsync(
      ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', safePath, '-map', '0', '-map_metadata', '0', '-c', 'copy', ...metaArgs, tmpPath],
      { timeout: 15000 }
    );
    if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
      return { ok: false, error: 'Tagged temp file was empty' };
    }
    fs.renameSync(tmpPath, safePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
  }
}

/**
 * Builds high-precision FFmpeg `aresample` filter arguments (64-bit `dblp` internal precision,
 * 128-tap Kaiser-windowed sinc with beta=14, 4096 phases) only when sample-rate conversion or
 * explicit dithered downsampling is required. Returns an empty array for native-rate PCM passthrough.
 * @param {number} sourceRate - Input stream sample rate in Hz.
 * @param {number} targetRate - Target output sample rate in Hz.
 * @param {{ force?: boolean, ditherMethod?: string }} [options={}] - Optional filter overrides.
 * @returns {string[]} FFmpeg CLI argument array.
 */
function buildHighPrecisionResampleArgs(sourceRate, targetRate, options = {}) {
  const src = Number(sourceRate) || 0;
  const dst = Number(targetRate) || 0;
  const needsRateChange = dst > 0 && (src <= 0 || Math.round(src) !== Math.round(dst));
  if (!needsRateChange && options.force !== true) {
    return [];
  }

  const params = [
    'resampler=swr',
    'tsf=dblp',
    'filter_type=kaiser',
    'filter_size=256',
    'phase_shift=12',
    'kaiser_beta=16',
    'cutoff=0.95',
    'exact_rational=1'
  ];
  if (dst > 0) params.push(`osr=${Math.round(dst)}`);
  if (typeof options.ditherMethod === 'string' && /^[a-z_]+$/.test(options.ditherMethod)) {
    params.push(`dither_method=${options.ditherMethod}`);
  }
  return ['-af', `aresample=${params.join(':')}`];
}

/**
 * Sanitizes a PurePath 64 native DSP wire string (`b0,...,b9|bass|bassDb|xf|xfPct|limiter`).
 * @param {string} [rawSpec=''] - Untrusted wire string.
 * @returns {string} Validated DSP spec or empty string.
 */
function sanitizeNativeDspSpec(rawSpec = '') {
  if (typeof rawSpec !== 'string') return '';
  const trimmed = rawSpec.trim();
  if (!trimmed || trimmed.length > 160) return '';
  return /^[0-9.,\-+|]+$/.test(trimmed) ? trimmed : '';
}

/**
 * Sanitizes a 32-band AutoEQ/Parametric EQ wire spec (`preamp;TYPE,fc,q,gain;...`).
 * @param {string} [rawSpec=''] - Untrusted PEQ wire spec.
 * @returns {string} Validated spec or empty string.
 */
function sanitizePeqWireSpec(rawSpec = '') {
  if (typeof rawSpec !== 'string') return '';
  const trimmed = rawSpec.trim();
  if (!trimmed || trimmed.length > 2048) return '';
  if (!/^[-+]?[0-9]+(?:\.[0-9]+)?(?:;(?:PK|LSC|HSC|LPQ|HPQ|NO|AP),[-+]?[0-9]+(?:\.[0-9]+)?,[-+]?[0-9]+(?:\.[0-9]+)?,[-+]?[0-9]+(?:\.[0-9]+)?){0,32}$/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

/**
 * Inspects a local RIFF/WAVE file header for valid PCM/IEEE-Float IR parameters.
 * @param {string} wavPath - Candidate WAV impulse path.
 * @returns {{ ok: boolean, filePath?: string, sampleRate?: number, channels?: number, bitsPerSample?: number, frames?: number, durationSec?: number, error?: string }}
 */
function inspectWavHeader(wavPath) {
  const safePath = validateSafeFilePath(wavPath, { allowedExtensions: new Set(['.wav']) });
  if (!safePath) return { ok: false, error: 'Rejected non-WAV or unsafe IR path' };
  let fd = null;
  try {
    fd = fs.openSync(safePath, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 44 || st.size > 134217728) {
      return { ok: false, error: 'IR WAV file size out of range (44 B .. 128 MB)' };
    }
    const readBytes = Math.min(st.size, 65536);
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, 0);
    if (buf.subarray(0, 4).toString('ascii') !== 'RIFF' || buf.subarray(8, 12).toString('ascii') !== 'WAVE') {
      return { ok: false, error: 'Not a valid RIFF/WAVE header' };
    }

    let pos = 12;
    let fmtTag = 0;
    let channels = 0;
    let sampleRate = 0;
    let blockAlign = 0;
    let bitsPerSample = 0;
    let dataSize = 0;
    let gotFmt = false;
    let gotData = false;

    while (pos + 8 <= st.size) {
      let hdr;
      if (pos + 8 <= readBytes) {
        hdr = buf.subarray(pos, pos + 8);
      } else {
        hdr = Buffer.alloc(8);
        if (fs.readSync(fd, hdr, 0, 8, pos) !== 8) break;
      }
      const id = hdr.subarray(0, 4).toString('ascii');
      const sz = hdr.readUInt32LE(4);
      if (id === 'fmt ' && sz >= 16) {
        const fBuf = Buffer.alloc(Math.min(64, sz));
        fs.readSync(fd, fBuf, 0, fBuf.length, pos + 8);
        fmtTag = fBuf.readUInt16LE(0);
        channels = fBuf.readUInt16LE(2);
        sampleRate = fBuf.readUInt32LE(4);
        blockAlign = fBuf.readUInt16LE(12);
        bitsPerSample = fBuf.readUInt16LE(14);
        if (fmtTag === 0xfffe && fBuf.length >= 26) {
          fmtTag = fBuf.readUInt16LE(24);
        }
        gotFmt = true;
      } else if (id === 'data') {
        dataSize = sz;
        gotData = true;
        break;
      }
      pos += 8 + sz + (sz & 1);
    }

    if (!gotFmt || !gotData) return { ok: false, error: 'Incomplete WAV fmt/data chunks' };
    if (![1, 3].includes(fmtTag)) return { ok: false, error: 'IR WAV must be PCM or IEEE float' };
    if (![1, 2, 4].includes(channels)) return { ok: false, error: 'IR WAV must be 1ch, 2ch, or 4ch (True Stereo)' };
    if (sampleRate < 8000 || sampleRate > 768000 || blockAlign === 0) return { ok: false, error: 'Invalid IR sample rate' };
    const frames = Math.floor(dataSize / blockAlign);
    if (frames <= 0 || frames > 16777216) return { ok: false, error: 'IR length exceeds 16M frames' };

    return {
      ok: true,
      filePath: safePath,
      sampleRate,
      channels,
      bitsPerSample,
      frames,
      durationSec: Number((frames / sampleRate).toFixed(3))
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Prepares an IR WAV file for a specific engine sample rate, pre-resampling mismatches cleanly
 * via FFmpeg 64-bit dblp 256-tap Kaiser-Sinc (beta=16) to `pcm_f64le` WAV.
 * @param {string} wavPath - Verified WAV file path.
 * @param {number} targetRate - Engine target sample rate in Hz.
 * @returns {Promise<{ ok: boolean, preparedPath?: string, resampled?: boolean, info?: object, error?: string }>}
 */
async function prepareConvolutionIrFile(wavPath, targetRate = 48000) {
  const info = inspectWavHeader(wavPath);
  if (!info.ok || !info.filePath) return { ok: false, error: info.error || 'Invalid WAV IR' };
  const dstRate = Math.max(8000, Math.min(768000, Math.round(Number(targetRate) || info.sampleRate)));
  if (info.sampleRate === dstRate) {
    return { ok: true, preparedPath: info.filePath, resampled: false, info };
  }

  const ffmpegBin = resolveFfmpegBinary();
  if (!ffmpegBin) {
    // Allow C++ standalone fallback resampler to handle rate matching gracefully
    return { ok: true, preparedPath: info.filePath, resampled: false, info };
  }

  try {
    const cacheDir = path.join(os.tmpdir(), 'vanta-ir-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const st = fs.statSync(info.filePath);
    const cacheKey = crypto
      .createHash('sha1')
      .update(`${info.filePath}|${st.size}|${st.mtimeMs}|${dstRate}`)
      .digest('hex')
      .slice(0, 16);
    const cachedWav = path.join(cacheDir, `ir_${cacheKey}_${dstRate}.wav`);
    if (fs.existsSync(cachedWav) && fs.statSync(cachedWav).size >= 44) {
      const cachedInfo = inspectWavHeader(cachedWav);
      return {
        ok: true,
        preparedPath: cachedWav,
        resampled: true,
        info: cachedInfo.ok ? cachedInfo : { ...info, sampleRate: dstRate, bitsPerSample: 64 }
      };
    }
    const resampleArgs = buildHighPrecisionResampleArgs(info.sampleRate, dstRate, { force: true });
    await execFileAsync(
      ffmpegBin,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', info.filePath, ...resampleArgs, '-c:a', 'pcm_f64le', '-f', 'wav', cachedWav],
      { timeout: 20000 }
    );
    if (!fs.existsSync(cachedWav) || fs.statSync(cachedWav).size < 44) {
      return { ok: true, preparedPath: info.filePath, resampled: false, info };
    }
    const resampledInfo = inspectWavHeader(cachedWav);
    return {
      ok: true,
      preparedPath: cachedWav,
      resampled: true,
      info: resampledInfo.ok ? resampledInfo : { ...info, sampleRate: dstRate, bitsPerSample: 64 }
    };
  } catch (err) {
    logger.warn('ConvolverIR', 'FFmpeg offline IR pre-resample fallback to native sinc', { error: err?.message });
    return { ok: true, preparedPath: info.filePath, resampled: false, info };
  }
}

/**
 * Serializes renderer DSP state into the PurePath 64 native WASAPI engine wire format:
 * `b0,b1,...,b9|bassFlag|bassDb|crossfeedFlag|crossfeedPct|limiterFlag`.
 * @param {object} [state={}] - DSP state or precomputed `bandGains` array.
 * @returns {string} Compact PurePath 64 specification string.
 */
function serializeNativeDspConfig(state = {}) {
  const clamp = (val, lo, hi, fallback) => {
    const n = Number(val);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  const fmt = (n) => Number(n.toFixed(2)).toString();
  const rawBands = Array.isArray(state.bandGains)
    ? state.bandGains
    : (state.eqEnabled && Array.isArray(state.gains) ? state.gains : []);
  const bands = Array.from({ length: 10 }, (_, idx) => fmt(clamp(rawBands[idx], -12, 12, 0)));
  const bass = state.bassBoost || state.bass ? 1 : 0;
  const bassDb = fmt(clamp(state.bassBoostDb ?? state.bassDb, 0, 9, 5.5));
  const crossfeed = state.crossfeed ? 1 : 0;
  const xfPct = fmt(clamp(state.crossfeedLevelPct ?? state.crossfeedPct, 0, 100, 55));
  const limiter = state.limiter ? 1 : 0;
  return `${bands.join(',')}|${bass}|${bassDb}|${crossfeed}|${xfPct}|${limiter}`;
}

module.exports = {
  resolveFfmpegBinary,
  resolveWasapiEngineBinary,
  parseFfmpegProbeOutput,
  probeAudioStreamInfo,
  parseMediaContainerProbe,
  probeMediaStreams,
  decideVideoPlaybackStrategy,
  convertSrtToVtt,
  writeFfmpegMetadataOnDisk,
  parseEbuR128Summary,
  measureEbuR128Loudness,
  readReplayGainTagsForFile,
  computeAlbumLoudnessSummary,
  analyzeAlbumReplayGain,
  listWasapiDevices,
  listAsioDevices,
  listSacdIsoTracks,
  buildSacdCatalogTracks,
  inspectWavPackDsdHeader,
  clearDeviceCapsCache,
  probeWasapiDeviceCaps,
  selectOptimalExclusiveTargetRate,
  selectFfmpegPipeFormat,
  isNativeDsdFile,
  needsLosslessPcmTranscode,
  buildHighPrecisionResampleArgs,
  sanitizeNativeDspSpec,
  sanitizePeqWireSpec,
  serializeNativeDspConfig,
  inspectWavHeader,
  prepareConvolutionIrFile,
  NativeWasapiPlayer,
  WindowsVolumeBridge
};
