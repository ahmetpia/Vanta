/**
 * @fileoverview VANTA — Personal Audio & Video OS Main Renderer Controller.
 * Orchestrates the 3-Column Master UI, 15 Left Sidebar Workspaces, Web Audio DSP Graph,
 * 60 FPS Spline Spectrum Visualizer, MIR Song DNA, Vibe Radio AI, and Electron IPC Vault Bridge.
 */

import {
  VantaAudioEngine,
  EQ_FREQUENCIES,
  EQ_PRESETS,
  DEVICE_EQ_PROFILES,
  requiresStudioDsp,
  requiresStudioFfmpegStream,
  serializeNativeDspSpecFromState,
  buildSignalPathDescriptor,
  computeWasapiGainFactor,
  resolveStartupAudioPrefs,
  resolveReplayGain2,
  parseAutoEqTxt,
  serializePeqWireSpec,
  evaluateAbxVerdict,
  generateAbxTrialSequence
} from './audioEngine.js';
import { VantaVisualizer } from './visualizer.js';
import { StageLightEngine, STAGE_FX_MODES, STAGE_PALETTES } from './stageLights.js';
import {
  applyProSmartFilter,
  buildVibeRadioQueue,
  buildTimeCapsuleAnalytics,
  buildAlbumCollections,
  buildArtistCollections,
  resolveQueueRowNumIndicator,
  resolveRowClickAction,
  isMusicVideoTagged,
  isLongFeatureVideo,
  GENRE_TAXONOMY,
  resolveMainGenre,
  parseStructuredLyrics
} from './vibeRecommender.js';
import { CAMELOT_KEY_MAP } from './mirAnalyzer.js';
import { executeFlowGraph } from './playlistFlowEngine.js';
import { FlowStudioController } from './flowStudioUI.js';
import { ScoreStudioController } from './scoreStudioUI.js';

const REKORDBOX_COLUMNS = [
  { id: 'num', label: '#', width: 32, minWidth: 28, locked: true, defaultVisible: true, sortAsc: '', sortDesc: '' },
  { id: 'title', label: 'Title', width: 170, minWidth: 115, locked: true, defaultVisible: true, editable: 'title', sortAsc: 'title-asc', sortDesc: 'title-desc' },
  { id: 'artist', label: 'Artist', width: 96, minWidth: 70, defaultVisible: true, editable: 'artist', sortAsc: 'artist-asc', sortDesc: 'artist-desc' },
  { id: 'bpm', label: 'BPM', width: 46, minWidth: 40, defaultVisible: true, editable: 'bpm', sortAsc: 'bpm-asc', sortDesc: 'bpm-desc' },
  { id: 'key', label: 'Key', width: 48, minWidth: 42, defaultVisible: true, editable: 'key', sortAsc: 'key-asc', sortDesc: 'key-desc' },
  { id: 'genre', label: 'Genre', width: 82, minWidth: 64, defaultVisible: true, editable: 'genre', sortAsc: 'genre-asc', sortDesc: 'genre-desc' },
  { id: 'time', label: 'Time', width: 48, minWidth: 42, defaultVisible: true, sortAsc: 'time-asc', sortDesc: 'time-desc' },
  { id: 'rating', label: 'Rating', width: 96, minWidth: 84, defaultVisible: true, sortAsc: 'stars-desc', sortDesc: 'stars-asc' },
  { id: 'tags', label: 'Tags', width: 66, minWidth: 58, defaultVisible: true, sortAsc: 'tags-asc', sortDesc: 'tags-desc' },
  { id: 'format', label: 'Format', width: 84, minWidth: 64, defaultVisible: true, sortAsc: 'format-asc', sortDesc: 'format-desc' },
  { id: 'created', label: 'Creation Date', width: 112, minWidth: 88, defaultVisible: true, sortAsc: 'created-asc', sortDesc: 'created-desc' },
  { id: 'size', label: 'Size', width: 66, minWidth: 52, defaultVisible: true, sortAsc: 'size-asc', sortDesc: 'size-desc' },
  { id: 'album', label: 'Album', width: 120, minWidth: 80, defaultVisible: false, editable: 'album', sortAsc: 'album-asc', sortDesc: 'album-desc' },
  { id: 'source', label: 'Source', width: 220, minWidth: 110, defaultVisible: false, sortAsc: 'source-asc', sortDesc: 'source-desc' }
];

const PLAYLIST_VISUAL_PRESETS = [
  { key: 'synth', icon: '⚡', label: 'Obsidian Synth', grad: 'linear-gradient(135deg, #7c5cff, #00e5ff)' },
  { key: 'rock', icon: '🎸', label: 'Electric Rock', grad: 'linear-gradient(135deg, #f43f5e, #fb923c)' },
  { key: 'night', icon: '🚗', label: 'Night Drive', grad: 'linear-gradient(135deg, #2563eb, #1e1b4b)' },
  { key: 'peak', icon: '🔥', label: 'Peaktime Club', grad: 'linear-gradient(135deg, #ec4899, #8b5cf6)' },
  { key: 'chill', icon: '🌊', label: 'Chill & Focus', grad: 'linear-gradient(135deg, #06b6d4, #10b981)' },
  { key: 'deep', icon: '🎧', label: 'Deep House', grad: 'linear-gradient(135deg, #4f46e5, #0ea5e9)' },
  { key: 'piano', icon: '🎹', label: 'Acoustic & Keys', grad: 'linear-gradient(135deg, #f59e0b, #d97706)' },
  { key: 'heart', icon: '♥', label: 'Favorites Vault', grad: 'linear-gradient(135deg, #ef4444, #be185d)' }
];

class VantaStudioApp {
  constructor() {
    this.catalog = [];
    this.displayedTracks = [];
    this.smartPlaylists = [];
    this.activeSmartPlaylistId = null;
    this.albumsMode = 'all';
    this.albumsSortBy = 'smart';
    this.albumsViewMode = 'grid';
    this.selectedAlbumId = null;
    this.albumCollections = [];
    this.artistsMode = 'all';
    this.artistsSortBy = 'curated';
    this.artistsViewMode = 'grid';
    this.selectedArtistId = null;
    this.selectedArtistReleaseId = null;
    this.artistCollections = [];
    this.editingSmartRuleId = null;
    this.draftRuleVisual = { mode: 'auto', presetKey: 'synth', imagePath: '' };
    this.doctorReport = { issues: [], healthScore: 100 };
    this.activeTrackIndex = 0;
    this.isPlaying = false;
    this.selectedExportFormat = 'MP3+ID3';
    this.activeNav = 'home';
    this.explorerOpen = false;
    this.explorerRoots = [];
    this.expandedDirs = new Set();
    this.dirEntriesCache = new Map();
    this.selectedTreePaths = new Set();
    this.lastClickedTreePath = null;
    this.visibleTreeNodes = [];
    this.explorerFilterQuery = '';
    this.hiddenExplorerDirs = [];
    this.activeStage = 'wave';
    this.editingTrackKey = null;
    this.banditRewards = {};
    this.currentLoadedTrack = null;
    this._pausedTrackKey = null;
    this._navigatingHistory = false;
    this._activeInlineEdit = false;
    this._rowClickTimer = null;
    this.rbColumnsState = this._loadRbColumnsState();
    try {
      const savedHist = JSON.parse(globalThis.localStorage?.getItem('vanta_play_history_v1') || '[]');
      this.playbackHistory = Array.isArray(savedHist) ? savedHist.slice(-30) : [];
    } catch {
      this.playbackHistory = [];
    }

    this.filterState = {
      query: '',
      minBpm: '',
      maxBpm: '',
      key: 'ALL',
      energyBand: 'ALL',
      exactStars: 0,
      tags: [],
      groups: [],
      favoriteOnly: false,
      sortBy: 'default'
    };

    this.audioEl = document.getElementById('vantaAudioPlayer');
    this.deckBEl = document.getElementById('vantaAudioDeckB');
    this.videoEl = document.getElementById('vantaVideoPlayer');
    this.canvasEl = document.getElementById('vantaWaveCanvas');

    const startupPrefs = resolveStartupAudioPrefs(
      globalThis.localStorage?.getItem('vanta_audio_prefs_v2'),
      globalThis.localStorage?.getItem('vanta_pro_dsp_v1')
    );
    this.engineMode = startupPrefs.engineMode; // 'wasapi' (Bit-Perfect Pure default) | 'dsp' (Studio DSP)
    this.preferredAudioEngineMode = startupPrefs.engineMode;
    this.outputBackend = startupPrefs.outputBackend || 'wasapi';
    this.asioDriver = startupPrefs.asioDriver || '';
    this.asioRawDsd = Boolean(startupPrefs.asioRawDsd);
    this.asioDevices = [];
    this.holdWasapiOnPause = startupPrefs.holdWasapiOnPause;
    this.wasapiPushMode = startupPrefs.wasapiPushMode;
    this.wasapiBufferMs = startupPrefs.wasapiBufferMs;
    this.clockSwitchPreRollMs = startupPrefs.clockSwitchPreRollMs;
    this.fixedRateLock = startupPrefs.fixedRateLock;
    this.fixedTargetRate = startupPrefs.fixedTargetRate;
    this._migratePureDspDefaults = startupPrefs.migratePureDspDefaults;
    this._currentFormattedLyrics = '';
    this._copyLyricsTimer = null;
    this._rbLastVStart = -1;
    this._rbLastVEnd = -1;
    this._rbScrollRaf = 0;
    this._rbViewportBound = false;
    this._filterDebounceTimer = null;
    this.selectedDeviceId = '';
    this.selectedDeviceName = '';
    this.deviceCaps = null;
    this.lastWasapiRatePlan = null;
    this.wasapiPausedHeld = false;
    this.wasapiXrunCount = 0;
    this.lastLiveAudioTelemetry = null;
    this.abxSession = null;
    this.activeTrackProbe = null;
    this.activeTrackR128 = null;
    this.flowStudio = new FlowStudioController({
      getCatalog: () => this.catalog,
      getSmartPlaylists: () => this.smartPlaylists,
      getAnchorTrack: () => this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex] || this.catalog[0] || null,
      getCurrentQueue: () => this.displayedTracks,
      getBanditRewards: () => this.banditRewards,
      getPlaybackHistory: () => this.playbackHistory,
      buildCoverElement: (rule, tracks, size) => this.buildPlaylistCoverElement(rule, tracks, size),
      renderCoverSwatches: (host, draftVisual, onSelect) => this._renderCoverSwatchesInto(host, draftVisual, onSelect),
      pickCoverImage: (id) => (window.vantaAPI?.pickPlaylistCover ? window.vantaAPI.pickPlaylistCover(id) : null),
      isDuplicateName: (name, ignoreId) => this._isDuplicateSmartPlaylistName(name, ignoreId),
      onSaveFlow: (flowObj, isEdit) => this.saveSmartPlaylistObject(flowObj, isEdit, 'flowValidationMsg'),
      onPlayTracks: (tracks, title) => this.playAdHocFlowPreview(tracks, title),
      onExportM3u8: (tracks, name) => this.exportPlaylistM3u8(tracks, name),
      onToggleMaximizeWin: () => window.vantaAPI?.windowControl?.('maximize'),
      onToast: (msg) => this.setToast(msg)
    });
    this.scoreStudio = new ScoreStudioController({
      getActiveTrack: () => this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex] || null,
      getPositionSec: () => Math.max(0, Number(this._lastTimelinePosSec) || 0),
      togglePlay: () => this.togglePlay(),
      seekToSeconds: (sec, triggerPlay) => this.seekToSeconds(sec, triggerPlay),
      setPracticePlaybackRate: (rate) => this.setPracticePlaybackRate(rate),
      setScoreMuteOriginal: (muted) => this.setScoreMuteOriginal(muted),
      onToast: (msg) => this.setToast(msg)
    });
    this._lastTimelinePosSec = 0;
    this._scoreMuteOriginal = false;
    this.activeTrackTags = null;
    this.lastReplayGainInfo = null;
    this.sacdVirtualTracks = [];
    this.wasapiStatusMode = this.engineMode === 'wasapi'
      ? (this.outputBackend === 'asio' ? 'ASIO ISOLATED READY' : 'WASAPI EXCLUSIVE READY')
      : 'STUDIO DSP';
    this.wasapiPausedTrackKey = null;
    this.wasapiResumeSec = 0;
    this.wasapiCurrentPositionSec = 0;
    this.crossfadeTriggeredForTrack = false;
    this._playbackSeq = 0;
    this.repeatMode = 'queue'; // 'off' | 'queue' | 'one'
    this.studioSeekOffsetSec = 0;
    this._videoSeekOffsetSec = 0;
    this._pendingStudioSeekSec = null;
    this._boundDeckElements = new WeakSet();
    this._boundTheaterVideoElements = new WeakSet();
    this.theaterOpen = false;
    this.theaterAmbilight = true;
    this.activeVideoProbe = null;
    this.activeVideoStrategy = 'direct';
    this.activeVideoAudioIdx = 0;
    this.activeLoadedVideoTrack = null;
    this.activeSubtitleUrl = null;
    this.siblingSubtitles = [];
    this._videoProbeSeq = 0;
    this._videoProbePromise = null;
    this._lastLoadedVideoUrl = '';
    this._theaterIdleTimer = null;
    this._ambilightRafId = 0;
    this.windowsVolumeLinked = false;
    this.deviceHwVolumeSupport = 3;
    try {
      this.dopEnabled = globalThis.localStorage?.getItem('vanta_dop_enabled_v1') === '1';
    } catch {
      this.dopEnabled = false;
    }

    const rawVol = globalThis.localStorage?.getItem('vanta_master_volume_v1');
    const savedVol = rawVol !== null && rawVol !== undefined && rawVol !== '' ? Number(rawVol) : 100;
    this.masterVolumePct = Number.isFinite(savedVol) ? Math.max(0, Math.min(100, savedVol)) : 100;
    this.masterVolumeLinear = this.masterVolumePct <= 0 ? 0 : Math.pow(this.masterVolumePct / 100, 1.75);
    this.isMuted = this.masterVolumePct === 0;
    this.preMuteVolumePct = this.masterVolumePct > 0 ? this.masterVolumePct : 85;

    this.audioEngine = new VantaAudioEngine();
    this.audioEngine.onElementsRecreated = ({ deckAEl, deckBEl, videoEl }) => {
      this.audioEl = deckAEl;
      this.deckBEl = deckBEl;
      this.videoEl = videoEl;
      this._lastLoadedVideoUrl = '';
      this._bindMediaEvents?.();
      this._bindVideoTheaterEvents?.();
    };
    this.visualizer = new VantaVisualizer(this.canvasEl, this.audioEngine);
    this.stageLights = new StageLightEngine(
      document.getElementById('stageFxCanvas'),
      document.getElementById('stageEdgeLaserRing'),
      document.getElementById('stageFxVideo')
    );
    this.visualizer.onFrame = (bars) => {
      this.stageLights?.tick(
        bars,
        this.isPlaying,
        this.currentLoadedTrack?.bpm || 126,
        this.currentLoadedTrack
      );
    };
  }

  async init() {
    this._loadProDspSettings();
    this.renderEqColumns();
    this.bindEvents();
    this._syncEngineModeUi(null);
    this._syncAllDspUi();
    // Only paint local UI slider on boot; never overwrite Windows OS endpoint volume before getSystemVolume() arrives.
    this._renderMasterVolumeUi(this.masterVolumePct, this.isMuted);
    this.visualizer.isPlaying = false;
    this.visualizer.start();
    this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);

    // Scan C:\Vanta\VantaVault + saved folders, WASAPI & ASIO hardware DACs via IPC
    if (window.vantaAPI) {
      void this.populateAudioDevices().catch(() => {});
      void this.populateAsioDevices().catch(() => {});

      window.vantaAPI.onVolumeEvent((vol) => {
        this.applySystemVolumeState(vol);
      });
      window.vantaAPI.onAudioDevicesChanged(() => {
        void this.populateAudioDevices(true).catch(() => {});
        void this.populateAsioDevices().catch(() => {});
      });
      navigator.mediaDevices?.addEventListener('devicechange', () => {
        void this.populateAudioDevices(true).catch(() => {});
      });
      window.vantaAPI
        .getSystemVolume()
        .then((vol) => this.applySystemVolumeState(vol))
        .catch(() => {});

      window.vantaAPI.onWasapiEvent((evt) => {
        this.handleWasapiEvent(evt);
      });

      try {
        const vaultData = await window.vantaAPI.scanVault();
        this.mergeVaultCatalog(vaultData.catalog, vaultData.doctor, vaultData.smartPlaylists);
      } catch {
        // Keep empty catalog on error
      }

      try {
        const fxVideoInfo = await window.vantaAPI.getFxVideo?.();
        if (fxVideoInfo?.videoPath) {
          this.stageLights?.setVideoSource(fxVideoInfo.videoPath);
          this.setupStageFxSelector();
        }
      } catch {
        // Ignore if optional FX video is unavailable
      }

      window.vantaAPI.onBatchProgress((prog) => {
        this.updateBatchProgressRing(prog.overallPercent, prog.stage);
      });

      window.vantaAPI.onScanProgress((prog) => {
        this.setToast(`Indexing Folder: ${prog.scannedCount} media files found (${prog.currentFile})`);
      });

      window.addEventListener('error', (ev) => {
        window.vantaAPI.logClientEvent('ERROR', ev.message || 'Renderer error', {
          filename: ev.filename,
          lineno: ev.lineno
        });
      });

      window.addEventListener('unhandledrejection', (ev) => {
        window.vantaAPI.logClientEvent('ERROR', 'Unhandled renderer promise rejection', {
          reason: String(ev.reason)
        });
      });

      window.vantaAPI.onMediaKey((action) => {
        if (action === 'PlayPause') this.togglePlay();
        else if (action === 'Next') this.stepTrack(1);
        else if (action === 'Previous') this.stepTrack(-1);
      });
    }

    this.renderQueue();
    this.selectTrack(0, false);
  }

  /**
   * Merges scanned disk files from C:\Vanta\VantaVault with the studio catalog.
   * @param {object[]} diskTracks - Tracks scanned from disk.
   * @param {object} doctor - Quality Doctor report.
   * @param {object[]} [smartPlaylists] - Saved smart playlists.
   */
  /**
   * Returns a globally unique identifier for any catalog track (including multi-track SACD ISO discs).
   * @param {object|null} track - Track object.
   * @returns {string|null} Unique track key.
   */
  _getTrackUniqueKey(track) {
    if (!track) return null;
    if (Number(track.sacdTrack) >= 1 && track.filePath) {
      return `${track.filePath}#${Number(track.sacdArea) || 0}:${Number(track.sacdTrack)}`;
    }
    return track.filePath || track.id || null;
  }

  /**
   * Builds a vanta-media:// playback URL for local files and virtual ScarletBook SACD ISO tracks.
   * @param {object} track - Active track metadata.
   * @param {number} [ssSec=0] - Optional start offset in seconds.
   * @returns {string} Encoded custom protocol media URL.
   */
  _buildLocalMediaUrl(track, ssSec = 0) {
    const params = new URLSearchParams();
    params.set('path', String(track?.filePath || ''));
    if (Number(track?.sacdTrack) >= 1) {
      params.set('sacdArea', String(Number.isFinite(Number(track.sacdArea)) ? Number(track.sacdArea) : 0));
      params.set('sacdTrack', String(Number(track.sacdTrack)));
    }
    if (Number(ssSec) > 0.5) {
      params.set('ss', Number(ssSec).toFixed(2));
    }
    return `vanta-media://local?${params.toString()}`;
  }

  mergeVaultCatalog(diskTracks = [], doctor = null, smartPlaylists = null) {
    this.doctorReport = doctor || { issues: [], healthScore: 100 };
    if (Array.isArray(smartPlaylists)) {
      this.smartPlaylists = smartPlaylists;
    }

    const merged = [];
    const seenKeys = new Set();
    const pushTrack = (dt) => {
      const item = {
        ...dt,
        stars: Number(dt.stars) || 0,
        favorite: Boolean(dt.favorite),
        tags: Array.isArray(dt.tags) ? dt.tags.slice(0, 3) : [],
        groups: Array.isArray(dt.groups) ? dt.groups.slice(0, 1) : [],
        tag: dt.provenance || dt.ext || 'Vault',
        isAi: String(dt.provenance || '').includes('AI'),
        grad: dt.isVideo
          ? 'linear-gradient(135deg, #f43f5e, #ffd166)'
          : 'linear-gradient(135deg, #2f6fed, #06b6d4)'
      };
      const k = this._getTrackUniqueKey(item);
      if (k && seenKeys.has(k)) return;
      if (k) seenKeys.add(k);
      merged.push(item);
    };

    for (const dt of diskTracks) pushTrack(dt);
    for (const st of this.sacdVirtualTracks || []) pushTrack(st);

    this.catalog = merged;
    const catalogKeys = new Set(merged.map((t) => this._getTrackUniqueKey(t)));
    this.playbackHistory = (this.playbackHistory || []).filter((h) => h && h.key && catalogKeys.has(h.key));
    this._updateLastPlayedButton();
    this.renderTagFilterOptions();
    this.applyFiltersAndRender(false);
    this.updateSidebarBadges();
    this.renderSmartPlaylistBar();
    void this._scheduleBackgroundTechProbe().catch(() => {});
  }

  /**
   * Collects sorted, case-insensitively deduplicated tag or group names across the catalog.
   * @param {'tags' | 'groups'} field - Metadata array field on track objects.
   * @returns {string[]} Unique sorted display labels.
   */
  collectUniqueMeta(field) {
    const map = new Map();
    for (const t of this.catalog) {
      const limit = field === 'tags' ? 3 : 1;
      for (const raw of (t[field] || []).slice(0, limit)) {
        const clean = String(raw || '').trim().replace(/\s+/g, ' ');
        if (!clean) continue;
        const key = clean.toLowerCase();
        if (!map.has(key)) map.set(key, clean);
      }
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Refreshes the separate multi-select TAG and GROUP checkbox combos and inline quick-assign combos.
   */
  renderTagFilterOptions() {
    const uniqueTags = this.collectUniqueMeta('tags');
    const uniqueGroups = this.collectUniqueMeta('groups');
    this._setupMultiCheckboxCombo('filterTagsCombo', uniqueTags, 'tags', 'All Tags', '#');
    this._setupMultiCheckboxCombo('filterGroupsCombo', uniqueGroups, 'groups', 'All Groups', '');
    this._populateInlineTagSelects(uniqueTags, uniqueGroups);
  }

  /**
   * Populates the inline tag/group editor quick-assign dropdowns with deduplicated catalog values.
   * @param {string[]} uniqueTags
   * @param {string[]} uniqueGroups
   */
  _populateInlineTagSelects(uniqueTags = this.collectUniqueMeta('tags'), uniqueGroups = this.collectUniqueMeta('groups')) {
    const fillSelect = (id, placeholder, items, prefix = '') => {
      const sel = document.getElementById(id);
      if (!sel) return;
      sel.replaceChildren();
      const def = document.createElement('option');
      def.value = '';
      def.textContent = placeholder;
      sel.appendChild(def);
      for (const item of items) {
        const opt = document.createElement('option');
        opt.value = item;
        opt.textContent = `${prefix}${item}`;
        sel.appendChild(opt);
      }
      sel.value = '';
    };
    fillSelect('existingTagSelect', 'Existing Tag ▾', uniqueTags, '#');
    fillSelect('existingGroupSelect', 'Existing Group ▾', uniqueGroups, '');
  }

  /**
   * Updates the player bar Back-to-Last-Played button state and hover tooltip.
   */
  _updateLastPlayedButton() {
    const btn = document.getElementById('btnLastPlayedTrack');
    if (!btn) return;
    const prev = this.playbackHistory.length ? this.playbackHistory[this.playbackHistory.length - 1] : null;
    btn.disabled = !prev;
    btn.title = prev
      ? `Back to Last Played: "${prev.title}"${prev.artist ? ` — ${prev.artist}` : ''}`
      : 'Back to Last Played Track (No history yet)';
  }

  /**
   * Persists the bounded playback history stack across sessions.
   */
  _savePlaybackHistory() {
    try {
      globalThis.localStorage?.setItem('vanta_play_history_v1', JSON.stringify(this.playbackHistory.slice(-30)));
    } catch {
      // Ignore storage errors
    }
  }

  /**
   * Binds or refreshes a multi-select checkbox dropdown menu for Tag or Group filtering.
   * @param {string} containerId - Wrapper element ID.
   * @param {string[]} items - Sorted unique labels.
   * @param {'tags' | 'groups'} stateKey - Filter state array property.
   * @param {string} emptyLabel - Label shown when nothing is checked.
   * @param {string} prefix - Optional display prefix (e.g. '#' for tags).
   */
  _setupMultiCheckboxCombo(containerId, items, stateKey, emptyLabel, prefix = '') {
    const root = document.getElementById(containerId);
    if (!root) return;
    const trigger = root.querySelector('.vanta-combo-trigger');
    const labelEl = root.querySelector('.vanta-combo-label');
    const menuEl = root.querySelector('.vanta-combo-menu');
    if (!trigger || !labelEl || !menuEl) return;

    // Keep only selections that still exist cleanly in catalog (case-insensitive map)
    const canonicalByLower = new Map(items.map((it) => [it.toLowerCase(), it]));
    const currentList = Array.isArray(this.filterState[stateKey]) ? this.filterState[stateKey] : [];
    const pruned = [];
    for (const sel of currentList) {
      const canon = canonicalByLower.get(String(sel || '').trim().toLowerCase());
      if (canon && !pruned.includes(canon)) pruned.push(canon);
    }
    this.filterState[stateKey] = pruned;

    const updateTriggerLabel = () => {
      const active = this.filterState[stateKey];
      if (!active.length) {
        labelEl.textContent = emptyLabel;
      } else if (active.length === 1) {
        labelEl.textContent = `${prefix}${active[0]}`;
      } else {
        labelEl.textContent = `${active.length} ${stateKey === 'tags' ? 'Tags' : 'Groups'}`;
      }
    };

    const closeAllMenus = () => {
      document.querySelectorAll('.vanta-combo-menu').forEach((m) => m.classList.add('hidden'));
      document.querySelectorAll('.vanta-combo-trigger').forEach((t) => t.setAttribute('aria-expanded', 'false'));
    };

    const renderMenu = () => {
      menuEl.innerHTML = '';
      const activeLower = new Set(this.filterState[stateKey].map((s) => s.toLowerCase()));

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = `vanta-combo-item ${activeLower.size === 0 ? 'selected' : ''}`;
      clearBtn.textContent = emptyLabel;
      clearBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.filterState[stateKey] = [];
        updateTriggerLabel();
        renderMenu();
        closeAllMenus();
        this.applyFiltersAndRender(true);
      });
      menuEl.appendChild(clearBtn);

      for (const name of items) {
        const lbl = document.createElement('label');
        lbl.className = 'vanta-check-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = activeLower.has(name.toLowerCase());
        cb.addEventListener('change', () => {
          const next = [];
          let found = false;
          for (const existing of this.filterState[stateKey]) {
            if (existing.toLowerCase() === name.toLowerCase()) {
              found = true;
              if (cb.checked) next.push(name);
            } else {
              next.push(existing);
            }
          }
          if (cb.checked && !found) next.push(name);
          this.filterState[stateKey] = next;
          clearBtn.classList.toggle('selected', next.length === 0);
          updateTriggerLabel();
          this.applyFiltersAndRender(true);
        });

        const txt = document.createElement('span');
        txt.textContent = `${prefix}${name}`;

        lbl.appendChild(cb);
        lbl.appendChild(txt);
        menuEl.appendChild(lbl);
      }
    };

    updateTriggerLabel();
    renderMenu();

    if (!root.dataset.comboBound) {
      root.dataset.comboBound = '1';
      menuEl.addEventListener('click', (ev) => ev.stopPropagation());
      trigger.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isOpen = !menuEl.classList.contains('hidden');
        closeAllMenus();
        if (!isOpen) {
          menuEl.classList.remove('hidden');
          trigger.setAttribute('aria-expanded', 'true');
        }
      });
    }
  }

  /**
   * Builds a crisp SVG heart icon element without innerHTML.
   * @param {boolean} [filled=false] - Whether heart should render filled.
   * @returns {SVGSVGElement}
   */
  _createHeartSvg(filled = false) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', filled ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.1');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z');
    svg.appendChild(path);
    return svg;
  }

  _getTracksPoolForNav(navId = this.activeNav) {
    if (navId === 'videos') {
      return this.catalog.filter((t) => t.isVideo);
    }
    if (navId === 'playlists' && this.activeSmartPlaylistId) {
      const activePl = this.smartPlaylists.find((p) => p.id === this.activeSmartPlaylistId);
      if (activePl?.kind === 'flow') {
        return this.evaluateSmartPlaylistTracks(activePl);
      }
      return [...this.catalog];
    }
    const audioPool = this.catalog.filter((t) => !t.isVideo || isMusicVideoTagged(t));
    if (navId === 'albums' && this.selectedAlbumId) {
      const groups = buildAlbumCollections(audioPool, { mode: this.albumsMode });
      const activeAlbum = groups.find((g) => g.id === this.selectedAlbumId);
      if (activeAlbum) return activeAlbum.tracks;
    }
    if (navId === 'artists' && this.selectedArtistId) {
      const artists = buildArtistCollections(audioPool, { mode: 'all' });
      const activeArtist = artists.find((a) => a.id === this.selectedArtistId);
      if (activeArtist) {
        if (this.selectedArtistReleaseId) {
          const rel = activeArtist.releases.find((r) => r.id === this.selectedArtistReleaseId);
          if (rel) return rel.tracks;
        }
        return activeArtist.tracks;
      }
    }
    return audioPool;
  }

  /**
   * Applies current Smart Focus filters and in-list search/sort, then re-renders the track queue.
   * @param {boolean} [resetIndex=true] - Whether to reset selection to index 0.
   */
  applyFiltersAndRender(resetIndex = true) {
    const baseList = this._getTracksPoolForNav(this.activeNav);

    const anchor = this.displayedTracks[this.activeTrackIndex] || baseList[0] || this.catalog[0] || null;
    this.displayedTracks = applyProSmartFilter(baseList, this.filterState, anchor);

    if (this.activeNav === 'vibe' && anchor) {
      this.displayedTracks = buildVibeRadioQueue(anchor, this.displayedTracks, this.banditRewards);
    } else if (this.activeNav === 'albums' && !this.selectedAlbumId && (!this.filterState.sortBy || this.filterState.sortBy === 'default')) {
      this.displayedTracks.sort(
        (a, b) =>
          String(a.album || '').localeCompare(String(b.album || '')) ||
          String(a.title || '').localeCompare(String(b.title || ''))
      );
    } else if (this.activeNav === 'artists' && !this.selectedArtistId && (!this.filterState.sortBy || this.filterState.sortBy === 'default')) {
      this.displayedTracks.sort(
        (a, b) =>
          String(a.artist || '').localeCompare(String(b.artist || '')) ||
          String(a.title || '').localeCompare(String(b.title || ''))
      );
    }

    if (resetIndex) {
      this.activeTrackIndex = 0;
    }

    if (this.activeNav === 'albums') {
      this.renderAlbumsWorkspace();
    } else if (this.activeNav === 'artists') {
      this.renderArtistsWorkspace();
    }

    const matchBadge = document.getElementById('listMatchCount');
    if (matchBadge) {
      if (this.activeNav === 'albums' && !this.selectedAlbumId && this.albumsViewMode === 'grid') {
        matchBadge.textContent = `${this.albumCollections.length} release${this.albumCollections.length === 1 ? '' : 's'}`;
      } else if (this.activeNav === 'artists' && !this.selectedArtistId && this.artistsViewMode === 'grid') {
        matchBadge.textContent = `${this.artistCollections.length} artist${this.artistCollections.length === 1 ? '' : 's'}`;
      } else {
        matchBadge.textContent = `${this.displayedTracks.length} / ${baseList.length} ${this.activeNav === 'videos' ? 'videos' : 'tracks'}`;
      }
    }

    this.renderQueue();
  }

  /**
   * Updates the track, album, artist, video, and Quality Doctor counters in the Left Sidebar.
   */
  updateSidebarBadges() {
    const trackBadge = document.getElementById('badgeTrackCount');
    const albumBadge = document.getElementById('badgeAlbumCount');
    const artistBadge = document.getElementById('badgeArtistCount');
    const videoBadge = document.getElementById('badgeVideoCount');
    const doctorBadge = document.getElementById('badgeDoctorCount');
    const doctorBtn = document.getElementById('btnRepairDoctorInline');

    const audioTracks = this.catalog.filter((t) => !t.isVideo || isMusicVideoTagged(t));
    if (trackBadge) {
      trackBadge.textContent = String(audioTracks.length);
    }
    if (albumBadge) {
      albumBadge.textContent = String(buildAlbumCollections(audioTracks, { mode: 'all' }).length);
    }
    if (artistBadge) {
      artistBadge.textContent = String(buildArtistCollections(audioTracks, { mode: 'all' }).length);
    }
    if (videoBadge) {
      const vCount = this.catalog.filter((t) => t.isVideo).length;
      videoBadge.textContent = String(vCount);
    }
    const playlistBadge = document.getElementById('badgePlaylistCount') || document.querySelector('.sidebar .nav-item[data-nav="playlists"] .nav-badge');
    if (playlistBadge) playlistBadge.textContent = String(this.smartPlaylists.length);
    const issueCount = this.doctorReport?.issues?.length || 0;
    if (doctorBadge) doctorBadge.textContent = String(issueCount);
    if (doctorBtn) {
      doctorBtn.textContent =
        issueCount > 0
          ? `🩺 Repair ${issueCount} Vault Issues`
          : `🩺 Quality Doctor: 100% Healthy`;
    }
  }

  /**
   * Loads persisted Pro DSP settings safely from localStorage, migrating legacy implicit defaults cleanly.
   */
  _loadProDspSettings() {
    try {
      const raw = globalThis.localStorage?.getItem('vanta_pro_dsp_v1');
      if (raw) {
        this.audioEngine.importPersistState(JSON.parse(raw));
      }
      if (this._migratePureDspDefaults) {
        this.audioEngine.state.lufs = false;
        this.audioEngine.state.limiter = false;
        this.audioEngine.syncDspState();
        this._saveProDspSettings();
        this._saveAudioPrefs();
        this._migratePureDspDefaults = false;
      }
    } catch {
      // Ignore corrupt storage
    }
  }

  /**
   * Saves active Pro DSP parameters & EQ bands to localStorage.
   */
  _saveProDspSettings() {
    try {
      globalThis.localStorage?.setItem('vanta_pro_dsp_v1', JSON.stringify(this.audioEngine.exportPersistState()));
    } catch {
      // Ignore storage quota errors
    }
  }

  /**
   * Persists preferred audio engine, ASIO backend, pause behavior, transport mode, rate lock, and pre-roll settings.
   */
  _saveAudioPrefs() {
    try {
      globalThis.localStorage?.setItem(
        'vanta_audio_prefs_v2',
        JSON.stringify({
          version: 2,
          preferredAudioEngineMode: this.preferredAudioEngineMode,
          outputBackend: this.outputBackend === 'asio' ? 'asio' : 'wasapi',
          asioDriver: this.asioDriver || '',
          asioRawDsd: Boolean(this.asioRawDsd),
          holdWasapiOnPause: Boolean(this.holdWasapiOnPause),
          wasapiPushMode: Boolean(this.wasapiPushMode),
          wasapiBufferMs: Number(this.wasapiBufferMs) || 0,
          clockSwitchPreRollMs: Number(this.clockSwitchPreRollMs) || 0,
          fixedRateLock: Boolean(this.fixedRateLock),
          fixedTargetRate: Number(this.fixedTargetRate) || 48000
        })
      );
    } catch {
      // Ignore storage quota errors
    }
  }

  /**
   * Synchronizes all DSP chips, hardware transport controls, slider readouts, and EQ preset pills.
   */
  _syncAllDspUi() {
    const st = this.audioEngine.state;
    document.querySelectorAll('[data-dsp]').forEach((chip) => {
      const key = chip.dataset.dsp;
      if (typeof st[key] === 'boolean') {
        chip.classList.toggle('on', Boolean(st[key]));
      }
    });

    const rgMode = st.replayGainMode || 'track';
    const rgTarget = Number(st.replayGainTargetLufs) === -14 ? -14 : -18;
    const lufsChip = document.querySelector('[data-dsp="lufs"]');
    if (lufsChip) {
      lufsChip.title = `ReplayGain 2.0 (${rgMode.toUpperCase()} @ ${rgTarget}.0 LUFS)`;
    }
    document.querySelectorAll('[data-rg-mode]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.rgMode === rgMode);
    });
    document.querySelectorAll('[data-rg-lufs]').forEach((btn) => {
      btn.classList.toggle('on', Number(btn.dataset.rgLufs) === rgTarget);
    });

    const backend = this.outputBackend === 'asio' ? 'asio' : 'wasapi';
    document.querySelectorAll('[data-output-backend]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.outputBackend === backend);
    });
    const asioSel = document.getElementById('selectAsioDriver');
    if (asioSel) {
      asioSel.disabled = !(this.asioDevices && this.asioDevices.length);
      if (this.asioDriver && Array.from(asioSel.options).some((o) => o.value === this.asioDriver)) {
        asioSel.value = this.asioDriver;
      }
    }
    const rawDsdBtn = document.getElementById('btnToggleAsioRawDsd');
    if (rawDsdBtn) {
      rawDsdBtn.classList.toggle('on', Boolean(this.asioRawDsd));
      rawDsdBtn.disabled = backend !== 'asio';
    }

    const isStudioPreset = Boolean(st.lufs || st.limiter || st.eqEnabled || st.spatial || st.crossfeed || st.bassBoost);
    document.getElementById('btnStudioDspPreset')?.classList.toggle('on', isStudioPreset);
    document.getElementById('btnApplyStudioPreset')?.classList.toggle('active', Boolean(st.lufs && st.limiter));
    document.getElementById('btnWasapiModeEvent')?.classList.toggle('on', !this.wasapiPushMode);
    document.getElementById('btnWasapiModePush')?.classList.toggle('on', Boolean(this.wasapiPushMode));

    const holdBtn = document.getElementById('btnToggleHoldOnPause');
    if (holdBtn) {
      holdBtn.classList.toggle('on', Boolean(this.holdWasapiOnPause));
      holdBtn.textContent = this.holdWasapiOnPause ? 'Hold Device (0 ms)' : 'Release DAC on Pause';
    }

    document.querySelectorAll('[data-vol-mode]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.volMode === (st.volumeMode || 'auto'));
    });

    const rateLockBtn = document.getElementById('btnToggleFixedRateLock');
    if (rateLockBtn) rateLockBtn.classList.toggle('on', Boolean(this.fixedRateLock));
    const rateSel = document.getElementById('selectFixedTargetRate');
    if (rateSel) {
      rateSel.value = String(this.fixedTargetRate || 48000);
      rateSel.disabled = !this.fixedRateLock;
    }
    document.querySelectorAll('[data-preroll-ms]').forEach((btn) => {
      btn.classList.toggle('on', Number(btn.dataset.prerollMs) === Number(this.clockSwitchPreRollMs));
    });

    const bufSlider = document.getElementById('wasapiBufferMsSlider');
    const bufVal = document.getElementById('wasapiBufferMsVal');
    if (bufSlider && document.activeElement !== bufSlider) bufSlider.value = String(this.wasapiBufferMs || 0);
    if (bufVal) bufVal.textContent = this.wasapiBufferMs > 0 ? `${this.wasapiBufferMs} ms` : 'Auto';

    const capsBadge = document.getElementById('dspHardwareCapsBadge');
    if (capsBadge) {
      if (backend === 'asio') {
        capsBadge.textContent = this.asioDriver
          ? `ASIO: ${this.asioDriver}${this.asioRawDsd ? ' · Raw DSD Ready' : ''}`
          : (this.asioDevices?.length ? `ASIO: ${this.asioDevices[0].name}` : 'ASIO: No Driver Found');
      } else if (this.deviceCaps && this.deviceCaps.ok) {
        const rates = Array.isArray(this.deviceCaps.supportedRates) ? this.deviceCaps.supportedRates : [];
        const maxRate = rates.length ? Math.max(...rates) : (this.deviceCaps.sharedSampleRate || 48000);
        const rateTxt = `${(maxRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
        const hwVol = (this.deviceCaps.hwVolumeSupport & 1) !== 0 ? 'HW Vol ✓' : 'SW Vol Only';
        const modeTxt = this.deviceCaps.exclusiveSupported ? `${rateTxt} · ${this.deviceCaps.maxBitDepth}-bit Excl` : 'Shared Only';
        capsBadge.textContent = `${modeTxt} · ${hwVol}`;
      } else {
        capsBadge.textContent = 'Endpoint: Default Ready';
      }
    }

    const sliderMap = [
      ['dspSpatialWidth', 'dspSpatialWidthVal', `${Math.round(st.spatialWidthPct)}%`, st.spatialWidthPct],
      ['dspCrossfeedLevel', 'dspCrossfeedLevelVal', `${Math.round(st.crossfeedLevelPct)}%`, st.crossfeedLevelPct],
      ['dspBassBoostDb', 'dspBassBoostDbVal', `+${Number(st.bassBoostDb).toFixed(1)} dB`, st.bassBoostDb],
      ['dspExciterMix', 'dspExciterMixVal', `${Math.round(st.exciterMixPct)}%`, st.exciterMixPct],
      ['dspReverbMix', 'dspReverbMixVal', `${Math.round(st.reverbMixPct)}%`, st.reverbMixPct],
      ['dspPitchSemitones', 'dspPitchSemitonesVal', `${st.pitchSemitones > 0 ? '+' : ''}${st.pitchSemitones} st`, st.pitchSemitones]
    ];
    for (const [inputId, valId, textVal, rawVal] of sliderMap) {
      const inputEl = document.getElementById(inputId);
      const valEl = document.getElementById(valId);
      if (inputEl && document.activeElement !== inputEl) inputEl.value = String(rawVal);
      if (valEl) valEl.textContent = textVal;
    }

    const activePreset = Object.keys(EQ_PRESETS).find((name) =>
      EQ_PRESETS[name].every((g, i) => Math.abs((st.gains[i] || 0) - g) < 0.05)
    );
    document.querySelectorAll('#dspEqPresetRow [data-eq-preset]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.eqPreset === activePreset);
    });

    const peqBands = Array.isArray(st.peqBands) ? st.peqBands : [];
    const hasPeq = peqBands.length > 0;
    const peqActive = Boolean(st.peqEnabled && hasPeq);
    const peqSummaryBadge = document.getElementById('peqSummaryBadge');
    if (peqSummaryBadge) {
      if (!hasPeq) {
        peqSummaryBadge.textContent = 'No profile';
      } else {
        const preampStr = `${Number(st.peqPreampDb || 0) >= 0 ? '+' : ''}${Number(st.peqPreampDb || 0).toFixed(1)}dB`;
        const title = st.peqName || 'AutoEQ';
        peqSummaryBadge.textContent = peqActive
          ? `${title} (${peqBands.length}b · ${preampStr})`
          : `[Bypass] ${title} (${peqBands.length}b)`;
      }
    }
    const togglePeqBtn = document.getElementById('btnTogglePeqActive');
    if (togglePeqBtn) {
      togglePeqBtn.disabled = !hasPeq;
      togglePeqBtn.classList.toggle('on', peqActive);
      togglePeqBtn.textContent = peqActive ? 'PEQ ON' : 'Bypassed';
    }
    const clearPeqBtn = document.getElementById('btnClearAutoEq');
    if (clearPeqBtn) clearPeqBtn.disabled = !hasPeq;

    const hasIr = Boolean(st.convolverPath);
    const irActive = Boolean(st.convolverEnabled && hasIr);
    const convInfoBadge = document.getElementById('convolverInfoBadge');
    if (convInfoBadge) {
      if (!hasIr) {
        convInfoBadge.textContent = 'No IR loaded';
      } else {
        const srTxt = st.convolverSampleRate ? `${(st.convolverSampleRate / 1000).toFixed(1).replace(/\.0$/, '')}k` : '';
        const chTxt = st.convolverChannels ? `${st.convolverChannels}ch` : '';
        const metaParts = [srTxt, chTxt].filter(Boolean).join(' · ');
        convInfoBadge.textContent = `${irActive ? '' : '[Bypass] '}${st.convolverName || 'Room IR'}${metaParts ? ` (${metaParts})` : ''}`;
      }
    }
    const toggleConvBtn = document.getElementById('btnToggleConvolverActive');
    if (toggleConvBtn) {
      toggleConvBtn.disabled = !hasIr;
      toggleConvBtn.classList.toggle('on', irActive);
      toggleConvBtn.textContent = irActive ? 'Convolver ON' : 'Bypassed';
    }
    const clearConvBtn = document.getElementById('btnClearConvolverIr');
    if (clearConvBtn) clearConvBtn.disabled = !hasIr;

    const wetPct = Math.max(0, Math.min(100, Math.round(Number(st.convolverWetPct ?? 100) || 0)));
    const wetSlider = document.getElementById('convolverWetSlider');
    const wetVal = document.getElementById('convolverWetVal');
    if (wetSlider && document.activeElement !== wetSlider) wetSlider.value = String(wetPct);
    if (wetVal) wetVal.textContent = `${wetPct}%`;
  }

  /**
   * Renders the 10 interactive frequency columns inside the Studio Pro DSP Rack Modal.
   */
  renderEqColumns() {
    const container = document.getElementById('eqColumnsContainer');
    const labelsRow = document.getElementById('eqFreqLabelsRow');
    if (!container) return;
    container.replaceChildren();
    if (labelsRow) labelsRow.replaceChildren();

    EQ_FREQUENCIES.forEach((freq, idx) => {
      const col = document.createElement('div');
      col.className = 'eq-col';
      const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
      const fullLabel = freq >= 1000 ? `${freq / 1000}kHz` : `${freq}Hz`;
      const currentGain = this.audioEngine.state.gains[idx] || 0;
      const pct = Math.round(((currentGain + 12) / 24) * 82 + 14);

      const bar = document.createElement('div');
      bar.className = 'eq-bar-fill';
      bar.style.height = `${pct}%`;
      col.title = `${fullLabel}: ${currentGain > 0 ? '+' : ''}${currentGain} dB (Click to adjust)`;

      const dbSpan = document.createElement('span');
      dbSpan.className = 'dsp-eq-label-db';
      dbSpan.textContent = `${currentGain > 0 ? '+' : ''}${currentGain}`;

      col.addEventListener('click', async (e) => {
        const rect = col.getBoundingClientRect();
        const clickRatio = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        const newDb = Math.round(clickRatio * 24 - 12);
        this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
        this.audioEngine.setEqBandGain(idx, newDb);
        await this.ensurePlaybackEngineForCurrentDsp(false);
        const newPct = Math.round(((newDb + 12) / 24) * 82 + 14);
        bar.style.height = `${newPct}%`;
        dbSpan.textContent = `${newDb > 0 ? '+' : ''}${newDb}`;
        col.title = `${fullLabel}: ${newDb > 0 ? '+' : ''}${newDb} dB`;
        this._syncAllDspUi();
        this._saveProDspSettings();
        this.updateStreamTelemetry();
        this.setToast(`EQ ${fullLabel} set to ${newDb > 0 ? '+' : ''}${newDb} dB`);
      });

      col.appendChild(bar);
      container.appendChild(col);

      if (labelsRow) {
        const cell = document.createElement('div');
        cell.className = 'dsp-eq-label-cell';
        cell.textContent = label;
        cell.appendChild(dbSpan);
        labelsRow.appendChild(cell);
      }
    });
  }

  /**
   * Resolves effective ReplayGain 2.0 multiplier from embedded ID3/Vorbis tags or measured EBU R128 loudness.
   * @returns {number} Linear gain factor.
   */
  getEffectiveReplayGain() {
    const activeTrack = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex] || null;
    const mergedTags = {
      replayGainTrackGainDb: activeTrack?.replayGainTrackGainDb,
      replayGainTrackPeak: activeTrack?.replayGainTrackPeak,
      replayGainAlbumGainDb: activeTrack?.replayGainAlbumGainDb,
      replayGainAlbumPeak: activeTrack?.replayGainAlbumPeak,
      ...(this.activeTrackTags || {})
    };
    const info = resolveReplayGain2({
      enabled: Boolean(this.audioEngine.state.lufs),
      mode: this.audioEngine.state.replayGainMode || 'track',
      targetLufs: Number(this.audioEngine.state.replayGainTargetLufs) === -14 ? -14 : -18,
      tags: mergedTags,
      r128: this.activeTrackR128,
      clipProtect: true
    });
    this.lastReplayGainInfo = info;
    return info.linearGain;
  }

  /**
   * Enumerates clean-room Win32 ASIO drivers via Main Process and populates the ASIO selector safely.
   */
  async populateAsioDevices() {
    const sel = document.getElementById('selectAsioDriver');
    if (!window.vantaAPI?.listAsioDevices) return [];
    try {
      const devices = await window.vantaAPI.listAsioDevices();
      this.asioDevices = Array.isArray(devices) ? devices : [];
      if (sel) {
        const opts = [];
        if (!this.asioDevices.length) {
          const emptyOpt = document.createElement('option');
          emptyOpt.value = '';
          emptyOpt.textContent = 'No ASIO Drivers Detected';
          opts.push(emptyOpt);
        } else {
          for (const drv of this.asioDevices) {
            const opt = document.createElement('option');
            opt.value = drv.name || '';
            opt.textContent = drv.name || drv.description || drv.clsid || 'ASIO Driver';
            opts.push(opt);
          }
          if (!this.asioDriver || !this.asioDevices.some((d) => d.name === this.asioDriver)) {
            this.asioDriver = this.asioDevices[0].name || '';
          }
        }
        sel.replaceChildren(...opts);
        if (this.asioDriver) sel.value = this.asioDriver;
      }
      this._syncAllDspUi();
      return this.asioDevices;
    } catch {
      return [];
    }
  }

  /**
   * Opens a ScarletBook SACD ISO disc image and merges its 2ch/Multichannel tracks into the library view.
   * @param {string} [isoPath=''] - Optional disk path; opens file dialog when omitted.
   */
  async importSacdIsoFiles(isoPath = '') {
    if (!window.vantaAPI?.importSacdIso) return;
    try {
      const res = await window.vantaAPI.importSacdIso(isoPath);
      if (!res || res.canceled) return;
      if (!res.ok || !Array.isArray(res.tracks) || !res.tracks.length) {
        this.setToast(`SACD ISO import failed: ${res?.error || 'No playable DSD tracks found'}`);
        return;
      }
      const existing = new Map((this.sacdVirtualTracks || []).map((t) => [this._getTrackUniqueKey(t), t]));
      for (const tr of res.tracks) {
        const k = this._getTrackUniqueKey(tr);
        if (k) existing.set(k, tr);
      }
      this.sacdVirtualTracks = Array.from(existing.values());
      const diskTracks = this.catalog.filter((t) => !t.sacdTrack);
      this.mergeVaultCatalog(diskTracks, this.doctorReport, this.smartPlaylists);
      this.setToast(`SACD ISO mounted: ${res.info?.albumTitle || res.tracks?.[0]?.album || 'SACD Album'} (${res.tracks.length} DSD tracks)`);
    } catch (err) {
      this.setToast(`SACD ISO error: ${err?.message || 'Unknown error'}`);
    }
  }

  /**
   * Scans the active album with EBU R128 Album+Track loudness and writes ReplayGain 2.0 ID3v2/FLAC tags.
   */
  async analyzeActiveAlbumReplayGain() {
    if (!window.vantaAPI?.analyzeAlbumReplayGain) return;
    const activeTrack = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex] || this.catalog[0] || null;
    if (!activeTrack) {
      this.setToast('Select a track or album first to run ReplayGain 2.0 analysis');
      return;
    }
    const albumNorm = String(activeTrack.album || '').trim().toLowerCase();
    let albumPool = albumNorm
      ? this.catalog.filter((t) => !t.isVideo && !t.sacdTrack && t.filePath && String(t.album || '').trim().toLowerCase() === albumNorm)
      : [];
    if (!albumPool.length && activeTrack.filePath && !activeTrack.isVideo && !activeTrack.sacdTrack) {
      albumPool = [activeTrack];
    }
    if (!albumPool.length) {
      this.setToast('No taggable local audio files selected for ReplayGain 2.0 scan');
      return;
    }

    const st = this.audioEngine.state;
    const targetLufs = Number(st.replayGainTargetLufs) === -14 ? -14 : -18;
    const btn = document.getElementById('btnAnalyzeAlbumRg');
    if (btn) {
      btn.disabled = true;
      btn.textContent = `Scanning ${albumPool.length}...`;
    }
    try {
      this.setToast(`Scanning ${albumPool.length} track(s) @ ${targetLufs}.0 LUFS (ReplayGain 2.0)...`);
      const res = await window.vantaAPI.analyzeAlbumReplayGain({
        tracks: albumPool.slice(0, 64).map((t) => ({ filePath: t.filePath, durationSec: Number(t.durationSec) || 180 })),
        targetLufs,
        writeTags: true
      });
      if (!res?.ok) {
        this.setToast(`ReplayGain scan failed: ${res?.error || 'Could not measure tracks'}`);
        return;
      }

      const byPath = new Map((res.tracks || []).map((r) => [String(r.filePath || '').toLowerCase(), r]));
      for (const item of this.catalog) {
        const hit = byPath.get(String(item.filePath || '').toLowerCase());
        if (!hit) continue;
        item.replayGainTrackGainDb = hit.trackGainDb;
        item.replayGainTrackPeak = hit.trackPeakLinear;
        item.replayGainAlbumGainDb = hit.albumGainDb;
        item.replayGainAlbumPeak = hit.albumPeakLinear;
      }
      const activeHit = activeTrack.filePath ? byPath.get(String(activeTrack.filePath).toLowerCase()) : null;
      if (activeHit) {
        this.activeTrackTags = {
          replayGainTrackGainDb: activeHit.trackGainDb,
          replayGainTrackPeak: activeHit.trackPeakLinear,
          replayGainAlbumGainDb: activeHit.albumGainDb,
          replayGainAlbumPeak: activeHit.albumPeakLinear
        };
      }

      if (!st.lufs) {
        st.lufs = true;
        if (st.replayGainMode === 'off') st.replayGainMode = albumPool.length > 1 ? 'album' : 'track';
        this.audioEngine.syncDspState();
        this._saveProDspSettings();
      }
      this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
      if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
        window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
      }
      this._syncAllDspUi();
      this.updateStreamTelemetry();
      const taggedCount = (res.tracks || []).filter((r) => r.taggedOk).length;
      const albLufs = res.albumSummary?.albumLufs ?? res.tracks?.[0]?.albumLufs ?? targetLufs;
      const albGain = res.albumSummary?.albumGainDb ?? res.tracks?.[0]?.albumGainDb ?? 0;
      this.setToast(
        `ReplayGain 2.0: Album ${albLufs} LUFS (${albGain > 0 ? '+' : ''}${albGain} dB) · ${taggedCount}/${res.tracks.length} tagged`
      );
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Analyze & Tag Album';
      }
    }
  }

  /**
   * Returns combined linear gain (EBU R128 ReplayGain * Master Volume) for Native WASAPI PCM scaling.
   * When Windows hardware endpoint volume is active (`hwSupport & 1`), hardware handles volume without double attenuation.
   * @returns {number} Combined gain multiplier.
   */
  getEffectiveWasapiGain() {
    return computeWasapiGainFactor({
      volumeMode: this.audioEngine?.state?.volumeMode || 'auto',
      windowsVolumeLinked: this.windowsVolumeLinked,
      deviceHwVolumeSupport: this.deviceHwVolumeSupport,
      isMuted: this.isMuted,
      masterVolumeLinear: this.masterVolumeLinear,
      replayGainLinear: this.getEffectiveReplayGain()
    });
  }

  /**
   * Renders master volume slider/icon/percentage UI without pushing any write to Windows Core Audio.
   * @param {number} pct - Display volume [0..100].
   * @param {boolean} muted - Mute state.
   */
  _renderMasterVolumeUi(pct, muted) {
    const visualPct = muted ? 0 : pct;
    const slider = document.getElementById('masterVolumeSlider');
    const pctLabel = document.getElementById('volumePercentLabel');
    if (slider) {
      slider.value = String(visualPct);
      slider.style.setProperty('--vol-pct', `${visualPct}%`);
    }
    if (pctLabel) pctLabel.textContent = `${visualPct}%`;
    this.renderVolumeIcon(pct, muted);
  }

  /**
   * Updates the Figma-grade crisp SVG Play/Pause icon cleanly.
   * @param {boolean} playing - Current playing state.
   */
  setPlayPauseIcon(playing) {
    const svg = document.getElementById('playPauseIconSvg');
    if (!svg) return;
    svg.innerHTML = playing
      ? '<rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/>'
      : '<path d="M7.5 5.14a1 1 0 0 1 1.52-.85l10.6 6.86a1 1 0 0 1 0 1.7l-10.6 6.86a1 1 0 0 1-1.52-.85V5.14Z"/>';
  }

  /**
   * Updates the Figma-grade crisp SVG Volume / Mute icon cleanly.
   * @param {number} pct - Volume percentage (0..100).
   * @param {boolean} muted - Muted flag.
   */
  renderVolumeIcon(pct, muted) {
    const svg = document.getElementById('volumeIconSvg');
    if (!svg) return;
    if (muted || pct === 0) {
      svg.innerHTML =
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';
    } else if (pct < 45) {
      svg.innerHTML = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>';
    } else {
      svg.innerHTML =
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>';
    }
  }

  /**
   * Synchronizes VANTA UI slider & Mute button when Windows Taskbar/Keys/Bluetooth changes volume externally.
   * @param {{ level: number, muted: boolean, hwSupport?: number }} volState - Endpoint volume snapshot.
   */
  applySystemVolumeState(volState) {
    if (!volState || typeof volState.level !== 'number') return;
    this.windowsVolumeLinked = true;
    if (volState.hwSupport !== undefined) {
      this.deviceHwVolumeSupport = Number(volState.hwSupport) || 0;
    }
    const volMode = this.audioEngine?.state?.volumeMode || 'auto';
    if (volMode === 'auto') {
      const pct = Math.max(0, Math.min(100, Math.round(volState.level * 100)));
      const muted = Boolean(volState.muted) || pct === 0;
      this.masterVolumePct = pct;
      this.isMuted = muted;
      if (pct > 0 && !muted) this.preMuteVolumePct = pct;
      this.masterVolumeLinear = muted ? 0 : Math.pow(pct / 100, 1.75);
      this._renderMasterVolumeUi(pct, muted);
      this.audioEngine.setVolume(muted ? 0 : 1.0);
    } else {
      const studioVol = volMode === 'fixed0db' ? (this.isMuted ? 0 : 1.0) : (this.isMuted ? 0 : this.masterVolumeLinear);
      this.audioEngine.setVolume(studioVol);
    }

    if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
      window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
    }
    this.updateStreamTelemetry();
  }

  /**
   * Sets Master Volume (0-100%), routing cleanly via Windows Hardware Volume, 64-Bit Software Volume,
   * or Fixed 0 dBFS bypass depending on `volumeMode`.
   * @param {number} pct - Volume percentage in [0, 100].
   * @param {boolean} [silent=false] - Skip toast notification.
   */
  setMasterVolume(pct, silent = false) {
    const volMode = this.audioEngine?.state?.volumeMode || 'auto';
    if (volMode === 'fixed0db') {
      if (!silent) this.setToast('Volume locked at Fixed 0 dBFS unity output');
      return;
    }

    const clamped = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    this.masterVolumePct = clamped;
    this.isMuted = clamped === 0;
    if (clamped > 0) this.preMuteVolumePct = clamped;
    this.masterVolumeLinear = clamped <= 0 ? 0 : Math.pow(clamped / 100, 1.75);

    try {
      globalThis.localStorage?.setItem('vanta_master_volume_v1', String(clamped));
    } catch {
      // Ignore storage quota issues
    }

    this._renderMasterVolumeUi(clamped, this.isMuted);

    if (volMode === 'auto' && window.vantaAPI) {
      this.windowsVolumeLinked = true;
      window.vantaAPI.setSystemVolume(clamped / 100).catch(() => {});
      this.audioEngine.setVolume(this.isMuted ? 0 : 1.0);
    } else {
      this.audioEngine.setVolume(this.isMuted ? 0 : this.masterVolumeLinear);
    }

    if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
      window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
    }
    this.updateStreamTelemetry();
    if (!silent) {
      const modeTag = volMode === 'software' ? '64-Bit SW Volume' : 'System Volume';
      this.setToast(clamped === 0 ? 'Master Audio Muted' : `${modeTag}: ${clamped}%`);
    }
  }

  /**
   * Toggles Mute / Unmute cleanly across Windows Endpoint or 64-Bit Software Volume.
   */
  toggleMute() {
    const volMode = this.audioEngine?.state?.volumeMode || 'auto';
    if (volMode === 'auto' && window.vantaAPI && this.windowsVolumeLinked) {
      const nextMuted = !this.isMuted;
      this.isMuted = nextMuted;
      if (!nextMuted && this.masterVolumePct === 0) {
        this.setMasterVolume(this.preMuteVolumePct || 85);
        return;
      }
      window.vantaAPI.setSystemMute(nextMuted).catch(() => {});
      this._renderMasterVolumeUi(this.masterVolumePct, nextMuted);
      this.audioEngine.setVolume(nextMuted ? 0 : 1.0);
      if (this.engineMode === 'wasapi' && this.isPlaying) {
        window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
      }
      this.setToast(nextMuted ? 'Audio Muted' : `System Volume: ${this.masterVolumePct}%`);
      return;
    }

    const nextMuted = !this.isMuted;
    this.isMuted = nextMuted;
    this._renderMasterVolumeUi(this.masterVolumePct, nextMuted);
    this.audioEngine.setVolume(nextMuted ? 0 : (volMode === 'fixed0db' ? 1.0 : this.masterVolumeLinear));
    if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
      window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
    }
    this.updateStreamTelemetry();
    this.setToast(nextMuted ? 'Audio Muted' : 'Audio Unmuted');
  }

  /**
   * Resolves the total duration in seconds for a track or loaded HTML5 media element.
   * @param {object|null} track - Active or previewed track.
   * @param {HTMLMediaElement|null} [mediaEl=null] - Associated media element.
   * @returns {number} Duration in seconds (0 if unknown).
   */
  _resolveEffectiveDurationSec(track, mediaEl = null) {
    if (track?.isVideo && this.activeVideoProbe?.durationSec > 0) {
      return Number(this.activeVideoProbe.durationSec);
    }
    if (!track?.isVideo && this.activeTrackProbe?.durationSec > 0) {
      return Number(this.activeTrackProbe.durationSec);
    }
    if (mediaEl && Number.isFinite(mediaEl.duration) && mediaEl.duration > 0) {
      const baseOff = track?.isVideo ? this._videoSeekOffsetSec : this.studioSeekOffsetSec;
      return baseOff + mediaEl.duration;
    }
    return Math.max(0, Number(track?.durationSec) || 0);
  }

  /**
   * Returns the active FFmpeg seek offset (isolated per media domain: audio vs video).
   * @param {object|null} track - Active track object.
   * @returns {number} Active seek offset in seconds.
   */
  _getMediaSeekOffsetSec(track) {
    return track?.isVideo ? this._videoSeekOffsetSec : this.studioSeekOffsetSec;
  }

  /**
   * Sets the active FFmpeg seek offset for audio or video cleanly without cross-polluting the other stage.
   * @param {object|null} track - Active track object.
   * @param {number} sec - Seek offset in seconds.
   */
  _setMediaSeekOffsetSec(track, sec) {
    const val = Math.max(0, Number(sec) || 0);
    if (track?.isVideo) {
      this._videoSeekOffsetSec = val;
    } else {
      this.studioSeekOffsetSec = val;
    }
  }

  /**
   * Applies a seek offset safely on a native Chromium byte-range media element (immediate or on loadedmetadata).
   * @param {HTMLMediaElement|null} mediaEl - Target audio or video element.
   * @param {number} targetSec - Target timeline offset in seconds.
   */
  _applyNativeSeekOnElement(mediaEl, targetSec) {
    if (!mediaEl) return;
    const desired = Math.max(0, Number(targetSec) || 0);
    const apply = () => {
      if (Number.isFinite(mediaEl.duration) && mediaEl.duration > 0) {
        mediaEl.currentTime = Math.min(Math.max(0, mediaEl.duration - 0.05), desired);
      } else {
        mediaEl.currentTime = desired;
      }
    };
    if (mediaEl.readyState >= 1) {
      apply();
    } else {
      mediaEl.addEventListener('loadedmetadata', apply, { once: true });
    }
  }

  /**
   * Unified seek dispatcher for Studio DSP audio & video playback (handles both native range & FFmpeg pipes).
   * @param {object} track - Target audio or video track.
   * @param {number} targetSec - Target timeline timestamp in seconds.
   * @param {boolean} triggerPlay - Whether playback should continue/restart when active.
   * @param {object} [opts={}] - Optional video strategy/element overrides.
   */
  _seekStudioMedia(track, targetSec, triggerPlay = true, opts = {}) {
    if (!track) return;
    const isVideoTrack = Boolean(track.isVideo);
    const activeDeck = this.audioEngine.getActiveDeckElement() || this.audioEl;
    const mediaEl = opts.mediaEl || (isVideoTrack ? this.videoEl : activeDeck);
    const strategy = opts.strategyOverride || this.activeVideoStrategy;
    const usesFfmpeg = Boolean(track.filePath) && requiresStudioFfmpegStream(track, strategy);
    const safeSec = Math.max(0, Number(targetSec) || 0);

    if (usesFfmpeg) {
      const nextOffset = safeSec > 0.5 ? safeSec : 0;
      this._setMediaSeekOffsetSec(track, nextOffset);
      if (!opts.independentVideo) {
        this._pendingStudioSeekSec = nextOffset;
      }
      const activelyPlaying = Boolean(
        isVideoTrack && opts.independentVideo
          ? (mediaEl && !mediaEl.paused)
          : this.isPlaying
      );
      if (triggerPlay && activelyPlaying) {
        if (opts.independentVideo && mediaEl) {
          const seekUrl = this.buildVideoStreamUrl(track, this.activeVideoAudioIdx, nextOffset);
          mediaEl.src = seekUrl;
          this._lastLoadedVideoUrl = seekUrl;
          mediaEl.play().catch(() => {});
        } else {
          void this.startPlayback(safeSec).catch(() => {});
        }
      } else if (isVideoTrack && mediaEl && track.filePath) {
        const pausedSeekUrl = this.buildVideoStreamUrl(track, this.activeVideoAudioIdx, nextOffset);
        mediaEl.src = pausedSeekUrl;
        this._lastLoadedVideoUrl = pausedSeekUrl;
      }
      return;
    }

    this._setMediaSeekOffsetSec(track, 0);
    if (mediaEl && (mediaEl.currentSrc || mediaEl.src) && mediaEl.readyState >= 1) {
      if (!opts.independentVideo) this._pendingStudioSeekSec = null;
      this._applyNativeSeekOnElement(mediaEl, safeSec);
    } else {
      if (!opts.independentVideo) this._pendingStudioSeekSec = safeSec;
      if (triggerPlay && this.isPlaying && !opts.independentVideo) {
        void this.startPlayback(safeSec).catch(() => {});
      }
    }
  }

  /**
   * Seeks relatively forward or backward by `deltaSec` across active WASAPI or Studio DSP playback.
   * @param {number} deltaSec - Relative seconds offset (e.g., -10 or +10).
   */
  seekRelative(deltaSec) {
    const track = this.displayedTracks[this.activeTrackIndex];
    if (!track) return;
    if (this.engineMode === 'wasapi' && window.vantaAPI && track.filePath && !track.isVideo) {
      const totalSec = this._resolveEffectiveDurationSec(track, null) || 232;
      const targetSec = Math.max(0, Math.min(Math.max(1, totalSec - 1), (this.wasapiCurrentPositionSec || 0) + deltaSec));
      this.updateTimelineUi(targetSec, totalSec);
      if (this.isPlaying) {
        void this.startPlayback(targetSec).catch(() => {});
      } else {
        this.wasapiCurrentPositionSec = targetSec;
        this.wasapiResumeSec = targetSec;
        this.wasapiPausedTrackKey = this._getTrackUniqueKey(track);
      }
      return;
    }

    const activeDeck = this.audioEngine.getActiveDeckElement() || this.audioEl;
    const activeMedia = track.isVideo ? this.videoEl : activeDeck;
    const totalSec = this._resolveEffectiveDurationSec(track, activeMedia) || 232;
    const currentActual =
      this._pendingStudioSeekSec !== null && !this.isPlaying
        ? this._pendingStudioSeekSec
        : (this._getMediaSeekOffsetSec(track) + (activeMedia?.currentTime || 0));
    const nextSec = Math.max(0, Math.min(Math.max(1, totalSec - 0.5), currentActual + deltaSec));
    this.updateTimelineUi(nextSec, totalSec);
    this._seekStudioMedia(track, nextSec, this.isPlaying);
  }

  /**
   * Cycles repeat mode ('queue' -> 'one' -> 'off').
   */
  cycleRepeatMode() {
    const order = ['queue', 'one', 'off'];
    this.repeatMode = order[(order.indexOf(this.repeatMode) + 1) % order.length];
    const btn = document.getElementById('btnRepeatMode');
    const oneBadge = document.getElementById('repeatOneBadge');
    if (btn) {
      btn.classList.toggle('active', this.repeatMode !== 'off');
      btn.title =
        this.repeatMode === 'one'
          ? 'Repeat Mode: Current Track (1)'
          : this.repeatMode === 'queue'
            ? 'Repeat Mode: Queue'
            : 'Repeat Mode: Off';
    }
    if (oneBadge) {
      oneBadge.classList.toggle('hidden', this.repeatMode !== 'one');
    }
    this.setToast(
      this.repeatMode === 'one'
        ? 'Repeat: Current Track'
        : this.repeatMode === 'queue'
          ? 'Repeat: Queue Loop'
          : 'Repeat: Off'
    );
  }

  /**
   * Handles end-of-track transitions according to active repeatMode.
   */
  handleTrackEnded() {
    if (this.repeatMode === 'one') {
      void this.startPlayback(0).catch(() => {});
      return;
    }
    if (this.repeatMode === 'queue' || this.activeTrackIndex < this.displayedTracks.length - 1) {
      this.stepTrack(1, true);
      return;
    }
    this.pausePlayback();
  }

  /**
   * Binds or updates a freeze-safe custom HTML Studio Combo box (avoids Win32 native <select> popup locks in frameless topbars).
   * @param {string} containerId - Combo wrapper element ID.
   * @param {Array<{ value: string, label: string, displayLabel?: string }>} items - Selectable options.
   * @param {string} activeValue - Currently selected option value.
   * @param {(item: { value: string, label: string, displayLabel?: string }) => Promise<void>|void} onSelect - Selection callback.
   */
  setupCustomCombo(containerId, items, activeValue, onSelect, options = {}) {
    const root = document.getElementById(containerId);
    if (!root) return;
    const trigger = root.querySelector('.vanta-combo-trigger');
    const labelEl = root.querySelector('.vanta-combo-label');
    const menuEl = root.querySelector('.vanta-combo-menu');
    if (!trigger || !labelEl || !menuEl) return;

    root._onOpenCombo = typeof options.onOpen === 'function' ? options.onOpen : null;

    const currentItem = items.find((i) => i.value === activeValue) || items[0];
    if (currentItem) {
      labelEl.textContent = currentItem.displayLabel || currentItem.label;
    }

    const closeAllMenus = () => {
      document.querySelectorAll('.vanta-combo-menu').forEach((m) => m.classList.add('hidden'));
      document.querySelectorAll('.vanta-combo-trigger').forEach((t) => t.setAttribute('aria-expanded', 'false'));
    };

    const renderMenu = (selectedVal) => {
      menuEl.innerHTML = '';
      items.forEach((item) => {
        const optBtn = document.createElement('button');
        optBtn.type = 'button';
        optBtn.className = `vanta-combo-item ${item.value === selectedVal ? 'selected' : ''}`;
        optBtn.setAttribute('role', 'option');
        optBtn.setAttribute('aria-selected', String(item.value === selectedVal));
        optBtn.textContent = item.label;
        optBtn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          closeAllMenus();
          labelEl.textContent = item.displayLabel || item.label;
          renderMenu(item.value);
          await onSelect(item);
        });
        menuEl.appendChild(optBtn);
      });
    };

    renderMenu(currentItem ? currentItem.value : activeValue);

    if (!root.dataset.comboBound) {
      root.dataset.comboBound = '1';
      trigger.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isOpen = !menuEl.classList.contains('hidden');
        closeAllMenus();
        if (!isOpen) {
          menuEl.classList.remove('hidden');
          trigger.setAttribute('aria-expanded', 'true');
          root._onOpenCombo?.();
        }
      });

      if (!VantaStudioApp._comboDocListenerBound) {
        VantaStudioApp._comboDocListenerBound = true;
        document.addEventListener('click', () => {
          document.querySelectorAll('.vanta-combo-menu').forEach((m) => m.classList.add('hidden'));
          document.querySelectorAll('.vanta-combo-trigger').forEach((t) => t.setAttribute('aria-expanded', 'false'));
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            document.querySelectorAll('.vanta-combo-menu').forEach((m) => m.classList.add('hidden'));
            document.querySelectorAll('.vanta-combo-trigger').forEach((t) => t.setAttribute('aria-expanded', 'false'));
          }
        });
      }
    }
  }

  /**
   * Populates hardware DAC / audio output endpoints into the custom Audio Output combo box.
   * Automatically refreshes when Bluetooth/USB audio endpoints hot-plug or when combo opens.
   * @param {boolean} [isHotPlugRefresh=false] - True when triggered by devicechange or combo open.
   */
  async refreshDeviceCaps(deviceId = this.selectedDeviceId) {
    if (!window.vantaAPI?.probeAudioCaps) return null;
    try {
      const caps = await window.vantaAPI.probeAudioCaps({ deviceId: deviceId || '', channels: 2 });
      if (caps && caps.ok) {
        this.deviceCaps = caps;
        if (caps.hwVolumeSupport !== undefined) {
          this.deviceHwVolumeSupport = Number(caps.hwVolumeSupport) || 0;
        }
        this._syncAllDspUi();
        this.updateStreamTelemetry();
      }
      return caps;
    } catch {
      return null;
    }
  }

  async populateAudioDevices(isHotPlugRefresh = false) {
    if (this._refreshingDevices) return;
    this._refreshingDevices = true;
    try {
      const fallbackItems = [{ value: '', label: '🔊 Default Audio Device', displayLabel: '🔊 Default Audio Device', rawName: '' }];
      const onDeviceSelect = async (item) => {
        this.selectedDeviceId = item.value || '';
        this.selectedDeviceName = item.rawName || '';
        await this.audioEngine.setOutputSinkId(this.selectedDeviceId, this.selectedDeviceName);
        if (window.vantaAPI) {
          window.vantaAPI.setVolumeDevice(this.selectedDeviceId).catch(() => {});
          await this.refreshDeviceCaps(this.selectedDeviceId);
        }
        if (this.engineMode === 'wasapi' && this.isPlaying) {
          const resumeSec = this.wasapiCurrentPositionSec || 0;
          void this.startPlayback(resumeSec).catch(() => {});
        }
        this.setToast(`Audio Output DAC: ${item.displayLabel || item.label}`);
      };

      const comboRoot = document.getElementById('audioOutputCombo');
      const comboOpts = { onOpen: () => this.populateAudioDevices(true) };
      if (!comboRoot?.dataset.comboBound) {
        this.setupCustomCombo('audioOutputCombo', fallbackItems, this.selectedDeviceId || '', onDeviceSelect, comboOpts);
      }
      if (!window.vantaAPI) return;

      const devices = await window.vantaAPI.listAudioDevices();
      if (!Array.isArray(devices) || !devices.length) return;
      const defaultDev = devices.find((d) => d.isDefault);
      const items = [
        {
          value: '',
          label: defaultDev ? `🔊 Default (${defaultDev.name})` : '🔊 Default Audio Device',
          displayLabel: defaultDev ? `🔊 Default (${defaultDev.name})` : '🔊 Default Audio Device',
          rawName: defaultDev?.name || ''
        },
        ...devices.map((dev) => ({
          value: dev.id,
          label: `${dev.isDefault ? '★ ' : '🎧 '}${dev.name}`,
          displayLabel: `${dev.isDefault ? '★ ' : '🎧 '}${dev.name}`,
          rawName: dev.name
        }))
      ];
      this.setupCustomCombo('audioOutputCombo', items, this.selectedDeviceId || '', onDeviceSelect, comboOpts);

      if (isHotPlugRefresh) {
        const activeMatch = items.find((i) => i.value === (this.selectedDeviceId || ''));
        if (activeMatch) {
          this.selectedDeviceName = activeMatch.rawName || '';
          if (this.engineMode === 'dsp' && this.audioEngine.ctx) {
            await this.audioEngine.setOutputSinkId(this.selectedDeviceId, this.selectedDeviceName);
          }
        }
      }
      await this.refreshDeviceCaps(this.selectedDeviceId);
    } catch {
      // Keep existing device options
    } finally {
      this._refreshingDevices = false;
    }
  }

  /**
   * Updates the real-time Right Dock audio telemetry badge (codec, kHz/bit, WASAPI/DSP, R128 LUFS).
   */
  /**
   * Pushes PurePath 64 native DSP settings (10-band EQ, Sub-Bass, Bauer Crossfeed, Limiter)
   * over the active WASAPI named-pipe without interrupting Bit-Perfect exclusive playback.
   */
  /**
   * Pushes PurePath 64 native DSP settings (10-band EQ, Sub-Bass, Bauer Crossfeed, Limiter)
   * and AutoEQ Parametric EQ filters over the active WASAPI/ASIO pipe without interrupting playback.
   */
  syncNativeWasapiDsp() {
    if (this.engineMode !== 'wasapi' || !window.vantaAPI) return;
    const spec = serializeNativeDspSpecFromState(this.audioEngine.state);
    window.vantaAPI.wasapiCmd(`DSP ${spec}`).catch(() => {});
    const peqSpec = serializePeqWireSpec(this.audioEngine.state);
    window.vantaAPI.wasapiCmd(peqSpec ? `PEQ_SPEC ${peqSpec}` : 'PEQ_OFF').catch(() => {});
  }

  /**
   * Synchronizes the 64-bit partitioned FFT Convolver IR with the native engine when active.
   * @param {boolean|null} [forceEnable=null] - Optional override for enabled state.
   */
  async syncNativeConvolver(forceEnable = null) {
    if (this.engineMode !== 'wasapi' || !window.vantaAPI?.loadConvolverIr) return null;
    const st = this.audioEngine.state;
    const enabled = forceEnable === null
      ? Boolean(st.convolverEnabled && st.convolverPath)
      : Boolean(forceEnable && st.convolverPath);
    const wetPct = Math.max(0, Math.min(100, Math.round(Number(st.convolverWetPct ?? 100) || 0)));
    try {
      const res = await window.vantaAPI.loadConvolverIr({
        enabled,
        filePath: enabled ? st.convolverPath : '',
        wetPct
      });
      if (res?.ok && res.resampled) {
        this.setToast(`Convolver IR resampled cleanly (64-bit Kaiser-Sinc -> ${res.sampleRate} Hz)`);
      } else if (res && !res.ok && res.error && enabled) {
        this.setToast(`Convolver load failed: ${res.error}`);
      }
      return res;
    } catch {
      return null;
    }
  }

  /**
   * Fetches and decodes the persisted convolution WAV IR into the Web Audio ConvolverNode when Studio DSP is active.
   */
  async _ensureStudioConvolverIrLoaded() {
    const st = this.audioEngine?.state;
    if (!st?.convolverEnabled || !st?.convolverPath || !this.audioEngine?.irConvolverNode) return false;
    if (this.audioEngine.irConvolverNode.buffer && this.audioEngine._loadedConvolverPath === st.convolverPath) {
      return true;
    }
    try {
      const res = await fetch(this._buildLocalMediaUrl({ filePath: st.convolverPath }));
      if (!res.ok) return false;
      const wavBytes = await res.arrayBuffer();
      const loaded = await this.audioEngine.setStudioConvolverIrBytes(wavBytes);
      if (loaded) {
        this.audioEngine._loadedConvolverPath = st.convolverPath;
      }
      return loaded;
    } catch {
      return false;
    }
  }

  /**
   * Keeps WASAPI PurePath 64 active for EQ/PEQ/Convolver/Bass/Crossfeed/Limiter changes, and seamlessly
   * transitions to Studio DSP only when Web Audio-exclusive processors (Spatial/Reverb/Pitch) engage.
   * @param {boolean} [actionRequiresStudio=false] - Whether the triggering action requires Studio DSP.
   */
  async ensurePlaybackEngineForCurrentDsp(actionRequiresStudio = false) {
    const needsStudio = Boolean(actionRequiresStudio) || requiresStudioDsp(this.audioEngine.state);
    if (this.engineMode === 'wasapi') {
      if (needsStudio) {
        await this.setEngineMode('dsp', true);
      } else {
        this.syncNativeWasapiDsp();
        this.updateStreamTelemetry();
      }
    } else if (this.engineMode === 'dsp') {
      await this.audioEngine.resumeEngine();
      this.updateStreamTelemetry();
    }
  }

  /**
   * Builds and applies live audio Signal Path telemetry to both the dock pill and Signal Path modal.
   */
  getSignalPathDescriptor() {
    const activeTrack = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex] || null;
    this.getEffectiveReplayGain();
    return buildSignalPathDescriptor({
      engineMode: this.engineMode,
      outputBackend: this.outputBackend,
      isVideo: Boolean(activeTrack?.isVideo),
      filePath: activeTrack?.filePath || '',
      sacdArea: Number(activeTrack?.sacdArea) || 0,
      sacdTrack: Number(activeTrack?.sacdTrack) || 0,
      trackTitle: activeTrack?.title || '',
      probe: this.activeTrackProbe,
      r128: this.activeTrackR128,
      replayGainInfo: this.lastReplayGainInfo,
      wasapiEvent: this.lastWasapiReadyEvent,
      caps: this.deviceCaps,
      ratePlan: this.lastWasapiRatePlan,
      dspState: this.audioEngine.state,
      convolverActive: Boolean(this.audioEngine.state.convolverEnabled && this.audioEngine.state.convolverPath),
      liveTelemetry: this.lastLiveAudioTelemetry,
      deviceName: this.lastWasapiReadyEvent?.deviceName || (this.outputBackend === 'asio' ? this.asioDriver : this.selectedDeviceName) || '',
      linearGain: this.engineMode === 'wasapi' ? this.getEffectiveWasapiGain() : this.getEffectiveReplayGain(),
      volumeMode: this.audioEngine?.state?.volumeMode || 'auto',
      pushMode: this.wasapiPushMode,
      preRollMs: this.clockSwitchPreRollMs,
      xrunCount: this.wasapiXrunCount,
      gaplessQueued: Boolean(this._wasapiGaplessTarget),
      gaplessCrossFormat: Boolean(this._wasapiGaplessTarget?.crossFormat)
    });
  }

  updateStreamTelemetry() {
    const el = document.getElementById('dockStreamTelemetry');
    if (!el) return;
    const activeTrack = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex];
    const desc = this.getSignalPathDescriptor();
    const parts = [desc.summaryLabel];

    if (this.activeTrackProbe) {
      const srKhz = `${(this.activeTrackProbe.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz`;
      const bits = this.activeTrackProbe.bitDepth ? `${this.activeTrackProbe.bitDepth}bit` : '16bit';
      const ch = Number(this.activeTrackProbe.channels) || 2;
      const chTag = ch > 2 ? (ch === 6 ? ' 5.1' : ch === 8 ? ' 7.1' : ` ${ch}ch`) : '';
      parts.push(`${this.activeTrackProbe.codec} ${srKhz}/${bits}${chTag}`);
    }
    if (this.audioEngine.state.lufs && this.audioEngine.state.replayGainMode !== 'off') {
      const targetLufs = Number(this.audioEngine.state.replayGainTargetLufs) === -14 ? -14 : -18;
      if (this.lastReplayGainInfo && this.lastReplayGainInfo.source !== 'unmeasured') {
        const db = Number(this.lastReplayGainInfo.appliedDb) || 0;
        const m = this.lastReplayGainInfo.source.includes('album') ? 'Album' : 'Track';
        parts.push(`RG2 ${m} ${db >= 0 ? '+' : ''}${db.toFixed(1)}dB @${targetLufs}`);
      } else if (this.activeTrackR128?.integratedLufs !== undefined) {
        parts.push(`R128 ${this.activeTrackR128.integratedLufs.toFixed(1)} LUFS`);
      }
    }

    el.classList.remove('tone-bit-exact', 'tone-purepath', 'tone-dop', 'tone-shared');
    if (this.engineMode === 'wasapi' && !activeTrack?.isVideo) {
      if (desc.qualityTone === 'bit_exact') el.classList.add('tone-bit-exact');
      else if (desc.qualityTone === 'purepath') el.classList.add('tone-purepath');
      else if (desc.qualityTone === 'dop') el.classList.add('tone-dop');
      else if (desc.qualityTone === 'shared') el.classList.add('tone-shared');
    }

    const icon = desc.qualityTone === 'bit_exact'
      ? '◆'
      : desc.qualityTone === 'purepath'
        ? '◈'
        : desc.qualityTone === 'dop'
          ? '⚡'
          : desc.qualityTone === 'shared'
            ? '⚠'
            : '🎛️';
    el.textContent = `${icon} ${parts.join(' · ')} ▾`;

    const modal = document.getElementById('signalPathModal');
    if (modal && !modal.classList.contains('hidden')) {
      this.renderSignalPathModal(desc);
    }
  }

  /**
   * Updates only the high-frequency Bit-Audit, True-Peak dBTP, Crest/DR, and XRUN badges cleanly.
   * @param {object} desc - Signal Path descriptor returned by getSignalPathDescriptor().
   */
  _renderSignalPathAuditBadges(desc) {
    const xrunPill = document.getElementById('signalPathXrunBadge');
    if (xrunPill) {
      const xruns = Math.max(0, Number(desc?.xrunCount ?? this.wasapiXrunCount ?? 0) || 0);
      xrunPill.textContent = `XRUNs: ${xruns}`;
      xrunPill.classList.toggle('warn', xruns > 0);
    }
    const audit = desc?.bitAudit;
    if (!audit) return;

    const bitAuditPill = document.getElementById('signalPathBitAuditBadge');
    if (bitAuditPill) {
      bitAuditPill.textContent = audit.bitAuditText;
      bitAuditPill.className = `signal-path-audit-pill${audit.bitAuditTone ? ` tone-${audit.bitAuditTone}` : ''}`;
    }
    const tpPill = document.getElementById('signalPathTruePeakBadge');
    if (tpPill) {
      const tpVal = Number(this.lastLiveAudioTelemetry?.truePeakDbtp);
      tpPill.textContent = `True Peak: ${audit.truePeakText}`;
      tpPill.className = `signal-path-audit-pill${Number.isFinite(tpVal) && tpVal > -0.3 ? ' tone-warn' : ''}`;
    }
    const drPill = document.getElementById('signalPathDrBadge');
    if (drPill) {
      drPill.textContent = audit.crestDrText;
    }
  }

  /**
   * Renders the Live Signal Path Inspector chain cleanly via createElement (zero innerHTML).
   * @param {object|null} [precomputed=null] - Optional precomputed descriptor.
   */
  renderSignalPathModal(precomputed = null) {
    const desc = precomputed || this.getSignalPathDescriptor();
    const led = document.getElementById('signalPathLed');
    const badge = document.getElementById('signalPathQualityBadge');
    const list = document.getElementById('signalPathStagesList');
    if (!list) return;

    const toneClass = `tone-${desc.qualityTone}`;
    if (led) led.className = `signal-path-led ${toneClass}`;
    if (badge) {
      badge.className = `signal-path-quality-badge ${toneClass}`;
      badge.textContent = desc.qualityBadge;
    }
    this._renderSignalPathAuditBadges(desc);

    const statusGlyph = {
      bit_exact: '◆',
      purepath: '◈',
      dop: '⚡',
      enhanced: '●',
      dsp: '●'
    };

    const rows = desc.stages.map((st) => {
      const row = document.createElement('div');
      row.className = 'signal-stage-row';

      const node = document.createElement('div');
      node.className = `signal-stage-node status-${st.status}`;
      node.textContent = statusGlyph[st.status] || '●';

      const body = document.createElement('div');
      body.className = 'signal-stage-body';

      const top = document.createElement('div');
      top.className = 'signal-stage-top';

      const titleEl = document.createElement('span');
      titleEl.className = 'signal-stage-title';
      titleEl.textContent = st.title;

      const specEl = document.createElement('span');
      specEl.className = 'signal-stage-spec';
      specEl.textContent = st.spec;

      const detailEl = document.createElement('div');
      detailEl.className = 'signal-stage-detail';
      detailEl.textContent = st.detail;

      top.appendChild(titleEl);
      top.appendChild(specEl);
      body.appendChild(top);
      body.appendChild(detailEl);
      row.appendChild(node);
      row.appendChild(body);
      return row;
    });

    list.replaceChildren(...rows);
  }

  _bindSignalPathModal() {
    const modal = document.getElementById('signalPathModal');
    const trigger = document.getElementById('dockStreamTelemetry');
    const closeBtn = document.getElementById('btnCloseSignalPath');
    if (!modal || !trigger) return;

    const closeModal = () => modal.classList.add('hidden');
    trigger.addEventListener('click', () => {
      this.renderSignalPathModal();
      modal.classList.remove('hidden');
    });
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });
  }

  /**
   * Updates timeline progress bar, wave playhead, and mm:ss labels safely.
   * @param {number} positionSec - Current position in seconds.
   * @param {number} durationSec - Total track duration in seconds.
   */
  updateTimelineUi(positionSec, durationSec) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) return;
    const safePos = Math.max(0, Number(positionSec) || 0);
    this._lastTimelinePosSec = safePos;
    const totalSec = Math.max(durationSec, safePos);
    const ratio = Math.max(0, Math.min(1, safePos / totalSec));
    this.visualizer.setProgress(ratio);
    const pctStr = `${(ratio * 100).toFixed(2)}%`;
    const fillEl = document.getElementById('masterTimelineFill');
    const thumbEl = document.getElementById('masterTimelineThumb');
    if (fillEl) fillEl.style.width = pctStr;
    if (thumbEl) thumbEl.style.left = `clamp(6px, ${pctStr}, calc(100% - 6px))`;
    const totalWhole = Math.max(0, Math.floor(totalSec));
    const cur = ratio >= 0.9999 ? totalWhole : Math.max(0, Math.min(totalWhole, Math.floor(safePos)));
    const rem = Math.max(0, totalWhole - cur);
    const elEl = document.getElementById('timeElapsedLabel');
    const remEl = document.getElementById('timeRemainingLabel');
    if (elEl) elEl.textContent = `${String(Math.floor(cur / 60)).padStart(2, '0')}:${String(cur % 60).padStart(2, '0')}`;
    if (remEl) remEl.textContent = `-${String(Math.floor(rem / 60)).padStart(2, '0')}:${String(rem % 60).padStart(2, '0')}`;
    this.scoreStudio?.syncPlayhead(safePos);
  }

  /**
   * Synchronizes the topbar Studio DSP / WASAPI Exclusive buttons with the active track type.
   * Locks WASAPI Exclusive while a video track is active so A/V sync always stays on Studio DSP.
   * @param {object|null} [track] - Track currently loaded or selected.
   */
  _syncEngineModeUi(track = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex]) {
    const isVideo = Boolean(track?.isVideo);
    const effectiveMode = isVideo ? 'dsp' : this.engineMode;
    document.querySelectorAll('[data-engine]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.engine === effectiveMode);
      if (btn.dataset.engine === 'wasapi') {
        btn.disabled = isVideo;
        btn.setAttribute('aria-disabled', String(isVideo));
        btn.title = isVideo
          ? 'Audio tracks only — Videos use Studio DSP for GPU A/V sync'
          : 'Bit-Perfect Direct DAC Access (exclusively locks audio device while playing; auto-releases on Pause)';
      }
    });
  }

  /**
   * Switches between Native WASAPI Exclusive and Dual-Deck Studio DSP engines seamlessly.
   * @param {'wasapi' | 'dsp'} mode - Target audio engine mode.
   * @param {boolean} [silent] - Suppress redundant toast if triggered by DSP interaction.
   */
  async setEngineMode(mode, silent = false) {
    const targetMode = mode === 'dsp' ? 'dsp' : 'wasapi';
    const track = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex];
    const isVideoTrack = Boolean(track?.isVideo);
    if (targetMode === 'wasapi' && isVideoTrack) {
      this._syncEngineModeUi(track);
      if (!silent) {
        this.setToast('WASAPI Exclusive is for Audio tracks only — Videos play via Direct GPU + Studio DSP');
      }
      return;
    }

    this.preferredAudioEngineMode = targetMode;
    this._saveAudioPrefs();
    if (this.engineMode === targetMode) {
      this._syncEngineModeUi(track);
      return;
    }
    const wasPlaying = this.isPlaying;
    const resumeSec = isVideoTrack
      ? (this._videoSeekOffsetSec + (this.videoEl?.currentTime || 0))
      : (targetMode === 'dsp'
        ? this.wasapiCurrentPositionSec
        : (this.studioSeekOffsetSec + (this.audioEngine.getActiveDeckElement()?.currentTime || 0)));

    this.engineMode = targetMode;
    this.wasapiPausedTrackKey = null;
    this.wasapiPausedHeld = false;
    this.wasapiResumeSec = 0;
    this._syncEngineModeUi(track);

    if (targetMode === 'dsp') {
      this.wasapiStatusMode = 'STUDIO DSP';
      this.audioEngine.setExternalSpectrum(null);
      window.vantaAPI?.logClientEvent('INFO', '[EngineSwitch] Switching to Studio DSP (stopping WASAPI)', { wasPlaying, resumeSec });
      if (window.vantaAPI) await window.vantaAPI.wasapiCmd('STOP').catch(() => {});
      window.vantaAPI?.logClientEvent('INFO', '[EngineSwitch] WASAPI STOP completed, resuming AudioContext');
      const ok = await this.audioEngine.resumeEngine();
      window.vantaAPI?.logClientEvent('INFO', '[EngineSwitch] resumeEngine finished', { ok, ctxState: this.audioEngine.ctx?.state });
      this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
      this.updateStreamTelemetry();
      if (wasPlaying && track?.filePath) {
        await this.startPlayback(resumeSec);
      } else if (track?.filePath && resumeSec > 0.5) {
        this._pendingStudioSeekSec = resumeSec;
      }
      window.vantaAPI?.logClientEvent('INFO', '[EngineSwitch] Studio DSP switch completed');
    } else {
      this.wasapiStatusMode = 'WASAPI EXCLUSIVE READY';
      this.audioEl.pause();
      this.deckBEl?.pause();
      await this.audioEngine.suspendEngine();
      if (wasPlaying && track?.filePath && !track.isVideo) {
        await this.startPlayback(resumeSec);
      } else if (track?.filePath && !track.isVideo && resumeSec > 0.5) {
        this.wasapiPausedTrackKey = this._getTrackUniqueKey(track);
        this.wasapiResumeSec = resumeSec;
        this.wasapiCurrentPositionSec = resumeSec;
      }
    }

    this.updateStreamTelemetry();
    if (!silent) {
      this.setToast(
        targetMode === 'wasapi'
          ? 'Audio Engine: Native WASAPI Exclusive (Bit-Perfect DAC · Auto-releases device on Pause)'
          : 'Audio Engine: Studio DSP (32-Bit Float EQ, Spatial & Dual-Deck Crossfade)'
      );
    }
  }

  /**
   * Handles native WASAPI C++ engine telemetry events (ready, spectrum, ended, error).
   * @param {object} evt - Parsed telemetry packet from Main Process.
   */
  _getNextTrackForWasapiGapless() {
    if (this.repeatMode === 'one' || (Number(this.audioEngine?.state?.crossfadeSeconds) || 0) > 0) {
      return null;
    }
    if (!this.displayedTracks.length) return null;
    let nextIdx = -1;
    if (this.activeTrackIndex + 1 < this.displayedTracks.length) {
      nextIdx = this.activeTrackIndex + 1;
    } else if (this.repeatMode === 'queue') {
      nextIdx = 0;
    }
    if (nextIdx < 0) return null;
    const nextTrack = this.displayedTracks[nextIdx];
    if (!nextTrack?.filePath || nextTrack.isVideo) return null;
    return { index: nextIdx, track: nextTrack };
  }

  _maybeQueueGaplessWasapiNext(positionSec, totalSec) {
    if (!window.vantaAPI?.wasapiQueueNext || this.engineMode !== 'wasapi' || !this.isPlaying) return;
    if (!Number.isFinite(totalSec) || totalSec <= 8.0) return;
    const remaining = totalSec - positionSec;
    if (remaining > 6.5 || remaining <= 0.15) return;

    const currentTrack = this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex];
    const currentKey = this._getTrackUniqueKey(currentTrack);
    const nextInfo = this._getNextTrackForWasapiGapless();
    if (!currentKey || !nextInfo) return;
    if (Number(currentTrack?.sacdTrack) >= 1 || Number(nextInfo.track?.sacdTrack) >= 1) return;

    const pairKey = `${currentKey}==>${this._getTrackUniqueKey(nextInfo.track)}`;
    if (this._wasapiGaplessQueuedKey === pairKey) return;
    this._wasapiGaplessQueuedKey = pairKey;

    const seq = (this._gaplessSeqCounter = (this._gaplessSeqCounter || 0) + 1);
    window.vantaAPI
      .wasapiQueueNext({
        filePath: nextInfo.track.filePath,
        dop: Boolean(this.dopEnabled),
        deviceId: this.selectedDeviceId || '',
        backend: this.outputBackend === 'asio' ? 'asio' : 'wasapi',
        asioDriver: this.asioDriver || '',
        asioRawDsd: Boolean(this.asioRawDsd),
        sacdTrack: Number(nextInfo.track.sacdTrack) || 0,
        exclusive: true,
        pushMode: Boolean(this.wasapiPushMode),
        bufferMs: Number(this.wasapiBufferMs) || 0,
        preRollMs: Number(this.clockSwitchPreRollMs) || 0,
        fixedRateLock: Boolean(this.fixedRateLock),
        fixedTargetRate: Number(this.fixedTargetRate) || 0,
        linearGain: this.getEffectiveWasapiGain(),
        seq
      })
      .then((res) => {
        if (res?.ok && res.queued) {
          this._wasapiGaplessTarget = {
            seq,
            index: nextInfo.index,
            track: nextInfo.track,
            probe: res.probe || null,
            r128: res.r128 || null,
            crossFormat: Boolean(res.crossFormat),
            ratePlan: res.ratePlan || null
          };
          this.updateStreamTelemetry();
        } else {
          this._wasapiGaplessTarget = null;
        }
      })
      .catch(() => {
        this._wasapiGaplessTarget = null;
      });
  }

  _commitGaplessWasapiAdvance(evt) {
    const target = this._wasapiGaplessTarget;
    if (!target || target.seq !== Number(evt.seq)) return false;

    const prevTrack = this.currentLoadedTrack;
    const prevKey = this._getTrackUniqueKey(prevTrack);
    const nextTrack = target.track;
    const resolvedIdx = this.displayedTracks.indexOf(nextTrack);
    const nextIdx = resolvedIdx >= 0 ? resolvedIdx : Math.max(0, Math.min(this.displayedTracks.length - 1, target.index));

    if (prevTrack && prevKey && prevKey !== this._getTrackUniqueKey(nextTrack)) {
      const top = this.playbackHistory[this.playbackHistory.length - 1];
      if (!top || top.key !== prevKey) {
        this.playbackHistory.push({ key: prevKey, title: prevTrack.title, artist: prevTrack.artist || '' });
        if (this.playbackHistory.length > 30) this.playbackHistory.shift();
        this._savePlaybackHistory();
      }
    }

    this._wasapiGaplessTarget = null;
    this._wasapiGaplessQueuedKey = null;
    this.currentLoadedTrack = nextTrack;
    this.activeTrackIndex = nextIdx;
    this._pausedTrackKey = null;
    this.wasapiPausedHeld = false;
    this.wasapiCurrentPositionSec = 0;
    this.activeTrackProbe = target.probe || evt.probe || null;
    this.activeTrackR128 = target.r128 || null;
    if (target.ratePlan || evt.ratePlan) {
      this.lastWasapiRatePlan = evt.ratePlan || target.ratePlan;
    }
    if (evt.caps) this.deviceCaps = evt.caps;
    if (this.lastWasapiReadyEvent) {
      this.lastWasapiReadyEvent = {
        ...this.lastWasapiReadyEvent,
        mode: evt.mode ?? this.lastWasapiReadyEvent.mode,
        dsdRate: evt.dsdRate ?? this.lastWasapiReadyEvent.dsdRate,
        sampleRate: evt.sampleRate ?? this.lastWasapiReadyEvent.sampleRate,
        bitsPerSample: evt.bitsPerSample ?? this.lastWasapiReadyEvent.bitsPerSample,
        validBits: evt.validBits ?? this.lastWasapiReadyEvent.validBits,
        channels: evt.channels ?? this.lastWasapiReadyEvent.channels,
        bufferFrames: evt.bufferFrames ?? this.lastWasapiReadyEvent.bufferFrames,
        inFmt: evt.inFmt ?? this.lastWasapiReadyEvent.inFmt,
        bitExact: evt.bitExact ?? this.lastWasapiReadyEvent.bitExact,
        signalMode: evt.signalMode ?? this.lastWasapiReadyEvent.signalMode
      };
    }

    document.getElementById('dockTrackTitle').textContent = nextTrack.title;
    document.getElementById('dockTrackSubtitle').textContent = `${nextTrack.artist} · ${nextTrack.bpm} BPM · ${nextTrack.key}`;
    const artBox = document.getElementById('dockArtworkBox');
    const miniThumb = document.getElementById('footerMiniThumb');
    const coverSrc = this._getTrackCoverSrc(nextTrack);
    if (coverSrc && artBox && miniThumb) {
      artBox.style.backgroundImage = `url("${coverSrc}")`;
      artBox.textContent = '';
      miniThumb.style.backgroundImage = `url("${coverSrc}")`;
      miniThumb.textContent = '';
    } else if (artBox && miniThumb) {
      artBox.style.backgroundImage = '';
      artBox.style.background = nextTrack.grad || 'linear-gradient(135deg, var(--a1), var(--a2), var(--a3))';
      artBox.textContent = '🎧';
      miniThumb.style.backgroundImage = '';
      miniThumb.style.background = nextTrack.grad || 'linear-gradient(135deg, var(--a1), var(--a3))';
      miniThumb.textContent = '🎧';
    }

    this.visualizer.setProgress(0);
    window.vantaAPI?.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
    if (!this.activeTrackR128) {
      void this.probeActiveTrack(nextTrack).catch(() => {});
    }
    this._updateLastPlayedButton();
    this.updateStreamTelemetry();
    this.renderQueue();
    return true;
  }

  handleWasapiEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    if (evt.event === 'ready') {
      this.lastWasapiReadyEvent = evt;
      if (evt.caps) {
        this.deviceCaps = evt.caps;
        if (evt.caps.hwVolumeSupport !== undefined) {
          this.deviceHwVolumeSupport = Number(evt.caps.hwVolumeSupport) || 0;
        }
      }
      if (evt.ratePlan) this.lastWasapiRatePlan = evt.ratePlan;
      if (evt.xrunCount !== undefined) this.wasapiXrunCount = Number(evt.xrunCount) || 0;
      const rateKhz = evt.sampleRate ? `${(evt.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz` : 'Native';
      if (evt.mode === 'asio_dsd_raw') {
        this.wasapiStatusMode = `ASIO RAW DSD (${evt.dsdRate || 'DSD'} @ ${rateKhz})`;
      } else if (evt.mode === 'asio') {
        this.wasapiStatusMode = evt.bitExact
          ? `BIT-EXACT ASIO (${rateKhz})`
          : `PUREPATH 64 ASIO (${rateKhz})`;
      } else if (evt.mode === 'dop_exclusive') {
        this.wasapiStatusMode = `NATIVE DoP v1.1 (${evt.dsdRate || 'DSD'} @ ${rateKhz})`;
      } else if (evt.mode === 'exclusive') {
        this.wasapiStatusMode = evt.bitExact
          ? `BIT-EXACT WASAPI (${rateKhz})`
          : `PUREPATH 64 WASAPI (${rateKhz})`;
      } else {
        this.wasapiStatusMode = 'WASAPI SHARED (Auto-Fallback)';
      }
      this._syncAllDspUi();
      this.updateStreamTelemetry();
      return;
    }
    if (evt.event === 'asio_fallback') {
      this.setToast(`ASIO fallback -> WASAPI Exclusive (${evt.reason || evt.message || 'Driver unavailable'})`);
      this.updateStreamTelemetry();
      return;
    }
    if (evt.event === 'dsp_state') {
      if (this.lastWasapiReadyEvent) {
        this.lastWasapiReadyEvent = {
          ...this.lastWasapiReadyEvent,
          bitExact: evt.bitExact,
          eqActive: evt.eqActive,
          peqActive: evt.peqActive ?? this.lastWasapiReadyEvent.peqActive,
          convolverActive: evt.convolverActive ?? this.lastWasapiReadyEvent.convolverActive,
          bass: evt.bass,
          crossfeed: evt.crossfeed,
          limiter: evt.limiter,
          signalMode: evt.signalMode
        };
      }
      const rateKhz = this.lastWasapiReadyEvent?.sampleRate
        ? `${(this.lastWasapiReadyEvent.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz`
        : 'Native';
      if (this.lastWasapiReadyEvent?.mode === 'asio') {
        this.wasapiStatusMode = evt.bitExact ? `BIT-EXACT ASIO (${rateKhz})` : `PUREPATH 64 ASIO (${rateKhz})`;
      } else if (this.lastWasapiReadyEvent?.mode === 'exclusive') {
        this.wasapiStatusMode = evt.bitExact
          ? `BIT-EXACT WASAPI (${rateKhz})`
          : `PUREPATH 64 WASAPI (${rateKhz})`;
      }
      this.updateStreamTelemetry();
      return;
    }
    if (evt.event === 'convolver_state') {
      if (this.lastWasapiReadyEvent) {
        this.lastWasapiReadyEvent = {
          ...this.lastWasapiReadyEvent,
          convolverActive: Boolean(evt.active)
        };
      }
      if (evt.error) {
        this.setToast(`Convolver warning: ${evt.error}`);
      }
      this.updateStreamTelemetry();
      return;
    }
    if (evt.event === 'paused' || evt.event === 'resumed') {
      if (evt.xrunCount !== undefined) this.wasapiXrunCount = Number(evt.xrunCount) || 0;
      const reportedPos = Number.isFinite(Number(evt.positionSec))
        ? Number(evt.positionSec)
        : ((Number(evt.positionMs) || 0) / 1000);
      if (Number.isFinite(reportedPos)) {
        this.wasapiCurrentPositionSec = Math.max(0, reportedPos);
        const totalSec = Number(evt.durationSec) || this._resolveEffectiveDurationSec(this.currentLoadedTrack, null);
        if (totalSec > 0) this.updateTimelineUi(this.wasapiCurrentPositionSec, totalSec);
      }
      this.updateStreamTelemetry();
      return;
    }
    if (evt.event === 'track_advanced') {
      if (!this._commitGaplessWasapiAdvance(evt)) {
        this.updateStreamTelemetry();
      }
      return;
    }
    if (evt.event === 'spectrum') {
      if (evt.xrunCount !== undefined) {
        this.wasapiXrunCount = Number(evt.xrunCount) || 0;
      }
      this.lastLiveAudioTelemetry = evt;
      if (this.engineMode === 'wasapi' && this.isPlaying) {
        if (Array.isArray(evt.bars)) {
          this.audioEngine.setExternalSpectrum(evt.bars, evt);
        }
        this.wasapiCurrentPositionSec = Number(evt.positionSec) || 0;
        const totalSec = Number(evt.durationSec) || this._resolveEffectiveDurationSec(this.currentLoadedTrack, null);
        this.updateTimelineUi(this.wasapiCurrentPositionSec, totalSec);
        this._maybeQueueGaplessWasapiNext(this.wasapiCurrentPositionSec, totalSec);
        const spModal = document.getElementById('signalPathModal');
        if (spModal && !spModal.classList.contains('hidden')) {
          this._renderSignalPathAuditBadges(this.getSignalPathDescriptor());
        }
      }
      return;
    }
    if (evt.event === 'ended') {
      this.audioEngine.setExternalSpectrum(null);
      this.lastLiveAudioTelemetry = null;
      this._wasapiGaplessTarget = null;
      this._wasapiGaplessQueuedKey = null;
      this.wasapiPausedHeld = false;
      if (evt.xrunCount !== undefined) this.wasapiXrunCount = Number(evt.xrunCount) || 0;
      if (this.engineMode === 'wasapi' && this.isPlaying) {
        const finalTotalSec = Number(evt.durationSec) || this._resolveEffectiveDurationSec(this.currentLoadedTrack, null);
        this.wasapiCurrentPositionSec = 0;
        this.wasapiPausedTrackKey = null;
        this.wasapiResumeSec = 0;
        this.handleTrackEnded();
        if (!this.isPlaying) {
          this.wasapiCurrentPositionSec = 0;
          this.wasapiPausedTrackKey = null;
          this.wasapiResumeSec = 0;
          if (finalTotalSec > 0) this.updateTimelineUi(finalTotalSec, finalTotalSec);
        }
      }
      return;
    }
    if (evt.event === 'error') {
      this.audioEngine.setExternalSpectrum(null);
      this.lastLiveAudioTelemetry = null;
      this.wasapiPausedHeld = false;
      if (this.engineMode === 'wasapi' && evt.message) {
        this.setToast(`WASAPI fallback -> Studio DSP (${evt.message})`);
        void this.setEngineMode('dsp', true).catch(() => {});
      }
      return;
    }
    if (evt.event === 'closed') {
      this.audioEngine.setExternalSpectrum(null);
      this.lastLiveAudioTelemetry = null;
      this.wasapiPausedHeld = false;
    }
  }

  /**
   * Probes true codec/sampleRate/bitDepth & EBU R128 loudness for the active track via ffmpeg-static.
   * @param {object} track - Active catalog track.
   */
  async probeActiveTrack(track) {
    if (!track?.filePath || Number(track.sacdTrack) >= 1 || !window.vantaAPI) return;
    const requestedPath = track.filePath;
    try {
      const info = await window.vantaAPI.probeAudio(requestedPath);
      const current = this.displayedTracks[this.activeTrackIndex];
      if (!info || !current || current.filePath !== requestedPath) return;
      this.activeTrackProbe = info.probe || null;
      this.activeTrackR128 = info.r128 || null;
      this.activeTrackTags = info.tags || null;
      const gain = this.getEffectiveReplayGain();
      this.audioEngine.setReplayGainLinear(gain);
      if (this.engineMode === 'wasapi' && this.isPlaying) {
        window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
      }
      if (!current.isVideo && info.probe?.durationSec > 0) {
        const curPos = this.engineMode === 'wasapi'
          ? (this.wasapiCurrentPositionSec || 0)
          : (this._pendingStudioSeekSec !== null && !this.isPlaying
            ? this._pendingStudioSeekSec
            : this.studioSeekOffsetSec + (this.audioEngine.getActiveDeckElement()?.currentTime || 0));
        this.updateTimelineUi(curPos, info.probe.durationSec);
      }
      this.updateStreamTelemetry();
    } catch {
      // Non-fatal probe error
    }
  }

  /**
   * Stops playback, resets player UI, and non-destructively clears the active playlist/queue
   * without deleting any media files from disk.
   */
  async clearEntirePlaylist() {
    const clearedCount = this.catalog.length;
    this.isPlaying = false;
    this.visualizer.isPlaying = false;
    this.visualizer.setProgress(0);
    this.audioEl.pause();
    this.audioEl.removeAttribute('src');
    this.deckBEl?.pause();
    this.deckBEl?.removeAttribute('src');
    this.videoEl.pause();
    this.videoEl.removeAttribute('src');
    this._lastLoadedVideoUrl = '';
    this.audioEngine.stopProceduralSynthPreview();
    this.audioEngine.setExternalSpectrum(null);
    this.setPlayPauseIcon(false);
    document.getElementById('vinylPlatterDisc')?.classList.add('paused');
    document.getElementById('inlineTagEditor')?.classList.add('hidden');
    this.editingTrackKey = null;

    this.currentLoadedTrack = null;
    this.engineMode = this.preferredAudioEngineMode;
    this.wasapiStatusMode = this.engineMode === 'wasapi' ? 'WASAPI EXCLUSIVE READY' : 'STUDIO DSP';
    this._syncEngineModeUi(null);
    this.activeTrackIndex = 0;
    this.activeTrackProbe = null;
    this.activeTrackR128 = null;
    this.wasapiPausedTrackKey = null;
    this.wasapiResumeSec = 0;
    this.wasapiCurrentPositionSec = 0;
    this.studioSeekOffsetSec = 0;
    this._pendingStudioSeekSec = null;
    this.playbackHistory = [];
    this._savePlaybackHistory();
    this._updateLastPlayedButton();
    this._renderTrackLyrics('');

    const dockTitle = document.getElementById('dockTrackTitle');
    const dockSub = document.getElementById('dockTrackSubtitle');
    const artBox = document.getElementById('dockArtworkBox');
    const miniThumb = document.getElementById('footerMiniThumb');
    if (dockTitle) dockTitle.textContent = 'No Track Loaded';
    if (dockSub) dockSub.textContent = 'Select a folder or download from YouTube';
    if (artBox) {
      artBox.style.backgroundImage = '';
      artBox.style.background = 'linear-gradient(135deg, var(--a1), var(--a2), var(--a3))';
      artBox.textContent = '🎧';
    }
    if (miniThumb) {
      miniThumb.style.backgroundImage = '';
      miniThumb.style.background = 'linear-gradient(135deg, var(--a1), var(--a3))';
      miniThumb.textContent = '🎧';
    }
    const fillEl = document.getElementById('masterTimelineFill');
    const thumbEl = document.getElementById('masterTimelineThumb');
    if (fillEl) fillEl.style.width = '0%';
    if (thumbEl) thumbEl.style.left = 'clamp(6px, 0%, calc(100% - 6px))';
    const elEl = document.getElementById('timeElapsedLabel');
    const remEl = document.getElementById('timeRemainingLabel');
    if (elEl) elEl.textContent = '00:00';
    if (remEl) remEl.textContent = '-00:00';

    this.sacdVirtualTracks = [];
    const filePaths = this.catalog.filter((t) => !t.sacdTrack).map((t) => t.filePath).filter(Boolean);
    this.wasapiStatusMode = this.engineMode === 'wasapi' ? 'WASAPI EXCLUSIVE READY' : 'STUDIO DSP';
    this.updateStreamTelemetry();

    if (window.vantaAPI) {
      const res = await window.vantaAPI.clearPlaylist({ filePaths });
      this.mergeVaultCatalog(res?.catalog || [], res?.doctor || { issues: [], healthScore: 100 });
    } else {
      this.mergeVaultCatalog([], { issues: [], healthScore: 100 });
    }
    this.setToast(`Cleared ${clearedCount} tracks from playlist (files kept safe on disk)`);
  }

  /**
   * Renders the full-width track list with clickable 5-star ratings, custom tags, groups, and playback selection.
   */
  /**
   * Renders the Rekordbox 7 style multi-column track table (Header + Sortable/Resizable/Inline-Editable Rows).
   */
  _loadRbColumnsState() {
    const allIds = REKORDBOX_COLUMNS.map((c) => c.id);
    const defaultIds = REKORDBOX_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);
    const defaultWidths = Object.fromEntries(REKORDBOX_COLUMNS.map((c) => [c.id, c.width]));
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem('vanta_rb_columns_v2') || 'null');
      if (saved && Array.isArray(saved.visibleIds)) {
        const validSet = new Set(allIds);
        const visibleIds = saved.visibleIds.filter((id) => validSet.has(id));
        if (!visibleIds.includes('num')) visibleIds.unshift('num');
        if (!visibleIds.includes('title')) visibleIds.splice(1, 0, 'title');

        let orderIds = Array.isArray(saved.orderIds)
          ? saved.orderIds.filter((id) => validSet.has(id))
          : [...allIds];
        for (const id of allIds) {
          if (!orderIds.includes(id)) orderIds.push(id);
        }
        orderIds = ['num', ...orderIds.filter((id) => id !== 'num')];

        return {
          visibleIds,
          orderIds,
          widths: { ...defaultWidths, ...(saved.widths || {}) },
          resizedIds: Array.isArray(saved.resizedIds) ? saved.resizedIds : []
        };
      }
    } catch {
      // Ignore malformed column settings
    }
    return { visibleIds: defaultIds, orderIds: allIds, widths: defaultWidths, resizedIds: [] };
  }

  _saveRbColumnsState() {
    try {
      globalThis.localStorage?.setItem('vanta_rb_columns_v2', JSON.stringify(this.rbColumnsState));
    } catch {
      // Ignore storage failures
    }
  }

  _getVisibleRbColumns() {
    const vis = new Set(this.rbColumnsState.visibleIds || []);
    const byId = new Map(REKORDBOX_COLUMNS.map((c) => [c.id, c]));
    const order = Array.isArray(this.rbColumnsState.orderIds)
      ? this.rbColumnsState.orderIds
      : REKORDBOX_COLUMNS.map((c) => c.id);
    return order
      .map((id) => byId.get(id))
      .filter((col) => col && (col.locked || vis.has(col.id)));
  }

  _moveRbColumn(draggedId, targetId, insertAfter = false) {
    if (!draggedId || !targetId || draggedId === targetId || draggedId === 'num' || targetId === 'num') return;
    const base = Array.isArray(this.rbColumnsState.orderIds)
      ? [...this.rbColumnsState.orderIds]
      : REKORDBOX_COLUMNS.map((c) => c.id);
    const cleaned = base.filter((id) => id !== draggedId);
    const targetIdx = cleaned.indexOf(targetId);
    if (targetIdx < 0) return;
    const insertIdx = Math.max(1, insertAfter ? targetIdx + 1 : targetIdx);
    cleaned.splice(insertIdx, 0, draggedId);
    this.rbColumnsState.orderIds = ['num', ...cleaned.filter((id) => id !== 'num')];
    this._saveRbColumnsState();
    this.renderQueue();
  }

  _applyRbGridTemplate() {
    const viewport = document.getElementById('rbTableViewport');
    if (!viewport) return;
    const cols = this._getVisibleRbColumns();
    const widths = cols.map((c) => Math.max(c.minWidth, Number(this.rbColumnsState.widths[c.id]) || c.width));
    const sumW = widths.reduce((a, b) => a + b, 0);
    const viewW = viewport.clientWidth || 0;
    const resizedSet = new Set(this.rbColumnsState.resizedIds || []);
    if (viewW > sumW + 6 && !resizedSet.has('title')) {
      const titleIdx = cols.findIndex((c) => c.id === 'title');
      if (titleIdx >= 0) {
        widths[titleIdx] += (viewW - sumW - 6);
      }
    }
    const template = widths.map((w) => `${w}px`).join(' ');
    viewport.style.setProperty('--rb-grid-cols', template);
  }

  _renderRbTableHeader() {
    const headerEl = document.getElementById('rbTableHeader');
    if (!headerEl) return;
    this._applyRbGridTemplate();
    headerEl.replaceChildren();

    const cols = this._getVisibleRbColumns();
    const activeSort = this.filterState?.sortBy || 'default';

    cols.forEach((col) => {
      const th = document.createElement('div');
      th.className = 'rb-th';
      th.dataset.colId = col.id;
      const isAsc = col.sortAsc && activeSort === col.sortAsc;
      const isDesc = col.sortDesc && activeSort === col.sortDesc;
      if (isAsc || isDesc) th.classList.add('sorted');

      const lbl = document.createElement('span');
      lbl.className = 'rb-th-label';
      lbl.textContent = col.label;
      th.appendChild(lbl);

      if (isAsc || isDesc) {
        const arrow = document.createElement('span');
        arrow.className = 'rb-th-sort';
        arrow.textContent = isAsc ? '▲' : '▼';
        th.appendChild(arrow);
      }

      if (col.sortAsc || col.sortDesc) {
        th.title = `Click to sort · Drag to reorder · Right-click for columns`;
        th.addEventListener('click', (e) => {
          if (e.target?.classList?.contains('rb-col-resizer')) return;
          let nextSort = col.sortAsc || col.sortDesc;
          if (activeSort === col.sortAsc && col.sortDesc) nextSort = col.sortDesc;
          else if (activeSort === col.sortDesc) nextSort = 'default';
          this.filterState.sortBy = nextSort;
          const sortSel = document.getElementById('listSortSelect');
          if (sortSel) {
            const hasOpt = Array.from(sortSel.options).some((o) => o.value === nextSort);
            sortSel.value = hasOpt ? nextSort : 'default';
          }
          this.applyFiltersAndRender(false);
        });
      } else {
        th.title = col.id === 'num' ? 'Right-click to show/hide columns' : 'Drag to reorder · Right-click for columns';
      }

      if (col.id !== 'num') {
        th.draggable = true;
        th.addEventListener('dragstart', (e) => {
          if (e.target?.classList?.contains('rb-col-resizer')) {
            e.preventDefault();
            return;
          }
          this._draggingColId = col.id;
          th.classList.add('dragging-col');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', col.id);
          }
        });
        th.addEventListener('dragover', (e) => {
          if (!this._draggingColId || this._draggingColId === col.id) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          const rect = th.getBoundingClientRect();
          const after = e.clientX > rect.left + rect.width / 2;
          th.classList.toggle('drop-after', after);
          th.classList.toggle('drop-before', !after);
        });
        th.addEventListener('dragleave', () => {
          th.classList.remove('drop-before', 'drop-after');
        });
        th.addEventListener('drop', (e) => {
          e.preventDefault();
          const draggedId = this._draggingColId || e.dataTransfer?.getData('text/plain');
          const rect = th.getBoundingClientRect();
          const after = e.clientX > rect.left + rect.width / 2;
          th.classList.remove('drop-before', 'drop-after');
          this._draggingColId = null;
          if (draggedId && draggedId !== col.id) {
            this._moveRbColumn(draggedId, col.id, after);
            const movedCol = REKORDBOX_COLUMNS.find((c) => c.id === draggedId);
            if (movedCol) this.setToast(`Column moved: ${movedCol.label}`);
          }
        });
        th.addEventListener('dragend', () => {
          this._draggingColId = null;
          headerEl.querySelectorAll('.rb-th').forEach((el) => el.classList.remove('dragging-col', 'drop-before', 'drop-after'));
        });
      }

      th.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._openRbColumnMenu(e.clientX, e.clientY);
      });

      const resizer = document.createElement('div');
      resizer.className = 'rb-col-resizer';
      resizer.title = `Drag to resize ${col.label}`;
      resizer.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        th.draggable = false;
        const startX = e.clientX;
        const startW = th.getBoundingClientRect().width || col.width;
        resizer.classList.add('resizing');
        const resizedSet = new Set(this.rbColumnsState.resizedIds || []);
        resizedSet.add(col.id);
        this.rbColumnsState.resizedIds = Array.from(resizedSet);

        const onMove = (mv) => {
          const nextW = Math.max(col.minWidth, Math.min(540, Math.round(startW + (mv.clientX - startX))));
          this.rbColumnsState.widths[col.id] = nextW;
          this._applyRbGridTemplate();
        };
        const onUp = () => {
          resizer.classList.remove('resizing');
          th.draggable = col.id !== 'num';
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          this._saveRbColumnsState();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      th.appendChild(resizer);

      headerEl.appendChild(th);
    });
  }

  _openRbColumnMenu(clientX, clientY) {
    const menu = document.getElementById('rbColumnMenu');
    if (!menu) return;
    menu.replaceChildren();

    const titleEl = document.createElement('div');
    titleEl.className = 'rb-col-menu-title';
    titleEl.textContent = 'Table Columns';
    menu.appendChild(titleEl);

    const visibleSet = new Set(this.rbColumnsState.visibleIds || []);
    for (const col of REKORDBOX_COLUMNS) {
      if (col.locked) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'rb-col-menu-item';
      const checked = visibleSet.has(col.id);

      const nameSpan = document.createElement('span');
      nameSpan.textContent = col.label;
      const tick = document.createElement('span');
      tick.textContent = checked ? '✓' : '';
      tick.style.color = 'var(--a2)';

      item.appendChild(nameSpan);
      item.appendChild(tick);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (visibleSet.has(col.id)) visibleSet.delete(col.id);
        else visibleSet.add(col.id);
        this.rbColumnsState.visibleIds = ['num', 'title', ...Array.from(visibleSet).filter((x) => x !== 'num' && x !== 'title')];
        this._saveRbColumnsState();
        this.renderQueue();
        this._openRbColumnMenu(clientX, clientY);
      });
      menu.appendChild(item);
    }

    const sep = document.createElement('div');
    sep.className = 'rb-col-menu-sep';
    menu.appendChild(sep);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'rb-col-menu-item';
    resetBtn.textContent = '↺ Reset Default Columns';
    resetBtn.addEventListener('click', () => {
      try {
        globalThis.localStorage?.removeItem('vanta_rb_columns_v2');
      } catch {
        // Ignore
      }
      this.rbColumnsState = this._loadRbColumnsState();
      menu.classList.add('hidden');
      this.renderQueue();
      this.setToast('Table columns reset to Rekordbox 7 default layout');
    });
    menu.appendChild(resetBtn);

    menu.classList.remove('hidden');
    const maxLeft = Math.max(8, window.innerWidth - 215);
    const maxTop = Math.max(8, window.innerHeight - 360);
    menu.style.left = `${Math.min(clientX, maxLeft)}px`;
    menu.style.top = `${Math.min(clientY, maxTop)}px`;
  }

  _closeRbGenrePopover() {
    document.getElementById('rbGenrePopover')?.classList.add('hidden');
  }

  async _commitTrackFieldUpdate(track, field, nextVal) {
    track[field] = nextVal;
    const res = await this.persistTrackAnnotation(track, { [field]: nextVal }, true);
    if (field === 'title' && this.displayedTracks[this.activeTrackIndex] === track) {
      const dockTitle = document.getElementById('dockTrackTitle');
      if (dockTitle) dockTitle.textContent = nextVal || track.fileName;
    }
    this.applyFiltersAndRender(false);
    if (res?.fileWriteWarning) {
      this.setToast(`Saved "${track.title}" to library DB (file locked: ${res.fileWriteWarning})`);
    } else if (res?.fileUpdated) {
      this.setToast(`Updated ${field.toUpperCase()} → "${nextVal || '—'}" (DB + File Tags synced)`);
    } else {
      this.setToast(`Updated ${field.toUpperCase()} → "${nextVal || '—'}" (Saved by Audio Hash)`);
    }
  }

  _openRbGenrePopover(cellEl, track) {
    const popover = document.getElementById('rbGenrePopover');
    if (!popover || !cellEl || !track) return;
    popover.replaceChildren();

    const currentGenre = String(track.genre || '').trim();
    const detectedMain = resolveMainGenre(currentGenre);
    let selectedMain = detectedMain || GENRE_TAXONOMY[4].main; // Default highlight: Electronic or matching main category

    const searchBar = document.createElement('div');
    searchBar.className = 'rb-genre-search-bar';

    const searchInput = document.createElement('input');
    searchInput.id = 'rbGenreSearchInput';
    searchInput.type = 'text';
    searchInput.className = 'rb-genre-search-input';
    searchInput.placeholder = 'Search genre / subgenre or type custom (Enter)...';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-ghost rb-genre-clear-btn';
    clearBtn.textContent = '✕ Clear';
    clearBtn.title = 'Clear Genre (—)';
    clearBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this._closeRbGenrePopover();
      await this._commitTrackFieldUpdate(track, 'genre', '');
    });

    searchBar.appendChild(searchInput);
    searchBar.appendChild(clearBtn);
    popover.appendChild(searchBar);

    const dualBody = document.createElement('div');
    dualBody.className = 'rb-genre-dual-body';
    const mainList = document.createElement('div');
    mainList.className = 'rb-genre-main-list';
    const subPane = document.createElement('div');
    subPane.className = 'rb-genre-sub-pane';
    dualBody.appendChild(mainList);
    dualBody.appendChild(subPane);

    const searchResultsEl = document.createElement('div');
    searchResultsEl.className = 'rb-genre-search-results hidden';

    popover.appendChild(dualBody);
    popover.appendChild(searchResultsEl);

    const chooseGenre = async (val) => {
      this._closeRbGenrePopover();
      await this._commitTrackFieldUpdate(track, 'genre', String(val || '').trim());
    };

    const renderDualPanels = () => {
      mainList.replaceChildren();
      subPane.replaceChildren();

      for (const cat of GENRE_TAXONOMY) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `rb-genre-main-item${cat.main === selectedMain ? ' active' : ''}`;
        const left = document.createElement('span');
        left.textContent = `${cat.icon} ${cat.main}`;
        const arrow = document.createElement('span');
        arrow.textContent = '›';
        btn.appendChild(left);
        btn.appendChild(arrow);
        btn.addEventListener('mouseenter', () => {
          if (selectedMain !== cat.main) {
            selectedMain = cat.main;
            renderDualPanels();
          }
        });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectedMain = cat.main;
          renderDualPanels();
        });
        btn.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          void chooseGenre(cat.main).catch(() => {});
        });
        mainList.appendChild(btn);
      }

      const activeCat = GENRE_TAXONOMY.find((c) => c.main === selectedMain) || GENRE_TAXONOMY[0];
      const subHdr = document.createElement('div');
      subHdr.className = 'rb-genre-sub-hdr';
      const hdrLbl = document.createElement('span');
      hdrLbl.textContent = `${activeCat.icon} ${activeCat.main}`;
      const setMainBtn = document.createElement('button');
      setMainBtn.type = 'button';
      setMainBtn.className = 'btn btn-ghost';
      setMainBtn.style.cssText = 'padding: 2px 8px; font-size: 10.5px;';
      setMainBtn.textContent = `Use "${activeCat.main}"`;
      setMainBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void chooseGenre(activeCat.main).catch(() => {});
      });
      subHdr.appendChild(hdrLbl);
      subHdr.appendChild(setMainBtn);
      subPane.appendChild(subHdr);

      const subGrid = document.createElement('div');
      subGrid.className = 'rb-genre-sub-grid';
      for (const sub of activeCat.subs) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `rb-genre-sub-chip${sub.toLowerCase() === currentGenre.toLowerCase() ? ' selected' : ''}`;
        chip.textContent = sub;
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          void chooseGenre(sub).catch(() => {});
        });
        subGrid.appendChild(chip);
      }
      subPane.appendChild(subGrid);
    };

    const renderSearchResults = (query) => {
      const q = query.trim().toLowerCase();
      if (!q) {
        searchResultsEl.classList.add('hidden');
        dualBody.classList.remove('hidden');
        renderDualPanels();
        return;
      }
      dualBody.classList.add('hidden');
      searchResultsEl.classList.remove('hidden');
      searchResultsEl.replaceChildren();

      const matches = [];
      for (const cat of GENRE_TAXONOMY) {
        if (cat.main.toLowerCase().includes(q)) {
          matches.push({ label: cat.main, parent: 'Main Genre' });
        }
        for (const sub of cat.subs) {
          if (sub.toLowerCase().includes(q)) {
            matches.push({ label: sub, parent: cat.main });
          }
        }
      }

      for (const m of matches.slice(0, 24)) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'rb-genre-search-item';
        const l = document.createElement('span');
        l.textContent = m.label;
        const r = document.createElement('span');
        r.className = 'rb-genre-search-parent';
        r.textContent = m.parent;
        item.appendChild(l);
        item.appendChild(r);
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          void chooseGenre(m.label).catch(() => {});
        });
        searchResultsEl.appendChild(item);
      }

      const customVal = query.trim();
      if (!matches.some((m) => m.label.toLowerCase() === q)) {
        const customBtn = document.createElement('button');
        customBtn.type = 'button';
        customBtn.className = 'rb-genre-search-item';
        customBtn.textContent = `+ Set custom genre: "${customVal}"`;
        customBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void chooseGenre(customVal).catch(() => {});
        });
        searchResultsEl.appendChild(customBtn);
      }
      searchResultsEl._topChoice = matches.length ? matches[0].label : customVal;
    };

    searchInput.addEventListener('input', () => renderSearchResults(searchInput.value));
    searchInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this._closeRbGenrePopover();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const choice = searchResultsEl._topChoice || searchInput.value.trim();
        if (choice) void chooseGenre(choice).catch(() => {});
      }
    });
    popover.onclick = (e) => e.stopPropagation();

    renderDualPanels();
    popover.classList.remove('hidden');

    const rect = cellEl.getBoundingClientRect();
    const popW = 468;
    const popH = 356;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 10));
    const top = rect.bottom + popH + 8 <= window.innerHeight
      ? rect.bottom + 4
      : Math.max(8, rect.top - popH - 4);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    searchInput.focus();
  }

  _formatTrackDurationCell(track) {
    if (track?.duration) return track.duration;
    const sec = Number(track?.durationSec) || 0;
    if (sec <= 0) return '—';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    return hrs > 0
      ? `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
      : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  _formatQualityCell(track) {
    const ext = String(track?.ext || 'MP3').toUpperCase();
    const bit = Number(track?.bitDepth) || 0;
    const sr = Number(track?.sampleRate) || 0;
    const br = Number(track?.bitrateKbps) || 0;
    const ch = Number(track?.channels) || 2;
    const srKhz = sr > 0 ? `${sr >= 44100 ? (sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1) : sr}kHz` : '';

    if (track?.isVideo) {
      const vc = String(track?.videoCodec || '').toUpperCase();
      const resStr = track?.videoWidth && track?.videoHeight ? `${track.videoWidth}×${track.videoHeight}` : '';
      const ac = String(track?.audioCodec || '').toUpperCase();
      const audioParts = [ac, br > 0 ? `${br} kbps` : '', srKhz, ch > 0 ? `${ch}ch` : ''].filter(Boolean).join(' ');
      const titleParts = [
        `${ext}${vc ? ` · ${vc}` : ''}${resStr ? ` (${resStr})` : ''}`,
        audioParts ? `Audio: ${audioParts}` : ''
      ].filter(Boolean);
      return {
        text: vc ? `${ext} · ${vc}` : ext,
        cls: 'video',
        title: titleParts.join(' • ')
      };
    }

    if (['FLAC', 'ALAC', 'WAV', 'W64', 'AIFF', 'AIF', 'APE', 'WV', 'DSF', 'DFF'].includes(ext)) {
      const srLabel = sr >= 44100 ? `·${Math.round(sr / 1000)}k` : '';
      const bitLabel = bit >= 16 ? ` ${bit}b` : '';
      return {
        text: `${ext}${bitLabel}${srLabel}`,
        cls: 'lossless',
        title: `${ext} Lossless${bit ? ` · ${bit}-bit` : ''}${srKhz ? ` · ${srKhz}` : ''}${br > 0 ? ` · ${br} kbps` : ''}`
      };
    }
    const kbps = br > 0 ? ` ${br}k` : '';
    return {
      text: `${ext}${kbps}`,
      cls: '',
      title: `${ext}${br > 0 ? ` · ${br} kbps` : ''}${srKhz ? ` · ${srKhz}` : ''}`
    };
  }

  _startInlineCellEdit(cellEl, track, field, currentVal) {
    if (!cellEl || !track || this._activeInlineEdit) return;
    this._activeInlineEdit = true;
    const prevNodes = Array.from(cellEl.childNodes);

    const input = document.createElement('input');
    input.type = field === 'bpm' ? 'number' : 'text';
    if (field === 'bpm') {
      input.min = '40';
      input.max = '240';
      input.step = '1';
    }
    input.className = 'rb-inline-input';
    input.value = currentVal || '';
    input.placeholder = field === 'genre' ? 'e.g. Melodic Techno' : `Enter ${field}...`;

    let finished = false;
    const restore = () => {
      cellEl.replaceChildren(...prevNodes);
      this._activeInlineEdit = false;
    };

    const commit = async () => {
      if (finished) return;
      finished = true;
      let nextVal = input.value.trim();
      if (field === 'bpm') {
        const n = Math.round(Number(nextVal));
        if (!Number.isFinite(n) || n < 40 || n > 240) {
          restore();
          this.setToast('BPM must be between 40 and 240');
          return;
        }
        nextVal = n;
      }

      const prevStr = String(currentVal ?? '').trim();
      if (String(nextVal) === prevStr) {
        restore();
        return;
      }

      track[field] = nextVal;
      this._activeInlineEdit = false;
      await this._commitTrackFieldUpdate(track, field, nextVal);
    };

    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        void commit().catch(() => {});
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finished = true;
        restore();
      }
    });
    input.addEventListener('blur', () => {
      if (!finished) void commit().catch(() => {});
    });

    cellEl.replaceChildren(input);
    input.focus();
    input.select();
  }

  _extractFolderPath(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    const sepIdx = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
    return sepIdx > 0 ? raw.slice(0, sepIdx) : raw;
  }

  _formatCreationDateCell(track) {
    const raw = track?.createdAt || track?.modifiedAt;
    if (!raw) return '—';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '—';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  _formatFileSizeCell(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '—';
    if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  _bindEditableCell(cell, track, field, currentVal) {
    cell.classList.add('rb-cell-editable');
    cell.addEventListener('dblclick', (e) => {
      clearTimeout(this._rowClickTimer);
      this._rowClickTimer = null;
      e.stopPropagation();
      this._startInlineCellEdit(cell, track, field, currentVal);
    });
  }

  _buildRbCell(col, track, idx, isSelected) {
    const cell = document.createElement('div');
    cell.className = 'rb-cell';
    cell.dataset.colId = col.id;

    switch (col.id) {
      case 'num': {
        cell.classList.add('rb-cell-num');
        const trackKey = this._getTrackUniqueKey(track);
        const loadedKey = this._getTrackUniqueKey(this.currentLoadedTrack);
        const indicator = resolveQueueRowNumIndicator({
          index: idx,
          trackKey,
          loadedKey,
          isPlaying: this.isPlaying,
          pausedTrackKey: this._pausedTrackKey,
          isSelected
        });
        cell.textContent = indicator;
        if (indicator !== String(idx + 1)) {
          cell.classList.add('rb-cell-num-state');
          cell.title = this.isPlaying ? 'Playing (click row to pause)' : 'Paused (click row to resume)';
        }
        break;
      }
      case 'title': {
        const thumb = document.createElement('div');
        thumb.className = 'rb-thumb';
        const coverSrc = this._getTrackCoverSrc(track);
        if (coverSrc) {
          const img = document.createElement('img');
          img.className = 'rb-thumb-img';
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.draggable = false;
          img.src = coverSrc;
          img.addEventListener('error', () => {
            img.remove();
            thumb.style.background = track.grad || 'linear-gradient(135deg, #2f6fed, #06b6d4)';
            thumb.textContent = track.isVideo ? '🎬' : '🎵';
          });
          thumb.appendChild(img);
        } else {
          thumb.style.background = track.grad || 'linear-gradient(135deg, #2f6fed, #06b6d4)';
          thumb.textContent = track.isVideo ? '🎬' : '🎵';
        }
        const txt = document.createElement('span');
        txt.className = 'rb-cell-text rb-cell-title';
        txt.textContent = track.title || track.fileName || 'Untitled';
        txt.title = `${track.title || ''} (Double-click to edit)`;
        cell.appendChild(thumb);
        cell.appendChild(txt);
        this._bindEditableCell(cell, track, 'title', track.title || '');
        break;
      }
      case 'artist': {
        const txt = document.createElement('span');
        txt.className = 'rb-cell-text rb-cell-muted';
        txt.textContent = track.artist || '—';
        txt.title = `${track.artist || ''} (Double-click to edit)`;
        cell.appendChild(txt);
        this._bindEditableCell(cell, track, 'artist', track.artist || '');
        break;
      }
      case 'bpm': {
        cell.classList.add('rb-cell-right');
        const txt = document.createElement('span');
        txt.className = 'rb-cell-text rb-cell-mono';
        txt.textContent = track.bpm ? String(track.bpm) : '—';
        txt.title = 'Double-click to edit BPM';
        cell.appendChild(txt);
        this._bindEditableCell(cell, track, 'bpm', String(track.bpm || ''));
        break;
      }
      case 'key': {
        const rawKey = String(track.key || '').trim();
        const camelot = CAMELOT_KEY_MAP[rawKey]?.code || '';
        const badge = document.createElement('span');
        if (camelot || rawKey) {
          badge.className = 'rb-key-badge';
          badge.textContent = camelot || rawKey;
          badge.title = rawKey && camelot ? `${camelot} (${rawKey}) — Double-click to edit` : 'Double-click to edit Key';
        } else {
          badge.className = 'rb-cell-empty';
          badge.textContent = '—';
        }
        cell.appendChild(badge);
        this._bindEditableCell(cell, track, 'key', rawKey);
        break;
      }
      case 'genre': {
        const g = String(track.genre || '').trim();
        const mainCat = resolveMainGenre(g);
        const txt = document.createElement('span');
        txt.className = g ? 'rb-cell-text' : 'rb-cell-text rb-cell-empty';
        txt.textContent = g || '—';
        txt.title = g
          ? `${mainCat && mainCat !== g ? `${mainCat} › ` : ''}${g} (Double-click to pick Genre / Subgenre)`
          : 'Double-click to pick Genre / Subgenre (DB + file tag)';
        cell.classList.add('rb-cell-editable');
        cell.appendChild(txt);
        cell.addEventListener('dblclick', (e) => {
          clearTimeout(this._rowClickTimer);
          this._rowClickTimer = null;
          e.stopPropagation();
          this._openRbGenrePopover(cell, track);
        });
        break;
      }
      case 'time': {
        cell.classList.add('rb-cell-right');
        const txt = document.createElement('span');
        const durStr = this._formatTrackDurationCell(track);
        txt.className = durStr === '—' ? 'rb-cell-mono rb-cell-empty' : 'rb-cell-mono rb-cell-muted';
        txt.textContent = durStr;
        cell.appendChild(txt);
        break;
      }
      case 'rating': {
        cell.classList.add('rb-rating-cell');
        const starsWrap = document.createElement('div');
        starsWrap.className = 'star-rating';
        const currentStars = Number(track.stars) || 0;
        for (let s = 1; s <= 5; s++) {
          const sBtn = document.createElement('button');
          sBtn.className = `star-btn ${s <= currentStars ? 'lit' : ''}`;
          sBtn.textContent = '★';
          sBtn.title = `Rate ${s} star${s > 1 ? 's' : ''}`;
          sBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const nextStars = currentStars === s ? 0 : s;
            track.stars = nextStars;
            await this.persistTrackAnnotation(track, { stars: nextStars });
            if (this.filterState.exactStars > 0) this.applyFiltersAndRender(false);
            else this.renderQueue();
            this.setToast(`Rated "${track.title}": ${nextStars > 0 ? `${nextStars}/5 ★` : 'Cleared'}`);
          });
          starsWrap.appendChild(sBtn);
        }
        const isFav = Boolean(track.favorite);
        const heartBtn = document.createElement('button');
        heartBtn.type = 'button';
        heartBtn.className = `heart-btn ${isFav ? 'lit' : ''}`;
        heartBtn.setAttribute('aria-pressed', String(isFav));
        heartBtn.title = isFav ? 'Remove from Favorites' : 'Mark as Favorite';
        heartBtn.appendChild(this._createHeartSvg(isFav));
        heartBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const nextFav = !Boolean(track.favorite);
          track.favorite = nextFav;
          await this.persistTrackAnnotation(track, { favorite: nextFav });
          if (this.filterState.favoriteOnly && !nextFav) this.applyFiltersAndRender(false);
          else this.renderQueue();
          this.setToast(nextFav ? `Added "${track.title}" to Favorites ♥` : `Removed "${track.title}" from Favorites`);
        });
        cell.appendChild(starsWrap);
        cell.appendChild(heartBtn);
        break;
      }
      case 'tags': {
        cell.classList.add('rb-tags-cell');
        for (const tg of (track.tags || []).slice(0, 3)) {
          const pill = document.createElement('span');
          pill.className = 'row-tag-pill';

          const txtBtn = document.createElement('button');
          txtBtn.type = 'button';
          txtBtn.className = 'pill-text-btn';
          txtBtn.textContent = `#${tg}`;
          txtBtn.title = 'Click to filter by #' + tg;
          txtBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.filterState.tags = [tg];
            this.renderTagFilterOptions();
            this.applyFiltersAndRender(true);
          });

          const rmBtn = document.createElement('button');
          rmBtn.type = 'button';
          rmBtn.className = 'pill-remove-btn';
          rmBtn.textContent = '×';
          rmBtn.title = `Remove #${tg}`;
          rmBtn.setAttribute('aria-label', `Remove tag ${tg}`);
          rmBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            track.tags = (track.tags || []).filter((item) => item !== tg);
            await this.persistTrackAnnotation(track, { tags: track.tags });
            this.renderTagFilterOptions();
            if (this.filterState.tags.length > 0) this.applyFiltersAndRender(false);
            else this.renderQueue();
            this.setToast(`Removed #${tg} from "${track.title}"`);
          });

          pill.appendChild(txtBtn);
          pill.appendChild(rmBtn);
          cell.appendChild(pill);
        }

        for (const grp of (track.groups || []).slice(0, 1)) {
          const gPill = document.createElement('span');
          gPill.className = 'row-group-pill';
          const grpBtn = document.createElement('button');
          grpBtn.type = 'button';
          grpBtn.className = 'pill-text-btn';
          grpBtn.textContent = grp;
          grpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.filterState.groups = [grp];
            this.renderTagFilterOptions();
            this.applyFiltersAndRender(true);
          });
          const rmGrpBtn = document.createElement('button');
          rmGrpBtn.type = 'button';
          rmGrpBtn.className = 'pill-remove-btn';
          rmGrpBtn.textContent = '×';
          rmGrpBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            track.groups = [];
            await this.persistTrackAnnotation(track, { groups: [] });
            this.renderTagFilterOptions();
            if (this.filterState.groups.length > 0) this.applyFiltersAndRender(false);
            else this.renderQueue();
          });
          gPill.appendChild(grpBtn);
          gPill.appendChild(rmGrpBtn);
          cell.appendChild(gPill);
        }

        const addTagBtn = document.createElement('button');
        addTagBtn.className = 'row-tag-btn';
        addTagBtn.textContent = '+';
        addTagBtn.title = 'Add up to 3 tags or assign 1 group';
        addTagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openInlineTagEditor(track);
        });
        cell.appendChild(addTagBtn);
        break;
      }
      case 'format': {
        const info = this._formatQualityCell(track);
        const pill = document.createElement('span');
        pill.className = `rb-format-pill ${info.cls}`.trim();
        pill.textContent = info.text;
        pill.title = info.title || info.text;
        cell.appendChild(pill);
        break;
      }
      case 'album': {
        const alb = String(track.album || '').trim();
        const txt = document.createElement('span');
        txt.className = alb ? 'rb-cell-text rb-cell-muted' : 'rb-cell-text rb-cell-empty';
        txt.textContent = alb || '—';
        txt.title = alb ? `${alb} (Double-click to edit)` : 'Double-click to add Album';
        cell.appendChild(txt);
        this._bindEditableCell(cell, track, 'album', alb);
        break;
      }
      case 'created': {
        cell.classList.add('rb-cell-right');
        const txt = document.createElement('span');
        const createdStr = this._formatCreationDateCell(track);
        txt.className = createdStr === '—' ? 'rb-cell-text rb-cell-empty' : 'rb-cell-text rb-cell-muted';
        txt.textContent = createdStr;
        txt.title = track.createdAt || '';
        cell.appendChild(txt);
        break;
      }
      case 'size': {
        cell.classList.add('rb-cell-right');
        const txt = document.createElement('span');
        const sizeStr = this._formatFileSizeCell(track.sizeBytes);
        txt.className = sizeStr === '—' ? 'rb-cell-mono rb-cell-empty' : 'rb-cell-mono rb-cell-muted';
        txt.textContent = sizeStr;
        cell.appendChild(txt);
        break;
      }
      case 'source': {
        const txt = document.createElement('span');
        const folderPath = this._extractFolderPath(track.filePath);
        const displaySource = folderPath || track.provenance || '';
        txt.className = displaySource ? 'rb-cell-text rb-cell-muted' : 'rb-cell-text rb-cell-empty';
        txt.textContent = displaySource || '—';
        txt.title = folderPath || track.filePath || '';
        cell.appendChild(txt);
        break;
      }
      default:
        break;
    }

    return cell;
  }

  /**
   * Renders embedded track lyrics into structured, left-aligned verse stanzas.
   * Uses safe DOM node creation rather than raw HTML string interpolation.
   * @param {string} rawLyrics - Embedded lyrics text or empty string.
   */
  _renderTrackLyrics(rawLyrics) {
    const container = document.getElementById('activeLyricLine');
    const copyBtn = document.getElementById('btnCopyLyrics');
    const tokens = parseStructuredLyrics(rawLyrics);
    this._currentFormattedLyrics = tokens.map((t) => (t.type === 'gap' ? '' : t.text)).join('\n');
    if (copyBtn) {
      copyBtn.disabled = !tokens.length;
      copyBtn.classList.remove('copied');
      const labelEl = copyBtn.querySelector('.lyrics-copy-label');
      if (labelEl) labelEl.textContent = 'Copy';
    }
    if (!container) return;
    container.replaceChildren();
    container.scrollTop = 0;

    if (!tokens.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'lyric-empty';
      emptyEl.textContent = 'No embedded lyrics found for this track.';
      container.appendChild(emptyEl);
      return;
    }

    const classMap = {
      section: 'lyric-section-header',
      cue: 'lyric-cue',
      line: 'lyric-line',
      gap: 'lyric-gap'
    };

    const frag = document.createDocumentFragment();
    for (const tok of tokens) {
      const el = document.createElement('div');
      el.className = classMap[tok.type] || 'lyric-line';
      if (tok.text) el.textContent = tok.text;
      frag.appendChild(el);
    }
    container.appendChild(frag);
  }

  /**
   * Returns lightweight lazy cover art URL (`vanta-cover://`) or inline DataURL if present.
   * @param {object|null} track
   * @returns {string}
   */
  _getTrackCoverSrc(track) {
    if (!track) return '';
    if (track.coverUrl) return track.coverUrl;
    if (track.coverDataUrl) return track.coverDataUrl;
    if (track.hasCover && track.filePath) {
      return `vanta-cover://local?path=${encodeURIComponent(track.filePath)}`;
    }
    return '';
  }

  /**
   * Binds throttled scroll/resize listeners on the Rekordbox viewport for 10,000+ row virtualization.
   */
  _ensureVirtualScrollBound() {
    if (this._rbViewportBound) return;
    const viewport = document.getElementById('rbTableViewport');
    if (!viewport) return;
    this._rbViewportBound = true;
    const schedule = () => {
      if (this._rbScrollRaf) return;
      this._rbScrollRaf = requestAnimationFrame(() => {
        this._rbScrollRaf = 0;
        this._renderVirtualWindow(false);
      });
    };
    viewport.addEventListener('scroll', schedule, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this._rbResizeObserver = new ResizeObserver(schedule);
      this._rbResizeObserver.observe(viewport);
    }
  }

  /**
   * Renders only the visible slice (+ overscan buffer) of displayedTracks into `#rbVirtualSlice`.
   * Keeps DOM node count capped (~35 rows) regardless of whether catalog has 20 or 20,000 tracks.
   * @param {boolean} [force=false]
   */
  _renderVirtualWindow(force = false) {
    const listEl = document.getElementById('trackQueueList');
    const viewport = document.getElementById('rbTableViewport');
    if (!listEl || !this.displayedTracks.length) return;
    if (!force && this._activeInlineEdit) return;

    const ROW_H = 44;
    const OVERSCAN = 10;
    const HEADER_H = 30;
    const total = this.displayedTracks.length;
    const scrollTop = Math.max(0, (viewport?.scrollTop || 0) - HEADER_H);
    const viewH = viewport?.clientHeight || 620;

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const endIdx = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

    if (!force && startIdx === this._rbLastVStart && endIdx === this._rbLastVEnd) {
      return;
    }
    this._rbLastVStart = startIdx;
    this._rbLastVEnd = endIdx;

    let sliceEl = document.getElementById('rbVirtualSlice');
    if (!sliceEl || sliceEl.parentElement !== listEl) {
      sliceEl = document.createElement('div');
      sliceEl.id = 'rbVirtualSlice';
      sliceEl.className = 'rb-virtual-slice';
      listEl.replaceChildren(sliceEl);
    }
    sliceEl.style.transform = `translate3d(0, ${startIdx * ROW_H}px, 0)`;

    const cols = this._getVisibleRbColumns();
    const frag = document.createDocumentFragment();

    for (let idx = startIdx; idx < endIdx; idx++) {
      const track = this.displayedTracks[idx];
      const isSelected = idx === this.activeTrackIndex;
      const row = document.createElement('div');
      row.className = `track-row rb-row rb-vrow ${idx % 2 === 1 ? 'rb-even' : ''} ${isSelected ? 'active' : ''}`;
      row.dataset.testid = `track-row-${idx}`;
      row.dataset.trackIndex = String(idx);

      for (const col of cols) {
        row.appendChild(this._buildRbCell(col, track, idx, isSelected));
      }

      row.addEventListener('click', (e) => {
        if (this._activeInlineEdit) return;
        clearTimeout(this._rowClickTimer);
        const fireSelect = () => {
          if (this._activeInlineEdit) return;
          const clickedKey = this._getTrackUniqueKey(track);
          const loadedKey = this._getTrackUniqueKey(this.currentLoadedTrack);
          if (resolveRowClickAction({ clickedKey, loadedKey }) === 'toggle') {
            this.activeTrackIndex = idx;
            this.togglePlay();
            return;
          }
          this.banditRewards[track.id] = (this.banditRewards[track.id] || 0) + 0.25;
          this.selectTrack(idx, true);
        };
        if (e.target?.closest?.('.rb-cell-editable')) {
          this._rowClickTimer = setTimeout(fireSelect, 240);
        } else {
          fireSelect();
        }
      });

      frag.appendChild(row);
    }

    sliceEl.replaceChildren(frag);
  }

  /**
   * Renders the active track queue into the virtualized Rekordbox 7 columnar table view.
   */
  renderQueue() {
    this._renderRbTableHeader();
    this._ensureVirtualScrollBound();
    const listEl = document.getElementById('trackQueueList');
    if (!listEl) return;

    const matchBadge = document.getElementById('listMatchCount');
    if (matchBadge) {
      if (this.activeNav === 'albums' && !this.selectedAlbumId && this.albumsViewMode === 'grid') {
        matchBadge.textContent = `${this.albumCollections.length} release${this.albumCollections.length === 1 ? '' : 's'}`;
      } else if (this.activeNav === 'artists' && !this.selectedArtistId && this.artistsViewMode === 'grid') {
        matchBadge.textContent = `${this.artistCollections.length} artist${this.artistCollections.length === 1 ? '' : 's'}`;
      } else {
        const poolTotal =
          (this.activeNav === 'albums' && this.selectedAlbumId) || (this.activeNav === 'artists' && this.selectedArtistId)
            ? this._getTracksPoolForNav(this.activeNav).length
            : this.catalog.length;
        matchBadge.textContent = `${this.displayedTracks.length} / ${poolTotal} ${this.activeNav === 'videos' ? 'videos' : 'tracks'}`;
      }
    }
    const clearBtn = document.getElementById('btnClearPlaylist');
    if (clearBtn) {
      clearBtn.disabled = this.catalog.length === 0;
    }

    if (this.displayedTracks.length === 0) {
      this._rbLastVStart = -1;
      this._rbLastVEnd = -1;
      listEl.style.height = '';
      listEl.style.position = '';
      listEl.replaceChildren();
      const emptyBox = document.createElement('div');
      emptyBox.style.cssText = 'padding: 28px 16px; text-align: center; color: var(--muted); font-size: 12.5px;';
      emptyBox.textContent =
        this.catalog.length > 0
          ? 'No tracks match your active search or BPM / Key / Star filters. Click "Reset" to show all tracks.'
          : 'Your playlist is empty. Open "Computer Explorer" under Sources, drop files/folders here, or paste a YouTube URL above.';
      listEl.appendChild(emptyBox);
      return;
    }

    listEl.style.position = 'relative';
    listEl.style.height = `${this.displayedTracks.length * 44}px`;
    this._renderVirtualWindow(true);
  }

  /**
   * Quietly enriches Time & Quality/Format columns in the background, prioritizing visible rows first
   * with bounded concurrency and without destroying scroll position.
   */
  async _scheduleBackgroundTechProbe() {
    if (!window.vantaAPI?.probeTrackTech || this._techProbeRunning) return;
    this._techProbeRunning = true;
    try {
      const visibleStart = Math.max(0, this._rbLastVStart >= 0 ? this._rbLastVStart : 0);
      const visibleEnd = Math.min(this.displayedTracks.length, Math.max(visibleStart + 40, this._rbLastVEnd));
      const seenPaths = new Set();
      const candidates = [];
      const pushIfNeedsProbe = (t) => {
        if (!t?.filePath || seenPaths.has(t.filePath)) return;
        seenPaths.add(t.filePath);
        if (!t.durationSec || (t.isVideo ? !t.videoCodec : !t.bitrateKbps)) {
          candidates.push(t);
        }
      };

      for (let i = visibleStart; i < visibleEnd; i++) pushIfNeedsProbe(this.displayedTracks[i]);
      for (const t of this.catalog) {
        if (candidates.length >= 60) break;
        pushIfNeedsProbe(t);
      }

      if (!candidates.length) return;
      let updatedAny = false;
      let cursor = 0;
      const workerCount = Math.min(3, candidates.length);
      const runWorker = async () => {
        while (cursor < candidates.length) {
          const track = candidates[cursor++];
          const p = await window.vantaAPI
            .probeTrackTech({ filePath: track.filePath, audioHash: track.audioHash, isVideo: Boolean(track.isVideo) })
            .catch(() => null);
          if (p) {
            if (p.durationSec > 0) track.durationSec = p.durationSec;
            if (p.bitrateKbps > 0) track.bitrateKbps = p.bitrateKbps;
            if (p.sampleRate > 0) track.sampleRate = p.sampleRate;
            if (p.bitDepth > 0) track.bitDepth = p.bitDepth;
            if (p.channels > 0) track.channels = p.channels;
            if (p.codec) track.audioCodec = p.codec;
            if (p.videoCodec) track.videoCodec = p.videoCodec;
            if (p.videoWidth > 0) track.videoWidth = p.videoWidth;
            if (p.videoHeight > 0) track.videoHeight = p.videoHeight;
            updatedAny = true;
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, runWorker));

      if (updatedAny && !this._activeInlineEdit) {
        this._renderVirtualWindow(true);
      }
    } finally {
      this._techProbeRunning = false;
    }
  }

  /**
   * Opens the inline Tag & Group editor bar for a specific track.
   * @param {object} track - Track object.
   */
  openInlineTagEditor(track) {
    this.editingTrackKey = track.filePath || track.id;
    const editor = document.getElementById('inlineTagEditor');
    const nameEl = document.getElementById('tagEditorTrackName');
    const tagInput = document.getElementById('tagInputField');
    const groupInput = document.getElementById('groupInputField');

    this._populateInlineTagSelects();
    if (nameEl) nameEl.textContent = track.title;
    if (tagInput) tagInput.value = '';
    if (groupInput) groupInput.value = '';
    if (editor) {
      editor.classList.remove('hidden');
      tagInput?.focus();
    }
  }

  /**
   * Persists track rating, tags, or group assignments to C:\Vanta\VantaVault\vanta-library.json.
   * @param {object} track - Target track.
   * @param {object} patch - Fields to merge.
   */
  async persistTrackAnnotation(track, patch, writeTagsToFile = false) {
    if (!window.vantaAPI) return null;
    let res = null;
    try {
      res = await window.vantaAPI.updateTrackMeta({
        audioHash: track.audioHash || '',
        filePath: track.filePath,
        id: track.id,
        patch,
        writeTagsToFile
      });
    } catch {
      // Ignore if outside Electron
    }
    this.renderSmartPlaylistBar();
    return res;
  }

  /**
   * Loads a track into the Right Studio Inspector Dock and Bottom Player Bar.
   * @param {number} index - Index in this.displayedTracks.
   * @param {boolean} [autoPlay=false] - Whether to immediately start playback.
   */
  selectTrack(index, autoPlay = false) {
    if (!this.displayedTracks.length) return;
    const clampedIdx = Math.max(0, Math.min(this.displayedTracks.length - 1, index));
    const incomingTrack = this.displayedTracks[clampedIdx];
    const incomingKey = this._getTrackUniqueKey(incomingTrack);
    const prevTrack = this.currentLoadedTrack;
    const prevKey = this._getTrackUniqueKey(prevTrack);

    if (!this._navigatingHistory && prevTrack && prevKey && prevKey !== incomingKey) {
      const top = this.playbackHistory[this.playbackHistory.length - 1];
      if (!top || top.key !== prevKey) {
        this.playbackHistory.push({
          key: prevKey,
          title: prevTrack.title,
          artist: prevTrack.artist || ''
        });
        if (this.playbackHistory.length > 30) {
          this.playbackHistory.shift();
        }
        this._savePlaybackHistory();
      }
    }
    this.currentLoadedTrack = incomingTrack;
    this._lastTimelinePosSec = 0;
    void this.scoreStudio?.onTrackChanged(incomingTrack).catch(() => {});
    if (prevKey !== incomingKey) {
      this._pausedTrackKey = null;
    }
    this._updateLastPlayedButton();

    this.activeTrackIndex = clampedIdx;
    const track = incomingTrack;

    // Update Right Dock & Footer Artwork
    document.getElementById('dockTrackTitle').textContent = track.title;
    document.getElementById('dockTrackSubtitle').textContent = `${track.artist} · ${track.bpm} BPM · ${track.key}`;

    const artBox = document.getElementById('dockArtworkBox');
    const miniThumb = document.getElementById('footerMiniThumb');
    const coverSrc = this._getTrackCoverSrc(track);
    if (coverSrc) {
      artBox.style.backgroundImage = `url("${coverSrc}")`;
      artBox.textContent = '';
      miniThumb.style.backgroundImage = `url("${coverSrc}")`;
      miniThumb.textContent = '';
    } else {
      artBox.style.backgroundImage = '';
      artBox.style.background = track.grad || 'linear-gradient(135deg, var(--a1), var(--a2), var(--a3))';
      artBox.textContent = track.isVideo ? '🎬' : '🎧';
      miniThumb.style.backgroundImage = '';
      miniThumb.style.background = track.grad || 'linear-gradient(135deg, var(--a1), var(--a3))';
      miniThumb.textContent = track.isVideo ? '🎬' : '🎧';
    }

    // Keep active track visible when stepping/jumping inside 1,000+ virtualized rows
    const viewport = document.getElementById('rbTableViewport');
    if (viewport) {
      const rowTop = clampedIdx * 44 + 30;
      const rowBot = rowTop + 44;
      const viewTop = viewport.scrollTop + 30;
      const viewBot = viewport.scrollTop + viewport.clientHeight;
      if (rowTop < viewTop) {
        viewport.scrollTop = Math.max(0, clampedIdx * 44);
      } else if (rowBot > viewBot && viewport.clientHeight > 74) {
        viewport.scrollTop = Math.max(0, rowBot - viewport.clientHeight);
      }
    }

    if (track.lyrics) {
      this._renderTrackLyrics(track.lyrics);
    } else if (track.hasLyrics && track.filePath && window.vantaAPI?.getTrackDetails) {
      this._renderTrackLyrics('');
      window.vantaAPI
        .getTrackDetails(track.filePath)
        .then((details) => {
          track.lyrics = details?.lyrics || '';
          if (this.currentLoadedTrack === track) {
            this._renderTrackLyrics(track.lyrics);
          }
        })
        .catch(() => {});
    } else {
      this._renderTrackLyrics('');
    }

    this.crossfadeTriggeredForTrack = false;
    this.activeTrackProbe = null;
    this.activeTrackR128 = null;
    this.activeTrackTags = null;
    this.lastReplayGainInfo = null;
    this.lastLiveAudioTelemetry = null;
    this.wasapiPausedTrackKey = null;
    this.wasapiResumeSec = 0;
    this.wasapiCurrentPositionSec = 0;
    this.studioSeekOffsetSec = 0;
    this._pendingStudioSeekSec = null;

    // Reset timeline & telemetry for incoming track
    this.visualizer.setProgress(0);
    const fillEl = document.getElementById('masterTimelineFill');
    const thumbEl = document.getElementById('masterTimelineThumb');
    if (fillEl) fillEl.style.width = '0%';
    if (thumbEl) thumbEl.style.left = '0%';
    const elEl = document.getElementById('timeElapsedLabel');
    const remEl = document.getElementById('timeRemainingLabel');
    if (elEl) elEl.textContent = '00:00';
    if (remEl) remEl.textContent = track.duration || '-00:00';

    // Load Media Stream into HTML5 deck only in Studio DSP or Video mode (never pre-load Chromium audio during WASAPI Exclusive)
    this.deckBEl?.pause();
    if (track.isVideo) {
      if (this.engineMode !== 'dsp') {
        this.engineMode = 'dsp';
        this.wasapiStatusMode = 'STUDIO DSP';
      }
    } else if (this.preferredAudioEngineMode === 'wasapi' && this.engineMode !== 'wasapi') {
      this.engineMode = 'wasapi';
      this.wasapiStatusMode = this.outputBackend === 'asio' ? 'ASIO ISOLATED READY' : 'WASAPI EXCLUSIVE READY';
    }
    this._syncEngineModeUi(track);

    if (track.filePath) {
      if (track.isVideo) {
        this.audioEl.pause();
        this.audioEl.removeAttribute('src');
        this.switchStage('video');
        this.prepareVideoTrack(track, this.theaterOpen);
        void this.probeActiveTrack(track).catch(() => {});
      } else {
        if (this.theaterOpen) this.openTheaterStage(false);
        const mediaUrl = this._buildLocalMediaUrl(track);
        this.videoEl.pause();
        if (this.engineMode === 'dsp') {
          const activeDeck = this.audioEngine.getActiveDeckElement() || this.audioEl;
          activeDeck.src = mediaUrl;
        } else {
          this.audioEl.pause();
          this.audioEl.removeAttribute('src');
          this.deckBEl?.removeAttribute('src');
          if (!autoPlay) {
            this.audioEngine.suspendEngine().catch(() => {});
          }
        }
        if (Number(track.sacdTrack) >= 1) {
          this.activeTrackProbe = {
            codec: track.audioCodec || track.codec || 'SACD DST/DSD',
            sampleRate: Number(track.sampleRate) || 2822400,
            bitDepth: 1,
            channels: Number(track.channels) || 2,
            durationSec: Number(track.durationSec) || 0,
            sacdArea: Number.isFinite(Number(track.sacdArea)) ? Number(track.sacdArea) : 0,
            sacdTrack: Number(track.sacdTrack)
          };
        } else {
          void this.probeActiveTrack(track).catch(() => {});
        }
      }
    } else {
      this.audioEl.removeAttribute('src');
      this.deckBEl?.removeAttribute('src');
    }

    this.updateStreamTelemetry();
    this.renderQueue();

    if (autoPlay) {
      void this.startPlayback(0).catch(() => {});
    } else {
      if (window.vantaAPI) window.vantaAPI.wasapiCmd('STOP').catch(() => {});
    }
  }

  /**
   * Starts audio/video playback via Native WASAPI Exclusive or Dual-Deck Studio DSP.
   * @param {number|null} [seekSecOverride=null] - Optional seek offset in seconds (`null` resumes paused state).
   */
  async startPlayback(seekSecOverride = null) {
    const track = this.displayedTracks[this.activeTrackIndex];
    if (!track) {
      this.setToast('No tracks loaded — open "Computer Explorer", drop files/folders, or paste a YouTube URL');
      return;
    }
    const mySeq = ++this._playbackSeq;
    this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
    this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
    this._pausedTrackKey = null;
    this.isPlaying = true;
    this.visualizer.isPlaying = true;

    this.setPlayPauseIcon(true);
    document.getElementById('vinylPlatterDisc')?.classList.remove('paused');
    this.renderQueue();

    const trackKey = this._getTrackUniqueKey(track);
    const useNativeWasapi =
      this.engineMode === 'wasapi' &&
      Boolean(window.vantaAPI) &&
      Boolean(track.filePath) &&
      !track.isVideo &&
      Math.abs(this.audioEngine.state.playbackRate - 1.0) < 0.001;

    if (track.filePath && useNativeWasapi) {
      this._pendingStudioSeekSec = null;
      this.audioEngine.stopProceduralSynthPreview();
      this.audioEl.pause();
      this.deckBEl?.pause();
      this.videoEl.pause();
      await this.audioEngine.suspendEngine();
      if (mySeq !== this._playbackSeq) return;

      const isHeldResume =
        Boolean(this.wasapiPausedHeld) &&
        this.wasapiPausedTrackKey === trackKey &&
        seekSecOverride === null;
      if (isHeldResume) {
        this.wasapiPausedHeld = false;
        this.wasapiPausedTrackKey = null;
        window.vantaAPI.wasapiCmd('RESUME').catch(() => {});
        const evtRate = this.lastWasapiReadyEvent?.sampleRate;
        const rKhz = evtRate ? `${(evtRate / 1000).toFixed(1).replace(/\.0$/, '')}kHz` : 'Native';
        const isAsioEvt = this.lastWasapiReadyEvent?.mode === 'asio' || this.lastWasapiReadyEvent?.mode === 'asio_dsd_raw';
        this.wasapiStatusMode = this.lastWasapiReadyEvent?.mode === 'asio_dsd_raw'
          ? `ASIO RAW DSD (${this.lastWasapiReadyEvent?.dsdRate || 'DSD'})`
          : (this.lastWasapiReadyEvent?.bitExact
            ? `BIT-EXACT ${isAsioEvt ? 'ASIO' : 'WASAPI'} (${rKhz})`
            : `PUREPATH 64 ${isAsioEvt ? 'ASIO' : 'WASAPI'} (${rKhz})`);
        this.updateStreamTelemetry();
        return;
      }

      const resumeOffset =
        seekSecOverride === null && this.wasapiPausedTrackKey === trackKey
          ? this.wasapiResumeSec
          : Math.max(0, Number(seekSecOverride) || 0);
      this.wasapiPausedTrackKey = null;
      this.wasapiPausedHeld = false;
      this.wasapiResumeSec = 0;
      this._wasapiGaplessTarget = null;
      this._wasapiGaplessQueuedKey = null;
      this.wasapiCurrentPositionSec = resumeOffset;
      this.wasapiXrunCount = 0;
      window.vantaAPI
        .wasapiPlay({
          filePath: track.filePath,
          exclusive: true,
          dop: Boolean(this.dopEnabled),
          deviceId: this.selectedDeviceId || '',
          backend: this.outputBackend === 'asio' ? 'asio' : 'wasapi',
          asioDriver: this.asioDriver || '',
          asioRawDsd: Boolean(this.asioRawDsd),
          sacdArea: Number(track.sacdArea) || 0,
          sacdTrack: Number(track.sacdTrack) || 0,
          linearGain: this.getEffectiveWasapiGain(),
          seekSec: resumeOffset,
          dspSpec: serializeNativeDspSpecFromState(this.audioEngine.state),
          peqSpec: serializePeqWireSpec(this.audioEngine.state),
          convolverIrPath: (this.audioEngine.state.convolverEnabled && this.audioEngine.state.convolverPath) ? this.audioEngine.state.convolverPath : '',
          convolverWetPct: Math.max(0, Math.min(100, Math.round(Number(this.audioEngine.state.convolverWetPct ?? 100) || 0))),
          pushMode: Boolean(this.wasapiPushMode),
          bufferMs: Number(this.wasapiBufferMs) || 0,
          preRollMs: Number(this.clockSwitchPreRollMs) || 0,
          fixedRateLock: Boolean(this.fixedRateLock),
          fixedTargetRate: Number(this.fixedTargetRate) || 0
        })
        .then((res) => {
          if (mySeq !== this._playbackSeq) return;
          if (!res?.ok) {
            this.setToast(`WASAPI fallback -> Studio DSP (${res?.error || 'Device busy'})`);
            void this.setEngineMode('dsp', true).catch(() => {});
          } else {
            if (res.probe) this.activeTrackProbe = res.probe;
            if (res.caps) {
              this.deviceCaps = res.caps;
              if (res.caps.hwVolumeSupport !== undefined) {
                this.deviceHwVolumeSupport = Number(res.caps.hwVolumeSupport) || 0;
              }
            }
            if (res.ratePlan) this.lastWasapiRatePlan = res.ratePlan;
            this._syncAllDspUi();
            this.updateStreamTelemetry();
          }
        })
        .catch(() => {
          if (mySeq === this._playbackSeq) void this.setEngineMode('dsp', true).catch(() => {});
        });
    } else if (track.filePath) {
      this.audioEngine.stopProceduralSynthPreview();
      if (!track.isVideo) {
        this.videoEl?.pause();
      }
      if (window.vantaAPI) await window.vantaAPI.wasapiCmd('STOP').catch(() => {});
      if (mySeq !== this._playbackSeq) return;
      if (track.isVideo && Boolean(this._videoProbePromise)) {
        await this._videoProbePromise.catch(() => {});
        if (mySeq !== this._playbackSeq) return;
      }
      await this.audioEngine.resumeEngine();
      if (mySeq !== this._playbackSeq) return;
      this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
      if (this.audioEngine.state.convolverEnabled && this.audioEngine.state.convolverPath) {
        void this._ensureStudioConvolverIrLoaded().catch(() => {});
      }
      const targetEl = track.isVideo
        ? this.videoEl
        : (this.audioEngine.getActiveDeckElement() || this.audioEl);
      const hasExplicitSeek = seekSecOverride !== null || this._pendingStudioSeekSec !== null;
      const effectiveSeek = seekSecOverride !== null
        ? Math.max(0, Number(seekSecOverride) || 0)
        : (this._pendingStudioSeekSec !== null ? Math.max(0, Number(this._pendingStudioSeekSec) || 0) : 0);
      this._pendingStudioSeekSec = null;

      const usesFfmpegStream = requiresStudioFfmpegStream(track, this.activeVideoStrategy);
      const currentSrc = String(targetEl.src || '');
      const sacdMismatch = Number(track.sacdTrack) >= 1 && !currentSrc.includes(`sacdTrack=${Number(track.sacdTrack)}`);
      const sameTrackLoaded = Boolean(currentSrc) && (
        track.isVideo
          ? (this._lastLoadedVideoUrl && currentSrc === this._lastLoadedVideoUrl)
          : (currentSrc.includes(encodeURIComponent(track.filePath)) && !sacdMismatch)
      );

      if (usesFfmpegStream) {
        if (hasExplicitSeek || !sameTrackLoaded) {
          const ffOffset = effectiveSeek > 0.5 ? effectiveSeek : 0;
          this._setMediaSeekOffsetSec(track, ffOffset);
          const streamUrl = track.isVideo
            ? this.buildVideoStreamUrl(track, this.activeVideoAudioIdx, ffOffset)
            : this._buildLocalMediaUrl(track, ffOffset);
          targetEl.src = streamUrl;
          if (track.isVideo) this._lastLoadedVideoUrl = streamUrl;
        }
      } else {
        this._setMediaSeekOffsetSec(track, 0);
        const directUrl = track.isVideo
          ? this.buildVideoStreamUrl(track, this.activeVideoAudioIdx, 0)
          : this._buildLocalMediaUrl(track, 0);
        if (!sameTrackLoaded || currentSrc.includes('&ss=')) {
          targetEl.src = directUrl;
          if (track.isVideo) this._lastLoadedVideoUrl = directUrl;
        }
        if (hasExplicitSeek) {
          this._applyNativeSeekOnElement(targetEl, effectiveSeek);
        }
      }

      targetEl.playbackRate = this.audioEngine.state.playbackRate;
      targetEl.preservesPitch = Math.abs(targetEl.playbackRate - 1.0) < 0.001;
      try {
        await targetEl.play();
      } catch (err) {
        if (err?.name !== 'AbortError') {
          this.setToast(`Playback error: ${err.message}`);
          window.vantaAPI?.logClientEvent('ERROR', 'Studio DSP play() failed', { error: err.message });
        }
      }
    } else {
      await this.audioEngine.resumeEngine();
      if (mySeq !== this._playbackSeq) return;
      this.audioEngine.startProceduralSynthPreview(track.bpm || 126);
    }
  }

  /**
   * Pauses playback cleanly across WASAPI Exclusive and Dual-Deck HTML5 engines.
   */
  pausePlayback() {
    const track = this.displayedTracks[this.activeTrackIndex];
    this.isPlaying = false;
    this.visualizer.isPlaying = false;
    const pausedTarget = this.currentLoadedTrack || track;
    this._pausedTrackKey = this._getTrackUniqueKey(pausedTarget);
    this.audioEl.pause();
    this.deckBEl?.pause();
    this.videoEl.pause();
    this.audioEngine.stopProceduralSynthPreview();
    this.audioEngine.setExternalSpectrum(null);

    if (this.engineMode === 'wasapi' && window.vantaAPI && track?.filePath && !track.isVideo) {
      this.wasapiPausedTrackKey = this._getTrackUniqueKey(track);
      if (this.holdWasapiOnPause) {
        this.wasapiPausedHeld = true;
        window.vantaAPI.wasapiCmd('PAUSE').catch(() => {});
        this.wasapiStatusMode = 'WASAPI EXCLUSIVE (HELD · 0ms)';
        this.updateStreamTelemetry();
      } else {
        this.wasapiPausedHeld = false;
        this.wasapiResumeSec = Math.max(0, Number(this.wasapiCurrentPositionSec) || 0);
        this._wasapiGaplessTarget = null;
        this._wasapiGaplessQueuedKey = null;
        this.lastWasapiReadyEvent = null;
        window.vantaAPI
          .wasapiCmd('STOP')
          .then((res) => {
            if (!this.isPlaying && res && Number.isFinite(Number(res.positionSec))) {
              this.wasapiResumeSec = Math.max(0, Number(res.positionSec));
              this.wasapiCurrentPositionSec = this.wasapiResumeSec;
            }
          })
          .catch(() => {});
        this.wasapiStatusMode = 'WASAPI EXCLUSIVE (RELEASED)';
        this.updateStreamTelemetry();
      }
    }

    this.setPlayPauseIcon(false);
    document.getElementById('vinylPlatterDisc')?.classList.add('paused');
    this.renderQueue();
    this.setToast('Playback Paused');
  }

  /**
   * Toggles master Play/Pause state.
   */
  togglePlay() {
    if (this.isPlaying) this.pausePlayback();
    else void this.startPlayback().catch(() => {});
  }

  /**
   * Advances to the next or previous track in the active queue.
   * @param {number} delta - +1 or -1.
   */
  stepTrack(delta, autoAdvance = false) {
    if (!this.displayedTracks.length) return;
    const len = this.displayedTracks.length;
    let nextIdx = (this.activeTrackIndex + delta + len) % len;
    if (autoAdvance) {
      let found = -1;
      for (let step = 1; step <= len; step++) {
        const candIdx = (this.activeTrackIndex + delta * step + len * step) % len;
        const cand = this.displayedTracks[candIdx];
        if (!cand) continue;
        if (isLongFeatureVideo(cand)) continue;
        if (cand.isVideo && !isMusicVideoTagged(cand) && this.activeNav !== 'videos') continue;
        found = candIdx;
        break;
      }
      if (found < 0) {
        this.pausePlayback();
        return;
      }
      nextIdx = found;
    }
    this.selectTrack(nextIdx, this.isPlaying);
  }

  /**
   * Returns to and plays the most recently played track from playback history.
   */
  goBackToLastPlayedTrack() {
    const currentKey = this._getTrackUniqueKey(this.currentLoadedTrack);
    while (this.playbackHistory.length > 0) {
      const entry = this.playbackHistory.pop();
      if (!entry || !entry.key || entry.key === currentKey) continue;

      let targetIdx = this.displayedTracks.findIndex((t) => this._getTrackUniqueKey(t) === entry.key);
      if (targetIdx < 0) {
        const inCatalog = this.catalog.find((t) => this._getTrackUniqueKey(t) === entry.key);
        if (!inCatalog) continue;
        document.getElementById('btnResetFilters')?.click();
        targetIdx = this.displayedTracks.findIndex((t) => this._getTrackUniqueKey(t) === entry.key);
      }
      if (targetIdx >= 0) {
        this._savePlaybackHistory();
        this._navigatingHistory = true;
        try {
          this.selectTrack(targetIdx, true);
        } finally {
          this._navigatingHistory = false;
        }
        this._updateLastPlayedButton();
        this.setToast(`Returned to Last Played: "${entry.title}"`);
        return;
      }
    }
    this._savePlaybackHistory();
    this._updateLastPlayedButton();
    this.setToast('No previous played track in history yet');
  }

  /**
   * Switches the Right Studio Inspector Dock visual stage ('wave' | 'video' | 'vinyl' | 'lyrics').
   * @param {string} stageName - Target stage mode.
   */
  switchStage(stageName) {
    this.activeStage = stageName;
    ['wave', 'video', 'vinyl', 'lyrics'].forEach((s) => {
      const container = document.getElementById(`stageContainer-${s}`);
      if (container) container.classList.toggle('hidden', s !== stageName);
    });
    document.querySelectorAll('#stageModeSwitcher .seg-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.stage === stageName);
    });
  }

  /**
   * Updates the sleek inline YouTube Batch progress indicator inside the YouTube Batch bar.
   * @param {number} percent - Progress percentage (0 to 100).
   * @param {string} stageLabel - Current batch pipeline stage.
   */
  updateBatchProgressRing(percent, stageLabel = 'Ready') {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const circumference = 69;
    const offset = Math.round(circumference - (clamped / 100) * circumference);

    const circle = document.getElementById('batchProgressCircle');
    const pctText = document.getElementById('batchProgressPct');
    const statusText = document.getElementById('batchStatusText');

    const isError = /fail/i.test(stageLabel);
    if (circle) {
      circle.setAttribute('stroke-dashoffset', String(offset));
      circle.setAttribute('stroke', isError ? '#f43f5e' : '#00e5ff');
    }
    if (pctText) {
      if (isError) pctText.textContent = '✕';
      else if (clamped === 100) pctText.textContent = '✓';
      else pctText.textContent = `${clamped}`;
    }
    if (statusText) {
      statusText.textContent = stageLabel;
      statusText.style.color = isError ? 'var(--rose)' : clamped === 100 ? 'var(--emerald)' : 'var(--a2)';
    }
  }

  /**
   * Updates the status toast in the bottom player bar.
   * @param {string} message - Status text.
   */
  setToast(message) {
    const el = document.getElementById('footerStatusToast');
    if (el) {
      clearTimeout(this._toastClearTimer);
      if (!message) {
        el.textContent = '';
        el.classList.add('hidden');
        return;
      }
      el.textContent = `✦ ${message}`;
      el.title = message;
      el.classList.remove('hidden');
      this._toastClearTimer = setTimeout(() => {
        el.textContent = '';
        el.classList.add('hidden');
      }, 2200);
    }
  }

  /**
   * Handles switching between the 15 Left Sidebar modules.
   * @param {string} navId - Selected sidebar module key.
   */
  handleSidebarSwitch(navId) {
    if (navId === 'explorer') {
      void this.toggleComputerExplorer().catch(() => {});
      return;
    }
    if (navId === 'score') {
      void this.scoreStudio?.open(this.currentLoadedTrack || this.displayedTracks[this.activeTrackIndex] || null).catch(() => {});
      return;
    }
    this.activeNav = navId;
    if (navId !== 'albums') {
      this.selectedAlbumId = null;
    }
    if (navId !== 'artists') {
      this.selectedArtistId = null;
      this.selectedArtistReleaseId = null;
    }
    if (navId !== 'playlists' && this.activeSmartPlaylistId) {
      this.activeSmartPlaylistId = null;
      this.filterState = {
        query: '',
        minBpm: '',
        maxBpm: '',
        key: 'ALL',
        energyBand: 'ALL',
        exactStars: 0,
        tags: [],
        groups: [],
        favoriteOnly: false,
        sortBy: 'default'
      };
      this._syncFilterBarDomFromState();
      this.renderTagFilterOptions();
    }
    document.querySelectorAll('.sidebar .nav-item').forEach((btn) => {
      const isExplorerBtn = btn.dataset.nav === 'explorer';
      btn.classList.toggle('active', btn.dataset.nav === navId || (isExplorerBtn && this.explorerOpen));
    });

    const badgeEl = document.getElementById('heroModuleBadge');
    const headlineEl = document.getElementById('heroHeadline');
    const descEl = document.getElementById('heroDescription');
    const queueTitleEl = document.getElementById('queuePanelTitle');

    const audioPool = this._getTracksPoolForNav('tracks');
    switch (navId) {
      case 'vibe': {
        const anchor = this.displayedTracks[this.activeTrackIndex] || audioPool[0] || this.catalog[0];
        this.displayedTracks = buildVibeRadioQueue(anchor, audioPool, this.banditRewards);
        badgeEl.textContent = 'VIBE RADIO • HARMONIC AUTO-DJ';
        headlineEl.innerHTML = `Vibe Radio Locked: <span class="grad-text">${anchor?.title || 'Night Walk'}</span>`;
        descEl.textContent = 'Continuous harmonic stream ordered by Song DNA cosine similarity and Camelot Wheel key compatibility.';
        queueTitleEl.textContent = 'Vibe Radio Harmonic Sequence';
        break;
      }
      case 'dna': {
        this.displayedTracks = [...audioPool].sort((a, b) => (b.energy || 0) - (a.energy || 0));
        badgeEl.textContent = 'MIR SONG DNA EXPLORER';
        headlineEl.innerHTML = `Acoustic Intelligence: <span class="grad-text">Song DNA Matrix</span>`;
        descEl.textContent = 'Real-time BPM onset detection, Camelot key analysis, and 6-dimensional acoustic embeddings.';
        queueTitleEl.textContent = 'Catalog Ranked by Acoustic Energy & BPM';
        break;
      }
      case 'capsule': {
        const stats = buildTimeCapsuleAnalytics(audioPool);
        this.displayedTracks = [...audioPool];
        badgeEl.textContent = 'MUSIC TIME CAPSULE';
        headlineEl.innerHTML = `Time Capsule: <span class="grad-text">${stats.eraTitle}</span>`;
        descEl.textContent = `Catalog DNA: ${stats.totalTracks} Tracks · Avg ${stats.avgBpm} BPM · Dominant Key ${stats.dominantKey} · ${stats.youtubeCount} YouTube / ${stats.localCount} Local.`;
        queueTitleEl.textContent = 'Time Capsule Nostalgia Radar';
        break;
      }
      case 'videos': {
        const vids = this._getTracksPoolForNav('videos');
        this.displayedTracks = vids;
        this.switchStage('video');
        badgeEl.textContent = '4K & HD VIDEO CLIPS VAULT';
        headlineEl.innerHTML = `Video Clips: <span class="grad-text">${vids.length} Video${vids.length === 1 ? '' : 's'} (MP4 / MKV / WebM)</span>`;
        descEl.textContent = 'Tag any clip with #MusicVideo to include it in your Tracks queue. All videos route through the 10-Band Pro Audio DSP Rack and 4K Theater Stage.';
        queueTitleEl.textContent = 'Video Clips & Movies';
        break;
      }
      case 'dj': {
        this.displayedTracks = [...audioPool];
        badgeEl.textContent = 'DJ CROSSFADE & 10-BAND PRO DSP';
        headlineEl.innerHTML = `Mastering Deck: <span class="grad-text">-14 LUFS &amp; 6.0s Beat-Sync</span>`;
        descEl.textContent = 'Open the Studio Pro DSP Rack from the Right Dock to sculpt 10-Band EQ, Spatial 3D Width, Crossfeed, Exciter, Limiter, and Pitch Shift.';
        queueTitleEl.textContent = 'Auto-DJ Beat-Matched Deck Queue';
        break;
      }
      case 'remix': {
        this.displayedTracks = [...audioPool];
        this.switchStage('lyrics');
        badgeEl.textContent = 'AI REMIX • KARAOKE • VINYL SOUL';
        headlineEl.innerHTML = `Creative Suite: <span class="grad-text">Vocal Remover &amp; Vinyl Turntable</span>`;
        descEl.textContent = 'Toggle real-time Mid-Side Karaoke Vocal Cancellation, Vinyl Soul needle crackle, and Slowed + Reverb pitch modes.';
        queueTitleEl.textContent = 'Stem & Karaoke Ready Tracks';
        break;
      }
      case 'tracks': {
        this.displayedTracks = [...audioPool];
        badgeEl.textContent = 'TRACKS LIBRARY';
        headlineEl.innerHTML = `Track Library: <span class="grad-text">${audioPool.length} Tracks</span>`;
        descEl.textContent = 'Audio tracks and #MusicVideo clips imported from watched folders, Computer Explorer, or drag-and-drop.';
        queueTitleEl.textContent = 'Tracks Library';
        break;
      }
      case 'albums': {
        this.selectedAlbumId = null;
        const filteredAudio = applyProSmartFilter(audioPool, this.filterState, audioPool[0] || null);
        this.displayedTracks = [...filteredAudio].sort(
          (a, b) =>
            String(a.album || '').localeCompare(String(b.album || '')) ||
            String(a.title || '').localeCompare(String(b.title || ''))
        );
        const allAlbums = buildAlbumCollections(audioPool, { mode: 'all' });
        const taggedCount = allAlbums.filter((g) => g.kind === 'album').length;
        const folderCount = allAlbums.filter((g) => g.kind === 'folder').length;
        badgeEl.textContent = 'ALBUMS & RELEASE COLLECTIONS';
        headlineEl.replaceChildren();
        headlineEl.append('Albums: ');
        const grad = document.createElement('span');
        grad.className = 'grad-text';
        grad.textContent = `${allAlbums.length} Release Group${allAlbums.length === 1 ? '' : 's'}`;
        headlineEl.appendChild(grad);
        descEl.textContent = `${taggedCount} tagged album${taggedCount === 1 ? '' : 's'} and ${folderCount} folder collection${folderCount === 1 ? '' : 's'} with instant cover-art playback and tracklist drill-down.`;
        queueTitleEl.textContent = 'Albums Collection';
        break;
      }
      case 'artists': {
        this.selectedArtistId = null;
        this.selectedArtistReleaseId = null;
        const filteredAudio = applyProSmartFilter(audioPool, this.filterState, audioPool[0] || null);
        this.displayedTracks = [...filteredAudio].sort(
          (a, b) =>
            String(a.artist || '').localeCompare(String(b.artist || '')) ||
            String(a.title || '').localeCompare(String(b.title || ''))
        );
        const allArtists = buildArtistCollections(audioPool, { mode: 'all' });
        const multiCount = allArtists.filter((a) => a.trackCount >= 2).length;
        badgeEl.textContent = 'ARTISTS & DISCOGRAPHY';
        headlineEl.replaceChildren();
        headlineEl.append('Artists: ');
        const grad = document.createElement('span');
        grad.className = 'grad-text';
        grad.textContent = `${allArtists.length} Studio Artist${allArtists.length === 1 ? '' : 's'}`;
        headlineEl.appendChild(grad);
        descEl.textContent = `${multiCount} artist${multiCount === 1 ? '' : 's'} with multiple tracks. Explore circular artist portraits, discography releases, and instant Vibe Radio.`;
        queueTitleEl.textContent = 'Artists Collection';
        break;
      }
      case 'playlists': {
        if (this.activeSmartPlaylistId) {
          const activeRule = this.smartPlaylists.find((p) => p.id === this.activeSmartPlaylistId);
          if (activeRule) {
            this.displayedTracks = this.evaluateSmartPlaylistTracks(activeRule);
          } else {
            this.activeSmartPlaylistId = null;
            this.displayedTracks = [...audioPool];
          }
        } else {
          this.displayedTracks = [...audioPool];
        }
        badgeEl.textContent = 'USER-DEFINED SMART PLAYLISTS';
        const names = (this.smartPlaylists || []).map((p) => p.name).join(' · ');
        headlineEl.innerHTML = `Smart Playlists: <span class="grad-text">${this.smartPlaylists.length} Custom Rule${this.smartPlaylists.length === 1 ? '' : 's'}</span>`;
        descEl.textContent = names || 'No rules defined yet. Click "+ New Rule" below or configure filters above and click "+ Smart List".';
        queueTitleEl.textContent = 'Smart Playlists';
        break;
      }
      case 'doctor': {
        this.displayedTracks = [...this.catalog];
        const count = this.doctorReport?.issues?.length || 0;
        badgeEl.textContent = 'CATALOG QUALITY & METADATA DOCTOR';
        headlineEl.innerHTML = `Quality Doctor: <span class="grad-text">${count} Issues Detected (${this.doctorReport.healthScore}% Health)</span>`;
        descEl.textContent = 'Scans C:\\Vanta\\VantaVault and watched folders for missing ID3v2 APIC cover frames, missing BPM/Key tags, and SHA-256 duplicates.';
        queueTitleEl.textContent = 'Inspected Catalog Tracks';
        break;
      }
      default: {
        this.displayedTracks = [...audioPool];
        badgeEl.textContent = `WORKSPACE • ${navId.toUpperCase()}`;
        headlineEl.innerHTML = `Tonight's Vibe: <span class="grad-text">Night Walk &amp; Obsidian Synth</span>`;
        descEl.textContent = 'VANTA harmonizes your YouTube Vault streams and Local 24-Bit FLAC / MP3 masters.';
        queueTitleEl.textContent = 'Library & Vault Queue';
        break;
      }
    }

    this.activeTrackIndex = 0;
    const activePoolLen = navId === 'videos' ? this._getTracksPoolForNav('videos').length : audioPool.length;
    const matchBadge = document.getElementById('listMatchCount');
    if (matchBadge) {
      matchBadge.textContent = `${this.displayedTracks.length} / ${activePoolLen} ${navId === 'videos' ? 'videos' : 'tracks'}`;
    }
    this.syncHeroPlaylistShowcase();
    this.renderSmartPlaylistBar();
    this.renderAlbumsWorkspace();
    this.renderArtistsWorkspace();
    if (this.activeNav === 'albums' && !this.selectedAlbumId && this.albumsViewMode === 'grid' && matchBadge) {
      matchBadge.textContent = `${this.albumCollections.length} release${this.albumCollections.length === 1 ? '' : 's'}`;
    } else if (this.activeNav === 'artists' && !this.selectedArtistId && this.artistsViewMode === 'grid' && matchBadge) {
      matchBadge.textContent = `${this.artistCollections.length} artist${this.artistCollections.length === 1 ? '' : 's'}`;
    }
    this.renderQueue();
    this.setToast(`Active Module: ${navId.toUpperCase()}`);
  }

  /**
   * Normalizes saved or draft smart playlist filters across legacy and modern schemas.
   * @param {object} [raw={}] - Raw filter fields.
   * @returns {object} Normalized filter configuration compatible with applyProSmartFilter.
   */
  normalizeRuleFilters(raw = {}) {
    const legacyTags = raw.tag && raw.tag !== 'ALL' ? [raw.tag] : [];
    const tags = Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t).trim()).filter(Boolean)
      : legacyTags;
    const groups = Array.isArray(raw.groups)
      ? raw.groups.map((g) => String(g).trim()).filter(Boolean)
      : [];
    return {
      query: String(raw.query || ''),
      minBpm: raw.minBpm ? String(raw.minBpm) : '',
      maxBpm: raw.maxBpm ? String(raw.maxBpm) : '',
      key: raw.key || 'ALL',
      energyBand: raw.energyBand || 'ALL',
      exactStars: Number(raw.exactStars || raw.minStars || 0),
      tags,
      groups,
      favoriteOnly: Boolean(raw.favoriteOnly),
      sortBy: raw.sortBy || 'default'
    };
  }

  /**
   * Returns true if at least one rule filter criterion is configured.
   * @param {object} filters - Normalized filter state.
   * @returns {boolean}
   */
  hasAnyRuleCriterion(filters = {}) {
    return Boolean(
      filters.minBpm ||
      filters.maxBpm ||
      (filters.key && filters.key !== 'ALL') ||
      (filters.energyBand && filters.energyBand !== 'ALL') ||
      Number(filters.exactStars) > 0 ||
      (Array.isArray(filters.tags) && filters.tags.length > 0) ||
      (Array.isArray(filters.groups) && filters.groups.length > 0) ||
      filters.favoriteOnly
    );
  }

  /**
   * Formats a compact human-readable rule summary string from filter criteria.
   * @param {object} rawFilters - Filter state.
   * @returns {string}
   */
  formatRuleSummary(rawFilters = {}) {
    const f = this.normalizeRuleFilters(rawFilters);
    const parts = [];
    if (f.minBpm || f.maxBpm) {
      parts.push(`${f.minBpm || '40'}–${f.maxBpm || '240'} BPM`);
    }
    if (f.key && f.key !== 'ALL') parts.push(f.key);
    if (f.energyBand && f.energyBand !== 'ALL') {
      const eMap = { low: 'Low Energy', mid: 'Mid Energy', high: 'Peak Energy' };
      parts.push(eMap[f.energyBand] || f.energyBand);
    }
    if (f.exactStars > 0) parts.push(`${f.exactStars}★`);
    if (f.tags.length) parts.push(f.tags.map((t) => `#${t}`).join(', '));
    if (f.groups.length) parts.push(`[${f.groups.join(', ')}]`);
    if (f.favoriteOnly) parts.push('♥');
    return parts.join(' · ');
  }

  /**
   * Renders the Smart Playlist Manager Bar with live match counts, apply, edit, and delete controls.
   */
  renderSmartPlaylistBar() {
    const barEl = document.getElementById('smartPlaylistBar');
    const gridEl = document.getElementById('smartPlaylistGrid');
    const summaryBadge = document.getElementById('smartRulesSummaryBadge');
    const clearRuleBtn = document.getElementById('btnClearActiveRule');
    if (!barEl || !gridEl) return;

    const shouldShow = this.activeNav === 'playlists';
    barEl.classList.toggle('hidden', !shouldShow);

    const rules = Array.isArray(this.smartPlaylists) ? this.smartPlaylists : [];
    if (summaryBadge) {
      summaryBadge.textContent = `${rules.length} rule${rules.length === 1 ? '' : 's'}`;
    }
    if (clearRuleBtn) {
      clearRuleBtn.classList.toggle('hidden', !this.activeSmartPlaylistId);
    }

    if (!shouldShow) return;

    gridEl.replaceChildren();
    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'smart-rule-empty';
      empty.textContent = 'No smart playlist rules yet. Click "+ New Rule" or set filters above and click "+ Smart List".';
      gridEl.appendChild(empty);
      return;
    }

    const anchor = this.catalog[0] || null;
    const frag = document.createDocumentFragment();
    for (const rule of rules) {
      const isFlow = rule.kind === 'flow';
      const normalizedFilters = isFlow ? {} : this.normalizeRuleFilters(rule.filters);
      const matchingTracks = this.evaluateSmartPlaylistTracks(rule, anchor);
      const matchCount = matchingTracks.length;
      const isActive = this.activeSmartPlaylistId === rule.id;

      const card = document.createElement('div');
      card.className = `smart-rule-card${isActive ? ' active' : ''}`;
      card.dataset.ruleId = rule.id;

      card.appendChild(this.buildPlaylistCoverElement(rule, matchingTracks, 'sm'));

      const info = document.createElement('div');
      info.className = 'smart-rule-info';

      const top = document.createElement('div');
      top.className = 'smart-rule-top';

      const nameEl = document.createElement('span');
      nameEl.className = 'smart-rule-name';
      nameEl.textContent = rule.name;

      top.appendChild(nameEl);
      if (isFlow) {
        const kindPill = document.createElement('span');
        kindPill.className = 'smart-rule-kind-pill';
        kindPill.textContent = 'FLOW';
        top.appendChild(kindPill);
      }

      const countPill = document.createElement('span');
      countPill.className = 'smart-rule-count';
      countPill.textContent = `${matchCount} track${matchCount === 1 ? '' : 's'}`;
      top.appendChild(countPill);

      const summaryEl = document.createElement('span');
      summaryEl.className = 'smart-rule-summary';
      const flowNodeLen = Object.keys(rule.graph?.nodes || {}).length;
      const flowEdgeLen = Array.isArray(rule.graph?.edges) ? rule.graph.edges.length : 0;
      const ruleSpec = isFlow
        ? `${flowNodeLen} nodes · ${flowEdgeLen} wires`
        : (this.formatRuleSummary(normalizedFilters) || 'All tracks');
      summaryEl.textContent = rule.description ? `${rule.description} · ${ruleSpec}` : ruleSpec;
      summaryEl.title = summaryEl.textContent;

      info.appendChild(top);
      info.appendChild(summaryEl);

      const btns = document.createElement('div');
      btns.className = 'smart-rule-btns';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'smart-rule-icon-btn play';
      playBtn.textContent = '▶';
      playBtn.title = `Play "${rule.name}"`;
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playSmartPlaylistRule(rule, false);
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'smart-rule-icon-btn';
      editBtn.textContent = '✎';
      editBtn.title = isFlow ? `Open "${rule.name}" in Flow Studio` : `Edit "${rule.name}"`;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isFlow) this.flowStudio.open(rule);
        else this.openSmartRuleModal(rule);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'smart-rule-icon-btn danger';
      delBtn.textContent = '×';
      delBtn.title = `Delete "${rule.name}"`;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.deleteSmartPlaylist(rule.id);
      });

      btns.appendChild(playBtn);
      btns.appendChild(editBtn);
      btns.appendChild(delBtn);

      card.appendChild(info);
      card.appendChild(btns);
      card.addEventListener('click', () => {
        if (this.activeSmartPlaylistId === rule.id) {
          this.clearActiveSmartRule();
        } else {
          this.applySmartPlaylistRule(rule);
        }
      });

      frag.appendChild(card);
    }

    gridEl.appendChild(frag);
  }

  /**
   * Formats total album duration in minutes/hours for release summary headers.
   * @param {number} totalSec - Total duration in seconds.
   * @returns {string} Human-readable runtime string.
   */
  _formatAlbumDuration(totalSec) {
    const sec = Math.max(0, Math.round(Number(totalSec) || 0));
    if (!sec) return '';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const remSec = sec % 60;
    if (hrs > 0) return `${hrs} hr ${mins} min`;
    if (mins > 0) return `${mins}m ${String(remSec).padStart(2, '0')}s`;
    return `${remSec}s`;
  }

  /**
   * Builds a crisp cover element (1 full cover, 2x2 mosaic, or gradient monogram) shared by Albums & Artists.
   * @param {object[]} tracks - Tracks supplying cover art.
   * @param {string} label - Display title/name for alt text and monogram initials.
   * @param {string} frameClass - CSS class for container shape (`album-art-frame card`, `artist-art-frame detail`, etc.).
   * @returns {HTMLElement}
   */
  _buildCollectionArtworkElement(tracks = [], label = 'V', frameClass = 'album-art-frame card') {
    const box = document.createElement('div');
    box.className = frameClass;

    const uniqueCovers = [];
    const seen = new Set();
    for (const t of tracks || []) {
      const cover = this._getTrackCoverSrc(t);
      if (cover && !seen.has(cover)) {
        seen.add(cover);
        uniqueCovers.push(cover);
        if (uniqueCovers.length >= 4) break;
      }
    }

    const applyMonogramFallback = () => {
      box.replaceChildren();
      const titleStr = String(label || 'V');
      let hash = 0;
      for (let i = 0; i < titleStr.length; i++) hash = (hash * 31 + titleStr.charCodeAt(i)) >>> 0;
      const preset = PLAYLIST_VISUAL_PRESETS[hash % PLAYLIST_VISUAL_PRESETS.length];
      box.style.background = preset.grad;

      const mono = document.createElement('div');
      mono.className = 'album-art-monogram';
      const words = titleStr.replace(/[^a-zA-Z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
      const initials =
        words.length >= 2
          ? `${words[0][0]}${words[1][0]}`.toUpperCase()
          : titleStr.slice(0, 2).toUpperCase() || 'VA';
      const disc = document.createElement('span');
      disc.className = 'album-monogram-initials';
      disc.textContent = initials;
      mono.appendChild(disc);
      box.appendChild(mono);
    };

    if (uniqueCovers.length === 1) {
      const img = document.createElement('img');
      img.className = 'album-art-img';
      img.alt = `${label} artwork`;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.draggable = false;
      img.src = uniqueCovers[0];
      img.addEventListener('error', applyMonogramFallback);
      box.appendChild(img);
      return box;
    }

    if (uniqueCovers.length >= 2) {
      const mosaic = document.createElement('div');
      mosaic.className = 'playlist-cover-mosaic';
      const tiles =
        uniqueCovers.length === 2
          ? [uniqueCovers[0], uniqueCovers[1], uniqueCovers[1], uniqueCovers[0]]
          : uniqueCovers.length === 3
            ? [uniqueCovers[0], uniqueCovers[1], uniqueCovers[2], uniqueCovers[0]]
            : uniqueCovers;
      for (const src of tiles) {
        const tile = document.createElement('div');
        tile.className = 'playlist-cover-mosaic-tile';
        tile.style.backgroundImage = `url("${src}")`;
        mosaic.appendChild(tile);
      }
      box.appendChild(mosaic);
      return box;
    }

    applyMonogramFallback();
    return box;
  }

  /**
   * Builds a square album artwork element.
   * @param {object} album - Album collection descriptor.
   * @param {'card'|'detail'} [variant='card'] - Layout size token.
   * @returns {HTMLElement}
   */
  buildAlbumCoverElement(album, variant = 'card') {
    return this._buildCollectionArtworkElement(album?.tracks || [], album?.title || 'Album', `album-art-frame ${variant}`);
  }

  /**
   * Builds a circular artist portrait/collage element.
   * @param {object} artist - Artist collection descriptor.
   * @param {'card'|'detail'} [variant='card'] - Layout size token.
   * @returns {HTMLElement}
   */
  buildArtistCoverElement(artist, variant = 'card') {
    return this._buildCollectionArtworkElement(artist?.tracks || [], artist?.name || 'Artist', `artist-art-frame ${variant}`);
  }

  /**
   * Opens the Album Detail drill-down view for a specific album release group.
   * @param {string} albumId - Target album collection ID.
   */
  openAlbumDetail(albumId) {
    if (!albumId) return;
    this.selectedAlbumId = albumId;
    this.applyFiltersAndRender(true);
    const activeAlbum = this.albumCollections.find((a) => a.id === albumId);
    if (activeAlbum) {
      this.setToast(`Opened Album: "${activeAlbum.title}" (${activeAlbum.trackCount} tracks)`);
    }
  }

  /**
   * Closes Album Detail drill-down and returns to the Albums Gallery Grid.
   */
  closeAlbumDetail() {
    if (!this.selectedAlbumId) return;
    this.selectedAlbumId = null;
    this.applyFiltersAndRender(true);
    this.setToast('Showing all Albums');
  }

  /**
   * Plays an Album collection immediately (sequentially or shuffled).
   * @param {object} album - Album descriptor.
   * @param {boolean} [shuffle=false] - Whether to shuffle playback order.
   */
  playAlbumCollection(album, shuffle = false) {
    if (!album || !Array.isArray(album.tracks) || !album.tracks.length) {
      this.setToast('This album has no playable tracks');
      return;
    }
    this.selectedAlbumId = album.id;
    this.applyFiltersAndRender(true);
    if (!this.displayedTracks.length) {
      this.setToast(`No matching tracks in "${album.title}"`);
      return;
    }
    if (shuffle) {
      const btnShuffle = document.getElementById('btnShuffle');
      if (btnShuffle && !btnShuffle.classList.contains('active')) {
        btnShuffle.click();
      }
      const randIdx = Math.floor(Math.random() * this.displayedTracks.length);
      this.selectTrack(randIdx, true);
    } else {
      this.selectTrack(0, true);
    }
  }

  /**
   * Renders the professional Albums Gallery Grid and Album Detail View inside #queuePanel.
   */
  renderAlbumsWorkspace() {
    const workspaceEl = document.getElementById('albumsWorkspace');
    const toolbarEl = document.getElementById('albumsToolbar');
    const detailHeroEl = document.getElementById('albumsDetailHero');
    const gridScrollEl = document.getElementById('albumsGridScroll');
    const gridEl = document.getElementById('albumsGrid');
    const tableViewportEl = document.getElementById('rbTableViewport');
    const queueTitleEl = document.getElementById('queuePanelTitle');
    if (!workspaceEl || !gridEl || !tableViewportEl) return;

    const isAlbumsNav = this.activeNav === 'albums';
    const listSortEl = document.getElementById('listSortSelect');
    const searchInputEl = document.getElementById('listSearchInput');
    workspaceEl.classList.toggle('hidden', !isAlbumsNav);
    if (!isAlbumsNav) {
      workspaceEl.classList.remove('albums-workspace-full');
      if (this.activeNav !== 'artists') {
        tableViewportEl.classList.remove('hidden');
        listSortEl?.classList.remove('hidden');
        if (searchInputEl) {
          searchInputEl.placeholder = 'Search title, artist, #tag, bpm:120-130, key:8A, star:4+...';
        }
      }
      return;
    }

    const audioBase = this.catalog.filter((t) => !t.isVideo || isMusicVideoTagged(t));
    // Apply Smart Focus bar filters (except album drill-down) so BPM/Key/Stars/Search narrow album cards cleanly
    const nonAlbumFilters = { ...this.filterState, query: '' };
    const smartFilteredPool = applyProSmartFilter(audioBase, nonAlbumFilters, audioBase[0] || null);

    const allCollections = buildAlbumCollections(smartFilteredPool, {
      mode: 'all',
      query: this.filterState.query,
      sortBy: this.albumsSortBy
    });
    const modeCollections =
      this.albumsMode === 'all'
        ? allCollections
        : buildAlbumCollections(smartFilteredPool, {
            mode: this.albumsMode,
            query: this.filterState.query,
            sortBy: this.albumsSortBy
          });
    this.albumCollections = modeCollections;

    // Update mode pill counts & active states
    const taggedCount = allCollections.filter((a) => a.kind === 'album').length;
    const folderCount = allCollections.filter((a) => a.kind === 'folder').length;
    document.querySelectorAll('#albumsModeGroup [data-album-mode]').forEach((btn) => {
      const m = btn.dataset.albumMode;
      btn.classList.toggle('active', m === this.albumsMode);
      if (m === 'all') btn.textContent = `All Releases (${allCollections.length})`;
      else if (m === 'tagged') btn.textContent = `Album Tags (${taggedCount})`;
      else if (m === 'folder') btn.textContent = `Folders (${folderCount})`;
    });
    document.querySelectorAll('#albumsViewGroup [data-album-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.albumView === this.albumsViewMode);
    });
    const sortSel = document.getElementById('albumsSortSelect');
    if (sortSel && sortSel.value !== this.albumsSortBy) sortSel.value = this.albumsSortBy;

    // Check if drilled into a specific album
    const activeAlbum = this.selectedAlbumId
      ? buildAlbumCollections(audioBase, { mode: 'all' }).find((a) => a.id === this.selectedAlbumId) || null
      : null;
    if (this.selectedAlbumId && !activeAlbum) {
      this.selectedAlbumId = null;
    }

    if (activeAlbum) {
      workspaceEl.classList.remove('albums-workspace-full');
      toolbarEl?.classList.add('hidden');
      gridScrollEl?.classList.add('hidden');
      detailHeroEl?.classList.remove('hidden');
      tableViewportEl.classList.remove('hidden');
      listSortEl?.classList.remove('hidden');
      if (searchInputEl) {
        searchInputEl.placeholder = `Search inside "${activeAlbum.title}"...`;
      }

      if (queueTitleEl) queueTitleEl.textContent = `Album · ${activeAlbum.title}`;

      const artHost = document.getElementById('albumDetailArt');
      const kindEl = document.getElementById('albumDetailReleaseKind');
      const titleEl = document.getElementById('albumDetailTitle');
      const subEl = document.getElementById('albumDetailSubtitle');
      const statsEl = document.getElementById('albumDetailStats');

      if (artHost) artHost.replaceChildren(this.buildAlbumCoverElement(activeAlbum, 'detail'));
      if (kindEl) {
        kindEl.textContent =
          activeAlbum.kind === 'album'
            ? activeAlbum.isCompilation
              ? 'COMPILATION ALBUM'
              : 'ALBUM RELEASE'
            : activeAlbum.kind === 'folder'
              ? 'FOLDER COLLECTION'
              : 'SINGLES COLLECTION';
      }
      if (titleEl) titleEl.textContent = activeAlbum.title;
      if (subEl) {
        const subParts = [activeAlbum.artist];
        if (activeAlbum.year) subParts.push(activeAlbum.year);
        if (activeAlbum.genre) subParts.push(activeAlbum.genre);
        subEl.textContent = subParts.filter(Boolean).join(' · ');
      }
      if (statsEl) {
        statsEl.replaceChildren();
        const addStatPill = (text, extraClass = '') => {
          const pill = document.createElement('span');
          pill.className = `album-stat-pill${extraClass ? ` ${extraClass}` : ''}`;
          pill.textContent = text;
          statsEl.appendChild(pill);
        };
        addStatPill(`${activeAlbum.trackCount} track${activeAlbum.trackCount === 1 ? '' : 's'}`);
        const durLabel = this._formatAlbumDuration(activeAlbum.totalDurationSec);
        if (durLabel) addStatPill(durLabel);
        if (activeAlbum.avgBpm > 0) addStatPill(`Avg ${activeAlbum.avgBpm} BPM`);
        if (activeAlbum.avgStars > 0) addStatPill(`★ ${activeAlbum.avgStars}`, 'star');
        if (activeAlbum.isLossless) addStatPill('HI-RES LOSSLESS', 'lossless');
        else if (activeAlbum.formats.length) addStatPill(activeAlbum.formats.slice(0, 2).join(' / '));
      }
      return;
    }

    // Gallery Grid vs Flat Table mode
    detailHeroEl?.classList.add('hidden');
    toolbarEl?.classList.remove('hidden');
    if (queueTitleEl) queueTitleEl.textContent = 'Albums Collection';

    if (this.albumsViewMode === 'table') {
      workspaceEl.classList.remove('albums-workspace-full');
      gridScrollEl?.classList.add('hidden');
      tableViewportEl.classList.remove('hidden');
      listSortEl?.classList.remove('hidden');
      if (searchInputEl) {
        searchInputEl.placeholder = 'Search title, artist, #tag, bpm:120-130, key:8A, star:4+...';
      }
      return;
    }

    workspaceEl.classList.add('albums-workspace-full');
    gridScrollEl?.classList.remove('hidden');
    tableViewportEl.classList.add('hidden');
    listSortEl?.classList.add('hidden');
    if (searchInputEl) {
      searchInputEl.placeholder = 'Search albums, artists, genres, year, or tracks...';
    }

    gridEl.replaceChildren();
    if (!modeCollections.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'albums-empty-state';
      emptyEl.textContent =
        this.albumsMode === 'tagged'
          ? 'No tracks with embedded Album tags match your filters yet. Switch to "All Releases" or edit an Album cell in Tracks.'
          : 'No albums or release folders match your active search and filters.';
      gridEl.appendChild(emptyEl);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const album of modeCollections) {
      const card = document.createElement('article');
      card.className = 'album-card';
      card.tabIndex = 0;
      card.dataset.albumId = album.id;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${album.title} by ${album.artist}, ${album.trackCount} tracks`);

      const artWrap = document.createElement('div');
      artWrap.className = 'album-card-art';
      artWrap.appendChild(this.buildAlbumCoverElement(album, 'card'));

      // Top-left release / lossless badge
      if (album.isLossless || album.kind === 'folder') {
        const topBadge = document.createElement('span');
        topBadge.className = `album-card-badge ${album.isLossless ? 'lossless' : 'folder'}`;
        topBadge.textContent = album.isLossless ? 'LOSSLESS' : 'FOLDER';
        artWrap.appendChild(topBadge);
      }

      // Top-right track count pill
      const countBadge = document.createElement('span');
      countBadge.className = 'album-card-count';
      countBadge.textContent = `${album.trackCount}`;
      countBadge.title = `${album.trackCount} track${album.trackCount === 1 ? '' : 's'}`;
      artWrap.appendChild(countBadge);

      // Hover quick-play / shuffle overlay
      const overlay = document.createElement('div');
      overlay.className = 'album-card-overlay';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'album-overlay-play';
      playBtn.textContent = '▶';
      playBtn.title = `Play "${album.title}"`;
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playAlbumCollection(album, false);
      });

      const shuffleBtn = document.createElement('button');
      shuffleBtn.type = 'button';
      shuffleBtn.className = 'album-overlay-shuffle';
      shuffleBtn.textContent = '🔀';
      shuffleBtn.title = `Shuffle "${album.title}"`;
      shuffleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playAlbumCollection(album, true);
      });

      overlay.appendChild(playBtn);
      overlay.appendChild(shuffleBtn);
      artWrap.appendChild(overlay);

      const meta = document.createElement('div');
      meta.className = 'album-card-meta';

      const titleEl = document.createElement('div');
      titleEl.className = 'album-card-title';
      titleEl.textContent = album.title;
      titleEl.title = album.title;

      const subEl = document.createElement('div');
      subEl.className = 'album-card-sub';
      subEl.textContent = album.year ? `${album.artist} · ${album.year}` : album.artist;
      subEl.title = subEl.textContent;

      const footerRow = document.createElement('div');
      footerRow.className = 'album-card-footer';

      const techEl = document.createElement('span');
      techEl.className = 'album-card-tech';
      const fmtText = album.formats.slice(0, 2).join(' · ');
      const durText = this._formatAlbumDuration(album.totalDurationSec);
      techEl.textContent = [fmtText, durText].filter(Boolean).join(' · ') || `${album.trackCount} tracks`;

      const ratingEl = document.createElement('span');
      ratingEl.className = 'album-card-rating';
      if (album.avgStars > 0) {
        ratingEl.textContent = `★ ${album.avgStars}`;
      } else if (album.favoriteCount > 0) {
        ratingEl.textContent = `♥ ${album.favoriteCount}`;
      }

      footerRow.appendChild(techEl);
      if (ratingEl.textContent) footerRow.appendChild(ratingEl);

      meta.appendChild(titleEl);
      meta.appendChild(subEl);
      meta.appendChild(footerRow);

      card.appendChild(artWrap);
      card.appendChild(meta);

      card.addEventListener('click', () => this.openAlbumDetail(album.id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openAlbumDetail(album.id);
        }
      });

      frag.appendChild(card);
    }

    gridEl.appendChild(frag);
  }

  /**
   * Opens the Artist Detail drill-down view for a specific artist.
   * @param {string} artistId - Target artist ID.
   */
  openArtistDetail(artistId) {
    if (!artistId) return;
    this.selectedArtistId = artistId;
    this.selectedArtistReleaseId = null;
    this.applyFiltersAndRender(true);
    const activeArtist = this.artistCollections.find((a) => a.id === artistId);
    if (activeArtist) {
      this.setToast(`Opened Artist: "${activeArtist.name}" (${activeArtist.trackCount} tracks)`);
    }
  }

  /**
   * Closes Artist Detail drill-down and returns to the Artists Gallery Grid.
   */
  closeArtistDetail() {
    if (!this.selectedArtistId) return;
    this.selectedArtistId = null;
    this.selectedArtistReleaseId = null;
    this.applyFiltersAndRender(true);
    this.setToast('Showing all Artists');
  }

  /**
   * Plays an Artist collection (sequential or shuffled) and optionally starts Vibe Radio.
   * @param {object} artist - Artist descriptor.
   * @param {boolean} [shuffle=false] - Whether to shuffle playback order.
   */
  playArtistCollection(artist, shuffle = false) {
    if (!artist || !Array.isArray(artist.tracks) || !artist.tracks.length) {
      this.setToast('This artist has no playable tracks');
      return;
    }
    this.selectedArtistId = artist.id;
    this.selectedArtistReleaseId = null;
    this.applyFiltersAndRender(true);
    if (!this.displayedTracks.length) {
      this.setToast(`No matching tracks for "${artist.name}"`);
      return;
    }
    if (shuffle) {
      const btnShuffle = document.getElementById('btnShuffle');
      if (btnShuffle && !btnShuffle.classList.contains('active')) {
        btnShuffle.click();
      }
      const randIdx = Math.floor(Math.random() * this.displayedTracks.length);
      this.selectTrack(randIdx, true);
    } else {
      this.selectTrack(0, true);
    }
  }

  /**
   * Launches harmonic Vibe Radio anchored on the artist's highest-rated track.
   * @param {object} artist - Artist descriptor.
   */
  startArtistVibeRadio(artist) {
    if (!artist || !Array.isArray(artist.tracks) || !artist.tracks.length) return;
    const bestTrack = [...artist.tracks].sort(
      (a, b) => (Number(b.stars) || 0) - (Number(a.stars) || 0) || Number(Boolean(b.favorite)) - Number(Boolean(a.favorite))
    )[0];
    this.selectedArtistId = null;
    this.selectedArtistReleaseId = null;
    const audioPool = this._getTracksPoolForNav('tracks');
    const bestKey = bestTrack?.filePath || bestTrack?.id;
    const anchor = audioPool.find((t) => (t.filePath || t.id) === bestKey) || bestTrack;
    this.activeNav = 'vibe';
    document.querySelectorAll('.sidebar .nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.nav === 'vibe' || (btn.dataset.nav === 'explorer' && this.explorerOpen));
    });
    this.displayedTracks = buildVibeRadioQueue(anchor, audioPool, this.banditRewards);
    this.renderAlbumsWorkspace();
    this.renderArtistsWorkspace();
    this.renderSmartPlaylistBar();
    this.syncHeroPlaylistShowcase();
    const idx = Math.max(0, this.displayedTracks.findIndex((t) => (t.filePath || t.id) === bestKey));
    this.selectTrack(idx, true);
    this.setToast(`Vibe Radio seeded from ${artist.name}: "${anchor?.title || ''}"`);
  }

  /**
   * Renders the professional Artists Gallery Grid (circular portraits) and Discography Detail View.
   */
  renderArtistsWorkspace() {
    const workspaceEl = document.getElementById('artistsWorkspace');
    const toolbarEl = document.getElementById('artistsToolbar');
    const detailHeroEl = document.getElementById('artistsDetailHero');
    const discogEl = document.getElementById('artistDiscographyStrip');
    const gridScrollEl = document.getElementById('artistsGridScroll');
    const gridEl = document.getElementById('artistsGrid');
    const tableViewportEl = document.getElementById('rbTableViewport');
    const queueTitleEl = document.getElementById('queuePanelTitle');
    const listSortEl = document.getElementById('listSortSelect');
    const searchInputEl = document.getElementById('listSearchInput');
    if (!workspaceEl || !gridEl || !tableViewportEl) return;

    const isArtistsNav = this.activeNav === 'artists';
    workspaceEl.classList.toggle('hidden', !isArtistsNav);
    if (!isArtistsNav) {
      workspaceEl.classList.remove('albums-workspace-full');
      if (this.activeNav !== 'albums') {
        tableViewportEl.classList.remove('hidden');
        listSortEl?.classList.remove('hidden');
        if (searchInputEl) {
          searchInputEl.placeholder = 'Search title, artist, #tag, bpm:120-130, key:8A, star:4+...';
        }
      }
      return;
    }

    const audioBase = this.catalog.filter((t) => !t.isVideo || isMusicVideoTagged(t));
    const nonQueryFilters = { ...this.filterState, query: '' };
    const smartFilteredPool = applyProSmartFilter(audioBase, nonQueryFilters, audioBase[0] || null);

    const allArtists = buildArtistCollections(smartFilteredPool, {
      mode: 'all',
      query: this.filterState.query,
      sortBy: this.artistsSortBy
    });
    const modeArtists =
      this.artistsMode === 'all'
        ? allArtists
        : buildArtistCollections(smartFilteredPool, {
            mode: this.artistsMode,
            query: this.filterState.query,
            sortBy: this.artistsSortBy
          });
    this.artistCollections = modeArtists;

    const multiCount = allArtists.filter((a) => a.trackCount >= 2).length;
    const ratedCount = allArtists.filter((a) => a.avgStars > 0 || a.favoriteCount > 0).length;
    document.querySelectorAll('#artistsModeGroup [data-artist-mode]').forEach((btn) => {
      const m = btn.dataset.artistMode;
      btn.classList.toggle('active', m === this.artistsMode);
      if (m === 'all') btn.textContent = `All Artists (${allArtists.length})`;
      else if (m === 'multi') btn.textContent = `2+ Tracks (${multiCount})`;
      else if (m === 'rated') btn.textContent = `Top Rated ★ (${ratedCount})`;
    });
    document.querySelectorAll('#artistsViewGroup [data-artist-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.artistView === this.artistsViewMode);
    });
    const sortSel = document.getElementById('artistsSortSelect');
    if (sortSel && sortSel.value !== this.artistsSortBy) sortSel.value = this.artistsSortBy;

    const activeArtist = this.selectedArtistId
      ? buildArtistCollections(audioBase, { mode: 'all' }).find((a) => a.id === this.selectedArtistId) || null
      : null;
    if (this.selectedArtistId && !activeArtist) {
      this.selectedArtistId = null;
      this.selectedArtistReleaseId = null;
    }

    if (activeArtist) {
      workspaceEl.classList.remove('albums-workspace-full');
      toolbarEl?.classList.add('hidden');
      gridScrollEl?.classList.add('hidden');
      detailHeroEl?.classList.remove('hidden');
      tableViewportEl.classList.remove('hidden');
      listSortEl?.classList.remove('hidden');
      if (searchInputEl) {
        searchInputEl.placeholder = `Search inside "${activeArtist.name}"...`;
      }
      if (queueTitleEl) queueTitleEl.textContent = `Artist · ${activeArtist.name}`;

      const artHost = document.getElementById('artistDetailArt');
      const kindEl = document.getElementById('artistDetailKind');
      const nameEl = document.getElementById('artistDetailName');
      const subEl = document.getElementById('artistDetailSubtitle');
      const statsEl = document.getElementById('artistDetailStats');

      if (artHost) artHost.replaceChildren(this.buildArtistCoverElement(activeArtist, 'detail'));
      if (kindEl) {
        kindEl.textContent = activeArtist.isGeneric ? 'STUDIO COLLECTION' : 'STUDIO ARTIST';
      }
      if (nameEl) nameEl.textContent = activeArtist.name;
      if (subEl) {
        subEl.textContent = activeArtist.genres.length
          ? activeArtist.genres.join(' · ')
          : `${activeArtist.releaseCount} release${activeArtist.releaseCount === 1 ? '' : 's'} in library`;
      }
      if (statsEl) {
        statsEl.replaceChildren();
        const addPill = (text, extraClass = '') => {
          const pill = document.createElement('span');
          pill.className = `album-stat-pill${extraClass ? ` ${extraClass}` : ''}`;
          pill.textContent = text;
          statsEl.appendChild(pill);
        };
        addPill(`${activeArtist.trackCount} track${activeArtist.trackCount === 1 ? '' : 's'}`);
        addPill(`${activeArtist.releaseCount} release${activeArtist.releaseCount === 1 ? '' : 's'}`);
        const durLabel = this._formatAlbumDuration(activeArtist.totalDurationSec);
        if (durLabel) addPill(durLabel);
        if (activeArtist.avgBpm > 0) addPill(`Avg ${activeArtist.avgBpm} BPM`);
        if (activeArtist.avgStars > 0) addPill(`★ ${activeArtist.avgStars}`, 'star');
        if (activeArtist.isLossless) addPill('HI-RES LOSSLESS', 'lossless');
        else if (activeArtist.formats.length) addPill(activeArtist.formats.slice(0, 2).join(' / '));
      }

      if (discogEl) {
        discogEl.replaceChildren();
        if (activeArtist.releases.length > 0) {
          discogEl.classList.remove('hidden');
          const allChip = document.createElement('button');
          allChip.type = 'button';
          allChip.className = `artist-discog-chip${!this.selectedArtistReleaseId ? ' active' : ''}`;
          allChip.textContent = `All Releases (${activeArtist.trackCount})`;
          allChip.addEventListener('click', () => {
            this.selectedArtistReleaseId = null;
            this.applyFiltersAndRender(true);
          });
          discogEl.appendChild(allChip);

          for (const rel of activeArtist.releases) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `artist-discog-chip${this.selectedArtistReleaseId === rel.id ? ' active' : ''}`;
            chip.textContent = `${rel.title} (${rel.trackCount})`;
            chip.title = `${rel.kind === 'album' ? 'Album' : 'Folder'}: ${rel.title}`;
            chip.addEventListener('click', () => {
              this.selectedArtistReleaseId = this.selectedArtistReleaseId === rel.id ? null : rel.id;
              this.applyFiltersAndRender(true);
            });
            discogEl.appendChild(chip);
          }
        } else {
          discogEl.classList.add('hidden');
        }
      }
      return;
    }

    detailHeroEl?.classList.add('hidden');
    toolbarEl?.classList.remove('hidden');
    if (queueTitleEl) queueTitleEl.textContent = 'Artists Collection';

    if (this.artistsViewMode === 'table') {
      workspaceEl.classList.remove('albums-workspace-full');
      gridScrollEl?.classList.add('hidden');
      tableViewportEl.classList.remove('hidden');
      listSortEl?.classList.remove('hidden');
      if (searchInputEl) {
        searchInputEl.placeholder = 'Search title, artist, #tag, bpm:120-130, key:8A, star:4+...';
      }
      return;
    }

    workspaceEl.classList.add('albums-workspace-full');
    gridScrollEl?.classList.remove('hidden');
    tableViewportEl.classList.add('hidden');
    listSortEl?.classList.add('hidden');
    if (searchInputEl) {
      searchInputEl.placeholder = 'Search artists, genres, albums, or tracks...';
    }

    gridEl.replaceChildren();
    if (!modeArtists.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'albums-empty-state';
      emptyEl.textContent = 'No artists match your active search or filters.';
      gridEl.appendChild(emptyEl);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const artist of modeArtists) {
      const card = document.createElement('article');
      card.className = 'artist-card';
      card.tabIndex = 0;
      card.dataset.artistId = artist.id;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `${artist.name}, ${artist.trackCount} tracks`);

      const artWrap = document.createElement('div');
      artWrap.className = 'artist-card-art';
      artWrap.appendChild(this.buildArtistCoverElement(artist, 'card'));

      const overlay = document.createElement('div');
      overlay.className = 'artist-card-overlay';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'album-overlay-play';
      playBtn.textContent = '▶';
      playBtn.title = `Play ${artist.name}`;
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playArtistCollection(artist, false);
      });

      const shuffleBtn = document.createElement('button');
      shuffleBtn.type = 'button';
      shuffleBtn.className = 'album-overlay-shuffle';
      shuffleBtn.textContent = '🔀';
      shuffleBtn.title = `Shuffle ${artist.name}`;
      shuffleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.playArtistCollection(artist, true);
      });

      overlay.appendChild(playBtn);
      overlay.appendChild(shuffleBtn);
      artWrap.appendChild(overlay);

      const meta = document.createElement('div');
      meta.className = 'artist-card-meta';

      const nameEl = document.createElement('div');
      nameEl.className = 'artist-card-name';
      nameEl.textContent = artist.name;
      nameEl.title = artist.name;

      const subEl = document.createElement('div');
      subEl.className = 'artist-card-sub';
      const relPart = `${artist.releaseCount} release${artist.releaseCount === 1 ? '' : 's'}`;
      const trkPart = `${artist.trackCount} track${artist.trackCount === 1 ? '' : 's'}`;
      subEl.textContent = artist.primaryGenre ? `${artist.primaryGenre} · ${trkPart}` : `${trkPart} · ${relPart}`;
      subEl.title = `${trkPart} · ${relPart}`;

      const footerRow = document.createElement('div');
      footerRow.className = 'artist-card-footer';

      const techEl = document.createElement('span');
      techEl.className = 'album-card-tech';
      techEl.textContent = artist.isLossless ? 'LOSSLESS' : (artist.formats.slice(0, 2).join(' · ') || 'AUDIO');
      footerRow.appendChild(techEl);

      if (artist.avgStars > 0) {
        const ratingEl = document.createElement('span');
        ratingEl.className = 'album-card-rating';
        ratingEl.textContent = `★ ${artist.avgStars}`;
        footerRow.appendChild(ratingEl);
      } else if (artist.favoriteCount > 0) {
        const favEl = document.createElement('span');
        favEl.className = 'album-card-rating';
        favEl.textContent = `♥ ${artist.favoriteCount}`;
        footerRow.appendChild(favEl);
      }

      meta.appendChild(nameEl);
      meta.appendChild(subEl);
      meta.appendChild(footerRow);

      card.appendChild(artWrap);
      card.appendChild(meta);

      card.addEventListener('click', () => this.openArtistDetail(artist.id));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openArtistDetail(artist.id);
        }
      });

      frag.appendChild(card);
    }

    gridEl.appendChild(frag);
  }

  /**
   * Builds a crisp playlist artwork box supporting custom images, 8 studio presets,
   * and automatic 2x2 mosaic collages from matching catalog tracks.
   * @param {object} ruleOrDraft - Rule or draft object { name, visual }.
   * @param {object[]} [matchingTracks=[]] - Tracks matching the rule for Auto Collage.
   * @param {'sm'|'md'|'lg'} [sizeClass='sm'] - Visual container size token.
   * @returns {HTMLElement}
   */
  buildPlaylistCoverElement(ruleOrDraft, matchingTracks = [], sizeClass = 'sm') {
    const box = document.createElement('div');
    box.className = `playlist-cover ${sizeClass}`;

    const visual = ruleOrDraft?.visual && typeof ruleOrDraft.visual === 'object'
      ? ruleOrDraft.visual
      : { mode: 'auto', presetKey: 'synth', imagePath: '' };

    const applyPresetFallback = (preferredKey) => {
      box.replaceChildren();
      let preset = PLAYLIST_VISUAL_PRESETS.find((p) => p.key === preferredKey);
      if (!preset) {
        const nameStr = String(ruleOrDraft?.name || 'V');
        let hash = 0;
        for (let i = 0; i < nameStr.length; i++) hash = (hash * 31 + nameStr.charCodeAt(i)) >>> 0;
        preset = PLAYLIST_VISUAL_PRESETS[hash % PLAYLIST_VISUAL_PRESETS.length];
      }
      box.style.background = preset.grad;
      const iconEl = document.createElement('span');
      iconEl.textContent = preset.icon;
      box.appendChild(iconEl);
    };

    if (visual.mode === 'image' && visual.imagePath) {
      const img = document.createElement('img');
      img.alt = `${ruleOrDraft?.name || 'Playlist'} cover`;
      img.draggable = false;
      img.src = `vanta-media://local?path=${encodeURIComponent(visual.imagePath)}`;
      img.addEventListener('error', () => applyPresetFallback(visual.presetKey));
      box.appendChild(img);
      return box;
    }

    if (visual.mode === 'preset') {
      applyPresetFallback(visual.presetKey);
      return box;
    }

    // Auto mode: use unique track cover art (1 full image or 2x2 mosaic), else studio monogram/preset
    const uniqueCovers = [];
    const seen = new Set();
    for (const t of matchingTracks) {
      const cover = this._getTrackCoverSrc(t);
      if (cover && !seen.has(cover)) {
        seen.add(cover);
        uniqueCovers.push(cover);
        if (uniqueCovers.length >= 4) break;
      }
    }

    if (uniqueCovers.length === 1) {
      const img = document.createElement('img');
      img.alt = `${ruleOrDraft?.name || 'Playlist'} cover`;
      img.draggable = false;
      img.src = uniqueCovers[0];
      box.appendChild(img);
      return box;
    }

    if (uniqueCovers.length >= 2) {
      const mosaic = document.createElement('div');
      mosaic.className = 'playlist-cover-mosaic';
      const tiles = uniqueCovers.length === 2
        ? [uniqueCovers[0], uniqueCovers[1], uniqueCovers[1], uniqueCovers[0]]
        : uniqueCovers.length === 3
          ? [uniqueCovers[0], uniqueCovers[1], uniqueCovers[2], uniqueCovers[0]]
          : uniqueCovers;
      for (const src of tiles) {
        const tile = document.createElement('div');
        tile.className = 'playlist-cover-mosaic-tile';
        tile.style.backgroundImage = `url("${src}")`;
        mosaic.appendChild(tile);
      }
      box.appendChild(mosaic);
      return box;
    }

    applyPresetFallback(null);
    return box;
  }

  /**
   * Evaluates either a flat Smart Rule (`kind === 'rule'`) or a DAG Flow (`kind === 'flow'`).
   * @param {object} playlist - Saved Smart Playlist or Flow descriptor.
   * @param {object|null} [anchorOverride=null] - Optional anchor track for harmonic/vibe references.
   * @returns {object[]} Matching/ordered track array.
   */
  evaluateSmartPlaylistTracks(playlist, anchorOverride = null) {
    if (!playlist) return [];
    const anchor = anchorOverride || this.currentLoadedTrack || this.catalog[0] || null;
    if (playlist.kind === 'flow') {
      const res = executeFlowGraph(playlist, {
        catalog: this.catalog,
        anchorTrack: anchor,
        banditRewards: this.banditRewards,
        playbackHistory: this.playbackHistory,
        currentQueue: this.displayedTracks,
        smartPlaylists: this.smartPlaylists
      });
      return Array.isArray(res.outputTracks) ? res.outputTracks : [];
    }
    return applyProSmartFilter(this.catalog, this.normalizeRuleFilters(playlist.filters), anchor);
  }

  /**
   * Exports a Flow or Smart Playlist track array to a UTF-8 `.m3u8` file via secure Main Process dialog.
   * @param {object[]} [tracks=[]] - Tracks to export.
   * @param {string} [playlistName='VANTA_Flow'] - Suggested playlist title.
   */
  async exportPlaylistM3u8(tracks = [], playlistName = 'VANTA_Flow') {
    if (!window.vantaAPI?.exportFlowM3u8) {
      this.setToast('M3U8 export requires the VANTA desktop runtime');
      return;
    }
    if (!Array.isArray(tracks) || !tracks.length) {
      this.setToast('No tracks available to export');
      return;
    }
    const slimTracks = tracks.map((t) => ({
      filePath: t.filePath || '',
      title: t.title || '',
      artist: t.artist || '',
      fileName: t.fileName || '',
      durationSec: Number(t.durationSec) || 0
    }));
    const res = await window.vantaAPI.exportFlowM3u8({
      playlistName,
      tracks: slimTracks
    });
    if (res?.canceled) return;
    if (!res?.ok) {
      this.setToast(`Export failed: ${res?.error || 'Could not save .m3u8'}`);
      return;
    }
    const fileLabel = String(res.filePath || '').split(/[\\/]/).pop() || 'playlist.m3u8';
    this.setToast(`Exported ${res.exportedCount} track${res.exportedCount === 1 ? '' : 's'} to ${fileLabel}`);
  }

  /**
   * Synchronizes the top Hero banner artwork, title, description, and Play/Shuffle controls
   * whenever a Smart Playlist rule is active in the Playlists workspace.
   */
  syncHeroPlaylistShowcase() {
    const artHost = document.getElementById('heroPlaylistArt');
    const actionsHost = document.getElementById('heroPlaylistActions');
    const badgeEl = document.getElementById('heroModuleBadge');
    const headlineEl = document.getElementById('heroHeadline');
    const descEl = document.getElementById('heroDescription');
    if (!artHost || !actionsHost || !headlineEl || !descEl) return;

    const activeRule = this.activeNav === 'playlists' && this.activeSmartPlaylistId
      ? this.smartPlaylists.find((p) => p.id === this.activeSmartPlaylistId)
      : null;

    if (!activeRule) {
      artHost.classList.add('hidden');
      artHost.replaceChildren();
      actionsHost.classList.add('hidden');
      if (this.activeNav === 'playlists') {
        if (badgeEl) badgeEl.textContent = 'USER-DEFINED SMART PLAYLISTS';
        headlineEl.replaceChildren();
        headlineEl.append('Smart Playlists: ');
        const grad = document.createElement('span');
        grad.className = 'grad-text';
        grad.textContent = `${this.smartPlaylists.length} Custom Rule${this.smartPlaylists.length === 1 ? '' : 's'}`;
        headlineEl.appendChild(grad);
        const names = (this.smartPlaylists || []).map((p) => p.name).join(' · ');
        descEl.textContent = names || 'No rules defined yet. Click "+ New Rule" or "⚡ Flow Studio" below.';
      }
      return;
    }

    const matchingTracks = this.evaluateSmartPlaylistTracks(activeRule);
    artHost.replaceChildren(this.buildPlaylistCoverElement(activeRule, matchingTracks, 'lg'));
    artHost.classList.remove('hidden');
    actionsHost.classList.remove('hidden');

    const isFlow = activeRule.kind === 'flow';
    if (badgeEl) badgeEl.textContent = `${isFlow ? 'FLOW PLAYLIST' : 'SMART PLAYLIST'} • ${matchingTracks.length} TRACKS`;
    headlineEl.replaceChildren();
    headlineEl.append('Playlist: ');
    const gradName = document.createElement('span');
    gradName.className = 'grad-text';
    gradName.textContent = activeRule.name;
    headlineEl.appendChild(gradName);

    const ruleSummary = isFlow
      ? `${Object.keys(activeRule.graph?.nodes || {}).length} nodes · ${activeRule.graph?.edges?.length || 0} wires`
      : this.formatRuleSummary(activeRule.filters);
    descEl.textContent = activeRule.description
      ? `${activeRule.description}${ruleSummary ? ` · ${ruleSummary}` : ''}`
      : (ruleSummary || `${matchingTracks.length} matching tracks`);
  }

  /**
   * Applies a Smart Playlist rule or Flow Playlist and immediately starts playing.
   * @param {object} rule - Target Smart Playlist rule or flow.
   * @param {boolean} [shuffle=false] - Whether to randomize starting track and enable shuffle.
   */
  playSmartPlaylistRule(rule, shuffle = false) {
    if (!rule) return;
    if (this.activeSmartPlaylistId !== rule.id) {
      this.applySmartPlaylistRule(rule);
    }
    if (!this.displayedTracks.length) {
      this.setToast(`"${rule.name}" has no matching tracks yet`);
      return;
    }
    if (shuffle) {
      const btnShuffle = document.getElementById('btnShuffle');
      if (btnShuffle && !btnShuffle.classList.contains('active')) {
        btnShuffle.click();
      }
      const randIdx = Math.floor(Math.random() * this.displayedTracks.length);
      this.selectTrack(randIdx, true);
    } else {
      this.selectTrack(0, true);
    }
  }

  /**
   * Loads an ad-hoc tracklist previewed inside Flow Studio into the active queue and starts playback.
   * @param {object[]} tracks - Flow output tracks.
   * @param {string} [title='Flow Preview'] - Label for toast notification.
   */
  playAdHocFlowPreview(tracks = [], title = 'Flow Preview') {
    if (!Array.isArray(tracks) || !tracks.length) {
      this.setToast(`"${title}" produced 0 tracks`);
      return;
    }
    this.displayedTracks = [...tracks];
    this.activeTrackIndex = 0;
    const matchBadge = document.getElementById('listMatchCount');
    if (matchBadge) {
      matchBadge.textContent = `${this.displayedTracks.length} / ${this.catalog.length} tracks`;
    }
    this.renderQueue();
    this.selectTrack(0, true);
    this.setToast(`Playing Flow output: "${title}" (${tracks.length} tracks)`);
  }

  /**
   * Loads a saved Smart Playlist rule or Flow Playlist into the queue and updates active showcase.
   * @param {object} rule - Smart playlist rule or flow object.
   */
  applySmartPlaylistRule(rule) {
    if (!rule) return;
    this.activeSmartPlaylistId = rule.id;
    if (rule.kind === 'flow') {
      this.filterState = {
        query: '',
        minBpm: '',
        maxBpm: '',
        key: 'ALL',
        energyBand: 'ALL',
        exactStars: 0,
        tags: [],
        groups: [],
        favoriteOnly: false,
        sortBy: 'default'
      };
    } else {
      this.filterState = { ...this.normalizeRuleFilters(rule.filters) };
    }

    this._syncFilterBarDomFromState();
    this.renderTagFilterOptions();
    this.applyFiltersAndRender(true);
    this.renderSmartPlaylistBar();
    this.syncHeroPlaylistShowcase();
    this.setToast(`Applied ${rule.kind === 'flow' ? 'Flow' : 'Smart'} Playlist: "${rule.name}" (${this.displayedTracks.length} matches)`);
  }

  /**
   * Clears the currently applied Smart Playlist rule and resets filters back to full catalog.
   */
  clearActiveSmartRule() {
    this.activeSmartPlaylistId = null;
    this.filterState = {
      query: '',
      minBpm: '',
      maxBpm: '',
      key: 'ALL',
      energyBand: 'ALL',
      exactStars: 0,
      tags: [],
      groups: [],
      favoriteOnly: false,
      sortBy: 'default'
    };
    this._syncFilterBarDomFromState();
    this.renderTagFilterOptions();
    this.applyFiltersAndRender(true);
    this.renderSmartPlaylistBar();
    this.syncHeroPlaylistShowcase();
    this.setToast('Showing all tracks');
  }

  _syncFilterBarDomFromState() {
    const f = this.filterState;
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    setVal('listSearchInput', f.query || '');
    setVal('filterBpmMin', f.minBpm || '');
    setVal('filterBpmMax', f.maxBpm || '');
    setVal('filterKeySelect', f.key || 'ALL');
    setVal('filterEnergySelect', f.energyBand || 'ALL');
    setVal('filterStarsSelect', String(f.exactStars || 0));
    setVal('listSortSelect', f.sortBy || 'default');

    const favFilterBtn = document.getElementById('btnFilterFavorites');
    if (favFilterBtn) {
      favFilterBtn.classList.toggle('active', Boolean(f.favoriteOnly));
      favFilterBtn.setAttribute('aria-pressed', String(Boolean(f.favoriteOnly)));
      favFilterBtn.querySelector('svg')?.setAttribute('fill', f.favoriteOnly ? 'currentColor' : 'none');
    }
  }

  /**
   * Opens the Smart Playlist Rule Editor modal for either creating a new rule or editing an existing one.
   * @param {object|null} [existingRule=null] - Existing rule to edit, or null for creation.
   */
  openSmartRuleModal(existingRule = null) {
    const modal = document.getElementById('smartRuleModal');
    if (!modal) return;

    this.editingSmartRuleId = existingRule ? existingRule.id : null;
    const titleEl = document.getElementById('smartRuleModalTitle');
    const saveBtn = document.getElementById('btnSaveSmartRule');
    if (titleEl) titleEl.textContent = existingRule ? 'Edit Smart Playlist Rule' : 'New Smart Playlist Rule';
    if (saveBtn) saveBtn.textContent = existingRule ? 'Update Rule' : 'Save Rule';

    const seed = existingRule
      ? this.normalizeRuleFilters(existingRule.filters)
      : this.normalizeRuleFilters(this.filterState);

    const defaultName = existingRule
      ? existingRule.name
      : this.formatRuleSummary(seed);

    const setElVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    setElVal('smartRuleNameInput', defaultName);
    setElVal('smartRuleDescInput', existingRule?.description || '');
    setElVal('ruleBpmMin', seed.minBpm || '');
    setElVal('ruleBpmMax', seed.maxBpm || '');
    setElVal('ruleKeySelect', seed.key || 'ALL');
    setElVal('ruleEnergySelect', seed.energyBand || 'ALL');
    setElVal('ruleStarsSelect', String(seed.exactStars || 0));
    setElVal('ruleSortSelect', seed.sortBy || 'default');
    setElVal('ruleTagsInput', (seed.tags || []).join(', '));
    setElVal('ruleGroupsInput', (seed.groups || []).join(', '));
    const favCheck = document.getElementById('ruleFavoriteOnly');
    if (favCheck) favCheck.checked = Boolean(seed.favoriteOnly);

    this.draftRuleVisual = existingRule?.visual && typeof existingRule.visual === 'object'
      ? {
          mode: existingRule.visual.mode || 'auto',
          presetKey: existingRule.visual.presetKey || 'synth',
          imagePath: existingRule.visual.imagePath || ''
        }
      : { mode: 'auto', presetKey: 'synth', imagePath: '' };

    this._renderCoverSwatches();
    this._renderRuleModalSuggestChips('ruleExistingTagsChips', 'ruleTagsInput', this.collectUniqueMeta('tags'), '#');
    this._renderRuleModalSuggestChips('ruleExistingGroupsChips', 'ruleGroupsInput', this.collectUniqueMeta('groups'), '');
    this._updateSmartRulePreview();

    modal.classList.remove('hidden');
    document.getElementById('smartRuleNameInput')?.focus();
  }

  _renderCoverSwatchesInto(host, draftVisual, onSelect) {
    if (!host) return;
    host.replaceChildren();

    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = `cover-swatch-btn auto-swatch${draftVisual.mode === 'auto' ? ' active' : ''}`;
    autoBtn.textContent = 'Auto 2×2';
    autoBtn.title = 'Automatic 2×2 collage from matching track covers';
    autoBtn.addEventListener('click', () => {
      onSelect({ ...draftVisual, mode: 'auto', imagePath: '' });
    });
    host.appendChild(autoBtn);

    for (const preset of PLAYLIST_VISUAL_PRESETS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isSelected = draftVisual.mode === 'preset' && draftVisual.presetKey === preset.key;
      btn.className = `cover-swatch-btn${isSelected ? ' active' : ''}`;
      btn.style.background = preset.grad;
      btn.textContent = preset.icon;
      btn.title = preset.label;
      btn.addEventListener('click', () => {
        onSelect({ mode: 'preset', presetKey: preset.key, imagePath: '' });
      });
      host.appendChild(btn);
    }
  }

  _renderCoverSwatches() {
    const host = document.getElementById('ruleCoverSwatches');
    this._renderCoverSwatchesInto(host, this.draftRuleVisual, (nextVisual) => {
      this.draftRuleVisual = nextVisual;
      this._renderCoverSwatches();
      this._updateSmartRulePreview();
    });
  }

  _renderRuleModalSuggestChips(containerId, inputId, values, prefix) {
    const box = document.getElementById(containerId);
    const inputEl = document.getElementById(inputId);
    if (!box || !inputEl) return;
    box.replaceChildren();
    for (const val of values.slice(0, 12)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'smart-suggest-chip';
      chip.textContent = `${prefix}${val}`;
      chip.addEventListener('click', () => {
        const current = inputEl.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const idx = current.findIndex((s) => s.toLowerCase() === val.toLowerCase());
        if (idx >= 0) current.splice(idx, 1);
        else current.push(val);
        inputEl.value = current.join(', ');
        this._updateSmartRulePreview();
      });
      box.appendChild(chip);
    }
  }

  _readDraftRuleFromModal() {
    const parseCsv = (id) =>
      String(document.getElementById(id)?.value || '')
        .split(',')
        .map((s) => s.trim().replace(/^#/, ''))
        .filter(Boolean);

    return {
      name: String(document.getElementById('smartRuleNameInput')?.value || '').trim().replace(/\s+/g, ' '),
      description: String(document.getElementById('smartRuleDescInput')?.value || '').trim().slice(0, 120),
      visual: { ...this.draftRuleVisual },
      filters: {
        query: '',
        minBpm: String(document.getElementById('ruleBpmMin')?.value || '').trim(),
        maxBpm: String(document.getElementById('ruleBpmMax')?.value || '').trim(),
        key: document.getElementById('ruleKeySelect')?.value || 'ALL',
        energyBand: document.getElementById('ruleEnergySelect')?.value || 'ALL',
        exactStars: Number(document.getElementById('ruleStarsSelect')?.value) || 0,
        tags: parseCsv('ruleTagsInput'),
        groups: parseCsv('ruleGroupsInput'),
        favoriteOnly: Boolean(document.getElementById('ruleFavoriteOnly')?.checked),
        sortBy: document.getElementById('ruleSortSelect')?.value || 'default'
      }
    };
  }

  _isDuplicateSmartPlaylistName(name, ignoreId = null) {
    const target = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!target) return false;
    return (this.smartPlaylists || []).some(
      (p) => p.id !== ignoreId && String(p.name || '').trim().replace(/\s+/g, ' ').toLowerCase() === target
    );
  }

  _updateSmartRulePreview() {
    const draft = this._readDraftRuleFromModal();
    const previewEl = document.getElementById('smartRulePreviewBanner');
    const valEl = document.getElementById('smartRuleValidationMsg');
    const saveBtn = document.getElementById('btnSaveSmartRule');

    const matches = applyProSmartFilter(this.catalog, draft.filters, this.catalog[0] || null);
    if (previewEl) {
      previewEl.textContent = `Matches ${matches.length} track${matches.length === 1 ? '' : 's'} right now`;
    }

    const coverPreview = document.getElementById('smartRuleCoverPreview');
    if (coverPreview) {
      coverPreview.replaceChildren(
        this.buildPlaylistCoverElement({ name: draft.name || 'Playlist', visual: this.draftRuleVisual }, matches, 'md')
      );
    }

    const hasCriterion = this.hasAnyRuleCriterion(draft.filters);
    let err = '';
    if (!hasCriterion) {
      err = 'Select at least one filter criterion (BPM, Key, Energy, Rating, Tag, Group, or Favorites ♥).';
    } else if (!draft.name) {
      err = 'Enter a name for this Smart Playlist rule.';
    } else if (this._isDuplicateSmartPlaylistName(draft.name, this.editingSmartRuleId)) {
      err = `A playlist named "${draft.name}" already exists. Choose a unique name.`;
    }

    if (valEl) {
      valEl.textContent = err;
      valEl.classList.toggle('hidden', !err);
    }
    if (saveBtn) saveBtn.disabled = Boolean(err);
  }

  /**
   * Shared persistence helper for both rule-based Smart Playlists and DAG Flow Playlists.
   * @param {object} playlistObj - Normalized playlist object (`kind: 'rule' | 'flow'`).
   * @param {boolean} isEdit - Whether updating an existing playlist.
   * @param {string} [validationElId='smartRuleValidationMsg'] - Validation error element ID.
   * @returns {Promise<boolean>} True on save success.
   */
  async saveSmartPlaylistObject(playlistObj, isEdit, validationElId = 'smartRuleValidationMsg') {
    if (window.vantaAPI?.saveSmartPlaylist) {
      const res = await window.vantaAPI.saveSmartPlaylist(playlistObj);
      if (!res?.ok) {
        const valEl = document.getElementById(validationElId);
        if (valEl) {
          valEl.textContent = res?.error || 'Could not save playlist.';
          valEl.classList.remove('hidden');
        }
        return false;
      }
      if (Array.isArray(res.smartPlaylists)) {
        this.smartPlaylists = res.smartPlaylists;
      }
    } else {
      const idx = this.smartPlaylists.findIndex((p) => p.id === playlistObj.id);
      if (idx >= 0) this.smartPlaylists[idx] = playlistObj;
      else this.smartPlaylists.push(playlistObj);
    }

    this.updateSidebarBadges();
    this.renderSmartPlaylistBar();
    if (isEdit && this.activeSmartPlaylistId === playlistObj.id) {
      this.applySmartPlaylistRule(playlistObj);
    } else {
      this.syncHeroPlaylistShowcase();
    }
    const label = playlistObj.kind === 'flow' ? 'Flow Playlist' : 'Smart Playlist';
    this.setToast(`${isEdit ? 'Updated' : 'Saved'} ${label}: "${playlistObj.name}"`);
    return true;
  }

  /**
   * Saves a created or edited Smart Playlist rule persistently and updates UI state.
   */
  async saveSmartRuleFromModal() {
    if (this._isSavingSmartRule) return;
    const draft = this._readDraftRuleFromModal();
    if (
      !draft.name ||
      !this.hasAnyRuleCriterion(draft.filters) ||
      this._isDuplicateSmartPlaylistName(draft.name, this.editingSmartRuleId)
    ) {
      this._updateSmartRulePreview();
      return;
    }

    this._isSavingSmartRule = true;
    const saveBtn = document.getElementById('btnSaveSmartRule');
    if (saveBtn) saveBtn.disabled = true;

    const isEdit = Boolean(this.editingSmartRuleId);
    const playlistObj = {
      id: this.editingSmartRuleId || `sp-${Date.now()}`,
      kind: 'rule',
      name: draft.name,
      description: draft.description,
      visual: draft.visual,
      filters: draft.filters
    };

    try {
      const ok = await this.saveSmartPlaylistObject(playlistObj, isEdit, 'smartRuleValidationMsg');
      if (ok) {
        document.getElementById('smartRuleModal')?.classList.add('hidden');
        this.editingSmartRuleId = null;
      }
    } finally {
      this._isSavingSmartRule = false;
    }
  }

  /**
   * Deletes a Smart Playlist rule permanently without touching tracks on disk.
   * @param {string} ruleId - Rule identifier to delete.
   */
  async deleteSmartPlaylist(ruleId) {
    const target = this.smartPlaylists.find((p) => p.id === ruleId);
    if (window.vantaAPI?.deleteSmartPlaylist) {
      const res = await window.vantaAPI.deleteSmartPlaylist(ruleId);
      if (res?.ok && Array.isArray(res.smartPlaylists)) {
        this.smartPlaylists = res.smartPlaylists;
      }
    } else {
      this.smartPlaylists = this.smartPlaylists.filter((p) => p.id !== ruleId);
    }

    const wasActive = this.activeSmartPlaylistId === ruleId;
    if (wasActive) {
      this.clearActiveSmartRule();
    } else {
      this.renderSmartPlaylistBar();
      this.syncHeroPlaylistShowcase();
    }
    this.updateSidebarBadges();
    this.setToast(`Deleted Smart Playlist${target ? `: "${target.name}"` : ''}`);
  }

  /**
   * Toggles the Split Computer Explorer pane beside Library & Vault Queue.
   * @param {boolean} [forceState] - Optional explicit open/close boolean.
   */
  async toggleComputerExplorer(forceState) {
    this.explorerOpen = typeof forceState === 'boolean' ? forceState : !this.explorerOpen;
    const splitStage = document.getElementById('centerSplitStage');
    const paneEl = document.getElementById('computerExplorerPane');
    const navBtn = document.getElementById('btnNavComputerExplorer');

    paneEl?.classList.toggle('hidden', !this.explorerOpen);
    splitStage?.classList.toggle('split-active', this.explorerOpen);
    navBtn?.classList.toggle('active', this.explorerOpen);

    if (this.explorerOpen) {
      if (!this.explorerRoots.length) {
        await this.loadComputerRoots();
      } else {
        await this.refreshComputerExplorer(true);
      }
    }
    this.setToast(this.explorerOpen ? 'Computer Explorer Open — drag folders or tracks into the playlist' : 'Computer Explorer Closed');
  }

  /**
   * Forces a live disk refresh of Computer Explorer roots and every currently expanded folder.
   * @param {boolean} [quiet=false] - Suppress toast notification when auto-refreshing on open.
   */
  async refreshComputerExplorer(quiet = false) {
    if (!window.vantaAPI?.getComputerRoots) return;
    this.dirEntriesCache.clear();
    const [roots, hiddenDirs] = await Promise.all([
      window.vantaAPI.getComputerRoots(),
      window.vantaAPI.getHiddenExplorerDirs ? window.vantaAPI.getHiddenExplorerDirs() : []
    ]);
    this.explorerRoots = Array.isArray(roots) ? roots : [];
    this.hiddenExplorerDirs = Array.isArray(hiddenDirs) ? hiddenDirs : [];
    this.renderHiddenDirsManager();

    const expandedList = Array.from(this.expandedDirs);
    await Promise.all(
      expandedList.map(async (dirPath) => {
        const res = await window.vantaAPI.listDir(dirPath).catch(() => null);
        this.dirEntriesCache.set(dirPath, Array.isArray(res?.entries) ? res.entries : []);
      })
    );
    this.renderComputerTree();
    if (!quiet) {
      this.setToast('Computer Explorer refreshed from disk');
    }
  }

  /**
   * Fetches top-level quick folders and mounted Windows drives and renders quick-access chips.
   */
  async loadComputerRoots() {
    if (!window.vantaAPI?.getComputerRoots) return;
    const [roots, hiddenDirs] = await Promise.all([
      window.vantaAPI.getComputerRoots(),
      window.vantaAPI.getHiddenExplorerDirs ? window.vantaAPI.getHiddenExplorerDirs() : []
    ]);
    this.explorerRoots = Array.isArray(roots) ? roots : [];
    this.hiddenExplorerDirs = Array.isArray(hiddenDirs) ? hiddenDirs : [];
    this.renderHiddenDirsManager();

    // Expand Music quick folder by default if present, otherwise first visible root
    const hiddenSet = new Set(this.hiddenExplorerDirs.map((p) => String(p || '').toLowerCase()));
    const visibleRoots = this.explorerRoots.filter((r) => !hiddenSet.has(r.path.toLowerCase()));
    const initialRoot = visibleRoots.find((r) => r.id === 'quick-music') || visibleRoots[0];
    if (initialRoot) {
      this.expandedDirs.add(initialRoot.path);
      await this.loadDirEntries(initialRoot.path);
    } else {
      this.renderComputerTree();
    }
  }

  /**
   * Lazy-loads a single directory depth via IPC and refreshes the Computer Explorer tree.
   * @param {string} dirPath - Directory path to inspect.
   */
  async loadDirEntries(dirPath, forceRefresh = false) {
    if (!dirPath || !window.vantaAPI?.listDir) return;
    if (forceRefresh || !this.dirEntriesCache.has(dirPath)) {
      const res = await window.vantaAPI.listDir(dirPath);
      this.dirEntriesCache.set(dirPath, Array.isArray(res?.entries) ? res.entries : []);
    }
    this.renderComputerTree();
  }

  /**
   * Expands or collapses a folder node in the Computer Explorer tree.
   * @param {string} dirPath - Folder path to toggle.
   */
  async toggleFolderNode(dirPath) {
    if (this.expandedDirs.has(dirPath)) {
      this.expandedDirs.delete(dirPath);
      this.renderComputerTree();
    } else {
      this.expandedDirs.add(dirPath);
      await this.loadDirEntries(dirPath, true);
    }
  }

  /**
   * Collects flattened visible tree nodes matching the optional live filter query.
   */
  _collectVisibleTreeNodes(entries, depth, filterLower, outList) {
    for (const entry of entries) {
      const nameMatches = !filterLower || entry.name.toLowerCase().includes(filterLower);
      if (entry.type === 'folder') {
        const isExpanded = this.expandedDirs.has(entry.path);
        const childEntries = isExpanded ? (this.dirEntriesCache.get(entry.path) || []) : [];
        const childMatches = [];
        if (isExpanded) {
          this._collectVisibleTreeNodes(childEntries, depth + 1, filterLower, childMatches);
        }
        if (nameMatches || childMatches.length > 0) {
          outList.push({
            path: entry.path,
            name: entry.name,
            type: 'folder',
            kind: entry.kind || 'folder',
            depth,
            expanded: isExpanded,
            emptyExpanded: isExpanded && childEntries.length === 0 && !filterLower
          });
          outList.push(...childMatches);
        }
      } else if (nameMatches) {
        outList.push({
          path: entry.path,
          name: entry.name,
          type: 'file',
          kind: 'file',
          ext: entry.ext || 'AUDIO',
          isVideo: Boolean(entry.isVideo),
          depth
        });
      }
    }
  }

  /**
   * Safely builds and renders the Computer Explorer tree using createElement/textContent only.
   */
  renderComputerTree() {
    const container = document.getElementById('computerTreeRoot');
    if (!container) return;

    const filterLower = String(this.explorerFilterQuery || '').trim().toLowerCase();
    const hiddenSet = new Set((this.hiddenExplorerDirs || []).map((p) => String(p || '').toLowerCase()));
    const flatNodes = [];

    for (const root of this.explorerRoots) {
      if (root.kind !== 'drive' && hiddenSet.has(root.path.toLowerCase())) continue;
      const isExpanded = this.expandedDirs.has(root.path);
      const childEntries = isExpanded ? (this.dirEntriesCache.get(root.path) || []) : [];
      const childMatches = [];
      if (isExpanded) {
        this._collectVisibleTreeNodes(childEntries, 1, filterLower, childMatches);
      }
      const rootMatches = !filterLower || root.label.toLowerCase().includes(filterLower);
      if (rootMatches || childMatches.length > 0) {
        flatNodes.push({
          path: root.path,
          name: root.label,
          type: 'folder',
          kind: root.kind,
          depth: 0,
          expanded: isExpanded,
          emptyExpanded: isExpanded && childEntries.length === 0 && !filterLower
        });
        flatNodes.push(...childMatches);
      }
    }

    this.visibleTreeNodes = flatNodes;
    container.replaceChildren();

    if (!flatNodes.length) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'tree-empty-note';
      emptyEl.textContent = filterLower ? 'No matching folders or media tracks found.' : 'No drives or media roots detected.';
      container.appendChild(emptyEl);
      this._updateExplorerSelectionControls();
      return;
    }

    const svgNs = 'http://www.w3.org/2000/svg';
    const makeIcon = (kind) => {
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      svg.setAttribute('stroke-width', '2');
      const p = document.createElementNS(svgNs, 'path');
      if (kind === 'drive') {
        svg.setAttribute('stroke', '#38bdf8');
        p.setAttribute('d', 'M4 6h16v12H4zM4 14h16M8 10h.01');
      } else if (kind === 'folder' || kind === 'special') {
        svg.setAttribute('stroke', '#fbbf24');
        p.setAttribute('d', 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z');
      } else {
        svg.setAttribute('stroke', '#34d399');
        p.setAttribute('d', 'M9 18V5l12-2v13M6 18a3 3 0 1 0 3-3 3 3 0 0 0-3 3zm12-2a3 3 0 1 0 3-3 3 3 0 0 0-3 3z');
      }
      svg.appendChild(p);
      return svg;
    };

    const frag = document.createDocumentFragment();
    for (const node of flatNodes) {
      const row = document.createElement('div');
      row.className = `tree-row${this.selectedTreePaths.has(node.path) ? ' selected' : ''}`;
      row.style.paddingLeft = `${8 + node.depth * 14}px`;
      row.draggable = true;
      row.title = node.path;
      row.dataset.path = node.path;

      if (node.type === 'folder') {
        const chev = document.createElement('span');
        chev.className = 'tree-chevron';
        chev.textContent = node.expanded ? '▾' : '▸';
        chev.addEventListener('click', (e) => {
          e.stopPropagation();
          void this.toggleFolderNode(node.path).catch(() => {});
        });
        row.appendChild(chev);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'tree-chevron';
        row.appendChild(spacer);
      }

      const iconWrap = document.createElement('span');
      iconWrap.className = 'tree-icon';
      iconWrap.appendChild(makeIcon(node.type === 'folder' ? node.kind : 'file'));
      row.appendChild(iconWrap);

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      row.appendChild(label);

      if (node.type === 'file') {
        const extBadge = document.createElement('span');
        extBadge.className = 'tree-ext-badge';
        extBadge.textContent = node.ext;
        row.appendChild(extBadge);
      }

      const quickAdd = document.createElement('button');
      quickAdd.type = 'button';
      quickAdd.className = 'tree-quick-add';
      quickAdd.textContent = '+';
      quickAdd.title = node.type === 'folder' ? 'Add folder to playlist' : 'Add track to playlist';
      quickAdd.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.addPathsToPlaylist([node.path], false);
      });
      row.appendChild(quickAdd);

      if (node.type === 'folder' && node.kind !== 'drive') {
        const hideBtn = document.createElement('button');
        hideBtn.type = 'button';
        hideBtn.className = 'tree-hide-btn';
        hideBtn.title = 'Hide folder from Computer Explorer';
        const eyeSvg = document.createElementNS(svgNs, 'svg');
        eyeSvg.setAttribute('viewBox', '0 0 24 24');
        eyeSvg.setAttribute('fill', 'none');
        eyeSvg.setAttribute('stroke', 'currentColor');
        eyeSvg.setAttribute('stroke-width', '2');
        eyeSvg.setAttribute('width', '12');
        eyeSvg.setAttribute('height', '12');
        const eyePath = document.createElementNS(svgNs, 'path');
        eyePath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22');
        eyeSvg.appendChild(eyePath);
        hideBtn.appendChild(eyeSvg);
        hideBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          await this.hideExplorerFolders([node.path]);
        });
        row.appendChild(hideBtn);
      }

      row.addEventListener('click', (e) => this._handleTreeRowClick(e, node));
      row.addEventListener('dblclick', async (e) => {
        e.stopPropagation();
        if (node.type === 'folder') {
          await this.toggleFolderNode(node.path);
        } else {
          await this.addPathsToPlaylist([node.path], true);
        }
      });
      row.addEventListener('dragstart', (e) => {
        if (!this.selectedTreePaths.has(node.path)) {
          this.selectedTreePaths = new Set([node.path]);
          this.lastClickedTreePath = node.path;
          this.renderComputerTree();
        }
        const paths = Array.from(this.selectedTreePaths);
        e.dataTransfer?.setData('application/x-vanta-paths', JSON.stringify(paths));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });

      frag.appendChild(row);

      if (node.emptyExpanded) {
        const emptyChild = document.createElement('div');
        emptyChild.className = 'tree-empty-note';
        emptyChild.style.paddingLeft = `${26 + node.depth * 14}px`;
        emptyChild.textContent = 'No subfolders or audio files';
        frag.appendChild(emptyChild);
      }
    }

    container.appendChild(frag);
    this._updateExplorerSelectionControls();
  }

  /**
   * Handles single, Ctrl, and Shift range selection inside Computer Explorer.
   */
  _handleTreeRowClick(event, node) {
    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (isShift && this.lastClickedTreePath) {
      const idxA = this.visibleTreeNodes.findIndex((n) => n.path === this.lastClickedTreePath);
      const idxB = this.visibleTreeNodes.findIndex((n) => n.path === node.path);
      if (idxA >= 0 && idxB >= 0) {
        const [start, end] = idxA <= idxB ? [idxA, idxB] : [idxB, idxA];
        if (!isCtrl) this.selectedTreePaths.clear();
        for (let i = start; i <= end; i++) {
          this.selectedTreePaths.add(this.visibleTreeNodes[i].path);
        }
      }
    } else if (isCtrl) {
      if (this.selectedTreePaths.has(node.path)) {
        this.selectedTreePaths.delete(node.path);
      } else {
        this.selectedTreePaths.add(node.path);
      }
      this.lastClickedTreePath = node.path;
    } else {
      this.selectedTreePaths = new Set([node.path]);
      this.lastClickedTreePath = node.path;
    }

    this.renderComputerTree();
  }

  /**
   * Toggles selection across all visible non-drive entries in Computer Explorer.
   */
  selectAllVisibleExplorerItems() {
    const selectable = this.visibleTreeNodes.filter((n) => n.kind !== 'drive');
    const pool = selectable.length ? selectable : this.visibleTreeNodes;
    if (!pool.length) return;

    const allSelected = pool.every((n) => this.selectedTreePaths.has(n.path));
    if (allSelected) {
      this.selectedTreePaths.clear();
    } else {
      this.selectedTreePaths = new Set(pool.map((n) => n.path));
    }
    this.renderComputerTree();
  }

  getSelectedHideableFolders() {
    return this.visibleTreeNodes
      .filter((n) => n.type === 'folder' && n.kind !== 'drive' && this.selectedTreePaths.has(n.path))
      .map((n) => n.path);
  }

  _updateExplorerSelectionControls() {
    const btnAdd = document.getElementById('btnExplorerAddSelected');
    if (btnAdd) {
      const count = this.selectedTreePaths.size;
      btnAdd.textContent = `+ Add Selected (${count})`;
      btnAdd.disabled = count === 0;
    }
    const btnHide = document.getElementById('btnExplorerHideSelected');
    if (btnHide) {
      const folderCount = this.getSelectedHideableFolders().length;
      btnHide.textContent = folderCount > 0 ? `Hide (${folderCount})` : 'Hide';
      btnHide.disabled = folderCount === 0;
    }
  }

  /**
   * Hides selected folders from Computer Explorer persistently without touching files on disk.
   * @param {string[]} paths - Folder paths to hide.
   */
  async hideExplorerFolders(paths = []) {
    const hideable = (Array.isArray(paths) ? paths : []).filter(
      (p) => p && !/^[a-zA-Z]:\\?$/.test(String(p).trim())
    );
    if (!hideable.length || !window.vantaAPI?.hideExplorerDirs) return;

    const res = await window.vantaAPI.hideExplorerDirs(hideable);
    this.hiddenExplorerDirs = Array.isArray(res?.hiddenExplorerDirs) ? res.hiddenExplorerDirs : [];

    const hiddenLower = new Set(hideable.map((p) => String(p).toLowerCase()));
    for (const p of Array.from(this.expandedDirs)) {
      if (hiddenLower.has(p.toLowerCase())) this.expandedDirs.delete(p);
    }
    for (const p of Array.from(this.selectedTreePaths)) {
      if (hiddenLower.has(p.toLowerCase())) this.selectedTreePaths.delete(p);
    }
    for (const [dirKey, cached] of this.dirEntriesCache.entries()) {
      this.dirEntriesCache.set(
        dirKey,
        cached.filter((e) => !(e.type === 'folder' && hiddenLower.has(String(e.path || '').toLowerCase())))
      );
    }

    this.renderHiddenDirsManager();
    this.renderComputerTree();
    this.setToast(`Hid ${hideable.length} folder${hideable.length > 1 ? 's' : ''} from Explorer (files untouched on disk)`);
  }

  /**
   * Restores one, multiple, or all hidden folders back into Computer Explorer.
   * @param {string[]} paths - Specific folder paths to restore.
   * @param {boolean} [all=false] - Restore every hidden folder.
   */
  async restoreExplorerFolders(paths = [], all = false) {
    if (!window.vantaAPI?.unhideExplorerDirs) return;
    const res = await window.vantaAPI.unhideExplorerDirs(paths, all);
    this.hiddenExplorerDirs = Array.isArray(res?.hiddenExplorerDirs) ? res.hiddenExplorerDirs : [];

    this.dirEntriesCache.clear();
    for (const openDir of Array.from(this.expandedDirs)) {
      const listed = await window.vantaAPI.listDir(openDir);
      this.dirEntriesCache.set(openDir, Array.isArray(listed?.entries) ? listed.entries : []);
    }

    this.renderHiddenDirsManager();
    this.renderComputerTree();
    this.setToast(all ? 'Restored all hidden folders in Computer Explorer' : 'Folder restored to Computer Explorer');
  }

  /**
   * Updates the Hidden (N) button badge and populates the hidden folders manager popover safely.
   */
  renderHiddenDirsManager() {
    const count = this.hiddenExplorerDirs.length;
    const btn = document.getElementById('btnExplorerHiddenMgr');
    const popover = document.getElementById('explorerHiddenPopover');
    const listEl = document.getElementById('explorerHiddenList');

    if (btn) {
      btn.textContent = `Hidden (${count})`;
      btn.classList.toggle('hidden', count === 0);
    }
    if (count === 0) {
      popover?.classList.add('hidden');
    }
    if (!listEl) return;

    listEl.replaceChildren();
    for (const dirPath of this.hiddenExplorerDirs) {
      const row = document.createElement('div');
      row.className = 'explorer-hidden-item';

      const pathSpan = document.createElement('span');
      pathSpan.className = 'explorer-hidden-path';
      pathSpan.textContent = dirPath;
      pathSpan.title = dirPath;
      row.appendChild(pathSpan);

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-ghost explorer-hdr-btn';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', () => this.restoreExplorerFolders([dirPath], false));
      row.appendChild(restoreBtn);

      listEl.appendChild(row);
    }
  }

  /**
   * Non-destructively indexes host folders/files into VANTA's playlist without moving files on disk.
   * @param {string[]} paths - Host file and/or directory paths.
   * @param {boolean} [autoPlayFirst=false] - Auto-play if a single track was added via double-click.
   */
  async addPathsToPlaylist(paths = [], autoPlayFirst = false) {
    const list = (Array.isArray(paths) ? paths : []).filter(Boolean);
    if (!list.length || !window.vantaAPI) return;

    const isoPaths = list.filter((p) => /\.iso$/i.test(String(p)));
    const mediaPaths = list.filter((p) => !/\.iso$/i.test(String(p)));
    for (const isoPath of isoPaths) {
      await this.importSacdIsoFiles(isoPath);
    }
    if (!mediaPaths.length || !window.vantaAPI.addPaths) return;

    this.setToast(`Adding ${mediaPaths.length} item${mediaPaths.length > 1 ? 's' : ''} to playlist...`);
    const res = await window.vantaAPI.addPaths(mediaPaths);
    if (!res) return;

    this.mergeVaultCatalog(res.catalog, res.doctor, res.smartPlaylists);

    if (autoPlayFirst && mediaPaths.length === 1) {
      const targetNorm = mediaPaths[0].toLowerCase();
      const addedTrack = this.catalog.find((t) => String(t.filePath || '').toLowerCase() === targetNorm);
      if (addedTrack?.isVideo && this.activeNav !== 'videos' && !isMusicVideoTagged(addedTrack)) {
        this.handleSidebarSwitch('videos');
      }
      const idx = this.displayedTracks.findIndex(
        (t) => String(t.filePath || '').toLowerCase() === targetNorm
      );
      if (idx >= 0) {
        this.selectTrack(idx, true);
      }
    }

    this.setToast(
      `Playlist updated: ${res.addedCount || mediaPaths.length} source item(s) processed (${this.catalog.length} tracks)`
    );
  }

  /**
   * Builds and binds the topbar Stage FX lighting selector (8 FX modes + 5 color palettes).
   */
  setupStageFxSelector() {
    const root = document.getElementById('stageFxCombo');
    const menuEl = document.getElementById('stageFxMenu');
    if (!root || !menuEl || !this.stageLights) return;

    const trigger = root.querySelector('.vanta-combo-trigger');
    const labelEl = root.querySelector('.vanta-combo-label');
    if (!trigger || !labelEl) return;

    const syncCinemaControls = () => {
      const btn = document.getElementById('btnCinemaStage');
      const exitBtn = document.getElementById('btnExitCinemaStage');
      const isCinema = Boolean(this.stageLights.cinemaMode && this.stageLights.mode !== 'off');
      btn?.classList.toggle('active', isCinema);
      exitBtn?.classList.toggle('hidden', !isCinema);
    };

    const renderMenu = () => {
      const currentMode = this.stageLights.mode;
      const currentPalette = this.stageLights.paletteId;
      const modeMeta = STAGE_FX_MODES.find((m) => m.id === currentMode) || STAGE_FX_MODES[0];
      labelEl.textContent = modeMeta.shortLabel;
      syncCinemaControls();

      menuEl.replaceChildren();

      const hdrModes = document.createElement('div');
      hdrModes.className = 'stage-fx-section-lbl';
      hdrModes.textContent = 'Stage Lighting FX';
      menuEl.appendChild(hdrModes);

      for (const m of STAGE_FX_MODES) {
        const opt = document.createElement('button');
        opt.type = 'button';
        opt.className = `stage-fx-option${m.id === currentMode ? ' active' : ''}`;
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', String(m.id === currentMode));

        const left = document.createElement('span');
        left.textContent = m.label;
        const right = document.createElement('small');
        right.textContent = m.id === currentMode ? '✓' : m.desc;

        opt.appendChild(left);
        opt.appendChild(right);
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          this.stageLights.setMode(m.id);
          renderMenu();
          menuEl.classList.add('hidden');
          trigger.setAttribute('aria-expanded', 'false');
          this.setToast(m.id === 'off' ? 'Stage Lighting FX: Off' : `Stage Lighting FX: ${m.label}`);
        });
        menuEl.appendChild(opt);
      }

      const hdrPal = document.createElement('div');
      hdrPal.className = 'stage-fx-section-lbl';
      hdrPal.textContent = 'Color Palette';
      menuEl.appendChild(hdrPal);

      const palRow = document.createElement('div');
      palRow.className = 'stage-fx-palette-row';
      for (const [palId, pal] of Object.entries(STAGE_PALETTES)) {
        const pBtn = document.createElement('button');
        pBtn.type = 'button';
        pBtn.className = `stage-fx-pal-btn${palId === currentPalette ? ' active' : ''}`;
        pBtn.textContent = pal.label;
        pBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.stageLights.setPalette(palId);
          renderMenu();
          this.setToast(`Stage FX Palette: ${pal.label}`);
        });
        palRow.appendChild(pBtn);
      }
      menuEl.appendChild(palRow);

      const hdrVideo = document.createElement('div');
      hdrVideo.className = 'stage-fx-section-lbl';
      hdrVideo.textContent = 'Live Video Source';
      menuEl.appendChild(hdrVideo);

      const videoRow = document.createElement('div');
      videoRow.className = 'stage-fx-palette-row';
      const activeFileLabel = document.createElement('span');
      activeFileLabel.style.cssText = 'font-size:10.5px; color:var(--muted); max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; align-self:center;';
      const curPath = this.stageLights.videoPath || '';
      const baseName = curPath ? curPath.split(/[\\/]/).pop() : 'None selected';
      activeFileLabel.textContent = baseName;
      activeFileLabel.title = curPath || 'No FX loop video configured';

      const pickVidBtn = document.createElement('button');
      pickVidBtn.type = 'button';
      pickVidBtn.className = 'stage-fx-pal-btn';
      pickVidBtn.textContent = '📁 Choose Video…';
      pickVidBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.vantaAPI?.pickFxVideo) return;
        const res = await window.vantaAPI.pickFxVideo();
        if (!res?.canceled && res?.videoPath) {
          this.stageLights.setVideoSource(res.videoPath);
          this.stageLights.setMode('video');
          renderMenu();
          menuEl.classList.add('hidden');
          trigger.setAttribute('aria-expanded', 'false');
          this.setToast(`Live Video FX active: ${res.fileName}`);
        }
      });

      videoRow.appendChild(activeFileLabel);
      videoRow.appendChild(pickVidBtn);
      menuEl.appendChild(videoRow);

      const hdrAlpha = document.createElement('div');
      hdrAlpha.className = 'stage-fx-section-lbl';
      hdrAlpha.textContent = 'Panel Transparency (Video clarity)';
      menuEl.appendChild(hdrAlpha);

      const alphaRow = document.createElement('div');
      alphaRow.className = 'fx-alpha-row';
      const alphaSlider = document.createElement('input');
      alphaSlider.id = 'fxGlassOpacitySlider';
      alphaSlider.type = 'range';
      alphaSlider.min = '6';
      alphaSlider.max = '80';
      alphaSlider.value = String(Math.round((this.stageLights.videoGlassAlpha || 0.24) * 100));
      alphaSlider.className = 'fx-alpha-slider';
      const alphaPct = document.createElement('span');
      alphaPct.className = 'fx-alpha-pct';
      alphaPct.textContent = `${alphaSlider.value}%`;
      alphaSlider.addEventListener('click', (e) => e.stopPropagation());
      alphaSlider.addEventListener('input', (e) => {
        e.stopPropagation();
        const pct = Number(e.target.value) || 24;
        alphaPct.textContent = `${pct}%`;
        this.stageLights.setVideoGlassAlpha(pct / 100);
      });
      alphaRow.appendChild(alphaSlider);
      alphaRow.appendChild(alphaPct);
      menuEl.appendChild(alphaRow);
    };

    const toggleCinemaStage = (forceVal = null) => {
      const next = forceVal === null ? !this.stageLights.cinemaMode : Boolean(forceVal);
      if (next && this.stageLights.mode === 'off') {
        this.stageLights.setMode(this.stageLights.videoPath ? 'video' : 'hyper');
      }
      this.stageLights.setCinemaMode(next);
      renderMenu();
      this.setToast(next ? 'Cinema Stage ON — press Esc or Show Playlist to return' : 'Playlist View restored');
    };

    renderMenu();

    if (!root.dataset.fxBound) {
      root.dataset.fxBound = '1';
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isClosed = menuEl.classList.contains('hidden');
        document.querySelectorAll('.vanta-combo-menu').forEach((m) => m.classList.add('hidden'));
        document.querySelectorAll('.vanta-combo-trigger').forEach((t) => t.setAttribute('aria-expanded', 'false'));
        if (isClosed) {
          renderMenu();
          menuEl.classList.remove('hidden');
          trigger.setAttribute('aria-expanded', 'true');
        }
      });

      document.getElementById('btnCinemaStage')?.addEventListener('click', () => toggleCinemaStage());
      document.getElementById('btnExitCinemaStage')?.addEventListener('click', () => toggleCinemaStage(false));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.stageLights?.cinemaMode) {
          toggleCinemaStage(false);
        }
      });
    }
  }

  /**
   * Builds the local media server URL for a video track with explicit playback strategy,
   * audio stream selection, and optional seek offset for remuxed containers.
   * @param {object} track
   * @param {number} [audioIdx=0]
   * @param {number} [seekSec=0]
   * @returns {string}
   */
  buildVideoStreamUrl(track, audioIdx = this.activeVideoAudioIdx, seekSec = 0) {
    const strategy = this.activeVideoStrategy || 'direct';
    const params = new URLSearchParams({
      path: track.filePath,
      mode: 'video',
      strategy,
      a: String(Math.max(0, Number(audioIdx) || 0))
    });
    if (strategy !== 'direct' && Number(seekSec) > 0.5) {
      params.set('ss', Number(seekSec).toFixed(2));
    }
    return `vanta-media://local?${params.toString()}`;
  }

  /**
   * Probes container streams (video resolution/codec, audio tracks, embedded + sibling subtitles)
   * and loads the selected video track cleanly into Theater Stage.
   * @param {object} track
   * @param {boolean} [enterTheater=true]
   */
  prepareVideoTrack(track, enterTheater = true) {
    if (!track?.filePath) return;
    const mySeq = ++this._videoProbeSeq;
    this.activeLoadedVideoTrack = track;
    this.activeVideoProbe = null;
    this.activeVideoStrategy = 'direct';
    this.activeVideoAudioIdx = 0;
    this._videoSeekOffsetSec = 0;
    if (this.displayedTracks[this.activeTrackIndex] === track) {
      this._pendingStudioSeekSec = null;
    }
    this.siblingSubtitles = [];
    this.clearActiveSubtitles();

    if (enterTheater) {
      this.openTheaterStage(true);
    }

    const titleEl = document.getElementById('theaterVideoTitle');
    if (titleEl) titleEl.textContent = track.title || track.filename || 'Video';

    const runProbe = async () => {
      let probeRes = null;
      if (window.vantaAPI?.probeVideoStreams) {
        probeRes = await window.vantaAPI.probeVideoStreams(track.filePath).catch(() => null);
      }
      if (mySeq !== this._videoProbeSeq) return;

      this._refreshVideoTrackControls(track, probeRes);
      const nextUrl = this.buildVideoStreamUrl(track, this.activeVideoAudioIdx, 0);
      if (this._lastLoadedVideoUrl !== nextUrl || !this.videoEl.src) {
        this.videoEl.src = nextUrl;
        this._lastLoadedVideoUrl = nextUrl;
      }
      const probedDur = probeRes?.probe?.durationSec || Number(track.durationSec) || 0;
      this._updateTheaterTimelineUi(0);
      if (this.displayedTracks[this.activeTrackIndex] === track && probedDur > 0) {
        this.updateTimelineUi(0, probedDur);
      }
    };

    this._videoProbePromise = runProbe();
  }

  /**
   * Reparents the single #vantaVideoPlayer DOM node cleanly between dock preview and center
   * 4K Theater Stage without recreating the WebAudio MediaElementSourceNode.
   * @param {boolean} [open=true]
   */
  openTheaterStage(open = true) {
    const targetOpen = Boolean(open);
    const stageEl = document.getElementById('theaterVideoStage');
    const theaterMount = document.getElementById('theaterVideoMount');
    const dockMount = document.getElementById('dockVideoMount');
    if (!stageEl || !theaterMount || !dockMount || !this.videoEl) return;

    const wasPlaying = !this.videoEl.paused;
    const targetMount = targetOpen ? theaterMount : dockMount;
    if (this.videoEl.parentElement !== targetMount) {
      targetMount.appendChild(this.videoEl);
      if (wasPlaying && this.videoEl.paused) {
        this.videoEl.play().catch(() => {});
      }
    }

    this.theaterOpen = targetOpen;
    stageEl.classList.toggle('hidden', !targetOpen);
    stageEl.classList.toggle('ambilight-off', !this.theaterAmbilight);
    document.body.classList.toggle('theater-video-active', targetOpen);

    if (targetOpen) {
      if (document.pictureInPictureElement === this.videoEl) {
        document.exitPictureInPicture?.().catch(() => {});
      }
      const playBtn = document.getElementById('btnTheaterPlayPause');
      if (playBtn) {
        playBtn.textContent = this.videoEl.paused ? '▶ Play' : '⏸ Pause';
      }
      const volSlider = document.getElementById('theaterVolumeSlider');
      const muteBtn = document.getElementById('btnTheaterMute');
      if (volSlider) volSlider.value = String(Math.round((this.videoEl.muted ? 0 : this.videoEl.volume) * 100));
      if (muteBtn) muteBtn.textContent = (this.videoEl.muted || this.videoEl.volume === 0) ? '🔇' : '🔊';
      const loopBtn = document.getElementById('btnTheaterLoop');
      if (loopBtn) loopBtn.classList.toggle('active', Boolean(this.videoEl.loop));
      this._updateTheaterTimelineUi();
      this._pokeTheaterOsd();
      this._startAmbilightLoop();
    } else {
      if (document.fullscreenElement === stageEl) {
        document.exitFullscreen?.().catch(() => {});
      }
      this._stopAmbilightLoop();
    }
  }

  /**
   * Populates Cinema OSD badges, audio language selector, and subtitle tracks from container probe.
   * @param {object} track
   * @param {object|null} probeRes
   */
  _refreshVideoTrackControls(track, probeRes) {
    const probe = probeRes?.probe || null;
    const rawStrat = probeRes?.strategy;
    this.activeVideoStrategy = typeof rawStrat === 'string' ? rawStrat : (rawStrat?.mode || 'direct');
    this.activeVideoAudioIdx = Number(probeRes?.audioRelIdx ?? rawStrat?.audioRelIdx ?? 0) || 0;
    this.activeVideoProbe = probe;
    this.siblingSubtitles = Array.isArray(probeRes?.siblingSubtitles) ? probeRes.siblingSubtitles : [];

    const badgeEl = document.getElementById('theaterTechBadge');
    const dockBadgeEl = document.getElementById('dockVideoStatusBadge');
    const w = probe?.video?.width || 0;
    const h = probe?.video?.height || 0;
    const tier = w >= 3800 || h >= 2100 ? '4K UHD' : w >= 2500 ? '1440p QHD' : w >= 1900 ? '1080p HD' : w >= 1260 ? '720p HD' : 'VIDEO';
    const codec = (probe?.video?.codec || track?.ext || 'MP4').toUpperCase();
    const pipeLabel =
      this.activeVideoStrategy === 'direct'
        ? 'Direct GPU'
        : this.activeVideoStrategy === 'remux-copy'
          ? 'Zero-Copy Remux'
          : 'FFmpeg Stream';
    const dims = w > 0 && h > 0 ? ` • ${w}×${h}` : '';
    const fullBadge = `${tier}${dims} • ${codec} • ${pipeLabel}`;
    if (badgeEl) badgeEl.textContent = fullBadge;
    if (dockBadgeEl) dockBadgeEl.textContent = `${tier} • ${pipeLabel}`;

    const audioSelect = document.getElementById('theaterAudioSelect');
    if (audioSelect) {
      audioSelect.replaceChildren();
      const streams = probe?.audioStreams?.length ? probe.audioStreams : [{ relIndex: 0, lang: 'und', codec: 'aac', channels: 2 }];
      streams.forEach((a) => {
        const relIdx = Number(a.relIndex ?? a.relIdx ?? 0);
        const opt = document.createElement('option');
        opt.value = String(relIdx);
        const lang = a.lang && a.lang !== 'und' ? a.lang.toUpperCase() : `Track ${relIdx + 1}`;
        const ch = a.channels >= 6 ? '5.1' : `${a.channels || 2}ch`;
        opt.textContent = `${lang} (${String(a.codec || 'audio').toUpperCase()} ${ch})`;
        if (relIdx === this.activeVideoAudioIdx) opt.selected = true;
        audioSelect.appendChild(opt);
      });
    }

    const subSelect = document.getElementById('theaterSubSelect');
    if (subSelect) {
      subSelect.replaceChildren();
      const offOpt = document.createElement('option');
      offOpt.value = 'off';
      offOpt.textContent = 'Subtitles Off';
      subSelect.appendChild(offOpt);

      const embeddedSubs = (probe?.subtitleStreams || []).filter((s) => !s.isBitmap);
      embeddedSubs.forEach((s) => {
        const relIdx = Number(s.relIndex ?? s.relIdx ?? 0);
        const opt = document.createElement('option');
        opt.value = `emb:${relIdx}`;
        const lang = s.lang && s.lang !== 'und' ? s.lang.toUpperCase() : `Sub #${relIdx + 1}`;
        opt.textContent = `Embedded: ${lang}`;
        subSelect.appendChild(opt);
      });

      this.siblingSubtitles.forEach((extSub, idx) => {
        const opt = document.createElement('option');
        opt.value = `ext:${idx}`;
        opt.textContent = `File: ${extSub.label}`;
        subSelect.appendChild(opt);
      });
    }
  }

  _resolveLoadedVideoTrack() {
    const active = this.displayedTracks[this.activeTrackIndex];
    return active?.isVideo ? active : this.activeLoadedVideoTrack;
  }

  _hasLoadedVideo() {
    return Boolean(this.videoEl && (this.videoEl.currentSrc || this.videoEl.src));
  }

  /**
   * Switches active audio stream on a multi-audio MKV/MP4 video, keeping timeline position.
   * @param {number} audioRelIdx
   */
  switchVideoAudioStream(audioRelIdx) {
    const track = this._resolveLoadedVideoTrack();
    if (!track?.filePath) return;
    const nextIdx = Math.max(0, Number(audioRelIdx) || 0);
    if (nextIdx === this.activeVideoAudioIdx) return;

    const isPrimaryVideo = Boolean(this.displayedTracks[this.activeTrackIndex]?.isVideo);
    const wasVideoPlaying = Boolean(this.videoEl && !this.videoEl.paused);
    this.activeVideoAudioIdx = nextIdx;
    if (nextIdx > 0 && this.activeVideoStrategy === 'direct') {
      this.activeVideoStrategy = 'remux-copy';
    }
    const curPos = this._videoSeekOffsetSec + (this.videoEl?.currentTime || 0);
    this._refreshVideoTrackControls(track, {
      probe: this.activeVideoProbe,
      strategy: this.activeVideoStrategy,
      audioRelIdx: nextIdx,
      siblingSubtitles: this.siblingSubtitles
    });
    if (isPrimaryVideo && this.isPlaying) {
      void this.startPlayback(curPos).catch(() => {});
    } else {
      const nextOffset = this.activeVideoStrategy !== 'direct' && curPos > 0.5 ? curPos : 0;
      this._videoSeekOffsetSec = nextOffset;
      if (isPrimaryVideo) this._pendingStudioSeekSec = curPos;
      const nextUrl = this.buildVideoStreamUrl(track, nextIdx, nextOffset);
      this.videoEl.src = nextUrl;
      this._lastLoadedVideoUrl = nextUrl;
      if (this.activeVideoStrategy === 'direct' && curPos > 0.5) {
        this._applyNativeSeekOnElement(this.videoEl, curPos);
      }
      if (wasVideoPlaying) {
        this.videoEl.play().catch(() => {});
      }
    }
    this.setToast(`Audio Stream switched to Track #${nextIdx + 1}`);
  }

  /**
   * Removes active WebVTT <track> elements and revokes temporary Blob URLs.
   */
  clearActiveSubtitles() {
    if (this.videoEl) {
      this.videoEl.querySelectorAll('track').forEach((tr) => tr.remove());
    }
    if (this.activeSubtitleUrl) {
      URL.revokeObjectURL(this.activeSubtitleUrl);
      this.activeSubtitleUrl = null;
    }
  }

  /**
   * Mounts a WebVTT subtitle string onto #vantaVideoPlayer.
   * @param {string} vttText
   * @param {string} [label='Subtitles']
   */
  applySubtitleVtt(vttText, label = 'Subtitles') {
    this.clearActiveSubtitles();
    if (!vttText || !this.videoEl) return;
    const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
    this.activeSubtitleUrl = URL.createObjectURL(blob);
    const trackEl = document.createElement('track');
    trackEl.kind = 'subtitles';
    trackEl.label = label;
    trackEl.srclang = 'en';
    trackEl.src = this.activeSubtitleUrl;
    trackEl.default = true;
    this.videoEl.appendChild(trackEl);
    if (trackEl.track) {
      trackEl.track.mode = 'showing';
    }
  }

  _pokeTheaterOsd() {
    const stageEl = document.getElementById('theaterVideoStage');
    if (!stageEl) return;
    stageEl.classList.remove('osd-idle');
    clearTimeout(this._theaterIdleTimer);
    this._theaterIdleTimer = setTimeout(() => {
      if (this.theaterOpen && this.videoEl && !this.videoEl.paused) {
        stageEl.classList.add('osd-idle');
      }
    }, 2800);
  }

  _startAmbilightLoop() {
    this._stopAmbilightLoop();
    const canvas = document.getElementById('theaterAmbilightCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = 48;
    canvas.height = 27;
    let lastDraw = 0;

    const frame = (now) => {
      if (!this.theaterOpen) return;
      if (this.theaterAmbilight && now - lastDraw >= 42 && this.videoEl && this.videoEl.readyState >= 2 && !this.videoEl.paused) {
        lastDraw = now;
        try {
          ctx.drawImage(this.videoEl, 0, 0, canvas.width, canvas.height);
        } catch {
          // Ignore transient draw error while seeking
        }
      }
      this._ambilightRafId = requestAnimationFrame(frame);
    };
    this._ambilightRafId = requestAnimationFrame(frame);
  }

  _stopAmbilightLoop() {
    if (this._ambilightRafId) {
      cancelAnimationFrame(this._ambilightRafId);
      this._ambilightRafId = 0;
    }
  }

  _formatVideoClock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  _flashTheaterFeedback(text) {
    const el = document.getElementById('theaterCenterOverlay');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(this._theaterFeedbackTimer);
    this._theaterFeedbackTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 680);
  }

  _updateTheaterTimelineUi(overrideCurSec = null) {
    if (!this.theaterOpen || !this.videoEl) return;
    const rawTotal =
      this.activeVideoProbe?.durationSec ||
      (Number.isFinite(this.videoEl.duration) ? this._videoSeekOffsetSec + this.videoEl.duration : 0) ||
      Number(this._resolveLoadedVideoTrack()?.durationSec) ||
      0;
    const cur =
      overrideCurSec !== null
        ? Math.max(0, Number(overrideCurSec) || 0)
        : this._videoSeekOffsetSec + (this.videoEl.currentTime || 0);
    const total = rawTotal > 0 ? Math.max(rawTotal, cur) : 0;
    const pct = total > 0 ? Math.max(0, Math.min(100, (cur / total) * 100)) : 0;

    const curEl = document.getElementById('theaterCurrentTime');
    const totEl = document.getElementById('theaterTotalTime');
    const fillEl = document.getElementById('theaterSeekFill');
    const thumbEl = document.getElementById('theaterSeekThumb');
    const bufEl = document.getElementById('theaterSeekBuffer');

    if (curEl) curEl.textContent = this._formatVideoClock(cur);
    if (totEl) totEl.textContent = this._formatVideoClock(total);
    if (fillEl) fillEl.style.width = `${pct.toFixed(2)}%`;
    if (thumbEl) thumbEl.style.left = `${pct.toFixed(2)}%`;

    if (bufEl) {
      if (total > 0 && this.videoEl.buffered?.length) {
        const bufEnd = this._videoSeekOffsetSec + this.videoEl.buffered.end(this.videoEl.buffered.length - 1);
        const bufPct = Math.max(0, Math.min(100, (bufEnd / total) * 100));
        bufEl.style.width = `${bufPct.toFixed(2)}%`;
      } else {
        bufEl.style.width = '0%';
      }
    }
  }

  /**
   * Toggles video playback from either the Right Dock mini stage or Theater stage.
   * Uses Option A (auto-switch): pauses active music (DSP or WASAPI) before playing an
   * independent video so music and video audio never overlap.
   */
  async _toggleVideoStagePlayPause() {
    const activeTrack = this.displayedTracks[this.activeTrackIndex];
    if (activeTrack?.isVideo) {
      const nextLabel = this.isPlaying ? '⏸ Paused' : '▶ Playing';
      this.togglePlay();
      if (this.theaterOpen) this._flashTheaterFeedback(nextLabel);
      return;
    }

    const videoTrack = this._resolveLoadedVideoTrack();
    if (!this._hasLoadedVideo() && !videoTrack?.filePath) {
      this.setToast('Select a video file in your library first');
      return;
    }

    if (!this._hasLoadedVideo() && videoTrack?.filePath) {
      const url = this.buildVideoStreamUrl(videoTrack, this.activeVideoAudioIdx, this._videoSeekOffsetSec);
      this.videoEl.src = url;
      this._lastLoadedVideoUrl = url;
    }

    if (this.videoEl.paused) {
      const pausedMusic = Boolean(this.isPlaying);
      if (pausedMusic) {
        this.pausePlayback();
      }
      this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
      await this.audioEngine.resumeEngine();
      this.videoEl.muted = false;
      try {
        await this.videoEl.play();
        if (this.theaterOpen) {
          this._flashTheaterFeedback('▶ Playing');
        } else {
          this.setToast(pausedMusic ? 'Playing Video (Music Paused)' : 'Playing Video');
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          this.setToast(`Video playback error: ${err.message}`);
        }
      }
    } else {
      this.videoEl.pause();
      if (this.theaterOpen) {
        this._flashTheaterFeedback('⏸ Paused');
      } else {
        this.setToast('Video Paused');
      }
    }
  }

  /**
   * Wires all 4K Theater Stage controls (Seekbar, Play/Pause, Volume, Speed, Loop, Fullscreen, Subtitles, Ambilight).
   */
  bindTheaterEvents() {
    const stageEl = document.getElementById('theaterVideoStage');
    const mountEl = document.getElementById('theaterVideoMount');
    const toggleFullscreen = async () => {
      if (!stageEl) return;
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await stageEl.requestFullscreen();
      } catch (err) {
        this.setToast(`Fullscreen info: ${err.message}`);
      }
    };

    const dockMount = document.getElementById('dockVideoMount');
    const openTheaterIfReady = () => {
      if (!this._hasLoadedVideo() && !this._resolveLoadedVideoTrack()) {
        this.setToast('Select a video file in your library first');
        return;
      }
      this.openTheaterStage(true);
    };

    const toggleTheaterPlayPause = () => {
      void this._toggleVideoStagePlayPause().catch(() => {});
    };

    const seekVideoToSec = (targetSec) => {
      const activeTrack = this.displayedTracks[this.activeTrackIndex];
      const videoTrack = this._resolveLoadedVideoTrack();
      if (!this._hasLoadedVideo() && !videoTrack) return;
      const total = this._resolveEffectiveDurationSec(videoTrack, this.videoEl);
      const clamped = Math.max(0, total > 0 ? Math.min(total - 0.5, targetSec) : targetSec);
      this._updateTheaterTimelineUi(clamped);
      if (activeTrack?.isVideo && total > 0) {
        this.updateTimelineUi(clamped, total);
      }

      const targetVideo = videoTrack || { isVideo: true, filePath: '' };
      const isPrimaryActive = Boolean(activeTrack?.isVideo);
      this._seekStudioMedia(targetVideo, clamped, true, {
        mediaEl: this.videoEl,
        independentVideo: !isPrimaryActive
      });
    };

    const nudgeVideo = (deltaSec) => {
      const cur = this._videoSeekOffsetSec + (this.videoEl?.currentTime || 0);
      seekVideoToSec(cur + deltaSec);
      this._flashTheaterFeedback(deltaSec >= 0 ? `⏩ +${deltaSec}s` : `⏪ ${deltaSec}s`);
    };

    document.getElementById('btnOpenTheater')?.addEventListener('click', openTheaterIfReady);
    let dockClickTimer = null;
    dockMount?.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(dockClickTimer);
      dockClickTimer = setTimeout(() => toggleTheaterPlayPause(), 190);
    });
    dockMount?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(dockClickTimer);
      openTheaterIfReady();
    });
    document.getElementById('btnTheaterClose')?.addEventListener('click', () => this.openTheaterStage(false));
    document.getElementById('btnTheaterFullscreen')?.addEventListener('click', toggleFullscreen);

    // Click toggles Play/Pause after brief debounce so double-click cleanly enters/exits Fullscreen
    let videoClickTimer = null;
    mountEl?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._pokeTheaterOsd();
      clearTimeout(videoClickTimer);
      videoClickTimer = setTimeout(() => toggleTheaterPlayPause(), 190);
    });
    mountEl?.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      clearTimeout(videoClickTimer);
      void toggleFullscreen().catch(() => {});
    });

    stageEl?.addEventListener('mousemove', () => this._pokeTheaterOsd());
    stageEl?.addEventListener('click', () => this._pokeTheaterOsd());

    document.getElementById('btnTheaterPlayPause')?.addEventListener('click', toggleTheaterPlayPause);
    document.getElementById('btnTheaterPiP')?.addEventListener('click', () => {
      document.getElementById('btnTogglePiP')?.click();
    });
    document.getElementById('btnTheaterBack10')?.addEventListener('click', () => nudgeVideo(-10));
    document.getElementById('btnTheaterFwd10')?.addEventListener('click', () => nudgeVideo(10));

    // Theater Interactive Timeline Scrubber
    const seekTrack = document.getElementById('theaterSeekTrack');
    const seekHover = document.getElementById('theaterSeekHover');
    let isDraggingTheaterSeek = false;
    const ratioFromTrack = (clientX) => {
      if (!seekTrack) return 0;
      const r = seekTrack.getBoundingClientRect();
      return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
    };
    const getTotalVideoSec = () =>
      this.activeVideoProbe?.durationSec ||
      (Number.isFinite(this.videoEl?.duration) ? this._videoSeekOffsetSec + this.videoEl.duration : 0) ||
      Number(this._resolveLoadedVideoTrack()?.durationSec) ||
      0;

    seekTrack?.addEventListener('pointerdown', (e) => {
      isDraggingTheaterSeek = true;
      seekTrack.classList.add('dragging');
      seekTrack.setPointerCapture?.(e.pointerId);
      const targetSec = getTotalVideoSec() * ratioFromTrack(e.clientX);
      this._updateTheaterTimelineUi(targetSec);
    });
    seekTrack?.addEventListener('pointermove', (e) => {
      const ratio = ratioFromTrack(e.clientX);
      const previewSec = getTotalVideoSec() * ratio;
      if (seekHover) {
        seekHover.classList.remove('hidden');
        seekHover.style.left = `${(ratio * 100).toFixed(2)}%`;
        seekHover.textContent = this._formatVideoClock(previewSec);
      }
      if (isDraggingTheaterSeek) {
        this._updateTheaterTimelineUi(previewSec);
      }
    });
    seekTrack?.addEventListener('pointerup', (e) => {
      if (!isDraggingTheaterSeek) return;
      isDraggingTheaterSeek = false;
      seekTrack.classList.remove('dragging');
      const targetSec = getTotalVideoSec() * ratioFromTrack(e.clientX);
      seekVideoToSec(targetSec);
    });
    seekTrack?.addEventListener('pointercancel', () => {
      isDraggingTheaterSeek = false;
      seekTrack.classList.remove('dragging');
    });
    seekTrack?.addEventListener('pointerleave', () => {
      seekHover?.classList.add('hidden');
    });

    // Video Volume, Mute, Playback Speed & Loop
    const volSlider = document.getElementById('theaterVolumeSlider');
    const muteBtn = document.getElementById('btnTheaterMute');
    const syncTheaterVolUi = () => {
      if (!this.videoEl) return;
      const mutedOrZero = this.videoEl.muted || this.videoEl.volume === 0;
      if (muteBtn) muteBtn.textContent = mutedOrZero ? '🔇' : '🔊';
      if (volSlider) volSlider.value = String(Math.round((this.videoEl.muted ? 0 : this.videoEl.volume) * 100));
    };
    muteBtn?.addEventListener('click', () => {
      if (!this.videoEl) return;
      this.videoEl.muted = !this.videoEl.muted;
      syncTheaterVolUi();
      this._flashTheaterFeedback(this.videoEl.muted ? '🔇 Muted' : `🔊 ${Math.round(this.videoEl.volume * 100)}%`);
    });
    volSlider?.addEventListener('input', (e) => {
      if (!this.videoEl) return;
      const v = Math.max(0, Math.min(1, Number(e.target.value) / 100));
      this.videoEl.volume = v;
      this.videoEl.muted = v === 0;
      if (muteBtn) muteBtn.textContent = v === 0 ? '🔇' : '🔊';
    });

    document.getElementById('theaterSpeedSelect')?.addEventListener('change', (e) => {
      if (!this.videoEl) return;
      const rate = Number(e.target.value) || 1;
      this.videoEl.playbackRate = rate;
      this.videoEl.preservesPitch = Math.abs(rate - 1) < 0.001;
      this._flashTheaterFeedback(`⚡ ${rate}x`);
    });

    const loopBtn = document.getElementById('btnTheaterLoop');
    loopBtn?.addEventListener('click', () => {
      if (!this.videoEl) return;
      this.videoEl.loop = !this.videoEl.loop;
      loopBtn.classList.toggle('active', this.videoEl.loop);
      this._flashTheaterFeedback(this.videoEl.loop ? '🔁 Loop ON' : '🔁 Loop OFF');
    });

    document.getElementById('theaterAudioSelect')?.addEventListener('change', (e) => {
      this.switchVideoAudioStream(Number(e.target.value) || 0);
    });

    document.getElementById('theaterSubSelect')?.addEventListener('change', async (e) => {
      const val = String(e.target.value || 'off');
      if (val === 'off') {
        this.clearActiveSubtitles();
        this.setToast('Subtitles Off');
        return;
      }
      const videoTrack = this._resolveLoadedVideoTrack();
      if (!window.vantaAPI?.getSubtitleVtt) return;

      if (val.startsWith('emb:') && videoTrack?.filePath) {
        const relSubIdx = Number(val.slice(4)) || 0;
        const res = await window.vantaAPI.getSubtitleVtt({ videoPath: videoTrack.filePath, relSubIdx }).catch(() => null);
        if (res?.ok && res.vtt) {
          this.applySubtitleVtt(res.vtt, `Embedded #${relSubIdx + 1}`);
          this.setToast(`Subtitles loaded: Embedded #${relSubIdx + 1}`);
        } else {
          this.setToast(`Subtitle extract failed: ${res?.error || 'Unsupported subtitle format'}`);
        }
      } else if (val.startsWith('ext:')) {
        const extIdx = Number(val.slice(4)) || 0;
        const subMeta = this.siblingSubtitles[extIdx];
        const subFilePath = subMeta?.path || subMeta?.filePath;
        if (subFilePath) {
          const res = await window.vantaAPI.getSubtitleVtt({ subtitleFilePath: subFilePath }).catch(() => null);
          if (res?.ok && res.vtt) {
            this.applySubtitleVtt(res.vtt, subMeta.label);
            this.setToast(`Subtitles loaded: ${subMeta.label}`);
          }
        }
      }
    });

    document.getElementById('btnLoadSubtitleFile')?.addEventListener('click', async () => {
      if (!window.vantaAPI?.pickSubtitleFile) return;
      const res = await window.vantaAPI.pickSubtitleFile().catch(() => null);
      if (!res || res.canceled || !res.vtt) return;
      this.applySubtitleVtt(res.vtt, res.label || 'External');
      const subSelect = document.getElementById('theaterSubSelect');
      if (subSelect) {
        const opt = document.createElement('option');
        opt.value = 'custom';
        opt.textContent = `File: ${res.label}`;
        opt.selected = true;
        subSelect.appendChild(opt);
      }
      this.setToast(`Loaded subtitle: ${res.label}`);
    });

    const ambBtn = document.getElementById('btnTheaterAmbilight');
    ambBtn?.addEventListener('click', () => {
      this.theaterAmbilight = !this.theaterAmbilight;
      ambBtn.classList.toggle('active', this.theaterAmbilight);
      stageEl?.classList.toggle('ambilight-off', !this.theaterAmbilight);
      this.setToast(`Theater Ambilight ${this.theaterAmbilight ? 'ON' : 'OFF'}`);
    });

    const syncTheaterPlayBtn = () => {
      const playBtn = document.getElementById('btnTheaterPlayPause');
      if (playBtn && this.videoEl) {
        playBtn.textContent = this.videoEl.paused ? '▶ Play' : '⏸ Pause';
      }
    };
    this._bindVideoTheaterEvents = () => {
      if (!this.videoEl || this._boundTheaterVideoElements.has(this.videoEl)) return;
      this._boundTheaterVideoElements.add(this.videoEl);
      this.videoEl.addEventListener('play', () => {
        syncTheaterPlayBtn();
        this._pokeTheaterOsd();
      });
      this.videoEl.addEventListener('pause', () => {
        syncTheaterPlayBtn();
        document.getElementById('theaterVideoStage')?.classList.remove('osd-idle');
      });
      this.videoEl.addEventListener('timeupdate', () => {
        if (!isDraggingTheaterSeek) this._updateTheaterTimelineUi();
      });
      ['loadedmetadata', 'durationchange', 'progress', 'seeked'].forEach((evtName) => {
        this.videoEl.addEventListener(evtName, () => this._updateTheaterTimelineUi());
      });
      this.videoEl.addEventListener('ended', () => {
        syncTheaterPlayBtn();
        document.getElementById('theaterVideoStage')?.classList.remove('osd-idle');
        if (!this.videoEl.loop) {
          const vTotal = this._resolveEffectiveDurationSec(this._resolveLoadedVideoTrack(), this.videoEl);
          if (vTotal > 0) this._updateTheaterTimelineUi(vTotal);
        }
      });
    };
    this._bindVideoTheaterEvents();

    document.addEventListener('keydown', (e) => {
      if (!this.theaterOpen) return;
      const tag = String(e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.key === 'Escape' && !document.fullscreenElement) {
        this.openTheaterStage(false);
      } else if (e.key === ' ' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleTheaterPlayPause();
      } else if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        nudgeVideo(-10);
      } else if (e.key === 'ArrowRight' || e.key.toLowerCase() === 'l') {
        e.preventDefault();
        nudgeVideo(10);
      } else if (e.key === 'ArrowUp' && this.videoEl) {
        e.preventDefault();
        this.videoEl.muted = false;
        this.videoEl.volume = Math.min(1, Number((this.videoEl.volume + 0.05).toFixed(2)));
        syncTheaterVolUi();
        this._flashTheaterFeedback(`🔊 ${Math.round(this.videoEl.volume * 100)}%`);
      } else if (e.key === 'ArrowDown' && this.videoEl) {
        e.preventDefault();
        this.videoEl.volume = Math.max(0, Number((this.videoEl.volume - 0.05).toFixed(2)));
        if (this.videoEl.volume === 0) this.videoEl.muted = true;
        syncTheaterVolUi();
        this._flashTheaterFeedback(this.videoEl.muted ? '🔇 Muted' : `🔊 ${Math.round(this.videoEl.volume * 100)}%`);
      } else if (e.key.toLowerCase() === 'm') {
        muteBtn?.click();
      } else if (e.key.toLowerCase() === 'f') {
        void toggleFullscreen().catch(() => {});
      }
    });
  }

  /**
   * Binds all DOM event listeners.
   */
  bindEvents() {
    document.addEventListener('click', (e) => {
      const colMenu = document.getElementById('rbColumnMenu');
      if (colMenu && !colMenu.classList.contains('hidden') && !colMenu.contains(e.target)) {
        colMenu.classList.add('hidden');
      }
      const genrePop = document.getElementById('rbGenrePopover');
      if (genrePop && !genrePop.classList.contains('hidden') && !genrePop.contains(e.target)) {
        this._closeRbGenrePopover();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this._closeRbGenrePopover();
      }
    });

    // 1. Frameless Window Controls
    document.getElementById('winMinBtn')?.addEventListener('click', () => window.vantaAPI?.windowControl('minimize'));
    document.getElementById('winMaxBtn')?.addEventListener('click', () => window.vantaAPI?.windowControl('maximize'));
    document.getElementById('winCloseBtn')?.addEventListener('click', () => window.vantaAPI?.windowControl('close'));
    document.getElementById('btnOpenVaultRoot')?.addEventListener('click', () => {
      if (window.vantaAPI) window.vantaAPI.openVault('');
      this.setToast('Opened C:\\Vanta\\VantaVault in Windows Explorer');
    });

    document.getElementById('btnOpenLogs')?.addEventListener('click', async () => {
      if (window.vantaAPI) {
        const res = await window.vantaAPI.openLogs();
        this.setToast(`Opened diagnostic log: ${res.logFilePath}`);
      }
    });

    // 2. 3-Theme Switcher (Obsidian, Slate, Ice)
    document.querySelectorAll('[data-theme]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const theme = btn.dataset.theme;
        document.body.classList.remove('theme-slate', 'theme-ice');
        if (theme === 'slate') document.body.classList.add('theme-slate');
        if (theme === 'ice') document.body.classList.add('theme-ice');
        document.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('active', b === btn));
        this.setToast(`Switched Studio Theme to ${theme.toUpperCase()}`);
      });
    });

    // 2B. Native WASAPI Exclusive vs Studio DSP Switcher
    document.querySelectorAll('[data-engine]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void this.setEngineMode(btn.dataset.engine).catch(() => {});
      });
    });

    // 3. Acoustic Device EQ Profile Combo Box (Non-Native DOM Dropdown)
    const profileIcons = {
      'Bit-Perfect (Flat)': '🎧',
      'Harman Target (In-Ear)': '🎯',
      'TWS / AirPods Clarity': '🎵',
      'Headphones Profile': '🎧',
      'Studio Monitors': '🖥️',
      'Cinema Spatial': '🎬',
      'Late-Night Car': '🚗',
      'Concert Hall': '🏛️'
    };
    const profileItems = Object.keys(DEVICE_EQ_PROFILES).map((name) => ({
      value: name,
      label: `${profileIcons[name] || '🎧'} ${name}`,
      displayLabel: `${profileIcons[name] || '🎧'} ${name}`
    }));

    this.setupCustomCombo('deviceProfileCombo', profileItems, this.audioEngine.state.deviceProfile, async (item) => {
      const next = item.value;
      this.audioEngine.state.deviceProfile = next;
      this.audioEngine.syncDspState();
      await this.ensurePlaybackEngineForCurrentDsp(false);
      this._saveProDspSettings();
      this.updateStreamTelemetry();
      this.setToast(`Acoustic Output Profile: ${next}`);
    });

    this.setupStageFxSelector();

    // 4. Pro Smart Focus Filter Bar & In-List Search / Sort
    const syncFilters = () => {
      this.filterState.query = document.getElementById('listSearchInput')?.value || '';
      this.filterState.minBpm = document.getElementById('filterBpmMin')?.value || '';
      this.filterState.maxBpm = document.getElementById('filterBpmMax')?.value || '';
      this.filterState.key = document.getElementById('filterKeySelect')?.value || 'ALL';
      this.filterState.energyBand = document.getElementById('filterEnergySelect')?.value || 'ALL';
      this.filterState.exactStars = Number(document.getElementById('filterStarsSelect')?.value) || 0;
      this.filterState.sortBy = document.getElementById('listSortSelect')?.value || 'default';
      this.applyFiltersAndRender(true);
    };

    ['listSearchInput', 'filterBpmMin', 'filterBpmMax'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', () => {
        clearTimeout(this._filterDebounceTimer);
        this._filterDebounceTimer = setTimeout(syncFilters, 180);
      });
    });
    ['filterKeySelect', 'filterEnergySelect', 'filterStarsSelect', 'listSortSelect'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', syncFilters);
    });

    const favFilterBtn = document.getElementById('btnFilterFavorites');
    favFilterBtn?.addEventListener('click', () => {
      this.filterState.favoriteOnly = !this.filterState.favoriteOnly;
      favFilterBtn.classList.toggle('active', this.filterState.favoriteOnly);
      favFilterBtn.setAttribute('aria-pressed', String(this.filterState.favoriteOnly));
      const favSvg = favFilterBtn.querySelector('svg');
      if (favSvg) favSvg.setAttribute('fill', this.filterState.favoriteOnly ? 'currentColor' : 'none');
      this.applyFiltersAndRender(true);
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('listSearchInput')?.focus();
      }
    });

    document.getElementById('btnResetFilters')?.addEventListener('click', () => {
      this.clearActiveSmartRule();
      this.setToast('Cleared all Smart Focus filters');
    });

    document.getElementById('btnSaveSmartPlaylist')?.addEventListener('click', () => {
      this.openSmartRuleModal(null);
    });

    document.getElementById('btnNewSmartRule')?.addEventListener('click', () => {
      this.openSmartRuleModal(null);
    });

    document.getElementById('btnNewFlowPlaylist')?.addEventListener('click', () => {
      this.flowStudio.open(null);
    });

    document.getElementById('btnClearActiveRule')?.addEventListener('click', () => {
      this.clearActiveSmartRule();
    });

    // 4B. Albums Gallery Toolbar & Detail Drill-Down Controls
    document.querySelectorAll('#albumsModeGroup [data-album-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.albumMode || 'all';
        if (this.albumsMode === nextMode) return;
        this.albumsMode = nextMode;
        this.selectedAlbumId = null;
        this.applyFiltersAndRender(true);
      });
    });

    document.getElementById('albumsSortSelect')?.addEventListener('change', (e) => {
      this.albumsSortBy = e.target.value || 'smart';
      this.renderAlbumsWorkspace();
    });

    document.querySelectorAll('#albumsViewGroup [data-album-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextView = btn.dataset.albumView || 'grid';
        if (this.albumsViewMode === nextView) return;
        this.albumsViewMode = nextView;
        this.selectedAlbumId = null;
        this.applyFiltersAndRender(true);
      });
    });

    document.getElementById('btnAlbumsBack')?.addEventListener('click', () => {
      this.closeAlbumDetail();
    });

    document.getElementById('btnAlbumPlayAll')?.addEventListener('click', () => {
      const audioPool = this._getTracksPoolForNav('tracks');
      const album = buildAlbumCollections(audioPool, { mode: 'all' }).find((a) => a.id === this.selectedAlbumId);
      if (album) this.playAlbumCollection(album, false);
    });

    document.getElementById('btnAlbumShuffle')?.addEventListener('click', () => {
      const audioPool = this._getTracksPoolForNav('tracks');
      const album = buildAlbumCollections(audioPool, { mode: 'all' }).find((a) => a.id === this.selectedAlbumId);
      if (album) this.playAlbumCollection(album, true);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.theaterOpen && !document.fullscreenElement) {
        if (this.activeNav === 'albums' && this.selectedAlbumId) {
          this.closeAlbumDetail();
        } else if (this.activeNav === 'artists' && this.selectedArtistId) {
          this.closeArtistDetail();
        }
      }
    });

    // 4C. Artists Gallery Toolbar & Discography Detail Controls
    document.querySelectorAll('#artistsModeGroup [data-artist-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.artistMode || 'all';
        if (this.artistsMode === nextMode) return;
        this.artistsMode = nextMode;
        this.selectedArtistId = null;
        this.selectedArtistReleaseId = null;
        this.applyFiltersAndRender(true);
      });
    });

    document.getElementById('artistsSortSelect')?.addEventListener('change', (e) => {
      this.artistsSortBy = e.target.value || 'curated';
      this.renderArtistsWorkspace();
    });

    document.querySelectorAll('#artistsViewGroup [data-artist-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextView = btn.dataset.artistView || 'grid';
        if (this.artistsViewMode === nextView) return;
        this.artistsViewMode = nextView;
        this.selectedArtistId = null;
        this.selectedArtistReleaseId = null;
        this.applyFiltersAndRender(true);
      });
    });

    document.getElementById('btnArtistsBack')?.addEventListener('click', () => {
      this.closeArtistDetail();
    });

    document.getElementById('btnArtistPlayAll')?.addEventListener('click', () => {
      const audioPool = this._getTracksPoolForNav('tracks');
      const artist = buildArtistCollections(audioPool, { mode: 'all' }).find((a) => a.id === this.selectedArtistId);
      if (artist) this.playArtistCollection(artist, false);
    });

    document.getElementById('btnArtistShuffle')?.addEventListener('click', () => {
      const audioPool = this._getTracksPoolForNav('tracks');
      const artist = buildArtistCollections(audioPool, { mode: 'all' }).find((a) => a.id === this.selectedArtistId);
      if (artist) this.playArtistCollection(artist, true);
    });

    document.getElementById('btnArtistVibeRadio')?.addEventListener('click', () => {
      const audioPool = this._getTracksPoolForNav('tracks');
      const artist = buildArtistCollections(audioPool, { mode: 'all' }).find((a) => a.id === this.selectedArtistId);
      if (artist) this.startArtistVibeRadio(artist);
    });

    document.getElementById('btnHeroPlayAll')?.addEventListener('click', () => {
      const activeRule = this.smartPlaylists.find((p) => p.id === this.activeSmartPlaylistId);
      if (activeRule) this.playSmartPlaylistRule(activeRule, false);
    });

    document.getElementById('btnHeroShufflePlay')?.addEventListener('click', () => {
      const activeRule = this.smartPlaylists.find((p) => p.id === this.activeSmartPlaylistId);
      if (activeRule) this.playSmartPlaylistRule(activeRule, true);
    });

    document.getElementById('btnHeroExportM3u8')?.addEventListener('click', async () => {
      const activeRule = this.smartPlaylists.find((p) => p.id === this.activeSmartPlaylistId);
      if (!activeRule) return;
      const tracks = this.evaluateSmartPlaylistTracks(activeRule);
      await this.exportPlaylistM3u8(tracks, activeRule.name);
    });

    document.getElementById('btnUploadRuleCover')?.addEventListener('click', async () => {
      if (!window.vantaAPI?.pickPlaylistCover) return;
      const res = await window.vantaAPI.pickPlaylistCover(this.editingSmartRuleId || `draft-${Date.now()}`);
      if (res?.canceled) return;
      if (res?.error || !res?.imagePath) {
        this.setToast(`Cover upload info: ${res?.error || 'Could not load image'}`);
        return;
      }
      this.draftRuleVisual = { mode: 'image', presetKey: this.draftRuleVisual.presetKey || 'synth', imagePath: res.imagePath };
      this._renderCoverSwatches();
      this._updateSmartRulePreview();
    });

    const smartRuleModal = document.getElementById('smartRuleModal');
    const closeSmartRuleModal = () => smartRuleModal?.classList.add('hidden');
    document.getElementById('btnCancelSmartRule')?.addEventListener('click', closeSmartRuleModal);
    document.getElementById('btnSaveSmartRule')?.addEventListener('click', () => this.saveSmartRuleFromModal());
    smartRuleModal?.addEventListener('click', (e) => {
      if (e.target === smartRuleModal) closeSmartRuleModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && smartRuleModal && !smartRuleModal.classList.contains('hidden')) {
        closeSmartRuleModal();
      }
    });
    ['smartRuleNameInput', 'ruleBpmMin', 'ruleBpmMax', 'ruleTagsInput', 'ruleGroupsInput'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', () => this._updateSmartRulePreview());
    });
    ['ruleKeySelect', 'ruleEnergySelect', 'ruleStarsSelect', 'ruleSortSelect', 'ruleFavoriteOnly'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => this._updateSmartRulePreview());
    });

    // Inline Tag (max 3) & Group (max 1) Editor actions + one-click Existing Tag/Group assignment
    const assignMetaToTrack = async (field, rawInput) => {
      const track = this.catalog.find((t) => (t.filePath || t.id) === this.editingTrackKey);
      if (!track) return false;
      const rawVal = String(rawInput || '').trim().replace(/^#/, '').replace(/\s+/g, ' ');
      if (!rawVal) return false;

      if (field === 'groups') {
        track.groups = [rawVal];
        await this.persistTrackAnnotation(track, { groups: [rawVal] });
        this.renderTagFilterOptions();
        this.renderQueue();
        this.setToast(`Assigned group "${rawVal}" to "${track.title}"`);
        return true;
      }

      const list = Array.isArray(track.tags) ? [...track.tags.slice(0, 3)] : [];
      if (list.some((existing) => existing.toLowerCase() === rawVal.toLowerCase())) {
        this.setToast(`Tag #${rawVal} already exists on "${track.title}"`);
        return true;
      }
      if (list.length >= 3) {
        this.setToast('Maximum 3 tags per track — remove one with × first');
        return false;
      }
      list.push(rawVal);
      track.tags = list;
      await this.persistTrackAnnotation(track, { tags: list });
      this.renderTagFilterOptions();
      this.renderQueue();
      this.setToast(`Added #${rawVal} to "${track.title}"`);
      return true;
    };

    const addMetaToEditingTrack = async (field) => {
      const inputId = field === 'tags' ? 'tagInputField' : 'groupInputField';
      const inputEl = document.getElementById(inputId);
      const ok = await assignMetaToTrack(field, inputEl?.value || '');
      if (ok && inputEl) inputEl.value = '';
    };

    document.getElementById('btnConfirmAddTag')?.addEventListener('click', () => addMetaToEditingTrack('tags'));
    document.getElementById('btnConfirmAddGroup')?.addEventListener('click', () => addMetaToEditingTrack('groups'));
    document.getElementById('existingTagSelect')?.addEventListener('change', async (e) => {
      const sel = e.target;
      if (sel.value) {
        await assignMetaToTrack('tags', sel.value);
        sel.value = '';
      }
    });
    document.getElementById('existingGroupSelect')?.addEventListener('change', async (e) => {
      const sel = e.target;
      if (sel.value) {
        await assignMetaToTrack('groups', sel.value);
        sel.value = '';
      }
    });
    document.getElementById('tagInputField')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void addMetaToEditingTrack('tags').catch(() => {});
    });
    document.getElementById('groupInputField')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void addMetaToEditingTrack('groups').catch(() => {});
    });
    document.getElementById('btnCloseTagEditor')?.addEventListener('click', () => {
      document.getElementById('inlineTagEditor')?.classList.add('hidden');
      this.editingTrackKey = null;
    });

    // 5. Left Sidebar Navigation Items (data-nav items only)
    document.querySelectorAll('.sidebar .nav-item[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => this.handleSidebarSwitch(btn.dataset.nav));
    });

    // 6. Format Selector in YouTube Batch Bar
    document.querySelectorAll('#formatSelectorGroup .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.selectedExportFormat = btn.dataset.format;
        document.querySelectorAll('#formatSelectorGroup .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
        this.setToast(`Batch Target Format: ${this.selectedExportFormat}`);
      });
    });

    // 7. YouTube Multi-URL / ID Batch Download Button
    document.getElementById('btnRunBatchDownload')?.addEventListener('click', () => this.runUniversalBatch());
    document.getElementById('btnQuickSaveTrack')?.addEventListener('click', () => this.runUniversalBatch());

    // 8. Left Sidebar SOURCES Actions (Split Computer Explorer + Refresh + Hidden Folder Restore + SACD ISO Import)
    document.getElementById('btnImportSacdIso')?.addEventListener('click', () => {
      void this.importSacdIsoFiles('').catch(() => {});
    });

    document.getElementById('btnRefreshExplorer')?.addEventListener('click', async () => {
      await this.refreshComputerExplorer(false);
    });

    document.getElementById('btnExplorerHiddenMgr')?.addEventListener('click', () => {
      document.getElementById('explorerHiddenPopover')?.classList.toggle('hidden');
    });

    document.getElementById('btnCloseHiddenPopover')?.addEventListener('click', () => {
      document.getElementById('explorerHiddenPopover')?.classList.add('hidden');
    });

    document.getElementById('btnRestoreAllHiddenDirs')?.addEventListener('click', async () => {
      await this.restoreExplorerFolders([], true);
    });

    // Internal Computer Explorer + External Windows Explorer Drag-and-Drop onto Playlist Panel
    const queuePanelEl = document.getElementById('queuePanel');
    if (queuePanelEl) {
      queuePanelEl.addEventListener('dragover', (e) => {
        const types = Array.from(e.dataTransfer?.types || []);
        if (types.includes('application/x-vanta-paths') || types.includes('Files')) {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          queuePanelEl.classList.add('drop-target-active');
        }
      });

      queuePanelEl.addEventListener('dragleave', (e) => {
        if (!queuePanelEl.contains(e.relatedTarget)) {
          queuePanelEl.classList.remove('drop-target-active');
        }
      });

      queuePanelEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        queuePanelEl.classList.remove('drop-target-active');

        const internalJson = e.dataTransfer?.getData('application/x-vanta-paths');
        if (internalJson) {
          try {
            const paths = JSON.parse(internalJson);
            if (Array.isArray(paths) && paths.length) {
              await this.addPathsToPlaylist(paths, false);
              return;
            }
          } catch {
            // Fall through if malformed internal drag payload
          }
        }

        const droppedFiles = Array.from(e.dataTransfer?.files || []);
        if (droppedFiles.length) {
          const extPaths = droppedFiles
            .map((f) => window.vantaAPI?.getPathForFile?.(f) || f.path || '')
            .filter(Boolean);
          if (extPaths.length) {
            await this.addPathsToPlaylist(extPaths, false);
          }
        }
      });
    }

    document.getElementById('btnExportWallet')?.addEventListener('click', async () => {
      if (!window.vantaAPI) return;
      const stats = buildTimeCapsuleAnalytics(this.catalog);
      const res = await window.vantaAPI.exportWallet({
        tracks: this.catalog,
        timeCapsule: stats
      });
      this.setToast(`Exported Portable Music Wallet to ${res.walletPath}`);
    });

    document.getElementById('btnRepairDoctorInline')?.addEventListener('click', async () => {
      if (!window.vantaAPI) return;
      const res = await window.vantaAPI.repairDoctor();
      this.mergeVaultCatalog(res.catalog, res.doctor);
      this.setToast(`Quality Doctor repaired ${res.repairResult.repairedCount} items in C:\\Vanta\\VantaVault`);
    });

    const clearModal = document.getElementById('confirmClearModal');
    const clearModalMsg = document.getElementById('clearModalMessage');
    const closeClearModal = () => clearModal?.classList.add('hidden');

    document.getElementById('btnClearPlaylist')?.addEventListener('click', () => {
      if (!this.catalog.length || !clearModal) return;
      if (clearModalMsg) {
        clearModalMsg.textContent = `All ${this.catalog.length.toLocaleString()} tracks will be removed from your VANTA playlist and queue.`;
      }
      clearModal.classList.remove('hidden');
      document.getElementById('btnCancelClearModal')?.focus();
    });
    document.getElementById('btnCancelClearModal')?.addEventListener('click', closeClearModal);
    document.getElementById('btnConfirmClearModal')?.addEventListener('click', async () => {
      closeClearModal();
      await this.clearEntirePlaylist();
    });
    clearModal?.addEventListener('click', (e) => {
      if (e.target === clearModal) closeClearModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && clearModal && !clearModal.classList.contains('hidden')) {
        closeClearModal();
      }
    });

    // 10. Right Studio Dock 4-Mode Stage Switcher & 5-Mode Pro Visualizer Switcher
    document.querySelectorAll('#stageModeSwitcher .seg-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.switchStage(btn.dataset.stage));
    });

    const vizLabels = {
      prism: 'VANTA Aurora Prism (3D Topography)',
      rta: 'RTA Spectrum + Peak Hold',
      vu: 'Stereo L/R VU & Peak Meter'
    };
    document.querySelectorAll('#vizModeSwitcher .viz-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.viz === this.visualizer.mode);
      btn.addEventListener('click', () => {
        const mode = btn.dataset.viz;
        this.visualizer.setMode(mode);
        document.querySelectorAll('#vizModeSwitcher .viz-pill').forEach((b) => {
          b.classList.toggle('active', b.dataset.viz === mode);
        });
        this.setToast(`Analyzer View: ${vizLabels[mode] || mode.toUpperCase()}`);
      });
    });

    // 11. Picture-in-Picture Video Button + 4K Theater Stage Bindings
    this.bindTheaterEvents();
    document.getElementById('btnTogglePiP')?.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else if (this.videoEl && this.videoEl.readyState >= 1) {
          await this.videoEl.requestPictureInPicture();
        } else {
          this.setToast('Load an MP4 Video Clip to enter Picture-in-Picture mode');
        }
      } catch (err) {
        this.setToast(`PiP info: ${err.message}`);
      }
    });

    // 12. All DSP Feature Chips & Studio Pro DSP Rack Modal
    document.querySelectorAll('[data-dsp]').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const flag = chip.dataset.dsp;
        this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
        const active = this.audioEngine.toggleDspFlag(flag);
        this._syncAllDspUi();
        this._saveProDspSettings();

        if (flag === 'lufs') {
          if (active && this.audioEngine.state.replayGainMode === 'off') {
            this.audioEngine.state.replayGainMode = 'track';
            this.audioEngine.syncDspState();
            this._syncAllDspUi();
            this._saveProDspSettings();
          }
          const gain = this.getEffectiveReplayGain();
          this.audioEngine.setReplayGainLinear(gain);
          if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
            window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
          }
          this.updateStreamTelemetry();
          const rgTarget = Number(this.audioEngine.state.replayGainTargetLufs) === -14 ? -14 : -18;
          const rgMode = String(this.audioEngine.state.replayGainMode || 'track').toUpperCase();
          this.setToast(`ReplayGain 2.0 (${rgMode} @ ${rgTarget}.0 LUFS) ${active ? 'ENABLED' : 'BYPASSED (UNITY 0dB)'}`);
          return;
        }

        const studioOnlyFlags = new Set(['spatial', 'exciter', 'reverb', 'karaoke', 'vinyl', 'saturation', 'nightMode']);
        await this.ensurePlaybackEngineForCurrentDsp(active && studioOnlyFlags.has(flag));
        if (flag === 'vinyl' && active) this.switchStage('vinyl');
        if (flag === 'karaoke' && active) this.switchStage('lyrics');
        this.setToast(`DSP [${flag.toUpperCase()}] ${active ? 'ENABLED' : 'BYPASSED'}`);
      });
    });

    const toggleStudioPreset = async (forceEnable = null) => {
      this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
      const st = this.audioEngine.state;
      const currentlyStudio = Boolean(st.lufs || st.limiter);
      const nextEnable = forceEnable !== null ? Boolean(forceEnable) : !currentlyStudio;
      if (nextEnable) {
        this.audioEngine.applyStudioDspPreset();
      } else {
        this.audioEngine.resetBitPerfect();
        if (this.engineMode === 'wasapi' && window.vantaAPI) {
          void this.syncNativeConvolver(false).catch(() => {});
        }
      }
      this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
      this._syncAllDspUi();
      this._saveProDspSettings();
      await this.ensurePlaybackEngineForCurrentDsp(false);
      if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
        window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
      }
      this.updateStreamTelemetry();
      this.setToast(nextEnable ? 'Studio DSP Preset ENABLED (EBU R128 + True-Peak Limiter)' : 'Bit-Perfect Pure ENABLED (Zero LUFS · Zero Limiter)');
    };

    document.getElementById('btnStudioDspPreset')?.addEventListener('click', () => {
      void toggleStudioPreset(null).catch(() => {});
    });

    document.getElementById('btnApplyStudioPreset')?.addEventListener('click', () => {
      void toggleStudioPreset(true).catch(() => {});
    });

    this._bindDspRackModal();
    this._bindSignalPathModal();
    this._bindAbxModal();

    document.getElementById('btnCopyLyrics')?.addEventListener('click', async () => {
      const text = this._currentFormattedLyrics || '';
      if (!text) return;
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          copied = document.execCommand('copy');
        } catch {
          copied = false;
        }
        ta.remove();
      }
      if (copied) {
        const btn = document.getElementById('btnCopyLyrics');
        const labelEl = btn?.querySelector('.lyrics-copy-label');
        if (btn) btn.classList.add('copied');
        if (labelEl) labelEl.textContent = 'Copied';
        clearTimeout(this._copyLyricsTimer);
        this._copyLyricsTimer = setTimeout(() => {
          btn?.classList.remove('copied');
          if (labelEl) labelEl.textContent = 'Copy';
        }, 1600);
        this.setToast('Lyrics copied to clipboard');
      } else {
        this.setToast('Unable to copy lyrics to clipboard');
      }
    });

    document.getElementById('btnKaraokeStageToggle')?.addEventListener('click', async () => {
      this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
      const active = this.audioEngine.toggleDspFlag('karaoke');
      document.querySelectorAll('[data-dsp="karaoke"]').forEach((c) => c.classList.toggle('on', active));
      if (active && this.engineMode === 'wasapi') {
        await this.setEngineMode('dsp', true);
      } else if (this.engineMode === 'dsp') {
        await this.audioEngine.resumeEngine();
      }
      this.setToast(`Karaoke Lead Vocal Cancellation: ${active ? 'ACTIVE (-18dB Center)' : 'OFF'}`);
    });

    const dopBtn = document.getElementById('btnToggleDop');
    if (dopBtn) {
      dopBtn.classList.toggle('on', this.dopEnabled);
      dopBtn.addEventListener('click', async () => {
        this.dopEnabled = !this.dopEnabled;
        dopBtn.classList.toggle('on', this.dopEnabled);
        try {
          globalThis.localStorage?.setItem('vanta_dop_enabled_v1', this.dopEnabled ? '1' : '0');
        } catch {
          // Ignore storage errors
        }
        this.setToast(
          this.dopEnabled
            ? 'Native DoP v1.1 ENABLED (Bit-exact DSD64/128/256 over WASAPI Exclusive · Auto-DXD fallback if unsupported)'
            : 'Native DoP v1.1 OFF (DSF/DFF decoded as Studio DXD PCM)'
        );
        const track = this.displayedTracks[this.activeTrackIndex];
        const isDsd = Boolean(track?.sacdTrack >= 1 || (track?.filePath && /\.(?:dsf|dff|wv)$/i.test(track.filePath)));
        if (this.isPlaying && this.engineMode === 'wasapi' && isDsd) {
          await this.startPlayback(this.wasapiCurrentPositionSec || 0);
        }
      });
    }

    // 13. Bottom Master Transport Controls, Back-to-Last-Played, Seek +/-10s, Repeat, Volume & Dual-Deck Crossfade
    document.getElementById('btnLastPlayedTrack')?.addEventListener('click', () => this.goBackToLastPlayedTrack());
    this._updateLastPlayedButton();
    document.getElementById('btnPlayPause')?.addEventListener('click', () => this.togglePlay());
    document.getElementById('btnPrevTrack')?.addEventListener('click', () => this.stepTrack(-1));
    document.getElementById('btnNextTrack')?.addEventListener('click', () => this.stepTrack(1));
    document.getElementById('btnSeekBack10')?.addEventListener('click', () => this.seekRelative(-10));
    document.getElementById('btnSeekForward10')?.addEventListener('click', () => this.seekRelative(10));
    document.getElementById('btnRepeatMode')?.addEventListener('click', () => this.cycleRepeatMode());
    document.getElementById('btnRepeatMode')?.classList.toggle('active', this.repeatMode !== 'off');

    document.getElementById('btnShuffle')?.addEventListener('click', () => {
      this.displayedTracks.sort(() => Math.random() - 0.5);
      this.activeTrackIndex = 0;
      this.renderQueue();
      this.setToast('Queue Shuffled');
    });

    document.getElementById('btnVolumeMute')?.addEventListener('click', () => this.toggleMute());
    const volSlider = document.getElementById('masterVolumeSlider');
    volSlider?.addEventListener('input', (e) => {
      this.setMasterVolume(Number(e.target.value), true);
    });
    document.getElementById('volumeControlGroup')?.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = e.deltaY < 0 ? 5 : -5;
      this.setMasterVolume(this.masterVolumePct + step, true);
    }, { passive: false });

    document.getElementById('crossfadeSelect')?.addEventListener('change', (e) => {
      const sec = Number(e.target.value) || 0;
      this.audioEngine.setCrossfadeSeconds(sec);
      if (sec > 0 && this.engineMode === 'wasapi') {
        void this.setEngineMode('dsp', true).catch(() => {});
      }
      this.setToast(sec > 0 ? `Dual-Deck Equal-Power Crossfade: ${sec.toFixed(1)}s` : 'Gapless Playback (0.0s Cut)');
    });

    const speedBtn = document.getElementById('btnPlaybackSpeed');
    const speeds = [1.0, 1.15, 1.25, 0.86];
    speedBtn?.addEventListener('click', () => {
      const cur = this.audioEngine.state.playbackRate;
      const next = speeds[(speeds.indexOf(cur) + 1) % speeds.length];
      this.audioEngine.state.playbackRate = next;
      if (Math.abs(next - 1.0) > 0.001 && this.engineMode === 'wasapi') {
        void this.setEngineMode('dsp', true).catch(() => {});
      }
      [this.audioEl, this.deckBEl].forEach((deck) => {
        if (!deck) return;
        deck.preservesPitch = Math.abs(next - 1.0) < 0.001;
        deck.playbackRate = next;
      });
      if (this.videoEl) {
        this.videoEl.playbackRate = next;
      }
      speedBtn.textContent = `${next.toFixed(2)}x`;
      this.setToast(next < 1 ? `Slowed + Reverb Tape Speed (${next}x)` : `Playback Speed: ${next.toFixed(2)}x`);
    });

    // 14. Pro Interactive Scrubber (Drag Seek + Hover Preview Tip) & Wave Canvas Scrubbing
    const getActiveTotalDuration = () => {
      const track = this.displayedTracks[this.activeTrackIndex];
      const activeDeck = this.audioEngine.getActiveDeckElement() || this.audioEl;
      const activeMedia = track?.isVideo ? this.videoEl : activeDeck;
      if (this.engineMode === 'wasapi' && track?.filePath && !track.isVideo) {
        return this._resolveEffectiveDurationSec(track, null) || 232;
      }
      return this._resolveEffectiveDurationSec(track, activeMedia) || 232;
    };

    const seekToRatio = (ratio, triggerPlay = true) => {
      const clamped = Math.max(0.0, Math.min(0.995, ratio));
      const totalSec = getActiveTotalDuration();
      this.seekToSeconds(totalSec * clamped, triggerPlay);
    };
    this._getActiveTotalDuration = getActiveTotalDuration;

    const timelineTrack = document.getElementById('masterTimelineTrack');
    const hoverTip = document.getElementById('timelineHoverTip');
    let isDraggingTimeline = false;

    const ratioFromClientX = (el, clientX) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    };

    timelineTrack?.addEventListener('pointerdown', (e) => {
      isDraggingTimeline = true;
      timelineTrack.classList.add('dragging');
      timelineTrack.setPointerCapture?.(e.pointerId);
      const ratio = ratioFromClientX(timelineTrack, e.clientX);
      const totalSec = getActiveTotalDuration();
      this.updateTimelineUi(totalSec * ratio, totalSec);
    });

    timelineTrack?.addEventListener('pointermove', (e) => {
      const ratio = ratioFromClientX(timelineTrack, e.clientX);
      const totalSec = getActiveTotalDuration();
      const previewSec = Math.floor(totalSec * ratio);
      if (hoverTip) {
        hoverTip.classList.remove('hidden');
        hoverTip.style.left = `${(ratio * 100).toFixed(2)}%`;
        hoverTip.textContent = `${String(Math.floor(previewSec / 60)).padStart(2, '0')}:${String(previewSec % 60).padStart(2, '0')}`;
      }
      if (isDraggingTimeline) {
        this.updateTimelineUi(totalSec * ratio, totalSec);
      }
    });

    const finishDrag = (e) => {
      if (!isDraggingTimeline) return;
      isDraggingTimeline = false;
      timelineTrack.classList.remove('dragging');
      const ratio = ratioFromClientX(timelineTrack, e.clientX);
      seekToRatio(ratio, true);
    };
    timelineTrack?.addEventListener('pointerup', finishDrag);
    timelineTrack?.addEventListener('pointercancel', () => {
      isDraggingTimeline = false;
      timelineTrack.classList.remove('dragging');
    });
    timelineTrack?.addEventListener('pointerleave', () => {
      hoverTip?.classList.add('hidden');
    });

    this.canvasEl?.addEventListener('click', (e) => {
      const ratio = ratioFromClientX(e.currentTarget, e.clientX);
      seekToRatio(ratio, true);
    });

    const bindDeckTimeline = (mediaEl) => {
      if (!mediaEl || this._boundDeckElements.has(mediaEl)) return;
      this._boundDeckElements.add(mediaEl);

      const syncDeckProgress = () => {
        const track = this.displayedTracks[this.activeTrackIndex];
        const expectedDeck = track?.isVideo ? this.videoEl : (this.audioEngine.getActiveDeckElement() || this.audioEl);
        if (mediaEl !== expectedDeck) return;
        if (!track?.isVideo && this.engineMode === 'wasapi') return;

        const actualCur =
          this._pendingStudioSeekSec !== null && !this.isPlaying
            ? this._pendingStudioSeekSec
            : (this._getMediaSeekOffsetSec(track) + (mediaEl.currentTime || 0));
        const totalDur = this._resolveEffectiveDurationSec(track, mediaEl);
        if (!totalDur) return;

        this.updateTimelineUi(actualCur, totalDur);

        // Dual-Deck Equal-Power Crossfade pre-roll trigger
        const fadeSec = this.audioEngine.state.crossfadeSeconds || 0;
        const remaining = totalDur - actualCur;
        if (
          this.isPlaying &&
          fadeSec > 0 &&
          !track?.isVideo &&
          !this.crossfadeTriggeredForTrack &&
          this.displayedTracks.length > 1 &&
          remaining <= fadeSec &&
          remaining > 0.25
        ) {
          const nextIdx = (this.activeTrackIndex + 1) % this.displayedTracks.length;
          const nextTrack = this.displayedTracks[nextIdx];
          if (nextTrack?.filePath && !nextTrack.isVideo) {
            this.crossfadeTriggeredForTrack = true;
            const nextUrl = `vanta-media://local?path=${encodeURIComponent(nextTrack.filePath)}`;
            void this.audioEngine.crossfadeToNext(nextUrl, fadeSec, this.getEffectiveReplayGain()).catch(() => {});
            this.activeTrackIndex = nextIdx;
            this.activeTrackProbe = null;
            this.activeTrackR128 = null;
            this.studioSeekOffsetSec = 0;
            this._pendingStudioSeekSec = null;
            document.getElementById('dockTrackTitle').textContent = nextTrack.title;
            document.getElementById('dockTrackSubtitle').textContent = `${nextTrack.artist} · ${nextTrack.bpm} BPM · ${nextTrack.key}`;
            this.renderQueue();
            void this.probeActiveTrack(nextTrack).catch(() => {});
            this.setToast(`Crossfading (${fadeSec}s) -> ${nextTrack.title}`);
            setTimeout(() => {
              this.crossfadeTriggeredForTrack = false;
            }, Math.max(500, fadeSec * 1000));
          }
        }
      };

      mediaEl.addEventListener('timeupdate', () => {
        if (!isDraggingTimeline) syncDeckProgress();
      });
      ['loadedmetadata', 'durationchange', 'seeked'].forEach((evtName) => {
        mediaEl.addEventListener(evtName, () => {
          if (!isDraggingTimeline) syncDeckProgress();
        });
      });

      mediaEl.addEventListener('ended', () => {
        const track = this.displayedTracks[this.activeTrackIndex];
        const expectedDeck = track?.isVideo ? this.videoEl : (this.audioEngine.getActiveDeckElement() || this.audioEl);
        if (mediaEl === expectedDeck && !this.crossfadeTriggeredForTrack) {
          const totalDur = this._resolveEffectiveDurationSec(track, mediaEl);
          this.handleTrackEnded();
          if (!this.isPlaying) {
            this._setMediaSeekOffsetSec(track, 0);
            this._pendingStudioSeekSec = null;
            if (totalDur > 0) this.updateTimelineUi(totalDur, totalDur);
          }
        }
      });
    };

    this._bindMediaEvents = () => {
      bindDeckTimeline(this.audioEl);
      bindDeckTimeline(this.deckBEl);
      bindDeckTimeline(this.videoEl);
    };
    this._bindMediaEvents();
  }

  /**
   * Wires the Studio Pro Audio DSP Rack modal (10-band EQ presets, sliders, pitch shift, Bit-Perfect reset).
   */
  _bindDspRackModal() {
    const modal = document.getElementById('dspRackModal');
    const openBtn = document.getElementById('btnOpenDspRack');
    const closeBtn = document.getElementById('btnCloseDspRack');
    if (!modal) return;

    const closeModal = () => modal.classList.add('hidden');
    openBtn?.addEventListener('click', () => {
      this.renderEqColumns();
      this._syncAllDspUi();
      modal.classList.remove('hidden');
    });
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });

    // Populate EQ preset pills cleanly
    const presetRow = document.getElementById('dspEqPresetRow');
    if (presetRow) {
      presetRow.replaceChildren();
      Object.keys(EQ_PRESETS).forEach((presetName) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.dataset.eqPreset = presetName;
        btn.textContent = presetName;
        btn.addEventListener('click', async () => {
          this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
          this.audioEngine.applyEqPreset(presetName);
          await this.ensurePlaybackEngineForCurrentDsp(false);
          this.renderEqColumns();
          this._syncAllDspUi();
          this._saveProDspSettings();
          this.updateStreamTelemetry();
          this.setToast(`10-Band EQ Preset: ${presetName}`);
        });
        presetRow.appendChild(btn);
      });
    }

    // Bind fine DSP parameter sliders
    const sliderBindings = [
      { id: 'dspSpatialWidth', param: 'spatialWidthPct', flag: 'spatial', studioOnly: true },
      { id: 'dspCrossfeedLevel', param: 'crossfeedLevelPct', flag: 'crossfeed', studioOnly: false },
      { id: 'dspBassBoostDb', param: 'bassBoostDb', flag: 'bassBoost', studioOnly: false },
      { id: 'dspExciterMix', param: 'exciterMixPct', flag: 'exciter', studioOnly: true },
      { id: 'dspReverbMix', param: 'reverbMixPct', flag: 'reverb', studioOnly: true },
      { id: 'dspPitchSemitones', param: 'pitchSemitones', flag: null, studioOnly: true }
    ];
    for (const cfg of sliderBindings) {
      document.getElementById(cfg.id)?.addEventListener('input', async (e) => {
        const num = Number(e.target.value);
        this.audioEngine.bindElements(this.audioEl, this.videoEl, this.deckBEl);
        if (cfg.flag && !this.audioEngine.state[cfg.flag]) {
          this.audioEngine.state[cfg.flag] = true;
        }
        this.audioEngine.setDspParam(cfg.param, num);
        const needsStudio = cfg.studioOnly && (Boolean(cfg.flag) || Math.abs(num) > 0);
        await this.ensurePlaybackEngineForCurrentDsp(needsStudio);
        this._syncAllDspUi();
        this._saveProDspSettings();
      });
    }

    document.getElementById('btnResetPitch')?.addEventListener('click', () => {
      this.audioEngine.setDspParam('pitchSemitones', 0);
      this._syncAllDspUi();
      this._saveProDspSettings();
      this.updateStreamTelemetry();
      this.setToast('Pitch Key Shift reset to 0 st');
    });

    document.getElementById('btnResetBitPerfect')?.addEventListener('click', () => {
      this.audioEngine.resetBitPerfect();
      const profLabel = document.querySelector('#deviceProfileCombo .vanta-combo-label');
      if (profLabel) profLabel.textContent = '🎧 Bit-Perfect (Flat)';
      this.renderEqColumns();
      this._syncAllDspUi();
      this._saveProDspSettings();
      this.syncNativeWasapiDsp();
      void this.syncNativeConvolver(false).catch(() => {});
      this.updateStreamTelemetry();
      this.setToast('DSP reset to Bit-Perfect Pure (Unity 0 dB · PEQ/Convolver/LUFS/Limiter OFF)');
    });

    const restartWasapiIfActive = () => {
      if (this.engineMode === 'wasapi' && this.isPlaying && this.currentLoadedTrack && !this.currentLoadedTrack.isVideo) {
        const resumePos = Math.max(0, Number(this.wasapiCurrentPositionSec) || 0);
        void this.startPlayback(resumePos).catch(() => {});
      }
    };

    document.getElementById('btnWasapiModeEvent')?.addEventListener('click', () => {
      this.wasapiPushMode = false;
      this._saveAudioPrefs();
      this._syncAllDspUi();
      restartWasapiIfActive();
      this.setToast('WASAPI Transport: Event-Driven (Low Jitter)');
    });

    document.getElementById('btnWasapiModePush')?.addEventListener('click', () => {
      this.wasapiPushMode = true;
      this._saveAudioPrefs();
      this._syncAllDspUi();
      restartWasapiIfActive();
      this.setToast('WASAPI Transport: Push Mode (Universal Compatibility)');
    });

    document.getElementById('btnToggleHoldOnPause')?.addEventListener('click', () => {
      this.holdWasapiOnPause = !this.holdWasapiOnPause;
      this._saveAudioPrefs();
      if (!this.holdWasapiOnPause && this.wasapiPausedHeld && window.vantaAPI) {
        this.wasapiPausedHeld = false;
        window.vantaAPI.wasapiCmd('STOP').catch(() => {});
        this.wasapiStatusMode = 'WASAPI EXCLUSIVE (RELEASED)';
      }
      this._syncAllDspUi();
      this.updateStreamTelemetry();
      this.setToast(
        this.holdWasapiOnPause
          ? 'Pause Mode: Hold WASAPI Device (0 ms Resume)'
          : 'Pause Mode: Release DAC on Pause (Recommended)'
      );
    });

    document.querySelectorAll('[data-vol-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.volMode;
        if (!['auto', 'software', 'fixed0db'].includes(mode)) return;
        this.audioEngine.state.volumeMode = mode;
        this._saveProDspSettings();
        this._syncAllDspUi();
        if (window.vantaAPI && this.engineMode === 'wasapi' && this.isPlaying) {
          window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
        }
        const studioVol = mode === 'fixed0db' ? (this.isMuted ? 0 : 1.0) : (mode === 'auto' ? (this.isMuted ? 0 : 1.0) : (this.isMuted ? 0 : this.masterVolumeLinear));
        this.audioEngine.setVolume(studioVol);
        this.updateStreamTelemetry();
        this.setToast(`Volume Mode: ${btn.textContent.trim()}`);
      });
    });

    document.getElementById('btnToggleFixedRateLock')?.addEventListener('click', () => {
      this.fixedRateLock = !this.fixedRateLock;
      this._saveAudioPrefs();
      this._syncAllDspUi();
      restartWasapiIfActive();
      this.setToast(this.fixedRateLock ? `Fixed Rate Lock: ${this.fixedTargetRate} Hz` : 'Sample Rate: Native Auto Match');
    });

    document.getElementById('selectFixedTargetRate')?.addEventListener('change', (e) => {
      const rate = Number(e.target.value) || 48000;
      this.fixedTargetRate = rate;
      this._saveAudioPrefs();
      this._syncAllDspUi();
      if (this.fixedRateLock) restartWasapiIfActive();
      this.setToast(`Locked Target Rate set to ${rate} Hz`);
    });

    document.querySelectorAll('[data-output-backend]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const backend = btn.dataset.outputBackend === 'asio' ? 'asio' : 'wasapi';
        if (backend === 'asio' && (!this.asioDevices || !this.asioDevices.length)) {
          await this.populateAsioDevices();
          if (!this.asioDevices.length) {
            this.setToast('No ASIO drivers found on Windows — staying on WASAPI Exclusive');
            return;
          }
        }
        this.outputBackend = backend;
        this._saveAudioPrefs();
        this._syncAllDspUi();
        restartWasapiIfActive();
        this.updateStreamTelemetry();
        this.setToast(
          backend === 'asio'
            ? `Output Backend: Isolated ASIO Host (${this.asioDriver || this.asioDevices?.[0]?.name || 'Auto'})`
            : 'Output Backend: Windows WASAPI Exclusive'
        );
      });
    });

    document.getElementById('selectAsioDriver')?.addEventListener('change', (e) => {
      this.asioDriver = String(e.target.value || '');
      this._saveAudioPrefs();
      this._syncAllDspUi();
      if (this.outputBackend === 'asio') restartWasapiIfActive();
      this.updateStreamTelemetry();
      this.setToast(`ASIO Driver selected: ${this.asioDriver || 'Auto'}`);
    });

    document.getElementById('btnToggleAsioRawDsd')?.addEventListener('click', () => {
      this.asioRawDsd = !this.asioRawDsd;
      this._saveAudioPrefs();
      this._syncAllDspUi();
      if (this.outputBackend === 'asio') restartWasapiIfActive();
      this.updateStreamTelemetry();
      this.setToast(
        this.asioRawDsd
          ? 'ASIO Native Raw DSD512/1024 ENABLED (Direct ASIOSTDSDInt8 hardware path)'
          : 'ASIO Native Raw DSD OFF (Uses DoP v1.1 or 64-bit DXD PCM)'
      );
    });

    document.querySelectorAll('[data-rg-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.rgMode;
        if (!['off', 'track', 'album'].includes(mode)) return;
        this.audioEngine.state.replayGainMode = mode;
        this.audioEngine.state.lufs = mode !== 'off';
        this.audioEngine.syncDspState();
        this._saveProDspSettings();
        this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
        if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
          window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
        }
        this._syncAllDspUi();
        this.updateStreamTelemetry();
        this.setToast(mode === 'off' ? 'ReplayGain 2.0: OFF (Unity 0 dBFS)' : `ReplayGain 2.0 Mode: ${mode.toUpperCase()}`);
      });
    });

    document.querySelectorAll('[data-rg-lufs]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lufs = Number(btn.dataset.rgLufs) === -14 ? -14 : -18;
        this.audioEngine.state.replayGainTargetLufs = lufs;
        if (!this.audioEngine.state.lufs || this.audioEngine.state.replayGainMode === 'off') {
          this.audioEngine.state.lufs = true;
          if (this.audioEngine.state.replayGainMode === 'off') {
            this.audioEngine.state.replayGainMode = 'track';
          }
        }
        this.audioEngine.syncDspState();
        this._saveProDspSettings();
        this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
        if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
          window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
        }
        this._syncAllDspUi();
        this.updateStreamTelemetry();
        this.setToast(`ReplayGain 2.0 Reference: ${lufs}.0 LUFS`);
      });
    });

    document.getElementById('btnAnalyzeAlbumRg')?.addEventListener('click', () => {
      void this.analyzeActiveAlbumReplayGain().catch(() => {});
    });

    document.querySelectorAll('[data-preroll-ms]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const ms = Number(btn.dataset.prerollMs) || 0;
        this.clockSwitchPreRollMs = ms;
        this._saveAudioPrefs();
        this._syncAllDspUi();
        this.updateStreamTelemetry();
        this.setToast(`Clock-Switch Pre-Roll Silence: ${ms} ms`);
      });
    });

    const bufSlider = document.getElementById('wasapiBufferMsSlider');
    bufSlider?.addEventListener('input', (e) => {
      const ms = Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0)));
      this.wasapiBufferMs = ms;
      const valEl = document.getElementById('wasapiBufferMsVal');
      if (valEl) valEl.textContent = ms > 0 ? `${ms} ms` : 'Auto';
    });
    bufSlider?.addEventListener('change', () => {
      this._saveAudioPrefs();
      this._syncAllDspUi();
      restartWasapiIfActive();
      this.setToast(`WASAPI Buffer Override: ${this.wasapiBufferMs > 0 ? `${this.wasapiBufferMs} ms` : 'Auto'}`);
    });

    // Precision 64-bit AutoEQ / EqualizerAPO (.txt) Parametric EQ controls
    document.getElementById('btnImportAutoEqTxt')?.addEventListener('click', async () => {
      if (!window.vantaAPI?.importAutoEqTxt) return;
      const res = await window.vantaAPI.importAutoEqTxt();
      if (!res || res.canceled) return;
      if (!res.ok || !res.text) {
        this.setToast(`AutoEQ import failed: ${res.error || 'Could not read filter file'}`);
        return;
      }
      const parsed = parseAutoEqTxt(res.text);
      if (!parsed.bands.length) {
        this.setToast(`No valid EqualizerAPO Filter lines found in ${res.fileName || 'selected file'}`);
        return;
      }
      const cleanName = String(res.fileName || 'AutoEQ').replace(/\.txt$/i, '');
      this.audioEngine.applyAutoEqProfile({
        enabled: true,
        name: cleanName,
        preampDb: parsed.preampDb,
        bands: parsed.bands
      });
      this._syncAllDspUi();
      this._saveProDspSettings();
      await this.ensurePlaybackEngineForCurrentDsp(false);
      this.setToast(`Loaded AutoEQ "${cleanName}" (${parsed.bands.length} bands · Preamp ${parsed.preampDb.toFixed(1)} dB)`);
    });

    document.getElementById('btnTogglePeqActive')?.addEventListener('click', async () => {
      const st = this.audioEngine.state;
      if (!Array.isArray(st.peqBands) || st.peqBands.length === 0) return;
      st.peqEnabled = !st.peqEnabled;
      this.audioEngine._rebuildStudioPeqGraph();
      this.audioEngine.syncDspState();
      this._syncAllDspUi();
      this._saveProDspSettings();
      await this.ensurePlaybackEngineForCurrentDsp(false);
      this.setToast(st.peqEnabled ? `AutoEQ "${st.peqName || 'PEQ'}" ENABLED` : 'AutoEQ PEQ Bypassed');
    });

    document.getElementById('btnClearAutoEq')?.addEventListener('click', async () => {
      this.audioEngine.applyAutoEqProfile({ enabled: false, name: '', preampDb: 0, bands: [] });
      this._syncAllDspUi();
      this._saveProDspSettings();
      await this.ensurePlaybackEngineForCurrentDsp(false);
      this.setToast('AutoEQ Parametric EQ profile cleared');
    });

    // Precision 64-bit Partitioned FFT Convolution (Room & Headphone .wav IR) controls
    document.getElementById('btnPickConvolverIr')?.addEventListener('click', async () => {
      if (!window.vantaAPI?.pickConvolverIr) return;
      const res = await window.vantaAPI.pickConvolverIr();
      if (!res || res.canceled) return;
      if (!res.ok || !res.filePath) {
        this.setToast(`Impulse Response error: ${res.error || 'Unsupported WAV header'}`);
        return;
      }
      const st = this.audioEngine.state;
      st.convolverEnabled = true;
      st.convolverPath = res.filePath;
      st.convolverName = res.fileName || 'Impulse.wav';
      st.convolverSampleRate = Number(res.sampleRate) || 0;
      st.convolverChannels = Number(res.channels) || 2;
      st.convolverFrames = Number(res.frames) || 0;
      this.audioEngine._loadedConvolverPath = '';

      if (this.engineMode === 'wasapi') {
        await this.syncNativeConvolver(true);
      } else {
        await this._ensureStudioConvolverIrLoaded();
      }
      this.audioEngine.syncDspState();
      this._syncAllDspUi();
      this._saveProDspSettings();
      this.updateStreamTelemetry();
      this.setToast(`Loaded 64-bit Convolver IR "${st.convolverName}" (${st.convolverSampleRate} Hz · ${st.convolverChannels}ch)`);
    });

    document.getElementById('btnToggleConvolverActive')?.addEventListener('click', async () => {
      const st = this.audioEngine.state;
      if (!st.convolverPath) return;
      st.convolverEnabled = !st.convolverEnabled;
      if (this.engineMode === 'wasapi') {
        await this.syncNativeConvolver(st.convolverEnabled);
      } else if (st.convolverEnabled) {
        await this._ensureStudioConvolverIrLoaded();
      }
      this.audioEngine.syncDspState();
      this._syncAllDspUi();
      this._saveProDspSettings();
      this.updateStreamTelemetry();
      this.setToast(st.convolverEnabled ? '64-Bit FFT Convolver ENABLED' : '64-Bit FFT Convolver Bypassed');
    });

    document.getElementById('btnClearConvolverIr')?.addEventListener('click', async () => {
      const st = this.audioEngine.state;
      st.convolverEnabled = false;
      st.convolverPath = '';
      st.convolverName = '';
      st.convolverSampleRate = 0;
      st.convolverChannels = 0;
      st.convolverFrames = 0;
      this.audioEngine._loadedConvolverPath = '';
      if (this.audioEngine.irConvolverNode) this.audioEngine.irConvolverNode.buffer = null;
      if (this.engineMode === 'wasapi') {
        await this.syncNativeConvolver(false);
      }
      this.audioEngine.syncDspState();
      this._syncAllDspUi();
      this._saveProDspSettings();
      this.updateStreamTelemetry();
      this.setToast('Convolution Impulse Response unloaded');
    });

    const wetSlider = document.getElementById('convolverWetSlider');
    wetSlider?.addEventListener('input', (e) => {
      const wet = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
      this.audioEngine.state.convolverWetPct = wet;
      const wetVal = document.getElementById('convolverWetVal');
      if (wetVal) wetVal.textContent = `${wet}%`;
      this.audioEngine.syncDspState();
    });
    wetSlider?.addEventListener('change', () => {
      const wet = Math.max(0, Math.min(100, Math.round(Number(this.audioEngine.state.convolverWetPct ?? 100) || 0)));
      this._saveProDspSettings();
      if (this.engineMode === 'wasapi' && this.audioEngine.state.convolverEnabled && window.vantaAPI) {
        window.vantaAPI.wasapiCmd(`CONVOLVER_WET ${wet}`).catch(() => {});
      }
      this.updateStreamTelemetry();
      this.setToast(`Convolver Wet Mix: ${wet}%`);
    });

    this._syncAllDspUi();
  }

  /**
   * Wires and drives the Double-Blind ABX Comparator modal (with loudness matching & binomial p-value verdict).
   */
  _bindAbxModal() {
    const modal = document.getElementById('abxModal');
    const openBtn = document.getElementById('btnOpenAbxModal');
    const closeBtn = document.getElementById('btnCloseAbxModal');
    const loudnessBtn = document.getElementById('btnAbxLoudnessMatch');
    const modeBtns = document.querySelectorAll('[data-abx-mode]');
    const trialsSel = document.getElementById('abxTrialsSelect');
    const trackBWrap = document.getElementById('abxTrackBWrap');
    const trackBSel = document.getElementById('abxTrackBSelect');
    const startBtn = document.getElementById('btnStartAbxSession');
    const revealBtn = document.getElementById('btnRevealAbxEarly');
    const progressBadge = document.getElementById('abxProgressBadge');
    const activeNote = document.getElementById('abxActiveNote');
    const playABtn = document.getElementById('btnAbxPlayA');
    const playBBtn = document.getElementById('btnAbxPlayB');
    const playXBtn = document.getElementById('btnAbxPlayX');
    const voteABtn = document.getElementById('btnAbxVoteA');
    const voteBBtn = document.getElementById('btnAbxVoteB');
    const resultsBox = document.getElementById('abxResultsBox');
    const scoreBadge = document.getElementById('abxScoreBadge');
    const pValBadge = document.getElementById('abxPValueBadge');
    const verdictEl = document.getElementById('abxVerdictSummary');
    const logList = document.getElementById('abxTrialLogList');
    if (!modal || !openBtn) return;

    let selectedMode = 'chain';
    let loudnessMatch = true;

    const populateTrackBOptions = () => {
      if (!trackBSel) return;
      const pool = (this.displayedTracks || []).filter((t) => t && !t.isVideo);
      trackBSel.replaceChildren();
      pool.forEach((tr) => {
        const idx = this.displayedTracks.indexOf(tr);
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = `${tr.artist ? `${tr.artist} — ` : ''}${tr.title || 'Untitled'}`;
        trackBSel.appendChild(opt);
      });
      const fallbackIdx = pool.length > 1
        ? this.displayedTracks.indexOf(pool.find((t) => this.displayedTracks.indexOf(t) !== this.activeTrackIndex) || pool[0])
        : this.activeTrackIndex;
      if (fallbackIdx >= 0) trackBSel.value = String(fallbackIdx);
    };

    const setAuditionActiveBtn = (slot) => {
      playABtn?.classList.toggle('active', slot === 'A');
      playBBtn?.classList.toggle('active', slot === 'B');
      playXBtn?.classList.toggle('active', slot === 'X');
    };

    const restorePreAbxState = async () => {
      const sess = this.abxSession;
      if (!sess) return;
      if (sess.mode === 'chain' && sess.snapshotDsp) {
        this.audioEngine.importPersistState(sess.snapshotDsp);
        this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
        this.syncNativeWasapiDsp();
        if (this.engineMode === 'wasapi') {
          await this.syncNativeConvolver();
          if (this.isPlaying && window.vantaAPI) {
            window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
          }
        }
        this._syncAllDspUi();
        this.updateStreamTelemetry();
      }
      this.abxSession = null;
    };

    const syncAbxModalControls = () => {
      const sess = this.abxSession;
      const running = Boolean(sess && sess.active && !sess.completed);
      modeBtns.forEach((btn) => btn.classList.toggle('on', btn.dataset.abxMode === selectedMode));
      if (loudnessBtn) loudnessBtn.classList.toggle('on', loudnessMatch);
      if (trackBWrap) trackBWrap.classList.toggle('hidden', selectedMode !== 'tracks');

      if (playABtn) playABtn.disabled = !running;
      if (playBBtn) playBBtn.disabled = !running;
      if (playXBtn) playXBtn.disabled = !running;

      const trialIdx = sess ? sess.results.length : 0;
      const canVote = running && trialIdx < sess.trials.length;
      if (voteABtn) voteABtn.disabled = !canVote;
      if (voteBBtn) voteBBtn.disabled = !canVote;
      if (revealBtn) revealBtn.classList.toggle('hidden', !(running && sess.results.length > 0));
      if (startBtn) startBtn.textContent = running ? 'Restart Blind Test' : 'Start Blind Test';
    };

    const renderAbxResults = (sess) => {
      if (!resultsBox || !sess) return;
      const correct = sess.results.filter((r) => r.correct).length;
      const total = sess.results.length;
      const verdict = evaluateAbxVerdict({
        correct,
        total,
        labelA: sess.labelA,
        labelB: sess.labelB
      });
      resultsBox.classList.remove('hidden');
      if (scoreBadge) scoreBadge.textContent = `Score: ${verdict.correct} / ${verdict.total} (${verdict.accuracyPct}%)`;
      if (pValBadge) {
        pValBadge.textContent = `p = ${verdict.pValue.toFixed(4)}`;
        pValBadge.classList.toggle('warn', !verdict.significant);
      }
      if (verdictEl) {
        verdictEl.textContent = verdict.summary;
        verdictEl.classList.toggle('sig', verdict.significant);
      }
      if (logList) {
        const items = sess.results.map((r) => {
          const pill = document.createElement('div');
          pill.className = `abx-log-pill ${r.correct ? 'ok' : 'miss'}`;
          pill.textContent = `#${r.trial}: X=${r.actual} · Pick=${r.guess} ${r.correct ? '✓' : '✗'}`;
          return pill;
        });
        logList.replaceChildren(...items);
      }
    };

    const finishAbxSession = async () => {
      const sess = this.abxSession;
      if (!sess) return;
      sess.active = false;
      sess.completed = true;
      setAuditionActiveBtn('');
      if (progressBadge) {
        progressBadge.textContent = `Completed (${sess.results.length}/${sess.trials.length} trials)`;
      }
      if (activeNote) {
        activeNote.textContent = `Blind session finished (${sess.labelA} vs ${sess.labelB}). Original DSP chain restored.`;
      }
      renderAbxResults(sess);
      if (sess.mode === 'chain' && sess.snapshotDsp) {
        this.audioEngine.importPersistState(sess.snapshotDsp);
        this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
        this.syncNativeWasapiDsp();
        if (this.engineMode === 'wasapi') {
          await this.syncNativeConvolver();
        }
        this._syncAllDspUi();
        this.updateStreamTelemetry();
      }
      syncAbxModalControls();
    };

    const auditionChoice = async (slot) => {
      const sess = this.abxSession;
      if (!sess || !sess.active) return;
      const targetChar = slot === 'X' ? sess.trials[sess.results.length] : slot;
      sess.activeAuditionSlot = slot;
      setAuditionActiveBtn(slot);

      if (sess.mode === 'chain') {
        if (targetChar === 'A') {
          this.audioEngine.importPersistState(sess.snapshotDsp);
        } else {
          this.audioEngine.resetBitPerfect();
        }
        if (sess.loudnessMatch) {
          this.audioEngine.state.lufs = true;
          this.audioEngine.state.replayGainMode = 'track';
          this.audioEngine.state.replayGainTargetLufs = -18;
        } else if (targetChar === 'B') {
          this.audioEngine.state.lufs = false;
        }
        this.audioEngine.syncDspState();
        this.audioEngine.setReplayGainLinear(this.getEffectiveReplayGain());
        if (this.engineMode === 'wasapi' && window.vantaAPI) {
          this.syncNativeWasapiDsp();
          await this.syncNativeConvolver(targetChar === 'A' && Boolean(sess.snapshotDsp?.convolverEnabled));
          if (this.isPlaying) {
            window.vantaAPI.wasapiCmd(`GAIN ${this.getEffectiveWasapiGain().toFixed(4)}`).catch(() => {});
          }
        }
        if (!this.isPlaying && this.displayedTracks.length > 0) {
          await this.startPlayback(0);
        }
        this.updateStreamTelemetry();
      } else {
        const targetIndex = targetChar === 'A' ? sess.trackAIndex : sess.trackBIndex;
        const curPos = this.engineMode === 'wasapi'
          ? Math.max(0, Number(this.wasapiCurrentPositionSec) || 0)
          : Math.max(0, Number(this.audioEl?.currentTime) || 0);
        if (sess.loudnessMatch) {
          this.audioEngine.state.lufs = true;
          this.audioEngine.state.replayGainMode = 'track';
          this.audioEngine.state.replayGainTargetLufs = -18;
        }
        if (this.activeTrackIndex !== targetIndex || !this.isPlaying) {
          this.loadTrack(targetIndex, false);
          await this.startPlayback(curPos);
        }
      }

      if (activeNote) {
        activeNote.textContent = slot === 'X'
          ? `Now auditioning hidden X (Trial ${sess.results.length + 1} of ${sess.trials.length}) — click "X is A" or "X is B"`
          : `Now auditioning reference ${slot} (${slot === 'A' ? sess.labelA : sess.labelB})`;
      }
    };

    const recordVote = async (votedChar) => {
      const sess = this.abxSession;
      if (!sess || !sess.active) return;
      const idx = sess.results.length;
      if (idx >= sess.trials.length) return;
      const actual = sess.trials[idx];
      sess.results.push({
        trial: idx + 1,
        actual,
        guess: votedChar,
        correct: actual === votedChar
      });
      if (sess.results.length >= sess.trials.length) {
        await finishAbxSession();
      } else {
        if (progressBadge) {
          progressBadge.textContent = `Trial ${sess.results.length + 1} / ${sess.trials.length}`;
        }
        renderAbxResults(sess);
        await auditionChoice('X');
        syncAbxModalControls();
      }
    };

    const closeModal = () => {
      modal.classList.add('hidden');
      if (this.abxSession?.active) {
        void restorePreAbxState().catch(() => {});
      }
    };

    openBtn.addEventListener('click', () => {
      populateTrackBOptions();
      resultsBox?.classList.toggle('hidden', !this.abxSession?.results?.length);
      syncAbxModalControls();
      modal.classList.remove('hidden');
    });
    closeBtn?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
    });

    loudnessBtn?.addEventListener('click', () => {
      loudnessMatch = !loudnessMatch;
      syncAbxModalControls();
    });
    modeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedMode = btn.dataset.abxMode === 'tracks' ? 'tracks' : 'chain';
        if (selectedMode === 'tracks') populateTrackBOptions();
        syncAbxModalControls();
      });
    });

    startBtn?.addEventListener('click', async () => {
      if (this.abxSession?.active) {
        await restorePreAbxState();
      }
      if (!this.displayedTracks.length) {
        this.setToast('Load at least one track before starting an ABX blind test');
        return;
      }
      if (selectedMode === 'tracks') {
        const trackAIdx = Math.max(0, this.activeTrackIndex);
        const trackBIdx = Math.max(0, Number(trackBSel?.value ?? trackAIdx) || 0);
        if (trackAIdx === trackBIdx) {
          this.setToast('Select a different Track B in the dropdown to compare two tracks');
          return;
        }
      }
      const totalTrials = Math.max(8, Math.min(16, Number(trialsSel?.value) || 12));
      const trackAIdx = Math.max(0, this.activeTrackIndex);
      const trackBIdx = Math.max(0, Number(trackBSel?.value ?? trackAIdx) || 0);
      const trackA = this.displayedTracks[trackAIdx];
      const trackB = this.displayedTracks[trackBIdx];
      this.abxSession = {
        active: true,
        completed: false,
        mode: selectedMode,
        loudnessMatch,
        trials: generateAbxTrialSequence(totalTrials),
        results: [],
        snapshotDsp: this.audioEngine.exportPersistState(),
        trackAIndex: trackAIdx,
        trackBIndex: trackBIdx,
        labelA: selectedMode === 'chain' ? 'Active DSP Chain' : (trackA?.title || 'Track A'),
        labelB: selectedMode === 'chain' ? 'Bit-Exact Flat' : (trackB?.title || 'Track B')
      };
      resultsBox?.classList.add('hidden');
      if (logList) logList.replaceChildren();
      if (progressBadge) progressBadge.textContent = `Trial 1 / ${totalTrials}`;
      syncAbxModalControls();
      await auditionChoice('A');
    });

    revealBtn?.addEventListener('click', () => { void finishAbxSession().catch(() => {}); });
    playABtn?.addEventListener('click', () => { void auditionChoice('A').catch(() => {}); });
    playBBtn?.addEventListener('click', () => { void auditionChoice('B').catch(() => {}); });
    playXBtn?.addEventListener('click', () => { void auditionChoice('X').catch(() => {}); });
    voteABtn?.addEventListener('click', () => { void recordVote('A').catch(() => {}); });
    voteBBtn?.addEventListener('click', () => { void recordVote('B').catch(() => {}); });
  }

  /**
   * Executes the Universal Multi-ID / URL Batch Downloader via Electron IPC.
   */
  async runUniversalBatch() {
    const inputEl = document.getElementById('universalBatchInput');
    let rawText = inputEl?.value?.trim() || '';
    if (!rawText) {
      const current = this.displayedTracks[this.activeTrackIndex];
      rawText = current?.id || '';
    }

    if (!window.vantaAPI) {
      this.updateBatchProgressRing(100, 'Saved + ID3');
      this.setToast('Batch Tagged & Saved to C:\\Vanta\\VantaVault');
      return;
    }

    const parsed = await window.vantaAPI.parseInputs(rawText);
    if (parsed.totalCount === 0) {
      this.setToast('Paste at least one valid YouTube URL or 11-char Video ID in the YouTube Batch bar');
      inputEl?.focus();
      return;
    }

    this.updateBatchProgressRing(10, `Queueing ${parsed.totalCount} Tracks...`);
    this.setToast(`Starting batch download of ${parsed.totalCount} track(s) as ${this.selectedExportFormat}...`);

    const batchRes = await window.vantaAPI.downloadBatch({
      rawText,
      format: this.selectedExportFormat
    });

    const results = batchRes.results || [];
    const okCount = results.filter((r) => r.ok).length;
    const failedItems = results.filter((r) => !r.ok);

    this.mergeVaultCatalog(batchRes.catalog, batchRes.doctor);
    if (okCount > 0 && this.selectedExportFormat === 'MP4 Video' && this.activeNav !== 'videos') {
      this.handleSidebarSwitch('videos');
    }

    if (okCount === 0) {
      const reason = failedItems[0]?.error || 'Download failed (check 📜 Logs)';
      this.updateBatchProgressRing(0, 'Failed (0/' + parsed.totalCount + ')');
      this.setToast(`Download Failed: ${reason}`);
    } else if (failedItems.length > 0) {
      const pct = Math.round((okCount / parsed.totalCount) * 100);
      this.updateBatchProgressRing(pct, `${okCount}/${parsed.totalCount} Saved`);
      this.setToast(`Partial: ${okCount}/${parsed.totalCount} saved (${failedItems[0].error})`);
    } else {
      this.updateBatchProgressRing(100, '100% Saved');
      this.setToast(`Completed: ${okCount}/${parsed.totalCount} track(s) tagged with ID3v2 & saved to C:\\Vanta\\VantaVault`);
    }
  }

  /**
   * Seeks active playback (WASAPI Exclusive or Studio DSP) to an exact timestamp in seconds.
   * Used by both the master timeline scrubber and Score Studio measure click / A-B loop.
   * @param {number} targetSec - Target position in seconds.
   * @param {boolean} [triggerPlay=true] - Resume playback if currently active.
   */
  seekToSeconds(targetSec, triggerPlay = true) {
    const track = this.displayedTracks[this.activeTrackIndex] || this.currentLoadedTrack;
    const totalSec = this._getActiveTotalDuration ? this._getActiveTotalDuration() : (Number(track?.durationSec) || 232);
    const clampedSec = Math.max(0, Math.min(Math.max(0.5, totalSec - 0.1), Number(targetSec) || 0));
    this.updateTimelineUi(clampedSec, totalSec);

    if (this.engineMode === 'wasapi' && window.vantaAPI && track?.filePath && !track.isVideo) {
      this.wasapiCurrentPositionSec = clampedSec;
      this.wasapiResumeSec = clampedSec;
      this.wasapiPausedTrackKey = this._getTrackUniqueKey(track);
      if (triggerPlay && this.isPlaying) {
        void this.startPlayback(clampedSec).catch(() => {});
      }
      return;
    }

    if (track) {
      this._seekStudioMedia(track, clampedSec, triggerPlay);
    }
  }

  /**
   * Sets pitch-preserving practice playback speed for Score Studio Practice Mode.
   * @param {number} rate - Speed multiplier in [0.5, 1.5].
   */
  setPracticePlaybackRate(rate) {
    const next = Math.max(0.5, Math.min(1.5, Number(rate) || 1.0));
    this.audioEngine.state.playbackRate = next;
    if (Math.abs(next - 1.0) > 0.001 && this.engineMode === 'wasapi') {
      void this.setEngineMode('dsp', true).catch(() => {});
    }
    [this.audioEl, this.deckBEl, this.videoEl].forEach((deck) => {
      if (!deck) return;
      deck.preservesPitch = true;
      deck.playbackRate = next;
    });
    const speedBtn = document.getElementById('btnPlaybackSpeed');
    if (speedBtn) speedBtn.textContent = `${next.toFixed(2)}x`;
  }

  /**
   * Temporarily mutes/unmutes original track audio during Score Studio MIDI Solo auditioning.
   * @param {boolean} muted - True to silence original audio while keeping clock running.
   */
  setScoreMuteOriginal(muted) {
    this._scoreMuteOriginal = Boolean(muted);
    const effectiveMuted = this.isMuted || this._scoreMuteOriginal;
    const volMode = this.audioEngine?.state?.volumeMode || 'auto';
    const studioVol = volMode === 'fixed0db'
      ? (effectiveMuted ? 0 : 1.0)
      : (effectiveMuted ? 0 : this.masterVolumeLinear);
    this.audioEngine.setVolume(studioVol);

    if (this.engineMode === 'wasapi' && this.isPlaying && window.vantaAPI) {
      const gain = effectiveMuted ? 0 : this.getEffectiveWasapiGain();
      window.vantaAPI.wasapiCmd(`GAIN ${gain.toFixed(4)}`).catch(() => {});
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const app = new VantaStudioApp();
  void app.init().catch(() => {});
});
