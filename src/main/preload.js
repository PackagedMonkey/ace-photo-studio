const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, handler) {
  const wrapped = (_event, payload) => {
    handler(payload);
  };

  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('aceApi', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickOutputFolder: () => ipcRenderer.invoke('pick-output-folder'),
  pickSaveFile: (defaultName) => ipcRenderer.invoke('pick-save-file', { defaultName }),
  saveDataUrl: (payload) => ipcRenderer.invoke('save-data-url', payload),
  getPathForFile: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      return path || null;
    } catch {
      return null;
    }
  },

  checkRawPipeline: () => ipcRenderer.invoke('check-raw-pipeline'),
  normalizePaths: (paths) => ipcRenderer.invoke('normalize-paths', paths),
  loadCleanupPresets: () => ipcRenderer.invoke('load-cleanup-presets'),
  saveCleanupPreset: (preset) => ipcRenderer.invoke('save-cleanup-preset', { preset }),
  deleteCleanupPreset: (name) => ipcRenderer.invoke('delete-cleanup-preset', { name }),

  importHdrFolder: (payload) => ipcRenderer.invoke('hdr-import-folder', payload),
  detectHdrGroups: (payload) => ipcRenderer.invoke('detect-hdr-groups', payload),
  startBatchHdrMerge: (payload) => ipcRenderer.invoke('start-batch-hdr-merge', payload),
  retryFailedSets: (payload) => ipcRenderer.invoke('retry-failed-sets', payload),
  getMergeQueueProgress: () => ipcRenderer.invoke('get-merge-queue-progress'),
  getHdrDiagnostics: () => ipcRenderer.invoke('get-hdr-diagnostics'),
  cancelBatchHdrMerge: () => ipcRenderer.invoke('cancel-merge'),
  openMergedTiffsInLibrary: (results) => ipcRenderer.invoke('open-merged-tiffs-in-library', { results }),
  exportEditedJpegs: (payload) => ipcRenderer.invoke('export-edited-jpegs', payload),
  openPathInFinder: (targetPath) => ipcRenderer.invoke('open-path-in-finder', { targetPath }),

  onHdrQueueUpdate: (handler) => subscribe('hdr-queue-update', handler),

  onMenuAddPhotos: (handler) => subscribe('menu-add-photos', handler),
  onMenuAddFolder: (handler) => subscribe('menu-add-folder', handler),
  onMenuAddHdrFolder: (handler) => subscribe('menu-add-hdr-folder', handler),
  onMenuStartHdrMerge: (handler) => subscribe('menu-start-hdr-merge', handler),
  onMenuCancelHdrMerge: (handler) => subscribe('menu-cancel-hdr-merge', handler),
  onMenuRetryFailedSets: (handler) => subscribe('menu-retry-failed-sets', handler),
  onMenuPreviewZoomIn: (handler) => subscribe('menu-preview-zoom-in', handler),
  onMenuPreviewZoomOut: (handler) => subscribe('menu-preview-zoom-out', handler),
  onMenuPreviewFit: (handler) => subscribe('menu-preview-fit', handler),
  onMenuTogglePreviewMode: (handler) => subscribe('menu-toggle-preview-mode', handler),
  onMenuSaveCurrent: (handler) => subscribe('menu-save-current', handler),
  onMenuExportAll: (handler) => subscribe('menu-export-all', handler),
  onMenuExportMergedHdr: (handler) => subscribe('menu-export-merged-hdr', handler),
  onMenuAutoFix: (handler) => subscribe('menu-auto-fix', handler),
  onAppReady: (handler) => subscribe('app-ready', handler),
});
