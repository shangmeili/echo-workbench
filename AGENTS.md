# 回响工作台项目说明

Run the local server yourself and open the preview in the in-app browser. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Product decisions

- Use a professional light workbench style, not marketing-page copy or layout.
- The home page has four real work entries only: 视频智能字幕、视频转写、音频转写、字幕文件翻译.
- The product center is transcription and subtitle production. Translation is an add-on when source and target languages differ, including bilingual subtitle output.
- Do not add fake feature cards, fake buttons, or unavailable workflow claims.
- Default local preview port is 53815.
- MiniMax integration uses the China endpoint `https://api.minimaxi.com/v1` and defaults to `MiniMax-M3`.
- First use must configure a local workspace. Project history must be backed by workspace files, not only browser cache.
- Video projects use the video file for preview and subtitle proofreading. Automatic transcription should start from the uploaded video first; a supplemental audio file is only a fallback when the video codec or source audio quality prevents reliable cloud ASR input.
- In the workbench, the primary "开始转写" action belongs in the media/upload panel, not in post-processing settings. The left workbench rail is for processing settings; the right side must keep result preview visible while the middle work area scrolls.
- NVIDIA Build Parakeet/Canary hosted Riva presets are English-first in this product. Do not present them as a reliable Chinese transcription path; Chinese transcription should use an HTTP ASR endpoint that explicitly supports Chinese.
- The default ASR preset is 阿里云百炼 Fun-ASR for Chinese/multilingual audio and video. It should submit original media through the server-side DashScope temporary-upload and async-task flow, then write results into the editable review table.
