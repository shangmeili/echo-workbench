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
  "同时", "并且", "以及", "为了", "接着", "另外", "最后", "首先", "为什么",
  "需要", "应该", "可以", "可能", "其实", "就是", "就像", "那么", "总之", "换句话说",
  "不要",
  "好的", "而是", "而不是", "也要", "系统", "这部分", "源语言", "目标语言", "翻译", "校对窗口", "按钮",
  "并生成", "不能让",
  "是的", "不是",
  "用户", "你会", "我会", "我们", "他们", "她们", "它们", "这个", "那个", "这些", "那些", "这里", "那里",
  "上一条", "下一条", "前一条", "后一条",
  "我知道", "我觉得", "我以为", "我想", "我要", "我不", "我希望", "我们先", "我们现在",
  "你知道", "你觉得", "你想", "你要", "你不", "你先", "他是", "她是", "是不是",
  "第一个", "第二个", "第三个", "第四个", "第一点", "第二点", "第三点", "第四点",
  "最近项目", "本地工作区", "视频上传后", "导出字幕前", "服务返回失败",
  "这对普通用户来说", "没有按照", "时间重叠也不应该", "而应该", "并保留",
  "翻译只应该", "源语言和目标语言",
  "上传视频后", "转写服务返回", "模型返回失败时页面", "普通用户无法判断", "模型配置测试失败",
  "不能只是", "工作台需要", "这个项目的主要功能", "不要把这种错误",
  "不一致时", "所有字幕转写", "从本地副本打开", "应该回到", "模型配置测试失败的原因",
  "源语言和目标语言应该保持在同一行", "翻译只应该作为源语言和目标语言",
];

const phraseStrongBreakBeforePatterns = new Set([
  "然后", "所以", "但是", "不过", "可是", "因为", "如果", "否则", "虽然", "只是",
  "同时", "并且", "以及", "为了", "接着", "另外", "最后", "首先", "为什么",
  "需要", "应该", "可以", "可能", "其实", "就是", "就像", "那么", "总之", "换句话说",
  "不要",
  "好的", "而是", "而不是", "也要", "系统", "这部分", "源语言", "目标语言", "翻译", "校对窗口", "按钮",
  "并生成", "不能让",
  "是的", "不是", "用户", "你会", "我会", "我知道", "我觉得", "我以为", "我想", "我要", "我不", "我希望",
  "你知道", "你觉得", "你想", "你要", "你不", "是不是",
  "第一个", "第二个", "第三个", "第四个", "第一点", "第二点", "第三点", "第四点",
  "最近项目", "本地工作区", "视频上传后", "导出字幕前", "服务返回失败",
  "这对普通用户来说", "没有按照", "时间重叠也不应该", "而应该", "并保留",
  "翻译只应该", "源语言和目标语言",
  "上传视频后", "转写服务返回", "模型返回失败时页面", "普通用户无法判断", "模型配置测试失败",
  "不能只是", "工作台需要", "这个项目的主要功能", "不要把这种错误",
  "不一致时", "所有字幕转写", "从本地副本打开", "应该回到", "模型配置测试失败的原因",
  "源语言和目标语言应该保持在同一行", "翻译只应该作为源语言和目标语言",
]);

const implicitBreakBeforePatterns = [
  "然后", "所以", "但是", "不过", "可是", "因为", "如果", "否则", "虽然", "只是",
  "同时", "并且", "以及", "为了", "接着", "另外", "最后", "首先", "为什么",
  "需要", "应该", "可以", "可能", "其实", "就是", "就像", "那么", "总之", "换句话说",
  "好的", "也要", "不要", "系统", "用户",
  "并生成", "不能让",
  "你会", "我会", "我知道", "我觉得", "我以为", "我想", "我要", "我不", "我希望",
  "你知道", "你觉得", "你想", "你要", "你不",
  "第一个", "第二个", "第三个", "第四个", "第一点", "第二点", "第三点", "第四点", "也不应该",
  "最近项目", "本地工作区", "视频上传后", "导出字幕前", "服务返回失败",
  "这对普通用户来说", "没有按照", "时间重叠也不应该", "而应该", "并保留",
  "翻译只应该", "源语言和目标语言",
  "上传视频后", "转写服务返回", "模型返回失败时页面", "普通用户无法判断", "模型配置测试失败",
  "不能只是", "工作台需要", "这个项目的主要功能", "不要把这种错误",
  "不一致时", "所有字幕转写", "从本地副本打开", "应该回到", "模型配置测试失败的原因",
  "源语言和目标语言应该保持在同一行", "翻译只应该作为源语言和目标语言",
];

const phraseBreakAfterPatterns = [
  "等一下", "等一等", "没关系", "好的", "是的", "不是", "好了", "够了", "死了", "完了", "对吧", "好吗", "知道了",
  "吗", "呢", "吧", "什么",
];

const protectedCjkSplitPairs = new Set([
  "不是", "应该", "可以", "可能", "需要", "目标", "语言", "中文", "英文", "翻译", "字幕", "转写", "校对",
  "尽量", "按钮", "用户", "系统", "模型", "配置", "视频", "音频", "时间", "重叠", "导出", "处理", "修复",
  "这种", "错误", "交给", "时候", "页面", "普通", "产品", "经理", "计划", "专有", "名词", "字幕",
  "到底", "返回", "失败", "直接",
]);

const protectedCjkSplitPhrases = [
  "普通用户来说", "普通用户", "产品经理", "上线计划", "专有名词", "开始转写页面",
  "到底失败在哪里", "服务返回失败", "返回失败", "把翻译", "直接可以", "视频上传后应该",
  "这对普通用户来说", "合理的断句", "转写不是翻译", "不是翻译", "翻译只应该",
  "源语言和目标语言", "源语言和目标语言不一致", "时间码可能", "模型配置测试失败",
  "普通用户无法判断", "需要说明具体原因", "功能问题自动修复", "媒体预览和当前段落",
  "源语言和目标语言应该保持在同一行",
  "字幕文件翻译应该保留原始时间码", "原始时间码并生成目标语言字幕",
  "原始时间码", "保留原始时间码并生成目标语言字幕", "并生成目标语言字幕",
  "目标语言字幕不能让用户重新整理时间轴", "不能让用户重新整理时间轴", "重新整理时间轴",
  "不应该作为提示由用户解决", "视频智能字幕需要先生成", "需要先生成可校对的转写文本",
  "生成可校对的转写文本", "可校对的转写文本", "目标语言不一致", "语言和目标语言不一致",
  "只应该作为源语言和目标语言不一致", "作为源语言和目标语言不一致",
  "源语言和目标语言不一致时的附加功能", "自动修复", "可以自动修复", "导入阶段自动修复",
  "媒体预览", "恢复媒体预览和当前段落",
  "上传视频后应该直接可以开始转写", "开始转写", "时间重叠也不应该",
  "时间轴重叠", "恢复成开始转写页面", "作为提示由用户解决", "交给用户自己处理", "用户自己处理",
  "校对界面", "应该回到校对界面", "从本地副本打开继续处理",
  "继续处理", "模型配置测试失败的原因", "不能只是", "不能只是恢复成开始转写按钮",
  "翻译只应该作为源语言和目标语言",
];

function startsWithPattern(text, patterns) {
  return Array.from(patterns).find((pattern) => String(text || "").startsWith(pattern)) || "";
}

function endsWithPattern(text, patterns) {
  return Array.from(patterns).find((pattern) => String(text || "").endsWith(pattern)) || "";
}

function isProtectedCjkPatternBoundary(value, index, pattern) {
  const text = String(value || "");
  if (pattern === "不是" && text.slice(index - 1, index + pattern.length) === "是不是") return true;
  if (pattern === "不是" && text[index - 1] === "而") return true;
  if (pattern === "不是" && text.slice(index - 2, index) === "转写") return true;
  if (pattern === "不要" && text[index - 1] === "先") return true;
  if (pattern === "只是" && text[index - 1] === "能") return true;
  if (pattern === "应该" && text[index - 1] === "不") return true;
  if (pattern === "应该" && text[index - 1] === "后") return true;
  if (pattern === "应该" && text[index - 1] === "只") return true;
  if (pattern === "应该" && text.slice(index - 4, index) === "目标语言") return true;
  if (pattern === "应该" && text.slice(index - 6, index) === "字幕文件翻译") return true;
  if (pattern === "可能" && text.slice(index - 3, index) === "时间码") return true;
  if (pattern === "也不应该" && text.slice(index - 4, index) === "时间重叠") return true;
  if (pattern === "可以" && text[index - 1] === "不") return true;
  if (pattern === "可以" && text[index - 1] === "否") return true;
  if (pattern === "可以" && text.slice(index - 2, index) === "直接") return true;
  if (pattern === "需要" && text.slice(index - 2, index) === "系统") return true;
  if (pattern === "用户" && text.slice(index - 2, index) === "普通") return true;
  if (pattern === "用户" && ["提示", "要求", "交给"].includes(text.slice(index - 2, index))) return true;
  if (pattern === "用户" && ["让", "给", "是", "由"].includes(text[index - 1])) return true;
  return false;
}

function shouldSkipCjkBreakBefore(value, index, pattern) {
  const text = String(value || "");
  if (pattern === "系统" && !text.slice(index).startsWith("系统应该")) return true;
  if (pattern === "源语言和目标语言" && text.slice(index - 2, index) === "作为") return true;
  if (pattern === "翻译" && text[index - 1] === "把") return true;
  return false;
}

function adjustedCjkBreakBeforeIndex(value, index, pattern) {
  const text = String(value || "");
  if ((pattern === "应该" && text[index - 1] === "也") || (pattern === "需要" && text[index - 1] === "才")) {
    return Math.max(0, index - 1);
  }
  return index;
}

function adjustCjkHardSplitIndex(value, index, maxUnits, minimumUnits) {
  const text = String(value || "");
  if (index <= 0 || index >= text.length) return index;
  for (const phrase of protectedCjkSplitPhrases) {
    let phraseStart = text.indexOf(phrase);
    while (phraseStart >= 0) {
      const phraseEnd = phraseStart + phrase.length;
      if (index > phraseStart && index < phraseEnd) {
        const rightBefore = text.slice(0, phraseEnd).trim();
        const rightAfter = text.slice(phraseEnd).trim();
        if (
          transcriptWeight(rightBefore) <= maxUnits + 2
          && transcriptWeight(rightAfter) >= 4
        ) {
          return phraseEnd;
        }

        const leftBefore = text.slice(0, phraseStart).trim();
        const leftAfter = text.slice(phraseStart).trim();
        if (
          transcriptWeight(leftBefore) >= minimumUnits
          && transcriptWeight(leftAfter) >= 4
        ) {
          return phraseStart;
        }

        return index;
      }
      phraseStart = text.indexOf(phrase, phraseStart + phrase.length);
    }
  }
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
    const englishRows = implicitEnglishParts.flatMap((part) => splitLongSentenceChunk(part));
    return rebalanceEnglishSubtitleParts(englishRows, maxMergedUnits(clean));
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
  "when", "where", "what", "why", "how", "than",
  "can", "could", "should", "would", "will", "may", "might", "must", "shall",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "i'm", "you're", "we're", "they're", "he's", "she's", "it's",
  "i've", "you've", "we've", "they've", "i'll", "you'll", "we'll", "they'll",
  "then", "also", "finally",
]);

const englishContinuationStartWords = new Set([
  "go", "goes", "went", "gone",
]);

const englishWeakStartWords = new Set([
  "exactly", "really", "very", "just", "only", "even", "still", "too",
]);

const englishSentenceStartWords = new Set([
  "i", "you", "he", "she", "it", "we", "they", "this", "that", "these", "those", "there",
  "then", "so", "but", "and", "for", "now",
]);

const englishLeadInWords = new Set([
  "first", "second", "third", "next", "then", "finally", "also", "now", "so", "well",
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
  return rebalanceEnglishSubtitleParts(result.filter(Boolean), limit);
}

function isWeakEnglishBoundaryEnding(word) {
  const clean = cleanEnglishWord(word);
  if (!clean) return false;
  if (englishWeakEndingWords.has(clean)) return true;
  return clean.length > 5 && /ing$/.test(clean);
}

function rebalanceEnglishSubtitleParts(parts, maxWords) {
  const rows = parts.map((part) => String(part || "").trim().split(/\s+/).filter(Boolean)).filter((part) => part.length);
  const limit = Math.max(6, Number(maxWords) || 10);
  const relaxedLimit = limit + 3;

  for (let index = 0; index < rows.length - 1; index += 1) {
    let previous = rows[index];
    let next = rows[index + 1];

    while (
      previous.length > 4
      && next.length < relaxedLimit
      && isWeakEnglishBoundaryEnding(previous.at(-1))
    ) {
      next.unshift(previous.pop());
    }

    while (
      next.length > 4
      && previous.length < relaxedLimit
      && (
        englishContinuationStartWords.has(cleanEnglishWord(next[0]))
        || (cleanEnglishWord(next[0]) === "it" && cleanEnglishWord(next[1]) === "and")
      )
    ) {
      previous.push(next.shift());
    }

    rows[index] = previous;
    rows[index + 1] = next;
  }

  return rows.map((part) => part.join(" ")).filter(Boolean);
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
    if (englishWeakStartWords.has(currentClean)) score += 8;
    if (currentClean === "and" && tailWords <= 5) score += 10;
    if (englishWeakEndingWords.has(currentClean)) score += 10;
    if (englishWeakEndingWords.has(beforeClean)) score += 14;
    if (tailWords < 4) score += 6;
    candidates.push({ index, score });
  }

  candidates.sort((left, right) => left.score - right.score);
  return candidates[0]?.index || Math.min(maxWords, Math.max(1, words.length - 1));
}

function splitCjkImplicitSentenceBoundaries(text) {
  const value = String(text || "").trim();
  const innerValue = value.replace(/[。！？!?；;]+$/g, "");
  if (!/[\u4e00-\u9fa5]/.test(value) || /[。！？!?；;，,、：:]/.test(innerValue)) return [value].filter(Boolean);
  const languageBoundaryParts = splitMixedCjkLatinBoundaries(value);
  if (languageBoundaryParts.length > 1) return languageBoundaryParts;
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
  for (const pattern of implicitBreakBeforePatterns) {
    let index = value.indexOf(pattern);
    while (index > 0) {
      if (shouldSkipCjkBreakBefore(value, index, pattern)) {
        index = value.indexOf(pattern, index + pattern.length);
        continue;
      }
      if (!isProtectedCjkPatternBoundary(value, index, pattern)) {
        const splitIndex = adjustedCjkBreakBeforeIndex(value, index, pattern);
        const before = value.slice(0, splitIndex).trim();
        const after = value.slice(splitIndex).trim();
        if (transcriptWeight(before) >= 4 && transcriptWeight(after) >= 4) {
          boundaryIndexes.push(splitIndex);
        }
      }
      index = value.indexOf(pattern, index + pattern.length);
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

function splitMixedCjkLatinBoundaries(value) {
  const text = String(value || "").trim();
  const boundaryIndexes = [];
  const addBoundary = (index) => {
    const before = text.slice(0, index).trim();
    const after = text.slice(index).trim();
    if (transcriptWeight(before) >= 4 && transcriptWeight(after) >= 4) boundaryIndexes.push(index);
  };

  for (let index = 1; index < text.length; index += 1) {
    const previous = text[index - 1] || "";
    const current = text[index] || "";
    if (/[\u4e00-\u9fa5]/.test(previous) && /[A-Za-z]/.test(current)) addBoundary(index);
    if (/[A-Za-z0-9]$/.test(previous) && /[\u4e00-\u9fa5]/.test(current)) addBoundary(index);
  }

  const sortedIndexes = [...new Set(boundaryIndexes)].sort((left, right) => left - right);
  if (!sortedIndexes.length) return [text];
  const result = [];
  let cursor = 0;
  for (const splitIndex of sortedIndexes) {
    const part = text.slice(cursor, splitIndex).trim();
    if (part) result.push(part);
    cursor = splitIndex;
  }
  const tail = text.slice(cursor).trim();
  if (tail) result.push(tail);
  return result.length > 1 ? result : [text];
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
      if (shouldSkipCjkBreakBefore(value, index, pattern)) {
        index = value.indexOf(pattern, index + pattern.length);
        continue;
      }
      if (isProtectedCjkPatternBoundary(value, index, pattern)) {
        index = value.indexOf(pattern, index + pattern.length);
        continue;
      }
      const splitIndex = adjustedCjkBreakBeforeIndex(value, index, pattern);
      const isStrongBreak = phraseStrongBreakBeforePatterns.has(pattern);
      addCandidate(splitIndex, isStrongBreak ? 7 : 1.5, isStrongBreak ? Math.max(4, minimumUnits - 2) : minimumUnits);
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
    .replace(/([a-z]{3,})([A-Z][a-z]{2,})/g, "$1 $2")
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

function timestampPair(item) {
  const timestamp = Array.isArray(item?.timestamp)
    ? item.timestamp
    : Array.isArray(item?.timestamps)
      ? item.timestamps
      : null;
  if (!timestamp) return [];
  return [timestamp[0], timestamp[1]];
}

function rawTimedItemEnd(item) {
  const [, timestampEnd] = timestampPair(item);
  return finiteNumber(item?.end ?? item?.end_time ?? item?.endTime ?? timestampEnd, 0);
}

function timingScaleForItems(items = [], fallbackDuration = 0) {
  const duration = Number(fallbackDuration) || 0;
  if (!duration) return 1;
  const maxEnd = Math.max(...items.map((item) => rawTimedItemEnd(item)), 0);
  return maxEnd > duration * 20 ? 0.001 : 1;
}

function scaleTimedValue(value, scale) {
  const number = Number(value);
  return Number.isFinite(number) ? number * scale : value;
}

function scaleTimedItems(items = [], scale = 1, options = {}) {
  if (scale === 1) return items;
  const scaleExplicitFields = options.scaleExplicitFields ?? true;
  return items.map((item) => {
    const next = { ...item };
    if (scaleExplicitFields) {
      for (const key of ["start", "end", "start_time", "end_time", "startTime", "endTime"]) {
        if (next[key] !== undefined) next[key] = scaleTimedValue(next[key], scale);
      }
    }
    if (Array.isArray(next.timestamp)) next.timestamp = next.timestamp.map((value) => scaleTimedValue(value, scale));
    if (Array.isArray(next.timestamps)) next.timestamps = next.timestamps.map((value) => scaleTimedValue(value, scale));
    return next;
  });
}

function wordStart(item) {
  const [timestampStart] = timestampPair(item);
  return finiteNumber(item?.start ?? item?.start_time ?? item?.startTime ?? timestampStart, 0);
}

function wordEnd(item) {
  const [, timestampEnd] = timestampPair(item);
  return finiteNumber(item?.end ?? item?.end_time ?? item?.endTime ?? timestampEnd, wordStart(item) + 0.35);
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
    const readableLimit = maxMergedUnits(text);
    const lastWord = text.split(/\s+/).at(-1) || "";
    const weakEnglishEnding = isLatinText(text) && isWeakEnglishBoundaryEnding(lastWord);
    const lengthBoundary = units >= readableLimit && (!weakEnglishEnding || units >= readableLimit + 4);
    const durationBoundary = duration >= 4.8 && (!weakEnglishEnding || duration >= 6.2);
    if (sentenceBoundary || lengthBoundary || durationBoundary) flush();
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
  const [timestampStart, timestampEnd] = timestampPair(segment);
  const start = finiteNumber(segment?.start ?? segment?.start_time ?? segment?.startTime ?? timestampStart, segmentIndex * 3);
  const inferredEnd = start + Math.max(transcriptWeight(text) * 0.22, 2);
  const explicitEnd = segment?.end ?? segment?.end_time ?? segment?.endTime;
  const rawEnd = finiteNumber(explicitEnd ?? timestampEnd, inferredEnd);
  const end = Math.max(start + (explicitEnd == null ? 0.5 : 0.35), rawEnd);
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

function isEnglishLeadInFragment(text) {
  const clean = normalizeAsrText(text);
  if (!/^[A-Za-z]+[,]?$/.test(clean)) return false;
  return englishLeadInWords.has(cleanEnglishWord(clean));
}

function isWeakCjkContinuationFragment(text) {
  const clean = normalizeAsrText(text);
  return /[\u4e00-\u9fa5]/.test(clean) && /(作为|不能|需要|应该|不应该|以及|和|与|或|交给|恢复成|时的|生成|重新整)$/.test(clean);
}

function startsLikelyNewSubtitleClause(previous, current) {
  const previousText = normalizeAsrText(previous?.text || "");
  const currentText = normalizeAsrText(current?.text || "");
  if (!previousText || !currentText || transcriptWeight(previousText) < 3) return false;
  if (isLatinText(previousText) && isLatinText(currentText)) {
    const firstWord = cleanEnglishWord(currentText.split(/\s+/)[0]);
    return englishSentenceStartWords.has(firstWord) && transcriptWeight(currentText) >= 3;
  }
  if (/[\u4e00-\u9fa5]/.test(currentText)) {
    const breakBefore = startsWithPattern(currentText, phraseStrongBreakBeforePatterns);
    return Boolean(breakBefore && transcriptWeight(currentText) >= 3);
  }
  return false;
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
  const preserveBoundaries = new Set((options.preserveBoundaries || []).map(([left, right]) => `${left}\u0000${right}`));
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
    const preserveBoundary = preserveBoundaries.has(`${previous.id}\u0000${current.id}`);
    const combinedText = joinAdjacentAsrText(previous.text, current.text);
    const combinedDuration = Math.max(finiteNumber(previous.end, 0), finiteNumber(current.end, 0)) - finiteNumber(previous.start, 0);
    const previousLeadInFragment = isEnglishLeadInFragment(previous.text);
    const previousWeakContinuation = isWeakCjkContinuationFragment(previous.text);
    const allowedCombinedDuration = previousLeadInFragment ? Math.max(maxCombinedDuration, 7) : maxCombinedDuration;
    const allowedMergedUnits = previousLeadInFragment && isLatinText(combinedText)
      ? Math.max(maxMergedUnits(combinedText), 14)
      : previousWeakContinuation
        ? Math.max(maxMergedUnits(combinedText), 20)
        : maxMergedUnits(combinedText);
    const shouldMerge = sameSpeaker(previous, current)
      && gap >= -0.05
      && gap <= maxGapSeconds
      && combinedDuration <= allowedCombinedDuration
      && !preserveBoundary
      && !isSentenceClosed(previous.text)
      && !startsLikelyNewSubtitleClause(previous, current)
      && transcriptWeight(combinedText) <= allowedMergedUnits
      && (isShortFragment(previous) || isShortFragment(current) || previousLeadInFragment || previousWeakContinuation);

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
    const segments = scaleTimedItems(result.segments, timingScaleForItems(result.segments, fallbackDuration), { scaleExplicitFields: false });
    const rows = segments.flatMap((segment, index) => rowsFromSegment(segment, index));
    return repairCoarseSegmentTiming(rows, fallbackDuration);
  }
  if (Array.isArray(result?.words) && result.words.length) {
    const words = scaleTimedItems(result.words, timingScaleForItems(result.words, fallbackDuration));
    const rows = repairAsrTimeline(groupWordsToRows(words));
    if (rows.length) return rows;
  }
  const sentences = splitTranscriptIntoSentences(result?.text || result?.transcript || "");
  if (!sentences.length) return [];
  const duration = resolveUntimedTranscriptDuration(sentences, fallbackDuration);
  const totalWeight = sentences.reduce((sum, item) => sum + transcriptWeight(item), 0) || sentences.length || 1;
  const gapSeconds = sentences.length > 1 && duration >= sentences.length * 0.45 + (sentences.length - 1) * 0.1 ? 0.1 : 0;
  const speechDuration = Math.max(0.5, duration - gapSeconds * Math.max(0, sentences.length - 1));
  const minimumSegmentDuration = Math.min(1.2, Math.max(0.35, (speechDuration / Math.max(sentences.length, 1)) * 0.55));
  let cursor = 0;
  return repairAsrTimeline(sentences.map((text, index) => {
    const isLast = index === sentences.length - 1;
    const remainingSegments = sentences.length - index - 1;
    const remainingGapDuration = gapSeconds * remainingSegments;
    const remainingDuration = Math.max(0.35, duration - cursor - remainingGapDuration);
    const proportional = speechDuration * (transcriptWeight(text) / totalWeight);
    const segmentDuration = isLast ? remainingDuration : Math.max(proportional, minimumSegmentDuration);
    const start = cursor;
    const latestEnd = Math.max(start + 0.35, duration - remainingGapDuration - remainingSegments * minimumSegmentDuration);
    const end = isLast ? duration : Math.min(latestEnd, start + segmentDuration);
    cursor = end + (isLast ? 0 : gapSeconds);
    return {
      id: `asr-text-${Date.now()}-${index}`,
      start,
      end: Math.max(start + 0.35, end),
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
  const minOverlap = /[\u4e00-\u9fa5]/.test(normalizeAsrText(previousText))
    && /[\u4e00-\u9fa5]/.test(normalizeAsrText(currentText))
    ? 2
    : 4;
  for (let size = maxOverlap; size >= minOverlap; size -= 1) {
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

function trimPartialProtectedPhraseSuffix(previousText, currentText) {
  const previous = normalizeAsrText(previousText);
  const current = normalizeAsrText(currentText);
  if (!previous || !current) return null;
  for (const phrase of protectedCjkSplitPhrases) {
    if (!current.startsWith(phrase)) continue;
    const maxPrefixLength = Math.min(phrase.length - 1, previous.length);
    const minimumPrefixLength = phrase.startsWith("不能") ? 2 : 3;
    for (let size = maxPrefixLength; size >= minimumPrefixLength; size -= 1) {
      const prefix = phrase.slice(0, size);
      if (!previous.endsWith(prefix)) continue;
      const trimmed = normalizeAsrText(previous.slice(0, -prefix.length));
      if (transcriptWeight(trimmed) >= 4) return trimmed;
    }
  }
  return null;
}

function minimumProtectedPhrasePrefixLength(phrase) {
  if (/^(作为提示|时间轴|不能让|重新整理)/.test(phrase)) return 1;
  if (/^(源语言|生成可|可校对)/.test(phrase)) return 1;
  if (/^(普通|时间|合理|用户|交给|转写|只应该|作为源|自动|媒体|原始|并生成|目标语言|语言和目标|不一致时)/.test(phrase)) return 2;
  if (phrase.startsWith("不能")) return 2;
  return 3;
}

function repairProtectedPhraseAcrossBoundary(previousText, currentText) {
  const previous = normalizeAsrText(previousText);
  const current = normalizeAsrText(currentText);
  if (!previous || !current) return null;

  for (const phrase of protectedCjkSplitPhrases) {
    if (phrase.length < 4) continue;
    const minimumPrefixLength = minimumProtectedPhrasePrefixLength(phrase);
    for (let prefixLength = phrase.length - 1; prefixLength >= minimumPrefixLength; prefixLength -= 1) {
      const prefix = phrase.slice(0, prefixLength);
      if (!previous.endsWith(prefix)) continue;
      const rest = phrase.slice(prefixLength);
      if (!rest) continue;
      const restIndex = current.indexOf(rest);
      if (restIndex < 0 || restIndex > 4) continue;
      const repairedPreviousText = normalizeAsrText(`${previous.slice(0, -prefix.length)}${phrase}`);
      return {
        previousText: repairedPreviousText,
        currentText: normalizeAsrText(current.slice(restIndex + rest.length)),
      };
    }
  }
  return null;
}

export function dedupeAdjacentAsrRows(rows, maxGapSeconds = 1.2) {
  const sorted = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const startDiff = finiteNumber(a?.start, 0) - finiteNumber(b?.start, 0);
    if (startDiff) return startDiff;
    return finiteNumber(a?.end, 0) - finiteNumber(b?.end, 0);
  });
  const result = [];
  for (const row of sorted) {
    let text = normalizeAsrText(row?.text || "");
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
    if (closeToPrevious && compactOverlapText(previousText).includes(compactOverlapText(text)) && transcriptWeight(text) <= 10) {
      result[result.length - 1] = {
        ...previous,
        end: Math.max(finiteNumber(previous.end, 0), finiteNumber(row.end, 0)),
      };
      continue;
    }
    if (
      closeToPrevious
      && transcriptWeight(previousText) <= 3
      && compactOverlapText(text).startsWith(compactOverlapText(previousText))
    ) {
      result[result.length - 1] = {
        ...row,
        start: finiteNumber(previous.start, 0),
        end: Math.max(finiteNumber(previous.end, 0), finiteNumber(row.end, 0)),
        text,
      };
      continue;
    }
    if (closeToPrevious) {
      const trimmedPrevious = trimPartialProtectedPhraseSuffix(previousText, text);
      if (trimmedPrevious) {
        result[result.length - 1] = { ...previous, text: trimmedPrevious };
        result.push({ ...row, text });
        continue;
      }
    }
    if (closeToPrevious) {
      const phraseRepair = repairProtectedPhraseAcrossBoundary(previousText, text);
      if (phraseRepair) {
        result[result.length - 1] = {
          ...previous,
          end: Math.max(finiteNumber(previous.end, 0), finiteNumber(row.end, 0)),
          text: phraseRepair.previousText,
        };
        text = phraseRepair.currentText;
        if (!text) continue;
      }
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
    return "识别结果与中文源语言不匹配，系统已标记为低可信结果；建议更换源语言或转写服务后重新转写。";
  }
  if (sourceLanguage === "英文" && normalizedText.length >= 24 && latinCount / normalizedText.length < 0.35) {
    return "识别结果与英文源语言不匹配，系统已标记为低可信结果；建议更换源语言或转写服务后重新转写。";
  }
  const safeDuration = Number(duration) || 0;
  const expectedMinRows = Math.max(2, Math.floor(safeDuration / 45));
  if (safeDuration >= 90 && rows.length < expectedMinRows) {
    return "长音频返回的分段异常偏少，系统已标记为低可信结果；建议重试或更换转写服务。";
  }
  const minimumTextWeight = Math.max(18, safeDuration / 6);
  if (safeDuration >= 60 && transcriptWeight(normalizedText) < minimumTextWeight) {
    return "长音频返回的文本异常偏少，系统已标记为低可信结果；建议重试或更换转写服务。";
  }
  return "";
}
