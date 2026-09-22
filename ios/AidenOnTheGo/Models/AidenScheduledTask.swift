import Foundation

enum AidenScheduledTaskMode: String, Codable, CaseIterable, Sendable {
    case llm
    case script

    var title: String { self == .llm ? String(localized: "Ask Aiden") : String(localized: "Run Script") }
}

enum AidenScheduledTaskPermission: String, Codable, CaseIterable, Sendable {
    case readOnly = "read-only"
    case full

    var title: String { self == .readOnly ? String(localized: "Read Only") : String(localized: "Full") }
}

enum AidenScheduledTaskResult: String, Codable, Sendable {
    case success, error, silent, blocked
}

struct AidenScheduledTask: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let revision: String
    let name: String
    let enabled: Bool
    let schedule: String
    let timezone: String
    let mode: AidenScheduledTaskMode
    let permission: AidenScheduledTaskPermission
    let workspaceId: String?
    let providerId: String?
    let modelId: String?
    let mcpServerIds: [String]?
    let scriptId: String?
    let prompt: String?
    let notify: Bool
    let running: Bool
    let nextRunAt: Date?
    let lastRunAt: Date?
    let lastResult: AidenScheduledTaskResult?
    let createdAt: Date
    let updatedAt: Date

    var usesLegacyInheritedMcpAccess: Bool {
        mode == .llm
            && permission == .full
            && workspaceId == nil
            && mcpServerIds == nil
    }

    var mcpAccessSummary: String? {
        guard mode == .llm else { return nil }
        if usesLegacyInheritedMcpAccess {
            return String(localized: "All enabled MCP servers (legacy)")
        }
        guard let mcpServerIds, !mcpServerIds.isEmpty else {
            return String(localized: "No MCP servers")
        }
        return String(localized: "\(mcpServerIds.count) selected")
    }

    func canBeginEdit(hasCurrentMcpInventory: Bool) -> Bool {
        !usesLegacyInheritedMcpAccess || hasCurrentMcpInventory
    }
}

struct AidenScheduledTaskMutation: Encodable, Equatable, Sendable {
    let name: String
    let schedule: String
    let timezone: String
    let mode: AidenScheduledTaskMode
    let permission: AidenScheduledTaskPermission
    let workspaceId: String?
    let providerId: String?
    let modelId: String?
    let mcpServerIds: [String]?
    let scriptId: String?
    let prompt: String?
    let notify: Bool
    let confirmedForeground = true
}

struct AidenScheduledRunAccepted: Codable, Equatable, Sendable {
    let taskId: String
    let runId: String
    let status: String
    let acceptedAt: Date
}

struct AidenScheduledRun: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let taskId: String
    let status: String
    let startedAt: Date
    let finishedAt: Date?
    let summary: String?
    let errorCode: String?
}

struct AidenScheduledScript: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
}

struct AidenScheduledMcpServer: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
}

struct AidenScheduledPreview: Codable, Equatable, Sendable {
    let dates: [Date]
}

struct AidenScheduledSettings: Codable, Equatable, Sendable {
    let revision: String
    let enabled: Bool
    let defaultMode: AidenScheduledTaskMode
    let defaultPermission: AidenScheduledTaskPermission
    let defaultMcpEnabled: Bool
    let defaultNotify: Bool
    let defaultTimezone: String
}

struct AidenScheduledSettingsMutation: Encodable, Equatable, Sendable {
    let enabled: Bool?
    let defaultMode: AidenScheduledTaskMode?
    let defaultPermission: AidenScheduledTaskPermission?
    let defaultMcpEnabled: Bool?
    let defaultNotify: Bool?
    let defaultTimezone: String?
    let confirmedForeground = true
}

enum AidenScheduledTaskPresentation {
    static func cadence(
        schedule: String,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let fields = schedule.split(whereSeparator: \Character.isWhitespace).map(String.init)
        let normalized: [String]
        if fields.count == 5 {
            normalized = fields
        } else if fields.count == 6, fields.first == "0" {
            normalized = Array(fields.dropFirst())
        } else {
            return String(localized: "Custom schedule")
        }
        let minuteField = normalized[0]
        let hourField = normalized[1]
        let dayOfMonth = normalized[2]
        let month = normalized[3]
        let dayOfWeek = normalized[4]

        guard dayOfMonth == "*", month == "*" else {
            return String(localized: "Custom schedule")
        }
        if hourField == "*", dayOfWeek == "*" {
            if minuteField == "*" { return String(localized: "Every minute") }
            if let interval = interval(minuteField, range: 1...59) {
                return interval == 1
                    ? String(localized: "Every minute")
                    : String(localized: "Every \(interval) minutes")
            }
            if let minute = number(minuteField, range: 0...59) {
                if minute == 0 { return String(localized: "Every hour") }
                return minute == 1
                    ? String(localized: "Every hour at 1 minute past")
                    : String(localized: "Every hour at \(minute) minutes past")
            }
        }
        if minuteField == "0", dayOfWeek == "*",
           let hours = interval(hourField, range: 1...23) {
            return hours == 1
                ? String(localized: "Every hour")
                : String(localized: "Every \(hours) hours")
        }

        guard let minute = number(minuteField, range: 0...59),
              let hour = number(hourField, range: 0...23) else {
            return String(localized: "Custom schedule")
        }
        let time = clockLabel(hour: hour, minute: minute, locale: locale)
        if dayOfWeek == "*" { return String(localized: "Every day at \(time)") }
        if dayOfWeek == "1-5" { return String(localized: "Weekdays at \(time)") }
        guard let weekday = number(dayOfWeek, range: 0...7) else {
            return String(localized: "Custom schedule")
        }
        let normalizedWeekday = weekday == 7 ? 0 : weekday
        let formatter = DateFormatter()
        formatter.locale = locale
        let weekdayName = formatter.weekdaySymbols[normalizedWeekday]
        return String(localized: "Every \(weekdayName) at \(time)")
    }

    private static func number(_ value: String, range: ClosedRange<Int>) -> Int? {
        guard !value.isEmpty, value.allSatisfy(\.isNumber),
              let number = Int(value), range.contains(number) else { return nil }
        return number
    }

    private static func interval(_ value: String, range: ClosedRange<Int>) -> Int? {
        guard value.hasPrefix("*/") else { return nil }
        return number(String(value.dropFirst(2)), range: range)
    }

    private static func clockLabel(hour: Int, minute: Int, locale: Locale) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let date = calendar.date(from: DateComponents(year: 2024, month: 1, day: 1, hour: hour, minute: minute))!
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.setLocalizedDateFormatFromTemplate("jm")
        return formatter.string(from: date)
    }
}

struct AidenScheduledTaskDraft: Equatable, Sendable {
    static let maximumMcpServerCount = 16

    var name = ""
    var schedule = ""
    var timezone = TimeZone.current.identifier
    var mode: AidenScheduledTaskMode = .llm
    var permission: AidenScheduledTaskPermission = .readOnly
    var workspaceId: String?
    var providerId: String?
    var modelId: String?
    var mcpServerIds = Set<String>()
    var scriptId: String?
    var prompt = ""
    var notify = true
    private(set) var hasResolvedMcpScope = true

    init() {}

    init(task: AidenScheduledTask, currentMcpServers: [AidenScheduledMcpServer]?) {
        name = task.name
        schedule = task.schedule
        timezone = task.timezone
        mode = task.mode
        permission = task.permission
        workspaceId = task.workspaceId
        providerId = task.providerId
        modelId = task.modelId
        if task.usesLegacyInheritedMcpAccess {
            if let currentMcpServers {
                mcpServerIds = Set(currentMcpServers.map(\.id))
            } else {
                hasResolvedMcpScope = false
            }
        } else {
            mcpServerIds = Set(task.mcpServerIds ?? [])
        }
        scriptId = task.scriptId
        prompt = task.prompt ?? ""
        notify = task.notify
    }

    var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Name is required.") }
        if schedule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Schedule is required.") }
        if timezone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Timezone is required.") }
        if mode == .llm && !hasResolvedMcpScope {
            return String(localized: "Refresh the enabled MCP server inventory before reviewing this legacy task.")
        }
        if mode == .llm && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Prompt is required.") }
        if mode == .llm && mcpServerIds.count > Self.maximumMcpServerCount {
            return String(localized: "Choose no more than 16 MCP servers.")
        }
        if mode == .llm && !mcpServerIds.isEmpty && permission != .full {
            return String(localized: "MCP access requires Full permission.")
        }
        if mode == .llm && !mcpServerIds.isEmpty && workspaceId != nil {
            return String(localized: "MCP access is available only without a workspace binding.")
        }
        if mode == .script && scriptId == nil { return String(localized: "Choose a script from Aiden Agent.") }
        if mode == .script && permission != .full { return String(localized: "Script tasks require Full permission.") }
        return nil
    }

    func reviewValidationMessage(
        replacing task: AidenScheduledTask?,
        currentMcpServers: [AidenScheduledMcpServer]?
    ) -> String? {
        if task?.usesLegacyInheritedMcpAccess == true, currentMcpServers == nil {
            return String(localized: "Refresh the enabled MCP server inventory before reviewing this legacy task.")
        }
        if let validationMessage { return validationMessage }
        guard mode == .llm, !mcpServerIds.isEmpty else { return nil }
        guard let currentMcpServers else {
            return String(localized: "Refresh the enabled MCP server inventory before reviewing MCP access.")
        }
        let availableIDs = Set(currentMcpServers.map(\.id))
        if !mcpServerIds.isSubset(of: availableIDs) {
            return String(localized: "Remove unavailable MCP connections before reviewing this task.")
        }
        return nil
    }

    @discardableResult
    mutating func setMcpServer(id: String, selected: Bool) -> Bool {
        if selected {
            guard mcpServerIds.contains(id) || mcpServerIds.count < Self.maximumMcpServerCount else {
                return false
            }
            mcpServerIds.insert(id)
            permission = .full
            workspaceId = nil
        } else {
            mcpServerIds.remove(id)
        }
        return true
    }

    mutating func setPermission(_ permission: AidenScheduledTaskPermission) {
        self.permission = permission
        if permission != .full { mcpServerIds.removeAll() }
    }

    mutating func setWorkspace(_ workspaceId: String?) {
        self.workspaceId = workspaceId
        if workspaceId != nil { mcpServerIds.removeAll() }
    }

    func mcpAccessReviewSummary(currentMcpServers: [AidenScheduledMcpServer]) -> String {
        guard !mcpServerIds.isEmpty else { return String(localized: "No MCP servers") }
        let serversByID = Dictionary(uniqueKeysWithValues: currentMcpServers.map { ($0.id, $0.name) })
        return mcpServerIds.sorted().map { id in
            serversByID[id] ?? String(localized: "Unavailable connection: \(id)")
        }.joined(separator: ", ")
    }

    var mutation: AidenScheduledTaskMutation {
        AidenScheduledTaskMutation(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            schedule: schedule.trimmingCharacters(in: .whitespacesAndNewlines),
            timezone: timezone.trimmingCharacters(in: .whitespacesAndNewlines),
            mode: mode,
            permission: permission,
            workspaceId: workspaceId,
            providerId: mode == .llm ? providerId : nil,
            modelId: mode == .llm ? modelId : nil,
            mcpServerIds: mode == .llm && hasResolvedMcpScope ? mcpServerIds.sorted() : nil,
            scriptId: mode == .script ? scriptId : nil,
            prompt: mode == .llm ? prompt.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            notify: notify
        )
    }
}

enum AidenScheduledTaskValidation {
    static func tasks(_ tasks: [AidenScheduledTask]) throws -> [AidenScheduledTask] {
        guard tasks.count <= 10_000 else { throw AidenRemoteClientError.invalidResponse }
        var ids = Set<String>()
        for task in tasks {
            let mcpServerIds = task.mcpServerIds ?? []
            guard isTaskIdentifier(task.id), ids.insert(task.id).inserted,
                  isOpaqueIdentifier(task.revision, maximum: 160), task.revision.hasPrefix("rev_"),
                  !task.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  task.name.count <= 120,
                  !task.schedule.isEmpty, task.schedule.count <= 500,
                  !task.timezone.isEmpty, task.timezone.count <= 120,
                  task.workspaceId.map({ isOpaqueIdentifier($0, maximum: 128) }) ?? true,
                  task.providerId.map({ isOpaqueIdentifier($0, maximum: 256) }) ?? true,
                  task.modelId.map({ isOpaqueIdentifier($0, maximum: 256) }) ?? true,
                  mcpServerIds.count <= AidenScheduledTaskDraft.maximumMcpServerCount,
                  Set(mcpServerIds).count == mcpServerIds.count,
                  mcpServerIds.allSatisfy({ isOpaqueIdentifier($0, maximum: 160) }),
                  task.prompt.map({ $0.count <= 32_768 }) ?? true,
                  task.scriptId.map(isScriptIdentifier) ?? true,
                  task.createdAt <= task.updatedAt,
                  task.mode == .llm
                    ? task.scriptId == nil
                        && task.prompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                    : task.permission == .full && task.scriptId != nil && task.prompt == nil,
                  mcpServerIds.isEmpty
                    || (task.mode == .llm && task.permission == .full && task.workspaceId == nil) else {
                throw AidenRemoteClientError.invalidResponse
            }
        }
        return tasks
    }

    static func runs(_ runs: [AidenScheduledRun], taskId: String) throws -> [AidenScheduledRun] {
        let statuses = Set(["accepted", "running", "succeeded", "failed", "cancelled"])
        guard isTaskIdentifier(taskId), runs.count <= 50,
              Set(runs.map(\.id)).count == runs.count,
              runs.allSatisfy({ run in
                  let isPending = run.status == "accepted" || run.status == "running"
                  let isFinished = run.status == "succeeded"
                    || run.status == "failed"
                    || run.status == "cancelled"
                  return isOpaqueIdentifier(run.id, maximum: 160)
                    && run.taskId == taskId
                    && statuses.contains(run.status)
                    && (run.summary.map({ $0.count <= 20_000 }) ?? true)
                    && (run.errorCode.map({ isOpaqueIdentifier($0, maximum: 160) }) ?? true)
                    && (run.finishedAt.map({ $0 >= run.startedAt }) ?? true)
                    && (!isPending || (run.finishedAt == nil && run.errorCode == nil))
                    && (!isFinished || run.finishedAt != nil)
                    && (run.status == "failed" || run.status == "cancelled" || run.errorCode == nil)
                    && (run.status != "failed" || run.errorCode != nil)
              }) else {
            throw AidenRemoteClientError.invalidResponse
        }
        return runs
    }

    private static func isTaskIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 160 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 45...46, 48...58, 65...90, 95, 97...122:
                true
            default:
                false
            }
        }
    }

    private static func isScriptIdentifier(_ value: String) -> Bool {
        guard value.hasPrefix("script_"), value.count == 50 else { return false }
        return value.dropFirst(7).unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 45, 48...57, 65...90, 95, 97...122:
                true
            default:
                false
            }
        }
    }

    private static func isOpaqueIdentifier(_ value: String, maximum: Int) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed == value, value.count <= maximum else { return false }
        return !value.unicodeScalars.contains { scalar in
            let point = scalar.value
            return point <= 0x1f
                || (point >= 0x7f && point <= 0x9f)
                || (point >= 0x202a && point <= 0x202e)
                || (point >= 0x2066 && point <= 0x2069)
        }
    }
}
