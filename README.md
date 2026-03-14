# ACE Photo Studio

ACE Photo Studio is a macOS Electron desktop app for DJI DNG bracket workflows:

1. Import single photos/folders or HDR RAW folders.
2. Detect 3-shot or 5-shot bracket groups.
3. Merge each valid bracket set into a 16-bit TIFF master.
4. Load merged TIFFs into the editor.
5. Apply cleanup adjustments/presets.
6. Export final JPEGs.

Current focus areas:
- merge correctness and workflow safety
- practical editor workflow quality
- ongoing Lightroom-like pro-app polish direction in the UI

This README is implementation-aligned with the current codebase (not aspirational behavior).

## Install on macOS

1. Choose the correct DMG for your Mac:
   - Apple Silicon (M1/M2/M3): `arm64`
   - Intel Mac: `x64`
2. Open the DMG and drag **ACE Photo Studio** into **Applications**.
3. Open **Applications** and launch **ACE Photo Studio**.

### If macOS says the app cannot be verified

1. Try opening the app once from **Applications**.
2. Go to **System Settings > Privacy & Security**.
3. Scroll to the security message for ACE Photo Studio and click **Open Anyway**.
4. Confirm the follow-up prompt to open the app.
5. Optional: right-click the app in **Applications** and choose **Open**.

## Current Feature Set

- Photo library import (`Add Photos`, `Add Folder`, drag/drop)
- DJI DNG pipeline checks before RAW-heavy workflows
- Batch HDR merge queue with:
  - bracket detection
  - queue progress/error reporting
  - cancel (safe stop after current write)
  - retry failed sets only
- Merged HDR master validation:
  - merged outputs validated as 16-bit TIFF
- Editor controls:
  - library + preview + adjustments workflow
  - split/slider compare
  - top-row adaptive presets (`Natural`, `Real Estate`, `Punchy`, `Soft`)
  - `PICK PRESET` dropdown with user preset save/load/delete
  - auto fix workflow
  - histogram panel
  - per-photo adjustments
- Export:
  - current photo as JPEG
  - export all loaded photos
  - strict-named merged-HDR JPEG export
- Validation coverage:
  - merge isolation test
  - bracket grouping test
  - sample HDR workflow validation
  - editor regression test suite (`tests/validate-editor-regressions.js`)

## Lens Correction Status (Current)

- For `hdr-merge-source` DJI Mavic 3 DNGs, pre-merge manual/profile lens correction is default ON when the camera is detected.
- Safe disable override is available:
  - `ACE_DISABLE_DJI_M3_LENS_CORRECTION_PREMERGE=1`
- Embedded-opcode correction is probed, but current helper stack typically falls back to manual/profile correction.
- Current active production path is the DJI Mavic 3 manual/profile pre-merge fallback.

## Architecture At A Glance

- Renderer/editor responsibilities are partially split:
  - `renderer.js`: UI orchestration/wiring and editor flow integration
  - `preview-pipeline.js`: preview processing path helpers
  - `histogram.js`: histogram rendering helpers
  - `auto-fix.js`: Auto Fix estimation helpers
  - `renderer-state.js`: renderer state creation/aliasing helpers
  - `editor-regression-core.js`: shared editor logic used by regression checks
- `preload.js`: secure bridge exposing explicit `aceApi` IPC methods/events
- Main process responsibilities are beginning to split:
  - `main.js`: app bootstrap, queue orchestration, normalization, menu/wiring
  - `presets-ipc.js`: cleanup preset IPC handlers
  - `exports-ipc.js`: export-related IPC handlers
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
npm run test:editor-regressions
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
- [docs/QA_BASELINE_2026-03-13.md](docs/QA_BASELINE_2026-03-13.md)

## Current Limitations / Known Status

- Some interactive release-gate behaviors still rely on manual human verification (compare interaction, visual parity checks, full UI sweep).
- Embedded DNG opcode correction is not the reliable active path in the current helper stack.
- DJI Mavic 3 manual/profile pre-merge correction is the active correction path.
- Preview quality/performance tuning is ongoing and should continue to be validated with `hdr-set-2` and `hdr-set-5`.
