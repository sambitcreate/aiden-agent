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

private struct AidenBotCustomAccessDetailRequest: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
}

private struct AidenBotCustomAccessSaveRequest: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
    let accessRevision: String
    let catalogRevision: String
}

private enum AidenBotCustomAccessDiscardAction: Equatable {
    case dismiss
    case selectBot(String?)
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

func aidenBotCustomAccessIsDirty(
    draft: AidenBotCustomAccessDraft?,
    cleanDraft: AidenBotCustomAccessDraft?
) -> Bool {
    draft != nil && draft != cleanDraft
}

struct AidenBotCustomAccessFlowView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    var preferredBotID: String? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette

    @State private var bots: [AidenBotSummary] = []
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var selectedBotID: String?
    @State private var selectedBot: AidenBotDetail?
    @State private var draft: AidenBotCustomAccessDraft?
    @State private var cleanDraft: AidenBotCustomAccessDraft?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var isLoadingBot = false
    @State private var savingRequest: AidenBotCustomAccessSaveRequest?
    @State private var editorMode: AidenBotEditorMode?
    @State private var loadError: String?
    @State private var botError: String?
    @State private var saveError: String?
    @State private var discardAction: AidenBotCustomAccessDiscardAction?

    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
            && selectedBot?.health != .archived
    }

    private var isSaving: Bool { savingRequest != nil }

    private var isDirty: Bool {
        aidenBotCustomAccessIsDirty(draft: draft, cleanDraft: cleanDraft)
    }

    private var canSave: Bool {
        guard canWrite, !isSaving,
              let catalog, let draft,
              draft.isSaveable(in: catalog) else { return false }
        return true
    }

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var detailRequest: AidenBotCustomAccessDetailRequest? {
        guard let context = capturedContext, let botID = selectedBotID,
              coordinator.isCurrent(context) else { return nil }
        return AidenBotCustomAccessDetailRequest(context: context, botID: botID)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Custom Access")
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
        .sheet(item: $editorMode) { mode in
            AidenBotEditorView(coordinator: coordinator, mode: mode) { created in
                let expectedSession = sessionIdentity
                selectedBotID = created.id
                Task { await load(for: expectedSession) }
            }
        }
        .task(id: sessionIdentity) {
            let expectedSession = sessionIdentity
            reset(for: expectedSession)
            await load(for: expectedSession)
        }
        .task(id: detailRequest) {
            guard let request = detailRequest, !isLoading else { return }
            await loadSelectedBot(request)
        }
        .alert(
            "Couldn’t Save Access",
            isPresented: Binding(
                get: { saveError != nil },
                set: { if !$0 { saveError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { saveError = nil }
        } message: {
            Text(saveError ?? "The change could not be saved.")
        }
        .confirmationDialog(
            "Discard access changes?",
            isPresented: Binding(
                get: { discardAction != nil },
                set: { if !$0 { discardAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) { performDiscardAction() }
            Button("Keep Editing", role: .cancel) { discardAction = nil }
        } message: {
            Text("Your unsaved Custom Access changes will be lost.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView("Loading access from your Mac…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            ContentUnavailableView {
                Label("Couldn’t Load Bot Access", systemImage: "exclamationmark.shield")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") {
                    let expectedSession = sessionIdentity
                    Task { await load(for: expectedSession) }
                }
            }
        } else if bots.isEmpty {
            ContentUnavailableView {
                Label("No Bots to Customize", systemImage: "person.2")
            } description: {
                Text("Create a Custom Bot here, then choose exactly what it can use.")
            } actions: {
                Button("Create Custom Bot") {
                    editorMode = .create(defaultAccess: .custom)
                }
                .buttonStyle(.borderedProminent)
                .disabled(capturedContext.map(coordinator.isCurrent) != true || !canCreateBot)
                .accessibilityHint("Opens the new Bot editor. Nothing is created until you save.")
            }
        } else {
            accessForm
        }
    }

    private var accessForm: some View {
        Form {
            Section {
                Picker("Bot", selection: selectedBotBinding) {
                    ForEach(bots) { bot in
                        Text(bot.name).tag(Optional(bot.id))
                    }
                }
                .accessibilityHint("Choose which existing bot to customize.")
            } header: {
                Text("Bot")
            } footer: {
                Text("Custom Access can only reduce what Aiden and your Mac already allow.")
            }

            if isLoadingBot {
                Section {
                    HStack {
                        Spacer()
                        ProgressView("Loading bot…")
                        Spacer()
                    }
                }
            } else if let botError {
                Section {
                    Text(botError)
                        .foregroundStyle(.red)
                        .accessibilityLabel("Bot access error: \(botError)")
                    Button("Try Again") {
                        guard let request = detailRequest else { return }
                        Task { await loadSelectedBot(request) }
                    }
                }
            } else if let catalog, draft != nil {
                aiSection(catalog)
                    .disabled(!canWrite)
                optionSection(
                    title: "Connections",
                    description: "Choose the services and accounts this bot can use.",
                    options: catalog.connections,
                    keyPath: \.connectionIDs
                )
                .disabled(!canWrite)
                optionSection(
                    title: "Skills",
                    description: "Choose the Aiden skills this bot can use.",
                    options: catalog.skills,
                    keyPath: \.skillIDs
                )
                .disabled(!canWrite)
                filesAndShellSection(catalog)
                    .disabled(!canWrite)
                optionSection(
                    title: "Other Capabilities",
                    description: "Optional Aiden capabilities available on this Mac.",
                    options: catalog.otherCapabilities,
                    keyPath: \.otherCapabilityIDs
                )
                .disabled(!canWrite)

                if !canWrite {
                    Section {
                        Label(readOnlyMessage, systemImage: "lock.fill")
                            .foregroundStyle(palette.secondary)
                            .accessibilityLabel("Read only. \(readOnlyMessage)")
                    }
                } else if let draft, !draft.isSaveable(in: catalog) {
                    Section {
                        Label(
                            "Some selected access is unavailable. Choose available options before saving.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .foregroundStyle(.orange)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .disabled(isSaving)
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
            .accessibilityHint("Select an AI provider already configured on your Mac.")

            Picker("Model", selection: modelBinding(catalog)) {
                ForEach(selectedProvider(in: catalog)?.models ?? []) { model in
                    Text(optionTitle(model.label, available: model.available))
                        .tag(model.id)
                        .disabled(!model.available)
                }
            }
            .accessibilityHint("Select the model this bot will use.")
        } header: {
            Text("AI")
        } footer: {
            Text("Credentials stay on your Mac.")
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
                .disabled(!catalog.shellAvailable && !(draft?.shellEnabled ?? false))
                .accessibilityHint("Allows the bot to use Aiden’s existing shell tool on your Mac.")
        } header: {
            Text("Files and Commands")
        } footer: {
            Text("Choose which files this Bot may work with when your requests need them.")
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

    private func optionLabel(
        _ title: String,
        description: String?,
        available: Bool
    ) -> some View {
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

    private var selectedBotBinding: Binding<String?> {
        Binding(
            get: { selectedBotID },
            set: { nextBotID in
                guard nextBotID != selectedBotID else { return }
                if isDirty {
                    discardAction = .selectBot(nextBotID)
                } else {
                    selectedBotID = nextBotID
                }
            }
        )
    }

    private func selectedProvider(in catalog: AidenBotCapabilityCatalog) -> AidenBotProviderOption? {
        catalog.providers.first { $0.id == draft?.providerID }
    }

    private func providerBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.providerID ?? "" },
            set: { providerID in
                guard var next = draft else { return }
                next.selectProvider(providerID, catalog: catalog)
                draft = next
            }
        )
    }

    private func modelBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.modelID ?? "" },
            set: { modelID in
                guard let provider = selectedProvider(in: catalog),
                      provider.available,
                      provider.models.contains(where: { $0.id == modelID && $0.available }),
                      var next = draft else { return }
                next.modelID = modelID
                draft = next
            }
        )
    }

    private func optionBinding(
        id optionID: String,
        available isAvailable: Bool,
        keyPath: WritableKeyPath<AidenBotCustomAccessDraft, Set<String>>
    ) -> Binding<Bool> {
        return Binding(
            get: { draft?[keyPath: keyPath].contains(optionID) == true },
            set: { enabled in
                guard var next = draft, !enabled || isAvailable else { return }
                if enabled {
                    next[keyPath: keyPath].insert(optionID)
                } else {
                    next[keyPath: keyPath].remove(optionID)
                }
                draft = next
            }
        )
    }

    private func isSelected(
        _ optionID: String,
        keyPath: KeyPath<AidenBotCustomAccessDraft, Set<String>>
    ) -> Bool {
        draft?[keyPath: keyPath].contains(optionID) == true
    }

    private func shellBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<Bool> {
        Binding(
            get: { draft?.shellEnabled ?? false },
            set: { enabled in
                guard var next = draft, !enabled || catalog.shellAvailable else { return }
                next.shellEnabled = enabled
                draft = next
            }
        )
    }

    private var readOnlyMessage: String {
        if selectedBot?.health == .archived {
            return "Archived bots are read-only until restored."
        }
        if coordinator.connectionState != .connected {
            return "Offline — reconnect to change Bot access."
        }
        return "This phone can view Bots but is not approved to change them."
    }

    @MainActor
    private func reset(for expectedSession: AidenBotCustomAccessSessionIdentity) {
        guard sessionIdentity == expectedSession else { return }
        capturedContext = nil
        bots = []
        catalog = nil
        selectedBotID = nil
        selectedBot = nil
        draft = nil
        cleanDraft = nil
        isLoading = true
        isLoadingBot = false
        savingRequest = nil
        loadError = nil
        botError = nil
        saveError = nil
        editorMode = nil
        discardAction = nil
    }

    private var canCreateBot: Bool {
        coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    @MainActor
    private func load(for expectedSession: AidenBotCustomAccessSessionIdentity) async {
        guard sessionIdentity == expectedSession else { return }
        isLoading = true
        loadError = nil
        selectedBot = nil
        draft = nil
        cleanDraft = nil
        var requestContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession,
                  context.instanceId == expectedSession.instanceID,
                  context.deviceId == expectedSession.deviceID else { return }
            let client = try coordinator.remoteClient(for: context)
            async let botsRequest = client.bots()
            async let catalogRequest = client.botCapabilityCatalog()
            let (list, loadedCatalog) = try await (botsRequest, catalogRequest)
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession else { return }
            capturedContext = context
            bots = list.bots.filter { $0.health != .archived }
            catalog = loadedCatalog
            if !bots.contains(where: { $0.id == selectedBotID }) {
                selectedBotID = bots.first(where: { $0.id == preferredBotID })?.id ?? bots.first?.id
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
    private func loadSelectedBot(_ request: AidenBotCustomAccessDetailRequest) async {
        guard detailRequest == request, coordinator.isCurrent(request.context),
              let catalog else { return }
        isLoadingBot = true
        botError = nil
        selectedBot = nil
        draft = nil
        cleanDraft = nil
        do {
            let detail = try await coordinator.remoteClient(for: request.context).bot(id: request.botID)
            guard coordinator.isCurrent(request.context), detailRequest == request,
                  capturedContext == request.context,
                  selectedBotID == request.botID else { return }
            guard let loadedDraft = AidenBotCustomAccessDraft(access: detail.access, catalog: catalog) else {
                botError = "No available AI provider and model can be selected on your Mac."
                isLoadingBot = false
                return
            }
            selectedBot = detail
            draft = loadedDraft
            cleanDraft = loadedDraft
            isLoadingBot = false
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: request.context) { return }
            guard coordinator.isCurrent(request.context), detailRequest == request,
                  capturedContext == request.context,
                  selectedBotID == request.botID else { return }
            botError = error.localizedDescription
            isLoadingBot = false
        }
    }

    @MainActor
    private func save() async {
        guard canSave, let context = capturedContext, coordinator.isCurrent(context),
              let bot = selectedBot, selectedBotID == bot.id,
              let catalog, let draft else { return }
        let request = AidenBotCustomAccessSaveRequest(
            context: context,
            botID: bot.id,
            accessRevision: bot.access.revision,
            catalogRevision: catalog.revision
        )
        savingRequest = request
        saveError = nil
        defer {
            if savingRequest == request {
                savingRequest = nil
            }
        }
        do {
            let selection = try draft.selection()
            guard catalog.containsAvailable(selection) else {
                throw AidenBotContractError.invalidCombination("unavailable custom access")
            }
            guard coordinator.isCurrent(request.context), savingRequest == request,
                  capturedContext == request.context,
                  selectedBotID == request.botID else { return }
            _ = try await coordinator.remoteClient(for: request.context).updateBotAccess(
                botId: request.botID,
                revision: request.accessRevision,
                update: .custom(catalogRevision: request.catalogRevision, selection: selection)
            )
            guard coordinator.isCurrent(request.context), savingRequest == request,
                  capturedContext == request.context,
                  selectedBotID == request.botID else { return }
            dismiss()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: request.context) { return }
            guard coordinator.isCurrent(request.context), savingRequest == request,
                  capturedContext == request.context,
                  selectedBotID == request.botID else { return }
            do {
                let client = try coordinator.remoteClient(for: request.context)
                async let detailRequest = client.bot(id: request.botID)
                async let catalogRequest = client.botCapabilityCatalog()
                let (authoritative, refreshedCatalog) = try await (detailRequest, catalogRequest)
                guard coordinator.isCurrent(request.context), savingRequest == request,
                      capturedContext == request.context,
                      selectedBotID == request.botID else { return }
                let desired = try draft.selection()
                if authoritative.access.custom == desired {
                    dismiss()
                    return
                }
                guard let refreshedBaseline = AidenBotCustomAccessDraft(
                    access: authoritative.access,
                    catalog: refreshedCatalog
                ) else {
                    saveError = "Access may have changed on your Mac. Close and reopen this screen to refresh."
                    return
                }
                selectedBot = authoritative
                self.catalog = refreshedCatalog
                cleanDraft = refreshedBaseline
                saveError = "Aiden refreshed the Bot’s latest access. Review and save any remaining changes."
            } catch is CancellationError {
                return
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: request.context) { return }
                guard coordinator.isCurrent(request.context), savingRequest == request,
                      capturedContext == request.context,
                      selectedBotID == request.botID else { return }
                capturedContext = nil
                saveError = "Aiden could not confirm the Bot’s latest access. Close and reopen this screen before retrying."
            }
        }
    }

    @MainActor
    private func requestDismiss() {
        if isDirty {
            discardAction = .dismiss
        } else {
            dismiss()
        }
    }

    @MainActor
    private func performDiscardAction() {
        let action = discardAction
        discardAction = nil
        switch action {
        case .dismiss:
            dismiss()
        case let .selectBot(botID):
            selectedBotID = botID
        case nil:
            break
        }
    }
}
