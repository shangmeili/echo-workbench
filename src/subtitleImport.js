const TIME_TOKEN = "\\d{1,2}:\\d{2}(?::\\d{2})?(?:[,.]\\d{1,3})?";

function normalizeInputNewlines(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\\r\\n|\\n|\\r/g, "\n");
}

export function parseTimestamp(value) {
  const normalized = String(value || "").trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(normalized) || 0;
}

function isLikelySpeakerLabel(value) {
  const label = String(value || "").trim();
  return /^(说话人\s*\d*|发言人\s*\d*|speaker[\s_-]*\d*|spk[\s_-]*\d*|主持人|嘉宾|采访者|受访者|旁白|男声|女声|男|女|问|答|q|a|s\d+|p\d+)$/i.test(label);
}

function extractSpeakerPrefix(value) {
  let text = String(value || "").trim();
  const voiceTagMatch = text.match(/^<v\s+([^>]{1,32})>\s*(.*)$/i);
  if (voiceTagMatch) {
    const speaker = voiceTagMatch[1].trim();
    const content = voiceTagMatch[2].trim();
    if (speaker && content) return { speaker, text: content };
  }

  const bracketMatch = text.match(/^\[([^\]]{1,32})\]\s*(.+)$/);
  if (bracketMatch && isLikelySpeakerLabel(bracketMatch[1])) {
    return { speaker: bracketMatch[1].trim(), text: bracketMatch[2].trim() };
  }

  const speakerMatch = text.match(/^([^:：]{1,32})[:：]\s*(.+)$/);
  if (speakerMatch && isLikelySpeakerLabel(speakerMatch[1])) {
    return { speaker: speakerMatch[1].trim(), text: speakerMatch[2].trim() };
  }
  return { speaker: "", text };
}

function extractSpeakerFromContentLines(lines) {
  const cleanLines = lines.map((line) => line.trim()).filter(Boolean);
  if (!cleanLines.length) return { speaker: "未标注", lines: cleanLines };
  const first = extractSpeakerPrefix(cleanLines[0]);
  if (!first.speaker) return { speaker: "未标注", lines: cleanLines };
  return { speaker: first.speaker, lines: [first.text, ...cleanLines.slice(1)].filter(Boolean) };
}

function dominantScript(value) {
  const text = String(value || "");
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk >= 2 && cjk >= latin) return "cjk";
  if (latin >= 3 && latin > cjk * 1.5) return "latin";
  return "mixed";
}

function splitBilingualContent(lines) {
  const cleanLines = lines.map((line) => line.trim()).filter(Boolean);
  if (cleanLines.length !== 2) return null;
  const firstScript = dominantScript(cleanLines[0]);
  const secondScript = dominantScript(cleanLines[1]);
  if (firstScript === "mixed" || secondScript === "mixed" || firstScript === secondScript) return null;
  return {
    text: cleanLines[0],
    translation: cleanLines[1],
  };
}

export function parsePlainTextRows(text) {
  const timestampPattern = new RegExp(`^\\[?(${TIME_TOKEN})(?:\\s*(?:-->|[-–—~至到])\\s*(${TIME_TOKEN}))?\\]?\\s*(.*)$`);
  const lines = normalizeInputNewlines(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  let lastStart = -3;
  const entries = [];
  let pendingTimedEntry = null;

  const pushEntry = (entry) => {
    entries.push(entry);
    lastStart = entry.start;
  };

  const flushPendingTimedEntry = () => {
    if (!pendingTimedEntry) return;
    const speakerContent = extractSpeakerFromContentLines(pendingTimedEntry.contentLines);
    const bilingual = splitBilingualContent(speakerContent.lines);
    const content = speakerContent.lines.join("\n").trim();
    pushEntry({
      start: pendingTimedEntry.start,
      explicitEnd: pendingTimedEntry.explicitEnd,
      speaker: speakerContent.speaker || "未标注",
      text: bilingual?.text || content || pendingTimedEntry.fallbackText,
      translation: bilingual?.translation || "",
    });
    pendingTimedEntry = null;
  };

  lines.forEach((line, index) => {
    const timestampMatch = line.match(timestampPattern);
    const hasTimestamp = Boolean(timestampMatch);
    const timestampStart = hasTimestamp ? parseTimestamp(timestampMatch[1]) : null;
    const timestampEnd = hasTimestamp && timestampMatch[2] ? parseTimestamp(timestampMatch[2]) : null;
    const start = hasTimestamp ? timestampStart : Math.max(index * 3, lastStart + 3);
    let content = hasTimestamp ? timestampMatch[3].replace(/^[-–—]\s*/, "").trim() : line;
    const shouldCollectFollowingLines = hasTimestamp && (timestampEnd || !content);

    if (shouldCollectFollowingLines) {
      flushPendingTimedEntry();
      pendingTimedEntry = {
        start,
        explicitEnd: timestampEnd && timestampEnd > start ? timestampEnd : null,
        contentLines: content ? [content] : [],
        fallbackText: line,
      };
      return;
    }

    if (!hasTimestamp && pendingTimedEntry) {
      pendingTimedEntry.contentLines.push(line);
      return;
    }

    flushPendingTimedEntry();
    const speakerPrefix = extractSpeakerPrefix(content);
    const speaker = speakerPrefix.speaker || "未标注";
    content = speakerPrefix.text;
    pushEntry({ start, explicitEnd: timestampEnd && timestampEnd > start ? timestampEnd : null, speaker, text: content || line });
  });
  flushPendingTimedEntry();
  return entries.map((entry, index) => {
    const next = entries.slice(index + 1).find((item) => item.start > entry.start);
    const end = entry.explicitEnd || (next ? Math.max(entry.start + 0.5, next.start) : entry.start + 3);
    return {
      id: `text-${Date.now()}-${index}`,
      start: entry.start,
      end,
      speaker: entry.speaker,
      text: entry.text,
      translation: entry.translation || "",
    };
  });
}

export function parseSubtitle(text) {
  const clean = normalizeInputNewlines(text).replace(/^WEBVTT[^\n]*\n+/i, "").trim();
  if (!clean) return [];
  const cueTimePattern = new RegExp(`^${TIME_TOKEN}(?:\\s+\\S+:\\S+)*$`);
  const hasInlineArrowText = clean
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("-->"))
    .some((line) => {
      const [, endPart = ""] = line.split("-->");
      return !cueTimePattern.test(endPart.trim());
    });
  if (hasInlineArrowText) {
    return parsePlainTextRows(clean);
  }
  const blocks = clean.split(/\n{2,}/);
  const rows = [];
  blocks.forEach((block, index) => {
    const lines = block.split("\n").filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) return;
    const [startRaw, endRaw] = lines[timeIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
    const speakerContent = extractSpeakerFromContentLines(lines.slice(timeIndex + 1));
    const bilingual = splitBilingualContent(speakerContent.lines);
    const content = speakerContent.lines.join("\n").trim();
    rows.push({
      id: `subtitle-${Date.now()}-${index}`,
      start: parseTimestamp(startRaw),
      end: parseTimestamp(endRaw),
      speaker: speakerContent.speaker,
      text: bilingual?.text || content,
      translation: bilingual?.translation || "",
    });
  });
  if (!rows.length) {
    rows.push(...parsePlainTextRows(clean));
  }
  return rows;
}
