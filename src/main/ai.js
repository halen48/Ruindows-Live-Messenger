'use strict';

const fs = require('fs');
const { ClaudeCode } = require('./claude-code');

/**
 * AI chat sites (ChatGPT, Claude, Gemini, DeepSeek) as Messenger contacts.
 *
 * Each provider runs its real website in a hidden window with its own
 * persistent session, so I log in once with my own account. History is read
 * through the site's own JSON endpoints where it has them (ChatGPT, Claude,
 * DeepSeek) or from the page (Gemini). Sending drives the page like a person
 * would: type into the box, press send, wait for the answer to finish.
 *
 * Conversations are addressed as "ai:<provider>:<conversation id>"; a fresh
 * chat window uses "ai:<provider>:new-<n>" until the site assigns an id.
 * Everything here depends on the sites' current layout and private APIs, so
 * expect to adjust selectors when a site changes.
 */
const { BrowserWindow, session } = require('electron');
const { importFirefoxLogin, firefoxHasGoogle, openFirefox } = require('./firefox-login');
const { EventEmitter } = require('events');

// all AI sites share one browser session, so signing in to Google (or any
// account) once counts for every site that offers it
const AI_PARTITION = 'persist:ai';

// a plain Chrome identity (no "Electron"), with the version this build really
// runs: bot checks compare it with the browser's own client hints
const CHROME_PLATFORM = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
const CHROME_UA = `Mozilla/5.0 (${CHROME_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${(process.versions.chrome || '130').split('.')[0]}.0.0.0 Safari/537.36`;

// Google refuses to sign in inside embedded browsers ("Esse navegador ou app
// pode não ser seguro") but lets Firefox through. Its login requests go out
// with a Firefox user agent; the page itself keeps the Chrome one, because
// a Firefox navigator.userAgent next to Chrome's features makes it reload
// forever.
const FIREFOX_UA = `Mozilla/5.0 (${process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : 'X11; Linux x86_64'}; rv:140.0) Gecko/20100101 Firefox/140.0`;

// Google's sign-in refuses embedded browsers unless the WHOLE identity says
// Firefox: the header alone isn't enough, the page's navigator.userAgent has
// to agree, or Google spots the contradiction ("navegador pode não ser
// seguro"). So the window switches to Firefox while it's on Google's sign-in
// pages and back to Chrome everywhere else (Firefox on gemini.google.com
// itself made the app reload in a loop).
const GOOGLE_SIGNIN = /^https:\/\/(accounts\.google\.[a-z.]+|accounts\.youtube\.com)\//i;
const agentFor = (url) => (GOOGLE_SIGNIN.test(url || '') ? FIREFOX_UA : CHROME_UA);

/** One window, and the popups it opens (like "Continuar com o Google"), in the same session. */
function useLoginFriendlyAgent(contents) {
  contents.setUserAgent(CHROME_UA);
  contents.on('did-start-navigation', (e, url, _inPlace, isMainFrame) => {
    if ((e?.isMainFrame ?? isMainFrame) === false) return;
    const ua = agentFor(e?.url || url);
    if (contents.getUserAgent() !== ua) contents.setUserAgent(ua);
  });
  // "Entrar com Google" goes site -> its OAuth URL -> redirect to Google.
  // Changing the agent mid-redirect crashes Electron, so the redirect is
  // dropped and Google's URL is loaded fresh, already as Firefox.
  contents.on('will-redirect', (e, url, _inPlace, isMainFrame) => {
    const target = e?.url || url;
    if ((e?.isMainFrame ?? isMainFrame) === false) return;
    if (agentFor(target) === contents.getUserAgent()) return;
    e.preventDefault();
    setImmediate(() => { if (!contents.isDestroyed()) contents.loadURL(target, { userAgent: agentFor(target) }).catch(() => {}); });
  });
  contents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, width: 520, height: 680 } }));
  contents.on('did-create-window', (child, { url } = {}) => {
    useLoginFriendlyAgent(child.webContents);
    // a popup that opens straight on Google's sign-in starts as Firefox
    if (url) child.webContents.setUserAgent(agentFor(url));
  });
}

const hookedSessions = new WeakSet();
/**
 * Firefox headers on everything a Google sign-in page loads, not only on
 * accounts.google.com: the page also hits gstatic, play.google.com etc., and
 * a single request still saying Chrome is enough for Google to refuse.
 */
function hookSession(ses) {
  if (hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    let page = '';
    try { page = details.webContents?.getURL() || ''; } catch {}
    if (GOOGLE_SIGNIN.test(details.url) || GOOGLE_SIGNIN.test(page)) {
      details.requestHeaders['User-Agent'] = FIREFOX_UA;
      // Chrome-only hints would give the Firefox identity away
      for (const h of Object.keys(details.requestHeaders)) if (/^sec-ch-ua/i.test(h)) delete details.requestHeaders[h];
    }
    cb({ requestHeaders: details.requestHeaders });
  });
}
// ---- page-side helpers (run inside the provider's page) ---------------------

// Types text into a textarea or a contenteditable editor the way a user would.
const TYPE_AND_SEND = `async (selInput, selSend, text) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let box = null;
  for (let i = 0; i < 60 && !box; i++) { box = document.querySelector(selInput); if (!box) await sleep(250); }
  if (!box) throw new Error('caixa de texto não encontrada');
  box.focus();
  if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), 'value').set;
    setter.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  }
  await sleep(400);
  let btn = null;
  for (let i = 0; i < 20; i++) {
    btn = selSend && document.querySelector(selSend);
    if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') break;
    btn = null;
    await sleep(200);
  }
  if (btn) btn.click();
  else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return true;
}`;

// Waits until the "stop generating" control appears and goes away again, or
// until the page text stops changing for a few seconds.
const WAIT_DONE = `async (selBusy, maxMs) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();
  let sawBusy = false, last = '', stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    const busy = selBusy ? !!document.querySelector(selBusy) : false;
    if (busy) sawBusy = true;
    const now = document.body.innerText.length + ':' + document.body.innerText.slice(-200);
    if (now !== last) { last = now; stableSince = Date.now(); }
    if (sawBusy && !busy && Date.now() - stableSince > 1200) return true;
    if (!sawBusy && Date.now() - start > 8000 && Date.now() - stableSince > 4000) return true;
    await sleep(400);
  }
  return false;
}`;

// Open the model picker and choose the option matching `rx`. Returns a short
// status string; never throws so a missing picker just means the default model.
const SELECT_MODEL = `async (btnSel, optSel, rx) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const re = new RegExp(rx, 'i');
  const btn = document.querySelector(btnSel);
  if (!btn) return 'no-picker';
  // already on it? the button shows the current model
  if (re.test(btn.getAttribute('aria-label') || btn.innerText || '')) return 'already';
  btn.click();
  for (let i = 0; i < 25 && !document.querySelector(optSel); i++) await sleep(150);
  const opt = [...document.querySelectorAll(optSel)].find((o) => re.test(o.innerText));
  if (opt) { opt.click(); await sleep(500); return 'selected'; }
  btn.click(); // close the menu we opened
  return 'not-found';
}`;

// ---- providers ----------------------------------------------------------------

const PROVIDERS = {
  chatgpt: {
    name: 'ChatGPT',
    home: 'https://chatgpt.com/',
    loginUrl: 'https://chatgpt.com/auth/login',
    convUrl: (id) => `https://chatgpt.com/c/${id}`,
    // the old textarea id, or the ProseMirror editor that replaced it
    input: '#prompt-textarea, div.ProseMirror[contenteditable="true"]',
    send: 'button[data-testid="send-button"]',
    busy: 'button[data-testid="stop-button"]',
    idFromUrl: (url) => url.match(/\/c\/([\w-]+)/)?.[1] || null,
    loggedIn: `fetch('/api/auth/session').then((r) => r.json()).then((j) => !!j.accessToken).catch(() => false)`,
    list: `(async () => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch('/backend-api/conversations?offset=0&limit=40&order=updated', { headers: { Authorization: 'Bearer ' + s.accessToken } });
      const j = await r.json();
      return (j.items || []).map((c) => ({ id: c.id, title: c.title, updated: Date.parse(c.update_time) || c.update_time * 1000 || 0 }));
    })()`,
    messages: (id) => `(async () => {
      const s = await (await fetch('/api/auth/session')).json();
      const j = await (await fetch('/backend-api/conversation/${id}', { headers: { Authorization: 'Bearer ' + s.accessToken } })).json();
      const out = [];
      let node = j.current_node;
      while (node && j.mapping[node]) {
        const m = j.mapping[node].message;
        if (m && (m.author?.role === 'user' || m.author?.role === 'assistant') && m.content) {
          const parts = (m.content.parts || []).filter((p) => typeof p === 'string');
          const text = parts.join('\\n').trim() || (m.content.text || '').trim();
          if (text && !(m.metadata?.is_visually_hidden_from_conversation)) {
            out.push({ id: m.id, role: m.author.role === 'user' ? 'user' : 'ai', text, ts: (m.create_time || 0) * 1000 });
          }
        }
        node = j.mapping[node].parent;
      }
      return { title: j.title, messages: out.reverse() };
    })()`,
  },

  claude: {
    name: 'Claude',
    home: 'https://claude.ai/new',
    loginUrl: 'https://claude.ai/login',
    convUrl: (id) => `https://claude.ai/chat/${id}`,
    input: 'div[contenteditable="true"]',
    send: 'button[aria-label="Send message"], button[aria-label="Enviar mensagem"]',
    busy: 'button[aria-label="Stop response"], button[aria-label="Parar resposta"]',
    idFromUrl: (url) => url.match(/\/chat\/([\w-]+)/)?.[1] || null,
    loggedIn: `fetch('/api/organizations').then((r) => r.ok ? r.json() : []).then((j) => Array.isArray(j) && j.length > 0).catch(() => false)`,
    org: `(async () => {
      const orgs = await (await fetch('/api/organizations')).json();
      const chat = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0];
      return chat.uuid;
    })()`,
    list: `(async () => {
      const orgs = await (await fetch('/api/organizations')).json();
      const org = (orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0]).uuid;
      const j = await (await fetch('/api/organizations/' + org + '/chat_conversations?limit=40')).json();
      return (j || []).map((c) => ({ id: c.uuid, title: c.name || 'Sem título', updated: Date.parse(c.updated_at) || 0 }));
    })()`,
    messages: (id) => `(async () => {
      const orgs = await (await fetch('/api/organizations')).json();
      const org = (orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0]).uuid;
      const j = await (await fetch('/api/organizations/' + org + '/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true')).json();
      const text = (m) => m.text || (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\\n');
      return {
        title: j.name,
        messages: (j.chat_messages || []).map((m) => ({ id: m.uuid, role: m.sender === 'human' ? 'user' : 'ai', text: text(m).trim(), ts: Date.parse(m.created_at) || 0 })).filter((m) => m.text),
      };
    })()`,
  },

  deepseek: {
    name: 'DeepSeek',
    home: 'https://chat.deepseek.com/',
    loginUrl: 'https://chat.deepseek.com/sign_in',
    convUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
    input: 'textarea',
    send: null, // Enter sends
    busy: null,
    idFromUrl: (url) => url.match(/\/s\/([\w-]+)/)?.[1] || null,
    // an expired token stays saved: the site sending me to sign_in is what counts
    loggedIn: `(() => { try { return !location.pathname.startsWith('/sign_in') && !!JSON.parse(localStorage.getItem('userToken')).value; } catch { return false; } })()`,
    list: `(async () => {
      const t = JSON.parse(localStorage.getItem('userToken')).value;
      const j = await (await fetch('/api/v0/chat_session/fetch_page?count=40', { headers: { Authorization: 'Bearer ' + t } })).json();
      return (j.data?.biz_data?.chat_sessions || []).map((c) => ({ id: c.id, title: c.title || 'Sem título', updated: (c.updated_at || 0) * 1000 }));
    })()`,
    messages: (id) => `(async () => {
      const t = JSON.parse(localStorage.getItem('userToken')).value;
      const j = await (await fetch('/api/v0/chat/history_messages?chat_session_id=${id}', { headers: { Authorization: 'Bearer ' + t } })).json();
      const d = j.data?.biz_data || {};
      const text = (m) => m.content || (m.fragments || []).filter((f) => f.type !== 'THINK').map((f) => f.content).join('\\n');
      return {
        title: d.chat_session?.title,
        messages: (d.chat_messages || []).map((m) => ({ id: String(m.message_id), role: m.role === 'USER' ? 'user' : 'ai', text: (text(m) || '').trim(), ts: (m.inserted_at || 0) * 1000 })).filter((m) => m.text),
      };
    })()`,
  },

  gemini: {
    name: 'Gemini',
    home: 'https://gemini.google.com/app',
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp&hl=pt-BR',
    convUrl: (id) => `https://gemini.google.com/app/${id}`,
    input: 'rich-textarea .ql-editor, div[contenteditable="true"]',
    send: 'button.send-button, button[aria-label*="Send"], button[aria-label*="Enviar"]',
    busy: 'button[aria-label*="Stop"], button[aria-label*="Parar"]',
    idFromUrl: (url) => url.match(/\/app\/([\w-]+)/)?.[1] || null,
    loggedIn: `!!document.querySelector('a[href*="SignOutOptions"], img[src*="googleusercontent.com/a/"]') || !document.querySelector('a[href*="ServiceLogin"], a[href*="accounts.google.com/v3/signin"]')`,
    // each "nova conversa" starts on a chosen model, shown as the subnick
    modelPicker: { btn: 'button[data-test-id="bard-mode-menu-button"]', opt: '[data-test-id^="bard-mode-option"]' },
    models: [
      { id: 'flash', label: 'Flash', match: 'flash(?!\\s*lite)' },
      { id: 'pro', label: 'Pro', match: '\\bpro\\b' },
      { id: 'argon', label: 'Argon', match: 'argon' },
    ],
    // no JSON API: read the sidebar
    list: `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // the sidebar fills in late (~10 s on a cold start)
      for (let i = 0; i < 50 && !document.querySelector('a[href^="/app/"]'); i++) await sleep(300);
      const seen = new Set();
      return [...document.querySelectorAll('a[href^="/app/"]')].map((a) => {
        const id = a.getAttribute('href').split('/')[2];
        if (!id || seen.has(id)) return null;
        seen.add(id);
        return { id, title: a.innerText.trim() || 'Sem título', updated: 0 };
      }).filter(Boolean).slice(0, 40);
    })()`,
    messages: () => `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 30 && !document.querySelector('user-query, model-response'); i++) await sleep(300);
      const out = [];
      document.querySelectorAll('user-query, model-response').forEach((el, i) => {
        const user = el.tagName === 'USER-QUERY';
        const t = (user ? el.querySelector('.query-text') : el.querySelector('.markdown, message-content'))?.innerText || el.innerText;
        if (t && t.trim()) out.push({ id: 'g' + i, role: user ? 'user' : 'ai', text: t.trim(), ts: 0 });
      });
      return { title: document.title.replace(/\\s*[-|]\\s*Gemini.*$/, ''), messages: out };
    })()`,
    pageMessages: true, // messages are read from the open page
  },
};

class AiService extends EventEmitter {
  constructor({ getEnabled, groupsFile }) {
    super();
    this.getEnabled = getEnabled; // () => ['chatgpt', ...]
    this.groupsFile = groupsFile;
    this.groups = this._loadGroups(); // AI group chats, see "Groups" below
    this.code = new ClaudeCode(); // Claude Code sessions, listed under Claude
    this.codeSessions = [];
    this.wins = new Map(); // provider -> hidden BrowserWindow
    this.state = new Map(); // provider -> { loggedIn, conversations: [] }
    this.queues = new Map(); // provider -> Promise chain (one action at a time)
    this.aliases = new Map(); // "ai:p:new-1" -> real conversation id
    this.cache = new Map(); // jid -> messages
    this.convModels = new Map(); // ai:p:realid -> model label (subnick)
  }

  static providers() {
    return Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name }));
  }

  static isAiJid(jid) {
    return typeof jid === 'string' && jid.startsWith('ai:');
  }

  static isGroupJid(jid) {
    return typeof jid === 'string' && jid.startsWith('ai:group:');
  }

  static isCodeJid(jid) {
    return typeof jid === 'string' && jid.startsWith('ai:cc:');
  }

  /** Re-read the list of Claude Code sessions (cheap: titles are cached by file time). */
  refreshCode() {
    if (!this.getEnabled().includes('claude') || !this.code.available()) {
      this.codeSessions = [];
      return;
    }
    try {
      this.codeSessions = this.code.listSessions().map((x) => ({ jid: `ai:cc:${x.id}`, title: x.title, mtime: x.mtime }));
    } catch {
      this.codeSessions = [];
    }
  }

  _parse(jid) {
    const [, provider, conv] = jid.split(':');
    const real = this.aliases.get(jid) || (conv?.startsWith('new-') ? null : conv);
    return { provider, conv: real, p: PROVIDERS[provider] };
  }

  /** The model picked for a "new conversation" jid (ai:p:new-<ts>-m-<model>). */
  _newModel(jid) {
    const conv = jid.split(':')[2] || '';
    const m = conv.match(/-m-([a-z0-9]+)$/);
    const provider = jid.split(':')[1];
    return (PROVIDERS[provider]?.models || []).find((x) => x.id === m?.[1]) || null;
  }

  _win(provider) {
    let win = this.wins.get(provider);
    if (win && !win.isDestroyed()) return win;
    const p = PROVIDERS[provider];
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 800,
      title: `Entrar no ${p.name}`,
      autoHideMenuBar: true,
      webPreferences: { partition: AI_PARTITION, backgroundThrottling: false },
    });
    hookSession(win.webContents.session);
    useLoginFriendlyAgent(win.webContents);
    // closing the login window only hides it; the session stays loaded
    win.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      win.hide();
      this.refresh(provider);
    });
    win.loadURL(p.home);
    this.wins.set(provider, win);
    return win;
  }

  _enqueue(provider, job) {
    clearTimeout(this.idleTimers?.get(provider));
    const prev = this.queues.get(provider) || Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    this.queues.set(provider, next);
    next.catch(() => {}).then(() => { if (this.queues.get(provider) === next) this._unloadWhenIdle(provider); });
    return next;
  }

  /**
   * These sites keep animating and polling even in a hidden window, which
   * costs a lot of CPU (and drags the whole desktop, mouse included). Once a
   * provider has had nothing to do for a bit, its page is swapped for a blank
   * one; the session cookies stay, and the next action loads the site again.
   */
  _unloadWhenIdle(provider) {
    if (!this.idleTimers) this.idleTimers = new Map();
    clearTimeout(this.idleTimers.get(provider));
    this.idleTimers.set(provider, setTimeout(() => {
      const win = this.wins.get(provider);
      if (!win || win.isDestroyed() || win.isVisible()) return; // login window open: leave it
      win.loadURL('about:blank').catch(() => {});
    }, 15000));
  }

  async _loaded(win) {
    if (!win.webContents.isLoading()) return;
    await new Promise((r) => win.webContents.once('did-stop-loading', r));
  }

  async _go(win, url) {
    if (win.webContents.getURL() === url) return;
    await win.loadURL(url).catch(() => {});
    await this._loaded(win);
    await new Promise((r) => setTimeout(r, 1200)); // let the app hydrate
  }

  _eval(win, code) {
    return win.webContents.executeJavaScript(code, true);
  }

  /** Show the provider's site so I can log in with my account. */
  login(provider) {
    if (!PROVIDERS[provider]) return;
    const win = this._win(provider);
    clearTimeout(this.idleTimers?.get(provider));
    // logged out: straight to the sign-in page (some home pages go blank
    // without a session); logged in: back to the site if it was blanked
    const p = PROVIDERS[provider];
    if (!this.state.get(provider)?.loggedIn && p.loginUrl) {
      // stop the home page still loading, and start Google's sign-in already
      // as Firefox instead of switching mid-way (that races, and loses)
      win.webContents.stop();
      win.webContents.setUserAgent(agentFor(p.loginUrl));
      win.loadURL(p.loginUrl, { userAgent: agentFor(p.loginUrl) }).catch(() => {});
    }
    else if (!win.webContents.getURL().startsWith(new URL(p.home).origin)) win.loadURL(p.home).catch(() => {});
    win.show();
    win.focus();
  }

  /**
   * Bring in the logins I already have in Firefox (Google included, which
   * can't be done inside the app), then check every site again.
   */
  async importFirefox() {
    const result = await importFirefoxLogin(session.fromPartition(AI_PARTITION));
    // pages already open still have the old, logged-out state
    for (const win of this.wins.values()) if (!win.isDestroyed() && !win.isVisible()) win.loadURL('about:blank').catch(() => {});
    await this.refresh();
    return { ...result, loggedIn: this.getRoster().filter((p) => p.loggedIn).map((p) => p.name) };
  }

  /**
   * Firefox isn't logged in to Google: open Google's sign-in in Firefox (where
   * Google allows it), watch Firefox's cookies, and as soon as the login shows
   * up, bring it in. Emits 'firefoxLogin' with the import result (or an error).
   */
  async loginGoogleInFirefox() {
    if (this.ffWatch) return { watching: true };
    const url = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp';
    if (!(await openFirefox(url))) throw new Error('não consegui abrir o Firefox');
    const started = Date.now();
    this.ffWatch = setInterval(async () => {
      if (this.ffBusy) return;
      this.ffBusy = true;
      try {
        if (await firefoxHasGoogle()) {
          this.stopFirefoxWatch();
          this.emit('firefoxLogin', await this.importFirefox().catch((e) => ({ error: e?.message || String(e) })));
        } else if (Date.now() - started > 10 * 60 * 1000) {
          this.stopFirefoxWatch();
          this.emit('firefoxLogin', { error: 'passaram 10 minutos e o Firefox não entrou no Google' });
        }
      } finally {
        this.ffBusy = false;
      }
    }, 3000);
    return { watching: true };
  }

  stopFirefoxWatch() {
    clearInterval(this.ffWatch);
    this.ffWatch = null;
  }

  /** Re-check login and reload the conversation list for one or all providers. */
  async refresh(provider) {
    this.refreshCode();
    this.emit('roster', this.getRoster());
    const ids = provider ? [provider] : this.getEnabled();
    await Promise.all(ids.map((id) => this._enqueue(id, async () => {
      const p = PROVIDERS[id];
      if (!p) return;
      const win = this._win(id);
      // I'm logging in in this window: don't pull it back to the home page
      if (win.isVisible()) return;
      await this._loaded(win);
      if (!win.webContents.getURL().startsWith(new URL(p.home).origin)) await this._go(win, p.home);
      let loggedIn = false;
      let conversations = [];
      try {
        loggedIn = !!(await this._eval(win, p.loggedIn));
        // Google drops the copied session once Firefox rotates its cookies:
        // copy them again (at most every 30 min) and look once more
        if (!loggedIn && id === 'gemini' && Date.now() - (this.lastAutoImport || 0) > 30 * 60 * 1000 && (await firefoxHasGoogle().catch(() => false))) {
          this.lastAutoImport = Date.now();
          await importFirefoxLogin(session.fromPartition(AI_PARTITION)).catch(() => null);
          // same address: _go would skip it, and the page must reload with the new cookies
          await win.loadURL(p.home).catch(() => {});
          await this._loaded(win);
          await new Promise((r) => setTimeout(r, 2500));
          loggedIn = !!(await this._eval(win, p.loggedIn));
        }
        if (loggedIn) {
          if (id === 'gemini') await this._go(win, p.home);
          conversations = ((await this._eval(win, p.list)) || []).map((c) => ({
            jid: `ai:${id}:${c.id}`,
            title: c.title || 'Sem título',
            updated: c.updated || 0,
            model: this.convModels.get(`ai:${id}:${c.id}`) || null,
          }));
        }
      } catch (e) {
        if (process.env.MSN_DEBUG) console.log(`[ai] ${id} refresh failed:`, e?.message);
      }
      this.state.set(id, { loggedIn, conversations });
      this.emit('roster', this.getRoster());
    })));
  }

  getRoster() {
    return this.getEnabled().filter((id) => PROVIDERS[id]).map((id) => ({
      id,
      name: PROVIDERS[id].name,
      loggedIn: !!this.state.get(id)?.loggedIn,
      checked: this.state.has(id),
      conversations: this.state.get(id)?.conversations || [],
      models: PROVIDERS[id].models ? PROVIDERS[id].models.map((m) => ({ id: m.id, label: m.label })) : undefined,
      codeSessions: id === 'claude' ? this.codeSessions : undefined,
    }));
  }

  displayName(jid) {
    if (AiService.isGroupJid(jid)) return this._group(jid)?.name || 'Grupo de IAs';
    if (AiService.isCodeJid(jid)) return `Claude Code - ${this.code.title(jid.slice('ai:cc:'.length))}`;
    const { provider, conv } = this._parse(jid);
    const p = PROVIDERS[provider];
    const c = this.state.get(provider)?.conversations.find((x) => x.jid === `ai:${provider}:${conv}`);
    const model = this.convModels.get(`ai:${provider}:${conv}`) || this._newModel(jid)?.label;
    const name = model ? `${p?.name} ${model}` : (p?.name || 'IA');
    return c ? `${name} - ${c.title}` : `${name} - Nova conversa`;
  }

  _toUi(jid, provider, m, i) {
    const name = PROVIDERS[provider].name;
    return {
      id: `${jid}:${m.id || i}`,
      chatJid: jid,
      fromMe: m.role === 'user',
      text: m.text,
      isNudge: false,
      timestamp: m.ts || Date.now() - 1000 * (1000 - i),
      senderName: m.role === 'user' ? null : name,
    };
  }

  async getMessages(jid) {
    if (AiService.isGroupJid(jid)) return this._group(jid)?.messages || [];
    if (AiService.isCodeJid(jid)) {
      const id = jid.slice('ai:cc:'.length);
      if (!this.code.meta.has(id)) this.refreshCode();
      // from now on, what gets written to the session shows up live
      this.code.watch(jid, id, (msgs) => {
        for (const m of msgs) {
          // my own message is already on screen (sent from this window)
          if (m.fromMe && this._sentCode?.delete(`${jid}\n${m.text.trim()}`)) continue;
          if (!m.fromMe) this._codeHeard = { ...(this._codeHeard || {}), [jid]: Date.now() };
          this.emit('message', m);
        }
      });
      return this.code.getMessages(jid, id);
    }
    const { provider, conv, p } = this._parse(jid);
    if (!p) return [];
    if (!conv) return this.cache.get(jid) || [];
    return this._enqueue(provider, async () => {
      const win = this._win(provider);
      try {
        if (p.pageMessages) await this._go(win, p.convUrl(conv));
        else if (!win.webContents.getURL().startsWith(new URL(p.home).origin)) await this._go(win, p.home);
        else await this._loaded(win);
        const { messages } = await this._eval(win, p.messages(conv));
        const list = messages.map((m, i) => this._toUi(jid, provider, m, i));
        this.cache.set(jid, list);
        return list;
      } catch (e) {
        if (process.env.MSN_DEBUG) console.log(`[ai] ${provider} history failed:`, e?.message);
        return this.cache.get(jid) || [];
      }
    });
  }

  /**
   * Type text into one provider's conversation and wait for the answer.
   * conv null starts a new conversation. Resolves { conv, text } (text null
   * if the answer couldn't be read); throws if sending failed.
   */
  _ask(provider, conv, text, model) {
    const p = PROVIDERS[provider];
    return this._enqueue(provider, async () => {
      const win = this._win(provider);
      await this._go(win, conv ? p.convUrl(conv) : p.home);
      // a fresh conversation can start on a chosen model
      if (!conv && model && p.modelPicker) {
        try { await this._eval(win, `(${SELECT_MODEL})(${JSON.stringify(p.modelPicker.btn)}, ${JSON.stringify(p.modelPicker.opt)}, ${JSON.stringify(model.match)})`); } catch {}
      }
      await this._eval(win, `(${TYPE_AND_SEND})(${JSON.stringify(p.input)}, ${JSON.stringify(p.send)}, ${JSON.stringify(text)})`);
      await this._eval(win, `(${WAIT_DONE})(${JSON.stringify(p.busy)}, 180000)`);
      // a new chat gets its id from the page address
      let id = conv;
      for (let i = 0; i < 20 && !id; i++) {
        id = p.idFromUrl(win.webContents.getURL());
        if (!id) await new Promise((r) => setTimeout(r, 500));
      }
      const { messages } = id ? await this._eval(win, p.messages(id)) : { messages: [] };
      const answer = [...messages].reverse().find((m) => m.role === 'ai');
      return { conv: id || null, text: answer?.text || null, index: messages.length };
    });
  }

  /**
   * Send my message; resolves with my own message right away and emits the
   * AI's answer as a normal incoming 'message' when it finishes.
   */
  async send(jid, text) {
    if (AiService.isGroupJid(jid)) return this.sendGroup(jid, text);
    if (AiService.isCodeJid(jid)) return this.sendCode(jid, text);
    const { provider, conv, p } = this._parse(jid);
    if (!p) throw new Error('IA desconhecida');
    const mine = { id: `${jid}:me-${Date.now()}`, chatJid: jid, fromMe: true, text, isNudge: false, timestamp: Date.now() };
    this.cache.set(jid, [...(this.cache.get(jid) || []), mine]);
    this.emit('presence', { jid, presence: 'composing' });
    const model = conv ? null : this._newModel(jid);
    this._ask(provider, conv, text, model)
      .then(({ conv: id, text: answer, index }) => {
        if (id && !conv) {
          this.aliases.set(jid, id);
          if (model) this.convModels.set(`ai:${provider}:${id}`, model.label);
        }
        if (!answer) return this.emit('message', this._notice(jid, provider, 'Não consegui ler a resposta. Veja a conversa no site.'));
        const ui = this._toUi(jid, provider, { role: 'ai', text: answer }, index);
        ui.timestamp = Date.now();
        this.cache.set(jid, [...(this.cache.get(jid) || []), ui]);
        this.emit('message', ui);
      })
      .catch((e) => this.emit('message', this._notice(jid, provider, `Não consegui enviar (${e?.message || e}). Talvez seja preciso entrar de novo.`)))
      .finally(() => {
        this.emit('presence', { jid, presence: 'paused' });
        this.refresh(provider);
      });
    return mine;
  }

  /** Message a Claude Code session: `claude -p --resume`, then show the reply. */
  async sendCode(jid, text) {
    const id = jid.slice('ai:cc:'.length);
    const mine = { id: `${jid}:me-${Date.now()}`, chatJid: jid, fromMe: true, text, isNudge: false, timestamp: Date.now() };
    const note = (t) => ({ id: `${jid}:err-${Date.now()}`, chatJid: jid, fromMe: false, text: `⚠ ${t}`, isNudge: false, timestamp: Date.now(), senderName: 'Claude Code' });
    if (!this._sentCode) this._sentCode = new Set();
    this._sentCode.add(`${jid}\n${text.trim()}`);
    this.emit('presence', { jid, presence: 'composing' });
    // the reply is written to the session file and arrives through the watcher;
    // if it doesn't (written elsewhere), show what the command printed
    const started = Date.now();
    this.code.send(id, text)
      .then((answer) => new Promise((r) => setTimeout(r, 2500)).then(() => {
        if ((this._codeHeard?.[jid] || 0) >= started) return;
        this.emit('message', { id: `${jid}:r-${Date.now()}`, chatJid: jid, fromMe: false, text: answer, isNudge: false, timestamp: Date.now(), senderName: 'Claude Code' });
      }))
      .catch((e) => this.emit('message', note(`Não consegui falar com o Claude Code (${e?.message || e}).`)))
      .finally(() => this.emit('presence', { jid, presence: 'paused' }));
    return mine;
  }

  // ---- Groups ---------------------------------------------------------------
  // A group puts several AIs in one MSN window. Each AI keeps its own real
  // conversation on its site; every time it's its turn it gets only what it
  // hasn't seen yet (my new message and what the others said since), marked
  // with who said it.
  //   mode 'round': everyone answers my message at the same time and sees the
  //                 others' answers with the next message
  //   mode 'chain': one after another, each already reading the answers before
  //                 it, so they reply to each other

  _loadGroups() {
    try {
      // older saves kept a dead "running" ({}) that froze the group
      return JSON.parse(fs.readFileSync(this.groupsFile, 'utf8')).map(({ running, ...g }) => g);
    } catch {
      return [];
    }
  }

  _saveGroups() {
    if (!this.groupsFile) return;
    try {
      const tmp = this.groupsFile + '.tmp';
      // "running" is the round in progress (a promise): not something to keep
      fs.writeFileSync(tmp, JSON.stringify(this.groups, (k, v) => (k === 'running' ? undefined : v)));
      fs.renameSync(tmp, this.groupsFile);
    } catch {
      /* non-fatal */
    }
  }

  _group(jid) {
    const id = String(jid).replace(/^ai:group:/, '');
    return this.groups.find((g) => g.id === id) || null;
  }

  getGroups() {
    return this.groups.map((g) => ({
      jid: `ai:group:${g.id}`,
      name: g.name,
      mode: g.mode,
      members: g.members.filter((m) => PROVIDERS[m]),
      busy: !!g.running,
    }));
  }

  _emitGroups() {
    this.emit('groups', this.getGroups());
  }

  /** The first group, with every AI, so there's something to start from. */
  ensureDefaultGroup(members) {
    if (this.groups.length) return;
    this.createGroup({ name: 'Todas as IAs', members, mode: 'round' });
  }

  createGroup({ name, members, mode }) {
    const g = {
      id: Date.now().toString(36),
      name: String(name || 'Grupo de IAs').slice(0, 60),
      members: (members || []).filter((m) => PROVIDERS[m]),
      mode: mode === 'chain' ? 'chain' : 'round',
      convs: {}, // provider -> its real conversation id
      introduced: [], // providers that already got the "this is a group" note
      messages: [], // UI messages, each with seenBy: [provider...]
    };
    this.groups.push(g);
    this._saveGroups();
    this._emitGroups();
    return `ai:group:${g.id}`;
  }

  updateGroup(jid, patch) {
    const g = this._group(jid);
    if (!g) return null;
    if (patch.name) g.name = String(patch.name).slice(0, 60);
    if (patch.mode) g.mode = patch.mode === 'chain' ? 'chain' : 'round';
    if (Array.isArray(patch.members)) g.members = patch.members.filter((m) => PROVIDERS[m]);
    this._saveGroups();
    this._emitGroups();
    return this.getGroups().find((x) => x.jid === jid);
  }

  deleteGroup(jid) {
    this.groups = this.groups.filter((g) => `ai:group:${g.id}` !== jid);
    this._saveGroups();
    this._emitGroups();
  }

  groupMembers(jid) {
    const g = this._group(jid);
    if (!g) return [];
    return g.members.filter((m) => PROVIDERS[m]).map((m) => ({
      // clicking a member opens that AI's own conversation behind the group
      jid: g.convs[m] ? `ai:${m}:${g.convs[m]}` : `ai:${m}:new-${Date.now()}`,
      nick: PROVIDERS[m].name,
      presence: this.state.get(m)?.loggedIn ? 'available' : 'unavailable',
    }));
  }

  /** What a member hasn't seen yet, as one message to type into its chat. */
  _pendingFor(g, provider) {
    const pending = g.messages.filter((m) => !m.seenBy.includes(provider));
    if (!pending.length) return null;
    const names = g.members.filter((m) => PROVIDERS[m]).map((m) => PROVIDERS[m].name);
    const me = PROVIDERS[provider].name;
    let text = '';
    if (!g.introduced.includes(provider)) {
      const others = names.filter((n) => n !== me);
      text +=
        `[Esta é uma conversa em grupo. Participantes: o usuário, ${others.join(', ')} e você (${me}). ` +
        'As falas dos outros chegam marcadas com o nome de quem falou. ' +
        `Responda só como ${me}, sem escrever as falas dos outros.]\n\n`;
    }
    text += pending
      .map((m) => (m.fromMe ? `Usuário: ${m.text}` : `${m.senderName}: ${m.text}`))
      .join('\n\n');
    return { text, ids: pending.map((m) => m.id) };
  }

  async _turn(g, provider) {
    const jid = `ai:group:${g.id}`;
    const name = PROVIDERS[provider].name;
    const pending = this._pendingFor(g, provider);
    if (!pending) return;
    // mark as seen now, so messages arriving meanwhile go in the next turn
    for (const m of g.messages) if (pending.ids.includes(m.id)) m.seenBy.push(provider);
    this.emit('presence', { jid, presence: 'composing', participant: `ai:${provider}`, participantName: name });
    let answer;
    try {
      const r = await this._ask(provider, g.convs[provider] || null, pending.text);
      if (r.conv) g.convs[provider] = r.conv;
      if (!g.introduced.includes(provider)) g.introduced.push(provider);
      answer = r.text || '⚠ Não consegui ler a resposta. Veja a conversa no site.';
    } catch (e) {
      // it didn't get them after all
      for (const m of g.messages) if (pending.ids.includes(m.id)) m.seenBy = m.seenBy.filter((x) => x !== provider);
      answer = `⚠ Não consegui enviar (${e?.message || e}). Talvez seja preciso entrar de novo.`;
    }
    const ui = {
      id: `${jid}:${provider}-${Date.now()}`,
      chatJid: jid,
      fromMe: false,
      text: answer,
      isNudge: false,
      timestamp: Date.now(),
      senderName: name,
      senderNick: name,
      senderJid: `ai:${provider}`,
      seenBy: answer.startsWith('⚠') ? g.members.slice() : [provider],
    };
    g.messages.push(ui);
    if (g.messages.length > 500) g.messages.splice(0, g.messages.length - 500);
    this._saveGroups();
    this.emit('presence', { jid, presence: 'paused', participant: `ai:${provider}`, participantName: name });
    this.emit('message', ui);
  }

  /** One round: every member answers what it hasn't seen yet. */
  async _round(g) {
    if (g.running) return g.running;
    const members = g.members.filter((m) => PROVIDERS[m]);
    g.running = (async () => {
      if (g.mode === 'chain') {
        for (const m of members) await this._turn(g, m);
      } else {
        await Promise.all(members.map((m) => this._turn(g, m)));
      }
    })().finally(() => {
      g.running = null;
      this._emitGroups();
    });
    this._emitGroups();
    return g.running;
  }

  async sendGroup(jid, text) {
    const g = this._group(jid);
    if (!g) throw new Error('grupo não encontrado');
    const mine = { id: `${jid}:me-${Date.now()}`, chatJid: jid, fromMe: true, text, isNudge: false, timestamp: Date.now(), seenBy: [] };
    g.messages.push(mine);
    this._saveGroups();
    // a message sent while they're still answering goes in the next round
    (typeof g.running?.then === 'function' ? g.running : Promise.resolve()).then(() => this._round(g));
    return mine;
  }

  /** Let them talk one more round without a new message from me. */
  continueGroup(jid) {
    const g = this._group(jid);
    if (g) this._round(g);
  }

  _notice(jid, provider, text) {
    return { id: `${jid}:err-${Date.now()}`, chatJid: jid, fromMe: false, text: `⚠ ${text}`, isNudge: false, timestamp: Date.now(), senderName: PROVIDERS[provider].name };
  }

  stop() {
    this.quitting = true;
    for (const win of this.wins.values()) if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { AiService, PROVIDERS, hookSession, useLoginFriendlyAgent };
