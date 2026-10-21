import Foundation
import MarkdownUI

/// Splits Markdown into independently parseable chunks at blank-line block
/// boundaries, so a growing (streamed) document can reuse the parse of every
/// settled chunk and re-parse only the open tail.
///
/// A split is made only where CommonMark guarantees every open block has
/// closed: after a blank line outside a fenced code block, before a complete
/// line that starts at column 0 and cannot continue a list. Documents with
/// constructs whose meaning crosses blank lines (link reference or footnote
/// definitions, and HTML blocks that ignore blank lines) are never split.
enum AidenMarkdownBlockSplitter {
    struct Split: Equatable {
        var settled: [Substring]
        var tail: Substring
    }

    static func split(_ text: String) -> Split {
        guard allowsSplitting(text) else { return Split(settled: [], tail: text[...]) }
        let utf8 = text.utf8
        var settled: [Substring] = []
        var chunkStart = text.startIndex
        var lineStart = text.startIndex
        var previousLineWasBlank = false
        var openFence: Fence?

        while let newline = utf8[lineStart...].firstIndex(of: 0x0A) {
            var lineEnd = newline
            if lineEnd > lineStart, utf8[utf8.index(before: lineEnd)] == 0x0D {
                lineEnd = utf8.index(before: lineEnd)
            }
            let line = utf8[lineStart..<lineEnd]
            let isBlank = line.allSatisfy { $0 == 0x20 || $0 == 0x09 }

            if openFence == nil,
               previousLineWasBlank,
               lineStart > chunkStart,
               startsIndependentBlock(line) {
                settled.append(text[chunkStart..<lineStart])
                chunkStart = lineStart
            }

            if let fence = openFence {
                if fence.isClosed(by: line) { openFence = nil }
            } else {
                openFence = Fence(opening: line)
            }
            previousLineWasBlank = isBlank
            lineStart = utf8.index(after: newline)
        }
        return Split(settled: settled, tail: text[chunkStart...])
    }

    private static func allowsSplitting(_ text: String) -> Bool {
        // HTML block types 1-5 (comments, CDATA, declarations, processing
        // instructions, and raw pre/script/style/textarea) continue across
        // blank lines. Rare in model output, so any occurrence opts out.
        let lowered = text.lowercased()
        for marker in ["<!", "<?", "<pre", "<script", "<style", "<textarea"] where lowered.contains(marker) {
            return false
        }
        // Reference and footnote definitions apply to the whole document.
        var lineStart = text.utf8.startIndex
        let utf8 = text.utf8
        while lineStart < utf8.endIndex {
            let lineEnd = utf8[lineStart...].firstIndex(of: 0x0A) ?? utf8.endIndex
            if looksLikeDefinition(utf8[lineStart..<lineEnd]) { return false }
            lineStart = lineEnd == utf8.endIndex ? lineEnd : utf8.index(after: lineEnd)
        }
        return true
    }

    private static func looksLikeDefinition(_ line: Substring.UTF8View) -> Bool {
        var index = line.startIndex
        var indent = 0
        while index < line.endIndex, line[index] == 0x20, indent < 4 {
            indent += 1
            index = line.index(after: index)
        }
        guard indent <= 3, index < line.endIndex, line[index] == 0x5B /* [ */ else { return false }
        guard let close = line[index...].firstIndex(of: 0x5D /* ] */) else { return false }
        let afterClose = line.index(after: close)
        return afterClose < line.endIndex && line[afterClose] == 0x3A /* : */
    }

    /// True when a complete line, following a blank line, cannot belong to any
    /// block opened before that blank line.
    private static func startsIndependentBlock(_ line: Substring.UTF8View) -> Bool {
        guard let first = line.first, first != 0x20, first != 0x09 else { return false }
        return !startsListItem(line)
    }

    private static func startsListItem(_ line: Substring.UTF8View) -> Bool {
        var bytes = line.makeIterator()
        guard let first = bytes.next() else { return false }
        func isMarkerTerminator(_ byte: UInt8?) -> Bool {
            byte == nil || byte == 0x20 || byte == 0x09 || byte == 0x0D
        }
        if first == 0x2D || first == 0x2A || first == 0x2B { // - * +
            return isMarkerTerminator(bytes.next())
        }
        guard (0x30...0x39).contains(first) else { return false }
        var digits = 1
        while let byte = bytes.next() {
            if (0x30...0x39).contains(byte) {
                digits += 1
                if digits > 9 { return false }
                continue
            }
            guard byte == 0x2E || byte == 0x29 else { return false } // . )
            return isMarkerTerminator(bytes.next())
        }
        return false
    }

    fileprivate struct Fence {
        let marker: UInt8
        let length: Int

        /// Recognizes a fenced code opener: up to three spaces, then at least
        /// three backticks or tildes (a backtick info string has no backticks).
        init?(opening line: Substring.UTF8View) {
            guard let (marker, length, rest) = Self.run(in: line) else { return nil }
            if marker == 0x60, rest.contains(0x60) { return nil }
            self.marker = marker
            self.length = length
        }

        func isClosed(by line: Substring.UTF8View) -> Bool {
            guard let (marker, length, rest) = Self.run(in: line) else { return false }
            return marker == self.marker
                && length >= self.length
                && rest.allSatisfy { $0 == 0x20 || $0 == 0x09 }
        }

        private static func run(
            in line: Substring.UTF8View
        ) -> (marker: UInt8, length: Int, rest: Substring.UTF8View.SubSequence)? {
            var index = line.startIndex
            var indent = 0
            while index < line.endIndex, line[index] == 0x20 {
                indent += 1
                if indent > 3 { return nil }
                index = line.index(after: index)
            }
            guard index < line.endIndex else { return nil }
            let marker = line[index]
            guard marker == 0x60 || marker == 0x7E else { return nil } // ` ~
            var length = 0
            while index < line.endIndex, line[index] == marker {
                length += 1
                index = line.index(after: index)
            }
            guard length >= 3 else { return nil }
            return (marker, length, line[index...])
        }
    }
}

/// Parses Markdown for display, reusing the parsed blocks of settled chunks.
///
/// Streaming previously re-parsed the whole accumulated reply on every token
/// (quadratic in reply length). With chunk reuse, each update parses only the
/// open tail; settled transcript messages become dictionary lookups on
/// re-render. The cache is bounded by entry count and retained characters.
@MainActor
final class AidenMarkdownContentCache {
    static let shared = AidenMarkdownContentCache()

    private struct Entry {
        let content: MarkdownContent
        var lastAccess: UInt64
    }

    private let maximumEntries: Int
    private let maximumCharacters: Int
    private var entries: [String: Entry] = [:]
    private var retainedCharacters = 0
    private var accessClock: UInt64 = 0

    /// Characters handed to the Markdown parser, for measuring reuse.
    private(set) var parsedCharacterCount = 0

    init(maximumEntries: Int = 512, maximumCharacters: Int = 400_000) {
        self.maximumEntries = maximumEntries
        self.maximumCharacters = maximumCharacters
    }

    var entryCount: Int { entries.count }

    func content(for markdown: String) -> MarkdownContent {
        let split = AidenMarkdownBlockSplitter.split(markdown)
        guard !split.settled.isEmpty else { return parse(markdown) }
        var chunks = split.settled.map { cachedContent(for: String($0)) }
        if !split.tail.isEmpty {
            chunks.append(parse(String(split.tail)))
        }
        return MarkdownContent {
            for chunk in chunks { chunk }
        }
    }

    /// The reply as independently rendered chunks: every settled chunk (parse
    /// reused from the cache) followed by the open tail. A chunk keeps its
    /// index as it grows and seals, so a view keyed by index keeps its
    /// identity and only the tail's view sees new text while a reply streams.
    ///
    /// With `streaming`, the open tail is drawn through
    /// `AidenStreamingMarkdownTail.displayText`, so a half-received marker
    /// never flashes as raw syntax. Sealed chunks are never altered.
    func chunks(for markdown: String, streaming: Bool = false) -> [AidenMarkdownChunk] {
        let split = AidenMarkdownBlockSplitter.split(markdown)
        guard !split.settled.isEmpty else {
            let text = streaming ? AidenStreamingMarkdownTail.displayText(markdown) : markdown
            return [AidenMarkdownChunk(index: 0, text: text, content: parse(text), leadingGap: 0)]
        }
        var pieces = split.settled.map { (text: String($0), sealed: true) }
        if !split.tail.isEmpty {
            let tail = String(split.tail)
            pieces.append((streaming ? AidenStreamingMarkdownTail.displayText(tail) : tail, false))
        }
        var chunks: [AidenMarkdownChunk] = []
        chunks.reserveCapacity(pieces.count)
        for (index, piece) in pieces.enumerated() {
            let gap = index == 0
                ? 0
                : AidenMarkdownChunkSpacing.gap(after: pieces[index - 1].text, before: piece.text)
            chunks.append(AidenMarkdownChunk(
                index: index,
                text: piece.text,
                content: piece.sealed ? cachedContent(for: piece.text) : parse(piece.text),
                leadingGap: gap
            ))
        }
        return chunks
    }

    func removeAll() {
        entries.removeAll()
        retainedCharacters = 0
    }

    private func parse(_ markdown: String) -> MarkdownContent {
        parsedCharacterCount += markdown.utf8.count
        return MarkdownContent(markdown)
    }

    private func cachedContent(for chunk: String) -> MarkdownContent {
        accessClock &+= 1
        if var entry = entries[chunk] {
            entry.lastAccess = accessClock
            entries[chunk] = entry
            return entry.content
        }
        let content = parse(chunk)
        // A single chunk larger than the whole budget is parsed but not kept.
        guard chunk.utf8.count <= maximumCharacters else { return content }
        entries[chunk] = Entry(content: content, lastAccess: accessClock)
        retainedCharacters += chunk.utf8.count
        evictIfNeeded()
        return content
    }

    private func evictIfNeeded() {
        guard entries.count > maximumEntries || retainedCharacters > maximumCharacters else { return }
        // Evict least recently used chunks down to 3/4 of each budget so a
        // burst of new chunks does not rescan the table on every insert.
        let entryTarget = maximumEntries * 3 / 4
        let characterTarget = maximumCharacters * 3 / 4
        let oldestFirst = entries.sorted { $0.value.lastAccess < $1.value.lastAccess }
        for (key, _) in oldestFirst {
            guard entries.count > entryTarget || retainedCharacters > characterTarget else { break }
            entries.removeValue(forKey: key)
            retainedCharacters -= key.utf8.count
        }
    }
}

/// One independently parsed piece of a reply. `leadingGap` is the space the
/// single-document layout would put between this chunk and the previous one.
struct AidenMarkdownChunk {
    let index: Int
    let text: String
    let content: MarkdownContent
    let leadingGap: CGFloat
}

/// Which chunks of a streaming reply fade in. Only a chunk whose text starts
/// at or after the end of what the previous render showed is new: a block
/// usually seals only after its first line was already visible in the tail,
/// and that text must not flash when it moves into its own chunk. The first
/// render fades nothing.
enum AidenMarkdownChunkReveal {
    static func newChunkIndices(
        _ chunks: [AidenMarkdownChunk],
        previouslyRenderedUTF8Count previous: Int?
    ) -> Set<Int> {
        guard let previous else { return [] }
        var start = 0
        var indices: Set<Int> = []
        for chunk in chunks {
            if start >= previous { indices.insert(chunk.index) }
            start += chunk.text.utf8.count
        }
        return indices
    }
}

/// The gap between two rendered chunks, matching what MarkdownUI's block
/// sequence would draw between the same blocks in one document: the larger of
/// the previous block's bottom margin and the next block's top margin, where a
/// block's margin is the largest of the blocks it contains. Values mirror the
/// chat theme, MarkdownUI's GitHub theme: every block but a thematic break
/// ends with a 16pt margin. The chat view's paragraph style sits outside
/// `.markdownTheme`, so the theme's 16pt paragraph margin is the one drawn.
enum AidenMarkdownChunkSpacing {
    static let paragraphBottom: CGFloat = 16
    static let blockBottom: CGFloat = 16
    static let headingTop: CGFloat = 24
    static let thematicBreak: CGFloat = 24

    static func gap(after previous: String, before next: String) -> CGFloat {
        max(bottomMargin(ofLastBlockIn: previous), topMargin(ofFirstBlockIn: next))
    }

    static func topMargin(ofFirstBlockIn chunk: String) -> CGFloat {
        let lines = nonBlankLeadingLines(of: chunk)
        guard let first = lines.first else { return 0 }
        if isThematicBreak(first) || isATXHeading(first) { return headingTop }
        // Don't treat a line as a Setext underline if the first line opens a
        // fenced code block (e.g., ```yaml\n--- should not be a heading).
        if lines.count > 1, AidenMarkdownBlockSplitter.Fence(opening: lines[0].utf8) == nil,
           isSetextUnderline(lines[1]) { return headingTop }
        if first.hasPrefix(">") {
            for line in lines where line.hasPrefix(">") {
                let quoted = stripQuoteMarkers(line)
                if isATXHeading(quoted) || isThematicBreak(quoted) { return headingTop }
            }
        }
        return 0
    }

    static func bottomMargin(ofLastBlockIn chunk: String) -> CGFloat {
        let lines = chunk.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.hasSuffix("\r") ? $0.dropLast() : $0 }
        guard let lastIndex = lines.lastIndex(where: { !isBlank($0) }) else { return 0 }
        // The last top-level block starts at the latest unindented line that
        // follows a blank line (or the chunk start).
        var start = lastIndex
        while start > 0 {
            let line = lines[start]
            if !isBlank(line), !line.hasPrefix(" "), !line.hasPrefix("\t"), isBlank(lines[start - 1]) { break }
            start -= 1
        }
        let block = lines[start...lastIndex].filter { !isBlank($0) }
        if block.count == 1 {
            let line = block[0]
            if isThematicBreak(line) { return thematicBreak }
            // Quoted thematic breaks inherit the child's margin (24pt), not the
            // block default (16pt), like topMargin does for quoted blocks.
            if line.hasPrefix(">") {
                let quoted = stripQuoteMarkers(line)
                if isThematicBreak(quoted) { return thematicBreak }
            }
        }
        return blockBottom
    }

    private static func nonBlankLeadingLines(of chunk: String) -> [Substring] {
        var result: [Substring] = []
        for line in chunk.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.hasSuffix("\r") ? line.dropLast() : line
            if isBlank(trimmed) { break }
            result.append(trimmed)
        }
        return result
    }

    private static func isBlank(_ line: Substring) -> Bool {
        line.allSatisfy { $0 == " " || $0 == "\t" }
    }

    private static func stripQuoteMarkers(_ line: Substring) -> Substring {
        var rest = line.drop { $0 == " " }
        while rest.hasPrefix(">") {
            rest = rest.dropFirst().drop { $0 == " " }
        }
        return rest
    }

    private static func isATXHeading(_ line: Substring) -> Bool {
        let content = line.drop { $0 == " " }
        guard line.count - content.count <= 3 else { return false }
        let hashes = content.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return false }
        let after = content.dropFirst(hashes)
        return after.isEmpty || after.first == " " || after.first == "\t"
    }

    private static func isThematicBreak(_ line: Substring) -> Bool {
        let content = line.filter { $0 != " " && $0 != "\t" }
        guard content.count >= 3, let marker = content.first, "-*_".contains(marker) else { return false }
        return content.allSatisfy { $0 == marker } && line.prefix { $0 == " " }.count <= 3
    }

    private static func isSetextUnderline(_ line: Substring) -> Bool {
        let content = line.drop { $0 == " " }
        guard line.count - content.count <= 3, let marker = content.first, marker == "=" || marker == "-" else {
            return false
        }
        let run = content.prefix { $0 == marker }
        return content.dropFirst(run.count).allSatisfy { $0 == " " || $0 == "\t" }
    }
}

/// Display-only repair of a streaming reply's open tail, so Markdown that has
/// only half arrived never flashes as raw syntax and then snaps into place:
///
/// - A last, unfinished line that is only a block marker (`-`, `1.`, `#`,
///   `>`, `|`, `---`) is hidden until its content arrives. Under a paragraph
///   a lone `-` or `=` would otherwise turn that paragraph into a heading for
///   a tick.
/// - A link whose destination is still arriving (`[label](https://exa`)
///   shows as its label.
/// - Inline code, `**strong**`, `*emphasis*` and `~~strike~~` opened on the
///   line being written are closed, or dropped when nothing follows them
///   yet. Spans may still close on a later line of the same block (not in a
///   new heading, list item or quote); an opener left unmatched on a
///   finished line is literal and drawn as written.
///
/// Only the last paragraph is examined, and nothing inside an open fenced
/// code block, an indented code line or an inline code span changes (CommonMark already draws it as code). `_` emphasis is
/// left alone because intraword underscores (`snake_case`) are not emphasis.
/// The settled reply is always drawn from the real text.
enum AidenStreamingMarkdownTail {
    static func displayText(_ tail: String) -> String {
        guard !tail.isEmpty else { return tail }
        let lines = tail.split(separator: "\n", omittingEmptySubsequences: false)
        var openFence: AidenMarkdownBlockSplitter.Fence?
        var paragraphStart = 0
        for (index, rawLine) in lines.enumerated() {
            let line = rawLine.hasSuffix("\r") ? rawLine.dropLast() : rawLine
            if let fence = openFence {
                if fence.isClosed(by: line.utf8) {
                    openFence = nil
                    paragraphStart = index + 1
                }
                continue
            }
            if let fence = AidenMarkdownBlockSplitter.Fence(opening: line.utf8) {
                openFence = fence
                continue
            }
            if line.allSatisfy({ $0 == " " || $0 == "\t" }) { paragraphStart = index + 1 }
        }
        guard openFence == nil else { return tail }
        // Four spaces or a tab may start an indented code block (or continue
        // a list item); its text is literal, so leave it as written.
        if let last = lines.last, last.hasPrefix("    ") || last.hasPrefix("\t") { return tail }

        var lineCount = lines.count
        if let last = lines.last, isLoneBlockMarker(last) {
            lineCount -= 1
        }
        guard paragraphStart < lineCount else {
            let kept = lines[..<lineCount].joined(separator: "\n")
            return lineCount < lines.count && lineCount > 0 ? kept + "\n" : kept
        }
        let prefix = lines[..<paragraphStart].map { $0 + "\n" }.joined()
        let paragraph = lines[paragraphStart..<lineCount].joined(separator: "\n")
        let repaired = repairInline(paragraph)
        let droppedLine = lineCount < lines.count
        return prefix + repaired + (droppedLine && !repaired.isEmpty ? "\n" : "")
    }

    /// An unfinished line holding only a block marker and spaces.
    static func isLoneBlockMarker(_ line: Substring) -> Bool {
        let content = line.filter { $0 != " " && $0 != "\t" && $0 != "\r" }
        guard !content.isEmpty else { return false }
        if content.allSatisfy({ "-=*_#>+|~`".contains($0) }) { return true }
        // An ordered-list marker: up to nine digits, then `.` or `)`.
        guard let last = content.last, last == "." || last == ")" else { return false }
        let digits = content.dropLast()
        return !digits.isEmpty && digits.count <= 9 && digits.allSatisfy(\.isASCII) && digits.allSatisfy(\.isNumber)
    }

    private enum Marker: Equatable {
        case code(Int)
        case strong
        case emphasis
        case strike

        var text: String {
            switch self {
            case .code(let length): return String(repeating: "`", count: length)
            case .strong: return "**"
            case .emphasis: return "*"
            case .strike: return "~~"
            }
        }
    }

    private static func repairInline(_ paragraph: String) -> String {
        var text = Array(paragraph)
        if let label = openLinkLabel(in: text) {
            text = Array(text[..<label.start]) + Array(label.text)
        }
        // Open markers, innermost last, with the offset each one starts at.
        var open: [(marker: Marker, offset: Int)] = []
        var index = 0
        var lineStart = true
        var currentLineStart = 0
        while index < text.count {
            let character = text[index]
            if character == "\n" {
                // Spans may close on a later line of the same block, so `open`
                // carries over, but never into a new heading or list item.
                if isBlockBoundary(text, lineStart: currentLineStart, newline: index) { open.removeAll() }
                lineStart = true
                index += 1
                currentLineStart = index
                continue
            }
            if case .code(let length)? = open.last?.marker {
                if character == "`" {
                    let run = runLength(of: "`", in: text, from: index)
                    if run == length { open.removeLast() }
                    index += run
                } else {
                    index += 1
                }
                lineStart = false
                continue
            }
            switch character {
            case "\\":
                index += 2
            case "`":
                let run = runLength(of: "`", in: text, from: index)
                open.append((.code(run), index))
                index += run
            case "*":
                let run = runLength(of: "*", in: text, from: index)
                let next = index + run < text.count ? text[index + run] : nil
                if lineStart, run == 1, next == " " || next == "\t" {
                    // A bullet, not emphasis.
                    index += run
                    break
                }
                let previous = index > 0 ? text[index - 1] : nil
                if run >= 2 { toggle(.strong, at: index, previous: previous, next: next, in: &open) }
                if run == 1 || run >= 3 {
                    toggle(.emphasis, at: run >= 3 ? index + 2 : index, previous: previous, next: next, in: &open)
                }
                index += run
            case "~":
                let run = runLength(of: "~", in: text, from: index)
                if run == 2 {
                    let previous = index > 0 ? text[index - 1] : nil
                    let next = index + run < text.count ? text[index + run] : nil
                    toggle(.strike, at: index, previous: previous, next: next, in: &open)
                }
                index += run
            default:
                index += 1
            }
            if character != " " && character != "\t" { lineStart = false }
        }
        // Only the line being written is repaired. An opener left unmatched on
        // a finished line is literal text and stays as written; openers are
        // stacked in order, so those are the ones left once the last line's
        // are handled.
        let lastLineStart = (text.lastIndex(of: "\n") ?? -1) + 1
        var closers = ""
        while let entry = open.popLast(), entry.offset >= lastLineStart {
            let marker = entry.marker
            let offset = entry.offset
            let rest = text[(offset + marker.text.count)...]
            if rest.allSatisfy(\.isWhitespace) {
                // Nothing follows the opener yet: hide it.
                text.removeSubrange(offset...)
            } else {
                closers += marker.text
            }
        }
        guard !closers.isEmpty else { return String(text) }
        while let last = text.last, last.isWhitespace { text.removeLast() }
        return String(text) + closers
    }

    /// Opens a marker, or closes the innermost matching one. A closer must
    /// follow non-whitespace; an opener must precede non-whitespace (or the
    /// end, where it is hidden).
    private static func toggle(
        _ marker: Marker,
        at offset: Int,
        previous: Character?,
        next: Character?,
        in open: inout [(marker: Marker, offset: Int)]
    ) {
        if let match = open.lastIndex(where: { $0.marker == marker }),
           let previous, !previous.isWhitespace {
            open.removeSubrange(match...)
            return
        }
        if next == nil || next?.isWhitespace == false {
            open.append((marker, offset))
        }
    }

    /// Whether `index` falls inside an inline code span (open or closed). A
    /// span opens and closes with backtick runs of equal length.
    private static func isInsideCodeSpan(_ text: [Character], at index: Int) -> Bool {
        var openRun: Int?
        var position = 0
        var lineStart = 0
        while position < index {
            if text[position] == "\n" {
                if isBlockBoundary(text, lineStart: lineStart, newline: position) { openRun = nil }
                position += 1
                lineStart = position
                continue
            }
            guard text[position] == "`" else {
                position += 1
                continue
            }
            let run = runLength(of: "`", in: text, from: position)
            if openRun == nil {
                openRun = run
            } else if openRun == run {
                openRun = nil
            }
            position += run
        }
        return openRun != nil
    }

    /// Whether the newline at `newline` ends a block: the line before it (from
    /// `lineStart`) is a heading, or the line after it starts a heading, list
    /// item or block quote. Inline spans never continue across it.
    private static func isBlockBoundary(_ text: [Character], lineStart: Int, newline: Int) -> Bool {
        startsHeading(text, at: lineStart) || startsBlock(text, at: newline + 1)
    }

    /// The position after up to three leading spaces, or nil when the line is
    /// indented further (indented code or a list continuation).
    private static func contentStart(_ text: [Character], at start: Int) -> Int? {
        var position = start
        while position < text.count, text[position] == " ", position - start < 4 { position += 1 }
        return position - start < 4 ? position : nil
    }

    private static func isSpaceOrLineEnd(_ text: [Character], at position: Int) -> Bool {
        position >= text.count || text[position] == " " || text[position] == "\t" || text[position] == "\n"
    }

    /// An ATX heading: one to six `#`, then a space or the line's end.
    private static func startsHeading(_ text: [Character], at start: Int) -> Bool {
        guard let position = contentStart(text, at: start) else { return false }
        let run = runLength(of: "#", in: text, from: position)
        return (1...6).contains(run) && isSpaceOrLineEnd(text, at: position + run)
    }

    /// A heading, a bullet or ordered list item, or a block quote.
    private static func startsBlock(_ text: [Character], at start: Int) -> Bool {
        guard let position = contentStart(text, at: start), position < text.count else { return false }
        if startsHeading(text, at: start) || text[position] == ">" { return true }
        if "-*+".contains(text[position]) { return isSpaceOrLineEnd(text, at: position + 1) }
        var end = position
        while end < text.count, end - position < 9, text[end].isASCII, text[end].isNumber { end += 1 }
        guard end > position, end < text.count, text[end] == "." || text[end] == ")" else { return false }
        return isSpaceOrLineEnd(text, at: end + 1)
    }

    private static func runLength(of character: Character, in text: [Character], from start: Int) -> Int {
        var end = start
        while end < text.count, text[end] == character { end += 1 }
        return end - start
    }

    /// `[label](destination` with no closing `)` yet, outside inline code:
    /// where the link starts and what to show for it (its label; nothing for
    /// an image).
    private static func openLinkLabel(in text: [Character]) -> (start: Int, text: String)? {
        guard let open = text.lastIndex(of: "["),
              let close = text[open...].firstIndex(of: "]"),
              close + 1 < text.count, text[close + 1] == "(",
              !text[(close + 1)...].contains(")") else { return nil }
        guard !isInsideCodeSpan(text, at: open) else { return nil }
        if open > 0, text[open - 1] == "!" { return (open - 1, "") }
        return (open, String(text[(open + 1)..<close]))
    }
}
