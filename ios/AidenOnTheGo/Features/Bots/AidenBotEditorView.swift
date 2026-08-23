import SwiftUI

enum AidenBotEditorDefaultAccess: Sendable {
    case recommended
    case full
    case custom
}

enum AidenBotEditorMode: Identifiable, Sendable {
    case create(defaultAccess: AidenBotEditorDefaultAccess)
    case edit(botID: String)

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
    }

    init?(detail: AidenBotDetail, catalog: AidenBotCapabilityCatalog) {
        guard let customAccess = AidenBotCustomAccessDraft(access: detail.access, catalog: catalog)
        else { return nil }
        name = detail.name
        purpose = detail.purpose
        openingGreeting = detail.openingGreeting ?? ""
        instructions = detail.instructions
        switch detail.avatar.semantic {
        case let .recipe(recipe): avatar = recipe
        case .legacy: avatar = Self.defaultAvatar
        }
        usesFullAccess = detail.access.accessMode.rawValue == AidenBotAccessMode.full.rawValue
        self.customAccess = customAccess
    }

    static let defaultAvatar = AidenBotAvatarRecipe(
        shape: .orb,
        color: .sky,
        eyes: .happy,
        detail: .sparkles
    )

    static let defaultInstructions = "Help clearly, use the selected tools when useful, and keep me in control."

    static func fullAccessAccepted(in catalog: AidenBotCapabilityCatalog) -> Bool {
        catalog.notice.acceptedDecision?.rawValue == AidenBotNoticeDecision.continueFull.rawValue
    }

    func accessUpdate(catalog: AidenBotCapabilityCatalog) throws -> AidenBotAccessUpdate {
        if usesFullAccess {
            guard Self.fullAccessAccepted(in: catalog) else {
                throw AidenBotContractError.invalidCombination("full access notice")
            }
            return .full(catalogRevision: catalog.revision)
        }
        let selection = try customAccess.selection()
        guard catalog.containsAvailable(selection) else {
            throw AidenBotContractError.invalidCombination("unavailable custom access")
        }
        return .custom(catalogRevision: catalog.revision, selection: selection)
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
        case .full:
            return detail.access.accessMode.rawValue != AidenBotAccessMode.full.rawValue
        case let .custom(_, selection):
            return detail.access.accessMode.rawValue != AidenBotAccessMode.custom.rawValue
                || detail.access.custom != selection
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

private struct AidenBotEditorCreateAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let request: AidenBotCreateRequest
    let idempotencyKey: UUID
}

private struct AidenBotEditorEditAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
    let identityRevision: String
    let accessRevision: String
    let catalogRevision: String
    let token: UUID
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

struct AidenBotEditorView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let mode: AidenBotEditorMode
    var onSaved: (AidenBotDetail) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var baselineBot: AidenBotDetail?
    @State private var draft: AidenBotEditorDraft?
    @State private var cleanCreateDraft: AidenBotEditorDraft?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var activeCreateAttempt: AidenBotEditorCreateAttempt?
    @State private var retainedCreateAttempt: AidenBotEditorCreateAttempt?
    @State private var activeEditAttempt: AidenBotEditorEditAttempt?
    @State private var avatarModel: AidenBotGeneratedAvatarModel?
    @State private var isConfirmingDiscard = false

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var isSaving: Bool {
        activeCreateAttempt != nil || activeEditAttempt != nil || avatarModel?.isBusy == true
    }

    private var isCreating: Bool {
        if case .create = mode { return true }
        return false
    }

    private var isDirty: Bool {
        aidenBotEditorIsDirty(
            draft: draft,
            cleanCreateDraft: cleanCreateDraft,
            baselineBot: baselineBot,
            catalog: catalog,
            isCreating: isCreating,
            hasAvatarCandidate: avatarModel?.hasCandidate == true
        )
    }

    private var isCreateDraftFrozen: Bool {
        guard retainedCreateAttempt != nil else { return false }
        if case .create = mode { return true }
        return false
    }

    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
            && baselineBot?.health != .archived
    }

    private var canSave: Bool {
        guard canWrite, !isLoading, !isSaving,
              aidenBotEditorCanSubmitSettings(hasAvatarCandidate: avatarModel?.hasCandidate == true),
              let catalog, let draft,
              draft.isSaveable(catalog: catalog) else { return false }
        if case .edit = mode, let baselineBot {
            let identityChanged = (try? draft.identityPatch(comparedTo: baselineBot)) != nil
            let accessChanged = (try? draft.changesAccess(comparedTo: baselineBot, catalog: catalog)) == true
            return identityChanged || accessChanged
        }
        return true
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { requestDismiss() }
                            .disabled(isSaving)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isSaving ? "Saving…" : "Save") {
                            Task { await save() }
                        }
                        .disabled(!canSave)
                    }
                }
        }
        .interactiveDismissDisabled(isSaving || isDirty)
        .task(id: sessionIdentity) {
            let expectedSession = sessionIdentity
            reset(for: expectedSession)
            await load(for: expectedSession)
        }
        .onChange(of: sessionIdentity) { oldValue, newValue in
            if capturedContext != nil, oldValue != newValue {
                dismiss()
            }
        }
        .alert(
            "Couldn’t Save Bot",
            isPresented: Binding(
                get: { saveError != nil },
                set: { if !$0 { saveError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { saveError = nil }
        } message: {
            Text(saveError ?? "The Bot could not be saved.")
        }
        .confirmationDialog(
            "Discard changes?",
            isPresented: $isConfirmingDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) { }
        } message: {
            Text("Your unsaved Bot changes will be lost.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView("Loading Bot settings from your Mac…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            ContentUnavailableView {
                Label("Couldn’t Load Bot Editor", systemImage: "exclamationmark.bubble")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") {
                    let expectedSession = sessionIdentity
                    Task { await load(for: expectedSession) }
                }
            }
        } else if let catalog, draft != nil {
            editorForm(catalog)
        }
    }

    private func editorForm(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Form {
            identitySection
            accessModeSection(catalog)
            aiSection(catalog)
                .disabled(draft?.usesFullAccess == true)
            optionSection(
                title: "Connections",
                description: "Services and accounts this Bot may use.",
                options: catalog.connections,
                keyPath: \.connectionIDs
            )
            .disabled(draft?.usesFullAccess == true)
            optionSection(
                title: "Skills",
                description: "Aiden skills this Bot may use.",
                options: catalog.skills,
                keyPath: \.skillIDs
            )
            .disabled(draft?.usesFullAccess == true)
            filesAndShellSection(catalog)
                .disabled(draft?.usesFullAccess == true)
            optionSection(
                title: "Other Capabilities",
                description: "Additional capabilities available on this Mac.",
                options: catalog.otherCapabilities,
                keyPath: \.otherCapabilityIDs
            )
            .disabled(draft?.usesFullAccess == true)
            avatarSection

            if !canWrite {
                Section {
                    Label(readOnlyMessage, systemImage: "lock.fill")
                        .foregroundStyle(palette.secondary)
                }
            } else if isCreateDraftFrozen {
                Section {
                    Label(
                        "Use Save to safely retry the same creation request, or cancel to start over.",
                        systemImage: "arrow.clockwise.circle"
                    )
                    .foregroundStyle(palette.secondary)
                }
            }
            reviewSection(catalog)
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .disabled(isSaving || isCreateDraftFrozen)
        .scrollDismissesKeyboard(.interactively)
    }

    private var identitySection: some View {
        Section {
            TextField("Name", text: textBinding(\.name))
                .textContentType(.name)
                .accessibilityHint("The name shown for this Bot and its chats.")
            TextField("How should it help?", text: textBinding(\.purpose), axis: .vertical)
                .lineLimit(2...4)
            TextField("Opening greeting (optional)", text: textBinding(\.openingGreeting), axis: .vertical)
                .lineLimit(2...6)
            DisclosureGroup("Advanced") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Detailed behavior")
                        .font(.subheadline.weight(.medium))
                    TextEditor(text: textBinding(\.instructions))
                        .frame(minHeight: 130)
                        .accessibilityLabel("Detailed Bot behavior")
                    Text("The helpful default works for most Bots. Change this only when you need precise behavior.")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                }
            }
        } header: {
            Text("Identity")
        } footer: {
            Text("Describe what this Bot should do and how it should behave.")
        }
    }

    private var avatarSection: some View {
        Section {
            HStack(spacing: 16) {
                avatarPreview
                VStack(alignment: .leading, spacing: 3) {
                    Text("Semantic avatar")
                        .font(.headline)
                    Text("Edit this anytime. A generated photo can sit on top of it without replacing it.")
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                }
            }
            avatarPicker("Shape", values: AidenBotAvatarShape.allCases, selection: Binding(
                get: { draft?.avatar.shape ?? AidenBotEditorDraft.defaultAvatar.shape },
                set: { updateAvatar(shape: $0) }
            ))
            avatarPicker("Color", values: AidenBotAvatarColor.allCases, selection: Binding(
                get: { draft?.avatar.color ?? AidenBotEditorDraft.defaultAvatar.color },
                set: { updateAvatar(color: $0) }
            ))
            avatarPicker("Eyes", values: AidenBotAvatarEyes.allCases, selection: Binding(
                get: { draft?.avatar.eyes ?? AidenBotEditorDraft.defaultAvatar.eyes },
                set: { updateAvatar(eyes: $0) }
            ))
            avatarPicker("Detail", values: AidenBotAvatarDetail.allCases, selection: Binding(
                get: { draft?.avatar.detail ?? AidenBotEditorDraft.defaultAvatar.detail },
                set: { updateAvatar(detail: $0) }
            ))

            if let avatarModel, let draft {
                Divider()
                AidenBotGeneratedAvatarLifecycleView(
                    model: avatarModel,
                    semanticAvatar: .recipe(draft.avatar),
                    botName: draft.name.isEmpty ? "Bot" : draft.name
                )
                AidenBotImagePlaygroundView(
                    identity: .init(name: draft.name, purpose: draft.purpose)
                ) { copiedURL in
                    Task { await avatarModel.ingestCopiedCandidate(at: copiedURL) }
                }
            } else if isCreating {
                Label(
                    "Save this Bot, then choose Edit Bot to create a photo with Apple Image Playground.",
                    systemImage: "photo.badge.plus"
                )
                .font(.caption)
                .foregroundStyle(palette.secondary)
            }
        } header: {
            Text("Avatar")
        } footer: {
            Text("The semantic avatar remains available even when this Bot has a generated photo.")
        }
    }

    private func accessModeSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            Picker("Access", selection: fullAccessBinding(catalog)) {
                Text("Full").tag(true)
                Text("Custom").tag(false)
            }
            .pickerStyle(.segmented)
            .accessibilityHint("Custom Access can reduce the capabilities this Bot may use.")

            if draft?.usesFullAccess == true {
                Label("Uses everything Aiden and your Mac currently allow.", systemImage: "checkmark.shield")
                    .foregroundStyle(palette.secondary)
            }
        } header: {
            Text("Access")
        } footer: {
            if !AidenBotEditorDraft.fullAccessAccepted(in: catalog) {
                Text("Full Access is unavailable because Customize First was selected for this Mac.")
            } else {
                Text("Connections and Skills are the most important controls when using Custom Access.")
            }
        }
    }

    private func aiSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            Picker("Provider", selection: providerBinding(catalog)) {
                ForEach(catalog.providers) { provider in
                    Text(optionTitle(provider.label, available: provider.available))
                        .tag(provider.id)
                        .disabled(!provider.available)
                }
            }
            Picker("Model", selection: modelBinding(catalog)) {
                ForEach(selectedProvider(in: catalog)?.models ?? []) { model in
                    Text(optionTitle(model.label, available: model.available))
                        .tag(model.id)
                        .disabled(!model.available)
                }
            }
        } header: {
            Text("AI")
        } footer: {
            Text("Provider credentials stay on your Mac.")
        }
    }

    private func filesAndShellSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            ForEach(catalog.fileScopes) { option in
                Toggle(isOn: optionBinding(
                    id: option.id,
                    available: option.available,
                    keyPath: \.fileScopeIDs
                )) {
                    optionLabel(option.label, description: option.description, available: option.available)
                }
                .disabled(!option.available && !isSelected(option.id, keyPath: \.fileScopeIDs))
            }
            Toggle("Run commands", isOn: shellBinding(catalog))
                .disabled(!catalog.shellAvailable && !(draft?.customAccess.shellEnabled ?? false))
                .accessibilityHint("Allows Aiden’s existing shell tool for this Bot.")
        } header: {
            Text("Files and Commands")
        } footer: {
            Text("Choose which files the Bot may work with and whether it may run commands on the paired Mac.")
        }
    }

    private func optionSection(
        title: String,
        description: String,
        options: [AidenBotCapabilityOption],
        keyPath: WritableKeyPath<AidenBotCustomAccessDraft, Set<String>>
    ) -> some View {
        Section {
            if options.isEmpty {
                Text("None configured on this Mac")
                    .foregroundStyle(palette.secondary)
            } else {
                ForEach(options) { option in
                    Toggle(isOn: optionBinding(
                        id: option.id,
                        available: option.available,
                        keyPath: keyPath
                    )) {
                        optionLabel(option.label, description: option.description, available: option.available)
                    }
                    .disabled(!option.available && !isSelected(option.id, keyPath: keyPath))
                }
            }
        } header: {
            Text(title)
        } footer: {
            Text(description)
        }
    }

    private func reviewSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            LabeledContent("Name", value: draft?.name.isEmpty == false ? draft?.name ?? "" : "Not entered")
            LabeledContent(
                "How it helps",
                value: draft?.purpose.isEmpty == false ? draft?.purpose ?? "" : "Not entered"
            )
            if draft?.usesFullAccess == true {
                Label(
                    "Full Access: files, commands, Connections, and Skills allowed by the paired Mac",
                    systemImage: "checkmark.shield"
                )
            } else if let access = draft?.customAccess {
                LabeledContent("Access", value: "Custom")
                LabeledContent("Files", value: "\(access.fileScopeIDs.count) selected")
                LabeledContent("Commands", value: access.shellEnabled ? "Allowed" : "Off")
                LabeledContent("Connections", value: "\(access.connectionIDs.count) selected")
                LabeledContent("Skills", value: "\(access.skillIDs.count) selected")
            }
        } header: {
            Text("Review")
        } footer: {
            Text("Nothing is created or changed until you choose Save.")
        }
        .accessibilityElement(children: .contain)
    }

    private var avatarPreview: some View {
        let recipe = draft?.avatar ?? AidenBotEditorDraft.defaultAvatar
        return AidenBotSemanticAvatarView(
            avatar: .recipe(recipe),
            name: draft?.name ?? "Bot",
            size: 72,
            isDecorative: false
        )
    }

    private func avatarPicker<Value: RawRepresentable & CaseIterable & Hashable>(
        _ title: String,
        values: Value.AllCases,
        selection: Binding<Value>
    ) -> some View where Value.RawValue == String, Value.AllCases: RandomAccessCollection {
        Picker(title, selection: selection) {
            ForEach(Array(values), id: \.self) { value in
                Text(value.rawValue.capitalized).tag(value)
            }
        }
    }

    private func updateAvatar(
        shape: AidenBotAvatarShape? = nil,
        color: AidenBotAvatarColor? = nil,
        eyes: AidenBotAvatarEyes? = nil,
        detail: AidenBotAvatarDetail? = nil
    ) {
        guard var next = draft else { return }
        let current = next.avatar
        next.avatar = AidenBotAvatarRecipe(
            shape: shape ?? current.shape,
            color: color ?? current.color,
            eyes: eyes ?? current.eyes,
            detail: detail ?? current.detail
        )
        draft = next
        retainedCreateAttempt = nil
    }

    private func textBinding(_ keyPath: WritableKeyPath<AidenBotEditorDraft, String>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? "" },
            set: { value in
                guard var next = draft else { return }
                next[keyPath: keyPath] = value
                draft = next
                retainedCreateAttempt = nil
            }
        )
    }

    private func fullAccessBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<Bool> {
        Binding(
            get: { draft?.usesFullAccess ?? false },
            set: { enabled in
                guard var next = draft else { return }
                next.usesFullAccess = enabled && AidenBotEditorDraft.fullAccessAccepted(in: catalog)
                draft = next
                retainedCreateAttempt = nil
            }
        )
    }

    private func selectedProvider(in catalog: AidenBotCapabilityCatalog) -> AidenBotProviderOption? {
        catalog.providers.first { $0.id == draft?.customAccess.providerID }
    }

    private func providerBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.customAccess.providerID ?? "" },
            set: { providerID in
                guard var next = draft else { return }
                next.customAccess.selectProvider(providerID, catalog: catalog)
                draft = next
                retainedCreateAttempt = nil
            }
        )
    }

    private func modelBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.customAccess.modelID ?? "" },
            set: { modelID in
                guard let provider = selectedProvider(in: catalog), provider.available,
                      provider.models.contains(where: { $0.id == modelID && $0.available }),
                      var next = draft else { return }
                next.customAccess.modelID = modelID
                draft = next
                retainedCreateAttempt = nil
            }
        )
    }

    private func optionBinding(
        id optionID: String,
        available isAvailable: Bool,
        keyPath: WritableKeyPath<AidenBotCustomAccessDraft, Set<String>>
    ) -> Binding<Bool> {
        Binding(
            get: { draft?.customAccess[keyPath: keyPath].contains(optionID) == true },
            set: { enabled in
                guard var next = draft, !enabled || isAvailable else { return }
                if enabled {
                    next.customAccess[keyPath: keyPath].insert(optionID)
                } else {
                    next.customAccess[keyPath: keyPath].remove(optionID)
                }
                draft = next
                retainedCreateAttempt = nil
            }
        )
    }

    private func shellBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<Bool> {
        Binding(
            get: { draft?.customAccess.shellEnabled ?? false },
            set: { enabled in
                guard var next = draft, !enabled || catalog.shellAvailable else { return }
                next.customAccess.shellEnabled = enabled
                draft = next
                retainedCreateAttempt = nil
            }
        )
    }

    private func isSelected(
        _ optionID: String,
        keyPath: KeyPath<AidenBotCustomAccessDraft, Set<String>>
    ) -> Bool {
        draft?.customAccess[keyPath: keyPath].contains(optionID) == true
    }

    private func optionLabel(_ title: String, description: String?, available: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(optionTitle(title, available: available))
            if let description, !description.isEmpty {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }
        }
    }

    private func optionTitle(_ title: String, available: Bool) -> String {
        available ? title : "\(title) — Unavailable"
    }

    private var title: String {
        if case .edit = mode { return "Edit Bot" }
        return "New Bot"
    }

    private var readOnlyMessage: String {
        if baselineBot?.health == .archived { return "Archived Bots are read-only until restored." }
        if coordinator.connectionState != .connected { return "Reconnect to your Mac to save this Bot." }
        return "This phone can view Bots but is not approved to change them."
    }

    @MainActor
    private func reset(for expectedSession: AidenBotCustomAccessSessionIdentity) {
        guard sessionIdentity == expectedSession else { return }
        catalog = nil
        baselineBot = nil
        draft = nil
        cleanCreateDraft = nil
        capturedContext = nil
        isLoading = true
        loadError = nil
        saveError = nil
        activeCreateAttempt = nil
        retainedCreateAttempt = nil
        activeEditAttempt = nil
        avatarModel?.clearForDismissal()
        avatarModel = nil
        isConfirmingDiscard = false
    }

    @MainActor
    private func load(for expectedSession: AidenBotCustomAccessSessionIdentity) async {
        guard sessionIdentity == expectedSession else { return }
        isLoading = true
        loadError = nil
        var requestContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession,
                  context.instanceId == expectedSession.instanceID,
                  context.deviceId == expectedSession.deviceID else { return }
            let client = try coordinator.remoteClient(for: context)
            let loadedCatalog: AidenBotCapabilityCatalog
            let loadedBot: AidenBotDetail?
            switch mode {
            case .create:
                loadedCatalog = try await client.botCapabilityCatalog()
                loadedBot = nil
            case let .edit(botID):
                async let catalogRequest = client.botCapabilityCatalog()
                async let detailRequest = client.bot(id: botID)
                (loadedCatalog, loadedBot) = try await (catalogRequest, detailRequest)
            }
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession,
                  !Task.isCancelled else { return }
            let loadedDraft = try aidenBotEditorResolvedDraft(
                mode: mode,
                catalog: loadedCatalog,
                bot: loadedBot
            )
            capturedContext = context
            catalog = loadedCatalog
            baselineBot = loadedBot
            draft = loadedDraft
            cleanCreateDraft = isCreating ? loadedDraft : nil
            if let loadedBot {
                avatarModel = AidenBotGeneratedAvatarModel(
                    coordinator: coordinator,
                    botID: loadedBot.id
                ) { updated in
                    baselineBot = updated
                    onSaved(updated)
                }
            }
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if let context = requestContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard sessionIdentity == expectedSession else { return }
            capturedContext = nil
            loadError = error.localizedDescription
            isLoading = false
        }
    }

    @MainActor
    private func save() async {
        guard canSave, let context = capturedContext, coordinator.isCurrent(context),
              let catalog, let draft else { return }
        switch mode {
        case .create:
            await create(draft: draft, catalog: catalog, context: context)
        case .edit:
            await edit(draft: draft, catalog: catalog, context: context)
        }
    }

    @MainActor
    private func requestDismiss() {
        if isDirty {
            isConfirmingDiscard = true
        } else {
            dismiss()
        }
    }

    @MainActor
    private func create(
        draft: AidenBotEditorDraft,
        catalog: AidenBotCapabilityCatalog,
        context: AidenRemoteRequestContext
    ) async {
        var sentAttempt: AidenBotEditorCreateAttempt?
        do {
            let createRequest = try draft.createRequest(catalog: catalog)
            let attempt: AidenBotEditorCreateAttempt
            if let retainedCreateAttempt,
               retainedCreateAttempt.context == context,
               retainedCreateAttempt.request == createRequest {
                attempt = retainedCreateAttempt
            } else {
                attempt = AidenBotEditorCreateAttempt(
                    context: context,
                    request: createRequest,
                    idempotencyKey: UUID()
                )
            }
            retainedCreateAttempt = attempt
            activeCreateAttempt = attempt
            sentAttempt = attempt
            saveError = nil
            defer { if activeCreateAttempt == attempt { activeCreateAttempt = nil } }
            guard coordinator.isCurrent(attempt.context), activeCreateAttempt == attempt,
                  capturedContext == attempt.context else { return }
            let created = try await coordinator.remoteClient(for: attempt.context).createBot(
                attempt.request,
                idempotencyKey: attempt.idempotencyKey
            )
            guard coordinator.isCurrent(attempt.context), activeCreateAttempt == attempt,
                  capturedContext == attempt.context else { return }
            retainedCreateAttempt = nil
            onSaved(created)
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                if retainedCreateAttempt == sentAttempt { retainedCreateAttempt = nil }
                return
            }
            guard coordinator.isCurrent(context), capturedContext == context else { return }
            if let sentAttempt, retainedCreateAttempt == sentAttempt,
               !aidenBotEditorCreateFailureIsAmbiguous(error) {
                retainedCreateAttempt = nil
            }
            saveError = error.localizedDescription
        }
    }

    @MainActor
    private func edit(
        draft: AidenBotEditorDraft,
        catalog: AidenBotCapabilityCatalog,
        context: AidenRemoteRequestContext
    ) async {
        guard let baselineBot else { return }
        let attempt = AidenBotEditorEditAttempt(
            context: context,
            botID: baselineBot.id,
            identityRevision: baselineBot.revision,
            accessRevision: baselineBot.access.revision,
            catalogRevision: catalog.revision,
            token: UUID()
        )
        activeEditAttempt = attempt
        saveError = nil
        defer { if activeEditAttempt == attempt { activeEditAttempt = nil } }
        do {
            let client = try coordinator.remoteClient(for: attempt.context)
            var latest = baselineBot
            if let patch = try draft.identityPatch(comparedTo: baselineBot) {
                guard isCurrent(attempt) else { return }
                latest = try await client.updateBotIdentity(
                    id: attempt.botID,
                    revision: attempt.identityRevision,
                    patch: patch
                )
                guard isCurrent(attempt) else { return }
                self.baselineBot = latest
            }
            if try draft.changesAccess(comparedTo: baselineBot, catalog: catalog) {
                guard isCurrent(attempt) else { return }
                _ = try await client.updateBotAccess(
                    botId: attempt.botID,
                    revision: attempt.accessRevision,
                    update: try draft.accessUpdate(catalog: catalog)
                )
                guard isCurrent(attempt) else { return }
                // Access mutation returns only the access projection. Re-fetch the
                // canonical detail so profile callers never receive the stale
                // pre-access revision from this editor callback.
                latest = try await client.bot(id: attempt.botID)
                guard isCurrent(attempt) else { return }
                self.baselineBot = latest
            }
            guard isCurrent(attempt) else { return }
            onSaved(latest)
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: attempt.context) { return }
            guard isCurrent(attempt) else { return }
            // A PATCH response can be lost after the Mac commits. Reconcile the
            // authoritative detail/catalog before allowing any retry so stale
            // revisions cannot repeat or conflict with an already-applied edit.
            do {
                let client = try coordinator.remoteClient(for: attempt.context)
                async let detailRequest = client.bot(id: attempt.botID)
                async let catalogRequest = client.botCapabilityCatalog()
                let (authoritative, refreshedCatalog) = try await (detailRequest, catalogRequest)
                guard isCurrent(attempt) else { return }
                self.baselineBot = authoritative
                self.catalog = refreshedCatalog
                if (try? draft.isSatisfied(by: authoritative, catalog: refreshedCatalog)) == true {
                    onSaved(authoritative)
                    dismiss()
                } else {
                    saveError = "Aiden checked the Bot on your Mac. Review any remaining changes, then save again."
                }
            } catch is CancellationError {
                return
            } catch let reconciliationError {
                if await coordinator.handleCredentialRevocation(
                    reconciliationError,
                    context: attempt.context
                ) { return }
                guard isCurrent(attempt) else { return }
                capturedContext = nil
                saveError = "Aiden couldn’t verify which changes reached your Mac. Close and reopen this Bot before editing again."
            }
        }
    }

    @MainActor
    private func isCurrent(_ attempt: AidenBotEditorEditAttempt) -> Bool {
        coordinator.isCurrent(attempt.context)
            && capturedContext == attempt.context
            && activeEditAttempt == attempt
            && baselineBot?.id == attempt.botID
    }
}
