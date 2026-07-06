export function splitTranscriptIntoSentences(text) {
  const clean = normalizeAsrText(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!clean) return [];
  const chunks = clean
    .split(/\n+|(?<=[。！？!?；;])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const rows = chunks.flatMap((chunk) => splitLongSentenceChunk(chunk));
  if (rows.length > 1) return rows;
  if (/\s/.test(clean) && /[A-Za-z]/.test(clean)) {
    const words = clean.split(/\s+/).filter(Boolean);
    const result = [];
    const maxWords = maxMergedUnits(clean);
    for (let index = 0; index < words.length; index += maxWords) {
      result.push(words.slice(index, index + maxWords).join(" "));
    }
    return result.filter(Boolean);
  }
  const maxChars = maxMergedUnits(clean);
  return splitCjkTextByReadableLength(clean, maxChars);
}

function splitLongSentenceChunk(text) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  const maxUnits = maxMergedUnits(clean);
  if (transcriptWeight(clean) <= maxUnits) return [clean];
  const pieces = clean
    .split(/(?<=[，,、：:])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  const result = [];
  let current = "";
  const flushCurrent = () => {
    if (!current.trim()) return;
    result.push(current.trim());
    current = "";
  };
  const hardSplit = (value) => {
    if (/\s/.test(value) && /[A-Za-z]/.test(value)) {
      const words = value.split(/\s+/).filter(Boolean);
      for (let index = 0; index < words.length; index += maxUnits) {
        result.push(words.slice(index, index + maxUnits).join(" "));
      }
      return;
    }
    result.push(...splitCjkTextByReadableLength(value, maxUnits));
  };

  for (const piece of pieces.length ? pieces : [clean]) {
    const candidate = current ? `${current}${piece}` : piece;
    if (transcriptWeight(candidate) <= maxUnits) {
      current = candidate;
      continue;
    }
    flushCurrent();
    if (transcriptWeight(piece) > maxUnits) {
      hardSplit(piece);
    } else {
      current = piece;
    }
  }
  flushCurrent();
  return result.length ? result : [clean];
}

function splitCjkTextByReadableLength(value, maxUnits) {
  const clean = String(value || "").trim();
  if (!clean) return [];
  const result = [];
  const softBreakPatterns = ["需要", "应该", "可以", "然后", "所以", "但是", "因为", "如果", "同时", "并且", "以及", "为了"];
  let remaining = clean;
  while (transcriptWeight(remaining) > maxUnits) {
    const minimum = Math.max(8, Math.floor(maxUnits * 0.62));
    if (transcriptWeight(remaining) <= maxUnits + 4) break;
    let splitIndex = -1;
    for (const pattern of softBreakPatterns) {
      const index = remaining.lastIndexOf(pattern, maxUnits);
      if (index >= minimum) {
        splitIndex = index;
        break;
      }
    }
    if (splitIndex < minimum) {
      splitIndex = maxUnits;
    }
    const tailLength = transcriptWeight(remaining.slice(splitIndex).trim());
    if (tailLength > 0 && tailLength < 5 && transcriptWeight(remaining) <= maxUnits + tailLength) break;
    const part = remaining.slice(0, splitIndex).trim();
    if (part) result.push(part);
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

export function transcriptWeight(text) {
  const value = String(text || "").trim();
  if (!value) return 1;
  if (/\s/.test(value) && /[A-Za-z]/.test(value)) return Math.max(value.split(/\s+/).length, 1);
  return Math.max(value.length, 1);
}

export function normalizeAsrText(text) {
  const value = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/([\u4e00-\u9fa5]),(?=[\u4e00-\u9fa5])/g, "$1，")
    .replace(/([\u4e00-\u9fa5]);(?=[\u4e00-\u9fa5])/g, "$1；")
    .replace(/([\u4e00-\u9fa5]):(?=[\u4e00-\u9fa5])/g, "$1：")
    .replace(/([\u4e00-\u9fa5])\?(?=$|[\s\u4e00-\u9fa5])/g, "$1？")
    .replace(/([\u4e00-\u9fa5])!(?=$|[\s\u4e00-\u9fa5])/g, "$1！")
    .replace(/([\u4e00-\u9fa5])\.(?=$|[\s\u4e00-\u9fa5])/g, "$1。")
    .trim();
  if (!/[\u4e00-\u9fa5]/.test(value)) return value;
  return value
    .replace(/中文字母/g, "中文字幕")
    .replace(/双语字母/g, "双语字幕")
    .replace(/中英字母/g, "中英字幕")
    .replace(/([A-Za-z0-9])\?(?=$|[\s\u4e00-\u9fa5])/g, "$1？")
    .replace(/([A-Za-z0-9])!(?=$|[\s\u4e00-\u9fa5])/g, "$1！");
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function wordText(item) {
  return String(item?.word ?? item?.text ?? item?.token ?? "").trim();
}

function wordStart(item) {
  return finiteNumber(item?.start ?? item?.start_time ?? item?.startTime, 0);
}

function wordEnd(item) {
  return finiteNumber(item?.end ?? item?.end_time ?? item?.endTime, wordStart(item) + 0.35);
}

export function joinAsrTokens(words) {
  const text = words.reduce((result, item) => {
    const token = wordText(item);
    if (!token) return result;
    if (!result) return token;
    const previous = result.at(-1) || "";
    if (/^[,.;:!?，。！？；：、）)]/.test(token)) return `${result}${token}`;
    if (/[（([]$/.test(previous)) return `${result}${token}`;
    if (/[,.;:!?]$/.test(previous) && /^[A-Za-z0-9\u4e00-\u9fa5]/.test(token)) return `${result} ${token}`;
    if ((/[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(token)) || (/[A-Za-z0-9]$/.test(previous) && /^[\u4e00-\u9fa5]/.test(token)) || (/[\u4e00-\u9fa5]$/.test(previous) && /^[A-Za-z0-9]/.test(token))) {
      return `${result} ${token}`;
    }
    return `${result}${token}`;
  }, "").replace(/\s+([,.;:!?，。！？；：、）)])/g, "$1").trim();
  return normalizeAsrText(text);
}

export function groupWordsToRows(words) {
  const rows = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const start = wordStart(group[0]);
    const end = Math.max(start + 0.2, wordEnd(group.at(-1)));
    const text = joinAsrTokens(group);
    if (text) {
      rows.push({
        id: `asr-${Date.now()}-${rows.length}`,
        start,
        end,
        speaker: "未标注",
        text,
        translation: "",
      });
    }
    group = [];
  };
  words.forEach((word) => {
    group.push(word);
    const text = joinAsrTokens(group);
    const duration = wordEnd(group.at(-1)) - wordStart(group[0]);
    const units = transcriptWeight(text);
    if (/[。！？!?；;]$/.test(wordText(word)) || units >= maxMergedUnits(text) || duration >= 4.8) flush();
  });
  flush();
  return rows;
}

function segmentText(segment) {
  return normalizeAsrText(segment?.text ?? segment?.transcript ?? segment?.sentence ?? "");
}

function rowsFromSegment(segment, segmentIndex) {
  const text = segmentText(segment);
  if (!text) return [];
  const start = finiteNumber(segment?.start ?? segment?.start_time ?? segment?.startTime, segmentIndex * 3);
  const inferredEnd = start + Math.max(transcriptWeight(text) * 0.22, 2);
  const rawEnd = finiteNumber(segment?.end ?? segment?.end_time ?? segment?.endTime, inferredEnd);
  const end = Math.max(start + 0.5, rawEnd);
  const speaker = segment.speaker || segment.speaker_label || "未标注";
  const sentences = splitTranscriptIntoSentences(text);
  if (sentences.length <= 1 && transcriptWeight(text) <= maxMergedUnits(text)) {
    return [{
      id: `asr-segment-${Date.now()}-${segmentIndex}`,
      start,
      end,
      speaker,
      text,
      translation: "",
    }];
  }

  const duration = Math.max(0.5, end - start);
  const totalWeight = sentences.reduce((sum, item) => sum + transcriptWeight(item), 0) || sentences.length || 1;
  const minimumSegmentDuration = Math.min(1.1, Math.max(0.35, (duration / Math.max(sentences.length, 1)) * 0.45));
  let cursor = start;
  return sentences.map((sentence, sentenceIndex) => {
    const isLast = sentenceIndex === sentences.length - 1;
    const remainingSegments = sentences.length - sentenceIndex - 1;
    const remainingDuration = Math.max(0.35, end - cursor);
    const proportional = duration * (transcriptWeight(sentence) / totalWeight);
    const segmentDuration = isLast ? remainingDuration : Math.max(proportional, minimumSegmentDuration);
    const latestEnd = Math.max(cursor + 0.3, end - remainingSegments * minimumSegmentDuration);
    const rowEnd = isLast ? end : Math.min(latestEnd, cursor + segmentDuration);
    const row = {
      id: `asr-segment-${Date.now()}-${segmentIndex}-${sentenceIndex}`,
      start: cursor,
      end: Math.max(cursor + 0.35, rowEnd),
      speaker,
      text: sentence,
      translation: "",
    };
    cursor = row.end;
    return row;
  }).filter((row) => row.text.trim());
}

function rowDuration(row) {
  return Math.max(0, finiteNumber(row?.end, 0) - finiteNumber(row?.start, 0));
}

function sameSpeaker(left, right) {
  return String(left?.speaker || "未标注") === String(right?.speaker || "未标注");
}

function isSentenceClosed(text) {
  return /[。！？!?；;.]$/.test(String(text || "").trim());
}

function isLatinText(text) {
  return /[A-Za-z]/.test(text) && /\s/.test(text);
}

function maxMergedUnits(text) {
  return isLatinText(text) ? 10 : 16;
}

function isShortFragment(row) {
  const text = normalizeAsrText(row?.text || "");
  if (!text || isSentenceClosed(text)) return false;
  const units = transcriptWeight(text);
  return rowDuration(row) < 1.05 || units <= 4;
}

function joinAdjacentAsrText(left, right) {
  const previous = normalizeAsrText(left || "");
  const current = normalizeAsrText(right || "");
  if (!previous) return current;
  if (!current) return previous;
  if (/[\u4e00-\u9fa5]$/.test(previous) && /^[\u4e00-\u9fa5，。！？；：、]/.test(current)) return `${previous}${current}`;
  if (/^[,.;:!?，。！？；：、]/.test(current)) return `${previous}${current}`;
  return `${previous} ${current}`.replace(/\s+([,.;:!?，。！？；：、])/g, "$1").trim();
}

export function mergeShortAdjacentAsrRows(rows, options = {}) {
  const maxGapSeconds = options.maxGapSeconds ?? 0.65;
  const maxCombinedDuration = options.maxCombinedDuration ?? 5.5;
  const result = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const text = normalizeAsrText(row?.text || "");
    if (!text) continue;
    const current = { ...row, text };
    const previous = result.at(-1);
    if (!previous) {
      result.push(current);
      continue;
    }

    const gap = finiteNumber(current.start, 0) - finiteNumber(previous.end, 0);
    const combinedText = joinAdjacentAsrText(previous.text, current.text);
    const combinedDuration = Math.max(finiteNumber(previous.end, 0), finiteNumber(current.end, 0)) - finiteNumber(previous.start, 0);
    const shouldMerge = sameSpeaker(previous, current)
      && gap >= -0.05
      && gap <= maxGapSeconds
      && combinedDuration <= maxCombinedDuration
      && transcriptWeight(combinedText) <= maxMergedUnits(combinedText)
      && (isShortFragment(previous) || isShortFragment(current));

    if (!shouldMerge) {
      result.push(current);
      continue;
    }

    result[result.length - 1] = {
      ...previous,
      end: Math.max(finiteNumber(previous.end, 0), finiteNumber(current.end, 0)),
      text: combinedText,
      translation: previous.translation || current.translation || "",
    };
  }

  return result;
}

export function rowsFromAsrResult(result, fallbackDuration = 0) {
  if (Array.isArray(result?.segments) && result.segments.length) {
    return result.segments.flatMap((segment, index) => rowsFromSegment(segment, index));
  }
  if (Array.isArray(result?.words) && result.words.length) {
    const rows = groupWordsToRows(result.words);
    if (rows.length) return rows;
  }
  const sentences = splitTranscriptIntoSentences(result?.text || result?.transcript || "");
  const duration = Number(fallbackDuration) > 0 ? Number(fallbackDuration) : Math.max(sentences.length * 4, 3);
  const totalWeight = sentences.reduce((sum, item) => sum + transcriptWeight(item), 0) || sentences.length || 1;
  const minimumSegmentDuration = Math.min(1.2, Math.max(0.45, (duration / Math.max(sentences.length, 1)) * 0.55));
  let cursor = 0;
  return sentences.map((text, index) => {
    const isLast = index === sentences.length - 1;
    const remainingSegments = sentences.length - index - 1;
    const remainingDuration = Math.max(0.5, duration - cursor);
    const proportional = duration * (transcriptWeight(text) / totalWeight);
    const segmentDuration = isLast ? remainingDuration : Math.max(proportional, minimumSegmentDuration);
    const start = cursor;
    const latestEnd = Math.max(start + 0.35, duration - remainingSegments * minimumSegmentDuration);
    const end = isLast ? duration : Math.min(latestEnd, start + segmentDuration);
    cursor = end;
    return {
      id: `asr-text-${Date.now()}-${index}`,
      start,
      end: Math.max(start + 0.5, end),
      speaker: "未标注",
      text,
      translation: "",
    };
  });
}

export function asrResultHasTiming(result) {
  return Boolean(
    (Array.isArray(result?.words) && result.words.length)
    || (Array.isArray(result?.segments) && result.segments.some((segment) => (
      Number.isFinite(Number(segment?.start ?? segment?.start_time ?? segment?.startTime))
      && Number.isFinite(Number(segment?.end ?? segment?.end_time ?? segment?.endTime))
    ))),
  );
}

export function dedupeAdjacentAsrRows(rows, maxGapSeconds = 1.2) {
  const sorted = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const startDiff = finiteNumber(a?.start, 0) - finiteNumber(b?.start, 0);
    if (startDiff) return startDiff;
    return finiteNumber(a?.end, 0) - finiteNumber(b?.end, 0);
  });
  const result = [];
  for (const row of sorted) {
    const text = normalizeAsrText(row?.text || "");
    if (!text) continue;
    const previous = result.at(-1);
    const previousText = normalizeAsrText(previous?.text || "");
    const closeToPrevious = previous
      && finiteNumber(row.start, 0) <= finiteNumber(previous.end, 0) + maxGapSeconds;
    if (closeToPrevious && previousText === text) {
      result[result.length - 1] = {
        ...previous,
        end: Math.max(finiteNumber(previous.end, 0), finiteNumber(row.end, 0)),
      };
      continue;
    }
    result.push({ ...row, text });
  }
  return result;
}

export function detectTranscriptionQualityIssue(rows, sourceLanguage, duration = 0) {
  const text = rows.map((row) => row.text || "").join("");
  const normalizedText = normalizeAsrText(text);
  if (!normalizedText.trim()) return "";
  const chineseCount = (normalizedText.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinCount = (normalizedText.match(/[A-Za-z]/g) || []).length;
  if (sourceLanguage === "中文" && normalizedText.length >= 24 && chineseCount / normalizedText.length < 0.18) {
    return "识别结果与中文源语言不匹配，请复查视频音轨、源语言或转写模型。";
  }
  if (sourceLanguage === "英文" && normalizedText.length >= 24 && latinCount / normalizedText.length < 0.35) {
    return "识别结果与英文源语言不匹配，请复查视频音轨、源语言或转写模型。";
  }
  const safeDuration = Number(duration) || 0;
  const expectedMinRows = Math.max(2, Math.floor(safeDuration / 45));
  if (safeDuration >= 90 && rows.length < expectedMinRows) {
    return "长音频返回的分段偏少，请检查音频是否完整，必要时更换转写模型后重试。";
  }
  const minimumTextWeight = Math.max(18, safeDuration / 6);
  if (safeDuration >= 60 && transcriptWeight(normalizedText) < minimumTextWeight) {
    return "长音频返回的文本偏少，请检查音量、音轨完整性、源语言或转写模型。";
  }
  return "";
}
