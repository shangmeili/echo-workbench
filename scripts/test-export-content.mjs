import assert from "node:assert/strict";
import { parsePlainTextRows, parseSubtitle, parseTimestamp } from "../src/subtitleImport.js";
import { exportRows, formatClock, formatSrtTime, validateExportRows } from "../src/subtitleExport.js";

const rows = [
  {
    start: 0,
    end: 2.5,
    speaker: "Speaker 1",
    text: "Hello Echo.",
    translation: "你好，回响。",
  },
  {
    start: 62.25,
    end: 65,
    speaker: "Speaker 2",
    text: "Export modes are real.",
    translation: "导出模式是真实的。",
  },
];

assert.equal(formatClock(62.25), "01:02.250");
assert.equal(formatClock(3661.5), "01:01:01.500");
assert.equal(formatClock(1.9996), "00:02.000");
assert.equal(formatSrtTime(3661.5), "01:01:01,500");
assert.equal(formatSrtTime(3599.9996), "01:00:00,000");
assert.equal(parseTimestamp("01:01:01.500"), 3661.5);
assert.equal(parseTimestamp("00:01,250"), 1.25);

assert.equal(
  exportRows(rows, "srt", "source"),
  [
    "1",
    "00:00:00,000 --> 00:00:02,500",
    "Hello Echo.",
    "",
    "2",
    "00:01:02,250 --> 00:01:05,000",
    "Export modes are real.",
  ].join("\n"),
);

assert.equal(
  exportRows(rows, "srt", "target"),
  [
    "1",
    "00:00:00,000 --> 00:00:02,500",
    "你好，回响。",
    "",
    "2",
    "00:01:02,250 --> 00:01:05,000",
    "导出模式是真实的。",
  ].join("\n"),
);

assert.equal(
  exportRows(rows, "vtt", "bilingual"),
  [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:02.500",
    "Hello Echo.",
    "你好，回响。",
    "",
    "2",
    "00:01:02.250 --> 00:01:05.000",
    "Export modes are real.",
    "导出模式是真实的。",
  ].join("\n"),
);

assert.equal(
  exportRows(rows, "txt", "target"),
  [
    "[00:00.000] Speaker 1: 你好，回响。",
    "",
    "[01:02.250] Speaker 2: 导出模式是真实的。",
  ].join("\n"),
);

assert.equal(
  exportRows(rows, "txt", "source", { includeTimecodes: false, includeSpeakers: false }),
  [
    "Hello Echo.",
    "",
    "Export modes are real.",
  ].join("\n"),
  "TXT export should support a clean transcript without timecodes or speaker labels",
);

assert.equal(
  exportRows(rows, "txt", "source", { includeTimecodes: true, includeSpeakers: false }),
  [
    "[00:00.000] Hello Echo.",
    "",
    "[01:02.250] Export modes are real.",
  ].join("\n"),
  "TXT export should allow timecodes without speaker labels",
);

assert.equal(
  exportRows(rows, "txt", "bilingual"),
  [
    "[00:00.000 - 00:02.500] Speaker 1",
    "原文：Hello Echo.",
    "译文：你好，回响。",
    "",
    "[01:02.250 - 01:05.000] Speaker 2",
    "原文：Export modes are real.",
    "译文：导出模式是真实的。",
  ].join("\n"),
);

assert.equal(
  exportRows(rows, "md", "source", { includeTimecodes: false, includeSpeakers: false }),
  [
    "# 转写稿",
    "",
    "- Hello Echo.",
    "",
    "- Export modes are real.",
  ].join("\n"),
  "Markdown export should support a clean transcript list without timing metadata",
);

assert.equal(
  exportRows([
    { start: 1, end: 3, speaker: "未标注", text: "无说话人原文。", translation: "Translation only label." },
  ], "txt", "bilingual"),
  [
    "[00:01.000 - 00:03.000]",
    "原文：无说话人原文。",
    "译文：Translation only label.",
  ].join("\n"),
);

assert.throws(
  () => exportRows([{ start: 0, end: 2, speaker: "未标注", text: "", translation: "" }], "srt", "source"),
  /第 1 条段落没有原文/,
  "export should fail fast instead of silently creating empty subtitle cues",
);

assert.throws(
  () => exportRows([{ start: 0, end: 2, speaker: "未标注", text: "Hello", translation: "" }], "srt", "target"),
  /第 1 条段落没有译文/,
  "target export should fail fast when a translation is missing",
);

assert.throws(
  () => validateExportRows([{ start: 3, end: 3, speaker: "未标注", text: "Bad time", translation: "" }], "source"),
  /第 1 条段落时间无效/,
  "export validation should reject invalid time ranges",
);

assert.throws(
  () => validateExportRows([
    { start: 0, end: 2, speaker: "未标注", text: "First", translation: "" },
    { start: 1.5, end: 3, speaker: "未标注", text: "Second", translation: "" },
  ], "source"),
  /第 1 条段落与下一条时间重叠/,
  "export validation should reject overlapping timeline ranges",
);

assert.equal(
  exportRows(rows, "md", "bilingual"),
  [
    "# 双语稿",
    "",
    "- **00:00.000 - 00:02.500** · Speaker 1",
    "  原文：Hello Echo.",
    "  译文：你好，回响。",
    "",
    "- **01:02.250 - 01:05.000** · Speaker 2",
    "  原文：Export modes are real.",
    "  译文：导出模式是真实的。",
  ].join("\n"),
);

assert.equal(
  exportRows(rows, "md", "target"),
  [
    "# 译文稿",
    "",
    "- **00:00.000 - 00:02.500** · Speaker 1",
    "  译文：你好，回响。",
    "",
    "- **01:02.250 - 01:05.000** · Speaker 2",
    "  译文：导出模式是真实的。",
  ].join("\n"),
);

assert.equal(
  exportRows([
    { start: 0, end: 2, speaker: "未标注", text: "没有说话人标签。", translation: "" },
    { start: 2, end: 4, speaker: "", text: "空说话人也不导出。", translation: "" },
    { start: 4, end: 6, speaker: "S1", text: "真实说话人保留。", translation: "" },
  ], "txt", "source"),
  [
    "[00:00.000] 没有说话人标签。",
    "",
    "[00:02.000] 空说话人也不导出。",
    "",
    "[00:04.000] S1: 真实说话人保留。",
  ].join("\n"),
);

const srtRows = parseSubtitle([
  "1",
  "00:00:01,000 --> 00:00:03,500",
  "第一条字幕",
  "",
  "2",
  "01:00:01,000 --> 01:00:04,000",
  "第二条字幕",
].join("\n"));

assert.equal(srtRows.length, 2);
assert.deepEqual(
  srtRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 1, end: 3.5, text: "第一条字幕" },
    { start: 3601, end: 3604, text: "第二条字幕" },
  ],
);

const vttRows = parseSubtitle([
  "WEBVTT",
  "",
  "00:00:02.000 --> 00:00:04.000",
  "Hello",
  "你好",
].join("\n"));

assert.equal(vttRows.length, 1);
assert.equal(vttRows[0].text, "Hello");
assert.equal(vttRows[0].translation, "你好");

const speakerSubtitleRows = parseSubtitle([
  "1",
  "00:00:01,000 --> 00:00:03,000",
  "Speaker 1: Hello from speaker one.",
  "说话人一号你好。",
  "",
  "2",
  "00:00:03,000 --> 00:00:05,000",
  "说话人2：第二段中文。",
  "Second translated line.",
  "",
  "3",
  "00:00:05,000 --> 00:00:07,000",
  "产品: 这不是说话人标签。",
].join("\n"));

assert.deepEqual(
  speakerSubtitleRows.map((row) => ({ speaker: row.speaker, text: row.text, translation: row.translation })),
  [
    { speaker: "Speaker 1", text: "Hello from speaker one.", translation: "说话人一号你好。" },
    { speaker: "说话人2", text: "第二段中文。", translation: "Second translated line." },
    { speaker: "未标注", text: "产品: 这不是说话人标签。", translation: "" },
  ],
);

const voiceTagRows = parseSubtitle([
  "WEBVTT",
  "",
  "00:00:07.000 --> 00:00:09.000",
  "<v Speaker 3>Voice tag line.",
].join("\n"));

assert.equal(voiceTagRows[0].speaker, "Speaker 3");
assert.equal(voiceTagRows[0].text, "Voice tag line.");

const wrappedRows = parseSubtitle([
  "1",
  "00:00:02,000 --> 00:00:04,000",
  "This is a wrapped subtitle line",
  "that should remain source text.",
].join("\n"));

assert.equal(wrappedRows.length, 1);
assert.equal(wrappedRows[0].text, "This is a wrapped subtitle line\nthat should remain source text.");
assert.equal(wrappedRows[0].translation, "");

const plainRows = parsePlainTextRows([
  "[00:00:05] 说话人: 开场",
  "00:00:08 - speaker: Next line",
  "无时间码段落",
].join("\n"));

assert.deepEqual(
  plainRows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 5, end: 8, speaker: "说话人", text: "开场" },
    { start: 8, end: 11, speaker: "speaker", text: "Next line" },
    { start: 11, end: 14, speaker: "未标注", text: "无时间码段落" },
  ],
);

const rangedPlainRows = parsePlainTextRows([
  "[00:00:05 - 00:00:08] 说话人: 带时间范围的开场",
  "00:00:08 --> 00:00:12 Speaker: Explicit range line",
  "00:00:12.500 - 00:00:14.000 旁白: 小数时间范围",
].join("\n"));

assert.deepEqual(
  rangedPlainRows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 5, end: 8, speaker: "说话人", text: "带时间范围的开场" },
    { start: 8, end: 12, speaker: "Speaker", text: "Explicit range line" },
    { start: 12.5, end: 14, speaker: "旁白", text: "小数时间范围" },
  ],
);

const rangedRowsViaSubtitleImport = parseSubtitle([
  "[00:00:05 - 00:00:08] 说话人: 带时间范围的开场",
  "00:00:08 --> 00:00:12 Speaker: Explicit range line",
  "00:00:12.500 - 00:00:14.000 旁白: 小数时间范围",
].join("\n"));

assert.deepEqual(
  rangedRowsViaSubtitleImport.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 5, end: 8, speaker: "说话人", text: "带时间范围的开场" },
    { start: 8, end: 12, speaker: "Speaker", text: "Explicit range line" },
    { start: 12.5, end: 14, speaker: "旁白", text: "小数时间范围" },
  ],
);

const bilingualPlainRows = parsePlainTextRows([
  "[00:00:00.000 - 00:00:02.332] Speaker 1: Previously on The Vampire Diaries...",
  "上集回顾：《吸血鬼日记》……",
  "[00:00:02.332 - 00:00:04.197] You left your son.",
  "你抛弃了你的儿子。",
].join("\n"));

assert.deepEqual(
  bilingualPlainRows.map((row) => ({ speaker: row.speaker, text: row.text, translation: row.translation })),
  [
    { speaker: "Speaker 1", text: "Previously on The Vampire Diaries...", translation: "上集回顾：《吸血鬼日记》……" },
    { speaker: "未标注", text: "You left your son.", translation: "你抛弃了你的儿子。" },
  ],
);

const bilingualPlainViaSubtitleImport = parseSubtitle([
  "[00:00:00.000 - 00:00:02.332] Speaker 1: Previously on The Vampire Diaries...",
  "上集回顾：《吸血鬼日记》……",
].join("\n"));

assert.equal(bilingualPlainViaSubtitleImport[0].translation, "上集回顾：《吸血鬼日记》……");

const bracketCueRows = parseSubtitle([
  "[00:00.000 --> 00:02.332]",
  "Previously on The Vampire Diaries...",
  "",
  "[00:02.332 --> 00:04.197]",
  "You left your son.",
].join("\n"));

assert.deepEqual(
  bracketCueRows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 0, end: 2.332, speaker: "未标注", text: "Previously on The Vampire Diaries..." },
    { start: 2.332, end: 4.197, speaker: "未标注", text: "You left your son." },
  ],
);

const escapedNewlineRows = parseSubtitle("00:00:00 --> 00:00:02 第一段文本\\n00:00:02 --> 00:00:04 第二段文本");

assert.deepEqual(
  escapedNewlineRows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
  [
    { start: 0, end: 2, speaker: "未标注", text: "第一段文本" },
    { start: 2, end: 4, speaker: "未标注", text: "第二段文本" },
  ],
);

console.log("subtitle content tests passed");
