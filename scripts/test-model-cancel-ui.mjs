import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const port = 56350 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let workspaceRoot = "";
let sampleVideoPath = "";
let replacementVideoPath = "";
let sampleSubtitlePath = "";
let server;
let serverStderr = "";
let releaseHeldChat;
let resolveChatStarted;
const chatStarted = new Promise((resolve) => {
  resolveChatStarted = resolve;
});

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite model-cancel-ui server exited before ready: ${serverStderr.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/provider-status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite model-cancel-ui server did not become ready.${serverStderr.trim() ? ` ${serverStderr.trim()}` : ""}`);
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
  configDir = await mkdtemp(join(tmpdir(), "echo-model-cancel-config-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "echo-model-cancel-workspace-"));
  const stamp = Date.now();
  sampleVideoPath = join(tmpdir(), `echo-model-cancel-a-${stamp}.mp4`);
  replacementVideoPath = join(tmpdir(), `echo-model-cancel-b-${stamp}.mp4`);
  sampleSubtitlePath = join(tmpdir(), `echo-model-cancel-${stamp}.srt`);
  await writeFile(sampleVideoPath, Buffer.from("video-a"));
  await writeFile(replacementVideoPath, Buffer.from("video-b"));
  await writeFile(sampleSubtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "需要翻译的第一句。",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "需要翻译的第二句。",
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
      DASHSCOPE_API_KEY: "",
      OPENAI_API_KEY: "",
      NVIDIA_API_KEY: "",
      GROQ_API_KEY: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (chunk) => {
    serverStderr += chunk.toString();
  });
  await waitForServer();

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  await page.route("**/api/chat", async (route) => {
    resolveChatStarted?.();
    await new Promise((resolve) => {
      releaseHeldChat = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify([
              { id: "row-1", translation: "stale translation one" },
              { id: "row-2", translation: "stale translation two" },
            ]),
          },
        }],
      }),
    });
  });

  await page.goto(baseUrl, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("echo.provider.v1", JSON.stringify({
      provider: "openai-compatible",
      baseUrl: "http://model-cancel.test/v1",
      model: "cancel-test-model",
      apiKey: "cancel-test-key",
      keySource: "browser",
      connectionTested: true,
      connectionFailed: false,
    }));
  });
  await page.reload({ waitUntil: "load" });
  await page.getByPlaceholder("请选择或输入本地工作区路径").fill(workspaceRoot);
  await page.getByRole("button", { name: "保存工作区" }).click();
  await page.waitForFunction(() => !document.querySelector(".workspace-warning"));
  await page.getByText("视频智能字幕", { exact: true }).click();

  let chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "上传视频", exact: true }).click();
  await (await chooserPromise).setFiles(sampleVideoPath);
  await page.waitForFunction(() => document.querySelector(".media-preview video"));

  chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "导入字幕文件", exact: true }).click();
  await (await chooserPromise).setFiles(sampleSubtitlePath);
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 2);

  await page.getByLabel("源语言").selectOption({ label: "中文" });
  await page.getByLabel("目标语言").selectOption({ label: "英文" });
  await page.locator(".processing-details summary").click();
  const translateButton = page.locator(".action-panel").getByRole("button", { name: "翻译为目标语言" });
  assert.equal(await translateButton.isEnabled(), true, "translation action should be enabled after importing subtitles and configuring a text model");
  await translateButton.click();
  await chatStarted;

  chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "更换视频" }).click();
  const chooser = await chooserPromise;
  let dialogMessage = "";
  page.once("dialog", async (dialog) => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });
  await chooser.setFiles(replacementVideoPath);
  await page.waitForFunction(() => !document.querySelector(".workbench-toast")?.textContent.includes("正在翻译"));
  releaseHeldChat?.();
  await page.waitForTimeout(500);

  const tableText = await page.locator(".subtitle-editor").innerText();
  assert.match(dialogMessage, /当前任务正在执行/);
  assert.doesNotMatch(tableText, /stale translation/, "aborted model response should not write stale translations into the current project");
  assert.equal(await page.locator(".review-list-row").count(), 2, "canceling the stale model response should preserve current review rows");
  await browser.close();
  console.log("model cancel UI tests passed");
} finally {
  releaseHeldChat?.();
  await stopServer(server);
  if (configDir) await rm(configDir, { recursive: true, force: true });
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  if (sampleVideoPath) await rm(sampleVideoPath, { force: true });
  if (replacementVideoPath) await rm(replacementVideoPath, { force: true });
  if (sampleSubtitlePath) await rm(sampleSubtitlePath, { force: true });
}
