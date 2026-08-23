import Observation
import SwiftUI

enum AidenBotChatAccessScope: String, CaseIterable, Identifiable {
    case bot = "Bot defaults"
    case chat = "This chat"

    var id: String { rawValue }
}

enum AidenBotChatSheet: Identifiable {
    case access
    case files(AidenBotConversationFileGrant)

    var id: String {
        switch self {
        case .access: "access"
        case .files: "files"
        }
    }
}

struct AidenBotChatToolsSessionIdentity: Equatable {
    let instanceID: String?
    let deviceID: String?
    let connection: String
    let capabilities: String

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
        capabilities = [
            installation?.deviceCapabilities.map(\.rawValue).sorted().joined(separator: ",") ?? "",
            installation?.serverCapabilities?.map(\.rawValue).sorted().joined(separator: ",") ?? "legacy",
        ].joined(separator: "|")
    }
}

struct AidenBotChatAccessDraft: Equatable {
    var mode: AidenBotChatAccessMode
    var providerID: String
    var modelID: String
    var fileScopeIDs: Set<String>
    var shellEnabled: Bool
    var connectionIDs: Set<String>
    var skillIDs: Set<String>
    var otherCapabilityIDs: Set<String>

    init?(
        botAccess: AidenBotAccessView,
        chatAccess: AidenBotChatAccessView,
        catalog: AidenBotCapabilityCatalog
    ) {
        let startingSelection: AidenBotCustomSelection
        if let custom = chatAccess.custom ?? botAccess.custom {
            startingSelection = custom
        } else {
            guard let provider = catalog.providers.first(where: {
                $0.available && $0.models.contains(where: \.available)
            }), let model = provider.models.first(where: \.available) else {
                return nil
            }
            guard let full = try? AidenBotCustomSelection(
                fileScopeIds: catalog.fileScopes.filter(\.available).map(\.id),
                shellEnabled: catalog.shellAvailable,
                connectionIds: catalog.connections.filter(\.available).map(\.id),
                skillIds: catalog.skills.filter(\.available).map(\.id),
                otherCapabilityIds: catalog.otherCapabilities.filter(\.available).map(\.id),
                providerId: provider.id,
                modelId: model.id
            ) else { return nil }
            startingSelection = full
        }

        mode = chatAccess.mode
        providerID = startingSelection.providerId
        modelID = startingSelection.modelId
        fileScopeIDs = Set(startingSelection.fileScopeIds)
        shellEnabled = startingSelection.shellEnabled
        connectionIDs = Set(startingSelection.connectionIds)
        skillIDs = Set(startingSelection.skillIds)
        otherCapabilityIDs = Set(startingSelection.otherCapabilityIds)
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

    func isSaveable(
        botAccess: AidenBotAccessView,
        catalog: AidenBotCapabilityCatalog
    ) -> Bool {
        guard mode == .custom else { return true }
        guard let selection = try? selection() else { return false }
        return catalog.containsAvailable(selection) && botAccess.permits(selection)
    }

    func optionAllowed(
        _ id: String,
        in options: [AidenBotCapabilityOption],
        botAllowedIDs: Set<String>?
    ) -> Bool {
        options.contains { $0.id == id && $0.available }
            && (botAllowedIDs?.contains(id) ?? true)
    }

    func fileScopeAllowed(
        _ id: String,
        catalog: AidenBotCapabilityCatalog,
        botAccess: AidenBotAccessView
    ) -> Bool {
        catalog.fileScopes.contains { $0.id == id && $0.available }
            && (botAccess.custom.map { Set($0.fileScopeIds).contains(id) } ?? true)
    }

    mutating func selectProvider(
        _ providerID: String,
        catalog: AidenBotCapabilityCatalog,
        botAccess: AidenBotAccessView
    ) {
        guard let provider = catalog.providers.first(where: {
            $0.id == providerID && $0.available
        }), let model = provider.models.first(where: \.available) else { return }
        if let ceiling = botAccess.custom,
           provider.id != ceiling.providerId || !provider.models.contains(where: {
               $0.id == ceiling.modelId && $0.available
           }) {
            return
        }
        self.providerID = provider.id
        modelID = botAccess.custom?.modelId ?? model.id
    }
}

enum AidenBotChatAccessPresentation {
    static func hasFiles(
        botAccess: AidenBotAccessView,
        chatAccess: AidenBotChatAccessView,
        catalog: AidenBotCapabilityCatalog
    ) -> Bool {
        if let custom = chatAccess.custom ?? botAccess.custom {
            return !custom.fileScopeIds.isEmpty
        }
        return catalog.fileScopes.contains(where: \.available)
    }

    static func summary(
        bot: AidenBotDetail,
        chatAccess: AidenBotChatAccessView,
        connected: Bool
    ) -> String {
        if !connected { return "Offline · \(chatAccess.summary)" }
        if bot.health == .archived { return "Archived · \(chatAccess.summary)" }
        if bot.health != .ready { return "Repair access · \(chatAccess.summary)" }
        return chatAccess.summary
    }
}

private struct AidenBotChatAccessLoadIdentity: Equatable {
    let context: AidenRemoteRequestContext
    let chatID: String
    let botID: String
}

struct AidenBotConversationFileGrant: Equatable {
    let context: AidenRemoteRequestContext
    let chatID: String
    let botID: String
    let chatAccessRevision: String
    let botPolicyRevision: String
    let catalogRevision: String
    let allowsWrites: Bool
}

@MainActor
@Observable
final class AidenBotChatToolsModel {
    let chatID: String
    let botID: String
    var bot: AidenBotDetail?
    var access: AidenBotChatAccessView?
    var catalog: AidenBotCapabilityCatalog?
    var draft: AidenBotChatAccessDraft?
    var isLoading = false
    var isSaving = false
    var errorMessage: String?

    private var loadIdentity: AidenBotChatAccessLoadIdentity?
    private var savedDraft: AidenBotChatAccessDraft?
    private var loadToken: UUID?

    init(chatID: String, botID: String) {
        self.chatID = chatID
        self.botID = botID
    }

    func summary(connected: Bool) -> String {
        guard let bot, let access else { return isLoading ? "Loading access…" : "Access unavailable" }
        return AidenBotChatAccessPresentation.summary(
            bot: bot,
            chatAccess: access,
            connected: connected
        )
    }

    var hasFiles: Bool {
        guard let bot, let access, let catalog, bot.health != .unavailable else { return false }
        return AidenBotChatAccessPresentation.hasFiles(
            botAccess: bot.access,
            chatAccess: access,
            catalog: catalog
        )
    }

    var isDirty: Bool { draft != savedDraft }

    func canEdit(coordinator: AidenRemoteCoordinator, hostAllowsMutations: Bool) -> Bool {
        guard isDirty, allowsDraftEditing(
            coordinator: coordinator,
            hostAllowsMutations: hostAllowsMutations
        ),
              let bot, bot.health == .ready,
              let access, let catalog, let draft,
              access.botPolicyRevision == bot.access.revision,
              draft.isSaveable(botAccess: bot.access, catalog: catalog) else { return false }
        return true
    }

    func allowsDraftEditing(
        coordinator: AidenRemoteCoordinator,
        hostAllowsMutations: Bool
    ) -> Bool {
        guard hostAllowsMutations, !isLoading, !isSaving,
              coordinator.connectionState == .connected,
              coordinator.installationStore.activeInstallation?.canWriteBots == true,
              let identity = loadIdentity, coordinator.isCurrent(identity.context),
              bot?.health == .ready else { return false }
        return true
    }

    func readOnlyMessage(coordinator: AidenRemoteCoordinator, hostAllowsMutations: Bool) -> String? {
        if bot?.health == .archived { return "Archived bots are read-only until restored." }
        if bot?.health == .degraded || bot?.health == .unavailable {
            return "This bot's access needs repair on your Mac before it can work."
        }
        if coordinator.connectionState != .connected { return "Offline — reconnect to change this chat's access." }
        if coordinator.installationStore.activeInstallation?.canWriteBots != true {
            return "This phone can view Bot access but is not approved to change it."
        }
        if !hostAllowsMutations { return "This conversation is read-only right now." }
        if loadIdentity.map({ coordinator.isCurrent($0.context) }) != true {
            return "This chat's access could not be verified. Refresh it before making changes."
        }
        return nil
    }

    func fileGrant(
        coordinator: AidenRemoteCoordinator,
        hostAllowsMutations: Bool
    ) -> AidenBotConversationFileGrant? {
        guard hasFiles, let identity = loadIdentity, let bot, let access, let catalog else { return nil }
        return AidenBotConversationFileGrant(
            context: identity.context,
            chatID: chatID,
            botID: botID,
            chatAccessRevision: access.revision,
            botPolicyRevision: bot.access.revision,
            catalogRevision: catalog.revision,
            allowsWrites: hostAllowsMutations
                && bot.health == .ready
                && coordinator.connectionState == .connected
                && coordinator.installationStore.activeInstallation?.canWriteBots == true
                && coordinator.isCurrent(identity.context)
        )
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        let token = UUID()
        loadToken = token
        var capturedContext: AidenRemoteRequestContext?
        isLoading = true
        errorMessage = nil
        defer {
            if loadToken == token { isLoading = false }
        }
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let identity = AidenBotChatAccessLoadIdentity(context: context, chatID: chatID, botID: botID)
            let client = try coordinator.remoteClient(for: context)
            async let botRequest = client.bot(id: botID)
            async let accessRequest = client.botChatAccess(chatId: chatID)
            async let catalogRequest = client.botCapabilityCatalog()
            let (loadedBot, loadedAccess, loadedCatalog) = try await (
                botRequest, accessRequest, catalogRequest
            )
            guard loadToken == token, coordinator.isCurrent(context),
                  loadedBot.id == botID,
                  loadedAccess.chatId == chatID,
                  loadedAccess.botId == botID,
                  loadedAccess.botPolicyRevision == loadedBot.access.revision,
                  loadedAccess.custom.map(loadedBot.access.permits) ?? true,
                  let loadedDraft = AidenBotChatAccessDraft(
                      botAccess: loadedBot.access,
                      chatAccess: loadedAccess,
                      catalog: loadedCatalog
                  ) else {
                throw AidenRemoteClientError.invalidResponse
            }
            loadIdentity = identity
            bot = loadedBot
            access = loadedAccess
            catalog = loadedCatalog
            draft = loadedDraft
            savedDraft = loadedDraft
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) {
                if loadToken == token { clearLoadedState() }
                return
            }
            guard loadToken == token,
                  capturedContext.map(coordinator.isCurrent) ?? true else { return }
            clearLoadedState()
            errorMessage = error.localizedDescription
        }
    }

    func refresh(coordinator: AidenRemoteCoordinator) async -> Bool {
        await load(coordinator: coordinator)
        guard let identity = loadIdentity else { return false }
        return coordinator.isCurrent(identity.context)
    }

    func resetForSessionChange() {
        loadToken = nil
        isLoading = false
        isSaving = false
        errorMessage = nil
        clearLoadedState()
    }

    func save(coordinator: AidenRemoteCoordinator, hostAllowsMutations: Bool) async -> Bool {
        guard canEdit(coordinator: coordinator, hostAllowsMutations: hostAllowsMutations),
              let identity = loadIdentity, let bot, let access, let catalog, let draft else { return false }
        let context = identity.context
        let expectedAccessRevision = access.revision
        let expectedBotRevision = bot.access.revision
        let expectedCatalogRevision = catalog.revision
        let attemptedDraft = draft
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let update: AidenBotChatAccessUpdate
            switch draft.mode {
            case .inherit:
                update = .inherit(
                    catalogRevision: expectedCatalogRevision,
                    expectedBotPolicyRevision: expectedBotRevision
                )
            case .custom:
                let selection = try draft.selection()
                guard catalog.containsAvailable(selection), bot.access.permits(selection) else {
                    throw AidenBotContractError.invalidCombination("chat access exceeds bot")
                }
                update = .custom(
                    catalogRevision: expectedCatalogRevision,
                    expectedBotPolicyRevision: expectedBotRevision,
                    selection: selection
                )
            }
            let updated = try await coordinator.remoteClient(for: context).updateBotChatAccess(
                chatId: chatID,
                revision: expectedAccessRevision,
                update: update
            )
            guard coordinator.isCurrent(context), loadIdentity == identity,
                  self.access?.revision == expectedAccessRevision,
                  self.bot?.access.revision == expectedBotRevision,
                  self.catalog?.revision == expectedCatalogRevision,
                  updated.chatId == chatID,
                  updated.botId == botID,
                  updated.botPolicyRevision == expectedBotRevision,
                  updated.custom.map(bot.access.permits) ?? true,
                  let nextDraft = AidenBotChatAccessDraft(
                      botAccess: bot.access,
                      chatAccess: updated,
                      catalog: catalog
                  ) else {
                throw AidenRemoteClientError.invalidResponse
            }
            self.access = updated
            self.draft = nextDraft
            savedDraft = nextDraft
            return true
        } catch is CancellationError {
            return false
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) {
                clearLoadedState()
                return false
            }
            guard coordinator.isCurrent(context), loadIdentity == identity else { return false }
            if shouldReconcile(error) {
                await loadFresh(coordinator: coordinator)
                guard coordinator.isCurrent(context),
                      loadIdentity?.context == context,
                      let refreshedBot = self.bot,
                      let refreshedCatalog = self.catalog,
                      self.access != nil else {
                    errorMessage = "Aiden could not confirm the access change. Reconnect and review access before trying again."
                    return false
                }
                if self.draft == attemptedDraft {
                    return true
                }
                if attemptedDraft.isSaveable(
                       botAccess: refreshedBot.access,
                       catalog: refreshedCatalog
                   ) {
                    self.draft = attemptedDraft
                }
                errorMessage = "Aiden could not confirm every access change. Review the refreshed settings before saving again."
                return false
            }
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func loadFresh(coordinator: AidenRemoteCoordinator) async {
        loadIdentity = nil
        await load(coordinator: coordinator)
    }

    private func clearLoadedState() {
        loadToken = nil
        isLoading = false
        loadIdentity = nil
        bot = nil
        access = nil
        catalog = nil
        draft = nil
        savedDraft = nil
    }

    private func shouldReconcile(_ error: Error) -> Bool {
        if error is URLError { return true }
        guard let clientError = error as? AidenRemoteClientError else { return false }
        switch clientError {
        case .invalidResponse, .unexpectedStatus:
            return true
        case .server(_, let body):
            return body.code.rawValue == "revision_conflict"
                || body.code.rawValue == "catalog_revision_conflict"
                || body.code.rawValue == "bot_policy_revision_conflict"
        case .invalidEndpoint, .missingCredential, .missingTrustConfiguration, .installationChanged:
            return false
        }
    }
}

struct AidenBotChatAccessSheetView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var model: AidenBotChatToolsModel
    let hostAllowsMutations: Bool
    @State private var scope = AidenBotChatAccessScope.chat
    @State private var isConfirmingDiscard = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("Access scope", selection: $scope) {
                    ForEach(AidenBotChatAccessScope.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                if scope == .bot { botDefaults }
                else { chatAccess }
            }
            .scrollContentBackground(.hidden)
            .background(palette.canvas)
            .navigationTitle("Access")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        if model.isDirty { isConfirmingDiscard = true }
                        else { dismiss() }
                    }
                }
                if scope == .chat {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.isSaving ? "Saving…" : "Save") {
                            Task {
                                if await model.save(
                                    coordinator: coordinator,
                                    hostAllowsMutations: hostAllowsMutations
                                ) { dismiss() }
                            }
                        }
                        .disabled(!model.canEdit(
                            coordinator: coordinator,
                            hostAllowsMutations: hostAllowsMutations
                        ))
                    }
                }
            }
        }
        .interactiveDismissDisabled(model.isSaving || model.isDirty)
        .confirmationDialog("Discard access changes?", isPresented: $isConfirmingDiscard) {
            Button("Discard Changes", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var botDefaults: some View {
        if let bot = model.bot {
            Section("Effective bot access") {
                Label(bot.access.summary, systemImage: bot.access.accessMode == .full ? "macbook" : "slider.horizontal.3")
                if let selection = bot.access.custom {
                    accessCounts(selection)
                }
            }
            Section {
                Text("Bot defaults set the ceiling. This chat can inherit them or turn capabilities off, but it cannot add access.")
                    .foregroundStyle(palette.secondary)
            }
        } else {
            unavailableContent
        }
    }

    @ViewBuilder
    private var chatAccess: some View {
        if let bot = model.bot, let access = model.access,
           let catalog = model.catalog, model.draft != nil {
            Section {
                Picker("This chat", selection: modeBinding) {
                    Text("Inherit Bot").tag(AidenBotChatAccessMode.inherit)
                    Text("Customize").tag(AidenBotChatAccessMode.custom)
                }
                .disabled(!canChangeDraft)
                Text(access.summary)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
            } header: { Text("Effective access") }

            if model.draft?.mode == .custom {
                optionSection(
                    title: "Connections",
                    description: "Connected apps and services already configured on your Mac.",
                    options: catalog.connections,
                    keyPath: \.connectionIDs,
                    ceiling: bot.access.custom.map { Set($0.connectionIds) }
                )
                .disabled(!canChangeDraft)
                optionSection(
                    title: "Skills",
                    description: "Aiden instructions and workflows available to this conversation.",
                    options: catalog.skills,
                    keyPath: \.skillIDs,
                    ceiling: bot.access.custom.map { Set($0.skillIds) }
                )
                .disabled(!canChangeDraft)
                filesAndCommands(catalog: catalog, bot: bot)
                    .disabled(!canChangeDraft)
                aiSection(catalog: catalog, bot: bot)
                    .disabled(!canChangeDraft)
                optionSection(
                    title: "Other abilities",
                    description: "Additional capabilities enabled for this bot on your Mac.",
                    options: catalog.otherCapabilities,
                    keyPath: \.otherCapabilityIDs,
                    ceiling: bot.access.custom.map { Set($0.otherCapabilityIds) }
                )
                .disabled(!canChangeDraft)
            }

            Section {
                Text("Access you turn off is blocked at the next tool effect, including during an active reply. Access you turn back on is available with the next turn. This chat can only use access already allowed for its Bot.")
                    .foregroundStyle(palette.secondary)
                if let message = model.readOnlyMessage(
                    coordinator: coordinator,
                    hostAllowsMutations: hostAllowsMutations
                ) {
                    Label(message, systemImage: "lock.fill")
                        .foregroundStyle(palette.secondary)
                }
                if let error = model.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(palette.warning)
                }
            }
        } else {
            unavailableContent
        }
    }

    private func accessCounts(_ selection: AidenBotCustomSelection) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("\(selection.connectionIds.count) connections", systemImage: "link")
            Label("\(selection.skillIds.count) skills", systemImage: "sparkles")
            Label(selection.fileScopeIds.isEmpty ? "Files off" : "Files on", systemImage: "folder")
            Label(selection.shellEnabled ? "Commands on" : "Commands off", systemImage: "terminal")
        }
        .font(.subheadline)
    }

    private var unavailableContent: some View {
        Section {
            if model.isLoading { ProgressView("Loading access…") }
            else {
                ContentUnavailableView(
                    "Access Unavailable",
                    systemImage: "lock.trianglebadge.exclamationmark",
                    description: Text(model.errorMessage ?? "Reconnect to your Mac to load this chat's access.")
                )
            }
        }
    }

    private var modeBinding: Binding<AidenBotChatAccessMode> {
        Binding(
            get: { model.draft?.mode ?? .inherit },
            set: { model.draft?.mode = $0 }
        )
    }

    private var canChangeDraft: Bool {
        model.allowsDraftEditing(
            coordinator: coordinator,
            hostAllowsMutations: hostAllowsMutations
        )
    }

    private func aiSection(catalog: AidenBotCapabilityCatalog, bot: AidenBotDetail) -> some View {
        Section("AI") {
            Picker("Provider", selection: providerBinding(catalog: catalog, bot: bot)) {
                ForEach(catalog.providers) { provider in
                    Text(optionTitle(provider.label, available: provider.available))
                        .tag(provider.id)
                        .disabled(!provider.available || (bot.access.custom?.providerId != nil
                            && bot.access.custom?.providerId != provider.id))
                }
            }
            Picker("Model", selection: modelBinding(catalog: catalog, bot: bot)) {
                ForEach(catalog.providers.first(where: { $0.id == model.draft?.providerID })?.models ?? []) { option in
                    Text(optionTitle(option.label, available: option.available))
                        .tag(option.id)
                        .disabled(!option.available || (bot.access.custom?.modelId != nil
                            && bot.access.custom?.modelId != option.id))
                }
            }
            Text("Provider credentials stay on your Mac.")
                .font(.footnote)
                .foregroundStyle(palette.secondary)
        }
    }

    private func filesAndCommands(catalog: AidenBotCapabilityCatalog, bot: AidenBotDetail) -> some View {
        Section {
            ForEach(catalog.fileScopes) { option in
                Toggle(isOn: fileBinding(option.id, catalog: catalog, bot: bot)) {
                    optionLabel(option.label, description: option.description, available: option.available)
                }
                .disabled(!(model.draft?.fileScopeAllowed(
                    option.id,
                    catalog: catalog,
                    botAccess: bot.access
                ) ?? false) && model.draft?.fileScopeIDs.contains(option.id) != true)
            }
            Toggle("Run commands", isOn: shellBinding(catalog: catalog, bot: bot))
                .disabled((!catalog.shellAvailable || bot.access.custom?.shellEnabled == false)
                    && model.draft?.shellEnabled != true)
        } header: { Text("Files and Commands") } footer: {
            Text("Files and commands remain limited by Bot defaults. This chat can only reduce access.")
        }
    }

    private func optionSection(
        title: String,
        description: String,
        options: [AidenBotCapabilityOption],
        keyPath: WritableKeyPath<AidenBotChatAccessDraft, Set<String>>,
        ceiling: Set<String>?
    ) -> some View {
        Section {
            if options.isEmpty {
                Text("None configured on this Mac").foregroundStyle(palette.secondary)
            } else {
                ForEach(options) { option in
                    Toggle(isOn: optionBinding(
                        option.id,
                        available: option.available,
                        options: options,
                        keyPath: keyPath,
                        ceiling: ceiling
                    )) {
                        optionLabel(option.label, description: option.description, available: option.available)
                    }
                    .disabled(!(model.draft?.optionAllowed(option.id, in: options, botAllowedIDs: ceiling) ?? false)
                        && model.draft?[keyPath: keyPath].contains(option.id) != true)
                }
            }
        } header: { Text(title) } footer: { Text(description) }
    }

    private func optionLabel(_ title: String, description: String?, available: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(optionTitle(title, available: available))
            if let description, !description.isEmpty {
                Text(description).font(.caption).foregroundStyle(palette.secondary)
            }
        }
    }

    private func optionTitle(_ title: String, available: Bool) -> String {
        available ? title : "\(title) — Unavailable"
    }

    private func optionBinding(
        _ id: String,
        available: Bool,
        options: [AidenBotCapabilityOption],
        keyPath: WritableKeyPath<AidenBotChatAccessDraft, Set<String>>,
        ceiling: Set<String>?
    ) -> Binding<Bool> {
        Binding(
            get: { model.draft?[keyPath: keyPath].contains(id) == true },
            set: { enabled in
                guard var draft = model.draft,
                      !enabled || draft.optionAllowed(id, in: options, botAllowedIDs: ceiling) else { return }
                if enabled { draft[keyPath: keyPath].insert(id) }
                else { draft[keyPath: keyPath].remove(id) }
                model.draft = draft
            }
        )
    }

    private func fileBinding(
        _ id: String,
        catalog: AidenBotCapabilityCatalog,
        bot: AidenBotDetail
    ) -> Binding<Bool> {
        Binding(
            get: { model.draft?.fileScopeIDs.contains(id) == true },
            set: { enabled in
                guard var draft = model.draft,
                      !enabled || draft.fileScopeAllowed(id, catalog: catalog, botAccess: bot.access) else { return }
                if enabled { draft.fileScopeIDs.insert(id) }
                else { draft.fileScopeIDs.remove(id) }
                model.draft = draft
            }
        )
    }

    private func shellBinding(
        catalog: AidenBotCapabilityCatalog,
        bot: AidenBotDetail
    ) -> Binding<Bool> {
        Binding(
            get: { model.draft?.shellEnabled ?? false },
            set: { enabled in
                guard var draft = model.draft,
                      !enabled || (catalog.shellAvailable && bot.access.custom?.shellEnabled != false) else { return }
                draft.shellEnabled = enabled
                model.draft = draft
            }
        )
    }

    private func providerBinding(
        catalog: AidenBotCapabilityCatalog,
        bot: AidenBotDetail
    ) -> Binding<String> {
        Binding(
            get: { model.draft?.providerID ?? "" },
            set: { id in
                guard var draft = model.draft else { return }
                draft.selectProvider(id, catalog: catalog, botAccess: bot.access)
                model.draft = draft
            }
        )
    }

    private func modelBinding(
        catalog: AidenBotCapabilityCatalog,
        bot: AidenBotDetail
    ) -> Binding<String> {
        Binding(
            get: { model.draft?.modelID ?? "" },
            set: { id in
                guard var draft = model.draft,
                      let provider = catalog.providers.first(where: { $0.id == draft.providerID }),
                      provider.models.contains(where: { $0.id == id && $0.available }),
                      bot.access.custom?.modelId == nil || bot.access.custom?.modelId == id else { return }
                draft.modelID = id
                model.draft = draft
            }
        )
    }
}

@MainActor
@Observable
final class AidenBotConversationFilesModel {
    let grant: AidenBotConversationFileGrant
    var index: AidenWorkspaceFileIndex?
    var document: AidenWorkspaceFileDocument?
    var draft = ""
    var isLoading = false
    var isSaving = false
    var errorMessage: String?

    init(grant: AidenBotConversationFileGrant) { self.grant = grant }

    func load(coordinator: AidenRemoteCoordinator) async {
        guard !isLoading, coordinator.isCurrent(grant.context) else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let client = try coordinator.remoteClient(for: grant.context)
            async let accessRequest = client.botChatAccess(chatId: grant.chatID)
            async let botRequest = client.bot(id: grant.botID)
            async let catalogRequest = client.botCapabilityCatalog()
            async let filesRequest = client.botConversationFiles(chatId: grant.chatID)
            let (access, bot, catalog, files) = try await (
                accessRequest, botRequest, catalogRequest, filesRequest
            )
            guard coordinator.isCurrent(grant.context),
                  access.chatId == grant.chatID,
                  access.botId == grant.botID,
                  access.revision == grant.chatAccessRevision,
                  access.botPolicyRevision == grant.botPolicyRevision,
                  bot.id == grant.botID,
                  bot.access.revision == grant.botPolicyRevision,
                  catalog.revision == grant.catalogRevision,
                  AidenBotChatAccessPresentation.hasFiles(
                      botAccess: bot.access,
                      chatAccess: access,
                      catalog: catalog
                  ) else {
                throw AidenRemoteClientError.invalidResponse
            }
            index = files
        } catch is CancellationError {
            return
        } catch {
            await handle(error, coordinator: coordinator)
        }
    }

    func open(_ entry: AidenWorkspaceFileEntry, coordinator: AidenRemoteCoordinator) async -> Bool {
        guard entry.kind == .file, coordinator.isCurrent(grant.context) else { return false }
        errorMessage = nil
        do {
            let client = try coordinator.remoteClient(for: grant.context)
            try await validateAccess(client: client, coordinator: coordinator, requiresWrite: false)
            let value = try await client.botConversationFile(chatId: grant.chatID, fileId: entry.id)
            guard coordinator.isCurrent(grant.context), index?.entries.contains(entry) == true else { return false }
            document = value
            draft = value.content
            return true
        } catch is CancellationError {
            return false
        } catch {
            await handle(error, coordinator: coordinator)
            return false
        }
    }

    func save(coordinator: AidenRemoteCoordinator) async -> Bool {
        guard grant.allowsWrites, coordinator.connectionState == .connected,
              coordinator.isCurrent(grant.context), !isSaving, let document else { return false }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            let client = try coordinator.remoteClient(for: grant.context)
            try await validateAccess(client: client, coordinator: coordinator, requiresWrite: true)
            let saved = try await client.writeBotConversationFile(
                chatId: grant.chatID,
                fileId: document.id,
                content: draft,
                expectedVersion: document.version
            )
            guard coordinator.isCurrent(grant.context), self.document?.version == document.version else { return false }
            self.document = saved
            draft = saved.content
            return true
        } catch is CancellationError {
            return false
        } catch {
            await handle(error, coordinator: coordinator)
            return false
        }
    }

    func reloadDocument(coordinator: AidenRemoteCoordinator) async {
        guard let document,
              let entry = index?.entries.first(where: { $0.id == document.id }) else { return }
        _ = await open(entry, coordinator: coordinator)
    }

    private func validateAccess(
        client: AidenRemoteClient,
        coordinator: AidenRemoteCoordinator,
        requiresWrite: Bool
    ) async throws {
        async let accessRequest = client.botChatAccess(chatId: grant.chatID)
        async let botRequest = client.bot(id: grant.botID)
        async let catalogRequest = client.botCapabilityCatalog()
        let (access, bot, catalog) = try await (accessRequest, botRequest, catalogRequest)
        guard coordinator.isCurrent(grant.context),
              access.chatId == grant.chatID,
              access.botId == grant.botID,
              access.revision == grant.chatAccessRevision,
              access.botPolicyRevision == grant.botPolicyRevision,
              bot.id == grant.botID,
              bot.access.revision == grant.botPolicyRevision,
              catalog.revision == grant.catalogRevision,
              (!requiresWrite || bot.health == .ready),
              AidenBotChatAccessPresentation.hasFiles(
                  botAccess: bot.access,
                  chatAccess: access,
                  catalog: catalog
              ) else {
            throw AidenRemoteClientError.invalidResponse
        }
    }

    private func handle(_ error: Error, coordinator: AidenRemoteCoordinator) async {
        if await coordinator.handleCredentialRevocation(error, context: grant.context) {
            index = nil
            document = nil
            draft = ""
            return
        }
        guard coordinator.isCurrent(grant.context) else { return }
        if case AidenRemoteClientError.server(_, let body) = error,
           body.code.rawValue == "revision_conflict" {
            errorMessage = "This file changed on the Mac. Reload it before saving again."
        } else if error is AidenRemoteClientError {
            errorMessage = "Files access changed. Return to the chat and open Files again."
        } else {
            errorMessage = error.localizedDescription
        }
    }
}

private struct AidenBotFilePresentation: Identifiable {
    let id: String
}

struct AidenBotConversationFilesView: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var coordinator: AidenRemoteCoordinator
    let grant: AidenBotConversationFileGrant
    @State private var model: AidenBotConversationFilesModel
    @State private var search = ""
    @State private var selectedFile: AidenBotFilePresentation?

    init(coordinator: AidenRemoteCoordinator, grant: AidenBotConversationFileGrant) {
        self.coordinator = coordinator
        self.grant = grant
        _model = State(initialValue: AidenBotConversationFilesModel(grant: grant))
    }

    private var entries: [AidenWorkspaceFileEntry] {
        let values = model.index?.entries ?? []
        guard !search.isEmpty else { return values }
        return values.filter { $0.displayPath.localizedCaseInsensitiveContains(search) }
    }

    private var showsFileError: Binding<Bool> {
        Binding(
            get: { model.errorMessage != nil && selectedFile == nil },
            set: { if !$0 { model.errorMessage = nil } }
        )
    }

    var body: some View {
        fileList
            .overlay { fileOverlay }
            .navigationTitle("Files")
            .searchable(text: $search, prompt: "Find a file")
            .refreshable { await model.load(coordinator: coordinator) }
            .task { await model.load(coordinator: coordinator) }
            .sheet(item: $selectedFile) { _ in
                AidenBotConversationFileEditorView(coordinator: coordinator, model: model)
            }
            .alert("Files", isPresented: showsFileError) {
                Button("OK", role: .cancel) { model.errorMessage = nil }
            } message: {
                Text(model.errorMessage ?? "The file operation failed.")
            }
    }

    private var fileList: some View {
        List {
            if coordinator.connectionState != .connected {
                Section {
                    Label("Offline — reconnect to view files.", systemImage: "wifi.slash")
                        .foregroundStyle(palette.secondary)
                }
            }
            if let index = model.index, index.truncated {
                Section {
                    Label("This bounded file list may be incomplete.", systemImage: "exclamationmark.triangle")
                }
            }
            Section("Files") {
                ForEach(entries) { entry in
                    fileRow(entry)
                    .disabled(entry.kind != .file || coordinator.connectionState != .connected)
                }
            }
        }
    }

    private func fileRow(_ entry: AidenWorkspaceFileEntry) -> some View {
        Button {
            Task {
                if await model.open(entry, coordinator: coordinator) {
                    selectedFile = AidenBotFilePresentation(id: entry.id)
                }
            }
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name).foregroundStyle(.primary)
                    Text(entry.displayPath)
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
            } icon: {
                Image(systemName: fileSymbol(entry.kind))
            }
        }
    }

    private func fileSymbol(_ kind: AidenWorkspaceFileKind) -> String {
        switch kind {
        case .directory: "folder"
        case .symlink: "link"
        case .file: "doc.text"
        }
    }

    @ViewBuilder
    private var fileOverlay: some View {
            if model.isLoading && model.index == nil { ProgressView("Loading files…") }
            else if !model.isLoading, model.index?.entries.isEmpty == true {
                ContentUnavailableView(
                    "No Files Yet",
                    systemImage: "folder",
                    description: Text("Files this Bot creates for your chats appear here.")
                )
            }
    }
}

private struct AidenBotConversationFileEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var coordinator: AidenRemoteCoordinator
    @Bindable var model: AidenBotConversationFilesModel
    @State private var isConfirmingDiscard = false

    private var isDirty: Bool { model.document.map { $0.content != model.draft } ?? false }

    var body: some View {
        NavigationStack {
            Group {
                if model.grant.allowsWrites {
                    TextEditor(text: $model.draft)
                } else {
                    ScrollView {
                        Text(model.draft)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8)
                    }
                    .accessibilityLabel("Read only file")
                }
            }
                .font(.system(.body, design: .monospaced))
                .padding(.horizontal, 8)
                .navigationTitle(model.document?.displayPath ?? "File")
                .navigationBarTitleDisplayMode(.inline)
                .safeAreaInset(edge: .bottom) {
                    if !model.grant.allowsWrites {
                        Label("Read Only", systemImage: "lock.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(.regularMaterial)
                    } else if coordinator.connectionState != .connected {
                        Label("Offline — reconnect to save changes.", systemImage: "wifi.slash")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding()
                            .frame(maxWidth: .infinity)
                            .background(.regularMaterial)
                    } else if let message = model.errorMessage {
                        VStack(spacing: 8) {
                            Text(message).font(.footnote).foregroundStyle(.secondary)
                            if message.contains("changed on the Mac") {
                                Button("Reload from Mac") {
                                    Task { await model.reloadDocument(coordinator: coordinator) }
                                }
                            }
                        }
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(.regularMaterial)
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") {
                            if isDirty && model.grant.allowsWrites { isConfirmingDiscard = true }
                            else { dismiss() }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.isSaving ? "Saving…" : "Save") {
                            Task { _ = await model.save(coordinator: coordinator) }
                        }
                        .disabled(!isDirty || model.isSaving || !model.grant.allowsWrites
                            || coordinator.connectionState != .connected)
                    }
                }
        }
        .interactiveDismissDisabled(isDirty && model.grant.allowsWrites)
        .confirmationDialog("Discard unsaved changes?", isPresented: $isConfirmingDiscard) {
            Button("Discard Changes", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
    }
}
