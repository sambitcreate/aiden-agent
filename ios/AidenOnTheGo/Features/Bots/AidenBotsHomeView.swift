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

    /// The durable session state comes first: an interrupted turn, a Bot the
    /// person paused (revision 37) or a missing model says so; otherwise the
    /// last message, or a greeting prompt.
    var preview: String {
        switch bot.sessionState {
        case .interrupted: return AidenBotSessionCopy.interruptedSubtitle
        case .paused: return AidenBotSessionCopy.pausedSubtitle
        case .needsModel: return AidenBotSessionCopy.needsModel
        default: break
        }
        let text = (conversation?.preview ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? "Say hello" : text
    }

    /// Shows the small activity dot on the avatar while the Bot is working.
    var isWorking: Bool {
        if let state = bot.sessionState { return state == .running }
        guard let conversation else { return false }
        return conversation.activityState != .idle
    }

    var lastActivity: Date { conversation?.updatedAt ?? bot.updatedAt }
}

/// Builds the Bots home list: the most recent
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
    /// Revision 61 (`bot:templates`): the Mac's templates, with their versions.
    case templates
    case profile(AidenBotSummary)
    /// Profile, opened straight to Memory or Advanced from a row's menu.
    case memory(AidenBotSummary)
    case advanced(AidenBotSummary)

    var id: String {
        switch self {
        case .create: "create"
        case .templates: "templates"
        case let .profile(bot): "profile-\(bot.id)"
        case let .memory(bot): "memory-\(bot.id)"
        case let .advanced(bot): "advanced-\(bot.id)"
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
    let availability: AidenBotsAvailability
    let onOpenConversation: (AidenBotConversationItem) async -> Void
    let onCreateConversation: (AidenBotSummary) async -> Void
    /// Opens a Bot's durable session (`bot-durable-session-v1`).
    var onOpenBotSession: (AidenBotSummary) -> Void = { _ in }
    /// A new Bot was made on a machine this list doesn't show.
    var onCreatedElsewhere: (AidenHostObjectID, AidenBotSummary) -> Void = { _, _ in }
    /// With more than one machine shown: every machine's Bots,
    /// listed in place of the selected machine's.
    var machines: AidenBotsHomeMachines? = nil

    @Environment(\.aidenPalette) private var palette
    @Environment(\.aidenReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var snapshot: AidenBotCacheSnapshot?
    @State private var snapshotScope: AidenBotsHomeScope?
    @State private var query = ""
    @State private var remoteSearchResults: [AidenBotConversationItem]?
    @State private var isLoading = false
    @State private var isCreatingConversation = false
    @State private var presentedSheet: AidenBotsHomeSheet?
    @State private var pendingDelete: AidenBotSummary?
    @State private var deleteError: String?
    @State private var loadError: String?
    @State private var loadGeneration: UInt = 0
    @State private var presets: [AidenBotPreset] = []
    @State private var presetAttempt: (presetID: String, key: UUID)?
    @State private var isStartingPreset = false
    /// Bot creation outlives New Bot (R15): the row shows at once, a failure offers Try Again.
    @State private var createFlow = AidenBotCreateFlow()
    /// The failed create New Bot reopens with after Try Again.
    @State private var createPrefill: AidenBotCreateFlow.Failure?

    private var loadID: AidenBotsHomeLoadID {
        AidenBotsHomeLoadID(
            instanceID: coordinator.defaultInstanceId,
            deviceID: coordinator.installationStore.activeInstallation?.deviceId,
            connectionState: coordinator.connectionState,
            isBotSurfaceActive: availability.canOpen
        )
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

    /// The Bot on its way, and its machine when that isn't the default.
    private var shownPendingCreate: (pending: AidenBotCreateFlow.Pending, machine: String?)? {
        createFlow.shownPending(coordinator: coordinator)
    }

    /// The failed create to show, whichever machine it's for.
    private var activeCreateFailure: AidenBotCreateFlow.Failure? {
        createFlow.failureToShow(coordinator: coordinator)
    }

    /// Bots home looks for what every machine's New Bot left, not just the default's.
    private var parkedAskScopes: [String] {
        createFlow.parkedAskScopes(coordinator: coordinator)
    }

    /// The default machine can make Bots and start their chats. It gates what
    /// this list does on the default machine alone: a first chat with a Bot it
    /// lists, the presets, and New Bot while it's the only machine listed. New
    /// Bot opens at once, connected or not (R15); the Bot is made once it answers.
    private var canCreateBot: Bool {
        availability.canWrite
            && coordinator.installationStore.activeInstallation?.canWriteBots == true
            && createFlow.pending == nil
    }

    /// New Bot asks whichever machine it's picked for, so one that can't make
    /// Bots doesn't close it for the others.
    private var canOpenNewBot: Bool {
        createFlow.canOpenNewBot(coordinator: coordinator)
    }

    /// The toolbar's New Bot. With several machines listed it opens while any of
    /// them can make Bots, and its picker starts on one that can.
    private var canTapNewBot: Bool {
        AidenBotCreateFlow.canTapNewBot(
            groupsMachines: machines != nil,
            defaultCanCreate: canCreateBot,
            canOpen: canOpenNewBot,
            coordinator: coordinator
        )
    }

    var body: some View {
        home
        .sheet(item: $presentedSheet, onDismiss: {
            // Try Again reopened New Bot and it closed without Create: that Bot is let go.
            if let reopened = createPrefill {
                createPrefill = nil
                createFlow.discard(reopened)
            }
        }) { sheet in
            switch sheet {
            case .create:
                AidenBotCreateView(
                    coordinator: coordinator,
                    initial: createPrefill?.input,
                    pinnedTo: createPrefill?.instanceId
                ) { input, target in
                    // Reopened by Try Again: it goes only to the Mac it was for.
                    startCreate(input, retrying: createPrefill, on: target)
                }
            case .templates:
                AidenBotTemplatesView(
                    presets: presets,
                    isBusy: isStartingPreset,
                    canCreate: canCreateBot,
                    onUse: { preset in
                        presentedSheet = nil
                        Task { await startChat(with: preset) }
                    },
                    onOpen: { botID in
                        presentedSheet = nil
                        openExisting(botID: botID)
                    }
                )
            case let .profile(bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    machine: nil,
                    initialSummary: bot,
                    onChanged: { Task { await load() } }
                )
            case let .memory(bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    machine: nil,
                    initialSummary: bot,
                    onChanged: { Task { await load() } },
                    opensMemory: true
                )
            case let .advanced(bot):
                AidenBotProfileView(
                    coordinator: coordinator,
                    machine: nil,
                    initialSummary: bot,
                    onChanged: { Task { await load() } },
                    opensAdvanced: true
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
            AidenBotCreateCopy.failedTitle,
            isPresented: Binding(
                get: { activeCreateFailure != nil },
                // Both buttons settle the failure themselves; a switch of Mac only hides it.
                set: { _ in }
            ),
            presenting: activeCreateFailure
        ) { failure in
            Button("Try Again") {
                guard let pairing = failure.retryPairing(coordinator: coordinator) else { return }
                switch createFlow.retry(
                    failure,
                    instanceId: pairing.instanceId,
                    deviceId: pairing.deviceId,
                    bots: listedBots(for: failure)
                ) {
                case let .send(input):
                    // An earlier launch's create: the same request, on the same key.
                    startCreate(input, retrying: failure, on: AidenNewWorkTarget(instanceId: failure.instanceId))
                case let .reopen(reopened):
                    createPrefill = reopened
                    presentedSheet = .create
                case .settled, .none:
                    break
                }
            }
            Button("OK", role: .cancel) {
                createPrefill = nil
                createFlow.discard(failure)
            }
        } message: { failure in
            Text(failure.shownMessage(coordinator: coordinator))
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
        .task(id: parkedAskScopes) {
            if !parkedAskScopes.isEmpty {
                await createFlow.restoreEveryMachine(coordinator: coordinator)
            }
        }
        .task(id: searchID) {
            await searchConversations()
        }
    }

    private var home: some View {
        homeScroll
            .navigationTitle("Bots")
            .searchable(text: $query, prompt: "Search Bots")
            .searchToolbarBehavior(.minimize)
            .toolbar {
                DefaultToolbarItem(kind: .search, placement: .primaryAction)
                ToolbarSpacer(.fixed, placement: .primaryAction)
                ToolbarItem(placement: .primaryAction) {
                    if offersTemplates {
                        Menu {
                            Button {
                                createPrefill = nil
                                presentedSheet = .create
                            } label: {
                                Label("New Bot", systemImage: "plus")
                            }
                            .disabled(!canTapNewBot)
                            Button {
                                presentedSheet = .templates
                            } label: {
                                Label("Templates", systemImage: "square.grid.2x2")
                            }
                        } label: {
                            Label("New Bot", systemImage: "plus")
                        }
                    } else {
                        Button {
                            createPrefill = nil
                            presentedSheet = .create
                        } label: {
                            Label("New Bot", systemImage: "plus")
                        }
                        .disabled(!canTapNewBot)
                    }
                }
            }
    }

    private var homeScroll: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let machines {
                    machinesContent(machines)
                } else {
                    if let loadError {
                        statusBanner(loadError)
                    } else if case .offline = coordinator.connectionState {
                        statusBanner("Offline — showing saved Bots")
                    }
                    messagingControl
                    content
                }
            }
            .padding(.bottom, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
    }

    @ViewBuilder
    private var messagingControl: some View {
        if coordinator.installationStore.activeInstallation?.hasNegotiatedAccess(to: .botMessaging) == true,
           let context = try? coordinator.requestContext(),
           let value = coordinator.botMessaging.value(for: context) {
            VStack(alignment: .leading, spacing: 8) {
                Toggle("Bots can message each other", isOn: Binding(
                    get: { value.enabled },
                    set: { enabled in
                        Task { @MainActor in
                            guard let client = try? coordinator.remoteClient(for: context) else { return }
                            await coordinator.botMessaging.save(
                                enabled: enabled, context: context,
                                send: { try await client.setBotMessaging(enabled: enabled) },
                                read: { try await client.bots().messaging },
                                isCurrent: { coordinator.isCurrent(context) }
                            )
                        }
                    }
                ))
                .disabled(coordinator.botMessaging.isSaving(for: context) || coordinator.connectionState != .connected
                    || coordinator.installationStore.activeInstallation?.canWriteBots != true)
                if let error = coordinator.botMessaging.error(for: context) {
                    Text(error).font(.footnote).foregroundStyle(palette.secondary)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let shown = shownPendingCreate {
            AidenBotPendingCreateRow(pending: shown.pending, machine: shown.machine)
        }
        switch contentState {
        case .loading:
            AidenBotHomeSkeletonView(reduceMotion: reduceMotion)
        case .empty where shownPendingCreate != nil:
            EmptyView()
        case .empty where coordinator.connectionState == .connected && !presets.isEmpty:
            AidenBotMeetFirstBotView(
                presets: presets,
                isBusy: isStartingPreset,
                canCreate: canCreateBot && canOpenNewBot,
                onStartChat: { preset in Task { await startChat(with: preset) } },
                onOpen: { botID in openExisting(botID: botID) },
                onCreateOwn: {
                    createPrefill = nil
                    presentedSheet = .create
                }
            )
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
                        : "Connect to your computer to see your Bots."
                )
            } actions: {
                if canOpenNewBot {
                    Button("New Bot") {
                        createPrefill = nil
                        presentedSheet = .create
                    }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .aidenSolidFillTint()
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

    /// Every shown machine's Bots: the strip, then each machine's under its name
    /// when the strip says All. A row opens the Bot on its own machine.
    @ViewBuilder
    private func machinesContent(_ machines: AidenBotsHomeMachines) -> some View {
        AidenMachineStrip(labels: machines.roster.tabMachines, filter: machines.filter)
            .padding(.vertical, AidenSpacing.xs)
        if let shown = shownPendingCreate {
            AidenBotPendingCreateRow(pending: shown.pending, machine: shown.machine)
        }
        let sections = AidenMachineSection.searched(machines.sections, filter: machines.filter.wrappedValue, matching: matchesQuery)
        if sections.allSatisfy(\.rows.isEmpty) {
            if normalizedQuery.isEmpty {
                ContentUnavailableView(
                    "No Bots",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("A Bot is a helper you can chat with anytime.")
                )
                .padding(.top, 54)
            } else {
                ContentUnavailableView.search(text: normalizedQuery)
                    .padding(.top, 54)
            }
        }
        ForEach(sections) { section in
            if machines.filter.wrappedValue == .all, !section.rows.isEmpty {
                Text(machines.roster.labels[section.instanceId]?.name ?? "")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 20)
                    .padding(.top, AidenSpacing.m)
                    .accessibilityAddTraits(.isHeader)
            }
            AidenMachineSectionStatus(coordinator: coordinator, instanceId: section.instanceId, savedListName: String(localized: "Bots"))
                .padding(.horizontal, 20)
            ForEach(section.rows) { row in
                Button {
                    machines.onOpen(row)
                } label: {
                    botRow(AidenBotHomeRow(bot: row.bot, conversation: nil), machine: row.id.instanceId)
                }
                .buttonStyle(.plain)
            }
            // Each machine's own switch, so one that's off can be turned back on.
            AidenMachineBotMessagingRow(messaging: AidenMachineBotMessaging(coordinator: coordinator, instanceId: section.instanceId))
        }
    }

    private func matchesQuery(_ row: AidenMachineBotRow) -> Bool {
        normalizedQuery.isEmpty
            || row.bot.name.localizedCaseInsensitiveContains(normalizedQuery)
            || row.bot.purpose.localizedCaseInsensitiveContains(normalizedQuery)
    }

    private func botRow(_ row: AidenBotHomeRow, machine: String? = nil) -> some View {
        HStack(alignment: .top, spacing: 14) {
            AidenBotCanonicalAvatarView(
                coordinator: coordinator,
                machine: machine,
                botID: row.bot.id,
                avatar: row.bot.avatar,
                name: row.bot.name,
                size: 52,
                working: row.isWorking
            )
            VStack(alignment: .leading, spacing: 4) {
                // At the accessibility sizes the purpose and time go under the
                // name, so none of the three has to squeeze into a third of a row.
                let stacked = dynamicTypeSize.isAccessibilitySize
                let header = stacked
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(spacing: 8))
                header {
                    Text(row.bot.name)
                        .font(.headline)
                        .foregroundStyle(palette.foreground)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if !row.bot.purpose.isEmpty {
                        Text(row.bot.purpose)
                            .font(.subheadline)
                            .foregroundStyle(palette.secondary)
                            // Two lines below the accessibility sizes: on one, the audit finds
                            // a purpose such as "Finds the signal in a busy week" cut short
                            // at the larger standard sizes (task-34 fix round 1).
                            .lineLimit(stacked ? nil : 2)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(palette.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                    if !stacked { Spacer(minLength: 4) }
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
        if AidenBotHostFeature.isAdvertised(AidenBotHostFeature.memory, coordinator: coordinator) {
            Button("Memory", systemImage: AidenBotMemorySymbol.name) {
                presentedSheet = .memory(bot)
            }
        }
        Button("Advanced", systemImage: "slider.horizontal.3") {
            presentedSheet = .advanced(bot)
        }
        if AidenBotDeletion.isAvailable(coordinator: coordinator, machine: nil) {
            Divider()
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

    /// The Bots the list shows for the failure's own pairing, to find one a lost create made.
    private func listedBots(for failure: AidenBotCreateFlow.Failure) -> [AidenBotSummary] {
        snapshotScope == AidenBotsHomeScope(instanceID: failure.instanceId, deviceID: failure.deviceId) ? allBots : []
    }

    /// Makes the Bot New Bot asked for, after the sheet closed (R15). `retrying` is the failure
    /// a Try Again came from: the flow sends it only to that failure's own Mac.
    @MainActor
    private func startCreate(
        _ input: AidenBotCreateInput,
        retrying: AidenBotCreateFlow.Failure? = nil,
        on target: AidenNewWorkTarget? = nil
    ) {
        let context: AidenRemoteRequestContext
        do {
            context = try AidenBotCreateOperations.context(for: target, coordinator: coordinator)
        } catch {
            if target != nil { coordinator.presentedError = AidenNewWorkMachine.noLongerPaired }
            return
        }
        createPrefill = nil
        let operations = AidenBotCreateOperations.make(coordinator: coordinator, context: context)
        Task {
            await createFlow.submit(input, operations: operations, retrying: retrying) { created in
                let bot = AidenBotSummary(detail: created)
                if context.instanceId == coordinator.defaultInstanceId {
                    // The new Bot's chat opens from the create receipt; the list refreshes behind it.
                    openChat(for: bot)
                } else {
                    onCreatedElsewhere(
                        AidenHostObjectID(instanceId: context.instanceId, deviceId: context.deviceId, objectId: bot.id),
                        bot
                    )
                }
                await load()
            }
        }
    }

    /// Opens the Bot's one chat, starting it the first time if needed.
    @MainActor
    private func openChat(for bot: AidenBotSummary) {
        guard !isCreatingConversation else { return }
        if case .durableSession = AidenBotChatRoute.resolve(botID: bot.id, hostFeatures: coordinator.knownServerFeatures) {
            onOpenBotSession(bot)
            return
        }
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
        presentedSheet = .profile(bot)
    }

    /// `POST /bots/from-preset`, then the new Bot's chat. A retry of the same
    /// preset reuses its Idempotency-Key.
    @MainActor
    private func startChat(with preset: AidenBotPreset) async {
        // Revision 61: a template already made opens its Bot instead.
        if let existing = preset.template?.existingBotId {
            openExisting(botID: existing)
            return
        }
        guard !isStartingPreset,
              let request = try? AidenBotPresetCreateRequest(presetId: preset.id, version: preset.template?.version) else { return }
        let key = presetAttempt?.presetID == preset.id ? presetAttempt!.key : UUID()
        presetAttempt = (preset.id, key)
        isStartingPreset = true
        defer { isStartingPreset = false }
        do {
            let context = try coordinator.requestContext()
            let result = try await coordinator.remoteClient(for: context).createBotFromPreset(request, idempotencyKey: key)
            guard coordinator.isCurrent(context) else { return }
            presetAttempt = nil
            // Open now from the receipt; the list refreshes behind the chat.
            openChat(for: result.bot)
            await load()
        } catch is CancellationError {
            return
        } catch {
            if !aidenBotSessionFailureIsAmbiguous(error) { presetAttempt = nil }
            if case let AidenRemoteClientError.server(409, body) = error, body.code.rawValue == "revision_conflict" {
                // Revision 61: the template changed on the Mac; show the new version.
                loadError = body.message.isEmpty ? "This template changed. Close it and open it again." : body.message
                if let context = try? coordinator.requestContext(),
                   let client = try? coordinator.remoteClient(for: context) {
                    await loadPresets(client: client)
                }
                return
            }
            loadError = "\(preset.name) couldn’t be created. Please try again."
        }
    }

    /// Revision 61: Open on a template that already has a Bot.
    @MainActor
    private func openExisting(botID: String) {
        if let bot = allBots.first(where: { $0.id == botID }) {
            openChat(for: bot)
        } else {
            loadError = "That Bot isn’t on this list yet. Pull to refresh and try again."
        }
    }

    /// The Mac sends template versions to this phone (`bot:templates`).
    private var offersTemplates: Bool {
        coordinator.installationStore.activeInstallation?.hasNegotiatedAccess(to: .botTemplates) == true
            && !presets.isEmpty
    }

    @MainActor
    private func loadPresets(client: AidenRemoteClient) async {
        guard AidenBotHostFeature.isAdvertised(AidenBotHostFeature.presets, coordinator: coordinator) else {
            presets = []
            return
        }
        if let loaded = try? await client.botPresets() { presets = loaded }
    }

    @MainActor
    private func delete(_ bot: AidenBotSummary) async {
        pendingDelete = nil
        do {
            try await AidenBotDeletion.deleteListed(botID: bot.id, coordinator: coordinator, machine: nil)
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
        guard availability.canOpen, expectedLoadID.isBotSurfaceActive else {
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
        // Connecting is unsettled, not empty: with nothing saved it shows the
        // skeleton until the Mac answers or the connection fails.
        isLoading = coordinator.connectionState == .connected || coordinator.connectionState == .connecting
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

        if coordinator.connectionState != .connected {
            loadError = snapshot == nil ? nil : "Offline — showing saved Bots"
            // Connecting with nothing saved stays unsettled (the skeleton, not
            // "No saved Bots"); `loadID` reruns this once the Mac answers.
            isLoading = coordinator.connectionState == .connecting && snapshot == nil
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
            let messagingGeneration = coordinator.botMessaging.generation(for: context)
            async let listRequest = aidenLoadBotsHomeSegment(enabled: plan.loadsList) {
                try await client.bots()
            }
            async let conversationRequest = aidenLoadBotsHomeSegment(
                enabled: plan.loadsConversations
            ) {
                try await client.botConversations()
            }
            let (listResult, conversationResult) = await (listRequest, conversationRequest)
            // The carousel shows on an empty list; with `bot:templates` (revision
            // 61) Templates is always in the New Bot menu, so it loads either way.
            let holdsTemplates = coordinator.installationStore.activeInstallation?.hasNegotiatedAccess(to: .botTemplates) == true
            if case let .success(list) = listResult, list?.bots.isEmpty == true || holdsTemplates {
                await loadPresets(client: client)
            }
            guard coordinator.isCurrent(context), loadGeneration == generation,
                  loadID == expectedLoadID, !Task.isCancelled else { return }
            var failures: [Error] = []
            let list: AidenBotList?
            switch listResult {
            case .success(let value):
                list = value
                coordinator.botMessaging.adopt(value?.messaging, context: context, generation: messagingGeneration)
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
            isLoading = false
            Task { await AidenBotRoutineNotifier.shared.deliverIfSupported(coordinator: coordinator) }
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
            isLoading = false
            loadError = snapshot == nil
                ? error.localizedDescription
                : "Couldn’t refresh — showing saved Bots"
        }
    }

    @MainActor
    private func searchConversations() async {
        let expected = searchID
        remoteSearchResults = nil
        guard availability.canOpen,
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
