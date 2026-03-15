(function initAceRendererState(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && typeof root === 'object') {
    root.AceRendererState = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAceRendererState() {
  function defineAlias(target, key, getter, setter) {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: getter,
      set: setter,
    });
  }

  function createRendererState() {
    const library = {
      photos: [],
      selectedId: null,
      selectedPhotoIds: new Set(),
      selectionAnchorId: null,
      interactionActive: false,
      loadedMergedPaths: new Set(),
    };

    const presets = {
      activePreset: null,
      userSavedPresets: [],
      selectedOptionId: '',
    };

    const preview = {
      applyToAll: false,
      zoom: 1,
      fitZoom: 1,
      panX: 0,
      panY: 0,
      isPanning: false,
      lastPanX: 0,
      lastPanY: 0,
      mode: 'split',
      sliderPosition: 50,
      perf: {
        fastTimer: null,
        fullTimer: null,
        lastFastScheduleAt: 0,
        lastInteractionAt: 0,
        fastInFlight: false,
        pendingFast: false,
      },
    };

    const hdrUi = {
      folderPath: null,
      sourceFiles: [],
      detection: null,
      queue: null,
      loadedQueueId: null,
    };

    const histogram = {
      refreshTimer: null,
      requestToken: 0,
    };

    const state = {
      library,
      presets,
      preview,
      hdrUi,
      hdr: hdrUi,
      histogram,
    };

    defineAlias(state, 'photos', () => library.photos, (value) => {
      library.photos = value;
    });
    defineAlias(state, 'selectedId', () => library.selectedId, (value) => {
      library.selectedId = value;
    });
    defineAlias(state, 'selectedPhotoIds', () => library.selectedPhotoIds, (value) => {
      library.selectedPhotoIds = value;
    });
    defineAlias(state, 'selectionAnchorId', () => library.selectionAnchorId, (value) => {
      library.selectionAnchorId = value;
    });
    defineAlias(state, 'libraryInteractionActive', () => library.interactionActive, (value) => {
      library.interactionActive = value;
    });
    defineAlias(state, 'loadedMergedPaths', () => library.loadedMergedPaths, (value) => {
      library.loadedMergedPaths = value;
    });

    defineAlias(state, 'activePreset', () => presets.activePreset, (value) => {
      presets.activePreset = value;
    });
    defineAlias(state, 'userSavedPresets', () => presets.userSavedPresets, (value) => {
      presets.userSavedPresets = value;
    });
    defineAlias(state, 'selectedPresetOptionId', () => presets.selectedOptionId, (value) => {
      presets.selectedOptionId = value;
    });

    defineAlias(state, 'applyToAll', () => preview.applyToAll, (value) => {
      preview.applyToAll = value;
    });
    defineAlias(state, 'zoom', () => preview.zoom, (value) => {
      preview.zoom = value;
    });
    defineAlias(state, 'fitZoom', () => preview.fitZoom, (value) => {
      preview.fitZoom = value;
    });
    defineAlias(state, 'panX', () => preview.panX, (value) => {
      preview.panX = value;
    });
    defineAlias(state, 'panY', () => preview.panY, (value) => {
      preview.panY = value;
    });
    defineAlias(state, 'isPanning', () => preview.isPanning, (value) => {
      preview.isPanning = value;
    });
    defineAlias(state, 'lastPanX', () => preview.lastPanX, (value) => {
      preview.lastPanX = value;
    });
    defineAlias(state, 'lastPanY', () => preview.lastPanY, (value) => {
      preview.lastPanY = value;
    });
    defineAlias(state, 'previewMode', () => preview.mode, (value) => {
      preview.mode = value;
    });
    defineAlias(state, 'sliderPosition', () => preview.sliderPosition, (value) => {
      preview.sliderPosition = value;
    });
    defineAlias(state, 'previewPerf', () => preview.perf, (value) => {
      preview.perf = value;
    });

    return state;
  }

  return {
    createRendererState,
  };
});
