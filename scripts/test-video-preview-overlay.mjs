import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 55900 + Math.floor(Math.random() * 800);
const baseUrl = `http://127.0.0.1:${port}`;

let configDir = "";
let workspaceRoot = "";
let videoPath = "";
let subtitlePath = "";
let server;
let serverStderr = "";

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite video-preview server exited before ready: ${serverStderr.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/workspace/status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite video-preview server did not become ready.${serverStderr.trim() ? ` ${serverStderr.trim()}` : ""}`);
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

async function chooseFile(page, buttonLocator, path) {
  const chooserPromise = page.waitForEvent("filechooser");
  await buttonLocator.click();
  const chooser = await chooserPromise;
  await chooser.setFiles(path);
}

async function generatePlayableWebm(page, path) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    const stream = canvas.captureStream(24);
    const supportedType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
      ? "video/webm;codecs=vp8"
      : "video/webm";
    const recorder = new MediaRecorder(stream, { mimeType: supportedType });
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    recorder.start();
    for (let frame = 0; frame < 84; frame += 1) {
      const second = frame / 24;
      const gradient = context.createLinearGradient(0, 0, 640, 360);
      gradient.addColorStop(0, "#111827");
      gradient.addColorStop(0.52, frame < 42 ? "#4f46e5" : "#0f766e");
      gradient.addColorStop(1, "#020617");
      context.fillStyle = gradient;
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "rgba(255,255,255,0.14)";
      context.fillRect(40 + frame * 2, 58, 180, 180);
      context.fillStyle = "#ffffff";
      context.font = "700 32px system-ui, sans-serif";
      context.fillText(frame < 42 ? "Echo preview first line" : "Echo preview second line", 56, 168);
      context.font = "500 18px system-ui, sans-serif";
      context.fillText(`00:0${Math.floor(second)}`, 56, 206);
      await new Promise((resolve) => setTimeout(resolve, 1000 / 24));
    }
    recorder.stop();
    await new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    const blob = new Blob(chunks, { type: supportedType });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await writeFile(path, Buffer.from(bytes));
}

async function assertSubtitleOverlay(page, expectedText) {
  await page.waitForFunction((text) => {
    const overlay = document.querySelector(".video-subtitle-preview");
    return overlay?.textContent?.includes(text);
  }, expectedText);
  const metrics = await page.evaluate(() => {
    const frame = document.querySelector(".video-preview-frame");
    const video = document.querySelector(".video-preview-frame video");
    const overlay = document.querySelector(".video-subtitle-preview");
    const error = document.querySelector(".media-preview-error");
    const rectFor = (node) => {
      const rect = node?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const frameRect = rectFor(frame);
    const overlayRect = rectFor(overlay);
    return {
      videoDuration: Number(video?.duration || 0),
      videoReadyState: Number(video?.readyState || 0),
      frameRect,
      overlayRect,
      overlayText: overlay?.textContent || "",
      mediaError: error?.textContent || "",
      overlayInsideFrame: Boolean(
        frameRect &&
        overlayRect &&
        overlayRect.left >= frameRect.left - 1 &&
        overlayRect.right <= frameRect.right + 1 &&
        overlayRect.top >= frameRect.top - 1 &&
        overlayRect.bottom <= frameRect.bottom + 1
      ),
      overlayAboveControls: Boolean(frameRect && overlayRect && frameRect.bottom - overlayRect.bottom >= 30),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  });
  assert.ok(metrics.videoDuration >= 3, `playable preview video should expose duration, got ${metrics.videoDuration}`);
  assert.ok(metrics.videoReadyState >= 1, `playable preview video should load metadata, readyState ${metrics.videoReadyState}`);
  assert.equal(metrics.mediaError, "", `playable preview should not show media error: ${metrics.mediaError}`);
  assert.equal(metrics.overlayInsideFrame, true, `subtitle overlay should stay inside video frame: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.overlayAboveControls, true, `subtitle overlay should not cover native controls: ${JSON.stringify(metrics)}`);
  assert.equal(metrics.horizontalOverflow, false, "subtitle overlay should not create horizontal page overflow");
  return metrics;
}

(async () => {
  let browser;
  try {
    configDir = await mkdtemp(join(tmpdir(), "echo-video-preview-config-"));
    workspaceRoot = await mkdtemp(join(tmpdir(), "echo-video-preview-workspace-"));
    videoPath = join(tmpdir(), `echo-video-preview-${Date.now()}.webm`);
    subtitlePath = join(tmpdir(), `echo-video-preview-${Date.now()}.srt`);

    server = spawn(process.execPath, [
      "node_modules/vite/bin/vite.js",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--configLoader", "native",
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ECHO_WORKBENCH_CONFIG_DIR: configDir },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (chunk) => { serverStderr += chunk.toString(); });
    await waitForServer();

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 920 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("echo.provider.v1", JSON.stringify({
        label: "MiniMax 中国区",
        baseUrl: "https://api.minimaxi.com/v1",
        model: "MiniMax-M3",
        apiKey: "video-preview-test-key",
        keySource: "input",
        availableModels: [],
      }));
      localStorage.setItem("echo.asrProvider.v1", JSON.stringify({
        label: "阿里云百炼 Fun-ASR（中文/多语言）",
        transport: "dashscope-funasr",
        model: "fun-asr",
        endpoint: "https://dashscope.aliyuncs.com/api/v1",
        languageCode: "zh",
        sendModel: false,
        videoInputMode: "original",
        apiKey: "video-preview-test-key",
        lastTest: null,
      }));
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await generatePlayableWebm(page, videoPath);
    await writeFile(subtitlePath, [
      "1",
      "00:00:00,000 --> 00:00:01,600",
      "可播放视频字幕第一句。",
      "",
      "2",
      "00:00:01,600 --> 00:00:03,400",
      "可播放视频字幕第二句。",
      "",
    ].join("\n"));

    const configured = await page.evaluate(async (root) => {
      const response = await fetch("/api/workspace/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      return response.json();
    }, workspaceRoot);
    assert.equal(configured.configured, true, "workspace should be configured before importing media");

    await page.goto(`${baseUrl}/?video-preview=${Date.now()}#workbench/video-subtitles`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector(".workspace-title")?.textContent?.includes("视频智能字幕"));
    await page.waitForFunction(() => {
      const uploadReady = [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.trim() === "上传视频" && !button.disabled);
      return uploadReady && !document.querySelector(".workspace-warning");
    });
    await chooseFile(page, page.getByRole("button", { name: "上传视频", exact: true }).first(), videoPath);
    await page.waitForFunction(() => {
      const video = document.querySelector(".video-preview-frame video");
      return video && Number(video.duration || 0) >= 3 && video.readyState >= 1;
    });
    await page.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "导入字幕文件" && !button.disabled));
    await chooseFile(page, page.getByRole("button", { name: "导入字幕文件", exact: true }), subtitlePath);

    const firstMetrics = await assertSubtitleOverlay(page, "可播放视频字幕第一句");
    await page.locator(".review-list-row .seek-row").nth(1).click();
    await assertSubtitleOverlay(page, "可播放视频字幕第二句");
    await page.screenshot({ path: `output/video-preview-overlay-${Date.now()}.png`, fullPage: true });

    const activeState = await page.evaluate(() => ({
      activeRowText: document.querySelector(".review-list-row.active-row")?.textContent || "",
      selectedRowText: document.querySelector(".review-list-row.selected-row")?.textContent || "",
      currentTime: Number(document.querySelector(".video-preview-frame video")?.currentTime || 0),
    }));
    assert.match(activeState.selectedRowText, /可播放视频字幕第二句/, "locating a subtitle row should select the matching segment");
    assert.ok(activeState.currentTime >= 1.5, `locating the second row should seek the video to its start time, got ${activeState.currentTime}`);

    console.log("video preview overlay tests passed", JSON.stringify({
      duration: Number(firstMetrics.videoDuration.toFixed(2)),
      frameWidth: Math.round(firstMetrics.frameRect.width),
      frameHeight: Math.round(firstMetrics.frameRect.height),
    }));
    await browser.close();
    await stopServer(server);
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    throw error;
  } finally {
    await Promise.all([
      configDir ? rm(configDir, { recursive: true, force: true }) : Promise.resolve(),
      workspaceRoot ? rm(workspaceRoot, { recursive: true, force: true }) : Promise.resolve(),
      videoPath ? rm(videoPath, { force: true }) : Promise.resolve(),
      subtitlePath ? rm(subtitlePath, { force: true }) : Promise.resolve(),
    ]);
  }
})();
