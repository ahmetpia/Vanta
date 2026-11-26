'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const logger = require('./loggerService.cjs');
const { validateSafeFilePath } = require('./pathSecurityService.cjs');

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
      resolve(parseFfmpegProbeOutput(stderr || ''));
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
    replayGainDb: Number(desiredGainDb.toFixed(2)),
    linearGain
  };
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
    this.ffmpegProc = null;
    this.engineProc = null;
    this.ctrlServer = null;
    this.ctrlSocket = null;
    this.sessionId = 0;
    this.seekOffsetSec = 0;
    this.currentFilePath = '';
    this.currentProbe = null;
    this.currentOptions = {};
  }

  /**
   * Stops any active native playback session and cleans up child processes and pipe.
   */
  stop() {
    this.sessionId++;
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
   * Windows releases the WASAPI Exclusive endpoint handle cleanly.
   * @returns {Promise<void>}
   */
  async stopAsync() {
    this.sessionId++;
    const proc = this.engineProc;
    const hadProc = Boolean(proc && proc.exitCode === null && !proc.killed);

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

    if (hadProc) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          this.engineProc = null;
          setTimeout(resolve, 260);
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
        }, 200);
        setTimeout(finish, 420);
      });
    } else {
      this.stop();
    }
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

    const safePath = validateSafeFilePath(filePath, { allowedExtensions: BRIDGE_MEDIA_EXTENSIONS });
    if (!safePath) {
      throw new Error('Invalid or rejected audio file path');
    }

    let safeDeviceId = '';
    if (typeof options.deviceId === 'string' && options.deviceId.trim()) {
      const requestedId = options.deviceId.trim();
      if (!knownWasapiDeviceIds.has(requestedId)) {
        await listWasapiDevices();
      }
      safeDeviceId = knownWasapiDeviceIds.get(requestedId) || '';
    }
    const safeGain = Number.isFinite(Number(options.linearGain))
      ? Math.max(0, Math.min(4.0, Number(options.linearGain)))
      : 1.0;

    const ffmpegBin = resolveFfmpegBinary();
    const engineBin = resolveWasapiEngineBinary();
    const useNativeDop = Boolean(options.dop) && options.exclusive !== false && isNativeDsdFile(safePath);
    if ((!useNativeDop && !ffmpegBin) || !engineBin) {
      throw new Error('Missing ffmpeg-static or vanta-audio-engine.exe');
    }

    this.currentFilePath = safePath;
    this.currentOptions = options;
    this.seekOffsetSec = Math.max(0, Number(options.seekSec) || 0);

    const probe = options.probe || (await probeAudioStreamInfo(safePath));
    if (mySession !== this.sessionId) return;
    this.currentProbe = probe;

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

    if (useNativeDop) {
      const engArgs = [
        '--exclusive',
        '--dop-file',
        safePath,
        '--seek-sec',
        String(this.seekOffsetSec.toFixed(3)),
        '--ctrl-pipe',
        pipeName
      ];
      if (safeDeviceId) {
        engArgs.push('--device', safeDeviceId);
      }

      logger.info('WasapiEngine', 'Starting Native DoP v1.1 session', {
        filePath: safePath,
        sampleRate: probe.sampleRate,
        codec: probe.codec,
        channels: probe.channels,
        seekSec: this.seekOffsetSec
      });

      this.ffmpegProc = null;
      this.engineProc = spawn(engineBin, engArgs, { windowsHide: true });
    } else {
      const ffArgs = ['-hide_banner', '-loglevel', 'error'];
      if (this.seekOffsetSec > 0) {
        ffArgs.push('-ss', String(this.seekOffsetSec.toFixed(3)));
      }
      const rawRate = Number(probe.sampleRate) || 48000;
      // Decode 1-bit DSD streams (>768 kHz raw clock) at studio DXD 352.8 kHz; cap PCM at 768 kHz
      const targetRate = rawRate > 768000 ? 352800 : Math.max(8000, Math.min(768000, rawRate));
      const targetChannels = Math.max(1, Math.min(8, Number(probe.channels) || 2));

      ffArgs.push(
        '-i',
        safePath,
        '-vn',
        '-f',
        's32le',
        '-acodec',
        'pcm_s32le',
        '-ac',
        String(targetChannels),
        '-ar',
        String(targetRate),
        '-'
      );

      const engArgs = [
        options.exclusive === false ? '--shared' : '--exclusive',
        '--rate',
        String(targetRate),
        '--channels',
        String(targetChannels),
        '--gain',
        String(safeGain),
        '--ctrl-pipe',
        pipeName
      ];
      if (safeDeviceId) {
        engArgs.push('--device', safeDeviceId);
      }

      logger.info('WasapiEngine', 'Starting native WASAPI session', {
        filePath: safePath,
        exclusive: options.exclusive !== false,
        sampleRate: probe.sampleRate,
        codec: probe.codec,
        bitDepth: probe.bitDepth,
        linearGain: safeGain
      });

      this.ffmpegProc = spawn(ffmpegBin, ffArgs, { windowsHide: true });
      this.engineProc = spawn(engineBin, engArgs, { windowsHide: true });

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
          if (evt.event === 'spectrum') {
            evt.positionSec = this.seekOffsetSec + (evt.positionMs || 0) / 1000;
            evt.durationSec = probe.durationSec || 0;
          } else if (evt.event === 'ready') {
            receivedReady = true;
            evt.codec = probe.codec;
            evt.bitrateKbps = probe.bitrateKbps;
            evt.durationSec = probe.durationSec;
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
      if (useNativeDop && !receivedReady && (dopUnsupported || exitCode === 10) && !fallbackTriggered) {
        fallbackTriggered = true;
        this.play(filePath, { ...options, dop: false, probe }).catch((err) => {
          this.onEvent({ event: 'error', message: err.message });
        });
        return;
      }
      this.onEvent({ event: 'closed' });
    });
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
  listWasapiDevices,
  isNativeDsdFile,
  needsLosslessPcmTranscode,
  NativeWasapiPlayer,
  WindowsVolumeBridge
};
