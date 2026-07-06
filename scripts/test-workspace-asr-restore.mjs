import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

async function waitForServer(baseUrl, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/provider-status`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not start: ${baseUrl}`);
}

async function createWorkspaceProject(baseUrl, id = "restore_asr_project", name = "restore-asr-video.mp4") {
  const project = {
    id,
    recent: {
      id,
      name,
      meta: "video/mp4 · 0.1 MB",
      status: "已导入",
      time: "测试",
      type: "video",
      tool: "video-transcribe",
      hasWorkspaceCopy: true,
    },
    tool: "video-transcribe",
    rows: [],
    workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "source", draft: "", transcriptionContext: "" },
    media: { name, type: "video/mp4", size: 128, duration: 8 },
    asrAudio: null,
    updatedAt: Date.now(),
  };
  const form = new FormData();
  form.set("project", JSON.stringify(project));
  form.set("media", new File([Buffer.from("not-a-real-video-but-restorable")], name, { type: "video/mp4" }));
  const response = await fetch(`${baseUrl}/api/workspace/projects`, { method: "POST", body: form });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || "failed to create workspace project");
  assert.equal(Boolean(data.project.mediaUrl), true);
}

const port = 56800 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let workspaceRoot = "";
let server;
let browser;

try {
  configDir = await mkdtemp(join(tmpdir(), "echo-restore-asr-config-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "echo-restore-asr-workspace-"));
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
    env: {
      ...process.env,
      ECHO_WORKBENCH_CONFIG_DIR: configDir,
      ASR_API_KEY: "test-asr-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(baseUrl);

  const configureResponse = await fetch(`${baseUrl}/api/workspace/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: workspaceRoot }),
  });
  assert.equal(configureResponse.ok, true, await configureResponse.text());
  await createWorkspaceProject(baseUrl);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let workspaceAsrCalled = false;
  await page.route("**/api/asr/transcribe-workspace", async (route) => {
    workspaceAsrCalled = true;
    const body = JSON.parse(route.request().postData() || "{}");
    assert.equal(body.projectId, "restore_asr_project");
    assert.equal(body.field, "media");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: "恢复项目转写测试。",
        segments: [{ start: 0, end: 1.2, text: "恢复项目转写测试。" }],
        provider: "workspace-restore-test",
      }),
    });
  });

  await page.goto(`${baseUrl}/#workbench/video-transcribe/restore_asr_project`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".workspace-title strong")?.textContent?.includes("视频转写"));
  const startButton = page.getByRole("button", { name: /开始转写/ }).first();
  await startButton.waitFor({ state: "visible" });
  assert.equal(await startButton.isEnabled(), true, "restored workspace media should enable transcription without re-uploading");
  await startButton.click();
  await page.waitForFunction(() => document.querySelector(".subtitle-table .table-row:not(.table-head)")?.textContent?.includes("恢复项目转写测试"));
  assert.equal(workspaceAsrCalled, true, "restored media should call the workspace ASR endpoint");

  await createWorkspaceProject(baseUrl, "restore_browser_extract_project", "restore-browser-extract.mp4");
  let browserExtractAsrCalled = false;
  await page.route("**/api/asr/transcribe", async (route) => {
    browserExtractAsrCalled = true;
    const contentType = route.request().headers()["content-type"] || "";
    assert.match(contentType, /multipart\/form-data/);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: "恢复项目浏览器输入测试。",
        segments: [{ start: 0, end: 1.2, text: "恢复项目浏览器输入测试。" }],
        provider: "workspace-browser-file-test",
      }),
    });
  });
  await page.evaluate(() => {
    localStorage.setItem("echo.asrProvider.v1", JSON.stringify({
      label: "自定义 HTTP 转写端点",
      transport: "nvidia-http",
      endpoint: "https://asr.example.test/v1/audio/transcriptions",
      model: "mock-asr",
      apiKey: "browser-file-test-key",
      languageCode: "zh",
      sendModel: true,
      videoInputMode: "extract",
      lastTest: null,
    }));
  });
  await page.goto(`${baseUrl}/#workbench/video-transcribe/restore_browser_extract_project`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".workspace-title strong")?.textContent?.includes("视频转写"));
  const browserExtractStartButton = page.getByRole("button", { name: /开始转写/ }).first();
  await browserExtractStartButton.waitFor({ state: "visible" });
  assert.equal(await browserExtractStartButton.isEnabled(), true, "restored workspace media should enable browser-file ASR providers without forcing re-upload");
  await browserExtractStartButton.click();
  await page.waitForFunction(() => document.querySelector(".subtitle-table .table-row:not(.table-head)")?.textContent?.includes("恢复项目浏览器输入测试"));
  assert.equal(browserExtractAsrCalled, true, "restored media should be re-read from workspace and submitted to the regular ASR endpoint when needed");

  await page.goto(`${baseUrl}/#models/asr`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".config-panel")?.textContent?.includes("转写服务"));
  await page.route("**/api/asr/test-sample*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/mp4",
      body: Buffer.from("sample-audio"),
    });
  });
  await page.route("**/api/asr/transcribe", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "回响工作台测试样本。", segments: [{ start: 0, end: 1, text: "回响工作台测试样本。" }] }),
    });
  });
  const testButton = page.getByRole("button", { name: "测试连接" });
  assert.equal(await testButton.isEnabled(), true, "built-in sample should make real ASR test action immediately available");
  await testButton.click();
  await page.waitForFunction(() => document.querySelector(".config-panel")?.textContent?.includes("测试样本已提交"));
} finally {
  if (browser) await browser.close();
  if (server) server.kill("SIGTERM");
  await Promise.all([
    configDir ? rm(configDir, { recursive: true, force: true }) : Promise.resolve(),
    workspaceRoot ? rm(workspaceRoot, { recursive: true, force: true }) : Promise.resolve(),
  ]);
}
