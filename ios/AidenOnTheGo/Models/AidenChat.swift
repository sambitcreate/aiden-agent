import Foundation
import ImageIO

private func aidenDecodeOptionalNonNull<Value: Decodable, Key: CodingKey>(
    _ type: Value.Type,
    from values: KeyedDecodingContainer<Key>,
    forKey key: Key
) throws -> Value? {
    guard values.contains(key) else { return nil }
    return try values.decode(type, forKey: key)
}

enum AidenChatRole: String, Codable, Sendable {
    case user
    case assistant
}

struct AidenChatMessage: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let role: AidenChatRole
    let text: String
    let attachments: [AidenMessageAttachment]?
    let htmlArtifacts: [AidenHtmlArtifact]?
    let outcome: AidenMessageOutcome?
    let timeline: AidenGenerationTimeline?
    let createdAt: Date

    init(
        id: String,
        role: AidenChatRole,
        text: String,
        attachments: [AidenMessageAttachment]? = nil,
        htmlArtifacts: [AidenHtmlArtifact]? = nil,
        outcome: AidenMessageOutcome? = nil,
        timeline: AidenGenerationTimeline? = nil,
        createdAt: Date
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.attachments = attachments
        self.htmlArtifacts = htmlArtifacts
        self.outcome = outcome
        self.timeline = timeline
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        role = try values.decode(AidenChatRole.self, forKey: .role)
        text = try values.decode(String.self, forKey: .text)
        attachments = try aidenDecodeOptionalNonNull(
            [AidenMessageAttachment].self,
            from: values,
            forKey: .attachments
        )
        htmlArtifacts = try aidenDecodeOptionalNonNull(
            [AidenHtmlArtifact].self,
            from: values,
            forKey: .htmlArtifacts
        )
        outcome = try aidenDecodeOptionalNonNull(
            AidenMessageOutcome.self,
            from: values,
            forKey: .outcome
        )
        timeline = try aidenDecodeOptionalNonNull(
            AidenGenerationTimeline.self,
            from: values,
            forKey: .timeline
        )
        createdAt = try values.decode(Date.self, forKey: .createdAt)
    }

    var isWireSafe: Bool {
        !id.isEmpty
            && id.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength
            && text.unicodeScalars.count <= AidenRemoteProtocol.maxTextLength
            && (attachments?.count ?? 0) <= 20
            && (attachments?.allSatisfy(\.isWireSafe) ?? true)
            && (htmlArtifacts?.count ?? 0) <= 40
            && (htmlArtifacts?.allSatisfy(\.isWireSafe) ?? true)
            && (outcome?.isWireSafe ?? true)
            // Generation timelines originate in JavaScript, where String.length
            // measures UTF-16 code units. Keep that wire offset convention while
            // retaining Unicode-scalar counting for the independent text bound.
            && (timeline?.isRendererSafe(contentLength: text.utf16.count) ?? true)
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, attachments, htmlArtifacts, outcome, timeline, createdAt
    }
}

struct AidenHtmlArtifact: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String

    var isWireSafe: Bool {
        !id.isEmpty
            && id.unicodeScalars.count <= 256
            && !title.isEmpty
            && title.unicodeScalars.count <= 120
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

enum AidenGenerationCancellationOrigin: String, Codable, Sendable {
    case userStop = "user_stop"
    case chatDeletion = "chat_deletion"
    case workspaceAuthorityChange = "workspace_authority_change"
    case computerUseDisabled = "computer_use_disabled"
    case scheduledTaskCancel = "scheduled_task_cancel"
    case applicationShutdown = "application_shutdown"
}

struct AidenGenerationClaimCheck: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Sendable {
        case unverifiedSuccess = "unverified_success"
    }

    let kind: Kind
    let stepIds: [String]
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
    let toolCallId: String?
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

    init(
        id: String,
        order: Int,
        kind: Kind,
        toolCallId: String? = nil,
        toolName: String?,
        label: String?,
        status: AidenAgentStepStatus?,
        startedAt: Double,
        updatedAt: Double,
        finishedAt: Double?,
        contentOffset: Int?,
        durationMs: Double?,
        target: String?,
        detail: String?,
        lineChanges: AidenAgentLineChanges?
    ) {
        self.id = id
        self.order = order
        self.kind = kind
        self.toolCallId = toolCallId
        self.toolName = toolName
        self.label = label
        self.status = status
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.finishedAt = finishedAt
        self.contentOffset = contentOffset
        self.durationMs = durationMs
        self.target = target
        self.detail = detail
        self.lineChanges = lineChanges
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        order = try values.decode(Int.self, forKey: .order)
        kind = try values.decode(Kind.self, forKey: .kind)
        toolCallId = try aidenDecodeOptionalNonNull(
            String.self,
            from: values,
            forKey: .toolCallId
        )
        toolName = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .toolName)
        label = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .label)
        status = try aidenDecodeOptionalNonNull(
            AidenAgentStepStatus.self,
            from: values,
            forKey: .status
        )
        startedAt = try values.decode(Double.self, forKey: .startedAt)
        updatedAt = try values.decode(Double.self, forKey: .updatedAt)
        finishedAt = try aidenDecodeOptionalNonNull(Double.self, from: values, forKey: .finishedAt)
        contentOffset = try aidenDecodeOptionalNonNull(Int.self, from: values, forKey: .contentOffset)
        durationMs = try aidenDecodeOptionalNonNull(Double.self, from: values, forKey: .durationMs)
        target = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .target)
        detail = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .detail)
        lineChanges = try aidenDecodeOptionalNonNull(
            AidenAgentLineChanges.self,
            from: values,
            forKey: .lineChanges
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id, order, kind, toolCallId, toolName, label, status, startedAt, updatedAt
        case finishedAt, contentOffset, durationMs, target, detail, lineChanges
    }

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
    let cancellationOrigin: AidenGenerationCancellationOrigin?
    let claimCheck: AidenGenerationClaimCheck?

    init(
        version: Int,
        generationId: String,
        status: AidenGenerationTimelineStatus,
        startedAt: Double,
        finishedAt: Double?,
        steps: [AidenAgentStep],
        cancellationOrigin: AidenGenerationCancellationOrigin? = nil,
        claimCheck: AidenGenerationClaimCheck? = nil
    ) {
        self.version = version
        self.generationId = generationId
        self.status = status
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.steps = steps
        self.cancellationOrigin = cancellationOrigin
        self.claimCheck = claimCheck
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        generationId = try values.decode(String.self, forKey: .generationId)
        status = try values.decode(AidenGenerationTimelineStatus.self, forKey: .status)
        startedAt = try values.decode(Double.self, forKey: .startedAt)
        finishedAt = try aidenDecodeOptionalNonNull(Double.self, from: values, forKey: .finishedAt)
        steps = try values.decode([AidenAgentStep].self, forKey: .steps)
        cancellationOrigin = try aidenDecodeOptionalNonNull(
            AidenGenerationCancellationOrigin.self,
            from: values,
            forKey: .cancellationOrigin
        )
        claimCheck = try aidenDecodeOptionalNonNull(
            AidenGenerationClaimCheck.self,
            from: values,
            forKey: .claimCheck
        )
    }

    private enum CodingKeys: String, CodingKey {
        case version, generationId, status, startedAt, finishedAt, steps
        case cancellationOrigin, claimCheck
    }

    var issueCount: Int {
        steps.filter { $0.kind == .tool && $0.status?.isIssue == true }.count
    }

    var isRendererSafe: Bool {
        isRendererSafe(contentLength: nil)
    }

    func isRendererSafe(contentLength: Int?) -> Bool {
        guard [1, 2, 3].contains(version),
              !generationId.isEmpty,
              generationId.unicodeScalars.count <= 128,
              Self.isSafeIdentifier(generationId),
              steps.count <= 200,
              startedAt.isFinite,
              startedAt >= 0,
              finishedAt.map({ $0.isFinite && $0 >= 0 }) ?? true,
              cancellationOrigin == nil || status == .cancelled
        else { return false }

        var previousContentOffset = 0
        for (index, step) in steps.enumerated() {
            guard step.order == index,
                  (0...199).contains(step.order),
                  step.startedAt.isFinite,
                  step.updatedAt.isFinite,
                  step.startedAt >= 0,
                  step.updatedAt >= 0,
                  step.finishedAt.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  step.contentOffset.map({
                      $0 >= 0 && $0 <= AidenRemoteProtocol.maxSafeInteger
                  }) ?? true,
                  step.durationMs.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  step.label.map({ !$0.isEmpty && $0.unicodeScalars.count <= 120 }) ?? true,
                  step.toolName.map({ !$0.isEmpty && $0.unicodeScalars.count <= 80 }) ?? true,
                  step.detail.map({ value in
                      !value.isEmpty
                          && value.unicodeScalars.count <= 120
                          && value.unicodeScalars.allSatisfy { $0.value >= 32 && $0.value != 127 }
                  }) ?? true,
                  step.target.map({ value in
                      let normalized = value.replacingOccurrences(of: "\\", with: "/")
                      let hasDrivePrefix = normalized.count >= 3
                          && normalized[normalized.index(after: normalized.startIndex)] == ":"
                          && normalized.first?.isLetter == true
                          && normalized[normalized.index(normalized.startIndex, offsetBy: 2)] == "/"
                      return !value.isEmpty && value.unicodeScalars.count <= 240
                          && !normalized.hasPrefix("/") && !normalized.hasPrefix("~")
                          && !hasDrivePrefix && !normalized.split(separator: "/").contains("..")
                  }) ?? true,
                  step.lineChanges.map({ changes in
                      version == 3
                          && step.kind == .tool
                          && (step.toolName == "write_file" || step.toolName == "edit_file")
                          && step.status == .completed
                          && (0...100_000_000).contains(changes.additions)
                          && (0...100_000_000).contains(changes.deletions)
                  }) ?? true else {
                return false
            }

            if version == 3 {
                guard let contentOffset = step.contentOffset,
                      contentOffset >= previousContentOffset,
                      contentLength.map({ contentOffset <= $0 }) ?? true else {
                    return false
                }
                previousContentOffset = contentOffset
            }

            switch step.kind {
            case .tool:
                guard Self.matches(step.id, pattern: #"^tool-[1-9][0-9]*$"#),
                      step.id.unicodeScalars.count <= 128,
                      let toolCallId = step.toolCallId,
                      toolCallId.unicodeScalars.count <= 128,
                      Self.matches(toolCallId, pattern: #"^call-[1-9][0-9]*$"#),
                      step.toolName != nil,
                      step.label != nil,
                      step.status != nil else {
                    return false
                }
            case .thinking:
                guard version != 1,
                      step.id.unicodeScalars.count <= 128,
                      Self.matches(step.id, pattern: #"^think-[1-9][0-9]*$"#) else {
                    return false
                }
            }
        }

        if let claimCheck {
            let issueStepIDs = Set(steps.compactMap { step -> String? in
                guard step.kind == .tool, step.status?.isIssue == true else { return nil }
                return step.id
            })
            guard status != .running,
                  (1...20).contains(claimCheck.stepIds.count),
                  Set(claimCheck.stepIds).count == claimCheck.stepIds.count,
                  claimCheck.stepIds.allSatisfy(issueStepIDs.contains) else {
                return false
            }
        }
        return true
    }

    private static func isSafeIdentifier(_ value: String) -> Bool {
        value.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 48...57, 65...90, 97...122, 45, 46, 58, 95:
                return true
            default:
                return false
            }
        }
    }

    private static func matches(_ value: String, pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }
}

enum AidenAgentActivityPresentation {
    static let renderArtifactToolName = "render_artifact"

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
        "vcc_recall": ("Recalling chat history", "Recalled chat history"),
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

    static func hasActiveThinkingStep(_ timeline: AidenGenerationTimeline?) -> Bool {
        guard let timeline, timeline.status == .running else { return false }
        for step in timeline.steps.reversed() {
            if step.kind == .tool { return false }
            return step.finishedAt == nil
        }
        return false
    }

    static func hasActiveToolStep(
        _ timeline: AidenGenerationTimeline?,
        named toolName: String
    ) -> Bool {
        guard let timeline, timeline.status == .running else { return false }
        return timeline.steps.contains { step in
            step.kind == .tool && step.toolName == toolName && step.status?.isActive == true
        }
    }

    static func reasoningLabel(_ timeline: AidenGenerationTimeline?, active: Bool) -> String {
        if active { return "Thinking" }
        let durationMs = timeline?.steps.reduce(0.0) { total, step in
            step.kind == .thinking ? total + (step.durationMs ?? 0) : total
        } ?? 0
        return "Thought \(duration(durationMs > 0 ? durationMs : nil))"
    }

    static func visualizingLabel(_ timeline: AidenGenerationTimeline?) -> String? {
        hasActiveToolStep(timeline, named: renderArtifactToolName) ? "Visualizing" : nil
    }

    static func activitySteps(
        _ timeline: AidenGenerationTimeline,
        reasoningVisible: Bool
    ) -> [AidenAgentStep] {
        reasoningVisible ? timeline.steps.filter { $0.kind == .tool } : timeline.steps
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

    init(
        status: AidenMessageOutcomeStatus,
        category: String?,
        attempts: Int?,
        retryExhausted: Bool?
    ) {
        self.status = status
        self.category = category
        self.attempts = attempts
        self.retryExhausted = retryExhausted
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decode(AidenMessageOutcomeStatus.self, forKey: .status)
        category = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .category)
        attempts = try aidenDecodeOptionalNonNull(Int.self, from: values, forKey: .attempts)
        retryExhausted = try aidenDecodeOptionalNonNull(
            Bool.self,
            from: values,
            forKey: .retryExhausted
        )
        guard isWireSafe else {
            throw DecodingError.dataCorruptedError(
                forKey: .category,
                in: values,
                debugDescription: "Message outcome contains an unknown category or invalid attempts count."
            )
        }
    }

    var isWireSafe: Bool {
        (category.map(Self.categories.contains) ?? true)
            && (attempts.map({ (0...16).contains($0) }) ?? true)
    }

    private static let categories: Set<String> = [
        "network", "timeout", "service_unavailable", "rate_limit", "authentication", "quota",
        "invalid_request", "context_window", "output_limit", "interrupted", "context_management",
        "unknown",
    ]

    private enum CodingKeys: String, CodingKey {
        case status, category, attempts, retryExhausted
    }
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

    init(id: String, name: String, mimeType: String, kind: AidenAttachmentKind, size: Int) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.kind = kind
        self.size = size
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        mimeType = try values.decode(String.self, forKey: .mimeType)
        kind = try values.decode(AidenAttachmentKind.self, forKey: .kind)
        size = try values.decode(Int.self, forKey: .size)
        guard isWireSafe else {
            throw DecodingError.dataCorruptedError(
                forKey: .id,
                in: values,
                debugDescription: "Message attachment contains an unsafe identity, name, MIME type, or size."
            )
        }
    }

    var isWireSafe: Bool {
        !id.isEmpty
            && id.unicodeScalars.count <= 256
            && id.unicodeScalars.allSatisfy { scalar in
                switch scalar.value {
                case 48...57, 65...90, 97...122, 45, 46, 58, 95:
                    return true
                default:
                    return false
                }
            }
            && !name.isEmpty
            && name.unicodeScalars.count <= 255
            && name.unicodeScalars.allSatisfy { scalar in
                scalar.value > 0x1f && scalar.value != 0x7f && scalar != "/" && scalar != "\\"
            }
            && !mimeType.isEmpty
            && mimeType.unicodeScalars.count <= 120
            && size >= 0
            && size <= AidenRemoteProtocol.maxSafeInteger
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, mimeType, kind, size
    }
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
    var botId: String? = nil
    var title: String
    var providerId: String?
    var modelId: String?
    var messages: [AidenChatMessage]
    let createdAt: Date
    var updatedAt: Date
    var revision: String
    var titlePending: Bool? = nil

    var isTitlePending: Bool { titlePending == true }
    var isBotChat: Bool { botId != nil }

    init(
        id: String,
        workspaceId: String,
        botId: String? = nil,
        title: String,
        providerId: String?,
        modelId: String?,
        messages: [AidenChatMessage],
        createdAt: Date,
        updatedAt: Date,
        revision: String,
        titlePending: Bool? = nil
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.botId = botId
        self.title = title
        self.providerId = providerId
        self.modelId = modelId
        self.messages = messages
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.revision = revision
        self.titlePending = titlePending
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        workspaceId = try values.decode(String.self, forKey: .workspaceId)
        if values.contains(.botId) {
            botId = try values.decode(String.self, forKey: .botId)
        } else {
            botId = nil
        }
        title = try values.decode(String.self, forKey: .title)
        providerId = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .providerId)
        modelId = try aidenDecodeOptionalNonNull(String.self, from: values, forKey: .modelId)
        messages = try values.decode([AidenChatMessage].self, forKey: .messages)
        let createdTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt)
        createdAt = createdTimestamp.date
        let updatedTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
        updatedAt = updatedTimestamp.date
        revision = try values.decode(String.self, forKey: .revision)
        titlePending = try aidenDecodeOptionalNonNull(Bool.self, from: values, forKey: .titlePending)

        try Self.requireIdentifier(id, forKey: .id, in: values)
        try Self.requireIdentifier(workspaceId, forKey: .workspaceId, in: values)
        if let botId {
            try Self.requireIdentifier(
                botId,
                maximumLength: AidenRemoteProtocol.maxBotIdentifierLength,
                forKey: .botId,
                in: values
            )
            guard Self.isPathSafeOpaqueIdentifier(botId) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .botId,
                    in: values,
                    debugDescription: "Bot IDs may contain only ASCII letters, digits, period, colon, underscore, and hyphen."
                )
            }
        }
        try Self.requireIdentifier(revision, forKey: .revision, in: values)
        try Self.requireText(title, maximumLength: 1_024, forKey: .title, in: values)
        guard (providerId == nil) == (modelId == nil) else {
            throw DecodingError.dataCorruptedError(
                forKey: providerId == nil ? .providerId : .modelId,
                in: values,
                debugDescription: "Chat providerId and modelId must be supplied together."
            )
        }
        if let providerId {
            try Self.requireText(
                providerId,
                maximumLength: 256,
                allowEmpty: false,
                forKey: .providerId,
                in: values
            )
        }
        if let modelId {
            try Self.requireText(
                modelId,
                maximumLength: 512,
                allowEmpty: false,
                forKey: .modelId,
                in: values
            )
        }
        guard messages.count <= 10_000 else {
            throw DecodingError.dataCorruptedError(
                forKey: .messages,
                in: values,
                debugDescription: "Chat messages exceed the 10,000-item wire bound."
            )
        }
        guard messages.allSatisfy({ $0.isWireSafe }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .messages,
                in: values,
                debugDescription: "Chat messages contain an unsafe or out-of-bounds field."
            )
        }
        guard titlePending != false else {
            throw DecodingError.dataCorruptedError(
                forKey: .titlePending,
                in: values,
                debugDescription: "titlePending may be omitted or true, but never false."
            )
        }
        guard AidenRemoteTimestamp.isOrdered(
            createdAt: createdTimestamp,
            updatedAt: updatedTimestamp
        ) else {
            throw DecodingError.dataCorruptedError(
                forKey: .updatedAt,
                in: values,
                debugDescription: "Chat updatedAt cannot precede createdAt."
            )
        }
    }

    static func regularWorkspaceChats(from chats: [Self]) -> [Self] {
        chats.filter { !$0.isBotChat }
    }

    private static func requireIdentifier(
        _ value: String,
        maximumLength: Int = AidenRemoteProtocol.maxIdentifierLength,
        forKey key: CodingKeys,
        in values: KeyedDecodingContainer<CodingKeys>
    ) throws {
        guard !value.isEmpty,
              value.unicodeScalars.count <= maximumLength else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: values,
                debugDescription: "Expected a non-empty bounded identifier."
            )
        }
    }

    private static func requireText(
        _ value: String,
        maximumLength: Int,
        allowEmpty: Bool = true,
        forKey key: CodingKeys,
        in values: KeyedDecodingContainer<CodingKeys>
    ) throws {
        guard (allowEmpty || !value.isEmpty),
              value.unicodeScalars.count <= maximumLength else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: values,
                debugDescription: "Expected a bounded Chat field."
            )
        }
    }

    private static func isPathSafeOpaqueIdentifier(_ value: String) -> Bool {
        value.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 48...57, 65...90, 97...122, 45, 46, 58, 95:
                return true
            default:
                return false
            }
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, workspaceId, botId, title, providerId, modelId, messages
        case createdAt, updatedAt, revision, titlePending
    }
}

enum AidenChatSummaryActivity: String, Codable, Equatable, Sendable {
    case idle
    case active
}

struct AidenChatSummary: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let workspaceId: String
    var title: String
    var titlePending: Bool
    let createdAt: Date
    var updatedAt: Date
    var revision: String
    var activity: AidenChatSummaryActivity

    init(
        id: String,
        workspaceId: String,
        title: String,
        titlePending: Bool,
        createdAt: Date,
        updatedAt: Date,
        revision: String,
        activity: AidenChatSummaryActivity
    ) {
        self.id = id
        self.workspaceId = workspaceId
        self.title = title
        self.titlePending = titlePending
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.revision = revision
        self.activity = activity
    }

    init(chat: AidenChat, preservingActivity activity: AidenChatSummaryActivity = .idle) {
        self.init(
            id: chat.id,
            workspaceId: chat.workspaceId,
            title: chat.title,
            titlePending: chat.isTitlePending,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            revision: chat.revision,
            activity: activity
        )
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        workspaceId = try values.decode(String.self, forKey: .workspaceId)
        title = try values.decode(String.self, forKey: .title)
        titlePending = try values.decode(Bool.self, forKey: .titlePending)
        let createdTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt)
        createdAt = createdTimestamp.date
        let updatedTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
        updatedAt = updatedTimestamp.date
        revision = try values.decode(String.self, forKey: .revision)
        activity = try values.decode(AidenChatSummaryActivity.self, forKey: .activity)

        try Self.requireIdentifier(id, forKey: .id, in: values)
        try Self.requireIdentifier(workspaceId, forKey: .workspaceId, in: values)
        guard Self.isValidRevision(revision) else {
            throw DecodingError.dataCorruptedError(
                forKey: .revision,
                in: values,
                debugDescription: "Expected a canonical Chat summary revision."
            )
        }
        guard title.unicodeScalars.count <= 1_024 else {
            throw DecodingError.dataCorruptedError(
                forKey: .title,
                in: values,
                debugDescription: "Expected a bounded Chat summary title."
            )
        }
        guard AidenRemoteTimestamp.isOrdered(
            createdAt: createdTimestamp,
            updatedAt: updatedTimestamp
        ) else {
            throw DecodingError.dataCorruptedError(
                forKey: .updatedAt,
                in: values,
                debugDescription: "Chat summary updatedAt cannot precede createdAt."
            )
        }
    }

    private static func requireIdentifier(
        _ value: String,
        forKey key: CodingKeys,
        in values: KeyedDecodingContainer<CodingKeys>
    ) throws {
        guard !value.isEmpty,
              value.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength,
              value.unicodeScalars.allSatisfy(Self.isSafeIdentifierScalar) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: values,
                debugDescription: "Expected a non-empty bounded Chat summary identifier."
            )
        }
    }

    private static func isValidRevision(_ value: String) -> Bool {
        guard value.hasPrefix("rev_") else { return false }
        let suffix = value.dropFirst(4)
        return suffix.unicodeScalars.count == 43
            && suffix.unicodeScalars.allSatisfy(isBase64URLScalar)
    }

    static func isValidCachedProjection(_ summary: AidenChatSummary) -> Bool {
        !summary.id.isEmpty
            && summary.id.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength
            && summary.id.unicodeScalars.allSatisfy(isSafeIdentifierScalar)
            && !summary.workspaceId.isEmpty
            && summary.workspaceId.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength
            && summary.workspaceId.unicodeScalars.allSatisfy(isSafeIdentifierScalar)
            && summary.title.unicodeScalars.count <= 1_024
            && !summary.revision.isEmpty
            && summary.revision.unicodeScalars.count <= AidenRemoteProtocol.maxIdentifierLength
            && summary.createdAt.timeIntervalSinceReferenceDate.isFinite
            && summary.updatedAt.timeIntervalSinceReferenceDate.isFinite
            && summary.updatedAt >= summary.createdAt
    }

    private static func isSafeIdentifierScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 45...46, 48...58, 65...90, 95, 97...122:
            return true
        default:
            return false
        }
    }

    private static func isBase64URLScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 45, 48...57, 65...90, 95, 97...122:
            return true
        default:
            return false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case id, workspaceId, title, titlePending, createdAt, updatedAt, revision, activity
    }
}

struct AidenChatSummaryPage: Codable, Equatable, Sendable {
    static let defaultLimit = 100
    static let maximumLimit = 200
    static let maximumCursorLength = 512

    let summaries: [AidenChatSummary]
    let nextCursor: String?

    init(summaries: [AidenChatSummary], nextCursor: String?) throws {
        self.summaries = summaries
        self.nextCursor = nextCursor
        try Self.validate(summaries: summaries, nextCursor: nextCursor)
    }

    init(legacyChats: [AidenChat]) {
        summaries = legacyChats
            .filter { !$0.isBotChat }
            .map { AidenChatSummary(chat: $0) }
            .sorted(by: Self.areInCanonicalOrder)
        nextCursor = nil
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        summaries = try values.decode([AidenChatSummary].self, forKey: .summaries)
        if values.contains(.nextCursor) {
            nextCursor = try values.decode(String.self, forKey: .nextCursor)
        } else {
            nextCursor = nil
        }
        try Self.validate(summaries: summaries, nextCursor: nextCursor)
    }

    static func merged(
        current: [AidenChatSummary],
        appending page: [AidenChatSummary]
    ) -> [AidenChatSummary] {
        var byID = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
        for summary in page { byID[summary.id] = summary }
        return byID.values.sorted(by: areInCanonicalOrder)
    }

    static func validatedContinuation(
        current: [AidenChatSummary],
        requestedCursor: String,
        page: AidenChatSummaryPage
    ) throws -> [AidenChatSummary] {
        let currentIDs = Set(current.map(\.id))
        let pageIDs = Set(page.summaries.map(\.id))
        let preservesBoundaryOrder: Bool
        if let last = current.last, let first = page.summaries.first {
            preservesBoundaryOrder = areInCanonicalOrder(last, first)
        } else {
            preservesBoundaryOrder = true
        }
        guard currentIDs.isDisjoint(with: pageIDs),
              page.nextCursor != requestedCursor,
              preservesBoundaryOrder else {
            throw AidenRemoteContractError.invalidJSON
        }
        return current + page.summaries
    }

    static func areInCanonicalOrder(_ left: AidenChatSummary, _ right: AidenChatSummary) -> Bool {
        if left.updatedAt != right.updatedAt { return left.updatedAt > right.updatedAt }
        return left.id < right.id
    }

    static func isValidCursor(_ cursor: String) -> Bool {
        guard !cursor.isEmpty,
              cursor.unicodeScalars.count <= maximumCursorLength,
              cursor.hasPrefix("cur_") else { return false }
        let components = cursor.dropFirst(4).split(separator: ".", omittingEmptySubsequences: false)
        guard components.count == 2,
              (1...384).contains(components[0].unicodeScalars.count),
              components[1].unicodeScalars.count == 43 else { return false }
        return components.allSatisfy { component in
            component.unicodeScalars.allSatisfy { scalar in
                switch scalar.value {
                case 45, 48...57, 65...90, 95, 97...122:
                    return true
                default:
                    return false
                }
            }
        }
    }

    private static func validate(
        summaries: [AidenChatSummary],
        nextCursor: String?
    ) throws {
        guard summaries.count <= maximumLimit,
              Set(summaries.map(\.id)).count == summaries.count,
              zip(summaries, summaries.dropFirst()).allSatisfy({ pair in
                  areInCanonicalOrder(pair.0, pair.1)
              }),
              nextCursor.map(isValidCursor) ?? true else {
            throw AidenRemoteContractError.invalidJSON
        }
    }

    private enum CodingKeys: String, CodingKey {
        case summaries, nextCursor
    }
}

struct AidenModel: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    var supportsImages: Bool?
    let thinkingLevels: [String]?
    let defaultThinkingLevel: String?
    let thinkingCanDisable: Bool?
    let hidden: Bool?

    var isHidden: Bool { hidden == true }
    var acceptsImageInput: Bool { supportsImages != false }

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
    let kind: AidenApprovalKind
    let canRespond: Bool
    let hasRequiredWriteCapability: Bool
    let hostCanAllow: Bool
    let canAllow: Bool
}

enum AidenApprovalKind: Equatable, Sendable {
    case action
    case scheduledTask

    init(toolName: String) {
        switch toolName {
        case "schedule_task", "edit_automation":
            self = .scheduledTask
        default:
            self = .action
        }
    }
}

struct AidenApprovalCapabilities: Equatable, Sendable {
    let canRespond: Bool
    let canWriteSchedules: Bool

    static let unrestricted = Self(canRespond: true, canWriteSchedules: true)
}

enum AidenApprovalResponseAuthorization: Equatable, Sendable {
    case allowed
    case approvalResponseRequired
    case scheduleWriteRequired
    case hostApprovalRequired

    static func resolve(
        approval: AidenPendingApproval,
        decision: AidenApprovalDecision,
        capabilities: AidenApprovalCapabilities
    ) -> Self {
        guard capabilities.canRespond else { return .approvalResponseRequired }
        guard decision == .allow else { return .allowed }
        guard approval.hostCanAllow else { return .hostApprovalRequired }
        guard approval.kind != .scheduledTask || capabilities.canWriteSchedules else {
            return .scheduleWriteRequired
        }
        return .allowed
    }
}

enum AidenApprovalPresentation {
    static func oneLineSummary(_ summary: String) -> String {
        let collapsed = summary
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        return collapsed.isEmpty ? String(localized: "Review requested action") : collapsed
    }

    static func title(for kind: AidenApprovalKind) -> String {
        switch kind {
        case .action: String(localized: "Approval needed")
        case .scheduledTask: String(localized: "Review scheduled task")
        }
    }

    static func detail(for kind: AidenApprovalKind) -> String {
        switch kind {
        case .action:
            String(localized: "Review this one action before Aiden continues.")
        case .scheduledTask:
            String(localized: "Check the exact schedule and unattended access before Aiden saves it.")
        }
    }

    static func denyTitle(for kind: AidenApprovalKind) -> String {
        switch kind {
        case .action: String(localized: "Deny")
        case .scheduledTask: String(localized: "Cancel")
        }
    }

    static func allowTitle(for kind: AidenApprovalKind) -> String {
        switch kind {
        case .action: String(localized: "Allow once")
        case .scheduledTask: String(localized: "Approve task")
        }
    }
}

enum AidenPendingApprovalResolution {
    static func resolve(
        _ approval: AidenStreamPendingApproval?,
        streamId: String,
        chatId: String,
        capabilities: AidenApprovalCapabilities = .unrestricted,
        now: Date = Date()
    ) -> AidenPendingApproval? {
        guard let approval,
              approval.streamId == streamId,
              approval.chatId == chatId,
              approval.expiresAt > now else { return nil }
        let kind = AidenApprovalKind(toolName: approval.toolName)
        let hasRequiredWriteCapability = kind != .scheduledTask || capabilities.canWriteSchedules
        return AidenPendingApproval(
            id: approval.approvalId,
            summary: approval.summary,
            expiresAt: approval.expiresAt,
            kind: kind,
            canRespond: capabilities.canRespond,
            hasRequiredWriteCapability: hasRequiredWriteCapability,
            hostCanAllow: approval.canAllow,
            canAllow: approval.canAllow && capabilities.canRespond && hasRequiredWriteCapability
        )
    }
}

struct AidenLiveTool: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    var status: String?
}
