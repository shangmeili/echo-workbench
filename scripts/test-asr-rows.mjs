import assert from "node:assert/strict";
import { asrResultHasTiming, dedupeAdjacentAsrRows, detectTranscriptionQualityIssue, groupWordsToRows, joinAsrTokens, mergeShortAdjacentAsrRows, normalizeAsrText, rowsFromAsrResult, splitTranscriptIntoSentences, transcriptWeight } from "../src/asrRows.js";

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
  splitTranscriptIntoSentences("this is a long english transcription result without punctuation and it should be split into readable subtitle rows for proofreading"),
  ["this is a long english transcription result without punctuation and", "it should be split into readable subtitle rows for proofreading"],
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

const textRows = rowsFromAsrResult({ transcript: "第一句没有时间戳。第二句会按时长分配。" }, 12);

assert.equal(textRows.length, 2);
assert.equal(textRows[0].start, 0);
assert.equal(textRows[1].end, 12);
assert.deepEqual(textRows.map((row) => row.text), ["第一句没有时间戳。", "第二句会按时长分配。"]);

const realStyleRows = rowsFromAsrResult({ text: "大家好,欢迎使用回响工作台,今天测试音频转写功能。" }, 8);
assert.deepEqual(realStyleRows.map((row) => row.text), ["大家好，欢迎使用回响工作台，", "今天测试音频转写功能。"]);

assert.ok(
  rowsFromAsrResult({
    text: "我以为我们只能给 Kade 最糟糕的最糟糕的，就像这个人 Kade 可以有他在这里继续补充后面的长句。",
  }, 12).every((row) => transcriptWeight(row.text) <= 20),
  "ASR plain-text fallback should split long subtitle rows into readable units",
);

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
