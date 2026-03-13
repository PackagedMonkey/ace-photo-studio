# Release Gate Checklist

Use this as the final manual + script gate after significant UI/editing/HDR changes.

## How to Use

- Mark each item `PASS`, `FAIL`, or `N/A`.
- Treat any **Critical** fail as a release blocker.
- Record sample set used (`hdr-set-2`, `hdr-set-5`, etc.) and brief evidence notes.

## Preflight Automation (Critical)

1. `npm run test:bracket-grouping` => PASS/FAIL
2. `npm run test:merge-isolation` => PASS/FAIL
3. `npm run test:hdr-samples` => PASS/FAIL

## A) Neutral Load / Reset Safety (Critical)

1. Load new photo: visible controls start at neutral defaults.
2. Load merged HDR TIFF: starts neutral (no hidden baked look).
3. Press Reset after edits: all sliders + hidden tone shaping return to default.
4. Reset clears visual preset-active indicators correctly.
5. Switching between photos does not carry adjustments unexpectedly.

## B) Repeated Auto Fix Non-Stacking (Critical)

1. On a flat HDR image (recommend `hdr-set-2` merged TIFF), press Auto Fix 3x.
2. Confirm first press applies improvement and subsequent presses do not drift heavily.
3. On already-good control (recommend `hdr-set-5`), confirm no black crush/clipping regression.
4. Verify behavior with `Apply edits to all photos` OFF and ON (ON should intentionally apply selected-photo profile to all).

## C) Compare Integrity (Critical)

1. Split view:
   - left/original side remains original
   - right/processed side reflects current adjustments
2. Slider view:
   - reveal handle tracks correctly
   - no geometry mismatch, no false reveal, no double-processing artifacts
3. Toggle Split <-> Slider repeatedly while zoom/pan active.
4. Compare button labels remain correct for current mode.

## D) Preview / Export Parity (Critical)

1. Set a non-trivial edit (tone/detail/color).
2. Export Current JPG and compare to settled preview.
3. Run Export All JPG and Batch HDR Export; spot-check at least 3 images.
4. Adjust JPEG quality slider and verify output quality differences are observable and sane.

## E) HDR Merge Workflow / Isolation (Critical)

1. Add HDR folder and detect sets (3-shot/5-shot as applicable).
2. Start merge queue; verify queue status transitions (`Waiting` -> `Processing` -> `Completed/Failed/Canceled`).
3. Cancel during active processing and verify safe-stop semantics.
4. Retry Failed and confirm only failed sets are retried (no full rescan restart).
5. Verify no cross-set contamination in outputs.

## F) 16-bit TIFF Master Verification (Critical)

1. Confirm merged output filenames use `_HDR16.tif` pattern.
2. Confirm queue completes with no bit-depth verification errors.
3. If any set fails with `HDR_OUTPUT_NOT_16BIT_TIFF`, treat as blocker.

## G) Preset Save/Load/Delete + Name Protections (High)

1. Top-row adaptive presets apply per-image and remain responsive.
2. Dropdown built-ins apply deterministic static values.
3. Save user preset; reload app; confirm preset persists and re-applies as expected.
4. Delete user preset and confirm removal from dropdown.
5. Attempt to save reserved names (`Studio Neutral`, `Interior Bright`, `Crisp Pop`, `Gentle Lift`, `Natural`, `Real Estate`, `Punchy`, `Soft`) and confirm rejection.

## H) Histogram Behavior (High)

1. Histogram appears with selected photo.
2. Histogram updates after significant edits and selection changes.
3. Histogram clears/fallbacks gracefully when no photo is selected.
4. No UI stutter or runaway refresh loops during rapid slider drags.

## I) UI Regression Sweep (High)

1. Header actions and top-bar export controls remain wired.
2. Left panel collapse/expand and resizer still function.
3. Retry Failed button hidden/disabled behavior remains correct.
4. Merged TIFF banner/path display remains readable and accurate.
5. Keyboard shortcuts/menu commands still trigger expected actions.

## J) Final Sign-Off

- Critical sections A-F: all PASS
- High sections G-I: no unresolved FAILs without explicit waiver
- Diagnostics and logs reviewed for anomalous warnings
- Release decision: `GO` / `NO-GO`
