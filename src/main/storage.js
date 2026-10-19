'use strict';

/**
 * Where things live on disk, per OS, and the media cache policy.
 *
 * - Session, messages and settings stay in the app data folder (they can't
 *   be rebuilt: WhatsApp sends full history only when the QR is scanned).
 * - The embedded browser's HTTP cache is disposable: RAM (/dev/shm) on
 *   Linux, the temp folder elsewhere.
 * - Downloaded media (photos, videos, stickers) can always be fetched again,
 *   so it lives either in the OS cache folder, trimmed by age and size
 *   ("persist"), or in a scratch folder wiped every time the app opens and
 *   closes ("temp"), for full disks or metered connections.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// demo runs get their own folders so they never touch the real ones
const APP = process.env.MSN_DEMO ? 'whatsmsn-demo' : 'whatsmsn';

const DEFAULT_MEDIA = {
  mode: 'persist', // 'persist' | 'temp'
  keepValue: 7, // how long downloaded media is kept in persist mode...
  keepUnit: 'days', // ...'hours' | 'days'
  maxMB: 500, // and the most it may take
  autoDownload: true, // load photos as they show up; off = click to download
};

function userTag() {
  try { return String(os.userInfo().uid ?? os.userInfo().username); } catch { return 'user'; }
}

/** RAM-backed scratch space on Linux, the OS temp folder elsewhere. */
function scratchRoot() {
  if (process.platform === 'linux' && fs.existsSync('/dev/shm')) return path.join('/dev/shm', `${APP}-${userTag()}`);
  return path.join(os.tmpdir(), `${APP}-${userTag()}`);
}

/** The OS's per-user cache folder. */
function cacheRoot() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.tmpdir(), APP, 'Cache');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', APP);
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), APP);
}

const paths = {
  browserCache: () => path.join(scratchRoot(), 'browser'),
  persistMedia: () => path.join(cacheRoot(), 'media'),
  tempMedia: () => path.join(scratchRoot(), 'media'),
};

function mediaOptions(settings) {
  return { ...DEFAULT_MEDIA, ...(settings.media || {}) };
}

function mediaDir(opts) {
  return opts.mode === 'temp' ? paths.tempMedia() : paths.persistMedia();
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).map((name) => {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        return st.isFile() ? { file, size: st.size, used: Math.max(st.atimeMs, st.mtimeMs) } : null;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function usage(dir) {
  const files = listFiles(dir);
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

function wipe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Drop media not used within the keep window, then the oldest until under the size cap. */
function trim(dir, opts) {
  const maxAge = opts.keepValue * (opts.keepUnit === 'hours' ? 3600e3 : 86400e3);
  const now = Date.now();
  let files = listFiles(dir);
  for (const f of files) {
    if (now - f.used > maxAge) { try { fs.rmSync(f.file); } catch {} }
  }
  files = listFiles(dir).sort((a, b) => a.used - b.used);
  let total = files.reduce((n, f) => n + f.size, 0);
  const cap = opts.maxMB * 1024 * 1024;
  for (const f of files) {
    if (total <= cap) break;
    try { fs.rmSync(f.file); total -= f.size; } catch {}
  }
}

/** Mark a cached file as just used, so the age/size trim keeps it longer. */
function touch(file) {
  try { const now = new Date(); fs.utimesSync(file, now, now); } catch {}
}

/**
 * Apply the policy at startup (and when options change): temp mode starts
 * empty; persist mode trims. Media from older versions (inside the data
 * folder) moves to the new place once.
 */
function prepareMedia(opts, legacyDir) {
  const dir = mediaDir(opts);
  if (opts.mode === 'temp') {
    wipe(dir);
    wipe(paths.persistMedia()); // chose not to keep media on disk
  } else {
    wipe(paths.tempMedia());
  }
  fs.mkdirSync(dir, { recursive: true });
  if (legacyDir && fs.existsSync(legacyDir)) {
    if (opts.mode === 'persist') {
      for (const name of fs.readdirSync(legacyDir)) {
        const from = path.join(legacyDir, name);
        const to = path.join(dir, name);
        try { fs.renameSync(from, to); } catch { try { fs.copyFileSync(from, to); } catch {} }
      }
    }
    wipe(legacyDir);
  }
  if (opts.mode === 'persist') trim(dir, opts);
  return dir;
}

module.exports = { DEFAULT_MEDIA, paths, mediaOptions, mediaDir, prepareMedia, trim, wipe, usage, touch };
