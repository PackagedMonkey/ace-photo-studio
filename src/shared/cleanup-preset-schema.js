const CLEANUP_PRESET_FIELDS = [
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
const MAX_TONE_CURVE_POINTS = 8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeToneCurvePoints(rawPoints, { maxPoints = MAX_TONE_CURVE_POINTS } = {}) {
  const maxInternalPoints = Math.max(0, Math.min(12, Math.round(maxPoints || MAX_TONE_CURVE_POINTS)) - 2);
  const points = [];
  const pushPoint = (xRaw, yRaw) => {
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    points.push({
      x: Math.round(clamp(x, 0, 1) * 1000) / 1000,
      y: Math.round(clamp(y, 0, 1) * 1000) / 1000,
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

  const sortedInternal = points
    .filter((point) => point.x > 0 && point.x < 1)
    .sort((a, b) => (a.x - b.x) || (a.y - b.y));

  const deduped = [];
  for (const point of sortedInternal) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.x - point.x) < 0.0005) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }

  return [
    { x: 0, y: 0 },
    ...deduped.slice(0, maxInternalPoints),
    { x: 1, y: 1 },
  ];
}

function normalizeCleanupPresetEntry(entry) {
  const name = String(entry?.name || '').trim();
  if (!name) return null;

  const normalized = { name: name.slice(0, 64) };
  for (const field of CLEANUP_PRESET_FIELDS) {
    const parsed = Number(entry?.[field]);
    const value = Number.isFinite(parsed) ? parsed : 0;
    if (field === 'exposure') {
      normalized[field] = Number(value.toFixed(2));
    } else if (field === 'toneCurve') {
      normalized[field] = Math.max(0, Math.min(100, Math.round(value)));
    } else {
      normalized[field] = Math.round(value);
    }
  }
  normalized.toneCurvePoints = normalizeToneCurvePoints(entry?.toneCurvePoints);

  return normalized;
}

module.exports = {
  CLEANUP_PRESET_FIELDS,
  MAX_TONE_CURVE_POINTS,
  normalizeToneCurvePoints,
  normalizeCleanupPresetEntry,
};
