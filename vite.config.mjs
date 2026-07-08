import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const ENV_KEY_NAMES = ["MINIMAX_API_KEY"];
const ASR_ENV_KEY_NAMES = ["ASR_API_KEY", "DASHSCOPE_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY"];
const WORKSPACE_CONFIG_FILE = "workspace.local.json";
const LEGACY_WORKSPACE_CONFIG_FILE = ".echo-workspace.local.json";
const MEDIA_STREAM_RANGE_CHUNK_SIZE = 4 * 1024 * 1024;
const DEFAULT_ASR_FETCH_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL_FETCH_TIMEOUT_MS = 120_000;
const localEnvValues = {};
let rivaClientStatusCache = { checkedAt: 0, available: false, error: "尚未检测 NVIDIA Riva SDK。" };

function parseEnvValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readLocalEnv(mode) {
  const filenames = [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
  const result = {};
  for (const filename of filenames) {
    const path = join(process.cwd(), filename);
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      if (![...ENV_KEY_NAMES, ...ASR_ENV_KEY_NAMES].includes(key)) continue;
      result[key] = parseEnvValue(trimmed.slice(separator + 1));
    }
  }
  return result;
}

function refreshLocalEnv(mode) {
  const env = readLocalEnv(mode);
  for (const name of [...ENV_KEY_NAMES, ...ASR_ENV_KEY_NAMES]) {
    if (env[name]) {
      localEnvValues[name] = env[name];
      continue;
    }
    delete localEnvValues[name];
  }
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithAsrTimeout(url, options = {}, timeoutMessage = "云端转写请求超时。") {
  const timeoutMs = positiveIntegerEnv("ECHO_ASR_FETCH_TIMEOUT_MS", DEFAULT_ASR_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithModelTimeout(url, options = {}, timeoutMessage = "文本模型请求超时。") {
  const timeoutMs = positiveIntegerEnv("ECHO_MODEL_FETCH_TIMEOUT_MS", DEFAULT_MODEL_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readJsonBody(req, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON 格式不正确"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function safeProjectId(id = "") {
  const value = String(id).trim();
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(value)) {
    throw new Error("项目 ID 不合法。");
  }
  return value;
}

function safeFileName(name = "media") {
  return basename(String(name || "media")).replace(/[^\w\u4e00-\u9fa5.\-() ]+/g, "_").slice(0, 180) || "media";
}

function workspaceConfigDir() {
  return resolve(String(process.env.ECHO_WORKBENCH_CONFIG_DIR || join(homedir(), ".echo-workbench")));
}

function workspaceConfigPath() {
  return join(workspaceConfigDir(), WORKSPACE_CONFIG_FILE);
}

function legacyWorkspaceConfigPath() {
  return join(process.cwd(), LEGACY_WORKSPACE_CONFIG_FILE);
}

function isTemporaryWorkspaceRoot(root = "") {
  if (!root) return false;
  const normalizedRoot = resolve(root);
  const normalizedTemp = resolve(tmpdir());
  return normalizedRoot === normalizedTemp || normalizedRoot.startsWith(`${normalizedTemp}/`);
}

function readWorkspaceConfig() {
  const path = existsSync(workspaceConfigPath()) ? workspaceConfigPath() : legacyWorkspaceConfigPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.root ? { root: resolve(String(parsed.root)) } : null;
  } catch {
    return null;
  }
}

async function ensureWorkspace(root) {
  await mkdir(join(root, "projects"), { recursive: true });
}

async function configureWorkspace(rootInput) {
  const input = String(rootInput || "").trim();
  if (!input) throw new Error("请选择或输入本地工作区路径。");
  const root = resolve(input);
  await ensureWorkspace(root);
  await mkdir(workspaceConfigDir(), { recursive: true });
  await writeFile(workspaceConfigPath(), JSON.stringify({ root }, null, 2));
  return { root };
}

function selectWorkspaceDirectory() {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("当前运行环境不支持系统目录选择，请手动输入工作区路径。"));
  }
  return new Promise((resolveSelect, reject) => {
    const child = spawn("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择回响工作台本地工作区")',
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "没有选择工作区目录。"));
        return;
      }
      const root = stdout.trim();
      if (!root) {
        reject(new Error("没有选择工作区目录。"));
        return;
      }
      resolveSelect({ root });
    });
  });
}

async function getWorkspaceOrThrow() {
  const config = readWorkspaceConfig();
  if (!config?.root) throw new Error("尚未配置本地工作区。请先在设置页配置。");
  await ensureWorkspace(config.root);
  return config;
}

function projectDir(root, id) {
  return join(root, "projects", safeProjectId(id));
}

async function listWorkspaceProjects(root) {
  const projectsRoot = join(root, "projects");
  if (!existsSync(projectsRoot)) return { projects: [], invalidProjectCount: 0 };
  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const projects = [];
  let invalidProjectCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const content = await readFile(join(projectsRoot, entry.name, "project.json"), "utf8");
      const record = JSON.parse(content);
      if (record?.recent) {
        const rowCount = Array.isArray(record.rows) ? record.rows.length : 0;
        projects.push({
          ...record.recent,
          id: record.id,
          hasWorkspaceCopy: true,
          hasMediaCopy: Boolean(record.media?.fileName),
          hasAsrAudioCopy: Boolean(record.asrAudio?.fileName),
          rowCount,
          recoverableState: rowCount ? "has-results" : record.media?.fileName ? "media-only" : "metadata-only",
          updatedAt: record.updatedAt || 0,
        });
      } else {
        invalidProjectCount += 1;
      }
    } catch {
      invalidProjectCount += 1;
    }
  }
  return {
    projects: projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
    invalidProjectCount,
  };
}

async function saveWorkspaceProject(form) {
  const { root } = await getWorkspaceOrThrow();
  const rawProject = form.get("project");
  if (!rawProject || typeof rawProject !== "string") throw new Error("缺少项目数据。");
  const project = JSON.parse(rawProject);
  return saveWorkspaceProjectRecord(root, project, form);
}

async function saveWorkspaceProjectRecord(root, project, form = null) {
  const id = safeProjectId(project.id);
  const dir = projectDir(root, id);
  await mkdir(dir, { recursive: true });

  const previousPath = join(dir, "project.json");
  let previous = {};
  if (existsSync(previousPath)) {
    try {
      previous = JSON.parse(await readFile(previousPath, "utf8"));
    } catch {
      previous = {};
    }
  }

  let media = previous.media || null;
  const uploaded = form?.get("media");
  if (uploaded && typeof uploaded !== "string") {
    const extension = extname(uploaded.name || "") || extname(project.media?.name || "") || ".media";
    const mediaFileName = `media${extension}`;
    const arrayBuffer = await uploaded.arrayBuffer();
    await writeFile(join(dir, mediaFileName), Buffer.from(arrayBuffer));
    media = {
      ...(project.media || {}),
      name: safeFileName(project.media?.name || uploaded.name || "media"),
      type: project.media?.type || uploaded.type || "",
      size: project.media?.size || uploaded.size || 0,
      duration: project.media?.duration || 0,
      fileName: mediaFileName,
    };
  } else if (project.media === null) {
    media = previous.media || null;
  } else if (project.media && previous.media) {
    media = { ...previous.media, ...project.media };
  } else if (project.media) {
    media = {
      ...project.media,
      name: safeFileName(project.media.name || "media"),
    };
  }

  let asrAudio = previous.asrAudio || null;
  const uploadedAsrAudio = form?.get("asrAudio");
  if (uploadedAsrAudio && typeof uploadedAsrAudio !== "string") {
    const extension = extname(uploadedAsrAudio.name || "") || extname(project.asrAudio?.name || "") || ".audio";
    const audioFileName = `asr-audio${extension}`;
    const arrayBuffer = await uploadedAsrAudio.arrayBuffer();
    await writeFile(join(dir, audioFileName), Buffer.from(arrayBuffer));
    asrAudio = {
      name: safeFileName(project.asrAudio?.name || uploadedAsrAudio.name || "audio-track"),
      type: project.asrAudio?.type || uploadedAsrAudio.type || "",
      size: project.asrAudio?.size || uploadedAsrAudio.size || 0,
      duration: project.asrAudio?.duration || 0,
      fileName: audioFileName,
    };
  } else if (project.asrAudio === null) {
    asrAudio = previous.asrAudio || null;
  } else if (project.asrAudio && previous.asrAudio) {
    asrAudio = { ...previous.asrAudio, ...project.asrAudio };
  } else if (project.asrAudio) {
    asrAudio = {
      ...project.asrAudio,
      name: safeFileName(project.asrAudio.name || "audio-track"),
    };
  }

  const now = Number.isFinite(Number(project.updatedAt)) ? Number(project.updatedAt) : Date.now();
  const record = {
    ...previous,
    id,
    recent: project.recent,
    tool: project.tool,
    rows: Array.isArray(project.rows) ? project.rows : [],
    workspaceState: project.workspaceState || {},
    media,
    asrAudio,
    updatedAt: now,
  };
  await writeFile(previousPath, JSON.stringify(record, null, 2));
  return record;
}

function readEncodedHeader(req, name, fallback = "") {
  const raw = req.headers[name.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return fallback;
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value);
  }
}

async function saveWorkspaceProjectAsset(req, id, field) {
  const { root } = await getWorkspaceOrThrow();
  const safeId = safeProjectId(id);
  const dir = projectDir(root, safeId);
  await mkdir(dir, { recursive: true });

  const headerName = readEncodedHeader(req, "x-echo-file-name", field === "asrAudio" ? "audio-track" : "media");
  const headerType = readEncodedHeader(req, "x-echo-file-type", req.headers["content-type"] || "");
  const headerSize = Number(readEncodedHeader(req, "x-echo-file-size", req.headers["content-length"] || "0"));
  const headerDuration = Number(readEncodedHeader(req, "x-echo-file-duration", "0"));
  const extension = extname(headerName || "") || (field === "asrAudio" ? ".audio" : ".media");
  const fileName = field === "asrAudio" ? `asr-audio${extension}` : `media${extension}`;
  const filePath = join(dir, fileName);

  await pipeline(req, createWriteStream(filePath));
  const fileStat = await stat(filePath);
  return {
    name: safeFileName(headerName),
    type: headerType || "application/octet-stream",
    size: Number.isFinite(headerSize) && headerSize > 0 ? headerSize : fileStat.size,
    duration: Number.isFinite(headerDuration) && headerDuration > 0 ? headerDuration : 0,
    fileName,
  };
}

async function loadWorkspaceProject(id) {
  const { root } = await getWorkspaceOrThrow();
  const safeId = safeProjectId(id);
  const content = await readFile(join(projectDir(root, safeId), "project.json"), "utf8");
  const record = JSON.parse(content);
  return {
    ...record,
    mediaUrl: record.media?.fileName ? `/api/workspace/projects/${encodeURIComponent(safeId)}/media` : "",
    asrAudioUrl: record.asrAudio?.fileName ? `/api/workspace/projects/${encodeURIComponent(safeId)}/asr-audio` : "",
  };
}

async function workspaceProjectFileSource(id, field) {
  const { root } = await getWorkspaceOrThrow();
  const safeId = safeProjectId(id);
  const content = await readFile(join(projectDir(root, safeId), "project.json"), "utf8");
  const record = JSON.parse(content);
  const fileRecord = record[field];
  if (!fileRecord?.fileName) {
    throw new Error(field === "asrAudio" ? "这个项目没有保存补充音频文件。" : "这个项目没有保存媒体文件。");
  }
  const filePath = join(projectDir(root, safeId), fileRecord.fileName);
  return {
    filePath,
    fileName: fileRecord.name || fileRecord.fileName,
    type: fileRecord.type || "application/octet-stream",
    record: fileRecord,
  };
}

async function deleteWorkspaceProject(id) {
  const { root } = await getWorkspaceOrThrow();
  const safeId = safeProjectId(id);
  await rm(projectDir(root, safeId), { recursive: true, force: true });
  const summary = await listWorkspaceProjects(root);
  return {
    ok: true,
    ...summary,
  };
}

function parseByteRange(rangeHeader, fileSize) {
  const value = String(rangeHeader || "").trim();
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || fileSize < 1) return { invalid: true };
  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength < 1) return { invalid: true };
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : Math.min(fileSize - 1, start + MEDIA_STREAM_RANGE_CHUNK_SIZE - 1);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= fileSize) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

async function streamWorkspaceProjectFile(req, res, id, field) {
  const { filePath, record: fileRecord } = await workspaceProjectFileSource(id, field);
  const fileStat = await stat(filePath);
  res.setHeader("Content-Type", fileRecord.type || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");

  const range = parseByteRange(req.headers.range, fileStat.size);
  if (range?.invalid) {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${fileStat.size}`);
    res.end();
    return;
  }

  if (range) {
    const contentLength = range.end - range.start + 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
    res.setHeader("Content-Length", String(contentLength));
    createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Length", String(fileStat.size));
  createReadStream(filePath).pipe(res);
}

function readRequestBuffer(req, maxBytes = 220 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("文件过大。当前开发代理单次最多接收 220MB。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runLocalCommand(command, args, fallbackMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(new Error(`${fallbackMessage}：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || fallbackMessage));
        return;
      }
      resolve();
    });
  });
}

const RIVA_CHUNK_SECONDS = 60;

function rivaCanReadDirectly(fileName = "") {
  return /\.(wav|flac)$/i.test(fileName);
}

function listRivaChunkFiles(tempDir) {
  return readdir(tempDir)
    .then((entries) => entries
      .filter((entry) => /^riva-input-\d+\.wav$/i.test(entry))
      .sort((left, right) => left.localeCompare(right))
      .map((entry) => join(tempDir, entry)));
}

async function prepareRivaAudioInputs({ inputPath, inputName, tempDir }) {
  if (rivaCanReadDirectly(inputName)) return [{ path: inputPath, offset: 0 }];
  const segmentPattern = join(tempDir, "riva-input-%03d.wav");
  await runLocalCommand(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-sample_fmt",
      "s16",
      "-f",
      "segment",
      "-segment_time",
      String(RIVA_CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      segmentPattern,
    ],
    "无法为 NVIDIA Riva 生成兼容音频。请确认系统可用 ffmpeg，或改传 16kHz 单声道 WAV/FLAC 音频",
  );
  const chunks = await listRivaChunkFiles(tempDir);
  if (!chunks.length) throw new Error("无法从媒体中生成可转写音频。请检查视频是否包含音轨，或改传 WAV/FLAC 音频。");
  return chunks.map((path, index) => ({ path, offset: index * RIVA_CHUNK_SECONDS }));
}

async function generateSpeechSample({ outputPath, text, format = "m4a", tempDir = "" }) {
  if (format === "wav") {
    const aiffPath = join(tempDir || tmpdir(), "echo-workbench-test.aiff");
    await runLocalCommand("say", ["-o", aiffPath, text], "无法生成测试语音样本，请手动选择一段清晰音频");
    await runLocalCommand(
      "afconvert",
      ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiffPath, outputPath],
      "无法生成 Riva 兼容 WAV 测试样本，请手动选择 16kHz 单声道 WAV、FLAC 或 OPUS 音频",
    );
    return outputPath;
  }

  await runLocalCommand("say", ["-o", outputPath, text], "无法生成测试语音样本，请手动选择一段清晰音频");
  return outputPath;
}

async function readFormData(req) {
  const buffer = await readRequestBuffer(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const request = new Request("http://localhost", {
    method: req.method,
    headers,
    body: buffer,
  });
  return request.formData();
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) return "";
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Base URL 必须是 http 或 https");
  }
  return url.toString().replace(/\/+$/, "");
}

function resolveApiKey(provider = {}) {
  if (provider.keySource === "env") {
    return ENV_KEY_NAMES.map((name) => process.env[name] || localEnvValues[name]).find(Boolean) || "";
  }
  return String(provider.apiKey || "").trim();
}

function providerAsrEnvKeyNames(provider = {}) {
  const endpoint = String(provider.endpoint || "").toLowerCase();
  const transport = String(provider.transport || "").toLowerCase();
  const names = ["ASR_API_KEY"];
  if (transport === "dashscope-funasr" || endpoint.includes("dashscope.aliyuncs.com")) {
    names.push("DASHSCOPE_API_KEY");
  } else if (endpoint.includes("api.groq.com")) {
    names.push("GROQ_API_KEY");
  } else if (endpoint.includes("api.openai.com")) {
    names.push("OPENAI_API_KEY");
  } else if (transport === "nvidia-riva-grpc" || endpoint.includes("nvidia") || endpoint.includes("nvcf")) {
    names.push("NVIDIA_API_KEY");
  }
  return names;
}

function resolveAsrApiKey(provider = {}) {
  return String(provider.apiKey || "").trim() || providerAsrEnvKeyNames(provider).map((name) => process.env[name] || localEnvValues[name]).find(Boolean) || "";
}

function resolveNvidiaApiKey(provider = {}) {
  return resolveAsrApiKey(provider);
}

function hasEnvApiKey() {
  return ENV_KEY_NAMES.some((name) => Boolean(process.env[name] || localEnvValues[name]));
}

function hasNvidiaEnvApiKey() {
  return ASR_ENV_KEY_NAMES.some((name) => Boolean(process.env[name] || localEnvValues[name]));
}

function asrEnvKeyStatus() {
  return {
    generic: Boolean(process.env.ASR_API_KEY || localEnvValues.ASR_API_KEY),
    dashscope: Boolean(process.env.DASHSCOPE_API_KEY || localEnvValues.DASHSCOPE_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY || localEnvValues.GROQ_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY || localEnvValues.OPENAI_API_KEY),
    nvidia: Boolean(process.env.NVIDIA_API_KEY || localEnvValues.NVIDIA_API_KEY),
  };
}

function asrTestSampleText(languageCode = "", format = "m4a") {
  const code = String(languageCode || "").toLowerCase();
  if (format === "wav" || code.startsWith("en")) {
    return "Echo workbench transcription test. This is a clear speech sample.";
  }
  if (code.startsWith("zh")) {
    return "回响工作台转写测试。视频智能字幕，音频转写。";
  }
  return "Echo workbench transcription test. 回响工作台转写测试。视频智能字幕，音频转写。";
}

function resolveRivaPython() {
  const configured = String(process.env.NVIDIA_RIVA_PYTHON || "").trim();
  if (configured) return configured;
  const localPython = join(process.cwd(), ".venv", "bin", "python");
  return existsSync(localPython) ? localPython : "python3";
}

export function sanitizeNvidiaAsrError(error) {
  const raw = String(error?.message || error || "").trim();
  const clean = raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [hidden]")
    .replace(/nvapi-[A-Za-z0-9._~+/=-]+/g, "nvapi-[hidden]")
    .replace(/sk-[A-Za-z0-9._~+/=-]+/g, "sk-[hidden]");
  const lower = clean.toLowerCase();
  if (/dns|lookup|resolve|could not contact dns|name resolution|grpc\.nvcf/.test(lower)) {
    return "云端转写服务暂时无法解析或连接。系统已保留当前任务，可稍后重试；服务器部署时需要确保运行环境可访问当前 ASR Endpoint。";
  }
  if (/unauth|permission|forbidden|401|403|authorization|authentication/.test(lower)) {
    return "云端转写鉴权失败。当前 Key 无法调用该模型或 Endpoint；需要更换有效 Key 或切换到有权限的转写服务。";
  }
  if (/not found|function id|function-id|endpoint|404/.test(lower)) {
    return "云端转写端点不可用。需要在模型配置中切换预设，或核对 HTTP Endpoint / Riva Function ID。";
  }
  if (/unavailable model requested|language_code|unsupported language|invalid_argument/.test(lower)) {
    return "当前转写配置未通过语言或音频参数校验。系统已阻止启用该配置，并避免写入不完整结果。";
  }
  if (/deadline|timeout|timed out|unavailable|temporarily unavailable/.test(lower)) {
    return "云端转写请求超时或上游暂不可用。系统已保留当前任务，可稍后重试；长音频建议切换更稳定的模型或缩短文件后再试。";
  }
  if (/internal error while making inference request|internal.*inference|inference request/.test(lower)) {
    return "云端转写上游推理请求未完成。系统未写入不完整结果；连续失败时需要切换转写模型或核对当前端点权限。";
  }
  if (/invalid|audio|encoding|sample|format|decode|wav|flac/.test(lower)) {
    return "云端转写服务无法识别当前音频输入。系统已保留媒体且未写入不完整结果；当前配置未通过音频格式校验。";
  }
  if (/dashscope|task_status|transcription_url|oss|policy|upload/.test(lower)) {
    return "百炼转写任务未完成。系统已保留当前任务；连续失败时需要更换 DashScope Key、模型权限、文件格式或网络环境后重试。";
  }
  if (!clean) return "云端转写失败。系统已保留当前任务，可切换转写服务或更换音频文件后重试。";
  return clean.length > 280 ? `${clean.slice(0, 280)}...` : clean;
}

function createAsrPipelineError(stage, message, options = {}) {
  const error = new Error(sanitizeNvidiaAsrError(message));
  error.asrStage = stage || "调用转写服务";
  error.asrCode = options.code || "ASR_STAGE_FAILED";
  error.retryable = options.retryable ?? true;
  if (options.cause) error.cause = options.cause;
  return error;
}

async function withAsrStage(stage, task, options = {}) {
  try {
    return await task();
  } catch (error) {
    if (error?.asrStage) throw error;
    throw createAsrPipelineError(stage, error?.message || error || "转写阶段失败。", { ...options, cause: error });
  }
}

function asrErrorPayload(error, fallbackStage = "调用转写服务") {
  const message = sanitizeNvidiaAsrError(error);
  return {
    error: message,
    stage: error?.asrStage || fallbackStage,
    code: error?.asrCode || "ASR_FAILED",
    retryable: error?.retryable ?? true,
  };
}

function detectRivaClient() {
  const now = Date.now();
  if (now - rivaClientStatusCache.checkedAt < 30_000) return Promise.resolve(rivaClientStatusCache);
  const python = resolveRivaPython();
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", "import riva.client"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rivaClientStatusCache = { checkedAt: Date.now(), available: false, error: "检测 NVIDIA Riva SDK 超时。" };
      resolve(rivaClientStatusCache);
    }, 3000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rivaClientStatusCache = { checkedAt: Date.now(), available: false, error: error.message || "无法启动 Python。" };
      resolve(rivaClientStatusCache);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const cleanError = stderr.includes("ModuleNotFoundError")
        ? "缺少 NVIDIA Riva SDK，请在服务端环境安装 nvidia-riva-client。"
        : (stderr.trim().split(/\r?\n/).at(-1) || "缺少 NVIDIA Riva SDK。");
      rivaClientStatusCache = {
        checkedAt: Date.now(),
        available: code === 0,
        error: code === 0 ? "" : cleanError,
      };
      resolve(rivaClientStatusCache);
    });
  });
}

async function forwardOpenAICompatible(path, provider, payload, method = "POST") {
  const baseUrl = normalizeBaseUrl(provider.baseUrl || "https://api.minimaxi.com/v1");
  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    throw new Error("缺少 API Key。请在模型配置中填写，或在本地服务环境中设置 MINIMAX_API_KEY。");
  }

  const response = await fetchWithModelTimeout(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(payload),
  }, method === "GET" ? "读取模型列表超时。" : "文本模型请求超时。");

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `上游请求失败：${response.status}`;
    throw new Error(message);
  }
  return data;
}

function isMiniMaxChatProvider(provider = {}) {
  try {
    const hostname = new URL(provider.baseUrl || "https://api.minimaxi.com/v1").hostname;
    return /(^|\.)minimax\.io$|(^|\.)minimaxi\.com$/.test(hostname);
  } catch {
    return false;
  }
}

export function buildChatCompletionPayload({ provider = {}, messages = [], temperature = 0.3, max_completion_tokens = 1200 } = {}) {
  const model = provider.model || "MiniMax-M3";
  const payload = {
    model,
    messages,
    temperature,
    max_completion_tokens,
    stream: false,
  };
  if (isMiniMaxChatProvider(provider) && /^MiniMax-M/i.test(model)) {
    payload.reasoning_split = true;
    if (/^MiniMax-M3/i.test(model)) {
      payload.thinking = { type: "disabled" };
    }
  }
  return payload;
}

function normalizedAsrLanguage(languageCode, { allowMulti = false } = {}) {
  const value = String(languageCode || "").trim();
  if (!value || value === "auto" || value === "自动识别") return "";
  if (value === "multi") return allowMulti ? "multi" : "";
  return value;
}

function supportsVerboseJsonTranscription({ endpoint, model }) {
  const target = String(endpoint || "").toLowerCase();
  const modelId = String(model || "").toLowerCase();
  return target.includes("/audio/transcriptions") && (
    modelId === "whisper-1"
    || modelId.includes("whisper")
  );
}

function objectMessage(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return value.message || value.error || value.detail || "";
  return String(value);
}

function responseErrorMessage(data = {}) {
  return objectMessage(data.error)
    || objectMessage(data.detail)
    || objectMessage(data.message)
    || objectMessage(data.output?.error)
    || objectMessage(data.output?.message)
    || objectMessage(data.data?.error)
    || objectMessage(data.data?.message)
    || "";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const clean = value.trim();
    if (clean) return clean;
  }
  return "";
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeGenericAsrResponse(data = {}, provider = "nvidia-http") {
  const output = data.output && typeof data.output === "object" ? data.output : {};
  const nestedData = data.data && typeof data.data === "object" ? data.data : {};
  const text = firstString(
    data.text,
    data.transcript,
    data.transcription,
    output.text,
    output.transcript,
    output.transcription,
    nestedData.text,
    nestedData.transcript,
    nestedData.transcription,
  );
  const segments = firstArray(
    data.segments,
    data.results,
    data.chunks,
    data.sentences,
    output.segments,
    output.results,
    output.chunks,
    output.sentences,
    nestedData.segments,
    nestedData.results,
    nestedData.chunks,
    nestedData.sentences,
  );
  const words = firstArray(data.words, output.words, nestedData.words);
  return { text, segments, words, provider };
}

function assertUsableAsrResult(result = {}, context = "云端 ASR") {
  const hasText = Boolean(String(result.text || result.transcript || "").trim());
  const hasSegments = Array.isArray(result.segments) && result.segments.some((segment) => String(segment?.text || segment?.transcript || segment?.sentence || "").trim());
  const hasWords = Array.isArray(result.words) && result.words.some((word) => String(word?.word || word?.text || word?.token || "").trim());
  if (!hasText && !hasSegments && !hasWords) {
    throw new Error(`${context}未返回可用转写文本。`);
  }
  return result;
}

function runPythonAsr({ apiKey, filePath, functionId, endpoint, languageCode, translate }) {
  const scriptPath = join(process.cwd(), "scripts", "nvidia_riva_asr.py");
  const python = resolveRivaPython();
  const args = [
    scriptPath,
    "--file",
    filePath,
    "--function-id",
    functionId,
    "--server",
    endpoint || "grpc.nvcf.nvidia.com:443",
    "--language-code",
    languageCode || "multi",
  ];
  if (translate) args.push("--translate");

  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      env: { ...process.env, NVIDIA_API_KEY: apiKey },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("NVIDIA ASR 请求超时。"));
    }, 180_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let data = {};
      try {
        data = stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)) : {};
      } catch {
        data = {};
      }
      if (code !== 0 || data.error) {
        reject(new Error(sanitizeNvidiaAsrError(data.error || stderr.trim() || "NVIDIA ASR 调用失败。")));
        return;
      }
      resolve(data);
    });
  });
}

async function callNvidiaHttpAsr({ apiKey, endpoint, model, languageCode, file, fileName, sendModel = false }) {
  const form = new FormData();
  if (sendModel && model) form.set("model", model);
  const normalizedLanguage = normalizedAsrLanguage(languageCode, { allowMulti: !sendModel });
  if (normalizedLanguage) form.set("language", normalizedLanguage);
  if (supportsVerboseJsonTranscription({ endpoint, model })) {
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
  }
  form.set("file", new File([file], fileName || "audio.wav"));
  const response = await fetchWithAsrTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  }, "HTTP 转写端点请求超时。");
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  const upstreamError = responseErrorMessage(data)
    || (String(data.status || data.output?.status || "").toLowerCase() === "error" ? "云端 ASR 返回错误状态。" : "");
  if (!response.ok) {
    const message = upstreamError || `云端 ASR 请求失败：${response.status}`;
    throw new Error(sanitizeNvidiaAsrError(message));
  }
  if (upstreamError) throw new Error(sanitizeNvidiaAsrError(upstreamError));
  return assertUsableAsrResult(normalizeGenericAsrResponse(data, "nvidia-http"), "HTTP 转写端点");
}

function dashScopeBaseUrl(endpoint) {
  return normalizeBaseUrl(endpoint || "https://dashscope.aliyuncs.com/api/v1");
}

function normalizedDashScopeLanguage(languageCode) {
  const value = normalizedAsrLanguage(languageCode, { allowMulti: false }).toLowerCase();
  if (!value) return "";
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("en")) return "en";
  if (value.startsWith("ja") || value.startsWith("jp")) return "ja";
  if (value.startsWith("ko")) return "ko";
  if (value.startsWith("es")) return "es";
  return value.split("-")[0];
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.message || data?.error?.message || data?.error || data?.raw || fallbackMessage;
    throw new Error(message);
  }
  return data;
}

function getDashScopeOutput(data = {}) {
  return data.output || data.data?.output || data;
}

function extractDashScopeTaskId(data = {}) {
  const output = getDashScopeOutput(data);
  return output.task_id || output.taskId || data.task_id || data.taskId || "";
}

function extractDashScopeStatus(data = {}) {
  const output = getDashScopeOutput(data);
  return String(output.task_status || output.taskStatus || data.task_status || data.status || "").toUpperCase();
}

function extractDashScopeTranscriptionUrl(data = {}) {
  const output = getDashScopeOutput(data);
  const results = output.results || data.results || [];
  const firstResult = Array.isArray(results) ? results[0] : results;
  const singleResult = output.result || data.result || {};
  return firstResult?.transcription_url
    || firstResult?.transcriptionUrl
    || singleResult?.transcription_url
    || singleResult?.transcriptionUrl
    || output.transcription_url
    || output.transcriptionUrl
    || data.transcription_url
    || data.transcriptionUrl
    || "";
}

function normalizeDashScopeTranscription(data = {}) {
  const transcripts = Array.isArray(data.transcripts)
    ? data.transcripts
    : Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.output?.transcripts)
        ? data.output.transcripts
        : [];
  const sentences = [];
  let text = "";
  for (const transcript of transcripts) {
    const transcriptText = String(transcript.text || transcript.transcript || "").trim();
    if (transcriptText) text += `${text ? "\n" : ""}${transcriptText}`;
    const sourceSentences = transcript.sentences || transcript.sentence || [];
    if (!Array.isArray(sourceSentences)) continue;
    for (const sentence of sourceSentences) {
      const startMs = Number(sentence.begin_time ?? sentence.start_time ?? sentence.start ?? 0);
      const endMs = Number(sentence.end_time ?? sentence.end ?? sentence.stop_time ?? startMs);
      const sentenceText = String(sentence.text || sentence.sentence || "").trim();
      if (!sentenceText) continue;
      sentences.push({
        start: Number.isFinite(startMs) ? startMs / 1000 : 0,
        end: Number.isFinite(endMs) ? endMs / 1000 : 0,
        speaker: sentence.speaker_id || sentence.speaker || "S1",
        text: sentenceText,
        words: Array.isArray(sentence.words) ? sentence.words : [],
      });
    }
  }
  if (!text) text = String(data.text || data.transcript || "").trim();
  return assertUsableAsrResult({
    text,
    segments: sentences,
    words: [],
    provider: "dashscope-funasr",
  }, "百炼转写结果");
}

async function getDashScopeUploadPolicy({ apiKey, baseUrl, model }) {
  const url = `${baseUrl}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`;
  const response = await fetchWithAsrTimeout(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  }, "获取百炼上传凭证超时。");
  const data = await readJsonResponse(response, "获取百炼临时上传策略失败。");
  const policy = data.data || data.output || data;
  if (!policy.upload_host || !policy.upload_dir || !policy.policy || !policy.signature || !policy.oss_access_key_id) {
    throw new Error("百炼临时上传策略缺少必要字段。");
  }
  return policy;
}

async function uploadDashScopeFile({ policy, file, fileName }) {
  const objectKey = `${String(policy.upload_dir).replace(/\/?$/, "/")}${safeFileName(fileName || "media")}`;
  const form = new FormData();
  form.set("OSSAccessKeyId", policy.oss_access_key_id);
  form.set("Signature", policy.signature);
  form.set("policy", policy.policy);
  form.set("x-oss-object-acl", policy.x_oss_object_acl || "private");
  form.set("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite || "true");
  form.set("key", objectKey);
  form.set("success_action_status", "200");
  form.set("file", new File([file], safeFileName(fileName || "media")));
  const response = await fetchWithAsrTimeout(policy.upload_host, {
    method: "POST",
    body: form,
  }, "上传媒体到百炼临时存储超时。");
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `上传百炼临时文件失败：${response.status}`);
  }
  return `oss://${objectKey}`;
}

function usesDashScopeSingleFileInput(model) {
  return /qwen.*asr.*filetrans|filetrans/i.test(String(model || ""));
}

function buildDashScopeTranscriptionParameters({ model, languageCode }) {
  const language = normalizedDashScopeLanguage(languageCode);
  if (usesDashScopeSingleFileInput(model)) {
    const parameters = { enable_itn: true };
    if (language) parameters.language = language;
    return parameters;
  }
  const parameters = {
    channel_id: [0],
    punctuation_prediction_enabled: true,
    inverse_text_normalization_enabled: true,
    timestamp_alignment_enabled: true,
  };
  if (language) parameters.language_hints = [language];
  return parameters;
}

async function submitDashScopeTranscription({ apiKey, baseUrl, model, ossUrl, languageCode }) {
  const usesSingleFileInput = usesDashScopeSingleFileInput(model);
  const parameters = buildDashScopeTranscriptionParameters({ model, languageCode });
  const response = await fetchWithAsrTimeout(`${baseUrl}/services/audio/asr/transcription`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model,
      input: usesSingleFileInput ? { file_url: ossUrl } : { file_urls: [ossUrl] },
      parameters,
    }),
  }, "提交百炼转写任务超时。");
  const data = await readJsonResponse(response, "提交百炼转写任务失败。");
  const taskId = extractDashScopeTaskId(data);
  if (!taskId) throw new Error("百炼转写任务未返回 task_id。");
  return taskId;
}

async function pollDashScopeTask({ apiKey, baseUrl, taskId, timeoutMs = 300_000 }) {
  const startedAt = Date.now();
  let lastData = null;
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetchWithAsrTimeout(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
      },
    }, "查询百炼转写任务超时。");
    const data = await readJsonResponse(response, "查询百炼转写任务失败。");
    lastData = data;
    const status = extractDashScopeStatus(data);
    if (status === "SUCCEEDED") return data;
    if (["FAILED", "CANCELED", "UNKNOWN"].includes(status)) {
      const output = getDashScopeOutput(data);
      throw new Error(output.message || output.task_metrics?.failed || `百炼转写任务失败：${status}`);
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 2500));
  }
  throw new Error(`百炼转写任务超时。${lastData ? `最后状态：${extractDashScopeStatus(lastData) || "处理中"}` : ""}`);
}

async function callDashScopeFunAsr({ apiKey, endpoint, model, languageCode, file, fileName }) {
  if (!model) throw new Error("缺少百炼 ASR 模型名称。");
  const baseUrl = dashScopeBaseUrl(endpoint);
  const policy = await withAsrStage("获取百炼上传凭证", () => getDashScopeUploadPolicy({ apiKey, baseUrl, model }));
  const ossUrl = await withAsrStage("上传媒体到百炼临时存储", () => uploadDashScopeFile({ policy, file, fileName }));
  const taskId = await withAsrStage("提交百炼转写任务", () => submitDashScopeTranscription({ apiKey, baseUrl, model, ossUrl, languageCode }));
  const taskData = await withAsrStage("等待百炼转写结果", () => pollDashScopeTask({ apiKey, baseUrl, taskId }));
  const transcriptionUrl = extractDashScopeTranscriptionUrl(taskData);
  if (!transcriptionUrl) throw new Error("百炼转写任务未返回 transcription_url。");
  const resultData = await withAsrStage("读取百炼转写结果", async () => {
    const resultResponse = await fetchWithAsrTimeout(transcriptionUrl, {}, "读取百炼转写结果超时。");
    return readJsonResponse(resultResponse, "读取百炼转写结果失败。");
  });
  return withAsrStage("读取百炼转写结果", () => normalizeDashScopeTranscription(resultData));
}

function offsetRivaTimingItems(items = [], offset = 0) {
  if (!offset || !Array.isArray(items)) return items || [];
  return items.map((item) => ({
    ...item,
    start: Number(item.start || 0) + offset,
    end: Number(item.end || 0) + offset,
  }));
}

function mergeRivaChunkResults(results = []) {
  const text = results.map((item) => String(item.result?.text || "").trim()).filter(Boolean).join(" ").trim();
  const words = results.flatMap((item) => offsetRivaTimingItems(item.result?.words, item.offset));
  const segments = words.length ? [] : results
    .map((item, index) => {
      const chunkText = String(item.result?.text || "").trim();
      if (!chunkText) return null;
      return {
        start: item.offset,
        end: item.offset + RIVA_CHUNK_SECONDS,
        text: chunkText,
        speaker: "未标注",
        id: `riva-chunk-${index}`,
      };
    })
    .filter(Boolean);
  return { text, words, segments, provider: "nvidia-riva" };
}

export async function transcribeWithNvidia({ provider, file, fileName }) {
  const apiKey = resolveNvidiaApiKey(provider);
  if (!apiKey) {
    throw createAsrPipelineError("读取转写配置", "缺少 ASR API Key。请先在模型配置中填写转写服务 Key。", { code: "ASR_MISSING_KEY", retryable: false });
  }
  const transport = provider.transport || "nvidia-riva-grpc";
  const languageCode = provider.languageCode || "multi";

  if (transport === "dashscope-funasr") {
    try {
      return await callDashScopeFunAsr({ apiKey, endpoint: provider.endpoint, model: provider.model || "fun-asr", languageCode, file, fileName });
    } catch (error) {
      if (error?.asrStage) throw error;
      throw createAsrPipelineError("调用百炼转写服务", error?.message || error || "百炼转写失败。");
    }
  }

  if (transport === "nvidia-http") {
    if (!provider.endpoint) throw createAsrPipelineError("读取转写配置", "缺少 HTTP 转写端点。", { code: "ASR_MISSING_ENDPOINT", retryable: false });
    if (provider.sendModel && !provider.model) {
      throw createAsrPipelineError("读取转写配置", "缺少 ASR 模型名称。OpenAI-compatible 转写端点需要填写模型。", { code: "ASR_MISSING_MODEL", retryable: false });
    }
    return withAsrStage("调用 HTTP 转写端点", () => callNvidiaHttpAsr({ apiKey, endpoint: provider.endpoint, model: provider.model, languageCode, file, fileName, sendModel: Boolean(provider.sendModel) }));
  }

  if (!provider.functionId) throw createAsrPipelineError("读取转写配置", "缺少 NVIDIA Riva function id。", { code: "ASR_MISSING_FUNCTION_ID", retryable: false });
  const rivaClientStatus = await detectRivaClient();
  if (!rivaClientStatus.available) {
    throw createAsrPipelineError("检测 Riva 依赖", rivaClientStatus.error || "缺少 NVIDIA Riva SDK。", { code: "ASR_RIVA_DEPENDENCY_MISSING", retryable: false });
  }
  const tempDir = await mkdtemp(join(tmpdir(), "echo-asr-"));
  const extension = extname(fileName || "") || ".wav";
  const filePath = join(tempDir, `input${extension}`);
  try {
    await writeFile(filePath, file);
    const rivaInputs = await withAsrStage("准备 Riva 音频输入", () => prepareRivaAudioInputs({ inputPath: filePath, inputName: fileName || `input${extension}`, tempDir }));
    const results = [];
    for (const input of rivaInputs) {
      const result = await withAsrStage("调用 NVIDIA Riva 转写", () => runPythonAsr({
        apiKey,
        filePath: input.path,
        functionId: provider.functionId,
        endpoint: provider.endpoint,
        languageCode,
        translate: Boolean(provider.translate),
      }));
      results.push({ offset: input.offset, result });
    }
    return mergeRivaChunkResults(results);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function registerLocalApi(middlewares, mode) {
  middlewares.use("/api/workspace/status", async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const config = readWorkspaceConfig();
          const root = config?.root || "";
          const configured = Boolean(root && existsSync(root));
          const summary = configured ? await listWorkspaceProjects(root) : { projects: [], invalidProjectCount: 0 };
          sendJson(res, 200, {
            configured,
            root,
            temporaryRoot: configured ? isTemporaryWorkspaceRoot(root) : false,
            suggestedRoot: "",
            ...summary,
          });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });

  middlewares.use("/api/workspace/select-directory", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          sendJson(res, 200, await selectWorkspaceDirectory());
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });

  middlewares.use("/api/workspace/configure", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const config = await configureWorkspace(body.root);
          const summary = await listWorkspaceProjects(config.root);
          sendJson(res, 200, { configured: true, root: config.root, temporaryRoot: isTemporaryWorkspaceRoot(config.root), suggestedRoot: "", ...summary });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });

  middlewares.use("/api/workspace/clear", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          const { root } = await getWorkspaceOrThrow();
          await rm(join(root, "projects"), { recursive: true, force: true });
          await ensureWorkspace(root);
          sendJson(res, 200, { ok: true, projects: [], invalidProjectCount: 0 });
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });

  middlewares.use("/api/workspace/projects", async (req, res, next) => {
        try {
          const url = new URL(req.url || "", "http://localhost");
          const parts = url.pathname.split("/").filter(Boolean);
          const id = parts[0] ? decodeURIComponent(parts[0]) : "";
          const action = parts[1] || "";

          if (!id && req.method === "POST") {
            const contentType = String(req.headers["content-type"] || "");
            let record;
            if (contentType.includes("application/json")) {
              const { root } = await getWorkspaceOrThrow();
              const project = await readJsonBody(req);
              record = await saveWorkspaceProjectRecord(root, project);
            } else {
              const form = await readFormData(req);
              record = await saveWorkspaceProject(form);
            }
            sendJson(res, 200, {
              ok: true,
              project: {
                ...record,
                mediaUrl: record.media?.fileName ? `/api/workspace/projects/${encodeURIComponent(record.id)}/media` : "",
                asrAudioUrl: record.asrAudio?.fileName ? `/api/workspace/projects/${encodeURIComponent(record.id)}/asr-audio` : "",
              },
            });
            return;
          }

          if (id && (action === "media" || action === "asr-audio") && req.method === "PUT") {
            const field = action === "asr-audio" ? "asrAudio" : "media";
            const asset = await saveWorkspaceProjectAsset(req, id, field);
            sendJson(res, 200, { ok: true, [field]: asset });
            return;
          }

          if (id && !action && req.method === "GET") {
            sendJson(res, 200, { project: await loadWorkspaceProject(id) });
            return;
          }

          if (id && !action && req.method === "DELETE") {
            sendJson(res, 200, await deleteWorkspaceProject(id));
            return;
          }

          if (id && action === "media" && req.method === "GET") {
            await streamWorkspaceProjectFile(req, res, id, "media");
            return;
          }

          if (id && action === "asr-audio" && req.method === "GET") {
            await streamWorkspaceProjectFile(req, res, id, "asrAudio");
            return;
          }

          next();
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });

  middlewares.use("/api/provider-status", async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        refreshLocalEnv(mode);
        const rivaClientStatus = await detectRivaClient();
        sendJson(res, 200, {
          envKeyConfigured: hasEnvApiKey(),
          asrEnvKeys: asrEnvKeyStatus(),
          asrEnvKeyConfigured: hasNvidiaEnvApiKey(),
          nvidiaEnvKeyConfigured: hasNvidiaEnvApiKey(),
          defaultBaseUrl: "https://api.minimaxi.com/v1",
          defaultModel: "MiniMax-M3",
          rivaClientAvailable: rivaClientStatus.available,
          rivaClientError: rivaClientStatus.error,
        });
      });

  middlewares.use("/api/asr/test-sample", async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        let tempDir = "";
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const format = url.searchParams.get("format") === "wav" ? "wav" : "m4a";
          tempDir = await mkdtemp(join(tmpdir(), "echo-asr-test-sample-"));
          const sampleName = format === "wav" ? "echo-workbench-test.wav" : "echo-workbench-test.m4a";
          const samplePath = join(tempDir, sampleName);
          await generateSpeechSample({
            outputPath: samplePath,
            text: asrTestSampleText(url.searchParams.get("language"), format),
            format,
            tempDir,
          });
          const sample = await readFile(samplePath);
          res.statusCode = 200;
          res.setHeader("Content-Type", format === "wav" ? "audio/wav" : "audio/mp4");
          res.setHeader("Content-Disposition", `attachment; filename="${sampleName}"`);
          res.end(sample);
        } catch (error) {
          sendJson(res, 400, { error: error.message || "生成测试样本失败。" });
        } finally {
          if (tempDir) {
            await rm(tempDir, { recursive: true, force: true }).catch(() => {});
          }
        }
      });

  middlewares.use("/api/asr/transcribe-workspace", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          refreshLocalEnv(mode);
          const body = await withAsrStage("读取转写请求", () => readJsonBody(req), { retryable: false });
          const field = body.field === "asrAudio" ? "asrAudio" : "media";
          const { filePath, fileName } = await withAsrStage("读取本地工作区媒体", () => workspaceProjectFileSource(body.projectId, field), { retryable: false });
          const result = await transcribeWithNvidia({
            provider: body.provider || {},
            file: await withAsrStage("读取本地工作区媒体", () => readFile(filePath), { retryable: false }),
            fileName: fileName || "media",
          });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, asrErrorPayload(error));
        }
      });

  middlewares.use("/api/asr/transcribe", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          refreshLocalEnv(mode);
          const form = await withAsrStage("读取上传媒体", () => readFormData(req), { retryable: false });
          const uploaded = form.get("file");
          if (!uploaded || typeof uploaded === "string") {
            throw createAsrPipelineError("读取上传媒体", "请先上传音频或视频文件。", { code: "ASR_MISSING_INPUT", retryable: false });
          }
          const providerRaw = form.get("provider");
          const provider = providerRaw
            ? await withAsrStage("读取转写配置", async () => JSON.parse(String(providerRaw)), { retryable: false })
            : {};
          const arrayBuffer = await withAsrStage("读取上传媒体", () => uploaded.arrayBuffer(), { retryable: false });
          const result = await transcribeWithNvidia({
            provider,
            file: Buffer.from(arrayBuffer),
            fileName: uploaded.name || "media.wav",
          });
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 400, asrErrorPayload(error));
        }
      });

  middlewares.use("/api/models", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          refreshLocalEnv(mode);
          const body = await readJsonBody(req);
          const data = await forwardOpenAICompatible("/models", body.provider, undefined, "GET");
          sendJson(res, 200, data);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });

  middlewares.use("/api/chat", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }
        try {
          refreshLocalEnv(mode);
          const body = await readJsonBody(req);
          const provider = body.provider || {};
          const data = await forwardOpenAICompatible("/chat/completions", provider, buildChatCompletionPayload({
            provider,
            messages: body.messages || [],
            temperature: body.temperature ?? 0.3,
            max_completion_tokens: body.max_completion_tokens ?? 1200,
          }));
          sendJson(res, 200, data);
        } catch (error) {
          sendJson(res, 400, { error: error.message });
        }
      });
}

function localApiPlugin(mode) {
  return {
    name: "echo-workbench-local-api",
    configureServer(server) {
      registerLocalApi(server.middlewares, mode);
    },
    configurePreviewServer(server) {
      registerLocalApi(server.middlewares, mode);
    },
  };
}

export default defineConfig(({ mode }) => {
  refreshLocalEnv(mode);
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    plugins: [react(), localApiPlugin(mode)],
  };
});
