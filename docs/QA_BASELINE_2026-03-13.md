# QA Baseline Evidence - 2026-03-13

## Scope

Release-gate baseline run before renderer/main refactor work.
Validation-first pass (no app logic changes).

Primary reference sets:
- `tests/hdr-samples/hdr-set-2` (flat/sensitive)
- `tests/hdr-samples/hdr-set-5` (already-good control)

## Automated Checks Run

### 1) `npm run test:bracket-grouping`
- Result: PASS
- Evidence: `ok: true` and expected 5-shot grouping behavior on `hdr-set-3`.

### 2) `npm run test:merge-isolation`
- Result: PASS
- Evidence: output includes `merge-input-isolation: PASS`.
- Temp root used by script:
  - `/var/folders/hd/54pmwrxn0gv80tl8l3t0zkz80000gn/T/ace-merge-isolation-OUazDw`

### 3) `npm run test:hdr-samples`
- Result: PASS
- Coverage: `hdr-set-1` and `hdr-set-2`
- Evidence highlights:
  - DNG helper available (`decoder: adobe-dng-sdk-helper`)
  - queue transitions include `Waiting -> Processing -> Completed`
  - merge output exists and naming matches `_HDR16.tif`
  - preview loadable for merged TIFF
  - export naming matches `_EDIT_q92.jpg`

### 4) `npm start` (launch smoke, manual interrupt)
- Result: PASS WITH CAVEAT
- Evidence:
  - Electron app process launched successfully and stayed running with no immediate crash output.
  - Session was manually stopped with `SIGINT` after startup dwell for smoke validation.
- Caveat:
  - This is not a functional UI walkthrough.

## Additional Evidence Runs (Set-Specific)

### hdr-set-2 targeted baseline run
Command: custom read-only node script using `detectBracketGroups`, `RawService`, `HdrService`, `exiftool`.

Observed:
- detection: 1 complete 5-shot group
- merge: PASS
- merged name pattern: PASS (`20260309_hdr-set-2_SET0001_HDR16.tif`)
- bit depth: `BitsPerSample : 16 16 16 16`
- export proxy JPG creation: PASS (`20260309_hdr-set-2_SET0001_EDIT_q92.jpg`)

Evidence paths:
- merged TIFF: `/var/folders/hd/54pmwrxn0gv80tl8l3t0zkz80000gn/T/ace-hdr-set2-baseline-puli8U/output/20260309_hdr-set-2_SET0001_HDR16.tif`
- jpg output: `/var/folders/hd/54pmwrxn0gv80tl8l3t0zkz80000gn/T/ace-hdr-set2-baseline-puli8U/output/20260309_hdr-set-2_SET0001_EDIT_q92.jpg`

### hdr-set-5 targeted baseline run
Command: custom read-only node script using `detectBracketGroups`, `RawService`, `HdrService`, `exiftool`.

Observed:
- detection: 1 complete 5-shot group
- merge: PASS
- merged name pattern: PASS (`20250406_hdr-set-5_SET0001_HDR16.tif`)
- bit depth: `BitsPerSample : 16 16 16 16`
- export proxy JPG creation: PASS (`20250406_hdr-set-5_SET0001_EDIT_q92.jpg`)

Evidence paths:
- merged TIFF: `/var/folders/hd/54pmwrxn0gv80tl8l3t0zkz80000gn/T/ace-hdr-set5-baseline-Hy91VJ/output/20250406_hdr-set-5_SET0001_HDR16.tif`
- jpg output: `/var/folders/hd/54pmwrxn0gv80tl8l3t0zkz80000gn/T/ace-hdr-set5-baseline-Hy91VJ/output/20250406_hdr-set-5_SET0001_EDIT_q92.jpg`

## Release-Gate Item Status (This Pass)

### Confirmed by automation/evidence
- Bracket detection baseline: PASS
- Merge input isolation / cross-set safety: PASS
- Queue state progression basics (waiting/processing/completed) in scripted flow: PASS
- 16-bit TIFF verification behavior (indirect + output inspection): PASS
- Output naming for merged TIFF and exported JPG: PASS

### Static-code confirmed (not UI-run)
- Reserved preset-name protection includes built-ins and legacy conflicting names: PASS WITH CAVEAT
- `toneCurve` included in preset adjustment keys and serialization path: PASS WITH CAVEAT

### Not verified in interactive UI during this pass
- Neutral load/reset behavior in live UI
- Repeated Auto Fix non-stacking visual behavior
- Compare split/slider interactive correctness
- Preview/export visual parity (human visual compare)
- Preset save/load/delete end-to-end in running app
- Histogram live update behavior
- Full UI regression sanity pass

## Baseline Conclusion

Current CLI/script baseline is stable for merge-grouping/isolation/naming/16-bit constraints.
Interactive release-gate items still require dedicated human UI verification before refactor freeze is considered complete.
