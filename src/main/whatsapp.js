'use strict';

/**
 * WhatsApp service built on Baileys.
 *
 * Owns the socket, auth state and a lightweight in-memory store
 * (chats / contacts / messages) that survives restarts via a JSON
 * snapshot in the Electron userData directory. Emits UI-friendly
 * events consumed by the Electron main process.
 */

const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const pino = require('pino');

const NUDGE_MARKER = '(NUDGE) You have just been sent a nudge!';
const MAX_MESSAGES_PER_CHAT = 200;

class WhatsAppService extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.authDir = path.join(dataDir, 'baileys-auth');
    this.storeFile = path.join(dataDir, 'store.json');
    this.rawMediaFile = path.join(dataDir, 'media-messages.json');
    // what I sent from this app, kept so a contact whose phone couldn't decrypt
    // it ("Aguardando mensagem") can get it re-sent, even after a restart
    this.sentFile = path.join(dataDir, 'sent-messages.json');
    this.mediaDir = path.join(dataDir, 'media');
    this.sock = null;
    this.me = null;
    this.stopped = false;

    // jid -> { jid, name, lastMessage, lastTimestamp, unread }
    this.chats = new Map();
    // jid -> { jid, name }
    this.contacts = new Map();
    // jid -> [ { id, fromMe, text, timestamp, senderName } ]
    this.messages = new Map();
    // jid -> 'available' | 'unavailable' | 'composing' | 'paused'
    this.presence = new Map();
    // anonymous group id (@lid) -> phone jid, learned from contacts/metadata/messages
    this.lidToPn = new Map();
    // jid -> the contact's WhatsApp "about" text, shown as their personal message
    this.abouts = new Map();
    // "group|person" -> the person's member title in that group
    this.memberLabels = new Map();
    // person -> last sign of life that isn't a stored message (reaction, edit, read receipt)
    this.seen = new Map();
    // favorite stickers synced from the phone: sticker id -> media info
    this.favStickers = new Map();
    // message id -> raw WAMessage for photos/stickers, needed to download them
    this.rawMedia = new Map();

    this._saveTimer = null;
    this._loadStore();
  }

  async start() {
    // Baileys is ESM-only; Electron's bundled Node lacks require(esm).
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      makeCacheableSignalKeyStore,
      fetchLatestWaWebVersion,
      fetchLatestBaileysVersion,
      DisconnectReason,
      BufferJSON,
      downloadMediaMessage,
      downloadContentFromMessage,
    } = await import('@whiskeysockets/baileys');
    this._baileys = { BufferJSON, downloadMediaMessage, downloadContentFromMessage };
    this._loadRawMedia();

    fs.mkdirSync(this.authDir, { recursive: true });
    // Archive and pin changes used to be dropped (initial-sync mode), but the
    // app-state version still advanced past them. Forget the versions once
    // so the next connection pulls a full snapshot with every archive/pin.
    const resyncMarker = path.join(this.dataDir, 'appstate-resynced-v4');
    if (!fs.existsSync(resyncMarker)) {
      // v3/v4: pins taken from the stale history snapshot are dropped; the full
      // app-state snapshot below re-sends the real ones
      for (const chat of this.chats.values()) delete chat.pinned;
      for (const f of fs.readdirSync(this.authDir)) {
        if (f.startsWith('app-state-sync-version-')) fs.rmSync(path.join(this.authDir, f), { force: true });
      }
      fs.writeFileSync(resyncMarker, new Date().toISOString());
    }
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // The library's baked-in WA Web version goes stale and gets rejected
    // by the server ("Connection Failure"), so ask WhatsApp itself first.
    let version;
    try {
      ({ version } = await fetchLatestWaWebVersion({}));
    } catch {
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {
        version = undefined; // fall back to the library default
      }
    }

    // Honour corporate/sandbox proxies: ws ignores HTTPS_PROXY, so hand
    // Baileys an explicit agent when one is configured.
    let agent;
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxyUrl) {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      agent = new HttpsProxyAgent(proxyUrl);
    }

    const sock = makeWASocket({
      version,
      // keys cached in memory: the file store alone is slow and racy under
      // bursts of messages, which shows up as "Bad MAC" decrypt failures
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
      // lets Baileys answer a contact's "please resend" with the original
      getMessage: async (key) => this._rawMessage(key),
      agent,
      fetchAgent: agent,
      logger: process.env.MSN_DEBUG ? pino({ level: 'debug' }) : this._syncLogger(),
      browser: ['Ruindows Live Messenger', 'Desktop', '8.5'],
      // Must be true: with false, Baileys skips the history-sync notification
      // entirely ("History sync is disabled by config"), so no chats, contacts
      // or messages are ever delivered and the buddy list stays empty. The
      // initial sync only fires once, at link time — re-pair to backfill an
      // account that was first linked with this off.
      syncFullHistory: true,
      markOnlineOnConnect: true,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (process.env.MSN_DEBUG) {
        console.log('[wa] connection.update', connection || (qr ? 'qr' : ''),
          lastDisconnect?.error?.message || '');
      }
      if (qr) this.emit('qr', qr);
      if (connection === 'open') {
        this.connected = true;
        this.me = {
          jid: this._bareJid(sock.user?.id),
          name: sock.user?.name || 'Me',
          lid: this._bareJid(sock.user?.lid) || null,
        };
        this.emit('open', this.me);
        // History sync gives us chat/contact skeletons but no names: group
        // subjects and saved contact names live elsewhere. Pull them in.
        this._hydrateNames().catch((e) => {
          if (process.env.MSN_DEBUG) console.log('[wa] hydrate failed:', e?.message);
        });
        this._subscribeRecentPresence();
        this._fetchAbouts().catch(() => {});
      }
      if (connection === 'close') {
        if (this.connected) this.lastOnline = Math.floor(Date.now() / 1000);
        this.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (process.env.MSN_DEBUG) {
          console.log('[wa] close statusCode=', statusCode,
            'reason=', Object.keys(DisconnectReason).find((k) => DisconnectReason[k] === statusCode),
            'msg=', lastDisconnect?.error?.message);
        }
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.emit('closed', { loggedOut });
        if (loggedOut) {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.emit('logged-out');
        }
        if (!this.stopped) {
          if (process.env.MSN_DEBUG) console.log('[wa] scheduling reconnect in 3s');
          setTimeout(() => {
            if (process.env.MSN_DEBUG) console.log('[wa] reconnecting now');
            this.start().catch((e) => {
              if (process.env.MSN_DEBUG) console.log('[wa] reconnect failed:', e?.message);
              this.emit('error', e);
            });
          }, 3000);
        }
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, isLatest, syncType, progress }) => {
      if (typeof progress === 'number') this._setSync('history', progress);
      if (process.env.MSN_DEBUG) {
        console.log('[wa] messaging-history.set', {
          chats: (chats || []).length,
          contacts: (contacts || []).length,
          messages: (messages || []).length,
          isLatest,
          syncType,
        });
      }
      for (const c of contacts || []) this._upsertContact(c);
      // history is a snapshot from link time: its pin flags go stale, so pins
      // only come from app-state sync (chats.update)
      for (const c of chats || []) this._upsertChat({ ...c, pinned: undefined });
      for (const m of messages || []) this._storeMessage(m, { silent: true });
      this._emitRoster();
      this._scheduleSave();
      if (progress >= 100) this._setSync('history', null);
    });

    sock.ev.on('contacts.upsert', (contacts) => {
      if (process.env.MSN_DEBUG) console.log('[wa] contacts.upsert', contacts.length);
      for (const c of contacts) this._upsertContact(c);
      this._emitRoster();
    });
    sock.ev.on('contacts.update', (updates) => {
      if (process.env.MSN_DEBUG) console.log('[wa] contacts.update', updates.length);
      for (const c of updates) this._upsertContact(c);
      this._emitRoster();
    });

    sock.ev.on('chats.upsert', (chats) => {
      if (process.env.MSN_DEBUG) console.log('[wa] chats.upsert', chats.length);
      for (const c of chats) this._upsertChat(c);
      this._emitRoster();
    });

    // archive/unarchive (app-state sync) and other chat metadata
    sock.ev.on('chats.update', (updates) => {
      for (const c of updates) this._upsertChat(c);
      this._emitRoster();
      this._scheduleSave();
    });

    // Group subject changes (rename, or metadata arriving late).
    sock.ev.on('groups.update', (updates) => {
      if (process.env.MSN_DEBUG) console.log('[wa] groups.update', updates.length);
      for (const g of updates) {
        if (!g.id || !g.subject) continue;
        this._upsertChat({ id: g.id, name: g.subject });
      }
      this._emitRoster();
      this._scheduleSave();
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      this._diag({ ev: 'upsert', type, n: messages.length });
      if (type !== 'notify' && type !== 'append') return;
      for (const m of messages) {
        try { this._storeMessage(m, { silent: type === 'append' }); }
        catch (e) { this._diag({ ev: 'store-error', err: e?.message }); }
      }
      this._scheduleSave();
    });

    // favorite stickers (surfaced by scripts/patch-baileys.js)
    sock.ev.on('sticker.action', ({ id, action, timestamp }) => {
      if (!id) return;
      if (!action?.isFavorite || action.isLottie || !action.directPath) {
        this.favStickers.delete(id);
      } else {
        this.favStickers.set(id, {
          url: action.url,
          directPath: action.directPath,
          mediaKey: action.mediaKey ? Buffer.from(action.mediaKey).toString('base64') : null,
          mimetype: action.mimetype || 'image/webp',
          at: timestamp || Date.now() / 1000,
        });
      }
      this.emit('stickers');
      this._scheduleSave();
    });

    // someone read my message: in groups per person, in private chats the chat itself
    sock.ev.on('message-receipt.update', (updates) => {
      for (const { receipt } of updates || []) {
        const ts = Number(receipt?.readTimestamp || receipt?.playedTimestamp || 0);
        if (ts) this._sawPerson(this._bareJid(receipt.userJid), ts);
      }
    });
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates || []) {
        const jid = this._bareJid(key?.remoteJid);
        // 4 = READ, 5 = PLAYED, on a message I sent in a private chat
        if (key?.fromMe && jid && !jid.endsWith('@g.us') && update?.status >= 4) this._sawPerson(jid, Date.now() / 1000);
      }
    });

    sock.ev.on('presence.update', ({ id, presences }) => {
      let jid = this._bareJid(id);
      if (jid?.endsWith('@lid')) jid = this._resolvePn(jid) || jid;
      const isGroup = jid?.endsWith('@g.us');
      for (const participant of Object.keys(presences || {})) {
        const p = presences[participant];
        if (!p) continue;
        if (isGroup) {
          // someone typing inside a group: say who, don't mark the group itself
          const who = this._bareJid(participant);
          const pn = this._resolvePn(who);
          const contact = this.contacts.get(pn) || this.contacts.get(who);
          this.emit('presence', {
            jid,
            presence: p.lastKnownPresence,
            participant: pn || who,
            participantName: contact?.notify || contact?.name || (pn ? '+' + pn.replace(/@.*/, '') : null),
          });
          continue;
        }
        this.presence.set(jid, p.lastKnownPresence);
        this.emit('presence', { jid, presence: p.lastKnownPresence });
      }
    });
  }

  async stop() {
    this.stopped = true;
    this._saveStore();
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* already closed */
    }
  }

  // ---- Actions --------------------------------------------------------

  async sendText(jid, text, quotedId) {
    const quoted = quotedId ? this._quotable(jid, quotedId) : undefined;
    const sent = await this.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
    this._rememberSent(sent);
    this._storeMessage(sent, { silent: false });
    this._scheduleSave();
    return this._toUiMessage(sent);
  }

  /** A WAMessage to reply to: the original when we kept it, else rebuilt from the stored text. */
  _quotable(jid, id) {
    const raw = this.rawMedia.get(id);
    if (raw) return raw;
    const mine = this._sent?.get(id);
    const ui = (this.messages.get(jid) || []).find((x) => x.id === id);
    if (!ui && !mine) return undefined;
    const key = { remoteJid: jid, id, fromMe: !!ui?.fromMe || !!mine };
    if (jid.endsWith('@g.us') && !key.fromMe && ui?.senderJid) key.participant = ui.senderJid;
    return { key, message: mine || { conversation: ui.text || '' } };
  }

  async sendNudge(jid) {
    return this.sendText(jid, NUDGE_MARKER);
  }

  async sendImage(jid, buffer) {
    const sent = await this.sock.sendMessage(jid, { image: buffer });
    this._rememberSent(sent);
    this._storeMessage(sent, { silent: false });
    this._scheduleSave();
    return this._toUiMessage(sent);
  }

  async sendFile(jid, filePath) {
    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mimetype =
      {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.zip': 'application/zip',
        '.txt': 'text/plain',
        '.doc': 'application/msword',
      }[ext] || 'application/octet-stream';
    const sent = await this.sock.sendMessage(jid, {
      document: { url: filePath },
      fileName,
      mimetype,
    });
    this._rememberSent(sent);
    this._storeMessage(sent, { silent: false });
    this._scheduleSave();
    return this._toUiMessage(sent);
  }

  async signOut() {
    try {
      await this.sock.logout();
    } catch {
      /* connection already down — wipe locally */
      fs.rmSync(this.authDir, { recursive: true, force: true });
      this.emit('logged-out');
    }
  }

  async setTyping(jid, composing) {
    try {
      await this.sock.sendPresenceUpdate(composing ? 'composing' : 'paused', jid);
    } catch {
      /* not fatal */
    }
  }

  async setMyPresence(state) {
    // 'available' | 'unavailable'
    try {
      await this.sock.sendPresenceUpdate(state);
    } catch {
      /* not fatal */
    }
  }

  async subscribePresence(jid) {
    try {
      await this.sock.presenceSubscribe(jid);
    } catch {
      /* not fatal */
    }
  }

  /** Local file path of a photo/sticker message, downloading it on first use. */
  /**
   * Sticker palette: my WhatsApp favorites, plus the ones recently seen in
   * chats. Each entry: { kind: 'fav'|'recent', id }.
   */
  getStickers() {
    const favorites = [...this.favStickers]
      .filter(([, s]) => s.mediaKey)
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .map(([id]) => ({ kind: 'fav', id }));
    const seenHashes = new Set();
    const recent = [];
    for (const [id, msg] of [...this.rawMedia].reverse()) {
      const st = msg.message?.stickerMessage;
      if (!st || st.isLottie) continue;
      const hash = st.fileSha256 ? Buffer.from(st.fileSha256).toString('base64') : id;
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      recent.push({ kind: 'recent', id });
      if (recent.length >= 40) break;
    }
    return { favorites, recent };
  }

  /** Local file for a palette sticker (downloads favorites on first use). */
  async getStickerFile({ kind, id }) {
    if (kind === 'recent') return this.getMedia(id);
    const st = this.favStickers.get(id);
    if (!st?.mediaKey || !this._baileys) return null;
    const file = path.join(this.mediaDir, `fav-${id.replace(/[^\w-]/g, '').slice(0, 60)}.webp`);
    if (fs.existsSync(file)) return this._used(file);
    try {
      const stream = await this._baileys.downloadContentFromMessage(
        { url: st.url, directPath: st.directPath, mediaKey: Buffer.from(st.mediaKey, 'base64') },
        'sticker'
      );
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(file, Buffer.concat(chunks));
      return file;
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[wa] sticker download failed:', e?.message);
      return null;
    }
  }

  async sendSticker(jid, ref) {
    const file = await this.getStickerFile(ref);
    if (!file) throw new Error('figurinha indisponível');
    const sent = await this.sock.sendMessage(jid, { sticker: fs.readFileSync(file) });
    this._rememberSent(sent);
    this._storeMessage(sent, { silent: false });
    this._scheduleSave();
    return this._toUiMessage(sent);
  }

  /** Bump a cached file's time so the cache trim keeps recently viewed media. */
  _used(file) {
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch {}
    return file;
  }

  /** The already-downloaded file for a message, without downloading. */
  cachedMedia(id) {
    if (!this.mediaDir) return null;
    for (const ext of ['jpg', 'webp', 'mp4']) {
      const file = path.join(this.mediaDir, `${String(id).replace(/[^\w-]/g, '')}.${ext}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  async getMedia(id) {
    const raw = this.rawMedia.get(id);
    if (!raw || !this._baileys) return null;
    let inner = raw.message || {};
    for (const wrap of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2']) {
      if (inner[wrap]?.message) inner = inner[wrap].message;
    }
    const ext = inner.stickerMessage ? 'webp' : inner.videoMessage ? 'mp4' : 'jpg';
    const file = path.join(this.mediaDir, `${id.replace(/[^\w-]/g, '')}.${ext}`);
    if (fs.existsSync(file)) return this._used(file);
    try {
      const buffer = await this._baileys.downloadMediaMessage(raw, 'buffer', {}, {
        logger: pino({ level: 'silent' }),
        reuploadRequest: this.sock.updateMediaMessage,
      });
      fs.mkdirSync(this.mediaDir, { recursive: true });
      fs.writeFileSync(file, buffer);
      return file;
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[wa] media download failed:', e?.message);
      return null;
    }
  }

  /** Group members with their last message time, for the conversation side panel. */
  async getGroupMembers(jid) {
    if (!this._groupMeta) this._groupMeta = new Map();
    let meta = this._groupMeta.get(jid);
    if (!meta) {
      try {
        meta = await this.sock.groupMetadata(jid);
        this._groupMeta.set(jid, meta);
      } catch {
        meta = null;
      }
    }
    // who spoke when, inside this group
    const spoke = new Map();
    for (const m of this.messages.get(jid) || []) {
      if (!m.fromMe && m.senderJid) spoke.set(m.senderJid, Math.max(spoke.get(m.senderJid) || 0, m.timestamp / 1000));
    }
    const ids = meta
      ? meta.participants.map((p) => {
          const aliases = [this._bareJid(p.id), this._bareJid(p.jid), this._bareJid(p.lid)].filter(Boolean);
          const lid = aliases.find((a) => a.endsWith('@lid'));
          if (lid && !aliases.some((a) => a.endsWith('@s.whatsapp.net')) && this.lidToPn.has(lid)) {
            aliases.push(this.lidToPn.get(lid));
          }
          return aliases;
        })
      : [...spoke.keys()].map((id) => [id, this._resolvePn(id)].filter(Boolean));
    const meJid = this.me?.jid;
    return ids
      .filter((aliases) => !aliases.includes(meJid))
      .map((aliases) => {
        const pn = aliases.find((a) => a.endsWith('@s.whatsapp.net'));
        const lastIncoming = Math.max(
          0,
          ...aliases.map((a) => spoke.get(a) || 0),
          ...aliases.map((a) => this._lastIncoming(a))
        );
        const nick = aliases.map((a) => this.contacts.get(a)?.notify || this.contacts.get(a)?.name).find(Boolean);
        return {
          jid: pn || aliases[0],
          nick: nick || null,
          title: this._memberLabel(jid, ...aliases),
          name: nick || (pn ? '+' + pn.replace(/@.*/, '') : 'Participante'),
          lastIncoming: lastIncoming || null,
          presence: this.presence.get(pn) || 'unavailable',
          ...this.busyInfo(pn),
        };
      })
      .sort((a, b) => (b.lastIncoming || 0) - (a.lastIncoming || 0) || a.name.localeCompare(b.name));
  }

  /** Fetch (once) a group's participants so @lid senders can be mapped to phones. */
  async ensureGroupMeta(jid) {
    if (!jid.endsWith('@g.us') || this._groupMeta?.has(jid) || !this.sock) return;
    if (!this._groupMeta) this._groupMeta = new Map();
    this._traceGroupNode(jid);
    try {
      const meta = await this.sock.groupMetadata(jid);
      this._groupMeta.set(jid, meta);
      for (const p of meta.participants || []) {
        const aliases = [p.id, p.jid, p.lid].map((a) => this._bareJid(a)).filter(Boolean);
        const pn = aliases.find((a) => a.endsWith('@s.whatsapp.net'));
        const lid = aliases.find((a) => a.endsWith('@lid'));
        if (pn && lid) this.lidToPn.set(lid, pn);
      }
      this._scheduleSave();
    } catch {
      /* not a member anymore, or offline */
    }
  }

  /**
   * Baileys' log is silent, but app-state sync (pins, archive) can fail
   * quietly. Keep only sync-related lines in wa-data/sync.log.
   */
  _syncLogger() {
    const file = path.join(this.dataDir, 'sync.log');
    try { if (fs.statSync(file).size > 2e6) fs.rmSync(file); } catch {}
    const stream = {
      write: (line) => {
        // also: connection/buffer state and any error (keys only, never message text)
        if (!/app.?state|syncd|resync|sync state|snapshot|patch|regular|critical|mutation|key.*(missing|not found|find)|AwaitingInitialSync|Online|buffer|decrypt|"level":(50|60)/i.test(line)) return;
        try { fs.appendFileSync(file, line); } catch {}
      },
    };
    return pino({ level: 'info' }, stream);
  }

  /** Pull everyone's "about" text in small batches, once per connection. */
  async _fetchAbouts() {
    const jids = [...this.chats.keys()].filter((j) => j.endsWith('@s.whatsapp.net') && j !== this.me?.jid);
    for (let i = 0; i < jids.length; i += 50) {
      if (this.stopped || !this.sock) return;
      try {
        const list = (await this.sock.fetchStatus(...jids.slice(i, i + 50))) || [];
        for (const r of list) {
          const jid = this._bareJid(r.id);
          const text = typeof r.status?.status === 'string' ? r.status.status.trim() : '';
          if (jid) text ? this.abouts.set(jid, text) : this.abouts.delete(jid);
        }
        this._emitRoster();
        this._scheduleSave();
      } catch (e) {
        if (process.env.MSN_DEBUG) console.log('[wa] fetchStatus failed:', e?.message);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** Group member titles ride along on messages (contextInfo) or come as a change notice. */
  _learnMemberLabel(groupJid, msg) {
    let content = msg.message || {};
    for (const wrap of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
      if (content[wrap]?.message) content = content[wrap].message;
    }
    let label = content.protocolMessage?.memberLabel;
    if (!label) {
      for (const part of Object.values(content)) {
        if (part && typeof part === 'object' && part.contextInfo?.memberLabel) { label = part.contextInfo.memberLabel; break; }
      }
    }
    if (!label) return;
    const raw = this._bareJid(msg.key.participantPn) || this._bareJid(msg.key.participant || msg.participant);
    const who = this._resolvePn(raw) || raw;
    if (!who) return;
    const key = `${groupJid}|${who}`;
    const text = (label.label || '').trim();
    if (text) this.memberLabels.set(key, text);
    else this.memberLabels.delete(key);
  }

  /**
   * Temporary probe: group member titles don't show up where Baileys' proto
   * says, so note any raw message/participant data mentioning a label in
   * wa-data/labels-debug.jsonl to find where WhatsApp actually puts them.
   */
  _traceLabel(kind, data) {
    try {
      const text = JSON.stringify(data, (k, v) => (v?.type === 'Buffer' || ArrayBuffer.isView(v) ? '<bin>' : v));
      if (!/label/i.test(text)) return;
      fs.appendFileSync(path.join(this.dataDir, 'labels-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, data: JSON.parse(text) }) + '\n');
    } catch {
      /* best effort */
    }
  }

  /** Probe: envelope attributes of live group messages (first 40 only). */
  _traceStanza(jid, msg) {
    if (!msg.stanzaInfo) return;
    this._stanzaTraced = (this._stanzaTraced || 0) + 1;
    if (this._stanzaTraced > 40) return;
    try {
      fs.appendFileSync(path.join(this.dataDir, 'stanza-debug.jsonl'), JSON.stringify({
        at: new Date().toISOString(), jid, fromMe: !!msg.key.fromMe, pushName: msg.pushName || null, stanza: msg.stanzaInfo,
      }) + '\n');
    } catch {
      /* best effort */
    }
  }

  /** Raw group query, to see every attribute WhatsApp sends per participant. */
  async _traceGroupNode(jid) {
    try {
      const node = await this.sock.query({
        tag: 'iq',
        attrs: { type: 'get', xmlns: 'w:g2', to: jid },
        content: [{ tag: 'query', attrs: { request: 'interactive' } }],
      });
      const group = node.content?.find?.((c) => c.tag === 'group');
      const participants = (group?.content || []).filter((c) => c.tag === 'participant');
      const odd = participants.filter((p) => Object.keys(p.attrs).some((k) => !['jid', 'type', 'lid', 'phone_number', 'error'].includes(k)) || p.content);
      fs.appendFileSync(path.join(this.dataDir, 'labels-debug.jsonl'), JSON.stringify({
        at: new Date().toISOString(),
        kind: 'group-node',
        jid,
        attrKeys: [...new Set(participants.flatMap((p) => Object.keys(p.attrs)))],
        groupChildren: [...new Set((group?.content || []).map((c) => c.tag))],
        sample: odd.slice(0, 5).map((p) => ({ attrs: p.attrs, content: p.content && String(JSON.stringify(p.content)).slice(0, 400) })),
      }) + '\n');
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[wa] group node trace failed:', e?.message);
    }
  }

  _memberLabel(groupJid, ...people) {
    for (const p of people) {
      if (!p) continue;
      const hit = this.memberLabels.get(`${groupJid}|${p}`) || this.memberLabels.get(`${groupJid}|${this._resolvePn(p)}`);
      if (hit) return hit;
    }
    return null;
  }

  // my last sent messages, so a contact whose phone failed to decrypt one
  // ("Bad MAC") can get it re-sent instead of "waiting for this message"
  _rememberSent(sent) {
    if (!sent?.key?.id || !sent.message) return;
    if (!this._sent) this._sent = new Map();
    this._sent.set(sent.key.id, sent.message);
    while (this._sent.size > 1000) this._sent.delete(this._sent.keys().next().value);
    this._scheduleSave();
  }

  _rawMessage(key) {
    return this._sent?.get(key.id) || this.rawMedia?.get(key.id)?.message || undefined;
  }

  _resolvePn(jid) {
    if (!jid) return null;
    if (jid.endsWith('@s.whatsapp.net')) return jid;
    return this.lidToPn.get(jid) || null;
  }

  /**
   * Seconds timestamp of the last thing this person said anywhere: their
   * private chat or any group. For a group jid, the group's last message.
   */
  /**
   * What the "Ocupado" rule needs about a person: their about text, and in
   * our private chat, when I last wrote and when they last wrote back.
   */
  busyInfo(jid) {
    if (!jid || jid.endsWith('@g.us')) return {};
    const chat = this.chats.get(jid);
    let lastOutgoing = chat?.lastOutgoing || 0;
    let directIncoming = chat?.lastIncoming || 0;
    if (!lastOutgoing || !directIncoming) {
      for (const m of this.messages.get(jid) || []) {
        const ts = m.timestamp / 1000;
        if (m.fromMe) lastOutgoing = Math.max(lastOutgoing, ts);
        else directIncoming = Math.max(directIncoming, ts);
      }
    }
    return {
      about: this.abouts.get(jid) || null,
      lastOutgoing: lastOutgoing || null,
      directIncoming: directIncoming || null,
    };
  }

  _lastIncoming(jid) {
    if (jid?.endsWith('@g.us')) {
      const list = this.messages.get(jid) || [];
      for (let i = list.length - 1; i >= 0; i--) if (!list[i].fromMe) return list[i].timestamp / 1000;
      return this.chats.get(jid)?.lastIncoming || 0;
    }
    const activity = this._activityMap();
    let best = Math.max(this.chats.get(jid)?.lastIncoming || 0, activity.get(jid) || 0);
    // the same person may have spoken in groups under their anonymous @lid id
    for (const [lid, pn] of this.lidToPn) if (pn === jid) best = Math.max(best, activity.get(lid) || 0);
    return best;
  }

  /** person jid (phone or @lid) -> last time they sent a message anywhere. */
  _activityMap() {
    if (this._activity) return this._activity;
    this._activity = new Map(this.seen);
    for (const [chatJid, list] of this.messages) {
      for (const m of list) if (!m.fromMe) this._bumpActivity(m, chatJid);
    }
    return this._activity;
  }

  /** Someone reacted, edited or read my message: they're around. */
  _sawPerson(jid, tsSeconds) {
    const who = this._resolvePn(jid) || jid;
    if (!who || who === this.me?.jid || who === this.me?.lid || who.endsWith('@g.us')) return;
    const ts = Math.min(tsSeconds || Date.now() / 1000, Date.now() / 1000);
    if (ts <= (this.seen.get(who) || 0)) return;
    this.seen.set(who, ts);
    if (this._activity && ts > (this._activity.get(who) || 0)) this._activity.set(who, ts);
    this._emitRoster();
    this._scheduleSave();
  }

  _bumpActivity(m, chatJid) {
    const who = chatJid.endsWith('@g.us') ? m.senderPn || this._resolvePn(m.senderJid) || m.senderJid : chatJid;
    if (!who) return;
    const ts = m.timestamp / 1000;
    if (ts > (this._activity.get(who) || 0)) this._activity.set(who, ts);
  }

  async getAvatar(jid) {
    if (!this._avatars) this._avatars = new Map();
    if (this._avatars.has(jid)) return this._avatars.get(jid);
    let url = null;
    try {
      url = await this.sock.profilePictureUrl(jid, 'image');
    } catch {
      /* no picture / privacy settings */
    }
    this._avatars.set(jid, url);
    return url;
  }

  async markRead(jid) {
    const chat = this.chats.get(jid);
    if (chat) chat.unread = 0;
    this._emitRoster();
  }

  getRoster() {
    const list = [...this.chats.values()]
      .filter((c) => c.jid.endsWith('@s.whatsapp.net') || c.jid.endsWith('@g.us') || this._lidName(c.jid))
      .map((c) => ({
        ...c,
        name: c.jid.endsWith('@lid') ? this._lidName(c.jid) : this.displayName(c.jid),
        presence: this.presence.get(c.jid) || 'unavailable',
        isGroup: c.jid.endsWith('@g.us'),
        lastIncoming: this._lastIncoming(c.jid) || null,
        ...this.busyInfo(c.jid),
      }))
      .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
    // everyone in my address book, not only people I've talked to: the ones
    // without a conversation land in Online/Offline like any other contact
    const listed = new Set(list.map((c) => c.jid));
    for (const c of this.contacts.values()) {
      if (!c.name || !c.jid?.endsWith('@s.whatsapp.net') || listed.has(c.jid) || c.jid === this.me?.jid) continue;
      list.push({ jid: c.jid, name: c.name, unread: 0, isGroup: false, presence: this.presence.get(c.jid) || 'unavailable', lastIncoming: null, contactOnly: true });
    }
    // "message yourself" chat, always listed so I can write to myself
    if (this.me?.jid) {
      const own = list.find((c) => c.jid === this.me.jid);
      if (own) own.isMe = true;
      else list.unshift({ jid: this.me.jid, name: this.me.name, isMe: true, isGroup: false, unread: 0, presence: 'available' });
    }
    return { me: this.me, chats: list };
  }

  getMessages(jid) {
    const list = this.messages.get(jid) || [];
    if (!jid.endsWith('@g.us')) return list;
    // older builds stored the group's name as the sender; resolve the person instead
    const groupName = this.displayName(jid);
    return list.map((m) => {
      if (m.fromMe) return m;
      const pn = m.senderPn || this._resolvePn(m.senderJid);
      // the person's own WhatsApp name (their "nick"), never the group's name
      const contact = this.contacts.get(pn) || this.contacts.get(m.senderJid);
      let nick = m.pushName || contact?.notify || contact?.name || null;
      if (!nick && m.senderName && m.senderName !== groupName && !/^\+?\d+$/.test(m.senderName)) nick = m.senderName;
      if (nick === groupName) nick = null;
      return { ...m, senderPn: pn, senderNick: nick, senderTitle: this._memberLabel(jid, pn, m.senderJid) };
    });
  }

  _senderName(senderJid, fallback) {
    const name = this.contacts.get(senderJid)?.name;
    if (name) return name;
    if (fallback && fallback !== senderJid.replace(/@.*/, '')) return fallback;
    return senderJid.endsWith('@lid') ? fallback || 'Participante' : senderJid.replace(/@.*/, '');
  }

  /**
   * WhatsApp only pushes online/offline for contacts we've subscribed to,
   * so ask for the most recent individual chats (staggered, not a flood).
   */
  _subscribeRecentPresence() {
    const recent = this.getRoster().chats.filter((c) => !c.isGroup && !c.archived).slice(0, 40);
    recent.forEach((c, i) => setTimeout(() => this.subscribePresence(c.jid), 2000 + i * 400));
  }

  /**
   * A chat known only by its anonymous @lid id: use a saved/notify name or
   * the name the person sent with their messages. Bare ids are hidden.
   */
  _lidName(jid) {
    if (!jid.endsWith('@lid')) return null;
    const named = this.displayName(jid);
    if (named && !/^\d+$/.test(named)) return named;
    const list = this.messages.get(jid) || [];
    for (let i = list.length - 1; i >= 0; i--) if (!list[i].fromMe && list[i].pushName) return list[i].pushName;
    return null;
  }

  displayName(jid) {
    const contact = this.contacts.get(jid);
    const chat = this.chats.get(jid);
    return (
      contact?.name ||
      chat?.name ||
      (jid || '').replace(/@.*/, '')
    );
  }

  // ---- Internals ------------------------------------------------------

  /**
   * Backfill display names the history sync omits:
   *  - group subjects via a single groupFetchAllParticipating() call
   *  - saved contact names via an app-state resync (emits contacts.update)
   * pushName from live/historical messages covers the rest opportunistically.
   */
  async _hydrateNames() {
    this._setSync('names', 0);
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      let named = 0;
      for (const meta of Object.values(groups || {})) {
        if (!meta?.id || !meta.subject) continue;
        this._upsertChat({ id: meta.id, name: meta.subject });
        named++;
      }
      if (process.env.MSN_DEBUG) console.log('[wa] group subjects hydrated:', named);
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[wa] groupFetchAllParticipating failed:', e?.message);
    }

    try {
      await this.sock.resyncAppState(
        ['critical_unblock_low', 'regular_high', 'regular_low', 'regular'],
        // must be false: in "initial sync" mode Baileys holds archive updates
        // until the matching chat shows up in a history batch, which never
        // happens after the first link, so archived chats never arrived
        false
      );
      if (process.env.MSN_DEBUG) console.log('[wa] app-state resync requested');
    } catch (e) {
      if (process.env.MSN_DEBUG) console.log('[wa] resyncAppState failed:', e?.message);
    }

    this._emitRoster();
    this._scheduleSave();
    this._setSync('names', null);
  }

  /**
   * Sync progress for the buddy list's progress bar. Two jobs can run at
   * once: the first-link history download (with a %), and the contact/group
   * name refresh on every connect (no %). null clears a job.
   */
  _setSync(job, progress) {
    if (!this._sync) this._sync = {};
    if (progress == null) delete this._sync[job];
    else this._sync[job] = progress;
    this.emit('sync', this.getSync());
  }

  getSync() {
    const s = this._sync || {};
    if ('history' in s) return { label: 'Sincronizando conversas...', progress: s.history };
    if ('names' in s) return { label: 'Atualizando contatos e grupos...', progress: null };
    return null;
  }

  _bareJid(jid) {
    if (!jid) return jid;
    return jid.replace(/:\d+(?=@)/, '');
  }

  _upsertContact(c) {
    const jid = this._bareJid(c.id);
    if (!jid) return;
    const existing = this.contacts.get(jid) || { jid };
    existing.name = c.name || c.notify || c.verifiedName || existing.name;
    if (c.notify) existing.notify = c.notify;
    const pn = [jid, this._bareJid(c.jid)].find((a) => a?.endsWith('@s.whatsapp.net'));
    const lid = [jid, this._bareJid(c.lid)].find((a) => a?.endsWith('@lid'));
    if (pn && lid) this.lidToPn.set(lid, pn);
    this.contacts.set(jid, existing);
    // group messages often come from the anonymous @lid id; index both ways
    for (const alias of [c.lid, c.jid]) {
      const a = this._bareJid(alias);
      if (a && a !== jid && existing.name) this.contacts.set(a, { jid: a, name: existing.name });
    }
  }

  _upsertChat(c) {
    const jid = this._canonChat(this._bareJid(c.id));
    if (!jid || jid === 'status@broadcast') return;
    const existing = this.chats.get(jid) || { jid, unread: 0 };
    if (c.name) existing.name = c.name;
    if (c.conversationTimestamp) {
      existing.lastTimestamp = Number(c.conversationTimestamp);
    }
    if (typeof c.unreadCount === 'number') existing.unread = c.unreadCount;
    if (typeof c.archived === 'boolean') existing.archived = c.archived;
    // pinned: pin timestamp while pinned, 0/null when unpinned
    if (c.pinned !== undefined) existing.pinned = Number(c.pinned) || null;
    this.chats.set(jid, existing);
  }

  _extractText(msg) {
    const m = msg.message;
    if (!m) return null;
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      (m.imageMessage && '\u{1F4F7} <foto>') ||
      (m.videoMessage && '\u{1F3AC} <video>') ||
      (m.audioMessage && '\u{1F3B5} <voice message>') ||
      (m.stickerMessage && '<figurinha>') ||
      (m.documentMessage && `\u{1F4CE} <file: ${m.documentMessage.fileName || 'document'}>`) ||
      null
    );
  }

  _toUiMessage(msg) {
    const jid = this._bareJid(msg.key.remoteJid);
    const text = this._extractText(msg);
    const isGroup = jid?.endsWith('@g.us');
    const senderJid = msg.key.fromMe
      ? this.me?.jid
      : this._bareJid(
          msg.key.participantPn || msg.key.participant || msg.participant || (isGroup ? null : msg.key.remoteJid)
        );
    let m = msg.message || {};
    for (const wrap of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
      if (m[wrap]?.message) m = m[wrap].message;
    }
    const media = m.imageMessage ? 'image' : m.stickerMessage ? 'sticker' : m.videoMessage ? 'video' : null;
    const thumb = m.videoMessage?.jpegThumbnail;
    return {
      id: msg.key.id,
      chatJid: this._canonChat(jid),
      fromMe: !!msg.key.fromMe,
      text,
      isNudge: text === NUDGE_MARKER,
      timestamp: Number(msg.messageTimestamp) * 1000 || Date.now(),
      senderJid,
      senderPn: msg.key.fromMe ? null : this._resolvePn(this._bareJid(msg.key.participantPn) || senderJid),
      pushName: msg.key.fromMe ? null : msg.pushName || null,
      media,
      // captions stay as text; bare photos/stickers show only the picture
      caption: m.imageMessage?.caption || m.videoMessage?.caption || null,
      // tiny still WhatsApp embeds in every video, shown before downloading it
      thumb: thumb && thumb.length ? `data:image/jpeg;base64,${Buffer.from(thumb).toString('base64')}` : null,
      duration: m.videoMessage?.seconds || null,
      quote: this._quoteOf(m, jid),
      senderName: msg.key.fromMe
        ? this.me?.name || 'Eu'
        : senderJid
          ? this._senderName(senderJid, msg.pushName)
          : msg.pushName || 'Participante',
    };
  }

  /** The message this one replies to, if any: { id, text, senderName, fromMe }. */
  _quoteOf(m, chatJid) {
    let ctx = null;
    for (const part of Object.values(m)) {
      if (part && typeof part === 'object' && part.contextInfo?.quotedMessage) { ctx = part.contextInfo; break; }
    }
    if (!ctx) return null;
    const text = this._extractText({ message: ctx.quotedMessage });
    const raw = this._bareJid(ctx.participant) || (chatJid.endsWith('@g.us') ? null : chatJid);
    const fromMe = !!raw && (raw === this.me?.jid || raw === this.me?.lid);
    const pn = this._resolvePn(raw);
    const contact = this.contacts.get(pn) || this.contacts.get(raw);
    let qm = ctx.quotedMessage;
    for (const wrap of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
      if (qm[wrap]?.message) qm = qm[wrap].message;
    }
    const media = qm.imageMessage ? 'image' : qm.stickerMessage ? 'sticker' : qm.videoMessage ? 'video' : null;
    // the small preview WhatsApp embeds in the quote itself
    const thumb = (qm.imageMessage || qm.videoMessage)?.jpegThumbnail;
    return {
      id: ctx.stanzaId || null,
      text: text || '',
      media,
      caption: qm.imageMessage?.caption || qm.videoMessage?.caption || null,
      thumb: thumb && thumb.length ? `data:image/jpeg;base64,${Buffer.from(thumb).toString('base64')}` : null,
      fromMe,
      senderJid: pn || raw,
      senderName: fromMe ? null : contact?.notify || contact?.name || (pn ? '+' + pn.replace(/@.*/, '') : 'Participante'),
    };
  }

  /** A reaction (or its removal) on one of the stored messages. */
  _applyReaction(chatJid, msg, reaction, sender) {
    const fromMe = !!msg.key.fromMe;
    const ts = Number(reaction.senderTimestampMs) / 1000 || Number(msg.messageTimestamp) || Date.now() / 1000;
    if (!fromMe) this._sawPerson(sender, ts);
    const target = (this.messages.get(chatJid) || []).find((m) => m.id === reaction.key?.id);
    if (!target) return;
    const who = fromMe ? 'me' : this._resolvePn(sender) || sender || 'alguem';
    const reactions = { ...(target.reactions || {}) };
    if (reaction.text) {
      const contact = this.contacts.get(who) || this.contacts.get(sender);
      reactions[who] = { emoji: reaction.text, name: fromMe ? null : msg.pushName || contact?.notify || contact?.name || null, fromMe };
    } else {
      delete reactions[who];
    }
    target.reactions = reactions;
    this.emit('reaction', { chatJid, id: target.id, reactions });
    this._scheduleSave();
  }

  _applyEdit(chatJid, id, text) {
    if (!id || text == null) return;
    const target = (this.messages.get(chatJid) || []).find((m) => m.id === id);
    if (!target) return;
    target.text = text;
    if (target.caption) target.caption = text;
    target.edited = true;
    this.emit('message-updated', target);
    this._scheduleSave();
  }

  /**
   * Ask the phone again for a chat's latest messages, once per session, so
   * replies (quotes) and video previews stored before the app knew about
   * them get filled in. Answers arrive as an on-demand history set.
   */
  refetchRecent(jid) {
    if (!this.sock || !jid) return;
    if (!this._refetched) this._refetched = new Set();
    if (this._refetched.has(jid)) return;
    this._refetched.add(jid);
    const list = this.messages.get(jid) || [];
    const newest = list[list.length - 1];
    if (!newest) return;
    const key = { remoteJid: jid, id: newest.id, fromMe: !!newest.fromMe };
    if (jid.endsWith('@g.us') && !newest.fromMe && newest.senderJid) key.participant = newest.senderJid;
    this.sock.fetchMessageHistory(50, key, Math.floor(newest.timestamp / 1000)).catch((e) => {
      if (process.env.MSN_DEBUG) console.log('[wa] refetch failed:', e?.message);
    });
  }

  _storeMessage(msg, { silent }) {
    const remote = this._bareJid(msg.key.remoteJid);
    // a private chat addressed by lid can carry the phone number alongside
    const remotePn = this._bareJid(msg.key.remoteJidAlt || msg.key.senderPn);
    if (remote?.endsWith('@lid') && remotePn?.endsWith('@s.whatsapp.net')) this.lidToPn.set(remote, remotePn);
    const jid = this._canonChat(remote);
    if (!jid || jid === 'status@broadcast') { if (!jid) this._diag({ ev: 'no-chat', remote: String(remote).replace(/^[^@]*/, '*') }); return; }
    const lid = this._bareJid(msg.key.participant);
    const pnAlias = this._bareJid(msg.key.participantPn);
    if (lid?.endsWith('@lid') && pnAlias?.endsWith('@s.whatsapp.net')) this.lidToPn.set(lid, pnAlias);
    if (jid.endsWith('@g.us')) {
      if (!msg.key.fromMe) this._learnMemberLabel(jid, msg);
      this._traceLabel('message', msg);
      this._traceStanza(jid, msg);
    }
    let inner = msg.message || {};
    for (const wrap of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2']) {
      if (inner[wrap]?.message) inner = inner[wrap].message;
    }
    const senderOf = () => this._bareJid(msg.key.participantPn || msg.key.participant || msg.participant) || (jid.endsWith('@g.us') ? null : jid);
    if (inner.reactionMessage) {
      this._applyReaction(jid, msg, inner.reactionMessage, senderOf());
      return;
    }
    const edited = inner.protocolMessage?.type === 14 ? inner.protocolMessage : inner.editedMessage?.message?.protocolMessage;
    if (edited?.editedMessage) {
      this._applyEdit(jid, edited.key?.id, this._extractText({ message: edited.editedMessage }));
      if (!msg.key.fromMe) this._sawPerson(senderOf(), Number(msg.messageTimestamp));
      return;
    }

    const ui = this._toUiMessage(msg);
    // WhatsApp couldn't hand over the keys yet ("Waiting for this message"):
    // show a placeholder; the real message replaces it when it's re-sent
    if (ui.text == null && msg.messageStubType === 2 && !msg.key.fromMe) {
      this._logDecrypt(jid, msg);
      ui.text = '⏳ Esperando esta mensagem. O WhatsApp vai reenviar (abrir o WhatsApp no celular ajuda).';
      ui.pending = true;
    }
    if (ui.text == null) {
      this._diag({ ev: 'dropped', fromMe: !!msg.key.fromMe, stub: msg.messageStubType || 0, kinds: Object.keys(inner).join(',') });
      return;
    }
    if (!ui.fromMe) this._diag({ ev: 'stored', silent: !!silent, group: jid.endsWith('@g.us') });
    // a message sent while I was offline: it pops its window like a new one
    const offline = !ui.fromMe && silent && this.prevOnline && ui.timestamp / 1000 > this.prevOnline;

    if (!msg.key.fromMe && msg.pushName) {
      const senderJid = this._bareJid(msg.key.participant || msg.key.remoteJid);
      if (!this.contacts.get(senderJid)?.name) {
        this.contacts.set(senderJid, { jid: senderJid, name: msg.pushName });
      }
    }

    if (ui.media) {
      this.rawMedia.set(ui.id, msg);
      if (this.rawMedia.size > 600) this.rawMedia.delete(this.rawMedia.keys().next().value);
    }

    const list = this.messages.get(jid) || [];
    const existing = list.find((m) => m.id === ui.id);
    if (existing?.pending && !ui.pending) {
      // the re-sent copy arrived: swap the placeholder for the real thing
      for (const k of Object.keys(existing)) delete existing[k];
      Object.assign(existing, ui);
      this.emit('message-updated', existing);
      const chat = this.chats.get(jid);
      if (chat) { chat.lastMessage = ui.text; this._emitRoster(); }
      this._scheduleSave();
      return;
    }
    if (existing) {
      // re-fetched history: fill in what older versions of the app didn't keep
      let changed = false;
      for (const k of ['quote', 'thumb', 'media', 'caption', 'duration', 'pushName', 'senderPn']) {
        if (ui[k] && !existing[k]) { existing[k] = ui[k]; changed = true; }
      }
      if (changed) { this.emit('message-updated', existing); this._scheduleSave(); }
      return;
    }
    list.push(ui);
    list.sort((a, b) => a.timestamp - b.timestamp);
    if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
    this.messages.set(jid, list);

    const chat = this.chats.get(jid) || { jid, unread: 0 };
    chat.lastMessage = ui.text;
    chat.lastTimestamp = ui.timestamp / 1000;
    if ((!silent || offline) && !ui.fromMe) chat.unread = (chat.unread || 0) + 1;
    if (ui.fromMe && !jid.endsWith('@g.us')) chat.lastOutgoing = Math.max(chat.lastOutgoing || 0, ui.timestamp / 1000);
    if (!ui.fromMe) {
      if (!jid.endsWith('@g.us')) chat.lastIncoming = Math.max(chat.lastIncoming || 0, ui.timestamp / 1000);
      if (this._activity) this._bumpActivity(ui, jid);
    }
    this.chats.set(jid, chat);

    if (!silent) this.emit('message', ui);
    else if (offline) this.emit('offline-message', ui);
    this._emitRoster();
  }

  /** What happens to incoming messages, without any content, in wa-data/incoming.log. */
  _diag(o) {
    try {
      const file = path.join(this.dataDir, 'incoming.log');
      if (!this._diagChecked) { this._diagChecked = true; try { if (fs.statSync(file).size > 1e6) fs.rmSync(file); } catch {} }
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toTimeString().slice(0, 8), ...o }) + '\n');
    } catch {}
  }

  /** Why a message couldn't be decrypted (no content), in wa-data/decrypt.log. */
  _logDecrypt(jid, msg) {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), chat: jid.endsWith('@g.us') ? 'grupo' : jid.endsWith('@lid') ? 'lid' : 'pn', err: msg.messageStubParameters?.[0] || '?' });
      fs.appendFileSync(path.join(this.dataDir, 'decrypt.log'), line + '\n');
    } catch {}
  }

  _emitRoster() {
    if (this._rosterQueued) return;
    this._rosterQueued = true;
    // batch bursts (history sync, busy groups) into one update
    setTimeout(() => {
      this._rosterQueued = false;
      if (this._mergeLidChats()) this._scheduleSave();
      this.emit('roster', this.getRoster());
    }, 300);
  }

  _loadStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      this.chats = new Map(raw.chats || []);
      this.contacts = new Map(raw.contacts || []);
      this.messages = new Map(raw.messages || []);
      this.lidToPn = new Map(raw.lidToPn || []);
      this.abouts = new Map(raw.abouts || []);
      this.memberLabels = new Map(raw.memberLabels || []);
      this.seen = new Map(raw.seen || []);
      this.favStickers = new Map(raw.favStickers || []);
      // the end of the previous session: anything newer that comes in while
      // the app catches up was sent to me while I was offline
      // (older stores don't have it: the newest saved message is close enough)
      this.lastOnline = Number(raw.lastOnline) || Math.floor(Math.max(0, ...[...this.messages.values()].flat().map((m) => m.timestamp || 0)) / 1000);
      this.prevOnline = this.lastOnline;
    } catch {
      /* first run */
    }
    this._mergeLidChats();
  }

  /** Private chats addressed by anonymous @lid go under the person's phone jid. */
  _canonChat(jid) {
    return jid?.endsWith('@lid') ? this.lidToPn.get(jid) || jid : jid;
  }

  /**
   * WhatsApp now keys many private chats (and their pins/archives) by @lid.
   * Fold every @lid chat whose phone number we know into the phone chat, so
   * one person is one row, with their pin, archive, unread and messages.
   */
  _mergeLidChats() {
    let merged = 0;
    for (const [lid, chat] of [...this.chats]) {
      if (!lid.endsWith('@lid')) continue;
      const pn = this.lidToPn.get(lid);
      if (!pn) continue;
      const into = this.chats.get(pn) || { jid: pn, unread: 0 };
      into.unread = (into.unread || 0) + (chat.unread || 0);
      if ((chat.lastTimestamp || 0) > (into.lastTimestamp || 0)) {
        into.lastTimestamp = chat.lastTimestamp;
        if (chat.lastMessage) into.lastMessage = chat.lastMessage;
      }
      into.lastIncoming = Math.max(into.lastIncoming || 0, chat.lastIncoming || 0) || into.lastIncoming;
      // app-state (pins, archive) now arrives keyed by lid, so it is the fresher source
      if (typeof chat.archived === 'boolean') into.archived = chat.archived;
      if (chat.pinned !== undefined) into.pinned = chat.pinned || null;
      if (!into.name && chat.name) into.name = chat.name;
      this.chats.set(pn, into);
      this.chats.delete(lid);
      const lidMsgs = this.messages.get(lid);
      if (lidMsgs) {
        const all = [...(this.messages.get(pn) || []), ...lidMsgs.map((m) => ({ ...m, chatJid: pn }))];
        const seen = new Set();
        const list = all.filter((m) => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => a.timestamp - b.timestamp);
        if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
        this.messages.set(pn, list);
        this.messages.delete(lid);
      }
      merged++;
    }
    if (merged) this._activity = null;
    return merged;
  }

  _loadRawMedia() {
    try {
      const sent = JSON.parse(fs.readFileSync(this.sentFile, 'utf8'), this._baileys.BufferJSON.reviver);
      this._sent = new Map(sent);
    } catch {
      /* nothing sent yet */
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.rawMediaFile, 'utf8'), this._baileys.BufferJSON.reviver);
      for (const [id, msg] of raw) if (!this.rawMedia.has(id)) this.rawMedia.set(id, msg);
    } catch {
      /* first run */
    }
  }

  _saveStore() {
    try {
      if (this._baileys) {
        fs.mkdirSync(this.dataDir, { recursive: true });
        fs.writeFileSync(this.rawMediaFile, JSON.stringify([...this.rawMedia], this._baileys.BufferJSON.replacer));
        if (this._sent) fs.writeFileSync(this.sentFile, JSON.stringify([...this._sent], this._baileys.BufferJSON.replacer));
      }
    } catch {
      /* non-fatal */
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.storeFile,
        JSON.stringify({
          chats: [...this.chats],
          contacts: [...this.contacts],
          messages: [...this.messages],
          lidToPn: [...this.lidToPn],
          abouts: [...this.abouts],
          memberLabels: [...this.memberLabels],
          seen: [...this.seen],
          favStickers: [...this.favStickers],
          lastOnline: this.connected ? Math.floor(Date.now() / 1000) : this.lastOnline || 0,
        })
      );
    } catch {
      /* non-fatal */
    }
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveStore(), 2000);
  }
}

module.exports = { WhatsAppService, NUDGE_MARKER };
