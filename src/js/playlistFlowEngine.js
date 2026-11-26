/**
 * @fileoverview VANTA Playlist Flow Engine — Pure DAG Scheduler & Node Pipeline Evaluator.
 * Adapts Smarter Playlists' composable node-graph paradigm to VANTA's local/YouTube catalog,
 * Song DNA, Camelot Wheel harmonic compatibility, and saved Smart Playlists.
 * Zero DOM or Electron dependencies so the entire graph engine is deterministically unit-testable.
 */

import { CAMELOT_KEY_MAP, evaluateHarmonicCompatibility } from './mirAnalyzer.js';
import {
  applyProSmartFilter,
  buildVibeRadioQueue,
  isMusicVideoTagged,
  resolveMainGenre
} from './vibeRecommender.js';

const LOSSLESS_EXTENSIONS = new Set(['FLAC', 'WAV', 'W64', 'AIFF', 'AIF', 'ALAC', 'DSF', 'DFF', 'APE', 'WV']);

export const MAX_FLOW_NODES = 120;
export const MAX_FLOW_EDGES = 400;

export const FLOW_NODE_CATEGORIES = Object.freeze({
  source: { id: 'source', label: 'Sources', accent: '#38bdf8' },
  filter: { id: 'filter', label: 'Filters', accent: '#a78bfa' },
  combiner: { id: 'combiner', label: 'Combiners', accent: '#f472b6' },
  sorter: { id: 'sorter', label: 'Sorters & DJ', accent: '#fbbf24' },
  conditional: { id: 'conditional', label: 'Conditionals', accent: '#fb923c' },
  output: { id: 'output', label: 'Output', accent: '#4ade80' }
});

/**
 * Returns a stable canonical identity key for deduplicating and comparing tracks.
 * @param {object} track - Catalog track object.
 * @returns {string} Stable identity key.
 */
export function getTrackIdentityKey(track) {
  if (!track || typeof track !== 'object') return '';
  if (track.audioHash) return `hash:${String(track.audioHash).toLowerCase()}`;
  if (track.filePath) return `path:${String(track.filePath).replace(/\\/g, '/').toLowerCase()}`;
  if (track.id) return `id:${String(track.id)}`;
  return `meta:${String(track.title || '').toLowerCase()}::${String(track.artist || '').toLowerCase()}`;
}

function normalizePathForCompare(rawPath) {
  let clean = String(rawPath || '').trim().replace(/\\/g, '/').toLowerCase();
  while (clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
}

function extractParentFolderName(filePath) {
  const norm = normalizePathForCompare(filePath);
  const slashIdx = norm.lastIndexOf('/');
  if (slashIdx <= 0) return '';
  const dir = norm.slice(0, slashIdx);
  const prevSlash = dir.lastIndexOf('/');
  return prevSlash >= 0 ? dir.slice(prevSlash + 1) : dir;
}

function getCamelotNumber(keyOrCode) {
  const raw = String(keyOrCode || '').trim();
  const fromMap = CAMELOT_KEY_MAP[raw]?.code;
  const code = (fromMap || raw).toUpperCase();
  const match = /^(\d{1,2})([AB])$/.exec(code);
  return match ? Number(match[1]) : 8;
}

function getCircularCamelotDistance(keyA, keyB) {
  const n1 = getCamelotNumber(keyA);
  const n2 = getCamelotNumber(keyB);
  const diff = Math.abs(n1 - n2);
  return Math.min(diff, 12 - diff);
}

function isLosslessTrack(track) {
  const ext = String(track?.ext || '').trim().toUpperCase();
  return LOSSLESS_EXTENSIONS.has(ext) || Number(track?.bitDepth) >= 24;
}

function parseCsvList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean);
}

function deduplicateTrackList(tracks) {
  const seen = new Set();
  const out = [];
  for (const track of tracks) {
    const key = getTrackIdentityKey(track);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function shuffleWithRng(list, rng = Math.random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function spaceTracksByArtist(tracks, rng = Math.random) {
  if (tracks.length <= 2) return shuffleWithRng(tracks, rng);
  const buckets = new Map();
  for (const track of shuffleWithRng(tracks, rng)) {
    const artistKey = String(track.artist || 'unknown').trim().toLowerCase() || 'unknown';
    if (!buckets.has(artistKey)) buckets.set(artistKey, []);
    buckets.get(artistKey).push(track);
  }

  const ordered = [];
  let lastArtist = '';
  while (ordered.length < tracks.length) {
    let chosenKey = null;
    let maxRemaining = -1;
    for (const [key, group] of buckets.entries()) {
      if (!group.length) continue;
      if (key !== lastArtist && group.length > maxRemaining) {
        maxRemaining = group.length;
        chosenKey = key;
      }
    }
    if (!chosenKey) {
      for (const [key, group] of buckets.entries()) {
        if (group.length > 0) {
          chosenKey = key;
          break;
        }
      }
    }
    const nextTrack = buckets.get(chosenKey).shift();
    ordered.push(nextTrack);
    lastArtist = chosenKey;
  }
  return ordered;
}

function sequenceHarmonicJourney(tracks, curve = 'energy-up') {
  if (tracks.length <= 1) return [...tracks];
  const pool = [...tracks];
  const isEnergyDown = curve === 'energy-down';
  const isBpmUp = curve === 'bpm-up';

  pool.sort((a, b) => {
    if (isBpmUp) return (Number(a.bpm) || 124) - (Number(b.bpm) || 124);
    if (isEnergyDown) return (Number(b.energy) || 80) - (Number(a.energy) || 80);
    return (Number(a.energy) || 80) - (Number(b.energy) || 80);
  });

  const ordered = [pool.shift()];
  while (pool.length) {
    const prev = ordered[ordered.length - 1];
    const prevBpm = Number(prev.bpm) || 124;
    const prevEnergy = Number(prev.energy) || 80;
    const prevArtist = String(prev.artist || '').trim().toLowerCase();

    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const candBpm = Number(cand.bpm) || 124;
      const candEnergy = Number(cand.energy) || 80;
      const candArtist = String(cand.artist || '').trim().toLowerCase();

      const keyCost = getCircularCamelotDistance(prev.key, cand.key) * 18;
      let progressionPenalty = 0;
      if (isBpmUp) {
        progressionPenalty = candBpm < prevBpm ? (prevBpm - candBpm) * 2.2 : (candBpm - prevBpm) * 0.7;
      } else if (isEnergyDown) {
        progressionPenalty = candEnergy > prevEnergy ? (candEnergy - prevEnergy) * 1.8 : (prevEnergy - candEnergy) * 0.6;
      } else {
        progressionPenalty = candEnergy < prevEnergy ? (prevEnergy - candEnergy) * 1.8 : (candEnergy - prevEnergy) * 0.6;
      }
      const bpmJumpCost = Math.abs(candBpm - prevBpm) * 0.5;
      const artistPenalty = candArtist && candArtist === prevArtist ? 35 : 0;

      const total = keyCost + progressionPenalty + bpmJumpCost + artistPenalty;
      if (total < bestCost) {
        bestCost = total;
        bestIdx = i;
      }
    }
    ordered.push(pool.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

/**
 * Self-describing node registry powering both pure execution and Flow Studio Inspector UI.
 */
export const FLOW_NODE_REGISTRY = {
  // ---- SOURCES ----
  'source:all': {
    type: 'source:all',
    category: 'source',
    title: 'All Library',
    inputs: 0,
    outputs: 1,
    defaults: { pool: 'audio' },
    fields: [
      {
        key: 'pool',
        label: 'Catalog Scope',
        kind: 'select',
        options: [
          { value: 'audio', label: 'Audio + #MusicVideo' },
          { value: 'all', label: 'Entire Catalog (incl. Video)' },
          { value: 'videos', label: 'Videos Only' },
          { value: 'musicvideos', label: '#MusicVideo Only' }
        ]
      }
    ],
    summarize: (p) => ({
      audio: 'Audio + #MusicVideo',
      all: 'Full Catalog',
      videos: 'Videos Only',
      musicvideos: '#MusicVideo Only'
    }[p.pool] || 'Audio + #MusicVideo'),
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      if (p.pool === 'all') return [...cat];
      if (p.pool === 'videos') return cat.filter((t) => Boolean(t.isVideo));
      if (p.pool === 'musicvideos') return cat.filter((t) => isMusicVideoTagged(t));
      return cat.filter((t) => !t.isVideo || isMusicVideoTagged(t));
    }
  },

  'source:smart_playlist': {
    type: 'source:smart_playlist',
    category: 'source',
    title: 'Smart Playlist Ref',
    inputs: 0,
    outputs: 1,
    defaults: { playlistId: '' },
    fields: [
      { key: 'playlistId', label: 'Saved Smart Playlist / Flow', kind: 'smart_playlist_select' }
    ],
    summarize: (p, ctx) => {
      if (!p.playlistId) return 'Select a playlist…';
      const found = (ctx?.smartPlaylists || []).find((sp) => sp.id === p.playlistId);
      return found ? `Ref: "${found.name}"` : `Ref: ${p.playlistId}`;
    },
    execute: (p, _in, ctx) => {
      if (!p.playlistId) return [];
      if (typeof ctx.resolveSmartPlaylistTracks === 'function') {
        return ctx.resolveSmartPlaylistTracks(p.playlistId);
      }
      const target = (ctx.smartPlaylists || []).find((sp) => sp.id === p.playlistId);
      if (!target) return [];
      if (target.kind === 'flow') return [];
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      return applyProSmartFilter(cat, target.filters || {}, ctx.anchorTrack || cat[0] || null);
    }
  },

  'source:folder': {
    type: 'source:folder',
    category: 'source',
    title: 'Folder Source',
    inputs: 0,
    outputs: 1,
    defaults: { folderPath: '', includeSubfolders: true },
    fields: [
      { key: 'folderPath', label: 'Folder Path (or Vault Subfolder)', kind: 'folder_select' },
      { key: 'includeSubfolders', label: 'Include Subfolders', kind: 'checkbox' }
    ],
    summarize: (p) => {
      if (!p.folderPath) return 'Any Folder';
      const seg = String(p.folderPath).replace(/\\/g, '/').split('/').filter(Boolean).pop();
      return `Folder: ${seg || p.folderPath}`;
    },
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      const target = normalizePathForCompare(p.folderPath);
      if (!target) return [...cat];
      const includeSub = p.includeSubfolders !== false;
      return cat.filter((t) => {
        const fp = normalizePathForCompare(t.filePath);
        const dir = fp.includes('/') ? fp.slice(0, fp.lastIndexOf('/')) : '';
        if (!dir) return false;
        if (!includeSub) return dir === target;
        return dir === target || dir.startsWith(`${target}/`);
      });
    }
  },

  'source:album': {
    type: 'source:album',
    category: 'source',
    title: 'Album Source',
    inputs: 0,
    outputs: 1,
    defaults: { albumTitle: '' },
    fields: [
      { key: 'albumTitle', label: 'Album / Release Name', kind: 'album_select' }
    ],
    summarize: (p) => (p.albumTitle ? `Album: "${p.albumTitle}"` : 'Select an album…'),
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      const q = String(p.albumTitle || '').trim().toLowerCase();
      if (!q) return [];
      return cat.filter((t) => {
        const album = String(t.album || '').trim().toLowerCase();
        if (album && album === q) return true;
        if (!album && extractParentFolderName(t.filePath) === q) return true;
        return false;
      });
    }
  },

  'source:artist': {
    type: 'source:artist',
    category: 'source',
    title: 'Artist Source',
    inputs: 0,
    outputs: 1,
    defaults: { artistName: '', matchMode: 'exact' },
    fields: [
      { key: 'artistName', label: 'Artist Name', kind: 'artist_select' },
      {
        key: 'matchMode',
        label: 'Match Mode',
        kind: 'select',
        options: [
          { value: 'exact', label: 'Exact Artist Match' },
          { value: 'contains', label: 'Contains / Collaborations' }
        ]
      }
    ],
    summarize: (p) => (p.artistName ? `Artist: ${p.artistName}` : 'Select an artist…'),
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      const q = String(p.artistName || '').trim().toLowerCase();
      if (!q) return [];
      const contains = p.matchMode === 'contains';
      return cat.filter((t) => {
        const artist = String(t.artist || '').trim().toLowerCase();
        return contains ? artist.includes(q) : artist === q;
      });
    }
  },

  'source:vibe_radio': {
    type: 'source:vibe_radio',
    category: 'source',
    title: 'Vibe Radio Seed',
    inputs: 0,
    outputs: 1,
    defaults: { anchorMode: 'playing', anchorTrackKey: '', count: 12, includeSeed: false },
    fields: [
      {
        key: 'anchorMode',
        label: 'Anchor Source',
        kind: 'select',
        options: [
          { value: 'playing', label: 'Currently Playing / Active Track' },
          { value: 'track', label: 'Specific Catalog Track' }
        ]
      },
      { key: 'anchorTrackKey', label: 'Seed Track (when Specific)', kind: 'track_select' },
      { key: 'count', label: 'Max Similar Tracks', kind: 'number', min: 1, max: 200 },
      { key: 'includeSeed', label: 'Include Anchor Track', kind: 'checkbox' }
    ],
    summarize: (p) => (p.anchorMode === 'track' ? `Vibe Seed (${p.count})` : `Active Vibe (${p.count})`),
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      if (!cat.length) return [];
      let anchor = ctx.anchorTrack || cat[0];
      if (p.anchorMode === 'track' && p.anchorTrackKey) {
        const byKey = cat.find((t) => getTrackIdentityKey(t) === p.anchorTrackKey || t.filePath === p.anchorTrackKey || t.id === p.anchorTrackKey);
        if (byKey) anchor = byKey;
      }
      if (!anchor) return [];
      const anchorKey = getTrackIdentityKey(anchor);
      const ranked = buildVibeRadioQueue(anchor, cat, ctx.banditRewards || {});
      const filtered = p.includeSeed ? ranked : ranked.filter((t) => getTrackIdentityKey(t) !== anchorKey);
      return filtered.slice(0, Math.max(1, Number(p.count) || 12));
    }
  },

  'source:favorites': {
    type: 'source:favorites',
    category: 'source',
    title: 'Favorites & Rated',
    inputs: 0,
    outputs: 1,
    defaults: { favoritesOnly: true, minStars: 0 },
    fields: [
      { key: 'favoritesOnly', label: 'Hearted Favorites Only ♥', kind: 'checkbox' },
      {
        key: 'minStars',
        label: 'Minimum Star Rating',
        kind: 'select',
        parse: Number,
        options: [
          { value: '0', label: 'Any Rating' },
          { value: '3', label: '★★★ (3+)' },
          { value: '4', label: '★★★★ (4+)' },
          { value: '5', label: '★★★★★ (5)' }
        ]
      }
    ],
    summarize: (p) => {
      const parts = [];
      if (p.favoritesOnly) parts.push('♥ Favorites');
      if (Number(p.minStars) > 0) parts.push(`★${p.minStars}+`);
      return parts.join(' · ') || 'All Rated';
    },
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      const minStars = Number(p.minStars) || 0;
      const favOnly = Boolean(p.favoritesOnly);
      return cat.filter((t) => (!favOnly || Boolean(t.favorite)) && (Number(t.stars) || 0) >= minStars);
    }
  },

  'source:lossless': {
    type: 'source:lossless',
    category: 'source',
    title: 'Lossless Masters',
    inputs: 0,
    outputs: 1,
    defaults: { format: 'ALL_LOSSLESS' },
    fields: [
      {
        key: 'format',
        label: 'Lossless Format Scope',
        kind: 'select',
        options: [
          { value: 'ALL_LOSSLESS', label: 'All Lossless & Hi-Res (FLAC/WAV/DSD/ALAC)' },
          { value: 'FLAC', label: 'FLAC Only' },
          { value: 'WAV', label: 'WAV / W64 Only' },
          { value: 'DSD', label: 'DSD (DSF / DFF) Only' },
          { value: 'ALAC', label: 'Apple ALAC Only' }
        ]
      }
    ],
    summarize: (p) => (p.format === 'ALL_LOSSLESS' ? 'All Lossless Masters' : `${p.format} Only`),
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      const fmt = String(p.format || 'ALL_LOSSLESS').toUpperCase();
      if (fmt === 'ALL_LOSSLESS') return cat.filter(isLosslessTrack);
      if (fmt === 'WAV') return cat.filter((t) => ['WAV', 'W64'].includes(String(t.ext || '').toUpperCase()));
      if (fmt === 'DSD') return cat.filter((t) => ['DSF', 'DFF'].includes(String(t.ext || '').toUpperCase()));
      return cat.filter((t) => String(t.ext || '').toUpperCase() === fmt);
    }
  },

  'source:current_queue': {
    type: 'source:current_queue',
    category: 'source',
    title: 'Current Queue',
    inputs: 0,
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Active Queue Snapshot',
    execute: (_p, _in, ctx) => [...(Array.isArray(ctx.currentQueue) ? ctx.currentQueue : [])]
  },

  'source:recently_added': {
    type: 'source:recently_added',
    category: 'source',
    title: 'Recently Added',
    inputs: 0,
    outputs: 1,
    defaults: { withinDays: 30, limit: 30 },
    fields: [
      { key: 'withinDays', label: 'Added Within (Days)', kind: 'number', min: 1, max: 3650 },
      { key: 'limit', label: 'Max Tracks', kind: 'number', min: 1, max: 500 }
    ],
    summarize: (p) => `Last ${Math.max(1, Number(p.withinDays) || 30)} days (max ${Math.max(1, Number(p.limit) || 30)})`,
    execute: (p, _in, ctx) => {
      const cat = Array.isArray(ctx.catalog) ? ctx.catalog : [];
      const nowMs = (ctx.nowDate instanceof Date ? ctx.nowDate : new Date()).getTime();
      const days = Math.max(1, Number(p.withinDays) || 30);
      const cutoffMs = nowMs - days * 86400 * 1000;
      const lim = Math.max(1, Number(p.limit) || 30);
      return cat
        .map((t) => ({ track: t, ts: Date.parse(t.createdAt || t.modifiedAt || '') || 0 }))
        .filter((item) => item.ts >= cutoffMs)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, lim)
        .map((item) => item.track);
    }
  },

  // ---- FILTERS ----
  'filter:bpm': {
    type: 'filter:bpm',
    category: 'filter',
    title: 'BPM Range',
    inputs: 1,
    outputs: 1,
    defaults: { minBpm: 118, maxBpm: 132 },
    fields: [
      { key: 'minBpm', label: 'Min BPM', kind: 'number', min: 40, max: 240 },
      { key: 'maxBpm', label: 'Max BPM', kind: 'number', min: 40, max: 240 }
    ],
    summarize: (p) => `${p.minBpm || 40}–${p.maxBpm || 240} BPM`,
    execute: (p, [primary = []]) => {
      const rawMin = Number(p.minBpm) || 0;
      const rawMax = Number(p.maxBpm) || 300;
      const min = Math.min(rawMin, rawMax);
      const max = Math.max(rawMin, rawMax);
      return primary.filter((t) => {
        const bpm = Number(t.bpm) || 124;
        return bpm >= min && bpm <= max;
      });
    }
  },

  'filter:harmonic': {
    type: 'filter:harmonic',
    category: 'filter',
    title: 'Camelot Harmonic',
    inputs: 1,
    outputs: 1,
    defaults: { anchorMode: 'fixed', targetKey: 'A min', maxDistance: 1 },
    fields: [
      {
        key: 'anchorMode',
        label: 'Key Reference',
        kind: 'select',
        options: [
          { value: 'fixed', label: 'Selected Key' },
          { value: 'playing', label: 'Follow Playing Track' }
        ]
      },
      {
        key: 'targetKey',
        label: 'Musical / Camelot Key',
        kind: 'select',
        options: Object.entries(CAMELOT_KEY_MAP).map(([key, info]) => ({
          value: key,
          label: `${info.code} · ${key}`
        }))
      },
      {
        key: 'maxDistance',
        label: 'Camelot Tolerance',
        kind: 'select',
        parse: Number,
        options: [
          { value: '0', label: 'Exact Key Match (0)' },
          { value: '1', label: 'Harmonic Match (±1)' },
          { value: '2', label: 'Wide Harmonic (±2)' }
        ]
      }
    ],
    summarize: (p) => {
      const code = CAMELOT_KEY_MAP[p.targetKey]?.code || p.targetKey || '8A';
      return p.anchorMode === 'playing' ? `Playing Key ±${p.maxDistance ?? 1}` : `${code} ±${p.maxDistance ?? 1}`;
    },
    execute: (p, [primary = []], ctx) => {
      const refKey = p.anchorMode === 'playing' && ctx.anchorTrack?.key ? ctx.anchorTrack.key : (p.targetKey || 'A min');
      const maxDist = Number(p.maxDistance ?? 1);
      return primary.filter((t) => {
        if (maxDist === 1) {
          return evaluateHarmonicCompatibility(refKey, t.key || 'A min').compatible;
        }
        return getCircularCamelotDistance(refKey, t.key || 'A min') <= maxDist;
      });
    }
  },

  'filter:energy': {
    type: 'filter:energy',
    category: 'filter',
    title: 'Energy Band',
    inputs: 1,
    outputs: 1,
    defaults: { band: 'custom', minEnergy: 75, maxEnergy: 100 },
    fields: [
      {
        key: 'band',
        label: 'Preset Energy Band',
        kind: 'select',
        options: [
          { value: 'custom', label: 'Custom Min–Max (%)' },
          { value: 'low', label: 'Low (<75%)' },
          { value: 'mid', label: 'Mid (75–87%)' },
          { value: 'high', label: 'Peak (88%+)' }
        ]
      },
      { key: 'minEnergy', label: 'Min Energy (%)', kind: 'number', min: 0, max: 100 },
      { key: 'maxEnergy', label: 'Max Energy (%)', kind: 'number', min: 0, max: 100 }
    ],
    summarize: (p) => {
      if (p.band === 'low') return 'Low Energy (<75%)';
      if (p.band === 'mid') return 'Mid Energy (75–87%)';
      if (p.band === 'high') return 'Peak Energy (88%+)';
      return `Energy ${p.minEnergy ?? 0}%–${p.maxEnergy ?? 100}%`;
    },
    execute: (p, [primary = []]) => {
      let min = Number(p.minEnergy ?? 0);
      let max = Number(p.maxEnergy ?? 100);
      if (p.band === 'low') { min = 0; max = 74; }
      else if (p.band === 'mid') { min = 75; max = 87; }
      else if (p.band === 'high') { min = 88; max = 100; }
      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      return primary.filter((t) => {
        const e = Number(t.energy) || 80;
        return e >= lo && e <= hi;
      });
    }
  },

  'filter:genre': {
    type: 'filter:genre',
    category: 'filter',
    title: 'Genre Taxonomy',
    inputs: 1,
    outputs: 1,
    defaults: { genre: '' },
    fields: [
      { key: 'genre', label: 'Main Genre or Subgenre', kind: 'genre_select' }
    ],
    summarize: (p) => (p.genre ? `Genre: ${p.genre}` : 'Any Genre'),
    execute: (p, [primary = []]) => {
      const target = String(p.genre || '').trim().toLowerCase();
      if (!target) return [...primary];
      return primary.filter((t) => {
        const trackGenre = String(t.genre || '').trim().toLowerCase();
        const mainGenre = resolveMainGenre(t.genre).toLowerCase();
        return trackGenre === target || mainGenre === target || trackGenre.includes(target);
      });
    }
  },

  'filter:tags_groups': {
    type: 'filter:tags_groups',
    category: 'filter',
    title: 'Tags, Groups & Rating',
    inputs: 1,
    outputs: 1,
    defaults: { tagsCsv: '', groupsCsv: '', matchAll: false, minStars: 0, favoriteOnly: false, format: 'ALL' },
    fields: [
      { key: 'tagsCsv', label: 'Tags (comma-separated)', kind: 'text', placeholder: 'e.g. nightdrive, warmup' },
      { key: 'groupsCsv', label: 'Groups (comma-separated)', kind: 'text', placeholder: 'e.g. Set 1, Car Mix' },
      { key: 'matchAll', label: 'Require All Listed Tags/Groups', kind: 'checkbox' },
      {
        key: 'minStars',
        label: 'Minimum Rating',
        kind: 'select',
        parse: Number,
        options: [
          { value: '0', label: 'Any Rating' },
          { value: '3', label: '★★★ (3+)' },
          { value: '4', label: '★★★★ (4+)' },
          { value: '5', label: '★★★★★ (5)' }
        ]
      },
      { key: 'favoriteOnly', label: 'Favorites Only ♥', kind: 'checkbox' },
      {
        key: 'format',
        label: 'File Format',
        kind: 'select',
        options: [
          { value: 'ALL', label: 'All Formats' },
          { value: 'FLAC', label: 'FLAC' },
          { value: 'MP3', label: 'MP3' },
          { value: 'WAV', label: 'WAV' },
          { value: 'M4A', label: 'M4A / ALAC' }
        ]
      }
    ],
    summarize: (p) => {
      const bits = [];
      const tags = parseCsvList(p.tagsCsv);
      const groups = parseCsvList(p.groupsCsv);
      if (tags.length) bits.push(tags.map((t) => `#${t}`).join(','));
      if (groups.length) bits.push(`[${groups.join(',')}]`);
      if (Number(p.minStars) > 0) bits.push(`★${p.minStars}+`);
      if (p.favoriteOnly) bits.push('♥');
      if (p.format && p.format !== 'ALL') bits.push(p.format);
      return bits.join(' · ') || 'All Metadata';
    },
    execute: (p, [primary = []]) => {
      const reqTags = parseCsvList(p.tagsCsv);
      const reqGroups = parseCsvList(p.groupsCsv);
      const matchAll = Boolean(p.matchAll);
      const minStars = Number(p.minStars) || 0;
      const favOnly = Boolean(p.favoriteOnly);
      const fmt = String(p.format || 'ALL').toUpperCase();

      return primary.filter((t) => {
        if (favOnly && !t.favorite) return false;
        if ((Number(t.stars) || 0) < minStars) return false;
        if (fmt !== 'ALL' && String(t.ext || '').toUpperCase() !== fmt) return false;

        const tTags = (Array.isArray(t.tags) ? t.tags : []).map((x) => String(x).trim().toLowerCase());
        const tGroups = (Array.isArray(t.groups) ? t.groups : []).map((x) => String(x).trim().toLowerCase());

        if (reqTags.length) {
          const ok = matchAll
            ? reqTags.every((rt) => tTags.includes(rt))
            : reqTags.some((rt) => tTags.includes(rt));
          if (!ok) return false;
        }
        if (reqGroups.length) {
          const ok = matchAll
            ? reqGroups.every((rg) => tGroups.includes(rg))
            : reqGroups.some((rg) => tGroups.includes(rg));
          if (!ok) return false;
        }
        return true;
      });
    }
  },

  'filter:dedup_track': {
    type: 'filter:dedup_track',
    category: 'filter',
    title: 'Dedup Track',
    inputs: 1,
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Unique Track ID / Hash',
    execute: (_p, [primary = []]) => deduplicateTrackList(primary)
  },

  'filter:dedup_artist': {
    type: 'filter:dedup_artist',
    category: 'filter',
    title: 'Dedup Artist',
    inputs: 1,
    outputs: 1,
    defaults: { maxPerArtist: 1 },
    fields: [
      { key: 'maxPerArtist', label: 'Max Tracks Per Artist', kind: 'number', min: 1, max: 20 }
    ],
    summarize: (p) => `Max ${Math.max(1, Number(p.maxPerArtist) || 1)} / artist`,
    execute: (p, [primary = []]) => {
      const cap = Math.max(1, Number(p.maxPerArtist) || 1);
      const counts = new Map();
      return primary.filter((t) => {
        const artistKey = String(t.artist || '').trim().toLowerCase();
        if (!artistKey) return true;
        const next = (counts.get(artistKey) || 0) + 1;
        counts.set(artistKey, next);
        return next <= cap;
      });
    }
  },

  'filter:take': {
    type: 'filter:take',
    category: 'filter',
    title: 'Take / Limit',
    inputs: 1,
    outputs: 1,
    defaults: { mode: 'count', limit: 15, from: 'start' },
    fields: [
      {
        key: 'mode',
        label: 'Limit Mode',
        kind: 'select',
        reRenderInspector: true,
        options: [
          { value: 'count', label: 'Track Count' },
          { value: 'minutes', label: 'Max Duration (min)' }
        ]
      },
      { key: 'limit', label: 'Limit Value', kind: 'number', min: 1, max: 500 },
      {
        key: 'from',
        label: 'Sample From',
        kind: 'select',
        options: [
          { value: 'start', label: 'Beginning' },
          { value: 'end', label: 'End' },
          { value: 'random', label: 'Random Sample' }
        ]
      }
    ],
    summarize: (p) => {
      const lim = Math.max(1, Number(p.limit) || 1);
      if (p.mode === 'minutes') return `Cap at ${lim} min (${p.from || 'start'})`;
      return `Take ${lim} (${p.from || 'start'})`;
    },
    execute: (p, [primary = []], ctx) => {
      const lim = Math.max(1, Number(p.limit) || 1);
      let ordered = [...primary];
      if (p.from === 'end') ordered.reverse();
      else if (p.from === 'random') ordered = shuffleWithRng(ordered, ctx.rng || Math.random);

      if (p.mode === 'minutes') {
        const maxSec = lim * 60;
        const out = [];
        let acc = 0;
        for (const t of ordered) {
          const dur = Math.max(1, Number(t.durationSec) || 180);
          if (acc + dur <= maxSec || out.length === 0) {
            out.push(t);
            acc += dur;
          }
        }
        return out;
      }
      return ordered.slice(0, lim);
    }
  },

  'filter:year': {
    type: 'filter:year',
    category: 'filter',
    title: 'Release Year',
    inputs: 1,
    outputs: 1,
    defaults: { minYear: 2000, maxYear: 2026, includeUnknown: false },
    fields: [
      { key: 'minYear', label: 'Min Year', kind: 'number', min: 1900, max: 2100 },
      { key: 'maxYear', label: 'Max Year', kind: 'number', min: 1900, max: 2100 },
      { key: 'includeUnknown', label: 'Keep Tracks Missing Year', kind: 'checkbox' }
    ],
    summarize: (p) => `${p.minYear || 1900}–${p.maxYear || 2100}`,
    execute: (p, [primary = []]) => {
      const rawMin = Number(p.minYear) || 1900;
      const rawMax = Number(p.maxYear) || 2100;
      const min = Math.min(rawMin, rawMax);
      const max = Math.max(rawMin, rawMax);
      const keepUnknown = Boolean(p.includeUnknown);
      return primary.filter((t) => {
        const m = /\b(19\d{2}|20\d{2})\b/.exec(String(t.year || ''));
        if (!m) return keepUnknown;
        const yr = Number(m[1]);
        return yr >= min && yr <= max;
      });
    }
  },

  'filter:exclude_played': {
    type: 'filter:exclude_played',
    category: 'filter',
    title: 'Exclude Played / Skipped',
    inputs: 1,
    outputs: 1,
    defaults: { mode: 'both', recentWindow: 20 },
    fields: [
      {
        key: 'mode',
        label: 'Exclusion Mode',
        kind: 'select',
        options: [
          { value: 'both', label: 'Recently Played & Skipped' },
          { value: 'played', label: 'Recently Played Only' },
          { value: 'skipped', label: 'Skipped / Low Bandit Only' }
        ]
      },
      { key: 'recentWindow', label: 'Recent Play Window', kind: 'number', min: 1, max: 100 }
    ],
    summarize: (p) => ({
      both: `Skip Played (${p.recentWindow || 20}) & Skipped`,
      played: `Exclude Last ${p.recentWindow || 20} Played`,
      skipped: 'Exclude Skipped Tracks'
    }[p.mode] || 'Exclude Played / Skipped'),
    execute: (p, [primary = []], ctx) => {
      const mode = p.mode || 'both';
      const checkPlayed = mode === 'both' || mode === 'played';
      const checkSkipped = mode === 'both' || mode === 'skipped';
      const win = Math.max(1, Number(p.recentWindow) || 20);
      const history = Array.isArray(ctx.playbackHistory) ? ctx.playbackHistory.slice(-win) : [];
      const playedSet = new Set();
      for (const h of history) {
        const k = typeof h === 'string' ? h : (h?.key || h?.filePath || h?.id || '');
        if (k) playedSet.add(String(k).replace(/\\/g, '/').toLowerCase());
      }
      const rewards = ctx.banditRewards && typeof ctx.banditRewards === 'object' ? ctx.banditRewards : {};

      return primary.filter((t) => {
        if (checkPlayed) {
          const candidates = [t.filePath, t.id, getTrackIdentityKey(t)]
            .filter(Boolean)
            .map((v) => String(v).replace(/\\/g, '/').toLowerCase());
          if (candidates.some((c) => playedSet.has(c))) return false;
        }
        if (checkSkipped) {
          const reward = Number(rewards[t.id] ?? rewards[t.filePath] ?? 0);
          if (reward < 0) return false;
        }
        return true;
      });
    }
  },

  'filter:format_tier': {
    type: 'filter:format_tier',
    category: 'filter',
    title: 'Format & Quality Tier',
    inputs: 1,
    outputs: 1,
    defaults: { tier: 'lossless_only' },
    fields: [
      {
        key: 'tier',
        label: 'Audio Quality Scope',
        kind: 'select',
        options: [
          { value: 'lossless_only', label: 'Lossless & Hi-Res Only' },
          { value: 'hires_24bit', label: '24-Bit / DSD Studio Master Only' },
          { value: 'lossy_only', label: 'Compressed Only (MP3 / AAC / OGG)' }
        ]
      }
    ],
    summarize: (p) => ({
      lossless_only: 'Lossless & Hi-Res',
      hires_24bit: '24-Bit / DSD Master',
      lossy_only: 'Lossy (MP3 / AAC)'
    }[p.tier] || 'Lossless & Hi-Res'),
    execute: (p, [primary = []]) => {
      const tier = p.tier || 'lossless_only';
      if (tier === 'hires_24bit') {
        return primary.filter((t) => Number(t.bitDepth) >= 24 || ['DSF', 'DFF'].includes(String(t.ext || '').toUpperCase()));
      }
      if (tier === 'lossy_only') {
        return primary.filter((t) => !isLosslessTrack(t) && !t.isVideo);
      }
      return primary.filter(isLosslessTrack);
    }
  },

  // ---- COMBINERS ----
  'combiner:concat': {
    type: 'combiner:concat',
    category: 'combiner',
    title: 'Concatenate (A + B)',
    inputs: 2,
    inputLabels: ['A', 'B'],
    outputs: 1,
    defaults: { deduplicate: true },
    fields: [
      { key: 'deduplicate', label: 'Remove Duplicate Tracks', kind: 'checkbox' }
    ],
    summarize: (p) => (p.deduplicate !== false ? 'Append A + B (Unique)' : 'Append A + B'),
    execute: (p, [a = [], b = []]) => {
      const merged = [...a, ...b];
      return p.deduplicate !== false ? deduplicateTrackList(merged) : merged;
    }
  },

  'combiner:zip': {
    type: 'combiner:zip',
    category: 'combiner',
    title: 'Alternate / Zip',
    inputs: 2,
    inputLabels: ['A', 'B'],
    outputs: 1,
    defaults: { ratioA: 2, ratioB: 1, deduplicate: true },
    fields: [
      { key: 'ratioA', label: 'Stream A Ratio', kind: 'number', min: 1, max: 10 },
      { key: 'ratioB', label: 'Stream B Ratio', kind: 'number', min: 1, max: 10 },
      { key: 'deduplicate', label: 'Skip Already Added Tracks', kind: 'checkbox' }
    ],
    summarize: (p) => `Interleave ${p.ratioA || 1}:${p.ratioB || 1}`,
    execute: (p, [a = [], b = []]) => {
      const rA = Math.max(1, Number(p.ratioA) || 1);
      const rB = Math.max(1, Number(p.ratioB) || 1);
      const dedup = p.deduplicate !== false;
      const out = [];
      const seen = new Set();
      let i = 0;
      let j = 0;

      const pushTrack = (t) => {
        const key = getTrackIdentityKey(t);
        if (dedup && (!key || seen.has(key))) return;
        if (key) seen.add(key);
        out.push(t);
      };

      while (i < a.length || j < b.length) {
        for (let k = 0; k < rA && i < a.length; k++) pushTrack(a[i++]);
        for (let k = 0; k < rB && j < b.length; k++) pushTrack(b[j++]);
      }
      return out;
    }
  },

  'combiner:union': {
    type: 'combiner:union',
    category: 'combiner',
    title: 'Union (A ∪ B)',
    inputs: 2,
    inputLabels: ['A', 'B'],
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Unique Union of A & B',
    execute: (_p, [a = [], b = []]) => deduplicateTrackList([...a, ...b])
  },

  'combiner:intersect': {
    type: 'combiner:intersect',
    category: 'combiner',
    title: 'Intersect (A ∩ B)',
    inputs: 2,
    inputLabels: ['A', 'B'],
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Tracks in Both A & B',
    execute: (_p, [a = [], b = []]) => {
      const bSet = new Set(b.map(getTrackIdentityKey));
      return deduplicateTrackList(a.filter((t) => bSet.has(getTrackIdentityKey(t))));
    }
  },

  'combiner:subtract': {
    type: 'combiner:subtract',
    category: 'combiner',
    title: 'Subtract (A − B)',
    inputs: 2,
    inputLabels: ['A', 'B'],
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Exclude Stream B from A',
    execute: (_p, [a = [], b = []]) => {
      const bSet = new Set(b.map(getTrackIdentityKey));
      return a.filter((t) => !bSet.has(getTrackIdentityKey(t)));
    }
  },

  // ---- SORTERS & DJ SHAPERS ----
  'sorter:field': {
    type: 'sorter:field',
    category: 'sorter',
    title: 'Sort Tracks',
    inputs: 1,
    outputs: 1,
    defaults: { sortBy: 'bpm-asc' },
    fields: [
      {
        key: 'sortBy',
        label: 'Sort Criterion',
        kind: 'select',
        options: [
          { value: 'bpm-asc', label: 'BPM ↑' },
          { value: 'bpm-desc', label: 'BPM ↓' },
          { value: 'key-asc', label: 'Camelot Key ↑' },
          { value: 'key-desc', label: 'Camelot Key ↓' },
          { value: 'energy-desc', label: 'Energy % ↓' },
          { value: 'stars-desc', label: 'Rating ★ ↓' },
          { value: 'title-asc', label: 'Title A–Z' },
          { value: 'artist-asc', label: 'Artist A–Z' },
          { value: 'time-asc', label: 'Duration ↑' },
          { value: 'time-desc', label: 'Duration ↓' },
          { value: 'created-desc', label: 'Recently Added ↓' }
        ]
      }
    ],
    summarize: (p) => `Sort: ${p.sortBy || 'bpm-asc'}`,
    execute: (p, [primary = []]) => applyProSmartFilter(primary, { sortBy: p.sortBy || 'bpm-asc' })
  },

  'sorter:harmonic_journey': {
    type: 'sorter:harmonic_journey',
    category: 'sorter',
    title: 'Harmonic Journey',
    inputs: 1,
    outputs: 1,
    defaults: { curve: 'energy-up' },
    fields: [
      {
        key: 'curve',
        label: 'DJ Progression Curve',
        kind: 'select',
        options: [
          { value: 'energy-up', label: 'Camelot + Rising Energy (Warmup → Peak)' },
          { value: 'bpm-up', label: 'Camelot + Rising Tempo (BPM ↑)' },
          { value: 'energy-down', label: 'Camelot + Cooldown (Energy ↓)' }
        ]
      }
    ],
    summarize: (p) => ({
      'energy-up': 'Camelot + Energy ↑',
      'bpm-up': 'Camelot + BPM ↑',
      'energy-down': 'Camelot + Cooldown ↓'
    }[p.curve] || 'Camelot + Energy ↑'),
    execute: (p, [primary = []]) => sequenceHarmonicJourney(primary, p.curve || 'energy-up')
  },

  'sorter:artist_spaced_shuffle': {
    type: 'sorter:artist_spaced_shuffle',
    category: 'sorter',
    title: 'Artist-Spaced Shuffle',
    inputs: 1,
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Shuffle Without Artist Clumps',
    execute: (_p, [primary = []], ctx) => spaceTracksByArtist(primary, ctx.rng || Math.random)
  },

  'sorter:reverse': {
    type: 'sorter:reverse',
    category: 'sorter',
    title: 'Reverse Stream',
    inputs: 1,
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Reverse Track Order',
    execute: (_p, [primary = []]) => [...primary].reverse()
  },

  'sorter:format_priority': {
    type: 'sorter:format_priority',
    category: 'sorter',
    title: 'Format Priority',
    inputs: 1,
    outputs: 1,
    defaults: { preference: 'lossless_first' },
    fields: [
      {
        key: 'preference',
        label: 'Format Order',
        kind: 'select',
        options: [
          { value: 'lossless_first', label: 'Lossless & Hi-Res First' },
          { value: 'hires_first', label: 'DSD / 24-Bit Master First' },
          { value: 'lossy_first', label: 'Compact (MP3 / M4A) First' }
        ]
      }
    ],
    summarize: (p) => ({
      lossless_first: 'Lossless First',
      hires_first: 'Hi-Res / DSD First',
      lossy_first: 'Compact Formats First'
    }[p.preference] || 'Lossless First'),
    execute: (p, [primary = []]) => {
      const pref = p.preference || 'lossless_first';
      const score = (t) => {
        const ext = String(t.ext || '').toUpperCase();
        const isDsd = ext === 'DSF' || ext === 'DFF';
        const isHiRes = isDsd || Number(t.bitDepth) >= 24;
        const isLossless = isLosslessTrack(t);
        if (pref === 'hires_first') return isDsd ? 3 : isHiRes ? 2 : isLossless ? 1 : 0;
        if (pref === 'lossy_first') return isLossless ? 0 : 2;
        return isHiRes ? 2 : isLossless ? 1 : 0;
      };
      return primary
        .map((t, idx) => ({ t, idx, s: score(t) }))
        .sort((a, b) => b.s - a.s || a.idx - b.idx)
        .map((x) => x.t);
    }
  },

  // ---- CONDITIONALS ----
  'conditional:if_min_count': {
    type: 'conditional:if_min_count',
    category: 'conditional',
    title: 'If Count ≥ N',
    inputs: 2,
    inputLabels: ['Primary', 'Fallback'],
    outputs: 1,
    defaults: { minCount: 5 },
    fields: [
      { key: 'minCount', label: 'Minimum Tracks in Primary (A)', kind: 'number', min: 1, max: 500 }
    ],
    summarize: (p) => `Use A if ≥${Math.max(1, Number(p.minCount) || 1)}, else B`,
    execute: (p, [a = [], b = []]) => {
      const min = Math.max(1, Number(p.minCount) || 1);
      return a.length >= min ? [...a] : [...b];
    }
  },

  'conditional:if_empty': {
    type: 'conditional:if_empty',
    category: 'conditional',
    title: 'If Empty Fallback',
    inputs: 2,
    inputLabels: ['Primary', 'Fallback'],
    outputs: 1,
    defaults: {},
    fields: [],
    summarize: () => 'Use A if non-empty, else B',
    execute: (_p, [a = [], b = []]) => (a.length > 0 ? [...a] : [...b])
  },

  'conditional:time_of_day': {
    type: 'conditional:time_of_day',
    category: 'conditional',
    title: 'Time of Day Branch',
    inputs: 2,
    inputLabels: ['Day (A)', 'Night (B)'],
    outputs: 1,
    defaults: { dayStartHour: 6, nightStartHour: 19, overrideHour: '' },
    fields: [
      { key: 'dayStartHour', label: 'Day Window Start (0–23)', kind: 'number', min: 0, max: 23 },
      { key: 'nightStartHour', label: 'Night Window Start (0–23)', kind: 'number', min: 0, max: 23 },
      { key: 'overrideHour', label: 'Preview Hour Override (optional 0–23)', kind: 'text', placeholder: 'Leave blank for local clock' }
    ],
    summarize: (p) => `Day ${p.dayStartHour ?? 6}:00–${p.nightStartHour ?? 19}:00 → A, else B`,
    execute: (p, [dayStream = [], nightStream = []], ctx) => {
      const rawOverride = String(p.overrideHour ?? '').trim();
      const now = ctx.nowDate instanceof Date ? ctx.nowDate : new Date();
      const hour = rawOverride !== '' && Number.isFinite(Number(rawOverride))
        ? Math.max(0, Math.min(23, Math.floor(Number(rawOverride))))
        : now.getHours();
      const dayStart = Math.max(0, Math.min(23, Number(p.dayStartHour ?? 6)));
      const nightStart = Math.max(0, Math.min(23, Number(p.nightStartHour ?? 19)));
      const isDay = dayStart < nightStart
        ? (hour >= dayStart && hour < nightStart)
        : (hour >= dayStart || hour < nightStart);
      return isDay ? [...dayStream] : [...nightStream];
    }
  },

  // ---- OUTPUT ----
  'output:playlist': {
    type: 'output:playlist',
    category: 'output',
    title: 'VANTA Playlist Output',
    inputs: 1,
    outputs: 0,
    defaults: { dedupOutput: false },
    fields: [
      { key: 'dedupOutput', label: 'Deduplicate Final Output', kind: 'checkbox' }
    ],
    summarize: (p) => (p.dedupOutput ? 'Final Queue (Deduplicated)' : 'Final Playlist Queue'),
    execute: (p, [primary = []]) => (p.dedupOutput ? deduplicateTrackList(primary) : [...primary])
  }
};

/**
 * Built-in starter Flow Templates users can load into the Studio canvas in one click.
 */
export const FLOW_PRESET_TEMPLATES = [
  {
    key: 'night-drive',
    name: 'Night Drive Peak-Hour Mix',
    description: 'Interleave 2:1 Lossless 118–132 BPM with Vibe Radio, deduplicate artists, and sequence harmonically',
    visual: { mode: 'auto', presetKey: 'night', imagePath: '' },
    graph: {
      nodes: {
        n1: { id: 'n1', type: 'source:lossless', x: 24, y: 28, params: { format: 'ALL_LOSSLESS' } },
        n2: { id: 'n2', type: 'source:vibe_radio', x: 24, y: 144, params: { anchorMode: 'playing', anchorTrackKey: '', count: 12, includeSeed: false } },
        n3: { id: 'n3', type: 'filter:bpm', x: 266, y: 28, params: { minBpm: 118, maxBpm: 132 } },
        n4: { id: 'n4', type: 'combiner:zip', x: 508, y: 84, params: { ratioA: 2, ratioB: 1, deduplicate: true } },
        n5: { id: 'n5', type: 'filter:dedup_artist', x: 24, y: 318, params: { maxPerArtist: 1 } },
        n6: { id: 'n6', type: 'sorter:harmonic_journey', x: 266, y: 318, params: { curve: 'energy-up' } },
        n7: { id: 'n7', type: 'filter:take', x: 508, y: 318, params: { mode: 'count', limit: 20, from: 'start' } },
        n8: { id: 'n8', type: 'output:playlist', x: 750, y: 318, params: { dedupOutput: true } }
      },
      edges: [
        ['n1', 'n3'],
        ['n3', 'n4'],
        ['n2', 'n4'],
        ['n4', 'n5'],
        ['n5', 'n6'],
        ['n6', 'n7'],
        ['n7', 'n8']
      ]
    }
  },
  {
    key: 'focus-sanctuary',
    name: 'Focus Sanctuary (Subtract Peak)',
    description: 'Subtract high-energy tracks from library, fallback to Favorites if sparse, sort by BPM ascending',
    visual: { mode: 'auto', presetKey: 'chill', imagePath: '' },
    graph: {
      nodes: {
        f1: { id: 'f1', type: 'source:all', x: 24, y: 32, params: { pool: 'audio' } },
        f2: { id: 'f2', type: 'filter:energy', x: 266, y: 128, params: { band: 'high', minEnergy: 88, maxEnergy: 100 } },
        f3: { id: 'f3', type: 'combiner:subtract', x: 508, y: 68, params: {} },
        f4: { id: 'f4', type: 'source:favorites', x: 24, y: 318, params: { favoritesOnly: true, minStars: 4 } },
        f5: { id: 'f5', type: 'conditional:if_min_count', x: 274, y: 318, params: { minCount: 4 } },
        f6: { id: 'f6', type: 'sorter:field', x: 516, y: 318, params: { sortBy: 'bpm-asc' } },
        f7: { id: 'f7', type: 'output:playlist', x: 758, y: 318, params: { dedupOutput: true } }
      },
      edges: [
        ['f1', 'f3', 0],
        ['f1', 'f2'],
        ['f2', 'f3', 1],
        ['f3', 'f5', 0],
        ['f4', 'f5', 1],
        ['f5', 'f6'],
        ['f6', 'f7']
      ]
    }
  },
  {
    key: 'harmonic-45m',
    name: 'Harmonic 45-Minute Set',
    description: 'Filter Harmonic Match tracks, arrange by Camelot progression, and cap total runtime to 45 minutes',
    visual: { mode: 'auto', presetKey: 'peak', imagePath: '' },
    graph: {
      nodes: {
        h1: { id: 'h1', type: 'source:all', x: 24, y: 52, params: { pool: 'audio' } },
        h2: { id: 'h2', type: 'filter:harmonic', x: 266, y: 52, params: { anchorMode: 'playing', targetKey: 'A min', maxDistance: 1 } },
        h3: { id: 'h3', type: 'sorter:harmonic_journey', x: 508, y: 52, params: { curve: 'bpm-up' } },
        h4: { id: 'h4', type: 'filter:take', x: 144, y: 268, params: { mode: 'minutes', limit: 45, from: 'start' } },
        h5: { id: 'h5', type: 'output:playlist', x: 388, y: 268, params: { dedupOutput: true } }
      },
      edges: [
        ['h1', 'h2'],
        ['h2', 'h3'],
        ['h3', 'h4'],
        ['h4', 'h5']
      ]
    }
  }
];

/**
 * Builds a level-based topological execution schedule for a DAG flow graph.
 * Detects cycles and missing/malformed node links cleanly.
 * @param {Record<string, object>} nodes - Map of nodeId -> node descriptor.
 * @param {Array<[string, string]>} edges - Directed `[srcId, dstId]` edge pairs.
 * @returns {{ ok: boolean, hasCycle: boolean, schedule: string[][], error: string }}
 */
export function buildFlowSchedule(nodes = {}, edges = []) {
  const safeNodes = nodes && typeof nodes === 'object' ? nodes : {};
  const nodeIds = Object.keys(safeNodes);
  if (!nodeIds.length) {
    return { ok: true, hasCycle: false, schedule: [], error: '' };
  }

  const adj = new Map();
  const inDegree = new Map();
  for (const id of nodeIds) {
    adj.set(id, []);
    inDegree.set(id, 0);
  }

  const seenEdges = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!Array.isArray(edge) || edge.length < 2) continue;
    const src = String(edge[0] || '');
    const dst = String(edge[1] || '');
    if (!Object.hasOwn(safeNodes, src) || !Object.hasOwn(safeNodes, dst)) continue;
    if (src === dst) {
      return { ok: false, hasCycle: true, schedule: [], error: `Self-loop detected on node "${src}"` };
    }
    const edgeKey = `${src}->${dst}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    adj.get(src).push(dst);
    inDegree.set(dst, (inDegree.get(dst) || 0) + 1);
  }

  const schedule = [];
  let currentBatch = nodeIds.filter((id) => inDegree.get(id) === 0);
  let scheduledCount = 0;

  while (currentBatch.length > 0) {
    schedule.push(currentBatch);
    scheduledCount += currentBatch.length;
    const nextBatch = [];
    for (const u of currentBatch) {
      for (const v of adj.get(u) || []) {
        const nextDeg = (inDegree.get(v) || 0) - 1;
        inDegree.set(v, nextDeg);
        if (nextDeg === 0) nextBatch.push(v);
      }
    }
    currentBatch = nextBatch;
  }

  if (scheduledCount !== nodeIds.length) {
    return {
      ok: false,
      hasCycle: true,
      schedule: [],
      error: 'Cycle detected in flow graph — disconnect cyclic wires to continue.'
    };
  }

  return { ok: true, hasCycle: false, schedule, error: '' };
}

/**
 * Detects whether referencing `targetPlaylistId` from `rootFlowId` creates a cross-playlist cycle.
 * @param {string} rootFlowId - Current flow playlist ID.
 * @param {string} targetPlaylistId - Referenced Smart Playlist / Flow ID.
 * @param {object[]} smartPlaylists - All saved smart playlists.
 * @returns {boolean} True when reference would form a cycle.
 */
export function hasPlaylistReferenceCycle(rootFlowId, targetPlaylistId, smartPlaylists = []) {
  if (!rootFlowId || !targetPlaylistId) return false;
  if (rootFlowId === targetPlaylistId) return true;

  const byId = new Map((Array.isArray(smartPlaylists) ? smartPlaylists : []).map((p) => [p.id, p]));
  const visited = new Set([rootFlowId]);
  const stack = [targetPlaylistId];

  while (stack.length > 0) {
    const currId = stack.pop();
    if (visited.has(currId)) return true;
    visited.add(currId);
    const curr = byId.get(currId);
    if (!curr || curr.kind !== 'flow' || !curr.graph?.nodes) continue;
    for (const node of Object.values(curr.graph.nodes)) {
      if (node?.type === 'source:smart_playlist' && node?.params?.playlistId) {
        stack.push(String(node.params.playlistId));
      }
    }
  }

  return false;
}

/**
 * Validates a flow graph structurally (edge cycles, unknown node types, and Smart Playlist ref cycles).
 * @param {object} flow - `{ id, graph: { nodes, edges } }`.
 * @param {object} [context={}] - `{ smartPlaylists }`.
 * @returns {{ valid: boolean, hasCycle: boolean, schedule: string[][], errors: string[] }}
 */
export function validateFlowGraph(flow = {}, context = {}) {
  const graph = flow?.graph || {};
  const nodes = graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : {};
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const errors = [];

  const sched = buildFlowSchedule(nodes, edges);
  if (sched.hasCycle) {
    errors.push(sched.error);
  }

  const allPlaylists = Array.isArray(context.smartPlaylists) ? context.smartPlaylists : [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    const def = FLOW_NODE_REGISTRY[node?.type];
    if (!def) {
      errors.push(`Unknown node type "${node?.type}" on #${nodeId}`);
      continue;
    }
    if (node.type === 'source:smart_playlist' && node.params?.playlistId && flow?.id) {
      if (hasPlaylistReferenceCycle(flow.id, node.params.playlistId, allPlaylists)) {
        errors.push(`Circular Smart Playlist reference on #${nodeId}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    hasCycle: sched.hasCycle,
    schedule: sched.schedule,
    errors
  };
}

/**
 * Executes a DAG playlist flow over VANTA's track catalog and returns per-node streams plus final output.
 * @param {object} flow - Flow playlist object `{ id, name, graph: { nodes, edges } }`.
 * @param {object} [context={}] - Execution context `{ catalog, anchorTrack, banditRewards, currentQueue, smartPlaylists, nowDate, rng, visitedFlowIds }`.
 * @returns {{ ok: boolean, hasCycle: boolean, schedule: string[][], nodeResults: Map<string, object[]>, nodeErrors: Map<string, string>, outputNodeId: string|null, outputTracks: object[], error: string }}
 */
export function executeFlowGraph(flow = {}, context = {}) {
  const graph = flow?.graph || {};
  const nodes = graph.nodes && typeof graph.nodes === 'object' ? graph.nodes : {};
  const edges = Array.isArray(graph.edges) ? graph.edges : [];

  const sched = buildFlowSchedule(nodes, edges);
  const nodeResults = new Map();
  const nodeErrors = new Map();

  if (sched.hasCycle) {
    return {
      ok: false,
      hasCycle: true,
      schedule: [],
      nodeResults,
      nodeErrors,
      outputNodeId: null,
      outputTracks: [],
      error: sched.error
    };
  }

  const visitedFlowIds = new Set(context.visitedFlowIds || []);
  if (flow?.id) visitedFlowIds.add(flow.id);

  const safeContext = {
    catalog: Array.isArray(context.catalog) ? context.catalog : [],
    anchorTrack: context.anchorTrack || null,
    banditRewards: context.banditRewards || {},
    playbackHistory: Array.isArray(context.playbackHistory) ? context.playbackHistory : [],
    currentQueue: Array.isArray(context.currentQueue) ? context.currentQueue : [],
    smartPlaylists: Array.isArray(context.smartPlaylists) ? context.smartPlaylists : [],
    nowDate: context.nowDate instanceof Date ? context.nowDate : new Date(),
    rng: typeof context.rng === 'function' ? context.rng : Math.random,
    visitedFlowIds,
    resolveSmartPlaylistTracks: (playlistId) => {
      if (!playlistId) return [];
      if (visitedFlowIds.has(playlistId)) {
        throw new Error(`Circular playlist reference detected for "${playlistId}"`);
      }
      const target = (safeContext.smartPlaylists || []).find((p) => p.id === playlistId);
      if (!target) return [];
      if (target.kind === 'flow') {
        const sub = executeFlowGraph(target, { ...safeContext, visitedFlowIds: new Set(visitedFlowIds) });
        return sub.outputTracks || [];
      }
      return applyProSmartFilter(
        safeContext.catalog,
        target.filters || {},
        safeContext.anchorTrack || safeContext.catalog[0] || null
      );
    }
  };

  for (const batch of sched.schedule) {
    for (const nodeId of batch) {
      const node = nodes[nodeId];
      const def = FLOW_NODE_REGISTRY[node?.type];
      if (!def) {
        nodeErrors.set(nodeId, `Unknown component type: ${node?.type}`);
        nodeResults.set(nodeId, []);
        continue;
      }

      const incomingEdges = edges.filter((e) => Array.isArray(e) && e[1] === nodeId);
      const incomingStreams = [];
      const unslotted = [];
      for (const edge of incomingEdges) {
        const stream = nodeResults.get(edge[0]) || [];
        const slot = edge.length >= 3 && (edge[2] === 0 || edge[2] === 1) ? edge[2] : null;
        if (slot !== null && incomingStreams[slot] === undefined) {
          incomingStreams[slot] = stream;
        } else {
          unslotted.push(stream);
        }
      }
      let nextSlot = 0;
      for (const stream of unslotted) {
        while (incomingStreams[nextSlot] !== undefined) nextSlot++;
        incomingStreams[nextSlot] = stream;
        nextSlot++;
      }
      const params = { ...def.defaults, ...(node.params || {}) };

      try {
        const result = def.execute(params, incomingStreams, safeContext);
        nodeResults.set(nodeId, Array.isArray(result) ? result : []);
      } catch (err) {
        nodeErrors.set(nodeId, err?.message || 'Node execution failed');
        nodeResults.set(nodeId, []);
      }
    }
  }

  const outputNode = Object.values(nodes).find((n) => n?.type === 'output:playlist') || null;
  let outputNodeId = outputNode ? outputNode.id : null;
  if (!outputNodeId && sched.schedule.length > 0) {
    const lastBatch = sched.schedule[sched.schedule.length - 1];
    outputNodeId = lastBatch[lastBatch.length - 1] || null;
  }

  return {
    ok: nodeErrors.size === 0,
    hasCycle: false,
    schedule: sched.schedule,
    nodeResults,
    nodeErrors,
    outputNodeId,
    outputTracks: outputNodeId ? (nodeResults.get(outputNodeId) || []) : [],
    error: nodeErrors.size ? Array.from(nodeErrors.values())[0] : ''
  };
}
