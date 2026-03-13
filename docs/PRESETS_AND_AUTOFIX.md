# Presets and Auto Fix

This document describes current preset/Auto Fix behavior exactly as implemented.

## Preset Surfaces

There are three preset surfaces in the current UI.

## 1) Top-row adaptive preset buttons

Buttons:

- `Natural`
- `Real Estate`
- `Punchy`
- `Soft`

Behavior:

- Uses `applyPreset(...)` -> `presetAdjustmentsForPhoto(...)` -> `estimateAutoAdjustments(...)`.
- Preset output is analysis-driven per selected image (`analysisStatsForPhoto`).
- Rotation is preserved from current photo.

Consequence:

- Same preset button can produce different values per image by design.

## 2) `PICK PRESET` dropdown built-ins

Current built-in dropdown names:

- `Studio Neutral`
- `Interior Bright`
- `Crisp Pop`
- `Gentle Lift`

Behavior:

- Uses static preset value maps defined in `BUILTIN_DROPDOWN_PRESETS`.
- Applying from dropdown sets exact stored values (after normalization/clamp).

Consequence:

- Dropdown built-ins are deterministic/static and distinct from top-row adaptive buttons.

## 3) User-saved presets

Storage:

- Main process stores presets at `app.getPath('userData')/presets.json`.
- Save is upsert by case-insensitive name.
- Delete removes by case-insensitive name.

Persisted fields currently include:

- `exposure`, `contrast`, `highlights`, `shadows`, `whites`, `blacks`
- `toneCurve` (clamped `0..100`)
- `clarity`, `dehaze`, `vibrance`, `saturation`, `warmth`, `sharpen`, `denoise`

Not persisted as preset field:

- `rotation` (intentionally excluded)

## Reserved / Protected Names

Reserved (cannot be saved as user presets):

- Current built-in names: `Studio Neutral`, `Interior Bright`, `Crisp Pop`, `Gentle Lift`
- Legacy conflicting names: `Natural`, `Real Estate`, `Punchy`, `Soft`

Delete protection:

- Built-in names are non-deletable.

## Auto Fix Behavior

Trigger path:

- `autoFixBtn` -> `ensurePhotoAnalysis(photo, { highPriority: true })`
- Then `updateAdjustments(estimateAutoAdjustments(stats, 'auto', ...))`

Key behavior:

- Auto Fix writes a full adjustment profile, not just one/few sliders.
- Because writes are full-profile, repeated Auto Fix presses should be stable/non-stacking for a given photo and analysis snapshot.
- Auto Fix still respects `Apply edits to all photos` if that toggle is enabled; in that mode, the selected-photo computed profile is applied to all loaded photos.

## Reset and Neutral Invariants

Reset button behavior:

- Applies `{ ...defaultAdjustments }` (includes `toneCurve: 0`, `rotation: 0`).
- Clears active top-row preset highlight.

Per-photo neutral initialization:

- New normalized items initialize with a clone of `defaultAdjustments`.

Expected invariant:

- Freshly loaded photo starts neutral.
- Reset returns selected photo to neutral defaults.

## Current State Notes

- Top-row adaptive presets and dropdown built-ins are intentionally separate surfaces with different semantics.
- `toneCurve` is currently an internal adjustment field and is persisted in user presets.
- Preset indicator coupling still depends on global renderer state (`activePreset` + `selectedPresetOptionId`) and should be regression-tested on selection changes.

## QA Focus For Presets/Auto Fix

- Verify repeated Auto Fix non-stacking on flat HDR and already-good image.
- Verify Reset fully clears tone shaping (`toneCurve`) and visible controls.
- Verify reserved-name protections (save/delete) still hold.
- Verify dropdown built-ins stay static while top-row presets remain adaptive.
