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
  computeSubBassCurveParams
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

const require = createRequire(import.meta.url);
const {
  normalizeId3Genre,
  encodeSynchsafeInt,
  decodeSynchsafeInt,
  writeId3v2Tags,
  readId3v2Tags,
  updateMp3MetadataOnDisk,
  readFlacMetadataFromFile
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
  resolveWasapiEngineBinary,
  listWasapiDevices
} = require('../electron/services/audioBridgeService.cjs');

const {
  resolveSafeVaultSubfolder,
  validateSafeFilePath,
  validateSafeDirectoryPath,
  isPathAuthorizedInScope,
  resolveFromTrustedRoots,
  SUBTITLE_EXTENSIONS
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
    // Bit-Perfect Reset preserves clip Limiter & EBU R128 safety while zeroing FX
    eng2.toggleDspFlag('spatial');
    eng2.resetBitPerfect();
    assert.equal(eng2.state.spatial, false);
    assert.equal(eng2.state.pitchSemitones, 0);
    assert.equal(eng2.state.limiter, true);
    assert.equal(eng2.state.lufs, true);
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
    assert.equal(engine.state.lufs, true);
    assert.equal(engine.state.eqEnabled, false);
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

      // 6. Strict CSP in index.html has no 'unsafe-inline'
      const htmlSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'index.html'), 'utf8');
      assert.equal(htmlSrc.includes("'unsafe-inline'"), false);
      assert.ok(htmlSrc.includes("object-src 'none'"));
    } finally {
      fs.rmSync(tmpSecDir, { recursive: true, force: true });
    }
  });
});
