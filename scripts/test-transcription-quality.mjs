import assert from "node:assert/strict";
import {
  rowsFromAsrResult,
  splitTranscriptIntoSentences,
  transcriptWeight,
} from "../src/asrRows.js";
import { getSubtitleQualityHints, normalizeReviewRows, repairReviewStructure, repairReviewStructurePreservingEmpty, repairReviewTimelinePreservingEmpty } from "../src/reviewRows.js";
import { parseSubtitle } from "../src/subtitleImport.js";

function assertCleanTimeline(rows, label) {
  assert.ok(rows.length > 0, `${label}: should produce review rows`);
  rows.forEach((row, index) => {
    assert.ok(Number.isFinite(row.start), `${label}: row ${index + 1} start should be finite`);
    assert.ok(Number.isFinite(row.end), `${label}: row ${index + 1} end should be finite`);
    assert.ok(row.end > row.start, `${label}: row ${index + 1} should have valid timing`);
    if (index > 0) {
      assert.ok(
        row.start >= rows[index - 1].end,
        `${label}: row ${index} and ${index + 1} should not overlap`,
      );
    }
  });
}

function assertReadableRows(rows, label) {
  rows.forEach((row, index) => {
    const text = String(row.text || "").trim();
    assert.ok(text, `${label}: row ${index + 1} should not be empty`);
    assert.ok(
      transcriptWeight(text) <= 20,
      `${label}: row ${index + 1} is too long for proofreading: ${text}`,
    );
  });
}

function assertNoMergeableFragments(rows, label) {
  const merged = repairReviewStructure(rows).rows;
  assert.equal(
    merged.length,
    rows.length,
    `${label}: should not leave short adjacent fragments that the system can merge automatically`,
  );
}

function assertWorkbenchQuality(rows, label) {
  assertCleanTimeline(rows, label);
  assertReadableRows(rows, label);
  assertNoMergeableFragments(rows, label);
}

function assertNoTimingPressure(rows, label) {
  rows.forEach((row, index) => {
    const hints = getSubtitleQualityHints(row, rows[index + 1]);
    assert.equal(
      hints.includes("阅读过快") || hints.includes("时长过短"),
      false,
      `${label}: row ${index + 1} should not leave timing pressure for the user: ${hints.join("、")} / ${row.text}`,
    );
  });
}

function normalizeLikeWorkbench(rows) {
  return repairReviewStructure(rows).rows;
}

const overlappingSegmentRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [
    { start: 174.781, end: 180, text: "哇，我听够了" },
    { start: 179.4, end: 183.364, text: "我以为我们只能给 Kade 最糟糕的最糟糕的，就像这个人 Kade 可以有他" },
    { start: 183.364, end: 185.709, text: "这些都是我的" },
  ],
}, 300));
assertWorkbenchQuality(overlappingSegmentRows, "overlapping ASR segment repair");

const normalizedStringTimes = normalizeReviewRows([
  { id: "string-time", start: "1.25", end: "2.5", speaker: "", text: "字符串时间也要规范化。", translation: "" },
]);
assert.equal(normalizedStringTimes[0].start, 1.25);
assert.equal(normalizedStringTimes[0].end, 2.5);
assert.equal(normalizedStringTimes[0].speaker, "未标注");

const snapshotTimelineRepair = repairReviewTimelinePreservingEmpty([
  { id: "a", start: "0", end: "2", speaker: "未标注", text: "旧快照第一条。", translation: "" },
  { id: "b", start: "1.5", end: "3", speaker: "未标注", text: "旧快照第二条。", translation: "" },
  { id: "empty", start: "3", end: "3", speaker: "未标注", text: "", translation: "" },
  { id: "c", start: "2.7", end: "5", speaker: "未标注", text: "空行后的旧快照。", translation: "" },
]);
assert.equal(snapshotTimelineRepair[2].id, "empty", "timeline repair should preserve explicit empty rows");
assert.equal(snapshotTimelineRepair[2].text, "");
assertCleanTimeline(snapshotTimelineRepair.filter((row) => row.text), "snapshot timeline repair");

const longChineseRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 16,
    text: "我们先看整体结论然后再处理细节如果还有问题继续复核不要把这种错误作为提示交给用户解决而是作为功能问题解决。",
  }],
}, 16));
assert.ok(longChineseRows.length >= 4, "long Chinese ASR rows should be split into multiple proofreading rows");
assertWorkbenchQuality(longChineseRows, "long Chinese ASR row repair");

const realisticProductSpeechRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 38,
    text: "这里是一个真实转写场景我们先看一下这个视频的主要内容然后确认每一段字幕是不是方便阅读如果出现时间重叠或者单条过长系统应该自动处理而不是要求用户自己判断怎么修复好的我们继续看下一段这部分讲的是模型配置和转写服务如果服务返回的文本没有标点也要尽量拆成适合校对的片段",
  }],
}, 38));
assertWorkbenchQuality(realisticProductSpeechRows, "realistic product speech ASR row repair");
assertNoTimingPressure(realisticProductSpeechRows, "realistic product speech ASR row repair");
assert.deepEqual(
  realisticProductSpeechRows.map((row) => row.text),
  [
    "这里是一个真实转写场景",
    "我们先看一下这个视频的主要内容",
    "然后确认每一段字幕",
    "是不是方便阅读",
    "如果出现时间重叠或者单条过长",
    "系统应该自动处理",
    "而不是要求用户自己判断怎么修复",
    "好的我们继续看下一段",
    "这部分讲的是模型配置和转写服务",
    "如果服务返回的文本没有标点",
    "也要尽量拆成适合校对的片段",
  ],
);

const compressedChineseRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 1,
    text: "我们现在必须马上离开这里否则就来不及了",
  }],
}, 20));
assertWorkbenchQuality(compressedChineseRows, "compressed Chinese ASR row repair");
assertNoTimingPressure(compressedChineseRows, "compressed Chinese ASR row repair");

const compressedEnglishRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 1,
    text: "I have spent the last three weeks sending people into that river to look for that bell and they have not found it",
  }],
}, 20));
assertWorkbenchQuality(compressedEnglishRows, "compressed English ASR row repair");
assertNoTimingPressure(compressedEnglishRows, "compressed English ASR row repair");

const terminalShortSubtitleRows = normalizeLikeWorkbench([
  { id: "first", start: 0, end: 2.4, speaker: "未标注", text: "第一条内容。", translation: "" },
  { id: "tail", start: 2.5, end: 2.8, speaker: "未标注", text: "末尾短字幕", translation: "" },
]);
assertNoTimingPressure(terminalShortSubtitleRows, "terminal short subtitle repair");
assert.ok(
  terminalShortSubtitleRows.at(-1).end - terminalShortSubtitleRows.at(-1).start >= 0.7,
  "terminal short subtitle should be extended instead of left for manual repair",
);

const longMixedRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 12,
    text: "我以为我们只能给 Kade 最糟糕的最糟糕的就像这个人 Kade 可以有他在这里继续补充后面的长句。",
  }],
}, 12));
assert.deepEqual(
  longMixedRows.map((row) => row.text),
  ["我以为我们只能给 Kade 最糟糕的最糟糕的", "就像这个人 Kade", "可以有他在这里继续补充后面的长句。"],
);
assertWorkbenchQuality(longMixedRows, "mixed Chinese English ASR row repair");

const implicitQuestionRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 7,
    text: "你会想要活着吗我希望活着这个可以吗我们现在继续处理",
  }],
}, 7));
assert.deepEqual(
  implicitQuestionRows.map((row) => row.text),
  ["你会想要活着吗", "我希望活着", "这个可以吗", "我们现在继续处理"],
);
assertWorkbenchQuality(implicitQuestionRows, "implicit Chinese question boundary repair");

const lowercaseEnglishRows = normalizeLikeWorkbench(rowsFromAsrResult({
  text: "yes. maybe you shouldn't be here. this should still become readable subtitle rows.",
}, 30));
assert.deepEqual(
  lowercaseEnglishRows.map((row) => row.text),
  ["yes.", "maybe you shouldn't be here.", "this should still become readable subtitle rows."],
);
assertWorkbenchQuality(lowercaseEnglishRows, "lowercase English sentence repair");

const fragmentRows = normalizeLikeWorkbench([
  { id: "a", start: 0, end: 0.48, speaker: "未标注", text: "我以为", translation: "" },
  { id: "b", start: 0.52, end: 0.96, speaker: "未标注", text: "我们", translation: "" },
  { id: "c", start: 1, end: 2.1, speaker: "未标注", text: "只能给 Kade", translation: "" },
  { id: "d", start: 2.9, end: 4.2, speaker: "未标注", text: "最糟糕的。", translation: "" },
]);
assert.deepEqual(
  fragmentRows.map((row) => row.text),
  ["我以为我们只能给 Kade", "最糟糕的。"],
);
assertWorkbenchQuality(fragmentRows, "short fragment repair");

const importedSubtitleRows = normalizeLikeWorkbench(parseSubtitle([
  "1",
  "00:00:01,000 --> 00:00:04,000",
  "第一条内容。",
  "",
  "2",
  "00:00:03,500 --> 00:00:08,000",
  "第二条内容很长需要系统自动处理不要把时间重叠和断句问题交给用户。",
].join("\n")));
assertWorkbenchQuality(importedSubtitleRows, "subtitle import auto repair");

const compressedOverlappingSubtitleRows = normalizeLikeWorkbench(parseSubtitle([
  "1",
  "00:00:00,000 --> 00:00:00,300",
  "这是一条非常非常长并且时间极短的字幕内容",
  "",
  "2",
  "00:00:00,250 --> 00:00:02,000",
  "后一条和上一条时间重叠",
  "",
  "3",
  "00:00:04,000 --> 00:00:04,300",
  "第三条也过短",
].join("\n")));
assertNoTimingPressure(compressedOverlappingSubtitleRows, "compressed overlapping subtitle import repair");
assertCleanTimeline(compressedOverlappingSubtitleRows, "compressed overlapping subtitle import repair");
assert.deepEqual(
  compressedOverlappingSubtitleRows.map((row) => row.text),
  ["这是一条非常非常长", "并且时间极短的字幕内容", "后一条和上一条时间重叠", "第三条也过短"],
);

const boundedMediaRepair = repairReviewStructure([
  { id: "a", start: 0, end: 0.3, speaker: "未标注", text: "第一条很长需要自动处理", translation: "" },
  { id: "b", start: 0.25, end: 1.1, speaker: "未标注", text: "第二条也很长需要自动处理", translation: "" },
  { id: "c", start: 1.05, end: 1.3, speaker: "未标注", text: "第三条过短", translation: "" },
], { maxEnd: 2.2 }).rows;
assertCleanTimeline(boundedMediaRepair, "bounded media repair");
assert.ok(
  boundedMediaRepair.at(-1).end <= 2.2,
  `bounded media repair should not create subtitle timecodes beyond media duration: ${boundedMediaRepair.at(-1).end}`,
);

const validBoundedAsrTimingRows = repairReviewStructure([
  { id: "a", start: 0, end: 0.5, speaker: "未标注", text: "音频转写第一句。", translation: "" },
  { id: "b", start: 0.6, end: 0.95, speaker: "未标注", text: "音频转写第二句。", translation: "" },
], { maxEnd: 1 }).rows;
assert.deepEqual(
  validBoundedAsrTimingRows.map((row) => Number(row.start.toFixed(3))),
  [0, 0.6],
  "bounded repair should preserve valid ASR seek points instead of compressing them",
);

const explicitSegmentRows = rowsFromAsrResult({
  segments: [
    { start: 0, end: 0.5, text: "音频转写第一句。" },
    { start: 0.6, end: 0.95, text: "音频转写第二句。" },
  ],
}, 1);
assert.deepEqual(
  explicitSegmentRows.map((row) => Number(row.start.toFixed(2))),
  [0, 0.6],
  "explicit ASR segment timing should not be compressed by minimum subtitle duration repair",
);

const untimedFallbackRows = rowsFromAsrResult({ text: "音频转写第一句。音频转写第二句。" }, 1);
assert.deepEqual(
  untimedFallbackRows.map((row) => Number(row.start.toFixed(2))),
  [0, 0.55],
  "untimed fallback should keep a small seek gap instead of hard-joining subtitle rows",
);

const importedBoundaryDuplicateRows = normalizeLikeWorkbench(parseSubtitle([
  "1",
  "00:00:00,000 --> 00:00:02,400",
  "边界重复句。新的内容。",
  "",
  "2",
  "00:00:02,100 --> 00:00:04,800",
  "新的内容。第三句。",
].join("\n")));
assert.deepEqual(
  importedBoundaryDuplicateRows.map((row) => row.text),
  ["边界重复句。新的内容。", "第三句。"],
  "imported or restored rows should trim repeated ASR chunk boundaries automatically",
);
assertWorkbenchQuality(importedBoundaryDuplicateRows, "subtitle import boundary duplicate repair");

const preservedEmptyRepair = repairReviewStructurePreservingEmpty([
  { id: "keep-empty", start: 0, end: 1, speaker: "未标注", text: "", translation: "" },
  {
    id: "long-after-empty",
    start: 1,
    end: 9,
    speaker: "未标注",
    text: "我知道你不相信我但是我们现在必须离开这里否则就来不及了",
    translation: "",
  },
]).rows;
assert.equal(preservedEmptyRepair[0].id, "keep-empty", "empty rows should be preserved for explicit export blocking");
assert.equal(preservedEmptyRepair[0].text, "");
assert.ok(preservedEmptyRepair.length >= 3, "non-empty rows should still be repaired when an empty row exists elsewhere");
assert.ok(
  preservedEmptyRepair.slice(1).every((row) => transcriptWeight(row.text) <= 20),
  `non-empty rows after an empty row should be readable: ${preservedEmptyRepair.map((row) => row.text).join(" | ")}`,
);

const emptyBoundaryRepair = repairReviewStructurePreservingEmpty([
  { id: "before-empty", start: 0, end: 2, speaker: "未标注", text: "第一条内容。", translation: "" },
  { id: "empty-boundary", start: 1.5, end: 1.5, speaker: "未标注", text: "", translation: "" },
  { id: "after-empty", start: 1.4, end: 3, speaker: "未标注", text: "第二条内容。", translation: "" },
]).rows;
assert.equal(emptyBoundaryRepair.find((row) => row.id === "empty-boundary")?.text, "");
assertCleanTimeline(emptyBoundaryRepair, "empty boundary timeline repair");

assert.deepEqual(
  splitTranscriptIntoSentences("The U.S. Army reviewed the audio. next sentence starts lowercase."),
  ["The U.S. Army reviewed the audio.", "next sentence starts lowercase."],
);

console.log("transcription quality gate passed");
