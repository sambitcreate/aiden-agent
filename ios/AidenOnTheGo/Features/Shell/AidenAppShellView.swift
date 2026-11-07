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

/// The four tabs, behind `AppConfig.tabShellEnabled`. Each tab has its own stack.
struct AidenAppShellView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Binding private var navigationRequest: AidenNavigationRequest?
    private let inboxStore: AidenUnifiedInboxStore
    private let navigationStore: AidenAppNavigationStore
    private let intents: AidenForegroundIntentRouter

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var navigation: AidenAppNavigation
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
        _navigation = State(initialValue: AidenAppNavigation(
            restoring: navigationStore.load(),
            installations: coordinator.installationStore.installations
        ))
    }

    private var botsAvailability: AidenBotsAvailability {
        AidenBotsAvailability.resolve(coordinator.installationStore.activeInstallation)
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
                        onCatchUp: { markViewed(navigation.startCatchUp(in: catchUpQueue)) },
                        onShowRunning: { showsRunningChats = true }
                    )
                    .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }
            .badge(inboxStore.needsYouCount)

            Tab("Bots", systemImage: AidenProductArea.bots.symbol, value: AidenAppTab.bots) {
                NavigationStack(path: $navigation.botsPath) {
                    AidenBotsRootView(availability: botsAvailability)
                        .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }

            Tab("Workspaces", systemImage: "folder", value: AidenAppTab.workspaces) {
                NavigationStack(path: $navigation.workspacesPath) {
                    AidenTabPlaceholderView(title: "Workspaces", systemImage: "folder")
                        .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }

            Tab(value: AidenAppTab.search, role: .search) {
                NavigationStack {
                    AidenTabPlaceholderView(title: "Search", systemImage: "magnifyingglass")
                }
                // On the `TabView` this would put a field on every tab.
                .searchable(text: $searchText)
            }
        }
        .tabViewStyle(.sidebarAdaptable)
        .tabBarMinimizeBehavior(horizontalSizeClass == .compact ? .onScrollDown : .automatic)
        .tabViewSearchActivation(.searchTabSelection)
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
    }

    @ViewBuilder
    private func destination(for route: AidenAppRoute) -> some View {
        switch route {
        case .chat(let id):
            AidenChatRouteView(
                coordinator: coordinator,
                id: id,
                autoStartVoice: navigation.chatStartingVoice == id,
                onNext: navigation.catchUp?.current == id ? nextInCatchUp : nil,
                onChatUpdated: { chat in
                    inboxStore.homeModel(for: id.instanceId)?.accept(chat)
                },
                onChatActivityChanged: { chatID, activity in
                    inboxStore.homeModel(for: id.instanceId)?.setActivity(activity, forChatID: chatID)
                }
            )
            // Next swaps the route in place, and the stack would otherwise keep this
            // view's state, so the old chat would stay on screen.
            .id(id)
            .onDisappear { navigation.finishStartingVoice(id) }
        case .bot(let id):
            let installation = coordinator.installationStore.installations.first { $0.id == id.instanceId }
            AidenBotsRootView(availability: AidenBotsAvailability.resolve(installation))
        case .workspace:
            AidenTabPlaceholderView(title: "Workspace", systemImage: "folder")
        case .machines:
            AidenMachinesRouteView(coordinator: coordinator)
        case .machine(let instanceId):
            AidenMachineDetailView(instanceId: instanceId, coordinator: coordinator, preferences: .shared)
        case .settings:
            AidenTabPlaceholderView(title: "Settings", systemImage: "gearshape")
        case .scheduled:
            AidenTabPlaceholderView(title: "Scheduled tasks", systemImage: "calendar")
        case .usage:
            AidenTabPlaceholderView(title: "Usage", systemImage: "chart.bar")
        case .catchUpFinished:
            AidenCatchUpFinishedView { navigation.inboxPath = [] }
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

/// Bots stays selectable when a machine can't offer them, and says why.
private struct AidenBotsRootView: View {
    let availability: AidenBotsAvailability

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        if let explanation = availability.tabExplanation {
            ContentUnavailableView(
                "Bots unavailable",
                systemImage: "person.2.slash",
                description: Text(explanation)
            )
            .background(palette.canvas.ignoresSafeArea())
            .navigationTitle("Bots")
        } else {
            AidenTabPlaceholderView(title: "Bots", systemImage: AidenProductArea.bots.symbol)
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
        case unavailable(String)
    }

    let id: AidenHostObjectID
    private(set) var state = State.loading
    @ObservationIgnored private let cache: AidenChatCache

    init(id: AidenHostObjectID, cache: AidenChatCache = .shared) {
        self.id = id
        self.cache = cache
    }

    func load(coordinator: AidenRemoteCoordinator) async {
        if case .ready = state { return }
        guard let owner = try? coordinator.ownerContext(for: id.instanceId), owner.deviceId == id.deviceId else {
            state = .unavailable(String(localized: "This machine is no longer paired. Pair it again to open this chat."))
            return
        }
        // Saved transcript first: the chat opens at once and refreshes itself.
        if let saved = await cache.admittedChat(instanceId: id.instanceId, chatId: id.objectId) {
            present(await cache.presenting(saved, instanceId: id.instanceId), owner: owner, coordinator: coordinator)
            return
        }
        do {
            let chat = try await coordinator.remoteClient(for: owner).chat(id: id.objectId)
            present(chat, owner: owner, coordinator: coordinator)
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

    private func present(_ chat: AidenChat, owner: AidenRemoteRequestContext, coordinator: AidenRemoteCoordinator) {
        guard coordinator.isLive(owner), chat.id == id.objectId else {
            state = .unavailable(String(localized: "This chat is no longer available."))
            return
        }
        if chat.isBotChat {
            let installation = coordinator.installationStore.installations.first { $0.id == id.instanceId }
            if let explanation = AidenBotsAvailability.resolve(installation).tabExplanation {
                state = .unavailable(explanation)
                return
            }
        }
        state = .ready(chat, owner: owner)
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
    @State private var model: AidenChatRouteModel

    init(
        coordinator: AidenRemoteCoordinator,
        id: AidenHostObjectID,
        autoStartVoice: Bool,
        onNext: (() -> Void)?,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void,
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void
    ) {
        self.coordinator = coordinator
        self.autoStartVoice = autoStartVoice
        self.onNext = onNext
        self.onChatUpdated = onChatUpdated
        self.onChatActivityChanged = onChatActivityChanged
        _model = State(initialValue: AidenChatRouteModel(id: id))
    }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView()
            case .ready(let chat, let owner) where chat.isBotChat:
                // Sending needs the Bot's own health check, which the Bots tab brings.
                AidenChatDetailView(
                    coordinator: coordinator,
                    chat: chat,
                    owner: owner,
                    allowsMutations: false,
                    onChatUpdated: onChatUpdated,
                    onChatActivityChanged: onChatActivityChanged
                )
            case .ready(let chat, let owner):
                AidenForkableChatDetailView(
                    coordinator: coordinator,
                    chat: chat,
                    owner: owner,
                    autoStartVoice: autoStartVoice,
                    onChatUpdated: onChatUpdated,
                    onChatActivityChanged: onChatActivityChanged
                )
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
                    Button("Next", action: onNext)
                        .accessibilityHint("Opens the next chat that needs you")
                }
            }
        }
        .task(id: coordinator.hosts.connection(for: model.id.instanceId)?.connectionState) {
            await model.load(coordinator: coordinator)
        }
    }
}
