import assert from "node:assert/strict";
import { asrResultHasTiming, dedupeAdjacentAsrRows, detectTranscriptionQualityIssue, groupWordsToRows, joinAsrTokens, mergeShortAdjacentAsrRows, normalizeAsrText, repairAsrTimeline, rowsFromAsrResult, splitTranscriptIntoSentences, transcriptWeight } from "../src/asrRows.js";

assert.deepEqual(
  splitTranscriptIntoSentences("大家好。今天测试转写！换一行\n继续。"),
  ["大家好。", "今天测试转写！", "换一行", "继续。"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("第一部分内容很长，需要按逗号切开，第二部分继续说明细节，第三部分收尾。"),
  ["第一部分内容很长，", "需要按逗号切开，", "第二部分继续说明细节，", "第三部分收尾。"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("这是一个没有标点的长中文识别结果需要拆成更容易校对和导出的字幕段落"),
  ["这是一个没有标点的长中文识别结果", "需要拆成更容易校对和导出的字幕段落"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我们先看整体结论然后再处理细节如果还有问题继续复核。"),
  ["我们先看整体结论", "然后再处理细节", "如果还有问题继续复核。"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我知道你不相信我但是我们现在必须离开这里否则就来不及了"),
  ["我知道你不相信我", "但是我们现在必须离开这里", "否则就来不及了"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("这是一条非常非常长并且时间极短的字幕内容后一条和上一条时间重叠"),
  ["这是一条非常非常长", "并且时间极短的字幕内容", "后一条和上一条时间重叠"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("好的我们继续看下一段这部分讲的是模型配置和转写服务"),
  ["好的我们继续看下一段", "这部分讲的是模型配置和转写服务"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("对这个问题不应该提示用户自己解决而是系统自动修复"),
  ["对这个问题不应该提示用户自己解决", "而是系统自动修复"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("如果还有问题继续复核不要把错误交给用户解决"),
  ["如果还有问题继续复核", "不要把错误交给用户解决"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我们先看整体结论然后再处理细节如果还有问题继续复核不要把这种错误作为提示交给用户解决而是作为功能问题解决。"),
  ["我们先看整体结论", "然后再处理细节", "如果还有问题继续复核", "不要把这种错误作为提示交给用户解决", "而是作为功能问题解决。"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("是这样如果源语言是英文目标语言是中文翻译才是附加功能"),
  ["是这样如果源语言是英文", "目标语言是中文", "翻译才是附加功能"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我觉得这个页面现在最大的问题是校对窗口太挤按钮也太多"),
  ["我觉得这个页面现在最大的问题是", "校对窗口太挤按钮也太多"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("哇我听够了我以为我们只能给 Kade 最糟糕的最糟糕的就像这个人 Kade 可以有他这些都是我的你在做什么在跟想吗这叫自我控制 Damon"),
  [
    "哇我听够了",
    "我以为我们只能给 Kade",
    "最糟糕的最糟糕的",
    "就像这个人 Kade",
    "可以有他",
    "这些都是我的你在做什么",
    "在跟想吗",
    "这叫自我控制",
    "Damon",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("之前在鬼魂笔记中是的我会想她死而不是我如果 Meg 和 Elizabeth 都死了你会想要活着吗我希望活着我不在乎任何人的事"),
  [
    "之前在鬼魂笔记中是的",
    "我会想她死而不是我",
    "如果 Meg 和 Elizabeth 都死了",
    "你会想要活着吗",
    "我希望活着",
    "我不在乎任何人的事",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我知道 你不相信我 但是 我们现在必须离开这里 否则 就来不及了"),
  ["我知道你不相信我", "但是我们现在必须离开这里", "否则就来不及了"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("等一下我还没有准备好你先不要开始我们马上处理"),
  ["等一下我还没有准备好", "你先不要开始我们马上处理"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("你会想要活着吗我希望活着"),
  ["你会想要活着吗", "我希望活着"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("这个可以吗我们现在继续处理"),
  ["这个可以吗", "我们现在继续处理"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我正在看着这个人"),
  ["我正在看着这个人"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我以为我们只能给 Kade 最糟糕的最糟糕的就像这个人 Kade 可以有他在这里继续补充后面的长句。"),
  ["我以为我们只能给 Kade 最糟糕的最糟糕的", "就像这个人 Kade", "可以有他在这里继续补充后面的长句。"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("this is a long english transcription result without punctuation and it should be split into readable subtitle rows for proofreading"),
  ["this is a long english transcription result without punctuation", "and it should be split into readable subtitle rows for proofreading"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("You left your son You abandoned your family I was ashamed"),
  ["You left your son", "You abandoned your family", "I was ashamed"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("I can become the Ripper that you want You would turn your humanity off For a short time yes"),
  ["I can become the Ripper that you want", "You would turn your humanity off", "For a short time yes"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("I can become the Ripper that you want you would turn your humanity off for a short time yes I predict that when it is over you let me and my brother go"),
  [
    "I can become the Ripper that you want",
    "you would turn your humanity off for a short time yes",
    "I predict that when it is over",
    "you let me and my brother go",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("Previously on The Vampire Diaries You left your son"),
  ["Previously on The Vampire Diaries", "You left your son"],
);

assert.deepEqual(
  splitTranscriptIntoSentences("今天我们讨论一下模型配置和转写服务为什么开始转写之后没有结果首先需要确认音频是否上传成功然后检查服务返回的时间码是不是正常"),
  [
    "今天我们讨论一下模型配置和转写服务",
    "为什么开始转写之后没有结果",
    "首先需要确认音频是否上传成功",
    "然后检查服务返回的时间码是不是正常",
  ],
);

assert.ok(
  splitTranscriptIntoSentences("this is a long english transcription result without punctuation and it should be split into readable subtitle rows for proofreading")
    .every((row) => !/\b(?:and|or|but|that|which|who|to|of|for|in|on|at|with|from|into|as|by|can|could|should|would|will|may|might|must|shall)$/i.test(row)),
  "English subtitle rows should not end on weak connector words when a better split exists",
);

assert.ok(
  splitTranscriptIntoSentences("If the speech recognition service returns long paragraphs without clear sentence breaks the workbench should split the text into readable rows automatically users should not solve time overlap or oversized subtitle problems by themselves")
    .every((row) => !/\b(?:can|could|should|would|will|may|might|must|shall)$/i.test(row)),
  "English subtitle rows should not end on dangling modal verbs",
);

assert.deepEqual(
  splitTranscriptIntoSentences("It will not go through both slits. If it's unobserved, it will."),
  ["It will not go through both slits.", "If it's unobserved, it will."],
);

assert.deepEqual(
  splitTranscriptIntoSentences("yes. maybe you shouldn't be here."),
  ["yes.", "maybe you shouldn't be here."],
);

assert.deepEqual(
  splitTranscriptIntoSentences("Dr. Smith reviewed the audio. The result is usable."),
  ["Dr. Smith reviewed the audio.", "The result is usable."],
);

assert.deepEqual(
  splitTranscriptIntoSentences("The U.S. Army reviewed the audio. The result is usable."),
  ["The U.S. Army reviewed the audio.", "The result is usable."],
);

assert.deepEqual(
  splitTranscriptIntoSentences("Use e.g. speaker names and product names. The subtitle stays readable."),
  ["Use e.g. speaker names and product names.", "The subtitle stays readable."],
);

assert.deepEqual(
  splitTranscriptIntoSentences("Use e.g. speaker names and product names. next sentence starts lowercase."),
  ["Use e.g. speaker names and product names.", "next sentence starts lowercase."],
);

assert.equal(joinAsrTokens([
  { word: "Hello" },
  { word: "world" },
  { word: "," },
  { word: "欢迎" },
  { word: "使用" },
  { word: "回响" },
  { word: "。" },
]), "Hello world, 欢迎使用回响。");

assert.equal(normalizeAsrText("大家好,欢迎使用回响工作台. 今天测试ASR!"), "大家好，欢迎使用回响工作台。 今天测试ASR！");
assert.equal(normalizeAsrText("Hello, welcome to Echo Workbench."), "Hello, welcome to Echo Workbench.");
assert.equal(normalizeAsrText("请生成准确的中文字母。"), "请生成准确的中文字幕。");

const wordRows = groupWordsToRows([
  { text: "大家", start_time: 0, end_time: 0.4 },
  { text: "好", start_time: 0.4, end_time: 0.8 },
  { text: "。", start_time: 0.8, end_time: 0.9 },
  { text: "今天", start_time: 1.2, end_time: 1.7 },
  { text: "测试", start_time: 1.7, end_time: 2.2 },
  { text: "ASR", start_time: 2.2, end_time: 2.6 },
]);

assert.equal(wordRows.length, 2);
assert.deepEqual(
  wordRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 0, end: 0.9, text: "大家好。" },
    { start: 1.2, end: 2.6, text: "今天测试 ASR" },
  ],
);

const englishWordRows = groupWordsToRows([
  { word: "You", start: 0, end: 0.2 },
  { word: "left", start: 0.2, end: 0.5 },
  { word: "your", start: 0.5, end: 0.7 },
  { word: "son.", start: 0.7, end: 1 },
  { word: "You", start: 1.1, end: 1.3 },
  { word: "abandoned", start: 1.3, end: 1.8 },
  { word: "your", start: 1.8, end: 2 },
  { word: "family.", start: 2, end: 2.4 },
]);

assert.deepEqual(
  englishWordRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 0, end: 1, text: "You left your son." },
    { start: 1.1, end: 2.4, text: "You abandoned your family." },
  ],
);

const longSingleTokenWordRows = groupWordsToRows([
  {
    text: "我知道你不相信我但是我们现在必须离开这里否则就来不及了",
    start_time: 0,
    end_time: 8,
  },
]);

assert.ok(longSingleTokenWordRows.length > 1, "word-level ASR rows should split a long single-token transcript");
assert.ok(
  longSingleTokenWordRows.every((row) => transcriptWeight(row.text) <= 20),
  `word-level long token rows should be readable: ${longSingleTokenWordRows.map((row) => row.text).join(" | ")}`,
);
for (let index = 1; index < longSingleTokenWordRows.length; index += 1) {
  assert.ok(longSingleTokenWordRows[index].start >= longSingleTokenWordRows[index - 1].end);
}
assert.equal(longSingleTokenWordRows.at(-1).end, 8);

const longEnglishWordRows = groupWordsToRows([
  { word: "I", start: 0, end: 0.2 },
  { word: "have", start: 0.2, end: 0.5 },
  { word: "spent", start: 0.5, end: 0.8 },
  { word: "the", start: 0.8, end: 1 },
  { word: "last", start: 1, end: 1.25 },
  { word: "three", start: 1.25, end: 1.55 },
  { word: "weeks", start: 1.55, end: 1.9 },
  { word: "sending", start: 1.9, end: 2.25 },
  { word: "people", start: 2.25, end: 2.6 },
  { word: "into", start: 2.6, end: 2.9 },
  { word: "that", start: 2.9, end: 3.1 },
  { word: "river", start: 3.1, end: 3.5 },
  { word: "to", start: 3.5, end: 3.7 },
  { word: "look", start: 3.7, end: 4 },
  { word: "for", start: 4, end: 4.2 },
  { word: "that", start: 4.2, end: 4.4 },
  { word: "bell", start: 4.4, end: 4.8 },
]);

assert.ok(longEnglishWordRows.length > 1, "word-level English ASR rows should split long unpunctuated speech");
assert.ok(
  longEnglishWordRows.every((row) => transcriptWeight(row.text) <= 12),
  `word-level English rows should be readable: ${longEnglishWordRows.map((row) => row.text).join(" | ")}`,
);
assert.equal(longEnglishWordRows.at(-1).end, 4.8);

const abbreviationWordRows = groupWordsToRows([
  { word: "Dr.", start: 0, end: 0.25 },
  { word: "Smith", start: 0.25, end: 0.6 },
  { word: "arrived.", start: 0.6, end: 1 },
]);

assert.deepEqual(abbreviationWordRows.map((row) => row.text), ["Dr. Smith arrived."]);

const segmentRows = rowsFromAsrResult({
  segments: [
    { start_time: 0, end_time: 2.4, speaker_label: "S1", transcript: "第一段转写" },
    { start_time: 2.4, end_time: 5.2, speaker_label: "S2", transcript: "第二段转写" },
  ],
});

assert.deepEqual(
  segmentRows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 0, end: 2.4, speaker: "S1", text: "第一段转写" },
    { start: 2.4, end: 5.2, speaker: "S2", text: "第二段转写" },
  ],
);

const longSegmentRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 18,
      text: "第一部分内容很长，需要按照字幕可读性进行拆分，第二部分继续补充背景信息，第三部分给出结论。最后一句保持独立。",
    },
  ],
});

assert.ok(longSegmentRows.length > 1);
assert.ok(longSegmentRows.every((row) => transcriptWeight(row.text) <= 20));
for (let index = 1; index < longSegmentRows.length; index += 1) {
  assert.ok(longSegmentRows[index].start >= longSegmentRows[index - 1].end);
}
assert.equal(longSegmentRows.at(-1).end, 18);

const coarseSegmentRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 60,
      text: "echo workbench transcription test. This is a stable audio transcription sample.",
    },
  ],
}, 60);
assert.ok(coarseSegmentRows.length >= 2);
assert.ok(coarseSegmentRows.at(-1).end < 12, `coarse ASR segment timing should be repaired for short speech, got ${coarseSegmentRows.at(-1).end}`);

const compressedSegmentRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 1,
      text: "我们现在必须马上离开这里否则就来不及了",
    },
  ],
}, 20);
assert.ok(compressedSegmentRows.at(-1).end > 3.5, `compressed ASR timing should expand to readable speech duration, got ${compressedSegmentRows.at(-1).end}`);

const compressedEnglishRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 1,
      text: "I have spent the last three weeks sending people into that river to look for that bell and they have not found it",
    },
  ],
}, 20);
assert.ok(compressedEnglishRows.at(-1).end > 8, `compressed English ASR timing should expand to readable speech duration, got ${compressedEnglishRows.at(-1).end}`);

const realisticSegmentRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 6,
      text: "echo workbench transcription test. This is a stable audio transcription sample.",
    },
  ],
}, 6);
assert.equal(realisticSegmentRows.at(-1).end, 6);

const millisecondSegmentRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 60000,
      text: "这是一段较长的毫秒级时间戳结果，需要优先按真实媒体时长缩放。",
    },
  ],
}, 60);
assert.equal(millisecondSegmentRows.at(-1).end, 60);

const textRows = rowsFromAsrResult({ transcript: "第一句没有时间戳。第二句会按时长分配。" }, 12);

assert.equal(textRows.length, 2);
assert.equal(textRows[0].start, 0);
assert.ok(textRows[1].end < 8, `untimed short text should not be stretched to the full media duration, got ${textRows[1].end}`);
assert.deepEqual(textRows.map((row) => row.text), ["第一句没有时间戳。", "第二句会按时长分配。"]);

const shortEnglishTextRows = rowsFromAsrResult({
  text: "echo workbench transcription test. This is a stable audio transcription sample.",
}, 60);
assert.ok(shortEnglishTextRows.length >= 2);
assert.ok(shortEnglishTextRows.at(-1).end < 12, `short untimed English ASR should use speech-length timing instead of a 60s media fallback, got ${shortEnglishTextRows.at(-1).end}`);

const realStyleRows = rowsFromAsrResult({ text: "大家好,欢迎使用回响工作台,今天测试音频转写功能。" }, 8);
assert.deepEqual(realStyleRows.map((row) => row.text), ["大家好，欢迎使用回响工作台，", "今天测试音频转写功能。"]);

assert.ok(
  rowsFromAsrResult({
    text: "我以为我们只能给 Kade 最糟糕的最糟糕的，就像这个人 Kade 可以有他在这里继续补充后面的长句。",
  }, 12).every((row) => transcriptWeight(row.text) <= 20),
  "ASR plain-text fallback should split long subtitle rows into readable units",
);

const mixedLanguageRows = rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 8,
    text: "我以为我们只能给 Kade 最糟糕的最糟糕的，就像这个人 Kade 可以有他在这里继续补充后面的长句。",
  }],
}, 8);
assert.ok(mixedLanguageRows.length >= 3, "mixed Chinese and English ASR segments should not stay as one oversized subtitle row");
assert.ok(
  mixedLanguageRows.every((row) => transcriptWeight(row.text) <= 18),
  `mixed ASR rows should stay readable, got ${mixedLanguageRows.map((row) => row.text).join(" | ")}`,
);

const phraseSpacedRows = rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 18,
    text: "之前在 《 鬼魂笔记 》 中 是的 我会想她死而不是我 如果 Meg 和 Elizabeth 都死了 你会想要活着吗 我希望活着",
  }],
}, 18);
assert.ok(phraseSpacedRows.length >= 4, `phrase-spaced ASR text should be split for proofreading, got ${phraseSpacedRows.map((row) => row.text).join(" | ")}`);
assert.ok(
  phraseSpacedRows.every((row) => transcriptWeight(row.text) <= 18),
  `phrase-spaced ASR rows should stay readable, got ${phraseSpacedRows.map((row) => row.text).join(" | ")}`,
);
assert.match(phraseSpacedRows.map((row) => row.text).join("|"), /之前在《鬼魂笔记》中/);
assert.match(phraseSpacedRows.map((row) => row.text).join("|"), /如果 Meg 和 Elizabeth 都死了/);
assert.ok(phraseSpacedRows.some((row) => row.text === "你会想要活着吗"));
assert.ok(phraseSpacedRows.some((row) => row.text === "我希望活着"));

const englishDialogueRows = rowsFromAsrResult({
  text: "Previously on The Vampire Diaries You left your son You abandoned your family I was ashamed I had to get out It is beautiful",
}, 12);
assert.deepEqual(
  englishDialogueRows.map((row) => row.text),
  [
    "Previously on The Vampire Diaries",
    "You left your son",
    "You abandoned your family",
    "I was ashamed",
    "I had to get out",
    "It is beautiful",
  ],
);

const unpunctuatedDialogueRows = rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 30,
    text: "哇我听够了我以为我们只能给 Kade 最糟糕的最糟糕的就像这个人 Kade 可以有他这些都是我的你在做什么在跟想吗这叫自我控制 Damon",
  }],
}, 30);
assert.deepEqual(
  unpunctuatedDialogueRows.map((row) => row.text),
  [
    "哇我听够了",
    "我以为我们只能给 Kade",
    "最糟糕的最糟糕的",
    "就像这个人 Kade",
    "可以有他",
    "这些都是我的你在做什么",
    "在跟想吗",
    "这叫自我控制",
    "Damon",
  ],
);
assert.ok(
  unpunctuatedDialogueRows.every((row) => transcriptWeight(row.text) <= 16),
  `unpunctuated dialogue rows should stay readable, got ${unpunctuatedDialogueRows.map((row) => row.text).join(" | ")}`,
);

const overlappingRows = rowsFromAsrResult({
  segments: [
    { start: 0, end: 4, text: "第一句内容。" },
    { start: 3.2, end: 6, text: "第二句内容。" },
    { start: 5.7, end: 7.5, text: "第三句内容。" },
  ],
});
for (let index = 1; index < overlappingRows.length; index += 1) {
  assert.ok(
    overlappingRows[index].start >= overlappingRows[index - 1].end,
    `ASR segment overlap should be repaired: ${JSON.stringify(overlappingRows)}`,
  );
}
assert.deepEqual(overlappingRows.map((row) => row.text), ["第一句内容。", "第二句内容。", "第三句内容。"]);

const repairedMergedRows = repairAsrTimeline(mergeShortAdjacentAsrRows([
  { id: "a", start: 0, end: 2.6, speaker: "S1", text: "This is fine.", translation: "" },
  { id: "b", start: 2.3, end: 4.5, speaker: "S1", text: "This overlaps.", translation: "" },
]));
for (let index = 1; index < repairedMergedRows.length; index += 1) {
  assert.ok(repairedMergedRows[index].start >= repairedMergedRows[index - 1].end);
}

assert.deepEqual(rowsFromAsrResult({}, 10), []);

assert.equal(asrResultHasTiming({ words: [{ start: 0, end: 0.3, word: "Hello" }] }), true);
assert.equal(asrResultHasTiming({ segments: [{ start: 0, end: 2, text: "第一段" }] }), true);
assert.equal(asrResultHasTiming({ text: "没有时间戳" }), false);

const dedupedRows = dedupeAdjacentAsrRows([
  { id: "a", start: 178.9, end: 180.2, speaker: "未标注", text: "边界重复句。", translation: "" },
  { id: "b", start: 179.6, end: 181.1, speaker: "未标注", text: "边界重复句.", translation: "" },
  { id: "c", start: 181.2, end: 183.8, speaker: "未标注", text: "新的内容。", translation: "" },
]);

assert.deepEqual(
  dedupedRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 178.9, end: 181.1, text: "边界重复句。" },
    { start: 181.2, end: 183.8, text: "新的内容。" },
  ],
);

const partialChineseDedupedRows = dedupeAdjacentAsrRows([
  { id: "a", start: 0, end: 2.4, speaker: "未标注", text: "边界重复句。新的内容。", translation: "" },
  { id: "b", start: 2.1, end: 4.8, speaker: "未标注", text: "新的内容。第三句。", translation: "" },
]);

assert.deepEqual(
  partialChineseDedupedRows.map((row) => row.text),
  ["边界重复句。新的内容。", "第三句。"],
);

const partialEnglishDedupedRows = dedupeAdjacentAsrRows([
  { id: "a", start: 0, end: 2.3, speaker: "未标注", text: "Previously on The Vampire Diaries", translation: "" },
  { id: "b", start: 2.1, end: 4.2, speaker: "未标注", text: "The Vampire Diaries You left your son.", translation: "" },
]);

assert.deepEqual(
  partialEnglishDedupedRows.map((row) => row.text),
  ["Previously on The Vampire Diaries", "You left your son."],
);

const distantRepeatedRows = dedupeAdjacentAsrRows([
  { id: "a", start: 0, end: 2.3, speaker: "未标注", text: "The Vampire Diaries", translation: "" },
  { id: "b", start: 8, end: 10, speaker: "未标注", text: "The Vampire Diaries continues.", translation: "" },
]);

assert.deepEqual(
  distantRepeatedRows.map((row) => row.text),
  ["The Vampire Diaries", "The Vampire Diaries continues."],
);

const mergedShortRows = mergeShortAdjacentAsrRows([
  { id: "a", start: 0, end: 0.8, speaker: "S1", text: "I can", translation: "" },
  { id: "b", start: 0.85, end: 1.6, speaker: "S1", text: "become the Ripper", translation: "" },
  { id: "c", start: 3, end: 4.1, speaker: "S1", text: "Next sentence.", translation: "" },
]);

assert.deepEqual(
  mergedShortRows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 0, end: 1.6, speaker: "S1", text: "I can become the Ripper" },
    { start: 3, end: 4.1, speaker: "S1", text: "Next sentence." },
  ],
);

assert.deepEqual(
  mergeShortAdjacentAsrRows([
    { id: "lead", start: 0, end: 2.1, speaker: "S1", text: "First,", translation: "" },
    { id: "body", start: 2.1, end: 6.1, speaker: "S1", text: "we upload a media file and wait for the transcription result.", translation: "" },
  ], { maxGapSeconds: 0.85, maxCombinedDuration: 5.8 }).map((row) => row.text),
  ["First, we upload a media file and wait for the transcription result."],
);

assert.equal(
  mergeShortAdjacentAsrRows([
    { id: "a", start: 0, end: 0.8, speaker: "S1", text: "I can", translation: "" },
    { id: "b", start: 0.85, end: 1.6, speaker: "S2", text: "become the Ripper", translation: "" },
  ]).length,
  2,
);

assert.deepEqual(
  mergeShortAdjacentAsrRows([
    { id: "a", start: 0, end: 0.9, speaker: "S1", text: "Yes.", translation: "" },
    { id: "b", start: 0.95, end: 2.1, speaker: "S1", text: "I understand.", translation: "" },
  ]).map((row) => row.text),
  ["Yes.", "I understand."],
);

assert.deepEqual(
  mergeShortAdjacentAsrRows([
    { id: "a", start: 0, end: 1.8, speaker: "S1", text: "第一条内容。", translation: "" },
    { id: "b", start: 1.85, end: 2.6, speaker: "S1", text: "第二条开头", translation: "" },
  ]).map((row) => row.text),
  ["第一条内容。", "第二条开头"],
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "This transcript is clearly English and not Chinese." },
  ], "中文", 20),
  /中文源语言不匹配/,
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "这是一段明显的中文识别结果，不应该被当成英文内容继续处理。" },
  ], "英文", 20),
  /英文源语言不匹配/,
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "只有一条短转写。" },
  ], "中文", 180),
  /分段偏少/,
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "短句。" },
    { text: "还是太短。" },
  ], "中文", 80),
  /文本偏少/,
);

assert.equal(
  detectTranscriptionQualityIssue([
    { text: "大家好，欢迎使用回响工作台，今天我们会完整测试音频转写功能。" },
    { text: "第二段继续说明模型配置、字幕校对、翻译和导出的真实工作流。" },
    { text: "第三段确认时间轴和项目恢复不会丢失处理结果。" },
    { text: "最后提醒用户继续核对专有名词和低置信片段。" },
  ], "中文", 120),
  "",
);

console.log("asr row tests passed");
