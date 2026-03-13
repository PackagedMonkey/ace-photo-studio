# Output Naming and File Rules

This document captures current naming, temp-write, and cache/output rules from the implementation.

## Naming Rules

## 1) Merged HDR TIFF master naming

Function: `buildMergedTiffName(...)` in `main.js`

Pattern:

```text
{shootDate}_{sourceFolder}_SET{setIndex4}_HDR16.tif
```

Example:

```text
20260309_hdr-set-2_SET0001_HDR16.tif
```

Notes:

- `shootDate` is sanitized and derived from group metadata/time fallback.
- `sourceFolder` is sanitized.
- `setIndex` is 4-digit padded (minimum `0001`).
- `_HDR16` denotes merged master intent and is backed by merge-worker bit-depth verification.

## 2) Merged HDR JPEG export naming

Function: `buildMergedJpegName(...)` in `main.js`

Pattern:

```text
{shootDate}_{sourceFolder}_SET{setIndex4}_EDIT_q{quality}.jpg
```

Example:

```text
20260309_hdr-set-2_SET0001_EDIT_q92.jpg
```

Notes:

- Used when `useHdrStrictNaming: true` for merged-HDR export flow.
- If name collisions exist, numeric suffix is appended (`_1`, `_2`, ...).

## 3) Non-strict generic JPEG export naming

Pattern in `export-edited-jpegs`:

```text
{baseName}{suffix}.jpg
```

Default suffix:

```text
_edit
```

Collision fallback:

```text
{baseName}{suffix}_{n}.jpg
```

## Temp and Atomic Write Rules

## 1) Merge worker output writes

- Worker writes to temp output in destination folder:
  - `.tmp-{pid}-{timestamp}-{outputBaseName}`
- Final output is published by rename after non-empty check.
- Stale temp files matching pattern are cleaned in `finally`.

## 2) Renderer single-save path (`save-data-url`)

- Temp path pattern:
  - `{outPath}.tmp-{pid}-{timestamp}`
- Temp file is validated non-empty then renamed to final path.

## 3) Batch JPEG export writes (`export-edited-jpegs`)

- Temp path pattern:
  - `.tmp-export-{pid}-{timestamp}-{rand}-{fileName}`
- Temp file validated non-empty then renamed to final.

## Cache and Working Directory Rules

## 1) Main cache root

- `APP_CACHE_ROOT = os.tmpdir()/ace-photo-studio-cache`

## 2) RAW conversion cache

- `raw-tiff-cache/{base}-{hash}.tiff`

## 3) Preview cache

- `preview-cache/{base}-{hash}.jpg`

## 4) HDR merge cache + work dirs

- `hdr-merge-cache/`
- Per-merge temp work directories under this root (`merge-{job}-*`)
- Inputs are staged as `input_0001_*` etc for per-set isolation.

## 5) Queue log/diagnostic outputs

- Queue logs under user data logs directory:
  - `hdr-merge-<timestamp>.log`
- Queue diagnostics snapshot JSON is written at queue finalization.

## 16-bit TIFF Enforcement Rule

Merged HDR masters are validated in `merge-worker.js`:

- Reads TIFF `BitsPerSample` tag (258).
- Requires all channel values equal `16`.
- Throws `HDR_OUTPUT_NOT_16BIT_TIFF` and removes invalid output if check fails.

## Validation Script Cross-References

- `tests/validate-hdr-samples.js`
  - validates naming regex for merged TIFF and exported JPEG
  - validates no partial temp output remains
- `tests/validate-bracket-grouping.js`
  - validates grouping/partition behavior for sample set
- `tests/validate-merge-input-isolation.js`
  - validates cross-set input isolation in merge pipeline
