import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { detectTranscriptionQualityIssue, rowsFromAsrResult, transcriptWeight } from "../src/asrRows.js";
import { getSubtitleQualityHints, repairReviewStructure, repairReviewStructurePreservingEmpty } from "../src/reviewRows.js";

function usage() {
  return [
    "Usage:",
    "  ASR_API_KEY=... npm run test:asr-live -- --file /path/to/sample.wav [--expect 关键词]",
    "  DASHSCOPE_API_KEY=... npm run test:asr-live -- --file /path/to/sample.mp4 --duration 120 --min-rows 4 --min-chars 80",
    "  DASHSCOPE_API_KEY=... npm run test:asr-live -- --generate-sample --sample-profile zh --expect 回响工作台",
    "",
    "Options:",
    "  --file <path>          Required. Real audio/video sample to transcribe.",
    "  --expect <text>        Optional. Text or regex that should appear in transcript.",
    "  --language <code>      Optional. ASR language code. Default: zh.",
    "  --transport <name>     Optional. dashscope-funasr | nvidia-http | nvidia-riva-grpc. Default: dashscope-funasr.",
    "  --endpoint <url>       Optional. ASR endpoint. Default: DashScope China endpoint.",
    "  --model <name>         Optional. ASR model. Default: fun-asr.",
    "  --function-id <id>     Optional. NVIDIA hosted Riva function id for nvidia-riva-grpc.",
    "  --duration <seconds>   Optional. Media duration for fallback time-axis checks.",
    "  --min-rows <number>    Optional. Minimum editable rows after normalization. Default: 1.",
    "  --min-chars <number>   Optional. Minimum transcript weight. Default: 1.",
    "  --generate-sample      Optional. Generate a short local speech sample with macOS say when --file is omitted.",
    "  --sample-profile <name> Optional. zh | en. Defaults to zh for DashScope and en for NVIDIA Riva.",
    "  --sample-text <text>   Optional. Text for --generate-sample. Default includes 回响工作台.",
    "  --sample-voice <name>  Optional. macOS say voice name.",
    "  --help                 Show this message.",
  ].join("\n");
}

function parseArgs(argv) {
  const defaultDashScopeEndpoint = "https://dashscope.aliyuncs.com/api/v1";
  const args = {
    file: "",
    expect: "",
    language: "zh",
    transport: "dashscope-funasr",
    endpoint: defaultDashScopeEndpoint,
    model: "fun-asr",
    "function-id": "",
    duration: "0",
    "min-rows": "1",
    "min-chars": "1",
    "generate-sample": false,
    "sample-profile": "",
    "sample-text": "回响工作台转写测试。视频智能字幕，音频转写，字幕文件翻译。",
    "sample-voice": "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    if (item === "--generate-sample") {
      args["generate-sample"] = true;
      continue;
    }
    if (item.startsWith("--")) {
      const key = item.slice(2);
      if (!(key in args)) throw new Error(`Unknown option: ${item}`);
      if (typeof args[key] === "boolean") {
        args[key] = true;
        continue;
      }
      args[key] = argv[index + 1] || "";
      index += 1;
    }
  }
  if (args.transport === "nvidia-riva-grpc") {
    if (args.endpoint === defaultDashScopeEndpoint) args.endpoint = "grpc.nvcf.nvidia.com:443";
    if (args.model === "fun-asr") args.model = "whisper-large-v3";
    if (!args["function-id"]) args["function-id"] = "b702f636-f60c-4a3d-a6f4-f3568c13bd7d";
    if (args.language === "zh") args.language = "en-US";
  }
  return args;
}

function contentTypeForFile(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".flac") return "audio/flac";
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

function generateSpeechSample({ outputPath, text, voice }) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (voice) args.push("-v", voice);
    args.push("-o", outputPath, text);
    const child = spawn("say", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(new Error(`无法生成测试语音样本：${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "无法生成测试语音样本。请改用 --file 指定真实音频。"));
        return;
      }
      resolve(outputPath);
    });
  });
}

async function waitForServer({ server, baseUrl, stderrRef }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server.exitCode !== null && server.exitCode !== undefined) {
      throw new Error(`Vite live-ASR server exited before ready: ${stderrRef.value.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/workspace/status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite live-ASR server did not become ready.${stderrRef.value.trim() ? ` ${stderrRef.value.trim()}` : ""}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      finish();
    }, 2500);
  });
}

function collectText(result) {
  return String(
    result.text
    || result.transcript
    || result.transcription
    || result.segments?.map?.((segment) => segment.text || segment.transcript || segment.sentence || "").filter(Boolean).join("\n")
    || "",
  ).trim();
}

function assertExpectedText(transcript, expected) {
  if (!expected) return;
  if (expected.startsWith("/") && expected.endsWith("/") && expected.length > 2) {
    assert.match(transcript, new RegExp(expected.slice(1, -1)));
    return;
  }
  assert.ok(
    transcript.toLowerCase().includes(expected.toLowerCase()),
    `Transcript did not include expected text: ${expected}. Preview: ${transcript.slice(0, 240)}`,
  );
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function sourceLanguageLabel(languageCode) {
  if (languageCode === "zh" || languageCode === "zh-CN") return "中文";
  if (languageCode === "en" || languageCode === "en-US") return "英文";
  return "自动识别";
}

function defaultSampleProfile(args) {
  if (args["sample-profile"]) return args["sample-profile"];
  return args.transport === "nvidia-riva-grpc" ? "en" : "zh";
}

function applySampleProfile(args) {
  const profile = defaultSampleProfile(args);
  if (profile === "en") {
    if (!args["sample-text"] || args["sample-text"] === "回响工作台转写测试。视频智能字幕，音频转写，字幕文件翻译。") {
      args["sample-text"] = "Echo workbench transcription test. This is a stable audio transcription sample.";
    }
    if (!args["sample-voice"]) args["sample-voice"] = "Samantha";
    if (args.language === "zh") args.language = "en";
    if (!args.expect) args.expect = "transcription";
    return;
  }
  if (profile !== "zh") throw new Error(`Unknown sample profile: ${profile}`);
  if (!args["sample-voice"]) args["sample-voice"] = "Tingting";
  if (!args.expect) args.expect = "回响工作台";
}

function assertWorkbenchRows(rows, label) {
  assert.ok(rows.length > 0, `${label}: no editable rows after workbench repair`);
  rows.forEach((row, index) => {
    const hints = getSubtitleQualityHints(row, rows[index + 1]);
    assert.deepEqual(hints, [], `${label}: row ${index + 1} still has structural quality hints: ${hints.join("、")} / ${row.text}`);
  });
  const secondPass = repairReviewStructure(rows).rows;
  assert.equal(secondPass.length, rows.length, `${label}: rows still contain mergeable fragments after repair`);
}

function providerEnvKeyNames({ transport, endpoint }) {
  const target = String(endpoint || "").toLowerCase();
  const names = ["ASR_API_KEY"];
  if (transport === "dashscope-funasr") {
    names.push("DASHSCOPE_API_KEY");
  } else if (transport === "nvidia-riva-grpc") {
    names.push("NVIDIA_API_KEY");
  } else if (target.includes("api.groq.com")) {
    names.push("GROQ_API_KEY");
  } else if (target.includes("api.openai.com")) {
    names.push("OPENAI_API_KEY");
  } else if (target.includes("nvidia") || target.includes("nvcf")) {
    names.push("NVIDIA_API_KEY");
  }
  return names;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const ASR_ENV_KEY_NAMES = providerEnvKeyNames(args);
const apiKey = ASR_ENV_KEY_NAMES.map((name) => process.env[name]).find(Boolean);
if (!apiKey) {
  throw new Error(`Missing ASR API key in environment. Set one of ${ASR_ENV_KEY_NAMES.join(", ")}. The key is read from env only and is never printed.`);
}

const port = 55800 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let generatedSampleDir = "";
let server;
const stderrRef = { value: "" };

try {
  if (!args.file && args["generate-sample"]) {
    applySampleProfile(args);
    generatedSampleDir = await mkdtemp(join(tmpdir(), "echo-live-asr-sample-"));
    args.file = await generateSpeechSample({
      outputPath: join(generatedSampleDir, "echo-live-asr-sample.m4a"),
      text: args["sample-text"],
      voice: args["sample-voice"],
    });
    args.duration = args.duration === "0" ? "6" : args.duration;
    args["min-rows"] = args["min-rows"] === "1" ? "1" : args["min-rows"];
    args["min-chars"] = args["min-chars"] === "1" ? "8" : args["min-chars"];
  }
  if (!args.file) throw new Error(`${usage()}\n\nMissing required --file. Use --generate-sample on macOS when you do not have a sample file.`);
  if (!existsSync(args.file)) throw new Error(`Sample file does not exist: ${args.file}`);

  configDir = await mkdtemp(join(tmpdir(), "echo-live-asr-config-"));
  server = spawn(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--configLoader",
    "native",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ECHO_WORKBENCH_CONFIG_DIR: configDir },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => {
    stderrRef.value += chunk.toString();
  });
  await waitForServer({ server, baseUrl, stderrRef });

  const fileBuffer = await readFile(args.file);
  const form = new FormData();
  form.set("file", new File([fileBuffer], basename(args.file), { type: contentTypeForFile(args.file) }));
  form.set("provider", JSON.stringify({
    label: args.transport === "dashscope-funasr"
      ? "阿里云百炼 Fun-ASR（中文/多语言）"
      : args.transport === "nvidia-riva-grpc"
        ? "NVIDIA hosted Riva gRPC"
        : "Live ASR HTTP",
    transport: args.transport,
    model: args.model,
    functionId: args["function-id"],
    endpoint: args.endpoint,
    languageCode: args.language,
    sendModel: args.transport === "nvidia-http",
    videoInputMode: args.transport === "dashscope-funasr" ? "original" : "extract",
    apiKey,
  }));

  const response = await fetch(`${baseUrl}/api/asr/transcribe`, { method: "POST", body: form });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || "live ASR request failed");

  const transcript = collectText(data);
  assert.ok(transcript.length > 0, "live ASR returned no readable transcript");
  assertExpectedText(transcript, args.expect);
  const duration = Number(args.duration) || 0;
  const rows = rowsFromAsrResult(data, duration);
  const repair = repairReviewStructurePreservingEmpty(rows, { maxEnd: duration });
  const workbenchRows = repair.rows;
  const minRows = positiveNumber(args["min-rows"], 1);
  const minChars = positiveNumber(args["min-chars"], 1);
  assert.ok(workbenchRows.length >= minRows, `live ASR produced too few editable rows after workbench repair: ${workbenchRows.length}`);
  const totalWeight = transcriptWeight(workbenchRows.map((row) => row.text).join(""));
  assert.ok(totalWeight >= minChars, `live ASR transcript is too short: ${totalWeight}`);
  const qualityIssue = detectTranscriptionQualityIssue(workbenchRows, sourceLanguageLabel(args.language), duration);
  assert.equal(qualityIssue, "", qualityIssue);
  assertWorkbenchRows(workbenchRows, "live ASR workbench rows");

  console.log(JSON.stringify({
    ok: true,
    provider: data.provider || args.transport,
    sampleFile: generatedSampleDir ? "generated" : "provided",
    transcriptPreview: transcript.slice(0, 500),
    editableRowCount: workbenchRows.length,
    transcriptWeight: totalWeight,
    repaired: {
      splitRowCount: repair.splitRowCount,
      mergedRowCount: repair.mergedRowCount,
      addedRowCount: repair.addedRowCount,
    },
    segmentCount: Array.isArray(data.segments) ? data.segments.length : 0,
    wordCount: Array.isArray(data.words) ? data.words.length : 0,
  }, null, 2));
} finally {
  await stopServer(server);
  if (configDir) await rm(configDir, { recursive: true, force: true });
  if (generatedSampleDir) await rm(generatedSampleDir, { recursive: true, force: true });
}
