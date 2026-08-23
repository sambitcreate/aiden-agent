import SwiftUI

private struct AidenBotsHomeLoadID: Equatable {
    let instanceID: String?
    let deviceID: String?
    let connectionState: AidenRemoteConnectionState
}

private struct AidenBotsSearchID: Equatable {
    let loadID: AidenBotsHomeLoadID
    let query: String
}

private enum AidenBotsHomeSheet: Identifiable {
    case editor(AidenBotEditorMode)
    case profile(AidenBotSummary)

    var id: String {
        switch self {
        case let .editor(mode): "editor-\(mode.id)"
        case let .profile(bot): "profile-\(bot.id)"
        }
    }
}

enum AidenBotsHomeContentState: Equatable {
    case loading
    case empty
    case noResults
    case content
}

func aidenBotsHomeContentState(
    hasSnapshot: Bool,
    isLoading: Bool,
    totalBotCount: Int,
    activeBotCount: Int,
    conversationCount: Int,
    hasQuery: Bool,
    filteredBotCount: Int,
    filteredConversationCount: Int
) -> AidenBotsHomeContentState {
    if !hasSnapshot && isLoading { return .loading }
    if totalBotCount == 0 && conversationCount == 0 { return .empty }
    if hasQuery && filteredBotCount == 0 && filteredConversationCount == 0 { return .noResults }
    return .content
}

func aidenBotCanStartNewChat(health: AidenBotHealth, canWrite: Bool) -> Bool {
    canWrite && health == .ready
}

struct AidenBotInboxActivityStatus: Equatable {
    let label: String
    let symbol: String
}

func aidenBotInboxActivityStatus(
    state: AidenBotConversationActivityState,
    canRespondToApproval: Bool
) -> AidenBotInboxActivityStatus? {
    switch state {
    case .idle: nil
    case .queued: .init(label: "Queued", symbol: "clock")
    case .running: .init(label: "Working", symbol: "waveform")
    case .waitingForApproval:
        canRespondToApproval
            ? .init(label: "Approval needed", symbol: "checkmark.shield")
            : .init(label: "Waiting for approval on Mac", symbol: "desktopcomputer")
    case .reconciling: .init(label: "Updating", symbol: "arrow.triangle.2.circlepath")
    }
}

struct AidenBotsHomeView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    let area: AidenProductArea
    let availability: AidenBotsAvailability
    let navigationStore: AidenProductNavigationStore
    let onSelectArea: (AidenProductArea) -> Void
    let onOpenConversation: (AidenBotConversationItem) async -> Void
    let onCreateConversation: (AidenBotSummary) async -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var snapshot: AidenBotCacheSnapshot?
    @State private var query = ""
    @State private var remoteSearchResults: [AidenBotConversationItem]?
    @State private var isLoading = false
    @State private var isChoosingBot = false
    @State private var isCreatingConversation = false
    @State private var presentedSheet: AidenBotsHomeSheet?
    @State private var loadError: String?
    @State private var loadGeneration: UInt = 0

    private var loadID: AidenBotsHomeLoadID {
        AidenBotsHomeLoadID(
            instanceID: coordinator.activeInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId,
            connectionState: coordinator.connectionState
        )
    }

    private var activeBots: [AidenBotSummary] {
        allBots.filter { $0.health != .archived }
    }

    private var chatReadyBots: [AidenBotSummary] {
        activeBots.filter { $0.health == .ready }
    }

    private var selectedBot: AidenBotSummary? {
        get {
            let installation = coordinator.installationStore.activeInstallation
            guard let id = navigationStore.selectedBot(
                for: installation?.id,
                deviceID: installation?.deviceId
            ) else { return nil }
            return allBots.first { $0.id == id }
        }
        nonmutating set {
            let installation = coordinator.installationStore.activeInstallation
            navigationStore.setSelectedBot(
                newValue?.id,
                for: installation?.id,
                deviceID: installation?.deviceId
            )
        }
    }

    private var allBots: [AidenBotSummary] {
        snapshot?.list?.bots ?? []
    }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredBots: [AidenBotSummary] {
        guard !normalizedQuery.isEmpty else { return activeBots }
        return activeBots.filter {
            $0.name.localizedCaseInsensitiveContains(normalizedQuery)
                || $0.purpose.localizedCaseInsensitiveContains(normalizedQuery)
        }
    }

    private var filteredConversations: [AidenBotConversationItem] {
        let conversations = allConversations
        guard !normalizedQuery.isEmpty else { return conversations }
        if let remoteSearchResults { return remoteSearchResults }
        return conversations.filter { conversation in
            let botName = allBots.first(where: { $0.id == conversation.botId })?.name ?? ""
            return conversation.title.localizedCaseInsensitiveContains(normalizedQuery)
                || (conversation.preview?.localizedCaseInsensitiveContains(normalizedQuery) == true)
                || botName.localizedCaseInsensitiveContains(normalizedQuery)
        }
    }

    private var allConversations: [AidenBotConversationItem] {
        snapshot?.conversations?.conversations ?? []
    }

    private var searchID: AidenBotsSearchID {
        AidenBotsSearchID(loadID: loadID, query: normalizedQuery)
    }

    private var favoriteBots: [AidenBotSummary] {
        let ids = snapshot?.list?.favorites.botIds ?? []
        return ids.compactMap { id in filteredBots.first(where: { $0.id == id }) }
    }

    private var contentState: AidenBotsHomeContentState {
        aidenBotsHomeContentState(
            hasSnapshot: snapshot != nil,
            isLoading: isLoading,
            totalBotCount: allBots.count,
            activeBotCount: activeBots.count,
            conversationCount: allConversations.count,
            hasQuery: !normalizedQuery.isEmpty,
            filteredBotCount: filteredBots.count,
            filteredConversationCount: filteredConversations.count
        )
    }

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    homeScroll
                        .navigationTitle("Bots")
                        .navigationBarTitleDisplayMode(.inline)
                } detail: {
                    if let selectedBot {
                        AidenBotProfileView(
                            coordinator: coordinator,
                            initialSummary: selectedBot,
                            onOpenConversation: onOpenConversation,
                            onCreateConversation: onCreateConversation,
                            onChanged: { Task { await load() } },
                            showsDismissButton: false
                        )
                        .id("\(loadID.instanceID ?? "none")-\(loadID.deviceID ?? "none")-\(selectedBot.id)")
                    } else {
                        ContentUnavailableView(
                            "Choose a Bot",
                            systemImage: "person.crop.circle.badge.checkmark",
                            description: Text("Select a Bot to view its profile and recent chats.")
                        )
                    }
                }
            } else {
                homeScroll
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case let .editor(mode):
                AidenBotEditorView(coordinator: coordinator, mode: mode) { _ in
                    Task { await load() }
                }
            case let .profile(bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    initialSummary: bot,
                    onOpenConversation: onOpenConversation,
                    onCreateConversation: onCreateConversation,
                    onChanged: { Task { await load() } }
                )
            }
        }
        .task(id: loadID) {
            await load()
        }
        .task(id: searchID) {
            await searchConversations()
        }
    }

    private var homeScroll: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                if let loadError {
                    statusBanner(loadError)
                }
                content
            }
            .padding(.bottom, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomDock
        }
        .confirmationDialog("New Chat", isPresented: $isChoosingBot, titleVisibility: .visible) {
            ForEach(chatReadyBots) { bot in
                Button(bot.name) {
                    isCreatingConversation = true
                    Task {
                        await onCreateConversation(bot)
                        isCreatingConversation = false
                    }
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Choose a Bot to start a new chat.")
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            AidenProductSwitcherButton(
                area: area,
                botsAvailability: availability,
                onSelect: onSelectArea
            )
            .frame(width: 52, height: 52)

            Text("Bots")
                .font(.largeTitle.bold())
                .foregroundStyle(palette.foreground)
            Spacer()
            Button {
                presentedSheet = .editor(.create(defaultAccess: .recommended))
            } label: {
                Image(systemName: "plus")
                    .font(.title3.weight(.semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canCreateBot)
            .accessibilityLabel("New Bot")
            .accessibilityHint("Opens the Bot editor. Nothing is created until you save.")
            if isLoading {
                ProgressView()
                    .accessibilityLabel("Refreshing Bots")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 14)
    }

    @ViewBuilder
    private var content: some View {
        if contentState == .loading {
            ProgressView("Loading Bots…")
                .frame(maxWidth: .infinity)
                .padding(.top, 80)
        } else if contentState == .empty {
            ContentUnavailableView {
                Label(
                    coordinator.connectionState == .connected ? "Make your first Bot" : "No saved Bots",
                    systemImage: "message"
                )
            } description: {
                Text(
                    coordinator.connectionState == .connected
                        ? "Create a Bot to give a familiar helper its own conversations and capabilities."
                        : "Reconnect to your Mac to load Bots."
                )
            } actions: {
                if coordinator.connectionState == .connected {
                    Button("New Bot") {
                        presentedSheet = .editor(.create(defaultAccess: .recommended))
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canCreateBot)
                }
            }
            .padding(.top, 54)
        } else if contentState == .noResults {
            ContentUnavailableView.search(text: normalizedQuery)
                .padding(.top, 54)
        } else {
            if !favoriteBots.isEmpty {
                Text("Favorites")
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 10)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 18) {
                        ForEach(favoriteBots) { bot in
                            Button {
                                presentProfile(bot)
                            } label: {
                                VStack(spacing: 8) {
                                    botAvatar(bot, diameter: 72)
                                    Text(bot.name)
                                        .font(.caption.weight(.medium))
                                        .foregroundStyle(palette.foreground)
                                        .lineLimit(1)
                                        .frame(width: 76)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .combine)
                            .accessibilityHint("Opens this Bot’s profile.")
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .padding(.bottom, 18)
            }

            if !filteredBots.isEmpty {
                Text("Bots")
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                ForEach(filteredBots) { bot in
                    Button {
                        presentProfile(bot)
                    } label: {
                        botProfileRow(bot)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this Bot’s profile.")
                }
            }

            if !filteredConversations.isEmpty {
                Text("Chats")
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                ForEach(filteredConversations) { conversation in
                    Button {
                        Task { await onOpenConversation(conversation) }
                    } label: {
                        conversationRow(conversation)
                    }
                    .buttonStyle(.plain)
                    .disabled(coordinator.connectionState != .connected)
                    .accessibilityHint(
                        coordinator.connectionState == .connected
                            ? "Opens this Bot chat."
                            : "Reconnect to open this saved chat."
                    )
                }
            }

            let archivedBots = allBots.filter { $0.health == .archived }
            if normalizedQuery.isEmpty, !archivedBots.isEmpty {
                Text("Archived")
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .padding(.top, 18)
                    .padding(.bottom, 8)
                ForEach(archivedBots) { bot in
                    Button {
                        presentProfile(bot)
                    } label: {
                        botProfileRow(bot)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this archived Bot’s read-only profile.")
                }
            }
        }
    }

    private var bottomDock: some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(palette.foreground)
                    .accessibilityHidden(true)
                TextField("Search", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityLabel("Search Bots and chats")
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(palette.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 17)
            .frame(minHeight: 54)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay { Capsule().stroke(palette.foreground.opacity(0.12), lineWidth: 0.5) }

            Button { isChoosingBot = true } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(palette.foreground)
                    .frame(width: 54, height: 54)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(
                !availability.canWrite
                    || coordinator.connectionState != .connected
                    || chatReadyBots.isEmpty
                    || isCreatingConversation
            )
            .background(.ultraThinMaterial, in: Circle())
            .overlay { Circle().stroke(palette.foreground.opacity(0.12), lineWidth: 0.5) }
            .accessibilityLabel("New Chat")
            .accessibilityHint("Choose a Bot to start a new chat.")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var canCreateBot: Bool {
        availability.canWrite
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    private func presentProfile(_ bot: AidenBotSummary) {
        if horizontalSizeClass == .regular {
            selectedBot = bot
        } else {
            presentedSheet = .profile(bot)
        }
    }

    private func conversationRow(_ conversation: AidenBotConversationItem) -> some View {
        let bot = allBots.first(where: { $0.id == conversation.botId })
        return HStack(spacing: 14) {
            if let bot {
                botAvatar(bot, diameter: 52)
            } else {
                AidenBotSemanticAvatarView(
                    avatar: .recipe(AidenBotEditorDraft.defaultAvatar),
                    name: "Bot",
                    size: 52
                )
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(bot?.name ?? "Bot")
                        .font(.headline)
                    Spacer()
                    Text(conversation.updatedAt, style: .time)
                        .font(.subheadline)
                        .foregroundStyle(palette.secondary)
                }
                Text(conversation.preview ?? conversation.title)
                    .font(.body)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(2)
                if let status = aidenBotInboxActivityStatus(
                    state: conversation.activityState,
                    canRespondToApproval: conversation.canRespondToApproval
                ) {
                    Label(status.label, systemImage: status.symbol)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(palette.accent)
                }
            }
            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(palette.secondary.opacity(0.7))
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    private func botProfileRow(_ bot: AidenBotSummary) -> some View {
        HStack(spacing: 14) {
            botAvatar(bot, diameter: 52)
            VStack(alignment: .leading, spacing: 4) {
                Text(bot.name)
                    .font(.headline)
                    .foregroundStyle(palette.foreground)
                Text(bot.purpose.isEmpty ? (bot.health == .archived ? "Archived" : "Bot") : bot.purpose)
                    .font(.subheadline)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption.bold())
                .foregroundStyle(palette.secondary.opacity(0.7))
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }

    private func botAvatar(_ bot: AidenBotSummary, diameter: CGFloat) -> some View {
        AidenBotSemanticAvatarView(
            avatar: bot.avatar.semantic,
            name: bot.name,
            size: diameter
        )
    }

    private func statusBanner(_ message: String) -> some View {
        Label(message, systemImage: coordinator.connectionState == .connected ? "exclamationmark.triangle" : "wifi.slash")
            .font(.footnote)
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
    }

    @MainActor
    private func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        let expectedLoadID = loadID
        guard let installation = coordinator.installationStore.activeInstallation else {
            snapshot = nil
            isLoading = false
            return
        }
        snapshot = nil
        loadError = nil
        isLoading = coordinator.connectionState == .connected
        let activation = await AidenBotCache.shared.activate(
            instanceId: installation.id,
            deviceId: installation.deviceId
        )
        if coordinator.connectionState != .connected {
            let cached = await AidenBotCache.shared.load(
                instanceId: installation.id,
                deviceId: installation.deviceId
            )
            guard coordinator.installationStore.activeInstallation?.id == installation.id,
                  coordinator.installationStore.activeInstallation?.deviceId == installation.deviceId,
                  loadGeneration == generation,
                  loadID == expectedLoadID,
                  await AidenBotCache.shared.isCurrent(activation),
                  !Task.isCancelled else { return }
            snapshot = cached
            validateSelectedBot(in: cached?.list?.bots ?? [])
            loadError = cached == nil ? nil : "Offline — showing saved Bots"
            isLoading = false
            return
        }

        var capturedContext: AidenRemoteRequestContext?
        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            // Archived Bots remain the identity owner of their readable chat history.
            // Keep them in the projection/cache, then filter them only from creation
            // and favorites controls.
            async let listRequest = client.bots(includeArchived: true)
            async let conversationRequest = client.botConversations()
            let (list, conversations) = try await (listRequest, conversationRequest)
            guard coordinator.isCurrent(context), loadGeneration == generation,
                  loadID == expectedLoadID, !Task.isCancelled else { return }
            let refreshed = AidenBotCacheSnapshot(
                list: list,
                conversations: conversations,
                savedAt: Date()
            )
            var cacheAccepted = false
            var cacheWriteFailed = false
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                do {
                    cacheAccepted = try await AidenBotCache.shared.store(
                        refreshed,
                        activation: activation
                    )
                } catch {
                    cacheWriteFailed = true
                }
            }
            guard retained,
                  coordinator.isCurrent(context),
                  loadGeneration == generation,
                  loadID == expectedLoadID,
                  await AidenBotCache.shared.isCurrent(activation),
                  cacheAccepted || cacheWriteFailed else { return }
            snapshot = refreshed
            validateSelectedBot(in: list.bots)
            isLoading = false
            if cacheWriteFailed {
                loadError = "Bots loaded, but this iPhone couldn’t save them for offline use."
            }
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard loadGeneration == generation, loadID == expectedLoadID else { return }
            let cached = await AidenBotCache.shared.load(
                instanceId: installation.id,
                deviceId: installation.deviceId
            )
            guard coordinator.installationStore.activeInstallation?.id == installation.id,
                  coordinator.installationStore.activeInstallation?.deviceId == installation.deviceId,
                  loadGeneration == generation,
                  loadID == expectedLoadID,
                  await AidenBotCache.shared.isCurrent(activation),
                  !Task.isCancelled else { return }
            snapshot = cached
            validateSelectedBot(in: cached?.list?.bots ?? [])
            isLoading = false
            loadError = cached == nil
                ? error.localizedDescription
                : "Couldn’t refresh — showing saved Bots"
        }
    }

    @MainActor
    private func validateSelectedBot(in bots: [AidenBotSummary]) {
        guard let selectedID = navigationStore.selectedBot(
            for: coordinator.activeInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId
        ) else { return }
        if !bots.contains(where: { $0.id == selectedID }) {
            selectedBot = nil
        }
    }

    @MainActor
    private func searchConversations() async {
        let expected = searchID
        remoteSearchResults = nil
        guard !expected.query.isEmpty, coordinator.connectionState == .connected else { return }
        var capturedContext: AidenRemoteRequestContext?
        do {
            try await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled, searchID == expected else { return }
            let context = try coordinator.requestContext()
            capturedContext = context
            let client = try coordinator.remoteClient(for: context)
            var results: [AidenBotConversationItem] = []
            var cursor: String?
            var pages = 0
            repeat {
                let page = try await client.botConversations(query: try AidenBotConversationQuery(
                    cursor: cursor,
                    query: expected.query
                ))
                results.append(contentsOf: page.conversations)
                cursor = page.nextCursor
                pages += 1
            } while cursor != nil && pages < 10 && results.count < 1_000 && !Task.isCancelled
            guard coordinator.isCurrent(context), searchID == expected, !Task.isCancelled else { return }
            remoteSearchResults = results
        } catch is CancellationError {
            return
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard searchID == expected else { return }
            remoteSearchResults = nil
        }
    }
}
