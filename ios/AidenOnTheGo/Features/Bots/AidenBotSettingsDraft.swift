import SwiftUI

struct AidenBotCustomAccessSessionIdentity: Equatable {
    let instanceID: String?
    let deviceID: String?
    let connection: String
    let capabilityRevision: String

    @MainActor
    init(coordinator: AidenRemoteCoordinator) {
        let installation = coordinator.installationStore.activeInstallation
        instanceID = installation?.id
        deviceID = installation?.deviceId
        switch coordinator.connectionState {
        case .needsPairing: connection = "needs-pairing"
        case .connecting: connection = "connecting"
        case .connected: connection = "connected"
        case .offline: connection = "offline"
        }
        capabilityRevision = [
            installation?.deviceCapabilities.map(\.rawValue).sorted().joined(separator: ",") ?? "",
            installation?.serverCapabilities?.map(\.rawValue).sorted().joined(separator: ",") ?? "legacy",
        ].joined(separator: "|")
    }
}

struct AidenBotCustomAccessDraft: Equatable {
    var providerID: String
    var modelID: String
    var fileScopeIDs: Set<String>
    var shellEnabled: Bool
    var connectionIDs: Set<String>
    var skillIDs: Set<String>
    var otherCapabilityIDs: Set<String>

    private init(
        providerID: String,
        modelID: String,
        fileScopeIDs: Set<String>,
        shellEnabled: Bool,
        connectionIDs: Set<String>,
        skillIDs: Set<String>,
        otherCapabilityIDs: Set<String>
    ) {
        self.providerID = providerID
        self.modelID = modelID
        self.fileScopeIDs = fileScopeIDs
        self.shellEnabled = shellEnabled
        self.connectionIDs = connectionIDs
        self.skillIDs = skillIDs
        self.otherCapabilityIDs = otherCapabilityIDs
    }

    init?(catalog: AidenBotCapabilityCatalog) {
        guard let provider = catalog.providers.first(where: { provider in
            provider.available && provider.models.contains(where: \.available)
        }), let model = provider.models.first(where: \.available) else {
            return nil
        }
        self.init(
            providerID: provider.id,
            modelID: model.id,
            fileScopeIDs: Set(catalog.fileScopes.filter(\.available).map(\.id)),
            shellEnabled: catalog.shellAvailable,
            connectionIDs: Set(catalog.connections.filter(\.available).map(\.id)),
            skillIDs: Set(catalog.skills.filter(\.available).map(\.id)),
            otherCapabilityIDs: Set(catalog.otherCapabilities.filter(\.available).map(\.id))
        )
    }

    init?(access: AidenBotAccessView, catalog: AidenBotCapabilityCatalog) {
        if let custom = access.custom {
            providerID = custom.providerId
            modelID = custom.modelId
            fileScopeIDs = Set(custom.fileScopeIds)
            shellEnabled = custom.shellEnabled
            connectionIDs = Set(custom.connectionIds)
            skillIDs = Set(custom.skillIds)
            otherCapabilityIDs = Set(custom.otherCapabilityIds)
            return
        }

        guard let defaults = AidenBotCustomAccessDraft(catalog: catalog) else {
            return nil
        }
        providerID = defaults.providerID
        modelID = defaults.modelID
        fileScopeIDs = defaults.fileScopeIDs
        shellEnabled = defaults.shellEnabled
        connectionIDs = defaults.connectionIDs
        skillIDs = defaults.skillIDs
        otherCapabilityIDs = defaults.otherCapabilityIDs
    }

    func selection() throws -> AidenBotCustomSelection {
        try AidenBotCustomSelection(
            fileScopeIds: fileScopeIDs.sorted(),
            shellEnabled: shellEnabled,
            connectionIds: connectionIDs.sorted(),
            skillIds: skillIDs.sorted(),
            otherCapabilityIds: otherCapabilityIDs.sorted(),
            providerId: providerID,
            modelId: modelID
        )
    }

    func isSaveable(in catalog: AidenBotCapabilityCatalog) -> Bool {
        guard let selection = try? selection() else { return false }
        return catalog.containsAvailable(selection)
    }

    mutating func selectProvider(_ providerID: String, catalog: AidenBotCapabilityCatalog) {
        guard let provider = catalog.providers.first(where: {
            $0.id == providerID && $0.available
        }), let model = provider.models.first(where: \.available) else { return }
        self.providerID = provider.id
        modelID = model.id
    }
}

func aidenBotVisibleCapabilityOptions(
    _ options: [AidenBotCapabilityOption],
    selectedIDs: Set<String>
) -> [AidenBotCapabilityOption] {
    options.filter { $0.available || selectedIDs.contains($0.id) }
}

func aidenBotCapabilityOptionTitle(
    _ option: AidenBotCapabilityOption,
    isSelected: Bool
) -> String {
    guard !option.available else { return option.label }
    if isSelected, option.label == "Invalid skill" {
        return "Previously selected skill — unavailable"
    }
    return "\(option.label) — Unavailable"
}

enum AidenBotEditorDefaultAccess: Sendable {
    case recommended
    case full
    case custom
}

enum AidenBotEditorMode: Identifiable, Sendable {
    case create(defaultAccess: AidenBotEditorDefaultAccess)
    case edit(botID: String)

    var catalogBotID: String? {
        switch self {
        case .create: nil
        case let .edit(botID): botID
        }
    }

    var id: String {
        switch self {
        case let .create(defaultAccess): "create-\(String(describing: defaultAccess))"
        case let .edit(botID): "edit-\(botID)"
        }
    }
}

struct AidenBotEditorDraft: Equatable {
    var name: String
    var purpose: String
    var openingGreeting: String
    var instructions: String
    var avatar: AidenBotAvatarRecipe
    var usesFullAccess: Bool
    var customAccess: AidenBotCustomAccessDraft
    var visionProviderID: String?
    var visionModelID: String?

    init?(catalog: AidenBotCapabilityCatalog, defaultAccess: AidenBotEditorDefaultAccess) {
        guard let customAccess = AidenBotCustomAccessDraft(catalog: catalog) else { return nil }
        name = ""
        purpose = ""
        openingGreeting = ""
        instructions = Self.defaultInstructions
        avatar = Self.defaultAvatar
        switch defaultAccess {
        case .custom:
            usesFullAccess = false
        case .full:
            usesFullAccess = Self.fullAccessAccepted(in: catalog)
        case .recommended:
            usesFullAccess = Self.fullAccessAccepted(in: catalog)
        }
        self.customAccess = customAccess
        let vision = Self.suggestedVisionSelection(catalog: catalog, primary: customAccess)
        visionProviderID = vision?.providerId
        visionModelID = vision?.modelId
    }

    init?(detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog) {
        guard var customAccess = AidenBotCustomAccessDraft(access: detail.access, catalog: catalog)
        else { return nil }
        if let selected = detail.modelSelection,
           let provider = catalog.providers.first(where: { $0.id == selected.providerId }),
           provider.models.contains(where: { $0.id == selected.modelId }) {
            customAccess.providerID = selected.providerId
            customAccess.modelID = selected.modelId
        }
        name = detail.name
        purpose = detail.purpose
        openingGreeting = detail.openingGreeting ?? ""
        instructions = detail.instructions
        avatar = AidenBotCharacterDraft(avatar: detail.avatar.semantic).recipe
        usesFullAccess = detail.access.accessMode.rawValue == AidenBotAccessMode.full.rawValue
        self.customAccess = customAccess
        let vision = detail.visionModelSelection
            ?? Self.suggestedVisionSelection(catalog: catalog, primary: customAccess)
        visionProviderID = vision?.providerId
        visionModelID = vision?.modelId
    }

    static let defaultAvatar = AidenBotCharacter.defaultRecipe

    static let defaultInstructions = "Help clearly, use the selected tools when useful, and keep me in control."

    /// The answer to "What should it help with?" becomes the subtitle and
    /// seeds the instructions; an empty answer keeps the helpful default.
    static func seededInstructions(helpWith answer: String) -> String {
        let trimmed = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? defaultInstructions : trimmed
    }

    /// Full Access is the default whenever the desktop allows it. Phones no
    /// longer show a notice wall, so a desktop that still requires its notice,
    /// or that recorded "Customize first", keeps new Bots on Custom.
    static func fullAccessAccepted(in catalog: AidenBotCapabilityCatalog) -> Bool {
        switch catalog.notice.acceptedDecision {
        case .continueFull: true
        case .customizeFirst: false
        case nil: !catalog.notice.requiresAcknowledgement
        }
    }

    private static func suggestedVisionSelection(
        catalog: AidenBotCapabilityCatalog,
        primary: AidenBotCustomAccessDraft
    ) -> AidenBotModelSelection? {
        guard catalog.model(providerId: primary.providerID, modelId: primary.modelID)?.supportsImages != true
        else { return nil }
        let preferred = catalog.providers.first(where: { provider in
            provider.id == primary.providerID && provider.available
                && provider.models.contains(where: { $0.available && $0.supportsImages })
        }) ?? catalog.providers.first(where: { provider in
            provider.available && provider.models.contains(where: { $0.available && $0.supportsImages })
        })
        guard let provider = preferred,
              let model = provider.models.first(where: { $0.available && $0.supportsImages }) else {
            return nil
        }
        return AidenBotModelSelection(providerId: provider.id, modelId: model.id)
    }

    func visionSelection(catalog: AidenBotCapabilityCatalog) throws -> AidenBotModelSelection? {
        guard catalog.model(
            providerId: customAccess.providerID,
            modelId: customAccess.modelID
        )?.supportsImages != true else { return nil }
        guard let visionProviderID, let visionModelID,
              let model = catalog.model(providerId: visionProviderID, modelId: visionModelID),
              model.available, model.supportsImages,
              catalog.providers.first(where: { $0.id == visionProviderID })?.available == true else {
            throw AidenBotContractError.invalidCombination("image-capable companion model")
        }
        return AidenBotModelSelection(providerId: visionProviderID, modelId: visionModelID)
    }

    mutating func reconcileVisionSelection(catalog: AidenBotCapabilityCatalog) {
        if catalog.model(
            providerId: customAccess.providerID,
            modelId: customAccess.modelID
        )?.supportsImages == true {
            visionProviderID = nil
            visionModelID = nil
            return
        }
        if let visionProviderID, let visionModelID,
           catalog.model(providerId: visionProviderID, modelId: visionModelID)?.supportsImages == true {
            return
        }
        let suggestion = Self.suggestedVisionSelection(catalog: catalog, primary: customAccess)
        visionProviderID = suggestion?.providerId
        visionModelID = suggestion?.modelId
    }

    func accessUpdate(catalog: AidenBotCapabilityCatalog) throws -> AidenBotAccessUpdate {
        let modelSelection = AidenBotModelSelection(
            providerId: customAccess.providerID,
            modelId: customAccess.modelID
        )
        guard catalog.containsAvailable(
            providerId: modelSelection.providerId,
            modelId: modelSelection.modelId
        ) else {
            throw AidenBotContractError.invalidCombination("unavailable Bot model")
        }
        if usesFullAccess {
            guard Self.fullAccessAccepted(in: catalog) else {
                throw AidenBotContractError.invalidCombination("full access notice")
            }
            return .full(
                catalogRevision: catalog.revision,
                selection: modelSelection,
                visionSelection: try visionSelection(catalog: catalog)
            )
        }
        let selection = try customAccess.selection()
        guard catalog.containsAvailable(selection) else {
            throw AidenBotContractError.invalidCombination("unavailable custom access")
        }
        return .custom(
            catalogRevision: catalog.revision,
            selection: selection,
            visionSelection: try visionSelection(catalog: catalog)
        )
    }

    func createRequest(catalog: AidenBotCapabilityCatalog) throws -> AidenBotCreateRequest {
        try AidenBotCreateRequest(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
            openingGreeting: Self.optionalTrimmed(openingGreeting),
            instructions: instructions.trimmingCharacters(in: .whitespacesAndNewlines),
            avatar: .recipe(avatar),
            access: try accessUpdate(catalog: catalog)
        )
    }

    func identityPatch(comparedTo detail: AidenBotDetail) throws -> AidenBotIdentityPatch? {
        let nextName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextPurpose = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextGreeting = openingGreeting.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextAvatar = AidenBotSemanticAvatar.recipe(avatar)
        let greetingChanged = nextGreeting != (detail.openingGreeting ?? "")
        guard nextName != detail.name || nextPurpose != detail.purpose
                || greetingChanged || nextInstructions != detail.instructions
                || nextAvatar != detail.avatar.semantic else { return nil }
        return try AidenBotIdentityPatch(
            name: nextName == detail.name ? nil : nextName,
            purpose: nextPurpose == detail.purpose ? nil : nextPurpose,
            openingGreeting: greetingChanged ? nextGreeting : nil,
            instructions: nextInstructions == detail.instructions ? nil : nextInstructions,
            avatar: nextAvatar == detail.avatar.semantic ? nil : nextAvatar
        )
    }

    func changesAccess(comparedTo detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog) throws -> Bool {
        let next = try accessUpdate(catalog: catalog)
        switch next {
        case let .full(_, selection, visionSelection):
            return detail.access.accessMode.rawValue != AidenBotAccessMode.full.rawValue
                || detail.modelSelection != selection
                || detail.visionModelSelection != visionSelection
        case let .custom(_, selection, visionSelection):
            return detail.access.accessMode.rawValue != AidenBotAccessMode.custom.rawValue
                || detail.access.custom != selection
                || detail.visionModelSelection != visionSelection
        }
    }

    func isSaveable(catalog: AidenBotCapabilityCatalog) -> Bool {
        (try? createRequest(catalog: catalog)) != nil
    }

    func isSatisfied(by detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog) throws -> Bool {
        try identityPatch(comparedTo: detail) == nil
            && !changesAccess(comparedTo: detail, catalog: catalog)
    }

    private static func optionalTrimmed(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

func aidenBotEditorIsDirty(
    draft: AidenBotEditorDraft?,
    cleanCreateDraft: AidenBotEditorDraft?,
    baselineBot: AidenBotDetail?,
    catalog: AidenBotCapabilityCatalog?,
    isCreating: Bool,
    hasAvatarCandidate: Bool = false
) -> Bool {
    if hasAvatarCandidate { return true }
    guard let draft else { return false }
    if isCreating { return draft != cleanCreateDraft }
    guard let baselineBot, let catalog else { return false }
    let identityChanged = (try? draft.identityPatch(comparedTo: baselineBot)) != nil
    let accessChanged = (try? draft.changesAccess(comparedTo: baselineBot, catalog: catalog)) == true
    return identityChanged || accessChanged
}

func aidenBotEditorCreateFailureIsAmbiguous(_ error: Error) -> Bool {
    if error is CancellationError || error is URLError { return true }
    guard let remoteError = error as? AidenRemoteClientError else { return true }
    switch remoteError {
    case .invalidResponse:
        // A canonical success can be committed before a malformed/truncated
        // response is detected, so preserve the key for authoritative replay.
        return true
    case let .server(statusCode, _), let .unexpectedStatus(statusCode):
        return (200..<300).contains(statusCode)
            || statusCode == 408
            || statusCode == 429
            || statusCode >= 500
    case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged:
        return false
    }
}

func aidenBotEditorCanSubmitSettings(hasAvatarCandidate: Bool) -> Bool {
    !hasAvatarCandidate
}

func aidenBotEditorResolvedDraft(
    mode: AidenBotEditorMode,
    catalog: AidenBotCapabilityCatalog,
    bot: AidenBotDetail?
) throws -> AidenBotEditorDraft {
    switch mode {
    case let .create(defaultAccess):
        guard let draft = AidenBotEditorDraft(catalog: catalog, defaultAccess: defaultAccess)
        else {
            throw AidenBotContractError.invalidCombination("no available provider and model")
        }
        return draft
    case .edit:
        guard let bot else {
            throw AidenBotContractError.invalidCombination("missing bot detail")
        }
        guard let draft = AidenBotEditorDraft(detail: bot, catalog: catalog) else {
            throw AidenBotContractError.invalidCombination("no available provider and model")
        }
        return draft
    }
}

/// Three-way merge used after a revision conflict or ambiguous edit response.
/// Fields unchanged by the person adopt the Mac's authoritative value; fields
/// deliberately edited in this sheet remain as the retry draft.
func aidenBotEditorRebasedDraft(
    _ draft: AidenBotEditorDraft,
    baseline: AidenBotDetail,
    baselineCatalog: AidenBotCapabilityCatalog,
    authoritative: AidenBotDetail,
    authoritativeCatalog: AidenBotCapabilityCatalog
) throws -> AidenBotEditorDraft {
    guard let baselineDraft = AidenBotEditorDraft(detail: baseline, catalog: baselineCatalog),
          var rebased = AidenBotEditorDraft(
              detail: authoritative,
              catalog: authoritativeCatalog
          ) else {
        throw AidenBotContractError.invalidCombination("no available provider and model")
    }

    if let identityPatch = try draft.identityPatch(comparedTo: baseline) {
        if identityPatch.name != nil { rebased.name = draft.name }
        if identityPatch.purpose != nil { rebased.purpose = draft.purpose }
        if identityPatch.openingGreeting != nil {
            rebased.openingGreeting = draft.openingGreeting
        }
        if identityPatch.instructions != nil { rebased.instructions = draft.instructions }
        if identityPatch.avatar != nil { rebased.avatar = draft.avatar }
    }

    if draft.usesFullAccess != baselineDraft.usesFullAccess {
        rebased.usesFullAccess = draft.usesFullAccess
    }
    // Provider and model are one binding. Never combine a user-edited model
    // with a concurrently changed provider (or the inverse).
    let modelBindingChanged =
        draft.customAccess.providerID != baselineDraft.customAccess.providerID
        || draft.customAccess.modelID != baselineDraft.customAccess.modelID
    if modelBindingChanged {
        rebased.customAccess.providerID = draft.customAccess.providerID
        rebased.customAccess.modelID = draft.customAccess.modelID
    }
    let visionBindingChanged = draft.visionProviderID != baselineDraft.visionProviderID
        || draft.visionModelID != baselineDraft.visionModelID
    if visionBindingChanged {
        rebased.visionProviderID = draft.visionProviderID
        rebased.visionModelID = draft.visionModelID
    }
    if draft.customAccess.fileScopeIDs != baselineDraft.customAccess.fileScopeIDs {
        rebased.customAccess.fileScopeIDs = draft.customAccess.fileScopeIDs
    }
    if draft.customAccess.shellEnabled != baselineDraft.customAccess.shellEnabled {
        rebased.customAccess.shellEnabled = draft.customAccess.shellEnabled
    }
    if draft.customAccess.connectionIDs != baselineDraft.customAccess.connectionIDs {
        rebased.customAccess.connectionIDs = draft.customAccess.connectionIDs
    }
    if draft.customAccess.skillIDs != baselineDraft.customAccess.skillIDs {
        rebased.customAccess.skillIDs = draft.customAccess.skillIDs
    }
    if draft.customAccess.otherCapabilityIDs != baselineDraft.customAccess.otherCapabilityIDs {
        rebased.customAccess.otherCapabilityIDs = draft.customAccess.otherCapabilityIDs
    }
    return rebased
}
