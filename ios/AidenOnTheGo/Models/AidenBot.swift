import Foundation

enum AidenBotContractError: Error, Equatable, LocalizedError {
    case invalidField(String)
    case invalidCombination(String)

    var errorDescription: String? {
        switch self {
        case .invalidCombination("no available provider and model"):
            String(
                localized: "Set up a provider and model on your Mac. In Aiden Agent, open Settings → Providers, connect or refresh a provider, and make at least one chat model available. Then tap Try Again."
            )
        case .invalidCombination("unavailable custom access"):
            String(
                localized: "One or more selected AI, Files, Connections, or Skills are no longer available. Review this Bot’s access choices and try again."
            )
        case .invalidCombination("chat access exceeds bot"):
            String(
                localized: "This chat is asking for more access than the Bot currently allows. Reduce the chat’s access or expand the Bot’s access, then try again."
            )
        case .invalidCombination("full access notice"):
            String(
                localized: "Review and accept the Full Access notice before giving this Bot full access."
            )
        case .invalidField, .invalidCombination:
            String(
                localized: "Aiden Agent returned Bot information this version of Aiden On The Go can’t use. Update Aiden Agent and Aiden On The Go, then try again."
            )
        }
    }
}

private struct AidenBotDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private enum AidenBotWire {
    static let maxNameLength = 80
    static let maxPurposeLength = 280
    static let maxGreetingLength = 2_000
    static let maxInstructionsLength = 32_000
    static let maxSummaryLength = 280
    static let maxPreviewLength = 500
    static let maxBots = 256
    static let maxFavorites = 20
    static let maxConversationPage = 50
    static let maxChatMessages = 10_000
    static let maxChatTitleLength = 1_024
    static let maxProviders = 64
    static let maxModels = 256
    static let maxAggregateModels = 512
    static let maxFileScopes = 64
    static let maxConnections = 128
    static let maxSkills = 256
    static let maxOtherCapabilities = 128
    static let maxAvatarBase64Length = 5_592_408
    static let maxAvatarBytes = 4 * 1_048_576
    static let fullAccessNoticeVersion = "bot-full-access-v1"

    static func requiredString<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>,
        forKey key: Key,
        maxLength: Int,
        allowEmpty: Bool = false
    ) throws -> String {
        let value = try values.decode(String.self, forKey: key)
        try validateString(value, field: key.stringValue, maxLength: maxLength, allowEmpty: allowEmpty)
        return value
    }

    static func optionalString<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>,
        forKey key: Key,
        maxLength: Int,
        allowEmpty: Bool = false
    ) throws -> String? {
        guard values.contains(key) else { return nil }
        let value = try values.decode(String.self, forKey: key)
        try validateString(value, field: key.stringValue, maxLength: maxLength, allowEmpty: allowEmpty)
        return value
    }

    static func optional<Value: Decodable, Key: CodingKey>(
        _ type: Value.Type,
        from values: KeyedDecodingContainer<Key>,
        forKey key: Key
    ) throws -> Value? {
        guard values.contains(key) else { return nil }
        return try values.decode(type, forKey: key)
    }

    static func identifier<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>,
        forKey key: Key,
        maxLength: Int = AidenRemoteProtocol.maxIdentifierLength
    ) throws -> String {
        let value = try requiredString(values, forKey: key, maxLength: maxLength)
        try validateIdentifier(value, field: key.stringValue, maxLength: maxLength)
        return value
    }

    static func optionalIdentifier<Key: CodingKey>(
        _ values: KeyedDecodingContainer<Key>,
        forKey key: Key,
        maxLength: Int = AidenRemoteProtocol.maxIdentifierLength
    ) throws -> String? {
        guard values.contains(key) else { return nil }
        let value = try values.decode(String.self, forKey: key)
        try validateString(value, field: key.stringValue, maxLength: maxLength, allowEmpty: false)
        guard value.unicodeScalars.allSatisfy(isSafeIdentifierScalar) else {
            throw AidenBotContractError.invalidField(key.stringValue)
        }
        return value
    }

    static func uniqueIdentifiers(
        _ values: [String],
        field: String,
        maxItems: Int,
        maxLength: Int = AidenRemoteProtocol.maxIdentifierLength
    ) throws -> [String] {
        guard values.count <= maxItems, Set(values).count == values.count else {
            throw AidenBotContractError.invalidField(field)
        }
        for value in values {
            try validateString(value, field: field, maxLength: maxLength, allowEmpty: false)
            guard value.unicodeScalars.allSatisfy(isSafeIdentifierScalar) else {
                throw AidenBotContractError.invalidField(field)
            }
        }
        return values
    }

    static func isSafeIdentifierScalar(_ scalar: Unicode.Scalar) -> Bool {
        let code = scalar.value
        return (48...57).contains(code) ||
            (65...90).contains(code) ||
            (97...122).contains(code) ||
            code == 45 || code == 46 || code == 58 || code == 95
    }

    static func validateIdentifier(_ value: String, field: String, maxLength: Int) throws {
        try validateString(value, field: field, maxLength: maxLength, allowEmpty: false)
        guard value.unicodeScalars.allSatisfy(isSafeIdentifierScalar) else {
            throw AidenBotContractError.invalidField(field)
        }
    }

    static func uniqueStrings(
        _ values: [String],
        field: String,
        maxItems: Int,
        maxLength: Int
    ) throws -> [String] {
        guard values.count <= maxItems, Set(values).count == values.count else {
            throw AidenBotContractError.invalidField(field)
        }
        for value in values {
            try validateString(value, field: field, maxLength: maxLength, allowEmpty: false)
        }
        return values
    }

    static func validateString(
        _ value: String,
        field: String,
        maxLength: Int,
        allowEmpty: Bool
    ) throws {
        guard (allowEmpty || !value.isEmpty), value.unicodeScalars.count <= maxLength else {
            throw AidenBotContractError.invalidField(field)
        }
    }

    static func requireOnlyKeys(
        _ decoder: Decoder,
        allowed: Set<String>
    ) throws {
        let dynamic = try decoder.container(keyedBy: AidenBotDynamicCodingKey.self)
        if let unexpected = dynamic.allKeys.first(where: { !allowed.contains($0.stringValue) }) {
            throw AidenBotContractError.invalidField(unexpected.stringValue)
        }
    }
}

enum AidenBotLegacyAvatar: String, Codable, CaseIterable, Sendable {
    case spark, orbit, leaf, prism, wave, ember
}

enum AidenBotAvatarShape: String, Codable, CaseIterable, Sendable {
    case wisp, orb, drop, hex, cloud, peak, squircle, capsule
}

enum AidenBotAvatarColor: String, Codable, CaseIterable, Sendable {
    case lilac, sky, mint, sun, periwinkle, coral, peach, aqua
}

enum AidenBotAvatarEyes: String, Codable, CaseIterable, Sendable {
    case dots, wide, happy, sleepy, focus, wink
}

enum AidenBotAvatarDetail: String, Codable, CaseIterable, Sendable {
    case none, halo, orbit, sparkles, antenna, bolts
}

struct AidenBotAvatarRecipe: Codable, Equatable, Sendable {
    let version: Int
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor
    let eyes: AidenBotAvatarEyes
    let detail: AidenBotAvatarDetail

    init(
        shape: AidenBotAvatarShape,
        color: AidenBotAvatarColor,
        eyes: AidenBotAvatarEyes,
        detail: AidenBotAvatarDetail
    ) {
        version = 1
        self.shape = shape
        self.color = color
        self.eyes = eyes
        self.detail = detail
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else { throw AidenBotContractError.invalidField("avatar.version") }
        shape = try values.decode(AidenBotAvatarShape.self, forKey: .shape)
        color = try values.decode(AidenBotAvatarColor.self, forKey: .color)
        eyes = try values.decode(AidenBotAvatarEyes.self, forKey: .eyes)
        detail = try values.decode(AidenBotAvatarDetail.self, forKey: .detail)
    }

    fileprivate static func decodeRequest(from decoder: Decoder) throws -> Self {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["version", "shape", "color", "eyes", "detail"]
        )
        return try Self(from: decoder)
    }
}

enum AidenBotSemanticAvatar: Codable, Equatable, Sendable {
    case legacy(AidenBotLegacyAvatar)
    case recipe(AidenBotAvatarRecipe)

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let legacy = try? value.decode(AidenBotLegacyAvatar.self) {
            self = .legacy(legacy)
        } else {
            self = .recipe(try AidenBotAvatarRecipe(from: decoder))
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case let .legacy(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .recipe(value):
            try value.encode(to: encoder)
        }
    }

    fileprivate static func decodeRequest(from decoder: Decoder) throws -> Self {
        let value = try decoder.singleValueContainer()
        if let legacy = try? value.decode(AidenBotLegacyAvatar.self) {
            return .legacy(legacy)
        }
        return .recipe(try AidenBotAvatarRecipe.decodeRequest(from: decoder))
    }
}

enum AidenBotAvatarAssetMimeType: String, Codable, Sendable {
    case png = "image/png"
}

enum AidenBotAvatarUploadMimeType: String, Codable, Sendable {
    case png = "image/png"
    case jpeg = "image/jpeg"
}

struct AidenBotAvatarAsset: Codable, Equatable, Sendable {
    let assetRevision: String
    let mimeType: AidenBotAvatarAssetMimeType
    let width: Int
    let height: Int
    let byteSize: Int

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        assetRevision = try AidenBotWire.identifier(values, forKey: .assetRevision)
        mimeType = try values.decode(AidenBotAvatarAssetMimeType.self, forKey: .mimeType)
        width = try values.decode(Int.self, forKey: .width)
        height = try values.decode(Int.self, forKey: .height)
        byteSize = try values.decode(Int.self, forKey: .byteSize)
        guard width == 512,
              height == 512,
              (1...AidenBotWire.maxAvatarBytes).contains(byteSize) else {
            throw AidenBotContractError.invalidField("avatar.asset")
        }
    }
}

/// Canonical raster bytes returned by the authenticated Bot avatar route.
/// The server always publishes a 512 x 512 PNG; keeping the bytes separate
/// from Bot DTOs prevents a photo or temporary location from entering normal
/// list/detail persistence.
struct AidenBotAvatarContent: Equatable, Sendable {
    let data: Data
    let assetRevision: String
}

struct AidenBotAvatarView: Codable, Equatable, Sendable {
    let semantic: AidenBotSemanticAvatar
    let asset: AidenBotAvatarAsset?

    init(semantic: AidenBotSemanticAvatar, asset: AidenBotAvatarAsset? = nil) {
        self.semantic = semantic
        self.asset = asset
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        semantic = try values.decode(AidenBotSemanticAvatar.self, forKey: .semantic)
        asset = try AidenBotWire.optional(AidenBotAvatarAsset.self, from: values, forKey: .asset)
    }
}

enum AidenBotHealth: String, Codable, Sendable {
    case ready, degraded, unavailable, archived
}

struct AidenBotSummary: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let purpose: String
    let avatar: AidenBotAvatarView
    let health: AidenBotHealth
    let createdAt: Date
    let updatedAt: Date
    let revision: String
    let archivedAt: Date?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.identifier(
            values,
            forKey: .id,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotWire.maxNameLength)
        purpose = try AidenBotWire.requiredString(
            values,
            forKey: .purpose,
            maxLength: AidenBotWire.maxPurposeLength,
            allowEmpty: true
        )
        avatar = try values.decode(AidenBotAvatarView.self, forKey: .avatar)
        health = try values.decode(AidenBotHealth.self, forKey: .health)
        let createdTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt)
        createdAt = createdTimestamp.date
        let updatedTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
        updatedAt = updatedTimestamp.date
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        archivedAt = try AidenBotWire.optional(Date.self, from: values, forKey: .archivedAt)
        guard (health == .archived) == (archivedAt != nil) else {
            throw AidenBotContractError.invalidCombination("bot health/timestamps")
        }
        guard AidenRemoteTimestamp.isOrdered(
            createdAt: createdTimestamp,
            updatedAt: updatedTimestamp
        ) else {
            throw AidenBotContractError.invalidCombination("bot timestamps")
        }
    }
}

struct AidenBotList: Codable, Equatable, Sendable {
    let bots: [AidenBotSummary]
    let maxBots: Int
    let favorites: AidenBotFavorites

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        bots = try values.decode([AidenBotSummary].self, forKey: .bots)
        maxBots = try values.decode(Int.self, forKey: .maxBots)
        favorites = try values.decode(AidenBotFavorites.self, forKey: .favorites)
        let archivedBotIDs = Set(bots.lazy.filter { $0.health == .archived }.map(\.id))
        guard bots.count <= AidenBotWire.maxBots,
              maxBots == AidenBotWire.maxBots,
              bots.count <= maxBots,
              Set(bots.map(\.id)).count == bots.count,
              Set(favorites.botIds).isSubset(of: Set(bots.map(\.id))),
              Set(favorites.botIds).isDisjoint(with: archivedBotIDs) else {
            throw AidenBotContractError.invalidField("bots")
        }
    }
}

struct AidenBotDetail: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let purpose: String
    let openingGreeting: String?
    let instructions: String
    let avatar: AidenBotAvatarView
    let health: AidenBotHealth
    let access: AidenBotAccessView
    let modelSelection: AidenBotModelSelection?
    let createdAt: Date
    let updatedAt: Date
    let revision: String
    let archivedAt: Date?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.identifier(
            values,
            forKey: .id,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotWire.maxNameLength)
        purpose = try AidenBotWire.requiredString(
            values,
            forKey: .purpose,
            maxLength: AidenBotWire.maxPurposeLength,
            allowEmpty: true
        )
        openingGreeting = try AidenBotWire.optionalString(
            values,
            forKey: .openingGreeting,
            maxLength: AidenBotWire.maxGreetingLength,
            allowEmpty: true
        )
        instructions = try AidenBotWire.requiredString(
            values,
            forKey: .instructions,
            maxLength: AidenBotWire.maxInstructionsLength
        )
        avatar = try values.decode(AidenBotAvatarView.self, forKey: .avatar)
        health = try values.decode(AidenBotHealth.self, forKey: .health)
        access = try values.decode(AidenBotAccessView.self, forKey: .access)
        modelSelection = try AidenBotWire.optional(
            AidenBotModelSelection.self,
            from: values,
            forKey: .modelSelection
        )
        let createdTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt)
        createdAt = createdTimestamp.date
        let updatedTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
        updatedAt = updatedTimestamp.date
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        archivedAt = try AidenBotWire.optional(Date.self, from: values, forKey: .archivedAt)
        guard access.botId == id,
              (health == .archived) == (archivedAt != nil) else {
            throw AidenBotContractError.invalidCombination("bot detail identity/state")
        }
        guard AidenRemoteTimestamp.isOrdered(
            createdAt: createdTimestamp,
            updatedAt: updatedTimestamp
        ) else {
            throw AidenBotContractError.invalidCombination("bot timestamps")
        }
    }
}

struct AidenBotModelSelection: Codable, Equatable, Sendable {
    let providerId: String
    let modelId: String

    init(providerId: String, modelId: String) {
        self.providerId = providerId
        self.modelId = modelId
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        providerId = try AidenBotWire.requiredString(values, forKey: .providerId, maxLength: 256)
        modelId = try AidenBotWire.requiredString(values, forKey: .modelId, maxLength: 512)
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case providerId, modelId
    }
}

struct AidenBotCreateRequest: Codable, Equatable, Sendable {
    let name: String
    let purpose: String
    let openingGreeting: String?
    let instructions: String
    let avatar: AidenBotSemanticAvatar
    let access: AidenBotAccessUpdate

    init(
        name: String,
        purpose: String,
        openingGreeting: String? = nil,
        instructions: String,
        avatar: AidenBotSemanticAvatar,
        access: AidenBotAccessUpdate
    ) throws {
        try AidenBotWire.validateString(name, field: "name", maxLength: AidenBotWire.maxNameLength, allowEmpty: false)
        try AidenBotWire.validateString(purpose, field: "purpose", maxLength: AidenBotWire.maxPurposeLength, allowEmpty: true)
        if let openingGreeting {
            try AidenBotWire.validateString(openingGreeting, field: "openingGreeting", maxLength: AidenBotWire.maxGreetingLength, allowEmpty: true)
        }
        try AidenBotWire.validateString(instructions, field: "instructions", maxLength: AidenBotWire.maxInstructionsLength, allowEmpty: false)
        self.name = name
        self.purpose = purpose
        self.openingGreeting = openingGreeting
        self.instructions = instructions
        self.avatar = avatar
        self.access = access
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try AidenBotWire.requiredString(values, forKey: .name, maxLength: AidenBotWire.maxNameLength)
        purpose = try AidenBotWire.requiredString(
            values,
            forKey: .purpose,
            maxLength: AidenBotWire.maxPurposeLength,
            allowEmpty: true
        )
        openingGreeting = try AidenBotWire.optionalString(
            values,
            forKey: .openingGreeting,
            maxLength: AidenBotWire.maxGreetingLength,
            allowEmpty: true
        )
        instructions = try AidenBotWire.requiredString(
            values,
            forKey: .instructions,
            maxLength: AidenBotWire.maxInstructionsLength
        )
        avatar = try AidenBotSemanticAvatar.decodeRequest(
            from: values.superDecoder(forKey: .avatar)
        )
        access = try values.decode(AidenBotAccessUpdate.self, forKey: .access)
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name, purpose, openingGreeting, instructions, avatar, access
    }
}

struct AidenBotIdentityPatch: Codable, Equatable, Sendable {
    let name: String?
    let purpose: String?
    let openingGreeting: String?
    let instructions: String?
    let avatar: AidenBotSemanticAvatar?

    init(
        name: String? = nil,
        purpose: String? = nil,
        openingGreeting: String? = nil,
        instructions: String? = nil,
        avatar: AidenBotSemanticAvatar? = nil
    ) throws {
        guard name != nil || purpose != nil || openingGreeting != nil || instructions != nil || avatar != nil else {
            throw AidenBotContractError.invalidCombination("empty identity patch")
        }
        if let name { try AidenBotWire.validateString(name, field: "name", maxLength: AidenBotWire.maxNameLength, allowEmpty: false) }
        if let purpose { try AidenBotWire.validateString(purpose, field: "purpose", maxLength: AidenBotWire.maxPurposeLength, allowEmpty: true) }
        if let openingGreeting { try AidenBotWire.validateString(openingGreeting, field: "openingGreeting", maxLength: AidenBotWire.maxGreetingLength, allowEmpty: true) }
        if let instructions { try AidenBotWire.validateString(instructions, field: "instructions", maxLength: AidenBotWire.maxInstructionsLength, allowEmpty: false) }
        self.name = name
        self.purpose = purpose
        self.openingGreeting = openingGreeting
        self.instructions = instructions
        self.avatar = avatar
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try AidenBotWire.optionalString(values, forKey: .name, maxLength: AidenBotWire.maxNameLength)
        purpose = try AidenBotWire.optionalString(
            values,
            forKey: .purpose,
            maxLength: AidenBotWire.maxPurposeLength,
            allowEmpty: true
        )
        openingGreeting = try AidenBotWire.optionalString(
            values,
            forKey: .openingGreeting,
            maxLength: AidenBotWire.maxGreetingLength,
            allowEmpty: true
        )
        instructions = try AidenBotWire.optionalString(
            values,
            forKey: .instructions,
            maxLength: AidenBotWire.maxInstructionsLength
        )
        if values.contains(.avatar) {
            avatar = try AidenBotSemanticAvatar.decodeRequest(
                from: values.superDecoder(forKey: .avatar)
            )
        } else {
            avatar = nil
        }
        guard name != nil || purpose != nil || openingGreeting != nil || instructions != nil || avatar != nil else {
            throw AidenBotContractError.invalidCombination("empty identity patch")
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case name, purpose, openingGreeting, instructions, avatar
    }
}

enum AidenBotConversationActivityState: String, Codable, Sendable {
    case idle, queued, running
    case waitingForApproval = "waiting_for_approval"
    case reconciling
}

struct AidenBotConversationItem: Codable, Equatable, Identifiable, Sendable {
    var id: String { chatId }

    let chatId: String
    let botId: String
    let title: String
    let preview: String?
    let activityState: AidenBotConversationActivityState
    let canRespondToApproval: Bool
    let createdAt: Date
    let updatedAt: Date
    let revision: String

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try AidenBotWire.requiredString(
            values,
            forKey: .chatId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        botId = try AidenBotWire.identifier(
            values,
            forKey: .botId,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        title = try AidenBotWire.requiredString(
            values,
            forKey: .title,
            maxLength: 1_024,
            allowEmpty: true
        )
        preview = try AidenBotWire.optionalString(
            values,
            forKey: .preview,
            maxLength: AidenBotWire.maxPreviewLength,
            allowEmpty: true
        )
        activityState = try values.decode(AidenBotConversationActivityState.self, forKey: .activityState)
        canRespondToApproval = try values.decode(Bool.self, forKey: .canRespondToApproval)
        let createdTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .createdAt)
        createdAt = createdTimestamp.date
        let updatedTimestamp = try values.decode(AidenRemoteTimestamp.self, forKey: .updatedAt)
        updatedAt = updatedTimestamp.date
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        guard AidenRemoteTimestamp.isOrdered(
                  createdAt: createdTimestamp,
                  updatedAt: updatedTimestamp
              ),
              !canRespondToApproval || activityState == .waitingForApproval else {
            throw AidenBotContractError.invalidCombination("conversation activity/timestamps")
        }
    }
}

struct AidenBotConversationPage: Codable, Equatable, Sendable {
    let conversations: [AidenBotConversationItem]
    let nextCursor: String?

    init(validatedSubsetOf page: Self, retainingBotIDs: Set<String>) {
        conversations = page.conversations.filter { retainingBotIDs.contains($0.botId) }
        nextCursor = page.nextCursor
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversations = try values.decode([AidenBotConversationItem].self, forKey: .conversations)
        nextCursor = try AidenBotWire.optionalString(
            values,
            forKey: .nextCursor,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        guard conversations.count <= AidenBotWire.maxConversationPage,
              Set(conversations.map(\.chatId)).count == conversations.count else {
            throw AidenBotContractError.invalidField("conversations")
        }
    }
}

struct AidenBotConversationQuery: Codable, Equatable, Sendable {
    let cursor: String?
    let query: String?
    let botId: String?
    let limit: Int?

    init(
        cursor: String? = nil,
        query: String? = nil,
        botId: String? = nil,
        limit: Int? = nil
    ) throws {
        if let cursor {
            try AidenBotWire.validateString(
                cursor,
                field: "cursor",
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                allowEmpty: false
            )
        }
        if let query {
            try AidenBotWire.validateString(query, field: "query", maxLength: 200, allowEmpty: true)
        }
        if let botId {
            try AidenBotWire.validateIdentifier(
                botId,
                field: "botId",
                maxLength: AidenRemoteProtocol.maxBotIdentifierLength
            )
        }
        if let limit, !(1...AidenBotWire.maxConversationPage).contains(limit) {
            throw AidenBotContractError.invalidField("limit")
        }
        self.cursor = cursor
        self.query = query
        self.botId = botId
        self.limit = limit
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        cursor = try AidenBotWire.optionalString(
            values,
            forKey: .cursor,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        query = try AidenBotWire.optionalString(values, forKey: .query, maxLength: 200, allowEmpty: true)
        botId = try AidenBotWire.optionalIdentifier(
            values,
            forKey: .botId,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        limit = try AidenBotWire.optional(Int.self, from: values, forKey: .limit)
        if let limit, !(1...AidenBotWire.maxConversationPage).contains(limit) {
            throw AidenBotContractError.invalidField("limit")
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case cursor, query, botId, limit
    }
}

struct AidenBotChatCreateRequest: Codable, Equatable, Sendable {
    let providerId: String?
    let modelId: String?

    init(providerId: String? = nil, modelId: String? = nil) throws {
        guard (providerId == nil) == (modelId == nil) else {
            throw AidenBotContractError.invalidCombination("chat provider/model override")
        }
        if let providerId { try AidenBotWire.validateString(providerId, field: "providerId", maxLength: 256, allowEmpty: false) }
        if let modelId { try AidenBotWire.validateString(modelId, field: "modelId", maxLength: 512, allowEmpty: false) }
        self.providerId = providerId
        self.modelId = modelId
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        providerId = try AidenBotWire.optionalString(values, forKey: .providerId, maxLength: 256)
        modelId = try AidenBotWire.optionalString(values, forKey: .modelId, maxLength: 512)
        guard (providerId == nil) == (modelId == nil) else {
            throw AidenBotContractError.invalidCombination("chat provider/model override")
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case providerId, modelId
    }
}

/// The Bot chat creation route returns the canonical naked Chat projection.
/// This wrapper keeps that wire shape while making `botId` required here.
struct AidenBotChatCreateResponse: Codable, Equatable, Sendable {
    let chat: AidenChat

    init(from decoder: Decoder) throws {
        chat = try AidenChat(from: decoder)
        guard let botId = chat.botId else {
            throw AidenBotContractError.invalidField("botId")
        }
        try AidenBotWire.validateIdentifier(
            botId,
            field: "botId",
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        try AidenBotWire.validateString(
            chat.title,
            field: "title",
            maxLength: AidenBotWire.maxChatTitleLength,
            allowEmpty: true
        )
        if let providerId = chat.providerId {
            try AidenBotWire.validateString(
                providerId,
                field: "providerId",
                maxLength: 256,
                allowEmpty: false
            )
        }
        if let modelId = chat.modelId {
            try AidenBotWire.validateString(
                modelId,
                field: "modelId",
                maxLength: 512,
                allowEmpty: false
            )
        }
        guard (chat.providerId == nil) == (chat.modelId == nil),
              chat.messages.count <= AidenBotWire.maxChatMessages,
              chat.updatedAt >= chat.createdAt,
              chat.titlePending != false else {
            throw AidenBotContractError.invalidCombination("bot chat projection")
        }
        for message in chat.messages {
            try AidenBotWire.validateString(
                message.id,
                field: "message.id",
                maxLength: AidenRemoteProtocol.maxIdentifierLength,
                allowEmpty: false
            )
            try AidenBotWire.validateString(
                message.text,
                field: "message.text",
                maxLength: AidenRemoteProtocol.maxTextLength,
                allowEmpty: true
            )
            guard message.attachments.map({ $0.count <= 20 }) ?? true else {
                throw AidenBotContractError.invalidField("message.attachments")
            }
        }
    }

    func encode(to encoder: Encoder) throws {
        try chat.encode(to: encoder)
    }
}

struct AidenBotCapabilityOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let available: Bool
    let description: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.identifier(values, forKey: .id)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: 120)
        available = try values.decode(Bool.self, forKey: .available)
        description = try AidenBotWire.optionalString(
            values,
            forKey: .description,
            maxLength: AidenBotWire.maxPurposeLength,
            allowEmpty: true
        )
    }
}

enum AidenBotFileScopeKind: String, Codable, Sendable {
    case fullMac = "full_mac"
    case botHome = "bot_home"
    case approvedLocation = "approved_location"
}

struct AidenBotFileScopeOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let available: Bool
    let description: String?
    let kind: AidenBotFileScopeKind

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.identifier(values, forKey: .id)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: 120)
        available = try values.decode(Bool.self, forKey: .available)
        description = try AidenBotWire.optionalString(
            values,
            forKey: .description,
            maxLength: AidenBotWire.maxPurposeLength,
            allowEmpty: true
        )
        kind = try values.decode(AidenBotFileScopeKind.self, forKey: .kind)
    }
}

struct AidenBotModelOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let available: Bool

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.requiredString(values, forKey: .id, maxLength: 512)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: 160)
        available = try values.decode(Bool.self, forKey: .available)
    }
}

struct AidenBotProviderOption: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let available: Bool
    let models: [AidenBotModelOption]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.requiredString(values, forKey: .id, maxLength: 256)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: 120)
        available = try values.decode(Bool.self, forKey: .available)
        models = try values.decode([AidenBotModelOption].self, forKey: .models)
        guard models.count <= AidenBotWire.maxModels,
              Set(models.map(\.id)).count == models.count else {
            throw AidenBotContractError.invalidField("models")
        }
    }
}

struct AidenBotCapabilityCatalog: Codable, Equatable, Sendable {
    let revision: String
    let providers: [AidenBotProviderOption]
    let fileScopes: [AidenBotFileScopeOption]
    let shellAvailable: Bool
    let connections: [AidenBotCapabilityOption]
    let skills: [AidenBotCapabilityOption]
    let otherCapabilities: [AidenBotCapabilityOption]
    let notice: AidenBotNoticeStatus

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        providers = try values.decode([AidenBotProviderOption].self, forKey: .providers)
        fileScopes = try values.decode([AidenBotFileScopeOption].self, forKey: .fileScopes)
        shellAvailable = try values.decode(Bool.self, forKey: .shellAvailable)
        connections = try values.decode([AidenBotCapabilityOption].self, forKey: .connections)
        skills = try values.decode([AidenBotCapabilityOption].self, forKey: .skills)
        otherCapabilities = try values.decode([AidenBotCapabilityOption].self, forKey: .otherCapabilities)
        notice = try values.decode(AidenBotNoticeStatus.self, forKey: .notice)

        guard providers.count <= AidenBotWire.maxProviders,
              providers.reduce(0, { $0 + $1.models.count }) <= AidenBotWire.maxAggregateModels,
              fileScopes.count <= AidenBotWire.maxFileScopes,
              connections.count <= AidenBotWire.maxConnections,
              skills.count <= AidenBotWire.maxSkills,
              otherCapabilities.count <= AidenBotWire.maxOtherCapabilities,
              Set(providers.map(\.id)).count == providers.count,
              Set(fileScopes.map(\.id)).count == fileScopes.count,
              Set(connections.map(\.id)).count == connections.count,
              Set(skills.map(\.id)).count == skills.count,
              Set(otherCapabilities.map(\.id)).count == otherCapabilities.count else {
            throw AidenBotContractError.invalidField("capability catalog")
        }
    }

    func contains(_ selection: AidenBotCustomSelection) -> Bool {
        guard let provider = providers.first(where: { $0.id == selection.providerId }),
              provider.models.contains(where: { $0.id == selection.modelId }) else {
            return false
        }
        return Set(selection.fileScopeIds).isSubset(of: Set(fileScopes.map(\.id)))
            && Set(selection.connectionIds).isSubset(of: Set(connections.map(\.id)))
            && Set(selection.skillIds).isSubset(of: Set(skills.map(\.id)))
            && Set(selection.otherCapabilityIds).isSubset(of: Set(otherCapabilities.map(\.id)))
    }

    func containsAvailable(_ selection: AidenBotCustomSelection) -> Bool {
        guard containsAvailable(providerId: selection.providerId, modelId: selection.modelId),
              !selection.shellEnabled || shellAvailable else {
            return false
        }
        return Set(selection.fileScopeIds).isSubset(of: Set(fileScopes.filter(\.available).map(\.id)))
            && Set(selection.connectionIds).isSubset(of: Set(connections.filter(\.available).map(\.id)))
            && Set(selection.skillIds).isSubset(of: Set(skills.filter(\.available).map(\.id)))
            && Set(selection.otherCapabilityIds).isSubset(of: Set(otherCapabilities.filter(\.available).map(\.id)))
    }

    func contains(providerId: String, modelId: String) -> Bool {
        providers.first(where: { $0.id == providerId })?
            .models.contains(where: { $0.id == modelId }) == true
    }

    func containsAvailable(providerId: String, modelId: String) -> Bool {
        guard let provider = providers.first(where: { $0.id == providerId }),
              provider.available else {
            return false
        }
        return provider.models.contains(where: { $0.id == modelId && $0.available })
    }
}

struct AidenBotCustomSelection: Codable, Equatable, Sendable {
    let fileScopeIds: [String]
    let shellEnabled: Bool
    let connectionIds: [String]
    let skillIds: [String]
    let otherCapabilityIds: [String]
    let providerId: String
    let modelId: String

    init(
        fileScopeIds: [String],
        shellEnabled: Bool,
        connectionIds: [String],
        skillIds: [String],
        otherCapabilityIds: [String],
        providerId: String,
        modelId: String
    ) throws {
        self.fileScopeIds = try AidenBotWire.uniqueIdentifiers(
            fileScopeIds,
            field: "fileScopeIds",
            maxItems: AidenBotWire.maxFileScopes,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        self.shellEnabled = shellEnabled
        self.connectionIds = try AidenBotWire.uniqueIdentifiers(
            connectionIds,
            field: "connectionIds",
            maxItems: AidenBotWire.maxConnections,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        self.skillIds = try AidenBotWire.uniqueIdentifiers(
            skillIds,
            field: "skillIds",
            maxItems: AidenBotWire.maxSkills,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        self.otherCapabilityIds = try AidenBotWire.uniqueIdentifiers(
            otherCapabilityIds,
            field: "otherCapabilityIds",
            maxItems: AidenBotWire.maxOtherCapabilities,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        try AidenBotWire.validateString(providerId, field: "providerId", maxLength: 256, allowEmpty: false)
        try AidenBotWire.validateString(modelId, field: "modelId", maxLength: 512, allowEmpty: false)
        self.providerId = providerId
        self.modelId = modelId
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        fileScopeIds = try AidenBotWire.uniqueIdentifiers(
            values.decode([String].self, forKey: .fileScopeIds),
            field: "fileScopeIds",
            maxItems: AidenBotWire.maxFileScopes,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        shellEnabled = try values.decode(Bool.self, forKey: .shellEnabled)
        connectionIds = try AidenBotWire.uniqueIdentifiers(
            values.decode([String].self, forKey: .connectionIds),
            field: "connectionIds",
            maxItems: AidenBotWire.maxConnections,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        skillIds = try AidenBotWire.uniqueIdentifiers(
            values.decode([String].self, forKey: .skillIds),
            field: "skillIds",
            maxItems: AidenBotWire.maxSkills,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        otherCapabilityIds = try AidenBotWire.uniqueIdentifiers(
            values.decode([String].self, forKey: .otherCapabilityIds),
            field: "otherCapabilityIds",
            maxItems: AidenBotWire.maxOtherCapabilities,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        providerId = try AidenBotWire.requiredString(values, forKey: .providerId, maxLength: 256)
        modelId = try AidenBotWire.requiredString(values, forKey: .modelId, maxLength: 512)
    }

    fileprivate static func decodeRequest(from decoder: Decoder) throws -> Self {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: [
                "providerId", "modelId", "fileScopeIds", "shellEnabled",
                "connectionIds", "skillIds", "otherCapabilityIds",
            ]
        )
        return try Self(from: decoder)
    }

    func isSubset(of ceiling: Self) -> Bool {
        providerId == ceiling.providerId
            && modelId == ceiling.modelId
            && (!shellEnabled || ceiling.shellEnabled)
            && Set(fileScopeIds).isSubset(of: Set(ceiling.fileScopeIds))
            && Set(connectionIds).isSubset(of: Set(ceiling.connectionIds))
            && Set(skillIds).isSubset(of: Set(ceiling.skillIds))
            && Set(otherCapabilityIds).isSubset(of: Set(ceiling.otherCapabilityIds))
    }
}

enum AidenBotAccessMode: String, Codable, Sendable {
    case full, custom
}

struct AidenBotAccessView: Codable, Equatable, Sendable {
    let botId: String
    let accessMode: AidenBotAccessMode
    let revision: String
    let policyEpoch: String
    let summary: String
    let custom: AidenBotCustomSelection?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenBotWire.identifier(
            values,
            forKey: .botId,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        accessMode = try values.decode(AidenBotAccessMode.self, forKey: .accessMode)
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        policyEpoch = try AidenBotWire.requiredString(
            values,
            forKey: .policyEpoch,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        summary = try AidenBotWire.requiredString(values, forKey: .summary, maxLength: AidenBotWire.maxSummaryLength)
        custom = try AidenBotWire.optional(AidenBotCustomSelection.self, from: values, forKey: .custom)
        guard (accessMode == .custom) == (custom != nil) else {
            throw AidenBotContractError.invalidCombination("bot access mode/custom")
        }
    }

    func permits(_ selection: AidenBotCustomSelection) -> Bool {
        switch accessMode {
        case .full:
            return true
        case .custom:
            return custom.map { selection.isSubset(of: $0) } ?? false
        }
    }
}

enum AidenBotAccessUpdate: Codable, Equatable, Sendable {
    case full(catalogRevision: String, selection: AidenBotModelSelection? = nil)
    case custom(catalogRevision: String, selection: AidenBotCustomSelection)

    var catalogRevision: String {
        switch self {
        case let .full(catalogRevision, _), let .custom(catalogRevision, _):
            return catalogRevision
        }
    }

    var customSelection: AidenBotCustomSelection? {
        switch self {
        case .full:
            return nil
        case let .custom(_, selection):
            return selection
        }
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let mode = try values.decode(AidenBotAccessMode.self, forKey: .accessMode)
        let catalogRevision = try AidenBotWire.requiredString(
            values,
            forKey: .catalogRevision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        switch mode {
        case .full:
            guard try values.decode(Bool.self, forKey: .confirmedForeground),
                  !values.contains(.custom) else {
                throw AidenBotContractError.invalidCombination("full access update")
            }
            let providerId = try AidenBotWire.optionalString(values, forKey: .providerId, maxLength: 256)
            let modelId = try AidenBotWire.optionalString(values, forKey: .modelId, maxLength: 512)
            guard (providerId == nil) == (modelId == nil) else {
                throw AidenBotContractError.invalidCombination("full access provider/model")
            }
            self = .full(
                catalogRevision: catalogRevision,
                selection: providerId.flatMap { provider in
                    modelId.map { AidenBotModelSelection(providerId: provider, modelId: $0) }
                }
            )
        case .custom:
            guard !values.contains(.confirmedForeground),
                  !values.contains(.providerId),
                  !values.contains(.modelId) else {
                throw AidenBotContractError.invalidCombination("custom access update")
            }
            self = .custom(
                catalogRevision: catalogRevision,
                selection: try AidenBotCustomSelection.decodeRequest(
                    from: values.superDecoder(forKey: .custom)
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .full(catalogRevision, selection):
            try values.encode(AidenBotAccessMode.full, forKey: .accessMode)
            try values.encode(catalogRevision, forKey: .catalogRevision)
            try values.encode(true, forKey: .confirmedForeground)
            try values.encodeIfPresent(selection?.providerId, forKey: .providerId)
            try values.encodeIfPresent(selection?.modelId, forKey: .modelId)
        case let .custom(catalogRevision, selection):
            try values.encode(AidenBotAccessMode.custom, forKey: .accessMode)
            try values.encode(catalogRevision, forKey: .catalogRevision)
            try values.encode(selection, forKey: .custom)
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case accessMode, catalogRevision, confirmedForeground, custom, providerId, modelId
    }
}

enum AidenBotChatAccessMode: String, Codable, Sendable {
    case inherit
    case custom
}

struct AidenBotChatAccessView: Codable, Equatable, Sendable {
    let chatId: String
    let botId: String
    let mode: AidenBotChatAccessMode
    let revision: String
    let botPolicyRevision: String
    let summary: String
    let custom: AidenBotCustomSelection?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        chatId = try AidenBotWire.requiredString(
            values,
            forKey: .chatId,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        botId = try AidenBotWire.identifier(
            values,
            forKey: .botId,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        mode = try values.decode(AidenBotChatAccessMode.self, forKey: .mode)
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        botPolicyRevision = try AidenBotWire.requiredString(
            values,
            forKey: .botPolicyRevision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        summary = try AidenBotWire.requiredString(values, forKey: .summary, maxLength: AidenBotWire.maxSummaryLength)
        custom = try AidenBotWire.optional(AidenBotCustomSelection.self, from: values, forKey: .custom)
        guard (mode == .custom) == (custom != nil) else {
            throw AidenBotContractError.invalidCombination("chat access mode/custom")
        }
    }
}

enum AidenBotChatAccessUpdate: Codable, Equatable, Sendable {
    case inherit(catalogRevision: String, expectedBotPolicyRevision: String)
    case custom(
        catalogRevision: String,
        expectedBotPolicyRevision: String,
        selection: AidenBotCustomSelection
    )

    var catalogRevision: String {
        switch self {
        case let .inherit(catalogRevision, _), let .custom(catalogRevision, _, _):
            return catalogRevision
        }
    }

    var expectedBotPolicyRevision: String {
        switch self {
        case let .inherit(_, revision), let .custom(_, revision, _):
            return revision
        }
    }

    var customSelection: AidenBotCustomSelection? {
        switch self {
        case .inherit:
            return nil
        case let .custom(_, _, selection):
            return selection
        }
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let mode = try values.decode(AidenBotChatAccessMode.self, forKey: .mode)
        let catalogRevision = try AidenBotWire.requiredString(
            values,
            forKey: .catalogRevision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        let expectedBotPolicyRevision = try AidenBotWire.requiredString(
            values,
            forKey: .expectedBotPolicyRevision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
        switch mode {
        case .inherit:
            guard !values.contains(.custom) else {
                throw AidenBotContractError.invalidCombination("inherited chat access")
            }
            self = .inherit(
                catalogRevision: catalogRevision,
                expectedBotPolicyRevision: expectedBotPolicyRevision
            )
        case .custom:
            self = .custom(
                catalogRevision: catalogRevision,
                expectedBotPolicyRevision: expectedBotPolicyRevision,
                selection: try AidenBotCustomSelection.decodeRequest(
                    from: values.superDecoder(forKey: .custom)
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .inherit(catalogRevision, expectedBotPolicyRevision):
            try values.encode(AidenBotChatAccessMode.inherit, forKey: .mode)
            try values.encode(catalogRevision, forKey: .catalogRevision)
            try values.encode(expectedBotPolicyRevision, forKey: .expectedBotPolicyRevision)
        case let .custom(catalogRevision, expectedBotPolicyRevision, selection):
            try values.encode(AidenBotChatAccessMode.custom, forKey: .mode)
            try values.encode(catalogRevision, forKey: .catalogRevision)
            try values.encode(expectedBotPolicyRevision, forKey: .expectedBotPolicyRevision)
            try values.encode(selection, forKey: .custom)
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case mode, catalogRevision, expectedBotPolicyRevision, custom
    }
}

struct AidenBotFavorites: Codable, Equatable, Sendable {
    let botIds: [String]
    let revision: String

    init(botIds: [String], revision: String) throws {
        self.botIds = try AidenBotWire.uniqueIdentifiers(
            botIds,
            field: "botIds",
            maxItems: AidenBotWire.maxFavorites,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        try AidenBotWire.validateString(revision, field: "revision", maxLength: AidenRemoteProtocol.maxIdentifierLength, allowEmpty: false)
        self.revision = revision
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        botIds = try AidenBotWire.uniqueIdentifiers(
            values.decode([String].self, forKey: .botIds),
            field: "botIds",
            maxItems: AidenBotWire.maxFavorites,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
        revision = try AidenBotWire.requiredString(
            values,
            forKey: .revision,
            maxLength: AidenRemoteProtocol.maxIdentifierLength
        )
    }
}

struct AidenBotFavoritesUpdateRequest: Codable, Equatable, Sendable {
    let botIds: [String]

    init(botIds: [String]) throws {
        self.botIds = try AidenBotWire.uniqueIdentifiers(
            botIds,
            field: "botIds",
            maxItems: AidenBotWire.maxFavorites,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["botIds"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        botIds = try AidenBotWire.uniqueIdentifiers(
            values.decode([String].self, forKey: .botIds),
            field: "botIds",
            maxItems: AidenBotWire.maxFavorites,
            maxLength: AidenRemoteProtocol.maxBotIdentifierLength
        )
    }

    private enum CodingKeys: String, CodingKey {
        case botIds
    }
}

enum AidenBotNoticeDecision: String, Codable, Sendable {
    case continueFull = "continue_full"
    case customizeFirst = "customize_first"
}

struct AidenBotNoticeStatus: Codable, Equatable, Sendable {
    let version: String
    let requiresAcknowledgement: Bool
    let acceptedAt: Date?
    let acceptedDecision: AidenBotNoticeDecision?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try AidenBotWire.requiredString(values, forKey: .version, maxLength: 80)
        requiresAcknowledgement = try values.decode(Bool.self, forKey: .requiresAcknowledgement)
        acceptedAt = try AidenBotWire.optional(Date.self, from: values, forKey: .acceptedAt)
        acceptedDecision = try AidenBotWire.optional(AidenBotNoticeDecision.self, from: values, forKey: .acceptedDecision)
        guard version == AidenBotWire.fullAccessNoticeVersion,
              requiresAcknowledgement
                ? (acceptedAt == nil && acceptedDecision == nil)
                : (acceptedAt != nil && acceptedDecision != nil) else {
            throw AidenBotContractError.invalidCombination("notice acknowledgement")
        }
    }
}

struct AidenBotNoticeAcknowledgement: Codable, Equatable, Sendable {
    let version: String
    let decision: AidenBotNoticeDecision
    let confirmedForeground: Bool

    init(version: String, decision: AidenBotNoticeDecision) throws {
        guard version == AidenBotWire.fullAccessNoticeVersion else {
            throw AidenBotContractError.invalidField("version")
        }
        self.version = version
        self.decision = decision
        confirmedForeground = true
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try AidenBotWire.requiredString(values, forKey: .version, maxLength: 80)
        decision = try values.decode(AidenBotNoticeDecision.self, forKey: .decision)
        confirmedForeground = try values.decode(Bool.self, forKey: .confirmedForeground)
        guard version == AidenBotWire.fullAccessNoticeVersion,
              confirmedForeground else {
            throw AidenBotContractError.invalidField("notice acknowledgement")
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version, decision, confirmedForeground
    }
}

struct AidenBotArchiveResponse: Codable, Equatable, Sendable {
    let bot: AidenBotDetail

    init(from decoder: Decoder) throws {
        bot = try AidenBotDetail(from: decoder)
        guard bot.health == .archived, bot.archivedAt != nil else {
            throw AidenBotContractError.invalidCombination("archive response")
        }
    }

    func encode(to encoder: Encoder) throws {
        try bot.encode(to: encoder)
    }
}

struct AidenBotRestoreResponse: Codable, Equatable, Sendable {
    let bot: AidenBotDetail

    init(from decoder: Decoder) throws {
        bot = try AidenBotDetail(from: decoder)
        guard bot.health != .archived, bot.archivedAt == nil else {
            throw AidenBotContractError.invalidCombination("restore response")
        }
    }

    func encode(to encoder: Encoder) throws {
        try bot.encode(to: encoder)
    }
}

struct AidenBotAvatarUpload: Codable, Equatable, Sendable {
    let mimeType: AidenBotAvatarUploadMimeType
    let data: String

    init(mimeType: AidenBotAvatarUploadMimeType, data: String) throws {
        guard data.count <= AidenBotWire.maxAvatarBase64Length,
              let decoded = Data(base64Encoded: data),
              !decoded.isEmpty,
              decoded.count <= AidenBotWire.maxAvatarBytes,
              decoded.base64EncodedString() == data else {
            throw AidenBotContractError.invalidField("avatar.data")
        }
        self.mimeType = mimeType
        self.data = data
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: Set(CodingKeys.allCases.map(\.stringValue)))
        let values = try decoder.container(keyedBy: CodingKeys.self)
        mimeType = try values.decode(AidenBotAvatarUploadMimeType.self, forKey: .mimeType)
        data = try values.decode(String.self, forKey: .data)
        guard data.count <= AidenBotWire.maxAvatarBase64Length,
              let decoded = Data(base64Encoded: data),
              !decoded.isEmpty,
              decoded.count <= AidenBotWire.maxAvatarBytes,
              decoded.base64EncodedString() == data else {
            throw AidenBotContractError.invalidField("avatar.data")
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case mimeType, data
    }
}

typealias AidenBotAvatarUploadResult = AidenBotAvatarAsset
typealias AidenBotFavoritesView = AidenBotFavorites
typealias AidenBotProviderModelOption = AidenBotModelOption

struct AidenBotCreateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotCreateRequest
    let response: AidenBotDetail

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotCreateRequest.self, forKey: .request)
        response = try values.decode(AidenBotDetail.self, forKey: .response)
        guard response.name == request.name,
              response.purpose == request.purpose,
              response.openingGreeting == request.openingGreeting,
              response.instructions == request.instructions,
              response.avatar.semantic == request.avatar else {
            throw AidenBotContractError.invalidCombination("bot create fixture")
        }
        switch request.access {
        case .full:
            guard response.access.accessMode == .full else {
                throw AidenBotContractError.invalidCombination("bot create access fixture")
            }
        case let .custom(_, selection):
            guard response.access.accessMode == .custom,
                  response.access.custom == selection else {
                throw AidenBotContractError.invalidCombination("bot create access fixture")
            }
        }
    }
}

struct AidenBotIdentityContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotIdentityPatch
    let response: AidenBotDetail

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotIdentityPatch.self, forKey: .request)
        response = try values.decode(AidenBotDetail.self, forKey: .response)

        let greetingMatches: Bool
        if let greeting = request.openingGreeting {
            greetingMatches = greeting.isEmpty
                ? response.openingGreeting == nil
                : response.openingGreeting == greeting
        } else {
            greetingMatches = true
        }
        guard request.name.map({ $0 == response.name }) ?? true,
              request.purpose.map({ $0 == response.purpose }) ?? true,
              greetingMatches,
              request.instructions.map({ $0 == response.instructions }) ?? true,
              request.avatar.map({ $0 == response.avatar.semantic }) ?? true else {
            throw AidenBotContractError.invalidCombination("bot identity fixture")
        }
    }
}

struct AidenBotChatCreateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotChatCreateRequest
    let response: AidenBotChatCreateResponse

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotChatCreateRequest.self, forKey: .request)
        response = try values.decode(AidenBotChatCreateResponse.self, forKey: .response)
        guard request.providerId.map({ $0 == response.chat.providerId }) ?? true,
              request.modelId.map({ $0 == response.chat.modelId }) ?? true else {
            throw AidenBotContractError.invalidCombination("bot chat create fixture")
        }
    }
}

struct AidenBotPolicyUpdateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotAccessUpdate
    let response: AidenBotAccessView

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotAccessUpdate.self, forKey: .request)
        response = try values.decode(AidenBotAccessView.self, forKey: .response)
        switch request {
        case .full:
            guard response.accessMode == .full else {
                throw AidenBotContractError.invalidCombination("bot policy fixture")
            }
        case let .custom(_, selection):
            guard response.accessMode == .custom, response.custom == selection else {
                throw AidenBotContractError.invalidCombination("bot policy fixture")
            }
        }
    }
}

struct AidenBotChatSubsetUpdateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotChatAccessUpdate
    let response: AidenBotChatAccessView

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotChatAccessUpdate.self, forKey: .request)
        response = try values.decode(AidenBotChatAccessView.self, forKey: .response)
        guard request.expectedBotPolicyRevision == response.botPolicyRevision else {
            throw AidenBotContractError.invalidCombination("chat policy revision fixture")
        }
        switch request {
        case .inherit:
            guard response.mode == .inherit else {
                throw AidenBotContractError.invalidCombination("chat policy fixture")
            }
        case let .custom(_, _, selection):
            guard response.mode == .custom, response.custom == selection else {
                throw AidenBotContractError.invalidCombination("chat policy fixture")
            }
        }
    }
}

struct AidenBotFavoritesUpdateContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotFavoritesUpdateRequest
    let response: AidenBotFavorites

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotFavoritesUpdateRequest.self, forKey: .request)
        response = try values.decode(AidenBotFavorites.self, forKey: .response)
        guard request.botIds == response.botIds else {
            throw AidenBotContractError.invalidCombination("bot favorites fixture")
        }
    }
}

struct AidenBotNoticeAcknowledgementContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotNoticeAcknowledgement
    let response: AidenBotNoticeStatus

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        request = try values.decode(AidenBotNoticeAcknowledgement.self, forKey: .request)
        response = try values.decode(AidenBotNoticeStatus.self, forKey: .response)
        guard request.version == response.version,
              !response.requiresAcknowledgement,
              request.decision == response.acceptedDecision else {
            throw AidenBotContractError.invalidCombination("bot notice fixture")
        }
    }
}

struct AidenBotAvatarUploadContractFixture: Codable, Equatable, Sendable {
    let request: AidenBotAvatarUpload
    let response: AidenBotAvatarAsset
}

struct AidenBotLegacyNonNegotiatingFixture: Codable, Equatable {
    let pairingExchange: AidenRemoteContractFixture.PairingExchange
    let server: AidenServer

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        pairingExchange = try values.decode(
            AidenRemoteContractFixture.PairingExchange.self,
            forKey: .pairingExchange
        )
        server = try values.decode(AidenServer.self, forKey: .server)
        let legacyCapabilities = Set(pairingExchange.capabilities)
        guard legacyCapabilities == Set(server.capabilities),
              server.serverCapabilities == nil,
              !legacyCapabilities.contains(.botRead),
              !legacyCapabilities.contains(.botWrite) else {
            throw AidenBotContractError.invalidCombination("legacy Bot negotiation fixture")
        }
    }
}
