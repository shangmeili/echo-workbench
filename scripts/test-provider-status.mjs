import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const port = 53880 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let server;
let serverStderr = "";

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite provider-status server exited before ready: ${serverStderr.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/provider-status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite provider-status server did not become ready.${serverStderr.trim() ? ` ${serverStderr.trim()}` : ""}`);
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
  configDir = await mkdtemp(join(tmpdir(), "echo-provider-status-config-"));
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
      DASHSCOPE_API_KEY: "provider-status-test-key",
      GROQ_API_KEY: "",
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

  const response = await fetch(`${baseUrl}/api/provider-status`);
  const data = await response.json();
  assert.equal(response.ok, true);
  assert.equal(data.asrEnvKeyConfigured, true);
  assert.equal(data.nvidiaEnvKeyConfigured, true);
  assert.equal(JSON.stringify(data).includes("provider-status-test-key"), false);
  console.log("provider status tests passed");
} finally {
  await stopServer(server);
  if (configDir) await rm(configDir, { recursive: true, force: true });
}
