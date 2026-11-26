'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  const frames = [
    createTextFrame('TIT2', metadata.title),
    createTextFrame('TPE1', metadata.artist),
    createTextFrame('TALB', metadata.album),
    createTextFrame('TCON', metadata.genre),
    createTextFrame('TBPM', metadata.bpm),
    createTextFrame('TKEY', metadata.key),
    createTextFrame('TYER', metadata.year),
    createTextFrame('TSRC', metadata.isrc),
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
  try {
    const fd = fs.openSync(filePath, 'r');
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
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'MP3 file not found' };
  }
  try {
    const rawBuf = fs.readFileSync(filePath);
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
      coverBuffer: current.coverBuffer
    };
    const updatedBuf = writeId3v2Tags(rawBuf, merged);
    const tmpPath = `${filePath}.vanta-tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, updatedBuf);
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, updatedBuf);
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

module.exports = {
  normalizeId3Genre,
  encodeSynchsafeInt,
  decodeSynchsafeInt,
  stripExistingId3v2,
  writeId3v2Tags,
  readId3v2Tags,
  readId3v2FromFile,
  updateMp3MetadataOnDisk,
  readFlacMetadataFromFile
};
