# Architecture

This document describes the current implementation boundaries and flow paths in ACE Photo Studio.

## Runtime Boundaries

- **Renderer (`renderer.js`)**
  - Owns UI state, controls, preview composition, histogram, and export payload preparation.
  - Does not directly use Node APIs.
- **Preload (`preload.js`)**
  - Exposes the `window.aceApi` bridge via `contextBridge.exposeInMainWorld`.
  - Maps renderer calls to named IPC channels.
- **Main (`main.js`)**
  - Owns filesystem access, dialogs, queue orchestration, RAW/HDR service usage, export writes, menu wiring.
- **Worker (`merge-worker.js`)**
  - Executes alignment + merge binaries, enforces per-set TIFF workspace isolation, validates merged TIFF bit depth.

## Practical File/Service Map

- `main.js`
  - BrowserWindow config, IPC handlers, queue lifecycle, naming rules, app menu.
- `preload.js`
  - API contract surface for renderer.
- `renderer.js`
  - Library/selection state, compare view, adjustments, presets, Auto Fix, histogram, export flow.
- `raw-service.js`
  - RAW conversion (`ace-dng-sdk-helper` preferred for DNG), preview JPEG generation (`sips`).
- `hdr-service.js`
  - Converts set inputs to TIFF, starts merge worker, manages active worker cancellation.
- `merge-worker.js`
  - Alignment (`align_image_stack`), fusion (`enfuse`) / true HDR helper, temp/atomic writes, 16-bit TIFF verification.
- `bracket-detector.js`, `file-grouping.js`
  - Grouping, partitioning, validation metadata, set completeness checks.

## Data/Workflow Paths

### 1) RAW Import Path

1. Renderer requests normalization through `aceApi.normalizePaths`.
2. Main resolves files and calls `normalizeInputPaths`.
3. RAW files are converted to TIFF via `RawService.convertRawToTiff`.
4. Preview JPEGs are generated and returned as renderer-consumable items.
5. Renderer stores items in `state.photos` with neutral `defaultAdjustments`.

### 2) HDR Merge Path

1. Renderer triggers `start-batch-hdr-merge` with folder/files + options.
2. Main performs bracket detection with metadata-aware grouping.
3. Queue state is initialized and broadcast via `hdr-queue-update`.
4. Each set is processed through `HdrService.mergeGroup` -> `merge-worker.js`.
5. Worker stages set inputs in isolated temp workspace and runs alignment/merge.
6. Worker writes merged TIFF atomically and validates `BitsPerSample == 16`.
7. Main records queue result and loads merged TIFFs into library on completion.

### 3) Preview/Edit Path

1. Renderer loads source image for selected photo.
2. Renderer applies adjustments in CPU path (`processImageToDataUrl`) with fast/settled preview scheduling.
3. Compare view uses same-frame original vs processed reveal in split/slider modes.
4. Histogram is computed from current preview source and refreshed on selection/adjustment changes.

### 4) Export Path

1. Renderer prepares JPEG data URLs from selected/all photos.
2. Main writes files with temp-path + rename semantics.
3. HDR strict export naming path uses merged metadata (`shootDate/sourceFolder/setIndex/quality`).

## Major Invariants To Protect

- Neutral load and reset must remain true neutral (`defaultAdjustments`, including hidden/internal fields).
- Compare integrity:
  - original side must remain original
  - processed side must remain processed
  - slider reveal must be same-frame geometry
- Merge isolation: per-set input staging and no cross-set contamination.
- Cancel semantics: finish safe current write, then stop waiting sets.
- Retry semantics: retry failed sets only, not full rescan.
- Merged HDR masters must be 16-bit TIFF.

## Lens-Correction Debug Bypass (Current State)

Location: `renderer.js`, `processImageToDataUrl`.

Current code contains:

- `// TEMPORARILY DISABLED FOR DEBUG:`
- A commented-out call: `imageData = applyLensCorrection(imageData, options?.lensParams);`

Interpretation:

- This is a **commented bypass marker** (not active executable bypass logic).
- Lens correction is currently **not applied** in this renderer preview path.
- The marker indicates a prior debug intervention and should be treated as a tracked hardening item.

Safe removal conditions for a future narrow pass:

1. Re-enable only behind an explicit feature flag or guarded switch.
2. Validate preview/export parity before/after re-enable.
3. Validate HDR reference sets (flat and already-good controls) for regressions.
4. Confirm neutral load/reset and compare behavior stay unchanged.

## Renderer State Coupling (Current Reality)

Renderer maintains a single large mutable `state` object across:

- library/selection
- adjustments/presets
- preview/zoom/pan/compare
- HDR queue/tracking
- histogram/preview performance timers

High-risk coupling points:

- Selection changes interacting with preset indicators and preview scheduling.
- `updateAdjustments` side effects touching presets, timers, and refresh queues.
- Shared flow between fast preview, settled preview, histogram refresh, and compare rendering.
- Multi-domain render pass (`render`) controlling many independent panels.

Safest future refactor boundaries:

1. Extract `presetState` domain (active button preset, dropdown selection, user presets).
2. Extract `previewState` domain (zoom/pan/mode/slider/perf timers).
3. Extract `hdrUiState` domain (folder/detection/queue/collapse state).
4. Keep import/export/merge behavior unchanged while only moving state ownership boundaries.

## Security Posture (Current)

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: false`
- Broad but explicit preload API surface.

Recommended hardening path is documented in [IPC_CONTRACT.md](IPC_CONTRACT.md).
