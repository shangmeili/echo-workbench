export const ASR_CHUNK_SECONDS = 180;

export function isAsrReadyAudioFile(file) {
  const name = file?.name || "";
  const type = file?.type || "";
  return /\.(wav|flac)$/i.test(name) || ["audio/wav", "audio/x-wav", "audio/flac", "audio/x-flac"].includes(type);
}

export function isOpenAICompatibleAsr(asrProvider = {}) {
  return (asrProvider.transport || "nvidia-http") === "nvidia-http" && asrProvider.sendModel !== false;
}

export function isRivaGrpcAsr(asrProvider = {}) {
  return (asrProvider.transport || "") === "nvidia-riva-grpc";
}

export function isDashScopeFunAsr(asrProvider = {}) {
  return (asrProvider.transport || "") === "dashscope-funasr";
}

export function shouldSubmitOriginalVideoForAsr(asrProvider = {}) {
  return isDashScopeFunAsr(asrProvider) || (isOpenAICompatibleAsr(asrProvider) && asrProvider.videoInputMode === "original");
}

export function shouldSubmitOriginalMediaForAsr(file, asrProvider = {}, duration = 0) {
  if (!file) return false;
  if (isRivaGrpcAsr(asrProvider) && file.type?.startsWith("video")) return true;
  if (isDashScopeFunAsr(asrProvider)) return Boolean(file.type?.startsWith("video") || file.type?.startsWith("audio"));
  if (!isOpenAICompatibleAsr(asrProvider)) return false;
  if (file.type?.startsWith("video")) return shouldSubmitOriginalVideoForAsr(asrProvider);
  if (file.type?.startsWith("audio")) return (Number(duration) || 0) <= ASR_CHUNK_SECONDS;
  return false;
}

export function shouldDecodeMediaForAsr(file, asrProvider = {}, duration = 0) {
  if (!file || shouldSubmitOriginalMediaForAsr(file, asrProvider, duration)) return false;
  if (file.type?.startsWith("video")) return true;
  return file.type?.startsWith("audio") && !isAsrReadyAudioFile(file);
}
