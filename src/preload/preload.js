'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Wraps a main -> renderer channel as a subscribe function that hands back an
 * unsubscribe, so the renderer never touches ipcRenderer or a raw channel name.
 */
const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

/**
 * The entire surface the renderer is given. Deliberately narrow: no generic
 * send, no channel names, no Node. Everything the UI can do is enumerated here.
 */
contextBridge.exposeInMainWorld('flowcus', {
  bootstrap: () => ipcRenderer.invoke('flowcus:bootstrap'),

  /** Timer verbs: start, pause, resume, stop, start-break, dismiss-alarm, ... */
  action: (type, payload) => ipcRenderer.send('flowcus:action', { type, payload }),

  saveSettings: (settings) => ipcRenderer.invoke('flowcus:save-settings', settings),
  requestStats: () => ipcRenderer.invoke('flowcus:stats'),
  requestAnalytics: () => ipcRenderer.invoke('flowcus:analytics'),

  /** Resolves the global total minutes studied (opt-in aggregate), or null when unconfigured. */
  globalStats: () => ipcRenderer.invoke('flowcus:global-stats'),

  /** Window verbs: minimize, close, toggle-mini, exit-mini. */
  window: (action) => ipcRenderer.invoke('flowcus:window', action),

  /** Resolves false if the URL is not a plain http(s) link. */
  openReward: (url) => ipcRenderer.invoke('flowcus:open-reward', url),

  /**
   * Study rooms. The renderer is only a transport here: it opens WebRTC data
   * channels and moves opaque strings; main verifies, decides and signs.
   */
  room: {
    get: () => ipcRenderer.invoke('flowcus:room-get'),
    create: (name) => ipcRenderer.invoke('flowcus:room-create', name),
    makeInvite: (name, sdp) => ipcRenderer.invoke('flowcus:room-make-invite', { name, sdp }),
    openInvite: (text) => ipcRenderer.invoke('flowcus:room-open-invite', text),
    makeReply: (sdp) => ipcRenderer.invoke('flowcus:room-make-reply', sdp),
    openReply: (text) => ipcRenderer.invoke('flowcus:room-open-reply', text),
    approve: (key) => ipcRenderer.invoke('flowcus:room-approve', key),
    deny: (key) => ipcRenderer.invoke('flowcus:room-deny', key),
    chat: (text) => ipcRenderer.invoke('flowcus:room-chat', text),
    leave: () => ipcRenderer.invoke('flowcus:room-leave'),
    relayOut: (to, kind, sdp) => ipcRenderer.invoke('flowcus:room-relay-out', { to, kind, sdp }),
    getTurn: () => ipcRenderer.invoke('flowcus:room-turn-get'),
    setTurn: (turn) => ipcRenderer.invoke('flowcus:room-turn-set', turn),

    channelOpen: (channelId, mode, peerKey) =>
      ipcRenderer.send('flowcus:room-channel-open', { channelId, mode, peerKey }),
    channelClosed: (channelId) => ipcRenderer.send('flowcus:room-channel-closed', channelId),
    data: (channelId, data) => ipcRenderer.send('flowcus:room-data', { channelId, data }),

    onSend: listen('flowcus:room-send'),
    onClose: listen('flowcus:room-close'),
    onRelayConnect: listen('flowcus:room-relay-connect'),
    onRelaySignal: listen('flowcus:room-relay-signal'),
    onState: listen('flowcus:room-state'),
  },

  onState: listen('flowcus:state'),
  onMini: listen('flowcus:mini'),
  onAlarm: listen('flowcus:alarm'),
  onChime: listen('flowcus:chime'),
  /** The clean tone that marks the end of a Wall Method baseline. */
  onTone: listen('flowcus:tone'),
  onSettings: listen('flowcus:settings'),
  onStats: listen('flowcus:stats'),
});
