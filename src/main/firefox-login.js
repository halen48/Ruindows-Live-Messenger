'use strict';

/**
 * "Usar o login do Firefox": copies my existing Google / AI-site sessions
 * from Firefox into the AI windows' session, when I click it.
 *
 * Google refuses to sign in inside embedded browsers, but a session that
 * already exists works. Firefox keeps its cookies unencrypted in
 * cookies.sqlite on every OS (Chrome encrypts them with the system keyring),
 * and doesn't bind Google sessions to the device, so its sessions carry over.
 *
 * Only cookies of the sites below are read, straight from Firefox's file into
 * the app's own cookie store (nothing is written anywhere else). Cloudflare's
 * bot-check cookies are left out: they're tied to Firefox's own identity.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DOMAINS = ['google.com', 'chatgpt.com', 'openai.com', 'claude.ai', 'anthropic.com', 'deepseek.com'];
const SKIP = /^(cf_clearance|__cf_bm|_cfuvid)$/;

function firefoxRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')];
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Firefox')];
  return [
    path.join(home, '.mozilla', 'firefox'),
    path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
  ];
}

/** Every profile's cookies.sqlite, the most recently used first. */
function cookieFiles() {
  const found = [];
  for (const root of firefoxRoots()) {
    let ini = '';
    try { ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8'); } catch { continue; }
    let rel = true;
    for (const line of ini.split(/\r?\n/)) {
      if (/^IsRelative=/.test(line)) rel = line.endsWith('1');
      const m = line.match(/^Path=(.+)$/);
      if (!m) continue;
      const dir = rel ? path.join(root, m[1]) : m[1];
      const file = path.join(dir, 'cookies.sqlite');
      try { found.push({ file, profile: path.basename(dir), mtime: fs.statSync(file).mtimeMs }); } catch {}
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/**
 * Firefox writes new cookies (a login made a minute ago) to cookies.sqlite-wal
 * first and only folds them into cookies.sqlite later, so reading the main
 * file alone misses them. sql.js can't read a WAL, so its committed pages are
 * applied to an in-memory copy of the database here.
 */
function withWal(db, wal) {
  if (!wal || wal.length < 32) return db;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return db;
  const pageSize = wal.readUInt32BE(8);
  const salt1 = wal.readUInt32BE(16), salt2 = wal.readUInt32BE(20);
  const frame = 24 + pageSize;
  const pages = new Map();
  let committed = new Map(), dbPages = 0;
  for (let off = 32; off + frame <= wal.length; off += frame) {
    // frames from an older generation of the WAL end the valid part
    if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2) break;
    pages.set(wal.readUInt32BE(off), wal.subarray(off + 24, off + frame));
    const size = wal.readUInt32BE(off + 4);
    if (size) { committed = new Map(pages); dbPages = size; } // commit frame
  }
  if (!dbPages) return db;
  const out = Buffer.alloc(dbPages * pageSize);
  db.copy(out, 0, 0, Math.min(db.length, out.length));
  for (const [pgno, data] of committed) if (pgno <= dbPages) data.copy(out, (pgno - 1) * pageSize);
  // mark it as a plain (non-WAL) database so sql.js opens it
  out[18] = 1;
  out[19] = 1;
  return out;
}

async function readCookies(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  // read into memory: Firefox may have the file open, and nothing is copied to disk
  let wal = null;
  try { wal = fs.readFileSync(file + '-wal'); } catch {}
  const db = new SQL.Database(withWal(fs.readFileSync(file), wal));
  try {
    const where = DOMAINS.map(() => 'host LIKE ?').join(' OR ');
    const stmt = db.prepare(`SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies WHERE (${where})`);
    stmt.bind(DOMAINS.map((d) => `%${d}`));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } finally {
    db.close();
  }
}

/**
 * Firefox keeps several copies of the same cookie: the real first-party one,
 * one per container ("^userContextId=N"), and with Total Cookie Protection one
 * per site that embeds Google ("^partitionKey=..."), which is usually a
 * logged-out visitor. Copying them all let a partitioned copy overwrite the
 * real session (Gemini never logged in while Claude did). So: only
 * unpartitioned cookies, from the default jar, or from the container that
 * actually holds the Google login if the default one doesn't.
 */
const hasGoogle = (list) => list.some((r) => /google\.com$/.test(r.host) && /^(__Secure-[13]PSID|SID)$/.test(r.name));

function pickJar(rows) {
  const jars = new Map();
  for (const r of rows) {
    const oa = String(r.originAttributes || '');
    if (/partitionKey=/.test(oa)) continue;
    if (!jars.has(oa)) jars.set(oa, []);
    jars.get(oa).push(r);
  }
  const loggedIn = hasGoogle;
  const def = jars.get('') || [];
  if (loggedIn(def) || jars.size <= 1) return def;
  const withGoogle = [...jars.entries()].filter(([, list]) => loggedIn(list));
  if (!withGoogle.length) return def;
  // the default jar still wins for the other sites; the container adds Google
  const [, container] = withGoogle[0];
  const key = (r) => `${r.host}|${r.path}|${r.name}`;
  const merged = new Map(def.map((r) => [key(r), r]));
  for (const r of container) if (/google\.com$/.test(r.host)) merged.set(key(r), r);
  return [...merged.values()];
}

/**
 * Copy the cookies into an Electron session. Resolves with how many were
 * copied and from which profile, or throws if there's nothing to use.
 */
async function importFirefoxLogin(session) {
  const files = cookieFiles();
  if (!files.length) throw new Error('não achei o Firefox neste PC');
  const now = Date.now() / 1000;
  for (const { file, profile } of files) {
    const rows = pickJar(await readCookies(file));
    if (!rows.length) continue;
    let copied = 0;
    const failed = [];
    for (const r of rows) {
      if (SKIP.test(r.name)) continue;
      // newer Firefox stores the expiry in milliseconds
      const expiry = r.expiry > 1e11 ? r.expiry / 1000 : r.expiry;
      if (expiry && expiry < now) continue;
      const host = r.host.replace(/^\./, '');
      const cookie = {
        url: `https://${host}${r.path || '/'}`,
        name: r.name,
        value: r.value,
        path: r.path || '/',
        secure: !!r.isSecure || r.name.startsWith('__Secure-') || r.name.startsWith('__Host-'),
        httpOnly: !!r.isHttpOnly,
        sameSite: ['no_restriction', 'lax', 'strict'][r.sameSite] || 'lax',
      };
      // Chromium refuses SameSite=None without Secure
      if (cookie.sameSite === 'no_restriction' && !cookie.secure) cookie.sameSite = 'lax';
      if (expiry) cookie.expirationDate = expiry;
      // __Host- cookies must not name a domain; dotted hosts cover subdomains
      if (r.host.startsWith('.') && !r.name.startsWith('__Host-')) cookie.domain = r.host;
      try {
        await session.cookies.set(cookie);
        copied++;
      } catch {
        // a cookie Chromium won't take: only its name is kept, for the message
        failed.push(r.name);
      }
    }
    await session.cookies.flushStore();
    const google = hasGoogle(rows);
    return { copied, profile, google, failed: failed.length };
  }
  throw new Error('o Firefox não tem login no Google nem nessas IAs');
}

/** Whether the most recent Firefox profile is logged in to Google (reads only, copies nothing). */
async function firefoxHasGoogle() {
  const [latest] = cookieFiles();
  if (!latest) return false;
  try { return hasGoogle(pickJar(await readCookies(latest.file))); } catch { return false; }
}

/**
 * Open Google's sign-in in Firefox itself (where Google allows it). Tries the
 * usual ways Firefox is installed; resolves false if none starts.
 */
function openFirefox(url) {
  const { spawn } = require('child_process');
  const tries = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', 'firefox', url]]]
    : process.platform === 'darwin'
      ? [['open', ['-a', 'Firefox', url]]]
      : [['firefox', [url]], ['flatpak', ['run', 'org.mozilla.firefox', url]], ['snap', ['run', 'firefox', url]]];
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= tries.length) return resolve(false);
      const [cmd, args] = tries[i];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => next(i + 1));
      child.once('spawn', () => { child.unref(); resolve(true); });
    };
    next(0);
  });
}

module.exports = { importFirefoxLogin, firefoxHasGoogle, openFirefox, withWal };
