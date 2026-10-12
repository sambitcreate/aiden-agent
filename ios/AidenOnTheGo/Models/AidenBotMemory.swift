import Foundation

// Contract revision 27 (`bot-memory-v1`): what a Bot remembers. Two groups,
// "About you" (`user`) and the Bot's own notes (`memory`), each a short list of
// plain-text entries under a character budget. Entry ids are content-addressed,
// so an edit naming text that changed since it was read fails instead of
// overwriting the newer text.

enum AidenBotMemoryWire {
    static let maxEntryLength = 500
    static let maxEntriesPerGroup = 64
    static let maxChars = 1_000_000

    /// The first 16 lowercase hex characters of a SHA-256.
    static func validateHexID(_ value: String, field: String) throws {
        let scalars = Array(value.unicodeScalars)
        guard scalars.count == 16,
              scalars.allSatisfy({ (48...57).contains($0.value) || (97...102).contains($0.value) }) else {
            throw AidenBotContractError.invalidField(field)
        }
    }
}

enum AidenBotMemoryTarget: String, Codable, CaseIterable, Sendable {
    /// About the person (USER.md).
    case user
    /// The Bot's own notes (MEMORY.md).
    case memory
}

struct AidenBotMemoryEntry: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let text: String

    init(id: String, text: String) throws {
        try AidenBotMemoryWire.validateHexID(id, field: "entry.id")
        try AidenBotWire.validateString(text, field: "entry.text", maxLength: AidenBotMemoryWire.maxEntryLength, allowEmpty: false)
        self.id = id
        self.text = text
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["id", "text"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            id: try values.decode(String.self, forKey: .id),
            text: try values.decode(String.self, forKey: .text)
        )
    }

    private enum CodingKeys: String, CodingKey { case id, text }
}

struct AidenBotMemoryGroup: Codable, Equatable, Sendable {
    let entries: [AidenBotMemoryEntry]
    let usedChars: Int
    let limitChars: Int
    let overBudget: Bool

    init(entries: [AidenBotMemoryEntry], usedChars: Int, limitChars: Int, overBudget: Bool) throws {
        guard entries.count <= AidenBotMemoryWire.maxEntriesPerGroup,
              Set(entries.map(\.id)).count == entries.count,
              (0...AidenBotMemoryWire.maxChars).contains(usedChars),
              (1...AidenBotMemoryWire.maxChars).contains(limitChars) else {
            throw AidenBotContractError.invalidField("memory group")
        }
        self.entries = entries
        self.usedChars = usedChars
        self.limitChars = limitChars
        self.overBudget = overBudget
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["entries", "usedChars", "limitChars", "overBudget"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            entries: try values.decode([AidenBotMemoryEntry].self, forKey: .entries),
            usedChars: try values.decode(Int.self, forKey: .usedChars),
            limitChars: try values.decode(Int.self, forKey: .limitChars),
            overBudget: try values.decode(Bool.self, forKey: .overBudget)
        )
    }

    /// Usage as a 0…1 fraction for the meter.
    var fraction: Double {
        min(1, max(0, Double(usedChars) / Double(limitChars)))
    }

    private enum CodingKeys: String, CodingKey { case entries, usedChars, limitChars, overBudget }
}

/// `GET /bots/{botId}/memory`.
struct AidenBotMemory: Codable, Equatable, Sendable {
    let botId: String
    let revision: String
    /// False when a memory file could not be read; only Erase is offered.
    let readable: Bool
    let memory: AidenBotMemoryGroup
    let user: AidenBotMemoryGroup
    /// Newest write, or nil when nothing was ever saved.
    let updatedAt: AidenRemoteTimestamp?

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["botId", "revision", "readable", "memory", "user", "updatedAt"]
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenBotWire.identifier(values, forKey: .botId, maxLength: AidenRemoteProtocol.maxBotIdentifierLength)
        revision = try values.decode(String.self, forKey: .revision)
        try AidenBotMemoryWire.validateHexID(revision, field: "revision")
        readable = try values.decode(Bool.self, forKey: .readable)
        memory = try values.decode(AidenBotMemoryGroup.self, forKey: .memory)
        user = try values.decode(AidenBotMemoryGroup.self, forKey: .user)
        guard values.contains(.updatedAt) else { throw AidenBotContractError.invalidField("updatedAt") }
        updatedAt = try values.decodeNil(forKey: .updatedAt)
            ? nil : try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(botId, forKey: .botId)
        try values.encode(revision, forKey: .revision)
        try values.encode(readable, forKey: .readable)
        try values.encode(memory, forKey: .memory)
        try values.encode(user, forKey: .user)
        if let updatedAt { try values.encode(updatedAt, forKey: .updatedAt) } else { try values.encodeNil(forKey: .updatedAt) }
    }

    func group(_ target: AidenBotMemoryTarget) -> AidenBotMemoryGroup {
        switch target {
        case .user: user
        case .memory: memory
        }
    }

    /// Every remembered entry, across both groups.
    var entryCount: Int { user.entries.count + memory.entries.count }

    private enum CodingKeys: String, CodingKey { case botId, revision, readable, memory, user, updatedAt }
}

/// One person edit. `replace` text is trimmed and 1–500 characters.
enum AidenBotMemoryEdit: Codable, Equatable, Sendable {
    case replace(target: AidenBotMemoryTarget, entryId: String, text: String)
    case remove(target: AidenBotMemoryTarget, entryId: String)
    case clear

    static func replacing(target: AidenBotMemoryTarget, entryId: String, text: String) throws -> Self {
        try AidenBotMemoryWire.validateHexID(entryId, field: "entryId")
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        try AidenBotWire.validateString(trimmed, field: "text", maxLength: AidenBotMemoryWire.maxEntryLength, allowEmpty: false)
        return .replace(target: target, entryId: entryId, text: trimmed)
    }

    static func removing(target: AidenBotMemoryTarget, entryId: String) throws -> Self {
        try AidenBotMemoryWire.validateHexID(entryId, field: "entryId")
        return .remove(target: target, entryId: entryId)
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "replace":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "target", "entryId", "text"])
            self = try .replacing(
                target: try values.decode(AidenBotMemoryTarget.self, forKey: .target),
                entryId: try values.decode(String.self, forKey: .entryId),
                text: try values.decode(String.self, forKey: .text)
            )
        case "remove":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "target", "entryId"])
            self = try .removing(
                target: try values.decode(AidenBotMemoryTarget.self, forKey: .target),
                entryId: try values.decode(String.self, forKey: .entryId)
            )
        case "clear":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind"])
            self = .clear
        default:
            throw AidenBotContractError.invalidField("edit.kind")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .replace(target, entryId, text):
            try values.encode("replace", forKey: .kind)
            try values.encode(target, forKey: .target)
            try values.encode(entryId, forKey: .entryId)
            try values.encode(text, forKey: .text)
        case let .remove(target, entryId):
            try values.encode("remove", forKey: .kind)
            try values.encode(target, forKey: .target)
            try values.encode(entryId, forKey: .entryId)
        case .clear:
            try values.encode("clear", forKey: .kind)
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, target, entryId, text }
}

/// `POST /bots/{botId}/memory/edits` body (`Idempotency-Key` required).
struct AidenBotMemoryEditRequest: Codable, Equatable, Sendable {
    let edit: AidenBotMemoryEdit

    init(edit: AidenBotMemoryEdit) {
        self.edit = edit
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["edit"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        edit = try values.decode(AidenBotMemoryEdit.self, forKey: .edit)
    }

    private enum CodingKeys: String, CodingKey { case edit }
}

/// `{ok: true, view}`: the memory after the edit.
struct AidenBotMemoryEditResponse: Codable, Equatable, Sendable {
    let view: AidenBotMemory

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["ok", "view"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Bool.self, forKey: .ok) else { throw AidenBotContractError.invalidField("ok") }
        view = try values.decode(AidenBotMemory.self, forKey: .view)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(true, forKey: .ok)
        try values.encode(view, forKey: .view)
    }

    private enum CodingKeys: String, CodingKey { case ok, view }
}

/// Why a memory edit failed, from the Mac's error code. None of these bodies
/// carry a view, so the caller refetches it.
enum AidenBotMemoryEditFailure: Equatable, Sendable {
    /// 404 `memory_entry_not_found`: the entry changed since it was read.
    case entryNotFound
    /// 422 `memory_over_budget`.
    case overBudget
    /// 422 `memory_blocked`: looks like a secret or an instruction.
    case blocked
    /// 422 `invalid_request` or anything else.
    case other

    init(_ error: Error) {
        guard case let AidenRemoteClientError.server(_, body) = error else {
            self = .other
            return
        }
        switch body.code.rawValue {
        case "memory_entry_not_found": self = .entryNotFound
        case "memory_over_budget": self = .overBudget
        case "memory_blocked": self = .blocked
        default: self = .other
        }
    }
}
