import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const port = 54800 + Math.floor(Math.random() * 1000);
const baseUrl = `http://127.0.0.1:${port}`;
const legacyConfigPath = ".echo-workspace.local.json";
let configDir = "";
let workspaceRoot = "";
let secondaryWorkspaceRoot = "";
let sampleSubtitlePath = "";
let englishSubtitlePath = "";
let riskySubtitlePath = "";
let fragmentSubtitlePath = "";
let longSubtitlePath = "";
let sampleAudioPath = "";
let sampleVideoPath = "";
let termImportPath = "";
let server;
let serverStderr = "";

function expectedExportBase(filePath) {
  return basename(filePath, extname(filePath));
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite product-flow server exited before ready: ${serverStderr.trim() || `exit code ${server.exitCode}`}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/workspace/status`);
      if (response.ok) return;
    } catch {
      // Wait until Vite is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vite product-flow server did not become ready.${serverStderr.trim() ? ` ${serverStderr.trim()}` : ""}`);
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
  const label = await buttonLocator.innerText().catch(() => "");
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null);
  await buttonLocator.click({ timeout: 5000 }).catch(() => {});
  const chooser = await chooserPromise;
  if (chooser) {
    await chooser.setFiles(path);
    return;
  }

  const inputIndex = /音频/.test(label)
    ? 1
    : /字幕|转写|文本/.test(label)
      ? 2
      : 0;
  await page.locator("input[type=\"file\"]").nth(inputIndex).setInputFiles(path);
}

async function openMediaAssociation(page) {
  const mediaAssociation = page.locator(".media-association-card");
  if (await mediaAssociation.count()) {
    const isOpen = await mediaAssociation.evaluate((node) => node.open);
    if (!isOpen) await mediaAssociation.locator("summary").click();
  }
}

async function openActionDetails(page, selector) {
  const details = page.locator(selector);
  if (await details.count()) {
    const isOpen = await details.evaluate((node) => node.open);
    if (!isOpen) await details.locator("summary").click();
  }
}

async function readDownloadText(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function readCorrectionTableValues(page) {
  return page.evaluate(() => {
    const focusedFields = [...document.querySelectorAll(".current-segment-card textarea")].map((field) => field.value || "");
    const listRows = [...document.querySelectorAll(".subtitle-table .table-row:not(.table-head)")].map((row) => row.innerText || "");
    return [...focusedFields, ...listRows].join("\n");
  });
}

function parseReviewTimecode(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
}

async function readReviewTimeRanges(page) {
  return page.evaluate(() => [...document.querySelectorAll(".review-list-row")].map((row) => {
    const text = row.innerText || "";
    const match = text.match(/(\d{2}:\d{2}\.\d{3})\s*[-–]\s*(\d{2}:\d{2}\.\d{3})/);
    return match ? { start: match[1], end: match[2], text } : null;
  }).filter(Boolean));
}

function assertNoReviewTimeOverlap(ranges, label) {
  assert.ok(ranges.length > 0, `${label}: should expose review time ranges`);
  let previousEnd = -Infinity;
  ranges.forEach((range, index) => {
    const start = parseReviewTimecode(range.start);
    const end = parseReviewTimecode(range.end);
    assert.notEqual(start, null, `${label}: row ${index + 1} should have a parseable start time`);
    assert.notEqual(end, null, `${label}: row ${index + 1} should have a parseable end time`);
    assert.ok(end > start, `${label}: row ${index + 1} should have valid timing: ${range.start} - ${range.end}`);
    assert.ok(start >= previousEnd, `${label}: row ${index + 1} should not overlap previous row: ${range.start} < ${previousEnd}`);
    previousEnd = end;
  });
}

async function readWorkbenchFeedback(page) {
  return page.evaluate(() => [...document.querySelectorAll(".message, .workbench-toast")].map((node) => node.textContent || "").join("\n"));
}

async function readCorrectionTableMode(page) {
  return page.evaluate(() => ({
    sourceOnly: Boolean(document.querySelector(".subtitle-table.source-only")),
    withTranslation: Boolean(document.querySelector(".subtitle-table.with-translation")),
    translationEditors: document.querySelectorAll(".subtitle-translation-textarea").length,
  }));
}

async function readCurrentSegmentFieldLabels(page) {
  return page.evaluate(() => [...document.querySelectorAll(".current-segment-card .current-edit-field > span")]
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean));
}

async function assertNoReviewStatsOrFilters(page) {
  const text = await page.locator(".subtitle-editor").innerText();
  assert.doesNotMatch(text, /全部\s*\d|未校对\s*\d|已确认\s*\d|需复听\s*\d/, "review workbench should not expose status stats or filter chips");
}

async function waitForWorkspaceSaved(page) {
  await page.waitForFunction(() => document.querySelector(".save-status-pill.saved")?.textContent?.includes("已保存"));
}

async function beforeUnloadIsPrevented(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function assertUndoRestoresCurrentText(page, nextText) {
  const editor = page.locator(".current-segment-card textarea").first();
  const before = await editor.inputValue();
  const readonlyBefore = await page.locator(".current-source-readonly").count();
  await page.evaluate((value) => {
    const field = document.querySelector(".current-segment-card textarea");
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor.set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, nextText);
  assert.equal(await editor.inputValue(), nextText);
  if (before && before !== nextText) {
    await page.waitForFunction((expected) => document.querySelector(".current-source-readonly")?.textContent?.includes(expected), before);
  }
  const undoButton = page.getByRole("button", { name: "撤销", exact: true });
  await undoButton.waitFor({ state: "visible" });
  assert.equal(await undoButton.isEnabled(), true, "undo should be visible and enabled in the workbench toolbar after editing current text");
  await undoButton.click();
  await page.waitForFunction((expected) => document.querySelector(".current-segment-card textarea")?.value === expected, before);
  assert.equal(await editor.inputValue(), before, "undo should restore the previous current segment text");
  const redoButton = page.getByRole("button", { name: "重做", exact: true });
  await redoButton.waitFor({ state: "visible" });
  assert.equal(await redoButton.isEnabled(), true, "redo should become available after undoing a text edit");
  await redoButton.click();
  await page.waitForFunction((expected) => document.querySelector(".current-segment-card textarea")?.value === expected, nextText);
  assert.equal(await editor.inputValue(), nextText, "redo should restore the undone current segment text edit");
  await undoButton.click();
  await page.waitForFunction((expected) => document.querySelector(".current-segment-card textarea")?.value === expected, before);
  if (readonlyBefore === 0) {
    await page.waitForFunction(() => !document.querySelector(".current-source-readonly"));
  }
}

async function assertSegmentReplayControls(page) {
  const locateButton = page.getByRole("button", { name: /定位到/ }).first();
  const playButton = page.getByRole("button", { name: "播放当前段" }).first();
  const loopButton = page.getByRole("button", { name: "循环播放当前段" }).first();
  assert.equal(await locateButton.count(), 1, "current segment should expose locate control");
  assert.equal(await playButton.count(), 1, "current segment should expose replay control");
  assert.equal(await loopButton.count(), 1, "current segment should expose loop replay control");
  const mediaControlsLayout = await page.evaluate(() => ({
    controlsInActionArea: document.querySelector(".current-segment-controls .current-media-tools")?.querySelectorAll(".segment-locate-button, .segment-play-button, .segment-loop-button").length || 0,
    controlsInMetaLine: document.querySelector(".current-segment-meta")?.querySelectorAll(".segment-locate-button, .segment-play-button, .segment-loop-button").length || 0,
  }));
  assert.equal(mediaControlsLayout.controlsInActionArea, 3, "current segment media controls should live in the compact right-side action area");
  assert.equal(mediaControlsLayout.controlsInMetaLine, 0, "current segment meta line should keep timing and status readable without media action buttons");
  await assert.doesNotReject(() => playButton.click());
  await loopButton.click();
  assert.equal(await loopButton.getAttribute("aria-pressed"), "true", "loop replay should toggle on");
  await loopButton.click();
  assert.equal(await loopButton.getAttribute("aria-pressed"), "false", "loop replay should toggle off");
}

async function assertConfirmStatusCanUndo(page) {
  await page.locator(".review-list-row").first().click();
  const editor = page.locator(".current-segment-card .subtitle-source-textarea");
  const originalText = await editor.inputValue();
  await editor.fill("");
  await page.waitForFunction(() => document.querySelector(".confirm-next")?.disabled);
  assert.equal(await page.getByRole("button", { name: "确认当前段并跳到下一段", exact: true }).isDisabled(), true, "empty rows should not expose a clickable confirm action");
  await editor.focus();
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".review-list-row.confirmed-row").count(), 0, "keyboard confirm should also be blocked for empty rows");
  const noEmptyExportDownload = page.waitForEvent("download", { timeout: 700 }).then(() => false, () => true);
  await page.locator(".top-export-control .primary").click();
  assert.equal(await noEmptyExportDownload, true, "export should be blocked while any reviewed segment has empty text");
  assert.match(await readWorkbenchFeedback(page), /空文本段落/, "empty text export block should explain what must be fixed");
  await page.waitForFunction(() => document.activeElement === document.querySelector(".current-segment-card .subtitle-source-textarea"));
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction((text) => document.querySelector(".current-segment-card .subtitle-source-textarea")?.value === text, originalText);

  await page.locator(".current-segment-card .subtitle-source-textarea").focus();
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 1);
  assert.match(await page.locator(".review-list-row.confirmed-row").first().innerText(), /已确认/);
  await page.locator(".review-list-row.confirmed-row").first().click();
  const confirmedEditor = page.locator(".current-segment-card .subtitle-source-textarea");
  const confirmedText = await confirmedEditor.inputValue();
  await confirmedEditor.fill(`${confirmedText} 修改`);
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 0);
  assert.equal(await page.locator(".review-list-row.confirmed-row").count(), 0, "editing a confirmed row should return it to pending review");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 1);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 0);
  assert.equal(await page.locator(".review-list-row.confirmed-row").count(), 0, "undo should remove the confirmed row status");

  await page.locator(".current-segment-card .subtitle-source-textarea").focus();
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 1);
  await page.locator(".review-list-row.confirmed-row").first().click();
  await page.getByLabel("当前段落开始时间").fill("00:00.100");
  await page.getByLabel("当前段落开始时间").press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 0);
  assert.equal(await page.locator(".review-list-row.confirmed-row").count(), 0, "editing a confirmed row timecode should return it to pending review");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 1);
  const speakerAssignment = page.getByLabel("当前段落说话人归属");
  if (await speakerAssignment.count()) {
    const currentSpeaker = await speakerAssignment.inputValue();
    const targetSpeaker = currentSpeaker === "未标注" ? "Speaker 1" : "未标注";
    await speakerAssignment.selectOption(targetSpeaker);
    await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 0);
    assert.equal(await page.locator(".review-list-row.confirmed-row").count(), 0, "editing a confirmed row speaker should return it to pending review");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 1);
  }
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row.confirmed-row").length === 0);
}

async function assertEditorKeyboardNavigation(page) {
  await page.locator(".review-list-row").first().click();
  const editor = page.locator(".current-segment-card .subtitle-source-textarea");
  await editor.focus();
  const firstText = await editor.inputValue();
  await editor.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true, cancelable: true })));
  await page.waitForFunction((previous) => {
    const field = document.querySelector(".current-segment-card .subtitle-source-textarea");
    return field && field.value && field.value !== previous;
  }, firstText);
  const secondText = await editor.inputValue();
  assert.notEqual(secondText, firstText, "Ctrl+ArrowDown should move focus to the next segment");
  await editor.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", ctrlKey: true, bubbles: true, cancelable: true })));
  await page.waitForFunction((expected) => document.querySelector(".current-segment-card .subtitle-source-textarea")?.value === expected, firstText);
  assert.equal(await editor.inputValue(), firstText, "Ctrl+ArrowUp should return to the previous segment");
}

async function assertWorkbenchFindShortcut(page) {
  await page.locator(".current-segment-card .subtitle-source-textarea").focus();
  await page.waitForFunction(() => document.querySelector("[aria-label='查找校对内容']") && document.querySelectorAll(".review-list-row").length > 0);
  await page.keyboard.press("Control+F");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "查找校对内容");
  assert.equal(await page.getByLabel("查找校对内容").evaluate((node) => node === document.activeElement), true, "Cmd/Ctrl+F should focus the workbench proofreading search field");
  await page.keyboard.type("产品流");
  assert.equal(await page.getByLabel("查找校对内容").inputValue(), "产品流");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement?.classList.contains("subtitle-source-textarea"));
  assert.equal(await page.getByLabel("查找校对内容").inputValue(), "", "Escape should clear the workbench search");
}

async function deleteTermWithConfirmation(page, termText) {
  const row = page.locator(".term-row").filter({ hasText: termText });
  await row.getByRole("button", { name: "删除" }).click();
  await page.waitForFunction((text) => [...document.querySelectorAll(".term-row")].some((item) => item.innerText.includes(text)), termText);
  assert.match(await row.innerText(), /确认删除/, "first term delete click should request confirmation instead of deleting immediately");
  await row.getByRole("button", { name: "确认删除" }).click();
  await page.waitForFunction((text) => ![...document.querySelectorAll(".term-row")].some((item) => item.innerText.includes(text)), termText);
}

async function assertNoMediaPlaybackControls(page) {
  assert.equal(await page.locator(".segment-locate-button").count(), 0, "text-only workbench should not show segment locate controls");
  assert.equal(await page.locator(".segment-play-button").count(), 0, "text-only workbench should not show segment play controls");
  assert.equal(await page.locator(".segment-loop-button").count(), 0, "text-only workbench should not show segment loop controls");
  assert.equal(await page.locator(".review-segment-list.no-media").count(), 1, "text-only workbench should render a no-media review list");
  assert.equal(await page.locator(".review-segment-list.no-media .seek-row").count(), 0, "text-only workbench should not render disabled row seek controls");
}

function createSilentWavBuffer() {
  const sampleRate = 16000;
  const durationSeconds = 1;
  const sampleCount = sampleRate * durationSeconds;
  const buffer = Buffer.alloc(44 + sampleCount * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + sampleCount * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(sampleCount * 2, 40);
  return buffer;
}

async function inspectWorkbenchLayout(page) {
  return page.evaluate(() => {
    const mediaPanel = document.querySelector(".media-panel");
    const controlPanel = document.querySelector(".action-panel");
    const previewPanel = document.querySelector(".result-preview-panel");
    const start = [...document.querySelectorAll("button")].find((button) => /开始转写/.test(button.innerText));
    const workbenchRect = document.querySelector(".workbench-layout")?.getBoundingClientRect();
    const mediaRect = mediaPanel?.getBoundingClientRect();
    const controlRect = controlPanel?.getBoundingClientRect();
    const previewRect = previewPanel?.getBoundingClientRect();
    const titleRect = document.querySelector(".workspace-title")?.getBoundingClientRect();
    const actionsRect = document.querySelector(".workspace-actions")?.getBoundingClientRect();
    const editorRect = document.querySelector(".subtitle-editor")?.getBoundingClientRect();
    const table = document.querySelector(".subtitle-table");
    const textStackRect = document.querySelector(".subtitle-text-stack")?.getBoundingClientRect();
    const draftRect = document.querySelector(".draft-panel")?.getBoundingClientRect();
    const currentSegmentRect = document.querySelector(".current-segment-card")?.getBoundingClientRect();
    const currentEditTextareaRect = document.querySelector(".current-segment-card .current-edit-field textarea")?.getBoundingClientRect();
    const currentSegmentControlsRect = document.querySelector(".current-segment-card .current-segment-controls")?.getBoundingClientRect();
    const currentNavToolsRect = document.querySelector(".current-segment-card .current-nav-tools")?.getBoundingClientRect();
    const confirmNextRect = document.querySelector(".current-segment-card .confirm-next")?.getBoundingClientRect();
    const currentRowToolsRect = document.querySelector(".current-segment-card .current-row-tools")?.getBoundingClientRect();
    const reviewListRect = document.querySelector(".review-segment-list")?.getBoundingClientRect();
    const reviewTitleRect = document.querySelector(".review-title-group")?.getBoundingClientRect();
    const editorToolsRect = document.querySelector(".editor-tools")?.getBoundingClientRect();
    const exportModeRect = document.querySelector(".top-export-control .export-mode-control")?.getBoundingClientRect();
    const contextDetails = document.querySelector(".action-panel .transcription-context-details");
    const textImport = document.querySelector(".text-import");
    const mediaAssociation = document.querySelector(".media-association-card");
    const statusRect = document.querySelector(".inline-status-group")?.getBoundingClientRect();
    const actionTitleRect = document.querySelector(".action-panel .panel-head h2")?.getBoundingClientRect();
    const quickStateRect = document.querySelector(".action-panel .workbench-quick-state")?.getBoundingClientRect();
    const startRect = start?.getBoundingClientRect();
    const undoRect = document.querySelector("[aria-label='撤销']")?.getBoundingClientRect();
    const redoRect = document.querySelector("[aria-label='重做']")?.getBoundingClientRect();
    const withinViewport = (rect) => Boolean(rect && rect.left >= -1 && rect.right <= window.innerWidth + 1 && rect.top >= -1 && rect.bottom <= window.innerHeight + 1);
    const withinRect = (child, parent) => Boolean(child && parent && child.left >= parent.left - 1 && child.right <= parent.right + 1 && child.top >= parent.top - 1 && child.bottom <= parent.bottom + 1);
    const intersects = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
    return {
      title: document.querySelector(".workspace-title strong")?.textContent?.trim(),
      hasResultRows: document.querySelectorAll(".subtitle-table .table-row").length > 1,
      isEmptyResultLayout: Boolean(document.querySelector(".workbench-layout.empty-results")),
      isFilledResultLayout: Boolean(document.querySelector(".workbench-layout.has-results")),
      usesTranslationStack: Boolean(document.querySelector(".subtitle-table.with-translation")),
      isSourceOnlyCorrectionTable: Boolean(document.querySelector(".subtitle-table.source-only")),
      translationEditorCount: document.querySelectorAll(".subtitle-text-stack label:nth-child(2) textarea").length,
      controlTitle: controlPanel?.querySelector(".panel-head h2")?.textContent?.trim() || "",
      hasDuplicateFormatExportInControls: Boolean(controlPanel?.querySelector(".export-row")),
      hasInlineSuccessMessage: Boolean(document.querySelector(".workbench-layout.has-results .message:not(.error)")),
      hasTopManualImportButton: [...document.querySelectorAll(".media-panel-tools button")].some((button) => button.textContent?.includes("导入已有文本")),
      hasToast: Boolean(document.querySelector(".workbench-toast")),
      inlineStatusText: document.querySelector(".workspace-actions .inline-status-group")?.innerText || "",
      hasMediaPanel: Boolean(mediaPanel),
      hasMediaPreview: Boolean(document.querySelector(".media-preview")),
      hasControlPanel: Boolean(controlPanel),
      hasPreview: Boolean(previewRect && previewRect.width > 0 && previewRect.height > 0),
      editorVisible: Boolean(editorRect && editorRect.width > 0 && editorRect.height > 0 && editorRect.top < window.innerHeight && editorRect.bottom > 0),
      editorInViewport: withinViewport(editorRect),
      editorToolsInViewport: withinViewport(editorToolsRect),
      tableOverflowsHorizontally: Boolean(table && table.scrollWidth > table.clientWidth + 2),
      startInsideMedia: Boolean(mediaPanel && start && mediaPanel.contains(start)),
      startInsideControlPanel: Boolean(controlPanel && start && controlPanel.contains(start)),
      hasStartTranscribe: Boolean(start),
      undoVisible: Boolean(undoRect && undoRect.width > 0 && undoRect.height > 0 && undoRect.top < window.innerHeight && undoRect.bottom > 0),
      redoVisible: Boolean(redoRect && redoRect.width > 0 && redoRect.height > 0 && redoRect.top < window.innerHeight && redoRect.bottom > 0),
      undoInViewport: withinViewport(undoRect),
      redoInViewport: withinViewport(redoRect),
      mediaVisible: Boolean(mediaRect && mediaRect.top < window.innerHeight && mediaRect.bottom > 0),
      controlVisible: Boolean(controlRect && controlRect.top < window.innerHeight && controlRect.bottom > 0),
      previewVisible: Boolean(previewRect && previewRect.width > 0 && previewRect.height > 0 && previewRect.top < window.innerHeight && previewRect.bottom > 0),
      mediaScrollsInternally: Boolean(mediaPanel && mediaPanel.scrollHeight > mediaPanel.clientHeight + 2),
      statusOverlapsStart: intersects(statusRect, startRect),
      mediaWidth: Number(mediaRect?.width || 0),
      mediaHeight: Number(mediaRect?.height || 0),
      controlWidth: Number(controlRect?.width || 0),
      controlHeight: Number(controlRect?.height || 0),
      previewReadableWidth: Number(previewRect?.width || 0),
      editorWidth: Number(editorRect?.width || 0),
      editorHeight: Number(editorRect?.height || 0),
      currentSegmentWidth: Number(currentSegmentRect?.width || 0),
      currentSegmentHeight: Number(currentSegmentRect?.height || 0),
      currentSegmentControlsWidth: Number(currentSegmentControlsRect?.width || 0),
      currentSegmentControlsHeight: Number(currentSegmentControlsRect?.height || 0),
      currentSegmentControlsInsideCard: withinRect(currentSegmentControlsRect, currentSegmentRect),
      currentRowToolsInsideCard: withinRect(currentRowToolsRect, currentSegmentRect),
      confirmNextInsideCard: withinRect(confirmNextRect, currentSegmentRect),
      currentNavToolsHeight: Number(currentNavToolsRect?.height || 0),
      hasCurrentMediaTools: Boolean(document.querySelector(".current-segment-card .current-media-tools")),
      confirmNextHeight: Number(confirmNextRect?.height || 0),
      currentEditTextareaHeight: Number(currentEditTextareaRect?.height || 0),
      currentEditTextareaWidth: Number(currentEditTextareaRect?.width || 0),
      reviewListHeight: Number(reviewListRect?.height || 0),
      reviewTitleOverlapsTools: intersects(reviewTitleRect, editorToolsRect),
      addSegmentInViewport: withinViewport([...document.querySelectorAll(".editor-tools button")].find((button) => button.textContent?.includes("添加段落"))?.getBoundingClientRect()),
      emptyMediaFillsLayout: Boolean(!document.querySelector(".media-preview") && mediaRect && workbenchRect && mediaRect.bottom >= workbenchRect.bottom - 2),
      emptyControlFillsLayout: Boolean(!document.querySelector(".media-preview") && controlRect && workbenchRect && controlRect.bottom >= workbenchRect.bottom - 2),
      exportModeVisible: Boolean(exportModeRect && actionsRect && exportModeRect.top >= actionsRect.top - 1 && exportModeRect.bottom <= actionsRect.bottom + 1),
      exportModeInActionPanel: Boolean(document.querySelector(".action-panel .export-mode-control")),
      attachActionsInActionHeader: Boolean(document.querySelector(".action-panel .panel-head .attach-media-inline")),
      quickStateSharesActionTitleRow: Boolean(actionTitleRect && quickStateRect && Math.abs(actionTitleRect.top - quickStateRect.top) <= 6),
      hasMediaAssociationCard: Boolean(mediaAssociation),
      mediaAssociationOpen: Boolean(mediaAssociation?.open),
      mediaAssociationText: mediaAssociation?.textContent || "",
      transcriptionContextCollapsed: Boolean(contextDetails && !contextDetails.open),
      correctionTextWidth: Number(textStackRect?.width || 0),
      mediaBeforeControls: Boolean(mediaRect && controlRect && mediaRect.left < controlRect.left),
      mediaBeforeEditor: Boolean(mediaRect && editorRect && mediaRect.left < editorRect.left),
      controlsBelowMedia: Boolean(mediaRect && controlRect && controlRect.top >= mediaRect.bottom - 2),
      controlsBeforePreview: Boolean(controlRect && previewRect && previewRect.width > 0 && controlRect.left < previewRect.left),
      titleAlignedWithMedia: Boolean(titleRect && mediaRect && Math.abs(titleRect.left - mediaRect.left) <= 2),
      titleAlignedWithControls: Boolean(titleRect && controlRect && Math.abs(titleRect.left - controlRect.left) <= 2),
      titleAlignedWithActions: Boolean(titleRect && actionsRect && Math.abs(titleRect.top - actionsRect.top) <= 8),
      textImportPresent: Boolean(textImport),
      textImportCollapsed: Boolean(textImport?.matches("details:not([open])")),
      overlaps: {
        mediaControls: intersects(mediaRect, controlRect),
        controlsPreview: intersects(controlRect, previewRect),
        mediaPreview: intersects(mediaRect, previewRect),
        mediaEditor: intersects(mediaRect, editorRect),
        editorDraft: intersects(editorRect, draftRect),
      },
      pageBodyScroll: (document.scrollingElement || document.documentElement).scrollHeight > window.innerHeight + 2,
    };
  });
}

async function assertWorkbenchLayout(page, { title, startExpected, hasResults = false, hasEditHistory = false, expectsMediaPanel = true }) {
  const layout = await inspectWorkbenchLayout(page);
  assert.equal(layout.title, title);
  assert.equal(layout.hasResultRows, hasResults, `${title} result row state mismatch`);
  assert.equal(layout.isEmptyResultLayout, !hasResults, `${title} should use compact empty-result layout only before results exist`);
  assert.equal(layout.isFilledResultLayout, hasResults, `${title} should use review layout after results exist`);
  assert.equal(layout.hasMediaPanel, expectsMediaPanel, `${title} media/import panel visibility mismatch`);
  assert.equal(layout.hasControlPanel, true, `${title} should show the fixed workbench controls`);
  assert.equal(layout.hasTopManualImportButton, false, `${title} should keep pasted transcript import as a secondary collapsed path, not a top-level media action`);
  assert.equal(layout.hasPreview, false, `${title} should not use a result preview column as the main work area`);
  assert.equal(layout.editorVisible, hasResults, `${title} should show the correction table only after results exist`);
  if (hasResults) {
    assert.equal(layout.isSourceOnlyCorrectionTable || layout.usesTranslationStack, true, `${title} correction table should declare source-only or translation layout`);
    assert.equal(layout.hasDuplicateFormatExportInControls, false, `${title} should keep format export in the top bar, not duplicate it inside processing settings`);
    assert.equal(layout.hasInlineSuccessMessage, false, `${title} should show routine success feedback as toast, not as an inline card that consumes workbench space`);
  }
  assert.equal(layout.controlTitle.includes("后处理"), false, `${title} should not describe transcription controls as post-processing`);
  assert.match(layout.controlTitle, /处理设置/, `${title} should label the fixed left rail as processing settings`);
  assert.equal(layout.undoVisible, hasResults || hasEditHistory, `${title} should show undo only for editable results or recoverable edit history`);
  assert.equal(layout.redoVisible, hasResults || hasEditHistory, `${title} should show redo only for editable results or recoverable edit history`);
  if (hasResults || hasEditHistory) {
    assert.equal(layout.undoInViewport, true, `${title} should keep undo fully inside the proofreading toolbar`);
    assert.equal(layout.redoInViewport, true, `${title} should keep redo fully inside the proofreading toolbar`);
  }
  assert.equal(layout.mediaVisible, expectsMediaPanel, `${title} media/import panel should match the current workflow state`);
  assert.equal(layout.controlVisible, true, `${title} controls should be visible in the first viewport`);
  assert.equal(layout.previewVisible, false, `${title} result preview should not occupy the workbench viewport`);
  if (hasResults) {
    assert.match(layout.inlineStatusText, /文本/, `${title} result state should keep compact text-model status in the top action row because correction, cleanup, and translation depend on it`);
    assert.doesNotMatch(layout.inlineStatusText, /已验|文本已配|转写已配/, `${title} result model status should use readable product labels instead of abbreviated state copy`);
    if (expectsMediaPanel && title !== "字幕文件翻译") {
      assert.match(layout.inlineStatusText, /转写/, `${title} result state with media should keep transcription status in the top action row instead of inside the media card`);
    }
  } else if (startExpected) {
    assert.match(layout.inlineStatusText, /转写服务|转写依赖/, `${title} setup state should show transcription-service status before ASR starts`);
    assert.doesNotMatch(layout.inlineStatusText, /文本/, `${title} setup state should not warn about text models before transcription results exist`);
  } else {
    assert.doesNotMatch(layout.inlineStatusText, /转写/, `${title} subtitle-file flow should not show ASR status`);
    assert.match(layout.inlineStatusText, /文本模型/, `${title} subtitle-file flow should show text-model status for translation`);
    assert.doesNotMatch(layout.inlineStatusText, /文本\s+(未配置|待测试|可用|失败)/, `${title} text-model status should be explicit enough to understand`);
  }
  assert.equal(expectsMediaPanel ? layout.titleAlignedWithMedia : layout.titleAlignedWithControls, true, `${title} breadcrumb should align with the first workbench column`);
  assert.equal(layout.titleAlignedWithActions, true, `${title} breadcrumb should align vertically with top actions`);
  if (hasResults) {
    if (expectsMediaPanel) {
      assert.equal(layout.mediaBeforeEditor, true, `${title} should place the correction table to the right of media`);
      assert.equal(layout.controlsBelowMedia, true, `${title} processing controls should move below media after results exist`);
      assert.ok(Math.abs(layout.controlWidth - layout.mediaWidth) <= 4, `${title} horizontal processing controls should align to media width, got media ${layout.mediaWidth}, controls ${layout.controlWidth}`);
    } else {
      assert.ok(layout.controlWidth >= 270 && layout.controlWidth <= 340, `${title} text-only controls should stay compact, got ${layout.controlWidth}`);
      assert.ok(layout.editorWidth >= 800, `${title} text-only result state should give the recovered space to proofreading, got editor ${layout.editorWidth}`);
      assert.equal(layout.quickStateSharesActionTitleRow, true, `${title} text-only result state should keep segment/export status in the processing header row`);
    }
    if (layout.hasMediaPreview) {
      assert.ok(layout.mediaWidth >= 470 && layout.mediaWidth <= 640, `${title} media preview column should stay readable after results exist while slightly reducing the proofreading column, got ${layout.mediaWidth}`);
      assert.ok(layout.mediaWidth >= layout.editorWidth * 0.96 && layout.mediaWidth <= layout.editorWidth * 1.18, `${title} result-state media and proofreading columns should stay close to balanced with the right side slightly reduced, got media ${layout.mediaWidth}, editor ${layout.editorWidth}`);
      assert.ok(layout.mediaHeight >= layout.controlHeight * 1.05 && layout.mediaHeight <= layout.controlHeight * 1.55, `${title} result-state media preview should receive slightly more height than processing settings, got media ${layout.mediaHeight}, controls ${layout.controlHeight}`);
    } else if (expectsMediaPanel) {
      const minSummaryWidth = title === "字幕文件翻译" ? 300 : 320;
      assert.ok(layout.mediaWidth >= minSummaryWidth && layout.mediaWidth <= 420, `${title} summary/media column should stay compact, got media column ${layout.mediaWidth}`);
      assert.ok(layout.editorWidth >= 620, `${title} text-only result state should keep a wider proofreading area, got editor ${layout.editorWidth}`);
    }
    if (expectsMediaPanel) assert.ok(layout.mediaHeight <= 470, `${title} media panel should stay compact after results exist, got ${layout.mediaHeight}`);
    assert.ok(layout.currentSegmentHeight <= (layout.usesTranslationStack ? 180 : 160), `${title} current segment editor should stay compact enough for long-form proofreading while keeping row tools clickable, got ${layout.currentSegmentHeight}`);
    assert.ok(layout.currentEditTextareaHeight >= 36, `${title} current segment editor should provide a real compact proofreading input, got ${layout.currentEditTextareaHeight}`);
    assert.ok(layout.confirmNextHeight <= 32, `${title} confirm action should be a compact workbench button, got ${layout.confirmNextHeight}`);
    assert.equal(layout.currentSegmentControlsInsideCard, true, `${title} current segment controls should stay inside the active proofreading card: ${JSON.stringify(layout)}`);
    assert.equal(layout.currentRowToolsInsideCard, true, `${title} split/merge/retranslate/delete controls should stay inside the active proofreading card: ${JSON.stringify(layout)}`);
    assert.equal(layout.confirmNextInsideCard, true, `${title} confirm action should stay inside the active proofreading card: ${JSON.stringify(layout)}`);
    if (layout.usesTranslationStack) {
      if (layout.hasCurrentMediaTools) {
      assert.ok(layout.currentSegmentControlsWidth >= 220 && layout.currentSegmentControlsWidth <= 340, `${title} bilingual media proofreading controls should stay compact while keeping playback, confirm, and row actions clickable, got ${layout.currentSegmentControlsWidth}`);
      } else {
        assert.ok(layout.currentSegmentControlsWidth <= 340, `${title} bilingual current segment controls should stay compact, got ${layout.currentSegmentControlsWidth}`);
      }
      assert.ok(layout.currentEditTextareaWidth >= layout.currentSegmentControlsWidth * 2, `${title} current segment text should dominate the editing card, got textarea ${layout.currentEditTextareaWidth}, controls ${layout.currentSegmentControlsWidth}`);
      assert.ok(layout.currentEditTextareaWidth >= layout.currentSegmentWidth - 80, `${title} bilingual editor should let source and translation fields use the card width instead of sharing a row with tools, got textarea ${layout.currentEditTextareaWidth}, card ${layout.currentSegmentWidth}`);
    }
    if (!layout.hasCurrentMediaTools && !layout.usesTranslationStack) {
      assert.ok(layout.currentNavToolsHeight <= 34, `${title} no-media source-only segment navigation should stay in a compact single row, got ${layout.currentNavToolsHeight}`);
      assert.ok(layout.currentSegmentHeight <= 145, `${title} source-only current segment editor should not crowd the review list while reserving space for row tools, got ${layout.currentSegmentHeight}`);
    }
    if (layout.usesTranslationStack) {
      assert.ok(layout.currentSegmentControlsHeight <= 96, `${title} bilingual current segment controls should fit beside the two editable text rows, got ${layout.currentSegmentControlsHeight}`);
    }
    assert.ok(layout.reviewListHeight >= 480, `${title} review list should keep enough visible working space, got ${layout.reviewListHeight}`);
    assert.equal(layout.reviewTitleOverlapsTools, false, `${title} proofreading title should not overlap the toolbar`);
    assert.ok(layout.controlHeight <= 640, `${title} result-state processing settings should fit its content instead of reserving a full-height column, got ${layout.controlHeight}`);
    assert.equal(layout.exportModeVisible, layout.usesTranslationStack, `${title} export content mode should only appear when translation or bilingual export is available`);
    assert.equal(layout.exportModeInActionPanel, false, `${title} processing settings should not duplicate export content mode`);
    assert.equal(layout.attachActionsInActionHeader, false, `${title} processing settings header should stay quiet; media association actions belong in the panel body`);
    assert.equal(layout.hasMediaAssociationCard, hasResults && !expectsMediaPanel && title !== "字幕文件翻译", `${title} should only show media association when a transcript has no linked media`);
    if (layout.hasMediaAssociationCard) {
      assert.equal(layout.mediaAssociationOpen, false, `${title} media association should stay folded until the user needs media linking`);
      assert.match(layout.mediaAssociationText, /素材关联[\s\S]*关联/, `${title} media association area should explain the real continuation path`);
    }
    if (title !== "字幕文件翻译") {
      assert.equal(layout.transcriptionContextCollapsed, true, `${title} result-state transcription prompt should stay collapsed unless the user opens it`);
    }
  }
  assert.equal(!layout.textImportPresent || layout.textImportCollapsed, true, `${title} paste/import fallback should be collapsed when present and must not occupy primary workbench space`);
  assert.deepEqual(layout.overlaps, {
    mediaControls: false,
    controlsPreview: false,
    mediaPreview: false,
    mediaEditor: false,
    editorDraft: false,
  }, `${title} workbench cards should not overlap`);
  assert.equal(layout.pageBodyScroll, false, `${title} should not require page-level scrolling to reach the preview`);
  const expectedStartVisible = hasResults ? false : startExpected;
  assert.equal(layout.hasStartTranscribe, expectedStartVisible, `${title} start transcription button visibility mismatch`);
  if (expectedStartVisible) {
    assert.equal(layout.startInsideMedia, false, `${title} start transcription button should not crowd the media/import panel`);
    assert.equal(layout.startInsideControlPanel, true, `${title} start transcription button should be in processing settings beside the transcription options`);
  }
  if (expectedStartVisible && !hasEditHistory) {
    assert.equal(layout.emptyMediaFillsLayout, true, `${title} setup media card should fill the empty workbench height instead of leaving a large blank area below it`);
    assert.equal(layout.emptyControlFillsLayout, true, `${title} setup processing card should fill the empty workbench height instead of leaving a large blank area below it`);
  }
  return layout;
}

async function assertMobileWorkbenchLayout(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  const layout = await page.evaluate(() => {
    const selectors = [
      ".workspace-header",
      ".workspace-actions",
      ".top-command-cluster",
      ".media-panel",
      ".action-panel",
      ".workbench-layout",
      ".workspace-title",
    ];
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width } : null;
    };
    const viewportOverflowers = selectors
      .map((selector) => ({ selector, rect: rectFor(selector) }))
      .filter(({ rect }) => rect && (rect.left < -2 || rect.right > window.innerWidth + 2))
      .map(({ selector, rect }) => ({ selector, left: rect.left, right: rect.right, width: rect.width }));
    const mediaRect = rectFor(".media-panel");
    const controlsRect = rectFor(".action-panel");
    const titleRect = rectFor(".workspace-title");
    const headerRect = rectFor(".workspace-header");
    return {
      viewportOverflowers,
      horizontalOverflow: document.scrollingElement.scrollWidth > window.innerWidth + 2,
      mediaFirst: Boolean(mediaRect && controlsRect && mediaRect.top < controlsRect.top),
      titleHeight: Number(titleRect?.bottom - titleRect?.top || 0),
      headerHeight: Number(headerRect?.bottom - headerRect?.top || 0),
      mediaTop: Number(mediaRect?.top || 0),
      mediaWidth: Number(mediaRect?.width || 0),
      controlsWidth: Number(controlsRect?.width || 0),
      undoVisible: Boolean(document.querySelector("[aria-label='撤销']")),
      redoVisible: Boolean(document.querySelector("[aria-label='重做']")),
    };
  });
  assert.equal(layout.horizontalOverflow, false, `mobile workbench should not create page-level horizontal overflow: ${JSON.stringify(layout)}`);
  assert.deepEqual(layout.viewportOverflowers, [], `mobile workbench cards should stay inside the viewport: ${JSON.stringify(layout.viewportOverflowers)}`);
  assert.equal(layout.mediaFirst, true, "mobile setup workbench should show media/import before processing settings");
  assert.ok(layout.titleHeight < 80, `mobile workbench title should not reserve desktop flex height, got ${layout.titleHeight}`);
  assert.ok(layout.headerHeight < 140, `mobile workbench header should stay compact, got ${layout.headerHeight}`);
  assert.ok(layout.mediaTop < 420, `mobile workbench should keep the media/import card reachable in the first viewport, got top ${layout.mediaTop}`);
  assert.ok(layout.mediaWidth <= 390 && layout.controlsWidth <= 390, `mobile workbench panels should fit the viewport, got media ${layout.mediaWidth}, controls ${layout.controlsWidth}`);
  assert.equal(layout.undoVisible, false, "mobile setup workbench should not show inactive undo before results exist");
  assert.equal(layout.redoVisible, false, "mobile setup workbench should not show inactive redo before results exist");
  await page.setViewportSize({ width: 1680, height: 950 });
}

async function assertNarrowSetupWorkbenchLayout(page) {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  const layout = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, width: rect.width } : null;
    };
    const mediaRect = rectFor(".media-panel");
    const controlsRect = rectFor(".action-panel");
    const workbenchRect = rectFor(".workbench-layout");
    const overflowers = [".workspace-header", ".workbench-layout", ".media-panel", ".action-panel"]
      .map((selector) => ({ selector, rect: rectFor(selector) }))
      .filter(({ rect }) => rect && (rect.left < -2 || rect.right > window.innerWidth + 2));
    return {
      mediaBeforeControls: Boolean(mediaRect && controlsRect && mediaRect.top < controlsRect.top),
      mediaWidth: Number(mediaRect?.width || 0),
      controlsWidth: Number(controlsRect?.width || 0),
      workbenchWidth: Number(workbenchRect?.width || 0),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      overflowers,
    };
  });
  assert.equal(layout.mediaBeforeControls, true, "narrow setup workbench should show media/import before processing settings");
  assert.ok(layout.mediaWidth >= layout.workbenchWidth - 4, `narrow setup media panel should use available width, got media ${layout.mediaWidth}, workbench ${layout.workbenchWidth}`);
  assert.ok(layout.controlsWidth >= layout.workbenchWidth - 4, `narrow setup processing panel should use available width, got controls ${layout.controlsWidth}, workbench ${layout.workbenchWidth}`);
  assert.equal(layout.horizontalOverflow, false, "narrow setup workbench should not create horizontal page overflow");
  assert.deepEqual(layout.overflowers, [], `narrow setup workbench cards should stay inside the viewport: ${JSON.stringify(layout.overflowers)}`);
  await page.setViewportSize({ width: 1680, height: 950 });
}

async function assertNarrowNoMediaResultLayout(page, title) {
  await page.setViewportSize({ width: 390, height: 844 });
  const layout = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const workbenchRect = rectFor(".workbench-layout");
    const actionRect = rectFor(".action-panel");
    const editorRect = rectFor(".subtitle-editor");
    const overflowers = [".workbench-layout", ".action-panel", ".subtitle-editor"]
      .map((selector) => ({ selector, rect: rectFor(selector) }))
      .filter(({ rect }) => rect && (rect.left < -2 || rect.right > window.innerWidth + 2));
    return {
      actionWidth: Number(actionRect?.width || 0),
      editorWidth: Number(editorRect?.width || 0),
      workbenchWidth: Number(workbenchRect?.width || 0),
      editorBeforeAction: Boolean(editorRect && actionRect && editorRect.top <= actionRect.top),
      actionBelowEditor: Boolean(editorRect && actionRect && actionRect.top >= editorRect.bottom - 2),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      overflowers,
    };
  });
  assert.ok(layout.editorWidth >= layout.workbenchWidth - 16, `${title} mobile no-media result should let proofreading use the workbench width, got ${JSON.stringify(layout)}`);
  assert.ok(layout.actionWidth >= layout.workbenchWidth - 16, `${title} mobile no-media processing panel should not collapse into a 2px rail, got ${JSON.stringify(layout)}`);
  assert.equal(layout.editorBeforeAction, true, `${title} mobile no-media result should prioritize proofreading before processing settings`);
  assert.equal(layout.actionBelowEditor, true, `${title} mobile no-media processing settings should sit below proofreading, not overlap it`);
  assert.equal(layout.horizontalOverflow, false, `${title} mobile no-media result should not create horizontal overflow`);
  assert.deepEqual(layout.overflowers, [], `${title} mobile no-media result cards should stay inside the viewport`);
  await page.setViewportSize({ width: 1680, height: 950 });
}

async function assertMobileManualImportLandsAtReviewTop(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await page.getByRole("button", { name: "粘贴转写", exact: true }).click();
  await page.getByPlaceholder("粘贴已有逐字稿、TXT、SRT 或 VTT 内容").fill([
    "[00:00:00 - 00:00:02] Speaker 1: 移动端导入后应落在校对顶部。",
    "[00:00:02 - 00:00:05] Speaker 2: 顶部操作按钮不能被滚动位置挤出视口。",
    "[00:00:05 - 00:00:08] Speaker 1: 处理设置应排在校对区之后。",
  ].join("\n"));
  await page.getByRole("button", { name: "导入文本", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length >= 3);
  const layout = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } : null;
    };
    const buttonVisible = (name) => [...document.querySelectorAll("button")]
      .some((button) => {
        const rect = button.getBoundingClientRect();
        return button.textContent.includes(name) && rect.top >= -2 && rect.bottom <= window.innerHeight + 2;
      });
    return {
      viewportHeight: window.innerHeight,
      shellScrollTop: Number(document.querySelector(".app-shell")?.scrollTop || 0),
      header: rectFor(".workspace-header"),
      editor: rectFor(".subtitle-editor"),
      action: rectFor(".action-panel"),
      viewportWidth: window.innerWidth,
      currentCard: rectFor(".current-segment-card"),
      currentSource: rectFor(".current-segment-card .subtitle-source-textarea"),
      currentControls: rectFor(".current-segment-card .current-segment-controls"),
      currentRowTools: rectFor(".current-segment-card .current-row-tools"),
      currentConfirm: rectFor(".current-segment-card .confirm-next"),
      undoVisible: buttonVisible("撤销"),
      exportVisible: buttonVisible("导出 TXT"),
      confirmVisible: buttonVisible("确认"),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      copyAll: (() => {
        const button = document.querySelector("button[aria-label='复制全文']");
        const label = button?.querySelector("span");
        const rect = button?.getBoundingClientRect();
        return { width: Number(rect?.width || 0), labelDisplay: label ? getComputedStyle(label).display : "", ariaLabel: button?.getAttribute("aria-label") || "" };
      })(),
    };
  });
  assert.ok(layout.shellScrollTop <= 2, `mobile import should reset the workbench scroll to the review top, got ${JSON.stringify(layout)}`);
  assert.ok(layout.header?.top >= -2 && layout.header?.bottom <= layout.viewportHeight + 2, `mobile import should keep the workbench header reachable, got ${JSON.stringify(layout)}`);
  assert.ok(layout.editor?.top >= 0 && layout.editor?.top <= layout.viewportHeight + 2, `mobile import should land at the proofreading card, got ${JSON.stringify(layout)}`);
  assert.equal(layout.undoVisible, true, "mobile import should keep undo visible after entering result mode");
  assert.equal(layout.exportVisible, true, "mobile import should keep export visible after entering result mode");
  assert.equal(layout.confirmVisible, true, "mobile import should keep the current-segment confirm action visible");
  assert.ok(layout.currentSource?.width >= 280, `mobile current segment editor should keep enough writing width, got ${JSON.stringify(layout)}`);
  assert.ok(layout.currentSource?.bottom <= layout.currentControls?.top + 2, `mobile current segment controls should sit below the editor, got ${JSON.stringify(layout)}`);
  assert.ok(layout.currentRowTools?.left >= layout.currentConfirm?.right + 4 || layout.currentConfirm?.left >= layout.currentRowTools?.right + 4, `mobile row tools should not overlap the confirm action, got ${JSON.stringify(layout)}`);
  assert.ok(layout.currentCard?.right <= layout.viewportWidth + 1, `mobile current segment card should stay inside the viewport, got ${JSON.stringify(layout)}`);
  assert.equal(layout.copyAll.ariaLabel, "复制全文", "mobile copy-all tool should keep its accessible name");
  assert.ok(layout.copyAll.width <= 44 && layout.copyAll.labelDisplay === "none", `mobile copy-all should collapse to an icon button to reduce toolbar crowding, got ${JSON.stringify(layout.copyAll)}`);
  assert.ok(layout.action?.top >= layout.editor?.bottom - 2, `mobile import should keep processing settings below proofreading, got ${JSON.stringify(layout)}`);
  assert.equal(layout.horizontalOverflow, false, "mobile import result should not create horizontal overflow");
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  const resetFeedback = await page.evaluate(() => ({
    rowCount: document.querySelectorAll(".review-list-row").length,
    toastText: document.querySelector(".workbench-toast")?.textContent || "",
    inlineText: document.querySelector(".workbench-work-area > .message")?.textContent || "",
  }));
  assert.equal(resetFeedback.rowCount, 0, "mobile import reset should return to the setup workbench");
  assert.equal(resetFeedback.toastText, "", `mobile setup workbench should not keep stale success toast after leaving a generated project: ${JSON.stringify(resetFeedback)}`);
  assert.equal(resetFeedback.inlineText, "", `mobile setup workbench should not keep stale inline feedback after leaving a generated project: ${JSON.stringify(resetFeedback)}`);
  await page.setViewportSize({ width: 1680, height: 950 });
}

async function assertMobileBilingualExportActionReadable(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await page.getByRole("button", { name: "粘贴转写", exact: true }).click();
  await page.getByPlaceholder("粘贴已有逐字稿、TXT、SRT 或 VTT 内容").fill([
    "[00:00:00.000 - 00:00:02.332] Previously on The Vampire Diaries...",
    "上集回顾：《吸血鬼日记》……",
    "[00:00:02.332 - 00:00:04.197] You left your son.",
    "你抛弃了你的儿子。",
  ].join("\n"));
  await page.getByRole("button", { name: "导入文本", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".current-segment-card.has-translation"));
  const layout = await page.evaluate(() => {
    const exportControl = document.querySelector(".top-export-control");
    const exportButton = exportControl?.querySelector(".primary");
    const modeControl = exportControl?.querySelector(".top-export-mode-control");
    const toast = document.querySelector(".workbench-toast");
    const sidebar = document.querySelector(".sidebar");
    const controlRect = exportControl?.getBoundingClientRect();
    const buttonRect = exportButton?.getBoundingClientRect();
    const modeRect = modeControl?.getBoundingClientRect();
    const toastRect = toast?.getBoundingClientRect();
    const sidebarRect = sidebar?.getBoundingClientRect();
    return {
      controlWidth: Number(controlRect?.width || 0),
      buttonWidth: Number(buttonRect?.width || 0),
      buttonTop: Number(buttonRect?.top || 0),
      modeBottom: Number(modeRect?.bottom || 0),
      buttonText: exportButton?.textContent?.trim() || "",
      toastOverlapsSidebar: Boolean(toastRect && sidebarRect && toastRect.top < sidebarRect.bottom - 2 && toastRect.bottom > sidebarRect.top + 2),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  });
  assert.match(layout.buttonText, /导出双语 TXT/, `mobile bilingual export should keep the full action label, got ${JSON.stringify(layout)}`);
  assert.ok(layout.buttonWidth >= layout.controlWidth - 4, `mobile bilingual export should use a full row instead of being squeezed, got ${JSON.stringify(layout)}`);
  assert.ok(layout.buttonTop >= layout.modeBottom - 2, `mobile bilingual export should sit below the mode switcher, got ${JSON.stringify(layout)}`);
  assert.equal(layout.toastOverlapsSidebar, false, `mobile import feedback toast should not cover the top navigation or brand area, got ${JSON.stringify(layout)}`);
  assert.equal(layout.horizontalOverflow, false, "mobile bilingual export toolbar should not create horizontal overflow");
  await page.setViewportSize({ width: 1680, height: 950 });
}

async function assertWorkbenchChromePersistsWhileReviewing(page, title) {
  const layout = await page.evaluate(() => {
    const workArea = document.querySelector(".workbench-work-area");
    if (workArea) workArea.scrollTop = workArea.scrollHeight;
    const controlPanel = document.querySelector(".action-panel");
    const editorPanel = document.querySelector(".subtitle-editor");
    const controlRect = controlPanel?.getBoundingClientRect();
    const editorRect = editorPanel?.getBoundingClientRect();
    return {
      controlVisible: Boolean(controlRect && controlRect.top < window.innerHeight && controlRect.bottom > 0),
      editorVisible: Boolean(editorRect && editorRect.top < window.innerHeight && editorRect.bottom > 0),
      workAreaScrollable: Boolean(workArea && workArea.scrollHeight > workArea.clientHeight + 2),
      workAreaScrolled: Boolean(workArea && workArea.scrollTop > 0),
      pageBodyScroll: document.documentElement.scrollHeight > window.innerHeight + 2,
    };
  });
  if (layout.workAreaScrollable) {
    assert.equal(layout.workAreaScrolled, true, `${title} should scroll the center work area when reviewing long content`);
  }
  assert.equal(layout.controlVisible, true, `${title} controls should remain visible while reviewing long content`);
  assert.equal(layout.editorVisible, true, `${title} correction table should remain visible while reviewing long content`);
  assert.equal(layout.pageBodyScroll, false, `${title} should not force page-level scrolling while reviewing long content`);
}

async function assertNarrowResultWorkbenchKeepsReviewList(page, title) {
  await page.setViewportSize({ width: 900, height: 900 });
  const layout = await page.evaluate(() => {
    const rectFor = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null;
    };
    const reviewRect = rectFor(".review-segment-list");
    const editorRect = rectFor(".subtitle-editor");
    const mediaRect = rectFor(".media-panel");
    const workbenchRect = rectFor(".workbench-layout");
    const headerRect = rectFor(".workspace-header");
    const toastRect = rectFor(".workbench-toast");
    const overlaps = (a, b) => Boolean(a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top);
    const toolbarItems = [
      ".workspace-actions .inline-status-group",
      ".top-history-control",
      ".top-export-control",
    ].map((selector) => ({ selector, rect: rectFor(selector) })).filter((item) => item.rect);
    const overflowers = [".workspace-header", ".workbench-layout", ".action-panel", ".media-panel", ".subtitle-editor"]
      .map((selector) => ({ selector, rect: rectFor(selector) }))
      .filter(({ rect }) => rect && (rect.left < -2 || rect.right > window.innerWidth + 2));
    return {
      reviewListHeight: Number(reviewRect?.height || 0),
      editorHeight: Number(editorRect?.height || 0),
      mediaWidth: Number(mediaRect?.width || 0),
      workbenchWidth: Number(workbenchRect?.width || 0),
      toolbarOverlaps: toolbarItems.flatMap((item, index) => toolbarItems.slice(index + 1)
        .filter((other) => overlaps(item.rect, other.rect))
        .map((other) => `${item.selector} overlaps ${other.selector}`)),
      toastOverlapsHeader: overlaps(toastRect, headerRect),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      overflowers,
    };
  });
  assert.ok(layout.reviewListHeight >= 240, `${title} narrow result state should keep the review list usable, got ${layout.reviewListHeight}`);
  assert.ok(layout.editorHeight >= 520, `${title} narrow result state should let the editor grow with the review list, got ${layout.editorHeight}`);
  if (title === "字幕文件翻译") {
    assert.ok(layout.mediaWidth >= 300, `${title} narrow result source summary should stay readable without taking the full proofreading width, got media ${layout.mediaWidth}`);
  } else {
    assert.ok(layout.mediaWidth >= layout.workbenchWidth - 4, `${title} narrow result media/source card should use the available workbench width, got media ${layout.mediaWidth}, workbench ${layout.workbenchWidth}`);
  }
  assert.deepEqual(layout.toolbarOverlaps, [], `${title} narrow result toolbar controls should wrap instead of overlapping: ${JSON.stringify(layout.toolbarOverlaps)}`);
  assert.equal(layout.toastOverlapsHeader, false, `${title} narrow result feedback toast should not cover the header toolbar`);
  assert.equal(layout.horizontalOverflow, false, `${title} narrow result state should not create horizontal page overflow`);
  assert.deepEqual(layout.overflowers, [], `${title} narrow result cards should stay inside the viewport`);
  await page.setViewportSize({ width: 1440, height: 920 });
}

async function assertDirectWorkbenchBackReturnsHome(context) {
  const routePage = await context.newPage();
  await routePage.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await routePage.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await routePage.goBack({ waitUntil: "networkidle" });
  await routePage.waitForTimeout(300);
  const routeState = await routePage.evaluate(() => ({
    hash: location.hash,
    title: document.title,
    body: document.body.innerText,
    hasHomeCards: [...document.querySelectorAll(".feature-card")].some((card) => card.textContent.includes("视频转写")),
  }));
  assert.equal(routeState.hash, "#home", `browser back from a direct workbench deep link should land on #home, got ${JSON.stringify(routeState)}`);
  assert.equal(routeState.title, "\u00a0", "icon-only browser title should persist after back navigation");
  assert.equal(routeState.hasHomeCards, true, `browser back from a direct workbench deep link should show the home workbench cards, got ${JSON.stringify(routeState)}`);
  await routePage.close();
}

async function assertBilingualPlainImportInfersLanguage(context) {
  const importPage = await context.newPage();
  await importPage.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await importPage.getByRole("button", { name: "粘贴转写", exact: true }).click();
  await importPage.getByPlaceholder("粘贴已有逐字稿、TXT、SRT 或 VTT 内容").fill([
    "[00:00:00.000 - 00:00:02.332] Speaker 1: Previously on The Vampire Diaries...",
    "上集回顾：《吸血鬼日记》……",
    "[00:00:02.332 - 00:00:04.197] You left your son.",
    "你抛弃了你的儿子。",
  ].join("\n"));
  await importPage.getByRole("button", { name: "导入文本", exact: true }).click();
  await importPage.waitForFunction(() => document.querySelector(".current-segment-card.has-translation"));
  assert.deepEqual(await readCorrectionTableMode(importPage), { sourceOnly: false, withTranslation: true, translationEditors: 1 }, "bilingual plain text import should enter translation proofreading mode");
  assert.equal(await importPage.getByLabel("源语言").inputValue(), "英文", "bilingual English source import should update the source language");
  assert.equal(await importPage.getByLabel("目标语言").inputValue(), "中文", "bilingual Chinese translation import should update the target language");
  assert.match(await importPage.locator(".top-export-control").innerText(), /导出双语 TXT/, "bilingual plain text import should default to bilingual export");
  assert.match(await importPage.locator(".review-list-row").first().innerText(), /上集回顾：《吸血鬼日记》/, "bilingual plain text import should keep the second line as translation text");
  const bilingualPlainImportLayout = await importPage.evaluate(() => {
    const rectFor = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect ? {
        width: Math.round(rect.width),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
        height: Math.round(rect.height),
      } : null;
    };
    return {
      source: rectFor(".current-segment-card .subtitle-source-textarea"),
      translation: rectFor(".current-segment-card .subtitle-translation-textarea"),
      controls: rectFor(".current-segment-card .current-segment-controls"),
      tools: rectFor(".current-segment-card .current-row-tools"),
      confirm: rectFor(".current-segment-card .confirm-next"),
      toolButtons: [...document.querySelectorAll(".current-row-tools .row-action, .current-row-tools .row-delete")].map((button) => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector("svg")?.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label") || "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          iconWidth: Math.round(icon?.width || 0),
        };
      }),
    };
  });
  assert.ok(bilingualPlainImportLayout.source?.width >= 590, `bilingual proofreading source field should stay wide enough, got ${JSON.stringify(bilingualPlainImportLayout)}`);
  assert.ok(bilingualPlainImportLayout.translation?.width >= 590, `bilingual proofreading translation field should stay wide enough, got ${JSON.stringify(bilingualPlainImportLayout)}`);
  assert.ok(bilingualPlainImportLayout.controls?.width <= 340, `bilingual proofreading controls should stay bounded and not take over the editor, got ${JSON.stringify(bilingualPlainImportLayout)}`);
  assert.ok(bilingualPlainImportLayout.tools?.top >= bilingualPlainImportLayout.confirm?.bottom + 4, `current row tools should sit below the confirm action instead of crowding the first control row, got ${JSON.stringify(bilingualPlainImportLayout)}`);
  assert.ok(bilingualPlainImportLayout.tools?.bottom <= bilingualPlainImportLayout.source?.top, `current row tools should stay above the source field without covering it, got ${JSON.stringify(bilingualPlainImportLayout)}`);
  assert.ok(bilingualPlainImportLayout.confirm?.bottom <= bilingualPlainImportLayout.source?.top, `confirm action should stay in the top control band without covering the source field, got ${JSON.stringify(bilingualPlainImportLayout)}`);
  assert.ok(
    bilingualPlainImportLayout.toolButtons.every((button) => button.width >= 28 && button.height >= 28 && button.iconWidth >= 14),
    `bilingual row actions should remain compact icon buttons while keeping usable click targets: ${JSON.stringify(bilingualPlainImportLayout.toolButtons)}`,
  );
  await importPage.close();
}

async function assertEnglishSubtitleFileInfersTranslationDirection(context) {
  const importPage = await context.newPage();
  await importPage.goto(`${baseUrl}/#workbench/subtitle-translate`, { waitUntil: "networkidle" });
  await importPage.waitForFunction(() => document.querySelector(".workspace-title")?.innerText.includes("字幕文件翻译"));
  await chooseFile(importPage, importPage.getByRole("button", { name: "选择字幕文件", exact: true }), englishSubtitlePath);
  await importPage.waitForFunction(() => document.querySelector(".current-segment-card"));
  assert.equal(await importPage.getByLabel("源语言").inputValue(), "英文", "English subtitle file import should infer English as the source language");
  assert.equal(await importPage.getByLabel("目标语言").inputValue(), "中文", "English subtitle file import should switch target language away from English");
  assert.match(await importPage.locator(".top-export-control").innerText(), /导出原文 SRT/, "English subtitle file import should keep source export available before translation");
  assert.match(await importPage.locator(".top-missing-translation").innerText(), /缺 2 条译文/, "English subtitle file import should keep missing-translation repair visible");
  await importPage.close();
}

(async () => {
try {
  configDir = await mkdtemp(join(tmpdir(), "echo-product-flow-config-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "echo-product-flow-workspace-"));
  sampleSubtitlePath = join(tmpdir(), `echo-product-flow-${Date.now()}.srt`);
  englishSubtitlePath = join(tmpdir(), `echo-product-flow-english-${Date.now()}.srt`);
  riskySubtitlePath = join(tmpdir(), `echo-product-flow-risky-${Date.now()}.srt`);
  fragmentSubtitlePath = join(tmpdir(), `echo-product-flow-fragments-${Date.now()}.srt`);
  longSubtitlePath = join(tmpdir(), `echo-product-flow-long-${Date.now()}.srt`);
  sampleAudioPath = join(tmpdir(), `echo-product-flow-${Date.now()}.wav`);
  sampleVideoPath = join(tmpdir(), `echo-product-flow-${Date.now()}.mp4`);
  termImportPath = join(tmpdir(), `echo-product-flow-terms-${Date.now()}.csv`);
  await writeFile(sampleSubtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:02,000",
    "产品流验收第一句。",
    "",
    "2",
    "00:00:02,000 --> 00:00:04,000",
    "产品流验收第二句。",
    "",
  ].join("\n"));
  await writeFile(englishSubtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:02,332",
    "Previously on The Vampire Diaries...",
    "",
    "2",
    "00:00:02,332 --> 00:00:04,197",
    "You left your son.",
    "",
  ].join("\n"));
  await writeFile(riskySubtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:00,300",
    "这是一条非常非常长并且时间极短的字幕内容",
    "",
    "2",
    "00:00:00,250 --> 00:00:02,000",
    "后一条和上一条时间重叠",
    "",
    "3",
    "00:00:04,000 --> 00:00:04,300",
    "第三条也过短",
    "",
  ].join("\n"));
  await writeFile(fragmentSubtitlePath, [
    "1",
    "00:00:00,000 --> 00:00:00,600",
    "我以为",
    "",
    "2",
    "00:00:00,700 --> 00:00:01,100",
    "我们",
    "",
    "3",
    "00:00:01,200 --> 00:00:02,200",
    "只能给 Kade",
    "",
    "4",
    "00:00:03,500 --> 00:00:05,500",
    "这是完整句子。",
    "",
  ].join("\n"));
  await writeFile(termImportPath, [
    "原文术语,目标译法",
    "\"多模态,检索\",\"multimodal, retrieval\"",
    "\"引号\"\"术语\",\"quoted \"\"term\"\"\"",
    "\"产品路线图\",\"product roadmap\"",
  ].join("\n"));
  const longSubtitleRows = Array.from({ length: 92 }, (_, index) => {
    const start = index * 2;
    const end = start + 2;
    const startClock = `00:${String(Math.floor(start / 60)).padStart(2, "0")}:${String(start % 60).padStart(2, "0")},000`;
    const endClock = `00:${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")},000`;
    return `${index + 1}\n${startClock} --> ${endClock}\n长转写分页第 ${index + 1} 句。`;
  });
  await writeFile(longSubtitlePath, `${longSubtitleRows.join("\n\n")}\n`);
  await writeFile(sampleAudioPath, createSilentWavBuffer());
  await writeFile(sampleVideoPath, Buffer.from("not-a-real-video-but-valid-video-workflow-upload"));

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

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 920 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("echo.provider.v1", JSON.stringify({
      label: "MiniMax 中国区",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M3",
      apiKey: "product-flow-test-key",
      keySource: "input",
      availableModels: [],
    }));
  });
  await page.addInitScript(() => {
    localStorage.setItem("echo.asrProvider.v1", JSON.stringify({
      label: "阿里云百炼 Fun-ASR（中文/多语言）",
      transport: "dashscope-funasr",
      model: "fun-asr",
      functionId: "",
      endpoint: "https://dashscope.aliyuncs.com/api/v1",
      languageCode: "zh",
      sendModel: false,
      videoInputMode: "original",
      apiKey: "product-flow-test-key",
      lastTest: null,
    }));
  });
  await page.addInitScript(() => {
    localStorage.setItem("echo.terms.v1", JSON.stringify([
      { id: 1, source: "吸血鬼日记", target: "The Vampire Diaries" },
    ]));
  });
  await assertDirectWorkbenchBackReturnsHome(context);
  const browserErrors = [];
  let expectedAsrFailureEvents = 0;
  let expectedAsrConnectionFailureEvents = 0;
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (expectedAsrFailureEvents > 0 && /Failed to load resource: the server responded with a status of 400/.test(message.text())) {
      expectedAsrFailureEvents -= 1;
      return;
    }
    if (expectedAsrConnectionFailureEvents > 0 && /Failed to load resource: net::ERR_CONNECTION_FAILED/.test(message.text())) {
      expectedAsrConnectionFailureEvents -= 1;
      return;
    }
    browserErrors.push({ type: "console", text: message.text() });
  });
  page.on("response", async (response) => {
    if (response.status() >= 400) {
      if (expectedAsrFailureEvents > 0 && response.status() === 400 && response.url().includes("/api/asr/transcribe")) {
        expectedAsrFailureEvents -= 1;
        return;
      }
      browserErrors.push({ type: "response", status: response.status(), url: response.url() });
    }
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const tabChrome = await page.evaluate(() => {
    const favicon = document.querySelector('link[rel~="icon"]');
    return {
      title: document.title,
      faviconHref: favicon?.getAttribute("href") || "",
      faviconType: favicon?.getAttribute("type") || "",
    };
  });
  assert.equal(tabChrome.title, "\u00a0", "browser tab should stay icon-only without the full product name");
  assert.match(tabChrome.faviconHref, /\/assets\/brand-icon\.png/, "browser tab favicon should use the uploaded brand icon");
  assert.equal(tabChrome.faviconType, "image/png", "browser tab favicon should point to the PNG brand icon asset");
  assert.match(await page.locator(".workspace-warning").innerText(), /先配置本地工作区/);
  assert.match(await page.locator(".recent-panel").innerText(), /先配置本地工作区/);
  await page.getByPlaceholder("请选择或输入本地工作区路径").fill(workspaceRoot);
  await page.getByRole("button", { name: "保存工作区" }).click();
  await page.waitForFunction(() => !document.querySelector(".workspace-warning"));
  const emptyHomeRecentsLayout = await page.evaluate(() => {
    const panel = document.querySelector(".recent-panel");
    const grid = document.querySelector(".lower-grid");
    const panelRect = panel?.getBoundingClientRect();
    const gridRect = grid?.getBoundingClientRect();
    return {
      panelHeight: Number(panelRect?.height || 0),
      gridHeight: Number(gridRect?.height || 0),
      emptyClass: Boolean(grid?.classList.contains("empty-recents")),
      internalScroll: Boolean(panel && panel.scrollHeight > panel.clientHeight + 2),
    };
  });
  assert.equal(emptyHomeRecentsLayout.emptyClass, true, "Home should mark an empty recent-project state explicitly");
  assert.ok(emptyHomeRecentsLayout.panelHeight > 0 && emptyHomeRecentsLayout.panelHeight <= 150, `empty recent-project card should stay compact instead of filling the page, got ${emptyHomeRecentsLayout.panelHeight}`);
  assert.ok(emptyHomeRecentsLayout.gridHeight <= 160, `empty recent-project container should not reserve unused vertical space, got ${emptyHomeRecentsLayout.gridHeight}`);
  assert.equal(emptyHomeRecentsLayout.internalScroll, false, "empty recent-project state should not expose a useless internal scroll area");
  assert.match(await page.locator(".recent-panel").innerText(), /系统临时目录/, "Home should warn when the configured workspace is temporary instead of implying history is durable");
  assert.equal(existsSync(legacyConfigPath), false, "workspace config should not be written inside the project directory");
  const configuredStatus = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/status");
    return response.json();
  });
  assert.equal(configuredStatus.configured, true);
  assert.equal(configuredStatus.projects.length, 0);
  await page.reload({ waitUntil: "networkidle" });
  await assertBilingualPlainImportInfersLanguage(context);
  await assertEnglishSubtitleFileInfersTranslationDirection(context);

  const invalidOnlyDir = join(workspaceRoot, "projects", "invalid-only-project");
  await mkdir(invalidOnlyDir, { recursive: true });
  await writeFile(join(invalidOnlyDir, "project.json"), "{ invalid project");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  await page.waitForFunction(() => document.querySelector(".projects-panel")?.textContent.includes("1 个本地项目副本不完整"));
  assert.equal(await page.getByRole("button", { name: "清空本地项目" }).isEnabled(), true, "projects page should allow clearing incomplete-only workspace copies");
  await page.getByRole("button", { name: "清空本地项目" }).click();
  assert.match(await page.locator(".projects-panel").innerText(), /包括不完整副本/);
  await page.getByRole("button", { name: "确认清空项目" }).click();
  await page.waitForFunction(() => !document.querySelector(".projects-panel")?.textContent.includes("本地项目副本不完整"));
  assert.match(await page.locator(".project-list").innerText(), /还没有本地项目/);
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.waitForFunction(() => location.hash === "#home");

  const homeCards = await page.evaluate(() => [...document.querySelectorAll(".feature-card")].map((card) => card.innerText));
  assert.equal(homeCards.length, 4);
  assert.deepEqual(homeCards.map((text) => text.split("\n")[0]), ["视频智能字幕", "视频转写", "音频转写", "字幕文件翻译"]);
  assert.equal(homeCards.some((text) => /撰写|写作|Token Plan/.test(text)), false);
  assert.equal(homeCards.some((text) => /调用当前转写服务|上传视频后|上传音频|进入工作台/.test(text)), false, "home cards should not read like implementation notes or duplicate entry links");
  assert.equal(homeCards.every((text) => /SRT|TXT|VTT/.test(text)), true, "home cards should expose expected output formats without extra workflow copy");
  const selectedHomeTitle = await page.locator(".feature-card.selected strong").innerText();
  const selectedHomeFeature = [
    { title: "视频智能字幕", hash: "#workbench/video-subtitles" },
    { title: "视频转写", hash: "#workbench/video-transcribe" },
    { title: "音频转写", hash: "#workbench/audio-transcribe" },
    { title: "字幕文件翻译", hash: "#workbench/subtitle-translate" },
  ].find((item) => item.title === selectedHomeTitle);
  assert.ok(selectedHomeFeature, "home should keep one selected workbench card");
  assert.equal(await page.locator(".hero-row .import-button").count(), 0, "home should not expose a duplicate primary entry beside the workbench cards");
  await page.getByText(selectedHomeFeature.title, { exact: true }).click();
  await page.waitForFunction((hash) => location.hash === hash, selectedHomeFeature.hash);
  assert.match(await page.locator(".workspace-title").innerText(), new RegExp(selectedHomeFeature.title));
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.waitForFunction(() => location.hash === "#home");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".hero-row .import-button").count(), 0, "mobile home should keep the workbench card grid as the entry surface");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForTimeout(200);
  await page.getByRole("navigation").getByRole("button", { name: "模型配置" }).click();
  await page.locator("label").filter({ hasText: "ASR API Key" }).locator("input").fill("");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("视频转写", { exact: true }).click();
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  const unconfiguredAsrCopy = await page.locator(".action-panel").innerText();
  assert.match(unconfiguredAsrCopy, /转写服务未配置/, "setup workbench should state the real blocker when ASR key is missing");
  assert.match(unconfiguredAsrCopy, /配置转写服务/, "setup workbench should provide a direct path to fix the missing transcription service");
  assert.doesNotMatch(unconfiguredAsrCopy, /当前不能开始转写/, "setup workbench should avoid repeating the same ASR blocker in multiple warning blocks");
  assert.doesNotMatch(unconfiguredAsrCopy, /当前配置会直接提交/, "setup workbench should not imply unconfigured ASR can submit media");
  await page.locator(".action-panel").getByRole("button", { name: "配置转写服务" }).click();
  await page.waitForFunction(() => location.hash === "#models/asr");
  assert.equal(await page.getByRole("button", { name: "转写服务", exact: true }).evaluate((node) => node.classList.contains("active")), true, "ASR blocker should open the transcription-service config panel");
  assert.equal(await page.locator("label").filter({ hasText: "ASR API Key" }).locator("input").isVisible(), true, "ASR blocker should land on the ASR key field, not the text-model panel");
  await page.locator("label").filter({ hasText: "ASR API Key" }).locator("input").fill("product-flow-test-key");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.waitForFunction(() => location.hash === "#home");
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  assert.match(await page.locator(".workspace-title").innerText(), /视频转写/, "opening a workbench hash directly should not be overwritten by the default home route");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#home");
  assert.equal(await page.locator(".feature-grid").isVisible(), true, "browser back from a direct workbench route should return to the home chooser");
  await page.goto(`${baseUrl}/#workbench/video-transcribe`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.waitForFunction(() => location.hash === "#home");

  await page.goto(`${baseUrl}/#workbench/subtitle-translate`, { waitUntil: "networkidle" });
  await page.locator(".inline-status-group button").filter({ hasText: /文本模型/ }).click();
  await page.waitForFunction(() => location.hash === "#models/text");
  assert.equal(await page.getByRole("button", { name: "文本模型", exact: true }).evaluate((node) => node.classList.contains("active")), true, "text-model status should open the text-model config panel");
  assert.equal(await page.getByLabel("文本模型提供方").isVisible(), true, "text-model status should land on text model provider settings");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => location.hash === "#models/text");
  assert.equal(await page.getByRole("button", { name: "文本模型", exact: true }).evaluate((node) => node.classList.contains("active")), true, "text-model config route should survive page refresh");
  assert.equal(await page.getByLabel("文本模型提供方").isVisible(), true, "refreshed text-model route should still show provider settings");
  await page.locator("label").filter({ hasText: /^API Key/ }).locator("input").fill("");
  assert.match(await page.locator(".config-actions").innerText(), /API Key/, "disabled text-model actions should explain the missing API Key prerequisite");
  const textModelPanelLayout = await page.evaluate(() => {
    const panel = document.querySelector(".text-model-config-panel")?.getBoundingClientRect();
    const form = document.querySelector(".text-model-config-panel .form-grid")?.getBoundingClientRect();
    const state = document.querySelector(".text-model-config-panel .config-state")?.getBoundingClientRect();
    const list = document.querySelector(".text-model-config-panel .model-list")?.getBoundingClientRect();
    const listHead = document.querySelector(".text-model-config-panel .model-list-head")?.getBoundingClientRect();
    return {
      panelHeight: Math.round(panel?.height || 0),
      formBottom: Math.round(form?.bottom || 0),
      stateTop: Math.round(state?.top || 0),
      listTop: Math.round(list?.top || 0),
      listHeadText: document.querySelector(".text-model-config-panel .model-list-head")?.textContent || "",
      listHeadVisible: Boolean(listHead && listHead.bottom <= window.innerHeight && listHead.top >= 0),
    };
  });
  assert.ok(textModelPanelLayout.panelHeight <= 620, `text model panel should not reserve a full empty viewport, got ${JSON.stringify(textModelPanelLayout)}`);
  assert.ok(textModelPanelLayout.stateTop - textModelPanelLayout.formBottom <= 28, `text model status should follow the form without a large blank gap, got ${JSON.stringify(textModelPanelLayout)}`);
  assert.match(textModelPanelLayout.listHeadText, /预设模型/, "text model quick-pick list should be labeled instead of appearing as unlabeled chips");
  assert.equal(textModelPanelLayout.listHeadVisible, true, "text model quick-pick label should stay visible in the first viewport");
  await page.locator("label").filter({ hasText: /^API Key/ }).locator("input").fill("product-flow-test-key");
  await page.getByRole("button", { name: "保存配置" }).click();
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.waitForFunction(() => location.hash === "#home");

  for (const spec of [
    { title: "视频智能字幕", id: "video-subtitles", mediaTitle: "视频与字幕", startExpected: true },
    { title: "视频转写", id: "video-transcribe", mediaTitle: "视频与转写", startExpected: true },
    { title: "音频转写", id: "audio-transcribe", mediaTitle: "音频与转写", startExpected: true },
    { title: "字幕文件翻译", id: "subtitle-translate", mediaTitle: "字幕文件", startExpected: false },
  ]) {
    await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
    await page.getByText(spec.title, { exact: true }).click();
    await page.waitForFunction((hash) => location.hash === hash, `#workbench/${spec.id}`);
    await page.waitForLoadState("networkidle");
    assert.match(await page.locator(".media-panel .panel-head h2").innerText(), new RegExp(spec.mediaTitle), "media panel title should match the active workbench task");
    assert.equal(await page.getByLabel("源语言").inputValue(), "中文", `${spec.title} should default source language to Chinese`);
    assert.equal(await page.getByLabel("目标语言").inputValue(), "英文", `${spec.title} should default target language to English`);
    await assertWorkbenchLayout(page, spec);
  }
  await assertMobileWorkbenchLayout(page);
  await assertNarrowSetupWorkbenchLayout(page);
  await assertMobileManualImportLandsAtReviewTop(page);
  await assertMobileBilingualExportActionReadable(page);

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.waitForFunction(() => location.hash === "#home");
  await page.getByText("视频转写", { exact: true }).click();
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#home");
  assert.equal(await page.locator(".feature-grid").isVisible(), true, "browser back after opening a home card should return to the home chooser");
  await page.getByText("视频转写", { exact: true }).click();
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await page.locator(".workspace-title .crumb").click();
  await page.waitForFunction(() => location.hash === "#home");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  assert.match(await page.locator(".workspace-title").innerText(), /视频转写/, "browser back from home should return to the previous workbench route");
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 0, "setup workbench should not show inactive undo after browser back restores it");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#home");

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("视频转写", { exact: true }).click();
  await page.waitForFunction(() => location.hash === "#workbench/video-transcribe");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "粘贴转写", exact: true }).click();
  await page.getByPlaceholder("粘贴已有逐字稿、TXT、SRT 或 VTT 内容").fill([
    "[00:00:05 - 00:00:08] Speaker 1: 带时间范围的开场，需要保留更完整的项目名称用于历史恢复",
    "00:00:08 --> 00:00:12 Speaker: Explicit range line",
    "00:00:12.500 - 00:00:14.000 旁白: 小数时间范围",
  ].join("\n"));
  await page.getByRole("button", { name: "导入文本", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".subtitle-table .table-row").length - 1 === 4);
  const rangedImportRows = await page.evaluate(() => [...document.querySelectorAll(".review-list-row")].map((row) => row.innerText));
  assert.match(rangedImportRows[0], /00:05.000 - 00:06.000/);
  assert.match(rangedImportRows[0], /Speaker 1/, "proofreading rows should display parsed speaker labels without requiring speaker editing");
  assert.match(rangedImportRows[0], /带时间范围的开场/);
  assert.doesNotMatch(rangedImportRows[0], /Speaker 1:/);
  assert.match(rangedImportRows[1], /00:06.000 - 00:08.000/);
  assert.match(rangedImportRows[1], /需要保留更完整的项目名称用于历史恢复/, "long imported transcript rows should be split into readable proofreading rows");
  assert.match(rangedImportRows[2], /00:08.000 - 00:12.000/);
  assert.match(rangedImportRows[2], /Speaker/, "proofreading rows should keep speaker labels visible when imported from text");
  assert.match(rangedImportRows[2], /Explicit range line/);
  assert.match(rangedImportRows[3], /00:12.500 - 00:14.000/);
  assert.match(rangedImportRows[3], /旁白/, "localized speaker labels should remain visible in the proofreading list");
  assert.match(rangedImportRows[3], /小数时间范围/);
  assert.equal(await page.locator(".top-export-mode-control").count(), 0, "plain transcription results should not show an export-mode switcher when only source export is available");
  assert.match(await page.locator(".top-export-control").innerText(), /导出 TXT/, "plain transcription results should still export the source transcript");
  const manualImportRecent = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem("echo.recents.v1") || "[]");
    return data.find((item) => /导入文本 · 4 条/.test(item.meta || "")) || null;
  });
  assert.ok(manualImportRecent, "manual text import should create a recoverable recent project");
  assert.match(manualImportRecent.name, /带时间范围的开场/, "manual text import should derive the project name from the transcript content");
  assert.match(manualImportRecent.name, /历史恢复/, "manual text import project names should preserve enough context for history recovery");
  assert.doesNotMatch(manualImportRecent.name, /\.\.\.$/, "manual text import project names should not store a data-layer ellipsis");
  assert.doesNotMatch(manualImportRecent.name, /Speaker|00:|手动导入转写文本/, "derived project name should avoid parser noise and repeated default labels");
  assert.equal(await page.getByLabel("导出格式").isVisible(), true, "export format selector should have a concise accessible label");
  assert.equal(await page.getByRole("button", { name: "导出 TXT", exact: true }).isVisible(), true, "export button should have a clean accessible name separate from the format selector");
  const exportOptionsButtonLayout = await page.evaluate(() => {
    const button = document.querySelector(".export-settings-trigger");
    const rect = button?.getBoundingClientRect();
    return {
      text: button?.textContent?.trim() || "",
      width: Math.round(rect?.width || 0),
    };
  });
  assert.equal(exportOptionsButtonLayout.text, "选项", `TXT/MD export options should be explicit instead of a bare gear icon, got ${JSON.stringify(exportOptionsButtonLayout)}`);
  assert.ok(exportOptionsButtonLayout.width <= 84, `TXT/MD export options should stay compact in the top bar, got ${JSON.stringify(exportOptionsButtonLayout)}`);
  await page.getByRole("button", { name: "展开导出设置" }).click();
  const exportSettingsGroup = page.getByRole("group", { name: "TXT 和 Markdown 导出设置" });
  assert.equal(await exportSettingsGroup.isVisible(), true, "TXT/MD export settings should be available without adding another large toolbar button");
  await exportSettingsGroup.getByRole("checkbox", { name: "时间码" }).uncheck();
  await exportSettingsGroup.getByRole("checkbox", { name: "说话人" }).uncheck();
  const cleanTranscriptDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 TXT", exact: true }).click();
  const cleanTranscriptDownload = await cleanTranscriptDownloadPromise;
  const cleanTranscriptText = await readDownloadText(cleanTranscriptDownload);
  assert.match(cleanTranscriptText, /^带时间范围的开场/m, "TXT export settings should support a clean transcript without timecodes or speakers");
  assert.doesNotMatch(cleanTranscriptText, /Speaker 1|00:05\.000|\[/, "clean TXT export should omit speaker labels and timestamp brackets");
  await exportSettingsGroup.getByRole("checkbox", { name: "时间码" }).check();
  await exportSettingsGroup.getByRole("checkbox", { name: "说话人" }).check();
  await page.getByRole("button", { name: "收起导出设置" }).click();
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).isEnabled(), true, "undo should remain available immediately after importing text into a new local project");
  assert.match(await page.getByRole("button", { name: "撤销", exact: true }).getAttribute("title"), /Cmd\/Ctrl\+Z/, "undo should expose the standard shortcut in its tooltip");
  assert.match(await page.getByRole("button", { name: "确认当前段并跳到下一段", exact: true }).getAttribute("title"), /Cmd\/Ctrl\+Enter/, "confirm-next should expose its keyboard shortcut without adding visible helper copy");
  const currentSegmentNavButtons = await page.evaluate(() => ["上一段", "下一段"].map((label) => {
    const button = document.querySelector(`.current-segment-controls button[aria-label="${label}"]`);
    const icon = button?.querySelector("svg");
    const rect = button?.getBoundingClientRect();
    const iconRect = icon?.getBoundingClientRect();
    const style = button ? getComputedStyle(button) : null;
    return {
      label,
      exists: Boolean(button),
      text: button?.textContent?.trim() || "",
      width: Number(rect?.width || 0),
      height: Number(rect?.height || 0),
      iconWidth: Number(iconRect?.width || 0),
      opacity: style?.opacity || "",
    };
  }));
  assert.ok(currentSegmentNavButtons.every((button) => button.exists && button.width >= 28 && button.height >= 28 && button.iconWidth >= 14), "current-segment previous/next controls should be visible icon buttons");
  assert.equal(currentSegmentNavButtons.find((button) => button.label === "上一段")?.opacity, "1", "disabled current-segment previous button should remain visually identifiable");
  await assertWorkbenchLayout(page, { title: "视频转写", startExpected: true, hasResults: true, expectsMediaPanel: false });
  assert.deepEqual(await readCurrentSegmentFieldLabels(page), ["转写原文"], "source-only transcription should label the editable source text and not imply translation exists");
  const sourceOnlyCurrentTools = await page.evaluate(() => {
    const tools = document.querySelector(".current-row-tools");
    const split = tools?.querySelector(".split-row")?.getBoundingClientRect();
    const merge = tools?.querySelector(".merge-row")?.getBoundingClientRect();
    const translate = tools?.querySelector(".translate-row")?.getBoundingClientRect();
    const del = tools?.querySelector(".row-delete")?.getBoundingClientRect();
    return {
      hasTranslate: Boolean(translate),
      splitWidth: Math.round(split?.width || 0),
      mergeWidth: Math.round(merge?.width || 0),
      deleteWidth: Math.round(del?.width || 0),
      deleteTop: Math.round(del?.top || 0),
      splitTop: Math.round(split?.top || 0),
      mergeTop: Math.round(merge?.top || 0),
      buttons: [...tools?.querySelectorAll(".row-action, .row-delete") || []].map((button) => {
        const rect = button.getBoundingClientRect();
        const icon = button.querySelector("svg")?.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label") || "",
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          iconWidth: Math.round(icon?.width || 0),
        };
      }),
    };
  });
  assert.equal(sourceOnlyCurrentTools.hasTranslate, false, "source-only current segment tools should not reserve a hidden translate button");
  assert.equal(sourceOnlyCurrentTools.deleteWidth, sourceOnlyCurrentTools.splitWidth, `source-only delete should use the same icon-button size as split and merge instead of spanning a row: ${JSON.stringify(sourceOnlyCurrentTools)}`);
  assert.equal(sourceOnlyCurrentTools.deleteTop, sourceOnlyCurrentTools.splitTop, `source-only row tools should stay in one compact tool row when translation is not active: ${JSON.stringify(sourceOnlyCurrentTools)}`);
  assert.ok(
    sourceOnlyCurrentTools.buttons.every((button) => button.width >= 28 && button.height >= 28 && button.iconWidth >= 14),
    `source-only row actions should keep usable icon-button click targets: ${JSON.stringify(sourceOnlyCurrentTools.buttons)}`,
  );
  assert.equal(await page.getByLabel("当前段落校对稿").count(), 1, "current segment source editor should keep an accessible label");
  await page.getByRole("button", { name: "复制当前段", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".message, .workbench-toast")].some((node) => node.textContent?.includes("已复制当前段落")));
  assert.match(await readWorkbenchFeedback(page), /已复制当前段落/, "current segment copy should perform a real clipboard action instead of exposing a decorative button");
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /\[00:05\.000 - 00:06\.000\][\s\S]*校对稿：带时间范围的开场/, "current segment copy should include split timing and current text");
  await page.getByRole("button", { name: "复制全文", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".message, .workbench-toast")].some((node) => node.textContent?.includes("已复制全文")));
  const cleanCopiedTranscript = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(cleanCopiedTranscript, /带时间范围的开场[\s\S]*Explicit range line[\s\S]*小数时间范围/, "copy all should copy the corrected transcript body");
  assert.doesNotMatch(cleanCopiedTranscript, /\[00:|00:05\.000|Speaker 1:/, "copy all should omit timecodes and speaker prefixes for clean pasting");
  await page.locator(".review-list-row").first().click();
  await page.locator(".current-segment-card .subtitle-source-textarea").fill("我们先看整体结论然后再处理细节如果还有问题继续复核不要把这种错误作为提示交给用户解决而是作为功能问题解决。");
  await page.locator(".workspace-title").click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length > 4);
  const manuallyRepairedRows = await page.evaluate(() => [...document.querySelectorAll(".review-list-row")].map((row) => row.innerText));
  assert.match(manuallyRepairedRows.join("\n"), /我们先看整体结论[\s\S]*然后再处理细节[\s\S]*如果还有问题继续复核/, "manual source edits should be split into readable proofreading rows on blur");
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /单条过长/, "manual source edits should not leave an oversized segment for the user to fix");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);
  assert.match(await page.locator(".review-list-row").first().innerText(), /带时间范围的开场/);
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length > 4);
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /单条过长/, "redo should restore the repaired split rows instead of reviving an oversized segment");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);
  await assertNarrowNoMediaResultLayout(page, "视频转写");
  const topHistoryLayout = await page.evaluate(() => [...document.querySelectorAll(".top-history-control button")].map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      text: button.innerText.trim(),
      width: rect.width,
      height: rect.height,
      visible: rect.width > 44 && rect.height >= 34,
    };
  }));
  assert.deepEqual(topHistoryLayout.map((button) => button.text), ["撤销", "重做"], "result-mode history controls should live in the top toolbar");
  assert.ok(topHistoryLayout.every((button) => button.visible), "top undo/redo controls should stay visibly recognizable, not icon-only buttons");
  assert.equal(await page.locator(".subtitle-editor .top-history-control, .editor-history-button").count(), 0, "proofreading card should not duplicate global undo/redo controls");
  assert.equal(await page.getByRole("button", { name: "关联视频", exact: true }).isVisible(), false, "text-only result state should keep optional media association folded by default");
  await openMediaAssociation(page);
  assert.equal(await page.getByRole("button", { name: "关联视频", exact: true }).isVisible(), true, "expanding media association should expose the optional media-linking action");
  assert.match(
    await page.getByRole("button", { name: "关联视频", exact: true }).locator("svg").getAttribute("class"),
    /lucide-download/,
    "associating a local media file should use the import/down arrow icon",
  );
  assert.match(
    await page.getByRole("button", { name: "替换转写文件", exact: true }).locator("svg").getAttribute("class"),
    /lucide-download/,
    "importing transcript/subtitle text should use the import/down arrow icon",
  );
  assert.match(
    await page.getByRole("button", { name: /导出 TXT/ }).locator("svg").getAttribute("class"),
    /lucide-upload/,
    "exporting a file should use the export/up arrow icon",
  );
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).isEnabled(), true, "proofreading undo should be visible and enabled in result mode");
  assert.equal(await page.getByRole("button", { name: "重做", exact: true }).isEnabled(), true, "redo should remain available after undoing the manual structure repair check");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".subtitle-editor") && document.querySelectorAll(".review-list-row").length === 0);
  assert.equal(await page.getByRole("button", { name: "重做", exact: true }).isEnabled(), true, "redo should remain visible after undoing the initial text import");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);
  await openActionDetails(page, ".time-sync-details");
  await page.getByLabel("时间偏移秒数").fill("0.7");
  await page.getByRole("button", { name: "整体延后", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:05.700 - 00:06.700"));
  assert.match(await page.locator(".review-list-row").first().innerText(), /00:05.700 - 00:06.700/, "time sync should shift all row timecodes later by the configured offset");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:05.000 - 00:06.000"));
  await page.getByRole("button", { name: "整体提前", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:04.300 - 00:05.300"));
  assert.match(await page.locator(".review-list-row").first().innerText(), /00:04.300 - 00:05.300/, "time sync should shift all row timecodes earlier by the configured offset");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:05.000 - 00:06.000"));
  await openMediaAssociation(page);
  await chooseFile(page, page.getByRole("button", { name: "替换转写文件", exact: true }), riskySubtitlePath);
  await page.waitForFunction(() => /\d+ 条/.test(document.querySelector(".replace-import-confirm")?.textContent || ""));
  await page.getByRole("button", { name: "确认替换", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length >= 4);
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /时长过短|阅读过快/, "imported risky timelines should be expanded when safe instead of leaving timing pressure for the user");
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /时间重叠|时间无效/, "imported risky timelines should be normalized before entering proofreading");
  assert.equal(await page.locator(".current-segment-card .split-row").isDisabled(), false, "repaired risky segments should remain editable instead of being locked by invalid timing");
  const repairStatus = page.locator(".workbench-quick-state");
  assert.doesNotMatch(await repairStatus.innerText(), /需修复/, "timeline issues should be repaired by the system instead of becoming user-facing export blockers");
  assert.equal(await repairStatus.isEnabled(), false, "timeline-only issues should not expose a manual repair status action");
  assert.equal(await page.getByRole("button", { name: "跳到下一处质量提示", exact: true }).count(), 0, "repairable structure issues should not appear as user-facing quality prompts");
  assert.equal(await page.getByRole("button", { name: /拆分 .* 条过长段落/ }).count(), 0, "long subtitle splitting should run automatically instead of becoming a manual repair button");
  const exportButtonAfterTimingIssue = page.locator(".top-export-control .primary");
  assert.match(await exportButtonAfterTimingIssue.innerText(), /导出 TXT/, "top export should remain available because timing issues are automatically repaired");
  assert.match(await exportButtonAfterTimingIssue.locator("svg").getAttribute("class"), /lucide-upload/, "available export action should keep the export arrow icon");
  assert.equal(await page.locator(".row-quality-badge").count(), 0, "system repair should clear timing quality hints on repairable risky subtitle rows");
  const repairedTimingDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 TXT", exact: true }).click();
  const repairedTimingDownload = await repairedTimingDownloadPromise;
  const repairedTimingText = await readDownloadText(repairedTimingDownload);
  assert.match(repairedTimingText, /时间极短|第三条也过短/, "export should continue after automatically repairing timeline issues");
  assert.doesNotMatch(repairedTimingText, /上一条\\n一条/, "automatic repair should not split common Chinese terms across subtitle rows");
  assert.doesNotMatch(await readWorkbenchFeedback(page), /请修正|时间轴问题/, "timeline repair should not push structural errors back to the user");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".current-segment-card textarea")?.value.includes("带时间范围的开场"));
  assert.equal(await page.locator(".media-panel").count(), 0, "text-import result state should not keep an empty media card");
  await openMediaAssociation(page);
  assert.equal(await page.getByRole("button", { name: "关联视频", exact: true }).isVisible(), true, "expanded text-import result state should keep media association available");
  assert.equal(await page.getByRole("button", { name: "替换转写文件", exact: true }).isVisible(), true, "text-import result state should keep replace transcript as a compact processing action");
  await page.getByRole("button", { name: "添加段落", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".current-segment-card textarea")?.value.includes("新转写段落"));
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /时间重叠|时间无效/, "adding a proofreading segment should normalize the timeline immediately");
  const singleSpeakerAssignment = page.getByLabel("当前段落说话人归属");
  await singleSpeakerAssignment.waitFor({ state: "visible" });
  assert.equal(await singleSpeakerAssignment.inputValue(), "未标注", "new unlabeled segments should expose speaker assignment when known speakers exist");
  await singleSpeakerAssignment.selectOption("Speaker 1");
  await page.waitForFunction(() => document.querySelector("[aria-label='当前段落说话人归属']")?.value === "Speaker 1");
  assert.match(await page.locator(".review-list-row.selected-row").innerText(), /Speaker 1/, "assigning an unlabeled segment to a known speaker should update the review list");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[aria-label='当前段落说话人归属']")?.value === "未标注");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);
  await chooseFile(page, page.getByRole("button", { name: "关联视频" }), sampleVideoPath);
  await page.waitForFunction(() => document.querySelector(".media-preview video") && document.querySelectorAll(".review-list-row").length === 4);
  assert.match(await readWorkbenchFeedback(page), /已关联[\s\S]*已保留 4 条转写段落/);
  assert.match(await readCorrectionTableValues(page), /带时间范围的开场/);
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.waitForTimeout(200);
  const mediumResultToolbarLayout = await inspectWorkbenchLayout(page);
  assert.equal(mediumResultToolbarLayout.editorInViewport, true, "medium-width video result state should keep the proofreading card fully inside the viewport");
  assert.equal(mediumResultToolbarLayout.editorToolsInViewport, true, "medium-width video result state should keep proofreading tools fully visible");
  assert.equal(mediumResultToolbarLayout.addSegmentInViewport, true, "medium-width video result state should not clip the add-segment action");
  assert.equal(mediumResultToolbarLayout.reviewTitleOverlapsTools, false, "medium-width video result state should not let proofreading toolbar overlap the title");
  assert.equal(mediumResultToolbarLayout.tableOverflowsHorizontally, false, "medium-width video result state should not make proofreading rows scroll horizontally");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".media-preview video") && !document.querySelector(".media-panel") && document.querySelectorAll(".review-list-row").length === 4);
  await openMediaAssociation(page);
  assert.equal(await page.getByRole("button", { name: "关联视频", exact: true }).isVisible(), true, "expanded folded association should still expose the media-linking action");

  await chooseFile(page, page.getByRole("button", { name: "替换转写文件", exact: true }), sampleSubtitlePath);
  await page.waitForFunction(() => document.querySelector(".replace-import-confirm")?.textContent.includes("替换当前校对表"));
  assert.equal(await page.locator(".review-list-row").count(), 4, "importing over existing review rows should wait for explicit confirmation");
  assert.match(await readWorkbenchFeedback(page), /请确认后继续/);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".replace-import-confirm"));
  assert.equal(await page.locator(".review-list-row").count(), 4, "canceling import replacement should keep existing rows");
  await chooseFile(page, page.getByRole("button", { name: "替换转写文件", exact: true }), sampleSubtitlePath);
  await page.waitForFunction(() => document.querySelector(".replace-import-confirm")?.textContent.includes("2 条"));
  await page.getByRole("button", { name: "确认替换", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 2);
  assert.match(await readCorrectionTableValues(page), /产品流验收第一句/);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);
  assert.match(await readCorrectionTableValues(page), /带时间范围的开场/);

  await chooseFile(page, page.getByRole("button", { name: "替换转写文件", exact: true }), fragmentSubtitlePath);
  await page.waitForFunction(() => document.querySelector(".replace-import-confirm")?.textContent.includes("2 条"));
  await page.getByRole("button", { name: "确认替换", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 2);
  assert.match(await readCorrectionTableValues(page), /我以为我们只能给 Kade/, "short ASR fragments should merge before entering proofreading");
  assert.match(await readWorkbenchFeedback(page), /已自动合并 2 条短碎片/, "import feedback should explain automatic short-fragment merging");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);

  await page.getByLabel("查找校对内容").fill("Explicit");
  await page.getByRole("button", { name: "打开替换", exact: true }).click();
  await page.locator(".replace-toolbar input").fill("Replaced line");
  await page.getByRole("button", { name: "替换当前", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".current-segment-card textarea")].some((field) => field.value.includes("Replaced line")));
  assert.match(await readCorrectionTableValues(page), /Replaced line/);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".current-segment-card textarea")].some((field) => field.value.includes("Explicit range line")));
  await page.getByLabel("查找校对内容").fill("时间");
  await page.locator(".replace-toolbar input").fill("时段");
  await page.getByRole("button", { name: "全部替换", exact: true }).click();
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll(".review-list-row")].map((row) => row.innerText).join("\n");
    return text.includes("带时段范围的开场") && text.includes("小数时段范围");
  });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll(".review-list-row")].map((row) => row.innerText).join("\n");
    return text.includes("带时间范围的开场") && text.includes("小数时间范围");
  });
  await page.getByLabel("查找校对内容").fill("");
  await page.getByRole("button", { name: "收起替换", exact: true }).click();

  await page.locator(".review-list-row").first().click();
  await page.locator(".current-segment-card .subtitle-source-textarea").focus();
  await page.evaluate(() => {
    const field = document.querySelector(".current-segment-card .subtitle-source-textarea");
    const splitIndex = field.value.indexOf("范围");
    field.setSelectionRange(splitIndex, splitIndex);
    field.dispatchEvent(new Event("select", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  });
  await page.getByRole("button", { name: "拆分段落", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 5);
  const cursorSplitRows = await page.evaluate(() => [...document.querySelectorAll(".review-list-row")].map((row) => row.innerText));
  assert.match(cursorSplitRows[0], /带时间/);
  assert.match(cursorSplitRows[1], /范围的开场/);
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /时间重叠|时间无效|单条过长/, "manual split should run the same structure repair path as import and export");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);

  await page.getByLabel("当前段落开始时间").fill("00:04.500");
  await page.getByLabel("当前段落开始时间").press("Enter");
  await page.getByLabel("当前段落结束时间").fill("00:07.500");
  await page.getByLabel("当前段落结束时间").press("Enter");
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:04.500 - 00:06.750"));
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /时间重叠|时间无效/, "manual time edits should be normalized immediately instead of leaving timeline errors for the user");
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /单条过长/, "manual time edits should use the full review repair path, not only timeline normalization");
  const speakerAssignment = page.getByLabel("当前段落说话人归属");
  await speakerAssignment.waitFor({ state: "visible" });
  assert.equal(await speakerAssignment.inputValue(), "Speaker 1", "current segment should show the parsed speaker in a compact assignment control");
  assert.equal(await page.getByRole("textbox", { name: "当前段落说话人", exact: true }).count(), 0, "proofreading focus card should not expose a full speaker editing box");
  await page.locator(".speaker-map-details summary").click();
  await page.getByLabel("将说话人 Speaker 1 重命名为").fill("Damon");
  await page.getByLabel("将说话人 Speaker 1 重命名为").press("Enter");
  await page.waitForFunction(() => document.querySelector("[aria-label='当前段落说话人归属']")?.value === "Damon");
  assert.match(await page.locator(".review-list-row").first().innerText(), /Damon/, "renaming a speaker should update the review list");
  const renamedSpeakerDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出 TXT/ }).click();
  const renamedSpeakerDownload = await renamedSpeakerDownloadPromise;
  assert.match(await readDownloadText(renamedSpeakerDownload), /\[00:04.500\] Damon: 带时间范围的开场/, "export should use the corrected speaker label");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("Speaker 1"));
  await page.locator(".review-list-row").first().click();
  await page.waitForFunction(() => document.querySelector("[aria-label='当前段落说话人归属']")?.value === "Speaker 1");
  await speakerAssignment.selectOption("Speaker");
  await page.waitForFunction(() => document.querySelector("[aria-label='当前段落说话人归属']")?.value === "Speaker");
  assert.match(await page.locator(".review-list-row").first().innerText(), /Speaker/, "reassigning the current segment speaker should update the review list");
  const reassignedSpeakerDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出 TXT/ }).click();
  const reassignedSpeakerDownload = await reassignedSpeakerDownloadPromise;
  assert.match(await readDownloadText(reassignedSpeakerDownload), /\[00:04.500\] Speaker: 带时间范围的开场/, "export should use the reassigned segment speaker");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("Speaker 1"));
  await page.locator(".review-list-row").first().click();
  await page.waitForFunction(() => document.querySelector("[aria-label='当前段落说话人归属']")?.value === "Speaker 1");
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:04.500 - 00:06.750"));
  const editedRangeDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出 TXT/ }).click();
  const editedRangeDownload = await editedRangeDownloadPromise;
  const editedRangeText = await readDownloadText(editedRangeDownload);
  assert.match(editedRangeText, /\[00:04.500\] Speaker 1: 带时间范围的开场/);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:04.500 - 00:06.000"));
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".review-list-row")?.innerText.includes("00:05.000 - 00:06.000"));
  await page.locator(".review-list-row").nth(1).click();
  await page.getByRole("button", { name: "添加段落" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 5);
  const insertedRows = await page.evaluate(() => [...document.querySelectorAll(".review-list-row")].map((row) => row.innerText));
  assert.match(insertedRows[2], /新转写段落/, "adding a proofreading segment should insert after the current segment");
  assert.match(insertedRows[3], /Explicit range line/);
  assert.match(insertedRows[4], /小数时间范围/);
  assert.doesNotMatch(await page.locator(".current-segment-card").innerText(), /时间重叠|时间无效/, "inserted proofreading segment should not overlap the following row");
  assert.match(await page.locator(".current-segment-card").innerText(), /3\/5/);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);
  assert.equal(await page.getByRole("button", { name: "重做", exact: true }).isEnabled(), true, "redo should become available after undoing a segment insertion");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 5);
  assert.match(await page.locator(".current-segment-card").innerText(), /3\/5/);
  await page.locator(".review-list-row").first().click();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 4);

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("视频智能字幕", { exact: true }).click();
  await page.waitForLoadState("networkidle");
  await chooseFile(page, page.getByRole("button", { name: "上传视频", exact: true }).first(), sampleVideoPath);
  await page.waitForTimeout(500);
  await chooseFile(page, page.getByRole("button", { name: "导入字幕文件", exact: true }), sampleSubtitlePath);
  await page.waitForTimeout(900);
  assert.match(await page.locator(".video-subtitle-preview").innerText(), /产品流验收第一句/);
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2);
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: true, withTranslation: false, translationEditors: 0 });
  assert.deepEqual(await readCurrentSegmentFieldLabels(page), ["字幕原文"], "subtitle proofreading should show source subtitles only before translation is requested");
  await assertWorkbenchLayout(page, { title: "视频智能字幕", startExpected: true, hasResults: true });
  await assertNoReviewStatsOrFilters(page);
  await waitForWorkspaceSaved(page);
  assert.equal(await beforeUnloadIsPrevented(page), false, "saved recoverable projects should not warn on refresh");
  await assertUndoRestoresCurrentText(page, "产品流撤销校验第一句。");
  await waitForWorkspaceSaved(page);
  assert.equal(await beforeUnloadIsPrevented(page), false, "saved edits should not keep the refresh warning active");
  await assertSegmentReplayControls(page);
  await assertEditorKeyboardNavigation(page);
  await assertWorkbenchFindShortcut(page);
  await assertConfirmStatusCanUndo(page);
  const resultProjectHash = await page.evaluate(() => location.hash);
  assert.match(resultProjectHash, /^#workbench\/video-subtitles\/project-/, "result-state workbench should have a recoverable project route");
  await page.locator(".workspace-title .crumb").click();
  await page.waitForFunction(() => location.hash === "#home");
  await page.goBack();
  await page.waitForFunction((expectedHash) => location.hash === expectedHash, resultProjectHash);
  await page.waitForFunction(() => document.querySelector(".workspace-title")?.innerText.includes("视频智能字幕") && document.querySelector(".subtitle-editor"));
  assert.equal(await page.locator(".subtitle-editor").isVisible(), true, "browser back to a result project route should restore the workbench content, not just the hash");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#home");
  await page.waitForFunction(() => document.querySelector(".feature-grid"));
  assert.equal(await page.locator(".feature-grid").isVisible(), true, "browser back should return to the home workbench chooser");
  await page.getByText("视频智能字幕", { exact: true }).click();
  await page.waitForFunction(() => location.hash === "#workbench/video-subtitles");
  await page.locator(".workspace-title .crumb").click();
  await page.waitForFunction(() => location.hash === "#home");
  assert.equal(await page.locator(".feature-grid").isVisible(), true, "workbench breadcrumb home should return to the home workbench chooser");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#workbench/video-subtitles");
  assert.match(await page.locator(".workspace-title").innerText(), /视频智能字幕/, "browser back after breadcrumb home should return to the previous workbench route");

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("字幕文件翻译", { exact: true }).click();
  await page.waitForLoadState("networkidle");
  await assertWorkbenchLayout(page, { title: "字幕文件翻译", startExpected: false });

  await chooseFile(page, page.getByRole("button", { name: "选择字幕文件", exact: true }), sampleSubtitlePath);
  await page.waitForTimeout(900);
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2);
  assert.match(await readCorrectionTableValues(page), /产品流验收第一句/);
  assert.equal(await page.locator(".subtitle-source-summary").isVisible(), true, "subtitle file result state should show the imported source summary");
  const subtitleSummaryLayout = await page.evaluate(() => {
    const summary = document.querySelector(".subtitle-source-summary");
    const info = summary?.querySelector("div");
    const infoRect = info?.getBoundingClientRect();
    return {
      infoWidth: Math.round(infoRect?.width || 0),
      hasActions: Boolean(summary?.querySelector(".subtitle-source-actions")),
    };
  });
  assert.ok(subtitleSummaryLayout.infoWidth >= 180, `subtitle source summary should leave readable width for file info, got ${subtitleSummaryLayout.infoWidth}`);
  assert.equal(subtitleSummaryLayout.hasActions, false, "subtitle source summary should not duplicate replace or translate actions");
  assert.equal(await page.locator(".media-panel .dropzone").count(), 0, "subtitle file result state should not show a fresh import dropzone");
  assert.equal(await page.locator(".processing-details").evaluate((node) => node.open), false, "subtitle post-processing should stay folded until the user needs it");
  await openActionDetails(page, ".processing-details");
  await page.locator(".action-panel").getByRole("button", { name: "翻译为目标语言", exact: true }).waitFor({ state: "visible" });
  await assertNoMediaPlaybackControls(page);
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: false, withTranslation: true, translationEditors: 1 });
  assert.deepEqual(await readCurrentSegmentFieldLabels(page), ["字幕原文", "译文"], "translation mode should expose separate source and translation editors");
  await page.getByLabel("目标语言").selectOption({ label: "中文" });
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: true, withTranslation: false, translationEditors: 0 }, "same source and target language should keep proofreading source-only");
  assert.deepEqual(await readCurrentSegmentFieldLabels(page), ["字幕原文"], "same-language proofreading should hide the translation field");
  assert.equal(await page.locator(".top-export-mode-control").count(), 0, "same-language workbench should not show an export-mode switcher when only source export is available");
  assert.match(await page.locator(".top-export-control").innerText(), /导出 SRT/, "same-language workbench should still export the source subtitles");
  await page.getByLabel("目标语言").selectOption({ label: "英文" });
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: false, withTranslation: true, translationEditors: 1 }, "cross-language selection should restore translation proofreading");
  const singleProcessingActionLayout = await page.evaluate(() => {
    const grid = document.querySelector(".processing-tool-grid");
    const button = grid?.querySelector(".action-button");
    const gridRect = grid?.getBoundingClientRect();
    const buttonRect = button?.getBoundingClientRect();
    return {
      buttonCount: grid?.querySelectorAll(".action-button").length || 0,
      gridWidth: Math.round(gridRect?.width || 0),
      buttonWidth: Math.round(buttonRect?.width || 0),
    };
  });
  assert.equal(singleProcessingActionLayout.buttonCount, 1, "subtitle translation should expose only the available post-processing action");
  assert.ok(
    singleProcessingActionLayout.buttonWidth >= singleProcessingActionLayout.gridWidth - 4,
    `single post-processing action should use the available card width, got button ${singleProcessingActionLayout.buttonWidth}, grid ${singleProcessingActionLayout.gridWidth}`,
  );
  const missingTranslationRows = await page.evaluate(() => ({
    chips: [...document.querySelectorAll(".review-list-row .missing-translation-chip")].map((node) => node.textContent || ""),
    listText: [...document.querySelectorAll(".review-list-row")].map((node) => node.innerText || "").join("\n"),
  }));
  assert.deepEqual(missingTranslationRows.chips, ["缺译文", "缺译文"], "missing translations should read as a status, not as fake translation text");
  assert.doesNotMatch(missingTranslationRows.listText, /译文内容/, "review list should not show placeholder text as if it were a real translation");
  await assertWorkbenchLayout(page, { title: "字幕文件翻译", startExpected: false, hasResults: true });
  await assertNarrowResultWorkbenchKeepsReviewList(page, "字幕文件翻译");
  const missingTranslationExportText = await page.locator(".top-export-mode-control").innerText();
  assert.deepEqual(missingTranslationExportText.split(/\s+/).filter(Boolean), ["原文", "译文", "双语"], "export mode switcher should stay compact and not mix missing-count status into mode labels");
  assert.equal(await page.locator(".top-missing-translation").innerText(), "缺 2 条译文", "missing translation count should be a separate clickable status");
  assert.equal(await page.locator(".top-missing-translation").count(), 1, "top export area should be the single jump target for missing translations");
  assert.doesNotMatch(await page.locator(".workbench-quick-state").innerText(), /缺 \d+ 条译文/, "processing settings status should not duplicate the missing-translation jump target");
  assert.equal(await page.locator(".workbench-quick-state").isEnabled(), false, "processing settings status should stay passive unless hard export blockers need repair");
  await page.locator(".top-missing-translation").click();
  await page.waitForTimeout(250);
  assert.match(await readWorkbenchFeedback(page), /已定位到第 1 条缺少译文的段落/, "missing translation status should give feedback after locating the first missing segment");

  let chatRequestCount = 0;
  const chatRequests = [];
  let holdNextDraftRequest = false;
  let releaseHeldDraftRequest = null;
  await page.route("**/api/chat", async (route) => {
    chatRequestCount += 1;
    const payload = route.request().postDataJSON?.() || {};
    const requestText = JSON.stringify(payload.messages || payload);
    chatRequests.push(requestText);
    if (holdNextDraftRequest && requestText.includes("整理成清晰")) {
      holdNextDraftRequest = false;
      await new Promise((resolve) => {
        releaseHeldDraftRequest = resolve;
      });
    }
    let content = requestText.includes("整理成清晰")
      ? "# 转写整理稿\n\n- 音频转写第一句。\n- 音频转写第二句。"
      : requestText.includes("提炼要点") || requestText.includes("摘要")
        ? "# 摘要与标题\n\n## 要点\n\n- 音频转写第一句。\n- 音频转写第二句。"
        : "";
    if (!content) {
      const translationRows = [];
      if (requestText.includes("产品流验收第一句")) {
        translationRows.push({ id: "row-1", translation: "Product flow acceptance sentence one." });
      }
      if (requestText.includes("产品流验收第二句")) {
        translationRows.push({ id: "row-2", translation: "Product flow acceptance sentence two." });
      }
      content = JSON.stringify(translationRows);
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        choices: [{
          message: {
            content,
          },
        }],
      }),
    }).catch(() => {});
  });
  await page.getByLabel("目标语言").selectOption({ label: "英文" });
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: false, withTranslation: true, translationEditors: 1 });
  await openActionDetails(page, ".processing-details");
  await page.locator(".action-panel").getByRole("button", { name: "翻译为目标语言", exact: true }).click();
  await page.waitForTimeout(1000);
  assert.equal(chatRequestCount, 1);
  const translatedTable = await readCorrectionTableValues(page);
  assert.match(translatedTable, /Product flow acceptance sentence one/);
  assert.match(await readWorkbenchFeedback(page), /已翻译 2 条为英文/);
  const bilingualListLayout = await page.evaluate(() => {
    const list = document.querySelector(".review-segment-list.with-translation");
    const spans = [...document.querySelectorAll(".review-segment-list.with-translation .list-text-stack span:not(.missing-translation-chip)")];
    return {
      overflowX: Boolean(list && list.scrollWidth > list.clientWidth + 2),
      textModes: spans.map((span) => {
        const style = getComputedStyle(span);
        return {
          whiteSpace: style.whiteSpace,
          lineClamp: style.webkitLineClamp,
          wordBreak: style.wordBreak,
        };
      }),
    };
  });
  assert.equal(bilingualListLayout.overflowX, false, "bilingual review list should not create horizontal scrolling");
  assert.ok(bilingualListLayout.textModes.length >= 2, "translated review list should expose both source and translation text spans");
  assert.ok(
    bilingualListLayout.textModes.every((mode) => mode.whiteSpace === "normal" && mode.lineClamp === "2"),
    "bilingual review list should allow two-line source and translation previews instead of forcing single-line truncation",
  );
  await page.locator(".translate-row").first().click();
  await page.waitForTimeout(700);
  assert.equal(chatRequestCount, 2);
  assert.match(await readWorkbenchFeedback(page), /已更新 1 条字幕译文/);
  assert.match(await readCorrectionTableValues(page), /Product flow acceptance sentence one/);
  await page.locator(".current-segment-card .subtitle-translation-textarea").fill("Manual edited translation must stay.");
  await page.locator(".review-list-row").nth(1).click();
  await page.locator(".current-segment-card .subtitle-translation-textarea").fill("");
  await page.locator(".review-list-row").first().click();
  await page.locator(".export-mode-control").getByRole("button", { name: "双语" }).click();
  await page.waitForFunction(() => document.querySelector(".current-segment-card")?.innerText.includes("2/2"));
  assert.equal(
    await page.locator(".export-mode-control").getByRole("button", { name: "双语" }).evaluate((node) => node.classList.contains("pending-attention")),
    true,
    "clicking bilingual output with missing translations should preserve the requested mode as pending",
  );
  assert.equal(
    await page.locator(".export-mode-control").getByRole("button", { name: "原文" }).evaluate((node) => node.classList.contains("active")),
    true,
    "source export should remain the active downloadable mode until translations are complete",
  );
  assert.equal(
    await page.locator(".current-segment-card .subtitle-translation-textarea").evaluate((node) => document.activeElement === node),
    true,
    "clicking bilingual output with missing translations should focus the first missing translation",
  );
  assert.match(await readWorkbenchFeedback(page), /还有 1 条没有译文/);
  await openActionDetails(page, ".processing-details");
  await page.getByRole("button", { name: /翻译为目标语言/ }).click();
  await page.waitForTimeout(1000);
  assert.equal(
    await page.locator(".export-mode-control").getByRole("button", { name: "双语" }).evaluate((node) => node.classList.contains("active")),
    true,
    "after missing translations are completed, the previously requested bilingual export mode should become active",
  );
  assert.equal(chatRequestCount, 3);
  const replenishedTable = await readCorrectionTableValues(page);
  assert.match(replenishedTable, /Manual edited translation must stay/);
  assert.match(replenishedTable, /Product flow acceptance sentence two/);
  assert.match(await readWorkbenchFeedback(page), /已补齐 1 条字幕译文/);
  await page.locator(".review-list-row").first().click();
  await page.locator(".current-segment-card .subtitle-source-textarea").focus();
  await page.evaluate(() => {
    const field = document.querySelector(".current-segment-card .subtitle-source-textarea");
    const splitIndex = field.value.indexOf("验收");
    field.setSelectionRange(splitIndex, splitIndex);
    field.dispatchEvent(new Event("select", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  });
  await page.getByRole("button", { name: "拆分段落", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 3);
  assert.equal(await page.locator(".missing-translation-chip").count(), 0, "splitting an already translated subtitle should not create missing-translation chores");
  assert.match(await readWorkbenchFeedback(page), /已同步拆分已有译文/, "manual split should preserve existing bilingual work");
  const splitBilingualTable = await readCorrectionTableValues(page);
  assert.match(splitBilingualTable, /Manual edited/, "first split row should keep part of the existing manual translation");
  assert.match(splitBilingualTable, /translation must stay/, "second split row should keep the remaining manual translation");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".review-list-row").length === 2);
  await assertWorkbenchChromePersistsWhileReviewing(page, "字幕文件翻译");

  const downloadPromise = page.waitForEvent("download");
  const topExportButton = page.locator(".top-export-control .primary");
  assert.match(await topExportButton.innerText(), /导出双语 SRT/, "export button should visibly include both content mode and selected format");
  assert.equal(await page.getByRole("button", { name: "导出双语 SRT", exact: true }).isVisible(), true, "export button accessible name should match the visible export intent");
  await topExportButton.click();
  const srtDownload = await downloadPromise;
  const exportedSrtText = await readDownloadText(srtDownload);
  assert.equal(srtDownload.suggestedFilename(), `${expectedExportBase(sampleSubtitlePath)}-双语.srt`);
  assert.match(exportedSrtText, /产品流验收第一句/);
  assert.match(exportedSrtText, /Manual edited translation must stay/);
  assert.match(exportedSrtText, /Product flow acceptance sentence two/);
  assert.match(exportedSrtText, /00:00:00,000 --> 00:00:02,000/);

  const brokenProjectDir = join(workspaceRoot, "projects", "broken-product-flow-project");
  const legacyTxtProjectId = "legacy-transcript-txt-project";
  const legacyTxtProjectDir = join(workspaceRoot, "projects", legacyTxtProjectId);
  await mkdir(legacyTxtProjectDir, { recursive: true });
  await writeFile(join(legacyTxtProjectDir, "project.json"), JSON.stringify({
    id: legacyTxtProjectId,
    recent: {
      id: legacyTxtProjectId,
      name: "legacy-transcript.txt",
      meta: "视频转写 · 文本导入 · 1 条",
      status: "待校对",
      time: "06/01 09:00",
      type: "document",
      hasWorkspaceCopy: true,
      updatedAt: 1,
    },
    rows: [{ id: "legacy-row-1", start: 0, end: 2, speaker: "未标注", text: "旧项目里的转写文本", translation: "" }],
    workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "source", draft: "", transcriptionContext: "" },
    media: null,
    asrAudio: null,
  }, null, 2));
  await mkdir(brokenProjectDir, { recursive: true });
  await writeFile(join(brokenProjectDir, "project.json"), "{ broken project json");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  await page.waitForTimeout(500);
  assert.match(await page.locator(".projects-panel").innerText(), /1 个本地项目副本不完整/);
  const projectRows = await page.evaluate(() => [...document.querySelectorAll(".project-row")].map((row) => row.innerText));
  assert.ok(projectRows.length >= 1);
  assert.equal(projectRows.some((row) => /echo-product-flow/.test(row)), true);
  const projectOpenLabel = await page.locator(".project-row .project-open-area").first().getAttribute("aria-label");
  assert.match(projectOpenLabel || "", /^继续处理项目 /, "project open action should have a concise accessible label");
  assert.match(await page.locator(".project-row .project-open").first().innerText(), /继续处理/);
  assert.match(await page.locator(".project-row .project-title").first().innerText(), /\d{2}\/\d{2}\s+\d{2}:\d{2}/, "project list rows should show the project time so users can choose the latest local copy");
  assert.equal(await page.locator(".project-row .project-open-area > small").count(), 0, "project rows should not keep hidden duplicate metadata inside the open action");
  await page.getByRole("button", { name: "视频项目" }).click();
  await page.waitForFunction(() => document.querySelector(".project-list")?.textContent.includes("legacy-transcript.txt"));
  assert.match(await page.locator(".project-list").innerText(), /legacy-transcript\.txt/);
  await page.getByRole("button", { name: "字幕项目" }).click();
  await page.waitForTimeout(300);
  assert.doesNotMatch(await page.locator(".project-list").innerText(), /legacy-transcript\.txt/, "legacy imported transcript TXT projects should not be classified as subtitle translation");
  await page.getByRole("button", { name: "全部项目" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length >= 2);
  const legacyRow = page.locator(".project-row").filter({ hasText: "legacy-transcript.txt" });
  await legacyRow.getByRole("button", { name: "重命名项目 legacy-transcript.txt", exact: true }).click();
  await page.getByLabel("新的项目名称 legacy-transcript.txt").fill("客户访谈转写项目");
  await legacyRow.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".project-list")?.textContent.includes("客户访谈转写项目"));
  assert.doesNotMatch(await page.locator(".project-list").innerText(), /legacy-transcript\.txt/, "renamed project should immediately replace the duplicate/default name in the list");
  const renamedProjectRecord = JSON.parse(await readFile(join(legacyTxtProjectDir, "project.json"), "utf8"));
  assert.equal(renamedProjectRecord.recent.name, "客户访谈转写项目", "project rename should persist to the workspace project.json");
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  await page.waitForFunction(() => document.querySelector(".project-list")?.textContent.includes("客户访谈转写项目"));
  assert.match(await page.locator(".project-list").innerText(), /客户访谈转写项目/, "renamed project should survive a reload from local workspace state");
  assert.ok(projectRows.length >= 2, "project delete flow needs at least one remaining project to open afterward");
  const projectCountBeforeDelete = await page.locator(".project-row").count();
  const deletedProjectName = await page.locator(".project-row .project-title strong").first().innerText();
  await page.locator(".project-row .project-delete").first().click();
  assert.equal(await page.locator(".project-row").count(), projectCountBeforeDelete, "first project delete click should only request confirmation");
  assert.match(await page.locator(".project-row .project-delete").first().innerText(), /确认删除/);
  await page.locator(".project-row .project-delete").first().click();
  await page.waitForFunction((count) => document.querySelectorAll(".project-row").length === count - 1, projectCountBeforeDelete);
  assert.equal(await page.locator(".project-row").count(), projectCountBeforeDelete - 1, "confirmed project delete should remove one recoverable project");
  assert.equal(await page.getByText(`已删除本地项目：${deletedProjectName}`, { exact: true }).isVisible(), true, "confirmed project delete should give explicit success feedback");

  await page.locator(".project-row .project-open-area").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#workbench/"));
  const restoredProjectHash = await page.evaluate(() => location.hash);
  assert.match(restoredProjectHash, /^#workbench\/[a-z-]+\/project-[a-zA-Z0-9-]+/, "continued project route should include the recoverable project id");
  assert.equal(await page.locator(".workspace-title strong").isVisible(), true, "opened project should land in a workbench, not a fresh project list");
  await page.waitForFunction(() => document.querySelectorAll(".subtitle-table .table-row").length >= 3);
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2);
  assert.match(await readCorrectionTableValues(page), /产品流验收第二句/);
  assert.equal(await page.locator(".current-segment-card textarea").count(), 1, "opened project should restore the editable correction panel");
  assert.equal(await page.locator(".top-export-control").isVisible(), true, "opened project should restore export controls");
  await page.goBack();
  await page.waitForFunction(() => location.hash === "#projects");
  assert.equal(await page.locator(".project-row").count() > 0, true, "browser back from a continued project should return to Projects instead of reopening a fresh workbench");
  await page.locator(".project-row .project-open-area").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#workbench/"));
  assert.equal(await page.locator(".current-segment-card textarea").count(), 1, "reopened project should still land in the continued proofreading workbench");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelectorAll(".subtitle-table .table-row").length >= 3);
  await waitForWorkspaceSaved(page);
  assert.equal(await beforeUnloadIsPrevented(page), false, "restored saved projects should not warn on refresh");
  assert.equal(await page.evaluate(() => location.hash), restoredProjectHash, "refreshing a continued project should keep the project route");
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2, "refreshing a continued project should restore rows from the local workspace");
  assert.match(await readCorrectionTableValues(page), /产品流验收第二句/);
  assert.equal(await page.locator(".current-segment-card textarea").count(), 1, "refreshing a continued project should restore the editable correction panel");
  assert.equal(await page.locator(".top-export-control").isVisible(), true, "refreshing a continued project should restore export controls");
  if ((await page.locator(".workspace-title strong").innerText()) === "字幕文件翻译") {
    assert.equal(await page.locator(".subtitle-source-summary").isVisible(), true, "restored subtitle file project should show source summary instead of a fresh import dropzone");
    assert.equal(await page.locator(".media-panel .dropzone").count(), 0, "restored subtitle file project should not show a fresh import dropzone");
    await assertNoMediaPlaybackControls(page);
  }
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  await page.getByLabel("搜索本地项目").fill("客户访谈转写项目");
  await page.waitForFunction(() => document.querySelector(".project-row")?.textContent.includes("客户访谈转写项目"));
  await page.locator(".project-row .project-open-area").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#workbench/video-transcribe/legacy-transcript-txt-project"));
  assert.equal(await page.locator(".workspace-title strong").innerText(), "视频转写", "legacy imported TXT transcript projects should reopen in the video transcription workbench");
  await page.waitForFunction(() => document.querySelector(".current-segment-card textarea")?.value.includes("旧项目里的转写文本"));

  let asrRequestCount = 0;
  let asrMode = "normal";
  let releaseHeldAsr = null;
  await page.route("**/api/asr/transcribe*", async (route) => {
    asrRequestCount += 1;
    if (asrMode === "hold") {
      await new Promise((resolve) => {
        releaseHeldAsr = resolve;
      });
    }
    if (asrMode === "clientTimeout") {
      await new Promise((resolve) => {
        releaseHeldAsr = resolve;
      });
      await route.abort("timedout").catch(() => {});
      return;
    }
    if (asrMode === "fail") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "云端转写请求超时或上游暂不可用。请稍后重试。",
          stage: "调用转写服务",
          code: "ASR_STAGE_FAILED",
          retryable: true,
        }),
      });
      return;
    }
    if (asrMode === "languageParamFail") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "当前转写配置未通过语言或音频参数校验。系统已阻止启用该配置，并避免写入不完整结果。",
          stage: "调用转写服务",
          code: "ASR_LANGUAGE_PARAMETER_FAILED",
          retryable: false,
        }),
      });
      return;
    }
    if (asrMode === "textFail") {
      await route.fulfill({
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body: "上游 ASR 返回了纯文本错误",
      });
      return;
    }
    if (asrMode === "okError") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "上游 ASR 以成功状态返回错误结果" },
          stage: "调用转写服务",
          code: "ASR_UPSTREAM_OK_ERROR",
          retryable: true,
        }),
      });
      return;
    }
    if (asrMode === "networkFail") {
      await route.abort("connectionfailed");
      return;
    }
    if (asrMode === "orphanCjk") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          segments: [
            { start: 174.781, end: 180, text: "之前在《鬼魂笔记》中" },
            { start: 179.4, end: 183, text: "为了" },
            { start: 183, end: 188, text: "寻找那座桥我们继续调查" },
          ],
          provider: "product-flow-mock-asr",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        text: "音频转写第一句。音频转写第二句。",
        segments: [
          { start: 0, end: 0.5, text: "音频转写第一句。" },
          { start: 0.6, end: 0.95, text: "音频转写第二句。" },
        ],
        provider: "product-flow-mock-asr",
      }),
    });
  });

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("视频转写", { exact: true }).click();
  await page.waitForLoadState("networkidle");
  await assertWorkbenchLayout(page, { title: "视频转写", startExpected: true });
  const emptyUploadLayout = await page.evaluate(() => {
    const dropzone = document.querySelector(".media-panel .dropzone")?.getBoundingClientRect();
    const panel = document.querySelector(".media-panel")?.getBoundingClientRect();
    return {
      dropzoneHeight: Math.round(dropzone?.height || 0),
      panelHeight: Math.round(panel?.height || 0),
    };
  });
  assert.ok(emptyUploadLayout.dropzoneHeight <= 300, `empty upload dropzone should stay compact before media exists, got ${JSON.stringify(emptyUploadLayout)}`);
  await chooseFile(page, page.getByRole("button", { name: "上传视频", exact: true }).first(), sampleVideoPath);
  await page.waitForTimeout(600);
  assert.equal(await page.getByRole("button", { name: "更换视频", exact: true }).isVisible(), true, "uploaded video state should offer replacing the current video, not another initial upload");
  assert.equal(await page.getByRole("button", { name: "上传视频", exact: true }).count(), 0, "uploaded video state should not keep the initial upload label");
  assert.equal(await page.locator(".media-panel .text-import").count(), 0, "uploaded video state should not reserve media card space for pasted transcript import");
  const frameHeightBeforePasteDialog = await page.evaluate(() => Math.round(document.querySelector(".media-preview .video-preview-frame")?.getBoundingClientRect().height || 0));
  await page.getByRole("button", { name: "粘贴转写", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".manual-import-dialog textarea") === document.activeElement);
  assert.equal(await page.getByRole("dialog", { name: "导入已有转写文本" }).isVisible(), true, "uploaded video state should expose pasted transcript import as a dialog instead of taking media-card space");
  const pastedImportLayout = await page.evaluate((expectedFrameHeight) => {
    const frame = document.querySelector(".media-preview .video-preview-frame")?.getBoundingClientRect();
    const importBox = document.querySelector(".manual-import-dialog")?.getBoundingClientRect();
    const textarea = document.querySelector(".manual-import-dialog textarea")?.getBoundingClientRect();
    const button = document.querySelector(".manual-import-dialog .primary")?.getBoundingClientRect();
    const panel = document.querySelector(".media-panel")?.getBoundingClientRect();
    return {
      frameHeight: Math.round(frame?.height || 0),
      importVisible: Boolean(importBox && textarea && textarea.height >= 160),
      importNotInsidePanel: Boolean(importBox && panel && (importBox.left > panel.right || importBox.top < panel.top || importBox.bottom > panel.bottom)),
      mediaPanelUnchanged: Boolean(frame && Math.abs(frame.height - expectedFrameHeight) <= 2),
      actionInDialogFooter: Boolean(textarea && button && button.top >= textarea.bottom + 6),
    };
  }, frameHeightBeforePasteDialog);
  assert.equal(pastedImportLayout.mediaPanelUnchanged, true, `pasted transcript dialog should not shrink the uploaded video preview, got ${JSON.stringify(pastedImportLayout)}`);
  assert.equal(pastedImportLayout.importVisible, true, "pasted transcript import should show a usable textarea after upload");
  assert.equal(pastedImportLayout.importNotInsidePanel, true, `pasted transcript import should be a modal layer, not a block inside the media card, got ${JSON.stringify(pastedImportLayout)}`);
  assert.equal(pastedImportLayout.actionInDialogFooter, true, `pasted transcript import action should sit in the dialog footer, got ${JSON.stringify(pastedImportLayout)}`);
  await page.getByRole("button", { name: "关闭导入文本", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".manual-import-dialog"));
  const uploadedVideoLayout = await page.evaluate(() => {
    const frame = document.querySelector(".media-preview .video-preview-frame")?.getBoundingClientRect();
    const panel = document.querySelector(".media-panel")?.getBoundingClientRect();
    const workArea = document.querySelector(".workbench-work-area")?.getBoundingClientRect();
    const controls = document.querySelector(".action-panel")?.getBoundingClientRect();
    const video = document.querySelector(".media-preview .video-preview-frame video");
    return {
      frameHeight: Math.round(frame?.height || 0),
      frameWidth: Math.round(frame?.width || 0),
      panelWidth: Math.round(panel?.width || 0),
      workAreaWidth: Math.round(workArea?.width || 0),
      panelHeight: Math.round(panel?.height || 0),
      controlsHeight: Math.round(controls?.height || 0),
      objectFit: video ? getComputedStyle(video).objectFit : "",
      hasPreviewError: Boolean(document.querySelector(".media-preview-error")),
      hasEditor: Boolean(document.querySelector(".subtitle-editor")),
    };
  });
  assert.equal(uploadedVideoLayout.hasEditor, false, "uploaded-only setup state should not show the proofreading editor before transcription or import");
  assert.ok(uploadedVideoLayout.panelWidth >= uploadedVideoLayout.workAreaWidth - 4, `uploaded video media card should fill the left work area, got ${JSON.stringify(uploadedVideoLayout)}`);
  if (uploadedVideoLayout.hasPreviewError) {
    assert.ok(uploadedVideoLayout.frameHeight <= 360, `unpreviewable uploaded video should use a compact error preview instead of a giant black frame, got ${JSON.stringify(uploadedVideoLayout)}`);
    assert.ok(uploadedVideoLayout.panelHeight <= 560, `unpreviewable uploaded video should not stretch the media card to the full viewport, got ${JSON.stringify(uploadedVideoLayout)}`);
  } else {
    assert.ok(uploadedVideoLayout.frameHeight >= 360, `uploaded video preview should use the media card height, got ${JSON.stringify(uploadedVideoLayout)}`);
    assert.ok(uploadedVideoLayout.frameHeight >= uploadedVideoLayout.panelHeight * 0.62, `uploaded video preview should receive most of the media card height, got ${JSON.stringify(uploadedVideoLayout)}`);
    assert.ok(uploadedVideoLayout.frameHeight <= 680, `uploaded video preview should avoid an oversized letterbox frame, got ${JSON.stringify(uploadedVideoLayout)}`);
    assert.ok(Math.abs(uploadedVideoLayout.panelHeight - uploadedVideoLayout.controlsHeight) <= 4, `uploaded video setup cards should share the same workbench height, got ${JSON.stringify(uploadedVideoLayout)}`);
  }
  assert.equal(uploadedVideoLayout.objectFit, "contain", "uploaded video preview should preserve the original frame without cropping content");
  assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 0, "uploaded-only setup state should not show edit-history controls before proofreading rows exist");
  assert.equal(await page.getByRole("button", { name: "重做", exact: true }).count(), 0, "uploaded-only setup state should not show redo before proofreading rows exist");
  assert.deepEqual(await page.evaluate(() => {
    const fallback = document.querySelector(".audio-track-box");
    const fallbackPanel = document.querySelector(".audio-track-fallback");
    const panelRect = fallbackPanel?.getBoundingClientRect();
    return {
      exists: Boolean(fallback),
      open: Boolean(fallback?.open),
      panelVisible: Boolean(panelRect && panelRect.height > 0),
    };
  }), { exists: false, open: false, panelVisible: false }, "default cloud video transcription should not expose supplemental audio in the normal upload flow");
  assert.doesNotMatch(await readWorkbenchFeedback(page), /补充音频/);
  await page.evaluate(() => document.querySelector(".media-preview video")?.dispatchEvent(new Event("error", { bubbles: true })));
  await page.waitForFunction(() => document.querySelector(".media-preview-error")?.textContent.includes("浏览器无法预览此视频"));
  assert.match(await page.locator(".media-preview-error").innerText(), /仍可提交到转写服务/);
  const uploadPreviewErrorLayout = await page.evaluate(() => {
    const frame = document.querySelector(".media-preview .video-preview-frame")?.getBoundingClientRect();
    const panel = document.querySelector(".media-panel")?.getBoundingClientRect();
    const workArea = document.querySelector(".workbench-work-area")?.getBoundingClientRect();
    return {
      frameHeight: Math.round(frame?.height || 0),
      panelWidth: Math.round(panel?.width || 0),
      workAreaWidth: Math.round(workArea?.width || 0),
      panelHeight: Math.round(panel?.height || 0),
      hasEditor: Boolean(document.querySelector(".subtitle-editor")),
    };
  });
  assert.equal(uploadPreviewErrorLayout.hasEditor, false, "preview-error upload state should still not show the proofreading editor before transcription or import");
  assert.ok(uploadPreviewErrorLayout.panelWidth >= uploadPreviewErrorLayout.workAreaWidth - 4, `preview-error media card should keep filling the left work area, got ${JSON.stringify(uploadPreviewErrorLayout)}`);
  assert.ok(uploadPreviewErrorLayout.frameHeight <= 360, `unpreviewable uploaded video should use a compact error preview instead of a giant black frame, got ${JSON.stringify(uploadPreviewErrorLayout)}`);
  assert.ok(uploadPreviewErrorLayout.panelHeight <= uploadedVideoLayout.panelHeight, `unpreviewable uploaded video should not expand the media card after preview failure, got ${JSON.stringify(uploadPreviewErrorLayout)}`);
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "media preview errors should not block cloud transcription");
  asrMode = "fail";
  expectedAsrFailureEvents = 2;
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("转写未完成"));
  assert.match(await page.locator(".transcription-status-card.error").innerText(), /云端转写请求超时或上游暂不可用/);
  assert.match(await page.locator(".transcription-status-card.error").innerText(), /阶段：调用转写服务/);
  const failedStatusLayout = await page.evaluate(() => {
    const status = document.querySelector(".transcription-status-card.error")?.getBoundingClientRect();
    const start = [...document.querySelectorAll("button")].find((button) => /开始转写/.test(button.innerText))?.getBoundingClientRect();
    return {
      visible: Boolean(status && status.width > 0 && status.height > 0 && status.top >= 0 && status.bottom <= window.innerHeight),
      beforeStart: Boolean(status && start && status.bottom <= start.top + 1),
    };
  });
  assert.deepEqual(failedStatusLayout, { visible: true, beforeStart: true }, `ASR failure should be visible before the retry button, got ${JSON.stringify(failedStatusLayout)}`);
  assert.equal(await page.locator(".subtitle-table").count(), 0, "failed transcription should not create proofreading rows");
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "failed transcription should return to a retryable state with the error still visible");
  asrMode = "languageParamFail";
  expectedAsrFailureEvents = 4;
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("未通过素材语言或音频参数校验"));
  const failedAsrProviderState = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("echo.asrProvider.v1") || "{}");
    return {
      testFailed: stored.lastTest?.ok === false,
      inlineText: [...document.querySelectorAll(".inline-status")].map((item) => item.textContent || "").join(" | "),
    };
  });
  assert.equal(failedAsrProviderState.testFailed, true, "runtime language/audio parameter failure should mark the ASR service as failed");
  assert.match(failedAsrProviderState.inlineText, /转写服务测试失败|转写服务失败/, "runtime ASR failure should be reflected in the service status");
  asrMode = "textFail";
  expectedAsrFailureEvents = 2;
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("上游 ASR 返回了纯文本错误"));
  assert.equal(await page.locator(".subtitle-table").count(), 0, "plain-text failed transcription should not create proofreading rows");
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "plain-text failed transcription should keep a retryable button with the error visible");
  asrMode = "okError";
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("上游 ASR 以成功状态返回错误结果"));
  assert.match(await page.locator(".transcription-status-card.error").innerText(), /阶段：调用转写服务/);
  assert.equal(await page.locator(".subtitle-table").count(), 0, "200-with-error ASR responses should not create proofreading rows");
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "200-with-error ASR responses should return to a retryable state with the error visible");
  asrMode = "networkFail";
  expectedAsrConnectionFailureEvents = 2;
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("转写服务连接中断"));
  assert.equal(await page.locator(".subtitle-table").count(), 0, "network failed transcription should not create proofreading rows");
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "network failed transcription should keep a retryable button with the error visible");
  asrMode = "clientTimeout";
  releaseHeldAsr = null;
  await page.evaluate(() => {
    window.__ECHO_ASR_CLIENT_TIMEOUT_MS__ = 40;
  });
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".transcription-status-card.error")?.textContent?.includes("转写服务响应超时"));
  assert.match(await page.locator(".transcription-status-card.error").innerText(), /阶段：等待转写服务响应/);
  assert.equal(await page.locator(".subtitle-table").count(), 0, "hung transcription should not create proofreading rows");
  assert.equal(await page.getByRole("button", { name: /开始转写/ }).first().isEnabled(), true, "hung transcription should return to a retryable state with a visible timeout error");
  releaseHeldAsr?.();
  releaseHeldAsr = null;
  await page.evaluate(() => {
    delete window.__ECHO_ASR_CLIENT_TIMEOUT_MS__;
  });
  asrMode = "hold";
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.getByRole("button", { name: /取消转写/ }).waitFor({ state: "visible" });
  assert.equal(await beforeUnloadIsPrevented(page), true, "running transcription should warn before leaving the page");
  const busyBackHash = await page.evaluate(() => location.hash);
  const busyBackDialogMessage = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await page.evaluate(() => window.history.back());
  assert.match(await busyBackDialogMessage, /当前任务正在执行/);
  await page.waitForFunction((expectedHash) => location.hash === expectedHash, busyBackHash);
  assert.equal(await page.getByRole("button", { name: /取消转写/ }).isVisible(), true, "canceling browser back should keep the running workbench visible");
  const busyImportChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "更换视频", exact: true }).click();
  const busyImportChooser = await busyImportChooserPromise;
  const busyImportDialogMessage = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await busyImportChooser.setFiles(sampleVideoPath);
  assert.match(await busyImportDialogMessage, /当前任务正在执行/);
  await page.waitForFunction((expectedHash) => location.hash === expectedHash, busyBackHash);
  assert.equal(await page.getByRole("button", { name: /取消转写/ }).isVisible(), true, "canceling replacement upload should keep the running workbench visible");
  const busyNavigationDialogMessage = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  assert.match(await busyNavigationDialogMessage, /当前任务正在执行/);
  await page.waitForFunction(() => location.hash.startsWith("#workbench/video-transcribe"));
  assert.equal(await page.getByRole("button", { name: /取消转写/ }).isVisible(), true, "canceling in-app navigation should keep the running workbench visible");
  await page.getByRole("button", { name: /取消转写/ }).click();
  releaseHeldAsr?.();
  await page.waitForFunction(() => [...document.querySelectorAll(".message, .workbench-toast")].some((node) => /已取消转写/.test(node.textContent || "")));
  await page.waitForFunction(() => !document.querySelector(".cancel-transcription-button"));
  assert.equal(await page.locator(".subtitle-table").count(), 0, "cancelled transcription should not create proofreading rows");
  asrMode = "normal";
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForTimeout(1200);
  assert.equal(asrRequestCount, 10);
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2);
  assert.match(await readCorrectionTableValues(page), /音频转写第一句/);
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: true, withTranslation: false, translationEditors: 0 });
  assert.doesNotMatch(await readWorkbenchFeedback(page), /补充音频/);
  const floatingWorkbenchMessages = await page.evaluate(() => [...document.querySelectorAll(".workbench-toast")].map((node) => node.textContent || ""));
  assert.ok(
    floatingWorkbenchMessages.every((text) => text.length <= 96 && !/(失败|缺少|没有|未检测|未完成|无法|fail|error)/i.test(text)),
    `floating workbench messages should stay short and non-error, got ${JSON.stringify(floatingWorkbenchMessages)}`,
  );
  await assertWorkbenchLayout(page, { title: "视频转写", startExpected: true, hasResults: true });
  const videoTranscriptDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出 TXT/ }).click();
  const videoTranscriptDownload = await videoTranscriptDownloadPromise;
  const exportedVideoTranscriptText = await readDownloadText(videoTranscriptDownload);
  assert.equal(videoTranscriptDownload.suggestedFilename(), `${expectedExportBase(sampleVideoPath)}.txt`);
  assert.match(exportedVideoTranscriptText, /音频转写第一句/);
  assert.match(exportedVideoTranscriptText, /音频转写第二句/);
  assert.doesNotMatch(exportedVideoTranscriptText, /未标注/);
  await page.getByLabel("导出格式").selectOption("md");
  const videoTranscriptMdDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出 MD/ }).click();
  const videoTranscriptMdDownload = await videoTranscriptMdDownloadPromise;
  const exportedVideoTranscriptMd = await readDownloadText(videoTranscriptMdDownload);
  assert.equal(videoTranscriptMdDownload.suggestedFilename(), `${expectedExportBase(sampleVideoPath)}.md`);
  assert.match(exportedVideoTranscriptMd, /# 转写稿/);
  assert.match(exportedVideoTranscriptMd, /音频转写第一句/);

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("音频转写", { exact: true }).click();
  await page.waitForLoadState("networkidle");
  await chooseFile(page, page.getByRole("button", { name: "上传音频", exact: true }).first(), sampleAudioPath);
  await page.waitForTimeout(600);
  asrMode = "orphanCjk";
  await assert.doesNotReject(() => page.getByRole("button", { name: /开始转写/ }).first().click());
  await page.waitForFunction(() => document.querySelector(".subtitle-table .table-row:not(.table-head)"));
  assert.equal(asrRequestCount, 11);
  const repairedOrphanCjkTable = await readCorrectionTableValues(page);
  assert.match(repairedOrphanCjkTable, /为了寻找那座桥我们继续调查/);
  assert.doesNotMatch(repairedOrphanCjkTable, /\n为了\n|时间重叠|时间无效|单条过长|阅读过快|时长过短/);
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2);
  assertNoReviewTimeOverlap(await readReviewTimeRanges(page), "bounded orphan Chinese ASR repair");
  await assertWorkbenchLayout(page, { title: "音频转写", startExpected: true, hasResults: true });
  asrMode = "normal";

  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  await page.getByText("音频转写", { exact: true }).click();
  await page.waitForLoadState("networkidle");
  await chooseFile(page, page.getByRole("button", { name: "上传音频", exact: true }).first(), sampleAudioPath);
  await page.waitForTimeout(600);
  const startButton = page.getByRole("button", { name: /开始转写/ }).first();
  await assert.doesNotReject(() => startButton.click());
  await page.waitForTimeout(1200);
  assert.equal(asrRequestCount, 12);
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2);
  assert.match(await readCorrectionTableValues(page), /音频转写第一句/);
  assert.deepEqual(await readCorrectionTableMode(page), { sourceOnly: true, withTranslation: false, translationEditors: 0 });
  assert.match(await readWorkbenchFeedback(page), /云端转写完成/);
  await assertWorkbenchLayout(page, { title: "音频转写", startExpected: true, hasResults: true });
  const audioTranscriptDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /导出 TXT/ }).click();
  const audioTranscriptDownload = await audioTranscriptDownloadPromise;
  const exportedAudioTranscriptText = await readDownloadText(audioTranscriptDownload);
  assert.equal(audioTranscriptDownload.suggestedFilename(), `${expectedExportBase(sampleAudioPath)}.txt`);
  assert.match(exportedAudioTranscriptText, /音频转写第一句/);
  assert.match(exportedAudioTranscriptText, /音频转写第二句/);
  assert.doesNotMatch(exportedAudioTranscriptText, /未标注/);

  holdNextDraftRequest = true;
  releaseHeldDraftRequest = null;
  await page.evaluate(() => {
    window.__ECHO_MODEL_CLIENT_TIMEOUT_MS__ = 40;
  });
  await openActionDetails(page, ".processing-details");
  await page.getByRole("button", { name: /转写整理/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".message, .workbench-toast")].some((node) => /文本模型响应超时/.test(node.textContent || "")));
  assert.equal(await page.locator(".draft-inline-panel textarea").count(), 0, "timed-out model task should not create draft output");
  assert.equal(await page.getByRole("button", { name: "取消处理", exact: true }).count(), 0, "model timeout should release the cancellation control");
  await openActionDetails(page, ".processing-details");
  assert.equal(await page.getByRole("button", { name: /转写整理/ }).isEnabled(), true, "model timeout should return processing actions to a retryable state with the error visible");
  releaseHeldDraftRequest?.();
  releaseHeldDraftRequest = null;
  await page.evaluate(() => {
    delete window.__ECHO_MODEL_CLIENT_TIMEOUT_MS__;
  });

  holdNextDraftRequest = true;
  await openActionDetails(page, ".processing-details");
  await page.getByRole("button", { name: /转写整理/ }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".processing-tool-grid button")].some((button) => button.textContent.includes("转写整理") && button.disabled));
  const modelBusyControls = await page.evaluate(() => ({
    processingButtons: [...document.querySelectorAll(".processing-tool-grid button")].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
    rowTranslateDisabled: [...document.querySelectorAll(".current-row-tools .translate-row")].every((button) => button.disabled),
  }));
  assert.ok(modelBusyControls.processingButtons.length >= 3, "transcription processing should expose model actions for this busy-state check");
  assert.ok(modelBusyControls.processingButtons.every((button) => button.disabled), "running one model task should disable all processing model actions");
  assert.equal(modelBusyControls.rowTranslateDisabled, true, "running one model task should also disable current-row retranslation");
  assert.equal(await page.getByRole("button", { name: "取消处理", exact: true }).isVisible(), true, "running one model task should expose a cancellation control");
  assert.equal(await beforeUnloadIsPrevented(page), true, "running model processing should warn before refreshing or closing the page");
  const modelBusyHash = await page.evaluate(() => location.hash);
  const modelBusyNavigationDialog = new Promise((resolve) => {
    page.once("dialog", async (dialog) => {
      resolve(dialog.message());
      await dialog.dismiss();
    });
  });
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  assert.match(await modelBusyNavigationDialog, /当前任务正在执行/);
  await page.waitForFunction((expectedHash) => location.hash === expectedHash, modelBusyHash);
  assert.equal(await page.getByRole("button", { name: "取消处理", exact: true }).isVisible(), true, "canceling navigation during model processing should keep the active workbench visible");
  await page.getByRole("button", { name: "取消处理", exact: true }).click();
  releaseHeldDraftRequest?.();
  await page.waitForFunction(() => [...document.querySelectorAll(".message, .workbench-toast")].some((node) => /已取消处理/.test(node.textContent || "")));
  assert.equal(await page.locator(".draft-inline-panel textarea").count(), 0, "canceling a model task should not create draft output");
  assert.equal(await page.getByRole("button", { name: "取消处理", exact: true }).count(), 0, "model cancellation control should disappear after canceling");
  await openActionDetails(page, ".processing-details");
  assert.equal(await page.getByRole("button", { name: /转写整理/ }).isEnabled(), true, "processing actions should become available again after canceling a model task");
  await page.getByRole("button", { name: /转写整理/ }).click();
  await page.waitForFunction(() => document.querySelector(".draft-inline-panel textarea")?.value.includes("转写整理稿"));
  assert.equal(chatRequests.some((request) => /整理成清晰/.test(request) && /吸血鬼日记=The Vampire Diaries/.test(request)), true, "draft generation should include terms from the terminology library");
  assert.match(await readWorkbenchFeedback(page), /转写整理稿已生成/);
  assert.equal(await page.locator(".draft-panel").count(), 0, "draft output should not create a third workbench card that compresses correction");
  assert.match(await page.locator(".draft-inline-panel").innerText(), /转写整理输出/);
  await assertWorkbenchLayout(page, { title: "音频转写", startExpected: true, hasResults: true });
  const draftDownloadPromise = page.waitForEvent("download");
  await page.locator(".draft-inline-panel").getByRole("button", { name: /导出 Markdown/ }).click();
  const draftDownload = await draftDownloadPromise;
  const exportedDraftText = await readDownloadText(draftDownload);
  assert.equal(draftDownload.suggestedFilename(), `${expectedExportBase(sampleAudioPath)}-整理稿.md`);
  assert.match(exportedDraftText, /转写整理稿/);

  const seekButtonCount = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".seek-row")];
    buttons[1]?.click();
    return buttons.length;
  });
  await page.waitForFunction(() => document.querySelector(".current-segment-card textarea")?.value.includes("第二句") || document.querySelector(".table-row.active-row")?.innerText.includes("第二句"));
  const seekResult = await page.evaluate(() => {
    const media = document.querySelector(".media-preview audio, .media-preview video");
    const activeRow = document.querySelector(".table-row.active-row");
    const secondRow = document.querySelectorAll(".review-list-row")[1];
    const activeText = activeRow?.querySelectorAll("textarea")?.[0]?.value || activeRow?.innerText || "";
    return {
      currentTime: media?.currentTime || 0,
      activeText,
      secondRowSelected: Boolean(secondRow?.classList.contains("selected-row")),
      secondRowActive: Boolean(secondRow?.classList.contains("active-row")),
      secondRowUsesLocateIcon: Boolean(secondRow?.querySelector(".seek-row .lucide-locate-fixed")),
      secondRowUsesPlayIcon: Boolean(secondRow?.querySelector(".seek-row .lucide-play")),
    };
  });
  assert.equal(seekButtonCount, 2);
  assert.ok(seekResult.currentTime >= 0.55 && seekResult.currentTime <= 0.75, `seek should move media to second row start, got ${seekResult.currentTime}`);
  assert.match(seekResult.activeText, /音频转写第二句/);
  assert.equal(seekResult.secondRowSelected, true, "seek should also select the row for editing");
  assert.equal(seekResult.secondRowActive, true, "seek should mark the row as the current media-time row");
  assert.equal(seekResult.secondRowUsesLocateIcon, true, "row seek action should use a locate icon");
  assert.equal(seekResult.secondRowUsesPlayIcon, false, "row seek action should not look like a play action");

  if (await page.locator(".split-row").first().isEnabled()) {
    await page.locator(".split-row").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".subtitle-table .table-row").length - 1 === 3);
    assert.match(await readWorkbenchFeedback(page), /已拆分当前段落/);
    await page.locator(".merge-row").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".subtitle-table .table-row").length - 1 === 2);
    assert.match(await readWorkbenchFeedback(page), /已合并当前段落/);
    assert.match(await readCorrectionTableValues(page), /音频转写第一句/);
  } else {
    assert.match(
      await page.locator(".split-row").first().getAttribute("title"),
      /太短/,
      "short ASR segments should not be split into unusable fragments",
    );
  }

  await page.locator(".row-delete").first().click();
  assert.equal(await page.locator(".row-delete.confirm-delete").count(), 1, "first delete click should use in-app confirmation instead of deleting immediately");
  assert.equal(await page.locator(".subtitle-table .table-row").count() - 1, 2, "first delete click should keep the row until confirmed");
  assert.match(await readWorkbenchFeedback(page), /再次点击删除确认/);
  await page.locator(".row-delete.confirm-delete").click();
  await page.waitForFunction(() => document.querySelectorAll(".subtitle-table .table-row").length - 1 === 1);
  await assertWorkbenchLayout(page, { title: "音频转写", startExpected: true, hasResults: true });
  await page.locator(".row-delete").first().click();
  assert.equal(await page.locator(".row-delete.confirm-delete").count(), 1, "remaining row should also require in-app delete confirmation");
  await page.locator(".row-delete.confirm-delete").click();
  await page.waitForFunction(() => !document.querySelector(".subtitle-table") || document.querySelectorAll(".subtitle-table .table-row").length - 1 === 0);
  await assertWorkbenchLayout(page, { title: "音频转写", startExpected: true, hasResults: false, hasEditHistory: true });
  assert.equal(await page.locator(".top-export-control").count(), 0, "top export should be hidden after all rows are deleted");
  assert.equal(await page.locator(".result-preview-panel").count(), 0, "empty result state should not keep a visible preview panel");

  await chooseFile(page, page.getByRole("button", { name: "导入转写文件", exact: true }), longSubtitlePath);
  await page.waitForFunction(() => document.querySelector(".review-pagination")?.textContent.includes("1-30 / 92"));
  assert.equal(await page.locator(".review-list-row").count(), 30, "long review lists should render a focused review batch instead of an 80-row page or all segments");
  assert.match(await page.locator(".review-pagination").innerText(), /1-30 \/ 92/);
  const longReviewPaginationLayout = await page.evaluate(() => {
    const pagination = document.querySelector(".review-pagination")?.getBoundingClientRect();
    const tools = document.querySelector(".subtitle-editor .editor-tools")?.getBoundingClientRect();
    const current = document.querySelector(".current-segment-card")?.getBoundingClientRect();
    const list = document.querySelector(".review-segment-list")?.getBoundingClientRect();
    const firstRow = document.querySelector(".review-list-row")?.getBoundingClientRect();
    const firstText = document.querySelector(".review-segment-list.source-only .list-text-stack span");
    const firstTextStyle = firstText ? getComputedStyle(firstText) : null;
    return {
      paginationInsideTools: Boolean(pagination && tools && pagination.top >= tools.top - 2 && pagination.bottom <= tools.bottom + 2),
      currentListGap: Math.round((list?.top || 0) - (current?.bottom || 0)),
      pageButtonText: [...document.querySelectorAll(".review-pagination button")].map((button) => button.textContent.trim()).join(" "),
      listOverflowX: Boolean(list && list.scrollWidth > list.clientWidth + 2),
      firstRowHeight: Math.round(firstRow?.height || 0),
      sourcePreviewMode: firstTextStyle ? {
        whiteSpace: firstTextStyle.whiteSpace,
        lineClamp: firstTextStyle.webkitLineClamp,
        wordBreak: firstTextStyle.wordBreak,
      } : null,
    };
  });
  assert.equal(longReviewPaginationLayout.paginationInsideTools, true, `long-list pagination should live in the proofreading toolbar, got ${JSON.stringify(longReviewPaginationLayout)}`);
  assert.ok(longReviewPaginationLayout.currentListGap <= 12, `long-list pagination should not insert a separate row between current segment and list, got ${JSON.stringify(longReviewPaginationLayout)}`);
  assert.match(longReviewPaginationLayout.pageButtonText, /上一组\s+下一组/, `long-list pagination buttons should stay readable even when disabled, got ${JSON.stringify(longReviewPaginationLayout)}`);
  assert.equal(longReviewPaginationLayout.listOverflowX, false, `long source-only review list should not create horizontal scrolling, got ${JSON.stringify(longReviewPaginationLayout)}`);
  assert.deepEqual(longReviewPaginationLayout.sourcePreviewMode, { whiteSpace: "normal", lineClamp: "2", wordBreak: "break-word" }, `long source-only review list should show a two-line preview instead of one-line truncation, got ${JSON.stringify(longReviewPaginationLayout)}`);
  assert.ok(longReviewPaginationLayout.firstRowHeight <= 76, `long source-only preview rows should stay dense enough for batch review, got ${JSON.stringify(longReviewPaginationLayout)}`);
  await page.getByLabel("跳转校对分页").selectOption("1");
  await page.waitForFunction(() => document.querySelector(".review-pagination")?.textContent.includes("31-60 / 92"));
  assert.match(await page.locator(".current-segment-card").innerText(), /31\/92/);
  await page.getByLabel("跳转校对分页").selectOption("0");
  await page.waitForFunction(() => document.querySelector(".review-pagination")?.textContent.includes("1-30 / 92"));
  await page.getByRole("button", { name: "下一组" }).click();
  await page.waitForFunction(() => document.querySelector(".review-pagination")?.textContent.includes("31-60 / 92"));
  assert.equal(await page.locator(".review-list-row").count(), 30, "second page should render a focused review batch");
  assert.match(await page.locator(".current-segment-card").innerText(), /31\/92/);
  assert.match(await readCorrectionTableValues(page), /长转写分页第 31 句/);
  await page.getByRole("button", { name: "上一组" }).click();
  await page.waitForFunction(() => document.querySelector(".review-pagination")?.textContent.includes("1-30 / 92"));
  await page.getByLabel("查找校对内容").fill("第 92 句");
  await page.waitForFunction(() => document.querySelector(".current-segment-card")?.innerText.includes("92/92"));
  assert.match(await page.locator(".review-pagination").innerText(), /91-92 \/ 92/);
  assert.equal(await page.locator(".review-list-row").count(), 2, "searching a cross-page result should render only the focused result page");
  assert.match(await page.locator(".review-list-row.selected-row").innerText(), /长转写分页第 92 句/);
  const selectedRowVisible = await page.evaluate(() => {
    const row = document.querySelector(".review-list-row.selected-row");
    const editor = document.querySelector(".subtitle-editor");
    const rowRect = row?.getBoundingClientRect();
    const editorRect = editor?.getBoundingClientRect();
    return Boolean(rowRect && editorRect && rowRect.top >= editorRect.top && rowRect.bottom <= editorRect.bottom);
  });
  assert.equal(selectedRowVisible, true, "cross-page search should scroll the selected row into view");
  await assertWorkbenchChromePersistsWhileReviewing(page, "音频转写");
  await waitForWorkspaceSaved(page);
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  await page.getByRole("button", { name: "音频项目" }).click();
  await page.getByLabel("搜索本地项目").fill("92 条");
  await page.waitForFunction(() => [...document.querySelectorAll(".project-row")].some((row) => /音频转写 · (已替换|已导入|导入)文本 · 92 条/.test(row.innerText)));
  const importedAudioProjectText = await page.evaluate(() => [...document.querySelectorAll(".project-row")].map((row) => row.innerText).find((text) => /音频转写 · (已替换|已导入|导入)文本 · 92 条/.test(text)) || "");
  assert.match(importedAudioProjectText, /音频转写 · (已替换|已导入|导入)文本 · 92 条/, "audio transcription projects imported from SRT/TXT should still be labeled as audio transcription work");
  assert.doesNotMatch(importedAudioProjectText, /字幕文件 · 92 条/, "audio transcription project records should not look like subtitle-file translation projects");

  await page.getByRole("navigation").getByRole("button", { name: "模型配置" }).click();
  await page.waitForTimeout(500);
  const scopedConfigTabs = page.locator(".config-tabs");
  await scopedConfigTabs.getByRole("button", { name: "文本模型", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".config-tabs button:nth-child(2)")?.classList.contains("active"));
  assert.equal(await page.getByLabel("文本模型提供方").isVisible(), true, "model config text tab should switch to text model provider settings");
  assert.equal(
    await page.locator("label").filter({ hasText: "ASR API Key" }).locator("input").count(),
    0,
    "text model tab should not keep rendering ASR-only fields",
  );
  await scopedConfigTabs.getByRole("button", { name: "转写服务", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".config-tabs button:nth-child(1)")?.classList.contains("active"));
  assert.equal(await page.locator("label").filter({ hasText: "ASR API Key" }).locator("input").isVisible(), true, "model config ASR tab should switch back to transcription-service settings");
  const modelConfig = await page.evaluate(() => ({
    hasAsr: /转写服务/.test(document.body.innerText),
    hasTextModel: /文本模型/.test(document.body.innerText),
    hasTokenPlan: /Token Plan/.test(document.body.innerText),
    exposesHostedNvidiaAsrPreset: /NVIDIA Parakeet ASR|NVIDIA Canary ASR/.test(document.body.innerText),
  }));
  assert.deepEqual(modelConfig, { hasAsr: true, hasTextModel: true, hasTokenPlan: false, exposesHostedNvidiaAsrPreset: false });
  const modelConfigLayout = await page.evaluate(() => {
    const shell = document.querySelector(".content-shell");
    const form = document.querySelector(".config-view .form-grid");
    const actions = document.querySelector(".config-actions");
    const asrKeyInput = [...document.querySelectorAll("label")]
      .find((label) => /ASR API Key/.test(label.innerText))
      ?.querySelector("input");
    const videoInputSelect = document.querySelector("[aria-label='视频输入方式']");
    const asrKeyRect = asrKeyInput?.getBoundingClientRect();
    const advanced = document.querySelector(".advanced-config");
    const actionButtons = [...document.querySelectorAll(".config-actions button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { text: button.innerText.trim(), visible: rect.top < window.innerHeight && rect.bottom > 0 };
    });
    return {
      pageDoesNotScroll: shell ? shell.scrollHeight <= shell.clientHeight + 2 : false,
      formScrollsInternally: form ? form.scrollHeight > form.clientHeight + 2 : false,
      actionsVisible: actions ? actions.getBoundingClientRect().bottom <= window.innerHeight + 1 : false,
      asrKeyVisible: Boolean(asrKeyRect && asrKeyRect.top >= 0 && asrKeyRect.bottom <= window.innerHeight),
      hidesFixedDashScopeVideoInput: !videoInputSelect,
      advancedCollapsed: advanced ? !advanced.open : false,
      hidesAdvancedAsrFieldsByDefault: !/DashScope Base URL|接入协议/.test(document.body.innerText),
      actionButtons,
    };
  });
  assert.equal(modelConfigLayout.pageDoesNotScroll, true, "model config should keep actions in the configured viewport instead of relying on page scrolling");
  assert.equal(modelConfigLayout.actionsVisible, true, "model config save/test actions should be visible in the first viewport");
  assert.equal(modelConfigLayout.asrKeyVisible, true, "ASR config should expose the API Key input in the first viewport when warning that the key is missing");
  assert.equal(modelConfigLayout.hidesFixedDashScopeVideoInput, true, "DashScope ASR config should not show a disabled video-input dropdown that cannot be changed");
  assert.equal(modelConfigLayout.advancedCollapsed, true, "ASR model, transport, endpoint, and sample controls should be collapsed as advanced settings by default");
  assert.equal(modelConfigLayout.hidesAdvancedAsrFieldsByDefault, true, "advanced ASR fields should not compete with provider, language, and key in the first viewport");
  assert.equal(modelConfigLayout.actionButtons.every((button) => button.visible), true, "all model config action buttons should be visible without scrolling");
  const asrTestButton = page.getByRole("button", { name: "测试连接" });
  assert.equal(await asrTestButton.count(), 1);
  assert.equal(await asrTestButton.isDisabled(), false, "ASR test should use the built-in sample by default instead of requiring users to choose one first");
  assert.doesNotMatch(await page.locator(".config-actions").innerText(), /保存并测试/, "ASR save and test actions should stay separate");
  assert.doesNotMatch(await page.locator(".config-actions").innerText(), /测试样本/, "default ASR test should not ask users to understand sample setup first");
  await page.route("**/api/asr/test-sample*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "audio/wav",
      body: await readFile(sampleAudioPath),
    });
  });
  await asrTestButton.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".config-panel").first().innerText(), /转写样本已返回结果|测试样本已提交/);
  const advancedConfig = page.locator(".advanced-config");
  await advancedConfig.evaluate((node) => { node.open = true; });
  await page.waitForFunction(() => document.querySelector(".advanced-config")?.open);
  await page.getByLabel("转写服务提供方").selectOption({ label: "阿里云百炼 Qwen3-ASR 文件转写" });
  const qwenDashScopeConfig = await page.evaluate(() => {
    const protocolSelect = document.querySelector("[aria-label='转写接入协议']");
    const endpointInput = [...document.querySelectorAll("label")].find((label) => /DashScope Base URL/.test(label.innerText))?.querySelector("input");
    const modelInput = [...document.querySelectorAll("label")].find((label) => /^模型/.test(label.innerText.trim()))?.querySelector("input");
    const keyInput = [...document.querySelectorAll("label")].find((label) => /ASR API Key/.test(label.innerText))?.querySelector("input");
    return {
      protocolText: protocolSelect?.selectedOptions?.[0]?.textContent || "",
      endpoint: endpointInput?.value || "",
      model: modelInput?.value || "",
      apiKey: keyInput?.value || "",
    };
  });
  assert.deepEqual(qwenDashScopeConfig, {
    protocolText: "阿里云百炼 ASR",
    endpoint: "https://dashscope.aliyuncs.com/api/v1",
    model: "qwen3-asr-flash-filetrans",
    apiKey: "product-flow-test-key",
  }, "switching between DashScope ASR presets should preserve the existing DashScope key and expose the Qwen3 file-transcription model");
  await page.getByLabel("转写服务提供方").selectOption({ label: "Groq Whisper（OpenAI Compatible）" });
  const groqConfig = await page.evaluate(() => {
    const endpointInput = [...document.querySelectorAll("label")].find((label) => /HTTP Endpoint/.test(label.innerText))?.querySelector("input");
    const modelInput = [...document.querySelectorAll("label")].find((label) => /^模型/.test(label.innerText.trim()))?.querySelector("input");
    const videoInputMode = document.querySelector("[aria-label='视频输入方式']");
    const keyInput = [...document.querySelectorAll("label")].find((label) => /ASR API Key/.test(label.innerText))?.querySelector("input");
    return {
      endpoint: endpointInput?.value || "",
      model: modelInput?.value || "",
      videoInputMode: videoInputMode?.value || "",
      apiKey: keyInput?.value || "",
    };
  });
  assert.deepEqual(groqConfig, {
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    model: "whisper-large-v3-turbo",
    videoInputMode: "extract",
    apiKey: "",
  });
  const advancedProviderRecommendation = await page.locator(".asr-recommendation").innerText();
  assert.match(advancedProviderRecommendation, /内置样本测试后才会作为可用转写服务/, "advanced ASR providers should explain that untested providers are not enabled");
  assert.doesNotMatch(advancedProviderRecommendation, /默认百炼 ASR/, "ASR recovery copy should not recommend a provider the user may not have a key for");
  await page.getByLabel("转写服务提供方").selectOption({ label: "自定义 HTTP 转写端点" });
  await page.evaluate(() => {
    const endpointInput = [...document.querySelectorAll("label")].find((label) => /HTTP Endpoint/.test(label.innerText))?.querySelector("input");
    const modelInput = [...document.querySelectorAll("label")].find((label) => /^模型/.test(label.innerText.trim()))?.querySelector("input");
    endpointInput.value = "https://asr.example.test/v1/audio/transcriptions";
    endpointInput.dispatchEvent(new Event("input", { bubbles: true }));
    modelInput.value = "";
    modelInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.match(await page.locator(".config-state").first().innerText(), /模型/);
  assert.equal(await page.getByRole("button", { name: "测试连接" }).isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const mobileAsrKeyVisible = await page.evaluate(() => {
    const input = [...document.querySelectorAll("label")]
      .find((label) => /ASR API Key/.test(label.innerText))
      ?.querySelector("input");
    const rect = input?.getBoundingClientRect();
    return Boolean(rect && rect.top >= 0 && rect.bottom <= window.innerHeight);
  });
  assert.equal(mobileAsrKeyVisible, true, "mobile ASR config should keep the API Key input visible in the first viewport");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForTimeout(300);

  await page.getByRole("navigation").getByRole("button", { name: "术语库" }).click();
  assert.equal(await page.getByRole("button", { name: "添加术语" }).isDisabled(), true, "empty term form should not expose a clickable no-op add action");
  await page.getByPlaceholder("原文术语，例如 产品路线图").fill("产品路线图");
  assert.equal(await page.getByRole("button", { name: "添加术语" }).isDisabled(), true, "term add should require a target wording");
  await page.getByPlaceholder("目标译法，例如 product roadmap").fill("product roadmap");
  assert.equal(await page.getByRole("button", { name: "添加术语" }).isDisabled(), false, "term add should enable once source and target are present");
  await page.getByRole("button", { name: "添加术语" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".term-row")].some((row) => row.innerText.includes("产品路线图")));
  assert.match(await page.locator(".term-list").innerText(), /product roadmap/);
  await chooseFile(page, page.getByRole("button", { name: "导入术语" }), termImportPath);
  await page.waitForFunction(() => [...document.querySelectorAll(".term-row")].some((row) => row.innerText.includes("多模态,检索")));
  const importedTermText = await page.locator(".term-list").innerText();
  assert.match(importedTermText, /多模态,检索[\s\S]*multimodal, retrieval/, "CSV import should preserve quoted commas");
  assert.match(importedTermText, /引号"术语[\s\S]*quoted "term"/, "CSV import should preserve escaped quotes");
  assert.match(await page.locator(".message.compact").innerText(), /已导入 2 条术语，重复项已跳过/);
  const termsLayout = await page.evaluate(() => {
    const shell = document.querySelector(".content-shell");
    const view = document.querySelector(".terms-view");
    const panel = document.querySelector(".terms-view .config-panel");
    const list = document.querySelector(".term-list");
    const search = document.querySelector("[aria-label='搜索术语']");
    return {
      shellScroll: Boolean(shell && shell.scrollHeight > shell.clientHeight + 2),
      viewFills: Boolean(view && view.getBoundingClientRect().height > 500),
      panelFills: Boolean(panel && panel.getBoundingClientRect().height > 380),
      listScrollStyle: list ? getComputedStyle(list).overflowY : "",
      searchVisible: Boolean(search && search.getBoundingClientRect().width > 160),
    };
  });
  assert.equal(termsLayout.shellScroll, false, "Terms should keep management inside the page area instead of scrolling the shell");
  assert.equal(termsLayout.viewFills, true, "Terms view should use the available workspace height");
  assert.equal(termsLayout.panelFills, true, "Terms panel should fill the available content area");
  assert.equal(termsLayout.listScrollStyle, "auto", "Terms list should own overflow for large terminology sets");
  assert.equal(termsLayout.searchVisible, true, "Terms should provide visible search for real terminology management");
  await page.getByLabel("搜索术语").fill("路线");
  assert.match(await page.locator(".term-list").innerText(), /产品路线图/);
  await page.getByLabel("搜索术语").fill("不存在术语");
  assert.match(await page.locator(".term-list").innerText(), /没有匹配的术语/);
  await page.getByRole("button", { name: "清空术语搜索" }).click();
  const termsDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const termsDownload = await termsDownloadPromise;
  assert.match(await readDownloadText(termsDownload), /产品路线图,\"product roadmap\"|\"产品路线图\",\"product roadmap\"/);
  await deleteTermWithConfirmation(page, "产品路线图");
  await deleteTermWithConfirmation(page, "多模态,检索");
  await deleteTermWithConfirmation(page, '引号"术语');
  await page.locator(".term-row").filter({ hasText: "吸血鬼日记" }).getByRole("button", { name: "删除" }).click();
  assert.match(await page.locator(".term-row").filter({ hasText: "吸血鬼日记" }).innerText(), /确认删除/, "first delete on the final term should keep it visible for confirmation");
  await page.locator(".term-row").filter({ hasText: "吸血鬼日记" }).getByRole("button", { name: "取消" }).click();
  assert.match(await page.locator(".term-list").innerText(), /吸血鬼日记/, "canceling term delete should preserve the term");
  await deleteTermWithConfirmation(page, "吸血鬼日记");
  await page.waitForFunction(() => !document.querySelector(".term-row"));
  assert.match(await page.locator(".term-list").innerText(), /还没有术语/);
  assert.match(await page.locator(".term-list").innerText(), /原文术语,目标译法/, "empty terminology state should show the supported import format");
  assert.equal(await page.getByRole("button", { name: "导出 CSV" }).isDisabled(), true, "export should return to disabled after deleting the last term");

  await page.evaluate(async () => {
    for (let index = 0; index < 24; index += 1) {
      const id = `ui_many_projects_${index}`;
      const project = {
        id,
        tool: "audio-transcribe",
        recent: {
          id,
          name: `ui-many-project-${index}.wav`,
          meta: "音频转写 · 1 条",
          status: "已保存",
          time: `06/19 04:0${index}`,
          type: "audio",
          tool: "audio-transcribe",
        },
        rows: [{ id: `ui-row-${index}`, start: 0, end: 1, speaker: "未标注", text: `第 ${index} 个项目`, translation: "" }],
        workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "source", draft: "", transcriptionContext: "" },
        media: null,
        asrAudio: null,
      };
      const form = new FormData();
      form.set("project", JSON.stringify(project));
      const response = await fetch("/api/workspace/projects", { method: "POST", body: form });
      if (!response.ok) throw new Error(`failed to create ${id}`);
    }
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  assert.match(await page.locator(".projects-view").innerText(), /当前工作区位于系统临时目录/, "Projects should warn when local project records live in a temporary workspace");
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length > 20);
  assert.ok(await page.locator(".project-row").count() > 20, "Projects should show all recoverable workspace projects, not only twenty");
  const projectsScrollLayout = await page.evaluate(() => {
    const shell = document.querySelector(".content-shell");
    const list = document.querySelector(".project-list");
    const header = document.querySelector(".projects-view .workspace-header");
    return {
      shellScroll: Boolean(shell && shell.scrollHeight > shell.clientHeight + 2),
      listScroll: Boolean(list && list.scrollHeight > list.clientHeight + 2),
      headerVisible: Boolean(header && header.getBoundingClientRect().top >= 0 && header.getBoundingClientRect().bottom <= window.innerHeight),
    };
  });
  assert.equal(projectsScrollLayout.shellScroll, false, "Projects should keep long history inside the list instead of making the whole page scroll");
  assert.equal(projectsScrollLayout.listScroll, true, "Projects should scroll inside the project list when many recoverable projects exist");
  assert.equal(projectsScrollLayout.headerVisible, true, "Projects header and destructive action should stay visible while the list scrolls");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileProjectsScrollLayout = await page.evaluate(() => {
    const panel = document.querySelector(".projects-panel");
    const list = document.querySelector(".project-list");
    const panelRect = panel?.getBoundingClientRect();
    return {
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
      panelHeight: Number(panelRect?.height || 0),
      listScroll: Boolean(list && list.scrollHeight > list.clientHeight + 2),
      firstRowWithinPanel: Boolean(panelRect && document.querySelector(".project-row")?.getBoundingClientRect().top >= panelRect.top),
    };
  });
  assert.equal(mobileProjectsScrollLayout.pageOverflowX, false, "mobile Projects should not overflow horizontally with long project names");
  assert.ok(mobileProjectsScrollLayout.panelHeight <= 620, `mobile Projects panel should stay bounded instead of stretching with all history rows, got ${mobileProjectsScrollLayout.panelHeight}`);
  assert.equal(mobileProjectsScrollLayout.listScroll, true, "mobile Projects should scroll long history inside the project list");
  assert.equal(mobileProjectsScrollLayout.firstRowWithinPanel, true, "mobile project rows should remain inside the bounded panel");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForTimeout(200);
  assert.match(await page.locator(".project-row .project-title strong").first().innerText(), /ui-many-project-23\.wav/, "Projects should be sorted newest first");
  assert.match(await page.locator(".project-head-title").innerText(), /\d+ 个项目/);
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(150);
  const narrowProjectHead = await page.evaluate(() => {
    const title = document.querySelector(".project-head-title h2")?.getBoundingClientRect();
    const search = document.querySelector(".project-search")?.getBoundingClientRect();
    return {
      titleHeight: Math.round(title?.height || 0),
      titleText: document.querySelector(".project-head-title h2")?.textContent?.trim() || "",
      searchWidth: Math.round(search?.width || 0),
      horizontalOverflow: document.scrollingElement.scrollWidth > window.innerWidth + 2,
    };
  });
  assert.equal(narrowProjectHead.horizontalOverflow, false, `narrow Projects header should not create horizontal overflow: ${JSON.stringify(narrowProjectHead)}`);
  assert.ok(narrowProjectHead.titleHeight <= 28, `Projects panel title should stay on one line at narrow width, got ${JSON.stringify(narrowProjectHead)}`);
  assert.ok(narrowProjectHead.searchWidth >= 260, `Projects search should stay usable after wrapping, got ${JSON.stringify(narrowProjectHead)}`);
  await page.setViewportSize({ width: 1680, height: 950 });
  await page.waitForTimeout(150);
  await page.locator(".project-row .project-delete").first().click();
  assert.match(await page.locator(".project-row .project-delete").first().innerText(), /确认删除/);
  await page.getByRole("button", { name: "音频项目" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length > 20);
  assert.equal(await page.locator(".project-row .project-delete.confirm").count(), 0, "changing the project filter should cancel any pending delete confirmation");
  assert.match(await page.locator(".project-head-title").innerText(), /显示 \d+ \/ \d+ 个项目/);
  assert.match(await page.locator(".project-list").innerText(), /ui-many-project-8\.wav/);
  await page.locator(".project-row .project-delete").first().click();
  assert.match(await page.locator(".project-row .project-delete").first().innerText(), /确认删除/);
  await page.getByLabel("搜索本地项目").fill("ui-many-project-8");
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length === 1);
  assert.equal(await page.locator(".project-row .project-delete.confirm").count(), 0, "searching projects should cancel any pending delete confirmation");
  assert.match(await page.locator(".project-head-title").innerText(), /显示 1 \/ \d+ 个项目/);
  assert.match(await page.locator(".project-list").innerText(), /ui-many-project-8\.wav/);
  await page.getByLabel("搜索本地项目").fill("没有这个项目");
  await page.waitForFunction(() => !document.querySelector(".project-row"));
  assert.match(await page.locator(".project-head-title").innerText(), /显示 0 \/ \d+ 个项目/);
  assert.match(await page.locator(".project-list").innerText(), /没有匹配的本地项目/);
  await page.getByRole("button", { name: "清空项目搜索" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length > 20);
  assert.match(await page.locator(".project-head-title").innerText(), /显示 \d+ \/ \d+ 个项目/);
  await page.getByRole("button", { name: "全部项目" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length > 20);
  assert.doesNotMatch(await page.locator(".project-head-title").innerText(), /显示/);
  await page.getByRole("navigation").getByRole("button", { name: "首页" }).click();
  assert.ok(await page.locator(".recent-row").count() <= 8, "Home should keep the recent project list compact");
  const desktopRecentLayout = await page.evaluate(() => {
    const panel = document.querySelector(".recent-panel");
    const list = document.querySelector(".recent-list");
    const warning = document.querySelector(".recent-panel > .workspace-temp-warning");
    const chip = document.querySelector(".recent-panel .workspace-temp-chip");
    const panelRect = panel?.getBoundingClientRect();
    const warningRect = warning?.getBoundingClientRect();
    const listWarning = list?.querySelector(".workspace-temp-warning");
    const chipRect = chip?.getBoundingClientRect();
    const firstTitle = document.querySelector(".recent-row strong");
    const firstTitleStyle = firstTitle ? getComputedStyle(firstTitle) : null;
    return {
      rowCount: document.querySelectorAll(".recent-row").length,
      panelHeight: Number(panelRect?.height || 0),
      listScroll: Boolean(list && list.scrollHeight > list.clientHeight + 2),
      warningOutsideList: Boolean(warning && !listWarning),
      warningWidth: Number(warningRect?.width || 0),
      chipVisible: Boolean(chipRect && chipRect.width > 0 && chipRect.height > 0),
      chipInsideHead: Boolean(chip?.closest(".panel-head")),
      listHasWarning: Boolean(listWarning),
      panelWidth: Number(panelRect?.width || 0),
      firstTitleWhiteSpace: firstTitleStyle?.whiteSpace || "",
      firstTitleLineClamp: firstTitleStyle?.webkitLineClamp || firstTitleStyle?.lineClamp || "",
    };
  });
  assert.ok(desktopRecentLayout.panelHeight <= 360, `desktop recent-project card should be bounded and avoid empty filler space, got ${desktopRecentLayout.panelHeight}`);
  assert.equal(desktopRecentLayout.rowCount > 4 && desktopRecentLayout.listScroll, true, "desktop Home should scroll recent projects inside the card when several records exist");
  assert.equal(desktopRecentLayout.warningOutsideList, false, "Home should not spend a full list row on temporary-workspace warnings when projects exist");
  assert.equal(desktopRecentLayout.listHasWarning, false, "temporary-workspace status should not occupy recent-list scroll space");
  assert.equal(desktopRecentLayout.chipVisible, true, "Home should keep a compact temporary-workspace status in the recent-project header");
  assert.equal(desktopRecentLayout.chipInsideHead, true, "temporary-workspace status should sit in the recent-project header actions");
  assert.notEqual(desktopRecentLayout.firstTitleWhiteSpace, "nowrap", "Home recent-project title should use available row width instead of forcing a one-line ellipsis");
  assert.equal(desktopRecentLayout.firstTitleLineClamp, "2", "Home recent-project title should allow two lines before truncating");
  await page.getByRole("button", { name: "临时工作区", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#settings");
  await page.goto(`${baseUrl}/#home`, { waitUntil: "networkidle" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileRecentLayout = await page.evaluate(() => {
    const panel = document.querySelector(".recent-panel");
    const list = document.querySelector(".recent-list");
    const panelRect = panel?.getBoundingClientRect();
    const rowLayoutOk = [...document.querySelectorAll(".recent-row")].every((row) => {
      const body = row.querySelector(":scope > div");
      const action = row.querySelector("em");
      const bodyRect = body?.getBoundingClientRect();
      const actionRect = action?.getBoundingClientRect();
      if (!bodyRect || !actionRect) return false;
      return actionRect.top >= bodyRect.bottom - 1 && actionRect.right <= row.getBoundingClientRect().right + 1;
    });
    return {
      rowCount: document.querySelectorAll(".recent-row").length,
      panelHeight: Number(panelRect?.height || 0),
      listScroll: Boolean(list && list.scrollHeight > list.clientHeight + 2),
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rowLayoutOk,
    };
  });
  assert.equal(mobileRecentLayout.pageOverflowX, false, "mobile Home should not overflow horizontally");
  assert.ok(mobileRecentLayout.panelHeight <= 540, `mobile recent-project card should stay bounded instead of pushing the page down, got ${mobileRecentLayout.panelHeight}`);
  assert.equal(mobileRecentLayout.rowCount > 4 && mobileRecentLayout.listScroll, true, "mobile Home should scroll recent projects inside the card when several records exist");
  assert.equal(mobileRecentLayout.rowLayoutOk, true, "mobile recent-project rows should stack metadata and continue action without overlap");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForTimeout(200);

  await page.getByRole("navigation").getByRole("button", { name: "设置" }).click();
  const visibleWorkspacePath = await page.locator(".workspace-path-card > strong").innerText();
  assert.doesNotMatch(visibleWorkspacePath, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "settings should not expose the full local workspace path by default");
  assert.match(visibleWorkspacePath, new RegExp(`${basename(workspaceRoot)}$`), "settings should still show the selected workspace folder name");
  assert.match(await page.locator(".workspace-temp-warning").innerText(), /系统临时目录/, "settings should warn when the local workspace is in a temporary directory");
  const desktopWorkspaceConfigLayout = await page.evaluate(() => {
    const config = document.querySelector(".workspace-config");
    const intro = document.querySelector(".workspace-config > div:first-child");
    const path = document.querySelector(".workspace-path-card");
    const warning = document.querySelector(".workspace-temp-warning");
    const actions = document.querySelector(".workspace-config-actions");
    const rectFor = (node) => {
      const rect = node?.getBoundingClientRect();
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width } : null;
    };
    const configRect = rectFor(config);
    const introRect = rectFor(intro);
    const pathRect = rectFor(path);
    const warningRect = rectFor(warning);
    const actionsRect = rectFor(actions);
    return {
      pathUsesRow: Boolean(configRect && pathRect && pathRect.width >= configRect.width - 50),
      warningUsesRow: Boolean(configRect && warningRect && warningRect.width >= configRect.width - 50),
      actionsAlignedWithIntro: Boolean(introRect && actionsRect && Math.abs(actionsRect.top - introRect.top) <= 4),
      pathBelowIntro: Boolean(introRect && pathRect && pathRect.top >= introRect.bottom + 8),
      warningBelowPath: Boolean(pathRect && warningRect && warningRect.top >= pathRect.bottom + 8),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    };
  });
  assert.deepEqual(desktopWorkspaceConfigLayout, {
    pathUsesRow: true,
    warningUsesRow: true,
    actionsAlignedWithIntro: true,
    pathBelowIntro: true,
    warningBelowPath: true,
    horizontalOverflow: false,
  }, "desktop settings workspace config should keep path and warning on full-width rows without squeezing the intro");
  await page.locator(".manual-path-editor summary").click();
  assert.equal(await page.locator(".manual-path-editor textarea").inputValue(), workspaceRoot, "manual workspace path editor should preserve the full editable path");
  const manualWorkspaceEditorLayout = await page.evaluate(() => {
    const editor = document.querySelector(".manual-path-editor textarea");
    const rect = editor?.getBoundingClientRect();
    return {
      visible: Boolean(rect && rect.width > 0 && rect.height > 0),
      withinViewport: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth),
      wrapsLongPaths: getComputedStyle(editor).overflowWrap === "anywhere",
    };
  });
  assert.deepEqual(manualWorkspaceEditorLayout, { visible: true, withinViewport: true, wrapsLongPaths: true }, "manual workspace path editor should show long paths without layout overflow");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const mobileWorkspacePathLayout = await page.evaluate(() => {
    const label = document.querySelector(".workspace-path-card > strong");
    const rect = label?.getBoundingClientRect();
    return {
      text: label?.textContent || "",
      wraps: getComputedStyle(label).whiteSpace === "normal",
      withinViewport: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth),
      pageOverflowX: document.scrollingElement.scrollWidth > window.innerWidth + 2,
    };
  });
  assert.doesNotMatch(mobileWorkspacePathLayout.text, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "mobile settings should still keep the full workspace path hidden by default");
  assert.equal(mobileWorkspacePathLayout.wraps, true, "mobile settings should wrap long workspace folder labels instead of truncating them");
  assert.equal(mobileWorkspacePathLayout.withinViewport, true, "mobile workspace path label should stay within the card");
  assert.equal(mobileWorkspacePathLayout.pageOverflowX, false, "mobile settings should not overflow horizontally after showing the workspace path");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForTimeout(200);
  const settingsDataManagement = await page.evaluate(() => [...document.querySelectorAll(".settings-list > div")].map((row) => ({
    title: row.querySelector("strong")?.textContent.trim() || "",
    buttonText: row.querySelector("button")?.textContent.trim() || "",
    buttonLabel: row.querySelector("button")?.getAttribute("aria-label") || "",
  })));
  assert.deepEqual(
    settingsDataManagement,
    [
      { title: "模型配置", buttonText: "清除", buttonLabel: "清除模型配置" },
      { title: "转写服务", buttonText: "清除", buttonLabel: "清除转写服务" },
      { title: "术语库", buttonText: "清除", buttonLabel: "清除术语库" },
      { title: "本地项目", buttonText: "清除", buttonLabel: "清除本地项目" },
    ],
    "settings destructive actions should use compact visible buttons while keeping explicit accessible labels",
  );
  const providerBeforeClearClick = await page.evaluate(() => localStorage.getItem("echo.provider.v1"));
  await page.getByRole("button", { name: "清除模型配置" }).click();
  assert.match(await page.locator(".message").innerText(), /再次点击“确认清除模型配置”/);
  assert.equal(await page.evaluate(() => localStorage.getItem("echo.provider.v1")), providerBeforeClearClick, "first model clear click should only request confirmation");
  assert.equal(await page.getByRole("button", { name: "确认清除模型配置" }).isVisible(), true);
  assert.equal(await page.getByRole("button", { name: "确认清除模型配置" }).innerText(), "确认清除");
  const asrBeforeClearClick = await page.evaluate(() => localStorage.getItem("echo.asrProvider.v1"));
  await page.getByRole("button", { name: "清除转写服务" }).click();
  assert.match(await page.locator(".message").innerText(), /再次点击“确认清除转写服务”/);
  assert.equal(await page.evaluate(() => localStorage.getItem("echo.asrProvider.v1")), asrBeforeClearClick, "first ASR clear click should only request confirmation");
  assert.equal(await page.getByRole("button", { name: "确认清除转写服务" }).isVisible(), true);
  const projectCountBeforeClear = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/status");
    const data = await response.json();
    return data.projects.length;
  });
  assert.ok(projectCountBeforeClear > 0, "settings clear confirmation should be tested with existing workspace projects");
  await page.getByRole("button", { name: "清除本地项目" }).click();
  await page.waitForTimeout(300);
  assert.match(await page.locator(".message").innerText(), /再次点击“确认清除本地项目”/);
  const projectCountAfterFirstClearClick = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/status");
    const data = await response.json();
    return data.projects.length;
  });
  assert.equal(projectCountAfterFirstClearClick, projectCountBeforeClear, "first settings clear click should only ask for confirmation");
  await page.getByRole("button", { name: "确认清除本地项目" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  assert.equal(await page.locator(".project-row").count(), 0);

  await page.evaluate(async () => {
    const project = {
      id: "switch_workspace_source",
      tool: "video-transcribe",
      recent: {
        id: "switch_workspace_source",
        name: "switch-workspace-source.mp4",
        meta: "视频转写 · 1 条",
        status: "已保存",
        time: "06/20 12:00",
        type: "video",
        tool: "video-transcribe",
      },
      rows: [{ id: "switch-row-1", start: 0, end: 2, speaker: "未标注", text: "切换工作区前的旧项目", translation: "" }],
      workspaceState: { sourceLanguage: "中文", targetLanguage: "英文", exportMode: "source", draft: "", transcriptionContext: "" },
      media: null,
      asrAudio: null,
    };
    const form = new FormData();
    form.set("project", JSON.stringify(project));
    const response = await fetch("/api/workspace/projects", { method: "POST", body: form });
    if (!response.ok) throw new Error("failed to create switch workspace source project");
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  await page.waitForFunction(() => document.querySelector(".project-row")?.textContent.includes("switch-workspace-source.mp4"));
  await page.locator(".project-row .project-open-area").first().click();
  await page.waitForFunction(() => document.querySelector(".current-segment-card textarea")?.value.includes("切换工作区前的旧项目"));
  secondaryWorkspaceRoot = await mkdtemp(join(tmpdir(), "echo-product-flow-workspace-switch-"));
  await page.getByRole("navigation").getByRole("button", { name: "设置" }).click();
  await page.locator(".manual-path-editor summary").click();
  await page.getByPlaceholder("请选择或输入本地工作区路径").fill(secondaryWorkspaceRoot);
  await page.getByRole("button", { name: "保存工作区" }).click();
  await page.waitForFunction(() => document.querySelector(".message")?.textContent.includes("本地工作区已配置"));
  const switchedStatus = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/status");
    return response.json();
  });
  assert.equal(switchedStatus.root, secondaryWorkspaceRoot, "workspace switch should update the configured root");
  assert.equal(switchedStatus.projects.length, 0, "new workspace should start with its own empty project list");
  await page.getByRole("navigation").getByRole("button", { name: "工作台" }).click();
  assert.equal(await page.locator(".current-segment-card textarea").count(), 0, "switching workspace should clear the old active project editor");
  assert.doesNotMatch(await page.locator(".content-shell").innerText(), /切换工作区前的旧项目/, "old workspace rows should not remain visible after switching workspace");
  await page.getByRole("navigation").getByRole("button", { name: "项目与文件" }).click();
  assert.equal(await page.locator(".project-row").count(), 0, "Projects should not show records from the previous workspace after switching");

  await context.close();
  await browser.close();
  assert.deepEqual(browserErrors, []);
  assert.equal(existsSync(legacyConfigPath), false, "workspace config should not be written inside the project directory");
  console.log("product flow tests passed");
} catch (error) {
  throw error;
} finally {
  await stopServer(server);
  await rm(legacyConfigPath, { force: true });
  if (configDir) await rm(configDir, { recursive: true, force: true });
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  if (secondaryWorkspaceRoot) await rm(secondaryWorkspaceRoot, { recursive: true, force: true });
  if (sampleSubtitlePath) await rm(sampleSubtitlePath, { force: true });
  if (englishSubtitlePath) await rm(englishSubtitlePath, { force: true });
  if (riskySubtitlePath) await rm(riskySubtitlePath, { force: true });
  if (fragmentSubtitlePath) await rm(fragmentSubtitlePath, { force: true });
  if (longSubtitlePath) await rm(longSubtitlePath, { force: true });
  if (sampleAudioPath) await rm(sampleAudioPath, { force: true });
  if (sampleVideoPath) await rm(sampleVideoPath, { force: true });
  if (termImportPath) await rm(termImportPath, { force: true });
}
})();
