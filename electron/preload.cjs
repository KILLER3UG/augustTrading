// Preload script for Electron — bridges renderer and main process securely.
// With contextIsolation: true, the renderer cannot access Node.js directly.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Expose a safe, minimal API to the renderer for auto-update control.
 * The renderer calls these via window.electronAPI.*
 */
contextBridge.exposeInMainWorld('electronAPI', {
    // App info
    getVersion: () => ipcRenderer.invoke('app:get-version'),

    // Desktop file store — the big stores' destination (electron/storeFs.cjs).
    // Every call RESOLVES to {ok,...}; a failure is data, not a rejection.
    store: {
        read: (key) => ipcRenderer.invoke('store:read', key),
        write: (key, value) => ipcRenderer.invoke('store:write', key, value),
        remove: (key) => ipcRenderer.invoke('store:remove', key),
        location: () => ipcRenderer.invoke('store:location'),
        list: (prefix) => ipcRenderer.invoke('store:list', prefix),
    },
    isElectron: true,
    platform: process.platform,

    // Repo bridge — source read/edit/apply, DEV ONLY (AUGUSTTRADING_REPO).
    // Every path is sandboxed in main; the renderer never sees fs or a shell.
    repo: {
        info: () => ipcRenderer.invoke('repo:info'),
        list: (rel) => ipcRenderer.invoke('repo:list', rel),
        read: (rel) => ipcRenderer.invoke('repo:read', rel),
        write: (rel, content) => ipcRenderer.invoke('repo:write', rel, content),
        apply: () => ipcRenderer.invoke('repo:apply'),
        setup: () => ipcRenderer.invoke('repo:setup'),
    },

    // Auto-update
    checkForUpdates: () => ipcRenderer.invoke('update:check'),
    downloadUpdate: () => ipcRenderer.invoke('update:download'),
    installUpdate: () => ipcRenderer.invoke('update:install'),
    // Fired by the restart-animation overlay once it has played: main then
    // runs quitAndInstall (with its own fallback timeout).
    quitNow: () => ipcRenderer.send('update:quit-now'),
    getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),

    // Secret encryption (OS keychain via safeStorage) — used by
    // ProviderConfigService to encrypt API keys at rest on desktop.
    encryptSecret: (plaintext) => ipcRenderer.invoke('crypto:encrypt', plaintext),
    decryptSecret: (payload) => ipcRenderer.invoke('crypto:decrypt', payload),

    // Provider requests run in the Electron main process so APIs that do not
    // expose browser CORS headers can still be used by the desktop app.
    providerChat: (request) => ipcRenderer.invoke('provider:chat', request),
    cancelProviderChat: (requestId) => ipcRenderer.invoke('provider:cancel', requestId),
    discoverModels: (config) => ipcRenderer.invoke('provider:discover', config),

    // Live streaming deltas for a providerChat call that set stream:true.
    // Payload: { requestId, type: 'text' | 'reasoning', delta }. The
    // providerChat promise still resolves with the accumulated final result;
    // these events only drive the realtime paint.
    onProviderChunk: (callback) => {
        const handler = (_event, chunk) => callback(chunk);
        ipcRenderer.on('provider:chunk', handler);
        return () => ipcRenderer.removeListener('provider:chunk', handler);
    },

    // Listen for real-time status updates pushed from main process
    onUpdateStatus: (callback) => {
        const handler = (_event, status) => callback(status);
        ipcRenderer.on('update-status', handler);
        // Return an unsubscribe function
        return () => ipcRenderer.removeListener('update-status', handler);
    },
});
