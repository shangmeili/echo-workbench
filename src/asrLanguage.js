const WHISPER_LANGUAGE_CODES = {
  中文: "zh",
  英文: "en",
  日文: "ja",
  韩文: "ko",
  西班牙文: "es",
};

const LOCALE_LANGUAGE_CODES = {
  中文: "zh-CN",
  英文: "en-US",
  日文: "ja-JP",
  韩文: "ko-KR",
  西班牙文: "es-ES",
};

const ENGLISH_ONLY_MODELS = new Set([
  "parakeet-tdt-0.6b-v2",
  "parakeet-ctc-1.1b-asr",
  "canary-1b-asr",
]);

const HOSTED_RIVA_ENGLISH_PREFERRED_MODELS = new Set([
  "parakeet-1.1b-rnnt-multilingual-asr",
  "canary-1b-asr",
]);

export function getAsrLanguageCode(asrProvider = {}, sourceLanguage = "") {
  if (!sourceLanguage || sourceLanguage === "自动识别") return asrProvider.languageCode || "multi";
  if (ENGLISH_ONLY_MODELS.has(asrProvider.model) && sourceLanguage !== "英文") {
    return asrProvider.languageCode || "en-US";
  }
  if (asrProvider.transport === "nvidia-riva-grpc" && HOSTED_RIVA_ENGLISH_PREFERRED_MODELS.has(asrProvider.model) && sourceLanguage !== "英文") {
    return asrProvider.languageCode || "multi";
  }
  if (asrProvider.model === "whisper-large-v3") {
    return WHISPER_LANGUAGE_CODES[sourceLanguage] || asrProvider.languageCode || "multi";
  }
  return LOCALE_LANGUAGE_CODES[sourceLanguage] || asrProvider.languageCode || "multi";
}

export function getAsrLanguageCompatibilityWarning(asrProvider = {}, sourceLanguage = "") {
  if (!sourceLanguage || sourceLanguage === "自动识别") return "";
  if (ENGLISH_ONLY_MODELS.has(asrProvider.model) && sourceLanguage !== "英文") {
    return "当前转写模型偏英文；中文、日文、韩文或西班牙文素材建议切换到明确支持对应语言的 HTTP 转写端点。";
  }
  if (asrProvider.transport === "nvidia-riva-grpc" && HOSTED_RIVA_ENGLISH_PREFERRED_MODELS.has(asrProvider.model) && sourceLanguage !== "英文") {
    return "NVIDIA 托管 Riva 预设已验证为英文优先；中文素材建议使用支持中文的 HTTP audio transcription 端点。";
  }
  return "";
}
