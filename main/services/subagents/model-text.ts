/**
 * Minimal normalization for text that remains in a child/model conversation.
 *
 * This is intentionally not the renderer privacy projection. Model-facing
 * task, source, and report text must retain paths, source syntax, encodings,
 * Unicode, and ordinary Markdown. Only terminal/protocol controls are
 * normalized here; boundedness is enforced by each owning contract.
 */
const ANSI_ESCAPE_SEQUENCE = new RegExp(
  String.raw`\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[()][0-2A-Z])`,
  "gu",
);
const UNSAFE_MODEL_CONTROL = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "gu",
);

export function normalizeSubagentModelText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(UNSAFE_MODEL_CONTROL, " ");
}
