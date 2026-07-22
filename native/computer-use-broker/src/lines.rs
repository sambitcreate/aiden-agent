use std::io::{self, BufRead, BufReader, Read, Write};

pub(crate) struct BoundedLines<R> {
    reader: BufReader<R>,
    buffered: Vec<u8>,
}

impl<R: Read> BoundedLines<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            buffered: Vec::new(),
        }
    }

    pub(crate) fn next(&mut self, maximum: usize) -> io::Result<Option<Vec<u8>>> {
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
                return Ok(Some(self.buffered.clone()));
            }
        }
    }
}

pub(crate) fn write_line(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    writer.write_all(bytes)?;
    writer.flush()
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
}
