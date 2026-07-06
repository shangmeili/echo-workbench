import assert from "node:assert/strict";
import { asrProviderPresets, defaultAsrProvider } from "../src/asrPresets.js";

const byLabel = new Map(asrProviderPresets.map((preset) => [preset.label, preset]));
const presetLabels = asrProviderPresets.map((preset) => preset.label);

assert.equal(defaultAsrProvider.videoInputMode, "original");
assert.equal(defaultAsrProvider.transport, "dashscope-funasr");
assert.equal(defaultAsrProvider.sendModel, false);
assert.equal(defaultAsrProvider.label, "阿里云百炼 Fun-ASR（中文/多语言）");
assert.equal(defaultAsrProvider.endpoint, "https://dashscope.aliyuncs.com/api/v1");
assert.equal(defaultAsrProvider.model, "fun-asr");

const dashScope = byLabel.get("阿里云百炼 Fun-ASR（中文/多语言）");
assert.ok(dashScope);
assert.equal(dashScope.transport, "dashscope-funasr");
assert.equal(dashScope.endpoint, "https://dashscope.aliyuncs.com/api/v1");
assert.equal(dashScope.model, "fun-asr");
assert.equal(dashScope.videoInputMode, "original");

const dashScopeQwenFiletrans = byLabel.get("阿里云百炼 Qwen3-ASR 文件转写");
assert.ok(dashScopeQwenFiletrans);
assert.equal(dashScopeQwenFiletrans.transport, "dashscope-funasr");
assert.equal(dashScopeQwenFiletrans.endpoint, "https://dashscope.aliyuncs.com/api/v1");
assert.equal(dashScopeQwenFiletrans.model, "qwen3-asr-flash-filetrans");
assert.equal(dashScopeQwenFiletrans.videoInputMode, "original");
assert.equal(dashScopeQwenFiletrans.sendModel, false);

const nvidiaWhisperRiva = byLabel.get("NVIDIA Whisper Large v3（托管 Riva gRPC）");
assert.ok(nvidiaWhisperRiva);
assert.equal(nvidiaWhisperRiva.transport, "nvidia-riva-grpc");
assert.equal(nvidiaWhisperRiva.endpoint, "grpc.nvcf.nvidia.com:443");
assert.equal(nvidiaWhisperRiva.model, "whisper-large-v3");
assert.equal(nvidiaWhisperRiva.functionId, "b702f636-f60c-4a3d-a6f4-f3568c13bd7d");
assert.equal(nvidiaWhisperRiva.languageCode, "multi");
assert.equal(nvidiaWhisperRiva.videoInputMode, "extract");

const openaiWhisper = byLabel.get("OpenAI Whisper API");
assert.ok(openaiWhisper);
assert.equal(openaiWhisper.endpoint, "https://api.openai.com/v1/audio/transcriptions");
assert.equal(openaiWhisper.model, "whisper-1");
assert.equal(openaiWhisper.videoInputMode, "extract");

const groqWhisper = byLabel.get("Groq Whisper（OpenAI Compatible）");
assert.ok(groqWhisper);
assert.equal(groqWhisper.transport, "nvidia-http");
assert.equal(groqWhisper.endpoint, "https://api.groq.com/openai/v1/audio/transcriptions");
assert.equal(groqWhisper.model, "whisper-large-v3-turbo");
assert.equal(groqWhisper.sendModel, true);
assert.equal(groqWhisper.videoInputMode, "extract");

const customHttp = byLabel.get("自定义 HTTP 转写端点");
assert.ok(customHttp);
assert.equal(customHttp.transport, "nvidia-http");
assert.equal(customHttp.endpoint, "");
assert.equal(customHttp.sendModel, true);
assert.equal(presetLabels.includes("待配置 HTTP 转写端点"), false);
assert.equal(presetLabels.includes("自定义 HTTP transcription"), false);

const customRiva = byLabel.get("自定义 NVIDIA Riva gRPC");
assert.ok(customRiva);
assert.equal(customRiva.transport, "nvidia-riva-grpc");
assert.equal(customRiva.endpoint, "grpc.nvcf.nvidia.com:443");
assert.equal(customRiva.functionId, "");
assert.equal(customRiva.videoInputMode, "extract");
assert.equal(presetLabels.some((label) => /Parakeet|Canary/.test(label)), false);

for (const preset of asrProviderPresets) {
  assert.ok(["dashscope-funasr", "nvidia-http", "nvidia-riva-grpc"].includes(preset.transport), `${preset.label} has unsupported transport`);
  assert.equal(preset.videoInputMode, preset.transport === "dashscope-funasr" ? "original" : "extract", `${preset.label} has unexpected video input mode`);
}

console.log("asr preset tests passed");
