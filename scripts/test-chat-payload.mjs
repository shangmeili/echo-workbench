import assert from "node:assert/strict";
import { buildChatCompletionPayload } from "../vite.config.mjs";

const messages = [{ role: "user", content: "校对这段转写文本。" }];

const defaultPayload = buildChatCompletionPayload({ messages });
assert.equal(defaultPayload.model, "MiniMax-M3");
assert.equal(defaultPayload.reasoning_split, true);
assert.deepEqual(defaultPayload.thinking, { type: "disabled" });

const minimaxM3China = buildChatCompletionPayload({
  provider: {
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
  },
  messages,
});
assert.equal(minimaxM3China.reasoning_split, true);
assert.deepEqual(minimaxM3China.thinking, { type: "disabled" });

const minimaxM2 = buildChatCompletionPayload({
  provider: {
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7",
  },
  messages,
});
assert.equal(minimaxM2.reasoning_split, true);
assert.equal("thinking" in minimaxM2, false);

for (const provider of [
  { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
]) {
  const payload = buildChatCompletionPayload({ provider, messages });
  assert.equal("reasoning_split" in payload, false, `${provider.baseUrl} should not receive MiniMax reasoning_split`);
  assert.equal("thinking" in payload, false, `${provider.baseUrl} should not receive MiniMax thinking`);
}

console.log("chat payload tests passed");
