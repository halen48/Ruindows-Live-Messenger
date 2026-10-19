'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

function on(channel) {
  return (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('msn', {
  originalAssets: () => ipcRenderer.invoke('assets:original'),
  getRoster: () => ipcRenderer.invoke('wa:getRoster'),
  getMessages: (jid) => ipcRenderer.invoke('wa:getMessages', jid),
  send: (jid, text, quotedId) => ipcRenderer.invoke('wa:send', { jid, text, quotedId }),
  nudge: (jid) => ipcRenderer.invoke('wa:nudge', jid),
  typing: (jid, composing) => ipcRenderer.invoke('wa:typing', { jid, composing }),
  setPresence: (state) => ipcRenderer.invoke('wa:setPresence', state),
  avatar: (jid) => ipcRenderer.invoke('wa:avatar', jid),
  cachedMyDp: () => ipcRenderer.invoke('ui:cachedMyDp'),
  markRead: (jid) => ipcRenderer.invoke('wa:markRead', jid),
  media: (id) => ipcRenderer.invoke('wa:media', id),
  groupMembers: (jid) => ipcRenderer.invoke('wa:groupMembers', jid),
  getStatus: () => ipcRenderer.invoke('ui:getStatus'),
  statusSync: () => ipcRenderer.sendSync('ui:statusSync'),
  getSync: () => ipcRenderer.invoke('wa:getSync'),
  setStatus: (status) => ipcRenderer.send('ui:setStatus', status),
  stickers: () => ipcRenderer.invoke('wa:stickers'),
  stickerFile: (ref) => ipcRenderer.invoke('wa:stickerFile', ref),
  sendSticker: (jid, ref) => ipcRenderer.invoke('wa:sendSticker', { jid, ref }),
  systemFonts: () => ipcRenderer.invoke('ui:systemFonts'),
  aiProviders: () => ipcRenderer.invoke('ai:providers'),
  aiRoster: () => ipcRenderer.invoke('ai:roster'),
  aiSetEnabled: (ids) => ipcRenderer.invoke('ai:setEnabled', ids),
  aiLogin: (id) => ipcRenderer.invoke('ai:login', id),
  aiRefresh: () => ipcRenderer.invoke('ai:refresh'),
  aiImportFirefox: () => ipcRenderer.invoke('ai:importFirefox'),
  aiGoogleInFirefox: () => ipcRenderer.invoke('ai:googleInFirefox'),
  onAiFirefoxLogin: (cb) => ipcRenderer.on('ai:firefoxLogin', (_e, r) => cb(r)),
  // Telegram login + lifecycle
  tgStatus: () => ipcRenderer.invoke('tg:status'),
  tgStartLogin: (opts) => ipcRenderer.invoke('tg:startLogin', opts),
  tgStartQrLogin: (opts) => ipcRenderer.invoke('tg:startQrLogin', opts),
  tgSubmitCode: (code) => ipcRenderer.invoke('tg:submitCode', code),
  tgSubmitPassword: (pw) => ipcRenderer.invoke('tg:submitPassword', pw),
  tgLogout: () => ipcRenderer.invoke('tg:logout'),
  igStatus: () => ipcRenderer.invoke('ig:status'),
  igLogin: () => ipcRenderer.invoke('ig:login'),
  igLogout: () => ipcRenderer.invoke('ig:logout'),
  igStartChat: (user) => ipcRenderer.invoke('ig:startChat', user),
  igLinkPreview: (url) => ipcRenderer.invoke('ig:linkPreview', url),
  igThumb: (id) => ipcRenderer.invoke('ig:thumb', id),
  themeGet: () => ipcRenderer.sendSync('ui:themeGet'),
  themeChoice: () => ipcRenderer.invoke('ui:themeChoice'),
  setTheme: (choice) => ipcRenderer.send('ui:setTheme', choice),
  onTheme: on('ui:theme'),
  getMediaOptions: () => ipcRenderer.invoke('ui:getMediaOptions'),
  setMediaOptions: (opts) => ipcRenderer.invoke('ui:setMediaOptions', opts),
  clearMedia: () => ipcRenderer.invoke('ui:clearMedia'),
  mediaCached: (id) => ipcRenderer.invoke('wa:mediaCached', id),
  getOption: (key) => ipcRenderer.invoke('ui:getOption', key),
  setOption: (key, value) => ipcRenderer.send('ui:setOption', { key, value }),
  profileGet: () => ipcRenderer.sendSync('ui:profileGet'),
  profileSet: (profile) => ipcRenderer.send('ui:profileSet', profile),

  sendImage: (jid, dataUrl) => ipcRenderer.invoke('wa:sendImage', { jid, dataUrl }),
  sendFile: (jid) => ipcRenderer.invoke('wa:sendFile', jid),
  sendBlob: (jid, name, dataUrl) => ipcRenderer.invoke('wa:sendBlob', { jid, name, dataUrl }),
  signOut: () => ipcRenderer.invoke('wa:signOut'),

  openChat: (jid) => ipcRenderer.send('ui:openChat', jid),
  toastClick: (jid) => ipcRenderer.send('ui:toastClick', jid),
  minimize: () => ipcRenderer.send('ui:minimize'),
  maximize: () => ipcRenderer.send('ui:maximize'),
  close: () => ipcRenderer.send('ui:close'),
  openExternal: (url) => ipcRenderer.send('ui:openExternal', url),

  onQr: on('wa:qr'),
  onOpen: on('wa:open'),
  onClosed: on('wa:closed'),
  onRoster: on('wa:roster'),
  onPresence: on('wa:presence'),
  onMessage: on('wa:message'),
  onStatus: on('ui:status'),
  onProfile: on('ui:profile'),
  onReaction: on('wa:reaction'),
  onStickers: on('wa:stickers'),
  onAiRoster: on('ai:roster'),
  onTgLogin: on('tg:login'),
  onIgLogin: on('ig:login'),
  onTgQr: on('tg:qr'),
  aiGroups: () => ipcRenderer.invoke('ai:groups'),
  aiGroupCreate: (opts) => ipcRenderer.invoke('ai:groupCreate', opts),
  aiGroupUpdate: (jid, patch) => ipcRenderer.invoke('ai:groupUpdate', { jid, patch }),
  aiGroupDelete: (jid) => ipcRenderer.invoke('ai:groupDelete', jid),
  aiGroupContinue: (jid) => ipcRenderer.invoke('ai:groupContinue', jid),
  onAiGroups: on('ai:groups'),
  onMediaOptions: on('ui:mediaOptions'),
  onMessageUpdated: on('wa:messageUpdated'),
  onSync: on('wa:sync'),
});


// --- UI zoom: Ctrl+scroll and Ctrl + / - / 0 (not an MSN thing, but handy on
// hi-dpi screens). Works in every window since both load this preload. The
// factor is remembered per window kind in localStorage.
(function setupZoom() {
  const KEY = 'uiZoom';
  const clamp = (z) => Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
  const read = () => { try { return parseFloat(localStorage.getItem(KEY)) || 1; } catch { return 1; } };
  const apply = (z) => {
    z = clamp(z);
    try { webFrame.setZoomFactor(z); } catch {}
    try { localStorage.setItem(KEY, String(z)); } catch {}
    return z;
  };
  window.addEventListener('DOMContentLoaded', () => apply(read()));
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); apply(webFrame.getZoomFactor() + 0.1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); apply(webFrame.getZoomFactor() - 0.1); }
    else if (e.key === '0') { e.preventDefault(); apply(1); }
  });
  window.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    apply(webFrame.getZoomFactor() + (e.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });
})();
