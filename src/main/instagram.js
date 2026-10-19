'use strict';

/**
 * Instagram DMs, personal account, through Instagram's own website.
 *
 * There's no official API for personal DMs, and the old /api/v1/direct_v2/
 * calls are gone from the web (404). The site now reads DMs with GraphQL
 * queries (PolarisDirectInboxQuery for the list, IGDThreadDetailQuery for a
 * conversation) and sends them over its own socket. So:
 *   - reading: the app opens instagram.com/direct/inbox/ once in a hidden
 *     window, keeps a copy of the queries the page itself sends (with the
 *     session's tokens) and repeats them from inside the site when it needs
 *     the list or a conversation;
 *   - sending: the hidden window opens the conversation and types into the
 *     message box, exactly like I would.
 * No password is handled here: I log in on the real site once and the
 * session stays in the app's own cookie store, like the AI sites.
 *
 * New messages are picked up by repeating the inbox query every POLL_MS.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { BrowserWindow, session } = require('electron');
const { useLoginFriendlyAgent } = require('./ai');

const JID_PREFIX = 'ig:';
const isIgJid = (jid) => typeof jid === 'string' && jid.startsWith(JID_PREFIX);
const PARTITION = 'persist:instagram';
const ORIGIN = 'https://www.instagram.com';
// a tiny same-origin page to run calls from while the heavy app isn't needed
const IDLE_PAGE = `${ORIGIN}/robots.txt`;
const APP_ID = '936619743392459'; // the web app's public id, sent by the site on every REST call
const POLL_MS = 20000;
const IDLE_MS = 60000;
const QUERIES = ['PolarisDirectInboxQuery', 'IGDThreadDetailQuery'];

// shortcode (the "C3xY..." in /reel/C3xY.../) -> numeric media id
const SC_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function shortcodeToId(code) {
  let id = 0n;
  for (const ch of String(code).slice(0, 11)) {
    const v = SC_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}
const REEL_RE = /instagram\.com\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]{5,})/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class InstagramService extends EventEmitter {
  constructor({ mediaDir } = {}) {
    super();
    this.mediaDir = mediaDir || null;
    this.chats = [];
    this.threads = new Map(); // thread_id -> latest thread object
    this.lastTs = new Map(); // thread_id -> newest message time already seen
    this.rawMedia = new Map(); // UI message id -> { url, kind, thumb }
    this.avatars = new Map(); // jid -> data URL
    this.q = {}; // friendly name -> captured request body
    this.me = null; // { fbid, name }
    this.sendQueue = Promise.resolve();
    this.following = []; // people I follow: the "contacts" of Instagram
    this.userThreads = new Map(); // username -> thread id, for 1:1 conversations
    this.uiById = new Map(); // shown messages, for replies' quotes
  }

  // people I follow with no conversation yet are listed as ig:user:<username>
  _userOf(jid) { return jid.startsWith(`${JID_PREFIX}user:`) ? jid.slice(JID_PREFIX.length + 5) : null; }
  /** The conversation id for a jid, if there is one (ig:user:x only after a first message). */
  _threadId(jid) {
    const user = this._userOf(jid);
    return user ? this.userThreads.get(user.toLowerCase()) || null : this._idOf(jid);
  }

  /** Everyone I follow (page by page, gently), again every 6 h. */
  async _loadFollowing() {
    if (this.followingAt && Date.now() - this.followingAt < 6 * 3600e3) return;
    this.followingAt = Date.now();
    const pk = (await this.ses.cookies.get({ url: ORIGIN, name: 'ds_user_id' }))[0]?.value;
    if (!pk) return;
    const all = [];
    let next = '';
    for (let page = 0; page < 15; page++) {
      let r;
      try {
        r = JSON.parse(await this.win.webContents.executeJavaScript(
          `fetch('/api/v1/friendships/${pk}/following/?count=200${next ? `&max_id=${next}` : ''}', { headers: { 'X-IG-App-ID': '${APP_ID}', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '' }, credentials: 'include' }).then((r) => r.text())`,
          true
        ));
      } catch { break; }
      for (const u of r.users || []) all.push({ pk: String(u.pk), username: u.username, name: u.full_name || u.username, pic: u.profile_pic_url });
      next = r.next_max_id;
      if (!next) break;
      await sleep(1500);
    }
    if (all.length) { this.following = all; this.refresh(); }
  }

  owns(jid) { return isIgJid(jid); }
  get ses() { return session.fromPartition(PARTITION); }

  status() {
    return { loggedIn: !!this.me, name: this.me?.name || null };
  }

  // ---- the hidden window ------------------------------------------------------

  _win() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { partition: PARTITION } });
    useLoginFriendlyAgent(this.win.webContents);
    // keep a copy of the GraphQL queries the site sends (they carry the
    // session's current tokens), to repeat them later
    if (!this.hooked) {
      this.hooked = true;
      this.ses.webRequest.onBeforeRequest({ urls: [`${ORIGIN}/api/graphql*`] }, (d, cb) => {
        try {
          const body = Buffer.concat((d.uploadData || []).map((u) => u.bytes || Buffer.alloc(0))).toString();
          const name = (body.match(/fb_api_req_friendly_name=([^&]+)/) || [])[1];
          if (QUERIES.includes(name)) this.q[name] = body;
        } catch {}
        cb({});
      });
    }
    this.loaded = this.win.loadURL(IDLE_PAGE).catch(() => {});
    return this.win;
  }

  async _go(url) {
    const win = this._win();
    await this.loaded;
    clearTimeout(this.idleTimer);
    if (win.webContents.getURL() !== url) {
      this.loaded = win.loadURL(url).catch(() => {});
      await this.loaded;
    }
    // the full Instagram app is heavy: back to a blank page when idle
    this.idleTimer = setTimeout(() => {
      if (!this.win.isDestroyed() && this.win.webContents.getURL() !== IDLE_PAGE) this.loaded = this.win.loadURL(IDLE_PAGE).catch(() => {});
    }, IDLE_MS);
    return win;
  }

  /** Open the inbox once so the site sends its queries and we can copy them. */
  async _capture() {
    if (QUERIES.every((n) => this.q[n])) return;
    if (this.capturing) return this.capturing;
    this.capturing = (async () => {
      await this._go(`${ORIGIN}/direct/inbox/`);
      for (let i = 0; i < 60 && !QUERIES.every((n) => this.q[n]); i++) await sleep(500);
      if (!this.q.PolarisDirectInboxQuery) throw new Error('o Instagram não carregou a caixa de entrada');
    })().finally(() => { this.capturing = null; });
    return this.capturing;
  }

  async _gql(name, variables) {
    await this._capture();
    let body = this.q[name];
    if (!body) throw new Error(`consulta ${name} indisponível`);
    if (variables) {
      const p = new URLSearchParams(body);
      p.set('variables', JSON.stringify({ ...JSON.parse(p.get('variables') || '{}'), ...variables }));
      body = p.toString();
    }
    const win = this.win;
    await this.loaded;
    const text = await win.webContents.executeJavaScript(
      `fetch('/api/graphql', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: ${JSON.stringify(body)}, credentials: 'include' }).then((r) => r.text())`,
      true
    );
    let json;
    try { json = JSON.parse(String(text).split('\n')[0]); } catch {
      // tokens expired or logged out: copy the queries again next time
      this.q = {};
      const err = new Error('resposta inesperada do Instagram');
      err.loggedOut = !(await this._hasSession());
      throw err;
    }
    if (json.errors?.length && !json.data) { this.q = {}; throw new Error(json.errors[0].message || 'erro do Instagram'); }
    return json.data;
  }

  // ---- session ---------------------------------------------------------------

  async _hasSession() {
    const c = await this.ses.cookies.get({ url: ORIGIN, name: 'sessionid' });
    return !!c[0]?.value;
  }

  /** On startup: pick the saved session back up, quietly. */
  async resume() {
    if (!(await this._hasSession())) return false;
    return this._start();
  }

  /** Show instagram.com's own sign-in; finishes by itself once I'm in. */
  login() {
    if (this.loginWin && !this.loginWin.isDestroyed()) { this.loginWin.focus(); return; }
    const win = new BrowserWindow({ width: 460, height: 720, title: 'Entrar no Instagram', autoHideMenuBar: true, webPreferences: { partition: PARTITION } });
    useLoginFriendlyAgent(win.webContents);
    win.loadURL(`${ORIGIN}/accounts/login/`).catch(() => {});
    this.loginWin = win;
    const check = setInterval(async () => {
      if (win.isDestroyed()) return clearInterval(check);
      if (!(await this._hasSession())) return;
      clearInterval(check);
      win.close();
      await this._start();
    }, 1500);
    win.on('closed', () => clearInterval(check));
  }

  async _start() {
    try {
      this.me = { fbid: null, name: null };
      await this.refresh(true);
      if (!this.me) return false;
      clearInterval(this.poll);
      this.poll = setInterval(() => this.refresh(), POLL_MS);
      this.emit('login', this.status());
      return true;
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[ig] start failed:', e?.message);
      this.me = null;
      return false;
    }
  }

  async logout() {
    clearInterval(this.poll);
    this.me = null;
    this.chats = [];
    this.threads.clear();
    this.lastTs.clear();
    this.q = {};
    await this.ses.clearStorageData().catch(() => {});
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.emit('roster', this.getRoster());
    this.emit('login', this.status());
  }

  // ---- roster ----------------------------------------------------------------

  async refresh(first = false) {
    if (!this.me) return;
    let data;
    try {
      data = await this._gql('PolarisDirectInboxQuery');
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[ig] inbox failed:', e?.message);
      if (e.loggedOut) { this.me = null; clearInterval(this.poll); this.emit('login', { ...this.status(), error: 'sessão do Instagram expirou' }); }
      if (first) throw e;
      return;
    }
    const edges = data?.get_slide_mailbox_for_iris_subscription?.threads_by_folder?.edges || [];
    const chats = [];
    for (const { node } of edges) {
      const t = node?.as_ig_direct_thread;
      if (!t) continue;
      const id = String(t.thread_id);
      this.threads.set(id, { ...this.threads.get(id), ...t });
      if (!this.me.fbid && t.viewer?.interop_messaging_user_fbid) this.me.fbid = String(t.viewer.interop_messaging_user_fbid);
      const jid = JID_PREFIX + id;
      const msgs = this._sorted(t);
      const theirs = msgs.filter((m) => !this._isMine(m));
      // unread: their messages after my read receipt (or "marked as unread")
      const myMark = Number((t.slide_read_receipts || []).find((r) => String(r.participant_fbid) === this.me.fbid)?.watermark_timestamp_ms || 0);
      const unread = theirs.filter((m) => Number(m.timestamp_ms) > myMark).length || (t.marked_as_unread ? 1 : 0);
      const other = (t.users || [])[0];
      // no "active now" on the web for this account: the same rule WhatsApp
      // uses without presence, by when they last wrote
      const lastTheirs = theirs.length ? Math.floor(Number(theirs[theirs.length - 1].timestamp_ms) / 1000) : 0;
      if (!t.is_group && other?.username) this.userThreads.set(other.username.toLowerCase(), id);
      chats.push({
        jid,
        source: 'instagram',
        name: t.thread_title || (t.users || []).map((u) => u.full_name || u.username).join(', ') || 'Instagram',
        isGroup: !!t.is_group,
        unread,
        presence: t.is_group ? 'available' : 'unavailable',
        lastIncoming: t.is_group ? null : lastTheirs,
        lastTimestamp: Math.floor(Number(t.last_activity_timestamp_ms || 0) / 1000),
        about: other && !t.is_group ? `@${other.username}` : '',
        pinned: !!t.is_pin,
      });
      // new messages since the last look become notifications
      const newest = msgs.length ? Number(msgs[msgs.length - 1].timestamp_ms) : 0;
      const seen = this.lastTs.get(id);
      this.lastTs.set(id, Math.max(newest, seen || 0));
      if (first || seen === undefined) continue;
      for (const m of msgs) {
        if (Number(m.timestamp_ms) <= seen || this._isMine(m)) continue;
        const ui = this._toUi(jid, m, t);
        if (ui.text || ui.media) this.emit('message', ui);
      }
    }
    for (const u of this.following) {
      if (this.userThreads.has(u.username.toLowerCase())) continue;
      chats.push({ jid: `${JID_PREFIX}user:${u.username}`, source: 'instagram', name: u.name, isGroup: false, unread: 0, presence: 'unavailable', lastIncoming: null, about: `@${u.username}`, pinned: false, contactOnly: true });
    }
    this.chats = chats;
    this.emit('roster', this.getRoster());
    if (first) setTimeout(() => this._loadFollowing().catch(() => {}), 5000);
  }

  getRoster() { return this.chats; }

  /**
   * Answer the bubble showing `text` (the newest one with it) the way I
   * would: hover it for real, then press its own "reply" button.
   */
  async _pressReply(win, text) {
    // the site draws emoji as images (gone from the page's text): compare
    // without them and without spacing
    const norm = (t) => String(t || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]/gu, '');
    const want = norm(String(text || '').split('\n')[0]).slice(0, 40);
    if (!want) return false;
    // the conversation takes a few seconds to draw its messages
    for (let i = 0; i < 40; i++) {
      // every element showing the text, newest first (the conversation list
      // on the left shows it too, without a reply button)
      const spots = await win.webContents.executeJavaScript(`(() => {
        const norm = ${norm.toString()};
        window.__msnReply = [...document.querySelectorAll('div[dir=auto], span[dir=auto]')].filter((e) => norm(e.innerText).startsWith(${JSON.stringify(want)}) && !e.closest('[contenteditable]')).reverse();
        return window.__msnReply.length;
      })()`);
      for (let k = 0; k < spots; k++) {
        const at = await win.webContents.executeJavaScript(`(() => {
          const el = window.__msnReply[${k}];
          el.scrollIntoView({ block: 'center' });
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x + Math.min(b.width / 2, 40)), y: Math.round(b.y + b.height / 2) };
        })()`);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
        await sleep(600);
        const ok = await win.webContents.executeJavaScript(`(() => {
          let row = window.__msnReply[${k}], btn = null;
          for (let up = 0; row && up < 8 && !(btn = row.querySelector('[aria-label^="Responda"], [aria-label^="Reply"]')); up++) row = row.parentElement;
          if (!btn) return false;
          (btn.closest('[role=button]') || btn).click();
          return true;
        })()`);
        if (ok) { await sleep(500); return true; }
      }
      await sleep(500);
    }
    return false;
  }


  /** Unread conversations whose latest message came after `since` (seconds): sent while I was offline. */
  async unreadSince(since) {
    const out = [];
    for (const c of this.chats) {
      if (!c.unread) continue;
      const t = this.threads.get(this._idOf(c.jid));
      const theirs = t ? this._sorted(t).filter((m) => !this._isMine(m)) : [];
      const m = theirs[theirs.length - 1];
      if (m && Number(m.timestamp_ms) / 1000 > since) out.push(this._toUi(c.jid, m, t));
    }
    return out;
  }
  _idOf(jid) { return jid.slice(JID_PREFIX.length); }

  _sorted(t) {
    return (t.slide_messages?.edges || []).map((e) => e.node).filter(Boolean)
      .sort((a, b) => Number(a.timestamp_ms) - Number(b.timestamp_ms));
  }

  _isMine(m) { return !!this.me?.fbid && String(m.sender_fbid) === this.me.fbid; }

  // ---- messages --------------------------------------------------------------

  _senderName(t, m) {
    if (m.sender?.name) return m.sender.name;
    const u = (t?.users || []).find((x) => String(x.interop_messaging_user_fbid) === String(m.sender_fbid));
    return u ? u.full_name || u.username : null;
  }

  // first picture URL anywhere inside a message's content
  _findImage(v, depth = 0) {
    if (!v || typeof v !== 'object' || depth > 6) return null;
    if (typeof v.url === 'string' && /^https?:/.test(v.url)) return v.url;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'header_icon' || k === 'favicon') continue;
      const u = this._findImage(x, depth + 1);
      if (u) return u;
    }
    return null;
  }

  _toUi(jid, m, t = this.threads.get(this._idOf(jid))) {
    const fromMe = this._isMine(m);
    const ui = {
      id: `${jid}:${m.message_id || m.id}`,
      chatJid: jid,
      fromMe,
      text: '',
      isNudge: false,
      timestamp: Number(m.timestamp_ms) || Date.now(),
      senderName: fromMe ? null : this._senderName(t, m) || undefined,
    };
    ui.senderNick = ui.senderName;
    const c = m.content || {};
    const kind = c.__typename || '';
    if (kind === 'SlideMessageText') {
      ui.text = c.text_body || '';
    } else if (kind === 'SlideMessageAdminText') {
      ui.text = `<${(c.text_fragments || []).map((f) => f.plaintext).join('') || 'ação'}>`;
    } else if (c.xma) {
      // shares: reels, posts, stories, links. The link stays in the text; a
      // reel/post link gets the video preview in the chat window
      const x = c.xma;
      const url = x.target_url || '';
      const what = /\/(reels?|tv)\//.test(url) ? '🎬 Reels' : /\/p\//.test(url) ? '📷 Post' : /stories/.test(url) ? '📖 Story' : '🔗';
      const head = x.header_title_text ? `${what} de ${x.header_title_text}` : what;
      ui.text = [head, c.xma_text_body, url].filter(Boolean).join('\n');
      if (x.preview_image?.url) this.rawMedia.set(ui.id, { url: x.preview_image.url, kind: 'image', thumb: x.preview_image.url });
    } else if (/Image|Photo/.test(kind) || m.content_type === 'IMAGES') {
      const url = this._findImage(c);
      if (url) { this.rawMedia.set(ui.id, { url, kind: 'image', thumb: url }); ui.media = 'image'; }
      ui.text = url ? '📷 <foto>' : '📷 Foto (abra no celular)';
    } else if (/Video/.test(kind) || m.content_type === 'VIDEO') {
      ui.text = '🎬 Vídeo (abra no celular)';
    } else if (/Audio|Voice/.test(kind) || m.content_type === 'AUDIO') {
      ui.text = '🎵 Áudio';
    } else if (/Sticker/.test(kind)) {
      ui.text = 'Figurinha';
    } else if (/Expired/.test(kind)) {
      ui.text = '<mensagem expirada>';
    } else {
      ui.text = m.text_body || `<${(m.content_type || kind || 'mensagem').toLowerCase()}>`;
    }
    // a reply: show what it answers (the quoted message is in the same thread)
    const rid = m.replied_to_message_id;
    if (rid) {
      const q = this.uiById.get(`${jid}:${rid}`);
      ui.quote = { id: `${jid}:${rid}`, text: q?.text || (q ? '' : 'Mensagem'), media: q?.media || null, caption: null, thumb: null, fromMe: !!q?.fromMe, senderName: q?.fromMe ? null : q?.senderName || null };
    }
    this.uiById.set(ui.id, ui);
    if (this.uiById.size > 20000) this.uiById.delete(this.uiById.keys().next().value);
    return ui;
  }

  async getMessages(jid) {
    if (!this.me) return [];
    const t = this.threads.get(this._threadId(jid));
    if (!t) return [];
    try {
      const data = await this._gql('IGDThreadDetailQuery', { thread_fbid: String(t.thread_fbid) });
      const full = data?.get_slide_thread_nullable?.as_ig_direct_thread;
      const thread = full || t;
      return this._sorted(thread).map((m) => this._toUi(jid, m, thread)).filter((m) => m.text || m.media);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[ig] thread failed:', e?.message);
      return this._sorted(t).map((m) => this._toUi(jid, m, t));
    }
  }

  /**
   * Start (or find) the conversation with @username: Instagram's own
   * ig.me/m/<user> link opens it; the thread id comes from where it lands.
   */
  async startChat(username) {
    const user = String(username || '').trim().replace(/^@/, '').replace(/[^\w.]/g, '');
    if (!user) throw new Error('nome de usuário vazio');
    if (!this.me) throw new Error('entre no Instagram primeiro');
    const known = this.userThreads.get(user.toLowerCase());
    if (known) return JID_PREFIX + known;
    const win = await this._go(`https://ig.me/m/${user}`);
    let id = null;
    for (let i = 0; i < 40 && !id; i++) {
      id = (win.webContents.getURL().match(/\/direct\/t\/(\d+)/) || [])[1];
      if (!id) await sleep(250);
    }
    if (!id) throw new Error(`não achei @${user} no Instagram`);
    this.userThreads.set(user.toLowerCase(), id);
    // shows up in the list right away, filled in properly by the next refresh
    if (!this.chats.some((c) => c.jid === JID_PREFIX + id)) {
      this.chats.push({ jid: JID_PREFIX + id, source: 'instagram', name: `@${user}`, isGroup: false, unread: 0, presence: 'unavailable', lastIncoming: 0, about: `@${user}`, pinned: false });
      this.emit('roster', this.getRoster());
    }
    setTimeout(() => this.refresh(), 2000);
    return JID_PREFIX + id;
  }

  /**
   * Send by typing into the conversation in the hidden window, like I would
   * (the site sends DMs over its own socket, which can't be replayed).
   */
  send(jid, text, quotedId) {
    const run = this.sendQueue.then(() => this._send(jid, text, quotedId));
    this.sendQueue = run.catch(() => {});
    return run;
  }

  async _send(jid, text, quotedId) {
    // someone I follow with no conversation yet: open one first
    let id = this._threadId(jid);
    if (!id) id = this._idOf(await this.startChat(this._userOf(jid)));
    const win = await this._go(`${ORIGIN}/direct/t/${id}/`);
    const BOX = 'div[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]';
    // the window has to really draw for hover buttons to show up
    if (quotedId && !(await this._pressReply(win, this.uiById.get(quotedId)?.text))) {
      throw new Error('não achei a mensagem pra responder no Instagram');
    }
    const ok = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let box = null;
      for (let i = 0; i < 60 && !box; i++) { box = document.querySelector(${JSON.stringify(BOX)}); if (!box) await sleep(250); }
      if (!box) return false;
      box.focus();
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      await sleep(300);
      return box.innerText.trim().length > 0;
    })()`);
    if (!ok) throw new Error('não achei a caixa de mensagem do Instagram');
    // a real Enter, as if typed
    for (const type of ['keyDown', 'char', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: type === 'char' ? '\r' : 'Return' });
    const sent = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 40; i++) { const b = document.querySelector(${JSON.stringify(BOX)}); if (b && !b.innerText.trim()) return true; await sleep(250); }
      return false;
    })()`);
    if (!sent) throw new Error('o Instagram não enviou a mensagem');
    this.lastTs.set(id, Date.now());
    setTimeout(() => this.refresh(), 3000);
    return { id: `${jid}:me-${Date.now()}`, chatJid: jid, fromMe: true, text, isNudge: false, timestamp: Date.now() };
  }

  async markRead(jid) {
    const c = this.chats.find((x) => x.jid === jid);
    if (c?.unread) { c.unread = 0; this.emit('roster', this.getRoster()); }
  }

  async setTyping() {}

  async groupMembers(jid) {
    const t = this.threads.get(this._threadId(jid) || '');
    return (t?.users || []).map((u) => ({
      jid: `${JID_PREFIX}u${u.id}`,
      nick: u.full_name || u.username,
      title: `@${u.username}`,
      name: u.full_name || u.username,
      presence: 'unavailable',
      lastIncoming: null,
    }));
  }

  // sending pictures/files needs Instagram's separate upload service; not yet
  async sendImage() { throw new Error('enviar foto pelo Instagram ainda não funciona'); }
  async sendFile() { throw new Error('enviar arquivo pelo Instagram ainda não funciona'); }

  // ---- pictures, videos, avatars --------------------------------------------

  async _download(url) {
    const r = await this.ses.fetch(url, { headers: { Referer: `${ORIGIN}/` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  async _dataUrl(url) {
    try { return `data:image/jpeg;base64,${(await this._download(url)).toString('base64')}`; } catch { return null; }
  }

  async avatar(jid) {
    if (this.avatars.has(jid)) return this.avatars.get(jid);
    const user = this._userOf(jid);
    const t = this.threads.get(this._threadId(jid) || '');
    const url = user ? this.following.find((u) => u.username === user)?.pic : t?.is_group ? t?.thread_image_url : t?.users?.[0]?.profile_pic_url;
    const data = typeof url === 'string' ? await this._dataUrl(url) : null;
    if (data) this.avatars.set(jid, data);
    return data;
  }

  _mediaFile(id, kind) {
    return path.join(this.mediaDir, `${String(id).replace(/[^\w-]/g, '')}.${kind === 'video' ? 'mp4' : 'jpg'}`);
  }

  cachedMedia(id) {
    const m = this.rawMedia.get(id);
    if (!m || !this.mediaDir) return null;
    const file = this._mediaFile(id, m.kind);
    return fs.existsSync(file) ? file : null;
  }

  async getMedia(id) {
    const m = this.rawMedia.get(id);
    if (!m || !this.mediaDir) return null;
    const file = this._mediaFile(id, m.kind);
    if (fs.existsSync(file)) return file;
    try {
      const buf = await this._download(m.url);
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(file, buf);
      return file;
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[ig] media failed:', e?.message);
      return null;
    }
  }

  /** Still picture for a share (a data URL, the CDN links expire). */
  async thumb(id) {
    const m = this.rawMedia.get(id);
    return m?.thumb ? this._dataUrl(m.thumb) : null;
  }

  /**
   * Preview for an instagram.com/reel|p/... link in any chat: still + video,
   * through my logged-in session. Null when not logged in or not a post.
   */
  async linkPreview(url) {
    const code = String(url).match(REEL_RE)?.[1];
    if (!code || !this.me) return null;
    const id = `${JID_PREFIX}preview:${code}`; // ig: so media requests come back here
    if (!this.rawMedia.has(id)) {
      const mediaId = shortcodeToId(code);
      if (!mediaId) return null;
      this._win();
      await this.loaded;
      let info;
      try {
        info = JSON.parse(await this.win.webContents.executeJavaScript(
          `fetch('/api/v1/media/${mediaId}/info/', { headers: { 'X-IG-App-ID': '${APP_ID}', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '' }, credentials: 'include' }).then((r) => r.text())`,
          true
        ));
      } catch { return null; }
      const it = info?.items?.[0];
      const c = it?.carousel_media?.[0] || it;
      const image = c?.image_versions2?.candidates?.[0]?.url;
      const video = c?.video_versions?.[0]?.url;
      if (!image && !video) return null;
      this.rawMedia.set(id, { url: video || image, kind: video ? 'video' : 'image', thumb: image, user: it.user?.username, caption: it.caption?.text || '', duration: Math.round(c.video_duration || 0) });
    }
    const m = this.rawMedia.get(id);
    return { id, media: m.kind, thumb: await this._dataUrl(m.thumb), user: m.user, caption: (m.caption || '').slice(0, 200), duration: m.duration || undefined };
  }
}

module.exports = { InstagramService, isIgJid, shortcodeToId, REEL_RE };
