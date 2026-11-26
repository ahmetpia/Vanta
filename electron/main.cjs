'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  protocol,
  session,
  net,
  nativeImage,
  globalShortcut
} = require('electron');

const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const logger = require('./services/loggerService.cjs');
const {
  SUBTITLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  hasSafePathSyntax,
  canonicalizePath,
  resolveSafeVaultSubfolder,
  resolveFromTrustedRoots
} = require('./services/pathSecurityService.cjs');
const {
  resolveFfmpegBinary,
  probeAudioStreamInfo,
  probeMediaStreams,
  decideVideoPlaybackStrategy,
  convertSrtToVtt,
  writeFfmpegMetadataOnDisk,
  measureEbuR128Loudness,
  listWasapiDevices,
  needsLosslessPcmTranscode,
  NativeWasapiPlayer,
  WindowsVolumeBridge
} = require('./services/audioBridgeService.cjs');
const { updateMp3MetadataOnDisk } = require('./services/id3Service.cjs');
const {
  parseYouTubeInputs,
  resolveYouTubeMetadata,
  downloadYouTubeMedia
} = require('./services/youtubeService.cjs');
const {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  computeAudioPayloadFingerprint,
  resolveHashStoreEntry,
  upsertHashAnnotation,
  getComputerRoots,
  listDirectoryEntries,
  scanExplicitMediaFiles,
  mergeCatalogTracks,
  scanMediaDirectoriesAsync,
  loadTrackCoverBinary,
  loadTrackLyricsText,
  runQualityDoctor,
  repairQualityIssues,
  exportPortableWallet,
  filterHiddenCatalogTracks,
  loadLibraryStore,
  saveLibraryStore
} = require('./services/libraryService.cjs');

const VAULT_ROOT = 'C:\\Vanta\\VantaVault';
const STORE_PATH = path.join(VAULT_ROOT, 'vanta-library.json');
const libraryStore = loadLibraryStore(STORE_PATH);

const watchedFolders = new Set([
  path.join(VAULT_ROOT, 'YouTube'),
  path.join(VAULT_ROOT, 'Local'),
  ...(libraryStore.watchedFolders || []).filter((p) => fs.existsSync(p))
]);
const watchedFiles = new Set(
  (libraryStore.watchedFiles || []).filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  })
);

/**
 * Merges persisted user annotations (stars, tags, groups, custom BPM/Key/Energy) onto scanned tracks.
 * @param {object[]} catalog - Scanned tracks.
 * @returns {object[]} Annotated tracks.
 */
function applyAnnotationsToCatalog(catalog) {
  const visible = filterHiddenCatalogTracks(catalog, libraryStore.hiddenPaths);
  const annotations = libraryStore.annotations || {};
  const techCache = libraryStore.loudnessCache || {};
  return visible.map((t) => {
    const { entry: saved } = resolveHashStoreEntry(annotations, t);
    const { entry: cachedInfo } = resolveHashStoreEntry(techCache, t);
    const probe = cachedInfo?.probe || {};
    const rawAlbum =
      saved.album !== undefined
        ? saved.album
        : (/^vanta media vault$/i.test(String(t.album || '').trim()) ? '' : t.album);
    const coverUrl =
      t.hasCover && t.filePath ? `vanta-cover://local?path=${encodeURIComponent(t.filePath)}` : '';
    return {
      ...t,
      title: saved.title !== undefined && saved.title !== '' ? saved.title : t.title,
      artist: saved.artist !== undefined && saved.artist !== '' ? saved.artist : t.artist,
      album: rawAlbum || '',
      genre: saved.genre !== undefined ? String(saved.genre) : String(t.genre || ''),
      year: saved.year !== undefined ? String(saved.year) : String(t.year || ''),
      stars: Number(saved.stars) || 0,
      favorite: Boolean(saved.favorite),
      tags: Array.isArray(saved.tags) ? saved.tags.slice(0, 3) : [],
      groups: Array.isArray(saved.groups) ? saved.groups.slice(0, 1) : [],
      bpm: Number(saved.bpm) || t.bpm,
      key: saved.key || t.key,
      energy: Number(saved.energy) || t.energy,
      coverUrl,
      coverDataUrl: t.filePath ? '' : (t.coverDataUrl || ''),
      hasLyrics: Boolean(t.hasLyrics || t.lyrics),
      lyrics: t.filePath ? '' : (t.lyrics || ''),
      durationSec: Number(t.durationSec) || Number(probe.durationSec) || 0,
      bitrateKbps: Number(t.bitrateKbps) || Number(probe.bitrateKbps) || 0,
      sampleRate: Number(t.sampleRate) || Number(probe.sampleRate) || 0,
      bitDepth: Number(t.bitDepth) || Number(probe.bitDepth) || 0,
      channels: Number(t.channels) || Number(probe.channels) || 0,
      audioCodec: String(t.audioCodec || probe.codec || ''),
      videoCodec: String(t.videoCodec || probe.videoCodec || ''),
      videoWidth: Number(t.videoWidth || probe.videoWidth || 0),
      videoHeight: Number(t.videoHeight || probe.videoHeight || 0)
    };
  });
}

let mainWindow = null;
const wasapiPlayer = new NativeWasapiPlayer((evt) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vanta:wasapi-event', evt);
  }
});
const volumeBridge = new WindowsVolumeBridge(
  (volState) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vanta:volume-event', volState);
    }
  },
  () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vanta:audio-devices-changed');
    }
  }
);

process.on('uncaughtException', (err) => {
  logger.error('MainProcess', 'Uncaught exception in Electron main process', {
    message: err.message,
    stack: err.stack
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('MainProcess', 'Unhandled promise rejection in Electron main process', {
    reason: String(reason)
  });
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vanta-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'vanta-cover',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true
    }
  }
]);

// Enable D3D11VA / DXVA2 GPU hardware-accelerated 4K H.264 / HEVC / VP9 / AV1 video decoding
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,VaapiVideoDecoder,HardwareMediaKeyHandling');

/**
 * Ensures all default C:\Vanta\VantaVault directories exist on startup.
 */
function ensureVaultDirectories() {
  const dirs = [
    path.join(VAULT_ROOT, 'YouTube'),
    path.join(VAULT_ROOT, 'Local'),
    path.join(VAULT_ROOT, 'Covers', 'playlists'),
    path.join(VAULT_ROOT, 'Exports'),
    path.join(VAULT_ROOT, 'logs')
  ];
  for (const d of dirs) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * Helper to broadcast folder scan progress to the renderer window.
 * @param {object} progressData - { scannedCount, currentFile }
 */
function sendScanProgress(progressData) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vanta:scan-progress', progressData);
  }
}

const ALL_MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const ALL_MEDIA_AND_IMAGE_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS]);
const INDEX_HTML_PATH = path.join(__dirname, '..', 'src', 'index.html');
const INDEX_FILE_URL = pathToFileURL(INDEX_HTML_PATH).href;

const BLOCKED_INGEST_DIR_NAMES = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.kube',
  'windows',
  'system32',
  'syswow64',
  '$recycle.bin',
  'system volume information'
]);

/**
 * Verifies that an incoming IPC invocation originates strictly from the trusted local Studio renderer frame.
 * @param {Electron.IpcMainInvokeEvent} event - IPC event.
 */
function assertAuthorizedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Unauthorized IPC sender');
  }
  const frameUrl = event.senderFrame?.url || '';
  if (frameUrl && !frameUrl.startsWith(INDEX_FILE_URL)) {
    throw new Error('Unauthorized IPC sender frame');
  }
}

/**
 * Wraps `ipcMain.handle` with strict sender frame authentication.
 * @param {string} channel - IPC channel name.
 * @param {Function} handler - IPC handler function.
 */
function registerSecureIpcHandler(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertAuthorizedIpcSender(event);
    return handler(event, ...args);
  });
}

const authorizedMediaFiles = new Map();
const authorizedExplorerDirs = new Map();

function toNormKey(p) {
  const norm = path.resolve(String(p || '').trim());
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function registerAuthorizedMediaFile(canonPath) {
  if (!canonPath) return;
  authorizedMediaFiles.set(toNormKey(canonPath), canonPath);
}

function registerAuthorizedExplorerDir(canonDir) {
  if (!canonDir) return;
  authorizedExplorerDirs.set(toNormKey(canonDir), canonDir);
}

/**
 * Returns trusted root directories allowed for media/subtitle access.
 */
function getAuthorizedMediaRoots() {
  const roots = [VAULT_ROOT, ...watchedFolders];
  for (const wf of watchedFiles) {
    if (wf) roots.push(path.dirname(wf));
  }
  return roots;
}

/**
 * Returns trusted OS drive & user roots for Computer Explorer navigation.
 */
function getTrustedExplorerRoots() {
  const roots = [VAULT_ROOT, ...watchedFolders];
  for (const r of getComputerRoots()) {
    if (r?.path) {
      roots.push(r.path);
      registerAuthorizedExplorerDir(r.path);
    }
  }
  return roots;
}

/**
 * Resolves an untrusted media/subtitle/image path strictly from server-side registries or
 * OS directory walks (`resolveFromTrustedRoots`), returning a zero-taint canonical path.
 * @param {string} rawPath - Untrusted path.
 * @param {Set<string>} allowedExtensions - Allowed lowercase extensions.
 * @returns {string|null} Server-originated canonical safe path or null if rejected.
 */
function resolveAuthorizedFile(rawPath, allowedExtensions) {
  if (!hasSafePathSyntax(rawPath)) return null;
  const key = toNormKey(rawPath);
  const cached = authorizedMediaFiles.get(key);
  if (cached) {
    const ext = path.extname(cached).toLowerCase();
    if ((!allowedExtensions || allowedExtensions.has(ext)) && fs.existsSync(cached)) {
      return cached;
    }
  }

  const resolved = resolveFromTrustedRoots(rawPath, getAuthorizedMediaRoots(), {
    expect: 'file',
    allowedExtensions,
    blockedSegments: BLOCKED_INGEST_DIR_NAMES
  });
  if (resolved) {
    registerAuthorizedMediaFile(resolved);
    return resolved;
  }
  logger.warn('SecurityBoundary', 'Blocked out-of-scope or invalid file access attempt', { rawPath });
  return null;
}

/**
 * Creates the primary VANTA Studio frameless desktop window.
 */
function createMainWindow() {
  ensureVaultDirectories();
  logger.info('AppLifecycle', 'Creating VANTA main studio window', {
    vaultRoot: VAULT_ROOT,
    logFile: logger.logFilePath
  });

  mainWindow = new BrowserWindow({
    width: 1460,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    frame: false,
    backgroundColor: '#07070D',
    title: 'VANTA — Personal Audio & Video OS',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.loadFile(INDEX_HTML_PATH);

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!targetUrl.startsWith(INDEX_FILE_URL)) {
      event.preventDefault();
      logger.warn('SecurityBoundary', 'Blocked unauthorized navigation attempt', { targetUrl });
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('RendererProcess', 'Renderer process terminated unexpectedly', details);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) {
      logger.warn('RendererConsole', message, { level, line, sourceId });
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    logger.info('AppLifecycle', 'VANTA main window ready and shown');
  });

  if (process.argv.includes('--verify-smoke')) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          const snapPath = path.join(VAULT_ROOT, 'Exports', 'vanta_live_window.png');
          fs.writeFileSync(snapPath, image.toPNG());
          logger.info('SmokeVerify', 'Captured live window screenshot', { snapPath });
          console.log('VANTA_SMOKE_VERIFIED_OK:', snapPath);
          app.exit(0);
        } catch (err) {
          logger.error('SmokeVerify', 'Smoke verification failed', { error: err.message });
          console.error('VANTA_SMOKE_ERROR:', err.message);
          app.exit(1);
        }
      }, 1200);
    });
  }

  mainWindow.on('closed', () => {
    logger.info('AppLifecycle', 'VANTA main window closed');
    mainWindow = null;
  });
}

/**
 * Registers IPC handlers bridging the sandboxed Renderer UI to Node.js media services.
 */
function registerIpcHandlers() {
  registerSecureIpcHandler('vanta:window-control', (_event, action) => {
    if (!mainWindow) return { ok: false };
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') {
      mainWindow.close();
    }
    return { ok: true, isMaximized: mainWindow ? mainWindow.isMaximized() : false };
  });

  registerSecureIpcHandler('vanta:open-vault', async (_event, subfolder = '') => {
    const target = resolveSafeVaultSubfolder(VAULT_ROOT, subfolder);
    if (!target) {
      logger.warn('SecurityBoundary', 'Blocked unsafe vault subfolder request', { subfolder });
      return { ok: false, error: 'Invalid vault subfolder' };
    }
    fs.mkdirSync(target, { recursive: true });
    logger.info('IPC', 'Opening vault folder in Explorer', { target });
    await shell.openPath(target);
    return { ok: true, path: target };
  });

  registerSecureIpcHandler('vanta:get-logs', () => {
    return {
      logFilePath: logger.logFilePath,
      entries: logger.getRecentLogs()
    };
  });

  registerSecureIpcHandler('vanta:open-logs', async () => {
    logger.info('IPC', 'User requested to open vanta.log in external viewer');
    await shell.openPath(logger.logFilePath);
    return { ok: true, logFilePath: logger.logFilePath };
  });

  registerSecureIpcHandler('vanta:client-log', (_event, payload = {}) => {
    const level = payload.level || 'INFO';
    const msg = payload.message || '';
    const meta = payload.meta || null;
    if (level === 'ERROR') logger.error('RendererUI', msg, meta);
    else if (level === 'WARN') logger.warn('RendererUI', msg, meta);
    else logger.info('RendererUI', msg, meta);
    return { ok: true };
  });

  registerSecureIpcHandler('vanta:parse-inputs', (_event, rawText) => {
    return parseYouTubeInputs(rawText);
  });

  registerSecureIpcHandler('vanta:resolve-preview', async (_event, rawText) => {
    const parsed = parseYouTubeInputs(rawText);
    const tracks = [];

    for (const ytId of parsed.youtubeIds) {
      const meta = await resolveYouTubeMetadata(ytId);
      tracks.push({ ...meta, sourceType: 'youtube' });
    }
    return { parsed, tracks };
  });

  registerSecureIpcHandler('vanta:download-batch', async (_event, payload = {}) => {
    const rawText = payload.rawText || '';
    const format = payload.format || 'MP3+ID3';
    const parsed = parseYouTubeInputs(rawText);

    logger.info('BatchDownloader', 'Starting YouTube batch download', {
      youtubeCount: parsed.youtubeIds.length,
      format
    });

    const results = [];
    for (let i = 0; i < parsed.youtubeIds.length; i++) {
      const ytId = parsed.youtubeIds[i];
      const sendProgress = (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const overallPercent = Math.round(
            ((i + (p.percent || 0) / 100) / Math.max(1, parsed.youtubeIds.length)) * 100
          );
          mainWindow.webContents.send('vanta:batch-progress', {
            itemIndex: i,
            totalItems: parsed.youtubeIds.length,
            token: ytId,
            type: 'youtube',
            stage: p.stage,
            itemPercent: p.percent || 0,
            overallPercent
          });
        }
      };

      try {
        const res = await downloadYouTubeMedia(ytId, {
          vaultDir: path.join(VAULT_ROOT, 'YouTube'),
          format,
          onProgress: sendProgress
        });
        if (Array.isArray(libraryStore.hiddenPaths) && libraryStore.hiddenPaths.length) {
          const downloadedSet = new Set(
            [res.audioPath, res.videoPath].filter(Boolean).map((p) => path.normalize(p).toLowerCase())
          );
          const beforeLen = libraryStore.hiddenPaths.length;
          libraryStore.hiddenPaths = libraryStore.hiddenPaths.filter(
            (hp) => !downloadedSet.has(path.normalize(String(hp || '')).toLowerCase())
          );
          if (libraryStore.hiddenPaths.length !== beforeLen) {
            saveLibraryStore(libraryStore, STORE_PATH);
          }
        }
        logger.info('BatchDownloader', `Saved YouTube track: ${res.title}`, {
          audioPath: res.audioPath,
          videoPath: res.videoPath
        });
        results.push({ ok: true, type: 'youtube', ...res });
      } catch (err) {
        logger.error('BatchDownloader', `Failed downloading ${ytId}`, {
          type: 'youtube',
          error: err.message
        });
        results.push({
          ok: false,
          type: 'youtube',
          token: ytId,
          error: err.message || 'Download failed'
        });
      }
    }

    const updatedCatalog = await buildFullCatalogAsync({ onProgress: sendScanProgress });
    const doctorReport = runQualityDoctor(updatedCatalog);

    return {
      results,
      catalog: updatedCatalog,
      doctor: doctorReport,
      smartPlaylists: libraryStore.smartPlaylists
    };
  });

  /**
   * Scans all watched folders plus standalone watched files without duplicates,
   * applying hidden-path filtering and saved user annotations.
   * @param {object} [scanOptions] - Optional scanner callbacks/limits.
   * @returns {Promise<object[]>} Annotated catalog tracks.
   */
  async function buildFullCatalogAsync(scanOptions = {}) {
    if (!libraryStore.scanCache || typeof libraryStore.scanCache !== 'object') {
      libraryStore.scanCache = {};
    }
    const opts = {
      ...scanOptions,
      statCache: libraryStore.scanCache,
      cacheDirty: false
    };
    const folderTracks = await scanMediaDirectoriesAsync(Array.from(watchedFolders), opts);
    const explicitTracks = scanExplicitMediaFiles(Array.from(watchedFiles), folderTracks, opts);
    if (opts.cacheDirty) {
      saveLibraryStore(libraryStore, STORE_PATH);
    }
    const merged = mergeCatalogTracks(folderTracks, explicitTracks);
    for (const t of merged) {
      if (t?.filePath) registerAuthorizedMediaFile(canonicalizePath(t.filePath));
    }
    return applyAnnotationsToCatalog(merged);
  }

  /**
   * Ingests an arbitrary mix of host directory and media file paths non-destructively
   * and unhides any matching paths from libraryStore.hiddenPaths.
   * @param {string[]} rawPaths - Host folder or file paths.
   * @returns {{ addedFolders: string[], addedFiles: string[] }}
   */
  function ingestPathsToLibrary(rawPaths = []) {
    const addedFolders = [];
    const addedFiles = [];
    let hiddenList = Array.isArray(libraryStore.hiddenPaths) ? [...libraryStore.hiddenPaths] : [];
    const explorerRoots = getTrustedExplorerRoots();

    for (const raw of Array.isArray(rawPaths) ? rawPaths : []) {
      if (!raw) continue;
      const safeDir = resolveFromTrustedRoots(String(raw), explorerRoots, {
        expect: 'dir',
        blockedSegments: BLOCKED_INGEST_DIR_NAMES
      });
      if (safeDir) {
        watchedFolders.add(safeDir);
        registerAuthorizedExplorerDir(safeDir);
        addedFolders.push(safeDir);
        const normLower = safeDir.toLowerCase();
        const prefix = normLower.endsWith(path.sep) ? normLower : `${normLower}${path.sep}`;
        hiddenList = hiddenList.filter((hp) => {
          const normHp = path.normalize(String(hp || '')).toLowerCase();
          return normHp !== normLower && !normHp.startsWith(prefix);
        });
        continue;
      }

      const safeFile = resolveFromTrustedRoots(String(raw), explorerRoots, {
        expect: 'file',
        allowedExtensions: ALL_MEDIA_EXTENSIONS,
        blockedSegments: BLOCKED_INGEST_DIR_NAMES
      });
      if (safeFile) {
        watchedFiles.add(safeFile);
        registerAuthorizedMediaFile(safeFile);
        addedFiles.push(safeFile);
        const normLower = safeFile.toLowerCase();
        hiddenList = hiddenList.filter(
          (hp) => path.normalize(String(hp || '')).toLowerCase() !== normLower
        );
      }
    }

    libraryStore.watchedFolders = Array.from(watchedFolders);
    libraryStore.watchedFiles = Array.from(watchedFiles);
    libraryStore.hiddenPaths = hiddenList;
    saveLibraryStore(libraryStore, STORE_PATH);
    return { addedFolders, addedFiles };
  }

  registerSecureIpcHandler('vanta:scan-vault', async () => {
    logger.info('IPC', 'Scanning watched vault folders and explicit files', {
      folders: Array.from(watchedFolders),
      filesCount: watchedFiles.size
    });
    const catalog = await buildFullCatalogAsync({ onProgress: sendScanProgress });
    const doctor = runQualityDoctor(catalog);
    return {
      vaultRoot: VAULT_ROOT,
      watchedFolders: Array.from(watchedFolders),
      watchedFiles: Array.from(watchedFiles),
      catalog,
      doctor,
      smartPlaylists: libraryStore.smartPlaylists
    };
  });

  registerSecureIpcHandler('vanta:get-computer-roots', () => {
    const roots = getComputerRoots();
    for (const r of roots) {
      if (r?.path) registerAuthorizedExplorerDir(canonicalizePath(r.path));
    }
    return roots;
  });

  registerSecureIpcHandler('vanta:list-dir', (_event, dirPath) => {
    if (!hasSafePathSyntax(dirPath)) {
      return { path: '', entries: [], error: 'Invalid or unsafe directory path' };
    }
    const key = toNormKey(dirPath);
    const trustedDir =
      authorizedExplorerDirs.get(key) ||
      resolveFromTrustedRoots(dirPath, getTrustedExplorerRoots(), {
        expect: 'dir',
        blockedSegments: BLOCKED_INGEST_DIR_NAMES
      });
    if (!trustedDir) {
      return { path: '', entries: [], error: 'Directory rejected by security policy' };
    }
    registerAuthorizedExplorerDir(trustedDir);
    const res = listDirectoryEntries(trustedDir, libraryStore.hiddenExplorerDirs || []);
    for (const entry of res?.entries || []) {
      if (entry.type === 'folder' && entry.path) {
        registerAuthorizedExplorerDir(entry.path);
      }
    }
    return res;
  });

  registerSecureIpcHandler('vanta:get-hidden-explorer-dirs', () => {
    return Array.isArray(libraryStore.hiddenExplorerDirs) ? libraryStore.hiddenExplorerDirs : [];
  });

  registerSecureIpcHandler('vanta:hide-explorer-dirs', (_event, payload = {}) => {
    const incoming = Array.isArray(payload.paths) ? payload.paths : [];
    const existing = Array.isArray(libraryStore.hiddenExplorerDirs) ? libraryStore.hiddenExplorerDirs : [];
    const seen = new Map();
    for (const p of existing) {
      if (!p) continue;
      const norm = path.normalize(String(p).trim());
      seen.set(norm.toLowerCase(), norm);
    }

    let added = 0;
    for (const raw of incoming) {
      if (!raw) continue;
      const norm = path.normalize(String(raw).trim());
      // Never hide logical drive roots such as "C:\"
      if (/^[a-zA-Z]:\\?$/.test(norm)) continue;
      const key = norm.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, norm);
        added++;
      }
    }

    libraryStore.hiddenExplorerDirs = Array.from(seen.values());
    saveLibraryStore(libraryStore, STORE_PATH);
    logger.info('Explorer', `Hid ${added} folder(s) from Computer Explorer`, {
      hiddenCount: libraryStore.hiddenExplorerDirs.length
    });
    return {
      ok: true,
      added,
      hiddenExplorerDirs: libraryStore.hiddenExplorerDirs
    };
  });

  registerSecureIpcHandler('vanta:unhide-explorer-dirs', (_event, payload = {}) => {
    const existing = Array.isArray(libraryStore.hiddenExplorerDirs) ? libraryStore.hiddenExplorerDirs : [];
    if (payload.all) {
      libraryStore.hiddenExplorerDirs = [];
    } else {
      const toRestore = new Set(
        (Array.isArray(payload.paths) ? payload.paths : [])
          .filter(Boolean)
          .map((p) => path.normalize(String(p).trim()).toLowerCase())
      );
      libraryStore.hiddenExplorerDirs = existing.filter(
        (p) => !toRestore.has(path.normalize(String(p || '')).toLowerCase())
      );
    }
    saveLibraryStore(libraryStore, STORE_PATH);
    logger.info('Explorer', 'Restored hidden Computer Explorer folder(s)', {
      remainingHidden: libraryStore.hiddenExplorerDirs.length
    });
    return {
      ok: true,
      hiddenExplorerDirs: libraryStore.hiddenExplorerDirs
    };
  });

  registerSecureIpcHandler('vanta:add-paths', async (_event, payload = {}) => {
    const requested = Array.isArray(payload.paths) ? payload.paths : [];
    const { addedFolders, addedFiles } = ingestPathsToLibrary(requested);
    const catalog = await buildFullCatalogAsync({ onProgress: sendScanProgress });
    const doctor = runQualityDoctor(catalog);

    logger.info('IPC', 'Ingested external/explorer paths', {
      addedFoldersCount: addedFolders.length,
      addedFilesCount: addedFiles.length,
      totalCatalogTracks: catalog.length
    });

    return {
      addedFolders,
      addedFiles,
      addedCount: addedFolders.length + addedFiles.length,
      watchedFolders: Array.from(watchedFolders),
      watchedFiles: Array.from(watchedFiles),
      catalog,
      doctor,
      smartPlaylists: libraryStore.smartPlaylists
    };
  });

  registerSecureIpcHandler('vanta:pick-folder', async () => {
    if (!mainWindow) return { canceled: true };
    logger.info('IPC', 'Opening folder picker dialog');

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Add Watched Media Folder to VANTA',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled || !result.filePaths.length) {
      logger.info('IPC', 'Folder picker dialog canceled by user');
      return { canceled: true };
    }

    const { addedFolders } = ingestPathsToLibrary(result.filePaths);
    const chosenDir = addedFolders[0] || result.filePaths[0];
    const catalog = await buildFullCatalogAsync({ onProgress: sendScanProgress });
    const doctor = runQualityDoctor(catalog);

    logger.info('IPC', `Finished indexing folder: ${chosenDir}`, {
      totalCatalogTracks: catalog.length,
      doctorIssues: doctor.issues.length
    });

    return {
      canceled: false,
      addedFolder: chosenDir,
      watchedFolders: Array.from(watchedFolders),
      watchedFiles: Array.from(watchedFiles),
      catalog,
      doctor,
      smartPlaylists: libraryStore.smartPlaylists
    };
  });

  registerSecureIpcHandler('vanta:clear-playlist', async (_event, payload = {}) => {
    await wasapiPlayer.stopAsync();

    // Non-destructive clear: drop external watched folders/files and hide vault tracks from queue without deleting any disk files
    const defaultVaultDirs = [path.join(VAULT_ROOT, 'YouTube'), path.join(VAULT_ROOT, 'Local')];
    watchedFolders.clear();
    defaultVaultDirs.forEach((d) => watchedFolders.add(d));
    watchedFiles.clear();
    libraryStore.watchedFolders = [];
    libraryStore.watchedFiles = [];

    const hiddenSet = new Set(
      (Array.isArray(libraryStore.hiddenPaths) ? libraryStore.hiddenPaths : []).map((p) =>
        path.normalize(String(p || '')).toLowerCase()
      )
    );
    const vaultRaw = await scanMediaDirectoriesAsync(defaultVaultDirs);
    for (const t of vaultRaw) {
      if (t.filePath) hiddenSet.add(path.normalize(t.filePath).toLowerCase());
    }
    const vaultRootLower = path.normalize(VAULT_ROOT).toLowerCase() + path.sep;
    for (const p of Array.isArray(payload.filePaths) ? payload.filePaths : []) {
      const norm = path.normalize(String(p || '')).toLowerCase();
      if (norm.startsWith(vaultRootLower)) {
        hiddenSet.add(norm);
      }
    }

    libraryStore.hiddenPaths = Array.from(hiddenSet);
    saveLibraryStore(libraryStore, STORE_PATH);
    logger.info('LibraryStore', 'Cleared playlist/queue non-destructively (files untouched on disk)', {
      hiddenVaultCount: libraryStore.hiddenPaths.length
    });

    return {
      ok: true,
      catalog: [],
      doctor: { issues: [], healthScore: 100 },
      smartPlaylists: libraryStore.smartPlaylists
    };
  });

  registerSecureIpcHandler('vanta:update-track-meta', async (_event, payload = {}) => {
    const updated = upsertHashAnnotation(libraryStore.annotations, payload);
    if (!updated) return { ok: false };
    saveLibraryStore(libraryStore, STORE_PATH);

    let fileUpdated = false;
    let fileWriteWarning = '';
    const tagFields = ['title', 'artist', 'album', 'genre', 'bpm', 'key', 'year'];
    const tagPatch = {};
    for (const f of tagFields) {
      if (payload.patch && payload.patch[f] !== undefined) {
        tagPatch[f] = payload.patch[f];
      }
    }

    if (payload.writeTagsToFile && payload.filePath && Object.keys(tagPatch).length > 0) {
      const safeTarget = resolveAuthorizedFile(payload.filePath, ALL_MEDIA_EXTENSIONS);
      if (!safeTarget) {
        fileWriteWarning = 'Target file rejected by security path policy';
      } else {
        const ext = path.extname(safeTarget).toLowerCase();
        if (ext === '.mp3') {
          const res = updateMp3MetadataOnDisk(safeTarget, tagPatch);
          fileUpdated = Boolean(res?.ok);
          if (!res?.ok) fileWriteWarning = res?.error || 'Could not write ID3v2 tags to MP3';
        } else if (['.flac', '.m4a', '.wav', '.aiff', '.aif', '.ogg', '.opus'].includes(ext)) {
          const res = await writeFfmpegMetadataOnDisk(safeTarget, tagPatch);
          fileUpdated = Boolean(res?.ok);
          if (!res?.ok) fileWriteWarning = res?.error || 'Could not write metadata tags to file';
        }
      }
    }

    return {
      ok: true,
      key: updated.key,
      annotation: updated.annotation,
      fileUpdated,
      fileWriteWarning
    };
  });

  registerSecureIpcHandler('vanta:save-smart-playlist', (_event, playlist) => {
    const cleanName = String(playlist?.name || '').trim().replace(/\s+/g, ' ');
    if (!playlist || !cleanName) return { ok: false, error: 'Playlist name is required' };
    const normalizedId = String(playlist.id || `sp-${Date.now()}`);
    const nameKey = cleanName.toLowerCase();
    const duplicate = libraryStore.smartPlaylists.some(
      (p) => p.id !== normalizedId && String(p.name || '').trim().replace(/\s+/g, ' ').toLowerCase() === nameKey
    );
    if (duplicate) {
      return {
        ok: false,
        error: `A playlist named "${cleanName}" already exists.`,
        smartPlaylists: libraryStore.smartPlaylists
      };
    }

    const requestedImg = String(playlist.visual?.imagePath || '').trim();
    const safeCoverImg = requestedImg ? (resolveAuthorizedFile(requestedImg, IMAGE_EXTENSIONS) || '') : '';
    const normalized = {
      id: normalizedId,
      name: cleanName,
      description: String(playlist.description || '').trim().slice(0, 140),
      visual: playlist.visual && typeof playlist.visual === 'object'
        ? {
            mode: ['auto', 'preset', 'image'].includes(playlist.visual.mode) ? playlist.visual.mode : 'auto',
            presetKey: String(playlist.visual.presetKey || 'synth').slice(0, 24),
            imagePath: safeCoverImg
          }
        : { mode: 'auto', presetKey: 'synth', imagePath: '' },
      filters: playlist.filters && typeof playlist.filters === 'object' ? playlist.filters : {}
    };
    const existingIdx = libraryStore.smartPlaylists.findIndex((p) => p.id === normalized.id);
    if (existingIdx >= 0) {
      const prevImg = libraryStore.smartPlaylists[existingIdx]?.visual?.imagePath;
      if (prevImg && prevImg !== normalized.visual.imagePath) {
        removeSafePlaylistCover(prevImg);
      }
      libraryStore.smartPlaylists[existingIdx] = normalized;
    } else {
      libraryStore.smartPlaylists.push(normalized);
    }
    saveLibraryStore(libraryStore, STORE_PATH);
    logger.info('LibraryStore', `Saved smart playlist "${normalized.name}"`);
    return { ok: true, smartPlaylists: libraryStore.smartPlaylists };
  });

  function removeSafePlaylistCover(coverPath) {
    try {
      if (!coverPath) return;
      const coversRoot = path.normalize(path.join(VAULT_ROOT, 'Covers', 'playlists')).toLowerCase() + path.sep;
      const targetNorm = path.normalize(String(coverPath));
      if (targetNorm.toLowerCase().startsWith(coversRoot) && fs.existsSync(targetNorm)) {
        fs.unlinkSync(targetNorm);
      }
    } catch {
      // Ignore locked thumbnail cleanup failures
    }
  }

  registerSecureIpcHandler('vanta:pick-playlist-cover', async (_event, payload = {}) => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Playlist Cover Artwork',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }

    const sourcePath = result.filePaths[0];
    try {
      const img = nativeImage.createFromPath(sourcePath);
      if (img.isEmpty()) {
        return { canceled: false, error: 'Unsupported or empty image file' };
      }
      const { width, height } = img.getSize();
      const squareSide = Math.min(width, height);
      const cropped = squareSide > 0 && width !== height
        ? img.crop({
            x: Math.floor((width - squareSide) / 2),
            y: Math.floor((height - squareSide) / 2),
            width: squareSide,
            height: squareSide
          })
        : img;
      const thumb = cropped.resize({ width: 256, height: 256, quality: 'good' });

      const coversDir = path.join(VAULT_ROOT, 'Covers', 'playlists');
      fs.mkdirSync(coversDir, { recursive: true });
      const safeId = String(payload.playlistId || 'draft').replace(/[^a-zA-Z0-9_-]/g, '');
      const destPath = path.join(coversDir, `${safeId}-${Date.now()}.jpg`);
      fs.writeFileSync(destPath, thumb.toJPEG(90));
      registerAuthorizedMediaFile(canonicalizePath(destPath));
      logger.info('LibraryStore', 'Saved optimized 256x256 playlist cover thumbnail', { destPath });

      return { canceled: false, imagePath: destPath };
    } catch (err) {
      logger.warn('LibraryStore', `Failed processing playlist cover ${sourcePath}`, { error: err.message });
      return { canceled: false, error: err.message };
    }
  });

  registerSecureIpcHandler('vanta:delete-smart-playlist', (_event, payload = {}) => {
    const targetId = String(payload.id || '').trim();
    if (!targetId) return { ok: false, smartPlaylists: libraryStore.smartPlaylists };
    const existing = libraryStore.smartPlaylists.find((p) => p.id === targetId);
    const before = libraryStore.smartPlaylists.length;
    libraryStore.smartPlaylists = libraryStore.smartPlaylists.filter((p) => p.id !== targetId);
    if (libraryStore.smartPlaylists.length !== before) {
      if (existing?.visual?.imagePath) {
        removeSafePlaylistCover(existing.visual.imagePath);
      }
      saveLibraryStore(libraryStore, STORE_PATH);
      logger.info('LibraryStore', `Deleted smart playlist "${targetId}"`);
    }
    return { ok: true, smartPlaylists: libraryStore.smartPlaylists };
  });

  registerSecureIpcHandler('vanta:get-fx-video', () => {
    const saved = libraryStore.stageFxVideoPath;
    if (saved && fs.existsSync(saved)) {
      registerAuthorizedMediaFile(canonicalizePath(saved));
      return { videoPath: saved, fileName: path.basename(saved) };
    }
    const defaults = [
      path.join(VAULT_ROOT, 'effect1.mp4'),
      path.join(VAULT_ROOT, 'effect1.webm'),
      path.join(VAULT_ROOT, 'effect1.mpg')
    ];
    const found = defaults.find((p) => fs.existsSync(p)) || '';
    if (found) registerAuthorizedMediaFile(canonicalizePath(found));
    return { videoPath: found, fileName: found ? path.basename(found) : '' };
  });

  registerSecureIpcHandler('vanta:pick-fx-video', async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose Stage Background Loop Video',
      defaultPath: VAULT_ROOT,
      filters: [{ name: 'Loop Videos', extensions: ['mp4', 'webm', 'mkv', 'mov'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) {
      return { canceled: true };
    }
    const chosen = canonicalizePath(result.filePaths[0]);
    registerAuthorizedMediaFile(chosen);
    libraryStore.stageFxVideoPath = chosen;
    saveLibraryStore(libraryStore, STORE_PATH);
    logger.info('LibraryStore', `Updated Stage FX background video to ${chosen}`);
    return { canceled: false, videoPath: chosen, fileName: path.basename(chosen) };
  });

  registerSecureIpcHandler('vanta:repair-doctor', async () => {
    logger.info('IPC', 'Running Quality Doctor auto-repair');
    const currentCatalog = await buildFullCatalogAsync();
    const currentDoctor = runQualityDoctor(currentCatalog);
    const repairResult = repairQualityIssues(currentDoctor.issues, VAULT_ROOT);
    const updatedCatalog = await buildFullCatalogAsync();
    const updatedDoctor = runQualityDoctor(updatedCatalog);
    return {
      repairResult,
      catalog: updatedCatalog,
      doctor: updatedDoctor
    };
  });

  registerSecureIpcHandler('vanta:export-wallet', (_event, walletPayload) => {
    logger.info('IPC', 'Exporting Portable Music Wallet');
    return exportPortableWallet(walletPayload, path.join(VAULT_ROOT, 'Exports'));
  });

  registerSecureIpcHandler('vanta:list-audio-devices', async () => {
    return listWasapiDevices();
  });

  registerSecureIpcHandler('vanta:probe-tech', async (_event, payload = {}) => {
    const rawPath = typeof payload === 'string' ? payload : payload?.filePath;
    const filePath = resolveAuthorizedFile(rawPath, ALL_MEDIA_EXTENSIONS);
    if (!filePath) return null;
    const audioHash = payload?.audioHash || computeAudioPayloadFingerprint(filePath);
    const cache = libraryStore.loudnessCache || {};
    const { entry: existing } = resolveHashStoreEntry(cache, { audioHash, filePath });
    const hasNeededVideo = !payload?.isVideo || Boolean(existing?.probe?.videoCodec);
    if ((existing?.probe?.durationSec > 0 || existing?.probe?.bitrateKbps > 0) && hasNeededVideo) {
      return existing.probe;
    }
    const probe = await probeAudioStreamInfo(filePath);
    const storeKey = audioHash ? `hash:${audioHash}` : filePath;
    libraryStore.loudnessCache = libraryStore.loudnessCache || {};
    libraryStore.loudnessCache[storeKey] = {
      ...(libraryStore.loudnessCache[storeKey] || {}),
      probe
    };
    saveLibraryStore(libraryStore, STORE_PATH);
    return probe;
  });

  registerSecureIpcHandler('vanta:probe-audio', async (_event, rawPath) => {
    const filePath = resolveAuthorizedFile(rawPath, ALL_MEDIA_EXTENSIONS);
    if (!filePath) return null;
    const audioHash = computeAudioPayloadFingerprint(filePath);
    const cache = libraryStore.loudnessCache || {};
    const { entry: cached } = resolveHashStoreEntry(cache, { audioHash, filePath });
    if (cached && cached.probe && cached.r128) {
      return cached;
    }
    const probe = cached?.probe || (await probeAudioStreamInfo(filePath));
    const r128 = await measureEbuR128Loudness(filePath, -14.0);
    const info = { probe, r128 };
    const storeKey = audioHash ? `hash:${audioHash}` : filePath;
    libraryStore.loudnessCache = libraryStore.loudnessCache || {};
    libraryStore.loudnessCache[storeKey] = info;
    saveLibraryStore(libraryStore, STORE_PATH);
    return info;
  });

  registerSecureIpcHandler('vanta:wasapi-play', async (_event, payload = {}) => {
    const { filePath: rawPath, exclusive = true, dop = false, deviceId = '', linearGain = 1.0, seekSec = 0 } = payload;
    const filePath = resolveAuthorizedFile(rawPath, ALL_MEDIA_EXTENSIONS);
    if (!filePath) {
      return { ok: false, error: 'Audio file not found or rejected by path policy' };
    }
    try {
      const cache = libraryStore.loudnessCache || {};
      const cached = cache[filePath];
      const probe = cached?.probe || (await probeAudioStreamInfo(filePath));
      await wasapiPlayer.play(filePath, {
        exclusive,
        dop: Boolean(dop),
        deviceId,
        linearGain,
        seekSec,
        probe
      });
      return { ok: true, probe };
    } catch (err) {
      logger.error('WasapiEngine', 'Failed starting native WASAPI playback', { error: err.message });
      return { ok: false, error: err.message };
    }
  });

  registerSecureIpcHandler('vanta:wasapi-cmd', async (_event, cmd) => {
    if (cmd === 'STOP') {
      await wasapiPlayer.stopAsync();
    } else {
      wasapiPlayer.sendCommand(cmd);
    }
    return { ok: true };
  });

  registerSecureIpcHandler('vanta:get-system-volume', () => {
    return volumeBridge.lastState;
  });

  registerSecureIpcHandler('vanta:set-system-volume', (_event, level01) => {
    volumeBridge.setVolume(level01);
    return { ok: true };
  });

  registerSecureIpcHandler('vanta:set-system-mute', (_event, muted) => {
    volumeBridge.setMute(muted);
    return { ok: true };
  });

  registerSecureIpcHandler('vanta:set-volume-device', (_event, deviceId) => {
    volumeBridge.setDevice(deviceId || '');
    return { ok: true };
  });

  registerSecureIpcHandler('vanta:probe-video-streams', async (_event, rawPath) => {
    const cleanPath = resolveAuthorizedFile(rawPath, VIDEO_EXTENSIONS);
    if (!cleanPath) {
      return {
        probe: { durationSec: 0, video: null, audioStreams: [], subtitleStreams: [] },
        strategy: 'direct',
        siblingSubtitles: []
      };
    }
    const probe = await probeMediaStreams(cleanPath);
    const strategy = decideVideoPlaybackStrategy(cleanPath, probe, 0);

    const siblingSubtitles = [];
    const dir = path.dirname(cleanPath);
    const base = path.basename(cleanPath, path.extname(cleanPath)).toLowerCase();
    try {
      for (const entry of fs.readdirSync(dir)) {
        const ext = path.extname(entry).toLowerCase();
        if (ext !== '.srt' && ext !== '.vtt') continue;
        const entryBase = path.basename(entry, ext).toLowerCase();
        if (entryBase === base || entryBase.startsWith(`${base}.`)) {
          const subPath = resolveAuthorizedFile(path.join(dir, entry), SUBTITLE_EXTENSIONS);
          if (subPath) {
            siblingSubtitles.push({
              label: entry,
              path: subPath
            });
          }
        }
      }
    } catch {
      // Ignore directory read error
    }

    return { probe, strategy, siblingSubtitles };
  });

  registerSecureIpcHandler('vanta:get-subtitle-vtt', async (_event, payload = {}) => {
    try {
      if (payload.subtitleFilePath) {
        const safeSubPath = resolveAuthorizedFile(payload.subtitleFilePath, SUBTITLE_EXTENSIONS);
        if (!safeSubPath) return { ok: false, error: 'Subtitle path rejected by security policy' };
        const raw = fs.readFileSync(safeSubPath, 'utf8');
        return { ok: true, vtt: convertSrtToVtt(raw) };
      }
      if (payload.videoPath && Number.isInteger(payload.relSubIdx) && payload.relSubIdx >= 0 && payload.relSubIdx < 64) {
        const safeVideoPath = resolveAuthorizedFile(payload.videoPath, VIDEO_EXTENSIONS);
        if (!safeVideoPath) return { ok: false, error: 'Video path rejected by security policy' };
        const ffmpegBin = resolveFfmpegBinary();
        if (!ffmpegBin) return { ok: false, error: 'FFmpeg unavailable' };
        const safeSubIdx = Number(payload.relSubIdx) & 0x3f;
        const mapSpec = `0:s:${safeSubIdx}`;
        return await new Promise((resolve) => {
          execFile(
            ffmpegBin,
            ['-hide_banner', '-loglevel', 'error', '-i', safeVideoPath, '-map', mapSpec, '-f', 'webvtt', '-'],
            { timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => {
              if (err || !stdout) resolve({ ok: false, error: err?.message || 'Subtitle extraction failed' });
              else resolve({ ok: true, vtt: String(stdout) });
            }
          );
        });
      }
      return { ok: false, error: 'No subtitle source specified' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  registerSecureIpcHandler('vanta:get-track-details', (_event, rawPath) => {
    const safePath = resolveAuthorizedFile(rawPath, ALL_MEDIA_EXTENSIONS);
    if (!safePath) return { lyrics: '' };
    return {
      lyrics: loadTrackLyricsText(safePath)
    };
  });

  registerSecureIpcHandler('vanta:pick-subtitle-file', async () => {
    if (!mainWindow) return { canceled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Load External Subtitle (.SRT / .VTT)',
      filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }],
      properties: ['openFile']
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    const chosen = result.filePaths[0];
    try {
      const raw = fs.readFileSync(chosen, 'utf8');
      return { canceled: false, label: path.basename(chosen), vtt: convertSrtToVtt(raw) };
    } catch (err) {
      return { canceled: false, error: err.message };
    }
  });
}

const coverBinaryCache = new Map();

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = new Set(['media', 'speaker-selection']);
    callback(allowedPermissions.has(permission));
  });

  volumeBridge.start();

  protocol.handle('vanta-cover', (request) => {
    try {
      const parsedUrl = new URL(request.url);
      const rawPath = parsedUrl.searchParams.get('path') || decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
      const filePath = resolveAuthorizedFile(rawPath, ALL_MEDIA_AND_IMAGE_EXTENSIONS);
      if (!filePath) {
        return new Response('Cover not found', { status: 404 });
      }
      const st = fs.statSync(filePath);
      const cacheKey = `${path.normalize(filePath).toLowerCase()}|${st.mtimeMs}`;
      let hit = coverBinaryCache.get(cacheKey);
      if (hit === undefined) {
        hit = loadTrackCoverBinary(filePath);
        if (coverBinaryCache.size >= 240) {
          const oldestKey = coverBinaryCache.keys().next().value;
          coverBinaryCache.delete(oldestKey);
        }
        coverBinaryCache.set(cacheKey, hit || null);
      }
      if (!hit || !hit.buffer) {
        return new Response('No embedded cover', { status: 404 });
      }
      return new Response(hit.buffer, {
        status: 200,
        headers: {
          'Content-Type': hit.mime || 'image/jpeg',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch {
      return new Response('Cover error', { status: 500 });
    }
  });

  protocol.handle('vanta-media', (request) => {
    try {
      const parsedUrl = new URL(request.url);
      const rawPath = parsedUrl.searchParams.get('path') || decodeURIComponent(parsedUrl.pathname.replace(/^\//, ''));
      const seekSec = Math.max(0, Number(parsedUrl.searchParams.get('ss')) || 0);
      const filePath = resolveAuthorizedFile(rawPath, ALL_MEDIA_AND_IMAGE_EXTENSIONS);
      if (!filePath) {
        logger.warn('MediaProtocol', `Requested media file not found or rejected: ${rawPath}`);
        return new Response('File not found', { status: 404 });
      }
      // Transparently handle 4K Video remux/transcode OR audiophile lossless PCM decoding
      const ext = path.extname(filePath).toLowerCase();
      const mediaMode = parsedUrl.searchParams.get('mode') || '';
      const strategy = parsedUrl.searchParams.get('strategy') || 'direct';
      const audioIdx = Math.max(0, Math.min(31, Number.parseInt(parsedUrl.searchParams.get('a') || '0', 10) || 0));

      if (mediaMode === 'video' && (strategy === 'remux-copy' || strategy === 'transcode-h264')) {
        const ffmpegBin = resolveFfmpegBinary();
        if (ffmpegBin) {
          const ffArgs = ['-hide_banner', '-loglevel', 'error'];
          if (seekSec > 0) ffArgs.push('-ss', String(seekSec.toFixed(3)));
          ffArgs.push('-i', filePath, '-map', '0:v:0', '-map', `0:a:${audioIdx}?`);
          if (strategy === 'remux-copy') {
            ffArgs.push('-c:v', 'copy');
          } else {
            ffArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p');
          }
          ffArgs.push(
            '-c:a', 'aac', '-b:a', '256k', '-ac', '2',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4', '-'
          );
          const ff = spawn(ffmpegBin, ffArgs, { windowsHide: true });
          const webStream = Readable.toWeb(ff.stdout);
          request.signal?.addEventListener('abort', () => {
            try { ff.kill(); } catch {}
          });
          return new Response(webStream, {
            status: 200,
            headers: {
              'Content-Type': 'video/mp4'
            }
          });
        }
      }

      if (mediaMode !== 'video' && ALL_MEDIA_EXTENSIONS.has(ext) && (needsLosslessPcmTranscode(filePath) || seekSec > 0)) {
        const ffmpegBin = resolveFfmpegBinary();
        if (ffmpegBin) {
          const ffArgs = ['-hide_banner', '-loglevel', 'error'];
          if (seekSec > 0) ffArgs.push('-ss', String(seekSec.toFixed(3)));
          ffArgs.push('-i', filePath, '-vn');
          // Cap DSD (DSF/DFF) streams cleanly for Chromium Studio DSP HTML5 WAV decoding
          if (['.dsf', '.dff'].includes(ext)) {
            ffArgs.push('-ar', '176400', '-ac', '2');
          }
          ffArgs.push('-f', 'wav', '-acodec', 'pcm_s24le', '-');
          const ff = spawn(ffmpegBin, ffArgs, { windowsHide: true });
          const webStream = Readable.toWeb(ff.stdout);
          request.signal?.addEventListener('abort', () => {
            try { ff.kill(); } catch {}
          });
          return new Response(webStream, {
            status: 200,
            headers: {
              'Content-Type': 'audio/wav'
            }
          });
        }
      }

      const mimeMap = {
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/opus',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.ts': 'video/mp2t',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif'
      };
      const contentType = mimeMap[ext] || 'application/octet-stream';
      const stat = fs.statSync(filePath);
      const fileSize = stat.size;
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (match) {
          let start = match[1] ? Number.parseInt(match[1], 10) : 0;
          let end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
          if (Number.isNaN(start)) start = 0;
          if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
          if (start >= fileSize || start > end) {
            return new Response('', {
              status: 416,
              headers: {
                'Content-Range': `bytes */${fileSize}`
              }
            });
          }
          const chunkSize = end - start + 1;
          const nodeStream = fs.createReadStream(filePath, { start, end });
          return new Response(Readable.toWeb(nodeStream), {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': String(chunkSize),
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes'
            }
          });
        }
      }

      const fullStream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(fullStream), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes'
        }
      });
    } catch (err) {
      logger.error('MediaProtocol', `Error streaming media URL: ${request.url}`, { error: err.message });
      return new Response('Media stream error', { status: 500 });
    }
  });

  registerIpcHandlers();
  createMainWindow();

  try {
    globalShortcut.register('MediaPlayPause', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vanta:media-key', 'PlayPause');
      }
    });
    globalShortcut.register('MediaNextTrack', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vanta:media-key', 'Next');
      }
    });
    globalShortcut.register('MediaPreviousTrack', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vanta:media-key', 'Previous');
      }
    });
  } catch {
    // Ignore if OS locks media keys
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('will-quit', () => {
  wasapiPlayer.stop();
  volumeBridge.stop();
  globalShortcut.unregisterAll();
  logger.info('AppLifecycle', 'VANTA application shutting down cleanly');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
