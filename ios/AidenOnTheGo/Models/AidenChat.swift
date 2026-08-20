import Foundation

enum AidenChatRole: String, Codable, Sendable {
    case user
    case assistant
}

struct AidenChatMessage: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let role: AidenChatRole
    let text: String
    let attachments: [AidenMessageAttachment]?
    let createdAt: Date

    init(
        id: String,
        role: AidenChatRole,
        text: String,
        attachments: [AidenMessageAttachment]? = nil,
        createdAt: Date
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.attachments = attachments
        self.createdAt = createdAt
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
}

struct AidenModel: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let thinkingLevels: [String]?
}

struct AidenProvider: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let models: [AidenModel]
}

struct AidenModelCatalog: Codable, Equatable, Sendable {
    let providers: [AidenProvider]
    let defaults: [String: String]
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
}

struct AidenLiveTool: Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    var status: String?
}
