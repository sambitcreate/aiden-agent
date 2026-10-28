import Foundation

// Contract revision 25 (`bot-durable-session-v1`): a Bot's one durable
// conversation, its live event stream, and the turn controls. Revision 27 adds
// the `memory_update` and `routine_proposal` entries (`bot:cards`) and skips
// entry types this client does not know. Revision 37 (`bot:handoffs`) adds the
// waiting hand-off, the `paused` state, and pause and resume.

enum AidenBotSessionWire {
    static let maxEntries = 200
    static let maxTextLength = 100_000
    static let maxMessageLength = 32_000
    /// Revision 33: references one Bot message may spend.
    static let maxMessageAttachments = 10
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

    /// Submission ids: 1–64 ASCII letters, digits, `.`, `_`, `:` or `-`.
    static func validateSubmissionID(_ value: String, field: String) throws {
        let scalars = Array(value.unicodeScalars)
        guard (1...maxSubmissionIDLength).contains(scalars.count),
              scalars.allSatisfy({ scalar in
                  switch scalar.value {
                  case 48...57, 65...90, 97...122, 46, 95, 58, 45: true
                  default: false
                  }
              }) else {
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
    /// Revision 37 (`bot:handoffs`): the person paused the Bot. Nothing runs
    /// until they resume it. A Mac sends it only to a device holding
    /// `bot:handoffs`; any other device reads a paused Bot as `unavailable`.
    case paused
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
    /// Contract revision 30 (`bot:activity`): the submission the person's own
    /// message was sent as, the same id as the send receipt and the queued
    /// list. Absent on every other message and whenever the Mac no longer knows it.
    let submissionId: String?

    init(
        id: String,
        role: AidenBotSessionMessageRole,
        text: String,
        createdAt: AidenRemoteTimestamp?,
        label: String?,
        interrupted: Bool,
        submissionId: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.label = label
        self.interrupted = interrupted
        self.submissionId = submissionId
    }
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

/// A turn that ended without a reply. `retryText` is the user text a Retry
/// sends again as a new message; it is absent when there is nothing to resend.
struct AidenBotFailedTurn: Equatable, Sendable {
    let id: String
    let createdAt: AidenRemoteTimestamp?
    let retryText: String?
}

enum AidenBotRoutineProposalStatus: String, Codable, Sendable {
    case pending, accepted, dismissed
}

/// Contract revision 27 (`bot:cards`): a routine the Bot suggested. A pending
/// card is answered once through `POST …/routine-proposals/{proposalId}/respond`.
struct AidenBotRoutineProposalCard: Equatable, Sendable {
    let id: String
    let proposalId: String
    let name: String
    let prompt: String
    let label: String
    let status: AidenBotRoutineProposalStatus
    /// Present exactly when the proposal was accepted.
    let routineId: String?
    let createdAt: AidenRemoteTimestamp?

    /// The same card after the Mac settled it.
    func settled(_ result: AidenBotRoutineProposalRespondResult) -> Self {
        Self(
            id: id,
            proposalId: proposalId,
            name: name,
            prompt: prompt,
            label: label,
            status: result.status,
            routineId: result.routineId,
            createdAt: createdAt
        )
    }
}

enum AidenBotSessionEntry: Codable, Equatable, Identifiable, Sendable {
    case message(AidenBotSessionMessage)
    case connectCard(AidenBotConnectCard)
    case notice(id: String, notice: AidenBotSessionNotice)
    case failedTurn(AidenBotFailedTurn)
    /// Revision 27 (`bot:cards`): the Bot saved something to its memory.
    case memoryUpdate(id: String, createdAt: AidenRemoteTimestamp?)
    /// Revision 27 (`bot:cards`): a routine the Bot suggested.
    case routineProposal(AidenBotRoutineProposalCard)

    /// The entry types this client renders. A revision-27 client skips any
    /// other type instead of failing the whole session.
    static let knownTypes: Set<String> = [
        "message", "connect_card", "notice", "failed_turn", "memory_update", "routine_proposal",
    ]

    var id: String {
        switch self {
        case let .message(message): message.id
        case let .connectCard(card): card.id
        case let .notice(id, _): id
        case let .failedTurn(turn): turn.id
        case let .memoryUpdate(id, _): id
        case let .routineProposal(card): card.id
        }
    }

    /// The `type` of an entry object, read without validating anything else.
    static func wireType(from decoder: Decoder) throws -> String {
        try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .type)
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let type = try values.decode(String.self, forKey: .type)
        guard Self.knownTypes.contains(type) else {
            throw AidenBotContractError.invalidField("entry.type")
        }
        let id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validateEntryID(id, field: "entry.id")
        switch type {
        case "message":
            try AidenBotWire.requireOnlyKeys(
                decoder,
                allowed: ["type", "id", "role", "text", "createdAt", "label", "interrupted", "submissionId"]
            )
            let role = try values.decode(AidenBotSessionMessageRole.self, forKey: .role)
            let interrupted = try AidenBotWire.optional(Bool.self, from: values, forKey: .interrupted)
            guard interrupted == nil || (interrupted == true && role == .assistant) else {
                throw AidenBotContractError.invalidCombination("interrupted message")
            }
            let submissionId = try AidenBotWire.optional(String.self, from: values, forKey: .submissionId)
            if let submissionId {
                // Only the person's own message: never an assistant's, never a routine's labelled input.
                guard role == .user, !values.contains(.label) else {
                    throw AidenBotContractError.invalidCombination("message submissionId")
                }
                try AidenBotSessionWire.validateSubmissionID(submissionId, field: "message.submissionId")
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
                interrupted: interrupted == true,
                submissionId: submissionId
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
        case "failed_turn":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["type", "id", "createdAt", "retryText"])
            self = .failedTurn(AidenBotFailedTurn(
                id: id,
                createdAt: try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: .createdAt),
                retryText: try AidenBotWire.optionalString(
                    values,
                    forKey: .retryText,
                    maxLength: AidenBotSessionWire.maxTextLength
                )
            ))
        case "memory_update":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["type", "id", "createdAt"])
            self = .memoryUpdate(
                id: id,
                createdAt: try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: .createdAt)
            )
        case "routine_proposal":
            try AidenBotWire.requireOnlyKeys(
                decoder,
                allowed: ["type", "id", "proposalId", "name", "prompt", "label", "status", "routineId", "createdAt"]
            )
            let proposalId = try values.decode(String.self, forKey: .proposalId)
            try AidenBotProactiveWire.validateProposalID(proposalId)
            let status = try values.decode(AidenBotRoutineProposalStatus.self, forKey: .status)
            let routineId = try AidenBotWire.optional(String.self, from: values, forKey: .routineId)
            if let routineId {
                try AidenBotWire.validateIdentifier(
                    routineId,
                    field: "routineId",
                    maxLength: AidenBotProactiveWire.maxRoutineIDLength
                )
            }
            guard routineId == nil || status == .accepted else {
                throw AidenBotContractError.invalidCombination("routine proposal routineId")
            }
            self = .routineProposal(AidenBotRoutineProposalCard(
                id: id,
                proposalId: proposalId,
                name: try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotRoutineWire.maxNameLength),
                prompt: try AidenBotWire.requiredString(
                    values,
                    forKey: .prompt,
                    maxLength: AidenBotSessionWire.maxTextLength
                ),
                label: try AidenBotWire.requiredString(values, forKey: .label, maxLength: AidenBotSessionWire.maxLabelLength),
                status: status,
                routineId: routineId,
                createdAt: try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: .createdAt)
            ))
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
            try values.encodeIfPresent(message.submissionId, forKey: .submissionId)
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
        case let .failedTurn(turn):
            try values.encode("failed_turn", forKey: .type)
            try values.encode(turn.id, forKey: .id)
            try values.encodeIfPresent(turn.createdAt, forKey: .createdAt)
            try values.encodeIfPresent(turn.retryText, forKey: .retryText)
        case let .memoryUpdate(id, createdAt):
            try values.encode("memory_update", forKey: .type)
            try values.encode(id, forKey: .id)
            try values.encodeIfPresent(createdAt, forKey: .createdAt)
        case let .routineProposal(card):
            try values.encode("routine_proposal", forKey: .type)
            try values.encode(card.id, forKey: .id)
            try values.encode(card.proposalId, forKey: .proposalId)
            try values.encode(card.name, forKey: .name)
            try values.encode(card.prompt, forKey: .prompt)
            try values.encode(card.label, forKey: .label)
            try values.encode(card.status, forKey: .status)
            try values.encodeIfPresent(card.routineId, forKey: .routineId)
            try values.encodeIfPresent(card.createdAt, forKey: .createdAt)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type, id, role, text, createdAt, label, interrupted, submissionId
        case pluginId, name, iconId, reason, status, notice, retryText
        case proposalId, prompt, routineId
    }
}

/// One element of a session's `entries`: a known entry, or nil for a type
/// this client does not know (skipped, never an error). Known types are still
/// validated strictly.
private struct AidenBotSessionEntrySlot: Decodable {
    let entry: AidenBotSessionEntry?

    init(from decoder: Decoder) throws {
        let type = try AidenBotSessionEntry.wireType(from: decoder)
        entry = AidenBotSessionEntry.knownTypes.contains(type)
            ? try AidenBotSessionEntry(from: decoder)
            : nil
    }
}

/// A Bot's waiting A–E question (`question` on the session and `question` events).
/// Answered by `waitId`, once; the card is the shared `ask_user_question` card.
struct AidenRemoteBotQuestion: Codable, Equatable, Sendable {
    let waitId: String
    let toolCallId: String
    let questions: [AidenRemoteQuestion]

    init(waitId: String, toolCallId: String, questions: [AidenRemoteQuestion]) throws {
        guard (1...4).contains(questions.count) else { throw AidenBotContractError.invalidField("questions") }
        self.waitId = waitId
        self.toolCallId = toolCallId
        self.questions = questions
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["waitId", "toolCallId", "questions"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        waitId = try AidenBotWire.identifier(values, forKey: .waitId, maxLength: 64)
        toolCallId = try AidenBotWire.identifier(values, forKey: .toolCallId, maxLength: 128)
        questions = try values.decode([AidenRemoteQuestion].self, forKey: .questions)
        guard (1...4).contains(questions.count) else { throw AidenBotContractError.invalidField("questions") }
    }

    private enum CodingKeys: String, CodingKey {
        case waitId, toolCallId, questions
    }
}

/// A tool call the Bot is waiting to have approved (`approval` on the session
/// and `approval` events). Answered once, by `waitId`, through the generic
/// `POST /approvals/{waitId}/respond`. `canAllow` false (Computer Use) means
/// the phone may only deny it.
struct AidenRemoteBotApproval: Codable, Equatable, Sendable {
    static let maxToolCallIDLength = 128
    static let maxToolNameLength = 120
    static let maxSummaryLength = 2_000

    let waitId: String
    let toolCallId: String
    let toolName: String
    let summary: String
    let canAllow: Bool

    init(waitId: String, toolCallId: String, toolName: String, summary: String, canAllow: Bool) throws {
        try Self.validateWaitID(waitId)
        try AidenBotWire.validateString(toolCallId, field: "toolCallId", maxLength: Self.maxToolCallIDLength, allowEmpty: false)
        try AidenBotWire.validateString(toolName, field: "toolName", maxLength: Self.maxToolNameLength, allowEmpty: false)
        try AidenBotWire.validateString(summary, field: "summary", maxLength: Self.maxSummaryLength, allowEmpty: false)
        self.waitId = waitId
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.summary = summary
        self.canAllow = canAllow
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["waitId", "toolCallId", "toolName", "summary", "canAllow"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            waitId: try values.decode(String.self, forKey: .waitId),
            toolCallId: try values.decode(String.self, forKey: .toolCallId),
            toolName: try values.decode(String.self, forKey: .toolName),
            summary: try values.decode(String.self, forKey: .summary),
            canAllow: try values.decode(Bool.self, forKey: .canAllow)
        )
    }

    /// `^[A-Za-z0-9-]{1,64}$`, the host's Bot wait id grammar.
    private static func validateWaitID(_ value: String) throws {
        let scalars = Array(value.unicodeScalars)
        guard (1...64).contains(scalars.count),
              scalars.allSatisfy({ scalar in
                  switch scalar.value {
                  case 48...57, 65...90, 97...122, 45: true
                  default: false
                  }
              }) else {
            throw AidenBotContractError.invalidField("waitId")
        }
    }

    private enum CodingKeys: String, CodingKey {
        case waitId, toolCallId, toolName, summary, canAllow
    }
}

/// `POST /bots/{botId}/questions/{waitId}/answer` receipt.
struct AidenBotQuestionAnswerReceipt: Codable, Equatable, Sendable {
    let waitId: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["waitId"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        waitId = try AidenBotWire.identifier(values, forKey: .waitId, maxLength: 64)
    }

    private enum CodingKeys: String, CodingKey {
        case waitId
    }
}

// MARK: Contract revision 37 (`bot:handoffs`)

enum AidenBotHandoffWire {
    static let maxActionLength = 160
    static let maxWhyLength = 400
    static let maxNoteLength = 4_000
    static let maxURLLength = 2_048

    /// `^[A-Za-z0-9-]{1,64}$`, the host's Bot wait id grammar.
    static func validateWaitID(_ value: String) throws {
        let scalars = Array(value.unicodeScalars)
        guard (1...64).contains(scalars.count),
              scalars.allSatisfy({ scalar in
                  switch scalar.value {
                  case 48...57, 65...90, 97...122, 45: true
                  default: false
                  }
              }) else {
            throw AidenBotContractError.invalidField("waitId")
        }
    }

    /// An https page with a host and no user name or password, with nothing
    /// around it, at most 2,048 characters: what the Mac's own parser accepts.
    /// The Mac stores a page as its WHATWG `href`, which keeps characters
    /// RFC 3986 does not allow (`[`, `]`, `|`, `^` in a path or query), so the
    /// parse encodes them instead of refusing the card.
    static func isOpenURL(_ value: String) -> Bool {
        guard !value.isEmpty,
              value.unicodeScalars.count <= maxURLLength,
              value.trimmingCharacters(in: .whitespacesAndNewlines) == value,
              let components = URLComponents(string: value, encodingInvalidCharacters: true),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil else {
            return false
        }
        return true
    }

    static func isBlank(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// What a hand-off asks for: a step the person does (`action`), or signing in
/// to a site in the Bot's own browser on the Mac (`sign_in`).
enum AidenBotHandoffKind: String, Codable, Sendable {
    case action
    case signIn = "sign_in"
}

/// The hand-off a Bot waits on (`handoff` on the session and `handoff` frames).
/// Answered once, by `waitId`: Done or Skip, with an optional note. A sign-in
/// is finished on the Mac, so the phone offers Finish on your Mac and Skip.
/// Revision 40: a card a password-or-code rule opened carries
/// `takesNote: false` (`takesNote`), so it is answered without a note.
/// Revision 42: a step on the Bot's own browser or computer carries
/// `onMac: true` and no `open`, so the phone offers Finish on your Mac beside
/// Skip and Done.
struct AidenRemoteBotHandoff: Codable, Equatable, Sendable {
    struct Open: Codable, Equatable, Sendable {
        let url: String

        init(url: String) throws {
            guard AidenBotHandoffWire.isOpenURL(url) else { throw AidenBotContractError.invalidField("open.url") }
            self.url = url
        }

        init(from decoder: Decoder) throws {
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["url"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            try self.init(url: try values.decode(String.self, forKey: .url))
        }

        private enum CodingKeys: String, CodingKey { case url }
    }

    let waitId: String
    let kind: AidenBotHandoffKind
    /// The card's title after "Your turn: ".
    let action: String
    let why: String?
    let open: Open?
    /// Revision 40: false on a card whose answer may carry no note, so the
    /// composer holds instead of sending a code to the Bot as Done's note.
    let takesNote: Bool
    /// Revision 42: the step is on the Bot's own screen on the Mac.
    let onMac: Bool

    init(
        waitId: String,
        kind: AidenBotHandoffKind,
        action: String,
        why: String? = nil,
        open: Open? = nil,
        takesNote: Bool = true,
        onMac: Bool = false
    ) throws {
        try AidenBotHandoffWire.validateWaitID(waitId)
        try AidenBotWire.validateString(action, field: "action", maxLength: AidenBotHandoffWire.maxActionLength, allowEmpty: false)
        guard !AidenBotHandoffWire.isBlank(action) else { throw AidenBotContractError.invalidField("action") }
        if let why {
            try AidenBotWire.validateString(why, field: "why", maxLength: AidenBotHandoffWire.maxWhyLength, allowEmpty: false)
        }
        self.waitId = waitId
        self.kind = kind
        self.action = action
        self.why = why
        self.open = open
        self.takesNote = takesNote
        self.onMac = onMac
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["waitId", "kind", "action", "why", "open", "takesNote", "onMac"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        // Only ever `false` when present (revision 40).
        let takesNote = try AidenBotWire.optional(Bool.self, from: values, forKey: .takesNote)
        if takesNote == true { throw AidenBotContractError.invalidField("takesNote") }
        // Only ever `true`, on an action without `open` (revision 42).
        let onMac = try AidenBotWire.optional(Bool.self, from: values, forKey: .onMac)
        if onMac == false { throw AidenBotContractError.invalidField("onMac") }
        let kind = try values.decode(AidenBotHandoffKind.self, forKey: .kind)
        let open = try AidenBotWire.optional(Open.self, from: values, forKey: .open)
        if onMac == true, kind != .action || open != nil { throw AidenBotContractError.invalidField("onMac") }
        try self.init(
            waitId: try values.decode(String.self, forKey: .waitId),
            kind: kind,
            action: try values.decode(String.self, forKey: .action),
            why: try AidenBotWire.optional(String.self, from: values, forKey: .why),
            open: open,
            takesNote: takesNote == nil,
            onMac: onMac == true
        )
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(waitId, forKey: .waitId)
        try values.encode(kind, forKey: .kind)
        try values.encode(action, forKey: .action)
        try values.encodeIfPresent(why, forKey: .why)
        try values.encodeIfPresent(open, forKey: .open)
        if !takesNote { try values.encode(false, forKey: .takesNote) }
        if onMac { try values.encode(true, forKey: .onMac) }
    }

    private enum CodingKeys: String, CodingKey {
        case waitId, kind, action, why, open, takesNote, onMac
    }
}

enum AidenBotHandoffOutcome: String, Codable, Sendable {
    case done, skipped
}

/// `POST /bots/{botId}/handoffs/{waitId}/answer` body. A note is non-blank
/// and at most 4,000 characters; a sign-in can only be skipped from a phone.
struct AidenBotHandoffAnswerRequest: Codable, Equatable, Sendable {
    let outcome: AidenBotHandoffOutcome
    let note: String?

    init(outcome: AidenBotHandoffOutcome, note: String? = nil) throws {
        if let note {
            guard !AidenBotHandoffWire.isBlank(note),
                  note.unicodeScalars.count <= AidenBotHandoffWire.maxNoteLength else {
                throw AidenBotContractError.invalidField("note")
            }
        }
        self.outcome = outcome
        self.note = note
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["outcome", "note"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            outcome: try values.decode(AidenBotHandoffOutcome.self, forKey: .outcome),
            note: try AidenBotWire.optional(String.self, from: values, forKey: .note)
        )
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(outcome, forKey: .outcome)
        try values.encodeIfPresent(note, forKey: .note)
    }

    private enum CodingKeys: String, CodingKey { case outcome, note }
}

/// The hand-off answer receipt: the wait it settled.
struct AidenBotHandoffAnswerReceipt: Codable, Equatable, Sendable {
    let waitId: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["waitId"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        waitId = try values.decode(String.self, forKey: .waitId)
        try AidenBotHandoffWire.validateWaitID(waitId)
    }

    private enum CodingKeys: String, CodingKey { case waitId }
}

/// `POST /bots/{botId}/handoffs/{waitId}/open-on-mac` receipt: whether the Mac
/// brought the hand-off forward. The wait stays open either way.
struct AidenBotHandoffOpenOnMacReceipt: Codable, Equatable, Sendable {
    let waitId: String
    let opened: Bool

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["waitId", "opened"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        waitId = try values.decode(String.self, forKey: .waitId)
        try AidenBotHandoffWire.validateWaitID(waitId)
        opened = try values.decode(Bool.self, forKey: .opened)
    }

    private enum CodingKeys: String, CodingKey { case waitId, opened }
}

// MARK: Contract revision 30 (`bot-activity-v1`, `bot:activity`)

/// What a Bot in a running turn is doing (spec §5). Exactly `phase`, `app`
/// and `startedAt` cross the wire; any other key is refused (§11).
struct AidenBotSessionActivity: Codable, Equatable, Sendable {
    static let maxAppLength = 40

    let phase: String
    /// The connection's label for the `app` phase.
    let app: String?
    /// When the turn started: the Mac's clock, milliseconds since 1970.
    let startedAt: Int

    init(phase: String, app: String? = nil, startedAt: Int) {
        self.phase = phase
        self.app = app
        self.startedAt = startedAt
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["phase", "app", "startedAt"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        phase = try values.decode(String.self, forKey: .phase)
        guard Self.isPhaseID(phase) else { throw AidenBotContractError.invalidField("activity.phase") }
        app = try AidenBotWire.optionalString(values, forKey: .app, maxLength: Self.maxAppLength)
        startedAt = try values.decode(Int.self, forKey: .startedAt)
        guard (0...AidenRemoteProtocol.maxSafeInteger).contains(startedAt) else {
            throw AidenBotContractError.invalidField("activity.startedAt")
        }
    }

    /// `^[a-z][a-z_]{0,31}$`: a newer Mac's phase still decodes, and reads as Working.
    static func isPhaseID(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard (1...32).contains(scalars.count), let first = scalars.first, (97...122).contains(first.value) else {
            return false
        }
        return scalars.allSatisfy { (97...122).contains($0.value) || $0 == "_" }
    }

    private enum CodingKeys: String, CodingKey { case phase, app, startedAt }
}

/// A message waiting for the running turn: `steer` joins it, `queue` runs after it.
struct AidenBotQueuedMessage: Codable, Equatable, Sendable {
    static let maxCount = 20

    let submissionId: String
    let mode: AidenStreamInputMode
    let text: String

    init(submissionId: String, mode: AidenStreamInputMode, text: String) {
        self.submissionId = submissionId
        self.mode = mode
        self.text = text
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["submissionId", "mode", "text"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        submissionId = try AidenBotWire.requiredString(
            values,
            forKey: .submissionId,
            maxLength: AidenBotSessionWire.maxSubmissionIDLength
        )
        try AidenBotSessionWire.validateSubmissionID(submissionId, field: "queued.submissionId")
        mode = try values.decode(AidenStreamInputMode.self, forKey: .mode)
        text = try AidenBotWire.requiredString(values, forKey: .text, maxLength: AidenBotSessionWire.maxMessageLength)
    }

    /// Decodes a queued list and enforces its limits: at most 20, each id once.
    ///
    /// - Warning: Decode a list only through here. A bare `[AidenBotQueuedMessage]`
    ///   decode checks each message but skips the list limits.
    static func decodeList<Key: CodingKey>(from container: KeyedDecodingContainer<Key>, forKey key: Key) throws -> [Self] {
        let list = try container.decode([Self].self, forKey: key)
        guard list.count <= maxCount, Set(list.map(\.submissionId)).count == list.count else {
            throw AidenBotContractError.invalidField("queued")
        }
        return list
    }

    private enum CodingKeys: String, CodingKey { case submissionId, mode, text }
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
    /// The question the Bot is waiting on, or nil.
    let question: AidenRemoteBotQuestion?
    /// The oldest tool approval the Bot is waiting on, or nil.
    let approval: AidenRemoteBotApproval?
    /// Revision 30 (`bot:activity`): what the running turn is doing, or nil.
    let activity: AidenBotSessionActivity?
    /// Revision 30 (`bot:activity`): the person's messages waiting for the turn.
    let queued: [AidenBotQueuedMessage]
    /// Revision 37 (`bot:handoffs`): the hand-off the Bot waits on, or nil.
    let handoff: AidenRemoteBotHandoff?

    var state: AidenBotSessionStateKind { stateView.state }

    init(
        botId: String,
        epoch: String,
        seq: Int,
        stateView: AidenBotSessionStateView,
        partial: String?,
        entries: [AidenBotSessionEntry],
        hasOlder: Bool,
        question: AidenRemoteBotQuestion? = nil,
        approval: AidenRemoteBotApproval? = nil,
        activity: AidenBotSessionActivity? = nil,
        queued: [AidenBotQueuedMessage] = [],
        handoff: AidenRemoteBotHandoff? = nil
    ) {
        self.botId = botId
        self.epoch = epoch
        self.seq = seq
        self.stateView = stateView
        self.partial = partial
        self.entries = entries
        self.hasOlder = hasOlder
        self.question = question
        self.approval = approval
        self.activity = activity
        self.queued = queued
        self.handoff = handoff
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: [
                "botId", "epoch", "seq", "state", "interrupted", "blocked", "partial", "entries", "hasOlder",
                "question", "approval", "activity", "queued", "handoff",
            ]
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
        let slots = try values.decode([AidenBotSessionEntrySlot].self, forKey: .entries)
        guard slots.count <= AidenBotSessionWire.maxEntries else {
            throw AidenBotContractError.invalidField("entries")
        }
        entries = slots.compactMap(\.entry)
        hasOlder = try values.decode(Bool.self, forKey: .hasOlder)
        question = try values.decode(AidenRemoteBotQuestion?.self, forKey: .question)
        approval = try values.decode(AidenRemoteBotApproval?.self, forKey: .approval)
        activity = try values.decodeIfPresent(AidenBotSessionActivity.self, forKey: .activity)
        if values.contains(.queued) {
            queued = try AidenBotQueuedMessage.decodeList(from: values, forKey: .queued)
        } else {
            queued = []
        }
        // Present (possibly null) only for a device holding `bot:handoffs`.
        handoff = try values.decodeIfPresent(AidenRemoteBotHandoff.self, forKey: .handoff)
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
        try values.encode(question, forKey: .question)
        try values.encode(approval, forKey: .approval)
        try values.encodeIfPresent(activity, forKey: .activity)
        if !queued.isEmpty { try values.encode(queued, forKey: .queued) }
        try values.encodeIfPresent(handoff, forKey: .handoff)
    }

    private enum CodingKeys: String, CodingKey {
        case botId, epoch, seq, partial, entries, hasOlder, question, approval, activity, queued, handoff
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
        /// An `entry` frame of a type this client does not know. It still
        /// advances the sequence, but changes nothing on screen.
        case unknownEntry(type: String)
        case state(AidenBotSessionStateView)
        /// The waiting question appeared (`question`) or was settled (nil).
        case question(AidenRemoteBotQuestion?)
        /// The waiting tool approval appeared (`approval`) or was settled (nil).
        case approval(AidenRemoteBotApproval?)
        /// Revision 30: what the running turn is doing now, or nil when none runs.
        case activity(AidenBotSessionActivity?)
        /// Revision 30: the person's messages still waiting for the turn.
        case queued([AidenBotQueuedMessage])
        /// Revision 37: the waiting hand-off appeared (`handoff`) or was settled (nil).
        case handoff(AidenRemoteBotHandoff?)
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
        case .entry, .unknownEntry: "entry"
        case .state: "state"
        case .question: "question"
        case .approval: "approval"
        case .activity: "activity"
        case .queued: "queued"
        case .handoff: "handoff"
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
            let entryDecoder = try fields.superDecoder(forKey: .entry)
            let type = try AidenBotSessionEntry.wireType(from: entryDecoder)
            kind = AidenBotSessionEntry.knownTypes.contains(type)
                ? .entry(try AidenBotSessionEntry(from: entryDecoder))
                : .unknownEntry(type: type)
        case "state":
            kind = .state(try AidenBotSessionStateView(from: payload))
        case "question":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["question"])
            kind = .question(try fields.decode(AidenRemoteBotQuestion?.self, forKey: .question))
        case "approval":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["approval"])
            kind = .approval(try fields.decode(AidenRemoteBotApproval?.self, forKey: .approval))
        case "activity":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["activity"])
            guard fields.contains(.activity) else { throw AidenBotContractError.invalidField("activity") }
            kind = .activity(try fields.decode(AidenBotSessionActivity?.self, forKey: .activity))
        case "queued":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["queued"])
            kind = .queued(try AidenBotQueuedMessage.decodeList(from: fields, forKey: .queued))
        case "handoff":
            try AidenBotWire.requireOnlyKeys(payload, allowed: ["handoff"])
            guard fields.contains(.handoff) else { throw AidenBotContractError.invalidField("handoff") }
            kind = .handoff(try fields.decode(AidenRemoteBotHandoff?.self, forKey: .handoff))
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
        case let .unknownEntry(type):
            var entry = fields.nestedContainer(keyedBy: AidenBotDynamicCodingKey.self, forKey: .entry)
            if let key = AidenBotDynamicCodingKey(stringValue: "type") { try entry.encode(type, forKey: key) }
        case let .state(view): try view.encode(to: payload)
        case let .question(question): try fields.encode(question, forKey: .question)
        case let .approval(approval): try fields.encode(approval, forKey: .approval)
        case let .activity(activity): try fields.encode(activity, forKey: .activity)
        case let .queued(list): try fields.encode(list, forKey: .queued)
        case let .handoff(handoff): try fields.encode(handoff, forKey: .handoff)
        case .closed: break
        }
    }

    private enum CodingKeys: String, CodingKey {
        case protocolVersion, botId, epoch, seq, type, payload
    }

    private enum PayloadKeys: String, CodingKey {
        case session, text, entry, question, approval, activity, queued, handoff
    }
}

/// `POST /bots/{botId}/messages` body.
struct AidenBotMessageRequest: Codable, Equatable, Sendable {
    let text: String
    /// Revision 30 (`bot-activity-v1`): Steer joins the running turn; Queue runs after it.
    let whenBusy: AidenStreamInputMode?
    /// Revision 33 (`bot-attachments-v1`): staged uploads this message spends.
    /// Absent (never empty) without attachments; with them the text may be empty.
    let attachmentIds: [String]?

    init(text: String, whenBusy: AidenStreamInputMode? = nil, attachmentIds: [String] = []) throws {
        guard attachmentIds.count <= AidenBotSessionWire.maxMessageAttachments,
              Set(attachmentIds).count == attachmentIds.count,
              attachmentIds.allSatisfy({ $0.range(of: #"^att_[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil }) else {
            throw AidenBotContractError.invalidField("attachmentIds")
        }
        guard !attachmentIds.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.unicodeScalars.count <= AidenBotSessionWire.maxMessageLength else {
            throw AidenBotContractError.invalidField("text")
        }
        self.text = text
        self.whenBusy = whenBusy
        self.attachmentIds = attachmentIds.isEmpty ? nil : attachmentIds
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["text", "whenBusy", "attachmentIds"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let attachmentIds = try values.decodeIfPresent([String].self, forKey: .attachmentIds)
        // An empty list is refused on the wire, never read as no attachments.
        if attachmentIds?.isEmpty == true { throw AidenBotContractError.invalidField("attachmentIds") }
        try self.init(
            text: try values.decode(String.self, forKey: .text),
            whenBusy: try values.decodeIfPresent(AidenStreamInputMode.self, forKey: .whenBusy),
            attachmentIds: attachmentIds ?? []
        )
    }

    private enum CodingKeys: String, CodingKey { case text, whenBusy, attachmentIds }
}

/// The empty `{}` body of resume, dismiss, stop, pause, and hand-off open-on-Mac.
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
