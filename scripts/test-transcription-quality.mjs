import assert from "node:assert/strict";
import {
  mergeShortAdjacentAsrRows,
  repairAsrTimeline,
  rowsFromAsrResult,
  splitTranscriptIntoSentences,
  transcriptWeight,
} from "../src/asrRows.js";

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
  const merged = mergeShortAdjacentAsrRows(rows, {
    maxGapSeconds: 0.85,
    maxCombinedDuration: 5.8,
  });
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

function normalizeLikeWorkbench(rows) {
  return repairAsrTimeline(mergeShortAdjacentAsrRows(repairAsrTimeline(rows), {
    maxGapSeconds: 0.85,
    maxCombinedDuration: 5.8,
  }));
}

const overlappingSegmentRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [
    { start: 174.781, end: 180, text: "哇，我听够了" },
    { start: 179.4, end: 183.364, text: "我以为我们只能给 Kade 最糟糕的最糟糕的，就像这个人 Kade 可以有他" },
    { start: 183.364, end: 185.709, text: "这些都是我的" },
  ],
}, 300));
assertWorkbenchQuality(overlappingSegmentRows, "overlapping ASR segment repair");

const longChineseRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 16,
    text: "我们先看整体结论然后再处理细节如果还有问题继续复核不要把这种错误作为提示交给用户解决而是作为功能问题解决。",
  }],
}, 16));
assert.ok(longChineseRows.length >= 4, "long Chinese ASR rows should be split into multiple proofreading rows");
assertWorkbenchQuality(longChineseRows, "long Chinese ASR row repair");

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

assert.deepEqual(
  splitTranscriptIntoSentences("The U.S. Army reviewed the audio. next sentence starts lowercase."),
  ["The U.S. Army reviewed the audio.", "next sentence starts lowercase."],
);

console.log("transcription quality gate passed");
