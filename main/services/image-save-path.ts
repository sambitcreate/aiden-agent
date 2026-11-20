/**
 * The generate_image `savePath` check, kept free of the model-tool imports so
 * the hook layer can name the same file a hook sees as `file_path`.
 */

export const SAVE_PATH_EXTENSION = /\.(png|jpe?g|gif|webp)$/iu;

// Characters a person cannot see on the approval card, or cannot tell apart from
// others: C0 and C1 controls, format characters (direction marks, embeddings,
// overrides and isolates, zero-width joiners and spaces, the soft hyphen, the
// BOM), every other code point Unicode says to draw as nothing (variation
// selectors, tag characters, the combining grapheme joiner, the Hangul fillers
// U+115F, U+1160, U+3164 and U+FFA0), private-use, unassigned and noncharacter
// code points (U+FFFF among them) and lone surrogates, which no font draws the
// same way twice, the object replacement character U+FFFC, the line and
// paragraph separators, the braille blank U+2800, and every space other than
// the ordinary one (the no-break, thin, hair and ideographic spaces among them).
const SAVE_PATH_HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800\ufffc]|(?! )\p{Zs}/u;

// One emoji a zero-width joiner may stand next to: one drawn as an emoji by
// default, or one followed by the emoji presentation selector U+FE0F, either
// with an optional skin tone.
const JOINABLE_EMOJI = String.raw`(?:\p{Emoji_Presentation}\p{Emoji_Modifier}?\ufe0f?|\p{Extended_Pictographic}\p{Emoji_Modifier}?\ufe0f)`;

// Emoji joined by zero-width joiners (a family, a flag such as 🏳️‍🌈, ❤️‍🔥,
// 👩‍💻), or a single emoji with its skin tone or presentation selector. The
// joiner is allowed only between two joinable emoji, where it changes the
// picture drawn; between a symbol drawn as text and anything else (`©‍®`), or
// anywhere else, it is refused like the characters above, and so is a selector
// that follows no emoji.
const EMOJI_SEQUENCE = new RegExp(
  String.raw`${JOINABLE_EMOJI}(?:\u200d${JOINABLE_EMOJI})+|\p{Extended_Pictographic}\p{Emoji_Modifier}?[\ufe0e\ufe0f]?`,
  "gu",
);

const hasHiddenCharacter = (value: string) => SAVE_PATH_HIDDEN_CHARACTER.test(value.replace(EMOJI_SEQUENCE, "e"));

/**
 * Checks a generate_image `savePath` before anything is sent to a provider: a
 * relative path inside the workspace folder (no `..`, no leading slash, `~`
 * or drive, no hidden folder, no folder or file name ending in a space, no
 * control, format, unassigned or invisible characters and no space but the
 * ordinary one, and no zero-width joiner outside an emoji sequence) naming a
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
  // A trailing space is invisible on the card, and Windows drops it from the name it writes.
  if (segments.some((segment) => segment.endsWith(" ")))
    throw new Error("savePath must not end a folder or file name with a space.");
  // Hidden folders (.git, .ssh, .aiden, .vscode) hold settings and hooks, never pictures.
  if (segments.slice(0, -1).some((segment) => segment.startsWith(".")))
    throw new Error("savePath must not be inside a hidden folder (one whose name starts with a dot).");
  const name = segments[segments.length - 1]!;
  const dot = name.lastIndexOf(".");
  if (dot === 0 || (dot > 0 && !SAVE_PATH_EXTENSION.test(name)))
    throw new Error("savePath must name an image file (.png, .jpg, .webp or .gif).");
  return segments.join("/");
}
