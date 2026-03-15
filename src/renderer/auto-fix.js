(function initAceAutoFix(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && typeof root === 'object') {
    root.AceAutoFix = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAceAutoFix() {
  const DEFAULT_ANALYSIS_MAX_DIMENSION = 320;
  const DEFAULT_FLAT_HDR_RECOVERY_TRIGGER = 0.36;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function percentileFromHistogram(histogram, total, percentile) {
    if (!total) return 0;

    const target = clamp(percentile, 0, 1) * total;
    let cumulative = 0;
    for (let i = 0; i < histogram.length; i++) {
      cumulative += histogram[i];
      if (cumulative >= target) return i;
    }

    return histogram.length - 1;
  }

  function localFallbackImageStats(isHdrMerged = false) {
    const meanLuminance = isHdrMerged ? 0.49 : 0.47;
    const p5Luminance = isHdrMerged ? 0.07 : 0.06;
    const p25Luminance = isHdrMerged ? 0.33 : 0.31;
    const p50Luminance = isHdrMerged ? 0.5 : 0.48;
    const p75Luminance = isHdrMerged ? 0.68 : 0.66;
    const p95Luminance = isHdrMerged ? 0.91 : 0.9;
    const dynamicRange = isHdrMerged ? 0.84 : 0.84;
    const sat5 = isHdrMerged ? 0.11 : 0.1;
    const sat95 = isHdrMerged ? 0.57 : 0.55;

    return {
      meanLuminance,
      meanLuma: meanLuminance,
      medianLuma: p50Luminance,
      p5Luminance,
      p25Luminance,
      p50Luminance,
      p75Luminance,
      p95Luminance,
      p5Luma: p5Luminance,
      p25Luma: p25Luminance,
      p50Luma: p50Luminance,
      p75Luma: p75Luminance,
      p95Luma: p95Luminance,
      dynamicRange,
      midtoneSpread: p75Luminance - p25Luminance,
      midDensity: 0.34,
      highlightDensity: 0.06,
      shadowDensity: 0.08,
      highlightClipPercent: 0.005,
      shadowClipPercent: 0.01,
      averageSaturation: 0.32,
      sat5,
      sat95,
      satSpread: sat95 - sat5,
      averageRed: 0.5,
      averageGreen: 0.5,
      averageBlue: 0.5,
      colorBalance: 0,
      colorCast: 0,
    };
  }

  function buildFallbackImageStats(isHdrMerged = false, { coreApi = null } = {}) {
    if (coreApi?.buildFallbackImageStats) {
      return coreApi.buildFallbackImageStats(isHdrMerged);
    }

    return localFallbackImageStats(isHdrMerged);
  }

  function analyzeImageStats(imageData, { coreApi = null } = {}) {
    if (!imageData?.data?.length) {
      return buildFallbackImageStats(false, { coreApi });
    }

    const luminanceHistogram = new Array(256).fill(0);
    const saturationHistogram = new Array(256).fill(0);
    const data = imageData.data;
    let total = 0;
    let lumaSum = 0;
    let satSum = 0;
    let redSum = 0;
    let greenSum = 0;
    let blueSum = 0;
    let highlightClip = 0;
    let shadowClip = 0;
    let midDensityCount = 0;
    let highlightDensityCount = 0;
    let shadowDensityCount = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const luma = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
      const bucket = clamp(Math.round(luma * 255), 0, 255);
      const maxV = Math.max(r, g, b);
      const minV = Math.min(r, g, b);
      const saturation = maxV <= 0 ? 0 : (maxV - minV) / maxV;
      const satBucket = clamp(Math.round(saturation * 255), 0, 255);

      luminanceHistogram[bucket] += 1;
      saturationHistogram[satBucket] += 1;
      lumaSum += luma;
      redSum += r;
      greenSum += g;
      blueSum += b;
      satSum += saturation;
      if (luma >= 0.35 && luma <= 0.65) midDensityCount += 1;
      if (luma >= 0.9 && luma <= 0.98) highlightDensityCount += 1;
      if (luma >= 0.02 && luma <= 0.1) shadowDensityCount += 1;
      if (luma > 0.98) highlightClip += 1;
      if (luma < 0.02) shadowClip += 1;
      total += 1;
    }

    if (!total) {
      return buildFallbackImageStats(false, { coreApi });
    }

    const p5 = percentileFromHistogram(luminanceHistogram, total, 0.05) / 255;
    const p25 = percentileFromHistogram(luminanceHistogram, total, 0.25) / 255;
    const p50 = percentileFromHistogram(luminanceHistogram, total, 0.5) / 255;
    const p75 = percentileFromHistogram(luminanceHistogram, total, 0.75) / 255;
    const p95 = percentileFromHistogram(luminanceHistogram, total, 0.95) / 255;
    const sat5 = percentileFromHistogram(saturationHistogram, total, 0.05) / 255;
    const sat95 = percentileFromHistogram(saturationHistogram, total, 0.95) / 255;
    const meanLuma = lumaSum / total;
    const dynamicRange = clamp(p95 - p5, 0, 1);
    const midtoneSpread = clamp(p75 - p25, 0, 1);
    const averageRed = redSum / total;
    const averageGreen = greenSum / total;
    const averageBlue = blueSum / total;
    const colorBalance = averageRed - averageBlue;
    const colorCast = Math.abs(averageRed - averageGreen) + Math.abs(averageGreen - averageBlue);

    return {
      meanLuminance: meanLuma,
      meanLuma,
      medianLuma: p50,
      p5Luminance: p5,
      p25Luminance: p25,
      p50Luminance: p50,
      p75Luminance: p75,
      p95Luminance: p95,
      p5Luma: p5,
      p25Luma: p25,
      p50Luma: p50,
      p75Luma: p75,
      p95Luma: p95,
      dynamicRange,
      midtoneSpread,
      midDensity: midDensityCount / total,
      highlightDensity: highlightDensityCount / total,
      shadowDensity: shadowDensityCount / total,
      highlightClipPercent: highlightClip / total,
      shadowClipPercent: shadowClip / total,
      averageSaturation: satSum / total,
      sat5,
      sat95,
      satSpread: clamp(sat95 - sat5, 0, 1),
      averageRed,
      averageGreen,
      averageBlue,
      colorBalance,
      colorCast,
    };
  }

  function analyzeImageStatsFromImage(image, {
    analysisMaxDimension = DEFAULT_ANALYSIS_MAX_DIMENSION,
    documentRef = null,
    coreApi = null,
  } = {}) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    if (!image?.width || !image?.height || !doc) {
      return buildFallbackImageStats(false, { coreApi });
    }

    const canvas = doc.createElement('canvas');
    const scale = Math.min(analysisMaxDimension / image.width, analysisMaxDimension / image.height, 1);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    if (!ctx) {
      return buildFallbackImageStats(false, { coreApi });
    }

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return analyzeImageStats(imageData, { coreApi });
  }

  function clampEditorAdjustments(adjustments, { rotation = 0, coreApi = null } = {}) {
    if (coreApi?.clampEditorAdjustments) {
      return coreApi.clampEditorAdjustments(adjustments, { rotation });
    }

    const toneCurve = clamp(Math.round(adjustments.toneCurve || 0), 0, 100);
    const toneCurvePoints = Array.isArray(adjustments?.toneCurvePoints)
      ? adjustments.toneCurvePoints
      : (
        coreApi?.toneCurvePointsFromLegacyStrength
          ? coreApi.toneCurvePointsFromLegacyStrength(toneCurve)
          : [{ x: 0, y: 0 }, { x: 1, y: 1 }]
      );

    return {
      exposure: clamp(Math.round(adjustments.exposure || 0), -400, 400),
      contrast: clamp(Math.round(adjustments.contrast || 0), -100, 100),
      highlights: clamp(Math.round(adjustments.highlights || 0), -100, 100),
      shadows: clamp(Math.round(adjustments.shadows || 0), -100, 100),
      whites: clamp(Math.round(adjustments.whites || 0), -100, 100),
      blacks: clamp(Math.round(adjustments.blacks || 0), -100, 100),
      toneCurve,
      toneCurvePoints,
      clarity: clamp(Math.round(adjustments.clarity || 0), -100, 100),
      dehaze: clamp(Math.round(adjustments.dehaze || 0), -100, 100),
      vibrance: clamp(Math.round(adjustments.vibrance || 0), -100, 100),
      saturation: clamp(Math.round(adjustments.saturation || 0), -100, 100),
      warmth: clamp(Math.round(adjustments.warmth || 0), -100, 100),
      sharpen: clamp(Math.round(adjustments.sharpen || 0), 0, 100),
      denoise: clamp(Math.round(adjustments.denoise || 0), 0, 100),
      rotation: ((Math.round(rotation) % 360) + 360) % 360,
    };
  }

  function estimateAutoAdjustments(stats, profile = 'natural', {
    isHdrMerged = false,
    rotation = 0,
    coreApi = null,
    defaultAdjustments = null,
    flatHdrRecoveryTrigger = DEFAULT_FLAT_HDR_RECOVERY_TRIGGER,
  } = {}) {
    if (coreApi?.estimateAutoAdjustments) {
      return coreApi.estimateAutoAdjustments(stats, profile, { isHdrMerged, rotation });
    }

    const baseDefaults = {
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
      toneCurvePoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      clarity: 0,
      dehaze: 0,
      sharpen: 0,
      denoise: 0,
      rotation: 0,
      ...(defaultAdjustments || {}),
    };

    // Conservative fallback path when shared editor core is unavailable.
    const fallbackStats = stats || buildFallbackImageStats(isHdrMerged, { coreApi });
    const exposure = Math.round(clamp((0.5 - (fallbackStats.meanLuma || 0.5)) * 100, -40, 40));
    const toneCurve = flatHdrRecoveryTrigger > 0 ? 0 : 0;

    return clampEditorAdjustments({
      ...baseDefaults,
      exposure,
      toneCurve,
    }, { rotation, coreApi });
  }

  return {
    DEFAULT_ANALYSIS_MAX_DIMENSION,
    DEFAULT_FLAT_HDR_RECOVERY_TRIGGER,
    clamp,
    percentileFromHistogram,
    buildFallbackImageStats,
    analyzeImageStats,
    analyzeImageStatsFromImage,
    clampEditorAdjustments,
    estimateAutoAdjustments,
  };
});
