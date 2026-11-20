import SwiftUI

enum AidenChromeSymbols {
    static let overflowMenu = "ellipsis"
    /// The Bots tab, and a Bot's row in Search.
    static let bots = "person.2.fill"
}

enum AidenBotsAvailability: Equatable, Sendable {
    case available(canWrite: Bool)
    case mobileDisabled
    case unsupported
    case notGranted

    var canOpen: Bool {
        if case .available = self { return true }
        return false
    }

    var canWrite: Bool {
        if case .available(canWrite: true) = self { return true }
        return false
    }

    static func resolve(
        _ installation: AidenInstallation?,
        mobileEnabled: Bool = AppConfig.botFirstMobileEnabled
    ) -> Self {
        guard mobileEnabled else { return .mobileDisabled }
        guard let installation,
              let supported = installation.serverCapabilities,
              supported.contains(.botRead) else {
            return .unsupported
        }
        guard installation.deviceCapabilities.contains(.botRead) else {
            return .notGranted
        }
        return .available(canWrite: installation.canWriteBots)
    }
}

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
            String(localized: "Bots need a newer version of Aiden Agent on your paired computer.")
        case .notGranted:
            String(localized: "Approve Bot access on your paired computer, or pair this phone again.")
        }
    }
}

private struct AidenArchiveSyncID: Equatable {
    let instanceID: String?
    let workspaceRevision: Int
    let archivedIDs: Set<String>
}

/// What the shell makes once, the first time it draws, and keeps.
@MainActor
final class AidenAppShellParts {
    struct Built {
        let navigation: AidenAppNavigation
        let newWork: AidenNewWorkChatFlow
    }

    private var made: Built?
    /// How many times `make` ran, for the test that pins it to once.
    private(set) var makeCount = 0

    func built(_ make: () -> Built) -> Built {
        if let made { return made }
        makeCount += 1
        let built = make()
        made = built
        return built
    }
}

/// The app: four tabs, each with its own stack.
struct AidenAppShellView: View {
    @Bindable var coordinator: AidenRemoteCoordinator
    @Binding private var navigationRequest: AidenNavigationRequest?
    /// A route asked for from outside the shell, such as Machines from the
    /// connection recovery banner. Shown on its own tab, then cleared.
    @Binding private var routeRequest: AidenAppRoute?
    private let inboxStore: AidenUnifiedInboxStore
    private let navigationStore: AidenAppNavigationStore
    private let intents: AidenForegroundIntentRouter

    @Environment(AidenAppearanceStore.self) private var appearance
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.aidenPalette) private var palette
    /// The navigation and compose flow, made on the shell's first draw. `init`
    /// runs on every ContentView render and `State` keeps only its first value,
    /// so building them there read and decoded the saved navigation each time.
    @State private var parts = AidenAppShellParts()
    @State private var botSummaries: [AidenHostObjectID: AidenBotSummary] = [:]
    @State private var searchText = ""
    @State private var showsRunningChats = false
    /// The Inbox split's columns. Both are asked for: the system tiles them when
    /// they fit (an iPhone Duo open in landscape) and lays the list over the
    /// detail when they don't (open in portrait), where picking a row puts it away.
    @State private var inboxColumns = NavigationSplitViewVisibility.all
    @State private var inboxSplitFrame = CGRect.zero
    @State private var inboxDetailFrame = CGRect.zero
    /// Whether the window was landscape the last time the split was measured.
    @State private var inboxWasLandscape: Bool?
    /// Whether the system puts its bars in a rail beside the content, as on a
    /// closed iPhone Duo.
    @State private var showsVerticalBar = false

    init(
        coordinator: AidenRemoteCoordinator,
        inboxStore: AidenUnifiedInboxStore,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil),
        routeRequest: Binding<AidenAppRoute?> = .constant(nil),
        navigationStore: AidenAppNavigationStore = AidenAppNavigationStore(),
        intents: AidenForegroundIntentRouter? = nil
    ) {
        self.coordinator = coordinator
        self.inboxStore = inboxStore
        _navigationRequest = navigationRequest
        _routeRequest = routeRequest
        self.navigationStore = navigationStore
        self.intents = intents ?? .shared
    }

    private var navigation: AidenAppNavigation { built.navigation }

    /// Compose in the Inbox and on the Workspaces tab, on a machine the person
    /// picks. A chat started from Workspaces stays there; anywhere else it's the Inbox's.
    private var newWork: AidenNewWorkChatFlow { built.newWork }

    private var built: AidenAppShellParts.Built {
        parts.built { [coordinator, inboxStore, navigationStore, horizontalSizeClass] in
            let navigation = AidenAppNavigation(
                restoring: navigationStore.load(
                    installations: coordinator.installationStore.installations,
                    selected: coordinator.defaultInstanceId
                ),
                installations: coordinator.installationStore.installations
            )
            // Set before any link or request opens a route, which reads it.
            navigation.inboxBesideList = horizontalSizeClass == .regular
            let newWork = AidenNewWorkChatFlow(coordinator: coordinator) { [weak navigation] chat, id in
                let home = inboxStore.homeModel(for: id.instanceId)
                home?.accept(chat)
                home?.markViewed(chatID: chat.id)
                guard let navigation else { return }
                navigation.open(.chat(id), on: navigation.tab == .workspaces ? .workspaces : .inbox)
            }
            return AidenAppShellParts.Built(navigation: navigation, newWork: newWork)
        }
    }

    /// The default machine's: it explains an empty single-machine Bots page and
    /// gates that page's writes. With several machines each row and New Bot ask
    /// their own machine.
    private var botsAvailability: AidenBotsAvailability {
        AidenBotsAvailability.resolve(coordinator.installationStore.activeInstallation)
    }

    private var archiveSyncID: AidenArchiveSyncID {
        AidenArchiveSyncID(
            instanceID: coordinator.defaultInstanceId,
            workspaceRevision: coordinator.workspaceSnapshotRevision,
            archivedIDs: coordinator.workspaceArchiveStore.archivedWorkspaceIDs(for: coordinator.defaultInstanceId)
        )
    }

    /// A machine that can't report usage leaves nothing to open, as on the old home.
    /// Usage is the default machine's page, as the rest of the More menu is.
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
        TabView(selection: Bindable(navigation).tab) {
            Tab("Inbox", systemImage: "tray", value: AidenAppTab.inbox) {
                // One split view at every width, collapsed by the system to a
                // single stack when compact. Swapping it for a separate stack
                // when an iPhone Duo closed let the split's own collapse pop
                // land on the new stack, which emptied the path.
                NavigationSplitView(columnVisibility: $inboxColumns, preferredCompactColumn: inboxCompactColumn) {
                    inboxList(selection: showsInboxBesideDetail ? AidenSplitNavigationPath(displayedInboxPath).selection : nil)
                } detail: {
                    inboxDetail
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { inboxDetailFrame = $0 }
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { inboxSplitFrame = $0 }
                // Turning the device brings the list back. Other resizes leave
                // the columns as the person set them; opening or closing an
                // iPhone Duo changes the size class, handled below.
                .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                    showInboxListIfTurned(size: size)
                }
                // A chat chosen any other way: a link, Catch Up's Next.
                .onChange(of: AidenSplitNavigationPath(navigation.inboxPath).selection) {
                    hideOverlaidInboxList()
                }
            }
            .badge(inboxStore.needsYouCount)
            // An iPad's tab strip draws the badge without saying it.
            .accessibilityValue(
                Text(inboxStore.needsYouCount == 1 ? "1 chat needs you" : "\(inboxStore.needsYouCount) chats need you"),
                isEnabled: inboxStore.needsYouCount > 0
            )

            Tab("Bots", systemImage: AidenChromeSymbols.bots, value: AidenAppTab.bots) {
                NavigationStack(path: Bindable(navigation).botsPath) {
                    AidenBotsTabView(
                        coordinator: coordinator,
                        store: inboxStore,
                        navigation: navigation,
                        availability: botsAvailability,
                        onOpenBot: { id, bot in botSummaries[id] = bot }
                    )
                    .navigationDestination(for: AidenAppRoute.self, destination: destination)
                }
            }

            Tab("Workspaces", systemImage: "folder", value: AidenAppTab.workspaces) {
                NavigationStack(path: Bindable(navigation).workspacesPath) {
                    AidenWorkspacesTabView(coordinator: coordinator, store: inboxStore, newWork: newWork)
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
        // The system's own placement: an iPad opens on the tab strip, and the
        // sidebar is a tap away. Asking for the sidebar by default
        // (`defaultAdaptableTabBarPlacement(.sidebar)`) made SwiftUI write its
        // sidebar state while drawing the first frame, which it reports as
        // "Modifying state during view update".
        .tabViewStyle(.sidebarAdaptable)
        .background { AidenVerticalBarReader { showsVerticalBar = $0 } }
        .tabBarMinimizeBehavior(horizontalSizeClass == .compact ? .onScrollDown : .automatic)
        .tabViewSearchActivation(.searchTabSelection)
        .aidenNewWorkPresentation(newWork, coordinator: coordinator)
        // Hiding the tab bar leaves the accessory up, under the composer.
        .aidenRunningAccessory(
            isEnabled: runningHome == .accessory && inboxStore.hasRunningChats && !navigation.showsConversation
        ) {
            AidenRunningAccessoryHost(store: inboxStore, onOpen: openRow) { showsRunningChats = true }
        }
        .sheet(isPresented: $showsRunningChats) {
            AidenRunningChatsSheet(store: inboxStore) { route in
                showsRunningChats = false
                openRow(route)
            }
        }
        // On every tab, the accessory and its sheet, so a machine page reached from
        // any of them counts its open chats.
        .environment(inboxStore)
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
        .onChange(of: horizontalSizeClass) { _, sizeClass in
            inboxColumns = .all
            navigation.inboxBesideList = sizeClass == .regular
        }
        .onChange(of: navigation.inboxOpenChat, initial: true) { _, chat in
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
        .onChange(of: routeRequest, initial: true) { _, route in
            guard let route else { return }
            routeRequest = nil
            navigation.open(route)
        }
        .onChange(of: intents.routes, initial: true) {
            for queued in intents.takeRoutes(openableOn: coordinator) {
                navigation.open(queued.route, startsVoice: queued.startsVoice)
            }
        }
        .onChange(of: coordinator.defaultInstanceId) { _, _ in
            navigation.leaveSelectedMachineRoutes()
        }
        .task(id: archiveSyncID) {
            coordinator.setDeviceArchivedWorkspaceIDs(archiveSyncID.archivedIDs, for: archiveSyncID.instanceID)
        }
    }

    /// Regular width puts the Inbox list beside the chat it opened, as on an
    /// iPhone Duo's inner display or an iPad. Compact width collapses the split
    /// to one stack.
    private var showsInboxBesideDetail: Bool {
        horizontalSizeClass == .regular
    }

    /// The Inbox path as drawn. Beside the list it's the path the list takes
    /// over, so the first frame after the display opens already highlights
    /// the chat on screen; `inboxBesideList` then stores the same path.
    private var displayedInboxPath: [AidenAppRoute] {
        showsInboxBesideDetail ? AidenSplitNavigationPath.takingOver(navigation.inboxPath) : navigation.inboxPath
    }

    /// Collapsed, the split shows the list until the path holds something,
    /// then the detail. Back from the detail's root returns to the list, which
    /// clears the path. Writes while not compact are the split's own and
    /// change nothing.
    private var inboxCompactColumn: Binding<NavigationSplitViewColumn> {
        Binding(
            get: { navigation.inboxPath.isEmpty ? .sidebar : .detail },
            set: { column in
                guard !showsInboxBesideDetail, column == .sidebar, !navigation.inboxPath.isEmpty else { return }
                navigation.inboxPath = []
            }
        )
    }

    /// The Inbox list with its banner and toolbar. `selection` is the row the
    /// detail beside it shows.
    private func inboxList(selection: AidenAppRoute?) -> some View {
        AidenInboxTabRootView(
            store: inboxStore,
            runningHome: runningHome,
            onOpen: openRow,
            onDelete: deleteChat,
            onOpenMachines: { navigation.open(.machines) },
            onCatchUp: {
                markViewed(navigation.startCatchUp(in: catchUpQueue))
                hideOverlaidInboxList()
            },
            onShowRunning: { showsRunningChats = true },
            selection: selection
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            AidenConnectionNotice(coordinator: coordinator)
        }
        .toolbar { inboxToolbar }
    }

    /// The detail column: the selected route at the root of its own stack, and
    /// the rest of the Inbox path pushed over it.
    private var inboxDetail: some View {
        let selection = AidenSplitNavigationPath(displayedInboxPath).selection
        return NavigationStack(path: Binding(
            get: { AidenSplitNavigationPath(displayedInboxPath).detailPath },
            set: { detailPath in
                var split = AidenSplitNavigationPath(displayedInboxPath)
                split.setDetailPath(detailPath)
                if split.path != navigation.inboxPath { navigation.inboxPath = split.path }
            }
        )) {
            Group {
                if let selection {
                    besideListDestination(for: selection)
                        // Another row is another screen, not this one updated.
                        .id(selection)
                } else {
                    ContentUnavailableView(
                        "No chat selected",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Pick a chat from the Inbox.")
                    )
                    .background(palette.canvas.ignoresSafeArea())
                }
            }
            .navigationDestination(for: AidenAppRoute.self, destination: besideListDestination)
        }
    }

    /// A screen in the detail column. Beside the list a conversation keeps the
    /// tabs up, as the list is; collapsed it's any stack's screen.
    private func besideListDestination(for route: AidenAppRoute) -> some View {
        screen(for: route, keepsTabs: showsInboxBesideDetail)
    }

    /// Picking a row while the list is an overlay over the detail (a narrow
    /// regular width, such as an iPhone Duo open in portrait) puts the overlay
    /// away, so the chosen chat is in view, including one tapped again while
    /// already selected. Tiled columns are left as they are.
    private func hideOverlaidInboxList() {
        guard showsInboxBesideDetail, inboxColumns != .detailOnly,
              AidenSplitNavigationPath(navigation.inboxPath).selection != nil,
              AidenSplitNavigationPath.listIsOverlaid(detailFrame: inboxDetailFrame, splitFrame: inboxSplitFrame)
        else { return }
        inboxColumns = .detailOnly
    }

    /// Brings the Inbox list back when the device turned. The window's
    /// orientation decides, not the split's shape: the keyboard shortens the
    /// split in portrait until it's wider than tall, and a turn resizes it in
    /// two steps that pass through a square.
    private func showInboxListIfTurned(size: CGSize) {
        let landscape = Self.windowIsLandscape ?? (size.width > size.height)
        defer { inboxWasLandscape = landscape }
        guard let inboxWasLandscape, inboxWasLandscape != landscape else { return }
        inboxColumns = .all
    }

    /// The foreground window's orientation, or nil before there is one.
    private static var windowIsLandscape: Bool? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
        else { return nil }
        let orientation = scene.effectiveGeometry.interfaceOrientation
        guard orientation != .unknown else { return nil }
        return orientation.isLandscape
    }

    private func deleteChat(_ id: AidenHostObjectID) {
        navigation.leave(.chat(id))
        Task {
            switch await inboxStore.delete(id) {
            case .deleted:
                coordinator.haptics.play(.success, scope: newWork.hapticScope, dedupeKey: "chat-remove:\(id.objectId)")
            case .failed:
                coordinator.haptics.play(.error, scope: newWork.hapticScope)
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
            AidenNewWorkComposeButton(flow: newWork)
        }
    }

    /// A screen on a tab's stack.
    private func destination(for route: AidenAppRoute) -> some View {
        screen(for: route, keepsTabs: false)
    }

    /// A conversation hides the tabs on a stack, where the composer owns the
    /// bottom edge. Where the system puts its bars in a rail at the side, as
    /// on a closed iPhone Duo, the tabs stay in the rail: they cover nothing
    /// there, and with them hidden the rail turns opaque white or black
    /// instead of showing the canvas under it. Set on each screen, root and
    /// pushed, because a pushed screen doesn't read the environment from
    /// outside its stack.
    private func screen(for route: AidenAppRoute, keepsTabs: Bool) -> some View {
        routeScreen(for: route)
            .environment(\.aidenConversationTabBar, keepsTabs || showsVerticalBar ? .automatic : .hidden)
    }

    @ViewBuilder
    private func routeScreen(for route: AidenAppRoute) -> some View {
        switch route {
        case .chat(let id):
            AidenChatRouteView(
                coordinator: coordinator,
                id: id,
                receipt: newWork.receipt(for: id),
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
            .environment(\.aidenConversationMachine, inboxStore.roster.chatSubtitle(for: id.instanceId))
            // Next swaps the route in place, and the stack would otherwise keep this
            // view's state, so the old chat would stay on screen.
            .id(id)
            .onDisappear {
                navigation.finishStartingVoice(id)
                newWork.forgetReceipt(id)
            }
        case .bot(let id):
            AidenBotRouteView(
                coordinator: coordinator,
                id: id,
                initialSummary: botSummaries[id],
                onNext: navigation.catchUp?.current == id ? nextInCatchUp : nil
            )
            .environment(\.aidenConversationMachine, inboxStore.roster.chatSubtitle(for: id.instanceId))
            // Next swaps the route in place, as for a chat.
            .id(id)
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
            AidenAppSettingsView(coordinator: coordinator, appearance: appearance)
        case .scheduled:
            AidenScheduledTasksView(coordinator: coordinator)
        case .usage:
            AidenMachineUsageView(coordinator: coordinator)
        case .catchUpFinished(let ending):
            AidenCatchUpFinishedView(ending: ending) { navigation.inboxPath = [] }
        }
    }

    /// An Inbox row: its chat, or its Bot, on the Inbox stack.
    private func openRow(_ route: AidenAppRoute) {
        if case .chat(let id) = route { markViewed(id) }
        navigation.openInboxRow(route)
        hideOverlaidInboxList()
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
            defaultInstanceId: coordinator.defaultInstanceId
        ) {
            navigation.open(route, startsVoice: request.startsVoice)
        } else {
            coordinator.presentedError = coordinator.noLongerPairedMessage(for: request.instanceId)
        }
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
            state = .unavailable(String(localized: "This computer is no longer paired. Pair it again to open this chat."))
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
                state = .unavailable(String(localized: "This computer is no longer paired. Pair it again to open this chat."))
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
    @Environment(\.aidenConversationTabBar) private var tabBar

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
        .toolbar(tabBar, for: .tabBar)
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

/// Reports whether the system puts its bars in a vertical rail beside the
/// content, as on a closed iPhone Duo's outer display. SwiftUI has no
/// environment value for it, so this reads UIKit's trait. Always false before
/// iOS 27.1.
private struct AidenVerticalBarReader: UIViewRepresentable {
    let onChange: @MainActor (Bool) -> Void

    func makeUIView(context: Context) -> TraitView {
        let view = TraitView()
        view.onChange = onChange
        return view
    }

    func updateUIView(_ view: TraitView, context: Context) {
        view.onChange = onChange
    }

    final class TraitView: UIView {
        var onChange: (@MainActor (Bool) -> Void)?
        private var reported: Bool?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            if #available(iOS 27.1, *) {
                registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: TraitView, _) in
                    view.report()
                }
            }
        }

        required init?(coder: NSCoder) {
            super.init(coder: coder)
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            report()
        }

        private func report() {
            guard window != nil else { return }
            var showsVerticalBar = false
            if #available(iOS 27.1, *) {
                showsVerticalBar = traitCollection.verticalBarEdge != .unspecified
            }
            guard showsVerticalBar != reported else { return }
            reported = showsVerticalBar
            // After the current update: the change sets SwiftUI state.
            Task { @MainActor [onChange] in onChange?(showsVerticalBar) }
        }
    }
}
