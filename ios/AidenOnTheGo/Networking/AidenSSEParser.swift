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

    mutating func finish() throws -> AidenRemoteStreamEvent? {
        guard frameBytes > 0 else { return nil }
        return try finishFrame()
    }

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
