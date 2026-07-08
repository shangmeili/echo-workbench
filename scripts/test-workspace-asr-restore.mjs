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

async function waitForWorkspaceSaved(page) {
  await page.waitForFunction(() => document.querySelector(".save-status-pill.saved")?.textContent?.includes("已保存"));
}

async function createWorkspaceProject(baseUrl, id = "restore_asr_project", name = "restore-asr-video.mp4", options = {}) {
  const sourceLanguage = options.sourceLanguage || "中文";
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const mediaDuration = Number(options.duration) || 8;
  const project = {
    id,
    recent: {
      id,
      name,
      meta: rows.length ? `转写校对 · ${rows.length} 条` : "video/mp4 · 0.1 MB",
      status: rows.length ? "待校对" : "已导入",
      time: "测试",
      type: "video",
      tool: "video-transcribe",
      hasWorkspaceCopy: true,
    },
    tool: "video-transcribe",
    rows,
    workspaceState: {
      sourceLanguage,
      targetLanguage: "英文",
      exportMode: "source",
      draft: "",
      transcriptionContext: "",
      ...(options.workspaceStatePatch || {}),
    },
    media: { name, type: "video/mp4", size: 128, duration: mediaDuration },
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
  await createWorkspaceProject(baseUrl, "restore_failed_asr_project", "restore-failed-asr-video.mp4", {
    workspaceStatePatch: {
      lastTranscriptionStatus: {
        state: "error",
        message: "转写未完成：调用转写服务失败：当前端点拒绝了识别语言或音频参数。系统已避免写入不完整结果。",
        stage: "调用转写服务",
        retryable: true,
      },
    },
  });
  await createWorkspaceProject(baseUrl, "restore_weak_boundary_project", "restore-weak-boundary-video.mp4", {
    sourceLanguage: "英文",
    duration: 12,
    rows: [
      { id: "weak-question-tail", start: 0, end: 2.4, speaker: "未标注", text: "And then you say something appropriate in response. To what", translation: "", reviewStatus: "pending" },
      { id: "weak-question-tail-next", start: 2.4, end: 3.4, speaker: "未标注", text: "end?", translation: "", reviewStatus: "pending" },
      { id: "weak-pronoun-tail", start: 3.4, end: 5.2, speaker: "未标注", text: "sort of a job? Oh, yeah. I'm", translation: "", reviewStatus: "pending" },
      { id: "weak-pronoun-tail-next", start: 5.2, end: 11.6, speaker: "未标注", text: "a waitress at the Cheesecake Factory. Oh, I love cheesecake. You're lactose intolerant. I don't eat it.", translation: "", reviewStatus: "pending" },
    ],
    workspaceStatePatch: {
      targetLanguage: "中文",
      exportMode: "source",
    },
  });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(`${baseUrl}/#workbench/video-transcribe/restore_weak_boundary_project`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".workspace-title strong")?.textContent?.includes("视频转写"));
  await page.waitForFunction(() => document.querySelector(".subtitle-table")?.textContent?.includes("To what end?"));
  const restoredWeakBoundaryText = await page.locator(".subtitle-table").innerText();
  assert.match(restoredWeakBoundaryText, /To what end\?/);
  assert.match(restoredWeakBoundaryText, /I'm a waitress at the Cheesecake Factory/);
  assert.doesNotMatch(restoredWeakBoundaryText, /Oh, yeah\. I'm\s*$/m, "restored old project should not leave a dangling I'm row ending");
  await waitForWorkspaceSaved(page);
  const weakProjectResponse = await fetch(`${baseUrl}/api/workspace/projects/restore_weak_boundary_project`);
  const weakProjectData = await weakProjectResponse.json();
  assert.equal(weakProjectResponse.ok, true, weakProjectData.error || "failed to reload repaired weak-boundary project");
  const persistedWeakRows = weakProjectData.project.rows.map((row) => row.text);
  assert.deepEqual(
    persistedWeakRows,
    [
      "And then you say something appropriate in response.",
      "To what end?",
      "sort of a job? Oh, yeah.",
      "I'm a waitress at the Cheesecake Factory. Oh, I love cheesecake. You're lactose intolerant. I don't eat it.",
    ],
    "opening a legacy project should persist automatically repaired subtitle boundaries back to the local workspace",
  );

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

  await page.goto(`${baseUrl}/#workbench/video-transcribe/restore_failed_asr_project`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".workspace-title strong")?.textContent?.includes("视频转写"));
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("当前端点拒绝了识别语言或音频参数"));
  assert.match(await page.locator(".transcription-status-card.error").innerText(), /阶段：调用转写服务/);
  assert.equal(await page.locator(".subtitle-table").count(), 0, "restored failed transcription should not create proofreading rows");
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "restored failed transcription should keep a retryable start action visible");

  await createWorkspaceProject(baseUrl, "restore_riva_video_project", "restore-riva-video.mp4");
  await page.evaluate(() => {
    localStorage.setItem("echo.asrProvider.v1", JSON.stringify({
      label: "NVIDIA Whisper Large v3（托管 Riva gRPC）",
      transport: "nvidia-riva-grpc",
      endpoint: "grpc.nvcf.nvidia.com:443",
      functionId: "whisper-large-v3",
      model: "whisper-large-v3",
      apiKey: "nvapi-test-key",
      languageCode: "en",
      sendModel: false,
      videoInputMode: "extract",
      lastTest: { ok: true, message: "测试通过", at: Date.now() },
    }));
  });
  await page.goto(`${baseUrl}/#workbench/video-transcribe/restore_riva_video_project`, { waitUntil: "networkidle" });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".workspace-title strong")?.textContent?.includes("视频转写"));
  const rivaStartButton = page.getByRole("button", { name: /开始转写/ }).first();
  await rivaStartButton.waitFor({ state: "visible" });
  assert.equal(await rivaStartButton.isEnabled(), false, "restored Chinese-source video should not allow the English-first hosted Riva path");
  const blockedRivaPanelText = await page.locator(".action-panel").innerText();
  assert.match(blockedRivaPanelText, /模型与源语言不匹配/);
  assert.equal((blockedRivaPanelText.match(/当前 NVIDIA 托管 Riva 预设/g) || []).length, 1, "Riva language blocker should not duplicate the same explanation");

  await createWorkspaceProject(baseUrl, "restore_riva_english_video_project", "restore-riva-english-video.mp4", { sourceLanguage: "英文" });
  await page.goto(`${baseUrl}/#workbench/video-transcribe/restore_riva_english_video_project`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".workspace-title strong")?.textContent?.includes("视频转写"));
  const rivaEnglishStartButton = page.getByRole("button", { name: /开始转写/ }).first();
  await rivaEnglishStartButton.waitFor({ state: "visible" });
  assert.equal(await rivaEnglishStartButton.isEnabled(), true, "restored English-source video should allow Riva transcription because server prepares compatible audio");

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
