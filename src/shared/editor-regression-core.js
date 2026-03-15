(function initAceEditorCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.AceEditorCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const FLAT_HDR_RECOVERY_TRIGGER = 0.36;
  const MAX_TONE_CURVE_POINTS = 8;
  const TONE_CURVE_POINT_PRECISION = 1000;

  const defaultAdjustments = {
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
    toneCurvePoints: [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ],
    clarity: 0,
    dehaze: 0,
    sharpen: 0,
    denoise: 0,
    rotation: 0,
  };

  const PRESET_ADJUSTMENT_KEYS = [
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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function roundCurvePoint(value) {
    return Math.round(clamp(value, 0, 1) * TONE_CURVE_POINT_PRECISION) / TONE_CURVE_POINT_PRECISION;
  }

  function createNeutralToneCurvePoints() {
    return [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
  }

  function normalizeToneCurvePoints(rawPoints, { maxPoints = MAX_TONE_CURVE_POINTS } = {}) {
    const maxInternalPoints = Math.max(0, Math.min(12, Math.round(maxPoints || MAX_TONE_CURVE_POINTS)) - 2);
    const parsed = [];
    const pushPoint = (xRaw, yRaw) => {
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      parsed.push({
        x: clamp(x, 0, 1),
        y: clamp(y, 0, 1),
      });
    };

    let source = rawPoints;
    if (typeof source === 'string') {
      try {
        source = JSON.parse(source);
      } catch {
        source = null;
      }
    }

    if (Array.isArray(source)) {
      for (const entry of source) {
        if (Array.isArray(entry)) {
          pushPoint(entry[0], entry[1]);
          continue;
        }
        if (entry && typeof entry === 'object') {
          pushPoint(entry.x, entry.y);
        }
      }
    }

    const sorted = parsed
      .filter((point) => point.x > 0 && point.x < 1)
      .sort((a, b) => (a.x - b.x) || (a.y - b.y));

    const deduped = [];
    for (const point of sorted) {
      const previous = deduped[deduped.length - 1];
      if (previous && Math.abs(previous.x - point.x) < 0.0005) {
        deduped[deduped.length - 1] = point;
      } else {
        deduped.push(point);
      }
    }

    const limitedInternal = deduped.slice(0, maxInternalPoints).map((point) => ({
      x: roundCurvePoint(point.x),
      y: roundCurvePoint(point.y),
    }));

    return [
      { x: 0, y: 0 },
      ...limitedInternal,
      { x: 1, y: 1 },
    ];
  }

  function cloneToneCurvePoints(points) {
    return normalizeToneCurvePoints(points).map((point) => ({ x: point.x, y: point.y }));
  }

  function isNeutralToneCurvePoints(points) {
    const normalized = normalizeToneCurvePoints(points);
    if (normalized.length !== 2) return false;
    const first = normalized[0];
    const last = normalized[1];
    return first.x === 0 && first.y === 0 && last.x === 1 && last.y === 1;
  }

  function toneCurvePointsFromLegacyStrength(strengthRaw) {
    const strength = clamp(Number(strengthRaw) || 0, 0, 100) / 100;
    if (strength <= 0.0001) {
      return createNeutralToneCurvePoints();
    }

    const shoulderLift = 0.033 * strength;
    return normalizeToneCurvePoints([
      { x: 0, y: 0 },
      { x: 0.25, y: clamp(0.25 - shoulderLift, 0, 1) },
      { x: 0.75, y: clamp(0.75 + shoulderLift, 0, 1) },
      { x: 1, y: 1 },
    ]);
  }

  function sampleToneCurveLinear(points, xRaw) {
    const x = clamp(Number(xRaw) || 0, 0, 1);
    const normalized = normalizeToneCurvePoints(points);
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    for (let i = 0; i < normalized.length - 1; i += 1) {
      const left = normalized[i];
      const right = normalized[i + 1];
      if (x < left.x || x > right.x) continue;
      const span = Math.max(0.000001, right.x - left.x);
      const t = (x - left.x) / span;
      return clamp(left.y + (right.y - left.y) * t, 0, 1);
    }

    return x;
  }

  function estimateLegacyToneCurveStrengthFromPoints(points) {
    const normalized = normalizeToneCurvePoints(points);
    if (isNeutralToneCurvePoints(normalized)) return 0;
    const quarterSample = sampleToneCurveLinear(normalized, 0.25);
    const threeQuarterSample = sampleToneCurveLinear(normalized, 0.75);
    const offset = Math.max(0, ((0.25 - quarterSample) + (threeQuarterSample - 0.75)) * 0.5);
    return clamp(Math.round((offset / 0.033) * 100), 0, 100);
  }

  function buildFallbackImageStats(isHdrMerged = false) {
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

  function clampEditorAdjustments(adjustments, { rotation = 0 } = {}) {
    const toneCurve = clamp(Math.round(adjustments.toneCurve || 0), 0, 100);
    const toneCurvePoints = Array.isArray(adjustments?.toneCurvePoints)
      ? normalizeToneCurvePoints(adjustments.toneCurvePoints)
      : toneCurvePointsFromLegacyStrength(toneCurve);

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

  function estimateAutoAdjustments(stats, profile = 'natural', { isHdrMerged = false, rotation = 0 } = {}) {
    const sourceStats = stats || buildFallbackImageStats(isHdrMerged);
    const meanLuma = clamp(sourceStats.meanLuminance ?? sourceStats.meanLuma ?? 0.5, 0, 1);
    const medianLuma = clamp(sourceStats.medianLuma ?? meanLuma, 0, 1);
    const p5 = clamp(sourceStats.p5Luminance ?? sourceStats.p5Luma ?? 0.06, 0, 1);
    const p25 = clamp(sourceStats.p25Luminance ?? sourceStats.p25Luma ?? ((medianLuma + p5) / 2), 0, 1);
    const p75 = clamp(sourceStats.p75Luminance ?? sourceStats.p75Luma ?? ((medianLuma + (sourceStats.p95Luminance ?? sourceStats.p95Luma ?? 0.9)) / 2), 0, 1);
    const p95 = clamp(sourceStats.p95Luminance ?? sourceStats.p95Luma ?? 0.9, 0, 1);
    const dynamicRange = clamp(sourceStats.dynamicRange ?? (p95 - p5), 0, 1);
    const midtoneSpread = clamp(sourceStats.midtoneSpread ?? (p75 - p25), 0, 1);
    const midDensity = clamp(sourceStats.midDensity ?? 0.34, 0, 1);
    const highlightDensity = clamp(sourceStats.highlightDensity ?? 0.06, 0, 1);
    const shadowDensity = clamp(sourceStats.shadowDensity ?? 0.08, 0, 1);
    const highlightClipPercent = clamp(sourceStats.highlightClipPercent ?? 0, 0, 1);
    const shadowClipPercent = clamp(sourceStats.shadowClipPercent ?? 0, 0, 1);
    const averageSaturation = clamp(sourceStats.averageSaturation ?? 0.32, 0, 1);
    const satSpread = clamp(sourceStats.satSpread ?? ((sourceStats.sat95 ?? 0.55) - (sourceStats.sat5 ?? 0.1)), 0, 1);
    const averageRed = clamp(sourceStats.averageRed ?? 0.5, 0, 1);
    const averageGreen = clamp(sourceStats.averageGreen ?? 0.5, 0, 1);
    const averageBlue = clamp(sourceStats.averageBlue ?? 0.5, 0, 1);
    const colorBalance = clamp(sourceStats.colorBalance ?? (averageRed - averageBlue), -1, 1);
    const colorCast = clamp(sourceStats.colorCast ?? (Math.abs(averageRed - averageGreen) + Math.abs(averageGreen - averageBlue)), 0, 2);
    const toeSpan = clamp(medianLuma - p5, 0, 1);
    const shoulderSpan = clamp(p95 - medianLuma, 0, 1);
    const tonalCrowding = clamp((0.24 - Math.min(toeSpan, shoulderSpan)) / 0.24, 0, 1);
    const midtoneCompression = clamp((0.34 - midtoneSpread) / 0.18, 0, 1);
    const midCrowding = clamp((midDensity - 0.46) / 0.28, 0, 1);
    const lowSaturationBias = clamp((0.32 - averageSaturation) / 0.22, 0, 1);
    const lowSatSpreadBias = clamp((0.44 - satSpread) / 0.24, 0, 1);
    const highlightPressure = clamp(
      clamp((p95 - 0.93) / 0.05, 0, 1) * 0.4
      + clamp((highlightDensity - 0.11) / 0.16, 0, 1) * 0.25
      + clamp((highlightClipPercent - 0.01) / 0.03, 0, 1) * 0.35,
      0,
      1
    );
    const shadowRisk = clamp(
      clamp((shadowClipPercent - 0.02) / 0.05, 0, 1) * 0.6
      + clamp((shadowDensity - 0.2) / 0.25, 0, 1) * 0.4,
      0,
      1
    );
    const liftedBlacksNeed = clamp((p5 - 0.085) / 0.08, 0, 1) * (1 - shadowRisk);
    const clipSafety = 1 - clamp(highlightClipPercent * 13 + shadowClipPercent * 11, 0, 1);
    const centerBias = clamp((midDensity - 0.49) / 0.24, 0, 1);
    const lowTailCompression = clamp((0.24 - toeSpan) / 0.2, 0, 1);
    const highTailCompression = clamp((0.27 - shoulderSpan) / 0.2, 0, 1);
    const centeredHistogramCompression = clamp(
      centerBias * 0.42
      + midtoneCompression * 0.24
      + tonalCrowding * 0.19
      + ((lowTailCompression + highTailCompression) * 0.5) * 0.15,
      0,
      1
    );
    const alreadyGoodImage = (
      dynamicRange >= 0.58
      && midtoneSpread >= 0.27
      && averageSaturation >= 0.26
      && highlightClipPercent <= 0.02
      && shadowClipPercent <= 0.02
      && midDensity <= 0.6
      && p5 >= 0.03
      && p95 <= 0.965
    );
    let flatRecoveryScore = 0;
    if (isHdrMerged && !alreadyGoodImage) {
      const lowRangeBias = clamp((0.63 - dynamicRange) / 0.28, 0, 1);
      const hazeBias = clamp((meanLuma - 0.45) / 0.2, 0, 1) * clamp((0.58 - dynamicRange) / 0.28, 0, 1);
      flatRecoveryScore = clamp(
        (
          lowRangeBias * 0.29
          + midtoneCompression * 0.28
          + midCrowding * 0.16
          + tonalCrowding * 0.09
          + centeredHistogramCompression * 0.12
          + (lowSaturationBias * 0.6 + lowSatSpreadBias * 0.4) * 0.06
        ) * clipSafety,
        0,
        1
      );

      if (dynamicRange > 0.62 && midtoneSpread > 0.3) {
        flatRecoveryScore *= 0.35;
      }
      if (shadowRisk > 0.45 && p5 < 0.07) {
        flatRecoveryScore *= 0.78;
      }
      flatRecoveryScore = clamp(flatRecoveryScore + hazeBias * 0.08, 0, 1);
    }
    const needsFlatRecovery = flatRecoveryScore >= FLAT_HDR_RECOVERY_TRIGGER;
    const antiFlatNeedScore = clamp(
      flatRecoveryScore * 0.56 + centeredHistogramCompression * 0.44,
      0,
      1
    );
    const shouldApplyAntiFlatGuard = (
      isHdrMerged
      && !alreadyGoodImage
      && clipSafety > 0.2
      && antiFlatNeedScore >= 0.34
      && (
        needsFlatRecovery
        || (centeredHistogramCompression > 0.36 && dynamicRange < 0.68)
      )
    );

    const targetMid = isHdrMerged ? 0.495 : 0.5;
    let exposure = (targetMid - medianLuma) * 106 + (0.49 - meanLuma) * 34;
    exposure -= highlightPressure * 20;
    if (meanLuma < 0.4 && highlightPressure < 0.35) {
      exposure += (0.4 - meanLuma) * 26;
    }
    if (meanLuma > 0.58) {
      exposure -= (meanLuma - 0.58) * 30;
    }
    if (shadowClipPercent > 0.04 && medianLuma < 0.44) {
      exposure += clamp((shadowClipPercent - 0.04) * 260, 0, 11);
    }

    let highlights = -((p95 - 0.89) * 165) - highlightPressure * 22;
    if (p95 < 0.82 && highlightDensity < 0.08) highlights += 5;

    let shadows = ((0.105 - p5) * 160) + shadowClipPercent * 170 - shadowRisk * 8;
    if (p5 > 0.12) shadows -= (p5 - 0.12) * 90;

    let whites = (0.93 - p95) * 120 - highlightPressure * 10 + clamp((0.11 - highlightDensity) * 20, -8, 6);
    let blacks = (0.06 - p5) * 118 - shadowClipPercent * 120 - shadowRisk * 12;
    if (liftedBlacksNeed > 0.18) {
      blacks -= 4 + liftedBlacksNeed * 8;
    }
    if (shadowRisk > 0.22) {
      blacks += shadowRisk * 12;
    }

    let contrast = (0.59 - dynamicRange) * 86 + (0.32 - midtoneSpread) * 44 + (0.5 - medianLuma) * 10;
    if (highlightPressure > 0.45) contrast -= 4;
    if (shadowRisk > 0.45) contrast -= 3;

    let clarity = 6 + (0.33 - midtoneSpread) * 18 + (0.56 - dynamicRange) * 11;
    let dehaze = (0.5 - dynamicRange) * 14 + midtoneCompression * 5 + (lowSaturationBias * 0.7 + lowSatSpreadBias * 0.3) * 4;
    if (highlightPressure > 0.55) dehaze -= 2;

    let vibrance = 10 + (0.32 - averageSaturation) * 80 + (0.44 - satSpread) * 18;
    let saturation = 3 + (0.3 - averageSaturation) * 26;
    if (averageSaturation > 0.55) {
      vibrance -= 4;
      saturation -= 2;
    }

    let warmth = clamp((averageBlue - averageRed) * 60, -14, 14);
    if (colorCast < 0.05) warmth *= 0.4;
    if (Math.abs(colorBalance) < 0.02) warmth *= 0.7;
    let toneCurve = 0;
    let sharpen = isHdrMerged ? 14 : 13;
    let denoise = isHdrMerged ? 4 : 3;

    if (profile === 'auto') {
      exposure *= 0.92;
      contrast -= 1;
      clarity -= 1;
      dehaze -= 1;
      vibrance -= 1;
      saturation -= 1;

      if (needsFlatRecovery) {
        const flatStrength = flatRecoveryScore;
        const depthNeed = clamp(midtoneCompression * 0.55 + midCrowding * 0.45, 0, 1);
        contrast += 8 + flatStrength * 12 + depthNeed * 4;
        clarity += 2 + flatStrength * 4 + depthNeed * 2;
        dehaze += 1 + flatStrength * 4 + depthNeed * 2;
        whites += 2 + flatStrength * 4;
        shadows += flatStrength * 3;
        if (liftedBlacksNeed > 0.1 && shadowRisk < 0.35) {
          blacks -= 2 + flatStrength * 5 + liftedBlacksNeed * 5;
        }
        highlights = Math.min(highlights, -4 - highlightPressure * 7);
        if (meanLuma > 0.52 && highlightPressure < 0.35) {
          exposure -= (meanLuma - 0.52) * 18;
        }
        contrast = Math.max(contrast, 12 + flatStrength * 14);
        toneCurve = Math.max(toneCurve, 8 + flatStrength * 11 + depthNeed * 6);
      }
      if (highlightPressure > 0.5) {
        highlights -= 4 + highlightPressure * 5;
      }
      if (averageSaturation < 0.3 || satSpread < 0.34) {
        vibrance += 7 + clamp((0.34 - satSpread) * 12, 0, 5);
        saturation += 1;
      }
      if (shadowRisk > 0.45) {
        blacks += 6 * shadowRisk;
        shadows += 3 * shadowRisk;
      }

      const guardedAutoBlackFloor = alreadyGoodImage
        ? -6
        : needsFlatRecovery
          ? (-8 - flatRecoveryScore * 12)
          : -14;
      blacks = Math.max(blacks, guardedAutoBlackFloor);
      if (!needsFlatRecovery) {
        toneCurve = Math.min(toneCurve, 6);
      }

      if (alreadyGoodImage) {
        contrast = clamp(contrast, -2, 8);
        highlights = Math.max(highlights, -7);
        shadows = Math.max(shadows, 1);
        whites = Math.max(whites, 2);
        blacks = Math.max(blacks, -5);
        clarity = clamp(clarity, 3, 9);
        dehaze = clamp(dehaze, -1, 4);
        toneCurve = Math.min(toneCurve, 4);
      } else if (needsFlatRecovery && isHdrMerged && dynamicRange < 0.62) {
        toneCurve = Math.max(toneCurve, 8 + (0.62 - dynamicRange) * 40);
      }
    } else if (profile === 'real-estate') {
      exposure += 18;
      contrast += 4;
      highlights -= 5;
      shadows += 5;
      whites += 4;
      blacks -= 3;
      clarity += 5;
      dehaze += 3;
      vibrance += 2;
      saturation += 1;
      sharpen += 1;
      denoise += 1;
    } else if (profile === 'punchy') {
      exposure -= 3;
      contrast += 8;
      highlights -= 4;
      shadows -= 1;
      whites += 4;
      blacks -= 6;
      clarity += 7;
      dehaze += 3;
      vibrance += 5;
      saturation += 2;
      sharpen += 2;
    } else if (profile === 'soft') {
      exposure += 1;
      contrast -= 3;
      highlights += 0;
      shadows += 1;
      whites -= 1;
      blacks -= 1;
      clarity -= 2;
      dehaze -= 1;
      vibrance -= 2;
      saturation -= 1;
      sharpen -= 1;
      denoise += 2;
    }

    if (!['soft', 'auto'].includes(profile) && dynamicRange < 0.46) {
      contrast = Math.max(contrast, 12);
      clarity = Math.max(clarity, 8);
      blacks = Math.min(blacks, -6);
    }

    if (profile === 'real-estate') {
      contrast = Math.max(contrast, 16);
      dehaze = Math.max(dehaze, 2);
      blacks = alreadyGoodImage ? Math.max(blacks, -5) : Math.min(blacks, -7);
      highlights = alreadyGoodImage ? Math.max(highlights, -6) : Math.min(highlights, -9);
    }

    if (profile === 'soft') {
      contrast = Math.max(contrast, 5);
      dehaze = Math.max(dehaze, 0);
      blacks = Math.min(blacks, -4);
    }

    if ((profile === 'auto' || profile === 'natural') && alreadyGoodImage) {
      const alreadyGoodExposureBoost = highlightClipPercent > 0.012 ? 30 : 38;
      exposure += alreadyGoodExposureBoost;
      contrast = clamp(contrast, -2, 10);
      highlights = Math.max(highlights, -8);
      shadows = Math.max(shadows, 1);
      blacks = Math.max(blacks, -6);
      whites = Math.max(whites, 2);
      toneCurve = Math.min(toneCurve, 4);
    }

    if (profile === 'real-estate' && alreadyGoodImage) {
      exposure += 16;
      shadows = Math.max(shadows, 3);
      whites = Math.max(whites, 5);
      blacks = Math.max(blacks, -5);
      highlights = Math.max(highlights, -6);
      toneCurve = Math.min(toneCurve, 4);
    }

    if (shouldApplyAntiFlatGuard) {
      const profileStrengthScale = profile === 'auto'
        ? 1
        : profile === 'natural'
          ? 0.9
          : profile === 'real-estate'
            ? 0.84
            : profile === 'punchy'
              ? 0.72
              : 0.62; // soft
      const antiFlatStrength = clamp(antiFlatNeedScore * profileStrengthScale, 0, 1);
      const endpointNeed = clamp((0.68 - dynamicRange) / 0.3, 0, 1);
      const endpointStrength = antiFlatStrength * endpointNeed;
      const shadowRoom = clamp((p5 - 0.03) / 0.12, 0, 1);
      const highlightRoom = clamp((0.97 - p95) / 0.12, 0, 1);

      const blackEndpointPush = (2 + endpointStrength * 10) * shadowRoom * (1 - shadowRisk * 0.75);
      const whiteEndpointLift = (2 + endpointStrength * 10) * highlightRoom * (1 - highlightPressure * 0.75);
      blacks -= blackEndpointPush;
      whites += whiteEndpointLift;

      const curveTarget = 6 + antiFlatStrength * 10 + centeredHistogramCompression * 5;
      toneCurve = Math.max(toneCurve, curveTarget);

      contrast += 3 + antiFlatStrength * 7;

      const microContrastNeed = clamp((0.3 - midtoneSpread) / 0.18, 0, 1);
      if (microContrastNeed > 0.12) {
        clarity += (0.8 + antiFlatStrength * 2.6) * microContrastNeed;
      }

      const hazeNeed = clamp((0.56 - dynamicRange) / 0.24, 0, 1);
      if (hazeNeed > 0.2) {
        dehaze += (0.6 + antiFlatStrength * 2.4) * hazeNeed;
      }

      if (meanLuma > 0.5 && highlightPressure < 0.45) {
        exposure -= antiFlatStrength * clamp((meanLuma - 0.5) / 0.2, 0, 1) * 7;
      }

      if (highlightPressure > 0.45 || highlightClipPercent > 0.01) {
        highlights -= 2 + highlightPressure * 5;
        whites -= highlightPressure * 4 + highlightClipPercent * 40;
      }

      if (shadowRisk > 0.45 || shadowClipPercent > 0.02) {
        blacks += shadowRisk * 7 + shadowClipPercent * 80;
        shadows += shadowRisk * 3;
      }

      const blackFloor = -24 + shadowRisk * 8;
      const whiteCeiling = 68 - highlightPressure * 16;
      blacks = Math.max(blacks, blackFloor);
      whites = Math.min(whites, whiteCeiling);
      toneCurve = Math.min(toneCurve, 24);
    }

    return clampEditorAdjustments({
      ...defaultAdjustments,
      exposure,
      contrast,
      highlights,
      shadows,
      whites,
      blacks,
      clarity,
      dehaze,
      vibrance,
      saturation,
      warmth,
      toneCurve,
      sharpen,
      denoise,
    }, { rotation });
  }

  function normalizePresetAdjustmentValue(key, rawValue) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return defaultAdjustments[key] || 0;

    if (key === 'exposure') {
      if (Math.abs(parsed) <= 8) return Math.round(parsed * 100);
      return Math.round(parsed);
    }

    if (key === 'toneCurve') {
      return clamp(Math.round(parsed), 0, 100);
    }

    return Math.round(parsed);
  }

  function presetAdjustmentsFromValues(values = {}) {
    const out = {};
    PRESET_ADJUSTMENT_KEYS.forEach((key) => {
      out[key] = normalizePresetAdjustmentValue(key, values[key]);
    });
    out.toneCurvePoints = normalizeToneCurvePoints(values?.toneCurvePoints);
    if (isNeutralToneCurvePoints(out.toneCurvePoints) && out.toneCurve > 0) {
      out.toneCurvePoints = toneCurvePointsFromLegacyStrength(out.toneCurve);
    }
    return out;
  }

  function presetStoragePayloadFromAdjustments(name, adjustments = {}) {
    const payload = {
      name: String(name || '').trim(),
    };

    PRESET_ADJUSTMENT_KEYS.forEach((key) => {
      const value = Number(adjustments[key] ?? defaultAdjustments[key] ?? 0);
      payload[key] = key === 'exposure'
        ? Number((value / 100).toFixed(2))
        : Math.round(value);
    });
    payload.toneCurvePoints = normalizeToneCurvePoints(adjustments?.toneCurvePoints);

    return payload;
  }

  function resolveRenderAdjustments(adjustments = null, defaults = defaultAdjustments) {
    const merged = {
      ...(defaults || defaultAdjustments),
      ...(adjustments || {}),
    };
    const toneCurveRaw = Number(merged.toneCurve);
    merged.toneCurve = Number.isFinite(toneCurveRaw) ? clamp(Math.round(toneCurveRaw), 0, 100) : 0;
    const hasExplicitCurvePoints = adjustments
      && Object.prototype.hasOwnProperty.call(adjustments, 'toneCurvePoints');
    merged.toneCurvePoints = hasExplicitCurvePoints
      ? normalizeToneCurvePoints(adjustments.toneCurvePoints)
      : toneCurvePointsFromLegacyStrength(merged.toneCurve);
    return merged;
  }

  function buildCompareRenderState({ photo, processedUrl, sliderPosition }) {
    const safePhoto = photo || {};
    const cleanedSrc = processedUrl || safePhoto.processedUrl || safePhoto.fastProcessedUrl || safePhoto.originalUrl || '';
    const originalSrc = safePhoto.originalUrl || '';
    const isHdrMerged = Boolean(safePhoto.isHdrMerged);
    const reveal = clamp(Number(sliderPosition) || 50, 0, 100);

    return {
      split: {
        originalLabel: isHdrMerged ? 'Merged 16-bit TIFF Master' : 'Original',
        cleanedLabel: isHdrMerged ? 'Current Edit Preview' : 'Cleaned Preview',
        originalSrc,
        cleanedSrc,
      },
      slider: {
        label: isHdrMerged
          ? 'Merged 16-bit TIFF Master / Current Edit Preview'
          : 'Before / After Slider',
        reveal,
        originalSrc,
        cleanedSrc,
      },
    };
  }

  return {
    FLAT_HDR_RECOVERY_TRIGGER,
    MAX_TONE_CURVE_POINTS,
    defaultAdjustments: {
      ...defaultAdjustments,
      toneCurvePoints: cloneToneCurvePoints(defaultAdjustments.toneCurvePoints),
    },
    PRESET_ADJUSTMENT_KEYS: [...PRESET_ADJUSTMENT_KEYS],
    clamp,
    createNeutralToneCurvePoints,
    normalizeToneCurvePoints,
    cloneToneCurvePoints,
    isNeutralToneCurvePoints,
    toneCurvePointsFromLegacyStrength,
    estimateLegacyToneCurveStrengthFromPoints,
    buildFallbackImageStats,
    clampEditorAdjustments,
    estimateAutoAdjustments,
    normalizePresetAdjustmentValue,
    presetAdjustmentsFromValues,
    presetStoragePayloadFromAdjustments,
    resolveRenderAdjustments,
    buildCompareRenderState,
  };
});
