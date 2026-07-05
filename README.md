# 回响工作台

本地优先的视频智能字幕、视频转写、音频转写和字幕文件翻译工作台。

## 当前可用功能

- 视频智能字幕：上传视频进行预览校对，按当前转写服务生成可编辑字幕；默认百炼 Fun-ASR 会直接提交原始音视频，百炼 Qwen3-ASR 文件转写也可作为可选预设，其他仅接收音频的端点才会从视频内音轨生成输入。也可导入文件/粘贴字幕文本，需要跨语言时生成译文并导出 SRT、VTT 或 TXT。
- 视频转写：上传视频后按当前转写服务生成可编辑逐字稿；默认百炼 Fun-ASR 会直接提交原始音视频，百炼 Qwen3-ASR 文件转写也可作为可选预设，其他仅接收音频的端点才会从视频内音轨生成输入。也可导入已有转写文本，校对并导出 TXT、Markdown、SRT 或 VTT。
- 音频转写：上传音频后调用云端 ASR 生成转写文本，也可导入已有转写文本，校对并导出 TXT、Markdown、SRT 或 VTT。
- 字幕文件翻译：导入或粘贴 SRT/VTT/TXT，翻译为目标语言并导出双语字幕。
- 校对表支持编辑时间码、说话人、原文、译文，并可新增、拆分、合并、单条重译或删除段落。
- 粘贴 TXT/逐字稿时支持常见时间码前缀，例如 `00:00:12 文本` 或 `[00:00.000] 说话人: 文本`。
- ASR 返回后会保留原始可编辑段落；若已配置文本模型，工作台会执行一次保守校正，只处理断句、标点、空格和明显识别错字，不扩写内容。
- 如果 ASR 只返回一整段文本、没有词级时间戳或分段，工作台会先调用文本模型恢复标点并切成适合字幕校对的短句，再按媒体时长分配时间轴。
- ASR 入表前会做保守文本规范化，例如中文语境中的英文逗号、句号、问号和感叹号会转为中文标点；同时修正少量字幕场景中高频且明确的同音错字，例如“中文字母”归一为“中文字幕”。
- 默认转写服务为阿里云百炼 Fun-ASR，工作台会通过本地代理把原始音视频上传到百炼临时地址，提交异步转写任务并轮询结果，再写入校对表；也可切换到百炼 Qwen3-ASR 文件转写预设。通用 HTTP audio transcription 端点仍可使用浏览器音轨抽取、分块和备用音频兜底。
- 对于只接收音频的通用 HTTP 转写端点，视频会在浏览器内从内置音轨生成 16kHz 单声道 WAV 输入，再按约 3 分钟分块提交云端 ASR；短音频可直接提交，长音频会分块。确认端点支持视频文件时，可在模型配置中改为直接提交原始视频。浏览器无法抽取视频音轨时，OpenAI-compatible HTTP 端点会自动改为直接提交原始视频；如果端点仍不接受视频，可关联独立备用音频继续转写。分块结果会按原时间线合并，并保守合并边界重复段落，降低长文件漏识别、超时和时间轴漂移风险。
- 转写完成后项目状态保持为待核对；如果源语言与识别文本明显不匹配，或长音频只返回极少分段/过少文本，界面会提示检查音量、音轨、源语言或转写模型。
- 云端转写失败会归一成可操作提示，例如网络/DNS、鉴权、Endpoint、音频格式或上游超时，不把底层错误栈直接暴露给用户。
- 已导入或已生成的转写/字幕段落可手动点击“校正转写/校正字幕”再次处理。
- 长字幕翻译和长转写整理会按段落分块调用文本模型，降低长视频一次请求超限或只返回部分结果的风险。
- Markdown 导出在视频转写和音频转写的逐字稿主导出中可用；整理稿生成后也可单独导出 Markdown。字幕流程只显示已实现的 SRT、VTT、TXT 导出。
- 导出文件名按流程区分：字幕流程使用 `echo-subtitles.*`，转写流程使用 `echo-transcript.*`。
- 字幕和转写导出可选择原文、译文或双语；译文未补齐时不会导出译文/双语半成品。
- 翻译是跨语言附加功能；工作台支持源语言和目标语言选择，二者一致时不会启用翻译。
- 源语言会用于选择 ASR 请求语言码；英文优先的 NVIDIA 托管 Riva 预设遇到中文等非英文素材时会提示切换到明确支持对应语言的 HTTP 转写端点。
- 转写服务配置支持阿里云百炼 Fun-ASR、阿里云百炼 Qwen3-ASR 文件转写、OpenAI Whisper API、Groq Whisper、OpenAI-compatible audio transcription、远程/自部署 NVIDIA NIM HTTP 端点，以及自定义 NVIDIA Riva gRPC。NVIDIA Build 页面中的多数 ASR 模型是下载或自部署形态，不等同于稳定免费托管转写端点。
- 点击开始转写时，待识别媒体会提交到当前配置的 HTTP transcription 或 Riva gRPC 转写服务；本地工作区用于保存媒体副本、校对表和处理结果。
- 转写配置页要求选择 5-15 秒清晰语音样本后再测试；只有真实样本返回可读文本，才视为转写服务可用。只有选择 Riva gRPC 时才显示 NVIDIA Riva SDK 依赖检测。
- 配置 MiniMax 中国区 OpenAI-compatible 接口，默认地址 `https://api.minimaxi.com/v1`，默认模型 `MiniMax-M3`，用于转写后的校正、整理、摘要和翻译。
- 读取当前 MiniMax 账号可用模型列表。
- 模型输入预设包含 MiniMax-M3、MiniMax-M2.7、MiniMax-M2.5、MiniMax-M2.1、MiniMax-M2 及高速版本；实际可用范围以当前账号读取到的模型列表为准。
- 模型连接测试和模型列表读取分别记录状态，避免把模型列表读取失败误判为连接失败。
- 本地术语库和项目内“转写提示”会进入校正、整理和翻译提示词，帮助保持专有名词一致。
- 首次使用需要由用户选择或输入本地工作区路径；项目媒体、校对表、整理稿和导出设置会保存到工作区，未配置时不会导入素材或建立历史项目。

## 不伪装的边界

MiniMax-M3 当前在本项目中用于转写/字幕文本后的清理、摘要和跨语言翻译，不作为 ASR 转写模型。

音频/视频转写由外部 ASR 端点提供。默认预设为阿里云百炼 Fun-ASR，适合中文和多语言录音文件转写；也内置阿里云百炼 Qwen3-ASR 文件转写预设，二者都需要用户填写 DashScope API Key，并通过原始文件上传与异步任务轮询返回结果。OpenAI Whisper API 和 Groq Whisper 都走 OpenAI-compatible `/audio/transcriptions` 上传管线，工作台会请求 verbose JSON、分段和词级时间戳。通用 HTTP transcription 端点需要用户填写可访问的 Endpoint、ASR Key 和必要模型名；这类端点通常从视频内音轨生成音频输入，只有确认端点支持视频文件时才建议改为直接提交原始视频。NVIDIA NIM HTTP 适合自部署或远程托管的 `/v1/audio/transcriptions` 音频端点，不依赖本机 Python SDK；自定义 Riva gRPC 仅适合已经拥有可用 Riva 地址、Function ID 和服务端 Riva Python 客户端的部署。如果模型没有返回词级时间戳，工作台会按文本内容和媒体时长自动分段，并要求校对时间轴。

NVIDIA HTTP / Riva ASR 通常接收音频输入。选择这类端点时，视频项目会从上传视频的内置音轨生成 ASR 输入；如果浏览器不支持该视频封装或编码，HTTP 端点会先尝试直接接收原始视频，仍失败时可关联独立备用音频作为兜底。部署时可以接入云端媒体抽轨服务，但本项目不依赖本地 ffmpeg 或本地 Whisper。

本项目不依赖本地 ffmpeg 或本地 Whisper 模型。HTTP 转写端点不需要安装 NVIDIA Riva SDK。只有使用 Riva gRPC 接入时，服务端才需要安装 NVIDIA Riva SDK：

```bash
npm run setup:riva
```

本地 API 会优先使用 HTTP transcription 端点；选择 Riva gRPC 时，会优先使用 `.venv/bin/python` 检测和调用 Riva SDK，部署到其他路径时可设置 `NVIDIA_RIVA_PYTHON` 指向对应 Python。

设置页不会假装 gRPC 依赖可用；如果当前服务未检测到 `nvidia-riva-client`，模型配置页会提示切换 HTTP 端点或安装依赖。

## 本地密钥

页面只在当前浏览器保存 API Key 和模型偏好；项目历史、媒体副本和处理结果必须保存到用户选择的本地工作区。

未填写 Key 时，连接测试和模型读取会保持禁用，避免把未配置状态误报成模型失败。
本地代理层可读取 `MINIMAX_API_KEY`，供开发调试使用，但不在界面中作为可选来源展示。
云端 ASR 可在服务端通过通用 `ASR_API_KEY`，或对应提供方变量 `DASHSCOPE_API_KEY`、`GROQ_API_KEY`、`OPENAI_API_KEY`、`NVIDIA_API_KEY` 提供；页面只显示“服务端 ASR Key”状态，不展示明文。

真实密钥不会写入仓库。

## 本地运行

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

## 本地测试

```bash
npm test
```

测试覆盖字幕导入、SRT/VTT/TXT/Markdown 导出、双语导出、长时间码格式、ASR 语言码选择、ASR HTTP 音频上传封装、ASR 返回结果转为校对表段落、分块边界重复段落合并，以及云端 ASR 上游错误提示归一化。

默认测试不调用真实云端 ASR。接入真实转写服务后，用一段清晰的真实音频或视频样本单独验收：

真实文本模型可用性可单独验收。该命令只验证 MiniMax 中国区 OpenAI-compatible 文本模型是否能通过本地代理返回内容，不代表音视频 ASR 已可用：

```bash
MINIMAX_API_KEY=你的MiniMax密钥 npm run test:text-live -- --models
```

```bash
ASR_API_KEY=你的DashScope或ASR密钥 npm run test:asr-live -- --file /path/to/sample.wav --expect 关键词 --duration 120 --min-rows 4 --min-chars 80
```

也可以使用提供方专用变量，例如 `DASHSCOPE_API_KEY`、`GROQ_API_KEY`、`OPENAI_API_KEY` 或 `NVIDIA_API_KEY`。

没有现成短样本时，可以在 macOS 上生成一段 m4a 系统语音样本再提交真实 ASR：

```bash
DASHSCOPE_API_KEY=你的DashScope密钥 npm run test:asr-live -- --generate-sample --expect 回响工作台 --min-chars 8
```

默认按百炼 Fun-ASR 中国区接口提交原始音视频。`--expect` 可填样本中应出现的关键词；如果不填，仍会验证云端返回了可编辑的转写段落。`--duration`、`--min-rows` 和 `--min-chars` 用于检查长音视频是否只返回了过短、过少或语言明显不匹配的结果。密钥只从环境变量读取，不会写入仓库或工作区。

## 本地记录

最近项目和项目与文件只展示本地工作区中可恢复的项目。新导入的媒体文件、视频项目的备用音频文件、字幕/转写行、转写提示、整理稿、语言选择和导出模式会写入工作区，用于刷新后继续打开对应工作台。模型 Key 和术语等本机偏好仍保存在当前浏览器，不作为项目历史来源。

工作区路径保存在仓库外的用户配置目录，默认是 `~/.echo-workbench/workspace.local.json`；也可以用 `ECHO_WORKBENCH_CONFIG_DIR` 指定配置目录。旧版 `.echo-workspace.local.json` 只作为兼容读取，不再作为新的写入位置。未配置工作区时，应用只允许配置模型、术语和工作区，不把浏览器缓存记录作为历史项目展示。配置工作区后，项目状态会显示为“有本地副本”。
