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
    private let inboxBadge: Int
    private let navigationStore: AidenAppNavigationStore

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var navigation: AidenAppNavigation
    @State private var homeModel = AidenHomeModel()
    @State private var searchText = ""

    init(
        coordinator: AidenRemoteCoordinator,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil),
        inboxBadge: Int = 0,
        navigationStore: AidenAppNavigationStore = AidenAppNavigationStore()
    ) {
        self.coordinator = coordinator
        _navigationRequest = navigationRequest
        self.inboxBadge = inboxBadge
        self.navigationStore = navigationStore
        _navigation = State(initialValue: AidenAppNavigation(
            restoring: navigationStore.load(
                installations: coordinator.installationStore.installations,
                selected: coordinator.activeInstanceId
            ),
            installations: coordinator.installationStore.installations
        ))
    }

    private var botsAvailability: AidenBotsAvailability {
        AidenBotsAvailability.resolve(coordinator.installationStore.activeInstallation)
    }

    var body: some View {
        TabView(selection: $navigation.tab) {
            Tab("Inbox", systemImage: "tray", value: AidenAppTab.inbox) {
                NavigationStack(path: $navigation.inboxPath) {
                    AidenInboxRootView(coordinator: coordinator, model: homeModel, onOpen: openChat)
                        .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }
            .badge(inboxBadge)

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
        .onChange(of: coordinator.installationStore.installations) { _, installations in
            navigation.dropRoutes(outside: installations)
        }
        .onChange(of: navigationRequest, initial: true) { _, request in
            guard let request else { return }
            navigationRequest = nil
            open(request)
        }
    }

    @ViewBuilder
    private func destination(for route: AidenAppRoute) -> some View {
        switch route {
        case .chat(let id):
            AidenChatRouteView(
                coordinator: coordinator,
                id: id,
                onChatUpdated: { chat in
                    if id.instanceId == coordinator.activeInstanceId { homeModel.accept(chat) }
                },
                onChatActivityChanged: { chatID, activity in
                    if id.instanceId == coordinator.activeInstanceId {
                        homeModel.setActivity(activity, forChatID: chatID)
                    }
                }
            )
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
        }
    }

    private func openChat(_ summary: AidenChatSummary) {
        guard let installation = coordinator.installationStore.activeInstallation else { return }
        homeModel.markViewed(chatID: summary.id)
        navigation.open(.chat(AidenHostObjectID(
            instanceId: installation.id,
            deviceId: installation.deviceId,
            objectId: summary.id
        )))
    }

    private func open(_ request: AidenNavigationRequest) {
        if request.destination == .newChat {
            navigation.tab = .workspaces
        } else if let route = AidenAppRoute(
            request: request,
            installations: coordinator.installationStore.installations,
            activeInstanceId: coordinator.activeInstanceId
        ) {
            navigation.open(route)
        } else {
            coordinator.presentedError = String(localized: "This machine is no longer paired. Pair it again to continue.")
        }
    }
}

/// The selected machine's chats, in the order it lists them, until the Inbox
/// tab has its own view.
private struct AidenInboxRootView: View {
    private struct LoadID: Equatable {
        let instanceID: String?
        let connectionState: AidenRemoteConnectionState
    }

    let coordinator: AidenRemoteCoordinator
    let model: AidenHomeModel
    let onOpen: (AidenChatSummary) -> Void

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        List(model.chats) { chat in
            Button(chat.title) { onOpen(chat) }
                .foregroundStyle(palette.foreground)
                .listRowBackground(palette.canvas)
        }
        .scrollContentBackground(.hidden)
        .background(palette.canvas.ignoresSafeArea())
        .overlay {
            if model.chats.isEmpty { emptyState }
        }
        .navigationTitle("Inbox")
        .task(id: LoadID(instanceID: coordinator.activeInstanceId, connectionState: coordinator.connectionState)) {
            await model.load(coordinator: coordinator)
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        switch model.chatListLoadState {
        case .unresolved, .loading:
            ProgressView()
        case .loaded:
            ContentUnavailableView("No chats yet", systemImage: "tray")
        case .failed(let message):
            ContentUnavailableView("Chats unavailable", systemImage: "tray", description: Text(message))
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
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    @State private var model: AidenChatRouteModel

    init(
        coordinator: AidenRemoteCoordinator,
        id: AidenHostObjectID,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void,
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void
    ) {
        self.coordinator = coordinator
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
        .task(id: coordinator.hosts.connection(for: model.id.instanceId)?.connectionState) {
            await model.load(coordinator: coordinator)
        }
    }
}
