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
      const json = this.safeStorage?.isEncryptionAvailable()
        ? this.safeStorage.decryptString(raw)
        : raw.toString('utf8');
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

  configured() {
    return !!(this.state.apiId && this.state.apiHash);
  }

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
      Number(this.state.apiId),
      String(this.state.apiHash),
      { connectionRetries: 5, deviceModel: 'Ruindows Live Messenger', appVersion: '8.5', useWSS: false }
    );
  }

  /**
   * Resume a saved session on startup, without asking for anything. Resolves
   * true if already logged in, false if a fresh login is needed.
   */
  async resume() {
    if (!this.configured() || !this.state.session) return false;
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
        chats.push({
          jid: JID_PREFIX + id,
          source: 'telegram',
          name: d.title || this._entityName(ent) || 'Telegram',
          isGroup: !!(d.isGroup || d.isChannel),
          unread: d.unreadCount || 0,
          // Telegram doesn't hand out online/offline like MSN; show as online
          presence: 'available',
          about: '',
          pinned: !!d.pinned,
        });
      }
      this.chats = chats;
      this.emit('roster', this.getRoster());
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] refresh failed:', e?.message);
    }
  }

  _entityName(ent) {
    if (!ent) return null;
    if (ent.title) return ent.title;
    return [ent.firstName, ent.lastName].filter(Boolean).join(' ') || ent.username || null;
  }

  getRoster() {
    return this.chats;
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

  _toUi(jid, m) {
    const text = m.message || m.text || '';
    return {
      id: `${jid}:${m.id}`,
      chatJid: jid,
      fromMe: !!m.out,
      text,
      isNudge: false,
      timestamp: (m.date || 0) * 1000 || Date.now(),
      senderName: m.out ? null : (this._entityName(m.sender) || undefined),
    };
  }

  async getMessages(jid, limit = 40) {
    if (!this.client) return [];
    try {
      const ent = await this._entity(jid);
      const msgs = await this.client.getMessages(ent, { limit });
      // gramjs returns newest first; the UI wants oldest first
      return [...msgs].reverse().map((m) => this._toUi(jid, m)).filter((m) => m.text);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[tg] history failed:', e?.message);
      return [];
    }
  }

  async send(jid, text) {
    const ent = await this._entity(jid);
    const sent = await this.client.sendMessage(ent, { message: text });
    return this._toUi(jid, sent);
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
    this.client.addEventHandler((event) => {
      const m = event.message;
      if (!m) return;
      const peer = m.peerId;
      const id = String(peer?.userId?.value ?? peer?.chatId?.value ?? peer?.channelId?.value ?? m.chatId?.value ?? m.chatId ?? '');
      if (!id) return;
      const jid = JID_PREFIX + id;
      const ui = this._toUi(jid, m);
      if (ui.text) this.emit('message', ui);
      // keep unread counts roughly fresh
      this.refresh();
    }, new NewMessage({}));
  }
}

module.exports = { TelegramService, isTgJid, JID_PREFIX };
