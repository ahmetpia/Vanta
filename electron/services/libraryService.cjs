'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  decodeSynchsafeInt,
  readId3v2FromFile,
  readFlacMetadataFromFile,
  writeId3v2Tags
} = require('./id3Service.cjs');
const logger = require('./loggerService.cjs');
const { validateSafeDirectoryPath } = require('./pathSecurityService.cjs');

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.wav',
  '.w64',
  '.aiff',
  '.aif',
  '.alac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.dsf',
  '.dff',
  '.ape',
  '.wv'
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.mkv',
  '.mov',
  '.m4v',
  '.avi',
  '.ts',
  '.mpg',
  '.mpeg',
  '.wmv',
  '.flv',
  '.3gp',
  '.ogv'
]);

const IGNORED_DIRECTORIES = new Set([
  'quarantine_duplicates',
  'node_modules',
  '.git',
  '.vscode',
  'appdata',
  'windows',
  'program files',
  'program files (x86)',
  '$recycle.bin',
  'system volume information',
  'dist',
  'build',
  'logs'
]);

// Minimal valid 1x1 Obsidian Violet JPEG buffer used when auto-repairing missing APIC cover frames
const DEFAULT_VANTA_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
);

/**
 * Computes a fast, constant-memory (64 KB max) content fingerprint of a media file
 * using partial file descriptor reads (never loading the full file into RAM).
 * @param {string} filePath - Absolute path to the media file.
 * @returns {string} 16-character hex SHA-256 prefix fingerprint.
 */
function computeAudioPayloadFingerprint(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const headerBuf = Buffer.alloc(10);
    const hdrRead = fs.readSync(fd, headerBuf, 0, 10, 0);
    if (hdrRead <= 0) return '';

    let audioOffset = 0;
    if (hdrRead === 10 && headerBuf.toString('ascii', 0, 3) === 'ID3') {
      audioOffset = 10 + decodeSynchsafeInt(headerBuf, 6);
    }

    const sampleBuf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, sampleBuf, 0, 65536, audioOffset);
    if (bytesRead <= 0) {
      // Fallback to offset 0 if ID3 size exceeded file length
      const fallbackRead = fs.readSync(fd, sampleBuf, 0, 65536, 0);
      return crypto
        .createHash('sha256')
        .update(sampleBuf.subarray(0, fallbackRead))
        .digest('hex')
        .slice(0, 16);
    }

    return crypto
      .createHash('sha256')
      .update(sampleBuf.subarray(0, bytesRead))
      .digest('hex')
      .slice(0, 16);
  } catch (err) {
    logger.warn('Fingerprint', `Failed to fingerprint ${filePath}`, { error: err.message });
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Estimates deterministic BPM, Musical Key, and Energy % from a track's title/fingerprint.
 * @param {string} seedStr - Track title or hash seed.
 * @returns {{ bpm: number, key: string, energy: number, mood: string }}
 */
function inferFallbackDna(seedStr) {
  const keys = ['A min', 'C min', 'F min', 'E min', 'G min', 'D min', 'B min'];
  const moods = ['Night Drive', 'Cybernetic', 'Melancholic', 'High Energy', 'Deep Focus', 'Ethnic Fusion'];
  let hash = 0;
  const s = String(seedStr || 'vanta');
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return {
    bpm: 92 + (hash % 52),
    key: keys[hash % keys.length],
    energy: 68 + (hash % 31),
    mood: moods[hash % moods.length]
  };
}

/**
 * Inspects a single media file and builds its catalog track record without loading full file into RAM.
 * Supports incremental mtime+size caching via `options.statCache` so >1000-track rescans take milliseconds.
 * @param {string} fullPath - Absolute file path.
 * @param {number} index - Track index counter.
 * @param {object} [options] - Optional incremental scan cache state `{ statCache, cacheDirty }`.
 * @returns {object|null} Track metadata record or null if unreadable.
 */
function inspectMediaFile(fullPath, index, options = {}) {
  const ext = path.extname(fullPath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) return null;

  let stat;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }

  const statCache = options?.statCache && typeof options.statCache === 'object' ? options.statCache : null;
  const normKey = statCache ? path.normalize(fullPath).toLowerCase() : '';
  if (statCache && normKey) {
    const cached = statCache[normKey];
    if (
      cached &&
      cached.sizeBytes === stat.size &&
      Math.abs((Number(cached.mtimeMs) || 0) - stat.mtimeMs) < 1 &&
      cached.track
    ) {
      return { ...cached.track };
    }
  }

  const isVideo = VIDEO_EXTENSIONS.has(ext);
  const currentDir = path.dirname(fullPath);
  const fileName = path.basename(fullPath);
  const baseName = path.basename(fileName, ext);
  const id3 = ext === '.mp3' ? readId3v2FromFile(fullPath) : { hasId3: false };
  const flac = ext === '.flac' ? readFlacMetadataFromFile(fullPath) : { hasFlac: false };
  const fallbackDna = inferFallbackDna(baseName);
  const audioHash = computeAudioPayloadFingerprint(fullPath);

  // Only embed coverDataUrl when statCache isn't slimming IPC payload, bounded <= 512 KB
  let coverDataUrl =
    !statCache && id3.coverDataUrl && id3.coverDataUrl.length <= 700000 ? id3.coverDataUrl : '';

  const siblingCover = path.join(currentDir, `${baseName}.jpeg`);
  let hasSiblingCover = false;
  if (fs.existsSync(siblingCover)) {
    hasSiblingCover = true;
    if (!coverDataUrl && !statCache) {
      try {
        const cStat = fs.statSync(siblingCover);
        if (cStat.size <= 512 * 1024) {
          const imgBuf = fs.readFileSync(siblingCover);
          coverDataUrl = `data:image/jpeg;base64,${imgBuf.toString('base64')}`;
        }
      } catch {
        coverDataUrl = '';
      }
    }
  }

  const sourceFolder = path.basename(currentDir);
  let provenance = id3.provenance || 'Local Master';
  if (/made with suno/i.test(provenance)) provenance = 'Suno MP3';
  else if (provenance.length > 28) provenance = `${provenance.slice(0, 26)}…`;
  if (sourceFolder.toLowerCase() === 'youtube') provenance = 'YouTube Vault • 320k';
  if (ext === '.flac') provenance = 'Lossless • FLAC Hi-Res';
  else if (ext === '.alac') provenance = 'Lossless • Apple ALAC';
  else if (ext === '.wav') provenance = 'Lossless • PCM WAV';
  else if (ext === '.w64') provenance = 'Lossless • Sony WAV64';
  else if (ext === '.aiff' || ext === '.aif') provenance = 'Lossless • AIFF';
  else if (ext === '.dsf' || ext === '.dff') provenance = 'Audiophile • DSD';
  else if (ext === '.ape') provenance = 'Lossless • Monkey Audio';
  else if (ext === '.wv') provenance = 'Lossless • WavPack';

  const embeddedTitle = id3.title || flac.title || '';
  const embeddedArtist = id3.artist || flac.artist || '';
  const embeddedAlbum = id3.album || flac.album || '';
  const embeddedGenre = id3.genre || flac.genre || '';
  const embeddedBpm = Number(id3.bpm || flac.bpm) || 0;
  const embeddedKey = id3.key || flac.key || '';
  const embeddedYear = id3.year || flac.year || '';

  const createdDate =
    stat.birthtime && Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;

  const rawLyrics = id3.lyrics || flac.lyrics || '';
  const hasLyrics = Boolean(rawLyrics && rawLyrics.trim() && !/^Restored by VANTA Quality Doctor$/i.test(rawLyrics.trim()));
  const replayGainTrackGainDb = id3.replayGainTrackGainDb ?? flac.replayGainTrackGainDb ?? null;
  const replayGainTrackPeak = id3.replayGainTrackPeak ?? flac.replayGainTrackPeak ?? null;
  const replayGainAlbumGainDb = id3.replayGainAlbumGainDb ?? flac.replayGainAlbumGainDb ?? null;
  const replayGainAlbumPeak = id3.replayGainAlbumPeak ?? flac.replayGainAlbumPeak ?? null;
  const record = {
    id: id3.isrc || audioHash || `local-${index}`,
    filePath: fullPath,
    fileName,
    ext: ext.slice(1).toUpperCase(),
    isVideo,
    sizeBytes: stat.size,
    title: embeddedTitle || baseName.replace(/_/g, ' '),
    artist: embeddedArtist || 'Local Studio Artist',
    album: embeddedAlbum,
    genre: embeddedGenre,
    bpm: embeddedBpm || fallbackDna.bpm,
    key: embeddedKey || fallbackDna.key,
    year: embeddedYear,
    energy: fallbackDna.energy,
    mood: fallbackDna.mood,
    durationSec: Number(flac.durationSec) || 0,
    sampleRate: Number(flac.sampleRate) || 0,
    bitDepth: Number(flac.bitDepth) || 0,
    channels: Number(flac.channels) || 0,
    bitrateKbps: 0,
    lyrics: statCache ? '' : rawLyrics,
    hasLyrics,
    replayGainTrackGainDb,
    replayGainTrackPeak,
    replayGainAlbumGainDb,
    replayGainAlbumPeak,
    provenance,
    hasId3: Boolean(id3.hasId3 || flac.hasFlac),
    hasCover: Boolean(id3.hasCover || hasSiblingCover || coverDataUrl),
    coverDataUrl,
    audioHash,
    createdAt: createdDate.toISOString(),
    modifiedAt: stat.mtime.toISOString()
  };

  if (statCache && normKey) {
    statCache[normKey] = {
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      track: record
    };
    if (options && typeof options === 'object') {
      options.cacheDirty = true;
    }
  }

  return record;
}

/**
 * Reads embedded ID3 cover art or sibling cover image binary on demand for `vanta-cover://`.
 * @param {string} filePath - Media file path.
 * @returns {{ buffer: Buffer, mime: string }|null}
 */
function loadTrackCoverBinary(filePath) {
  const cleanPath = String(filePath || '').trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) return null;
  const ext = path.extname(cleanPath).toLowerCase();
  if (ext === '.mp3') {
    const id3 = readId3v2FromFile(cleanPath);
    if (Buffer.isBuffer(id3.coverBuffer) && id3.coverBuffer.length > 0) {
      return { buffer: id3.coverBuffer, mime: id3.coverMime || 'image/jpeg' };
    }
  }
  const dir = path.dirname(cleanPath);
  const base = path.basename(cleanPath, ext);
  for (const imgExt of ['.jpeg', '.jpg', '.png', '.webp']) {
    const candidate = path.join(dir, `${base}${imgExt}`);
    try {
      if (fs.existsSync(candidate)) {
        const st = fs.statSync(candidate);
        if (st.isFile() && st.size > 0 && st.size <= 4 * 1024 * 1024) {
          const mime = imgExt === '.png' ? 'image/png' : imgExt === '.webp' ? 'image/webp' : 'image/jpeg';
          return { buffer: fs.readFileSync(candidate), mime };
        }
      }
    } catch {
      // Ignore unreadable sibling cover
    }
  }
  return null;
}

/**
 * Reads embedded track lyrics on demand when user selects a song.
 * @param {string} filePath - Media file path.
 * @returns {string} Embedded lyrics text or empty string.
 */
function loadTrackLyricsText(filePath) {
  const cleanPath = String(filePath || '').trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) return '';
  const ext = path.extname(cleanPath).toLowerCase();
  if (ext === '.mp3') {
    return readId3v2FromFile(cleanPath).lyrics || '';
  }
  if (ext === '.flac') {
    return readFlacMetadataFromFile(cleanPath).lyrics || '';
  }
  return '';
}

/**
 * Synchronously scans directories with strict depth and file count bounds (used by unit tests).
 * @param {string[]} dirPaths - Array of directory paths.
 * @param {object} [options] - Scan bounds.
 * @returns {object[]} Array of catalog track objects.
 */
function scanMediaDirectories(dirPaths, options = {}) {
  const roots = Array.isArray(dirPaths) ? dirPaths : [dirPaths];
  const maxDepth = options.maxDepth ?? 4;
  const maxFiles = options.maxFiles ?? 25000;
  const tracks = [];
  const visitedFiles = new Set();

  function walk(currentDir, depth) {
    if (depth > maxDepth || tracks.length >= maxFiles) return;
    if (!currentDir || !fs.existsSync(currentDir)) return;

    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (tracks.length >= maxFiles) break;
      const lowerName = entry.name.toLowerCase();
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(lowerName)) continue;

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (visitedFiles.has(fullPath)) continue;
        visitedFiles.add(fullPath);
        const record = inspectMediaFile(fullPath, tracks.length + 1, options);
        if (record) tracks.push(record);
      }
    }
  }

  for (const r of roots) {
    walk(r, 0);
  }

  return tracks;
}

/**
 * Non-blocking asynchronous directory scanner that yields to the Electron Main Process event loop
 * every 12 files so the UI window never freezes, even on large directories.
 * @param {string[]} dirPaths - Array of directory paths to scan.
 * @param {object} [options] - Scan configuration.
 * @param {number} [options.maxDepth=4] - Maximum folder recursion depth.
 * @param {number} [options.maxFiles=1500] - Maximum files to index in a single pass.
 * @param {Function} [options.onProgress] - Callback ({ scannedCount, currentFile }).
 * @returns {Promise<object[]>} Resolved array of catalog track objects.
 */
async function scanMediaDirectoriesAsync(dirPaths, options = {}) {
  const startMs = Date.now();
  const roots = Array.isArray(dirPaths) ? dirPaths : [dirPaths];
  const maxDepth = options.maxDepth ?? 4;
  const maxFiles = options.maxFiles ?? 25000;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  logger.info('FolderScanner', 'Starting non-blocking async directory scan', {
    roots,
    maxDepth,
    maxFiles
  });

  const tracks = [];
  const visitedFiles = new Set();
  const dirQueue = roots.map((r) => ({ dir: r, depth: 0 }));
  let processedOps = 0;

  while (dirQueue.length > 0 && tracks.length < maxFiles) {
    const { dir, depth } = dirQueue.shift();
    if (!dir || depth > maxDepth) continue;

    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn('FolderScanner', `Skipped inaccessible directory: ${dir}`, { error: err.message });
      continue;
    }

    for (const entry of entries) {
      if (tracks.length >= maxFiles) break;
      const lowerName = entry.name.toLowerCase();
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(lowerName)) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) {
          dirQueue.push({ dir: fullPath, depth: depth + 1 });
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) continue;
        if (visitedFiles.has(fullPath)) continue;
        visitedFiles.add(fullPath);

        const record = inspectMediaFile(fullPath, tracks.length + 1, options);
        if (record) {
          tracks.push(record);
          onProgress({
            scannedCount: tracks.length,
            currentFile: entry.name
          });
        }

        processedOps++;
        if (processedOps % 12 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    }
  }

  const elapsedMs = Date.now() - startMs;
  logger.info('FolderScanner', `Completed async directory scan in ${elapsedMs}ms`, {
    trackCount: tracks.length,
    elapsedMs
  });

  return tracks;
}

const EXPLORER_HIDDEN_DIRS = new Set([
  '$recycle.bin',
  '$windows.~bt',
  '$windows.~ws',
  'system volume information',
  'recovery',
  'msocache',
  'perflogs',
  'boot',
  'config.msi',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  'documents and settings',
  'node_modules',
  '.git',
  '.vscode'
]);

/**
 * Enumerates quick user media folders and accessible Windows logical drives cleanly.
 * @returns {Array<{id: string, label: string, path: string, kind: 'special'|'drive'}>}
 */
function getComputerRoots() {
  const roots = [];
  const home = os.homedir();
  const specialCandidates = [
    { id: 'quick-music', label: 'Music', dir: path.join(home, 'Music') },
    { id: 'quick-downloads', label: 'Downloads', dir: path.join(home, 'Downloads') },
    { id: 'quick-desktop', label: 'Desktop', dir: path.join(home, 'Desktop') }
  ];

  for (const item of specialCandidates) {
    try {
      if (item.dir && fs.existsSync(item.dir) && fs.statSync(item.dir).isDirectory()) {
        roots.push({
          id: item.id,
          label: item.label,
          path: item.dir,
          kind: 'special'
        });
      }
    } catch {
      // Skip inaccessible user profile directory
    }
  }

  for (let code = 67; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const driveRoot = `${letter}:\\`;
    try {
      if (fs.statSync(driveRoot).isDirectory()) {
        roots.push({
          id: `drive-${letter}`,
          label: `Local Disk (${letter}:)`,
          path: driveRoot,
          kind: 'drive'
        });
      }
    } catch {
      // Drive letter not mounted or inaccessible
    }
  }

  return roots;
}

/**
 * Lists a single directory level (lazy-loaded) with folders first and supported media files second.
 * @param {string} dirPath - Directory path to inspect.
 * @param {string[]} [userHiddenDirs=[]] - User-hidden full folder paths to exclude in O(1).
 * @returns {{ path: string, entries: Array<object>, error?: string }}
 */
function listDirectoryEntries(dirPath, userHiddenDirs = []) {
  const normalized = validateSafeDirectoryPath(dirPath);
  if (!normalized) return { path: '', entries: [], error: 'Invalid or unsafe directory path' };
  const userHiddenSet = new Set(
    (Array.isArray(userHiddenDirs) ? userHiddenDirs : [])
      .map((p) => path.normalize(String(p || '')).toLowerCase())
      .filter(Boolean)
  );

  let rawEntries = [];
  try {
    rawEntries = fs.readdirSync(normalized, { withFileTypes: true });
  } catch (err) {
    return { path: normalized, entries: [], error: err.message };
  }

  const folders = [];
  const files = [];

  for (const entry of rawEntries) {
    const name = entry.name;
    const lowerName = name.toLowerCase();
    if (!name || name.startsWith('.') || EXPLORER_HIDDEN_DIRS.has(lowerName)) continue;

    const fullPath = path.join(normalized, name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();

    // Resolve symlinks/junctions safely without throwing on broken links
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(fullPath);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }

    if (isDir) {
      if (userHiddenSet.has(fullPath.toLowerCase())) continue;
      folders.push({
        name,
        path: fullPath,
        type: 'folder',
        hasChildren: true
      });
    } else if (isFile) {
      const ext = path.extname(name).toLowerCase();
      if (!AUDIO_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) continue;
      files.push({
        name,
        path: fullPath,
        type: 'file',
        ext: ext.slice(1).toUpperCase(),
        isVideo: VIDEO_EXTENSIONS.has(ext)
      });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  folders.sort(byName);
  files.sort(byName);

  const combined = [...folders, ...files].slice(0, 2000);
  return { path: normalized, entries: combined };
}

/**
 * Indexes explicit standalone audio/video file paths not already present in existingTracks.
 * @param {string[]} filePaths - Array of host file paths.
 * @param {object[]} [existingTracks=[]] - Previously indexed folder tracks for deduplication.
 * @returns {object[]} Newly indexed standalone track records.
 */
function scanExplicitMediaFiles(filePaths = [], existingTracks = [], options = {}) {
  const seen = new Set(
    (Array.isArray(existingTracks) ? existingTracks : [])
      .map((t) => path.normalize(String(t?.filePath || '')).toLowerCase())
      .filter(Boolean)
  );
  const tracks = [];
  let idx = existingTracks.length + 1;

  for (const rawPath of Array.isArray(filePaths) ? filePaths : []) {
    if (!rawPath) continue;
    const normalized = path.normalize(String(rawPath));
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;

    try {
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) continue;
    } catch {
      continue;
    }

    const record = inspectMediaFile(normalized, idx++, options);
    if (record) {
      seen.add(key);
      tracks.push(record);
    }
  }

  return tracks;
}

/**
 * Merges folder-scanned tracks and explicit file tracks without path duplicates.
 * @param {object[]} [folderTracks=[]] - Tracks discovered in watched folders.
 * @param {object[]} [explicitTracks=[]] - Standalone watched files.
 * @returns {object[]} Deduplicated merged track list.
 */
function mergeCatalogTracks(folderTracks = [], explicitTracks = []) {
  const seen = new Set();
  const merged = [];
  for (const track of [...(folderTracks || []), ...(explicitTracks || [])]) {
    if (!track?.filePath) continue;
    const key = path.normalize(String(track.filePath)).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(track);
  }
  return merged;
}

/**
 * Runs the VANTA Catalog Quality & Metadata Doctor to identify duplicate files,
 * missing ID3v2 cover artwork, and missing BPM/Key/Title metadata.
 * @param {object[]} tracks - Array of scanned catalog track objects.
 * @returns {{ issues: object[], healthScore: number }}
 */
function runQualityDoctor(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const issues = [];
  const seenHashes = new Map();

  for (const track of list) {
    if (track.audioHash) {
      if (seenHashes.has(track.audioHash)) {
        const primary = seenHashes.get(track.audioHash);
        const duplicateTrack = track.sizeBytes < primary.sizeBytes ? track : primary;
        issues.push({
          type: 'DUPLICATE_AUDIO',
          severity: 'warning',
          trackId: duplicateTrack.id,
          filePath: duplicateTrack.filePath,
          title: duplicateTrack.title,
          description: `Duplicate audio payload of "${primary.title}" (${Math.round(duplicateTrack.sizeBytes / 1024)} KB)`,
          actionLabel: 'Quarantine Duplicate'
        });
      } else {
        seenHashes.set(track.audioHash, track);
      }
    }

    if (track.ext === 'MP3' && !track.hasCover) {
      issues.push({
        type: 'MISSING_COVER',
        severity: 'warning',
        trackId: track.id,
        filePath: track.filePath,
        title: track.title,
        description: `Missing embedded ID3v2 APIC cover artwork frame in ${track.fileName}`,
        actionLabel: 'Embed Cover Art'
      });
    }

    if (track.ext === 'MP3' && !track.hasId3) {
      issues.push({
        type: 'MISSING_METADATA',
        severity: 'info',
        trackId: track.id,
        filePath: track.filePath,
        title: track.title,
        description: `Missing ID3v2 header (Title, Artist, TBPM, TKEY) in ${track.fileName}`,
        actionLabel: 'Write ID3v2 Tags'
      });
    }
  }

  const penalty = Math.min(60, issues.length * 8);
  const healthScore = list.length === 0 ? 100 : Math.max(40, 100 - penalty);

  return {
    issues,
    healthScore
  };
}

/**
 * Automatically repairs detected Quality Doctor issues.
 * @param {object[]} issues - Array of issue objects returned by runQualityDoctor.
 * @param {string} [vaultRoot='C:\\Vanta\\VantaVault'] - Root vault directory.
 * @returns {{ repairedCount: number, details: string[] }}
 */
function repairQualityIssues(issues, vaultRoot = 'C:\\Vanta\\VantaVault') {
  const list = Array.isArray(issues) ? issues : [];
  let repairedCount = 0;
  const details = [];

  const quarantineDir = path.join(vaultRoot, 'Exports', 'Quarantine_Duplicates');
  fs.mkdirSync(quarantineDir, { recursive: true });

  for (const issue of list) {
    if (!issue.filePath || !fs.existsSync(issue.filePath)) continue;

    try {
      if (issue.type === 'DUPLICATE_AUDIO') {
        const dest = path.join(quarantineDir, path.basename(issue.filePath));
        try {
          fs.renameSync(issue.filePath, dest);
        } catch (moveErr) {
          if (moveErr.code === 'EXDEV') {
            fs.copyFileSync(issue.filePath, dest);
            fs.unlinkSync(issue.filePath);
          } else {
            throw moveErr;
          }
        }
        repairedCount++;
        details.push(`Moved duplicate ${path.basename(issue.filePath)} to Quarantine_Duplicates`);
      } else if (issue.type === 'MISSING_COVER' || issue.type === 'MISSING_METADATA') {
        const rawMp3 = fs.readFileSync(issue.filePath);
        const existing = readId3v2FromFile(issue.filePath);
        const dna = inferFallbackDna(issue.title || path.basename(issue.filePath));

        const baseDir = path.dirname(issue.filePath);
        const stem = path.basename(issue.filePath, path.extname(issue.filePath));
        const siblingJpeg = path.join(baseDir, `${stem}.jpeg`);
        let coverBuffer = existing.coverBuffer;
        if (!coverBuffer && fs.existsSync(siblingJpeg)) {
          coverBuffer = fs.readFileSync(siblingJpeg);
        }
        if (!coverBuffer) {
          coverBuffer = DEFAULT_VANTA_JPEG;
        }

        const repairedMp3 = writeId3v2Tags(rawMp3, {
          title: existing.title || issue.title || stem,
          artist: existing.artist || 'VANTA Studio Restored',
          album: existing.album || 'VANTA Media Vault',
          genre: existing.genre || dna.mood,
          bpm: existing.bpm || dna.bpm,
          key: existing.key || dna.key,
          isrc: existing.isrc || stem,
          lyrics: existing.lyrics || 'Restored by VANTA Quality Doctor',
          provenance: existing.provenance || 'Repaired • VANTA Doctor',
          coverBuffer
        });

        fs.writeFileSync(issue.filePath, repairedMp3);
        repairedCount++;
        details.push(`Repaired ID3v2 & APIC cover frame in ${path.basename(issue.filePath)}`);
      }
    } catch (err) {
      logger.error('QualityDoctor', `Failed repairing ${issue.filePath}`, { error: err.message });
      details.push(`Skipped ${path.basename(issue.filePath)}: ${err.message}`);
    }
  }

  logger.info('QualityDoctor', `Completed catalog repair (${repairedCount} items fixed)`);
  return { repairedCount, details };
}

/**
 * Exports a Portable Music Wallet (.vanta.json manifest).
 * @param {object} walletPayload - Catalog, presets, and analytics state.
 * @param {string} [exportDir='C:\\Vanta\\VantaVault\\Exports'] - Export folder path.
 * @returns {{ walletPath: string, trackCount: number, exportedAt: string }}
 */
function exportPortableWallet(walletPayload = {}, exportDir = 'C:\\Vanta\\VantaVault\\Exports') {
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const walletPath = path.join(exportDir, `VantaWallet_${stamp}.vanta.json`);

  const exportedAt = new Date().toISOString();
  const tracks = Array.isArray(walletPayload.tracks) ? walletPayload.tracks : [];
  const doc = {
    schema: 'VANTA_PORTABLE_MUSIC_WALLET_V1',
    exportedAt,
    vaultRoot: 'C:\\Vanta\\VantaVault',
    trackCount: tracks.length,
    eqPresets: walletPayload.eqPresets || {
      activePreset: 'Vanta Mastering',
      bands: [6, 4, 0, 3, 5],
      lufsTarget: -14.0,
      crossfadeSeconds: 6.0
    },
    timeCapsule: walletPayload.timeCapsule || {
      eraTitle: '2026 Late-Night Obsidian Synth Era',
      averageBpm: 124,
      dominantKey: 'A min'
    },
    tracks: tracks.map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      bpm: t.bpm,
      key: t.key,
      energy: t.energy,
      mood: t.mood,
      provenance: t.provenance,
      fileName: t.fileName
    }))
  };

  fs.writeFileSync(walletPath, JSON.stringify(doc, null, 2), 'utf8');
  logger.info('WalletExporter', `Exported Portable Music Wallet to ${walletPath}`, {
    trackCount: tracks.length
  });
  return {
    walletPath,
    trackCount: tracks.length,
    exportedAt
  };
}

const ALLOWED_FLOW_NODE_TYPES = new Set([
  'source:all',
  'source:smart_playlist',
  'source:folder',
  'source:album',
  'source:artist',
  'source:vibe_radio',
  'source:favorites',
  'source:lossless',
  'source:current_queue',
  'source:recently_added',
  'filter:bpm',
  'filter:harmonic',
  'filter:energy',
  'filter:genre',
  'filter:tags_groups',
  'filter:dedup_track',
  'filter:dedup_artist',
  'filter:take',
  'filter:year',
  'filter:exclude_played',
  'filter:format_tier',
  'combiner:concat',
  'combiner:zip',
  'combiner:union',
  'combiner:intersect',
  'combiner:subtract',
  'sorter:field',
  'sorter:harmonic_journey',
  'sorter:artist_spaced_shuffle',
  'sorter:reverse',
  'sorter:format_priority',
  'conditional:if_min_count',
  'conditional:if_empty',
  'conditional:time_of_day',
  'output:playlist'
]);

const MAX_FLOW_NODES = 120;
const MAX_FLOW_EDGES = 400;

/**
 * Sanitizes an untrusted Flow node parameter map to bounded JSON primitives.
 * @param {object} rawParams - Raw parameter dictionary.
 * @returns {object} Safe parameter map.
 */
function sanitizeFlowParams(rawParams) {
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) return {};
  const clean = {};
  let count = 0;
  for (const [k, v] of Object.entries(rawParams)) {
    if (count >= 32) break;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const key = String(k || '').trim().slice(0, 48);
    if (!key) continue;
    if (typeof v === 'string') {
      clean[key] = v.slice(0, 512);
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      clean[key] = v;
    } else if (typeof v === 'boolean') {
      clean[key] = v;
    }
    count++;
  }
  return clean;
}

/**
 * Validates and canonicalizes a Smarter Playlists DAG graph object (`{ nodes, edges }`).
 * Drops unknown node types, out-of-bounds coordinates, dangling edges, and self-loops.
 * @param {object} rawGraph - Untrusted graph payload from IPC or disk store.
 * @returns {{ nodes: object, edges: Array }} Sanitized DAG structure.
 */
function sanitizeFlowGraph(rawGraph) {
  const nodes = {};
  const rawNodes = rawGraph?.nodes && typeof rawGraph.nodes === 'object' && !Array.isArray(rawGraph.nodes)
    ? rawGraph.nodes
    : {};

  let nodeCount = 0;
  for (const [rawId, node] of Object.entries(rawNodes)) {
    if (nodeCount >= MAX_FLOW_NODES) break;
    const id = String(rawId || node?.id || '').trim().slice(0, 64);
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
    const type = String(node?.type || '').trim();
    if (!ALLOWED_FLOW_NODE_TYPES.has(type)) continue;
    const xNum = Number(node?.x);
    const yNum = Number(node?.y);
    nodes[id] = {
      id,
      type,
      x: Number.isFinite(xNum) ? Math.max(0, Math.min(10000, Math.round(xNum))) : 28,
      y: Number.isFinite(yNum) ? Math.max(0, Math.min(10000, Math.round(yNum))) : 48,
      params: sanitizeFlowParams(node?.params)
    };
    nodeCount++;
  }

  const edges = [];
  const seenEdges = new Set();
  const rawEdges = Array.isArray(rawGraph?.edges) ? rawGraph.edges : [];
  for (const edge of rawEdges) {
    if (edges.length >= MAX_FLOW_EDGES) break;
    if (!Array.isArray(edge) || edge.length < 2) continue;
    const src = String(edge[0] || '').trim();
    const dst = String(edge[1] || '').trim();
    if (!Object.hasOwn(nodes, src) || !Object.hasOwn(nodes, dst) || src === dst) continue;
    const hasSlot = edge.length >= 3 && (edge[2] === 0 || edge[2] === 1);
    const slotKey = hasSlot ? `:${edge[2]}` : '';
    const edgeKey = `${src}->${dst}${slotKey}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    edges.push(hasSlot ? [src, dst, edge[2]] : [src, dst]);
  }

  return { nodes, edges };
}

/**
 * Generates an extended UTF-8 `.m3u8` playlist file string from a list of tracks,
 * stripping control/newline characters to prevent playlist line injection.
 * @param {object[]} [tracks=[]] - Authorized media track objects.
 * @param {object} [options={}] - Optional `{ playlistName }`.
 * @returns {{ content: string, exportedCount: number }} Extended M3U8 text and exported track count.
 */
function buildM3u8Content(tracks = [], options = {}) {
  const sanitizeLine = (val) => String(val || '').replace(/[\r\n\0]+/g, ' ').trim();
  const lines = ['#EXTM3U'];
  const cleanPlaylistName = sanitizeLine(options?.playlistName);
  if (cleanPlaylistName) {
    lines.push(`#PLAYLIST:${cleanPlaylistName}`);
  }

  let exportedCount = 0;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const rawPath = String(track?.filePath || '').trim();
    if (!rawPath || /[\r\n\0]/.test(rawPath)) continue;
    const durationSec = Number(track?.durationSec);
    const durInt = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : -1;
    const artist = sanitizeLine(track?.artist) || 'Unknown Artist';
    const title = sanitizeLine(track?.title || track?.fileName) || 'Untitled';
    lines.push(`#EXTINF:${durInt},${artist} - ${title}`);
    lines.push(rawPath);
    exportedCount++;
  }

  return {
    content: `${lines.join('\n')}\n`,
    exportedCount
  };
}

/**
 * Loads the persistent VANTA library store (ratings, custom tags, groups, smart playlists, watched folders).
 * @param {string} [storePath='C:\\Vanta\\VantaVault\\vanta-library.json'] - Path to JSON store.
 * @returns {{ watchedFolders: string[], annotations: object, smartPlaylists: object[] }}
 */
function loadLibraryStore(storePath = 'C:\\Vanta\\VantaVault\\vanta-library.json') {
  const defaults = {
    watchedFolders: [],
    watchedFiles: [],
    hiddenPaths: [],
    hiddenExplorerDirs: [],
    annotations: {},
    loudnessCache: {},
    scanCache: {},
    stageFxVideoPath: '',
    smartPlaylists: []
  };
  try {
    if (!fs.existsSync(storePath)) return defaults;
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      watchedFolders: Array.isArray(parsed.watchedFolders) ? parsed.watchedFolders : defaults.watchedFolders,
      watchedFiles: Array.isArray(parsed.watchedFiles) ? parsed.watchedFiles : defaults.watchedFiles,
      hiddenPaths: Array.isArray(parsed.hiddenPaths) ? parsed.hiddenPaths : defaults.hiddenPaths,
      hiddenExplorerDirs: Array.isArray(parsed.hiddenExplorerDirs) ? parsed.hiddenExplorerDirs : defaults.hiddenExplorerDirs,
      annotations: parsed.annotations && typeof parsed.annotations === 'object' ? parsed.annotations : {},
      loudnessCache: parsed.loudnessCache && typeof parsed.loudnessCache === 'object' ? parsed.loudnessCache : {},
      scanCache: parsed.scanCache && typeof parsed.scanCache === 'object' ? parsed.scanCache : {},
      stageFxVideoPath: typeof parsed.stageFxVideoPath === 'string' ? parsed.stageFxVideoPath : '',
      smartPlaylists: (() => {
        const list = Array.isArray(parsed.smartPlaylists) ? parsed.smartPlaylists : defaults.smartPlaylists;
        const seenNames = new Set();
        const unique = [];
        for (const sp of list) {
          const cleanName = String(sp?.name || '').trim().replace(/\s+/g, ' ');
          if (!cleanName) continue;
          const key = cleanName.toLowerCase();
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          const kind = sp?.kind === 'flow' ? 'flow' : 'rule';
          const baseEntry = {
            ...sp,
            kind,
            name: cleanName,
            description: String(sp.description || '').trim(),
            visual: sp.visual && typeof sp.visual === 'object'
              ? sp.visual
              : { mode: 'auto', presetKey: 'synth', imagePath: '' }
          };
          if (kind === 'flow') {
            baseEntry.graph = sanitizeFlowGraph(sp.graph);
            delete baseEntry.filters;
          }
          unique.push(baseEntry);
        }
        return unique;
      })()
    };
  } catch (err) {
    logger.warn('LibraryStore', `Failed loading library store ${storePath}`, { error: err.message });
    return defaults;
  }
}

/**
 * Excludes cleared track paths from catalog listings without touching files on disk.
 * @param {object[]} tracks - Scanned tracks.
 * @param {string[]} hiddenPaths - Persisted normalized paths hidden from playlist/queue.
 * @returns {object[]} Visible catalog tracks.
 */
function filterHiddenCatalogTracks(tracks = [], hiddenPaths = []) {
  const hiddenSet = new Set(
    (Array.isArray(hiddenPaths) ? hiddenPaths : []).map((p) => path.normalize(String(p || '')).toLowerCase())
  );
  if (!hiddenSet.size) return Array.isArray(tracks) ? tracks : [];
  return (Array.isArray(tracks) ? tracks : []).filter((t) => {
    const key = path.normalize(String(t?.filePath || '')).toLowerCase();
    return !hiddenSet.has(key);
  });
}

/**
 * Persists the VANTA library store to disk atomically.
 * @param {object} store - Store object { watchedFolders, hiddenPaths, annotations, smartPlaylists }.
 * @param {string} [storePath='C:\\Vanta\\VantaVault\\vanta-library.json'] - Path to JSON store.
 */
function saveLibraryStore(store, storePath = 'C:\\Vanta\\VantaVault\\vanta-library.json') {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const cacheEntries = store?.scanCache ? Object.keys(store.scanCache).length : 0;
    const serialized = cacheEntries > 120 ? JSON.stringify(store) : JSON.stringify(store, null, 2);
    fs.writeFileSync(storePath, serialized, 'utf8');
  } catch (err) {
    logger.error('LibraryStore', `Failed saving library store ${storePath}`, { error: err.message });
  }
}

/**
 * Resolves a persisted track annotation or cache entry using stable `audioHash` first
 * (surviving file moves/renames), with transparent fallback to `filePath` and `id`.
 * @param {object} map - Annotations or cache object from libraryStore.
 * @param {object} track - Track metadata object.
 * @returns {{ primaryKey: string, entry: object }} Resolved storage key and merged entry.
 */
function resolveHashStoreEntry(map = {}, track = {}) {
  const hashKey = track?.audioHash ? `hash:${track.audioHash}` : '';
  const pathKey = track?.filePath || '';
  const idKey = track?.id || '';
  const primaryKey = hashKey || pathKey || idKey;

  const byId = idKey && map[idKey] ? map[idKey] : {};
  const byPath = pathKey && map[pathKey] ? map[pathKey] : {};
  const byHash = hashKey && map[hashKey] ? map[hashKey] : {};

  return {
    primaryKey,
    entry: { ...byId, ...byPath, ...byHash }
  };
}

/**
 * Persists a partial annotation update primarily under `hash:<audioHash>` while migrating any
 * legacy path-keyed entry cleanly so ratings/tags/genres follow the file across renames & moves.
 * @param {object} annotationsMap - Mutable libraryStore.annotations object.
 * @param {object} payload - Track locator ({ audioHash, filePath, id, patch }).
 * @returns {{ key: string, annotation: object }|null} Updated key and merged annotation.
 */
function upsertHashAnnotation(annotationsMap, payload = {}) {
  if (!annotationsMap || typeof annotationsMap !== 'object') return null;
  const hashKey = payload.audioHash ? `hash:${payload.audioHash}` : '';
  const pathKey = payload.filePath || '';
  const idKey = payload.id || '';
  const key = hashKey || pathKey || idKey;
  if (!key) return null;

  const { entry } = resolveHashStoreEntry(annotationsMap, payload);
  annotationsMap[key] = {
    ...entry,
    ...(payload.patch || {})
  };
  if (hashKey && pathKey && annotationsMap[pathKey]) {
    delete annotationsMap[pathKey];
  }
  return { key, annotation: annotationsMap[key] };
}

module.exports = {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  computeAudioPayloadFingerprint,
  resolveHashStoreEntry,
  upsertHashAnnotation,
  inferFallbackDna,
  getComputerRoots,
  listDirectoryEntries,
  scanExplicitMediaFiles,
  mergeCatalogTracks,
  scanMediaDirectories,
  scanMediaDirectoriesAsync,
  loadTrackCoverBinary,
  loadTrackLyricsText,
  runQualityDoctor,
  repairQualityIssues,
  exportPortableWallet,
  filterHiddenCatalogTracks,
  sanitizeFlowGraph,
  buildM3u8Content,
  loadLibraryStore,
  saveLibraryStore
};
