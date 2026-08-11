//! Markdown compatibility helpers shared by the main transcript and the
//! proactive-assistant thread.
//!
//! Electron's renderer enables `remarkMath` and `rehypeKatex`, so `$...$` and
//! `$$...$$` become KaTeX output. `gpui-component` 0.5.1 currently parses
//! CommonMark/GFM with math constructs disabled and has no KaTeX/MathJax
//! renderer. Until the native renderer grows that capability, keep formulas
//! readable and source-preserving instead of silently dropping delimiters or
//! pretending that monospace source is rendered mathematics.

/// Keep fallback work bounded for pathological model output. A formula longer
/// than this remains untouched source text; it is still truthful, while the
/// fallback never spends unbounded effort finding a matching delimiter or
/// building a large fence wrapper.
const MAX_MATH_FALLBACK_BYTES: usize = 16 * 1024;

/// Convert supported math spans into a source-preserving GPUI fallback.
///
/// Inline math is wrapped in a Markdown code span, while display math is
/// wrapped in a fenced `math` code block. The original `$` delimiters remain
/// inside both wrappers, so copy/paste and streaming recovery retain exactly
/// what the model emitted. Fenced/inline code, escaped dollars, unterminated
/// expressions, and oversized expressions are left unchanged.
pub(crate) fn markdown_with_math_fallback(markdown: &str) -> String {
    let mut output = String::with_capacity(markdown.len());
    let mut cursor = 0;

    while cursor < markdown.len() {
        if let Some(end) = fenced_code_end(markdown, cursor) {
            output.push_str(&markdown[cursor..end]);
            cursor = end;
            continue;
        }

        if markdown.as_bytes()[cursor] == b'`' {
            if let Some(end) = inline_code_end(markdown, cursor) {
                output.push_str(&markdown[cursor..end]);
                cursor = end;
                continue;
            }
        }

        if markdown.as_bytes()[cursor] == b'$' && !is_escaped(markdown.as_bytes(), cursor) {
            if let Some(span) = math_span(markdown, cursor) {
                let source = &markdown[span.start..span.end];
                if source.len() <= MAX_MATH_FALLBACK_BYTES {
                    if span.display {
                        append_display_fallback(&mut output, source);
                    } else {
                        append_inline_fallback(&mut output, source);
                    }
                    cursor = span.end;
                    continue;
                }
            }
        }

        let character = markdown[cursor..]
            .chars()
            .next()
            .expect("cursor always points at a UTF-8 boundary");
        output.push(character);
        cursor += character.len_utf8();
    }

    output
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MathSpan {
    start: usize,
    end: usize,
    display: bool,
}

fn math_span(markdown: &str, start: usize) -> Option<MathSpan> {
    let bytes = markdown.as_bytes();
    let marker_len = dollar_run(bytes, start);
    if marker_len == 0 {
        return None;
    }

    // A two-dollar run beginning on a Markdown line is the flow-math shape
    // emitted by remarkMath. It may contain text on its opening line, but its
    // closing run must be the only non-whitespace content on its line.
    if marker_len >= 2 && line_prefix_is_spaces(bytes, start, 3) {
        if let Some(end) = display_math_end(markdown, start, marker_len) {
            return Some(MathSpan {
                start,
                end,
                display: true,
            });
        }
    }

    let body_start = start + marker_len;
    let end = inline_math_end(markdown, body_start, marker_len)?;
    Some(MathSpan {
        start,
        end,
        display: false,
    })
}

fn display_math_end(markdown: &str, start: usize, marker_len: usize) -> Option<usize> {
    let bytes = markdown.as_bytes();
    let mut cursor = start + marker_len;
    while cursor < bytes.len() {
        if cursor.saturating_sub(start + marker_len) > MAX_MATH_FALLBACK_BYTES {
            return None;
        }
        if bytes[cursor] == b'$'
            && !is_escaped(bytes, cursor)
            && dollar_run(bytes, cursor) == marker_len
            && line_prefix_is_spaces(bytes, cursor, 3)
        {
            let after = cursor + marker_len;
            let line_end = markdown[after..]
                .find('\n')
                .map_or(bytes.len(), |offset| after + offset);
            if markdown[after..line_end]
                .bytes()
                .all(|byte| byte == b' ' || byte == b'\t' || byte == b'\r')
            {
                let end = if line_end < bytes.len() {
                    line_end + 1
                } else {
                    line_end
                };
                let body = &markdown[start + marker_len..cursor];
                if !body.is_empty() && body.contains('\n') {
                    return Some(end);
                }
            }
        }
        cursor += markdown[cursor..]
            .chars()
            .next()
            .expect("cursor always points at a UTF-8 boundary")
            .len_utf8();
    }
    None
}

fn inline_math_end(markdown: &str, body_start: usize, marker_len: usize) -> Option<usize> {
    let bytes = markdown.as_bytes();
    let mut cursor = body_start;
    while cursor < bytes.len() {
        if cursor.saturating_sub(body_start) > MAX_MATH_FALLBACK_BYTES {
            return None;
        }
        if bytes[cursor] == b'\n' {
            return None;
        }
        if bytes[cursor] == b'$'
            && !is_escaped(bytes, cursor)
            && dollar_run(bytes, cursor) == marker_len
            && cursor > body_start
        {
            return Some(cursor + marker_len);
        }
        cursor += markdown[cursor..]
            .chars()
            .next()
            .expect("cursor always points at a UTF-8 boundary")
            .len_utf8();
    }
    None
}

fn append_inline_fallback(output: &mut String, source: &str) {
    let ticks = "`".repeat(max_backtick_run(source).saturating_add(1));
    output.push_str(&ticks);
    output.push_str(source);
    output.push_str(&ticks);
}

fn append_display_fallback(output: &mut String, source: &str) {
    let fence = "`".repeat(3.max(max_backtick_run(source).saturating_add(1)));
    output.push_str(&fence);
    output.push_str("math\n");
    output.push_str(source);
    if !source.ends_with('\n') {
        output.push('\n');
    }
    output.push_str(&fence);
    if source.ends_with('\n') {
        output.push('\n');
    }
}

fn max_backtick_run(value: &str) -> usize {
    let mut max_run = 0;
    let mut run = 0;
    for byte in value.bytes() {
        if byte == b'`' {
            run += 1;
            max_run = max_run.max(run);
        } else {
            run = 0;
        }
    }
    max_run
}

fn dollar_run(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .take_while(|&&byte| byte == b'$')
        .count()
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let mut backslashes = 0;
    let mut cursor = index;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        backslashes += 1;
        cursor -= 1;
    }
    backslashes % 2 == 1
}

fn line_prefix_is_spaces(bytes: &[u8], index: usize, maximum: usize) -> bool {
    let line_start = bytes[..index]
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map_or(0, |position| position + 1);
    let prefix = &bytes[line_start..index];
    prefix.len() <= maximum && prefix.iter().all(|&byte| byte == b' ')
}

fn fenced_code_end(markdown: &str, start: usize) -> Option<usize> {
    let bytes = markdown.as_bytes();
    if !line_prefix_is_spaces(bytes, start, 3) {
        return None;
    }
    let marker = *bytes.get(start)?;
    if marker != b'`' && marker != b'~' {
        return None;
    }
    let marker_len = bytes[start..]
        .iter()
        .take_while(|&&byte| byte == marker)
        .count();
    if marker_len < 3 {
        return None;
    }

    let mut line_start = line_end(markdown, start);
    while line_start < bytes.len() {
        let first = line_start
            + bytes[line_start..]
                .iter()
                .take_while(|&&byte| byte == b' ')
                .count();
        let available = bytes.len().saturating_sub(first);
        let run = bytes[first..]
            .iter()
            .take_while(|&&byte| byte == marker)
            .count();
        if first - line_start <= 3 && available > 0 && run >= marker_len {
            let after = first + run;
            let end = line_end(markdown, first);
            if markdown[after..end]
                .bytes()
                .all(|byte| byte == b' ' || byte == b'\t' || byte == b'\r')
            {
                return Some(if end < bytes.len() { end + 1 } else { end });
            }
        }
        line_start = if line_end(markdown, line_start) < bytes.len() {
            line_end(markdown, line_start) + 1
        } else {
            bytes.len()
        };
    }

    // An unmatched fence owns the rest of the Markdown document.
    Some(bytes.len())
}

fn inline_code_end(markdown: &str, start: usize) -> Option<usize> {
    let bytes = markdown.as_bytes();
    let marker_len = bytes[start..]
        .iter()
        .take_while(|&&byte| byte == b'`')
        .count();
    if marker_len == 0 || marker_len >= 3 && line_prefix_is_spaces(bytes, start, 3) {
        return None;
    }

    let mut cursor = start + marker_len;
    while cursor < bytes.len() {
        if bytes[cursor] == b'\n' {
            return None;
        }
        if bytes[cursor] == b'`' && !is_escaped(bytes, cursor) {
            let run = bytes[cursor..]
                .iter()
                .take_while(|&&byte| byte == b'`')
                .count();
            if run == marker_len {
                return Some(cursor + run);
            }
            cursor += run.max(1);
        } else {
            cursor += markdown[cursor..]
                .chars()
                .next()
                .expect("cursor always points at a UTF-8 boundary")
                .len_utf8();
        }
    }
    None
}

fn line_end(markdown: &str, start: usize) -> usize {
    markdown[start..]
        .find('\n')
        .map_or(markdown.len(), |offset| start + offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_math_is_source_preserving_code_fallback() {
        assert_eq!(
            markdown_with_math_fallback("The answer is $x^2 + y^2$."),
            "The answer is `$x^2 + y^2$`."
        );
    }

    #[test]
    fn display_math_is_a_labeled_source_preserving_block() {
        assert_eq!(
            markdown_with_math_fallback("Before\n$$\nx^2 + y^2\n$$\nAfter"),
            "Before\n```math\n$$\nx^2 + y^2\n$$\n```\nAfter"
        );
    }

    #[test]
    fn math_inside_code_and_escaped_dollars_are_untouched() {
        let markdown = "`$inline$`\n```md\n$block$\n```\nEscaped \\$x\\$";
        assert_eq!(markdown_with_math_fallback(markdown), markdown);
    }

    #[test]
    fn unterminated_and_oversized_math_are_left_as_truthful_source() {
        assert_eq!(markdown_with_math_fallback("open $x + 1"), "open $x + 1");
        let oversized = format!("${}$", "x".repeat(MAX_MATH_FALLBACK_BYTES));
        assert_eq!(markdown_with_math_fallback(&oversized), oversized);
    }

    #[test]
    fn fallback_fences_grow_past_backticks_in_the_formula() {
        let markdown = "$$\na ``` b\n$$";
        assert_eq!(
            markdown_with_math_fallback(markdown),
            "````math\n$$\na ``` b\n$$\n````"
        );
    }
}
