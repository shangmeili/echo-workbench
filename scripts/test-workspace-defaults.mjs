import assert from "node:assert/strict";
import { defaultWorkspaceState, workspaceDefaultsForFeature } from "../src/workspaceDefaults.js";

assert.equal(defaultWorkspaceState.draft, "");
assert.equal(defaultWorkspaceState.transcriptionContext, "");
assert.equal(defaultWorkspaceState.sourceLanguage, "中文");
assert.equal(defaultWorkspaceState.targetLanguage, "英文");
assert.equal(defaultWorkspaceState.exportFormat, "");
assert.equal(defaultWorkspaceState.lastTranscriptionStatus, null);
assert.equal(workspaceDefaultsForFeature("video-subtitles").sourceLanguage, "中文");
assert.equal(workspaceDefaultsForFeature("video-subtitles").targetLanguage, "英文");
assert.equal(workspaceDefaultsForFeature("video-transcribe").sourceLanguage, "中文");
assert.equal(workspaceDefaultsForFeature("video-transcribe").targetLanguage, "英文");
assert.equal(workspaceDefaultsForFeature("audio-transcribe").sourceLanguage, "中文");
assert.equal(workspaceDefaultsForFeature("audio-transcribe").targetLanguage, "英文");
assert.equal(workspaceDefaultsForFeature("subtitle-translate").sourceLanguage, "中文");
assert.equal(workspaceDefaultsForFeature("subtitle-translate").targetLanguage, "英文");

console.log("workspace default tests passed");
