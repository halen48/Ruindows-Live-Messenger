'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
