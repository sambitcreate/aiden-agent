import SwiftUI

extension AidenBotsAvailability {
    /// Why the Bots tab has nothing to show. The tab stays selectable in every
    /// state, so this is what it says instead of going away.
    var tabExplanation: String? {
        switch self {
        case .available:
            nil
        case .mobileDisabled:
            String(localized: "Bots aren’t available in this version of Aiden On The Go.")
        case .unsupported:
            String(localized: "Bots need a newer version of Aiden Agent on your paired machine.")
        case .notGranted:
            String(localized: "Approve Bot access on your paired machine, or pair this phone again.")
        }
    }
}

/// A page that's a sheet in the menu shell and pushed in the tab shell. A sheet
/// needs its own stack, and a pushed page must not bring a second one.
struct AidenPresentedStack<Content: View>: View {
    let isPushed: Bool
    @ViewBuilder let content: Content

    var body: some View {
        if isPushed {
            content
        } else {
            NavigationStack { content }
        }
    }
}

private struct AidenArchiveSyncID: Equatable {
    let instanceID: String?
    let workspaceRevision: Int
    let archivedIDs: Set<String>
}

/// The four tabs, behind `AppConfig.tabShellEnabled`. Each tab has its own stack.
struct AidenAppShellView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Binding private var navigationRequest: AidenNavigationRequest?
    private let inboxStore: AidenUnifiedInboxStore
    private let navigationStore: AidenAppNavigationStore
    private let intents: AidenForegroundIntentRouter

    @Environment(AidenAppearanceStore.self) private var appearance
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var navigation: AidenAppNavigation
    @State private var newChat: AidenNewChatFlow
    @State private var botSummaries: [AidenHostObjectID: AidenBotSummary] = [:]
    @State private var searchText = ""
    @State private var showsRunningChats = false

    init(
        coordinator: AidenRemoteCoordinator,
        inboxStore: AidenUnifiedInboxStore,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil),
        navigationStore: AidenAppNavigationStore = AidenAppNavigationStore(),
        intents: AidenForegroundIntentRouter? = nil
    ) {
        self.coordinator = coordinator
        self.inboxStore = inboxStore
        _navigationRequest = navigationRequest
        self.navigationStore = navigationStore
        self.intents = intents ?? .shared
        let navigation = AidenAppNavigation(
            restoring: navigationStore.load(
                installations: coordinator.installationStore.installations,
                selected: coordinator.activeInstanceId
            ),
            installations: coordinator.installationStore.installations
        )
        _navigation = State(initialValue: navigation)
        // A chat started from Workspaces stays there; anywhere else it's the Inbox's.
        _newChat = State(initialValue: AidenNewChatFlow(
            coordinator: coordinator,
            home: { coordinator.activeInstanceId.flatMap(inboxStore.homeModel(for:)) },
            reload: { await inboxStore.refreshAll() },
            onOpen: { id in
                navigation.open(.chat(id), on: navigation.tab == .workspaces ? .workspaces : .inbox)
            }
        ))
    }

    private var botsAvailability: AidenBotsAvailability {
        AidenBotsAvailability.resolve(coordinator.installationStore.activeInstallation)
    }

    private var archiveSyncID: AidenArchiveSyncID {
        AidenArchiveSyncID(
            instanceID: coordinator.activeInstanceId,
            workspaceRevision: coordinator.workspaceSnapshotRevision,
            archivedIDs: coordinator.workspaceArchiveStore.archivedWorkspaceIDs(for: coordinator.activeInstanceId)
        )
    }

    /// A machine that can't report usage leaves nothing to open, as on the old home.
    private var usageUnavailable: Bool {
        !AidenHomeLoadPlan(installation: coordinator.installationStore.activeInstallation).loadsUsage
    }

    private var runningHome: AidenRunningHome {
        .resolve(
            accessoryCanTurnOff: AidenRunningHome.accessoryCanTurnOff,
            horizontalSizeClass: horizontalSizeClass
        )
    }

    /// Read at every step of a run, never kept.
    private var catchUpQueue: AidenCatchUpQueue {
        AidenCatchUpQueue(rows: inboxStore.inbox.needsYou)
    }

    var body: some View {
        TabView(selection: $navigation.tab) {
            Tab("Inbox", systemImage: "tray", value: AidenAppTab.inbox) {
                NavigationStack(path: $navigation.inboxPath) {
                    AidenInboxTabRootView(
                        store: inboxStore,
                        runningHome: runningHome,
                        onOpen: openChat,
                        onDelete: deleteChat,
                        onCatchUp: { markViewed(navigation.startCatchUp(in: catchUpQueue)) },
                        onShowRunning: { showsRunningChats = true }
                    )
                    .safeAreaInset(edge: .top, spacing: 0) {
                        AidenConnectionNotice(coordinator: coordinator)
                    }
                    .toolbar { inboxToolbar }
                    .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }
            .badge(inboxStore.needsYouCount)

            Tab("Bots", systemImage: AidenProductArea.bots.symbol, value: AidenAppTab.bots) {
                NavigationStack(path: $navigation.botsPath) {
                    AidenBotsTabView(
                        coordinator: coordinator,
                        navigation: navigation,
                        availability: botsAvailability,
                        onOpenBot: { id, bot in botSummaries[id] = bot }
                    )
                    .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }

            Tab("Workspaces", systemImage: "folder", value: AidenAppTab.workspaces) {
                NavigationStack(path: $navigation.workspacesPath) {
                    AidenWorkspacesTabView(coordinator: coordinator, newChat: newChat)
                        .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }

            Tab(value: AidenAppTab.search, role: .search) {
                // The field is on this stack's root view: on the `TabView` it would
                // sit on every tab.
                NavigationStack {
                    AidenSearchTabView(coordinator: coordinator, inboxStore: inboxStore) { navigation.open($0) }
                }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(.sidebar)
        .tabBarMinimizeBehavior(horizontalSizeClass == .compact ? .onScrollDown : .automatic)
        .tabViewSearchActivation(.searchTabSelection)
        .aidenNewChatPresentation(newChat)
        // Hiding the tab bar leaves the accessory up, under the composer.
        .aidenRunningAccessory(
            isEnabled: runningHome == .accessory && inboxStore.hasRunningChats && navigation.openChat == nil
        ) {
            AidenRunningAccessoryHost(store: inboxStore, onOpen: openChat) { showsRunningChats = true }
        }
        .sheet(isPresented: $showsRunningChats) {
            AidenRunningChatsSheet(store: inboxStore) { id in
                showsRunningChats = false
                openChat(id)
            }
        }
        .alert(
            "Aiden On The Go",
            isPresented: Binding(
                get: { coordinator.presentedError != nil },
                set: { if !$0 { coordinator.presentedError = nil } }
            )
        ) {
            Button("OK", role: .cancel) { coordinator.presentedError = nil }
        } message: {
            Text(coordinator.presentedError ?? "The operation could not be completed.")
        }
        .onChange(of: navigation.snapshot) { _, snapshot in
            navigationStore.save(snapshot)
        }
        .onChange(of: navigation.tab == .inbox, initial: true) { _, isOnScreen in
            inboxStore.setInboxVisible(isOnScreen)
        }
        .onChange(of: navigation.openChat, initial: true) { _, chat in
            inboxStore.openChat = chat
            inboxStore.setFocusedMachine(chat?.instanceId)
        }
        .onDisappear {
            inboxStore.setInboxVisible(false)
            inboxStore.openChat = nil
            inboxStore.setFocusedMachine(nil)
        }
        .onChange(of: coordinator.installationStore.installations) { _, installations in
            navigation.dropRoutes(outside: installations)
        }
        .onChange(of: navigationRequest, initial: true) { _, request in
            guard let request else { return }
            navigationRequest = nil
            open(request)
        }
        .onChange(of: intents.routes, initial: true) {
            for queued in intents.takeRoutes(openableOn: coordinator) {
                navigation.open(queued.route, startsVoice: queued.startsVoice)
            }
        }
        .onChange(of: coordinator.activeInstanceId) { _, _ in
            navigation.leaveSelectedMachineRoutes()
        }
        .task(id: archiveSyncID) {
            coordinator.setDeviceArchivedWorkspaceIDs(archiveSyncID.archivedIDs, for: archiveSyncID.instanceID)
        }
        .onAppear { coordinator.haptics.activate(scope: newChat.hapticScope) }
        .onDisappear { coordinator.haptics.deactivate(scope: newChat.hapticScope) }
    }

    private func deleteChat(_ id: AidenHostObjectID) {
        navigation.leave(.chat(id))
        Task {
            switch await inboxStore.delete(id) {
            case .deleted:
                coordinator.haptics.play(.success, scope: newChat.hapticScope, dedupeKey: "chat-remove:\(id.objectId)")
            case .failed:
                coordinator.haptics.play(.error, scope: newChat.hapticScope)
            case .abandoned:
                break
            }
        }
    }

    @ToolbarContentBuilder
    private var inboxToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("Settings", systemImage: "gearshape") { navigation.open(.settings) }
                Button("Scheduled tasks", systemImage: "calendar.badge.clock") { navigation.open(.scheduled) }
                Button("Usage", systemImage: "chart.bar.xaxis") { navigation.open(.usage) }
                    .disabled(usageUnavailable)
            } label: {
                Label("Inbox menu", systemImage: AidenChromeSymbols.overflowMenu)
            }
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) {
            AidenNewChatButton(flow: newChat)
        }
    }

    @ViewBuilder
    private func destination(for route: AidenAppRoute) -> some View {
        switch route {
        case .chat(let id):
            AidenChatRouteView(
                coordinator: coordinator,
                id: id,
                receipt: newChat.receipt(for: id),
                autoStartVoice: navigation.chatStartingVoice == id,
                onNext: navigation.catchUp?.current == id ? nextInCatchUp : nil,
                onChatUpdated: { chat in
                    inboxStore.homeModel(for: id.instanceId)?.accept(chat)
                },
                onChatActivityChanged: { chatID, activity in
                    inboxStore.homeModel(for: id.instanceId)?.setActivity(activity, forChatID: chatID)
                },
                onForkOpened: { fork in
                    let home = inboxStore.homeModel(for: id.instanceId)
                    home?.accept(fork)
                    home?.markViewed(chatID: fork.id)
                },
                onBotChat: { bot in navigation.replace(route, with: .bot(bot)) }
            )
            // Next swaps the route in place, and the stack would otherwise keep this
            // view's state, so the old chat would stay on screen.
            .id(id)
            .onDisappear {
                navigation.finishStartingVoice(id)
                newChat.forgetReceipt(id)
            }
        case .bot(let id):
            AidenBotRouteView(coordinator: coordinator, id: id, initialSummary: botSummaries[id])
        case .workspace(let id):
            AidenWorkspaceRouteView(
                coordinator: coordinator,
                id: id,
                onRemoved: { navigation.leave(route) },
                onChatUpdated: { inboxStore.homeModel(for: id.instanceId)?.accept($0) },
                onChatRemoved: { inboxStore.homeModel(for: id.instanceId)?.removeChat(id: $0) },
                onChatActivityChanged: { chatID, activity in
                    inboxStore.homeModel(for: id.instanceId)?.setActivity(activity, forChatID: chatID)
                }
            )
        case .machines:
            AidenMachinesRouteView(coordinator: coordinator)
        case .machine(let instanceId):
            AidenMachineDetailView(instanceId: instanceId, coordinator: coordinator, preferences: .shared)
        case .settings:
            AidenAppSettingsView(
                coordinator: coordinator,
                appearance: appearance,
                isPushed: true
            )
        case .scheduled:
            AidenScheduledTasksView(coordinator: coordinator, isPushed: true)
        case .usage:
            AidenUsageRouteView(coordinator: coordinator)
        case .catchUpFinished(let ending):
            AidenCatchUpFinishedView(ending: ending) { navigation.inboxPath = [] }
        }
    }

    private func openChat(_ id: AidenHostObjectID) {
        markViewed(id)
        navigation.open(.chat(id))
    }

    private func nextInCatchUp() {
        markViewed(navigation.advanceCatchUp(in: catchUpQueue))
    }

    private func markViewed(_ id: AidenHostObjectID?) {
        guard let id else { return }
        inboxStore.homeModel(for: id.instanceId)?.markViewed(chatID: id.objectId)
    }

    private func open(_ request: AidenNavigationRequest) {
        if let route = AidenAppRoute(
            request: request,
            installations: coordinator.installationStore.installations,
            activeInstanceId: coordinator.activeInstanceId
        ) {
            navigation.open(route, startsVoice: request.startsVoice)
        } else {
            coordinator.presentedError = String(localized: "This machine is no longer paired. Pair it again to continue.")
        }
    }
}

/// What Usage reads. Its route names no machine, so it reads the selected one.
@MainActor @Observable
final class AidenUsageRouteModel {
    enum State: Equatable {
        case loading
        case ready(AidenUsageSummary, providers: [AidenProvider])
        case offline
        case failed
        /// The machine doesn't let this phone read its usage.
        case unavailable(String)
    }

    private(set) var state = State.loading

    func load(coordinator: AidenRemoteCoordinator) async {
        guard let context = try? coordinator.requestContext() else { return }
        let plan = AidenHomeLoadPlan(installation: coordinator.installationStore.activeInstallation)
        guard plan.loadsUsage else {
            state = .unavailable(String(localized: "This machine doesn’t share its usage with this phone."))
            return
        }
        switch coordinator.connectionState {
        case .connected:
            break
        case .connecting, .needsPairing:
            return
        case .offline:
            if case .ready = state { return }
            state = .offline
            return
        }
        if case .ready = state {} else { state = .loading }
        do {
            let client = try coordinator.remoteClient(for: context)
            async let catalog = plan.loadsModelCatalog ? try? await client.modelCatalog() : nil
            let usage = try await client.usage()
            let providers = await catalog?.providers ?? []
            guard coordinator.isCurrent(context) else { return }
            state = .ready(usage, providers: providers)
        } catch where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: context) { return }
            guard coordinator.isCurrent(context) else { return }
            if case .ready = state { return }
            state = .failed
        }
    }
}

private struct AidenUsageRouteView: View {
    private struct LoadID: Equatable {
        let selection: String?
        let connectionState: AidenRemoteConnectionState
    }

    let coordinator: AidenRemoteCoordinator
    @Environment(\.aidenPalette) private var palette
    @State private var model = AidenUsageRouteModel()

    var body: some View {
        Group {
            switch model.state {
            case .ready(let usage, let providers):
                AidenUsageView(usage: usage, providers: providers, isPushed: true)
            case .unavailable(let message):
                ContentUnavailableView("Usage unavailable", systemImage: "chart.bar.xaxis", description: Text(message))
                    .background(palette.canvas.ignoresSafeArea())
                    .navigationTitle("Usage")
            case .loading, .offline, .failed:
                AidenUsagePendingView(
                    isOffline: model.state == .offline,
                    failed: model.state == .failed,
                    retry: { Task { await model.load(coordinator: coordinator) } },
                    isPushed: true
                )
            }
        }
        .task(id: LoadID(selection: coordinator.activeInstanceId, connectionState: coordinator.connectionState)) {
            await model.load(coordinator: coordinator)
        }
    }
}

private struct AidenTabPlaceholderView: View {
    let title: LocalizedStringKey
    let systemImage: String

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        ContentUnavailableView(title, systemImage: systemImage)
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle(title)
    }
}

/// Finds what a chat route points at. It reads the route's own machine through
/// an owner context, so opening a chat never moves the selection.
@MainActor @Observable
final class AidenChatRouteModel {
    enum State {
        case loading
        case ready(AidenChat, owner: AidenRemoteRequestContext)
        /// A Bot's chat. Sending needs the Bot's own health check, so it belongs
        /// on a `.bot` route for this Bot.
        case botChat(AidenHostObjectID)
        case unavailable(String)
    }

    let id: AidenHostObjectID
    private(set) var state = State.loading
    @ObservationIgnored private let cache: AidenChatCache
    @ObservationIgnored private let receipt: AidenChat?

    /// `receipt` is the chat as the machine just created it, when there is one.
    init(id: AidenHostObjectID, cache: AidenChatCache = .shared, receipt: AidenChat? = nil) {
        self.id = id
        self.cache = cache
        self.receipt = receipt
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        if case .ready = state { return }
        guard let owner = try? coordinator.ownerContext(for: id.instanceId), owner.deviceId == id.deviceId else {
            state = .unavailable(String(localized: "This machine is no longer paired. Pair it again to open this chat."))
            return
        }
        if let receipt {
            await present(receipt, owner: owner, coordinator: coordinator)
            return
        }
        // Saved transcript first: the chat opens at once and refreshes itself.
        if let saved = await cache.admittedChat(instanceId: id.instanceId, chatId: id.objectId) {
            await present(await cache.presenting(saved, instanceId: id.instanceId), owner: owner, coordinator: coordinator)
            return
        }
        do {
            let chat = try await coordinator.remoteClient(for: owner).chat(id: id.objectId)
            await present(chat, owner: owner, coordinator: coordinator)
        } catch where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: owner) {
                state = .unavailable(String(localized: "This machine is no longer paired. Pair it again to open this chat."))
                return
            }
            // The view loads again once the machine settles.
            if coordinator.hosts.connection(for: id.instanceId)?.connectionState == .connecting { return }
            state = .unavailable(error.localizedDescription)
        }
    }

    private func present(_ chat: AidenChat, owner: AidenRemoteRequestContext, coordinator: AidenRemoteCoordinator) async {
        guard coordinator.isLive(owner), chat.id == id.objectId else {
            state = .unavailable(String(localized: "This chat is no longer available."))
            return
        }
        if let botId = chat.botId {
            let installation = coordinator.installationStore.installations.first { $0.id == id.instanceId }
            if let explanation = AidenBotsAvailability.resolve(installation).tabExplanation {
                state = .unavailable(explanation)
            } else {
                state = .botChat(AidenHostObjectID(instanceId: id.instanceId, deviceId: id.deviceId, objectId: botId))
            }
            return
        } else if let refusal = await workspaceRefusal(of: chat, coordinator: coordinator) {
            state = .unavailable(refusal)
            return
        }
        // Cancelled: the view is loading again, and that load decides.
        guard !Task.isCancelled else { return }
        state = coordinator.isLive(owner)
            ? .ready(chat, owner: owner)
            : .unavailable(String(localized: "This chat is no longer available."))
    }

    /// Why this chat's workspace rules it out. Only a machine that's answering
    /// can say a workspace is gone, so a saved chat stays readable while it's away.
    private func workspaceRefusal(of chat: AidenChat, coordinator: AidenRemoteCoordinator) async -> String? {
        if coordinator.workspaceArchiveStore.isArchived(workspaceID: chat.workspaceId, instanceID: id.instanceId) {
            return String(localized: "That chat belongs to a workspace archived on this device. Unarchive it from Workspaces to open the chat.")
        }
        guard let connection = coordinator.hosts.connection(for: id.instanceId),
              connection.connectionState == .connected else { return nil }
        func isListed() -> Bool { connection.workspaces.contains { $0.id == chat.workspaceId } }
        guard !isListed() else { return nil }
        // A chat started without a workspace can sit in a hidden folder made
        // after the phone last read the machine's workspaces.
        do {
            try await connection.refreshWorkspacesForPoll()
        } catch {
            return nil
        }
        return isListed() ? nil : String(localized: "The chat's workspace is no longer available.")
    }
}

private struct AidenChatRouteView: View {
    let coordinator: AidenRemoteCoordinator
    let autoStartVoice: Bool
    /// Set only while this chat is a Catch Up run's. On the route rather than the
    /// chat, so a chat that can't load can still be moved on from, and a fork
    /// pushed over it has no Next of its own.
    let onNext: (() -> Void)?
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    let onForkOpened: @MainActor (AidenChat) -> Void
    let onBotChat: @MainActor (AidenHostObjectID) -> Void
    @State private var model: AidenChatRouteModel
    @State private var holdsAttachments = false
    @State private var isConfirmingNext = false

    init(
        coordinator: AidenRemoteCoordinator,
        id: AidenHostObjectID,
        receipt: AidenChat?,
        autoStartVoice: Bool,
        onNext: (() -> Void)?,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void,
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void,
        onForkOpened: @escaping @MainActor (AidenChat) -> Void,
        onBotChat: @escaping @MainActor (AidenHostObjectID) -> Void
    ) {
        self.coordinator = coordinator
        self.autoStartVoice = autoStartVoice
        self.onNext = onNext
        self.onChatUpdated = onChatUpdated
        self.onChatActivityChanged = onChatActivityChanged
        self.onForkOpened = onForkOpened
        self.onBotChat = onBotChat
        _model = State(initialValue: AidenChatRouteModel(id: id, receipt: receipt))
    }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView()
            case .ready(let chat, let owner):
                AidenForkableChatDetailView(
                    coordinator: coordinator,
                    chat: chat,
                    owner: owner,
                    autoStartVoice: autoStartVoice,
                    onChatUpdated: onChatUpdated,
                    onChatActivityChanged: onChatActivityChanged,
                    onForkOpened: onForkOpened
                )
            case .botChat(let bot):
                ProgressView()
                    .task { onBotChat(bot) }
            case .unavailable(let message):
                ContentUnavailableView(
                    "Chat unavailable",
                    systemImage: "exclamationmark.bubble",
                    description: Text(message)
                )
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            if let onNext {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Next") {
                        if holdsAttachments { isConfirmingNext = true } else { onNext() }
                    }
                    .accessibilityHint("Opens the next chat that needs you")
                    .confirmationDialog(
                        "Discard attachments?",
                        isPresented: $isConfirmingNext,
                        titleVisibility: .visible
                    ) {
                        Button("Discard attachments", role: .destructive, action: onNext)
                        Button("Stay", role: .cancel) {}
                    } message: {
                        Text("They aren’t kept when you move to the next chat. Your message text is saved.")
                    }
                }
            }
        }
        .onPreferenceChange(AidenChatHoldsAttachmentsKey.self) { holds in
            holdsAttachments = holds
        }
        .task(id: coordinator.hosts.connection(for: model.id.instanceId)?.connectionState) {
            await model.load(coordinator: coordinator)
        }
    }
}
