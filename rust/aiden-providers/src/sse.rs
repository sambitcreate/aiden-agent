//! Pure SSE frame parsing shared by every provider transport.
//!
//! Two shapes exist in the wild:
//! - **event-tagged** (Anthropic Messages): frames carry `event: <name>` +
//!   `data: <json>` fields and are split on blank lines.
//! - **data-only** (OpenAI Chat Completions, OpenAI Responses, Google
//!   `:streamGenerateContent`, Codex): every frame is a bare `data: <json>`
//!   line (or several `data:` lines joined with `\n`); a `[DONE]` sentinel
//!   terminates the stream.
//!
//! [`sse_frames`] keeps the event-tagged parser used by the Anthropic tests;
//! [`SseDecoder`] is an incremental data-only splitter for live byte streams
//! and is reused by the fixture tests so the same code path is exercised
//! without any network.

/// A parsed SSE frame: (event name, data payload). Event name is empty for
/// bare `data:` frames.
pub type SseFrame = (String, String);

/// Split a complete event-tagged SSE byte stream into frames. Handles `\r\n`
/// and `\n` line endings, joins multi-line `data:` payloads with `\n`, and
/// skips comment lines (`: ...`) and unknown fields per the SSE spec.
pub fn sse_frames(input: &[u8]) -> Vec<SseFrame> {
    let text = String::from_utf8_lossy(input).replace("\r\n", "\n");
    let mut frames = Vec::new();
    for block in text.split("\n\n") {
        let mut event = String::new();
        let mut data = Vec::new();
        let mut saw_data = false;
        for raw_line in block.lines() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            if let Some(name) = line.strip_prefix("event:") {
                event = name.trim().to_string();
            } else if let Some(payload) = line.strip_prefix("data:") {
                saw_data = true;
                data.push(payload.trim_start().to_string());
            }
            // `:` comments and unknown fields are ignored per the SSE spec.
        }
        if saw_data || !event.is_empty() {
            frames.push((event, data.join("\n")));
        }
    }
    frames
}

/// Split a complete data-only SSE byte stream into payload strings.
/// `[DONE]` sentinels are preserved as their own payload so callers decide
/// how to treat them.
pub fn data_payloads(input: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(input).replace("\r\n", "\n");
    let mut payloads = Vec::new();
    for block in text.split("\n\n") {
        let mut data = Vec::new();
        let mut saw_data = false;
        for raw_line in block.lines() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            if let Some(payload) = line.strip_prefix("data:") {
                saw_data = true;
                data.push(payload.trim_start().to_string());
            }
        }
        if saw_data {
            payloads.push(data.join("\n"));
        }
    }
    payloads
}

/// Incremental data-only SSE splitter for live byte streams. Bytes are pushed
/// in arbitrary chunk sizes; complete frames are returned as they are
/// delimited by a blank line. `finish` flushes any trailing unterminated
/// frame (providers that close the connection without a final blank line).
#[derive(Default)]
pub struct SseDecoder {
    buffer: String,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append bytes and return any complete `data:` payloads delimited so far.
    /// CRLF line endings are normalized so `\r\n\r\n` block separators split
    /// identically to `\n\n` (the normalization runs on the accumulated
    /// buffer, so a `\r\n` pair split across chunks is still caught).
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        self.buffer = self.buffer.replace("\r\n", "\n");
        let mut payloads = Vec::new();
        while let Some(sep) = self.buffer.find("\n\n") {
            let block = self.buffer.drain(..=sep + 1).collect::<String>();
            if let Some(payload) = extract_data_payload(&block) {
                payloads.push(payload);
            }
        }
        payloads
    }

    /// Flush any remaining unterminated frame.
    pub fn finish(&mut self) -> Vec<String> {
        let tail = std::mem::take(&mut self.buffer);
        extract_data_payload(&tail).into_iter().collect()
    }
}

/// Extract the joined `data:` payload from one blank-line-delimited block.
/// Returns `None` when the block carries no `data:` lines.
fn extract_data_payload(block: &str) -> Option<String> {
    let mut data = Vec::new();
    for raw_line in block.lines() {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        if let Some(payload) = line.strip_prefix("data:") {
            data.push(payload.trim_start().to_string());
        }
    }
    if data.is_empty() {
        None
    } else {
        Some(data.join("\n"))
    }
}

/// Convenience: parse a complete data-only byte stream via [`SseDecoder`]
/// (identical behavior to [`data_payloads`], exercised by the same tests).
pub fn parse_data_sse(input: &[u8]) -> Vec<String> {
    let mut decoder = SseDecoder::new();
    let mut payloads = decoder.push(input);
    payloads.extend(decoder.finish());
    payloads
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_frames_are_split_with_crlf_tolerated() {
        let input = b"event: message_start\r\ndata: {\"a\":1}\r\n\r\ndata: {\"b\":2}\n\n";
        let frames = sse_frames(input);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].0, "message_start");
        assert_eq!(frames[0].1, "{\"a\":1}");
        assert_eq!(frames[1].0, "");
        assert_eq!(frames[1].1, "{\"b\":2}");
    }

    #[test]
    fn multi_line_data_payloads_join_with_newline() {
        let input = b"data: line1\ndata: line2\n\n";
        let frames = sse_frames(input);
        assert_eq!(frames[0].1, "line1\nline2");
    }

    #[test]
    fn comments_and_unknown_fields_are_ignored() {
        let input = b": keepalive\nretry: 1000\ndata: {\"ok\":true}\n\n";
        let frames = sse_frames(input);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].1, "{\"ok\":true}");
    }

    #[test]
    fn data_payloads_keep_done_sentinel() {
        let input = b"data: {\"id\":\"1\"}\n\ndata: [DONE]\n\n";
        let payloads = data_payloads(input);
        assert_eq!(payloads, vec!["{\"id\":\"1\"}", "[DONE]"]);
    }

    #[test]
    fn decoder_handles_fragmented_chunks() {
        let mut decoder = SseDecoder::new();
        let bytes = b"data: {\"abc\"";
        assert!(decoder.push(bytes).is_empty());
        let rest = b": 1}\n\ndata: {\"b\":2}\n\n";
        let payloads = decoder.push(rest);
        assert_eq!(payloads, vec!["{\"abc\": 1}", "{\"b\":2}"]);
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn decoder_flushes_trailing_unterminated_frame() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b"data: {\"a\":1}\n").is_empty());
        assert_eq!(decoder.finish(), vec!["{\"a\":1}"]);
    }
}
