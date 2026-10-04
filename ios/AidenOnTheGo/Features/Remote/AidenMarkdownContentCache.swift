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

    private struct Fence {
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
