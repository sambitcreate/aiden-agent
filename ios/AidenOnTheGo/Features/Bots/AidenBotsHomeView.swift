import SwiftUI

private struct AidenBotsHomeLoadID: Equatable {
    let instanceID: String?
    let deviceID: String?
    let connectionState: AidenRemoteConnectionState
    let isBotSurfaceActive: Bool
}

private struct AidenBotsSearchID: Equatable {
    let loadID: AidenBotsHomeLoadID
    let query: String
}

struct AidenBotsHomeScope: Equatable {
    let instanceID: String
    let deviceID: String
}

struct AidenBotsFavoriteMutation: Equatable {
    let id: UUID
    let scope: AidenBotsHomeScope
    let botID: String
}

struct AidenBotsFavoriteMutationFinish: Equatable {
    let favoriteOverride: [String]?
    let favoriteError: String?
}

func aidenBotsFinishFavoriteMutation(
    current: AidenBotsFavoriteMutation?,
    finishing mutation: AidenBotsFavoriteMutation,
    restoring override: [String]?,
    error: String? = nil
) -> AidenBotsFavoriteMutationFinish? {
    guard current == mutation else { return nil }
    return AidenBotsFavoriteMutationFinish(
        favoriteOverride: override,
        favoriteError: error
    )
}

struct AidenBotContactSectionIDs: Equatable {
    let favorites: [String]
    let others: [String]
}

/// Produces the one-contact-per-Bot projection used by the inbox. Favorites
/// are a placement, not a duplicate copy, and search intentionally collapses
/// the screen into one ordered result list.
func aidenBotContactSectionIDs(
    matchingBotIDs: [String],
    activeBotIDs: [String],
    favoriteIDs: [String],
    isSearching: Bool
) -> AidenBotContactSectionIDs {
    guard !isSearching else {
        return AidenBotContactSectionIDs(favorites: [], others: matchingBotIDs)
    }

    let activeSet = Set(activeBotIDs)
    var seenFavorites = Set<String>()
    let visibleFavorites = favoriteIDs.filter { id in
        activeSet.contains(id) && seenFavorites.insert(id).inserted
    }
    let favoriteSet = Set(visibleFavorites)
    return AidenBotContactSectionIDs(
        favorites: visibleFavorites,
        others: matchingBotIDs.filter { !favoriteSet.contains($0) }
    )
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

func aidenBotUsesColdLoadingPlaceholder(
    isLoading: Bool,
    hasUsableContent: Bool
) -> Bool {
    isLoading && !hasUsableContent
}

/// Defensively resolves legacy or stale duplicate projections to one stable
/// chat per Bot. The Mac contract is authoritative and normally returns one;
/// newest activity wins, with chat identity as a deterministic tie-breaker.
func aidenCanonicalBotConversations(
    _ conversations: [AidenBotConversationItem]
) -> [AidenBotConversationItem] {
    var canonicalByBotID: [String: AidenBotConversationItem] = [:]
    for conversation in conversations {
        guard let current = canonicalByBotID[conversation.botId] else {
            canonicalByBotID[conversation.botId] = conversation
            continue
        }
        if conversation.updatedAt > current.updatedAt
            || (conversation.updatedAt == current.updatedAt
                && (conversation.createdAt > current.createdAt
                    || (conversation.createdAt == current.createdAt
                        && conversation.chatId < current.chatId))) {
            canonicalByBotID[conversation.botId] = conversation
        }
    }
    return conversations.filter { conversation in
        canonicalByBotID[conversation.botId]?.chatId == conversation.chatId
    }
}

/// A single layout-shaped placeholder shared by the Bot favorites, Bot list,
/// and chat list during a true cold load. Warm refreshes keep the last-good UI
/// in place and never show this view.
private struct AidenBotHomeSkeletonView: View {
    let reduceMotion: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AidenBotSkeletonBlock(width: 74, height: 16, radius: 8, reduceMotion: reduceMotion)
                .padding(.horizontal, 20)
                .padding(.bottom, 12)

            ViewThatFits(in: .horizontal) {
                favoritePlaceholders(diameter: 72, spacing: 18)
                favoritePlaceholders(diameter: 56, spacing: 12)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 22)

            AidenBotSkeletonBlock(width: 38, height: 16, radius: 8, reduceMotion: reduceMotion)
                .padding(.horizontal, 20)
                .padding(.bottom, 8)

            ForEach(0..<3, id: \.self) { index in
                HStack(spacing: 14) {
                    AidenBotSkeletonBlock(width: 52, height: 52, radius: 26, reduceMotion: reduceMotion)
                    VStack(alignment: .leading, spacing: 8) {
                        AidenBotSkeletonBlock(
                            width: index == 1 ? 126 : 104,
                            height: 15,
                            radius: 7.5,
                            reduceMotion: reduceMotion
                        )
                        AidenBotSkeletonBlock(
                            width: index == 2 ? 160 : 180,
                            height: 12,
                            radius: 6,
                            reduceMotion: reduceMotion
                        )
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 11)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading Bots")
    }

    private func favoritePlaceholders(diameter: CGFloat, spacing: CGFloat) -> some View {
        HStack(spacing: spacing) {
            ForEach(0..<4, id: \.self) { _ in
                VStack(spacing: 8) {
                    AidenBotSkeletonBlock(
                        width: diameter,
                        height: diameter,
                        radius: diameter / 2,
                        reduceMotion: reduceMotion
                    )
                    AidenBotSkeletonBlock(width: 48, height: 10, radius: 5, reduceMotion: reduceMotion)
                }
            }
        }
    }
}

struct AidenBotSkeletonBlock: View {
    @Environment(\.aidenPalette) private var palette
    let width: CGFloat?
    let height: CGFloat
    let radius: CGFloat
    let reduceMotion: Bool

    var body: some View {
        GeometryReader { proxy in
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(palette.raised)
                .overlay {
                    if !reduceMotion {
                        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                            let duration = 1.6
                            let elapsed = timeline.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: duration)
                            let progress = elapsed / duration
                            LinearGradient(
                                colors: [
                                    .clear,
                                    palette.foreground.opacity(0.12),
                                    .clear,
                                ],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                            .frame(width: max(24, proxy.size.width * 0.7))
                            .offset(x: (-proxy.size.width * 0.85) + (proxy.size.width * 1.7 * progress))
                            .mask {
                                RoundedRectangle(cornerRadius: radius, style: .continuous)
                            }
                        }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
        .frame(width: width, height: height)
        .accessibilityHidden(true)
    }
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
    @Binding var isShowingSwitcherCoachmark: Bool
    let onSelectArea: (AidenProductArea) -> Void
    let onOpenConversation: (AidenBotConversationItem) async -> Void
    let onCreateConversation: (AidenBotSummary) async -> Void

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var snapshot: AidenBotCacheSnapshot?
    @State private var snapshotScope: AidenBotsHomeScope?
    @State private var query = ""
    @State private var remoteSearchResults: [AidenBotConversationItem]?
    @State private var isLoading = false
    @State private var isChoosingBot = false
    @State private var isCreatingConversation = false
    @State private var favoriteOverride: [String]?
    @State private var favoriteMutation: AidenBotsFavoriteMutation?
    @State private var presentedSheet: AidenBotsHomeSheet?
    @State private var loadError: String?
    @State private var favoriteError: String?
    @State private var loadGeneration: UInt = 0

    private var loadID: AidenBotsHomeLoadID {
        AidenBotsHomeLoadID(
            instanceID: coordinator.activeInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId,
            connectionState: coordinator.connectionState,
            isBotSurfaceActive: aidenBotSurfaceIsActive(
                area: area,
                availability: availability
            )
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

    private var allConversations: [AidenBotConversationItem] {
        aidenCanonicalBotConversations(snapshot?.conversations?.conversations ?? [])
    }

    private var conversationByBotID: [String: AidenBotConversationItem] {
        Dictionary(uniqueKeysWithValues: allConversations.map { ($0.botId, $0) })
    }

    private var searchID: AidenBotsSearchID {
        AidenBotsSearchID(loadID: loadID, query: normalizedQuery)
    }

    private var favoriteIDs: [String] {
        favoriteOverride ?? snapshot?.list?.favorites.botIds ?? []
    }

    private var favoriteIDSet: Set<String> { Set(favoriteIDs) }

    private var matchingBots: [AidenBotSummary] {
        let remoteConversationBotIDs = Set(remoteSearchResults?.map(\.botId) ?? [])
        let candidates = allBots.filter { bot in
            guard !normalizedQuery.isEmpty else { return true }
            let conversation = conversationByBotID[bot.id]
            return bot.name.localizedCaseInsensitiveContains(normalizedQuery)
                || bot.purpose.localizedCaseInsensitiveContains(normalizedQuery)
                || (conversation?.title.localizedCaseInsensitiveContains(normalizedQuery) == true)
                || (conversation?.preview?.localizedCaseInsensitiveContains(normalizedQuery) == true)
                || remoteConversationBotIDs.contains(bot.id)
        }
        return candidates.sorted { lhs, rhs in
            let leftDate = conversationByBotID[lhs.id]?.updatedAt ?? lhs.updatedAt
            let rightDate = conversationByBotID[rhs.id]?.updatedAt ?? rhs.updatedAt
            if leftDate != rightDate { return leftDate > rightDate }
            let nameOrder = lhs.name.localizedStandardCompare(rhs.name)
            if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
            return lhs.id < rhs.id
        }
    }

    private var contactSectionIDs: AidenBotContactSectionIDs {
        aidenBotContactSectionIDs(
            matchingBotIDs: matchingBots.map(\.id),
            activeBotIDs: activeBots.map(\.id),
            favoriteIDs: favoriteIDs,
            isSearching: !normalizedQuery.isEmpty
        )
    }

    private var favoriteBots: [AidenBotSummary] {
        let activeByID = Dictionary(uniqueKeysWithValues: activeBots.map { ($0.id, $0) })
        return contactSectionIDs.favorites.compactMap { activeByID[$0] }
    }

    private var otherBots: [AidenBotSummary] {
        let matchingByID = Dictionary(uniqueKeysWithValues: matchingBots.map { ($0.id, $0) })
        return contactSectionIDs.others.compactMap { matchingByID[$0] }
    }

    private var contentState: AidenBotsHomeContentState {
        aidenBotsHomeContentState(
            hasSnapshot: snapshot != nil,
            isLoading: isLoading,
            totalBotCount: allBots.count,
            activeBotCount: activeBots.count,
            conversationCount: allConversations.count,
            hasQuery: !normalizedQuery.isEmpty,
            filteredBotCount: matchingBots.count,
            filteredConversationCount: 0
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
        .alert("Couldn’t Update Favorites", isPresented: Binding(
            get: { favoriteError != nil },
            set: { if !$0 { favoriteError = nil } }
        )) {
            Button("OK", role: .cancel) { favoriteError = nil }
        } message: {
            Text(favoriteError ?? "The operation could not be completed.")
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
        .confirmationDialog("Choose a Bot", isPresented: $isChoosingBot, titleVisibility: .visible) {
            ForEach(chatReadyBots) { bot in
                Button(bot.name) {
                    openOrCreateConversation(for: bot)
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Open this Bot’s chat. Aiden starts it the first time if needed.")
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            AidenProductSwitcherButton(
                area: area,
                botsAvailability: availability,
                isCoachmarkPresented: $isShowingSwitcherCoachmark,
                onSelect: onSelectArea
            )
            .frame(width: 68, height: 52)

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
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 14)
    }

    @ViewBuilder
    private var content: some View {
        if contentState == .loading {
            AidenBotHomeSkeletonView(reduceMotion: reduceMotion)
        } else if contentState == .empty {
            ContentUnavailableView {
                Label(
                    coordinator.connectionState == .connected ? "Make your first Bot" : "No saved Bots",
                    systemImage: "message"
                )
            } description: {
                Text(
                    coordinator.connectionState == .connected
                        ? "Create a Bot to give a familiar helper one persistent conversation and its own capabilities."
                        : "Reconnect to your Mac to load Bots."
                )
            } actions: {
                if coordinator.connectionState == .connected {
                    Button("New Bot") {
                        presentedSheet = .editor(.create(defaultAccess: .recommended))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(palette.accent)
                    .foregroundStyle(palette.onAccent)
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
                                openOrCreateConversation(for: bot)
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
                            .contextMenu { botContextMenu(bot) }
                            .accessibilityElement(children: .combine)
                            .accessibilityLabel("\(bot.name), favorite")
                            .accessibilityHint(openHint(for: bot))
                            .accessibilityActions {
                                if canUpdateFavorite(bot, adding: false) {
                                    Button("Unpin from Favorites") {
                                        updateFavoriteFromAccessibility(bot, move: .remove)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .padding(.bottom, 18)
            }

            if !otherBots.isEmpty {
                Text("Bots")
                    .font(.headline)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 8)
                ForEach(otherBots) { bot in
                    Button {
                        openOrCreateConversation(for: bot)
                    } label: {
                        botContactRow(bot)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { botContextMenu(bot) }
                    .accessibilityHint(openHint(for: bot))
                    .accessibilityActions {
                        let isFavorite = favoriteIDSet.contains(bot.id)
                        if canUpdateFavorite(bot, adding: !isFavorite) {
                            Button(isFavorite ? "Unpin from Favorites" : "Pin to Favorites") {
                                updateFavoriteFromAccessibility(
                                    bot,
                                    move: isFavorite ? .remove : .add
                                )
                            }
                        }
                    }
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
                    .accessibilityLabel("Search Bots")
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
            .accessibilityLabel("Open Bot Chat")
            .accessibilityHint("Choose a Bot to open its chat.")
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

    private func canOpen(_ bot: AidenBotSummary) -> Bool {
        guard coordinator.connectionState == .connected else { return false }
        if conversationByBotID[bot.id] != nil { return true }
        return bot.health == .ready && canCreateBot
    }

    private func openHint(for bot: AidenBotSummary) -> String {
        guard coordinator.connectionState == .connected else {
            return "Reconnect to open this Bot’s saved conversation."
        }
        if conversationByBotID[bot.id] != nil {
            return "Opens this Bot’s conversation."
        }
        if bot.health == .ready, canCreateBot {
            return "Starts this Bot’s conversation."
        }
        return "Open Bot Details to review why this Bot cannot start a conversation."
    }

    private func canUpdateFavorite(_ bot: AidenBotSummary, adding: Bool) -> Bool {
        guard bot.health != .archived,
              favoriteMutation == nil,
              canCreateBot else { return false }
        return !adding || favoriteIDs.count < AidenBotFavorites.maximumCount
    }

    private func updateFavoriteFromAccessibility(
        _ bot: AidenBotSummary,
        move: AidenBotFavoriteOrderMove
    ) {
        let adding = move == .add
        guard canUpdateFavorite(bot, adding: adding) else { return }
        Task { await updateFavorite(bot, move: move) }
    }

    @MainActor
    private func updateFavorite(
        _ bot: AidenBotSummary,
        move: AidenBotFavoriteOrderMove
    ) async {
        let adding = move == .add
        guard canUpdateFavorite(bot, adding: adding),
              let installation = coordinator.installationStore.activeInstallation,
              let list = snapshot?.list else { return }
        let scope = AidenBotsHomeScope(
            instanceID: installation.id,
            deviceID: installation.deviceId
        )
        let mutation = AidenBotsFavoriteMutation(id: UUID(), scope: scope, botID: bot.id)
        let currentFavorites = list.favorites
        let nextIDs = aidenBotFavoriteOrder(favoriteIDs, moving: bot.id, move)
        guard nextIDs != favoriteIDs else { return }

        var capturedContext: AidenRemoteRequestContext?
        let previousOverride = favoriteOverride
        favoriteMutation = mutation
        favoriteOverride = nextIDs
        favoriteError = nil

        do {
            let context = try coordinator.requestContext()
            capturedContext = context
            let request = try AidenBotFavoritesUpdateRequest(botIds: nextIDs)
            let updated = try await coordinator.remoteClient(for: context).updateBotFavorites(
                request,
                revision: currentFavorites.revision
            )
            guard coordinator.isCurrent(context),
                  coordinator.installationStore.activeInstallation?.id == installation.id,
                  coordinator.installationStore.activeInstallation?.deviceId == installation.deviceId else {
                finishFavoriteMutation(mutation, restoring: nil)
                return
            }
            try await publishFavorites(updated, list: list, context: context)
            finishFavoriteMutation(mutation, restoring: nil)
        } catch is CancellationError {
            finishFavoriteMutation(mutation, restoring: previousOverride)
        } catch {
            if let context = capturedContext,
               await coordinator.handleCredentialRevocation(error, context: context) {
                finishFavoriteMutation(mutation, restoring: previousOverride)
                return
            }
            guard let context = capturedContext, coordinator.isCurrent(context) else {
                finishFavoriteMutation(mutation, restoring: nil)
                return
            }
            do {
                let authoritative = try await coordinator.remoteClient(for: context).botFavorites()
                guard coordinator.isCurrent(context) else {
                    finishFavoriteMutation(mutation, restoring: nil)
                    return
                }
                try await publishFavorites(authoritative, list: list, context: context)
                finishFavoriteMutation(
                    mutation,
                    restoring: nil,
                    error: "Aiden refreshed the latest Favorites. Try your change again."
                )
            } catch {
                finishFavoriteMutation(
                    mutation,
                    restoring: previousOverride,
                    error: "Aiden couldn’t update Favorites. Reconnect and try again."
                )
            }
        }
    }

    private func finishFavoriteMutation(
        _ mutation: AidenBotsFavoriteMutation,
        restoring override: [String]?,
        error: String? = nil
    ) {
        guard let finish = aidenBotsFinishFavoriteMutation(
            current: favoriteMutation,
            finishing: mutation,
            restoring: override,
            error: error
        ) else { return }
        favoriteMutation = nil
        favoriteOverride = finish.favoriteOverride
        favoriteError = finish.favoriteError
    }

    private func resetFavoriteMutationState() {
        favoriteMutation = nil
        favoriteOverride = nil
        favoriteError = nil
    }

    @MainActor
    private func publishFavorites(
        _ favorites: AidenBotFavorites,
        list: AidenBotList,
        context: AidenRemoteRequestContext
    ) async throws {
        // Keep any Bot-list refresh that completed while this mutation was in
        // flight; only the revisioned Favorites projection is replaced.
        let updatedList = try (snapshot?.list ?? list).replacingFavorites(favorites)
        guard coordinator.isCurrent(context) else { return }
        let savedAt = Date()
        var updatedSnapshot = snapshot ?? AidenBotCacheSnapshot(savedAt: savedAt)
        updatedSnapshot.list = updatedList
        updatedSnapshot.savedAt = savedAt
        snapshot = updatedSnapshot
        let retained = await coordinator.withRetainedInstallationData(for: context) {
            _ = try? await AidenBotCache.shared.mergeAndStore(
                AidenBotCacheSegments(list: updatedList),
                savedAt: savedAt,
                instanceId: context.instanceId,
                deviceId: context.deviceId
            )
        }
        guard retained, coordinator.isCurrent(context) else { return }
    }

    @MainActor
    private func openOrCreateConversation(for bot: AidenBotSummary) {
        guard !isCreatingConversation else { return }
        guard canOpen(bot) else {
            presentProfile(bot)
            return
        }
        isCreatingConversation = true
        Task {
            defer { isCreatingConversation = false }
            if let conversation = allConversations.first(where: { $0.botId == bot.id }) {
                await onOpenConversation(conversation)
            } else {
                await onCreateConversation(bot)
                await load()
            }
        }
    }

    private func presentProfile(_ bot: AidenBotSummary) {
        if horizontalSizeClass == .regular {
            selectedBot = bot
        } else {
            presentedSheet = .profile(bot)
        }
    }

    private func botContactRow(_ bot: AidenBotSummary) -> some View {
        let conversation = conversationByBotID[bot.id]
        let preview = botContactPreview(bot, conversation: conversation)
        return HStack(spacing: 14) {
            botAvatar(bot, diameter: 52)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(bot.name)
                        .font(.headline)
                        .foregroundStyle(palette.foreground)
                    Spacer()
                    if let conversation {
                        AidenRelativeTimestampView(date: conversation.updatedAt)
                            .font(.subheadline)
                            .foregroundStyle(palette.secondary)
                    }
                }
                Text(preview)
                    .font(.body)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(2)
                if let conversation,
                   let status = aidenBotInboxActivityStatus(
                       state: conversation.activityState,
                       canRespondToApproval: conversation.canRespondToApproval
                   ) {
                    Label(status.label, systemImage: status.symbol)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(palette.accent)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(botContactAccessibilityLabel(bot, conversation: conversation, preview: preview))
    }

    private func botContactPreview(
        _ bot: AidenBotSummary,
        conversation: AidenBotConversationItem?
    ) -> String {
        let base = conversation?.preview ?? conversation?.title ?? bot.purpose
        let fallback = base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Start a conversation"
            : base
        return bot.health == .archived ? "Archived · \(fallback)" : fallback
    }

    private func botContactAccessibilityLabel(
        _ bot: AidenBotSummary,
        conversation: AidenBotConversationItem?,
        preview: String
    ) -> String {
        var parts = [bot.name, preview]
        if let conversation,
           let status = aidenBotInboxActivityStatus(
               state: conversation.activityState,
               canRespondToApproval: conversation.canRespondToApproval
           ) {
            parts.append(status.label)
        }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private func botContextMenu(_ bot: AidenBotSummary) -> some View {
        let isFavorite = favoriteIDSet.contains(bot.id)
        Button {
            Task { await updateFavorite(bot, move: isFavorite ? .remove : .add) }
        } label: {
            Label(
                isFavorite ? "Unpin from Favorites" : "Pin to Favorites",
                systemImage: isFavorite ? "pin.slash" : "pin"
            )
        }
        .disabled(!canUpdateFavorite(bot, adding: !isFavorite))

        Button {
            presentProfile(bot)
        } label: {
            Label("Bot Details", systemImage: "info.circle")
        }
    }

    private func botAvatar(_ bot: AidenBotSummary, diameter: CGFloat) -> some View {
        AidenBotCanonicalAvatarView(
            coordinator: coordinator,
            botID: bot.id,
            avatar: bot.avatar,
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
        guard aidenBotSurfaceAllows(
            .homeLoad,
            area: area,
            availability: availability
        ), expectedLoadID.isBotSurfaceActive else {
            snapshot = nil
            snapshotScope = nil
            remoteSearchResults = nil
            presentedSheet = nil
            isChoosingBot = false
            isCreatingConversation = false
            resetFavoriteMutationState()
            loadError = nil
            isLoading = false
            return
        }
        guard let installation = coordinator.installationStore.activeInstallation else {
            snapshot = nil
            snapshotScope = nil
            resetFavoriteMutationState()
            isLoading = false
            return
        }
        let scope = AidenBotsHomeScope(
            instanceID: installation.id,
            deviceID: installation.deviceId
        )
        if snapshotScope != scope {
            snapshot = nil
            snapshotScope = scope
            remoteSearchResults = nil
            resetFavoriteMutationState()
        }
        loadError = nil
        isLoading = coordinator.connectionState == .connected
        let activation = await AidenBotCache.shared.activate(
            instanceId: installation.id,
            deviceId: installation.deviceId
        )

        // Hydrate the device-local projection before making any network
        // request. This keeps a warm inbox visible while the Mac refreshes.
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
        if let cached,
           snapshot == nil || cached.savedAt > (snapshot?.savedAt ?? .distantPast) {
            snapshot = cached
        }
        validateSelectedBot(in: snapshot?.list?.bots ?? [])

        if coordinator.connectionState != .connected {
            loadError = snapshot == nil ? nil : "Offline — showing saved Bots"
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
            let segments = AidenBotCacheSegments(
                list: list,
                conversations: conversations
            )
            let refreshedAt = Date()
            let refreshed = segments.applying(to: snapshot, savedAt: refreshedAt)
            var persistedSnapshot: AidenBotCacheSnapshot?
            var cacheWriteFailed = false
            let retained = await coordinator.withRetainedInstallationData(for: context) {
                do {
                    persistedSnapshot = try await AidenBotCache.shared.mergeAndStore(
                        segments,
                        savedAt: refreshedAt,
                        activation: activation
                    )
                    cacheWriteFailed = persistedSnapshot == nil
                } catch {
                    cacheWriteFailed = true
                }
            }
            guard retained,
                  coordinator.isCurrent(context),
                  loadGeneration == generation,
                  loadID == expectedLoadID,
                  await AidenBotCache.shared.isCurrent(activation),
                  !Task.isCancelled else { return }
            snapshot = persistedSnapshot ?? refreshed
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
            if let cached,
               snapshot == nil || cached.savedAt > (snapshot?.savedAt ?? .distantPast) {
                snapshot = cached
            }
            validateSelectedBot(in: snapshot?.list?.bots ?? [])
            isLoading = false
            loadError = snapshot == nil
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
        guard aidenBotSurfaceAllows(
                  .search,
                  area: area,
                  availability: availability
              ),
              expected.loadID.isBotSurfaceActive,
              !expected.query.isEmpty,
              coordinator.connectionState == .connected else { return }
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
            remoteSearchResults = aidenCanonicalBotConversations(results)
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
