#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { detectBracketGroups } = require('../src/shared/bracket-detector');
const { RawService } = require('../src/main/raw-service');
const { HdrService } = require('../src/main/hdr-service');

const RAW_EXTENSIONS = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.pef', '.srw']);

const SAMPLE_FOLDERS = [
  path.resolve(__dirname, 'hdr-samples', 'hdr-set-1'),
  path.resolve(__dirname, 'hdr-samples', 'hdr-set-2'),
];

function sanitizeName(name, fallback = 'image') {
  const cleaned = String(name || '')
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '_');

  return cleaned || fallback;
}

function formatDateStamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknownDate';

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function formatSetIndex(setIndex) {
  return String(Math.max(1, Number(setIndex) || 1)).padStart(4, '0');
}

function pickShootDateForGroup(group) {
  if (group?.shootDate) return sanitizeName(group.shootDate, 'unknownDate');
  if (Number.isFinite(group?.captureTimeMs)) return formatDateStamp(group.captureTimeMs);
  return 'unknownDate';
}

function pickSourceFolderForGroup(group, folderPath) {
  return sanitizeName(group?.sourceFolder || path.basename(folderPath) || 'shoot', 'shoot');
}

function buildMergedTiffName(group, folderPath) {
  const shootDate = pickShootDateForGroup(group);
  const sourceFolder = pickSourceFolderForGroup(group, folderPath);
  const setIndex = formatSetIndex(group?.setIndex || 1);
  return `${shootDate}_${sourceFolder}_SET${setIndex}_HDR16.tif`;
}

function buildMergedJpegName(group, folderPath, quality) {
  const shootDate = pickShootDateForGroup(group);
  const sourceFolder = pickSourceFolderForGroup(group, folderPath);
  const setIndex = formatSetIndex(group?.setIndex || 1);
  const safeQuality = String(Math.max(1, Math.min(100, Number(quality) || 92)));
  return `${shootDate}_${sourceFolder}_SET${setIndex}_EDIT_q${safeQuality}.jpg`;
}

function listRawFiles(folderPath) {
  return fs.readdirSync(folderPath)
    .map((name) => path.join(folderPath, name))
    .filter((filePath) => fs.statSync(filePath).isFile())
    .filter((filePath) => RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

function probeCommand(candidates, args = ['--version']) {
  for (const candidate of candidates) {
    if (!candidate) continue;

    const command = String(candidate);

    if (command.includes(path.sep)) {
      if (!fs.existsSync(command)) continue;
    }

    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (!result.error) {
      return {
        available: true,
        command,
      };
    }

    if (result.error && result.error.code !== 'ENOENT') {
      return {
        available: true,
        command,
      };
    }
  }

  return { available: false, command: null };
}

function getEnfuseStatus() {
  return probeCommand([
    '/Applications/Hugin/Hugin.app/Contents/MacOS/enfuse',
    '/Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/enfuse',
    '/Applications/Hugin/HuginStitchProject.app/Contents/MacOS/enfuse',
    '/opt/homebrew/bin/enfuse',
    '/usr/local/bin/enfuse',
    'enfuse',
  ]);
}

function getAlignStatus() {
  return probeCommand([
    '/Applications/Hugin/Hugin.app/Contents/MacOS/align_image_stack',
    '/Applications/Hugin/PTBatcherGUI.app/Contents/MacOS/align_image_stack',
    '/Applications/Hugin/HuginStitchProject.app/Contents/MacOS/align_image_stack',
    '/opt/homebrew/bin/align_image_stack',
    '/usr/local/bin/align_image_stack',
    'align_image_stack',
  ]);
}

async function runFolderValidation(folderPath, pipelineStatus, binaryStatus) {
  const sourceFiles = listRawFiles(folderPath);

  const detectorRawService = new RawService({ logger: () => {} });

  const autoDetection = await detectBracketGroups(sourceFiles, {
    bracketMode: 'auto',
    isRawFile: (filePath) => detectorRawService.isRawFile(filePath),
  });

  const forcedFiveDetection = await detectBracketGroups(sourceFiles, {
    bracketMode: '5',
    isRawFile: (filePath) => detectorRawService.isRawFile(filePath),
  });

  const autoGroup = autoDetection.completeGroups[0] || null;
  const forcedFiveGroup = forcedFiveDetection.completeGroups[0] || null;

  const mergedName = autoGroup
    ? buildMergedTiffName({ ...autoGroup, setIndex: 1 }, folderPath)
    : null;
  const jpegNameQ92 = autoGroup
    ? buildMergedJpegName({ ...autoGroup, setIndex: 1 }, folderPath, 92)
    : null;

  const expectedFiveShotComplete = (
    autoDetection.completeGroups.length === 1 &&
    autoDetection.incompleteGroups.length === 0 &&
    autoDetection.completeGroups[0].sourceCount === 5
  );

  const queueValidation = {
    started: false,
    statuses: ['Waiting'],
    finalStatus: 'Waiting',
    setStatus: 'Waiting',
    error: null,
  };

  const conversionValidation = {
    attempted: false,
    ok: false,
    convertedCount: 0,
    convertedTiffPaths: [],
    error: null,
  };

  const mergeValidation = {
    attempted: false,
    ok: false,
    skippedReason: null,
    outputPath: null,
    outputExists: false,
    outputNameMatchesSpec: false,
    noPartialTempOutput: false,
    tempOutputFiles: [],
    previewLoadable: false,
    error: null,
  };

  const libraryValidation = {
    attempted: false,
    ok: false,
    previewPath: null,
    error: null,
  };

  const exportValidation = {
    attempted: false,
    ok: false,
    outputPath: null,
    outputExists: false,
    outputNameMatchesSpec: false,
    error: null,
  };

  const missingForFusion = [];
  if (!pipelineStatus.dngPreferredAvailable) missingForFusion.push('ace-dng-sdk-helper');
  if (!binaryStatus.enfuse.available) missingForFusion.push('enfuse');

  if (expectedFiveShotComplete && missingForFusion.length === 0) {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-hdr-workflow-'));
    const outputDir = path.join(cacheRoot, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    const rawService = new RawService({
      cacheRoot,
      logger: () => {},
    });

    const hdrService = new HdrService({
      cacheRoot,
      rawService,
      logger: () => {},
    });

    const groupForRun = {
      ...autoGroup,
      setIndex: 1,
      sourceFolder: path.basename(folderPath),
    };

    const outputPath = path.join(outputDir, mergedName);
    const expectedJpegPath = path.join(outputDir, jpegNameQ92);
    mergeValidation.attempted = true;
    mergeValidation.outputPath = outputPath;

    queueValidation.started = true;
    queueValidation.statuses.push('Processing');
    queueValidation.setStatus = 'Processing';

    try {
      conversionValidation.attempted = true;
      for (const sourcePath of groupForRun.sourcePaths) {
        const conversion = await rawService.convertRawToTiff(sourcePath);
        conversionValidation.convertedTiffPaths.push(conversion.outputPath);
      }
      conversionValidation.convertedCount = conversionValidation.convertedTiffPaths.length;
      conversionValidation.ok = conversionValidation.convertedCount === groupForRun.sourcePaths.length;

      await hdrService.mergeGroup(groupForRun, {
        mode: 'fusion',
        outputPath,
        autoAlign: true,
        workerId: `validate-${path.basename(folderPath)}`,
        logPath: path.join(outputDir, 'merge.log'),
        cacheKeySuffix: mergedName,
      });

      mergeValidation.ok = true;
      mergeValidation.outputExists = fs.existsSync(outputPath);
      mergeValidation.outputNameMatchesSpec = path.basename(outputPath) === mergedName;
      mergeValidation.tempOutputFiles = fs.readdirSync(outputDir)
        .filter((name) => name.startsWith(`${mergedName}.tmp-`))
        .sort((a, b) => a.localeCompare(b));
      mergeValidation.noPartialTempOutput = mergeValidation.tempOutputFiles.length === 0;

      if (mergeValidation.outputExists) {
        try {
          libraryValidation.attempted = true;
          const preview = await rawService.ensurePreviewImage(outputPath);
          mergeValidation.previewLoadable = Boolean(preview?.previewPath && fs.existsSync(preview.previewPath));
          libraryValidation.ok = mergeValidation.previewLoadable;
          libraryValidation.previewPath = preview?.previewPath || null;
        } catch (error) {
          mergeValidation.previewLoadable = false;
          mergeValidation.error = `Merged TIFF preview failed: ${error.message || error}`;
          libraryValidation.ok = false;
          libraryValidation.error = mergeValidation.error;
        }
      }

      if (mergeValidation.outputExists) {
        try {
          exportValidation.attempted = true;
          exportValidation.outputPath = expectedJpegPath;
          await rawService.ensurePreviewImage(outputPath, expectedJpegPath);
          exportValidation.outputExists = fs.existsSync(expectedJpegPath);
          exportValidation.outputNameMatchesSpec = path.basename(expectedJpegPath) === jpegNameQ92;
          exportValidation.ok = exportValidation.outputExists && exportValidation.outputNameMatchesSpec;
        } catch (error) {
          exportValidation.ok = false;
          exportValidation.error = error.message || String(error);
        }
      }

      queueValidation.setStatus = 'Completed';
      queueValidation.finalStatus = 'Completed';
      queueValidation.statuses.push('Completed');
    } catch (error) {
      queueValidation.setStatus = 'Failed';
      queueValidation.finalStatus = 'Failed';
      queueValidation.statuses.push('Failed');
      queueValidation.error = error.message || String(error);
      conversionValidation.ok = false;
      conversionValidation.error = conversionValidation.error || queueValidation.error;
      mergeValidation.ok = false;
      mergeValidation.error = error.message || String(error);
      mergeValidation.outputExists = fs.existsSync(outputPath);
      mergeValidation.tempOutputFiles = fs.readdirSync(outputDir)
        .filter((name) => name.startsWith(`${mergedName}.tmp-`))
        .sort((a, b) => a.localeCompare(b));
      mergeValidation.noPartialTempOutput = mergeValidation.tempOutputFiles.length === 0;
    }

    fs.rmSync(cacheRoot, { recursive: true, force: true });
  } else {
    mergeValidation.skippedReason = missingForFusion.length
      ? `Missing required binaries: ${missingForFusion.join(', ')}`
      : 'Bracket detection did not produce exactly one complete 5-shot group.';
    queueValidation.finalStatus = 'Skipped';
    queueValidation.setStatus = 'Skipped';
    queueValidation.statuses.push('Skipped');
  }

  return {
    folderName: path.basename(folderPath),
    folderPath,
    sourceFiles,
    importCheck: {
      ok: sourceFiles.length === 5,
      fileCount: sourceFiles.length,
    },
    detectionAuto: {
      completeGroups: autoDetection.completeGroups.length,
      incompleteGroups: autoDetection.incompleteGroups.length,
      skippedFiles: autoDetection.skippedFiles.length,
      groupSizes: autoDetection.completeGroups.map((group) => group.sourceCount),
    },
    detectionFiveShot: {
      completeGroups: forcedFiveDetection.completeGroups.length,
      incompleteGroups: forcedFiveDetection.incompleteGroups.length,
      skippedFiles: forcedFiveDetection.skippedFiles.length,
      groupSizes: forcedFiveDetection.completeGroups.map((group) => group.sourceCount),
    },
    completeFiveShotExpected: expectedFiveShotComplete,
    naming: {
      mergedTiff: mergedName,
      exportedJpegQ92: jpegNameQ92,
      mergedPatternMatch: mergedName
        ? /^\d{8}_.+_SET\d{4}_HDR16\.tif$/i.test(mergedName)
        : false,
      jpegPatternMatch: jpegNameQ92
        ? /^\d{8}_.+_SET\d{4}_EDIT_q\d{1,3}\.jpg$/i.test(jpegNameQ92)
        : false,
    },
    queueValidation,
    conversionValidation,
    mergeValidation,
    libraryValidation,
    exportValidation,
  };
}

async function main() {
  const pipelineService = new RawService({ logger: () => {} });
  const pipelineStatus = await pipelineService.checkPipeline();

  const binaryStatus = {
    enfuse: getEnfuseStatus(),
    alignImageStack: getAlignStatus(),
  };

  const folderResults = [];
  for (const folderPath of SAMPLE_FOLDERS) {
    folderResults.push(await runFolderValidation(folderPath, pipelineStatus, binaryStatus));
  }

  const result = {
    timestamp: new Date().toISOString(),
    pipelineStatus: {
      ok: pipelineStatus.ok,
      decoder: pipelineStatus.decoder,
      dngPreferredAvailable: pipelineStatus.dngPreferredAvailable,
      dngPreferredDecoder: pipelineStatus.dngPreferredDecoder,
      warning: pipelineStatus.warning,
    },
    binaryStatus,
    folders: folderResults,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exit(1);
});
