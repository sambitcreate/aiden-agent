use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiffTone {
    Context,
    Addition,
    Deletion,
    Hunk,
    Header,
    Meta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DiffLine {
    pub old: Option<u32>,
    pub new: Option<u32>,
    pub text: String,
    pub tone: DiffTone,
}

pub(crate) fn parse_patch(patch: &str, limit: usize) -> Arc<Vec<DiffLine>> {
    let mut old = 0u32;
    let mut new = 0u32;
    let mut lines = Vec::new();
    for raw in patch.lines().take(limit) {
        let tone = if raw.starts_with("@@") {
            if let Some((next_old, next_new)) = parse_hunk_header(raw) {
                old = next_old;
                new = next_new;
            }
            DiffTone::Hunk
        } else if raw.starts_with("+++") || raw.starts_with("---") || raw.starts_with("diff ") {
            DiffTone::Header
        } else if is_meta_line(raw) {
            DiffTone::Meta
        } else if raw.starts_with('+') {
            DiffTone::Addition
        } else if raw.starts_with('-') {
            DiffTone::Deletion
        } else {
            DiffTone::Context
        };
        let (old_line, new_line) = match tone {
            DiffTone::Addition => {
                let line = new;
                new = new.saturating_add(1);
                (None, Some(line))
            }
            DiffTone::Deletion => {
                let line = old;
                old = old.saturating_add(1);
                (Some(line), None)
            }
            DiffTone::Context if !raw.starts_with('\\') => {
                let pair = (Some(old), Some(new));
                old = old.saturating_add(1);
                new = new.saturating_add(1);
                pair
            }
            _ => (None, None),
        };
        lines.push(DiffLine {
            old: old_line,
            new: new_line,
            text: raw.to_string(),
            tone,
        });
    }
    Arc::new(lines)
}

fn parse_hunk_header(line: &str) -> Option<(u32, u32)> {
    let mut parts = line.split_whitespace();
    parts.next()?;
    let old = parts
        .next()?
        .trim_start_matches('-')
        .split(',')
        .next()?
        .parse()
        .ok()?;
    let new = parts
        .next()?
        .trim_start_matches('+')
        .split(',')
        .next()?
        .parse()
        .ok()?;
    Some((old, new))
}

fn is_meta_line(line: &str) -> bool {
    line.starts_with("index ")
        || line.starts_with("new file mode ")
        || line.starts_with("deleted file mode ")
        || line.starts_with("old mode ")
        || line.starts_with("new mode ")
        || line.starts_with("rename from ")
        || line.starts_with("rename to ")
        || line.starts_with("similarity index ")
        || line.starts_with("dissimilarity index ")
        || line.starts_with("Binary files ")
        || line.starts_with("Binary file ")
        || line.starts_with("\\ No newline at end of file")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_is_parsed_once_into_bounded_numbered_lines() {
        let lines = parse_patch("@@ -2,2 +2,2 @@\n-old\n+new\n same\n", 3);
        assert_eq!(lines.len(), 3);
        assert_eq!((lines[1].old, lines[1].new), (Some(2), None));
        assert_eq!((lines[2].old, lines[2].new), (None, Some(2)));
    }

    #[test]
    fn metadata_never_advances_line_numbers_and_zero_count_hunks_work() {
        let patch = "index 123..456 100644\nnew file mode 100644\n@@ -0,0 +1,1 @@\n+hello\n\\ No newline at end of file\n";
        let lines = parse_patch(patch, 10);
        assert_eq!(lines[0].tone, DiffTone::Meta);
        assert_eq!(lines[1].tone, DiffTone::Meta);
        assert_eq!((lines[3].old, lines[3].new), (None, Some(1)));
        assert_eq!((lines[4].old, lines[4].new), (None, None));
    }
}
