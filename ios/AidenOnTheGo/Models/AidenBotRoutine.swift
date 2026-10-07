import Foundation

// Contract revision 25: per-Bot routines (`bot-routines-v1`), connection
// requests (`bot-connection-requests-v1`), and starter presets
// (`bot-presets-v1`).

enum AidenBotRoutineWire {
    static let maxRoutines = 64
    static let maxNameLength = 120
    static let maxMessageLength = 32_768
    static let maxTimezoneLength = 120
    static let maxLabelLength = 200
    static let maxErrorLength = 500
    static let maxPresets = 8
    static let maxSuggestedConnections = 8

    /// 24-hour `HH:MM`.
    static func isValidTime(_ value: String) -> Bool {
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ $0.count == 2 && $0.allSatisfy(\.isASCIIDigit) }),
              let hour = Int(parts[0]), let minute = Int(parts[1]) else { return false }
        return (0...23).contains(hour) && (0...59).contains(minute)
    }

    /// A real calendar `YYYY-MM-DD`.
    static func isValidDate(_ value: String) -> Bool {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy(\.isASCIIDigit) }),
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), day >= 1 else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
              let days = calendar.range(of: .day, in: .month, for: date) else { return false }
        return days.contains(day)
    }

    static func validateTimezone(_ value: String) throws {
        guard !value.isEmpty,
              value.unicodeScalars.count <= maxTimezoneLength,
              value.trimmingCharacters(in: .whitespacesAndNewlines) == value else {
            throw AidenBotContractError.invalidField("timezone")
        }
    }

    static func validateText(_ value: String, field: String, maxLength: Int) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.unicodeScalars.count <= maxLength else {
            throw AidenBotContractError.invalidField(field)
        }
    }
}

private extension Character {
    var isASCIIDigit: Bool { isASCII && isNumber }
}

/// Frequency-first schedule. Weekdays use Sunday = 0.
enum AidenBotRoutineSchedule: Codable, Equatable, Sendable {
    case once(date: String, time: String)
    case daily(time: String)
    case weekdays(time: String)
    case weekly(days: [Int], time: String)
    case monthly(day: Int, time: String)

    var time: String {
        switch self {
        case let .once(_, time), let .daily(time), let .weekdays(time),
             let .weekly(_, time), let .monthly(_, time):
            time
        }
    }

    /// Validates the same invariants the decoder enforces.
    func validated() throws -> Self {
        guard AidenBotRoutineWire.isValidTime(time) else {
            throw AidenBotContractError.invalidField("schedule.time")
        }
        switch self {
        case let .once(date, _):
            guard AidenBotRoutineWire.isValidDate(date) else {
                throw AidenBotContractError.invalidField("schedule.date")
            }
        case let .weekly(days, _):
            guard (1...7).contains(days.count), days == Array(Set(days)).sorted(),
                  days.allSatisfy({ (0...6).contains($0) }) else {
                throw AidenBotContractError.invalidField("schedule.days")
            }
        case let .monthly(day, _):
            guard (1...31).contains(day) else {
                throw AidenBotContractError.invalidField("schedule.day")
            }
        case .daily, .weekdays:
            break
        }
        return self
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try values.decode(String.self, forKey: .kind)
        let time = try values.decode(String.self, forKey: .time)
        switch kind {
        case "once":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "date", "time"])
            self = .once(date: try values.decode(String.self, forKey: .date), time: time)
        case "daily":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "time"])
            self = .daily(time: time)
        case "weekdays":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "time"])
            self = .weekdays(time: time)
        case "weekly":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "days", "time"])
            self = .weekly(days: try values.decode([Int].self, forKey: .days), time: time)
        case "monthly":
            try AidenBotWire.requireOnlyKeys(decoder, allowed: ["kind", "day", "time"])
            self = .monthly(day: try values.decode(Int.self, forKey: .day), time: time)
        default:
            throw AidenBotContractError.invalidField("schedule.kind")
        }
        _ = try validated()
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .once(date, time):
            try values.encode("once", forKey: .kind)
            try values.encode(date, forKey: .date)
            try values.encode(time, forKey: .time)
        case let .daily(time):
            try values.encode("daily", forKey: .kind)
            try values.encode(time, forKey: .time)
        case let .weekdays(time):
            try values.encode("weekdays", forKey: .kind)
            try values.encode(time, forKey: .time)
        case let .weekly(days, time):
            try values.encode("weekly", forKey: .kind)
            try values.encode(days, forKey: .days)
            try values.encode(time, forKey: .time)
        case let .monthly(day, time):
            try values.encode("monthly", forKey: .kind)
            try values.encode(day, forKey: .day)
            try values.encode(time, forKey: .time)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case kind, date, time, days, day
    }
}

enum AidenBotRoutineResult: String, Codable, Sendable {
    case success, error, silent, blocked, skipped
}

struct AidenBotRoutine: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let botId: String
    let name: String
    let message: String
    /// Null only for a stored routine whose schedule became unreadable.
    let schedule: AidenBotRoutineSchedule?
    let timezone: String
    /// The host's friendly schedule text; shown as-is.
    let label: String
    let enabled: Bool
    let nextRunAt: AidenRemoteTimestamp?
    let lastRunAt: AidenRemoteTimestamp?
    let lastResult: AidenBotRoutineResult?
    let lastError: String?
    let updatedAt: AidenRemoteTimestamp
    let revision: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: [
            "id", "botId", "name", "message", "schedule", "timezone", "label", "enabled",
            "nextRunAt", "lastRunAt", "lastResult", "lastError", "updatedAt", "revision",
        ])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.identifier(values, forKey: .id, maxLength: 160)
        botId = try AidenBotWire.identifier(values, forKey: .botId, maxLength: AidenRemoteProtocol.maxBotIdentifierLength)
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotRoutineWire.maxNameLength)
        message = try AidenBotWire.requiredString(
            values,
            forKey: .message,
            maxLength: AidenBotRoutineWire.maxMessageLength,
            allowEmpty: true
        )
        guard values.contains(.schedule) else { throw AidenBotContractError.invalidField("schedule") }
        schedule = try values.decodeNil(forKey: .schedule)
            ? nil : try values.decode(AidenBotRoutineSchedule.self, forKey: .schedule)
        timezone = try values.decode(String.self, forKey: .timezone)
        try AidenBotRoutineWire.validateTimezone(timezone)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: AidenBotRoutineWire.maxLabelLength)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        nextRunAt = try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: .nextRunAt)
        lastRunAt = try AidenBotWire.optional(AidenRemoteTimestamp.self, from: values, forKey: .lastRunAt)
        lastResult = try AidenBotWire.optional(AidenBotRoutineResult.self, from: values, forKey: .lastResult)
        lastError = try AidenBotWire.optionalString(values, forKey: .lastError, maxLength: AidenBotRoutineWire.maxErrorLength)
        updatedAt = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
        revision = try AidenBotWire.requiredString(values, forKey: .revision, maxLength: AidenRemoteProtocol.maxIdentifierLength)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(botId, forKey: .botId)
        try values.encode(name, forKey: .name)
        try values.encode(message, forKey: .message)
        if let schedule { try values.encode(schedule, forKey: .schedule) } else { try values.encodeNil(forKey: .schedule) }
        try values.encode(timezone, forKey: .timezone)
        try values.encode(label, forKey: .label)
        try values.encode(enabled, forKey: .enabled)
        try values.encodeIfPresent(nextRunAt, forKey: .nextRunAt)
        try values.encodeIfPresent(lastRunAt, forKey: .lastRunAt)
        try values.encodeIfPresent(lastResult, forKey: .lastResult)
        try values.encodeIfPresent(lastError, forKey: .lastError)
        try values.encode(updatedAt, forKey: .updatedAt)
        try values.encode(revision, forKey: .revision)
    }

    private enum CodingKeys: String, CodingKey {
        case id, botId, name, message, schedule, timezone, label, enabled
        case nextRunAt, lastRunAt, lastResult, lastError, updatedAt, revision
    }
}

struct AidenBotRoutineList: Codable, Equatable, Sendable {
    let routines: [AidenBotRoutine]

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["routines"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        routines = try values.decode([AidenBotRoutine].self, forKey: .routines)
        guard routines.count <= AidenBotRoutineWire.maxRoutines,
              Set(routines.map(\.id)).count == routines.count else {
            throw AidenBotContractError.invalidField("routines")
        }
    }

    private enum CodingKeys: String, CodingKey { case routines }
}

struct AidenBotRoutineCreateRequest: Codable, Equatable, Sendable {
    let name: String
    let schedule: AidenBotRoutineSchedule
    let message: String
    let timezone: String?

    init(name: String, schedule: AidenBotRoutineSchedule, message: String, timezone: String? = nil) throws {
        try AidenBotRoutineWire.validateText(name, field: "name", maxLength: AidenBotRoutineWire.maxNameLength)
        try AidenBotRoutineWire.validateText(message, field: "message", maxLength: AidenBotRoutineWire.maxMessageLength)
        if let timezone { try AidenBotRoutineWire.validateTimezone(timezone) }
        self.name = name
        self.schedule = try schedule.validated()
        self.message = message
        self.timezone = timezone
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["name", "schedule", "message", "timezone"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            name: try values.decode(String.self, forKey: .name),
            schedule: try values.decode(AidenBotRoutineSchedule.self, forKey: .schedule),
            message: try values.decode(String.self, forKey: .message),
            timezone: try values.decodeIfPresent(String.self, forKey: .timezone)
        )
    }

    private enum CodingKeys: String, CodingKey { case name, schedule, message, timezone }
}

/// `PATCH /bots/{botId}/routines/{routineId}` body; at least one field.
struct AidenBotRoutineUpdateRequest: Codable, Equatable, Sendable {
    let name: String?
    let schedule: AidenBotRoutineSchedule?
    let message: String?
    let timezone: String?
    let enabled: Bool?

    init(
        name: String? = nil,
        schedule: AidenBotRoutineSchedule? = nil,
        message: String? = nil,
        timezone: String? = nil,
        enabled: Bool? = nil
    ) throws {
        guard name != nil || schedule != nil || message != nil || timezone != nil || enabled != nil else {
            throw AidenBotContractError.invalidCombination("empty routine update")
        }
        if let name { try AidenBotRoutineWire.validateText(name, field: "name", maxLength: AidenBotRoutineWire.maxNameLength) }
        if let message {
            try AidenBotRoutineWire.validateText(message, field: "message", maxLength: AidenBotRoutineWire.maxMessageLength)
        }
        if let timezone { try AidenBotRoutineWire.validateTimezone(timezone) }
        self.name = name
        self.schedule = try schedule?.validated()
        self.message = message
        self.timezone = timezone
        self.enabled = enabled
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["name", "schedule", "message", "timezone", "enabled"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            name: try values.decodeIfPresent(String.self, forKey: .name),
            schedule: try values.decodeIfPresent(AidenBotRoutineSchedule.self, forKey: .schedule),
            message: try values.decodeIfPresent(String.self, forKey: .message),
            timezone: try values.decodeIfPresent(String.self, forKey: .timezone),
            enabled: try values.decodeIfPresent(Bool.self, forKey: .enabled)
        )
    }

    private enum CodingKeys: String, CodingKey { case name, schedule, message, timezone, enabled }
}

// MARK: - Connection requests

struct AidenBotConnectionRequest: Codable, Equatable, Sendable {
    let pluginId: String

    init(pluginId: String) throws {
        try AidenBotSessionWire.validatePluginID(pluginId, field: "pluginId")
        self.pluginId = pluginId
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["pluginId"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(pluginId: try values.decode(String.self, forKey: .pluginId))
    }

    private enum CodingKeys: String, CodingKey { case pluginId }
}

struct AidenBotConnectionRequestReceipt: Codable, Equatable, Sendable {
    let pluginId: String
    let name: String
    let status: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["pluginId", "name", "status"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pluginId = try values.decode(String.self, forKey: .pluginId)
        try AidenBotSessionWire.validatePluginID(pluginId, field: "pluginId")
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: 120)
        status = try values.decode(String.self, forKey: .status)
        guard status == "sent" else { throw AidenBotContractError.invalidField("status") }
    }

    private enum CodingKeys: String, CodingKey { case pluginId, name, status }
}

// MARK: - Presets

struct AidenBotConnectionChip: Codable, Equatable, Identifiable, Sendable {
    var id: String { pluginId }
    let pluginId: String
    let name: String
    let iconId: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["pluginId", "name", "iconId"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pluginId = try values.decode(String.self, forKey: .pluginId)
        try AidenBotSessionWire.validatePluginID(pluginId, field: "pluginId")
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: 120)
        iconId = try values.decode(String.self, forKey: .iconId)
        try AidenBotSessionWire.validatePluginID(iconId, field: "iconId")
    }

    private enum CodingKeys: String, CodingKey { case pluginId, name, iconId }
}

struct AidenBotPresetRoutine: Codable, Equatable, Sendable {
    let name: String
    let label: String

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["name", "label"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotRoutineWire.maxNameLength)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: AidenBotRoutineWire.maxLabelLength)
    }

    private enum CodingKeys: String, CodingKey { case name, label }
}

struct AidenBotPreset: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let subtitle: String
    let avatar: AidenBotAvatarRecipe
    let suggestedConnections: [AidenBotConnectionChip]
    let suggestedRoutine: AidenBotPresetRoutine?

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["id", "name", "subtitle", "avatar", "suggestedConnections", "suggestedRoutine"]
        )
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        try AidenBotSessionWire.validatePluginID(id, field: "preset.id")
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotWire.maxNameLength)
        subtitle = try AidenBotWire.requiredString(values, forKey: .subtitle, maxLength: AidenBotWire.maxPurposeLength)
        avatar = try AidenBotAvatarRecipe.decodeRequest(from: values.superDecoder(forKey: .avatar))
        suggestedConnections = try values.decode([AidenBotConnectionChip].self, forKey: .suggestedConnections)
        suggestedRoutine = try AidenBotWire.optional(AidenBotPresetRoutine.self, from: values, forKey: .suggestedRoutine)
        guard suggestedConnections.count <= AidenBotRoutineWire.maxSuggestedConnections else {
            throw AidenBotContractError.invalidField("suggestedConnections")
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, subtitle, avatar, suggestedConnections, suggestedRoutine
    }
}

struct AidenBotPresetList: Codable, Equatable, Sendable {
    let presets: [AidenBotPreset]

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["presets"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        presets = try values.decode([AidenBotPreset].self, forKey: .presets)
        guard presets.count <= AidenBotRoutineWire.maxPresets,
              Set(presets.map(\.id)).count == presets.count else {
            throw AidenBotContractError.invalidField("presets")
        }
    }

    private enum CodingKeys: String, CodingKey { case presets }
}

struct AidenBotPresetCreateRequest: Codable, Equatable, Sendable {
    let presetId: String

    init(presetId: String) throws {
        try AidenBotSessionWire.validatePluginID(presetId, field: "presetId")
        self.presetId = presetId
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["presetId"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(presetId: try values.decode(String.self, forKey: .presetId))
    }

    private enum CodingKeys: String, CodingKey { case presetId }
}

struct AidenBotPresetCreateResult: Codable, Equatable, Sendable {
    /// True only for the request that made the Bot.
    let created: Bool
    let bot: AidenBotSummary

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["created", "bot"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        created = try values.decode(Bool.self, forKey: .created)
        bot = try values.decode(AidenBotSummary.self, forKey: .bot)
    }

    private enum CodingKeys: String, CodingKey { case created, bot }
}
