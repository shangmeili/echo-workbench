export function formatClock(totalSeconds) {
  const totalMillis = Math.max(0, Math.round(Number(totalSeconds || 0) * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const seconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function formatSrtTime(totalSeconds) {
  const totalMillis = Math.max(0, Math.round(Number(totalSeconds || 0) * 1000));
  const hours = Math.floor(totalMillis / 3600000);
  const minutes = Math.floor((totalMillis % 3600000) / 60000);
  const seconds = Math.floor((totalMillis % 60000) / 1000);
  const millis = totalMillis % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export function rowOutputLines(row, mode) {
  const source = String(row.text || "").trim();
  const target = String(row.translation || "").trim();
  if (mode === "target") return [target].filter(Boolean);
  if (mode === "bilingual") return [source, target].filter(Boolean);
  return [source].filter(Boolean);
}

export function validateExportRows(rows, mode = "source") {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("没有可导出的段落。");
  }
  rows.forEach((row, index) => {
    const source = String(row?.text || "").trim();
    const target = String(row?.translation || "").trim();
    const start = Number(row?.start) || 0;
    const end = Number(row?.end) || 0;
    if (!source) {
      throw new Error(`第 ${index + 1} 条段落没有原文。`);
    }
    if ((mode === "target" || mode === "bilingual") && !target) {
      throw new Error(`第 ${index + 1} 条段落没有译文。`);
    }
    if (end <= start) {
      throw new Error(`第 ${index + 1} 条段落时间无效。`);
    }
    const next = rows[index + 1];
    if (next && Number(next.start || 0) < end - 0.02) {
      throw new Error(`第 ${index + 1} 条段落与下一条时间重叠。`);
    }
  });
}

const defaultExportOptions = {
  includeTimecodes: true,
  includeSpeakers: true,
};

function normalizeExportOptions(options = {}) {
  return { ...defaultExportOptions, ...options };
}

function speakerPrefix(row, options = defaultExportOptions) {
  if (!options.includeSpeakers) return "";
  const speaker = String(row?.speaker || "").trim();
  if (!speaker || speaker === "未标注") return "";
  return `${speaker}: `;
}

function speakerLabel(row, options = defaultExportOptions) {
  return speakerPrefix(row, options).replace(/:\s*$/, "");
}

function markdownContentLines(row, mode) {
  const source = String(row.text || "").trim();
  const target = String(row.translation || "").trim();
  if (mode === "target") return target ? [`译文：${target}`] : [];
  if (mode === "bilingual") {
    return [
      source ? `原文：${source}` : "",
      target ? `译文：${target}` : "",
    ].filter(Boolean);
  }
  return source ? [source] : [];
}

function textBlock(row, mode, options = defaultExportOptions) {
  const source = String(row.text || "").trim();
  const target = String(row.translation || "").trim();
  if (mode === "bilingual") {
    const meta = [
      options.includeTimecodes ? `[${formatClock(row.start)} - ${formatClock(row.end)}]` : "",
      speakerLabel(row, options),
    ].filter(Boolean).join(" ");
    return [
      meta,
      source ? `原文：${source}` : "",
      target ? `译文：${target}` : "",
    ].filter(Boolean).join("\n");
  }
  const prefix = [
    options.includeTimecodes ? `[${formatClock(row.start)}]` : "",
    speakerPrefix(row, options),
  ].filter(Boolean).join(" ");
  const text = rowOutputLines(row, mode).join("\n");
  if (!prefix) return text;
  return `${prefix}${prefix.endsWith(" ") ? "" : " "}${text}`;
}

function markdownBlock(row, options = defaultExportOptions) {
  const meta = [
    options.includeTimecodes ? `**${formatClock(row.start)} - ${formatClock(row.end)}**` : "",
    speakerLabel(row, options),
  ].filter(Boolean).join(" · ");
  const lines = markdownContentLines(row, row.__exportMode || "source");
  if (!meta) {
    return lines.map((line) => `- ${line.replace(/\n/g, "\n  ")}`).join("\n");
  }
  return [`- ${meta}`, ...lines.map((line) => `  ${line.replace(/\n/g, "\n  ")}`)].join("\n");
}

function markdownTitle(mode) {
  if (mode === "target") return "译文稿";
  if (mode === "bilingual") return "双语稿";
  return "转写稿";
}

export function exportRows(rows, format, mode = "source", options = {}) {
  validateExportRows(rows, mode);
  const exportOptions = normalizeExportOptions(options);
  if (format === "txt") {
    return rows.map((row) => textBlock(row, mode, exportOptions)).join("\n\n");
  }
  if (format === "md") {
    return `# ${markdownTitle(mode)}\n\n${rows.map((row) => markdownBlock({ ...row, __exportMode: mode }, exportOptions)).join("\n\n")}`;
  }
  if (format === "vtt") {
    return `WEBVTT\n\n${rows
      .map((row, index) => `${index + 1}\n${formatSrtTime(row.start).replace(",", ".")} --> ${formatSrtTime(row.end).replace(",", ".")}\n${rowOutputLines(row, mode).join("\n")}`)
      .join("\n\n")}`;
  }
  return rows
    .map((row, index) => `${index + 1}\n${formatSrtTime(row.start)} --> ${formatSrtTime(row.end)}\n${rowOutputLines(row, mode).join("\n")}`)
    .join("\n\n");
}
