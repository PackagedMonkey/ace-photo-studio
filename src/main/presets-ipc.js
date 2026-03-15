const fs = require('fs');
const path = require('path');
const { normalizeCleanupPresetEntry } = require('../shared/cleanup-preset-schema');

const LOCKED_BUILTIN_PRESET_NAMES = ['Studio Neutral', 'Interior Bright', 'Crisp Pop', 'Gentle Lift'];
const LEGACY_CONFLICTING_PRESET_NAMES = ['Natural', 'Real Estate', 'Punchy', 'Soft'];
const LOCKED_BUILTIN_PRESET_NAME_SET = new Set(
  LOCKED_BUILTIN_PRESET_NAMES.map((name) => name.toLowerCase())
);
const RESERVED_PRESET_NAME_SET = new Set([
  ...LOCKED_BUILTIN_PRESET_NAMES.map((name) => name.toLowerCase()),
  ...LEGACY_CONFLICTING_PRESET_NAMES.map((name) => name.toLowerCase()),
]);

function isLockedBuiltinPresetName(name) {
  return LOCKED_BUILTIN_PRESET_NAME_SET.has(String(name || '').trim().toLowerCase());
}

function isReservedCleanupPresetName(name) {
  return RESERVED_PRESET_NAME_SET.has(String(name || '').trim().toLowerCase());
}

function registerPresetsIpc({ ipcMain, app, ensureDir }) {
  function getCleanupPresetsPath() {
    return path.join(app.getPath('userData'), 'presets.json');
  }

  function readCleanupPresets() {
    const presetsPath = getCleanupPresetsPath();
    if (!fs.existsSync(presetsPath)) return [];

    let parsed = [];
    try {
      parsed = JSON.parse(fs.readFileSync(presetsPath, 'utf8'));
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeCleanupPresetEntry(entry))
      .filter((entry) => entry && !isReservedCleanupPresetName(entry.name))
      .filter(Boolean);
  }

  function writeCleanupPresets(presets) {
    const presetsPath = getCleanupPresetsPath();
    ensureDir(path.dirname(presetsPath));
    const safePresets = Array.isArray(presets)
      ? presets.map((entry) => normalizeCleanupPresetEntry(entry)).filter(Boolean)
      : [];
    fs.writeFileSync(presetsPath, JSON.stringify(safePresets, null, 2), 'utf8');
    return safePresets;
  }

  ipcMain.handle('load-cleanup-presets', async () => {
    try {
      const presets = readCleanupPresets();
      return {
        ok: true,
        presets,
        filePath: getCleanupPresetsPath(),
      };
    } catch (error) {
      return {
        ok: false,
        presets: [],
        error: error.message || String(error),
        filePath: getCleanupPresetsPath(),
      };
    }
  });

  ipcMain.handle('save-cleanup-preset', async (_, payload = {}) => {
    try {
      const normalized = normalizeCleanupPresetEntry(payload.preset);
      if (!normalized) {
        throw new Error('Preset name is required.');
      }
      if (isReservedCleanupPresetName(normalized.name)) {
        throw new Error('That preset name is reserved for a built-in preset. Please choose a different name.');
      }

      const presets = readCleanupPresets();
      const nameKey = normalized.name.toLowerCase();
      const existingIndex = presets.findIndex((entry) => entry.name.toLowerCase() === nameKey);

      if (existingIndex >= 0) {
        presets[existingIndex] = normalized;
      } else {
        presets.push(normalized);
      }

      const saved = writeCleanupPresets(presets);
      return {
        ok: true,
        presets: saved,
        filePath: getCleanupPresetsPath(),
      };
    } catch (error) {
      return {
        ok: false,
        presets: [],
        error: error.message || String(error),
        filePath: getCleanupPresetsPath(),
      };
    }
  });

  ipcMain.handle('delete-cleanup-preset', async (_, payload = {}) => {
    try {
      const name = String(payload.name || '').trim();
      if (!name) {
        throw new Error('Preset name is required.');
      }
      if (isLockedBuiltinPresetName(name)) {
        throw new Error('Built-in presets cannot be deleted.');
      }

      const presets = readCleanupPresets();
      const nameKey = name.toLowerCase();
      const nextPresets = presets.filter((entry) => entry.name.toLowerCase() !== nameKey);
      const saved = writeCleanupPresets(nextPresets);

      return {
        ok: true,
        presets: saved,
        filePath: getCleanupPresetsPath(),
      };
    } catch (error) {
      return {
        ok: false,
        presets: [],
        error: error.message || String(error),
        filePath: getCleanupPresetsPath(),
      };
    }
  });
}

module.exports = {
  registerPresetsIpc,
};
