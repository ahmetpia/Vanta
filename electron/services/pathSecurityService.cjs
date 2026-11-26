'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

const WINDOWS_RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

const VAULT_SUBFOLDER_MAP = Object.freeze({
  '': '',
  youtube: 'YouTube',
  local: 'Local',
  covers: 'Covers',
  'covers/playlists': path.join('Covers', 'playlists'),
  exports: 'Exports',
  logs: 'logs'
});

/**
 * Checks whether a raw path string contains null bytes, control chars, UNC prefixes,
 * leading dashes (CLI argument tampering), or Windows Alternate Data Streams.
 * @param {string} rawPath - Untrusted path input.
 * @returns {boolean} True when syntactically safe to canonicalize.
 */
function hasSafePathSyntax(rawPath) {
  if (typeof rawPath !== 'string') return false;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 4096) return false;
  if (trimmed.includes('\0') || /[\r\n]/.test(trimmed)) return false;
  // Block CLI flag confusion (e.g. "-i", "--output")
  if (trimmed.startsWith('-')) return false;
  // Block UNC network shares (\\server\share or //server/share) and Windows device namespaces (\\.\...)
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) return false;
  // Block NTFS Alternate Data Streams (any colon after drive-letter index 1)
  const colonIdx = trimmed.indexOf(':', 2);
  if (colonIdx !== -1) return false;
  return true;
}

/**
 * Canonicalizes a filesystem path, resolving symlinks/junctions when the path exists.
 * @param {string} targetPath - Normalized path.
 * @returns {string} Canonical real path (or resolved path if not yet on disk).
 */
function canonicalizePath(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Normalizes path casing on Windows for safe prefix comparisons.
 * @param {string} p - Path string.
 * @returns {string} Comparison key.
 */
function toComparisonPath(p) {
  const norm = path.normalize(String(p || ''));
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/**
 * Checks whether `candidatePath` is strictly equal to or inside `rootDir`.
 * @param {string} rootDir - Trusted root directory.
 * @param {string} candidatePath - Path to verify.
 * @returns {boolean} True when contained within `rootDir`.
 */
function isPathInsideDir(rootDir, candidatePath) {
  if (!rootDir || !candidatePath) return false;
  const rootCanon = toComparisonPath(canonicalizePath(rootDir));
  const candCanon = toComparisonPath(canonicalizePath(candidatePath));
  if (candCanon === rootCanon) return true;
  const prefix = rootCanon.endsWith(path.sep) ? rootCanon : `${rootCanon}${path.sep}`;
  return candCanon.startsWith(prefix);
}

/**
 * Resolves an allowlisted subfolder strictly inside `vaultRoot` (prevents traversal & command tampering).
 * @param {string} vaultRoot - Configured VantaVault root path.
 * @param {string} [subfolder=''] - Requested vault subfolder name.
 * @returns {string|null} Canonical safe directory path or null if rejected.
 */
function resolveSafeVaultSubfolder(vaultRoot, subfolder = '') {
  if (typeof subfolder !== 'string') return null;
  const key = subfolder.trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!Object.hasOwn(VAULT_SUBFOLDER_MAP, key)) {
    return null;
  }
  const rootCanon = canonicalizePath(vaultRoot);
  const rel = VAULT_SUBFOLDER_MAP[key];
  const candidate = rel ? path.resolve(rootCanon, rel) : rootCanon;
  return isPathInsideDir(rootCanon, candidate) ? candidate : null;
}

/**
 * Validates and canonicalizes a host file path for read/probe/write operations.
 * Blocks null bytes, UNC paths, ADS streams, leading dashes, device names, and disallowed extensions.
 * @param {string} rawPath - Untrusted file path.
 * @param {object} [options={}] - Validation options.
 * @param {Set<string>|null} [options.allowedExtensions=null] - Optional lowercase extension allowlist.
 * @param {boolean} [options.mustExist=true] - Require existing regular file.
 * @returns {string|null} Canonical real file path, or null if invalid/unsafe.
 */
function validateSafeFilePath(rawPath, options = {}) {
  const { allowedExtensions = null, mustExist = true } = options;
  if (!hasSafePathSyntax(rawPath)) return null;

  const trimmed = rawPath.trim();
  const baseName = path.basename(trimmed);
  if (!baseName || WINDOWS_RESERVED_DEVICE_RE.test(baseName)) return null;

  const resolved = path.resolve(trimmed);
  if (allowedExtensions) {
    const ext = path.extname(resolved).toLowerCase();
    if (!allowedExtensions.has(ext)) return null;
  }

  if (mustExist) {
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
  }

  const canonical = canonicalizePath(resolved);
  if (allowedExtensions) {
    const canonExt = path.extname(canonical).toLowerCase();
    if (!allowedExtensions.has(canonExt)) return null;
  }
  return canonical;
}

/**
 * Validates and canonicalizes a directory path for safe read-only listing/scanning.
 * @param {string} rawDir - Untrusted directory path.
 * @param {object} [options={}] - Validation options.
 * @param {boolean} [options.mustExist=true] - Require existing directory.
 * @returns {string|null} Canonical directory path, or null if unsafe.
 */
function validateSafeDirectoryPath(rawDir, options = {}) {
  const { mustExist = true } = options;
  if (!hasSafePathSyntax(rawDir)) return null;

  const trimmed = rawDir.trim();
  const resolved = path.resolve(trimmed);

  if (mustExist) {
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return null;
  }

  return canonicalizePath(resolved);
}

/**
 * Checks whether a canonical file path is authorized within the current application scope
 * (VantaVault, watched folders, explicit watched files, or approved standalone media/cover paths).
 * @param {string} canonicalFilePath - Already validated canonical file path.
 * @param {object} scope - Current authorized scope sets.
 * @param {string} scope.vaultRoot - Vault root path.
 * @param {Iterable<string>} [scope.watchedFolders=[]] - Authorized folder roots.
 * @param {Iterable<string>} [scope.watchedFiles=[]] - Authorized standalone file paths.
 * @param {Iterable<string>} [scope.extraFiles=[]] - Additional dialog-approved file paths.
 * @param {boolean} [scope.allowSiblingInWatchedFileDirs=false] - Allow sibling files (e.g. .srt) next to watchedFiles.
 * @returns {boolean} True when authorized.
 */
function isPathAuthorizedInScope(canonicalFilePath, scope = {}) {
  if (!canonicalFilePath) return false;
  const candCmp = toComparisonPath(canonicalFilePath);

  if (scope.vaultRoot && isPathInsideDir(scope.vaultRoot, canonicalFilePath)) {
    return true;
  }

  for (const folder of scope.watchedFolders || []) {
    if (folder && isPathInsideDir(folder, canonicalFilePath)) {
      return true;
    }
  }

  for (const wf of scope.watchedFiles || []) {
    if (!wf) continue;
    const wfCanon = canonicalizePath(wf);
    if (toComparisonPath(wfCanon) === candCmp) return true;
    if (scope.allowSiblingInWatchedFileDirs) {
      if (toComparisonPath(path.dirname(wfCanon)) === toComparisonPath(path.dirname(canonicalFilePath))) {
        return true;
      }
    }
  }

  for (const ef of scope.extraFiles || []) {
    if (!ef) continue;
    if (toComparisonPath(canonicalizePath(ef)) === candCmp) return true;
  }

  return false;
}

module.exports = {
  SUBTITLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  VAULT_SUBFOLDER_MAP,
  hasSafePathSyntax,
  canonicalizePath,
  isPathInsideDir,
  resolveSafeVaultSubfolder,
  validateSafeFilePath,
  validateSafeDirectoryPath,
  isPathAuthorizedInScope
};
