import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function usage() {
  return [
    "Usage:",
    "  MINIMAX_API_KEY=... npm run test:text-live",
    "",
    "Options:",
    "  --base-url <url>      OpenAI-compatible base URL. Default: https://api.minimaxi.com/v1",
    "  --model <name>        Text model. Default: MiniMax-M3",
    "  --expect <text>       Text expected in assistant response. Default: 回响工作台",
    "  --models              Also verify /models returns a list.",
    "  --help                Show this message.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    "base-url": "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
    expect: "回响工作台",
    models: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    if (item === "--models") {
      args.models = true;
      continue;
    }
    if (item.startsWith("--")) {
      const key = item.slice(2);
      if (!(key in args)) throw new Error(`Unknown option: ${item}`);
      args[key] = argv[index + 1] || "";
      index += 1;
    }
  }
  return args;
}

async function waitForServer({ server, baseUrl, stderrRef }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server.exitCode !== null && server.exitCode !== undefined) {
      throw new Error(`Vite live text server exited before ready: ${stderrRef.value.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/workspace/status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite live text server did not become ready.${stderrRef.value.trim() ? ` ${stderrRef.value.trim()}` : ""}`);
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

function assistantText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part.text || "").join("").trim();
  return "";
}

function extractModels(data) {
  if (Array.isArray(data?.data)) return data.data.map((item) => item.id || item.name).filter(Boolean);
  if (Array.isArray(data?.models)) return data.models.map((item) => item.id || item.name || item).filter(Boolean);
  return [];
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) {
  throw new Error("Missing MINIMAX_API_KEY. The key is read from env only and is never printed.");
}

const port = 56800 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let configDir = "";
let server;
const stderrRef = { value: "" };

try {
  configDir = await mkdtemp(join(tmpdir(), "echo-live-text-config-"));
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

  const provider = {
    label: "MiniMax 中国区",
    baseUrl: args["base-url"],
    model: args.model,
    apiKey,
    keySource: "input",
  };

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      messages: [
        { role: "system", content: "你是一个连接测试助手。只输出用户要求的短句。" },
        { role: "user", content: `请原样回复：${args.expect}` },
      ],
      temperature: 0,
      max_completion_tokens: 64,
    }),
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || "live text model request failed");
  const text = assistantText(data);
  assert.ok(text.length > 0, "live text model returned empty assistant content");
  assert.ok(text.includes(args.expect), `live text model response did not include expected text: ${args.expect}`);

  let modelCount = 0;
  if (args.models) {
    const modelsResponse = await fetch(`${baseUrl}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const modelsData = await modelsResponse.json();
    assert.equal(modelsResponse.ok, true, modelsData.error || "live model list request failed");
    const models = extractModels(modelsData);
    assert.ok(models.length > 0, "live model list returned no models");
    modelCount = models.length;
  }

  console.log(JSON.stringify({
    ok: true,
    provider: provider.label,
    baseUrl: provider.baseUrl,
    model: provider.model,
    responsePreview: text.slice(0, 120),
    modelCount,
  }, null, 2));
} finally {
  await stopServer(server);
  if (configDir) await rm(configDir, { recursive: true, force: true });
}
