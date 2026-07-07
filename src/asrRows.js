export function splitTranscriptIntoSentences(text) {
  const phraseRows = splitPhraseSpacedTranscript(text);
  if (phraseRows.length > 1) return phraseRows;

  const clean = normalizeAsrText(text)
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/(而不是我)(?=(如果|但是|可是|不过|然后|所以|你会|我会|我们|他们|这些|那些))/g, "$1\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!clean) return [];
  const chunks = mergeAbbreviationChunks(clean
    .split(/\n+|(?<=[。！？!?；;])\s*|(?<=[A-Za-z]\.)\s+(?=[A-Za-z"“'(\[])/)
    .map((item) => item.trim())
    .filter(Boolean));
  const rows = chunks.flatMap((chunk) => splitLongSentenceChunk(chunk));
  if (rows.length > 1) return rows;
  if (/\s/.test(clean) && /[A-Za-z]/.test(clean)) {
    return splitEnglishTextByReadableLength(clean, maxMergedUnits(clean));
  }
  const maxChars = maxMergedUnits(clean);
  return splitCjkTextByReadableLength(clean, maxChars);
}

const phraseBreakBeforePatterns = [
  "然后", "所以", "但是", "不过", "可是", "因为", "如果", "否则", "虽然", "只是",
  "同时", "并且", "以及", "为了", "接着", "另外", "最后",
  "需要", "应该", "可以", "可能", "其实", "就是", "就像", "那么", "总之", "换句话说",
  "好的", "而是", "而不是", "也要", "系统", "这部分", "源语言", "目标语言", "翻译", "校对窗口", "按钮",
  "是的", "不是",
  "你会", "我会", "我们", "他们", "她们", "它们", "这个", "那个", "这些", "那些", "这里", "那里",
  "上一条", "下一条", "前一条", "后一条",
  "我知道", "我觉得", "我以为", "我想", "我要", "我不", "我希望", "我们先", "我们现在",
  "你知道", "你觉得", "你想", "你要", "你不", "你先", "他是", "她是", "是不是",
];

const phraseStrongBreakBeforePatterns = new Set([
  "然后", "所以", "但是", "不过", "可是", "因为", "如果", "否则", "虽然", "只是",
  "同时", "并且", "以及", "为了", "接着", "另外", "最后",
  "需要", "应该", "可以", "可能", "其实", "就是", "就像", "那么", "总之", "换句话说",
  "好的", "而是", "而不是", "也要", "系统", "这部分", "源语言", "目标语言", "翻译", "校对窗口", "按钮",
  "是的", "不是", "你会", "我会", "我知道", "我觉得", "我以为", "我想", "我要", "我不", "我希望",
  "你知道", "你觉得", "你想", "你要", "你不", "是不是",
]);

const phraseBreakAfterPatterns = [
  "等一下", "等一等", "没关系", "好的", "是的", "不是", "好了", "够了", "死了", "完了", "对吧", "好吗", "知道了",
  "吗", "呢", "吧", "什么",
];

const protectedCjkSplitPairs = new Set([
  "不是", "应该", "可以", "可能", "需要", "目标", "语言", "中文", "英文", "翻译", "字幕", "转写", "校对",
  "尽量", "按钮", "用户", "系统", "模型", "配置", "视频", "音频", "时间", "重叠", "导出", "处理", "修复",
]);

function startsWithPattern(text, patterns) {
  return patterns.find((pattern) => String(text || "").startsWith(pattern)) || "";
}

function endsWithPattern(text, patterns) {
  return patterns.find((pattern) => String(text || "").endsWith(pattern)) || "";
}

function isProtectedCjkPatternBoundary(value, index, pattern) {
  const text = String(value || "");
  if (pattern === "不是" && text.slice(index - 1, index + pattern.length) === "是不是") return true;
  if (pattern === "不是" && text[index - 1] === "而") return true;
  if (pattern === "应该" && text[index - 1] === "不") return true;
  if (pattern === "可以" && text[index - 1] === "不") return true;
  return false;
}

function adjustCjkHardSplitIndex(value, index, maxUnits, minimumUnits) {
  const text = String(value || "");
  if (index <= 0 || index >= text.length) return index;
  const pair = `${text[index - 1] || ""}${text[index] || ""}`;
  if (!protectedCjkSplitPairs.has(pair)) return index;

  const rightIndex = index + 1;
  const rightBefore = text.slice(0, rightIndex).trim();
  const rightAfter = text.slice(rightIndex).trim();
  if (
    transcriptWeight(rightBefore) <= maxUnits + 2
    && transcriptWeight(rightAfter) >= 4
  ) {
    return rightIndex;
  }

  const leftIndex = index - 1;
  const leftBefore = text.slice(0, leftIndex).trim();
  const leftAfter = text.slice(leftIndex).trim();
  if (
    transcriptWeight(leftBefore) >= minimumUnits
    && transcriptWeight(leftAfter) >= 4
  ) {
    return leftIndex;
  }

  return index;
}

function splitPhraseSpacedTranscript(text) {
  const raw = String(text || "").replace(/\r/g, "").trim();
  if (!raw || !/[\u4e00-\u9fa5]/.test(raw) || !/[\u4e00-\u9fa5][ \t]+[\u4e00-\u9fa5A-Za-z0-9《“"']/.test(raw)) return [];
  if (/[。！？!?；;，,、：:]/.test(raw)) return [];
  const rows = raw
    .split(/\n+/)
    .flatMap((line) => splitPhraseSpacedLine(line))
    .flatMap((line) => splitLongSentenceChunk(line))
    .map((line) => normalizeAsrText(line))
    .filter(Boolean);
  return rows.length > 1 ? rows : [];
}

function splitPhraseSpacedLine(line) {
  const chunks = String(line || "")
    .trim()
    .split(/[ \t]+/)
    .map((item) => normalizeAsrText(item))
    .filter(Boolean);
  if (chunks.length < 6) return [];

  const rows = [];
  let current = "";
  const flush = () => {
    const clean = normalizeAsrText(current);
    if (clean) rows.push(clean);
    current = "";
  };

  for (const chunk of chunks) {
    const breakBefore = startsWithPattern(chunk, phraseBreakBeforePatterns);
    const shouldBreakBefore = current
      && breakBefore
      && transcriptWeight(current) >= (phraseStrongBreakBeforePatterns.has(breakBefore) ? 4 : 7);
    if (shouldBreakBefore) flush();

    const candidate = current ? joinAdjacentAsrText(current, chunk) : chunk;
    if (current && transcriptWeight(candidate) > maxMergedUnits(candidate)) {
      flush();
      current = chunk;
    } else {
      current = candidate;
    }

    if (current && endsWithPattern(current, phraseBreakAfterPatterns) && transcriptWeight(current) >= 4) {
      flush();
    }
  }

  flush();
  return rows;
}

const abbreviationBoundaryPattern = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.|(?:\b[A-Z]\.){2,})$/i;

function endsWithProtectedAbbreviation(text) {
  return abbreviationBoundaryPattern.test(String(text || "").trim());
}

function mergeAbbreviationChunks(chunks) {
  const result = [];
  for (const chunk of chunks) {
    if (result.length && endsWithProtectedAbbreviation(result.at(-1))) {
      result[result.length - 1] = `${result.at(-1)} ${chunk}`;
      continue;
    }
    result.push(chunk);
  }
  return result;
}

function splitLongSentenceChunk(text) {
  const clean = String(text || "").trim();
  if (!clean) return [];
  const implicitEnglishParts = splitEnglishImplicitSentenceBoundaries(clean);
  if (implicitEnglishParts.length > 1) {
    return implicitEnglishParts.flatMap((part) => splitLongSentenceChunk(part));
  }
  const implicitParts = splitCjkImplicitSentenceBoundaries(clean);
  if (implicitParts.length > 1) {
    return implicitParts.flatMap((part) => splitLongSentenceChunk(part));
  }
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
    if (isLatinText(value)) {
      result.push(...splitEnglishTextByReadableLength(value, maxUnits));
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

const englishBreakBeforeWords = new Set([
  "and", "but", "because", "so", "if", "when", "while", "where", "which", "who", "then",
  "however", "therefore", "although", "though", "unless",
]);

const englishWeakEndingWords = new Set([
  "a", "an", "the", "and", "or", "but", "because", "that", "which", "who", "to", "of",
  "for", "in", "on", "at", "with", "from", "into", "as", "by",
]);

const englishSentenceStartWords = new Set([
  "i", "you", "he", "she", "it", "we", "they", "this", "that", "these", "those", "there",
  "then", "so", "but", "and", "for", "now",
]);

function cleanEnglishWord(word) {
  return String(word || "").replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, "").toLowerCase();
}

function isCapitalizedEnglishToken(word) {
  return /^[A-Z][A-Za-z0-9']*$/.test(String(word || "").replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ""));
}

function splitEnglishImplicitSentenceBoundaries(value) {
  const clean = String(value || "").trim();
  if (!isLatinText(clean) || /[.!?;:]/.test(clean)) return [clean].filter(Boolean);
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length < 7) return [clean];
  const result = [];
  let current = [];

  words.forEach((word, index) => {
    const currentClean = cleanEnglishWord(word);
    const previousClean = cleanEnglishWord(words[index - 1]);
    const remainingWords = words.length - index;
    const likelySentenceStart = isCapitalizedEnglishToken(word) || (current.length >= 5 && englishSentenceStartWords.has(currentClean));
    const shouldSplit = current.length >= 3
      && remainingWords >= 2
      && englishSentenceStartWords.has(currentClean)
      && likelySentenceStart
      && (isCapitalizedEnglishToken(word) || currentClean === "and" || !englishWeakEndingWords.has(currentClean))
      && !englishWeakEndingWords.has(previousClean);

    if (shouldSplit) {
      result.push(current.join(" "));
      current = [];
    }
    current.push(word);
  });

  if (current.length) result.push(current.join(" "));
  return result.length > 1 ? result : [clean];
}

function splitEnglishTextByReadableLength(value, maxWords) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const limit = Math.max(6, Number(maxWords) || 10);
  const lastChunkLimit = limit + 2;
  const result = [];
  let remaining = words;
  while (remaining.length > lastChunkLimit) {
    const splitIndex = chooseReadableEnglishSplitIndex(remaining, limit);
    result.push(remaining.slice(0, splitIndex).join(" "));
    remaining = remaining.slice(splitIndex);
  }
  if (remaining.length) result.push(remaining.join(" "));
  return result.filter(Boolean);
}

function chooseReadableEnglishSplitIndex(words, maxWords) {
  const minWords = Math.max(4, Math.floor(maxWords * 0.5));
  const upper = Math.min(maxWords, words.length - 1);
  const target = Math.max(minWords, maxWords * 0.78);
  const candidates = [];

  for (let index = minWords; index <= upper; index += 1) {
    const before = words[index - 1] || "";
    const current = words[index] || "";
    const beforeClean = cleanEnglishWord(before);
    const currentClean = cleanEnglishWord(current);
    const tailWords = words.length - index;
    let score = Math.abs(index - target);
    if (/[,.!?;:]$/.test(before)) score -= 7;
    if (englishBreakBeforeWords.has(currentClean)) score -= 4;
    if (currentClean === "and" && tailWords <= 5) score += 10;
    if (englishWeakEndingWords.has(currentClean)) score += 10;
    if (englishWeakEndingWords.has(beforeClean)) score += 8;
    if (tailWords < 4) score += 6;
    candidates.push({ index, score });
  }

  candidates.sort((left, right) => left.score - right.score);
  return candidates[0]?.index || Math.min(maxWords, Math.max(1, words.length - 1));
}

function splitCjkImplicitSentenceBoundaries(text) {
  const value = String(text || "").trim();
  if (!/[\u4e00-\u9fa5]/.test(value) || /[。！？!?；;，,、：:]/.test(value)) return [value].filter(Boolean);
  const boundaryPattern = /(吗|呢|吧|好了|够了|死了|完了|什么|知道了|没关系|是的)(?=(我|你|他|她|它|我们|你们|他们|她们|这个|那个|这些|那些|这里|那里|这叫|但是|可是|不过|然后|所以|如果|否则|因为|同时|另外|最后|接着|欢迎|现在|在))/g;
  const boundaryIndexes = [];
  let match;
  while ((match = boundaryPattern.exec(value)) !== null) {
    const splitIndex = match.index + match[1].length;
    const before = value.slice(0, splitIndex).trim();
    const after = value.slice(splitIndex).trim();
    if (transcriptWeight(before) >= 3 && transcriptWeight(after) >= 3) {
      boundaryIndexes.push(splitIndex);
    }
  }
  const implicitStandaloneStartPatterns = ["这些", "那些", "这叫", "欢迎", "你好"];
  for (const pattern of implicitStandaloneStartPatterns) {
    let index = value.indexOf(pattern);
    while (index > 0) {
      const before = value.slice(0, index).trim();
      const after = value.slice(index).trim();
      if (transcriptWeight(before) >= 4 && transcriptWeight(after) >= 4) {
        boundaryIndexes.push(index);
      }
      index = value.indexOf(pattern, index + pattern.length);
    }
  }
  const contrastBoundaryPattern = /(而不是我)(?=(如果|但是|可是|不过|然后|所以|你会|我会|我们|他们|这些|那些))/g;
  while ((match = contrastBoundaryPattern.exec(value)) !== null) {
    const splitIndex = match.index + match[1].length;
    const before = value.slice(0, splitIndex).trim();
    const after = value.slice(splitIndex).trim();
    if (transcriptWeight(before) >= 5 && transcriptWeight(after) >= 3) {
      boundaryIndexes.push(splitIndex);
    }
  }
  const contrastStartPattern = /(而不是|而是)/g;
  while ((match = contrastStartPattern.exec(value)) !== null) {
    const splitIndex = match.index;
    if (match[1] === "而不是" && value.slice(splitIndex, splitIndex + 4) === "而不是我") continue;
    const before = value.slice(0, splitIndex).trim();
    const after = value.slice(splitIndex).trim();
    if (transcriptWeight(before) >= 5 && transcriptWeight(after) >= 4) {
      boundaryIndexes.push(splitIndex);
    }
  }
  const newQuestionPattern = /(这个|那个|这里|那里)(可以吗|对吗|好吗|是不是|行吗)/g;
  while ((match = newQuestionPattern.exec(value)) !== null) {
    const splitIndex = match.index;
    const before = value.slice(0, splitIndex).trim();
    const after = value.slice(splitIndex).trim();
    if (transcriptWeight(before) >= 5 && transcriptWeight(after) >= 3) {
      boundaryIndexes.push(splitIndex);
    }
  }
  const translationBoundaryPattern = /(中文|英文|普通话|粤语|日文|韩文|法文|德文|西班牙文)(?=(翻译才是|翻译仅|翻译只是|翻译作为))/g;
  while ((match = translationBoundaryPattern.exec(value)) !== null) {
    const splitIndex = match.index + match[1].length;
    const before = value.slice(0, splitIndex).trim();
    const after = value.slice(splitIndex).trim();
    if (transcriptWeight(before) >= 5 && transcriptWeight(after) >= 4) {
      boundaryIndexes.push(splitIndex);
    }
  }
  const sortedIndexes = [...new Set(boundaryIndexes)]
    .filter((index) => index > 0 && index < value.length)
    .sort((left, right) => left - right);
  const result = [];
  let cursor = 0;
  for (const splitIndex of sortedIndexes) {
    const before = value.slice(cursor, splitIndex).trim();
    const after = value.slice(splitIndex).trim();
    if (transcriptWeight(before) >= 3 && transcriptWeight(after) >= 3) {
      result.push(before);
      cursor = splitIndex;
    }
  }
  const tail = value.slice(cursor).trim();
  if (tail) result.push(tail);
  return result.length > 1 ? result : [value];
}

function splitCjkTextByReadableLength(value, maxUnits) {
  const clean = String(value || "").trim();
  if (!clean) return [];
  const result = [];
  let remaining = clean;
  while (transcriptWeight(remaining) > maxUnits) {
    const minimum = Math.max(6, Math.floor(maxUnits * 0.45));
    if (transcriptWeight(remaining) <= maxUnits + 1) break;
    const splitIndex = chooseReadableCjkSplitIndex(remaining, maxUnits, minimum);
    const tailLength = transcriptWeight(remaining.slice(splitIndex).trim());
    if (tailLength > 0 && tailLength < 5 && transcriptWeight(remaining) <= maxUnits + tailLength) break;
    const part = remaining.slice(0, splitIndex).trim();
    if (part) result.push(part);
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

function chooseReadableCjkSplitIndex(value, maxUnits, minimumUnits) {
  const candidates = [];
  const addCandidate = (index, weight = 1, minUnits = minimumUnits) => {
    if (index <= 0 || index >= value.length) return;
    const beforeUnits = transcriptWeight(value.slice(0, index).trim());
    const afterUnits = transcriptWeight(value.slice(index).trim());
    if (beforeUnits < minUnits || afterUnits < 4) return;
    if (beforeUnits > maxUnits + 4) return;
    const target = Math.max(minimumUnits, maxUnits * 0.68);
    candidates.push({ index, score: Math.abs(beforeUnits - target) - weight });
  };

  for (const pattern of phraseBreakBeforePatterns) {
    let index = value.indexOf(pattern);
    while (index > 0) {
      if (isProtectedCjkPatternBoundary(value, index, pattern)) {
        index = value.indexOf(pattern, index + pattern.length);
        continue;
      }
      const isStrongBreak = phraseStrongBreakBeforePatterns.has(pattern);
      addCandidate(index, isStrongBreak ? 7 : 1.5, isStrongBreak ? Math.max(4, minimumUnits - 2) : minimumUnits);
      index = value.indexOf(pattern, index + pattern.length);
    }
  }

  for (const pattern of phraseBreakAfterPatterns) {
    let index = value.indexOf(pattern);
    while (index >= 0) {
      addCandidate(index + pattern.length, 5, Math.max(3, minimumUnits - 3));
      index = value.indexOf(pattern, index + pattern.length);
    }
  }

  for (let index = 1; index < value.length; index += 1) {
    if (/[，,、：:]/.test(value[index - 1])) addCandidate(index, 3);
  }

  if (candidates.length) {
    candidates.sort((left, right) => left.score - right.score);
    return candidates[0].index;
  }

  return chooseHardSplitIndex(value, maxUnits, minimumUnits);
}

function chooseHardSplitIndex(value, maxUnits, minimumUnits) {
  let splitIndex = -1;
  for (let index = 1; index < value.length; index += 1) {
    if (transcriptWeight(value.slice(0, index).trim()) <= maxUnits) {
      splitIndex = index;
      continue;
    }
    break;
  }
  if (splitIndex < 0) return Math.min(value.length - 1, Math.max(1, maxUnits));
  const originalSplit = splitIndex;
  while (
    splitIndex > 1
    && /[A-Za-z0-9]/.test(value[splitIndex - 1] || "")
    && /[A-Za-z0-9]/.test(value[splitIndex] || "")
  ) {
    splitIndex -= 1;
  }
  if (transcriptWeight(value.slice(0, splitIndex).trim()) < minimumUnits) return originalSplit;
  return adjustCjkHardSplitIndex(value, splitIndex, maxUnits, minimumUnits);
}

export function transcriptWeight(text) {
  const value = String(text || "").trim();
  if (!value) return 1;
  const cjkCount = (value.match(/[\u4e00-\u9fa5]/g) || []).length;
  const latinWords = (value.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g) || []).length;
  if (cjkCount && latinWords) return Math.max(cjkCount + latinWords, 1);
  if (!cjkCount && /\s/.test(value) && /[A-Za-z]/.test(value)) return Math.max(value.split(/\s+/).filter(Boolean).length, 1);
  return Math.max(value.length, 1);
}

export function normalizeAsrText(text) {
  const value = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/([\u4e00-\u9fa5])[ \t]+([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/([\u4e00-\u9fa5])\s+([《“"（(])/g, "$1$2")
    .replace(/([《“"（(])\s+/g, "$1")
    .replace(/\s+([》”"）)])/g, "$1")
    .replace(/([》”"）)])\s+([\u4e00-\u9fa5])/g, "$1$2")
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

function splitTimedTextRow(row, idPrefix = "asr-row") {
  const text = normalizeAsrText(row?.text || "");
  if (!text) return [];
  const sentences = splitTranscriptIntoSentences(text);
  if (sentences.length <= 1 && transcriptWeight(text) <= maxMergedUnits(text)) {
    return [{ ...row, text }];
  }

  const start = finiteNumber(row?.start, 0);
  const fallbackEnd = start + estimateSpeechDurationForText(text);
  const end = Math.max(start + 0.5, finiteNumber(row?.end, fallbackEnd));
  const duration = end - start;
  const totalWeight = sentences.reduce((sum, sentence) => sum + transcriptWeight(sentence), 0) || sentences.length || 1;
  const minimumSegmentDuration = Math.min(1.1, Math.max(0.35, (duration / Math.max(sentences.length, 1)) * 0.45));
  let cursor = start;

  return sentences.map((sentence, index) => {
    const isLast = index === sentences.length - 1;
    const remainingSegments = sentences.length - index - 1;
    const proportional = duration * (transcriptWeight(sentence) / totalWeight);
    const segmentDuration = isLast ? end - cursor : Math.max(proportional, minimumSegmentDuration);
    const latestEnd = Math.max(cursor + 0.3, end - remainingSegments * minimumSegmentDuration);
    const rowEnd = isLast ? end : Math.min(latestEnd, cursor + segmentDuration);
    const next = {
      ...row,
      id: index === 0 ? row.id : `${idPrefix}-${Date.now()}-${index}`,
      start: cursor,
      end: Math.max(cursor + 0.35, rowEnd),
      text: sentence,
      translation: "",
    };
    cursor = next.end;
    return next;
  }).filter((item) => item.text.trim());
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
      rows.push(...splitTimedTextRow({
        id: `asr-${Date.now()}-${rows.length}`,
        start,
        end,
        speaker: "未标注",
        text,
        translation: "",
      }, "asr-word"));
    }
    group = [];
  };
  words.forEach((word) => {
    group.push(word);
    const text = joinAsrTokens(group);
    const duration = wordEnd(group.at(-1)) - wordStart(group[0]);
    const units = transcriptWeight(text);
    const sentenceBoundary = isSentenceClosed(text) && !endsWithProtectedAbbreviation(text);
    if (sentenceBoundary || units >= maxMergedUnits(text) || duration >= 4.8) flush();
  });
  flush();
  return rows;
}

function rawSegmentText(segment) {
  return String(segment?.text ?? segment?.transcript ?? segment?.sentence ?? "").trim();
}

function segmentText(segment) {
  return normalizeAsrText(rawSegmentText(segment));
}

function rowsFromSegment(segment, segmentIndex) {
  const rawText = rawSegmentText(segment);
  const text = normalizeAsrText(rawText);
  if (!text) return [];
  const start = finiteNumber(segment?.start ?? segment?.start_time ?? segment?.startTime, segmentIndex * 3);
  const inferredEnd = start + Math.max(transcriptWeight(text) * 0.22, 2);
  const rawEnd = finiteNumber(segment?.end ?? segment?.end_time ?? segment?.endTime, inferredEnd);
  const end = Math.max(start + 0.5, rawEnd);
  const speaker = segment.speaker || segment.speaker_label || "未标注";
  const sentences = splitTranscriptIntoSentences(rawText);
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
  return /[A-Za-z]/.test(text) && /\s/.test(text) && !/[\u4e00-\u9fa5]/.test(text);
}

function maxMergedUnits(text) {
  return isLatinText(text) ? 10 : 16;
}

function estimateSpeechDurationForText(text) {
  const clean = normalizeAsrText(text);
  if (!clean) return 0;
  const units = transcriptWeight(clean);
  const secondsPerUnit = isLatinText(clean) ? 0.42 : 0.24;
  return Math.max(1.1, units * secondsPerUnit);
}

function resolveUntimedTranscriptDuration(sentences, fallbackDuration = 0) {
  const estimated = sentences.reduce((sum, sentence) => sum + estimateSpeechDurationForText(sentence), 0);
  const sentenceFloor = Math.max(sentences.length * 1.2, 1.5);
  const estimatedDuration = Math.max(estimated, sentenceFloor);
  const mediaDuration = Number(fallbackDuration) > 0 ? Number(fallbackDuration) : 0;
  if (!mediaDuration) return estimatedDuration;
  if (mediaDuration <= estimatedDuration * 1.75) return mediaDuration;
  return estimatedDuration;
}

function estimateRowsSpeechDuration(rows) {
  const validRows = Array.isArray(rows) ? rows.filter((row) => normalizeAsrText(row?.text || "")) : [];
  if (!validRows.length) return 0;
  const estimated = validRows.reduce((sum, row) => sum + estimateSpeechDurationForText(row.text), 0);
  return Math.max(estimated, validRows.length * 1.2, 1.5);
}

function scaleRowsToDuration(rows, targetDuration) {
  const maxEnd = Math.max(...rows.map((row) => finiteNumber(row?.end, 0)), 0);
  if (!rows.length || !maxEnd || !Number.isFinite(targetDuration) || targetDuration <= 0) return rows;
  const factor = targetDuration / maxEnd;
  return rows.map((row, index) => {
    const start = Math.max(0, finiteNumber(row.start, 0) * factor);
    const rawEnd = Math.max(start + 0.35, finiteNumber(row.end, start + 0.35) * factor);
    return {
      ...row,
      start,
      end: index === rows.length - 1 ? Math.max(start + 0.5, targetDuration) : rawEnd,
    };
  });
}

function sanitizeTimedRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => {
      const text = normalizeAsrText(row?.text || "");
      if (!text) return null;
      const start = Math.max(0, finiteNumber(row?.start, index * 1.2));
      const rawEnd = finiteNumber(row?.end, start + estimateSpeechDurationForText(text));
      return {
        ...row,
        start,
        end: Math.max(start + 0.35, rawEnd),
        text,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const startDiff = finiteNumber(left.start, 0) - finiteNumber(right.start, 0);
      if (startDiff) return startDiff;
      return finiteNumber(left.end, 0) - finiteNumber(right.end, 0);
    });
}

export function repairAsrTimeline(rows) {
  const repaired = sanitizeTimedRows(rows);
  if (repaired.length <= 1) return repaired;

  for (let index = 1; index < repaired.length; index += 1) {
    const previous = repaired[index - 1];
    const current = repaired[index];
    const previousEnd = finiteNumber(previous.end, finiteNumber(previous.start, 0) + 0.35);
    const currentStart = finiteNumber(current.start, previousEnd);
    if (currentStart >= previousEnd) continue;

    const previousStart = finiteNumber(previous.start, 0);
    const currentEnd = Math.max(currentStart + 0.35, finiteNumber(current.end, currentStart + 0.35));
    const boundary = Math.max(
      previousStart + 0.35,
      Math.min(currentEnd - 0.35, (currentStart + previousEnd) / 2),
    );

    if (Number.isFinite(boundary) && boundary > previousStart && boundary < currentEnd) {
      previous.end = boundary;
      current.start = boundary;
      current.end = Math.max(current.start + 0.35, currentEnd);
      continue;
    }

    current.start = previousEnd;
    current.end = Math.max(current.start + 0.35, currentEnd);
  }

  return repaired;
}

function repairCoarseSegmentTiming(rows, fallbackDuration = 0) {
  const validRows = Array.isArray(rows) ? rows.filter((row) => normalizeAsrText(row?.text || "")) : [];
  if (!validRows.length) return [];
  const maxEnd = Math.max(...validRows.map((row) => finiteNumber(row.end, 0)), 0);
  if (!maxEnd) return validRows;
  const estimatedDuration = estimateRowsSpeechDuration(validRows);
  const mediaDuration = Number(fallbackDuration) > 0 ? Number(fallbackDuration) : 0;
  const estimatedTargetDuration = mediaDuration ? Math.min(estimatedDuration, mediaDuration) : estimatedDuration;

  if (mediaDuration && maxEnd > mediaDuration * 20) {
    return repairAsrTimeline(scaleRowsToDuration(validRows, mediaDuration));
  }
  if (mediaDuration && maxEnd > mediaDuration * 1.75 && mediaDuration <= estimatedDuration * 2.2) {
    return repairAsrTimeline(scaleRowsToDuration(validRows, mediaDuration));
  }
  if (estimatedDuration && maxEnd > estimatedDuration * 2.5) {
    return repairAsrTimeline(scaleRowsToDuration(validRows, estimatedDuration));
  }
  if (estimatedDuration > maxEnd * 1.65 && (!mediaDuration || maxEnd < mediaDuration * 0.75)) {
    return repairAsrTimeline(scaleRowsToDuration(validRows, estimatedTargetDuration));
  }
  return repairAsrTimeline(validRows);
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
  if (/[\u4e00-\u9fa5，。！？；：、]$/.test(previous) && /^[\u4e00-\u9fa5，。！？；：、]/.test(current)) return `${previous}${current}`;
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
      && !isSentenceClosed(previous.text)
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
    const rows = result.segments.flatMap((segment, index) => rowsFromSegment(segment, index));
    return repairCoarseSegmentTiming(rows, fallbackDuration);
  }
  if (Array.isArray(result?.words) && result.words.length) {
    const rows = repairAsrTimeline(groupWordsToRows(result.words));
    if (rows.length) return rows;
  }
  const sentences = splitTranscriptIntoSentences(result?.text || result?.transcript || "");
  if (!sentences.length) return [];
  const duration = resolveUntimedTranscriptDuration(sentences, fallbackDuration);
  const totalWeight = sentences.reduce((sum, item) => sum + transcriptWeight(item), 0) || sentences.length || 1;
  const minimumSegmentDuration = Math.min(1.2, Math.max(0.45, (duration / Math.max(sentences.length, 1)) * 0.55));
  let cursor = 0;
  return repairAsrTimeline(sentences.map((text, index) => {
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
  }));
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

function stripOverlapToken(value) {
  return String(value || "")
    .replace(/^[^A-Za-z0-9\u4e00-\u9fa5']+|[^A-Za-z0-9\u4e00-\u9fa5']+$/g, "")
    .toLowerCase();
}

function overlapWords(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .map((word) => stripOverlapToken(word))
    .filter(Boolean);
}

function trimLatinRepeatedBoundaryPrefix(previousText, currentText) {
  const previousParts = String(previousText || "").trim().split(/\s+/).filter(Boolean);
  const currentParts = String(currentText || "").trim().split(/\s+/).filter(Boolean);
  const previousWords = previousParts.map((word) => stripOverlapToken(word));
  const currentWords = currentParts.map((word) => stripOverlapToken(word));
  const maxOverlap = Math.min(previousWords.length, currentWords.length, 10);

  for (let size = maxOverlap; size >= 3; size -= 1) {
    const previousSlice = previousWords.slice(-size);
    const currentSlice = currentWords.slice(0, size);
    if (!previousSlice.every((word, index) => word && word === currentSlice[index])) continue;
    return normalizeAsrText(currentParts.slice(size).join(" ").replace(/^[,.;:!?，。！？；：、\s]+/, ""));
  }
  return null;
}

function compactOverlapText(text) {
  return normalizeAsrText(text)
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "")
    .toLowerCase();
}

function removeCompactPrefix(text, compactPrefix) {
  let cursor = 0;
  let matched = "";
  const source = String(text || "");
  while (cursor < source.length && matched.length < compactPrefix.length) {
    const char = source[cursor];
    const normalized = compactOverlapText(char);
    if (normalized) {
      if (normalized !== compactPrefix[matched.length]) return null;
      matched += normalized;
    }
    cursor += 1;
  }
  if (matched !== compactPrefix) return null;
  return normalizeAsrText(source.slice(cursor).replace(/^[,.;:!?，。！？；：、\s]+/, ""));
}

function trimCompactRepeatedBoundaryPrefix(previousText, currentText) {
  const previous = compactOverlapText(previousText);
  const current = compactOverlapText(currentText);
  const maxOverlap = Math.min(previous.length, current.length, 24);
  for (let size = maxOverlap; size >= 4; size -= 1) {
    const overlap = previous.slice(-size);
    if (current.slice(0, size) !== overlap) continue;
    return removeCompactPrefix(currentText, overlap);
  }
  return null;
}

function trimRepeatedBoundaryPrefix(previousText, currentText) {
  const previous = normalizeAsrText(previousText);
  const current = normalizeAsrText(currentText);
  if (!previous || !current) return current;
  if (previous === current) return "";

  const previousWords = overlapWords(previous);
  const currentWords = overlapWords(current);
  if (previousWords.length >= 3 && currentWords.length >= 3) {
    const latinTrimmed = trimLatinRepeatedBoundaryPrefix(previous, current);
    if (latinTrimmed !== null) return latinTrimmed;
  }

  const compactTrimmed = trimCompactRepeatedBoundaryPrefix(previous, current);
  if (compactTrimmed !== null) return compactTrimmed;
  return current;
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
    if (closeToPrevious) {
      const trimmedText = trimRepeatedBoundaryPrefix(previousText, text);
      if (trimmedText !== text) {
        if (!trimmedText) {
          result[result.length - 1] = {
            ...previous,
            end: Math.max(finiteNumber(previous.end, 0), finiteNumber(row.end, 0)),
          };
          continue;
        }
        result.push({ ...row, text: trimmedText });
        continue;
      }
    }
    result.push({ ...row, text });
  }
  return repairAsrTimeline(result);
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
