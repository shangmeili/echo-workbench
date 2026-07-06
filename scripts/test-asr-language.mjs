import assert from "node:assert/strict";
import { getAsrLanguageCode, getAsrLanguageCompatibilityWarning } from "../src/asrLanguage.js";

assert.equal(getAsrLanguageCode({ model: "whisper-large-v3", languageCode: "multi" }, "中文"), "zh");
assert.equal(getAsrLanguageCode({ model: "whisper-large-v3", languageCode: "multi" }, "英文"), "en");
assert.equal(getAsrLanguageCode({ transport: "nvidia-riva-grpc", model: "whisper-large-v3", languageCode: "multi" }, "英文"), "en-US");
assert.equal(getAsrLanguageCode({ model: "whisper-large-v3", languageCode: "multi" }, "自动识别"), "multi");
assert.equal(getAsrLanguageCode({ model: "canary-1b-asr", languageCode: "en-US" }, "西班牙文"), "en-US");
assert.equal(getAsrLanguageCode({ model: "parakeet-tdt-0.6b-v2", languageCode: "en-US" }, "中文"), "en-US");
assert.equal(getAsrLanguageCode({ model: "parakeet-tdt-0.6b-v2", languageCode: "en-US" }, "英文"), "en-US");
assert.equal(getAsrLanguageCode({ transport: "nvidia-riva-grpc", model: "parakeet-1.1b-rnnt-multilingual-asr", languageCode: "multi" }, "中文"), "multi");

assert.match(
  getAsrLanguageCompatibilityWarning({ model: "parakeet-ctc-1.1b-asr" }, "中文"),
  /已阻止提交/,
);
assert.doesNotMatch(
  getAsrLanguageCompatibilityWarning({ model: "parakeet-ctc-1.1b-asr" }, "中文"),
  /工作台选择|匹配的源语言|英文素材/,
);
assert.match(
  getAsrLanguageCompatibilityWarning({ transport: "nvidia-riva-grpc", model: "parakeet-1.1b-rnnt-multilingual-asr" }, "中文"),
  /已阻止提交/,
);
assert.match(
  getAsrLanguageCompatibilityWarning({ transport: "nvidia-riva-grpc", model: "whisper-large-v3" }, "中文"),
  /已阻止提交/,
);
assert.equal(getAsrLanguageCompatibilityWarning({ model: "parakeet-ctc-1.1b-asr" }, "英文"), "");
assert.equal(getAsrLanguageCompatibilityWarning({ model: "whisper-large-v3" }, "中文"), "");
assert.equal(getAsrLanguageCompatibilityWarning({ transport: "nvidia-riva-grpc", model: "whisper-large-v3" }, "英文"), "");

console.log("asr language tests passed");
