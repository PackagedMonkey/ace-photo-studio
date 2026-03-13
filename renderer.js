console.log('ACE Photo Studio renderer loaded');

const RAW_FILE_PATTERN = /\.(dng|cr2|cr3|nef|arw|raf|orf|rw2|pef|srw)$/i;
const editorCore = (typeof window !== 'undefined' && window.AceEditorCore) ? window.AceEditorCore : null;
const previewPipeline = (typeof window !== 'undefined' && window.AcePreviewPipeline) ? window.AcePreviewPipeline : null;
const histogramModule = (typeof window !== 'undefined' && window.AceHistogram) ? window.AceHistogram : null;
const autoFixModule = (typeof window !== 'undefined' && window.AceAutoFix) ? window.AceAutoFix : null;
const rendererStateModule = (typeof window !== 'undefined' && window.AceRendererState) ? window.AceRendererState : null;

const defaultAdjustments = editorCore?.defaultAdjustments
  ? { ...editorCore.defaultAdjustments }
  : {
    exposure: 0,
    contrast: 0,
    vibrance: 0,
    saturation: 0,
    warmth: 0,
    shadows: 0,
    highlights: 0,
    whites: 0,
    blacks: 0,
    toneCurve: 0,
    clarity: 0,
    dehaze: 0,
    sharpen: 0,
    denoise: 0,
    rotation: 0,
  };

const controlsConfig = [
  { key: 'exposure', label: 'Exposure', min: -400, max: 400, step: 1 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'whites', label: 'Whites', min: -100, max: 100 },
  { key: 'blacks', label: 'Blacks', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
  { key: 'dehaze', label: 'Dehaze', min: -100, max: 100 },
  { key: 'vibrance', label: 'Vibrance', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100 },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 100 },
  { key: 'denoise', label: 'Denoise', min: 0, max: 100 },
];

const PRESET_ADJUSTMENT_KEYS = editorCore?.PRESET_ADJUSTMENT_KEYS
  ? [...editorCore.PRESET_ADJUSTMENT_KEYS]
  : [
    'exposure',
    'contrast',
    'highlights',
    'shadows',
    'whites',
    'blacks',
    'toneCurve',
    'clarity',
    'dehaze',
    'vibrance',
    'saturation',
    'warmth',
    'sharpen',
    'denoise',
  ];

const BUILTIN_DROPDOWN_PRESETS = [
  {
    id: 'builtin-natural',
    name: 'Studio Neutral',
    adjustments: {
      exposure: 0.26,
      contrast: 25,
      highlights: 65,
      shadows: -6,
      whites: 51,
      blacks: -19,
      clarity: 11,
      dehaze: 8,
      vibrance: 23,
      saturation: 6,
      warmth: 0,
      sharpen: 13,
      denoise: 3,
    },
  },
  {
    id: 'builtin-real-estate',
    name: 'Interior Bright',
    adjustments: {
      exposure: 0.44,
      contrast: 29,
      highlights: -9,
      shadows: -1,
      whites: 55,
      blacks: -22,
      clarity: 16,
      dehaze: 11,
      vibrance: 25,
      saturation: 7,
      warmth: 0,
      sharpen: 14,
      denoise: 4,
    },
  },
  {
    id: 'builtin-punchy',
    name: 'Crisp Pop',
    adjustments: {
      exposure: 0.23,
      contrast: 33,
      highlights: 61,
      shadows: -7,
      whites: 55,
      blacks: -25,
      clarity: 18,
      dehaze: 11,
      vibrance: 28,
      saturation: 8,
      warmth: 0,
      sharpen: 15,
      denoise: 3,
    },
  },
  {
    id: 'builtin-soft',
    name: 'Gentle Lift',
    adjustments: {
      exposure: 0.27,
      contrast: 22,
      highlights: 65,
      shadows: -5,
      whites: 50,
      blacks: -20,
      clarity: 9,
      dehaze: 7,
      vibrance: 21,
      saturation: 5,
      warmth: 0,
      sharpen: 12,
      denoise: 5,
    },
  },
];
const LEGACY_CONFLICTING_PRESET_NAMES = ['Natural', 'Real Estate', 'Punchy', 'Soft'];
const BUILTIN_PRESET_NAME_SET = new Set(
  BUILTIN_DROPDOWN_PRESETS.map((preset) => String(preset.name || '').trim().toLowerCase())
);
const RESERVED_PRESET_NAME_SET = new Set([
  ...BUILTIN_PRESET_NAME_SET,
  ...LEGACY_CONFLICTING_PRESET_NAMES.map((name) => String(name || '').trim().toLowerCase()),
]);

const FAST_PREVIEW_MAX_DIMENSION = 352;
const FAST_PREVIEW_THROTTLE_MS = 32;
const SETTLED_PREVIEW_DELAY_MS = 680;
const SETTLED_PREVIEW_IDLE_GUARD_MS = 260;
const ANALYSIS_MAX_DIMENSION = 320;
const HISTOGRAM_BIN_COUNT = 64;
const HISTOGRAM_MAX_DIMENSION = 224;
const HISTOGRAM_REFRESH_DELAY_MS = 90;
// Auto-fix calibration anchors from live references:
// - hdr-set-2: flat/washed merged HDR should trigger stronger recovery
// - hdr-set-5: already-good control should avoid recovery branch
const FLAT_HDR_RECOVERY_TRIGGER = 0.36;
// correctness-first default: GPU preview is kept for future experimentation,
// but disabled by default to avoid preview/export tone mismatches.
const GPU_PREVIEW_MODE = 'disabled'; // 'disabled' | 'experimental_fast'

if (!rendererStateModule?.createRendererState) {
  throw new Error('Renderer state module unavailable.');
}

const state = rendererStateModule.createRendererState();

let previewHandlersBound = false;

const el = {
  startupScreen: document.getElementById('startupScreen'),
  startupStatusLabel: document.getElementById('startupStatusLabel'),
  appRoot: document.getElementById('appRoot'),

  addPhotosBtn: document.getElementById('addPhotosBtn'),
  addFolderBtn: document.getElementById('addFolderBtn'),
  addHdrFolderBtn: document.getElementById('addHdrFolderBtn'),
  startHdrMergePanelBtn: document.getElementById('startHdrMergePanelBtn'),
  retryFailedBtn: document.getElementById('retryFailedBtn'),
  cancelHdrMergeBtn: document.getElementById('cancelHdrMergeBtn'),
  openHdrOutputFolderBtn: document.getElementById('openHdrOutputFolderBtn'),
  hdrActionHint: document.getElementById('hdrActionHint'),

  miniAddPhotosBtn: document.getElementById('miniAddPhotosBtn'),
  miniAddFolderBtn: document.getElementById('miniAddFolderBtn'),
  clearLibraryBtn: document.getElementById('clearLibraryBtn'),
  toggleHdrWorkflowSection: document.getElementById('toggleHdrWorkflowSection'),
  toggleLibrarySection: document.getElementById('toggleLibrarySection'),
  leftPanelRoot: document.querySelector('.left-panel'),
  leftPanelBody: document.querySelector('.left-panel-body'),
  leftPanelResizer: document.getElementById('leftPanelResizer'),
  hdrWorkflowLeftSection: document.getElementById('hdrWorkflowLeftSection'),
  libraryLeftSection: document.getElementById('libraryLeftSection'),

  exportAllBtn: document.getElementById('exportAllBtn'),
  exportMergedHdrBtn: document.getElementById('exportMergedHdrBtn'),
  hdrExportQuality: document.getElementById('hdrExportQuality'),
  hdrExportQualityValue: document.getElementById('hdrExportQualityValue'),

  autoFixBtn: document.getElementById('autoFixBtn'),
  presetNaturalBtn: document.getElementById('presetNaturalBtn'),
  presetRealEstateBtn: document.getElementById('presetRealEstateBtn'),
  presetPunchyBtn: document.getElementById('presetPunchyBtn'),
  presetSoftBtn: document.getElementById('presetSoftBtn'),
  rotateBtn: document.getElementById('rotateBtn'),
  saveCurrentBtn: document.getElementById('saveCurrentBtn'),
  resetBtn: document.getElementById('resetBtn'),
  copyToAllBtn: document.getElementById('copyToAllBtn'),
  applyAllToggle: document.getElementById('applyAllToggle'),
  presetDropdownBtn: document.getElementById('presetDropdownBtn'),
  presetDropdownMenu: document.getElementById('presetDropdownMenu'),
  savePresetBtn: document.getElementById('savePresetBtn'),
  savePresetModal: document.getElementById('savePresetModal'),
  presetNameInput: document.getElementById('presetNameInput'),
  cancelSavePresetBtn: document.getElementById('cancelSavePresetBtn'),
  confirmSavePresetBtn: document.getElementById('confirmSavePresetBtn'),

  dropzone: document.getElementById('dropzone'),
  dropOverlay: document.getElementById('dropOverlay'),
  photoList: document.getElementById('photoList'),
  photoCount: document.getElementById('photoCount'),
  previewArea: document.getElementById('previewArea'),
  histogramCanvas: document.getElementById('histogramCanvas'),
  controls: document.getElementById('controls'),

  zoomInBtn: document.getElementById('zoomInBtn'),
  zoomOutBtn: document.getElementById('zoomOutBtn'),
  zoomFitBtn: document.getElementById('zoomFitBtn'),
  previewModeBtn: document.getElementById('previewModeBtn'),

  hdrModeSelect: document.getElementById('hdrModeSelect'),
  hdrBracketSelect: document.getElementById('hdrBracketSelect'),
  hdrConcurrencySelect: document.getElementById('hdrConcurrencySelect'),
  toggleHdrDetailsBtn: document.getElementById('toggleHdrDetailsBtn'),
  hdrDetailsContent: document.getElementById('hdrDetailsContent'),
  hdrStatusCompact: document.getElementById('hdrStatusCompact'),
  hdrSummary: document.getElementById('hdrSummary'),
  hdrOverallProgressBar: document.getElementById('hdrOverallProgressBar'),
  hdrOverallProgressText: document.getElementById('hdrOverallProgressText'),
  hdrSetList: document.getElementById('hdrSetList'),
  hdrErrorList: document.getElementById('hdrErrorList'),
};

function showStartup() {
  setTimeout(() => {
    el.startupScreen?.classList.add('fade-out');

    setTimeout(() => {
      el.startupScreen?.remove();
      el.appRoot?.classList.remove('hidden');
    }, 550);
  }, 2200);
}

showStartup();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizePathSlashes(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function pathBasename(filePath) {
  const normalized = normalizePathSlashes(filePath);
  const pieces = normalized.split('/').filter(Boolean);
  return pieces.length ? pieces[pieces.length - 1] : normalized;
}

function pathDirname(filePath) {
  const normalized = normalizePathSlashes(filePath);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return '';
  return normalized.slice(0, index);
}

function pathExt(filePath) {
  const base = pathBasename(filePath);
  const index = base.lastIndexOf('.');
  if (index <= 0) return '';
  return base.slice(index).toLowerCase();
}

function pathBasenameWithoutExt(filePath) {
  const base = pathBasename(filePath);
  const index = base.lastIndexOf('.');
  if (index <= 0) return base;
  return base.slice(0, index);
}

function compactPathPreview(filePath, { folder = false } = {}) {
  const normalized = normalizePathSlashes(filePath || '');
  if (!normalized) return '';

  const base = pathBasename(normalized) || normalized;
  const parent = pathBasename(pathDirname(normalized));

  if (folder) {
    if (parent && parent !== base) return `${parent}/${base}`;
    return base;
  }

  if (parent) return `${parent}/${base}`;
  return base;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusClassName(statusLabel) {
  return String(statusLabel || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function filePathToUrl(filePath) {
  const normalized = normalizePathSlashes(filePath || '');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return encodeURI(`file://${withLeadingSlash}`);
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // fall through to textarea fallback
    }
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

function isRawPath(filePath) {
  return RAW_FILE_PATTERN.test(filePath || '');
}

function parentName(filePath) {
  const dir = pathDirname(filePath);
  return pathBasename(dir) || 'Folder';
}

function makeOutputName(filePath) {
  return `${pathBasenameWithoutExt(filePath)}-cleaned.jpg`;
}

function lastMergedResult(queue) {
  const results = Array.isArray(queue?.mergedResults) ? queue.mergedResults : [];
  return results.length ? results[results.length - 1] : null;
}

function mergedHdrBaseAdjustments() {
  return { ...defaultAdjustments };
}

function resolveRenderAdjustments(adjustments = null) {
  if (editorCore?.resolveRenderAdjustments) {
    return editorCore.resolveRenderAdjustments(adjustments, defaultAdjustments);
  }
  return {
    ...defaultAdjustments,
    ...(adjustments || {}),
  };
}

function photoPreviewUrl(photo) {
  return photo?.processedUrl || photo?.fastProcessedUrl || photo?.originalUrl;
}

function clearPreviewTimers() {
  if (state.preview.perf.fastTimer) {
    clearTimeout(state.preview.perf.fastTimer);
    state.preview.perf.fastTimer = null;
  }

  if (state.preview.perf.fullTimer) {
    clearTimeout(state.preview.perf.fullTimer);
    state.preview.perf.fullTimer = null;
  }

  state.preview.perf.pendingFast = false;
  if (state.histogram.refreshTimer) {
    clearTimeout(state.histogram.refreshTimer);
    state.histogram.refreshTimer = null;
  }
}

function queueViewportQualityRefresh({ debounceMs = 180 } = {}) {
  const photo = selectedPhoto();
  if (!photo) return;

  queueSelectedPreviewRender({
    fastMode: false,
    debounceMs: Math.max(0, debounceMs),
    fullRender: false,
  });
}

function markPhotoAdjustmentsDirty(photo) {
  if (!photo) return;
  photo.adjustVersion = (photo.adjustVersion || 0) + 1;
  photo.processedUrl = null;
  photo.fastProcessedUrl = null;
  photo.histogramKey = null;
  photo.histogramBins = null;
}

function updateSelectedThumbImage() {
  const photo = selectedPhoto();
  if (!photo || !el.photoList) return;

  const rows = Array.from(el.photoList.querySelectorAll('.photo-item'));
  const row = rows.find((item) => item.dataset.id === photo.id);
  const thumb = row?.querySelector('.thumb');
  if (thumb) {
    thumb.src = photoPreviewUrl(photo);
  }
}

function updateLivePreviewImageSources(photo) {
  if (!photo) return false;
  const nextSrc = photoPreviewUrl(photo);
  const cleanedNodes = Array.from(document.querySelectorAll('.preview-image[alt="Cleaned"], .compare-cleaned-image'));
  if (!cleanedNodes.length) return false;

  cleanedNodes.forEach((node) => {
    node.src = nextSrc;
  });

  return true;
}

async function getPhotoSourceImage(photo) {
  if (!photo) throw new Error('Missing photo for preview render.');
  if (photo.sourceImage) {
    if (!photo.analysisStats && !photo.analysisPromise) {
      schedulePhotoAnalysis(photo, photo.sourceImage, { highPriority: false });
    }
    return photo.sourceImage;
  }
  if (photo.sourceImagePromise) return photo.sourceImagePromise;

  photo.sourceImagePromise = loadImage(photo.originalUrl)
    .then((img) => {
      photo.sourceImage = img;
      if (!photo.analysisStats && !photo.analysisPromise) {
        schedulePhotoAnalysis(photo, img, { highPriority: false });
      }
      return img;
    })
    .finally(() => {
      photo.sourceImagePromise = null;
    });

  return photo.sourceImagePromise;
}

function queueSelectedPreviewRender({
  fastMode = false,
  debounceMs = 0,
  autoFit = false,
  fullRender = false,
} = {}) {
  const photo = selectedPhoto();
  if (!photo) return;

  const expectedPhotoId = photo.id;
  const expectedVersion = photo.adjustVersion || 0;
  const timerKey = fastMode ? 'fastTimer' : 'fullTimer';

  if (fastMode && state.preview.perf.fastInFlight) {
    state.preview.perf.pendingFast = true;
    return;
  }

  if (state.preview.perf[timerKey]) {
    clearTimeout(state.preview.perf[timerKey]);
    state.preview.perf[timerKey] = null;
  }

  let waitMs = Math.max(0, debounceMs);
  if (fastMode) {
    const now = Date.now();
    const delta = now - state.preview.perf.lastFastScheduleAt;
    waitMs = Math.max(waitMs, Math.max(0, FAST_PREVIEW_THROTTLE_MS - delta));
    state.preview.perf.lastFastScheduleAt = now + waitMs;
  }

  state.preview.perf[timerKey] = setTimeout(() => {
    state.preview.perf[timerKey] = null;

    if (!fastMode) {
      const idleDelta = Date.now() - (state.preview.perf.lastInteractionAt || 0);
      if (idleDelta < SETTLED_PREVIEW_IDLE_GUARD_MS) {
        queueSelectedPreviewRender({
          fastMode: false,
          debounceMs: SETTLED_PREVIEW_IDLE_GUARD_MS - idleDelta,
          autoFit,
          fullRender,
        });
        return;
      }
    }

    refreshSelectedPreview({
      autoFit,
      fastMode,
      fullRender,
      expectedPhotoId,
      expectedVersion,
    });
  }, waitMs);
}

function selectionSetEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function normalizeLibrarySelectionState() {
  if (!(state.selectedPhotoIds instanceof Set)) {
    state.selectedPhotoIds = new Set(state.selectedPhotoIds || []);
  }

  if (!state.photos.length) {
    state.selectedId = null;
    state.selectionAnchorId = null;
    state.selectedPhotoIds.clear();
    return;
  }

  const validIds = new Set(state.photos.map((photo) => photo.id));
  for (const id of Array.from(state.selectedPhotoIds)) {
    if (!validIds.has(id)) {
      state.selectedPhotoIds.delete(id);
    }
  }

  if (state.selectedId && !validIds.has(state.selectedId)) {
    state.selectedId = null;
  }

  if (!state.selectedId) {
    state.selectedId = state.photos[0].id;
  }

  if (state.selectedId) {
    state.selectedPhotoIds.add(state.selectedId);
  }

  if (!state.selectedPhotoIds.size) {
    state.selectedPhotoIds.add(state.selectedId);
  }

  if (!state.selectedPhotoIds.has(state.selectedId)) {
    const fallback = state.photos.find((photo) => state.selectedPhotoIds.has(photo.id));
    state.selectedId = fallback ? fallback.id : state.photos[0].id;
    state.selectedPhotoIds.add(state.selectedId);
  }

  if (state.selectionAnchorId && !validIds.has(state.selectionAnchorId)) {
    state.selectionAnchorId = null;
  }
  if (!state.selectionAnchorId) {
    state.selectionAnchorId = state.selectedId;
  }
}

function selectedLibraryPhotos() {
  normalizeLibrarySelectionState();
  return state.photos.filter((photo) => state.selectedPhotoIds.has(photo.id));
}

function manualHdrSelectionInfo() {
  const selectedPhotos = selectedLibraryPhotos();
  const selectedCount = selectedPhotos.length;
  const hasMultiSelect = selectedCount > 1;
  const rawSelectedPhotos = selectedPhotos.filter((photo) => photo.isRaw && !photo.isHdrMerged);
  const sourceFiles = [...new Set(rawSelectedPhotos.map((photo) => photo.filePath))];
  const rawCount = sourceFiles.length;
  const excludedNonRawCount = selectedCount - rawSelectedPhotos.length;
  const singleSetCandidate = excludedNonRawCount === 0 && (rawCount === 3 || rawCount === 5);
  const canAttemptManualMerge = hasMultiSelect && rawCount >= 3;
  let invalidReason = '';

  if (hasMultiSelect && rawCount < 3) {
    invalidReason = `Manual HDR merge needs at least 3 RAW photos. Current RAW selection: ${rawCount}.`;
  }

  return {
    selectedPhotos,
    selectedCount,
    hasMultiSelect,
    rawSelectedPhotos,
    rawCount,
    excludedNonRawCount,
    canAttemptManualMerge,
    singleSetCandidate,
    multiSetCandidate: canAttemptManualMerge && !singleSetCandidate,
    invalidReason,
    sourceFiles,
  };
}

function applyLibrarySelection(photoId, event = {}) {
  normalizeLibrarySelectionState();

  const clickedIndex = state.photos.findIndex((photo) => photo.id === photoId);
  if (clickedIndex < 0) {
    return { selectionChanged: false, primaryChanged: false };
  }

  const prevSelection = new Set(state.selectedPhotoIds);
  const prevPrimary = state.selectedId;
  const toggleModifier = Boolean(event.metaKey || event.ctrlKey);
  const shiftModifier = Boolean(event.shiftKey);

  let nextSelection = new Set(state.selectedPhotoIds);
  let nextPrimary = state.selectedId || photoId;
  const anchorId = state.selectionAnchorId || state.selectedId || photoId;
  const anchorIndex = state.photos.findIndex((photo) => photo.id === anchorId);

  if (shiftModifier && anchorIndex >= 0) {
    const rangeStart = Math.min(anchorIndex, clickedIndex);
    const rangeEnd = Math.max(anchorIndex, clickedIndex);
    const rangeIds = state.photos.slice(rangeStart, rangeEnd + 1).map((photo) => photo.id);

    if (toggleModifier) {
      rangeIds.forEach((id) => nextSelection.add(id));
    } else {
      nextSelection = new Set(rangeIds);
    }
    nextPrimary = photoId;
  } else if (toggleModifier) {
    if (nextSelection.has(photoId) && nextSelection.size > 1) {
      nextSelection.delete(photoId);
      if (nextPrimary === photoId) {
        const fallback = state.photos.find((photo) => nextSelection.has(photo.id));
        nextPrimary = fallback ? fallback.id : photoId;
      }
    } else {
      nextSelection.add(photoId);
      nextPrimary = photoId;
    }
    state.selectionAnchorId = photoId;
  } else {
    nextSelection = new Set([photoId]);
    nextPrimary = photoId;
    state.selectionAnchorId = photoId;
  }

  if (!nextSelection.size) {
    nextSelection.add(photoId);
    nextPrimary = photoId;
  }

  if (!nextSelection.has(nextPrimary)) {
    const fallback = state.photos.find((photo) => nextSelection.has(photo.id));
    nextPrimary = fallback ? fallback.id : photoId;
  }

  if (shiftModifier && anchorIndex < 0) {
    state.selectionAnchorId = photoId;
  }

  state.selectedPhotoIds = nextSelection;
  state.selectedId = nextPrimary;
  normalizeLibrarySelectionState();

  return {
    selectionChanged: !selectionSetEquals(prevSelection, state.selectedPhotoIds),
    primaryChanged: prevPrimary !== state.selectedId,
  };
}

function focusLibraryItem(item) {
  if (!item?.focus) return;
  try {
    item.focus({ preventScroll: true });
  } catch {
    item.focus();
  }
}

function selectAllLibraryPhotos() {
  normalizeLibrarySelectionState();
  if (!state.photos.length) return { changed: false, primaryChanged: false };

  const previousSelection = new Set(state.selectedPhotoIds);
  const previousPrimary = state.selectedId;
  const allIds = state.photos.map((photo) => photo.id);
  const allSelection = new Set(allIds);
  const nextPrimary = (state.selectedId && allSelection.has(state.selectedId))
    ? state.selectedId
    : allIds[0];

  state.selectedPhotoIds = allSelection;
  state.selectedId = nextPrimary;
  state.selectionAnchorId = nextPrimary;
  normalizeLibrarySelectionState();

  return {
    changed: !selectionSetEquals(previousSelection, state.selectedPhotoIds),
    primaryChanged: previousPrimary !== state.selectedId,
  };
}

function selectedPhoto() {
  normalizeLibrarySelectionState();
  return state.photos.find((photo) => photo.id === state.selectedId) || null;
}

function getCurrentAdjustments() {
  return selectedPhoto()?.adjustments || defaultAdjustments;
}

function resetView() {
  state.zoom = state.fitZoom || 1;
  state.panX = 0;
  state.panY = 0;
}

function makePreviewTransform() {
  return `translate(calc(-50% + ${state.panX}px), calc(-50% + ${state.panY}px)) scale(${state.zoom})`;
}

function previewImageSizeStyle(photo) {
  const sourceImage = photo?.sourceImage;
  if (!sourceImage?.width || !sourceImage?.height) return '';

  const rotation = ((photo?.adjustments?.rotation || 0) % 360 + 360) % 360;
  const rotate90 = rotation === 90 || rotation === 270;
  const width = rotate90 ? sourceImage.height : sourceImage.width;
  const height = rotate90 ? sourceImage.width : sourceImage.height;

  return `width:${Math.max(1, Math.round(width))}px;height:${Math.max(1, Math.round(height))}px;`;
}

function histogramSourceKeyForPhoto(photo) {
  if (!histogramModule?.sourceKeyForPhoto) return '';
  return histogramModule.sourceKeyForPhoto(photo);
}

function drawHistogramBins(bins = null) {
  if (!el.histogramCanvas || !histogramModule?.drawHistogramBins) return;
  histogramModule.drawHistogramBins(el.histogramCanvas, bins);
}

function buildLuminanceHistogramFromImage(image, binCount = HISTOGRAM_BIN_COUNT) {
  if (!histogramModule?.buildLuminanceHistogramFromImage) {
    return new Array(binCount).fill(0);
  }
  return histogramModule.buildLuminanceHistogramFromImage(image, {
    binCount,
    maxDimension: HISTOGRAM_MAX_DIMENSION,
    documentRef: document,
  });
}

async function resolveHistogramSourceImage(photo) {
  if (!photo) return null;

  if (!photo.processedUrl) {
    return getPhotoSourceImage(photo);
  }

  return loadImage(photo.processedUrl);
}

async function refreshSelectedHistogram({ force = false } = {}) {
  if (!el.histogramCanvas) return;

  const photo = selectedPhoto();
  if (!photo) {
    state.histogram.requestToken += 1;
    drawHistogramBins(null);
    return;
  }

  const histogramKey = histogramSourceKeyForPhoto(photo);
  if (!force && photo.histogramKey === histogramKey && Array.isArray(photo.histogramBins)) {
    drawHistogramBins(photo.histogramBins);
    return;
  }

  const requestToken = ++state.histogram.requestToken;

  try {
    const sourceImage = await resolveHistogramSourceImage(photo);
    if (!sourceImage) {
      drawHistogramBins(null);
      return;
    }

    const bins = buildLuminanceHistogramFromImage(sourceImage, HISTOGRAM_BIN_COUNT);
    photo.histogramBins = bins;
    photo.histogramKey = histogramKey;

    if (requestToken !== state.histogram.requestToken) return;
    if (selectedPhoto()?.id !== photo.id) return;
    drawHistogramBins(bins);
  } catch (error) {
    if (requestToken !== state.histogram.requestToken) return;
    console.warn('Histogram update failed:', error);
    drawHistogramBins(null);
  }
}

function scheduleHistogramRefresh({ force = false, delayMs = HISTOGRAM_REFRESH_DELAY_MS } = {}) {
  if (!el.histogramCanvas) return;

  if (state.histogram.refreshTimer) {
    clearTimeout(state.histogram.refreshTimer);
    state.histogram.refreshTimer = null;
  }

  state.histogram.refreshTimer = setTimeout(() => {
    state.histogram.refreshTimer = null;
    refreshSelectedHistogram({ force });
  }, Math.max(0, delayMs));
}

function buildFallbackImageStats(isHdrMerged = false) {
  if (autoFixModule?.buildFallbackImageStats) {
    return autoFixModule.buildFallbackImageStats(isHdrMerged, { coreApi: editorCore });
  }

  if (editorCore?.buildFallbackImageStats) {
    return editorCore.buildFallbackImageStats(isHdrMerged);
  }

  return {
    meanLuminance: 0.47,
    meanLuma: 0.47,
    medianLuma: 0.48,
    p5Luminance: 0.06,
    p25Luminance: 0.31,
    p50Luminance: 0.48,
    p75Luminance: 0.66,
    p95Luminance: 0.9,
    p5Luma: 0.06,
    p25Luma: 0.31,
    p50Luma: 0.48,
    p75Luma: 0.66,
    p95Luma: 0.9,
    dynamicRange: 0.84,
    midtoneSpread: 0.35,
    midDensity: 0.34,
    highlightDensity: 0.06,
    shadowDensity: 0.08,
    highlightClipPercent: 0.005,
    shadowClipPercent: 0.01,
    averageSaturation: 0.32,
    sat5: 0.1,
    sat95: 0.55,
    satSpread: 0.45,
    averageRed: 0.5,
    averageGreen: 0.5,
    averageBlue: 0.5,
    colorBalance: 0,
    colorCast: 0,
  };
}

function analyzeImageStats(imageData) {
  if (autoFixModule?.analyzeImageStats) {
    return autoFixModule.analyzeImageStats(imageData, { coreApi: editorCore });
  }

  return buildFallbackImageStats(false);
}

function analyzeImageStatsFromImage(image) {
  if (autoFixModule?.analyzeImageStatsFromImage) {
    return autoFixModule.analyzeImageStatsFromImage(image, {
      analysisMaxDimension: ANALYSIS_MAX_DIMENSION,
      documentRef: document,
      coreApi: editorCore,
    });
  }

  return buildFallbackImageStats(false);
}

function clampEditorAdjustments(adjustments, { rotation = 0 } = {}) {
  if (autoFixModule?.clampEditorAdjustments) {
    return autoFixModule.clampEditorAdjustments(adjustments, { rotation, coreApi: editorCore });
  }

  if (editorCore?.clampEditorAdjustments) {
    return editorCore.clampEditorAdjustments(adjustments, { rotation });
  }

  return {
    ...defaultAdjustments,
    ...(adjustments || {}),
    rotation: ((Math.round(rotation) % 360) + 360) % 360,
  };
}

function estimateAutoAdjustments(stats, profile = 'natural', { isHdrMerged = false, rotation = 0 } = {}) {
  if (autoFixModule?.estimateAutoAdjustments) {
    return autoFixModule.estimateAutoAdjustments(stats, profile, {
      isHdrMerged,
      rotation,
      coreApi: editorCore,
      defaultAdjustments,
      flatHdrRecoveryTrigger: FLAT_HDR_RECOVERY_TRIGGER,
    });
  }

  if (editorCore?.estimateAutoAdjustments) {
    return editorCore.estimateAutoAdjustments(stats, profile, { isHdrMerged, rotation });
  }

  return clampEditorAdjustments({ ...defaultAdjustments }, { rotation });
}

function schedulePhotoAnalysis(photo, image, { force = false, highPriority = false } = {}) {
  if (!photo || !image) return Promise.resolve(buildFallbackImageStats(Boolean(photo?.isHdrMerged)));
  if (!force && photo.analysisStats) return Promise.resolve(photo.analysisStats);
  if (!force && photo.analysisPromise) return photo.analysisPromise;

  photo.analysisPromise = new Promise((resolve) => {
    const run = () => {
      try {
        const stats = analyzeImageStatsFromImage(image);
        photo.analysisStats = stats;
        resolve(stats);
      } catch (error) {
        console.warn('Image analysis failed:', error);
        const fallback = buildFallbackImageStats(Boolean(photo?.isHdrMerged));
        photo.analysisStats = fallback;
        resolve(fallback);
      } finally {
        photo.analysisPromise = null;
      }
    };

    if (highPriority) {
      run();
      return;
    }

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 200 });
    } else {
      setTimeout(run, 0);
    }
  });

  return photo.analysisPromise;
}

async function ensurePhotoAnalysis(photo, { force = false, highPriority = false } = {}) {
  if (!photo) {
    return buildFallbackImageStats(false);
  }

  if (!force && photo.analysisStats) {
    return photo.analysisStats;
  }
  const shouldForce = force || (highPriority && !photo.analysisStats);

  if (!shouldForce && photo.analysisPromise) {
    return photo.analysisPromise;
  }

  const image = photo.sourceImage || await getPhotoSourceImage(photo);
  return schedulePhotoAnalysis(photo, image, { force: shouldForce, highPriority });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

const previewGpu = {
  attemptedInit: false,
  available: false,
  disabled: false,
  failureReason: null,
  backend: null,
  renderer: null,
};

const PREVIEW_WEBGL_VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = (a_position + 1.0) * 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const PREVIEW_WEBGL_FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 v_uv;
  uniform sampler2D u_image;
  uniform float u_exposureGain;
  uniform float u_contrastFactor;
  uniform float u_saturationFactor;
  uniform float u_shadows;
  uniform float u_highlights;
  uniform float u_whites;
  uniform float u_blacks;
  uniform float u_clarity;
  uniform float u_dehaze;
  uniform float u_warmth;
  uniform float u_filmicToe;
  uniform float u_filmicShoulder;
  uniform float u_filmicGamma;

  float safeClamp(float value, float minV, float maxV) {
    return min(maxV, max(minV, value));
  }

  float srgbToLinear(float value) {
    if (value <= 0.04045) return value / 12.92;
    return pow((value + 0.055) / 1.055, 2.4);
  }

  float linearToSrgb(float value) {
    if (value <= 0.0031308) return value * 12.92;
    return 1.055 * pow(value, 1.0 / 2.4) - 0.055;
  }

  float luminanceLinear(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
  }

  float applyFilmicLuminance(float value, float toe, float shoulder, float gammaV) {
    float safe = max(0.0, value);
    float toeCut = max(0.0, safe - toe);
    float shoulderMapped = toeCut / (1.0 + shoulder * toeCut);
    return pow(safeClamp(shoulderMapped, 0.0, 1.0), gammaV);
  }

  float adjustMaskedTone(float value, float amount, float maskV, float darkenMultiplier) {
    if (amount == 0.0 || maskV == 0.0) return value;

    if (amount > 0.0) {
      return safeClamp(value + (1.0 - value) * amount * maskV, 0.0, 1.0);
    }

    return safeClamp(value + value * amount * maskV * darkenMultiplier, 0.0, 1.0);
  }

  void main() {
    vec3 sampled = texture2D(u_image, v_uv).rgb;
    vec3 color = vec3(
      srgbToLinear(sampled.r),
      srgbToLinear(sampled.g),
      srgbToLinear(sampled.b)
    ) * u_exposureGain;
    color = max(color, vec3(0.0));

    float contrastPivot = 0.18;
    float shadowToneAmount = u_shadows * 0.82;
    float highlightToneAmount = u_highlights * 0.9;
    float whiteToneAmount = u_whites * 0.72;

    float luminance = luminanceLinear(color);
    float shadowMask = 1.0 - smoothstep(0.1, 0.5, luminance);
    float highlightMask = smoothstep(0.32, 0.95, luminance);
    float whiteMask = smoothstep(0.68, 1.0, luminance);
    float blackMask = 1.0 - smoothstep(0.0, 0.24, luminance);

    color.r = adjustMaskedTone(color.r, shadowToneAmount, shadowMask, 1.0);
    color.g = adjustMaskedTone(color.g, shadowToneAmount, shadowMask, 1.0);
    color.b = adjustMaskedTone(color.b, shadowToneAmount, shadowMask, 1.0);

    color.r = adjustMaskedTone(color.r, highlightToneAmount, highlightMask, 1.0);
    color.g = adjustMaskedTone(color.g, highlightToneAmount, highlightMask, 1.0);
    color.b = adjustMaskedTone(color.b, highlightToneAmount, highlightMask, 1.0);

    color.r = adjustMaskedTone(color.r, whiteToneAmount, whiteMask, 1.0);
    color.g = adjustMaskedTone(color.g, whiteToneAmount, whiteMask, 1.0);
    color.b = adjustMaskedTone(color.b, whiteToneAmount, whiteMask, 1.0);

    color.r = adjustMaskedTone(color.r, u_blacks, blackMask, 1.25);
    color.g = adjustMaskedTone(color.g, u_blacks, blackMask, 1.25);
    color.b = adjustMaskedTone(color.b, u_blacks, blackMask, 1.25);

    if (u_dehaze != 0.0) {
      luminance = luminanceLinear(color);
      float maxV = max(color.r, max(color.g, color.b));
      float minV = min(color.r, min(color.g, color.b));
      float satLocal = maxV > 0.0 ? (maxV - minV) / maxV : 0.0;
      float hazeMask = smoothstep(0.2, 0.95, luminance) * (1.0 - satLocal);
      float hazeOffset = u_dehaze * hazeMask * 0.1;

      color = max(vec3(0.0), color - vec3(hazeOffset));

      float dehazeContrast = 1.0 + u_dehaze * 0.22;
      color = max(vec3(0.0), (color - vec3(contrastPivot)) * dehazeContrast + vec3(contrastPivot));
    }

    color = max(vec3(0.0), (color - vec3(contrastPivot)) * u_contrastFactor + vec3(contrastPivot));

    luminance = luminanceLinear(color);

    if (u_clarity != 0.0) {
      float midMask = smoothstep(0.14, 0.58, luminance) * (1.0 - smoothstep(0.5, 0.9, luminance));
      float targetLum = safeClamp(
        luminance + (luminance - 0.24) * u_clarity * midMask * 0.65,
        0.0,
        1.0
      );

      if (luminance > 0.0001) {
        float clarityScale = targetLum / luminance;
        color = clamp(color * clarityScale, 0.0, 1.0);
      }
    }

    luminance = luminanceLinear(color);
    if (luminance > 0.0001) {
      float mappedLum = applyFilmicLuminance(luminance, u_filmicToe, u_filmicShoulder, u_filmicGamma);
      float filmicScale = mappedLum / luminance;
      color = clamp(color * filmicScale, 0.0, 1.0);
    }

    float warmthAmount = u_warmth / 100.0;
    color = vec3(
      safeClamp(color.r + 0.11 * warmthAmount, 0.0, 1.0),
      safeClamp(color.g + 0.02 * warmthAmount, 0.0, 1.0),
      safeClamp(color.b - 0.10 * warmthAmount, 0.0, 1.0)
    );

    float gray = luminanceLinear(color);
    color = vec3(gray) + (color - vec3(gray)) * u_saturationFactor;
    color = clamp(color, 0.0, 1.0);

    gl_FragColor = vec4(
      safeClamp(linearToSrgb(color.r), 0.0, 1.0),
      safeClamp(linearToSrgb(color.g), 0.0, 1.0),
      safeClamp(linearToSrgb(color.b), 0.0, 1.0),
      1.0
    );
  }
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create shader.');

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'Shader compile failed.';
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();

  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error('Failed to create program.');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'Program link failed.';
    gl.deleteProgram(program);
    throw new Error(message);
  }

  return program;
}

function createPreviewGpuRenderer() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });

  if (!gl) {
    throw new Error('WebGL context is not available.');
  }

  const program = createProgram(gl, PREVIEW_WEBGL_VERTEX_SHADER, PREVIEW_WEBGL_FRAGMENT_SHADER);
  gl.useProgram(program);

  const uniforms = {
    image: gl.getUniformLocation(program, 'u_image'),
    exposureGain: gl.getUniformLocation(program, 'u_exposureGain'),
    contrastFactor: gl.getUniformLocation(program, 'u_contrastFactor'),
    saturationFactor: gl.getUniformLocation(program, 'u_saturationFactor'),
    shadows: gl.getUniformLocation(program, 'u_shadows'),
    highlights: gl.getUniformLocation(program, 'u_highlights'),
    whites: gl.getUniformLocation(program, 'u_whites'),
    blacks: gl.getUniformLocation(program, 'u_blacks'),
    clarity: gl.getUniformLocation(program, 'u_clarity'),
    dehaze: gl.getUniformLocation(program, 'u_dehaze'),
    warmth: gl.getUniformLocation(program, 'u_warmth'),
    filmicToe: gl.getUniformLocation(program, 'u_filmicToe'),
    filmicShoulder: gl.getUniformLocation(program, 'u_filmicShoulder'),
    filmicGamma: gl.getUniformLocation(program, 'u_filmicGamma'),
  };

  const positionBuffer = gl.createBuffer();
  if (!positionBuffer) {
    throw new Error('Failed to create WebGL vertex buffer.');
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1,
      1, -1,
      -1, 1,
      1, 1,
    ]),
    gl.STATIC_DRAW
  );

  const positionLocation = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(positionLocation);
  gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create WebGL texture.');
  }

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(uniforms.image, 0);

  const stagingCanvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(1, 1)
    : document.createElement('canvas');
  const stagingCtx = stagingCanvas.getContext('2d');
  if (!stagingCtx) {
    throw new Error('Could not create staging 2D context for GPU preview.');
  }

  const render = (image, adjustments, jpegQuality = 0.92, options = {}) => {
    const fastMode = Boolean(options.fastMode);
    const maxDimension = Number(options.maxDimension || 0);
    const sourceScale = maxDimension > 0
      ? Math.min(maxDimension / Math.max(image.width, image.height), 1)
      : 1;
    const sourceWidth = Math.max(1, Math.round(image.width * sourceScale));
    const sourceHeight = Math.max(1, Math.round(image.height * sourceScale));
    const rotation = adjustments.rotation % 360;
    const rotate90 = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
    const outputWidth = rotate90 ? sourceHeight : sourceWidth;
    const outputHeight = rotate90 ? sourceWidth : sourceHeight;

    stagingCanvas.width = outputWidth;
    stagingCanvas.height = outputHeight;
    stagingCtx.setTransform(1, 0, 0, 1, 0, 0);
    stagingCtx.clearRect(0, 0, outputWidth, outputHeight);
    stagingCtx.save();
    stagingCtx.translate(outputWidth / 2, outputHeight / 2);
    stagingCtx.rotate((rotation * Math.PI) / 180);
    stagingCtx.drawImage(
      image,
      -sourceWidth / 2,
      -sourceHeight / 2,
      sourceWidth,
      sourceHeight
    );
    stagingCtx.restore();

    canvas.width = outputWidth;
    canvas.height = outputHeight;
    gl.viewport(0, 0, outputWidth, outputHeight);

    const exposure = clamp(adjustments.exposure ?? 0, -400, 400);
    const contrastValue = clamp(adjustments.contrast ?? 0, -100, 100);
    const clarity = (adjustments.clarity || 0) / 100;
    const dehaze = (adjustments.dehaze || 0) / 100;

    const exposureGain = Math.pow(2, exposure / 100);
    const contrastFactor = 1 + (contrastValue / 100) * 0.72;
    const saturationFactor = 1 + (clamp(adjustments.saturation ?? 0, -100, 100) / 100) * 0.85;
    const shadows = (adjustments.shadows || 0) / 100;
    const highlights = (adjustments.highlights || 0) / 100;
    const whites = (adjustments.whites || 0) / 100;
    const blacks = (adjustments.blacks || 0) / 100;
    const filmicToe = clamp(
      Math.max(0, -blacks) * 0.018 + Math.max(0, dehaze) * 0.006,
      0,
      0.03
    );
    const filmicShoulder = clamp(
      Math.max(0, -highlights) * 0.08 + Math.max(0, whites) * 0.05,
      0,
      0.22
    );
    const filmicGamma = clamp(
      1 + Math.max(0, contrastValue / 100) * 0.05,
      1,
      1.06
    );

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, stagingCanvas);

    gl.uniform1f(uniforms.exposureGain, exposureGain);
    gl.uniform1f(uniforms.contrastFactor, contrastFactor);
    gl.uniform1f(uniforms.saturationFactor, saturationFactor);
    gl.uniform1f(uniforms.shadows, shadows);
    gl.uniform1f(uniforms.highlights, highlights);
    gl.uniform1f(uniforms.whites, whites);
    gl.uniform1f(uniforms.blacks, blacks);
    gl.uniform1f(uniforms.clarity, clarity);
    gl.uniform1f(uniforms.dehaze, dehaze);
    gl.uniform1f(uniforms.warmth, adjustments.warmth || 0);
    gl.uniform1f(uniforms.filmicToe, filmicToe);
    gl.uniform1f(uniforms.filmicShoulder, filmicShoulder);
    gl.uniform1f(uniforms.filmicGamma, filmicGamma);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    return canvas.toDataURL('image/jpeg', clamp(jpegQuality, fastMode ? 0.6 : 0.4, 1));
  };

  return { render };
}

function getPreviewGpuRenderer() {
  if (previewGpu.disabled) return null;
  if (previewGpu.renderer) return previewGpu.renderer;
  if (previewGpu.attemptedInit) return null;

  previewGpu.attemptedInit = true;
  try {
    previewGpu.renderer = createPreviewGpuRenderer();
    previewGpu.available = true;
    previewGpu.backend = 'webgl';
    console.log('[PREVIEW-GPU] WebGL preview acceleration enabled.');
    return previewGpu.renderer;
  } catch (error) {
    previewGpu.available = false;
    previewGpu.failureReason = error.message || String(error);
    previewGpu.disabled = true;
    console.warn(`[PREVIEW-GPU] Disabled: ${previewGpu.failureReason}`);
    return null;
  }
}

function canUseGpuPreview(adjustments, options = {}) {
  if (options.allowGpu !== true) return false;

  if (options.forceFastGpu === true) {
    if (!options.fastMode) return false;
    if ((adjustments.sharpen || 0) > 0 || (adjustments.denoise || 0) > 0) return false;
    return Boolean(getPreviewGpuRenderer());
  }

  if (GPU_PREVIEW_MODE !== 'experimental_fast') return false;

  // Even when enabled experimentally, keep full-quality and export paths on CPU.
  if (!options.fastMode) return false;
  if ((adjustments.sharpen || 0) > 0 || (adjustments.denoise || 0) > 0) return false;

  return Boolean(getPreviewGpuRenderer());
}

function processPreviewToDataUrl(image, adjustments, jpegQuality = 0.92, options = {}) {
  if (canUseGpuPreview(adjustments, options)) {
    try {
      return previewGpu.renderer.render(image, adjustments, jpegQuality, options);
    } catch (error) {
      previewGpu.disabled = true;
      previewGpu.failureReason = error.message || String(error);
      console.warn(`[PREVIEW-GPU] Falling back to CPU: ${previewGpu.failureReason}`);
    }
  }

  return processImageToDataUrl(image, adjustments, jpegQuality, options);
}

// All edit controls in renderer apply to preview-backed images only.
function processImageToDataUrl(image, adjustments, jpegQuality = 0.92, options = {}) {
  if (!previewPipeline?.processImageToDataUrl) {
    throw new Error('Preview pipeline is unavailable.');
  }

  return previewPipeline.processImageToDataUrl(image, adjustments, jpegQuality, options);
}

function analysisStatsForPhoto(photo) {
  if (!photo) return buildFallbackImageStats(false);
  if (photo.analysisStats) return photo.analysisStats;
  return buildFallbackImageStats(Boolean(photo.isHdrMerged));
}

async function buildPreview(
  photo,
  {
    fastMode = false,
    adjustmentsSnapshot = null,
    jpegQuality = null,
  } = {}
) {
  const img = await getPhotoSourceImage(photo);
  const adjustments = adjustmentsSnapshot || resolveRenderAdjustments(photo.adjustments);
  const quality = jpegQuality == null ? (fastMode ? 0.64 : 0.92) : jpegQuality;
  const stages = Array.from(document.querySelectorAll('.image-stage'));
  const stageLongest = stages.reduce((max, stage) => {
    return Math.max(max, stage?.clientWidth || 0, stage?.clientHeight || 0);
  }, 0);
  const dpr = clamp(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1, 1, 2);
  const zoomFactor = clamp(state.zoom || 1, 1, 2.5);
  const sourceLongest = Math.max(img.width || 0, img.height || 0);
  const isCompareMode = state.preview.mode === 'split' || state.preview.mode === 'slider';
  const isHdrSettledPreview = Boolean(photo?.isHdrMerged);
  const settledScale = isHdrSettledPreview
    ? (1.15 + (zoomFactor - 1) * 0.5)
    : (1.32 + (zoomFactor - 1) * 0.65);
  const settledPreviewBaseMaxDimension = clamp(
    Math.round((stageLongest || 1200) * dpr * settledScale),
    isHdrSettledPreview ? 1100 : 1300,
    isHdrSettledPreview ? 2500 : 3000
  );
  // In split/slider compare, before side uses full-size source pixels.
  // Keep settled after-side preview at full source resolution for matched sharpness.
  const settledPreviewMaxDimension = (!fastMode && isHdrSettledPreview && isCompareMode && sourceLongest > 0)
    ? sourceLongest
    : settledPreviewBaseMaxDimension;

  return processPreviewToDataUrl(
    img,
    adjustments,
    quality,
    fastMode
      ? {
        fastMode: true,
        maxDimension: FAST_PREVIEW_MAX_DIMENSION,
        allowGpu: true,
        forceFastGpu: Boolean(photo?.isHdrMerged),
      }
      : { allowGpu: false, maxDimension: settledPreviewMaxDimension }
  );
}

async function fitPreviewToStage() {
  const photo = selectedPhoto();
  const stage = document.querySelector('.image-stage');

  if (!photo || !stage) {
    state.fitZoom = 1;
    resetView();
    return;
  }

  const selectedIdAtStart = photo.id;

  try {
    const sourceImage = await getPhotoSourceImage(photo);
    if (!sourceImage || selectedPhoto()?.id !== selectedIdAtStart) return;

    const rotation = (photo.adjustments.rotation || 0) % 360;
    const rotated = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;

    const imageWidth = rotated ? sourceImage.height : sourceImage.width;
    const imageHeight = rotated ? sourceImage.width : sourceImage.height;

    const scaleX = stage.clientWidth / imageWidth;
    const scaleY = stage.clientHeight / imageHeight;

    // Keep a tiny safety margin so "Fit" reliably shows the full frame.
    const fittedZoom = clamp(Math.min(scaleX, scaleY) * 0.985, 0.03, 8);

    state.fitZoom = fittedZoom;
    state.zoom = fittedZoom;
    state.panX = 0;
    state.panY = 0;

    renderPreview();
    queueViewportQualityRefresh({ debounceMs: 120 });
  } catch (error) {
    console.warn('Could not fit preview to stage:', error);
  }
}

async function refreshSelectedPreview({
  autoFit = false,
  fastMode = false,
  fullRender = true,
  expectedPhotoId = null,
  expectedVersion = null,
} = {}) {
  const currentPhoto = selectedPhoto();

  if (!currentPhoto) {
    render();
    return;
  }

  const targetPhotoId = expectedPhotoId || currentPhoto.id;
  const versionAtStart = expectedVersion == null
    ? (currentPhoto.adjustVersion || 0)
    : expectedVersion;
  const adjustmentsSnapshot = resolveRenderAdjustments(currentPhoto.adjustments);
  let nextPreviewUrl = null;
  let markedFastInFlight = false;

  if (fastMode) {
    state.preview.perf.fastInFlight = true;
    markedFastInFlight = true;
  }

  try {
    nextPreviewUrl = await buildPreview(currentPhoto, {
      fastMode,
      adjustmentsSnapshot,
    });

    const selectedAfterRender = selectedPhoto();
    if (!selectedAfterRender || selectedAfterRender.id !== targetPhotoId) return;
    if ((selectedAfterRender.adjustVersion || 0) !== versionAtStart) return;

    if (fastMode) {
      selectedAfterRender.fastProcessedUrl = nextPreviewUrl;
    } else {
      selectedAfterRender.processedUrl = nextPreviewUrl;
      selectedAfterRender.fastProcessedUrl = null;
      selectedAfterRender.histogramKey = null;
      scheduleHistogramRefresh({ force: true, delayMs: 0 });
    }

    if (fullRender) {
      render();
    } else {
      if (!updateLivePreviewImageSources(selectedAfterRender)) {
        renderPreview();
      }
      if (!fastMode) {
        updateSelectedThumbImage();
      }
    }

    if (autoFit && !fastMode) {
      setTimeout(() => {
        fitPreviewToStage();
      }, 0);
    }
  } catch (error) {
    console.error(error);
  } finally {
    if (markedFastInFlight) {
      state.preview.perf.fastInFlight = false;
      if (state.preview.perf.pendingFast) {
        state.preview.perf.pendingFast = false;
        queueSelectedPreviewRender({
          fastMode: true,
          debounceMs: 0,
          fullRender: false,
        });
      }
    }
  }
}

async function refreshAllThumbnails() {
  for (const photo of state.photos) {
    if (!photo.processedUrl) {
      try {
        const previewUrl = await buildPreview(photo, { fastMode: false });
        photo.processedUrl = previewUrl;
        photo.fastProcessedUrl = null;
      } catch (error) {
        console.error(error);
      }
    }
  }
}

async function addNormalizedItems(normalizedItems, { suppressDuplicateAlert = false } = {}) {
  if (!normalizedItems?.length) {
    if (!suppressDuplicateAlert) {
      alert('No supported images were found.');
    }
    return;
  }

  const existing = new Set(state.photos.map((photo) => photo.filePath));

  const newItems = normalizedItems
    .filter((item) => !existing.has(item.originalPath))
    .map((item, index) => {
      const isHdrMerged = Boolean(item.isMergedHdr || item.hdrMetadata);
      const baseAdjustments = { ...defaultAdjustments };

      return {
        id: `${item.originalPath}-${Date.now()}-${index}`,
        filePath: item.originalPath,
        workingPath: item.workingPath,
        isRaw: Boolean(item.isRaw),
        isHdrMerged,
        hdrMetadata: item.hdrMetadata || null,
        exportBaseName: item.exportBaseName || pathBasenameWithoutExt(item.originalPath),
        name: pathBasename(item.originalPath),
        originalUrl: filePathToUrl(item.workingPath),
        processedUrl: null,
        fastProcessedUrl: null,
        sourceImage: null,
        sourceImagePromise: null,
        analysisStats: null,
        analysisPromise: null,
        histogramKey: null,
        histogramBins: null,
        adjustVersion: 0,
        adjustments: baseAdjustments,
      };
    });

  if (!newItems.length) {
    if (!suppressDuplicateAlert) {
      alert('Those photos are already loaded.');
    }
    return;
  }

  state.photos.push(...newItems);

  if (!state.selectedId && state.photos[0]) {
    state.selectedId = state.photos[0].id;
    state.selectedPhotoIds = new Set([state.selectedId]);
    state.selectionAnchorId = state.selectedId;
  }
  normalizeLibrarySelectionState();

  resetView();
  render();
  await refreshSelectedPreview({ autoFit: true });
  await refreshAllThumbnails();
  render();
}

async function addFiles(paths, { skipRawDecoderCheck = false, suppressDuplicateAlert = false } = {}) {
  try {
    const rawPipelineStatus = skipRawDecoderCheck
      ? { ok: true }
      : await window.aceApi.checkRawPipeline();
    const looksLikeDngImport = (paths || []).some((entry) => /\.dng$/i.test(entry || ''));

    if (!skipRawDecoderCheck && looksLikeDngImport && rawPipelineStatus?.dngPreferredAvailable === false) {
      alert(
        'DJI DNG import blocked.\n\n' +
        (rawPipelineStatus.warning
          || 'Adobe-compatible DNG helper is required for reliable DJI DNG conversion.')
      );
      return;
    }

    const normalized = await window.aceApi.normalizePaths(paths || []);

    if (!normalized || !normalized.length) {
      const looksLikeRaw = (paths || []).some((entry) => isRawPath(entry));

      if (looksLikeRaw) {
        alert(
          'RAW import failed.\n\n' +
          (rawPipelineStatus.ok
            ? 'A RAW decoder was detected, but at least one RAW file could not be converted. Check the terminal logs for details.'
            : `No RAW decoder is available.\n\n${rawPipelineStatus.error || 'Unknown RAW decoder error.'}`)
        );
      } else if (!suppressDuplicateAlert) {
        alert('No supported image files were found.');
      }

      return;
    }

    await addNormalizedItems(normalized, { suppressDuplicateAlert });
  } catch (error) {
    console.error(error);
    alert(`Import failed.\n\n${error.message || error}`);
  }
}

function updateAdjustments(updates, { interactive = false, source = 'manual' } = {}) {
  const photo = selectedPhoto();
  if (!photo) return;

  if (source !== 'preset' && state.presets.activePreset !== null) {
    state.presets.activePreset = null;
    syncPresetButtonState();
  }
  if (source !== 'preset' && state.presets.selectedOptionId) {
    state.presets.selectedOptionId = '';
    syncPresetDropdownOptions();
  }

  if (state.preview.applyToAll) {
    for (const item of state.photos) {
      item.adjustments = { ...item.adjustments, ...updates };
      markPhotoAdjustmentsDirty(item);
    }
  } else {
    photo.adjustments = { ...photo.adjustments, ...updates };
    markPhotoAdjustmentsDirty(photo);
  }

  state.preview.perf.lastInteractionAt = Date.now();

  if (interactive) {
    if (state.preview.perf.fullTimer) {
      clearTimeout(state.preview.perf.fullTimer);
      state.preview.perf.fullTimer = null;
    }

    queueSelectedPreviewRender({
      fastMode: true,
      debounceMs: 0,
      fullRender: false,
    });
    return;
  }

  if (state.preview.perf.fastTimer) {
    clearTimeout(state.preview.perf.fastTimer);
    state.preview.perf.fastTimer = null;
  }
  if (state.preview.perf.fullTimer) {
    clearTimeout(state.preview.perf.fullTimer);
    state.preview.perf.fullTimer = null;
  }

  renderControls();
  const shouldDebounceSettledRender = source === 'manual';
  if (shouldDebounceSettledRender) {
    queueSelectedPreviewRender({
      fastMode: true,
      debounceMs: 0,
      fullRender: false,
    });
  }
  queueSelectedPreviewRender({
    fastMode: false,
    debounceMs: shouldDebounceSettledRender ? SETTLED_PREVIEW_DELAY_MS : 0,
    fullRender: false,
  });
}

function presetAdjustmentsForPhoto(presetName, photo) {
  const isHdrMerged = Boolean(photo?.isHdrMerged);
  const stats = analysisStatsForPhoto(photo);
  const profile = ['natural', 'real-estate', 'punchy', 'soft'].includes(presetName)
    ? presetName
    : 'natural';
  return estimateAutoAdjustments(stats, profile, {
    isHdrMerged,
    rotation: photo?.adjustments?.rotation || 0,
  });
}

async function applyPreset(presetName) {
  const photo = selectedPhoto();
  if (!photo) return;

  const targetPhotoId = photo.id;
  state.presets.activePreset = presetName;
  state.presets.selectedOptionId = '';
  syncPresetDropdownOptions();
  syncPresetButtonState();

  const latest = selectedPhoto();
  if (!latest || latest.id !== targetPhotoId) return;

  const presetAdjustments = presetAdjustmentsForPhoto(presetName, latest);
  presetAdjustments.rotation = latest.adjustments?.rotation || 0;
  updateAdjustments(presetAdjustments, { source: 'preset' });
  syncPresetButtonState();
}

function normalizePresetAdjustmentValue(key, rawValue) {
  if (editorCore?.normalizePresetAdjustmentValue) {
    return editorCore.normalizePresetAdjustmentValue(key, rawValue);
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return defaultAdjustments[key] || 0;

  if (key === 'exposure') {
    // Stored exposure values are in stops (e.g. 0.35). Support legacy slider-scale values too.
    if (Math.abs(parsed) <= 8) return Math.round(parsed * 100);
    return Math.round(parsed);
  }

  if (key === 'toneCurve') {
    return clamp(Math.round(parsed), 0, 100);
  }

  return Math.round(parsed);
}

function presetAdjustmentsFromValues(values = {}) {
  if (editorCore?.presetAdjustmentsFromValues) {
    return editorCore.presetAdjustmentsFromValues(values);
  }

  const out = {};
  PRESET_ADJUSTMENT_KEYS.forEach((key) => {
    out[key] = normalizePresetAdjustmentValue(key, values[key]);
  });
  return out;
}

function presetStoragePayloadFromAdjustments(name, adjustments = {}) {
  if (editorCore?.presetStoragePayloadFromAdjustments) {
    return editorCore.presetStoragePayloadFromAdjustments(name, adjustments);
  }

  const payload = {
    name: String(name || '').trim(),
  };

  PRESET_ADJUSTMENT_KEYS.forEach((key) => {
    const value = Number(adjustments[key] ?? defaultAdjustments[key] ?? 0);
    payload[key] = key === 'exposure'
      ? Number((value / 100).toFixed(2))
      : Math.round(value);
  });

  return payload;
}

function userPresetOptionId(name) {
  return `user:${encodeURIComponent(String(name || ''))}`;
}

function dropdownPresetEntries() {
  const builtIns = BUILTIN_DROPDOWN_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    adjustments: presetAdjustmentsFromValues(preset.adjustments),
    source: 'builtin',
  }));

  const userPresets = state.presets.userSavedPresets.map((preset) => ({
    id: userPresetOptionId(preset.name),
    name: preset.name,
    adjustments: preset.adjustments,
    source: 'user',
  }));

  return [...builtIns, ...userPresets];
}

function syncPresetDropdownOptions() {
  if (!el.presetDropdownBtn || !el.presetDropdownMenu) return;

  const entries = dropdownPresetEntries();
  const hasPhoto = Boolean(selectedPhoto());
  if (state.presets.selectedOptionId && !entries.some((entry) => entry.id === state.presets.selectedOptionId)) {
    state.presets.selectedOptionId = '';
  }

  if (!entries.length) {
    el.presetDropdownMenu.innerHTML = '<div class="preset-dropdown-empty">No presets available.</div>';
  } else {
    el.presetDropdownMenu.innerHTML = entries.map((entry) => {
      const isSelected = entry.id === state.presets.selectedOptionId;
      const deleteButton = entry.source === 'user'
        ? `<button type="button" class="preset-dropdown-delete quiet" data-delete-preset="${escapeHtml(encodeURIComponent(entry.name))}">Delete</button>`
        : '';
      return `
        <div class="preset-dropdown-row">
          <button
            type="button"
            class="preset-dropdown-item ${isSelected ? 'is-selected' : ''}"
            data-preset-id="${escapeHtml(entry.id)}"
          >${escapeHtml(entry.name)}</button>
          ${deleteButton}
        </div>
      `;
    }).join('');
  }

  el.presetDropdownBtn.disabled = !hasPhoto;
  if (el.savePresetBtn) {
    el.savePresetBtn.disabled = !hasPhoto;
  }
  if (isPresetDropdownOpen()) {
    positionPresetDropdownOverlay();
  }
}

function applyDropdownPresetById(optionId) {
  const photo = selectedPhoto();
  if (!photo || !optionId) return;

  const targetPreset = dropdownPresetEntries().find((entry) => entry.id === optionId);
  if (!targetPreset) return;

  state.presets.activePreset = null;
  syncPresetButtonState();
  state.presets.selectedOptionId = optionId;
  updateAdjustments(targetPreset.adjustments, { source: 'preset' });
}

function isPresetDropdownOpen() {
  return Boolean(el.presetDropdownMenu && !el.presetDropdownMenu.classList.contains('hidden'));
}

function positionPresetDropdownOverlay() {
  if (!el.presetDropdownMenu || !el.presetDropdownBtn) return;
  if (!isPresetDropdownOpen()) return;

  const buttonRect = el.presetDropdownBtn.getBoundingClientRect();
  const viewportPadding = 8;
  const menuGap = 2;
  const preferredMaxHeight = 220;
  const menuWidth = Math.max(1, Math.round(buttonRect.width));
  const naturalHeight = Math.min(
    Math.max(1, Math.round(el.presetDropdownMenu.scrollHeight || preferredMaxHeight)),
    preferredMaxHeight
  );
  const availableBelow = Math.max(0, window.innerHeight - buttonRect.bottom - menuGap - viewportPadding);
  const availableAbove = Math.max(0, buttonRect.top - menuGap - viewportPadding);
  const placeAbove = availableBelow < Math.min(140, naturalHeight) && availableAbove > availableBelow;
  const usableHeight = placeAbove ? availableAbove : availableBelow;
  const overlayMaxHeight = Math.max(100, Math.min(preferredMaxHeight, usableHeight || preferredMaxHeight));
  const renderHeight = Math.min(naturalHeight, overlayMaxHeight);

  const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
  const left = clamp(Math.round(buttonRect.left), viewportPadding, maxLeft);

  let top = placeAbove
    ? Math.round(buttonRect.top - menuGap - renderHeight)
    : Math.round(buttonRect.bottom + menuGap);

  if (!placeAbove && top + renderHeight > window.innerHeight - viewportPadding) {
    top = Math.max(viewportPadding, window.innerHeight - viewportPadding - renderHeight);
  }
  if (placeAbove && top < viewportPadding) {
    top = viewportPadding;
  }

  el.presetDropdownMenu.style.width = `${menuWidth}px`;
  el.presetDropdownMenu.style.maxHeight = `${Math.round(overlayMaxHeight)}px`;
  el.presetDropdownMenu.style.bottom = '';

  // Some app shells establish a non-viewport containing block for fixed overlays.
  // Measure that origin so viewport-based trigger rects map to the same coordinate space.
  el.presetDropdownMenu.style.left = '0px';
  el.presetDropdownMenu.style.top = '0px';
  const overlayOriginRect = el.presetDropdownMenu.getBoundingClientRect();
  const originOffsetLeft = Math.round(overlayOriginRect.left);
  const originOffsetTop = Math.round(overlayOriginRect.top);

  el.presetDropdownMenu.style.left = `${left - originOffsetLeft}px`;
  el.presetDropdownMenu.style.top = `${top - originOffsetTop}px`;
}

function closePresetDropdown() {
  if (!el.presetDropdownMenu || !el.presetDropdownBtn) return;
  el.presetDropdownMenu.classList.add('hidden');
  el.presetDropdownBtn.setAttribute('aria-expanded', 'false');
  el.presetDropdownMenu.style.top = '';
  el.presetDropdownMenu.style.left = '';
  el.presetDropdownMenu.style.width = '';
  el.presetDropdownMenu.style.maxHeight = '';
}

function openPresetDropdown() {
  if (!el.presetDropdownMenu || !el.presetDropdownBtn) return;
  if (el.presetDropdownBtn.disabled) return;
  syncPresetDropdownOptions();
  el.presetDropdownMenu.classList.remove('hidden');
  el.presetDropdownBtn.setAttribute('aria-expanded', 'true');
  positionPresetDropdownOverlay();
  requestAnimationFrame(() => {
    positionPresetDropdownOverlay();
  });
}

function togglePresetDropdown() {
  if (isPresetDropdownOpen()) {
    closePresetDropdown();
  } else {
    openPresetDropdown();
  }
}

async function deleteUserPresetByName(name) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return;
  if (BUILTIN_PRESET_NAME_SET.has(trimmedName.toLowerCase())) {
    alert('Built-in presets cannot be deleted.');
    return;
  }
  if (!window.aceApi?.deleteCleanupPreset) {
    alert('Preset delete API is unavailable.');
    return;
  }

  const confirmed = window.confirm(`Delete preset "${trimmedName}"?`);
  if (!confirmed) return;

  try {
    const response = await window.aceApi.deleteCleanupPreset(trimmedName);
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not delete preset.');
    }

    state.presets.userSavedPresets = (response.presets || [])
      .map((preset) => {
        const presetName = String(preset?.name || '').trim();
        if (!presetName || RESERVED_PRESET_NAME_SET.has(presetName.toLowerCase())) return null;
        return {
          name: presetName,
          adjustments: presetAdjustmentsFromValues(preset),
        };
      })
      .filter(Boolean);

    const deletedId = userPresetOptionId(trimmedName);
    if (state.presets.selectedOptionId === deletedId) {
      state.presets.selectedOptionId = '';
    }
    syncPresetDropdownOptions();
  } catch (error) {
    console.error(error);
    alert(`Could not delete preset.\n\n${error.message || error}`);
  }
}

async function loadUserSavedPresets() {
  if (!window.aceApi?.loadCleanupPresets) return;

  try {
    const response = await window.aceApi.loadCleanupPresets();
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not load cleanup presets.');
    }

    state.presets.userSavedPresets = (response.presets || [])
      .map((preset) => {
        const name = String(preset?.name || '').trim();
        if (!name || RESERVED_PRESET_NAME_SET.has(name.toLowerCase())) return null;
        return {
          name,
          adjustments: presetAdjustmentsFromValues(preset),
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.warn('Cleanup preset load failed:', error);
    state.presets.userSavedPresets = [];
  }

  syncPresetDropdownOptions();
}

function isSavePresetModalOpen() {
  return Boolean(el.savePresetModal && !el.savePresetModal.classList.contains('hidden'));
}

function openSavePresetModal() {
  if (!selectedPhoto()) return;
  if (!el.savePresetModal || !el.presetNameInput) return;

  closePresetDropdown();
  el.savePresetModal.classList.remove('hidden');
  el.savePresetModal.setAttribute('aria-hidden', 'false');
  el.presetNameInput.value = '';

  setTimeout(() => {
    el.presetNameInput?.focus();
  }, 0);
}

function closeSavePresetModal() {
  if (!el.savePresetModal) return;
  el.savePresetModal.classList.add('hidden');
  el.savePresetModal.setAttribute('aria-hidden', 'true');
}

async function savePresetFromModal() {
  const photo = selectedPhoto();
  if (!photo) {
    closeSavePresetModal();
    return;
  }

  const name = String(el.presetNameInput?.value || '').trim();
  if (!name) {
    alert('Please enter a preset name.');
    el.presetNameInput?.focus();
    return;
  }
  if (RESERVED_PRESET_NAME_SET.has(name.toLowerCase())) {
    alert('That name is reserved for a built-in preset. Please choose a different preset name.');
    el.presetNameInput?.focus();
    return;
  }

  if (!window.aceApi?.saveCleanupPreset) {
    alert('Preset save API is unavailable.');
    return;
  }

  const payload = presetStoragePayloadFromAdjustments(name, photo.adjustments || defaultAdjustments);

  try {
    const response = await window.aceApi.saveCleanupPreset(payload);
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not save preset.');
    }

    state.presets.userSavedPresets = (response.presets || [])
      .map((preset) => {
        const presetName = String(preset?.name || '').trim();
        if (!presetName || RESERVED_PRESET_NAME_SET.has(presetName.toLowerCase())) return null;
        return {
          name: presetName,
          adjustments: presetAdjustmentsFromValues(preset),
        };
      })
      .filter(Boolean);

    const savedName = state.presets.userSavedPresets.find(
      (preset) => preset.name.toLowerCase() === payload.name.toLowerCase()
    )?.name || payload.name;
    state.presets.selectedOptionId = userPresetOptionId(savedName);
    closeSavePresetModal();
    syncPresetDropdownOptions();
  } catch (error) {
    console.error(error);
    alert(`Could not save preset.\n\n${error.message || error}`);
  }
}

function formatSignedValue(value) {
  if (value > 0) return `+${value}`;
  return String(value);
}

function formatControlValue(controlKey, value) {
  if (controlKey === 'exposure') {
    const stops = (value || 0) / 100;
    return `${stops > 0 ? '+' : ''}${stops.toFixed(2)}`;
  }

  if (['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'clarity', 'dehaze', 'vibrance', 'saturation', 'warmth'].includes(controlKey)) {
    return formatSignedValue(value || 0);
  }

  return String(value || 0);
}

function renderControls() {
  const current = getCurrentAdjustments();

  el.controls.innerHTML = controlsConfig.map((control) => {
    const value = current[control.key] ?? defaultAdjustments[control.key];

    return `
      <div class="control">
        <div class="control-head">
          <span class="control-label">${escapeHtml(control.label)}</span>
          <input
            class="control-slider"
            type="range"
            data-key="${escapeHtml(control.key)}"
            min="${control.min}"
            max="${control.max}"
            step="${control.step || 1}"
            value="${value}"
            ${!selectedPhoto() ? 'disabled' : ''}
          />
          <span class="control-value" data-control-value="value">${escapeHtml(formatControlValue(control.key, value))}</span>
        </div>
      </div>
    `;
  }).join('');

  el.controls.querySelectorAll('input[type="range"]').forEach((input) => {
    input.addEventListener('input', (event) => {
      const key = event.target.dataset.key;
      const value = Number(event.target.value);
      const valueLabel = event.target
        .closest('.control')
        ?.querySelector('[data-control-value="value"]');
      if (valueLabel) {
        valueLabel.textContent = formatControlValue(key, value);
      }

      updateAdjustments({ [key]: value }, { interactive: true });
    });

    input.addEventListener('change', (event) => {
      const key = event.target.dataset.key;
      const value = Number(event.target.value);
      updateAdjustments({ [key]: value }, { interactive: false });
    });
  });
}

function renderPhotoList() {
  el.photoCount.textContent = String(state.photos.length);
  normalizeLibrarySelectionState();

  if (!state.photos.length) {
    el.photoList.innerHTML = `
      <div style="padding:16px;border:1px solid var(--border);border-radius:18px;color:var(--muted);background:rgba(255,255,255,.02);font-size:13px;">
        No photos loaded yet. Use Add Photos, Add Folder, Add HDR Folder, or drag files from Finder.
      </div>
    `;
    return;
  }

  el.photoList.innerHTML = state.photos.map((photo) => {
    const tags = [];

    if (photo.isRaw) tags.push({ label: 'RAW->TIFF', className: '' });
    if (photo.isHdrMerged) {
      const sourceCount = photo.hdrMetadata?.sourceCount || photo.hdrMetadata?.sourcePaths?.length || '?';
      tags.push({
        label: 'Merged 16-bit TIFF',
        className: 'merged',
      });
      tags.push({
        label: `${sourceCount} source`,
        className: 'meta',
      });
    }

    const tagsHtml = tags.length
      ? `<div class="photo-tags">${tags.map((tag) => `<span class="photo-tag ${escapeHtml(tag.className || '')}">${escapeHtml(tag.label)}</span>`).join('')}</div>`
      : '';
    const isPrimary = photo.id === state.selectedId;
    const isSelected = state.selectedPhotoIds.has(photo.id);
    const className = [
      'photo-item',
      isSelected ? 'selected' : '',
      isPrimary ? 'active' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${escapeHtml(className)}" data-id="${escapeHtml(photo.id)}" tabindex="0" role="button" aria-selected="${isSelected ? 'true' : 'false'}">
        <img class="thumb" src="${escapeHtml(photoPreviewUrl(photo))}" alt="" />
        <div class="meta">
          <div class="name">${escapeHtml(photo.name)}</div>
          <div class="sub">${escapeHtml(parentName(photo.filePath))}</div>
          ${tagsHtml}
        </div>
        <button class="remove-btn" type="button" data-remove="${escapeHtml(photo.id)}">✕</button>
      </div>
    `;
  }).join('');

  el.photoList.querySelectorAll('.photo-item').forEach((item) => {
    item.addEventListener('click', async (event) => {
      if (event.target.closest('[data-remove]')) return;
      state.library.interactionActive = true;
      const { selectionChanged, primaryChanged } = applyLibrarySelection(item.dataset.id, event);
      if (!selectionChanged && !primaryChanged) return;
      focusLibraryItem(item);

      if (primaryChanged) {
        clearPreviewTimers();
        state.presets.activePreset = null;
        resetView();
        render();
        await refreshSelectedPreview({ autoFit: true });
        return;
      }

      render();
    });

    item.addEventListener('keydown', async (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      state.library.interactionActive = true;
      const { selectionChanged, primaryChanged } = applyLibrarySelection(item.dataset.id, {});
      if (!selectionChanged && !primaryChanged) return;
      focusLibraryItem(item);

      clearPreviewTimers();
      state.presets.activePreset = null;
      resetView();
      render();
      await refreshSelectedPreview({ autoFit: true });
    });
  });

  el.photoList.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();

      const id = button.dataset.remove;
      const removedPhoto = state.photos.find((photo) => photo.id === id);

      state.photos = state.photos.filter((photo) => photo.id !== id);
      state.selectedPhotoIds.delete(id);
      if (state.selectionAnchorId === id) {
        state.selectionAnchorId = null;
      }

      if (removedPhoto?.isHdrMerged) {
        state.library.loadedMergedPaths.delete(removedPhoto.filePath);
      }

      if (state.selectedId === id) {
        clearPreviewTimers();
        const fallbackSelected = state.photos.find((photo) => state.selectedPhotoIds.has(photo.id));
        state.selectedId = fallbackSelected?.id || state.photos[0]?.id || null;
        state.presets.activePreset = null;
      }
      normalizeLibrarySelectionState();

      render();

      if (state.selectedId) {
        refreshSelectedPreview({ autoFit: true });
      }
    });
  });
}

async function handleLibrarySelectAllShortcut(event) {
  const key = String(event.key || '').toLowerCase();
  const isSelectAllShortcut = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'a';
  if (!isSelectAllShortcut) return;

  const activeElement = document.activeElement;
  const target = event.target;
  const targetWithinLibrary = Boolean(target?.closest?.('#photoList'));
  const focusWithinLibrary = Boolean(activeElement?.closest?.('#photoList'));
  const libraryContextActive = targetWithinLibrary || focusWithinLibrary || state.library.interactionActive;

  if (!libraryContextActive) return;

  if (
    activeElement
    && (activeElement.tagName === 'INPUT'
      || activeElement.tagName === 'TEXTAREA'
      || activeElement.tagName === 'SELECT'
      || activeElement.isContentEditable)
  ) {
    return;
  }

  event.preventDefault();

  const { changed, primaryChanged } = selectAllLibraryPhotos();
  if (!changed && !primaryChanged) return;

  if (primaryChanged) {
    clearPreviewTimers();
    state.presets.activePreset = null;
    resetView();
  }

  render();

  if (primaryChanged) {
    await refreshSelectedPreview({ autoFit: true });
  }
}

function clearLibraryFlow() {
  if (!state.photos.length) return;

  const confirmClear = window.confirm(
    `Delete all ${state.photos.length} item(s) from Library?\n\nThis clears current selection and preview state.`
  );
  if (!confirmClear) return;

  clearPreviewTimers();
  state.photos = [];
  state.selectedId = null;
  state.selectedPhotoIds = new Set();
  state.selectionAnchorId = null;
  state.library.interactionActive = false;
  state.presets.activePreset = null;
  state.presets.selectedOptionId = '';
  state.preview.applyToAll = false;
  state.library.loadedMergedPaths.clear();
  closePresetDropdown();
  closeSavePresetModal();
  resetView();
  render();
}

function compareRenderStateForPhoto(photo) {
  if (editorCore?.buildCompareRenderState) {
    return editorCore.buildCompareRenderState({
      photo,
      processedUrl: photoPreviewUrl(photo),
      sliderPosition: state.preview.sliderPosition,
    });
  }

  const reveal = clamp(Number(state.preview.sliderPosition) || 50, 0, 100);
  return {
    split: {
      originalLabel: photo.isHdrMerged ? 'Merged 16-bit TIFF Master' : 'Original',
      cleanedLabel: photo.isHdrMerged ? 'Current Edit Preview' : 'Cleaned Preview',
      originalSrc: photo.originalUrl,
      cleanedSrc: photoPreviewUrl(photo),
    },
    slider: {
      label: photo.isHdrMerged
        ? 'Merged 16-bit TIFF Master / Current Edit Preview'
        : 'Before / After Slider',
      reveal,
      originalSrc: photo.originalUrl,
      cleanedSrc: photoPreviewUrl(photo),
    },
  };
}

function renderSplitPreview(photo, transform) {
  const compareState = compareRenderStateForPhoto(photo);
  const originalLabel = compareState.split.originalLabel;
  const cleanedLabel = compareState.split.cleanedLabel;
  const sizeStyle = previewImageSizeStyle(photo);

  return `
    <div class="preview-grid">
      <div class="image-card">
        <div class="image-label">${escapeHtml(originalLabel)}</div>
        <div class="image-wrap">
          <div class="image-stage">
            <img class="preview-image" style="transform:${transform};${sizeStyle}" src="${escapeHtml(compareState.split.originalSrc)}" alt="Original" />
          </div>
        </div>
      </div>
      <div class="image-card">
        <div class="image-label">${escapeHtml(cleanedLabel)}</div>
        <div class="image-wrap">
          <div class="image-stage">
            <img class="preview-image" style="transform:${transform};${sizeStyle}" src="${escapeHtml(compareState.split.cleanedSrc)}" alt="Cleaned" />
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderSliderPreview(photo, transform) {
  const compareState = compareRenderStateForPhoto(photo);
  const label = compareState.slider.label;
  const reveal = compareState.slider.reveal;
  const clipInset = `${100 - reveal}%`;
  const sizeStyle = previewImageSizeStyle(photo);

  return `
    <div class="compare-card">
      <div class="image-label">${escapeHtml(label)}</div>
        <div class="image-wrap compare-wrap">
          <div class="image-stage compare-stage">
          <div class="compare-corner-label compare-corner-label-before">Before</div>
          <div class="compare-corner-label compare-corner-label-after">After</div>
          <img class="compare-cleaned-image" style="transform:${transform};${sizeStyle}" src="${escapeHtml(compareState.slider.cleanedSrc)}" alt="Cleaned" />
          <div class="compare-original-overlay" style="clip-path:inset(0 ${clipInset} 0 0);">
            <img class="compare-original-image" style="transform:${transform};${sizeStyle}" src="${escapeHtml(compareState.slider.originalSrc)}" alt="Original" />
          </div>

          <div class="compare-handle" style="left:${reveal}%;">
            <div class="compare-handle-line"></div>
            <div class="compare-handle-knob">↔</div>
          </div>

          <input
            id="compareSlider"
            class="compare-slider-input"
            type="range"
            min="0"
            max="100"
            value="${reveal}"
            aria-label="Before and after comparison slider"
          />
        </div>
      </div>
    </div>
  `;
}

function attachPreviewInteractions() {
  const stages = Array.from(document.querySelectorAll('.image-stage'));
  const wraps = Array.from(document.querySelectorAll('.image-wrap'));

  function updateTransforms() {
    document.querySelectorAll('.preview-image, .compare-original-image, .compare-cleaned-image').forEach((img) => {
      img.style.transform = makePreviewTransform();
    });
  }

  function startPan(event) {
    const sliderThumb = event.target.closest('.compare-handle');
    const sliderInput = event.target.closest('#compareSlider');
    if (sliderThumb || sliderInput) return;
    if (event.button !== 0) return;

    state.isPanning = true;
    state.lastPanX = event.clientX;
    state.lastPanY = event.clientY;
    wraps.forEach((wrap) => wrap.classList.add('dragging'));
  }

  stages.forEach((stage) => {
    stage.onwheel = (event) => {
      event.preventDefault();

      const delta = event.deltaY < 0 ? 0.15 : -0.15;
      const minZoom = state.fitZoom || 0.03;

      state.zoom = clamp(state.zoom + delta, minZoom, 8);

      if (Math.abs(state.zoom - minZoom) < 0.08) {
        state.zoom = minZoom;
        state.panX = 0;
        state.panY = 0;
      }

      updateTransforms();
      state.preview.perf.lastInteractionAt = Date.now();
      queueViewportQualityRefresh({ debounceMs: 180 });
    };

    stage.onmousedown = startPan;
  });

  const compareSlider = document.getElementById('compareSlider');
  if (compareSlider) {
    const overlay = document.querySelector('.compare-original-overlay');
    const handle = document.querySelector('.compare-handle');
    let sliderRaf = null;

    compareSlider.oninput = (event) => {
      state.preview.sliderPosition = clamp(Number(event.target.value), 0, 100);
      if (sliderRaf) return;

      sliderRaf = window.requestAnimationFrame(() => {
        const clipInset = `${100 - state.preview.sliderPosition}%`;
        if (overlay) overlay.style.clipPath = `inset(0 ${clipInset} 0 0)`;
        if (handle) handle.style.left = `${state.preview.sliderPosition}%`;
        sliderRaf = null;
      });
    };
  }

  if (!previewHandlersBound) {
    window.addEventListener('mousemove', (event) => {
      if (!state.isPanning) return;

      const dx = event.clientX - state.lastPanX;
      const dy = event.clientY - state.lastPanY;

      state.lastPanX = event.clientX;
      state.lastPanY = event.clientY;
      state.panX += dx;
      state.panY += dy;

      document.querySelectorAll('.preview-image, .compare-original-image, .compare-cleaned-image').forEach((img) => {
        img.style.transform = makePreviewTransform();
      });
    });

    function endPan() {
      state.isPanning = false;
      document.querySelectorAll('.image-wrap').forEach((wrap) => wrap.classList.remove('dragging'));
    }

    window.addEventListener('mouseup', endPan);
    window.addEventListener('mouseleave', endPan);

    previewHandlersBound = true;
  }
}

function renderPreview() {
  const photo = selectedPhoto();

  if (!photo) {
    el.previewArea.innerHTML = '<div class="empty">Choose or drop a photo to start.</div>';
    return;
  }

  const transform = makePreviewTransform();
  const previewBody = state.preview.mode === 'slider'
    ? renderSliderPreview(photo, transform)
    : renderSplitPreview(photo, transform);
  const mergedFileName = pathBasename(photo.filePath || '');
  const mergedFolderPath = pathDirname(photo.filePath || '') || photo.filePath || '';
  const mergedFolderLabel = compactPathPreview(mergedFolderPath, { folder: true });

  const mergedBanner = photo.isHdrMerged
    ? `
      <div class="preview-merged-banner">
        <div class="preview-merged-title">Merged 16-bit TIFF Master</div>
        <div class="preview-merged-file">${escapeHtml(mergedFileName)}</div>
        <div class="preview-merged-path" title="${escapeHtml(mergedFolderPath)}">Folder: ${escapeHtml(mergedFolderLabel)}</div>
      </div>
    `
    : '';

  el.previewArea.innerHTML = `${mergedBanner}${previewBody}`;

  attachPreviewInteractions();
}

function renderHdrSummary() {
  const detection = state.hdr.detection;
  const queue = state.hdr.queue;
  const latestResult = lastMergedResult(queue);

  const rows = [];
  const metricRow = (label, value) => `
    <div class="hdr-summary-row">
      <span class="hdr-summary-label">${escapeHtml(label)}</span>
      <span class="hdr-summary-value">${escapeHtml(value)}</span>
    </div>
  `;
  const pathRow = (label, fullPath, options = {}) => {
    if (!fullPath) return '';
    const preview = compactPathPreview(fullPath, { folder: Boolean(options.folder) }) || fullPath;
    return `
      <div class="hdr-summary-row hdr-summary-row-path">
        <span class="hdr-summary-label">${escapeHtml(label)}</span>
        <span class="hdr-summary-value" title="${escapeHtml(fullPath)}">${escapeHtml(preview)}</span>
        <span class="hdr-path-actions">
          <button class="hdr-path-btn" type="button" data-path-action="reveal" data-target-path="${escapeHtml(fullPath)}">Reveal</button>
          <button class="hdr-path-btn" type="button" data-path-action="copy" data-target-path="${escapeHtml(fullPath)}">Copy Path</button>
        </span>
      </div>
    `;
  };

  if (state.hdr.folderPath) {
    rows.push(pathRow('Folder', state.hdr.folderPath, { folder: true }));
  }

  if (detection?.summary) {
    rows.push(metricRow('Source RAW files', detection.summary.totalRawFiles));
    rows.push(metricRow('Complete sets', detection.summary.totalCompleteGroups));
    rows.push(metricRow('Incomplete sets', detection.summary.totalIncompleteGroups));
    rows.push(metricRow('Skipped files', detection.summary.totalSkippedFiles));
  }

  if (queue?.queueId) {
    rows.push(metricRow('Queue Status', queue.status));
    if (queue.cancelRequested && queue.status === 'Processing') {
      rows.push(metricRow('Cancel', 'requested (finishing current write safely)'));
    }
    rows.push(metricRow('Merged', `${queue.completedCount}/${queue.totalBracketSets}`));
    if (queue.skippedCount > 0) rows.push(metricRow('Skipped', queue.skippedCount));
    if (queue.failedCount > 0) rows.push(metricRow('Failed', queue.failedCount));
    if (queue.canceledCount > 0) rows.push(metricRow('Canceled', queue.canceledCount));
    if (queue.outputDir) {
      rows.push(pathRow('Output Folder', queue.outputDir, { folder: true }));
    }
    if (latestResult?.mergedPath) {
      rows.push(metricRow('Latest Merged TIFF', pathBasename(latestResult.mergedPath)));
      rows.push(pathRow('Merged TIFF Path', latestResult.mergedPath));
    }
    if (queue.logPath) rows.push(pathRow('Log', queue.logPath));
  }

  const compactParts = [];
  if (queue?.queueId) {
    compactParts.push(`Status: ${queue.status}`);
    compactParts.push(`Merged ${queue.completedCount}/${queue.totalBracketSets}`);
    if (queue.failedCount > 0) compactParts.push(`Failed ${queue.failedCount}`);
    if (queue.skippedCount > 0) compactParts.push(`Skipped ${queue.skippedCount}`);
  } else if (detection?.summary) {
    compactParts.push(`Complete sets: ${detection.summary.totalCompleteGroups}`);
    compactParts.push(`Incomplete: ${detection.summary.totalIncompleteGroups}`);
  }

  if (el.hdrStatusCompact) {
    el.hdrStatusCompact.textContent = compactParts.length
      ? compactParts.join(' • ')
      : 'No HDR folder selected yet.';
  }

  if (!rows.length) {
    el.hdrSummary.innerHTML = 'No HDR folder selected yet.';
    return;
  }

  el.hdrSummary.innerHTML = rows.join('');
  el.hdrSummary.querySelectorAll('[data-path-action]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      const action = event.currentTarget?.dataset?.pathAction;
      const targetPath = event.currentTarget?.dataset?.targetPath || '';
      if (!action || !targetPath) return;

      if (action === 'reveal') {
        try {
          const response = await window.aceApi.openPathInFinder(targetPath);
          if (!response?.ok) {
            throw new Error(response?.error || 'Could not reveal path in Finder.');
          }
        } catch (error) {
          console.error(error);
          alert(`Could not reveal path.\n\n${error.message || error}`);
        }
        return;
      }

      if (action === 'copy') {
        const copied = await copyTextToClipboard(targetPath);
        if (!copied) {
          alert('Could not copy path to clipboard.');
          return;
        }

        const originalLabel = event.currentTarget.textContent;
        event.currentTarget.textContent = 'Copied';
        window.setTimeout(() => {
          event.currentTarget.textContent = originalLabel;
        }, 900);
      }
    });
  });
}

function renderHdrQueueLists() {
  const queue = state.hdr.queue;

  if (!queue || !Array.isArray(queue.sets) || !queue.sets.length) {
    el.hdrSetList.innerHTML = '<div class="mini-note">Queue is idle.</div>';
  } else {
    el.hdrSetList.innerHTML = queue.sets.map((set, index) => `
      <div class="hdr-set-row status-${escapeHtml(statusClassName(set.status))}">
        <div class="hdr-set-top">
          <span class="status">${escapeHtml(set.status)}</span>
          <span class="hdr-set-id">SET${escapeHtml(String(set.setIndex || (index + 1)).padStart(4, '0'))}</span>
        </div>
        <div class="hdr-set-main">${escapeHtml(set.firstFileName || set.id)} (${set.sourceCount} files)</div>
        ${set.outputPath ? `<div class="hdr-set-meta">${escapeHtml(pathBasename(set.outputPath))}</div>` : ''}
        ${set.error ? `<div class="hdr-set-meta">${escapeHtml(set.error)}</div>` : ''}
      </div>
    `).join('');
  }

  const queueErrors = queue?.errors || [];

  if (!queueErrors.length) {
    el.hdrErrorList.innerHTML = '<div class="mini-note">No errors.</div>';
  } else {
    el.hdrErrorList.innerHTML = queueErrors.map((entry) => `
      <div class="hdr-error-row">
        <strong>${escapeHtml(entry.setId || 'Set')}</strong>
        <span>${escapeHtml(entry.error || 'Unknown error')}</span>
      </div>
    `).join('');
  }
}

function renderHdrProgress() {
  const queue = state.hdr.queue;

  const total = queue?.totalBracketSets || 0;
  const processed = queue?.processedCount || 0;
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

  el.hdrOverallProgressBar.style.width = `${percent}%`;
  el.hdrOverallProgressText.textContent = `${processed} / ${total} sets`;
}

function syncPresetButtonState() {
  const hasPhoto = Boolean(selectedPhoto());

  [
    [el.presetNaturalBtn, 'natural'],
    [el.presetRealEstateBtn, 'real-estate'],
    [el.presetPunchyBtn, 'punchy'],
    [el.presetSoftBtn, 'soft'],
  ].forEach(([button, preset]) => {
    if (!button) return;
    button.classList.toggle('is-active', hasPhoto && state.presets.activePreset === preset);
  });
}

function syncPreviewModeButtonLabel() {
  if (!el.previewModeBtn) return;
  el.previewModeBtn.textContent = state.preview.mode === 'split' ? 'Slider View' : 'Split View';
}

function syncLeftPanelLayoutState() {
  if (!el.leftPanelBody) return;

  const hdrCollapsed = Boolean(el.hdrWorkflowLeftSection?.classList.contains('is-collapsed'));
  const libraryCollapsed = Boolean(el.libraryLeftSection?.classList.contains('is-collapsed'));
  const bothCollapsed = hdrCollapsed && libraryCollapsed;

  el.leftPanelBody.classList.toggle('hdr-collapsed', hdrCollapsed);
  el.leftPanelBody.classList.toggle('library-collapsed', libraryCollapsed);
  el.leftPanelBody.classList.toggle('both-collapsed', bothCollapsed);
  el.leftPanelRoot?.classList.toggle('is-compact-collapsed', bothCollapsed);

  if (el.leftPanelResizer) {
    const hideResizer = hdrCollapsed || libraryCollapsed;
    el.leftPanelResizer.classList.toggle('is-hidden', hideResizer);
    el.leftPanelResizer.setAttribute('aria-hidden', hideResizer ? 'true' : 'false');
  }

  if (!hdrCollapsed && !libraryCollapsed && el.hdrWorkflowLeftSection) {
    const currentTop = el.hdrWorkflowLeftSection.getBoundingClientRect().height;
    if (currentTop > 0) {
      resizeLeftPanelTopSection(currentTop);
    }
  }
}

function resizeLeftPanelTopSection(nextTopPx) {
  if (!el.leftPanelBody || !el.leftPanelResizer) return;

  const totalAvailable = el.leftPanelBody.clientHeight - el.leftPanelResizer.offsetHeight;
  if (totalAvailable <= 0) return;

  const minTop = 170;
  const minBottom = 140;
  const maxTop = Math.max(minTop, totalAvailable - minBottom);
  const clampedTop = clamp(nextTopPx, minTop, maxTop);

  el.leftPanelBody.style.setProperty('--left-top-size', `${clampedTop}px`);
}

function initLeftPanelResizer() {
  if (!el.leftPanelBody || !el.leftPanelResizer || !el.hdrWorkflowLeftSection) return;

  let dragActive = false;
  let dragStartY = 0;
  let dragStartTop = 0;

  const stopDrag = () => {
    if (!dragActive) return;
    dragActive = false;
    el.leftPanelBody.classList.remove('is-resizing');

    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', stopDrag, true);
    window.removeEventListener('pointercancel', stopDrag, true);
    window.removeEventListener('blur', stopDrag);
  };

  const onPointerMove = (event) => {
    if (!dragActive) return;
    const deltaY = event.clientY - dragStartY;
    resizeLeftPanelTopSection(dragStartTop + deltaY);
  };

  el.leftPanelResizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (el.leftPanelBody.classList.contains('hdr-collapsed')) return;
    if (el.leftPanelBody.classList.contains('library-collapsed')) return;

    dragActive = true;
    dragStartY = event.clientY;
    dragStartTop = el.hdrWorkflowLeftSection.getBoundingClientRect().height;
    el.leftPanelBody.classList.add('is-resizing');

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', stopDrag, true);
    window.addEventListener('pointercancel', stopDrag, true);
    window.addEventListener('blur', stopDrag);

    event.preventDefault();
    event.stopPropagation();
  });

  el.leftPanelResizer.addEventListener('keydown', (event) => {
    if (el.leftPanelBody.classList.contains('hdr-collapsed')) return;
    if (el.leftPanelBody.classList.contains('library-collapsed')) return;

    let delta = 0;
    if (event.key === 'ArrowUp') delta = -24;
    if (event.key === 'ArrowDown') delta = 24;
    if (!delta) return;

    event.preventDefault();
    const currentTop = el.hdrWorkflowLeftSection.getBoundingClientRect().height;
    resizeLeftPanelTopSection(currentTop + delta);
  });
}

function setLeftSectionExpanded(toggleButton, expanded) {
  if (!toggleButton) return;
  const section = toggleButton.closest('.left-stack-section');
  if (!section) return;

  toggleButton.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  section.classList.toggle('is-collapsed', !expanded);
  syncLeftPanelLayoutState();
}

function bindLeftSectionToggle(toggleButton) {
  if (!toggleButton) return;

  toggleButton.addEventListener('click', () => {
    const expanded = toggleButton.getAttribute('aria-expanded') !== 'false';
    setLeftSectionExpanded(toggleButton, !expanded);
  });
}

function setHdrDetailsExpanded(expanded) {
  if (!el.toggleHdrDetailsBtn || !el.hdrDetailsContent) return;

  el.toggleHdrDetailsBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  el.hdrDetailsContent.classList.toggle('is-collapsed', !expanded);
  el.toggleHdrDetailsBtn.innerHTML = `
    <span class="hdr-details-chevron" aria-hidden="true"></span>
    <span>${expanded ? 'Hide Details' : 'Show Details'}</span>
  `;
}

function renderHistogramPanel() {
  if (!el.histogramCanvas) return;

  const photo = selectedPhoto();
  if (!photo) {
    state.histogram.requestToken += 1;
    drawHistogramBins(null);
    return;
  }

  const histogramKey = histogramSourceKeyForPhoto(photo);
  if (photo.histogramKey === histogramKey && Array.isArray(photo.histogramBins)) {
    drawHistogramBins(photo.histogramBins);
    return;
  }

  drawHistogramBins(photo.histogramBins || null);
  scheduleHistogramRefresh({ force: false });
}

function render() {
  el.applyAllToggle.classList.toggle('on', state.preview.applyToAll);
  syncPreviewModeButtonLabel();

  renderPhotoList();
  renderPreview();
  renderHistogramPanel();
  renderControls();
  renderHdrSummary();
  renderHdrQueueLists();
  renderHdrProgress();

  const hasPhotos = state.photos.length > 0;
  const hasMergedPhotos = state.photos.some((photo) => photo.isHdrMerged);
  const queueRunning = state.hdr.queue?.status === 'Processing';
  const hasFailedSets = (state.hdr.queue?.sets || []).some((set) => set.status === 'Failed');
  const detectedCompleteSets = state.hdr.detection?.summary?.totalCompleteGroups || 0;
  const queueOutputFolder = state.hdr.queue?.outputDir || null;
  const manualSelection = manualHdrSelectionInfo();
  const manualSelectionEngaged = manualSelection.hasMultiSelect;
  const manualMergeReady = manualSelection.canAttemptManualMerge;

  [
    el.autoFixBtn,
    el.presetNaturalBtn,
    el.presetRealEstateBtn,
    el.presetPunchyBtn,
    el.presetSoftBtn,
    el.rotateBtn,
    el.saveCurrentBtn,
    el.resetBtn,
    el.exportAllBtn,
    el.zoomInBtn,
    el.zoomOutBtn,
    el.zoomFitBtn,
    el.previewModeBtn,
  ].forEach((button) => {
    if (button) button.disabled = !hasPhotos;
  });

  if (!hasPhotos) {
    state.presets.activePreset = null;
  }
  syncPresetButtonState();
  syncPresetDropdownOptions();

  if (el.copyToAllBtn) el.copyToAllBtn.disabled = state.photos.length < 2;
  if (el.clearLibraryBtn) el.clearLibraryBtn.disabled = !hasPhotos;
  if (el.startHdrMergePanelBtn) {
    const canStart = !queueRunning && (
      manualSelectionEngaged
        ? manualMergeReady
        : Boolean(state.hdr.folderPath)
    );
    el.startHdrMergePanelBtn.disabled = !canStart;
    el.startHdrMergePanelBtn.classList.toggle(
      'is-ready',
      canStart && (manualSelectionEngaged ? manualMergeReady : detectedCompleteSets > 0)
    );
    el.startHdrMergePanelBtn.textContent = manualSelectionEngaged
      ? (
        manualMergeReady
          ? (manualSelection.singleSetCandidate ? 'Merge Selected (1 set)' : 'Merge Selected Sets')
          : 'Merge Selected'
      )
      : 'Start HDR Merge';
  }
  if (el.retryFailedBtn) {
    el.retryFailedBtn.disabled = queueRunning || !hasFailedSets;
    el.retryFailedBtn.classList.toggle('btn-hidden', !hasFailedSets);
  }
  if (el.cancelHdrMergeBtn) el.cancelHdrMergeBtn.disabled = !queueRunning;
  if (el.openHdrOutputFolderBtn) {
    el.openHdrOutputFolderBtn.disabled = !queueOutputFolder;
  }
  if (el.addHdrFolderBtn) el.addHdrFolderBtn.disabled = queueRunning;
  if (el.exportMergedHdrBtn) el.exportMergedHdrBtn.disabled = !hasMergedPhotos;

  if (el.hdrActionHint) {
    let hint = '1) Add HDR Folder, 2) review detected sets, 3) press Start HDR Merge.';
    if (queueRunning) {
      hint = 'HDR merge is processing. You can cancel safely; current write will finish first.';
    } else if (manualSelectionEngaged) {
      if (manualMergeReady) {
        if (manualSelection.singleSetCandidate) {
          hint = `Manual selection ready: ${manualSelection.rawCount} RAW photo(s) selected. Start will merge one selected set.`;
        } else {
          hint = `Manual multi-set mode: ${manualSelection.rawCount} RAW photo(s) selected. Start will detect and merge all valid selected bracket sets.`;
        }
        if (manualSelection.excludedNonRawCount > 0) {
          hint += ` ${manualSelection.excludedNonRawCount} non-RAW selected item(s) will be excluded.`;
        }
      } else {
        hint = `${manualSelection.invalidReason} Use Command-click/Shift-click to select at least 3 RAW photos.`;
      }
    } else if (!state.hdr.folderPath) {
      hint = 'Select an HDR folder to detect bracket groups, or Command/Shift-select RAW photos in Library.';
    } else if (detectedCompleteSets <= 0) {
      hint = 'No complete bracket sets detected yet. Check incomplete/skipped groups, or use manual RAW library selection.';
    } else if (hasFailedSets) {
      hint = 'Some sets failed. Use Retry Failed to retry only failed sets.';
    } else {
      hint = `Ready: ${detectedCompleteSets} complete set(s) detected. Press Start HDR Merge.`;
    }

    el.hdrActionHint.textContent = hint;
  }
}

function togglePreviewMode() {
  const nextMode = state.preview.mode === 'slider' ? 'split' : 'slider';

  if (nextMode === 'slider') {
    if (!Number.isFinite(state.preview.sliderPosition) || state.preview.sliderPosition < 5 || state.preview.sliderPosition > 95) {
      state.preview.sliderPosition = 50;
    }
  }

  state.preview.mode = nextMode;
  syncPreviewModeButtonLabel();
  setTimeout(() => fitPreviewToStage(), 0);
}

async function pickPhotos() {
  const result = await window.aceApi.pickFiles();
  if (result?.length) {
    await addFiles(result);
  }
}

async function pickFolder() {
  const result = await window.aceApi.pickFolder();
  if (result) {
    await addFiles([result]);
  }
}

async function importHdrFolderFlow(folderPath = null) {
  try {
    const response = await window.aceApi.importHdrFolder({
      folderPath,
      bracketMode: el.hdrBracketSelect?.value || 'auto',
    });

    if (!response || response.cancelled || response.canceled) return;

    if (!response.ok) {
      throw new Error(response.error || 'Failed to import HDR folder.');
    }

    if (!response.folderPath) {
      throw new Error('HDR import did not return a folder path.');
    }

    const sourceFiles = Array.isArray(response.sourceFiles) ? response.sourceFiles : [];
    let detection = response.detection || null;

    // Defensive fallback for packaged builds: if detection payload is missing,
    // run detection explicitly and surface any error instead of silently no-oping.
    if (!detection?.summary) {
      const fallback = await window.aceApi.detectHdrGroups({
        folderPath: response.folderPath,
        bracketMode: el.hdrBracketSelect?.value || 'auto',
      });

      if (!fallback?.ok) {
        throw new Error(fallback?.error || 'HDR detection failed after folder import.');
      }

      detection = fallback.detection || null;
    }

    if (!detection?.summary) {
      detection = {
        completeGroups: [],
        incompleteGroups: [],
        skippedFiles: [],
        summary: {
          totalInputFiles: sourceFiles.length,
          totalRawFiles: sourceFiles.length,
          totalCompleteGroups: 0,
          totalIncompleteGroups: 0,
          totalSkippedFiles: 0,
          bracketMode: el.hdrBracketSelect?.value || 'auto',
          timeGapMs: 8000,
          metadataRecords: 0,
        },
      };
    }

    state.hdr.folderPath = response.folderPath;
    state.hdr.sourceFiles = sourceFiles;
    state.hdr.detection = detection;

    console.log(
      `[HDR-IMPORT] folder=${response.folderPath} rawFiles=${sourceFiles.length} completeSets=${detection.summary.totalCompleteGroups}`
    );

    render();
  } catch (error) {
    console.error(error);
    alert(`HDR folder import failed.\n\n${error.message || error}`);
  }
}

async function pickHdrFolderFlow() {
  try {
    const folderPath = await window.aceApi.pickFolder();
    if (!folderPath) return;
    await importHdrFolderFlow(folderPath);
  } catch (error) {
    console.error(error);
    alert(`HDR folder pick failed.\n\n${error.message || error}`);
  }
}

async function openHdrOutputFolderFlow() {
  try {
    const queue = state.hdr.queue || null;
    const latest = lastMergedResult(queue);
    const targetPath = queue?.outputDir || latest?.mergedPath || null;

    if (!targetPath) {
      alert('No HDR output folder is available yet. Run a merge first.');
      return;
    }

    const response = await window.aceApi.openPathInFinder(targetPath);
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not open output folder.');
    }
  } catch (error) {
    console.error(error);
    alert(`Could not open HDR output folder.\n\n${error.message || error}`);
  }
}

async function loadMergedResultsIntoLibrary(mergedResults) {
  const toLoad = (mergedResults || [])
    .filter((result) => result?.mergedPath)
    .filter((result) => !state.library.loadedMergedPaths.has(result.mergedPath));

  if (!toLoad.length) return;

  const response = await window.aceApi.openMergedTiffsInLibrary(toLoad);

  if (!response?.ok) {
    throw new Error(response?.error || 'Could not open merged TIFFs in library.');
  }

  const expectedMergedPaths = new Set(toLoad.map((result) => normalizePathSlashes(result.mergedPath)));
  const normalizedItems = Array.isArray(response.items) ? response.items : [];
  const mismatchedItems = normalizedItems.filter(
    (item) => !expectedMergedPaths.has(normalizePathSlashes(item.originalPath))
  );
  const nonHdrItems = normalizedItems.filter((item) => !item?.isMergedHdr && !item?.hdrMetadata);

  if (mismatchedItems.length) {
    throw new Error('Library import mismatch: received non-merged items for HDR load.');
  }

  if (nonHdrItems.length) {
    throw new Error('Library import mismatch: merged HDR metadata missing on loaded TIFF item(s).');
  }

  await addNormalizedItems(normalizedItems, {
    suppressDuplicateAlert: true,
  });

  for (const result of toLoad) {
    state.library.loadedMergedPaths.add(result.mergedPath);
  }
}

async function onQueueUpdated(queue) {
  state.hdr.queue = queue;
  render();

  if (!queue || !queue.queueId) return;
  if (!['Completed', 'Canceled', 'Failed'].includes(queue.status)) return;
  if (state.hdr.loadedQueueId === queue.queueId) return;

  state.hdr.loadedQueueId = queue.queueId;

  try {
    await loadMergedResultsIntoLibrary(queue.mergedResults || []);

    if ((queue.mergedResults || []).length) {
      const latest = lastMergedResult(queue);
      const mergedCount = queue.mergedResults.length;
      const statusLabel = queue.status === 'Completed' ? 'completed successfully' : queue.status.toLowerCase();

      let message = `HDR merge ${statusLabel}.\n\n`;
      message += `Merged TIFFs: ${mergedCount}\n`;
      message += `Loaded into library: ${mergedCount}\n`;

      if (queue.outputDir) {
        message += `\nOutput folder:\n${queue.outputDir}\n`;
      }

      if (latest?.mergedPath) {
        message += `\nLatest TIFF:\n${pathBasename(latest.mergedPath)}\n`;
      }

      alert(message);
    }
  } catch (error) {
    console.error(error);
    alert(`HDR queue completed, but loading merged TIFFs failed.\n\n${error.message || error}`);
  }
}

async function startBatchHdrMergeFlow() {
  try {
    const manualSelection = manualHdrSelectionInfo();
    const useManualSelection = manualSelection.hasMultiSelect;

    if (useManualSelection) {
      if (!manualSelection.canAttemptManualMerge) {
        alert(
          `${manualSelection.invalidReason}\n\n` +
          'Tip: select at least 3 RAW photos for manual merge, or single-click one Library photo to return to folder mode.'
        );
        return;
      }

      const selectedSourceFiles = [...new Set(manualSelection.sourceFiles)];
      if (!selectedSourceFiles.length) {
        alert('No RAW source photos are selected for manual HDR merge.');
        return;
      }

      if (manualSelection.excludedNonRawCount > 0) {
        const proceed = window.confirm(
          `${manualSelection.excludedNonRawCount} selected item(s) are not RAW and will be excluded.\n\nContinue with RAW-only manual merge?`
        );
        if (!proceed) return;
      }

      const preflight = await window.aceApi.detectHdrGroups({
        filePaths: selectedSourceFiles,
        bracketMode: el.hdrBracketSelect?.value || 'auto',
      });

      if (!preflight?.ok) {
        throw new Error(preflight?.error || 'Could not analyze selected RAW files for HDR grouping.');
      }

      const detection = preflight.detection || null;
      const completeSets = detection?.summary?.totalCompleteGroups || 0;
      const incompleteSets = detection?.summary?.totalIncompleteGroups || 0;
      const skippedFiles = detection?.summary?.totalSkippedFiles || 0;

      if (completeSets <= 0) {
        alert(
          'No complete HDR bracket sets were detected in the selected RAW files.\n\n' +
          `Incomplete groups: ${incompleteSets}\n` +
          `Skipped files: ${skippedFiles}`
        );
        return;
      }

      if (incompleteSets > 0 || skippedFiles > 0) {
        const proceed = window.confirm(
          `Detected ${completeSets} complete HDR set(s) from selected RAW files.\n` +
          `Incomplete groups: ${incompleteSets}\n` +
          `Skipped files: ${skippedFiles}\n\n` +
          'Continue and merge the complete sets only?'
        );
        if (!proceed) return;
      }

      const response = await window.aceApi.startBatchHdrMerge({
        sourceFiles: selectedSourceFiles,
        bracketMode: el.hdrBracketSelect?.value || 'auto',
        mergeMode: el.hdrModeSelect?.value || 'fusion',
        concurrency: Number(el.hdrConcurrencySelect?.value || 1),
      });

      if (!response?.ok) {
        throw new Error(response?.error || 'Could not start manual HDR merge from selected photos.');
      }

      state.hdr.queue = response.queue;
      render();

      if (!response.queue?.totalBracketSets) {
        alert(
          'Selected RAW files did not resolve to complete bracket sets.'
        );
      } else if (response.queue.totalBracketSets < completeSets) {
        alert(
          `Preflight detected ${completeSets} complete set(s), but the queue started with ${response.queue.totalBracketSets} set(s).\n\n` +
          'Check file availability and retry.'
        );
      }
      return;
    }

    if (!state.hdr.folderPath) {
      await pickHdrFolderFlow();
      if (!state.hdr.folderPath) return;
    }

    const response = await window.aceApi.startBatchHdrMerge({
      folderPath: state.hdr.folderPath,
      bracketMode: el.hdrBracketSelect?.value || 'auto',
      mergeMode: el.hdrModeSelect?.value || 'fusion',
      concurrency: Number(el.hdrConcurrencySelect?.value || 1),
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Could not start batch HDR merge.');
    }

    state.hdr.queue = response.queue;
    render();

    if (!response.queue?.totalBracketSets) {
      alert('No complete bracket sets were detected. Check the Incomplete/Skipped lists in the HDR summary.');
    }
  } catch (error) {
    console.error(error);
    alert(`Batch HDR merge failed to start.\n\n${error.message || error}`);
  }
}

async function cancelBatchHdrMergeFlow() {
  try {
    const queue = await window.aceApi.cancelBatchHdrMerge();
    state.hdr.queue = queue;
    render();
  } catch (error) {
    console.error(error);
    alert(`Could not cancel merge queue.\n\n${error.message || error}`);
  }
}

async function retryFailedSetsFlow() {
  try {
    const response = await window.aceApi.retryFailedSets();
    if (!response?.ok) {
      throw new Error(response?.error || 'Retry failed.');
    }

    state.hdr.queue = response.queue;
    render();
  } catch (error) {
    console.error(error);
    alert(`Could not retry failed sets.\n\n${error.message || error}`);
  }
}

async function exportCurrent() {
  const photo = selectedPhoto();
  if (!photo) return;

  try {
    const image = await getPhotoSourceImage(photo);
    const dataUrl = processImageToDataUrl(
      image,
      resolveRenderAdjustments(photo.adjustments),
      Number(el.hdrExportQuality?.value || 92) / 100
    );

    const outPath = await window.aceApi.pickSaveFile(makeOutputName(photo.filePath));
    if (!outPath) return;

    await window.aceApi.saveDataUrl({ outPath, dataUrl });
    alert(`Saved to:\n${outPath}`);
  } catch (error) {
    console.error(error);
    alert(`Could not save current image.\n\n${error.message || error}`);
  }
}

async function exportPhotosWithSettings(photos, { suffix, quality, useHdrStrictNaming = false }) {
  const items = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];

    const image = await getPhotoSourceImage(photo);
    const dataUrl = processImageToDataUrl(image, resolveRenderAdjustments(photo.adjustments), quality / 100);

    items.push({
      originalPath: photo.filePath,
      baseName: photo.exportBaseName || pathBasenameWithoutExt(photo.filePath),
      hdrNaming: useHdrStrictNaming ? {
        shootDate: photo.hdrMetadata?.shootDate || 'unknownDate',
        sourceFolder: photo.hdrMetadata?.sourceFolder || 'shoot',
        setIndex: photo.hdrMetadata?.setIndex || 1,
      } : null,
      dataUrl,
    });

    if (i % 2 === 1) {
      // Yield to keep the renderer responsive while preparing many exports.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return window.aceApi.exportEditedJpegs({
    items,
    suffix,
    quality,
    useHdrStrictNaming,
  });
}

async function exportAll() {
  if (!state.photos.length) return;

  try {
    const quality = Number(el.hdrExportQuality?.value || 92);
    const suffix = '_edit';

    const result = await exportPhotosWithSettings(state.photos, { suffix, quality });

    if (!result?.ok) {
      if (!result?.cancelled) {
        throw new Error(result?.error || 'Export failed.');
      }
      return;
    }

    const summary = `Export complete.\n\nSaved: ${result.exported.length}\nFailed: ${result.failed.length}\n\nFolder:\n${result.outputDir}`;
    alert(summary);
  } catch (error) {
    console.error(error);
    alert(`Export failed for one or more images.\n\n${error.message || error}`);
  }
}

async function exportMergedHdr() {
  const mergedPhotos = state.photos.filter((photo) => photo.isHdrMerged);
  if (!mergedPhotos.length) {
    alert('No merged HDR photos are loaded.');
    return;
  }

  try {
    const quality = Number(el.hdrExportQuality?.value || 92);
    const result = await exportPhotosWithSettings(mergedPhotos, {
      suffix: '_edit',
      quality,
      useHdrStrictNaming: true,
    });

    if (!result?.ok) {
      if (!result?.cancelled) {
        throw new Error(result?.error || 'HDR export failed.');
      }
      return;
    }

    let message = `HDR export complete.\n\nSaved: ${result.exported.length}`;
    if (result.failed.length) {
      message += `\nFailed: ${result.failed.length}`;
    }
    message += `\n\nFolder:\n${result.outputDir}`;

    alert(message);
  } catch (error) {
    console.error(error);
    alert(`HDR export failed.\n\n${error.message || error}`);
  }
}

function showDropOverlay(show) {
  el.dropOverlay?.classList.toggle('show', show);
  el.dropzone?.classList.toggle('active', show);
}

function hasExternalFilePayload(event) {
  const dt = event?.dataTransfer;
  if (!dt) return false;

  const types = Array.from(dt.types || []);
  if (types.includes('Files')) return true;
  if (types.includes('public.file-url')) return true;
  if (types.includes('text/uri-list')) return true;
  return false;
}

function fileUriToPath(input) {
  if (!input || !String(input).toLowerCase().startsWith('file://')) return null;

  try {
    const url = new URL(input);
    if (url.protocol !== 'file:') return null;

    let pathname = decodeURIComponent(url.pathname || '');
    // Windows file URI compatibility.
    if (/^\/[a-zA-Z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname || null;
  } catch (_) {
    return null;
  }
}

function pushDroppedPath(out, seen, candidate) {
  if (!candidate || typeof candidate !== 'string') return;

  let path = candidate.trim();
  if (!path) return;

  if (path.toLowerCase().startsWith('file://')) {
    const fromUri = fileUriToPath(path);
    if (!fromUri) return;
    path = fromUri;
  }

  if (seen.has(path)) return;
  seen.add(path);
  out.push(path);
}

function appendDroppedTextPaths(out, seen, textValue) {
  if (!textValue || typeof textValue !== 'string') return;

  for (const line of textValue.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    pushDroppedPath(out, seen, value);
  }
}

async function resolveDroppedFilePath(file) {
  if (!file) return '';

  if (typeof file.path === 'string' && file.path.trim()) {
    return file.path.trim();
  }

  if (window.aceApi?.getPathForFile) {
    try {
      const bridgedPath = await window.aceApi.getPathForFile(file);
      if (typeof bridgedPath === 'string' && bridgedPath.trim()) {
        return bridgedPath.trim();
      }
    } catch {
      // Best-effort fallback: continue to URI/text extraction.
    }
  }

  return '';
}

async function getDroppedPaths(event) {
  const out = [];
  const seen = new Set();

  const dt = event?.dataTransfer;
  if (!dt) return out;

  // Primary path source for Electron Finder drops.
  for (const file of Array.from(dt.files || [])) {
    const resolved = await resolveDroppedFilePath(file);
    pushDroppedPath(out, seen, resolved);
  }

  // Fallback source used by some drag origins where FileList is empty.
  for (const item of Array.from(dt.items || [])) {
    if (item?.kind !== 'file') continue;
    const file = item.getAsFile?.();
    const resolved = await resolveDroppedFilePath(file);
    pushDroppedPath(out, seen, resolved);
  }

  // URI/text payload fallback for macOS Finder edge cases.
  appendDroppedTextPaths(out, seen, dt.getData('text/uri-list'));
  appendDroppedTextPaths(out, seen, dt.getData('text/plain'));

  if (!out.length) {
    console.warn('Drop did not expose local file paths. types=', Array.from(dt.types || []));
  }

  return out;
}

el.addPhotosBtn?.addEventListener('click', () => {
  pickPhotos();
});

el.miniAddPhotosBtn?.addEventListener('click', () => {
  pickPhotos();
});

el.addFolderBtn?.addEventListener('click', () => {
  pickFolder();
});

el.miniAddFolderBtn?.addEventListener('click', () => {
  pickFolder();
});

el.clearLibraryBtn?.addEventListener('click', () => {
  clearLibraryFlow();
});

el.addHdrFolderBtn?.addEventListener('click', () => {
  pickHdrFolderFlow();
});

el.startHdrMergePanelBtn?.addEventListener('click', () => {
  startBatchHdrMergeFlow();
});

el.openHdrOutputFolderBtn?.addEventListener('click', () => {
  openHdrOutputFolderFlow();
});

el.retryFailedBtn?.addEventListener('click', () => {
  retryFailedSetsFlow();
});

el.cancelHdrMergeBtn?.addEventListener('click', () => {
  cancelBatchHdrMergeFlow();
});

el.exportAllBtn?.addEventListener('click', () => {
  exportAll();
});

el.exportMergedHdrBtn?.addEventListener('click', () => {
  exportMergedHdr();
});

el.hdrExportQuality?.addEventListener('input', () => {
  if (el.hdrExportQualityValue) {
    el.hdrExportQualityValue.textContent = String(el.hdrExportQuality.value);
  }
});

el.presetNaturalBtn?.addEventListener('click', () => {
  applyPreset('natural');
});

el.presetRealEstateBtn?.addEventListener('click', () => {
  applyPreset('real-estate');
});

el.presetPunchyBtn?.addEventListener('click', () => {
  applyPreset('punchy');
});

el.presetSoftBtn?.addEventListener('click', () => {
  applyPreset('soft');
});

el.presetDropdownBtn?.addEventListener('click', () => {
  togglePresetDropdown();
});

el.presetDropdownMenu?.addEventListener('click', (event) => {
  const deleteButton = event.target?.closest?.('[data-delete-preset]');
  if (deleteButton) {
    event.preventDefault();
    event.stopPropagation();
    const decodedName = decodeURIComponent(String(deleteButton.dataset.deletePreset || ''));
    deleteUserPresetByName(decodedName);
    return;
  }

  const presetButton = event.target?.closest?.('[data-preset-id]');
  if (presetButton) {
    event.preventDefault();
    const optionId = String(presetButton.dataset.presetId || '');
    if (!optionId) return;
    applyDropdownPresetById(optionId);
    closePresetDropdown();
  }
});

el.savePresetBtn?.addEventListener('click', () => {
  if (!selectedPhoto()) {
    alert('Select a photo before saving a preset.');
    return;
  }
  openSavePresetModal();
});

el.cancelSavePresetBtn?.addEventListener('click', () => {
  closeSavePresetModal();
});

el.confirmSavePresetBtn?.addEventListener('click', () => {
  savePresetFromModal();
});

el.presetNameInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    savePresetFromModal();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeSavePresetModal();
  }
});

el.savePresetModal?.addEventListener('click', (event) => {
  if (event.target === el.savePresetModal) {
    closeSavePresetModal();
  }
});

el.saveCurrentBtn?.addEventListener('click', () => {
  exportCurrent();
});

el.zoomInBtn?.addEventListener('click', () => {
  const minZoom = state.fitZoom || 0.03;
  state.zoom = clamp(state.zoom + 0.25, minZoom, 8);
  renderPreview();
  state.preview.perf.lastInteractionAt = Date.now();
  queueViewportQualityRefresh({ debounceMs: 120 });
});

el.zoomOutBtn?.addEventListener('click', () => {
  const minZoom = state.fitZoom || 0.03;
  state.zoom = clamp(state.zoom - 0.25, minZoom, 8);

  if (Math.abs(state.zoom - minZoom) < 0.08) {
    state.zoom = minZoom;
    state.panX = 0;
    state.panY = 0;
  }

  renderPreview();
  state.preview.perf.lastInteractionAt = Date.now();
  queueViewportQualityRefresh({ debounceMs: 120 });
});

el.zoomFitBtn?.addEventListener('click', () => {
  fitPreviewToStage();
});

el.previewModeBtn?.addEventListener('click', () => {
  togglePreviewMode();
});

el.autoFixBtn?.addEventListener('click', async () => {
  const photo = selectedPhoto();
  if (!photo) return;

  try {
    const stats = await ensurePhotoAnalysis(photo, { highPriority: true });
    updateAdjustments(estimateAutoAdjustments(stats, 'auto', {
      isHdrMerged: Boolean(photo.isHdrMerged),
      rotation: photo.adjustments?.rotation || 0,
    }));
  } catch (error) {
    console.warn('Auto analysis fallback:', error);
    alert('Could not auto-fix that photo.');
  }
});

el.rotateBtn?.addEventListener('click', () => {
  const photo = selectedPhoto();
  if (!photo) return;

  updateAdjustments({
    rotation: ((photo.adjustments.rotation || 0) + 90) % 360,
  });
});

el.resetBtn?.addEventListener('click', () => {
  const photo = selectedPhoto();
  if (!photo) return;

  state.presets.activePreset = null;
  syncPresetButtonState();
  updateAdjustments({ ...defaultAdjustments });
});

el.copyToAllBtn?.addEventListener('click', async () => {
  const photo = selectedPhoto();
  if (!photo) return;

  for (const item of state.photos) {
    item.adjustments = { ...photo.adjustments };
    markPhotoAdjustmentsDirty(item);
  }

  await refreshSelectedPreview();
  await refreshAllThumbnails();
  render();
});

el.applyAllToggle?.addEventListener('click', () => {
  state.preview.applyToAll = !state.preview.applyToAll;
  render();
});

let globalDragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!hasExternalFilePayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  globalDragDepth += 1;
  showDropOverlay(true);
}, true);

window.addEventListener('dragover', (event) => {
  if (!hasExternalFilePayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  if (globalDragDepth <= 0) globalDragDepth = 1;
  showDropOverlay(true);
}, true);

window.addEventListener('dragleave', (event) => {
  if (!hasExternalFilePayload(event)) return;
  event.preventDefault();
  event.stopPropagation();

  globalDragDepth = Math.max(0, globalDragDepth - 1);
  if (
    globalDragDepth === 0 ||
    event.clientX <= 0 ||
    event.clientY <= 0 ||
    event.clientX >= window.innerWidth ||
    event.clientY >= window.innerHeight
  ) {
    globalDragDepth = 0;
    showDropOverlay(false);
  }
}, true);

window.addEventListener('drop', async (event) => {
  if (!hasExternalFilePayload(event)) return;
  event.preventDefault();
  event.stopPropagation();
  globalDragDepth = 0;
  showDropOverlay(false);

  const paths = await getDroppedPaths(event);
  if (paths.length) {
    await addFiles(paths);
    return;
  }

  alert('No usable local file paths were received from this drag operation.');
}, true);

window.addEventListener('resize', () => {
  if (isPresetDropdownOpen()) {
    positionPresetDropdownOverlay();
  }
  renderHistogramPanel();
  if (selectedPhoto()) {
    fitPreviewToStage();
  }
});

window.addEventListener('scroll', () => {
  if (isPresetDropdownOpen()) {
    positionPresetDropdownOverlay();
  }
}, true);

document.addEventListener('mousedown', (event) => {
  state.library.interactionActive = Boolean(event.target?.closest?.('#libraryLeftSection'));
  if (!event.target?.closest?.('.preset-manager-row')) {
    closePresetDropdown();
  }
}, true);

document.addEventListener('focusin', (event) => {
  state.library.interactionActive = Boolean(event.target?.closest?.('#libraryLeftSection'));
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isSavePresetModalOpen()) {
    event.preventDefault();
    closeSavePresetModal();
    return;
  }
  if (event.key === 'Escape' && isPresetDropdownOpen()) {
    event.preventDefault();
    closePresetDropdown();
    return;
  }
  handleLibrarySelectAllShortcut(event);
}, true);

window.aceApi.onHdrQueueUpdate((queue) => {
  onQueueUpdated(queue);
});

window.aceApi.onMenuAddPhotos((filePaths) => {
  if (filePaths?.length) {
    addFiles(filePaths);
  }
});

window.aceApi.onMenuAddFolder((folderPath) => {
  if (folderPath) {
    addFiles([folderPath]);
  }
});

window.aceApi.onMenuAddHdrFolder(() => {
  pickHdrFolderFlow();
});

window.aceApi.onMenuStartHdrMerge(() => {
  startBatchHdrMergeFlow();
});

window.aceApi.onMenuCancelHdrMerge(() => {
  cancelBatchHdrMergeFlow();
});

bindLeftSectionToggle(el.toggleHdrWorkflowSection);
bindLeftSectionToggle(el.toggleLibrarySection);
initLeftPanelResizer();
syncLeftPanelLayoutState();
setHdrDetailsExpanded(false);
el.toggleHdrDetailsBtn?.addEventListener('click', () => {
  const expanded = el.toggleHdrDetailsBtn.getAttribute('aria-expanded') === 'true';
  setHdrDetailsExpanded(!expanded);
});

window.aceApi.onMenuRetryFailedSets(() => {
  retryFailedSetsFlow();
});

window.aceApi.onMenuPreviewZoomIn(() => {
  const minZoom = state.fitZoom || 0.03;
  state.zoom = clamp(state.zoom + 0.25, minZoom, 8);
  renderPreview();
});

window.aceApi.onMenuPreviewZoomOut(() => {
  const minZoom = state.fitZoom || 0.03;
  state.zoom = clamp(state.zoom - 0.25, minZoom, 8);

  if (Math.abs(state.zoom - minZoom) < 0.08) {
    state.zoom = minZoom;
    state.panX = 0;
    state.panY = 0;
  }

  renderPreview();
});

window.aceApi.onMenuPreviewFit(() => {
  fitPreviewToStage();
});

window.aceApi.onMenuTogglePreviewMode(() => {
  togglePreviewMode();
});

window.aceApi.onMenuSaveCurrent(() => {
  exportCurrent();
});

window.aceApi.onMenuExportAll(() => {
  exportAll();
});

window.aceApi.onMenuExportMergedHdr(() => {
  exportMergedHdr();
});

window.aceApi.onMenuAutoFix(() => {
  el.autoFixBtn?.click();
});

window.aceApi.onAppReady(() => {
  if (el.startupStatusLabel) {
    el.startupStatusLabel.textContent = 'Ready';
  }
});

(async () => {
  if (el.hdrExportQualityValue && el.hdrExportQuality) {
    el.hdrExportQualityValue.textContent = String(el.hdrExportQuality.value);
  }

  try {
    const queue = await window.aceApi.getMergeQueueProgress();
    state.hdr.queue = queue;
  } catch (error) {
    console.error('Initial queue progress fetch failed:', error);
  }

  await loadUserSavedPresets();

  render();
})();
