import assert from "node:assert/strict";
import { rowsFromAsrResult } from "../src/asrRows.js";
import { getSubtitleQualityHints, repairReviewStructure } from "../src/reviewRows.js";

const productPhrases = [
  "用户点击开始转写以后按钮变成转写中但是过一段时间又恢复成开始转写页面没有告诉我到底失败在哪里这类错误不应该作为提示由用户解决而是作为功能问题解决",
  "这个项目的主要功能是转写不是翻译翻译只应该作为源语言和目标语言不一致时的附加功能",
  "普通用户无法判断模型配置测试失败的原因页面需要说明具体原因并给出可以自动修复的动作",
  "转写服务返回的时间轴重叠和断句异常不能交给用户自己处理应该在导入阶段自动修复",
  "所有字幕转写单条过长没有按照合理的断句会严重影响校对效率",
  "从本地副本打开继续处理应该回到校对界面并恢复媒体预览和当前段落",
  "上传视频后应该直接可以开始转写如果模型返回失败时页面不能只是恢复成开始转写按钮",
  "字幕文件翻译应该保留原始时间码并生成目标语言字幕不能让用户重新整理时间轴",
  "视频智能字幕需要先生成可校对的转写文本再按源语言和目标语言决定是否翻译",
];

const badBoundaryPattern = /(开始\|转写|转写\|不是|不是\|翻译|源语言\|和目标语言|普通\|用户|用户\|无法判断|时间\|重叠|时间码\|可能|合理\|的断句|不能\|只是|由\|用户|给\|用户|用户\|自己|自动\|修复|当前\|段落|媒体\|预览|本地\|副本|继续\|处理|校对\|界面|模型配置\|测试失败|具体\|原因|作为\|提示|原始\|时间码|重新\|整理时间轴)/;
const weakEndingPattern = /(不能|只是|而|由|给|和|的|在|成|为|与|或|作为|应该|需要|生成|重新整)$/;
const hardQualityHints = new Set(["时间无效", "时间重叠", "单条过长", "阅读过快"]);

function stressScenarios(phrase, cutA, cutB) {
  const first = phrase.slice(0, cutA);
  const second = phrase.slice(Math.max(0, cutA - 2), cutB);
  const third = phrase.slice(Math.max(0, cutB - 2));
  return [
    {
      name: "single compressed segment",
      result: { segments: [{ start: 0, end: 20, text: phrase }] },
    },
    {
      name: "two overlapping segments",
      result: {
        segments: [
          { start: 0, end: 9, text: first },
          { start: 8.2, end: 20, text: phrase.slice(Math.max(0, cutA - 2)) },
        ],
      },
    },
    {
      name: "three overlapping fragments",
      result: {
        segments: [
          { start: 0, end: 7, text: first },
          { start: 6.2, end: 13, text: second },
          { start: 12.3, end: 20, text: third },
        ],
      },
    },
  ];
}

const failures = [];
let scenarioCount = 0;

for (const phrase of productPhrases) {
  for (const cutA of [8, 12, 16, 20, 24, 28, 32]) {
    for (const cutB of [cutA + 4, cutA + 8, cutA + 12]) {
      for (const scenario of stressScenarios(phrase, cutA, cutB)) {
        scenarioCount += 1;
        const rows = repairReviewStructure(rowsFromAsrResult(scenario.result, 20), { maxEnd: 20 }).rows;
        const joined = rows.map((row) => row.text).join("|");
        const hints = rows
          .flatMap((row, index) => getSubtitleQualityHints(row, rows[index + 1]))
          .filter((hint) => hardQualityHints.has(hint));
        const weakRows = rows.filter((row) => weakEndingPattern.test(row.text)).map((row) => row.text);
        const badBoundary = joined.match(badBoundaryPattern)?.[0] || "";
        if (hints.length || weakRows.length || badBoundary) {
          failures.push({
            phrase,
            scenario: scenario.name,
            hints,
            weakRows,
            badBoundary,
            joined,
          });
        }
      }
    }
  }
}

assert.deepEqual(
  failures,
  [],
  `ASR structure stress should not leave timing or readability repair to users: ${JSON.stringify(failures.slice(0, 10), null, 2)}`,
);

console.log(`asr structure stress tests passed (${scenarioCount} scenarios)`);
