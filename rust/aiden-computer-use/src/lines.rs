//! Newline-delimited MCP framing (port of the broker's `lines.rs` plus the
//! byte-bounded decoder logic from `main/services/computer-use/session.ts`).

use std::io::{self, BufRead, BufReader, Read, Write};

/// Synchronous bounded line reader — byte-for-byte mirror of the broker's
/// `BoundedLines`, which is what both the broker guard and the bridge relay
/// use on their sockets. Kept here so the client-side framing and the mock
/// broker share one implementation with the native protocol.
pub struct BoundedLines<R> {
    reader: BufReader<R>,
    buffered: Vec<u8>,
}

impl<R: Read> BoundedLines<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            buffered: Vec::new(),
        }
    }

    pub fn next(&mut self, maximum: usize) -> io::Result<Option<Vec<u8>>> {
        self.buffered.clear();
        loop {
            let available = self.reader.fill_buf()?;
            if available.is_empty() {
                return if self.buffered.is_empty() {
                    Ok(None)
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unterminated line",
                    ))
                };
            }
            let newline = available.iter().position(|byte| *byte == b'\n');
            let take = newline.unwrap_or(available.len());
            if self.buffered.len().saturating_add(take) > maximum {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "line exceeds size limit",
                ));
            }
            self.buffered.extend_from_slice(&available[..take]);
            self.reader.consume(take + usize::from(newline.is_some()));
            if newline.is_some() {
                if self.buffered.last() == Some(&b'\r') {
                    self.buffered.pop();
                }
                return Ok(Some(std::mem::take(&mut self.buffered)));
            }
        }
    }
}

/// Write a complete line (the caller supplies any trailing newline) and flush.
pub fn write_line(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    writer.write_all(bytes)?;
    writer.flush()
}

/// Extract one newline-delimited frame from a chunk buffer, returning the
/// frame (with the trailing `\r`, if any, stripped) and the remaining bytes.
/// Used by the async reader in `session.rs` and by framing tests.
pub fn decode_frame(input: &[u8]) -> Option<(&[u8], &[u8])> {
    let newline = input.iter().position(|byte| *byte == b'\n')?;
    let mut frame = &input[..newline];
    if frame.last() == Some(&b'\r') {
        frame = &frame[..frame.len() - 1];
    }
    Some((frame, &input[newline + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn reads_crlf_without_retaining_line_endings() {
        let mut lines = BoundedLines::new(Cursor::new(b"one\r\ntwo\n"));
        assert_eq!(lines.next(10).unwrap(), Some(b"one".to_vec()));
        assert_eq!(lines.next(10).unwrap(), Some(b"two".to_vec()));
        assert_eq!(lines.next(10).unwrap(), None);
    }

    #[test]
    fn rejects_oversize_and_unterminated_lines() {
        let mut oversized = BoundedLines::new(Cursor::new(b"12345\n"));
        assert_eq!(
            oversized.next(4).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let mut unterminated = BoundedLines::new(Cursor::new(b"partial"));
        assert_eq!(
            unterminated.next(20).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn decode_frame_splits_and_strips_cr() {
        assert_eq!(
            decode_frame(b"one\r\ntwo\n"),
            Some((&b"one"[..], &b"two\n"[..]))
        );
        assert_eq!(decode_frame(b"three"), None);
    }
}
