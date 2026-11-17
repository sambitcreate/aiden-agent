// The words of the prompt main shows when a close or reload would lose work the
// renderer reported: which surfaces are still saving, or hold unsaved work.

/** Which renderer surfaces hold the unsaved or saving work, as the renderer's close guard reports them. */
export interface CloseGuardSources {
  dirty: readonly string[];
  saving: readonly string[];
  /** The image workflow's title, while it is unsaved or saving. */
  imagesLabel?: string;
}

export type CloseGuardAction = "close" | "reload";

export type CloseGuardPrompt = {
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
};

type Named = "editor" | "images" | "design";

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The surfaces named in a list, the Files editor first. The editor reports no sources through
 * its IPC path, so work from no named surface (or no sources at all) is the editor's.
 */
function surfaces(list: readonly string[] | undefined, fallbackToEditor: boolean): Named[] {
  if (!list) return ["editor"];
  const named = (["editor", "images", "design"] as const).filter((name) => list.includes(name));
  if (named.length === 0 && fallbackToEditor) return ["editor"];
  return named;
}

function nameOf(surface: Named, path: string | undefined, imagesLabel: string | undefined): string {
  if (surface === "editor") return path ? `“${path}”` : "the open file";
  if (surface === "images") return imagesLabel ? `the image workflow “${imagesLabel}”` : "the image workflow";
  return "the design canvas";
}

/** The "wait, still saving" notice, shown with a single Keep Aiden Open button. */
export function closeGuardSavingPrompt(
  sources: CloseGuardSources | undefined,
  action: CloseGuardAction,
): CloseGuardPrompt {
  const saving = surfaces(sources?.saving, true);
  const only = saving.length === 1 ? saving[0] : undefined;
  const title =
    only === "images" ? "Image workflow save in progress" : only === "design" ? "Design canvas save in progress" : "File save in progress";
  const names = saving.map((surface) => nameOf(surface, undefined, sources?.imagesLabel));
  return {
    title,
    message: `Wait for ${joinNames(names)} to finish saving before ${action === "close" ? "closing Aiden" : "reloading"}.`,
    buttons: ["Keep Aiden Open"],
  };
}

/** The "discard unsaved work?" question; the second button discards. */
export function closeGuardDiscardPrompt(
  sources: CloseGuardSources | undefined,
  path: string | undefined,
  action: CloseGuardAction,
): CloseGuardPrompt {
  const dirty = surfaces(sources?.dirty, true);
  // The Files editor speaks of edits; the canvas and workflows, of changes.
  const noun = dirty.includes("editor") ? "edits" : "changes";
  const names = dirty.map((surface) =>
    surface === "editor" && !path ? "The open file" : nameOf(surface, path, sources?.imagesLabel),
  );
  const subject = capitalize(joinNames(names));
  const verb = dirty.length === 1 ? "has" : "have";
  const Noun = capitalize(noun);
  return {
    title: noun === "edits" ? "Discard unsaved edits?" : "Discard unsaved changes?",
    message: `${subject} ${verb} ${noun} that have not been saved.`,
    detail: `${action === "close" ? "Closing" : "Reloading"} Aiden will permanently discard those ${noun}.`,
    buttons: [
      "Keep Editing",
      action === "close" ? `Discard ${Noun} and Close` : `Discard ${Noun} and Reload`,
    ],
  };
}
