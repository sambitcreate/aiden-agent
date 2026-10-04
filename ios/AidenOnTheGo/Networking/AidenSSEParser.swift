import Foundation

enum AidenSSEParserError: Error, Equatable {
    case frameTooLarge
    case invalidEventID
    case eventIDMismatch
    case eventNameMismatch
    case missingData
}

struct AidenSSEParser {
    private var eventID: String?
    private var eventName: String?
    private var dataLines: [String] = []
    private var frameBytes = 0

    mutating func consume(line: String) throws -> AidenRemoteStreamEvent? {
        frameBytes += line.utf8.count + 1
        guard frameBytes <= AidenRemoteProtocol.maxSSEFrameBytes else {
            throw AidenSSEParserError.frameTooLarge
        }
        guard !line.isEmpty else { return try finishFrame() }
        guard !line.hasPrefix(":") else { return nil }

        let field: Substring
        let value: Substring
        if let separator = line.firstIndex(of: ":") {
            field = line[..<separator]
            var start = line.index(after: separator)
            if start < line.endIndex, line[start] == " " {
                start = line.index(after: start)
            }
            value = line[start...]
        } else {
            field = Substring(line)
            value = ""
        }
        switch field {
        case "id": eventID = String(value)
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        default: break
        }
        return nil
    }

    // Only a consumed blank line completes a frame. EOF must discard this
    // parser, leaving any pending event available for replay on reconnect.
    private mutating func finishFrame() throws -> AidenRemoteStreamEvent? {
        defer { reset() }
        guard !dataLines.isEmpty else {
            if eventID == nil, eventName == nil { return nil }
            throw AidenSSEParserError.missingData
        }
        guard let eventID, let sequence = Int(eventID), sequence > 0 else {
            throw AidenSSEParserError.invalidEventID
        }
        let event = try AidenRemoteJSONDecoder.decodeSSEEvent(
            from: Data(dataLines.joined(separator: "\n").utf8)
        )
        guard event.sequence == sequence else { throw AidenSSEParserError.eventIDMismatch }
        if let eventName, eventName != event.type.rawValue {
            throw AidenSSEParserError.eventNameMismatch
        }
        return event
    }

    private mutating func reset() {
        eventID = nil
        eventName = nil
        dataLines.removeAll(keepingCapacity: true)
        frameBytes = 0
    }
}

/// Splits an SSE byte stream into lines for `AidenSSEParser`.
///
/// Lines end at LF; a trailing CR is stripped, so CRLF streams parse the same
/// as LF streams. Empty lines are delivered because they delimit frames. A
/// line that is not valid UTF-8 throws `AidenRemoteClientError.invalidResponse`
/// and a line longer than the SSE frame limit throws `frameTooLarge`. Bytes
/// after the last LF are discarded at EOF, since EOF never completes a frame.
///
/// `URLSession.AsyncBytes` already reads the socket in buffered chunks, so the
/// per-byte work here is kept to a compare and an append: cancellation is
/// checked once per line, and validation runs once per line.
enum AidenSSELineDecoder {
    static func forEachLine<Bytes: AsyncSequence>(
        in bytes: Bytes,
        maximumLineBytes: Int = AidenRemoteProtocol.maxSSEFrameBytes,
        _ body: (String) throws -> Void
    ) async throws where Bytes.Element == UInt8 {
        var lineBytes: [UInt8] = []
        lineBytes.reserveCapacity(512)
        for try await byte in bytes {
            guard byte == 0x0A else {
                guard lineBytes.count < maximumLineBytes else {
                    throw AidenSSEParserError.frameTooLarge
                }
                lineBytes.append(byte)
                continue
            }
            try Task.checkCancellation()
            if lineBytes.last == 0x0D { lineBytes.removeLast() }
            guard let line = String(validating: lineBytes, as: UTF8.self) else {
                throw AidenRemoteClientError.invalidResponse
            }
            lineBytes.removeAll(keepingCapacity: true)
            try body(line)
        }
    }
}
