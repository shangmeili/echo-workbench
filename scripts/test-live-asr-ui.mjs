import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const NVIDIA_RIVA_PROVIDER = {
  label: "NVIDIA Whisper Large v3（托管 Riva gRPC）",
  transport: "nvidia-riva-grpc",
  model: "whisper-large-v3",
  functionId: "b702f636-f60c-4a3d-a6f4-f3568c13bd7d",
  endpoint: "grpc.nvcf.nvidia.com:443",
  languageCode: "multi",
  sendModel: false,
  videoInputMode: "extract",
  apiKey: "",
  lastTest: { ok: true, message: "测试通过", at: Date.now() },
};

function usage() {
  return [
    "Usage:",
    "  NVIDIA_API_KEY=... npm run test:asr-ui-live",
    "",
    "This launches an isolated local app, generates a short English WAV sample,",
    "then verifies the real workbench UI can start NVIDIA Riva transcription",
    "and that incompatible Chinese-source Riva settings are blocked before ASR is called.",
  ].join("\n");
}

if (!process.env.NVIDIA_API_KEY) {
  throw new Error(`${usage()}\n\nMissing NVIDIA_API_KEY. The key is read from env only and is never printed.`);
}

function runCommand(command, args, failureMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => reject(new Error(`${failureMessage}: ${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || failureMessage));
    });
  });
}

async function waitForServer({ server, baseUrl, stderrRef }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server.exitCode !== null && server.exitCode !== undefined) {
      throw new Error(`Vite live-ASR UI server exited before ready: ${stderrRef.value.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/provider-status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite live-ASR UI server did not become ready.${stderrRef.value.trim() ? ` ${stderrRef.value.trim()}` : ""}`);
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

async function configureWorkspace(baseUrl, root) {
  const response = await fetch(`${baseUrl}/api/workspace/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root }),
  });
  assert.equal(response.ok, true, await response.text());
}

async function prepareSampleWav(root) {
  const aiffPath = join(root, "echo-ui-live-sample.aiff");
  const wavPath = join(root, "echo-ui-live-sample.wav");
  await runCommand(
    "say",
    ["-o", aiffPath, "Echo workbench transcription test. This is a stable audio transcription sample."],
    "无法生成系统语音样本，请改用 macOS 或手动扩展该测试",
  );
  await runCommand(
    "afconvert",
    ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiffPath, wavPath],
    "无法生成 Riva 兼容 WAV 测试样本",
  );
  return wavPath;
}

async function seedRivaProvider(page) {
  await page.addInitScript((provider) => {
    localStorage.setItem("echo.asrProvider.v1", JSON.stringify(provider));
  }, NVIDIA_RIVA_PROVIDER);
}

function parseTimecodeSeconds(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return NaN;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const milliseconds = Number((match[4] || "0").padEnd(3, "0"));
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function maxSubtitleEndSeconds(text) {
  const matches = [...String(text || "").matchAll(/(\d{2}:\d{2}(?:\.\d{1,3})?)\s*-\s*(\d{2}:\d{2}(?:\.\d{1,3})?)/g)];
  if (!matches.length) return 0;
  return Math.max(...matches.map((match) => parseTimecodeSeconds(match[2])).filter(Number.isFinite));
}

async function openAudioWorkbench(page, baseUrl, samplePath, sourceLanguage) {
  await page.goto(`${baseUrl}/#workbench/audio-transcribe`, { waitUntil: "networkidle" });
  await page.getByLabel("源语言").selectOption({ label: sourceLanguage });
  await page.getByLabel("目标语言").selectOption({ label: sourceLanguage === "英文" ? "中文" : "英文" });
  await page.locator("input[type=\"file\"]").first().setInputFiles(samplePath);
  await page.waitForFunction(() => document.body.textContent.includes("echo-ui-live-sample.wav"));
}

async function verifySuccessfulTranscription(page, baseUrl, samplePath) {
  await openAudioWorkbench(page, baseUrl, samplePath, "英文");
  const startButton = page.getByRole("button", { name: /开始转写/ }).first();
  assert.equal(await startButton.isEnabled(), true, "English Riva audio should enable the start button");
  await startButton.click();
  await page.waitForFunction(
    () => document.querySelector(".subtitle-table .table-row:not(.table-head)") || document.querySelector(".transcription-status-card.error"),
    null,
    { timeout: 60_000 },
  );
  const errorCard = await page.locator(".transcription-status-card.error").count();
  if (errorCard) throw new Error(await page.locator(".transcription-status-card.error").innerText());
  const tableText = await page.locator(".subtitle-table").innerText();
  assert.match(tableText.toLowerCase(), /echo workbench|transcription test|stable audio/);
  const reviewRows = await page.locator(".subtitle-table .table-row:not(.table-head)").count();
  assert.ok(reviewRows >= 2, `live ASR result should be split into reviewable rows, got ${reviewRows}: ${tableText}`);
  assert.doesNotMatch(
    await page.locator(".subtitle-editor").innerText(),
    /时间重叠|时间无效|单条过长|阅读过快|时长过短|下一处提示|拆分长段/,
    "live ASR result should not expose repairable structure issues as user-facing proofreading prompts",
  );
  const maxEnd = maxSubtitleEndSeconds(tableText);
  assert.ok(maxEnd > 0, `transcription table should expose subtitle timecodes: ${tableText}`);
  assert.ok(maxEnd < 12, `short live-ASR sample should not be stretched across the media fallback duration, got ${maxEnd}s`);
  return tableText.slice(0, 260);
}

async function verifyIncompatibleLanguageBlocked(page, baseUrl, samplePath) {
  let asrRequests = 0;
  await page.route("**/api/asr/**", (route) => {
    asrRequests += 1;
    route.abort();
  });
  await openAudioWorkbench(page, baseUrl, samplePath, "中文");
  const panelText = await page.locator(".action-panel").innerText();
  assert.match(panelText, /模型与源语言不匹配/);
  assert.equal((panelText.match(/当前 NVIDIA 托管 Riva 预设/g) || []).length, 1);
  const startButton = page.getByRole("button", { name: /开始转写/ }).first();
  assert.equal(await startButton.isEnabled(), false, "Chinese source + hosted Riva should disable the start button");
  assert.equal(asrRequests, 0, "incompatible language should not call ASR endpoints");
  await page.unroute("**/api/asr/**");
  return { asrRequests, blockerPreview: panelText.slice(0, 220) };
}

const port = 56950 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let workspaceRoot = "";
let tempRoot = "";
let server;
let browser;
const stderrRef = { value: "" };

try {
  configDir = await mkdtemp(join(tmpdir(), "echo-ui-live-config-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "echo-ui-live-workspace-"));
  tempRoot = await mkdtemp(join(tmpdir(), "echo-ui-live-sample-"));
  const samplePath = await prepareSampleWav(tempRoot);

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
  await configureWorkspace(baseUrl, workspaceRoot);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
  });
  await seedRivaProvider(page);

  const rowsPreview = await verifySuccessfulTranscription(page, baseUrl, samplePath);
  const blocked = await verifyIncompatibleLanguageBlocked(page, baseUrl, samplePath);
  assert.equal(browserErrors.length, 0, `browser errors: ${browserErrors.join("\n")}`);

  console.log(JSON.stringify({
    ok: true,
    provider: "nvidia-riva-grpc",
    sampleFile: "generated",
    successRowsPreview: rowsPreview,
    blocked,
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await stopServer(server);
  if (configDir) await rm(configDir, { recursive: true, force: true });
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
