import { redactBareCredentialTokens } from "./credential-tokens.js";
import { decodeHTMLStrict } from "entities";
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
const ASSIGNMENT_SECRET_HINT =
  /auth|access|api|authorization|aws|client|connection|cookie|credential|database|db|encryption|github|passwd|password|private|pwd|refresh|secret|session|signing|token/iu;
const STANDALONE_CREDENTIAL_HINT =
  /-----BEGIN|PuTTY-User-Key-File|Bearer\s|Basic\s|:\/\/|(?:AKIA|AIza|SG\.|eyJ|gh[pousr]_|github_pat_|glpat-|hf_|npm_|pypi-|sk-|(?:sk|rk)_(?:live|test)_|xox[baprs]-|ya29\.)/iu;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY|SSH2 ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY|SSH2 ENCRYPTED PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----|$)/giu;
const PUTTY_PRIVATE_KEY = /PuTTY-User-Key-File-[123]:[\s\S]*$/gimu;
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
  `\\b(?:[Ee]ndpoint|[Rr]oute)\\s+\\/${SAFE_WEB_ROUTE_PREFIX}(?:\\/[A-Za-z0-9._~!$&'()*+,:=@%-]+)*`,
  "gu",
);
const HTML_WEB_ROUTE_ATTRIBUTE = new RegExp(
  `\\b(?:action|href|src)=(["'])\\/${SAFE_WEB_ROUTE_PREFIX}(?:\\/[A-Za-z0-9._~!$&'()*+,:=@%-]+)*\\1`,
  "gu",
);
const HTTP_REQUEST_WEB_ROUTE = new RegExp(
  `\\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\\s+\\/${SAFE_WEB_ROUTE_PREFIX}(?:\\/[A-Za-z0-9._~!$&'()*+,:=@%-]+)*(?=\\s|$)`,
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
const HAS_WHITESPACE_SEPARATED_PERCENT = new RegExp(WHITESPACE_SEPARATED_PERCENT.source, "iu");
const WRAPPED_ENCODING_WHITESPACE = /[ \t\r\n]/u;
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
const INTERNAL_SECURITY_MARKUP_TRIGGER = /[*`]|__|~~/u;
const ENCODED_TEXT_REDACTION = "[REDACTED ENCODED TEXT]";
const UNSETTLED_TEXT_REDACTION = "[REDACTED TEXT]";
/** A percent escape or HTML character reference left in text after filtering. */
const ENCODING_ESCAPE = /%[0-9A-Fa-f]{2}|&(?:#\d+|#x[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/iu;
const CONTROL_SPLIT_REDACTION = "[REDACTED CONTROL-SPLIT TEXT]";
const MARKDOWN_CONTENT_REDACTION = "[REDACTED MARKDOWN CONTENT]";
const RENDERED_REDACTION_PLACEHOLDER = /\[?REDACTED(?: [A-Z-]+)*\]?/gu;
const RENDERED_REDACTED_ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9])(?:${SENSITIVE_FIELD}|[A-Z][A-Z0-9_]{0,63})\\s*[:=]\\s*\\[?REDACTED(?: [A-Z-]+)*\\]?`,
  "giu",
);
const MARKDOWN_ESCAPABLE_PUNCTUATION = new Set(Array.from("!\"#$%&'()*+,-./:;<=>?@[]^_`{|}~"));
const SNAPSHOT_MARKDOWN_PARSER = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const MARKDOWN_LINE_BREAK_TRIGGER = /[\r\n\u2028\u2029]/u;
const MARKDOWN_EDGE_WHITESPACE_TRIGGER = /^\s|\s$/u;
const MARKDOWN_SYNTAX_TRIGGER = /[#>*`~[\]<>\\&$|]/u;
const MARKDOWN_BLOCK_PREFIX_TRIGGER = /^(?:[-+]|\d{1,9}[.)](?:\s|$))/u;
const GFM_WWW_AUTOLINK_TRIGGER = /www\./iu;
const REDACTED_MARKER_TRIGGER = /redacted/iu;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BASE32_EXPECTED_PADDING: ReadonlyMap<number, number> = new Map([
  [0, 0],
  [2, 6],
  [4, 4],
  [5, 3],
  [7, 1],
]);
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

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

function hasNonLineControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0 && code <= 9) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeSensitiveSyntax(value: string): {
  hadEncodedControl: boolean;
  value: string;
} {
  let decoded = value;
  let hadEncodedControl = false;
  if (decoded.includes("&") && decoded.includes(";")) {
    for (let pass = 0; pass < 64; pass += 1) {
      if (!decoded.includes("&") || !decoded.includes(";")) break;
      for (const [entity] of decoded.matchAll(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu)) {
        if (Array.from(decodeHTMLStrict(entity)).some(isControl)) hadEncodedControl = true;
      }
      const next = decodeHTMLStrict(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  }
  const hadWhitespaceSeparatedPercent =
    decoded.includes("%") && HAS_WHITESPACE_SEPARATED_PERCENT.test(decoded);

  let normalized = hasNonAscii(decoded)
    ? decoded.replace(DEFAULT_IGNORABLE_CHARACTER, "").normalize("NFKC")
    : decoded;
  if (normalized.includes("%")) {
    normalized = normalized.replace(SENSITIVE_PERCENT_ESCAPE, (escape, hex: string) => {
      const decodedChar = String.fromCharCode(Number.parseInt(hex, 16));
      return /[A-Za-z0-9_:=-]/u.test(decodedChar) ? decodedChar : escape;
    });
  }
  if (normalized.includes("\\")) {
    normalized = normalizeMarkdownEscapes(normalized);
  }
  while (INTERNAL_SECURITY_MARKUP_TRIGGER.test(normalized)) {
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
  const normalizedLines = /[\r\u2028\u2029]/u.test(normalized.value)
    ? normalized.value.replace(/\r\n?/gu, "\n").replace(/[\u2028\u2029]/gu, "\n")
    : normalized.value;
  const hasNonLineControls = hasNonLineControl(normalizedLines);
  const hadControls = hasNonLineControls || normalized.hadEncodedControl;
  const spaced = hasNonLineControls ? replaceNonLineControls(normalizedLines, " ") : normalizedLines;
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

/**
 * Redact only credentials that span lines (YAML block scalars, private-key blocks) so a later
 * per-line pass cannot separate their opening line from the body. Single-line tokens are left
 * whole for control-aware inspection.
 */
export function redactMultilineCredentialBlocks(value: string): string {
  let sanitized = value;
  if (value.includes(":") && ASSIGNMENT_SECRET_HINT.test(value)) sanitized = sanitized.replace(BLOCK_SCALAR_ASSIGNED_SECRET, "$1[REDACTED]");
  if (STANDALONE_CREDENTIAL_HINT.test(value)) {
    sanitized = sanitized.replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]").replace(PUTTY_PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  }
  return sanitized;
}

export function sanitizeCredentialText(value: string): string {
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
      .replace(BEARER_SECRET, "Bearer [REDACTED]")
      .replace(BASIC_SECRET, "Basic [REDACTED]")
      .replace(CREDENTIAL_URI, "$1[REDACTED]@");
  }
  return redactBareCredentialTokens(sanitized, "[REDACTED CREDENTIAL]").replace(/(\[REDACTED(?: CREDENTIAL| ABSOLUTE PATH)?\])\]+/gu, "$1");
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
  if (!value.includes("%")) return { exhausted: false, value };
  let decoded = value;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    if (!decoded.includes("%")) return { exhausted: false, value: decoded };
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
    return FATAL_UTF8_DECODER.decode(bytes);
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
    return FATAL_UTF8_DECODER.decode(bytes);
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
  const expectedPadding = BASE32_EXPECTED_PADDING.get(remainder);
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
    return FATAL_UTF8_DECODER.decode(Uint8Array.from(bytes));
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
  preserve(HTTP_REQUEST_WEB_ROUTE);
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
  return attributePrefix.length === 0 || /^[A-Za-z_:][-A-Za-z0-9_:.]*$/u.test(attributePrefix);
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

/**
 * End of an indented block value. The block ends at the line break before the
 * next unindented line, so that line break stays in the output and a second
 * pass over redacted text gives the same text. Blank lines inside the block
 * are kept with it only when more indented lines follow them.
 */
function indentedEnvironmentValueEnd(value: string, end: number): number {
  let valueEnd = end;
  let cursor = end;
  let sawIndentedLine = false;
  while (value[cursor] === "\r" || value[cursor] === "\n") {
    let next = cursor + 1;
    if (value[cursor] === "\r" && value[next] === "\n") next += 1;
    const contentStart = next;
    while (value[next] === " " || value[next] === "\t") next += 1;
    if (next === contentStart) {
      if (!sawIndentedLine) return valueEnd;
      cursor = next;
      continue;
    }
    sawIndentedLine = true;
    while (next < value.length && value[next] !== "\r" && value[next] !== "\n") next += 1;
    valueEnd = next;
    cursor = next;
  }
  return valueEnd;
}

function blockValueStartsOnNextLine(value: string, start: number): boolean {
  return value[start] === "\r" || value[start] === "\n";
}

/**
 * Secret hints in a setting-shaped colon-and-block name: all caps, snake or
 * kebab case, or camelCase. The name, without `_` and `-`, ends in one of
 * these words, so `API_KEY`, `APITOKEN`, `apiToken` and `PASSPHRASE` count.
 */
const BLOCK_NAME_SECRET_ENDING =
  /(?:key|token|secret|password|passwd|passphrase|passcode|pwd|jwt|cred|creds|credential|cookie|otp|totp|cvv|seed|mnemonic|private|signature|(?:seed|recovery|secret|backup|wallet|mnemonic)phrase|(?:recovery|backup)code)s?$/u;
/**
 * A plain word, such as a prose heading, is a hint only when it is exactly one
 * of these, so `Password:` and `Credentials:` count but `Keys:`, `Tokens:`,
 * `Hotkeys:` and `Design tokens:` do not. Plurals that read as prose headings
 * (`keys`, `tokens`, `cookies`) stay out on purpose.
 */
const BLOCK_NAME_SECRET_WORD: ReadonlySet<string> = new Set([
  "key", "token", "secret", "secrets", "password", "passwd", "passphrase", "passcode", "pwd", "jwt",
  "cred", "creds", "credential", "credentials", "cookie", "apikey", "authtoken", "accesstoken",
  "otp", "totp", "cvv", "seed", "mnemonic", "private", "signature",
]);
/** Whole names that are secrets without a secret ending. */
const BLOCK_NAME_SECRET_EXACT: ReadonlySet<string> = new Set([
  "authorization", "sessionid", "sessiontoken", "privatekey",
]);

function blockNameIsSettingShaped(name: string): boolean {
  return /^[A-Z0-9_-]*[A-Z][A-Z0-9_-]*$/u.test(name) || /[_-]/u.test(name) || /[a-z0-9][A-Z]/u.test(name);
}

function blockNameHasSecretHint(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_-]/gu, "");
  return (
    (blockNameIsSettingShaped(name)
      ? BLOCK_NAME_SECRET_ENDING.test(normalized)
      : BLOCK_NAME_SECRET_WORD.has(normalized)) ||
    BLOCK_NAME_SECRET_EXACT.has(normalized) ||
    // A PIN is only a whole segment: `PIN`, `ATM_PIN`, but not `SPIN`.
    /(?:^|[_-])pin$/iu.test(name)
  );
}

/**
 * A bare all-caps word followed by a colon and an indented block, like
 * `JSON:`, `README:` or `TASK:`, reads as a label when the word carries no
 * secret hint. Names with an underscore or digit stay setting-shaped.
 */
function colonBlockNameIsLabel(name: string): boolean {
  return /^[A-Z]{2,64}$/u.test(name) && !blockNameHasSecretHint(name);
}

/** One opaque token of letters and digits on a line of its own. */
const OPAQUE_BLOCK_TOKEN = /^(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9+/_=.-]{12,}$/u;

/**
 * A label's block still hides when its value looks like a credential: the
 * existing credential detectors flag it, or it is a single opaque token.
 */
function labelBlockLooksLikeCredential(block: string): boolean {
  const lines = block.split(/\r\n|[\r\n]/u).map((line) => line.trim()).filter(Boolean);
  return (
    containsHighConfidenceSecretIncludingEncodings(block) ||
    (lines.length === 1 && OPAQUE_BLOCK_TOKEN.test(lines[0]!)) ||
    // A base64 body wrapped over several lines, like a key or certificate.
    (lines.length > 1 && lines.every((line) => MULTILINE_BASE64_LINE.test(line))) ||
    // A recovery phrase: twelve or more lowercase words and nothing else.
    (lines.length >= 1 && isRecoveryPhrase(lines.join(" ")))
  );
}

const MULTILINE_BASE64_LINE = /^[A-Za-z0-9+/]{16,}={0,2}$/u;
const RECOVERY_WORD = /^[a-z]{2,12}$/u;
const RECOVERY_NUMBERING = /^\d{1,2}[.):-]?$/u;
/** A list number written onto its word, as in `1.word` or `1-word`. */
const RECOVERY_NUMBER_PREFIX = /^\d{1,2}[.):-](?=[A-Za-z])/u;

/** The words of a possible recovery phrase, without list numbers. */
function recoveryPhraseWords(text: string): string[] {
  return text.trim().replace(/[.,;:!]+$/u, "").split(/[\s,]+/u)
    .map((word) => word.replace(RECOVERY_NUMBER_PREFIX, ""))
    .filter((word) => word && !RECOVERY_NUMBERING.test(word));
}

/**
 * A wallet-style recovery phrase: twelve or more words and nothing else, all
 * in lowercase, all in capitals or all in Title Case. Commas between them,
 * numbering such as `1. word`, `1.word` or `1-word`, and punctuation at the
 * end are allowed. A sentence, which capitalises only its first word, is not
 * one.
 */
function isRecoveryPhrase(text: string): boolean {
  const words = recoveryPhraseWords(text);
  if (words.length < 12) return false;
  const oneCase = words.every((word) => /^[a-z]+$/u.test(word)) ||
    words.every((word) => /^[A-Z]+$/u.test(word)) ||
    words.every((word) => /^[A-Z][a-z]+$/u.test(word));
  return oneCase && words.every((word) => RECOVERY_WORD.test(word.toLowerCase()));
}

/**
 * A two-word secret name whose last word alone is ordinary, such as
 * `Seed phrase`, `recovery phrase` or `Backup codes`. Returns where the name
 * starts when the word before `name` (ending at `offset`) completes one.
 */
function twoWordSecretNameStart(value: string, offset: number, name: string): number | undefined {
  const last = name.toLowerCase();
  const first = /^(?:phrases?|words)$/u.test(last)
    ? /(?:^|[^A-Za-z0-9_])((?:seed|recovery|secret|backup|wallet|mnemonic)[ \t]+)$/iu
    : /^codes?$/u.test(last)
      ? /(?:^|[^A-Za-z0-9_])((?:recovery|backup|pin)[ \t]+)$/iu
      : last === "number"
        ? /(?:^|[^A-Za-z0-9_])(pin[ \t]+)$/iu
        : undefined;
  if (!first) return undefined;
  const match = first.exec(value.slice(Math.max(0, offset - 32), offset));
  return match ? offset - match[1]!.length : undefined;
}

/**
 * Names whose values are often ordinary: a random seed, a signature or OTP
 * algorithm, a `private` flag. They hide only values that look secret. A TOTP
 * value is the shared secret itself, so `totp` is not one of them.
 */
const WEAK_SECRET_NAME = /(?:seed|signature|otp|cvv|pin|private)s?$/u;
/**
 * Ordinary words a weak name's value can be, such as an algorithm, a type or
 * a delivery method (`signature: "sha256"`, `otp: string`, `otp: sms`),
 * compared without `-` and `_`.
 */
const PLAIN_WEAK_VALUE: ReadonlySet<string> = new Set([
  "sha1", "sha224", "sha256", "sha384", "sha512", "sha3", "md5", "hmac", "hmacsha1", "hmacsha256",
  "hmacsha512", "hs256", "hs384", "hs512", "rs256", "rs384", "rs512", "es256", "es384", "es512",
  "ps256", "eddsa", "ed25519", "ecdsa", "rsa", "rsasha256", "dsa", "pss", "pkcs1", "pkcs8",
  "base64", "base64url", "hex", "utf8", "string", "str", "number", "boolean", "bool", "int",
  "integer", "float", "bytes", "buffer", "object", "array", "any", "unknown", "text", "sms",
  "email", "voice", "app", "authenticator", "totp", "hotp", "push", "random", "auto", "default",
  "fixed", "static", "disabled", "enabled", "pending", "unset", "empty", "hidden", "masked",
  "public", "internal", "protected", "readonly",
]);
/** A count of tokens, such as `max_tokens` or `inputTokens`, not a credential. */
const TOKEN_COUNT_NAME = /(?:tokens|^(?:max|min|num|total|input|output|prompt|completion|cached|reasoning)token)$/u;
const PLAIN_INTEGER = /^\d{1,3}(?:[,_]\d{3})+[,;]?$|^\d+[,;]?$/u;
/** A long opaque token, like a key or a wallet seed in hex or base64. */
const OPAQUE_SEED_VALUE = /^(?!\d+$)[A-Za-z0-9+/=_.-]{16,}$/u;

/** `NAME: value` or `NAME=value` on one line, where the value starts on that line. */
const SAME_LINE_NAMED_VALUE =
  /(^|[^A-Za-z0-9_.$])((?:\*{1,2}|_{1,2}|~~)?(["'`]?)([A-Za-z_][A-Za-z0-9_-]{0,63})\3(?:\*{1,2}|_{1,2}|~~)?[ \t]*(?::(?!:)|=(?![=>~]))[ \t]*)(?=[^\s])/gu;
const REFERENCE_VALUE =
  /^(?:\$|%[A-Za-z_]|(?:process|import\.meta)\.env\b|os\.environ\b|Deno\.env\b|getenv\(|env\(|\[REDACTED|<[^>]*>$|\*{3,}|x{3,}$|(?:\/|~\/|\.\.?\/)|(?:true|false|null|undefined|none|nil|yes|no|on|off|required|optional|n\/a)\b)/iu;
const CALL_OR_MEMBER_VALUE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\??\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:\(|\??\.[A-Za-z_$])/u;
const PLAIN_NAME_PREFIX = /(?:^|[\r\n])[ \t]*(?:(?:[-*+\u2022]|\d{1,3}[.)])[ \t]+)?(?:\*{1,2}|_{1,2}|~~)?$/u;

function secretValueEnd(line: string, start: number, toEndOfLine: boolean): number {
  const quote = line[start];
  if (quote === "\"" || quote === "'" || quote === "`") {
    const close = line.indexOf(quote, start + 1);
    return close === -1 ? line.length : close + 1;
  }
  if (toEndOfLine) {
    let end = line.length;
    while (end > start && /\s/u.test(line[end - 1]!)) end -= 1;
    return end;
  }
  let end = start;
  while (end < line.length && !/[\s,;)\]}]/u.test(line[end]!)) end += 1;
  return end;
}

function secretValueIsShown(value: string): boolean {
  const unquoted = value.replace(/^["'`]|["'`]$/gu, "").trim();
  return (
    unquoted.length < 3 ||
    REFERENCE_VALUE.test(unquoted) ||
    CALL_OR_MEMBER_VALUE.test(unquoted)
  );
}

/**
 * Hide the value of a secret-named setting written on one line, such as
 * `OTP: 731905`, `PIN=4821`, `"cvv": "123"` or `Seed phrase: <words>`.
 * Setting-shaped and quoted names hide the rest of the line, and `=` hides one
 * token. A plain prose word such as `Password:` counts only at the start of a
 * line or list item, and hides a lone value, a value with a digit, or a whole
 * recovery phrase. A short all-caps word such as `OTP` or `CVV` counts
 * anywhere, but reads as prose when several words without a digit follow
 * (`OTP: sent by SMS`). A seed hides only a recovery phrase or a long opaque
 * token, never a number, and weak names such as `signature` keep a short
 * identifier like `"sha256"`. References (`$VAR`, `process.env.X`, a call),
 * paths, booleans and placeholders stay readable, and so do labels without a
 * secret name, like `NOTE:` or `Design tokens:`.
 */
export function redactSecretNamedSameLineValues(value: string): string {
  if (!value.includes(":") && !value.includes("=")) return value;
  let cursor = 0;
  let redacted = "";
  for (const match of value.matchAll(SAME_LINE_NAMED_VALUE)) {
    const offset = (match.index ?? 0) + match[1]!.length;
    if (offset < cursor) continue;
    const quoted = match[3]!.length > 0;
    const name = match[4]!;
    const twoWordStart = quoted ? undefined : twoWordSecretNameStart(value, offset, name);
    if (twoWordStart === undefined && !blockNameHasSecretHint(name)) continue;
    const nameStart = twoWordStart ?? offset;
    const firstWord = twoWordStart === undefined ? "" : value.slice(twoWordStart, offset).trim().toLowerCase();
    const normalized = name.toLowerCase().replace(/[_-]/gu, "");
    // `PIN code` and `PIN number` count anywhere, like `PIN`.
    const shortCaps = !quoted && (twoWordStart === undefined ? /^[A-Z]{2,4}$/u.test(name) : firstWord === "pin");
    const settingShaped = !shortCaps && twoWordStart === undefined && (quoted || blockNameIsSettingShaped(name));
    const equals = match[2]!.trimEnd().endsWith("=");
    const valueStart = offset + match[2]!.length;
    const quotedValue = /["'`]/u.test(value[valueStart] ?? "");
    let lineEnd = valueStart;
    while (lineEnd < value.length && !/[\r\n\u2028\u2029]/u.test(value[lineEnd]!)) lineEnd += 1;
    const line = value.slice(0, lineEnd);
    const rest = line.slice(valueStart).trim();
    const phrase = isRecoveryPhrase(rest);
    // A whole recovery phrase under a secret name is never prose, so it hides
    // after a leading word too (`Secret recovery phrase:`, `My seed phrase:`).
    if (!settingShaped && !shortCaps && !equals && !phrase &&
      !PLAIN_NAME_PREFIX.test(value.slice(Math.max(0, nameStart - 64), nameStart))) continue;
    // Code such as `const pin = readPin()` stays; a quoted literal still hides.
    if (!quotedValue && sourceCodeAssignmentContext(value, offset)) continue;
    // A token count such as `max_tokens: 4096` is a number, not a credential.
    if (TOKEN_COUNT_NAME.test(normalized) && PLAIN_INTEGER.test(rest.replace(/^["'`]|["'`]$/gu, "").split(/\s/u)[0]!.replace(/["'`]/gu, ""))) continue;
    // A list of recovery or backup codes hides as a whole once one has a digit.
    const codeList = (firstWord === "recovery" || firstWord === "backup") && /^codes?$/iu.test(name) &&
      /\d/u.test(rest.split(/\s/u)[0]!);
    const valueEnd = secretValueEnd(line, valueStart, (settingShaped && !equals) || phrase || codeList);
    const secret = value.slice(valueStart, valueEnd);
    if (valueEnd <= valueStart || secretValueIsShown(secret)) continue;
    const unquotedSecret = secret.trim().replace(/^["'`]|["'`]$/gu, "");
    if (!phrase && twoWordStart === undefined && WEAK_SECRET_NAME.test(normalized)) {
      // A seed is a secret only as a recovery phrase or a long opaque token.
      if (/seeds?$/u.test(normalized) && !/mnemonic|phrase/u.test(normalized) &&
        !OPAQUE_SEED_VALUE.test(unquotedSecret)) continue;
      if (PLAIN_WEAK_VALUE.has(unquotedSecret.toLowerCase().replace(/[-_]/gu, ""))) continue;
    }
    // After a prose word, a value followed by more words is a sentence, such
    // as `Token: the parser emits it`, unless the word carries a digit.
    if (!settingShaped && !equals && !phrase && !codeList && !quotedValue &&
      secret.trim() !== rest && !/\d/u.test(secret)) continue;
    redacted += `${value.slice(cursor, valueStart)}[REDACTED]`;
    cursor = valueEnd;
  }
  return cursor === 0 ? value : `${redacted}${value.slice(cursor)}`;
}

const NEXT_LINE_BLOCK_ASSIGNMENT =
  /((?<![A-Za-z0-9_-])(?:\*{1,2}|_{1,2}|~~)?["'`]?([A-Za-z_][A-Za-z0-9_-]{0,63})["'`]?(?:\*{1,2}|_{1,2}|~~)?[ \t]*:[ \t]*)(?=\r?\n[ \t]+[^\s])/gu;

/** A name followed by `:` or `=`, where a phrase or code list may start. */
const PHRASE_OR_CODE_LABEL =
  /((?<![A-Za-z0-9_-])(?:\*{1,2}|_{1,2}|~~)?["'`]?([A-Za-z_][A-Za-z0-9_-]{0,63})["'`]?(?:\*{1,2}|_{1,2}|~~)?[ \t]*[:=][ \t]*)/gu;
const PHRASE_NAME =
  /(?:^(?:seed|mnemonic)s?|(?:seed|recovery|secret|backup|wallet|mnemonic)phrases?|(?:seed|recovery|mnemonic)words)$/u;
const CODE_NAME = /(?:recovery|backup)codes?$/u;
/** One recovery or backup code, such as `1234-5678` or `ab12cd34`. */
const RECOVERY_CODE = /^(?=[^\s]*\d)[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})*[,;]?$/u;

/** Whether a name owns a recovery phrase or a list of recovery codes. */
function phraseOrCodeName(value: string, nameOffset: number, name: string): "phrase" | "code" | undefined {
  const twoWordStart = twoWordSecretNameStart(value, nameOffset, name);
  if (twoWordStart !== undefined) {
    const first = value.slice(twoWordStart, nameOffset).trim().toLowerCase();
    if (/^(?:phrases?|words)$/iu.test(name)) return "phrase";
    return first === "recovery" || first === "backup" ? "code" : undefined;
  }
  const normalized = name.toLowerCase().replace(/[_-]/gu, "");
  if (PHRASE_NAME.test(normalized)) return "phrase";
  return CODE_NAME.test(normalized) ? "code" : undefined;
}

/** A line of words, possibly numbered, that may be part of a recovery phrase. */
function isPhraseWordLine(line: string): boolean {
  const words = recoveryPhraseWords(line);
  return words.length > 0 && words.every((word) => /^[A-Za-z]{2,12}$/u.test(word));
}

/** A line of recovery codes, possibly numbered. */
function isCodeLine(line: string): boolean {
  const codes = line.trim().split(/\s+/u).filter((token) => !RECOVERY_CODE_NUMBERING.test(token));
  return codes.length > 0 && codes.every((code) => RECOVERY_CODE.test(code));
}
const RECOVERY_CODE_NUMBERING = /^\d{1,2}[.)]$/u;
const STANDARD_PHRASE_LENGTHS: ReadonlySet<number> = new Set([12, 15, 18, 21, 24]);

/**
 * A recovery phrase or code list under its name that runs on over unindented
 * lines: one numbered word per line, a phrase split over two lines, or half
 * of it on the name's line and the rest below. The lines that belong to it
 * are hidden; a blank line or a line of other text ends it.
 */
function redactUnindentedPhraseBlocks(value: string): string {
  let cursor = 0;
  let redacted = "";
  for (const match of value.matchAll(PHRASE_OR_CODE_LABEL)) {
    const offset = match.index;
    if (offset === undefined || offset < cursor) continue;
    const name = match[2]!;
    const kind = phraseOrCodeName(value, offset + match[0].indexOf(name), name);
    if (!kind) continue;
    const valueStart = offset + match[0].length;
    const lineTest = kind === "phrase" ? isPhraseWordLine : isCodeLine;
    let lineEnd = valueStart;
    while (lineEnd < value.length && value[lineEnd] !== "\r" && value[lineEnd] !== "\n") lineEnd += 1;
    const sameLine = value.slice(valueStart, lineEnd);
    if (sameLine.trim() && !lineTest(sameLine)) continue;
    const parts = sameLine.trim() ? [sameLine] : [];
    const ends: number[] = sameLine.trim() ? [lineEnd] : [];
    let next = lineEnd;
    while (value[next] === "\r" || value[next] === "\n") {
      let start = next + 1;
      if (value[next] === "\r" && value[start] === "\n") start += 1;
      let end = start;
      while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end += 1;
      const line = value.slice(start, end);
      if (!line.trim() || !lineTest(line)) break;
      parts.push(line);
      ends.push(end);
      next = end;
    }
    // The name's own line is left to the one-line rules.
    if (ends.length === 0 || ends[ends.length - 1] === lineEnd) continue;
    let valueEnd: number | undefined;
    if (kind === "code") {
      valueEnd = ends[ends.length - 1];
    } else {
      // The longest run of lines that reads as one phrase of a standard
      // length (12, 15, 18, 21 or 24 words), so a lowercase line of prose
      // after the phrase stays shown; failing that, the longest phrase.
      let longest: number | undefined;
      for (let count = parts.length; count > 0 && valueEnd === undefined; count -= 1) {
        const run = parts.slice(0, count).join(" ");
        if (!isRecoveryPhrase(run)) continue;
        longest ??= ends[count - 1];
        if (STANDARD_PHRASE_LENGTHS.has(recoveryPhraseWords(run).length)) valueEnd = ends[count - 1];
      }
      valueEnd ??= longest;
    }
    if (valueEnd === undefined || valueEnd <= lineEnd) continue;
    if (sameLine.trim()) {
      redacted += `${value.slice(cursor, valueStart)}[REDACTED]`;
    } else {
      const breakEnd = value[lineEnd] === "\r" && value[lineEnd + 1] === "\n" ? lineEnd + 2 : lineEnd + 1;
      redacted += `${value.slice(cursor, breakEnd)}[REDACTED]`;
    }
    cursor = valueEnd;
  }
  return cursor === 0 ? value : `${redacted}${value.slice(cursor)}`;
}

/**
 * A secret-named setting whose value is an indented block on the following
 * lines, such as `PASSWORD:` or `PASSPHRASE:`, hides every line of that block,
 * not just the first. A recovery phrase or code list under its name also
 * hides when its lines are not indented.
 */
export function redactSensitiveNextLineBlocks(text: string): string {
  if (!text.includes(":") && !text.includes("=")) return text;
  const value = redactUnindentedPhraseBlocks(text);
  if (!value.includes(":")) return value;
  let cursor = 0;
  let redacted = "";
  for (const match of value.matchAll(NEXT_LINE_BLOCK_ASSIGNMENT)) {
    const offset = match.index;
    if (offset === undefined || offset < cursor) continue;
    const name = match[2]!;
    const nameOffset = offset + match[0].indexOf(name);
    if (!blockNameHasSecretHint(name) && twoWordSecretNameStart(value, nameOffset, name) === undefined) continue;
    const blockStart = offset + match[0].length;
    const valueEnd = indentedEnvironmentValueEnd(value, blockStart);
    if (valueEnd <= blockStart) continue;
    const lineBreak = value[blockStart] === "\r" && value[blockStart + 1] === "\n" ? "\r\n" : value[blockStart]!;
    let indentEnd = blockStart + lineBreak.length;
    while (value[indentEnd] === " " || value[indentEnd] === "\t") indentEnd += 1;
    redacted += `${value.slice(cursor, blockStart)}${value.slice(blockStart, indentEnd)}[REDACTED]`;
    cursor = valueEnd;
  }
  return cursor === 0 ? value : `${redacted}${value.slice(cursor)}`;
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
    if (
      !isTightEqualsAssignment &&
      blockValueStartsOnNextLine(value, valueStart) &&
      colonBlockNameIsLabel(name) &&
      !labelBlockLooksLikeCredential(value.slice(valueStart, valueEnd))
    ) {
      continue;
    }
    redacted += `${value.slice(cursor, offset)}${match[0]}[REDACTED ENVIRONMENT VALUE]`;
    cursor = valueEnd;
    changed = true;
  }
  return changed ? `${redacted}${value.slice(cursor)}` : value;
}

/**
 * A line that ends in a hidden value, which may wrap onto the next line. Only
 * markers that stand for a value count: a hidden path, Markdown block or
 * unsettled text is not a secret, so the line after it stays readable.
 */
const ENDS_IN_HIDDEN_VALUE =
  /\[REDACTED(?: CREDENTIAL| MCP CREDENTIAL| ENVIRONMENT VALUE| PRIVATE KEY| TOKEN| AUTHORIZATION)?\]["'`]?[,;]?$/u;
/**
 * One opaque token of credential characters, such as the wrapped tail of a
 * key: eight or more with a letter and a digit, or sixteen or more with at
 * least two capitals and no digit, like `FAKEFAKEFAKEFAKE`.
 */
const OPAQUE_CONTINUATION_TOKEN =
  /^(?:(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9+/=._~-]{8,}|(?=(?:[^A-Z\s]*[A-Z]){2})[A-Za-z0-9+/=._~-]{16,})["'`]?[,;]?$/u;
/** A file path such as `src/config/env.ts` or a file name such as `README.md`. */
const PATH_SHAPED_LINE =
  /^(?:~|\.{1,2})?\/?(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]*[A-Za-z_-]\.[a-z][a-z0-9]{0,7}[,;:.]?$/u;
const FILE_NAME_LINE = /^[A-Za-z][A-Za-z_-]*\.[A-Za-z][A-Za-z0-9]{0,7}[,;:.]?$/u;
/** A version such as `v2.3.1` or `1.4.0-beta.2`. */
const VERSION_LINE = /^v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?[,;:.]?$/u;

/** Whether a line is a file path, file name or version on its own. */
export function lineIsPathOrVersion(line: string): boolean {
  const trimmed = line.trim();
  if (VERSION_LINE.test(trimmed)) return true;
  if (!trimmed.includes("/")) return FILE_NAME_LINE.test(trimmed);
  return PATH_SHAPED_LINE.test(trimmed) && !/\/\//u.test(trimmed);
}

/**
 * Whether `line` reads as the wrapped rest of a value that was hidden on the
 * line before it, such as the second half of a key or token. Its first word is
 * an opaque token; a path, file name or version is not one.
 */
export function isWrappedSecretTail(previousSafeLine: string | undefined, line: string): boolean {
  if (previousSafeLine === undefined || !ENDS_IN_HIDDEN_VALUE.test(previousSafeLine)) return false;
  const trimmed = line.trim();
  if (!trimmed || lineIsPathOrVersion(trimmed)) return false;
  return OPAQUE_CONTINUATION_TOKEN.test(trimmed.split(/\s+/u)[0]!);
}

/**
 * Hide the wrapped rest of a value hidden on the line above, and the line
 * after that while it is still part of it, in already-filtered text.
 */
function redactWrappedSecretTails(value: string): string {
  if (!value.includes("[REDACTED")) return value;
  const lines = value.split("\n");
  let changed = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const carriage = line.endsWith("\r") ? "\r" : "";
    if (!isWrappedSecretTail(lines[index - 1]!.replace(/\r$/u, ""), line)) continue;
    lines[index] = `[REDACTED]${carriage}`;
    changed = true;
  }
  return changed ? lines.join("\n") : value;
}

function sanitizeVariant(value: string, includeEnvironment: boolean): string {
  // Subagent text only: the shared credential filter, which main-chat
  // compaction also uses, leaves prose blocks alone.
  const blockSafe = redactSensitiveNextLineBlocks(value);
  // Renderer snapshots also hide a secret-named value written on one line,
  // such as `Passcode: 482913`, as the saved helper conversation does.
  const environmentSafe = includeEnvironment
    ? redactSecretNamedSameLineValues(
      redactEnvironmentAssignments(blockSafe).replace(/(\[REDACTED ENVIRONMENT VALUE\])\]+/gu, "$1"),
    )
    : blockSafe;
  const pathSafe = sanitizePaths(sanitizePaths(environmentSafe));
  return includeEnvironment ? redactWrappedSecretTails(pathSafe) : pathSafe;
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

function hasPairedUnderscores(value: string): boolean {
  const first = value.indexOf("_");
  return first !== -1 && value.indexOf("_", first + 1) !== -1;
}

/**
 * Single-line plain strings without Markdown punctuation, paired underscores,
 * list/break prefixes, edge whitespace, GFM autolink triggers, or REDACTED
 * placeholders parse to a single literal text node with no metadata or stripped
 * placeholders, so their rendered text equals the input already checked by
 * `nonMarkdownPolicyIsUnsafe`.
 */
function mayRequireRendererMarkdownCheck(value: string): boolean {
  if (value.length === 0) return false;
  return (
    MARKDOWN_LINE_BREAK_TRIGGER.test(value) ||
    MARKDOWN_EDGE_WHITESPACE_TRIGGER.test(value) ||
    MARKDOWN_SYNTAX_TRIGGER.test(value) ||
    hasPairedUnderscores(value) ||
    MARKDOWN_BLOCK_PREFIX_TRIGGER.test(value) ||
    value.includes("@") ||
    value.includes("://") ||
    GFM_WWW_AUTOLINK_TRIGGER.test(value) ||
    REDACTED_MARKER_TRIGGER.test(value)
  );
}

function rendererMarkdownIsUnsafe(value: string): boolean {
  if (!mayRequireRendererMarkdownCheck(value)) return false;
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
  if (candidate.length < 17 || !WRAPPED_ENCODING_WHITESPACE.test(candidate)) {
    return { exhausted: false, values: [] };
  }
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
        // Whitespace-separated prose routinely looks like a Base32 payload
        // after its spaces are removed (for example, "and report back").
        // Require the minimum payload size plus an encoding marker before
        // exploring a candidate. Newline-wrapped and framed encodings still
        // pass this gate, while ordinary word sequences remain prose.
        if (compact.length < 16 || !/[0-9+=]/u.test(compact)) continue;
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
  const escapeLayer = candidate.includes("\\") ? decodeJavaScriptEscapeLayer(candidate) : undefined;
  const payloads: Array<string | undefined> = [escapeLayer?.value];
  if (candidate.length >= 8) {
    for (const [token] of candidate.matchAll(BASE64_TOKEN)) {
      payloads.push(decodeBase64Token(token));
    }
  }
  if (candidate.length >= 16) {
    for (const [token] of candidate.matchAll(HEX_TOKEN)) {
      payloads.push(decodeHexToken(token));
    }
    for (const [token] of candidate.matchAll(BASE32_TOKEN)) {
      payloads.push(decodeBase32Token(token, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"));
    }
    for (const [token] of candidate.matchAll(BASE32HEX_TOKEN)) {
      payloads.push(decodeBase32Token(token, "0123456789ABCDEFGHIJKLMNOPQRSTUV"));
    }
  }
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
  if (candidate.includes("%") && WRAPPED_ENCODING_WHITESPACE.test(candidate)) {
    for (const [token] of candidate.matchAll(WHITESPACE_SEPARATED_PERCENT)) {
      const decoded = decodePercentLayers(token.replace(/[ \t\r\n]+/gu, ""));
      exhausted ||= decoded.exhausted;
      if (decoded.value !== token) payloads.push(decoded.value);
    }
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

export interface SubagentTextSanitization {
  text: string;
  /** True only when the privacy policy generated a replacement. */
  privacyReplacement: boolean;
}

/** Passes of the plain filter before its output must be stable. */
const MAX_SANITIZE_PASSES = 3;

/**
 * Re-run the plain filter until its output stops changing, so one redaction
 * that exposes another (for example a credential assignment that now owns an
 * environment placeholder) settles instead of hiding the whole text.
 */
function settledSanitizeVariant(value: string, includeEnvironment: boolean): string {
  let safe = sanitizeVariant(value, includeEnvironment);
  for (let pass = 1; pass < MAX_SANITIZE_PASSES; pass += 1) {
    const next = sanitizeVariant(safe, includeEnvironment);
    if (next === safe) break;
    safe = next;
  }
  return safe;
}

function sanitizeWithPolicyFacts(
  value: string,
  includeEnvironment: boolean,
): SubagentTextSanitization {
  const { compact, hadControls, spaced } = controlVariants(value);
  const safe = settledSanitizeVariant(spaced, includeEnvironment);
  const directReplacement = safe !== spaced;
  if (nonMarkdownPolicyIsUnsafe(safe, includeEnvironment)) {
    // The encoded-text marker is for credentials hidden by an encoding or a
    // look-alike key. Plain text whose filter output never settles gets the
    // generic marker instead, but only when nothing in it is still encoded:
    // if renormalizing or percent-decoding changes it, an encoding is why.
    const settled = controlVariants(safe);
    const stillEncoded =
      settled.spaced !== safe ||
      ENCODING_ESCAPE.test(safe) ||
      decodePercentLayers(safe).value !== safe;
    const unsettledPlainText =
      !stillEncoded &&
      !containsObfuscatedAssignmentKey(settled.spaced) &&
      sanitizeVariant(settled.spaced, includeEnvironment) !== settled.spaced;
    return {
      text: unsettledPlainText ? UNSETTLED_TEXT_REDACTION : ENCODED_TEXT_REDACTION,
      privacyReplacement: true,
    };
  }
  if (hadControls) {
    const compactSafe = sanitizeVariant(compact, includeEnvironment);
    if (compactSafe !== compact || nonMarkdownPolicyIsUnsafe(compactSafe, includeEnvironment)) {
      return { text: CONTROL_SPLIT_REDACTION, privacyReplacement: true };
    }
    if (includeEnvironment && rendererMarkdownIsUnsafe(compactSafe)) {
      return { text: MARKDOWN_CONTENT_REDACTION, privacyReplacement: true };
    }
  }
  if (includeEnvironment && rendererMarkdownIsUnsafe(safe)) {
    return { text: MARKDOWN_CONTENT_REDACTION, privacyReplacement: true };
  }
  return { text: safe, privacyReplacement: directReplacement };
}

function sanitizeWithPolicy(value: string, includeEnvironment: boolean): string {
  return sanitizeWithPolicyFacts(value, includeEnvironment).text;
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

/**
 * Project renderer-safe snapshot text while reporting producer-owned privacy
 * provenance. Literal redaction-marker prose does not set the replacement fact.
 */
export function sanitizeSubagentSnapshotTextWithFacts(value: string): SubagentTextSanitization {
  return sanitizeWithPolicyFacts(value, true);
}

const LABEL_LINE_BREAK = /(?<![A-Za-z0-9_])([A-Z]{2,64}):[ \t]*(?:\r\n?|\n)[ \t]*/gu;

/**
 * Collapse text onto one line for single-line previews. A bare all-caps label
 * that ends its line, such as `JSON:` or `TASK:`, is joined to what follows
 * with a dash instead of `: `. On one line, `JSON: value` reads as a setting
 * and would be hidden, although the multi-line text treats it as a label.
 */
export function collapseSubagentTextToSingleLine(value: string): string {
  return value
    .replace(LABEL_LINE_BREAK, (whole, name: string) =>
      colonBlockNameIsLabel(name) ? `${name} — ` : whole,
    )
    .replace(/\s+/gu, " ");
}
