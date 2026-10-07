import Foundation

enum AidenSSEParserError: Error, Equatable {
    case frameTooLarge
    case invalidEventID
    case eventIDMismatch
    case eventNameMismatch
    case missingData
}

/// One complete SSE frame before its JSON body is decoded.
struct AidenSSERawFrame: Equatable {
    let sequence: Int
    let name: String?
    let data: Data
}

/// Splits SSE lines into frames. Only a consumed blank line completes a frame;
/// EOF must discard this parser, leaving any pending event for replay.
struct AidenSSEFrameParser {
    /// Run streams label a gap snapshot `nextSequence - 1`, which may be 0.
    var minimumEventID = 1
    private var eventID: String?
    private var eventName: String?
    private var dataLines: [String] = []
    private var frameBytes = 0

    // Explicit because Swift 6.2 makes the memberwise init private when any
    // stored property is private.
    init(minimumEventID: Int = 1) {
        self.minimumEventID = minimumEventID
    }

    mutating func consume(line: String) throws -> AidenSSERawFrame? {
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

    private mutating func finishFrame() throws -> AidenSSERawFrame? {
        defer { reset() }
        guard !dataLines.isEmpty else {
            if eventID == nil, eventName == nil { return nil }
            throw AidenSSEParserError.missingData
        }
        guard let eventID, let sequence = Int(eventID), sequence >= minimumEventID else {
            throw AidenSSEParserError.invalidEventID
        }
        return AidenSSERawFrame(
            sequence: sequence,
            name: eventName,
            data: Data(dataLines.joined(separator: "\n").utf8)
        )
    }

    private mutating func reset() {
        eventID = nil
        eventName = nil
        dataLines.removeAll(keepingCapacity: true)
        frameBytes = 0
    }
}

struct AidenSSEParser: AidenSSEEventParsing {
    private var frames = AidenSSEFrameParser()

    mutating func consume(line: String) throws -> AidenRemoteStreamEvent? {
        guard let frame = try frames.consume(line: line) else { return nil }
        let event = try AidenRemoteJSONDecoder.decodeSSEEvent(from: frame.data)
        guard event.sequence == frame.sequence else { throw AidenSSEParserError.eventIDMismatch }
        if let name = frame.name, name != event.type.rawValue {
            throw AidenSSEParserError.eventNameMismatch
        }
        return event
    }
}

/// Parses the contract revision 19 run streams as a phone holding the
/// revision 24 phone-scoped run subset sees them.
struct AidenRunSSEParser: AidenSSEEventParsing {
    private var frames = AidenSSEFrameParser(minimumEventID: 0)

    mutating func consume(line: String) throws -> AidenRemoteRunEvent? {
        guard let frame = try frames.consume(line: line) else { return nil }
        let event = try AidenRemoteJSONDecoder.decodeRunSSEEvent(from: frame.data)
        guard event.sequence == frame.sequence else { throw AidenSSEParserError.eventIDMismatch }
        if let name = frame.name, name != event.wireType {
            throw AidenSSEParserError.eventNameMismatch
        }
        return event
    }
}

extension AidenRemoteRunEvent {
    var wireType: String {
        switch kind {
        case .started: "run.started"
        case let .content(content): content.type.rawValue
        case .approvalRequired: "approval_required"
        case .approvalResolved: "approval_resolved"
        case .questionRequired: "question_required"
        case .questionResolved: "question_resolved"
        case .snapshot: "snapshot"
        case .ended: "run.ended"
        }
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

/// Parses `GET /bots/{botId}/session/events` (contract revision 25). Order is
/// carried by each frame's `(epoch, seq)`, so an SSE `id:` line is optional;
/// when present it must equal `seq`, and an `event:` name must equal `type`.
struct AidenBotSessionSSEParser: AidenSSEEventParsing {
    private var eventID: String?
    private var eventName: String?
    private var dataLines: [String] = []
    private var frameBytes = 0

    init() {}

    mutating func consume(line: String) throws -> AidenBotSessionEvent? {
        frameBytes += line.utf8.count + 1
        guard frameBytes <= AidenRemoteProtocol.maxSSEFrameBytes else {
            throw AidenSSEParserError.frameTooLarge
        }
        guard !line.isEmpty else { return try finishFrame() }
        guard !line.hasPrefix(":") else { return nil }
        let field: Substring
        var value: Substring = ""
        if let separator = line.firstIndex(of: ":") {
            field = line[..<separator]
            var start = line.index(after: separator)
            if start < line.endIndex, line[start] == " " { start = line.index(after: start) }
            value = line[start...]
        } else {
            field = Substring(line)
        }
        switch field {
        case "id": eventID = String(value)
        case "event": eventName = String(value)
        case "data": dataLines.append(String(value))
        default: break
        }
        return nil
    }

    private mutating func finishFrame() throws -> AidenBotSessionEvent? {
        defer {
            eventID = nil
            eventName = nil
            dataLines.removeAll(keepingCapacity: true)
            frameBytes = 0
        }
        guard !dataLines.isEmpty else {
            if eventID == nil, eventName == nil { return nil }
            throw AidenSSEParserError.missingData
        }
        let event = try AidenRemoteJSONDecoder.decode(
            AidenBotSessionEvent.self,
            from: Data(dataLines.joined(separator: "\n").utf8),
            maximumBytes: AidenRemoteProtocol.maxSSEFrameBytes
        )
        if let eventID, Int(eventID) != event.seq { throw AidenSSEParserError.eventIDMismatch }
        if let eventName, eventName != event.wireType { throw AidenSSEParserError.eventNameMismatch }
        return event
    }
}
