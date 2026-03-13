const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { uniquePaths, getHelperBinaryCandidates, getHelperRootCandidates } = require('./helper-paths');
const { registerPresetsIpc } = require('./presets-ipc');
const { registerExportsIpc } = require('./exports-ipc');

const {
  RawService,
  RAW_IMAGE_EXTENSIONS,
  RAW_FILE_FILTER_EXTENSIONS,
  ALL_SUPPORTED_EXTENSIONS,
} = require('./raw-service');
const { detectBracketGroups } = require('./bracket-detector');
const { HdrService } = require('./hdr-service');

let mainWindow = null;
let splashBounceId = -1;

// Keep app single-instance in production. This prevents accidental extra
// windows if anything launches the app executable unexpectedly.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

const APP_CACHE_ROOT = path.join(os.tmpdir(), 'ace-photo-studio-cache');
const QUEUE_MAX_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.ACE_HDR_MAX_CONCURRENCY) || 2)
);

fs.mkdirSync(APP_CACHE_ROOT, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function logToConsole(scope, message) {
  console.log(`[${scope}] ${message}`);
}

const rawService = new RawService({
  cacheRoot: APP_CACHE_ROOT,
  logger: (message) => logToConsole('RAW', message),
});

const hdrService = new HdrService({
  rawService,
  cacheRoot: APP_CACHE_ROOT,
  logger: (message) => logToConsole('HDR', message),
});

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', settleReject);

    child.on('close', (code) => {
      if (settled) return;

      if (code === 0) {
        settleResolve({ code, stdout, stderr });
        return;
      }

      const error = new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      settleReject(error);
    });
  });
}

function summarizeErrorOutput(error) {
  const text = String(error?.stderr || error?.stdout || error?.message || '').trim();
  if (!text) return '';
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function isLaunchFailure(error) {
  if (!error) return false;
  if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ENOTDIR') return true;
  if (typeof error.code === 'number' && (error.code === 126 || error.code === 127)) return true;

  const output = `${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`;
  return /library not loaded|image not found|bad cpu type|cannot execute|permission denied|not found/i.test(output);
}

async function runFirstAvailableCommand(candidates, args, toolName) {
  let launchError = null;
  let commandError = null;
  const launchFailures = [];

  for (const command of candidates) {
    try {
      const result = await runProcess(command, args);
      return { ...result, command };
    } catch (error) {
      if (isLaunchFailure(error)) {
        launchError = error;
        launchFailures.push(`${command}: ${summarizeErrorOutput(error) || 'launch failed'}`);
        continue;
      }

      commandError = error;
      break;
    }
  }

  if (commandError) throw commandError;

  if (launchError) {
    const details = launchFailures.slice(0, 4).join(' | ');
    const notFound = new Error(
      `${toolName} was not found or could not be launched. Tried: ${candidates.join(', ')}` +
      (details ? ` | Launch issues: ${details}` : '')
    );
    notFound.code = 'ENOENT';
    throw notFound;
  }

  throw new Error(`${toolName} could not be launched.`);
}

function getExiftoolCandidates() {
  return uniquePaths([
    ...getHelperBinaryCandidates('exiftool', {
      baseDir: __dirname,
      envVar: 'ACE_EXIFTOOL_PATH',
    }),
    '/opt/homebrew/bin/exiftool',
    '/usr/local/bin/exiftool',
    'exiftool',
  ]);
}

function parseExifDate(value) {
  if (!value || typeof value !== 'string') return null;

  const normalized = value
    .trim()
    .replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function parseNumericExposure(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return null;

  const parsed = Number(String(value).replace(/[^\d+\-.]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

// Optional metadata reader. If exiftool is unavailable, we keep processing using filename/time heuristics.
async function readExifMetadata(filePaths, queueLogger = null) {
  const log = typeof queueLogger === 'function' ? queueLogger : () => {};

  if (!filePaths.length) {
    return new Map();
  }

  try {
    const { stdout, command } = await runFirstAvailableCommand(
      getExiftoolCandidates(),
      [
        '-j',
        '-n',
        '-DateTimeOriginal',
        '-SubSecDateTimeOriginal',
        '-CreateDate',
        '-ExposureCompensation',
        '-ExposureBiasValue',
        ...filePaths,
      ],
      'exiftool'
    );

    const parsed = JSON.parse(stdout || '[]');
    const metadataByPath = new Map();

    for (const entry of parsed) {
      const sourcePath = path.resolve(entry.SourceFile || '');
      if (!sourcePath) continue;

      metadataByPath.set(sourcePath, {
        dateTimeOriginal: entry.DateTimeOriginal || null,
        subSecDateTimeOriginal: entry.SubSecDateTimeOriginal || null,
        createDate: entry.CreateDate || null,
        captureTimeMs: parseExifDate(
          entry.SubSecDateTimeOriginal
          || entry.DateTimeOriginal
          || entry.CreateDate
        ),
        exposureCompensation: parseNumericExposure(entry.ExposureCompensation),
        exposureBias: parseNumericExposure(entry.ExposureBiasValue),
      });
    }

    log(`Metadata read from ${command}: ${metadataByPath.size} file(s).`);
    return metadataByPath;
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('Exif metadata reader not found. Continuing with filename/timestamp grouping.');
      return new Map();
    }

    log(`Exif metadata read failed: ${error.message || error}`);
    return new Map();
  }
}

function walkDirectory(dirPath, supportedExtensions) {
  const results = [];

  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      results.push(...walkDirectory(fullPath, supportedExtensions));
      continue;
    }

    const ext = path.extname(fullPath).toLowerCase();
    if (supportedExtensions.has(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}

function collectSupportedFiles(inputPaths, supportedExtensions = ALL_SUPPORTED_EXTENSIONS) {
  const out = [];
  const seen = new Set();

  for (const inputPath of inputPaths || []) {
    if (!inputPath) continue;

    const resolvedPath = path.resolve(inputPath);

    let stat = null;
    try {
      stat = fs.statSync(resolvedPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      const files = walkDirectory(resolvedPath, supportedExtensions);
      for (const filePath of files) {
        const normalized = path.resolve(filePath);
        if (seen.has(normalized)) continue;

        seen.add(normalized);
        out.push(normalized);
      }

      continue;
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    if (!supportedExtensions.has(ext)) continue;

    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    out.push(resolvedPath);
  }

  return out;
}

function getLogsDir() {
  const baseDir = app.isReady()
    ? app.getPath('userData')
    : APP_CACHE_ROOT;

  return ensureDir(path.join(baseDir, 'logs'));
}

function makeQueueLogPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(getLogsDir(), `hdr-merge-${stamp}.log`);
}

function createQueueLogger(logPath) {
  return (message) => {
    const line = `[${nowIso()}] ${message}`;

    console.log(`[HDR-QUEUE] ${message}`);

    try {
      ensureDir(path.dirname(logPath));
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {}
  };
}

function ensureNonEmptyFile(filePath, label = 'File') {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`${label} is empty or invalid: ${filePath}`);
  }
}

function formatQueueError(error, logPath = null) {
  const message = (error?.message || String(error) || 'Unknown HDR merge error').trim();
  const code = error?.code ? ` [${error.code}]` : '';
  const logHint = logPath ? ` (See log: ${logPath})` : '';
  return `${message}${code}${logHint}`;
}

function writeQueueDiagnosticsSnapshot(queueState) {
  try {
    const logsDir = getLogsDir();
    const queueId = queueState?.queueId || `queue-${Date.now()}`;
    const diagnosticsPath = path.join(logsDir, `hdr-queue-summary-${queueId}.json`);

    const snapshot = {
      generatedAt: nowIso(),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      queue: {
        queueId: queueState.queueId,
        status: queueState.status,
        cancelRequested: queueState.cancelRequested,
        startedAt: queueState.startedAt,
        finishedAt: queueState.finishedAt,
        sourceFolder: queueState.sourceFolder,
        outputDir: queueState.outputDir,
        logPath: queueState.logPath,
        mergeMode: queueState.mergeMode,
        bracketMode: queueState.bracketMode,
        concurrency: queueState.concurrency,
        totalSourceFiles: queueState.totalSourceFiles,
        totalBracketSets: queueState.totalBracketSets,
        processedCount: queueState.processedCount,
        completedCount: queueState.completedCount,
        skippedCount: queueState.skippedCount,
        failedCount: queueState.failedCount,
        canceledCount: queueState.canceledCount,
        latestMergedPath: queueState.latestMergedPath || null,
        latestMergedAt: queueState.latestMergedAt || null,
      },
      errors: (queueState.errors || []).slice(-50),
    };

    fs.writeFileSync(diagnosticsPath, JSON.stringify(snapshot, null, 2), 'utf8');
    return diagnosticsPath;
  } catch {
    return null;
  }
}

function readLogTail(logPath, lineCount = 80) {
  if (!logPath || !fs.existsSync(logPath)) return '';

  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, lineCount)).join('\n');
  } catch {
    return '';
  }
}

function listCandidateStatus(candidates = []) {
  return uniquePaths(candidates).map((candidate) => {
    const isPathLike = candidate.includes('/') || candidate.includes('\\') || path.isAbsolute(candidate);
    if (!isPathLike) {
      return {
        candidate,
        exists: null,
        type: 'command',
      };
    }

    return {
      candidate,
      exists: fs.existsSync(candidate),
      type: 'path',
    };
  });
}

function findNearestExistingPath(targetPath) {
  let current = path.resolve(targetPath);

  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }

  return fs.existsSync(current) ? current : null;
}

function isImageTiff(filePath) {
  return /\.(tif|tiff)$/i.test(filePath);
}

function makeBaseName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

function sanitizeName(name, fallback = 'image') {
  const cleaned = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_');

  return cleaned || fallback;
}

function sanitizeSuffix(suffix) {
  if (!suffix) return '';
  const cleaned = String(suffix)
    .trim()
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_');

  if (!cleaned) return '';
  return cleaned.startsWith('_') ? cleaned : `_${cleaned}`;
}

function formatDateStamp(value) {
  if (!value && value !== 0) return 'unknownDate';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknownDate';

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function pickShootDateForGroup(group) {
  if (group?.shootDate) return sanitizeName(group.shootDate, 'unknownDate');
  if (Number.isFinite(group?.captureTimeMs)) return formatDateStamp(group.captureTimeMs);

  const firstSource = group?.sourcePaths?.[0];
  if (firstSource && fs.existsSync(firstSource)) {
    try {
      const stat = fs.statSync(firstSource);
      return formatDateStamp(stat.mtimeMs);
    } catch {}
  }

  return 'unknownDate';
}

function pickSourceFolderForGroup(group, fallbackFolderPath = null) {
  const rawFolder = group?.sourceFolder
    || (fallbackFolderPath ? path.basename(fallbackFolderPath) : null)
    || (group?.folderPath ? path.basename(group.folderPath) : null)
    || 'shoot';

  return sanitizeName(rawFolder, 'shoot');
}

function formatSetIndex(setIndex) {
  return String(Math.max(1, Number(setIndex) || 1)).padStart(4, '0');
}

function buildMergedTiffName(group, fallbackFolderPath = null) {
  const shootDate = pickShootDateForGroup(group);
  const sourceFolder = pickSourceFolderForGroup(group, fallbackFolderPath);
  const setIndex = formatSetIndex(group?.setIndex);
  return `${shootDate}_${sourceFolder}_SET${setIndex}_HDR16.tif`;
}

function buildMergedJpegName({ shootDate, sourceFolder, setIndex, quality }) {
  const safeShootDate = sanitizeName(shootDate, 'unknownDate');
  const safeSourceFolder = sanitizeName(sourceFolder, 'shoot');
  const safeSetIndex = formatSetIndex(setIndex);
  const safeQuality = String(Math.max(1, Math.min(100, Number(quality) || 92)));
  return `${safeShootDate}_${safeSourceFolder}_SET${safeSetIndex}_EDIT_q${safeQuality}.jpg`;
}

function createEmptyQueueState() {
  return {
    queueId: null,
    status: 'Waiting',
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    sourceFolder: null,
    outputDir: null,
    logPath: null,
    mergeMode: 'fusion',
    bracketMode: 'auto',
    concurrency: 1,
    totalSourceFiles: 0,
    totalBracketSets: 0,
    processedCount: 0,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    canceledCount: 0,
    sets: [],
    mergedResults: [],
    latestMergedPath: null,
    latestMergedAt: null,
    diagnosticsPath: null,
    errors: [],
    incompleteGroups: [],
    skippedFiles: [],
  };
}

const hdrQueue = {
  state: createEmptyQueueState(),
  activePromise: null,
};
let queueStartInFlight = false;
let queueStartCancelRequested = false;

function cloneQueueState() {
  const snapshot = JSON.parse(JSON.stringify(hdrQueue.state));
  snapshot.initializing = queueStartInFlight;
  snapshot.initCancelRequested = queueStartCancelRequested;
  return snapshot;
}

function broadcastQueueUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('hdr-queue-update', cloneQueueState());
}

function recomputeQueueCounters() {
  const statusCounters = {
    Completed: 0,
    Skipped: 0,
    Failed: 0,
    Canceled: 0,
  };

  for (const set of hdrQueue.state.sets) {
    if (set.status in statusCounters) {
      statusCounters[set.status] += 1;
    }
  }

  hdrQueue.state.completedCount = statusCounters.Completed;
  hdrQueue.state.skippedCount = statusCounters.Skipped;
  hdrQueue.state.failedCount = statusCounters.Failed;
  hdrQueue.state.canceledCount = statusCounters.Canceled;
  hdrQueue.state.processedCount = (
    statusCounters.Completed +
    statusCounters.Skipped +
    statusCounters.Failed +
    statusCounters.Canceled
  );
}

function currentQueueIsRunning() {
  return hdrQueue.state.status === 'Processing' || queueStartInFlight;
}

async function detectHdrGroups(rawFiles, { bracketMode = 'auto', queueLogger = null } = {}) {
  const log = typeof queueLogger === 'function' ? queueLogger : () => {};

  const result = await detectBracketGroups(rawFiles, {
    bracketMode,
    isRawFile: (filePath) => rawService.isRawFile(filePath),
    readMetadata: (paths) => readExifMetadata(paths, log),
    logger: log,
  });

  return result;
}

function getGroupValidationFailureReason(group) {
  if (!group || group.validForMerge !== false) {
    return null;
  }

  const reasons = Array.isArray(group.validation?.reasons)
    ? group.validation.reasons.filter(Boolean)
    : [];

  if (reasons.length) {
    return reasons.join(' ');
  }

  if (typeof group.reason === 'string' && group.reason.trim()) {
    const rawReason = group.reason.trim();
    return rawReason.replace(/^set validation failed:\s*/i, '');
  }

  return 'files appear to span multiple bracket groups.';
}

async function processQueueSet(setIndex, sourceGroup) {
  const queueState = hdrQueue.state;
  const set = queueState.sets[setIndex];

  if (!set) return;
  if (queueState.cancelRequested) return;

  set.status = 'Processing';
  set.startedAt = nowIso();
  set.error = null;
  recomputeQueueCounters();
  broadcastQueueUpdate();

  const queueLogger = createQueueLogger(queueState.logPath);
  const outputName = buildMergedTiffName(sourceGroup, queueState.sourceFolder);
  const outputPath = path.join(queueState.outputDir, outputName);

  try {
    queueLogger(`Set ${setIndex + 1}/${queueState.sets.length} start (${set.id}) output=${outputPath}`);

    const validationFailureReason = getGroupValidationFailureReason(sourceGroup);
    if (validationFailureReason) {
      const validationError = new Error(`Set validation failed: ${validationFailureReason}`);
      validationError.code = 'SET_VALIDATION_FAILED';
      throw validationError;
    }

    const mergeResult = await hdrService.mergeGroup(sourceGroup, {
      mode: queueState.mergeMode,
      outputPath,
      autoAlign: true,
      logPath: queueState.logPath,
      workerId: set.id,
      cacheKeySuffix: outputName,
    });
    ensureNonEmptyFile(mergeResult.mergedPath, 'Merged TIFF output');

    set.status = 'Completed';
    set.finishedAt = nowIso();
    set.outputPath = mergeResult.mergedPath;
    set.modeUsed = mergeResult.modeUsed;
    set.alignmentNote = mergeResult.alignmentNote;
    set.warnings = mergeResult.warnings || [];
    set.groupingMethod = sourceGroup.groupingMethod || null;
    set.partitionMethod = sourceGroup.partitionMethod || null;
    set.sequenceRange = sourceGroup.sequenceRange || null;
    set.captureTimeRange = sourceGroup.captureTimeRange || null;
    set.exposureSignature = sourceGroup.exposureSignature || null;
    set.validation = sourceGroup.validation || null;
    queueState.latestMergedPath = mergeResult.mergedPath;
    queueState.latestMergedAt = nowIso();

    queueState.mergedResults.push({
      id: set.id,
      mergedPath: mergeResult.mergedPath,
      outputName,
      sourcePaths: sourceGroup.sourcePaths,
      sourceCount: sourceGroup.sourceCount,
      modeRequested: queueState.mergeMode,
      modeUsed: mergeResult.modeUsed,
      alignmentApplied: mergeResult.alignmentApplied,
      alignmentNote: mergeResult.alignmentNote,
      warnings: mergeResult.warnings || [],
      createdAt: nowIso(),
      exportBaseName: sourceGroup.firstFileName
        ? makeBaseName(sourceGroup.firstFileName)
        : makeBaseName(mergeResult.mergedPath),
      shootDate: pickShootDateForGroup(sourceGroup),
      sourceFolder: pickSourceFolderForGroup(sourceGroup, queueState.sourceFolder),
      setIndex: Number(sourceGroup.setIndex) || (setIndex + 1),
      jpegExportName: buildMergedJpegName({
        shootDate: pickShootDateForGroup(sourceGroup),
        sourceFolder: pickSourceFolderForGroup(sourceGroup, queueState.sourceFolder),
        setIndex: Number(sourceGroup.setIndex) || (setIndex + 1),
        quality: 92,
      }),
    });

    for (const warning of set.warnings) {
      queueLogger(`Set ${setIndex + 1}/${queueState.sets.length} warning: ${warning}`);
    }

    queueLogger(`Set ${setIndex + 1}/${queueState.sets.length} complete: ${mergeResult.mergedPath}`);
  } catch (error) {
    if (queueState.cancelRequested) {
      set.status = 'Canceled';
      set.error = 'Canceled by user.';
      set.finishedAt = nowIso();
    } else {
      set.status = 'Failed';
      set.error = formatQueueError(error, queueState.logPath);
      set.finishedAt = nowIso();

      queueState.errors.push({
        setId: set.id,
        setIndex: setIndex + 1,
        outputPath,
        code: error?.code || null,
        error: set.error,
        rawError: error?.message || String(error),
        at: nowIso(),
      });

      queueLogger(`Set ${setIndex + 1}/${queueState.sets.length} failed: ${set.error}`);
    }
  }

  recomputeQueueCounters();
  broadcastQueueUpdate();
}

async function runQueueWorkers(queueId, groups) {
  const queueState = hdrQueue.state;

  let cursor = 0;

  const workerCount = Math.max(1, Math.min(queueState.concurrency, QUEUE_MAX_CONCURRENCY));

  async function workerLoop() {
    while (true) {
      if (hdrQueue.state.queueId !== queueId) return;
      if (hdrQueue.state.cancelRequested) return;

      const nextIndex = cursor;
      cursor += 1;

      if (nextIndex >= groups.length) return;

      await processQueueSet(nextIndex, groups[nextIndex]);
    }
  }

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(workerLoop());
  }

  await Promise.all(workers);
}

async function finalizeQueue(queueId) {
  if (hdrQueue.state.queueId !== queueId) return;
  const queueLogger = createQueueLogger(hdrQueue.state.logPath);

  for (const set of hdrQueue.state.sets) {
    if (set.status === 'Waiting') {
      set.status = hdrQueue.state.cancelRequested ? 'Skipped' : 'Failed';
      set.error = hdrQueue.state.cancelRequested
        ? 'Skipped after cancel request.'
        : 'Queue ended before this set was processed.';
      set.finishedAt = nowIso();

      if (!hdrQueue.state.cancelRequested) {
        hdrQueue.state.errors.push({
          setId: set.id,
          error: set.error,
        });
      }
    }
  }

  recomputeQueueCounters();

  if (hdrQueue.state.status !== 'Failed') {
    hdrQueue.state.status = hdrQueue.state.cancelRequested ? 'Canceled' : 'Completed';
  }
  hdrQueue.state.finishedAt = nowIso();
  hdrQueue.state.diagnosticsPath = writeQueueDiagnosticsSnapshot(hdrQueue.state);

  if (hdrQueue.state.diagnosticsPath) {
    queueLogger(`Queue diagnostics saved: ${hdrQueue.state.diagnosticsPath}`);
  }

  broadcastQueueUpdate();
}

function normalizeQueueGroups(groups, sourceFolder) {
  return (groups || []).map((group, index) => {
    const setIndex = Number(group.setIndex) || (index + 1);
    const shootDate = pickShootDateForGroup(group);
    const normalizedSourceFolder = pickSourceFolderForGroup(group, sourceFolder);

    return {
      ...group,
      setIndex,
      shootDate,
      sourceFolder: normalizedSourceFolder,
    };
  });
}

async function startQueueFromGroups({
  groups,
  sourceFolder,
  totalSourceFiles = 0,
  bracketMode = 'auto',
  mergeMode = 'fusion',
  concurrency = 1,
  outputDir,
  logPath,
  incompleteGroups = [],
  skippedFiles = [],
  queueLabel = 'new',
}) {
  const queueId = crypto.randomUUID
    ? crypto.randomUUID()
    : `queue-${Date.now()}-${Math.round(Math.random() * 1000)}`;

  const safeOutputDir = path.resolve(outputDir || path.join(APP_CACHE_ROOT, 'hdr-merged-output'));
  ensureDir(safeOutputDir);

  const safeLogPath = logPath ? path.resolve(logPath) : makeQueueLogPath();
  const queueLogger = createQueueLogger(safeLogPath);
  const normalizedGroups = normalizeQueueGroups(groups, sourceFolder);

  hdrQueue.state = {
    queueId,
    status: 'Processing',
    cancelRequested: false,
    startedAt: nowIso(),
    finishedAt: null,
    sourceFolder: sourceFolder ? path.resolve(sourceFolder) : null,
    outputDir: safeOutputDir,
    logPath: safeLogPath,
    mergeMode,
    bracketMode,
    concurrency: Math.max(1, Math.min(Number(concurrency) || 1, QUEUE_MAX_CONCURRENCY)),
    totalSourceFiles,
    totalBracketSets: normalizedGroups.length,
    processedCount: 0,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    canceledCount: 0,
    sets: normalizedGroups.map((group, index) => ({
      id: group.id,
      queueIndex: index,
      setIndex: group.setIndex,
      shootDate: group.shootDate,
      sourceFolder: group.sourceFolder,
      firstFileName: group.firstFileName,
      sourceCount: group.sourceCount,
      sourcePaths: group.sourcePaths,
      groupingMethod: group.groupingMethod || null,
      partitionMethod: group.partitionMethod || null,
      sequenceRange: group.sequenceRange || null,
      captureTimeRange: group.captureTimeRange || null,
      exposureSignature: group.exposureSignature || null,
      validation: group.validation || null,
      validForMerge: group.validForMerge !== false,
      status: 'Waiting',
      startedAt: null,
      finishedAt: null,
      outputPath: null,
      error: null,
      warnings: [],
    })),
    mergedResults: [],
    latestMergedPath: null,
    latestMergedAt: null,
    diagnosticsPath: null,
    errors: [],
    incompleteGroups,
    skippedFiles,
  };

  queueLogger(
    `Queue ${queueId} (${queueLabel}) initialized. sourceFiles=${totalSourceFiles}, completeGroups=${normalizedGroups.length}, ` +
    `incompleteGroups=${incompleteGroups.length}, mode=${mergeMode}, bracket=${bracketMode}, concurrency=${hdrQueue.state.concurrency}`
  );

  broadcastQueueUpdate();

  if (!normalizedGroups.length) {
    hdrQueue.state.status = 'Completed';
    hdrQueue.state.finishedAt = nowIso();
    recomputeQueueCounters();
    hdrQueue.state.diagnosticsPath = writeQueueDiagnosticsSnapshot(hdrQueue.state);
    broadcastQueueUpdate();
    return cloneQueueState();
  }

  const queueRunPromise = runQueueWorkers(queueId, normalizedGroups)
    .catch((error) => {
      const formatted = formatQueueError(error, safeLogPath);
      queueLogger(`Queue ${queueId} error: ${formatted}`);
      hdrQueue.state.errors.push({
        setId: 'queue',
        code: error?.code || null,
        error: formatted,
        rawError: error?.message || String(error),
        at: nowIso(),
      });
      hdrQueue.state.status = 'Failed';
    })
    .finally(async () => {
      await finalizeQueue(queueId);
      if (hdrQueue.activePromise === queueRunPromise) {
        hdrQueue.activePromise = null;
      }
    });

  hdrQueue.activePromise = queueRunPromise;

  return cloneQueueState();
}

async function startBatchHdrMerge(payload = {}) {
  if (currentQueueIsRunning()) {
    throw new Error('An HDR merge queue is already running or initializing. Cancel it before starting another queue.');
  }

  queueStartInFlight = true;
  queueStartCancelRequested = false;

  try {
    const sourceFolder = payload.folderPath ? path.resolve(payload.folderPath) : null;
    const bracketMode = payload.bracketMode || 'auto';
    const mergeMode = payload.mergeMode || 'fusion';
    const concurrency = Math.max(
      1,
      Math.min(Number(payload.concurrency) || 1, QUEUE_MAX_CONCURRENCY)
    );

    const outputDir = path.resolve(payload.outputDir || path.join(APP_CACHE_ROOT, 'hdr-merged-output'));
    const logPath = payload.logPath ? path.resolve(payload.logPath) : makeQueueLogPath();
    const queueLogger = createQueueLogger(logPath);

    const sourceFiles = payload.sourceFiles?.length
      ? collectSupportedFiles(payload.sourceFiles, RAW_IMAGE_EXTENSIONS)
      : sourceFolder
        ? walkDirectory(sourceFolder, RAW_IMAGE_EXTENSIONS)
        : [];

    const containsDngSources = sourceFiles.some((filePath) => /\.dng$/i.test(filePath || ''));
    if (containsDngSources) {
      const pipeline = await rawService.checkPipeline();
      if (!pipeline?.dngPreferredAvailable) {
        throw new Error(
          'DJI DNG merge blocked: Adobe-compatible DNG helper is unavailable. ' +
          'Install/configure the preferred DNG helper and try again.'
        );
      }
    }

    const detection = await detectHdrGroups(sourceFiles, {
      bracketMode,
      queueLogger,
    });

    const groups = detection.completeGroups.map((group, index) => ({
      ...group,
      setIndex: index + 1,
    }));

    if (queueStartCancelRequested) {
      const cancelled = new Error('HDR queue startup was canceled.');
      cancelled.code = 'CANCELLED';
      throw cancelled;
    }

    return startQueueFromGroups({
      groups,
      sourceFolder,
      totalSourceFiles: sourceFiles.length,
      bracketMode,
      mergeMode,
      concurrency,
      outputDir,
      logPath,
      incompleteGroups: detection.incompleteGroups,
      skippedFiles: detection.skippedFiles,
      queueLabel: 'initial',
    });
  } finally {
    queueStartInFlight = false;
    queueStartCancelRequested = false;
  }
}

async function retryFailedSets(payload = {}) {
  if (currentQueueIsRunning()) {
    throw new Error('Cannot retry failed sets while a queue is processing or initializing.');
  }

  queueStartInFlight = true;
  queueStartCancelRequested = false;

  try {
    const failedSets = hdrQueue.state.sets.filter((set) => set.status === 'Failed');
    if (!failedSets.length) {
      throw new Error('There are no failed sets to retry.');
    }

    const retryGroups = failedSets.map((set) => ({
      id: set.id,
      sourcePaths: set.sourcePaths,
      sourceCount: set.sourceCount,
      firstFileName: set.firstFileName,
      folderPath: hdrQueue.state.sourceFolder || null,
      sourceFolder: set.sourceFolder || null,
      shootDate: set.shootDate || null,
      setIndex: set.setIndex,
      groupingMethod: set.groupingMethod || null,
      partitionMethod: set.partitionMethod || null,
      sequenceRange: set.sequenceRange || null,
      captureTimeRange: set.captureTimeRange || null,
      exposureSignature: set.exposureSignature || null,
      validation: set.validation || null,
      validForMerge: set.validForMerge !== false,
    }));

    const retryConcurrency = payload.concurrency !== undefined
      ? Math.max(1, Number(payload.concurrency) || 1)
      : 1;

    return startQueueFromGroups({
      groups: retryGroups,
      sourceFolder: hdrQueue.state.sourceFolder,
      totalSourceFiles: hdrQueue.state.totalSourceFiles,
      bracketMode: hdrQueue.state.bracketMode,
      mergeMode: hdrQueue.state.mergeMode,
      concurrency: retryConcurrency,
      outputDir: payload.outputDir || hdrQueue.state.outputDir,
      logPath: payload.logPath || makeQueueLogPath(),
      incompleteGroups: [],
      skippedFiles: [],
      queueLabel: 'retry-failed-only',
    });
  } finally {
    queueStartInFlight = false;
    queueStartCancelRequested = false;
  }
}

function cancelBatchHdrMerge(options = {}) {
  if (queueStartInFlight && hdrQueue.state.status !== 'Processing') {
    queueStartCancelRequested = true;
    createQueueLogger(hdrQueue.state.logPath)('Cancel requested during queue initialization.');
    return cloneQueueState();
  }

  if (!currentQueueIsRunning()) {
    return cloneQueueState();
  }

  const force = Boolean(options.force);

  // Safe cancel: allow active merge write to finish, skip any waiting sets after that.
  hdrQueue.state.cancelRequested = true;
  createQueueLogger(hdrQueue.state.logPath)(`Cancel requested.${force ? ' Force stop enabled.' : ''}`);

  if (force) {
    hdrService.cancelActiveMerges();
  }

  broadcastQueueUpdate();

  return cloneQueueState();
}

function createAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [{
        label: 'ACE Photo Studio',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          {
            label: 'Check for Updates',
            click: () => {
              if (!mainWindow) return;

              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Check for Updates',
                message: 'Auto-update is not wired in yet.',
                detail: 'This menu item is ready for your updater later.',
              });
            },
          },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }]
      : []),

    {
      label: 'File',
      submenu: [
        {
          label: 'Add Photos…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            if (!mainWindow) return;
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openFile', 'multiSelections'],
              filters: [
                {
                  name: 'Images and RAW',
                  extensions: [
                    'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff',
                    ...RAW_FILE_FILTER_EXTENSIONS,
                  ],
                },
              ],
            });

            if (!result.canceled && result.filePaths.length) {
              mainWindow.webContents.send('menu-add-photos', result.filePaths);
            }
          },
        },
        {
          label: 'Add Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            if (!mainWindow) return;
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
            });

            if (!result.canceled && result.filePaths[0]) {
              mainWindow.webContents.send('menu-add-folder', result.filePaths[0]);
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Add HDR Folder…',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            mainWindow?.webContents.send('menu-add-hdr-folder');
          },
        },
        {
          label: 'Start Batch HDR Merge',
          accelerator: 'CmdOrCtrl+Alt+M',
          click: () => {
            mainWindow?.webContents.send('menu-start-hdr-merge');
          },
        },
        {
          label: 'Cancel Batch HDR Merge',
          accelerator: 'CmdOrCtrl+Alt+C',
          click: () => {
            mainWindow?.webContents.send('menu-cancel-hdr-merge');
          },
        },
        {
          label: 'Retry Failed Sets',
          accelerator: 'CmdOrCtrl+Alt+R',
          click: () => {
            mainWindow?.webContents.send('menu-retry-failed-sets');
          },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },

    {
      label: 'View',
      submenu: [
        {
          label: 'Zoom In Preview',
          accelerator: 'CmdOrCtrl+=',
          click: () => mainWindow?.webContents.send('menu-preview-zoom-in'),
        },
        {
          label: 'Zoom Out Preview',
          accelerator: 'CmdOrCtrl+-',
          click: () => mainWindow?.webContents.send('menu-preview-zoom-out'),
        },
        {
          label: 'Fit Preview',
          accelerator: 'CmdOrCtrl+0',
          click: () => mainWindow?.webContents.send('menu-preview-fit'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Split / Slider View',
          accelerator: 'CmdOrCtrl+\\',
          click: () => mainWindow?.webContents.send('menu-toggle-preview-mode'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'togglefullscreen' },
      ],
    },

    {
      label: 'Export',
      submenu: [
        {
          label: 'Save Current Image…',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu-save-current'),
        },
        {
          label: 'Export All to Folder…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu-export-all'),
        },
        {
          label: 'Export Merged HDR to JPEG…',
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => mainWindow?.webContents.send('menu-export-merged-hdr'),
        },
        { type: 'separator' },
        {
          label: 'Auto Fix Current Photo',
          accelerator: 'CmdOrCtrl+E',
          click: () => mainWindow?.webContents.send('menu-auto-fix'),
        },
      ],
    },

    {
      label: 'Help',
      submenu: [
        {
          label: 'ACE Photo Studio Help',
          click: async () => {
            await shell.openExternal('https://www.youtube.com/@MisAdventureLab');
          },
        },
        {
          label: 'Report an Issue',
          click: async () => {
            await shell.openExternal('mailto:misadventurelabs@gmail.com?subject=ACE%20Photo%20Studio%20Support');
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    title: 'ACE Photo Studio',
    icon: path.join(__dirname, 'assets', 'ace_photo_studio.icns'),
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    if (process.platform === 'darwin' && splashBounceId !== -1 && app.dock) {
      app.dock.cancelBounce(splashBounceId);
      splashBounceId = -1;
    }

    mainWindow.webContents.send('app-ready');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function normalizeInputPaths(inputPaths, { metadataByPath = new Map() } = {}) {
  const files = collectSupportedFiles(inputPaths);
  const normalized = [];

  for (const filePath of files) {
    const resolvedPath = path.resolve(filePath);

    if (rawService.isRawFile(resolvedPath)) {
      try {
        const conversion = await rawService.convertRawToTiff(resolvedPath);
        const preview = await rawService.ensureRawPreviewImage(resolvedPath, conversion.outputPath);

        normalized.push({
          originalPath: resolvedPath,
          workingPath: preview.previewPath,
          isRaw: true,
          rawTiffPath: conversion.outputPath,
          metadata: metadataByPath.get(resolvedPath) || null,
        });
      } catch (error) {
        logToConsole('NORMALIZE', `RAW conversion failed for ${resolvedPath}: ${error.message || error}`);
      }

      continue;
    }

    let workingPath = resolvedPath;

    if (isImageTiff(resolvedPath)) {
      try {
        const preview = await rawService.ensurePreviewImage(resolvedPath);
        workingPath = preview.previewPath;
      } catch {
        // If TIFF preview fails, keep TIFF path as a best-effort fallback.
      }
    }

    const metadata = metadataByPath.get(resolvedPath) || null;

    normalized.push({
      originalPath: resolvedPath,
      workingPath,
      isRaw: false,
      isMergedHdr: Boolean(metadata?.isMergedHdr),
      hdrMetadata: metadata?.hdrMetadata || null,
      exportBaseName: metadata?.exportBaseName || makeBaseName(resolvedPath),
      metadata,
    });
  }

  return normalized;
}

ipcMain.handle('pick-files', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Images and RAW',
        extensions: [
          'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff',
          ...RAW_FILE_FILTER_EXTENSIONS,
        ],
      },
    ],
  });

  if (result.canceled) return null;
  return result.filePaths;
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });

  if (result.canceled) return null;
  return result.filePaths[0] || null;
});

ipcMain.handle('pick-output-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled) return null;
  return result.filePaths[0] || null;
});

ipcMain.handle('check-raw-pipeline', async () => {
  return rawService.checkPipeline();
});

ipcMain.handle('normalize-paths', async (_, inputPaths = []) => {
  return normalizeInputPaths(inputPaths);
});

registerPresetsIpc({
  ipcMain,
  app,
  ensureDir,
});

registerExportsIpc({
  ipcMain,
  dialog,
  getMainWindow: () => mainWindow,
  ensureDir,
  ensureNonEmptyFile,
  sanitizeName,
  sanitizeSuffix,
  makeBaseName,
  buildMergedJpegName,
});

ipcMain.handle('hdr-import-folder', async (event, payload = {}) => {
  try {
    let folderPath = payload.folderPath || null;

    if (!folderPath) {
      const senderWindow = BrowserWindow.fromWebContents(event.sender) || null;
      const result = senderWindow
        ? await dialog.showOpenDialog(senderWindow, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });

      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, cancelled: true };
      }

      folderPath = result.filePaths[0];
    }

    const resolvedFolderPath = path.resolve(folderPath);

    if (!fs.existsSync(resolvedFolderPath)) {
      return {
        ok: false,
        error: `HDR folder does not exist: ${resolvedFolderPath}`,
      };
    }

    const sourceFiles = walkDirectory(resolvedFolderPath, RAW_IMAGE_EXTENSIONS);
    const detection = await detectHdrGroups(sourceFiles, {
      bracketMode: payload.bracketMode || 'auto',
    });

    logToConsole(
      'HDR-IMPORT',
      `folder=${resolvedFolderPath} rawFiles=${sourceFiles.length} completeSets=${detection?.summary?.totalCompleteGroups || 0}`
    );

    return {
      ok: true,
      folderPath: resolvedFolderPath,
      sourceFiles,
      detection: detection || null,
    };
  } catch (error) {
    const message = error.message || String(error);
    logToConsole('HDR-IMPORT', `Failed: ${message}`);
    return {
      ok: false,
      error: message,
    };
  }
});

ipcMain.handle('detect-hdr-groups', async (_, payload = {}) => {
  const bracketMode = payload.bracketMode || 'auto';

  const sourceFiles = payload.folderPath
    ? walkDirectory(path.resolve(payload.folderPath), RAW_IMAGE_EXTENSIONS)
    : collectSupportedFiles(payload.filePaths || [], RAW_IMAGE_EXTENSIONS);

  const detection = await detectHdrGroups(sourceFiles, {
    bracketMode,
  });

  return {
    ok: true,
    sourceFiles,
    detection,
  };
});

ipcMain.handle('start-batch-hdr-merge', async (_, payload = {}) => {
  try {
    const queue = await startBatchHdrMerge(payload);
    return {
      ok: true,
      queue,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      queue: cloneQueueState(),
    };
  }
});

ipcMain.handle('retry-failed-sets', async (_, payload = {}) => {
  try {
    const queue = await retryFailedSets(payload);
    return {
      ok: true,
      queue,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      queue: cloneQueueState(),
    };
  }
});

ipcMain.handle('get-merge-queue-progress', async () => {
  return cloneQueueState();
});

ipcMain.handle('get-hdr-diagnostics', async () => {
  const queue = cloneQueueState();

  return {
    ok: true,
    generatedAt: nowIso(),
    app: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
    },
    paths: {
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      userData: app.getPath('userData'),
      cacheRoot: APP_CACHE_ROOT,
    },
    queue,
    queueLogTail: readLogTail(queue.logPath, 120),
    helpers: {
      helperRoots: listCandidateStatus(getHelperRootCandidates({ baseDir: __dirname })),
      exiftool: listCandidateStatus(getExiftoolCandidates()),
      dngHelper: listCandidateStatus(rawService.getAdobeDngHelperCandidates()),
      enfuse: listCandidateStatus(getHelperBinaryCandidates('enfuse', { baseDir: __dirname })),
      alignImageStack: listCandidateStatus(getHelperBinaryCandidates('align_image_stack', { baseDir: __dirname })),
      opencvHdrHelper: listCandidateStatus(getHelperBinaryCandidates('ace-opencv-hdr-helper', {
        baseDir: __dirname,
        envVar: 'ACE_OPENCV_HDR_HELPER',
      })),
    },
  };
});

ipcMain.handle('cancel-merge', async (_, payload = {}) => {
  return cancelBatchHdrMerge(payload);
});

ipcMain.handle('open-path-in-finder', async (_, payload = {}) => {
  try {
    const rawTargetPath = String(payload.targetPath || '').trim();
    if (!rawTargetPath) {
      return { ok: false, error: 'No target path was provided.' };
    }

    const targetPath = path.resolve(rawTargetPath);
    const resolvedTarget = fs.existsSync(targetPath)
      ? targetPath
      : findNearestExistingPath(targetPath);

    if (!resolvedTarget) {
      return { ok: false, error: `Path does not exist and no parent folder was found: ${targetPath}` };
    }

    const stat = fs.statSync(resolvedTarget);
    if (stat.isDirectory()) {
      const shellError = await shell.openPath(resolvedTarget);
      if (shellError) {
        return { ok: false, error: shellError };
      }

      return {
        ok: true,
        openedPath: resolvedTarget,
        fallbackUsed: resolvedTarget !== targetPath,
      };
    }

    shell.showItemInFolder(resolvedTarget);
    return {
      ok: true,
      openedPath: resolvedTarget,
      fallbackUsed: resolvedTarget !== targetPath,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
    };
  }
});

ipcMain.handle('open-merged-tiffs-in-library', async (_, payload = {}) => {
  const results = Array.isArray(payload.results) ? payload.results : [];

  const metadataByPath = new Map();
  const mergedPaths = [];

  for (const result of results) {
    const mergedPath = path.resolve(result.mergedPath || result.outputPath || '');
    if (!mergedPath || !fs.existsSync(mergedPath)) continue;
    try {
      ensureNonEmptyFile(mergedPath, 'Merged TIFF');
    } catch {
      continue;
    }

    mergedPaths.push(mergedPath);

    metadataByPath.set(mergedPath, {
      isMergedHdr: true,
      exportBaseName: result.exportBaseName || makeBaseName(result.sourcePaths?.[0] || mergedPath),
      hdrMetadata: {
        isMergedOutput: true,
        mergedPath,
        id: result.id || null,
        sourcePaths: result.sourcePaths || [],
        sourceCount: result.sourceCount || (result.sourcePaths ? result.sourcePaths.length : 0),
        shootDate: result.shootDate || null,
        sourceFolder: result.sourceFolder || null,
        setIndex: result.setIndex || null,
        modeRequested: result.modeRequested || 'fusion',
        modeUsed: result.modeUsed || result.modeRequested || 'fusion',
        alignmentApplied: Boolean(result.alignmentApplied),
        alignmentNote: result.alignmentNote || '',
        warnings: result.warnings || [],
      },
    });
  }

  const normalized = await normalizeInputPaths(mergedPaths, { metadataByPath });

  return {
    ok: true,
    items: normalized,
  };
});

app.whenReady().then(() => {
  createAppMenu();

  if (process.platform === 'darwin' && app.dock) {
    splashBounceId = app.dock.bounce('informational');
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (currentQueueIsRunning()) {
    cancelBatchHdrMerge({ force: true });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
