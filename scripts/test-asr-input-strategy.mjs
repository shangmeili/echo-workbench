import assert from "node:assert/strict";
import { shouldDecodeMediaForAsr, shouldSubmitOriginalMediaForAsr } from "../src/asrInputStrategy.js";

const openAiCompatible = { transport: "nvidia-http", sendModel: true, videoInputMode: "extract" };
const openAiCompatibleDirectVideo = { transport: "nvidia-http", sendModel: true, videoInputMode: "original" };
const nimHttp = { transport: "nvidia-http", sendModel: false };
const rivaGrpc = { transport: "nvidia-riva-grpc", sendModel: false };
const dashScope = { transport: "dashscope-funasr", videoInputMode: "original" };

const video = { name: "meeting.mp4", type: "video/mp4" };
const shortMp3 = { name: "clip.mp3", type: "audio/mpeg" };
const longMp3 = { name: "lecture.mp3", type: "audio/mpeg" };
const wav = { name: "speech.wav", type: "audio/wav" };

assert.equal(shouldSubmitOriginalMediaForAsr(video, openAiCompatible, 3600), false);
assert.equal(shouldDecodeMediaForAsr(video, openAiCompatible, 3600), true);

assert.equal(shouldSubmitOriginalMediaForAsr(video, dashScope, 3600), true);
assert.equal(shouldDecodeMediaForAsr(video, dashScope, 3600), false);
assert.equal(shouldSubmitOriginalMediaForAsr(longMp3, dashScope, 3600), true);
assert.equal(shouldDecodeMediaForAsr(longMp3, dashScope, 3600), false);

assert.equal(shouldSubmitOriginalMediaForAsr(video, openAiCompatibleDirectVideo, 3600), true);
assert.equal(shouldDecodeMediaForAsr(video, openAiCompatibleDirectVideo, 3600), false);

assert.equal(shouldSubmitOriginalMediaForAsr(shortMp3, openAiCompatible, 120), true);
assert.equal(shouldDecodeMediaForAsr(shortMp3, openAiCompatible, 120), false);

assert.equal(shouldSubmitOriginalMediaForAsr(longMp3, openAiCompatible, 3600), false);
assert.equal(shouldDecodeMediaForAsr(longMp3, openAiCompatible, 3600), true);

assert.equal(shouldSubmitOriginalMediaForAsr(video, nimHttp, 120), false);
assert.equal(shouldDecodeMediaForAsr(video, nimHttp, 120), true);

assert.equal(shouldSubmitOriginalMediaForAsr(wav, rivaGrpc, 120), false);
assert.equal(shouldDecodeMediaForAsr(wav, rivaGrpc, 120), false);
assert.equal(shouldSubmitOriginalMediaForAsr(video, rivaGrpc, 3600), true);
assert.equal(shouldDecodeMediaForAsr(video, rivaGrpc, 3600), false);

console.log("asr input strategy tests passed");
