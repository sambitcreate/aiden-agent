import type { ExternalEditor } from "./types";

export const PREFERRED_EDITOR_STORAGE_KEY = "aiden-agent.preferredEditorId";

interface EditorPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function resolvePreferredEditorId(
  availableEditors: readonly Pick<ExternalEditor, "id">[],
  storedEditorId: string | null,
): string | null {
  if (storedEditorId && availableEditors.some((editor) => editor.id === storedEditorId)) {
    return storedEditorId;
  }
  return availableEditors[0]?.id ?? null;
}

export function readPreferredEditorId(
  storage: EditorPreferenceStorage = localStorage,
): string | null {
  try {
    return storage.getItem(PREFERRED_EDITOR_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function persistPreferredEditorId(
  editorId: string,
  storage: EditorPreferenceStorage = localStorage,
): void {
  try {
    storage.setItem(PREFERRED_EDITOR_STORAGE_KEY, editorId);
  } catch {
    // Opening still works if browser storage is temporarily unavailable.
  }
}
