(function initAceHistogram(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root && typeof root === 'object') {
    root.AceHistogram = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAceHistogram() {
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function sourceKeyForPhoto(photo) {
    if (!photo) return '';
    const mode = photo.processedUrl ? 'processed' : 'original';
    return `${photo.id}:${photo.adjustVersion || 0}:${mode}`;
  }

  function resizeHistogramCanvas(canvas, { dprOverride = null } = {}) {
    if (!canvas) {
      return { width: 1, height: 1 };
    }

    const dprSource = dprOverride == null
      ? (typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1)
      : dprOverride;
    const dpr = clamp(dprSource, 1, 2);
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth || 1));
    const cssHeight = Math.max(1, Math.round(canvas.clientHeight || 1));
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    return { width: targetWidth, height: targetHeight };
  }

  function drawHistogramBins(canvas, bins = null, options = {}) {
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = resizeHistogramCanvas(canvas, options);
    ctx.clearRect(0, 0, width, height);

    const plotPaddingX = 4;
    const plotPaddingY = 3;
    const plotWidth = Math.max(1, width - (plotPaddingX * 2));
    const plotHeight = Math.max(1, height - (plotPaddingY * 2));

    const baseGradient = ctx.createLinearGradient(0, 0, 0, height);
    baseGradient.addColorStop(0, 'rgba(24, 33, 48, 0.9)');
    baseGradient.addColorStop(1, 'rgba(10, 15, 24, 0.96)');
    ctx.fillStyle = baseGradient;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(130, 148, 184, 0.24)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotPaddingX, height - plotPaddingY - 0.5);
    ctx.lineTo(width - plotPaddingX, height - plotPaddingY - 0.5);
    ctx.stroke();

    if (!Array.isArray(bins) || !bins.length) {
      return;
    }

    const maxBin = Math.max(1, ...bins);
    const lineColor = 'rgba(173, 201, 255, 0.96)';
    const fillGradient = ctx.createLinearGradient(0, plotPaddingY, 0, height - plotPaddingY);
    fillGradient.addColorStop(0, 'rgba(118, 160, 255, 0.54)');
    fillGradient.addColorStop(1, 'rgba(70, 112, 196, 0.08)');

    ctx.beginPath();
    for (let i = 0; i < bins.length; i += 1) {
      const normalized = clamp(bins[i] / maxBin, 0, 1);
      const x = plotPaddingX + (i / (bins.length - 1)) * plotWidth;
      const y = plotPaddingY + (1 - normalized) * plotHeight;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.lineTo(width - plotPaddingX, height - plotPaddingY);
    ctx.lineTo(plotPaddingX, height - plotPaddingY);
    ctx.closePath();
    ctx.fillStyle = fillGradient;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < bins.length; i += 1) {
      const normalized = clamp(bins[i] / maxBin, 0, 1);
      const x = plotPaddingX + (i / (bins.length - 1)) * plotWidth;
      const y = plotPaddingY + (1 - normalized) * plotHeight;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  function buildLuminanceHistogramFromImage(image, { binCount = 64, maxDimension = 224, documentRef = null } = {}) {
    const bins = new Array(binCount).fill(0);
    if (!image?.width || !image?.height) return bins;

    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    if (!doc) return bins;

    const canvas = doc.createElement('canvas');
    const scale = Math.min(maxDimension / image.width, maxDimension / image.height, 1);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return bins;

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const luma = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      const bucket = clamp(Math.floor(luma * (binCount - 1)), 0, binCount - 1);
      bins[bucket] += 1;
    }

    return bins;
  }

  return {
    sourceKeyForPhoto,
    resizeHistogramCanvas,
    drawHistogramBins,
    buildLuminanceHistogramFromImage,
  };
});
