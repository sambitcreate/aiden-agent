import SwiftUI

struct AidenBotProfileRoute: Identifiable, Equatable {
    let summary: AidenBotSummary
    var id: String { summary.id }
}

enum AidenBotFavoriteOrderMove: Equatable {
    case add
    case remove
    case earlier
    case later
}

func aidenBotFavoriteOrder(
    _ botIDs: [String],
    moving botID: String,
    _ move: AidenBotFavoriteOrderMove
) -> [String] {
    var result = botIDs.filter { $0 != botID }
    switch move {
    case .add:
        result.append(botID)
    case .remove:
        break
    case .earlier, .later:
        guard let oldIndex = botIDs.firstIndex(of: botID) else { return botIDs }
        let destination = move == .earlier ? max(0, oldIndex - 1) : min(botIDs.count - 1, oldIndex + 1)
        result.insert(botID, at: destination)
    }
    return result
}

func aidenBotConversationCanDelete(
    _ conversation: AidenBotConversationItem,
    botHealth: AidenBotHealth,
    canWrite: Bool
) -> Bool {
    canWrite && botHealth != .archived && conversation.activityState == .idle
}

struct AidenBotConversationSelectionAccessibility: Equatable {
    let value: String
    let isSelected: Bool
    let hint: String
}

func aidenBotConversationSelectionAccessibility(
    isSelecting: Bool,
    isSelected: Bool,
    canDelete: Bool,
    botHealth: AidenBotHealth,
    canWrite: Bool,
    activityState: AidenBotConversationActivityState
) -> AidenBotConversationSelectionAccessibility {
    guard isSelecting else {
        return .init(value: "", isSelected: false, hint: "Opens this chat.")
    }
    let hint: String
    if botHealth == .archived {
        hint = "Archived Bot chats are read-only."
    } else if !canWrite {
        hint = "Reconnect or refresh before selecting chats."
    } else if activityState != .idle {
        hint = "Active chats cannot be deleted."
    } else if canDelete {
        hint = "Selects this chat for deletion."
    } else {
        hint = "This chat cannot be deleted."
    }
    return .init(
        value: isSelected ? "Selected" : "Not selected",
        isSelected: isSelected,
        hint: hint
    )
}

enum AidenBotProfileLifecycleAction: Equatable {
    case archive
    case restore(idempotencyKey: UUID)
}

struct AidenBotProfileLifecycleResult: Equatable {
    let detail: AidenBotDetail
    let favorites: AidenBotFavorites
}

@MainActor
func aidenBotProfileLifecycleUpdate(
    client: AidenRemoteClient,
    botID: String,
    revision: String,
    action: AidenBotProfileLifecycleAction,
    isCurrent: () -> Bool
) async throws -> AidenBotProfileLifecycleResult {
    guard isCurrent() else { throw AidenRemoteClientError.installationChanged }
    let detail: AidenBotDetail
    switch action {
    case .archive:
        detail = try await client.archiveBot(id: botID, revision: revision)
    case let .restore(idempotencyKey):
        detail = try await client.restoreBot(
            id: botID,
            revision: revision,
            idempotencyKey: idempotencyKey
        )
    }
    guard isCurrent(), detail.id == botID else {
        throw AidenRemoteClientError.installationChanged
    }
    let favorites = try await client.botFavorites()
    guard isCurrent() else { throw AidenRemoteClientError.installationChanged }
    return .init(detail: detail, favorites: favorites)
}

@MainActor
@discardableResult
func aidenBotProfileDeleteConversation(
    client: AidenRemoteClient,
    projection: AidenBotConversationItem,
    expectedBotID: String,
    isCurrent: () -> Bool
) async throws -> AidenChat {
    guard isCurrent() else { throw AidenRemoteClientError.installationChanged }
    let chat = try await client.chat(id: projection.id)
    guard isCurrent() else { throw AidenRemoteClientError.installationChanged }
    guard chat.id == projection.id, chat.botId == expectedBotID else {
        throw AidenRemoteClientError.invalidResponse
    }
    try await client.removeChat(id: chat.id, revision: chat.revision)
    guard isCurrent() else { throw AidenRemoteClientError.installationChanged }
    return chat
}

private enum AidenBotProfileSheet: Identifiable {
    case edit(String)
    case access(String)

    var id: String {
        switch self {
        case let .edit(botID): "edit-\(botID)"
        case let .access(botID): "access-\(botID)"
        }
    }
}

private struct AidenBotProfileMutation: Equatable {
    enum Kind: Equatable {
        case favorites(revision: String, botIDs: [String])
        case archive(revision: String)
        case restore(revision: String, idempotencyKey: UUID)
        case deleteChats([(id: String, revision: String)])

        static func == (lhs: Self, rhs: Self) -> Bool {
            switch (lhs, rhs) {
            case let (.favorites(lRevision, lIDs), .favorites(rRevision, rIDs)):
                lRevision == rRevision && lIDs == rIDs
            case let (.archive(lhs), .archive(rhs)):
                lhs == rhs
            case let (.restore(lRevision, lKey), .restore(rRevision, rKey)):
                lRevision == rRevision && lKey == rKey
            case let (.deleteChats(lhs), .deleteChats(rhs)):
                lhs.map(\.id) == rhs.map(\.id) && lhs.map(\.revision) == rhs.map(\.revision)
            default:
                false
            }
        }
    }

    let context: AidenRemoteRequestContext
    let botID: String
    let kind: Kind
    let token: UUID
}

struct AidenBotProfileView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let initialSummary: AidenBotSummary
    let onOpenConversation: (AidenBotConversationItem) async -> Void
    let onCreateConversation: (AidenBotSummary) async -> Void
    var onChanged: () -> Void = { }
    var showsDismissButton = true

    @Environment(\.dismiss) private var dismiss
    @Environment(\.aidenPalette) private var palette
    @State private var detail: AidenBotDetail?
    @State private var favorites: AidenBotFavorites?
    @State private var conversations: [AidenBotConversationItem] = []
    @State private var capturedContext: AidenRemoteRequestContext?
    @State private var presentedSheet: AidenBotProfileSheet?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var mutationError: String?
    @State private var activeMutation: AidenBotProfileMutation?
    @State private var retainedRestore: (revision: String, key: UUID)?
    @State private var requiresRefreshAfterMutation = false
    @State private var isConfirmingArchive = false
    @State private var isConfirmingDelete = false
    @State private var isSelectingChats = false
    @State private var selectedChatIDs: Set<String> = []
    @State private var loadGeneration: UInt = 0

    private var botID: String { initialSummary.id }

    private var sessionIdentity: AidenBotCustomAccessSessionIdentity {
        AidenBotCustomAccessSessionIdentity(coordinator: coordinator)
    }

    private var isMutating: Bool { activeMutation != nil }

    private var canWrite: Bool {
        capturedContext.map(coordinator.isCurrent) == true
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
            && !requiresRefreshAfterMutation
            && !isMutating
    }

    private var isArchived: Bool { detail?.health == .archived }

    private var isFavorite: Bool { favorites?.botIds.contains(botID) == true }

    private var favoriteIndex: Int? { favorites?.botIds.firstIndex(of: botID) }

    private var deletableConversations: [AidenBotConversationItem] {
        guard let detail else { return [] }
        return conversations.filter {
            aidenBotConversationCanDelete($0, botHealth: detail.health, canWrite: canWrite)
        }
    }

    private var selectedDeletableConversations: [AidenBotConversationItem] {
        deletableConversations.filter { selectedChatIDs.contains($0.id) }
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Bot")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if showsDismissButton {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { dismiss() }
                                .disabled(isMutating)
                        }
                    }
                    if let detail {
                        ToolbarItem(placement: .primaryAction) {
                            lifecycleMenu(detail)
                        }
                    }
                }
        }
        .interactiveDismissDisabled(isMutating)
        .sheet(item: $presentedSheet, onDismiss: {
            let expectedSession = sessionIdentity
            Task { await load(for: expectedSession) }
        }) { sheet in
            switch sheet {
            case let .edit(botID):
                AidenBotEditorView(coordinator: coordinator, mode: .edit(botID: botID)) { _ in
                    let expectedSession = sessionIdentity
                    Task { await load(for: expectedSession) }
                    onChanged()
                }
            case let .access(botID):
                AidenBotCustomAccessFlowView(coordinator: coordinator, preferredBotID: botID)
            }
        }
        .task(id: sessionIdentity) {
            let expectedSession = sessionIdentity
            reset(for: expectedSession)
            await load(for: expectedSession)
        }
        .onChange(of: sessionIdentity) { oldValue, newValue in
            if showsDismissButton, capturedContext != nil, oldValue != newValue { dismiss() }
        }
        .confirmationDialog(
            "Archive this Bot?",
            isPresented: $isConfirmingArchive,
            titleVisibility: .visible
        ) {
            Button("Archive Bot", role: .destructive) {
                Task { await archive() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Its chats stay available to read. Restore the Bot later to edit it or start new work.")
        }
        .confirmationDialog(
            deleteConfirmationTitle,
            isPresented: $isConfirmingDelete,
            titleVisibility: .visible
        ) {
            Button(deleteConfirmationTitle, role: .destructive) {
                Task { await deleteSelectedChats() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Deleted chats and their messages cannot be recovered.")
        }
        .alert(
            "Couldn’t Complete the Change",
            isPresented: Binding(
                get: { mutationError != nil },
                set: { if !$0 { mutationError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { mutationError = nil }
        } message: {
            Text(mutationError ?? "The change could not be completed.")
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView("Loading Bot…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            ContentUnavailableView {
                Label("Couldn’t Load Bot", systemImage: "exclamationmark.bubble")
            } description: {
                Text(loadError)
            } actions: {
                Button("Try Again") {
                    let expectedSession = sessionIdentity
                    Task { await load(for: expectedSession) }
                }
            }
        } else if let detail {
            profile(detail)
        }
    }

    private func profile(_ detail: AidenBotDetail) -> some View {
        ScrollView {
            LazyVStack(spacing: 22) {
                identityHeader(detail)
                if detail.health == .archived {
                    Label(
                        "Archived — chats remain readable. Restore this Bot to make changes or start new chats.",
                        systemImage: "archivebox.fill"
                    )
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 16))
                }
                if requiresRefreshAfterMutation {
                    Button {
                        let expectedSession = sessionIdentity
                        Task { await load(for: expectedSession) }
                    } label: {
                        Label("Refresh before making another change", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                actionBar(detail)
                favoriteOrderCard(detail)
                conversationCard(detail)
                identityDetails(detail)
            }
            .frame(maxWidth: 680)
            .padding(.horizontal, 20)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity)
        }
        .background(palette.canvas.ignoresSafeArea())
        .refreshable {
            let expectedSession = sessionIdentity
            await load(for: expectedSession)
        }
    }

    private func identityHeader(_ detail: AidenBotDetail) -> some View {
        VStack(spacing: 12) {
            AidenBotCanonicalAvatarView(
                coordinator: coordinator,
                botID: detail.id,
                avatar: detail.avatar,
                name: detail.name,
                size: 112
            )
            Text(detail.name)
                .font(.largeTitle.bold())
                .multilineTextAlignment(.center)
                .foregroundStyle(palette.foreground)
            if !detail.purpose.isEmpty {
                Text(detail.purpose)
                    .font(.body)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(palette.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func actionBar(_ detail: AidenBotDetail) -> some View {
        HStack(alignment: .top, spacing: 12) {
            profileAction("New Chat", systemImage: "square.and.pencil") {
                guard detail.health == .ready else { return }
                if showsDismissButton { dismiss() }
                Task { await onCreateConversation(initialSummary) }
            }
            .disabled(!aidenBotCanStartNewChat(health: detail.health, canWrite: canWrite))
            .accessibilityHint(
                detail.health == .ready
                    ? "Starts a new chat with this Bot."
                    : "Repair this Bot’s access on the paired Mac before starting a new chat."
            )

            profileAction("Edit Bot", systemImage: "pencil") {
                presentedSheet = .edit(detail.id)
            }
            .disabled(!canWrite || detail.health == .archived)

            profileAction("Access", systemImage: "switch.2") {
                presentedSheet = .access(detail.id)
            }
            .disabled(!canWrite || detail.health == .archived)

            profileAction(
                isFavorite ? "Unfavorite" : "Favorite",
                systemImage: isFavorite ? "star.fill" : "star"
            ) {
                Task { await updateFavorite(isFavorite ? .remove : .add) }
            }
            .disabled(!canWrite || detail.health == .archived || favorites == nil)
        }
    }

    private func profileAction(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: systemImage)
                    .font(.title3.weight(.semibold))
                    .frame(width: 48, height: 42)
                    .background(palette.raised, in: RoundedRectangle(cornerRadius: 13))
                Text(title)
                    .font(.caption)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    @ViewBuilder
    private func favoriteOrderCard(_ detail: AidenBotDetail) -> some View {
        if isFavorite, let favoriteIndex, let favorites {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Favorite order", systemImage: "star.fill")
                        .font(.headline)
                    Spacer()
                    Text("\(favoriteIndex + 1) of \(favorites.botIds.count)")
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }
                HStack {
                    Button("Move Earlier", systemImage: "arrow.left") {
                        Task { await updateFavorite(.earlier) }
                    }
                    .disabled(!canWrite || detail.health == .archived || favoriteIndex == 0)
                    Spacer()
                    Button("Move Later", systemImage: "arrow.right") {
                        Task { await updateFavorite(.later) }
                    }
                    .disabled(
                        !canWrite || detail.health == .archived
                            || favoriteIndex == favorites.botIds.count - 1
                    )
                }
                .buttonStyle(.bordered)
            }
            .padding(16)
            .background(palette.raised, in: RoundedRectangle(cornerRadius: 18))
        }
    }

    private func conversationCard(_ detail: AidenBotDetail) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Recent Chats")
                    .font(.headline)
                Spacer()
                if isSelectingChats {
                    Button("Cancel") {
                        isSelectingChats = false
                        selectedChatIDs = []
                    }
                    if !selectedDeletableConversations.isEmpty {
                        Button("Delete (\(selectedDeletableConversations.count))", role: .destructive) {
                            isConfirmingDelete = true
                        }
                    }
                } else if !deletableConversations.isEmpty {
                    Button("Select") { isSelectingChats = true }
                }
            }
            .padding(16)

            Divider()
            if conversations.isEmpty {
                Text("No chats yet")
                    .foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            } else {
                ForEach(conversations) { conversation in
                    conversationRow(conversation, detail: detail)
                    if conversation.id != conversations.last?.id { Divider().padding(.leading, 56) }
                }
            }
        }
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 18))
    }

    private func conversationRow(
        _ conversation: AidenBotConversationItem,
        detail: AidenBotDetail
    ) -> some View {
        let canDelete = aidenBotConversationCanDelete(
            conversation,
            botHealth: detail.health,
            canWrite: canWrite
        )
        let accessibility = aidenBotConversationSelectionAccessibility(
            isSelecting: isSelectingChats,
            isSelected: selectedChatIDs.contains(conversation.id),
            canDelete: canDelete,
            botHealth: detail.health,
            canWrite: canWrite,
            activityState: conversation.activityState
        )
        return Button {
            if isSelectingChats {
                guard canDelete else { return }
                if selectedChatIDs.contains(conversation.id) {
                    selectedChatIDs.remove(conversation.id)
                } else {
                    selectedChatIDs.insert(conversation.id)
                }
            } else {
                if showsDismissButton { dismiss() }
                Task { await onOpenConversation(conversation) }
            }
        } label: {
            HStack(spacing: 12) {
                if isSelectingChats {
                    Image(systemName: selectedChatIDs.contains(conversation.id) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(canDelete ? palette.accent : palette.secondary)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: "message")
                        .foregroundStyle(palette.accent)
                        .frame(width: 28)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(conversation.title.isEmpty ? "New Chat" : conversation.title)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                    Text(conversation.preview ?? conversationStatus(conversation))
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Text(conversation.updatedAt, style: .relative)
                    .font(.caption)
                    .foregroundStyle(palette.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSelectingChats && !canDelete)
        .accessibilityValue(accessibility.value)
        .accessibilityAddTraits(
            accessibility.isSelected ? .isSelected : []
        )
        .accessibilityHint(accessibility.hint)
    }

    private func identityDetails(_ detail: AidenBotDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(detail.access.summary, systemImage: "switch.2")
            if let openingGreeting = detail.openingGreeting, !openingGreeting.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Greeting").font(.caption).foregroundStyle(palette.secondary)
                    Text(openingGreeting)
                }
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(palette.raised, in: RoundedRectangle(cornerRadius: 18))
    }

    private func lifecycleMenu(_ detail: AidenBotDetail) -> some View {
        Menu {
            if detail.health == .archived {
                Button("Restore Bot", systemImage: "arrow.uturn.backward") {
                    Task { await restore() }
                }
                .disabled(!canWrite)
            } else {
                Button("Archive Bot", systemImage: "archivebox", role: .destructive) {
                    isConfirmingArchive = true
                }
                .disabled(!canWrite)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .disabled(isMutating)
        .accessibilityLabel("Bot actions")
    }

    private var deleteConfirmationTitle: String {
        let count = selectedDeletableConversations.count
        return count == 1 ? "Delete Chat" : "Delete \(count) Chats"
    }

    private func conversationStatus(_ conversation: AidenBotConversationItem) -> String {
        switch conversation.activityState {
        case .idle: "No preview"
        case .queued: "Queued"
        case .running: "Working"
        case .waitingForApproval: "Waiting for approval"
        case .reconciling: "Updating"
        }
    }

    @MainActor
    private func reset(for expectedSession: AidenBotCustomAccessSessionIdentity) {
        guard sessionIdentity == expectedSession else { return }
        loadGeneration &+= 1
        detail = nil
        favorites = nil
        conversations = []
        capturedContext = nil
        presentedSheet = nil
        isLoading = true
        loadError = nil
        mutationError = nil
        activeMutation = nil
        retainedRestore = nil
        requiresRefreshAfterMutation = false
        isSelectingChats = false
        selectedChatIDs = []
    }

    @MainActor
    private func load(for expectedSession: AidenBotCustomAccessSessionIdentity) async {
        guard sessionIdentity == expectedSession, !isMutating else { return }
        loadGeneration &+= 1
        let generation = loadGeneration
        isLoading = true
        loadError = nil
        var requestContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            requestContext = context
            guard isCurrentLoad(generation, session: expectedSession, context: context) else { return }
            let client = try coordinator.remoteClient(for: context)
            async let detailRequest = client.bot(id: botID)
            async let favoritesRequest = client.botFavorites()
            async let conversationsRequest = client.botConversations(
                query: try AidenBotConversationQuery(botId: botID, limit: 50)
            )
            let (loadedDetail, loadedFavorites, page) = try await (
                detailRequest,
                favoritesRequest,
                conversationsRequest
            )
            guard isCurrentLoad(generation, session: expectedSession, context: context),
                  loadedDetail.id == botID, page.conversations.allSatisfy({ $0.botId == botID }),
                  !Task.isCancelled else { return }
            detail = loadedDetail
            favorites = loadedFavorites
            conversations = page.conversations
            capturedContext = context
            if retainedRestore?.revision != loadedDetail.revision {
                retainedRestore = nil
            }
            requiresRefreshAfterMutation = false
            isSelectingChats = false
            selectedChatIDs = []
            isLoading = false
        } catch is CancellationError {
            return
        } catch {
            if let context = requestContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard loadGeneration == generation, sessionIdentity == expectedSession else { return }
            capturedContext = nil
            loadError = error.localizedDescription
            isLoading = false
        }
    }

    @MainActor
    private func updateFavorite(_ move: AidenBotFavoriteOrderMove) async {
        guard canWrite, let context = capturedContext, coordinator.isCurrent(context),
              let detail, detail.health != .archived, let favorites else { return }
        let botIDs = aidenBotFavoriteOrder(favorites.botIds, moving: botID, move)
        guard botIDs != favorites.botIds else { return }
        let mutation = AidenBotProfileMutation(
            context: context,
            botID: botID,
            kind: .favorites(revision: favorites.revision, botIDs: botIDs),
            token: UUID()
        )
        activeMutation = mutation
        loadGeneration &+= 1
        mutationError = nil
        defer { if activeMutation == mutation { activeMutation = nil } }
        do {
            let update = try AidenBotFavoritesUpdateRequest(botIds: botIDs)
            guard isCurrent(mutation) else { return }
            let response = try await coordinator.remoteClient(for: context).updateBotFavorites(
                update,
                revision: favorites.revision
            )
            guard isCurrent(mutation) else { return }
            self.favorites = response
            onChanged()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard isCurrent(mutation) else { return }
            do {
                let authoritative = try await coordinator.remoteClient(for: context).botFavorites()
                guard isCurrent(mutation) else { return }
                self.favorites = authoritative
                if authoritative.botIds != botIDs {
                    mutationError = "Aiden refreshed the latest Favorites order. Review it before trying again."
                }
                onChanged()
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
                guard isCurrent(mutation) else { return }
                requiresRefreshAfterMutation = true
                mutationError = "Aiden could not confirm the latest Favorites order. Refresh before trying again."
            }
        }
    }

    @MainActor
    private func archive() async {
        guard canWrite, let context = capturedContext, coordinator.isCurrent(context),
              let detail, detail.health != .archived else { return }
        let mutation = AidenBotProfileMutation(
            context: context,
            botID: botID,
            kind: .archive(revision: detail.revision),
            token: UUID()
        )
        await performLifecycleMutation(mutation, action: .archive)
    }

    @MainActor
    private func restore() async {
        guard canWrite, let context = capturedContext, coordinator.isCurrent(context),
              let detail, detail.health == .archived else { return }
        let restore: (revision: String, key: UUID)
        if let retainedRestore, retainedRestore.revision == detail.revision {
            restore = retainedRestore
        } else {
            restore = (detail.revision, UUID())
            retainedRestore = restore
        }
        let mutation = AidenBotProfileMutation(
            context: context,
            botID: botID,
            kind: .restore(revision: restore.revision, idempotencyKey: restore.key),
            token: UUID()
        )
        await performLifecycleMutation(
            mutation,
            action: .restore(idempotencyKey: restore.key)
        )
    }

    @MainActor
    private func performLifecycleMutation(
        _ mutation: AidenBotProfileMutation,
        action: AidenBotProfileLifecycleAction
    ) async {
        activeMutation = mutation
        loadGeneration &+= 1
        mutationError = nil
        defer { if activeMutation == mutation { activeMutation = nil } }
        do {
            let revision: String
            switch mutation.kind {
            case let .archive(value), let .restore(value, _):
                revision = value
            default:
                return
            }
            let result = try await aidenBotProfileLifecycleUpdate(
                client: coordinator.remoteClient(for: mutation.context),
                botID: botID,
                revision: revision,
                action: action,
                isCurrent: { isCurrent(mutation) }
            )
            guard isCurrent(mutation) else { return }
            detail = result.detail
            favorites = result.favorites
            retainedRestore = nil
            onChanged()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: mutation.context) { return }
            guard isCurrent(mutation) else { return }
            requiresRefreshAfterMutation = true
            mutationError = "Aiden could not confirm the Bot’s latest state. Refresh before trying again."
        }
    }

    @MainActor
    private func deleteSelectedChats() async {
        guard canWrite, let context = capturedContext, coordinator.isCurrent(context),
              let detail, detail.health != .archived else { return }
        let selected = selectedDeletableConversations
        guard !selected.isEmpty else { return }
        let mutation = AidenBotProfileMutation(
            context: context,
            botID: botID,
            kind: .deleteChats(selected.map { ($0.id, $0.revision) }),
            token: UUID()
        )
        activeMutation = mutation
        loadGeneration &+= 1
        mutationError = nil
        var deletedCount = 0
        defer { if activeMutation == mutation { activeMutation = nil } }
        do {
            let client = try coordinator.remoteClient(for: context)
            for conversation in selected {
                guard isCurrent(mutation),
                      conversations.contains(where: {
                          $0.id == conversation.id && $0.revision == conversation.revision
                      }) else { return }
                _ = try await aidenBotProfileDeleteConversation(
                    client: client,
                    projection: conversation,
                    expectedBotID: botID,
                    isCurrent: {
                        isCurrent(mutation)
                            && conversations.contains(where: {
                                $0.id == conversation.id && $0.revision == conversation.revision
                            })
                    }
                )
                guard isCurrent(mutation) else { return }
                conversations.removeAll { $0.id == conversation.id }
                selectedChatIDs.remove(conversation.id)
                deletedCount += 1
            }
            isSelectingChats = false
            selectedChatIDs = []
            onChanged()
        } catch is CancellationError {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard isCurrent(mutation) else { return }
            do {
                let page = try await coordinator.remoteClient(for: context).botConversations(
                    query: try AidenBotConversationQuery(botId: botID, limit: 50)
                )
                guard isCurrent(mutation), page.conversations.allSatisfy({ $0.botId == botID }) else { return }
                conversations = page.conversations
                let remainingSelected = Set(selected.map(\.id)).intersection(
                    Set(page.conversations.map(\.id))
                )
                selectedChatIDs = remainingSelected
                if remainingSelected.isEmpty {
                    isSelectingChats = false
                    onChanged()
                    return
                }
                requiresRefreshAfterMutation = true
                mutationError = deletedCount == 0
                    ? "The selected chat still exists. Refresh before trying again."
                    : "Deleted \(deletedCount) chat\(deletedCount == 1 ? "" : "s"). Refresh before retrying the remaining selection."
                onChanged()
            } catch {
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
                guard isCurrent(mutation) else { return }
                requiresRefreshAfterMutation = true
                mutationError = "Aiden could not confirm the selected chats’ latest state. Refresh before trying again."
                onChanged()
            }
        }
    }

    @MainActor
    private func isCurrent(_ mutation: AidenBotProfileMutation) -> Bool {
        coordinator.isCurrent(mutation.context)
            && capturedContext == mutation.context
            && activeMutation == mutation
            && detail?.id == mutation.botID
    }

    @MainActor
    private func isCurrentLoad(
        _ generation: UInt,
        session: AidenBotCustomAccessSessionIdentity,
        context: AidenRemoteRequestContext
    ) -> Bool {
        loadGeneration == generation
            && activeMutation == nil
            && sessionIdentity == session
            && coordinator.isCurrent(context)
    }
}
