import Foundation

/// Incremental `multipart/x-mixed-replace` parser for serve-sim's MJPEG
/// stream. Feed arbitrary chunks; it returns each complete part body once.
/// A part's `Content-Length` is honoured (the JPEG may contain the boundary
/// bytes); without one, the part ends at the next `\r\n--<boundary>`.
struct AidenMJPEGMultipartParser {
    enum Failure: Error, Equatable {
        case partTooLarge
        case malformedHeaders
    }

    static let defaultBoundary = "frame"
    static let maximumPartBytes = 8 * 1_048_576
    private static let maximumHeaderBytes = 16 * 1_024

    private enum State {
        case seekingBoundary
        case delimiterLine
        case headers(contentLength: Int?)
        case body(contentLength: Int?)
        case closed
    }

    private let delimiter: [UInt8]
    private let bodyTerminator: [UInt8]
    private var buffer: [UInt8] = []
    private var state = State.seekingBoundary
    /// Where the next unlengthed terminator search resumes.
    private var scanFrom = 0

    init(boundary: String = Self.defaultBoundary) {
        delimiter = Array("--\(boundary)".utf8)
        bodyTerminator = Array("\r\n--\(boundary)".utf8)
    }

    /// The boundary named by a `Content-Type` header, or `frame`.
    static func boundary(fromContentType contentType: String?) -> String {
        guard let contentType else { return defaultBoundary }
        for parameter in contentType.split(separator: ";").dropFirst() {
            let pair = parameter.split(separator: "=", maxSplits: 1)
            guard pair.count == 2,
                  pair[0].trimmingCharacters(in: .whitespaces).lowercased() == "boundary" else { continue }
            var value = pair[1].trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            if value.hasPrefix("--") { value = String(value.dropFirst(2)) }
            if !value.isEmpty, value.utf8.count <= 70 { return value }
        }
        return defaultBoundary
    }

    mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(contentsOf: chunk)
        var frames: [Data] = []
        var offset = 0
        defer {
            if offset > 0 {
                buffer.removeFirst(offset)
                scanFrom = max(0, scanFrom - offset)
            }
        }
        while true {
            switch state {
            case .closed:
                offset = buffer.count
                return frames
            case .seekingBoundary:
                guard let found = Self.search(delimiter, in: buffer, from: offset) else {
                    // Keep only a possible partial delimiter.
                    offset = max(offset, buffer.count - (delimiter.count - 1))
                    return frames
                }
                offset = found + delimiter.count
                state = .delimiterLine
            case .delimiterLine:
                guard buffer.count - offset >= 2 else { return frames }
                if buffer[offset] == 45, buffer[offset + 1] == 45 {
                    state = .closed
                    continue
                }
                guard let lineEnd = Self.search([13, 10], in: buffer, from: offset) else {
                    guard buffer.count - offset <= Self.maximumHeaderBytes else { throw Failure.malformedHeaders }
                    return frames
                }
                offset = lineEnd + 2
                state = .headers(contentLength: nil)
            case .headers(let contentLength):
                guard let lineEnd = Self.search([13, 10], in: buffer, from: offset) else {
                    guard buffer.count - offset <= Self.maximumHeaderBytes else { throw Failure.malformedHeaders }
                    return frames
                }
                let line = buffer[offset..<lineEnd]
                offset = lineEnd + 2
                if line.isEmpty {
                    if let contentLength, contentLength > Self.maximumPartBytes { throw Failure.partTooLarge }
                    state = .body(contentLength: contentLength)
                    scanFrom = offset
                } else {
                    state = .headers(contentLength: try Self.contentLength(in: line) ?? contentLength)
                }
            case .body(let contentLength?):
                guard buffer.count - offset >= contentLength else { return frames }
                if contentLength > 0 {
                    frames.append(Data(buffer[offset..<(offset + contentLength)]))
                }
                offset += contentLength
                state = .seekingBoundary
            case .body(nil):
                let start = max(offset, scanFrom)
                guard let end = Self.search(bodyTerminator, in: buffer, from: start) else {
                    guard buffer.count - offset <= Self.maximumPartBytes else { throw Failure.partTooLarge }
                    scanFrom = max(offset, buffer.count - (bodyTerminator.count - 1))
                    return frames
                }
                guard end - offset <= Self.maximumPartBytes else { throw Failure.partTooLarge }
                if end > offset {
                    frames.append(Data(buffer[offset..<end]))
                }
                // Resume at the delimiter itself, after the CRLF.
                offset = end + 2
                state = .seekingBoundary
            }
        }
    }

    private static func contentLength(in line: ArraySlice<UInt8>) throws -> Int? {
        guard let text = String(bytes: line, encoding: .utf8),
              let colon = text.firstIndex(of: ":") else {
            throw Failure.malformedHeaders
        }
        guard text[..<colon].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" else {
            return nil
        }
        let value = text[text.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        guard !value.isEmpty, value.count <= 10, value.allSatisfy(\.isASCIIDigit),
              let length = Int(value) else {
            throw Failure.malformedHeaders
        }
        return length
    }

    private static func search(_ needle: [UInt8], in haystack: [UInt8], from start: Int) -> Int? {
        guard !needle.isEmpty, haystack.count >= needle.count, start <= haystack.count - needle.count else {
            return nil
        }
        let first = needle[0]
        var index = max(start, 0)
        let last = haystack.count - needle.count
        while index <= last {
            if haystack[index] == first {
                var matched = true
                for offset in 1..<needle.count where haystack[index + offset] != needle[offset] {
                    matched = false
                    break
                }
                if matched { return index }
            }
            index += 1
        }
        return nil
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}
