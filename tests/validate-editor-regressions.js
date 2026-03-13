#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const editorCore = require('../editor-regression-core');
const rendererStateFactory = require('../renderer-state');
const { normalizeCleanupPresetEntry } = require('../cleanup-preset-schema');

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message} expected=${expected}, actual=${actual}, tolerance=${tolerance}`);
  }
}

function runNeutralResetDefaultsCheck() {
  const defaults = editorCore.defaultAdjustments;
  const expectedZeroKeys = [
    'exposure',
    'contrast',
    'vibrance',
    'saturation',
    'warmth',
    'shadows',
    'highlights',
    'whites',
    'blacks',
    'toneCurve',
    'clarity',
    'dehaze',
    'sharpen',
    'denoise',
    'rotation',
  ];

  for (const key of expectedZeroKeys) {
    assert.strictEqual(defaults[key], 0, `defaultAdjustments.${key} should be neutral (0).`);
  }

  const resetResolved = editorCore.resolveRenderAdjustments({});
  assert.strictEqual(resetResolved.toneCurve, 0, 'resolveRenderAdjustments should keep neutral toneCurve=0.');
}

function runAutoFixIdempotenceCheck() {
  const flatHdrStats = {
    meanLuma: 0.52,
    medianLuma: 0.51,
    p5Luma: 0.11,
    p25Luma: 0.41,
    p75Luma: 0.58,
    p95Luma: 0.86,
    dynamicRange: 0.75,
    midtoneSpread: 0.17,
    midDensity: 0.66,
    highlightDensity: 0.05,
    shadowDensity: 0.07,
    highlightClipPercent: 0.002,
    shadowClipPercent: 0.004,
    averageSaturation: 0.3,
    satSpread: 0.31,
    averageRed: 0.49,
    averageGreen: 0.5,
    averageBlue: 0.51,
  };
  const healthyHdrStats = {
    meanLuma: 0.49,
    medianLuma: 0.5,
    p5Luma: 0.06,
    p25Luma: 0.34,
    p75Luma: 0.69,
    p95Luma: 0.93,
    dynamicRange: 0.87,
    midtoneSpread: 0.35,
    midDensity: 0.4,
    highlightDensity: 0.08,
    shadowDensity: 0.11,
    highlightClipPercent: 0.006,
    shadowClipPercent: 0.01,
    averageSaturation: 0.37,
    satSpread: 0.48,
    averageRed: 0.51,
    averageGreen: 0.5,
    averageBlue: 0.49,
  };

  const profiles = ['auto', 'natural', 'real-estate', 'punchy', 'soft'];
  for (const profile of profiles) {
    const firstFlat = editorCore.estimateAutoAdjustments(flatHdrStats, profile, { isHdrMerged: true, rotation: 0 });
    const secondFlat = editorCore.estimateAutoAdjustments(flatHdrStats, profile, { isHdrMerged: true, rotation: 0 });
    assert.deepStrictEqual(secondFlat, firstFlat, `Idempotence failed for flat stats profile=${profile}.`);

    const firstHealthy = editorCore.estimateAutoAdjustments(healthyHdrStats, profile, { isHdrMerged: true, rotation: 0 });
    const secondHealthy = editorCore.estimateAutoAdjustments(healthyHdrStats, profile, { isHdrMerged: true, rotation: 0 });
    assert.deepStrictEqual(secondHealthy, firstHealthy, `Idempotence failed for healthy stats profile=${profile}.`);
  }

  const repeated = [];
  for (let i = 0; i < 5; i += 1) {
    repeated.push(editorCore.estimateAutoAdjustments(flatHdrStats, 'auto', { isHdrMerged: true, rotation: 0 }));
  }
  for (let i = 1; i < repeated.length; i += 1) {
    assert.deepStrictEqual(repeated[i], repeated[0], 'Repeated Auto Fix should not drift/stack on same stats.');
  }
}

function runPresetReproductionCheck() {
  const flatHdrStats = {
    meanLuma: 0.52,
    medianLuma: 0.51,
    p5Luma: 0.11,
    p25Luma: 0.41,
    p75Luma: 0.58,
    p95Luma: 0.86,
    dynamicRange: 0.75,
    midtoneSpread: 0.17,
    midDensity: 0.66,
    highlightDensity: 0.05,
    shadowDensity: 0.07,
    highlightClipPercent: 0.002,
    shadowClipPercent: 0.004,
    averageSaturation: 0.3,
    satSpread: 0.31,
    averageRed: 0.49,
    averageGreen: 0.5,
    averageBlue: 0.51,
  };

  const adjusted = editorCore.estimateAutoAdjustments(flatHdrStats, 'auto', { isHdrMerged: true, rotation: 0 });
  const payload = editorCore.presetStoragePayloadFromAdjustments('Regression Auto', adjusted);
  const normalized = normalizeCleanupPresetEntry(payload);
  const loadedAdjustments = editorCore.presetAdjustmentsFromValues(normalized);

  for (const key of editorCore.PRESET_ADJUSTMENT_KEYS) {
    if (key === 'exposure') {
      assertApprox(loadedAdjustments[key], adjusted[key], 1, `Preset exposure round-trip mismatch for ${key}.`);
    } else {
      assert.strictEqual(loadedAdjustments[key], adjusted[key], `Preset round-trip mismatch for ${key}.`);
    }
  }
  assert.strictEqual(loadedAdjustments.toneCurve, adjusted.toneCurve, 'toneCurve must persist in user preset round-trip.');

  const legacyNormalized = normalizeCleanupPresetEntry({
    name: 'Legacy Without ToneCurve',
    exposure: 0.32,
    contrast: 12,
    highlights: -4,
    shadows: 8,
  });
  assert.strictEqual(legacyNormalized.toneCurve, 0, 'Legacy preset without toneCurve should default toneCurve=0.');
  const legacyLoaded = editorCore.presetAdjustmentsFromValues(legacyNormalized);
  assert.strictEqual(legacyLoaded.toneCurve, 0, 'Legacy loaded preset should resolve toneCurve=0.');
}

function runCompareIntegrityCheck() {
  const photo = {
    isHdrMerged: false,
    originalUrl: 'file:///original.tif',
    processedUrl: 'file:///processed.jpg',
  };
  const splitState = editorCore.buildCompareRenderState({
    photo,
    processedUrl: photo.processedUrl,
    sliderPosition: 41,
  });

  assert.strictEqual(splitState.split.originalSrc, photo.originalUrl, 'Split compare original source must stay original.');
  assert.strictEqual(splitState.split.cleanedSrc, photo.processedUrl, 'Split compare cleaned source must stay processed.');
  assert.strictEqual(splitState.slider.originalSrc, photo.originalUrl, 'Slider compare original source must stay original.');
  assert.strictEqual(splitState.slider.cleanedSrc, photo.processedUrl, 'Slider compare cleaned source must stay processed.');
  assert.strictEqual(splitState.slider.reveal, 41, 'Slider reveal value must match state.');

  const mergedState = editorCore.buildCompareRenderState({
    photo: {
      isHdrMerged: true,
      originalUrl: 'file:///merged.tif',
      processedUrl: 'file:///merged-preview.jpg',
    },
    processedUrl: 'file:///merged-preview.jpg',
    sliderPosition: 180,
  });
  assert.strictEqual(mergedState.slider.reveal, 100, 'Slider reveal should clamp to 100.');
  assert.strictEqual(
    mergedState.slider.label,
    'Merged 16-bit TIFF Master / Current Edit Preview',
    'Merged compare label should preserve expected wording.'
  );
}

function runPreviewExportParityCheck() {
  const raw = {
    exposure: 22,
    contrast: 14,
    highlights: -10,
    shadows: 11,
    whites: 8,
    blacks: -7,
    toneCurve: 13,
    clarity: 5,
    dehaze: 4,
    vibrance: 10,
    saturation: 2,
    warmth: 1,
    sharpen: 14,
    denoise: 3,
    rotation: 90,
  };

  const previewResolved = editorCore.resolveRenderAdjustments(raw);
  const exportResolved = editorCore.resolveRenderAdjustments(raw);
  assert.deepStrictEqual(
    previewResolved,
    exportResolved,
    'Preview/export should resolve adjustments through the same deterministic path.'
  );

  const missingToneCurve = editorCore.resolveRenderAdjustments({
    exposure: 12,
    contrast: 8,
  });
  assert.strictEqual(missingToneCurve.toneCurve, 0, 'Missing toneCurve should resolve to neutral 0.');
}

function runRendererStateDomainCheck() {
  const state = rendererStateFactory.createRendererState();

  assert(Array.isArray(state.library.photos), 'library.photos should initialize as an array.');
  assert(state.photos === state.library.photos, 'legacy photos alias should point to library.photos.');

  state.preview.applyToAll = true;
  assert.strictEqual(state.applyToAll, true, 'applyToAll alias should reflect preview.applyToAll.');
  state.applyToAll = false;
  assert.strictEqual(state.preview.applyToAll, false, 'preview.applyToAll should reflect applyToAll alias writes.');

  state.presets.activePreset = 'natural';
  assert.strictEqual(state.activePreset, 'natural', 'activePreset alias should reflect presets.activePreset.');
  state.activePreset = null;
  assert.strictEqual(state.presets.activePreset, null, 'presets.activePreset should reflect activePreset alias writes.');

  state.preview.mode = 'slider';
  assert.strictEqual(state.previewMode, 'slider', 'previewMode alias should reflect preview.mode.');
  state.previewMode = 'split';
  assert.strictEqual(state.preview.mode, 'split', 'preview.mode should reflect previewMode alias writes.');

  state.library.interactionActive = true;
  assert.strictEqual(
    state.libraryInteractionActive,
    true,
    'libraryInteractionActive alias should reflect library.interactionActive.'
  );
  state.libraryInteractionActive = false;
  assert.strictEqual(
    state.library.interactionActive,
    false,
    'library.interactionActive should reflect libraryInteractionActive alias writes.'
  );
}

function runRendererWiringCheck() {
  const rendererPath = path.join(__dirname, '..', 'renderer.js');
  const indexPath = path.join(__dirname, '..', 'index.html');
  const rendererSource = fs.readFileSync(rendererPath, 'utf8');
  const indexSource = fs.readFileSync(indexPath, 'utf8');

  const requiredMarkers = [
    'editorCore?.estimateAutoAdjustments',
    'editorCore?.normalizePresetAdjustmentValue',
    'editorCore?.presetAdjustmentsFromValues',
    'editorCore?.presetStoragePayloadFromAdjustments',
    'editorCore?.buildCompareRenderState',
    'previewPipeline?.processImageToDataUrl',
    'histogramModule?.drawHistogramBins',
    'autoFixModule?.estimateAutoAdjustments',
    'rendererStateModule?.createRendererState',
    'resolveRenderAdjustments(currentPhoto.adjustments)',
    'resolveRenderAdjustments(photo.adjustments)',
  ];

  for (const marker of requiredMarkers) {
    assert(
      rendererSource.includes(marker),
      `renderer.js is missing editor-regression integration marker: ${marker}`
    );
  }

  assert(
    indexSource.includes('<script src="./renderer-state.js"></script>'),
    'index.html must load renderer-state.js before renderer.js'
  );

  assert(
    indexSource.includes('<script src="./preview-pipeline.js"></script>'),
    'index.html must load preview-pipeline.js before renderer.js'
  );

  assert(
    indexSource.includes('<script src="./histogram.js"></script>'),
    'index.html must load histogram.js before renderer.js'
  );

  assert(
    indexSource.includes('<script src="./auto-fix.js"></script>'),
    'index.html must load auto-fix.js before renderer.js'
  );

  assert(
    indexSource.includes('<script src="./editor-regression-core.js"></script>'),
    'index.html must load editor-regression-core.js before renderer.js'
  );
}

function run() {
  runNeutralResetDefaultsCheck();
  runAutoFixIdempotenceCheck();
  runPresetReproductionCheck();
  runCompareIntegrityCheck();
  runPreviewExportParityCheck();
  runRendererStateDomainCheck();
  runRendererWiringCheck();

  console.log('editor-regressions: PASS');
}

try {
  run();
} catch (error) {
  console.error(`editor-regressions: FAIL: ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
}
