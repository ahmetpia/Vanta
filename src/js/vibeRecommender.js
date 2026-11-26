/**
 * @fileoverview VANTA Personalization, Vibe Radio, Semantic Natural-Language Search,
 * Contextual Bandits, and Time Capsule Engine (Pillars B, F, H).
 */

import { CAMELOT_KEY_MAP, computeSongDna, evaluateHarmonicCompatibility } from './mirAnalyzer.js';

export const GENRE_TAXONOMY = [
  {
    id: 'pop',
    main: 'Pop',
    icon: '✨',
    subs: ['Synth-Pop', 'Electropop', 'Indie Pop', 'Dream Pop', 'Hyperpop', 'Chamber Pop', 'Baroque Pop', 'Dance-Pop', 'Teen Pop', 'K-Pop', 'J-Pop', 'Latin Pop', 'Art Pop']
  },
  {
    id: 'rock',
    main: 'Rock',
    icon: '🎸',
    subs: ['Classic Rock', 'Hard Rock', 'Soft Rock', 'Psychedelic Rock', 'Progressive Rock', 'Punk Rock', 'Post-Punk', 'Alternative Rock', 'Indie Rock', 'Grunge', 'Shoegaze', 'Garage Rock', 'Folk Rock', 'Blues Rock', 'Britpop', 'Post-Rock', 'Math Rock']
  },
  {
    id: 'metal',
    main: 'Metal',
    icon: '⚡',
    subs: ['Heavy Metal', 'Thrash Metal', 'Death Metal', 'Black Metal', 'Doom Metal', 'Power Metal', 'Progressive Metal', 'Nu Metal', 'Metalcore', 'Deathcore', 'Symphonic Metal', 'Folk Metal', 'Groove Metal', 'Blackgaze']
  },
  {
    id: 'hiphop',
    main: 'Hip-Hop / Rap',
    icon: '🎤',
    subs: ['Old School Hip-Hop', 'Boom Bap', 'Conscious Hip-Hop', 'Gangsta Rap', 'East Coast Rap', 'West Coast Rap', 'Southern Rap', 'Trap', 'Drill', 'UK Drill', 'Cloud Rap', 'Lo-Fi Hip-Hop', 'Jazz Rap', 'Experimental Hip-Hop']
  },
  {
    id: 'electronic',
    main: 'Electronic',
    icon: '🎛️',
    subs: ['House', 'Deep House', 'Tech House', 'Progressive House', 'Acid House', 'Techno', 'Minimal Techno', 'Melodic Techno', 'Trance', 'Psytrance', 'Drum and Bass (DnB)', 'Jungle', 'Dubstep', 'Breakbeat', 'Big Beat', 'Garage / 2-Step', 'Ambient', 'Downtempo', 'Synthwave / Darksynth', 'IDM', 'Hardstyle', 'UK Garage']
  },
  {
    id: 'rnb',
    main: 'R&B / Soul / Funk',
    icon: '💫',
    subs: ['Neo-Soul', 'Contemporary R&B', 'Motown', 'Quiet Storm', 'Funk', 'P-Funk', 'Disco', 'Nu-Disco', 'Boogie', 'Gospel']
  },
  {
    id: 'jazz',
    main: 'Jazz / Blues',
    icon: '🎷',
    subs: ['Dixieland', 'Swing', 'Bebop', 'Hard Bop', 'Cool Jazz', 'Modal Jazz', 'Free Jazz', 'Jazz Fusion', 'Smooth Jazz', 'Acid Jazz', 'Latin Jazz', 'Delta Blues', 'Chicago Blues', 'Electric Blues', 'Piedmont Blues', 'Jump Blues', 'Soul Blues']
  },
  {
    id: 'classical',
    main: 'Classical',
    icon: '🎻',
    subs: ['Early Music', 'Renaissance', 'Baroque', 'Classical Period', 'Romantic', 'Modern Classical', 'Minimalism', 'Opera', 'Choral', 'Chamber Music', 'Orchestral', 'Soundtrack / Film Score', 'Video Game Music']
  },
  {
    id: 'folk',
    main: 'Folk / Country',
    icon: '🪕',
    subs: ['Traditional Folk', 'Contemporary Folk', 'Indie Folk', 'Americana', 'Bluegrass', 'Outlaw Country', 'Alt-Country', 'Country Pop', 'Honky-Tonk', 'Celtic Folk']
  },
  {
    id: 'world',
    main: 'World / Latin / Reggae',
    icon: '🌍',
    subs: ['Salsa', 'Bachata', 'Merengue', 'Cumbia', 'Bossa Nova', 'Samba', 'Tango', 'Reggaeton', 'Dancehall', 'Dub', 'Ska', 'Rocksteady', 'Afrobeats', 'Afrobeat', 'Highlife', 'Flamenco', 'Fado', 'Arabesk', 'Türk Sanat Müziği', 'Türk Halk Müziği', 'Anatolian Rock']
  }
];

/**
 * Maps a subgenre or genre string back to its parent Main Category in GENRE_TAXONOMY.
 * Enables Smart Playlists & searches on "Electronic" to match "Deep House", "Techno", etc.
 * @param {string} rawGenre - Stored genre string.
 * @returns {string} Parent Main Genre label or empty string if unknown.
 */
export function resolveMainGenre(rawGenre) {
  const clean = String(rawGenre || '').trim().toLowerCase();
  if (!clean) return '';
  for (const cat of GENRE_TAXONOMY) {
    if (cat.main.toLowerCase() === clean || clean.startsWith(`${cat.main.toLowerCase()} ·`)) {
      return cat.main;
    }
    if (cat.subs.some((s) => s.toLowerCase() === clean)) {
      return cat.main;
    }
  }
  return '';
}

/**
 * Computes cosine similarity between two numeric vectors of equal length.
 * @param {number[]} vecA - First vector.
 * @param {number[]} vecB - Second vector.
 * @returns {number} Cosine similarity in [0, 1].
 */
export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

/**
 * Parses a natural-language semantic search query (e.g., "melancholic night drive synthwave 120-128 BPM")
 * into structured BPM ranges, mood descriptors, and keyword tokens.
 * @param {string} rawQuery - Natural-language query from the top Semantic Search bar.
 * @returns {{ minBpm: number|null, maxBpm: number|null, moodTags: string[], tokens: string[] }}
 */
export function parseSemanticSearchQuery(rawQuery) {
  const clean = String(rawQuery || '')
    .replace(/[“”"']/g, '')
    .trim()
    .toLowerCase();

  let minBpm = null;
  let maxBpm = null;

  // Match range like "120-128 bpm" or "120–128 bpm"
  const rangeMatch = /(\d{2,3})\s*[-–to]+\s*(\d{2,3})\s*bpm/i.exec(clean);
  if (rangeMatch) {
    minBpm = Math.min(Number(rangeMatch[1]), Number(rangeMatch[2]));
    maxBpm = Math.max(Number(rangeMatch[1]), Number(rangeMatch[2]));
  } else {
    const singleBpm = /(\d{2,3})\s*bpm/i.exec(clean);
    if (singleBpm) {
      const target = Number(singleBpm[1]);
      minBpm = target - 8;
      maxBpm = target + 8;
    }
  }

  const moodDictionary = [
    'melancholic',
    'night',
    'drive',
    'synthwave',
    'synth',
    'phonk',
    'ambient',
    'focus',
    'rain',
    'energetic',
    'aggressive',
    'chill',
    'lo-fi',
    'fusion',
    'rock',
    'obsidian'
  ];

  const moodTags = moodDictionary.filter((m) => clean.includes(m));
  const stopWords = new Set(['for', 'with', 'and', 'the', 'around', 'bpm', 'mix', 'music', 'track', 'songs']);
  const tokens = clean
    .replace(/\b\d{2,3}(?:\s?(?:[-–]|to)\s?\d{2,3})?\s?bpm\b/gi, '')
    .split(/[^a-z0-9ğüşıöç]+/i)
    .filter((w) => w.length >= 2 && !stopWords.has(w));

  return {
    minBpm,
    maxBpm,
    moodTags,
    tokens
  };
}

/**
 * Executes semantic natural-language search across the track catalog, returning tracks ranked by semantic relevance.
 * @param {string} rawQuery - Natural-language search prompt.
 * @param {object[]} catalogTracks - Array of catalog track objects.
 * @returns {object[]} Ranked matching tracks with `semanticScore` attached.
 */
export function executeSemanticSearch(rawQuery, catalogTracks = []) {
  const parsed = parseSemanticSearchQuery(rawQuery);
  if (!parsed.minBpm && !parsed.maxBpm && parsed.tokens.length === 0) {
    return catalogTracks.map((t) => ({ ...t, semanticScore: 100 }));
  }

  const scored = catalogTracks.map((track) => {
    let score = 50;
    const bpm = Number(track.bpm) || 124;

    if (parsed.minBpm !== null && parsed.maxBpm !== null) {
      if (bpm >= parsed.minBpm && bpm <= parsed.maxBpm) {
        score += 35;
      } else {
        const dist = Math.min(Math.abs(bpm - parsed.minBpm), Math.abs(bpm - parsed.maxBpm));
        score -= Math.min(35, dist * 1.5);
      }
    }

    const haystack = `${track.title || ''} ${track.artist || ''} ${track.genre || ''} ${track.mood || ''} ${track.provenance || ''}`.toLowerCase();
    for (const token of parsed.tokens) {
      if (haystack.includes(token)) {
        score += 18;
      }
    }
    for (const mood of parsed.moodTags) {
      if (haystack.includes(mood)) {
        score += 12;
      }
    }

    return {
      ...track,
      semanticScore: Math.max(5, Math.min(99, Math.round(score)))
    };
  });

  return scored
    .filter((t) => t.semanticScore >= 40)
    .sort((a, b) => b.semanticScore - a.semanticScore);
}

/**
 * Ranks catalog tracks for "Vibe Radio" continuity from an anchor track using:
 * 1. Song DNA Cosine Similarity
 * 2. Camelot Wheel Harmonic Key Compatibility
 * 3. Contextual Bandit real-time feedback (likes, completions, skips)
 * @param {object} anchorTrack - Current playing track.
 * @param {object[]} catalogTracks - Full catalog list.
 * @param {object} [banditRewards={}] - Map of trackId -> numeric reward weight (-1.0 to +1.0).
 * @returns {object[]} Ordered Vibe Radio queue with match percentage and transition notes.
 */
export function isMusicVideoTagged(track = {}) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  const tags = Array.isArray(track.tags) ? track.tags : [];
  const groups = Array.isArray(track.groups) ? track.groups : [];
  return tags.some((t) => norm(t) === 'musicvideo') || groups.some((g) => norm(g) === 'musicvideo');
}

export function isLongFeatureVideo(track = {}) {
  if (!track?.isVideo) return false;
  if ((Number(track.durationSec) || 0) > 900) return true;
  return /\b(full[\s._-]*movie|feature[\s._-]*film|1080p[\s._-]*bluray|2160p[\s._-]*uhd)\b/i.test(
    String(track.title || track.fileName || '')
  );
}

export function buildVibeRadioQueue(anchorTrack, catalogTracks = [], banditRewards = {}) {
  if (!anchorTrack || catalogTracks.length === 0) return [];
  const eligible = catalogTracks.filter((t) => !t.isVideo || (isMusicVideoTagged(t) && !isLongFeatureVideo(t)));
  const pool = eligible.length ? eligible : catalogTracks.filter((t) => !t.isVideo);
  if (!pool.length) return [];
  const anchorDna = computeSongDna(anchorTrack);

  return pool
    .map((candidate) => {
      const candDna = computeSongDna(candidate);
      const sim = cosineSimilarity(anchorDna.vector, candDna.vector);
      const harm = evaluateHarmonicCompatibility(anchorTrack.key, candidate.key);
      const harmonicBonus = harm.compatible ? 0.08 : 0;
      const banditBonus = (Number(banditRewards[candidate.id]) || 0) * 0.1;

      const rawMatch = Math.min(0.99, Math.max(0.62, sim * 0.88 + harmonicBonus + banditBonus));
      const matchPercent = Math.round(rawMatch * 100);

      return {
        ...candidate,
        matchPercent,
        camelotTransition: `${harm.camelotA} → ${harm.camelotB}`,
        harmonicCompatible: harm.compatible
      };
    })
    .sort((a, b) => b.matchPercent - a.matchPercent);
}

/**
 * Computes the Time Capsule & Catalog Intelligence summary (Pillar H).
 * @param {object[]} catalogTracks - Catalog tracks array.
 * @returns {object} Summary statistics for the Time Capsule & Song DNA views.
 */
export function buildTimeCapsuleAnalytics(catalogTracks = []) {
  if (!catalogTracks.length) {
    return {
      totalTracks: 0,
      avgBpm: 124,
      avgEnergy: 86,
      dominantKey: 'A min',
      aiCount: 0,
      youtubeCount: 0,
      localCount: 0,
      eraTitle: '2026 Obsidian Night Synth Era'
    };
  }

  let bpmSum = 0;
  let energySum = 0;
  let aiCount = 0;
  let youtubeCount = 0;
  let localCount = 0;
  const keyFreq = new Map();

  for (const t of catalogTracks) {
    bpmSum += Number(t.bpm) || 124;
    energySum += Number(t.energy) || 85;
    const k = t.key || 'A min';
    keyFreq.set(k, (keyFreq.get(k) || 0) + 1);

    const prov = String(t.provenance || '').toLowerCase();
    if (prov.includes('suno') || prov.includes('ai')) aiCount++;
    else if (prov.includes('youtube') || prov.includes('yt')) youtubeCount++;
    else localCount++;
  }

  let dominantKey = 'A min';
  let maxKeyCount = 0;
  for (const [k, count] of keyFreq.entries()) {
    if (count > maxKeyCount) {
      maxKeyCount = count;
      dominantKey = k;
    }
  }

  return {
    totalTracks: catalogTracks.length,
    avgBpm: Math.round(bpmSum / catalogTracks.length),
    avgEnergy: Math.round(energySum / catalogTracks.length),
    dominantKey,
    aiCount,
    youtubeCount,
    localCount,
    eraTitle: '2026 Obsidian Night Synth & Studio Era'
  };
}

/**
 * Applies multi-parameter pro DJ/library filtering and sorting across tracks.
 * Supports inline query prefixes (`bpm:120-135`, `key:8A`, `key:Am`, `star:4+`, `#tag`, `ext:flac`).
 * @param {object[]} catalogTracks - Full track array.
 * @param {object} [filters] - Filter configuration.
 * @param {object|null} [anchorTrack=null] - Currently playing track for Harmonic Match.
 * @returns {object[]} Filtered and sorted tracks.
 */
export function applyProSmartFilter(catalogTracks = [], filters = {}, anchorTrack = null) {
  let minBpm = filters.minBpm ? Number(filters.minBpm) : null;
  let maxBpm = filters.maxBpm ? Number(filters.maxBpm) : null;
  let keyFilter = filters.key || 'ALL';
  const energyBand = filters.energyBand || 'ALL';
  let minStars = Number(filters.minStars) || 0;
  let exactStars = Number(filters.exactStars) || 0;
  const tagFilter = filters.tag || 'ALL';
  const selectedTags = Array.isArray(filters.tags)
    ? filters.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  const selectedGroups = Array.isArray(filters.groups)
    ? filters.groups.map((g) => String(g).trim().toLowerCase()).filter(Boolean)
    : [];
  const favoriteOnly = Boolean(filters.favoriteOnly);
  const sortBy = filters.sortBy || 'default';
  let textTokens = [];
  let requiredTags = [];
  let extFilter = '';

  const rawSearch = String(filters.query || '').trim();
  if (rawSearch) {
    const parts = rawSearch.split(/\s+/);
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower.startsWith('bpm:')) {
        const val = lower.slice(4);
        const range = /^(\d{2,3})[-–](\d{2,3})$/.exec(val);
        if (range) {
          minBpm = Math.min(Number(range[1]), Number(range[2]));
          maxBpm = Math.max(Number(range[1]), Number(range[2]));
        } else if (/^\d{2,3}$/.test(val)) {
          minBpm = Number(val) - 3;
          maxBpm = Number(val) + 3;
        }
      } else if (lower.startsWith('key:')) {
        keyFilter = part.slice(4).trim();
      } else if (lower.startsWith('star:') || lower.startsWith('stars:')) {
        const rawVal = lower.replace(/^stars?:/, '');
        const num = Number.parseInt(rawVal, 10);
        if (!Number.isNaN(num)) {
          if (rawVal.endsWith('+')) minStars = num;
          else exactStars = num;
        }
      } else if (lower.startsWith('ext:')) {
        extFilter = lower.slice(4).trim();
      } else if (lower.startsWith('#') && lower.length > 1) {
        requiredTags.push(lower.slice(1));
      } else {
        textTokens.push(lower);
      }
    }
  }

  const filtered = catalogTracks.filter((track) => {
    const bpm = Number(track.bpm) || 124;
    const energy = Number(track.energy) || 80;
    const stars = Number(track.stars) || 0;
    const trackKey = String(track.key || 'A min');
    const camelotCode = (CAMELOT_KEY_MAP[trackKey]?.code || '').toLowerCase();
    const tags = Array.isArray(track.tags) ? track.tags.map((t) => String(t).trim().toLowerCase()) : [];
    const groups = Array.isArray(track.groups) ? track.groups.map((g) => String(g).trim().toLowerCase()) : [];

    if (minBpm !== null && bpm < minBpm) return false;
    if (maxBpm !== null && bpm > maxBpm) return false;

    if (keyFilter && keyFilter !== 'ALL') {
      if (keyFilter === 'HARMONIC') {
        if (anchorTrack) {
          const harm = evaluateHarmonicCompatibility(anchorTrack.key, trackKey);
          if (!harm.compatible) return false;
        }
      } else {
        const kq = keyFilter.toLowerCase().replace(/\s+/g, '');
        const tkNorm = trackKey.toLowerCase().replace(/\s+/g, '');
        const tkShort = tkNorm.replace('min', 'm');
        if (tkNorm !== kq && tkShort !== kq && camelotCode !== kq) {
          return false;
        }
      }
    }

    if (energyBand === 'low' && energy >= 75) return false;
    if (energyBand === 'mid' && (energy < 75 || energy >= 88)) return false;
    if (energyBand === 'high' && energy < 88) return false;

    if (exactStars > 0 && stars !== exactStars) return false;
    if (minStars > 0 && stars < minStars) return false;
    if (favoriteOnly && !track.favorite) return false;

    if (selectedTags.length > 0 && !selectedTags.some((st) => tags.includes(st))) return false;
    if (selectedGroups.length > 0 && !selectedGroups.some((sg) => groups.includes(sg))) return false;

    if (tagFilter && tagFilter !== 'ALL') {
      const tf = tagFilter.toLowerCase();
      if (!tags.includes(tf) && !groups.includes(tf)) return false;
    }

    if (extFilter && String(track.ext || '').toLowerCase() !== extFilter) {
      return false;
    }

    for (const reqTag of requiredTags) {
      if (!tags.some((t) => t.includes(reqTag)) && !groups.some((g) => g.includes(reqTag))) {
        return false;
      }
    }

    if (textTokens.length > 0) {
      const parentGenre = resolveMainGenre(track.genre);
      const haystack = [
        track.title,
        track.artist,
        track.album,
        track.genre,
        parentGenre,
        track.mood,
        track.provenance,
        track.fileName,
        trackKey,
        camelotCode,
        ...tags,
        ...groups
      ]
        .join(' ')
        .toLowerCase();

      for (const tok of textTokens) {
        if (!haystack.includes(tok)) return false;
      }
    }

    return true;
  });

  const sortSpec = {
    'title-asc': (a, b) => String(a.title || '').localeCompare(String(b.title || '')),
    'title-desc': (a, b) => String(b.title || '').localeCompare(String(a.title || '')),
    'artist-asc': (a, b) => String(a.artist || '').localeCompare(String(b.artist || '')),
    'artist-desc': (a, b) => String(b.artist || '').localeCompare(String(a.artist || '')),
    'bpm-asc': (a, b) => (Number(a.bpm) || 0) - (Number(b.bpm) || 0),
    'bpm-desc': (a, b) => (Number(b.bpm) || 0) - (Number(a.bpm) || 0),
    'key-asc': (a, b) => getCamelotSortRank(a.key) - getCamelotSortRank(b.key),
    'key-desc': (a, b) => getCamelotSortRank(b.key) - getCamelotSortRank(a.key),
    'genre-asc': (a, b) => compareNonEmptyText(a.genre, b.genre, 1),
    'genre-desc': (a, b) => compareNonEmptyText(a.genre, b.genre, -1),
    'time-asc': (a, b) => (Number(a.durationSec) || 0) - (Number(b.durationSec) || 0),
    'time-desc': (a, b) => (Number(b.durationSec) || 0) - (Number(a.durationSec) || 0),
    'stars-asc': (a, b) => (Number(a.stars) || 0) - (Number(b.stars) || 0),
    'stars-desc': (a, b) => (Number(b.stars) || 0) - (Number(a.stars) || 0),
    'tags-asc': (a, b) => compareNonEmptyText((a.tags || []).join(' '), (b.tags || []).join(' '), 1),
    'tags-desc': (a, b) => compareNonEmptyText((a.tags || []).join(' '), (b.tags || []).join(' '), -1),
    'format-asc': (a, b) => String(a.ext || '').localeCompare(String(b.ext || '')),
    'format-desc': (a, b) => String(b.ext || '').localeCompare(String(a.ext || '')),
    'album-asc': (a, b) => compareNonEmptyText(a.album, b.album, 1),
    'album-desc': (a, b) => compareNonEmptyText(a.album, b.album, -1),
    'created-asc': (a, b) => compareNonEmptyText(a.createdAt || a.modifiedAt, b.createdAt || b.modifiedAt, 1),
    'created-desc': (a, b) => compareNonEmptyText(a.createdAt || a.modifiedAt, b.createdAt || b.modifiedAt, -1),
    'size-asc': (a, b) => (Number(a.sizeBytes) || 0) - (Number(b.sizeBytes) || 0),
    'size-desc': (a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0),
    'source-asc': (a, b) => compareNonEmptyText(extractFolderOnly(a.filePath) || a.provenance, extractFolderOnly(b.filePath) || b.provenance, 1),
    'source-desc': (a, b) => compareNonEmptyText(extractFolderOnly(a.filePath) || a.provenance, extractFolderOnly(b.filePath) || b.provenance, -1),
    'energy-desc': (a, b) => (Number(b.energy) || 0) - (Number(a.energy) || 0)
  };
  if (sortSpec[sortBy]) {
    filtered.sort(sortSpec[sortBy]);
  }

  return filtered;
}

function getCamelotSortRank(keyStr) {
  const code = (CAMELOT_KEY_MAP[keyStr]?.code || String(keyStr || '')).toUpperCase();
  const match = /^(\d{1,2})([AB])$/.exec(code);
  if (!match) return 999;
  return Number(match[1]) * 2 + (match[2] === 'B' ? 1 : 0);
}

function extractFolderOnly(filePath) {
  const s = String(filePath || '').trim();
  const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return idx > 0 ? s.slice(0, idx) : s;
}

function compareNonEmptyText(aVal, bVal, dir = 1) {
  const a = String(aVal || '').trim();
  const b = String(bVal || '').trim();
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b) * dir;
}

const LYRIC_SECTION_REGEX = /^\[(?:intro|verse|pre-chorus|post-chorus|chorus|bridge|hook|refrain|interlude|outro|solo|instrumental|break|drop)(?:[\s:-]*\d*|[ \t]+[^\]]{1,24})?\]$/i;
const INLINE_SECTION_REGEX = /\[(?:intro|verse|pre-chorus|post-chorus|chorus|bridge|hook|refrain|interlude|outro|solo|instrumental|break|drop)(?:[\s:-]*\d*|[ \t]+[^\]]{1,24})?\]/gi;

/**
 * Normalizes embedded USLT/Vorbis/LRC lyrics into clean line-by-line stanza tokens.
 * Ensures section headers ([Verse 1], [Pre-Chorus], [Chorus], etc.) start cleanly with stanza gaps.
 * @param {string} rawLyrics - Raw lyrics string from track metadata.
 * @returns {Array<{ type: 'section'|'cue'|'line'|'gap', text: string }>}
 */
export function parseStructuredLyrics(rawLyrics) {
  let normalized = String(rawLyrics || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();
  if (!normalized || /^Restored by VANTA Quality Doctor$/i.test(normalized)) {
    return [];
  }

  // Ensure structural section markers ([Verse 1], [Chorus], etc.) break onto their own lines
  normalized = normalized.replace(INLINE_SECTION_REGEX, (match) => `\n${match}\n`);

  const lines = normalized.split('\n');
  const tokens = [];

  for (const rawLine of lines) {
    // Strip leading LRC timecodes such as [00:12.34]
    const stripped = rawLine
      .replace(/^(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*)+/, '')
      .replace(/[ \t]+/g, ' ')
      .trim();

    if (!stripped) {
      const prev = tokens[tokens.length - 1];
      if (tokens.length > 0 && prev && prev.type !== 'gap' && prev.type !== 'section') {
        tokens.push({ type: 'gap', text: '' });
      }
      continue;
    }

    if (LYRIC_SECTION_REGEX.test(stripped)) {
      const prev = tokens[tokens.length - 1];
      if (tokens.length > 0 && prev && prev.type !== 'gap') {
        tokens.push({ type: 'gap', text: '' });
      }
      tokens.push({ type: 'section', text: stripped });
    } else if (/^\[[^\]]{1,120}\]$/.test(stripped)) {
      tokens.push({ type: 'cue', text: stripped });
    } else {
      tokens.push({ type: 'line', text: stripped });
    }
  }

  while (tokens.length > 0 && tokens[tokens.length - 1].type === 'gap') {
    tokens.pop();
  }
  return tokens;
}

const LOSSLESS_FORMATS = new Set(['FLAC', 'WAV', 'W64', 'AIFF', 'AIF', 'ALAC', 'DSF', 'DFF', 'APE', 'WV']);

/**
 * Extracts the immediate parent directory name from a file path for folder-based release grouping.
 * @param {string} filePath - Track file path.
 * @returns {string} Parent folder name or empty string.
 */
function extractParentFolderName(filePath) {
  const dir = extractFolderOnly(filePath);
  if (!dir) return '';
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Creates an empty track collection metric accumulator shared by Album and Artist grouping.
 * @param {string} id - Unique collection ID.
 * @param {object} [extra={}] - Extra initial fields.
 * @returns {object} Metric bucket.
 */
function createMetricBucket(id, extra = {}) {
  return {
    id,
    ...extra,
    tracks: [],
    artistCounts: new Map(),
    genreCounts: new Map(),
    yearCounts: new Map(),
    formatSet: new Set(),
    totalDurationSec: 0,
    bpmSum: 0,
    bpmCount: 0,
    starSum: 0,
    ratedCount: 0,
    maxStars: 0,
    favoriteCount: 0,
    isLossless: false,
    latestIso: ''
  };
}

/**
 * Accumulates a track's metadata & audio metrics into a collection bucket.
 * @param {object} bucket - Target metric bucket.
 * @param {object} track - Track object.
 */
function accumulateTrackIntoBucket(bucket, track) {
  bucket.tracks.push(track);

  const artist = String(track.artist || '').trim();
  if (artist) {
    bucket.artistCounts.set(artist, (bucket.artistCounts.get(artist) || 0) + 1);
  }

  const genre = String(track.genre || '').trim();
  if (genre) {
    bucket.genreCounts.set(genre, (bucket.genreCounts.get(genre) || 0) + 1);
  }

  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(String(track.year || ''));
  if (yearMatch) {
    bucket.yearCounts.set(yearMatch[1], (bucket.yearCounts.get(yearMatch[1]) || 0) + 1);
  }

  const ext = String(track.ext || '').trim().toUpperCase();
  if (ext) {
    bucket.formatSet.add(ext);
    if (LOSSLESS_FORMATS.has(ext) || Number(track.bitDepth) >= 24) {
      bucket.isLossless = true;
    }
  }

  const dur = Number(track.durationSec) || 0;
  if (dur > 0) bucket.totalDurationSec += dur;

  const bpm = Number(track.bpm) || 0;
  if (bpm > 0) {
    bucket.bpmSum += bpm;
    bucket.bpmCount += 1;
  }

  const stars = Number(track.stars) || 0;
  if (stars > 0) {
    bucket.starSum += stars;
    bucket.ratedCount += 1;
    if (stars > bucket.maxStars) bucket.maxStars = stars;
  }
  if (track.favorite) bucket.favoriteCount += 1;

  const iso = String(track.createdAt || track.modifiedAt || '');
  if (iso && iso > bucket.latestIso) {
    bucket.latestIso = iso;
  }
}

/**
 * Returns keys from a frequency map sorted descending by occurrence count.
 * @param {Map<string, number>} countMap - Count map.
 * @param {string} [fallback=''] - Fallback when map is empty.
 * @returns {string} Top key.
 */
function pickTopKeyFromMap(countMap, fallback = '') {
  let bestKey = fallback;
  let bestCount = -1;
  for (const [k, c] of countMap.entries()) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  return bestKey;
}

/**
 * Builds structured Album & Release Collections from catalog tracks.
 * Groups tracks with `album` metadata into Album Releases and falls back to parent folder
 * collections for untagged tracks so every library feels cohesive and browsable.
 * @param {object[]} [tracks=[]] - Audio / #MusicVideo track pool.
 * @param {object} [options={}] - Grouping, filter, and sorting options.
 * @param {'all'|'tagged'|'folder'} [options.mode='all'] - Release source filter.
 * @param {string} [options.query=''] - Search filter matching album title, artist, genre, year, or track title.
 * @param {'smart'|'title-asc'|'artist-asc'|'tracks-desc'|'rating-desc'|'recent-desc'|'year-desc'} [options.sortBy='smart'] - Sort order.
 * @returns {object[]} Sorted album collection descriptors.
 */
export function buildAlbumCollections(tracks = [], options = {}) {
  const mode = options.mode === 'tagged' || options.mode === 'folder' ? options.mode : 'all';
  const query = String(options.query || '').trim().toLowerCase();
  const sortBy = options.sortBy || 'smart';

  const groupsMap = new Map();

  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track) continue;
    const rawAlbum = String(track.album || '').trim();
    const hasExplicitAlbum = Boolean(rawAlbum && !/^vanta media vault$/i.test(rawAlbum));

    let kind = 'single';
    let groupKey = 'single:vault';
    let displayTitle = 'Singles & Loose Tracks';
    let folderPath = '';

    if (hasExplicitAlbum) {
      kind = 'album';
      groupKey = `album:${rawAlbum.toLowerCase()}`;
      displayTitle = rawAlbum;
    } else if (track.filePath) {
      folderPath = extractFolderOnly(track.filePath);
      const folderName = extractParentFolderName(track.filePath);
      kind = 'folder';
      groupKey = `folder:${folderPath.toLowerCase()}`;
      displayTitle = folderName || 'Local Folder';
    }

    if (mode === 'tagged' && kind !== 'album') continue;
    if (mode === 'folder' && kind !== 'folder') continue;

    let bucket = groupsMap.get(groupKey);
    if (!bucket) {
      bucket = createMetricBucket(groupKey, { kind, title: displayTitle, folderPath });
      groupsMap.set(groupKey, bucket);
    }
    accumulateTrackIntoBucket(bucket, track);
  }

  let collections = [];
  for (const b of groupsMap.values()) {
    const specificArtists = [...b.artistCounts.keys()].filter(
      (a) => !/^local studio artist$/i.test(a) && !/^unknown artist$/i.test(a)
    );
    const isCompilation = specificArtists.length > 2;
    const primaryArtist = isCompilation
      ? 'Various Artists'
      : specificArtists.length >= 1
        ? pickTopKeyFromMap(new Map(specificArtists.map((a) => [a, b.artistCounts.get(a) || 1])), specificArtists[0])
        : pickTopKeyFromMap(b.artistCounts, 'Local Studio Artist');

    const sortedTracks = [...b.tracks].sort((a, bTrack) =>
      String(a.title || '').localeCompare(String(bTrack.title || ''))
    );

    const albumObj = {
      id: b.id,
      kind: b.kind,
      title: b.title,
      artist: primaryArtist,
      artists: specificArtists.length ? specificArtists : [...b.artistCounts.keys()],
      isCompilation,
      year: pickTopKeyFromMap(b.yearCounts, ''),
      genre: pickTopKeyFromMap(b.genreCounts, ''),
      trackCount: sortedTracks.length,
      totalDurationSec: Math.round(b.totalDurationSec),
      avgBpm: b.bpmCount > 0 ? Math.round(b.bpmSum / b.bpmCount) : 0,
      avgStars: b.ratedCount > 0 ? Number((b.starSum / b.ratedCount).toFixed(1)) : 0,
      maxStars: b.maxStars,
      favoriteCount: b.favoriteCount,
      isLossless: b.isLossless,
      formats: [...b.formatSet],
      latestIso: b.latestIso,
      tracks: sortedTracks
    };

    if (query) {
      const hay = [
        albumObj.title,
        albumObj.artist,
        albumObj.genre,
        albumObj.year,
        ...albumObj.formats,
        ...sortedTracks.map((t) => `${t.title || ''} ${t.artist || ''}`)
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) continue;
    }

    collections.push(albumObj);
  }

  const sorters = {
    smart: (a, b) =>
      (a.kind === 'album' ? 0 : a.kind === 'folder' ? 1 : 2) -
        (b.kind === 'album' ? 0 : b.kind === 'folder' ? 1 : 2) ||
      b.trackCount - a.trackCount ||
      a.title.localeCompare(b.title),
    'title-asc': (a, b) => a.title.localeCompare(b.title),
    'artist-asc': (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    'tracks-desc': (a, b) => b.trackCount - a.trackCount || a.title.localeCompare(b.title),
    'rating-desc': (a, b) =>
      b.avgStars - a.avgStars || b.favoriteCount - a.favoriteCount || b.trackCount - a.trackCount,
    'recent-desc': (a, b) => String(b.latestIso || '').localeCompare(String(a.latestIso || '')) || a.title.localeCompare(b.title),
    'year-desc': (a, b) =>
      (Number(b.year) || 0) - (Number(a.year) || 0) || a.title.localeCompare(b.title)
  };

  collections.sort(sorters[sortBy] || sorters.smart);
  return collections;
}

const GENERIC_ARTIST_RE = /^(?:local studio artist|unknown artist|various artists)$/i;

/**
 * Builds structured Artist Collections with discography releases, genre summaries,
 * lossless detection, and curated sorting from catalog tracks.
 * @param {object[]} [tracks=[]] - Audio / #MusicVideo track pool.
 * @param {object} [options={}] - Grouping, filter, and sorting options.
 * @param {'all'|'multi'|'rated'} [options.mode='all'] - Artist filter mode.
 * @param {string} [options.query=''] - Search query matching artist, genre, album, or track titles.
 * @param {'curated'|'tracks-desc'|'name-asc'|'rating-desc'|'recent-desc'} [options.sortBy='curated'] - Sort order.
 * @returns {object[]} Sorted artist collection descriptors.
 */
export function buildArtistCollections(tracks = [], options = {}) {
  const mode = options.mode === 'multi' || options.mode === 'rated' ? options.mode : 'all';
  const query = String(options.query || '').trim().toLowerCase();
  const sortBy = options.sortBy || 'curated';

  const groupsMap = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track) continue;
    const rawArtist = String(track.artist || '').trim() || 'Unknown Artist';
    const key = `artist:${rawArtist.toLowerCase()}`;
    let bucket = groupsMap.get(key);
    if (!bucket) {
      bucket = createMetricBucket(key, {
        name: rawArtist,
        isGeneric: GENERIC_ARTIST_RE.test(rawArtist)
      });
      groupsMap.set(key, bucket);
    }
    accumulateTrackIntoBucket(bucket, track);
  }

  const artists = [];
  for (const b of groupsMap.values()) {
    const sortedTracks = [...b.tracks].sort((a, bTrack) =>
      String(a.title || '').localeCompare(String(bTrack.title || ''))
    );
    const releases = buildAlbumCollections(sortedTracks, { mode: 'all', sortBy: 'tracks-desc' });
    const topGenres = [...b.genreCounts.entries()]
      .sort((a, bG) => bG[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([g]) => g);

    const artistObj = {
      id: b.id,
      name: b.name,
      isGeneric: b.isGeneric,
      genres: topGenres,
      primaryGenre: topGenres[0] || '',
      trackCount: sortedTracks.length,
      releaseCount: releases.length,
      releases,
      totalDurationSec: Math.round(b.totalDurationSec),
      avgBpm: b.bpmCount > 0 ? Math.round(b.bpmSum / b.bpmCount) : 0,
      avgStars: b.ratedCount > 0 ? Number((b.starSum / b.ratedCount).toFixed(1)) : 0,
      maxStars: b.maxStars,
      favoriteCount: b.favoriteCount,
      isLossless: b.isLossless,
      formats: [...b.formatSet],
      latestIso: b.latestIso,
      tracks: sortedTracks
    };

    if (mode === 'multi' && artistObj.trackCount < 2) continue;
    if (mode === 'rated' && artistObj.avgStars <= 0 && artistObj.favoriteCount <= 0) continue;

    if (query) {
      const hay = [
        artistObj.name,
        ...artistObj.genres,
        ...artistObj.formats,
        ...releases.map((r) => r.title),
        ...sortedTracks.map((t) => t.title || '')
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) continue;
    }

    artists.push(artistObj);
  }

  const sorters = {
    curated: (a, b) =>
      Number(a.isGeneric) - Number(b.isGeneric) ||
      b.trackCount - a.trackCount ||
      b.avgStars - a.avgStars ||
      a.name.localeCompare(b.name),
    'tracks-desc': (a, b) => b.trackCount - a.trackCount || a.name.localeCompare(b.name),
    'name-asc': (a, b) => a.name.localeCompare(b.name),
    'rating-desc': (a, b) =>
      b.avgStars - a.avgStars || b.favoriteCount - a.favoriteCount || b.trackCount - a.trackCount,
    'recent-desc': (a, b) => String(b.latestIso || '').localeCompare(String(a.latestIso || '')) || a.name.localeCompare(b.name)
  };

  artists.sort(sorters[sortBy] || sorters.curated);
  return artists;
}

/**
 * Resolves the `#` column display indicator for a queue row ('▶', '⏸︎', or 1-based track index).
 * @param {object} state - Row and playback state.
 * @param {number} state.index - Zero-based row index.
 * @param {string|null} state.trackKey - Row track key (`filePath || id`).
 * @param {string|null} state.loadedKey - Currently loaded track key.
 * @param {boolean} state.isPlaying - Whether primary playback is active.
 * @param {string|null} state.pausedTrackKey - Key of explicitly paused track.
 * @param {boolean} [state.isSelected=false] - Whether row is currently selected.
 * @returns {string} Display text for the `#` column cell.
 */
export function resolveQueueRowNumIndicator({
  index,
  trackKey,
  loadedKey,
  isPlaying,
  pausedTrackKey,
  isSelected = false
}) {
  const matchesLoaded = Boolean(trackKey && loadedKey && trackKey === loadedKey);
  if ((matchesLoaded || isSelected) && isPlaying) {
    return '▶';
  }
  if ((matchesLoaded || isSelected) && !isPlaying && trackKey && pausedTrackKey === trackKey) {
    return '⏸\uFE0E';
  }
  return String(index + 1);
}

/**
 * Determines whether clicking a queue row should toggle Play/Pause on the loaded track
 * or select and start playing a new track.
 * @param {object} params - Click context.
 * @param {string|null} params.clickedKey - Clicked row track key.
 * @param {string|null} params.loadedKey - Currently loaded track key.
 * @returns {'toggle'|'select'} Action to perform.
 */
export function resolveRowClickAction({ clickedKey, loadedKey }) {
  if (clickedKey && loadedKey && clickedKey === loadedKey) {
    return 'toggle';
  }
  return 'select';
}
