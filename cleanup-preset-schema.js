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

  return normalized;
}

module.exports = {
  CLEANUP_PRESET_FIELDS,
  normalizeCleanupPresetEntry,
};
