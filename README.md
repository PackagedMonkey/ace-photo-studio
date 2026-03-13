# ACE Photo Studio

ACE Photo Studio is a macOS Electron desktop app for DJI DNG bracket workflows:

1. Import single photos/folders or HDR RAW folders.
2. Detect 3-shot or 5-shot bracket groups.
3. Merge each valid bracket set into a 16-bit TIFF master.
4. Load merged TIFFs into the editor.
5. Apply cleanup adjustments/presets.
6. Export final JPEGs.

This README is implementation-aligned with the current codebase (not aspirational behavior).

## Current Feature Set

- Photo library import (`Add Photos`, `Add Folder`, drag/drop)
- DJI DNG pipeline checks before RAW-heavy workflows
- Batch HDR merge queue with:
  - bracket detection
  - queue progress/error reporting
  - cancel (safe stop after current write)
  - retry failed sets only
- Editor controls:
  - split/slider compare
  - auto fix + preset actions
  - histogram panel
  - per-photo adjustments
- Export:
  - current photo as JPEG
  - export all loaded photos
  - strict-named merged-HDR JPEG export

## Architecture At A Glance

- `renderer.js`: UI, selection state, preview rendering, controls, export preparation
- `preload.js`: secure bridge exposing explicit `aceApi` IPC methods/events
- `main.js`: filesystem dialogs, RAW normalization, HDR queue orchestration, export writing, app menu
- `raw-service.js`: RAW -> TIFF conversion and preview JPEG generation
- `hdr-service.js`: per-set merge orchestration and worker launch
- `merge-worker.js`: alignment/fusion/HDR helper execution, set-isolation checks, final TIFF validation
- `bracket-detector.js` + `file-grouping.js`: bracket grouping/partitioning/validation

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for flow-level detail.

## Primary Workflows

### 1) Standard Photo Cleanup

1. Add photos/folder.
2. Main process normalizes inputs (RAW files become preview-backed working assets).
3. Edit in renderer preview.
4. Export current or all JPEGs.

### 2) Batch HDR Merge (DJI DNG)

1. Add HDR folder.
2. Detect bracket groups.
3. Start merge queue.
4. Merge outputs are validated as 16-bit TIFF masters.
5. Completed merged TIFFs are loaded into library with HDR metadata.
6. Edit and export as JPEG.

## Setup / Run / Test

```bash
npm install
npm start
```

Validation scripts:

```bash
npm run test:bracket-grouping
npm run test:merge-isolation
npm run test:hdr-samples
```

Packaging / helper checks:

```bash
npm run stage:helpers
npm run verify:helpers
npm run pack
npm run dist
```

## Documentation Map

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [docs/IPC_CONTRACT.md](docs/IPC_CONTRACT.md)
- [docs/PRESETS_AND_AUTOFIX.md](docs/PRESETS_AND_AUTOFIX.md)
- [docs/OUTPUT_NAMING_AND_FILE_RULES.md](docs/OUTPUT_NAMING_AND_FILE_RULES.md)
- [docs/RELEASE_GATE_CHECKLIST.md](docs/RELEASE_GATE_CHECKLIST.md)

## Current Hardening Notes

- Preview pipeline contains an explicit lens-correction debug bypass marker in renderer code. It is documented in the architecture and release checklist docs.
- BrowserWindow runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`; hardening path is documented in the IPC contract and architecture docs.
- Renderer state is intentionally centralized but large; coupling risks and safe future refactor boundaries are documented in architecture.
