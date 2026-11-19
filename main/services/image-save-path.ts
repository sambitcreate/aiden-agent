/**
 * The generate_image `savePath` check, kept free of the model-tool imports so
 * the hook layer can name the same file a hook sees as `file_path`.
 */

export const SAVE_PATH_EXTENSION = /\.(png|jpe?g|gif|webp)$/iu;

// Characters a person cannot see on the approval card: C0 and C1 controls, format
// characters (direction marks, embeddings, overrides and isolates, zero-width
// joiners and spaces, the soft hyphen, the BOM), the line and paragraph
// separators, and the Hangul fillers that render as blank space.
const SAVE_PATH_HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\u2028\u2029\u115f\u1160\u3164]/u;

/**
 * Checks a generate_image `savePath` before anything is sent to a provider: a
 * relative path inside the workspace folder (no `..`, no leading slash, `~`
 * or drive, no hidden folder, no control, format or invisible characters) naming a
 * file with an image extension, or with none. Returns it with
 * forward slashes and without `.` segments. The folder itself is enforced
 * again when the file is written.
 */
export function checkImageSavePath(value: unknown): string {
  // Control, format and invisible characters could make the approval card
  // show one path while another is written.
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512 || SAVE_PATH_HIDDEN_CHARACTER.test(value))
    throw new Error("Invalid savePath.");
  // A leading ~ is a home folder to a person reading the card, but a folder named ~ to the workspace.
  if (/^(?:[\\/~]|[A-Za-z]:)/u.test(value))
    throw new Error("savePath must be a path inside the workspace folder, such as design/assets/hero.png.");
  const segments = value.split(/[\\/]/u).filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes(".."))
    throw new Error("savePath must be a path inside the workspace folder, such as design/assets/hero.png.");
  // Hidden folders (.git, .ssh, .aiden, .vscode) hold settings and hooks, never pictures.
  if (segments.slice(0, -1).some((segment) => segment.startsWith(".")))
    throw new Error("savePath must not be inside a hidden folder (one whose name starts with a dot).");
  const name = segments[segments.length - 1]!;
  const dot = name.lastIndexOf(".");
  if (dot === 0 || (dot > 0 && !SAVE_PATH_EXTENSION.test(name)))
    throw new Error("savePath must name an image file (.png, .jpg, .webp or .gif).");
  return segments.join("/");
}
