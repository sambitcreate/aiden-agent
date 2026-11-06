import Foundation

/// Revision 59. Opaque catalog identities are never resolved from labels.
enum AidenRoutineModelWire {
    static func closed(_ decoder: Decoder, _ keys: Set<String>) throws { try AidenBotWire.requireOnlyKeys(decoder, allowed: keys) }
    static func optional<T: Decodable, K: CodingKey>(_ type: T.Type, _ c: KeyedDecodingContainer<K>, _ key: K) throws -> T? {
        c.contains(key) ? try c.decode(type, forKey: key) : nil
    }
    static func id(_ value: String) throws { try AidenOpenWorkWire.id(value) }
    static func costReceiptID(_ value: String) throws {
        guard value.utf8.count == 69, value.hasPrefix("cost_"), value.dropFirst(5).utf8.allSatisfy({
            (48...57).contains($0) || (97...102).contains($0)
        }) else { throw AidenRemoteClientError.invalidResponse }
    }
    static func label(_ value: String) throws { try AidenOpenWorkWire.text(value, scalars: 160, bytes: 640) }
}
enum AidenRoutineThinking: String, Codable, CaseIterable, Identifiable, Sendable {
    case off, minimal, low, medium, high, xhigh, max
    var id: String { rawValue }
    var title: String { rawValue == "xhigh" ? "Extra high" : rawValue.capitalized }
}
struct AidenRoutineModelChoice: Codable, Equatable, Hashable, Sendable {
    let providerId: String
    let modelId: String
    var thinkingLevel: AidenRoutineThinking
    init(providerId: String, modelId: String, thinkingLevel: AidenRoutineThinking) {
        self.providerId = providerId; self.modelId = modelId; self.thinkingLevel = thinkingLevel
    }
    func validate() throws { try AidenRoutineModelWire.id(providerId); try AidenRoutineModelWire.id(modelId) }
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["providerId", "modelId", "thinkingLevel"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providerId = try c.decode(String.self, forKey: .providerId); modelId = try c.decode(String.self, forKey: .modelId)
        thinkingLevel = try c.decode(AidenRoutineThinking.self, forKey: .thinkingLevel); try validate()
    }
}
enum AidenRoutineModelSelection: Codable, Equatable, Sendable {
    case inherit
    case selected(primary: AidenRoutineModelChoice, fallback: AidenRoutineModelChoice?)
    var primary: AidenRoutineModelChoice? { if case let .selected(primary, _) = self { primary } else { nil } }
    var fallback: AidenRoutineModelChoice? { if case let .selected(_, fallback) = self { fallback } else { nil } }
    func validate() throws { try primary?.validate(); try fallback?.validate() }
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["mode", "primary", "fallback"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .mode) {
        case "inherit":
            guard !c.contains(.primary), !c.contains(.fallback) else { throw AidenRemoteClientError.invalidResponse }
            self = .inherit
        case "selected": self = .selected(primary: try c.decode(AidenRoutineModelChoice.self, forKey: .primary), fallback: try AidenRoutineModelWire.optional(AidenRoutineModelChoice.self, c, .fallback))
        default: throw AidenRemoteClientError.invalidResponse
        }
    }
    func encode(to encoder: Encoder) throws {
        try validate()
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .inherit: try c.encode("inherit", forKey: .mode)
        case let .selected(primary, fallback):
            try c.encode("selected", forKey: .mode); try c.encode(primary, forKey: .primary); try c.encodeIfPresent(fallback, forKey: .fallback)
        }
    }
    private enum CodingKeys: String, CodingKey { case mode, primary, fallback }
}
struct AidenRoutineModelSettings: Codable, Equatable, Sendable {
    let botId: String; let routineId: String; let revision: String
    let selection: AidenRoutineModelSelection; let updatedAt: Int; let lastMutationId: UUID?
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["botId", "routineId", "revision", "selection", "updatedAt", "lastMutationId"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId); routineId = try AidenOpenWorkWire.identity(c, .routineId)
        revision = try AidenOpenWorkWire.identity(c, .revision); selection = try c.decode(AidenRoutineModelSelection.self, forKey: .selection)
        updatedAt = try c.decode(Int.self, forKey: .updatedAt); try AidenOpenWorkWire.timestamp(updatedAt)
        lastMutationId = try AidenRoutineModelWire.optional(String.self, c, .lastMutationId).map(AidenOpenWorkWire.uuid)
    }
    private enum CodingKeys: String, CodingKey { case botId, routineId, revision, selection, updatedAt, lastMutationId }
}
struct AidenRoutineModelSave: Codable, Equatable, Sendable {
    let botId: String; let routineId: String; let mutationId: UUID
    let expectedRevision: String; let catalogRevision: String; let selection: AidenRoutineModelSelection
    init(botId: String, routineId: String, mutationId: UUID, expectedRevision: String, catalogRevision: String, selection: AidenRoutineModelSelection) {
        self.botId = botId; self.routineId = routineId; self.mutationId = mutationId
        self.expectedRevision = expectedRevision; self.catalogRevision = catalogRevision; self.selection = selection
    }
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["botId", "routineId", "mutationId", "expectedRevision", "catalogRevision", "selection"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(botId: try c.decode(String.self, forKey: .botId), routineId: try c.decode(String.self, forKey: .routineId),
            mutationId: try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)),
            expectedRevision: try c.decode(String.self, forKey: .expectedRevision), catalogRevision: try c.decode(String.self, forKey: .catalogRevision), selection: try c.decode(AidenRoutineModelSelection.self, forKey: .selection))
        try validate()
    }
    private enum CodingKeys: String, CodingKey { case botId, routineId, mutationId, expectedRevision, catalogRevision, selection }
    func validate() throws {
        for value in [botId, routineId, expectedRevision, catalogRevision] { try AidenRoutineModelWire.id(value) }
        _ = try AidenOpenWorkWire.uuid(mutationId.uuidString); try selection.validate()
    }
}
struct AidenRoutineModelOption: Codable, Equatable, Identifiable, Sendable {
    let id: String; let label: String; let available: Bool; let supportsImages: Bool; let thinkingLevels: [AidenRoutineThinking]
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["id", "label", "available", "supportsImages", "thinkingLevels"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenOpenWorkWire.identity(c, .id); label = try c.decode(String.self, forKey: .label); try AidenRoutineModelWire.label(label)
        available = try c.decode(Bool.self, forKey: .available); supportsImages = try c.decode(Bool.self, forKey: .supportsImages)
        thinkingLevels = try c.decode([AidenRoutineThinking].self, forKey: .thinkingLevels)
        guard thinkingLevels.count <= 7, Set(thinkingLevels).count == thinkingLevels.count else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case id, label, available, supportsImages, thinkingLevels }
}
struct AidenRoutineModelProvider: Codable, Equatable, Identifiable, Sendable {
    let id: String; let label: String; let available: Bool; let models: [AidenRoutineModelOption]
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["id", "label", "available", "models"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try AidenOpenWorkWire.identity(c, .id); label = try c.decode(String.self, forKey: .label); try AidenRoutineModelWire.label(label)
        available = try c.decode(Bool.self, forKey: .available); models = try c.decode([AidenRoutineModelOption].self, forKey: .models)
        guard models.count <= 512, Set(models.map(\.id)).count == models.count else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case id, label, available, models }
}
struct AidenRoutineModelCatalog: Codable, Equatable, Sendable {
    let revision: String; let providers: [AidenRoutineModelProvider]
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["revision", "providers"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        revision = try AidenOpenWorkWire.identity(c, .revision); providers = try c.decode([AidenRoutineModelProvider].self, forKey: .providers)
        guard providers.count <= 64, providers.reduce(0, { $0 + $1.models.count }) <= 512,
              Set(providers.map(\.id)).count == providers.count else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case revision, providers }
    func option(_ choice: AidenRoutineModelChoice) -> (AidenRoutineModelProvider, AidenRoutineModelOption)? {
        guard let provider = providers.first(where: { $0.id == choice.providerId }), let model = provider.models.first(where: { $0.id == choice.modelId }) else { return nil }
        return (provider, model)
    }
    func admits(_ choice: AidenRoutineModelChoice) -> Bool {
        guard let (provider, model) = option(choice) else { return false }
        return provider.available && model.available && model.thinkingLevels.contains(choice.thinkingLevel)
    }
    func label(_ choice: AidenRoutineModelChoice) -> String {
        guard let (provider, model) = option(choice) else { return "Unavailable saved model" }
        return "\(provider.label) · \(model.label)"
    }
}
enum AidenRoutineModelResult: Decodable, Equatable, Sendable {
    enum Code: String, Decodable, Sendable { case conflict, invalid, unavailable, notFound = "not_found", historyFull = "history_full" }
    case accepted(settings: AidenRoutineModelSettings, mutationId: UUID, replayed: Bool)
    case rejected(code: Code, settings: AidenRoutineModelSettings?)
    var settings: AidenRoutineModelSettings? { switch self { case let .accepted(settings, _, _): settings; case let .rejected(_, settings): settings } }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if try c.decode(Bool.self, forKey: .ok) {
            try AidenRoutineModelWire.closed(decoder, ["ok", "settings", "mutationId", "replayed"])
            self = .accepted(settings: try c.decode(AidenRoutineModelSettings.self, forKey: .settings), mutationId: try AidenOpenWorkWire.uuid(c.decode(String.self, forKey: .mutationId)), replayed: try c.decode(Bool.self, forKey: .replayed))
        } else {
            try AidenRoutineModelWire.closed(decoder, ["ok", "code", "error", "settings"])
            try AidenRoutineModelWire.label(c.decode(String.self, forKey: .error))
            self = .rejected(code: try c.decode(Code.self, forKey: .code), settings: try AidenRoutineModelWire.optional(AidenRoutineModelSettings.self, c, .settings))
        }
    }
    private enum CodingKeys: String, CodingKey { case ok, settings, mutationId, replayed, code, error }
}
struct AidenRoutineRunModel: Decodable, Equatable, Sendable {
    enum FallbackReason: String, Decodable, Sendable { case modelUnavailable = "model_unavailable", credentialsUnavailable = "credentials_unavailable" }
    let chosen: AidenRoutineModelChoice; let actual: AidenRoutineModelChoice
    let providerLabel: String; let modelLabel: String; let chosenProviderLabel: String; let chosenModelLabel: String
    let fallbackReason: FallbackReason?
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["chosen", "actual", "providerLabel", "modelLabel", "chosenProviderLabel", "chosenModelLabel", "fallbackReason"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        chosen = try c.decode(AidenRoutineModelChoice.self, forKey: .chosen); actual = try c.decode(AidenRoutineModelChoice.self, forKey: .actual)
        providerLabel = try c.decode(String.self, forKey: .providerLabel); modelLabel = try c.decode(String.self, forKey: .modelLabel)
        chosenProviderLabel = try c.decode(String.self, forKey: .chosenProviderLabel); chosenModelLabel = try c.decode(String.self, forKey: .chosenModelLabel)
        for label in [providerLabel, modelLabel, chosenProviderLabel, chosenModelLabel] { try AidenRoutineModelWire.label(label) }
        fallbackReason = try AidenRoutineModelWire.optional(FallbackReason.self, c, .fallbackReason)
    }
    private enum CodingKeys: String, CodingKey { case chosen, actual, providerLabel, modelLabel, chosenProviderLabel, chosenModelLabel, fallbackReason }
}
struct AidenRoutineModelRun: Decodable, Equatable, Identifiable, Sendable {
    enum Trigger: String, Decodable, Sendable { case scheduled, manual, event, retry, catchUp = "catch_up" }
    let runId: String; var id: String { runId }; let submissionId: String?
    let admittedAt: Int; let startedAt: Int?; let scheduledFor: Int?; let timezone: String?
    let triggerKind: Trigger; let model: AidenRoutineRunModel
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["runId", "submissionId", "admittedAt", "startedAt", "scheduledFor", "timezone", "triggerKind", "model"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runId = try AidenOpenWorkWire.identity(c, .runId); submissionId = try AidenRoutineModelWire.optional(String.self, c, .submissionId)
        if let submissionId { try AidenOpenWorkWire.decimal(submissionId) }
        admittedAt = try c.decode(Int.self, forKey: .admittedAt); startedAt = try AidenRoutineModelWire.optional(Int.self, c, .startedAt)
        scheduledFor = try AidenRoutineModelWire.optional(Int.self, c, .scheduledFor); timezone = try AidenRoutineModelWire.optional(String.self, c, .timezone)
        for stamp in [admittedAt, startedAt, scheduledFor].compactMap({ $0 }) { try AidenOpenWorkWire.timestamp(stamp) }
        if let timezone { guard timezone.utf16.count <= 100, TimeZone(identifier: timezone) != nil else { throw AidenRemoteClientError.invalidResponse } }
        guard scheduledFor == nil || timezone != nil else { throw AidenRemoteClientError.invalidResponse }
        triggerKind = try c.decode(Trigger.self, forKey: .triggerKind); model = try c.decode(AidenRoutineRunModel.self, forKey: .model)
    }
    private enum CodingKeys: String, CodingKey { case runId, submissionId, admittedAt, startedAt, scheduledFor, timezone, triggerKind, model }
}
struct AidenBotResumeStatus: Decodable, Equatable, Sendable {
    let requiresUnknownCostAcknowledgement: Bool
    let interruptedSubmissionId: String?
    let costReceiptId: String?
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["requiresUnknownCostAcknowledgement", "interruptedSubmissionId", "costReceiptId"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requiresUnknownCostAcknowledgement = try c.decode(Bool.self, forKey: .requiresUnknownCostAcknowledgement)
        interruptedSubmissionId = try AidenRoutineModelWire.optional(String.self, c, .interruptedSubmissionId)
        if let interruptedSubmissionId { try AidenOpenWorkWire.decimal(interruptedSubmissionId) }
        costReceiptId = try AidenRoutineModelWire.optional(String.self, c, .costReceiptId)
        if let costReceiptId { try AidenRoutineModelWire.costReceiptID(costReceiptId) }
        guard !requiresUnknownCostAcknowledgement || interruptedSubmissionId != nil,
              requiresUnknownCostAcknowledgement == (costReceiptId != nil) else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case requiresUnknownCostAcknowledgement, interruptedSubmissionId, costReceiptId }
}
struct AidenBotResumeRequest: Encodable, Equatable, Sendable {
    let acknowledgeUnknownCost: Bool
    var expectedSubmissionId: String? = nil
    var expectedCostReceiptId: String? = nil
    func validate() throws {
        guard acknowledgeUnknownCost == (expectedSubmissionId != nil), acknowledgeUnknownCost == (expectedCostReceiptId != nil) else { throw AidenRemoteClientError.invalidResponse }
        if let expectedSubmissionId { try AidenOpenWorkWire.decimal(expectedSubmissionId) }
        if let expectedCostReceiptId { try AidenRoutineModelWire.costReceiptID(expectedCostReceiptId) }
    }
    func encode(to encoder: Encoder) throws {
        try validate()
        var c = encoder.container(keyedBy: CodingKeys.self)
        if acknowledgeUnknownCost {
            try c.encode(true, forKey: .acknowledgeUnknownCost)
            try c.encode(expectedSubmissionId, forKey: .expectedSubmissionId)
            try c.encode(expectedCostReceiptId, forKey: .expectedCostReceiptId)
        }
    }
    private enum CodingKeys: String, CodingKey { case acknowledgeUnknownCost, expectedSubmissionId, expectedCostReceiptId }
}

struct AidenRoutineModelDirectory: Decodable, Equatable, Sendable {
    struct Routine: Decodable, Equatable, Identifiable, Sendable {
        enum Kind: String, Decodable, Sendable { case scheduled, event, watch }
        let id: String; let name: String; let kind: Kind
        init(from decoder: Decoder) throws {
            try AidenRoutineModelWire.closed(decoder, ["id", "name", "kind"])
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try AidenOpenWorkWire.identity(c, .id); name = try c.decode(String.self, forKey: .name)
            try AidenRoutineModelWire.label(name); kind = try c.decode(Kind.self, forKey: .kind)
        }
        private enum CodingKeys: String, CodingKey { case id, name, kind }
    }
    let botId: String; let routines: [Routine]
    init(from decoder: Decoder) throws {
        try AidenRoutineModelWire.closed(decoder, ["botId", "routines"])
        let c = try decoder.container(keyedBy: CodingKeys.self)
        botId = try AidenOpenWorkWire.identity(c, .botId); routines = try c.decode([Routine].self, forKey: .routines)
        guard routines.count <= 1024, Set(routines.map(\.id)).count == routines.count else { throw AidenRemoteClientError.invalidResponse }
    }
    private enum CodingKeys: String, CodingKey { case botId, routines }
}
