'use strict';

/**
 * Demo service: same surface as WhatsAppService but backed by canned
 * data. Enabled with MSN_DEMO=1 so the UI can be previewed (and
 * screenshotted) without linking a real WhatsApp account.
 */

const EventEmitter = require('events');
const { NUDGE_MARKER } = require('./whatsapp');

function createDemoService() {
  const wa = new EventEmitter();
  const now = Date.now();

  wa.me = { jid: 'me@s.whatsapp.net', name: 'Craig (M)' };
  wa.presence = new Map([
    ['david@s.whatsapp.net', 'available'],
    ['fair@s.whatsapp.net', 'available'],
  ]);

  const chats = [
    { jid: 'me@s.whatsapp.net', name: 'Craig (M)', isMe: true, unread: 0 },
    { jid: 'david@s.whatsapp.net', name: 'Dave', pinned: 2, about: 'nunca mais volto pro discado (H)', lastMessage: 'brb tea :)', lastTimestamp: now / 1000 - 60, unread: 1 },
    { jid: 'fair@s.whatsapp.net', name: 'Charlotte', pinned: 1, about: 'Disponível', lastMessage: 'From where…', lastTimestamp: now / 1000 - 400, unread: 0 },
    { jid: 'jonathan@s.whatsapp.net', name: 'Jonny', about: 'trabalhando, só urgências', lastMessage: 'see you at 8', lastTimestamp: now / 1000 - 4000, unread: 0 },
    { jid: 'michael@s.whatsapp.net', name: 'Liam Doherty', lastMessage: 'Thank god for revision…', lastTimestamp: now / 1000 - 9000, unread: 0 },
    { jid: 'wojciech@s.whatsapp.net', name: 'Rhys Pritchard', lastMessage: '∫ maths dx', lastTimestamp: now / 1000 - 20000, unread: 0 },
    { jid: 'alexis@s.whatsapp.net', name: 'beckyxo_MSN 7.5', lastMessage: null, lastTimestamp: now / 1000 - 90000, unread: 0 },
    { jid: 'frex@s.whatsapp.net', name: 'gaz1990', lastMessage: null, lastTimestamp: now / 1000 - 100000, unread: 0 },
    { jid: 'crew@g.us', name: 'The Lads 2004', lastMessage: 'lan party saturday??', lastTimestamp: now / 1000 - 600, unread: 3 },
    { jid: 'old@s.whatsapp.net', name: 'Tia Neide', lastMessage: 'bom dia (F)', lastTimestamp: now / 1000 - 200000, unread: 0, archived: true },
  ];

  const messages = new Map([
    ['david@s.whatsapp.net', [
      { id: 'd1', chatJid: 'david@s.whatsapp.net', fromMe: false, text: 'hey!! you got broadband now or still 56k? :P', isNudge: false, timestamp: now - 340000, senderName: 'Dave' },
      { id: 'd2', chatJid: 'david@s.whatsapp.net', fromMe: true, text: '*1mb cable* mate, downloads FLY \u{1F60E}', isNudge: false, timestamp: now - 300000, senderName: 'Craig (M)' },
      { id: 'd3', chatJid: 'david@s.whatsapp.net', fromMe: false, text: NUDGE_MARKER, isNudge: true, timestamp: now - 250000, senderName: 'Dave' },
      { id: 'd4', chatJid: 'david@s.whatsapp.net', fromMe: false, text: 'brb tea :)', isNudge: false, timestamp: now - 60000, senderName: 'Dave' },
    ]],
    ['crew@g.us', [
      { id: 'g1', chatJid: 'crew@g.us', fromMe: false, text: 'lan party saturday??', reactions: { a: { emoji: '👍', name: 'Jonny' }, b: { emoji: '👍', name: 'Liam' }, me: { emoji: '😂', fromMe: true } }, isNudge: false, timestamp: now - 600000, senderName: 'Dave', senderJid: 'david@s.whatsapp.net', senderPn: '5511900000001@s.whatsapp.net', senderNick: 'Dave', senderTitle: 'Dono da LAN' },
      { id: 'g2', chatJid: 'crew@g.us', fromMe: false, text: 'only if someone brings the CS 1.6 cd (B)', isNudge: false, timestamp: now - 500000, senderName: 'Jonny', senderJid: 'jonathan@s.whatsapp.net', senderPn: '5521900000002@s.whatsapp.net', senderNick: null, quote: { id: 'g1', text: 'lan party saturday??', fromMe: false, senderName: 'Dave' } },
      { id: 'g3', chatJid: 'crew@g.us', fromMe: false, text: '\u{1F3AC} <video>', media: 'video', thumb: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAA2AGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjqKKK9g4AooooAKKKKACiiun8D6HBq2pSz3aLJBaBT5ZP3mJOMjuODx9OozWGIrxoUnVnsi6cHOSijOs/C2t39uLi309zG33WdlTcMZyNxGRz16VU1DSr7SphFfWrwMfuluVbp0I4PUdK9rqpqemWur2L2d5HujbkEfeQ9mB7H/PSvmqef1PafvIrl8tz0ZYGPL7r1PFKKmu7Z7O8mtZCpeCRo2K9CQcHH5VDX1aaaujy3oFFFFMAooooAKKKKACuu+HuqQWepT2c7KhuwvluxxllJwv47j+WO9cjRXPiaEcRRlSl1LpzdOakj3aobq6gsbWS5uZVihjGWdu3+fSvNLPx7rdpbiFjBc7ejzoS2MYxkEZ+p596ztZ8R6jrrKLuVREp3LDGMIpxjPqfxJ6nFfLU8irupabSj3PTljYct47lO/uvtuoXN3s2efK0m3OduSTjP41Xoor7CKUUkjyW7u5b+wf9NP8Ax2j7B/00/wDHauUV4X1yv/N+CM7sp/YP+mn/AI7R9g/6af8AjtXKKPrlf+b8EF2U/sH/AE0/8do+wf8ATT/x2rlFH1yv/N+CC7Kf2D/pp/47R9g/6af+O1coo+uV/wCb8EF2U/sH/TT/AMdo+wf9NP8Ax2rlFH1yv/N+CC7Kf2D/AKaf+O0fYP8App/47Vyij65X/m/BBdhRRRXKIKKKKACiiigAooooAKKKKACiiigD/9k=', duration: 42, isNudge: false, timestamp: now - 400000, senderName: 'Dave', senderJid: 'david@s.whatsapp.net', senderPn: '5511900000001@s.whatsapp.net', senderNick: 'Dave', senderTitle: 'Dono da LAN' },
      { id: 'g4', chatJid: 'crew@g.us', fromMe: true, text: 'kkkkk o sol de 2004', isNudge: false, timestamp: now - 100000, senderName: 'Craig', quote: { id: 'g3', text: '', media: 'video', thumb: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAA2AGADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjqKKK9g4AooooAKKKKACiiun8D6HBq2pSz3aLJBaBT5ZP3mJOMjuODx9OozWGIrxoUnVnsi6cHOSijOs/C2t39uLi309zG33WdlTcMZyNxGRz16VU1DSr7SphFfWrwMfuluVbp0I4PUdK9rqpqemWur2L2d5HujbkEfeQ9mB7H/PSvmqef1PafvIrl8tz0ZYGPL7r1PFKKmu7Z7O8mtZCpeCRo2K9CQcHH5VDX1aaaujy3oFFFFMAooooAKKKKACuu+HuqQWepT2c7KhuwvluxxllJwv47j+WO9cjRXPiaEcRRlSl1LpzdOakj3aobq6gsbWS5uZVihjGWdu3+fSvNLPx7rdpbiFjBc7ejzoS2MYxkEZ+p596ztZ8R6jrrKLuVREp3LDGMIpxjPqfxJ6nFfLU8irupabSj3PTljYct47lO/uvtuoXN3s2efK0m3OduSTjP41Xoor7CKUUkjyW7u5b+wf9NP8Ax2j7B/00/wDHauUV4X1yv/N+CM7sp/YP+mn/AI7R9g/6af8AjtXKKPrlf+b8EF2U/sH/AE0/8do+wf8ATT/x2rlFH1yv/N+CC7Kf2D/pp/47R9g/6af+O1coo+uV/wCb8EF2U/sH/TT/AMdo+wf9NP8Ax2rlFH1yv/N+CC7Kf2D/AKaf+O0fYP8App/47Vyij65X/m/BBdhRRRXKIKKKKACiiigAooooAKKKKACiiigD/9k=', fromMe: false, senderName: 'Dave' } },
      { id: 'g5', chatJid: 'crew@g.us', fromMe: false, text: '\u{1F3B5} <áudio>', media: 'audio', duration: 7, waveform: [20, 60, 140, 200, 120, 90, 180, 240, 160, 80, 40, 100, 190, 230, 150, 70, 30, 90, 170, 210, 130, 60, 110, 200, 250, 180, 90, 40, 80, 160, 220, 140, 70, 30, 60, 150, 210, 170, 100, 50, 90, 180, 230, 160, 80, 40, 20, 10], isNudge: false, timestamp: now - 50000, senderName: 'Dave', senderJid: 'david@s.whatsapp.net', senderPn: '5511900000001@s.whatsapp.net', senderNick: 'Dave', senderTitle: 'Dono da LAN' },
    ]],
  ]);

  wa.getRoster = () => ({
    me: wa.me,
    chats: chats.map((c) => ({
      ...c,
      presence: wa.presence.get(c.jid) || 'unavailable',
      isGroup: c.jid.endsWith('@g.us'),
      lastIncoming: c.lastIncoming ?? (c.lastMessage ? c.lastTimestamp : null),
    })),
  });
  wa.getMessages = (jid) => messages.get(jid) || [];
  wa.getStickers = () => ({ favorites: [], recent: [] });
  wa.displayName = (jid) => chats.find((c) => c.jid === jid)?.name || jid.replace(/@.*/, '');
  wa.getAvatar = async () => null;
  // voice clips: sent ones are kept in temp files; MSN_DEMO_AUDIO plays for the sample one
  const demoFiles = new Map();
  wa.getMedia = async (id) => demoFiles.get(id) || (id === 'g5' ? process.env.MSN_DEMO_AUDIO || null : null);
  wa.sendVoice = async (jid, ogg, seconds) => {
    const id = 'v' + Math.random().toString(36).slice(2);
    const file = require('path').join(require('os').tmpdir(), `whatsmsn-demo-${id}.ogg`);
    require('fs').writeFileSync(file, ogg);
    demoFiles.set(id, file);
    const msg = { id, chatJid: jid, fromMe: true, text: '', media: 'audio', duration: seconds, isNudge: false, timestamp: Date.now(), senderName: wa.me.name };
    (messages.get(jid) || messages.set(jid, []).get(jid)).push(msg);
    return msg;
  };
  wa.getSync = () => (process.env.MSN_SHOT_DIR ? { label: 'Sincronizando conversas...', progress: 42 } : null);
  wa.getGroupMembers = async () => [
    { jid: '5511900000001@s.whatsapp.net', nick: 'Dave', title: 'Dono da LAN', name: 'Dave', lastIncoming: now / 1000 - 60, presence: 'unavailable' },
    { jid: '5521900000002@s.whatsapp.net', nick: null, name: 'Jonny', lastIncoming: now / 1000 - 5000, presence: 'unavailable' },
    { jid: 'michael@s.whatsapp.net', name: 'Liam Doherty', lastIncoming: null, presence: 'unavailable' },
    { jid: 'wojciech@s.whatsapp.net', name: 'Rhys Pritchard', lastIncoming: null, presence: 'unavailable' },
  ];
  wa.subscribePresence = async () => {};
  wa.markRead = async (jid) => {
    const c = chats.find((x) => x.jid === jid);
    if (c) c.unread = 0;
  };
  wa.setTyping = async () => {};
  wa.setMyPresence = async () => {};
  wa.stop = async () => {};

  wa.sendText = async (jid, text) => {
    const msg = {
      id: 'm' + Math.random().toString(36).slice(2),
      chatJid: jid,
      fromMe: true,
      text,
      isNudge: text === NUDGE_MARKER,
      timestamp: Date.now(),
      senderName: wa.me.name,
    };
    (messages.get(jid) || messages.set(jid, []).get(jid)).push(msg);
    // echo a canned reply so the conversation feels alive
    setTimeout(() => {
      const reply = {
        id: 'r' + Math.random().toString(36).slice(2),
        chatJid: jid,
        fromMe: false,
        text: msg.isNudge ? NUDGE_MARKER : 'lol nice one (Y)',
        isNudge: msg.isNudge,
        timestamp: Date.now(),
        senderName: wa.displayName(jid),
      };
      messages.get(jid).push(reply);
      wa.emit('message', reply);
    }, 1500);
    return msg;
  };
  wa.sendNudge = (jid) => wa.sendText(jid, NUDGE_MARKER);
  wa.sendImage = (jid) => wa.sendText(jid, '\u{1F4F7} <picture>');
  wa.sendFile = (jid, filePath) =>
    wa.sendText(jid, `\u{1F4CE} <file: ${filePath.split(/[\\/]/).pop()}>`);
  wa.signOut = async () => wa.emit('logged-out');

  wa.start = async () => {
    // show the sign-in screen with a sample QR briefly, then "sign in"
    setTimeout(() => wa.emit('qr', 'demo-mode-sample-qr-code-not-a-real-whatsapp-token'), 300);
    const openAt = process.env.MSN_SHOT_DIR ? 4500 : 1500;
    setTimeout(() => wa.emit('open', wa.me), openAt);
    // Jonathan pops online then drops away, exercising the (Away) state
    setTimeout(() => wa.emit('presence', { jid: 'jonathan@s.whatsapp.net', presence: 'available' }), openAt + 200);
    setTimeout(() => wa.emit('presence', { jid: 'jonathan@s.whatsapp.net', presence: 'unavailable' }), openAt + 400);
    // an unsolicited message so the toast notification path fires
    setTimeout(() => {
      const msg = {
        id: 'toast1',
        chatJid: 'fair@s.whatsapp.net',
        fromMe: false,
        text: 'you seen the new Busted video?? (8)',
        isNudge: false,
        timestamp: Date.now(),
        senderName: 'Charlotte',
      };
      (messages.get(msg.chatJid) || messages.set(msg.chatJid, []).get(msg.chatJid)).push(msg);
      wa.emit('message', msg);
    }, openAt + 2500);
  };

  return wa;
}

module.exports = { createDemoService };
