# IPC Contract

This document records the current `preload.js` -> `main.js` contract exposed to renderer as `window.aceApi`.

Scope: **current implementation**, not proposed APIs.

## Bridge Posture

Current BrowserWindow security settings:

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: false`

Preload exposes a broad explicit API surface. This is functional, but should be hardened in phases (see end of document).

## Invoke APIs (`ipcRenderer.invoke`)

### File/Path Dialog and Save APIs

1. `pickFiles()`
- Channel: `pick-files`
- Args: none
- Returns: `string[] | null`

2. `pickFolder()`
- Channel: `pick-folder`
- Args: none
- Returns: `string | null`

3. `pickOutputFolder()`
- Channel: `pick-output-folder`
- Args: none
- Returns: `string | null`

4. `pickSaveFile(defaultName)`
- Channel: `pick-save-file`
- Request: `{ defaultName?: string }`
- Returns: `string | null`

5. `saveDataUrl(payload)`
- Channel: `save-data-url`
- Request: `{ outPath: string, dataUrl: string }`
- Returns: `true` on success
- Failure mode: throws/rejects if required fields are missing or write fails

6. `openPathInFinder(targetPath)`
- Channel: `open-path-in-finder`
- Request: `{ targetPath: string }`
- Returns success: `{ ok: true, openedPath: string, fallbackUsed: boolean }`
- Returns failure: `{ ok: false, error: string }`

7. `getPathForFile(file)`
- No IPC channel (uses `webUtils.getPathForFile` in preload)
- Args: browser `File`
- Returns: `string | null`

### RAW/Normalization APIs

8. `checkRawPipeline()`
- Channel: `check-raw-pipeline`
- Args: none
- Returns object (current shape):
  - `ok: boolean`
  - `decoder: string | null`
  - `dngPreferredDecoder: string | null`
  - `dngPreferredAvailable: boolean`
  - `error: string | null`
  - `warning: string | null`
  - `backends: { adobeDngSdkHelper, macOSSips }`

9. `normalizePaths(paths)`
- Channel: `normalize-paths`
- Request: `string[]`
- Returns: normalized item array.
- Item shape (current):
  - RAW-derived item: `{ originalPath, workingPath, isRaw: true, rawTiffPath, metadata }`
  - Non-RAW item: `{ originalPath, workingPath, isRaw: false, isMergedHdr, hdrMetadata, exportBaseName, metadata }`

### Preset APIs

10. `loadCleanupPresets()`
- Channel: `load-cleanup-presets`
- Args: none
- Returns success: `{ ok: true, presets: Preset[], filePath: string }`
- Returns failure: `{ ok: false, presets: [], error: string, filePath: string }`

11. `saveCleanupPreset(preset)`
- Channel: `save-cleanup-preset`
- Request: `{ preset: PresetLike }`
- Returns success: `{ ok: true, presets: Preset[], filePath: string }`
- Returns failure: `{ ok: false, presets: [], error: string, filePath: string }`

12. `deleteCleanupPreset(name)`
- Channel: `delete-cleanup-preset`
- Request: `{ name: string }`
- Returns success: `{ ok: true, presets: Preset[], filePath: string }`
- Returns failure: `{ ok: false, presets: [], error: string, filePath: string }`

### HDR Workflow APIs

13. `importHdrFolder(payload)`
- Channel: `hdr-import-folder`
- Request: `{ folderPath?: string, bracketMode?: 'auto' | '3' | '5' }`
- Returns success: `{ ok: true, folderPath, sourceFiles, detection }`
- Returns cancel/failure:
  - `{ ok: false, cancelled: true }`
  - `{ ok: false, error: string }`

14. `detectHdrGroups(payload)`
- Channel: `detect-hdr-groups`
- Request: `{ folderPath?: string, filePaths?: string[], bracketMode?: 'auto' | '3' | '5' }`
- Returns: `{ ok: true, sourceFiles, detection }`

15. `startBatchHdrMerge(payload)`
- Channel: `start-batch-hdr-merge`
- Request (current keys): `{ folderPath?, sourceFiles?, bracketMode?, mergeMode?, concurrency?, outputDir?, logPath? }`
- Returns success: `{ ok: true, queue }`
- Returns failure: `{ ok: false, error: string, queue }`

16. `retryFailedSets(payload)`
- Channel: `retry-failed-sets`
- Request: `{ concurrency?, outputDir?, logPath? }`
- Returns success: `{ ok: true, queue }`
- Returns failure: `{ ok: false, error: string, queue }`

17. `getMergeQueueProgress()`
- Channel: `get-merge-queue-progress`
- Args: none
- Returns: queue snapshot

18. `getHdrDiagnostics()`
- Channel: `get-hdr-diagnostics`
- Args: none
- Returns: `{ ok, generatedAt, app, paths, queue, queueLogTail, helpers }`

19. `cancelBatchHdrMerge()`
- Channel: `cancel-merge`
- Request: optional options object (supports `{ force?: boolean }` in main)
- Returns: queue snapshot

20. `openMergedTiffsInLibrary(results)`
- Channel: `open-merged-tiffs-in-library`
- Request: `{ results: Array<{ mergedPath|outputPath, ...metadata }> }`
- Returns: `{ ok: true, items: normalizedLibraryItems[] }`

### Export APIs

21. `exportEditedJpegs(payload)`
- Channel: `export-edited-jpegs`
- Request keys:
  - `items: Array<{ originalPath?, baseName?, exportBaseName?, hdrNaming?, dataUrl }>`
  - `suffix?: string`
  - `quality?: number`
  - `outputDir?: string`
  - `useHdrStrictNaming?: boolean`
- Returns cancelled: `{ ok: false, cancelled: true }`
- Returns validation failure: `{ ok: false, error: string }`
- Returns success: `{ ok: true, outputDir: string, exported: Array<{source,outPath}>, failed: Array<{source,error}> }`

## Event APIs (`ipcRenderer.on`)

All `onX(handler)` subscriptions return an unsubscribe function.

- `onHdrQueueUpdate` -> `hdr-queue-update` (queue snapshot)
- `onMenuAddPhotos` -> `menu-add-photos` (`string[]`)
- `onMenuAddFolder` -> `menu-add-folder` (`string | null`)
- `onMenuAddHdrFolder` -> `menu-add-hdr-folder`
- `onMenuStartHdrMerge` -> `menu-start-hdr-merge`
- `onMenuCancelHdrMerge` -> `menu-cancel-hdr-merge`
- `onMenuRetryFailedSets` -> `menu-retry-failed-sets`
- `onMenuPreviewZoomIn` -> `menu-preview-zoom-in`
- `onMenuPreviewZoomOut` -> `menu-preview-zoom-out`
- `onMenuPreviewFit` -> `menu-preview-fit`
- `onMenuTogglePreviewMode` -> `menu-toggle-preview-mode`
- `onMenuSaveCurrent` -> `menu-save-current`
- `onMenuExportAll` -> `menu-export-all`
- `onMenuExportMergedHdr` -> `menu-export-merged-hdr`
- `onMenuAutoFix` -> `menu-auto-fix`
- `onAppReady` -> `app-ready`

## Current Risks

- Broad renderer-callable filesystem surface (save/export/open-path/normalize/import/merge controls).
- Mixed error semantics (some channels throw, others return `{ ok: false }`).
- No central runtime schema validation for request payloads.

## Phased Hardening Plan (No Behavior Change Yet)

### Phase 1: Contract freeze + validation wrappers (low risk)

- Add a typed contract map in preload (runtime guard + defaults).
- Normalize all renderer-call patterns to explicit `ok/error` handling conventions.
- Add docs-first changelog process for any IPC signature change.

### Phase 2: Main-side input validation hardening

- Validate payload object shape and field ranges per channel.
- Reject unexpected fields for sensitive write APIs (`save-data-url`, `export-edited-jpegs`).
- Keep response shape backward compatible.

### Phase 3: Sandbox tightening prep

- Inventory all APIs/features relying on current unsandboxed assumptions.
- Add smoke tests for drag/drop file resolution and export/import menus.
- Trial `sandbox: true` behind a test branch only.

## What Can Break If Tightened Too Aggressively

- Drag/drop path extraction and local-file workflows.
- Existing renderer assumptions about thrown errors vs `{ ok: false }` responses.
- Menu shortcut handlers expecting payload type flexibility.
- Export/import flows if payload coercion is narrowed without renderer updates.
