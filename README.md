# 回响工作台

回响工作台是一个本地优先的音视频转写与字幕生产工具，面向视频字幕校对、会议/访谈转写、音频逐字稿整理和字幕文件翻译等工作流。

它把媒体预览、云端 ASR 接入、逐段校对、文本模型校正、翻译和导出放在同一个工作台中。项目文件保存在用户选择的本地工作区，API Key 和模型配置保留在本机环境中，适合个人或小团队在可控环境下处理音视频内容。

## English Overview

Echo Workbench is a local-first workspace for audio/video transcription, subtitle production, proofreading, translation, and export.

It combines media preview, cloud ASR integrations, segment-level review, LLM-assisted correction, optional translation, and subtitle/transcript export in one workflow. Project files are stored in a local workspace selected by the user, while API keys and model preferences remain on the local machine.

Main workflows:

- Video subtitles: upload a video, generate or import editable subtitle segments, proofread them against the media, optionally translate them, and export SRT, VTT, or TXT.
- Video transcription: upload a video, generate an editable transcript, proofread the text, and export TXT, Markdown, SRT, or VTT.
- Audio transcription: upload audio, generate or import transcript text, proofread it, and export TXT, Markdown, SRT, or VTT.
- Subtitle translation: import or paste SRT/VTT/TXT subtitles, translate them to the target language, and export source, translated, or bilingual subtitles.

Echo Workbench does not bundle a local Whisper model or depend on local ffmpeg. Audio/video transcription is provided by external ASR services such as Alibaba Cloud DashScope Fun-ASR, DashScope Qwen3-ASR file transcription, OpenAI Whisper-compatible endpoints, Groq Whisper, NVIDIA NIM HTTP endpoints, or custom NVIDIA Riva gRPC deployments. MiniMax-M3 and other text models are used for transcript cleanup, structuring, summarization, and translation, not for ASR itself.

## 适用场景

- 视频字幕生产：从视频生成字幕，逐段校对时间轴和文本，导出 SRT、VTT 或 TXT。
- 视频/音频转写：为会议、访谈、课程、播客和素材审阅生成可编辑逐字稿。
- 字幕翻译：翻译已有 SRT/VTT/TXT 字幕，并导出原文、译文或双语版本。
- 本地项目管理：把媒体副本、校对表、整理稿和导出设置保存在用户选择的本地工作区。

## 项目特点

- 本地优先：媒体副本、校对表和项目状态保存在用户选择的工作区，便于刷新后继续处理。
- 工作台导向：围绕“上传/导入、转写、校对、翻译、导出”的实际流程组织界面。
- 接入灵活：ASR 和文本模型解耦，可接入不同云端或自部署转写服务。
- 轻量依赖：不内置本地 Whisper，不依赖本地 ffmpeg，适合在普通前端开发环境中运行。
- 可校对输出：转写结果不是一次性文本，而是可编辑、可定位、可导出的段落表。

## 核心能力

- 视频智能字幕：上传视频进行预览和字幕校对，调用当前转写服务生成可编辑字幕；也可以导入或粘贴已有字幕文本，再进行翻译和导出。
- 视频转写：上传视频生成可编辑逐字稿，支持导入已有转写文本，校对后导出 TXT、Markdown、SRT 或 VTT。
- 音频转写：上传音频生成转写文本，支持导入已有文本，校对后导出 TXT、Markdown、SRT 或 VTT。
- 字幕文件翻译：导入或粘贴 SRT/VTT/TXT，翻译为目标语言，并按原文、译文或双语模式导出。
- 校对编辑：支持编辑时间码、说话人、原文和译文，并可新增、拆分、合并、重译或删除段落。
- 文本辅助：已配置文本模型后，可对转写/字幕执行保守校正、整理、摘要和翻译。
- 分块处理：长字幕翻译和长转写整理会按段落分块处理，降低单次请求超限风险。
- 导出格式：字幕流程支持 SRT、VTT、TXT；转写流程支持 TXT、Markdown、SRT、VTT。
- 术语一致性：本地术语库和项目内转写提示会进入校正、整理和翻译提示词。
- 本地工作区：首次使用需要配置工作区路径，项目历史以本地文件为准，不依赖浏览器缓存。

## 模型与服务接入

回响工作台把“语音识别”和“文本处理”分成两类模型：

- ASR 转写服务：用于把音视频转换为文本和时间轴。
- 文本模型：用于校正、整理、摘要和翻译转写结果。

内置 ASR 接入包括：

- 阿里云百炼 Fun-ASR
- 阿里云百炼 Qwen3-ASR 文件转写
- OpenAI Whisper API
- Groq Whisper
- OpenAI-compatible audio transcription endpoint
- 远程或自部署 NVIDIA NIM HTTP endpoint
- 自定义 NVIDIA Riva gRPC endpoint

文本模型默认按 MiniMax 中国区 OpenAI-compatible 接口配置，默认地址为 `https://api.minimaxi.com/v1`，默认模型为 `MiniMax-M3`。MiniMax-M3 在本项目中用于文本处理，不作为 ASR 转写模型。

## 功能边界

- 本项目不内置本地 Whisper 模型。
- 本项目不依赖本地 ffmpeg。
- 音视频转写质量取决于所接入的 ASR 服务、音频质量、语言设置和返回的时间戳粒度。
- 如果 ASR 模型没有返回词级时间戳，工作台会按文本内容和媒体时长生成初始分段，仍需要人工校对时间轴。
- NVIDIA NIM HTTP endpoint 适合远程或自部署 `/v1/audio/transcriptions` 服务；Riva gRPC 适合已有 Riva 地址、Function ID 和服务端 Riva Python 客户端的部署。

只有使用 Riva gRPC 接入时，服务端才需要安装 NVIDIA Riva SDK：

```bash
npm run setup:riva
```

部署到其他 Python 路径时，可设置 `NVIDIA_RIVA_PYTHON` 指向对应运行环境。

## 配置与隐私

页面只在当前浏览器保存 API Key 和模型偏好；项目历史、媒体副本和处理结果必须保存到用户选择的本地工作区。

本地代理层可读取 `MINIMAX_API_KEY`，供开发和部署环境使用。云端 ASR 可通过通用 `ASR_API_KEY`，或对应提供方变量 `DASHSCOPE_API_KEY`、`GROQ_API_KEY`、`OPENAI_API_KEY`、`NVIDIA_API_KEY` 提供。

真实密钥不会写入仓库。

## 运行

```bash
npm install
npm run dev
```

默认地址为 `http://127.0.0.1:53815/`。

构建后也可以用本地预览服务运行：

```bash
npm run build
npm run preview
```

`dev` 和 `preview` 都会挂载本地 API，用于工作区保存、模型代理和转写服务调用。

## 验证

```bash
npm test
```

测试覆盖字幕导入导出、双语字幕、ASR 输入封装、ASR 结果入表、模型响应解析、工作区持久化和主要产品流程。

默认测试不调用真实云端 ASR。接入真实服务后，可以用真实样本单独验证：

文本模型验证：

```bash
MINIMAX_API_KEY=你的MiniMax密钥 npm run test:text-live -- --models
```

ASR 验证：

```bash
ASR_API_KEY=你的DashScope或ASR密钥 npm run test:asr-live -- --file /path/to/sample.wav --expect 关键词 --duration 120 --min-rows 4 --min-chars 80
```

也可以使用提供方专用变量，例如 `DASHSCOPE_API_KEY`、`GROQ_API_KEY`、`OPENAI_API_KEY` 或 `NVIDIA_API_KEY`。

没有现成短样本时，可以在 macOS 上生成一段 m4a 系统语音样本再提交真实 ASR：

```bash
DASHSCOPE_API_KEY=你的DashScope密钥 npm run test:asr-live -- --generate-sample --expect 回响工作台 --min-chars 8
```

默认按百炼 Fun-ASR 中国区接口提交原始音视频。`--expect` 可填样本中应出现的关键词；如果不填，仍会验证云端返回了可编辑的转写段落。`--duration`、`--min-rows` 和 `--min-chars` 用于检查长音视频是否只返回了过短、过少或语言明显不匹配的结果。密钥只从环境变量读取，不会写入仓库或工作区。

## 工作区

最近项目和项目与文件只展示本地工作区中可恢复的项目。新导入的媒体文件、视频项目的备用音频文件、字幕/转写行、转写提示、整理稿、语言选择和导出模式会写入工作区，用于刷新后继续打开对应工作台。模型 Key 和术语等本机偏好仍保存在当前浏览器，不作为项目历史来源。

工作区路径保存在仓库外的用户配置目录，默认是 `~/.echo-workbench/workspace.local.json`；也可以用 `ECHO_WORKBENCH_CONFIG_DIR` 指定配置目录。旧版 `.echo-workspace.local.json` 只作为兼容读取，不再作为新的写入位置。未配置工作区时，应用只允许配置模型、术语和工作区，不把浏览器缓存记录作为历史项目展示。配置工作区后，项目状态会显示为“有本地副本”。
