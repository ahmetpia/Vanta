'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const logger = require('./loggerService.cjs');
const { resolveFfmpegBinary } = require('./audioBridgeService.cjs');
const {
  validateSafeFilePath,
  resolveSafeVaultSubfolder
} = require('./pathSecurityService.cjs');
const { computeAudioPayloadFingerprint } = require('./libraryService.cjs');

const HTDEMUCS_MODEL_META = Object.freeze({
  filename: 'htdemucs_fp16weights.onnx',
  sha256: 'd05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a',
  url: 'https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx',
  license: 'MIT',
  expectedBytes: 165612636
});

const DEFAULT_VAULT_ROOT = 'C:\\Vanta\\VantaVault';
const PRE_ROLL_SEC = 0.15;
const PRE_ROLL_MS = 150;
const MIN_WINDOW_SEC = 5;
const DEFAULT_MAX_WINDOW_SEC = 480; // Guardrail for very long DJ mixes unless overridden
const VALID_STEMS = new Set(['drums', 'bass', 'other', 'vocals']);

/**
 * Normalizes and clamps transcription start/duration parameters safely.
 * Allows targeting any section of long tracks while enforcing `[MIN_WINDOW_SEC, DEFAULT_MAX_WINDOW_SEC]`
 * when an explicit window duration or end time is provided.
 * @param {object} [opts={}] - `{ startSec, durationSec, endSec }`.
 * @returns {{ startSec: number, durationSec: number }} Normalized integer second bounds.
 */
function normalizeTranscriptionWindow(opts = {}) {
  const startSec = Math.max(0, Math.round(Number(opts.startSec) || 0));
  const rawDuration = Math.round(Number(opts.durationSec) || 0);
  const rawEnd = Math.round(Number(opts.endSec) || 0);
  const derivedDuration = !(rawDuration > 0) && rawEnd > startSec ? (rawEnd - startSec) : rawDuration;
  const durationSec = derivedDuration > 0
    ? Math.max(MIN_WINDOW_SEC, Math.min(DEFAULT_MAX_WINDOW_SEC, derivedDuration))
    : 0;
  return { startSec, durationSec };
}

const activeJobs = new Map();

/**
 * Resolves `basic-pitch-rs.exe` from packaged resources or workspace `bin/`.
 * @returns {string} Absolute path or empty string.
 */
function resolveBasicPitchBinary() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'basic-pitch-rs.exe') : '',
    path.join(__dirname, '..', '..', 'bin', 'basic-pitch-rs.exe'),
    'C:\\Vanta\\bin\\basic-pitch-rs.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * Resolves `vanta-stem-engine.exe` from packaged resources or workspace `bin/`.
 * @returns {string} Absolute path or empty string.
 */
function resolveStemEngineBinary() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bin', 'vanta-stem-engine.exe') : '',
    path.join(__dirname, '..', '..', 'bin', 'vanta-stem-engine.exe'),
    'C:\\Vanta\\bin\\vanta-stem-engine.exe'
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * Resolves the MIT-licensed HTDemucs ONNX weights path.
 * @param {string} [vaultRoot=DEFAULT_VAULT_ROOT] - Vault root directory.
 * @returns {string} Existing model path or empty string.
 */
function resolveHtdemucsModelPath(vaultRoot = DEFAULT_VAULT_ROOT) {
  const safeModelsDir = resolveSafeVaultSubfolder(vaultRoot, 'models');
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'models', HTDEMUCS_MODEL_META.filename) : '',
    safeModelsDir ? path.join(safeModelsDir, HTDEMUCS_MODEL_META.filename) : '',
    path.join('C:\\Vanta\\VantaVault\\Models', HTDEMUCS_MODEL_META.filename)
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * Returns readiness status of local transcription and HTDemucs stem separation binaries/models.
 * @param {string} [vaultRoot=DEFAULT_VAULT_ROOT] - Vault root directory.
 * @returns {object} Engine capability status object.
 */
function getTranscriptionEngineStatus(vaultRoot = DEFAULT_VAULT_ROOT) {
  const ffmpegPath = resolveFfmpegBinary();
  const basicPitchPath = resolveBasicPitchBinary();
  const stemEnginePath = resolveStemEngineBinary();
  const htdemucsModelPath = resolveHtdemucsModelPath(vaultRoot);
  return {
    readyDirect: Boolean(ffmpegPath && basicPitchPath),
    readyStems: Boolean(ffmpegPath && basicPitchPath && stemEnginePath && htdemucsModelPath),
    hasFfmpeg: Boolean(ffmpegPath),
    hasBasicPitch: Boolean(basicPitchPath),
    hasStemEngine: Boolean(stemEnginePath),
    hasHtdemucsModel: Boolean(htdemucsModelPath),
    htdemucsModelMeta: {
      filename: HTDEMUCS_MODEL_META.filename,
      license: HTDEMUCS_MODEL_META.license,
      expectedBytes: HTDEMUCS_MODEL_META.expectedBytes,
      sha256: HTDEMUCS_MODEL_META.sha256
    }
  };
}

/**
 * Builds an acoustic pre-conditioning filter string for FFmpeg based on the chosen focus profile.
 * Always prepends a 150 ms silence delay so initial note attacks at t=0.00s are preserved cleanly.
 * @param {string} focusProfile - `'solo'|'melody'|'chords'|'bass'|'full'`.
 * @returns {string} FFmpeg `-af` filter graph.
 */
function buildPreconditionAudioFilter(focusProfile = 'solo') {
  const p = String(focusProfile || 'solo').toLowerCase();
  const pad = `adelay=${PRE_ROLL_MS}:all=1`;
  switch (p) {
    case 'melody':
      return `pan=mono|c0=0.5*c0+0.5*c1,highpass=f=110,lowpass=f=4200,${pad}`;
    case 'chords':
      return `pan=mono|c0=0.65*c0-0.35*c1,highpass=f=60,lowpass=f=3200,${pad}`;
    case 'bass':
      return `pan=mono|c0=0.5*c0+0.5*c1,highpass=f=28,lowpass=f=280,${pad}`;
    case 'solo':
      return `pan=mono|c0=0.5*c0+0.5*c1,highpass=f=28,${pad}`;
    case 'full':
    default:
      return `pan=mono|c0=0.5*c0+0.5*c1,${pad}`;
  }
}

/**
 * Sanitizes a cache key segment strictly to lowercase alphanumeric/underscore/hyphen characters.
 * @param {string} raw - Untrusted cache key component.
 * @returns {string} Safe token.
 */
function sanitizeCacheToken(raw) {
  return String(raw || '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '_')
    .slice(0, 64);
}

/**
 * Computes a deterministic cache key for a track transcription configuration.
 * @param {string} filePath - Canonical media file path.
 * @param {object} opts - Transcription parameters.
 * @returns {{ audioHash: string, cacheKey: string, stemCacheKey: string }}
 */
function computeScoreCacheKeys(filePath, opts = {}) {
  const rawHash = computeAudioPayloadFingerprint(filePath) ||
    crypto.createHash('sha256').update(String(filePath)).digest('hex').slice(0, 24);
  const audioHash = sanitizeCacheToken(rawHash);
  const mode = opts.mode === 'htdemucs' ? 'htdemucs' : 'direct';
  const focus = sanitizeCacheToken(opts.focusProfile || 'solo');
  const stemsKey = Array.isArray(opts.stems) && opts.stems.length
    ? [...new Set(opts.stems.map((s) => String(s).toLowerCase()).filter((s) => VALID_STEMS.has(s)))].sort((a, b) => a.localeCompare(b, 'en')).join('-')
    : 'other';
  const win = normalizeTranscriptionWindow(opts);
  const winTag = win.startSec > 0 || win.durationSec > 0 ? `_w${win.startSec}_${win.durationSec}` : '';

  const cacheKey = mode === 'htdemucs'
    ? `${audioHash}_htdemucs_${stemsKey}${winTag}`
    : `${audioHash}_direct_${focus}${winTag}`;
  const stemCacheKey = `${audioHash}${winTag}`;
  return { audioHash, cacheKey, stemCacheKey };
}

/**
 * Spawns a child process safely with `shell: false`, tracking it in `job` for clean cancellation.
 * @param {object|null} job - Active job record.
 * @param {string} binPath - Executable path.
 * @param {string[]} args - Argument array.
 * @param {object} [opts={}] - `{ onStdoutLine }`.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runTrackedChild(job, binPath, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) {
      reject(new Error('Transcription job cancelled'));
      return;
    }

    const child = spawn(binPath, args, { windowsHide: true, shell: false });
    if (job) job.children.add(child);

    const stdoutChunks = [];
    const stderrChunks = [];
    let lineBuf = '';

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      if (typeof opts.onStdoutLine === 'function') {
        lineBuf += chunk.toString('utf8');
        let idx;
        while ((idx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, idx).trim();
          lineBuf = lineBuf.slice(idx + 1);
          if (line) opts.onStdoutLine(line);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      if (job) job.children.delete(child);
      reject(err);
    });

    child.on('close', (code) => {
      if (job) job.children.delete(child);
      if (lineBuf.trim() && typeof opts.onStdoutLine === 'function') {
        opts.onStdoutLine(lineBuf.trim());
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (job?.cancelled) {
        reject(new Error('Transcription job cancelled'));
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(binPath)} exited with code ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function buildFfmpegWindowArgs(opts = {}) {
  const win = normalizeTranscriptionWindow(opts);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const durSec = win.durationSec > 0 ? win.durationSec : DEFAULT_MAX_WINDOW_SEC;
  if (win.startSec > 0) args.push('-ss', String(win.startSec));
  if (durSec > 0) args.push('-t', String(durSec));
  return args;
}

/**
 * Decodes and pre-conditions an audio/video file to 22,050 Hz mono WAV with 150ms pre-roll silence.
 * @private
 */
async function decodePreconditionedMonoWav(job, ffmpegBin, srcPath, dstWavPath, opts = {}) {
  const args = buildFfmpegWindowArgs(opts);
  args.push(
    '-i', srcPath,
    '-vn',
    '-af', buildPreconditionAudioFilter(opts.focusProfile || 'solo'),
    '-ar', '22050',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    dstWavPath
  );
  await runTrackedChild(job, ffmpegBin, args);
}

/**
 * Decodes an audio/video file to 44,100 Hz stereo float32 WAV for HTDemucs inference.
 * @private
 */
async function decodeDemucsStereoWav(job, ffmpegBin, srcPath, dstWavPath, opts = {}) {
  const args = buildFfmpegWindowArgs(opts);
  args.push(
    '-i', srcPath,
    '-vn',
    '-ar', '44100',
    '-ac', '2',
    '-c:a', 'pcm_f32le',
    dstWavPath
  );
  await runTrackedChild(job, ffmpegBin, args);
}

/**
 * Runs `basic-pitch-rs.exe` on a prepared 22,050 Hz mono WAV and returns normalized notes.
 * Subtracts the 150ms pre-roll offset from every note timestamp cleanly.
 * @private
 */
async function runBasicPitchProvider(job, bpBin, wavPath, stemTag = 'mix', bpOpts = {}) {
  const onset = Math.max(0.1, Math.min(0.95, Number(bpOpts.onsetThreshold ?? 0.50)));
  const frame = Math.max(0.1, Math.min(0.95, Number(bpOpts.frameThreshold ?? 0.30)));
  const minNoteMs = Math.max(40, Math.min(500, Number(bpOpts.minNoteLengthMs ?? 80)));

  const args = [
    wavPath,
    '--json',
    '--no-pitch-bends',
    '--onset-threshold', onset.toFixed(2),
    '--frame-threshold', frame.toFixed(2),
    '--minimum-note-length', minNoteMs.toFixed(1),
    '-q',
    '--output', '-'
  ];
  if (bpOpts.minFreqHz) args.push('--minimum-frequency', String(Number(bpOpts.minFreqHz)));
  if (bpOpts.maxFreqHz) args.push('--maximum-frequency', String(Number(bpOpts.maxFreqHz)));

  const { stdout } = await runTrackedChild(job, bpBin, args);
  const cleanJson = stdout.replace(/^\uFEFF/, '').trim();
  const parsed = JSON.parse(cleanJson);
  const notes = Array.isArray(parsed.notes) ? parsed.notes : [];

  return {
    inputDurationSec: Math.max(0, (Number(parsed.input?.duration_s) || 0) - PRE_ROLL_SEC),
    notes: notes.map((n) => {
      const startSec = Math.max(0, Number(n.start_s || 0) - PRE_ROLL_SEC);
      const endSec = Math.max(startSec + 0.03, Number(n.end_s || startSec + 0.1) - PRE_ROLL_SEC);
      return {
        start_s: startSec,
        end_s: endSec,
        pitch: Number(n.pitch),
        note_name: String(n.note_name || ''),
        amplitude: Number(n.amplitude || 0.5),
        velocity: Number(n.velocity || 64),
        stem: stemTag
      };
    })
  };
}

/**
 * Reads a cached transcription payload from `VantaVault/Scores/` if present and valid.
 * @param {string} filePath - Canonical media path.
 * @param {object} [opts={}] - Mode/profile/stem options.
 * @param {string} [vaultRoot=DEFAULT_VAULT_ROOT] - Vault root path.
 * @returns {object|null} Cached transcription payload or null.
 */
function getCachedTranscription(filePath, opts = {}, vaultRoot = DEFAULT_VAULT_ROOT) {
  const safePath = validateSafeFilePath(filePath);
  if (!safePath) return null;
  const scoresDir = resolveSafeVaultSubfolder(vaultRoot, 'scores');
  if (!scoresDir) return null;
  const { cacheKey } = computeScoreCacheKeys(safePath, opts);
  const cacheFile = path.join(scoresDir, `${cacheKey}.score.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (parsed && Array.isArray(parsed.notes)) {
      return { ...parsed, cached: true };
    }
  } catch {
    // Ignore corrupted cache entry
  }
  return null;
}

/**
 * Cancels an in-flight transcription job and terminates any active child processes.
 * @param {string} jobId - Job identifier.
 * @returns {boolean} True if an active job was cancelled.
 */
function cancelTranscriptionJob(jobId) {
  const job = activeJobs.get(String(jobId || ''));
  if (!job) return false;
  job.cancelled = true;
  for (const child of job.children) {
    try {
      child.kill();
    } catch {
      // Ignore already exited child
    }
  }
  activeJobs.delete(String(jobId));
  return true;
}

/**
 * Downloads and SHA-256 verifies the MIT-licensed HTDemucs model into `VantaVault/Models/` if missing.
 * @param {string} [vaultRoot=DEFAULT_VAULT_ROOT] - Vault root directory.
 * @param {(prog: { pct: number, downloadedBytes: number, totalBytes: number }) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, modelPath: string, sha256: string }>}
 */
async function ensureHtdemucsModel(vaultRoot = DEFAULT_VAULT_ROOT, onProgress = null) {
  const existing = resolveHtdemucsModelPath(vaultRoot);
  if (existing) {
    return { ok: true, modelPath: existing, sha256: HTDEMUCS_MODEL_META.sha256 };
  }

  const modelsDir = resolveSafeVaultSubfolder(vaultRoot, 'models');
  if (!modelsDir) throw new Error('Invalid Vault Models directory');
  fs.mkdirSync(modelsDir, { recursive: true });

  const destPath = path.join(modelsDir, HTDEMUCS_MODEL_META.filename);
  const partPath = `${destPath}.part`;

  const res = await fetch(HTDEMUCS_MODEL_META.url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch HTDemucs model (HTTP ${res.status})`);
  }

  const totalBytes = Number(res.headers.get('content-length')) || HTDEMUCS_MODEL_META.expectedBytes;
  const hash = crypto.createHash('sha256');
  const writer = fs.createWriteStream(partPath);
  let downloadedBytes = 0;

  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      writer.write(buf);
      downloadedBytes += buf.length;
      if (typeof onProgress === 'function') {
        onProgress({
          pct: Math.min(99, Math.round((downloadedBytes / Math.max(1, totalBytes)) * 100)),
          downloadedBytes,
          totalBytes
        });
      }
    }
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      writer.end();
    });

    const actualSha = hash.digest('hex').toLowerCase();
    if (actualSha !== HTDEMUCS_MODEL_META.sha256) {
      throw new Error(`HTDemucs SHA-256 mismatch (expected ${HTDEMUCS_MODEL_META.sha256}, got ${actualSha})`);
    }
    fs.renameSync(partPath, destPath);
    if (typeof onProgress === 'function') {
      onProgress({ pct: 100, downloadedBytes, totalBytes });
    }
    logger.info('Transcription', 'Downloaded & SHA-256 verified MIT HTDemucs model', { destPath });
    return { ok: true, modelPath: destPath, sha256: actualSha };
  } catch (err) {
    try { writer.destroy(); } catch {}
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch {}
    throw err;
  }
}

/**
 * Executes the full VANTA audio-to-notes transcription pipeline (`Direct` or `HTDemucs 4-Stem`).
 * @param {string} rawFilePath - Host audio/video file path (must be validated first).
 * @param {object} [opts={}] - Pipeline options `{ jobId, mode, focusProfile, stems, startSec, durationSec, force, vaultRoot, onProgress }`.
 * @returns {Promise<object>} Canonical transcription result payload.
 */
async function transcribeAudioFile(rawFilePath, opts = {}) {
  const vaultRoot = opts.vaultRoot || DEFAULT_VAULT_ROOT;
  const safePath = validateSafeFilePath(rawFilePath);
  if (!safePath) {
    throw new Error('Rejected unsafe or non-existent audio file path');
  }

  const mode = opts.mode === 'htdemucs' ? 'htdemucs' : 'direct';
  const focusProfile = String(opts.focusProfile || 'solo');
  const requestedStems = Array.isArray(opts.stems) && opts.stems.length
    ? [...new Set(opts.stems.map((s) => String(s).toLowerCase()).filter((s) => VALID_STEMS.has(s)))]
    : ['other'];
  if (!requestedStems.length) requestedStems.push('other');
  const win = normalizeTranscriptionWindow(opts);
  const effectiveOpts = {
    ...opts,
    mode,
    focusProfile,
    stems: requestedStems,
    startSec: win.startSec,
    durationSec: win.durationSec
  };

  if (!opts.force) {
    const cached = getCachedTranscription(safePath, effectiveOpts, vaultRoot);
    if (cached) {
      return cached;
    }
  }

  const ffmpegBin = resolveFfmpegBinary();
  const bpBin = resolveBasicPitchBinary();
  if (!ffmpegBin) throw new Error('FFmpeg binary not found');
  if (!bpBin) throw new Error('basic-pitch-rs binary not found in bin/');

  const jobId = String(opts.jobId || crypto.randomUUID());
  const job = { id: jobId, cancelled: false, children: new Set() };
  activeJobs.set(jobId, job);

  const emitProgress = (stage, pct, detail = '') => {
    if (typeof opts.onProgress === 'function') {
      opts.onProgress({ jobId, stage, pct, detail });
    }
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-score-'));
  const t0 = Date.now();

  try {
    const { audioHash, cacheKey, stemCacheKey } = computeScoreCacheKeys(safePath, effectiveOpts);
    const scoresDir = resolveSafeVaultSubfolder(vaultRoot, 'scores');
    if (scoresDir) fs.mkdirSync(scoresDir, { recursive: true });

    let mergedNotes = [];
    let durationSec = 0;
    let stemProvider = 'ffmpeg-direct';

    if (mode === 'htdemucs') {
      const stemExe = resolveStemEngineBinary();
      const modelPath = resolveHtdemucsModelPath(vaultRoot);
      if (!stemExe) throw new Error('vanta-stem-engine.exe not found in bin/');
      if (!modelPath) throw new Error('HTDemucs model missing. Download MIT htdemucs_fp16weights.onnx first.');

      const stemDir = scoresDir
        ? path.join(scoresDir, 'stems', stemCacheKey)
        : path.join(tempDir, 'stems');
      fs.mkdirSync(stemDir, { recursive: true });

      const allStemsExist = ['drums', 'bass', 'other', 'vocals'].every((s) =>
        fs.existsSync(path.join(stemDir, `${s}.wav`))
      );

      if (!allStemsExist || opts.force) {
        emitProgress('decode', 5, 'Decoding 44.1 kHz stereo master via FFmpeg...');
        const stereoWav = path.join(tempDir, 'mix_44k.wav');
        await decodeDemucsStereoWav(job, ffmpegBin, safePath, stereoWav, win);

        emitProgress('htdemucs', 12, 'Separating 4 stems (HTDemucs ONNX)...');
        const stemArgs = [
          '--model', modelPath,
          '--input', stereoWav,
          '--out-dir', stemDir,
          '--provider', 'auto'
        ];
        await runTrackedChild(job, stemExe, stemArgs, {
          onStdoutLine: (line) => {
            try {
              const msg = JSON.parse(line);
              if (msg.type === 'progress') {
                const scaled = 12 + Math.round((Number(msg.pct) || 0) * 0.63);
                emitProgress('htdemucs', scaled, `Separating stems: chunk ${msg.chunk}/${msg.total}`);
              } else if (msg.type === 'init') {
                stemProvider = `htdemucs-${msg.provider || 'cpu'}`;
              }
            } catch {
              // Ignore non-JSON log line
            }
          }
        });
      } else {
        emitProgress('htdemucs', 72, 'Using cached HTDemucs stems...');
        stemProvider = 'htdemucs-cached';
      }

      for (let i = 0; i < requestedStems.length; i++) {
        const stemName = requestedStems[i];
        const stemWav = path.join(stemDir, `${stemName}.wav`);
        if (!fs.existsSync(stemWav)) continue;

        const basePct = 76 + Math.round((i / requestedStems.length) * 20);
        emitProgress('transcribe', basePct, `Transcribing ${stemName} stem notes...`);

        const preWav = path.join(tempDir, `${stemName}_22k.wav`);
        const stemFocus = stemName === 'bass' ? 'bass' : 'solo';
        await decodePreconditionedMonoWav(job, ffmpegBin, stemWav, preWav, {
          focusProfile: stemFocus,
          startSec: 0,
          durationSec: 0
        });
        const bpRes = await runBasicPitchProvider(job, bpBin, preWav, stemName, {
          minFreqHz: stemName === 'bass' ? 28 : 40,
          maxFreqHz: stemName === 'bass' ? 330 : 4186
        });
        durationSec = Math.max(durationSec, bpRes.inputDurationSec);
        mergedNotes.push(...bpRes.notes);
      }
    } else {
      emitProgress('decode', 20, `Pre-conditioning audio (${focusProfile} profile)...`);
      const monoWav = path.join(tempDir, 'mono_22k.wav');
      await decodePreconditionedMonoWav(job, ffmpegBin, safePath, monoWav, {
        focusProfile,
        startSec: win.startSec,
        durationSec: win.durationSec
      });
      emitProgress('transcribe', 55, 'Extracting polyphonic notes via Basic Pitch...');
      const bpRes = await runBasicPitchProvider(job, bpBin, monoWav, 'mix', {
        minFreqHz: focusProfile === 'bass' ? 28 : focusProfile === 'melody' ? 110 : 32,
        maxFreqHz: focusProfile === 'bass' ? 330 : 4186
      });
      durationSec = bpRes.inputDurationSec;
      mergedNotes = bpRes.notes;
    }

    mergedNotes.sort((a, b) => a.start_s - b.start_s || a.pitch - b.pitch);
    const elapsedMs = Date.now() - t0;

    const payload = {
      schemaVersion: 1,
      jobId,
      audioHash,
      cacheKey,
      mode,
      focusProfile,
      stems: requestedStems,
      windowStartSec: win.startSec,
      requestedDurationSec: win.durationSec,
      stemProvider,
      transcriptionProvider: 'basic-pitch-rs-0.2.0',
      durationSec: Number(durationSec.toFixed(3)),
      elapsedMs,
      createdAt: new Date().toISOString(),
      cached: false,
      notes: mergedNotes
    };

    if (scoresDir) {
      const cacheFile = path.join(scoresDir, `${cacheKey}.score.json`);
      fs.writeFileSync(cacheFile, JSON.stringify(payload), 'utf8');
    }

    emitProgress('done', 100, `Completed in ${(elapsedMs / 1000).toFixed(2)}s (${mergedNotes.length} raw notes)`);
    logger.info('Transcription', `Transcribed ${path.basename(safePath)}`, {
      mode,
      focusProfile,
      stems: requestedStems,
      windowStartSec: win.startSec,
      requestedDurationSec: win.durationSec,
      elapsedMs,
      rawNotes: mergedNotes.length
    });
    return payload;
  } finally {
    activeJobs.delete(jobId);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failure
    }
  }
}

module.exports = {
  HTDEMUCS_MODEL_META,
  PRE_ROLL_SEC,
  MIN_WINDOW_SEC,
  DEFAULT_MAX_WINDOW_SEC,
  normalizeTranscriptionWindow,
  resolveBasicPitchBinary,
  resolveStemEngineBinary,
  resolveHtdemucsModelPath,
  getTranscriptionEngineStatus,
  buildPreconditionAudioFilter,
  computeScoreCacheKeys,
  getCachedTranscription,
  cancelTranscriptionJob,
  ensureHtdemucsModel,
  transcribeAudioFile
};
