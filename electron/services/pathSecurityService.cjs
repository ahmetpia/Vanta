'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
const SACD_ISO_EXTENSIONS = new Set(['.iso']);
const PEQ_TXT_EXTENSIONS = new Set(['.txt']);
const CONVOLVER_IR_EXTENSIONS = new Set(['.wav']);
const PLAYLIST_EXTENSIONS = new Set(['.m3u8', '.m3u']);

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
  let key = subfolder.trim().replaceAll('\\', '/').toLowerCase();
  while (key.startsWith('/')) key = key.slice(1);
  while (key.endsWith('/')) key = key.slice(0, -1);
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

/**
 * Resolves an untrusted host path strictly from a set of trusted root directories by walking
 * real OS directory entries (`fs.readdirSync`), ensuring the returned string never contains
 * tainted user input and never traverses symlinks/junctions or blocked system segments.
 * @param {string} rawPath - Untrusted path input.
 * @param {Iterable<string>} trustedRoots - Trusted root directories (e.g. drive roots, VAULT_ROOT).
 * @param {object} [options={}] - Resolution options.
 * @param {'file'|'dir'|'any'} [options.expect='any'] - Expected filesystem entry kind.
 * @param {Set<string>|null} [options.allowedExtensions=null] - Optional lowercase extension allowlist for files.
 * @param {Set<string>|null} [options.blockedSegments=null] - Optional lowercase directory segment blocklist.
 * @returns {string|null} Server-constructed canonical path, or null if invalid/not found.
 */
function resolveFromTrustedRoots(rawPath, trustedRoots, options = {}) {
  const { expect = 'any', allowedExtensions = null, blockedSegments = null } = options;
  if (!hasSafePathSyntax(rawPath)) return null;

  const targetResolved = path.resolve(rawPath.trim());
  const targetCmp = toComparisonPath(targetResolved);

  // Pick the longest matching trusted root
  let matchedRoot = null;
  let matchedRootCmp = '';
  for (const root of trustedRoots || []) {
    if (!root) continue;
    const rootCanon = canonicalizePath(root);
    const rootCmp = toComparisonPath(rootCanon);
    const prefix = rootCmp.endsWith(path.sep) ? rootCmp : `${rootCmp}${path.sep}`;
    if (targetCmp === rootCmp || targetCmp.startsWith(prefix)) {
      if (rootCmp.length > matchedRootCmp.length) {
        matchedRoot = rootCanon;
        matchedRootCmp = rootCmp;
      }
    }
  }
  if (!matchedRoot) return null;

  const rel = path.relative(matchedRoot, targetResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const segments = rel ? rel.split(path.sep).filter(Boolean) : [];
  let current = matchedRoot;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === '.' || seg === '..' || WINDOWS_RESERVED_DEVICE_RE.test(seg)) return null;
    if (blockedSegments && blockedSegments.has(seg.toLowerCase())) return null;

    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }

    const segCmp = process.platform === 'win32' ? seg.toLowerCase() : seg;
    const match = entries.find((e) => (process.platform === 'win32' ? e.name.toLowerCase() : e.name) === segCmp);
    if (!match) return null;

    const isLast = i === segments.length - 1;
    const nextPath = path.join(current, match.name);
    if (!isLast) {
      if (!match.isDirectory()) {
        if (!match.isSymbolicLink()) return null;
        try {
          if (!fs.statSync(nextPath).isDirectory()) return null;
        } catch {
          return null;
        }
      }
      current = nextPath;
    } else {
      let isFile = match.isFile();
      let isDir = match.isDirectory();
      if (match.isSymbolicLink()) {
        try {
          const st = fs.statSync(nextPath);
          isFile = st.isFile();
          isDir = st.isDirectory();
        } catch {
          return null;
        }
      }
      if (expect === 'file' && !isFile) return null;
      if (expect === 'dir' && !isDir) return null;
      if (!isFile && !isDir) return null;
      if (isFile && allowedExtensions) {
        const ext = path.extname(match.name).toLowerCase();
        if (!allowedExtensions.has(ext)) return null;
      }
      current = nextPath;
    }
  }

  if (segments.length === 0 && expect === 'file') return null;
  return canonicalizePath(current);
}

/**
 * Validates that an `.iso` file exists, obeys all path security checks, and contains a genuine
 * ScarletBook `SACDMTOC` header at LSN 510 (2048-byte or raw 2064-byte sector layout).
 * Rejects OS/DVD/arbitrary `.iso` files before any ingestion or extraction.
 * @param {string} rawPath - Untrusted ISO file path.
 * @returns {string|null} Canonical verified SACD ISO path or null if rejected.
 */
function validateSafeSacdIsoPath(rawPath) {
  const canon = validateSafeFilePath(rawPath, { allowedExtensions: SACD_ISO_EXTENSIONS });
  if (!canon) return null;
  let fd = null;
  try {
    fd = fs.openSync(canon, 'r');
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size < 511 * 2048) return null;
    const sig = Buffer.alloc(8);
    if (fs.readSync(fd, sig, 0, 8, 510 * 2048) === 8 && sig.toString('ascii') === 'SACDMTOC') {
      return canon;
    }
    if (st.size >= 511 * 2064 && fs.readSync(fd, sig, 0, 8, 510 * 2064 + 12) === 8 && sig.toString('ascii') === 'SACDMTOC') {
      return canon;
    }
    return null;
  } catch {
    return null;
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
  SUBTITLE_EXTENSIONS,
  IMAGE_EXTENSIONS,
  SACD_ISO_EXTENSIONS,
  PEQ_TXT_EXTENSIONS,
  CONVOLVER_IR_EXTENSIONS,
  PLAYLIST_EXTENSIONS,
  VAULT_SUBFOLDER_MAP,
  hasSafePathSyntax,
  canonicalizePath,
  isPathInsideDir,
  resolveSafeVaultSubfolder,
  validateSafeFilePath,
  validateSafeDirectoryPath,
  validateSafeSacdIsoPath,
  isPathAuthorizedInScope,
  resolveFromTrustedRoots
};
