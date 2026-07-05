import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync("src/App.jsx", "utf8");
const mainSource = readFileSync("src/main.jsx", "utf8");
const readme = readFileSync("README.md", "utf8");
const indexHtml = readFileSync("index.html", "utf8");

const featureBlockMatch = appSource.match(/const featureCards = \[([\s\S]*?)\];/);
assert.ok(featureBlockMatch, "featureCards block should exist");
const featureBlock = featureBlockMatch[1];

const titles = [...featureBlock.matchAll(/title: "([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(titles, ["视频智能字幕", "视频转写", "音频转写", "字幕文件翻译"]);

assert.equal(/撰写|写作|Token Plan/.test(featureBlock), false, "home feature cards should not expose off-scope wording");
assert.equal(/视频智能字幕[\s\S]*?从音轨生成转写/.test(featureBlock), false, "default video subtitle card should not imply audio extraction is mandatory");
assert.equal(/视频转写[\s\S]*?从音轨转写/.test(featureBlock), false, "default video transcription card should not imply audio extraction is mandatory");
assert.doesNotMatch(featureBlock, /implemented|调用当前转写服务|生成译文并导出双语字幕/, "home feature cards should read like product entries, not implementation notes");
assert.doesNotMatch(appSource, /<em>进入工作台<\/em>/, "home feature cards should not duplicate the primary entry action copy");
assert.doesNotMatch(appSource, /补充音频/, "user-facing app copy should describe optional backup audio without implying video requires supplemental audio");
assert.doesNotMatch(readme, /补充音频/, "README should not imply supplemental audio is part of the normal video transcription flow");
assert.doesNotMatch(appSource, /已补充的音频|补充独立音频/, "user-facing app copy should call fallback audio optional backup audio");
assert.doesNotMatch(readme, /已补充的音频|补充独立音频/, "README should call fallback audio optional backup audio");
assert.doesNotMatch(appSource, /文本模型待验证/, "configured text model state should not imply verification blocks proofreading or export");
assert.match(appSource, /文本模型已配置/, "configured but untested text model state should be worded as configured");
assert.doesNotMatch(appSource, /转写已验|文本已配|转写已配/, "result-state model badges should avoid abbreviated status labels");

assert.match(readme, /MiniMax-M3 当前在本项目中用于转写\/字幕文本后的清理、摘要和跨语言翻译，不作为 ASR 转写模型。/);
assert.match(readme, /默认百炼 Fun-ASR 会直接提交原始音视频/);
assert.match(readme, /阿里云百炼 Qwen3-ASR 文件转写/);
assert.match(readme, /选择 5-15 秒清晰语音样本后再测试/);
assert.doesNotMatch(readme, /未选择样本时只做最小连通性测试/);

assert.match(indexHtml, /<link rel="icon" type="image\/png" href="\/assets\/brand-icon\.png\?v=[\d-]+" \/>/);
assert.doesNotMatch(indexHtml, /brand-logo/, "browser tab should not reference the horizontal wordmark");
assert.doesNotMatch(indexHtml, /favicon\.svg/, "browser tab should use the uploaded brand icon instead of the older generated favicon");
assert.match(indexHtml, /<title>&nbsp;<\/title>/, "browser tab title should use a non-visible blank so the tab only shows the favicon without visible fallback text");
assert.doesNotMatch(indexHtml, /<title>\s*回响工作台\s*<\/title>/, "browser tab should not show the product name next to the favicon");
assert.match(mainSource, /ICON_ONLY_TAB_TITLE = "\\u00a0";/, "runtime title should keep a non-visible blank so the tab only shows the favicon");
assert.doesNotMatch(mainSource, /document\.title\s*=\s*["']回响工作台["']/, "runtime should not restore a visible tab title");
assert.doesNotMatch(appSource, /document\.title\s*=\s*["']回响工作台["']/, "app runtime should not restore a visible tab title");
assert.match(mainSource, /new MutationObserver\(setIconOnlyTabTitle\)/, "runtime should keep the tab title icon-only if a later script mutates it");
assert.match(mainSource, /window\.addEventListener\("pageshow", setIconOnlyTabTitle\)/, "runtime should re-apply the icon-only title after browser page restore");
assert.match(appSource, /label: "Google Gemini"[\s\S]*baseUrl: "https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai"/, "text model presets should include Gemini's official OpenAI-compatible endpoint");
assert.doesNotMatch(appSource, /label: "Anthropic|label: "Claude/, "do not expose native Claude/Anthropic as an OpenAI-compatible provider without a matching server adapter");
assert.doesNotMatch(appSource, /kimi-k2\.7|qwen3-max|gpt-5"/, "provider presets should avoid speculative or unsupported model ids; users can fetch account-specific models instead");
assert.match(appSource, /model: "deepseek-v4-flash"/, "DeepSeek preset should default to the current official v4 flash model");
assert.match(appSource, /models: \["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"\]/, "DeepSeek preset should keep legacy aliases after current v4 models");
assert.match(appSource, /DeepSeek 旧别名将于 2026-07-24 弃用/, "DeepSeek legacy model aliases should warn before deprecation");
assert.match(appSource, /baseUrl: "https:\/\/api\.moonshot\.ai\/v1"/, "Kimi preset should use the current official Moonshot endpoint");
assert.match(appSource, /model: "kimi-k2\.6"/, "Kimi preset should default to the current general-purpose model");
assert.match(appSource, /models: \["kimi-k2\.6", "kimi-latest", "kimi-k2-thinking", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"\]/, "Kimi preset should include current Kimi models while retaining legacy Moonshot ids");
assert.match(appSource, /Kimi \/ Moonshot 官方 OpenAI Compatible 端点已更新为 https:\/\/api\.moonshot\.ai\/v1/, "Kimi legacy endpoint should warn users to use the current official endpoint");

assert.doesNotMatch(appSource, /<Upload size=\{18\} \/>\s*导入/, "import actions should use the downward arrow icon");
assert.doesNotMatch(appSource, /<Download size=\{18\} \/>\s*\{primaryExportLabel\}/, "export actions should use the upward arrow icon");
assert.match(appSource, /<Download size=\{18\} \/>\s*\{testSample \? "更换样本" : "选择样本"\}/, "selecting an ASR test sample is an import-style action");
assert.match(appSource, /<Download size=\{15\} \/>\s*关联\{isAudioFlow \? "音频" : "视频"\}/, "associating local media should use the import-style icon");
assert.match(appSource, /<Download size=\{18\} \/>\s*导入术语/, "term import should use the downward import icon");
assert.match(appSource, /<Upload size=\{18\} \/>\s*导出 CSV/, "term export should use the upward export icon");
assert.doesNotMatch(appSource, /<Upload size=\{18\} \/>\s*导入术语/, "term import should not use the export icon");
assert.doesNotMatch(appSource, /<Download size=\{18\} \/>\s*导出 CSV/, "term export should not use the import icon");
assert.match(appSource, /aria-label=\{`继续处理 \$\{item\.name\}`\}/, "recent project rows should expose a clear continue action name");
const brandIconHeader = readFileSync("public/assets/brand-icon.png").subarray(0, 8).toString("hex");
assert.equal(brandIconHeader, "89504e470d0a1a0a", "favicon should point to a real PNG brand icon asset");

console.log("product copy tests passed");
