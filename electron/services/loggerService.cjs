'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = 'C:\\Vanta\\VantaVault\\logs';
const LOG_FILE = path.join(LOG_DIR, 'vanta.log');
const MAX_MEM_ENTRIES = 250;
const recentEntries = [];

/**
 * Ensures the C:\Vanta\VantaVault\logs directory exists.
 */
function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Ignore directory error
  }
}

/**
 * Writes a structured log entry to C:\Vanta\VantaVault\logs\vanta.log and memory ring buffer.
 * @param {'INFO'|'WARN'|'ERROR'} level - Log severity level.
 * @param {string} scope - Subsystem or module name (e.g., 'FolderScanner', 'IPC', 'Suno').
 * @param {string} message - Human-readable log description.
 * @param {object} [meta] - Optional structured diagnostic metadata.
 * @returns {object} Recorded log entry object.
 */
function writeLog(level, scope, message, meta = null) {
  ensureLogDir();
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
  const line = `[${timestamp}] [${level}] [${scope}] ${message}${metaStr}\n`;

  const entry = {
    timestamp,
    level,
    scope,
    message,
    meta
  };

  recentEntries.push(entry);
  if (recentEntries.length > MAX_MEM_ENTRIES) {
    recentEntries.shift();
  }

  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // Fallback if disk write fails
  }

  return entry;
}

const logger = {
  logFilePath: LOG_FILE,
  info: (scope, msg, meta) => writeLog('INFO', scope, msg, meta),
  warn: (scope, msg, meta) => writeLog('WARN', scope, msg, meta),
  error: (scope, msg, meta) => writeLog('ERROR', scope, msg, meta),
  getRecentLogs: () => [...recentEntries]
};

module.exports = logger;
