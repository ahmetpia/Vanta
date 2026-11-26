'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { writeId3v2Tags } = require('./id3Service.cjs');

const execFileAsync = promisify(execFile);

const YOUTUBE_URL_REGEX = /(?:https?:\/\/)?(?:www\.|music\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/gi;

let ffmpegPath = '';
try {
  ffmpegPath = require('ffmpeg-static') || '';
  if (ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
    const unpacked = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
    if (fs.existsSync(unpacked)) {
      ffmpegPath = unpacked;
    }
  }
} catch {
  ffmpegPath = '';
}

/**
 * Sanitizes a track title for safe filesystem storage on Windows and macOS.
 * @param {string} rawName - Raw track title.
 * @returns {string} Safe filename stem.
 */
function sanitizeFilename(rawName) {
  const cleaned = String(rawName || 'Vanta_Track')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 96) || 'Vanta_Track';
}

/**
 * Parses a text block containing single or multiple YouTube URLs or 11-character video IDs.
 * @param {string} rawText - User input text.
 * @returns {{ youtubeIds: string[], totalCount: number }} Deduplicated YouTube IDs.
 */
function parseYouTubeInputs(rawText) {
  const text = String(rawText || '');
  const youtubeSet = new Set();

  let match;
  YOUTUBE_URL_REGEX.lastIndex = 0;
  while ((match = YOUTUBE_URL_REGEX.exec(text)) !== null) {
    youtubeSet.add(match[1]);
  }

  // Also check standalone 11-character YouTube IDs separated by whitespace or commas
  for (const token of text.split(/[\s,;]+/)) {
    const trimmed = token.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
      youtubeSet.add(trimmed);
    }
  }

  const youtubeIds = Array.from(youtubeSet);
  return {
    youtubeIds,
    totalCount: youtubeIds.length
  };
}

/**
 * Extracts an 11-character YouTube video ID from a URL or raw ID string.
 * @param {string} urlOrId - YouTube watch URL, short URL, or 11-char ID.
 * @returns {string} 11-character YouTube video ID or empty string.
 */
function extractYouTubeId(urlOrId) {
  const str = String(urlOrId || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(str)) {
    return str;
  }
  const m = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/i.exec(str);
  return m ? m[1] : '';
}

/**
 * Resolves the path to the yt-dlp executable on Windows/macOS.
 * @returns {string} Executable command or absolute path.
 */
function resolveYtDlpBinary() {
  const candidates = [
    path.join('C:\\Vanta', 'bin', 'yt-dlp.exe'),
    'C:\\Program Files\\Python311\\Scripts\\yt-dlp.exe',
    'yt-dlp'
  ];
  for (const c of candidates) {
    if (c === 'yt-dlp' || fs.existsSync(c)) {
      return c;
    }
  }
  return 'yt-dlp';
}

/**
 * Fetches YouTube video metadata (title, author/channel, thumbnail URL) using YouTube's public oEmbed endpoint.
 * @param {string} urlOrId - YouTube video URL or 11-char video ID.
 * @param {Function} [fetchImpl=globalThis.fetch] - Injectable fetch implementation.
 * @returns {Promise<object>} Normalized YouTube track metadata.
 */
async function resolveYouTubeMetadata(urlOrId, fetchImpl = globalThis.fetch) {
  const videoId = extractYouTubeId(urlOrId);
  if (!videoId) {
    throw new Error(`Invalid YouTube URL or Video ID: ${urlOrId}`);
  }
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  try {
    const res = await fetchImpl(oembedUrl);
    if (res && res.ok) {
      const data = await res.json();
      return {
        id: videoId,
        title: data.title || `YouTube Track ${videoId}`,
        artist: data.author_name || 'YouTube Studio',
        coverUrl: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        watchUrl,
        provenance: 'YouTube Vault • 320kbps'
      };
    }
  } catch {
    // Fallback below
  }

  return {
    id: videoId,
    title: `YouTube Track ${videoId}`,
    artist: 'YouTube Creator',
    coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    watchUrl,
    provenance: 'YouTube Vault • 320kbps'
  };
}

/**
 * Downloads a YouTube track as high-bitrate MP3 (with ID3v2 Cover Art) or MP4 Video into C:\Vanta\VantaVault\YouTube.
 * @param {string} urlOrId - YouTube URL or 11-char video ID.
 * @param {object} [options] - Download configuration.
 * @param {string} [options.vaultDir='C:\\Vanta\\VantaVault\\YouTube'] - Target directory.
 * @param {string} [options.format='MP3+ID3'] - 'MP3+ID3' | 'MP4 Video' | 'ALL'.
 * @param {Function} [options.onProgress] - Progress callback.
 * @param {Function} [options.fetchImpl=globalThis.fetch] - Injectable fetch implementation.
 * @returns {Promise<object>} Download summary with saved file path and metadata.
 */
async function downloadYouTubeMedia(urlOrId, options = {}) {
  const vaultDir = options.vaultDir || path.join('C:\\Vanta\\VantaVault', 'YouTube');
  const format = options.format || 'MP3+ID3';
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  fs.mkdirSync(vaultDir, { recursive: true });
  onProgress({ stage: 'Resolving YouTube Metadata', percent: 15 });

  const meta = await resolveYouTubeMetadata(urlOrId, fetchImpl);
  const safeStem = `${sanitizeFilename(meta.title)}_${meta.id}`;
  const isVideoOnly = format === 'MP4 Video';
  const downloadBoth = format === 'ALL';
  const ytDlpBin = resolveYtDlpBinary();

  const saved = {};

  if (isVideoOnly || downloadBoth) {
    const mp4Path = path.join(vaultDir, `${safeStem}.mp4`);
    const vArgs = [
      '--no-playlist',
      '--no-warnings',
      '-o',
      mp4Path,
      '-f',
      'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format',
      'mp4'
    ];
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      vArgs.push('--ffmpeg-location', ffmpegPath);
    }
    vArgs.push(meta.watchUrl);
    onProgress({ stage: 'Downloading HD MP4 Video', percent: 45 });
    await execFileAsync(ytDlpBin, vArgs, { timeout: 180000 });
    saved.videoPath = mp4Path;
  }

  if (!isVideoOnly || downloadBoth) {
    const mp3Path = path.join(vaultDir, `${safeStem}.mp3`);
    const aArgs = [
      '--no-playlist',
      '--no-warnings',
      '-o',
      mp3Path,
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0'
    ];
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      aArgs.push('--ffmpeg-location', ffmpegPath);
    }
    aArgs.push(meta.watchUrl);

    onProgress({ stage: 'Extracting 320kbps MP3 Audio', percent: 70 });
    await execFileAsync(ytDlpBin, aArgs, { timeout: 180000 });

    if (fs.existsSync(mp3Path)) {
      onProgress({ stage: 'Embedding ID3v2 Cover & Metadata', percent: 90 });
      let coverBuffer = null;
      try {
        const thumbRes = await fetchImpl(meta.coverUrl);
        if (thumbRes && thumbRes.ok) {
          coverBuffer = Buffer.from(await thumbRes.arrayBuffer());
        }
      } catch {
        coverBuffer = null;
      }

      const rawMp3 = fs.readFileSync(mp3Path);
      const taggedMp3 = writeId3v2Tags(rawMp3, {
        title: meta.title,
        artist: meta.artist,
        album: 'YouTube Vault • VANTA OS',
        genre: 'YouTube Audio Stream',
        bpm: options.bpm || 124,
        key: options.key || 'Cm',
        isrc: meta.id,
        lyrics: `Source: ${meta.watchUrl}`,
        provenance: meta.provenance,
        coverBuffer
      });
      fs.writeFileSync(mp3Path, taggedMp3);
    }
    saved.audioPath = mp3Path;
  }

  onProgress({ stage: 'Saved in Vault', percent: 100 });
  return {
    ...meta,
    ...saved,
    savedAt: new Date().toISOString()
  };
}

module.exports = {
  sanitizeFilename,
  parseYouTubeInputs,
  extractYouTubeId,
  resolveYtDlpBinary,
  resolveYouTubeMetadata,
  downloadYouTubeMedia
};
