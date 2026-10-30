import SwiftUI

/// Copy for an Advanced Save that didn't stick, shown by the screen behind it.
enum AidenBotAdvancedCopy {
    static let unreachable = "Aiden couldn’t reach your Mac, so Advanced wasn’t saved. Open it to try again."
    static let changedOnMac = "Something changed on your Mac, so Advanced wasn’t saved. Open it to check and save again."
    static let couldNotCheck = "Aiden couldn’t check what Advanced saved. Open it again to see."
}

/// The requests one Advanced Save makes; the remote client provides them, tests a fake.
struct AidenBotAdvancedSaveOperations {
    var waitForConnection: @MainActor (Duration) async -> Bool
    var updateIdentity: @MainActor (_ revision: String, AidenBotIdentityPatch) async throws -> AidenBotDetail
    var updateAccess: @MainActor (_ revision: String, AidenBotAccessUpdate) async throws -> Void
    var readBot: @MainActor () async throws -> AidenBotDetail
    var readCatalog: @MainActor () async throws -> AidenBotCapabilityCatalog
    /// True when the error revoked this phone; the save then stops quietly.
    var handleRevocation: @MainActor (Error) async -> Bool = { _ in false }
}

enum AidenBotAdvancedSaveOutcome: Equatable {
    case saved(AidenBotDetail)
    case failed(String)
    /// This phone lost access; nothing more to say.
    case stopped
}

/// One Advanced Save, which runs after the page has closed (R15): it waits
/// briefly for the Mac, sends the identity and access changes on the revisions
/// the page was edited on, and re-reads the Bot. A lost answer is settled by
/// re-reading, so a change the Mac saved is never sent twice or called failed.
@MainActor
func aidenBotAdvancedSave(
    draft: AidenBotEditorDraft,
    baseline: AidenBotDetail,
    catalog: AidenBotCapabilityCatalog,
    operations: AidenBotAdvancedSaveOperations,
    connectionHold: Duration = .seconds(8),
    requestLimit: Duration = .seconds(12)
) async -> AidenBotAdvancedSaveOutcome {
    func bounded<T: Sendable>(_ operation: @escaping @MainActor () async throws -> T) async throws -> T {
        let call = AidenBotMainActorCall(operation)
        return try await aidenBotWithin(requestLimit) { try await call.call() }
    }
    do {
        guard await operations.waitForConnection(connectionHold) else { return .failed(AidenBotAdvancedCopy.unreachable) }
        var latest = baseline
        if let patch = try draft.identityPatch(comparedTo: baseline) {
            latest = try await bounded { try await operations.updateIdentity(baseline.revision, patch) }
        }
        if try draft.changesAccess(comparedTo: baseline, catalog: catalog) {
            let update = try draft.accessUpdate(catalog: catalog)
            try await bounded { try await operations.updateAccess(baseline.access.revision, update) }
            latest = try await bounded { try await operations.readBot() }
        }
        return .saved(latest)
    } catch is CancellationError {
        return .stopped
    } catch {
        if await operations.handleRevocation(error) { return .stopped }
        do {
            let authoritative = try await bounded { try await operations.readBot() }
            let refreshedCatalog = try await bounded { try await operations.readCatalog() }
            let rebased = try aidenBotEditorRebasedDraft(
                draft,
                baseline: baseline,
                baselineCatalog: catalog,
                authoritative: authoritative,
                authoritativeCatalog: refreshedCatalog
            )
            if (try? rebased.isSatisfied(by: authoritative, catalog: refreshedCatalog)) == true {
                return .saved(authoritative)
            }
            return .failed(AidenBotAdvancedCopy.changedOnMac)
        } catch {
            if await operations.handleRevocation(error) { return .stopped }
            return .failed(AidenBotAdvancedCopy.couldNotCheck)
        }
    }
}

/// One page for the settings most people never need: the AI model, the image
/// model, and what the Bot can use. Name, subtitle,
/// character, and instructions live on the Profile.
struct AidenBotAdvancedView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let botID: String
    var onSaved: (AidenBotDetail) -> Void = { _ in }
    /// A Save that didn't reach the Mac, after Advanced closed: the screen behind says so.
    var onSaveFailed: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @State private var catalog: AidenBotCapabilityCatalog?
    @State private var baselineBot: AidenBotDetail?
    @State private var draft: AidenBotEditorDraft?
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var isConfirmingDiscard = false
    @State private var chatActivityModel: AidenBotChatActivityModel?
    @State private var isShowingChatActivity = false
    /// Chat activity saves, reported to the screens behind Advanced once, even after it closes.
    @State private var chatActivityReport = AidenBotChatActivityReport()

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var isDirty: Bool {
        aidenBotEditorIsDirty(
            draft: draft,
            cleanCreateDraft: nil,
            baselineBot: baselineBot,
            catalog: catalog,
            isCreating: false
        )
    }

    /// Editing works on the saved details at once, connected or not (R15); Save
    /// waits briefly for the Mac after the page closes.
    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    private var canSave: Bool {
        guard canWrite, isDirty, let catalog, let draft, draft.isSaveable(catalog: catalog) else { return false }
        return true
    }

    var body: some View {
        content
            .navigationTitle("Advanced")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(isDirty)
            .toolbar {
                if isDirty {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { isConfirmingDiscard = true }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { save() }
                            .disabled(!canSave)
                    }
                }
            }
            // A new pairing starts over; a connection coming up only re-reads, keeping edits.
            .task(id: sessionIdentity.pairing) {
                let expectedSession = sessionIdentity
                reset(for: expectedSession)
                await load(for: expectedSession)
            }
            .onChange(of: coordinator.connectionState == .connected) { _, connected in
                guard connected, baselineBot != nil else { return }
                let expectedSession = sessionIdentity
                Task { await load(for: expectedSession) }
            }
            .onAppear { chatActivityReport.appeared(.advanced) }
            .onDisappear {
                // Closing Advanced (not opening Chat activity over it) reports a saved pick once;
                // one that lands later is reported when it lands.
                chatActivityReport.disappeared(
                    .advanced,
                    replacedBy: isShowingChatActivity ? .chatActivity : nil,
                    reportBehind: onSaved
                )
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

    /// Only a phone that may not change Bots is locked; Chat activity has its own rules.
    private var isLocked: Bool { !canWrite }

    private func form(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Form {
            if !canWrite {
                Section {
                    Label(readOnlyMessage, systemImage: "lock.fill")
                        .foregroundStyle(palette.secondary)
                }
            } else if coordinator.connectionState != .connected {
                Section {
                    // Never a lock: changes save once the Mac is reachable.
                    Text(AidenBotSessionCopy.connecting)
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
            }
            modelSection(catalog).disabled(isLocked)
            accessSection(catalog).disabled(isLocked)
            chatActivitySection
            Group {
                if draft?.usesFullAccess == false {
                    optionSection(title: "Connections", options: catalog.connections, keyPath: \.connectionIDs)
                    optionSection(title: "Skills", options: catalog.skills, keyPath: \.skillIDs)
                    filesAndCommandsSection(catalog)
                    optionSection(title: "Other", options: catalog.otherCapabilities, keyPath: \.otherCapabilityIDs)
                }
            }
            .disabled(isLocked)
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .scrollDismissesKeyboard(.interactively)
        .navigationDestination(isPresented: $isShowingChatActivity) {
            if let chatActivityModel, let baselineBot {
                AidenBotChatActivityView(
                    bot: baselineBot,
                    canWrite: coordinator.installationStore.activeInstallation?.canWriteBots == true,
                    model: chatActivityModel
                )
                .onAppear { chatActivityReport.appeared(.chatActivity) }
                // The sheet or the chat can close straight from here, with Advanced never showing again.
                .onDisappear { chatActivityReport.disappeared(.chatActivity, reportBehind: onSaved) }
            }
        }
    }

    private func modelSection(_ catalog: AidenBotCapabilityCatalog) -> some View {
        Section {
            AidenBotModelRow(
                title: "Model",
                catalog: catalog,
                providerID: draft?.customAccess.providerID,
                modelID: draft?.customAccess.modelID,
                recommended: recommendedDraft(catalog).map {
                    AidenBotModelSelection(providerId: $0.customAccess.providerID, modelId: $0.customAccess.modelID)
                }
            ) { providerID, modelID in
                draft?.selectModel(providerID: providerID, modelID: modelID, catalog: catalog)
            }
            switch draft?.photoModelNeed(catalog: catalog) ?? .none {
            case .none:
                EmptyView()
            case .unavailable:
                Text("To look at photos, add an AI that can see images on your Mac.")
                    .foregroundStyle(palette.secondary)
            case .choose:
                AidenBotModelRow(
                    title: "Photos",
                    catalog: catalog,
                    providerID: draft?.visionProviderID,
                    modelID: draft?.visionModelID,
                    imagesOnly: true
                ) { providerID, modelID in
                    draft?.selectVisionModel(providerID: providerID, modelID: modelID, catalog: catalog)
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

    /// Revision 30: hidden unless the Mac announces `bot-activity-v1` and this phone holds
    /// `bot:activity`. It opens from the cached Bot, so it stays reachable offline.
    @ViewBuilder
    private var chatActivitySection: some View {
        if aidenBotShowsChatActivity(
            server: coordinator.server,
            installation: coordinator.installationStore.activeInstallation,
            hasBaseline: baselineBot != nil
        ), let baselineBot {
            Section {
                Button {
                    openChatActivity(baselineBot)
                } label: {
                    HStack {
                        LabeledContent(AidenBotChatActivityCopy.title, value: AidenBotChatActivityCopy.summary(baselineBot.chatActivity))
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.secondary.opacity(0.6))
                            .accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isDirty)
            } footer: {
                Text(isDirty ? "Save or cancel your changes first." : "What you see in its chat on your Mac while it works.")
            }
        }
    }

    private func openChatActivity(_ bot: AidenBotDetail) {
        // A model still saving keeps its own revision; reopening it must not fork a second writer.
        if chatActivityModel?.isSaving != true {
            let botID = bot.id
            // The pairing this page opens under; every request and result stays with it.
            let context = try? coordinator.requestContext()
            let isCurrent: @MainActor () -> Bool = { [coordinator] in
                context.map(coordinator.isCurrent) == true
            }
            chatActivityModel = AidenBotChatActivityModel(
                bot: bot,
                save: { next, revision in
                    guard let context else { throw AidenRemoteClientError.installationChanged }
                    let client = try coordinator.remoteClient(for: context)
                    return try await client.updateBotIdentity(
                        id: botID,
                        revision: revision,
                        patch: try AidenBotIdentityPatch(chatActivity: next)
                    )
                },
                refresh: {
                    guard let context else { throw AidenRemoteClientError.installationChanged }
                    let client = try coordinator.remoteClient(for: context)
                    return try await client.bot(id: botID)
                },
                onSaved: { [report = chatActivityReport, onSaved] saved in
                    // Another pairing's Bot is never shown, cached or reported here.
                    guard let context, isCurrent() else { return }
                    // Advanced's own Save, and its summary row, move to the newest revision.
                    // The screens behind hear about it once Advanced closes, or at once after.
                    baselineBot = saved
                    cacheDetail(saved, for: context)
                    report.saved(saved, reportBehind: onSaved)
                },
                waitForConnection: { hold in await aidenBotWaitForConnection(coordinator, hold: hold) },
                isCurrent: isCurrent
            )
        }
        isShowingChatActivity = true
    }

    private func cacheDetail(_ detail: AidenBotDetail, for context: AidenRemoteRequestContext) {
        guard coordinator.isCurrent(context) else { return }
        Task {
            _ = await coordinator.withRetainedInstallationData(for: context) {
                _ = try? await AidenBotCache.shared.upsertDetailAndStore(
                    detail,
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
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
        if capturedContext == nil { return "Connect to your Mac to change this." }
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
        isConfirmingDiscard = false
        chatActivityModel = nil
        isShowingChatActivity = false
        chatActivityReport = AidenBotChatActivityReport()
    }

    @MainActor
    private func load(for expectedSession: AidenBotCustomAccessSessionIdentity) async {
        guard sessionIdentity.pairing == expectedSession.pairing else { return }
        if draft == nil { isLoading = true }
        loadError = nil
        var requestContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            guard coordinator.isCurrent(context), sessionIdentity.pairing == expectedSession.pairing else { return }
            if draft == nil, let cached = await AidenBotCache.shared.load(
                instanceId: context.instanceId,
                deviceId: context.deviceId
            ), let cachedCatalog = cached.catalog(forBotID: botID),
               let cachedBot = cached.details.first(where: { $0.id == botID }),
               let cachedDraft = AidenBotEditorDraft(detail: cachedBot, catalog: cachedCatalog) {
                guard coordinator.isCurrent(context), sessionIdentity.pairing == expectedSession.pairing else { return }
                catalog = cachedCatalog
                baselineBot = cachedBot
                draft = cachedDraft
                // The saved settings are editable at once; Save waits for the Mac (R15).
                capturedContext = context
                isLoading = false
            }
            let client = try coordinator.remoteClient(for: context)
            async let catalogRequest = client.botCapabilityCatalog(botId: botID)
            async let detailRequest = client.bot(id: botID)
            let (loadedCatalog, loadedBot) = try await (catalogRequest, detailRequest)
            guard coordinator.isCurrent(context), sessionIdentity.pairing == expectedSession.pairing,
                  !Task.isCancelled else { return }
            let loadedDraft: AidenBotEditorDraft
            if isDirty, let draft, let baselineBot, let catalog {
                // Edits made before the Mac answered stay, on top of what it holds now.
                loadedDraft = try aidenBotEditorRebasedDraft(
                    draft,
                    baseline: baselineBot,
                    baselineCatalog: catalog,
                    authoritative: loadedBot,
                    authoritativeCatalog: loadedCatalog
                )
            } else {
                loadedDraft = try aidenBotEditorResolvedDraft(
                    mode: .edit(botID: botID),
                    catalog: loadedCatalog,
                    bot: loadedBot
                )
            }
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
            guard coordinator.isCurrent(context), sessionIdentity.pairing == expectedSession.pairing,
                  !Task.isCancelled else { return }
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if let context = requestContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard sessionIdentity.pairing == expectedSession.pairing else { return }
            // Saved settings stay editable offline; with none, there is nothing to edit.
            if draft == nil {
                capturedContext = nil
                loadError = aidenBotFriendlyLoadError(error)
            }
            isLoading = false
        }
    }

    /// Save closes Advanced at once (R15). The change goes out after, waiting
    /// briefly for the Mac; the screens behind hear the Mac's Bot, or the error.
    @MainActor
    private func save() {
        guard canSave, let context = capturedContext, coordinator.isCurrent(context),
              let catalog, let draft, let baselineBot else { return }
        let botID = baselineBot.id
        let coordinator = coordinator
        let report = chatActivityReport
        let onSaved = onSaved
        let onSaveFailed = onSaveFailed
        let operations = AidenBotAdvancedSaveOperations(
            waitForConnection: { hold in await aidenBotWaitForConnection(coordinator, hold: hold) },
            updateIdentity: { revision, patch in
                try await coordinator.remoteClient(for: context).updateBotIdentity(id: botID, revision: revision, patch: patch)
            },
            updateAccess: { revision, update in
                _ = try await coordinator.remoteClient(for: context).updateBotAccess(botId: botID, revision: revision, update: update)
            },
            readBot: { try await coordinator.remoteClient(for: context).bot(id: botID) },
            readCatalog: { try await coordinator.remoteClient(for: context).botCapabilityCatalog(botId: botID) },
            handleRevocation: { error in await coordinator.handleCredentialRevocation(error, context: context) }
        )
        Task { @MainActor in
            let outcome = await aidenBotAdvancedSave(draft: draft, baseline: baselineBot, catalog: catalog, operations: operations)
            guard coordinator.isCurrent(context) else { return }
            switch outcome {
            case let .saved(latest):
                report.reportedByAdvanced()
                _ = await coordinator.withRetainedInstallationData(for: context) {
                    _ = try? await AidenBotCache.shared.upsertDetailAndStore(
                        latest,
                        instanceId: context.instanceId,
                        deviceId: context.deviceId
                    )
                }
                onSaved(latest)
            case let .failed(message):
                onSaveFailed(message)
            case .stopped:
                break
            }
        }
        dismiss()
    }
}

/// Plain-language load errors for Bot surfaces.
func aidenBotFriendlyLoadError(_ error: Error) -> String {
    if case AidenBotContractError.invalidCombination("no available provider and model") = error {
        return "Needs an AI model. Set one up on your Mac, then try again."
    }
    return error.localizedDescription
}

// MARK: - Model choice (New Bot and Advanced)

struct AidenBotModelListSection: Identifiable {
    let provider: AidenBotProviderOption
    let models: [AidenBotModelOption]
    var id: String { provider.id }
}

/// The Mac's models grouped by service, optionally only those that read images,
/// filtered by a search that matches the model or service name.
func aidenBotModelListSections(
    catalog: AidenBotCapabilityCatalog,
    imagesOnly: Bool,
    query: String
) -> [AidenBotModelListSection] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return catalog.providers.compactMap { provider in
        let models = provider.models.filter { model in
            (!imagesOnly || model.supportsImages)
                && (needle.isEmpty
                    || model.label.localizedCaseInsensitiveContains(needle)
                    || provider.label.localizedCaseInsensitiveContains(needle))
        }
        return models.isEmpty ? nil : AidenBotModelListSection(provider: provider, models: models)
    }
}

/// A row naming the chosen model; it pushes the model list.
struct AidenBotModelRow: View {
    let title: String
    let catalog: AidenBotCapabilityCatalog
    let providerID: String?
    let modelID: String?
    var imagesOnly = false
    var recommended: AidenBotModelSelection? = nil
    let onSelect: (String, String) -> Void

    @Environment(\.aidenPalette) private var palette

    private var current: (provider: AidenBotProviderOption, model: AidenBotModelOption)? {
        guard let provider = catalog.providers.first(where: { $0.id == providerID }),
              let model = provider.models.first(where: { $0.id == modelID }) else { return nil }
        return (provider, model)
    }

    var body: some View {
        NavigationLink {
            AidenBotModelListView(
                title: title, catalog: catalog, providerID: providerID, modelID: modelID,
                imagesOnly: imagesOnly, recommended: recommended, onSelect: onSelect
            )
        } label: {
            HStack(spacing: 8) {
                Text(title).foregroundStyle(palette.foreground)
                Spacer(minLength: 8)
                if let current {
                    AidenProviderIcon(providerID: current.provider.id, providerLabel: current.provider.label, modelID: current.model.id, size: 18)
                    Text(current.model.label).foregroundStyle(palette.secondary).lineLimit(1)
                } else {
                    Text("Choose").foregroundStyle(palette.secondary)
                }
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue(current?.model.label ?? "None")
    }
}

/// The Mac's models: Recommended first, then one section per service.
struct AidenBotModelListView: View {
    let title: String
    let catalog: AidenBotCapabilityCatalog
    let providerID: String?
    let modelID: String?
    let imagesOnly: Bool
    let recommended: AidenBotModelSelection?
    let onSelect: (String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var query = ""

    var body: some View {
        List {
            if query.isEmpty, let recommended,
               let provider = catalog.providers.first(where: { $0.id == recommended.providerId }),
               let model = provider.models.first(where: { $0.id == recommended.modelId }),
               !imagesOnly || model.supportsImages {
                Section("Recommended") { row(provider, model) }
            }
            ForEach(aidenBotModelListSections(catalog: catalog, imagesOnly: imagesOnly, query: query)) { section in
                Section {
                    ForEach(section.models) { model in row(section.provider, model) }
                } header: {
                    HStack(spacing: 6) {
                        AidenProviderIcon(providerID: section.provider.id, providerLabel: section.provider.label, size: 14)
                        Text(section.provider.available ? section.provider.label : "\(section.provider.label) · Not set up")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .searchable(text: $query, prompt: "Search models")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func row(_ provider: AidenBotProviderOption, _ model: AidenBotModelOption) -> some View {
        let usable = provider.available && model.available
        let isSelected = provider.id == providerID && model.id == modelID
        return Button {
            onSelect(provider.id, model.id)
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.label).foregroundStyle(palette.foreground)
                    Text(usable ? (model.supportsImages ? "Reads images" : "Text only") : "Set up on your Mac")
                        .font(.footnote)
                        .foregroundStyle(palette.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Selected")
                }
            }
        }
        .disabled(!usable)
    }
}

// MARK: - Chat activity (spec §7, contract revision 30)

/// Advanced offers Chat activity on a Mac that announces `bot-activity-v1` to a phone that
/// holds `bot:activity`, once a Bot's detail (cached or fresh) is on screen. Offline, the
/// pairing's last-known capabilities decide (R21).
func aidenBotShowsChatActivity(server: AidenServer?, installation: AidenInstallation?, hasBaseline: Bool) -> Bool {
    hasBaseline && aidenBotActivitySupported(server: server, installation: installation)
}

/// The Bot changed on the Mac since this phone read it (a stale `If-Match`).
func aidenBotIsRevisionConflict(_ error: Error) -> Bool {
    guard case let AidenRemoteClientError.server(status, body) = error else { return false }
    return status == 409 || body.code == AidenRemoteErrorCode(rawValue: "revision_conflict")
}

/// Waits for the Mac connection to come up, so an optimistic pick made while connecting
/// still goes out. False once `hold` runs out, or when no Mac is paired.
@MainActor
func aidenBotWaitForConnection(_ coordinator: AidenRemoteCoordinator, hold: Duration) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: hold)
    while coordinator.connectionState != .connected {
        if coordinator.connectionState == .needsPairing || clock.now >= deadline || Task.isCancelled { return false }
        try? await Task.sleep(for: .milliseconds(200))
    }
    return true
}


/// Copy shared with the desktop page (`bot-chat-activity-page.tsx`) and Android.
enum AidenBotChatActivityCopy {
    static let title = "Chat activity"
    static let levelTitle = "How much to show"
    static let wordingTitle = "What the status line says"
    static let phonesTitle = "On iPhone and Android"
    static let phonesFooter = "Always just the line, with the same words."
    static let recommended = "Recommended"
    static let saveFailed = "Aiden couldn’t save that choice."
    static let saveConflict = "This changed on your Mac. Showing what it has now."
    static let saveUnreachable = "Aiden couldn’t reach your Mac to save that choice."

    static func message(_ failure: AidenBotChatActivityFailure) -> String {
        switch failure {
        case .generic: saveFailed
        case .offline: saveUnreachable
        case .conflict: saveConflict
        }
    }

    static func label(_ level: AidenBotChatActivityLevel) -> String {
        switch level {
        case .quiet: "Quiet"
        case .summary: "Summary"
        case .detailed: "Detailed"
        }
    }

    static func detail(_ level: AidenBotChatActivityLevel) -> String {
        switch level {
        case .quiet: "One line that says what it’s doing."
        case .summary: "Adds a short recap above each reply."
        case .detailed: "Also shows its last few steps while it works."
        }
    }

    static func label(_ wording: AidenBotChatActivityWording) -> String {
        switch wording {
        case .follows: "Follows the work"
        case .thinking: "Always “Thinking”"
        }
    }

    static func detail(_ wording: AidenBotChatActivityWording) -> String {
        switch wording {
        case .follows: "Says what it’s doing, like Reading or Searching the web."
        case .thinking: "One calm word, whatever it’s doing."
        }
    }

    /// Advanced's trailing value: "Quiet · Follows the work".
    static func summary(_ value: AidenBotChatActivity?) -> String {
        let resolved = value ?? .standard
        return "\(label(resolved.level)) · \(label(resolved.wording))"
    }

    static func description(botName: String) -> String {
        "What you see in \(botName)’s chat on your Mac while it works. Changes save as you pick them."
    }
}

/// One scripted turn, as each level shows it on the Mac: think, read, search, edit, reply.
enum AidenBotChatActivityPreview {
    struct Frame: Equatable {
        /// The line's phase, or nil on the reply frame.
        let phase: String?
        /// Finished step rows: Detailed while live, or the open recap after the reply.
        let steps: [String]
        /// The step in progress, listed while the line says its phase (Detailed only).
        let running: String?
        let recap: String?
        let recapOpen: Bool
    }

    static let durations: [TimeInterval] = [1.4, 1.6, 1.6, 1.4, 2.8]
    static let prompt = "Plan dinners for this week"
    static let reply = "Here’s a plan for the week."
    static let recap = "Worked for 18s · read 1 file, searched the web, edited 1 file"

    private static let phases: [String?] = ["thinking", "reading", "searching", "editing", nil]
    private static let stepLabels = ["Read 1 file", "Searched the web", "Edited 1 file"]
    /// The step in progress reads in the Mac's own phase words, as its line does.
    private static let runningLabels = ["reading", "searching", "editing"].map {
        AidenBotActivityPhase.display(phase: $0, wording: .follows, app: nil).word
    }

    /// Reduce Motion's still frame. Summary's whole point is the recap above the reply, so it
    /// holds the reply; Quiet and Detailed hold the line (and Detailed's steps) mid-turn.
    static func stillIndex(for level: AidenBotChatActivityLevel) -> Int {
        level == .summary ? phases.count - 1 : 2
    }

    static func frameIndex(elapsed: TimeInterval) -> Int {
        let total = durations.reduce(0, +)
        var time = elapsed.truncatingRemainder(dividingBy: total)
        if time < 0 { time += total }
        for (index, duration) in durations.enumerated() {
            if time < duration { return index }
            time -= duration
        }
        return durations.count - 1
    }

    static func frame(index: Int, level: AidenBotChatActivityLevel) -> Frame {
        let clamped = min(max(index, 0), phases.count - 1)
        if let phase = phases[clamped] {
            let live = level == .detailed && clamped >= 1
            return Frame(
                phase: phase,
                steps: live ? Array(stepLabels.prefix(clamped - 1)) : [],
                running: live ? runningLabels[clamped - 1] : nil,
                recap: nil,
                recapOpen: false
            )
        }
        switch level {
        case .quiet: return Frame(phase: nil, steps: [], running: nil, recap: nil, recapOpen: false)
        case .summary: return Frame(phase: nil, steps: [], running: nil, recap: recap, recapOpen: false)
        case .detailed: return Frame(phase: nil, steps: stepLabels, running: nil, recap: recap, recapOpen: true)
        }
    }
}

/// The Mac stayed unreachable for the whole hold.
struct AidenBotChatActivityUnreachable: Error {}

/// Carries a main-actor closure into `aidenBotWithin`'s race; it is only ever called on the main actor.
struct AidenBotMainActorCall<Function>: @unchecked Sendable {
    let call: Function
    init(_ call: Function) { self.call = call }
}

/// Why a pick didn't stick, so the page says so in the right words (Android parity).
enum AidenBotChatActivityFailure: Equatable {
    /// The Mac refused or failed the save.
    case generic
    /// The phone couldn't reach the Mac: offline, disconnected, or too slow.
    case offline
    /// The Bot changed on the Mac; the page now shows what the Mac holds.
    case conflict
}

/// The save may or may not have reached the Mac: no answer came, so a late success is possible.
func aidenBotChatActivityTransportFailure(_ error: Error) -> Bool {
    error is AidenBotRequestTimedOut || error is URLError
}

/// Reports Chat activity saves to the screens behind Advanced. While Advanced or
/// its Chat activity page shows, it holds the newest, to report once when the
/// last of them closes, whichever page that is (the sheet can close from Chat
/// activity); a save that lands after that is reported at once, so it is never lost.
@MainActor
final class AidenBotChatActivityReport {
    enum Page: Hashable {
        case advanced, chatActivity
    }

    private var showing: Set<Page> = [.advanced]
    private var unreported: AidenBotDetail?

    func saved(_ detail: AidenBotDetail, reportBehind: (AidenBotDetail) -> Void) {
        if showing.isEmpty {
            reportBehind(detail)
        } else {
            unreported = detail
        }
    }

    func appeared(_ page: Page) { showing.insert(page) }

    /// `page` left the screen; `replacedBy` is the page pushed over it. Once neither
    /// page shows, what was held is reported once, and later saves go straight behind.
    func disappeared(_ page: Page, replacedBy next: Page? = nil, reportBehind: (AidenBotDetail) -> Void) {
        showing.remove(page)
        if let next { showing.insert(next) }
        guard showing.isEmpty, let detail = unreported else { return }
        unreported = nil
        reportBehind(detail)
    }

    /// Advanced's own Save reported the newest Bot; nothing older is held.
    func reportedByAdvanced() { unreported = nil }
}

/// Applies each pick at once and saves it with no Save button, like the Mac page.
/// A failed save returns to the last choice the Mac confirmed. A pick made while a
/// save is in flight shows at once and goes out next (the last pick wins), on the
/// revision that save returned. A stale revision refreshes the Bot and adopts the Mac's choice.
/// Nothing is queued durably: a pick is held only for `connectionHold` while the Mac connects.
@MainActor
@Observable
final class AidenBotChatActivityModel {
    /// What the page shows: the last pick, saved or not.
    private(set) var value: AidenBotChatActivity
    private(set) var isSaving = false
    /// Why the last pick didn't stick, until the next pick.
    private(set) var saveFailure: AidenBotChatActivityFailure?
    var errorMessage: String?

    @ObservationIgnored private var saved: AidenBotChatActivity
    @ObservationIgnored private var pending: AidenBotChatActivity?
    @ObservationIgnored private var revision: String
    @ObservationIgnored private let save: @MainActor (AidenBotChatActivity, String) async throws -> AidenBotDetail
    @ObservationIgnored private let refresh: @MainActor () async throws -> AidenBotDetail
    @ObservationIgnored private let onSaved: @MainActor (AidenBotDetail) -> Void
    @ObservationIgnored private let waitForConnection: (@MainActor (Duration) async -> Bool)?
    /// False once the pairing this page opened under is no longer the active one.
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let connectionHold: Duration
    @ObservationIgnored private let requestLimit: Duration

    /// `requestLimit` bounds each request: the phone's URLSession waits for connectivity
    /// for minutes, which a settings pick must not. `isCurrent` fences the pairing: once it
    /// is false nothing more is sent, and a result that comes back is dropped unreported.
    init(
        bot: AidenBotDetail,
        save: @escaping @MainActor (AidenBotChatActivity, String) async throws -> AidenBotDetail,
        refresh: @escaping @MainActor () async throws -> AidenBotDetail,
        onSaved: @escaping @MainActor (AidenBotDetail) -> Void,
        waitForConnection: (@MainActor (Duration) async -> Bool)? = nil,
        isCurrent: @escaping @MainActor () -> Bool = { true },
        connectionHold: Duration = .seconds(8),
        requestLimit: Duration = .seconds(12)
    ) {
        let current = bot.chatActivity ?? .standard
        value = current
        saved = current
        revision = bot.revision
        self.save = save
        self.refresh = refresh
        self.onSaved = onSaved
        self.waitForConnection = waitForConnection
        self.isCurrent = isCurrent
        self.connectionHold = connectionHold
        self.requestLimit = requestLimit
    }

    func pick(_ next: AidenBotChatActivity) async {
        guard next != value else { return }
        value = next
        errorMessage = nil
        saveFailure = nil
        if isSaving {
            pending = next
            return
        }
        isSaving = true
        defer { isSaving = false }
        var target = next
        while true {
            guard await send(target) else { return }
            guard let following = pending else { break }
            pending = nil
            if following == saved { break }
            target = following
        }
        value = saved
    }

    /// One save: true when the Mac holds `target` afterwards. A stale revision, a
    /// timeout or a transport failure re-reads the Bot first, so a save that landed
    /// late shows as saved with no error, and anything else returns to what the Mac holds.
    private func send(_ target: AidenBotChatActivity) async -> Bool {
        do {
            guard isCurrent() else { return giveUp() }
            if let waitForConnection {
                let connected = await waitForConnection(connectionHold)
                // Another pairing came up during the hold: the pick was for the Mac that left.
                guard isCurrent() else { return giveUp() }
                if !connected { throw AidenBotChatActivityUnreachable() }
            }
            // The closures run on the main actor; the box only carries them across the race.
            let save = AidenBotMainActorCall(save)
            let sentRevision = revision
            let detail = try await aidenBotWithin(requestLimit) { try await save.call(target, sentRevision) }
            guard isCurrent() else { return giveUp() }
            revision = detail.revision
            saved = detail.chatActivity ?? target
            onSaved(detail)
            return true
        } catch {
            guard isCurrent() else { return giveUp() }
            if error is CancellationError {
                pending = nil
                value = saved
                return false
            }
            let conflict = aidenBotIsRevisionConflict(error)
            if conflict || aidenBotChatActivityTransportFailure(error),
               let fresh = await adoptTheMacsChoice(),
               (fresh.chatActivity ?? .standard) == target {
                // The Mac holds this pick after all: one made meanwhile goes out next, on the fresh revision.
                return true
            }
            // The pairing changed during the refresh: nothing more is said about that Mac's Bot.
            guard isCurrent() else { return giveUp() }
            pending = nil
            let failure: AidenBotChatActivityFailure
            if conflict {
                failure = .conflict
            } else if aidenBotChatActivityTransportFailure(error) || error is AidenBotChatActivityUnreachable {
                failure = .offline
            } else {
                failure = .generic
            }
            value = saved
            saveFailure = failure
            errorMessage = AidenBotChatActivityCopy.message(failure)
            return false
        }
    }

    /// The pairing changed under the pick: it goes back to what this page last saw, with no error,
    /// since the person is no longer looking at that Mac's Bot.
    private func giveUp() -> Bool {
        pending = nil
        value = saved
        return false
    }

    /// The Mac may hold something else now: take its revision and choice, so the next pick can save.
    private func adoptTheMacsChoice() async -> AidenBotDetail? {
        guard isCurrent() else { return nil }
        let refresh = AidenBotMainActorCall(refresh)
        guard let fresh = try? await aidenBotWithin(requestLimit, { try await refresh.call() }),
              isCurrent() else { return nil }
        revision = fresh.revision
        saved = fresh.chatActivity ?? .standard
        onSaved(fresh)
        return fresh
    }
}

struct AidenBotChatActivityView: View {
    let botName: String
    let canWrite: Bool
    @State private var model: AidenBotChatActivityModel
    @Environment(\.aidenPalette) private var palette

    init(bot: AidenBotDetail, canWrite: Bool, model: AidenBotChatActivityModel) {
        botName = bot.name
        self.canWrite = canWrite
        _model = State(initialValue: model)
    }

    var body: some View {
        Form {
            if !canWrite {
                Section {
                    Label("This phone can look but not change Bots.", systemImage: "lock.fill")
                        .foregroundStyle(palette.secondary)
                }
            }
            Section {
                Text(AidenBotChatActivityCopy.description(botName: botName))
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .listRowBackground(palette.raised)
            }
            Section(AidenBotChatActivityCopy.levelTitle) {
                let levels = AidenBotChatActivityLevel.allCases
                ForEach(Array(levels.enumerated()), id: \.element) { index, level in
                    choiceRow(
                        title: AidenBotChatActivityCopy.label(level),
                        detail: AidenBotChatActivityCopy.detail(level),
                        recommended: level == .quiet,
                        selected: model.value.level == level,
                        neighbors: neighbors(levels.map { model.value.level == $0 }, index),
                        preview: AidenBotChatActivityPreviewView(level: level, wording: model.value.wording)
                    ) { Task { await model.pick(AidenBotChatActivity(level: level, wording: model.value.wording)) } }
                }
            }
            Section(AidenBotChatActivityCopy.wordingTitle) {
                let wordings = AidenBotChatActivityWording.allCases
                ForEach(Array(wordings.enumerated()), id: \.element) { index, wording in
                    choiceRow(
                        title: AidenBotChatActivityCopy.label(wording),
                        detail: AidenBotChatActivityCopy.detail(wording),
                        recommended: false,
                        selected: model.value.wording == wording,
                        neighbors: neighbors(wordings.map { model.value.wording == $0 }, index),
                        preview: AidenBotChatActivityPreviewView(level: .quiet, wording: wording)
                    ) { Task { await model.pick(AidenBotChatActivity(level: model.value.level, wording: wording)) } }
                }
            }
            Section {
                AidenBotChatActivityPreviewView(level: .quiet, wording: model.value.wording)
                    .listRowBackground(palette.raised)
            } header: {
                Text(AidenBotChatActivityCopy.phonesTitle)
            } footer: {
                Text(AidenBotChatActivityCopy.phonesFooter)
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .navigationTitle(AidenBotChatActivityCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(!canWrite)
        .alert(
            "Couldn’t Save",
            isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
        ) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? AidenBotChatActivityCopy.saveFailed)
        }
    }

    /// Which separators touch the selected row; those are hidden so no sliver shows above it.
    private func neighbors(_ selected: [Bool], _ index: Int) -> (top: Bool, bottom: Bool) {
        let above = index > 0 && selected[index - 1]
        let below = index < selected.count - 1 && selected[index + 1]
        return (selected[index] || above, selected[index] || below)
    }

    /// A radio row: the radio and the row's background show the choice; there is no border.
    /// The row reads as one element (title, Recommended, detail); the preview is decoration.
    private func choiceRow(
        title: String,
        detail: String,
        recommended: Bool,
        selected: Bool,
        neighbors: (top: Bool, bottom: Bool),
        preview: AidenBotChatActivityPreviewView,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? palette.accent : palette.secondary)
                    .font(.title3)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(title).foregroundStyle(palette.foreground)
                        if recommended {
                            Text(AidenBotChatActivityCopy.recommended)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(palette.secondary)
                        }
                    }
                    Text(detail).font(.footnote).foregroundStyle(palette.secondary)
                    preview
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // No dedicated selection token exists; the accent wash is what Appearance and onboarding use.
        .listRowBackground(
            ZStack {
                palette.raised
                if selected { palette.accent.opacity(0.12) }
            }
        )
        .listRowSeparator(neighbors.top ? .hidden : .automatic, edges: .top)
        .listRowSeparator(neighbors.bottom ? .hidden : .automatic, edges: .bottom)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A small chat replaying one scripted turn. It holds its still frame under Reduce Motion,
/// and stops while the app is inactive or the preview is scrolled out of view.
struct AidenBotChatActivityPreviewView: View {
    let level: AidenBotChatActivityLevel
    let wording: AidenBotChatActivityWording

    @Environment(\.aidenPalette) private var palette
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.aidenReduceMotion) private var appReduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var onScreen = true
    @ScaledMetric(relativeTo: .caption) private var markSize: CGFloat = 14

    private var still: Bool { systemReduceMotion || appReduceMotion }
    private var paused: Bool { still || scenePhase != .active || !onScreen }

    var body: some View {
        // One shared clock, so every preview on the page is on the same step of the turn.
        TimelineView(.animation(minimumInterval: 0.2, paused: paused)) { context in
            let index = still
                ? AidenBotChatActivityPreview.stillIndex(for: level)
                : AidenBotChatActivityPreview.frameIndex(elapsed: context.date.timeIntervalSinceReferenceDate)
            content(AidenBotChatActivityPreview.frame(index: index, level: level))
        }
        .padding(10)
        .background(palette.canvas, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        // A Form's rows come and go as they scroll, so appearing is being on screen.
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func content(_ frame: AidenBotChatActivityPreview.Frame) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(AidenBotChatActivityPreview.prompt)
                .font(.caption)
                .foregroundStyle(palette.foreground)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .frame(maxWidth: .infinity, alignment: .trailing)
            if let recap = frame.recap {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Image(systemName: frame.recapOpen ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                    Text(recap).fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption2)
                .foregroundStyle(palette.secondary)
            }
            ForEach(frame.steps, id: \.self) { step in
                Text(step).font(.caption2).foregroundStyle(palette.secondary).padding(.leading, 14)
            }
            if let running = frame.running {
                Text(running).font(.caption2.weight(.medium)).foregroundStyle(palette.foreground).padding(.leading, 14)
            }
            if let phase = frame.phase {
                let shown = AidenBotActivityPhase.display(phase: phase, wording: wording, app: nil)
                HStack(spacing: 6) {
                    AidenActivityMark(mark: shown.mark, size: markSize, active: !paused, color: palette.secondary)
                    Text(shown.word).font(.caption)
                }
                .foregroundStyle(palette.secondary)
            } else {
                Text(AidenBotChatActivityPreview.reply).font(.caption).foregroundStyle(palette.foreground)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
