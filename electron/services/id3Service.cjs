'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateSafeFilePath } = require('./pathSecurityService.cjs');

const MP3_EXTENSIONS = new Set(['.mp3']);
const FLAC_EXTENSIONS = new Set(['.flac']);

/**
 * Parses a ReplayGain dB string (e.g. "-6.42 dB", "+1.20 dB") or number into a bounded float.
 * @param {string|number|null|undefined} raw - Raw tag value.
 * @returns {number|null} Gain in dB or null if absent/invalid.
 */
function parseReplayGainDbValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.max(-50, Math.min(30, Number(raw.toFixed(2)))) : null;
  }
  const m = /([+-]?\d+(?:\.\d+)?)/.exec(String(raw).trim());
  if (!m) return null;
  const val = Number(m[1]);
  return Number.isFinite(val) ? Math.max(-50, Math.min(30, Number(val.toFixed(2)))) : null;
}

/**
 * Parses a ReplayGain peak string (e.g. "0.987654") or number into a finite peak amplitude.
 * @param {string|number|null|undefined} raw - Raw tag value.
 * @returns {number|null} Linear sample/true peak or null if absent/invalid.
 */
function parseReplayGainPeakValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const val = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(val) && val > 0 && val <= 16 ? Number(val.toFixed(6)) : null;
}

/**
 * Formats a dB gain according to ReplayGain 2.0 conventions (e.g. "-6.42 dB").
 * @param {number} db - Gain in decibels.
 * @returns {string}
 */
function formatReplayGainDb(db) {
  const n = Number(db) || 0;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)} dB`;
}

/**
 * Formats a peak amplitude according to ReplayGain 2.0 conventions (6 decimals).
 * @param {number} peak - Linear peak amplitude.
 * @returns {string}
 */
function formatReplayGainPeak(peak) {
  const n = Math.max(0, Number(peak) || 0);
  return n.toFixed(6);
}

const ID3V1_GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal',
  'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop',
  'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
  'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative',
  'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
  'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta Rap',
  'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave',
  'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka',
  'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing',
  'Fast-Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock',
  'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus',
  'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata',
  'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba',
  'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo',
  'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore', 'Terror',
  'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal',
  'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa',
  'Thrash Metal', 'Anime', 'JPop', 'Synthpop'
];

/**
 * Resolves numeric ID3v1 genre references like "(18)" or "(18)Techno" into readable names.
 * @param {string} rawGenre - Raw TCON text.
 * @returns {string} Clean genre string.
 */
function normalizeId3Genre(rawGenre) {
  const s = String(rawGenre || '').trim();
  if (!s) return '';
  const match = /^\((\d+)\)(.*)$/.exec(s);
  if (match) {
    const trailing = match[2].trim();
    if (trailing) return trailing;
    const code = Number(match[1]);
    return ID3V1_GENRES[code] || s;
  }
  if (/^\d+$/.test(s)) {
    const code = Number(s);
    return ID3V1_GENRES[code] || s;
  }
  return s;
}

/**
 * Encodes a 28-bit integer into a 4-byte ID3v2 synchsafe integer buffer.
 * @param {number} size - Non-negative integer size.
 * @returns {Buffer} 4-byte synchsafe buffer.
 */
function encodeSynchsafeInt(size) {
  const safe = Math.max(0, Number(size) || 0);
  return Buffer.from([
    (safe >> 21) & 0x7f,
    (safe >> 14) & 0x7f,
    (safe >> 7) & 0x7f,
    safe & 0x7f
  ]);
}

/**
 * Decodes a 4-byte ID3v2 synchsafe integer buffer into a standard number.
 * @param {Buffer} buf - Buffer containing at least 4 bytes.
 * @param {number} [offset=0] - Starting byte offset.
 * @returns {number} Decoded integer value.
 */
function decodeSynchsafeInt(buf, offset = 0) {
  return (
    ((buf[offset] & 0x7f) << 21) |
    ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) |
    (buf[offset + 3] & 0x7f)
  );
}

/**
 * Strips an existing ID3v2 header from an MP3 Buffer if present.
 * @param {Buffer} mp3Buffer - Raw MP3 binary buffer.
 * @returns {Buffer} Audio payload buffer without the leading ID3v2 tag.
 */
function stripExistingId3v2(mp3Buffer) {
  if (!Buffer.isBuffer(mp3Buffer) || mp3Buffer.length < 10) {
    return mp3Buffer;
  }
  if (mp3Buffer.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = decodeSynchsafeInt(mp3Buffer, 6);
    const totalHeaderBytes = 10 + tagSize;
    if (totalHeaderBytes < mp3Buffer.length) {
      return mp3Buffer.subarray(totalHeaderBytes);
    }
  }
  return mp3Buffer;
}

/**
 * Builds an ID3v2.3/2.4 text frame using UTF-8 encoding (encoding byte 0x03).
 * @param {string} frameId - 4-character frame ID (e.g., 'TIT2', 'TPE1').
 * @param {string|number} text - Text content to store.
 * @returns {Buffer|null} Complete ID3 frame buffer or null if empty.
 */
function createTextFrame(frameId, text) {
  if (text === undefined || text === null || String(text).trim() === '') {
    return null;
  }
  const strBytes = Buffer.from(String(text).trim(), 'utf8');
  const payload = Buffer.concat([Buffer.from([0x03]), strBytes]);
  const header = Buffer.alloc(10);
  header.write(frameId, 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
}

/**
 * Builds an ID3v2 TXXX (User Defined Text Information) frame using UTF-8 encoding (0x03).
 * @param {string} description - TXXX field descriptor (e.g., 'REPLAYGAIN_TRACK_GAIN').
 * @param {string|number} value - Field value text.
 * @returns {Buffer|null} Complete TXXX frame buffer or null if empty.
 */
function createTxxxFrame(description, value) {
  const cleanDesc = String(description || '').trim();
  if (!cleanDesc || value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const enc = Buffer.from([0x03]);
  const descBytes = Buffer.concat([Buffer.from(cleanDesc, 'utf8'), Buffer.from([0x00])]);
  const valBytes = Buffer.from(String(value).trim(), 'utf8');
  const payload = Buffer.concat([enc, descBytes, valBytes]);

  const header = Buffer.alloc(10);
  header.write('TXXX', 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
}

/**
 * Builds an ID3v2 USLT (Unsynchronized Lyrics) or COMM (Comment) frame.
 * @param {'USLT'|'COMM'} frameId - Frame identifier.
 * @param {string} content - Lyrics or comment body.
 * @param {string} [descriptor='VANTA'] - Short content descriptor.
 * @returns {Buffer|null} Complete frame buffer or null if empty.
 */
function createLangTextFrame(frameId, content, descriptor = 'VANTA') {
  if (!content || String(content).trim() === '') {
    return null;
  }
  const encodingByte = Buffer.from([0x03]); // UTF-8
  const langBytes = Buffer.from('eng', 'ascii');
  const descBytes = Buffer.concat([Buffer.from(descriptor, 'utf8'), Buffer.from([0x00])]);
  const bodyBytes = Buffer.from(String(content).trim(), 'utf8');
  const payload = Buffer.concat([encodingByte, langBytes, descBytes, bodyBytes]);

  const header = Buffer.alloc(10);
  header.write(frameId, 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
}

/**
 * Builds an ID3v2 APIC (Attached Picture / Album Cover Art) frame.
 * @param {Buffer} imageBuffer - Raw JPEG or PNG image buffer.
 * @param {string} [mimeType='image/jpeg'] - Image MIME type.
 * @returns {Buffer|null} Complete APIC frame buffer or null if no image buffer.
 */
function createApicFrame(imageBuffer, mimeType = 'image/jpeg') {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return null;
  }
  const detectedMime =
    imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 ? 'image/png' : mimeType;

  const encodingByte = Buffer.from([0x00]); // ISO-8859-1 for MIME & description
  const mimeBytes = Buffer.concat([Buffer.from(detectedMime, 'ascii'), Buffer.from([0x00])]);
  const picTypeByte = Buffer.from([0x03]); // 0x03 = Cover (front)
  const descBytes = Buffer.from([0x00]); // Empty description, null-terminated
  const payload = Buffer.concat([encodingByte, mimeBytes, picTypeByte, descBytes, imageBuffer]);

  const header = Buffer.alloc(10);
  header.write('APIC', 0, 4, 'ascii');
  header.writeUInt32BE(payload.length, 4);
  header.writeUInt16BE(0, 8);
  return Buffer.concat([header, payload]);
}

/**
 * Embeds ID3v2 tags (Title, Artist, Album, Genre, BPM, Key, ISRC, Lyrics, Provenance, Cover Art)
 * directly into an MP3 binary buffer.
 * @param {Buffer} mp3Buffer - Original MP3 audio buffer.
 * @param {object} metadata - Metadata dictionary.
 * @param {string} [metadata.title] - Track title (TIT2).
 * @param {string} [metadata.artist] - Track artist/creator (TPE1).
 * @param {string} [metadata.album] - Track album/collection (TALB).
 * @param {string} [metadata.genre] - Track genre/style tags (TCON).
 * @param {number|string} [metadata.bpm] - Track tempo in BPM (TBPM).
 * @param {string} [metadata.key] - Musical key (TKEY).
 * @param {string} [metadata.isrc] - Track UUID or ISRC identifier (TSRC).
 * @param {string} [metadata.lyrics] - Unsynchronized lyrics or prompt (USLT).
 * @param {string} [metadata.provenance] - AI/Source provenance label (COMM).
 * @param {Buffer} [metadata.coverBuffer] - Raw JPEG/PNG cover artwork buffer (APIC).
 * @returns {Buffer} Tagged MP3 buffer containing the prepended ID3v2 header.
 */
function writeId3v2Tags(mp3Buffer, metadata = {}) {
  const cleanAudio = stripExistingId3v2(mp3Buffer);
  const rgTrackGain = metadata.replayGainTrackGainDb !== undefined && metadata.replayGainTrackGainDb !== null
    ? formatReplayGainDb(metadata.replayGainTrackGainDb)
    : metadata.REPLAYGAIN_TRACK_GAIN;
  const rgTrackPeak = metadata.replayGainTrackPeak !== undefined && metadata.replayGainTrackPeak !== null
    ? formatReplayGainPeak(metadata.replayGainTrackPeak)
    : metadata.REPLAYGAIN_TRACK_PEAK;
  const rgAlbumGain = metadata.replayGainAlbumGainDb !== undefined && metadata.replayGainAlbumGainDb !== null
    ? formatReplayGainDb(metadata.replayGainAlbumGainDb)
    : metadata.REPLAYGAIN_ALBUM_GAIN;
  const rgAlbumPeak = metadata.replayGainAlbumPeak !== undefined && metadata.replayGainAlbumPeak !== null
    ? formatReplayGainPeak(metadata.replayGainAlbumPeak)
    : metadata.REPLAYGAIN_ALBUM_PEAK;

  const frames = [
    createTextFrame('TIT2', metadata.title),
    createTextFrame('TPE1', metadata.artist),
    createTextFrame('TALB', metadata.album),
    createTextFrame('TCON', metadata.genre),
    createTextFrame('TBPM', metadata.bpm),
    createTextFrame('TKEY', metadata.key),
    createTextFrame('TYER', metadata.year),
    createTextFrame('TSRC', metadata.isrc),
    createTxxxFrame('REPLAYGAIN_TRACK_GAIN', rgTrackGain),
    createTxxxFrame('REPLAYGAIN_TRACK_PEAK', rgTrackPeak),
    createTxxxFrame('REPLAYGAIN_ALBUM_GAIN', rgAlbumGain),
    createTxxxFrame('REPLAYGAIN_ALBUM_PEAK', rgAlbumPeak),
    createLangTextFrame('USLT', metadata.lyrics, 'Lyrics'),
    createLangTextFrame('COMM', metadata.provenance, 'Provenance'),
    createApicFrame(metadata.coverBuffer)
  ].filter(Boolean);

  const framesPayload = Buffer.concat(frames);
  const id3Header = Buffer.alloc(10);
  id3Header.write('ID3', 0, 3, 'ascii');
  id3Header[3] = 0x03; // ID3v2.3
  id3Header[4] = 0x00; // Revision 0
  id3Header[5] = 0x00; // Flags
  encodeSynchsafeInt(framesPayload.length).copy(id3Header, 6);

  return Buffer.concat([id3Header, framesPayload, cleanAudio]);
}

/**
 * Decodes an ID3 text payload according to its leading encoding byte.
 * @param {Buffer} payload - Frame payload buffer.
 * @returns {string} Decoded text string.
 */
function decodeTextPayload(payload) {
  if (!payload || payload.length <= 1) return '';
  const enc = payload[0];
  const body = payload.subarray(1);
  let text = '';
  if (enc === 0x01 || enc === 0x02) {
    // UTF-16
    const start = body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff)) ? 2 : 0;
    text = body.subarray(start).toString('utf16le');
  } else if (enc === 0x03) {
    text = body.toString('utf8');
  } else {
    text = body.toString('latin1');
  }
  return text.replace(/\0/g, '').trim();
}

/**
 * Parses ID3v2.3 and ID3v2.4 metadata and embedded APIC cover art from an MP3 Buffer.
 * @param {Buffer} mp3Buffer - MP3 binary buffer.
 * @returns {object} Extracted metadata object.
 */
function readId3v2Tags(mp3Buffer) {
  const result = {
    hasId3: false,
    title: '',
    artist: '',
    album: '',
    genre: '',
    bpm: '',
    key: '',
    year: '',
    isrc: '',
    lyrics: '',
    provenance: '',
    replayGainTrackGainDb: null,
    replayGainTrackPeak: null,
    replayGainAlbumGainDb: null,
    replayGainAlbumPeak: null,
    hasCover: false,
    coverMime: '',
    coverDataUrl: '',
    coverBuffer: null
  };

  if (!Buffer.isBuffer(mp3Buffer) || mp3Buffer.length < 10 || mp3Buffer.toString('ascii', 0, 3) !== 'ID3') {
    return result;
  }

  result.hasId3 = true;
  const versionMajor = mp3Buffer[3];
  const tagSize = decodeSynchsafeInt(mp3Buffer, 6);
  const limit = Math.min(mp3Buffer.length, 10 + tagSize);

  let offset = 10;
  while (offset + 10 <= limit) {
    const frameId = mp3Buffer.toString('ascii', offset, offset + 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) {
      break;
    }

    const frameSize =
      versionMajor === 4
        ? decodeSynchsafeInt(mp3Buffer, offset + 4)
        : mp3Buffer.readUInt32BE(offset + 4);

    if (frameSize <= 0 || offset + 10 + frameSize > limit) {
      break;
    }

    const payload = mp3Buffer.subarray(offset + 10, offset + 10 + frameSize);

    switch (frameId) {
      case 'TIT2':
        result.title = decodeTextPayload(payload);
        break;
      case 'TPE1':
        result.artist = decodeTextPayload(payload);
        break;
      case 'TALB':
        result.album = decodeTextPayload(payload);
        break;
      case 'TCON':
        result.genre = normalizeId3Genre(decodeTextPayload(payload));
        break;
      case 'TBPM':
        result.bpm = decodeTextPayload(payload);
        break;
      case 'TKEY':
        result.key = decodeTextPayload(payload);
        break;
      case 'TYER':
      case 'TDRC':
        if (!result.year) result.year = decodeTextPayload(payload).slice(0, 4);
        break;
      case 'TSRC':
        result.isrc = decodeTextPayload(payload);
        break;
      case 'TXXX': {
        if (payload.length > 2) {
          const enc = payload[0];
          const body = payload.subarray(1);
          let sep = -1;
          let valueStart = -1;
          if (enc === 0x01 || enc === 0x02) {
            for (let k = 0; k + 1 < body.length; k += 2) {
              if (body[k] === 0x00 && body[k + 1] === 0x00) {
                sep = k;
                valueStart = k + 2;
                break;
              }
            }
          } else {
            sep = body.indexOf(0x00);
            if (sep >= 0) valueStart = sep + 1;
          }
          if (sep >= 0 && valueStart <= body.length) {
            const encByte = Buffer.from([enc]);
            const desc = decodeTextPayload(Buffer.concat([encByte, body.subarray(0, sep)])).trim().toUpperCase();
            const val = decodeTextPayload(Buffer.concat([encByte, body.subarray(valueStart)]));
            if (desc === 'REPLAYGAIN_TRACK_GAIN') {
              result.replayGainTrackGainDb = parseReplayGainDbValue(val);
            } else if (desc === 'REPLAYGAIN_TRACK_PEAK') {
              result.replayGainTrackPeak = parseReplayGainPeakValue(val);
            } else if (desc === 'REPLAYGAIN_ALBUM_GAIN') {
              result.replayGainAlbumGainDb = parseReplayGainDbValue(val);
            } else if (desc === 'REPLAYGAIN_ALBUM_PEAK') {
              result.replayGainAlbumPeak = parseReplayGainPeakValue(val);
            }
          }
        }
        break;
      }
      case 'USLT':
      case 'COMM': {
        if (payload.length > 4) {
          const enc = payload[0];
          const bodyAfterLang = payload.subarray(4);
          let textBuf = bodyAfterLang;
          if (enc === 0x01 || enc === 0x02) {
            let sep = -1;
            for (let k = 0; k + 1 < bodyAfterLang.length; k += 2) {
              if (bodyAfterLang[k] === 0x00 && bodyAfterLang[k + 1] === 0x00) {
                sep = k + 2;
                break;
              }
            }
            textBuf = sep >= 0 ? bodyAfterLang.subarray(sep) : bodyAfterLang;
          } else {
            const nullSep = bodyAfterLang.indexOf(0x00);
            textBuf = nullSep >= 0 ? bodyAfterLang.subarray(nullSep + 1) : bodyAfterLang;
          }
          const decoded = decodeTextPayload(Buffer.concat([Buffer.from([enc]), textBuf]));
          if (frameId === 'USLT') result.lyrics = decoded;
          if (frameId === 'COMM') result.provenance = decoded;
        }
        break;
      }
      case 'APIC': {
        const mimeEnd = payload.indexOf(0x00, 1);
        if (mimeEnd > 1) {
          const mime = payload.toString('ascii', 1, mimeEnd) || 'image/jpeg';
          const descStart = mimeEnd + 2; // skip null + picType byte
          const descEnd = payload.indexOf(0x00, descStart);
          const imgStart = descEnd >= 0 ? descEnd + 1 : descStart;
          const imgBuf = payload.subarray(imgStart);
          if (imgBuf.length > 0) {
            result.hasCover = true;
            result.coverMime = mime;
            result.coverBuffer = Buffer.from(imgBuf);
            result.coverDataUrl = `data:${mime};base64,${imgBuf.toString('base64')}`;
          }
        }
        break;
      }
      default:
        break;
    }

    offset += 10 + frameSize;
  }

  return result;
}

/**
 * Reads ID3v2 tags from a local file on disk (reading only the header portion for performance).
 * @param {string} filePath - Absolute path to the MP3 file.
 * @returns {object} Extracted ID3v2 metadata.
 */
function readId3v2FromFile(filePath) {
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: MP3_EXTENSIONS });
  if (!safePath) return readId3v2Tags(Buffer.alloc(0));
  try {
    const fd = fs.openSync(safePath, 'r');
    try {
      const headerBuf = Buffer.alloc(10);
      const bytesRead = fs.readSync(fd, headerBuf, 0, 10, 0);
      if (bytesRead < 10 || headerBuf.toString('ascii', 0, 3) !== 'ID3') {
        return readId3v2Tags(Buffer.alloc(0));
      }
      const tagSize = decodeSynchsafeInt(headerBuf, 6);
      const totalToRead = Math.min(10 + tagSize, 4 * 1024 * 1024); // Cap header read at 4MB
      const fullTagBuf = Buffer.alloc(totalToRead);
      fs.readSync(fd, fullTagBuf, 0, totalToRead, 0);
      return readId3v2Tags(fullTagBuf);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return readId3v2Tags(Buffer.alloc(0));
  }
}

/**
 * Updates metadata fields on an existing MP3 file in place while preserving cover art,
 * lyrics, provenance, and the exact audio payload (so audioHash remains identical).
 * @param {string} filePath - Target MP3 file path.
 * @param {object} [patch={}] - Metadata fields to update (title, artist, album, genre, bpm, key, year).
 * @returns {{ ok: boolean, error?: string }} Write status.
 */
function updateMp3MetadataOnDisk(filePath, patch = {}) {
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: MP3_EXTENSIONS });
  if (!safePath) {
    return { ok: false, error: 'MP3 file not found or rejected by path policy' };
  }
  try {
    const rawBuf = fs.readFileSync(safePath);
    const current = readId3v2Tags(rawBuf);
    const merged = {
      title: patch.title !== undefined ? patch.title : current.title,
      artist: patch.artist !== undefined ? patch.artist : current.artist,
      album: patch.album !== undefined ? patch.album : current.album,
      genre: patch.genre !== undefined ? patch.genre : current.genre,
      bpm: patch.bpm !== undefined ? patch.bpm : current.bpm,
      key: patch.key !== undefined ? patch.key : current.key,
      year: patch.year !== undefined ? patch.year : current.year,
      isrc: current.isrc,
      lyrics: current.lyrics,
      provenance: current.provenance,
      replayGainTrackGainDb: patch.replayGainTrackGainDb !== undefined ? patch.replayGainTrackGainDb : current.replayGainTrackGainDb,
      replayGainTrackPeak: patch.replayGainTrackPeak !== undefined ? patch.replayGainTrackPeak : current.replayGainTrackPeak,
      replayGainAlbumGainDb: patch.replayGainAlbumGainDb !== undefined ? patch.replayGainAlbumGainDb : current.replayGainAlbumGainDb,
      replayGainAlbumPeak: patch.replayGainAlbumPeak !== undefined ? patch.replayGainAlbumPeak : current.replayGainAlbumPeak,
      coverBuffer: current.coverBuffer
    };
    const updatedBuf = writeId3v2Tags(rawBuf, merged);
    const dir = path.dirname(safePath);
    const base = path.basename(safePath);
    const tmpPath = path.join(dir, `.${base}.vanta-tmp-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpPath, updatedBuf);
    try {
      fs.renameSync(tmpPath, safePath);
    } catch {
      fs.writeFileSync(safePath, updatedBuf);
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fast pure-JS reader for FLAC STREAMINFO & VORBIS_COMMENT metadata blocks (Title, Artist,
 * Album, Genre, BPM, Key, Year, Duration, Sample Rate, Bit Depth, Channels) without spawning ffmpeg.
 * @param {string} filePath - Path to .flac file.
 * @returns {object} Extracted FLAC metadata descriptor.
 */
function readFlacMetadataFromFile(filePath) {
  const empty = {
    hasFlac: false,
    title: '',
    artist: '',
    album: '',
    genre: '',
    bpm: '',
    key: '',
    year: '',
    lyrics: '',
    replayGainTrackGainDb: null,
    replayGainTrackPeak: null,
    replayGainAlbumGainDb: null,
    replayGainAlbumPeak: null,
    sampleRate: 0,
    channels: 0,
    bitDepth: 0,
    durationSec: 0
  };
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4 || head.toString('ascii', 0, 4) !== 'fLaC') {
      return empty;
    }
    empty.hasFlac = true;
    let offset = 4;
    let isLast = false;
    while (!isLast && offset < 2 * 1024 * 1024) {
      const blkHdr = Buffer.alloc(4);
      if (fs.readSync(fd, blkHdr, 0, 4, offset) < 4) break;
      isLast = (blkHdr[0] & 0x80) !== 0;
      const blockType = blkHdr[0] & 0x7f;
      const blockLen = (blkHdr[1] << 16) | (blkHdr[2] << 8) | blkHdr[3];
      offset += 4;
      if (blockLen <= 0 || blockLen > 1024 * 1024) {
        offset += Math.max(0, blockLen);
        continue;
      }

      if (blockType === 0 && blockLen >= 18) {
        const si = Buffer.alloc(Math.min(blockLen, 34));
        fs.readSync(fd, si, 0, si.length, offset);
        const sr = (si[10] << 12) | (si[11] << 4) | ((si[12] >> 4) & 0x0f);
        const ch = ((si[12] >> 1) & 0x07) + 1;
        const bps = (((si[12] & 0x01) << 4) | ((si[13] >> 4) & 0x0f)) + 1;
        const totalSamples =
          (BigInt(si[13] & 0x0f) << 32n) | BigInt(si.readUInt32BE(14));
        empty.sampleRate = sr;
        empty.channels = ch;
        empty.bitDepth = bps;
        empty.durationSec = sr > 0 ? Number(totalSamples) / sr : 0;
      } else if (blockType === 4 && blockLen >= 8) {
        const vc = Buffer.alloc(blockLen);
        const readN = fs.readSync(fd, vc, 0, blockLen, offset);
        let pos = 0;
        const vendorLen = readN >= 4 ? vc.readUInt32LE(pos) : 0;
        pos += 4 + vendorLen;
        if (pos + 4 <= readN) {
          const count = vc.readUInt32LE(pos);
          pos += 4;
          for (let i = 0; i < count && pos + 4 <= readN; i++) {
            const cLen = vc.readUInt32LE(pos);
            pos += 4;
            if (cLen <= 0 || pos + cLen > readN) break;
            const entry = vc.subarray(pos, pos + cLen).toString('utf8');
            pos += cLen;
            const eq = entry.indexOf('=');
            if (eq <= 0) continue;
            const k = entry.slice(0, eq).trim().toUpperCase();
            const v = entry.slice(eq + 1).trim();
            if (!v) continue;
            if (k === 'TITLE' && !empty.title) empty.title = v;
            else if ((k === 'ARTIST' || k === 'ALBUMARTIST') && !empty.artist) empty.artist = v;
            else if (k === 'ALBUM' && !empty.album) empty.album = v;
            else if (k === 'GENRE' && !empty.genre) empty.genre = v;
            else if ((k === 'BPM' || k === 'TBPM' || k === 'TEMPO') && !empty.bpm) empty.bpm = v;
            else if ((k === 'INITIALKEY' || k === 'INITIAL_KEY' || k === 'KEY' || k === 'TKEY') && !empty.key) empty.key = v;
            else if ((k === 'DATE' || k === 'YEAR') && !empty.year) empty.year = v.slice(0, 4);
            else if ((k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'USLT') && !empty.lyrics) empty.lyrics = v;
            else if (k === 'REPLAYGAIN_TRACK_GAIN') empty.replayGainTrackGainDb = parseReplayGainDbValue(v);
            else if (k === 'REPLAYGAIN_TRACK_PEAK') empty.replayGainTrackPeak = parseReplayGainPeakValue(v);
            else if (k === 'REPLAYGAIN_ALBUM_GAIN') empty.replayGainAlbumGainDb = parseReplayGainDbValue(v);
            else if (k === 'REPLAYGAIN_ALBUM_PEAK') empty.replayGainAlbumPeak = parseReplayGainPeakValue(v);
          }
        }
      }

      offset += blockLen;
    }
    return empty;
  } catch {
    return empty;
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
 * Atomically updates VORBIS_COMMENT tags (including ReplayGain 2.0 tags) on a FLAC file
 * without touching audio frames, STREAMINFO MD5, or embedded PICTURE blocks.
 * @param {string} filePath - Target .flac path.
 * @param {object} [patch={}] - Fields (`title`, `artist`, `album`, `genre`, `bpm`, `key`, `year`,
 *   `replayGainTrackGainDb`, `replayGainTrackPeak`, `replayGainAlbumGainDb`, `replayGainAlbumPeak`).
 * @returns {{ ok: boolean, error?: string }}
 */
function updateFlacVorbisTagsOnDisk(filePath, patch = {}) {
  const safePath = validateSafeFilePath(filePath, { allowedExtensions: FLAC_EXTENSIONS });
  if (!safePath) {
    return { ok: false, error: 'FLAC file not found or rejected by path policy' };
  }
  try {
    const raw = fs.readFileSync(safePath);
    if (raw.length < 42 || raw.toString('ascii', 0, 4) !== 'fLaC') {
      return { ok: false, error: 'Invalid FLAC header' };
    }

    let offset = 4;
    let isLast = false;
    const preservedBlocks = [];
    let vendorStr = 'reference libFLAC VANTA 2.0';
    let comments = [];

    while (!isLast && offset + 4 <= raw.length) {
      const hdr = raw.subarray(offset, offset + 4);
      isLast = (hdr[0] & 0x80) !== 0;
      const blockType = hdr[0] & 0x7f;
      const blockLen = (hdr[1] << 16) | (hdr[2] << 8) | hdr[3];
      offset += 4;
      if (blockLen < 0 || offset + blockLen > raw.length) {
        return { ok: false, error: 'Corrupt FLAC metadata block length' };
      }
      const body = raw.subarray(offset, offset + blockLen);
      offset += blockLen;

      if (blockType === 1) {
        // Drop old PADDING block; rebuild clean padding below
        continue;
      }
      if (blockType === 4 && body.length >= 8) {
        let pos = 0;
        const vLen = body.readUInt32LE(pos);
        pos += 4;
        if (pos + vLen <= body.length) {
          vendorStr = body.subarray(pos, pos + vLen).toString('utf8') || vendorStr;
          pos += vLen;
        }
        if (pos + 4 <= body.length) {
          const count = body.readUInt32LE(pos);
          pos += 4;
          for (let i = 0; i < count && pos + 4 <= body.length; i++) {
            const cLen = body.readUInt32LE(pos);
            pos += 4;
            if (cLen <= 0 || pos + cLen > body.length) break;
            const entry = body.subarray(pos, pos + cLen).toString('utf8');
            pos += cLen;
            const eq = entry.indexOf('=');
            if (eq > 0) {
              comments.push({
                key: entry.slice(0, eq).trim(),
                upperKey: entry.slice(0, eq).trim().toUpperCase(),
                value: entry.slice(eq + 1)
              });
            }
          }
        }
      } else {
        preservedBlocks.push({ blockType, body });
      }
    }

    const audioFrames = raw.subarray(offset);

    const setOrRemoveTag = (upperKey, formattedValue) => {
      comments = comments.filter((c) => c.upperKey !== upperKey);
      if (formattedValue !== undefined && formattedValue !== null && String(formattedValue).trim() !== '') {
        comments.push({ key: upperKey, upperKey, value: String(formattedValue).trim() });
      }
    };

    if (patch.title !== undefined) setOrRemoveTag('TITLE', patch.title);
    if (patch.artist !== undefined) setOrRemoveTag('ARTIST', patch.artist);
    if (patch.album !== undefined) setOrRemoveTag('ALBUM', patch.album);
    if (patch.genre !== undefined) setOrRemoveTag('GENRE', patch.genre);
    if (patch.bpm !== undefined) setOrRemoveTag('BPM', patch.bpm);
    if (patch.key !== undefined) setOrRemoveTag('INITIALKEY', patch.key);
    if (patch.year !== undefined) setOrRemoveTag('DATE', patch.year);
    if (patch.replayGainTrackGainDb !== undefined) {
      setOrRemoveTag('REPLAYGAIN_TRACK_GAIN', patch.replayGainTrackGainDb === null ? null : formatReplayGainDb(patch.replayGainTrackGainDb));
    }
    if (patch.replayGainTrackPeak !== undefined) {
      setOrRemoveTag('REPLAYGAIN_TRACK_PEAK', patch.replayGainTrackPeak === null ? null : formatReplayGainPeak(patch.replayGainTrackPeak));
    }
    if (patch.replayGainAlbumGainDb !== undefined) {
      setOrRemoveTag('REPLAYGAIN_ALBUM_GAIN', patch.replayGainAlbumGainDb === null ? null : formatReplayGainDb(patch.replayGainAlbumGainDb));
    }
    if (patch.replayGainAlbumPeak !== undefined) {
      setOrRemoveTag('REPLAYGAIN_ALBUM_PEAK', patch.replayGainAlbumPeak === null ? null : formatReplayGainPeak(patch.replayGainAlbumPeak));
    }

    const vendorBuf = Buffer.from(vendorStr, 'utf8');
    const vLenBuf = Buffer.alloc(4);
    vLenBuf.writeUInt32LE(vendorBuf.length, 0);
    const countBuf = Buffer.alloc(4);
    countBuf.writeUInt32LE(comments.length, 0);
    const commentParts = [vLenBuf, vendorBuf, countBuf];
    for (const c of comments) {
      const entryBuf = Buffer.from(`${c.key}=${c.value}`, 'utf8');
      const eLen = Buffer.alloc(4);
      eLen.writeUInt32LE(entryBuf.length, 0);
      commentParts.push(eLen, entryBuf);
    }
    const vorbisBody = Buffer.concat(commentParts);

    const allBlocks = [
      ...preservedBlocks,
      { blockType: 4, body: vorbisBody },
      { blockType: 1, body: Buffer.alloc(1024, 0) }
    ];

    const outParts = [Buffer.from('fLaC', 'ascii')];
    for (let i = 0; i < allBlocks.length; i++) {
      const blk = allBlocks[i];
      const len = blk.body.length;
      if (len > 0xffffff) {
        return { ok: false, error: 'FLAC metadata block exceeds 16 MB limit' };
      }
      const hdr = Buffer.alloc(4);
      hdr[0] = (i === allBlocks.length - 1 ? 0x80 : 0x00) | (blk.blockType & 0x7f);
      hdr[1] = (len >> 16) & 0xff;
      hdr[2] = (len >> 8) & 0xff;
      hdr[3] = len & 0xff;
      outParts.push(hdr, blk.body);
    }
    outParts.push(audioFrames);

    const updatedBuf = Buffer.concat(outParts);
    const dir = path.dirname(safePath);
    const base = path.basename(safePath);
    const tmpPath = path.join(dir, `.${base}.vanta-tmp-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpPath, updatedBuf);
    try {
      fs.renameSync(tmpPath, safePath);
    } catch {
      fs.writeFileSync(safePath, updatedBuf);
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  normalizeId3Genre,
  encodeSynchsafeInt,
  decodeSynchsafeInt,
  stripExistingId3v2,
  parseReplayGainDbValue,
  parseReplayGainPeakValue,
  formatReplayGainDb,
  formatReplayGainPeak,
  createTxxxFrame,
  writeId3v2Tags,
  readId3v2Tags,
  readId3v2FromFile,
  updateMp3MetadataOnDisk,
  readFlacMetadataFromFile,
  updateFlacVorbisTagsOnDisk
};
