import AVFoundation
import AVKit
import Accessibility
import CryptoKit
import ImageIO
import MarkdownUI
import Observation
import Photos
import SwiftUI
import UIKit
import UniformTypeIdentifiers


private struct AidenBotHeaderNameGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(palette.raised, in: Capsule())
        } else {
            content.glassEffect(.regular.interactive(), in: Capsule())
        }
    }
}

private extension View {
    func aidenBotHeaderNameGlass() -> some View {
        modifier(AidenBotHeaderNameGlassModifier())
    }
}

@MainActor
@Observable
final class AidenWorkspaceChatsModel {
    private var presentationGenerations: [String: UInt64] = [:]
    private let coordinator: AidenRemoteCoordinator
    private let workspaceId: String
    private let cache: AidenChatCache
    private let hapticScope: UUID
    private let onChatUpdated: @MainActor (AidenChat) -> Void
    private let onChatRemoved: @MainActor (String) -> Void
    private(set) var chats: [AidenChat] = []
    private(set) var isLoading = false
    private(set) var isMutating = false
    var presentedError: String?

    init(
        coordinator: AidenRemoteCoordinator,
        workspaceId: String,
        hapticScope: UUID = UUID(),
        cache: AidenChatCache = .shared,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in }
    ) {
        self.coordinator = coordinator
        self.workspaceId = workspaceId
        self.hapticScope = hapticScope
        self.cache = cache
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
    }

    var isConnected: Bool { coordinator.connectionState == .connected }

    func setHapticsActive(_ active: Bool) {
        if active {
            coordinator.haptics.activate(scope: hapticScope)
        } else {
            coordinator.haptics.deactivate(scope: hapticScope)
        }
    }

    func accept(_ chat: AidenChat) {
        guard chat.workspaceId == workspaceId, !chat.isBotChat else { return }
        upsert(chat)
    }

    func load() async {
        guard let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        let metadataWriteToken = cache.reserveChatWrite()
        if chats.isEmpty, let cached = await cache.admittedWorkspaceChats(instanceId: instanceId, workspaceId: workspaceId) {
            guard coordinator.isCurrent(context) else { return }
            var presented: [AidenChat] = []
            for row in AidenChat.regularWorkspaceChats(from: cached) {
                if let current = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: row.id) { presented.append(current) }
            }
            guard coordinator.isCurrent(context) else { return }
            chats = Self.sorted(presented)
        }
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let remote = try await coordinator.remoteClient(for: context).chats(workspaceId: workspaceId)
            guard coordinator.isCurrent(context) else { return }
            // Commit before publishing: a held list response may have lost to a
            // detail owner, another list, or removal while HTTP was in flight.
            do {
                try await cache.saveChats(AidenChat.regularWorkspaceChats(from: remote), instanceId: instanceId, workspaceId: workspaceId, writeToken: metadataWriteToken, isAuthoritativeFetch: true)
            } catch {
                // Admission precedes IO; preserve the in-memory winner on disk failure.
            }
            let admitted = await cache.admittedWorkspaceChats(instanceId: instanceId, workspaceId: workspaceId)
            guard coordinator.isCurrent(context) else { return }
            var presented: [AidenChat] = []
            for row in AidenChat.regularWorkspaceChats(from: admitted ?? []) {
                if let current = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: row.id) { presented.append(current) }
            }
            guard coordinator.isCurrent(context) else { return }
            chats = Self.sorted(presented)
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            if chats.isEmpty { presentedError = error.localizedDescription }
        }
    }

    func create() async -> AidenChat? {
        guard !isMutating, let context = try? coordinator.requestContext() else { return nil }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        do {
            let chat = try await coordinator.remoteClient(for: context).createChat(workspaceId: workspaceId)
            guard coordinator.isCurrent(context) else { return nil }
            guard !chat.isBotChat else {
                presentedError = String(localized: "Aiden returned a conversation that is unavailable in Workspaces.")
                return nil
            }
            guard let admitted = await persist(chat: chat, instanceId: instanceId, context: context), coordinator.isCurrent(context) else { return nil }
            onChatUpdated(admitted)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-create:\(chat.id):\(chat.revision)")
            return admitted
        } catch let error where aidenIsCancellation(error) {
            return nil
        } catch {
            guard coordinator.isCurrent(context) else { return nil }
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            return nil
        }
    }

    private func refreshRenameSnapshot(chatId: String, context: AidenRemoteRequestContext) async throws -> AidenChat {
        let token = cache.reserveChatWrite()
        let remote = try await coordinator.remoteClient(for: context).chat(id: chatId)
        guard coordinator.isCurrent(context), remote.id == chatId, remote.workspaceId == workspaceId, !remote.isBotChat else { throw CancellationError() }
        guard try await cache.saveFetchedChat(remote, instanceId: context.instanceId, writeToken: token) else { throw CancellationError() }
        guard coordinator.isCurrent(context),
              let current = await cache.admittedChat(instanceId: context.instanceId, chatId: chatId),
              !(await cache.needsRenameRefresh(instanceId: context.instanceId, chatId: chatId)) else { throw CancellationError() }
        return current
    }

    func rename(_ chat: AidenChat, to title: String) async {
        let cleaned = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, !isMutating, let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        isMutating = true
        defer { isMutating = false }
        // The new title shows in this list at once, as a local override the
        // admitted receipt replaces; Recents and the open chat take the receipt,
        // since only an admitted write may be published. A failed PATCH puts the
        // stored row back unless another owner published since.
        var optimistic = chat
        optimistic.localTitleOverride = cleaned
        upsert(optimistic)
        let optimisticGeneration = presentationGenerations[chat.id] ?? 0
        let rollBackTitle = { [self] in
            guard coordinator.isCurrent(context), optimisticGeneration == (presentationGenerations[chat.id] ?? 0) else { return }
            upsert(chat)
        }
        do {
            let canonical: AidenChat
            let pendingRename = await cache.needsRenameRefresh(instanceId: instanceId, chatId: chat.id)
            if pendingRename || chat.localTitleOverride != nil {
                canonical = try await refreshRenameSnapshot(chatId: chat.id, context: context)
            } else { canonical = chat }
            guard coordinator.isCurrent(context) else { return }
            let origin = cache.reserveChatWrite()
            let generation = presentationGenerations[chat.id] ?? 0
            let updated = try await coordinator.remoteClient(for: context).updateChat(
                id: chat.id, revision: canonical.revision, title: cleaned
            )
            guard coordinator.isCurrent(context) else { return }
            guard updated.id == chat.id, updated.workspaceId == workspaceId, !updated.isBotChat else {
                rollBackTitle()
                return
            }
            let receiptCutoff = cache.reserveChatWrite()
            guard let admitted = await cache.acceptRename(updated, instanceId: instanceId, origin: origin, cutoff: receiptCutoff) else {
                if coordinator.isCurrent(context), generation == (presentationGenerations[chat.id] ?? 0) {
                    chats.removeAll { $0.id == chat.id }
                    presentationGenerations[chat.id, default: 0] &+= 1
                    onChatRemoved(chat.id)
                }
                return
            }
            guard coordinator.isCurrent(context) else { return }
            guard await cache.reconcileWorkspaceChat(admitted, instanceId: instanceId, authority: origin, cutoff: receiptCutoff) else { return }
            let publicationGeneration = presentationGenerations[chat.id] ?? 0
            guard let presentation = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: chat.id) else { return }
            guard coordinator.isCurrent(context), publicationGeneration == (presentationGenerations[chat.id] ?? 0), cache.isChatWriteRetained(origin, instanceId: instanceId, chatId: chat.id) else { return }
            upsert(presentation)
            onChatUpdated(presentation)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-rename:\(updated.id):\(updated.revision)")
            // A failed read must not roll back a successful mutation or replay PATCH.
            let refreshGeneration = presentationGenerations[chat.id] ?? 0
            do {
                let refreshed = try await refreshRenameSnapshot(chatId: chat.id, context: context)
                guard coordinator.isCurrent(context), refreshGeneration == (presentationGenerations[chat.id] ?? 0) else { return }
                guard await cache.reconcileWorkspaceChat(refreshed, instanceId: instanceId, authority: origin, cutoff: receiptCutoff) else { return }
                guard coordinator.isCurrent(context), refreshGeneration == (presentationGenerations[chat.id] ?? 0), cache.isChatWriteRetained(origin, instanceId: instanceId, chatId: chat.id) else { return }
                guard let presentation = await cache.presentedWorkspaceChat(instanceId: instanceId, workspaceId: workspaceId, chatId: chat.id) else { return }
                guard coordinator.isCurrent(context), refreshGeneration == (presentationGenerations[chat.id] ?? 0), cache.isChatWriteRetained(origin, instanceId: instanceId, chatId: chat.id) else { return }
                upsert(presentation)
                onChatUpdated(presentation)
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
            }
        } catch let error where aidenIsCancellation(error) {
            rollBackTitle()
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            rollBackTitle()
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
        }
    }

    func remove(_ chat: AidenChat) async {
        guard !isMutating, let context = try? coordinator.requestContext() else { return }
        let instanceId = context.instanceId
        let metadataWriteToken = cache.reserveChatWrite()
        isMutating = true
        defer { isMutating = false }
        presentationGenerations[chat.id, default: 0] &+= 1
        chats.removeAll { $0.id == chat.id }
        // The row leaves this list and Recents at once; a failed DELETE puts it back.
        onChatRemoved(chat.id)
        do {
            let canonical: AidenChat
            let pendingRename = await cache.needsRenameRefresh(instanceId: instanceId, chatId: chat.id)
            if pendingRename || chat.localTitleOverride != nil {
                canonical = try await refreshRenameSnapshot(chatId: chat.id, context: context)
            } else { canonical = chat }
            guard coordinator.isCurrent(context) else { return }
            try await coordinator.remoteClient(for: context).removeChat(id: chat.id, revision: canonical.revision)
            guard coordinator.isCurrent(context) else { return }
            await cache.removeChat(instanceId: instanceId, chatId: chat.id)
            await AidenChatDraftStore.shared.remove(instanceId: instanceId, chatId: chat.id)
            try? await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId, writeToken: metadataWriteToken)
            onChatRemoved(chat.id)
            coordinator.haptics.play(.success, scope: hapticScope, dedupeKey: "chat-remove:\(chat.id):\(chat.revision)")
        } catch let error where aidenIsCancellation(error) {
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
            onChatUpdated(chat)
        } catch {
            guard coordinator.isCurrent(context) else { return }
            upsert(chat)
            onChatUpdated(chat)
            presentedError = error.localizedDescription
            coordinator.haptics.play(.error, scope: hapticScope)
            await load()
        }
    }

    private func upsert(_ chat: AidenChat) {
        guard !chat.isBotChat else { return }
        presentationGenerations[chat.id, default: 0] &+= 1
        chats.removeAll { $0.id == chat.id }
        chats.append(chat)
        chats = Self.sorted(chats)
    }

    private func persist(chat: AidenChat, instanceId: String, context: AidenRemoteRequestContext) async -> AidenChat? {
        let generation = presentationGenerations[chat.id] ?? 0
        let writeToken = cache.reserveChatWrite()
        do {
            guard try await cache.saveChat(chat, instanceId: instanceId, writeToken: writeToken) else {
                // The winner is admitted in memory even if its disk write failed.
                guard let current = await cache.admittedChat(instanceId: instanceId, chatId: chat.id),
                      current.workspaceId == workspaceId, !current.isBotChat else {
                    if coordinator.isCurrent(context), generation == (presentationGenerations[chat.id] ?? 0) {
                        presentationGenerations[chat.id, default: 0] &+= 1
                        chats.removeAll { $0.id == chat.id }
                        onChatRemoved(chat.id)
                    }
                    return nil
                }
                // The winner may be detail-only (or its file write failed), so
                // keep the created row in the durable list for a cold reopen.
                await cache.admitCreatedWorkspaceChat(chatId: chat.id, instanceId: instanceId, workspaceId: workspaceId, writeToken: writeToken)
                guard generation == (presentationGenerations[chat.id] ?? 0) else { return chats.first { $0.id == chat.id } }
                upsert(current)
                return current
            }
        } catch {
            // Disk failure remains best-effort; a normal fence rejection above
            // instead means another owner invalidated this snapshot. The detail
            // was admitted in memory, so still keep its list row durable.
            await cache.admitCreatedWorkspaceChat(chatId: chat.id, instanceId: instanceId, workspaceId: workspaceId, writeToken: writeToken)
            guard generation == (presentationGenerations[chat.id] ?? 0) else { return chats.first { $0.id == chat.id } }
            upsert(chat)
            return chat
        }
        guard generation == (presentationGenerations[chat.id] ?? 0) else { return chats.first { $0.id == chat.id } }
        upsert(chat)
        let publicationGeneration = presentationGenerations[chat.id] ?? 0
        do {
            try await cache.saveChats(chats, instanceId: instanceId, workspaceId: workspaceId, writeToken: writeToken)
            try await cache.reconcileChatSummary(chat, instanceId: instanceId, writeToken: writeToken)
        } catch {}
        if publicationGeneration == (presentationGenerations[chat.id] ?? 0) {
            upsert(chat)
            return chat
        }
        return chats.first { $0.id == chat.id }
    }

    private static func sorted(_ chats: [AidenChat]) -> [AidenChat] {
        chats.sorted {
            if $0.updatedAt == $1.updatedAt { return $0.id < $1.id }
            return $0.updatedAt > $1.updatedAt
        }
    }
}

struct AidenWorkspaceChatsView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Environment(\.aidenPalette) private var palette
    let workspace: AidenWorkspace
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatRemoved: @MainActor (String) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    @State private var model: AidenWorkspaceChatsModel
    @State private var createdChat: AidenChat?
    @State private var renameChat: AidenChat?
    @State private var renameTitle = ""
    @State private var deleteChat: AidenChat?

    init(
        coordinator: AidenRemoteCoordinator,
        workspace: AidenWorkspace,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatRemoved: @escaping @MainActor (String) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in }
    ) {
        self.coordinator = coordinator
        self.workspace = workspace
        self.onChatUpdated = onChatUpdated
        self.onChatRemoved = onChatRemoved
        self.onChatActivityChanged = onChatActivityChanged
        _model = State(initialValue: AidenWorkspaceChatsModel(
            coordinator: coordinator,
            workspaceId: workspace.id,
            onChatUpdated: onChatUpdated,
            onChatRemoved: onChatRemoved
        ))
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(workspace.name).font(.title2.bold())
                    Label(workspace.permission.detail, systemImage: "checkmark.shield")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 8)
            }

            Section("Chats") {
                if model.chats.isEmpty, !model.isLoading {
                    ContentUnavailableView(
                        "No Chats",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Start a chat in this workspace to control Aiden Agent.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(model.chats) { chat in
                        NavigationLink {
                            AidenForkableChatDetailView(
                                coordinator: coordinator,
                                chat: chat,
                                onChatUpdated: {
                                    model.accept($0)
                                    onChatUpdated($0)
                                },
                                onChatActivityChanged: onChatActivityChanged,
                                onForkOpened: acceptOpenedFork
                            )
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                AidenForkableChatTitle(title: chat.displayTitle, isFork: chat.forkedFrom != nil)
                                AidenRelativeTimestampView(date: chat.updatedAt)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { deleteChat = chat } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button { beginRename(chat) } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            .tint(palette.fillAccent)
                        }
                        .contextMenu {
                            Button { beginRename(chat) } label: { Label("Rename", systemImage: "pencil") }
                            Button(role: .destructive) { deleteChat = chat } label: { Label("Delete", systemImage: "trash") }
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas)
        .overlay { if model.isLoading && model.chats.isEmpty { ProgressView() } }
        .refreshable { await model.load() }
        .task(id: coordinator.activeInstanceId) { await model.load() }
        .navigationDestination(isPresented: Binding(
            get: { createdChat != nil },
            set: { if !$0 { createdChat = nil } }
        )) {
            if let createdChat {
                AidenForkableChatDetailView(
                    coordinator: coordinator,
                    chat: createdChat,
                    onChatUpdated: {
                        model.accept($0)
                        onChatUpdated($0)
                    },
                    onChatActivityChanged: onChatActivityChanged,
                    onForkOpened: acceptOpenedFork
                )
                .id(createdChat.id)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { createdChat = await model.create() }
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .disabled(!model.isConnected || model.isMutating)
                .accessibilityLabel("New chat")
            }
        }
        .alert("Rename Chat", isPresented: Binding(
            get: { renameChat != nil },
            set: { if !$0 { renameChat = nil } }
        )) {
            TextField("Chat title", text: $renameTitle)
            Button("Cancel", role: .cancel) { renameChat = nil }
            Button("Save") {
                guard let chat = renameChat else { return }
                renameChat = nil
                Task { await model.rename(chat, to: renameTitle) }
            }
        }
        .confirmationDialog("Delete this chat?", isPresented: Binding(
            get: { deleteChat != nil },
            set: { if !$0 { deleteChat = nil } }
        ), titleVisibility: .visible) {
            Button("Delete Chat", role: .destructive) {
                guard let chat = deleteChat else { return }
                deleteChat = nil
                Task { await model.remove(chat) }
            }
            Button("Cancel", role: .cancel) { deleteChat = nil }
        } message: {
            Text("This permanently removes the chat from Aiden Agent.")
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil },
            set: { if !$0 { model.presentedError = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil }
        } message: {
            Text(model.presentedError ?? "The operation could not be completed.")
        }
        .onAppear { model.setHapticsActive(true) }
        .onDisappear { model.setHapticsActive(false) }
    }

    private func beginRename(_ chat: AidenChat) {
        renameTitle = chat.displayTitle
        renameChat = chat
    }

    /// Lists the fork; the detail pushes it over its source.
    private func acceptOpenedFork(_ chat: AidenChat) {
        model.accept(chat)
        onChatUpdated(chat)
    }
}

private enum AidenChatAttachmentCoordinateSpace {
    static let name = "aiden-chat-attachment-coordinate-space"
}

private struct AidenAttachmentButtonCenterPreferenceKey: PreferenceKey {
    static let defaultValue: CGPoint? = nil

    static func reduce(value: inout CGPoint?, nextValue: () -> CGPoint?) {
        value = nextValue() ?? value
    }
}

struct AidenChatDetailView: View {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenPalette) private var palette
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AidenChatViewModel
    @State private var sceneRefreshGate = AidenSceneRefreshGate(refreshOnFirstActivation: false)
    @State private var chatLoadEpoch = 0
    @State private var composerHeight: CGFloat = 132
    @State private var botToolsModel: AidenBotChatToolsModel?
    @State private var botSheet: AidenBotChatSheet?
    @State private var isConfirmingBotDelete = false
    @Environment(\.dismiss) private var dismissChat
    @State private var workspaceFileReference: String?
    @State private var showsWorkspaceFile = false
    @State private var progressSheet: AidenProgressSheet?
    @State private var follow = AidenTranscriptFollowController()
    @State private var attachmentPicker = AidenAttachmentPickerState()
    @State private var isFileImporterPresented = false
    @State private var attachmentButtonCenter: CGPoint?
    @FocusState private var composerIsFocused: Bool
    @Namespace private var attachmentMotionNamespace
    @State private var coordinator: AidenRemoteCoordinator?
    @State private var forkSummaryRequest: AidenForkSummaryRequest?
    @State private var simulators = AidenChatSimulatorsModel()
    @State private var simulatorViewer: AidenSimulatorViewerModel?
    @State private var simulatorRefreshEpoch = 0
    @State private var spending = AidenSpendingNoticeModel()
    @State private var backgroundJobs = AidenBackgroundJobsModel()
    @State private var showsBackgroundJobs = false
    let autoStartVoice: Bool
    let allowsMutations: Bool
    /// Opens a chat this one was forked into. Nil hides the fork actions,
    /// for surfaces that cannot navigate to a new Workspace chat.
    private let onOpenChat: (@MainActor (AidenChat) -> Void)?

    init(
        coordinator: AidenRemoteCoordinator,
        chat: AidenChat,
        autoStartVoice: Bool = false,
        allowsMutations: Bool = true,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void = { _ in },
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void = { _, _ in },
        onOpenChat: (@MainActor (AidenChat) -> Void)? = nil
    ) {
        _coordinator = State(initialValue: coordinator)
        self.onOpenChat = onOpenChat
        _model = State(initialValue: AidenChatViewModel(
            coordinator: coordinator,
            chat: chat,
            allowsMutations: allowsMutations,
            onChatUpdated: onChatUpdated,
            onChatActivityChanged: onChatActivityChanged
        ))
        _botToolsModel = State(initialValue: chat.botId.map {
            AidenBotChatToolsModel(chatID: chat.id, botID: $0)
        })
        self.autoStartVoice = autoStartVoice
        self.allowsMutations = allowsMutations
    }

#if DEBUG
    init(readOnlyFixture chat: AidenChat) {
        _coordinator = State(initialValue: nil)
        _model = State(initialValue: AidenChatViewModel(readOnlyFixture: chat))
        _botToolsModel = State(initialValue: nil)
        autoStartVoice = false
        allowsMutations = false
        onOpenChat = nil
    }
#endif

    private var workspace: AidenWorkspace? {
        coordinator?.workspaces.first { $0.id == model.chat.workspaceId }
    }

    private var botToolsSessionIdentity: AidenBotChatToolsSessionIdentity? {
        coordinator.map(AidenBotChatToolsSessionIdentity.init)
    }

    private var botPrimarySupportsImages: Bool? {
        guard let bot = botToolsModel?.bot,
              let selection = bot.modelSelection,
              let catalog = botToolsModel?.catalog else { return nil }
        return catalog.model(
            providerId: selection.providerId,
            modelId: selection.modelId
        )?.supportsImages
    }

    private var effectiveAllowsMutations: Bool {
        guard let botToolsModel else { return allowsMutations }
        return allowsMutations && botToolsModel.bot?.health == .ready
    }

    private var presentationStyle: AidenChatPresentationStyle {
        AidenChatPresentationStyle(chat: model.chat)
    }

    var body: some View {
        chatStack
        .background(palette.canvas.ignoresSafeArea())
        .onPreferenceChange(AidenComposerHeightPreferenceKey.self) { height in
            guard height > 0 else { return }
            composerHeight = height
        }
        .onChange(of: effectiveAllowsMutations, initial: true) { _, allowed in
            model.setAllowsMutations(allowed)
        }
        .onChange(of: reduceMotion, initial: true) { _, reduce in
            model.setPacesStreamingReveal(!reduce)
        }
        .onChange(of: botToolsModel?.bot?.visionModelSelection, initial: true) { _, selection in
            model.setBotVisionModelSelection(selection)
        }
        .onChange(of: botPrimarySupportsImages, initial: true) { _, supportsImages in
            model.setBotPrimarySupportsImages(supportsImages)
        }
        .onChange(of: model.pendingQuestion?.id) { _, id in
            guard id != nil else { return }
            composerIsFocused = false
            attachmentPicker.dismiss()
        }
        .onChange(of: model.isStreaming) { _, isStreaming in
            guard isStreaming else { return }
            attachmentPicker.dismiss()
        }
        .navigationTitle(presentationStyle == .botMessages ? "" : model.chat.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { chatToolbar }
        .task(id: backgroundJobsRefreshKey) {
            // Not pushed: read after each reply settles, and every few seconds
            // while something runs or the list is open. Only while the app
            // is in front: a backgrounded app never polls the Mac.
            guard scenePhase == .active else { return }
            await backgroundJobs.refresh(chatId: model.chat.id, transport: backgroundJobsTransport)
            while !Task.isCancelled, backgroundJobsTransport != nil,
                  backgroundJobs.runningCount > 0 || showsBackgroundJobs {
                try? await Task.sleep(for: .seconds(showsBackgroundJobs ? 3 : 10))
                guard !Task.isCancelled else { return }
                await backgroundJobs.refresh(chatId: model.chat.id, transport: backgroundJobsTransport)
            }
        }
        .task(id: newWorktreeRefreshKey) {
            await model.refreshNewWorktreeRepository()
        }
        .task(id: spendingRefreshKey) {
            await spending.refresh(owner: spendingOwner, transport: spendingTransport)
        }
        .task(id: chatLoadEpoch) {
            // Loads on appear and after each return from the background. A
            // newer epoch cancels an older load still in flight.
            guard scenePhase != .background else { return }
            await model.reload(observeProgress: true)
        }
        .onChange(of: coordinator?.connectionState) { old, new in
            // A chat opened from its saved copy while connecting reloads once
            // the Mac answers, so the transcript and read state reconcile.
            if new == .connected, old != .connected { chatLoadEpoch &+= 1 }
        }
        .task(id: coordinator?.server?.serverTime) {
            guard scenePhase == .active else { return }
            model.startProgressObservation()
        }
        .task(id: botToolsSessionIdentity) {
            model.readAloud.stop()
            guard let coordinator, let botToolsModel else { return }
            botToolsModel.resetForSessionChange()
            await botToolsModel.load(coordinator: coordinator)
        }
        .environment(\.openURL, OpenURLAction { url in
            let raw = url.relativeString
            if AidenWorkspaceFileLink.path(raw) != nil, model.chat.botId == nil, workspace?.hasFolder == true {
                workspaceFileReference = raw
                showsWorkspaceFile = true
                return .handled
            }
            if url.isFileURL || raw.hasPrefix("/") || raw.hasPrefix("./") || raw.hasPrefix("../") || raw.hasPrefix("~/") { return .discarded }
            return .systemAction
        })
        .sheet(isPresented: $showsWorkspaceFile) {
            if let coordinator, let workspace {
                NavigationStack { AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace, initialReference: workspaceFileReference) }
            }
        }
        .sheet(item: $botSheet) { botSheetContent($0) }
        .sheet(item: $progressSheet) { progressSheet in
            AidenChatProgressSheet(kind: progressSheet, model: model)
        }
        .sheet(isPresented: $showsBackgroundJobs) {
            AidenBackgroundJobsSheet(
                model: backgroundJobs,
                canStop: allowsMutations && coordinator?.server?.capabilities.contains(.chatWrite) == true,
                onStop: { jobId in Task { await backgroundJobs.stop(jobId, transport: backgroundJobsTransport) } }
            )
        }
        .sheet(item: $forkSummaryRequest) { request in
            AidenForkSummarySheet { focus in
                performFork(messageID: request.id, action: .forkWithSummary, focus: focus)
            }
        }
        .task(id: simulatorRefreshKey) {
            // Once when the chat opens, again after each return to the
            // foreground (chatLoadEpoch) and when the viewer closes. No polling.
            guard scenePhase != .background else { return }
            await simulators.refresh(coordinator: coordinator, chatId: model.chat.id)
        }
        .fullScreenCover(item: $simulatorViewer, onDismiss: {
            simulatorRefreshEpoch &+= 1
        }) { viewer in
            AidenSimulatorViewer(model: viewer)
        }
        .task(id: model.chat.forkedFrom?.chatId) {
            await model.resolveForkSource()
        }
        .task(id: model.chat.forkedFrom?.summary?.state) {
            await model.observePendingForkSummary()
        }
        .alert("Aiden On The Go", isPresented: Binding(
            get: { model.presentedError != nil || model.readAloud.errorMessage != nil },
            set: { if !$0 { model.presentedError = nil; model.readAloud.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.presentedError = nil; model.readAloud.errorMessage = nil }
        } message: {
            Text(model.presentedError ?? model.readAloud.errorMessage ?? "The operation could not be completed.")
        }
        .aidenBotDeleteConfirmation(
            isPresented: $isConfirmingBotDelete,
            botName: botToolsModel?.bot?.name ?? model.chat.title
        ) {
            deleteBotFromChat()
        }
        .onAppear {
            model.setHapticsActive(true)
            model.setChatForegrounded(true)
            model.setSceneActive(scenePhase == .active)
            if scenePhase == .background { _ = sceneRefreshGate.transition(to: .background) }
        }
        .onChange(of: model.readAloudCandidateID) { _, candidate in
            if let active = model.readAloud.activeMessageID, active != candidate { model.readAloud.stop() }
        }
        .onChange(of: scenePhase) { _, phase in
            model.setSceneActive(phase == .active)
            if phase != .active {
                model.readAloud.stop()
            }
            switch sceneRefreshGate.transition(to: phase) {
            case .refresh:
                chatLoadEpoch &+= 1
            case .resume:
                model.startProgressObservation()
            case .suspend:
                model.stopProgressObservation()
                // The return to the foreground reloads and re-arms it.
                model.stopVisualSnapshotRefresh()
            case .none:
                // `.inactive` is transient; progress keeps streaming.
                break
            }
        }
        .onDisappear {
            model.readAloud.stop()
            model.setHapticsActive(false)
            model.setChatForegrounded(false)
            model.stopProgressObservation()
            attachmentPicker.reset()
        }
    }

    private var chatStack: some View {
        ZStack(alignment: .bottom) {
            transcript
            composer
            AidenAttachmentPickerOverlay(
                picker: attachmentPicker,
                motionNamespace: attachmentMotionNamespace,
                attachmentCapacity: attachmentCapacity,
                canChoosePhotos: model.acceptsImageAttachments,
                isBotChat: model.chat.isBotChat,
                isBusy: attachmentControlsAreBusy,
                attachmentButtonCenter: attachmentButtonCenter,
                onUnavailableBotPhotos: { model.requestBotVisionSetup() },
                onChooseFiles: { isFileImporterPresented = true },
                onCaptureCameraPhoto: commitCapturedPhoto,
                onCommitPhotos: commitSelectedPhotos
            )
            .allowsHitTesting(attachmentPicker.isPresented)
            .accessibilityHidden(!attachmentPicker.isPresented)
            .zIndex(20)
        }
        .coordinateSpace(name: AidenChatAttachmentCoordinateSpace.name)
        .onPreferenceChange(AidenAttachmentButtonCenterPreferenceKey.self) { center in
            attachmentButtonCenter = center
        }
        .animation(
            AidenAttachmentPickerPresentationMotion.transition(
                isPresented: attachmentPicker.isPresented,
                reduceMotion: reduceMotion
            ),
            value: attachmentPicker.isPresented
        )
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: allowedAttachmentContentTypes,
            allowsMultipleSelection: true
        ) { result in
            model.prepareAttachments(result) { url in
                try await AidenAttachmentPreparation.fileUploadAsync(url: url)
            }
        }
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                messageList(proxy)
                    .background {
                        AidenChatScrollObserver(
                            onFollowEvent: { follow.handle($0) },
                            onMetrics: { follow.updateMetrics($0) }
                        )
                    }
            }
            .defaultScrollAnchor(
                AidenChatScrollPolicy.initialTranscriptAnchor,
                for: .initialOffset
            )
            .defaultScrollAnchor(
                AidenChatScrollPolicy.sizeChangeAnchor(shouldFollowLatest: follow.isFollowing),
                for: .sizeChanges
            )
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(
                TapGesture().onEnded { composerIsFocused = false }
            )
            .background {
                // A leaf reads the per-tick trigger, so a reveal tick re-snaps
                // a following reader without re-running this screen.
                AidenStreamingFollowTrigger(trigger: { model.streamingScrollTrigger }) {
                    followLatest(proxy, animated: false)
                }
            }
            .overlay(alignment: .bottom) {
                if follow.showsJumpButton {
                    AidenChatJumpToLatestButton {
                        jumpToLatest(proxy)
                    }
                    .padding(.bottom, composerHeight + 10)
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: follow.showsJumpButton)
            .onAppear { follow.setStreaming(model.isStreaming) }
            .onChange(of: model.isStreaming) { _, streaming in
                follow.setStreaming(streaming)
            }
            .onChange(of: model.explicitSendCount) { _, _ in
                jumpToLatest(proxy)
            }
            .onChange(of: model.chat.messages.count) { _, _ in
                followLatest(proxy, animated: false)
            }
            .onChange(of: model.pendingApproval?.id) { _, approvalID in
                guard approvalID != nil else { return }
                composerIsFocused = false
                followLatest(proxy, animated: true)
            }
        }
    }

    private func messageList(_ proxy: ScrollViewProxy) -> some View {
        LazyVStack(
            alignment: .leading,
            spacing: presentationStyle == .botMessages ? 3 : 18
        ) {
            if let forkLabel = model.forkSource.label {
                AidenChatForkLineageRow(label: forkLabel)
            }
            if model.hasOlderMessages {
                AidenLoadEarlierMessagesButton(isLoading: model.isLoadingEarlierMessages) {
                    loadEarlierMessages(proxy)
                }
            }
            // Settled rows live in a child view that tracks only `chat`, so
            // per-token liveText updates never re-evaluate finished messages.
            // `chat` is a value snapshot: comparing model.chat would read the
            // same live property on both sides of == and never differ.
            AidenSettledMessageRows(
                model: model,
                chat: model.chat,
                presentationStyle: presentationStyle,
                readAloudCandidateID: model.readAloudCandidateID,
                readAloudActiveID: model.readAloud.activeMessageID,
                renderIDs: model.messageRenderIDs,
                imageArrivalRevealIDs: model.imageArrivalRevealGenerationIDs,
                appControlsAvailable: model.canReadAppControls,
                onAskAbout: model.isReadOnlyPresentation ? nil : { selection in
                    if model.askAbout(selection) { composerIsFocused = true }
                },
                forkAvailability: onOpenChat == nil ? nil : model.forkAvailability,
                onFork: onOpenChat == nil ? nil : { messageID, action in
                    if action == .forkWithSummary {
                        forkSummaryRequest = AidenForkSummaryRequest(id: messageID)
                    } else {
                        performFork(messageID: messageID, action: action)
                    }
                },
                canSettleForkSummary: model.canSettleForkSummary,
                isSettlingForkSummary: model.isSettlingForkSummary,
                visualViewerAvailable: model.supportsVisualViewer,
                onVisualPrompt: model.isReadOnlyPresentation ? nil : { (prompt: String) -> Void in
                    _ = model.appendVisualPrompt(prompt)
                },
                browserRecordingsAvailable: model.supportsBrowserRecordings
            )
            .equatable()
            if model.showsLiveResponse {
                AidenLiveResponseView(model: model, presentationStyle: presentationStyle)
            }
            Color.clear
                .frame(height: max(96, composerHeight + 12))
                .accessibilityHidden(true)
            Color.clear.frame(height: 1).id(AidenChatScrollPolicy.transcriptBottomAnchorID)
        }
        .padding(.horizontal)
        .padding(.top, 20)
    }

    private func performFork(messageID: String, action: AidenChatForkMenuAction, focus: String = "") {
        guard let onOpenChat else { return }
        Task { @MainActor in
            guard let forked = await model.fork(
                messageId: messageID,
                action: action,
                summaryFocus: focus
            ) else { return }
            onOpenChat(forked)
        }
    }

    private var simulatorRefreshKey: String {
        let available = coordinator.map(AidenChatSimulatorsModel.isAvailable(coordinator:)) ?? false
        return "\(model.chat.id)|\(chatLoadEpoch)|\(simulatorRefreshEpoch)|\(available)"
    }

    /// Revision 47: a Workspace chat's total, or a Bot chat's month.
    private var spendingOwner: AidenSpendingOwner {
        model.chat.botId.map(AidenSpendingOwner.bot) ?? .chat(model.chat.id)
    }

    private var spendingTransport: AidenSpendingTransport? {
        guard let coordinator, coordinator.server?.supportsSpendingLimits == true else { return nil }
        return try? coordinator.remoteClient()
    }

    /// Revision 49: a Workspace chat's background jobs, once this phone holds `chat:jobs`.
    private var backgroundJobsTransport: AidenBackgroundJobTransport? {
        guard !model.chat.isBotChat, let coordinator,
              coordinator.server?.capabilities.contains(.chatJobs) == true else { return nil }
        return try? coordinator.remoteClient()
    }

    private var backgroundJobsRefreshKey: String {
        [
            model.chat.id,
            coordinator?.activeInstanceId ?? "",
            String(coordinator?.server?.capabilities.contains(.chatJobs) == true),
            String(model.isStreaming),
            String(model.chat.messages.count),
            String(chatLoadEpoch),
            String(showsBackgroundJobs),
            String(scenePhase == .active),
        ].joined(separator: "|")
    }

    /// Revision 53: New worktree sits beside the composer's chips until the
    /// chat's first message, and stays hidden while that message is on its way.
    private var showsNewWorktreeChip: Bool {
        allowsMutations && model.offersNewWorktree && !model.isSettingUpWorktree
    }

    private var newWorktreeRefreshKey: String {
        [
            model.chat.id,
            model.chat.workspaceId,
            coordinator?.activeInstanceId ?? "",
            String(coordinator?.server?.capabilities.contains(.chatNewWorktree) == true),
        ].joined(separator: "|")
    }

    /// Re-read after each reply settles and after a send the Mac refused.
    private var spendingRefreshKey: String {
        [
            model.chat.id,
            coordinator?.activeInstanceId ?? "",
            String(coordinator?.server?.supportsSpendingLimits == true),
            String(model.isStreaming),
            String(model.chat.messages.count),
            model.sendRecoveryMessage ?? "",
        ].joined(separator: "|")
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if let current = spending.spending, allowsMutations {
                AidenSpendingNotice(
                    spending: current,
                    botName: nil,
                    isAllowing: spending.isAllowing,
                    canAllow: coordinator?.server?.capabilities.contains(model.chat.isBotChat ? .botWrite : .chatWrite) == true,
                    errorMessage: spending.errorMessage,
                    onAllowMore: { Task { await spending.allowMore(transport: spendingTransport) } }
                )
            }
            if let message = model.sendRecoveryMessage {
                VStack(alignment: .leading, spacing: 8) {
                    Text(message).font(.footnote).accessibilityAddTraits(.updatesFrequently)
                    HStack {
                        Button("Retry message") { Task { await model.send(retry: true) } }.disabled(!model.canRetrySend)
                        Button("I checked — dismiss") { Task { await model.discardPendingSend() } }
                    }.font(.footnote)
                }.padding(12).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16)).padding(.bottom, 8)
            }
            if model.isSettingUpWorktree {
                AidenNewWorktreeSetupRow { model.cancelWorktreeSetup() }
            }
            if simulators.deviceCount > 0 || backgroundJobs.runningCount > 0 || showsNewWorktreeChip {
                HStack(spacing: 8) {
                    if simulators.deviceCount > 0 {
                        AidenSimulatorDeviceButton(count: simulators.deviceCount) {
                            simulatorViewer = simulators.makeViewer(coordinator: coordinator)
                        }
                    }
                    AidenBackgroundJobsChip(running: backgroundJobs.runningCount) {
                        showsBackgroundJobs = true
                    }
                    if showsNewWorktreeChip {
                        AidenNewWorktreeChip(isOn: $model.startsInNewWorktree)
                            .disabled(model.isStarting)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, simulators.deviceCount > 0 ? 0 : 4)
                .padding(.bottom, 4)
            }
            AidenChatProgressControls(
                taskProgress: model.taskProgress,
                agentRoster: model.agentRoster,
                canReadTasks: model.canReadTaskProgress,
                canReadAgents: model.canReadAgentRoster,
                taskIsStale: model.isTaskProgressStale,
                agentIsStale: model.isAgentRosterStale,
                openTasks: { progressSheet = .tasks },
                openAgents: { progressSheet = .agents }
            )
            if let notice = model.macOnlyAgentNotice {
                Text(notice)
                    .font(.footnote)
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 6)
            }
            if let question = model.pendingQuestion {
                AidenQuestionCard(
                    model: model,
                    prompt: question,
                    onSubmit: { request in
                        Task {
                            await model.respondToQuestion(
                                request,
                                promptID: question.id,
                                idempotencyKey: UUID()
                            )
                        }
                    }
                )
                .disabled(!model.isConnected || model.isReadOnlyPresentation || model.isRespondingToQuestion || model.isStopping)
                .id(question.id)
            } else {
                AidenComposerView(
                    model: model,
                    autoStartVoice: autoStartVoice,
                    composerFocus: $composerIsFocused,
                    attachmentPicker: attachmentPicker,
                    motionNamespace: attachmentMotionNamespace,
                    canToggleAttachments: canToggleAttachmentPicker,
                    onToggleAttachmentPicker: toggleAttachmentPicker,
                    placeholder: botToolsModel?.bot.map { "Ask \($0.name)" } ?? "Message Aiden"
                )
            }
        }
        .disabled(model.isReadOnlyPresentation)
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
        .background {
            GeometryReader { proxy in
                Color.clear.preference(
                    key: AidenComposerHeightPreferenceKey.self,
                    value: proxy.size.height
                )
            }
        }
    }

    private var attachmentCapacity: Int {
        AidenAttachmentPickerPolicy.availableCapacity(pendingCount: model.pendingAttachments.count)
    }

    private var attachmentControlsAreBusy: Bool {
        !model.isConnected || !canToggleAttachmentPicker
    }

    private var canToggleAttachmentPicker: Bool {
        AidenAttachmentPickerPolicy.canPresent(
            isReadOnly: model.isReadOnlyPresentation,
            isStreaming: model.isStreaming,
            isUploading: model.isUploadingAttachment,
            isPreparing: model.isPreparingAttachments,
            capacity: attachmentCapacity
        )
    }

    private var allowedAttachmentContentTypes: [UTType] {
        let textTypes: [UTType] = [.plainText, .sourceCode, .json, .xml, .commaSeparatedText]
        return model.acceptsImageAttachments ? [.image] + textTypes : textTypes
    }

    private func toggleAttachmentPicker() {
        guard canToggleAttachmentPicker else { return }
        composerIsFocused = false
        if attachmentPicker.isPresented {
            attachmentPicker.dismiss()
        } else {
            attachmentPicker.openMenu()
        }
    }

    private func commitSelectedPhotos() {
        guard !attachmentControlsAreBusy else { return }
        let commit = attachmentPicker.beginCommit(pendingCount: model.pendingAttachments.count)
        guard let commit else { return }

        let preparation = model.prepareAttachments(Result<[PHAsset], Error>.success(commit.assets)) { asset in
            let picked = try await AidenPhotoLibraryImageLoader.pickedImage(for: asset)
            return try await AidenAttachmentPreparation.imageUploadAsync(
                data: picked.data,
                name: picked.name
            )
        }
        guard let preparation else {
            attachmentPicker.finishCommit(commit.id)
            return
        }
        Task { @MainActor in
            await preparation.value
            attachmentPicker.finishCommit(commit.id)
        }
    }

    private func commitCapturedPhoto(_ data: Data) {
        guard !attachmentControlsAreBusy, attachmentCapacity > 0,
              model.acceptsImageAttachments else { return }
        attachmentPicker.dismiss()
        model.prepareAttachments(.success([data])) { capturedData in
            try await AidenAttachmentPreparation.imageUploadAsync(
                data: capturedData,
                name: "Camera Photo.jpg"
            )
        }
    }

    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if let coordinator, let botToolsModel {
            ToolbarItem(placement: .principal) {
                botHeaderPill(coordinator: coordinator, model: botToolsModel)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        openBotProfile(coordinator: coordinator, model: botToolsModel)
                    } label: {
                        Label("Profile", systemImage: "person.crop.circle")
                    }

                    if botToolsModel.fileGrant(
                        coordinator: coordinator,
                        hostAllowsMutations: effectiveAllowsMutations
                    ) != nil {
                        Button {
                            openBotFiles(coordinator: coordinator, model: botToolsModel)
                        } label: {
                            Label("Files", systemImage: "folder")
                        }
                    }

                    if AidenBotDeletion.isAvailable(coordinator: coordinator), botToolsModel.bot != nil {
                        Button(role: .destructive) {
                            isConfirmingBotDelete = true
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                } label: {
                    Image(systemName: AidenChromeSymbols.overflowMenu)
                        .font(.body.weight(.semibold))
                        .contentShape(Circle())
                }
                .buttonBorderShape(.circle)
                .accessibilityLabel("More")
            }
        } else if model.chat.botId == nil,
                  let coordinator, let workspace, workspace.hasFolder {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink {
                    AidenWorkspaceFilesView(coordinator: coordinator, workspace: workspace)
                } label: {
                    Label("Files", systemImage: "folder")
                }
                .accessibilityLabel("Workspace files")
            }
        }
    }

    /// A small avatar and the Bot's name. Tapping it opens the Profile.
    private func botHeaderPill(
        coordinator: AidenRemoteCoordinator,
        model botModel: AidenBotChatToolsModel
    ) -> some View {
        Button {
            openBotProfile(coordinator: coordinator, model: botModel)
        } label: {
            HStack(spacing: 8) {
                if let bot = botModel.bot {
                    AidenBotCanonicalAvatarView(
                        coordinator: coordinator,
                        botID: bot.id,
                        avatar: bot.avatar,
                        name: bot.name,
                        size: 26
                    )
                } else {
                    Circle()
                        .fill(palette.raised)
                        .frame(width: 26, height: 26)
                }
                Text(botModel.bot?.name ?? model.chat.title)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
            }
            .padding(.leading, 4)
            .padding(.trailing, 12)
            .frame(minHeight: 34)
            .aidenBotHeaderNameGlass()
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(botModel.bot?.name ?? model.chat.title)
        .accessibilityHint("Opens the Bot’s profile")
    }

    @ViewBuilder
    private func botSheetContent(_ destination: AidenBotChatSheet) -> some View {
        if let coordinator, let botToolsModel {
            switch destination {
            case .profile(let bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    initialSummary: bot,
                    onChanged: {
                        Task { await botToolsModel.load(coordinator: coordinator) }
                    },
                    onDeleted: {
                        botSheet = nil
                        dismissChat()
                    }
                )
            case .files(let grant):
                NavigationStack {
                    AidenBotConversationFilesView(coordinator: coordinator, grant: grant)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Done") { botSheet = nil }
                            }
                        }
                }
            }
        }
    }

    private func openBotProfile(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        if let bot = model.bot {
            botSheet = .profile(AidenBotSummary(detail: bot))
            return
        }
        Task {
            guard await model.refresh(coordinator: coordinator),
                  let bot = model.bot else { return }
            botSheet = .profile(AidenBotSummary(detail: bot))
        }
    }

    private func deleteBotFromChat() {
        guard let coordinator, let bot = botToolsModel?.bot else { return }
        Task {
            do {
                try await AidenBotDeletion.delete(botID: bot.id, revision: bot.revision, coordinator: coordinator)
                dismissChat()
            } catch is CancellationError {
                return
            } catch {
                model.presentedError = "\(bot.name) wasn’t deleted. Please try again."
            }
        }
    }

    private func openBotFiles(
        coordinator: AidenRemoteCoordinator,
        model: AidenBotChatToolsModel
    ) {
        Task {
            guard await model.refresh(coordinator: coordinator),
                  let grant = model.fileGrant(
                      coordinator: coordinator,
                      hostAllowsMutations: effectiveAllowsMutations
                  ) else { return }
            botSheet = .files(grant)
        }
    }

    /// Prepending would otherwise leave the viewport at the same offset over
    /// new content; re-anchor on the message that was first so the reader
    /// stays where they were.
    private func loadEarlierMessages(_ proxy: ScrollViewProxy) {
        let anchorID = model.chat.messages.first?.id
        Task {
            await model.loadEarlierMessages()
            guard let anchorID, model.chat.messages.first?.id != anchorID,
                  model.chat.messages.contains(where: { $0.id == anchorID }) else { return }
            proxy.scrollTo(model.renderID(forMessageID: anchorID), anchor: .top)
        }
    }

    /// Jump to latest or a send: re-arms follow, then snaps (while
    /// streaming) or animates (when idle) to the bottom sentinel.
    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        follow.scheduleFollowScroll(isUserInitiated: true, animated: true) { animated in
            scrollToBottom(proxy, animated: animated)
        }
    }

    /// An automatic follow; it does nothing unless follow is latched on.
    private func followLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        follow.scheduleFollowScroll(isUserInitiated: false, animated: animated) { animated in
            scrollToBottom(proxy, animated: animated)
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let scroll = {
            proxy.scrollTo(AidenChatScrollPolicy.transcriptBottomAnchorID, anchor: .bottom)
        }
        if animated, !reduceMotion {
            withAnimation(.easeOut(duration: 0.2), scroll)
        } else {
            scroll()
        }
    }
}

func aidenChatIsScrolledAwayFromLatest(
    contentOffsetY: CGFloat,
    containerHeight: CGFloat,
    contentHeight: CGFloat,
    bottomInset: CGFloat,
    threshold: CGFloat = 72
) -> Bool {
    guard containerHeight > 0, contentHeight > containerHeight else { return false }
    let viewportBottom = contentOffsetY + containerHeight
    let contentBottom = contentHeight + max(0, bottomInset)
    return contentBottom - viewportBottom > threshold
}

struct AidenChatJumpToLatestButton: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 34, height: 34)
                .contentShape(Circle())
                .modifier(AidenChatJumpToLatestGlassModifier(reduceTransparency: reduceTransparency))
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("Jump to latest")
        .accessibilityHint("Scrolls to the newest message")
    }
}

/// Pages the transcript back one window. A soft raised capsule with no
/// border, matching the transcript's other quiet secondary controls.
private struct AidenLoadEarlierMessagesButton: View {
    @Environment(\.aidenPalette) private var palette

    let isLoading: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isLoading {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 11, weight: .semibold))
                }
                Text(isLoading ? "Loading earlier messages" : "Load earlier messages")
                    .font(.footnote.weight(.medium))
            }
            .foregroundStyle(palette.secondary)
            .padding(.horizontal, 14)
            .frame(minHeight: 32)
            .background(palette.raised, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(isLoading)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
        .accessibilityHint("Shows older messages in this conversation")
    }
}

private struct AidenChatJumpToLatestGlassModifier: ViewModifier {
    @Environment(\.aidenPalette) private var palette
    let reduceTransparency: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(palette.raised, in: Circle())
        } else {
            content.glassEffect(.regular.interactive(), in: Circle())
        }
    }
}

private struct AidenComposerHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 132

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// One settled transcript row: the ID its view is keyed by, and where its
/// message sits in the chat.
struct AidenTranscriptRowIdentity: Identifiable, Equatable {
    let id: String
    let index: Int

    /// Rows keyed by `renderIDs[message.id] ?? message.id`. A render ID that
    /// another message already uses is ignored, so row IDs stay unique.
    static func rows(for messages: [AidenChatMessage], renderIDs: [String: String]) -> [Self] {
        guard !renderIDs.isEmpty else {
            return messages.indices.map { Self(id: messages[$0].id, index: $0) }
        }
        var used = Set(messages.map(\.id))
        return messages.indices.map { index in
            let messageID = messages[index].id
            guard let alias = renderIDs[messageID], alias != messageID, !used.contains(alias) else {
                return Self(id: messageID, index: index)
            }
            used.insert(alias)
            return Self(id: alias, index: index)
        }
    }
}

private struct AidenSettledMessageRows: View, Equatable {
    let model: AidenChatViewModel
    let chat: AidenChat
    let presentationStyle: AidenChatPresentationStyle
    /// Value snapshots of the Read Aloud state the rows render, so a playback
    /// change re-evaluates the rows even though `model` compares equal.
    let readAloudCandidateID: String?
    let readAloudActiveID: String?
    /// `AidenChatViewModel.messageRenderIDs`: rows keep the identity they
    /// were first drawn with when the Mac assigns a message its ID.
    var renderIDs: [String: String] = [:]
    /// Generations whose settled image plays the arrival reveal.
    var imageArrivalRevealIDs: Set<String> = []
    var appControlsAvailable = false
    /// Quotes a selection into the composer; nil while the chat is read-only.
    /// Closure identity is excluded from equality like the stable `model`.
    var onAskAbout: ((String) -> Void)? = nil
    /// Nil hides every fork action (no `chat-fork-v1`, read-only, or busy).
    var forkAvailability: AidenChatForkAvailability? = nil
    var onFork: ((String, AidenChatForkMenuAction) -> Void)? = nil
    /// Value snapshots for the fork summary card's actions.
    var canSettleForkSummary = false
    var isSettlingForkSummary = false
    /// The Mac announces `chat-visual-viewer-v1` (revision 35).
    var visualViewerAvailable = false
    /// Adds a follow-up confirmed in the visual viewer to the composer.
    var onVisualPrompt: ((String) -> Void)? = nil
    /// The Mac announces `chat-browser-recordings-v1` (revision 46).
    var browserRecordingsAvailable = false

    static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.onAskAbout == nil) == (rhs.onAskAbout == nil) &&
        lhs.visualViewerAvailable == rhs.visualViewerAvailable &&
        lhs.browserRecordingsAvailable == rhs.browserRecordingsAvailable &&
        (lhs.onVisualPrompt == nil) == (rhs.onVisualPrompt == nil) &&
        (lhs.onFork == nil) == (rhs.onFork == nil) &&
        lhs.forkAvailability == rhs.forkAvailability &&
        lhs.canSettleForkSummary == rhs.canSettleForkSummary &&
        lhs.isSettlingForkSummary == rhs.isSettlingForkSummary &&
        // `model` is a shared reference (same pointer on both sides of every
        // comparison), so equality must cover the value-typed snapshots the
        // body renders — `chat`, the Read Aloud state — and the presentation style.
        lhs.chat == rhs.chat && lhs.presentationStyle == rhs.presentationStyle &&
            lhs.readAloudCandidateID == rhs.readAloudCandidateID &&
            lhs.readAloudActiveID == rhs.readAloudActiveID &&
            lhs.renderIDs == rhs.renderIDs &&
            lhs.imageArrivalRevealIDs == rhs.imageArrivalRevealIDs &&
            lhs.appControlsAvailable == rhs.appControlsAvailable
    }

    var body: some View {
        let forkActions = forkAvailability.map {
            AidenChatForkEligibility.actions(for: chat.messages, supportsSummary: $0.supportsSummary)
        } ?? [:]
        let forkSummary = chat.forkedFrom?.summary
        ForEach(AidenTranscriptRowIdentity.rows(for: chat.messages, renderIDs: renderIDs)) { row in
            let index = row.index
            let message = chat.messages[index]
            messageRow(message, at: index, forkActions: forkActions[message.id] ?? [])
            // The summary sits in model context right after the last copied message.
            if let forkSummary, forkSummary.afterMessageId == message.id {
                forkSummaryCard(forkSummary)
            }
        }
    }

    private func forkSummaryCard(_ summary: AidenChatForkSummary) -> some View {
        AidenForkSummaryCard(
            summary: summary,
            isBusy: isSettlingForkSummary,
            onCancel: canSettleForkSummary ? { Task { await model.cancelForkSummary() } } : nil,
            onRetry: canSettleForkSummary ? { Task { await model.retryForkSummary() } } : nil,
            onSkip: canSettleForkSummary ? { Task { await model.skipForkSummary() } } : nil
        )
    }

    private func messageRow(
        _ message: AidenChatMessage,
        at index: Int,
        forkActions: [AidenChatForkMenuAction]
    ) -> some View {
        let previous = index > 0 ? chat.messages[index - 1] : nil
        let isBotMessage = presentationStyle == .botMessages
        let topPadding: CGFloat = isBotMessage && !aidenMessagesJoin(previous, message) ? 9 : 0
        let next = index + 1 < chat.messages.count ? chat.messages[index + 1] : nil
        // Bot bubbles join into clusters; only the cluster's last bubble
        // carries the footer so the Messages rhythm stays compact.
        let showsFooter = !isBotMessage || next.map { !aidenMessagesJoin(message, $0) } ?? true
        let revealGenerationID = message.timeline.map(\.generationId).flatMap {
            imageArrivalRevealIDs.contains($0) ? $0 : nil
        }
        let revealAttachmentID = revealGenerationID.flatMap { _ in
            AidenImageGenerationPlaceholderState.arrivalRevealAttachmentID(in: message)
        }

        return AidenMessageView(
            message: message,
            presentationStyle: presentationStyle,
            loadAttachmentImage: { attachment in
                await model.attachmentImageData(for: attachment)
            },
            readAloudAction: readAloudCandidateID == message.id ? { model.toggleReadAloud(message.id) } : nil,
            readAloudActive: readAloudActiveID == message.id,
            showsFooter: showsFooter,
            onAskAbout: onAskAbout,
            forkActions: onFork == nil ? [] : forkActions,
            onFork: onFork.map { handler in { (action: AidenChatForkMenuAction) in handler(message.id, action) } },
            imageArrivalRevealAttachmentID: revealAttachmentID,
            onImageArrivalRevealed: revealGenerationID.map { generationID in
                { model.finishImageArrivalReveal(generationID: generationID) }
            },
            appControlsAvailable: appControlsAvailable,
            appControlsCache: model.appControlsCache,
            loadAppControls: { try await model.loadAppControls($0) },
            applyAppControl: { try await model.applyAppControl($0, operation: $1) },
            loadVisualDocument: visualViewerAvailable
                ? { (visualID: String, appearance: AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad in
                    await model.visualDocument(visualId: visualID, appearance: appearance)
                }
                : nil,
            onVisualPrompt: onVisualPrompt,
            loadBrowserRecording: browserRecordingsAvailable
                ? { (recording: AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad in
                    await model.browserRecording(recording)
                }
                : nil
        )
        .equatable()
        .padding(.top, topPadding)
    }
}

struct AidenMessageView: View, Equatable {
    @Environment(\.aidenPalette) private var palette
    let message: AidenChatMessage
    let presentationStyle: AidenChatPresentationStyle
    let loadAttachmentImage: (AidenMessageAttachment) async -> Data?
    var readAloudAction: (() -> Void)? = nil
    var readAloudActive = false
    var showsFooter = true
    var onAskAbout: ((String) -> Void)? = nil
    var forkActions: [AidenChatForkMenuAction] = []
    var onFork: ((AidenChatForkMenuAction) -> Void)? = nil
    /// The generated image that plays the one-shot arrival reveal, if any.
    var imageArrivalRevealAttachmentID: String? = nil
    var onImageArrivalRevealed: (() -> Void)? = nil
    var appControlsAvailable = false
    var appControlsCache: AidenAppControlCache? = nil
    var loadAppControls: ((AidenAppControlPanel) async throws -> AidenAppControlSnapshot)? = nil
    var applyAppControl: ((AidenAppControlPanel, AidenAppControlOperation) async throws -> AidenAppControlReceipt)? = nil
    /// Present while the Mac announces `chat-visual-viewer-v1` (revision 35).
    var loadVisualDocument: ((String, AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad)? = nil
    var onVisualPrompt: ((String) -> Void)? = nil
    /// Present while the Mac announces `chat-browser-recordings-v1` (revision 46).
    var loadBrowserRecording: ((AidenBrowserRecordingRecap) async -> AidenBrowserRecordingLoad)? = nil
    @State private var selectTextRequest: AidenSelectTextRequest?

    static func == (lhs: Self, rhs: Self) -> Bool {
        // The loader closure captures the stable view-model; identity churn on
        // it must not force settled rows to re-render on every streamed token.
        // The Read Aloud and Ask actions are compared by presence for the same reason.
        lhs.message == rhs.message && lhs.presentationStyle == rhs.presentationStyle &&
            (lhs.readAloudAction == nil) == (rhs.readAloudAction == nil) &&
            lhs.readAloudActive == rhs.readAloudActive &&
            lhs.showsFooter == rhs.showsFooter &&
            (lhs.onAskAbout == nil) == (rhs.onAskAbout == nil) &&
            lhs.forkActions == rhs.forkActions &&
            (lhs.onFork == nil) == (rhs.onFork == nil) &&
            lhs.imageArrivalRevealAttachmentID == rhs.imageArrivalRevealAttachmentID &&
            lhs.appControlsAvailable == rhs.appControlsAvailable &&
            (lhs.loadVisualDocument == nil) == (rhs.loadVisualDocument == nil) &&
            (lhs.onVisualPrompt == nil) == (rhs.onVisualPrompt == nil) &&
            (lhs.loadBrowserRecording == nil) == (rhs.loadBrowserRecording == nil)
    }

    private var selectableText: String {
        AidenSelectionQuote.selectableText(for: message, visibleText: visibleText)
    }

    private var botReply: AidenBotReplyProjection? {
        guard presentationStyle == .botMessages, message.role == .assistant else { return nil }
        return AidenBotReplyProjection.resolve(
            text: message.text,
            timeline: message.timeline,
            isActive: false
        )
    }

    private var visibleText: String {
        botReply?.finalText ?? message.text
    }

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 2) {
            messageBody
            if showsFooter {
                AidenMessageFooter(
                    message: message,
                    copyText: AidenMessageActionContent.copyText(for: message, presentationStyle: presentationStyle),
                    readAloudAction: readAloudAction,
                    readAloudActive: readAloudActive
                )
            }
        }
        .sheet(item: $selectTextRequest) { request in
            AidenSelectTextSheet(text: request.text, onAskAbout: onAskAbout)
        }
    }

    private var messageBody: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: presentationStyle == .botMessages ? 72 : 48)
                messageContent
            } else {
                messageContent
                    .frame(
                        maxWidth: presentationStyle == .botMessages ? 620 : .infinity,
                        alignment: .leading
                    )
                    .layoutPriority(1)
                if presentationStyle == .botMessages {
                    Spacer(minLength: 72)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .contextMenu {
            if let copyText = AidenMessageActionContent.copyText(
                for: message,
                presentationStyle: presentationStyle
            ) {
                Button {
                    UIPasteboard.general.string = copyText
                } label: {
                    Label("Copy", systemImage: "doc.on.doc")
                }
                Button {
                    selectTextRequest = AidenSelectTextRequest(text: selectableText)
                } label: {
                    Label("Select Text", systemImage: "selection.pin.in.out")
                }
                if let onAskAbout {
                    Button {
                        onAskAbout(selectableText)
                    } label: {
                        Label("Ask About This", systemImage: "text.bubble")
                    }
                }
            }
            if let onFork, !forkActions.isEmpty {
                Divider()
                ForEach(forkActions, id: \.self) { action in
                    Button {
                        onFork(action)
                    } label: {
                        Label(action.menuTitle, systemImage: action.systemImage)
                    }
                }
            }
        }
        .accessibilityActions {
            if let copyText = AidenMessageActionContent.copyText(
                for: message,
                presentationStyle: presentationStyle
            ) {
                Button(message.role == .user ? "Copy message" : "Copy response") {
                    UIPasteboard.general.string = copyText
                }
                Button("Select text") {
                    selectTextRequest = AidenSelectTextRequest(text: selectableText)
                }
                if let onAskAbout {
                    Button("Ask about this") {
                        onAskAbout(selectableText)
                    }
                }
            }
            if let onFork {
                ForEach(forkActions, id: \.self) { action in
                    Button(action.accessibilityTitle) { onFork(action) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(message.role == .user ? "You" : "Aiden")

    }

    /// A committed assistant reply's rows in the order they happened, with each
    /// visual and image beneath the step that made it; nil without a usable timeline.
    private var messageChronologicalRows: [AidenChronologicalRow]? {
        guard message.role == .assistant, presentationStyle != .botMessages else { return nil }
        return AidenChronologicalProjection.rows(
            text: message.text,
            reasoning: message.reasoning ?? "",
            timeline: message.timeline,
            visuals: AidenChatVisualPresentation.rowVisuals(in: message),
            images: AidenImageGenerationPlaceholderState.stripImageAttachments(for: message)
        )
    }

    private var messageContent: some View {
        VStack(
            alignment: message.role == .user ? .trailing : .leading,
            spacing: 10
        ) {
            if let rows = messageChronologicalRows {
                AidenChronologicalTranscript(
                    rows: rows,
                    active: false,
                    visualContent: { visual in AnyView(visualRow(visual)) },
                    loadRecording: loadBrowserRecording,
                    imageContent: { images in
                        AnyView(AidenMessageImageAttachmentsView(
                            attachments: images,
                            edge: AidenMessageMediaEdge.forRole(message.role),
                            loadData: loadAttachmentImage,
                            revealAttachmentID: imageArrivalRevealAttachmentID,
                            onArrivalRevealed: onImageArrivalRevealed
                        ))
                    }
                )
            } else {
            if message.role == .assistant, let reasoning = message.reasoning, !reasoning.isEmpty {
                AidenReasoningCard(text: reasoning, label: "Thought", active: false)
            }
            if message.role == .assistant, let timeline = message.timeline {
                let activitySteps = timeline.steps.filter { !$0.isQuestionnaire }
                if !activitySteps.isEmpty {
                    AidenActivityFeed(
                        timeline: timeline,
                        active: false,
                        progressText: botReply?.progressText,
                        showsRunningRowsWhenCollapsed: presentationStyle != .botMessages,
                        steps: activitySteps
                    )
                }
                ForEach(AidenAgentActivityPresentation.questionnaireSteps(timeline)) { step in
                    if let recap = step.questionnaire {
                        AidenQuestionnaireRecapView(recap: recap)
                    }
                }
                ForEach(AidenAgentActivityPresentation.extractionSteps(timeline)) { step in
                    if let recap = step.extraction {
                        AidenWebExtractRecapView(recap: recap)
                    }
                }
                ForEach(AidenAgentActivityPresentation.recordingSteps(timeline)) { step in
                    if let recording = step.recording {
                        AidenBrowserRecordingCardView(recording: recording, load: loadBrowserRecording)
                    }
                }
            }
            if !visibleText.isEmpty {
                messageText
            }
            // Without a chronological timeline, visuals follow the reply text.
            if message.role == .assistant {
                ForEach(AidenChatVisualPresentation.rowVisuals(in: message)) { visual in
                    visualRow(visual)
                }
            }
            }
            // Snapshots appear once, inline at their visual, never in the strip,
            // and images drawn beneath their step leave it too.
            let attachments = AidenChatVisualPresentation.stripAttachments(for: message)
            if !attachments.isEmpty {
                let imageAttachments = AidenImageGenerationPlaceholderState.stripImageAttachments(for: message)
                let placedImageIDs = messageChronologicalRows.map(AidenChronologicalProjection.placedImageIDs) ?? []
                let trailingImages = imageAttachments.filter { !placedImageIDs.contains($0.id) }
                if !trailingImages.isEmpty {
                    AidenMessageImageAttachmentsView(
                        attachments: trailingImages,
                        edge: AidenMessageMediaEdge.forRole(message.role),
                        loadData: loadAttachmentImage,
                        revealAttachmentID: imageArrivalRevealAttachmentID,
                        onArrivalRevealed: onImageArrivalRevealed
                    )
                }
                let fallbackAttachments = attachments.filter { attachment in
                    !imageAttachments.contains(where: { $0.id == attachment.id })
                }
                ForEach(fallbackAttachments.indices, id: \.self) { index in
                    let attachment = fallbackAttachments[index]
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.name).lineLimit(1)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file))
                                .foregroundStyle(palette.secondary)
                        }
                    } icon: {
                        Image(systemName: attachment.kind == .image ? "photo.badge.exclamationmark" : "doc.text")
                    }
                    .font(.caption)
                    .padding(AidenMessageContentSurface.usesRaisedBubble(
                        role: message.role,
                        content: .fallbackAttachment
                    ) ? 10 : 0)
                    .background(
                        AidenMessageContentSurface.usesRaisedBubble(
                            role: message.role,
                            content: .fallbackAttachment
                        ) ? palette.raised : Color.clear,
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                    )
                    .accessibilityElement(children: .combine)
                }
            }
            if message.role == .assistant, let panels = message.appPanels {
                ForEach(panels) { panel in
                    AidenNativeAppControlPanel(panel: panel, available: appControlsAvailable, cache: appControlsCache, load: loadAppControls, apply: applyAppControl)
                }
            }
            if message.role == .assistant {
                // A visual's snapshot replaces the card for the artifact it shows.
                ForEach(AidenChatVisualPresentation.unviewableHtmlArtifacts(in: message), id: \.id) { artifact in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(artifact.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        Text("Can't view on this device. View in Aiden Agent.")
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(artifact.title). Can't view on this device. View in Aiden Agent.")
                }
            }
            if message.role == .assistant, let outcome = message.outcome {
                AidenMessageOutcomeView(outcome: outcome)
            }
        }
    }

    private func visualRow(_ visual: AidenChatVisual) -> some View {
        AidenVisualRowView(
            visual: visual,
            snapshot: AidenChatVisualPresentation.snapshotAttachment(for: visual, in: message),
            loadData: loadAttachmentImage,
            loadDocument: loadVisualDocument.map { load in
                { (appearance: AidenVisualViewerAppearance) async -> AidenVisualDocumentLoad in
                    await load(visual.id, appearance)
                }
            },
            onAddToMessage: onVisualPrompt
        )
    }

    private var messageText: some View {
        let usesWorkspaceBubble = AidenMessageContentSurface.usesRaisedBubble(
            role: message.role,
            content: .text
        )
        let usesBotBubble = presentationStyle == .botMessages
        return AidenMessageTextView(role: message.role, content: visibleText)
            .foregroundStyle(
                usesBotBubble && message.role == .user
                    ? palette.onFillAccent
                    : palette.foreground
            )
            .padding(usesWorkspaceBubble || usesBotBubble ? 12 : 0)
            .background {
                if usesBotBubble {
                    AidenBotMessageBubbleShape()
                    .fill(
                        message.role == .user
                            ? palette.fillAccent
                            : Color(uiColor: .secondarySystemFill)
                    )
                } else if usesWorkspaceBubble {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(palette.raised)
                }
            }
    }
}

struct AidenActivityFeed: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    let timeline: AidenGenerationTimeline
    let active: Bool
    let progressText: String?
    let showsRunningRowsWhenCollapsed: Bool
    var steps: [AidenAgentStep]? = nil
    @State private var isExpanded = false

    private var visibleSteps: [AidenAgentStep] { steps ?? timeline.steps }
    private var rows: [AidenAgentStep] { Array(visibleSteps.suffix(3)) }
    private var isRunning: Bool { active && timeline.status == .running }
    private var compactOnly: Bool { AidenAgentActivityPresentation.isCompactContextOnly(visibleSteps) }
    /// A healthy lone compaction is fully told by its own line in the header, so the
    /// expanded list would only repeat it; progress text still needs the disclosure.
    private var stepInHeader: Bool { compactOnly && timeline.issueCount == 0 }
    private var allowsDisclosure: Bool {
        !stepInHeader || !(progressText ?? "").isEmpty
    }
    private var showsCollapsedTicker: Bool {
        isRunning && (!isExpanded || !allowsDisclosure) && showsRunningRowsWhenCollapsed
    }
    private var headline: String {
        if stepInHeader, let last = visibleSteps.last {
            return AidenAgentActivityPresentation.line(for: last)
        }
        return AidenAgentActivityPresentation.summary(timeline)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isExpanded && allowsDisclosure ? 4 : 0) {
            header
            if allowsDisclosure, isExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if !stepInHeader {
                        ForEach(visibleSteps) { step in
                            AidenActivityStepLine(step: step, shimmer: isRunning && step.isActive)
                        }
                    }
                    if let progressText, !progressText.isEmpty {
                        Divider()
                            .padding(.vertical, 4)
                        Text("Updates")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(palette.secondary)
                        Text(verbatim: progressText)
                            .font(.caption)
                            .foregroundStyle(palette.secondary)
                            .lineSpacing(3)
                            .textSelection(.enabled)
                            .padding(.top, 1)
                    }
                }
                .padding(.top, 2)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: timeline.steps.last?.id)
        .onAppear {
            if timeline.issueCount > 0 { isExpanded = true }
        }
    }

    @ViewBuilder
    private var header: some View {
        if allowsDisclosure {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                    isExpanded.toggle()
                }
            } label: {
                headerRow.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(headline)
            .accessibilityHint(isExpanded ? "Collapses activity" : "Expands activity")
        } else {
            headerRow
                .accessibilityElement(children: .combine)
                .accessibilityLabel(headline)
        }
    }

    private var headerRow: some View {
        HStack(alignment: showsCollapsedTicker ? .bottom : .center, spacing: 8) {
            Group {
                if showsCollapsedTicker {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(rows) { step in
                            AidenActivityStepLine(step: step, shimmer: step.id == rows.last?.id && step.isActive)
                                .frame(height: 24)
                                .id(step.id)
                                .transition(.opacity)
                        }
                    }
                    .frame(height: CGFloat(rows.count) * 24, alignment: .bottom)
                    .clipped()
                } else {
                    Text(headline)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                        .aidenActivityShimmer(isRunning)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if timeline.issueCount > 0 {
                Text(timeline.issueCount == 1 ? "1 issue" : "\(timeline.issueCount) issues")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(palette.warning)
            }

            if allowsDisclosure {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
        }
    }
}

struct AidenActivityStepLine: View {
    @Environment(\.aidenPalette) private var palette
    let step: AidenAgentStep
    let shimmer: Bool

    private var tone: Color {
        switch step.status {
        case .failed: palette.danger
        case .blocked, .cancelled, .awaitingApproval: palette.warning
        default: palette.secondary
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(AidenAgentActivityPresentation.line(for: step))
                .lineLimit(1)
                .truncationMode(.tail)
            if let file = step.producedFile {
                Text("File \(file.operation) · \(file.relativePath.components(separatedBy: "/").last ?? file.relativePath)")
                    .font(.caption2)
                    .lineLimit(1)
                    .accessibilityLabel("File \(file.operation): \(file.relativePath)")
            }
            if let changes = step.lineChanges, changes.additions > 0 || changes.deletions > 0 {
                Text("+\(changes.additions) −\(changes.deletions)")
                    .font(.caption2.monospaced().weight(.medium))
            }
        }
        .font(.caption)
        .foregroundStyle(tone)
        .aidenActivityShimmer(shimmer)
        .accessibilityElement(children: .combine)
    }
}

private struct AidenActivityShimmerModifier: ViewModifier {
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    let active: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if active && !reduceMotion && !lowPowerMode {
            content.overlay {
                GeometryReader { proxy in
                    TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                        let cycle = context.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: 1.8) / 1.8
                        LinearGradient(
                            colors: [.clear, .white.opacity(0.42), .clear],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: max(proxy.size.width * 0.55, 36))
                        .offset(x: (proxy.size.width * 1.55 * cycle) - proxy.size.width * 0.55)
                    }
                }
                .mask(content)
                .allowsHitTesting(false)
            }
        } else {
            content
        }
    }
}

extension View {
    func aidenActivityShimmer(_ active: Bool) -> some View {
        modifier(AidenActivityShimmerModifier(active: active))
    }
}

struct AidenMessageOutcomePresentation: Equatable {
    let title: String
    let detail: String?
    let symbol: String
    let isFailure: Bool

    static func make(_ outcome: AidenMessageOutcome) -> Self {
        guard outcome.status == .failed else {
            return Self(title: "Response cancelled", detail: nil, symbol: "stop.circle", isFailure: false)
        }
        let detail: String
        switch outcome.category {
        case "network":
            detail = "Aiden could not reach the model provider."
        case "timeout":
            detail = "The model provider took too long to respond."
        case "service_unavailable":
            detail = "The model provider is temporarily unavailable."
        case "rate_limit":
            detail = "The model provider is receiving too many requests. Try again shortly."
        case "authentication":
            detail = "The model provider rejected its credentials. Check Provider Settings on your desktop."
        case "quota":
            detail = "The model provider account has no available quota."
        case "invalid_request":
            detail = "The model provider could not accept this request. For a Bot, change its model in Edit Bot; for a Workspace chat, use the composer."
        case "context_window":
            detail = "This conversation is too large for the selected model."
        case "output_limit":
            detail = "The model reached its response limit before it could finish."
        case "interrupted":
            detail = "The response was interrupted before it could finish."
        case "context_management":
            detail = "Aiden could not prepare this conversation for the selected model."
        default:
            detail = "The model provider could not complete this response."
        }
        return Self(title: "Generation failed", detail: detail, symbol: "exclamationmark.triangle", isFailure: true)
    }
}

private struct AidenMessageOutcomeView: View {
    @Environment(\.aidenPalette) private var palette
    let outcome: AidenMessageOutcome

    var body: some View {
        let presentation = AidenMessageOutcomePresentation.make(outcome)
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: presentation.symbol)
                .foregroundStyle(presentation.isFailure ? Color.red : palette.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title).fontWeight(.semibold)
                if let detail = presentation.detail {
                    Text(detail).foregroundStyle(palette.secondary)
                }
            }
        }
        .font(.caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(
            presentation.isFailure ? Color.red.opacity(0.08) : palette.raised,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .accessibilityElement(children: .combine)
    }
}

/// Shared by the message and question composers so cancellation remains reachable.
struct AidenChatStopButton: View {
    @Environment(\.aidenPalette) private var palette
    @Bindable var model: AidenChatViewModel

    var canStop: Bool { model.canControlCurrentRun && !model.isStopping }

    @discardableResult
    func stop() async -> Bool { await model.stop() }

    var body: some View {
        if model.isStreaming {
            Button { Task { await stop() } } label: {
                Image(systemName: "stop.fill")
                    .frame(width: 30, height: 30)
                    .background(palette.foreground, in: Circle())
                    .foregroundStyle(palette.canvas)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!canStop)
            .accessibilityLabel(model.isStopping ? "Stopping response" : "Stop response")
        }
    }
}

private struct AidenComposerView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: AidenChatViewModel
    let autoStartVoice: Bool
    let composerFocus: FocusState<Bool>.Binding
    @Bindable var attachmentPicker: AidenAttachmentPickerState
    let motionNamespace: Namespace.ID
    let canToggleAttachments: Bool
    let onToggleAttachmentPicker: () -> Void
    var placeholder = "Message Aiden"
    @State private var voiceInput = ComposerVoiceInputController()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let progress = model.uploadProgress {
                AidenUploadProgressRow(progress: progress, onCancel: model.cancelUploads)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if !visiblePendingAttachments.isEmpty || !attachmentPicker.committingAssets.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(visiblePendingAttachments) { attachment in
                            AidenPendingAttachmentCard(
                                attachment: attachment,
                                loadImageData: {
                                    await model.pendingAttachmentImageData(for: attachment)
                                },
                                onRemove: {
                                    Task { await model.removeAttachment(attachment) }
                                }
                            )
                            .transition(.opacity.combined(with: .scale(scale: 0.96)))
                        }

                        ForEach(attachmentPicker.committingAssets, id: \.localIdentifier) { asset in
                            AidenCommittingPhotoCard(
                                asset: asset,
                                motionNamespace: motionNamespace
                            )
                        }
                    }
                    .padding(.horizontal, 1)
                }
                .accessibilityLabel("Attachments")
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let selectedSkill = model.selectedSkill {
                HStack(spacing: 6) {
                    Image(systemName: "slash.circle")
                        .font(.caption.weight(.medium))
                    Text("/\(selectedSkill.name)")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                    Button {
                        model.clearSelectedSkill()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.caption2.weight(.bold))
                    }
                    .accessibilityLabel("Remove skill \(selectedSkill.name)")
                }
                .foregroundStyle(palette.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(palette.secondary.opacity(0.12), in: Capsule())
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Skill \(selectedSkill.name) selected")
            }

            if !model.composerSuggestions.isEmpty {
                AidenComposerSuggestionList(
                    suggestions: model.composerSuggestions,
                    onSelect: { suggestion in
                        switch suggestion {
                        case .skill(let entry):
                            model.selectSkillSuggestion(entry)
                        case .agent, .file:
                            model.selectMentionSuggestion(suggestion)
                        }
                    }
                )
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            TextField(placeholder, text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 4)
                    .padding(.top, 5)
                    .focused(composerFocus)
                    .disabled(voiceInput.isBusy)
                    .submitLabel(.send)
                    .onSubmit {
                        guard !model.isStreaming else { return }
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    }

                HStack(alignment: .center, spacing: 10) {
                Button(action: onToggleAttachmentPicker) {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .frame(width: 44, height: 44)
                        .rotationEffect(.degrees(attachmentPicker.isPresented ? 45 : 0))
                        .opacity(model.isUploadingAttachment || model.isPreparingAttachments ? 0.48 : 1)
                        .overlay(alignment: .bottomTrailing) {
                            // While the upload bar shows progress, it is the only spinner.
                            if model.uploadProgress == nil, model.isUploadingAttachment || model.isPreparingAttachments {
                                ProgressView()
                                    .controlSize(.mini)
                                    .padding(3)
                                    .background(.regularMaterial, in: Circle())
                            }
                        }
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
                .disabled(!canToggleAttachments)
                .accessibilityLabel("Add attachment")
                .accessibilityValue(attachmentPicker.isPresented ? "Open" : "Closed")
                .accessibilityHint(model.acceptsImageAttachments
                    ? "Attach an image or bounded text file"
                    : "Attach a bounded text file. This model cannot read images")
                .background {
                    GeometryReader { proxy in
                        let frame = proxy.frame(in: .named(AidenChatAttachmentCoordinateSpace.name))
                        Color.clear.preference(
                            key: AidenAttachmentButtonCenterPreferenceKey.self,
                            value: CGPoint(x: frame.midX, y: frame.midY)
                        )
                    }
                }

                if model.showsComposerModelControl, !model.visibleProviders.isEmpty {
                    Menu {
                        ForEach(model.visibleProviders) { provider in
                            Section {
                                ForEach(provider.models) { candidate in
                                    if let levels = candidate.thinkingLevels, !levels.isEmpty {
                                        Menu {
                                            ForEach(levels, id: \.self) { level in
                                                Button {
                                                    select(
                                                        candidate,
                                                        providerId: provider.id,
                                                        thinkingLevel: level
                                                    )
                                                } label: {
                                                    if isSelected(candidate, providerId: provider.id, thinkingLevel: level) {
                                                        Label(candidate.thinkingLabel(for: level), systemImage: "checkmark")
                                                    } else {
                                                        Text(candidate.thinkingLabel(for: level))
                                                    }
                                                }
                                            }
                                        } label: { Text(candidate.label) }
                                    } else {
                                        Button {
                                            select(candidate, providerId: provider.id, thinkingLevel: nil)
                                        } label: {
                                            if isSelected(candidate, providerId: provider.id, thinkingLevel: nil) {
                                                Label(candidate.label, systemImage: "checkmark")
                                            } else {
                                                Text(candidate.label)
                                            }
                                        }
                                    }
                                }
                            } header: {
                                Label {
                                    Text(provider.label)
                                } icon: {
                                    AidenProviderIcon(
                                        providerID: provider.id,
                                        providerLabel: provider.label,
                                        artwork: provider.artwork,
                                        size: 16,
                                        color: palette.secondary
                                    )
                                }
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            if let provider = model.selectedProvider {
                                AidenProviderIcon(
                                    providerID: provider.id,
                                    providerLabel: provider.label,
                                    modelID: model.selectedModel?.id,
                                    artwork: provider.artwork,
                                    size: 15,
                                    color: palette.secondary
                                )
                            }
                            Text(model.selectedModel?.label ?? "Model").lineLimit(1)
                            if let level = model.selectedThinkingLevel,
                               model.selectedModel?.thinkingLevels?.isEmpty == false {
                                Text("· \(level.capitalized)")
                                    .lineLimit(1)
                                    .foregroundStyle(palette.secondary.opacity(0.8))
                            }
                            Image(systemName: "chevron.down").font(.caption2)
                        }
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .frame(maxWidth: 180, alignment: .leading)
                        .frame(minHeight: 44)
                    }
                    .accessibilityLabel("Model")
                    .accessibilityValue(selectedModelAccessibilityValue)
                } else if model.showsComposerModelControl,
                          let selectedModel = model.selectedModel {
                    HStack(spacing: 4) {
                        Text(selectedModel.label).lineLimit(1)
                        Text("· Hidden")
                            .lineLimit(1)
                            .foregroundStyle(palette.secondary.opacity(0.8))
                    }
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: 180, alignment: .leading)
                    .frame(minHeight: 44)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Model")
                    .accessibilityValue("\(selectedModel.label), hidden from picker")
                }

                Spacer(minLength: 0)

                // Dictation is off while a response streams, so the busy
                // Steer/Queue pill takes the mic's place (as on Android); a
                // dictation already running keeps its stop control.
                if !(model.isStreaming && model.showsRunInputOptions) || voiceInput.isListening {
                    Button {
                        Task {
                            guard !model.isReadOnlyPresentation else { return }
                            model.readAloud.stop()
                            await voiceInput.toggle(
                                currentDraft: model.draft,
                                updateDraft: { model.draft = $0 },
                                macTranscriber: model.transcribeMacSpeech
                            )
                        }
                    } label: {
                        Group {
                            if voiceInput.isListening {
                                AidenListeningWaveform(isAnimated: !reduceMotion)
                            } else {
                                Image(systemName: "mic")
                                    .font(.body.weight(.medium))
                            }
                        }
                        .frame(width: 44, height: 44)
                    }
                    .disabled(
                        model.isReadOnlyPresentation || model.isStreaming
                            || (voiceInput.isBusy && !voiceInput.isListening)
                    )
                    .accessibilityLabel(voiceInput.isListening ? "Stop voice input" : "Start voice input")
                }

                if model.isStreaming {
                    if model.showsRunInputOptions {
                        runInputPill
                    }
                    AidenChatStopButton(model: model)
                } else {
                    Button {
                        voiceInput.stopBeforeSubmittingDraft()
                        Task { await model.send() }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.headline.bold())
                            .frame(width: 30, height: 30)
                    }
                    .buttonStyle(AidenSolidFillButtonStyle(shape: Circle(), hitSize: 44))
                    .disabled(!model.canSend)
                    .accessibilityLabel("Send message")
                }
            }

            if let receipt = model.runInputReceipt {
                Text(receipt)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
                    .transition(.opacity)
            }

            if let error = voiceInput.errorMessage, !voiceInput.isListening {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .aidenComposerGlass()
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(palette.secondary.opacity(0.35), lineWidth: 0.5)
                .allowsHitTesting(false)
        }
        .shadow(color: .black.opacity(0.12), radius: 14, y: 6)
        .animation(
            reduceMotion ? nil : .smooth(duration: 0.34),
            value: visiblePendingAttachments.map(\.id) + attachmentPicker.committingAssets.map(\.localIdentifier)
        )
        .task {
            await model.startVoiceForLaunch(if: autoStartVoice) {
                model.readAloud.stop()
                await voiceInput.toggle(
                    currentDraft: model.draft,
                    updateDraft: { model.draft = $0 },
                    macTranscriber: model.transcribeMacSpeech
                )
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .aidenStopDictationForReadAloud)) { _ in
            voiceInput.cancelDiscardingRecording()
        }
        .onDisappear {
            voiceInput.cancelDiscardingRecording()
            model.cancelAttachmentPreparation()
        }
        .onChange(of: scenePhase) { _, phase in
            if AidenVoiceCaptureLifecyclePolicy.shouldDiscardRecording(for: phase) {
                voiceInput.cancelDiscardingRecording()
            }
        }
    }

    private var visiblePendingAttachments: [AidenAttachmentReference] {
        guard !attachmentPicker.committingAssets.isEmpty else { return model.pendingAttachments }
        return Array(model.pendingAttachments.prefix(attachmentPicker.committingPendingPrefixCount))
    }

    /// One pill while a run streams, matching the desktop and Android control:
    /// the mode's name sends in that mode (touch and hold for the menu), and the
    /// chevron opens the same Steer/Queue menu.
    private var runInputPill: some View {
        HStack(spacing: 0) {
            Menu {
                runInputModeMenu
            } label: {
                Text(model.runInputMode.busyLabel)
                    .font(.subheadline.weight(.semibold))
                    .contentTransition(.interpolate)
                    .padding(.leading, 14)
                    .padding(.trailing, 4)
                    .frame(minHeight: 44)
            } primaryAction: {
                voiceInput.stopBeforeSubmittingDraft()
                Task { await model.submitRunInput(model.runInputMode) }
            }
            .accessibilityLabel(model.runInputMode.busyActionLabel)
            .accessibilityHint(String(localized: "Touch and hold to choose Steer or Queue"))

            Menu {
                runInputModeMenu
            } label: {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.bold))
                    .padding(.leading, 4)
                    .padding(.trailing, 12)
                    .frame(minHeight: 44)
            }
            .accessibilityLabel(String(localized: "Choose message action"))
        }
        .foregroundStyle(runInputButtonForeground)
        .background(runInputButtonBackground, in: Capsule().inset(by: 7))
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(model.isStopping || model.isSubmittingRunInput || model.isReadOnlyPresentation)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: model.runInputMode)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: model.canSubmitRunInput)
    }

    @ViewBuilder
    private var runInputModeMenu: some View {
        ForEach(AidenStreamInputMode.busyModes, id: \.self) { mode in
            Button {
                voiceInput.stopBeforeSubmittingDraft()
                Task { await model.selectRunInputMode(mode) }
            } label: {
                if model.runInputMode == mode {
                    Label {
                        Text(mode.busyLabel)
                        Text(mode.busyDetail)
                    } icon: {
                        Image(systemName: "checkmark")
                    }
                } else {
                    Text(mode.busyLabel)
                    Text(mode.busyDetail)
                }
            }
            .accessibilityAddTraits(model.runInputMode == mode ? .isSelected : [])
        }
    }

    private var runInputButtonBackground: Color {
        if model.canSubmitRunInput { return palette.fillAccent }
        return palette.foreground.opacity(colorScheme == .dark ? 0.18 : 0.12)
    }

    private var runInputButtonForeground: Color {
        model.canSubmitRunInput ? palette.onFillAccent : palette.secondary
    }

    private var selectedModelAccessibilityValue: String {
        guard let selectedModel = model.selectedModel else { return model.selectedModelDisplayLabel }
        guard let level = model.selectedThinkingLevel,
              selectedModel.thinkingLevels?.isEmpty == false
        else { return selectedModel.label }
        return "\(selectedModel.label), \(level.capitalized) thinking"
    }

    private func select(_ candidate: AidenModel, providerId: String, thinkingLevel: String?) {
        model.selectModel(
            providerId: providerId,
            modelId: candidate.id,
            thinkingLevel: thinkingLevel
        )
    }

    private func isSelected(
        _ candidate: AidenModel,
        providerId: String,
        thinkingLevel: String?
    ) -> Bool {
        guard model.selectedProviderId == providerId,
              model.selectedModelId == candidate.id
        else { return false }
        return thinkingLevel == nil || model.selectedThinkingLevel == thinkingLevel
    }
}

enum AidenVoiceCaptureLifecyclePolicy {
    static func shouldDiscardRecording(for phase: ScenePhase) -> Bool {
        phase == .background
    }
}

private struct AidenListeningWaveform: View {
    let isAnimated: Bool

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 12, paused: !isAnimated)) { context in
            let phase = isAnimated ? context.date.timeIntervalSinceReferenceDate * 7 : 0
            HStack(alignment: .center, spacing: 2) {
                ForEach(0..<5, id: \.self) { index in
                    let offset = Double(index) * 0.85
                    let amplitude = isAnimated ? abs(sin(phase + offset)) : 0.45
                    Capsule(style: .continuous)
                        .frame(width: 2.5, height: 19)
                        .scaleEffect(
                            x: 1,
                            y: (7 + (amplitude * 12)) / 19,
                            anchor: .center
                        )
                }
            }
            .frame(width: 24, height: 22)
        }
        .accessibilityHidden(true)
    }
}

private struct AidenComposerGlassModifier: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.aidenPalette) private var palette

    let enabled: Bool
    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)

    @ViewBuilder
    func body(content: Content) -> some View {
        if !enabled {
            content
        } else if !reduceTransparency {
            // The whole composer is a stable surface containing its own
            // interactive controls. Marking the container interactive causes
            // Liquid Glass to recompute multiple times during streamed updates.
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(palette.raised, in: shape)
        }
    }
}

extension View {
    func aidenComposerGlass(enabled: Bool = true) -> some View {
        modifier(AidenComposerGlassModifier(enabled: enabled))
    }
}

/// Compact composer palette for `/` skills and `@` roster/file mentions. The
/// panel is presentation only: skills hand the Mac an opaque lease, mentions
/// insert display text. It inherits the composer glass surface rather than
/// introducing a second floating container.
private struct AidenComposerSuggestionList: View {
    @Environment(\.aidenPalette) private var palette
    let suggestions: [AidenComposerSuggestion]
    let onSelect: (AidenComposerSuggestion) -> Void

    private let maximumRows = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(suggestions.prefix(maximumRows))) { suggestion in
                Button {
                    onSelect(suggestion)
                } label: {
                    row(for: suggestion)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isDisabled(suggestion))
                if suggestion.id != suggestions.prefix(maximumRows).last?.id {
                    Divider().opacity(0.35)
                }
            }
        }
        .background(palette.raised.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func isDisabled(_ suggestion: AidenComposerSuggestion) -> Bool {
        if case .skill(let entry) = suggestion { return !entry.available }
        return false
    }

    @ViewBuilder
    private func row(for suggestion: AidenComposerSuggestion) -> some View {
        switch suggestion {
        case .skill(let entry):
            HStack(spacing: 8) {
                Image(systemName: "slash.circle")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("/\(entry.name)")
                        .font(.callout.weight(.medium))
                        .foregroundStyle(entry.available ? palette.foreground : palette.secondary)
                        .lineLimit(1)
                    Text(entry.available ? entry.description : (entry.unavailableReason ?? ""))
                        .font(.caption)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Text(entry.source.rawValue)
                    .font(.caption2)
                    .foregroundStyle(palette.secondary.opacity(0.85))
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                entry.available
                    ? "Skill \(entry.name)"
                    : "Skill \(entry.name), unavailable"
            )
        case .agent(let agent):
            HStack(spacing: 8) {
                Image(systemName: "person.crop.square")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18)
                Text(agent.label)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text("agent")
                    .font(.caption2)
                    .foregroundStyle(palette.secondary.opacity(0.85))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Mention agent \(agent.label)")
        case .file(let entry):
            HStack(spacing: 8) {
                Image(systemName: "doc")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(palette.secondary)
                    .frame(width: 18)
                Text(entry.displayPath)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(palette.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                Text("file")
                    .font(.caption2)
                    .foregroundStyle(palette.secondary.opacity(0.85))
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Mention file \(entry.displayPath)")
        }
    }
}
