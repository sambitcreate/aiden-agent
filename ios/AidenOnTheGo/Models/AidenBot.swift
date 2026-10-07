import Foundation

enum AidenBotContractError: Error, Equatable, LocalizedError {
    case invalidField(String)
    case invalidCombination(String)

    var errorDescription: String? {
        switch self {
        case .invalidCombination("no available provider and model"):
            String(
                localized: "Set up a provider and model on your paired desktop. In Aiden Agent, open Settings → Providers, connect or refresh a provider, and make at least one chat model available. Then tap Try Again."
            )
        case .invalidCombination("unavailable custom access"):
            String(
                localized: "One or more selected AI, Files, Connections, or Skills are no longer available. Review this Bot’s access choices and try again."
            )
        case .invalidField, .invalidCombination:
            String(
                localized: "Aiden Agent returned Bot information this version of Aiden On The Go can’t use. Update Aiden Agent and Aiden On The Go, then try again."
            )
        }
    }
}

struct AidenBotDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

enum AidenBotWire {
    static let maxNameLength = 80
    static let maxPurposeLength = 280
    static let maxGreetingLength = 2_000
    static let maxInstructionsLength = 32_000
    static let maxSummaryLength = 280
    static let maxPreviewLength = 500
    static let maxBots = 256
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

enum AidenBotAvatarShape: String, Codable, CaseIterable, Sendable {
    case wisp, orb, drop, hex, cloud, peak, squircle, capsule
}

enum AidenBotAvatarColor: String, Codable, CaseIterable, Sendable {
    case lilac, sky, mint, sun, periwinkle, coral, peach, aqua, rose, lime, plum, graphite
}

/// A Bot character on the wire: `{version: 1, shape, color}`. Older hosts may
/// still send `eyes` and `detail`; they are accepted, ignored, and never sent.
struct AidenBotAvatarRecipe: Codable, Equatable, Sendable {
    let version: Int
    let shape: AidenBotAvatarShape
    let color: AidenBotAvatarColor

    init(shape: AidenBotAvatarShape, color: AidenBotAvatarColor) {
        version = 1
        self.shape = shape
        self.color = color
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        version = try values.decode(Int.self, forKey: .version)
        guard version == 1 else { throw AidenBotContractError.invalidField("avatar.version") }
        shape = try values.decode(AidenBotAvatarShape.self, forKey: .shape)
        color = try values.decode(AidenBotAvatarColor.self, forKey: .color)
    }

    private enum CodingKeys: String, CodingKey {
        case version, shape, color
    }

    static func decodeRequest(from decoder: Decoder) throws -> Self {
        try AidenBotWire.requireOnlyKeys(
            decoder,
            allowed: ["version", "shape", "color", "eyes", "detail"]
        )
        return try Self(from: decoder)
    }
}

/// A Bot's semantic avatar. Since revision 25 it is always a recipe; the
/// legacy string ids are gone from the wire.
enum AidenBotSemanticAvatar: Codable, Equatable, Sendable {
    case recipe(AidenBotAvatarRecipe)

    var recipe: AidenBotAvatarRecipe {
        switch self {
        case let .recipe(value): value
        }
    }

    init(from decoder: Decoder) throws {
        self = .recipe(try AidenBotAvatarRecipe(from: decoder))
    }

    func encode(to encoder: Encoder) throws {
        try recipe.encode(to: encoder)
    }

    static func decodeRequest(from decoder: Decoder) throws -> Self {
        .recipe(try AidenBotAvatarRecipe.decodeRequest(from: decoder))
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
    case ready, degraded, unavailable
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
    /// Present when the host advertises `bot-durable-session-v1`.
    let sessionState: AidenBotSessionStateKind?

    init(detail: AidenBotDetail) {
        id = detail.id
        name = detail.name
        purpose = detail.purpose
        avatar = detail.avatar
        health = detail.health
        createdAt = detail.createdAt
        updatedAt = detail.updatedAt
        revision = detail.revision
        sessionState = detail.sessionState
    }

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
        sessionState = try AidenBotWire.optional(
            AidenBotSessionStateKind.self,
            from: values,
            forKey: .sessionState
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
        guard AidenRemoteTimestamp.isOrdered(
            createdAt: createdTimestamp,
            updatedAt: updatedTimestamp
        ) else {
            throw AidenBotContractError.invalidCombination("bot timestamps")
        }
    }
}

/// `GET /bots`: `{bots, maxBots}`. Revision 25 removed Favorites, so a
/// payload still carrying `favorites` is rejected.
struct AidenBotList: Codable, Equatable, Sendable {
    let bots: [AidenBotSummary]
    let maxBots: Int

    init(bots: [AidenBotSummary], maxBots: Int = AidenBotWire.maxBots) throws {
        guard Self.isValid(bots: bots, maxBots: maxBots) else {
            throw AidenBotContractError.invalidField("bots")
        }
        self.bots = bots
        self.maxBots = maxBots
    }

    init(from decoder: Decoder) throws {
        try AidenBotWire.requireOnlyKeys(decoder, allowed: ["bots", "maxBots"])
        let values = try decoder.container(keyedBy: CodingKeys.self)
        bots = try values.decode([AidenBotSummary].self, forKey: .bots)
        maxBots = try values.decode(Int.self, forKey: .maxBots)
        guard Self.isValid(bots: bots, maxBots: maxBots) else {
            throw AidenBotContractError.invalidField("bots")
        }
    }

    /// The same list without one Bot, used after a permanent delete.
    func removing(botID: String) throws -> Self {
        try Self(bots: bots.filter { $0.id != botID }, maxBots: maxBots)
    }

    /// The same list with one Bot inserted or replaced, used after a create.
    func upserting(_ bot: AidenBotSummary) throws -> Self {
        var next = bots.filter { $0.id != bot.id }
        next.append(bot)
        return try Self(bots: next, maxBots: maxBots)
    }

    private static func isValid(bots: [AidenBotSummary], maxBots: Int) -> Bool {
        bots.count <= AidenBotWire.maxBots
            && maxBots == AidenBotWire.maxBots
            && bots.count <= maxBots
            && Set(bots.map(\.id)).count == bots.count
    }

    private enum CodingKeys: String, CodingKey {
        case bots, maxBots
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
    let visionModelSelection: AidenBotModelSelection?
    let createdAt: Date
    let updatedAt: Date
    let revision: String
    /// Present when the host advertises `bot-durable-session-v1`.
    let sessionState: AidenBotSessionStateKind?

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
        sessionState = try AidenBotWire.optional(
            AidenBotSessionStateKind.self,
            from: values,
            forKey: .sessionState
        )
        access = try values.decode(AidenBotAccessView.self, forKey: .access)
        modelSelection = try AidenBotWire.optional(
            AidenBotModelSelection.self,
            from: values,
            forKey: .modelSelection
        )
        visionModelSelection = try AidenBotWire.optional(
            AidenBotModelSelection.self,
            from: values,
            forKey: .visionModelSelection
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
        guard access.botId == id else {
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
    /// Optional since revision 25: omitted means Full Access by default, and a
    /// Bot created without an AI model reports `sessionState: needs_model`.
    let access: AidenBotAccessUpdate?

    init(
        name: String,
        purpose: String,
        openingGreeting: String? = nil,
        instructions: String,
        avatar: AidenBotSemanticAvatar,
        access: AidenBotAccessUpdate? = nil
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
        access = try values.decodeIfPresent(AidenBotAccessUpdate.self, forKey: .access)
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
    let supportsImages: Bool

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenBotWire.requiredString(values, forKey: .id, maxLength: 512)
        label = try AidenBotWire.requiredString(values, forKey: .label, maxLength: 160)
        available = try values.decode(Bool.self, forKey: .available)
        supportsImages = try values.decode(Bool.self, forKey: .supportsImages)
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
    let skillsEnabled: Bool
    let otherCapabilities: [AidenBotCapabilityOption]

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
        skillsEnabled = values.contains(.skillsEnabled)
            ? try values.decode(Bool.self, forKey: .skillsEnabled) : true
        otherCapabilities = try values.decode([AidenBotCapabilityOption].self, forKey: .otherCapabilities)

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

    func model(providerId: String, modelId: String) -> AidenBotModelOption? {
        providers.first(where: { $0.id == providerId })?
            .models.first(where: { $0.id == modelId })
    }

    // Disabled catalogs contain only authenticated retained skills; selection controls
    // still prohibit adding an unavailable choice and the Mac enforces saved ownership.
    func containsAvailable(_ selection: AidenBotCustomSelection) -> Bool {
        guard containsAvailable(providerId: selection.providerId, modelId: selection.modelId),
              !selection.shellEnabled || shellAvailable else {
            return false
        }
        return Set(selection.fileScopeIds).isSubset(of: Set(fileScopes.filter(\.available).map(\.id)))
            && Set(selection.connectionIds).isSubset(of: Set(connections.filter(\.available).map(\.id)))
            && Set(selection.skillIds).isSubset(of: Set(skills.filter { $0.available || !skillsEnabled }.map(\.id)))
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
    case full(
        catalogRevision: String,
        selection: AidenBotModelSelection? = nil,
        visionSelection: AidenBotModelSelection? = nil
    )
    case custom(
        catalogRevision: String,
        selection: AidenBotCustomSelection,
        visionSelection: AidenBotModelSelection? = nil
    )

    var catalogRevision: String {
        switch self {
        case let .full(catalogRevision, _, _), let .custom(catalogRevision, _, _):
            return catalogRevision
        }
    }

    var customSelection: AidenBotCustomSelection? {
        switch self {
        case .full:
            return nil
        case let .custom(_, selection, _):
            return selection
        }
    }

    var visionSelection: AidenBotModelSelection? {
        switch self {
        case let .full(_, _, selection), let .custom(_, _, selection): selection
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
                },
                visionSelection: try values.decodeIfPresent(
                    AidenBotModelSelection.self,
                    forKey: .visionModel
                )
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
                ),
                visionSelection: try values.decodeIfPresent(
                    AidenBotModelSelection.self,
                    forKey: .visionModel
                )
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .full(catalogRevision, selection, visionSelection):
            try values.encode(AidenBotAccessMode.full, forKey: .accessMode)
            try values.encode(catalogRevision, forKey: .catalogRevision)
            try values.encode(true, forKey: .confirmedForeground)
            try values.encodeIfPresent(selection?.providerId, forKey: .providerId)
            try values.encodeIfPresent(selection?.modelId, forKey: .modelId)
            try values.encode(visionSelection, forKey: .visionModel)
        case let .custom(catalogRevision, selection, visionSelection):
            try values.encode(AidenBotAccessMode.custom, forKey: .accessMode)
            try values.encode(catalogRevision, forKey: .catalogRevision)
            try values.encode(selection, forKey: .custom)
            try values.encode(visionSelection, forKey: .visionModel)
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case accessMode, catalogRevision, confirmedForeground, custom, providerId, modelId, visionModel
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
typealias AidenBotProviderModelOption = AidenBotModelOption
