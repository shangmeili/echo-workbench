export const defaultWorkspaceState = {
  draft: "",
  transcriptionContext: "",
  sourceLanguage: "中文",
  targetLanguage: "英文",
  exportMode: "source",
  exportFormat: "",
  exportOptions: {
    includeTimecodes: true,
    includeSpeakers: true,
  },
  translationRequested: false,
  lastTranscriptionStatus: null,
};

export function workspaceDefaultsForFeature(id) {
  return {
    ...defaultWorkspaceState,
    translationRequested: id === "subtitle-translate",
  };
}
