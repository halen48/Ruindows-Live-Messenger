'use strict';

/**
 * Instagram DMs, personal account, through Instagram's own website.
 *
 * There's no official API for personal DMs. Instead of an unofficial client
 * that would need (and store) the password, the app keeps instagram.com open
 * in a hidden window, in its own session: I log in on the real site once, and
 * the app reads and sends DMs with the same web calls the site itself makes.
 * No password is ever handled here; the session lives in the app's cookie
 * store, like the AI sites.
 *
 * New messages are picked up by polling the inbox (the site uses a socket we
 * don't speak), every POLL_MS.
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
// a tiny same-origin page: calls run from it with the site's cookies and
// headers, without keeping the whole (heavy) Instagram app running
const API_PAGE = `${ORIGIN}/robots.txt`;
const APP_ID = '936619743392459'; // the web app's public id, sent by the site on every call
const POLL_MS = 20000;

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

// in-page call: same origin, so the browser adds cookies, Origin, Sec-Fetch-*
const CALL = `async (method, url, body) => {
  const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
  const headers = { 'X-IG-App-ID': '${APP_ID}', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': csrf };
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(url, { method, headers, body: body || undefined, credentials: 'include' });
  return { status: r.status, text: await r.text() };
}`;

class InstagramService extends EventEmitter {
  constructor({ mediaDir } = {}) {
    super();
    this.mediaDir = mediaDir || null;
    this.chats = [];
    this.threads = new Map(); // thread id -> last inbox entry
    this.lastItem = new Map(); // thread id -> newest item id already seen
    this.rawMedia = new Map(); // UI message id -> { url, kind }
    this.avatars = new Map(); // jid -> data URL
    this.me = null; // { pk, username, name }
  }

  owns(jid) { return isIgJid(jid); }
  get ses() { return session.fromPartition(PARTITION); }

  status() {
    return { loggedIn: !!this.me, name: this.me?.name || this.me?.username || null };
  }

  // ---- session ---------------------------------------------------------------

  async _hasSession() {
    const c = await this.ses.cookies.get({ url: ORIGIN, name: 'sessionid' });
    return !!c[0]?.value;
  }

  _apiWin() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, backgroundThrottling: false } });
    useLoginFriendlyAgent(this.win.webContents);
    this.ready = this.win.loadURL(API_PAGE).catch(() => {});
    return this.win;
  }

  async _call(method, url, form) {
    const win = this._apiWin();
    await this.ready;
    const body = form ? new URLSearchParams(form).toString() : null;
    const r = await win.webContents.executeJavaScript(`(${CALL})(${JSON.stringify(method)}, ${JSON.stringify(url)}, ${JSON.stringify(body)})`, true);
    if (r.status === 401 || r.status === 403 || /"require_login":\s*true|login_required/.test(r.text)) {
      const err = new Error('sessão do Instagram expirou');
      err.loggedOut = true;
      throw err;
    }
    try { return JSON.parse(r.text); } catch { throw new Error(`resposta inesperada (${r.status})`); }
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
      const pk = (await this.ses.cookies.get({ url: ORIGIN, name: 'ds_user_id' }))[0]?.value;
      this.me = { pk: String(pk || ''), username: null, name: null };
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
    this.lastItem.clear();
    await this.ses.clearStorageData().catch(() => {});
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.emit('roster', this.getRoster());
    this.emit('login', this.status());
  }

  // ---- roster ----------------------------------------------------------------

  async refresh(first = false) {
    if (!this.me) return;
    let inbox;
    try {
      inbox = await this._call('GET', '/api/v1/direct_v2/inbox/?persistentBadging=true&folder=&limit=40&thread_message_limit=10');
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[ig] inbox failed:', e?.message);
      if (e.loggedOut) { this.me = null; clearInterval(this.poll); this.emit('login', { ...this.status(), error: e.message }); }
      return;
    }
    const viewer = inbox.viewer || {};
    if (viewer.pk) this.me = { pk: String(viewer.pk), username: viewer.username, name: viewer.full_name || viewer.username };
    const threads = inbox.inbox?.threads || [];
    const presence = await this._presence().catch(() => ({}));
    const chats = [];
    for (const t of threads) {
      const id = String(t.thread_id);
      this.threads.set(id, t);
      const jid = JID_PREFIX + id;
      const isGroup = !!t.is_group;
      const other = (t.users || [])[0];
      const pres = isGroup || !other ? { presence: 'available', lastIncoming: null } : this._presenceOf(presence[other.pk]);
      chats.push({
        jid,
        source: 'instagram',
        name: t.thread_title || (t.users || []).map((u) => u.full_name || u.username).join(', ') || 'Instagram',
        isGroup,
        unread: t.read_state === 1 ? 1 : 0,
        presence: pres.presence,
        lastIncoming: pres.lastIncoming,
        about: other && !isGroup ? `@${other.username}` : '',
        pinned: !!t.is_pin,
      });
      // new messages since the last look become notifications
      const items = t.items || [];
      const seen = this.lastItem.get(id);
      if (items[0]) this.lastItem.set(id, String(items[0].item_id));
      if (first || seen === undefined) continue;
      const fresh = [];
      for (const it of items) {
        if (String(it.item_id) === seen) break;
        fresh.push(it);
      }
      for (const it of fresh.reverse()) {
        const ui = this._toUi(jid, it, t);
        if (!ui.fromMe && ui.text) this.emit('message', ui);
      }
    }
    this.chats = chats;
    this.emit('roster', this.getRoster());
  }

  async _presence() {
    const r = await this._call('GET', '/api/v1/direct_v2/get_presence/');
    return r.user_presence || {};
  }

  // same rule as WhatsApp/Telegram: active = online, otherwise a "last seen"
  // the list turns into away/offline by age
  _presenceOf(p) {
    if (!p) return { presence: 'unavailable', lastIncoming: 0 };
    if (p.is_active) return { presence: 'available', lastIncoming: Math.floor(Date.now() / 1000) };
    return { presence: 'unavailable', lastIncoming: Math.floor((p.last_activity_at_ms || 0) / 1000) };
  }

  getRoster() { return this.chats; }
  _idOf(jid) { return jid.slice(JID_PREFIX.length); }

  // ---- messages --------------------------------------------------------------

  _userName(t, pk) {
    const u = (t?.users || []).find((x) => String(x.pk) === String(pk));
    return u ? u.full_name || u.username : null;
  }

  // the picture/video inside a post, reel or DM photo
  _mediaOf(m) {
    if (!m) return null;
    const c = m.carousel_media?.[0] || m;
    const image = c.image_versions2?.candidates?.[0]?.url;
    const video = c.video_versions?.[0]?.url;
    return { image, video, code: m.code, user: m.user?.username, caption: m.caption?.text || '', duration: Math.round(c.video_duration || 0) };
  }

  _toUi(jid, it, t = this.threads.get(this._idOf(jid))) {
    const fromMe = String(it.user_id) === this.me?.pk;
    const ui = {
      id: `${jid}:${it.item_id}`,
      chatJid: jid,
      fromMe,
      text: '',
      isNudge: false,
      timestamp: Math.floor(Number(it.timestamp) / 1000) || Date.now(),
      senderName: fromMe ? null : this._userName(t, it.user_id) || undefined,
    };
    ui.senderNick = ui.senderName;
    const media = (m, label) => {
      const x = this._mediaOf(m);
      if (!x) return (ui.text = label);
      const link = x.code ? `${ORIGIN}/${m.product_type === 'clips' || it.item_type === 'clip' ? 'reel' : 'p'}/${x.code}/` : '';
      if (x.video || x.image) {
        this.rawMedia.set(ui.id, { url: x.video || x.image, kind: x.video ? 'video' : 'image', thumb: x.image });
        ui.media = x.video ? 'video' : 'image';
        ui.duration = x.duration || undefined;
        ui.thumbUrl = x.image;
      }
      // reels/posts: who posted + the link, so it can be opened on the site
      // a plain DM photo/video shows just itself
      if (x.user || link) ui.caption = [x.user ? `${label} de @${x.user}` : label, link].filter(Boolean).join('\n');
      ui.text = ui.caption || label;
    };
    switch (it.item_type) {
      case 'text': ui.text = it.text || ''; break;
      case 'link': ui.text = it.link?.text || it.link?.link_context?.link_url || ''; break;
      case 'like': ui.text = it.like || '❤️'; break;
      case 'media': media(it.media, '📷 Foto'); if (it.media?.media_type === 2) ui.caption = ui.text = '🎬 Vídeo'; break;
      case 'clip': media(it.clip?.clip, '🎬 Reels'); break;
      case 'media_share': media(it.media_share, '📷 Post'); break;
      case 'felix_share': media(it.felix_share?.video, '🎬 Vídeo'); break;
      case 'animated_media': {
        const url = it.animated_media?.images?.fixed_height?.url;
        if (url) { this.rawMedia.set(ui.id, { url, kind: 'image' }); ui.media = 'image'; }
        ui.text = 'GIF';
        break;
      }
      case 'voice_media': ui.text = '🎵 Áudio'; break;
      case 'raven_media': case 'visual_media': ui.text = '📷 Foto temporária (abra no celular)'; break;
      case 'story_share': ui.text = '📖 Story compartilhado'; break;
      case 'reel_share': ui.text = [it.reel_share?.text, '(resposta ao story)'].filter(Boolean).join(' '); break;
      case 'action_log': ui.text = `<${it.action_log?.description || 'ação'}>`; break;
      case 'placeholder': ui.text = it.placeholder?.message || '<mensagem indisponível>'; break;
      default: {
        // newer "XMA" shares (reels, posts, links): keep the link; the window
        // turns an instagram.com/reel/ link into a preview with the video
        const xma = Object.keys(it).find((k) => k.startsWith('xma_') && Array.isArray(it[k]) && it[k][0]);
        if (xma) {
          const x = it[xma][0];
          const what = /clip|reel/.test(xma) ? '🎬 Reels' : /story/.test(xma) ? '📖 Story' : '🔗';
          ui.text = [`${what}${x.header_title_text ? ` de ${x.header_title_text}` : ''}`, x.title_text, x.target_url].filter(Boolean).join('\n');
        } else {
          ui.text = `<${it.item_type || 'mensagem'}>`;
        }
      }
    }
    return ui;
  }

  async getMessages(jid, limit = 40) {
    if (!this.me) return [];
    try {
      const r = await this._call('GET', `/api/v1/direct_v2/threads/${this._idOf(jid)}/?limit=${limit}`);
      const t = r.thread || {};
      this.threads.set(this._idOf(jid), { ...this.threads.get(this._idOf(jid)), ...t });
      return [...(t.items || [])].reverse().map((it) => this._toUi(jid, it, t)).filter((m) => m.text || m.media);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[ig] thread failed:', e?.message);
      return [];
    }
  }

  async send(jid, text) {
    const ctx = String(BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1e6)));
    const r = await this._call('POST', '/api/v1/direct_v2/threads/broadcast/text/', {
      action: 'send_item',
      client_context: ctx,
      mutation_token: ctx,
      offline_threading_id: ctx,
      thread_ids: `[${this._idOf(jid)}]`,
      text,
    });
    if (r.status !== 'ok') throw new Error(r.message || 'o Instagram recusou a mensagem');
    const itemId = r.payload?.item_id || ctx;
    this.lastItem.set(this._idOf(jid), String(itemId));
    return { id: `${jid}:${itemId}`, chatJid: jid, fromMe: true, text, isNudge: false, timestamp: Date.now() };
  }

  async markRead(jid) {
    const id = this._idOf(jid);
    const item = this.threads.get(id)?.items?.[0]?.item_id;
    if (!item) return;
    try {
      await this._call('POST', `/api/v1/direct_v2/threads/${id}/items/${item}/seen/`, { action: 'mark_seen', thread_id: id, use_unified_inbox: 'true' });
      const c = this.chats.find((x) => x.jid === jid);
      if (c?.unread) { c.unread = 0; this.emit('roster', this.getRoster()); }
    } catch {}
  }

  async setTyping() {}

  async groupMembers(jid) {
    const t = this.threads.get(this._idOf(jid));
    return (t?.users || []).map((u) => ({
      jid: `${JID_PREFIX}u${u.pk}`,
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
    const t = this.threads.get(this._idOf(jid));
    const url = t?.is_group ? null : t?.users?.[0]?.profile_pic_url;
    const data = url ? await this._dataUrl(url) : null;
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

  /** Still picture for a reel/post shown in a chat (a data URL, the CDN links expire). */
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
      let info;
      try { info = await this._call('GET', `/api/v1/media/${mediaId}/info/`); } catch { return null; }
      const x = this._mediaOf(info.items?.[0]);
      if (!x || !(x.video || x.image)) return null;
      this.rawMedia.set(id, { url: x.video || x.image, kind: x.video ? 'video' : 'image', thumb: x.image, user: x.user, caption: x.caption, duration: x.duration });
    }
    const m = this.rawMedia.get(id);
    return { id, media: m.kind, thumb: await this._dataUrl(m.thumb), user: m.user, caption: (m.caption || '').slice(0, 200), duration: m.duration || undefined };
  }
}

module.exports = { InstagramService, isIgJid, shortcodeToId, REEL_RE };
