const path = require('path');

function parseExposureToken(token) {
  if (!token) return null;

  if (typeof token === 'number' && Number.isFinite(token)) {
    return token;
  }

  const value = Number(String(token).replace(/[^\d+\-.]/g, ''));
  return Number.isFinite(value) ? value : null;
}

function parseExifDateString(value) {
  if (!value || typeof value !== 'string') return null;

  // Exif date format usually looks like: 2025:01:03 18:33:41
  const normalized = value
    .trim()
    .replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
    .replace(/\.\d+$/, '');

  const asDate = new Date(normalized);
  if (Number.isNaN(asDate.getTime())) {
    return null;
  }

  return asDate.getTime();
}

function extractCaptureTimestampFromStem(stem) {
  const dateAndTime = stem.match(/(20\d{2}[01]\d[0-3]\d)[_-]?([0-2]\d[0-5]\d[0-5]\d)/);
  if (dateAndTime) {
    return `${dateAndTime[1]}${dateAndTime[2]}`;
  }

  const packed = stem.match(/(20\d{12})/);
  return packed ? packed[1] : null;
}

function normalizeBracketStem(stem) {
  return stem
    .replace(/(?:[_-](?:ev|exp)?[+\-]?\d+(?:\.\d+)?)$/i, '')
    .replace(/(?:[_-](?:aeb|hdr|d))$/i, '')
    .replace(/(?:[_-]\d{3,6})$/, '')
    .replace(/[_-]+$/, '')
    .toLowerCase();
}

function parseExposureHintFromStem(stem) {
  const patterns = [
    /(?:^|[_-])(?:ev|exp)([+\-]?\d+(?:\.\d+)?)(?:$|[_-])/i,
    /(?:^|[_-])([+\-]?\d+(?:\.\d+)?)ev(?:$|[_-])/i,
    /(?:^|[_-])m(\d+(?:\.\d+)?)(?:$|[_-])/i,
    /(?:^|[_-])p(\d+(?:\.\d+)?)(?:$|[_-])/i,
  ];

  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (!match) continue;

    const token = match[0].toLowerCase();
    let value = Number(match[1]);

    if (!Number.isFinite(value)) continue;
    if (token.includes('m') && !token.includes('ev') && !token.includes('exp')) value *= -1;

    return value;
  }

  return null;
}

function parseSequenceNumberFromStem(stem) {
  const trailing = stem.match(/(?:^|[_-])(\d{3,6})(?:$|[_-])/);
  if (!trailing) return null;

  const numeric = Number(trailing[1]);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildBracketRecord(filePath, stats, metadata = null) {
  const resolvedPath = path.resolve(filePath);
  const stem = path.basename(resolvedPath, path.extname(resolvedPath));

  const metadataExposure = parseExposureToken(
    metadata?.exposureCompensation
    ?? metadata?.exposureBias
    ?? metadata?.exposureEv
  );

  const metadataCaptureMs = parseExifDateString(
    metadata?.dateTimeOriginal
    ?? metadata?.subSecDateTimeOriginal
    ?? metadata?.createDate
  );

  return {
    filePath: resolvedPath,
    dir: path.dirname(resolvedPath),
    stem,
    normalizedStem: normalizeBracketStem(stem),
    sequenceNumber: parseSequenceNumberFromStem(stem),
    captureStamp: extractCaptureTimestampFromStem(stem),
    mtimeMs: stats.mtimeMs,
    captureTimeMs: metadataCaptureMs || stats.mtimeMs,
    exposureEv: Number.isFinite(metadataExposure)
      ? metadataExposure
      : parseExposureHintFromStem(stem),
    metadataSource: metadata ? 'metadata' : 'filename',
    metadata,
  };
}

function splitRecordsByTimeGap(records, maxGapMs) {
  if (!records.length) return [];

  const sorted = [...records].sort((a, b) => {
    if (a.captureTimeMs !== b.captureTimeMs) {
      return a.captureTimeMs - b.captureTimeMs;
    }

    if (a.mtimeMs !== b.mtimeMs) {
      return a.mtimeMs - b.mtimeMs;
    }

    return a.filePath.localeCompare(b.filePath);
  });

  const groups = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const next = sorted[i];
    const delta = Math.abs(next.captureTimeMs - previous.captureTimeMs);

    if (delta > maxGapMs) {
      groups.push(current);
      current = [next];
      continue;
    }

    current.push(next);
  }

  groups.push(current);
  return groups;
}

function bucketRecords(records, maxGapMs) {
  const buckets = new Map();

  for (const record of records) {
    const captureDay = record.captureStamp ? record.captureStamp.slice(0, 8) : null;

    const key = captureDay
      ? `${record.dir}|day|${captureDay}`
      : `${record.dir}|stem|${record.normalizedStem}`;

    if (!buckets.has(key)) {
      buckets.set(key, []);
    }

    buckets.get(key).push(record);
  }

  const chunks = [];

  for (const [bucketKey, bucketRecords] of buckets.entries()) {
    const timeChunks = splitRecordsByTimeGap(bucketRecords, maxGapMs);

    for (const chunk of timeChunks) {
      if (!chunk.length) continue;
      chunks.push({
        bucketKey,
        records: chunk,
      });
    }
  }

  return chunks;
}

function sortRecordsForMerge(records) {
  const useExposure = records.every((record) => Number.isFinite(record.exposureEv));

  return [...records].sort((a, b) => {
    if (useExposure && a.exposureEv !== b.exposureEv) {
      return a.exposureEv - b.exposureEv;
    }

    if (Number.isFinite(a.sequenceNumber) && Number.isFinite(b.sequenceNumber) && a.sequenceNumber !== b.sequenceNumber) {
      return a.sequenceNumber - b.sequenceNumber;
    }

    if (a.captureTimeMs !== b.captureTimeMs) {
      return a.captureTimeMs - b.captureTimeMs;
    }

    return a.filePath.localeCompare(b.filePath);
  });
}

function sortRecordsForPartition(records) {
  return [...records].sort((a, b) => {
    if (Number.isFinite(a.sequenceNumber) && Number.isFinite(b.sequenceNumber) && a.sequenceNumber !== b.sequenceNumber) {
      return a.sequenceNumber - b.sequenceNumber;
    }

    if (a.captureTimeMs !== b.captureTimeMs) {
      return a.captureTimeMs - b.captureTimeMs;
    }

    if (a.mtimeMs !== b.mtimeMs) {
      return a.mtimeMs - b.mtimeMs;
    }

    return a.filePath.localeCompare(b.filePath);
  });
}

function summarizeSequenceRange(records) {
  const sequenceValues = records
    .map((record) => record.sequenceNumber)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!sequenceValues.length) {
    return {
      available: false,
      start: null,
      end: null,
      span: null,
      maxGap: null,
      contiguous: null,
    };
  }

  let maxGap = 0;
  for (let i = 1; i < sequenceValues.length; i++) {
    const gap = sequenceValues[i] - sequenceValues[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
    }
  }

  const start = sequenceValues[0];
  const end = sequenceValues[sequenceValues.length - 1];

  return {
    available: true,
    start,
    end,
    span: Math.max(0, end - start),
    maxGap,
    contiguous: maxGap <= 1,
  };
}

function summarizeCaptureTimeRange(records) {
  const captureTimes = records
    .map((record) => record.captureTimeMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!captureTimes.length) {
    return {
      available: false,
      startMs: null,
      endMs: null,
      spanMs: null,
      maxGapMs: null,
    };
  }

  let maxGapMs = 0;
  for (let i = 1; i < captureTimes.length; i++) {
    const gap = captureTimes[i] - captureTimes[i - 1];
    if (gap > maxGapMs) {
      maxGapMs = gap;
    }
  }

  const startMs = captureTimes[0];
  const endMs = captureTimes[captureTimes.length - 1];

  return {
    available: true,
    startMs,
    endMs,
    spanMs: Math.max(0, endMs - startMs),
    maxGapMs,
  };
}

function summarizeExposureSignature(records) {
  const exposures = records
    .map((record) => record.exposureEv)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!exposures.length) {
    return 'unknown';
  }

  return exposures.map((value) => value.toFixed(2)).join('|');
}

function describePartitionedSet(records, partitionMethod) {
  return {
    partitionMethod,
    sequenceRange: summarizeSequenceRange(records),
    captureTimeRange: summarizeCaptureTimeRange(records),
    exposureSignature: summarizeExposureSignature(records),
  };
}

function validateBracketSetRecords(records, options = {}) {
  const expectedSize = Number(options.expectedSize) || records.length;
  const sequenceRange = summarizeSequenceRange(records);
  const captureTimeRange = summarizeCaptureTimeRange(records);
  const exposureSignature = summarizeExposureSignature(records);
  const reasons = [];
  const warnings = [];

  if (sequenceRange.available) {
    const allowedSpan = Math.max(expectedSize + 1, 6);
    if (sequenceRange.span > allowedSpan) {
      reasons.push(
        `filename sequence span is too wide (${sequenceRange.start}-${sequenceRange.end}) for ${expectedSize}-shot bracket.`
      );
    }

    if (sequenceRange.maxGap > 2) {
      reasons.push(`filename sequence has abnormal jump (max gap ${sequenceRange.maxGap}).`);
    }
  }

  if (captureTimeRange.available) {
    const spanLimitMs = expectedSize >= 5 ? 15000 : 10000;
    if (captureTimeRange.spanMs > spanLimitMs) {
      reasons.push(
        `capture time spread is too large (${captureTimeRange.spanMs}ms) for ${expectedSize}-shot bracket.`
      );
    }
  }

  if (exposureSignature !== 'unknown') {
    const uniqueExposureCount = new Set(exposureSignature.split('|')).size;
    if (expectedSize >= 5 && uniqueExposureCount < 3) {
      warnings.push('exposure signature appears narrow for a 5-shot bracket.');
    }
  }

  return {
    isValid: reasons.length === 0,
    reasons,
    warnings,
    sequenceRange,
    captureTimeRange,
    exposureSignature,
  };
}

function evaluatePartition(parts) {
  let incompleteFileCount = 0;
  let incompleteGroupCount = 0;
  let completeGroupCount = 0;
  let fiveShotCount = 0;

  for (const size of parts) {
    if (size === 3 || size === 5) {
      completeGroupCount += 1;
      if (size === 5) {
        fiveShotCount += 1;
      }
      continue;
    }

    incompleteGroupCount += 1;
    incompleteFileCount += size;
  }

  return {
    parts,
    incompleteFileCount,
    incompleteGroupCount,
    completeGroupCount,
    partCount: parts.length,
    fiveShotCount,
  };
}

function isBetterPartition(candidate, currentBest) {
  if (!currentBest) return true;

  if (candidate.incompleteFileCount !== currentBest.incompleteFileCount) {
    return candidate.incompleteFileCount < currentBest.incompleteFileCount;
  }

  if (candidate.incompleteGroupCount !== currentBest.incompleteGroupCount) {
    return candidate.incompleteGroupCount < currentBest.incompleteGroupCount;
  }

  if (candidate.completeGroupCount !== currentBest.completeGroupCount) {
    return candidate.completeGroupCount > currentBest.completeGroupCount;
  }

  if (candidate.partCount !== currentBest.partCount) {
    return candidate.partCount < currentBest.partCount;
  }

  if (candidate.fiveShotCount !== currentBest.fiveShotCount) {
    return candidate.fiveShotCount > currentBest.fiveShotCount;
  }

  return false;
}

function chooseAutoPartition(totalCount) {
  const sizes = [5, 3, 4, 2];
  const memo = new Map();

  function solve(remaining) {
    if (remaining === 0) return [];
    if (remaining < 2) return null;
    if (memo.has(remaining)) return memo.get(remaining);

    let best = null;

    for (const size of sizes) {
      if (remaining < size) continue;

      const tail = solve(remaining - size);
      if (!tail) continue;

      const candidate = [size, ...tail];

      if (isBetterPartition(evaluatePartition(candidate), best ? evaluatePartition(best) : null)) {
        best = candidate;
      }
    }

    memo.set(remaining, best);
    return best;
  }

  return solve(totalCount) || [totalCount];
}

function shouldPreferSequentialFiveShotPartition(records) {
  if (records.length < 10 || records.length % 5 !== 0) {
    return false;
  }

  const sequenceValues = records.map((record) => record.sequenceNumber);
  if (sequenceValues.some((value) => !Number.isFinite(value))) {
    return false;
  }

  for (let i = 1; i < sequenceValues.length; i++) {
    const gap = sequenceValues[i] - sequenceValues[i - 1];
    if (gap <= 0 || gap > 2) {
      return false;
    }
  }

  for (let offset = 0; offset < sequenceValues.length; offset += 5) {
    const start = sequenceValues[offset];
    const end = sequenceValues[offset + 4];
    if ((end - start) > 6) {
      return false;
    }
  }

  return true;
}

function partitionChunkIntoBracketSets(records, bracketMode) {
  const sortedForPartition = sortRecordsForPartition(records);

  if (!sortedForPartition.length) {
    return {
      completeSets: [],
      incompleteSets: [],
      completeSetMeta: [],
      incompleteSetMeta: [],
      partitionMethod: 'none',
    };
  }

  const completeSets = [];
  const incompleteSets = [];
  const completeSetMeta = [];
  const incompleteSetMeta = [];
  let partitionMethod = 'auto-dp';

  if (bracketMode === '3' || bracketMode === '5') {
    const groupSize = Number(bracketMode);
    partitionMethod = `fixed-size-${groupSize}`;

    for (let i = 0; i < sortedForPartition.length; i += groupSize) {
      const rawSetRecords = sortedForPartition.slice(i, i + groupSize);
      const groupRecords = sortRecordsForMerge(rawSetRecords);
      const meta = describePartitionedSet(rawSetRecords, partitionMethod);
      if (groupRecords.length === groupSize) {
        completeSets.push(groupRecords);
        completeSetMeta.push(meta);
      } else {
        incompleteSets.push(groupRecords);
        incompleteSetMeta.push(meta);
      }
    }

    return {
      completeSets,
      incompleteSets,
      completeSetMeta,
      incompleteSetMeta,
      partitionMethod,
    };
  }

  const sizes = shouldPreferSequentialFiveShotPartition(sortedForPartition)
    ? new Array(sortedForPartition.length / 5).fill(5)
    : chooseAutoPartition(sortedForPartition.length);

  if (sizes.every((size) => size === 5)) {
    partitionMethod = shouldPreferSequentialFiveShotPartition(sortedForPartition)
      ? 'auto-sequential-five-blocks'
      : 'auto-dp-five-blocks';
  }

  let offset = 0;

  for (const size of sizes) {
    const rawSetRecords = sortedForPartition.slice(offset, offset + size);
    const groupRecords = sortRecordsForMerge(rawSetRecords);
    const meta = describePartitionedSet(rawSetRecords, partitionMethod);
    offset += size;

    if (groupRecords.length < 2) {
      incompleteSets.push(groupRecords);
      incompleteSetMeta.push(meta);
      continue;
    }

    if (size === 3 || size === 5) {
      completeSets.push(groupRecords);
      completeSetMeta.push(meta);
    } else {
      incompleteSets.push(groupRecords);
      incompleteSetMeta.push(meta);
    }
  }

  return {
    completeSets,
    incompleteSets,
    completeSetMeta,
    incompleteSetMeta,
    partitionMethod,
  };
}

module.exports = {
  buildBracketRecord,
  bucketRecords,
  partitionChunkIntoBracketSets,
  sortRecordsForMerge,
  sortRecordsForPartition,
  validateBracketSetRecords,
  parseExifDateString,
  parseExposureToken,
};
