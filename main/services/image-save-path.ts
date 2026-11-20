/**
 * The generate_image `savePath` check, kept free of the model-tool imports so
 * the hook layer can name the same file a hook sees as `file_path`.
 */

export const SAVE_PATH_EXTENSION = /\.(png|jpe?g|gif|webp)$/iu;

// Characters a person cannot see on the approval card: C0 and C1 controls, format
// characters (direction marks, embeddings, overrides and isolates, zero-width
// joiners and spaces, the soft hyphen, the BOM), every other code point Unicode
// says to draw as nothing (variation selectors, tag characters, the combining
// grapheme joiner, the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0), the
// line and paragraph separators, and the blanks that look like a space or
// nothing: the braille blank U+2800 and the ideographic space U+3000.
const SAVE_PATH_HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800\u3000]/u;

// An emoji with its skin tone or presentation selector, joined to further
// emoji by zero-width joiners (a family, a flag such as 🏳️‍🌈, ❤️‍🔥). The joiner
// and selector are allowed only inside such a sequence, where they change the
// picture drawn; anywhere else they are refused like the characters above.
const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\ufe0e\ufe0f])?(?:\u200d\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\ufe0e\ufe0f])?)*/gu;

const hasHiddenCharacter = (value: string) => SAVE_PATH_HIDDEN_CHARACTER.test(value.replace(EMOJI_SEQUENCE, "e"));

/**
 * Checks a generate_image `savePath` before anything is sent to a provider: a
 * relative path inside the workspace folder (no `..`, no leading slash, `~`
 * or drive, no hidden folder, no control, format or invisible characters
 * outside an emoji sequence) naming a
 * file with an image extension, or with none. Returns it with
 * forward slashes and without `.` segments. The folder itself is enforced
 * again when the file is written.
 */
export function checkImageSavePath(value: unknown): string {
  // Control, format and invisible characters could make the approval card
  // show one path while another is written.
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512 || hasHiddenCharacter(value))
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
