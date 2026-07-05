import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const port = 53816 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const legacyConfigPath = ".echo-workspace.local.json";
let configDir = "";
let workspaceRoot = "";
let server;
let serverStderr = "";

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite test server exited before ready: ${serverStderr.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/workspace/status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite test server did not become ready.${serverStderr.trim() ? ` ${serverStderr.trim()}` : ""}`);
}

async function postForm(project, files = {}) {
  const form = new FormData();
  form.set("project", JSON.stringify(project));
  if (files.media) form.set("media", files.media);
  if (files.asrAudio) form.set("asrAudio", files.asrAudio);
  const response = await fetch(`${baseUrl}/api/workspace/projects`, { method: "POST", body: form });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || "workspace save failed");
  return data.project;
}

async function assertBytesResponse(path, options, expectedStatus, expectedBytes, expectedContentRange = "") {
  const response = await fetch(`${baseUrl}${path}`, options);
  assert.equal(response.status, expectedStatus);
  if (expectedContentRange) {
    assert.equal(response.headers.get("content-range"), expectedContentRange);
  }
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  if (expectedBytes) {
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expectedBytes);
  }
  return response;
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
  await rm(legacyConfigPath, { force: true });
  configDir = await mkdtemp(join(tmpdir(), "echo-workbench-config-test-"));

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
    serverStderr += chunk.toString();
  });
  await waitForServer();

  let response = await fetch(`${baseUrl}/api/workspace/status`);
  let data = await response.json();
  assert.equal(response.ok, true);
  assert.equal(data.configured, false);
  assert.equal(data.suggestedRoot, "");

  response = await fetch(`${baseUrl}/api/workspace/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: "" }),
  });
  data = await response.json();
  assert.equal(response.ok, false);
  assert.match(data.error, /工作区路径/);

  workspaceRoot = await mkdtemp(join(tmpdir(), "echo-workspace-test-"));
  response = await fetch(`${baseUrl}/api/workspace/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: workspaceRoot }),
  });
  data = await response.json();
  assert.equal(response.ok, true, data.error || "workspace configure failed");
  assert.equal(data.configured, true);
  assert.equal(data.temporaryRoot, true, "workspace API should mark temporary roots so the UI can warn users");
  assert.equal(existsSync(legacyConfigPath), false, "workspace config should not be written inside the project directory");

  const id = "test_recovery_20260619";
  const rows = [
    { id: "row-1", start: 0, end: 2, speaker: "S1", text: "第一条字幕", translation: "First subtitle" },
    { id: "row-2", start: 2, end: 4, speaker: "S1", text: "第二条字幕", translation: "Second subtitle" },
  ];
  const initialProject = {
    id,
    tool: "video-subtitles",
    recent: { id, name: "persistence-test.mp4", meta: "视频智能字幕 · 2 条", status: "已导入", time: "06/19 02:00", type: "video", tool: "video-subtitles" },
    rows,
    workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "bilingual", exportFormat: "srt", draft: "", transcriptionContext: "产品路线图、Echo Workbench" },
    media: { name: "persistence-test.mp4", type: "video/mp4", size: 12, duration: 4 },
    asrAudio: { name: "persistence-audio.wav", type: "audio/wav", size: 8, duration: 4 },
  };

  await postForm(initialProject, {
    media: new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], "persistence-test.mp4", { type: "video/mp4" }),
    asrAudio: new File([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], "persistence-audio.wav", { type: "audio/wav" }),
  });

  const updatedRows = rows.map((row) => row.id === "row-2" ? { ...row, text: "第二条已编辑字幕" } : row);
  await postForm({
    ...initialProject,
    rows: updatedRows,
    recent: { ...initialProject.recent, status: "已编辑", meta: "视频智能字幕 · 已编辑 2 条" },
    media: null,
    asrAudio: null,
  });

  response = await fetch(`${baseUrl}/api/workspace/projects/${id}`);
  data = await response.json();
  assert.equal(response.ok, true, data.error || "workspace load failed");
  assert.equal(data.project.rows.length, 2);
  assert.equal(data.project.rows[1].text, "第二条已编辑字幕");
  assert.equal(data.project.workspaceState.exportMode, "bilingual");
  assert.equal(data.project.workspaceState.exportFormat, "srt");
  assert.equal(data.project.workspaceState.transcriptionContext, "产品路线图、Echo Workbench");
  assert.ok(data.project.mediaUrl);
  assert.ok(data.project.asrAudioUrl);

  await assertBytesResponse(data.project.mediaUrl, {}, 200, [0, 0, 0, 24, 102, 116, 121, 112]);
  await assertBytesResponse(data.project.mediaUrl, { headers: { Range: "bytes=0-3" } }, 206, [0, 0, 0, 24], "bytes 0-3/8");
  await assertBytesResponse(data.project.asrAudioUrl, { headers: { Range: "bytes=-4" } }, 206, [0, 0, 0, 0], "bytes 4-7/8");
  response = await assertBytesResponse(data.project.mediaUrl, { headers: { Range: "bytes=99-100" } }, 416, null, "bytes */8");
  assert.equal(await response.text(), "");

  response = await fetch(`${baseUrl}/api/workspace/status`);
  data = await response.json();
  assert.equal(response.ok, true);
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].hasWorkspaceCopy, true);
  assert.equal(data.projects[0].status, "已编辑");

  const textOnlyId = "test_text_only_subtitles";
  await postForm({
    id: textOnlyId,
    tool: "subtitle-translate",
    recent: {
      id: textOnlyId,
      name: "text-only.srt",
      meta: "字幕文件 · 2 条",
      status: "已解析",
      time: "06/19 02:10",
      type: "document",
      tool: "subtitle-translate",
    },
    rows,
    workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "bilingual", draft: "", transcriptionContext: "" },
    media: null,
    asrAudio: null,
  });

  response = await fetch(`${baseUrl}/api/workspace/projects/${textOnlyId}`);
  data = await response.json();
  assert.equal(response.ok, true, data.error || "text-only workspace load failed");
  assert.equal(data.project.recent.type, "document");
  assert.equal(data.project.mediaUrl, "");
  assert.equal(data.project.asrAudioUrl, "");
  assert.equal(data.project.rows.length, 2);

  response = await fetch(`${baseUrl}/api/workspace/projects/${textOnlyId}`, { method: "DELETE" });
  data = await response.json();
  assert.equal(response.ok, true, data.error || "text-only workspace delete failed");
  assert.equal(data.projects.some((item) => item.id === textOnlyId), false);
  assert.equal(data.projects.some((item) => item.id === id), true);

  response = await fetch(`${baseUrl}/api/workspace/projects/${textOnlyId}`);
  data = await response.json();
  assert.equal(response.ok, false, "deleted project should not be recoverable");

  response = await fetch(`${baseUrl}/api/workspace/status`);
  data = await response.json();
  assert.equal(response.ok, true);
  assert.equal(data.projects.length, 1);
  assert.equal(data.projects[0].id, id);
  assert.equal(data.invalidProjectCount, 0);

  const brokenProjectDir = join(workspaceRoot, "projects", "broken_project");
  await mkdir(brokenProjectDir, { recursive: true });
  await writeFile(join(brokenProjectDir, "project.json"), "{ not valid json");
  response = await fetch(`${baseUrl}/api/workspace/status`);
  data = await response.json();
  assert.equal(response.ok, true);
  assert.equal(data.projects.length, 1, "broken project folders should not hide valid recoverable projects");
  assert.equal(data.invalidProjectCount, 1, "workspace status should expose incomplete or corrupted project folders");

  for (let index = 0; index < 24; index += 1) {
    const manyId = `many_projects_${index}`;
    await postForm({
      id: manyId,
      tool: "audio-transcribe",
      recent: {
        id: manyId,
        name: `many-project-${index}.wav`,
        meta: "音频转写 · 1 条",
        status: "已保存",
        time: `06/19 03:0${index}`,
        type: "audio",
        tool: "audio-transcribe",
      },
      rows: [{ id: `row-many-${index}`, start: 0, end: 1, speaker: "未标注", text: `第 ${index} 个项目`, translation: "" }],
      workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "source", draft: "", transcriptionContext: "" },
      media: null,
      asrAudio: null,
    });
  }

  response = await fetch(`${baseUrl}/api/workspace/status`);
  data = await response.json();
  assert.equal(response.ok, true);
  assert.equal(data.projects.length, 25, "workspace status should return all recoverable projects, not only the newest twenty");
  assert.equal(data.projects[0].id, "many_projects_23", "workspace projects should be sorted newest first");
  assert.equal(data.projects.some((item) => item.id === id), true, "older recoverable projects should remain visible in Projects");

  console.log("workspace persistence tests passed");

  if (serverStderr.includes("error") || serverStderr.includes("EADDRINUSE")) {
    throw new Error(serverStderr);
  }
} finally {
  await stopServer(server);
  await rm(legacyConfigPath, { force: true });
  if (configDir) await rm(configDir, { recursive: true, force: true });
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
}
