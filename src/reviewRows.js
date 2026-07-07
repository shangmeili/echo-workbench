import { dedupeAdjacentAsrRows, mergeShortAdjacentAsrRows, repairAsrTimeline, splitTranscriptIntoSentences, transcriptWeight } from "./asrRows.js";

export function normalizeReviewRows(rows = []) {
  return rows.map((row, index) => {
    const start = Number(row?.start);
    const end = Number(row?.end);
    const normalizedStart = Number.isFinite(start) ? start : 0;
    const normalizedEnd = Number.isFinite(end) ? end : normalizedStart;
    const text = row?.text || "";
    return {
      ...row,
      id: row?.id || `row-${Date.now()}-${index}`,
      start: normalizedStart,
      end: normalizedEnd,
      speaker: row?.speaker || "未标注",
      text,
      translation: row?.translation || "",
      originalText: row?.originalText ?? text,
      reviewStatus: row?.reviewStatus || "pending",
    };
  });
}

function subtitleReadableLength(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

function subtitleLengthLimit(value) {
  return /[A-Za-z]/.test(String(value || "")) && /\s/.test(String(value || "")) ? 18 : 20;
}

export function getSubtitleQualityHints(row, nextRow = null) {
  const hints = [];
  const start = Number(row?.start) || 0;
  const end = Number(row?.end) || 0;
  const duration = end - start;
  const text = String(row?.text || "");
  const textLength = /[A-Za-z]/.test(text) && /\s/.test(text) ? transcriptWeight(text) : subtitleReadableLength(text);
  if (!String(row?.text || "").trim()) hints.push("空文本");
  if (end <= start) hints.push("时间无效");
  if (nextRow && Number(nextRow.start) < end - 0.02) hints.push("时间重叠");
  if (duration > 0 && duration < 0.7) hints.push("时长过短");
  if (textLength > subtitleLengthLimit(text)) hints.push("单条过长");
  if (duration > 0 && textLength / duration > 18) hints.push("阅读过快");
  return hints;
}

export function hasTimingExportIssue(rows = []) {
  return rows.some((row, index) => {
    const hints = getSubtitleQualityHints(row, rows[index + 1]);
    return hints.includes("时间无效") || hints.includes("时间重叠");
  });
}

function splitReviewRowByReadableText(row) {
  const textParts = splitTranscriptIntoSentences(row?.text || "");
  if (textParts.length <= 1) return [row];
  const start = Number(row.start) || 0;
  const end = Math.max(start + 0.5, Number(row.end) || start + textParts.length * 1.2);
  const duration = end - start;
  const totalWeight = textParts.reduce((sum, item) => sum + transcriptWeight(item), 0) || textParts.length;
  const originalParts = row.originalText && row.originalText !== row.text ? splitTranscriptIntoSentences(row.originalText) : textParts;
  const translationParts = row.translation ? splitTranscriptIntoSentences(row.translation) : [];
  let cursor = start;
  return textParts.map((part, index) => {
    const isLast = index === textParts.length - 1;
    const weight = transcriptWeight(part);
    const rowDuration = isLast ? end - cursor : Math.max(0.45, duration * (weight / totalWeight));
    const rowEnd = isLast ? end : Math.min(end - 0.2, cursor + rowDuration);
    const next = {
      ...row,
      id: index === 0 ? row.id : `row-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
      start: cursor,
      end: Math.max(cursor + 0.35, rowEnd),
      text: part,
      originalText: originalParts.length === textParts.length ? originalParts[index] : part,
      translation: translationParts.length === textParts.length ? translationParts[index] : "",
      reviewStatus: "pending",
    };
    cursor = next.end;
    return next;
  });
}

export function repairReadableReviewRows(inputRows = []) {
  const normalizedRows = normalizeReviewRows(inputRows);
  const repairedRows = [];
  let splitRowCount = 0;
  normalizedRows.forEach((row, index) => {
    const hints = getSubtitleQualityHints(row, normalizedRows[index + 1]);
    const needsReadableSplit = hints.includes("单条过长") || hints.includes("阅读过快");
    if (!needsReadableSplit) {
      repairedRows.push(row);
      return;
    }
    const parts = splitReviewRowByReadableText(row);
    if (parts.length > 1) splitRowCount += 1;
    repairedRows.push(...parts);
  });
  return {
    rows: normalizeReviewRows(repairedRows),
    splitRowCount,
    addedRowCount: Math.max(0, repairedRows.length - normalizedRows.length),
  };
}

function subtitleTextLengthForTiming(value) {
  const text = String(value || "");
  return /[A-Za-z]/.test(text) && /\s/.test(text) ? transcriptWeight(text) : subtitleReadableLength(text);
}

function readableDurationFloor(row) {
  const textLength = subtitleTextLengthForTiming(row?.text || "");
  if (!textLength) return 0.7;
  return Math.min(8, Math.max(0.7, textLength / 14));
}

function joinReviewText(left, right) {
  const previous = String(left || "").trim();
  const current = String(right || "").trim();
  if (!previous) return current;
  if (!current) return previous;
  if (/[\u4e00-\u9fff]$/.test(previous) && /^[\u4e00-\u9fff]/.test(current)) return `${previous}${current}`;
  if (/^[,.;:!?，。！？；：、]/.test(current)) return `${previous}${current}`;
  return `${previous} ${current}`.replace(/\s+([,.;:!?，。！？；：、])/g, "$1").trim();
}

function reviewSentenceClosed(text) {
  return /[。！？!?；;.]$/.test(String(text || "").trim());
}

function hasTimingPressure(row, nextRow = null) {
  const hints = getSubtitleQualityHints(row, nextRow);
  return hints.includes("时长过短") || hints.includes("阅读过快");
}

function mergeTimingPressureAdjacentRows(inputRows = []) {
  const rows = normalizeReviewRows(inputRows);
  const result = [];
  for (const row of rows) {
    const previous = result.at(-1);
    if (!previous) {
      result.push(row);
      continue;
    }
    const gap = Number(row.start) - Number(previous.end);
    const shouldMerge = hasTimingPressure(previous, row)
      && gap <= 0.35
      && !reviewSentenceClosed(previous.text)
      && String(previous.speaker || "未标注") === String(row.speaker || "未标注");
    if (!shouldMerge) {
      result.push(row);
      continue;
    }
    result[result.length - 1] = {
      ...previous,
      end: Math.max(Number(previous.end) || 0, Number(row.end) || 0),
      text: joinReviewText(previous.text, row.text),
      originalText: joinReviewText(previous.originalText || previous.text, row.originalText || row.text),
      translation: joinReviewText(previous.translation, row.translation),
      reviewStatus: previous.reviewStatus === "confirmed" ? "pending" : previous.reviewStatus,
    };
  }
  return normalizeReviewRows(result);
}

function boundedNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function fitRowsWithinMaxEnd(inputRows = [], maxEnd = 0) {
  const rows = normalizeReviewRows(inputRows);
  const boundedEnd = Number(maxEnd);
  if (!rows.length || !Number.isFinite(boundedEnd) || boundedEnd <= 0) return rows;
  const lastEnd = Math.max(...rows.map((row) => boundedNumber(row.end, 0)), 0);
  if (lastEnd <= boundedEnd + 0.001) return rows;

  const firstStart = Math.max(0, Math.min(boundedNumber(rows[0].start, 0), boundedEnd));
  const available = Math.max(0.05 * rows.length, boundedEnd - firstStart);
  const minimumDuration = Math.min(0.35, Math.max(0.05, (available / rows.length) * 0.35));
  const totalMinimum = minimumDuration * rows.length;
  const flexibleDuration = Math.max(0, available - totalMinimum);
  const weights = rows.map((row) => Math.max(1, subtitleTextLengthForTiming(row.text)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || rows.length;
  let cursor = firstStart;

  return rows.map((row, index) => {
    const isLast = index === rows.length - 1;
    const targetDuration = isLast
      ? Math.max(0.05, boundedEnd - cursor)
      : minimumDuration + flexibleDuration * (weights[index] / totalWeight);
    const start = Math.min(cursor, Math.max(0, boundedEnd - 0.05));
    const end = isLast ? boundedEnd : Math.min(boundedEnd, Math.max(start + 0.05, start + targetDuration));
    cursor = end;
    return { ...row, start, end: Math.max(start + 0.01, end) };
  });
}

function repairTimingPressureRows(inputRows = []) {
  const rows = normalizeReviewRows(inputRows);
  let previousEnd = 0;
  return rows.map((row) => {
    const start = Math.max(Number(row.start) || 0, previousEnd);
    const end = Number(row.end) || start;
    const desiredEnd = start + readableDurationFloor(row);
    const nextEnd = Math.max(start + 0.35, end, desiredEnd);
    previousEnd = nextEnd;
    return { ...row, start, end: nextEnd };
  });
}

export function repairReviewStructure(inputRows = [], options = {}) {
  const boundedEnd = Number(options.maxEnd) || 0;
  const timedRows = repairAsrTimeline(dedupeAdjacentAsrRows(inputRows));
  const pressureMergedRows = mergeTimingPressureAdjacentRows(timedRows);
  const mergedRows = mergeShortAdjacentAsrRows(pressureMergedRows, { maxGapSeconds: 0.85, maxCombinedDuration: 5.8 });
  const readableRepair = repairReadableReviewRows(repairAsrTimeline(mergedRows));
  const timedReadableRows = boundedEnd > 0
    ? repairAsrTimeline(readableRepair.rows)
    : repairTimingPressureRows(readableRepair.rows);
  const finalMergedRows = mergeShortAdjacentAsrRows(timedReadableRows, { maxGapSeconds: 0.85, maxCombinedDuration: 5.8 });
  const timelineRows = repairAsrTimeline(finalMergedRows);
  const pressureRows = repairAsrTimeline(repairTimingPressureRows(finalMergedRows));
  const timelineLastEnd = Math.max(...timelineRows.map((row) => Number(row.end) || 0), 0);
  const pressureLastEnd = Math.max(...pressureRows.map((row) => Number(row.end) || 0), 0);
  const shouldPreserveBoundedTiming = boundedEnd > 0 && timelineLastEnd <= boundedEnd + 0.001 && pressureLastEnd > boundedEnd + 0.001;
  const repairedRows = fitRowsWithinMaxEnd(shouldPreserveBoundedTiming ? timelineRows : pressureRows, options.maxEnd);
  const mergedRowCount = Math.max(0, timedRows.length + readableRepair.addedRowCount - finalMergedRows.length);
  return {
    ...readableRepair,
    mergedRowCount,
    rows: normalizeReviewRows(repairedRows),
  };
}

export function repairReviewTimelinePreservingEmpty(inputRows = []) {
  const normalizedRows = normalizeReviewRows(inputRows);
  let previousEnd = 0;
  return normalizedRows.map((row, index) => {
    let start = Number.isFinite(Number(row.start)) ? Number(row.start) : previousEnd;
    let end = Number.isFinite(Number(row.end)) ? Number(row.end) : start + 0.35;
    if (index > 0 && start < previousEnd) {
      start = previousEnd;
    }
    if (end <= start) {
      end = start + 0.35;
    }
    previousEnd = end;
    return { ...row, start, end };
  });
}

export function repairReviewStructurePreservingEmpty(inputRows = [], options = {}) {
  const normalizedRows = normalizeReviewRows(inputRows);
  const repairedRows = [];
  let pendingRows = [];
  let splitRowCount = 0;
  let addedRowCount = 0;
  let mergedRowCount = 0;

  const flushPendingRows = () => {
    if (!pendingRows.length) return;
    const repair = repairReviewStructure(pendingRows, options);
    repairedRows.push(...repair.rows);
    splitRowCount += repair.splitRowCount || 0;
    addedRowCount += repair.addedRowCount || 0;
    mergedRowCount += repair.mergedRowCount || 0;
    pendingRows = [];
  };

  normalizedRows.forEach((row) => {
    if (String(row.text || "").trim()) {
      pendingRows.push(row);
      return;
    }
    flushPendingRows();
    repairedRows.push(row);
  });
  flushPendingRows();

  return {
    rows: fitRowsWithinMaxEnd(repairReviewTimelinePreservingEmpty(repairedRows), options.maxEnd),
    splitRowCount,
    addedRowCount,
    mergedRowCount,
  };
}
