import Foundation

enum AidenRemoteProtocol {
    static let version = 1
    static let basePath = "/api/aiden/v1"
    static let maxIdentifierLength = 128
    static let maxEndpointLength = 2_048
    static let maxEndpointPort = 65_535
    static let maxEventTypeLength = 80
    static let maxEventPayloadProperties = 32
    // The envelope is additively extensible. Its only key-count ceiling is the
    // same whole-document abuse limit enforced by the TypeScript raw scanner;
    // the event payload itself remains capped at 32 properties below.
    static let maxEventEnvelopeProperties = 16_384
    static let maxJSONTotalObjectKeys = 16_384
    static let maxTextLength = 200_000
    static let maxToolNameLength = 120
    static let maxTimelineLabelLength = 500
    static let maxApprovalSummaryLength = 2_000
    static let maxErrorMessageLength = 2_000
    static let maxJSONBodyBytes = 1_048_576
    static let maxFileJSONBodyBytes = 6 * 1_048_576
    static let maxSSEFrameBytes = maxJSONBodyBytes
    static let maxPairingPayloadBytes = 4_096
    static let maxSafeInteger = 9_007_199_254_740_991
    static let maxJSONNestingDepth = 128
    static let forbiddenWireKeys: Set<String> = [
        "authorization", "credentialDigest", "providerFingerprint", "mcpServerBindings",
        "folderPath", "repositoryPath", "worktreePath", "worktreeGitDir",
        "ownershipToken", "worktreeDevice", "worktreeInode", "createdFromHead",
        "canonicalPath", "absolutePath", "scriptPath", "environment", "stdout", "stderr",
    ]
}

enum AidenPairingBootstrapError: Error, Equatable {
    case unsupportedProtocol
    case invalidInstance
    case invalidEndpoint
    case invalidFingerprint
    case weakSecret
    case expired
    case excessiveTTL
}

enum AidenPairingPayloadError: Error, Equatable {
    case invalidKind
    case invalidTrust
    case invalidCACertificateData
}

enum AidenManualPairingError: Error, Equatable, LocalizedError {
    case invalidCode
    case invalidBootstrap
    case decryptionFailed
    case endpointMismatch

    var errorDescription: String? {
        switch self {
        case .invalidCode:
            return String(localized: "Enter the 20-character setup code shown on your Mac.")
        case .invalidBootstrap:
            return String(localized: "Aiden Agent returned an invalid manual pairing response.")
        case .decryptionFailed:
            return String(localized: "The setup code is incorrect or belongs to a different pairing window.")
        case .endpointMismatch:
            return String(localized: "The setup code belongs to a different Aiden Agent address.")
        }
    }
}

enum AidenRemoteContractError: Error, Equatable {
    case duplicateJSONKey(String)
    case invalidJSON
    case unknownTerminalEvent(String)
    case unsafePayloadField(String)
    case payloadTooLarge
    case unknownErrorCode(String)
    case invalidTerminalClassification
    case invalidProtocolVersion
    case invalidStreamIdentity
    case invalidSequence
    case invalidPairingExchange
}

private struct AidenDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private func assertKnownKeys<Key: CodingKey>(
    _ container: KeyedDecodingContainer<Key>,
    allowed: Set<String>
) throws {
    if let unsupported = container.allKeys.first(where: { !allowed.contains($0.stringValue) }) {
        throw AidenRemoteContractError.unsafePayloadField(unsupported.stringValue)
    }
}

/// A JSON object member name after JSON escape processing, retaining its exact
/// Unicode scalar sequence for equality. `String` equality uses canonical
/// equivalence, while JSON member names are compared after unescaping only.
private struct AidenRawJSONKey: Hashable {
    let scalars: [UInt32]
    let displayValue: String

    init(_ value: String) {
        scalars = value.unicodeScalars.map(\.value)
        displayValue = value
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.scalars == rhs.scalars
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(scalars.count)
        for scalar in scalars {
            hasher.combine(scalar)
        }
    }
}

/// Foundation's JSONDecoder does not provide a duplicate-member policy. Scan
/// the raw JSON first so object names cannot be overwritten by a later member,
/// including when one spelling uses JSON escapes and the other does not.
private struct AidenRawJSONDuplicateKeyScanner {
    private let bytes: [UInt8]
    private var offset = 0
    private var totalObjectKeys = 0

    init(data: Data) {
        bytes = Array(data)
    }

    static func validate(_ data: Data) throws {
        var scanner = Self(data: data)
        try scanner.parseDocument()
    }

    private mutating func parseDocument() throws {
        try parseValue(depth: 0)
        skipWhitespace()
        guard offset == bytes.count else { throw AidenRemoteContractError.invalidJSON }
    }

    private mutating func parseValue(depth: Int) throws {
        guard depth <= AidenRemoteProtocol.maxJSONNestingDepth else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        skipWhitespace()
        guard let byte = peek() else { throw AidenRemoteContractError.invalidJSON }
        switch byte {
        case 0x7B: // {
            try parseObject(depth: depth)
        case 0x5B: // [
            try parseArray(depth: depth)
        case 0x22: // "
            _ = try parseString()
        case 0x74: // t
            try parseLiteral([0x74, 0x72, 0x75, 0x65]) // true
        case 0x66: // f
            try parseLiteral([0x66, 0x61, 0x6C, 0x73, 0x65]) // false
        case 0x6E: // n
            try parseLiteral([0x6E, 0x75, 0x6C, 0x6C]) // null
        case 0x2D, 0x30...0x39: // - or digit
            try parseNumber()
        default:
            throw AidenRemoteContractError.invalidJSON
        }
    }

    private mutating func parseObject(depth: Int) throws {
        try consume(0x7B) // {
        skipWhitespace()
        var keys = Set<AidenRawJSONKey>()
        if consumeIf(0x7D) { return } // }

        while true {
            skipWhitespace()
            guard peek() == 0x22 else { throw AidenRemoteContractError.invalidJSON }
            let key = try parseString()
            totalObjectKeys += 1
            guard totalObjectKeys <= AidenRemoteProtocol.maxJSONTotalObjectKeys else {
                throw AidenRemoteContractError.payloadTooLarge
            }
            guard keys.insert(key).inserted else {
                throw AidenRemoteContractError.duplicateJSONKey(key.displayValue)
            }
            skipWhitespace()
            try consume(0x3A) // :
            try parseValue(depth: depth + 1)
            skipWhitespace()
            if consumeIf(0x2C) { continue } // ,
            try consume(0x7D) // }
            return
        }
    }

    private mutating func parseArray(depth: Int) throws {
        try consume(0x5B) // [
        skipWhitespace()
        if consumeIf(0x5D) { return } // ]

        while true {
            try parseValue(depth: depth + 1)
            skipWhitespace()
            if consumeIf(0x2C) { continue } // ,
            try consume(0x5D) // ]
            return
        }
    }

    private mutating func parseLiteral(_ literal: [UInt8]) throws {
        guard bytes.count - offset >= literal.count,
              Array(bytes[offset..<(offset + literal.count)]) == literal else {
            throw AidenRemoteContractError.invalidJSON
        }
        offset += literal.count
    }

    private mutating func parseNumber() throws {
        _ = consumeIf(0x2D) // -

        if consumeIf(0x30) { // 0
            if let next = peek(), next >= 0x30, next <= 0x39 {
                throw AidenRemoteContractError.invalidJSON
            }
        } else {
            guard let first = peek(), first >= 0x31, first <= 0x39 else {
                throw AidenRemoteContractError.invalidJSON
            }
            offset += 1
            while let next = peek(), next >= 0x30, next <= 0x39 { offset += 1 }
        }

        if consumeIf(0x2E) { // .
            guard let first = peek(), first >= 0x30, first <= 0x39 else {
                throw AidenRemoteContractError.invalidJSON
            }
            offset += 1
            while let next = peek(), next >= 0x30, next <= 0x39 { offset += 1 }
        }

        if let next = peek(), next == 0x65 || next == 0x45 { // e/E
            offset += 1
            _ = consumeIf(0x2B) // +
            _ = consumeIf(0x2D) // -
            guard let first = peek(), first >= 0x30, first <= 0x39 else {
                throw AidenRemoteContractError.invalidJSON
            }
            offset += 1
            while let digit = peek(), digit >= 0x30, digit <= 0x39 { offset += 1 }
        }
    }

    private mutating func parseString() throws -> AidenRawJSONKey {
        try consume(0x22) // "
        var utf8: [UInt8] = []

        while let byte = peek() {
            offset += 1
            switch byte {
            case 0x22: // "
                guard let value = String(bytes: utf8, encoding: .utf8) else {
                    throw AidenRemoteContractError.invalidJSON
                }
                return AidenRawJSONKey(value)
            case 0x5C: // \
                guard let escape = peek() else { throw AidenRemoteContractError.invalidJSON }
                offset += 1
                switch escape {
                case 0x22, 0x5C, 0x2F: // " \\ /
                    utf8.append(escape)
                case 0x62: // b
                    utf8.append(0x08)
                case 0x66: // f
                    utf8.append(0x0C)
                case 0x6E: // n
                    utf8.append(0x0A)
                case 0x72: // r
                    utf8.append(0x0D)
                case 0x74: // t
                    utf8.append(0x09)
                case 0x75: // u
                    let first = try readHexQuad()
                    if first >= 0xD800 && first <= 0xDBFF {
                        guard consumeIf(0x5C), consumeIf(0x75) else {
                            throw AidenRemoteContractError.invalidJSON
                        }
                        let second = try readHexQuad()
                        guard second >= 0xDC00 && second <= 0xDFFF else {
                            throw AidenRemoteContractError.invalidJSON
                        }
                        let scalar = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                        try appendScalar(scalar, to: &utf8)
                    } else if first >= 0xDC00 && first <= 0xDFFF {
                        throw AidenRemoteContractError.invalidJSON
                    } else {
                        try appendScalar(first, to: &utf8)
                    }
                default:
                    throw AidenRemoteContractError.invalidJSON
                }
            default:
                guard byte >= 0x20 else { throw AidenRemoteContractError.invalidJSON }
                utf8.append(byte)
            }
        }

        throw AidenRemoteContractError.invalidJSON
    }

    private mutating func readHexQuad() throws -> UInt32 {
        guard bytes.count - offset >= 4 else { throw AidenRemoteContractError.invalidJSON }
        var value: UInt32 = 0
        for _ in 0..<4 {
            guard let digit = Self.hexValue(bytes[offset]) else {
                throw AidenRemoteContractError.invalidJSON
            }
            value = (value << 4) | digit
            offset += 1
        }
        return value
    }

    private func appendScalar(_ value: UInt32, to utf8: inout [UInt8]) throws {
        guard let scalar = UnicodeScalar(value) else {
            throw AidenRemoteContractError.invalidJSON
        }
        utf8.append(contentsOf: String(scalar).utf8)
    }

    private static func hexValue(_ byte: UInt8) -> UInt32? {
        switch byte {
        case 0x30...0x39: return UInt32(byte - 0x30)
        case 0x41...0x46: return UInt32(byte - 0x41 + 10)
        case 0x61...0x66: return UInt32(byte - 0x61 + 10)
        default: return nil
        }
    }

    private func peek() -> UInt8? {
        guard offset < bytes.count else { return nil }
        return bytes[offset]
    }

    private mutating func consume(_ expected: UInt8) throws {
        guard consumeIf(expected) else { throw AidenRemoteContractError.invalidJSON }
    }

    private mutating func consumeIf(_ expected: UInt8) -> Bool {
        guard peek() == expected else { return false }
        offset += 1
        return true
    }

    private mutating func skipWhitespace() {
        while let byte = peek(), byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D {
            offset += 1
        }
    }
}

private func boundedString<Key: CodingKey>(
    _ container: KeyedDecodingContainer<Key>,
    forKey key: Key,
    maxLength: Int,
    field: String,
    required: Bool = false
) throws -> String? {
    let value: String?
    // `decodeIfPresent` treats an explicitly encoded JSON null the same as an
    // absent member. Wire schemas distinguish those cases: null is invalid
    // for every bounded string member, while only an absent optional member
    // may decode to nil.
    if required || container.contains(key) {
        value = try container.decode(String.self, forKey: key)
    } else {
        value = nil
    }
    guard let value else { return nil }
    guard !value.isEmpty, value.unicodeScalars.count <= maxLength else {
        throw AidenRemoteContractError.unsafePayloadField(field)
    }
    return value
}

private func decodeOptionalNonNull<Value: Decodable, Key: CodingKey>(
    _ container: KeyedDecodingContainer<Key>,
    _ type: Value.Type,
    forKey key: Key
) throws -> Value? {
    guard container.contains(key) else { return nil }
    return try container.decode(type, forKey: key)
}

private func isAidenASCIIAlphaNumeric(_ scalar: UnicodeScalar) -> Bool {
    (scalar.value >= 48 && scalar.value <= 57) ||
        (scalar.value >= 65 && scalar.value <= 90) ||
        (scalar.value >= 97 && scalar.value <= 122)
}

private func isAidenASCIIHex(_ scalar: UnicodeScalar) -> Bool {
    (scalar.value >= 48 && scalar.value <= 57) ||
        (scalar.value >= 65 && scalar.value <= 70) ||
        (scalar.value >= 97 && scalar.value <= 102)
}

private func isCanonicalAidenIPv4(_ value: String) -> Bool {
    let octets = value.split(separator: ".", omittingEmptySubsequences: false)
    guard octets.count == 4 else { return false }
    return octets.allSatisfy { octet in
        let scalars = Array(octet.unicodeScalars)
        guard !scalars.isEmpty,
              scalars.count <= 3,
              scalars.allSatisfy({ $0.value >= 48 && $0.value <= 57 }) else {
            return false
        }
        if scalars.count > 1, scalars[0].value == 48 { return false }
        guard let number = Int(String(octet)) else { return false }
        return number <= 255
    }
}

private func parseAidenIPv6Side(_ value: String) -> Int? {
    if value.isEmpty { return 0 }
    let groups = value.split(separator: ":", omittingEmptySubsequences: false)
    guard groups.allSatisfy({ !$0.isEmpty }) else { return nil }
    var count = 0
    for (index, group) in groups.enumerated() {
        let value = String(group)
        if value.contains(".") {
            guard index == groups.count - 1, isCanonicalAidenIPv4(value) else { return nil }
            count += 2
        } else {
            let scalars = Array(value.unicodeScalars)
            guard (1...4).contains(scalars.count), scalars.allSatisfy(isAidenASCIIHex) else {
                return nil
            }
            count += 1
        }
    }
    return count
}

private func isCanonicalAidenIPv6(_ value: String) -> Bool {
    guard !value.isEmpty,
          value.unicodeScalars.allSatisfy({ isAidenASCIIHex($0) || $0.value == 46 || $0.value == 58 }) else {
        return false
    }
    let sides = value.components(separatedBy: "::")
    guard sides.count <= 2 else { return false }
    if sides.count == 2 {
        if sides[0].contains(".") { return false }
        guard let left = parseAidenIPv6Side(sides[0]),
              let right = parseAidenIPv6Side(sides[1]) else {
            return false
        }
        return left + right < 8
    }
    return parseAidenIPv6Side(value) == 8
}

private func isCanonicalAidenDNSLabel(_ label: Substring) -> Bool {
    let scalars = Array(label.unicodeScalars)
    guard !scalars.isEmpty,
          scalars.count <= 63,
          let first = scalars.first,
          let last = scalars.last,
          isAidenASCIIAlphaNumeric(first),
          isAidenASCIIAlphaNumeric(last) else {
        return false
    }
    return scalars.dropFirst().dropLast().allSatisfy { isAidenASCIIAlphaNumeric($0) || $0.value == 45 }
}

private func isCanonicalAidenDNSHost(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 253 else { return false }
    let labels = value.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.allSatisfy({ !$0.isEmpty }) else { return false }
    if labels.allSatisfy({ !$0.isEmpty && $0.unicodeScalars.allSatisfy({ $0.value >= 48 && $0.value <= 57 }) }) {
        // Numeric-only authorities are ambiguous under Foundation URL parsing.
        // Keep only canonical dotted-decimal IPv4 instead of letting `123`
        // become `0.0.0.123` on one platform and a DNS name on another.
        return isCanonicalAidenIPv4(value)
    }
    // A DNS authority must not end in a numeric-only label. This keeps
    // `aiden.123` distinct from canonical IPv4 while retaining numeric labels
    // in non-terminal positions.
    if labels.last?.unicodeScalars.allSatisfy({ $0.value >= 48 && $0.value <= 57 }) == true {
        return false
    }
    return labels.allSatisfy(isCanonicalAidenDNSLabel)
}

private func isCanonicalAidenPort(_ value: String) -> Bool {
    let scalars = Array(value.unicodeScalars)
    guard !scalars.isEmpty,
          scalars.count <= 5,
          scalars[0].value != 48,
          scalars.allSatisfy({ $0.value >= 48 && $0.value <= 57 }),
          let port = Int(value) else {
        return false
    }
    return (1...AidenRemoteProtocol.maxEndpointPort).contains(port)
}

private func isCanonicalAidenAuthority(_ value: String) -> Bool {
    // Keep the raw grammar ASCII-only. This rejects C0/DEL, all Unicode
    // whitespace and normalization-sensitive host spellings before Foundation
    // can decode or normalize them.
    guard value.unicodeScalars.allSatisfy({
        $0.value <= 0x7F && $0.value > 0x20 && $0.value != 0x7F
    }) else {
        return false
    }

    let host: String
    var rawPort: String?
    if value.first == "[" {
        guard let closingBracket = value.firstIndex(of: "]"),
              closingBracket > value.index(after: value.startIndex) else {
            return false
        }
        let hostStart = value.index(after: value.startIndex)
        guard !value[hostStart..<closingBracket].contains("["),
              !value[value.index(after: closingBracket)...].contains("]") else {
            return false
        }
        host = String(value[hostStart..<closingBracket])
        let suffix = String(value[value.index(after: closingBracket)...])
        if suffix.isEmpty {
            rawPort = nil
        } else {
            guard suffix.first == ":" else { return false }
            rawPort = String(suffix.dropFirst())
        }
        guard isCanonicalAidenIPv6(host) else { return false }
    } else {
        guard !value.contains("[") && !value.contains("]") else { return false }
        if let colon = value.firstIndex(of: ":") {
            guard colon == value.lastIndex(of: ":") else { return false }
            host = String(value[..<colon])
            rawPort = String(value[value.index(after: colon)...])
        } else {
            host = value
        }
        guard isCanonicalAidenDNSHost(host) else { return false }
    }

    return rawPort.map(isCanonicalAidenPort) ?? true
}

func isCanonicalAidenEndpoint(_ rawEndpoint: String) -> Bool {
    guard rawEndpoint.utf8.count <= AidenRemoteProtocol.maxEndpointLength,
          rawEndpoint.hasPrefix("https://"),
          rawEndpoint.hasSuffix(AidenRemoteProtocol.basePath) else {
        return false
    }
    let authorityStart = rawEndpoint.index(rawEndpoint.startIndex, offsetBy: "https://".count)
    let pathStart = rawEndpoint.index(rawEndpoint.endIndex, offsetBy: -AidenRemoteProtocol.basePath.count)
    guard pathStart > authorityStart else { return false }
    return isCanonicalAidenAuthority(String(rawEndpoint[authorityStart..<pathStart]))
}

func isCanonicalAidenEndpoint(_ endpoint: URL) -> Bool {
    isCanonicalAidenEndpoint(endpoint.absoluteString)
}

struct AidenRemoteCapability: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    static let serverRead = Self(rawValue: "server:read")
    static let chatRead = Self(rawValue: "chat:read")
    static let chatWrite = Self(rawValue: "chat:write")
    static let approvalRespond = Self(rawValue: "approval:respond")
    static let workspaceRead = Self(rawValue: "workspace:read")
    static let workspaceBrowse = Self(rawValue: "workspace:browse")
    static let workspaceManage = Self(rawValue: "workspace:manage")
    static let filesRead = Self(rawValue: "files:read")
    static let filesWrite = Self(rawValue: "files:write")
    static let gitRead = Self(rawValue: "git:read")
    static let gitWrite = Self(rawValue: "git:write")
    static let scheduleRead = Self(rawValue: "schedule:read")
    static let scheduleWrite = Self(rawValue: "schedule:write")

    static let v1Known: [Self] = [
        .serverRead, .chatRead, .chatWrite, .approvalRespond,
        .workspaceRead, .workspaceBrowse, .workspaceManage,
        .filesRead, .filesWrite, .gitRead, .gitWrite,
        .scheduleRead, .scheduleWrite,
    ]

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        guard !value.isEmpty, value.unicodeScalars.count <= AidenRemoteProtocol.maxEventTypeLength else {
            throw AidenRemoteContractError.unsafePayloadField("capability")
        }
        self.init(rawValue: value)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

struct AidenRemoteEventType: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    static let snapshot = Self(rawValue: "snapshot")
    static let status = Self(rawValue: "status")
    static let textDelta = Self(rawValue: "text_delta")
    static let reasoningDelta = Self(rawValue: "reasoning_delta")
    static let toolStarted = Self(rawValue: "tool_started")
    static let toolFinished = Self(rawValue: "tool_finished")
    static let timeline = Self(rawValue: "timeline")
    static let approvalRequired = Self(rawValue: "approval_required")
    static let done = Self(rawValue: "done")
    static let error = Self(rawValue: "error")
    static let cancelled = Self(rawValue: "cancelled")
    static let heartbeat = Self(rawValue: "heartbeat")

    static let v1Known: [Self] = [
        .snapshot, .status, .textDelta, .reasoningDelta,
        .toolStarted, .toolFinished, .timeline, .approvalRequired,
        .done, .error, .cancelled, .heartbeat,
    ]

    var isTerminal: Bool {
        self == .done || self == .error || self == .cancelled
    }
}

struct AidenRemoteErrorCode: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    static let v1Known: [Self] = [
        Self(rawValue: "invalid_request"),
        Self(rawValue: "payload_too_large"),
        Self(rawValue: "rate_limited"),
        Self(rawValue: "authentication_required"),
        Self(rawValue: "credential_revoked"),
        Self(rawValue: "capability_denied"),
        Self(rawValue: "pairing_closed"),
        Self(rawValue: "pairing_expired"),
        Self(rawValue: "pairing_already_used"),
        Self(rawValue: "server_identity_changed"),
        Self(rawValue: "not_found"),
        Self(rawValue: "already_exists"),
        Self(rawValue: "revision_conflict"),
        Self(rawValue: "idempotency_conflict"),
        Self(rawValue: "idempotency_capacity"),
        Self(rawValue: "idempotency_in_flight"),
        Self(rawValue: "workspace_unavailable"),
        Self(rawValue: "workspace_changing"),
        Self(rawValue: "permission_confirmation_required"),
        Self(rawValue: "handle_invalid"),
        Self(rawValue: "handle_expired"),
        Self(rawValue: "handle_wrong_device"),
        Self(rawValue: "root_policy_changed"),
        Self(rawValue: "filesystem_identity_changed"),
        Self(rawValue: "path_outside_root"),
        Self(rawValue: "handle_capacity"),
        Self(rawValue: "turn_already_active"),
        Self(rawValue: "stream_gone"),
        Self(rawValue: "approval_already_resolved"),
        Self(rawValue: "approval_expired"),
        Self(rawValue: "operation_in_progress"),
        Self(rawValue: "operation_stale"),
        Self(rawValue: "git_capability_denied"),
        Self(rawValue: "schedule_disabled"),
        Self(rawValue: "schedule_run_in_progress"),
        Self(rawValue: "server_interrupted"),
        Self(rawValue: "internal_error"),
    ]

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        guard Self.v1Known.contains(Self(rawValue: value)) else {
            throw AidenRemoteContractError.unknownErrorCode(value)
        }
        self.init(rawValue: value)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

struct AidenRemoteErrorEnvelope: Codable, Equatable, Sendable {
    struct Details: Codable, Equatable, Sendable {
        let currentRevision: String?
        let retryAfterSeconds: Int?
        let chatId: String?
        let minimumClientVersion: String?
        let limit: Int?
        let field: String?

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            currentRevision = try boundedString(
                values,
                forKey: .currentRevision,
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                field: "currentRevision"
            )
            retryAfterSeconds = try decodeOptionalNonNull(
                values,
                Int.self,
                forKey: .retryAfterSeconds
            )
            if let retryAfterSeconds {
                guard (0...86_400).contains(retryAfterSeconds) else {
                    throw AidenRemoteContractError.unsafePayloadField("retryAfterSeconds")
                }
            }
            chatId = try boundedString(
                values,
                forKey: .chatId,
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                field: "chatId"
            )
            minimumClientVersion = try boundedString(
                values,
                forKey: .minimumClientVersion,
                maxLength: 40,
                field: "minimumClientVersion"
            )
            limit = try decodeOptionalNonNull(values, Int.self, forKey: .limit)
            if let limit {
                guard (0...1_000_000).contains(limit) else {
                    throw AidenRemoteContractError.unsafePayloadField("limit")
                }
            }
            field = try boundedString(
                values,
                forKey: .field,
                maxLength: 120,
                field: "field"
            )
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case currentRevision, retryAfterSeconds, chatId, minimumClientVersion, limit, field
        }
    }

    struct Body: Codable, Equatable, Sendable {
        let code: AidenRemoteErrorCode
        let message: String
        let requestId: String
        let retryable: Bool
        let details: Details?

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            code = try values.decode(AidenRemoteErrorCode.self, forKey: .code)
            message = try boundedString(
                values,
                forKey: .message,
                maxLength: AidenRemoteProtocol.maxErrorMessageLength,
                field: "message",
                required: true
            )!
            requestId = try boundedString(
                values,
                forKey: .requestId,
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                field: "requestId",
                required: true
            )!
            retryable = try values.decode(Bool.self, forKey: .retryable)
            details = try decodeOptionalNonNull(values, Details.self, forKey: .details)
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case code, message, requestId, retryable, details
        }
    }

    let error: Body

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
        try assertKnownKeys(dynamic, allowed: ["error"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        error = try values.decode(Body.self, forKey: .error)
    }

    private enum CodingKeys: String, CodingKey {
        case error
    }
}

struct AidenRemoteEventPayload: Codable, Equatable, Sendable {
    let chatId: String?
    let turnId: String?
    let nextSequence: Int?
    let state: String?
    let text: String?
    let toolId: String?
    let name: String?
    let status: String?
    let label: String?
    let approvalId: String?
    let summary: String?
    let expiresAt: Date?
    let messageId: String?
    let code: AidenRemoteErrorCode?
    let message: String?
    let source: String?
    private let wirePresentKeys: Set<String>

    var presentKeys: Set<String> {
        wirePresentKeys
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
        guard dynamic.allKeys.count <= AidenRemoteProtocol.maxEventPayloadProperties else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        wirePresentKeys = Set(dynamic.allKeys.map(\.stringValue))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try boundedString(
            values,
            forKey: .chatId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength,
            field: "chatId"
        )
        turnId = try boundedString(
            values,
            forKey: .turnId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength,
            field: "turnId"
        )
        nextSequence = try decodeOptionalNonNull(values, Int.self, forKey: .nextSequence)
        state = try boundedString(values, forKey: .state, maxLength: 64, field: "state")
        text = try boundedString(
            values,
            forKey: .text,
            maxLength: AidenRemoteProtocol.maxTextLength,
            field: "text"
        )
        toolId = try boundedString(
            values,
            forKey: .toolId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength,
            field: "toolId"
        )
        name = try boundedString(
            values,
            forKey: .name,
            maxLength: AidenRemoteProtocol.maxToolNameLength,
            field: "name"
        )
        status = try boundedString(values, forKey: .status, maxLength: 32, field: "status")
        label = try boundedString(
            values,
            forKey: .label,
            maxLength: AidenRemoteProtocol.maxTimelineLabelLength,
            field: "label"
        )
        approvalId = try boundedString(
            values,
            forKey: .approvalId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength,
            field: "approvalId"
        )
        summary = try boundedString(
            values,
            forKey: .summary,
            maxLength: AidenRemoteProtocol.maxApprovalSummaryLength,
            field: "summary"
        )
        expiresAt = try decodeOptionalNonNull(values, Date.self, forKey: .expiresAt)
        messageId = try boundedString(
            values,
            forKey: .messageId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength,
            field: "messageId"
        )
        code = try decodeOptionalNonNull(values, AidenRemoteErrorCode.self, forKey: .code)
        message = try boundedString(
            values,
            forKey: .message,
            maxLength: AidenRemoteProtocol.maxErrorMessageLength,
            field: "message"
        )
        source = try boundedString(values, forKey: .source, maxLength: 32, field: "source")
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case chatId, turnId, nextSequence, state, text, toolId, name, status, label
        case approvalId, summary, expiresAt, messageId, code, message, source
    }
}

private indirect enum AidenUnknownJSONValue: Decodable {
    case object
    case array
    case scalar

    init(from decoder: Decoder) throws {
        guard decoder.codingPath.count <= AidenRemoteProtocol.maxJSONNestingDepth else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        if let values = try? decoder.container(keyedBy: AidenDynamicCodingKey.self) {
            for key in values.allKeys {
                if AidenRemoteProtocol.forbiddenWireKeys.contains(key.stringValue) {
                    throw AidenRemoteContractError.unsafePayloadField(key.stringValue)
                }
                _ = try values.decode(AidenUnknownJSONValue.self, forKey: key)
            }
            self = .object
            return
        }
        if var values = try? decoder.unkeyedContainer() {
            while !values.isAtEnd { _ = try values.decode(AidenUnknownJSONValue.self) }
            self = .array
            return
        }
        let value = try decoder.singleValueContainer()
        if value.decodeNil()
            || (try? value.decode(Bool.self)) != nil
            || (try? value.decode(Int64.self)) != nil
            || (try? value.decode(Double.self)) != nil
            || (try? value.decode(String.self)) != nil {
            self = .scalar
            return
        }
        throw DecodingError.dataCorruptedError(in: value, debugDescription: "Unsupported JSON value.")
    }
}

private struct AidenUnknownEventPayload: Decodable {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
        guard values.allKeys.count <= AidenRemoteProtocol.maxEventPayloadProperties else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        for key in values.allKeys {
            if AidenRemoteProtocol.forbiddenWireKeys.contains(key.stringValue) {
                throw AidenRemoteContractError.unsafePayloadField(key.stringValue)
            }
            _ = try values.decode(AidenUnknownJSONValue.self, forKey: key)
        }
    }
}

struct AidenRemoteStreamEvent: Decodable, Equatable, Sendable {
    let protocolVersion: Int
    let streamId: String
    let sequence: Int
    let timestamp: Date
    let type: AidenRemoteEventType
    let terminal: Bool
    let payload: AidenRemoteEventPayload?

    var shouldApply: Bool { AidenRemoteEventType.v1Known.contains(type) }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case protocolVersion, streamId, sequence, timestamp, type, terminal, payload
    }

    init(from decoder: Decoder) throws {
        let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
        guard dynamic.allKeys.count <= AidenRemoteProtocol.maxEventEnvelopeProperties else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        let envelopeKeys = Set(CodingKeys.allCases.map(\.stringValue))
        for key in dynamic.allKeys where !envelopeKeys.contains(key.stringValue) {
            if AidenRemoteProtocol.forbiddenWireKeys.contains(key.stringValue) {
                throw AidenRemoteContractError.unsafePayloadField(key.stringValue)
            }
            _ = try dynamic.decode(AidenUnknownJSONValue.self, forKey: key)
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
        guard protocolVersion == AidenRemoteProtocol.version else {
            throw AidenRemoteContractError.invalidProtocolVersion
        }
        streamId = try values.decode(String.self, forKey: .streamId)
        guard !streamId.isEmpty, streamId.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength else {
            throw AidenRemoteContractError.invalidStreamIdentity
        }
        sequence = try values.decode(Int.self, forKey: .sequence)
        guard (1...AidenRemoteProtocol.maxSafeInteger).contains(sequence) else {
            throw AidenRemoteContractError.invalidSequence
        }
        timestamp = try values.decode(Date.self, forKey: .timestamp)
        type = try values.decode(AidenRemoteEventType.self, forKey: .type)
        guard !type.rawValue.isEmpty,
              type.rawValue.unicodeScalars.count <= AidenRemoteProtocol.maxEventTypeLength else {
            throw AidenRemoteContractError.unsafePayloadField("type")
        }
        terminal = try values.decode(Bool.self, forKey: .terminal)
        if !AidenRemoteEventType.v1Known.contains(type) {
            guard !terminal else { throw AidenRemoteContractError.unknownTerminalEvent(type.rawValue) }
            _ = try values.decode(AidenUnknownEventPayload.self, forKey: .payload)
            payload = nil
            return
        }
        guard terminal == type.isTerminal else {
            throw AidenRemoteContractError.invalidTerminalClassification
        }
        let decodedPayload = try values.decode(AidenRemoteEventPayload.self, forKey: .payload)
        let allowedKeys: Set<String>
        switch type {
        case .snapshot: allowedKeys = ["chatId", "turnId", "nextSequence"]
        case .status: allowedKeys = ["state"]
        case .textDelta, .reasoningDelta: allowedKeys = ["text"]
        case .toolStarted: allowedKeys = ["toolId", "name"]
        case .toolFinished: allowedKeys = ["toolId", "status"]
        case .timeline: allowedKeys = ["label"]
        case .approvalRequired: allowedKeys = ["approvalId", "summary", "expiresAt"]
        case .done: allowedKeys = ["messageId"]
        case .error: allowedKeys = ["code", "message"]
        case .cancelled: allowedKeys = ["source"]
        case .heartbeat: allowedKeys = []
        default: allowedKeys = []
        }
        if let unsupported = decodedPayload.presentKeys.subtracting(allowedKeys).first {
            throw AidenRemoteContractError.unsafePayloadField(unsupported)
        }
        guard decodedPayload.presentKeys == allowedKeys else {
            throw AidenRemoteContractError.unsafePayloadField("missing-required-field")
        }
        if type == .status,
           let state = decodedPayload.state,
           !["queued", "running", "waiting_for_approval", "reconciling"].contains(state) {
            throw AidenRemoteContractError.unsafePayloadField("state")
        }
        if type == .snapshot,
           let nextSequence = decodedPayload.nextSequence,
           !(1...AidenRemoteProtocol.maxSafeInteger).contains(nextSequence) {
            throw AidenRemoteContractError.unsafePayloadField("nextSequence")
        }
        if type == .toolFinished,
           let status = decodedPayload.status,
           !["succeeded", "failed", "cancelled"].contains(status) {
            throw AidenRemoteContractError.unsafePayloadField("status")
        }
        if type == .cancelled,
           let source = decodedPayload.source,
           !["device", "server"].contains(source) {
            throw AidenRemoteContractError.unsafePayloadField("source")
        }
        payload = decodedPayload
    }
}

struct AidenRemoteContractFixture: Decodable {
    struct Health: Decodable {
        let ok: Bool
        let protocolVersion: Int

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            ok = try values.decode(Bool.self, forKey: .ok)
            guard ok else { throw AidenRemoteContractError.unsafePayloadField("ok") }
            protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
            guard protocolVersion == AidenRemoteProtocol.version else {
                throw AidenRemoteContractError.invalidProtocolVersion
            }
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case ok, protocolVersion
        }
    }

    struct ManualPairingBootstrap: Decodable, Equatable {
        static let kindValue = "aiden-manual-pairing-v1"

        let kind: String
        let protocolVersion: Int
        let sessionId: String
        let expiresAt: Date
        let rawExpiresAt: String
        let salt: Data
        let nonce: Data
        let ciphertext: Data
        let tag: Data

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decode(String.self, forKey: .kind)
            protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
            sessionId = try values.decode(String.self, forKey: .sessionId)
            rawExpiresAt = try values.decode(String.self, forKey: .expiresAt)
            guard let parsedExpiry = AidenStrictRFC3339Date.date(from: rawExpiresAt) else {
                throw AidenManualPairingError.invalidBootstrap
            }
            expiresAt = parsedExpiry
            let rawSalt = try values.decode(String.self, forKey: .salt)
            let rawNonce = try values.decode(String.self, forKey: .nonce)
            let rawCiphertext = try values.decode(String.self, forKey: .ciphertext)
            let rawTag = try values.decode(String.self, forKey: .tag)
            guard rawSalt.count == 22,
                  rawNonce.count == 16,
                  (2...5_462).contains(rawCiphertext.count),
                  rawTag.count == 22,
                  let decodedSalt = rawSalt.canonicalBase64URLDecoded,
                  let decodedNonce = rawNonce.canonicalBase64URLDecoded,
                  let decodedCiphertext = rawCiphertext.canonicalBase64URLDecoded,
                  let decodedTag = rawTag.canonicalBase64URLDecoded else {
                throw AidenManualPairingError.invalidBootstrap
            }
            salt = decodedSalt
            nonce = decodedNonce
            ciphertext = decodedCiphertext
            tag = decodedTag
        }

        @discardableResult
        func validated(at now: Date = Date()) throws -> Self {
            guard kind == Self.kindValue,
                  protocolVersion == AidenRemoteProtocol.version,
                  sessionId.range(
                    of: "^pairing_[A-Za-z0-9_-]{32}$",
                    options: .regularExpression
                  ) != nil,
                  expiresAt > now,
                  expiresAt.timeIntervalSince(now) <= 5 * 60,
                  salt.count == 16,
                  nonce.count == 12,
                  !ciphertext.isEmpty,
                  ciphertext.count <= AidenRemoteProtocol.maxPairingPayloadBytes,
                  tag.count == 16 else {
                throw AidenManualPairingError.invalidBootstrap
            }
            return self
        }

        var keyDerivationInfo: Data {
            Data("\(Self.kindValue)\n\(sessionId)".utf8)
        }

        var additionalAuthenticatedData: Data {
            Data("\(Self.kindValue)\n\(sessionId)\n\(rawExpiresAt)".utf8)
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case kind, protocolVersion, sessionId, expiresAt, salt, nonce, ciphertext, tag
        }
    }

    struct PairingBootstrap: Codable, Equatable {
        let protocolVersion: Int
        let instanceId: String
        let endpoint: URL
        fileprivate let rawEndpoint: String
        let serverSpkiSha256: String
        let secret: String
        let expiresAt: Date

        init(
            protocolVersion: Int,
            instanceId: String,
            endpoint: URL,
            serverSpkiSha256: String,
            secret: String,
            expiresAt: Date
        ) {
            self.protocolVersion = protocolVersion
            self.instanceId = instanceId
            self.endpoint = endpoint
            self.rawEndpoint = endpoint.absoluteString
            self.serverSpkiSha256 = serverSpkiSha256
            self.secret = secret
            self.expiresAt = expiresAt
        }

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
            instanceId = try boundedString(
                values,
                forKey: .instanceId,
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                field: "instanceId",
                required: true
            )!
            let rawEndpoint = try values.decode(String.self, forKey: .endpoint)
            guard isCanonicalAidenEndpoint(rawEndpoint), let endpoint = URL(string: rawEndpoint) else {
                throw AidenPairingBootstrapError.invalidEndpoint
            }
            self.endpoint = endpoint
            self.rawEndpoint = rawEndpoint
            serverSpkiSha256 = try values.decode(String.self, forKey: .serverSpkiSha256)
            secret = try values.decode(String.self, forKey: .secret)
            expiresAt = try values.decode(Date.self, forKey: .expiresAt)
        }

        @discardableResult
        func validated(at now: Date = Date()) throws -> Self {
            guard protocolVersion == AidenRemoteProtocol.version else {
                throw AidenPairingBootstrapError.unsupportedProtocol
            }
            guard !instanceId.isEmpty,
                  instanceId.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength else {
                throw AidenPairingBootstrapError.invalidInstance
            }
            guard isCanonicalAidenEndpoint(rawEndpoint) else {
                throw AidenPairingBootstrapError.invalidEndpoint
            }
            guard serverSpkiSha256.range(
                of: "^sha256/[A-Za-z0-9+/]{43}=$",
                options: .regularExpression
            ) != nil else {
                throw AidenPairingBootstrapError.invalidFingerprint
            }
            let encodedFingerprint = String(serverSpkiSha256.dropFirst("sha256/".count))
            guard serverSpkiSha256.hasPrefix("sha256/"),
                  let fingerprint = Data(base64Encoded: encodedFingerprint),
                  fingerprint.count == 32 else {
                throw AidenPairingBootstrapError.invalidFingerprint
            }
            guard secret.base64URLDecoded?.count == 32,
                  secret.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
                throw AidenPairingBootstrapError.weakSecret
            }
            guard expiresAt > now else { throw AidenPairingBootstrapError.expired }
            guard expiresAt.timeIntervalSince(now) <= 5 * 60 else {
                throw AidenPairingBootstrapError.excessiveTTL
            }
            return self
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case protocolVersion, instanceId, endpoint, serverSpkiSha256, secret, expiresAt
        }
    }

    struct PairingTrust: Codable, Equatable, Sendable {
        enum Mode: String, Codable, Sendable {
            case privateCA = "private-ca"
            case system
        }

        let mode: Mode
        let caCertificateDerBase64: String?

        init(mode: Mode, caCertificateDerBase64: String? = nil) {
            self.mode = mode
            self.caCertificateDerBase64 = caCertificateDerBase64
        }

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            mode = try values.decode(Mode.self, forKey: .mode)
            caCertificateDerBase64 = try values.decodeIfPresent(
                String.self,
                forKey: .caCertificateDerBase64
            )
            _ = try validated()
        }

        @discardableResult
        func validated() throws -> Self {
            switch mode {
            case .system:
                guard caCertificateDerBase64 == nil else {
                    throw AidenPairingPayloadError.invalidTrust
                }
            case .privateCA:
                guard let value = caCertificateDerBase64,
                      !value.isEmpty,
                      let data = Data(base64Encoded: value),
                      data.count <= AidenRemoteProtocol.maxPairingPayloadBytes,
                      data.base64EncodedString() == value else {
                    throw AidenPairingPayloadError.invalidCACertificateData
                }
            }
            return self
        }

        var caCertificateDER: Data? {
            guard mode == .privateCA,
                  let value = caCertificateDerBase64 else { return nil }
            return Data(base64Encoded: value)
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case mode, caCertificateDerBase64
        }
    }

    struct PairingPayload: Codable, Equatable {
        static let kindValue = "aiden-pairing-v1"

        let kind: String
        let bootstrap: PairingBootstrap
        let trust: PairingTrust

        init(bootstrap: PairingBootstrap, trust: PairingTrust) {
            kind = Self.kindValue
            self.bootstrap = bootstrap
            self.trust = trust
        }

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            kind = try values.decode(String.self, forKey: .kind)
            guard kind == Self.kindValue else { throw AidenPairingPayloadError.invalidKind }
            bootstrap = try values.decode(PairingBootstrap.self, forKey: .bootstrap)
            trust = try values.decode(PairingTrust.self, forKey: .trust)
        }

        @discardableResult
        func validated(at now: Date = Date()) throws -> Self {
            guard kind == Self.kindValue else { throw AidenPairingPayloadError.invalidKind }
            _ = try bootstrap.validated(at: now)
            _ = try trust.validated()
            return self
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case kind, bootstrap, trust
        }
    }

    struct PairingExchange: Codable, Equatable {
        let protocolVersion: Int
        let instanceId: String
        let deviceId: String
        let credential: String
        let capabilities: [AidenRemoteCapability]
        let endpoint: URL
        fileprivate let rawEndpoint: String
        let serverSpkiSha256: String
        let displayName: String?

        init(
            protocolVersion: Int,
            instanceId: String,
            deviceId: String,
            credential: String,
            capabilities: [AidenRemoteCapability],
            endpoint: URL,
            serverSpkiSha256: String,
            displayName: String? = nil
        ) {
            self.protocolVersion = protocolVersion
            self.instanceId = instanceId
            self.deviceId = deviceId
            self.credential = credential
            self.capabilities = capabilities
            self.endpoint = endpoint
            self.rawEndpoint = endpoint.absoluteString
            self.serverSpkiSha256 = serverSpkiSha256
            self.displayName = displayName
        }

        init(from decoder: Decoder) throws {
            let dynamic = try decoder.container(keyedBy: AidenDynamicCodingKey.self)
            try assertKnownKeys(dynamic, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
            let values = try decoder.container(keyedBy: CodingKeys.self)
            protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
            instanceId = try boundedString(
                values,
                forKey: .instanceId,
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                field: "instanceId",
                required: true
            )!
            deviceId = try boundedString(
                values,
                forKey: .deviceId,
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                field: "deviceId",
                required: true
            )!
            credential = try values.decode(String.self, forKey: .credential)
            capabilities = try values.decode([AidenRemoteCapability].self, forKey: .capabilities)
            let rawEndpoint = try values.decode(String.self, forKey: .endpoint)
            guard isCanonicalAidenEndpoint(rawEndpoint), let endpoint = URL(string: rawEndpoint) else {
                throw AidenRemoteContractError.invalidPairingExchange
            }
            self.endpoint = endpoint
            self.rawEndpoint = rawEndpoint
            serverSpkiSha256 = try values.decode(String.self, forKey: .serverSpkiSha256)
            displayName = try boundedString(
                values,
                forKey: .displayName,
                maxLength: 80,
                field: "displayName",
                required: false
            )
        }

        func validated(against bootstrap: PairingBootstrap) throws -> Self {
            guard protocolVersion == AidenRemoteProtocol.version,
                  !instanceId.isEmpty,
                  instanceId.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength,
                  !deviceId.isEmpty,
                  deviceId.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength,
                  instanceId == bootstrap.instanceId,
                  isCanonicalAidenEndpoint(rawEndpoint),
                  rawEndpoint == bootstrap.rawEndpoint,
                  endpoint == bootstrap.endpoint,
                  endpoint.absoluteString.utf8.count <= AidenRemoteProtocol.maxEndpointLength,
                  serverSpkiSha256 == bootstrap.serverSpkiSha256,
                  credential.base64URLDecoded?.count == 32,
                  credential.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  Set(capabilities).count == capabilities.count,
                  Set(capabilities).isSubset(of: Set(AidenRemoteCapability.v1Known)) else {
                throw AidenRemoteContractError.invalidPairingExchange
            }
            return self
        }

        private enum CodingKeys: String, CodingKey, CaseIterable {
            case protocolVersion, instanceId, deviceId, credential, capabilities, endpoint, serverSpkiSha256, displayName
        }
    }

    let contractRevision: Int
    let protocolVersion: Int
    let capabilities: [AidenRemoteCapability]
    let health: Health
    let pairingBootstrap: PairingBootstrap
    let pairingExchange: PairingExchange
    let streamStatus: AidenStreamStatus
    let streamApproval: AidenStreamApprovalSnapshot
    let events: [AidenRemoteStreamEvent]
    let error: AidenRemoteErrorEnvelope
}

extension String {
    var base64URLDecoded: Data? {
        var value = replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        return Data(base64Encoded: value)
    }

    var canonicalBase64URLDecoded: Data? {
        guard !isEmpty,
              unicodeScalars.allSatisfy({ $0.isASCII }),
              range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              count % 4 != 1,
              let decoded = base64URLDecoded else { return nil }
        let canonical = decoded.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return canonical == self ? decoded : nil
    }
}

enum AidenRemoteJSONDecoder {
    static func decode<Value: Decodable>(
        _ type: Value.Type,
        from data: Data,
        maximumBytes: Int = AidenRemoteProtocol.maxJSONBodyBytes
    ) throws -> Value {
        try JSONDecoder.aidenRemote().decodeAidenRemote(type, from: data, maximumBytes: maximumBytes)
    }

    static func decodeSSEEvent(from data: Data) throws -> AidenRemoteStreamEvent {
        try JSONDecoder.aidenRemote().decodeAidenRemoteStreamEvent(from: data)
    }

    static func decodePairingBootstrap(
        from data: Data
    ) throws -> AidenRemoteContractFixture.PairingBootstrap {
        try decode(AidenRemoteContractFixture.PairingBootstrap.self, from: data)
    }

    static func decodePairingPayload(
        from data: Data
    ) throws -> AidenRemoteContractFixture.PairingPayload {
        guard data.count <= AidenRemoteProtocol.maxPairingPayloadBytes else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        return try decode(AidenRemoteContractFixture.PairingPayload.self, from: data)
    }

    static func decodeManualPairingBootstrap(
        from data: Data
    ) throws -> AidenRemoteContractFixture.ManualPairingBootstrap {
        try decode(
            AidenRemoteContractFixture.ManualPairingBootstrap.self,
            from: data,
            maximumBytes: AidenRemoteProtocol.maxPairingPayloadBytes * 2
        )
    }
}

extension JSONDecoder {
    static func aidenRemote() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .strictRFC3339
        return decoder
    }

    func decodeAidenRemote<Value: Decodable>(
        _ type: Value.Type,
        from data: Data,
        maximumBytes: Int = AidenRemoteProtocol.maxJSONBodyBytes
    ) throws -> Value {
        guard data.count <= maximumBytes else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        try AidenRawJSONDuplicateKeyScanner.validate(data)
        _ = try decode(AidenUnknownJSONValue.self, from: data)
        return try decode(type, from: data)
    }

    func decodeAidenRemoteStreamEvent(from data: Data) throws -> AidenRemoteStreamEvent {
        guard data.count <= AidenRemoteProtocol.maxSSEFrameBytes else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        return try decodeAidenRemote(AidenRemoteStreamEvent.self, from: data)
    }
}

private enum AidenStrictRFC3339Date {
    private static let pattern = try! NSRegularExpression(
        pattern: #"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"#
    )

    static func date(from value: String) -> Date? {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = pattern.firstMatch(in: value, options: [], range: range),
              match.range.location == range.location,
              match.range.length == range.length else {
            return nil
        }

        func capture(_ index: Int) -> String? {
            let captureRange = match.range(at: index)
            guard captureRange.location != NSNotFound,
                  let swiftRange = Range(captureRange, in: value) else {
                return nil
            }
            return String(value[swiftRange])
        }

        guard let year = capture(1).flatMap(Int.init),
              let month = capture(2).flatMap(Int.init),
              let day = capture(3).flatMap(Int.init),
              let hour = capture(4).flatMap(Int.init),
              let minute = capture(5).flatMap(Int.init),
              let second = capture(6).flatMap(Int.init),
              let offset = capture(8) else {
            return nil
        }

        let leapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
        let daysInMonth: [Int] = [
            31, leapYear ? 29 : 28, 31, 30, 31, 30,
            31, 31, 30, 31, 30, 31,
        ]
        guard (1...12).contains(month),
              (1...daysInMonth[month - 1]).contains(day),
              (0...23).contains(hour),
              (0...59).contains(minute),
              (0...59).contains(second) else {
            return nil
        }

        let fractionDigits = capture(7).map { String($0.dropFirst()) } ?? ""
        let milliseconds = Int(String((fractionDigits + "000").prefix(3))) ?? 0
        let offsetHours: Int
        let offsetMinutes: Int
        let offsetSign: Int
        if offset == "Z" {
            offsetHours = 0
            offsetMinutes = 0
            offsetSign = 1
        } else {
            offsetHours = Int(offset.dropFirst().prefix(2)) ?? 0
            offsetMinutes = Int(offset.dropFirst(4).prefix(2)) ?? 0
            offsetSign = offset.first == "+" ? 1 : -1
        }
        guard offsetHours <= 23, offsetMinutes <= 59 else { return nil }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var components = DateComponents()
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        components.year = year
        components.month = month
        components.day = day
        components.hour = hour
        components.minute = minute
        components.second = second
        components.nanosecond = milliseconds * 1_000_000
        guard let date = calendar.date(from: components) else { return nil }

        let offsetSeconds = offsetSign * (offsetHours * 60 + offsetMinutes) * 60
        return date.addingTimeInterval(-TimeInterval(offsetSeconds))
    }
}

private extension JSONDecoder.DateDecodingStrategy {
    static let strictRFC3339 = custom { decoder in
        let container = try decoder.singleValueContainer()
        let value = try container.decode(String.self)
        if let date = AidenStrictRFC3339Date.date(from: value) { return date }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Expected a strict RFC 3339 timestamp."
        )
    }
}
