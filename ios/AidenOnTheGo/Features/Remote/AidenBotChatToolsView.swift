import Observation
import SwiftUI

enum AidenBotChatSheet: Identifiable {
    case profile(AidenBotSummary)
    case files(AidenBotConversationFileGrant)

    var id: String {
        switch self {
        case .profile(let bot): "profile-\(bot.id)"
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

enum AidenBotFilesPresentation {
    /// A Bot has Files when its access includes at least one file location.
    static func hasFiles(botAccess: AidenBotAccessView, catalog: AidenBotCapabilityCatalog) -> Bool {
        if let custom = botAccess.custom {
            return !custom.fileScopeIds.isEmpty
        }
        return catalog.fileScopes.contains(where: \.available)
    }
}

private struct AidenBotChatToolsLoadIdentity: Equatable {
    let context: AidenRemoteRequestContext
    let botID: String
}

/// Authority for one Files sheet: the Bot's access and catalog revisions it
/// was opened under. A revision change closes reads and writes.
struct AidenBotConversationFileGrant: Equatable {
    let context: AidenRemoteRequestContext
    let chatID: String
    let botID: String
    let botPolicyRevision: String
    let catalogRevision: String
    let allowsWrites: Bool
}

/// The Bot identity and access a Bot chat needs for its header, Profile,
/// Files, and image handling.
@MainActor
@Observable
final class AidenBotChatToolsModel {
    let chatID: String
    let botID: String
    var bot: AidenBotDetail?
    var catalog: AidenBotCapabilityCatalog?
    var isLoading = false
    var errorMessage: String?

    private var loadIdentity: AidenBotChatToolsLoadIdentity?
    private var loadToken: UUID?
    private let cache: AidenBotCache

    init(chatID: String, botID: String, cache: AidenBotCache = .shared) {
        self.chatID = chatID
        self.botID = botID
        self.cache = cache
    }

    var hasFiles: Bool {
        guard let bot, let catalog, bot.health != .unavailable else { return false }
        return AidenBotFilesPresentation.hasFiles(botAccess: bot.access, catalog: catalog)
    }

    func fileGrant(
        coordinator: AidenRemoteCoordinator,
        hostAllowsMutations: Bool
    ) -> AidenBotConversationFileGrant? {
        guard hasFiles, let identity = loadIdentity, let bot, let catalog else { return nil }
        return AidenBotConversationFileGrant(
            context: identity.context,
            chatID: chatID,
            botID: botID,
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
        if let installation = coordinator.installationStore.activeInstallation,
           let cached = await cache.load(
               instanceId: installation.id,
               deviceId: installation.deviceId
           ), loadToken == token,
           coordinator.installationStore.activeInstallation?.id == installation.id,
           coordinator.installationStore.activeInstallation?.deviceId == installation.deviceId {
            bot = cached.details.first(where: { $0.id == botID })
            catalog = cached.catalog(forBotID: botID)
        }
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            async let botRequest = client.bot(id: botID)
            async let catalogRequest = client.botCapabilityCatalog(botId: botID)
            let (loadedBot, loadedCatalog) = try await (botRequest, catalogRequest)
            guard loadToken == token, coordinator.isCurrent(context), loadedBot.id == botID else {
                throw AidenRemoteClientError.invalidResponse
            }
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                let existing = await cache.load(
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
                var details = existing?.details ?? []
                details.removeAll { $0.id == loadedBot.id }
                details.append(loadedBot)
                _ = try? await cache.mergeAndStore(
                    AidenBotCacheSegments(details: details, catalogsByBotID: [botID: loadedCatalog]),
                    instanceId: context.instanceId,
                    deviceId: context.deviceId
                )
            }
            guard retained, loadToken == token, coordinator.isCurrent(context) else {
                throw CancellationError()
            }
            loadIdentity = AidenBotChatToolsLoadIdentity(context: context, botID: botID)
            bot = loadedBot
            catalog = loadedCatalog
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
            loadIdentity = nil
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
        errorMessage = nil
        clearLoadedState()
    }

    private func clearLoadedState() {
        loadToken = nil
        isLoading = false
        loadIdentity = nil
        bot = nil
        catalog = nil
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
            async let botRequest = client.bot(id: grant.botID)
            async let catalogRequest = client.botCapabilityCatalog(botId: grant.botID)
            async let filesRequest = client.botConversationFiles(chatId: grant.chatID)
            let (bot, catalog, files) = try await (botRequest, catalogRequest, filesRequest)
            guard coordinator.isCurrent(grant.context),
                  bot.id == grant.botID,
                  bot.access.revision == grant.botPolicyRevision,
                  catalog.revision == grant.catalogRevision,
                  AidenBotFilesPresentation.hasFiles(botAccess: bot.access, catalog: catalog) else {
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
        async let botRequest = client.bot(id: grant.botID)
        async let catalogRequest = client.botCapabilityCatalog(botId: grant.botID)
        let (bot, catalog) = try await (botRequest, catalogRequest)
        guard coordinator.isCurrent(grant.context),
              bot.id == grant.botID,
              bot.access.revision == grant.botPolicyRevision,
              catalog.revision == grant.catalogRevision,
              (!requiresWrite || bot.health == .ready),
              AidenBotFilesPresentation.hasFiles(botAccess: bot.access, catalog: catalog) else {
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
            errorMessage = "This file changed on your Mac. Reload it before saving again."
        } else if error is AidenRemoteClientError {
            errorMessage = "Something changed on your Mac. Go back to the chat and open Files again."
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
                            if message.contains("changed on the paired desktop") {
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
