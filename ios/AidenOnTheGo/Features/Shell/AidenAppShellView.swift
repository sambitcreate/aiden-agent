import SwiftUI

enum AidenChromeSymbols {
    static let overflowMenu = "ellipsis"
    /// The Bots tab, and a Bot's row in Search.
    static let bots = "person.2.fill"
}

extension ToolbarContent {
    /// The item the bar gives up last when it runs out of room, as a closed
    /// iPhone Duo's side rail does: compose. Before iOS 27 the system decides.
    /// `visibilityPriority` is in the iOS 27.0 SDK (SwiftUI 8.0); the SDK
    /// check lets the iOS 26 SDK (Xcode 26.6, CI) build without it.
    @ToolbarContentBuilder
    func aidenKeptLongestInBar() -> some ToolbarContent {
        #if canImport(SwiftUI, _version: 8.0)
        if #available(iOS 27.0, *) {
            visibilityPriority(.high)
        } else {
            self
        }
        #else
        self
        #endif
    }
}

extension View {
    /// For a task view, such as a conversation: where the bars run short of
    /// height, as in a closed iPhone Duo's side rail, the system keeps the
    /// screen's own actions and shrinks the tab bar first. The API arrived in
    /// the iOS 27.1 SDK (UIKit 9127.0.85), so Xcode 27.0 builds without it.
    func aidenPrefersToolbarItems() -> some View {
        modifier(AidenPrefersToolbarItems())
    }
}

private struct AidenPrefersToolbarItems: ViewModifier {
    func body(content: Content) -> some View {
        #if canImport(UIKit, _version: 9127.0.85)
        if #available(iOS 27.1, *) {
            content.toolbarVerticalCompressionBehavior(.prefersToolbarItems)
        } else {
            content
        }
        #else
        content
        #endif
    }
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
        let chatScreens: AidenChatScreens
        let homeComposer: AidenHomeComposerModel
        let homeFeed: AidenHomeFeedModel
        let search: AidenSearchModel
        let listScroll: AidenListScrollPlaces
        let offlineNotices: AidenOfflineNoticeDismissals
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
    /// A tab root asked for from the Home Screen. Shown at its root, then cleared.
    @Binding private var tabRequest: AidenAppTab?
    private let inboxStore: AidenUnifiedInboxStore
    private let navigationStore: AidenAppNavigationStore
    private let intents: AidenForegroundIntentRouter

    @Environment(AidenAppearanceStore.self) private var appearance
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.aidenPalette) private var palette
    private enum ShellSheet: Identifiable {
        case runningChats
        case pairing(showsDesktopCheck: Bool)

        var id: String {
            switch self {
            case .runningChats: "running-chats"
            case .pairing(let showsDesktopCheck): "pairing-\(showsDesktopCheck)"
            }
        }
    }

    /// The navigation and compose flow, made on the shell's first draw. `init`
    /// runs on every ContentView render and `State` keeps only its first value,
    /// so building them there read and decoded the saved navigation each time.
    @State private var parts = AidenAppShellParts()
    @State private var botSummaries: [AidenHostObjectID: AidenBotSummary] = [:]
    /// What Home's ambient background shows, read from the inbox.
    @State private var ambient = AidenAmbientActivityModel()
    @State private var activeSheet: ShellSheet?
    /// Add Computer from the drawer: pairing is the shell's sheet, presented
    /// once the drawer's cover has gone, not in the same update.
    @State private var pairsAfterDrawer = false
    /// Each list tab's split columns.
    @State private var chatsColumns = AidenSplitColumns()
    @State private var inboxColumns = AidenSplitColumns()
    @State private var botsColumns = AidenSplitColumns()
    @State private var workspacesColumns = AidenSplitColumns()
    /// Whether the system puts its bars in a rail beside the content, as on a
    /// closed iPhone Duo.
    @State private var showsVerticalBar = false
    /// The shell's own window, for its orientation.
    @State private var window = AidenWindowReader.Window()
    /// Whether the software keyboard is up. The compact dock gives way to it.
    @State private var keyboardIsUp = false
    /// How far the drawer is open: the tabs slide aside by it at compact width.
    @State private var drawerReveal = AidenDrawerReveal()
    @Environment(\.aidenReduceMotion) private var reduceMotion
    /// The drawer over the tabs (`AidenDrawerView`).
    private var drawerIsOpen: Bool {
        get { navigation.drawerIsOpen }
        nonmutating set { navigation.drawerIsOpen = newValue }
    }
    /// Whether the drawer's cover is up. It outlasts `drawerIsOpen` while the
    /// drawer slides shut, so the drawer stays under the returning tabs
    /// however it was put away.
    @State private var drawerCoverIsUp = false
    @Environment(\.layoutDirection) private var layoutDirection
    /// VoiceOver goes back to the showing tab's menu button when the drawer
    /// closes. Keyed by tab because every tab's list keeps its own button.
    @AccessibilityFocusState private var focusedMenuButton: AidenAppTab?

    init(
        coordinator: AidenRemoteCoordinator,
        inboxStore: AidenUnifiedInboxStore,
        navigationRequest: Binding<AidenNavigationRequest?> = .constant(nil),
        routeRequest: Binding<AidenAppRoute?> = .constant(nil),
        tabRequest: Binding<AidenAppTab?> = .constant(nil),
        navigationStore: AidenAppNavigationStore = AidenAppNavigationStore(),
        intents: AidenForegroundIntentRouter? = nil
    ) {
        self.coordinator = coordinator
        self.inboxStore = inboxStore
        _navigationRequest = navigationRequest
        _routeRequest = routeRequest
        _tabRequest = tabRequest
        self.navigationStore = navigationStore
        self.intents = intents ?? .shared
    }

    private var navigation: AidenAppNavigation { built.navigation }

    /// Compose in the Inbox, the Chats tab, the Workspaces tab and the drawer,
    /// on a machine the person picks. A chat started from Workspaces stays
    /// there; anywhere else it opens on the Chats tab.
    private var newWork: AidenNewWorkChatFlow { built.newWork }

    /// Each open chat's screen state, kept while its chat is on a tab.
    private var chatScreens: AidenChatScreens { built.chatScreens }
    private var homeComposer: AidenHomeComposerModel { built.homeComposer }
    private var homeFeed: AidenHomeFeedModel { built.homeFeed }

    private var built: AidenAppShellParts.Built {
        parts.built { [coordinator, inboxStore, navigationStore, horizontalSizeClass, verticalSizeClass] in
            let navigation = AidenAppNavigation(
                restoring: navigationStore.load(
                    installations: coordinator.installationStore.installations,
                    selected: coordinator.defaultInstanceId
                ),
                installations: coordinator.installationStore.installations
            )
            // Set before any link or request opens a route, which reads it.
            navigation.besideList = AidenTabChrome.besideList(horizontal: horizontalSizeClass, vertical: verticalSizeClass)
            let chatScreens = AidenChatScreens(
                isOpen: { [weak navigation] id in navigation?.holdsConversation(id) ?? false },
                isBotOpen: { [weak navigation] id in navigation?.holdsBot(id) ?? false }
            )
            let newWork = AidenNewWorkChatFlow(coordinator: coordinator) { [weak navigation, weak chatScreens] chat, id, prompt in
                let home = inboxStore.homeModel(for: id.instanceId)
                home?.accept(chat)
                home?.markViewed(chatID: chat.id)
                guard let navigation else { return }
                if let prompt {
                    // Home's Send: the words go with the chat, and Home decides
                    // whether to open it (only if the person is still there).
                    chatScreens?.screen(for: id, receipt: chat).chat.queueLaunchSend(prompt)
                    return
                }
                navigation.openNewChat(id)
            }
            let homeComposer = AidenHomeComposerModel()
            homeComposer.place = AidenHomeSendPlace(
                isOnHome: { [weak navigation] in
                    guard let navigation else { return false }
                    return navigation.tab == .chats && navigation.chatsPath.isEmpty
                },
                open: { [weak navigation] id in navigation?.open(.chat(id), on: .chats) }
            )
            let search = AidenSearchModel(
                chatInput: { AidenSearchChatInput(store: inboxStore) },
                machines: { AidenSearchMachine.machines(in: coordinator) }
            )
            return AidenAppShellParts.Built(
                navigation: navigation,
                newWork: newWork,
                chatScreens: chatScreens,
                homeComposer: homeComposer,
                homeFeed: AidenHomeFeedModel(),
                search: search,
                listScroll: AidenListScrollPlaces(),
                offlineNotices: AidenOfflineNoticeDismissals()
            )
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

    /// Follows the layout, as the dock does, so the two never disagree.
    private var runningHome: AidenRunningHome {
        .resolve(tabChrome)
    }

    /// Read at every step of a run, never kept.
    private var catchUpQueue: AidenCatchUpQueue {
        AidenCatchUpQueue(rows: inboxStore.inbox.needsYou)
    }

    private var hasNoComputers: Bool {
        coordinator.installationStore.installations.isEmpty
    }

    /// Aiden's own dock and Home header at compact width; the system's
    /// sidebar-adaptable tab view beside a list.
    private var tabChrome: AidenTabChrome {
        .resolve(besideList: navigation.besideList)
    }

    private func openAddComputer() {
        activeSheet = .pairing(showsDesktopCheck: hasNoComputers)
    }

    var body: some View {
        handlingRequests(shellContent)
    }

    /// Links, notifications, Shortcuts and Quick Actions, each of which puts
    /// the drawer away. Apart from the body so it type-checks in time.
    private func handlingRequests(_ content: some View) -> some View {
        content
        .onChange(of: navigationRequest, initial: true) { _, request in
            guard let request else { return }
            navigationRequest = nil
            closeDrawer(refocusingMenu: false)
            open(request)
        }
        .onChange(of: routeRequest, initial: true) { _, route in
            guard let route else { return }
            routeRequest = nil
            closeDrawer(refocusingMenu: false)
            navigation.open(route)
        }
        .onChange(of: intents.routes, initial: true) {
            for queued in intents.takeRoutes(openableOn: coordinator) {
                closeDrawer(refocusingMenu: false)
                navigation.open(
                    queued.route,
                    startsVoice: queued.startsVoice,
                    startsCamera: queued.startsCamera
                )
            }
        }
        .onChange(of: tabRequest, initial: true) { _, tab in
            guard let tab else { return }
            tabRequest = nil
            closeDrawer(refocusingMenu: false)
            // Pairing stays open: leaving it mid-scan would lose the person's place.
            if case .runningChats? = activeSheet { activeSheet = nil }
            navigation.selectTabRoot(tab)
        }
        .onChange(of: coordinator.defaultInstanceId) { _, _ in
            navigation.leaveSelectedMachineRoutes()
        }
    }

    private var shellContent: some View {
        TabView(selection: Binding(get: { navigation.tab }, set: { navigation.tab = $0 })) {
            Tab(AidenAppTab.chats.title, systemImage: "bubble.left.and.bubble.right", value: AidenAppTab.chats) {
                splitTab(.chats, columns: chatsColumns, empty: .chats) { selection in
                    chatsList(selection: selection)
                }
            }

            Tab(AidenAppTab.bots.title, systemImage: AidenChromeSymbols.bots, value: AidenAppTab.bots) {
                splitTab(.bots, columns: botsColumns, empty: .bots) { selection in
                    botsList(selection: selection)
                }
            }

            Tab(AidenAppTab.workspaces.title, systemImage: "folder", value: AidenAppTab.workspaces) {
                splitTab(.workspaces, columns: workspacesColumns, empty: .workspaces) { selection in
                    workspacesList(selection: selection)
                }
            }

            Tab(AidenAppTab.inbox.title, systemImage: "tray", value: AidenAppTab.inbox) {
                splitTab(.inbox, columns: inboxColumns, empty: .inbox) { selection in
                    inboxList(selection: selection)
                }
            }
            .badge(inboxStore.needsYouCount)
            // An iPad's tab strip draws the badge without saying it.
            .accessibilityValue(
                Text(AidenAppTab.inbox.accessibilityCount(needsYou: inboxStore.needsYouCount) ?? ""),
                isEnabled: inboxStore.needsYouCount > 0
            )
        }
        // The system's own placement: an iPad opens on the tab strip, and the
        // sidebar is a tap away. Asking for the sidebar by default
        // (`defaultAdaptableTabBarPlacement(.sidebar)`) made SwiftUI write its
        // sidebar state while drawing the first frame, which it reports as
        // "Modifying state during view update".
        .tabViewStyle(.sidebarAdaptable)
        .background {
            AidenWindowReader(window: window) { showsVerticalBar = $0 }
        }
        // Above every tab's stack, so pushed screens read them too.
        .environment(\.aidenTabsInSideRail, showsVerticalBar)
        .environment(\.aidenUsesDock, tabChrome == .dock)
        .environment(\.aidenOfflineNotices, built.offlineNotices)
        // Only a keyboard docked over the window's bottom takes the dock's
        // place: not a hardware keyboard's shortcut bar, nor a floating
        // keyboard. The notification's frame is in the screen's coordinate
        // space, which in Split View, Slide Over and Stage Manager isn't the
        // window's, so the window's frame is taken into that space to compare.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { note in
            guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
                  let screen = (note.object as? UIScreen) ?? window.scene?.screen else { return }
            keyboardIsUp = AidenTabChrome.keyboardTakesBottomEdge(
                keyboard: frame, screen: screen.bounds,
                window: window.frame(in: screen.coordinateSpace) ?? screen.bounds)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardIsUp = false
        }
        // A new tab view each time the display opens or closes, as at launch.
        // A closed iPhone Duo's side rail reads the showing tab's Back and
        // More when it's built, and a list tab swapping its container under
        // the same tab view left it reading none, along with the running
        // accessory over a chat (iOS 27.1 simulator). The paths and chats
        // are the shell's, so the new one opens where the old one was.
        .id(navigation.besideList)
        // At compact width the tabs slide aside to show the drawer under them.
        .modifier(AidenDrawerPush(reveal: drawerReveal, isEnabled: drawerPushesContent))
        .gesture(AidenDrawerEdgeSwipe(
            isEnabled: opensDrawerFromEdge,
            layoutDirection: layoutDirection,
            onBegan: beginDrawerSwipe,
            onChanged: trackDrawerSwipe,
            onEnded: endDrawerSwipe
        ))
        // The drawer is modal: a clear full-screen presentation, so UIKit
        // takes everything under it (the tabs' hosts, bars, side rail and
        // accessory) out of VoiceOver's reach. Attached after the `.id`, so
        // it stays open as the display folds. The drawer runs its own slide;
        // the cover comes and goes without the system's.
        .fullScreenCover(
            isPresented: Binding(get: { drawerCoverIsUp }, set: { if !$0 { closeDrawer() } }),
            onDismiss: {
                guard pairsAfterDrawer else { return }
                pairsAfterDrawer = false
                openAddComputer()
            }
        ) {
            drawerOverlay
                .presentationBackground(.clear)
                // The shell is presenting the cover, so an error raised while
                // the drawer is up is shown from the drawer.
                .alert(
                    "Aiden On The Go",
                    isPresented: errorBinding(whileDrawerIsOpen: true)
                ) {
                    Button("OK", role: .cancel) { coordinator.presentedError = nil }
                } message: {
                    Text(coordinator.presentedError ?? "The operation could not be completed.")
                }
        }
        .transaction(value: drawerCoverIsUp) { $0.disablesAnimations = true }
        // Something other than the drawer's own close put it away (a route
        // the navigation opened): the tabs slide back over it, then the
        // cover goes.
        .onChange(of: drawerIsOpen) { _, isOpen in
            guard !isOpen, drawerCoverIsUp else { return }
            drawerReveal.isTracking = false
            guard drawerReveal.progress > 0 else {
                drawerCoverIsUp = false
                return
            }
            drawerReveal.settle(open: false, reduceMotion: reduceMotion) {
                drawerCoverIsUp = false
            }
        }
        // While the cover is up the drawer presents the flow; the shell can't.
        .aidenNewWorkPresentation(newWork, coordinator: coordinator, isActive: !drawerCoverIsUp)
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .runningChats:
                AidenRunningChatsSheet(store: inboxStore) { route in
                    activeSheet = nil
                    openRow(route)
                }
            case .pairing(let showsDesktopCheck):
                AidenPairingView(
                    coordinator: coordinator,
                    showsDesktopCheck: showsDesktopCheck,
                    onClose: { activeSheet = nil },
                    onPaired: { activeSheet = nil }
                )
            }
        }
        // On every tab, the accessory and its sheet, so a machine page reached from
        // any of them counts its open chats.
        .environment(inboxStore)
        .alert(
            "Aiden On The Go",
            isPresented: errorBinding(whileDrawerIsOpen: false)
        ) {
            Button("OK", role: .cancel) { coordinator.presentedError = nil }
        } message: {
            Text(coordinator.presentedError ?? "The operation could not be completed.")
        }
        .modifier(InboxObservers(shell: self))
        .onChange(of: navigation.snapshot) { _, snapshot in
            navigationStore.save(snapshot)
            chatScreens.pathsChanged()
        }
        // Opening or closing an iPhone Duo swaps each list tab's container
        // (`AidenListTab`). The chat screens hear first, so the views the
        // swap takes away don't count as the reader leaving; the containers
        // follow `besideList`, so its new value is set before either goes.
        // An iPhone turning sideways changes both size classes; only the
        // pair says whether the layout moves (`AidenTabChrome.besideList`).
        .onChange(of: SizeClasses(horizontal: horizontalSizeClass, vertical: verticalSizeClass)) { _, sizeClasses in
            let besideList = AidenTabChrome.besideList(horizontal: sizeClasses.horizontal, vertical: sizeClasses.vertical)
            guard besideList != navigation.besideList else { return }
            for columns in [chatsColumns, inboxColumns, botsColumns, workspacesColumns] { columns.visibility = .all }
            chatScreens.rebuilding()
            navigation.besideList = besideList
        }
        .onChange(of: coordinator.installationStore.installations) { _, installations in
            navigation.dropRoutes(outside: installations)
        }
        .task(id: archiveSyncID) {
            coordinator.setDeviceArchivedWorkspaceIDs(archiveSyncID.archivedIDs, for: archiveSyncID.instanceID)
        }
    }

    /// Keeps the Inbox store and Home's ambient background in step with what's
    /// on screen. Apart from `body` so its chain type-checks in time.
    private struct InboxObservers: ViewModifier {
        let shell: AidenAppShellView

        func body(content: Content) -> some View {
            let navigation = shell.navigation
            let inboxStore = shell.inboxStore
            content
                // Home, on the Chats tab, reads the same snapshots the Inbox does,
                // and so does the drawer's recent list while it's open on any tab.
                .onChange(of: navigation.tab == .inbox || navigation.tab == .chats || navigation.showsChatList, initial: true) { _, isOnScreen in
                    inboxStore.setInboxVisible(isOnScreen)
                }
                .onChange(of: navigation.inboxOpenChat, initial: true) { _, chat in
                    inboxStore.openChat = chat
                    inboxStore.setFocusedMachine(chat?.instanceId)
                }
                .onChange(of: shell.ambientFocusedChat, initial: true) { shell.updateAmbient() }
                .onChange(of: inboxStore.snapshots) { shell.updateAmbient() }
                .onChange(of: inboxStore.hiddenMachines) { shell.updateAmbient() }
                .onDisappear {
                    inboxStore.setInboxVisible(false)
                    inboxStore.openChat = nil
                    inboxStore.setFocusedMachine(nil)
                }
        }
    }

    private func columns(for tab: AidenAppTab) -> AidenSplitColumns {
        switch tab {
        case .chats: chatsColumns
        case .bots: botsColumns
        case .workspaces: workspacesColumns
        case .inbox: inboxColumns
        }
    }

    /// A list tab: its list, and what the list opened beside it or pushed
    /// over it. `list` gets the row to highlight.
    private func splitTab<Sidebar: View>(
        _ tab: AidenAppTab,
        columns: AidenSplitColumns,
        empty: AidenSplitEmptyState,
        @ViewBuilder list: @escaping (AidenAppRoute?) -> Sidebar
    ) -> some View {
        AidenListTab(
            tab: tab,
            navigation: navigation,
            scrollPlaces: built.listScroll,
            columns: columns,
            window: window,
            empty: empty,
            // Each column's content too: the tabs and their columns are hosted
            // apart, so hiding the tab view, or this tab, leaves the list and
            // the screen beside it in reach behind the open drawer (iOS 27
            // simulator's audit read the Inbox's rows through the scrim). The
            // modifier reads the drawer itself, so each host updates on its own.
            list: { selection in
                list(selection)
                    .toolbar {
                        // Home's header carries its own at compact width.
                        if tab != .chats || tabChrome == .system { menuToolbarItem(on: tab) }
                    }
            },
            screen: { route, keepsTabs in
                AnyView(screen(for: route, keepsTabs: keepsTabs))
            },
            dock: { route in AnyView(dockBar(under: route)) }
        )
    }

    /// Puts the tab's list away when it's laid over the detail
    /// (`AidenSplitColumns.hideOverlaidList`).
    private func hideOverlaidList(on tab: AidenAppTab) {
        columns(for: tab).hideOverlaidList(
            besideList: navigation.besideList,
            hasSelection: AidenSplitNavigationPath(navigation.path(of: tab)).selection != nil
        )
    }

    /// The Inbox list with its banner and toolbar. `selection` is the row the
    /// detail beside it shows.
    private func inboxList(selection: AidenAppRoute?) -> some View {
        AidenInboxTabRootView(
            store: inboxStore,
            runningHome: runningHome,
            hasNoComputers: hasNoComputers,
            onAddComputer: openAddComputer,
            onOpen: openRow,
            onDelete: deleteChat,
            onOpenMachines: { navigation.open(.machines) },
            onCatchUp: {
                markViewed(navigation.startCatchUp(in: catchUpQueue))
                hideOverlaidList(on: .inbox)
            },
            onShowRunning: { activeSheet = .runningChats },
            selection: selection,
            // In a side rail the system lays the outgoing chip over the
            // incoming chat while it pushes, so it goes with the list.
            showsMachineStatus: !showsVerticalBar || navigation.besideList || navigation.inboxPath.isEmpty
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            AidenConnectionNotice(coordinator: coordinator)
        }
        .toolbar { composeToolbar }
    }

    /// Home's "See all": Catch Up when something waits on the person (the
    /// digest's hidden rows are among it), else every Bot.
    private func seeAllFromHome() {
        if catchUpQueue.first != nil {
            markViewed(navigation.startCatchUp(in: catchUpQueue))
            hideOverlaidList(on: .inbox)
        } else {
            navigation.selectTabRoot(.bots)
        }
    }

    /// The Chats list, which is also Home: the greeting, the Bots and their
    /// news above every chat, newest first, the ambient background behind
    /// it, and Home's composer below. Beside an open chat the list is just
    /// a list: one composer on screen, and no background next to the chat.
    private func chatsList(selection: AidenAppRoute?) -> some View {
        let showsHome = !navigation.besideList || selection == nil
        return AidenChatsTabView(
            store: inboxStore,
            hasNoComputers: hasNoComputers,
            onAddComputer: openAddComputer,
            selection: selection,
            header: AnyView(AidenHomeHeader(
                coordinator: coordinator,
                store: inboxStore,
                feedModel: homeFeed,
                onOpen: openFromHome,
                onOpenBots: { navigation.selectTabRoot(.bots) },
                onSeeAll: seeAllFromHome
            )),
            showsAmbientBackground: showsHome,
            onRefresh: {
                // A pull reads the Bots' news too, even news read a moment ago.
                async let lists: Void = inboxStore.refreshAll()
                async let feed: Void = homeFeed.refresh(
                    coordinator: coordinator, hiddenMachines: inboxStore.hiddenMachines, force: true
                )
                _ = await (lists, feed)
            }
        ) { route in
            openFromHome(route)
        }
        // The dock steps aside while the Home field's keyboard is up, and the
        // drawer gives the field its focus back when it closes, so a tap on
        // the list, or a drag down it, puts the keyboard away and brings the
        // tabs back. A short list doesn't scroll, so the tap is the way out.
        // It sits under the composer's inset: a tap on the composer keeps the
        // keyboard. A UIKit tap, as in a chat: a SwiftUI one on a scroll view
        // never fires on iOS 26, and this one lets the tapped row still open.
        .scrollDismissesKeyboard(.immediately)
        .gesture(AidenTranscriptTap { homeComposer.session.putAwayKeyboard() })
        .safeAreaInset(edge: .top, spacing: 0) {
            AidenConnectionNotice(coordinator: coordinator)
        }
        // Above the connection notice: at compact width Home draws its own
        // header and hides the navigation bar, keeping the title for Back.
        .safeAreaBar(edge: .top, spacing: 0) {
            if tabChrome == .dock { homeHeaderBar }
        }
        .toolbar(tabChrome == .dock ? .hidden : .automatic, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if showsHome, !hasNoComputers {
                AidenHomeComposerSlot(flow: newWork, model: homeComposer)
                    .padding(.horizontal, AidenSpacing.m)
                    .padding(.bottom, AidenSpacing.s)
            }
        }
        .environment(\.aidenAmbientActivity, ambient.activity)
        .environment(\.aidenAmbientMicLevel, ambient.micLevel)
        .toolbar {
            if tabChrome == .system { composeToolbar }
        }
    }

    /// A row, Bot or chat chosen on Home (the Chats list).
    private func openFromHome(_ route: AidenAppRoute) {
        navigation.pick(route, fromListOf: .chats)
        hideOverlaidList(on: .chats)
    }

    /// The chat Home's ambient background counts as on screen: the one
    /// selected beside the Chats list. A chat finishing there is already in
    /// view, so it doesn't light the background.
    private var ambientFocusedChat: AidenHostObjectID? {
        guard navigation.besideList, navigation.tab == .chats else { return nil }
        return navigation.chatsPath.first?.chatID
    }

    /// Feeds Home's ambient background from every shown machine.
    private func updateAmbient() {
        ambient.update(
            snapshots: Array(inboxStore.snapshots.values),
            hiddenMachines: inboxStore.hiddenMachines,
            focusedChat: ambientFocusedChat
        )
    }

    /// The Bots list. Its own function, as the Inbox's is, so the tab view
    /// type-checks in reasonable time.
    private func botsList(selection: AidenAppRoute?) -> some View {
        AidenBotsTabView(
            coordinator: coordinator,
            store: inboxStore,
            navigation: navigation,
            availability: botsAvailability,
            selection: selection,
            onAddComputer: openAddComputer,
            onOpenBot: { id, bot in botSummaries[id] = bot },
            onOpened: { hideOverlaidList(on: .bots) }
        )
    }

    /// The Workspaces list.
    private func workspacesList(selection: AidenAppRoute?) -> some View {
        AidenWorkspacesTabView(
            coordinator: coordinator,
            store: inboxStore,
            newWork: newWork,
            besideList: navigation.besideList,
            selection: selection,
            onAddComputer: openAddComputer
        ) { route in
            navigation.pick(route, fromListOf: .workspaces)
            hideOverlaidList(on: .workspaces)
        }
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

    // MARK: Compact chrome

    /// The running chats and the dock under a stack's list (`route` nil) or a
    /// screen pushed over it, at compact width outside a conversation and
    /// while the keyboard is down.
    @ViewBuilder
    private func dockBar(under route: AidenAppRoute?) -> some View {
        if AidenTabChrome.showsDock(
            besideList: navigation.besideList,
            showsConversation: route?.isConversation == true,
            keyboardIsUp: keyboardIsUp
        ) {
            VStack(spacing: AidenSpacing.s) {
                if runningHome == .accessory {
                    AidenRunningAccessoryHost(store: inboxStore, onOpen: openRow) { activeSheet = .runningChats }
                }
                AidenDock(selection: navigation.tab, needsYouCount: inboxStore.needsYouCount) { tab in
                    navigation.selectFromDock(tab)
                }
            }
        }
    }

    /// Home's own header at compact width (concept 01): the menu and compose
    /// as round glass buttons over the greeting, in place of the navigation
    /// bar. VoiceOver returns to this menu button as it does to a tab's.
    private var homeHeaderBar: some View {
        HStack(spacing: AidenSpacing.m) {
            Button(action: openDrawer) {
                Label("Open menu", systemImage: "line.3.horizontal")
            }
            .accessibilityFocused($focusedMenuButton, equals: AidenAppTab.chats)
            .accessibilityShowsLargeContentViewer()
            .accessibilityIdentifier("aiden.home.menu")
            Spacer(minLength: 0)
            composeButton
                .accessibilityShowsLargeContentViewer()
        }
        .buttonStyle(AidenChromeIconButtonStyle())
        .padding(.horizontal, AidenSpacing.l)
        .padding(.top, AidenSpacing.xs)
        .padding(.bottom, AidenSpacing.s)
    }

    /// Compose, or Add Computer with none paired. Settings, Scheduled and
    /// Usage moved to the drawer; compose stays here until Home has its own.
    @ToolbarContentBuilder
    private var composeToolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            composeButton
        }
        .aidenKeptLongestInBar()
    }

    @ViewBuilder
    private var composeButton: some View {
        if hasNoComputers {
            Button(action: openAddComputer) {
                Label("Add Computer", systemImage: "plus")
            }
        } else {
            AidenNewWorkComposeButton(flow: newWork)
        }
    }

    // MARK: Drawer

    /// The menu button on every tab's list, which opens the drawer.
    @ToolbarContentBuilder
    private func menuToolbarItem(on tab: AidenAppTab) -> some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button(action: openDrawer) {
                Label("Open menu", systemImage: "line.3.horizontal")
            }
            .accessibilityFocused($focusedMenuButton, equals: tab)
        }
    }

    /// An edge swipe opens the drawer only at a tab's root on a stack. On a
    /// pushed screen the same swipe is the stack's Back, and beside the list
    /// or in a side rail the edge belongs to the system's own columns.
    private var opensDrawerFromEdge: Bool {
        !drawerCoverIsUp && !navigation.besideList && !showsVerticalBar
            && navigation.path(of: navigation.tab).isEmpty
            // A sheet or alert up over the tab keeps the edge.
            && activeSheet == nil && !newWork.isChoosingWorkspace && !newWork.isNamingWorkspace
            && coordinator.presentedError == nil
    }

    /// The tabs slide aside for the drawer on a stack; beside the list it
    /// lays over them.
    private var drawerPushesContent: Bool { !navigation.besideList }

    private var drawerOverlay: some View {
        AidenDrawerOverlay(reveal: drawerReveal, pushesContent: drawerPushesContent, close: closeDrawer) {
            AidenDrawerView(
                search: built.search,
                coordinator: coordinator,
                inboxStore: inboxStore,
                pins: .shared,
                usageUnavailable: usageUnavailable,
                onOpen: { route in
                    // VoiceOver follows the page it opens, not the menu button.
                    closeDrawer(refocusingMenu: false)
                    navigation.open(route)
                },
                onShowAllChats: {
                    closeDrawer(refocusingMenu: false)
                    navigation.showAllChats()
                    // Beside the list the open chat stays, so an overlaid
                    // list that its pick put away comes back over it.
                    if navigation.besideList { chatsColumns.visibility = .all }
                },
                onClose: closeDrawer
            ) {
                if hasNoComputers {
                    // Pairing is the shell's sheet, so the drawer goes first.
                    Button {
                        pairsAfterDrawer = true
                        closeDrawer(refocusingMenu: false)
                    } label: {
                        Label("Add Computer", systemImage: "plus")
                    }
                } else {
                    AidenNewWorkComposeButton(flow: newWork)
                }
            }
            // The compose's workspace choice is a sheet, so it's presented
            // over the drawer while the drawer is up.
            .aidenNewWorkPresentation(newWork, coordinator: coordinator, ownsHaptics: false)
        }
    }

    /// The error alert, from the shell or, while the drawer's cover is up, from the drawer.
    private func errorBinding(whileDrawerIsOpen: Bool) -> Binding<Bool> {
        Binding(
            get: { coordinator.presentedError != nil && drawerCoverIsUp == whileDrawerIsOpen },
            set: { if !$0 { coordinator.presentedError = nil } }
        )
    }

    private func openDrawer() {
        drawerReveal.isTracking = false
        drawerIsOpen = true
        if drawerCoverIsUp {
            // Reopened while it was sliding shut.
            drawerReveal.settle(open: true, reduceMotion: reduceMotion)
        } else {
            // The cover slides the drawer in once it's up.
            drawerCoverIsUp = true
        }
    }

    private func closeDrawer() {
        closeDrawer(refocusingMenu: true)
    }

    /// Slides the drawer shut, and the tabs back, then takes its cover away.
    /// Whatever the person picked opens underneath meanwhile.
    private func closeDrawer(refocusingMenu: Bool) {
        guard drawerIsOpen else { return }
        drawerReveal.isTracking = false
        drawerReveal.settle(open: false, reduceMotion: reduceMotion) {
            drawerIsOpen = false
            drawerCoverIsUp = false
            if refocusingMenu { focusedMenuButton = navigation.tab }
        }
    }

    /// A finger on the leading edge: the drawer comes up shut and follows it.
    private func beginDrawerSwipe() {
        drawerReveal.isTracking = true
        drawerReveal.progress = 0
        drawerIsOpen = true
        drawerCoverIsUp = true
    }

    private func trackDrawerSwipe(_ movement: AidenDrawerEdgeSwipe.Movement) {
        guard drawerReveal.isTracking else { return }
        drawerReveal.progress = AidenDrawerGeometry.progress(
            start: 0, translation: movement.translation, width: drawerReveal.travel,
            rightToLeft: layoutDirection == .rightToLeft
        )
    }

    /// Let go: open or shut by where it is and how fast it was moving.
    private func endDrawerSwipe(_ movement: AidenDrawerEdgeSwipe.Movement?) {
        guard drawerReveal.isTracking else { return }
        drawerReveal.isTracking = false
        let staysOpen = movement.map {
            AidenDrawerGeometry.settlesOpen(
                progress: drawerReveal.progress, velocity: $0.velocity, width: drawerReveal.travel,
                rightToLeft: layoutDirection == .rightToLeft
            )
        } ?? false
        if staysOpen {
            drawerReveal.settle(open: true, reduceMotion: reduceMotion)
        } else {
            closeDrawer(refocusingMenu: false)
        }
    }

    /// Beside the list a conversation keeps the system tabs, which stay
    /// reachable from the list. On a stack the dock stands in for them and
    /// steps aside for the composer itself (`AidenTabChrome.showsDock`), so
    /// the system bar stays hidden whatever this says (`aidenUsesDock`). Set
    /// on each screen, root and pushed, because a screen pushed by a stack
    /// doesn't read what's set on that stack's root.
    private func screen(for route: AidenAppRoute, keepsTabs: Bool) -> some View {
        routeScreen(for: route)
            .environment(\.aidenConversationTabBar, keepsTabs ? .automatic : .hidden)
    }

    @ViewBuilder
    private func routeScreen(for route: AidenAppRoute) -> some View {
        switch route {
        case .chat(let id), .fork(let id, _):
            AidenChatRouteView(
                coordinator: coordinator,
                screen: chatScreens.screen(for: id, receipt: newWork.receipt(for: id)),
                autoStartVoice: navigation.chatStartingVoice == id,
                autoStartCamera: navigation.chatStartingCamera == id,
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
                    // Over the chat it came from, so Back returns there.
                    let forkID = AidenHostObjectID(instanceId: id.instanceId, deviceId: id.deviceId, objectId: fork.id)
                    navigation.push(.fork(forkID, source: id), over: route)
                },
                onBotChat: { bot in navigation.replace(route, with: .bot(bot)) }
            )
            .environment(\.aidenConversationMachine, inboxStore.roster.chatSubtitle(for: id.instanceId))
            // Next swaps the route in place, and the stack would otherwise keep this
            // view's state, so the old chat would stay on screen.
            .id(id)
            .onDisappear {
                navigation.finishStartingVoice(id)
                navigation.finishStartingCamera(id)
                newWork.forgetReceipt(id)
            }
        case .bot(let id):
            AidenBotRouteView(
                coordinator: coordinator,
                screen: chatScreens.botScreen(for: id),
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
                onOpenChat: { chatID in navigation.push(.chat(chatID), over: route) }
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
        hideOverlaidList(on: .inbox)
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
    @ObservationIgnored private var loading: Task<Void, Never>?
    /// Counts loads started, so only the newest one clears `isLoading`.
    @ObservationIgnored private var loadsStarted = 0
    /// A load is under way.
    @ObservationIgnored private(set) var isLoading = false

    /// `receipt` is the chat as the machine just created it, when there is one.
    init(id: AidenHostObjectID, cache: AidenChatCache = .shared, receipt: AidenChat? = nil) {
        self.id = id
        self.cache = cache
        self.receipt = receipt
    }

    /// Loads again, in place of any load under way: the screen appeared, or
    /// its machine's connection changed. The load is the model's, not the
    /// view's, so it isn't cancelled when SwiftUI reports the screen gone. A
    /// chat a link chose on a tab that wasn't showing appeared and disappeared
    /// in one update as the tab came forward, and never appeared again, so a
    /// view task's load was cancelled and the chat spun for good. Returns
    /// the load, for tests.
    @discardableResult
    func startLoading(coordinator: AidenRemoteCoordinator) -> Task<Void, Never> {
        loading?.cancel()
        loadsStarted += 1
        let started = loadsStarted
        isLoading = true
        let load = Task<Void, Never> { [weak self] in
            await self?.load(coordinator: coordinator)
            guard let self, self.loadsStarted == started else { return }
            self.isLoading = false
        }
        loading = load
        return load
    }

    /// Loads again only when the chat isn't open and no load is under way: the
    /// screen appeared. The first appearance comes right after the connection
    /// handler started the first load, and replacing that load would ask the
    /// machine for the chat twice. Returns the load it started, for tests.
    @discardableResult
    func loadIfIdle(coordinator: AidenRemoteCoordinator) -> Task<Void, Never>? {
        if case .ready = state { return nil }
        guard !isLoading else { return nil }
        return startLoading(coordinator: coordinator)
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
        } catch where Task.isCancelled || error is CancellationError {
            // A newer load is under way. A request the machine's pin refused
            // also reports itself cancelled (URLError.cancelled), but nothing
            // loads again after that, so it says so below.
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
        // Cancelled: a newer load is under way, and that load decides.
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
    let autoStartCamera: Bool
    /// Set only while this chat is a Catch Up run's. On the route rather than the
    /// chat, so a chat that can't load can still be moved on from, and a fork
    /// pushed over it has no Next of its own.
    let onNext: (() -> Void)?
    let onChatUpdated: @MainActor (AidenChat) -> Void
    let onChatActivityChanged: @MainActor (String, AidenChatSummaryActivity) -> Void
    let onForkOpened: @MainActor (AidenChat) -> Void
    let onBotChat: @MainActor (AidenHostObjectID) -> Void
    /// The shell's, so a rebuilt screen finds the chat it already loaded.
    let screen: AidenChatScreens.Screen
    private var model: AidenChatRouteModel { screen.route }
    @State private var holdsAttachments = false
    @State private var isConfirmingNext = false

    init(
        coordinator: AidenRemoteCoordinator,
        screen: AidenChatScreens.Screen,
        autoStartVoice: Bool,
        autoStartCamera: Bool,
        onNext: (() -> Void)?,
        onChatUpdated: @escaping @MainActor (AidenChat) -> Void,
        onChatActivityChanged: @escaping @MainActor (String, AidenChatSummaryActivity) -> Void,
        onForkOpened: @escaping @MainActor (AidenChat) -> Void,
        onBotChat: @escaping @MainActor (AidenHostObjectID) -> Void
    ) {
        self.coordinator = coordinator
        self.autoStartVoice = autoStartVoice
        self.autoStartCamera = autoStartCamera
        self.onNext = onNext
        self.onChatUpdated = onChatUpdated
        self.onChatActivityChanged = onChatActivityChanged
        self.onForkOpened = onForkOpened
        self.onBotChat = onBotChat
        self.screen = screen
    }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView()
            case .ready(let chat, let owner):
                AidenChatDetailView(
                    coordinator: coordinator,
                    chat: chat,
                    owner: owner,
                    autoStartVoice: autoStartVoice,
                    autoStartCamera: autoStartCamera,
                    onChatUpdated: onChatUpdated,
                    onChatActivityChanged: onChatActivityChanged,
                    onOpenChat: onForkOpened,
                    screen: screen.chat
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
        .aidenConversationTabBar()
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
        .onChange(of: coordinator.hosts.connection(for: model.id.instanceId)?.connectionState, initial: true) {
            model.startLoading(coordinator: coordinator)
        }
        // Back to a chat that couldn't load tries again.
        .onAppear {
            model.loadIfIdle(coordinator: coordinator)
        }
    }
}

/// The shell's chat screens: each chat's and each Bot's route model and
/// screen state, kept while a tab's path holds the chat or the Bot, so opening
/// or closing an iPhone Duo, which builds the screen's views again, loses
/// nothing. A screen goes once its route has left every tab and nobody sees
/// it (`AidenChatScreen`).
@MainActor
final class AidenChatScreens {
    final class Screen {
        let route: AidenChatRouteModel
        let chat: AidenChatScreen

        init(route: AidenChatRouteModel, chat: AidenChatScreen) {
            self.route = route
            self.chat = chat
        }
    }

    /// A Bot's screen: its route model, and what its chat keeps, the durable
    /// conversation's (`session`) or a legacy chat's (`chat`'s parts).
    final class BotScreen {
        let route: AidenBotRouteModel
        let chat: AidenChatScreen
        let session: AidenBotSessionScreenParts

        init(route: AidenBotRouteModel, chat: AidenChatScreen, session: AidenBotSessionScreenParts) {
            self.route = route
            self.chat = chat
            self.session = session
        }
    }

    private var screens: [AidenHostObjectID: Screen] = [:]
    private var botScreens: [AidenHostObjectID: BotScreen] = [:]
    private let isOpen: @MainActor (AidenHostObjectID) -> Bool
    private let isBotOpen: @MainActor (AidenHostObjectID) -> Bool
    private let pause: @MainActor (Duration) async -> Void

    init(
        pause: @escaping @MainActor (Duration) async -> Void = { try? await Task.sleep(for: $0) },
        isOpen: @escaping @MainActor (AidenHostObjectID) -> Bool,
        isBotOpen: @escaping @MainActor (AidenHostObjectID) -> Bool = { _ in false }
    ) {
        self.pause = pause
        self.isOpen = isOpen
        self.isBotOpen = isBotOpen
    }

    /// The chats with a screen kept, for tests.
    var kept: Set<AidenHostObjectID> { Set(screens.keys) }

    /// The Bots with a screen kept, for tests.
    var keptBots: Set<AidenHostObjectID> { Set(botScreens.keys) }

    /// The Bot's screen, made the first time it's asked for.
    func botScreen(for id: AidenHostObjectID) -> BotScreen {
        if let screen = botScreens[id] { return screen }
        let screen = BotScreen(
            route: AidenBotRouteModel(id: id),
            chat: AidenChatScreen(
                isOpen: { [weak self] in self?.isBotOpen(id) ?? false },
                onLeft: { [weak self] in self?.forgetBot(id) },
                pause: pause
            ),
            session: AidenBotSessionScreenParts()
        )
        botScreens[id] = screen
        return screen
    }

    /// The chat's screen, made the first time it's asked for. `receipt` is
    /// the chat as its machine just created it, when there is one.
    func screen(for id: AidenHostObjectID, receipt: AidenChat? = nil) -> Screen {
        if let screen = screens[id] { return screen }
        let screen = Screen(
            route: AidenChatRouteModel(id: id, receipt: receipt),
            chat: AidenChatScreen(
                isOpen: { [weak self] in self?.isOpen(id) ?? false },
                onLeft: { [weak self] in self?.forget(id) },
                pause: pause
            )
        )
        screens[id] = screen
        return screen
    }

    /// The shell is about to swap its containers: the screens on screen now
    /// get new views (`AidenChatScreen.rebuilding()`).
    func rebuilding() {
        for screen in screens.values { screen.chat.rebuilding() }
        for screen in botScreens.values { screen.chat.rebuilding() }
    }

    /// A tab's path changed. Screens whose chat is on no tab and that nobody
    /// sees go; one a view is still leaving goes when it has left.
    func pathsChanged() {
        for screen in Array(screens.values) { screen.chat.leaveIfClosed() }
        for screen in Array(botScreens.values) { screen.chat.leaveIfClosed() }
    }

    private func forget(_ id: AidenHostObjectID) {
        guard let screen = screens[id], !screen.chat.isShowing, !isOpen(id) else { return }
        screens[id] = nil
    }

    private func forgetBot(_ id: AidenHostObjectID) {
        guard let screen = botScreens[id], !screen.chat.isShowing, !isBotOpen(id) else { return }
        botScreens[id] = nil
    }
}

/// What a list tab's detail says with nothing selected.
enum AidenSplitEmptyState {
    case chats, inbox, bots, workspaces

    var title: LocalizedStringKey {
        switch self {
        case .chats, .inbox: "No chat selected"
        case .bots: "No Bot selected"
        case .workspaces: "No workspace selected"
        }
    }

    var systemImage: String {
        switch self {
        case .chats, .inbox: "bubble.left.and.bubble.right"
        case .bots: AidenChromeSymbols.bots
        case .workspaces: "folder"
        }
    }

    var message: LocalizedStringKey {
        switch self {
        case .chats: "Pick a chat from the list."
        case .inbox: "Pick a chat from the Inbox."
        case .bots: "Pick a Bot from the list."
        case .workspaces: "Pick a workspace from the list."
        }
    }
}

/// A list tab's split view: which columns it shows, and where they were last
/// measured. Both columns are asked for: the system tiles them when they fit
/// (an iPhone Duo open in landscape) and lays the list over the detail when
/// they don't (open in portrait), where picking a row puts it away.
@MainActor @Observable
final class AidenSplitColumns {
    var visibility = NavigationSplitViewVisibility.all {
        didSet { updateListCoversDetail() }
    }
    /// The list lies over the detail and dims it (an iPad or an open iPhone
    /// Duo in portrait), so the detail can't be read or reached until the
    /// list goes.
    private(set) var listCoversDetail = false
    @ObservationIgnored var splitFrame = CGRect.zero {
        didSet { updateListCoversDetail() }
    }
    @ObservationIgnored var detailFrame = CGRect.zero {
        didSet { updateListCoversDetail() }
    }
    /// Whether the window was landscape the last time the split was measured.
    @ObservationIgnored private var wasLandscape: Bool?

    /// Picking a row while the list is an overlay over the detail (a narrow
    /// regular width, such as an iPhone Duo open in portrait) puts the overlay
    /// away, so the chosen screen is in view, including a row tapped again
    /// while already selected. Tiled columns are left as they are.
    func hideOverlaidList(besideList: Bool, hasSelection: Bool) {
        guard besideList, visibility != .detailOnly, hasSelection,
              AidenSplitNavigationPath.listIsOverlaid(detailFrame: detailFrame, splitFrame: splitFrame)
        else { return }
        visibility = .detailOnly
    }

    /// With nothing chosen the detail is only a placeholder, so a hidden list
    /// comes back rather than leaving "No … selected" on its own, as on a tab
    /// first shown in portrait on an open iPhone Duo.
    func showListIfNothingChosen(besideList: Bool, hasSelection: Bool) {
        guard besideList, !hasSelection, visibility == .detailOnly else { return }
        visibility = .all
    }

    private func updateListCoversDetail() {
        let covers = visibility != .detailOnly
            && AidenSplitNavigationPath.listIsOverlaid(detailFrame: detailFrame, splitFrame: splitFrame)
        if covers != listCoversDetail { listCoversDetail = covers }
    }

    /// Brings the list back when the device turned. The window's orientation
    /// decides, not the split's shape: the keyboard shortens the split in
    /// portrait until it's wider than tall, and a turn resizes it in two steps
    /// that pass through a square.
    fileprivate func showListIfTurned(landscape: Bool) {
        defer { wasLandscape = landscape }
        guard let wasLandscape, wasLandscape != landscape else { return }
        visibility = .all
    }
}

/// A list tab. Compact, it's one stack: the list at its root and the tab's
/// path pushed over it, as on any iPhone. Regular, it's a split: the list
/// beside a stack rooted at the selected row. Opening or closing an iPhone
/// Duo swaps one for the other. A split that collapses to one stack itself
/// left the closed iPhone Duo's side rail without a working Back (iOS 27.1
/// simulator); a stack built while closed always has one.
///
/// The tab's path is the one source of truth (`AidenAppNavigation`), so the
/// new container shows the same screens, and a chat's state is the shell's
/// (`AidenChatScreens`), so they're as they were. The container going away
/// can still write its path as it's taken down (a stack popping to nothing),
/// so each container's writes count only while the navigation is in its
/// layout: `AidenAppNavigation.besideList` changes first, then the container
/// follows it.
private struct AidenListTab<List: View>: View {
    let tab: AidenAppTab
    let navigation: AidenAppNavigation
    let scrollPlaces: AidenListScrollPlaces
    let columns: AidenSplitColumns
    let window: AidenWindowReader.Window
    let empty: AidenSplitEmptyState
    let list: (AidenAppRoute?) -> List
    /// A route's screen, and whether a conversation there keeps the tabs.
    let screen: (AidenAppRoute, Bool) -> AnyView
    /// The compact dock under the list (nil) or a pushed route.
    let dock: (AidenAppRoute?) -> AnyView

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    private var path: [AidenAppRoute] { navigation.path(of: tab) }

    var body: some View {
        if navigation.besideList { split } else { stack }
    }

    private func write(_ path: [AidenAppRoute], besideList: Bool) {
        navigation.setPath(
            path,
            of: tab,
            laidOutBesideList: besideList,
            widthIsRegular: horizontalSizeClass.map {
                AidenTabChrome.besideList(horizontal: $0, vertical: verticalSizeClass)
            }
        )
    }

    // MARK: Compact

    private var stack: some View {
        NavigationStack(path: Binding(
            get: { path },
            set: { write($0, besideList: false) }
        )) {
            // The dock stands in for the system tab bar on a stack, on the
            // list and every screen pushed over it, with the running chats
            // above it. It's each screen's own bar, inside the stack: an
            // inset on the stack or the tab view never reached the screens,
            // so Home's composer sat under the dock (iOS 27 simulator). Its
            // content keeps clear of it and scrolls under its edge effect.
            list(nil)
                .environment(\.aidenListScroll, AidenListScrollKeeping(places: scrollPlaces, tab: tab))
                .toolbar(.hidden, for: .tabBar)
                .safeAreaBar(edge: .bottom, spacing: 0) { dock(nil) }
                // A soft edge, as under the system bar: the closed iPhone
                // Duo otherwise cuts the list hard across the screen.
                .aidenComposerSoftScrollEdge()
                .navigationDestination(for: AidenAppRoute.self) { route in
                    screen(route, false)
                        .toolbar(.hidden, for: .tabBar)
                        .safeAreaBar(edge: .bottom, spacing: 0) { dock(route) }
                        .aidenComposerSoftScrollEdge()
                }
        }
    }

    // MARK: Regular

    private var split: some View {
        @Bindable var columns = columns
        return NavigationSplitView(columnVisibility: $columns.visibility) {
            list(AidenSplitNavigationPath(path).selection)
                .environment(\.aidenListScroll, AidenListScrollKeeping(places: scrollPlaces, tab: tab))
                // One width for every list tab and every launch, wide enough
                // for a machine's status line, a row's title and the bar's
                // title with its buttons on an iPhone Duo's inner display.
                // The system's own choice varied between launches.
                .navigationSplitViewColumnWidth(min: 320, ideal: 400, max: 420)
        } detail: {
            detail
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { columns.detailFrame = $0 }
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { columns.splitFrame = $0 }
        // Turning the device brings the list back. Other resizes leave the
        // columns as the person set them; opening or closing an iPhone Duo
        // changes the size class, which the shell handles.
        .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
            columns.showListIfTurned(landscape: window.isLandscape ?? (size.width > size.height))
        }
        // A row chosen any other way: a link, a Search result, Catch Up's Next.
        .onChange(of: AidenSplitNavigationPath(path).selection, initial: true) { _, selection in
            columns.hideOverlaidList(besideList: true, hasSelection: selection != nil)
            columns.showListIfNothingChosen(besideList: true, hasSelection: selection != nil)
        }
        // A screen pushed over the chosen one (Computers from the list's
        // status item, a chat's Bot) shows in the detail, so a list laid over
        // it goes too, as for a row.
        .onChange(of: path) { old, new in
            guard new.count > old.count else { return }
            columns.hideOverlaidList(besideList: true, hasSelection: AidenSplitNavigationPath(new).selection != nil)
        }
        // The system hides the list of a tab first shown in portrait on an
        // iPad (iOS 27.1 simulator), which left "No Bot selected" alone.
        // With a row chosen (an iPhone Duo opened in portrait on a chat) the
        // chat stays in view, as after a pick, and the bar's sidebar button
        // or the drawer's Show all chats brings the list over it.
        .onChange(of: columns.visibility) {
            columns.showListIfNothingChosen(
                besideList: true,
                hasSelection: AidenSplitNavigationPath(path).selection != nil
            )
        }
    }

    /// The detail column: the selected route at the root of its own stack, and
    /// the rest of the path pushed over it. A conversation here keeps the
    /// tabs up, as the list beside it does.
    private var detail: some View {
        let selection = AidenSplitNavigationPath(path).selection
        return NavigationStack(path: Binding(
            get: { AidenSplitNavigationPath(path).detailPath },
            set: { detailPath in
                var split = AidenSplitNavigationPath(path)
                split.setDetailPath(detailPath)
                write(split.path, besideList: true)
            }
        )) {
            Group {
                if let selection {
                    screen(selection, true)
                        // Another row is another screen, not this one updated.
                        .id(selection)
                } else {
                    AidenSplitPlaceholder(empty: empty, columns: columns)
                }
            }
            .navigationDestination(for: AidenAppRoute.self) { screen($0, true) }
        }
    }
}

/// The detail with nothing chosen. Under the list's dimming (the list laid
/// over it) the words would be out of reach and too faint to read, and the
/// list is where to pick one, so only the canvas shows. Dropping them also
/// keeps VoiceOver in the list: `accessibilityHidden` doesn't hide a
/// `ContentUnavailableView`'s text (iOS 27.1 simulator).
private struct AidenSplitPlaceholder: View {
    let empty: AidenSplitEmptyState
    let columns: AidenSplitColumns

    @Environment(\.aidenPalette) private var palette

    var body: some View {
        ZStack {
            palette.canvas.ignoresSafeArea()
            if !columns.listCoversDetail {
                ContentUnavailableView(empty.title, systemImage: empty.systemImage, description: Text(empty.message))
            }
        }
    }
}

/// Where each list tab's list was scrolled to, kept by the shell so a fold,
/// which builds the list again in the other container, keeps it. A place is
/// the row across the top of the list, so it holds through a reflow at the
/// new width and through rows or banners that arrive above it.
@MainActor
final class AidenListScrollPlaces {
    /// The row across the top of each tab's list, or none at the very top.
    private var topRows: [AidenAppTab: AnyHashable] = [:]

    func topRow(of tab: AidenAppTab) -> AnyHashable? { topRows[tab] }

    func record(_ row: AnyHashable?, of tab: AidenAppTab) {
        topRows[tab] = row
    }

    /// The row across the top of the visible part: the highest row whose
    /// bottom reaches below `visibleTop`. Frames and `visibleTop` are in the
    /// same space, the list's own.
    static func topRow(frames: [AnyHashable: CGRect], visibleTop: CGFloat) -> AnyHashable? {
        frames
            .filter { $0.value.maxY > visibleTop + 1 }
            .min { $0.value.minY < $1.value.minY }?
            .key
    }
}

/// Which tab's list scroll to keep, for the list a list tab shows
/// (`View.aidenKeepsListScroll()`).
struct AidenListScrollKeeping {
    let places: AidenListScrollPlaces
    let tab: AidenAppTab
}

/// The frames of one list's rows as they're laid out, in the list's own space.
/// Not observed: only the person's scroll reads them.
@MainActor
final class AidenListRowFrames {
    fileprivate var frames: [AnyHashable: CGRect] = [:]
    /// Whether the person's scroll is moving the list.
    fileprivate var moving = false

    fileprivate func set(_ frame: CGRect?, for id: AnyHashable) {
        frames[id] = frame
    }
}

extension EnvironmentValues {
    @Entry var aidenListScroll: AidenListScrollKeeping?
    @Entry var aidenListRowFrames: AidenListRowFrames?
}

private enum AidenListScrollSpace {
    static let name = "aiden.list.scroll"
}

extension View {
    /// On a list tab's own scrolling list: keeps where it's scrolled to when
    /// a fold builds it again. Placed on the scroll view itself, as a row
    /// strip that scrolls sideways inside it would take a position meant for
    /// the list. Its rows say who they are with `aidenListScrollRow(_:)`.
    func aidenKeepsListScroll() -> some View {
        modifier(AidenListScrollKeeperReader())
    }

    /// A row the list's place can be: the list comes back with this row at
    /// its top. `id` is the row's identity in its `ForEach`, which is what
    /// `ScrollViewReader` scrolls to; nil marks nothing.
    ///
    /// Goes on the row's content (a button's label), never on the row
    /// itself: on the view a `ForEach` hands the list, the geometry reading
    /// hides the row's own list insets, background and swipe actions.
    func aidenListScrollRow(_ id: AnyHashable?) -> some View {
        modifier(AidenListScrollRow(id: id))
    }
}

private struct AidenListScrollKeeperReader: ViewModifier {
    @Environment(\.aidenListScroll) private var keeping

    func body(content: Content) -> some View {
        if let keeping {
            content.modifier(AidenListScrollKeeper(places: keeping.places, tab: keeping.tab))
        } else {
            content
        }
    }
}

private struct AidenListScrollRow: ViewModifier {
    let id: AnyHashable?

    @Environment(\.aidenListRowFrames) private var rowFrames

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { proxy in
                proxy.frame(in: .named(AidenListScrollSpace.name))
            } action: { frame in
                if let id { rowFrames?.set(frame, for: id) }
            }
            .onDisappear {
                if let id { rowFrames?.set(nil, for: id) }
            }
    }
}

/// When a list tab's list goes back to its saved row: once, at its first
/// layout, whichever of that and its first appearance comes last. A list
/// reports no content before its first layout, so it waits for that. After
/// it, nothing brings the list back again: not reappearing on its tab, and
/// not its rows emptying and filling (a filter to an empty machine and back).
struct AidenListScrollRestore {
    private(set) var pending: AnyHashable?
    private var hasAppeared = false
    private var isLaidOut = false

    /// The list appeared, with `row` saved. Returns the row to go to now.
    mutating func appear(returningTo row: AnyHashable?) -> AnyHashable? {
        defer { hasAppeared = true }
        guard !hasAppeared else {
            pending = nil
            return nil
        }
        if isLaidOut { return row }
        pending = row
        return nil
    }

    /// The list's content went from empty to laid out, or back. Returns the
    /// row to go to now.
    mutating func layout(hasContent: Bool) -> AnyHashable? {
        guard hasContent, !isLaidOut else { return nil }
        isLaidOut = true
        defer { pending = nil }
        return pending
    }

    /// The person took hold of the list, so where they put it wins.
    mutating func interact() { pending = nil }
}

/// Records the row across the top of a list tab's list while the person
/// scrolls it and when it comes to rest, and brings a new list back to that
/// row once (`AidenListScrollRestore`). A list taken down as the display folds
/// reports its own geometry on the way out from rest, and that isn't where
/// they left it, so a list at rest records nothing more.
private struct AidenListScrollKeeper: ViewModifier {
    let places: AidenListScrollPlaces
    let tab: AidenAppTab

    @State private var rowFrames = AidenListRowFrames()
    @State private var restore = AidenListScrollRestore()

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content
                .coordinateSpace(.named(AidenListScrollSpace.name))
                .environment(\.aidenListRowFrames, rowFrames)
                .onAppear { scroll(proxy, to: restore.appear(returningTo: places.topRow(of: tab))) }
                .onScrollPhaseChange { old, phase, context in
                    if phase == .interacting { restore.interact() }
                    rowFrames.moving = phase.isScrolling
                    // Coming to rest, and each change of phase on the way.
                    if old.isScrolling { record(context.geometry) }
                }
                .onScrollGeometryChange(for: ScrollGeometry.self) { $0 } action: { _, geometry in
                    if rowFrames.moving { record(geometry) }
                }
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    geometry.contentSize.height > 0
                } action: { _, laidOut in
                    scroll(proxy, to: restore.layout(hasContent: laidOut))
                }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, to row: AnyHashable?) {
        // `scrollTo` matches a `ForEach` identity by its own type, not
        // wrapped. After this layout pass, which may still set the offset itself.
        guard let row, let id = row.base as? any Hashable else { return }
        Task { @MainActor in
            await Task.yield()
            proxy.scrollTo(id, anchor: .top)
        }
    }

    private func record(_ geometry: ScrollGeometry) {
        let atTop = geometry.contentOffset.y + geometry.contentInsets.top <= 1
        // The list's own space starts where it shows, under the bar: its
        // scrolling runs on under the bar, its frame doesn't (iOS 27.1,
        // iPhone Duo).
        let row = atTop ? nil : AidenListScrollPlaces.topRow(frames: rowFrames.frames, visibleTop: 0)
        places.record(row, of: tab)
    }
}

/// Both size classes, watched together as an iPhone turns.
private struct SizeClasses: Equatable {
    let horizontal: UserInterfaceSizeClass?
    let vertical: UserInterfaceSizeClass?
}

/// Reads the shell's own window: its scene, for the orientation, and whether
/// the system puts its bars in a vertical rail beside the content, as on a
/// closed iPhone Duo's outer display. SwiftUI has no environment value for
/// either.
private struct AidenWindowReader: UIViewRepresentable {
    /// The shell's window scene, held weakly and read when needed rather
    /// than drawn from.
    @MainActor
    final class Window {
        fileprivate weak var scene: UIWindowScene?
        fileprivate weak var uiWindow: UIWindow?

        /// The window's frame in `space` (the screen's, for the keyboard), or
        /// nil before the shell is in a window.
        func frame(in space: any UICoordinateSpace) -> CGRect? {
            guard let uiWindow else { return nil }
            return uiWindow.convert(uiWindow.bounds, to: space)
        }

        /// The window's orientation, or nil before there is one.
        var isLandscape: Bool? {
            guard let orientation = scene?.effectiveGeometry.interfaceOrientation,
                  orientation != .unknown else { return nil }
            return orientation.isLandscape
        }
    }

    let window: Window
    let onVerticalBarChange: @MainActor (Bool) -> Void

    func makeUIView(context: Context) -> TraitView {
        let view = TraitView()
        updateUIView(view, context: context)
        return view
    }

    func updateUIView(_ view: TraitView, context: Context) {
        view.shellWindow = window
        view.onChange = onVerticalBarChange
    }

    final class TraitView: UIView {
        var shellWindow: Window?
        var onChange: (@MainActor (Bool) -> Void)?
        private var reported: Bool?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            #if canImport(UIKit, _version: 9127.0.85)
            if #available(iOS 27.1, *) {
                registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: TraitView, _) in
                    view.report()
                }
            }
            #endif
        }

        required init?(coder: NSCoder) {
            super.init(coder: coder)
        }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            shellWindow?.scene = window?.windowScene
            shellWindow?.uiWindow = window
            report()
        }

        private func report() {
            guard window != nil else { return }
            let showsVerticalBar = Self.showsVerticalBar(traitCollection)
            guard showsVerticalBar != reported else { return }
            reported = showsVerticalBar
            // After the current update: the change sets SwiftUI state.
            Task { @MainActor [onChange] in onChange?(showsVerticalBar) }
        }

        /// The vertical bar arrived in iOS 27.1. The SDK check (UIKit 9127.0.85
        /// is the iOS 27.1 SDK's) lets Xcode 27.0, whose UIKit lacks the API,
        /// still build; there, and before iOS 27.1, it's never shown.
        private static func showsVerticalBar(_ traits: UITraitCollection) -> Bool {
            #if canImport(UIKit, _version: 9127.0.85)
            if #available(iOS 27.1, *) {
                return traits.verticalBarEdge != .unspecified
            }
            #endif
            return false
        }
    }
}

