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

async function readCookies(file) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  // read into memory: Firefox may have the file open, and nothing is copied to disk
  const db = new SQL.Database(fs.readFileSync(file));
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
function pickJar(rows) {
  const jars = new Map();
  for (const r of rows) {
    const oa = String(r.originAttributes || '');
    if (/partitionKey=/.test(oa)) continue;
    if (!jars.has(oa)) jars.set(oa, []);
    jars.get(oa).push(r);
  }
  const loggedIn = (list) => list.some((r) => /google\.com$/.test(r.host) && /^(__Secure-[13]PSID|SID)$/.test(r.name));
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
    const google = rows.some((r) => /google\.com$/.test(r.host) && /^(__Secure-[13]PSID|SID)$/.test(r.name));
    return { copied, profile, google, failed: failed.length };
  }
  throw new Error('o Firefox não tem login no Google nem nessas IAs');
}

module.exports = { importFirefoxLogin };
