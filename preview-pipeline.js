(function initAcePreviewPipeline(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && typeof root === 'object') {
    root.AcePreviewPipeline = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAcePreviewPipeline() {
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function srgbToLinear(value) {
    if (value <= 0.04045) return value / 12.92;
    return Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function linearToSrgb(value) {
    if (value <= 0.0031308) return value * 12.92;
    return 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  }

  function luminanceLinear(r, g, b) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function applyFilmicLuminance(value, toe, shoulder, gamma) {
    const safe = Math.max(0, value);
    const toeCut = Math.max(0, safe - toe);
    const shoulderMapped = toeCut / (1 + shoulder * toeCut);
    return Math.pow(clamp(shoulderMapped, 0, 1), gamma);
  }

  function applySubtleSCurve(value, strength = 0) {
    const x = clamp(value, 0, 1);
    const safeStrength = clamp(strength, 0, 0.35);
    const curveDelta = x * (1 - x) * (2 * x - 1);
    return clamp(x + curveDelta * safeStrength, 0, 1);
  }

  function applyWarmthNormalized(r, g, b, warmth) {
    const amt = warmth / 100;
    return [
      clamp(r + 0.11 * amt, 0, 1),
      clamp(g + 0.02 * amt, 0, 1),
      clamp(b - 0.1 * amt, 0, 1),
    ];
  }

  function applyVibranceSaturation(r, g, b, saturationFactor) {
    const satDelta = saturationFactor - 1;
    if (Math.abs(satDelta) < 0.0001) return [r, g, b];

    const gray = luminanceLinear(r, g, b);
    const maxV = Math.max(r, g, b);
    const minV = Math.min(r, g, b);
    const satLocal = maxV > 0 ? (maxV - minV) / maxV : 0;

    const weakColorWeight = 1 - satLocal;
    const highlightProtect = 1 - smoothstep(0.78, 1.0, gray);
    const scale = satDelta >= 0
      ? 1 + satDelta * (0.22 + weakColorWeight * 0.78) * highlightProtect
      : 1 + satDelta * 0.85;

    return [
      clamp(gray + (r - gray) * scale, 0, 1),
      clamp(gray + (g - gray) * scale, 0, 1),
      clamp(gray + (b - gray) * scale, 0, 1),
    ];
  }

  function adjustMaskedTone(value, amount, mask, darkenMultiplier = 1) {
    if (!amount || !mask) return value;

    if (amount > 0) {
      return clamp(value + (1 - value) * amount * mask, 0, 1);
    }

    return clamp(value + value * amount * mask * darkenMultiplier, 0, 1);
  }

  function processImageToDataUrl(image, adjustments, jpegQuality = 0.92, options = {}) {
    const fastMode = Boolean(options.fastMode);
    const maxDimension = Number(options.maxDimension || 0);
    const sourceScale = maxDimension > 0
      ? Math.min(maxDimension / Math.max(image.width, image.height), 1)
      : 1;
    const sourceWidth = Math.max(1, Math.round(image.width * sourceScale));
    const sourceHeight = Math.max(1, Math.round(image.height * sourceScale));
    const rotation = adjustments.rotation % 360;
    const rotate90 = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;
    const canvas = document.createElement('canvas');
    canvas.width = rotate90 ? sourceHeight : sourceWidth;
    canvas.height = rotate90 ? sourceWidth : sourceHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.drawImage(
      image,
      -sourceWidth / 2,
      -sourceHeight / 2,
      sourceWidth,
      sourceHeight
    );
    ctx.restore();

    let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // TEMPORARILY DISABLED FOR DEBUG:
    // Bypass lens-correction stage in preview pipeline to isolate washed-out rendering.
    // imageData = applyLensCorrection(imageData, options?.lensParams);
    const data = imageData.data;
    const exposureStops = clamp(adjustments.exposure || 0, -400, 400) / 100;
    const exposureGain = Math.pow(2, exposureStops);
    const contrast = clamp(adjustments.contrast || 0, -100, 100) / 100;
    const vibrance = clamp(adjustments.vibrance || 0, -100, 100) / 100;
    const saturation = clamp(adjustments.saturation || 0, -100, 100) / 100;
    const shadows = (adjustments.shadows || 0) / 100;
    const highlights = (adjustments.highlights || 0) / 100;
    const whites = (adjustments.whites || 0) / 100;
    const blacks = (adjustments.blacks || 0) / 100;
    const clarityBase = (adjustments.clarity || 0) / 100;
    const dehazeBase = (adjustments.dehaze || 0) / 100;
    const clarity = fastMode ? clarityBase * 0.7 : clarityBase;
    const dehaze = fastMode ? dehazeBase * 0.8 : dehazeBase;
    const warmth = clamp(adjustments.warmth || 0, -100, 100);
    const contrastPivot = 0.18;
    const contrastFactor = 1 + contrast * 0.72;
    const shadowToneAmount = shadows * 0.62;
    const highlightToneAmount = highlights * 0.78;
    const whiteToneAmount = whites * 0.5;
    const blackToneAmount = blacks * 0.58;
    const vibranceFactor = 1 + vibrance * 0.95;
    const saturationFactor = 1 + saturation * 0.85;
    const hasShadows = Math.abs(shadowToneAmount) > 0.0001;
    const hasHighlights = Math.abs(highlightToneAmount) > 0.0001;
    const hasWhites = Math.abs(whiteToneAmount) > 0.0001;
    const hasBlacks = Math.abs(blackToneAmount) > 0.0001;
    const hasContrast = Math.abs(contrastFactor - 1) > 0.0001;
    const hasDehaze = Math.abs(dehaze) > 0.0001;
    const hasClarity = Math.abs(clarity) > 0.0001;
    const hasVibrance = Math.abs(vibranceFactor - 1) > 0.0001;
    const hasSaturation = Math.abs(saturationFactor - 1) > 0.0001;
    const hasWarmth = Math.abs(warmth) > 0.0001;
    const filmicToe = clamp(Math.max(0, -blacks) * 0.018 + Math.max(0, dehaze) * 0.006, 0, 0.03);
    const filmicShoulder = clamp(Math.max(0, -highlights) * 0.08 + Math.max(0, whites) * 0.05, 0, 0.22);
    const filmicGamma = clamp(1 + Math.max(0, contrast) * 0.05, 1, 1.06);
    const hasFilmic = !fastMode && (filmicToe > 0 || filmicShoulder > 0);
    const toneCurveStrength = clamp((adjustments.toneCurve || 0) / 100, 0, 0.35);
    const hasToneCurve = toneCurveStrength > 0.0001;
    const needsToneMask = hasShadows || hasHighlights || hasWhites || hasBlacks;

    for (let i = 0; i < data.length; i += 4) {
      let r = srgbToLinear(data[i] / 255) * exposureGain;
      let g = srgbToLinear(data[i + 1] / 255) * exposureGain;
      let b = srgbToLinear(data[i + 2] / 255) * exposureGain;

      r = Math.max(0, r);
      g = Math.max(0, g);
      b = Math.max(0, b);

      let luminance = luminanceLinear(r, g, b);
      if (needsToneMask) {
        const shadowMask = hasShadows ? 1 - smoothstep(0.08, 0.55, luminance) : 0;
        const highlightMask = hasHighlights ? smoothstep(0.48, 1.0, luminance) : 0;
        const whiteMask = hasWhites ? smoothstep(0.68, 1.0, luminance) : 0;
        const blackMask = hasBlacks ? 1 - smoothstep(0.0, 0.28, luminance) : 0;

        if (hasHighlights) {
          r = adjustMaskedTone(r, highlightToneAmount, highlightMask);
          g = adjustMaskedTone(g, highlightToneAmount, highlightMask);
          b = adjustMaskedTone(b, highlightToneAmount, highlightMask);
        }

        if (hasShadows) {
          r = adjustMaskedTone(r, shadowToneAmount, shadowMask);
          g = adjustMaskedTone(g, shadowToneAmount, shadowMask);
          b = adjustMaskedTone(b, shadowToneAmount, shadowMask);
        }

        if (hasWhites) {
          r = adjustMaskedTone(r, whiteToneAmount, whiteMask);
          g = adjustMaskedTone(g, whiteToneAmount, whiteMask);
          b = adjustMaskedTone(b, whiteToneAmount, whiteMask);
        }

        if (hasBlacks) {
          r = adjustMaskedTone(r, blackToneAmount, blackMask, 1.08);
          g = adjustMaskedTone(g, blackToneAmount, blackMask, 1.08);
          b = adjustMaskedTone(b, blackToneAmount, blackMask, 1.08);
        }
      }

      if (hasToneCurve) {
        // Subtle S-curve after exposure/highlight/shadow shaping.
        r = applySubtleSCurve(r, toneCurveStrength);
        g = applySubtleSCurve(g, toneCurveStrength);
        b = applySubtleSCurve(b, toneCurveStrength);
      }

      if (hasContrast) {
        luminance = luminanceLinear(r, g, b);
        const highlightProtect = smoothstep(0.74, 1.0, luminance);
        const protectedContrast = 1 + (contrastFactor - 1) * (1 - highlightProtect * 0.35);
        r = Math.max(0, (r - contrastPivot) * protectedContrast + contrastPivot);
        g = Math.max(0, (g - contrastPivot) * protectedContrast + contrastPivot);
        b = Math.max(0, (b - contrastPivot) * protectedContrast + contrastPivot);
      }

      if (hasDehaze) {
        if (fastMode) {
          const dehazeOffset = dehaze * 0.018;
          const dehazeContrast = 1 + dehaze * 0.1;
          r = Math.max(0, (r - dehazeOffset - contrastPivot) * dehazeContrast + contrastPivot);
          g = Math.max(0, (g - dehazeOffset - contrastPivot) * dehazeContrast + contrastPivot);
          b = Math.max(0, (b - dehazeOffset - contrastPivot) * dehazeContrast + contrastPivot);
        } else {
          luminance = luminanceLinear(r, g, b);
          const maxV = Math.max(r, g, b);
          const minV = Math.min(r, g, b);
          const satLocal = maxV > 0 ? (maxV - minV) / maxV : 0;
          const hazeMask = smoothstep(0.24, 0.96, luminance) * (1 - satLocal * 0.8);
          const shadowProtection = 1 - smoothstep(0.0, 0.26, luminance);
          const hazeOffset = dehaze * hazeMask * 0.035 * (1 - shadowProtection * 0.4);

          r = Math.max(0, r - hazeOffset);
          g = Math.max(0, g - hazeOffset);
          b = Math.max(0, b - hazeOffset);

          const dehazeContrast = 1 + dehaze * 0.12;
          r = Math.max(0, (r - contrastPivot) * dehazeContrast + contrastPivot);
          g = Math.max(0, (g - contrastPivot) * dehazeContrast + contrastPivot);
          b = Math.max(0, (b - contrastPivot) * dehazeContrast + contrastPivot);

          if (dehaze > 0) {
            const colorDepthBoost = dehaze * hazeMask * 0.08;
            luminance = luminanceLinear(r, g, b);
            r = clamp(luminance + (r - luminance) * (1 + colorDepthBoost), 0, 1);
            g = clamp(luminance + (g - luminance) * (1 + colorDepthBoost), 0, 1);
            b = clamp(luminance + (b - luminance) * (1 + colorDepthBoost), 0, 1);
          }
        }
      }

      if (hasClarity) {
        luminance = luminanceLinear(r, g, b);
        const midMask = smoothstep(0.12, 0.64, luminance) * (1 - smoothstep(0.62, 0.95, luminance));
        const lumaContrastScale = 1 + clarity * midMask * 0.26;
        r = clamp((r - luminance) * lumaContrastScale + luminance, 0, 1);
        g = clamp((g - luminance) * lumaContrastScale + luminance, 0, 1);
        b = clamp((b - luminance) * lumaContrastScale + luminance, 0, 1);
      }

      if (hasFilmic) {
        luminance = luminanceLinear(r, g, b);
        if (luminance > 0.0001) {
          const mappedLum = applyFilmicLuminance(luminance, filmicToe, filmicShoulder, filmicGamma);
          const scale = mappedLum / luminance;
          r = clamp(r * scale, 0, 1);
          g = clamp(g * scale, 0, 1);
          b = clamp(b * scale, 0, 1);
        }
      }

      if (hasVibrance) {
        [r, g, b] = applyVibranceSaturation(r, g, b, vibranceFactor);
      }
      if (hasSaturation) {
        const gray = luminanceLinear(r, g, b);
        r = clamp(gray + (r - gray) * saturationFactor, 0, 1);
        g = clamp(gray + (g - gray) * saturationFactor, 0, 1);
        b = clamp(gray + (b - gray) * saturationFactor, 0, 1);
      }
      if (hasWarmth) {
        [r, g, b] = applyWarmthNormalized(r, g, b, warmth);
      }

      data[i] = Math.round(clamp(linearToSrgb(r), 0, 1) * 255);
      data[i + 1] = Math.round(clamp(linearToSrgb(g), 0, 1) * 255);
      data[i + 2] = Math.round(clamp(linearToSrgb(b), 0, 1) * 255);
    }

    ctx.putImageData(imageData, 0, 0);

    if (!fastMode && adjustments.denoise > 0) {
      const passes = Math.max(1, Math.round(adjustments.denoise / 20));
      for (let i = 0; i < passes; i++) {
        ctx.filter = `blur(${0.25 + adjustments.denoise / 80}px)`;
        const temp = document.createElement('canvas');
        temp.width = canvas.width;
        temp.height = canvas.height;
        const tempContext = temp.getContext('2d');
        tempContext.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(temp, 0, 0);
        ctx.filter = 'none';
      }
    }

    if (!fastMode && adjustments.sharpen > 0) {
      const strength = adjustments.sharpen / 100;
      const src = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const out = ctx.createImageData(canvas.width, canvas.height);
      const s = src.data;
      const d = out.data;
      const w = canvas.width;
      const h = canvas.height;
      const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0];

      for (let i = 0; i < s.length; i++) d[i] = s[i];

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          for (let c = 0; c < 3; c++) {
            let value = 0;
            let ki = 0;

            for (let ky = -1; ky <= 1; ky++) {
              for (let kx = -1; kx <= 1; kx++) {
                value += s[((y + ky) * w + (x + kx)) * 4 + c] * kernel[ki++];
              }
            }

            const idx = (y * w + x) * 4 + c;
            d[idx] = clamp(s[idx] * (1 - strength) + value * strength, 0, 255);
          }

          d[(y * w + x) * 4 + 3] = s[(y * w + x) * 4 + 3];
        }
      }

      ctx.putImageData(out, 0, 0);
    }

    return canvas.toDataURL('image/jpeg', clamp(jpegQuality, fastMode ? 0.6 : 0.4, 1));
  }

  return {
    processImageToDataUrl,
    applyWarmthNormalized,
    applyVibranceSaturation,
    applyFilmicLuminance,
    applySubtleSCurve,
    adjustMaskedTone,
    smoothstep,
    srgbToLinear,
    linearToSrgb,
    luminanceLinear,
  };
});
