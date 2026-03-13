const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  buildBracketRecord,
  bucketRecords,
  partitionChunkIntoBracketSets,
  validateBracketSetRecords,
} = require('./file-grouping');

const DEFAULT_TIME_GAP_MS = 8000;

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function makeGroupId(sourcePaths) {
  const hash = crypto
    .createHash('md5')
    .update(sourcePaths.join('|'))
    .digest('hex')
    .slice(0, 10);

  const first = path.basename(sourcePaths[0], path.extname(sourcePaths[0]));
  return `${first}-${hash}`;
}

function formatShootDateFromMs(timeMs) {
  if (!Number.isFinite(timeMs)) {
    return null;
  }

  const date = new Date(timeMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function inferGroupingMethod(groupRecords) {
  const metadataCount = groupRecords.filter((record) => record.metadataSource === 'metadata').length;
  if (metadataCount === groupRecords.length && metadataCount > 0) {
    return 'metadata->timestamp->filename';
  }
  if (metadataCount > 0) {
    return 'metadata(partial)->timestamp->filename';
  }
  return 'timestamp->filename';
}

function summarizeGroup(groupRecords, bucketKey, partitionMeta = null, validation = null) {
  const sourcePaths = groupRecords.map((record) => record.filePath);
  const sortedTimes = groupRecords
    .map((record) => record.captureTimeMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  const firstTime = sortedTimes.length ? sortedTimes[0] : null;
  const lastTime = sortedTimes.length ? sortedTimes[sortedTimes.length - 1] : null;
  const folderPath = groupRecords[0]?.dir || null;

  return {
    id: makeGroupId(sourcePaths),
    sourcePaths,
    sourceCount: sourcePaths.length,
    bracketSize: sourcePaths.length,
    folderPath,
    sourceFolder: folderPath ? path.basename(folderPath) : 'shoot',
    firstFileName: path.basename(sourcePaths[0] || ''),
    captureTimeMs: firstTime,
    shootDate: formatShootDateFromMs(firstTime),
    timeRangeMs: firstTime !== null && lastTime !== null ? Math.max(0, lastTime - firstTime) : 0,
    detectionHint: (bucketKey.includes('|day|') || bucketKey.includes('|stamp|')) ? 'timestamp' : 'filename',
    groupingMethod: inferGroupingMethod(groupRecords),
    partitionMethod: partitionMeta?.partitionMethod || 'unknown',
    sequenceRange: validation?.sequenceRange || partitionMeta?.sequenceRange || null,
    captureTimeRange: validation?.captureTimeRange || partitionMeta?.captureTimeRange || null,
    exposureSignature: validation?.exposureSignature || partitionMeta?.exposureSignature || 'unknown',
    metadataDrivenSort: groupRecords.every((record) => Number.isFinite(record.exposureEv)),
    exposureValues: groupRecords.map((record) => record.exposureEv),
    validation: validation
      ? {
        isValid: validation.isValid,
        reasons: validation.reasons,
        warnings: validation.warnings,
      }
      : {
        isValid: true,
        reasons: [],
        warnings: [],
      },
    validForMerge: validation ? validation.isValid : true,
  };
}

// Detect complete/incomplete bracket groups from RAW files.
async function detectBracketGroups(filePaths, options = {}) {
  const {
    bracketMode = 'auto',
    timeGapMs = DEFAULT_TIME_GAP_MS,
    isRawFile,
    readMetadata,
    logger,
  } = options;

  const log = typeof logger === 'function' ? logger : () => {};

  const uniquePaths = [...new Set((filePaths || [])
    .filter(Boolean)
    .map((entry) => path.resolve(entry)))];

  const filteredRawPaths = isRawFile
    ? uniquePaths.filter((filePath) => isRawFile(filePath))
    : uniquePaths;

  const existingRawPaths = filteredRawPaths.filter((filePath) => fs.existsSync(filePath));

  let metadataByPath = new Map();

  if (typeof readMetadata === 'function' && existingRawPaths.length) {
    try {
      const metadataResult = await readMetadata(existingRawPaths);
      if (metadataResult instanceof Map) {
        metadataByPath = metadataResult;
      } else if (metadataResult && typeof metadataResult === 'object') {
        metadataByPath = new Map(Object.entries(metadataResult));
      }
    } catch (error) {
      log(`Metadata reader failed: ${error.message || error}`);
    }
  }

  const records = [];
  const skippedFiles = [];

  for (const rawPath of existingRawPaths) {
    const stat = safeStat(rawPath);
    if (!stat || !stat.isFile()) {
      skippedFiles.push({
        filePath: rawPath,
        reason: 'not-a-regular-file',
      });
      continue;
    }

    const metadata = metadataByPath.get(rawPath) || null;
    const record = buildBracketRecord(rawPath, stat, metadata);
    records.push(record);
  }

  const chunks = bucketRecords(records, timeGapMs);
  const completeGroups = [];
  const incompleteGroups = [];

  const usedPaths = new Set();

  for (const chunk of chunks) {
    const {
      completeSets,
      incompleteSets,
      completeSetMeta,
      incompleteSetMeta,
      partitionMethod,
    } = partitionChunkIntoBracketSets(chunk.records, bracketMode);

    for (let index = 0; index < completeSets.length; index++) {
      const set = completeSets[index];
      const setMeta = completeSetMeta[index] || { partitionMethod };
      const validation = validateBracketSetRecords(set, { expectedSize: set.length });
      const group = summarizeGroup(set, chunk.bucketKey, setMeta, validation);
      group.status = 'complete';
      if (!validation.isValid) {
        group.reason = `Set validation failed: ${validation.reasons.join(' ')}`;
      }
      completeGroups.push(group);
      for (const filePath of group.sourcePaths) usedPaths.add(filePath);
    }

    for (let index = 0; index < incompleteSets.length; index++) {
      const set = incompleteSets[index];
      if (!set.length) continue;
      const setMeta = incompleteSetMeta[index] || { partitionMethod };
      const validation = validateBracketSetRecords(set, { expectedSize: set.length });
      const group = summarizeGroup(set, chunk.bucketKey, setMeta, validation);
      group.status = 'incomplete';
      group.reason = bracketMode === 'auto'
        ? `Incomplete auto-detected set with ${group.sourceCount} file(s).`
        : `Expected ${bracketMode} shots but found ${group.sourceCount}.`;

      incompleteGroups.push(group);
      for (const filePath of group.sourcePaths) usedPaths.add(filePath);
    }
  }

  for (const record of records) {
    if (!usedPaths.has(record.filePath)) {
      skippedFiles.push({
        filePath: record.filePath,
        reason: 'not-grouped',
      });
    }
  }

  completeGroups.sort((a, b) => a.firstFileName.localeCompare(b.firstFileName));
  incompleteGroups.sort((a, b) => a.firstFileName.localeCompare(b.firstFileName));

  return {
    completeGroups,
    incompleteGroups,
    skippedFiles,
    summary: {
      totalInputFiles: uniquePaths.length,
      totalRawFiles: records.length,
      totalCompleteGroups: completeGroups.length,
      totalInvalidGroups: completeGroups.filter((group) => group.validForMerge === false).length,
      totalIncompleteGroups: incompleteGroups.length,
      totalSkippedFiles: skippedFiles.length,
      bracketMode,
      timeGapMs,
      metadataRecords: records.filter((record) => record.metadataSource === 'metadata').length,
    },
  };
}

module.exports = {
  detectBracketGroups,
};
