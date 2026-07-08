import assert from "node:assert/strict";
import { rowsFromAsrResult } from "../src/asrRows.js";
import { transcribeWithNvidia } from "../vite.config.mjs";

const originalFetch = globalThis.fetch;
const requests = [];

function tinyWavBuffer() {
  return Buffer.from([
    82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32,
    16, 0, 0, 0, 1, 0, 1, 0, 64, 31, 0, 0, 128, 62, 0, 0,
    2, 0, 16, 0, 100, 97, 116, 97, 0, 0, 0, 0,
  ]);
}

try {
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method });
    if (url === "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=fun-asr") {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer dashscope-test-token");
      return new Response(JSON.stringify({
        data: {
          upload_dir: "dashscope-temp/echo/",
          oss_access_key_id: "oss-test-id",
          signature: "oss-signature",
          policy: "oss-policy",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
          upload_host: "https://dashscope-upload.example.test",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope-upload.example.test") {
      assert.equal(options.method, "POST");
      const body = options.body;
      assert.ok(body instanceof FormData);
      assert.equal(body.get("OSSAccessKeyId"), "oss-test-id");
      assert.equal(body.get("Signature"), "oss-signature");
      assert.equal(body.get("policy"), "oss-policy");
      assert.equal(body.get("key"), "dashscope-temp/echo/dashscope-video-test.mp4");
      assert.equal(body.get("file").name, "dashscope-video-test.mp4");
      return new Response("", { status: 200 });
    }
    if (url === "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription") {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer dashscope-test-token");
      assert.equal(options.headers["X-DashScope-Async"], "enable");
      assert.equal(options.headers["X-DashScope-OssResourceResolve"], "enable");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "fun-asr");
      assert.deepEqual(body.input.file_urls, ["oss://dashscope-temp/echo/dashscope-video-test.mp4"]);
      assert.deepEqual(body.parameters.language_hints, ["zh"]);
      return new Response(JSON.stringify({ output: { task_id: "task-echo-1", task_status: "PENDING" } }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope.aliyuncs.com/api/v1/tasks/task-echo-1") {
      assert.equal(options.method, "GET");
      return new Response(JSON.stringify({
        output: {
          task_id: "task-echo-1",
          task_status: "SUCCEEDED",
          results: [{ transcription_url: "https://dashscope-result.example.test/result.json" }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope-result.example.test/result.json") {
      return new Response(JSON.stringify({
        transcripts: [{
          text: "大家好，欢迎使用回响工作台。今天测试视频转写功能。",
          sentences: [
            { begin_time: 0, end_time: 2200, speaker_id: "S1", text: "大家好，欢迎使用回响工作台。" },
            { begin_time: 2200, end_time: 4800, speaker_id: "S1", text: "今天测试视频转写功能。" },
          ],
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const dashScopeResult = await transcribeWithNvidia({
    provider: {
      transport: "dashscope-funasr",
      endpoint: "https://dashscope.aliyuncs.com/api/v1",
      model: "fun-asr",
      apiKey: "dashscope-test-token",
      languageCode: "zh-CN",
      sendModel: false,
    },
    file: tinyWavBuffer(),
    fileName: "dashscope-video-test.mp4",
  });

  assert.equal(dashScopeResult.provider, "dashscope-funasr");
  assert.equal(dashScopeResult.segments.length, 2);
  assert.match(dashScopeResult.text, /回响工作台/);
  assert.equal(requests.filter((item) => item.url.includes("dashscope")).length, 5);

  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method, mode: "dashscope-policy-fail" });
    if (url.includes("/uploads?action=getPolicy")) {
      return new Response(JSON.stringify({ message: "policy denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "dashscope-funasr",
        endpoint: "https://dashscope.aliyuncs.com/api/v1",
        model: "fun-asr",
        apiKey: "dashscope-test-token",
        languageCode: "zh-CN",
      },
      file: tinyWavBuffer(),
      fileName: "dashscope-policy-fail.mp4",
    }),
    (error) => {
      assert.equal(error.asrStage, "获取百炼上传凭证");
      assert.equal(error.retryable, true);
      assert.match(error.message, /百炼转写任务未完成/);
      return true;
    },
  );

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    assert.equal(url, "https://asr.example.test/v1/audio/transcriptions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-only-token");
    assert.ok(body instanceof FormData);
    assert.equal(body.get("model"), "mock-asr");
    assert.equal(body.get("language"), "zh");
    const file = body.get("file");
    assert.equal(file.name, "api-transcribe-test.wav");
    assert.equal(file.type, "");
    assert.ok(file.size > 40);
    requests.push({ url, method: options.method, fileName: file.name, fileSize: file.size });

    return new Response(JSON.stringify({
      text: "大家好,欢迎使用回响工作台. 今天测试音频转写功能!",
      segments: [
        { start: 0, end: 2.2, speaker: "S1", text: "大家好,欢迎使用回响工作台." },
        { start: 2.2, end: 4.8, speaker: "S1", text: "今天测试音频转写功能!" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const result = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://asr.example.test/v1/audio/transcriptions",
      model: "mock-asr",
      apiKey: "test-only-token",
      languageCode: "zh",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "api-transcribe-test.wav",
  });

  assert.equal(requests.length, 7);
  assert.equal(result.provider, "nvidia-http");
  assert.equal(result.segments.length, 2);
  assert.match(result.text, /回响工作台/);

  globalThis.fetch = async (url) => {
    requests.push({ url, mode: "http-fail" });
    return new Response(JSON.stringify({ error: { message: "upstream failed" } }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "nvidia-http",
        endpoint: "https://asr.example.test/v1/audio/transcriptions",
        model: "mock-asr",
        apiKey: "test-only-token",
        languageCode: "zh",
        sendModel: true,
      },
      file: tinyWavBuffer(),
      fileName: "api-transcribe-fail.wav",
    }),
    (error) => {
      assert.equal(error.asrStage, "调用 HTTP 转写端点");
      assert.equal(error.retryable, true);
      assert.match(error.message, /upstream failed/);
      return true;
    },
  );

  globalThis.fetch = async (url) => {
    requests.push({ url, mode: "http-ok-error" });
    return new Response(JSON.stringify({ error: { message: "upstream returned error in success body" } }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "nvidia-http",
        endpoint: "https://asr.example.test/v1/audio/transcriptions",
        model: "mock-asr",
        apiKey: "test-only-token",
        languageCode: "zh",
        sendModel: true,
      },
      file: tinyWavBuffer(),
      fileName: "api-transcribe-ok-error.wav",
    }),
    (error) => {
      assert.equal(error.asrStage, "调用 HTTP 转写端点");
      assert.match(error.message, /upstream returned error in success body/);
      return true;
    },
  );

  globalThis.fetch = async (url) => {
    requests.push({ url, mode: "http-empty-success" });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "nvidia-http",
        endpoint: "https://asr.example.test/v1/audio/transcriptions",
        model: "mock-asr",
        apiKey: "test-only-token",
        languageCode: "zh",
        sendModel: true,
      },
      file: tinyWavBuffer(),
      fileName: "api-transcribe-empty.wav",
    }),
    (error) => {
      assert.equal(error.asrStage, "调用 HTTP 转写端点");
      assert.match(error.message, /未返回可用转写文本/);
      return true;
    },
  );

  globalThis.fetch = async (url) => {
    requests.push({ url, mode: "http-nested-output" });
    return new Response(JSON.stringify({
      output: {
        text: "nested output transcription",
        segments: [{ start: 0, end: 1.3, text: "nested output transcription" }],
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const nestedOutputResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://asr.example.test/v1/audio/transcriptions",
      model: "mock-asr",
      apiKey: "test-only-token",
      languageCode: "zh",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "api-transcribe-nested.wav",
  });

  assert.equal(nestedOutputResult.text, "nested output transcription");
  assert.equal(nestedOutputResult.segments.length, 1);

  const rows = rowsFromAsrResult(result, 5);
  assert.deepEqual(
    rows.map((row) => ({ start: row.start, end: row.end, speaker: row.speaker, text: row.text })),
    [
      { start: 0, end: 2.2, speaker: "S1", text: "大家好，欢迎使用回响工作台。" },
      { start: 2.2, end: 4.8, speaker: "S1", text: "今天测试音频转写功能！" },
    ],
  );

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer openai-test-token");
    assert.equal(body.get("model"), "whisper-1");
    assert.equal(body.get("language"), null);
    assert.equal(body.get("response_format"), "verbose_json");
    assert.equal(body.getAll("timestamp_granularities[]").join(","), "segment,word");
    const file = body.get("file");
    assert.equal(file.name, "openai-whisper-test.wav");
    requests.push({ url, model: body.get("model"), language: body.get("language"), responseFormat: body.get("response_format") });

    return new Response(JSON.stringify({
      text: "hello world",
      segments: [{ start: 0, end: 1.4, text: "hello world" }],
      words: [{ start: 0, end: 0.5, word: "hello" }, { start: 0.6, end: 1.1, word: "world" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const whisperResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
      apiKey: "openai-test-token",
      languageCode: "multi",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "openai-whisper-test.wav",
  });

  assert.equal(requests.length, 12);
  assert.equal(whisperResult.words.length, 2);
  assert.equal(whisperResult.segments.length, 1);

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer openai-test-token");
    assert.equal(body.get("model"), "whisper-1");
    requests.push({ url, model: body.get("model"), mode: "word-timestamp-array" });

    return new Response(JSON.stringify({
      text: "timestamp words work",
      words: [
        { word: "timestamp", timestamp: [0, 0.42] },
        { word: "words", timestamp: [0.46, 0.88] },
        { word: "work", timestamp: [0.92, 1.3] },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const whisperTimestampResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://api.openai.com/v1/audio/transcriptions",
      model: "whisper-1",
      apiKey: "openai-test-token",
      languageCode: "multi",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "openai-whisper-word-timestamp-test.wav",
  });

  assert.equal(requests.length, 13);
  assert.deepEqual(
    rowsFromAsrResult(whisperTimestampResult, 3).map((row) => ({ start: row.start, end: row.end, text: row.text })),
    [{ start: 0, end: 1.3, text: "timestamp words work" }],
    "word timestamp-array ASR responses should keep provider timing",
  );

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer groq-test-token");
    assert.equal(body.get("model"), "whisper-large-v3-turbo");
    assert.equal(body.get("language"), null);
    assert.equal(body.get("response_format"), "verbose_json");
    assert.equal(body.getAll("timestamp_granularities[]").join(","), "segment,word");
    const file = body.get("file");
    assert.equal(file.name, "groq-whisper-test.wav");
    requests.push({ url, model: body.get("model"), responseFormat: body.get("response_format") });

    return new Response(JSON.stringify({
      text: "fast multilingual transcription",
      segments: [{ start: 0, end: 2.1, text: "fast multilingual transcription" }],
      words: [{ start: 0, end: 0.4, word: "fast" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const groqResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
      apiKey: "groq-test-token",
      languageCode: "multi",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "groq-whisper-test.wav",
  });

  assert.equal(requests.length, 14);
  assert.equal(groqResult.words.length, 1);
  assert.equal(groqResult.segments.length, 1);

  process.env.DASHSCOPE_API_KEY = "wrong-dashscope-env-token";
  process.env.GROQ_API_KEY = "matched-groq-env-token";
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
    assert.equal(options.headers.Authorization, "Bearer matched-groq-env-token");
    requests.push({ url, envKeyMatched: true });
    return new Response(JSON.stringify({
      text: "provider matched environment key",
      segments: [{ start: 0, end: 1.2, text: "provider matched environment key" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const groqEnvResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
      model: "whisper-large-v3-turbo",
      apiKey: "",
      languageCode: "multi",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "groq-env-test.wav",
  });

  assert.equal(requests.length, 15);
  assert.equal(groqEnvResult.segments.length, 1);
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.GROQ_API_KEY;

  process.env.GROQ_API_KEY = "wrong-groq-env-token";
  globalThis.fetch = async () => {
    throw new Error("DashScope request should not be sent with a Groq environment key");
  };
  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "dashscope-funasr",
        endpoint: "https://dashscope.aliyuncs.com/api/v1",
        model: "fun-asr",
        apiKey: "",
        languageCode: "zh",
        sendModel: false,
      },
      file: tinyWavBuffer(),
      fileName: "dashscope-env-mismatch.mp4",
    }),
    /缺少 ASR API Key/,
  );
  delete process.env.GROQ_API_KEY;

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    assert.equal(url, "http://nim.example.test:9000/v1/audio/transcriptions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer nim-test-token");
    assert.equal(body.get("model"), null);
    assert.equal(body.get("language"), "multi");
    const file = body.get("file");
    assert.equal(file.name, "nvidia-nim-test.wav");
    requests.push({ url, model: body.get("model"), language: body.get("language") });

    return new Response(JSON.stringify({
      text: "bonjour le monde",
      segments: [{ start: 0, end: 1.8, text: "bonjour le monde" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const nimResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "http://nim.example.test:9000/v1/audio/transcriptions",
      apiKey: "nim-test-token",
      languageCode: "multi",
      sendModel: false,
    },
    file: tinyWavBuffer(),
    fileName: "nvidia-nim-test.wav",
  });

  assert.equal(requests.length, 16);
  assert.equal(nimResult.segments.length, 1);

  globalThis.fetch = async (url, options = {}) => {
    const body = options.body;
    assert.equal(url, "https://chunked-asr.example.test/v1/audio/transcriptions");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer chunk-test-token");
    assert.equal(body.get("model"), "chunked-whisper");
    requests.push({ url, model: body.get("model"), mode: "chunked-asr" });

    return new Response(JSON.stringify({
      text: "Chunk one keeps timing. Chunk two keeps timing.",
      chunks: [
        { timestamp: [0, 1.4], text: "Chunk one keeps timing." },
        { timestamp: [1.4, 3.2], text: "Chunk two keeps timing." },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };

  const chunkedResult = await transcribeWithNvidia({
    provider: {
      transport: "nvidia-http",
      endpoint: "https://chunked-asr.example.test/v1/audio/transcriptions",
      model: "chunked-whisper",
      apiKey: "chunk-test-token",
      languageCode: "en",
      sendModel: true,
    },
    file: tinyWavBuffer(),
    fileName: "chunked-whisper-test.wav",
  });

  assert.equal(requests.length, 17);
  assert.equal(chunkedResult.segments.length, 2);
  assert.deepEqual(
    rowsFromAsrResult(chunkedResult, 5).map((row) => ({ start: row.start, end: row.end, text: row.text })),
    [
      { start: 0, end: 1.4, text: "Chunk one keeps timing." },
      { start: 1.4, end: 3.2, text: "Chunk two keeps timing." },
    ],
    "chunk/timestamp ASR responses should keep provider timing instead of falling back to untimed plain text",
  );

  const qwenDashScopeRequestCount = requests.length;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method });
    if (url === "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3-asr-flash-filetrans") {
      assert.equal(options.method, "GET");
      assert.equal(options.headers.Authorization, "Bearer dashscope-test-token");
      return new Response(JSON.stringify({
        data: {
          upload_dir: "dashscope-temp/echo/",
          oss_access_key_id: "oss-test-id",
          signature: "oss-signature",
          policy: "oss-policy",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
          upload_host: "https://dashscope-upload.example.test",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope-upload.example.test") {
      assert.equal(options.method, "POST");
      const body = options.body;
      assert.ok(body instanceof FormData);
      assert.equal(body.get("key"), "dashscope-temp/echo/qwen3-filetrans-test.mp4");
      assert.equal(body.get("file").name, "qwen3-filetrans-test.mp4");
      return new Response("", { status: 200 });
    }
    if (url === "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription") {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer dashscope-test-token");
      assert.equal(options.headers["X-DashScope-Async"], "enable");
      assert.equal(options.headers["X-DashScope-OssResourceResolve"], "enable");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "qwen3-asr-flash-filetrans");
      assert.equal(body.input.file_url, "oss://dashscope-temp/echo/qwen3-filetrans-test.mp4");
      assert.equal(body.input.file_urls, undefined);
      assert.equal(body.parameters.language, "en");
      assert.equal(body.parameters.enable_itn, true);
      assert.equal(body.parameters.language_hints, undefined);
      assert.equal(body.parameters.timestamp_alignment_enabled, undefined);
      return new Response(JSON.stringify({ output: { task_id: "task-echo-qwen3", task_status: "PENDING" } }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope.aliyuncs.com/api/v1/tasks/task-echo-qwen3") {
      assert.equal(options.method, "GET");
      return new Response(JSON.stringify({
        output: {
          task_id: "task-echo-qwen3",
          task_status: "SUCCEEDED",
          result: { transcription_url: "https://dashscope-result.example.test/qwen3.json" },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope-result.example.test/qwen3.json") {
      return new Response(JSON.stringify({
        output: {
          transcripts: [{
            text: "Qwen3 file transcription works.",
            sentences: [
              { begin_time: 0, end_time: 1800, speaker_id: "S1", text: "Qwen3 file transcription works." },
            ],
          }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const qwenDashScopeResult = await transcribeWithNvidia({
    provider: {
      transport: "dashscope-funasr",
      endpoint: "https://dashscope.aliyuncs.com/api/v1",
      model: "qwen3-asr-flash-filetrans",
      apiKey: "dashscope-test-token",
      languageCode: "en-US",
      sendModel: false,
    },
    file: tinyWavBuffer(),
    fileName: "qwen3-filetrans-test.mp4",
  });

  assert.equal(requests.length, qwenDashScopeRequestCount + 5);
  assert.equal(qwenDashScopeResult.provider, "dashscope-funasr");
  assert.equal(qwenDashScopeResult.segments.length, 1);
  assert.match(qwenDashScopeResult.text, /Qwen3/);

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "nvidia-http",
        apiKey: "test-only-token",
        model: "mock-asr",
        sendModel: true,
      },
      file: tinyWavBuffer(),
      fileName: "missing-endpoint.wav",
    }),
    /缺少 HTTP 转写端点/,
  );

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "nvidia-http",
        endpoint: "https://asr.example.test/v1/audio/transcriptions",
        apiKey: "test-only-token",
        sendModel: true,
      },
      file: tinyWavBuffer(),
      fileName: "missing-model.wav",
    }),
    /缺少 ASR 模型名称/,
  );

  const previousAsrFetchTimeout = process.env.ECHO_ASR_FETCH_TIMEOUT_MS;
  process.env.ECHO_ASR_FETCH_TIMEOUT_MS = "10";
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, "https://asr-timeout.example.test/v1/audio/transcriptions");
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(options.signal.reason || new Error("aborted"));
      }, { once: true });
    });
  };
  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "nvidia-http",
        endpoint: "https://asr-timeout.example.test/v1/audio/transcriptions",
        apiKey: "test-only-token",
        model: "mock-asr",
        languageCode: "zh",
        sendModel: true,
      },
      file: tinyWavBuffer(),
      fileName: "timeout-test.wav",
    }),
    (error) => {
      assert.equal(error.asrStage, "调用 HTTP 转写端点");
      assert.equal(error.retryable, true);
      assert.match(error.message, /超时/);
      return true;
    },
  );
  if (previousAsrFetchTimeout === undefined) {
    delete process.env.ECHO_ASR_FETCH_TIMEOUT_MS;
  } else {
    process.env.ECHO_ASR_FETCH_TIMEOUT_MS = previousAsrFetchTimeout;
  }

  globalThis.fetch = async (url, options = {}) => {
    if (url === "https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=fun-asr") {
      return new Response(JSON.stringify({
        data: {
          upload_dir: "dashscope-temp/echo/",
          oss_access_key_id: "oss-test-id",
          signature: "oss-signature",
          policy: "oss-policy",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
          upload_host: "https://dashscope-upload.example.test",
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope-upload.example.test") {
      assert.equal(options.method, "POST");
      return new Response("", { status: 200 });
    }
    if (url === "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription") {
      return new Response(JSON.stringify({ output: { task_id: "task-empty-result", task_status: "PENDING" } }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope.aliyuncs.com/api/v1/tasks/task-empty-result") {
      return new Response(JSON.stringify({
        output: {
          task_id: "task-empty-result",
          task_status: "SUCCEEDED",
          results: [{ transcription_url: "https://dashscope-result.example.test/empty.json" }],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (url === "https://dashscope-result.example.test/empty.json") {
      return new Response(JSON.stringify({ transcripts: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  await assert.rejects(
    () => transcribeWithNvidia({
      provider: {
        transport: "dashscope-funasr",
        endpoint: "https://dashscope.aliyuncs.com/api/v1",
        model: "fun-asr",
        apiKey: "dashscope-test-token",
        languageCode: "zh",
      },
      file: tinyWavBuffer(),
      fileName: "dashscope-empty-result.mp4",
    }),
    (error) => {
      assert.equal(error.asrStage, "读取百炼转写结果");
      assert.match(error.message, /未返回可用转写文本/);
      return true;
    },
  );

  console.log("asr api tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
