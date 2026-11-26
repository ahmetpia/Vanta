'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vantaAPI', {
  windowControl: (action) => ipcRenderer.invoke('vanta:window-control', action),
  openVault: (subfolder = '') => ipcRenderer.invoke('vanta:open-vault', subfolder),
  getLogs: () => ipcRenderer.invoke('vanta:get-logs'),
  openLogs: () => ipcRenderer.invoke('vanta:open-logs'),
  logClientEvent: (level, message, meta = null) =>
    ipcRenderer.invoke('vanta:client-log', { level, message, meta }),
  parseInputs: (rawText) => ipcRenderer.invoke('vanta:parse-inputs', rawText),
  resolvePreview: (rawText) => ipcRenderer.invoke('vanta:resolve-preview', rawText),
  downloadBatch: (payload) => ipcRenderer.invoke('vanta:download-batch', payload),
  scanVault: () => ipcRenderer.invoke('vanta:scan-vault'),
  getComputerRoots: () => ipcRenderer.invoke('vanta:get-computer-roots'),
  listDir: (dirPath) => ipcRenderer.invoke('vanta:list-dir', dirPath),
  getHiddenExplorerDirs: () => ipcRenderer.invoke('vanta:get-hidden-explorer-dirs'),
  hideExplorerDirs: (paths) => ipcRenderer.invoke('vanta:hide-explorer-dirs', { paths }),
  unhideExplorerDirs: (paths, all = false) => ipcRenderer.invoke('vanta:unhide-explorer-dirs', { paths, all }),
  addPaths: (paths) => ipcRenderer.invoke('vanta:add-paths', { paths }),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  pickFolder: () => ipcRenderer.invoke('vanta:pick-folder'),
  clearPlaylist: (payload) => ipcRenderer.invoke('vanta:clear-playlist', payload),
  updateTrackMeta: (payload) => ipcRenderer.invoke('vanta:update-track-meta', payload),
  saveSmartPlaylist: (playlist) => ipcRenderer.invoke('vanta:save-smart-playlist', playlist),
  deleteSmartPlaylist: (id) => ipcRenderer.invoke('vanta:delete-smart-playlist', { id }),
  pickPlaylistCover: (playlistId) => ipcRenderer.invoke('vanta:pick-playlist-cover', { playlistId }),
  getFxVideo: () => ipcRenderer.invoke('vanta:get-fx-video'),
  pickFxVideo: () => ipcRenderer.invoke('vanta:pick-fx-video'),
  repairDoctor: () => ipcRenderer.invoke('vanta:repair-doctor'),
  exportWallet: (walletPayload) => ipcRenderer.invoke('vanta:export-wallet', walletPayload),
  listAudioDevices: () => ipcRenderer.invoke('vanta:list-audio-devices'),
  listAsioDevices: () => ipcRenderer.invoke('vanta:list-asio-devices'),
  probeAudioCaps: (payload) => ipcRenderer.invoke('vanta:probe-audio-caps', payload),
  listSacdIso: (isoPath) => ipcRenderer.invoke('vanta:list-sacd-iso', isoPath),
  importSacdIso: (isoPath) => ipcRenderer.invoke('vanta:import-sacd-iso', isoPath),
  importAutoEqTxt: (txtPath = '') => ipcRenderer.invoke('vanta:import-autoeq-txt', txtPath),
  pickConvolverIr: () => ipcRenderer.invoke('vanta:pick-convolver-ir'),
  loadConvolverIr: (payload) => ipcRenderer.invoke('vanta:load-convolver-ir', payload),
  analyzeAlbumReplayGain: (payload) => ipcRenderer.invoke('vanta:analyze-album-replaygain', payload),
  probeAudio: (filePath) => ipcRenderer.invoke('vanta:probe-audio', filePath),
  probeTrackTech: (payload) => ipcRenderer.invoke('vanta:probe-tech', payload),
  getTrackDetails: (filePath) => ipcRenderer.invoke('vanta:get-track-details', filePath),
  probeVideoStreams: (filePath) => ipcRenderer.invoke('vanta:probe-video-streams', filePath),
  getSubtitleVtt: (payload) => ipcRenderer.invoke('vanta:get-subtitle-vtt', payload),
  pickSubtitleFile: () => ipcRenderer.invoke('vanta:pick-subtitle-file'),
  wasapiPlay: (payload) => ipcRenderer.invoke('vanta:wasapi-play', payload),
  wasapiQueueNext: (payload) => ipcRenderer.invoke('vanta:wasapi-queue-next', payload),
  wasapiCmd: (cmd) => ipcRenderer.invoke('vanta:wasapi-cmd', cmd),
  getSystemVolume: () => ipcRenderer.invoke('vanta:get-system-volume'),
  setSystemVolume: (level01) => ipcRenderer.invoke('vanta:set-system-volume', level01),
  setSystemMute: (muted) => ipcRenderer.invoke('vanta:set-system-mute', muted),
  setVolumeDevice: (deviceId) => ipcRenderer.invoke('vanta:set-volume-device', deviceId),
  onVolumeEvent: (callback) => {
    const handler = (_event, evt) => callback(evt);
    ipcRenderer.on('vanta:volume-event', handler);
    return () => ipcRenderer.removeListener('vanta:volume-event', handler);
  },
  onAudioDevicesChanged: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('vanta:audio-devices-changed', handler);
    return () => ipcRenderer.removeListener('vanta:audio-devices-changed', handler);
  },
  onWasapiEvent: (callback) => {
    const handler = (_event, evt) => callback(evt);
    ipcRenderer.on('vanta:wasapi-event', handler);
    return () => ipcRenderer.removeListener('vanta:wasapi-event', handler);
  },
  onBatchProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('vanta:batch-progress', handler);
    return () => ipcRenderer.removeListener('vanta:batch-progress', handler);
  },
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('vanta:scan-progress', handler);
    return () => ipcRenderer.removeListener('vanta:scan-progress', handler);
  },
  onMediaKey: (callback) => {
    const handler = (_event, keyAction) => callback(keyAction);
    ipcRenderer.on('vanta:media-key', handler);
    return () => ipcRenderer.removeListener('vanta:media-key', handler);
  }
});
