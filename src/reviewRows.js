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
    if (!hints.includes("单条过长")) {
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

export function repairReviewStructure(inputRows = []) {
  const timedRows = repairAsrTimeline(dedupeAdjacentAsrRows(inputRows));
  const mergedRows = mergeShortAdjacentAsrRows(timedRows, { maxGapSeconds: 0.85, maxCombinedDuration: 5.8 });
  const readableRepair = repairReadableReviewRows(repairAsrTimeline(mergedRows));
  const repairedRows = repairAsrTimeline(readableRepair.rows);
  const mergedRowCount = Math.max(0, timedRows.length - mergedRows.length);
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

export function repairReviewStructurePreservingEmpty(inputRows = []) {
  const normalizedRows = normalizeReviewRows(inputRows);
  const repairedRows = [];
  let pendingRows = [];
  let splitRowCount = 0;
  let addedRowCount = 0;
  let mergedRowCount = 0;

  const flushPendingRows = () => {
    if (!pendingRows.length) return;
    const repair = repairReviewStructure(pendingRows);
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
    rows: repairReviewTimelinePreservingEmpty(repairedRows),
    splitRowCount,
    addedRowCount,
    mergedRowCount,
  };
}
