import Foundation

/// Remote Revision 59: person-facing connector watches. Provider bindings and polling stay on the host.
enum AidenBotWatchWire {
    static let intervals = [15, 30, 60]

    static func text(_ value: String, _ field: String, limit: Int, empty: Bool = false) throws {
        guard (empty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty), value.utf16.count <= limit else {
            throw AidenBotContractError.invalidField(field)
        }
    }

    static func requiredString<Key: CodingKey>(_ values: KeyedDecodingContainer<Key>, forKey key: Key, maxLength: Int) throws -> String {
        let value = try values.decode(String.self, forKey: key)
        try text(value, key.stringValue, limit: maxLength)
        return value
    }

    static func optionalString<Key: CodingKey>(_ values: KeyedDecodingContainer<Key>, forKey key: Key, maxLength: Int) throws -> String? {
        guard values.contains(key) else { return nil }
        return try requiredString(values, forKey: key, maxLength: maxLength)
    }

    static func uuid(_ value: String) throws {
        guard value.utf8.count == 36, UUID(uuidString: value) != nil else { throw AidenBotContractError.invalidField("watch identity") }
    }

    static func revision(_ value: String, removed: Bool = false) throws {
        let number = removed && value.hasPrefix("deleted:") ? String(value.dropFirst(8)) : value
        guard !number.isEmpty, number.count <= 32, number.first != "0",
              number.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw AidenBotContractError.invalidField("revision")
        }
    }

    static func timestamp(_ value: Int?) throws {
        if let value, !(0...AidenRemoteProtocol.maxSafeInteger).contains(value) {
            throw AidenBotContractError.invalidField("watch timestamp")
        }
    }
}

enum AidenBotWatchTemplateID: String, Codable, CaseIterable, Sendable {
    case mailMessages = "mail_messages", calendarUpcoming = "calendar_upcoming"
}

enum AidenBotWatchCondition: Codable, Equatable, Sendable {
    case email(sender: String?, subject: String?, unreadOnly: Bool)
    case calendar(lookAheadMinutes: Int, timezone: String)

    var kind: String {
        switch self { case .email: "email"; case .calendar: "calendar" }
    }

    func validate() throws {
        switch self {
        case let .email(sender, subject, _):
            if let sender { try AidenBotWatchWire.text(sender, "sender", limit: 200) }
            if let subject { try AidenBotWatchWire.text(subject, "subject", limit: 200) }
        case let .calendar(minutes, timezone):
            guard (15...1440).contains(minutes), TimeZone(identifier: timezone) != nil else {
                throw AidenBotContractError.invalidField("calendar condition")
            }
            try AidenBotWatchWire.text(timezone, "timezone", limit: 100)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "email":
            self = .email(sender: try c.decodeIfPresent(String.self, forKey: .sender),
                          subject: try c.decodeIfPresent(String.self, forKey: .subject),
                          unreadOnly: try c.decode(Bool.self, forKey: .unreadOnly))
        case "calendar":
            self = .calendar(lookAheadMinutes: try c.decode(Int.self, forKey: .lookAheadMinutes),
                             timezone: try c.decode(String.self, forKey: .timezone))
        default: throw AidenBotContractError.invalidField("condition.kind")
        }
        try validate()
    }

    func encode(to encoder: Encoder) throws {
        try validate()
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind, forKey: .kind)
        switch self {
        case let .email(sender, subject, unread):
            try c.encodeIfPresent(sender, forKey: .sender)
            try c.encodeIfPresent(subject, forKey: .subject)
            try c.encode(unread, forKey: .unreadOnly)
        case let .calendar(minutes, timezone):
            try c.encode(minutes, forKey: .lookAheadMinutes)
            try c.encode(timezone, forKey: .timezone)
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, sender, subject, unreadOnly, lookAheadMinutes, timezone }
}

struct AidenBotWatchTemplate: Decodable, Equatable, Identifiable, Sendable {
    let id: AidenBotWatchTemplateID
    let title: String
    let description: String
    let kind: String
    let available: Bool
    let unavailableReason: String?
    let intervals: [Int]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(AidenBotWatchTemplateID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decode(String.self, forKey: .description)
        kind = try c.decode(String.self, forKey: .kind)
        available = try c.decode(Bool.self, forKey: .available)
        unavailableReason = try c.decodeIfPresent(String.self, forKey: .unavailableReason)
        intervals = try c.decode([Int].self, forKey: .intervals)
        try AidenBotWatchWire.text(title, "title", limit: 500)
        try AidenBotWatchWire.text(description, "description", limit: 500)
        if let unavailableReason { try AidenBotWatchWire.text(unavailableReason, "unavailableReason", limit: 500) }
        guard kind == (id == .mailMessages ? "email" : "calendar"), !intervals.isEmpty,
              intervals.count <= 3, Set(intervals).count == intervals.count,
              intervals.allSatisfy(AidenBotWatchWire.intervals.contains),
              available || unavailableReason != nil else { throw AidenBotContractError.invalidField("template") }
    }
    private enum CodingKeys: String, CodingKey { case id, title, description, kind, available, unavailableReason, intervals }
}

struct AidenBotWatchSource: Codable, Equatable, Sendable {
    let providerLabel: String
    let accountLabel: String
    let resourceLabel: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providerLabel = try AidenBotWatchWire.requiredString(c, forKey: .providerLabel, maxLength: 500)
        accountLabel = try AidenBotWatchWire.requiredString(c, forKey: .accountLabel, maxLength: 500)
        resourceLabel = try AidenBotWatchWire.requiredString(c, forKey: .resourceLabel, maxLength: 500)
    }
    var label: String { "\(providerLabel) · \(accountLabel) · \(resourceLabel)" }
    private enum CodingKeys: String, CodingKey { case providerLabel, accountLabel, resourceLabel }
}

struct AidenBotWatchSourceChoice: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let templateId: AidenBotWatchTemplateID
    let providerLabel: String
    let accountLabel: String
    let resourceLabel: String
    let available: Bool
    let unavailableReason: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        try AidenBotWatchWire.uuid(id)
        templateId = try c.decode(AidenBotWatchTemplateID.self, forKey: .templateId)
        providerLabel = try AidenBotWatchWire.requiredString(c, forKey: .providerLabel, maxLength: 500)
        accountLabel = try AidenBotWatchWire.requiredString(c, forKey: .accountLabel, maxLength: 500)
        resourceLabel = try AidenBotWatchWire.requiredString(c, forKey: .resourceLabel, maxLength: 500)
        available = try c.decode(Bool.self, forKey: .available)
        unavailableReason = try AidenBotWatchWire.optionalString(c, forKey: .unavailableReason, maxLength: 500)
        guard available || unavailableReason != nil else { throw AidenBotContractError.invalidField("source") }
    }
    var label: String { "\(providerLabel) · \(accountLabel) · \(resourceLabel)" }
    private enum CodingKeys: String, CodingKey { case id, templateId, providerLabel, accountLabel, resourceLabel, available, unavailableReason }
}

enum AidenBotWatchState: String, Codable, Sendable {
    case waiting, empty, unchanged, changed, error, paused
    var label: String {
        switch self {
        case .waiting: "Waiting for a check"
        case .empty: "No matching items"
        case .unchanged: "No change"
        case .changed: "Change detected"
        case .error: "Needs attention"
        case .paused: "Paused"
        }
    }
}

struct AidenBotWatch: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let botId: String
    let revision: String
    let name: String
    let prompt: String
    let templateId: AidenBotWatchTemplateID
    let condition: AidenBotWatchCondition
    let everyMinutes: Int
    let source: AidenBotWatchSource
    let enabled: Bool
    let state: AidenBotWatchState
    let lastCheckAt: Int?
    let nextCheckAt: Int?
    let lastRunAt: Int?
    let lastError: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        try AidenBotWatchWire.uuid(id)
        botId = try AidenBotWire.identifier(c, forKey: .botId, maxLength: AidenRemoteProtocol.maxBotIdentifierLength)
        revision = try c.decode(String.self, forKey: .revision)
        try AidenBotWatchWire.revision(revision)
        name = try AidenBotWatchWire.requiredString(c, forKey: .name, maxLength: 120)
        prompt = try AidenBotWatchWire.requiredString(c, forKey: .prompt, maxLength: 32_768)
        templateId = try c.decode(AidenBotWatchTemplateID.self, forKey: .templateId)
        condition = try c.decode(AidenBotWatchCondition.self, forKey: .condition)
        everyMinutes = try c.decode(Int.self, forKey: .everyMinutes)
        guard AidenBotWatchWire.intervals.contains(everyMinutes),
              condition.kind == (templateId == .mailMessages ? "email" : "calendar") else {
            throw AidenBotContractError.invalidField("watch configuration")
        }
        source = try c.decode(AidenBotWatchSource.self, forKey: .source)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        state = try c.decode(AidenBotWatchState.self, forKey: .state)
        lastCheckAt = try c.decodeIfPresent(Int.self, forKey: .lastCheckAt)
        nextCheckAt = try c.decodeIfPresent(Int.self, forKey: .nextCheckAt)
        lastRunAt = try c.decodeIfPresent(Int.self, forKey: .lastRunAt)
        lastError = try AidenBotWatchWire.optionalString(c, forKey: .lastError, maxLength: 200)
        for stamp in [lastCheckAt, nextCheckAt, lastRunAt] { try AidenBotWatchWire.timestamp(stamp) }
    }
    private enum CodingKeys: String, CodingKey {
        case id, botId, revision, name, prompt, templateId, condition, everyMinutes, source, enabled, state
        case lastCheckAt, nextCheckAt, lastRunAt, lastError
    }
}

struct AidenBotWatchList: Decodable, Equatable, Sendable {
    let supported: Bool
    let unavailableReason: String?
    let templates: [AidenBotWatchTemplate]
    let watches: [AidenBotWatch]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        supported = try c.decode(Bool.self, forKey: .supported)
        unavailableReason = try AidenBotWatchWire.optionalString(c, forKey: .unavailableReason, maxLength: 500)
        templates = try c.decode([AidenBotWatchTemplate].self, forKey: .templates)
        watches = try c.decode([AidenBotWatch].self, forKey: .watches)
        guard templates.count <= 2, watches.count <= 16,
              Set(templates.map(\.id)).count == templates.count,
              Set(watches.map(\.id)).count == watches.count else { throw AidenBotContractError.invalidField("watches") }
    }
    private enum CodingKeys: String, CodingKey { case supported, unavailableReason, templates, watches }
}

struct AidenBotWatchSources: Decodable, Equatable, Sendable {
    let choices: [AidenBotWatchSourceChoice]
    let unavailableReasons: [String]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        choices = try c.decode([AidenBotWatchSourceChoice].self, forKey: .choices)
        unavailableReasons = try c.decode([String].self, forKey: .unavailableReasons)
        guard choices.count <= 500, Set(choices.map(\.id)).count == choices.count,
              unavailableReasons.count <= 16 else { throw AidenBotContractError.invalidField("sources") }
        for reason in unavailableReasons { try AidenBotWatchWire.text(reason, "unavailableReason", limit: 200) }
    }
    private enum CodingKeys: String, CodingKey { case choices, unavailableReasons }
}

/// Exact request snapshot retained for an uncertain write; route identities are never encoded.
struct AidenBotWatchSaveRequest: Codable, Equatable, Sendable {
    let name: String
    let prompt: String
    let condition: AidenBotWatchCondition
    let everyMinutes: Int
    let sourceChoiceId: String?
    let expectedRevision: String?
    let mutationId: UUID

    func validate(isCreate: Bool) throws {
        try AidenBotWatchWire.text(name, "name", limit: 120)
        try AidenBotWatchWire.text(prompt, "prompt", limit: 32_768)
        try condition.validate()
        guard AidenBotWatchWire.intervals.contains(everyMinutes), !isCreate || sourceChoiceId != nil,
              isCreate == (expectedRevision == nil) else { throw AidenBotContractError.invalidField("watch save") }
        if let sourceChoiceId { try AidenBotWatchWire.uuid(sourceChoiceId) }
        if let expectedRevision { try AidenBotWatchWire.revision(expectedRevision) }
    }
}

struct AidenBotWatchActionRequest: Codable, Equatable, Sendable {
    let expectedRevision: String
    let mutationId: UUID
    var enabled: Bool? = nil
}

enum AidenBotWatchTestRequest: Encodable, Equatable, Sendable {
    case saved(id: String, expectedRevision: String)
    case draft(sourceChoiceId: String, condition: AidenBotWatchCondition)
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .saved(id, revision):
            try AidenBotWatchWire.uuid(id)
            try AidenBotWatchWire.revision(revision)
            try c.encode(id, forKey: .id)
            try c.encode(revision, forKey: .expectedRevision)
        case let .draft(source, condition):
            try AidenBotWatchWire.uuid(source)
            try c.encode(source, forKey: .sourceChoiceId)
            try c.encode(condition, forKey: .condition)
        }
    }
    private enum CodingKeys: String, CodingKey { case id, expectedRevision, sourceChoiceId, condition }
}

struct AidenBotWatchTestResult: Decodable, Equatable, Sendable {
    enum Result: String, Decodable, Sendable { case baseline, empty, unchanged, changed }
    let checkedAt: Int
    let result: Result
    let itemCount: Int
    let changeCount: Int
    let preview: [String]
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        checkedAt = try c.decode(Int.self, forKey: .checkedAt)
        try AidenBotWatchWire.timestamp(checkedAt)
        result = try c.decode(Result.self, forKey: .result)
        itemCount = try c.decode(Int.self, forKey: .itemCount)
        changeCount = try c.decode(Int.self, forKey: .changeCount)
        preview = try c.decode([String].self, forKey: .preview)
        guard (0...AidenRemoteProtocol.maxSafeInteger).contains(itemCount),
              (0...AidenRemoteProtocol.maxSafeInteger).contains(changeCount), preview.count <= 8 else {
            throw AidenBotContractError.invalidField("test result")
        }
        for label in preview { try AidenBotWatchWire.text(label, "preview", limit: 500) }
    }
    private enum CodingKeys: String, CodingKey { case checkedAt, result, itemCount, changeCount, preview }
}

struct AidenBotWatchRemoval: Decodable, Equatable, Sendable {
    let id: String
    let revision: String
    let removed: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        revision = try c.decode(String.self, forKey: .revision)
        removed = try c.decode(Bool.self, forKey: .removed)
        try AidenBotWatchWire.uuid(id)
        try AidenBotWatchWire.revision(revision, removed: true)
    }
    private enum CodingKeys: String, CodingKey { case id, revision, removed }
}

struct AidenBotWatchRunResult: Decodable, Equatable, Sendable {
    let id: String
    let revision: String
    let admitted: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        revision = try c.decode(String.self, forKey: .revision)
        admitted = try c.decode(Bool.self, forKey: .admitted)
        try AidenBotWatchWire.uuid(id)
        try AidenBotWatchWire.revision(revision)
    }
    private enum CodingKeys: String, CodingKey { case id, revision, admitted }
}

extension AidenBotWatch: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botWatch") }
}
extension AidenBotWatchList: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botWatches") }
}
extension AidenBotWatchSources: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botWatchSources") }
}
extension AidenBotWatchTestResult: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botWatchTest") }
}

extension AidenBotWatchRemoval: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botWatchReceipt") }
}
extension AidenBotWatchRunResult: AidenBotPrivateResponseScoped {
    static var aidenBotPrivateResponseScope: AidenBotPrivateResponseScope { .root("botWatchReceipt") }
}
