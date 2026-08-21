export const CREATE_IMAGES_MAX_BATCH_INVOCATIONS = 8;

export type CreateImagesPromptListParseResult =
  | { status: "ready"; items: string[] }
  | { status: "invalid"; message: string };

export function parseCreateImagesPromptList(
  source: string,
  format: "lines" | "json",
): CreateImagesPromptListParseResult {
  let values: unknown[];
  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(source);
      if (!Array.isArray(parsed)) {
        return { status: "invalid", message: "Enter a JSON array of prompt strings." };
      }
      values = parsed;
    } catch {
      return { status: "invalid", message: "Enter a valid JSON array of prompt strings." };
    }
  } else {
    values = source.split(/\r?\n/u);
  }
  const items = values
    .map((value) => (typeof value === "string" ? value.trim() : undefined))
    .filter((value): value is string => Boolean(value));
  if (items.length === 0) return { status: "invalid", message: "Add at least one prompt item." };
  if (items.length > CREATE_IMAGES_MAX_BATCH_INVOCATIONS) {
    return {
      status: "invalid",
      message: `A confirmed batch is limited to ${CREATE_IMAGES_MAX_BATCH_INVOCATIONS} provider requests.`,
    };
  }
  if (values.some((value) => typeof value !== "string")) {
    return { status: "invalid", message: "Every prompt-list item must be a string." };
  }
  return { status: "ready", items };
}
