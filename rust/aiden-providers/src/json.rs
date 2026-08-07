//! Pure JSON / text helpers ported from pi-ai `utils/json-parse.js`,
//! `utils/hash.js`, `utils/sanitize-unicode.js`, and the `[DONE]` sentinel
//! handling. No IO; these are the fixtures-testable core of the streaming
//! accumulators.

/// `[DONE]` sentinel terminating OpenAI-style data-only SSE streams.
pub const SSE_DONE: &str = "[DONE]";

/// OpenAI prompt-cache key clamp (`clampOpenAIPromptCacheKey`): first 64
/// chars, splitting on Unicode scalar boundaries.
pub fn clamp_openai_prompt_cache_key(key: &str) -> String {
    key.chars().take(64).collect()
}

/// Fast deterministic hash shortening long strings (`utils/hash.js`).
pub fn short_hash(input: &str) -> String {
    let mut h1: u32 = 0xdeadbeef;
    let mut h2: u32 = 0x41c6ce57;
    for ch in input.chars() {
        let ch = ch as u32;
        h1 = h1.wrapping_mul(2654435761) ^ ch;
        h2 = h2.wrapping_mul(1597334677) ^ ch;
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2246822507) ^ (h2 ^ (h2 >> 13)).wrapping_mul(3266489909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2246822507) ^ (h1 ^ (h1 >> 13)).wrapping_mul(3266489909);
    format!("{:x}{:x}", h2, h1)
}

/// `JSON.stringify` with `undefined`/circular fallback semantics.
pub fn safe_json_stringify(value: &serde_json::Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[unserializable]".to_string())
}

/// Port of pi-ai `sanitizeSurrogates` (removes unpaired UTF-16 surrogates that
/// break JSON serialization at several providers).
///
/// Rust `str` values are always valid UTF-8 and therefore can never contain a
/// lone surrogate code point, so this is an identity function here — the
/// TS-side hazard (a lone surrogate entering a request body) cannot arise once
/// bytes have been decoded into a `String`. Kept for call-site parity with the
/// vendored transports.
pub fn sanitize_surrogates(text: &str) -> String {
    let _ = text;
    text.to_string()
}

/// Group a non-negative integer with US-style thousands separators
/// (`toLocaleString("en-US")`).
pub fn group_digits(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (count, ch) in digits.chars().rev().enumerate() {
        if count > 0 && count % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

/// Escape raw control characters inside JSON string literals and repair
/// invalid backslash escapes (`repairJson` in `utils/json-parse.js`).
pub fn repair_json(json: &str) -> String {
    const VALID_ESCAPES: &[char] = &['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u'];
    let chars: Vec<char> = json.chars().collect();
    let mut out = String::with_capacity(json.len());
    let mut in_string = false;
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if !in_string {
            out.push(ch);
            if ch == '"' {
                in_string = true;
            }
            index += 1;
            continue;
        }
        if ch == '"' {
            out.push(ch);
            in_string = false;
            index += 1;
            continue;
        }
        if ch == '\\' {
            let next = chars.get(index + 1).copied();
            match next {
                None => {
                    out.push_str("\\\\");
                    index += 1;
                }
                Some('u') => {
                    let hex: String = chars.iter().skip(index + 2).take(4).collect();
                    if hex.len() == 4 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
                        out.push_str("\\u");
                        out.push_str(&hex);
                        index += 6;
                    } else {
                        // `\u` without 4 hex digits (or an invalid escape
                        // following it): emit a literal backslash pair.
                        out.push_str("\\\\");
                        index += 1;
                    }
                }
                Some(next_ch) if VALID_ESCAPES.contains(&next_ch) => {
                    out.push('\\');
                    out.push(next_ch);
                    index += 2;
                }
                Some(_) => {
                    out.push_str("\\\\");
                    index += 1;
                }
            }
            continue;
        }
        if is_control(ch) {
            out.push_str(&escape_control(ch));
        } else {
            out.push(ch);
        }
        index += 1;
    }
    out
}

fn is_control(ch: char) -> bool {
    let code = ch as u32;
    code <= 0x1F || code == 0x7F
}

fn escape_control(ch: char) -> String {
    match ch {
        '\u{0008}' => "\\b".to_string(),
        '\u{000C}' => "\\f".to_string(),
        '\n' => "\\n".to_string(),
        '\r' => "\\r".to_string(),
        '\t' => "\\t".to_string(),
        other => format!("\\u{:04x}", other as u32),
    }
}

/// Parse JSON, retrying once after repairing string literals.
pub fn parse_json_with_repair(json: &str) -> Result<serde_json::Value, serde_json::Error> {
    match serde_json::from_str(json) {
        Ok(value) => Ok(value),
        Err(first) => {
            let repaired = repair_json(json);
            if repaired != json {
                serde_json::from_str(&repaired)
            } else {
                Err(first)
            }
        }
    }
}

/// Best-effort parse of a streaming JSON fragment (`parseStreamingJson`).
/// Always yields a valid object: `{}` when nothing useful can be recovered.
pub fn parse_streaming_json(partial_json: &str) -> serde_json::Value {
    if partial_json.trim().is_empty() {
        return serde_json::Value::Object(Default::default());
    }
    if let Ok(value) = parse_json_with_repair(partial_json) {
        return value;
    }
    if let Ok(value) = partial_json_parse(partial_json) {
        return value;
    }
    if let Ok(value) = partial_json_parse(&repair_json(partial_json)) {
        return value;
    }
    serde_json::Value::Object(Default::default())
}

/// A small tolerant parser for incomplete JSON fragments: returns whatever
/// top-level structure is recoverable, or `Err` when nothing parses.
fn partial_json_parse(input: &str) -> Result<serde_json::Value, serde_json::Error> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "empty partial json",
        )));
    }
    let bytes = trimmed.as_bytes();
    match bytes[0] {
        b'{' => parse_partial_object(bytes),
        b'[' => parse_partial_array(bytes),
        b'"' => parse_partial_string(bytes),
        b't' | b'f' | b'n' | b'-' | b'0'..=b'9' => {
            // Best effort: let serde decide; numbers/booleans rarely stream.
            let mut end = 0;
            for (idx, byte) in bytes.iter().enumerate() {
                if *byte == b',' || *byte == b'}' || *byte == b']' || *byte == b'\n' {
                    end = idx;
                    break;
                }
                end = idx + 1;
            }
            serde_json::from_slice(&bytes[..end])
        }
        _ => Err(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unexpected json start",
        ))),
    }
}

fn parse_partial_string(bytes: &[u8]) -> Result<serde_json::Value, serde_json::Error> {
    let text = String::from_utf8_lossy(bytes);
    // Find the closing quote, respecting backslash escapes.
    let mut escaped = false;
    for (idx, ch) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '"' {
            return serde_json::from_str(&text[..=idx]);
        }
    }
    // Unterminated string: append a closing quote and try again.
    serde_json::from_str(&format!("{text}\""))
}

/// Close an unterminated trailing string literal (used before brace closing).
fn repair_trailing_string(text: &str) -> String {
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
        }
    }
    if in_string {
        format!("{text}\"")
    } else {
        text.to_string()
    }
}

/// Walk a JSON fragment tracking the open-bracket depth and whether the input
/// ends inside a string literal.
fn partial_json_depth(text: &str) -> (i32, bool) {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for ch in text.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            _ => {}
        }
    }
    (depth, in_string)
}

fn parse_partial_object(bytes: &[u8]) -> Result<serde_json::Value, serde_json::Error> {
    let text = String::from_utf8_lossy(bytes);
    let (depth, in_string) = partial_json_depth(&text);
    if depth <= 0 && !in_string {
        return serde_json::from_str(&text);
    }
    // Close the unterminated string, then the remaining open braces.
    let mut candidate = repair_trailing_string(&text);
    for _ in 0..depth.max(0) {
        candidate.push('}');
    }
    serde_json::from_str(&candidate)
}

fn parse_partial_array(bytes: &[u8]) -> Result<serde_json::Value, serde_json::Error> {
    let text = String::from_utf8_lossy(bytes);
    let (depth, in_string) = partial_json_depth(&text);
    if depth <= 0 && !in_string {
        return serde_json::from_str(&text);
    }
    let mut candidate = repair_trailing_string(&text);
    for _ in 0..depth.max(0) {
        candidate.push(']');
    }
    serde_json::from_str(&candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_cache_key_respects_scalar_boundaries() {
        let long: String = "a".repeat(100);
        assert_eq!(clamp_openai_prompt_cache_key(&long).chars().count(), 64);
        assert_eq!(clamp_openai_prompt_cache_key("short"), "short");
    }

    #[test]
    fn short_hash_is_deterministic_and_compact() {
        let a = short_hash("fc_item_12345");
        assert_eq!(a, short_hash("fc_item_12345"));
        assert!(a.len() <= 16);
        assert_ne!(a, short_hash("fc_item_12346"));
    }

    #[test]
    fn streaming_json_repairs_control_characters() {
        // A raw newline inside a string literal breaks strict JSON.
        let fragment = "{\"a\": \"line1\nline2\"}";
        let parsed = parse_streaming_json(fragment);
        assert_eq!(parsed["a"], "line1\nline2");
    }

    #[test]
    fn streaming_json_parses_incomplete_objects() {
        let parsed = parse_streaming_json("{\"pattern\": \"fo");
        assert_eq!(parsed["pattern"], "fo");
    }

    #[test]
    fn streaming_json_empty_and_garbage_yield_object() {
        assert_eq!(parse_streaming_json(""), serde_json::json!({}));
        assert_eq!(parse_streaming_json("  "), serde_json::json!({}));
        assert_eq!(parse_streaming_json("{{{"), serde_json::json!({}));
    }

    #[test]
    fn streaming_json_parses_complete_fragments() {
        assert_eq!(
            parse_streaming_json("{\"x\": [1, 2, 3]}"),
            serde_json::json!({"x": [1, 2, 3]})
        );
    }

    #[test]
    fn sanitize_is_identity_for_valid_utf8() {
        // Rust strings cannot hold lone surrogates; the sanitizer is a no-op
        // that preserves valid text including emoji.
        assert_eq!(
            sanitize_surrogates("hi \u{1F648} world"),
            "hi \u{1F648} world"
        );
        assert_eq!(sanitize_surrogates("plain text"), "plain text");
    }

    #[test]
    fn group_digits_matches_us_locale() {
        assert_eq!(group_digits(0), "0");
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1000), "1,000");
        assert_eq!(group_digits(1234567), "1,234,567");
    }
}
