export function stripWrappingCodeFence(text) {
  const clean = String(text || "").trim();
  const match = clean.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : clean;
}

export function formatTermReference(terms = []) {
  return terms.map((term) => `${term.source}=${term.target}`).join("; ") || "无";
}

export function buildTranslationMessages({ rows = [], targetLanguage, sourceLanguage, subject = "字幕", transcriptionContext = "", terms = [] }) {
  const subjectLabel = subject === "转写段落" ? "转写段落" : "字幕";
  const sentenceLabel = subjectLabel === "字幕" ? "字幕句子" : "转写文本";
  const prompt = `请把下面${subjectLabel}逐条翻译成${targetLanguage}。源语言：${sourceLanguage}。这一步仅用于源语言和目标语言不一致的场景。
要求：
1. 只返回 JSON 数组，数组长度必须与输入一致。
2. 每项必须包含原始 id 和 translation。
3. 不要改写 id，不要解释。
4. 保持${sentenceLabel}自然简洁，不添加原文没有的信息。
输入：
${JSON.stringify(rows.map((row) => ({ id: row.id, text: row.text })))}
转写提示：${String(transcriptionContext || "").trim() || "无"}
术语参考：${formatTermReference(terms)}`;

  return [
    { role: "system", content: `你是专业${subjectLabel}翻译助手。只在需要跨语言转换时翻译，保持含义准确、文本自然简洁。` },
    { role: "user", content: prompt },
  ];
}
