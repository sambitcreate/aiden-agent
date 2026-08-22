import Foundation
import ImageIO

enum AidenChatRole: String, Codable, Sendable {
    case user
    case assistant
}

struct AidenChatMessage: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let role: AidenChatRole
    let text: String
    let attachments: [AidenMessageAttachment]?
    let outcome: AidenMessageOutcome?
    let timeline: AidenGenerationTimeline?
    let createdAt: Date

    init(
        id: String,
        role: AidenChatRole,
        text: String,
        attachments: [AidenMessageAttachment]? = nil,
        outcome: AidenMessageOutcome? = nil,
        timeline: AidenGenerationTimeline? = nil,
        createdAt: Date
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.attachments = attachments
        self.outcome = outcome
        self.timeline = timeline
        self.createdAt = createdAt
    }
}

enum AidenAgentStepStatus: String, Codable, Sendable {
    case pending
    case awaitingApproval = "awaiting_approval"
    case running
    case completed
    case failed
    case blocked
    case cancelled

    var isActive: Bool {
        self == .pending || self == .awaitingApproval || self == .running
    }

    var isIssue: Bool {
        self == .failed || self == .blocked || self == .cancelled
    }
}

enum AidenGenerationTimelineStatus: String, Codable, Sendable {
    case running
    case completed
    case failed
    case cancelled
}

struct AidenAgentLineChanges: Codable, Equatable, Sendable {
    let additions: Int
    let deletions: Int
}

struct AidenAgentStep: Codable, Identifiable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case tool
        case thinking
    }

    let id: String
    let order: Int
    let kind: Kind
    let toolName: String?
    let label: String?
    let status: AidenAgentStepStatus?
    let startedAt: Double
    let updatedAt: Double
    let finishedAt: Double?
    let contentOffset: Int?
    let durationMs: Double?
    let target: String?
    let detail: String?
    let lineChanges: AidenAgentLineChanges?

    var isActive: Bool {
        kind == .thinking ? finishedAt == nil : status?.isActive == true
    }
}

struct AidenGenerationTimeline: Codable, Equatable, Sendable {
    let version: Int
    let generationId: String
    let status: AidenGenerationTimelineStatus
    let startedAt: Double
    let finishedAt: Double?
    let steps: [AidenAgentStep]

    var issueCount: Int {
        steps.filter { $0.kind == .tool && $0.status?.isIssue == true }.count
    }

    var isRendererSafe: Bool {
        guard [1, 2, 3].contains(version),
              !generationId.isEmpty,
              generationId.count <= 128,
              steps.count <= 200,
              startedAt.isFinite,
              startedAt >= 0,
              finishedAt.map({ $0.isFinite && $0 >= 0 }) ?? true
        else { return false }
        return steps.enumerated().allSatisfy { index, step in
            guard step.order == index,
                  step.id.count <= 128,
                  step.startedAt.isFinite,
                  step.updatedAt.isFinite,
                  step.startedAt >= 0,
                  step.updatedAt >= 0,
                  step.finishedAt.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  step.contentOffset.map({ $0 >= 0 }) ?? true,
                  step.durationMs.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  step.label.map({ !$0.isEmpty && $0.count <= 120 }) ?? true,
                  step.toolName.map({ !$0.isEmpty && $0.count <= 80 }) ?? true,
                  step.detail.map({ value in
                      !value.isEmpty && value.count <= 120 && !value.contains(where: { $0.isNewline })
                  }) ?? true,
                  step.target.map({ value in
                      let normalized = value.replacingOccurrences(of: "\\", with: "/")
                      let hasDrivePrefix = normalized.count >= 3
                          && normalized[normalized.index(after: normalized.startIndex)] == ":"
                          && normalized.first?.isLetter == true
                          && normalized[normalized.index(normalized.startIndex, offsetBy: 2)] == "/"
                      return !value.isEmpty && value.count <= 240
                          && !normalized.hasPrefix("/") && !normalized.hasPrefix("~")
                          && !hasDrivePrefix && !normalized.split(separator: "/").contains("..")
                  }) ?? true
            else { return false }
            return step.kind == .thinking || (step.toolName != nil && step.label != nil && step.status != nil)
        }
    }
}

enum AidenAgentActivityPresentation {
    private static let verbs: [String: (active: String, complete: String)] = [
        "read_file": ("Reading", "Read"),
        "list_dir": ("Listing", "Listed"),
        "glob": ("Searching files", "Searched files"),
        "grep": ("Grepping", "Grepped"),
        "write_file": ("Writing", "Wrote"),
        "edit_file": ("Editing", "Edited"),
        "run_command": ("Running", "Ran"),
        "web_search": ("Searching the web", "Searched the web"),
        "schedule_task": ("Scheduling", "Scheduled"),
        "edit_automation": ("Editing automation", "Edited automation"),
        "computer_use": ("Using Mac", "Used Mac"),
        "compact_context": ("Compacting context", "Compacted context"),
    ]

    static func duration(_ milliseconds: Double?) -> String {
        guard let milliseconds, milliseconds >= 2_000 else { return "briefly" }
        let seconds = Int((milliseconds / 1_000).rounded())
        guard seconds >= 60 else { return "for \(seconds)s" }
        let minutes = seconds / 60
        let remainder = seconds % 60
        return remainder == 0 ? "for \(minutes)m" : "for \(minutes)m \(remainder)s"
    }

    static func line(for step: AidenAgentStep) -> String {
        if step.kind == .thinking {
            return step.isActive ? "Thinking" : "Thought \(duration(step.durationMs))"
        }
        let label = step.label ?? "Tool"
        let pair = verbs[step.toolName ?? ""]
        let verb: String
        switch step.status {
        case .pending, .running:
            verb = pair?.active ?? label
        case .completed:
            verb = pair?.complete ?? label
        case .awaitingApproval:
            verb = "\(label) needs approval"
        case .failed:
            verb = "\(label) failed"
        case .blocked:
            verb = "\(label) denied"
        case .cancelled:
            verb = "\(label) cancelled"
        case nil:
            verb = label
        }
        let object: String?
        if step.toolName == "grep", let detail = step.detail, let target = step.target {
            object = "\(detail) in \(target)"
        } else {
            object = step.detail ?? step.target
        }
        return object.map { "\(verb) \($0)" } ?? verb
    }

    static func summary(_ timeline: AidenGenerationTimeline) -> String {
        let tools = timeline.steps.filter { $0.kind == .tool }
        guard !tools.isEmpty else {
            return timeline.status == .running ? "Thinking" : "Thought \(duration(timeline.steps.compactMap(\.durationMs).reduce(0, +)))"
        }
        let running = timeline.status == .running
        let files = tools.filter { $0.toolName == "read_file" }.count
        let searches = tools.filter { $0.toolName == "grep" || $0.toolName == "glob" }.count
        let directories = tools.filter { $0.toolName == "list_dir" }.count
        let commands = tools.filter { $0.toolName == "run_command" }.count
        let changes = tools.filter { $0.toolName == "write_file" || $0.toolName == "edit_file" }.count
        let web = tools.filter { $0.toolName == "web_search" }.count
        let mac = tools.filter { $0.toolName == "computer_use" }.count
        let compactions = tools.filter { $0.toolName == "compact_context" }.count
        let tallied = Set([
            "read_file", "grep", "glob", "list_dir", "run_command", "write_file", "edit_file",
            "web_search", "computer_use", "compact_context",
        ])
        let other = tools.filter { step in
            guard let toolName = step.toolName else { return true }
            return !tallied.contains(toolName)
        }.count
        var clauses: [String] = []
        let explored = [
            files > 0 ? "\(files) file\(files == 1 ? "" : "s")" : nil,
            searches > 0 ? "\(searches) search\(searches == 1 ? "" : "es")" : nil,
            directories > 0 ? "\(directories) director\(directories == 1 ? "y" : "ies")" : nil,
        ].compactMap { $0 }
        if !explored.isEmpty { clauses.append("\(running ? "Exploring" : "Explored") \(explored.joined(separator: ", "))") }
        if changes > 0 { clauses.append("\(running ? "editing" : "edited") \(changes) file\(changes == 1 ? "" : "s")") }
        if commands > 0 { clauses.append("\(running ? "running" : "ran") \(commands) command\(commands == 1 ? "" : "s")") }
        if web > 0 { clauses.append("\(web) web search\(web == 1 ? "" : "es")") }
        if mac > 0 { clauses.append("\(mac) Mac action\(mac == 1 ? "" : "s")") }
        if compactions > 0 { clauses.append(running ? "compacting context" : "compacted context") }
        if other > 0 { clauses.append("\(other) tool call\(other == 1 ? "" : "s")") }
        if clauses.isEmpty { return running ? "Working" : "Used \(tools.count) tool\(tools.count == 1 ? "" : "s")" }
        let sentence = clauses.joined(separator: ", ")
        guard explored.isEmpty, let first = sentence.first else { return sentence }
        return first.uppercased() + sentence.dropFirst()
    }
}

enum AidenMessageOutcomeStatus: String, Codable, Sendable {
    case failed
    case cancelled
}

struct AidenMessageOutcome: Codable, Equatable, Sendable {
    let status: AidenMessageOutcomeStatus
    let category: String?
    let attempts: Int?
    let retryExhausted: Bool?
}

enum AidenAttachmentKind: String, Codable, Sendable {
    case image
    case text
}

struct AidenMessageAttachment: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let mimeType: String
    let kind: AidenAttachmentKind
    let size: Int
}

struct AidenAttachmentContent: Equatable, Sendable {
    let data: Data
    let mimeType: String
}

enum AidenAttachmentImageValidation {
    static let maximumBytes = 8 * 1_048_576
    static let maximumDimension = 16_384
    static let maximumPixels = 40_000_000

    static func validatedData(
        _ data: Data,
        mimeType: String,
        declaredSize: Int? = nil
    ) -> Data? {
        guard !data.isEmpty,
              data.count <= maximumBytes,
              declaredSize.map({ $0 == data.count }) ?? true,
              hasMatchingSignature(data, mimeType: mimeType),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0,
              height > 0,
              width <= maximumDimension,
              height <= maximumDimension,
              width <= maximumPixels / height,
              CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 2,
                  kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) != nil
        else { return nil }
        return data
    }

    private static func hasMatchingSignature(_ data: Data, mimeType: String) -> Bool {
        let header = [UInt8](data.prefix(8))
        switch mimeType.lowercased() {
        case "image/png":
            return header == [137, 80, 78, 71, 13, 10, 26, 10]
                && [UInt8](data.suffix(12)) == [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]
        case "image/jpeg":
            let trailer = [UInt8](data.suffix(2))
            return header.count >= 3
                && header[0] == 0xff
                && header[1] == 0xd8
                && header[2] == 0xff
                && trailer == [0xff, 0xd9]
        default:
            return false
        }
    }
}

struct AidenAttachmentReference: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let mimeType: String
    let kind: AidenAttachmentKind
    let size: Int
    let expiresAt: Date

    func isValid(now: Date = Date()) -> Bool {
        guard id.range(
            of: #"^att_[A-Za-z0-9_-]{43}$"#,
            options: .regularExpression
        ) != nil,
            expiresAt > now,
            size >= 0,
            size <= 8 * 1_048_576,
            !name.isEmpty,
            name.unicodeScalars.count <= 255,
            name.unicodeScalars.allSatisfy({ scalar in
                scalar.value > 0x1f && scalar.value != 0x7f && scalar != "/" && scalar != "\\"
            }),
            !mimeType.isEmpty,
            mimeType.unicodeScalars.count <= 120
        else { return false }

        switch kind {
        case .image:
            return mimeType == "image/jpeg" || mimeType == "image/png"
        case .text:
            return size <= 400_000 && Self.allowedTextMimeTypes.contains(mimeType)
        }
    }

    private static let allowedTextMimeTypes: Set<String> = [
        "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
        "application/yaml", "application/x-yaml", "application/javascript", "application/typescript",
    ]
}

enum AidenAttachmentUpload: Encodable, Equatable, Sendable {
    case image(name: String, mimeType: String, data: Data)
    case text(name: String, mimeType: String, text: String)

    private enum CodingKeys: String, CodingKey {
        case name, mimeType, kind, data, text
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .image(let name, let mimeType, let data):
            try container.encode(name, forKey: .name)
            try container.encode(mimeType, forKey: .mimeType)
            try container.encode(AidenAttachmentKind.image.rawValue, forKey: .kind)
            try container.encode(data.base64EncodedString(), forKey: .data)
        case .text(let name, let mimeType, let text):
            try container.encode(name, forKey: .name)
            try container.encode(mimeType, forKey: .mimeType)
            try container.encode(AidenAttachmentKind.text.rawValue, forKey: .kind)
            try container.encode(text, forKey: .text)
        }
    }
}

struct AidenChat: Codable, Identifiable, Equatable, Sendable {
    let id: String
    var workspaceId: String
    var title: String
    var providerId: String?
    var modelId: String?
    var messages: [AidenChatMessage]
    let createdAt: Date
    var updatedAt: Date
    var revision: String
    var titlePending: Bool? = nil

    var isTitlePending: Bool { titlePending == true }
}

struct AidenModel: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let thinkingLevels: [String]?
    let defaultThinkingLevel: String?
    let thinkingCanDisable: Bool?
    let hidden: Bool?

    var isHidden: Bool { hidden == true }

    var effectiveThinkingLevel: String? {
        guard let thinkingLevels, !thinkingLevels.isEmpty else { return nil }
        if let defaultThinkingLevel, thinkingLevels.contains(defaultThinkingLevel) {
            return defaultThinkingLevel
        }
        if thinkingLevels.contains("medium") { return "medium" }
        if thinkingLevels.contains("high") { return "high" }
        if thinkingLevels.contains("low") { return "low" }
        if thinkingLevels.contains("off") { return "off" }
        return thinkingLevels.first
    }

    func thinkingLabel(for level: String) -> String {
        level == "off" && thinkingCanDisable == false ? "Hide" : level.capitalized
    }
}

struct AidenProvider: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let artwork: AidenProviderArtwork?
    let models: [AidenModel]

    init(
        id: String,
        label: String,
        artwork: AidenProviderArtwork? = nil,
        models: [AidenModel]
    ) {
        self.id = id
        self.label = label
        self.artwork = artwork
        self.models = models
    }
}

struct AidenProviderArtwork: Codable, Equatable, Sendable {
    let mimeType: String
    let dataBase64: String

    var boundedPNGData: Data? {
        guard mimeType == "image/png",
              dataBase64.count <= 44_000,
              let data = Data(base64Encoded: dataBase64),
              data.count <= 32 * 1024
        else { return nil }
        let header = [UInt8](data.prefix(24))
        guard header.count == 24,
              Array(header[0..<8]) == [137, 80, 78, 71, 13, 10, 26, 10],
              Array(header[12..<16]) == [73, 72, 68, 82]
        else { return nil }
        let dimension: (Int) -> UInt32 = { offset in
            (UInt32(header[offset]) << 24)
                | (UInt32(header[offset + 1]) << 16)
                | (UInt32(header[offset + 2]) << 8)
                | UInt32(header[offset + 3])
        }
        let width = dimension(16)
        let height = dimension(20)
        guard width > 0, height > 0, width <= 64, height <= 64 else { return nil }
        return data
    }
}

extension AidenProvider {
    var visibleModels: [AidenModel] { models.filter { !$0.isHidden } }
}

struct AidenModelCatalog: Codable, Equatable, Sendable {
    let providers: [AidenProvider]
    let defaults: [String: String]
}

extension AidenModelCatalog {
    var visibleProviders: [AidenProvider] {
        providers.compactMap { provider in
            let models = provider.visibleModels
            return models.isEmpty ? nil : AidenProvider(
                id: provider.id,
                label: provider.label,
                artwork: provider.artwork,
                models: models
            )
        }
    }
}

struct AidenUsageTokens: Codable, Equatable, Sendable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let cacheWrite1h: Int?
    let reasoning: Int
    let total: Int
}

struct AidenUsageTotals: Codable, Equatable, Sendable {
    let requests: Int
    let completedRequests: Int
    let failedRequests: Int
    let cancelledRequests: Int
    let reportedTokenRequests: Int
    let unmeteredRequests: Int
    let localRequests: Int
    let costedRequests: Int
    let unpricedHostedRequests: Int
    let hostedCostUsd: Double
    let activeDays: Int
    let currentStreak: Int
    let longestStreak: Int
    let tokens: AidenUsageTokens
}

struct AidenUsageDay: Codable, Equatable, Sendable {
    let date: String
    let requests: Int
    let reportedTokenRequests: Int
    let unmeteredRequests: Int
    let tokens: AidenUsageTokens
    let hostedCostUsd: Double
}

struct AidenUsageModel: Codable, Equatable, Identifiable, Sendable {
    let providerId: String
    let providerLabel: String
    let modelId: String
    let modelLabel: String
    let local: Bool
    let requests: Int
    let reportedTokenRequests: Int
    let unmeteredRequests: Int
    let tokens: AidenUsageTokens
    let hostedCostUsd: Double

    var id: String { "\(providerId):\(modelId):\(local)" }
}

struct AidenUsageSummary: Codable, Equatable, Sendable {
    let range: String
    let startDate: String
    let endDate: String
    let totals: AidenUsageTotals
    let days: [AidenUsageDay]
    let models: [AidenUsageModel]
}

struct AidenTurnStart: Encodable, Equatable, Sendable {
    let text: String
    let providerId: String?
    let modelId: String?
    let thinkingLevel: String?
    let attachmentIds: [String]?

    init(
        text: String,
        providerId: String? = nil,
        modelId: String? = nil,
        thinkingLevel: String? = nil,
        attachmentIds: [String]? = nil
    ) {
        self.text = text
        self.providerId = providerId
        self.modelId = modelId
        self.thinkingLevel = thinkingLevel
        self.attachmentIds = attachmentIds
    }
}

struct AidenTurnStartResponse: Decodable, Equatable, Sendable {
    let turnId: String
    let streamId: String
    let status: String
    let message: AidenChatMessage
}

enum AidenStreamState: String, Codable, Sendable {
    case queued
    case running
    case waitingForApproval = "waiting_for_approval"
    case reconciling
    case done
    case error
    case cancelled
    case interrupted

    var isTerminal: Bool {
        switch self {
        case .done, .error, .cancelled, .interrupted: true
        default: false
        }
    }
}

struct AidenStreamStatus: Codable, Equatable, Sendable {
    let streamId: String
    let chatId: String
    let turnId: String
    let state: AidenStreamState
    let lastSequence: Int
    let updatedAt: Date
}

struct AidenStreamPendingApproval: Codable, Equatable, Sendable {
    let approvalId: String
    let streamId: String
    let chatId: String
    let summary: String
    let toolCallId: String
    let toolName: String
    let expiresAt: Date
    let canAllow: Bool
}

struct AidenStreamApprovalSnapshot: Codable, Equatable, Sendable {
    let approval: AidenStreamPendingApproval?
}

enum AidenApprovalDecision: String, Codable, Sendable {
    case allow
    case deny
}

struct AidenApprovalResponse: Codable, Equatable, Sendable {
    let approvalId: String
    let decision: AidenApprovalDecision
    let resolvedAt: Date
}

struct AidenPendingApproval: Identifiable, Equatable, Sendable {
    let id: String
    let summary: String
    let expiresAt: Date
    let canAllow: Bool
}

enum AidenApprovalPresentation {
    static func oneLineSummary(_ summary: String) -> String {
        let collapsed = summary
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        return collapsed.isEmpty ? String(localized: "Review requested action") : collapsed
    }
}

enum AidenPendingApprovalResolution {
    static func resolve(
        _ approval: AidenStreamPendingApproval?,
        streamId: String,
        chatId: String,
        now: Date = Date()
    ) -> AidenPendingApproval? {
        guard let approval,
              approval.streamId == streamId,
              approval.chatId == chatId,
              approval.expiresAt > now else { return nil }
        return AidenPendingApproval(
            id: approval.approvalId,
            summary: approval.summary,
            expiresAt: approval.expiresAt,
            canAllow: approval.canAllow
        )
    }
}

struct AidenLiveTool: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    var status: String?
}
