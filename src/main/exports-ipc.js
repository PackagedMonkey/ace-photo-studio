const fs = require('fs');
const path = require('path');

function registerExportsIpc({
  ipcMain,
  dialog,
  getMainWindow,
  ensureDir,
  ensureNonEmptyFile,
  sanitizeName,
  sanitizeSuffix,
  makeBaseName,
  buildMergedJpegName,
}) {
  ipcMain.handle('pick-save-file', async (_, payload = {}) => {
    const result = await dialog.showSaveDialog({
      defaultPath: payload.defaultName || 'image-cleaned.jpg',
      filters: [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }],
    });

    if (result.canceled) return null;
    return result.filePath || null;
  });

  ipcMain.handle('save-data-url', async (_, payload = {}) => {
    const { outPath, dataUrl } = payload;

    if (!outPath || !dataUrl) {
      throw new Error('save-data-url requires outPath and dataUrl.');
    }

    const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
    const resolvedOutPath = path.resolve(outPath);
    ensureDir(path.dirname(resolvedOutPath));
    const tempOutPath = `${resolvedOutPath}.tmp-${process.pid}-${Date.now()}`;

    try {
      fs.rmSync(tempOutPath, { force: true });
    } catch {}

    try {
      fs.writeFileSync(tempOutPath, Buffer.from(base64, 'base64'));
      ensureNonEmptyFile(tempOutPath, 'Saved image');
      fs.renameSync(tempOutPath, resolvedOutPath);
    } finally {
      try {
        fs.rmSync(tempOutPath, { force: true });
      } catch {}
    }

    return true;
  });

  ipcMain.handle('export-edited-jpegs', async (_, payload = {}) => {
    const items = Array.isArray(payload.items) ? payload.items : [];

    if (!items.length) {
      return {
        ok: false,
        error: 'No edited images were provided for export.',
      };
    }

    let outputDir = payload.outputDir || null;

    if (!outputDir) {
      const pickResult = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openDirectory', 'createDirectory'],
      });

      if (pickResult.canceled || !pickResult.filePaths[0]) {
        return { ok: false, cancelled: true };
      }

      outputDir = pickResult.filePaths[0];
    }

    const resolvedOutputDir = path.resolve(outputDir);
    ensureDir(resolvedOutputDir);

    const suffix = sanitizeSuffix(payload.suffix || '_edit');
    const requestedQuality = Math.max(1, Math.min(100, Number(payload.quality) || 92));
    const useHdrStrictNaming = Boolean(payload.useHdrStrictNaming);

    const exported = [];
    const failed = [];
    const reservedNames = new Set();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      try {
        if (!item || !item.dataUrl) {
          throw new Error('Missing dataUrl for export item.');
        }

        const hdrNaming = item.hdrNaming || null;
        const baseName = sanitizeName(
          item.baseName
            || item.exportBaseName
            || (item.originalPath ? makeBaseName(item.originalPath) : null)
            || `image_${String(i + 1).padStart(4, '0')}`
        );

        let fileName = `${baseName}${suffix}.jpg`;

        if (useHdrStrictNaming && hdrNaming) {
          fileName = buildMergedJpegName({
            shootDate: hdrNaming.shootDate,
            sourceFolder: hdrNaming.sourceFolder,
            setIndex: hdrNaming.setIndex,
            quality: requestedQuality,
          });
        }

        let dedupeIndex = 1;

        while (reservedNames.has(fileName) || fs.existsSync(path.join(resolvedOutputDir, fileName))) {
          if (useHdrStrictNaming && hdrNaming) {
            const strictName = buildMergedJpegName({
              shootDate: hdrNaming.shootDate,
              sourceFolder: hdrNaming.sourceFolder,
              setIndex: hdrNaming.setIndex,
              quality: requestedQuality,
            });
            const noExt = strictName.replace(/\.jpg$/i, '');
            fileName = `${noExt}_${dedupeIndex}.jpg`;
          } else {
            fileName = `${baseName}${suffix}-${dedupeIndex + 1}.jpg`;
          }
          dedupeIndex += 1;
        }

        reservedNames.add(fileName);

        const outPath = path.join(resolvedOutputDir, fileName);
        const base64 = String(item.dataUrl).replace(/^data:image\/\w+;base64,/, '');
        const tempOutPath = path.join(
          resolvedOutputDir,
          `.tmp-export-${process.pid}-${Date.now()}-${Math.round(Math.random() * 10000)}-${fileName}`
        );

        try {
          fs.rmSync(tempOutPath, { force: true });
        } catch {}

        try {
          fs.writeFileSync(tempOutPath, Buffer.from(base64, 'base64'));
          ensureNonEmptyFile(tempOutPath, 'Exported JPEG');
          fs.renameSync(tempOutPath, outPath);
        } finally {
          try {
            fs.rmSync(tempOutPath, { force: true });
          } catch {}
        }

        exported.push({
          source: item.originalPath || `item-${i + 1}`,
          outPath,
        });
      } catch (error) {
        failed.push({
          source: item?.originalPath || `item-${i + 1}`,
          error: error.message || String(error),
        });
      }
    }

    return {
      ok: true,
      outputDir: resolvedOutputDir,
      exported,
      failed,
    };
  });
}

module.exports = {
  registerExportsIpc,
};
