import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";

const rootElement = document.getElementById("root");
const ICON_ONLY_TAB_TITLE = "\u00a0";

function setIconOnlyTabTitle() {
  const titleNode = document.querySelector("title");
  if (titleNode && titleNode.textContent !== ICON_ONLY_TAB_TITLE) {
    titleNode.textContent = ICON_ONLY_TAB_TITLE;
  }
  if (document.title !== ICON_ONLY_TAB_TITLE) {
    document.title = ICON_ONLY_TAB_TITLE;
  }
}

setIconOnlyTabTitle();
const tabTitleObserver = new MutationObserver(setIconOnlyTabTitle);
tabTitleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
window.addEventListener("pageshow", setIconOnlyTabTitle);
window.addEventListener("focus", setIconOnlyTabTitle);
window.addEventListener("hashchange", setIconOnlyTabTitle);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderFatal(error) {
  if (!rootElement) return;
  if (rootElement.children.length > 0) return;
  const message = error?.message || String(error || "未知错误");
  rootElement.innerHTML = `<div style="padding:24px;font:14px system-ui;color:#b42318;background:#fff4f4;border:1px solid #f3c2c2;border-radius:12px;margin:24px">回响工作台启动失败：${escapeHtml(message)}</div>`;
}

window.addEventListener("error", (event) => renderFatal(event.error || event.message));
window.addEventListener("unhandledrejection", (event) => renderFatal(event.reason));

try {
  createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  );
} catch (error) {
  renderFatal(error);
}
