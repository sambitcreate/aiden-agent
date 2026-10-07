import SwiftUI

private struct AidenBotAdvancedSaveAttempt: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
    let identityRevision: String
    let accessRevision: String
    let catalogRevision: String
    let token: UUID
}

/// One page for the settings most people never need: the AI model, the image
/// model, what the Bot can use, and its opening greeting. Name, subtitle,
/// character, and instructions live on the Profile.
struct AidenBotAdvancedView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    var onSaved: (AidenBotDetail) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var baselineBot: AidenBotDetail?
    @State private var draft: AidenBotEditorDraft?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var activeAttempt: AidenBotAdvancedSaveAttempt?
    @State private var isConfirmingDiscard = false

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var isSaving: Bool { activeAttempt != nil }

    private var isDirty: Bool {
        aidenBotEditorIsDirty(
            draft: draft,
            cleanCreateDraft: nil,
            baselineBot: baselineBot,
            catalog: catalog,
            isCreating: false
        )
    }

    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    private var canSave: Bool {
        guard canWrite, !isLoading, !isSaving, isDirty,
              let catalog, let draft, draft.isSaveable(catalog: catalog) else { return false }
        return true
    }

    var body: some View {
        content
            .navigationTitle("Advanced")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(isDirty || isSaving)
            .toolbar {
                if isDirty || isSaving {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { isConfirmingDiscard = true }
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
            .task(id: sessionIdentity) {
                let expectedSession = sessionIdentity
                reset(for: expectedSession)
                await load(for: expectedSession)
            }
            .alert(
                "Couldn’t Save",
                isPresented: Binding(
                    get: { saveError != nil },
                    set: { if !$0 { saveError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { saveError = nil }
            } message: {
                Text(saveError ?? "Your changes weren’t saved.")
            }
            .confirmationDialog(
                "Discard changes?",
                isPresented: $isConfirmingDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) { }
            }
    }

    @ViewBuilder
    private var content: some View {
        if aidenBotUsesColdLoadingPlaceholder(
            isLoading: isLoading,
            hasUsableContent: catalog != nil && draft != nil
        ) {
            VStack(alignment: .leading, spacing: 16) {
                AidenBotSkeletonBlock(width: nil, height: 112, radius: 18, reduceMotion: reduceMotion)
                AidenBotSkeletonBlock(width: nil, height: 126, radius: 18, reduceMotion: reduceMotion)
            }
            .padding(.horizontal, 20)
            .padding(.top, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading")
        } else if let catalog, draft != nil {
            form(catalog)
        } else if let loadError {
            ContentUnavailableView {
                Label("Couldn’t Load", systemImage: "exclamationmark.bubble")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") {
                    let expectedSession = sessionIdentity
                    Task { await load(for: expectedSession) }
                }
            }
        }
    }

    private func form(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Form {
            if !canWrite {
                Section {
                    Label(readOnlyMessage, systemImage: "lock.fill")
                        .foregroundStyle(palette.secondary)
                }
            }
            modelSection(catalog)
            accessSection(catalog)
            if draft?.usesFullAccess == false {
                optionSection(title: "Connections", options: catalog.connections, keyPath: \.connectionIDs)
                optionSection(title: "Skills", options: catalog.skills, keyPath: \.skillIDs)
                filesAndCommandsSection(catalog)
                optionSection(title: "Other", options: catalog.otherCapabilities, keyPath: \.otherCapabilityIDs)
            }
            Section {
                TextField("Say hello when a chat starts (optional)", text: textBinding(\.openingGreeting), axis: .vertical)
                    .lineLimit(2...6)
            } header: {
                Text("Opening greeting")
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .disabled(isSaving || !canWrite)
        .scrollDismissesKeyboard(.interactively)
    }

    private func modelSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            Picker("AI", selection: providerBinding(catalog)) {
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
            if selectedPrimaryModel(in: catalog)?.supportsImages == false {
                if visionProviders(in: catalog).isEmpty {
                    Text("To look at photos, add an AI that can see images on your Mac.")
                        .foregroundStyle(palette.secondary)
                } else {
                    Picker("Photos", selection: visionProviderBinding(catalog)) {
                        ForEach(visionProviders(in: catalog)) { provider in
                            Text(provider.label).tag(provider.id)
                        }
                    }
                    Picker("Photo model", selection: visionModelBinding(catalog)) {
                        ForEach(selectedVisionProvider(in: catalog)?.models.filter {
                            $0.available && $0.supportsImages
                        } ?? []) { model in
                            Text(model.label).tag(model.id)
                        }
                    }
                }
            }
            Button("Use recommended") { useRecommendedModels(catalog) }
                .disabled(isRecommended(catalog))
        } header: {
            Text("AI model")
        }
    }

    private func accessSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            Picker("What it can use", selection: fullAccessBinding(catalog)) {
                Text("Everything").tag(true)
                Text("Only what I pick").tag(false)
            }
            .pickerStyle(.segmented)
        } header: {
            Text("What it can use")
        } footer: {
            if draft?.usesFullAccess == true {
                Text("It can use everything your Mac allows. Your Mac still asks before risky steps.")
            } else {
                Text("Turn on only what this Bot needs.")
            }
        }
    }

    private func filesAndCommandsSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            ForEach(aidenBotVisibleCapabilityOptionsForFiles(catalog)) { option in
                Toggle(isOn: optionBinding(id: option.id, available: option.available, keyPath: \.fileScopeIDs)) {
                    Text(optionTitle(option.label, available: option.available))
                }
            }
            Toggle("Run commands", isOn: shellBinding(catalog))
                .disabled(!catalog.shellAvailable && !(draft?.customAccess.shellEnabled ?? false))
        } header: {
            Text("Files and commands")
        }
    }

    @ViewBuilder
    private func optionSection(
        title: String,
        options: [AidenBotCapabilityOption],
        keyPath: WritableKeyPath<AidenBotCustomAccessDraft, Set<String>>
    ) -> some View {
        let selected = draft?.customAccess[keyPath: keyPath] ?? []
        let visible = aidenBotVisibleCapabilityOptions(options, selectedIDs: selected)
        if !visible.isEmpty {
            Section {
                ForEach(visible) { option in
                    Toggle(isOn: optionBinding(id: option.id, available: option.available, keyPath: keyPath)) {
                        Text(aidenBotCapabilityOptionTitle(option, isSelected: selected.contains(option.id)))
                    }
                }
            } header: {
                Text(title)
            }
        }
    }

    private func aidenBotVisibleCapabilityOptionsForFiles(
        _ catalog: AidenBotCapabilityCatalog
    ) -> [AidenBotFileScopeOption] {
        let selected = draft?.customAccess.fileScopeIDs ?? []
        return catalog.fileScopes.filter { $0.available || selected.contains($0.id) }
    }

    // MARK: Bindings

    private func textBinding(_ keyPath: WritableKeyPath<AidenBotEditorDraft, String>) -> Binding<String> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? "" },
            set: { value in
                guard var next = draft else { return }
                next[keyPath: keyPath] = value
                draft = next
            }
        )
    }

    private func fullAccessBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<Bool> {
        Binding(
            get: { draft?.usesFullAccess ?? false },
            set: { enabled in
                guard var next = draft else { return }
                next.usesFullAccess = enabled
                draft = next
            }
        )
    }

    private func selectedProvider(in catalog: AidenBotCapabilityCatalog) -> AidenBotProviderOption? {
        catalog.providers.first { $0.id == draft?.customAccess.providerID }
    }

    private func selectedPrimaryModel(in catalog: AidenBotCapabilityCatalog) -> AidenBotModelOption? {
        selectedProvider(in: catalog)?.models.first { $0.id == draft?.customAccess.modelID }
    }

    private func visionProviders(in catalog: AidenBotCapabilityCatalog) -> [AidenBotProviderOption] {
        catalog.providers.filter { provider in
            provider.available && provider.models.contains(where: { $0.available && $0.supportsImages })
        }
    }

    private func selectedVisionProvider(in catalog: AidenBotCapabilityCatalog) -> AidenBotProviderOption? {
        catalog.providers.first { $0.id == draft?.visionProviderID }
    }

    private func recommendedDraft(_ catalog: AidenBotCapabilityCatalog) -> AidenBotEditorDraft? {
        guard var next = draft,
              let recommended = AidenBotCustomAccessDraft(catalog: catalog) else { return nil }
        next.customAccess.providerID = recommended.providerID
        next.customAccess.modelID = recommended.modelID
        next.visionProviderID = nil
        next.visionModelID = nil
        next.reconcileVisionSelection(catalog: catalog)
        return next
    }

    private func isRecommended(_ catalog: AidenBotCapabilityCatalog) -> Bool {
        guard let recommended = recommendedDraft(catalog), let draft else { return true }
        return recommended.customAccess.providerID == draft.customAccess.providerID
            && recommended.customAccess.modelID == draft.customAccess.modelID
            && recommended.visionProviderID == draft.visionProviderID
            && recommended.visionModelID == draft.visionModelID
    }

    private func useRecommendedModels(_ catalog: AidenBotCapabilityCatalog) {
        if let next = recommendedDraft(catalog) { draft = next }
    }

    private func visionProviderBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.visionProviderID ?? "" },
            set: { providerID in
                guard let provider = visionProviders(in: catalog).first(where: { $0.id == providerID }),
                      let model = provider.models.first(where: { $0.available && $0.supportsImages }),
                      var next = draft else { return }
                next.visionProviderID = provider.id
                next.visionModelID = model.id
                draft = next
            }
        )
    }

    private func visionModelBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.visionModelID ?? "" },
            set: { modelID in
                guard let provider = selectedVisionProvider(in: catalog),
                      provider.models.contains(where: {
                          $0.id == modelID && $0.available && $0.supportsImages
                      }), var next = draft else { return }
                next.visionModelID = modelID
                draft = next
            }
        )
    }

    private func providerBinding(_ catalog: AidenBotCapabilityCatalog) -> Binding<String> {
        Binding(
            get: { draft?.customAccess.providerID ?? "" },
            set: { providerID in
                guard var next = draft else { return }
                next.customAccess.selectProvider(providerID, catalog: catalog)
                next.reconcileVisionSelection(catalog: catalog)
                draft = next
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
                next.reconcileVisionSelection(catalog: catalog)
                draft = next
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
            }
        )
    }

    private func optionTitle(_ title: String, available: Bool) -> String {
        available ? title : "\(title) — Unavailable"
    }

    private var readOnlyMessage: String {
        if coordinator.connectionState != .connected { return "Connect to your Mac to change this." }
        return "This phone can look but not change Bots."
    }

    // MARK: Loading and saving

    @MainActor
    private func reset(for expectedSession: AidenBotCustomAccessSessionIdentity) {
        guard sessionIdentity == expectedSession else { return }
        catalog = nil
        baselineBot = nil
        draft = nil
        capturedContext = nil
        isLoading = true
        loadError = nil
        saveError = nil
        activeAttempt = nil
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
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession else { return }
            if let cached = await AidenBotCache.shared.load(
                instanceId: context.instanceId,
                deviceId: context.deviceId
            ), let cachedCatalog = cached.catalog(forBotID: botID),
               let cachedBot = cached.details.first(where: { $0.id == botID }),
               let cachedDraft = AidenBotEditorDraft(detail: cachedBot, catalog: cachedCatalog) {
                guard coordinator.isCurrent(context), sessionIdentity == expectedSession else { return }
                catalog = cachedCatalog
                baselineBot = cachedBot
                draft = cachedDraft
                isLoading = false
            }
            let client = try coordinator.remoteClient(for: context)
            async let catalogRequest = client.botCapabilityCatalog(botId: botID)
            async let detailRequest = client.bot(id: botID)
            let (loadedCatalog, loadedBot) = try await (catalogRequest, detailRequest)
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession,
                  !Task.isCancelled else { return }
            let loadedDraft = try aidenBotEditorResolvedDraft(
                mode: .edit(botID: botID),
                catalog: loadedCatalog,
                bot: loadedBot
            )
            capturedContext = context
            catalog = loadedCatalog
            baselineBot = loadedBot
            draft = loadedDraft
            _ = await coordinator.withRetainedInstallationData(for: context) {
                _ = try? await AidenBotCache.shared.mergeAndStore(
                    AidenBotCacheSegments(catalogsByBotID: [botID: loadedCatalog]),
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
                _ = try? await AidenBotCache.shared.upsertDetailAndStore(
                    loadedBot,
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
            }
            guard coordinator.isCurrent(context), sessionIdentity == expectedSession,
                  !Task.isCancelled else { return }
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if let context = requestContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard sessionIdentity == expectedSession else { return }
            capturedContext = nil
            loadError = aidenBotFriendlyLoadError(error)
            isLoading = false
        }
    }

    @MainActor
    private func save() async {
        guard canSave, let context = capturedContext, coordinator.isCurrent(context),
              let catalog, let draft, let baselineBot else { return }
        let attempt = AidenBotAdvancedSaveAttempt(
            context: context,
            botID: baselineBot.id,
            identityRevision: baselineBot.revision,
            accessRevision: baselineBot.access.revision,
            catalogRevision: catalog.revision,
            token: UUID()
        )
        activeAttempt = attempt
        saveError = nil
        defer { if activeAttempt == attempt { activeAttempt = nil } }
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
            // A response can be lost after the Mac saves. Re-read the Bot
            // before allowing a retry so stale revisions never repeat an edit.
            do {
                let client = try coordinator.remoteClient(for: attempt.context)
                async let detailRequest = client.bot(id: attempt.botID)
                async let catalogRequest = client.botCapabilityCatalog(botId: attempt.botID)
                let (authoritative, refreshedCatalog) = try await (detailRequest, catalogRequest)
                guard isCurrent(attempt) else { return }
                let rebasedDraft = try aidenBotEditorRebasedDraft(
                    draft,
                    baseline: baselineBot,
                    baselineCatalog: catalog,
                    authoritative: authoritative,
                    authoritativeCatalog: refreshedCatalog
                )
                self.baselineBot = authoritative
                self.catalog = refreshedCatalog
                self.draft = rebasedDraft
                if (try? rebasedDraft.isSatisfied(by: authoritative, catalog: refreshedCatalog)) == true {
                    onSaved(authoritative)
                    dismiss()
                } else {
                    saveError = "Something changed on your Mac. Check your changes and save again."
                }
            } catch is CancellationError {
                return
            } catch let reconciliationError {
                if await coordinator.handleCredentialRevocation(reconciliationError, context: attempt.context) { return }
                guard isCurrent(attempt) else { return }
                capturedContext = nil
                saveError = "Aiden couldn’t check what was saved. Go back and open Advanced again."
            }
        }
    }

    @MainActor
    private func isCurrent(_ attempt: AidenBotAdvancedSaveAttempt) -> Bool {
        coordinator.isCurrent(attempt.context)
            && capturedContext == attempt.context
            && activeAttempt == attempt
            && baselineBot?.id == attempt.botID
    }
}

/// Plain-language load errors for Bot surfaces.
func aidenBotFriendlyLoadError(_ error: Error) -> String {
    if case AidenBotContractError.invalidCombination("no available provider and model") = error {
        return "Needs an AI model. Set one up on your Mac, then try again."
    }
    return error.localizedDescription
}
