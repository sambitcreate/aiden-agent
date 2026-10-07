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

struct AidenBotsHomeLoadPlan: Equatable {
    let loadsList: Bool
    let loadsConversations: Bool

    init(installation: AidenInstallation?) {
        loadsList = installation?.hasNegotiatedAccess(to: .botRead) == true
        loadsConversations = loadsList
            && installation?.hasNegotiatedAccess(to: .chatRead) == true
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

enum AidenBotDeepLinkResolution: Equatable, Sendable {
    /// Open this Bot's canonical conversation.
    case openChat(String)
    /// The Bot has no conversation yet; land on the Bot without creating one.
    case showBot
}

/// Chooses the chat a `aiden-otg://bot/{id}/chat` link opens. Items owned by
/// another Bot are ignored even if a server returned them, and duplicates use
/// the same canonical rule as Bots Home so a link and a tap agree.
func aidenResolvedBotDeepLink(
    botID: String,
    conversations: [AidenBotConversationItem]
) -> AidenBotDeepLinkResolution {
    let owned = conversations.filter { $0.botId == botID }
    guard let chat = aidenCanonicalBotConversations(owned).first else { return .showBot }
    return .openChat(chat.chatId)
}

/// A shimmering placeholder block for cold loads. Warm refreshes keep the
/// last-good UI in place and never show it.
struct AidenBotSkeletonBlock: View {
    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenLowPowerMode) private var lowPowerMode
    let width: CGFloat?
    let height: CGFloat
    let radius: CGFloat
    let reduceMotion: Bool

    var body: some View {
        GeometryReader { proxy in
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(palette.raised)
                .overlay {
                    if !reduceMotion && !lowPowerMode {
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

/// One row per Bot on the Bots home.
struct AidenBotHomeRow: Equatable, Identifiable {
    let bot: AidenBotSummary
    let conversation: AidenBotConversationItem?

    var id: String { bot.id }

    /// The last message, or the Bot's subtitle before its first chat.
    var preview: String {
        let text = (conversation?.preview ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "Say hello" : text
    }

    /// Shows the small activity dot on the avatar while the Bot is working.
    var isWorking: Bool {
        guard let conversation else { return false }
        return conversation.activityState != .idle
    }

    var lastActivity: Date { conversation?.updatedAt ?? bot.updatedAt }
}

/// Builds the Bots home list: archived Bots are hidden, the most recent
/// conversation comes first, and search matches names, subtitles, previews,
/// and server-side message matches.
func aidenBotHomeRows(
    bots: [AidenBotSummary],
    conversations: [AidenBotConversationItem],
    query: String,
    remoteMatchBotIDs: Set<String> = []
) -> [AidenBotHomeRow] {
    let canonical = aidenCanonicalBotConversations(conversations)
    let conversationByBotID = Dictionary(canonical.map { ($0.botId, $0) }, uniquingKeysWith: { first, _ in first })
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return bots
        .filter { $0.health != .archived }
        .map { AidenBotHomeRow(bot: $0, conversation: conversationByBotID[$0.id]) }
        .filter { row in
            guard !needle.isEmpty else { return true }
            return row.bot.name.localizedCaseInsensitiveContains(needle)
                || row.bot.purpose.localizedCaseInsensitiveContains(needle)
                || (row.conversation?.preview?.localizedCaseInsensitiveContains(needle) == true)
                || remoteMatchBotIDs.contains(row.bot.id)
        }
        .sorted { lhs, rhs in
            if lhs.lastActivity != rhs.lastActivity { return lhs.lastActivity > rhs.lastActivity }
            let nameOrder = lhs.bot.name.localizedStandardCompare(rhs.bot.name)
            if nameOrder != .orderedSame { return nameOrder == .orderedAscending }
            return lhs.bot.id < rhs.bot.id
        }
}

private enum AidenBotsHomeSheet: Identifiable {
    case create
    case profile(AidenBotSummary)

    var id: String {
        switch self {
        case .create: "create"
        case let .profile(bot): "profile-\(bot.id)"
        }
    }
}

private struct AidenBotHomeSkeletonView: View {
    let reduceMotion: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<4, id: \.self) { index in
                HStack(spacing: 14) {
                    AidenBotSkeletonBlock(width: 52, height: 52, radius: 26, reduceMotion: reduceMotion)
                    VStack(alignment: .leading, spacing: 8) {
                        AidenBotSkeletonBlock(width: index == 1 ? 126 : 104, height: 15, radius: 7.5, reduceMotion: reduceMotion)
                        AidenBotSkeletonBlock(width: index == 2 ? 160 : 200, height: 12, radius: 6, reduceMotion: reduceMotion)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading Bots")
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
    @State private var isSearching = false
    @State private var remoteSearchResults: [AidenBotConversationItem]?
    @State private var isLoading = false
    @State private var isCreatingConversation = false
    @State private var presentedSheet: AidenBotsHomeSheet?
    @State private var pendingDelete: AidenBotSummary?
    @State private var deleteError: String?
    @State private var loadError: String?
    @State private var loadGeneration: UInt = 0
    @FocusState private var searchIsFocused: Bool

    private var loadID: AidenBotsHomeLoadID {
        AidenBotsHomeLoadID(
            instanceID: coordinator.activeInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId,
            connectionState: coordinator.connectionState,
            isBotSurfaceActive: aidenBotSurfaceIsActive(area: area, availability: availability)
        )
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
            navigationStore.setSelectedBot(newValue?.id, for: installation?.id, deviceID: installation?.deviceId)
        }
    }

    private var allBots: [AidenBotSummary] { snapshot?.list?.bots ?? [] }

    private var normalizedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var allConversations: [AidenBotConversationItem] {
        aidenCanonicalBotConversations(snapshot?.conversations?.conversations ?? [])
    }

    private var searchID: AidenBotsSearchID {
        AidenBotsSearchID(loadID: loadID, query: normalizedQuery)
    }

    private var allRows: [AidenBotHomeRow] {
        aidenBotHomeRows(bots: allBots, conversations: allConversations, query: "")
    }

    private var rows: [AidenBotHomeRow] {
        aidenBotHomeRows(
            bots: allBots,
            conversations: allConversations,
            query: normalizedQuery,
            remoteMatchBotIDs: Set(remoteSearchResults?.map(\.botId) ?? [])
        )
    }

    private var contentState: AidenBotsHomeContentState {
        aidenBotsHomeContentState(
            hasSnapshot: snapshot != nil,
            isLoading: isLoading,
            totalBotCount: allRows.count,
            activeBotCount: allRows.count,
            conversationCount: 0,
            hasQuery: !normalizedQuery.isEmpty,
            filteredBotCount: rows.count,
            filteredConversationCount: 0
        )
    }

    private var canCreateBot: Bool {
        availability.canWrite
            && coordinator.connectionState == .connected
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
    }

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    homeScroll
                        .toolbar(.hidden, for: .navigationBar)
                } detail: {
                    if let selectedBot {
                        AidenBotProfileView(
                            coordinator: coordinator,
                            initialSummary: selectedBot,
                            onChanged: { Task { await load() } },
                            onDeleted: { self.selectedBot = nil },
                            showsDismissButton: false
                        )
                        .id("\(loadID.instanceID ?? "none")-\(loadID.deviceID ?? "none")-\(selectedBot.id)")
                    } else {
                        ContentUnavailableView(
                            "Pick a Bot",
                            systemImage: "bubble.left.and.bubble.right",
                            description: Text("Tap a Bot to chat with it.")
                        )
                    }
                }
            } else {
                homeScroll
            }
        }
        .sheet(item: $presentedSheet) { sheet in
            switch sheet {
            case .create:
                AidenBotCreateView(coordinator: coordinator) { created in
                    Task {
                        await load()
                        openChat(for: AidenBotSummary(detail: created))
                    }
                }
            case let .profile(bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    initialSummary: bot,
                    onChanged: { Task { await load() } }
                )
            }
        }
        .aidenBotDeleteConfirmation(
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            botName: pendingDelete?.name ?? ""
        ) {
            if let bot = pendingDelete { Task { await delete(bot) } }
        }
        .alert(
            "Couldn’t Delete",
            isPresented: Binding(
                get: { deleteError != nil },
                set: { if !$0 { deleteError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { deleteError = nil }
        } message: {
            Text(deleteError ?? "Please try again.")
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
                if isSearching {
                    searchField
                }
                if let loadError {
                    statusBanner(loadError)
                }
                content
            }
            .padding(.bottom, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
    }

    private var header: some View {
        HStack(spacing: 12) {
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
            headerButton(systemImage: "magnifyingglass", label: isSearching ? "Close search" : "Search") {
                isSearching.toggle()
                if isSearching {
                    searchIsFocused = true
                } else {
                    query = ""
                }
            }
            .disabled(allRows.isEmpty && !isSearching)
            headerButton(systemImage: "plus", label: "New Bot") {
                presentedSheet = .create
            }
            .disabled(!canCreateBot)
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private func headerButton(systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(palette.foreground)
                .frame(width: 44, height: 44)
                .background(palette.raised, in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(palette.secondary)
                .accessibilityHidden(true)
            TextField("Search Bots", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searchIsFocused)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(palette.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(palette.raised, in: Capsule())
        .padding(.horizontal, 20)
        .padding(.bottom, 10)
    }

    @ViewBuilder
    private var content: some View {
        switch contentState {
        case .loading:
            AidenBotHomeSkeletonView(reduceMotion: reduceMotion)
        case .empty:
            ContentUnavailableView {
                Label(
                    coordinator.connectionState == .connected ? "Make your first Bot" : "No saved Bots",
                    systemImage: "bubble.left.and.bubble.right"
                )
            } description: {
                Text(
                    coordinator.connectionState == .connected
                        ? "A Bot is a helper you can chat with anytime."
                        : "Connect to your Mac to see your Bots."
                )
            } actions: {
                if coordinator.connectionState == .connected {
                    Button("New Bot") { presentedSheet = .create }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .tint(palette.accent)
                        .foregroundStyle(palette.onAccent)
                        .disabled(!canCreateBot)
                }
            }
            .padding(.top, 54)
        case .noResults:
            ContentUnavailableView.search(text: normalizedQuery)
                .padding(.top, 54)
        case .content:
            ForEach(rows) { row in
                Button {
                    openChat(for: row.bot)
                } label: {
                    botRow(row)
                }
                .buttonStyle(.plain)
                .contextMenu { botContextMenu(row.bot) }
                .disabled(isCreatingConversation)
            }
        }
    }

    private func botRow(_ row: AidenBotHomeRow) -> some View {
        HStack(alignment: .top, spacing: 14) {
            AidenBotCanonicalAvatarView(
                coordinator: coordinator,
                botID: row.bot.id,
                avatar: row.bot.avatar,
                name: row.bot.name,
                size: 52
            )
            .overlay(alignment: .bottomTrailing) {
                if row.isWorking {
                    Circle()
                        .fill(palette.success)
                        .frame(width: 14, height: 14)
                        .padding(2)
                        .background(palette.canvas, in: Circle())
                        .accessibilityHidden(true)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(row.bot.name)
                        .font(.headline)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if !row.bot.purpose.isEmpty {
                        Text(row.bot.purpose)
                            .font(.subheadline)
                            .foregroundStyle(palette.secondary)
                            .lineLimit(1)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    Spacer(minLength: 4)
                    if let conversation = row.conversation {
                        AidenRelativeTimestampView(date: conversation.updatedAt)
                            .font(.subheadline)
                            .foregroundStyle(palette.secondary)
                    }
                }
                Text(row.preview)
                    .font(.body)
                    .foregroundStyle(palette.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rowAccessibilityLabel(row))
        .accessibilityHint("Opens the chat")
    }

    private func rowAccessibilityLabel(_ row: AidenBotHomeRow) -> String {
        var parts = [row.bot.name]
        if !row.bot.purpose.isEmpty { parts.append(row.bot.purpose) }
        if row.isWorking { parts.append("Working") }
        parts.append(row.preview)
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private func botContextMenu(_ bot: AidenBotSummary) -> some View {
        Button("Profile", systemImage: "person.crop.circle") {
            presentProfile(bot)
        }
        if AidenBotDeletion.isAvailable(coordinator: coordinator) {
            Button("Delete", systemImage: "trash", role: .destructive) {
                pendingDelete = bot
            }
        }
    }

    private func statusBanner(_ message: String) -> some View {
        Label(message, systemImage: coordinator.connectionState == .connected ? "exclamationmark.triangle" : "wifi.slash")
            .font(.footnote)
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
    }

    /// Opens the Bot's one chat, starting it the first time if needed.
    @MainActor
    private func openChat(for bot: AidenBotSummary) {
        guard !isCreatingConversation else { return }
        if let conversation = allConversations.first(where: { $0.botId == bot.id }) {
            isCreatingConversation = true
            Task {
                defer { isCreatingConversation = false }
                await onOpenConversation(conversation)
            }
            return
        }
        guard bot.health == .ready, canCreateBot else {
            presentProfile(bot)
            return
        }
        isCreatingConversation = true
        Task {
            defer { isCreatingConversation = false }
            await onCreateConversation(bot)
            await load()
        }
    }

    private func presentProfile(_ bot: AidenBotSummary) {
        if horizontalSizeClass == .regular {
            selectedBot = bot
        } else {
            presentedSheet = .profile(bot)
        }
    }

    @MainActor
    private func delete(_ bot: AidenBotSummary) async {
        pendingDelete = nil
        do {
            let detail = try await coordinator.remoteClient(for: try coordinator.requestContext()).bot(id: bot.id)
            try await AidenBotDeletion.delete(botID: detail.id, revision: detail.revision, coordinator: coordinator)
            if selectedBot?.id == bot.id { selectedBot = nil }
            await load()
        } catch is CancellationError {
            return
        } catch {
            deleteError = "\(bot.name) wasn’t deleted. Please try again."
        }
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
            pendingDelete = nil
            isCreatingConversation = false
            loadError = nil
            isLoading = false
            return
        }
        guard let installation = coordinator.installationStore.activeInstallation else {
            snapshot = nil
            snapshotScope = nil
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
            let plan = AidenBotsHomeLoadPlan(installation: installation)
            // Bot identity and chat history are separately granted, so one
            // denied segment must not erase the other. Archived Bots are no
            // longer a phone concept and are not requested.
            async let listRequest = aidenLoadBotsHomeSegment(enabled: plan.loadsList) {
                try await client.bots()
            }
            async let conversationRequest = aidenLoadBotsHomeSegment(
                enabled: plan.loadsConversations
            ) {
                try await client.botConversations()
            }
            let (listResult, conversationResult) = await (listRequest, conversationRequest)
            guard coordinator.isCurrent(context), loadGeneration == generation,
                  loadID == expectedLoadID, !Task.isCancelled else { return }
            var failures: [Error] = []
            let list: AidenBotList?
            switch listResult {
            case .success(let value): list = value
            case .failure(let error):
                list = nil
                failures.append(error)
            }
            let conversations: AidenBotConversationPage?
            switch conversationResult {
            case .success(let value): conversations = value
            case .failure(let error):
                conversations = nil
                failures.append(error)
            }
            for error in failures {
                if await coordinator.handleCredentialRevocation(error, context: context) { return }
            }
            guard list != nil || conversations != nil else {
                throw failures.first ?? AidenRemoteClientError.invalidResponse
            }
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
            validateSelectedBot(in: list?.bots ?? snapshot?.list?.bots ?? [])
            isLoading = false
            if cacheWriteFailed {
                loadError = "Bots loaded, but this iPhone couldn’t save them for offline use."
            } else if !failures.isEmpty {
                loadError = "Some Bot details couldn’t be refreshed. Showing the latest available data."
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
              coordinator.connectionState == .connected,
              AidenBotsHomeLoadPlan(
                  installation: coordinator.installationStore.activeInstallation
              ).loadsConversations else { return }
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

private func aidenLoadBotsHomeSegment<Value: Sendable>(
    enabled: Bool,
    operation: @escaping @Sendable () async throws -> Value
) async -> Result<Value?, Error> {
    guard enabled else { return .success(nil) }
    do {
        return .success(try await operation())
    } catch {
        return .failure(error)
    }
}
