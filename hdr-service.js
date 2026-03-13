const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

class HdrService {
  constructor(options = {}) {
    if (!options.rawService) {
      throw new Error('HdrService requires a rawService instance.');
    }

    this.rawService = options.rawService;
    this.logger = typeof options.logger === 'function' ? options.logger : () => {};
    this.cacheRoot = ensureDir(options.cacheRoot || path.join(os.tmpdir(), 'ace-photo-studio-cache'));
    this.hdrCacheDir = ensureDir(path.join(this.cacheRoot, 'hdr-merge-cache'));
    this.workerScriptPath = options.workerScriptPath || path.join(__dirname, 'merge-worker.js');
    this.activeWorkers = new Map();
  }

  makeMergeHash(sourcePaths, mode) {
    const normalized = [...sourcePaths]
      .map((filePath) => path.resolve(filePath))
      .sort((a, b) => a.localeCompare(b));

    const key = `${mode}|${normalized.join('|')}`;
    return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
  }

  async convertGroupSourcesToTiffs(sourcePaths, jobLogger) {
    const tiffPaths = [];

    jobLogger(`SOURCE_FILES_JSON ${JSON.stringify(sourcePaths)}`);

    for (const sourcePath of sourcePaths) {
      if (this.rawService.isRawFile(sourcePath)) {
        let conversion = null;
        try {
          conversion = await this.rawService.convertRawToTiff(sourcePath, null, {
            context: 'hdr-merge-source',
          });
        } catch (error) {
          const lens = error?.lensCorrection || null;
          if (lens && lens.requested) {
            jobLogger(
              `RAW_LENS_CORRECTION_JSON ${JSON.stringify({
                sourcePath: path.resolve(sourcePath),
                requested: lens.requested,
                metadataDetected: lens.metadataDetected,
                metadataMarkers: lens.metadataMarkers || [],
                helperSupportsCorrection: lens.helperSupportsCorrection,
                mode: lens.mode || null,
                djiMavic3Detected: lens.djiMavic3Detected,
                djiProfileId: lens.djiProfileId || null,
                embeddedAttempted: lens.embeddedAttempted,
                manualFallbackAttempted: lens.manualFallbackAttempted,
                manualFallbackApplied: lens.manualFallbackApplied,
                manualFallbackReason: lens.manualFallbackReason || null,
                applied: lens.applied,
                skipped: lens.skipped,
                skipReason: lens.skipReason || null,
                failed: true,
                error: error.message || String(error),
              })}`
            );
          }
          throw error;
        }
        tiffPaths.push(conversion.outputPath);
        const lens = conversion.lensCorrection || null;
        const lensSummary = lens
          ? (
            lens.requested
              ? `, lens=${lens.applied ? `applied:${lens.mode || 'unknown'}` : `skipped:${lens.skipReason || 'unknown'}`}`
              : (lens.mode === 'disabled'
                ? `, lens=disabled:${lens.skipReason || 'unknown'}`
                : ', lens=not-requested')
          )
          : '';
        jobLogger(
          `RAW converted for merge: ${sourcePath} -> ${conversion.outputPath} (${conversion.backend}${conversion.cached ? ', cache' : ''}${lensSummary})`
        );
        if (lens) {
          jobLogger(
            `RAW_LENS_CORRECTION_JSON ${JSON.stringify({
              sourcePath: path.resolve(sourcePath),
              requested: lens.requested,
              metadataDetected: lens.metadataDetected,
              metadataMarkers: lens.metadataMarkers || [],
              helperSupportsCorrection: lens.helperSupportsCorrection,
              mode: lens.mode || null,
              djiMavic3Detected: lens.djiMavic3Detected,
              djiProfileId: lens.djiProfileId || null,
              embeddedAttempted: lens.embeddedAttempted,
              manualFallbackAttempted: lens.manualFallbackAttempted,
              manualFallbackApplied: lens.manualFallbackApplied,
              manualFallbackReason: lens.manualFallbackReason || null,
              applied: lens.applied,
              skipped: lens.skipped,
              skipReason: lens.skipReason || null,
            })}`
          );
        }
        continue;
      }

      tiffPaths.push(path.resolve(sourcePath));
    }

    jobLogger(`CONVERTED_TIFFS_JSON ${JSON.stringify(tiffPaths)}`);
    return tiffPaths;
  }

  runMergeWorker(payload, workerId) {
    return new Promise((resolve, reject) => {
      const childEnv = {
        ...process.env,
        // In packaged Electron apps, this forces a background Node-style worker
        // instead of launching another full app instance/window.
        ELECTRON_RUN_AS_NODE: '1',
      };

      const child = spawn(process.execPath, [this.workerScriptPath], {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this.activeWorkers.set(workerId, child);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        this.activeWorkers.delete(workerId);
        reject(error);
      });

      child.on('close', (code) => {
        this.activeWorkers.delete(workerId);

        if (code !== 0 && !stdout.trim()) {
          const error = new Error(stderr.trim() || `merge-worker exited with code ${code}`);
          error.code = code;
          error.stderr = stderr;
          reject(error);
          return;
        }

        try {
          const parsed = JSON.parse(stdout || '{}');
          if (!parsed.ok) {
            const detailSuffix = parsed.details ? ` ${parsed.details}` : '';
            const error = new Error((parsed.error || 'HDR merge worker failed.') + detailSuffix);
            error.code = parsed.code;
            error.details = parsed.details || null;
            reject(error);
            return;
          }

          resolve(parsed);
        } catch (error) {
          error.message = `Could not parse merge worker output: ${error.message}`;
          reject(error);
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  async mergeGroup(group, options = {}) {
    const {
      mode = 'fusion',
      outputPath,
      autoAlign = true,
      logPath = null,
      cacheKeySuffix = null,
      workerId = group.id,
    } = options;

    if (!group || !Array.isArray(group.sourcePaths) || group.sourcePaths.length < 2) {
      throw new Error('mergeGroup requires a group with at least two source paths.');
    }

    const sourcePaths = [...new Set(group.sourcePaths.map((filePath) => path.resolve(filePath)))];

    const hash = this.makeMergeHash(sourcePaths, `${mode}|${cacheKeySuffix || ''}`);
    const defaultOutputPath = path.join(this.hdrCacheDir, `hdr-${hash}.tiff`);
    const finalOutputPath = path.resolve(outputPath || defaultOutputPath);

    ensureDir(path.dirname(finalOutputPath));

    const jobLogger = (message) => {
      this.logger(`[${workerId}] ${message}`);
      if (logPath) {
        try {
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] [${workerId}] ${message}\n`);
        } catch {
          // Ignore log append failures.
        }
      }
    };

    // Only reuse cached outputs when using the internal hash-derived path.
    // User-provided output paths (queue SET0001-style naming) must be recomputed
    // so stale files from prior runs cannot be mistaken for current-set results.
    const canReuseExistingOutput = !outputPath;
    if (canReuseExistingOutput && fs.existsSync(finalOutputPath)) {
      jobLogger(`Using cached HDR output: ${finalOutputPath}`);
      return {
        mergedPath: finalOutputPath,
        cached: true,
        modeRequested: mode,
        modeUsed: mode,
        alignmentApplied: false,
        alignmentNote: 'Cached result used.',
        warnings: [],
      };
    }

    const inputTiffs = await this.convertGroupSourcesToTiffs(sourcePaths, jobLogger);

    jobLogger(`MERGE_INPUT_TIFFS_JSON ${JSON.stringify(inputTiffs)}`);

    const payload = {
      jobId: workerId,
      mode,
      inputTiffs,
      outputPath: finalOutputPath,
      autoAlign,
      workRoot: this.hdrCacheDir,
      logPath,
    };

    const workerResult = await this.runMergeWorker(payload, workerId);

    return {
      mergedPath: workerResult.mergedPath,
      cached: false,
      modeRequested: workerResult.modeRequested,
      modeUsed: workerResult.modeUsed,
      alignmentApplied: workerResult.alignmentApplied,
      alignmentNote: workerResult.alignmentNote,
      warnings: workerResult.warnings || [],
    };
  }

  cancelActiveMerges() {
    for (const [workerId, worker] of this.activeWorkers.entries()) {
      try {
        worker.kill('SIGTERM');
        this.logger(`Cancelled merge worker: ${workerId}`);
      } catch (error) {
        this.logger(`Failed to cancel merge worker ${workerId}: ${error.message || error}`);
      }
    }

    this.activeWorkers.clear();
  }
}

module.exports = {
  HdrService,
};
