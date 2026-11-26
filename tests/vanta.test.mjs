import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  VantaAudioEngine,
  EQ_FREQUENCIES,
  EQ_PRESETS,
  DEVICE_EQ_PROFILES,
  buildTubeSaturationCurve,
  computeEqualPowerCrossfade,
  computeMidSideSpatialGains,
  computeBauerCrossfeedParams,
  computeSubBassCurveParams,
  buildSignalPathDescriptor,
  computeWasapiGainFactor,
  resolveStartupAudioPrefs,
  resolveReplayGain2
} from '../src/js/audioEngine.js';
import { VISUALIZER_MODES } from '../src/js/visualizer.js';
import {
  estimateBpmFromPcm,
  evaluateHarmonicCompatibility,
  computeSongDna
} from '../src/js/mirAnalyzer.js';
import {
  cosineSimilarity,
  parseSemanticSearchQuery,
  executeSemanticSearch,
  buildVibeRadioQueue,
  buildTimeCapsuleAnalytics,
  buildAlbumCollections,
  buildArtistCollections,
  resolveQueueRowNumIndicator,
  resolveRowClickAction,
  applyProSmartFilter,
  isMusicVideoTagged,
  isLongFeatureVideo,
  GENRE_TAXONOMY,
  resolveMainGenre,
  parseStructuredLyrics
} from '../src/js/vibeRecommender.js';
import {
  STAGE_FX_MODES,
  STAGE_PALETTES,
  computeStageSpectralMetrics,
  resolveStagePalette
} from '../src/js/stageLights.js';
import {
  FLOW_NODE_REGISTRY,
  FLOW_PRESET_TEMPLATES,
  buildFlowSchedule,
  validateFlowGraph,
  hasPlaylistReferenceCycle,
  executeFlowGraph
} from '../src/js/playlistFlowEngine.js';

const require = createRequire(import.meta.url);
const {
  normalizeId3Genre,
  encodeSynchsafeInt,
  decodeSynchsafeInt,
  writeId3v2Tags,
  readId3v2Tags,
  updateMp3MetadataOnDisk,
  readFlacMetadataFromFile,
  updateFlacVorbisTagsOnDisk,
  parseReplayGainDbValue,
  parseReplayGainPeakValue,
  formatReplayGainDb,
  formatReplayGainPeak
} = require('../electron/services/id3Service.cjs');
const {
  sanitizeFilename,
  parseYouTubeInputs,
  extractYouTubeId,
  resolveYouTubeMetadata
} = require('../electron/services/youtubeService.cjs');
const {
  VIDEO_EXTENSIONS,
  computeAudioPayloadFingerprint,
  resolveHashStoreEntry,
  upsertHashAnnotation,
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
} = require('../electron/services/libraryService.cjs');
const logger = require('../electron/services/loggerService.cjs');
const {
  parseFfmpegProbeOutput,
  parseEbuR128Summary,
  isNativeDsdFile,
  needsLosslessPcmTranscode,
  parseMediaContainerProbe,
  decideVideoPlaybackStrategy,
  convertSrtToVtt,
  resolveFfmpegBinary,
  resolveWasapiEngineBinary,
  listWasapiDevices,
  listAsioDevices,
  inspectWavPackDsdHeader,
  computeAlbumLoudnessSummary,
  readReplayGainTagsForFile,
  analyzeAlbumReplayGain,
  listSacdIsoTracks,
  buildSacdCatalogTracks
} = require('../electron/services/audioBridgeService.cjs');

const {
  resolveSafeVaultSubfolder,
  validateSafeFilePath,
  validateSafeDirectoryPath,
  validateSafeSacdIsoPath,
  isPathAuthorizedInScope,
  resolveFromTrustedRoots,
  SUBTITLE_EXTENSIONS,
  SACD_ISO_EXTENSIONS,
  PLAYLIST_EXTENSIONS
} = require('../electron/services/pathSecurityService.cjs');

describe('VANTA — Personal Audio & Video OS Verification Suite', () => {
  it('1. YouTube Multi-URL / Video ID Parser extracts & deduplicates watch, short, and raw IDs', async () => {
    const raw = `
      https://youtu.be/dQw4w9WgXcQ,
      https://www.youtube.com/watch?v=dQw4w9WgXcQ
      https://music.youtube.com/watch?v=9bZkp7q19f0
      https://www.youtube.com/shorts/aqz-KE-bpKQ
      jNQXAC9IVRw
    `;

    const parsed = parseYouTubeInputs(raw);
    assert.deepEqual(parsed.youtubeIds, ['dQw4w9WgXcQ', '9bZkp7q19f0', 'aqz-KE-bpKQ', 'jNQXAC9IVRw']);
    assert.equal(parsed.totalCount, 4);
    assert.equal(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(sanitizeFilename('Track: Title / Test? *1*'), 'Track_ Title _ Test_ _1_');

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        title: 'Midnight Analog Session',
        author_name: 'VANTA Live',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      })
    });
    const meta = await resolveYouTubeMetadata('https://youtu.be/dQw4w9WgXcQ', mockFetch);
    assert.equal(meta.title, 'Midnight Analog Session');
    assert.equal(meta.artist, 'VANTA Live');
  });

  it('2. Binary ID3v2 Engine embeds and parses Title, Artist, BPM, Key, Lyrics, Provenance & APIC Cover Art', () => {
    const sizeVal = 194583;
    const encoded = encodeSynchsafeInt(sizeVal);
    assert.equal(decodeSynchsafeInt(encoded), sizeVal);

    const fakeMp3Payload = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x11, 0x22, 0x33, 0x44]);
    const fakeJpegCover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    const tagged = writeId3v2Tags(fakeMp3Payload, {
      title: 'Midnight Circuit',
      artist: 'NOVAE',
      album: 'VANTA Vault',
      genre: 'Dark Synthwave',
      bpm: 126,
      key: 'A min',
      isrc: 'dQw4w9WgXcQ',
      lyrics: 'Neon rain falls on obsidian glass',
      provenance: 'YouTube Vault • 320kbps',
      coverBuffer: fakeJpegCover
    });

    const parsed = readId3v2Tags(tagged);
    assert.equal(parsed.hasId3, true);
    assert.equal(parsed.title, 'Midnight Circuit');
    assert.equal(parsed.artist, 'NOVAE');
    assert.equal(parsed.album, 'VANTA Vault');
    assert.equal(parsed.genre, 'Dark Synthwave');
    assert.equal(parsed.bpm, '126');
    assert.equal(parsed.key, 'A min');
    assert.equal(parsed.isrc, 'dQw4w9WgXcQ');
    assert.equal(parsed.lyrics, 'Neon rain falls on obsidian glass');
    assert.equal(parsed.provenance, 'YouTube Vault • 320kbps');
    assert.equal(parsed.hasCover, true);
    assert.equal(parsed.coverMime, 'image/jpeg');
    assert.deepEqual(parsed.coverBuffer, fakeJpegCover);

    // Re-tagging must strip old header without duplicating ID3 frames
    const retagged = writeId3v2Tags(tagged, {
      title: 'Midnight Circuit (Remastered)',
      artist: 'NOVAE',
      bpm: 128
    });
    const reparsed = readId3v2Tags(retagged);
    assert.equal(reparsed.title, 'Midnight Circuit (Remastered)');
    assert.equal(reparsed.bpm, '128');
  });

  it('3. Quality Doctor detects duplicates & missing cover art, auto-repairs them, and exports Portable Wallet', () => {
    const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-doctor-test-'));
    try {
      const sharedAudioPayload = Buffer.alloc(1024, 0x5a);
      const fileA = path.join(tmpVault, 'track_master.mp3');
      const fileB = path.join(tmpVault, 'track_duplicate.mp3');

      fs.writeFileSync(fileA, sharedAudioPayload);
      fs.writeFileSync(fileB, sharedAudioPayload);

      const scanned = scanMediaDirectories([tmpVault]);
      assert.equal(scanned.length, 2);

      const report = runQualityDoctor(scanned);
      assert.ok(report.issues.some((i) => i.type === 'DUPLICATE_AUDIO'));
      assert.ok(report.issues.some((i) => i.type === 'MISSING_COVER'));

      const repair = repairQualityIssues(report.issues, tmpVault);
      assert.ok(repair.repairedCount >= 2);

      const rescanned = scanMediaDirectories([tmpVault]);
      assert.equal(rescanned.length, 1);
      assert.equal(rescanned[0].hasCover, true);
      assert.equal(rescanned[0].hasId3, true);

      const wallet = exportPortableWallet({ tracks: rescanned }, path.join(tmpVault, 'Exports'));
      assert.ok(fs.existsSync(wallet.walletPath));
      assert.equal(wallet.trackCount, 1);
    } finally {
      fs.rmSync(tmpVault, { recursive: true, force: true });
    }
  });

  it('4. Web Audio DSP Math: Tube Saturation & Equal-Power Crossfade conserve energy', () => {
    const curve = buildTubeSaturationCurve(30, 512);
    assert.equal(curve.length, 512);
    assert.ok(curve[0] >= -1 && curve[511] <= 1);

    const midFade = computeEqualPowerCrossfade(0.5);
    const powerSum = midFade.gainA * midFade.gainA + midFade.gainB * midFade.gainB;
    assert.ok(Math.abs(powerSum - 1.0) < 1e-6);

    // 10-Band EQ frequencies, presets, and AutoEQ device profiles
    assert.equal(EQ_FREQUENCIES.length, 10);
    assert.equal(EQ_PRESETS['Flat Reference'].length, 10);
    assert.equal(DEVICE_EQ_PROFILES['Harman Target (In-Ear)'].length, 10);

    // Mid-Side Binaural Spatializer bounds
    const sp = computeMidSideSpatialGains(135);
    assert.ok(sp.sideGain > 1.3 && sp.midGain > 0.7 && sp.haasDelaySec > 0 && sp.earlyWet > 0);
    const spClamp = computeMidSideSpatialGains(999);
    assert.equal(spClamp.sideGain, computeMidSideSpatialGains(150).sideGain);

    // Bauer Crossfeed acoustic conservation
    const xf = computeBauerCrossfeedParams(55);
    assert.equal(xf.cutoffHz, 700);
    assert.equal(xf.delaySec, 0.00026);
    assert.ok(Math.abs(xf.directGain * xf.directGain + xf.crossGain * xf.crossGain - 1.0) < 1e-3);

    // Dynamic Sub-Bass Boost bounds
    const sub = computeSubBassCurveParams(5.5);
    assert.equal(sub.subShelfDb, 5.5);
    assert.ok(sub.punchDb > 2 && sub.headroomLinear < 1 && sub.headroomLinear > 0.65);

    // Pro DSP engine state persistence, legacy 8-band upgrade, & Bit-Perfect reset
    const eng = new VantaAudioEngine();
    eng.applyEqPreset('Bass & Punch');
    assert.equal(eng.state.eqEnabled, true);
    eng.setDspParam('spatialWidthPct', 145);
    eng.setDspParam('pitchSemitones', -2);
    const snap = eng.exportPersistState();
    const eng2 = new VantaAudioEngine();
    eng2.importPersistState(snap);
    assert.equal(eng2.state.spatialWidthPct, 145);
    assert.equal(eng2.state.pitchSemitones, -2);
    assert.deepEqual(eng2.state.gains, EQ_PRESETS['Bass & Punch']);
    // Legacy 8-band migration
    eng2.importPersistState({ gains: [1, 2, 3, 4, 5, 6, 7, 8] });
    assert.equal(eng2.state.gains.length, 10);
    // Bit-Perfect Pure Reset zeroes coloring FX, Limiter, and EBU R128 for strict Bit-Perfect transport;
    // Studio DSP Preset re-enables EBU R128 + True-Peak Limiter in one action
    eng2.toggleDspFlag('spatial');
    eng2.applyStudioDspPreset();
    assert.equal(eng2.state.limiter, true);
    assert.equal(eng2.state.lufs, true);
    eng2.resetBitPerfect();
    assert.equal(eng2.state.spatial, false);
    assert.equal(eng2.state.pitchSemitones, 0);
    assert.equal(eng2.state.limiter, false);
    assert.equal(eng2.state.lufs, false);
  });

  it('5. MIR Song DNA, PCM BPM Onset Estimator, Semantic Search & Vibe Radio AI', () => {
    const sampleRate = 10000;
    const durationSec = 6;
    const pcm = new Float32Array(sampleRate * durationSec);
    const intervalSamples = Math.floor(sampleRate * 0.5); // 120 BPM
    for (let beat = 0; beat < durationSec * 2; beat++) {
      const start = beat * intervalSamples;
      for (let k = 0; k < 180 && start + k < pcm.length; k++) {
        pcm[start + k] = 0.95;
      }
    }

    const detectedBpm = estimateBpmFromPcm(pcm, sampleRate);
    assert.ok(Math.abs(detectedBpm - 120) <= 2, `Expected ~120 BPM, got ${detectedBpm}`);

    const harmOk = evaluateHarmonicCompatibility('A min', 'E min');
    assert.equal(harmOk.compatible, true);
    assert.equal(harmOk.camelotA, '8A');
    assert.equal(harmOk.camelotB, '9A');

    const query = parseSemanticSearchQuery('“melancholic night drive synthwave 120–128 BPM”');
    assert.equal(query.minBpm, 120);
    assert.equal(query.maxBpm, 128);
    assert.ok(query.moodTags.includes('melancholic'));
    assert.ok(query.moodTags.includes('synthwave'));

    const catalog = [
      { id: '1', title: 'Midnight Circuit', genre: 'Dark Synthwave', mood: 'Melancholic Night Drive', bpm: 126, key: 'A min', energy: 88, provenance: 'Local Master' },
      { id: '2', title: 'Morning Acoustic Folk', genre: 'Acoustic', mood: 'Sunny', bpm: 84, key: 'F min', energy: 45, provenance: 'Local Master' },
      { id: '3', title: 'Obsidian Synth Highway', genre: 'Synthwave', mood: 'Night Drive', bpm: 124, key: 'E min', energy: 90, provenance: 'YouTube Vault' }
    ];

    const searchResults = executeSemanticSearch('melancholic night drive synthwave 120-128 BPM', catalog);
    assert.equal(searchResults[0].id, '1');

    const vibeQueue = buildVibeRadioQueue(catalog[0], catalog);
    assert.equal(vibeQueue[0].id, '1');
    assert.equal(vibeQueue[1].id, '3');

    const dna = computeSongDna(catalog[0]);
    assert.equal(dna.vector.length, 6);
    assert.ok(cosineSimilarity(dna.vector, dna.vector) > 0.99);

    const capsule = buildTimeCapsuleAnalytics(catalog);
    assert.equal(capsule.totalTracks, 3);
    assert.equal(capsule.youtubeCount, 1);
    assert.equal(capsule.localCount, 2);
  });

  it('6. Async Non-Blocking Folder Scanner & Persistent Diagnostic Logger (vanta.log)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-async-scan-'));
    try {
      const musicSub = path.join(tmpDir, 'MyMusic');
      const ignoredSub = path.join(tmpDir, 'node_modules');
      fs.mkdirSync(musicSub, { recursive: true });
      fs.mkdirSync(ignoredSub, { recursive: true });

      fs.writeFileSync(path.join(musicSub, 'song1.mp3'), Buffer.alloc(128000, 0x33));
      fs.writeFileSync(path.join(ignoredSub, 'ignored.mp3'), Buffer.alloc(4096, 0x44));

      const progressEvents = [];
      const scanned = await scanMediaDirectoriesAsync([tmpDir], {
        onProgress: (p) => progressEvents.push(p)
      });

      assert.equal(scanned.length, 1);
      assert.equal(scanned[0].fileName, 'song1.mp3');
      assert.equal(progressEvents.length, 1);

      logger.info('UnitTest', 'Verified async folder scan and logger service', { count: scanned.length });
      assert.ok(fs.existsSync(logger.logFilePath));
      const recent = logger.getRecentLogs();
      assert.ok(recent.some((e) => e.scope === 'UnitTest'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('7. Bit-Perfect DSP Bypass, Pro Smart Focus Filter (BPM/Key/Stars/Tags) & Persistent Store', () => {
    const linearCurve = buildTubeSaturationCurve(0, 256);
    assert.ok(Math.abs(linearCurve[0] - (-1)) < 1e-6);
    assert.ok(Math.abs(linearCurve[128] - 0) < 0.02);

    const library = [
      { id: 't1', title: 'Night Highway', artist: 'NOVAE', bpm: 126, key: 'A min', energy: 90, stars: 5, favorite: true, tags: ['NightDrive', 'Peak'], groups: ['Car Mix'], ext: 'MP3' },
      { id: 't2', title: 'Warm Dawn', artist: 'ELARA', bpm: 92, key: 'C min', energy: 65, stars: 3, favorite: false, tags: ['Chill'], groups: ['Study'], ext: 'FLAC' },
      { id: 't3', title: 'Shadow Pulse', artist: 'ORBIT', bpm: 124, key: 'E min', energy: 86, stars: 4, favorite: true, tags: ['NightDrive'], groups: ['Set 1'], ext: 'MP3' }
    ];

    const byPrefix = applyProSmartFilter(library, { query: 'bpm:120-130 star:4+ #nightdrive', sortBy: 'bpm-asc' });
    assert.deepEqual(byPrefix.map((t) => t.id), ['t3', 't1']);

    assert.deepEqual(applyProSmartFilter(library, { exactStars: 4 }).map((t) => t.id), ['t3']);
    assert.deepEqual(applyProSmartFilter(library, { exactStars: 3 }).map((t) => t.id), ['t2']);
    assert.deepEqual(applyProSmartFilter(library, { exactStars: 1 }).map((t) => t.id), []);
    assert.deepEqual(applyProSmartFilter(library, { query: 'star:3' }).map((t) => t.id), ['t2']);
    assert.deepEqual(applyProSmartFilter(library, { tags: ['Chill', 'Peak'] }).map((t) => t.id), ['t1', 't2']);
    assert.deepEqual(applyProSmartFilter(library, { groups: ['Car Mix', 'Set 1'] }).map((t) => t.id), ['t1', 't3']);
    assert.deepEqual(applyProSmartFilter(library, { favoriteOnly: true }).map((t) => t.id), ['t1', 't3']);
    assert.deepEqual(applyProSmartFilter(library, { favoriteOnly: true, exactStars: 4, energyBand: 'mid', tags: ['NightDrive'], groups: ['Set 1'] }).map((t) => t.id), ['t3']);

    const byHarmonic = applyProSmartFilter(library, { key: 'HARMONIC' }, library[0]);
    assert.deepEqual(byHarmonic.map((t) => t.id), ['t1', 't3']);

    const tmpStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-store-test-'));
    try {
      const storePath = path.join(tmpStoreDir, 'vanta-library.json');
      saveLibraryStore({
        watchedFolders: ['D:\\Music'],
        hiddenPaths: ['C:\\Vanta\\VantaVault\\YouTube\\cleared.mp3'],
        annotations: { 't1': { stars: 5, tags: ['NightDrive'], groups: ['Car Mix'] } },
        smartPlaylists: [{ id: 'sp-1', name: '120-130 BPM', filters: { minBpm: 120, maxBpm: 130 } }]
      }, storePath);
      const reloaded = loadLibraryStore(storePath);
      assert.deepEqual(reloaded.watchedFolders, ['D:\\Music']);
      assert.deepEqual(reloaded.hiddenPaths, ['C:\\Vanta\\VantaVault\\YouTube\\cleared.mp3']);
      assert.equal(reloaded.annotations.t1.stars, 5);
      assert.equal(reloaded.smartPlaylists[0].name, '120-130 BPM');

      const visibleAfterClear = filterHiddenCatalogTracks(
        [
          { id: 'v1', filePath: 'c:\\vanta\\vantavault\\youtube\\cleared.mp3' },
          { id: 'v2', filePath: 'C:\\Vanta\\VantaVault\\YouTube\\kept.mp3' }
        ],
        reloaded.hiddenPaths
      );
      assert.deepEqual(visibleAfterClear.map((t) => t.id), ['v2']);
    } finally {
      fs.rmSync(tmpStoreDir, { recursive: true, force: true });
    }
  });

  it('8. Native WASAPI Audio Bridge, EBU R128 ReplayGain & Dual-Deck Crossfade Engine', async () => {
    const sampleProbeStderr = `
      Duration: 00:04:12.50, start: 0.000000, bitrate: 2822 kb/s
      Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit), 2822 kb/s
    `;
    const probe = parseFfmpegProbeOutput(sampleProbeStderr);
    assert.equal(probe.codec, 'FLAC');
    assert.equal(probe.sampleRate, 96000);
    assert.equal(probe.bitDepth, 24);
    assert.equal(probe.channels, 2);
    assert.equal(probe.bitrateKbps, 2822);
    assert.ok(Math.abs(probe.durationSec - 252.5) < 0.01);

    const r128Stderr = `
      [Parsed_ebur128_0 @ 000001] Summary:
        Integrated loudness:
          I:         -11.0 LUFS
          Threshold: -21.1 LUFS
        True peak:
          Peak:      -0.2 dBFS
    `;
    const r128 = parseEbuR128Summary(r128Stderr);
    assert.equal(r128.integratedLufs, -11.0);
    assert.equal(r128.replayGainDb, -3.0);
    assert.ok(r128.linearGain > 0.7 && r128.linearGain < 0.72);

    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.m4a', 'ALAC'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.alac'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.aiff'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.w64'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.dsf'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.dff'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.ape'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.wv'), true);
    assert.equal(needsLosslessPcmTranscode('C:\\Music\\master.mp3'), false);

    const probe768 = parseFfmpegProbeOutput(
      'Stream #0:0: Audio: pcm_s32le, 768000 Hz, 7.1, s32, 196608 kb/s'
    );
    assert.equal(probe768.codec, 'PCM_S32LE');
    assert.equal(probe768.sampleRate, 768000);
    assert.equal(probe768.bitDepth, 32);
    assert.equal(probe768.channels, 8);

    const probe51 = parseFfmpegProbeOutput(
      'Stream #0:0: Audio: flac, 192000 Hz, 5.1(side), s32 (24 bit), 9216 kb/s'
    );
    assert.equal(probe51.channels, 6);
    assert.equal(probe51.bitDepth, 24);

    const probeDsd = parseFfmpegProbeOutput(
      'Stream #0:0: Audio: dsd_lsbf_planar, 2822400 Hz, stereo, fltp, 5644 kb/s'
    );
    assert.equal(probeDsd.codec, 'DSD_LSBF_PLANAR');
    assert.equal(probeDsd.sampleRate, 2822400);
    assert.equal(probeDsd.bitDepth, 1);
    assert.equal(probeDsd.channels, 2);

    const exePath = resolveWasapiEngineBinary();
    assert.ok(exePath && fs.existsSync(exePath), `Missing vanta-audio-engine.exe at ${exePath}`);
    const devices = await listWasapiDevices();
    assert.ok(Array.isArray(devices) && devices.length >= 1, 'Expected at least 1 active Windows WASAPI endpoint');

    const engine = new VantaAudioEngine();
    assert.equal(engine.activeDeck, 'A');
    assert.equal(engine.state.lufs, false);
    assert.equal(engine.state.limiter, false);
    assert.equal(engine.state.eqEnabled, false);
    assert.equal(engine.state.volumeMode, 'auto');
    engine.applyStudioDspPreset();
    assert.equal(engine.state.lufs, true);
    assert.equal(engine.state.limiter, true);
    engine.resetBitPerfect();
    assert.equal(engine.state.lufs, false);
    assert.equal(engine.state.limiter, false);
    assert.equal(engine.state.crossfadeSeconds, 0.0);
    engine.setCrossfadeSeconds(6);
    assert.equal(engine.state.crossfadeSeconds, 6);

    const { gainA, gainB } = computeEqualPowerCrossfade(0.5);
    assert.ok(Math.abs(gainA * gainA + gainB * gainB - 1.0) < 1e-6);

    assert.deepEqual(VISUALIZER_MODES, ['prism', 'rta', 'vu']);
    const fakeBars = Array.from({ length: 24 }, (_, idx) => (idx + 1) / 24);
    engine.setExternalSpectrum(fakeBars, {
      lPeak: 0.81,
      rPeak: 0.74,
      lRms: 0.32,
      rRms: 0.29,
      wave: Array.from({ length: 32 }, (_, i) => Math.sin(i * 0.2))
    });
    assert.equal(engine.getSpectrumBars(24).length, 24);
    assert.equal(engine.getWaveformSamples(32).length, 32);
    const stereo = engine.getStereoLevels();
    assert.equal(stereo.lPeak, 0.81);
    assert.equal(stereo.rPeak, 0.74);

    // Native DoP v1.1 verification (synthetic Sony DSF DSD64 LSB-first & Philips DSDIFF DSD128 MSB-first)
    assert.equal(isNativeDsdFile('C:\\Music\\track.dsf'), true);
    assert.equal(isNativeDsdFile('C:\\Music\\track.dff'), true);
    assert.equal(isNativeDsdFile('C:\\Music\\track.flac'), false);

    const tmpDopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-dop-test-'));
    try {
      // 1. Sony DSF (DSD64 @ 2822400Hz, 2ch, LSB-first bitsPerSample=1, blockSize=16)
      const dsfPath = path.join(tmpDopDir, 'synthetic_dsd64.dsf');
      const dsfBuf = Buffer.alloc(28 + 52 + 12 + 32, 0);
      dsfBuf.write('DSD ', 0, 'ascii');
      dsfBuf.writeBigUInt64LE(28n, 4);
      dsfBuf.writeBigUInt64LE(BigInt(dsfBuf.length), 12);
      dsfBuf.writeBigUInt64LE(0n, 20);

      dsfBuf.write('fmt ', 28, 'ascii');
      dsfBuf.writeBigUInt64LE(52n, 32);
      dsfBuf.writeUInt32LE(1, 40);
      dsfBuf.writeUInt32LE(0, 44);
      dsfBuf.writeUInt32LE(2, 48);
      dsfBuf.writeUInt32LE(2, 52);
      dsfBuf.writeUInt32LE(2822400, 56);
      dsfBuf.writeUInt32LE(1, 60);
      dsfBuf.writeBigUInt64LE(128n, 64);
      dsfBuf.writeUInt32LE(16, 72);
      dsfBuf.writeUInt32LE(0, 76);

      dsfBuf.write('data', 80, 'ascii');
      dsfBuf.writeBigUInt64LE(44n, 84);
      // Ch0 block (16 bytes starting at 92)
      dsfBuf[92] = 0x01; // bit-reversed -> 0x80
      dsfBuf[93] = 0x03; // bit-reversed -> 0xC0
      dsfBuf[94] = 0xAA; // bit-reversed -> 0x55
      dsfBuf[95] = 0x55; // bit-reversed -> 0xAA
      // Ch1 block (16 bytes starting at 108)
      dsfBuf[108] = 0x0F; // bit-reversed -> 0xF0
      dsfBuf[109] = 0xF0; // bit-reversed -> 0x0F
      dsfBuf[110] = 0x80; // bit-reversed -> 0x01
      dsfBuf[111] = 0x01; // bit-reversed -> 0x80
      fs.writeFileSync(dsfPath, dsfBuf);

      const dsfOut = JSON.parse(execFileSync(exePath, ['--test-dop', dsfPath], { encoding: 'utf8' }).trim());
      assert.equal(dsfOut.ok, true);
      assert.equal(dsfOut.format, 'DSF');
      assert.equal(dsfOut.dsdRate, 'DSD64');
      assert.equal(dsfOut.carrierRate, 176400);
      assert.equal(dsfOut.channels, 2);
      assert.equal(dsfOut.sampleFrames, 8);
      assert.equal(dsfOut.firstWords[0], 0x0580C0);
      assert.equal(dsfOut.firstWords[1], 0x05F00F);
      assert.equal(dsfOut.firstWords[2], 0xFA55AA);
      assert.equal(dsfOut.firstWords[3], 0xFA0180);

      // 2. Philips DSDIFF DFF (DSD128 @ 5644800Hz, 2ch, MSB-first byte-interleaved)
      const dffPath = path.join(tmpDopDir, 'synthetic_dsd128.dff');
      const dffBuf = Buffer.alloc(16 + (12 + 58) + (12 + 16), 0);
      dffBuf.write('FRM8', 0, 'ascii');
      dffBuf.writeBigUInt64BE(BigInt(dffBuf.length - 12), 4);
      dffBuf.write('DSD ', 12, 'ascii');

      // PROP chunk at 16 (58 bytes payload)
      dffBuf.write('PROP', 16, 'ascii');
      dffBuf.writeBigUInt64BE(58n, 20);
      dffBuf.write('SND ', 28, 'ascii');
      dffBuf.write('FS  ', 32, 'ascii');
      dffBuf.writeBigUInt64BE(4n, 36);
      dffBuf.writeUInt32BE(5644800, 44);
      dffBuf.write('CHNL', 48, 'ascii');
      dffBuf.writeBigUInt64BE(10n, 52);
      dffBuf.writeUInt16BE(2, 60);
      dffBuf.write('SLFT', 62, 'ascii');
      dffBuf.write('SRGT', 66, 'ascii');
      dffBuf.write('CMPR', 70, 'ascii');
      dffBuf.writeBigUInt64BE(4n, 74);
      dffBuf.write('DSD ', 82, 'ascii');

      // DSD sound chunk at 86 (16 bytes = 4 carrier frames x 2ch x 2 bytes)
      dffBuf.write('DSD ', 86, 'ascii');
      dffBuf.writeBigUInt64BE(16n, 90);
      dffBuf[98] = 0x12; dffBuf[99] = 0xAB;
      dffBuf[100] = 0x34; dffBuf[101] = 0xCD;
      dffBuf[102] = 0x56; dffBuf[103] = 0xEF;
      dffBuf[104] = 0x78; dffBuf[105] = 0x01;
      fs.writeFileSync(dffPath, dffBuf);

      const dffOut = JSON.parse(execFileSync(exePath, ['--test-dop', dffPath], { encoding: 'utf8' }).trim());
      assert.equal(dffOut.ok, true);
      assert.equal(dffOut.format, 'DFF');
      assert.equal(dffOut.dsdRate, 'DSD128');
      assert.equal(dffOut.carrierRate, 352800);
      assert.equal(dffOut.channels, 2);
      assert.equal(dffOut.sampleFrames, 4);
      assert.equal(dffOut.firstWords[0], 0x051234);
      assert.equal(dffOut.firstWords[1], 0x05ABCD);
      assert.equal(dffOut.firstWords[2], 0xFA5678);
      assert.equal(dffOut.firstWords[3], 0xFAEF01);
      assert.equal(dffOut.firstWords[4], 0x050000);
      assert.equal(dffOut.firstWords[6], 0xFA0000);
    } finally {
      fs.rmSync(tmpDopDir, { recursive: true, force: true });
    }
  });

  it('9. Split Computer Explorer Roots, Lazy Listing, Explicit File Ingestion & Store Persistence', () => {
    const roots = getComputerRoots();
    assert.ok(Array.isArray(roots) && roots.length >= 1);
    assert.ok(roots.some((r) => r.kind === 'drive' && r.path.endsWith(':\\')));

    const tmpExp = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-explorer-'));
    try {
      const subA = path.join(tmpExp, 'Alpha Folder');
      const subB = path.join(tmpExp, 'Beta Folder');
      const hiddenNodeMods = path.join(tmpExp, 'node_modules');
      const hiddenOsDir = path.join(tmpExp, 'Windows');
      fs.mkdirSync(subA, { recursive: true });
      fs.mkdirSync(subB, { recursive: true });
      fs.mkdirSync(hiddenNodeMods, { recursive: true });
      fs.mkdirSync(hiddenOsDir, { recursive: true });

      const mp3File = path.join(tmpExp, 'track_alpha.mp3');
      const flacFile = path.join(tmpExp, 'master_beta.flac');
      const nestedMp3 = path.join(subA, 'nested_song.mp3');
      fs.writeFileSync(mp3File, Buffer.alloc(4096, 0x11));
      fs.writeFileSync(flacFile, Buffer.alloc(4096, 0x22));
      fs.writeFileSync(nestedMp3, Buffer.alloc(4096, 0x33));
      fs.writeFileSync(path.join(tmpExp, 'readme.txt'), 'not media');

      const listed = listDirectoryEntries(tmpExp);
      assert.equal(listed.entries.length, 4);
      // Folders must appear before media files, skipping unsupported files, node_modules & Windows OS folders
      assert.deepEqual(
        listed.entries.map((e) => `${e.type}:${e.name}`),
        ['folder:Alpha Folder', 'folder:Beta Folder', 'file:master_beta.flac', 'file:track_alpha.mp3']
      );

      // User-hidden directory filter (O(1)) excludes subB without touching disk
      const filteredListed = listDirectoryEntries(tmpExp, [subB.toUpperCase()]);
      assert.deepEqual(
        filteredListed.entries.map((e) => `${e.type}:${e.name}`),
        ['folder:Alpha Folder', 'file:master_beta.flac', 'file:track_alpha.mp3']
      );

      const folderTracks = scanMediaDirectories([subA]);
      assert.equal(folderTracks.length, 1);

      // Should index standalone mp3/flac and skip nestedMp3 already present in folderTracks
      const explicitTracks = scanExplicitMediaFiles([mp3File, flacFile, nestedMp3, path.join(tmpExp, 'readme.txt')], folderTracks);
      assert.equal(explicitTracks.length, 2);

      const merged = mergeCatalogTracks(folderTracks, explicitTracks);
      assert.equal(merged.length, 3);

      const storePath = path.join(tmpExp, 'vanta-library.json');
      saveLibraryStore(
        {
          watchedFolders: [subA],
          watchedFiles: [mp3File, flacFile],
          hiddenPaths: [],
          hiddenExplorerDirs: [subB],
          annotations: {},
          loudnessCache: {},
          smartPlaylists: []
        },
        storePath
      );
      const reloaded = loadLibraryStore(storePath);
      assert.deepEqual(reloaded.watchedFiles, [mp3File, flacFile]);
      assert.deepEqual(reloaded.hiddenExplorerDirs, [subB]);
      // Zero built-in smart playlist defaults: empty user array must stay empty
      assert.deepEqual(reloaded.smartPlaylists, []);
      const freshStore = loadLibraryStore(path.join(tmpExp, 'nonexistent-store.json'));
      assert.deepEqual(freshStore.smartPlaylists, []);

      // Duplicate smart playlist names (case-insensitive) are deduplicated cleanly on load
      const dupStorePath = path.join(tmpExp, 'vanta-dup-store.json');
      saveLibraryStore(
        {
          watchedFolders: [],
          watchedFiles: [],
          hiddenPaths: [],
          hiddenExplorerDirs: [],
          annotations: {},
          loudnessCache: {},
          stageFxVideoPath: 'C:\\Vanta\\VantaVault\\effect1.mp4',
          smartPlaylists: [
            {
              id: 'sp-1',
              name: 'Rock',
              description: 'Guitar energy',
              visual: { mode: 'preset', presetKey: 'rock', imagePath: '' },
              filters: { minBpm: '120', maxBpm: '150' }
            },
            { id: 'sp-2', name: 'rock ', filters: { minBpm: '140', maxBpm: '150' } },
            { id: 'sp-3', name: 'Chill', filters: { energyBand: 'low' } }
          ]
        },
        dupStorePath
      );
      const deduped = loadLibraryStore(dupStorePath);
      assert.deepEqual(deduped.smartPlaylists.map((p) => p.name), ['Rock', 'Chill']);
      assert.equal(deduped.smartPlaylists[0].description, 'Guitar energy');
      assert.equal(deduped.smartPlaylists[0].visual.presetKey, 'rock');
      assert.equal(deduped.smartPlaylists[1].visual.mode, 'auto');
      assert.equal(deduped.stageFxVideoPath, 'C:\\Vanta\\VantaVault\\effect1.mp4');
    } finally {
      fs.rmSync(tmpExp, { recursive: true, force: true });
    }
  });

  it('10. Stage FX 3-Band Spectral Onset Detector, Hyper-Stage Classifier & Key Palette Resolution', () => {
    assert.equal(STAGE_FX_MODES.length, 9);
    assert.ok(STAGE_FX_MODES.some((m) => m.id === 'video'));
    assert.ok(STAGE_PALETTES.cyber && STAGE_PALETTES.warm && STAGE_PALETTES.track);

    // Silence decays envelopes smoothly without false kick onsets
    const silentState = computeStageSpectralMetrics(new Float32Array(24).fill(0), { bass: 0.5, mid: 0.4, high: 0.3 }, false);
    assert.equal(silentState.kickDetected, false);
    assert.ok(silentState.bass < 0.5 && silentState.mid < 0.4 && silentState.high < 0.3);

    // Sub-bass kick spike triggers onset and classifies DROP
    const kickBars = new Float32Array(24).fill(0.15);
    kickBars[0] = 0.92;
    kickBars[1] = 0.88;
    kickBars[2] = 0.82;
    kickBars[3] = 0.78;
    kickBars[4] = 0.72;
    const dropState = computeStageSpectralMetrics(kickBars, { bass: 0.1, avgBass: 0.1, rollingEnergy: 0.4 }, true);
    assert.equal(dropState.kickDetected, true);
    assert.equal(dropState.onset, 1.0);
    assert.equal(dropState.hyperStage, 'DROP');

    assert.equal(resolveStagePalette('track', { key: 'F min' }).label, 'Warm Club');
    assert.equal(resolveStagePalette('track', { key: 'G min' }).label, 'Aurora Ice');
    assert.equal(resolveStagePalette('warm', { key: 'A min' }).label, 'Warm Club');

    // Moderate-bass & compressed-mix step jump also trigger kick detection cleanly
    const modBars = new Float32Array(24).fill(0.1);
    for (let i = 0; i < 5; i++) modBars[i] = 0.28;
    const modKick = computeStageSpectralMetrics(modBars, { bass: 0.2, avgBass: 0.22, rawBass: 0.21 }, true);
    assert.equal(modKick.kickDetected, true);
  });

  it('11. 4K Video Container Probe, Zero-Copy Remux Strategy & SRT-to-VTT Converter', () => {
    ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.avi', '.ts'].forEach((ext) => {
      assert.ok(VIDEO_EXTENSIONS.has(ext), `Expected VIDEO_EXTENSIONS to include ${ext}`);
    });

    const mkvStderr = [
      'Input #0, matroska,webm, from \'C:\\Movies\\BladeRunner4K.mkv\':',
      '  Duration: 02:43:12.50, start: 0.000000, bitrate: 24500 kb/s',
      '  Stream #0:0(eng): Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr, 1k tbn',
      '  Stream #0:1(eng): Audio: dts (DTS-HD MA), 48000 Hz, 5.1(side), s32p (24 bit), 3200 kb/s (default)',
      '  Stream #0:2(tur): Audio: ac3, 48000 Hz, 5.1(side), fltp, 448 kb/s',
      '  Stream #0:3(tur): Subtitle: subrip (default)',
      '  Stream #0:4(eng): Subtitle: hdmv_pgs_subtitle'
    ].join('\n');

    const mkvProbe = parseMediaContainerProbe(mkvStderr);
    assert.equal(mkvProbe.video.codec, 'hevc');
    assert.equal(mkvProbe.video.width, 3840);
    assert.equal(mkvProbe.video.height, 2160);
    assert.equal(mkvProbe.video.is4K, true);
    assert.equal(mkvProbe.video.isHdr, true);
    assert.ok(Math.abs(mkvProbe.durationSec - (2 * 3600 + 43 * 60 + 12.5)) < 0.05);
    assert.equal(mkvProbe.audioStreams.length, 2);
    assert.equal(mkvProbe.audioStreams[0].relIndex, 0);
    assert.equal(mkvProbe.audioStreams[0].lang, 'eng');
    assert.equal(mkvProbe.audioStreams[0].codec, 'dts');
    assert.equal(mkvProbe.audioStreams[0].channels, 6);
    assert.equal(mkvProbe.audioStreams[1].relIndex, 1);
    assert.equal(mkvProbe.audioStreams[1].lang, 'tur');
    assert.equal(mkvProbe.subtitleStreams.length, 2);
    assert.equal(mkvProbe.subtitleStreams[0].relIndex, 0);
    assert.equal(mkvProbe.subtitleStreams[0].isBitmap, false);
    assert.equal(mkvProbe.subtitleStreams[1].isBitmap, true);

    // 4K MKV + HEVC + DTS uses zero-copy video remux (-c:v copy) instead of slow software re-encode
    assert.equal(decideVideoPlaybackStrategy('C:\\Movies\\BladeRunner4K.mkv', mkvProbe, 1), 'remux-copy');

    // Native MP4 + H264 + AAC on track 0 (with ffmpeg [0x1]/[0x2] hex stream IDs) streams directly over GPU without remux
    const mp4Probe = parseMediaContainerProbe([
      'Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'clip.mp4\':',
      '  Duration: 00:01:15.00, bitrate: 18000 kb/s',
      '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 3840x2160, 60 fps',
      '  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp'
    ].join('\n'));
    assert.equal(mp4Probe.video.width, 3840);
    assert.equal(mp4Probe.video.height, 2160);
    assert.equal(mp4Probe.audioStreams.length, 1);
    assert.equal(decideVideoPlaybackStrategy('C:\\Clips\\clip.mp4', mp4Probe, 0), 'direct');
    // Multi-audio switch on MP4 upgrades to zero-copy remux so the alternate audio stream maps cleanly
    assert.equal(decideVideoPlaybackStrategy('C:\\Clips\\clip.mp4', mp4Probe, 1), 'remux-copy');

    // Legacy MPEG2 video requires H.264 stream transcode
    const mpgProbe = parseMediaContainerProbe('  Stream #0:0: Video: mpeg2video, yuv420p, 720x576, 25 fps\n  Stream #0:1: Audio: mp2, 48000 Hz, stereo');
    assert.equal(decideVideoPlaybackStrategy('C:\\Clips\\old.mpg', mpgProbe, 0), 'transcode-h264');

    // SRT -> WebVTT conversion handles BOM, CRLF normalization, and comma timestamps
    const srt = '\uFEFF1\r\n00:01:02,345 --> 00:01:05,678\r\nVANTA 4K Stage\r\n\r\n2\r\n00:01:06,000 --> 00:01:08,100\r\nSecond line\r\n';
    const vtt = convertSrtToVtt(srt);
    assert.ok(vtt.startsWith('WEBVTT\n'));
    assert.ok(vtt.includes('00:01:02.345 --> 00:01:05.678'));
    assert.ok(!vtt.includes('\r'));
    assert.ok(!vtt.includes('\uFEFF'));
  });

  it('12. Rekordbox 7 Table Metadata: audioHash Persistence, Strict Genre, ID3 Writeback, FLAC Vorbis & Column Sort', () => {
    assert.equal(normalizeId3Genre('(18)'), 'Techno');
    assert.equal(normalizeId3Genre('(17)Rock'), 'Rock');
    assert.equal(normalizeId3Genre('Melodic Techno'), 'Melodic Techno');

    const tmpRbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-rb7-'));
    try {
      // 1. Untagged MP3 keeps genre strictly empty (''), computes stable audioHash, and preserves hash across ID3 edits
      const mp3Path = path.join(tmpRbDir, 'Untagged_Cut.mp3');
      const rawPcmFrames = Buffer.alloc(4096, 0x7b);
      fs.writeFileSync(mp3Path, writeId3v2Tags(rawPcmFrames, { title: 'Untagged Cut', artist: 'DJ Test' }));

      const scanned = scanMediaDirectories([tmpRbDir]);
      assert.equal(scanned.length, 1);
      assert.equal(scanned[0].genre, '');
      assert.equal(scanned[0].album, '');
      assert.ok(scanned[0].createdAt && !Number.isNaN(Date.parse(scanned[0].createdAt)));
      assert.ok(scanned[0].sizeBytes > 0);
      const hashBefore = computeAudioPayloadFingerprint(mp3Path);
      assert.ok(hashBefore && hashBefore.length === 16);

      // Update ID3v2 on disk; audioHash must remain identical so hash annotations never break
      const writeRes = updateMp3MetadataOnDisk(mp3Path, { genre: 'Acid Techno', bpm: 138, key: '8A' });
      assert.equal(writeRes.ok, true);
      assert.equal(computeAudioPayloadFingerprint(mp3Path), hashBefore);
      const rescanned = scanMediaDirectories([tmpRbDir]);
      assert.equal(rescanned[0].genre, 'Acid Techno');
      assert.equal(rescanned[0].bpm, 138);
      assert.equal(rescanned[0].key, '8A');

      // 2. Hash-keyed annotations migrate legacy filePath keys and survive file moves/renames
      const annotations = {
        [mp3Path]: { stars: 4, tags: ['Warmup'] }
      };
      const up = upsertHashAnnotation(annotations, {
        audioHash: hashBefore,
        filePath: mp3Path,
        patch: { stars: 5, genre: 'Acid Techno' }
      });
      assert.equal(up.key, `hash:${hashBefore}`);
      assert.equal(annotations[mp3Path], undefined);
      const movedLookup = resolveHashStoreEntry(annotations, {
        audioHash: hashBefore,
        filePath: path.join(tmpRbDir, 'Moved_Folder', 'Renamed.mp3')
      });
      assert.equal(movedLookup.entry.stars, 5);
      assert.deepEqual(movedLookup.entry.tags, ['Warmup']);
      assert.equal(movedLookup.entry.genre, 'Acid Techno');

      // 3. Pure-JS FLAC STREAMINFO (24-bit 96kHz) + VORBIS_COMMENT reader
      const flacPath = path.join(tmpRbDir, 'Master_96k.flac');
      const streamInfo = Buffer.alloc(34, 0);
      // 96000 Hz (20 bits), 2 ch ((1)<<1), 24-bit ((23)=0x17 => bit 0 = 1 in byte[12], high 4 bits = 0x7 in byte[13])
      const sr96 = 96000;
      streamInfo[10] = (sr96 >> 12) & 0xff;
      streamInfo[11] = (sr96 >> 4) & 0xff;
      streamInfo[12] = ((sr96 & 0x0f) << 4) | (1 << 1) | 1;
      streamInfo[13] = 0x70;
      streamInfo.writeUInt32BE(192000, 14); // 192000 samples / 96000 Hz = 2.0 sec
      const hdrSi = Buffer.from([0x00, 0x00, 0x00, 34]); // type 0, len 34

      const comments = ['TITLE=Sub Zero', 'ARTIST=Analog', 'GENRE=Deep House', 'BPM=124', 'INITIALKEY=8A', 'DATE=2026'];
      const vendor = Buffer.from('VANTA');
      const vcParts = [Buffer.alloc(4), vendor, Buffer.alloc(4)];
      vcParts[0].writeUInt32LE(vendor.length, 0);
      vcParts[2].writeUInt32LE(comments.length, 0);
      for (const c of comments) {
        const cb = Buffer.from(c, 'utf8');
        const lb = Buffer.alloc(4);
        lb.writeUInt32LE(cb.length, 0);
        vcParts.push(lb, cb);
      }
      const vcPayload = Buffer.concat(vcParts);
      const hdrVc = Buffer.from([0x84, (vcPayload.length >> 16) & 0xff, (vcPayload.length >> 8) & 0xff, vcPayload.length & 0xff]);
      fs.writeFileSync(flacPath, Buffer.concat([Buffer.from('fLaC'), hdrSi, streamInfo, hdrVc, vcPayload]));

      const flacMeta = readFlacMetadataFromFile(flacPath);
      assert.equal(flacMeta.hasFlac, true);
      assert.equal(flacMeta.sampleRate, 96000);
      assert.equal(flacMeta.bitDepth, 24);
      assert.equal(flacMeta.channels, 2);
      assert.equal(flacMeta.durationSec, 2);
      assert.equal(flacMeta.genre, 'Deep House');
      assert.equal(flacMeta.bpm, '124');
      assert.equal(flacMeta.key, '8A');

      // 4. Column sort rules: Camelot wheel order, Genre, Creation Date, Size & Source folder
      const list = [
        { id: '1', title: 'A', key: 'A min', genre: '', sizeBytes: 5000, createdAt: '2026-01-01T00:00:00Z', filePath: 'D:\\Music\\Techno\\a.mp3' },
        { id: '2', title: 'B', key: 'G# min', genre: 'Techno', sizeBytes: 12000, createdAt: '2026-03-01T00:00:00Z', filePath: 'D:\\Music\\Ambient\\b.mp3' },
        { id: '3', title: 'C', key: 'F min', genre: 'Deep House', sizeBytes: 8000, createdAt: '2026-02-01T00:00:00Z', filePath: 'D:\\Music\\House\\c.mp3' }
      ];
      assert.deepEqual(
        applyProSmartFilter(list, { sortBy: 'key-asc' }).map((t) => t.id),
        ['2', '3', '1'] // 1A (G# min), 4A (F min), 8A (A min)
      );
      assert.deepEqual(
        applyProSmartFilter(list, { sortBy: 'genre-asc' }).map((t) => t.id),
        ['3', '2', '1'] // Deep House, Techno, ''
      );
      assert.deepEqual(
        applyProSmartFilter(list, { sortBy: 'created-desc' }).map((t) => t.id),
        ['2', '3', '1']
      );
      assert.deepEqual(
        applyProSmartFilter(list, { sortBy: 'size-desc' }).map((t) => t.id),
        ['2', '3', '1']
      );
      assert.deepEqual(
        applyProSmartFilter(list, { sortBy: 'source-asc' }).map((t) => t.id),
        ['2', '3', '1'] // D:\Music\Ambient, D:\Music\House, D:\Music\Techno
      );

      // 5. Video isolation: long videos (> 15 min / movies) excluded from Vibe Radio while short #MusicVideo stays eligible
      const audio1 = { id: 'a1', title: 'Track One', bpm: 124, key: 'A min', isVideo: false, tags: [] };
      const clipMv = { id: 'v1', title: 'Clip MV', bpm: 125, key: 'A min', isVideo: true, durationSec: 210, tags: ['MusicVideo'] };
      const plainVid = { id: 'v2', title: 'Plain Clip', bpm: 125, key: 'A min', isVideo: true, durationSec: 200, tags: [] };
      const longMovie = { id: 'v3', title: 'Full Movie 4K', bpm: 125, key: 'A min', isVideo: true, durationSec: 6500, tags: ['MusicVideo'] };

      assert.equal(isMusicVideoTagged(clipMv), true);
      assert.equal(isMusicVideoTagged(plainVid), false);
      assert.equal(isLongFeatureVideo(clipMv), false);
      assert.equal(isLongFeatureVideo(longMovie), true);
      const vibeQ = buildVibeRadioQueue(audio1, [audio1, clipMv, plainVid, longMovie]);
      assert.deepEqual(vibeQ.map((t) => t.id).sort(), ['a1', 'v1']);

      // 6. 10-Category Genre & Subgenre Hierarchy + Main-Genre Smart Search Resolution
      assert.equal(GENRE_TAXONOMY.length, 10);
      assert.equal(resolveMainGenre('Deep House'), 'Electronic');
      assert.equal(resolveMainGenre('Türk Sanat Müziği'), 'World / Latin / Reggae');
      assert.equal(resolveMainGenre('Metal'), 'Metal');
      assert.deepEqual(
        applyProSmartFilter(
          [
            { id: 'g1', title: 'Cut 1', genre: 'Deep House' },
            { id: 'g2', title: 'Cut 2', genre: 'Grunge' }
          ],
          { query: 'electronic' }
        ).map((t) => t.id),
        ['g1']
      );

      // 7. parseFfmpegProbeOutput captures videoCodec & dimensions cleanly for video Format badges
      const av1VideoProbe = parseFfmpegProbeOutput([
        '  Duration: 02:04:42.92, start: 0.000000, bitrate: 671 kb/s',
        '  Stream #0:0[0x1](und): Video: av1 (libdav1d) (av01 / 0x31307661), yuv420p(tv), 1920x1080, 535 kb/s, 30 fps',
        '  Stream #0:1[0x2](eng): Audio: opus (Opus / 0x7375704F), 48000 Hz, stereo, fltp, 131 kb/s'
      ].join('\n'));
      assert.equal(av1VideoProbe.videoCodec, 'AV1');
      assert.equal(av1VideoProbe.videoWidth, 1920);
      assert.equal(av1VideoProbe.videoHeight, 1080);
      assert.equal(av1VideoProbe.codec, 'OPUS');
      assert.equal(av1VideoProbe.bitrateKbps, 131);

      // 8. Structured Lyrics Parser splits stanzas cleanly, strips LRC timecodes, and ignores legacy placeholders
      assert.deepEqual(parseStructuredLyrics('Restored by VANTA Quality Doctor'), []);
      const parsedLyrics = parseStructuredLyrics(
        '[Sad piano solo]\n[Verse 1]\n[00:05.20] Line one\nLine two [Chorus] Stay till morning\nOh let me go'
      );
      assert.deepEqual(parsedLyrics, [
        { type: 'cue', text: '[Sad piano solo]' },
        { type: 'gap', text: '' },
        { type: 'section', text: '[Verse 1]' },
        { type: 'line', text: 'Line one' },
        { type: 'line', text: 'Line two' },
        { type: 'gap', text: '' },
        { type: 'section', text: '[Chorus]' },
        { type: 'line', text: 'Stay till morning' },
        { type: 'line', text: 'Oh let me go' }
      ]);
    } finally {
      fs.rmSync(tmpRbDir, { recursive: true, force: true });
    }
  });

  it('13. Large-Library Scalability: Incremental mtime statCache, slim IPC catalog & lazy binary cover/lyrics', async () => {
    const tmpScaleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-scale-test-'));
    const storePath = path.join(tmpScaleDir, 'store.json');
    try {
      const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
      const mp3Path = path.join(tmpScaleDir, 'Scalable Track.mp3');
      const rawAudio = Buffer.alloc(1024, 0x3c);
      const tagged = writeId3v2Tags(rawAudio, {
        title: 'Scalable Anthem',
        artist: 'VANTA Orchestra',
        lyrics: '[Verse 1]\nFast virtual scrolling',
        coverBuffer: fakeJpeg,
        coverMime: 'image/jpeg'
      });
      fs.writeFileSync(mp3Path, tagged);

      const statCache = {};
      const opts = { statCache, cacheDirty: false };
      const firstScan = await scanMediaDirectoriesAsync([tmpScaleDir], opts);
      assert.equal(firstScan.length, 1);
      assert.equal(opts.cacheDirty, true);
      assert.equal(firstScan[0].hasCover, true);
      assert.equal(firstScan[0].hasLyrics, true);
      assert.equal(firstScan[0].coverDataUrl, '');
      assert.equal(firstScan[0].lyrics, '');

      // Persist & reload store with scanCache, then verify cache hit does not mark cacheDirty
      const store = loadLibraryStore(storePath);
      store.scanCache = statCache;
      saveLibraryStore(store, storePath);
      const reloaded = loadLibraryStore(storePath);
      const opts2 = { statCache: reloaded.scanCache, cacheDirty: false };
      const cachedScan = await scanMediaDirectoriesAsync([tmpScaleDir], opts2);
      assert.equal(cachedScan.length, 1);
      assert.equal(opts2.cacheDirty, false);
      assert.equal(cachedScan[0].title, 'Scalable Anthem');

      // Lazy cover binary and lazy lyrics loaders read exact bytes on demand
      const cover = loadTrackCoverBinary(mp3Path);
      assert.ok(cover && Buffer.isBuffer(cover.buffer) && cover.buffer.equals(fakeJpeg));
      assert.equal(cover.mime, 'image/jpeg');
      assert.equal(loadTrackLyricsText(mp3Path), '[Verse 1]\nFast virtual scrolling');
    } finally {
      fs.rmSync(tmpScaleDir, { recursive: true, force: true });
    }
  });

  it('14. Enterprise Red Team Security: Path Traversal, ADS/UNC/Arg Tampering, Scope Isolation & CSP/Regex Hardening', () => {
    const tmpSecDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-sec-test-'));
    try {
      const vaultRoot = path.join(tmpSecDir, 'VantaVault');
      const outsideDir = path.join(tmpSecDir, 'Outside');
      fs.mkdirSync(path.join(vaultRoot, 'YouTube'), { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const secretFile = path.join(outsideDir, 'secret.env');
      const outsideMp3 = path.join(outsideDir, 'external.mp3');
      const vaultMp3 = path.join(vaultRoot, 'YouTube', 'safe.mp3');
      const outsideSrt = path.join(outsideDir, 'external.srt');
      fs.writeFileSync(secretFile, 'API_KEY=do_not_read', 'utf8');
      fs.writeFileSync(outsideMp3, writeId3v2Tags(Buffer.alloc(512, 0x22), { title: 'External' }));
      fs.writeFileSync(vaultMp3, writeId3v2Tags(Buffer.alloc(512, 0x33), { title: 'Vault' }));
      fs.writeFileSync(outsideSrt, '1\n00:00:01,000 --> 00:00:02,000\nHello\n', 'utf8');

      // 1. Vault subfolder allowlist blocks traversal, arbitrary subfolders, and CLI-flag payloads
      assert.equal(resolveSafeVaultSubfolder(vaultRoot, ''), fs.realpathSync(vaultRoot));
      assert.equal(resolveSafeVaultSubfolder(vaultRoot, 'YouTube'), path.join(fs.realpathSync(vaultRoot), 'YouTube'));
      assert.equal(resolveSafeVaultSubfolder(vaultRoot, '..\\Outside'), null);
      assert.equal(resolveSafeVaultSubfolder(vaultRoot, '../../Windows/System32'), null);
      assert.equal(resolveSafeVaultSubfolder(vaultRoot, '--help'), null);
      assert.equal(resolveSafeVaultSubfolder(vaultRoot, 'YouTube\0evil'), null);

      // 2. validateSafeFilePath blocks non-media extensions, UNC shares, ADS, null bytes, and leading dashes
      assert.equal(validateSafeFilePath(secretFile, { allowedExtensions: new Set(['.mp3']) }), null);
      assert.equal(validateSafeFilePath('\\\\evil-server\\share\\track.mp3', { mustExist: false }), null);
      assert.equal(validateSafeFilePath(`${vaultMp3}:hiddenstream`, { mustExist: false }), null);
      assert.equal(validateSafeFilePath('-i', { mustExist: false }), null);
      assert.equal(validateSafeFilePath(`${vaultMp3}\0.txt`, { mustExist: false }), null);
      assert.equal(validateSafeFilePath('CON', { mustExist: false }), null);
      assert.ok(validateSafeFilePath(vaultMp3, { allowedExtensions: new Set(['.mp3']) }));

      // 3. Scope isolation blocks out-of-scope media/subtitle files while permitting vault + watched + sibling subtitles
      const scope = {
        vaultRoot,
        watchedFolders: [],
        watchedFiles: [],
        allowSiblingInWatchedFileDirs: true
      };
      assert.equal(isPathAuthorizedInScope(vaultMp3, scope), true);
      assert.equal(isPathAuthorizedInScope(outsideMp3, scope), false);
      assert.equal(isPathAuthorizedInScope(outsideSrt, scope), false);

      // Adding outsideMp3 to watchedFiles authorizes it and sibling .srt in the same folder
      scope.watchedFiles.push(outsideMp3);
      assert.equal(isPathAuthorizedInScope(outsideMp3, scope), true);
      assert.equal(isPathAuthorizedInScope(outsideSrt, scope), true);
      assert.ok(validateSafeFilePath(outsideSrt, { allowedExtensions: SUBTITLE_EXTENSIONS }));

      // 3B. Server-side resolveFromTrustedRoots reconstructs paths from OS directory entries and blocks escapes/blocked segments
      const trustedResolved = resolveFromTrustedRoots(vaultMp3, [vaultRoot], {
        expect: 'file',
        allowedExtensions: new Set(['.mp3'])
      });
      assert.equal(trustedResolved, fs.realpathSync(vaultMp3));
      assert.equal(resolveFromTrustedRoots(outsideMp3, [vaultRoot], { expect: 'file' }), null);
      assert.equal(resolveFromTrustedRoots(secretFile, [outsideDir], { expect: 'file', allowedExtensions: new Set(['.mp3']) }), null);
      assert.equal(
        resolveFromTrustedRoots(path.join(vaultRoot, '..', 'Outside', 'external.mp3'), [vaultRoot], { expect: 'file' }),
        null
      );

      // 4. ID3 service rejects non-MP3 / traversal / ADS targets cleanly
      const id3Reject = updateMp3MetadataOnDisk(secretFile, { title: 'Pwned' });
      assert.equal(id3Reject.ok, false);
      assert.equal(validateSafeDirectoryPath('\\\\attacker\\c$'), null);
      assert.equal(listDirectoryEntries('\\\\attacker\\c$').entries.length, 0);

      // 5. ReDoS-safe semantic search parser handles adversarial repeated digit strings in <15ms
      const t0 = performance.now();
      const adv = parseSemanticSearchQuery(`${'123'.repeat(400)} bpm melancholic`);
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 50, `Semantic parser took too long on adversarial input: ${elapsed}ms`);
      assert.ok(adv.moodTags.includes('melancholic'));

      // 6. Strict CSP in index.html has no 'unsafe-inline' and main.cjs allows trusted fullscreen permission
      const htmlSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
      assert.equal(htmlSrc.includes("'unsafe-inline'"), false);
      assert.ok(htmlSrc.includes("object-src 'none'"));
      const mainSrc = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.cjs'), 'utf8');
      assert.ok(mainSrc.includes("'fullscreen'"), 'setPermissionRequestHandler must permit fullscreen for Theater video mode');
    } finally {
      fs.rmSync(tmpSecDir, { recursive: true, force: true });
    }
  });

  it('15. Albums Collection Engine: groups tagged albums & folder releases, computes stats, filters & sorts', () => {
    const sampleTracks = [
      {
        id: 'a1',
        title: 'Midnight City',
        artist: 'M83',
        album: "Hurry Up, We're Dreaming",
        genre: 'Synth-Pop',
        year: '2011',
        ext: 'FLAC',
        bitDepth: 24,
        bpm: 105,
        durationSec: 244,
        stars: 5,
        favorite: true,
        filePath: 'D:\\Music\\M83\\01 Midnight City.flac'
      },
      {
        id: 'a2',
        title: 'Intro',
        artist: 'M83',
        album: "Hurry Up, We're Dreaming",
        genre: 'Synth-Pop',
        year: '2011',
        ext: 'FLAC',
        bitDepth: 24,
        bpm: 95,
        durationSec: 322,
        stars: 4,
        filePath: 'D:\\Music\\M83\\02 Intro.flac'
      },
      {
        id: 'f1',
        title: 'Tokyo Cafe Jazz',
        artist: 'Local Studio Artist',
        album: '',
        ext: 'MP3',
        bpm: 88,
        durationSec: 300,
        stars: 3,
        filePath: 'C:\\Vanta\\VantaVault\\YouTube\\Tokyo Cafe.mp3'
      },
      {
        id: 'c1',
        title: 'Track 1',
        artist: 'Artist A',
        album: 'Club Compilation',
        ext: 'MP3',
        bpm: 128,
        durationSec: 200,
        filePath: 'D:\\Music\\Comp\\t1.mp3'
      },
      {
        id: 'c2',
        title: 'Track 2',
        artist: 'Artist B',
        album: 'Club Compilation',
        ext: 'MP3',
        bpm: 130,
        durationSec: 210,
        filePath: 'D:\\Music\\Comp\\t2.mp3'
      },
      {
        id: 'c3',
        title: 'Track 3',
        artist: 'Artist C',
        album: 'Club Compilation',
        ext: 'MP3',
        bpm: 126,
        durationSec: 190,
        filePath: 'D:\\Music\\Comp\\t3.mp3'
      }
    ];

    const all = buildAlbumCollections(sampleTracks, { mode: 'all' });
    assert.equal(all.length, 3);
    const m83 = all.find((g) => g.title === "Hurry Up, We're Dreaming");
    assert.ok(m83);
    assert.equal(m83.kind, 'album');
    assert.equal(m83.artist, 'M83');
    assert.equal(m83.year, '2011');
    assert.equal(m83.trackCount, 2);
    assert.equal(m83.totalDurationSec, 566);
    assert.equal(m83.avgBpm, 100);
    assert.equal(m83.avgStars, 4.5);
    assert.equal(m83.isLossless, true);

    const comp = all.find((g) => g.title === 'Club Compilation');
    assert.ok(comp);
    assert.equal(comp.isCompilation, true);
    assert.equal(comp.artist, 'Various Artists');

    const taggedOnly = buildAlbumCollections(sampleTracks, { mode: 'tagged' });
    assert.equal(taggedOnly.length, 2);
    assert.equal(taggedOnly.every((g) => g.kind === 'album'), true);

    const folderOnly = buildAlbumCollections(sampleTracks, { mode: 'folder' });
    assert.equal(folderOnly.length, 1);
    assert.equal(folderOnly[0].title, 'YouTube');

    const queried = buildAlbumCollections(sampleTracks, { mode: 'all', query: 'midnight' });
    assert.equal(queried.length, 1);
    assert.equal(queried[0].title, "Hurry Up, We're Dreaming");

    const byTracks = buildAlbumCollections(sampleTracks, { mode: 'all', sortBy: 'tracks-desc' });
    assert.equal(byTracks[0].title, 'Club Compilation');
  });

  it('16. Queue Row Click Toggle & # Column Play/Pause Indicator', () => {
    assert.equal(resolveRowClickAction({ clickedKey: 'C:\\a.mp3', loadedKey: 'C:\\a.mp3' }), 'toggle');
    assert.equal(resolveRowClickAction({ clickedKey: 'C:\\b.mp3', loadedKey: 'C:\\a.mp3' }), 'select');
    assert.equal(resolveRowClickAction({ clickedKey: 'C:\\a.mp3', loadedKey: null }), 'select');

    assert.equal(
      resolveQueueRowNumIndicator({
        index: 2,
        trackKey: 'C:\\a.mp3',
        loadedKey: 'C:\\a.mp3',
        isPlaying: true,
        pausedTrackKey: null,
        isSelected: true
      }),
      '▶'
    );
    assert.equal(
      resolveQueueRowNumIndicator({
        index: 2,
        trackKey: 'C:\\a.mp3',
        loadedKey: 'C:\\a.mp3',
        isPlaying: false,
        pausedTrackKey: 'C:\\a.mp3',
        isSelected: true
      }),
      '⏸\uFE0E'
    );
    assert.equal(
      resolveQueueRowNumIndicator({
        index: 0,
        trackKey: 'C:\\a.mp3',
        loadedKey: null,
        isPlaying: false,
        pausedTrackKey: null,
        isSelected: true
      }),
      '1'
    );
  });

  it('17. Artists Collection Engine: groups artists, prioritizes curated over generic, computes discography & filters', () => {
    const sampleTracks = [
      {
        id: 'ar1',
        title: 'Midnight City',
        artist: 'M83',
        album: "Hurry Up, We're Dreaming",
        genre: 'Synth-Pop',
        ext: 'FLAC',
        bitDepth: 24,
        bpm: 105,
        durationSec: 244,
        stars: 5,
        favorite: true,
        filePath: 'D:\\Music\\M83\\01 Midnight City.flac'
      },
      {
        id: 'ar2',
        title: 'Wait',
        artist: 'M83',
        album: "Hurry Up, We're Dreaming",
        genre: 'Synth-Pop',
        ext: 'FLAC',
        bitDepth: 24,
        bpm: 84,
        durationSec: 343,
        stars: 4,
        filePath: 'D:\\Music\\M83\\02 Wait.flac'
      },
      {
        id: 'ar3',
        title: 'Oblivion',
        artist: 'M83',
        album: 'Oblivion OST',
        genre: 'Soundtrack',
        ext: 'MP3',
        bpm: 112,
        durationSec: 356,
        stars: 5,
        filePath: 'D:\\Music\\M83\\Oblivion.mp3'
      },
      {
        id: 'ar4',
        title: 'Solo Track',
        artist: 'Aria Nova',
        album: 'Single',
        genre: 'Ambient',
        ext: 'MP3',
        bpm: 90,
        durationSec: 200,
        stars: 0,
        filePath: 'D:\\Music\\Aria\\solo.mp3'
      },
      {
        id: 'ar5',
        title: 'Vault Demo 1',
        artist: 'Local Studio Artist',
        album: '',
        ext: 'MP3',
        bpm: 120,
        durationSec: 180,
        filePath: 'C:\\Vanta\\VantaVault\\Local\\demo1.mp3'
      },
      {
        id: 'ar6',
        title: 'Vault Demo 2',
        artist: 'Local Studio Artist',
        album: '',
        ext: 'MP3',
        bpm: 124,
        durationSec: 190,
        filePath: 'C:\\Vanta\\VantaVault\\Local\\demo2.mp3'
      }
    ];

    const curated = buildArtistCollections(sampleTracks, { mode: 'all', sortBy: 'curated' });
    assert.equal(curated.length, 3);
    assert.equal(curated[0].name, 'M83');
    assert.equal(curated[curated.length - 1].name, 'Local Studio Artist');
    assert.equal(curated[curated.length - 1].isGeneric, true);

    const m83 = curated[0];
    assert.equal(m83.trackCount, 3);
    assert.equal(m83.releaseCount, 2);
    assert.equal(m83.primaryGenre, 'Synth-Pop');
    assert.equal(m83.isLossless, true);
    assert.equal(m83.avgStars, 4.7);

    const multiOnly = buildArtistCollections(sampleTracks, { mode: 'multi' });
    assert.equal(multiOnly.length, 2);
    assert.equal(multiOnly.every((a) => a.trackCount >= 2), true);

    const ratedOnly = buildArtistCollections(sampleTracks, { mode: 'rated' });
    assert.equal(ratedOnly.length, 1);
    assert.equal(ratedOnly[0].name, 'M83');

    const queried = buildArtistCollections(sampleTracks, { mode: 'all', query: 'oblivion' });
    assert.equal(queried.length, 1);
    assert.equal(queried[0].name, 'M83');
  });

  it('18. Phase 1 Signal Purity: FFmpeg Kaiser-Sinc resample helper and PitchWorklet Hermite/Hann DSP math', async () => {
    const bridgeMod = await import('../electron/services/audioBridgeService.cjs');
    const buildHighPrecisionResampleArgs =
      bridgeMod.buildHighPrecisionResampleArgs || bridgeMod.default?.buildHighPrecisionResampleArgs;
    assert.equal(typeof buildHighPrecisionResampleArgs, 'function');

    // Native PCM pass-through (44.1 -> 44.1, 96 -> 96) emits ZERO resampling filter args
    assert.deepEqual(buildHighPrecisionResampleArgs(44100, 44100), []);
    assert.deepEqual(buildHighPrecisionResampleArgs(192000, 192000), []);

    // DSD->DXD or forced sample rate conversion emits 64-bit dblp Kaiser-Sinc filter args
    const dsdArgs = buildHighPrecisionResampleArgs(2822400, 352800);
    assert.equal(dsdArgs.length, 2);
    assert.equal(dsdArgs[0], '-af');
    assert.match(
      dsdArgs[1],
      /aresample=resampler=swr:tsf=dblp:filter_type=kaiser:filter_size=256:phase_shift=12:kaiser_beta=16:cutoff=0\.95:exact_rational=1:osr=352800/
    );

    const studioDsdArgs = buildHighPrecisionResampleArgs(0, 176400, { force: true, ditherMethod: 'shibata' });
    assert.equal(studioDsdArgs[0], '-af');
    assert.match(studioDsdArgs[1], /osr=176400:dither_method=shibata/);

    const pitchMod = await import('../src/js/pitchWorklet.js');
    assert.equal(typeof pitchMod.hermiteInterpolate4, 'function');
    assert.equal(typeof pitchMod.hannWindowFromPhase, 'function');

    // Hermite passes through exact knot points and smooths midpoint accurately
    assert.equal(pitchMod.hermiteInterpolate4(0.0, 0.25, 0.75, 1.0, 0.0), 0.25);
    assert.equal(pitchMod.hermiteInterpolate4(0.0, 0.25, 0.75, 1.0, 1.0), 0.75);
    const linearMid = pitchMod.hermiteInterpolate4(-1, 0, 1, 2, 0.5);
    assert.ok(Math.abs(linearMid - 0.5) < 1e-12);

    // Complementary Hann overlap windows sum to unity across all phases
    for (const ph of [0, 0.13, 0.25, 0.37, 0.49]) {
      const sum = pitchMod.hannWindowFromPhase(ph) + pitchMod.hannWindowFromPhase(ph + 0.5);
      assert.ok(Math.abs(sum - 1.0) < 1e-12);
    }
  });

  it('19. Phase 2 PurePath 64: Native EQ/Crossfeed serialization, WASAPI vs Studio routing & Signal Path Inspector', async () => {
    const bridgeMod = await import('../electron/services/audioBridgeService.cjs');
    const serializeNativeDspConfig =
      bridgeMod.serializeNativeDspConfig || bridgeMod.default?.serializeNativeDspConfig;
    const sanitizeNativeDspSpec =
      bridgeMod.sanitizeNativeDspSpec || bridgeMod.default?.sanitizeNativeDspSpec;

    const engineMod = await import('../src/js/audioEngine.js');
    const {
      computeEffectiveEqGains,
      requiresStudioDsp,
      serializeNativeDspSpecFromState,
      buildSignalPathDescriptor
    } = engineMod;

    // 1. Native DSP serializer clamps bounds and rejects injection characters
    const flatSpec = serializeNativeDspSpecFromState({
      eqEnabled: false,
      gains: [4, 2, 0, 0, 0, 0, 0, 0, 0, 0],
      deviceProfile: 'Bit-Perfect (Flat)',
      bassBoost: false,
      bassBoostDb: 5.5,
      crossfeed: false,
      crossfeedLevelPct: 55,
      limiter: false
    });
    assert.equal(flatSpec, '0,0,0,0,0,0,0,0,0,0|0|5.5|0|55|0');
    assert.equal(sanitizeNativeDspSpec(flatSpec), flatSpec);
    assert.equal(sanitizeNativeDspSpec('0,0|0|5.5|0|55|0; rm -rf /'), '');

    const cjsSpec = serializeNativeDspConfig({
      bandGains: [20, -25, 1.5, 0, 0, 0, 0, 0, 0, 3],
      bassBoost: true,
      bassBoostDb: 12,
      crossfeed: true,
      crossfeedLevelPct: 75,
      limiter: true
    });
    assert.equal(cjsSpec, '12,-12,1.5,0,0,0,0,0,0,3|1|9|1|75|1');

    // 2. PurePath 64 keeps EQ/Profile/Bass/Crossfeed/Limiter on native WASAPI; only Spatial/Reverb/Pitch/Crossfade require Studio DSP
    const purePathState = {
      eqEnabled: true,
      gains: [2, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      deviceProfile: 'Harman Target (In-Ear)',
      bassBoost: true,
      crossfeed: true,
      limiter: true,
      spatial: false,
      exciter: false,
      reverb: false,
      karaoke: false,
      vinyl: false,
      nightMode: false,
      pitchSemitones: 0,
      playbackRate: 1.0,
      crossfadeSeconds: 0
    };
    assert.equal(requiresStudioDsp(purePathState), false);
    const effGains = computeEffectiveEqGains(purePathState);
    assert.equal(effGains[0], 5); // +2 manual + 3 Harman
    assert.equal(effGains[1], 2.5); // 0 manual + 2.5 Harman
    assert.equal(requiresStudioDsp({ ...purePathState, spatial: true }), true);
    assert.equal(requiresStudioDsp({ ...purePathState, pitchSemitones: 2 }), true);
    assert.equal(requiresStudioDsp({ ...purePathState, crossfadeSeconds: 3 }), true);

    // 3. Signal Path Descriptor reports Bit-Exact vs PurePath 64 vs DoP vs Studio DSP accurately
    const bitExactPath = buildSignalPathDescriptor({
      engineMode: 'wasapi',
      isVideo: false,
      filePath: 'C:\\Music\\track.flac',
      probe: { codec: 'FLAC', sampleRate: 96000, bitDepth: 24, channels: 2 },
      wasapiEvent: {
        mode: 'exclusive',
        sampleRate: 96000,
        bitsPerSample: 24,
        validBits: 24,
        bitExact: true,
        bufferFrames: 960,
        deviceName: 'Reference DAC'
      },
      dspState: {
        eqEnabled: false,
        gains: new Array(10).fill(0),
        deviceProfile: 'Bit-Perfect (Flat)',
        bassBoost: false,
        crossfeed: false,
        limiter: false
      },
      linearGain: 1.0,
      gaplessQueued: true
    });
    assert.equal(bitExactPath.qualityTone, 'bit_exact');
    assert.equal(bitExactPath.qualityBadge, 'BIT-EXACT LOSSLESS PATH');
    assert.match(bitExactPath.stages[1].detail, /pass-through/i);
    assert.match(bitExactPath.stages[4].detail, /0 ms Gapless Primed/);

    const purePathDesc = buildSignalPathDescriptor({
      engineMode: 'wasapi',
      isVideo: false,
      filePath: 'C:\\Music\\track.dsf',
      probe: { codec: 'DSD_LSBF_PLANAR', sampleRate: 2822400, bitDepth: 1, channels: 2 },
      wasapiEvent: {
        mode: 'exclusive',
        sampleRate: 352800,
        bitsPerSample: 32,
        validBits: 24,
        bitExact: false,
        deviceName: 'Reference DAC'
      },
      dspState: purePathState,
      linearGain: 1.0
    });
    assert.equal(purePathDesc.qualityTone, 'purepath');
    assert.match(purePathDesc.stages[1].detail, /Kaiser-Sinc.*352\.8 kHz/);
    assert.match(purePathDesc.stages[2].detail, /64-bit/i);
    assert.match(purePathDesc.stages[3].detail, /True-Peak Limiter.*TPDF Dither/);
  });

  it('20. Phase 0 Audiophile Harness: C++ --self-test, 24-bit PCM MSB fidelity, +3.5 dBFS float headroom & 64-bit Kaiser-Sinc', () => {
    const exePath = resolveWasapiEngineBinary();
    assert.ok(exePath && fs.existsSync(exePath), `Missing vanta-audio-engine.exe at ${exePath}`);
    const ffmpegBin = resolveFfmpegBinary();
    assert.ok(ffmpegBin && fs.existsSync(ffmpegBin), `Missing ffmpeg binary at ${ffmpegBin}`);

    // 1. Native C++ --self-test (RingBuffer, Bit-Exact Pcm32/Pcm24, PurePath 64 EQ/PEQ32/Convolver/BitAudit, TruePeak 4x Hermite, TPDF16, DoP, Backend Lifecycle)
    const selfTestRaw = execFileSync(exePath, ['--self-test'], { encoding: 'utf8', timeout: 10000 }).trim();
    const selfTest = JSON.parse(selfTestRaw);
    assert.equal(selfTest.ok, true, `C++ --self-test failed: ${selfTestRaw}`);
    assert.equal(selfTest.failed, 0);
    assert.ok(selfTest.passed >= 19, `Expected at least 19 C++ self-tests, got ${selfTest.passed}`);
    assert.equal(selfTest.tests.peq32AutoEqStability, true);
    assert.equal(selfTest.tests.fftConvolverDiracAndPerf192k, true);
    assert.equal(selfTest.tests.liveMetersBitAuditAndTruePeak, true);
    for (const [name, passed] of Object.entries(selfTest.tests)) {
      assert.equal(passed, true, `Expected C++ self-test "${name}" to pass`);
    }

    const tmpFixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-phase0-fixtures-'));
    try {
      // Helper to build minimal RIFF/WAVE PCM or IEEE-Float container cleanly
      const buildWavBuffer = (sampleRate, channels, bitsPerSample, audioFormatTag, payloadBuf) => {
        const blockAlign = (channels * bitsPerSample) / 8;
        const byteRate = sampleRate * blockAlign;
        const hdr = Buffer.alloc(44);
        hdr.write('RIFF', 0, 'ascii');
        hdr.writeUInt32LE(36 + payloadBuf.length, 4);
        hdr.write('WAVE', 8, 'ascii');
        hdr.write('fmt ', 12, 'ascii');
        hdr.writeUInt32LE(16, 16);
        hdr.writeUInt16LE(audioFormatTag, 20);
        hdr.writeUInt16LE(channels, 22);
        hdr.writeUInt32LE(sampleRate, 24);
        hdr.writeUInt32LE(byteRate, 28);
        hdr.writeUInt16LE(blockAlign, 32);
        hdr.writeUInt16LE(bitsPerSample, 34);
        hdr.write('data', 36, 'ascii');
        hdr.writeUInt32LE(payloadBuf.length, 40);
        return Buffer.concat([hdr, payloadBuf]);
      };

      // 2. 24-bit PCM MSB-aligned lossless extraction via FFmpeg -> pcm_s32le (0 bit loss)
      const patterns24 = [0x123456, -0x234567, 0x7fffff, -0x800000, 0x000001, -0x000001, 0x400000, -0x400000];
      const pcm24Payload = Buffer.alloc(patterns24.length * 3);
      for (let i = 0; i < patterns24.length; i++) {
        const u = patterns24[i] & 0xffffff;
        pcm24Payload[i * 3] = u & 0xff;
        pcm24Payload[i * 3 + 1] = (u >> 8) & 0xff;
        pcm24Payload[i * 3 + 2] = (u >> 16) & 0xff;
      }
      const wav24Path = path.join(tmpFixtureDir, 'bitpattern_24bit.wav');
      fs.writeFileSync(wav24Path, buildWavBuffer(48000, 2, 24, 1, pcm24Payload));

      const rawS32Out = execFileSync(
        ffmpegBin,
        ['-hide_banner', '-loglevel', 'error', '-i', wav24Path, '-vn', '-f', 's32le', '-acodec', 'pcm_s32le', '-'],
        { timeout: 8000 }
      );
      assert.equal(rawS32Out.length, patterns24.length * 4);
      for (let i = 0; i < patterns24.length; i++) {
        const s32 = rawS32Out.readInt32LE(i * 4);
        assert.equal(s32 & 0xff, 0, '24-bit source must remain clean MSB-aligned in 32-bit container');
        assert.equal(s32 >> 8, patterns24[i], `24-bit sample index ${i} must match bit-for-bit`);
      }

      // 3. +3.5 dBFS IEEE Float32 WAV headroom preservation via pcm_f64le + attenuation vs integer saturation
      const floatFrames = 1024;
      const floatPayload = Buffer.alloc(floatFrames * 2 * 4);
      const peakAmp = Math.pow(10, 3.5 / 20); // ~1.4962 (+3.5 dBFS)
      for (let f = 0; f < floatFrames; f++) {
        const v = peakAmp * Math.sin((2 * Math.PI * 1000 * f) / 44100);
        floatPayload.writeFloatLE(v, f * 8);
        floatPayload.writeFloatLE(-v, f * 8 + 4);
      }
      const wavOverPath = path.join(tmpFixtureDir, 'headroom_plus3_5dbfs.wav');
      fs.writeFileSync(wavOverPath, buildWavBuffer(44100, 2, 32, 3, floatPayload));

      // Verify raw pcm_f64le pipe keeps peaks > 1.0 unclipped so ReplayGain/DSP can attenuate cleanly
      const rawF64Out = execFileSync(
        ffmpegBin,
        ['-hide_banner', '-loglevel', 'error', '-i', wavOverPath, '-vn', '-f', 'f64le', '-acodec', 'pcm_f64le', '-'],
        { timeout: 8000 }
      );
      assert.equal(rawF64Out.length, floatFrames * 2 * 8);
      let maxF64 = 0;
      for (let i = 0; i < floatFrames * 2; i++) {
        const val = Math.abs(rawF64Out.readDoubleLE(i * 8));
        if (val > maxF64) maxF64 = val;
      }
      assert.ok(maxF64 > 1.45 && maxF64 < 1.52, `Expected unclipped +3.5 dBFS headroom in f64le, got ${maxF64}`);

      // Verify 64-bit dblp 256-tap Kaiser-Sinc (beta=16) resampling (44.1 kHz -> 96 kHz) preserves headroom without clipping or NaN
      const resampledF64Out = execFileSync(
        ffmpegBin,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          wavOverPath,
          '-vn',
          '-af',
          'volume=-4dB,aresample=resampler=swr:tsf=dblp:filter_type=kaiser:filter_size=256:phase_shift=12:kaiser_beta=16:cutoff=0.95:exact_rational=1:osr=96000',
          '-f',
          'f64le',
          '-acodec',
          'pcm_f64le',
          '-'
        ],
        { timeout: 8000 }
      );
      const outSampleCount = resampledF64Out.length / 8;
      assert.ok(outSampleCount > floatFrames * 2 * 2.1, 'Expected ~2.177x frames from 44.1 -> 96 kHz');
      let maxAttenuated = 0;
      for (let i = 0; i < outSampleCount; i++) {
        const s = resampledF64Out.readDoubleLE(i * 8);
        assert.ok(Number.isFinite(s), 'Kaiser-Sinc output must contain only finite float64 samples');
        const absS = Math.abs(s);
        if (absS > maxAttenuated) maxAttenuated = absS;
      }
      assert.ok(maxAttenuated > 0.85 && maxAttenuated <= 0.99, `Expected unclipped ~-0.5 dBFS peak after -4dB + Kaiser-Sinc, got ${maxAttenuated}`);
    } finally {
      fs.rmSync(tmpFixtureDir, { recursive: true, force: true });
    }
  });

  it('21. Phase 1 Core Transport: Endpoint --probe-caps, 64-bit f64le/rate routing, startup Pure defaults, Volume Modes & Signal Path', async () => {
    const exePath = resolveWasapiEngineBinary();
    assert.ok(exePath && fs.existsSync(exePath), `Missing vanta-audio-engine.exe at ${exePath}`);

    // 1. Live Windows endpoint --probe-caps JSON contract
    const capsRaw = execFileSync(exePath, ['--probe-caps'], { encoding: 'utf8', timeout: 8000 }).trim();
    const liveCaps = JSON.parse(capsRaw);
    assert.equal(liveCaps.ok, true, `Expected live --probe-caps ok=true, got ${capsRaw}`);
    assert.equal(typeof liveCaps.deviceId, 'string');
    assert.equal(typeof liveCaps.deviceName, 'string');
    assert.equal(typeof liveCaps.exclusiveSupported, 'boolean');
    assert.ok(Array.isArray(liveCaps.supportedRates) && liveCaps.supportedRates.length >= 1, 'Expected non-empty supportedRates');
    assert.ok([16, 24, 32].includes(liveCaps.maxBitDepth));

    // 2. Optimal Exclusive target rate selector keeps WASAPI Exclusive instead of dropping to Shared
    const bridgeMod = await import('../electron/services/audioBridgeService.cjs');
    const selectOptimalExclusiveTargetRate =
      bridgeMod.selectOptimalExclusiveTargetRate || bridgeMod.default?.selectOptimalExclusiveTargetRate;
    const selectFfmpegPipeFormat =
      bridgeMod.selectFfmpegPipeFormat || bridgeMod.default?.selectFfmpegPipeFormat;
    assert.equal(typeof selectOptimalExclusiveTargetRate, 'function');
    assert.equal(typeof selectFfmpegPipeFormat, 'function');

    const headsetCaps = {
      ok: true,
      exclusiveSupported: true,
      sharedSampleRate: 48000,
      maxBitDepth: 16,
      supportedRates: [48000]
    };
    const btRes = selectOptimalExclusiveTargetRate(44100, headsetCaps, { exclusivePreferred: true });
    assert.equal(btRes.targetRate, 48000);
    assert.equal(btRes.useExclusive, true);
    assert.equal(btRes.resampled, true);
    assert.equal(btRes.reason, 'exclusive_swr_resample');

    const dacCaps = {
      ok: true,
      exclusiveSupported: true,
      sharedSampleRate: 48000,
      maxBitDepth: 24,
      supportedRates: [48000, 88200, 96000]
    };
    // Exact native match -> untouched rate, zero resampling
    assert.deepEqual(
      selectOptimalExclusiveTargetRate(96000, dacCaps, { exclusivePreferred: true }),
      { targetRate: 96000, useExclusive: true, resampled: false, reason: 'native_rate_match' }
    );
    // 44.1k source on DAC without 44.1k native -> picks same-clock-family integer 2x (88.2 kHz)
    assert.deepEqual(
      selectOptimalExclusiveTargetRate(44100, dacCaps, { exclusivePreferred: true }),
      { targetRate: 88200, useExclusive: true, resampled: true, reason: 'exclusive_swr_resample' }
    );
    // Fixed Rate Lock overrides automatic native matching
    assert.deepEqual(
      selectOptimalExclusiveTargetRate(44100, dacCaps, { exclusivePreferred: true, fixedRateLock: true, fixedTargetRate: 96000 }),
      { targetRate: 96000, useExclusive: true, resampled: true, reason: 'fixed_rate_lock' }
    );
    // Genuine non-exclusive endpoint falls back cleanly to Shared mix rate
    assert.deepEqual(
      selectOptimalExclusiveTargetRate(96000, { ok: true, exclusiveSupported: false, sharedSampleRate: 48000, supportedRates: [] }, { exclusivePreferred: true }),
      { targetRate: 48000, useExclusive: false, resampled: true, reason: 'shared_fallback_endpoint' }
    );

    // 3. Smart FFmpeg Pipe Format routing: s32le for lossless integer pass-through, f64le for lossy/float/resampled
    const flac16 = selectFfmpegPipeFormat({ codec: 'FLAC', bitDepth: 16 }, { resampled: false });
    assert.equal(flac16.ffCodec, 'pcm_s32le');
    assert.equal(flac16.inFmt, 's32le');
    assert.equal(flac16.effectiveSrcBits, 16);

    const flac24Resampled = selectFfmpegPipeFormat({ codec: 'FLAC', bitDepth: 24 }, { resampled: true });
    assert.equal(flac24Resampled.ffCodec, 'pcm_f64le');
    assert.equal(flac24Resampled.inFmt, 'f64le');
    assert.equal(flac24Resampled.effectiveSrcBits, 32);

    const mp3Pipe = selectFfmpegPipeFormat({ codec: 'MP3', bitDepth: 0 }, { resampled: false });
    assert.equal(mp3Pipe.ffCodec, 'pcm_f64le');
    assert.equal(mp3Pipe.inFmt, 'f64le');
    assert.equal(mp3Pipe.isLossyOrFloat, true);

    // 4. Startup Profile Defaults (WASAPI + Bit-Perfect Pure), Persistence & v1 -> v2 Migration
    const fresh = resolveStartupAudioPrefs(null, null);
    assert.equal(fresh.engineMode, 'wasapi');
    assert.equal(fresh.holdWasapiOnPause, false);
    assert.equal(fresh.wasapiPushMode, false);

    const restoredStudio = resolveStartupAudioPrefs(
      JSON.stringify({ version: 2, preferredAudioEngineMode: 'dsp', holdWasapiOnPause: true, wasapiPushMode: true, wasapiBufferMs: 40, clockSwitchPreRollMs: 50, fixedRateLock: true, fixedTargetRate: 96000 }),
      null
    );
    assert.equal(restoredStudio.engineMode, 'dsp');
    assert.equal(restoredStudio.holdWasapiOnPause, true);
    assert.equal(restoredStudio.wasapiPushMode, true);
    assert.equal(restoredStudio.wasapiBufferMs, 40);
    assert.equal(restoredStudio.clockSwitchPreRollMs, 50);
    assert.equal(restoredStudio.fixedRateLock, true);
    assert.equal(restoredStudio.fixedTargetRate, 96000);

    const legacyImplicit = resolveStartupAudioPrefs(
      null,
      JSON.stringify({ eqEnabled: false, lufs: true, limiter: true, gains: new Array(10).fill(0), deviceProfile: 'Bit-Perfect (Flat)' })
    );
    assert.equal(legacyImplicit.engineMode, 'wasapi');
    assert.equal(legacyImplicit.migratePureDspDefaults, true);

    const legacyCustomStudio = resolveStartupAudioPrefs(
      null,
      JSON.stringify({ eqEnabled: true, spatial: true, lufs: true, limiter: true, gains: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    );
    assert.equal(legacyCustomStudio.engineMode, 'dsp');
    assert.equal(legacyCustomStudio.migratePureDspDefaults, false);

    // 5. Volume Mode Gain Matrix & Honest Signal Path Reporting (SW Volume vs HW Volume vs Shared Fallback vs XRUNs)
    assert.equal(computeWasapiGainFactor({ volumeMode: 'auto', windowsVolumeLinked: true, deviceHwVolumeSupport: 3, masterVolumeLinear: 0.4, replayGainLinear: 1.0 }), 1.0);
    assert.equal(computeWasapiGainFactor({ volumeMode: 'auto', windowsVolumeLinked: true, deviceHwVolumeSupport: 0, masterVolumeLinear: 0.4, replayGainLinear: 1.0 }), 0.4);
    assert.equal(computeWasapiGainFactor({ volumeMode: 'software', windowsVolumeLinked: true, deviceHwVolumeSupport: 3, masterVolumeLinear: 0.5, replayGainLinear: 0.8 }), 0.4);
    assert.equal(computeWasapiGainFactor({ volumeMode: 'fixed0db', windowsVolumeLinked: true, deviceHwVolumeSupport: 0, masterVolumeLinear: 0.25, replayGainLinear: 1.0 }), 1.0);

    const swVolPath = buildSignalPathDescriptor({
      engineMode: 'wasapi',
      filePath: 'C:\\Music\\track.flac',
      probe: { codec: 'FLAC', sampleRate: 44100, bitDepth: 24, channels: 2 },
      wasapiEvent: { mode: 'exclusive', pushMode: true, sampleRate: 48000, bitsPerSample: 16, validBits: 16, inFmt: 'f64le', bitExact: false, xrunCount: 2, deviceName: 'JBL Buds' },
      ratePlan: btRes,
      volumeMode: 'software',
      preRollMs: 50,
      linearGain: 0.5,
      dspState: { eqEnabled: false, gains: new Array(10).fill(0), limiter: false, lufs: false }
    });
    assert.equal(swVolPath.qualityTone, 'purepath');
    assert.equal(swVolPath.xrunCount, 2);
    assert.match(swVolPath.stages[1].detail, /256-tap, beta=16/);
    assert.match(swVolPath.stages[2].detail, /64-Bit Software Volume/);
    assert.match(swVolPath.stages[3].title, /24->16 TPDF Dither/);
    assert.match(swVolPath.stages[3].spec, /Pre-Roll 50 ms/);
    assert.match(swVolPath.stages[4].detail, /Push Timer/);
    assert.match(swVolPath.stages[4].spec, /XRUNs: 2/);

    const sharedFallbackPath = buildSignalPathDescriptor({
      engineMode: 'wasapi',
      filePath: 'C:\\Music\\track.flac',
      probe: { codec: 'FLAC', sampleRate: 96000, bitDepth: 24, channels: 2 },
      wasapiEvent: { mode: 'shared', sampleRate: 48000, bitsPerSample: 32, validBits: 24, bitExact: false, xrunCount: 0, deviceName: 'Generic Endpoint' },
      ratePlan: { targetRate: 48000, useExclusive: false, resampled: true, reason: 'shared_fallback_endpoint' },
      linearGain: 1.0,
      dspState: { eqEnabled: false, gains: new Array(10).fill(0), limiter: false, lufs: false }
    });
    assert.equal(sharedFallbackPath.qualityTone, 'shared');
    assert.equal(sharedFallbackPath.qualityBadge, 'WASAPI SHARED FALLBACK');
  });

  it('22. Phase 2 Audiophile Harness: ReplayGain 2.0 Tagging/Math, ASIO Backend, WavPack DSD, SACD ISO & Signal Path', async () => {
    const exePath = resolveWasapiEngineBinary();
    const ffmpegBin = resolveFfmpegBinary();
    assert.ok(exePath && fs.existsSync(exePath));
    assert.ok(ffmpegBin && fs.existsSync(ffmpegBin));

    // 1. ReplayGain 2.0 pure helpers & clip-protected math
    assert.equal(parseReplayGainDbValue(' -7.45 dB '), -7.45);
    assert.equal(parseReplayGainDbValue('+3.20 dB'), 3.2);
    assert.equal(parseReplayGainPeakValue('0.988123'), 0.988123);
    assert.equal(formatReplayGainDb(-7.4), '-7.40 dB');
    assert.equal(formatReplayGainPeak(0.95), '0.950000');

    const bypassedRg = resolveReplayGain2({ enabled: false, mode: 'track', targetLufs: -18, tags: { replayGainTrackGainDb: -6 } });
    assert.equal(bypassedRg.linearGain, 1.0);
    assert.equal(bypassedRg.appliedDb, 0);

    const album18 = resolveReplayGain2({
      enabled: true,
      mode: 'album',
      targetLufs: -18,
      tags: { replayGainTrackGainDb: -4.0, replayGainTrackPeak: 0.9, replayGainAlbumGainDb: -6.0, replayGainAlbumPeak: 0.95 },
      clipProtect: true
    });
    assert.equal(album18.appliedDb, -6);
    assert.equal(album18.source, 'tag_album');

    const album14 = resolveReplayGain2({
      enabled: true,
      mode: 'album',
      targetLufs: -14,
      tags: { replayGainAlbumGainDb: -6.0, replayGainAlbumPeak: 0.5 },
      clipProtect: true
    });
    assert.equal(album14.appliedDb, -2); // -6 dB @ -18 ref -> -2 dB @ -14 ref

    const peakCapped = resolveReplayGain2({
      enabled: true,
      mode: 'track',
      targetLufs: -18,
      tags: { replayGainTrackGainDb: 8.0, replayGainTrackPeak: 0.9 },
      clipProtect: true
    });
    assert.ok(peakCapped.linearGain * 0.9 <= 0.945, `Expected clip protection to cap peak gain, got linearGain=${peakCapped.linearGain}`);

    const albumSummary = computeAlbumLoudnessSummary([
      { integratedLufs: -12.0, truePeakDbfs: -0.5, durationSec: 180 },
      { integratedLufs: -20.0, truePeakDbfs: -3.0, durationSec: 60 }
    ], -18.0);
    assert.ok(albumSummary && albumSummary.albumLufs > -16 && albumSummary.albumLufs < -12);
    assert.ok(albumSummary.albumGainDb < 0);

    // 2. Startup v2 prefs persist ASIO fields cleanly
    const asioPrefs = resolveStartupAudioPrefs(
      JSON.stringify({ version: 2, preferredAudioEngineMode: 'wasapi', outputBackend: 'asio', asioDriver: 'Realtek ASIO', asioRawDsd: true }),
      null
    );
    assert.equal(asioPrefs.outputBackend, 'asio');
    assert.equal(asioPrefs.asioDriver, 'Realtek ASIO');
    assert.equal(asioPrefs.asioRawDsd, true);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-phase2-fixtures-'));
    try {
      // 3. Atomic MP3 ID3v2 TXXX & FLAC VORBIS_COMMENT ReplayGain 2.0 writes + Album EBU R128 scan
      const mp3Path = path.join(tmpDir, 'rg_track1.mp3');
      const flac1Path = path.join(tmpDir, 'rg_album1.flac');
      const flac2Path = path.join(tmpDir, 'rg_album2.flac');
      const wvPcmPath = path.join(tmpDir, 'pcm_test.wv');

      execFileSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', mp3Path], { stdio: 'ignore', timeout: 15000 });
      execFileSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4', '-af', 'volume=0.6', '-ar', '48000', '-ac', '2', '-c:a', 'flac', flac1Path], { stdio: 'ignore', timeout: 15000 });
      execFileSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.4', '-af', 'volume=0.2', '-ar', '48000', '-ac', '2', '-c:a', 'flac', flac2Path], { stdio: 'ignore', timeout: 15000 });
      execFileSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=523.25:duration=0.25', '-ar', '48000', '-ac', '2', '-c:a', 'wavpack', wvPcmPath], { stdio: 'ignore', timeout: 15000 });

      const mp3HashBefore = computeAudioPayloadFingerprint(mp3Path);
      const mp3Updated = updateMp3MetadataOnDisk(mp3Path, {
        title: 'RG2 MP3 Master',
        artist: 'VANTA Test',
        replayGainTrackGainDb: -7.45,
        replayGainTrackPeak: 0.988123,
        replayGainAlbumGainDb: -6.12,
        replayGainAlbumPeak: 0.995
      });
      assert.equal(mp3Updated.ok, true);
      assert.equal(computeAudioPayloadFingerprint(mp3Path), mp3HashBefore);
      const mp3Tags = readId3v2Tags(fs.readFileSync(mp3Path));
      assert.equal(mp3Tags.replayGainTrackGainDb, -7.45);
      assert.equal(mp3Tags.replayGainAlbumGainDb, -6.12);
      assert.ok(Math.abs(mp3Tags.replayGainTrackPeak - 0.988123) < 1e-6);

      // Verify FLAC STREAMINFO (bytes 4..41) + trailing audio bytes remain bit-identical after VORBIS_COMMENT patch
      const parseFlacAudioStart = (buf) => {
        let pos = 4;
        while (pos + 4 <= buf.length) {
          const hdr = buf[pos];
          const isLast = (hdr & 0x80) !== 0;
          const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
          pos += 4 + len;
          if (isLast) return pos;
        }
        return -1;
      };
      const flacOrigBuf = fs.readFileSync(flac1Path);
      const origStreamInfo = flacOrigBuf.subarray(8, 42);
      const origAudioFrames = flacOrigBuf.subarray(parseFlacAudioStart(flacOrigBuf));

      const flacPatchedOk = updateFlacVorbisTagsOnDisk(flac1Path, {
        artist: 'VANTA Studio',
        replayGainTrackGainDb: -8.25,
        replayGainTrackPeak: 0.912345,
        replayGainAlbumGainDb: -7.8,
        replayGainAlbumPeak: 0.995
      });
      assert.equal(flacPatchedOk.ok, true);
      const flacNewBuf = fs.readFileSync(flac1Path);
      const newAudioStart = parseFlacAudioStart(flacNewBuf);
      assert.ok(newAudioStart > 42);
      assert.deepEqual(flacNewBuf.subarray(8, 42), origStreamInfo, 'FLAC STREAMINFO must remain identical');
      assert.deepEqual(flacNewBuf.subarray(newAudioStart), origAudioFrames, 'FLAC audio frames must remain bit-identical');
      const flacMeta = readFlacMetadataFromFile(flac1Path);
      assert.equal(flacMeta.artist, 'VANTA Studio');
      assert.equal(flacMeta.replayGainTrackGainDb, -8.25);
      assert.equal(flacMeta.replayGainAlbumGainDb, -7.8);

      const rgAnalyze = await analyzeAlbumReplayGain([
        { filePath: flac1Path, durationSec: 0.4 },
        { filePath: flac2Path, durationSec: 0.4 }
      ], { targetLufs: -18.0, writeTags: true });
      assert.equal(rgAnalyze.ok, true);
      assert.equal(rgAnalyze.tracks.length, 2);
      assert.equal(rgAnalyze.tracks.filter((t) => t.taggedOk).length, 2);
      assert.ok(Number.isFinite(rgAnalyze.albumSummary?.albumLufs));
      assert.equal(rgAnalyze.tracks[0].albumGainDb, rgAnalyze.tracks[1].albumGainDb);
      assert.ok(rgAnalyze.tracks[1].trackGainDb > rgAnalyze.tracks[0].trackGainDb, 'Quieter track should receive higher positive/less-negative ReplayGain');
      const diskFlac2Tags = await readReplayGainTagsForFile(flac2Path);
      assert.equal(diskFlac2Tags.replayGainAlbumGainDb, rgAnalyze.albumSummary.albumGainDb);

      // 4. ASIO enumeration contract
      const asioCliRaw = execFileSync(exePath, ['--list-asio-devices'], { encoding: 'utf8', timeout: 8000 }).trim();
      const asioCli = JSON.parse(asioCliRaw);
      assert.ok(Array.isArray(asioCli));
      const asioSvc = await listAsioDevices();
      assert.ok(Array.isArray(asioSvc));
      assert.equal(asioSvc.length, asioCli.length);

      // 5. WavPack DSD vs PCM inspection + FFmpeg probe parser
      const wvPcmInfo = inspectWavPackDsdHeader(wvPcmPath);
      assert.equal(wvPcmInfo.isWvDsd, false);
      assert.ok(wvPcmInfo.blockSamples > 0);

      const wvDsdPath = path.join(tmpDir, 'synthetic_dsd.wv');
      const wvDsdHdr = Buffer.alloc(64);
      wvDsdHdr.write('wvpk', 0, 'ascii');
      wvDsdHdr.writeUInt32LE(56, 4); // ckSize
      wvDsdHdr.writeUInt16LE(0x0410, 8); // version
      wvDsdHdr.writeUInt32LE(0x80000000 >>> 0, 24); // flags bit 31 = DSD audio
      fs.writeFileSync(wvDsdPath, wvDsdHdr);
      const wvDsdInfo = inspectWavPackDsdHeader(wvDsdPath);
      assert.equal(wvDsdInfo.isWvDsd, true);

      const wvProbe = parseFfmpegProbeOutput(
        '  Duration: 00:03:15.00, start: 0.000000\n  Stream #0:0: Audio: wavpack, 2822400 Hz, stereo, dsd_lsbf\n',
        wvDsdPath
      );
      assert.equal(wvProbe.codec, 'DSD_WAVPACK');
      assert.equal(wvProbe.sampleRate, 2822400);
      assert.equal(wvProbe.bitDepth, 1);

      // 6. SACD ISO validation + ScarletBook TOC parsing + catalog track generation
      assert.equal(SACD_ISO_EXTENSIONS.has('.iso'), true);
      const nonSacdIso = path.join(tmpDir, 'data_disc.iso');
      fs.writeFileSync(nonSacdIso, Buffer.alloc(2048 * 4, 0));
      assert.equal(validateSafeSacdIsoPath(nonSacdIso), null);
      assert.equal(validateSafeSacdIsoPath('\\\\server\\share\\disc.iso'), null);

      const sacdIsoPath = path.join(tmpDir, 'synthetic_sacd.iso');
      // Build 520 * 2048 byte ISO matching SacdIsoReader layout: SACDMTOC @ LSN 510, TWOCHTOC @ 512, SACDTRL1 @ 513, SACDTRL2 @ 514, SACDTTxt @ 515, audio @ 516..517
      const isoBuf = Buffer.alloc(520 * 2048, 0);
      const mtocOff = 510 * 2048;
      isoBuf.write('SACDMTOC', mtocOff, 'ascii');
      isoBuf[mtocOff + 8] = 1; // major
      isoBuf[mtocOff + 9] = 20; // minor
      isoBuf.write('VANTA-SACD-001', mtocOff + 24, 'ascii');
      isoBuf.writeUInt32BE(512, mtocOff + 64); // area_1_toc_1_start
      isoBuf.writeUInt16BE(4, mtocOff + 84);   // area_1_toc_size (sectors)

      // TWOCHTOC @ LSN 512
      const atocOff = 512 * 2048;
      isoBuf.write('TWOCHTOC', atocOff, 'ascii');
      isoBuf[atocOff + 20] = 4;  // fs code -> 2822400 Hz
      isoBuf[atocOff + 21] = 2;  // frame_format = raw DSD (0 = DST)
      isoBuf[atocOff + 32] = 2;  // channels

      // SACDTRL1 @ LSN 513 (toc sector 1)
      const trl1Off = 513 * 2048;
      isoBuf.write('SACDTRL1', trl1Off, 'ascii');
      isoBuf.writeUInt32BE(516, trl1Off + 8);           // track_start_lsn[0]
      isoBuf.writeUInt32BE(2, trl1Off + 8 + 255 * 4);   // track_length_lsn[0]

      // SACDTRL2 @ LSN 514 (toc sector 2)
      const trl2Off = 514 * 2048;
      isoBuf.write('SACDTRL2', trl2Off, 'ascii');
      isoBuf[trl2Off + 8 + 255 * 4 + 1] = 2; // 2 sec duration

      // SACDTTxt @ LSN 515 (toc sector 3)
      const ttxtOff = 515 * 2048;
      isoBuf.write('SACDTTxt', ttxtOff, 'ascii');
      isoBuf.writeUInt16BE(520, ttxtOff + 8);
      const ttxtPayload = Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from('Time Capsule SACD\0', 'utf8'),
        Buffer.from([0x02]),
        Buffer.from('ScarletBook Lab\0', 'utf8'),
        Buffer.from([0x00])
      ]);
      ttxtPayload.copy(isoBuf, ttxtOff + 520);

      // Raw DSD audio sectors @ LSN 516..517 (1 packet of 256 bytes each -> 512 DSD octet bytes)
      for (const lsn of [516, 517]) {
        const sOff = lsn * 2048;
        isoBuf[sOff] = (1 << 5); // pktCount = 1, frmCount = 0, dstEnc = 0
        isoBuf.writeUInt16BE((1 << 15) | (2 << 11) | 256, sOff + 1); // frameStart=1, DATA_TYPE_AUDIO=2, len=256
        for (let bi = 0; bi < 256; bi++) {
          isoBuf[sOff + 3 + bi] = (bi & 1) ? 0xaa : 0x55;
        }
      }

      fs.writeFileSync(sacdIsoPath, isoBuf);
      assert.equal(validateSafeSacdIsoPath(sacdIsoPath), sacdIsoPath);

      const sacdProbeRes = await listSacdIsoTracks(sacdIsoPath);
      assert.equal(sacdProbeRes.ok, true, `SACD listSacdIsoTracks failed: ${JSON.stringify(sacdProbeRes)}`);
      assert.equal(sacdProbeRes.areas.length, 1);
      assert.equal(sacdProbeRes.areas[0].tracks[0].title, 'Time Capsule SACD');
      assert.equal(sacdProbeRes.areas[0].tracks[0].artist, 'ScarletBook Lab');
      assert.equal(sacdProbeRes.areas[0].tracks[0].durationSec, 2);

      const catTracks = buildSacdCatalogTracks(sacdIsoPath, sacdProbeRes);
      assert.equal(catTracks.length, 1);
      assert.equal(catTracks[0].sacdArea, 0);
      assert.equal(catTracks[0].sacdTrack, 1);
      assert.equal(catTracks[0].title, 'Time Capsule SACD');
      assert.equal(catTracks[0].audioCodec, 'DSD_SACD');

      // Extract valid Philips DSDIFF stream via --sacd-extract-dff and verify FFmpeg -f iff decode
      const dffBuf = execFileSync(exePath, ['--sacd-extract-dff', sacdIsoPath, '--sacd-area', '0', '--sacd-track', '1'], { timeout: 10000 });
      assert.equal(dffBuf.subarray(0, 4).toString('ascii'), 'FRM8');
      assert.equal(dffBuf.subarray(12, 16).toString('ascii'), 'DSD ');
      const dffOutPath = path.join(tmpDir, 'sacd_track1.dff');
      fs.writeFileSync(dffOutPath, dffBuf);
      const decodedPcm = execFileSync(ffmpegBin, ['-v', 'error', '-y', '-f', 'iff', '-i', dffOutPath, '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'], { timeout: 10000 });
      assert.ok(decodedPcm.length > 0, 'Expected FFmpeg -f iff to decode extracted SACD DSDIFF stream to PCM');

      // 7. Signal Path Descriptor coverage for ASIO PCM, ASIO Native Raw DSD512, SACD ISO & ReplayGain 2.0
      const asioRawPath = buildSignalPathDescriptor({
        engineMode: 'wasapi',
        outputBackend: 'asio',
        filePath: 'C:\\Music\\Reference.dsf',
        probe: { codec: 'DSD_LSBF_PLANAR', sampleRate: 22579200, bitDepth: 1, channels: 2 },
        wasapiEvent: { mode: 'asio_dsd_raw', dsdRate: 'DSD512', sampleRate: 22579200, deviceName: 'iFi USB ASIO', bufferFrames: 512, xrunCount: 0 },
        dspState: { eqEnabled: false, gains: new Array(10).fill(0), lufs: false, limiter: false },
        linearGain: 1.0
      });
      assert.equal(asioRawPath.qualityTone, 'dop');
      assert.equal(asioRawPath.qualityBadge, 'ASIO NATIVE RAW DSD BITSTREAM');
      assert.equal(asioRawPath.summaryLabel, 'ASIO RAW DSD512');
      assert.equal(asioRawPath.stages.length, 4);
      assert.match(asioRawPath.stages[1].detail, /DSD512/);
      assert.match(asioRawPath.stages[3].detail, /Isolated ASIO Host · Native Raw DSD/);

      const asioRgPath = buildSignalPathDescriptor({
        engineMode: 'wasapi',
        outputBackend: 'asio',
        filePath: sacdIsoPath,
        sacdArea: 1,
        sacdTrack: 2,
        probe: { codec: 'SACD DST', sampleRate: 2822400, bitDepth: 1, channels: 2, sacdArea: 1, sacdTrack: 2 },
        wasapiEvent: { mode: 'asio', sampleRate: 352800, bitsPerSample: 32, validBits: 24, bitExact: false, deviceName: 'Realtek ASIO' },
        replayGainInfo: { linearGain: 0.5, appliedDb: -6.02, source: 'tag_album', referenceLufs: -18 },
        dspState: { eqEnabled: false, gains: new Array(10).fill(0), lufs: true, replayGainMode: 'album', replayGainTargetLufs: -18, limiter: true },
        linearGain: 0.5
      });
      assert.equal(asioRgPath.stages[0].title, 'SACD ISO ScarletBook Container');
      assert.match(asioRgPath.stages[1].detail, /ScarletBook \+ DST/);
      assert.match(asioRgPath.stages[2].detail, /ReplayGain 2\.0 \(Album @ -18 LUFS, -6\.0 dB\)/);
      assert.match(asioRgPath.summaryLabel, /PUREPATH 64 · ASIO/);

      const wvSignalPath = buildSignalPathDescriptor({
        engineMode: 'dsp',
        filePath: wvDsdPath,
        probe: wvProbe,
        dspState: { eqEnabled: false, gains: new Array(10).fill(0), lufs: true, replayGainMode: 'track', replayGainTargetLufs: -14, limiter: true },
        replayGainInfo: { linearGain: 0.7943, appliedDb: -2.0, source: 'tag_track', referenceLufs: -14 }
      });
      assert.match(wvSignalPath.stages[0].title, /WavPack DSD Lossless Container/);
      assert.match(wvSignalPath.stages[1].detail, /WavPack DSD 64-bit dblp Kaiser-Sinc/);
      assert.match(wvSignalPath.stages[2].detail, /ReplayGain 2\.0 \(Track @ -14 LUFS/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('23. Phase 3 Precision DSP: AutoEQ Parser/PEQ, FFT Convolver IR Header/Resampler, Live Bit-Audit & Double-Blind ABX Stats', async () => {
    const engineMod = await import('../src/js/audioEngine.js');
    const secMod = require('../electron/services/pathSecurityService.cjs');
    const bridgeMod = require('../electron/services/audioBridgeService.cjs');

    assert.equal(secMod.PEQ_TXT_EXTENSIONS.has('.txt'), true);
    assert.equal(secMod.CONVOLVER_IR_EXTENSIONS.has('.wav'), true);

    // 1. EqualizerAPO / AutoEQ .txt parsing + 32-band cap + wire serialization/sanitization
    const autoEqSample = [
      'Preamp: -6.4 dB',
      'Filter 1: ON LSC Fc 105 Hz Gain 5.8 dB Q 0.70',
      'Filter 2: ON PK Fc 2140 Hz Gain -3.2 dB Q 1.45',
      'Filter 3: ON HSC Fc 10000 Hz Gain -1.5 dB Q 0.71',
      'Filter 4: ON LPQ Fc 18500 Hz Q 0.707',
      'Filter 5: ON HPQ Fc 22 Hz Q 0.707',
      'Filter 6: ON NO Fc 50 Hz Q 8.0',
      'Filter 7: ON AP Fc 1000 Hz Q 1.0',
      'Filter 8: OFF PK Fc 500 Hz Gain 4.0 dB Q 1.0',
      'Filter 9: ON None Fc 800 Hz Gain 2.0 dB Q 1.0'
    ].join('\n');
    const parsedPeq = engineMod.parseAutoEqTxt(autoEqSample);
    assert.equal(parsedPeq.preampDb, -6.4);
    assert.equal(parsedPeq.bands.length, 7);
    assert.deepEqual(
      parsedPeq.bands.map((b) => b.type),
      ['LSC', 'PK', 'HSC', 'LPQ', 'HPQ', 'NO', 'AP']
    );

    // Cap at 32 filters
    const manyFilters = Array.from({ length: 40 }, (_, i) => `Filter ${i + 1}: ON PK Fc ${100 + i * 20} Hz Gain 1.0 dB Q 1.41`).join('\n');
    const cappedPeq = engineMod.parseAutoEqTxt(`Preamp: -2.0 dB\n${manyFilters}`);
    assert.equal(cappedPeq.bands.length, 32);

    const wireSpec = engineMod.serializePeqWireSpec({
      peqEnabled: true,
      peqPreampDb: parsedPeq.preampDb,
      peqBands: parsedPeq.bands
    });
    assert.ok(wireSpec.startsWith('-6.4;LSC,105,0.7,5.8;PK,2140,1.45,-3.2'));
    assert.equal(engineMod.serializePeqWireSpec(parsedPeq), wireSpec);
    assert.equal(bridgeMod.sanitizePeqWireSpec(wireSpec), wireSpec);
    assert.equal(bridgeMod.sanitizePeqWireSpec('-6.4;PK,1000,2,1;rm -rf'), '');
    assert.equal(
      engineMod.serializePeqWireSpec({ peqEnabled: false, peqPreampDb: -6.4, peqBands: parsedPeq.bands }),
      ''
    );

    // 2. WAV IR Header validation & FFmpeg 64-bit dblp Kaiser-Sinc IR pre-resampling cache
    const buildTestWav = (sr, ch, bits, tag, frames) => {
      const blockAlign = (ch * bits) / 8;
      const byteRate = sr * blockAlign;
      const dataBytes = frames * blockAlign;
      const buf = Buffer.alloc(44 + dataBytes);
      buf.write('RIFF', 0, 'ascii');
      buf.writeUInt32LE(36 + dataBytes, 4);
      buf.write('WAVE', 8, 'ascii');
      buf.write('fmt ', 12, 'ascii');
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(tag, 20);
      buf.writeUInt16LE(ch, 22);
      buf.writeUInt32LE(sr, 24);
      buf.writeUInt32LE(byteRate, 28);
      buf.writeUInt16LE(blockAlign, 32);
      buf.writeUInt16LE(bits, 34);
      buf.write('data', 36, 'ascii');
      buf.writeUInt32LE(dataBytes, 40);
      // Put a unit Dirac sample on frame 0 ch 0
      if (tag === 3 && bits === 32) {
        buf.writeFloatLE(1.0, 44);
      } else if (tag === 1 && bits === 16) {
        buf.writeInt16LE(16384, 44);
      }
      return buf;
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-phase3-fixtures-'));
    let cachedResampledIr = null;
    try {
      const ir44Path = path.join(tmpDir, 'room_44k_stereo.wav');
      const ir4chPath = path.join(tmpDir, 'true_stereo_4ch.wav');
      const ir6chPath = path.join(tmpDir, 'invalid_6ch.wav');
      const badHdrPath = path.join(tmpDir, 'corrupt.wav');

      fs.writeFileSync(ir44Path, buildTestWav(44100, 2, 16, 1, 256));
      fs.writeFileSync(ir4chPath, buildTestWav(48000, 4, 32, 3, 128));
      fs.writeFileSync(ir6chPath, buildTestWav(48000, 6, 16, 1, 64));
      fs.writeFileSync(badHdrPath, Buffer.from('NOT_A_RIFF_WAVE_FILE_AT_ALL_00000000000000000000'));

      const hdr44 = bridgeMod.inspectWavHeader(ir44Path);
      assert.equal(hdr44.ok, true);
      assert.equal(hdr44.sampleRate, 44100);
      assert.equal(hdr44.channels, 2);
      assert.equal(hdr44.frames, 256);

      const hdr4ch = bridgeMod.inspectWavHeader(ir4chPath);
      assert.equal(hdr4ch.ok, true);
      assert.equal(hdr4ch.channels, 4);

      assert.equal(bridgeMod.inspectWavHeader(ir6chPath).ok, false);
      assert.equal(bridgeMod.inspectWavHeader(badHdrPath).ok, false);
      assert.equal(bridgeMod.inspectWavHeader('\\\\server\\share\\ir.wav').ok, false);

      const passthroughIr = await bridgeMod.prepareConvolutionIrFile(ir44Path, 44100);
      assert.equal(passthroughIr.ok, true);
      assert.equal(passthroughIr.resampled, false);
      assert.equal(passthroughIr.preparedPath, ir44Path);

      const upsampledIr = await bridgeMod.prepareConvolutionIrFile(ir44Path, 96000);
      assert.equal(upsampledIr.ok, true);
      assert.equal(upsampledIr.resampled, true);
      assert.equal(upsampledIr.info.sampleRate, 96000);
      assert.equal(upsampledIr.info.bitsPerSample, 64);
      assert.ok(fs.existsSync(upsampledIr.preparedPath));
      cachedResampledIr = upsampledIr.preparedPath;
    } finally {
      if (cachedResampledIr && fs.existsSync(cachedResampledIr)) {
        fs.rmSync(cachedResampledIr, { force: true });
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    // 3. Double-Blind ABX Exact Binomial Statistics & Sequence Generation
    assert.equal(engineMod.computeAbxBinomialPValue(12, 12), 0.000244);
    assert.equal(engineMod.computeAbxBinomialPValue(10, 12), 0.019287);
    assert.ok(engineMod.computeAbxBinomialPValue(6, 12) > 0.5);

    const sigVerdict = engineMod.evaluateAbxVerdict({ correct: 11, total: 12, labelA: 'AutoEQ ON', labelB: 'Bit-Exact' });
    assert.equal(sigVerdict.significant, true);
    assert.ok(sigVerdict.confidencePct >= 99.6);
    assert.match(sigVerdict.summary, /Audible difference detected/);

    const nullVerdict = engineMod.evaluateAbxVerdict({ correct: 6, total: 12, labelA: 'A', labelB: 'B' });
    assert.equal(nullVerdict.significant, false);
    assert.match(nullVerdict.summary, /No statistically significant difference/);

    const abxSeq = engineMod.generateAbxTrialSequence(8, (n) => Array.from({ length: n }, (_, i) => i));
    assert.deepEqual(abxSeq, ['A', 'B', 'A', 'B', 'A', 'B', 'A', 'B']);

    // 4. Live Bit-Audit Summary & Signal Path Descriptor Phase 3 Stages
    const paddedAudit = engineMod.computeLiveBitAuditSummary({
      telemetry: { truePeakDbtp: -0.4, crestDb: 11.2, drDb: 11.4, activeBits: 16, srcActiveBits: 16 },
      probe: { bitDepth: 24, sampleRate: 96000 },
      wasapiEvt: { bitExact: true, validBits: 24, bitsPerSample: 32 }
    });
    assert.equal(paddedAudit.bitAuditTone, 'warn');
    assert.match(paddedAudit.bitAuditText, /16-in-24 Padded/);
    assert.equal(paddedAudit.truePeakText, '-0.4 dBTP');
    assert.match(paddedAudit.crestDrText, /DR 11\.4 dB/);

    const true24Audit = engineMod.computeLiveBitAuditSummary({
      telemetry: { truePeakDbtp: -1.2, crestDb: 13.0, drDb: 13.5, activeBits: 24, srcActiveBits: 24 },
      probe: { bitDepth: 24, sampleRate: 192000 },
      wasapiEvt: { bitExact: true, validBits: 24, bitsPerSample: 32 }
    });
    assert.equal(true24Audit.bitAuditTone, 'bit_exact');
    assert.match(true24Audit.bitAuditText, /24-bit Active -> 24-bit Wire/);

    const convPath = engineMod.buildSignalPathDescriptor({
      engineMode: 'wasapi',
      filePath: 'C:\\Music\\StudioMaster.flac',
      probe: { codec: 'FLAC', sampleRate: 96000, bitDepth: 24, channels: 2 },
      wasapiEvent: { mode: 'exclusive', sampleRate: 96000, bitsPerSample: 32, validBits: 24, bitExact: false, deviceName: 'Reference DAC' },
      dspState: {
        eqEnabled: false,
        gains: new Array(10).fill(0),
        peqEnabled: true,
        peqName: 'HD650',
        peqBands: parsedPeq.bands,
        convolverEnabled: true,
        convolverPath: 'C:\\Vanta\\room.wav',
        convolverName: 'RoomCorrection.wav',
        convolverWetPct: 85,
        lufs: false,
        limiter: false
      },
      convolverActive: true,
      liveTelemetry: { truePeakDbtp: -0.4, crestDb: 12.1, drDb: 12.3, activeBits: 24, srcActiveBits: 24 },
      linearGain: 1.0
    });
    assert.equal(convPath.qualityTone, 'purepath');
    assert.match(convPath.stages[2].detail, /AutoEQ PEQ \(HD650 · 7 bands\)/);
    assert.match(convPath.stages[2].detail, /FFT Convolver \(RoomCorrection\.wav · 85%\)/);
    assert.equal(convPath.bitAudit.truePeakText, '-0.4 dBTP');
  });

  it('24. Audio & Video Timeline Sync: Native Range vs FFmpeg Stream Routing & Clean Media Element Rebinding', async () => {
    const { VantaAudioEngine, requiresStudioFfmpegStream } = await import('../src/js/audioEngine.js');

    // 1. Chromium-native formats (MP3/FLAC/WAV/M4A/OGG/OPUS & direct MP4) must NOT route seeks through FFmpeg pipes
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Music\\Soy el Eco.mp3', isVideo: false }), false);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Music\\Track.flac', isVideo: false }), false);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Music\\Track.wav', isVideo: false }), false);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Video\\Clip.mp4', isVideo: true }, 'direct'), false);

    // Lossless/DSD non-native audio, SACD ISO, and FFmpeg-remuxed/transcoded video must use FFmpeg streams
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Music\\Master.dsf', isVideo: false }), true);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Music\\Master.alac', isVideo: false }), true);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Music\\Disc.iso', sacdTrack: 1, isVideo: false }), true);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Video\\Movie.mkv', isVideo: true }, 'remux-copy'), true);
    assert.equal(requiresStudioFfmpegStream({ filePath: 'D:\\Video\\Movie.avi', isVideo: true }, 'transcode-h264'), true);

    // 2. Media element cloning during WASAPI teardown must strip stale vantaBound flags & notify rebind callback
    const makeMockMediaEl = (initialAttrs = {}) => {
      const attrs = { ...initialAttrs };
      const el = {
        paused: false,
        src: 'vanta-media://local?path=a.mp3',
        parentNode: {},
        pause() { this.paused = true; },
        removeAttribute(k) { delete attrs[k]; if (k === 'src') this.src = ''; },
        getAttribute(k) { return attrs[k]; },
        cloneNode() { return makeMockMediaEl({ ...attrs }); },
        replaceWith(nextEl) { this._replacedBy = nextEl; }
      };
      return el;
    };

    const deckA = makeMockMediaEl({ 'data-vanta-bound': '1' });
    const deckB = makeMockMediaEl({ 'data-vanta-bound': '1' });
    const video = makeMockMediaEl({ 'data-vanta-bound': '1', 'data-vanta-theater-bound': '1' });

    const eng = new VantaAudioEngine();
    eng.bindElements(deckA, video, deckB);
    let recreatedPayload = null;
    eng.onElementsRecreated = (payload) => { recreatedPayload = payload; };
    eng._recreateMediaElements(true);

    assert.ok(recreatedPayload, 'Expected onElementsRecreated callback after cloning');
    assert.notEqual(recreatedPayload.deckAEl, deckA);
    assert.notEqual(recreatedPayload.videoEl, video);
    assert.equal(recreatedPayload.deckAEl.getAttribute('data-vanta-bound'), undefined);
    assert.equal(recreatedPayload.deckBEl.getAttribute('data-vanta-bound'), undefined);
    assert.equal(recreatedPayload.videoEl.getAttribute('data-vanta-bound'), undefined);
    assert.equal(recreatedPayload.videoEl.getAttribute('data-vanta-theater-bound'), undefined);
    assert.equal(recreatedPayload.deckAEl.src, '');
  });

  it('25. Playlist Flow Engine: DAG Scheduler, Cycle Guards, All Node Types & Persistent Flow Store', () => {
    // 1. Topological scheduling (diamond graph + cycle rejection)
    const diamond = buildFlowSchedule(
      { a: {}, b: {}, c: {}, d: {} },
      [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']]
    );
    assert.equal(diamond.ok, true);
    assert.equal(diamond.hasCycle, false);
    assert.deepEqual(diamond.schedule[0], ['a']);
    assert.deepEqual(diamond.schedule[1].sort(), ['b', 'c']);
    assert.deepEqual(diamond.schedule[2], ['d']);

    const cyclic = buildFlowSchedule(
      { a: {}, b: {}, c: {} },
      [['a', 'b'], ['b', 'c'], ['c', 'a']]
    );
    assert.equal(cyclic.ok, false);
    assert.equal(cyclic.hasCycle, true);
    assert.match(cyclic.error, /Cycle detected/);

    // 2. Smart Playlist cross-reference cycle detection
    const allFlows = [
      {
        id: 'flow-a',
        kind: 'flow',
        name: 'Flow A',
        graph: {
          nodes: { n1: { id: 'n1', type: 'source:smart_playlist', params: { playlistId: 'flow-b' } } },
          edges: []
        }
      },
      {
        id: 'flow-b',
        kind: 'flow',
        name: 'Flow B',
        graph: {
          nodes: { n1: { id: 'n1', type: 'source:smart_playlist', params: { playlistId: 'flow-a' } } },
          edges: []
        }
      }
    ];
    assert.equal(hasPlaylistReferenceCycle('flow-a', 'flow-b', allFlows), true);
    const validation = validateFlowGraph(allFlows[0], { smartPlaylists: allFlows });
    assert.equal(validation.valid, false);
    assert.match(validation.errors[0], /Circular Smart Playlist reference/);

    // 3. Multi-source catalog for node tests
    const catalog = [
      { id: 't1', audioHash: 'h1', filePath: 'C:\\Music\\Pop\\Track1.flac', title: 'Midnight Grid', artist: 'Artist A', album: 'Night', genre: 'Deep House', bpm: 124, key: 'A min', energy: 86, stars: 5, favorite: true, ext: 'FLAC', durationSec: 240, tags: ['nightdrive'], groups: ['Set 1'] },
      { id: 't2', audioHash: 'h2', filePath: 'C:\\Music\\Pop\\Track2.flac', title: 'Neon Pulse', artist: 'Artist B', album: 'Night', genre: 'Melodic Techno', bpm: 128, key: 'E min', energy: 92, stars: 5, favorite: true, ext: 'FLAC', durationSec: 260, tags: ['peak'], groups: ['Set 1'] },
      { id: 't3', audioHash: 'h3', filePath: 'C:\\Music\\Pop2\\Other.mp3', title: 'Pop2 Trap', artist: 'Artist A', album: 'Other', genre: 'Synth-Pop', bpm: 120, key: 'D min', energy: 78, stars: 4, favorite: false, ext: 'MP3', durationSec: 200, tags: ['warmup'], groups: ['Car'] },
      { id: 't4', audioHash: 'h4', filePath: 'C:\\Music\\Ambient\\Rain.wav', title: 'Rain Focus', artist: 'Artist C', album: 'Calm', genre: 'Ambient', bpm: 88, key: 'G min', energy: 55, stars: 4, favorite: true, ext: 'WAV', durationSec: 300, tags: ['focus'], groups: [] },
      { id: 't5', audioHash: 'h5', filePath: 'C:\\Music\\Videos\\Live.mp4', title: 'Live Clip', artist: 'Artist D', album: '', genre: 'Electronic', bpm: 130, key: 'A min', energy: 90, stars: 3, favorite: false, ext: 'MP4', durationSec: 180, isVideo: true, tags: ['MusicVideo'], groups: [] }
    ];

    const savedRule = {
      id: 'rule-fav',
      kind: 'rule',
      name: 'Favs',
      filters: { favoriteOnly: true, minBpm: '120', maxBpm: '132' }
    };

    const ctx = {
      catalog,
      anchorTrack: catalog[0],
      currentQueue: [catalog[3]],
      smartPlaylists: [savedRule],
      rng: () => 0.25,
      nowDate: new Date(2026, 10, 26, 22, 0, 0)
    };

    // Folder boundary guard: C:\Music\Pop must NOT match C:\Music\Pop2
    const folderExec = executeFlowGraph({
      id: 'f-folder',
      graph: {
        nodes: { s1: { id: 's1', type: 'source:folder', x: 0, y: 0, params: { folderPath: 'C:\\Music\\Pop', includeSubfolders: true } } },
        edges: []
      }
    }, ctx);
    assert.deepEqual(folderExec.outputTracks.map((t) => t.id), ['t1', 't2']);

    // Genre taxonomy match ('Electronic' matches Deep House, Melodic Techno, Ambient, Electronic)
    const genreExec = executeFlowGraph({
      id: 'f-genre',
      graph: {
        nodes: {
          s1: { id: 's1', type: 'source:all', x: 0, y: 0, params: { pool: 'audio' } },
          g1: { id: 'g1', type: 'filter:genre', x: 100, y: 0, params: { genre: 'Electronic' } }
        },
        edges: [['s1', 'g1']]
      }
    }, ctx);
    assert.ok(genreExec.outputTracks.some((t) => t.id === 't1'));
    assert.equal(genreExec.outputTracks.some((t) => t.id === 't3'), false);

    // Explicit slot routing on 2-input Subtract (B wired before A in edges array!)
    const subtractExec = executeFlowGraph({
      id: 'f-sub',
      graph: {
        nodes: {
          a: { id: 'a', type: 'source:lossless', x: 0, y: 0, params: { format: 'ALL_LOSSLESS' } },
          b: { id: 'b', type: 'source:smart_playlist', x: 0, y: 100, params: { playlistId: 'rule-fav' } },
          sub: { id: 'sub', type: 'combiner:subtract', x: 200, y: 50, params: {} },
          out: { id: 'out', type: 'output:playlist', x: 400, y: 50, params: {} }
        },
        edges: [
          ['b', 'sub', 1], // slot B wired first!
          ['a', 'sub', 0], // slot A wired second!
          ['sub', 'out']
        ]
      }
    }, ctx);
    assert.deepEqual(subtractExec.outputTracks.map((t) => t.id), ['t4']);

    // Weighted Zip + Dedup Artist + Harmonic Journey + Take Minutes + Time of Day
    const pipelineExec = executeFlowGraph({
      id: 'f-pipe',
      graph: {
        nodes: {
          srcA: { id: 'srcA', type: 'source:all', x: 0, y: 0, params: { pool: 'audio' } },
          srcB: { id: 'srcB', type: 'source:current_queue', x: 0, y: 100, params: {} },
          tod: { id: 'tod', type: 'conditional:time_of_day', x: 200, y: 50, params: { dayStartHour: 6, nightStartHour: 19 } },
          dedup: { id: 'dedup', type: 'filter:dedup_artist', x: 400, y: 50, params: { maxPerArtist: 1 } },
          sort: { id: 'sort', type: 'sorter:harmonic_journey', x: 600, y: 50, params: { curve: 'energy-up' } },
          out: { id: 'out', type: 'output:playlist', x: 800, y: 50, params: { dedupOutput: true } }
        },
        edges: [
          ['srcA', 'tod', 0],
          ['srcB', 'tod', 1], // At 22:00, Time of Day picks Night branch (slot 1 = currentQueue)
          ['tod', 'dedup'],
          ['dedup', 'sort'],
          ['sort', 'out']
        ]
      }
    }, ctx);
    assert.deepEqual(pipelineExec.outputTracks.map((t) => t.id), ['t4']);

    // Every preset template executes without errors
    assert.ok(Object.keys(FLOW_NODE_REGISTRY).length >= 25);
    for (const tpl of FLOW_PRESET_TEMPLATES) {
      const res = executeFlowGraph({ id: tpl.key, kind: 'flow', graph: tpl.graph }, ctx);
      assert.equal(res.ok, true, `Preset ${tpl.key} should execute cleanly`);
      assert.equal(res.hasCycle, false);
    }

    // Exercise remaining V1 nodes (Zip, Union, Intersect, Harmonic, Tags, Take minutes/random, Artist-spaced shuffle, If Empty)
    const zipUnionExec = executeFlowGraph({
      id: 'f-comb',
      graph: {
        nodes: {
          sAlb: { id: 'sAlb', type: 'source:album', x: 0, y: 0, params: { albumTitle: 'Night' } },
          sArt: { id: 'sArt', type: 'source:artist', x: 0, y: 80, params: { artistName: 'Artist A', matchMode: 'exact' } },
          sVibe: { id: 'sVibe', type: 'source:vibe_radio', x: 0, y: 160, params: { anchorMode: 'playing', count: 3, includeSeed: true } },
          zip: { id: 'zip', type: 'combiner:zip', x: 180, y: 40, params: { ratioA: 1, ratioB: 1, deduplicate: true } },
          inter: { id: 'inter', type: 'combiner:intersect', x: 180, y: 160, params: {} },
          uni: { id: 'uni', type: 'combiner:union', x: 360, y: 90, params: {} },
          harm: { id: 'harm', type: 'filter:harmonic', x: 520, y: 90, params: { anchorMode: 'fixed', targetKey: 'A min', maxDistance: 1 } },
          tags: { id: 'tags', type: 'filter:tags_groups', x: 680, y: 90, params: { tagsCsv: 'nightdrive,peak', matchAll: false, minStars: 4, favoriteOnly: true, format: 'FLAC' } },
          spaced: { id: 'spaced', type: 'sorter:artist_spaced_shuffle', x: 840, y: 90, params: {} },
          takeMin: { id: 'takeMin', type: 'filter:take', x: 1000, y: 90, params: { mode: 'minutes', limit: 5, from: 'start' } },
          emptyCheck: { id: 'emptyCheck', type: 'conditional:if_empty', x: 1160, y: 90, params: {} },
          out: { id: 'out', type: 'output:playlist', x: 1320, y: 90, params: { dedupOutput: true } }
        },
        edges: [
          ['sAlb', 'zip', 0],
          ['sArt', 'zip', 1],
          ['sAlb', 'inter', 0],
          ['sVibe', 'inter', 1],
          ['zip', 'uni', 0],
          ['inter', 'uni', 1],
          ['uni', 'harm'],
          ['harm', 'tags'],
          ['tags', 'spaced'],
          ['spaced', 'takeMin'],
          ['takeMin', 'emptyCheck', 0],
          ['sVibe', 'emptyCheck', 1],
          ['emptyCheck', 'out']
        ]
      }
    }, ctx);
    assert.equal(zipUnionExec.ok, true);
    assert.ok(zipUnionExec.outputTracks.length >= 1);
    assert.ok(zipUnionExec.outputTracks.every((t) => t.ext === 'FLAC' && t.favorite));

    // Verify if_empty fallback & dedup_track
    const fallbackExec = executeFlowGraph({
      id: 'f-empty-fb',
      graph: {
        nodes: {
          sAll: { id: 'sAll', type: 'source:all', x: 0, y: 0, params: { pool: 'audio' } },
          fBpm: { id: 'fBpm', type: 'filter:bpm', x: 160, y: 0, params: { minBpm: 210, maxBpm: 230 } },
          sFav: { id: 'sFav', type: 'source:favorites', x: 0, y: 100, params: { favoritesOnly: true, minStars: 5 } },
          fb: { id: 'fb', type: 'conditional:if_empty', x: 320, y: 50, params: {} },
          dedupT: { id: 'dedupT', type: 'filter:dedup_track', x: 480, y: 50, params: {} },
          rev: { id: 'rev', type: 'sorter:reverse', x: 640, y: 50, params: {} }
        },
        edges: [
          ['sAll', 'fBpm'],
          ['fBpm', 'fb', 0],
          ['sFav', 'fb', 1],
          ['fb', 'dedupT'],
          ['dedupT', 'rev']
        ]
      }
    }, ctx);
    assert.deepEqual(fallbackExec.outputTracks.map((t) => t.id), ['t2', 't1']);

    // 4. Backend sanitizeFlowGraph & loadLibraryStore round-trip security
    const sanitized = sanitizeFlowGraph({
      nodes: {
        valid1: { id: 'valid1', type: 'source:all', x: 42.6, y: -15, params: { pool: 'audio', __proto__: { hacked: true }, num: 5 } },
        badType: { id: 'badType', type: 'exec:shell', x: 10, y: 10, params: {} },
        'bad id!': { id: 'bad id!', type: 'source:all', x: 10, y: 10, params: {} }
      },
      edges: [
        ['valid1', 'valid1'], // self-loop blocked
        ['valid1', 'badType'], // dangling blocked
        ['valid1', 'valid1', 0]
      ]
    });
    assert.deepEqual(Object.keys(sanitized.nodes), ['valid1']);
    assert.equal(sanitized.nodes.valid1.x, 43);
    assert.equal(sanitized.nodes.valid1.y, 0);
    assert.equal(Object.hasOwn(sanitized.nodes.valid1.params, '__proto__'), false);
    assert.equal(sanitized.edges.length, 0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-flow-store-'));
    const storeFile = path.join(tmpDir, 'vanta-library.json');
    saveLibraryStore({
      watchedFolders: [],
      annotations: {},
      smartPlaylists: [
        savedRule,
        {
          id: 'flow-persisted',
          kind: 'flow',
          name: 'Saved Flow',
          description: 'Night graph',
          visual: { mode: 'auto', presetKey: 'synth', imagePath: '' },
          graph: {
            nodes: { n1: { id: 'n1', type: 'source:all', x: 20, y: 30, params: { pool: 'audio' } } },
            edges: []
          }
        }
      ]
    }, storeFile);
    const loaded = loadLibraryStore(storeFile);
    assert.equal(loaded.smartPlaylists.length, 2);
    assert.equal(loaded.smartPlaylists[0].kind, 'rule');
    assert.equal(loaded.smartPlaylists[1].kind, 'flow');
    assert.equal(loaded.smartPlaylists[1].graph.nodes.n1.type, 'source:all');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('26. Playlist Flow Studio V2: Extended Nodes (Year, Played/Skipped, Format Tier/Priority, Recently Added) & Secure M3U8 Export', () => {
    const nowDate = new Date('2026-11-26T20:00:00Z');
    const v2Catalog = [
      { id: 'v1', filePath: 'C:\\Music\\OldMp3.mp3', title: 'Retro Synth', artist: 'Artist X', ext: 'MP3', bitDepth: 16, year: '1998', createdAt: '2026-11-25T10:00:00Z', durationSec: 210 },
      { id: 'v2', filePath: 'C:\\Music\\RecentFlac.flac', title: 'Modern Lossless', artist: 'Artist Y', ext: 'FLAC', bitDepth: 16, year: '2024', createdAt: '2026-11-20T10:00:00Z', durationSec: 245 },
      { id: 'v3', filePath: 'C:\\Music\\HiRes24.flac', title: 'Studio Master 24', artist: 'Artist Z', ext: 'FLAC', bitDepth: 24, year: '2025', createdAt: '2026-11-24T10:00:00Z', durationSec: 300 },
      { id: 'v4', filePath: 'C:\\Music\\PlayedTrack.wav', title: 'Just Played', artist: 'Artist W', ext: 'WAV', bitDepth: 24, year: '2023', createdAt: '2026-01-01T10:00:00Z', durationSec: 190 },
      { id: 'v5', filePath: 'C:\\Music\\SkippedTrack.dsf', title: 'Skipped DSD', artist: 'Artist Q', ext: 'DSF', bitDepth: 1, year: '', createdAt: '2026-11-22T10:00:00Z', durationSec: 260 }
    ];

    const v2Ctx = {
      catalog: v2Catalog,
      nowDate,
      playbackHistory: [{ key: 'C:\\Music\\PlayedTrack.wav', title: 'Just Played' }],
      banditRewards: { v5: -0.5, v3: 0.5 }
    };

    // 1. Recently Added (30 days) sorted descending -> excludes v4 (Jan 2026)
    const recentExec = executeFlowGraph({
      id: 'v2-recent',
      graph: {
        nodes: {
          s1: { id: 's1', type: 'source:recently_added', x: 0, y: 0, params: { withinDays: 30, limit: 10 } }
        },
        edges: []
      }
    }, v2Ctx);
    assert.deepEqual(recentExec.outputTracks.map((t) => t.id), ['v1', 'v3', 'v5', 'v2']);

    // 2. Release Year + Exclude Played/Skipped + Format Priority
    const pipeExec = executeFlowGraph({
      id: 'v2-pipe',
      graph: {
        nodes: {
          sAll: { id: 'sAll', type: 'source:all', x: 0, y: 0, params: { pool: 'audio' } },
          yr: { id: 'yr', type: 'filter:year', x: 160, y: 0, params: { minYear: 2020, maxYear: 2026, includeUnknown: true } },
          ex: { id: 'ex', type: 'filter:exclude_played', x: 320, y: 0, params: { mode: 'both', recentWindow: 20 } },
          prio: { id: 'prio', type: 'sorter:format_priority', x: 480, y: 0, params: { preference: 'hires_first' } }
        },
        edges: [['sAll', 'yr'], ['yr', 'ex'], ['ex', 'prio']]
      }
    }, v2Ctx);
    // v1 excluded by year, v4 excluded as played, v5 excluded as negative bandit reward -> leaves v3 (24-bit) then v2 (16-bit)
    assert.deepEqual(pipeExec.outputTracks.map((t) => t.id), ['v3', 'v2']);

    // 3. Format & Quality Tier filter (24-bit / DSD vs Lossy)
    const hiresExec = executeFlowGraph({
      id: 'v2-tier',
      graph: {
        nodes: {
          sAll: { id: 'sAll', type: 'source:all', x: 0, y: 0, params: { pool: 'audio' } },
          tier: { id: 'tier', type: 'filter:format_tier', x: 160, y: 0, params: { tier: 'hires_24bit' } }
        },
        edges: [['sAll', 'tier']]
      }
    }, v2Ctx);
    assert.deepEqual(hiresExec.outputTracks.map((t) => t.id), ['v3', 'v4', 'v5']);

    // 4. sanitizeFlowGraph allows all V2 node types
    const sanitizedV2 = sanitizeFlowGraph({
      nodes: {
        n1: { id: 'n1', type: 'source:recently_added', x: 10, y: 10, params: { withinDays: 14 } },
        n2: { id: 'n2', type: 'filter:year', x: 20, y: 20, params: { minYear: 2020, maxYear: 2026 } },
        n3: { id: 'n3', type: 'filter:exclude_played', x: 30, y: 30, params: { mode: 'both' } },
        n4: { id: 'n4', type: 'filter:format_tier', x: 40, y: 40, params: { tier: 'hires_24bit' } },
        n5: { id: 'n5', type: 'sorter:format_priority', x: 50, y: 50, params: { preference: 'lossless_first' } }
      },
      edges: [['n1', 'n2'], ['n2', 'n3'], ['n3', 'n4'], ['n4', 'n5']]
    });
    assert.equal(Object.keys(sanitizedV2.nodes).length, 5);
    assert.equal(sanitizedV2.edges.length, 4);

    // 5. buildM3u8Content CRLF/NUL injection prevention & formatting
    const m3u = buildM3u8Content([
      { filePath: 'C:\\Music\\HiRes24.flac', artist: 'Artist\r\nInject', title: 'Master\nTrack', durationSec: 300.4 },
      { filePath: 'C:\\Music\\Evil\n#EXTINF:0,Fake.mp3', artist: 'Bad', title: 'Path', durationSec: 100 },
      { filePath: '', artist: 'Empty', title: 'Skip', durationSec: 100 }
    ], { playlistName: 'Night\nDrive' });
    assert.equal(m3u.exportedCount, 1);
    assert.match(m3u.content, /^#EXTM3U\n#PLAYLIST:Night Drive\n#EXTINF:300,Artist Inject - Master Track\nC:\\Music\\HiRes24\.flac\n$/);

    // 6. pathSecurityService PLAYLIST_EXTENSIONS validation
    const tmpExportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vanta-m3u8-'));
    const validM3u8 = validateSafeFilePath(path.join(tmpExportDir, 'mix.m3u8'), {
      allowedExtensions: PLAYLIST_EXTENSIONS,
      mustExist: false
    });
    assert.ok(validM3u8 && validM3u8.endsWith('.m3u8'));
    assert.equal(
      validateSafeFilePath(path.join(tmpExportDir, 'mix.exe'), { allowedExtensions: PLAYLIST_EXTENSIONS, mustExist: false }),
      null
    );
    assert.equal(
      validateSafeFilePath(path.join(tmpExportDir, 'mix.m3u8:ads'), { allowedExtensions: PLAYLIST_EXTENSIONS, mustExist: false }),
      null
    );
    assert.equal(
      validateSafeFilePath('\\\\evil-share\\mix.m3u8', { allowedExtensions: PLAYLIST_EXTENSIONS, mustExist: false }),
      null
    );
    fs.rmSync(tmpExportDir, { recursive: true, force: true });
  });
});
