import assert from "node:assert/strict";
import {
  rowsFromAsrResult,
  splitTranscriptIntoSentences,
  transcriptWeight,
} from "../src/asrRows.js";
import { getSubtitleQualityHints, hasTimingExportIssue, normalizeReviewRows, repairReviewStructure, repairReviewStructurePreservingEmpty, repairReviewTimelinePreservingEmpty } from "../src/reviewRows.js";
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

function assertStableStructuralRepair(inputRows, label, options = {}) {
  const firstPass = repairReviewStructure(inputRows, options).rows;
  const secondPass = repairReviewStructure(firstPass, options).rows;
  assertCleanTimeline(firstPass, label);
  firstPass.forEach((row, index) => {
    const hints = getSubtitleQualityHints(row, firstPass[index + 1]);
    assert.equal(
      hints.includes("单条过长"),
      false,
      `${label}: row ${index + 1} should not remain too long after structural repair: ${row.text}`,
    );
  });
  assert.deepEqual(
    firstPass.map((row) => row.text),
    secondPass.map((row) => row.text),
    `${label}: structural repair should be stable after one pass`,
  );
}

function normalizeLikeWorkbench(rows) {
  return repairReviewStructure(rows).rows;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 2 ** 32;
  };
}

const overlappingSegmentRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [
    { start: 174.781, end: 180, text: "哇，我听够了" },
    { start: 179.4, end: 183.364, text: "我以为我们只能给 Kade 最糟糕的最糟糕的，就像这个人 Kade 可以有他" },
    { start: 183.364, end: 185.709, text: "这些都是我的" },
  ],
}, 300));
assertWorkbenchQuality(overlappingSegmentRows, "overlapping ASR segment repair");

const orphanCjkLeadInRows = normalizeLikeWorkbench([
  { id: "a", start: 174.781, end: 180, speaker: "未标注", text: "之前在《鬼魂笔记》中", translation: "" },
  { id: "b", start: 180, end: 183, speaker: "未标注", text: "为了", translation: "" },
  { id: "c", start: 183, end: 188, speaker: "未标注", text: "寻找那座桥我们继续调查", translation: "" },
]);
assertWorkbenchQuality(orphanCjkLeadInRows, "orphan Chinese lead-in repair");
assert.deepEqual(
  orphanCjkLeadInRows.map((row) => row.text),
  ["之前在《鬼魂笔记》中", "为了寻找那座桥我们继续调查"],
  `orphan Chinese lead-in should merge into the next row: ${orphanCjkLeadInRows.map((row) => row.text).join(" | ")}`,
);

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
assert.ok(
  longChineseRows.every((row) => !/交$/.test(row.text) && !/^给用户/.test(row.text)),
  `long Chinese ASR repair should not split inside the phrase 交给用户: ${longChineseRows.map((row) => row.text).join(" | ")}`,
);

const mergedThenReadableRows = normalizeLikeWorkbench([
  { id: "a", start: 0, end: 0.8, speaker: "未标注", text: "我们先看整体结论", translation: "" },
  { id: "b", start: 0.85, end: 1.5, speaker: "未标注", text: "然后再处理细节如果还有问题继续复核", translation: "" },
  { id: "c", start: 1.55, end: 2.1, speaker: "未标注", text: "不要把错误交给用户解决", translation: "" },
]);
assertWorkbenchQuality(mergedThenReadableRows, "merged fragment readability repair");
assert.ok(
  mergedThenReadableRows.every((row) => !/交$/.test(row.text) && !/^给用户/.test(row.text)),
  `merged fragment readability repair should keep semantic phrases intact: ${mergedThenReadableRows.map((row) => row.text).join(" | ")}`,
);

const manualSplitBoundaryRepair = repairReviewStructure([
  { id: "manual-left", start: 0, end: 0.4, speaker: "未标注", text: "带时间", translation: "" },
  { id: "manual-right", start: 0.4, end: 1.4, speaker: "未标注", text: "范围的开场", translation: "" },
], { preserveBoundaries: [["manual-left", "manual-right"]] }).rows;
assert.deepEqual(
  manualSplitBoundaryRepair.map((row) => row.text),
  ["带时间", "范围的开场"],
  "manual split boundaries should not be immediately merged back by automatic structure repair",
);

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
    "然后确认每一段字幕是不是方便阅读",
    "如果出现时间重叠或者单条过长",
    "系统应该自动处理",
    "而不是要求用户自己判断怎么修复",
    "好的我们继续看下一段",
    "这部分讲的是模型配置和转写服务",
    "如果服务返回的文本没有标点",
    "也要尽量拆成适合校对的片段",
  ],
);

const realisticChineseWorkflowRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [{
    start: 0,
    end: 28,
    text: "今天我们先导入一段会议视频然后等待系统完成转写如果模型返回的内容没有标点也应该自动拆分成适合校对的段落而不是让用户自己处理时间重叠和断句问题",
  }],
}, 28));
assertWorkbenchQuality(realisticChineseWorkflowRows, "realistic Chinese workflow ASR row repair");
assert.deepEqual(
  realisticChineseWorkflowRows.map((row) => row.text),
  [
    "今天我们先导入一段会议视频",
    "然后等待系统完成转写",
    "如果模型返回的内容没有标点",
    "也应该自动拆分成适合校对的段落",
    "而不是让用户自己处理时间重叠和断句问题",
  ],
);
assert.ok(
  realisticChineseWorkflowRows.every((row) => !/(是否|也|才|如果|但是|然后|所以|需要|应该|可以)$/.test(row.text) && !/^候/.test(row.text)),
  `realistic Chinese workflow rows should not leave dangling helper words: ${realisticChineseWorkflowRows.map((row) => row.text).join(" | ")}`,
);

const sequentialChineseMeetingRows = normalizeLikeWorkbench(rowsFromAsrResult({
  text: "今天我们讨论视频转写平台的质量问题首先时间轴不能重叠其次断句要符合语义如果模型返回很长的段落系统应该自动拆分最后导出前要再次校验",
}, 28));
assertWorkbenchQuality(sequentialChineseMeetingRows, "sequential Chinese meeting repair");
assert.deepEqual(
  sequentialChineseMeetingRows.map((row) => row.text),
  [
    "今天我们讨论视频转写平台的质量问题",
    "首先时间轴不能重叠",
    "其次断句要符合语义",
    "如果模型返回很长的段落",
    "系统应该自动拆分",
    "最后导出前要再次校验",
  ],
);

const trailingChineseLeadInRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [
    { start: 0, end: 1.2, text: "今天我们讨论" },
    { start: 1.0, end: 3.4, text: "视频转写平台的质量问题首先" },
    { start: 3.3, end: 5.2, text: "时间轴不能重叠其次断句要符合语义" },
    { start: 5.0, end: 8.8, text: "如果模型返回很长的段落系统应该自动拆分" },
    { start: 8.7, end: 10.5, text: "最后导出前要再次校验" },
  ],
}, 28));
assertWorkbenchQuality(trailingChineseLeadInRows, "trailing Chinese lead-in repair");
assert.ok(
  trailingChineseLeadInRows.every((row) => !/首先$|其次$|再次$/.test(row.text)),
  `trailing Chinese lead-in repair should not leave ordering words at row ends: ${trailingChineseLeadInRows.map((row) => row.text).join(" | ")}`,
);
assert.ok(
  trailingChineseLeadInRows.some((row) => row.text === "首先时间轴不能重叠")
    && trailingChineseLeadInRows.some((row) => row.text === "其次断句要符合语义")
    && trailingChineseLeadInRows.some((row) => row.text === "最后导出前要再次校验"),
  `trailing Chinese lead-in repair should preserve complete ordered clauses: ${trailingChineseLeadInRows.map((row) => row.text).join(" | ")}`,
);

const trailingPurposeLeadInRows = normalizeLikeWorkbench([
  { id: "purpose-a", start: 0, end: 2.2, speaker: "未标注", text: "之前在《鬼魂笔记》中为了", translation: "" },
  { id: "purpose-b", start: 2.2, end: 5.1, speaker: "未标注", text: "寻找那座桥我们继续调查", translation: "" },
]);
assert.deepEqual(
  trailingPurposeLeadInRows.map((row) => row.text),
  ["之前在《鬼魂笔记》中", "为了寻找那座桥我们继续调查"],
  "trailing purpose lead-in should move to the next subtitle row",
);
assertWorkbenchQuality(trailingPurposeLeadInRows, "trailing purpose lead-in repair");

const protectedChineseBoundaryCases = [
  {
    label: "semantic question boundary",
    phrase: "我们今天讨论项目上线前的转写质量首先要确认时间轴不能重叠其次要检查断句是否符合语义最后导出字幕前系统应该自动校验",
    cutA: 28,
    cutB: 35,
    rejected: /断句\|是否/,
    expected: /其次要检查断句是否符合语义/,
  },
  {
    label: "user self-fix boundary",
    phrase: "视频里的说话人停顿很短但是字幕仍然需要清楚表达每句话不能让用户自己判断哪里应该拆开",
    cutA: 28,
    cutB: 31,
    rejected: /仍然\|需要|不能\|让|用户\|自己|哪里\|应该/,
    expected: /不能让用户自己判断哪里应该拆开/,
  },
  {
    label: "large paragraph workbench boundary",
    phrase: "如果转写服务返回一大段没有标点的文本工作台应该自动整理为短句并保留和视频预览同步的时间码",
    cutA: 7,
    cutB: 10,
    rejected: /返\|回|一大\|段|工作台\|应该|自动\|整理/,
    expected: /返回一大段没有标点的文本/,
  },
];

for (const boundaryCase of protectedChineseBoundaryCases) {
  const rows = normalizeLikeWorkbench(rowsFromAsrResult({
    segments: [
      { start: 0, end: 5, text: boundaryCase.phrase.slice(0, boundaryCase.cutA) },
      { start: 4.7, end: 10, text: boundaryCase.phrase.slice(Math.max(0, boundaryCase.cutA - 2), boundaryCase.cutB) },
      { start: 9.7, end: 18, text: boundaryCase.phrase.slice(Math.max(0, boundaryCase.cutB - 2)) },
    ],
  }, 20));
  const joined = rows.map((row) => row.text).join("|");
  assertWorkbenchQuality(rows, `protected Chinese boundary repair: ${boundaryCase.label}`);
  assert.doesNotMatch(joined, boundaryCase.rejected, `protected Chinese boundary repair should remove bad boundary: ${joined}`);
  assert.match(joined, boundaryCase.expected, `protected Chinese boundary repair should keep intended phrase: ${joined}`);
}

const realisticEnglishDialogueRows = normalizeLikeWorkbench(rowsFromAsrResult({
  text: "Previously on The Vampire Diaries You left your son You abandoned your family I was ashamed I had to get out It is beautiful",
}, 12));
assertWorkbenchQuality(realisticEnglishDialogueRows, "realistic English dialogue ASR row repair");
assert.deepEqual(
  realisticEnglishDialogueRows.map((row) => row.text),
  [
    "Previously on The Vampire Diaries",
    "You left your son",
    "You abandoned your family",
    "I was ashamed",
    "I had to get out",
    "It is beautiful",
  ],
);

const questionBoundaryEnglishRows = normalizeLikeWorkbench(rowsFromAsrResult({
  text: "I told you I would come back but you did not believe me now we have to leave before they find us what are you doing here",
}, 18));
assertWorkbenchQuality(questionBoundaryEnglishRows, "question boundary English dialogue repair");
assert.ok(
  questionBoundaryEnglishRows.some((row) => /^what are you doing here$/i.test(row.text)),
  `question boundary repair should start a new subtitle at the question: ${questionBoundaryEnglishRows.map((row) => row.text).join(" | ")}`,
);
assert.ok(
  questionBoundaryEnglishRows.every((row) => !/find$|^us what|I told you I$/i.test(row.text)),
  `question boundary repair should not leave weak English row boundaries: ${questionBoundaryEnglishRows.map((row) => row.text).join(" | ")}`,
);

const overlappingEnglishQuestionRows = normalizeLikeWorkbench(rowsFromAsrResult({
  segments: [
    { start: 0, end: 2, text: "I told you I would" },
    { start: 1.9, end: 4.6, text: "come back but you did not" },
    { start: 4.5, end: 5.1, text: "believe me" },
    { start: 5.05, end: 9, text: "now we have to leave before they find us" },
    { start: 9, end: 11, text: "what are you doing here" },
  ],
}, 18));
assertWorkbenchQuality(overlappingEnglishQuestionRows, "overlapping English question repair");
assert.ok(
  overlappingEnglishQuestionRows.every((row) => !/I told you I$/i.test(row.text)),
  `overlapping English repair should move subject auxiliary pairs together: ${overlappingEnglishQuestionRows.map((row) => row.text).join(" | ")}`,
);

const restoredEnglishBoundaryRows = normalizeLikeWorkbench([
  { id: "weak-with", start: 0, end: 4.58, speaker: "未标注", text: "So if a photon is directed through a plane with", translation: "" },
  { id: "weak-with-next", start: 4.58, end: 8.737, speaker: "未标注", text: "two slits in it and either slit is observed,", translation: "" },
  { id: "weak-before", start: 14.937, end: 19.517, speaker: "未标注", text: "if it's observed after it's left the plane but before", translation: "" },
  { id: "weak-before-next", start: 19.517, end: 21.559, speaker: "未标注", text: "it hits its target,", translation: "" },
  { id: "weak-question", start: 21.559, end: 26.139, speaker: "未标注", text: "it will not have gone through both slits. Agreed. What's", translation: "" },
  { id: "weak-question-next", start: 26.139, end: 27.335, speaker: "未标注", text: "your point?", translation: "" },
]);
assertCleanTimeline(restoredEnglishBoundaryRows, "restored English weak boundary repair");
assert.ok(
  restoredEnglishBoundaryRows.every((row) => !/\b(with|before|what'?s)$/i.test(String(row.text || "").trim())),
  `restored English rows should not leave weak boundary words for manual repair: ${restoredEnglishBoundaryRows.map((row) => row.text).join(" | ")}`,
);
assert.ok(
  restoredEnglishBoundaryRows.some((row) => /^with two slits\b/i.test(row.text)),
  `restored English rows should move with to the following phrase: ${restoredEnglishBoundaryRows.map((row) => row.text).join(" | ")}`,
);
assert.ok(
  restoredEnglishBoundaryRows.some((row) => /before it hits\b/i.test(row.text)),
  `restored English rows should move before into the following phrase: ${restoredEnglishBoundaryRows.map((row) => row.text).join(" | ")}`,
);
assert.ok(
  restoredEnglishBoundaryRows.some((row) => /^What's your point\?/i.test(row.text)),
  `restored English rows should keep the question phrase together: ${restoredEnglishBoundaryRows.map((row) => row.text).join(" | ")}`,
);

const restoredSingleWordContinuationRows = normalizeLikeWorkbench([
  { id: "weak-question-tail", start: 277.32, end: 281.9, speaker: "未标注", text: "And then you say something appropriate in response. To what", translation: "" },
  { id: "weak-question-tail-next", start: 281.9, end: 283.942, speaker: "未标注", text: "end?", translation: "" },
  { id: "weak-pronoun-tail", start: 574.084, end: 577.395, speaker: "未标注", text: "sort of a job? Oh, yeah. I'm", translation: "" },
  { id: "weak-pronoun-tail-next", start: 577.395, end: 584.936, speaker: "未标注", text: "a waitress at the Cheesecake Factory. Oh, I love cheesecake. You're lactose intolerant. I don't eat it.", translation: "" },
  { id: "weak-question-lead", start: 43.117, end: 48.121, speaker: "未标注", text: "Papa Doc's capital. Idea. That's Port-au-Prince. Haiti. - Can I help", translation: "" },
  { id: "weak-question-lead-next", start: 48.121, end: 50.163, speaker: "未标注", text: "you?", translation: "" },
  { id: "weak-tail-clause", start: 1247.866, end: 1252.446, speaker: "未标注", text: "sorry. I really thought if you guys went instead of", translation: "" },
  { id: "weak-tail-clause-next", start: 1252.446, end: 1254.066, speaker: "未标注", text: "me.", translation: "" },
]);
assertCleanTimeline(restoredSingleWordContinuationRows, "single-word English continuation repair");
assert.deepEqual(
  restoredSingleWordContinuationRows.map((row) => row.text),
  [
    "Papa Doc's capital. Idea. That's Port-au-Prince. Haiti.",
    "- Can I help you?",
    "And then you say something appropriate in response.",
    "To what end?",
    "sort of a job? Oh, yeah.",
    "I'm a waitress at the Cheesecake Factory. Oh, I love cheesecake. You're lactose intolerant. I don't eat it.",
    "sorry.",
    "I really thought if you guys went instead of me.",
  ],
  "single-word continuation repair should move weak trailing clauses before proofreading",
);

const translatedWeakBoundaryRows = normalizeLikeWorkbench([
  { id: "translated-left", start: 0, end: 2.8, speaker: "未标注", text: "I can become the Ripper that", translation: "我可以成为那个开膛手", reviewStatus: "confirmed" },
  { id: "translated-right", start: 2.8, end: 4.6, speaker: "未标注", text: "you want.", translation: "你想要的。", reviewStatus: "confirmed" },
]);
assert.deepEqual(
  translatedWeakBoundaryRows.map((row) => row.text),
  ["I can become the Ripper", "that you want."],
  "translated weak boundary repair should move dangling source words before proofreading",
);
assert.deepEqual(
  translatedWeakBoundaryRows.map((row) => row.translation),
  ["", ""],
  "translated weak boundary repair should clear stale translations instead of showing mismatched bilingual rows",
);
assert.ok(
  translatedWeakBoundaryRows.every((row) => row.reviewStatus === "pending"),
  "translated weak boundary repair should reopen affected confirmed rows for review",
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

const englishLeadInRows = normalizeLikeWorkbench([
  { id: "lead", start: 0, end: 2.1, speaker: "未标注", text: "First,", translation: "" },
  { id: "body", start: 2.1, end: 6.1, speaker: "未标注", text: "we upload a media file and wait for the transcription result.", translation: "" },
]);
assert.deepEqual(
  englishLeadInRows.map((row) => row.text),
  ["First, we upload a media file and wait for the transcription result."],
);
assertWorkbenchQuality(englishLeadInRows, "English lead-in fragment repair");

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

const outOfRangeBoundedAsrRepair = repairReviewStructure([
  { id: "out-a", start: 174.781, end: 180, speaker: "未标注", text: "之前在《鬼魂笔记》中", translation: "" },
  { id: "out-b", start: 179.4, end: 183, speaker: "未标注", text: "为了", translation: "" },
  { id: "out-c", start: 183, end: 188, speaker: "未标注", text: "寻找那座桥我们继续调查", translation: "" },
], { maxEnd: 1 }).rows;
assertCleanTimeline(outOfRangeBoundedAsrRepair, "out-of-range bounded ASR repair");
assert.deepEqual(
  outOfRangeBoundedAsrRepair.map((row) => row.text),
  ["之前在《鬼魂笔记》中", "为了寻找那座桥我们继续调查"],
  "out-of-range bounded ASR repair should merge orphan lead-in text into the next subtitle row",
);
assert.ok(
  outOfRangeBoundedAsrRepair.at(-1).end <= 1,
  `out-of-range bounded ASR repair should fit within media duration: ${outOfRangeBoundedAsrRepair.at(-1).end}`,
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

const translatedLongRowRepair = repairReviewStructure([
  {
    id: "translated-long-row",
    start: 0,
    end: 12,
    speaker: "未标注",
    text: "第一部分内容很长需要拆分第二部分继续补充背景信息第三部分给出结论",
    originalText: "第一部分内容很长需要拆分第二部分继续补充背景信息第三部分给出结论",
    translation: "The first part is long and needs splitting. The second part adds background. The third part gives the conclusion.",
  },
], { maxEnd: 12 }).rows;
assert.ok(translatedLongRowRepair.length > 1, "translated long rows should be split for proofreading readability");
assert.ok(
  translatedLongRowRepair.every((row) => String(row.translation || "").trim()),
  `automatic readability repair should keep existing translations aligned: ${translatedLongRowRepair.map((row) => row.translation).join(" | ")}`,
);
assertCleanTimeline(translatedLongRowRepair, "translated long row repair");

const realEnglishBoundaryRepair = repairReviewStructure([
  { id: "real-en-1", start: 680.005, end: 682.947, speaker: "未标注", text: "it's not crazy. It's a paradox.", translation: "" },
  { id: "real-en-2", start: 682.947, end: 686.219, speaker: "未标注", text: "Paradoxes are part of nature. Think about light. Now,", translation: "" },
  { id: "real-en-3", start: 686.219, end: 689.532, speaker: "未标注", text: "if you look at Huygens,light is a wave,", translation: "" },
  { id: "real-en-4", start: 935.201, end: 936.489, speaker: "未标注", text: "Oh,", translation: "" },
  { id: "real-en-5", start: 936.489, end: 939.923, speaker: "未标注", text: "I'll probably say yes. It's just not the kind", translation: "" },
  { id: "real-en-6", start: 939.923, end: 944.138, speaker: "未标注", text: "of thing you ask a guy you just met. Wow.", translation: "" },
], { maxEnd: 945 }).rows;
const realEnglishBoundarySecondPass = repairReviewStructure(realEnglishBoundaryRepair, { maxEnd: 945 }).rows;
assert.deepEqual(
  realEnglishBoundaryRepair.map((row) => row.text),
  realEnglishBoundarySecondPass.map((row) => row.text),
  "real English boundary repair should be stable after one workbench pass",
);
assert.ok(
  realEnglishBoundaryRepair.some((row) => row.text === "Paradoxes are part of nature. Think about light. Now,"),
  `real English boundary repair should not trim Paradoxes into a suffix: ${realEnglishBoundaryRepair.map((row) => row.text).join(" | ")}`,
);
assert.ok(
  realEnglishBoundaryRepair.some((row) => row.text === "Oh, I'll probably say yes. It's just not the kind"),
  `real English short interjections should merge forward before proofreading: ${realEnglishBoundaryRepair.map((row) => row.text).join(" | ")}`,
);

for (let seed = 1; seed <= 120; seed += 1) {
  const random = seededRandom(seed);
  const rowCount = 3 + Math.floor(random() * 10);
  const riskyRows = Array.from({ length: rowCount }, (_, index) => {
    const start = random() * 8 - 1;
    const end = start + random() * 2 - 0.5;
    const text = random() < 0.12
      ? ""
      : random() < 0.35
        ? "这是一条非常非常长并且时间极短的字幕内容后一条和上一条时间重叠"
        : `测试字幕${index}`;
    return { id: `seed-${seed}-${index}`, start, end, speaker: "未标注", text, translation: "" };
  });
  const repairedRows = repairReviewStructurePreservingEmpty(riskyRows, { maxEnd: 10 }).rows
    .filter((row) => String(row.text || "").trim());
  assert.equal(
    hasTimingExportIssue(repairedRows),
    false,
    `seeded risky timeline repair should not leave export-blocking timing issues: seed ${seed}`,
  );
  assert.ok(
    repairedRows.every((row) => row.end <= 10.001),
    `seeded risky timeline repair should stay inside media duration: seed ${seed}`,
  );
}

const mixedStressPhrases = [
  "我们先看整体结论",
  "然后再处理细节",
  "如果还有问题继续复核",
  "不要把错误交给用户解决",
  "而是作为功能问题解决",
  "这里是模型配置",
  "开始转写后没有结果",
  "首先确认音频是否清晰",
  "你先不要开始",
  "我们马上处理",
  "I can become the Ripper",
  "You abandoned your family",
  "This is a stable transcription sample",
];

for (let seed = 1; seed <= 300; seed += 1) {
  const random = seededRandom(seed);
  const rowCount = 2 + Math.floor(random() * 8);
  let cursor = Math.max(0, random() * 2 - 0.5);
  const mixedRows = Array.from({ length: rowCount }, (_, index) => {
    const start = cursor + (random() * 0.5 - 0.15);
    const end = start + random() * 2.2 - 0.2;
    const text = Array.from({ length: 1 + Math.floor(random() * 3) }, () => (
      mixedStressPhrases[Math.floor(random() * mixedStressPhrases.length)]
    )).join(random() < 0.5 ? " " : "");
    cursor = end + (random() * 0.8 - 0.2);
    return {
      id: `mixed-seed-${seed}-${index}`,
      start,
      end,
      speaker: random() < 0.8 ? "未标注" : "S2",
      text,
      translation: "",
    };
  });
  assertStableStructuralRepair(mixedRows, `mixed-language structural repair seed ${seed}`, { maxEnd: 20 });
}

console.log("transcription quality gate passed");
