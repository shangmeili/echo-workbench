import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 54950 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let workspaceRoot = "";
let sampleVideoPath = "";
let sampleSubtitlePath = "";
let server;
let serverStderr = "";

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite provider-key-ui server exited before ready: ${serverStderr.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/provider-status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite provider-key-ui server did not become ready.${serverStderr.trim() ? ` ${serverStderr.trim()}` : ""}`);
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

try {
  configDir = await mkdtemp(join(tmpdir(), "echo-provider-key-ui-config-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "echo-provider-key-ui-workspace-"));
  sampleVideoPath = join(tmpdir(), `echo-provider-key-ui-${Date.now()}.mp4`);
  sampleSubtitlePath = join(tmpdir(), `echo-provider-key-ui-${Date.now()}.srt`);
  await writeFile(sampleVideoPath, Buffer.from("not-a-real-video-but-valid-upload-test"));
  await writeFile(sampleSubtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "这是一个字幕导入测试。",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "文本模型未配置时应该显示配置入口。",
    "",
  ].join("\n"));
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
      GROQ_API_KEY: "provider-key-ui-groq-only",
      DASHSCOPE_API_KEY: "",
      OPENAI_API_KEY: "",
      NVIDIA_API_KEY: "",
      ASR_API_KEY: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString();
  });
  await waitForServer();

  const statusResponse = await fetch(`${baseUrl}/api/provider-status`);
  const status = await statusResponse.json();
  assert.equal(status.asrEnvKeys.groq, true);
  assert.equal(status.asrEnvKeys.dashscope, false);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.getByPlaceholder("请选择或输入本地工作区路径").fill(workspaceRoot);
  await page.getByRole("button", { name: "保存工作区" }).click();
  await page.waitForFunction(() => !document.querySelector(".workspace-warning"));
  await page.getByText("视频智能字幕", { exact: true }).click();
  await page.waitForTimeout(400);
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传视频", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(sampleVideoPath);
  await page.waitForTimeout(500);

  const state = await page.evaluate(() => {
    const startButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("开始转写"));
    const statusText = [...document.querySelectorAll(".inline-status")].map((item) => item.textContent.trim()).join(" ");
    const actionPanelText = document.querySelector(".action-panel")?.textContent?.trim() || "";
    return {
      startDisabled: Boolean(startButton?.disabled),
      statusText,
      actionPanelText,
      hint: document.querySelector(".start-hint")?.textContent?.trim() || "",
    };
  });
  assert.equal(state.startDisabled, true);
  assert.match(state.statusText, /转写服务未配置/);
  assert.doesNotMatch(state.statusText, /转写\s+未配置/);
  assert.equal(state.hint, "", "media card should not repeat the ASR blocker when the processing panel already explains it");
  assert.match(state.actionPanelText, /转写服务未配置/);
  assert.match(state.actionPanelText, /配置转写服务/);

  const subtitleChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入字幕文件", exact: true }).click();
  const subtitleChooser = await subtitleChooserPromise;
  await subtitleChooser.setFiles(sampleSubtitlePath);
  await page.waitForFunction(() => document.querySelectorAll(".review-segment-list .review-list-row").length >= 2);
  await page.locator(".processing-details summary").click();
  const modelRequiredText = await page.locator(".model-required-note").innerText();
  assert.match(modelRequiredText, /校正、整理、翻译需要文本模型/);
  await page.locator(".model-required-note").getByRole("button", { name: "配置文本模型" }).click();
  await page.waitForFunction(() => location.hash === "#models/text");
  assert.equal(await page.getByRole("button", { name: "文本模型", exact: true }).evaluate((node) => node.classList.contains("active")), true);
  assert.equal(await page.getByLabel("文本模型提供方").isVisible(), true);
  await browser.close();
  console.log("provider key UI tests passed");
} finally {
  await stopServer(server);
  if (configDir) await rm(configDir, { recursive: true, force: true });
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  if (sampleVideoPath) await rm(sampleVideoPath, { force: true });
  if (sampleSubtitlePath) await rm(sampleSubtitlePath, { force: true });
}
