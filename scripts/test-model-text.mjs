import assert from "node:assert/strict";
import { buildTranslationMessages, formatTermReference, stripWrappingCodeFence } from "../src/modelText.js";

assert.equal(stripWrappingCodeFence("```markdown\n# 标题\n\n正文\n```"), "# 标题\n\n正文");
assert.equal(stripWrappingCodeFence("```\n纯文本\n```"), "纯文本");
assert.equal(stripWrappingCodeFence("# 不需要处理"), "# 不需要处理");
assert.equal(stripWrappingCodeFence("前言\n```markdown\n不是外层代码块\n```"), "前言\n```markdown\n不是外层代码块\n```");
assert.equal(formatTermReference([]), "无");
assert.equal(formatTermReference([{ source: "产品路线图", target: "product roadmap" }]), "产品路线图=product roadmap");

const transcriptMessages = buildTranslationMessages({
  rows: [{ id: "row-1", text: "大家好，今天讨论产品路线图。" }],
  targetLanguage: "英文",
  sourceLanguage: "中文",
  subject: "转写段落",
  transcriptionContext: "产品路线图",
  terms: [{ source: "产品路线图", target: "product roadmap" }],
});
assert.match(transcriptMessages[0].content, /专业转写段落翻译助手/);
assert.match(transcriptMessages[1].content, /下面转写段落逐条翻译/);
assert.match(transcriptMessages[1].content, /保持转写文本自然简洁/);
assert.doesNotMatch(transcriptMessages[1].content, /字幕句子/);

const subtitleMessages = buildTranslationMessages({
  rows: [{ id: "row-1", text: "第一条字幕。" }],
  targetLanguage: "英文",
  sourceLanguage: "中文",
  subject: "字幕",
});
assert.match(subtitleMessages[0].content, /专业字幕翻译助手/);
assert.match(subtitleMessages[1].content, /下面字幕逐条翻译/);
assert.match(subtitleMessages[1].content, /保持字幕句子自然简洁/);

console.log("model text tests passed");
