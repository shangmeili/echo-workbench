import assert from "node:assert/strict";
import { asrResultHasTiming, dedupeAdjacentAsrRows, detectTranscriptionQualityIssue, groupWordsToRows, joinAsrTokens, mergeShortAdjacentAsrRows, normalizeAsrText, repairAsrTimeline, rowsFromAsrResult, splitTranscriptIntoSentences, transcriptWeight } from "../src/asrRows.js";
import { getSubtitleQualityHints, repairReviewStructure } from "../src/reviewRows.js";

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

assert.deepEqual(
  splitTranscriptIntoSentences("今天我们先导入一段会议视频然后等待系统完成转写如果模型返回的内容没有标点也应该自动拆分成适合校对的段落而不是让用户自己处理时间重叠和断句问题"),
  [
    "今天我们先导入一段会议视频",
    "然后等待系统完成转写",
    "如果模型返回的内容没有标点",
    "也应该自动拆分成适合校对的段落",
    "而不是让用户自己处理时间重叠和断句问题",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("用户看到时间重叠或者单条过长的时候不应该被要求自己修复而是系统在导出前自动整理时间轴和文本结构"),
  ["用户看到时间重叠或者单条过长的时候", "不应该被要求自己修复", "而是系统在导出前自动整理时间轴和文本结构"],
);

assert.ok(
  splitTranscriptIntoSentences("上传视频后系统应该先检查媒体是否可以读取然后再调用转写服务如果服务返回失败页面需要说明具体原因不能只显示开始转写又恢复原状")
    .every((row) => !/(是否|也|才|如果|但是|然后|所以|需要|应该|可以)$/.test(row) && !/^候/.test(row)),
  "Chinese subtitle rows should not end on dangling helper words or split protected words",
);

assert.deepEqual(
  splitTranscriptIntoSentences("我想先确认一下今天这个视频里面提到的几个关键问题第一个是转写结果为什么会出现时间重叠第二个是字幕为什么会被切得很奇怪第三个是用户不应该自己去修这些结构问题"),
  [
    "我想先确认一下今天",
    "这个视频里面提到的几个关键问题",
    "第一个是转写结果",
    "为什么会出现时间重叠",
    "第二个是字幕",
    "为什么会被切得很奇怪",
    "第三个是用户不应该自己去修",
    "这些结构问题",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("我们现在看到的情况是点击开始转写以后按钮会变成转写中但是过一段时间又恢复成开始转写页面没有告诉我到底失败在哪里这对普通用户来说是不可接受的"),
  [
    "我们现在看到的情况是点击开始转写以后",
    "按钮会变成转写中",
    "但是过一段时间又恢复成开始转写页面",
    "没有告诉我到底失败在哪里",
    "这对普通用户来说是不可接受的",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("所有字幕转写单条过长没有按照合理的断句时间重叠也不应该要求用户处理"),
  [
    "所有字幕转写单条过长",
    "没有按照合理的断句",
    "时间重叠也不应该要求用户处理",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("开始转写失败以后页面不能只是恢复按钮状态而应该展示具体失败阶段并保留可重试状态"),
  [
    "开始转写失败以后页面",
    "不能只是恢复按钮状态",
    "而应该展示具体失败阶段",
    "并保留可重试状态",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("导出字幕前系统应该自动整理时间轴用户不应该自己去修这些结构问题"),
  [
    "导出字幕前",
    "系统应该自动整理时间轴",
    "用户不应该自己去修",
    "这些结构问题",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("服务返回失败时页面需要说明具体原因不能只显示开始转写又恢复原状"),
  [
    "服务返回失败时页面",
    "需要说明具体原因不能只显示开始转写",
    "又恢复原状",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("视频上传后应该直接可以开始转写如果模型返回的内容没有标点"),
  [
    "视频上传后应该直接可以开始转写",
    "如果模型返回的内容没有标点",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("界面不应该把翻译放在主流程前面也不应该让转写按钮藏在后处理里面"),
  [
    "界面不应该把翻译放在主流程前面",
    "也不应该让转写按钮藏在后处理里面",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("这类错误不应该作为提示由用户解决而是作为功能问题解决"),
  [
    "这类错误不应该作为提示由用户解决",
    "而是作为功能问题解决",
  ],
);

assert.deepEqual(
  splitTranscriptIntoSentences("昨天我们看了一个会议录屏里面有产品经理开发和运营三个人讨论上线计划大家说话比较快中间还有一些专有名词比如回响工作台和模型配置"),
  [
    "昨天我们看了一个会议录屏里面有",
    "产品经理开发和运营三个人讨论上线计划",
    "大家说话比较快中间还有一些专有名词",
    "比如回响工作台和模型配置",
  ],
);

for (const rows of [
  splitTranscriptIntoSentences("我们现在看到的情况是点击开始转写以后按钮会变成转写中但是过一段时间又恢复成开始转写页面没有告诉我到底失败在哪里这对普通用户来说是不可接受的"),
  splitTranscriptIntoSentences("昨天我们看了一个会议录屏里面有产品经理开发和运营三个人讨论上线计划大家说话比较快中间还有一些专有名词比如回响工作台和模型配置"),
  splitTranscriptIntoSentences("服务返回失败时页面需要说明具体原因不能只显示开始转写又恢复原状"),
  splitTranscriptIntoSentences("视频上传后应该直接可以开始转写如果模型返回的内容没有标点"),
  splitTranscriptIntoSentences("界面不应该把翻译放在主流程前面也不应该让转写按钮藏在后处理里面"),
  splitTranscriptIntoSentences("这类错误不应该作为提示由用户解决而是作为功能问题解决"),
  splitTranscriptIntoSentences("所有字幕转写单条过长没有按照合理的断句时间重叠也不应该要求用户处理"),
  splitTranscriptIntoSentences("开始转写失败以后页面不能只是恢复按钮状态而应该展示具体失败阶段并保留可重试状态"),
]) {
  const joined = rows.join("|");
  assert.doesNotMatch(joined, /这对\|普通用户|普通\|用户|用户\|来说|由\|用户|用户\|解决|产品\|经理|上线\|计划|专有\|名词|返\|回失败|到\|底|合理\|的断句|时间重叠\|也不应该|不能\|只是|把\|翻译|视频上传后\|应该|直接\|可以/, "Chinese hard split should not break common product and subtitle-review phrases");
  assert.doesNotMatch(joined, /(不能|而|由)($|\|)/, "Chinese rows should not end on weak helper words when a better split exists");
}

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
assert.ok(
  longEnglishWordRows.every((row) => !/\b(?:and|or|but|because|that|which|who|to|of|for|in|on|at|with|from|into|as|by|when|where|what|why|how|than)$/i.test(row.text)),
  `word-level English rows should not stop on weak boundary words: ${longEnglishWordRows.map((row) => row.text).join(" | ")}`,
);
assert.equal(longEnglishWordRows.at(-1).end, 4.8);

const abbreviationWordRows = groupWordsToRows([
  { word: "Dr.", start: 0, end: 0.25 },
  { word: "Smith", start: 0.25, end: 0.6 },
  { word: "arrived.", start: 0.6, end: 1 },
]);

assert.deepEqual(abbreviationWordRows.map((row) => row.text), ["Dr. Smith arrived."]);

const timestampWordRows = rowsFromAsrResult({
  words: [
    { word: "Timestamp", timestamp: [0, 0.35] },
    { word: "words", timestamp: [0.4, 0.75] },
    { word: "keep", timestamp: [0.8, 1.05] },
    { word: "timing.", timestamp: [1.1, 1.55] },
  ],
}, 3);

assert.deepEqual(
  timestampWordRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [{ start: 0, end: 1.55, text: "Timestamp words keep timing." }],
  "word-level timestamp arrays should preserve provider timing",
);

const millisecondTimestampWordRows = rowsFromAsrResult({
  words: [
    { word: "Millisecond", timestamp: [0, 350] },
    { word: "words", timestamp: [400, 750] },
    { word: "keep", timestamp: [800, 1050] },
    { word: "timing.", timestamp: [1100, 1550] },
  ],
}, 3);

assert.deepEqual(
  millisecondTimestampWordRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [{ start: 0, end: 1.55, text: "Millisecond words keep timing." }],
  "word-level millisecond timestamp arrays should be normalized to seconds",
);

const mixedSegmentAndWordRows = rowsFromAsrResult({
  segments: [
    {
      start: 0,
      end: 8,
      text: "I have spent the last three weeks sending people into that river to look for that bell and they have not found a thing",
    },
  ],
  words: [
    { word: "I", start: 0, end: 0.2 },
    { word: "have", start: 0.2, end: 0.45 },
    { word: "spent", start: 0.45, end: 0.8 },
    { word: "the", start: 0.8, end: 1.0 },
    { word: "last", start: 1.0, end: 1.25 },
    { word: "three", start: 1.25, end: 1.55 },
    { word: "weeks", start: 1.55, end: 1.95 },
    { word: "sending", start: 1.95, end: 2.4 },
    { word: "people", start: 2.4, end: 2.8 },
    { word: "into", start: 2.8, end: 3.05 },
    { word: "that", start: 3.05, end: 3.25 },
    { word: "river", start: 3.25, end: 3.65 },
    { word: "to", start: 4.1, end: 4.25 },
    { word: "look", start: 4.25, end: 4.55 },
    { word: "for", start: 4.55, end: 4.75 },
    { word: "that", start: 4.75, end: 4.95 },
    { word: "bell", start: 4.95, end: 5.25 },
    { word: "and", start: 5.8, end: 6.0 },
    { word: "they", start: 6.0, end: 6.25 },
    { word: "have", start: 6.25, end: 6.5 },
    { word: "not", start: 6.5, end: 6.75 },
    { word: "found", start: 6.75, end: 7.15 },
    { word: "a", start: 7.15, end: 7.3 },
    { word: "thing", start: 7.3, end: 7.8 },
  ],
}, 8);

assert.deepEqual(
  mixedSegmentAndWordRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 0, end: 3.65, text: "I have spent the last three weeks sending people into that river" },
    { start: 4.1, end: 5.25, text: "to look for that bell" },
    { start: 5.8, end: 7.8, text: "and they have not found a thing" },
  ],
  "when a service returns coarse segments and precise words, ASR rows should use word-level subtitle boundaries",
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

const timestampSegmentRows = rowsFromAsrResult({
  segments: [
    { timestamp: [0, 1.25], text: "Timestamp segment one." },
    { timestamp: [1.25, 2.9], text: "Timestamp segment two." },
  ],
}, 5);

assert.deepEqual(
  timestampSegmentRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 0, end: 1.25, text: "Timestamp segment one." },
    { start: 1.25, end: 2.9, text: "Timestamp segment two." },
  ],
  "ASR rows should preserve timestamp-array segment timing",
);

const millisecondTimestampSegmentRows = rowsFromAsrResult({
  segments: [
    { timestamp: [0, 1250], text: "Millisecond segment one." },
    { timestamp: [1250, 2900], text: "Millisecond segment two." },
  ],
}, 5);

assert.deepEqual(
  millisecondTimestampSegmentRows.map((row) => ({ start: row.start, end: row.end, text: row.text })),
  [
    { start: 0, end: 1.25, text: "Millisecond segment one." },
    { start: 1.25, end: 2.9, text: "Millisecond segment two." },
  ],
  "segment-level millisecond timestamp arrays should be normalized to seconds",
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

for (const scenario of [
  {
    name: "coarse long product failure segment",
    duration: 30,
    result: {
      segments: [{
        start: 0,
        end: 30,
        text: "用户点击开始转写以后按钮变成转写中但是过一段时间又恢复成开始转写页面没有告诉我到底失败在哪里这类错误不应该作为提示由用户解决而是作为功能问题解决",
      }],
    },
    expectedText: /不应该作为提示由用户解决/,
  },
  {
    name: "overlapping repeated service failure prefix",
    duration: 7,
    result: {
      segments: [
        { start: 0, end: 4, text: "服务返回失败时页面需要说明具体原因不能只显示开始转写" },
        { start: 3.1, end: 7, text: "不能只显示开始转写又恢复原状用户不知道发生了什么" },
      ],
    },
    expectedText: /又恢复原状/,
  },
  {
    name: "compressed unpunctuated upload flow",
    duration: 8,
    result: {
      segments: [{
        start: 0,
        end: 0.7,
        text: "视频上传后应该直接可以开始转写如果模型返回的内容没有标点也应该自动拆分成适合校对的段落",
      }],
    },
    expectedText: /视频上传后应该直接可以开始转写/,
  },
  {
    name: "overlapping product translation boundary",
    duration: 15.68,
    result: {
      segments: [
        {
          start: 0,
          end: 5,
          text: "这个项目的主要功能是转写不是翻译翻译只应该作为附加功能在源语言和目",
        },
        {
          start: 4.2,
          end: 10,
          text: "附加功能在源语言和目标语言不一致的时候使用字幕文件翻译也是单独入口",
        },
      ],
    },
    expectedText: /转写不是翻译\|只应该作为附加功能在\|源语言和目标语言/,
    rejectedText: /转写\|不是|源语言和目\||\|附加功能在\||源语言\|和目标语言/,
  },
  {
    name: "fragmented user-facing config failure",
    duration: 20,
    result: {
      segments: [
        { start: 0, end: 7, text: "普通" },
        { start: 6.2, end: 13, text: "普通用户无法判断模型配置测试失败" },
        { start: 12.3, end: 20, text: "试失败的原因页面需要说明具体原因并给出可以自动修复的动作" },
      ],
    },
    expectedText: /普通用户无法判断\|模型配置测试失败的原因/,
    rejectedText: /普通\|用户|用户\|无法判断|模型配置\|测试失败|具体\|原因/,
  },
  {
    name: "overlapping service errors should not be user chores",
    duration: 20,
    result: {
      segments: [
        { start: 0, end: 9, text: "转写服务返回的时" },
        { start: 8.2, end: 20, text: "的时间轴重叠和断句异常不能交给用户自己处理应该在导入阶段自动修复" },
      ],
    },
    expectedText: /转写服务返回的时间轴重叠\|和断句异常不能交给用户自己处理/,
    rejectedText: /时间\|重叠|用户\|自己|给\|用户|的时\|间轴/,
  },
  {
    name: "overlapping reset state keeps full start-transcribe phrase",
    duration: 20,
    result: {
      segments: [
        { start: 0, end: 7, text: "用户点击开始转写以后按钮变成转写中" },
        { start: 6.2, end: 13, text: "但是过一段时间又恢复成" },
        { start: 12.3, end: 20, text: "复成开始转写页面没有告诉我到底失败在哪里这类错误不应该作为提示由用户解决" },
      ],
    },
    expectedText: /恢复成开始转写页面/,
    rejectedText: /恢复成\|开始转写|(^|\|)复成开始|作为\|提示/,
  },
]) {
  const repairedRows = repairReviewStructure(rowsFromAsrResult(scenario.result, scenario.duration), { maxEnd: scenario.duration }).rows;
  const allHints = repairedRows.flatMap((row, index) => getSubtitleQualityHints(row, repairedRows[index + 1]));
  const repairedText = repairedRows.map((row) => row.text).join("|");
  assert.deepEqual(
    allHints.filter((hint) => ["时间无效", "时间重叠", "单条过长", "阅读过快"].includes(hint)),
    [],
    `${scenario.name}: system should repair timing and readability before proofreading`,
  );
  assert.match(
    repairedText,
    scenario.expectedText,
    `${scenario.name}: repaired rows should keep the intended phrase intact`,
  );
  if (scenario.rejectedText) {
    assert.doesNotMatch(
      repairedText,
      scenario.rejectedText,
      `${scenario.name}: repaired rows should remove duplicated or truncated overlap fragments`,
    );
  }
}

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
  /中文源语言不匹配，系统已标记为低可信结果/,
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "这是一段明显的中文识别结果，不应该被当成英文内容继续处理。" },
  ], "英文", 20),
  /英文源语言不匹配，系统已标记为低可信结果/,
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "只有一条短转写。" },
  ], "中文", 180),
  /分段异常偏少，系统已标记为低可信结果/,
);

assert.match(
  detectTranscriptionQualityIssue([
    { text: "短句。" },
    { text: "还是太短。" },
  ], "中文", 80),
  /文本异常偏少，系统已标记为低可信结果/,
);

for (const issueText of [
  detectTranscriptionQualityIssue([{ text: "This transcript is clearly English and not Chinese." }], "中文", 20),
  detectTranscriptionQualityIssue([{ text: "这是一段明显的中文识别结果，不应该被当成英文内容继续处理。" }], "英文", 20),
  detectTranscriptionQualityIssue([{ text: "只有一条短转写。" }], "中文", 180),
  detectTranscriptionQualityIssue([{ text: "短句。" }, { text: "还是太短。" }], "中文", 80),
]) {
  assert.doesNotMatch(issueText, /请|用户.*处理|自行|自己/, "quality issue copy should be system-owned instead of asking users to solve service problems");
}

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
