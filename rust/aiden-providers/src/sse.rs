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
/// how to treat them. Empty `data:` frames (keepalives) are dropped, matching
/// the incremental [`SseDecoder`] behavior.
pub fn data_payloads(input: &[u8]) -> Vec<String> {
    parse_data_sse(input)
}

/// Incremental data-only SSE splitter for live byte streams. Bytes are pushed
/// in arbitrary chunk sizes; complete frames are returned as they are
/// delimited by a blank line. `finish` flushes any trailing unterminated
/// frame (providers that close the connection without a final blank line).
///
/// The splitter buffers *raw bytes* and only decodes UTF-8 once a whole frame
/// is delimited, so a multi-byte character split across two chunk boundaries
/// is not corrupted by a per-chunk `from_utf8_lossy` (which would inject
/// U+FFFD replacement characters into the JSON and break parsing).
#[derive(Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append bytes and return any complete `data:` payloads delimited so far.
    /// CRLF line endings are normalized so `\r\n\r\n` block separators split
    /// identically to `\n\n` (the normalization runs on the accumulated
    /// buffer, so a `\r\n` pair split across chunks is still caught). Frames
    /// with an empty `data:` payload (e.g. `data: \n\n` keepalives emitted by
    /// some proxies) are dropped — they carry no JSON.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(bytes);
        normalize_crlf(&mut self.buffer);
        let mut payloads = Vec::new();
        while let Some(sep) = find_subslice(&self.buffer, b"\n\n") {
            let block: Vec<u8> = self.buffer.drain(..sep + 2).collect();
            if let Some(payload) = extract_data_payload_bytes(&block) {
                payloads.push(payload);
            }
        }
        payloads
    }

    /// Flush any remaining unterminated frame.
    pub fn finish(&mut self) -> Vec<String> {
        let tail = std::mem::take(&mut self.buffer);
        extract_data_payload_bytes(&tail).into_iter().collect()
    }
}

/// Replace every `\r\n` with `\n` in place.
fn normalize_crlf(buffer: &mut Vec<u8>) {
    if buffer.contains(&b'\r') {
        let mut write = 0usize;
        let mut read = 0usize;
        while read < buffer.len() {
            if buffer[read] == b'\r' && read + 1 < buffer.len() && buffer[read + 1] == b'\n' {
                buffer[write] = b'\n';
                write += 1;
                read += 2;
            } else {
                let byte = buffer[read];
                buffer[write] = byte;
                write += 1;
                read += 1;
            }
        }
        buffer.truncate(write);
    }
}

/// Find the byte offset of the first occurrence of `needle` in `haystack`.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// Extract the joined `data:` payload from one blank-line-delimited block.
/// Returns `None` when the block carries no `data:` lines or its payload is
/// empty. Only decodes UTF-8 here — the whole frame is a complete string by
/// construction, so a character split across chunks reassembles correctly.
fn extract_data_payload_bytes(block: &[u8]) -> Option<String> {
    let mut data: Vec<Vec<u8>> = Vec::new();
    for raw_line in block.split(|byte| *byte == b'\n') {
        let line = raw_line.strip_suffix(b"\r").unwrap_or(raw_line);
        if let Some(payload) = line.strip_prefix(b"data:") {
            let payload = trim_ascii_start(payload);
            if !payload.is_empty() {
                data.push(payload.to_vec());
            }
        }
    }
    if data.is_empty() {
        return None;
    }
    let joined = data.join(&b'\n');
    // A full frame is always valid UTF-8 when the provider sent valid UTF-8;
    // lossy decoding is a last-resort safety net, not a per-chunk corruption.
    Some(String::from_utf8_lossy(&joined).into_owned())
}

fn trim_ascii_start(bytes: &[u8]) -> &[u8] {
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    &bytes[start..]
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

    #[test]
    fn empty_data_frames_are_dropped() {
        let mut decoder = SseDecoder::new();
        // `data: ` with only whitespace (a common keepalive shape) and `data:`
        // with no value at all must not become empty payloads.
        let payloads = decoder.push(b"data: {\"a\":1}\n\ndata: \n\ndata:\n\ndata: {\"b\":2}\n\n");
        assert_eq!(payloads, vec!["{\"a\":1}", "{\"b\":2}"]);
        assert!(decoder.finish().is_empty());
        // The complete-stream parser agrees.
        assert_eq!(
            data_payloads(b"data: {\"a\":1}\n\ndata:  \n\n"),
            vec!["{\"a\":1}"]
        );
    }

    #[test]
    fn multibyte_utf8_split_across_chunks_is_preserved() {
        // "café" where the 2-byte é (0xC3 0xA9) is split across pushes; the
        // JSON text must survive lossless (no U+FFFD replacement chars).
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b"data: {\"text\":\"caf\xC3").is_empty());
        let payloads = decoder.push(b"\xA9\"}\n\ndata: {\"ok\":\xE2\x9C\x93}\n");
        assert_eq!(payloads, vec!["{\"text\":\"café\"}"]);
        assert_eq!(decoder.finish(), vec!["{\"ok\":\u{2713}}"]);

        // A 4-byte emoji (U+1F600) split across three chunks.
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b"data: {\"t\":\"\xF0\x9F").is_empty());
        assert!(decoder.push(b"\x98").is_empty());
        let payloads = decoder.push(b"\x80\"}\n\n");
        assert_eq!(payloads, vec!["{\"t\":\"\u{1F600}\"}"]);
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn crlf_split_across_chunks_is_normalized() {
        // The blank-line separator `\r\n\r\n` is split so `\r\n\r` ends one
        // chunk and `\n` starts the next; normalization must still split frames.
        let mut decoder = SseDecoder::new();
        assert!(decoder.push(b"data: {\"a\":1}\r\n\r").is_empty());
        let payloads = decoder.push(b"\ndata: {\"b\":2}\n\n");
        assert_eq!(payloads, vec!["{\"a\":1}", "{\"b\":2}"]);
        assert!(decoder.finish().is_empty());
    }
}
