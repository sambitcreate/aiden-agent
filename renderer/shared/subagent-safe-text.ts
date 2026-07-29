import { decodeHTML } from "entities";
import { toString as markdownToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

// Keep the credential grammar bounded. These expressions are applied to the
// complete read-file payload in Electron's main process, so an unbounded
// namespace prefix can turn a benign repeated `segment.` input quadratic.
const KEY_SEPARATOR = "(?:[.\\t\\p{Z}\\p{Pd}\\p{Pc}\\u00b7\\u2022\\u2219]{1,4})";
const OPTIONAL_KEY_SEPARATOR = `(?:${KEY_SEPARATOR})?`;
const SENSITIVE_NAMESPACE_PREFIX = `(?:[a-z0-9]{1,32}${KEY_SEPARATOR}){0,8}`;
const SENSITIVE_FIELD =
  `(?!(?:public${OPTIONAL_KEY_SEPARATOR}token)(?=["'\`]?\\s*[:=]))` +
  SENSITIVE_NAMESPACE_PREFIX +
  `(?:auth${OPTIONAL_KEY_SEPARATOR}token|access${OPTIONAL_KEY_SEPARATOR}token|api${OPTIONAL_KEY_SEPARATOR}key|authorization|auth(?:orization)?${OPTIONAL_KEY_SEPARATOR}token|aws${OPTIONAL_KEY_SEPARATOR}(?:access${OPTIONAL_KEY_SEPARATOR}key${OPTIONAL_KEY_SEPARATOR}id|secret${OPTIONAL_KEY_SEPARATOR}access${OPTIONAL_KEY_SEPARATOR}key|session${OPTIONAL_KEY_SEPARATOR}token)|client${OPTIONAL_KEY_SEPARATOR}secret|connection${OPTIONAL_KEY_SEPARATOR}string|cookie|credential(?:s)?|database${OPTIONAL_KEY_SEPARATOR}url|db${OPTIONAL_KEY_SEPARATOR}url|encryption${OPTIONAL_KEY_SEPARATOR}key|github${OPTIONAL_KEY_SEPARATOR}token|id${OPTIONAL_KEY_SEPARATOR}token|passwd|password|private${OPTIONAL_KEY_SEPARATOR}token|pwd|refresh${OPTIONAL_KEY_SEPARATOR}token|secret|secret${OPTIONAL_KEY_SEPARATOR}(?:key|token)|session|session${OPTIONAL_KEY_SEPARATOR}id|set${OPTIONAL_KEY_SEPARATOR}cookie|signing${OPTIONAL_KEY_SEPARATOR}key|token)`;
const COMPLETE_ASSIGNED_SECRET = new RegExp(
  `((?<![A-Za-z0-9_-])(?:\\*{1,2}|_{1,2}|~~)?["'\`]?(?:${SENSITIVE_FIELD})["'\`]?(?:\\*{1,2}|_{1,2}|~~)?\\s*[:=]\\s*)([^\\r\\n]+)`,
  "giu",
);
const BLOCK_SCALAR_ASSIGNED_SECRET = new RegExp(
  `((?<![A-Za-z0-9_-])(?:\\*{1,2}|_{1,2}|~~)?["'\`]?(?:${SENSITIVE_FIELD})["'\`]?(?:\\*{1,2}|_{1,2}|~~)?\\s*:\\s*)[>|][+-]?[1-9]?[^\\r\\n]*(?:\\r?\\n(?:[ \\t]+[^\\r\\n]*|(?=\\r?\\n|$)))+`,
  "giu",
);
const CONNECTION_STRING_SECRET = new RegExp(
  `((?<![A-Za-z0-9])(?:\\*{1,2}|_{1,2}|~~)?["'\`]?(?:${SENSITIVE_NAMESPACE_PREFIX})(?:connection${OPTIONAL_KEY_SEPARATOR}string|database${OPTIONAL_KEY_SEPARATOR}url|db${OPTIONAL_KEY_SEPARATOR}url)["'\`]?(?:\\*{1,2}|_{1,2}|~~)?\\s*[:=]\\s*)[^\\r\\n]+`,
  "giu",
);
const BEARER_SECRET =
  /(?<![A-Za-z0-9])Bearer\s+(?:\*{1,2}|_{1,2}|~~)?[A-Za-z0-9._~+/=-]+(?:\*{1,2}|_{1,2}|~~)?/giu;
const BASIC_SECRET =
  /(?<![A-Za-z0-9])Basic\s+(?:\*{1,2}|_{1,2}|~~)?[A-Za-z0-9+/=]+(?:\*{1,2}|_{1,2}|~~)?/giu;
const CREDENTIAL_URI = /((?<![A-Za-z0-9])[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu;
const TOKEN_SECRET =
  /(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|SG\.[0-9A-Za-z_-]{12,}\.[0-9A-Za-z_-]{12,}|eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}|gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,}|glpat-[0-9A-Za-z_-]{10,}|hf_[0-9A-Za-z]{10,}|npm_[0-9A-Za-z]{10,}|pypi-[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{8,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{12,}|xox[baprs]-[0-9A-Za-z-]{8,}|ya29\.[0-9A-Za-z_-]{10,})(?![A-Za-z0-9])/gu;
const ASSIGNMENT_SECRET_HINT =
  /auth|access|api|authorization|aws|client|connection|cookie|credential|database|db|encryption|github|passwd|password|private|pwd|refresh|secret|session|signing|token/iu;
const STANDALONE_CREDENTIAL_HINT =
  /-----BEGIN|PuTTY-User-Key-File|ssh-(?:rsa|ed25519)|ecdsa-sha2-|Bearer\s|Basic\s|:\/\/|(?:AKIA|AIza|SG\.|eyJ|gh[pousr]_|github_pat_|glpat-|hf_|npm_|pypi-|sk-|(?:sk|rk)_(?:live|test)_|xox[baprs]-|ya29\.)/iu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY|SSH2 ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY|SSH2 ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|$)/giu;
const PUTTY_PRIVATE_KEY = /PuTTY-User-Key-File-[123]:[\s\S]*$/gimu;
const SSH_KEY_MATERIAL =
  /(^|[\s("'`])(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-[^\s]+)\s+[A-Za-z0-9+/=]{16,}(?:[ \t]+[^\r\n]*)?/gimu;
const FILE_URL = /\bfile:\/\/[^\r\n)\]}"'`<>;,]+/giu;
const HTTP_URL = /(?<![A-Za-z0-9])https?:\/\/[^\s<>"'`]+/giu;
const HTTP_URL_LOCAL_POSIX_PATHNAME =
  /^\/+(?:Applications|Library|System|Users|Volumes|bin|dev|etc|home|mnt|opt|proc|root|run|sbin|srv|tmp|usr|var)(?:\/|$)/u;
const HTTP_URL_LOCAL_WINDOWS_PATHNAME = /^\/+(?:[A-Za-z]:[\\/]|\\\\)/u;
const CONTEXTUAL_REGEX_LITERAL =
  /\b(?:pattern|regex|regexp)\s+\/(?:\\.|[^/\\\r\n])+\/[dgimsuvy]*/giu;
const NUMERIC_DIVISION = /\b\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?\b/gu;
const SAFE_WEB_ROUTE_PREFIX = "(?:_next|api|app|assets|docs|login|logout|settings|users)";
const CONTEXTUAL_WEB_ROUTE = new RegExp(
  `\\b(?:endpoint|route)\\s+\\/${SAFE_WEB_ROUTE_PREFIX}(?:\\/[A-Za-z0-9._~!$&'()*+,:=@%-]+)*`,
  "gu",
);
const HTML_WEB_ROUTE_ATTRIBUTE = new RegExp(
  `\\b(?:action|href|src)=(["'])\\/${SAFE_WEB_ROUTE_PREFIX}(?:\\/[A-Za-z0-9._~!$&'()*+,:=@%-]+)*\\1`,
  "gu",
);
const HTML_CLOSING_TAG = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/gu;
const QUOTED_ABSOLUTE_PATH = /(["'`])(?:\/(?!\/)|[A-Za-z]:\\|\\\\)[^"'`\r\n]+\1/gu;
const GENERIC_POSIX_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}/])\/(?!\/)[^\r\n)\]}"'`<>;,]+/gmu;
const POSIX_ROOT_PATH = /(^|[^\p{L}\p{N}/])\/(?=$|[\s)\]}"'`<>;,])/gmu;
const UNC_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}])\\\\[^\r\n)\]}"'`<>;,]+/gmu;
const FORWARD_UNC_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}/:])\/\/[^\r\n)\]}"'`<>;,]+/gmu;
const WINDOWS_ABSOLUTE_PATH = /(^|[^\p{L}\p{N}])[A-Za-z]:[\\/][^\r\n)\]}"'`<>;,]+/gmu;
const WINDOWS_ROOT_PATH = /(^|[^\p{L}\p{N}])[A-Za-z]:[\\/](?=$|[\s)\]}"'`<>;,])/gmu;
const ENVIRONMENT_ASSIGNMENT_PREFIX =
  /(?<![A-Za-z0-9])(?:\*{1,2}|_{1,2}|~~)?([A-Za-z_][A-Za-z0-9_]{0,63})(?:\*{1,2}|_{1,2}|~~)?([ \t]*[:=][ \t]*)/gu;
const DEFAULT_IGNORABLE_CHARACTER = /\p{Default_Ignorable_Code_Point}/gu;
const LINE_BREAK_CHARACTER = /[\r\n\u2028\u2029]/gu;
const SENSITIVE_PERCENT_ESCAPE = /%([0-9a-f]{2})/giu;
const VALID_PERCENT_RUN = /(?:%[0-9a-f]{2})+/giu;
const BASE64_TOKEN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{8,}={0,2}(?![A-Za-z0-9+/_=-])/gu;
const LINE_WRAPPED_BASE64_TOKEN =
  /(?<![A-Za-z0-9+/_=-])(?:[A-Za-z0-9+/_=-]{1,76}[ \t\r\n]+)+[A-Za-z0-9+/_=-]{1,76}(?![A-Za-z0-9+/_=-])/gu;
const BASE32_TOKEN = /(?<![A-Z2-7=])[A-Z2-7]{16,}={0,6}(?![A-Z2-7=])/giu;
const BASE32HEX_TOKEN = /(?<![A-V0-9=])[A-V0-9]{16,}={0,6}(?![A-V0-9=])/giu;
const WHITESPACE_SEPARATED_PERCENT =
  /(?<!%[0-9a-f])(?:%[0-9a-f]{2}[ \t\r\n]+){2,}%[0-9a-f]{2}(?![0-9a-f])/giu;
const HEX_TOKEN = /(?<![A-Za-z0-9])(?:0x)?[0-9a-f]{16,}(?![A-Za-z0-9])/giu;
const JAVASCRIPT_NUMERIC_ESCAPE =
  /\\(?:u(?:[0-9a-f]{4}|\{[0-9a-f]{1,6}\})|x[0-9a-f]{2}|(?:[0-3][0-7]{2}|[0-7]{2}|0(?![0-9])))/iu;
const JSON_NAMED_CONTROL_ESCAPE = /\\[bfnrt]/u;
const JSON_NAMED_CONTROLS: Readonly<Record<string, string>> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const ASSIGNMENT_KEY_STOP = /[\s:=,;{}[\]]/u;
const ASSIGNMENT_KEY_LEFT_BOUNDARY = /[\p{L}\p{M}\p{N}_-]/u;
const COMBINING_MARK = /\p{M}/u;
const INTERNAL_SECURITY_MARKUP = /(?<=[A-Za-z0-9_])(?:\*{1,2}|__|~~|`{1,3})(?=[A-Za-z0-9_=:])/gu;
const HTML_ENTITY_CANDIDATE = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/iu;
const ENCODED_TEXT_REDACTION = "[REDACTED ENCODED TEXT]";
const CONTROL_SPLIT_REDACTION = "[REDACTED CONTROL-SPLIT TEXT]";
const MARKDOWN_CONTENT_REDACTION = "[REDACTED MARKDOWN CONTENT]";
const RENDERED_REDACTION_PLACEHOLDER = /\[?REDACTED(?: [A-Z-]+)*\]?/gu;
const RENDERED_REDACTED_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])(?:${SENSITIVE_FIELD}|[A-Z][A-Z0-9_]{0,63})\\s*[:=]\\s*\\[?REDACTED(?: [A-Z-]+)*\\]?`,
  "giu",
);
const MARKDOWN_ESCAPABLE_PUNCTUATION = new Set(Array.from("!\"#$%&'()*+,-./:;<=>?@[]^_`{|}~"));
const SNAPSHOT_MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const DISALLOWED_SNAPSHOT_MARKDOWN_NODES = new Set([
  "image",
  "imageReference",
  "inlineMath",
  "math",
]);
const MAX_PERCENT_DECODE_PASSES = 16;
const MAX_ENCODING_DEPTH = 16;
const MAX_ENCODING_STEPS = 2_048;
const MAX_DECODED_CHARACTERS = 128 * 1024;
const MAX_WRAPPED_ENCODING_CHARACTERS = Math.ceil((MAX_DECODED_CHARACTERS * 8) / 5);
const MAX_WRAPPED_ENCODING_CANDIDATES = 2_048;
const MAX_WRAPPED_CANDIDATE_CHARACTERS = MAX_DECODED_CHARACTERS * 4;
const ASSIGNMENT_CONFUSABLES: Readonly<Record<string, string>> = {
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "y",
  χ: "x",
  А: "A",
  В: "B",
  Е: "E",
  Н: "H",
  І: "I",
  Ј: "J",
  К: "K",
  М: "M",
  О: "O",
  Р: "P",
  Ѕ: "S",
  Т: "T",
  Х: "X",
  У: "Y",
  а: "a",
  в: "b",
  г: "r",
  е: "e",
  і: "i",
  ј: "j",
  к: "k",
  м: "m",
  о: "o",
  р: "p",
  с: "c",
  ѕ: "s",
  т: "t",
  х: "x",
  у: "y",
  ԁ: "d",
};
const SENSITIVE_KEY_SKELETONS = [
  "authtoken",
  "accesstoken",
  "apikey",
  "authorization",
  "authorizationtoken",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "awssessiontoken",
  "clientsecret",
  "connectionstring",
  "cookie",
  "credential",
  "credentials",
  "databaseurl",
  "dburl",
  "encryptionkey",
  "githubtoken",
  "idtoken",
  "passwd",
  "password",
  "privatetoken",
  "pwd",
  "refreshtoken",
  "secret",
  "secretkey",
  "secrettoken",
  "session",
  "sessionid",
  "setcookie",
  "signingkey",
  "token",
] as const;

function isNonLineControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    (code >= 0 && code <= 9) ||
    code === 11 ||
    code === 12 ||
    (code >= 14 && code <= 31) ||
    (code >= 127 && code <= 159)
  );
}

function isControl(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code <= 31 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
}

function replaceNonLineControls(value: string, replacement: string): string {
  return Array.from(value)
    .map((character) => (isNonLineControl(character) ? replacement : character))
    .join("");
}

function normalizeMarkdownEscapes(value: string): string {
  const characters = Array.from(value);
  const normalized: string[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const next = characters[index + 1];
    // Preserve doubled backslashes so UNC paths still reach the dedicated
    // absolute-path detector. CommonMark consumes the other ASCII punctuation
    // escapes before users see the text, so the privacy projection must too.
    if (
      character === "\\" &&
      next !== undefined &&
      next !== "\\" &&
      MARKDOWN_ESCAPABLE_PUNCTUATION.has(next)
    ) {
      normalized.push(next);
      index += 1;
    } else {
      normalized.push(character);
    }
  }
  return normalized.join("");
}

function normalizeSensitiveSyntax(value: string): {
  hadEncodedControl: boolean;
  value: string;
} {
  let decoded = value;
  let hadEncodedControl = false;
  for (let pass = 0; pass < 64; pass += 1) {
    for (const [entity] of decoded.matchAll(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu)) {
      if (Array.from(decodeHTML(entity)).some(isControl)) hadEncodedControl = true;
    }
    const next = decodeHTML(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (HTML_ENTITY_CANDIDATE.test(decoded)) {
    return { hadEncodedControl, value: ENCODED_TEXT_REDACTION };
  }
  const hadWhitespaceSeparatedPercent = new RegExp(WHITESPACE_SEPARATED_PERCENT.source, "iu").test(
    decoded,
  );

  let normalized = decoded
    .replace(DEFAULT_IGNORABLE_CHARACTER, "")
    .normalize("NFKC")
    .replace(SENSITIVE_PERCENT_ESCAPE, (escape, hex: string) => {
      const decoded = String.fromCharCode(Number.parseInt(hex, 16));
      return /[A-Za-z0-9_:=-]/u.test(decoded) ? decoded : escape;
    });
  normalized = normalizeMarkdownEscapes(normalized);
  while (true) {
    const withoutInternalMarkup = normalized.replace(INTERNAL_SECURITY_MARKUP, "");
    if (withoutInternalMarkup === normalized) break;
    normalized = withoutInternalMarkup;
  }
  return {
    hadEncodedControl: hadEncodedControl || hadWhitespaceSeparatedPercent,
    value: normalized,
  };
}

function controlVariants(value: string): {
  compact: string;
  hadControls: boolean;
  spaced: string;
} {
  const normalized = normalizeSensitiveSyntax(value);
  const normalizedLines = normalized.value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u2028\u2029]/gu, "\n");
  const hasNonLineControls = Array.from(normalizedLines).some(isNonLineControl);
  const hadControls = hasNonLineControls || normalized.hadEncodedControl;
  const spaced = replaceNonLineControls(normalizedLines, " ");
  let compact = hasNonLineControls ? replaceNonLineControls(normalizedLines, "") : normalizedLines;
  if (normalized.hadEncodedControl) {
    compact = compact.replace(LINE_BREAK_CHARACTER, "");
  }
  return {
    compact,
    hadControls,
    spaced,
  };
}

function sanitizeCredentialText(value: string): string {
  let sanitized = value;
  if ((value.includes("=") || value.includes(":")) && ASSIGNMENT_SECRET_HINT.test(value)) {
    sanitized = sanitized
      .replace(CONNECTION_STRING_SECRET, "$1[REDACTED]")
      .replace(BLOCK_SCALAR_ASSIGNED_SECRET, "$1[REDACTED]")
      .replace(COMPLETE_ASSIGNED_SECRET, (match, prefix: string, rawValue: string) =>
        credentialAssignmentIsReference(prefix, rawValue) ? match : `${prefix}[REDACTED]`,
      );
  }
  if (STANDALONE_CREDENTIAL_HINT.test(value)) {
    sanitized = sanitized
      .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
      .replace(PUTTY_PRIVATE_KEY, "[REDACTED PRIVATE KEY]")
      .replace(SSH_KEY_MATERIAL, "$1[REDACTED SSH KEY]")
      .replace(BEARER_SECRET, "Bearer [REDACTED]")
      .replace(BASIC_SECRET, "Basic [REDACTED]")
      .replace(CREDENTIAL_URI, "$1[REDACTED]@")
      .replace(TOKEN_SECRET, "[REDACTED CREDENTIAL]");
  }
  return sanitized.replace(/(\[REDACTED(?: CREDENTIAL| ABSOLUTE PATH)?\])\]+/gu, "$1");
}

function directCredentialPolicyIsUnsafe(value: string): boolean {
  const { compact, hadControls, spaced } = controlVariants(value);
  return (
    containsObfuscatedAssignmentKey(spaced) ||
    sanitizeCredentialText(spaced) !== spaced ||
    (hadControls &&
      (containsObfuscatedAssignmentKey(compact) || sanitizeCredentialText(compact) !== compact))
  );
}

export function containsHighConfidenceSecret(value: string): boolean {
  return directCredentialPolicyIsUnsafe(value);
}

function credentialAssignmentIsReference(prefix: string, rawValue: string): boolean {
  const value = rawValue
    .trim()
    .replace(/[;,}\]]+$/gu, "")
    .trim();
  if (
    /^(?:(?:process|import\.meta)\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]\r\n]+\])|Deno\.env\.get\([^)\r\n]+\)|os\.environ(?:\[[^\]\r\n]+\]|\.[A-Za-z_][A-Za-z0-9_]*)|getenv\([^)\r\n]+\))$/u.test(
      value,
    )
  ) {
    return true;
  }
  if (
    /(?:^|[^A-Za-z0-9_-])["'`]?(?:session|session(?:[.\t\p{Z}\p{Pd}\p{Pc}\u00b7\u2022\u2219]{1,4})?id)["'`]?\s*[:=]/iu.test(
      prefix,
    ) &&
    (/^(?:await\s+)?(?:new\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\([^"'`\r\n]*\)$/u.test(
      value,
    ) ||
      /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\??\.)[A-Za-z_$][A-Za-z0-9_$]*|\[[A-Za-z_$][A-Za-z0-9_$]*\])+$/u.test(
        value,
      ) ||
      /^(?:active|current|new|next|previous|stored|user)[A-Za-z0-9_$]*Session(?:Id)?$/iu.test(
        value,
      ) ||
      /^\{[^"'`\r\n]*\}$/u.test(value))
  ) {
    // Source-code identifiers are not credential material. Keep literal
    // strings and serialized/header assignments under the conservative rule.
    return true;
  }
  return /authorization/iu.test(prefix) && /^role(?:[- ]based)?$/iu.test(value);
}

function redactAbsolutePaths(value: string): string {
  return value
    .replace(FILE_URL, "[REDACTED ABSOLUTE PATH]")
    .replace(
      QUOTED_ABSOLUTE_PATH,
      (_match, quote: string) => `${quote}[REDACTED ABSOLUTE PATH]${quote}`,
    )
    .replace(GENERIC_POSIX_ABSOLUTE_PATH, "$1[REDACTED ABSOLUTE PATH]")
    .replace(POSIX_ROOT_PATH, "$1[REDACTED ABSOLUTE PATH]")
    .replace(UNC_ABSOLUTE_PATH, "$1[REDACTED ABSOLUTE PATH]")
    .replace(FORWARD_UNC_ABSOLUTE_PATH, "$1[REDACTED ABSOLUTE PATH]")
    .replace(WINDOWS_ABSOLUTE_PATH, "$1[REDACTED ABSOLUTE PATH]")
    .replace(WINDOWS_ROOT_PATH, "$1[REDACTED ABSOLUTE PATH]");
}

function decodeValidPercentRuns(value: string): string {
  return value.replace(VALID_PERCENT_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      // One malformed UTF-8 byte run must not disable decoding of unrelated
      // ASCII escapes elsewhere in the field.
      return run.replace(SENSITIVE_PERCENT_ESCAPE, (escape, hex: string) => {
        const code = Number.parseInt(hex, 16);
        return code <= 0x7f ? String.fromCharCode(code) : escape;
      });
    }
  });
}

function decodePercentLayers(value: string): { exhausted: boolean; value: string } {
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    const next = decodeValidPercentRuns(decoded);
    if (next === decoded) return { exhausted: false, value: decoded };
    decoded = next;
  }
  return {
    exhausted: decodeValidPercentRuns(decoded) !== decoded,
    value: decoded,
  };
}

function containsObfuscatedAssignmentKey(value: string): boolean {
  if (!value.includes("=") && !value.includes(":")) return false;
  const characters = Array.from(value);
  for (let delimiter = 0; delimiter < characters.length; delimiter += 1) {
    if (characters[delimiter] !== "=" && characters[delimiter] !== ":") continue;
    let end = delimiter;
    while (end > 0 && /^\s$/u.test(characters[end - 1]!)) end -= 1;
    let start = end;
    let length = 0;
    while (start > 0 && length < 64 && !ASSIGNMENT_KEY_STOP.test(characters[start - 1]!)) {
      start -= 1;
      length += 1;
    }
    if (length < 2 || (start > 0 && ASSIGNMENT_KEY_LEFT_BOUNDARY.test(characters[start - 1]!))) {
      continue;
    }
    const key = characters.slice(start, end).join("").normalize("NFKC");
    const hasNonAscii = Array.from(key).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);

    let asciiSignals = 0;
    const skeleton = Array.from(key)
      .filter(
        (character) => !COMBINING_MARK.test(character) && character !== "_" && character !== "-",
      )
      .map((character) => {
        const confusable = ASSIGNMENT_CONFUSABLES[character];
        if (confusable) {
          asciiSignals += 1;
          return confusable.toLowerCase();
        }
        if (/^[A-Za-z0-9]$/u.test(character)) {
          asciiSignals += 1;
          return character.toLowerCase();
        }
        return "?";
      })
      .join("");
    if (!skeleton.includes("?")) {
      if (!hasNonAscii) continue;
      const comparison = `${skeleton}=placeholder-value`;
      if (sanitizeVariant(comparison, true) !== comparison) return true;
      continue;
    }
    if (
      asciiSignals >= 2 &&
      SENSITIVE_KEY_SKELETONS.some((sensitive) => {
        return skeleton.includes("?") && skeleton.replace(/\?/gu, "") === sensitive;
      })
    ) {
      return true;
    }
  }
  return false;
}

function decodeBase64Token(token: string): string | undefined {
  const unpadded = token.replace(/=+$/u, "").replace(/-/gu, "+").replace(/_/gu, "/");
  if (unpadded.length % 4 === 1) return undefined;
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeHexToken(token: string): string | undefined {
  const hex = token.startsWith("0x") || token.startsWith("0X") ? token.slice(2) : token;
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeBase32Token(token: string, alphabet: string): string | undefined {
  const normalized = token.toUpperCase();
  const firstPadding = normalized.indexOf("=");
  const encoded = firstPadding < 0 ? normalized : normalized.slice(0, firstPadding);
  const padding = firstPadding < 0 ? "" : normalized.slice(firstPadding);
  if (!/^=*$/u.test(padding)) return undefined;
  const remainder = encoded.length % 8;
  const expectedPadding = new Map([
    [0, 0],
    [2, 6],
    [4, 4],
    [5, 3],
    [7, 1],
  ]).get(remainder);
  if (expectedPadding === undefined || (padding.length > 0 && padding.length !== expectedPadding)) {
    return undefined;
  }
  if (padding.length > 0 && normalized.length % 8 !== 0) return undefined;

  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of encoded) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return undefined;
    bits = bits * 32 + digit;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      const divisor = 2 ** bitCount;
      bytes.push(Math.floor(bits / divisor) & 0xff);
      bits %= divisor;
    }
  }
  if (bitCount > 0 && bits !== 0) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Decode one bounded JavaScript/JSON escape layer. In addition to numeric
 * escapes, JSON's five named control escapes are reversible and can hide
 * credential separators. Doubled backslashes are collapsed only when they
 * reveal one of those bounded escapes for a later pass; arbitrary JavaScript
 * escapes remain uninterpreted.
 */
function decodeJavaScriptEscapeLayer(
  value: string,
): { decodedControl: boolean; value: string } | undefined {
  let decoded = "";
  let decodedBoundedEscape = false;
  let decodedControl = false;
  let collapsedBackslash = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\" || index + 1 >= value.length) {
      decoded += character;
      continue;
    }

    const next = value[index + 1]!;
    if (next === "\\") {
      decoded += "\\";
      collapsedBackslash = true;
      index += 1;
      continue;
    }

    if (next === "u") {
      if (value[index + 2] === "{") {
        const close = value.indexOf("}", index + 3);
        if (close > index + 3 && close - (index + 3) <= 6) {
          const hex = value.slice(index + 3, close);
          const codePoint = /^[0-9a-f]+$/iu.test(hex) ? Number.parseInt(hex, 16) : -1;
          if (codePoint >= 0 && codePoint <= 0x10ffff) {
            const decodedCharacter = String.fromCodePoint(codePoint);
            decoded += decodedCharacter;
            decodedBoundedEscape = true;
            decodedControl ||= Array.from(decodedCharacter).some(isControl);
            index = close;
            continue;
          }
        }
      } else {
        const hex = value.slice(index + 2, index + 6);
        if (hex.length === 4 && /^[0-9a-f]{4}$/iu.test(hex)) {
          const decodedCharacter = String.fromCharCode(Number.parseInt(hex, 16));
          decoded += decodedCharacter;
          decodedBoundedEscape = true;
          decodedControl ||= isControl(decodedCharacter);
          index += 5;
          continue;
        }
      }
    } else if (next === "x") {
      const hex = value.slice(index + 2, index + 4);
      if (hex.length === 2 && /^[0-9a-f]{2}$/iu.test(hex)) {
        const decodedCharacter = String.fromCharCode(Number.parseInt(hex, 16));
        decoded += decodedCharacter;
        decodedBoundedEscape = true;
        decodedControl ||= isControl(decodedCharacter);
        index += 3;
        continue;
      }
    } else if (/^[bfnrt]$/u.test(next)) {
      decoded += JSON_NAMED_CONTROLS[next]!;
      decodedBoundedEscape = true;
      decodedControl = true;
      index += 1;
      continue;
    } else if (/^[0-7]$/u.test(next)) {
      const available = value.slice(index + 1, index + 4);
      let octal = "";
      if (/^[0-3][0-7]{2}/u.test(available)) {
        octal = available.slice(0, 3);
      } else if (/^[0-7]{2}/u.test(available)) {
        octal = available.slice(0, 2);
      } else if (next === "0" && !/^[0-9]$/u.test(value[index + 2] ?? "")) {
        octal = "0";
      }
      if (octal.length > 0) {
        const decodedCharacter = String.fromCharCode(Number.parseInt(octal, 8));
        decoded += decodedCharacter;
        decodedBoundedEscape = true;
        decodedControl ||= isControl(decodedCharacter);
        index += octal.length;
        continue;
      }
    }

    decoded += character;
  }

  if (decodedBoundedEscape) return { decodedControl, value: decoded };
  return collapsedBackslash &&
    (JAVASCRIPT_NUMERIC_ESCAPE.test(decoded) || JSON_NAMED_CONTROL_ESCAPE.test(decoded))
    ? { decodedControl: false, value: decoded }
    : undefined;
}

function sanitizeHttpUrl(url: string): string {
  const authorityStart = url.indexOf("://") + 3;
  const authorityBoundaryOffset = url.slice(authorityStart).search(/[/?#]/u);
  const authorityBoundary =
    authorityBoundaryOffset < 0 ? url.length : authorityStart + authorityBoundaryOffset;
  if (url[authorityBoundary] === "/") {
    const pathnameSuffixOffset = url.slice(authorityBoundary).search(/[?#]/u);
    const pathnameEnd =
      pathnameSuffixOffset < 0 ? url.length : authorityBoundary + pathnameSuffixOffset;
    const decodedPathname = decodePercentLayers(url.slice(authorityBoundary, pathnameEnd));
    const comparablePathname = decodedPathname.value
      .replace(DEFAULT_IGNORABLE_CHARACTER, "")
      .normalize("NFKC");
    if (
      decodedPathname.exhausted ||
      HTTP_URL_LOCAL_POSIX_PATHNAME.test(comparablePathname) ||
      HTTP_URL_LOCAL_WINDOWS_PATHNAME.test(comparablePathname)
    ) {
      return `${url.slice(0, authorityBoundary)}/REDACTED_ABSOLUTE_PATH`;
    }
  }

  const suffixIndex = url.search(/[?#]/u);
  if (suffixIndex < 0) return url;
  const decoded = decodePercentLayers(url.slice(suffixIndex + 1));
  const suffix = decoded.value.normalize("NFKC");
  if (!decoded.exhausted && redactAbsolutePaths(suffix) === suffix) return url;
  return `${url.slice(0, suffixIndex + 1)}REDACTED_ABSOLUTE_PATH`;
}

function sanitizePaths(value: string): string {
  const credentialSafe = sanitizeCredentialText(value);
  let placeholderPrefix = "AIDENSAFETEXTPRESERVED";
  while (credentialSafe.includes(placeholderPrefix)) placeholderPrefix += "X";
  const preservedSyntax: string[] = [];
  let protectedSyntax = credentialSafe;
  const preserve = (pattern: RegExp, transform: (value: string) => string = (value) => value) => {
    protectedSyntax = protectedSyntax.replace(pattern, (value) => {
      const placeholder = `${placeholderPrefix}${preservedSyntax.length}END`;
      preservedSyntax.push(transform(value));
      return placeholder;
    });
  };
  preserve(HTTP_URL, sanitizeHttpUrl);
  preserve(CONTEXTUAL_REGEX_LITERAL);
  preserve(NUMERIC_DIVISION);
  preserve(CONTEXTUAL_WEB_ROUTE);
  preserve(HTML_WEB_ROUTE_ATTRIBUTE);
  preserve(HTML_CLOSING_TAG);
  const withoutPaths = redactAbsolutePaths(protectedSyntax);
  const restoredSyntax = preservedSyntax.reduce(
    (text, value, index) => text.replace(`${placeholderPrefix}${index}END`, value),
    withoutPaths,
  );
  return sanitizeCredentialText(restoredSyntax);
}

function sourceCodeAssignmentContext(value: string, offset: number): boolean {
  // Snapshot fields are bounded, but keep context lookup bounded as well so a
  // long source line with many assignments cannot turn this into a quadratic
  // classifier. We only need the local declaration or parameter context.
  const before = value.slice(Math.max(0, offset - 256), offset);
  const line = before.slice(Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1);
  if (
    /(?:^|[;{}])\s*(?:const|let|var|type|interface|class|enum)\s+$/u.test(line) ||
    /\bfunction(?:\s+[A-Za-z_$][A-Za-z0-9_$]*)?\s*\([^)]*$/u.test(line) ||
    /\b(?:for|while|if|switch)\s*\([^)]*$/u.test(line) ||
    // A destructuring declaration starts with the pattern itself rather than
    // an identifier, so the simple declaration expression above ends before
    // its default values. Keep this narrowly tied to const/let/var instead of
    // treating arbitrary braces as source code.
    /(?:^|[;{}])\s*(?:const|let|var)\s+[{[][^;\r\n]{0,240}$/u.test(line)
  ) {
    return true;
  }
  return arrowParameterAssignmentContext(value, offset);
}

function parenthesizedExpressionStart(line: string, offset: number): number | undefined {
  const opens: number[] = [];
  let quote: string | undefined;
  for (let index = 0; index < offset; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "(") {
      opens.push(index);
    } else if (character === ")") {
      opens.pop();
    }
  }
  return opens.length === 0 ? undefined : opens[opens.length - 1];
}

function matchingParenthesisEnd(line: string, start: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function arrowParameterAssignmentContext(value: string, offset: number): boolean {
  const lineStart =
    Math.max(value.lastIndexOf("\n", offset - 1), value.lastIndexOf("\r", offset - 1)) + 1;
  const nextLineBreak = value.slice(offset).search(/[\r\n]/u);
  const lineEnd = nextLineBreak < 0 ? value.length : offset + nextLineBreak;
  // The limited source window deliberately makes a very long or incomplete
  // pseudo-function ambiguous and therefore private.
  const start = Math.max(lineStart, offset - 256);
  const end = Math.min(lineEnd, offset + 256);
  const line = value.slice(start, end);
  const localOffset = offset - start;
  const parameterStart = parenthesizedExpressionStart(line, localOffset);
  if (parameterStart === undefined) return false;
  const parameterEnd = matchingParenthesisEnd(line, parameterStart);
  if (parameterEnd === undefined || parameterEnd < localOffset) return false;
  // Default parameters, including callback and destructured parameters, are
  // only source controls once their own parenthesized list closes directly
  // into an arrow. A parenthesized shell fragment has no such grammar.
  return /^\s*(?::[^=\r\n]{1,160})?\s*=>/u.test(line.slice(parameterEnd + 1));
}

function base64TokenContaining(value: string, offset: number): boolean {
  let start = offset;
  let end = offset;
  while (start > 0 && /[A-Za-z0-9+/_=-]/u.test(value[start - 1]!)) start -= 1;
  while (end < value.length && /[A-Za-z0-9+/_=-]/u.test(value[end]!)) end += 1;
  return /^[A-Za-z0-9+/_-]{8,}={0,2}$/u.test(value.slice(start, end));
}

function insideQuotedText(line: string, end: number): boolean {
  let quote: string | undefined;
  for (let index = 0; index < end; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === "\\") {
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") quote = character;
  }
  return quote !== undefined;
}

function completeHtmlOpeningTagEnd(line: string, start: number): number | undefined {
  if (!/^<[A-Za-z][A-Za-z0-9-]*/u.test(line.slice(start))) return undefined;
  let quote: string | undefined;
  for (let index = start + 1; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "<") {
      return undefined;
    } else if (character === ">") {
      return index;
    }
  }
  return undefined;
}

function htmlAttributeAssignmentContext(line: string, offset: number): boolean {
  const tagStart = line.lastIndexOf("<", offset);
  if (tagStart < 0 || insideQuotedText(line, tagStart)) return false;
  const tagName = /^<[A-Za-z][A-Za-z0-9-]*/u.exec(line.slice(tagStart));
  if (!tagName || tagStart + tagName[0].length >= offset) return false;
  const tagEnd = completeHtmlOpeningTagEnd(line, tagStart);
  if (tagEnd === undefined || offset >= tagEnd) return false;

  let attributeStart = tagStart + tagName[0].length;
  let quote: string | undefined;
  for (let index = attributeStart; index < offset; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      attributeStart = index + 1;
    }
  }
  // An assignment inside quoted attribute content is not itself an HTML
  // attribute. It can still pass through the independently strict HTTP query
  // rule below, but otherwise privacy wins.
  if (quote) return false;
  const attributePrefix = line.slice(attributeStart, offset);
  return (
    attributePrefix.length === 0 ||
    /^[A-Za-z_:][-A-Za-z0-9_:.]*$/u.test(attributePrefix)
  );
}

function nonShellAssignmentContext(value: string, offset: number): boolean {
  // Lowercase and mixed-case identifiers overlap heavily with HTML
  // attributes and URL query parameters. Those are not shell assignments;
  // everything else that is a tight `name=value` stays private so a shell
  // command can appear after prompts, quoted `sh -c` programs, or prose.
  const lineStart =
    Math.max(value.lastIndexOf("\n", offset - 1), value.lastIndexOf("\r", offset - 1)) + 1;
  const nextLineBreak = value.slice(offset).search(/[\r\n]/u);
  const lineEnd = nextLineBreak < 0 ? value.length : offset + nextLineBreak;
  const start = Math.max(lineStart, offset - 256);
  const end = Math.min(lineEnd, offset + 256);
  const line = value.slice(start, end);
  const localOffset = offset - start;
  return (
    htmlAttributeAssignmentContext(line, localOffset) ||
    /https?:\/\/[^\s<>"'`]*[?&][^?&\s<>"'`]*$/iu.test(line.slice(0, localOffset))
  );
}

function hasUnescapedLineContinuation(value: string, offset: number): boolean {
  let slashes = 0;
  for (let index = offset - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function quotedEnvironmentValueEnd(value: string, start: number): number | undefined {
  const quoteOffset =
    value[start] === "$" && (value[start + 1] === '"' || value[start + 1] === "'")
      ? start + 1
      : start;
  const quote = value[quoteOffset];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;

  for (let index = quoteOffset + 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === quote) return index + 1;
  }
  // An unterminated quoted value can still carry environment data. Preserve
  // no suffix whose ownership is ambiguous at this renderer-safe boundary.
  return value.length;
}

function indentedEnvironmentValueEnd(value: string, end: number): number {
  let valueEnd = end;
  let sawIndentedLine = false;
  while (value[valueEnd] === "\r" || value[valueEnd] === "\n") {
    let next = valueEnd + 1;
    if (value[valueEnd] === "\r" && value[next] === "\n") next += 1;
    const contentStart = next;
    while (value[next] === " " || value[next] === "\t") next += 1;
    if (next === contentStart) {
      if (!sawIndentedLine) return valueEnd;
      valueEnd = next;
      continue;
    }
    sawIndentedLine = true;
    while (next < value.length && value[next] !== "\r" && value[next] !== "\n") next += 1;
    valueEnd = next;
  }
  return valueEnd;
}

function environmentValueEnd(value: string, start: number): number {
  const quoted = quotedEnvironmentValueEnd(value, start);
  if (quoted !== undefined) return quoted;

  let end = start;
  while (end < value.length) {
    const character = value[end]!;
    if (character === "\r" || character === "\n") {
      if (!hasUnescapedLineContinuation(value, end)) {
        return indentedEnvironmentValueEnd(value, end);
      }
      if (character === "\r" && value[end + 1] === "\n") end += 1;
    }
    end += 1;
  }
  return end;
}

function redactEnvironmentAssignments(value: string): string {
  let cursor = 0;
  let redacted = "";
  let changed = false;
  for (const match of value.matchAll(ENVIRONMENT_ASSIGNMENT_PREFIX)) {
    const offset = match.index;
    if (offset === undefined || offset < cursor) continue;
    const name = match[1]!;
    const delimiter = match[2]!;
    const isConventionalEnvironmentName = name === name.toUpperCase();
    const isTightEqualsAssignment = delimiter.startsWith("=");
    // POSIX uses `=` for assignments. Treat a one-letter `X:` label or a
    // spaced mathematical `X = value` expression as ordinary text. Lowercase
    // and mixed-case names are valid shell variables too; redact every tight
    // form except source code, HTML/URL syntax, or a complete Base64 token.
    // Keep the established broader policy for conventional names such as
    // NODE_ENV in structured output.
    if (
      (name.length === 1 && delimiter !== "=") ||
      sourceCodeAssignmentContext(value, offset) ||
      (!isConventionalEnvironmentName &&
        (!isTightEqualsAssignment ||
          base64TokenContaining(value, offset) ||
          nonShellAssignmentContext(value, offset)))
    ) {
      continue;
    }
    const valueStart = offset + match[0].length;
    const valueEnd = environmentValueEnd(value, valueStart);
    if (valueEnd <= valueStart) continue;
    redacted += `${value.slice(cursor, offset)}${match[0]}[REDACTED ENVIRONMENT VALUE]`;
    cursor = valueEnd;
    changed = true;
  }
  return changed ? `${redacted}${value.slice(cursor)}` : value;
}

function sanitizeVariant(value: string, includeEnvironment: boolean): string {
  const environmentSafe = includeEnvironment
    ? redactEnvironmentAssignments(value)
        .replace(/(\[REDACTED ENVIRONMENT VALUE\])\]+/gu, "$1")
    : value;
  return sanitizePaths(sanitizePaths(environmentSafe));
}

function markdownContainsNodeType(value: unknown, types: ReadonlySet<string>): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as { children?: unknown[]; type?: unknown };
  if (typeof node.type === "string" && types.has(node.type)) return true;
  return Array.isArray(node.children)
    ? node.children.some((child) => markdownContainsNodeType(child, types))
    : false;
}

function stripGeneratedRedactions(value: string): string {
  return value
    .replace(RENDERED_REDACTED_ASSIGNMENT, "")
    .replace(RENDERED_REDACTION_PLACEHOLDER, "");
}

function markdownContainsUnsafeMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as {
    children?: unknown[];
    title?: unknown;
    url?: unknown;
  };
  for (const candidate of [node.url, node.title]) {
    if (typeof candidate !== "string") continue;
    const decoded = decodePercentLayers(candidate);
    if (decoded.exhausted) return true;
    const comparable = stripGeneratedRedactions(decoded.value);
    if (nonMarkdownPolicyIsUnsafe(comparable, true)) return true;
  }
  return Array.isArray(node.children)
    ? node.children.some((child) => markdownContainsUnsafeMetadata(child))
    : false;
}

function rendererMarkdownIsUnsafe(value: string): boolean {
  try {
    const tree = SNAPSHOT_MARKDOWN_PARSER.parse(value);
    // V1 inspector output never needs active remote resources. Math is also
    // rejected because KaTeX can turn TeX commands into visible identifier
    // characters that are absent from the source string.
    if (
      markdownContainsNodeType(tree, DISALLOWED_SNAPSHOT_MARKDOWN_NODES) ||
      markdownContainsUnsafeMetadata(tree)
    ) {
      return true;
    }
    // Generated placeholders are already policy output. Remove their rendered
    // form—and an assignment that owns one—before comparing production-visible
    // text with the raw sanitizer.
    const renderedText = stripGeneratedRedactions(
      markdownToString(tree, { includeImageAlt: true }),
    );
    return nonMarkdownPolicyIsUnsafe(renderedText, true);
  } catch {
    return true;
  }
}

function directPolicyIsUnsafe(value: string, includeEnvironment: boolean): boolean {
  const { compact, hadControls, spaced } = controlVariants(value);
  if (
    containsObfuscatedAssignmentKey(spaced) ||
    sanitizeVariant(spaced, includeEnvironment) !== spaced
  ) {
    return true;
  }
  return (
    hadControls &&
    (containsObfuscatedAssignmentKey(compact) ||
      sanitizeVariant(compact, includeEnvironment) !== compact)
  );
}

function wrappedEncodingCompacts(candidate: string): {
  exhausted: boolean;
  values: string[];
} {
  const compacts: string[] = [];
  let candidateCharacters = 0;
  let exhausted = false;
  for (const [token] of candidate.matchAll(LINE_WRAPPED_BASE64_TOKEN)) {
    const chunks = token.trim().split(/[ \t\r\n]+/u);
    if (chunks.length < 2) continue;

    // Prefixes from grep output and ordinary prose can frame both sides of an
    // encoded payload. Inspect every contiguous chunk range rather than a
    // bypassable fixed number of edge trims. The explicit count and aggregate
    // character budgets make hostile long runs fail closed before this search
    // can become an unbounded quadratic workload.
    for (let start = 0; start < chunks.length - 1; start += 1) {
      let compact = chunks[start]!;
      for (let end = start + 1; end < chunks.length; end += 1) {
        compact += chunks[end]!;
        if (compact.length > MAX_WRAPPED_ENCODING_CHARACTERS) {
          exhausted = true;
          break;
        }
        if (compact.length < 8) continue;
        candidateCharacters += compact.length;
        if (
          compacts.length >= MAX_WRAPPED_ENCODING_CANDIDATES ||
          candidateCharacters > MAX_WRAPPED_CANDIDATE_CHARACTERS
        ) {
          return { exhausted: true, values: Array.from(new Set(compacts)) };
        }
        compacts.push(compact);
      }
    }
  }
  return { exhausted, values: Array.from(new Set(compacts)) };
}

function decodedEncodingPayloads(candidate: string): {
  exhausted: boolean;
  payloads: string[];
} {
  const escapeLayer = decodeJavaScriptEscapeLayer(candidate);
  const payloads = [
    escapeLayer?.value,
    ...Array.from(candidate.matchAll(BASE64_TOKEN), ([token]) => decodeBase64Token(token)),
    ...Array.from(candidate.matchAll(HEX_TOKEN), ([token]) => decodeHexToken(token)),
    ...Array.from(candidate.matchAll(BASE32_TOKEN), ([token]) =>
      decodeBase32Token(token, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
    ),
    ...Array.from(candidate.matchAll(BASE32HEX_TOKEN), ([token]) =>
      decodeBase32Token(token, "0123456789ABCDEFGHIJKLMNOPQRSTUV"),
    ),
  ];
  const wrapped = wrappedEncodingCompacts(candidate);
  for (const compact of wrapped.values) {
    payloads.push(
      decodeBase64Token(compact),
      decodeHexToken(compact),
      decodeBase32Token(compact, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"),
      decodeBase32Token(compact, "0123456789ABCDEFGHIJKLMNOPQRSTUV"),
    );
  }
  if (escapeLayer?.decodedControl) {
    payloads.push(
      Array.from(escapeLayer.value)
        .filter((character) => !isControl(character))
        .join(""),
    );
  }
  let exhausted = wrapped.exhausted;
  for (const [token] of candidate.matchAll(WHITESPACE_SEPARATED_PERCENT)) {
    const decoded = decodePercentLayers(token.replace(/[ \t\r\n]+/gu, ""));
    exhausted ||= decoded.exhausted;
    if (decoded.value !== token) payloads.push(decoded.value);
  }
  return {
    exhausted,
    payloads: payloads.filter(
      (decoded): decoded is string => decoded !== undefined && decoded.length > 0,
    ),
  };
}

function encodedPayloadIsUnsafe(
  value: string,
  policyIsUnsafe: (candidate: string) => boolean,
): boolean {
  const worklist = [{ depth: 0, value }];
  const seen = new Set([value]);
  let decodedCharacters = 0;
  let steps = 0;
  while (worklist.length > 0) {
    const candidate = worklist.pop()!;
    const decoded = decodedEncodingPayloads(candidate.value);
    if (decoded.exhausted) return true;
    const { payloads } = decoded;
    if (candidate.depth >= MAX_ENCODING_DEPTH && payloads.length > 0) return true;
    for (const decoded of payloads) {
      steps += 1;
      decodedCharacters += decoded.length;
      if (steps > MAX_ENCODING_STEPS || decodedCharacters > MAX_DECODED_CHARACTERS) return true;
      const normalized = decoded.replace(DEFAULT_IGNORABLE_CHARACTER, "").normalize("NFKC");
      const percentDecoded = decodePercentLayers(normalized);
      if (
        percentDecoded.exhausted ||
        policyIsUnsafe(normalized) ||
        (percentDecoded.value !== normalized && policyIsUnsafe(percentDecoded.value))
      ) {
        return true;
      }
      for (const next of [normalized, percentDecoded.value]) {
        if (seen.has(next)) continue;
        seen.add(next);
        worklist.push({ depth: candidate.depth + 1, value: next });
      }
    }
  }
  return false;
}

function nonMarkdownPolicyIsUnsafe(value: string, includeEnvironment: boolean): boolean {
  const policyIsUnsafe = (candidate: string) => directPolicyIsUnsafe(candidate, includeEnvironment);
  if (policyIsUnsafe(value)) return true;
  const percentDecoded = decodePercentLayers(value);
  if (percentDecoded.exhausted) return true;
  if (percentDecoded.value !== value && policyIsUnsafe(percentDecoded.value)) {
    return true;
  }
  return (
    encodedPayloadIsUnsafe(value, policyIsUnsafe) ||
    (percentDecoded.value !== value && encodedPayloadIsUnsafe(percentDecoded.value, policyIsUnsafe))
  );
}

/**
 * Reject raw or reversibly encoded credentials at model-facing file boundaries
 * without treating ordinary absolute paths as credential material.
 */
export function containsHighConfidenceSecretIncludingEncodings(value: string): boolean {
  if (directCredentialPolicyIsUnsafe(value)) return true;
  const decodedPolicyIsUnsafe = (candidate: string) => directPolicyIsUnsafe(candidate, false);
  const percentDecoded = decodePercentLayers(value);
  if (percentDecoded.exhausted) return true;
  if (percentDecoded.value !== value && decodedPolicyIsUnsafe(percentDecoded.value)) {
    return true;
  }
  return (
    encodedPayloadIsUnsafe(value, decodedPolicyIsUnsafe) ||
    (percentDecoded.value !== value &&
      encodedPayloadIsUnsafe(percentDecoded.value, decodedPolicyIsUnsafe))
  );
}

function sanitizeWithPolicy(value: string, includeEnvironment: boolean): string {
  const { compact, hadControls, spaced } = controlVariants(value);
  const safe = sanitizeVariant(spaced, includeEnvironment);
  if (nonMarkdownPolicyIsUnsafe(safe, includeEnvironment)) return ENCODED_TEXT_REDACTION;
  if (hadControls) {
    const compactSafe = sanitizeVariant(compact, includeEnvironment);
    if (compactSafe !== compact || nonMarkdownPolicyIsUnsafe(compactSafe, includeEnvironment)) {
      return CONTROL_SPLIT_REDACTION;
    }
    if (includeEnvironment && rendererMarkdownIsUnsafe(compactSafe)) {
      return MARKDOWN_CONTENT_REDACTION;
    }
  }
  if (includeEnvironment && rendererMarkdownIsUnsafe(safe)) {
    return MARKDOWN_CONTENT_REDACTION;
  }
  return safe;
}

/** Strip high-confidence credentials and absolute filesystem paths at trust boundaries. */
export function sanitizeSubagentText(value: string): string {
  return sanitizeWithPolicy(value, false);
}

/**
 * Renderer snapshots are stricter than model-facing reports: even ordinary
 * environment assignments are hidden because no environment data belongs in
 * persisted or IPC-visible child state.
 */
export function sanitizeSubagentSnapshotText(value: string): string {
  return sanitizeWithPolicy(value, true);
}
