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

struct AidenScheduledTaskDraft: Equatable, Sendable {
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

    init() {}

    init(task: AidenScheduledTask) {
        name = task.name
        schedule = task.schedule
        timezone = task.timezone
        mode = task.mode
        permission = task.permission
        workspaceId = task.workspaceId
        providerId = task.providerId
        modelId = task.modelId
        mcpServerIds = Set(task.mcpServerIds ?? [])
        scriptId = task.scriptId
        prompt = task.prompt ?? ""
        notify = task.notify
    }

    var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Name is required.") }
        if schedule.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Schedule is required.") }
        if timezone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Timezone is required.") }
        if mode == .llm && prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return String(localized: "Prompt is required.") }
        if mode == .script && scriptId == nil { return String(localized: "Choose a script from Aiden Agent.") }
        if mode == .script && permission != .full { return String(localized: "Script tasks require Full permission.") }
        return nil
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
            mcpServerIds: mode == .llm && !mcpServerIds.isEmpty ? mcpServerIds.sorted() : nil,
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
            guard !task.id.isEmpty, task.id.count <= 160, ids.insert(task.id).inserted,
                  task.revision.hasPrefix("rev_"), !task.name.isEmpty, task.name.count <= 120,
                  !task.schedule.isEmpty, task.schedule.count <= 500,
                  !task.timezone.isEmpty, task.timezone.count <= 120,
                  task.prompt.map({ $0.count <= 32_768 }) ?? true,
                  task.scriptId.map({ $0.hasPrefix("script_") && $0.count == 50 }) ?? true else {
                throw AidenRemoteClientError.invalidResponse
            }
        }
        return tasks
    }

    static func runs(_ runs: [AidenScheduledRun], taskId: String) throws -> [AidenScheduledRun] {
        guard runs.count <= 50,
              runs.allSatisfy({ $0.taskId == taskId && $0.summary.map({ $0.count <= 20_000 }) ?? true }) else {
            throw AidenRemoteClientError.invalidResponse
        }
        return runs
    }
}
