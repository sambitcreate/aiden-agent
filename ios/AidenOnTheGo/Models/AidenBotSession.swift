import Foundation

// Contract revision 25 (`bot-durable-session-v1`): a Bot's one durable
// conversation, its live event stream, and the turn controls.

enum AidenBotSessionWire {
    static let maxEntries = 200
    static let maxTextLength = 100_000
    static let maxMessageLength = 32_000
    static let maxLabelLength = 120
    static let maxReasonLength = 280
    static let maxEpochLength = 64
    static let maxSubmissionIDLength = 64

    static func validateEntryID(_ value: String, field: String) throws {
        try AidenBotWire.validateIdentifier(value, field: field, maxLength: AidenRemoteProtocol.maxIdentifierLength)
    }

    /// Plugin and preset identifiers: lowercase ASCII, digits, `.`, `_`, `-`.
    static func validatePluginID(_ value: String, field: String) throws {
        let scalars = Array(value.unicodeScalars)
        guard (1...80).contains(scalars.count),
              let first = scalars.first,
              isLowerAlphanumeric(first),
              scalars.allSatisfy({ isLowerAlphanumeric($0) || $0 == "." || $0 == "_" || $0 == "-" }) else {
            throw AidenBotContractError.invalidField(field)
        }
    }

    static func validateEpoch(_ value: String) throws {
        let scalars = Array(value.unicodeScalars)
        guard (1...maxEpochLength).contains(scalars.count),
              scalars.allSatisfy({ scalar in
                  switch scalar.value {
                  case 48...57, 65...90, 97...122, 45, 95: true
                  default: false
                  }
              }) else {
            throw AidenBotContractError.invalidField("epoch")
        }
    }

    static func validateSequence(_ value: Int) throws {
        guard (0...AidenRemoteProtocol.maxSafeInteger).contains(value) else {
            throw AidenBotContractError.invalidField("seq")
        }
    }

    private static func isLowerAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        (48...57).contains(scalar.value) || (97...122).contains(scalar.value)
    }
}

extension AidenRemoteTimestamp: Encodable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

enum AidenBotSessionStateKind: String, Codable, CaseIterable, Sendable {
    case idle, running, interrupted
    case needsModel = "needs_model"
    case unavailable
}

enum AidenBotSessionBlockedReason: String, Codable, Sendable {
    case accessChanged = "access_changed"
    case botMissing = "bot_missing"
}

/// `{state, interrupted, blocked?}`: `interrupted` is true exactly when the
/// state is `interrupted`, and `blocked` only appears while interrupted.
struct AidenBotSessionStateView: Codable, Equatable, Sendable {
    let state: AidenBotSessionStateKind
    let interrupted: Bool
    let blocked: AidenBotSessionBlockedReason?

    init(state: AidenBotSessionStateKind, blocked: AidenBotSessionBlockedReason? = nil) throws {
        guard blocked == nil || state == .interrupted else {
            throw AidenBotContractError.invalidCombination("bot session blocked")
        }
        self.state = state
        interrupted = state == .interrupted
        self.blocked = blocked
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["state", "interrupted", "blocked"])
        try self.init(flattenedFrom: decoder)
    }

    /// Decodes the state fields that sit beside other keys in a larger object.
    init(flattenedFrom decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        state = try values.decode(AidenBotSessionStateKind.self, forKey: .state)
        interrupted = try values.decode(Bool.self, forKey: .interrupted)
        blocked = try AidenBotWire.optional(AidenBotSessionBlockedReason.self, from: values, forKey: .blocked)
        guard interrupted == (state == .interrupted), blocked == nil || interrupted else {
            throw AidenBotContractError.invalidCombination("bot session state")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(state, forKey: .state)
        try values.encode(interrupted, forKey: .interrupted)
        try values.encodeIfPresent(blocked, forKey: .blocked)
    }

    private enum CodingKeys: String, CodingKey {
        case state, interrupted, blocked
    }
}

enum AidenBotSessionMessageRole: String, Codable, Sendable {
    case user, assistant
}

struct AidenBotSessionMessage: Equatable, Sendable {
    let id: String
    let role: AidenBotSessionMessageRole
    let text: String
    let createdAt: AidenRemoteTimestamp?
    /// The routine name shown above a routine's user turn.
    let label: String?
    /// An assistant answer that was cut off.
    let interrupted: Bool
}

enum AidenBotConnectCardStatus: String, Codable, Sendable {
    case pending, connected, dismissed
}

struct AidenBotConnectCard: Equatable, Sendable {
    let id: String
    let pluginId: String
    let name: String
    let iconId: String
    let reason: String
    let status: AidenBotConnectCardStatus
}

enum AidenBotSessionNotice: String, Codable, Sendable {
    case sessionReset = "session_reset"
}

enum AidenBotSessionEntry: Codable, Equatable, Identifiable, Sendable {
    case message(AidenBotSessionMessage)
    case connectCard(AidenBotConnectCard)
    case notice(id: String, notice: AidenBotSessionNotice)

    var id: String {
        switch self {
        case let .message(message): message.id
        case let .connectCard(card): card.id
        case let .notice(id, _): id
        }
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let type = try values.decode(String.self, forKey: .type)
        let id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validateEntryID(id, field: "entry.id")
        switch type {
        case "message":
            try AidenBotWire.requireOnlyKeys(
                decoder,
                allowed: ["type", "id", "role", "text", "createdAt", "label", "interrupted"]
            )
            let role = try values.decode(AidenBotSessionMessageRole.self, forKey: .role)
            let interrupted = try AidenBotWire.optional(Bool.self, from: values, forKey: .interrupted)
            guard interrupted == nil || (interrupted == true && role == .assistant) else {
                throw AidenBotContractError.invalidCombination("interrupted message")
            }
            self = .message(AidenBotSessionMessage(
                id: id,
                role: role,
                text: try AidenBotWire.requiredString(
                    values,
                    forKey: .text,
                    maxLength: AidenBotSessionWire.maxTextLength,
                    allowEmpty: true
                ),
                createdAt: try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: .createdAt),
                label: try AidenBotWire.optionalString(values, forKey: .label, maxLength: AidenBotSessionWire.maxLabelLength),
                interrupted: interrupted == true
            ))
        case "connect_card":
            try AidenBotWire.requireOnlyKeys(
                decoder,
                allowed: ["type", "id", "pluginId", "name", "iconId", "reason", "status"]
            )
            let pluginId = try values.decode(String.self, forKey: .pluginId)
            try AidenBotSessionWire.validatePluginID(pluginId, field: "pluginId")
            let iconId = try values.decode(String.self, forKey: .iconId)
            try AidenBotSessionWire.validatePluginID(iconId, field: "iconId")
            self = .connectCard(AidenBotConnectCard(
                id: id,
                pluginId: pluginId,
                name: try AidenBotWire.requiredString(values, forKey: .name, maxLength: 120),
                iconId: iconId,
                reason: try AidenBotWire.requiredString(
                    values,
                    forKey: .reason,
                    maxLength: AidenBotSessionWire.maxReasonLength
                ),
                status: try values.decode(AidenBotConnectCardStatus.self, forKey: .status)
            ))
        case "notice":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["type", "id", "notice"])
            self = .notice(id: id, notice: try values.decode(AidenBotSessionNotice.self, forKey: .notice))
        default:
            throw AidenBotContractError.invalidField("entry.type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .message(message):
            try values.encode("message", forKey: .type)
            try values.encode(message.id, forKey: .id)
            try values.encode(message.role, forKey: .role)
            try values.encode(message.text, forKey: .text)
            try values.encodeIfPresent(message.createdAt, forKey: .createdAt)
            try values.encodeIfPresent(message.label, forKey: .label)
            if message.interrupted { try values.encode(true, forKey: .interrupted) }
        case let .connectCard(card):
            try values.encode("connect_card", forKey: .type)
            try values.encode(card.id, forKey: .id)
            try values.encode(card.pluginId, forKey: .pluginId)
            try values.encode(card.name, forKey: .name)
            try values.encode(card.iconId, forKey: .iconId)
            try values.encode(card.reason, forKey: .reason)
            try values.encode(card.status, forKey: .status)
        case let .notice(id, notice):
            try values.encode("notice", forKey: .type)
            try values.encode(id, forKey: .id)
            try values.encode(notice, forKey: .notice)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, id, role, text, createdAt, label, interrupted
        case pluginId, name, iconId, reason, status, notice
    }
}

/// `GET /bots/{botId}/session`: the newest entries (newest last) plus the
/// in-flight assistant text, stamped with the `(epoch, seq)` it reflects.
struct AidenBotSession: Codable, Equatable, Sendable {
    let botId: String
    let epoch: String
    let seq: Int
    let stateView: AidenBotSessionStateView
    let partial: String?
    let entries: [AidenBotSessionEntry]
    let hasOlder: Bool

    var state: AidenBotSessionStateKind { stateView.state }

    init(
        botId: String,
        epoch: String,
        seq: Int,
        stateView: AidenBotSessionStateView,
        partial: String?,
        entries: [AidenBotSessionEntry],
        hasOlder: Bool
    ) {
        self.botId = botId
        self.epoch = epoch
        self.seq = seq
        self.stateView = stateView
        self.partial = partial
        self.entries = entries
        self.hasOlder = hasOlder
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["botId", "epoch", "seq", "state", "interrupted", "blocked", "partial", "entries", "hasOlder"]
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenBotWire.identifier(values, forKey: .botId, maxLength: AidenRemoteProtocol.maxBotIdentifierLength)
        epoch = try values.decode(String.self, forKey: .epoch)
        try AidenBotSessionWire.validateEpoch(epoch)
        seq = try values.decode(Int.self, forKey: .seq)
        try AidenBotSessionWire.validateSequence(seq)
        stateView = try AidenBotSessionStateView(flattenedFrom: decoder)
        partial = try AidenBotWire.optionalString(
            values,
            forKey: .partial,
            maxLength: AidenBotSessionWire.maxTextLength,
            allowEmpty: true
        )
        entries = try values.decode([AidenBotSessionEntry].self, forKey: .entries)
        hasOlder = try values.decode(Bool.self, forKey: .hasOlder)
        guard entries.count <= AidenBotSessionWire.maxEntries,
              Set(entries.map(\.id)).count == entries.count else {
            throw AidenBotContractError.invalidField("entries")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(botId, forKey: .botId)
        try values.encode(epoch, forKey: .epoch)
        try values.encode(seq, forKey: .seq)
        try stateView.encode(to: encoder)
        try values.encodeIfPresent(partial, forKey: .partial)
        try values.encode(entries, forKey: .entries)
        try values.encode(hasOlder, forKey: .hasOlder)
    }

    private enum CodingKeys: String, CodingKey {
        case botId, epoch, seq, partial, entries, hasOlder
    }
}

/// One frame of `GET /bots/{botId}/session/events`.
struct AidenBotSessionEvent: Codable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// Always the first frame of a connection; replaces everything.
        case snapshot(AidenBotSession)
        /// The full current partial text (not a delta); empty clears it.
        case partial(String)
        /// Append, or replace by id; clears the partial.
        case entry(AidenBotSessionEntry)
        case state(AidenBotSessionStateView)
        /// The host closed this session; reconnect for a new epoch.
        case closed
    }

    let botId: String
    let epoch: String
    let seq: Int
    let kind: Kind

    init(botId: String, epoch: String, seq: Int, kind: Kind) {
        self.botId = botId
        self.epoch = epoch
        self.seq = seq
        self.kind = kind
    }

    var wireType: String {
        switch kind {
        case .snapshot: "snapshot"
        case .partial: "partial"
        case .entry: "entry"
        case .state: "state"
        case .closed: "closed"
        }
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["protocolVersion", "botId", "epoch", "seq", "type", "payload"]
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Int.self, forKey: .protocolVersion) == AidenRemoteProtocol.version else {
            throw AidenRemoteContractError.invalidProtocolVersion
        }
        botId = try AidenBotWire.identifier(values, forKey: .botId, maxLength: AidenRemoteProtocol.maxBotIdentifierLength)
        epoch = try values.decode(String.self, forKey: .epoch)
        try AidenBotSessionWire.validateEpoch(epoch)
        seq = try values.decode(Int.self, forKey: .seq)
        try AidenBotSessionWire.validateSequence(seq)
        let payload = try values.superDecoder(forKey: .payload)
        let fields = try payload.container(keyedBy: PayloadKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "snapshot":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["session"])
            let session = try fields.decode(AidenBotSession.self, forKey: .session)
            guard session.botId == botId, session.epoch == epoch, session.seq == seq else {
                throw AidenBotContractError.invalidCombination("snapshot identity")
            }
            kind = .snapshot(session)
        case "partial":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["text"])
            kind = .partial(try AidenBotWire.requiredString(
                fields,
                forKey: .text,
                maxLength: AidenBotSessionWire.maxTextLength,
                allowEmpty: true
            ))
        case "entry":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["entry"])
            kind = .entry(try fields.decode(AidenBotSessionEntry.self, forKey: .entry))
        case "state":
            kind = .state(try AidenBotSessionStateView(from: payload))
        case "closed":
            try AidenBotWire.requireOnlyKeys(payload, allowed: [])
            kind = .closed
        default:
            throw AidenBotContractError.invalidField("type")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(AidenRemoteProtocol.version, forKey: .protocolVersion)
        try values.encode(botId, forKey: .botId)
        try values.encode(epoch, forKey: .epoch)
        try values.encode(seq, forKey: .seq)
        try values.encode(wireType, forKey: .type)
        let payload = values.superEncoder(forKey: .payload)
        var fields = payload.container(keyedBy: PayloadKeys.self)
        switch kind {
        case let .snapshot(session): try fields.encode(session, forKey: .session)
        case let .partial(text): try fields.encode(text, forKey: .text)
        case let .entry(entry): try fields.encode(entry, forKey: .entry)
        case let .state(view): try view.encode(to: payload)
        case .closed: break
        }
    }

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, botId, epoch, seq, type, payload
    }

    private enum PayloadKeys: String, CodingKey {
        case session, text, entry
    }
}

/// `POST /bots/{botId}/messages` body.
struct AidenBotMessageRequest: Codable, Equatable, Sendable {
    let text: String

    init(text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.unicodeScalars.count <= AidenBotSessionWire.maxMessageLength else {
            throw AidenBotContractError.invalidField("text")
        }
        self.text = text
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["text"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(text: try values.decode(String.self, forKey: .text))
    }

    private enum CodingKeys: String, CodingKey { case text }
}

/// The empty `{}` body of resume, dismiss, and stop.
struct AidenBotSessionActionRequest: Codable, Equatable, Sendable {
    init() {}

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: [])
    }

    func encode(to encoder: Encoder) throws {
        _ = encoder.container(keyedBy: AidenBotDynamicCodingKey.self)
    }
}

/// `POST /bots/{botId}/messages` receipt.
struct AidenBotMessageReceipt: Codable, Equatable, Sendable {
    let submissionId: String
    let deduped: Bool
    let stateView: AidenBotSessionStateView

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["submissionId", "deduped", "state", "interrupted", "blocked"]
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        submissionId = try AidenBotWire.requiredString(
            values,
            forKey: .submissionId,
            maxLength: AidenBotSessionWire.maxSubmissionIDLength
        )
        deduped = try values.decode(Bool.self, forKey: .deduped)
        stateView = try AidenBotSessionStateView(flattenedFrom: decoder)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(submissionId, forKey: .submissionId)
        try values.encode(deduped, forKey: .deduped)
        try stateView.encode(to: encoder)
    }

    private enum CodingKeys: String, CodingKey {
        case submissionId, deduped
    }
}
