import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AudioWaveform,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Check,
  ClipboardPaste,
  Clock3,
  Combine,
  Copy,
  Download,
  FileAudio,
  FileText,
  FolderOpen,
  Home,
  Languages,
  LayoutGrid,
  ListChecks,
  Loader2,
  LocateFixed,
  MessageSquareText,
  PenLine,
  Play,
  Repeat2,
  RefreshCw,
  Redo2,
  Scissors,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { asrResultHasTiming, dedupeAdjacentAsrRows, detectTranscriptionQualityIssue, mergeShortAdjacentAsrRows, repairAsrTimeline, rowsFromAsrResult } from "./asrRows.js";
import { ASR_CHUNK_SECONDS, isAsrReadyAudioFile, isOpenAICompatibleAsr, shouldDecodeMediaForAsr, shouldSubmitOriginalMediaForAsr } from "./asrInputStrategy.js";
import { getAsrLanguageCode, getAsrLanguageCompatibilityWarning } from "./asrLanguage.js";
import { asrProviderPresets, defaultAsrProvider } from "./asrPresets.js";
import { buildTranslationMessages, formatTermReference, stripWrappingCodeFence } from "./modelText.js";
import { getCorrectedTextValue, getTranslationValue, parseJsonArrayFromModelText } from "./modelResponse.js";
import { getSubtitleQualityHints, hasTimingExportIssue, normalizeReviewRows, repairReadableReviewRows, repairReviewStructure, repairReviewStructurePreservingEmpty } from "./reviewRows.js";
import { parseSubtitle, parseTimestamp } from "./subtitleImport.js";
import { exportRows, formatClock, validateExportRows } from "./subtitleExport.js";
import { defaultWorkspaceState, workspaceDefaultsForFeature } from "./workspaceDefaults.js";

const STORAGE_KEYS = {
  provider: "echo.provider.v1",
  asrProvider: "echo.asrProvider.v1",
  terms: "echo.terms.v1",
  recents: "echo.recents.v1",
};

const REVIEW_PAGE_SIZE = 30;
const MINIMAX_PROVIDER_LABEL = "MiniMax 中国区";
const DEFAULT_ASR_CLIENT_TIMEOUT_MS = 180_000;
const DEFAULT_MODEL_CLIENT_TIMEOUT_MS = 180_000;

const defaultProvider = {
  label: MINIMAX_PROVIDER_LABEL,
  baseUrl: "https://api.minimaxi.com/v1",
  model: "MiniMax-M3",
  apiKey: "",
  keySource: "input",
  availableModels: [],
  lastTest: null,
  lastModelSync: null,
};

const defaultServerStatus = {
  checking: true,
  envKeyConfigured: false,
  asrEnvKeys: {},
  nvidiaEnvKeyConfigured: false,
  rivaClientAvailable: false,
  rivaClientError: "",
  error: "",
};

const defaultWorkspaceStatus = {
  checking: true,
  configured: false,
  root: "",
  suggestedRoot: "",
  projects: [],
  invalidProjectCount: 0,
  error: "",
};

const EDITABLE_TIMECODE_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?$|^\d+(?:[,.]\d+)?$/;

function parseEditableTimecode(value) {
  const trimmed = String(value || "").trim();
  if (!EDITABLE_TIMECODE_PATTERN.test(trimmed)) return null;
  const parsed = parseTimestamp(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const providerPresets = [
  {
    label: MINIMAX_PROVIDER_LABEL,
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
    models: [
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
      "MiniMax-M2.1",
      "MiniMax-M2.1-highspeed",
      "MiniMax-M2",
    ],
  },
  {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
  },
  {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    models: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  {
    label: "Kimi / Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    models: ["kimi-k2.6", "kimi-latest", "kimi-k2-thinking", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
  },
  {
    label: "Qwen / 阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-max-latest",
    models: ["qwen-max-latest", "qwen-max", "qwen-plus", "qwen-turbo"],
  },
  {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.5-flash",
    models: [
      "gemini-3.5-flash",
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-pro",
    ],
  },
  {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
    models: ["openrouter/auto", "openrouter/free", "openai/gpt-4o", "anthropic/claude-opus-latest", "google/gemini-pro"],
  },
  {
    label: "自定义 OpenAI Compatible",
    baseUrl: "",
    model: "",
    models: [],
  },
];

function normalizeProviderLabel(label) {
  const value = String(label || "");
  if (value.includes("MiniMax")) return MINIMAX_PROVIDER_LABEL;
  return value;
}

function findProviderPreset(label) {
  const normalized = normalizeProviderLabel(label);
  return providerPresets.find((item) => item.label === normalized) || providerPresets[0];
}

function getTextModelCompatibilityNotes(provider = {}) {
  const label = normalizeProviderLabel(provider.label);
  const model = String(provider.model || "").trim();
  const baseUrl = String(provider.baseUrl || "").trim();
  const notes = [];
  if (label === "DeepSeek" && ["deepseek-chat", "deepseek-reasoner"].includes(model)) {
    notes.push("DeepSeek 旧别名将于 2026-07-24 弃用；建议改用 deepseek-v4-flash 或 deepseek-v4-pro。");
  }
  if (label === "Kimi / Moonshot" && /api\.moonshot\.cn\/v1/i.test(baseUrl)) {
    notes.push("Kimi / Moonshot 官方 OpenAI Compatible 端点已更新为 https://api.moonshot.ai/v1。");
  }
  return notes;
}

function findAsrProviderPreset(label) {
  return asrProviderPresets.find((item) => item.label === label) || asrProviderPresets[0];
}

function asrCredentialScope(provider = {}) {
  if (provider.transport === "dashscope-funasr") return "dashscope";
  if (provider.transport === "nvidia-http") {
    try {
      const host = new URL(provider.endpoint || "").hostname;
      if (host.includes("groq.com")) return "groq";
      if (host.includes("openai.com")) return "openai";
      if (host.includes("nvidia.com") || host.includes("nvcf.nvidia.com")) return "nvidia";
      return host || "custom-http";
    } catch {
      return provider.label || "custom-http";
    }
  }
  if (provider.transport === "nvidia-riva-grpc") return "riva-grpc";
  return provider.label || provider.transport || "unknown";
}

function getProviderModelOptions(provider) {
  const preset = findProviderPreset(provider.label);
  return [...new Set([provider.model, ...preset.models, ...(provider.availableModels || [])].filter(Boolean))];
}

function ensureChinaMiniMaxProvider(provider) {
  if (!provider) return defaultProvider;
  const next = { ...defaultProvider, ...provider };
  next.label = normalizeProviderLabel(next.label);
  const isCustomProvider = next.label === "自定义 OpenAI Compatible";
  let usesLegacyMiniMaxHost = false;
  try {
    usesLegacyMiniMaxHost = new URL(next.baseUrl).hostname === ["api", "minimax", "io"].join(".");
  } catch {
    usesLegacyMiniMaxHost = false;
  }
  if (!isCustomProvider && (!next.baseUrl || usesLegacyMiniMaxHost)) {
    next.baseUrl = defaultProvider.baseUrl;
  }
  if (!next.model) next.model = defaultProvider.model;
  next.keySource = "input";
  return next;
}

function ensureAsrProvider(provider) {
  if (!provider) return defaultAsrProvider;
  const next = { ...defaultAsrProvider, ...provider };
  const knownPreset = asrProviderPresets.some((item) => item.label === next.label);
  const hostedWhisperPreset = asrProviderPresets.find((item) => item.label === "NVIDIA Whisper Large v3（托管 Riva gRPC）");
  const emptyLegacyHttpConfig = next.transport === "nvidia-http"
    && !String(next.endpoint || "").trim()
    && /待配置 HTTP|自定义 HTTP transcription|自定义 HTTP 转写端点|NVIDIA NIM HTTP/.test(next.label || "");
  const obsoleteHostedHttp = next.transport === "nvidia-http"
    && (/托管端点模板|HTTP，无本地 SDK|多语言转写/.test(next.label || "") || String(next.endpoint || "").includes(".invocation.api.nvcf.nvidia.com"));
  if (emptyLegacyHttpConfig || obsoleteHostedHttp) {
    const apiKey = next.apiKey || "";
    next.label = defaultAsrProvider.label;
    next.transport = defaultAsrProvider.transport;
    next.endpoint = defaultAsrProvider.endpoint;
    next.functionId = defaultAsrProvider.functionId;
    next.model = defaultAsrProvider.model;
    next.sendModel = defaultAsrProvider.sendModel;
    next.apiKey = apiKey;
    next.lastTest = null;
  } else if (
    hostedWhisperPreset &&
    next.transport === "nvidia-riva-grpc" &&
    (/NVIDIA Whisper Large v3/.test(next.label || "") || next.model === "whisper-large-v3")
  ) {
    const apiKey = next.apiKey || "";
    Object.assign(next, hostedWhisperPreset, { apiKey });
    next.lastTest = null;
  } else if (next.label === "NVIDIA Parakeet ASR（托管 Riva gRPC）") {
    next.label = "自定义 NVIDIA Riva gRPC";
  } else if (next.label === "NVIDIA Canary ASR/AST（托管 Riva gRPC）") {
    next.label = "自定义 NVIDIA Riva gRPC";
  } else if (/NVIDIA Parakeet ASR|NVIDIA Canary ASR/.test(next.label || "")) {
    next.label = "自定义 NVIDIA Riva gRPC";
  } else if (!knownPreset && next.transport === "nvidia-riva-grpc") {
    next.label = "自定义 NVIDIA Riva gRPC";
  } else if (!knownPreset && next.transport === "nvidia-http") {
    next.label = next.sendModel === false ? "NVIDIA NIM HTTP（自部署/远程）" : "自定义 HTTP 转写端点";
  } else if (!knownPreset && next.transport === "dashscope-funasr") {
    next.label = "阿里云百炼 Fun-ASR（中文/多语言）";
  } else if (hostedWhisperPreset && next.label === "NVIDIA Whisper Large v3（多语言转写）") {
    const apiKey = next.apiKey || "";
    Object.assign(next, hostedWhisperPreset, { apiKey });
    next.lastTest = null;
  } else if (next.label === "NVIDIA Whisper Large v3（HTTP，无本地 SDK）") {
    next.label = defaultAsrProvider.label;
  }
  if (!next.transport) next.transport = defaultAsrProvider.transport;
  if (!next.endpoint) {
    next.endpoint = next.transport === "dashscope-funasr"
      ? "https://dashscope.aliyuncs.com/api/v1"
      : next.transport === "nvidia-http"
        ? ""
        : "grpc.nvcf.nvidia.com:443";
  }
  if (!next.languageCode) next.languageCode = defaultAsrProvider.languageCode;
  if (next.sendModel === undefined) {
    next.sendModel = next.transport === "nvidia-http" && !String(next.endpoint || "").includes(".invocation.api.nvcf.nvidia.com");
  }
  if (!next.videoInputMode) next.videoInputMode = next.transport === "dashscope-funasr" ? "original" : "extract";
  return next;
}

function inferRecentTool(item) {
  if (featureCards.some((feature) => feature.id === item?.tool)) return item.tool;
  const meta = String(item?.meta || "");
  const status = String(item?.status || "");
  const text = `${meta} ${status}`;
  if (/音频转写/.test(text)) return "audio-transcribe";
  if (/视频转写|逐字稿|转写文本|文本导入/.test(text)) return "video-transcribe";
  if (/视频智能字幕/.test(text)) return "video-subtitles";
  if (/字幕文件翻译|字幕翻译|字幕文件/.test(text)) return "subtitle-translate";
  if (item?.type === "audio") return "audio-transcribe";
  if (/\.(srt|vtt)$/i.test(item?.name || "")) return "subtitle-translate";
  if (/\.(txt)$/i.test(item?.name || "")) return "video-transcribe";
  return "video-subtitles";
}

function createProjectId() {
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatProjectTime() {
  return new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatWorkspacePath(value) {
  const path = String(value || "").trim();
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 1) return normalized;
  return `.../${parts.at(-1)}`;
}

function cleanProjectNameSnippet(value = "") {
  return String(value || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\b/g, " ")
    .replace(/^\s*(?:Speaker\s*\d+|说话人\s*\d+|旁白|未标注)\s*[:：-]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferManualImportProjectName(rows = [], fallback = "手动导入转写文本") {
  const text = rows
    .map((row) => cleanProjectNameSnippet(row?.text))
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .trim();
  if (!text) return fallback;
  const maxLength = 96;
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function recentSortValue(item) {
  return Number(item?.updatedAt || 0);
}

function mergeRecentProjects(primary = [], secondary = [], limit = Infinity) {
  const byId = new Map();
  [...secondary, ...primary].forEach((item) => {
    if (!item) return;
    const key = item.id || `${item.name}-${item.time}`;
    const existing = byId.get(key);
    byId.set(key, {
      ...(existing || {}),
      ...item,
      hasWorkspaceCopy: Boolean(item.hasWorkspaceCopy || existing?.hasWorkspaceCopy),
    });
  });
  return [...byId.values()]
    .sort((a, b) => recentSortValue(b) - recentSortValue(a))
    .slice(0, limit);
}

function recoverableProjects(recents = [], workspaceStatus = defaultWorkspaceStatus, activeProjectId = "", limit = Infinity) {
  if (!workspaceStatus.configured) return [];
  const workspaceProjects = Array.isArray(workspaceStatus.projects) ? workspaceStatus.projects : [];
  const byId = new Map(workspaceProjects.map((item) => [item.id, { ...item, hasWorkspaceCopy: true }]));
  const activeRecent = recents.find((item) => item.id && item.id === activeProjectId && item.hasWorkspaceCopy);
  if (activeRecent && !byId.has(activeRecent.id)) byId.set(activeRecent.id, activeRecent);
  return [...byId.values()]
    .sort((a, b) => recentSortValue(b) - recentSortValue(a))
    .slice(0, limit);
}

const featureCards = [
  {
    id: "video-subtitles",
    title: "视频智能字幕",
    desc: "视频字幕校对，支持翻译与双语输出",
    icon: AudioWaveform,
    tone: "violet",
    output: "SRT / VTT / TXT",
  },
  {
    id: "video-transcribe",
    title: "视频转写",
    desc: "视频转写校对，整理为逐字稿",
    icon: FileAudio,
    tone: "cyan",
    output: "TXT / MD / SRT / VTT",
  },
  {
    id: "audio-transcribe",
    title: "音频转写",
    desc: "从音频生成转写文本，整理为逐字稿",
    icon: FileText,
    tone: "blue",
    output: "TXT / MD / SRT / VTT",
  },
  {
    id: "subtitle-translate",
    title: "字幕文件翻译",
    desc: "翻译已有字幕，生成目标语言或双语字幕",
    icon: Languages,
    tone: "purple",
    output: "SRT / VTT / TXT",
  },
];

const navItems = [
  { id: "home", label: "首页", icon: Home },
  { id: "workbench", label: "工作台", icon: LayoutGrid },
  { id: "projects", label: "项目与文件", icon: FolderOpen },
  { id: "models", label: "模型配置", icon: Sparkles },
  { id: "terms", label: "术语库", icon: BookOpen },
  { id: "settings", label: "设置", icon: Settings },
];

function loadStored(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveStored(key, value) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Persistence is optional; the workbench should still run when localStorage is unavailable.
    return false;
  }
}

function storageWritable() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    const key = "echo.storage.probe";
    storage.setItem(key, "1");
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function mediaSignature(media) {
  if (!media?.file && !media?.url) return "no-media";
  return [
    media.name || media.file?.name || "",
    media.type || media.file?.type || "",
    media.size || media.file?.size || 0,
    media.file?.lastModified || media.lastModified || media.url || 0,
    Math.round((Number(media.duration) || 0) * 1000),
    audioTrackSignature(media.asrAudio),
  ].join("|");
}

function audioTrackSignature(audioTrack) {
  if (!audioTrack?.file && !audioTrack?.url) return "no-audio-track";
  return [
    audioTrack.name || audioTrack.file?.name || "",
    audioTrack.type || audioTrack.file?.type || "",
    audioTrack.size || audioTrack.file?.size || 0,
    audioTrack.file?.lastModified || audioTrack.lastModified || audioTrack.url || 0,
    Math.round((Number(audioTrack.duration) || 0) * 1000),
  ].join("|");
}

function primaryMediaSignature(media) {
  if (!media?.file && !media?.url) return "no-media";
  return [
    media.name || media.file?.name || "",
    media.type || media.file?.type || "",
    media.size || media.file?.size || 0,
    media.file?.lastModified || media.lastModified || media.url || 0,
    Math.round((Number(media.duration) || 0) * 1000),
  ].join("|");
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fileBaseName(filename = "media") {
  const clean = filename.trim() || "media";
  return clean.replace(/\.[^.]+$/, "") || "media";
}

function safeDownloadBaseName(name = "media") {
  const base = fileBaseName(String(name || "media"))
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return (base || "media").slice(0, 96);
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function encodeWavFromSampleRange(samples, sampleRate, startSample = 0, endSample = samples.length) {
  const firstSample = Math.max(0, Math.min(samples.length, Math.floor(startSample)));
  const lastSample = Math.max(firstSample, Math.min(samples.length, Math.ceil(endSample)));
  const frameCount = Math.max(0, lastSample - firstSample);
  let peak = 0;
  for (let index = firstSample; index < lastSample; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  const gain = peak > 0 && peak < 0.95 ? Math.min(8, 0.95 / peak) : 1;
  const bytesPerSample = 2;
  const dataSize = frameCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = firstSample; index < lastSample; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] * gain));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function encodeWavFromAudioBuffer(audioBuffer, startSeconds = 0, endSeconds = audioBuffer.duration) {
  const samples = mixAudioBufferToMono(audioBuffer);
  return encodeWavFromSampleRange(
    samples,
    audioBuffer.sampleRate,
    startSeconds * audioBuffer.sampleRate,
    endSeconds * audioBuffer.sampleRate,
  );
}

function mixAudioBufferToMono(audioBuffer) {
  const channelCount = Math.max(1, Number(audioBuffer.numberOfChannels) || 1);
  if (channelCount === 1) return audioBuffer.getChannelData(0);
  const length = audioBuffer.length || audioBuffer.getChannelData(0).length;
  const mixed = new Float32Array(length);
  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      mixed[index] += (data[index] || 0) / channelCount;
    }
  }
  return mixed;
}

function chunkRenderedAudio(rendered, originalName, onProgress) {
  const duration = Number(rendered.duration) || 0;
  const chunkCount = Math.max(1, Math.ceil(duration / ASR_CHUNK_SECONDS));
  const baseName = fileBaseName(originalName);
  const chunks = [];
  const overlapSeconds = chunkCount > 1 ? 0.6 : 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const nominalStart = index * ASR_CHUNK_SECONDS;
    const start = Math.max(0, nominalStart - (index > 0 ? overlapSeconds : 0));
    const end = Math.min(duration, nominalStart + ASR_CHUNK_SECONDS);
    if (end - start < 0.5) continue;
    onProgress?.(chunkCount > 1 ? `正在生成第 ${index + 1}/${chunkCount} 个转写音频分块。` : "正在生成转写音频。");
    const wav = encodeWavFromAudioBuffer(rendered, start, end);
    const suffix = chunkCount > 1 ? `_part-${String(index + 1).padStart(2, "0")}` : "";
    chunks.push({
      file: new File([wav], `${baseName}${suffix}.wav`, { type: "audio/wav" }),
      offset: start,
      duration: end - start,
      converted: true,
      chunked: chunkCount > 1,
    });
  }
  return chunks;
}

async function decodeMediaToWavChunks(file, onProgress) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineAudioContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) {
    throw new Error("当前浏览器不支持媒体音轨解码，请改传 WAV/FLAC 音频。");
  }

  onProgress?.("正在读取媒体文件。");
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContextClass();
  try {
    onProgress?.("正在从媒体中解码音轨。");
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    if (!decoded?.duration || !Number.isFinite(decoded.duration)) {
      throw new Error("没有检测到可用音轨");
    }

    onProgress?.("正在转换为云端转写服务更易识别的 16kHz 单声道 WAV，并增强音量。");
    const targetSampleRate = 16000;
    const targetLength = Math.ceil(decoded.duration * targetSampleRate);
    const offline = new OfflineAudioContextClass(1, targetLength, targetSampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    return chunkRenderedAudio(rendered, file.name, onProgress);
  } catch (error) {
    const reason = error.message || "浏览器不支持此媒体编码";
    if (file.type?.startsWith("video")) {
      throw new Error(`无法从该视频解码音轨：${reason}。请切换到支持原始视频的云端转写服务，或导入已有字幕/转写文本继续校对。`);
    }
    throw new Error(`无法解码该音频：${reason}。请改传 WAV/FLAC/MP3 音频，或导入已有转写文本继续校对。`);
  } finally {
    await audioContext.close?.();
  }
}

async function prepareAsrInputs(file, mediaDuration, onProgress, asrProvider) {
  const duration = Number(mediaDuration) || 0;
  if (shouldSubmitOriginalMediaForAsr(file, asrProvider, duration)) {
    onProgress?.(file.type?.startsWith("video")
      ? "正在提交原始视频文件，由云端转写服务抽取音轨。"
      : "正在提交原始音频文件给云端转写服务。");
    return [{ file, offset: 0, duration, converted: false, chunked: false, directOriginal: true }];
  }
  const shouldChunkReadyAudio = file?.type?.startsWith("audio") && duration > ASR_CHUNK_SECONDS;
  if (shouldDecodeMediaForAsr(file, asrProvider, duration) || shouldChunkReadyAudio) {
    try {
      return await decodeMediaToWavChunks(file, onProgress);
    } catch (error) {
      if (isAsrReadyAudioFile(file) && !file.type?.startsWith("video")) {
        onProgress?.(`浏览器无法分块处理该音频，将直接提交原始文件：${error.message}`);
        return [{ file, offset: 0, duration, converted: false, chunked: false }];
      }
      if ((asrProvider?.transport || defaultAsrProvider.transport) === "nvidia-http" && asrProvider?.sendModel !== false && file.type?.startsWith("audio")) {
        onProgress?.(`浏览器无法分块处理该音频，将直接提交原始音频文件：${error.message}`);
        return [{ file, offset: 0, duration, converted: false, chunked: false, directOriginal: true }];
      }
      if (file.type?.startsWith("video") && isOpenAICompatibleAsr(asrProvider)) {
        onProgress?.(`浏览器无法稳定抽取视频音轨，将改为直接提交原始视频文件：${error.message}`);
        return [{ file, offset: 0, duration, converted: false, chunked: false, directOriginal: true, fallbackFromVideoDecode: true }];
      }
      throw error;
    }
  }
  return [{ file, offset: 0, duration, converted: false, chunked: false }];
}

async function fileFromWorkspaceMedia(mediaSource) {
  if (!mediaSource?.workspaceUrl) throw new Error("本地工作区缺少可读取的媒体副本。");
  const response = await fetch(mediaSource.workspaceUrl);
  if (!response.ok) throw new Error("无法读取本地工作区媒体副本，请重新上传媒体。");
  const blob = await response.blob();
  return new File(
    [blob],
    mediaSource.name || mediaSource.fileName || "workspace-media",
    {
      type: mediaSource.type || blob.type || "application/octet-stream",
      lastModified: mediaSource.lastModified || Date.now(),
    },
  );
}

function offsetRows(rows, offset) {
  if (!offset) return rows;
  return rows.map((row) => ({
    ...row,
    id: `${row.id}-offset-${Math.round(offset * 1000)}`,
    start: Number(row.start || 0) + offset,
    end: Number(row.end || 0) + offset,
  }));
}

function mediaDurationLimit(mediaLike) {
  return Number(mediaLike?.asrAudio?.duration || mediaLike?.duration || 0) || 0;
}

function workspaceProjectDurationLimit(project) {
  return Number(project?.asrAudio?.duration || project?.media?.duration || 0) || 0;
}

function repairReviewStructureUnlessEmpty(rows = [], options = {}) {
  return repairReviewStructurePreservingEmpty(rows, options);
}

function reviewRowsChanged(previousRows = [], nextRows = []) {
  if (previousRows.length !== nextRows.length) return true;
  return nextRows.some((row, index) => {
    const current = previousRows[index];
    return !current
      || row.id !== current.id
      || row.text !== current.text
      || row.translation !== current.translation
      || Math.abs((Number(row.start) || 0) - (Number(current.start) || 0)) > 0.001
      || Math.abs((Number(row.end) || 0) - (Number(current.end) || 0)) > 0.001;
  });
}

function displaySpeakerLabel(speaker) {
  const label = String(speaker || "").trim();
  if (!label || label === "未标注") return "";
  return label;
}

function canSplitReviewRow(row) {
  if (!String(row?.text || "").trim() || String(row?.text || "").trim().length < 2) return false;
  const start = Number(row?.start) || 0;
  const end = Number(row?.end) || 0;
  return end - start >= 0.4;
}

function providerReady(provider, serverStatus = defaultServerStatus) {
  if (provider.keySource === "env") return Boolean(provider.baseUrl && provider.model && serverStatus.envKeyConfigured);
  return Boolean(provider.baseUrl && provider.model && provider.apiKey);
}

function asrUsesRivaGrpc(asrProvider) {
  return (asrProvider?.transport || defaultAsrProvider.transport) === "nvidia-riva-grpc";
}

function asrRequiresModel(asrProvider) {
  const transport = asrProvider?.transport || defaultAsrProvider.transport;
  return transport === "dashscope-funasr" || (transport === "nvidia-http" && Boolean(asrProvider?.sendModel));
}

function asrTargetConfigured(asrProvider) {
  const transport = asrProvider?.transport || defaultAsrProvider.transport;
  if (transport === "dashscope-funasr") {
    return Boolean(asrProvider?.endpoint && asrProvider?.model);
  }
  if (transport === "nvidia-http") {
    return Boolean(asrProvider?.endpoint && (!asrRequiresModel(asrProvider) || asrProvider?.model));
  }
  return Boolean(asrProvider?.functionId);
}

function asrDependencyReady(asrProvider, serverStatus = defaultServerStatus) {
  return !asrUsesRivaGrpc(asrProvider) || Boolean(serverStatus.rivaClientAvailable);
}

function asrProviderEnvKeyTypes(asrProvider = {}) {
  const endpoint = String(asrProvider.endpoint || "").toLowerCase();
  const transport = String(asrProvider.transport || "").toLowerCase();
  const types = ["generic"];
  if (transport === "dashscope-funasr" || endpoint.includes("dashscope.aliyuncs.com")) {
    types.push("dashscope");
  } else if (endpoint.includes("api.groq.com")) {
    types.push("groq");
  } else if (endpoint.includes("api.openai.com")) {
    types.push("openai");
  } else if (transport === "nvidia-riva-grpc" || endpoint.includes("nvidia") || endpoint.includes("nvcf")) {
    types.push("nvidia");
  }
  return types;
}

function hasServerAsrKeyForProvider(asrProvider, serverStatus = defaultServerStatus) {
  const keys = serverStatus.asrEnvKeys || {};
  if (!Object.keys(keys).length && serverStatus.nvidiaEnvKeyConfigured) return true;
  return asrProviderEnvKeyTypes(asrProvider).some((type) => Boolean(keys[type]));
}

function asrReady(asrProvider, serverStatus = defaultServerStatus) {
  return Boolean((asrProvider?.apiKey || hasServerAsrKeyForProvider(asrProvider, serverStatus)) && asrTargetConfigured(asrProvider) && asrDependencyReady(asrProvider, serverStatus));
}

function workspaceMediaCanUseAsAsrInput(mediaLike, asrProvider, duration = 0) {
  if (!mediaLike?.workspaceUrl) return false;
  if (shouldSubmitOriginalMediaForAsr(mediaLike, asrProvider, duration)) return true;
  return Boolean(mediaLike.type?.startsWith("audio") && !shouldDecodeMediaForAsr(mediaLike, asrProvider, duration));
}

function isErrorMessage(value) {
  const text = String(value || "").toLowerCase();
  return ["失败", "缺少", "没有", "未检测", "未完成", "无法", "error", "fail"].some((term) => text.includes(term.toLowerCase()));
}

function shouldShowInlineWorkbenchMessage(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return isErrorMessage(text)
    || text.startsWith("正在")
    || text.startsWith("请")
    || text.startsWith("请输入")
    || text.startsWith("当前已有")
    || text.includes("需先");
}

function isAsrLanguageParameterError(error) {
  const text = String(error?.message || error || "");
  return /识别语言|语言参数|音频参数|unsupported language|language_code|invalid_argument/i.test(text);
}

function fallbackAsrLanguageCodeForRetry(asrProvider = {}) {
  if (asrProvider.transport === "dashscope-funasr") return asrProvider.languageCode || "zh";
  if (asrProvider.transport === "nvidia-riva-grpc") return "multi";
  return asrProvider.languageCode || "multi";
}

function isTransientAsrConnectionError(error) {
  if (error?.name === "AbortError") return false;
  const raw = String(error?.message || error || "").trim();
  return /failed to fetch|networkerror|load failed|network request failed|请求失败|网络|connection/i.test(raw);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function formatAsrFailureMessage(error) {
  if (error?.name === "AbortError") return "已取消转写。已保留当前媒体和已有校对内容。";
  const raw = String(error?.message || "").trim();
  const stageText = error?.stage ? `${error.stage}失败：` : "";
  if (isAsrLanguageParameterError(error)) {
    return `转写未完成：${stageText}当前转写配置未通过素材语言或音频参数校验。系统已阻止写入空结果、保留当前任务，并将该配置保持为未通过状态。`;
  }
  if (isTransientAsrConnectionError(error)) {
    return `转写未完成：${stageText}转写服务连接中断，系统已保留当前任务。没有生成不完整结果，可以直接再次开始；连续失败时该服务会保持未通过状态。`;
  }
  return `转写未完成：${stageText}${raw || "云端转写服务未返回可用结果"}。已保留当前媒体和已有校对内容，可以直接重试；连续失败时该服务会保持未通过状态。`;
}

function formatAsrConfigTestFailure(error) {
  const raw = String(error?.message || "").trim();
  if (isAsrLanguageParameterError(error)) {
    return "转写服务测试失败：当前配置未通过语言或音频参数校验。系统没有保存测试通过状态，也不会启用该转写服务。";
  }
  if (isTransientAsrConnectionError(error)) {
    return "转写服务测试失败：当前端点连接中断或网络不可达。系统没有保存测试通过状态；该服务暂不能作为可用转写服务启用。";
  }
  return raw || "转写服务测试失败：当前配置未返回可用结果。系统没有保存测试通过状态。";
}

function getAssistantText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (Array.isArray(content)) {
    return content.map((part) => part.text || "").join("").trim();
  }
  return "";
}

function chunkRowsForModel(rows, maxChars = 4600) {
  const chunks = [];
  let current = [];
  let currentSize = 0;
  rows.forEach((row) => {
    const size = JSON.stringify({ id: row.id, start: row.start, end: row.end, speaker: row.speaker, text: row.text }).length;
    if (current.length && currentSize + size > maxChars) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(row);
    currentSize += size;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

function rowsToTranscript(rows) {
  return rows.map((row) => `[${formatClock(row.start)}-${formatClock(row.end)}] ${row.speaker}: ${row.text}`).join("\n");
}

function rowsHaveCompleteTranslations(rows) {
  return Boolean(rows.length && rows.every((row) => String(row.translation || "").trim()));
}

function dominantLanguageLabel(values = []) {
  const text = values.map((value) => String(value || "")).join("\n");
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
  if (hangul >= 2 && hangul >= latin) return "韩文";
  if (kana >= 2 && kana >= latin) return "日文";
  if (han >= 2 && han >= latin) return "中文";
  if (latin >= 3 && latin > (han + kana + hangul) * 1.5) return "英文";
  return "";
}

function inferImportedLanguagePair(rows = []) {
  const translatedRows = rows.filter((row) => String(row.text || "").trim() && String(row.translation || "").trim());
  if (!translatedRows.length) return null;
  const sourceLanguage = dominantLanguageLabel(translatedRows.map((row) => row.text));
  const targetLanguage = dominantLanguageLabel(translatedRows.map((row) => row.translation));
  if (!sourceLanguage || !targetLanguage || sourceLanguage === targetLanguage) return null;
  return { sourceLanguage, targetLanguage };
}

function fallbackTargetLanguageForSource(sourceLanguage) {
  return sourceLanguage === "英文" ? "中文" : "英文";
}

function inferImportedLanguageState(rows = [], currentState = {}) {
  const inferredPair = inferImportedLanguagePair(rows);
  if (inferredPair) return inferredPair;
  const sourceLanguage = dominantLanguageLabel(rows.map((row) => row.text));
  if (!sourceLanguage) return null;
  const currentTargetLanguage = currentState.targetLanguage || defaultWorkspaceState.targetLanguage;
  return {
    sourceLanguage,
    targetLanguage: currentTargetLanguage && currentTargetLanguage !== sourceLanguage
      ? currentTargetLanguage
      : fallbackTargetLanguageForSource(sourceLanguage),
  };
}

function subtitlePreviewLines(row, mode) {
  if (!row) return [];
  const source = String(row.text || "").trim();
  const target = String(row.translation || "").trim();
  if (mode === "target") return target ? [target] : [];
  if (mode === "bilingual") return [source, target].filter(Boolean);
  return source ? [source] : [];
}

async function readApiResponse(response, fallbackMessage) {
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  const upstreamError = data?.error || (data?.status === "error" ? data?.message : "");
  if (!response.ok || upstreamError) {
    const errorText = typeof upstreamError === "object"
      ? upstreamError.message || upstreamError.error || JSON.stringify(upstreamError)
      : upstreamError;
    const error = new Error(errorText || data.message || fallbackMessage);
    error.stage = data.stage || "";
    error.code = data.code || "";
    error.retryable = data.retryable;
    throw error;
  }
  return data;
}

function getModelClientTimeoutMs() {
  const configured = Number(globalThis.__ECHO_MODEL_CLIENT_TIMEOUT_MS__);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MODEL_CLIENT_TIMEOUT_MS;
}

function createTimedRequestSignal(parentSignal, timeoutMs, timeoutMessage, stage) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason || new DOMException("Aborted", "AbortError"));
  };
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    timeoutMessage,
    isTimeout: () => timedOut,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
    timeoutError: () => {
      const error = new Error(timeoutMessage);
      if (stage) error.stage = stage;
      error.retryable = true;
      return error;
    },
  };
}

async function fetchTimedEndpoint(url, init, options = {}) {
  const requestSignal = createTimedRequestSignal(
    options.signal,
    options.timeoutMs,
    options.timeoutMessage,
    options.timeoutStage,
  );
  try {
    return await fetch(url, { ...init, signal: requestSignal.signal });
  } catch (error) {
    if (requestSignal.isTimeout()) throw requestSignal.timeoutError();
    throw error;
  } finally {
    requestSignal.cleanup();
  }
}

async function callChat(provider, messages, options = {}) {
  const response = await fetchTimedEndpoint("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      messages,
      temperature: options.temperature ?? 0.2,
      max_completion_tokens: options.max_completion_tokens ?? 1200,
    }),
  }, {
    signal: options.signal,
    timeoutMs: getModelClientTimeoutMs(),
    timeoutMessage: "文本模型响应超时。系统已停止等待本次请求并保留当前内容。",
    timeoutStage: "等待文本模型响应",
  });
  const data = await readApiResponse(response, "模型请求失败");
  return getAssistantText(data);
}

function getAsrClientTimeoutMs() {
  const configured = Number(globalThis.__ECHO_ASR_CLIENT_TIMEOUT_MS__);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ASR_CLIENT_TIMEOUT_MS;
}

function createAsrRequestSignal(parentSignal) {
  return createTimedRequestSignal(
    parentSignal,
    getAsrClientTimeoutMs(),
    "转写服务响应超时。系统已停止等待本次请求并保留当前任务。",
    "等待转写服务响应",
  );
}

async function fetchAsrEndpoint(url, init, options = {}) {
  const requestSignal = createAsrRequestSignal(options.signal);
  try {
    return await fetch(url, { ...init, signal: requestSignal.signal });
  } catch (error) {
    if (requestSignal.isTimeout()) throw requestSignal.timeoutError();
    throw error;
  } finally {
    requestSignal.cleanup();
  }
}

async function callAsr(asrProvider, file, languageCode, options = {}) {
  const form = new FormData();
  form.set("file", file);
  form.set("provider", JSON.stringify({ ...asrProvider, languageCode }));
  const response = await fetchAsrEndpoint("/api/asr/transcribe", {
    method: "POST",
    body: form,
  }, options);
  return readApiResponse(response, "云端转写失败");
}

async function callWorkspaceAsr(asrProvider, workspaceSource, languageCode, options = {}) {
  const response = await fetchAsrEndpoint("/api/asr/transcribe-workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: { ...asrProvider, languageCode },
      projectId: workspaceSource.projectId || workspaceSource.workspaceProjectId,
      field: workspaceSource.field || workspaceSource.workspaceField,
    }),
  }, options);
  return readApiResponse(response, "云端转写失败");
}

async function fetchWorkspaceStatus() {
  const response = await fetch("/api/workspace/status");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取本地工作区失败");
  return data;
}

async function configureLocalWorkspace(root) {
  const response = await fetch("/api/workspace/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "配置本地工作区失败");
  return data;
}

async function selectLocalWorkspaceDirectory() {
  const response = await fetch("/api/workspace/select-directory", { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "选择工作区目录失败");
  return data.root || "";
}

async function uploadWorkspaceProjectAsset(projectId, field, file, metadata = {}) {
  if (!projectId || !file) return null;
  const action = field === "asrAudio" ? "asr-audio" : "media";
  const response = await fetch(`/api/workspace/projects/${encodeURIComponent(projectId)}/${action}`, {
    method: "PUT",
    headers: {
      "Content-Type": metadata.type || file.type || "application/octet-stream",
      "x-echo-file-name": encodeURIComponent(metadata.name || file.name || field),
      "x-echo-file-type": encodeURIComponent(metadata.type || file.type || ""),
      "x-echo-file-size": String(metadata.size || file.size || 0),
      "x-echo-file-duration": String(metadata.duration || 0),
    },
    body: file,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "保存媒体文件失败");
  return data[field];
}

async function saveWorkspaceProject(project, mediaFile, asrAudioFile) {
  const nextProject = { ...project };
  if (mediaFile) {
    nextProject.media = await uploadWorkspaceProjectAsset(project.id, "media", mediaFile, project.media);
  }
  if (asrAudioFile) {
    nextProject.asrAudio = await uploadWorkspaceProjectAsset(project.id, "asrAudio", asrAudioFile, project.asrAudio);
  }
  const response = await fetch("/api/workspace/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(nextProject),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "保存本地项目失败");
  return data.project;
}

async function loadWorkspaceProject(id) {
  const response = await fetch(`/api/workspace/projects/${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取本地项目失败");
  return data.project;
}

async function deleteWorkspaceProject(id) {
  const response = await fetch(`/api/workspace/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "删除本地项目失败");
  return data;
}

async function renameWorkspaceProject(id, name) {
  const project = await loadWorkspaceProject(id);
  const nextName = String(name || "").trim();
  if (!nextName) throw new Error("项目名称不能为空。");
  const response = await saveWorkspaceProject({
    id,
    recent: {
      ...(project.recent || {}),
      id,
      name: nextName,
      hasWorkspaceCopy: true,
      updatedAt: project.updatedAt || project.recent?.updatedAt || Date.now(),
    },
    tool: project.tool || inferRecentTool(project.recent),
    rows: Array.isArray(project.rows) ? project.rows : [],
    workspaceState: project.workspaceState || {},
    media: project.media || null,
    asrAudio: project.asrAudio || null,
    updatedAt: project.updatedAt || project.recent?.updatedAt || Date.now(),
  }, null, null);
  return response;
}

async function clearWorkspaceProjects() {
  const response = await fetch("/api/workspace/clear", { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "清除本地工作区项目失败");
  return data;
}

async function mediaStateFromWorkspaceProject(project) {
  if (!project?.mediaUrl || !project.media) return null;
  const media = {
    file: null,
    name: project.media.name || "media",
    type: project.media.type || "",
    size: project.media.size || 0,
    url: project.mediaUrl,
    duration: project.media.duration || 0,
    workspaceUrl: project.mediaUrl,
    fileName: project.media.fileName || "",
    lastModified: project.updatedAt || project.recent?.updatedAt || 0,
  };
  if (project.asrAudioUrl && project.asrAudio) {
    media.asrAudio = {
      file: null,
      name: project.asrAudio.name || "audio-track",
      type: project.asrAudio.type || "",
      size: project.asrAudio.size || 0,
      url: project.asrAudioUrl,
      duration: project.asrAudio.duration || 0,
      workspaceUrl: project.asrAudioUrl,
      fileName: project.asrAudio.fileName || "",
      lastModified: project.updatedAt || project.recent?.updatedAt || 0,
    };
  }
  return media;
}

function AppLogo() {
  return (
    <div className="brand">
      <img src="/assets/brand-logo.png" alt="回响工作台" />
    </div>
  );
}

function Sidebar({ activeNav, setActiveNav }) {
  return (
    <aside className="sidebar">
      <AppLogo />
      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = activeNav === item.id;
          return (
            <button key={item.id} className={`nav-item ${active ? "active" : ""}`} onClick={() => setActiveNav(item.id)}>
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function FeatureCard({ feature, selected, onSelect, onOpen }) {
  const Icon = feature.icon;
  return (
    <button
      className={`feature-card ${selected ? "selected" : ""}`}
      onMouseEnter={onSelect}
      onFocus={onSelect}
      onClick={onOpen}
      aria-label={`${feature.title}，进入工作台`}
    >
      <span className={`feature-icon ${feature.tone}`}>
        <Icon size={32} />
      </span>
      {selected && (
        <span className="selected-dot">
          <Check size={14} />
        </span>
      )}
      <strong>{feature.title}</strong>
      <span>{feature.desc}</span>
      <small>{feature.output}</small>
    </button>
  );
}

function RecentFileChip({ item }) {
  const tool = inferRecentTool(item);
  const isSubtitle = tool === "subtitle-translate";
  const isAudio = tool === "audio-transcribe" || (item?.type === "audio" && !isSubtitle);
  const Icon = isSubtitle ? FileText : isAudio ? AudioWaveform : FileAudio;
  return (
    <span className={`file-chip ${isSubtitle ? "document" : isAudio ? "audio" : ""}`}>
      <Icon size={18} />
    </span>
  );
}

function RecentProjects({ recents, onViewAll, onOpenRecent, workspaceStatus, onOpenSettings }) {
  const hasTemporaryWorkspace = Boolean(workspaceStatus.configured && workspaceStatus.temporaryRoot);
  return (
    <section className="panel recent-panel">
      <div className="panel-head">
        <h2><Clock3 size={20} />最近项目</h2>
        <div className="recent-head-actions">
          {hasTemporaryWorkspace && recents.length > 0 && (
            <button type="button" className="workspace-temp-chip" onClick={onOpenSettings} title="当前工作区位于系统临时目录，项目副本可能被系统清理。点击更换工作区。">
              临时工作区
            </button>
          )}
          <button className="text-button" onClick={onViewAll}>查看全部</button>
        </div>
      </div>
      <div className="recent-list">
        {recents.map((item) => (
          <button className="recent-row" key={`${item.id || item.name}-${item.time}`} type="button" onClick={() => onOpenRecent(item)} title="打开并继续处理" aria-label={`继续处理 ${item.name}`}>
            <RecentFileChip item={item} />
            <div>
              <strong>{item.name}</strong>
              <span>{projectDisplayMeta(item)} · {item.time}</span>
              <small className={item.status === "处理中" ? "blue" : "green"}>{item.status} · {projectRecoverableLabel(item)}</small>
            </div>
            <em>继续处理 <ChevronRight size={16} /></em>
          </button>
        ))}
        {!recents.length && (
          <div className="empty-inline">
            {hasTemporaryWorkspace
              ? "当前工作区位于系统临时目录，项目副本可能被系统清理。建议更换长期保存目录。"
              : workspaceStatus.configured ? "上传媒体或导入字幕后，可恢复项目会显示在这里。" : "先配置本地工作区，后续项目才会有可恢复的媒体副本和处理结果。"}
            {hasTemporaryWorkspace && <button className="text-button inline-link" type="button" onClick={onOpenSettings}>更换工作区</button>}
            {!workspaceStatus.configured && <button className="text-button inline-link" type="button" onClick={onOpenSettings}>配置工作区</button>}
          </div>
        )}
      </div>
    </section>
  );
}

function WorkbenchInlineStatus({ provider, asrProvider, serverStatus, onOpenModels, showAsr = true, showText = true, compact = false }) {
  const hasKey = providerReady({ ...provider, keySource: "input" }, serverStatus);
  const hasAsrKey = Boolean(asrProvider?.apiKey || hasServerAsrKeyForProvider(asrProvider, serverStatus));
  const hasAsrTarget = asrTargetConfigured(asrProvider);
  const hasAsrDependency = asrDependencyReady(asrProvider, serverStatus);
  const hasAsr = asrReady(asrProvider, serverStatus);
  const asrTested = asrProvider.lastTest?.ok === true;
  const asrFailed = asrProvider.lastTest?.ok === false;
  const connectionTested = provider.lastTest?.ok;
  const connectionFailed = provider.lastTest?.ok === false;
  const textState = compact
    ? (!hasKey ? "文本模型未配置" : connectionFailed ? "文本模型失败" : connectionTested ? "文本模型可用" : "文本模型已配置")
    : (!hasKey ? "文本模型未配置" : connectionFailed ? "文本模型测试失败" : connectionTested ? "文本模型已验证" : "文本模型已配置");
  const asrState = compact
    ? (!hasAsrKey || !hasAsrTarget ? "转写服务未配置" : !hasAsrDependency ? "转写依赖缺失" : asrFailed ? "转写服务失败" : asrTested ? "转写服务可用" : "转写服务已配置")
    : (!hasAsrKey || !hasAsrTarget ? "转写服务未配置" : !hasAsrDependency ? "转写依赖缺失" : asrFailed ? "转写服务测试失败" : asrTested ? "转写服务已验证" : "转写服务已配置");
  const asrTitle = asrFailed
    ? asrProvider.lastTest?.message || "转写服务测试失败"
    : !hasAsrKey || !hasAsrTarget
      ? "配置转写服务"
      : !hasAsrDependency
        ? serverStatus.rivaClientError || "gRPC 依赖缺失"
        : `转写服务：${asrProvider.model || "云端 ASR"}`;
  return (
    <div className="inline-status-group" aria-label="模型状态">
      {showAsr && (
        <button className={`inline-status ${!hasAsr || asrFailed ? "warn" : asrTested ? "ok" : "pending"}`} onClick={() => onOpenModels("asr")} title={asrTitle} aria-label={compact ? `转写服务状态：${asrState}` : undefined}>
          <span />
          {asrState}
        </button>
      )}
      {showText && (
        <button className={`inline-status ${connectionFailed || !hasKey ? "warn" : connectionTested ? "ok" : "pending"}`} onClick={() => onOpenModels("text")} title={hasKey ? `文本模型：${provider.model || "未选择"}` : "配置文本模型以使用校正、整理、翻译"} aria-label={compact ? `文本模型状态：${textState}` : undefined}>
          <span />
          {textState}
        </button>
      )}
    </div>
  );
}

function WorkspaceSaveStatus({ status }) {
  if (!status || status.state === "idle") return null;
  const label = status.message || {
    saving: "保存中",
    saved: "已保存",
    error: "保存失败",
    unconfigured: "未配置工作区",
  }[status.state] || "";
  if (!label) return null;
  const title = status.detail || label;
  return (
    <span className={`save-status-pill ${status.state}`} title={title}>
      <span />
      {label}
    </span>
  );
}

function HomeView({ selectedFeature, setSelectedFeature, onOpenWorkbench, recents, onViewAllProjects, onOpenRecent, workspaceStatus, onOpenSettings, onConfigureWorkspace, onSelectWorkspaceDirectory }) {
  const [workspaceRoot, setWorkspaceRoot] = useState(workspaceStatus.root || "");
  const [workspaceSetupMessage, setWorkspaceSetupMessage] = useState("");

  useEffect(() => {
    if (!workspaceStatus.configured) {
      setWorkspaceRoot(workspaceStatus.root || "");
    }
  }, [workspaceStatus.configured, workspaceStatus.root]);

  const configureWorkspaceFromHome = async () => {
    setWorkspaceSetupMessage("");
    try {
      await onConfigureWorkspace(workspaceRoot);
      setWorkspaceSetupMessage("工作区已配置，后续项目会保存本地副本。");
    } catch (error) {
      setWorkspaceSetupMessage(error.message || "工作区配置失败。");
    }
  };
  const selectWorkspaceFromHome = async () => {
    setWorkspaceSetupMessage("");
    try {
      const root = await onSelectWorkspaceDirectory();
      if (root) setWorkspaceRoot(root);
    } catch (error) {
      setWorkspaceSetupMessage(error.message || "选择工作区目录失败。");
    }
  };

  return (
    <div className="home-grid">
      <main className="home-main">
        <header className="hero-row">
          <div>
            <h1>回响工作台</h1>
            <p>面向视频、音频和字幕文件的转写校对、字幕翻译、双语字幕与导出。</p>
          </div>
        </header>
        {!workspaceStatus.configured && (
          <section className="workspace-warning">
            <div>
              <strong>先配置本地工作区</strong>
              <span>未配置时不导入素材、不建立历史项目。配置后，媒体副本、校对表和整理稿会保存到本地目录。</span>
            </div>
            <div className="workspace-setup-form">
              <input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="请选择或输入本地工作区路径" />
              <button className="secondary" onClick={selectWorkspaceFromHome}>选择目录</button>
              <button className="primary" onClick={configureWorkspaceFromHome} disabled={!workspaceRoot.trim()}>保存工作区</button>
              <button className="secondary" onClick={onOpenSettings}>更多设置</button>
              {workspaceSetupMessage && <small className={isErrorMessage(workspaceSetupMessage) ? "error" : ""}>{workspaceSetupMessage}</small>}
            </div>
          </section>
        )}

        <section className="feature-grid" aria-label="工作台功能">
          {featureCards.map((feature) => (
            <FeatureCard
              key={feature.id}
              feature={feature}
              selected={selectedFeature.id === feature.id}
              onSelect={() => setSelectedFeature(feature)}
              onOpen={() => onOpenWorkbench(feature.id)}
            />
          ))}
        </section>

        <div className={`lower-grid ${recents.length ? "has-recents" : "empty-recents"}`}>
          <RecentProjects recents={recents} onViewAll={onViewAllProjects} onOpenRecent={onOpenRecent} workspaceStatus={workspaceStatus} onOpenSettings={onOpenSettings} />
        </div>
      </main>
    </div>
  );
}

function WorkbenchView({ activeTool, onBackHome, rows, setRows, media, setMedia, workspaceState, setWorkspaceState, provider, asrProvider, setAsrProvider, serverStatus, terms, addRecent, updateActiveRecent, onOpenModels, workspaceStatus, workspaceSaveStatus, onOpenSettings, workspaceNotice, activeProjectId, activeProjectName, onBusyChange }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [transcriptionStatus, setTranscriptionStatus] = useState({ state: "idle", message: "" });
  const [manualImport, setManualImport] = useState("");
  const [manualImportOpen, setManualImportOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState(null);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [subtitleSearch, setSubtitleSearch] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [subtitleReplace, setSubtitleReplace] = useState("");
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const [exportSettingsOpen, setExportSettingsOpen] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState("");
  const [pendingDeleteRowId, setPendingDeleteRowId] = useState("");
  const [mediaPreviewError, setMediaPreviewError] = useState("");
  const [timeShiftSeconds, setTimeShiftSeconds] = useState("0.5");
  const { draft, transcriptionContext, sourceLanguage, targetLanguage, exportMode, exportFormat, translationRequested } = { ...defaultWorkspaceState, ...workspaceState };
  const exportOptions = { ...defaultWorkspaceState.exportOptions, ...(workspaceState.exportOptions || {}) };
  const setDraft = (value) => setWorkspaceState((current) => ({ ...current, draft: value }));
  const setTranscriptionContext = (value) => setWorkspaceState((current) => ({ ...current, transcriptionContext: value }));
  const setSourceLanguage = (value) => setWorkspaceState((current) => ({ ...current, sourceLanguage: value }));
  const setTargetLanguage = (value) => setWorkspaceState((current) => ({ ...current, targetLanguage: value }));
  const setExportMode = (value) => setWorkspaceState((current) => ({ ...current, exportMode: value }));
  const setExportFormat = (value) => setWorkspaceState((current) => ({ ...current, exportFormat: value }));
  const setExportOption = (key, value) => setWorkspaceState((current) => ({ ...current, exportOptions: { ...defaultWorkspaceState.exportOptions, ...(current.exportOptions || {}), [key]: value } }));
  const setTranslationRequested = (value) => setWorkspaceState((current) => ({ ...current, translationRequested: value }));
  const setWorkbenchTranscriptionStatus = (status, options = {}) => {
    const nextStatus = { state: "idle", message: "", ...status };
    setTranscriptionStatus(nextStatus);
    if (options.persist) {
      setWorkspaceState((current) => ({ ...current, lastTranscriptionStatus: nextStatus }));
    }
  };
  const clearWorkbenchTranscriptionStatus = (options = {}) => {
    setTranscriptionStatus({ state: "idle", message: "" });
    if (options.persist) {
      setWorkspaceState((current) => ({ ...current, lastTranscriptionStatus: null }));
    }
  };
  const markAsrProviderRuntimeFailure = (message) => {
    if (typeof setAsrProvider !== "function") return;
    setAsrProvider((current) => {
      const next = {
        ...current,
        lastTest: {
          ok: false,
          message,
          at: Date.now(),
        },
      };
      saveStored(STORAGE_KEYS.asrProvider, next);
      return next;
    });
  };
  const mediaInputRef = useRef(null);
  const audioTrackInputRef = useRef(null);
  const subtitleInputRef = useRef(null);
  const manualImportTextareaRef = useRef(null);
  const mediaElementRef = useRef(null);
  const subtitleTableRef = useRef(null);
  const subtitleSearchInputRef = useRef(null);
  const textSelectionRef = useRef({ rowId: "", index: null });
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const textEditSnapshotRef = useRef(null);
  const pendingEditorFocusRef = useRef("");
  const asrAbortRef = useRef(null);
  const modelAbortRef = useRef(null);
  const previousUndoScopeRef = useRef({ activeProjectId, activeTool });
  const previousTranscriptionStatusScopeRef = useRef({ activeProjectId, activeTool });
  const previousRowsLengthRef = useRef(rows.length);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [segmentPlaybackRowId, setSegmentPlaybackRowId] = useState("");
  const [segmentLoopRowId, setSegmentLoopRowId] = useState("");

  useEffect(() => {
    setMediaPreviewError("");
  }, [media?.url]);

  useEffect(() => {
    return () => {
      asrAbortRef.current?.abort();
      asrAbortRef.current = null;
      modelAbortRef.current?.abort();
      modelAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.("");
  }, [busy, onBusyChange]);

  const clearUndoHistory = () => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    textEditSnapshotRef.current = null;
    setUndoDepth(0);
    setRedoDepth(0);
  };

  const cloneMediaState = (value) => (value ? ({
    ...value,
    asrAudio: value.asrAudio ? { ...value.asrAudio } : undefined,
  }) : null);

  const createEditSnapshot = (label) => ({
    label,
    rows: rows.map((row) => ({ ...row })),
    media: cloneMediaState(media),
    workspaceState: { ...workspaceState },
    selectedRowId,
  });

  const restoreEditSnapshot = (snapshot) => {
    const restoredRows = repairReviewStructureUnlessEmpty(
      snapshot.rows.map((row) => ({ ...row })),
      { maxEnd: mediaDurationLimit(snapshot.media) },
    ).rows;
    setRows(restoredRows);
    setMedia(cloneMediaState(snapshot.media));
    setWorkspaceState({ ...defaultWorkspaceState, ...snapshot.workspaceState });
    setSelectedRowId(restoredRows.some((row) => row.id === snapshot.selectedRowId) ? snapshot.selectedRowId : restoredRows[0]?.id || "");
    textEditSnapshotRef.current = null;
  };

  const pushUndoSnapshot = (label) => {
    const snapshot = createEditSnapshot(label);
    undoStackRef.current = [...undoStackRef.current, snapshot].slice(-40);
    redoStackRef.current = [];
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(0);
  };

  const undoLastChange = () => {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return;
    redoStackRef.current = [...redoStackRef.current, createEditSnapshot(snapshot.label)].slice(-40);
    restoreEditSnapshot(snapshot);
    textEditSnapshotRef.current = null;
    setMessage(`已撤销：${snapshot.label}`);
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(redoStackRef.current.length);
  };

  const redoLastChange = () => {
    const snapshot = redoStackRef.current.pop();
    if (!snapshot) return;
    undoStackRef.current = [...undoStackRef.current, createEditSnapshot(snapshot.label)].slice(-40);
    restoreEditSnapshot(snapshot);
    textEditSnapshotRef.current = null;
    setMessage(`已重做：${snapshot.label}`);
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(redoStackRef.current.length);
  };

  const textEditKey = (rowId, field) => `${rowId}:${field}`;

  const textEditLabel = (field) => (field === "translation" ? "编辑译文" : "编辑校对稿");

  const beginTextEditSnapshot = (rowId, field) => {
    const key = textEditKey(rowId, field);
    if (textEditSnapshotRef.current?.key === key) return;
    textEditSnapshotRef.current = {
      key,
      snapshot: createEditSnapshot(textEditLabel(field)),
      pushed: false,
    };
  };

  const pushPreparedUndoSnapshot = (snapshot) => {
    undoStackRef.current = [...undoStackRef.current, snapshot].slice(-40);
    redoStackRef.current = [];
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(0);
  };

  const pushTextEditSnapshot = (rowId, field) => {
    const key = `${rowId}:${field}`;
    let session = textEditSnapshotRef.current;
    if (session?.key !== key) {
      session = {
        key,
        snapshot: createEditSnapshot(textEditLabel(field)),
        pushed: false,
      };
    }
    if (session.pushed) {
      textEditSnapshotRef.current = session;
      return;
    }
    pushPreparedUndoSnapshot(session.snapshot);
    textEditSnapshotRef.current = { ...session, pushed: true };
  };

  const finishTextEditSnapshot = (rowId, field, options = {}) => {
    if (textEditSnapshotRef.current?.key === `${rowId}:${field}`) {
      textEditSnapshotRef.current = null;
    }
    if (field === "text" && options.repairStructure) {
      const repairResult = repairReviewStructureUnlessEmpty(rows, structureRepairOptions);
      if (!reviewRowsChanged(rows, repairResult.rows)) return;
      setRows(repairResult.rows);
      if (!repairResult.rows.some((row) => row.id === rowId)) {
        setSelectedRowId(repairResult.rows[0]?.id || "");
      }
      markRowsEdited(repairResult.rows.length);
      const mergeText = repairResult.mergedRowCount ? `已自动合并 ${repairResult.mergedRowCount} 条短碎片。` : "";
      const splitText = repairResult.splitRowCount ? `已自动拆分 ${repairResult.splitRowCount} 条过长段落。` : "";
      if (mergeText || splitText) setMessage(`${mergeText}${splitText}`);
    }
  };

  const updateRowTextField = (id, field, value) => {
    pushTextEditSnapshot(id, field);
    const currentRow = rows.find((row) => row.id === id);
    const textChanged = currentRow && String(currentRow[field] || "") !== String(value || "");
    updateRow(id, {
      [field]: value,
      ...(textChanged && currentRow.reviewStatus === "confirmed" ? { reviewStatus: "pending" } : {}),
    });
  };

  const rememberTextSelection = (rowId, event) => {
    const index = event.currentTarget.selectionStart;
    textSelectionRef.current = { rowId, index: Number.isFinite(index) ? index : null };
  };

  useEffect(() => {
    const previous = previousUndoScopeRef.current;
    const toolChanged = previous.activeTool !== activeTool;
    const switchedExistingProject = previous.activeProjectId !== activeProjectId && Boolean(previous.activeProjectId);
    if (toolChanged || switchedExistingProject) {
      clearUndoHistory();
      setSelectedRowId("");
      setSubtitleSearch("");
      setActiveSearchIndex(0);
      setSegmentPlaybackRowId("");
      setSegmentLoopRowId("");
      setMessage("");
    }
    previousUndoScopeRef.current = { activeProjectId, activeTool };
  }, [activeProjectId, activeTool]);

  useEffect(() => () => {
    asrAbortRef.current?.abort();
  }, []);

  const focusSubtitleSearch = () => {
    const input = subtitleSearchInputRef.current;
    input?.focus?.();
    input?.select?.();
    window.setTimeout(() => {
      if (document.activeElement !== input) {
        input?.focus?.();
        input?.select?.();
      }
    }, 0);
  };

  useEffect(() => {
    const handleUndoShortcut = (event) => {
      const key = event.key.toLowerCase();
      const isFind = (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "f";
      const isUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && key === "z";
      const isRedo = (event.metaKey || event.ctrlKey) && ((event.shiftKey && key === "z") || key === "y");
      if (isFind && rows.length > 0) {
        event.preventDefault();
        focusSubtitleSearch();
        return;
      }
      if (isUndo && undoStackRef.current.length) {
        event.preventDefault();
        undoLastChange();
      }
      if (isRedo && redoStackRef.current.length) {
        event.preventDefault();
        redoLastChange();
      }
    };
    window.addEventListener("keydown", handleUndoShortcut);
    return () => window.removeEventListener("keydown", handleUndoShortcut);
  }, [rows.length, undoDepth, redoDepth]);

  useEffect(() => {
    if (workspaceNotice?.text && isErrorMessage(workspaceNotice.text)) {
      setMessage(workspaceNotice.text);
    }
  }, [workspaceNotice]);

  useEffect(() => {
    if (!message || shouldShowInlineWorkbenchMessage(message)) return undefined;
    const timeout = window.setTimeout(() => {
      setMessage((current) => (current === message ? "" : current));
    }, 4200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const previousRowsLength = previousRowsLengthRef.current;
    previousRowsLengthRef.current = rows.length;
    if (previousRowsLength !== 0 || rows.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(".app-shell")?.scrollTo({ top: 0, left: 0 });
      document.querySelector(".content-shell.workbench-shell")?.scrollTo({ top: 0, left: 0 });
      window.scrollTo({ top: 0, left: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [rows.length]);

  useEffect(() => {
    const hasContentWithoutRecoverableProject = Boolean(
      busy ||
      manualImport.trim() ||
      ((media?.url || rows.length || String(draft || "").trim()) && (!activeProjectId || !workspaceStatus?.configured))
    );
    const shouldProtectUnload = Boolean(
      busy ||
      workspaceSaveStatus?.state === "saving" ||
      workspaceSaveStatus?.state === "error" ||
      hasContentWithoutRecoverableProject
    );

    if (!shouldProtectUnload) {
      return undefined;
    }

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [activeProjectId, busy, draft, manualImport, media?.url, rows.length, workspaceSaveStatus?.state, workspaceStatus?.configured]);

  const selectedFeature = featureCards.find((item) => item.id === activeTool) || featureCards[0];

  useEffect(() => {
    const previousScope = previousTranscriptionStatusScopeRef.current;
    const scopeChanged = previousScope.activeTool !== activeTool || previousScope.activeProjectId !== activeProjectId;
    previousTranscriptionStatusScopeRef.current = { activeProjectId, activeTool };
    if (!scopeChanged) return;
    setManualImportOpen(false);
    clearWorkbenchTranscriptionStatus();
  }, [activeProjectId, activeTool]);

  useEffect(() => {
    const savedStatus = workspaceState.lastTranscriptionStatus;
    if (!savedStatus || rows.length || transcriptionStatus.state !== "idle") return;
    setTranscriptionStatus(savedStatus);
  }, [rows.length, transcriptionStatus.state, workspaceState.lastTranscriptionStatus]);

  useEffect(() => {
    if (!manualImportOpen) return undefined;
    const frame = window.requestAnimationFrame(() => {
      manualImportTextareaRef.current?.focus?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [manualImportOpen]);

  const isSubtitleFileFlow = selectedFeature.id === "subtitle-translate";
  const isSubtitleWorkflow = selectedFeature.id === "video-subtitles" || selectedFeature.id === "subtitle-translate";
  const isAudioFlow = selectedFeature.id === "audio-transcribe";
  const isVideoFlow = selectedFeature.id === "video-subtitles" || selectedFeature.id === "video-transcribe";
  const isTranscriptionFlow = selectedFeature.id === "video-transcribe" || selectedFeature.id === "audio-transcribe";
  const usesDashScopeFunAsr = asrProvider.transport === "dashscope-funasr";
  const workspaceReady = Boolean(workspaceStatus?.configured);
  const mediaAccept = isAudioFlow ? "audio/*" : "video/*";
  const missingMediaHint = isAudioFlow ? "先上传音频文件" : "先上传视频文件";
  const transcriptImportLabel = isSubtitleFileFlow ? "选择字幕文件" : isSubtitleWorkflow ? "导入字幕文件" : "导入转写文件";
  const transcriptReplaceLabel = isSubtitleWorkflow ? "替换字幕文件" : "替换转写文件";
  const manualImportLabel = isSubtitleWorkflow ? "导入已有字幕文本" : "导入已有转写文本";
  const manualImportPlaceholder = isSubtitleWorkflow ? "粘贴 SRT/VTT/TXT 字幕内容" : "粘贴已有逐字稿、TXT、SRT 或 VTT 内容";
  const mediaPanelTitle = isSubtitleFileFlow ? "字幕文件" : isAudioFlow ? "音频与转写" : isSubtitleWorkflow ? "视频与字幕" : "视频与转写";
  const segmentKind = isTranscriptionFlow ? "转写" : "字幕";
  const editorTitle = isTranscriptionFlow ? "转写校对" : "字幕校对";
  const addRowText = isTranscriptionFlow ? "新转写段落" : "新字幕";
  const emptyEditorText = isTranscriptionFlow
    ? "还没有转写段落。导入 TXT/SRT/VTT 文件，或点击“添加段落”手动创建。"
    : "还没有字幕段落。导入 SRT/VTT/TXT 文件，或点击“添加段落”手动创建。";
  const noticeText = isSubtitleFileFlow
    ? "导入字幕后可校对、翻译并导出。"
    : usesDashScopeFunAsr && isVideoFlow
      ? "提交视频到当前转写服务，生成时间轴文本。"
    : isSubtitleWorkflow
      ? "从视频生成转写文本，再校对和导出字幕。"
      : isAudioFlow
        ? "上传音频生成转写文本，也可导入已有文本。"
        : "从视频生成转写文本，再校对和导出。";
  const transcriptText = rows.map((row) => `${row.speaker}: ${row.text}`).join("\n");
  const llmReady = providerReady(provider, serverStatus);
  const asrConfigured = Boolean((asrProvider?.apiKey || hasServerAsrKeyForProvider(asrProvider, serverStatus)) && asrTargetConfigured(asrProvider));
  const asrDependencyOk = asrDependencyReady(asrProvider, serverStatus);
  const transcriptionReady = asrReady(asrProvider, serverStatus);
  const mediaType = media?.type || media?.file?.type || "";
  const asrMedia = media?.asrAudio || media;
  const hasAsrFile = Boolean(media?.asrAudio?.file || media?.file);
  const workspaceSourceReady = Boolean(!hasAsrFile && workspaceMediaCanUseAsAsrInput(asrMedia, asrProvider, media?.asrAudio?.duration || media?.duration || 0));
  const workspaceFileRecoverable = Boolean(!hasAsrFile && asrMedia?.workspaceUrl);
  const hasTranscriptionInput = Boolean(hasAsrFile || workspaceSourceReady || workspaceFileRecoverable);
  const videoHasAudioTrack = Boolean(mediaType.startsWith("video") && (media?.asrAudio?.file || media?.asrAudio?.workspaceUrl));
  const transcriptionFile = media?.asrAudio?.file || media?.file || asrMedia;
  const transcriptionDuration = media?.asrAudio?.duration || media?.duration || 0;
  const structureRepairOptions = { maxEnd: transcriptionDuration };
  const mediaSubmitsOriginal = shouldSubmitOriginalMediaForAsr(transcriptionFile, asrProvider, transcriptionDuration);
  const mediaNeedsBrowserDecode = shouldDecodeMediaForAsr(transcriptionFile, asrProvider, transcriptionDuration);
  const videoUsesEmbeddedAudio = Boolean(mediaType.startsWith("video") && !media.asrAudio?.file);
  const shouldShowAudioFallback = Boolean(
    mediaType.startsWith("video") &&
    !rows.length &&
    (media.asrAudio?.file || (!usesDashScopeFunAsr && asrProvider.videoInputMode !== "original"))
  );
  const languageCompatibilityWarning = !isSubtitleFileFlow ? getAsrLanguageCompatibilityWarning(asrProvider, sourceLanguage) : "";
  const asrLanguageCompatible = !languageCompatibilityWarning;
  const canStartTranscription = Boolean(workspaceReady && hasTranscriptionInput && transcriptionReady && asrLanguageCompatible);
  const hasMediaPlayback = Boolean(media?.url);
  const showMediaPanel = Boolean(!rows.length || hasMediaPlayback || isSubtitleFileFlow);
  const startTranscriptionHint = !workspaceReady
    ? "需先配置本地工作区"
    : !media?.url && !media?.file
      ? missingMediaHint
    : !hasTranscriptionInput
      ? "本地副本不可读取，请重新上传媒体。"
    : !asrConfigured
      ? "需配置云端转写服务"
      : !asrDependencyOk
        ? "需安装 Riva 客户端或切换 HTTP 端点"
        : usesDashScopeFunAsr && transcriptionFile?.type?.startsWith("video")
          ? "直接提交视频文件，由百炼 ASR 生成时间轴文本"
        : mediaSubmitsOriginal && transcriptionFile?.type?.startsWith("video")
          ? "直接提交视频文件，由云端转写服务抽取音轨"
        : mediaSubmitsOriginal && transcriptionFile?.type?.startsWith("audio")
          ? "直接提交音频文件给云端转写服务"
        : videoHasAudioTrack
          ? "使用备用音频文件转写，视频用于预览校对"
        : videoUsesEmbeddedAudio
          ? "从视频内音轨生成转写输入，并保留视频预览校对"
          : mediaNeedsBrowserDecode
            ? "先转换并增强音频，再调用云端转写服务"
            : `使用 ${asrProvider.model || "云端 ASR"} 生成可编辑文本`;
  const startBlockedMessage = !workspaceReady
    ? "本地工作区未配置，无法保存媒体副本和转写结果。"
    : !hasTranscriptionInput
      ? "没有可提交的媒体输入，请上传媒体或重新打开可恢复的本地项目。"
      : !asrConfigured
        ? "转写服务未配置，无法提交云端转写任务。"
        : !asrDependencyOk
          ? "当前转写服务依赖未就绪，无法提交任务。"
          : !asrLanguageCompatible
            ? languageCompatibilityWarning
            : "";
  const asrBlocked = !asrConfigured || !asrDependencyOk || !asrLanguageCompatible;
  const asrBlockerTitle = !asrConfigured ? "转写服务未配置" : !asrDependencyOk ? "转写依赖未就绪" : "模型与源语言不匹配";
  const asrBlockerDetail = !asrConfigured
    ? `请先配置 ${asrProvider.label || asrProvider.model || "ASR 服务"} 的 API Key。`
    : !asrDependencyOk
      ? "当前转写依赖未就绪，系统已阻止提交，避免生成空结果。"
      : languageCompatibilityWarning;
  const cloudTranscriptionNotice = !asrConfigured
    ? `转写服务未配置：请在模型配置中填写 ${asrProvider.label || asrProvider.model || "ASR 服务"} 的 API Key。`
    : !asrDependencyOk
      ? "转写服务依赖未就绪：系统已阻止提交，避免生成空结果。"
      : `转写服务：${asrProvider.label || asrProvider.model || "ASR 服务"}`;
  const asrSetupNote = !asrConfigured
    ? "当前不能开始转写。请先完成转写服务配置，再上传媒体生成可编辑文本。"
    : !asrDependencyOk
      ? "当前转写服务依赖未就绪，工作台会阻止提交，避免生成空结果。"
      : languageCompatibilityWarning || (sourceLanguage === "自动识别"
        ? "为提高转写稳定性，建议在开始前明确选择源语言。"
          : usesDashScopeFunAsr
            ? "当前配置会直接提交原始音视频到百炼 ASR。"
          : asrProvider.videoInputMode === "original"
          ? "当前配置会直接提交原始视频；如果端点只接收音频，请在模型配置中改为从视频音轨生成输入。"
          : "当前配置会从视频内音轨生成转写输入；备用音频仅用于音轨不可用或质量较差时。");
  const exportFilePrefix = isTranscriptionFlow ? "echo-transcript" : "echo-subtitles";
  const exportBaseName = safeDownloadBaseName(media?.name || activeProjectName || exportFilePrefix);
  const exportFormatOptions = isTranscriptionFlow ? ["txt", "md", "srt", "vtt"] : ["srt", "vtt", "txt"];
  const activeTopExportFormat = exportFormatOptions.includes(exportFormat) ? exportFormat : exportFormatOptions[0];
  const supportsTextExportOptions = ["txt", "md"].includes(activeTopExportFormat);
  const emptyTextCount = rows.filter((row) => !String(row.text || "").trim()).length;
  const missingTranslationCount = rows.filter((row) => !String(row.translation || "").trim()).length;
  const sameLanguageSelected = sourceLanguage !== "自动识别" && sourceLanguage === targetLanguage;
  const translationExportAvailable = !sameLanguageSelected;
  const hasAnyTranslation = rows.some((row) => String(row.translation || "").trim());
  const translationFlowActive = Boolean(
    translationExportAvailable &&
    (isSubtitleFileFlow || translationRequested || hasAnyTranslation || exportMode !== "source")
  );
  const translationComplete = Boolean(translationExportAvailable && rows.length && missingTranslationCount === 0);
  const currentExportMode = !translationExportAvailable ? "source" : (exportMode === "source" || translationComplete ? exportMode : "source");
  const exportModeLabel = currentExportMode === "target" ? "译文" : currentExportMode === "bilingual" ? "双语" : "原文";
  const basePrimaryExportLabel = translationFlowActive
    ? `导出${exportModeLabel} ${activeTopExportFormat.toUpperCase()}`
    : `导出 ${activeTopExportFormat.toUpperCase()}`;
  const activeReviewRow = rows.find((row) => row.id === selectedRowId) || rows[0] || null;
  const activeReviewIndex = activeReviewRow ? rows.findIndex((row) => row.id === activeReviewRow.id) : -1;
  const activeSpeakerLabel = displaySpeakerLabel(activeReviewRow?.speaker);
  const speakerLabels = useMemo(() => [...new Set(rows.map((row) => displaySpeakerLabel(row.speaker)).filter(Boolean))], [rows]);
  const speakerSelectOptions = useMemo(() => [...new Set(["未标注", ...speakerLabels])], [speakerLabels]);
  const canReassignActiveSpeaker = Boolean(activeReviewRow && speakerLabels.length > 0 && (!activeSpeakerLabel || speakerLabels.length > 1));
  const activeOriginalText = String(activeReviewRow?.originalText || "").trim();
  const activeEditedText = String(activeReviewRow?.text || "").trim();
  const canConfirmActiveRow = Boolean(activeReviewRow && activeEditedText);
  const showActiveOriginalText = Boolean(activeOriginalText && activeOriginalText !== activeEditedText);
  const reviewPageCount = Math.max(1, Math.ceil(rows.length / REVIEW_PAGE_SIZE));
  const activeReviewPageIndex = activeReviewIndex >= 0 ? Math.floor(activeReviewIndex / REVIEW_PAGE_SIZE) : 0;
  const reviewPageStart = activeReviewPageIndex * REVIEW_PAGE_SIZE;
  const reviewPageEnd = Math.min(rows.length, reviewPageStart + REVIEW_PAGE_SIZE);
  const visibleReviewRows = rows.slice(reviewPageStart, reviewPageEnd);
  const qualityHintMap = useMemo(() => {
    const map = new Map();
    rows.forEach((row, index) => {
      const hints = getSubtitleQualityHints(row, rows[index + 1]);
      const userActionableHints = hints.filter((hint) => hint === "空文本");
      if (userActionableHints.length) map.set(row.id, userActionableHints);
    });
    return map;
  }, [rows]);
  const qualityIssueRows = rows.filter((row) => qualityHintMap.has(row.id));
  const longSubtitleIssueRows = rows.filter((row) => (qualityHintMap.get(row.id) || []).includes("单条过长"));
  const timingExportIssueRows = rows.filter((row) => {
    const hints = qualityHintMap.get(row.id) || [];
    return hints.includes("时间无效") || hints.includes("时间重叠");
  });
  const timingExportIssueCount = timingExportIssueRows.length;
  const exportBlockerCount = emptyTextCount;
  const primaryExportLabel = exportBlockerCount ? `补齐 ${exportBlockerCount} 条后导出` : basePrimaryExportLabel;
  const primaryExportTitle = exportBlockerCount ? "点击定位第一条缺少原文的段落" : basePrimaryExportLabel;
  const activeQualityHints = activeReviewRow ? qualityHintMap.get(activeReviewRow.id) || [] : [];
  const showReviewPagination = rows.length > REVIEW_PAGE_SIZE;
  const isLoopingActiveSegment = Boolean(activeReviewRow?.id && segmentLoopRowId === activeReviewRow.id);
  const activeTimedRow = media?.url && rows.length
    ? rows.find((row) => playbackTime >= (Number(row.start) || 0) && playbackTime < (Number(row.end) || 0)) || null
    : null;
  const activeVideoSubtitleRow = mediaType.startsWith("video") ? activeTimedRow : null;
  const activeVideoSubtitleLines = subtitlePreviewLines(activeVideoSubtitleRow, currentExportMode);
  const translationHint = !rows.length
    ? "先导入字幕或转写段落；仅用于跨语言场景"
    : sameLanguageSelected
      ? "源语言与目标语言一致，无需翻译"
      : !llmReady
        ? "需配置文本模型；仅作为跨语言附加功能"
        : sourceLanguage === "自动识别"
          ? "自动判断源语言，仅在需要跨语言时使用"
          : `从${sourceLanguage}翻译为${targetLanguage}`;
  const correctionHint = !rows.length
    ? `先导入或生成${segmentKind}段落`
    : !llmReady
      ? "需配置文本模型"
      : "只修正断句、标点和明显识别错字";
  const modelTaskBusy = Boolean(busy && busy !== "asr");
  const showAsrQualityNote = !isSubtitleFileFlow && (sourceLanguage === "自动识别" || isVideoFlow);
  const showTranslationColumn = translationFlowActive;
  const needsTranslationAttention = Boolean(rows.length && showTranslationColumn && missingTranslationCount);
  const needsExportRepair = Boolean(rows.length && exportBlockerCount);
  const quickStateLabel = needsExportRepair
    ? `缺原文 ${exportBlockerCount} 条`
    : !translationExportAvailable
      ? "原文"
      : translationComplete
        ? "译文已补齐"
        : exportModeLabel;
  const exportModeButtonClass = (mode) => {
    if (currentExportMode === mode) return "active";
    if (mode !== "source" && exportMode === mode && needsTranslationAttention) return "pending-attention";
    if (mode !== "source" && !translationComplete) return "needs-attention";
    return "";
  };
  const normalizedSubtitleSearch = subtitleSearch.trim().toLowerCase();
  const searchMatches = useMemo(() => {
    if (!normalizedSubtitleSearch) return [];
    return rows
      .map((row, index) => {
        const haystack = [
          row.speaker,
          row.text,
          row.translation,
          formatClock(row.start),
          formatClock(row.end),
        ].join(" ").toLowerCase();
        return haystack.includes(normalizedSubtitleSearch) ? { id: row.id, index } : null;
      })
      .filter(Boolean);
  }, [normalizedSubtitleSearch, rows]);
  const activeSearchRowId = searchMatches[activeSearchIndex]?.id || "";
  const replaceCandidateCount = normalizedSubtitleSearch
    ? rows.filter((row) => [row.text, row.translation].some((value) => String(value || "").toLowerCase().includes(normalizedSubtitleSearch))).length
    : 0;

  const scrollReviewRowIntoView = (rowId, block = "nearest") => {
    if (!rowId || !subtitleTableRef.current) return;
    const escapeSelector = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
    const rowElement = subtitleTableRef.current.querySelector(`[data-row-id="${escapeSelector(rowId)}"]`);
    if (!rowElement) return;
    const scrollContainer = rowElement.closest(".review-segment-list") || subtitleTableRef.current;
    if (!scrollContainer) {
      rowElement.scrollIntoView({ block, behavior: "auto" });
      return;
    }
    const containerRect = scrollContainer.getBoundingClientRect();
    const rowRect = rowElement.getBoundingClientRect();
    const targetTop = rowRect.top - containerRect.top + scrollContainer.scrollTop
      - (block === "center" ? (containerRect.height - rowRect.height) / 2 : 12);
    scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
  };

  useEffect(() => {
    window.setTimeout(() => scrollReviewRowIntoView(activeTimedRow?.id), 0);
  }, [activeTimedRow?.id, activeReviewPageIndex]);

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [normalizedSubtitleSearch]);

  useEffect(() => {
    if (!searchMatches.length) {
      setActiveSearchIndex(0);
      return;
    }
    if (activeSearchIndex >= searchMatches.length) {
      setActiveSearchIndex(searchMatches.length - 1);
    }
  }, [activeSearchIndex, searchMatches.length]);

  useEffect(() => {
    if (!activeSearchRowId || !subtitleTableRef.current) return;
    setSelectedRowId(activeSearchRowId);
  }, [activeSearchRowId]);

  useEffect(() => {
    if (!activeReviewRow?.id) return;
    window.setTimeout(() => scrollReviewRowIntoView(activeReviewRow.id, "nearest"), 0);
  }, [activeReviewRow?.id, activeReviewPageIndex]);

  useEffect(() => {
    if (!pendingEditorFocusRef.current) return undefined;
    const field = pendingEditorFocusRef.current;
    pendingEditorFocusRef.current = "";
    const selector = field === "translation"
      ? ".current-segment-card .subtitle-translation-textarea"
      : ".current-segment-card .subtitle-source-textarea";
    const frame = window.requestAnimationFrame(() => document.querySelector(selector)?.focus?.());
    return () => window.cancelAnimationFrame(frame);
  }, [activeReviewRow?.id, showTranslationColumn]);

  useEffect(() => {
    if (!rows.length) {
      setSelectedRowId("");
      return;
    }
    if (!rows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(rows[0].id);
    }
  }, [rows, selectedRowId]);

  useEffect(() => {
    if (pendingDeleteRowId && !rows.some((row) => row.id === pendingDeleteRowId)) {
      setPendingDeleteRowId("");
    }
  }, [pendingDeleteRowId, rows]);

  useEffect(() => {
    if (!pendingDeleteRowId) return undefined;
    const timeout = window.setTimeout(() => setPendingDeleteRowId(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [pendingDeleteRowId]);

  const jumpToFirstMissingTranslation = ({ showMessage = false } = {}) => {
    const targetIndex = rows.findIndex((row) => !String(row.translation || "").trim());
    const target = rows[targetIndex];
    if (!target) return false;
    setSelectedRowId(target.id);
    setTranslationRequested(true);
    if (showMessage) {
      setMessage(`已定位到第 ${targetIndex + 1} 条缺少译文的段落。`);
    }
    const escapeSelector = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
    window.setTimeout(() => {
      const rowElement = subtitleTableRef.current?.querySelector(`[data-row-id="${escapeSelector(target.id)}"]`);
      rowElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      const translationInput = document.querySelector(".current-segment-card .subtitle-translation-textarea") || rowElement?.querySelector(".subtitle-translation-textarea");
      translationInput?.focus?.();
    }, 0);
    return true;
  };

  const jumpToFirstEmptyText = ({ showMessage = false } = {}) => {
    const targetIndex = rows.findIndex((row) => !String(row.text || "").trim());
    const target = rows[targetIndex];
    if (!target) return false;
    setSelectedRowId(target.id);
    if (showMessage) {
      setMessage(`还有 ${emptyTextCount} 条空文本段落，已定位到第 ${targetIndex + 1} 条。请补齐或删除后再导出。`);
    }
    const escapeSelector = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
    window.setTimeout(() => {
      const rowElement = subtitleTableRef.current?.querySelector(`[data-row-id="${escapeSelector(target.id)}"]`);
      rowElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      const sourceInput = document.querySelector(".current-segment-card .subtitle-source-textarea") || rowElement?.querySelector(".subtitle-source-textarea");
      sourceInput?.focus?.();
    }, 0);
    return true;
  };

  const jumpToFirstTimingExportIssue = ({ showMessage = false } = {}) => {
    const targetIndex = rows.findIndex((row) => {
      const hints = qualityHintMap.get(row.id) || [];
      return hints.includes("时间无效") || hints.includes("时间重叠");
    });
    const target = rows[targetIndex];
    if (!target) return false;
    const hints = qualityHintMap.get(target.id) || [];
    setSelectedRowId(target.id);
    if (showMessage) {
      setMessage(`系统会在导出前自动整理 ${timingExportIssueCount} 条时间轴异常：${hints.filter((hint) => hint === "时间无效" || hint === "时间重叠").join("、")}。`);
    }
    const escapeSelector = globalThis.CSS?.escape || ((value) => String(value).replace(/"/g, '\\"'));
    window.setTimeout(() => {
      const rowElement = subtitleTableRef.current?.querySelector(`[data-row-id="${escapeSelector(target.id)}"]`);
      rowElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      document.querySelector("[aria-label='当前段落开始时间']")?.focus?.();
    }, 0);
    return true;
  };

  const requestExportMode = (mode) => {
    if (mode !== "source" && !translationExportAvailable) {
      setExportMode("source");
      setMessage("源语言与目标语言一致，无需译文或双语导出。");
      return;
    }
    if (mode === "source" || translationComplete) {
      setExportMode(mode);
      return;
    }
    setExportMode(mode);
    setTranslationRequested(true);
    jumpToFirstMissingTranslation();
    setMessage(`还有 ${missingTranslationCount} 条没有译文。已定位到第一条缺失段落，可手动补齐或使用翻译。`);
  };

  const jumpToFirstWorkbenchIssue = () => {
    if (emptyTextCount > 0) {
      jumpToFirstEmptyText({ showMessage: true });
      return;
    }
    if (timingExportIssueCount > 0) {
      jumpToFirstTimingExportIssue({ showMessage: true });
      return;
    }
    if (needsTranslationAttention) {
      jumpToFirstMissingTranslation({ showMessage: true });
    }
  };

  const moveSearchMatch = (direction) => {
    if (!searchMatches.length) return;
    setActiveSearchIndex((current) => (current + direction + searchMatches.length) % searchMatches.length);
  };

  const focusCurrentSegmentEditor = (field = "text") => {
    const selector = field === "translation"
      ? ".current-segment-card .subtitle-translation-textarea"
      : ".current-segment-card .subtitle-source-textarea";
    window.setTimeout(() => document.querySelector(selector)?.focus?.(), 0);
  };

  const jumpToNextQualityIssue = () => {
    if (!qualityIssueRows.length) return;
    const currentIndex = qualityIssueRows.findIndex((row) => row.id === activeReviewRow?.id);
    const nextRow = qualityIssueRows[(currentIndex + 1 + qualityIssueRows.length) % qualityIssueRows.length];
    selectReviewRow(nextRow, hasMediaPlayback);
    const hints = qualityHintMap.get(nextRow.id) || [];
    setMessage(`已定位到质量提示：${hints.join("、")}。`);
  };

  const repairLongSubtitleRows = () => {
    if (!longSubtitleIssueRows.length) return;
    const repairResult = repairReviewStructureUnlessEmpty(rows, structureRepairOptions);
    if (repairResult.addedRowCount <= 0) {
      jumpToNextQualityIssue();
      setMessage("当前长段缺少稳定断点，已定位到对应段落，可在校对区直接编辑。");
      return;
    }
    pushUndoSnapshot("自动拆分长段");
    setRows(repairResult.rows);
    markRowsEdited(repairResult.rows.length);
    const firstSplit = repairResult.rows.find((row) => !rows.some((oldRow) => oldRow.id === row.id && oldRow.text === row.text)) || repairResult.rows[0];
    setSelectedRowId(firstSplit?.id || "");
    setMessage(`已拆分 ${repairResult.splitRowCount} 条过长段落，新增 ${repairResult.addedRowCount} 条可校对段落。译文已按可确认对应关系保留，无法对应的译文已清空。`);
  };

  const handleSubtitleSearchKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveSearchMatch(event.shiftKey ? -1 : 1);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (subtitleSearch || event.currentTarget.value) setSubtitleSearch("");
      focusCurrentSegmentEditor("text");
    }
  };

  const replaceTextValue = (value, searchValue, replacementValue) => {
    const text = String(value || "");
    if (!searchValue) return text;
    const pattern = new RegExp(searchValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return text.replace(pattern, replacementValue);
  };

  const replaceReviewText = (scope) => {
    const query = subtitleSearch.trim();
    if (!query) {
      setMessage("请先输入要查找的内容。");
      return;
    }
    const normalizedQuery = query.toLowerCase();
    const rowHasReplaceTarget = (row) => [row.text, row.translation].some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
    const activeRowCanReplace = activeReviewRow && rowHasReplaceTarget(activeReviewRow);
    const fallbackTarget = rows.find(rowHasReplaceTarget);
    const currentTargetId = activeSearchRowId || (activeRowCanReplace ? activeReviewRow.id : fallbackTarget?.id);
    const targetIds = scope === "current" ? new Set([currentTargetId].filter(Boolean)) : null;
    let changedCount = 0;
    const nextRows = rows.map((row) => {
      if (targetIds && !targetIds.has(row.id)) return row;
      const nextText = replaceTextValue(row.text, query, subtitleReplace);
      const nextTranslation = replaceTextValue(row.translation, query, subtitleReplace);
      if (nextText === row.text && nextTranslation === row.translation) return row;
      changedCount += 1;
      return {
        ...row,
        text: nextText,
        translation: nextTranslation,
        originalText: row.originalText || row.text,
        reviewStatus: row.reviewStatus === "confirmed" ? "pending" : row.reviewStatus,
      };
    });
    if (!changedCount) {
      setMessage("当前校对文本和译文中没有可替换的匹配项。");
      return;
    }
    pushUndoSnapshot(scope === "current" ? "替换当前匹配" : "批量替换文本");
    const repairResult = repairReviewStructureUnlessEmpty(nextRows, structureRepairOptions);
    setRows(repairResult.rows);
    if (scope === "current" && currentTargetId) setSelectedRowId(currentTargetId);
    markRowsEdited(repairResult.rows.length);
    const splitText = repairResult.splitRowCount ? ` 已自动拆分 ${repairResult.splitRowCount} 条过长段落。` : "";
    setMessage(scope === "current" ? `已替换当前匹配项，可使用撤销恢复。${splitText}` : `已替换 ${changedCount} 条段落中的匹配项，可使用撤销恢复。${splitText}`);
  };

  const confirmInterruptingWork = (actionLabel) => {
    if (!busy) return true;
    if (!window.confirm(`当前任务正在执行，${actionLabel}会中断处理。\n\n确定继续吗？`)) return false;
    asrAbortRef.current?.abort();
    asrAbortRef.current = null;
    modelAbortRef.current?.abort();
    modelAbortRef.current = null;
    setBusy("");
    return true;
  };

  const handleMedia = (file) => {
    if (!file) return;
    if (!workspaceReady) {
      setMessage("请先配置本地工作区，再导入媒体文件。");
      return;
    }
    if (!confirmInterruptingWork("导入新媒体")) return;
    clearWorkbenchTranscriptionStatus({ persist: true });
    setPendingImport(null);
    const hasExistingRows = rows.length > 0;
    const replacingMedia = Boolean(media?.file);
    const url = URL.createObjectURL(file);
    pushUndoSnapshot(hasExistingRows ? (replacingMedia ? "更换关联媒体" : "关联媒体") : "导入媒体");
    if (!hasExistingRows) {
      setRows([]);
      setDraft("");
      setManualImport("");
      setManualImportOpen(false);
      setExportMode("source");
      setTranslationRequested(isSubtitleFileFlow);
    }
    setPlaybackTime(0);
    setMedia({ file, name: file.name, type: file.type, size: file.size, url, duration: 0 });
    const mediaMeta = `${file.type || "媒体文件"} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    if (hasExistingRows) {
      updateActiveRecent?.({
        meta: `${mediaMeta} · 已关联 ${rows.length} 条${segmentKind}`,
        status: "待校对",
        time: formatProjectTime(),
      });
      setMessage(`${file.type.startsWith("audio") ? "音频" : "视频"}已关联。已保留 ${rows.length} 条${segmentKind}段落，可按时间码定位校对；可使用撤销取消关联。`);
      return;
    }
    addRecent({
      name: file.name,
      meta: mediaMeta,
      status: "已导入",
      time: formatProjectTime(),
      type: file.type.startsWith("audio") ? "audio" : "video",
      tool: activeTool,
    });
    setMessage(file.type.startsWith("video")
      ? usesDashScopeFunAsr
        ? `视频已导入。当前配置会直接提交原始视频生成${segmentKind}文本。`
        : asrProvider.videoInputMode === "original"
          ? `视频已导入。当前配置会直接提交原始视频生成${segmentKind}文本。`
          : `视频已导入。可直接开始转写；当前配置会从视频内音轨生成转写输入。`
      : `音频已导入。可以开始转写，也可以继续导入已有${segmentKind}文本进行校对。`);
  };

  const handleAudioTrack = (file) => {
    if (!file) return;
    if (!workspaceReady) {
      setMessage("请先配置本地工作区，再关联备用音频文件。");
      return;
    }
    if (!media?.file?.type?.startsWith("video")) {
      setMessage("请先上传视频文件，再为这个视频关联备用音频文件。");
      return;
    }
    if (!confirmInterruptingWork("关联备用音频")) return;
    const url = URL.createObjectURL(file);
    setMedia((current) => current ? ({
      ...current,
      asrAudio: { file, name: file.name, type: file.type, size: file.size, url, duration: 0 },
    }) : current);
    updateActiveRecent?.({
      meta: `${media.type || "视频"} · ${(media.size / 1024 / 1024).toFixed(1)} MB · 已关联备用音频`,
      time: formatProjectTime(),
    });
    setMessage("备用音频已关联。开始转写时会优先使用这条音频，视频继续用于预览和字幕校对。");
  };

  const updateMediaDuration = (url, duration) => {
    const safeDuration = Number.isFinite(duration) ? duration : 0;
    setMediaPreviewError("");
    setMedia((current) => (current?.url === url ? { ...current, duration: safeDuration } : current));
  };

  const handleMediaPreviewError = () => {
    setMediaPreviewError(media?.type?.startsWith("audio")
      ? "浏览器无法预览此音频。仍可提交到转写服务，或导入已有转写文本继续校对。"
      : "浏览器无法预览此视频。仍可提交到转写服务，或导入已有转写/字幕文本继续校对。");
  };

  const updateAudioTrackDuration = (url, duration) => {
    const safeDuration = Number.isFinite(duration) ? duration : 0;
    setMedia((current) => {
      if (!current?.asrAudio || current.asrAudio.url !== url) return current;
      return { ...current, asrAudio: { ...current.asrAudio, duration: safeDuration } };
    });
  };

  const seekToRow = (row) => {
    const start = Math.max(0, Number(row?.start) || 0);
    if (!mediaElementRef.current) {
      setPlaybackTime(start);
      return;
    }
    try {
      mediaElementRef.current.currentTime = start;
      setPlaybackTime(start);
      mediaElementRef.current.focus?.();
    } catch {
      setPlaybackTime(start);
    }
  };

  const playReviewRow = (row, loop = false) => {
    if (!row?.id) return;
    const mediaElement = mediaElementRef.current;
    const start = Math.max(0, Number(row.start) || 0);
    const loopAlreadyActive = loop && segmentLoopRowId === row.id;

    setSelectedRowId(row.id);

    if (loopAlreadyActive) {
      setSegmentLoopRowId("");
      setSegmentPlaybackRowId("");
      mediaElement?.pause?.();
      return;
    }

    setSegmentLoopRowId(loop ? row.id : "");
    setSegmentPlaybackRowId(loop ? "" : row.id);

    if (!mediaElement) {
      setPlaybackTime(start);
      return;
    }

    try {
      mediaElement.currentTime = start;
      setPlaybackTime(start);
      const playResult = mediaElement.play?.();
      playResult?.catch?.(() => {});
    } catch {
      setPlaybackTime(start);
    }
  };

  const handleMediaTimeUpdate = (event) => {
    const mediaElement = event.currentTarget;
    const currentTime = Number(mediaElement?.currentTime) || 0;
    const trackedRowId = segmentLoopRowId || segmentPlaybackRowId;
    const trackedRow = rows.find((row) => row.id === trackedRowId);

    if (trackedRow) {
      const start = Math.max(0, Number(trackedRow.start) || 0);
      const end = Math.max(start, Number(trackedRow.end) || start);
      if (end > start && currentTime >= end) {
        if (segmentLoopRowId === trackedRow.id) {
          mediaElement.currentTime = start;
          setPlaybackTime(start);
          const playResult = mediaElement.play?.();
          playResult?.catch?.(() => {});
          return;
        }
        mediaElement.pause?.();
        mediaElement.currentTime = end;
        setSegmentPlaybackRowId("");
        setPlaybackTime(end);
        return;
      }
    }

    setPlaybackTime(currentTime);
  };

  const handleMediaEnded = () => {
    setSegmentPlaybackRowId("");
    setSegmentLoopRowId("");
  };

  const selectReviewRow = (row, shouldSeek = false) => {
    if (!row?.id) return;
    setSelectedRowId(row.id);
    if (shouldSeek) seekToRow(row);
  };

  const moveReviewRow = (offset) => {
    if (!rows.length) return;
    const currentIndex = activeReviewIndex >= 0 ? activeReviewIndex : 0;
    const nextIndex = Math.min(rows.length - 1, Math.max(0, currentIndex + offset));
    const nextRow = rows[nextIndex];
    if (nextRow) selectReviewRow(nextRow, true);
  };

  const moveReviewPage = (offset) => {
    if (!rows.length) return;
    const nextPage = Math.min(reviewPageCount - 1, Math.max(0, activeReviewPageIndex + offset));
    const target = rows[nextPage * REVIEW_PAGE_SIZE];
    if (target) selectReviewRow(target, hasMediaPlayback);
  };

  const jumpReviewPage = (pageIndex) => {
    if (!rows.length) return;
    const nextPage = Math.min(reviewPageCount - 1, Math.max(0, Number(pageIndex) || 0));
    const target = rows[nextPage * REVIEW_PAGE_SIZE];
    if (target) selectReviewRow(target, hasMediaPlayback);
  };

  const updateReviewStatus = (rowId, status, advance = false) => {
    if (!rowId) return;
    const targetRow = rows.find((row) => row.id === rowId);
    if (status === "confirmed" && !String(targetRow?.text || "").trim()) {
      setMessage("当前段落没有可确认的校对文本。");
      return;
    }
    pushUndoSnapshot(status === "confirmed" ? "确认段落" : "标记段落");
    setRows((current) => current.map((row) => (row.id === rowId ? { ...row, reviewStatus: status } : row)));
    markRowsEdited(rows.length);
    if (advance) {
      window.setTimeout(() => moveReviewRow(1), 0);
    }
  };

  const handleCurrentEditorKeyDown = (event, rowId, field) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      finishTextEditSnapshot(rowId, field);
      updateReviewStatus(rowId, "confirmed", true);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "ArrowUp") {
      event.preventDefault();
      finishTextEditSnapshot(rowId, field);
      pendingEditorFocusRef.current = field;
      moveReviewRow(-1);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "ArrowDown") {
      event.preventDefault();
      finishTextEditSnapshot(rowId, field);
      pendingEditorFocusRef.current = field;
      moveReviewRow(1);
    }
  };

  const throwIfAsrAborted = (signal) => {
    if (signal?.aborted) throw new DOMException("转写已取消。", "AbortError");
  };

  const throwIfModelAborted = (signal) => {
    if (signal?.aborted) throw new DOMException("处理已取消。", "AbortError");
  };

  const isAbortError = (error) => error?.name === "AbortError";

  const createModelAbortController = () => {
    modelAbortRef.current?.abort();
    const abortController = new AbortController();
    modelAbortRef.current = abortController;
    return abortController;
  };

  const clearModelAbortController = (abortController) => {
    if (modelAbortRef.current === abortController) modelAbortRef.current = null;
  };

  const cancelModelTask = () => {
    if (!modelAbortRef.current) return;
    modelAbortRef.current.abort();
    modelAbortRef.current = null;
    setBusy("");
    setMessage("已取消处理。已保留当前校对内容。");
  };

  const cancelTranscription = () => {
    if (!asrAbortRef.current) return;
    asrAbortRef.current.abort();
    asrAbortRef.current = null;
    setBusy("");
    const cancelMessage = "已取消转写。已保留当前媒体和已有校对内容。";
    setMessage(cancelMessage);
    setWorkbenchTranscriptionStatus({
      state: "cancelled",
      message: cancelMessage,
      stage: "取消转写",
      retryable: true,
    }, { persist: true });
  };

  const restoreTextOnlyAsrResult = async (result, signal) => {
    throwIfAsrAborted(signal);
    const rawText = String(result?.text || result?.transcript || "").trim();
    const hasTimedResult = (Array.isArray(result?.words) && result.words.length) || (Array.isArray(result?.segments) && result.segments.length);
    if (!llmReady || hasTimedResult || !rawText) return result;
    const prompt = `请把下面这段 ASR 逐字稿恢复标点，并切成适合字幕校对的短句。
要求：
1. 只添加标点和合理断句，不添加原文没有的信息，不改写成文章。
2. 每条字幕尽量保持 8-26 个中文字符；英文每条 6-18 个词。
3. 专有名词优先参考术语库；不确定时保留原文。
4. 只返回 JSON 数组，每项包含 text。
源语言：${sourceLanguage}。
转写提示：${transcriptionContext.trim() || "无"}。
术语参考：${formatTermReference(terms)}。
ASR 逐字稿：
${rawText}`;
    const text = await callChat(provider, [
      { role: "system", content: "你是字幕断句助手。只能基于 ASR 原文恢复标点和分段，不能补充信息。" },
      { role: "user", content: prompt },
    ], { max_completion_tokens: 1200, signal });
    throwIfAsrAborted(signal);
    const parsed = parseJsonArrayFromModelText(text);
    const segments = parsed
      .map((item) => getCorrectedTextValue(item))
      .map((item) => item.trim())
      .filter(Boolean);
    return segments.length ? { ...result, text: segments.join("\n") } : result;
  };

  const startTranscription = async () => {
    if (busy === "asr") return;
    if (!workspaceReady || !hasTranscriptionInput || !transcriptionReady || !asrLanguageCompatible) {
      const errorMessage = `转写未开始：${startBlockedMessage || startTranscriptionHint}`;
      setMessage(errorMessage);
      setWorkbenchTranscriptionStatus({
        state: "error",
        message: errorMessage,
        stage: !workspaceReady || !hasTranscriptionInput ? "准备转写输入" : "读取转写配置",
        retryable: Boolean(workspaceReady && hasTranscriptionInput),
      }, { persist: true });
      return;
    }
    const compatibilityMessage = getAsrLanguageCompatibilityWarning(asrProvider, sourceLanguage);
    if (compatibilityMessage) {
      const errorMessage = `转写未开始：${compatibilityMessage}`;
      setMessage(errorMessage);
      setWorkbenchTranscriptionStatus({ state: "error", message: errorMessage, stage: "读取转写配置", retryable: true }, { persist: true });
      return;
    }
    const abortController = new AbortController();
    asrAbortRef.current = abortController;
    setBusy("asr");
    setMessage("");
    setWorkbenchTranscriptionStatus({ state: "running", message: "正在准备转写任务。", stage: "准备转写输入" });
    setWorkspaceState((current) => ({ ...current, lastTranscriptionStatus: null }));
    const setTranscriptionProgress = (text, stage = "") => {
      setMessage(text);
      setWorkbenchTranscriptionStatus({ state: "running", message: text, stage });
    };
    const submitAsrInput = async (input, requestedLanguageCode) => {
      const request = (languageCodeForRequest) => (input.workspaceProjectId
        ? callWorkspaceAsr(asrProvider, input, languageCodeForRequest, { signal: abortController.signal })
        : callAsr(asrProvider, input.file, languageCodeForRequest, { signal: abortController.signal }));
      try {
        return await request(requestedLanguageCode);
      } catch (error) {
        if (isTransientAsrConnectionError(error)) {
          setTranscriptionProgress("转写服务连接中断，正在自动重试。", error.stage || "连接转写服务");
          await wait(900, abortController.signal);
          return request(requestedLanguageCode);
        }
        const fallbackLanguageCode = fallbackAsrLanguageCodeForRetry(asrProvider);
        if (!isAsrLanguageParameterError(error) || !fallbackLanguageCode || fallbackLanguageCode === requestedLanguageCode) {
          throw error;
        }
        setTranscriptionProgress(`当前转写服务拒绝语言参数，已自动改用 ${fallbackLanguageCode} 重试。`, "读取转写配置");
        return request(fallbackLanguageCode);
      }
    };
    try {
      const usingAudioTrack = Boolean(media?.asrAudio);
      const asrMediaSource = usingAudioTrack ? media.asrAudio : media;
      const asrSource = {
        file: asrMediaSource?.file || null,
        workspaceUrl: asrMediaSource?.workspaceUrl || "",
        workspaceField: usingAudioTrack ? "asrAudio" : "media",
        duration: asrMediaSource?.duration || media?.duration || 0,
        fromAudioTrack: usingAudioTrack,
        name: asrMediaSource?.name || media?.name || "media",
        type: asrMediaSource?.type || media?.type || "",
        lastModified: asrMediaSource?.lastModified || media?.lastModified || 0,
      };
      const recoveredFile = !asrSource.file && !workspaceSourceReady && asrSource.workspaceUrl
        ? await fileFromWorkspaceMedia(asrSource)
        : null;
      if (recoveredFile) setTranscriptionProgress("已从本地工作区读取媒体副本，正在准备转写输入。", "读取本地工作区媒体");
      const asrFile = asrSource.file || recoveredFile;
      const asrInputs = asrFile
        ? await prepareAsrInputs(asrFile, asrSource.duration, setTranscriptionProgress, asrProvider)
        : workspaceSourceReady
          ? [{
            workspaceProjectId: activeProjectId,
            workspaceField: asrSource.workspaceField,
            duration: asrSource.duration,
            offset: 0,
            directOriginal: true,
            workspaceOriginal: true,
          }]
          : [];
      if (!asrInputs.length) {
        throw new Error("本地副本无法作为当前转写服务的输入。工作台没有提交空任务；请重新上传媒体，或在模型配置中改用支持原始媒体文件的转写服务。");
      }
      const languageCode = getAsrLanguageCode(asrProvider, sourceLanguage);
      const parsedRows = [];
      const rawResults = [];
      for (let index = 0; index < asrInputs.length; index += 1) {
        const input = asrInputs[index];
        setTranscriptionProgress(asrInputs.length > 1
          ? `正在调用 ${asrProvider.model || "云端 ASR"} 转写第 ${index + 1}/${asrInputs.length} 段。`
          : `正在调用 ${asrProvider.model || "云端 ASR"} 转写。`, "调用转写服务");
        throwIfAsrAborted(abortController.signal);
        const result = await submitAsrInput(input, languageCode);
        throwIfAsrAborted(abortController.signal);
        rawResults.push(result);
        const normalizedResult = await restoreTextOnlyAsrResult(result, abortController.signal);
        parsedRows.push(...offsetRows(rowsFromAsrResult(normalizedResult, input.duration), input.offset));
      }
      throwIfAsrAborted(abortController.signal);
      const parsed = repairAsrTimeline(mergeShortAdjacentAsrRows(dedupeAdjacentAsrRows(parsedRows)));
      if (!parsed.length) {
        throw new Error("转写服务已响应，但没有返回可用文本。工作台没有写入空结果；请检查媒体是否有清晰语音，或在模型配置中改用更适合该素材的转写服务。");
      }
      const dedupeCount = Math.max(0, parsedRows.length - parsed.length);
      let finalRows = parsed;
      let correctionText = llmReady ? "" : "可配置文本模型后再点击“校正转写”。";
      if (llmReady) {
        try {
          finalRows = await correctRowsWithModel(parsed, { signal: abortController.signal });
          correctionText = "已完成保守文本校正。";
        } catch (error) {
          correctionText = `自动校正未完成：${error.message || "文本模型请求失败"}。已保留 ASR 原始结果。`;
        }
      }
      const readableRepair = repairReviewStructure(finalRows, { maxEnd: asrSource.duration });
      const reviewRows = readableRepair.rows;
      pushUndoSnapshot("生成转写结果");
      setRows(reviewRows);
      setDraft("");
      setExportMode("source");
      setTranslationRequested(false);
      addRecent({
        name: media.name,
        meta: `${asrProvider.model || "云端 ASR"} · ${reviewRows.length} 条`,
        status: llmReady && correctionText.startsWith("已完成") ? "已校正待核对" : "待校对",
        time: formatProjectTime(),
        type: media.type.startsWith("audio") ? "audio" : "video",
        tool: activeTool,
      });
      const hasTiming = rawResults.some(asrResultHasTiming);
      const conversionText = asrSource.fromAudioTrack
        ? "已使用备用音频文件进行转写。"
        : asrInputs.some((input) => input.workspaceOriginal)
          ? "已从本地工作区副本提交媒体文件给云端转写服务。"
        : usesDashScopeFunAsr && asrSource.type?.startsWith("video")
          ? "已直接提交原始视频文件给百炼 ASR。"
        : asrInputs.some((input) => input.directOriginal)
          ? asrInputs.some((input) => input.fallbackFromVideoDecode)
            ? "浏览器无法抽取视频音轨，已改为直接提交原始视频文件给云端转写服务。"
            : (asrSource.type?.startsWith("video") ? "已直接提交原始视频文件给云端转写服务。" : "已直接提交原始音频文件给云端转写服务。")
        : asrInputs.some((input) => input.converted)
          ? "已先从媒体中生成 16kHz 单声道 WAV 音频。"
          : "";
      const chunkText = asrInputs.length > 1 ? `已分 ${asrInputs.length} 段提交，降低长文件漏识别和超时风险。` : "";
      const dedupeText = dedupeCount ? `已合并 ${dedupeCount} 条重叠重复段落。` : "";
      const qualityIssue = detectTranscriptionQualityIssue(reviewRows, sourceLanguage, asrSource.duration);
      const readabilityText = readableRepair.splitRowCount ? `已自动拆分 ${readableRepair.splitRowCount} 条过长段落。` : "";
      const shortFragmentText = readableRepair.mergedRowCount ? `已自动合并 ${readableRepair.mergedRowCount} 条短碎片。` : "";
      const qualityText = qualityIssue ? ` ${qualityIssue}` : " 可继续校对文本、专有名词和低置信片段。";
      const successMessage = hasTiming ? `${conversionText}${chunkText}${dedupeText}${readabilityText}${shortFragmentText}云端转写完成，已生成 ${reviewRows.length} 条可编辑段落。${correctionText}${qualityText}` : `${conversionText}${chunkText}${dedupeText}${readabilityText}${shortFragmentText}云端转写完成，已生成 ${reviewRows.length} 条可编辑段落；当前模型未返回词级时间戳，系统已按文本自动生成时间轴。${correctionText}${qualityText}`;
      setMessage(successMessage);
      setWorkbenchTranscriptionStatus({ state: "success", message: successMessage, stage: "生成校对结果" });
      setWorkspaceState((current) => ({ ...current, lastTranscriptionStatus: null }));
    } catch (error) {
      const errorMessage = formatAsrFailureMessage(error);
      if (isAsrLanguageParameterError(error)) {
        markAsrProviderRuntimeFailure("转写任务失败：当前服务未通过素材语言或音频参数校验，系统已暂停将其视为可用转写服务。");
      }
      setMessage(errorMessage);
      setWorkbenchTranscriptionStatus({
        state: error?.name === "AbortError" ? "cancelled" : "error",
        message: errorMessage,
        stage: error?.stage || (error?.name === "AbortError" ? "取消转写" : "调用转写服务"),
        code: error?.code || "",
        retryable: error?.retryable ?? true,
      }, { persist: true });
    } finally {
      if (asrAbortRef.current === abortController) asrAbortRef.current = null;
      setBusy("");
    }
  };

  const applyImportedRows = (parsed, options = {}) => {
    const { name = "", source = "file", replaceExisting = rows.length > 0, splitRowCount = 0 } = options;
    const hadRows = rows.length > 0;
    pushUndoSnapshot(source === "manual" ? "导入文本" : "导入字幕/转写文件");
    setRows(parsed);
    setDraft("");
    if (source === "manual") {
      setManualImport("");
      setManualImportOpen(false);
    }
    setPendingImport(null);
    const importedHasCompleteTranslations = rowsHaveCompleteTranslations(parsed);
    setWorkspaceState((current) => ({
      ...current,
      ...(inferImportedLanguageState(parsed, current) || {}),
      exportMode: importedHasCompleteTranslations ? "bilingual" : "source",
      translationRequested: isSubtitleFileFlow || importedHasCompleteTranslations,
    }));
    const time = formatProjectTime();
    if (media?.url || activeProjectId) {
      const activeImportMeta = isSubtitleFileFlow
        ? `${hadRows || replaceExisting ? "已替换" : "已导入"}${source === "manual" ? "字幕文本" : "字幕文件"} · ${parsed.length} 条`
        : `${selectedFeature.title} · ${hadRows || replaceExisting ? "已替换" : "已导入"}文本 · ${parsed.length} 条`;
      updateActiveRecent?.({
        meta: activeImportMeta,
        status: "待校对",
        time,
      });
    } else {
      const standaloneImportMeta = isSubtitleFileFlow
        ? `${source === "manual" ? "字幕文本" : "字幕文件"} · ${parsed.length} 条`
        : `${selectedFeature.title} · 导入文本 · ${parsed.length} 条`;
      const manualFallbackName = isSubtitleWorkflow ? "手动导入字幕文本" : "手动导入转写文本";
      addRecent({
        name: source === "manual" ? inferManualImportProjectName(parsed, manualFallbackName) : name,
        meta: standaloneImportMeta,
        status: source === "manual" ? "已导入" : "已解析",
        time,
        type: "document",
        tool: activeTool,
      });
    }
    const mergedText = options.mergedRowCount ? `已自动合并 ${options.mergedRowCount} 条短碎片。` : "";
    const splitText = splitRowCount ? `已自动拆分 ${splitRowCount} 条过长段落。` : "";
    setMessage(hadRows
      ? `已替换当前校对表，导入 ${parsed.length} 条${segmentKind}段落。${mergedText}${splitText}可使用撤销恢复上一步。`
      : `已解析 ${parsed.length} 条${segmentKind}段落。${mergedText}${splitText}`);
  };

  const requestImportRows = (parsed, options = {}) => {
    if (rows.length > 0) {
      setPendingImport({ ...options, rows: parsed });
      setMessage(`当前已有 ${rows.length} 条${segmentKind}段落。新导入的 ${parsed.length} 条会替换当前校对表，请确认后继续。`);
      return;
    }
    applyImportedRows(parsed, { ...options, replaceExisting: false });
  };

  const handleSubtitle = async (file) => {
    if (!file) return;
    if (!workspaceReady) {
      setMessage("请先配置本地工作区，再导入字幕或转写文件。");
      return;
    }
    if (!confirmInterruptingWork("导入字幕或转写文件")) return;
    const text = await file.text();
    const repairResult = repairReviewStructure(parseSubtitle(text), structureRepairOptions);
    const parsed = repairResult.rows;
    if (!parsed.length) {
      setMessage("没有解析到可导入的字幕或文本内容。");
      return;
    }
    requestImportRows(parsed, { source: "file", name: file.name, splitRowCount: repairResult.splitRowCount, mergedRowCount: repairResult.mergedRowCount });
  };

  const importManualText = () => {
    if (!workspaceReady) {
      setMessage("请先配置本地工作区，再导入字幕或转写文本。");
      return;
    }
    const repairResult = repairReviewStructure(parseSubtitle(manualImport), structureRepairOptions);
    const parsed = repairResult.rows;
    if (!parsed.length) {
      setMessage("请输入可导入的字幕或转写文本。");
      return;
    }
    requestImportRows(parsed, { source: "manual", name: inferManualImportProjectName(parsed, isSubtitleWorkflow ? "手动导入字幕文本" : "手动导入转写文本"), splitRowCount: repairResult.splitRowCount, mergedRowCount: repairResult.mergedRowCount });
  };

  const confirmPendingImport = () => {
    if (!pendingImport?.rows?.length) return;
    applyImportedRows(pendingImport.rows, pendingImport);
  };

  const cancelPendingImport = () => {
    setPendingImport(null);
    setMessage("已取消替换，当前校对表未改变。");
  };

  const updateRow = (id, patch) => {
    setRows((current) => current.map((row) => {
      if (row.id !== id) return row;
      const originalText = Object.hasOwn(patch, "text") && !row.originalText ? row.text : row.originalText;
      return { ...row, originalText, ...patch };
    }));
  };

  const commitRowTimecode = (rowId, field, value) => {
    const parsed = parseEditableTimecode(value);
    const row = rows.find((item) => item.id === rowId);
    if (!row) return false;
    if (parsed === null) {
      setMessage("时间码格式不正确，请使用 00:00.000 或 00:00:00.000。");
      return false;
    }
    if (field === "start" && parsed >= row.end) {
      setMessage("开始时间必须早于结束时间。");
      return false;
    }
    if (field === "end" && parsed <= row.start) {
      setMessage("结束时间必须晚于开始时间。");
      return false;
    }
    if (Math.abs((row[field] || 0) - parsed) < 0.001) return true;
    pushUndoSnapshot("编辑时间码");
    setRows((current) => {
      const editedRows = current.map((item) => (item.id === rowId
        ? {
          ...item,
          [field]: parsed,
          ...(item.reviewStatus === "confirmed" ? { reviewStatus: "pending" } : {}),
        }
        : item));
      return repairReviewStructureUnlessEmpty(editedRows, structureRepairOptions).rows;
    });
    markRowsEdited(rows.length);
    return true;
  };

  const correctRowsWithModel = async (inputRows, options = {}) => {
    const { signal } = options;
    const chunks = chunkRowsForModel(inputRows);
    const correctedRows = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      setMessage(`正在校正${segmentKind}文本（${index + 1}/${chunks.length}）。`);
      throwIfAsrAborted(signal);
      const prompt = `请校正下面的${segmentKind}文本。要求：
1. 只修正标点、断句、大小写、空格、明显 ASR 识别错字和可由上下文直接确认的同音错字。
2. 转写提示和术语库只用于判断专有名词、人物名、产品名、章节名和同音词；不能据此添加原文没有的信息。
3. 不补充没有出现在原文中的信息，不扩写，不改写成文章。
4. 保持 id、start、end、speaker 不变，数组长度必须与输入一致，不合并或拆分条目。
5. 只返回 JSON 数组，每项包含 id 和 text。
源语言：${sourceLanguage}。
转写提示：${transcriptionContext.trim() || "无"}。
术语参考：${formatTermReference(terms)}。
输入：
${JSON.stringify(chunk.map((row) => ({ id: row.id, start: row.start, end: row.end, speaker: row.speaker, text: row.text })))}`;
      const text = await callChat(provider, [
        { role: "system", content: "你是严谨的转写校对助手。你的任务是保守校正，不创造信息，不重写观点。" },
        { role: "user", content: prompt },
      ], { max_completion_tokens: 2200, signal });
      throwIfAsrAborted(signal);
      const parsed = parseJsonArrayFromModelText(text);
      chunk.forEach((row, rowIndex) => {
        const foundById = parsed.find((item) => item && typeof item === "object" && String(item.id) === String(row.id));
        const correctedText = getCorrectedTextValue(foundById || parsed[rowIndex]);
        correctedRows.push(correctedText ? { ...row, text: correctedText } : row);
      });
    }
    return correctedRows;
  };

  const correctCurrentRows = async () => {
    if (!llmReady || !rows.length || modelAbortRef.current) return;
    const abortController = createModelAbortController();
    setBusy("correct");
    setMessage("");
    try {
      const repairResult = repairReviewStructureUnlessEmpty(await correctRowsWithModel(rows, { signal: abortController.signal }), structureRepairOptions);
      const corrected = repairResult.rows;
      throwIfModelAborted(abortController.signal);
      pushUndoSnapshot(`校正${segmentKind}`);
      setRows(corrected);
      updateActiveRecent?.({
        status: "已校正",
        meta: `${segmentKind}校正 · ${corrected.length} 条`,
        time: formatProjectTime(),
      });
      const splitText = repairResult.splitRowCount ? `已自动拆分 ${repairResult.splitRowCount} 条过长段落。` : "";
      setMessage(`已校正 ${corrected.length} 条${segmentKind}文本。${splitText}可继续核对文本和专有名词。`);
    } catch (error) {
      if (isAbortError(error)) return;
      setMessage(error.message || `${segmentKind}校正失败。`);
    } finally {
      clearModelAbortController(abortController);
      if (!abortController.signal.aborted) setBusy("");
    }
  };

  const addRow = () => {
    if (!workspaceReady) {
      setMessage("请先配置本地工作区，再添加校对段落。");
      return;
    }
    const nextCount = rows.length + 1;
    const time = formatProjectTime();
    if (!activeProjectId && !media?.url) {
      addRecent({
        name: isTranscriptionFlow ? "手动创建转写项目" : "手动创建字幕项目",
        meta: `手动创建 · ${nextCount} 条`,
        status: "待校对",
        time,
        type: "document",
        tool: activeTool,
      });
    } else {
      updateActiveRecent?.({
        meta: `手动编辑 · ${nextCount} 条`,
        status: "待校对",
        time,
      });
    }
    const activeIndex = rows.findIndex((row) => row.id === selectedRowId);
    const insertIndex = activeIndex >= 0 ? activeIndex + 1 : rows.length;
    const anchorRow = activeIndex >= 0 ? rows[activeIndex] : rows.at(-1);
    const nextRow = rows[insertIndex];
    const fallbackStart = rows.length ? Math.max(...rows.map((row) => Number(row.end) || 0)) : 0;
    const start = Number.isFinite(Number(anchorRow?.end)) ? Number(anchorRow.end) : fallbackStart;
    const nextStart = Number(nextRow?.start);
    const end = Number.isFinite(nextStart) && nextStart > start ? nextStart : start + 3;
    const text = addRowText || "";
    const newRow = { id: `row-${Date.now()}`, start, end, speaker: "未标注", text, originalText: text, translation: "", reviewStatus: "pending" };
    pushUndoSnapshot("添加段落");
    const nextRows = [
      ...rows.slice(0, insertIndex),
      newRow,
      ...rows.slice(insertIndex),
    ];
    setRows(repairReviewStructureUnlessEmpty(nextRows, structureRepairOptions).rows);
    markRowsEdited(nextRows.length);
    setSelectedRowId(newRow.id);
  };

  const markRowsEdited = (nextCount) => {
    updateActiveRecent?.({
      meta: `手动编辑 · ${nextCount} 条`,
      status: nextCount ? "待校对" : "空项目",
      time: formatProjectTime(),
    });
  };

  const renameSpeakerLabel = (sourceSpeaker, nextSpeaker) => {
    const source = displaySpeakerLabel(sourceSpeaker);
    const target = String(nextSpeaker || "").trim();
    if (!source || !target || source === target) return;
    pushUndoSnapshot("重命名说话人");
    const nextRows = rows.map((row) => (
      displaySpeakerLabel(row.speaker) === source
        ? { ...row, speaker: target, reviewStatus: row.reviewStatus === "confirmed" ? "pending" : row.reviewStatus }
        : row
    ));
    setRows(nextRows);
    markRowsEdited(nextRows.length);
    setMessage(`已将 ${source} 重命名为 ${target}。`);
  };

  const assignRowSpeaker = (rowId, nextSpeaker) => {
    const target = String(nextSpeaker || "未标注").trim() || "未标注";
    const currentRow = rows.find((row) => row.id === rowId);
    if (!currentRow || currentRow.speaker === target) return;
    pushUndoSnapshot("修改段落说话人");
    const nextRows = rows.map((row) => (row.id === rowId
      ? { ...row, speaker: target, reviewStatus: row.reviewStatus === "confirmed" ? "pending" : row.reviewStatus }
      : row));
    setRows(nextRows);
    markRowsEdited(nextRows.length);
    setMessage(`已将当前段落归为 ${displaySpeakerLabel(target) || "未标注"}。`);
  };

  const splitSegmentText = (value) => {
    const text = String(value || "").trim();
    if (text.length < 2) return null;
    const midpoint = Math.floor(text.length / 2);
    const punctuation = ["。", "！", "？", "；", "，", ".", "!", "?", ";", ","];
    let splitAt = -1;
    for (let radius = 0; radius <= midpoint; radius += 1) {
      const rightIndex = midpoint + radius;
      const leftIndex = midpoint - radius;
      if (punctuation.includes(text[rightIndex])) {
        splitAt = rightIndex + 1;
        break;
      }
      if (punctuation.includes(text[leftIndex])) {
        splitAt = leftIndex + 1;
        break;
      }
    }
    if (splitAt <= 0 || splitAt >= text.length) splitAt = midpoint;
    const before = text.slice(0, splitAt).trim();
    const after = text.slice(splitAt).trim();
    if (!before || !after) return null;
    return { before, after };
  };

  const splitSegmentTextAt = (value, index) => {
    const text = String(value || "");
    const splitAt = Number(index);
    if (!Number.isFinite(splitAt) || splitAt <= 0 || splitAt >= text.length) return null;
    const before = text.slice(0, splitAt).trim();
    const after = text.slice(splitAt).trim();
    if (!before || !after) return null;
    return { before, after };
  };

  const writeClipboardText = async (text) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the selection-based copy path when browser permissions block the async clipboard API.
      }
    }
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.left = "-9999px";
    field.style.top = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(field);
    if (!copied) throw new Error("浏览器拒绝访问剪贴板");
  };

  const copyCurrentSegment = async () => {
    if (!activeReviewRow) return;
    const lines = [
      `[${formatClock(activeReviewRow.start)} - ${formatClock(activeReviewRow.end)}]`,
      activeSpeakerLabel ? `说话人：${activeSpeakerLabel}` : "",
      `校对稿：${activeReviewRow.text || ""}`,
      showTranslationColumn && activeReviewRow.translation ? `译文：${activeReviewRow.translation}` : "",
    ].filter(Boolean);
    try {
      await writeClipboardText(lines.join("\n"));
      setMessage("已复制当前段落。");
    } catch (error) {
      setMessage(`复制失败：${error.message || "浏览器拒绝访问剪贴板"}`);
    }
  };

  const cleanTextLinesForCopy = (row, mode) => {
    const source = String(row.text || "").trim();
    const target = String(row.translation || "").trim();
    if (mode === "target") return target ? [target] : [];
    if (mode === "bilingual") {
      return [
        source ? `原文：${source}` : "",
        target ? `译文：${target}` : "",
      ].filter(Boolean);
    }
    return source ? [source] : [];
  };

  const copyAllCleanText = async () => {
    if (!rows.length) return;
    if ((currentExportMode === "target" || currentExportMode === "bilingual") && !translationComplete) {
      setMessage(`还有 ${missingTranslationCount} 条没有译文，无法复制${currentExportMode === "target" ? "译文" : "双语"}全文。请先翻译或手动补齐译文。`);
      jumpToFirstMissingTranslation();
      return;
    }
    const content = rows.map((row) => cleanTextLinesForCopy(row, currentExportMode).join("\n")).filter(Boolean).join("\n\n");
    if (!content.trim()) {
      setMessage("没有可复制的文本。");
      return;
    }
    try {
      await writeClipboardText(content);
      setMessage(`已复制${translationFlowActive ? exportModeLabel : ""}全文。`);
    } catch (error) {
      setMessage(`复制失败：${error.message || "浏览器拒绝访问剪贴板"}`);
    }
  };

  const getActiveSplitTextParts = (row) => (textSelectionRef.current.rowId === row?.id
    ? splitSegmentTextAt(row.text, textSelectionRef.current.index) || splitSegmentText(row.text)
    : splitSegmentText(row.text));

  const joinSegmentText = (before, after) => {
    const left = String(before || "").trim();
    const right = String(after || "").trim();
    if (!left) return right;
    if (!right) return left;
    if (/[。！？；，、,.!?;]$/.test(left) || /^[。！？；，、,.!?;]/.test(right)) {
      return `${left}${right}`;
    }
    if (/[\u4e00-\u9fff]$/.test(left) && /^[\u4e00-\u9fff]/.test(right)) {
      return `${left}${right}`;
    }
    return `${left} ${right}`;
  };

  const splitRow = (row) => {
    if (!canSplitReviewRow(row)) {
      setMessage("当前段落太短或时间码不足，不能继续拆分。");
      return;
    }
    const textParts = getActiveSplitTextParts(row);
    if (!textParts) {
      setMessage("当前段落内容太短，无法拆分。");
      return;
    }
    const index = rows.findIndex((item) => item.id === row.id);
    if (index < 0) return;
    const sourceRow = rows[index];
    const start = Number(sourceRow.start) || 0;
    const end = Number(sourceRow.end) || start + 2;
    const duration = Math.max(0.4, end - start);
    const ratio = textParts.before.length / Math.max(1, textParts.before.length + textParts.after.length);
    const splitTime = Math.min(end - 0.1, Math.max(start + 0.1, start + duration * ratio));
    const originalTextParts = sourceRow.originalText
      ? (textSelectionRef.current.rowId === sourceRow.id
        ? splitSegmentTextAt(sourceRow.originalText, textSelectionRef.current.index)
        : null) || splitSegmentText(sourceRow.originalText) || textParts
      : textParts;
    const nextRows = [
      ...rows.slice(0, index),
      { ...sourceRow, text: textParts.before, originalText: originalTextParts.before, end: splitTime, translation: "", reviewStatus: "pending" },
      {
        ...sourceRow,
        id: `row-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        start: splitTime,
        end,
        text: textParts.after,
        originalText: originalTextParts.after,
        translation: "",
        reviewStatus: "pending",
      },
      ...rows.slice(index + 1),
    ];
    pushUndoSnapshot("拆分段落");
    const readableRepair = repairReadableReviewRows(repairAsrTimeline(nextRows));
    const repairedRows = repairAsrTimeline(readableRepair.rows);
    setRows(normalizeReviewRows(repairedRows));
    markRowsEdited(repairedRows.length);
    const splitText = readableRepair.splitRowCount ? `系统已继续拆分 ${readableRepair.splitRowCount} 条过长段落。` : "";
    setMessage(`已拆分当前段落。译文已清空，请重新翻译或手动校对。${splitText}`);
  };

  const mergeWithNextRow = (rowId) => {
    const index = rows.findIndex((item) => item.id === rowId);
    if (index < 0 || index >= rows.length - 1) {
      setMessage("当前段落后面没有可合并的内容。");
      return;
    }
    const row = rows[index];
    const next = rows[index + 1];
    const nextRows = [
      ...rows.slice(0, index),
      {
        ...row,
        end: Number(next.end) || Number(row.end) || 0,
        text: joinSegmentText(row.text, next.text),
        originalText: joinSegmentText(row.originalText || row.text, next.originalText || next.text),
        translation: joinSegmentText(row.translation, next.translation),
        reviewStatus: "pending",
      },
      ...rows.slice(index + 2),
    ];
    pushUndoSnapshot("合并段落");
    const repairResult = repairReviewStructureUnlessEmpty(nextRows, structureRepairOptions);
    setRows(repairResult.rows);
    markRowsEdited(repairResult.rows.length);
    const splitText = repairResult.splitRowCount ? `系统已重新拆分 ${repairResult.splitRowCount} 条过长段落。` : "";
    setMessage(`已合并当前段落和下一段。${splitText}`);
  };

  const shiftAllTimecodes = (offsetSeconds) => {
    const offset = Number(offsetSeconds);
    const magnitude = Math.abs(offset);
    if (!rows.length) return;
    if (!Number.isFinite(offset) || !magnitude) {
      setMessage("请输入大于 0 的时间偏移秒数。");
      return;
    }
    const minStart = rows.reduce((min, row) => Math.min(min, Number(row.start) || 0), Number.POSITIVE_INFINITY);
    const effectiveOffset = Math.max(offset, -Math.max(0, minStart));
    if (!effectiveOffset) {
      setMessage("第一段已经从 00:00.000 开始，无法继续提前。");
      return;
    }
    const nextRows = rows.map((row) => ({
      ...row,
      start: Math.max(0, Number(row.start || 0) + effectiveOffset),
      end: Math.max(0, Number(row.end || 0) + effectiveOffset),
      reviewStatus: row.reviewStatus === "confirmed" ? "pending" : row.reviewStatus,
    }));
    pushUndoSnapshot(effectiveOffset < 0 ? "整体提前时间码" : "整体延后时间码");
    const repairResult = repairReviewStructureUnlessEmpty(nextRows, structureRepairOptions);
    setRows(repairResult.rows);
    markRowsEdited(repairResult.rows.length);
    setMessage(`已将全部时间码${effectiveOffset < 0 ? "提前" : "延后"} ${Math.abs(effectiveOffset).toFixed(1)} 秒，可使用撤销恢复。`);
  };

  const removeRow = (id) => {
    if (pendingDeleteRowId !== id) {
      setPendingDeleteRowId(id);
      setMessage("再次点击删除确认移除此段，可使用撤销恢复。");
      return;
    }
    const targetIndex = rows.findIndex((row) => row.id === id);
    const nextRows = rows.filter((row) => row.id !== id);
    pushUndoSnapshot("删除段落");
    const repairResult = repairReviewStructureUnlessEmpty(nextRows, structureRepairOptions);
    setRows(repairResult.rows);
    markRowsEdited(repairResult.rows.length);
    setSelectedRowId(repairResult.rows[Math.min(Math.max(targetIndex, 0), repairResult.rows.length - 1)]?.id || "");
    setPendingDeleteRowId("");
    setMessage("已删除段落。可使用撤销恢复。");
  };

  const handleExport = (filename, content, label) => {
    try {
      downloadText(filename, content);
      updateActiveRecent?.({
        status: `已导出${exportModeLabel}`,
        meta: `${label} · ${rows.length} 条`,
        time: formatProjectTime(),
      });
      setMessage(`已导出 ${exportModeLabel} ${label}：${filename}`);
    } catch (error) {
      setMessage(`导出失败：${error.message || "浏览器阻止了下载"}`);
    }
  };

  const exportFilename = (format, mode = currentExportMode) => {
    const suffix = mode === "target" ? "-译文" : mode === "bilingual" ? "-双语" : "";
    return `${exportBaseName}${suffix}.${format}`;
  };

  const exportCurrentRows = (format) => {
    let rowsToExport = rows;
    const exportRepair = repairReviewStructureUnlessEmpty(rowsToExport, structureRepairOptions);
    if (reviewRowsChanged(rowsToExport, exportRepair.rows)) {
      const repairedRows = exportRepair.rows;
      if (hasTimingExportIssue(repairedRows)) {
        setMessage("导出失败：系统未能自动修复时间轴，请重新生成转写或导入有效字幕文件。");
        return;
      }
      pushUndoSnapshot("导出前自动修复字幕结构");
      rowsToExport = repairedRows;
      setRows(repairedRows);
      markRowsEdited(repairedRows.length);
    }
    try {
      validateExportRows(rowsToExport, currentExportMode);
    } catch (error) {
      if (emptyTextCount > 0) {
        jumpToFirstEmptyText({ showMessage: true });
        return;
      }
      if ((currentExportMode === "target" || currentExportMode === "bilingual") && !translationComplete) {
        setMessage(`还有 ${missingTranslationCount} 条没有译文，无法导出${currentExportMode === "target" ? "译文" : "双语"}文件。请先翻译或手动补齐译文。`);
        jumpToFirstMissingTranslation();
        return;
      }
      setMessage(`导出失败：${error.message || "导出内容不完整"}`);
      return;
    }
    handleExport(exportFilename(format, currentExportMode), exportRows(rowsToExport, format, currentExportMode, exportOptions), format.toUpperCase());
  };

  const handlePlainExport = (filename, content, label) => {
    try {
      downloadText(filename, content);
      updateActiveRecent?.({
        status: "已导出整理稿",
        meta: label,
        time: formatProjectTime(),
      });
      setMessage(`已导出 ${label}：${filename}`);
    } catch (error) {
      setMessage(`导出失败：${error.message || "浏览器阻止了下载"}`);
    }
  };

  const translateRows = async () => {
    if (!llmReady || !rows.length || sameLanguageSelected || modelAbortRef.current) return;
    const abortController = createModelAbortController();
    setTranslationRequested(true);
    setBusy("translate");
    setMessage("");
    try {
      const rowsToTranslate = rows.filter((row) => !String(row.translation || "").trim());
      const fillsMissingTranslations = rowsToTranslate.length > 0 && rowsToTranslate.length < rows.length;
      const targetRows = rowsToTranslate.length ? rowsToTranslate : rows;
      const chunks = chunkRowsForModel(targetRows);
      const translationsById = new Map();
      const translationSubject = isTranscriptionFlow ? "转写段落" : "字幕";
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        const chunk = chunks[chunkIndex];
        setMessage(`正在翻译${translationSubject}（${chunkIndex + 1}/${chunks.length}）。`);
        throwIfModelAborted(abortController.signal);
        const text = await callChat(provider, buildTranslationMessages({
          rows: chunk,
          targetLanguage,
          sourceLanguage,
          subject: translationSubject,
          transcriptionContext,
          terms,
        }), { max_completion_tokens: 2200, signal: abortController.signal });
        throwIfModelAborted(abortController.signal);
        const parsed = parseJsonArrayFromModelText(text);
        chunk.forEach((row, index) => {
          const foundById = parsed.find((item) => item && typeof item === "object" && String(item.id) === String(row.id));
          const translation = getTranslationValue(foundById || parsed[index]);
          if (translation) translationsById.set(row.id, translation);
        });
      }
      let translatedCount = 0;
      const nextRows = rows.map((row) => {
        const translation = translationsById.get(row.id);
        if (!translation) return row;
        translatedCount += 1;
        return { ...row, translation };
      });
      if (!translatedCount) {
        throw new Error("模型已响应，但没有返回可写入的译文。请重试或检查文本模型输出格式。");
      }
      throwIfModelAborted(abortController.signal);
      pushUndoSnapshot("翻译段落");
      setRows(normalizeReviewRows(nextRows));
      setExportMode(exportMode === "target" ? "target" : "bilingual");
      updateActiveRecent?.({
        status: "已翻译",
        meta: `${targetLanguage}译文 · ${translatedCount} 条`,
        time: formatProjectTime(),
      });
      setMessage(fillsMissingTranslations
        ? `已补齐 ${translatedCount} 条${translationSubject}译文。`
        : `已翻译 ${translatedCount} 条为${targetLanguage}。`);
    } catch (error) {
      if (isAbortError(error)) return;
      setMessage(`翻译失败：${error.message || "文本模型未返回可用译文"}。已保留当前校对内容，可重试或手动补齐译文。`);
    } finally {
      clearModelAbortController(abortController);
      if (!abortController.signal.aborted) setBusy("");
    }
  };

  const translateSingleRow = async (row) => {
    if (!llmReady || sameLanguageSelected || !String(row?.text || "").trim() || modelAbortRef.current) return;
    const abortController = createModelAbortController();
    setTranslationRequested(true);
    const busyKey = `translate-row-${row.id}`;
    setBusy(busyKey);
    setMessage("");
    try {
      const translationSubject = isTranscriptionFlow ? "转写段落" : "字幕";
      const text = await callChat(provider, buildTranslationMessages({
        rows: [row],
        targetLanguage,
        sourceLanguage,
        subject: translationSubject,
        transcriptionContext,
        terms,
      }), { max_completion_tokens: 700, signal: abortController.signal });
      throwIfModelAborted(abortController.signal);
      const parsed = parseJsonArrayFromModelText(text);
      const foundById = parsed.find((item) => item && typeof item === "object" && String(item.id) === String(row.id));
      const translation = getTranslationValue(foundById || parsed[0]);
      if (!translation) {
        throw new Error("模型已响应，但没有返回这条段落的译文。请重试或手动填写。");
      }
      const nextRows = normalizeReviewRows(rows.map((item) => (item.id === row.id ? { ...item, translation } : item)));
      pushUndoSnapshot("翻译当前段落");
      setRows(nextRows);
      if (nextRows.every((item) => String(item.translation || "").trim())) {
        setExportMode(exportMode === "target" ? "target" : "bilingual");
      }
      updateActiveRecent?.({
        status: "已翻译",
        meta: `${targetLanguage}译文 · 单条更新`,
        time: formatProjectTime(),
      });
      setMessage(`已更新 1 条${translationSubject}译文。`);
    } catch (error) {
      if (isAbortError(error)) return;
      setMessage(`翻译失败：${error.message || "文本模型未返回这条段落的可用译文"}。已保留当前校对内容，可重试或手动填写译文。`);
    } finally {
      clearModelAbortController(abortController);
      if (!abortController.signal.aborted) setBusy("");
    }
  };

  const generateDraft = async (mode) => {
    if (!llmReady || !transcriptText.trim() || modelAbortRef.current) return;
    const abortController = createModelAbortController();
    setBusy(mode);
    setMessage("");
    try {
      const chunks = chunkRowsForModel(rows, 5600);
      const termReference = formatTermReference(terms);
      let text = "";
      if (mode === "summary") {
        const notes = [];
        for (let index = 0; index < chunks.length; index += 1) {
          setMessage(`正在提炼分段要点（${index + 1}/${chunks.length}）。`);
          throwIfModelAborted(abortController.signal);
          const note = await callChat(provider, [
            { role: "system", content: "你是转写文本分析助手。只基于用户提供的内容提炼，不添加不存在的信息。" },
            { role: "user", content: `请从下面逐字稿片段提炼要点、可能章节和关键时间码。保留事实顺序，不做总结合并。转写提示和术语库只用于理解专有名词，不得补充为正文事实。用 Markdown 短条目。\n\n转写提示：${transcriptionContext.trim() || "无"}\n术语参考：${termReference}\n\n逐字稿片段：\n${rowsToTranscript(chunks[index])}` },
          ], { max_completion_tokens: 1600, signal: abortController.signal });
          throwIfModelAborted(abortController.signal);
          notes.push(note);
        }
        setMessage("正在生成摘要与标题。");
        text = await callChat(provider, [
          { role: "system", content: "你是转写文本整理助手。只能基于分段笔记生成摘要，不能补充不存在的信息。" },
          { role: "user", content: `请基于下面分段笔记生成：1. 一个准确标题；2. 5条要点摘要；3. 章节时间轴。术语库只用于保持专有名词一致，不得补充新事实。用 Markdown。不要使用代码块包裹输出。\n\n术语参考：${termReference}\n\n分段笔记：\n${notes.join("\n\n---\n\n")}` },
        ], { max_completion_tokens: 1800, signal: abortController.signal });
        throwIfModelAborted(abortController.signal);
      } else {
        const parts = [];
        for (let index = 0; index < chunks.length; index += 1) {
          setMessage(`正在整理转写文本（${index + 1}/${chunks.length}）。`);
          throwIfModelAborted(abortController.signal);
          const part = await callChat(provider, [
            { role: "system", content: "你是转写文本整理助手，只基于用户提供的文本整理内容，不添加不存在的信息。" },
            { role: "user", content: `请把下面逐字稿片段整理成清晰、分段的转写稿，保留原意、信息顺序、重要时间线，不扩写、不改写成文章。转写提示和术语库只用于理解专有名词，不得补充为正文事实。用 Markdown。不要使用代码块包裹输出。\n\n转写提示：${transcriptionContext.trim() || "无"}\n术语参考：${termReference}\n\n逐字稿片段：\n${rowsToTranscript(chunks[index])}` },
          ], { max_completion_tokens: 1800, signal: abortController.signal });
          throwIfModelAborted(abortController.signal);
          parts.push(stripWrappingCodeFence(part));
        }
        text = parts.join("\n\n---\n\n");
      }
      throwIfModelAborted(abortController.signal);
      const cleanDraft = stripWrappingCodeFence(text);
      setDraft(cleanDraft);
      updateActiveRecent?.({
        status: mode === "summary" ? "已摘要" : "已整理",
        meta: `${mode === "summary" ? "摘要与标题" : "转写整理"} · ${rows.length} 条`,
        time: formatProjectTime(),
      });
      setMessage(mode === "summary" ? "摘要与标题已生成。" : "转写整理稿已生成。");
    } catch (error) {
      if (isAbortError(error)) return;
      setMessage(error.message);
    } finally {
      clearModelAbortController(abortController);
      if (!abortController.signal.aborted) setBusy("");
    }
  };

  const lastUndoLabel = undoStackRef.current[undoDepth - 1]?.label || "";
  const showSetupHistory = !rows.length && (redoDepth > 0 || (undoDepth > 0 && lastUndoLabel !== "导入媒体"));
  const showTopHistory = rows.length > 0 || showSetupHistory;

  return (
    <div className={`workbench-view ${rows.length ? "result-mode" : "setup-mode"}`}>
      <header className="workspace-header">
        <div className="workspace-title">
          <button className="crumb" onClick={onBackHome}>首页</button>
          <span className="crumb-separator">/</span>
          <strong>{selectedFeature.title}</strong>
        </div>
        <div className="workspace-actions">
          <div className="setup-import-actions">
            <WorkbenchInlineStatus
              provider={provider}
              asrProvider={asrProvider}
              serverStatus={serverStatus}
              onOpenModels={onOpenModels}
              showAsr={!isSubtitleFileFlow && (!rows.length || Boolean(media?.url))}
              showText={isSubtitleFileFlow || rows.length > 0}
              compact={rows.length > 0}
            />
            <WorkspaceSaveStatus status={workspaceSaveStatus} />
          </div>
          {(rows.length > 0 || showSetupHistory) && (
            <div className="top-command-cluster">
              {showTopHistory && (
                <div className="top-history-control" aria-label="编辑历史">
                  <button className="secondary top-undo-button" type="button" onClick={undoLastChange} disabled={!undoDepth} aria-label="撤销" title={undoDepth ? "撤销上一步修改（Cmd/Ctrl+Z）" : "没有可撤销的修改"}>
                    <Undo2 size={17} />
                    撤销
                  </button>
                  <button className="secondary top-redo-button" type="button" onClick={redoLastChange} disabled={!redoDepth} aria-label="重做" title={redoDepth ? "重做刚撤销的修改（Cmd/Ctrl+Shift+Z）" : "没有可重做的修改"}>
                    <Redo2 size={17} />
                    重做
                  </button>
                </div>
              )}
              {rows.length > 0 && (
                <div className="top-export-control" aria-label="导出结果">
                  {translationFlowActive && (
                    <div className="export-mode-control top-export-mode-control" aria-label="导出内容">
                      <button className={exportModeButtonClass("source")} type="button" onClick={() => requestExportMode("source")}>原文</button>
                      <button className={exportModeButtonClass("target")} type="button" onClick={() => requestExportMode("target")} title={translationComplete ? "只导出译文" : `缺 ${missingTranslationCount} 条译文，点击定位`}>译文</button>
                      <button className={exportModeButtonClass("bilingual")} type="button" onClick={() => requestExportMode("bilingual")} title={translationComplete ? "原文和译文逐条导出" : `缺 ${missingTranslationCount} 条译文，点击定位`}>双语</button>
                    </div>
                  )}
                  {needsTranslationAttention && (
                    <button className="top-missing-translation" type="button" onClick={() => jumpToFirstMissingTranslation({ showMessage: true })} title="跳到第一条缺少译文的段落">
                      缺 {missingTranslationCount} 条译文
                    </button>
                  )}
                  <label className="top-export-format">
                    <span className="sr-only">导出格式</span>
                    <select aria-label="导出格式" value={activeTopExportFormat} onChange={(event) => setExportFormat(event.target.value)}>
                    {exportFormatOptions.map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}
                    </select>
                  </label>
                  {supportsTextExportOptions && (
                    <div className="top-export-settings">
                      <button
                        className={`icon-button export-settings-trigger ${exportSettingsOpen ? "active" : ""}`}
                        type="button"
                        onClick={() => setExportSettingsOpen((current) => !current)}
                        aria-label={exportSettingsOpen ? "收起导出设置" : "展开导出设置"}
                        aria-expanded={exportSettingsOpen}
                        title="TXT/MD 导出选项"
                      >
                        <SlidersHorizontal size={15} />
                        <span>选项</span>
                      </button>
                      {exportSettingsOpen && (
                        <div className="export-settings-popover" role="group" aria-label="TXT 和 Markdown 导出设置">
                          <label>
                            <input
                              type="checkbox"
                              checked={exportOptions.includeTimecodes}
                              onChange={(event) => setExportOption("includeTimecodes", event.target.checked)}
                            />
                            时间码
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={exportOptions.includeSpeakers}
                              onChange={(event) => setExportOption("includeSpeakers", event.target.checked)}
                            />
                            说话人
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                  <button className="primary" aria-label={primaryExportLabel} title={primaryExportTitle} onClick={() => exportCurrentRows(activeTopExportFormat)} disabled={!rows.length}>
                    {exportBlockerCount ? <AlertCircle size={18} /> : <Upload size={18} />}
                    {primaryExportLabel}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {!isSubtitleFileFlow && (
        <input
          ref={mediaInputRef}
          type="file"
          accept={mediaAccept}
          hidden
          onChange={(event) => {
            handleMedia(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      )}
      {!isSubtitleFileFlow && isVideoFlow && (
        <input
          ref={audioTrackInputRef}
          type="file"
          accept="audio/*"
          hidden
          onChange={(event) => {
            handleAudioTrack(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      )}
      <input
        ref={subtitleInputRef}
        type="file"
        accept=".srt,.vtt,.txt"
        hidden
        onChange={(event) => {
          handleSubtitle(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {!workspaceReady && (
        <section className="workspace-warning compact">
          <div>
            <strong>请先配置本地工作区</strong>
            <span>媒体文件、字幕校对表和整理稿需要保存到本地工作区。配置后再导入素材，历史项目才可恢复。</span>
          </div>
          <button className="primary" onClick={onOpenSettings}>配置工作区</button>
        </section>
      )}

      <div className={`workbench-layout ${rows.length ? "has-results" : "empty-results"} ${rows.length && !showMediaPanel ? "no-media-results" : ""}`}>
        <aside className="panel action-panel">
          <div className="panel-head">
            <h2><Wand2 size={20} />处理设置</h2>
            {rows.length > 0 && (
              <button
                className={`workbench-quick-state ${needsExportRepair ? "actionable" : ""}`}
                type="button"
                onClick={jumpToFirstWorkbenchIssue}
                disabled={!needsExportRepair}
                aria-label={
                  needsExportRepair
                    ? `${rows.length} 条${segmentKind}段落，${exportBlockerCount} 条缺少原文，点击定位`
                    : `${rows.length} 条${segmentKind}段落，${quickStateLabel}`
                }
                title={needsExportRepair ? "跳转到第一条缺少原文的段落" : quickStateLabel}
              >
                <span>{rows.length} 条{segmentKind}段落</span>
                <strong>{quickStateLabel}</strong>
              </button>
            )}
          </div>
          {pendingImport && (
            <div className="replace-import-confirm" role="status" aria-live="polite">
              <div>
                <strong>替换当前校对表？</strong>
                <span>
                  当前 {rows.length} 条，将替换为 {pendingImport.rows.length} 条{segmentKind}段落。
                </span>
              </div>
              <div className="replace-import-actions">
                <button className="secondary compact-button" type="button" onClick={cancelPendingImport}>
                  取消
                </button>
                <button className="primary compact-button" type="button" onClick={confirmPendingImport}>
                  确认替换
                </button>
              </div>
            </div>
          )}
          <div className="action-scroll-area">
            {rows.length > 0 && !hasMediaPlayback && !isSubtitleFileFlow && (
              <details className="media-association-card" aria-label="素材关联">
                <summary>
                  <span>素材关联</span>
                  <small>替换转写 / 关联{isAudioFlow ? "音频" : "视频"}</small>
                </summary>
                <div>
                  <button className="secondary attach-media-inline" type="button" onClick={() => subtitleInputRef.current?.click()} disabled={!workspaceReady}>
                    <Download size={15} />
                    {transcriptReplaceLabel}
                  </button>
                  <button className="secondary attach-media-inline" type="button" onClick={() => (workspaceReady ? mediaInputRef.current?.click() : onOpenSettings())}>
                    <Download size={15} />
                    关联{isAudioFlow ? "音频" : "视频"}
                  </button>
                </div>
              </details>
            )}
            {!isSubtitleFileFlow && !rows.length && (
              <div className={`service-disclosure ${asrBlocked ? "warn blocker" : ""}`}>
                {asrBlocked ? (
                  <>
                    <div>
                      <strong>{asrBlockerTitle}</strong>
                      <span>{asrBlockerDetail}</span>
                    </div>
                    <button className="text-button inline-link" type="button" onClick={() => onOpenModels("asr")}>
                      配置转写服务
                    </button>
                  </>
                ) : cloudTranscriptionNotice}
              </div>
            )}
            <div className="action-section-title">{rows.length ? "校对语言" : "语言"}</div>
            <div className="translation-controls">
              <label>
                源语言
                <select aria-label="源语言" value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)}>
                  <option>自动识别</option>
                  <option>中文</option>
                  <option>英文</option>
                  <option>日文</option>
                  <option>韩文</option>
                  <option>西班牙文</option>
                </select>
              </label>
              <label>
                目标语言
                <select aria-label="目标语言" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}>
                  <option>中文</option>
                  <option>英文</option>
                  <option>日文</option>
                  <option>韩文</option>
                  <option>西班牙文</option>
                </select>
              </label>
            </div>
            {!rows.length && showAsrQualityNote && !asrBlocked && (
              <div className="quality-note">
                {asrSetupNote}
              </div>
            )}
            {!asrBlocked && !showAsrQualityNote && languageCompatibilityWarning && (
              <div className="quality-note">
                {languageCompatibilityWarning}
              </div>
            )}
            {!isSubtitleFileFlow && (rows.length ? (
              <details className="transcription-context transcription-context-details">
                <summary>转写提示</summary>
                <textarea
                  value={transcriptionContext}
                  onChange={(event) => setTranscriptionContext(event.target.value)}
                  placeholder="可填写视频主题、人物名、产品名、会议议程、容易听错的专有名词"
                  aria-label="转写提示"
                />
              </details>
            ) : (
              <label className="transcription-context">
                <span>转写提示</span>
                <textarea
                  value={transcriptionContext}
                  onChange={(event) => setTranscriptionContext(event.target.value)}
                  placeholder="可填写视频主题、人物名、产品名、会议议程、容易听错的专有名词"
                />
                <small>用于转写后的自动校正和翻译，不会作为新内容写入结果。</small>
              </label>
            ))}
            {!isSubtitleFileFlow && transcriptionStatus.state !== "idle" && (!rows.length || transcriptionStatus.state !== "success") && (
              <div className={`transcription-status-card ${transcriptionStatus.state}`} role={transcriptionStatus.state === "error" ? "alert" : "status"} aria-live="polite">
                <div>
                  <strong>
                    {transcriptionStatus.state === "running"
                      ? "转写进行中"
                      : transcriptionStatus.state === "error"
                        ? "转写未完成"
                        : transcriptionStatus.state === "cancelled"
                          ? "转写已取消"
                          : "转写完成"}
                  </strong>
                  {transcriptionStatus.stage && (
                    <em className="status-stage">阶段：{transcriptionStatus.stage}</em>
                  )}
                  <span>{transcriptionStatus.message}</span>
                </div>
                {transcriptionStatus.state === "error" && (
                  <div className="transcription-status-actions">
                    <button className="secondary compact-button" type="button" onClick={startTranscription} disabled={!canStartTranscription || busy === "asr"}>
                      <RefreshCw size={15} />
                      重试
                    </button>
                    <button className="secondary compact-button" type="button" onClick={() => onOpenModels("asr")}>
                      <SlidersHorizontal size={15} />
                      转写服务
                    </button>
                  </div>
                )}
              </div>
            )}
            {!isSubtitleFileFlow && !rows.length && (
              <div className="setup-action-footer">
                <button className="primary start-transcription-button" onClick={startTranscription} disabled={!canStartTranscription || busy === "asr"}>
                  {busy === "asr" ? <Loader2 className="spin" size={18} /> : <AudioWaveform size={18} />}
                  {busy === "asr" ? "转写中" : "开始转写"}
                </button>
                {busy === "asr" && (
                  <button className="secondary compact-tool-button cancel-transcription-button" type="button" onClick={cancelTranscription}>
                    <X size={16} />
                    取消转写
                  </button>
                )}
              </div>
            )}
            {rows.length > 0 && speakerLabels.length > 0 && (
              <details className="speaker-map-details">
                <summary>说话人 <span>{speakerLabels.length}</span></summary>
                <div className="speaker-map-list">
                  {speakerLabels.map((speaker) => (
                    <label key={speaker} className="speaker-map-row">
                      <span>{speaker}</span>
                      <input
                        defaultValue={speaker}
                        aria-label={`将说话人 ${speaker} 重命名为`}
                        onBlur={(event) => renameSpeakerLabel(speaker, event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                          if (event.key === "Escape") {
                            event.currentTarget.value = speaker;
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                  ))}
                </div>
              </details>
            )}
            {rows.length > 0 && (
              <>
                <details className="compact-action-details time-sync-details">
                  <summary>时间同步</summary>
                  <div className="time-shift-controls" aria-label="整体时间码平移">
                    <label className="time-shift-input">
                      <span>偏移秒数</span>
                      <input
                        type="number"
                        min="0.1"
                        max="60"
                        step="0.1"
                        value={timeShiftSeconds}
                        onChange={(event) => setTimeShiftSeconds(event.target.value)}
                        aria-label="时间偏移秒数"
                      />
                    </label>
                    <button className="secondary compact-button" type="button" onClick={() => shiftAllTimecodes(-Number(timeShiftSeconds))} disabled={!rows.length}>
                      <Clock3 size={15} />
                      整体提前
                    </button>
                    <button className="secondary compact-button" type="button" onClick={() => shiftAllTimecodes(Number(timeShiftSeconds))} disabled={!rows.length}>
                      <Clock3 size={15} />
                      整体延后
                    </button>
                  </div>
                </details>
                <details className="compact-action-details processing-details" open={modelTaskBusy || Boolean(draft)}>
                  <summary>校正与翻译</summary>
                  {llmReady ? (
                    <>
                    <div className="processing-tool-grid">
                      {!isSubtitleFileFlow && (
                        <button className="action-button" onClick={correctCurrentRows} disabled={modelTaskBusy} title={correctionHint}>
                          {busy === "correct" ? <Loader2 className="spin" size={18} /> : <Wand2 size={18} />}
                          {isTranscriptionFlow ? "校正转写" : "校正字幕"}
                        </button>
                      )}
                      {isTranscriptionFlow && (
                        <>
                        <button className="action-button" onClick={() => generateDraft("draft")} disabled={modelTaskBusy} title="整理口语化转写文本，不扩写">
                          {busy === "draft" ? <Loader2 className="spin" size={18} /> : <PenLine size={18} />}
                          转写整理
                        </button>
                        <button className="action-button" onClick={() => generateDraft("summary")} disabled={modelTaskBusy} title="提炼章节、要点和标题">
                          {busy === "summary" ? <Loader2 className="spin" size={18} /> : <MessageSquareText size={18} />}
                          摘要与标题
                        </button>
                        </>
                      )}
                      <button className="action-button secondary-action" onClick={translateRows} disabled={sameLanguageSelected || modelTaskBusy} title={translationHint}>
                        {busy === "translate" ? <Loader2 className="spin" size={18} /> : <Languages size={18} />}
                        翻译为目标语言
                      </button>
                    </div>
                    {modelTaskBusy && (
                      <button className="secondary compact-button cancel-model-task-button" type="button" onClick={cancelModelTask}>
                        <X size={16} />
                        取消处理
                      </button>
                    )}
                    </>
                  ) : (
                    <div className="model-required-note" role="status">
                      <span>校正、整理、翻译需要文本模型。</span>
                      <button type="button" className="text-button" onClick={() => onOpenModels("text")}>配置文本模型</button>
                    </div>
                  )}
                </details>
                {isTranscriptionFlow && draft && (
                  <div className="draft-inline-panel">
                    <div>
                      <strong>转写整理输出</strong>
                      <button className="secondary" onClick={() => handlePlainExport(`${exportBaseName}-整理稿.md`, draft, "Markdown")} disabled={!draft}>导出 Markdown</button>
                    </div>
                    <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="整理稿或摘要会显示在这里，也可以继续手动编辑。" />
                  </div>
                )}
              </>
            )}
          </div>
        </aside>

        <div className="workbench-main">
          <div className="workbench-work-area">
            {showMediaPanel && (
            <section className="panel media-panel">
              <div className="panel-head">
                <h2><FileAudio size={20} />{mediaPanelTitle}</h2>
                <div className="media-panel-tools">
                  {!rows.length && !isSubtitleFileFlow && (
                    <button className="secondary compact-tool-button" onClick={() => mediaInputRef.current?.click()} disabled={!workspaceReady}>
                      <Upload size={16} />
                      {media ? `更换${isAudioFlow ? "音频" : "视频"}` : `上传${isAudioFlow ? "音频" : "视频"}`}
                    </button>
                  )}
                  {!rows.length && (
                    <button className="secondary compact-tool-button" onClick={() => subtitleInputRef.current?.click()} disabled={!workspaceReady}>
                      <Download size={16} />
                      {transcriptImportLabel}
                    </button>
                  )}
                  {!rows.length && !isSubtitleFileFlow && (
                    <button className="secondary compact-tool-button" type="button" onClick={() => setManualImportOpen((current) => !current)} disabled={!workspaceReady}>
                      <ClipboardPaste size={16} />
                      {`粘贴${segmentKind}`}
                    </button>
                  )}
                  {rows.length > 0 && !isSubtitleFileFlow && media && (
                    <button className="secondary compact-tool-button" onClick={() => mediaInputRef.current?.click()} disabled={!workspaceReady}>
                      <Upload size={16} />
                      更换{isAudioFlow ? "音频" : "视频"}
                    </button>
                  )}
                  {rows.length > 0 && (
                    <button className="secondary compact-tool-button" onClick={() => subtitleInputRef.current?.click()} disabled={!workspaceReady}>
                      <Download size={16} />
                      {transcriptReplaceLabel}
                    </button>
                  )}
                </div>
              </div>
              {!isSubtitleFileFlow && !rows.length && !asrBlocked && (
                <div className="start-hint">
                  {startTranscriptionHint}
                </div>
              )}
              {isSubtitleFileFlow ? (
                rows.length ? (
                  <div className="subtitle-source-summary">
                    <RecentFileChip item={{ name: activeProjectName || "字幕文件", type: "document", tool: "subtitle-translate" }} />
                    <div>
                      <strong>{activeProjectName || "已导入字幕文件"}</strong>
                      <span>{rows.length} 条字幕段落 · 可继续校对、翻译和导出</span>
                    </div>
                  </div>
                ) : (
                <button className="dropzone compact-dropzone" aria-label="选择字幕文件导入" onClick={() => (workspaceReady ? subtitleInputRef.current?.click() : onOpenSettings())}>
                  <Download size={32} />
                  <strong>{workspaceReady ? "导入字幕文件" : "配置工作区后导入字幕"}</strong>
                  <span>{workspaceReady ? "支持 SRT/VTT/TXT；导入后可翻译并导出双语字幕。" : "先保存本地工作区，字幕项目才会有可恢复副本。"}</span>
                </button>
                )
              ) : media ? (
                <div className="media-preview">
                  {media.type.startsWith("video") ? (
                    <div className="video-preview-frame">
                      <video
                        ref={mediaElementRef}
                        src={media.url}
                        controls
                        onLoadedMetadata={(event) => updateMediaDuration(media.url, event.currentTarget?.duration)}
                        onError={handleMediaPreviewError}
                        onTimeUpdate={handleMediaTimeUpdate}
                        onSeeked={(event) => setPlaybackTime(Number(event.currentTarget?.currentTime) || 0)}
                        onEnded={handleMediaEnded}
                      />
                      {mediaPreviewError && (
                        <div className="media-preview-error" role="status">
                          <AlertCircle size={18} />
                          <span>{mediaPreviewError}</span>
                        </div>
                      )}
                      {activeVideoSubtitleLines.length > 0 && (
                        <div className={`video-subtitle-preview ${currentExportMode === "bilingual" ? "bilingual" : ""}`} aria-label="视频字幕预览">
                          {activeVideoSubtitleLines.map((line, index) => (
                            <span key={`${activeVideoSubtitleRow.id || "row"}-${index}`}>{line}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <audio
                      ref={mediaElementRef}
                      src={media.url}
                      controls
                      onLoadedMetadata={(event) => updateMediaDuration(media.url, event.currentTarget?.duration)}
                      onError={handleMediaPreviewError}
                      onTimeUpdate={handleMediaTimeUpdate}
                      onSeeked={(event) => setPlaybackTime(Number(event.currentTarget?.currentTime) || 0)}
                      onEnded={handleMediaEnded}
                    />
                  )}
                  {!media.type.startsWith("video") && mediaPreviewError && (
                    <div className="media-preview-error inline" role="status">
                      <AlertCircle size={18} />
                      <span>{mediaPreviewError}</span>
                    </div>
                  )}
                  <div>
                    <strong>{media.name}</strong>
                    <span>{media.type || "媒体文件"} · {(media.size / 1024 / 1024).toFixed(1)} MB</span>
                  </div>
                  {shouldShowAudioFallback && (
                    <details className={`audio-track-box ${media.asrAudio?.file ? "ready" : ""}`}>
                      <summary>
                        <AudioWaveform size={18} />
                        <strong>{media.asrAudio?.file ? "已关联备用音频" : "可选备用音频"}</strong>
                        <span>
                          {media.asrAudio?.file
                            ? `${media.asrAudio.name} · ${(media.asrAudio.size / 1024 / 1024).toFixed(1)} MB`
                            : usesDashScopeFunAsr || asrProvider.videoInputMode === "original"
                              ? "默认使用原始视频；仅在音频异常时关联备用音频。"
                              : "默认使用视频音轨；仅在音轨异常时关联备用音频。"}
                        </span>
                      </summary>
                      <div className="audio-track-fallback">
                        <button className="secondary compact-button" type="button" onClick={() => audioTrackInputRef.current?.click()}>
                          {media.asrAudio?.file ? "更换备用音频" : "选择备用音频"}
                        </button>
                        {media.asrAudio?.file && (
                          <audio
                            src={media.asrAudio.url}
                            controls
                            onLoadedMetadata={(event) => updateAudioTrackDuration(media.asrAudio.url, event.currentTarget?.duration)}
                          />
                        )}
                      </div>
                    </details>
                  )}
                </div>
              ) : rows.length ? (
                <div className="media-attach-summary">
                  <div>
                    <FileAudio size={18} />
                    <span>未关联媒体</span>
                    <small>可继续校对转写文本；关联媒体后可按时间码定位预览。</small>
                  </div>
                  <button className="secondary compact-button" type="button" onClick={() => (workspaceReady ? mediaInputRef.current?.click() : onOpenSettings())}>
                    <Download size={16} />
                    关联{isAudioFlow ? "音频" : "视频"}
                  </button>
                </div>
              ) : (
                <button className="dropzone compact-dropzone" aria-label={`选择${isAudioFlow ? "音频" : "视频"}文件上传`} onClick={() => (workspaceReady ? mediaInputRef.current?.click() : onOpenSettings())}>
                  <Upload size={32} />
                  <strong>{workspaceReady ? (isAudioFlow ? "上传音频文件" : "上传视频文件") : "配置工作区后上传媒体"}</strong>
                  <span>{workspaceReady ? "上传后可在工作台内预览，并与字幕或转写文本对照校对。" : "先保存本地工作区，媒体和处理结果才会持久保存。"}</span>
                </button>
              )}
              {!rows.length && !media && (
                <div className="notice">
                  {noticeText}
                </div>
              )}
            </section>
            )}

            {manualImportOpen && !rows.length && (
              <div className="manual-import-overlay" role="presentation">
                <section className="manual-import-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-import-title">
                  <div className="manual-import-head">
                    <h3 id="manual-import-title">{manualImportLabel}</h3>
                    <button className="icon-button" type="button" onClick={() => setManualImportOpen(false)} aria-label="关闭导入文本">
                      <X size={17} />
                    </button>
                  </div>
                  <p>粘贴已有文本后解析为校对段落，不会覆盖媒体文件。</p>
                  <textarea
                    id="manual-import"
                    ref={manualImportTextareaRef}
                    value={manualImport}
                    onChange={(event) => setManualImport(event.target.value)}
                    placeholder={manualImportPlaceholder}
                  />
                  <div className="manual-import-actions">
                    <button className="secondary" type="button" onClick={() => setManualImportOpen(false)}>
                      取消
                    </button>
                    <button className="primary" type="button" onClick={importManualText} disabled={!workspaceReady || !manualImport.trim()}>
                      <Download size={18} />导入文本
                    </button>
                  </div>
                </section>
              </div>
            )}

            {message && shouldShowInlineWorkbenchMessage(message) && <div className={`message ${isErrorMessage(message) ? "error" : ""}`}>{message}</div>}
            {message && !shouldShowInlineWorkbenchMessage(message) && <div className="workbench-toast" role="status" aria-live="polite">{message}</div>}

            {rows.length > 0 && (
            <section className="panel subtitle-editor">
              <div className="panel-head">
                <div className="review-title-group">
                  <h2><ListChecks size={20} />{editorTitle}</h2>
                </div>
                <div className="editor-tools">
                  <label className="subtitle-search">
                    <Search size={16} />
                    <input
                      ref={subtitleSearchInputRef}
                      value={subtitleSearch}
                      onChange={(event) => setSubtitleSearch(event.target.value)}
                      onKeyDown={handleSubtitleSearchKeyDown}
                      placeholder="查找"
                      aria-label="查找校对内容"
                    />
                    {normalizedSubtitleSearch && (
                      <span>{searchMatches.length ? `${activeSearchIndex + 1}/${searchMatches.length}` : "0/0"}</span>
                    )}
                    {subtitleSearch && (
                      <button className="search-clear" type="button" onClick={() => setSubtitleSearch("")} aria-label="清空查找">
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <button className="icon-button" type="button" onClick={() => moveSearchMatch(-1)} disabled={!searchMatches.length} aria-label="上一条匹配">
                    <ChevronUp size={16} />
                  </button>
                  <button className="icon-button" type="button" onClick={() => moveSearchMatch(1)} disabled={!searchMatches.length} aria-label="下一条匹配">
                    <ChevronDown size={16} />
                  </button>
                  <button
                    className={`icon-button replace-toggle ${replaceOpen ? "active" : ""}`}
                    type="button"
                    onClick={() => setReplaceOpen((current) => !current)}
                    aria-label={replaceOpen ? "收起替换" : "打开替换"}
                    title="查找替换"
                  >
                    <Repeat2 size={16} />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    onClick={copyCurrentSegment}
                    disabled={!activeReviewRow}
                    aria-label="复制当前段"
                    title="复制当前段"
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    className="secondary copy-all-button"
                    type="button"
                    onClick={copyAllCleanText}
                    disabled={!rows.length}
                    title="复制不带时间码的全文"
                    aria-label="复制全文"
                  >
                    <Copy size={15} /><span>复制全文</span>
                  </button>
                  {qualityIssueRows.length > 0 && (
                    <button className="quality-jump-button" type="button" onClick={jumpToNextQualityIssue} aria-label="跳到下一处质量提示" title="跳到下一处质量提示">
                      下一处提示
                    </button>
                  )}
                  {longSubtitleIssueRows.length > 0 && (
                    <button className="secondary" type="button" onClick={repairLongSubtitleRows} aria-label={`拆分 ${longSubtitleIssueRows.length} 条过长段落`} title="按标点和可读长度自动拆分过长段落">
                      拆分长段
                    </button>
                  )}
                  {showReviewPagination && (
                    <div className="review-pagination" aria-label="校对列表分页">
                      <span>{reviewPageStart + 1}-{reviewPageEnd} / {rows.length}</span>
                      <select aria-label="跳转校对分页" value={activeReviewPageIndex} onChange={(event) => jumpReviewPage(event.target.value)}>
                        {Array.from({ length: reviewPageCount }, (_, index) => (
                          <option key={index} value={index}>第 {index + 1} 组</option>
                        ))}
                      </select>
                      <button className="secondary review-page-step" type="button" onClick={() => moveReviewPage(-1)} disabled={activeReviewPageIndex <= 0} aria-label="上一组">
                        <ChevronLeft size={15} /><span>上一组</span>
                      </button>
                      <button className="secondary review-page-step" type="button" onClick={() => moveReviewPage(1)} disabled={activeReviewPageIndex >= reviewPageCount - 1} aria-label="下一组">
                        <span>下一组</span><ChevronRight size={15} />
                      </button>
                    </div>
                  )}
                  <button className="secondary" onClick={addRow} disabled={!workspaceReady}>
                    添加段落
                  </button>
                </div>
              </div>
              {replaceOpen && (
                <div className="replace-toolbar" aria-label="查找替换">
                  <span>{replaceCandidateCount ? `${replaceCandidateCount} 条可替换` : "无可替换匹配"}</span>
                  <label>
                    替换为
                    <input
                      value={subtitleReplace}
                      onChange={(event) => setSubtitleReplace(event.target.value)}
                      placeholder="输入替换文本"
                    />
                  </label>
                  <button className="secondary" type="button" onClick={() => replaceReviewText("current")} disabled={!normalizedSubtitleSearch || !replaceCandidateCount}>
                    替换当前
                  </button>
                  <button className="primary" type="button" onClick={() => replaceReviewText("all")} disabled={!normalizedSubtitleSearch || !replaceCandidateCount}>
                    全部替换
                  </button>
                </div>
              )}

              {activeReviewRow && (
                <div className={`current-segment-card ${showTranslationColumn ? "has-translation" : ""}`}>
                  <div className="current-segment-main">
                    <div className="current-segment-meta">
                      <span className="current-segment-label">当前段落</span>
                      {canReassignActiveSpeaker ? (
                        <label className="current-speaker-select">
                          <span className="sr-only">当前段落说话人归属</span>
                          <select
                            aria-label="当前段落说话人归属"
                            value={activeReviewRow.speaker || "未标注"}
                            onChange={(event) => assignRowSpeaker(activeReviewRow.id, event.target.value)}
                          >
                            {speakerSelectOptions.map((speaker) => (
                              <option key={speaker} value={speaker}>{speaker}</option>
                            ))}
                          </select>
                        </label>
                      ) : activeSpeakerLabel ? (
                        <span className="current-speaker-chip">{activeSpeakerLabel}</span>
                      ) : null}
                      <label className="current-meta-field timecode-meta-field">
                        <span title="开始时间">起</span>
                        <input
                          key={`${activeReviewRow.id}-start-${activeReviewRow.start}`}
                          defaultValue={formatClock(activeReviewRow.start)}
                          onBlur={(event) => {
                            if (!commitRowTimecode(activeReviewRow.id, "start", event.currentTarget.value)) {
                              event.currentTarget.value = formatClock(activeReviewRow.start);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              event.currentTarget.value = formatClock(activeReviewRow.start);
                              event.currentTarget.blur();
                            }
                          }}
                          aria-label="当前段落开始时间"
                        />
                      </label>
                      <label className="current-meta-field timecode-meta-field">
                        <span title="结束时间">止</span>
                        <input
                          key={`${activeReviewRow.id}-end-${activeReviewRow.end}`}
                          defaultValue={formatClock(activeReviewRow.end)}
                          onBlur={(event) => {
                            if (!commitRowTimecode(activeReviewRow.id, "end", event.currentTarget.value)) {
                              event.currentTarget.value = formatClock(activeReviewRow.end);
                            }
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              event.currentTarget.value = formatClock(activeReviewRow.end);
                              event.currentTarget.blur();
                            }
                          }}
                          aria-label="当前段落结束时间"
                        />
                      </label>
                      {activeReviewRow.reviewStatus === "confirmed" && <span className="review-status-badge confirmed">已确认</span>}
                      {activeQualityHints.length > 0 && (
                        <div className="quality-hint-group" aria-label="当前段落质量提示">
                          {activeQualityHints.map((hint) => <span key={hint}>{hint}</span>)}
                        </div>
                      )}
                      <span className="segment-counter">{activeReviewIndex + 1}/{rows.length}</span>
                    </div>
                    {showActiveOriginalText && (
                      <label className="current-source-readonly">
                        <span className="sr-only">原始转写</span>
                        <div>{activeOriginalText}</div>
                      </label>
                    )}
                    <label className="current-edit-field current-source-edit-field">
                      <span>{isTranscriptionFlow ? "转写原文" : "字幕原文"}</span>
                      <textarea
                        className="subtitle-source-textarea"
                        value={activeReviewRow.text}
                        onFocus={(event) => {
                          rememberTextSelection(activeReviewRow.id, event);
                          beginTextEditSnapshot(activeReviewRow.id, "text");
                        }}
                        onSelect={(event) => rememberTextSelection(activeReviewRow.id, event)}
                        onClick={(event) => rememberTextSelection(activeReviewRow.id, event)}
                        onKeyDown={(event) => handleCurrentEditorKeyDown(event, activeReviewRow.id, "text")}
                        onKeyUp={(event) => rememberTextSelection(activeReviewRow.id, event)}
                        onChange={(event) => updateRowTextField(activeReviewRow.id, "text", event.target.value)}
                        onBlur={() => finishTextEditSnapshot(activeReviewRow.id, "text", { repairStructure: true })}
                        placeholder="校对当前段落"
                        aria-label="当前段落校对稿"
                      />
                    </label>
                    {showTranslationColumn && (
                      <label className="current-edit-field current-translation-edit-field">
                        <span>译文</span>
                        <textarea
                          className="subtitle-translation-textarea"
                          value={activeReviewRow.translation}
                          onFocus={() => beginTextEditSnapshot(activeReviewRow.id, "translation")}
                          onKeyDown={(event) => handleCurrentEditorKeyDown(event, activeReviewRow.id, "translation")}
                          onChange={(event) => updateRowTextField(activeReviewRow.id, "translation", event.target.value)}
                          onBlur={() => finishTextEditSnapshot(activeReviewRow.id, "translation")}
                          placeholder="译文内容"
                          aria-label="当前段落译文"
                        />
                      </label>
                    )}
                    <div className="current-segment-controls">
                      <div className="current-nav-tools" aria-label="段落切换">
                        <button className="secondary segment-nav-button" type="button" onClick={() => moveReviewRow(-1)} disabled={activeReviewIndex <= 0} data-tooltip="上一段" title="切换到上一段（Cmd/Ctrl+↑）" aria-label="上一段">
                          <ChevronLeft size={16} /><span className="sr-only">上一段</span>
                        </button>
                        <button className="secondary segment-nav-button" type="button" onClick={() => moveReviewRow(1)} disabled={activeReviewIndex < 0 || activeReviewIndex >= rows.length - 1} data-tooltip="下一段" title="切换到下一段（Cmd/Ctrl+↓）" aria-label="下一段">
                          <ChevronRight size={16} /><span className="sr-only">下一段</span>
                        </button>
                      </div>
                      {hasMediaPlayback && (
                        <div className="current-media-tools" aria-label="当前段落媒体控制">
                          <button className="segment-locate-button" type="button" onClick={() => seekToRow(activeReviewRow)} data-tooltip="定位" aria-label={`定位到 ${formatClock(activeReviewRow.start)}`} title="定位到媒体时间">
                            <LocateFixed size={14} />
                            <span className="sr-only">定位</span>
                          </button>
                          <button className="segment-play-button" type="button" onClick={() => playReviewRow(activeReviewRow)} data-tooltip="播放" aria-label="播放当前段" title="播放当前段">
                            <Play size={14} />
                            <span className="sr-only">播放</span>
                          </button>
                          <button className={`segment-loop-button ${isLoopingActiveSegment ? "active" : ""}`} type="button" onClick={() => playReviewRow(activeReviewRow, true)} data-tooltip={isLoopingActiveSegment ? "停止循环" : "循环"} aria-label="循环播放当前段" aria-pressed={isLoopingActiveSegment} title={isLoopingActiveSegment ? "停止循环当前段" : "循环播放当前段"}>
                            <Repeat2 size={14} />
                            <span className="sr-only">循环</span>
                          </button>
                        </div>
                      )}
                      <button className="primary confirm-next" type="button" onClick={() => updateReviewStatus(activeReviewRow.id, "confirmed", true)} disabled={!canConfirmActiveRow} title={canConfirmActiveRow ? "确认当前段并跳到下一段（Cmd/Ctrl+Enter）" : "当前段落没有可确认的校对文本"} aria-label="确认当前段并跳到下一段">
                        <Check size={17} />确认
                      </button>
                      <div className="current-row-tools" aria-label="当前段落工具">
                        <button className="row-action split-row" type="button" onClick={() => splitRow(activeReviewRow)} disabled={!canSplitReviewRow(activeReviewRow)} data-tooltip="拆分" title={canSplitReviewRow(activeReviewRow) ? "在此处把段落拆成两段" : "当前段落太短，不能继续拆分"} aria-label="拆分段落">
                          <Scissors size={16} /><span>拆分</span>
                        </button>
                        <button className="row-action merge-row" type="button" onClick={() => mergeWithNextRow(activeReviewRow.id)} disabled={activeReviewIndex >= rows.length - 1} data-tooltip="合并" title="把当前段落和下一段合并" aria-label="合并到下一段">
                          <Combine size={16} /><span>合并</span>
                        </button>
                        {showTranslationColumn && llmReady && !sameLanguageSelected && (
                          <button
                            className="row-action translate-row"
                            type="button"
                            onClick={() => translateSingleRow(activeReviewRow)}
                            disabled={!String(activeReviewRow.text || "").trim() || modelTaskBusy}
                            data-tooltip={activeReviewRow.translation ? "重译" : "翻译"}
                            title={activeReviewRow.translation ? "重新翻译此段" : "翻译此段"}
                            aria-label={activeReviewRow.translation ? "重新翻译此段" : "翻译此段"}
                          >
                            {busy === `translate-row-${activeReviewRow.id}` ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                            <span>{activeReviewRow.translation ? "重译" : "翻译"}</span>
                          </button>
                        )}
                        <button className={`row-delete ${pendingDeleteRowId === activeReviewRow.id ? "confirm-delete" : ""}`} type="button" onClick={() => removeRow(activeReviewRow.id)} data-tooltip={pendingDeleteRowId === activeReviewRow.id ? "确认删除" : "删除"} aria-label={pendingDeleteRowId === activeReviewRow.id ? "确认删除段落" : "删除段落"} title={pendingDeleteRowId === activeReviewRow.id ? "再次点击确认删除，可通过撤销恢复" : "删除此段，可通过撤销恢复"}>
                          <Trash2 size={16} /><span>{pendingDeleteRowId === activeReviewRow.id ? "确认" : "删除"}</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={subtitleTableRef} className={`subtitle-table review-segment-list ${showTranslationColumn ? "with-translation" : "source-only"} ${hasMediaPlayback ? "with-media" : "no-media"}`}>
                <div className="table-row table-head">
                  {hasMediaPlayback && <span>定位</span>}<span>时间码</span><span>内容</span>
                </div>
                {visibleReviewRows.map((row) => {
                  const rowQualityHints = qualityHintMap.get(row.id) || [];
                  const rowSpeakerLabel = displaySpeakerLabel(row.speaker);
                  return (
                    <div className={`table-row review-list-row ${row.reviewStatus === "confirmed" ? "confirmed-row" : ""} ${activeReviewRow?.id === row.id ? "selected-row" : ""} ${activeTimedRow?.id === row.id ? "active-row" : ""} ${activeSearchRowId === row.id ? "search-row" : ""}`} key={row.id} data-row-id={row.id} onClick={() => selectReviewRow(row)}>
                      {hasMediaPlayback && (
                        <button className="seek-row" type="button" onClick={(event) => { event.stopPropagation(); selectReviewRow(row, true); }} aria-label={`定位到 ${formatClock(row.start)}`} title={`定位到 ${formatClock(row.start)}`}>
                          <LocateFixed size={13} /><span className="sr-only">定位</span>
                        </button>
                      )}
                      <span className="list-meta-stack">
                        <span className="list-time">{formatClock(row.start)} - {formatClock(row.end)}</span>
                        {rowSpeakerLabel && <span className="list-speaker">{rowSpeakerLabel}</span>}
                      </span>
                      <div className="list-text-stack">
                        <span data-label={showTranslationColumn ? "原文" : isTranscriptionFlow ? "转写原文" : "字幕原文"}>{row.text || "暂无内容"}</span>
                        {showTranslationColumn && (
                          row.translation
                            ? <span data-label="译文">{row.translation}</span>
                            : <span className="missing-translation-chip">缺译文</span>
                        )}
                      </div>
                      {rowQualityHints.length > 0 && <span className="row-quality-badge">{rowQualityHints[0]}</span>}
                      {row.reviewStatus === "confirmed" && <span className="review-status-badge confirmed">已确认</span>}
                    </div>
                  );
                })}
                {!rows.length && (
                  <div className="empty-inline subtitle-empty">
                    {emptyEditorText}
                  </div>
                )}
              </div>
            </section>
            )}

          </div>

        </div>
      </div>
    </div>
  );
}

function AsrConfigPanel({ asrProvider, setAsrProvider, serverStatus, refreshServerStatus }) {
  const [draft, setDraft] = useState(asrProvider);
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [testSample, setTestSample] = useState(null);
  const testSampleInputRef = useRef(null);
  const usesRivaGrpc = asrUsesRivaGrpc(draft);
  const usesDashScopeFunAsr = draft.transport === "dashscope-funasr";
  const requiresModel = asrRequiresModel(draft);
  const hasTargetAddress = usesDashScopeFunAsr || draft.transport === "nvidia-http"
    ? Boolean(String(draft.endpoint || "").trim())
    : Boolean(String(draft.functionId || "").trim());
  const hasRequiredModel = !requiresModel || Boolean(String(draft.model || "").trim());
  const hasMatchingServerKey = hasServerAsrKeyForProvider(draft, serverStatus);
  const hasCredential = Boolean(draft.apiKey || hasMatchingServerKey);
  const credentialLabel = draft.apiKey ? "浏览器 Key" : hasMatchingServerKey ? "服务端 ASR Key" : "";
  const ready = Boolean(hasCredential && hasTargetAddress && hasRequiredModel);
  const hasTestSample = Boolean(testSample);
  const keyMismatchWarning = draft.apiKey?.startsWith("nvapi-") && usesDashScopeFunAsr
    ? "当前 Key 看起来像 NVIDIA Key，但提供方是百炼 ASR。请确认提供方和 Key 来源是否匹配。"
    : draft.apiKey && asrUsesRivaGrpc(draft) && !draft.apiKey.startsWith("nvapi-")
      ? "当前 Key 看起来不像 NVIDIA Key，请确认它有当前 Riva / NVCF 端点权限。"
      : "";
  const tested = draft.lastTest?.ok === true;
  const failed = draft.lastTest?.ok === false;
  const rivaReady = asrDependencyReady(draft, serverStatus);
  const canTest = ready && rivaReady;
  const dependencyWarning = usesRivaGrpc && !serverStatus.rivaClientAvailable
    ? `当前服务未检测到 NVIDIA Riva SDK，gRPC 接入无法完成转写。${serverStatus.rivaClientError || ""}`
    : "";
  const targetLabel = usesDashScopeFunAsr ? "DashScope Base URL" : draft.transport === "nvidia-http" ? "HTTP Endpoint" : "Function ID";
  const missingAsrParts = [
    !hasCredential ? "ASR API Key" : "",
    !hasTargetAddress ? targetLabel : "",
    !hasRequiredModel ? "模型" : "",
  ].filter(Boolean);
  const missingTargetText = missingAsrParts.length
    ? `请填写 ${missingAsrParts.join("、")}；未配置时工作台不会启用开始转写。`
    : "转写服务已配置。可直接保存，或用内置样本验证真实识别结果。";
  const asrTestBlockedParts = [
    ...missingAsrParts,
    !rivaReady ? "服务依赖" : "",
  ].filter(Boolean);
  const asrTestBlockedText = asrTestBlockedParts.length
    ? `测试前需先补齐：${asrTestBlockedParts.join("、")}。`
    : "";
  const configStateText = dependencyWarning || keyMismatchWarning || (ready
    ? usesRivaGrpc
      ? `${credentialLabel} 已可用于音频转写。`
      : usesDashScopeFunAsr
        ? `${credentialLabel} 已可用于百炼 ASR。`
        : `${credentialLabel} 已可用于 HTTP 转写端点。`
    : missingTargetText);
  const badgeText = !ready ? "待配置" : !rivaReady ? "依赖缺失" : failed ? "测试失败" : tested ? "已验证" : "已配置";
  const showAsrRecommendation = failed || !usesDashScopeFunAsr || Boolean(keyMismatchWarning);
  const asrRecommendationText = usesRivaGrpc
    ? "当前使用 NVIDIA Riva gRPC。测试会使用内置 Riva 兼容样本；测试失败时不会启用该服务。"
    : !usesDashScopeFunAsr
      ? "当前提供方需要通过内置样本测试后才会作为可用转写服务。"
      : failed
        ? "当前配置测试失败，系统不会把它标记为可用转写服务。"
        : "";

  useEffect(() => setDraft(asrProvider), [asrProvider]);

  const updateDraft = (patch) => {
    setDraft((current) => ({ ...current, ...patch, lastTest: null }));
    setResult("");
  };

  const persist = (patch = {}, options = {}) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setAsrProvider(next);
    const stored = saveStored(STORAGE_KEYS.asrProvider, next);
    if (options.showResult) {
      setResult(stored ? "转写服务配置已保存。" : "当前浏览器无法保存配置；配置仅在本次页面会话有效。");
    }
    return next;
  };

  const saveAsrConfig = () => {
    persist({}, { showResult: true });
  };

  const markAsrTest = (lastTest) => {
    setDraft((current) => ({ ...current, lastTest }));
  };

  const handleProviderChange = (label) => {
    const preset = findAsrProviderPreset(label);
    const keepApiKey = asrCredentialScope(preset) === asrCredentialScope(draft);
    const next = { ...defaultAsrProvider, ...preset, apiKey: keepApiKey ? draft.apiKey : "" };
    setDraft(next);
    setTestSample(null);
    setResult("");
  };

  const handleTransportChange = (transport) => {
    setDraft((current) => {
      const next = { ...current, transport, lastTest: null };
      if (transport === "dashscope-funasr") {
        next.endpoint = current.endpoint?.startsWith("https://dashscope.") ? current.endpoint : "https://dashscope.aliyuncs.com/api/v1";
        next.model = current.model || "fun-asr";
        next.functionId = "";
        next.sendModel = false;
        next.videoInputMode = "original";
      }
      if (transport === "nvidia-http" && (!current.endpoint || current.endpoint === "grpc.nvcf.nvidia.com:443")) {
        next.endpoint = "";
        next.functionId = "";
        next.sendModel = true;
        next.videoInputMode = current.videoInputMode === "original" ? "original" : "extract";
      }
      if (transport === "nvidia-riva-grpc" && (!current.endpoint || current.endpoint.startsWith("http"))) {
        next.endpoint = "grpc.nvcf.nvidia.com:443";
        next.sendModel = false;
        next.videoInputMode = "extract";
      }
      return next;
    });
    setTestSample(null);
    setResult("");
  };

  const loadBuiltInTestSample = async () => {
    const sampleFormat = usesRivaGrpc ? "wav" : "m4a";
    const response = await fetch(`/api/asr/test-sample?format=${sampleFormat}&language=${encodeURIComponent(draft.languageCode || "multi")}`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "生成测试样本失败。");
    }
    const blob = await response.blob();
    return new File(
      [blob],
      sampleFormat === "wav" ? "echo-workbench-test.wav" : "echo-workbench-test.m4a",
      { type: blob.type || (sampleFormat === "wav" ? "audio/wav" : "audio/mp4"), lastModified: Date.now() },
    );
  };

  const useBuiltInTestSample = async () => {
    setBusy("sample");
    setResult("");
    try {
      const sample = await loadBuiltInTestSample();
      setTestSample(sample);
      setResult("已载入内置测试样本。点击“测试连接”会调用真实转写服务验证。");
    } catch (error) {
      setResult(error.message || "生成测试样本失败。请手动选择一段清晰语音音频。");
    } finally {
      setBusy("");
    }
  };

  const testAsrConnection = async () => {
    setBusy("test");
    setResult("");
    try {
      if (!hasCredential || !hasTargetAddress || !hasRequiredModel) {
        throw new Error(missingTargetText);
      }
      if (!rivaReady) {
        throw new Error(serverStatus.rivaClientError || "当前 gRPC 接入缺少 NVIDIA Riva SDK。");
      }
      const testFile = testSample || await loadBuiltInTestSample();
      if (!testSample) setTestSample(testFile);
      const testLanguageCode = usesRivaGrpc ? "en-US" : draft.languageCode || "multi";
      const data = await callAsr(draft, testFile, testLanguageCode);
      const transcript = String(data?.text || data?.transcript || data?.segments?.map?.((item) => item.text).filter(Boolean).join(" ") || "").trim();
      markAsrTest({ ok: true, message: "转写样本已返回结果。", at: Date.now() });
      setResult(`测试样本已提交，配置尚未保存。${transcript ? `识别片段：${transcript.slice(0, 180)}` : "接口已响应，但没有返回可读文本；请换一段清晰语音样本或检查模型。"}`);
    } catch (error) {
      const failureMessage = formatAsrConfigTestFailure(error);
      markAsrTest({ ok: false, message: failureMessage, at: Date.now() });
      setResult(failureMessage);
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="panel config-panel">
      <div className="panel-head">
        <h2><AudioWaveform size={20} />转写服务</h2>
        <span className={`config-badge ${ready && rivaReady && !failed ? "ok" : "warn"}`}>{badgeText}</span>
      </div>
      <div className="form-grid asr-core-grid">
        <label>
          提供方
          <select aria-label="转写服务提供方" value={draft.label} onChange={(event) => handleProviderChange(event.target.value)}>
            {asrProviderPresets.map((preset) => (
              <option key={preset.label}>{preset.label}</option>
            ))}
          </select>
        </label>
        <label>
          语言
          <select aria-label="转写识别语言" value={draft.languageCode} onChange={(event) => updateDraft({ languageCode: event.target.value })}>
            <option value="multi">自动识别 / multi</option>
            <option value="zh">中文 / zh</option>
            <option value="zh-CN">中文普通话 / zh-CN</option>
            <option value="en">英文 / en</option>
            <option value="en-US">美式英文 / en-US</option>
            <option value="ja">日文 / ja</option>
            <option value="ko">韩文 / ko</option>
            <option value="es">西班牙文 / es</option>
          </select>
        </label>
        <label className="span-2">
          ASR API Key
          <input type="password" value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} placeholder="只保存在当前浏览器，不写入仓库" />
        </label>
      </div>
      <div className={`config-state ${ready && !dependencyWarning && !keyMismatchWarning ? "ok" : "warn"}`}>
        {configStateText}
      </div>
      {showAsrRecommendation && (
        <div className="asr-recommendation">
          <div>
            <strong>建议配置</strong>
            <span>{asrRecommendationText}</span>
          </div>
        </div>
      )}
      <details className="advanced-config">
        <summary>
          <span><SlidersHorizontal size={17} />高级设置</span>
          <em>{draft.model || "默认模型"} · {usesDashScopeFunAsr ? "百炼 ASR" : draft.transport === "nvidia-http" ? "HTTP" : "Riva gRPC"}</em>
        </summary>
        <div className="form-grid">
          <label>
            模型
            <input value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })} placeholder={requiresModel ? "例如 whisper-1 / gpt-4o-transcribe / 端点要求的模型名" : "当前端点不需要发送模型名"} />
          </label>
          <label>
            接入协议
            <select aria-label="转写接入协议" value={draft.transport} onChange={(event) => handleTransportChange(event.target.value)}>
              <option value="dashscope-funasr">阿里云百炼 ASR</option>
              <option value="nvidia-http">HTTP audio transcription</option>
              <option value="nvidia-riva-grpc">NVIDIA Riva gRPC</option>
            </select>
          </label>
          {!usesDashScopeFunAsr && (
            <label className="span-2">
              视频输入方式
              <select aria-label="视频输入方式" value={draft.videoInputMode || "extract"} onChange={(event) => updateDraft({ videoInputMode: event.target.value })}>
                <option value="extract">从视频内音轨生成音频输入</option>
                <option value="original">直接提交原始视频</option>
              </select>
              <span className="field-note">
                大多数 audio transcription 端点只接收音频，建议保持默认。只有确认端点支持视频文件时，才选择直接提交原始视频。
              </span>
            </label>
          )}
          <label className="span-2">
            {targetLabel}
            <input
              value={usesDashScopeFunAsr || draft.transport === "nvidia-http" ? draft.endpoint : draft.functionId}
              onChange={(event) => {
                const value = event.target.value;
                updateDraft(usesDashScopeFunAsr || draft.transport === "nvidia-http" ? { endpoint: value } : { functionId: value });
              }}
              placeholder={usesDashScopeFunAsr ? "https://dashscope.aliyuncs.com/api/v1" : draft.transport === "nvidia-http" ? "https://.../v1/audio/transcriptions" : "NVIDIA hosted Riva function id"}
            />
            {!usesDashScopeFunAsr && (
              <span className="field-note">
                {draft.transport === "nvidia-http"
                  ? "HTTP 端点可使用 OpenAI-compatible audio transcription 服务，或自部署/远程 NVIDIA NIM 的 /v1/audio/transcriptions。"
                  : "NVIDIA Build 的 Whisper Large v3 可走 Riva gRPC；需要有效的 NVIDIA Build Key、Function ID、Riva SDK，以及兼容的 WAV/FLAC/OPUS 音频输入。"}
              </span>
            )}
          </label>
        </div>
        <div className="asr-test-sample">
          <input
            ref={testSampleInputRef}
            type="file"
            accept="audio/*"
            hidden
            onChange={(event) => {
              setTestSample(event.target.files?.[0] || null);
              event.target.value = "";
            }}
          />
          <div>
            <strong>测试样本</strong>
            <span>{testSample ? `${testSample.name} · ${(testSample.size / 1024 / 1024).toFixed(1)} MB` : "默认测试会自动使用内置语音样本；需要验证特定口音或噪声时再选择自己的音频。"}</span>
          </div>
          <button className="secondary" type="button" onClick={() => testSampleInputRef.current?.click()}>
            <Download size={18} />
            {testSample ? "更换样本" : "选择样本"}
          </button>
          <button className="secondary" type="button" onClick={useBuiltInTestSample} disabled={busy === "sample"}>
            {busy === "sample" ? <Loader2 className="spin" size={18} /> : <Sparkles size={18} />}
            使用测试样本
          </button>
          {testSample && <button className="secondary" type="button" onClick={() => setTestSample(null)}>移除样本</button>}
        </div>
      </details>
      <div className="config-actions">
        {asrTestBlockedText && <p className="config-action-hint">{asrTestBlockedText}</p>}
        <button className="secondary" onClick={saveAsrConfig}>保存配置</button>
        {usesRivaGrpc && (
          <button className="secondary" onClick={refreshServerStatus} disabled={serverStatus.checking}>
            {serverStatus.checking ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            检测服务依赖
          </button>
        )}
        <button className="primary" onClick={testAsrConnection} disabled={!canTest || busy === "test"} title={canTest ? "使用内置样本验证真实转写结果" : configStateText}>
          {busy === "test" ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
          测试连接
        </button>
      </div>
      {usesRivaGrpc && !rivaReady && (
        <div className="env-note warn">
          gRPC 接入需要服务端安装 NVIDIA Riva SDK；也可以切换到 HTTP audio transcription 端点。
        </div>
      )}
      {result && <div className={`message ${isErrorMessage(result) ? "error" : ""}`}>{result}</div>}
    </section>
  );
}

function ModelConfigView({ provider, setProvider, asrProvider, setAsrProvider, serverStatus, refreshServerStatus, activeConfigPanel, setActiveConfigPanel }) {
  const [draft, setDraft] = useState({ ...provider, keySource: "input" });
  const [busy, setBusy] = useState("");
  const [result, setResult] = useState("");
  const [storageOk, setStorageOk] = useState(() => storageWritable());

  useEffect(() => setDraft({ ...provider, keySource: "input" }), [provider]);

  const draftHasBaseConfig = Boolean(draft.baseUrl && draft.model);
  const draftForRequests = { ...draft, keySource: "input" };
  const draftReady = providerReady(draftForRequests);
  const modelOptions = getProviderModelOptions(draft);
  const textModelCompatibilityNotes = getTextModelCompatibilityNotes(draft);
  const missingTextModelParts = [
    !draft.baseUrl ? "Base URL" : "",
    !draft.model ? "模型" : "",
    !draft.apiKey ? "API Key" : "",
  ].filter(Boolean);
  const textModelActionHint = missingTextModelParts.length
    ? `连接测试前需先补齐：${missingTextModelParts.join("、")}。`
    : "";
  const configStatusText = !draftHasBaseConfig
    ? "请先补全 Base URL 和模型名称。"
    : draftReady
      ? "当前配置可用于连接测试和读取模型。密钥不会显示在页面或写入仓库。"
      : "请填写当前提供方的 API Key 后再测试连接。";

  const persist = (patch = {}, options = {}) => {
    const next = { ...draft, ...patch, keySource: "input" };
    setDraft(next);
    setProvider(next);
    const stored = saveStored(STORAGE_KEYS.provider, next);
    setStorageOk(stored);
    if (options.showResult) {
      if (!next.apiKey) {
        setResult(stored ? "基础配置已保存；缺少 API Key，连接测试前请填写。" : "缺少 API Key，且当前浏览器无法保存配置；配置仅在本次页面会话有效。");
      } else {
        setResult(stored ? "配置已保存。" : "当前浏览器无法保存配置；配置仅在本次页面会话有效。");
      }
    }
    return next;
  };

  const handleProviderChange = (label) => {
    const preset = findProviderPreset(label);
    setDraft({
      ...draft,
      label: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
      apiKey: "",
      keySource: "input",
      availableModels: [],
      lastTest: null,
      lastModelSync: null,
    });
    setResult("");
  };

  const fetchModels = async () => {
    setBusy("models");
    setResult("");
    try {
      if (!draftReady) {
        throw new Error(configStatusText);
      }
      const response = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: draftForRequests }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取模型失败");
      const models = (data.data || []).map((item) => item.id).filter(Boolean);
      persist({
        availableModels: models,
        model: models.includes(draft.model) ? draft.model : models[0] || draft.model,
        lastModelSync: { ok: true, message: `已读取 ${models.length} 个可用模型。`, at: Date.now() },
      });
      setResult(`已读取 ${models.length} 个可用模型。`);
    } catch (error) {
      persist({ lastModelSync: { ok: false, message: error.message, at: Date.now() } });
      setResult(error.message);
    } finally {
      setBusy("");
    }
  };

  const testConnection = async () => {
    setBusy("test");
    setResult("");
    try {
      if (!draftReady) {
        throw new Error(configStatusText);
      }
      const text = await callChat(draftForRequests, [
        { role: "system", content: "你是连接测试助手。" },
        { role: "user", content: "请只回复：回响连接成功" },
      ], { max_completion_tokens: 40 });
      persist({ lastTest: { ok: text.includes("回响") || text.length > 0, message: text, at: Date.now() } });
      setResult(text || "连接成功。");
    } catch (error) {
      persist({ lastTest: { ok: false, message: error.message, at: Date.now() } });
      setResult(error.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="config-view">
      <header className="workspace-header">
        <div>
          <strong>模型配置</strong>
          <p>转写服务负责音视频识别；文本模型负责校正、整理、翻译和摘要。</p>
        </div>
      </header>
      <div className="config-tabs" aria-label="模型配置类型">
        <button type="button" className={activeConfigPanel === "asr" ? "active" : ""} onClick={() => setActiveConfigPanel("asr")}>转写服务</button>
        <button type="button" className={activeConfigPanel === "text" ? "active" : ""} onClick={() => setActiveConfigPanel("text")}>文本模型</button>
      </div>
      {activeConfigPanel === "asr" ? (
        <AsrConfigPanel asrProvider={asrProvider} setAsrProvider={setAsrProvider} serverStatus={serverStatus} refreshServerStatus={refreshServerStatus} />
      ) : (
      <section className="panel config-panel text-model-config-panel">
        <div className="panel-head">
          <h2><Sparkles size={20} />文本模型</h2>
        </div>
        <div className="form-grid">
          <label>
            提供方
            <select aria-label="文本模型提供方" value={draft.label} onChange={(event) => handleProviderChange(event.target.value)}>
              {providerPresets.map((preset) => (
                <option key={preset.label}>{preset.label}</option>
              ))}
            </select>
          </label>
          <label>
            Base URL
            <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
          </label>
          <label>
            模型
            <input list="model-options" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            <datalist id="model-options">
              {modelOptions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label className="span-2">
            API Key
            <input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value, keySource: "input" })} placeholder="只保存在当前浏览器，不写入仓库" />
            {!storageOk && <span className="field-note warn">当前浏览器无法保存配置。仍可在本次页面会话中测试连接，但刷新后需要重新填写。</span>}
          </label>
        </div>
        {textModelCompatibilityNotes.length > 0 && (
          <div className="config-compatibility-note" role="note">
            {textModelCompatibilityNotes.map((note) => <span key={note}>{note}</span>)}
          </div>
        )}
        <div className={`config-state ${draftReady ? "ok" : "warn"}`}>
          {configStatusText}
        </div>
        <div className="config-actions">
          {textModelActionHint && <p className="config-action-hint">{textModelActionHint}</p>}
          <button className="secondary" onClick={() => persist({}, { showResult: true })}>保存配置</button>
          <button className="secondary" onClick={fetchModels} disabled={!draftReady || busy === "models"} title={draftReady ? "读取当前账号可用模型" : configStatusText}>
            {busy === "models" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            读取可用模型
          </button>
          <button className="primary" onClick={testConnection} disabled={!draftReady || busy === "test"} title={draftReady ? "发送一次最小连接测试" : configStatusText}>
            {busy === "test" ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
            连接测试
          </button>
        </div>
        {result && <div className={`message ${isErrorMessage(result) ? "error" : ""}`}>{result}</div>}
        <div className="model-list-block">
          <div className="model-list-head">
            <strong>预设模型</strong>
            <span>可直接选择，也可以在上方手动输入当前账号支持的模型名。</span>
          </div>
          <div className="model-list">
            {modelOptions.map((model) => (
              <button key={model} className={model === draft.model ? "active" : ""} onClick={() => persist({ model })}>{model}</button>
            ))}
          </div>
        </div>
      </section>
      )}
    </div>
  );
}

function projectRecordKey(item) {
  return item?.id || `${item?.name || "project"}-${item?.time || ""}`;
}

function projectMatchesKind(item, kind) {
  if (kind === "all") return true;
  const tool = inferRecentTool(item);
  if (kind === "video") return tool === "video-subtitles" || tool === "video-transcribe";
  if (kind === "audio") return tool === "audio-transcribe";
  if (kind === "subtitle") return tool === "subtitle-translate";
  return true;
}

function projectDisplayMeta(item) {
  const tool = inferRecentTool(item);
  const meta = String(item?.meta || "").trim();
  const countText = meta.match(/(\d+\s*条)/)?.[1] || "";
  const importedTextMeta = /字幕文件|字幕\/转写文件|转写\/字幕文件|文本导入/.test(meta);
  if ((tool === "audio-transcribe" || tool === "video-transcribe") && importedTextMeta) {
    const label = tool === "audio-transcribe" ? "音频转写" : "视频转写";
    const action = /已替换/.test(meta) ? "已替换文本" : /已导入/.test(meta) ? "已导入文本" : "导入文本";
    return countText ? `${label} · ${action} · ${countText}` : `${label} · ${action}`;
  }
  if (tool === "video-subtitles" && importedTextMeta) {
    const action = /已替换/.test(meta) ? "已替换字幕" : /已导入/.test(meta) ? "已导入字幕" : "导入字幕";
    return countText ? `视频智能字幕 · ${action} · ${countText}` : `视频智能字幕 · ${action}`;
  }
  return meta;
}

function projectRecoverableLabel(item) {
  if (item?.rowCount > 0 || item?.recoverableState === "has-results") return `有校对结果${item.rowCount ? ` · ${item.rowCount} 条` : ""}`;
  if (item?.hasMediaCopy || item?.recoverableState === "media-only") return "有媒体副本";
  if (item?.hasWorkspaceCopy) return "有本地副本";
  return "仅有记录";
}

function ProjectsView({ recents, onOpenRecent, onRenameProject, onDeleteProject, onClearProjects, workspaceStatus, onOpenSettings }) {
  const [confirmDeleteKey, setConfirmDeleteKey] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [deletingKey, setDeletingKey] = useState("");
  const [editingKey, setEditingKey] = useState("");
  const [editingName, setEditingName] = useState("");
  const [renamingKey, setRenamingKey] = useState("");
  const [notice, setNotice] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [projectKind, setProjectKind] = useState("all");
  const normalizedProjectSearch = projectSearch.trim().toLowerCase();
  const projectKindOptions = [
    { id: "all", label: "全部" },
    { id: "video", label: "视频" },
    { id: "audio", label: "音频" },
    { id: "subtitle", label: "字幕" },
  ];
  const filteredRecents = recents.filter((item) => {
    if (!projectMatchesKind(item, projectKind)) return false;
    if (!normalizedProjectSearch) return true;
    return [
      item.name,
      projectDisplayMeta(item),
      item.status,
      item.time,
      inferRecentTool(item),
    ].some((value) => String(value || "").toLowerCase().includes(normalizedProjectSearch));
  });
  const hasProjectFilter = normalizedProjectSearch || projectKind !== "all";
  const projectCountLabel = hasProjectFilter
    ? `显示 ${filteredRecents.length} / ${recents.length} 个项目`
    : `${recents.length} 个项目`;
  const hasAnyWorkspaceProjectCopy = recents.length > 0 || workspaceStatus.invalidProjectCount > 0;

  useEffect(() => {
    if (!confirmDeleteKey) return undefined;
    const timeout = window.setTimeout(() => setConfirmDeleteKey(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [confirmDeleteKey]);

  const handleDeleteProject = async (item) => {
    const key = projectRecordKey(item);
    if (confirmDeleteKey !== key) {
      setConfirmDeleteKey(key);
      setNotice("");
      return;
    }
    setDeletingKey(key);
    setNotice("");
    try {
      await onDeleteProject(item);
      setNotice(`已删除本地项目：${item.name || "未命名项目"}`);
      setConfirmDeleteKey("");
    } catch (error) {
      setNotice(error.message || "项目删除失败。请检查本地工作区权限。");
    } finally {
      setDeletingKey("");
    }
  };

  const startRenameProject = (item) => {
    setEditingKey(projectRecordKey(item));
    setEditingName(item.name || "");
    setConfirmDeleteKey("");
    setNotice("");
  };

  const handleRenameProject = async (event, item) => {
    event.preventDefault();
    const key = projectRecordKey(item);
    const nextName = editingName.trim();
    if (!nextName) {
      setNotice("项目名称不能为空。");
      return;
    }
    if (nextName === item.name) {
      setEditingKey("");
      setEditingName("");
      return;
    }
    setRenamingKey(key);
    setNotice("");
    try {
      await onRenameProject(item, nextName);
      setEditingKey("");
      setEditingName("");
    } catch (error) {
      setNotice(error.message || "项目重命名失败。请检查本地工作区权限。");
    } finally {
      setRenamingKey("");
    }
  };

  const handleClearProjects = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setNotice("再次点击“确认清空项目”会删除本地工作区中的全部项目副本，包括不完整副本。");
      return;
    }
    setNotice("");
    try {
      await onClearProjects();
      setConfirmClear(false);
    } catch (error) {
      setNotice(error.message || "项目清空失败。请检查本地工作区权限。");
    }
  };

  return (
    <div className="projects-view">
      <header className="workspace-header">
        <div>
          <strong>项目与文件</strong>
          <p>这里只显示本地工作区中可恢复的项目、媒体副本和处理结果。</p>
        </div>
        <button className={`secondary ${confirmClear ? "danger-outline" : ""}`} onClick={handleClearProjects} disabled={!hasAnyWorkspaceProjectCopy}>
          {confirmClear ? "确认清空项目" : "清空本地项目"}
        </button>
      </header>
      {!workspaceStatus.configured && (
        <section className="workspace-warning compact">
          <div>
            <strong>项目历史需要本地工作区</strong>
            <span>配置工作区后，新项目会保存媒体副本、校对表和整理稿；未配置时不建立可恢复项目。</span>
          </div>
          <button className="primary" onClick={onOpenSettings}>配置工作区</button>
        </section>
      )}
      {workspaceStatus.configured && workspaceStatus.temporaryRoot && (
        <section className="workspace-warning compact temporary-workspace-warning">
          <div>
            <strong>当前工作区位于系统临时目录</strong>
            <span>项目副本可能被系统清理。建议更换为 Documents 或其他长期保存目录，再继续建立项目历史。</span>
          </div>
          <button className="primary" onClick={onOpenSettings}>更换工作区</button>
        </section>
      )}
      <section className="panel projects-panel">
        <div className="panel-head">
          <div className="project-head-title">
            <h2><FolderOpen size={20} />本地项目记录</h2>
            <span>{projectCountLabel}</span>
          </div>
          <div className="project-filter-tabs" aria-label="项目类型筛选">
            {projectKindOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={projectKind === option.id ? "active" : ""}
                onClick={() => {
                  setProjectKind(option.id);
                  setConfirmDeleteKey("");
                  setNotice("");
                }}
                aria-pressed={projectKind === option.id}
                aria-label={`${option.label}项目`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="project-search">
            <Search size={16} />
            <input
              value={projectSearch}
              onChange={(event) => {
                setProjectSearch(event.target.value);
                setConfirmDeleteKey("");
                setNotice("");
              }}
              placeholder="搜索项目"
              aria-label="搜索本地项目"
            />
            {projectSearch && (
              <button type="button" onClick={() => setProjectSearch("")} aria-label="清空项目搜索">
                <X size={14} />
              </button>
            )}
          </label>
        </div>
        {notice && <div className={`message compact ${isErrorMessage(notice) ? "error" : ""}`}>{notice}</div>}
        {workspaceStatus.invalidProjectCount > 0 && (
          <div className="message compact warning">
            有 {workspaceStatus.invalidProjectCount} 个本地项目副本不完整，已从列表隐藏。可检查工作区目录，或重新导入素材生成新的可恢复项目。
          </div>
        )}
        <div className="project-list">
          {filteredRecents.map((item) => (
            <div className="project-row" key={projectRecordKey(item)}>
              <button className="project-open-area" type="button" onClick={() => onOpenRecent(item)} title="继续处理项目" aria-label={`继续处理项目 ${item.name}`}>
                <RecentFileChip item={item} />
                <div className="project-title">
                  <strong>{item.name}</strong>
                  <span>{projectDisplayMeta(item)}{item.time ? ` · ${item.time}` : ""} · {projectRecoverableLabel(item)}</span>
                </div>
                <em>{item.status}</em>
                <span className="project-open">继续处理 <ChevronRight size={16} /></span>
              </button>
              <div className="project-row-actions">
                {editingKey === projectRecordKey(item) ? (
                  <form className="project-rename-form" onSubmit={(event) => handleRenameProject(event, item)}>
                    <input
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      maxLength={80}
                      aria-label={`新的项目名称 ${item.name}`}
                      autoFocus
                    />
                    <button className="primary" type="submit" disabled={renamingKey === projectRecordKey(item)}>
                      {renamingKey === projectRecordKey(item) ? <Loader2 className="spin" size={15} /> : <Check size={15} />}
                      保存
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => {
                        setEditingKey("");
                        setEditingName("");
                        setNotice("");
                      }}
                      disabled={renamingKey === projectRecordKey(item)}
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      className="project-rename"
                      type="button"
                      onClick={() => startRenameProject(item)}
                      disabled={Boolean(editingKey) || renamingKey === projectRecordKey(item)}
                      aria-label={`重命名项目 ${item.name}`}
                    >
                      <PenLine size={16} />
                      重命名
                    </button>
                    <button
                      className={`project-delete ${confirmDeleteKey === projectRecordKey(item) ? "confirm" : ""}`}
                      type="button"
                      onClick={() => handleDeleteProject(item)}
                      disabled={deletingKey === projectRecordKey(item)}
                      aria-label={`${confirmDeleteKey === projectRecordKey(item) ? "确认删除项目" : "删除项目"} ${item.name}`}
                    >
                      {deletingKey === projectRecordKey(item) ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                      {confirmDeleteKey === projectRecordKey(item) ? "确认删除" : "删除"}
                    </button>
                  </>
                )}
                {confirmDeleteKey === projectRecordKey(item) && (
                  <button
                    className="project-delete-cancel"
                    type="button"
                    onClick={() => {
                      setConfirmDeleteKey("");
                      setNotice("");
                    }}
                    disabled={deletingKey === projectRecordKey(item)}
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          ))}
          {!recents.length && (
            <div className="empty-state large">
              {workspaceStatus.configured
                ? workspaceStatus.invalidProjectCount > 0
                  ? "没有可恢复的本地项目。可清空不完整副本，或重新导入素材建立新项目。"
                  : "还没有本地项目。回到首页选择工作台，再导入视频、音频或字幕文件开始。"
                : "请先配置本地工作区，再导入文件建立可恢复项目。"}
            </div>
          )}
          {recents.length > 0 && !filteredRecents.length && (
            <div className="empty-state large">
              没有匹配的本地项目。
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SettingsView({ provider, setProvider, asrProvider, setAsrProvider, setTerms, workspaceStatus, onConfigureWorkspace, onClearProjects, onSelectWorkspaceDirectory }) {
  const [notice, setNotice] = useState("");
  const [workspaceRoot, setWorkspaceRoot] = useState(workspaceStatus.root || "");
  const [confirmClearAction, setConfirmClearAction] = useState("");
  const workspacePathLabel = formatWorkspacePath(workspaceRoot);
  useEffect(() => {
    setWorkspaceRoot(workspaceStatus.root || "");
  }, [workspaceStatus.root]);
  useEffect(() => {
    if (!confirmClearAction) return undefined;
    const timeout = window.setTimeout(() => setConfirmClearAction(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [confirmClearAction]);
  const requireClearConfirmation = (action, message) => {
    if (confirmClearAction !== action) {
      setConfirmClearAction(action);
      setNotice(message);
      return false;
    }
    setConfirmClearAction("");
    return true;
  };
  return (
    <div className="settings-view">
      <header className="workspace-header">
        <div>
          <strong>设置</strong>
          <p>配置项目工作区和本机偏好。密钥不会在页面明文展示，也不会写入仓库。</p>
        </div>
      </header>
      <section className="panel config-panel">
        <div className="workspace-config">
          <div>
            <strong>本地工作区</strong>
            <span>{workspaceStatus.configured ? "已配置。项目记录、媒体副本和处理结果会保存到本地工作区。" : "首次使用前需要配置。未配置时不会导入素材或建立历史项目。"}</span>
          </div>
          <div className="workspace-path-card">
            <span className="field-label">工作区路径</span>
            <strong>{workspacePathLabel || "未选择工作区路径"}</strong>
            <details className="manual-path-editor">
              <summary>手动输入路径</summary>
              <textarea value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="请选择或输入本地工作区路径" rows={2} />
            </details>
          </div>
          {workspaceStatus.temporaryRoot && (
            <div className="workspace-temp-warning">
              当前工作区位于系统临时目录，项目副本可能被系统清理。建议选择 Documents 或其他长期保存目录。
            </div>
          )}
          <div className="workspace-config-actions">
            <button className="secondary" onClick={async () => {
              try {
                const root = await onSelectWorkspaceDirectory();
                if (root) setWorkspaceRoot(root);
                setNotice("");
              } catch (error) {
                setNotice(error.message || "选择工作区目录失败。");
              }
            }}>
              选择目录
            </button>
            <button className="primary" disabled={!workspaceRoot.trim()} onClick={async () => {
              try {
                await onConfigureWorkspace(workspaceRoot);
                setNotice("本地工作区已配置。后续项目会保存到本地工作区。");
              } catch (error) {
                setNotice(error.message || "本地工作区配置失败。");
              }
            }}>
              保存工作区
            </button>
          </div>
        </div>
        <div className="settings-section-title">
          <strong>数据管理</strong>
          <span>这些操作只影响当前浏览器配置或已选择工作区中的项目副本。</span>
        </div>
        <div className="settings-list">
          <div>
            <strong>模型配置</strong>
            <span>移除当前浏览器保存的文本模型配置、模型列表和连接测试结果。</span>
            <button aria-label={confirmClearAction === "provider" ? "确认清除模型配置" : "清除模型配置"} className={`secondary ${confirmClearAction === "provider" ? "danger-outline" : ""}`} onClick={() => {
              if (!requireClearConfirmation("provider", "再次点击“确认清除模型配置”会移除当前文本模型配置。")) return;
              setProvider(defaultProvider);
              saveStored(STORAGE_KEYS.provider, defaultProvider);
              setNotice("文本模型配置已清除。");
            }}>{confirmClearAction === "provider" ? "确认清除" : "清除"}</button>
          </div>
          <div>
            <strong>转写服务</strong>
            <span>移除当前浏览器保存的云端转写服务配置和测试结果。</span>
            <button aria-label={confirmClearAction === "asr" ? "确认清除转写服务" : "清除转写服务"} className={`secondary ${confirmClearAction === "asr" ? "danger-outline" : ""}`} onClick={() => {
              if (!requireClearConfirmation("asr", "再次点击“确认清除转写服务”会移除当前云端转写服务配置。")) return;
              setAsrProvider(defaultAsrProvider);
              saveStored(STORAGE_KEYS.asrProvider, defaultAsrProvider);
              setNotice("转写服务配置已清除。");
            }}>{confirmClearAction === "asr" ? "确认清除" : "清除"}</button>
          </div>
          <div>
            <strong>术语库</strong>
            <span>移除当前浏览器保存的术语映射。</span>
            <button aria-label={confirmClearAction === "terms" ? "确认清除术语库" : "清除术语库"} className={`secondary ${confirmClearAction === "terms" ? "danger-outline" : ""}`} onClick={() => {
              if (!requireClearConfirmation("terms", "再次点击“确认清除术语库”会移除当前浏览器保存的术语映射。")) return;
              setTerms([]);
              saveStored(STORAGE_KEYS.terms, []);
              setNotice("术语库已清除。");
            }}>{confirmClearAction === "terms" ? "确认清除" : "清除"}</button>
          </div>
          <div>
            <strong>本地项目</strong>
            <span>清除本地工作区中的项目副本和页面项目列表，不影响模型配置。</span>
            <button aria-label={confirmClearAction === "projects" ? "确认清除本地项目" : "清除本地项目"} className={`secondary ${confirmClearAction === "projects" ? "danger-outline" : ""}`} onClick={async () => {
              if (!requireClearConfirmation("projects", "再次点击“确认清除本地项目”会删除本地工作区中的项目副本。")) return;
              try {
                await onClearProjects();
                setConfirmClearAction("");
                setNotice("本地项目已清除。");
              } catch (error) {
                setNotice(error.message || "本地项目清除失败。请检查本地工作区权限。");
              }
            }} disabled={!workspaceStatus.configured}>{confirmClearAction === "projects" ? "确认清除" : "清除"}</button>
          </div>
        </div>
        {notice && <div className="message">{notice}</div>}
      </section>
    </div>
  );
}

function TermsView({ terms, setTerms }) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [notice, setNotice] = useState("");
  const [termSearch, setTermSearch] = useState("");
  const [confirmDeleteTermId, setConfirmDeleteTermId] = useState("");
  const termImportRef = useRef(null);
  const sourceTerm = source.trim();
  const targetTerm = target.trim();
  const canAddTerm = Boolean(sourceTerm && targetTerm);
  const normalizedTermSearch = termSearch.trim().toLowerCase();
  const filteredTerms = terms.filter((term) => {
    if (!normalizedTermSearch) return true;
    return [term.source, term.target].some((value) => String(value || "").toLowerCase().includes(normalizedTermSearch));
  });
  const termCountLabel = normalizedTermSearch ? `显示 ${filteredTerms.length} / ${terms.length} 条` : `${terms.length} 条术语`;
  const parseTermLines = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => ({
          source: String(item.source || item.term || item.original || "").trim(),
          target: String(item.target || item.translation || item.value || "").trim(),
        })).filter((item) => item.source && item.target);
      }
    } catch {
      // Fall through to line-based parsing.
    }
    const splitDelimitedLine = (line, delimiter) => {
      const cells = [];
      let cell = "";
      let inQuotes = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === '"') {
          if (inQuotes && line[index + 1] === '"') {
            cell += '"';
            index += 1;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === delimiter && !inQuotes) {
          cells.push(cell.trim());
          cell = "";
        } else {
          cell += char;
        }
      }
      cells.push(cell.trim());
      return cells;
    };
    return trimmed.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const cells = splitDelimitedLine(line, line.includes("\t") ? "\t" : ",");
        return { source: String(cells[0] || "").trim(), target: String(cells.slice(1).join(",") || "").trim() };
      })
      .filter((item) => item.source && item.target && item.source !== "原文术语" && item.source.toLowerCase() !== "source");
  };
  const persistTerms = (next, message = "") => {
    setTerms(next);
    saveStored(STORAGE_KEYS.terms, next);
    if (message) setNotice(message);
  };
  const addTerm = () => {
    if (!canAddTerm) return;
    const next = [...terms, { id: Date.now(), source: sourceTerm, target: targetTerm }];
    persistTerms(next, "术语已添加。");
    setSource("");
    setTarget("");
  };
  const deleteTerm = (term) => {
    if (confirmDeleteTermId !== term.id) {
      setConfirmDeleteTermId(term.id);
      setNotice("再次点击“确认删除”会移除此术语。");
      return;
    }
    const next = terms.filter((item) => item.id !== term.id);
    persistTerms(next, "术语已删除。");
    setConfirmDeleteTermId("");
  };
  const importTerms = async (file) => {
    if (!file) return;
    const imported = parseTermLines(await file.text());
    if (!imported.length) {
      setNotice("没有识别到可导入的术语。请使用两列 CSV/TSV/TXT：原文术语,目标译法。");
      return;
    }
    const keyOf = (term) => `${term.source}\n${term.target}`.toLowerCase();
    const existing = new Set(terms.map(keyOf));
    const nextItems = imported
      .filter((term) => !existing.has(keyOf(term)))
      .map((term, index) => ({ id: Date.now() + index, ...term }));
    persistTerms([...terms, ...nextItems], `已导入 ${nextItems.length} 条术语${nextItems.length < imported.length ? "，重复项已跳过" : ""}。`);
  };
  const exportTerms = () => {
    if (!terms.length) {
      setNotice("还没有可导出的术语。");
      return;
    }
    const escapeCell = (value) => `"${String(value || "").replaceAll('"', '""')}"`;
    const csv = ["原文术语,目标译法", ...terms.map((term) => `${escapeCell(term.source)},${escapeCell(term.target)}`)].join("\n");
    downloadText("echo-terms.csv", csv);
    setNotice("术语库已导出为 CSV。");
  };
  return (
    <div className="terms-view">
      <header className="workspace-header">
        <div>
          <strong>术语库</strong>
          <p>术语会进入翻译提示词，帮助当前模型保持专有名词一致。</p>
        </div>
        <div className="terms-actions">
          <button className="secondary" type="button" onClick={() => termImportRef.current?.click()}><Download size={18} />导入术语</button>
          <button className="secondary" type="button" onClick={exportTerms} disabled={!terms.length}><Upload size={18} />导出 CSV</button>
        </div>
      </header>
      <input
        ref={termImportRef}
        type="file"
        accept=".csv,.tsv,.txt,.json"
        hidden
        onChange={(event) => {
          importTerms(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <section className="panel config-panel">
        <div className="panel-head">
          <div className="term-head-title">
            <h2><BookOpen size={20} />术语映射</h2>
            <span>{termCountLabel}</span>
          </div>
          <label className="term-search">
            <Search size={16} />
            <input
              value={termSearch}
              onChange={(event) => setTermSearch(event.target.value)}
              placeholder="搜索术语"
              aria-label="搜索术语"
            />
            {termSearch && (
              <button type="button" onClick={() => setTermSearch("")} aria-label="清空术语搜索">
                <X size={14} />
              </button>
            )}
          </label>
        </div>
        <div className="term-inputs">
          <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="原文术语，例如 产品路线图" />
          <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="目标译法，例如 product roadmap" />
          <button className="primary" onClick={addTerm} disabled={!canAddTerm}>添加术语</button>
        </div>
        {notice && <div className={`message compact ${isErrorMessage(notice) ? "error" : ""}`}>{notice}</div>}
        <div className="term-list">
          {filteredTerms.map((term) => (
            <div key={term.id} className="term-row">
              <strong>{term.source}</strong>
              <span>{term.target}</span>
              <div className="term-row-actions">
                <button
                  className={confirmDeleteTermId === term.id ? "confirm" : ""}
                  onClick={() => deleteTerm(term)}
                  aria-label={`${confirmDeleteTermId === term.id ? "确认删除术语" : "删除术语"} ${term.source}`}
                >
                  <Trash2 size={15} />
                  {confirmDeleteTermId === term.id ? "确认删除" : "删除"}
                </button>
                {confirmDeleteTermId === term.id && (
                  <button
                    className="term-delete-cancel"
                    onClick={() => {
                      setConfirmDeleteTermId("");
                      setNotice("");
                    }}
                  >
                    取消
                  </button>
                )}
              </div>
            </div>
          ))}
          {!terms.length && (
            <div className="empty-state term-empty-state">
              <strong>还没有术语</strong>
              <span>添加人名、产品名、专有名词或固定译法后，会用于字幕翻译、转写校正和整理。</span>
              <small>可手动添加，也可导入 CSV/TSV/TXT/JSON；每行使用“原文术语,目标译法”。</small>
            </div>
          )}
          {terms.length > 0 && !filteredTerms.length && <p className="empty-state">没有匹配的术语。</p>}
        </div>
      </section>
    </div>
  );
}

function getWorkbenchLeaveWarning({ activeNav, workbenchBusy, workspaceSaveStatus }) {
  if (activeNav !== "workbench") return "";
  if (workbenchBusy) return "当前任务正在执行，离开工作台会中断处理。";
  if (workspaceSaveStatus?.state === "error") return "最近一次本地保存失败，离开后可能无法从项目记录恢复当前进度。";
  return "";
}

export function App() {
  useEffect(() => {
    document.title = "\u00a0";
  }, []);

  const [activeNav, setActiveNav] = useState("home");
  const [activeTool, setActiveTool] = useState("home");
  const [selectedFeature, setSelectedFeature] = useState(featureCards[0]);
  const [provider, setProvider] = useState(() => ensureChinaMiniMaxProvider(loadStored(STORAGE_KEYS.provider, defaultProvider)));
  const [asrProvider, setAsrProvider] = useState(() => ensureAsrProvider(loadStored(STORAGE_KEYS.asrProvider, defaultAsrProvider)));
  const [terms, setTerms] = useState(() => loadStored(STORAGE_KEYS.terms, []));
  const [recents, setRecents] = useState(() => loadStored(STORAGE_KEYS.recents, []));
  const [rows, setRows] = useState([]);
  const [media, setMedia] = useState(null);
  const [workspaceState, setWorkspaceState] = useState(defaultWorkspaceState);
  const [serverStatus, setServerStatus] = useState(defaultServerStatus);
  const [workspaceStatus, setWorkspaceStatus] = useState(defaultWorkspaceStatus);
  const [workspaceFeatureId, setWorkspaceFeatureId] = useState("");
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeProjectName, setActiveProjectName] = useState("");
  const [workspaceNotice, setWorkspaceNotice] = useState(null);
  const [workspaceSaveStatus, setWorkspaceSaveStatus] = useState({ state: "idle", message: "" });
  const [workbenchBusy, setWorkbenchBusy] = useState("");
  const [modelConfigPanel, setModelConfigPanel] = useState("asr");
  const activeProjectIdRef = useRef("");
  const savedMediaSignatureRef = useRef("");
  const savedWorkspaceMediaSignatureRef = useRef("");
  const savedWorkspaceAudioSignatureRef = useRef("");
  const saveWorkspaceQueueRef = useRef(Promise.resolve());
  const workspaceFailureRef = useRef(new Set());
  const deletingWorkspaceProjectIdsRef = useRef(new Set());
  const applyingHistoryNavigationRef = useRef(false);
  const replaceNextNavigationRef = useRef(false);
  const currentRouteHashRef = useRef("#home");
  const ignoreNextPopStateRef = useRef(false);
  const lastAppliedHistoryHashRef = useRef("");
  const navigationGuardRef = useRef({ activeNav: "home", workbenchBusy: "", workspaceSaveStatus: { state: "idle", message: "" } });
  const [navigationReady, setNavigationReady] = useState(false);

  const workbenchLeaveWarning = () => {
    return getWorkbenchLeaveWarning({ activeNav, workbenchBusy, workspaceSaveStatus });
  };

  const requestNavigation = (targetNav, targetLabel = "离开当前工作台") => {
    if (targetNav !== activeNav) {
      const warning = workbenchLeaveWarning();
      if (warning && !window.confirm(`${warning}\n\n确定${targetLabel}吗？`)) return false;
    }
    if (targetNav !== "workbench") {
      setActiveTool("home");
      setActiveProjectId("");
      setActiveProjectName("");
    }
    setActiveNav(targetNav);
    return true;
  };

  const handleWorkbenchBusyChange = useCallback((nextBusy) => {
    setWorkbenchBusy(nextBusy || "");
  }, []);

  useEffect(() => {
    navigationGuardRef.current = { activeNav, workbenchBusy, workspaceSaveStatus };
  }, [activeNav, workbenchBusy, workspaceSaveStatus]);

  const refreshServerStatus = async () => {
    setServerStatus((current) => ({ ...current, checking: true, error: "" }));
    try {
      const response = await fetch("/api/provider-status");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "检测失败");
      setServerStatus({
        checking: false,
        envKeyConfigured: Boolean(data.envKeyConfigured),
        asrEnvKeys: data.asrEnvKeys || {},
        nvidiaEnvKeyConfigured: Boolean(data.asrEnvKeyConfigured ?? data.nvidiaEnvKeyConfigured),
        rivaClientAvailable: Boolean(data.rivaClientAvailable),
        rivaClientError: data.rivaClientError || "",
        error: "",
      });
    } catch (error) {
      setServerStatus({ ...defaultServerStatus, checking: false, error: error.message || "检测失败" });
    }
  };

  const refreshWorkspaceStatus = async () => {
    setWorkspaceStatus((current) => ({ ...current, checking: true, error: "" }));
    try {
      const data = await fetchWorkspaceStatus();
      setWorkspaceStatus({ ...defaultWorkspaceStatus, ...data, checking: false, error: "" });
      if (data.configured && Array.isArray(data.projects)) {
        setRecents(data.projects);
      } else if (!data.configured) {
        setRecents((current) => current.map((item) => ({ ...item, hasWorkspaceCopy: false })));
      }
    } catch (error) {
      setWorkspaceStatus((current) => ({ ...current, checking: false, configured: false, error: error.message || "读取本地工作区失败" }));
    }
  };

  useEffect(() => {
    refreshServerStatus();
    refreshWorkspaceStatus();
  }, []);

  useEffect(() => {
    saveStored(STORAGE_KEYS.provider, provider);
  }, [provider]);
  useEffect(() => {
    saveStored(STORAGE_KEYS.asrProvider, asrProvider);
  }, [asrProvider]);
  useEffect(() => {
    saveStored(STORAGE_KEYS.terms, terms);
  }, [terms]);
  useEffect(() => {
    saveStored(STORAGE_KEYS.recents, recents);
  }, [recents]);
  useEffect(() => {
    activeProjectIdRef.current = activeProjectId;
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) {
      setWorkspaceSaveStatus({ state: "idle", message: "" });
      return;
    }
    if (deletingWorkspaceProjectIdsRef.current.has(activeProjectId)) return;
    const recent = recents.find((item) => item.id === activeProjectId);
    if (!recent) {
      setWorkspaceSaveStatus({ state: "idle", message: "" });
      return;
    }
    const patch = {
      id: activeProjectId,
      recent,
      tool: inferRecentTool(recent),
      rows,
      workspaceState,
    };
    if (workspaceStatus.configured) {
      const savingProjectId = activeProjectId;
      setWorkspaceSaveStatus({ state: "saving", message: "保存中" });
      const workspaceMediaSignature = primaryMediaSignature(media);
      const workspaceAudioSignature = audioTrackSignature(media?.asrAudio);
      const workspaceMediaChanged = workspaceMediaSignature !== savedWorkspaceMediaSignatureRef.current;
      const workspaceAudioChanged = workspaceAudioSignature !== savedWorkspaceAudioSignatureRef.current;
      const workspaceProject = {
        ...patch,
        media: workspaceMediaChanged
          ? media?.file ? {
            name: media.name,
            type: media.type,
            size: media.size,
            duration: media.duration || 0,
            lastModified: media.file.lastModified || Date.now(),
          } : null
          : media
            ? { name: media.name, type: media.type, size: media.size, duration: media.duration || 0 }
            : null,
        asrAudio: workspaceAudioChanged
          ? media?.asrAudio?.file ? {
            name: media.asrAudio.name,
            type: media.asrAudio.type,
            size: media.asrAudio.size,
            duration: media.asrAudio.duration || 0,
            lastModified: media.asrAudio.file.lastModified || Date.now(),
          } : null
          : media?.asrAudio
            ? { name: media.asrAudio.name, type: media.asrAudio.type, size: media.asrAudio.size, duration: media.asrAudio.duration || 0 }
            : null,
      };
      const saveTask = saveWorkspaceQueueRef.current
        .catch(() => {})
        .then(() => saveWorkspaceProject(
          workspaceProject,
          workspaceMediaChanged ? media?.file : null,
          workspaceAudioChanged ? media?.asrAudio?.file : null,
        ));
      saveWorkspaceQueueRef.current = saveTask;
      saveTask
        .then(() => {
          if (savingProjectId !== activeProjectIdRef.current) return;
          savedMediaSignatureRef.current = mediaSignature(media);
          savedWorkspaceMediaSignatureRef.current = workspaceMediaSignature;
          savedWorkspaceAudioSignatureRef.current = workspaceAudioSignature;
          workspaceFailureRef.current.delete(savingProjectId);
          setRecents((current) => {
            let changed = false;
            const next = current.map((item) => {
              if (item.id !== savingProjectId || item.hasWorkspaceCopy) return item;
              changed = true;
              return { ...item, hasWorkspaceCopy: true };
            });
            return changed ? next : current;
          });
          setWorkspaceStatus((current) => {
            if (!current.configured) return current;
            const savedRecent = {
              ...recent,
              id: savingProjectId,
              hasWorkspaceCopy: true,
              hasMediaCopy: Boolean(media),
              hasAsrAudioCopy: Boolean(media?.asrAudio),
              rowCount: rows.length,
              recoverableState: rows.length ? "has-results" : media ? "media-only" : "metadata-only",
              updatedAt: Date.now(),
            };
            return {
              ...current,
              projects: mergeRecentProjects([savedRecent], current.projects || []),
            };
          });
          setWorkspaceSaveStatus({ state: "saved", message: "已保存" });
        })
        .catch((error) => {
          if (savingProjectId !== activeProjectIdRef.current) return;
          const detail = error?.message || "保存本地项目失败。";
          setWorkspaceSaveStatus({ state: "error", message: "保存失败", detail });
          if (!workspaceFailureRef.current.has(savingProjectId)) {
            workspaceFailureRef.current.add(savingProjectId);
            setWorkspaceNotice({
              id: Date.now(),
              text: `本地工作区保存失败：${detail} 当前页面仍可继续处理，但项目历史可能无法恢复媒体文件。`,
            });
          }
        });
    } else {
      setWorkspaceSaveStatus({ state: "unconfigured", message: "未配置工作区" });
    }
  }, [activeProjectId, recents, media, rows, workspaceState, workspaceStatus.configured]);

  const addRecent = (item) => {
    const reuseCurrentId = activeProjectId && activeProjectName && item.name === activeProjectName;
    const id = item.id || (reuseCurrentId ? activeProjectId : createProjectId());
    if (!item.id && !reuseCurrentId && activeNav === "workbench") {
      replaceNextNavigationRef.current = true;
    }
    deletingWorkspaceProjectIdsRef.current.delete(id);
    if (!reuseCurrentId) savedMediaSignatureRef.current = "";
    if (!reuseCurrentId) savedWorkspaceMediaSignatureRef.current = "";
    if (!reuseCurrentId) savedWorkspaceAudioSignatureRef.current = "";
    if (!reuseCurrentId) setWorkspaceSaveStatus({ state: "idle", message: "" });
    const nextItem = { ...item, id, hasWorkspaceCopy: Boolean(item.hasWorkspaceCopy), updatedAt: item.updatedAt || Date.now() };
    setActiveProjectId(id);
    setActiveProjectName(nextItem.name);
    setRecents((current) => mergeRecentProjects([nextItem], current));
    return id;
  };

  const updateActiveRecent = (patch) => {
    if (!activeProjectId) return;
    setRecents((current) => mergeRecentProjects(current.map((item) => {
      if (item.id !== activeProjectId) return item;
      return {
        ...item,
        ...patch,
        updatedAt: patch.updatedAt || Date.now(),
        hasWorkspaceCopy: patch.hasWorkspaceCopy ?? item.hasWorkspaceCopy,
      };
    })));
  };

  const activateWorkspace = (id, options = {}) => {
    if (options.forceReset || workspaceFeatureId !== id) {
      setActiveProjectId("");
      setActiveProjectName("");
      setRows([]);
      setMedia(null);
      setWorkspaceState(workspaceDefaultsForFeature(id));
      setWorkspaceNotice(null);
      setWorkspaceSaveStatus({ state: "idle", message: "" });
      savedMediaSignatureRef.current = "";
      savedWorkspaceMediaSignatureRef.current = "";
      savedWorkspaceAudioSignatureRef.current = "";
    }
    setWorkspaceFeatureId(id);
  };

  const restoreWorkspaceProject = async (projectId, fallbackItem = null, options = {}) => {
    const isCurrent = options.isCurrent || (() => true);
    const workspaceProject = await loadWorkspaceProject(projectId);
    if (!isCurrent()) return { stale: true };
    const repairedProjectRows = Array.isArray(workspaceProject.rows)
      ? repairReviewStructureUnlessEmpty(workspaceProject.rows, { maxEnd: workspaceProjectDurationLimit(workspaceProject) })
      : { rows: [], splitRowCount: 0, addedRowCount: 0, mergedRowCount: 0 };
    const recent = {
      ...(fallbackItem || {}),
      ...(workspaceProject.recent || {}),
      id: projectId,
      hasWorkspaceCopy: true,
      hasMediaCopy: Boolean(workspaceProject.media?.fileName || workspaceProject.mediaUrl),
      hasAsrAudioCopy: Boolean(workspaceProject.asrAudio?.fileName || workspaceProject.asrAudioUrl),
      rowCount: repairedProjectRows.rows.length,
      recoverableState: repairedProjectRows.rows.length
        ? "has-results"
        : workspaceProject.media?.fileName || workspaceProject.mediaUrl
          ? "media-only"
          : "metadata-only",
    };
    const tool = workspaceProject.tool || inferRecentTool(recent);
    const feature = featureCards.find((entry) => entry.id === tool) || featureCards[0];
    const restoredMedia = await mediaStateFromWorkspaceProject(workspaceProject);
    if (!isCurrent()) return { stale: true };
    setSelectedFeature(feature);
    setWorkspaceFeatureId(feature.id);
    setActiveTool(feature.id);
    setActiveNav("workbench");
    setRows(repairedProjectRows.rows);
    setMedia(restoredMedia);
    setWorkspaceState({ ...defaultWorkspaceState, ...(workspaceProject.workspaceState || {}) });
    setWorkspaceNotice(null);
    savedMediaSignatureRef.current = mediaSignature(restoredMedia);
    savedWorkspaceMediaSignatureRef.current = primaryMediaSignature(restoredMedia);
    savedWorkspaceAudioSignatureRef.current = audioTrackSignature(restoredMedia?.asrAudio);
    setActiveProjectName(recent.name || fallbackItem?.name || "未命名项目");
    setActiveProjectId(projectId);
    setWorkspaceSaveStatus({ state: "saved", message: "已保存" });
    setRecents((current) => mergeRecentProjects([recent], current));
    setWorkspaceStatus((current) => current.configured
      ? { ...current, projects: mergeRecentProjects([recent], current.projects || []) }
      : current);
    return { tool: feature.id, recent };
  };

  const openRecentProject = async (item) => {
    if (!workspaceStatus.configured) {
      requestNavigation("settings", "进入设置");
      setWorkspaceNotice({
        id: Date.now(),
        text: "请先配置本地工作区，再打开可恢复项目。",
      });
      return;
    }
    const tool = inferRecentTool(item);
    const feature = featureCards.find((entry) => entry.id === tool) || featureCards[0];
    const isCurrentSessionProject = Boolean(activeProjectId && item.id && item.id === activeProjectId);
    if (item.id) {
      if (workspaceStatus.configured) {
        try {
          await restoreWorkspaceProject(item.id, item);
          return;
        } catch {
          if (item.hasWorkspaceCopy) {
            setWorkspaceNotice({
              id: Date.now(),
              text: `无法从本地工作区恢复项目：${item.name}。请检查工作区目录或重新导入素材。`,
            });
            return;
          }
        }
      }
    }
    setSelectedFeature(feature);
    setWorkspaceFeatureId(tool);
    setActiveTool(tool);
    setActiveNav("workbench");
    if (!isCurrentSessionProject) {
      setActiveProjectId("");
      setActiveProjectName("");
      setRows([]);
      setMedia(null);
      setWorkspaceState(workspaceDefaultsForFeature(tool));
      savedMediaSignatureRef.current = "";
      savedWorkspaceMediaSignatureRef.current = "";
      savedWorkspaceAudioSignatureRef.current = "";
      setWorkspaceSaveStatus({ state: "idle", message: "" });
    }
    setWorkspaceNotice({
      id: Date.now(),
      text: isCurrentSessionProject
        ? `已打开最近项目：${item.name}`
        : `无法恢复 ${item.name}。项目历史只展示本地工作区中存在媒体副本和处理结果的项目。`,
    });
  };

  const clearRecentProjects = async () => {
    if (workspaceStatus.configured) {
      try {
        await clearWorkspaceProjects();
      } catch (error) {
        setWorkspaceNotice({
          id: Date.now(),
          text: "本地工作区项目清除失败。已保留当前页面记录，请检查工作区目录权限后重试。",
        });
        throw error;
      }
    }
    setRecents([]);
    setRows([]);
    setMedia(null);
    setWorkspaceState(defaultWorkspaceState);
    setActiveProjectId("");
    setActiveProjectName("");
    setWorkspaceSaveStatus({ state: "idle", message: "" });
    savedMediaSignatureRef.current = "";
    savedWorkspaceMediaSignatureRef.current = "";
    savedWorkspaceAudioSignatureRef.current = "";
    saveStored(STORAGE_KEYS.recents, []);
    if (workspaceStatus.configured) {
      setWorkspaceStatus((current) => ({ ...current, projects: [], invalidProjectCount: 0 }));
    }
  };

  const deleteRecentProject = async (item) => {
    const key = projectRecordKey(item);
    const deletingActiveProject = Boolean(activeProjectId && item.id && activeProjectId === item.id);
    if (item.id) {
      deletingWorkspaceProjectIdsRef.current.add(item.id);
      await saveWorkspaceQueueRef.current.catch(() => {});
    }
    if (deletingActiveProject) {
      setRows([]);
      setMedia(null);
      setWorkspaceState(defaultWorkspaceState);
      setActiveProjectId("");
      setActiveProjectName("");
      setWorkspaceSaveStatus({ state: "idle", message: "" });
      savedMediaSignatureRef.current = "";
      savedWorkspaceMediaSignatureRef.current = "";
      savedWorkspaceAudioSignatureRef.current = "";
    }
    if (workspaceStatus.configured && item.id) {
      const data = await deleteWorkspaceProject(item.id);
      setWorkspaceStatus((current) => ({
        ...current,
        invalidProjectCount: typeof data.invalidProjectCount === "number" ? data.invalidProjectCount : current.invalidProjectCount,
        projects: Array.isArray(data.projects)
          ? data.projects
          : (current.projects || []).filter((project) => project.id !== item.id),
      }));
    }
    setRecents((current) => current.filter((entry) => {
      if (item.id) return entry.id !== item.id;
      return projectRecordKey(entry) !== key;
    }));
    if (item.id) {
      workspaceFailureRef.current.delete(item.id);
    }
  };

  const renameRecentProject = async (item, nextName) => {
    const cleanName = String(nextName || "").trim();
    if (!cleanName) throw new Error("项目名称不能为空。");
    if (!item.id) throw new Error("这个项目缺少本地副本，无法重命名。");
    await saveWorkspaceQueueRef.current.catch(() => {});
    const renamed = await renameWorkspaceProject(item.id, cleanName);
    const updatedRecent = {
      ...item,
      ...(renamed?.recent || {}),
      id: item.id,
      name: cleanName,
      hasWorkspaceCopy: true,
      updatedAt: item.updatedAt || renamed?.updatedAt || Date.now(),
    };
    setRecents((current) => mergeRecentProjects(current.map((entry) => (
      entry.id === item.id ? { ...entry, ...updatedRecent } : entry
    ))));
    setWorkspaceStatus((current) => current.configured
      ? {
        ...current,
        projects: mergeRecentProjects((current.projects || []).map((entry) => (
          entry.id === item.id ? { ...entry, ...updatedRecent } : entry
        ))),
      }
      : current);
    if (activeProjectId === item.id) {
      setActiveProjectName(cleanName);
    }
    setWorkspaceNotice({
      id: Date.now(),
      text: `项目已重命名为：${cleanName}`,
    });
  };

  const handleConfigureWorkspace = async (root) => {
    const previousWorkspaceRoot = workspaceStatus.root || "";
    const data = await configureLocalWorkspace(root);
    const switchedWorkspace = Boolean(
      workspaceStatus.configured
      && previousWorkspaceRoot
      && data.root
      && data.root !== previousWorkspaceRoot,
    );
    setWorkspaceStatus({ ...defaultWorkspaceStatus, ...data, checking: false, error: "" });
    if (Array.isArray(data.projects)) {
      setRecents(data.projects);
    }
    if (switchedWorkspace) {
      setRows([]);
      setMedia(null);
      setWorkspaceState(defaultWorkspaceState);
      setActiveProjectId("");
      setActiveProjectName("");
      setWorkspaceFeatureId("");
      setWorkspaceSaveStatus({ state: "idle", message: "" });
      savedMediaSignatureRef.current = "";
      savedWorkspaceMediaSignatureRef.current = "";
      savedWorkspaceAudioSignatureRef.current = "";
      workspaceFailureRef.current.clear();
      setWorkspaceNotice({
        id: Date.now(),
        text: "已切换本地工作区。当前页面已清空旧工作区项目状态，请从新工作区的项目记录继续。",
      });
    }
    return data;
  };

  const openWorkbench = (id) => {
    if (id === "models") {
      setModelConfigPanel("asr");
      requestNavigation("models", "进入模型配置");
      return;
    }
    const feature = featureCards.find((item) => item.id === id);
    if (feature) setSelectedFeature(feature);
    if (feature) activateWorkspace(feature.id, { forceReset: true });
    setActiveTool(id);
    setActiveNav("workbench");
  };

  const applyNavigationFromHash = async () => {
    const navigationHash = window.location.hash;
    const rawHash = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    const [nav = "home", tool, projectId] = rawHash.split("/");
    const validNav = navItems.some((item) => item.id === nav) ? nav : "home";
    applyingHistoryNavigationRef.current = true;
    if (validNav === "workbench") {
      const feature = featureCards.find((item) => item.id === tool) || selectedFeature;
      if (projectId) {
        try {
          const restored = await restoreWorkspaceProject(projectId, null, {
            isCurrent: () => window.location.hash === navigationHash,
          });
          if (restored.stale) return;
          if (restored.tool !== feature.id) {
            window.history.replaceState(
              { nav: "workbench", tool: restored.tool, projectId },
              "",
              `#workbench/${restored.tool}/${encodeURIComponent(projectId)}`,
            );
          }
        } catch (error) {
          if (window.location.hash !== navigationHash) return;
          setSelectedFeature(feature);
          activateWorkspace(feature.id);
          setActiveTool(feature.id);
          setActiveNav("workbench");
          setWorkspaceNotice({
            id: Date.now(),
            text: `无法从本地工作区恢复项目。${error.message || "请从项目与文件重新打开。"}`,
          });
        }
        return;
      }
      setSelectedFeature(feature);
      activateWorkspace(feature.id, { forceReset: Boolean(activeProjectId) });
      setActiveTool(feature.id);
      setActiveNav("workbench");
      return;
    }
    if (validNav === "models") {
      setModelConfigPanel(tool === "text" ? "text" : "asr");
    }
    setActiveTool("home");
    setActiveProjectId("");
    setActiveProjectName("");
    setActiveNav(validNav);
  };

  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState({ nav: "home", tool: selectedFeature.id }, "", "#home");
      currentRouteHashRef.current = "#home";
      setNavigationReady(true);
    } else {
      const initialHash = window.location.hash;
      if (!window.history.state && initialHash !== "#home") {
        const rawHash = decodeURIComponent(initialHash.replace(/^#/, ""));
        const [nav = "home", tool, projectId] = rawHash.split("/");
        const state = nav === "workbench"
          ? { nav: "workbench", tool: tool || selectedFeature.id, projectId: projectId || "" }
          : nav === "models"
            ? { nav: "models", tool: tool === "text" ? "text" : "asr", projectId: "" }
            : { nav, tool: tool || selectedFeature.id, projectId: "" };
        window.history.replaceState({ nav: "home", tool: selectedFeature.id, projectId: "" }, "", "#home");
        window.history.pushState(state, "", initialHash);
      }
      void applyNavigationFromHash().finally(() => setNavigationReady(true));
    }
    const handlePopState = () => {
      lastAppliedHistoryHashRef.current = window.location.hash;
      if (ignoreNextPopStateRef.current) {
        ignoreNextPopStateRef.current = false;
        return;
      }
      const warning = getWorkbenchLeaveWarning(navigationGuardRef.current);
      if (warning && !window.confirm(`${warning}\n\n确定离开当前工作台吗？`)) {
        ignoreNextPopStateRef.current = true;
        window.history.forward();
        return;
      }
      void applyNavigationFromHash();
    };
    const handleHashChange = () => {
      if (lastAppliedHistoryHashRef.current === window.location.hash) {
        lastAppliedHistoryHashRef.current = "";
        return;
      }
      void applyNavigationFromHash();
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  useEffect(() => {
    if (!navigationReady) return;
    const tool = activeTool === "home" ? selectedFeature.id : activeTool;
    const hash = activeNav === "workbench"
      ? `#workbench/${tool}${activeProjectId ? `/${encodeURIComponent(activeProjectId)}` : ""}`
      : activeNav === "models"
        ? `#models/${modelConfigPanel === "text" ? "text" : "asr"}`
      : `#${activeNav}`;
    const state = { nav: activeNav, tool, projectId: activeNav === "workbench" ? activeProjectId : "" };
    const currentHash = window.location.hash;
    if (applyingHistoryNavigationRef.current) {
      applyingHistoryNavigationRef.current = false;
      replaceNextNavigationRef.current = false;
      if (currentHash !== hash) {
        window.history.replaceState(state, "", hash);
      }
      currentRouteHashRef.current = hash;
      return;
    }
    const workbenchBaseHash = `#workbench/${tool}`;
    const shouldReplaceCurrentWorkbenchRoute = activeNav === "workbench" && Boolean(activeProjectId) && currentHash === workbenchBaseHash;
    if (currentHash !== hash) {
      if (replaceNextNavigationRef.current || shouldReplaceCurrentWorkbenchRoute) {
        replaceNextNavigationRef.current = false;
        window.history.replaceState(state, "", hash);
        currentRouteHashRef.current = hash;
        return;
      }
      window.history.pushState(state, "", hash);
    } else {
      replaceNextNavigationRef.current = false;
      window.history.replaceState(state, "", hash);
    }
    currentRouteHashRef.current = hash;
  }, [navigationReady, activeNav, activeTool, selectedFeature.id, activeProjectId, modelConfigPanel]);

  const projectRecents = useMemo(
    () => recoverableProjects(recents, workspaceStatus, activeProjectId),
    [recents, workspaceStatus.configured, workspaceStatus.projects, activeProjectId],
  );
  const homeRecents = useMemo(
    () => projectRecents.slice(0, 8),
    [projectRecents],
  );

  const content = useMemo(() => {
    if (activeNav === "models") return <ModelConfigView provider={provider} setProvider={setProvider} asrProvider={asrProvider} setAsrProvider={setAsrProvider} serverStatus={serverStatus} refreshServerStatus={refreshServerStatus} activeConfigPanel={modelConfigPanel} setActiveConfigPanel={setModelConfigPanel} />;
    if (activeNav === "terms") return <TermsView terms={terms} setTerms={setTerms} />;
    if (activeNav === "projects") return <ProjectsView recents={projectRecents} onOpenRecent={openRecentProject} onRenameProject={renameRecentProject} onDeleteProject={deleteRecentProject} onClearProjects={clearRecentProjects} workspaceStatus={workspaceStatus} onOpenSettings={() => requestNavigation("settings", "进入设置")} />;
    if (activeNav === "settings") return <SettingsView provider={provider} setProvider={setProvider} asrProvider={asrProvider} setAsrProvider={setAsrProvider} setTerms={setTerms} workspaceStatus={workspaceStatus} onConfigureWorkspace={handleConfigureWorkspace} onClearProjects={clearRecentProjects} onSelectWorkspaceDirectory={selectLocalWorkspaceDirectory} />;
    if (activeNav === "workbench") {
      return (
        <WorkbenchView
          key={activeTool === "home" ? selectedFeature.id : activeTool}
          activeTool={activeTool === "home" ? selectedFeature.id : activeTool}
          onBackHome={() => {
            if (!requestNavigation("home", "返回首页")) return;
            setActiveTool(selectedFeature.id);
          }}
          rows={rows}
          setRows={setRows}
          media={media}
          setMedia={setMedia}
          workspaceState={workspaceState}
          setWorkspaceState={setWorkspaceState}
          provider={provider}
          asrProvider={asrProvider}
          setAsrProvider={setAsrProvider}
          serverStatus={serverStatus}
          terms={terms}
          addRecent={addRecent}
          updateActiveRecent={updateActiveRecent}
          onOpenModels={(panel = "asr") => {
            setModelConfigPanel(panel === "text" ? "text" : "asr");
            requestNavigation("models", "进入模型配置");
          }}
          workspaceStatus={workspaceStatus}
          workspaceSaveStatus={workspaceSaveStatus}
          onOpenSettings={() => requestNavigation("settings", "进入设置")}
          workspaceNotice={workspaceNotice}
          activeProjectId={activeProjectId}
          activeProjectName={activeProjectName}
          onBusyChange={handleWorkbenchBusyChange}
        />
      );
    }
    return (
      <HomeView
        selectedFeature={selectedFeature}
        setSelectedFeature={setSelectedFeature}
        onOpenWorkbench={openWorkbench}
        recents={homeRecents}
        onViewAllProjects={() => setActiveNav("projects")}
        onOpenRecent={openRecentProject}
        workspaceStatus={workspaceStatus}
        onOpenSettings={() => requestNavigation("settings", "进入设置")}
        onConfigureWorkspace={handleConfigureWorkspace}
        onSelectWorkspaceDirectory={selectLocalWorkspaceDirectory}
      />
    );
  }, [activeNav, activeTool, selectedFeature, homeRecents, projectRecents, provider, asrProvider, serverStatus, terms, rows, media, workspaceState, workspaceStatus, workspaceFeatureId, activeProjectName, activeProjectId, workspaceNotice, workspaceSaveStatus, workbenchBusy, modelConfigPanel]);

  return (
    <div className="app-shell">
      <Sidebar activeNav={activeNav} setActiveNav={(id) => {
        if (!requestNavigation(id, `进入${navItems.find((item) => item.id === id)?.label || "该页面"}`)) return;
        if (id === "workbench" && activeTool === "home") {
          activateWorkspace(selectedFeature.id);
          setActiveTool(selectedFeature.id);
        }
      }} />
      <div className={`content-shell ${activeNav === "workbench" ? "workbench-shell" : ""}`}>{content}</div>
    </div>
  );
}
