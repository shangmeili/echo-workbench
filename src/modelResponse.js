function stripCodeFence(text) {
  return String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

function normalizeObjectList(parsed) {
  const list = parsed.items || parsed.rows || parsed.translations || parsed.results || parsed.data || parsed.output;
  if (Array.isArray(list)) return list;
  const entries = Object.entries(parsed).filter(([, value]) => (
    typeof value === "string"
    || (value && typeof value === "object" && !Array.isArray(value))
  ));
  if (!entries.length) return null;
  return entries.map(([id, value]) => (typeof value === "string" ? { id, text: value, translation: value } : { id, ...value }));
}

export function parseJsonArrayFromModelText(text) {
  const clean = stripCodeFence(text);
  const arrayStart = clean.indexOf("[");
  const arrayEnd = clean.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return JSON.parse(clean.slice(arrayStart, arrayEnd + 1));
  }
  const objectStart = clean.indexOf("{");
  const objectEnd = clean.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) {
    const parsed = JSON.parse(clean.slice(objectStart, objectEnd + 1));
    const list = normalizeObjectList(parsed);
    if (Array.isArray(list)) return list;
  }
  throw new Error("模型没有返回可解析的 JSON 数组。");
}

export function getTranslationValue(item) {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  return String(item.translation || item.translated || item.target || item.text || item.output || item.value || item["译文"] || "").trim();
}

export function getCorrectedTextValue(item) {
  if (typeof item === "string") return item.trim();
  if (!item || typeof item !== "object") return "";
  return String(item.text || item.corrected || item.correctedText || item.corrected_text || item.output || item.value || item["校正文"] || item["修正文"] || "").trim();
}
