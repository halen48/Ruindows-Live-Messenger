'use strict';

/**
 * Telegram as contacts in the same list as WhatsApp.
 *
 * Logs into the *personal* account over MTProto (gramjs), so it sees the real
 * chats, not a bot. The login needs an api_id/api_hash the user generates for
 * free at https://my.telegram.org — these and the saved session string live
 * on this PC only (encrypted with the OS keyring when available). Nothing is
 * sent anywhere but Telegram's own servers.
 *
 * Chats are exposed with jids like `tg:<peerId>` and source 'telegram', so the
 * renderer shows them with the blue badge next to the WhatsApp ones. Messages,
 * history and sending go through the same channels as WhatsApp.
 */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const JID_PREFIX = 'tg:';
const isTgJid = (jid) => typeof jid === 'string' && jid.startsWith(JID_PREFIX);

// Built-in app credentials (Telegram Desktop's public ones) so the user just
// scans a QR and never has to touch my.telegram.org. The api_id/api_hash
// identify the *app*, not the account — logging in is still the user's own QR
// scan. Someone who wants their own can still set them.
const DEFAULT_API_ID = 2040;
const DEFAULT_API_HASH = 'b18441a1ff607e10a989891a5462e627';

// A deferred promise: resolve() it from elsewhere (the login code typed in UI).
function defer() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

class TelegramService extends EventEmitter {
  /** stateFile: where the session + api creds are stored; safeStorage optional. */
  constructor({ stateFile, safeStorage } = {}) {
    super();
    this.stateFile = stateFile;
    // downloaded photos/videos, next to the session file
    this.mediaDir = stateFile ? path.join(path.dirname(stateFile), 'media') : null;
    // gramjs messages with media, by UI id, so the window can ask to download
    this.rawMedia = new Map();
    this.uiById = new Map();
    this.lastMsg = new Map(); // jid -> newest gramjs message, for offline messages
    // resolves once a saved session finished connecting (or turned out invalid)
    this.ready = new Promise((r) => { this._setReady = r; });
    this.safeStorage = safeStorage || null;
    this.client = null;
    this.entities = new Map(); // peerId (string) -> gramjs entity
    this.chats = []; // roster entries
    this.login = null; // in-progress login { step, resolvers }
    this.me = null;
    this.state = this._load();
  }

  // ---- persisted state (api creds + session string) ------------------------

  _load() {
    try {
      const raw = fs.readFileSync(this.stateFile);
      // plain JSON (no keyring when it was saved) or safeStorage ciphertext
      const json = raw[0] === 0x7b ? raw.toString('utf8') : this.safeStorage.decryptString(raw);
      return JSON.parse(json);
    } catch {
      return { apiId: null, apiHash: null, session: '' };
    }
  }

  _save() {
    try {
      const json = JSON.stringify(this.state);
      const buf = this.safeStorage?.isEncryptionAvailable()
        ? this.safeStorage.encryptString(json)
        : Buffer.from(json, 'utf8');
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, buf);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] save failed:', e?.message);
    }
  }

  _apiId() { return Number(this.state.apiId || DEFAULT_API_ID); }
  _apiHash() { return String(this.state.apiHash || DEFAULT_API_HASH); }
  // always usable now: built-in creds mean the user only scans a QR
  configured() { return true; }

  owns(jid) { return isTgJid(jid); }

  status() {
    return {
      configured: this.configured(),
      loggedIn: !!this.me,
      // where the login flow is waiting, so the UI knows what to ask for
      awaiting: this.login?.step || null,
      name: this.me ? [this.me.firstName, this.me.lastName].filter(Boolean).join(' ') : null,
    };
  }

  // ---- login ----------------------------------------------------------------

  _newClient() {
    const { TelegramClient } = require('telegram');
    const { StringSession } = require('telegram/sessions');
    return new TelegramClient(
      new StringSession(this.state.session || ''),
      this._apiId(),
      this._apiHash(),
      // over secure WebSocket (port 443), like Telegram Web: networks that
      // filter non-HTTPS traffic left the plain connection hanging forever
      { connectionRetries: 5, deviceModel: 'Ruindows Live Messenger', appVersion: '8.5', useWSS: true }
    );
  }

  /**
   * Resume a saved session on startup, without asking for anything. Resolves
   * true if already logged in, false if a fresh login is needed.
   */
  async resume() {
    const ok = await this._resume();
    this._setReady(ok);
    return ok;
  }

  async _resume() {
    // read again now that the app is ready: on Linux the keyring behind
    // safeStorage isn't available when the service is built, so the
    // encrypted file looked unreadable and the session seemed gone
    this.state = this._load();
    if (!this.state.session) return false;
    try {
      this.client = this._newClient();
      await this.client.connect();
      if (!(await this.client.checkAuthorization())) return false;
      await this._onLoggedIn();
      return true;
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] resume failed:', e?.message);
      return false;
    }
  }

  /**
   * Start a phone-number login. Returns once Telegram has sent the code; the
   * UI then calls submitCode (and submitPassword if 2FA is on). apiId/apiHash
   * are saved for next time.
   */
  async startLogin({ apiId, apiHash, phone }) {
    if (apiId && apiHash) {
      this.state.apiId = Number(apiId);
      this.state.apiHash = String(apiHash).trim();
      this._save();
    }
    if (!this.configured()) throw new Error('faltam o api_id e o api_hash (pegue em my.telegram.org)');
    if (this.login) throw new Error('já tem um login em andamento');

    this.client = this._newClient();
    const code = defer();
    const password = defer();
    this.login = { step: 'code', code, password };

    // client.start drives the whole flow; the callbacks block until the UI
    // feeds the code / password back in through submitCode / submitPassword
    const done = this.client.start({
      phoneNumber: async () => String(phone).trim(),
      phoneCode: async () => {
        this.login.step = 'code';
        this.emit('login', this.status());
        return code.promise;
      },
      password: async () => {
        this.login.step = 'password';
        this.emit('login', this.status());
        return password.promise;
      },
      onError: (err) => { this.login.error = err?.message || String(err); },
    });

    this.login.done = done
      .then(async () => {
        this.login = null;
        await this._onLoggedIn();
      })
      .catch((e) => {
        const msg = e?.message || String(e);
        this.login = null;
        this.emit('login', { ...this.status(), error: msg });
        throw e;
      });

    return this.status();
  }

  /**
   * Log in by QR code: scan it in the phone's Telegram (Settings > Devices >
   * Link Desktop Device). Still needs api_id/api_hash once (they identify the
   * app, not the account). Emits 'qr' with a tg://login URL to turn into an
   * image; re-emits when the token refreshes.
   */
  async startQrLogin({ apiId, apiHash }) {
    if (apiId && apiHash) {
      this.state.apiId = Number(apiId);
      this.state.apiHash = String(apiHash).trim();
      this._save();
    }
    if (!this.configured()) throw new Error('faltam o api_id e o api_hash (pegue em my.telegram.org)');
    // a previous attempt left hanging (window closed, network dropped): start over
    if (this.login) {
      const old = this.client;
      this.login = null;
      old?.disconnect().catch(() => {});
    }

    this.client = this._newClient();
    const password = defer();
    this.login = { step: 'qr', password };
    await this.client.connect();

    this.login.done = this.client.signInUserWithQrCode(
      { apiId: this._apiId(), apiHash: this._apiHash() },
      {
        qrCode: async (code) => {
          const token = Buffer.from(code.token).toString('base64url');
          this.emit('qr', `tg://login?token=${token}`);
        },
        password: async () => {
          this.login.step = 'password';
          this.emit('login', this.status());
          return password.promise;
        },
        onError: (err) => {
          // transient while waiting for the scan: keep going (return false)
          if (process.env.MSN_DEBUG) console.log('[tg] qr error:', err?.message);
          return false;
        },
      }
    )
      .then(async () => { this.login = null; await this._onLoggedIn(); })
      .catch((e) => {
        const msg = e?.message || String(e);
        this.login = null;
        this.emit('login', { ...this.status(), error: msg });
      });

    return this.status();
  }

  submitCode(value) {
    if (!this.login?.code) throw new Error('nenhum login esperando o código');
    this.login.code.resolve(String(value).trim());
    return this.status();
  }

  submitPassword(value) {
    if (!this.login?.password) throw new Error('nenhum login esperando a senha');
    this.login.password.resolve(String(value));
    return this.status();
  }

  async _onLoggedIn() {
    this.state.session = this.client.session.save();
    this._save();
    this.me = await this.client.getMe();
    this._listen();
    this.emit('login', this.status());
    await this.refresh();
  }

  async logout() {
    try { await this.client?.invoke(new (require('telegram').Api.auth.LogOut)()); } catch {}
    try { await this.client?.disconnect(); } catch {}
    this.client = null;
    this.me = null;
    this.entities.clear();
    this.chats = [];
    this.state.session = '';
    this._save();
    this.emit('roster', this.getRoster());
    this.emit('login', this.status());
  }

  // ---- roster ---------------------------------------------------------------

  async refresh() {
    if (!this.client || !this.me) return;
    try {
      const dialogs = await this.client.getDialogs({ limit: 100 });
      const chats = [];
      for (const d of dialogs) {
        const ent = d.entity;
        if (!ent) continue;
        const id = String(d.id?.value ?? d.id);
        this.entities.set(id, ent);
        if (d.message) this.lastMsg.set(JID_PREFIX + id, d.message);
        const isGroup = !!(d.isGroup || d.isChannel);
        const pres = isGroup ? { presence: 'available' } : this._presenceOf(ent, d.message);
        chats.push({
          jid: JID_PREFIX + id,
          source: 'telegram',
          name: d.title || this._entityName(ent) || 'Telegram',
          isGroup,
          unread: d.unreadCount || 0,
          // same online/away/offline rule as WhatsApp, from Telegram's own
          // "last seen": presence + a lastIncoming the renderer ages
          presence: pres.presence,
          lastIncoming: pres.lastIncoming,
          about: '',
          pinned: !!d.pinned,
        });
      }
      // my Telegram contacts I have no conversation with, too
      const listed = new Set(chats.map((c) => c.jid));
      for (const u of await this._contacts()) {
        const id = String(u.id?.value ?? u.id);
        if (listed.has(JID_PREFIX + id) || u.self || u.deleted) continue;
        this.entities.set(id, u);
        const pres = this._presenceOf(u, this.lastMsg.get(JID_PREFIX + id));
        chats.push({ jid: JID_PREFIX + id, source: 'telegram', name: this._entityName(u) || 'Telegram', isGroup: false, unread: 0, presence: pres.presence, lastIncoming: pres.lastIncoming, about: u.username ? `@${u.username}` : '', pinned: false, contactOnly: true });
      }
      this.chats = chats;
      this.emit('roster', this.getRoster());
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] refresh failed:', e?.message);
    }
  }

  /** The account's contact list, fetched again every 10 min (their "last seen" changes). */
  async _contacts() {
    if (this.contactList && Date.now() - this.contactsAt < 10 * 60 * 1000) return this.contactList;
    try {
      const { Api } = require('telegram');
      const r = await this.client.invoke(new Api.contacts.GetContacts({ hash: require('big-integer').zero }));
      if (r.users) { this.contactList = r.users; this.contactsAt = Date.now(); }
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] contacts failed:', e?.message);
    }
    return this.contactList || [];
  }

  // map Telegram's user "last seen" to the same presence the WhatsApp side
  // uses (available = online; otherwise a lastIncoming the UI turns into
  // online/away/offline by how long ago it was)
  _presenceOf(ent, lastMsg) {
    const now = Math.floor(Date.now() / 1000);
    const st = ent?.status;
    const c = st?.className;
    if (c === 'UserStatusOnline') return { presence: 'available', lastIncoming: now };
    if (c === 'UserStatusOffline') return { presence: 'unavailable', lastIncoming: Number(st.wasOnline) || 0 };
    // "recently" (they hide their last seen) says nothing about the time, so
    // it can't mean Away for everybody: like WhatsApp, go by the last
    // message they sent me; none known means Offline
    // (bots and Telegram's own account, which greets me at every login, aren't people)
    const robot = ent?.bot || ent?.support || String(ent?.id?.value ?? ent?.id) === '777000';
    const theirs = !robot && lastMsg && !lastMsg.out && !lastMsg.action ? Number(lastMsg.date) || 0 : 0;
    return { presence: 'unavailable', lastIncoming: theirs };
  }

  /** Someone's status changed (online now / went away): update the list live. */
  _onStatus(userId, status) {
    const jid = JID_PREFIX + userId;
    const chat = this.chats.find((c) => c.jid === jid);
    if (!chat) return;
    const ent = this.entities.get(userId);
    if (ent) ent.status = status;
    const pres = this._presenceOf({ status }, this.lastMsg.get(jid));
    if (chat.presence === pres.presence && chat.lastIncoming === pres.lastIncoming) return;
    Object.assign(chat, pres);
    this.emit('roster', this.getRoster());
  }

  _entityName(ent) {
    if (!ent) return null;
    if (ent.title) return ent.title;
    return [ent.firstName, ent.lastName].filter(Boolean).join(' ') || ent.username || null;
  }

  getRoster() {
    return this.chats;
  }

  /** Unread conversations whose latest message came after `since` (seconds): sent while I was offline. */
  async unreadSince(since) {
    const out = [];
    for (const c of this.chats) {
      const m = this.lastMsg.get(c.jid);
      if (!c.unread || !m || m.out || Number(m.date) <= since) continue;
      const ui = await this._withSender(c.jid, m);
      if (ui.text || ui.media) out.push(ui);
    }
    return out;
  }

  _idOf(jid) {
    return jid.slice(JID_PREFIX.length);
  }

  async _entity(jid) {
    const id = this._idOf(jid);
    if (this.entities.has(id)) return this.entities.get(id);
    const ent = await this.client.getEntity(Number(id));
    this.entities.set(id, ent);
    return ent;
  }

  // ---- messages -------------------------------------------------------------

  // what a media message shows as text (photos/videos aren't downloaded yet)
  _mediaLabel(m) {
    if (!m.media) return '';
    if (m.photo) return '\u{1F4F7} Foto';
    if (m.video || m.gif) return '\u{1F3AC} Vídeo';
    if (m.voice || m.audio) return '\u{1F3B5} Áudio';
    if (m.sticker) return 'Figurinha';
    const name = m.file?.name;
    return name ? `\u{1F4CE} ${name}` : '\u{1F4CE} Arquivo';
  }

  // photos/videos/stickers the chat window shows inline (same shape as WhatsApp)
  _inlineMedia(m) {
    if (m.photo) return 'image';
    if (m.sticker && !/tgs|webm/.test(m.file?.mimeType || '')) return 'sticker';
    if ((m.video || m.gif) && !m.videoNote) return 'video';
    if (m.voice || m.audio) return 'audio';
    return null;
  }

  /** sender: the resolved author (gramjs entity), for group "X diz:". */
  _toUi(jid, m, sender = m.sender) {
    const caption = m.message || '';
    const media = this._inlineMedia(m);
    const label = media ? '' : this._mediaLabel(m);
    const text = media ? caption || (media === 'video' ? '\u{1F3AC} <vídeo>' : media === 'audio' ? '\u{1F3B5} <áudio>' : '\u{1F4F7} <foto>') : caption && label ? `${label}\n${caption}` : caption || label;
    if (media) this.rawMedia.set(`${jid}:${m.id}`, m);
    const name = m.out ? null : (this._entityName(sender) || undefined);
    const ui = {
      id: `${jid}:${m.id}`,
      chatJid: jid,
      fromMe: !!m.out,
      text,
      isNudge: false,
      timestamp: (m.date || 0) * 1000 || (m.out ? Date.now() : 0),
      senderName: name,
      // the group window reads the author from senderNick
      senderNick: name,
      senderJid: sender?.id != null ? `${JID_PREFIX}${String(sender.id?.value ?? sender.id)}` : undefined,
      ...(media ? { media, caption: caption || undefined, duration: (m.video || m.voice || m.audio)?.attributes?.find?.((a) => a.duration)?.duration, gif: !!m.gif || undefined, waveform: this._waveform(m) } : {}),
      quote: this._quoteOf(jid, m),
    };
    // remembered so replies to it can show what they quote
    this.uiById.set(ui.id, ui);
    if (this.uiById.size > 20000) this.uiById.delete(this.uiById.keys().next().value);
    return ui;
  }

  // resolve the author when gramjs didn't attach it (cached, so cheap)
  async _withSender(jid, m) {
    let sender = m.sender;
    if (!sender && !m.out) { try { sender = await m.getSender(); } catch {} }
    return this._toUi(jid, m, sender);
  }

  async getMessages(jid, limit = 40) {
    // window opened while the saved session is still connecting: wait for it
    if (!this.me && this.state.session) await Promise.race([this.ready, new Promise((r) => setTimeout(r, 20000))]);
    if (!this.client) return [];
    try {
      const ent = await this._entity(jid);
      const msgs = await this.client.getMessages(ent, { limit });
      // gramjs returns newest first; the UI wants oldest first
      const list = [...msgs].reverse();
      const ui = await Promise.all(list.map((m) => this._withSender(jid, m)));
      // senders resolve out of order: fill quotes now that the whole page is known
      ui.forEach((u, i) => { if (u.quote) u.quote = this._quoteOf(jid, list[i]); });
      return ui.filter((m) => m.text);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] history failed:', e?.message);
      return [];
    }
  }

  async send(jid, text, quotedId) {
    const ent = await this._entity(jid);
    // a reply: ids are "<chat>:<message id>"
    const replyTo = quotedId ? Number(String(quotedId).split(':').pop()) || undefined : undefined;
    const sent = await this.client.sendMessage(ent, { message: text, replyTo });
    return this._toUi(jid, sent);
  }

  /** The message this one replies to, in the shape the chat window shows. */
  _quoteOf(jid, m) {
    const rid = m.replyTo?.replyToMsgId;
    if (!rid) return null;
    const q = this.uiById.get(`${jid}:${rid}`);
    return {
      id: `${jid}:${rid}`,
      text: q?.text || (q ? '' : 'Mensagem'),
      media: q?.media === 'image' || q?.media === 'video' || q?.media === 'sticker' ? q.media : null,
      caption: q?.caption || null,
      thumb: null,
      fromMe: !!q?.fromMe,
      senderJid: q?.senderJid,
      senderName: q?.fromMe ? null : q?.senderName || null,
    };
  }

  _mediaFile(id, m) {
    const ext = m.photo ? 'jpg' : m.sticker ? 'webp' : m.voice ? 'ogg' : m.audio ? (/mpeg|mp3/.test(m.file?.mimeType || '') ? 'mp3' : /mp4|m4a|aac/.test(m.file?.mimeType || '') ? 'm4a' : 'ogg') : 'mp4';
    return path.join(this.mediaDir, `${String(id).replace(/[^\w-]/g, '')}.${ext}`);
  }

  /** Already-downloaded file for a message id, without downloading. */
  cachedMedia(id) {
    const m = this.rawMedia.get(id);
    if (!m || !this.mediaDir) return null;
    const file = this._mediaFile(id, m);
    return fs.existsSync(file) ? file : null;
  }

  /** Download a photo/video/sticker the window asked for; returns the file path. */
  async getMedia(id) {
    const m = this.rawMedia.get(id);
    if (!m || !this.client || !this.mediaDir) return null;
    const file = this._mediaFile(id, m);
    if (fs.existsSync(file)) return file;
    try {
      const buf = await this.client.downloadMedia(m, {});
      if (!buf?.length) return null;
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(file, buf);
      return file;
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] media download failed:', e?.message);
      return null;
    }
  }

  /** Telegram packs a voice note's waveform as 5-bit values: unpack to 0..255. */
  _waveform(m) {
    const w = m.voice?.attributes?.find?.((a) => a.waveform)?.waveform;
    if (!w?.length) return undefined;
    const out = [];
    const bits = w.length * 8;
    for (let i = 0; i + 5 <= bits && out.length < 100; i += 5) {
      const byte = i >> 3;
      const v = ((w[byte] | ((w[byte + 1] || 0) << 8)) >> (i & 7)) & 31;
      out.push(Math.round((v / 31) * 255));
    }
    return out;
  }

  /** A voice clip (Ogg/Opus) as a Telegram voice message. */
  async sendVoice(jid, ogg, seconds) {
    const { CustomFile } = require('telegram/client/uploads');
    const { Api } = require('telegram');
    const ent = await this._entity(jid);
    const file = new CustomFile('clipe.ogg', ogg.length, '', ogg);
    const sent = await this.client.sendFile(ent, {
      file,
      voiceNote: true,
      attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: seconds })],
    });
    return this._toUi(jid, sent);
  }

  /** Send a picture (pasted/drawn) as a Telegram photo. */
  async sendImage(jid, buffer) {
    const { CustomFile } = require('telegram/client/uploads');
    const ent = await this._entity(jid);
    const file = new CustomFile('imagem.png', buffer.length, '', buffer);
    const sent = await this.client.sendFile(ent, { file });
    return this._toUi(jid, sent);
  }

  /** Send a file from disk; pictures/videos go as media, the rest as document. */
  async sendFile(jid, filePath) {
    const ent = await this._entity(jid);
    const media = /\.(png|jpe?g|gif|webp|mp4|mov|webm)$/i.test(filePath);
    const sent = await this.client.sendFile(ent, { file: filePath, forceDocument: !media });
    return this._toUi(jid, sent);
  }

  /** Participants of a Telegram group/channel, in the member-panel shape. */
  async groupMembers(jid) {
    if (!this.client) return [];
    try {
      const ent = await this._entity(jid);
      const users = await this.client.getParticipants(ent, { limit: 200 });
      const meId = this.me && String(this.me.id?.value ?? this.me.id);
      return users
        .filter((u) => String(u.id?.value ?? u.id) !== meId)
        .map((u) => {
          const name = this._entityName(u) || 'Participante';
          const pres = this._presenceOf(u);
          return { jid: `${JID_PREFIX}${String(u.id?.value ?? u.id)}`, nick: name, title: name, name, lastIncoming: pres.lastIncoming, presence: pres.presence };
        });
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] members failed:', e?.message);
      return [];
    }
  }

  async markRead(jid) {
    try { await this.client?.markAsRead(await this._entity(jid)); } catch {}
  }

  async setTyping(jid, composing) {
    try {
      const { Api } = require('telegram');
      await this.client?.invoke(new Api.messages.SetTyping({
        peer: await this._entity(jid),
        action: composing ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction(),
      }));
    } catch {}
  }

  async avatar(jid) {
    if (!this.client) return null;
    try {
      const buf = await this.client.downloadProfilePhoto(await this._entity(jid), { isBig: false });
      if (!buf || !buf.length) return null;
      return `data:image/jpeg;base64,${Buffer.from(buf).toString('base64')}`;
    } catch {
      return null;
    }
  }

  // ---- live updates ---------------------------------------------------------

  _listen() {
    const { NewMessage } = require('telegram/events');
    const { utils } = require('telegram');
    this.client.addEventHandler(async (event) => {
      const m = event.message;
      if (!m?.peerId) return;
      // the MARKED id (groups negative, channels -100...), same as the
      // dialog ids the roster uses; the raw chatId would open a ghost chat
      let id;
      try { id = String(utils.getPeerId(m.peerId)); } catch { return; }
      const jid = JID_PREFIX + id;
      const ui = await this._withSender(jid, m);
      if (ui.text) this.emit('message', ui);
      // keep unread counts roughly fresh
      this.refresh();
    }, new NewMessage({}));
    // live "online"/"last seen" changes
    const { Raw } = require('telegram/events');
    this.client.addEventHandler((u) => {
      if (u?.className === 'UpdateUserStatus') this._onStatus(String(u.userId?.value ?? u.userId), u.status);
    }, new Raw({}));
  }
}

module.exports = { TelegramService, isTgJid, JID_PREFIX };
