'use strict';

// libsignal prints every failed decrypt ("Bad MAC", "Failed to decrypt
// message with any known session...") with a full stack trace straight to
// the console. Baileys already recovers by asking the sender to resend, so
// keep the terminal quiet unless debugging.
if (!process.env.MSN_DEBUG) {
  const NOISE = /Bad MAC|Failed to decrypt message|Session error|Closing (open )?session|Closing stale|Decrypted message with closed session|No session found|Removing old closed session/i;
  for (const level of ['log', 'error', 'warn', 'info']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const first = args[0] instanceof Error ? args[0].message : String(args[0] ?? '');
      if (NOISE.test(first) || (args[1] instanceof Error && NOISE.test(args[1].message))) return;
      original(...args);
    };
  }
}

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage, screen } = require('electron');
const QRCode = require('qrcode');
const { WhatsAppService } = require('./whatsapp');
const { AiService } = require('./ai');
const storage = require('./storage');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.js');
// the WLM 8.5 two-buddies icon, for the taskbar/dock and the tray
const APP_ICON = path.join(RENDERER, 'assets', 'wlm85', 'app-icon.png');
const TRAY_ICON = path.join(RENDERER, 'assets', 'wlm85', 'tray-icon.png');

// renaming the app moves userData, so pin it first: the WhatsApp session lives there
// demo/screenshot runs get their own folder so they never touch the real profile or session
const USER_DATA = process.env.MSN_DEMO
  ? path.join(app.getPath('temp'), 'whatsmsn-demo')
  : path.join(app.getPath('appData'), 'whatsmsn'); // same folder in dev and in installed builds
app.setName('Ruindows Live Messenger');
app.setPath('userData', USER_DATA);
// the embedded browser's HTTP cache is disposable: RAM on Linux, temp elsewhere
app.commandLine.appendSwitch('disk-cache-dir', storage.paths.browserCache());

let wa = null;
let loginWin = null;
let buddyWin = null;
const chatWins = new Map(); // jid -> BrowserWindow

// My MSN status is purely cosmetic: nothing is sent to WhatsApp. "busy"
// (Ocupado) silences toasts and sounds, like Messenger did.
// the seven statuses of Messenger 8.5, in its menu order
const STATUS_LABEL = { online: 'Online', busy: 'Ocupado', brb: 'Volto logo', away: 'Ausente', phone: 'Ao telefone', lunch: 'Saí para almoçar', offline: 'Offline' };

// My nick, personal message, pictures and status, kept in a file so they
// come back exactly as I left them. localStorage alone loses recent writes
// when the app is killed (Ctrl+C, tray "Sair").
const SETTINGS_FILE = path.join(USER_DATA, 'wlm-settings.json');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
const settings = readSettings();
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(settings));
    fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE);
  } catch (e) {
    console.error('could not save settings:', e.message);
  }
}

let myStatus = STATUS_LABEL[settings.status] ? settings.status : 'online'; // online | busy | away | offline

function setMyStatus(status) {
  if (!STATUS_LABEL[status]) return;
  myStatus = status;
  settings.status = status;
  saveSettings();
  try { tray?.setToolTip(`Ruindows Live Messenger - ${STATUS_LABEL[status]}`); } catch {}
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('ui:status', status);
  }
}

function baseWindowOptions(width, height) {
  return {
    width,
    height,
    frame: false,
    transparent: true,
    resizable: true,
    show: false,
    icon: APP_ICON,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

/**
 * Dev aid: MSN_SHOT_DIR=/some/dir saves a PNG of each window after load.
 * MSN_SHOT_PROBE can hold a JS snippet executed pre-capture (e.g. to
 * open a menu) — it no-ops on windows where its selectors don't match.
 */
function attachScreenshot(win, name) {
  if (!process.env.MSN_SHOT_DIR) return;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (process.env.MSN_SHOT_PROBE) {
          // whatever the snippet returns is saved next to the PNG
          const out = await win.webContents.executeJavaScript(process.env.MSN_SHOT_PROBE).catch(() => null);
          if (out != null) fs.writeFileSync(path.join(process.env.MSN_SHOT_DIR, `${name}.probe.json`), JSON.stringify(out, null, 1));
          await new Promise((r) => setTimeout(r, 250));
        }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(process.env.MSN_SHOT_DIR, `${name}.png`), img.toPNG());
      } catch (e) {
        console.error('screenshot failed', e);
      }
    }, Number(process.env.MSN_SHOT_DELAY) || 1500);
  });
}

function createLoginWindow() {
  loginWin = new BrowserWindow({ ...baseWindowOptions(300, 640), resizable: false });
  loginWin.loadFile(path.join(RENDERER, 'login.html'));
  loginWin.once('ready-to-show', () => loginWin?.show());
  attachScreenshot(loginWin, 'login');
  loginWin.on('closed', () => {
    loginWin = null;
    if (!buddyWin) app.quit();
  });
}

function createBuddyListWindow() {
  buddyWin = new BrowserWindow(baseWindowOptions(330, 660));
  buddyWin.loadFile(path.join(RENDERER, 'buddylist.html'));
  buddyWin.once('ready-to-show', () => buddyWin?.show());
  attachScreenshot(buddyWin, 'buddylist');
  buddyWin.on('closed', () => {
    buddyWin = null;
    if (!loginWin) app.quit();
  });
}

function openChatWindow(jid, { focus = true } = {}) {
  let win = chatWins.get(jid);
  if (win && !win.isDestroyed()) {
    if (focus) win.focus();
    return win;
  }
  win = new BrowserWindow(baseWindowOptions(620, 560));
  win.loadFile(path.join(RENDERER, 'chat.html'), { query: { jid } });
  // incoming-message windows open inactive, like MSN's taskbar flash
  win.once('ready-to-show', () => (focus ? win.show() : win.showInactive()));
  attachScreenshot(win, 'chat');
  win.on('closed', () => {
    chatWins.delete(jid);
    // stop following a Claude Code session's file once its window is gone
    if (AiService.isCodeJid(jid)) ai.code.unwatch(jid.slice('ai:cc:'.length));
  });
  chatWins.set(jid, win);
  if (!AiService.isAiJid(jid)) {
    wa.subscribePresence(jid);
    wa.markRead(jid);
  }
  return win;
}

// ---- Toast notifications (the slide-up above the tray) -------------------

const activeToasts = [];

function showToast({ senderName, text, chatJid }) {
  if (myStatus === 'busy') return;
  const area = screen.getPrimaryDisplay().workArea;
  const W = 236;
  const H = 96;
  const x = area.x + area.width - W - 8;
  const yFinal = area.y + area.height - (H + 6) * (activeToasts.length + 1);

  const toast = new BrowserWindow({
    width: W,
    height: H,
    x,
    y: area.y + area.height - 10,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false },
  });
  toast.loadFile(path.join(RENDERER, 'toast.html'), {
    query: { name: senderName, text: (text || '').slice(0, 90), jid: chatJid },
  });
  toast.setIgnoreMouseEvents(false);
  attachScreenshot(toast, 'toast');
  activeToasts.push(toast);

  // slide up
  let y = area.y + area.height - 10;
  const slide = setInterval(() => {
    if (toast.isDestroyed()) return clearInterval(slide);
    y -= 12;
    if (y <= yFinal) {
      y = yFinal;
      clearInterval(slide);
    }
    toast.setPosition(x, Math.round(y));
  }, 16);

  const dismiss = () => {
    clearInterval(slide);
    const i = activeToasts.indexOf(toast);
    if (i >= 0) activeToasts.splice(i, 1);
    if (!toast.isDestroyed()) toast.close();
  };
  setTimeout(dismiss, 7000);
  toast.on('closed', () => {
    const i = activeToasts.indexOf(toast);
    if (i >= 0) activeToasts.splice(i, 1);
  });
}

// ---- Tray icon --------------------------------------------------------------

let tray = null;

/**
 * Rasterise an SVG asset into a NativeImage. Offscreen windows deliver their
 * pixels via the `paint` event — capturePage() on them returns a blank frame,
 * which is why the tray icon used to render broken. We wait for the <img> to
 * decode, force a repaint, then grab the image handed to us by `paint`.
 */
function renderSvgToImage(svgPath, size) {
  return new Promise((resolve, reject) => {
    const svg = fs.readFileSync(svgPath, 'utf8');
    const b64 = Buffer.from(svg).toString('base64');
    const win = new BrowserWindow({
      show: false,
      width: size,
      height: size,
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true },
    });

    let done = false;
    let ready = false;
    const finish = (img, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      err ? reject(err) : resolve(img);
    };
    const timer = setTimeout(() => finish(null, new Error('tray render timeout')), 4000);

    win.webContents.on('paint', (_e, _dirty, image) => {
      if (ready && !image.isEmpty()) finish(image);
    });
    // The page sets its title once the <img> has finished decoding; only then
    // do we force a repaint and accept the resulting frame.
    win.webContents.on('page-title-updated', (_e, title) => {
      if (title === 'ready') {
        ready = true;
        win.webContents.invalidate();
      }
    });

    win.loadURL(
      `data:text/html,<body style="margin:0;background:transparent">` +
        `<img src="data:image/svg+xml;base64,${b64}" width="${size}" height="${size}" ` +
        `onload="document.title='ready'"></body>`
    );
  });
}

/** Last-resort tray icon: a solid MSN-green square, so we never show nothing. */
function fallbackTrayImage() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0x32; // B
    buf[i * 4 + 1] = 0xc8; // G
    buf[i * 4 + 2] = 0x58; // R
    buf[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

async function setupTray() {
  let image = nativeImage.createFromPath(TRAY_ICON);
  if (image.isEmpty()) {
    try {
      image = await renderSvgToImage(path.join(RENDERER, 'assets', 'buddy-online.svg'), 32);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tray] render failed:', e.message);
    }
  }
  if (!image || image.isEmpty()) image = fallbackTrayImage();

  try {
    // panel icons are 22px on Linux, 16px in the Windows tray and the macOS menu bar
    const traySize = process.platform === 'linux' ? 22 : 16;
    tray = new Tray(image.resize({ width: traySize, height: traySize, quality: 'best' }));
    tray.setToolTip('Ruindows Live Messenger - Online');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir o Ruindows Live Messenger', click: () => (buddyWin || loginWin)?.show() },
        { type: 'separator' },
        ...Object.entries(STATUS_LABEL).map(([status, label]) => ({
          label: `Meu status: ${label === 'Offline' ? 'Aparecer offline' : label}`,
          click: () => setMyStatus(status),
        })),
        { type: 'separator' },
        { label: 'Sair', click: () => app.quit() },
      ])
    );
    tray.on('click', () => (buddyWin || loginWin)?.show());
  } catch (e) {
    // no system tray available (some Linux setups) — not fatal
    if (process.env.MSN_DEBUG) console.log('[tray]', e.message);
  }
}

/** Classic MSN nudge: rattle the window around its origin. */
function shakeWindow(win) {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  let i = 0;
  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer);
    if (i >= 24) {
      clearInterval(timer);
      win.setPosition(x, y);
      return;
    }
    const dx = Math.round(Math.sin(i * 2.1) * 8);
    const dy = Math.round(Math.cos(i * 1.7) * 8);
    win.setPosition(x + dx, y + dy);
    i++;
  }, 25);
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

async function startWhatsApp() {
  if (process.env.MSN_DEMO) {
    const { createDemoService } = require('./demo');
    wa = createDemoService();
  } else {
    wa = new WhatsAppService(path.join(app.getPath('userData'), 'wa-data'));
  }
  applyMediaPolicy();

  wa.on('qr', async (qr) => {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 220 });
    loginWin?.webContents.send('wa:qr', dataUrl);
    if (process.env.MSN_SHOT_DIR && loginWin) {
      setTimeout(async () => {
        try {
          const img = await loginWin.webContents.capturePage();
          fs.writeFileSync(path.join(process.env.MSN_SHOT_DIR, 'login-qr.png'), img.toPNG());
        } catch { /* window gone */ }
      }, 800);
    }
  });

  wa.on('open', (me) => {
    const showBuddyList = () => {
      if (!buddyWin) createBuddyListWindow();
      if (process.env.MSN_DEMO && process.env.MSN_SHOT_DIR) {
        setTimeout(() => openChatWindow(process.env.MSN_SHOT_CHAT || 'david@s.whatsapp.net', { focus: false }), 600);
      }
      if (loginWin) {
        const w = loginWin;
        loginWin = null;
        w.close();
      }
      broadcast('wa:open', me);
      broadcast('wa:roster', wa.getRoster());
    };
    // let the sign-in window play its "Entrando..." animation first, like 8.5 did
    if (loginWin) {
      loginWin.webContents.send('wa:open', me);
      setTimeout(showBuddyList, 2200);
    } else {
      showBuddyList();
    }
  });

  wa.on('closed', ({ loggedOut }) => broadcast('wa:closed', { loggedOut }));

  wa.on('logged-out', () => {
    if (!loginWin) createLoginWindow(); // first, so closing the rest can't quit the app
    for (const [, win] of chatWins) win.close();
    if (buddyWin) {
      const w = buddyWin;
      buddyWin = null;
      w.close();
    }
  });

  wa.on('roster', (roster) => broadcast('wa:roster', roster));
  wa.on('sync', (state) => broadcast('wa:sync', state));
  wa.on('presence', (p) => broadcast('wa:presence', p));

  wa.on('reaction', (r) => broadcast('wa:reaction', r));
  wa.on('stickers', () => broadcast('wa:stickers'));
  wa.on('message-updated', (m) => broadcast('wa:messageUpdated', m));
  wa.on('message', (msg) => deliverMessage(msg));

  wa.on('error', (e) => console.error('[whatsapp]', e));

  await wa.start();
}

/** A new message (WhatsApp or an AI): tell every window, pop the chat, toast. */
function deliverMessage(msg) {
  // the chat window, when open, plays the sound; the buddy list only when it isn't
  const open = chatWins.get(msg.chatJid);
  broadcast('wa:message', { ...msg, windowOpen: !!open && !open.isDestroyed() });
  // optional: archived groups update quietly (no window, no toast)
  const quiet = settings.quietArchivedGroups && msg.chatJid?.endsWith('@g.us') && wa.chats?.get(msg.chatJid)?.archived;
  if (!msg.fromMe && !quiet) {
    const existing = chatWins.get(msg.chatJid);
    const wasFocused = !!existing && !existing.isDestroyed() && existing.isFocused();
    const win = openChatWindow(msg.chatJid, { focus: false });
    if (msg.isNudge) shakeWindow(win);
    else if (!wasFocused && myStatus !== 'busy') {
      win.flashFrame(true);
      showToast(msg);
    }
  }
}

// ---- IPC ---------------------------------------------------------------

// Original-asset overrides: files the user imported from their own copy
// of MSN Messenger (see scripts/import-original-assets.js). Gitignored;
// nothing is bundled. Renderers swap art/sounds when a file is present.
const ORIGINAL_DIR = path.join(RENDERER, 'assets', 'original');
ipcMain.handle('assets:original', () => {
  try {
    return fs.readdirSync(ORIGINAL_DIR).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
});

ipcMain.handle('wa:getRoster', () => wa.getRoster());
ipcMain.handle('wa:media', async (_e, id) => {
  const file = await wa.getMedia?.(id);
  return file ? require('url').pathToFileURL(file).href : null;
});
ipcMain.handle('ui:getStatus', () => myStatus);
ipcMain.handle('wa:stickers', () => wa.getStickers?.() || { favorites: [], recent: [] });
ipcMain.handle('wa:stickerFile', async (_e, ref) => {
  const file = await wa.getStickerFile?.(ref);
  return file ? require('url').pathToFileURL(file).href : null;
});
ipcMain.handle('wa:sendSticker', (_e, { jid, ref }) => wa.sendSticker(jid, ref));

// installed font families for the "Alterar fonte" dialog (fontconfig)
let fontCache = null;
ipcMain.handle('ui:systemFonts', () => {
  if (fontCache) return fontCache;
  try {
    const { execFileSync } = require('child_process');
    let out;
    if (process.platform === 'win32') {
      out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
        'Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'],
      { encoding: 'utf8', windowsHide: true });
    } else if (process.platform === 'darwin') {
      // font family names from the system font catalogue
      const json = JSON.parse(execFileSync('system_profiler', ['SPFontsDataType', '-json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
      out = (json.SPFontsDataType || []).flatMap((f) => (f.typefaces || []).map((t) => t.family)).join('\n');
    } else {
      out = execFileSync('fc-list', [':', 'family'], { encoding: 'utf8' });
    }
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const first = line.split(',')[0].trim();
      if (first && !first.startsWith('.')) names.add(first);
    }
    fontCache = [...names].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  } catch {
    fontCache = ['Segoe UI', 'Arial', 'Comic Sans MS', 'Courier New', 'Georgia', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
  }
  return fontCache;
});
// app options (only the ones the renderer may flip)
// ---- theme: 'light' | 'dark' | 'system' (follows the OS) ---------------------------
const { nativeTheme } = require('electron');
function themeChoice() {
  return ['light', 'dark', 'system'].includes(settings.theme) ? settings.theme : 'light';
}
function currentTheme() {
  const choice = themeChoice();
  if (choice === 'system') return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  return choice;
}
ipcMain.on('ui:themeGet', (e) => { e.returnValue = currentTheme(); });
ipcMain.handle('ui:themeChoice', () => themeChoice());
ipcMain.on('ui:setTheme', (_e, choice) => {
  if (!['light', 'dark', 'system'].includes(choice)) return;
  settings.theme = choice;
  saveSettings();
  nativeTheme.themeSource = choice;
  broadcast('ui:theme', currentTheme());
});
app.whenReady().then(() => {
  nativeTheme.themeSource = themeChoice();
  nativeTheme.on('updated', () => broadcast('ui:theme', currentTheme()));
});

const OPTION_KEYS = ['quietArchivedGroups'];
ipcMain.handle('ui:getOption', (_e, key) => (OPTION_KEYS.includes(key) ? !!settings[key] : null));
ipcMain.on('ui:setOption', (_e, { key, value }) => {
  if (!OPTION_KEYS.includes(key)) return;
  settings[key] = !!value;
  saveSettings();
});
ipcMain.on('ui:profileGet', (e) => { e.returnValue = settings.profile || null; });
ipcMain.on('ui:profileSet', (e, profile) => {
  settings.profile = profile;
  saveSettings();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && win.webContents !== e.sender) win.webContents.send('ui:profile', profile);
  }
});
ipcMain.handle('wa:getSync', () => wa.getSync?.() || null);
ipcMain.handle('wa:groupMembers', (_e, jid) => (AiService.isAiJid(jid) ? ai.groupMembers(jid) : wa.getGroupMembers?.(jid) || []));

// ---- AI chat sites ---------------------------------------------------------------
// every AI has its own section in the list, like Grupos and Offline; one can
// be hidden by right-clicking it
const AI_ORDER = ['chatgpt', 'deepseek', 'gemini', 'claude'];
const aiShown = () => AI_ORDER.filter((id) => !(settings.aiHidden || []).includes(id));
const ai = new AiService({ getEnabled: aiShown, groupsFile: path.join(USER_DATA, 'ai-groups.json') });
ai.ensureDefaultGroup(AI_ORDER);
ai.on('message', (msg) => deliverMessage(msg));
ai.on('presence', (p) => broadcast('wa:presence', p));
ai.on('roster', (r) => broadcast('ai:roster', r));
ai.on('groups', (g) => broadcast('ai:groups', g));
ipcMain.handle('ai:groups', () => ai.getGroups());
ipcMain.handle('ai:groupCreate', (_e, opts) => ai.createGroup(opts || {}));
ipcMain.handle('ai:groupUpdate', (_e, { jid, patch }) => ai.updateGroup(jid, patch || {}));
ipcMain.handle('ai:groupDelete', (_e, jid) => ai.deleteGroup(jid));
ipcMain.handle('ai:groupContinue', (_e, jid) => ai.continueGroup(jid));
ipcMain.handle('ai:providers', () => AiService.providers());
ipcMain.handle('ai:roster', () => ai.getRoster());
ipcMain.handle('ai:setEnabled', (_e, ids) => {
  const known = new Set(AiService.providers().map((p) => p.id));
  const before = aiShown();
  const added = ids.filter((id) => known.has(id) && !before.includes(id));
  settings.aiHidden = AI_ORDER.filter((id) => !ids.includes(id));
  saveSettings();
  broadcast('ai:roster', ai.getRoster());
  for (const id of added) ai.login(id); // first time: show the site to log in
  return ai.getRoster();
});
ipcMain.handle('ai:login', (_e, id) => ai.login(id));
ipcMain.handle('ai:refresh', () => ai.refresh());
ipcMain.handle('ai:importFirefox', () => ai.importFirefox().then((r) => r, (e) => ({ error: e?.message || String(e) })));
ipcMain.on('ui:setStatus', (_e, status) => setMyStatus(status));
// sync, so a chat window popped open by a message knows before it plays a sound
ipcMain.on('ui:statusSync', (e) => { e.returnValue = myStatus; });
ipcMain.handle('wa:getMessages', async (_e, jid) => {
  if (AiService.isAiJid(jid)) {
    return { jid, name: ai.displayName(jid), me: wa.me, messages: await ai.getMessages(jid), presence: 'available', isAi: true };
  }
  await wa.ensureGroupMeta?.(jid);
  wa.refetchRecent?.(jid);
  return getMessagesPayload(jid);
});
const getMessagesPayload = (jid) => ({
  jid,
  name: wa.displayName(jid),
  me: wa.me,
  messages: wa.getMessages(jid),
  lastIncoming: wa.getRoster().chats.find((c) => c.jid === jid)?.lastIncoming || null,
  presence: wa.presence.get(jid) || 'unavailable',
  ...(wa.busyInfo?.(jid) || {}),
});
ipcMain.handle('wa:send', (_e, { jid, text, quotedId }) =>
  AiService.isAiJid(jid) ? ai.send(jid, text) : wa.sendText(jid, text, quotedId));
ipcMain.handle('wa:nudge', async (_e, jid) => {
  if (AiService.isAiJid(jid)) throw new Error('não disponível para IAs');
  const win = chatWins.get(jid);
  shakeWindow(win);
  return wa.sendNudge(jid);
});
ipcMain.handle('wa:typing', (_e, { jid, composing }) => (AiService.isAiJid(jid) ? null : wa.setTyping(jid, composing)));
ipcMain.handle('wa:setPresence', (_e, state) => wa.setMyPresence(state));
// my own WhatsApp picture is also kept on disk so the sign-in screen can show
// it before WhatsApp connects
const MY_DP_FILE = path.join(USER_DATA, 'my-display-picture.jpg');
ipcMain.handle('wa:avatar', async (_e, jid) => {
  if (AiService.isAiJid(jid)) return null;
  const url = await wa.getAvatar(jid);
  if (url && jid && jid === wa.me?.jid) {
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((buf) => buf && fs.writeFileSync(MY_DP_FILE, Buffer.from(buf)))
      .catch(() => {});
  }
  return url;
});
ipcMain.handle('ui:cachedMyDp', () => {
  // a custom picture set in Messenger wins over the WhatsApp one
  if (settings.profile?.dp) return settings.profile.dp;
  return fs.existsSync(MY_DP_FILE) ? require('url').pathToFileURL(MY_DP_FILE).href + '?t=' + fs.statSync(MY_DP_FILE).mtimeMs : null;
});
ipcMain.handle('wa:markRead', (_e, jid) => (AiService.isAiJid(jid) ? null : wa.markRead(jid)));
ipcMain.handle('wa:signOut', () => wa.signOut());

ipcMain.handle('wa:sendImage', (_e, { jid, dataUrl }) => {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  return wa.sendImage(jid, Buffer.from(b64, 'base64'));
});

ipcMain.handle('wa:sendFile', async (e, jid) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Send a File',
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return wa.sendFile(jid, filePaths[0]);
});

ipcMain.on('ui:openChat', (_e, jid) => openChatWindow(jid));
ipcMain.on('ui:toastClick', (e, jid) => {
  if (jid) openChatWindow(jid);
  BrowserWindow.fromWebContents(e.sender)?.close();
});
ipcMain.on('ui:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('ui:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('ui:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('ui:openExternal', (_e, url) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url);
  // downloaded chat photos/videos open in the system viewer
  if (/^file:\/\//.test(url) && wa?.mediaDir) {
    const file = require('url').fileURLToPath(url);
    if (file.startsWith(path.resolve(wa.mediaDir) + path.sep)) shell.openPath(file);
  }
});

// ---- downloaded media: where it lives and when it goes -------------------------
let mediaTrimTimer = null;
function applyMediaPolicy() {
  if (!wa || process.env.MSN_DEMO) return;
  const opts = storage.mediaOptions(settings);
  wa.mediaDir = storage.prepareMedia(opts, path.join(USER_DATA, 'wa-data', 'media'));
  clearInterval(mediaTrimTimer);
  if (opts.mode === 'persist') mediaTrimTimer = setInterval(() => storage.trim(wa.mediaDir, storage.mediaOptions(settings)), 3600e3);
}
ipcMain.handle('ui:getMediaOptions', () => {
  const opts = storage.mediaOptions(settings);
  return { ...opts, dir: storage.mediaDir(opts), usage: storage.usage(storage.mediaDir(opts)) };
});
ipcMain.handle('ui:setMediaOptions', (_e, next) => {
  const prev = storage.mediaOptions(settings);
  const clean = {
    mode: next.mode === 'temp' ? 'temp' : 'persist',
    keepValue: Math.max(1, Math.min(999, Number(next.keepValue) || prev.keepValue)),
    keepUnit: next.keepUnit === 'hours' ? 'hours' : 'days',
    maxMB: Math.max(50, Math.min(100000, Number(next.maxMB) || prev.maxMB)),
    autoDownload: !!next.autoDownload,
  };
  settings.media = clean;
  saveSettings();
  if (clean.mode !== prev.mode) applyMediaPolicy();
  else if (clean.mode === 'persist' && wa?.mediaDir) storage.trim(wa.mediaDir, clean);
  broadcast('ui:mediaOptions', clean);
  return clean;
});
ipcMain.handle('ui:clearMedia', () => {
  if (!wa?.mediaDir) return null;
  storage.wipe(wa.mediaDir);
  fs.mkdirSync(wa.mediaDir, { recursive: true });
  return storage.usage(wa.mediaDir);
});
ipcMain.handle('wa:mediaCached', (_e, id) => {
  const file = wa?.cachedMedia?.(id);
  return file ? require('url').pathToFileURL(file).href : null;
});

// ---- App lifecycle ------------------------------------------------------

app.whenReady().then(async () => {
  if (process.platform === 'darwin') { try { app.dock.setIcon(APP_ICON); } catch {} }
  createLoginWindow();
  setupTray();
  // AI sites load in the background; their list fills in when ready
  if (aiShown().length) setTimeout(() => ai.refresh(), 3000);
  await startWhatsApp();
});

app.on('window-all-closed', () => app.quit());
// macOS: clicking the dock icon brings the buddy list back
app.on('activate', () => {
  const win = buddyWin && !buddyWin.isDestroyed() ? buddyWin : loginWin;
  if (win && !win.isDestroyed()) win.show();
});
app.on('before-quit', () => {
  ai.stop();
  wa?.stop();
  // temporary media goes away with the app
  if (!process.env.MSN_DEMO && storage.mediaOptions(settings).mode === 'temp' && wa?.mediaDir) storage.wipe(wa.mediaDir);
});
