//! Port of `renderer/shared/subagent-safe-text.ts` — the bounded credential
//! and absolute-path sanitizer applied at trust boundaries.
//!
//! The TypeScript implementation relies on Node packages (`entities`,
//! `mdast-util-to-string`, `remark-*`, `unified`) and a large set of `RegExp`
//! literals. `aiden-core` must stay free of non-serde dependencies, so this is
//! a hand-rolled port of the same grammar that is deliberately
//! fail-closed (it over-redacts rather than risking a leak). Notably:
//! - HTML entities are detected but not decoded: any `&…;` candidate redacts
//!   the whole field with `[REDACTED ENCODED TEXT]` (the TS decodes first and
//!   only redacts when a candidate survives; without a decoder the
//!   conservative branch is always taken).
//! - Full NFKC normalization and the remark-based markdown AST checks are
//!   approximated: control-variant scanning, credential/path/environment
//!   redaction, and bounded base64/hex/base32/percent/JS-escape re-checks are
//!   all ported.

// ===========================================================================
// Control characters
// ===========================================================================

fn is_non_line_control(ch: char) -> bool {
    let code = ch as u32;
    (code <= 9)
        || code == 11
        || code == 12
        || (14..=31).contains(&code)
        || (127..=159).contains(&code)
}

fn is_control(ch: char) -> bool {
    let code = ch as u32;
    code <= 31 || (127..=159).contains(&code) || code == 0x2028 || code == 0x2029
}

fn replace_non_line_controls(value: &str, replacement: char) -> String {
    value
        .chars()
        .map(|ch| {
            if is_non_line_control(ch) {
                replacement
            } else {
                ch
            }
        })
        .collect()
}

/// Approximate `\p{Default_Ignorable_Code_Point}`.
fn is_default_ignorable(ch: char) -> bool {
    let code = ch as u32;
    code == 0x00ad
        || code == 0x034f
        || code == 0x061c
        || (0x115f..=0x1160).contains(&code)
        || (0x17b4..=0x17b5).contains(&code)
        || (0x180b..=0x180f).contains(&code)
        || (0x200b..=0x200f).contains(&code)
        || (0x202a..=0x202e).contains(&code)
        || (0x2060..=0x206f).contains(&code)
        || code == 0x3164
        || (0xfe00..=0xfe0f).contains(&code)
        || code == 0xfeff
        || (0xffa0..=0xffa0).contains(&code)
        || (0xfff0..=0xfff8).contains(&code)
        || (0x1bca0..=0x1bca3).contains(&code)
        || (0x1d173..=0x1d17a).contains(&code)
        || (0xe0000..=0xe0fff).contains(&code)
        || (0xfdd0..=0xfdef).contains(&code)
        || code & 0xfffe == 0xfffe
}

// ===========================================================================
// Sensitive syntax normalization
// ===========================================================================

const ENCODED_TEXT_REDACTION: &str = "[REDACTED ENCODED TEXT]";
const CONTROL_SPLIT_REDACTION: &str = "[REDACTED CONTROL-SPLIT TEXT]";

/// `&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);` — a candidate entity.
fn has_html_entity_candidate(value: &str) -> bool {
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '&' {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        let mut digits = 0;
        let mut _hex = false;
        if cursor < chars.len() && chars[cursor] == '#' {
            cursor += 1;
            if cursor < chars.len() && (chars[cursor] == 'x' || chars[cursor] == 'X') {
                _hex = true;
                cursor += 1;
            }
            while cursor < chars.len() && chars[cursor].is_ascii_hexdigit() {
                cursor += 1;
                digits += 1;
            }
            if digits > 0 && cursor < chars.len() && chars[cursor] == ';' {
                return true;
            }
        } else {
            let start = cursor;
            while cursor < chars.len()
                && (chars[cursor].is_ascii_lowercase() || chars[cursor].is_ascii_digit())
                && cursor - start < 32
            {
                cursor += 1;
            }
            if cursor > start
                && chars[start].is_ascii_lowercase()
                && cursor < chars.len()
                && chars[cursor] == ';'
            {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// `%([0-9a-f]{2})` with `i` — decode when the result is a safe character.
fn percent_escape_replacement(chars: &[char], index: usize) -> Option<char> {
    if chars[index] != '%' || index + 2 >= chars.len() {
        return None;
    }
    let hex: String = chars[index + 1..index + 3].iter().collect();
    if !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    let decoded = u32::from_str_radix(&hex, 16).ok()?;
    let decoded_char = char::from_u32(decoded)?;
    if decoded_char.is_ascii_alphanumeric() || matches!(decoded_char, '_' | ':' | '=' | '-') {
        Some(decoded_char)
    } else {
        None
    }
}

fn is_markdown_escapable_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '!' | '"'
            | '#'
            | '$'
            | '%'
            | '&'
            | '\''
            | '('
            | ')'
            | '*'
            | '+'
            | ','
            | '-'
            | '.'
            | '/'
            | ':'
            | ';'
            | '<'
            | '='
            | '>'
            | '?'
            | '@'
            | '['
            | ']'
            | '^'
            | '_'
            | '`'
            | '{'
            | '|'
            | '}'
            | '~'
    )
}

/// CommonMark consumes ASCII punctuation escapes before users see the text, so
/// the privacy projection must too. Doubled backslashes are preserved so UNC
/// paths still reach the dedicated absolute-path detector.
fn normalize_markdown_escapes(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut normalized = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == '\\'
            && index + 1 < chars.len()
            && chars[index + 1] != '\\'
            && is_markdown_escapable_punctuation(chars[index + 1])
        {
            normalized.push(chars[index + 1]);
            index += 2;
        } else {
            normalized.push(ch);
            index += 1;
        }
    }
    normalized
}

fn has_internal_security_markup(value: &str) -> Option<(usize, usize)> {
    // `(?<=[A-Za-z0-9_])(?:\*{1,2}|__|~~|`{1,3})(?=[A-Za-z0-9_=:])`
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let prev_ok =
            index > 0 && (chars[index - 1].is_ascii_alphanumeric() || chars[index - 1] == '_');
        if !prev_ok {
            index += 1;
            continue;
        }
        let markup_len = match ch {
            '*' | '_' | '~' => {
                let mut count = 0;
                while index + count < chars.len() && chars[index + count] == ch && count < 2 {
                    count += 1;
                }
                if (ch == '*' || ch == '~') && count > 0 && count <= 2 {
                    count
                } else if ch == '_' && count == 2 {
                    2
                } else {
                    0
                }
            }
            '`' => {
                let mut count = 0;
                while index + count < chars.len() && chars[index + count] == '`' && count < 3 {
                    count += 1;
                }
                if count > 0 && count <= 3 {
                    count
                } else {
                    0
                }
            }
            _ => 0,
        };
        if markup_len > 0 {
            let next = index + markup_len;
            if next < chars.len()
                && (chars[next].is_ascii_alphanumeric() || matches!(chars[next], '_' | '=' | ':'))
            {
                return Some((index, next));
            }
        }
        index += 1;
    }
    None
}

fn normalize_sensitive_syntax(value: &str) -> (bool, String) {
    let had_encoded_control = false;
    // The TS decodes HTML entities up to 64 times. Without a decoder any
    // surviving candidate redacts the whole field (fail-closed).
    if has_html_entity_candidate(value) {
        return (true, ENCODED_TEXT_REDACTION.to_string());
    }
    let mut normalized: String = value
        .chars()
        .filter(|ch| !is_default_ignorable(*ch))
        .collect();
    let chars: Vec<char> = normalized.chars().collect();
    let mut decoded = String::with_capacity(normalized.len());
    let mut index = 0;
    while index < chars.len() {
        match percent_escape_replacement(&chars, index) {
            Some(replacement) => {
                decoded.push(replacement);
                index += 3;
            }
            None => {
                decoded.push(chars[index]);
                index += 1;
            }
        }
    }
    normalized = normalize_markdown_escapes(&decoded);
    while let Some((start, end)) = has_internal_security_markup(&normalized) {
        let mut result = String::with_capacity(normalized.len());
        result.push_str(&normalized[..start]);
        result.push_str(&normalized[end..]);
        normalized = result;
    }
    (had_encoded_control, normalized)
}

struct ControlVariants {
    compact: String,
    had_controls: bool,
    spaced: String,
}

fn control_variants(value: &str) -> ControlVariants {
    let (had_encoded_control, normalized) = normalize_sensitive_syntax(value);
    let normalized_lines: String = normalized
        .replace("\r\n", "\n")
        .replace(['\r', '\u{2028}', '\u{2029}'], "\n");
    let has_non_line_controls = normalized_lines.chars().any(is_non_line_control);
    let had_controls = has_non_line_controls || had_encoded_control;
    let spaced = replace_non_line_controls(&normalized_lines, ' ');
    let mut compact = if has_non_line_controls {
        replace_non_line_controls(&normalized_lines, '\u{0}')
    } else {
        normalized_lines.clone()
    };
    if had_encoded_control {
        compact = compact.replace(['\r', '\n', '\u{2028}', '\u{2029}'], "");
    }
    ControlVariants {
        compact,
        had_controls,
        spaced,
    }
}

// ===========================================================================
// Sensitive field grammar
// ===========================================================================

fn is_key_separator(ch: char) -> bool {
    ch == '.'
        || ch == '\t'
        || ch == '-'
        || ch == '_'
        || ch.is_whitespace()
        || matches!(ch, '\u{2010}'..='\u{2015}' | '\u{b7}' | '\u{2022}' | '\u{2219}' | '\u{203f}' | '\u{2040}' | '\u{2054}' | '\u{fe33}' | '\u{fe34}' | '\u{fe4d}'..='\u{fe4f}' | '\u{ff0d}' | '\u{ff3f}' | '\u{fe58}' | '\u{fe63}')
}

fn sensitive_name_matches(lower: &[char], index: usize, name: &str) -> Option<usize> {
    let name_chars: Vec<char> = name.chars().collect();
    let mut cursor = index;
    let mut word_index = 0;
    loop {
        let mut word_len = 0;
        while word_index + word_len < name_chars.len() && name_chars[word_index + word_len] != ' ' {
            word_len += 1;
        }
        if cursor + word_len > lower.len()
            || lower[cursor..cursor + word_len] != name_chars[word_index..word_index + word_len]
        {
            return None;
        }
        cursor += word_len;
        word_index += word_len;
        if word_index >= name_chars.len() {
            return Some(cursor);
        }
        word_index += 1; // skip the space between words
                         // Optional separator group (1-4 separator chars) between words.
        let mut sep_len = 0;
        while cursor < lower.len() && sep_len < 4 && is_key_separator(lower[cursor]) {
            cursor += 1;
            sep_len += 1;
        }
    }
}

const SENSITIVE_FIELD_NAMES: &[&str] = &[
    "auth token",
    "access token",
    "api key",
    "authorization token",
    "authorization",
    "aws access key id",
    "aws secret access key",
    "aws session token",
    "client secret",
    "connection string",
    "cookie",
    "credential",
    "credentials",
    "database url",
    "db url",
    "encryption key",
    "github token",
    "id token",
    "passwd",
    "password",
    "private token",
    "pwd",
    "refresh token",
    "secret key",
    "secret token",
    "secret",
    "session id",
    "session",
    "set cookie",
    "signing key",
    "token",
];

/// Parse a sensitive field (with optional namespace prefix) starting at
/// `index`. Returns the char position just after the field. Names are tried
/// at every segment boundary so `aws_secret_access_key` and `apiKey` both
/// resolve.
fn parse_sensitive_field(lower: &[char], index: usize) -> Option<usize> {
    let mut cursor = index;
    let mut segments = 0;
    loop {
        for name in SENSITIVE_FIELD_NAMES {
            if let Some(end) = sensitive_name_matches(lower, cursor, name) {
                return Some(end);
            }
        }
        if segments >= 8 {
            return None;
        }
        let mut segment_len = 0;
        while cursor < lower.len() && segment_len < 32 && lower[cursor].is_ascii_alphanumeric() {
            cursor += 1;
            segment_len += 1;
        }
        if segment_len == 0 || cursor >= lower.len() {
            return None;
        }
        if !is_key_separator(lower[cursor]) {
            return None;
        }
        let mut sep_len = 0;
        while cursor < lower.len() && sep_len < 4 && is_key_separator(lower[cursor]) {
            cursor += 1;
            sep_len += 1;
        }
        segments += 1;
    }
}

fn skip_emphasis_and_quote(lower: &[char], mut index: usize) -> (usize, bool, bool) {
    // (new_index, had_emphasis, had_quote)
    let mut had_emphasis = false;
    let mut had_quote = false;
    loop {
        if index < lower.len() && matches!(lower[index], '*' | '_' | '~') {
            had_emphasis = true;
            index += 1;
            continue;
        }
        if index < lower.len() && matches!(lower[index], '\'' | '"' | '`') {
            had_quote = true;
            index += 1;
            continue;
        }
        break;
    }
    (index, had_emphasis, had_quote)
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '$')
}

fn is_credential_assignment_reference(field: &str, value: &str) -> bool {
    let value = value.trim().trim_end_matches([';', ',', '}', ']']).trim();
    let lower_value = value.to_ascii_lowercase();
    // Environment accessors.
    let env_accessor = {
        let after = |prefix: &str| {
            let Some(rest) = lower_value.strip_prefix(prefix) else {
                return false;
            };
            if let Some(rest) = rest.strip_prefix('.') {
                let mut chars = rest.chars();
                let first = chars
                    .next()
                    .map(|ch| ch == '_' || ch.is_ascii_alphabetic())
                    .unwrap_or(false);
                first && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
            } else if let Some(rest) = rest.strip_prefix('[') {
                !rest.is_empty()
                    && rest
                        .chars()
                        .take_while(|ch| *ch != ']' && *ch != '\r' && *ch != '\n')
                        .count()
                        > 0
                    && rest.ends_with(']')
            } else {
                false
            }
        };
        lower_value.starts_with("process.env")
            && (after("process.env") || lower_value == "process.env")
            || lower_value.starts_with("import.meta.env") && after("import.meta.env")
            || lower_value.starts_with("deno.env.get(")
                && lower_value.ends_with(')')
                && !lower_value.contains('\n')
            || lower_value.starts_with("os.environ")
                && (after("os.environ") || lower_value == "os.environ")
            || lower_value.starts_with("getenv(")
                && lower_value.ends_with(')')
                && !lower_value.contains('\n')
    };
    if env_accessor {
        return true;
    }
    // Session-id source-code identifiers.
    let lower_field = field.to_ascii_lowercase();
    let has_session_key = lower_field.contains("session");
    if has_session_key {
        let session_reference = {
            let call_like = {
                let trimmed = lower_value.trim_start();
                let after_await = trimmed
                    .strip_prefix("await ")
                    .map(str::trim_start)
                    .unwrap_or(trimmed)
                    .strip_prefix("new ")
                    .map(str::trim_start)
                    .unwrap_or(trimmed);
                let open = after_await.find('(');
                match open {
                    Some(open) => {
                        let name = &after_await[..open];
                        let name_valid = !name.is_empty()
                            && name
                                .chars()
                                .all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
                            && !name.chars().next().unwrap().is_ascii_digit();
                        let close = after_await.rfind(')');
                        name_valid
                            && close == Some(after_await.len() - 1)
                            && !after_await.contains('\'')
                            && !after_await.contains('"')
                            && !after_await.contains('`')
                            && !after_await.contains('\n')
                    }
                    None => false,
                }
            };
            let member_chain = {
                let trimmed = lower_value.trim();
                let mut rest = trimmed;
                let first = rest.chars().next();
                if first
                    .map(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphabetic())
                    .unwrap_or(false)
                {
                    rest = &rest[1..];
                    let mut valid = true;
                    let mut segments = 0;
                    loop {
                        if let Some(next) = rest.strip_prefix('.') {
                            rest = next;
                            segments += 1;
                            let mut count = 0;
                            while !rest.is_empty() {
                                let ch = rest.chars().next().unwrap();
                                if ch == '_' || ch == '$' || ch.is_ascii_alphanumeric() {
                                    rest = &rest[1..];
                                    count += 1;
                                } else {
                                    break;
                                }
                            }
                            if count == 0 {
                                valid = false;
                                break;
                            }
                        } else if let Some(next) = rest.strip_prefix('[') {
                            segments += 1;
                            let mut count = 0;
                            while !next.is_empty() {
                                let ch = next.chars().next().unwrap();
                                if ch == '_' || ch == '$' || ch.is_ascii_alphanumeric() {
                                    rest = &next[1..];
                                    count += 1;
                                } else if ch == ']' {
                                    rest = &next[1..];
                                    count = 0;
                                    break;
                                } else {
                                    valid = false;
                                    break;
                                }
                            }
                            if !valid || count != 0 {
                                valid = false;
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    valid && segments > 0 && rest.is_empty()
                } else {
                    false
                }
            };
            let session_identifier = {
                let trimmed = lower_value.trim();
                let prefixes = [
                    "active", "current", "new", "next", "previous", "stored", "user",
                ];
                prefixes.iter().any(|prefix| {
                    let Some(rest) = trimmed.strip_prefix(prefix) else {
                        return false;
                    };
                    let core = rest.trim_end_matches("id");
                    core.ends_with("session")
                })
            };
            let object_literal = {
                let trimmed = lower_value.trim();
                trimmed.starts_with('{')
                    && trimmed.ends_with('}')
                    && !trimmed.contains('\'')
                    && !trimmed.contains('"')
                    && !trimmed.contains('`')
                    && !trimmed.contains('\n')
            };
            call_like || member_chain || session_identifier || object_literal
        };
        if session_reference {
            return true;
        }
    }
    // authorization: role-based.
    if field.to_ascii_lowercase().contains("authorization") {
        let value = value.trim();
        if value.eq_ignore_ascii_case("role")
            || value.eq_ignore_ascii_case("role-based")
            || value.eq_ignore_ascii_case("role based")
        {
            return true;
        }
    }
    false
}

/// Redact `key: value` / `key = value` assignments that name a sensitive
/// field. Returns the sanitized text.
fn sanitize_credential_text(value: &str) -> String {
    let mut sanitized = value.to_string();
    let lower = value.to_ascii_lowercase();
    let has_assignment = value.contains('=') || value.contains(':');
    let has_hint = [
        "auth",
        "access",
        "api",
        "authorization",
        "aws",
        "client",
        "connection",
        "cookie",
        "credential",
        "database",
        "db",
        "encryption",
        "github",
        "passwd",
        "password",
        "private",
        "pwd",
        "refresh",
        "secret",
        "session",
        "signing",
        "token",
    ]
    .iter()
    .any(|hint| lower.contains(hint));
    if has_assignment && has_hint {
        sanitized = redact_assignments(&sanitized);
    }
    if has_standalone_credential_hint(&lower) {
        sanitized = redact_standalone(&sanitized);
    }
    sanitized = collapse_redaction_runs(&sanitized);
    sanitized
}

/// The `\b[a-z][a-z0-9+.-]*://[^/@\s]+@` + token-prefix hints that gate the
/// standalone redactions.
fn has_standalone_credential_hint(lower: &str) -> bool {
    lower.contains("-----begin")
        || lower.contains("putty-user-key-file")
        || lower.contains("ssh-rsa")
        || lower.contains("ssh-ed25519")
        || lower.contains("ecdsa-sha2-")
        || lower.contains("bearer ")
        || lower.contains("basic ")
        || lower.contains("://")
        || [
            "akia",
            "aiza",
            "sg.",
            "eyj",
            "ghp_",
            "gho_",
            "ghu_",
            "ghs_",
            "ghr_",
            "github_pat_",
            "glpat-",
            "hf_",
            "npm_",
            "pypi-",
            "sk-",
            "sk_live_",
            "sk_test_",
            "rk_live_",
            "rk_test_",
            "xoxb-",
            "xoxp-",
            "xoxa-",
            "xoxr-",
            "xoxs-",
            "ya29.",
        ]
        .iter()
        .any(|prefix| lower.contains(prefix))
}

fn redact_assignments(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let lower: Vec<char> = value.to_ascii_lowercase().chars().collect();
    let mut output: Vec<char> = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        // Lookbehind: not preceded by an identifier char.
        if index > 0 && is_identifier_char(chars[index - 1]) {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        // Try to parse a sensitive assignment here.
        let mut cursor = index;
        let (after_prefix, had_emphasis, had_quote) = skip_emphasis_and_quote(&lower, cursor);
        cursor = after_prefix;
        let field_start = cursor;
        let Some(field_end) = parse_sensitive_field(&lower, cursor) else {
            output.push(chars[index]);
            index += 1;
            continue;
        };
        let mut after_field = field_end;
        // Optional quote + emphasis after the field.
        let (after_suffix, had_quote_after, had_emphasis_after) =
            skip_emphasis_and_quote(&lower, after_field);
        after_field = after_suffix;
        let _ = (had_emphasis, had_quote, had_emphasis_after, had_quote_after);
        // Whitespace + delimiter.
        let mut cursor = after_field;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        if cursor >= chars.len() || !matches!(chars[cursor], '=' | ':') {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let delimiter = chars[cursor];
        cursor += 1;
        while cursor < chars.len() && chars[cursor].is_whitespace() {
            cursor += 1;
        }
        let field: String = lower[field_start..field_end].iter().collect();
        let field_is_connection = field.contains("connection")
            || field.contains("database url")
            || field.contains("db url");
        // Block scalar: `: >` / `: |` with an indented continuation block.
        let is_block_scalar =
            delimiter == ':' && cursor < chars.len() && matches!(chars[cursor], '>' | '|');
        if is_block_scalar {
            // `[>|][+-]?[1-9]?[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|(?=\r?\n|$)))+`
            let mut block_end = cursor;
            block_end += 1;
            if block_end < chars.len() && matches!(chars[block_end], '+' | '-') {
                block_end += 1;
            }
            if block_end < chars.len() && chars[block_end].is_ascii_digit() {
                block_end += 1;
            }
            while block_end < chars.len() && !matches!(chars[block_end], '\r' | '\n') {
                block_end += 1;
            }
            let mut saw_line = false;
            while block_end < chars.len() {
                if chars[block_end] == '\r' && chars.get(block_end + 1) == Some(&'\n') {
                    block_end += 2;
                } else if chars[block_end] == '\r' || chars[block_end] == '\n' {
                    block_end += 1;
                } else {
                    break;
                }
                let line_start = block_end;
                while block_end < chars.len()
                    && (chars[block_end] == ' ' || chars[block_end] == '\t')
                {
                    block_end += 1;
                }
                if block_end == line_start {
                    if !saw_line {
                        break;
                    }
                    continue;
                }
                saw_line = true;
                while block_end < chars.len() && !matches!(chars[block_end], '\r' | '\n') {
                    block_end += 1;
                }
            }
            if saw_line {
                output.extend("[REDACTED]".chars());
                index = block_end;
                continue;
            }
        }
        // Complete assignment: redact `[^\r\n]+` unless it is a reference.
        let mut line_end = cursor;
        while line_end < chars.len() && !matches!(chars[line_end], '\r' | '\n') {
            line_end += 1;
        }
        if line_end <= cursor {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let raw_value: String = chars[cursor..line_end].iter().collect();
        let is_reference =
            !field_is_connection && is_credential_assignment_reference(&field, &raw_value);
        if is_reference {
            // Keep the original text.
            output.extend(chars[index..line_end].iter());
            index = line_end;
            continue;
        }
        output.extend(chars[index..cursor].iter());
        output.extend("[REDACTED]".chars());
        index = line_end;
    }
    output.into_iter().collect()
}

fn collapse_redaction_runs(value: &str) -> String {
    let mut result = value.to_string();
    loop {
        // `(\[REDACTED(?: CREDENTIAL| ABSOLUTE PATH)?\])\]+` — only a marker
        // followed by extra `]`s is collapsed.
        let mut changed = false;
        let mut next = String::with_capacity(result.len());
        let chars: Vec<char> = result.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let rest: String = chars[i..].iter().collect();
            let prefixes = [
                "[REDACTED CREDENTIAL]",
                "[REDACTED ABSOLUTE PATH]",
                "[REDACTED]",
            ];
            let mut matched = false;
            for prefix in prefixes {
                if let Some(suffix) = rest.strip_prefix(prefix) {
                    let trailing = suffix.chars().take_while(|ch| *ch == ']').count();
                    if trailing > 0 {
                        next.push_str(prefix);
                        i += prefix.chars().count() + trailing;
                        changed = true;
                    } else {
                        next.push_str(prefix);
                        i += prefix.chars().count();
                    }
                    matched = true;
                    break;
                }
            }
            if !matched {
                next.push(chars[i]);
                i += 1;
            }
        }
        if !changed {
            return next;
        }
        result = next;
    }
}

// ===========================================================================
// Standalone redactions
// ===========================================================================

fn redact_standalone(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output: Vec<char> = Vec::with_capacity(value.len());
    let mut index = 0;
    // Private key blocks: -----BEGIN ...----- ... -----END ...-----
    while index < chars.len() {
        let rest: String = chars[index..].iter().collect();
        let lower_rest = rest.to_ascii_lowercase();
        if lower_rest.starts_with("-----begin") {
            let rest_after = &rest["-----begin".len()..]; // after "-----BEGIN"
            let begin_end = rest_after
                .find("-----")
                .map(|end| index + "-----begin".len() + end + 5);
            if let Some(begin_end) = begin_end {
                let rest_after_begin = &chars[begin_end..];
                let end_text: String = rest_after_begin.iter().collect();
                if let Some(end_marker) = end_text.to_ascii_lowercase().find("-----end") {
                    let end_pos = begin_end + end_marker + 5;
                    let tail: String = chars[end_pos..].iter().collect();
                    let close = tail.find("-----").map(|close| end_pos + close + 5);
                    let redact_end = close.unwrap_or(chars.len());
                    output.extend("[REDACTED PRIVATE KEY]".chars());
                    index = redact_end;
                    continue;
                }
            }
        }
        if lower_rest.starts_with("putty-user-key-file-") {
            output.extend("[REDACTED PRIVATE KEY]".chars());
            index = chars.len();
            continue;
        }
        // ssh key material: ssh-rsa|ssh-ed25519|ecdsa-sha2-... base64 material
        let ssh_hit = ["ssh-rsa", "ssh-ed25519"]
            .iter()
            .find(|prefix| lower_rest.starts_with(*prefix));
        let ecdsa_hit = lower_rest.starts_with("ecdsa-sha2-");
        if let Some(prefix) = ssh_hit {
            let mut cursor = index + prefix.chars().count();
            while cursor < chars.len() && !matches!(chars[cursor], ' ' | '\t' | '\r' | '\n') {
                cursor += 1;
            }
            let after_ws = skip_ws(&chars, cursor);
            let mut material_len = 0;
            let mut cursor2 = after_ws;
            while cursor2 < chars.len()
                && (chars[cursor2].is_ascii_alphanumeric()
                    || matches!(chars[cursor2], '+' | '/' | '='))
            {
                cursor2 += 1;
                material_len += 1;
            }
            if material_len >= 16 {
                output.extend(chars[index..after_ws].iter());
                output.extend("[REDACTED SSH KEY]".chars());
                index = cursor2;
                continue;
            }
        }
        if ecdsa_hit {
            let mut cursor = index;
            while cursor < chars.len() && !matches!(chars[cursor], ' ' | '\t' | '\r' | '\n') {
                cursor += 1;
            }
            let after_ws = skip_ws(&chars, cursor);
            let mut material_len = 0;
            let mut cursor2 = after_ws;
            while cursor2 < chars.len() && chars[cursor2].is_ascii_alphanumeric() {
                cursor2 += 1;
                material_len += 1;
            }
            if material_len >= 16 {
                output.extend(chars[index..after_ws].iter());
                output.extend("[REDACTED SSH KEY]".chars());
                index = cursor2;
                continue;
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    let mut result: String = output.into_iter().collect();
    // Bearer / Basic tokens.
    result = redact_auth_scheme(&result, "Bearer ");
    result = redact_auth_scheme(&result, "Basic ");
    // Credential URIs: scheme://userinfo@
    result = redact_credential_uris(&result);
    // Structured token prefixes.
    result = redact_token_prefixes(&result);
    result
}

fn skip_ws(chars: &[char], mut index: usize) -> usize {
    while index < chars.len() && (chars[index] == ' ' || chars[index] == '\t') {
        index += 1;
    }
    index
}

fn redact_auth_scheme(value: &str, scheme: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let lower: Vec<char> = value.to_ascii_lowercase().chars().collect();
    let scheme_lower: Vec<char> = scheme.to_ascii_lowercase().chars().collect();
    let mut output: Vec<char> = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if index > 0 && is_identifier_char(chars[index - 1]) {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let mut matches_scheme = true;
        for (offset, expected) in scheme_lower.iter().enumerate() {
            if index + offset >= lower.len() || lower[index + offset] != *expected {
                matches_scheme = false;
                break;
            }
        }
        if !matches_scheme {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let mut cursor = index + scheme_lower.len();
        // Optional emphasis markers, then the token run.
        while cursor < chars.len() && matches!(chars[cursor], '*' | '_' | '~') {
            cursor += 1;
        }
        let token_start = cursor;
        while cursor < chars.len()
            && (chars[cursor].is_ascii_alphanumeric()
                || matches!(chars[cursor], '.' | '_' | '~' | '+' | '/' | '=' | '-'))
        {
            cursor += 1;
        }
        if cursor == token_start {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        // Optional trailing emphasis markers.
        while cursor < chars.len() && matches!(chars[cursor], '*' | '_' | '~') {
            cursor += 1;
        }
        output.extend(chars[index..token_start].iter());
        output.extend("[REDACTED]".chars());
        index = cursor;
    }
    output.into_iter().collect()
}

fn redact_credential_uris(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output: Vec<char> = Vec::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if index > 0 && is_identifier_char(chars[index - 1]) {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        // scheme: [a-z][a-z0-9+.-]* :// userinfo @
        if !chars[index].is_ascii_alphabetic() {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        while cursor < chars.len()
            && (chars[cursor].is_ascii_alphanumeric() || matches!(chars[cursor], '+' | '.' | '-'))
        {
            cursor += 1;
        }
        if cursor + 3 > chars.len()
            || chars[cursor] != ':'
            || chars[cursor + 1] != '/'
            || chars[cursor + 2] != '/'
        {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let mut at_cursor = cursor + 3;
        while at_cursor < chars.len()
            && chars[at_cursor] != '@'
            && chars[at_cursor] != '/'
            && chars[at_cursor] != ' '
            && chars[at_cursor] != '\t'
        {
            at_cursor += 1;
        }
        if at_cursor < chars.len() && chars[at_cursor] == '@' {
            output.extend(chars[index..cursor + 3].iter());
            output.extend("[REDACTED]".chars());
            output.push('@');
            index = at_cursor + 1;
        } else {
            output.push(chars[index]);
            index += 1;
        }
    }
    output.into_iter().collect()
}

const TOKEN_PREFIXES: &[(&str, usize)] = &[
    ("AKIA", 16),
    ("AIza", 20),
    ("ghp_", 20),
    ("gho_", 20),
    ("ghu_", 20),
    ("ghs_", 20),
    ("ghr_", 20),
    ("github_pat_", 20),
    ("glpat-", 10),
    ("hf_", 10),
    ("npm_", 10),
    ("pypi-", 10),
    ("sk-", 8),
    ("sk_live_", 12),
    ("sk_test_", 12),
    ("rk_live_", 12),
    ("rk_test_", 12),
    ("xoxb-", 8),
    ("xoxp-", 8),
    ("xoxa-", 8),
    ("xoxr-", 8),
    ("xoxs-", 8),
    ("ya29.", 10),
];

fn token_charset(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')
}

fn redact_token_prefixes(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if index > 0 && is_identifier_char(chars[index - 1]) {
            output.push(chars[index]);
            index += 1;
            continue;
        }
        let mut matched = false;
        // SG. token (sendgrid).
        if index + 2 < chars.len()
            && chars[index] == 'S'
            && chars[index + 1] == 'G'
            && chars[index + 2] == '.'
        {
            let mut cursor = index + 3;
            let mut len = 0;
            while cursor < chars.len()
                && len < 12 + 1
                && token_charset(chars[cursor])
                && chars[cursor] != '.'
            {
                cursor += 1;
                len += 1;
            }
            if cursor < chars.len() && chars[cursor] == '.' {
                cursor += 1;
                let mut len2 = 0;
                while cursor < chars.len() && len2 < 12 + 1 && token_charset(chars[cursor]) {
                    cursor += 1;
                    len2 += 1;
                }
                if len >= 12 && len2 >= 12 {
                    output.push_str("[REDACTED CREDENTIAL]");
                    index = cursor;
                    matched = true;
                }
            }
        }
        if matched {
            continue;
        }
        // JWT: eyJ<base64url>.<base64url>.<base64url>
        if index + 3 <= chars.len()
            && chars[index] == 'e'
            && chars[index + 1] == 'y'
            && chars[index + 2] == 'J'
        {
            let mut segments = 0;
            let mut cursor = index + 3;
            let mut all_long = true;
            let mut current_len = 0;
            while cursor < chars.len() {
                let ch = chars[cursor];
                if ch == '.' {
                    segments += 1;
                    if current_len < 10 {
                        all_long = false;
                    }
                    current_len = 0;
                    cursor += 1;
                    if segments == 3 {
                        break;
                    }
                    continue;
                }
                if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
                    break;
                }
                current_len += 1;
                cursor += 1;
            }
            if segments == 3 && all_long && current_len >= 10 {
                output.push_str("[REDACTED CREDENTIAL]");
                index = cursor;
                matched = true;
            }
        }
        if matched {
            continue;
        }
        let rest: String = chars[index..].iter().collect();
        let mut prefix_hit = false;
        for (prefix, minimum) in TOKEN_PREFIXES {
            if !rest.starts_with(prefix) {
                continue;
            }
            let mut cursor = index + prefix.chars().count();
            let mut len = 0;
            while cursor < chars.len() && token_charset(chars[cursor]) {
                cursor += 1;
                len += 1;
            }
            if len >= *minimum {
                output.push_str("[REDACTED CREDENTIAL]");
                index = cursor;
                prefix_hit = true;
                break;
            }
        }
        if prefix_hit {
            continue;
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

// ===========================================================================
// Absolute path redaction
// ===========================================================================

fn is_path_terminator(ch: char) -> bool {
    matches!(
        ch,
        '\r' | '\n' | ')' | ']' | '}' | '"' | '\'' | '`' | '<' | '>' | ';' | ','
    )
}

fn redact_absolute_paths(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    // file:// URLs
    while index < chars.len() {
        let rest: String = chars[index..].iter().collect();
        let lower_rest = rest.to_ascii_lowercase();
        if lower_rest.starts_with("file://") {
            let mut cursor = index + 7;
            while cursor < chars.len()
                && !is_path_terminator(chars[cursor])
                && chars[cursor] != ' '
                && chars[cursor] != '\t'
            {
                cursor += 1;
            }
            if cursor > index + 7 {
                output.push_str("[REDACTED ABSOLUTE PATH]");
                index = cursor;
                continue;
            }
        }
        // Quoted absolute paths.
        let quote_hit = matches!(chars[index], '"' | '\'' | '`');
        if quote_hit {
            let quote = chars[index];
            let mut cursor = index + 1;
            let mut path_len = 0;
            let is_abs = cursor < chars.len()
                && (chars[cursor] == '/' && chars.get(cursor + 1) != Some(&'/')
                    || (chars[cursor].is_ascii_alphabetic()
                        && chars.get(cursor + 1) == Some(&':')
                        && matches!(chars.get(cursor + 2), Some('\\') | Some('/')))
                    || (chars[cursor] == '\\' && chars.get(cursor + 1) == Some(&'\\')));
            while cursor < chars.len()
                && chars[cursor] != quote
                && chars[cursor] != '\r'
                && chars[cursor] != '\n'
            {
                cursor += 1;
                path_len += 1;
            }
            if is_abs && path_len > 0 && cursor < chars.len() && chars[cursor] == quote {
                output.push(quote);
                output.push_str("[REDACTED ABSOLUTE PATH]");
                output.push(quote);
                index = cursor + 1;
                continue;
            }
        }
        // Generic POSIX absolute path: /...  (not //)
        if chars[index] == '/' && chars.get(index + 1) != Some(&'/') {
            let preceded_ok =
                index == 0 || !(chars[index - 1].is_alphanumeric() || chars[index - 1] == '/');
            if preceded_ok {
                let mut cursor = index + 1;
                while cursor < chars.len() && !is_path_terminator(chars[cursor]) {
                    cursor += 1;
                }
                if cursor > index + 1 {
                    output.push_str("[REDACTED ABSOLUTE PATH]");
                    index = cursor;
                    continue;
                }
            }
        }
        // POSIX root path: `/` alone.
        if chars[index] == '/'
            && (index + 1 >= chars.len()
                || chars[index + 1].is_whitespace()
                || matches!(
                    chars[index + 1],
                    ')' | ']' | '}' | '"' | '\'' | '`' | '<' | '>' | ';' | ','
                ))
        {
            let preceded_ok =
                index == 0 || !(chars[index - 1].is_alphanumeric() || chars[index - 1] == '/');
            if preceded_ok {
                output.push_str("[REDACTED ABSOLUTE PATH]");
                index += 1;
                continue;
            }
        }
        // UNC absolute path: \\...
        if chars[index] == '\\' && chars.get(index + 1) == Some(&'\\') {
            let preceded_ok = index == 0 || !chars[index - 1].is_alphanumeric();
            if preceded_ok {
                let mut cursor = index + 2;
                while cursor < chars.len()
                    && !is_path_terminator(chars[cursor])
                    && chars[cursor] != ' '
                    && chars[cursor] != '\t'
                {
                    cursor += 1;
                }
                if cursor > index + 2 {
                    output.push_str("[REDACTED ABSOLUTE PATH]");
                    index = cursor;
                    continue;
                }
            }
        }
        // Forward-UNC: //... (but not :// — URLs are preserved separately).
        if chars[index] == '/' && chars.get(index + 1) == Some(&'/') {
            let preceded_ok = index == 0
                || !(chars[index - 1].is_alphanumeric()
                    || chars[index - 1] == '/'
                    || chars[index - 1] == ':');
            if preceded_ok {
                let mut cursor = index + 2;
                while cursor < chars.len()
                    && !is_path_terminator(chars[cursor])
                    && chars[cursor] != ' '
                    && chars[cursor] != '\t'
                {
                    cursor += 1;
                }
                if cursor > index + 2 {
                    output.push_str("[REDACTED ABSOLUTE PATH]");
                    index = cursor;
                    continue;
                }
            }
        }
        // Windows absolute path: X:\ or X:/
        if chars[index].is_ascii_alphabetic()
            && chars.get(index + 1) == Some(&':')
            && matches!(chars.get(index + 2), Some('\\') | Some('/'))
        {
            let preceded_ok = index == 0 || !chars[index - 1].is_alphanumeric();
            if preceded_ok {
                let mut cursor = index + 3;
                while cursor < chars.len()
                    && !is_path_terminator(chars[cursor])
                    && chars[cursor] != ' '
                    && chars[cursor] != '\t'
                {
                    cursor += 1;
                }
                if cursor > index + 3 {
                    output.push_str("[REDACTED ABSOLUTE PATH]");
                    index = cursor;
                    continue;
                }
            }
        }
        // Windows root: X:\ or X:/ alone.
        if chars[index].is_ascii_alphabetic()
            && chars.get(index + 1) == Some(&':')
            && matches!(chars.get(index + 2), Some('\\') | Some('/'))
            && (index + 3 >= chars.len()
                || chars[index + 3].is_whitespace()
                || is_path_terminator(chars[index + 3]))
        {
            let preceded_ok = index == 0 || !chars[index - 1].is_alphanumeric();
            if preceded_ok {
                output.push_str("[REDACTED ABSOLUTE PATH]");
                index += 3;
                continue;
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

// ===========================================================================
// Percent decoding
// ===========================================================================

const MAX_PERCENT_DECODE_PASSES: usize = 16;

fn decode_valid_percent_runs(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '%' && index + 2 < chars.len() {
            let hex: String = chars[index + 1..index + 3].iter().collect();
            if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                // Try to decode the maximal valid percent run as UTF-8.
                let run_start = index;
                let mut cursor = index;
                let mut bytes: Vec<u8> = Vec::new();
                while cursor + 2 < chars.len()
                    && chars[cursor] == '%'
                    && chars[cursor + 1].is_ascii_hexdigit()
                    && chars[cursor + 2].is_ascii_hexdigit()
                {
                    let byte = u8::from_str_radix(&value[cursor + 1..cursor + 3], 16).unwrap();
                    bytes.push(byte);
                    cursor += 3;
                }
                match String::from_utf8(bytes.clone()) {
                    Ok(decoded) => {
                        output.push_str(&decoded);
                        index = cursor;
                    }
                    Err(_) => {
                        // Fall back to ASCII-only decoding of the first escape.
                        if bytes.first().map(|b| *b <= 0x7f).unwrap_or(false) {
                            output.push(char::from_u32(bytes[0] as u32).unwrap());
                            index = run_start + 3;
                        } else {
                            output.push('%');
                            index += 1;
                        }
                    }
                }
                continue;
            }
        }
        output.push(chars[index]);
        index += 1;
    }
    output
}

fn decode_percent_layers(value: &str) -> (bool, String) {
    let mut decoded = value.to_string();
    for _pass in 0..MAX_PERCENT_DECODE_PASSES {
        let next = decode_valid_percent_runs(&decoded);
        if next == decoded {
            return (false, decoded);
        }
        decoded = next;
    }
    let next = decode_valid_percent_runs(&decoded);
    (next != decoded, decoded)
}

// ===========================================================================
// Environment assignments
// ===========================================================================

/// `(?<![A-Za-z0-9])(?:\*{1,2}|_{1,2}|~~)?([A-Za-z_][A-Za-z0-9_]{0,63})(?:...)?([ \t]*[:=][ \t]*)`
fn redact_environment_assignments(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut changed = false;
    while cursor < chars.len() {
        if cursor > 0 && chars[cursor - 1].is_ascii_alphanumeric() {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        let mut index = cursor;
        while index < chars.len() && matches!(chars[index], '*' | '_' | '~') {
            index += 1;
        }
        let name_start = index;
        if index >= chars.len() || !(chars[index] == '_' || chars[index].is_ascii_alphabetic()) {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        let mut name_len = 0;
        while index < chars.len()
            && name_len < 64
            && (chars[index] == '_' || chars[index].is_ascii_alphanumeric())
        {
            index += 1;
            name_len += 1;
        }
        let name_end = index;
        while index < chars.len() && matches!(chars[index], '*' | '_' | '~') {
            index += 1;
        }
        // `[ \t]*[:=][ \t]*`
        let mut delim_index = index;
        while delim_index < chars.len() && (chars[delim_index] == ' ' || chars[delim_index] == '\t')
        {
            delim_index += 1;
        }
        if delim_index >= chars.len() || !matches!(chars[delim_index], '=' | ':') {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        let delimiter = chars[delim_index];
        let mut after_delim = delim_index + 1;
        while after_delim < chars.len() && (chars[after_delim] == ' ' || chars[after_delim] == '\t')
        {
            after_delim += 1;
        }
        let name: String = chars[name_start..name_end].iter().collect();
        let is_conventional = name.chars().all(|ch| !ch.is_ascii_lowercase());
        // "Tight" means the delimiter begins immediately after the name.
        let is_tight_equals = delimiter == '=' && delim_index == index;
        // Exclusions mirroring the TS guards.
        if name.chars().count() == 1 && delimiter != '=' {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        if source_code_assignment_context(value, cursor) {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        if !is_conventional
            && (!is_tight_equals
                || base64_token_containing(value, cursor)
                || non_shell_assignment_context(value, cursor))
        {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        let value_end = environment_value_end(&chars, after_delim);
        if value_end <= after_delim {
            output.push(chars[cursor]);
            cursor += 1;
            continue;
        }
        output.push_str(&value[cursor..after_delim]);
        output.push_str("[REDACTED ENVIRONMENT VALUE]");
        cursor = value_end;
        changed = true;
    }
    if changed {
        output.push_str(&value[cursor..]);
        output
    } else {
        value.to_string()
    }
}

fn has_unescaped_line_continuation(chars: &[char], offset: usize) -> bool {
    let mut slashes = 0;
    let mut index = offset;
    while index > 0 && chars.get(index - 1) == Some(&'\\') {
        slashes += 1;
        index -= 1;
    }
    slashes % 2 == 1
}

fn quoted_environment_value_end(chars: &[char], start: usize) -> Option<usize> {
    let quote_offset =
        if start + 1 < chars.len() && chars[start] == '$' && matches!(chars[start + 1], '"' | '\'')
        {
            start + 1
        } else {
            start
        };
    let quote = *chars.get(quote_offset)?;
    if !matches!(quote, '"' | '\'' | '`') {
        return None;
    }
    let mut index = quote_offset + 1;
    while index < chars.len() {
        if chars[index] == '\\' {
            index += 2;
            continue;
        }
        if chars[index] == quote {
            return Some(index + 1);
        }
        index += 1;
    }
    Some(chars.len())
}

fn indented_environment_value_end(chars: &[char], mut end: usize) -> usize {
    let mut saw_indented_line = false;
    while end < chars.len() && (chars[end] == '\r' || chars[end] == '\n') {
        let mut next = end + 1;
        if chars[end] == '\r' && chars.get(next) == Some(&'\n') {
            next += 1;
        }
        let content_start = next;
        while next < chars.len() && (chars[next] == ' ' || chars[next] == '\t') {
            next += 1;
        }
        if next == content_start {
            if !saw_indented_line {
                return end;
            }
            end = next;
            continue;
        }
        saw_indented_line = true;
        while next < chars.len() && chars[next] != '\r' && chars[next] != '\n' {
            next += 1;
        }
        end = next;
    }
    end
}

fn environment_value_end(chars: &[char], start: usize) -> usize {
    if let Some(quoted) = quoted_environment_value_end(chars, start) {
        return quoted;
    }
    let mut end = start;
    while end < chars.len() {
        let ch = chars[end];
        if ch == '\r' || ch == '\n' {
            if !has_unescaped_line_continuation(chars, end) {
                return indented_environment_value_end(chars, end);
            }
            if ch == '\r' && chars.get(end + 1) == Some(&'\n') {
                end += 1;
            }
        }
        end += 1;
    }
    end
}

fn source_code_assignment_context(value: &str, offset: usize) -> bool {
    let before = &value[offset.saturating_sub(256)..offset];
    let line_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line = &before[line_start..];
    let line = line.trim_start();
    if line == "const"
        || line == "let"
        || line == "var"
        || line == "type"
        || line == "interface"
        || line == "class"
        || line == "enum"
    {
        return true;
    }
    if let Some(open) = line.find('(') {
        if (line.starts_with("function")
            || line.starts_with("for")
            || line.starts_with("while")
            || line.starts_with("if")
            || line.starts_with("switch"))
            && line[..open]
                .trim_end()
                .ends_with(|ch: char| ch.is_ascii_alphanumeric() || ch == ' ')
        {
            return true;
        }
    }
    false
}

fn base64_token_containing(value: &str, offset: usize) -> bool {
    let chars: Vec<char> = value.chars().collect();
    let is_token_char =
        |ch: char| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '_' | '-' | '=');
    let mut start = offset;
    while start > 0 && is_token_char(chars[start - 1]) {
        start -= 1;
    }
    let mut end = offset;
    while end < chars.len() && is_token_char(chars[end]) {
        end += 1;
    }
    let token: String = chars[start..end].iter().collect();
    let body = token.trim_end_matches('=');
    let padding = token.len() - body.len();
    // `^[A-Za-z0-9+/_-]{8,}={0,2}$`
    body.len() >= 8
        && padding <= 2
        && body
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '_' | '-'))
}

fn non_shell_assignment_context(value: &str, offset: usize) -> bool {
    // HTML attribute context: `<tag attr=` or inside a tag before `>`.
    let before = &value[offset.saturating_sub(256)..offset];
    if let Some(tag_start) = before.rfind('<') {
        let after = before[tag_start..].trim_start();
        if after.starts_with('/') {
            // closing tag — not an attribute context
        } else {
            return true;
        }
    }
    // URL query parameter context: `https?://...?&name=`
    let line_start = before.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line = &before[line_start..];
    if line.contains("://") {
        let scheme_end = line.find("://").map(|i| i + 3).unwrap_or(0);
        let rest = &line[scheme_end..];
        if rest.contains('?') || rest.contains('&') {
            return true;
        }
    }
    false
}

// ===========================================================================
// Sanitize pipeline
// ===========================================================================

fn sanitize_variant(value: &str, include_environment: bool) -> String {
    let environment_safe = if include_environment {
        let redacted = redact_environment_assignments(value);
        collapse_environment_redaction_runs(&redacted)
    } else {
        value.to_string()
    };
    // The TS runs sanitizePaths twice; the second pass is idempotent for our
    // ported subset, so a single pass keeps the same observable behavior for
    // the bounded grammar below.
    let without_paths = redact_absolute_paths(&environment_safe);
    let restored = without_paths;
    sanitize_credential_text(&restored)
}

fn collapse_environment_redaction_runs(value: &str) -> String {
    // `(\[REDACTED ENVIRONMENT VALUE\])\]+`
    let mut result = value.to_string();
    loop {
        let marker = "[REDACTED ENVIRONMENT VALUE]";
        let Some(position) = result.find(marker) else {
            break;
        };
        let suffix = &result[position + marker.len()..];
        let trailing = suffix.chars().take_while(|ch| *ch == ']').count();
        if trailing == 0 {
            break;
        }
        let mut next = String::with_capacity(result.len());
        next.push_str(&result[..position + marker.len()]);
        next.push_str(&suffix[trailing..]);
        result = next;
    }
    result
}

fn direct_policy_is_unsafe(value: &str, include_environment: bool) -> bool {
    let variants = control_variants(value);
    if contains_obfuscated_assignment_key(&variants.spaced)
        || sanitize_variant(&variants.spaced, include_environment) != variants.spaced
    {
        return true;
    }
    variants.had_controls
        && (contains_obfuscated_assignment_key(&variants.compact)
            || sanitize_variant(&variants.compact, include_environment) != variants.compact)
}

/// The obfuscated-assignment-key detector: assignment keys that only differ
/// from a sensitive skeleton via confusable (homoglyph) characters.
fn contains_obfuscated_assignment_key(value: &str) -> bool {
    if !value.contains('=') && !value.contains(':') {
        return false;
    }
    let chars: Vec<char> = value.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '=' && chars[index] != ':' {
            index += 1;
            continue;
        }
        let delimiter = index;
        let mut end = delimiter;
        while end > 0 && chars[end - 1].is_whitespace() {
            end -= 1;
        }
        let mut start = end;
        let mut length = 0;
        while start > 0 && length < 64 && !is_assignment_key_stop(chars[start - 1]) {
            start -= 1;
            length += 1;
        }
        if length < 2 || (start > 0 && is_key_left_boundary(chars[start - 1])) {
            index += 1;
            continue;
        }
        let key: String = chars[start..end].iter().collect();
        let has_non_ascii = key.chars().any(|ch| ch as u32 > 0x7f);
        let mut ascii_signals = 0usize;
        let mut skeleton = String::new();
        let mut has_unknown = false;
        for ch in key.chars() {
            if ch == '_' || ch == '-' || (ch as u32) >= 0x300 && (ch as u32) <= 0x36f {
                continue;
            }
            if let Some(confusable) = confusable_map(ch) {
                ascii_signals += 1;
                skeleton.push(confusable);
            } else if ch.is_ascii_alphanumeric() {
                ascii_signals += 1;
                skeleton.push(ch.to_ascii_lowercase());
            } else {
                skeleton.push('?');
                has_unknown = true;
            }
        }
        if !has_unknown {
            if !has_non_ascii {
                index += 1;
                continue;
            }
            let comparison = format!("{skeleton}=placeholder-value");
            if sanitize_variant(&comparison, true) != comparison {
                return true;
            }
            index += 1;
            continue;
        }
        if ascii_signals >= 2 && sensitive_skeleton_matches(&skeleton) {
            return true;
        }
        index += 1;
    }
    false
}

fn is_assignment_key_stop(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ':' | '=' | ',' | ';' | '{' | '}' | '[' | ']')
}

fn is_key_left_boundary(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '-'
}

fn confusable_map(ch: char) -> Option<char> {
    match ch {
        'Α' => Some('a'),
        'Β' => Some('b'),
        'Ε' => Some('e'),
        'Ζ' => Some('z'),
        'Η' => Some('h'),
        'Ι' => Some('i'),
        'Κ' => Some('k'),
        'Μ' => Some('m'),
        'Ν' => Some('n'),
        'Ο' => Some('o'),
        'Ρ' => Some('p'),
        'Τ' => Some('t'),
        'Υ' => Some('y'),
        'Χ' => Some('x'),
        'α' => Some('a'),
        'β' => Some('b'),
        'ε' => Some('e'),
        'ι' => Some('i'),
        'κ' => Some('k'),
        'ο' => Some('o'),
        'ρ' => Some('p'),
        'τ' => Some('t'),
        'υ' => Some('y'),
        'χ' => Some('x'),
        'А' => Some('a'),
        'В' => Some('b'),
        'Е' => Some('e'),
        'Н' => Some('h'),
        'І' => Some('i'),
        'Ј' => Some('j'),
        'К' => Some('k'),
        'М' => Some('m'),
        'О' => Some('o'),
        'Р' => Some('p'),
        'Ѕ' => Some('s'),
        'Т' => Some('t'),
        'Х' => Some('x'),
        'У' => Some('y'),
        'а' => Some('a'),
        'в' => Some('b'),
        'г' => Some('r'),
        'е' => Some('e'),
        'і' => Some('i'),
        'ј' => Some('j'),
        'к' => Some('k'),
        'м' => Some('m'),
        'о' => Some('o'),
        'р' => Some('p'),
        'с' => Some('c'),
        'ѕ' => Some('s'),
        'т' => Some('t'),
        'х' => Some('x'),
        'у' => Some('y'),
        'ԁ' => Some('d'),
        _ => None,
    }
}

const SENSITIVE_KEY_SKELETONS: &[&str] = &[
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
];

fn sensitive_skeleton_matches(skeleton: &str) -> bool {
    let stripped: String = skeleton.chars().filter(|ch| *ch != '?').collect();
    SENSITIVE_KEY_SKELETONS
        .iter()
        .any(|sensitive| skeleton.contains('?') && stripped == *sensitive)
}

// ===========================================================================
// Encoded payload detection
// ===========================================================================

const MAX_ENCODING_DEPTH: usize = 16;
const MAX_ENCODING_STEPS: usize = 2_048;
const MAX_DECODED_CHARACTERS: usize = 128 * 1024;

fn decode_base64_token(token: &str) -> Option<String> {
    let unpadded = token
        .trim_end_matches('=')
        .replace('-', "+")
        .replace('_', "/");
    if unpadded.chars().count() % 4 == 1 {
        return None;
    }
    let padded = format!(
        "{unpadded}{}",
        "=".repeat((4 - unpadded.chars().count() % 4) % 4)
    );
    let mut bits: u32 = 0;
    let mut bit_count = 0;
    let mut bytes: Vec<u8> = Vec::new();
    for ch in padded.chars() {
        if ch == '=' {
            break;
        }
        let digit = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            _ => return None,
        };
        bits = (bits << 6) | digit;
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            bytes.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    String::from_utf8(bytes).ok()
}

fn decode_hex_token(token: &str) -> Option<String> {
    let hex = token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"))
        .unwrap_or(token);
    if !hex.len().is_multiple_of(2) || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    let bytes: Vec<u8> = hex
        .as_bytes()
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect();
    String::from_utf8(bytes).ok()
}

fn decode_base32_token(token: &str, alphabet: &str) -> Option<String> {
    let normalized = token.to_ascii_uppercase();
    let first_padding = normalized.find('=');
    let (encoded, padding) = match first_padding {
        Some(position) => (&normalized[..position], &normalized[position..]),
        None => (normalized.as_str(), ""),
    };
    if !padding.chars().all(|ch| ch == '=') {
        return None;
    }
    let remainder = encoded.len() % 8;
    let expected_padding = match remainder {
        0 => Some(0),
        2 => Some(6),
        4 => Some(4),
        5 => Some(3),
        7 => Some(1),
        _ => None,
    };
    let expected_padding = expected_padding?;
    if !padding.is_empty() && padding.len() != expected_padding {
        return None;
    }
    if !padding.is_empty() && !normalized.len().is_multiple_of(8) {
        return None;
    }
    let mut bits: u64 = 0;
    let mut bit_count = 0;
    let mut bytes: Vec<u8> = Vec::new();
    for ch in encoded.chars() {
        let digit = alphabet.find(ch)? as u64;
        bits = bits * 32 + digit;
        bit_count += 5;
        while bit_count >= 8 {
            bit_count -= 8;
            let divisor = 1u64 << bit_count;
            bytes.push(((bits / divisor) & 0xff) as u8);
            bits %= divisor;
        }
    }
    if bit_count > 0 && bits != 0 {
        return None;
    }
    String::from_utf8(bytes).ok()
}

/// One bounded JavaScript/JSON escape layer.
fn decode_javascript_escape_layer(value: &str) -> Option<(bool, String)> {
    let chars: Vec<char> = value.chars().collect();
    let mut decoded = String::with_capacity(value.len());
    let mut decoded_bounded_escape = false;
    let mut decoded_control = false;
    let mut collapsed_backslash = false;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch != '\\' || index + 1 >= chars.len() {
            decoded.push(ch);
            index += 1;
            continue;
        }
        let next = chars[index + 1];
        if next == '\\' {
            decoded.push('\\');
            collapsed_backslash = true;
            index += 2;
            continue;
        }
        if next == 'u' {
            if chars.get(index + 2) == Some(&'{') {
                let mut close = index + 3;
                while close < chars.len() && chars[close] != '}' && close - (index + 3) <= 6 {
                    close += 1;
                }
                if close < chars.len() && chars[close] == '}' && close - (index + 3) <= 6 {
                    let hex: String = chars[index + 3..close].iter().collect();
                    if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                        if let Ok(code_point) = u32::from_str_radix(&hex, 16) {
                            if code_point <= 0x10ffff {
                                let character = char::from_u32(code_point).unwrap();
                                decoded.push(character);
                                decoded_bounded_escape = true;
                                if is_control(character) {
                                    decoded_control = true;
                                }
                                index = close + 1;
                                continue;
                            }
                        }
                    }
                }
            } else if index + 6 <= chars.len() {
                let hex: String = chars[index + 2..index + 6].iter().collect();
                if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                    let character = char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap();
                    decoded.push(character);
                    decoded_bounded_escape = true;
                    if is_control(character) {
                        decoded_control = true;
                    }
                    index += 6;
                    continue;
                }
            }
        } else if next == 'x' && index + 4 <= chars.len() {
            let hex: String = chars[index + 2..index + 4].iter().collect();
            if hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                let character = char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap();
                decoded.push(character);
                decoded_bounded_escape = true;
                if is_control(character) {
                    decoded_control = true;
                }
                index += 4;
                continue;
            }
        } else if matches!(next, 'b' | 'f' | 'n' | 'r' | 't') {
            let replacement = match next {
                'b' => '\u{8}',
                'f' => '\u{c}',
                'n' => '\n',
                'r' => '\r',
                _ => '\t',
            };
            decoded.push(replacement);
            decoded_bounded_escape = true;
            decoded_control = true;
            index += 2;
            continue;
        } else if next.is_ascii_digit() && next <= '7' {
            let available: String = chars[index + 1..(index + 4).min(chars.len())]
                .iter()
                .collect();
            let mut octal = "";
            if available.len() >= 3
                && available.as_bytes()[0] <= b'3'
                && available.as_bytes()[1] <= b'7'
                && available.as_bytes()[2] <= b'7'
            {
                octal = &available[..3];
            } else if available.len() >= 2
                && available.as_bytes()[0] <= b'7'
                && available.as_bytes()[1] <= b'7'
            {
                octal = &available[..2];
            } else if next == '0'
                && !chars
                    .get(index + 2)
                    .map(|ch| ch.is_ascii_digit())
                    .unwrap_or(false)
            {
                octal = "0";
            }
            if !octal.is_empty() {
                let character = char::from_u32(u32::from_str_radix(octal, 8).unwrap()).unwrap();
                decoded.push(character);
                decoded_bounded_escape = true;
                if is_control(character) {
                    decoded_control = true;
                }
                index += octal.len() + 1;
                continue;
            }
        }
        decoded.push(ch);
        index += 1;
    }
    if decoded_bounded_escape {
        return Some((decoded_control, decoded));
    }
    let has_numeric_escape = decoded.contains("\\u") || decoded.contains("\\x");
    if collapsed_backslash && has_numeric_escape {
        return Some((false, decoded));
    }
    None
}

/// Does the value contain a reversible encoding of a credential?
fn encoded_payload_is_unsafe(value: &str, policy_is_unsafe: &dyn Fn(&str) -> bool) -> bool {
    let mut worklist: Vec<(usize, String)> = vec![(0, value.to_string())];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(value.to_string());
    let mut decoded_characters = 0usize;
    let mut steps = 0usize;
    while let Some((depth, candidate)) = worklist.pop() {
        let mut payloads: Vec<String> = Vec::new();
        if let Some((_, decoded)) = decode_javascript_escape_layer(&candidate) {
            payloads.push(decoded);
        }
        let mut cursor = 0;
        let chars: Vec<char> = candidate.chars().collect();
        while cursor < chars.len() {
            if chars[cursor].is_ascii_alphanumeric()
                || matches!(chars[cursor], '+' | '/' | '_' | '-' | '=')
            {
                let start = cursor;
                while cursor < chars.len()
                    && (chars[cursor].is_ascii_alphanumeric()
                        || matches!(chars[cursor], '+' | '/' | '_' | '-' | '='))
                {
                    cursor += 1;
                }
                let token: String = chars[start..cursor].iter().collect();
                if token.chars().count() >= 8 {
                    if let Some(decoded) = decode_base64_token(&token) {
                        payloads.push(decoded);
                    }
                }
                if token.chars().count() >= 16 {
                    if let Some(decoded) = decode_hex_token(&token) {
                        payloads.push(decoded);
                    }
                    if let Some(decoded) =
                        decode_base32_token(&token, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
                    {
                        payloads.push(decoded);
                    }
                    if let Some(decoded) =
                        decode_base32_token(&token, "0123456789ABCDEFGHIJKLMNOPQRSTUV")
                    {
                        payloads.push(decoded);
                    }
                }
            } else {
                cursor += 1;
            }
        }
        if depth >= MAX_ENCODING_DEPTH && !payloads.is_empty() {
            return true;
        }
        for decoded in payloads {
            steps += 1;
            decoded_characters += decoded.chars().count();
            if steps > MAX_ENCODING_STEPS || decoded_characters > MAX_DECODED_CHARACTERS {
                return true;
            }
            let normalized: String = decoded
                .chars()
                .filter(|ch| !is_default_ignorable(*ch))
                .collect();
            let (percent_exhausted, percent_decoded) = decode_percent_layers(&normalized);
            if percent_exhausted || policy_is_unsafe(&normalized) {
                return true;
            }
            if percent_decoded != normalized && policy_is_unsafe(&percent_decoded) {
                return true;
            }
            for next in [normalized.clone(), percent_decoded] {
                if seen.contains(&next) {
                    continue;
                }
                seen.insert(next.clone());
                worklist.push((depth + 1, next));
            }
        }
    }
    false
}

fn direct_credential_policy_is_unsafe(value: &str) -> bool {
    let variants = control_variants(value);
    if contains_obfuscated_assignment_key(&variants.spaced)
        || sanitize_credential_text(&variants.spaced) != variants.spaced
    {
        return true;
    }
    variants.had_controls
        && (contains_obfuscated_assignment_key(&variants.compact)
            || sanitize_credential_text(&variants.compact) != variants.compact)
}

// ===========================================================================
// Public API
// ===========================================================================

/// Reject raw or reversibly encoded credentials at model-facing file
/// boundaries.
pub fn contains_high_confidence_secret(value: &str) -> bool {
    direct_credential_policy_is_unsafe(value)
}

/// Stricter variant that also decodes base64/hex/base32/percent/JS-escape
/// layers before re-checking the direct policy.
pub fn contains_high_confidence_secret_including_encodings(value: &str) -> bool {
    if direct_credential_policy_is_unsafe(value) {
        return true;
    }
    let (percent_exhausted, percent_decoded) = decode_percent_layers(value);
    if percent_exhausted {
        return true;
    }
    if percent_decoded != value && direct_policy_is_unsafe(&percent_decoded, false) {
        return true;
    }
    encoded_payload_is_unsafe(value, &|candidate| {
        direct_policy_is_unsafe(candidate, false)
    }) || (percent_decoded != value
        && encoded_payload_is_unsafe(&percent_decoded, &|candidate| {
            direct_policy_is_unsafe(candidate, false)
        }))
}

fn sanitize_with_policy(value: &str, include_environment: bool) -> String {
    let variants = control_variants(value);
    let safe = sanitize_variant(&variants.spaced, include_environment);
    if !include_environment {
        if contains_high_confidence_secret_including_encodings(&safe) {
            return ENCODED_TEXT_REDACTION.to_string();
        }
    } else if contains_high_confidence_secret_including_encodings(&safe) {
        return ENCODED_TEXT_REDACTION.to_string();
    }
    if variants.had_controls {
        let compact_safe = sanitize_variant(&variants.compact, include_environment);
        if compact_safe != variants.compact
            || (!include_environment
                && contains_high_confidence_secret_including_encodings(&compact_safe))
            || (include_environment
                && contains_high_confidence_secret_including_encodings(&compact_safe))
        {
            return CONTROL_SPLIT_REDACTION.to_string();
        }
    }
    safe
}

/// Strip high-confidence credentials and absolute filesystem paths at trust
/// boundaries (model-facing reports).
pub fn sanitize_subagent_text(value: &str) -> String {
    sanitize_with_policy(value, false)
}

/// Renderer snapshots are stricter: even ordinary environment assignments are
/// hidden because no environment data belongs in persisted or IPC-visible
/// child state.
pub fn sanitize_subagent_snapshot_text(value: &str) -> String {
    sanitize_with_policy(value, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_and_plain_text_pass_through_unchanged() {
        for input in [
            "run-1",
            "generation-1",
            "Review the authority boundary.",
            "Reading workspace files",
            "Remote change outcome unknown. Check the remote system before retrying.",
            "Completed successfully.",
        ] {
            assert_eq!(sanitize_subagent_snapshot_text(input), input, "{input}");
            assert!(!contains_high_confidence_secret(input));
        }
    }

    #[test]
    fn redacts_assigned_secrets() {
        assert!(contains_high_confidence_secret("password: hunter2"));
        assert_eq!(
            sanitize_subagent_snapshot_text("apiKey = sk-abcdefghijklmnopqrstuvwxyz"),
            "apiKey = [REDACTED]"
        );
        assert_eq!(
            sanitize_subagent_snapshot_text("NODE_ENV=production"),
            "NODE_ENV=[REDACTED ENVIRONMENT VALUE]"
        );
        assert_eq!(
            sanitize_subagent_snapshot_text("token=secret-value"),
            "token=[REDACTED]"
        );
        assert_eq!(
            sanitize_subagent_snapshot_text("Bearer abcdefghijklmnopqrstuvwxyz"),
            "Bearer [REDACTED]"
        );
    }

    #[test]
    fn preserves_environment_accessor_references() {
        let input = "password = process.env.DB_PASSWORD";
        assert_eq!(sanitize_subagent_text(input), input);
        assert!(!contains_high_confidence_secret(input));
    }

    #[test]
    fn redacts_absolute_paths_but_keeps_relative_ones() {
        assert!(!contains_high_confidence_secret(
            "changed /Users/sambit/file.txt"
        ));
        assert_eq!(
            sanitize_subagent_snapshot_text("path /Users/sambit/file.txt"),
            "path [REDACTED ABSOLUTE PATH]"
        );
        assert_eq!(
            sanitize_subagent_snapshot_text("src/renderer/shared/appearance.ts"),
            "src/renderer/shared/appearance.ts"
        );
    }

    #[test]
    fn encoded_credentials_are_detected() {
        let plaintext = "password=super-secret-1";
        let encoded = base64_encode(plaintext.as_bytes());
        assert!(contains_high_confidence_secret_including_encodings(
            &encoded
        ));
        assert!(!contains_high_confidence_secret(&encoded));
        let hex_encoded = plaintext
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert!(contains_high_confidence_secret_including_encodings(
            &hex_encoded
        ));
    }

    fn base64_encode(bytes: &[u8]) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut output = String::new();
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
            let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
            let combined = (b0 << 16) | (b1 << 8) | b2;
            output.push(ALPHABET[((combined >> 18) & 63) as usize] as char);
            output.push(ALPHABET[((combined >> 12) & 63) as usize] as char);
            if chunk.len() > 1 {
                output.push(ALPHABET[((combined >> 6) & 63) as usize] as char);
            } else {
                output.push('=');
            }
            if chunk.len() > 2 {
                output.push(ALPHABET[(combined & 63) as usize] as char);
            } else {
                output.push('=');
            }
        }
        output
    }
}
