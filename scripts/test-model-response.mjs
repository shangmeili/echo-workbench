import assert from "node:assert/strict";
import { getCorrectedTextValue, getTranslationValue, parseJsonArrayFromModelText } from "../src/modelResponse.js";

assert.deepEqual(parseJsonArrayFromModelText("```json\n[{\"id\":\"row-1\",\"translation\":\"Hello\"}]\n```"), [
  { id: "row-1", translation: "Hello" },
]);

assert.deepEqual(parseJsonArrayFromModelText("{\"rows\":[{\"id\":\"row-1\",\"text\":\"校正文本\"}]}"), [
  { id: "row-1", text: "校正文本" },
]);

assert.deepEqual(parseJsonArrayFromModelText("{\"row-1\":\"Hello\",\"row-2\":\"World\"}"), [
  { id: "row-1", text: "Hello", translation: "Hello" },
  { id: "row-2", text: "World", translation: "World" },
]);

assert.equal(getTranslationValue({ id: "row-1", value: "目标译文" }), "目标译文");
assert.equal(getTranslationValue({ id: "row-1", "译文": "中文键译文" }), "中文键译文");
assert.equal(getCorrectedTextValue({ corrected_text: "校正文" }), "校正文");
assert.equal(getCorrectedTextValue({ value: "键值校正" }), "键值校正");

assert.throws(() => parseJsonArrayFromModelText("没有 JSON"), /模型没有返回可解析/);

console.log("model response tests passed");
