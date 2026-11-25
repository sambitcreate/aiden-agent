import Foundation
import Observation


/// The shell's four tabs, in bar order. Search and Settings live in the
/// drawer (`AidenDrawerView`), not on the bar. A saved tab this build doesn't
/// know, such as v2's `search`, reads as Chats.
enum AidenAppTab: String, Codable, CaseIterable, Hashable {
    case chats, bots, workspaces, inbox

    /// The tabs drawn as a list beside a detail at regular width: all four.
    static let listTabs: [AidenAppTab] = allCases

    /// True for a route this tab's list has a row for. Beside the list such a
    /// route becomes the selection rather than going on top: the Chats tab's
    /// chats, the Inbox's chats and Bots, the Bots tab's Bots and the
    /// Workspaces tab's workspaces.
    func listsRow(for route: AidenAppRoute) -> Bool {
        switch (self, route) {
        case (.chats, _): route.chatID != nil
        case (.inbox, _): route.isConversation
        case (.bots, .bot), (.workspaces, .workspace): true
        default: false
        }
    }
}

enum AidenAppRoute: Hashable, Codable {
    case chat(AidenHostObjectID), bot(AidenHostObjectID), workspace(AidenHostObjectID)
    /// A chat forked from `source`, opened over it, so it stays over its source
    /// in every layout: beside the list the source keeps the highlight and Back
    /// returns there (`AidenSplitNavigationPath.takingOver`). The same screen
    /// as `.chat` of its ID (`screen`).
    case fork(AidenHostObjectID, source: AidenHostObjectID)
    case machines, machine(instanceId: String), settings, scheduled, usage
    /// Where a Catch Up run ends. It means nothing after a relaunch, so it's never saved.
    case catchUpFinished(AidenCatchUpEnding)

    /// The tab whose stack holds this route when it's opened on its own.
    /// Nil for a page the drawer opens (Settings, Scheduled tasks, Usage,
    /// Computers and a computer's page): it goes on top of the tab that's
    /// showing, so Back returns to where the drawer was opened.
    var ownTab: AidenAppTab? {
        switch self {
        case .chat, .fork: .chats
        case .bot: .bots
        case .workspace: .workspaces
        case .catchUpFinished: .inbox
        case .machines, .machine, .settings, .scheduled, .usage: nil
        }
    }

    /// A chat or a Bot: a row the Inbox list can select.
    var isConversation: Bool {
        switch self {
        case .chat, .fork, .bot: true
        default: false
        }
    }

    /// The chat a route shows, a fork's included.
    var chatID: AidenHostObjectID? {
        switch self {
        case .chat(let id), .fork(let id, _): id
        default: nil
        }
    }

    /// The screen the route draws. A fork is its chat's screen, so one
    /// conversation never has two screens, forked or not.
    var screen: AidenAppRoute {
        if case .fork(let id, _) = self { .chat(id) } else { self }
    }

    /// What a link asks for, on the machine it names or else the selected one.
    /// Nil for a new chat, which isn't a place to go, and for a machine that
    /// isn't paired.
    init?(
        request: AidenNavigationRequest,
        installations: [AidenInstallation],
        defaultInstanceId: String?
    ) {
        let instanceId = request.instanceId ?? defaultInstanceId
        guard let installation = installations.first(where: { $0.id == instanceId }) else { return nil }
        func owned(_ objectId: String) -> AidenHostObjectID {
            AidenHostObjectID(instanceId: installation.id, deviceId: installation.deviceId, objectId: objectId)
        }
        switch request.destination {
        case .newChat: return nil
        case .chat(let chatId): self = .chat(owned(chatId))
        case .botChat(let botId): self = .bot(owned(botId))
        }
    }

    /// The machine the route belongs to. Nil for a place that has none.
    var instanceId: String? {
        switch self {
        case .chat(let id), .fork(let id, _), .bot(let id), .workspace(let id): id.instanceId
        case .machine(let instanceId): instanceId
        case .machines, .settings, .scheduled, .usage, .catchUpFinished: nil
        }
    }

    /// False for a route to a machine that's gone, or to an older pairing of it.
    func isReachable(on installations: [AidenInstallation]) -> Bool {
        switch self {
        case .chat(let id), .fork(let id, _), .bot(let id), .workspace(let id):
            installations.contains { $0.id == id.instanceId && $0.deviceId == id.deviceId }
        case .machine(let instanceId):
            installations.contains { $0.id == instanceId }
        case .machines, .settings, .scheduled, .usage, .catchUpFinished:
            true
        }
    }

    /// True for a route to something on this machine.
    fileprivate func belongs(to instanceId: String) -> Bool {
        switch self {
        case .chat(let id), .fork(let id, _), .bot(let id), .workspace(let id): id.instanceId == instanceId
        case .machine(let id): id == instanceId
        case .machines, .settings, .scheduled, .usage, .catchUpFinished: false
        }
    }
}

extension AidenRemoteCoordinator {
    /// False once the route's machine has left, been paired again, or been revoked.
    func canOpen(_ route: AidenAppRoute) -> Bool {
        route.isReachable(on: installationStore.installations)
            && route.instanceId.flatMap { hosts.connection(for: $0)?.isRevoked } != true
    }
}

/// The shell's place in the app, as saved between launches.
struct AidenAppNavigationSnapshot: Codable, Equatable {
    var tab: AidenAppTab
    var chatsPath: [AidenAppRoute]
    var inboxPath: [AidenAppRoute]
    var botsPath: [AidenAppRoute]
    var workspacesPath: [AidenAppRoute]
    /// Where a machine that isn't on a tab's path had got to, by `savedPathKey`.
    /// Each tab has one path, and v1 kept one per machine, so this is where
    /// the others wait instead of being lost.
    var savedPaths: [String: [AidenAppRoute]]

    init(
        tab: AidenAppTab = .chats,
        chatsPath: [AidenAppRoute] = [],
        inboxPath: [AidenAppRoute] = [],
        botsPath: [AidenAppRoute] = [],
        workspacesPath: [AidenAppRoute] = [],
        savedPaths: [String: [AidenAppRoute]] = [:]
    ) {
        self.tab = tab
        self.chatsPath = chatsPath
        self.inboxPath = inboxPath
        self.botsPath = botsPath
        self.workspacesPath = workspacesPath
        self.savedPaths = savedPaths
    }

    /// `AidenHostObjectID.storageKey` with the tab as the object, so a pairing's
    /// two paths stay apart, and a new pairing of the machine starts clean.
    private static func savedPathKey(of installation: AidenInstallation, on tab: AidenAppTab) -> String {
        AidenHostObjectID(
            instanceId: installation.id,
            deviceId: installation.deviceId,
            objectId: tab.rawValue
        ).storageKey
    }

    static func savedPaths(
        of installation: AidenInstallation,
        on tab: AidenAppTab,
        _ path: [AidenAppRoute]
    ) -> [String: [AidenAppRoute]] {
        [savedPathKey(of: installation, on: tab): path]
    }

    func savedPath(on tab: AidenAppTab, of installation: AidenInstallation) -> [AidenAppRoute] {
        savedPaths[Self.savedPathKey(of: installation, on: tab)] ?? []
    }

    /// Read per field: a tab or route only a later build knows costs that one
    /// value, not the whole snapshot. A v2 snapshot reads the same way: it has
    /// no Chats path, and its `search` tab, gone from the bar, reads as Chats.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tab = (try? container.decode(AidenAppTab.self, forKey: .tab)) ?? .chats
        chatsPath = (try? container.decode([AidenAppRoute].self, forKey: .chatsPath)) ?? []
        inboxPath = (try? container.decode([AidenAppRoute].self, forKey: .inboxPath)) ?? []
        botsPath = (try? container.decode([AidenAppRoute].self, forKey: .botsPath)) ?? []
        workspacesPath = (try? container.decode([AidenAppRoute].self, forKey: .workspacesPath)) ?? []
        savedPaths = (try? container.decode([String: [AidenAppRoute]].self, forKey: .savedPaths)) ?? [:]
    }

    /// Without this machine's routes. A tab it was on goes back to the last
    /// screen before its first one, so Machines stays when its page goes.
    fileprivate func removing(instanceId: String) -> AidenAppNavigationSnapshot {
        func kept(_ path: [AidenAppRoute]) -> [AidenAppRoute] {
            Array(path.prefix { !$0.belongs(to: instanceId) })
        }
        return AidenAppNavigationSnapshot(
            tab: tab,
            chatsPath: kept(chatsPath),
            inboxPath: kept(inboxPath),
            botsPath: kept(botsPath),
            workspacesPath: kept(workspacesPath),
            savedPaths: savedPaths.filter { !$0.value.contains { $0.belongs(to: instanceId) } }
        )
    }
}

/// The tab shell's routes, in `aiden.product-navigation.v3`. A saved v3 stands
/// for itself, readable or not. Without one, a saved v2 (the Inbox, Bots,
/// Workspaces and Search bar) is read in its place, with Search becoming
/// Chats; only the absence of both means v1 hasn't moved yet.
///
/// `AidenProductNavigationStore` keeps `aiden.product-navigation.v1`: each
/// machine's last workspace stays there, and the menu shell's per-machine paths
/// until the first write here lands.
struct AidenAppNavigationStore {
    static let snapshotKey = "aiden.product-navigation.v3"
    /// The four-tab bar's key before Chats. The first v3 write removes it.
    static let previousSnapshotKey = "aiden.product-navigation.v2"
    private static let sizeLimit = 1_048_576

    private let defaults: UserDefaults
    private let legacy: AidenProductNavigationStore

    /// The app's v1 store is one shared object, and a second one over the same
    /// defaults would write its own stale copy back over it.
    init(defaults: UserDefaults = .standard, legacy: AidenProductNavigationStore? = nil) {
        self.defaults = defaults
        self.legacy = legacy ?? (defaults === UserDefaults.standard
            ? .shared
            : AidenProductNavigationStore(defaults: defaults))
    }

    /// Reading never writes, so a launch that goes no further leaves v1 whole.
    func load(
        installations: [AidenInstallation] = [],
        selected: String? = nil
    ) -> AidenAppNavigationSnapshot {
        guard let key = [Self.snapshotKey, Self.previousSnapshotKey].first(where: { defaults.object(forKey: $0) != nil }) else {
            return migrated(installations: installations, selected: selected)
        }
        guard let data = defaults.data(forKey: key),
              data.count <= Self.sizeLimit,
              let snapshot = try? JSONDecoder().decode(AidenAppNavigationSnapshot.self, from: data) else {
            return AidenAppNavigationSnapshot()
        }
        return snapshot
    }

    private var hasSaved: Bool {
        defaults.object(forKey: Self.snapshotKey) != nil || defaults.object(forKey: Self.previousSnapshotKey) != nil
    }

    /// The first write to land is the one that replaces v1's paths. One that
    /// doesn't land, whether too big or refused, leaves v1 as it was.
    ///
    /// A write that lands also keeps the workspace open deepest on the
    /// Workspaces tab in v1, as its machine's last workspace: a new-chat link or
    /// Shortcut that names no workspace starts there.
    func save(_ snapshot: AidenAppNavigationSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot), data.count <= Self.sizeLimit else { return }
        let isFirstWrite = defaults.object(forKey: Self.snapshotKey) == nil
        defaults.set(data, forKey: Self.snapshotKey)
        guard defaults.data(forKey: Self.snapshotKey) == data else { return }
        rememberTheOpenWorkspace(in: snapshot)
        if isFirstWrite {
            defaults.removeObject(forKey: Self.previousSnapshotKey)
            legacy.forgetCompactPaths()
        }
    }

    private func rememberTheOpenWorkspace(in snapshot: AidenAppNavigationSnapshot) {
        for route in snapshot.workspacesPath.reversed() {
            guard case .workspace(let id) = route else { continue }
            if legacy.selectedWorkspace(for: id.instanceId) != id.objectId {
                legacy.setSelectedWorkspace(id.objectId, for: id.instanceId)
            }
            return
        }
    }

    /// Takes a forgotten machine's routes out of what's saved. With neither v3
    /// nor v2 saved there are none, and v1's own purge has its paths.
    func purge(instanceID: String) {
        guard hasSaved else { return }
        save(load().removing(instanceId: instanceID))
    }

    /// v1's paths, each on the machine it was saved for. They name workspaces
    /// and chats by id alone, so a machine that's no longer paired can't take
    /// them. The selected machine's go on the tabs, which is where the old
    /// shell would have opened.
    private func migrated(installations: [AidenInstallation], selected: String?) -> AidenAppNavigationSnapshot {
        var snapshot = AidenAppNavigationSnapshot()
        for installation in installations {
            func owned(_ objectId: String) -> AidenHostObjectID {
                AidenHostObjectID(instanceId: installation.id, deviceId: installation.deviceId, objectId: objectId)
            }
            let workspaces = legacy.compactWorkspacePath(for: installation.id).map { AidenAppRoute.workspace(owned($0)) }
            let bots = legacy.compactBotPath(for: installation.id).map { value in
                AidenBotChatRoute.botID(fromPath: value).map { AidenAppRoute.bot(owned($0)) } ?? .chat(owned(value))
            }
            if installation.id == selected {
                snapshot.workspacesPath = workspaces
                snapshot.botsPath = bots
                continue
            }
            if !workspaces.isEmpty {
                snapshot.savedPaths.merge(AidenAppNavigationSnapshot.savedPaths(of: installation, on: .workspaces, workspaces)) { $1 }
            }
            if !bots.isEmpty {
                snapshot.savedPaths.merge(AidenAppNavigationSnapshot.savedPaths(of: installation, on: .bots, bots)) { $1 }
            }
        }
        return snapshot
    }
}

/// A tab's path shown as a list beside its detail, at regular width. The tab's
/// path stays the one source of truth: its first route is the list's selection,
/// and the rest are pushed on the detail column's stack. A compact width shows
/// the same path as one stack over the list, so closing or opening the display
/// keeps the same route on screen.
///
/// Everything on screen is on the path, a workspace's chats and the forks
/// pushed over a chat included, so a size-class change, Back and a relaunch
/// all see it. A chat's own state, such as its draft, attachments and place,
/// is the shell's (`AidenChatScreens`), so a rebuilt screen keeps it.
struct AidenSplitNavigationPath: Equatable {
    private(set) var path: [AidenAppRoute]

    init(_ path: [AidenAppRoute]) {
        self.path = path
    }

    /// The list's selected row, and the detail column's root.
    var selection: AidenAppRoute? { path.first }

    /// What's pushed in the detail column over the selection.
    var detailPath: [AidenAppRoute] { Array(path.dropFirst()) }

    /// Choosing a row starts the detail over on it.
    mutating func select(_ route: AidenAppRoute) {
        path = [route]
    }

    /// A stack's path taken over by the tab's list: the route nearest the top
    /// that the list has a row for becomes the selection and only the screens
    /// above it stay, so the highlighted row is what's on screen. Pages under
    /// it, and rows it was opened over, go. A fork stays over the chat it came
    /// from, so that chat keeps the highlight and Back from the fork returns
    /// to it. A path with no such route is kept as it is.
    static func takingOver(_ path: [AidenAppRoute], on tab: AidenAppTab) -> [AidenAppRoute] {
        guard var index = path.lastIndex(where: tab.listsRow) else { return path }
        while index > 0, case .fork(_, let source) = path[index], path[index - 1].chatID == source {
            index -= 1
        }
        return Array(path[index...])
    }

    /// The detail column's stack moved, by Back or a push. With nothing
    /// selected there's no detail stack, so there's nothing to change.
    mutating func setDetailPath(_ detailPath: [AidenAppRoute]) {
        guard let selection else { return }
        path = [selection] + detailPath
    }

    /// True when the list is drawn over the detail rather than beside it: the
    /// detail column starts at the split's own leading edge, where tiled
    /// columns start it after the list. Frames are global. A frame not measured
    /// yet, or a detail narrower than half the split (one mid-animation), says no.
    static func listIsOverlaid(detailFrame: CGRect, splitFrame: CGRect) -> Bool {
        guard splitFrame.width > 0, detailFrame.width > splitFrame.width / 2 else { return false }
        return abs(detailFrame.minX - splitFrame.minX) < 1
    }
}

/// Which tab is showing and what each tab has pushed.
@MainActor @Observable
final class AidenAppNavigation {
    var tab: AidenAppTab
    var chatsPath: [AidenAppRoute]
    var inboxPath: [AidenAppRoute] {
        didSet { endCatchUpIfLeft() }
    }
    var botsPath: [AidenAppRoute]
    var workspacesPath: [AidenAppRoute]
    private var savedPaths: [String: [AidenAppRoute]]

    /// Not saved: a relaunch must not open the microphone or camera.
    private(set) var chatStartingVoice: AidenHostObjectID?
    private(set) var chatStartingCamera: AidenHostObjectID?
    /// The Catch Up under way, while its chat is on top of the Inbox. Not saved:
    /// a relaunch restores the chat, as an ordinary chat.
    private(set) var catchUp: AidenCatchUpRun?
    /// Each list tab's list is beside its detail (regular width). The shell
    /// keeps it in step with the size class. A route a tab's list has a row for
    /// (`AidenAppTab.listsRow`) then becomes that list's selection instead of
    /// going on top of the one there, so the highlighted row is what's on
    /// screen. Pages such as Settings, and a workspace's chats, still go on
    /// top. Not saved: the width decides it on every launch. Turning it on, at
    /// launch or when the display opens, hands each path to its list
    /// (`AidenSplitNavigationPath.takingOver`).
    var besideList = false {
        didSet {
            guard besideList, !oldValue else { return }
            for tab in AidenAppTab.listTabs {
                let updated = AidenSplitNavigationPath.takingOver(path(of: tab), on: tab)
                if updated != self.path(of: tab) { setPath(updated, of: tab) }
            }
        }
    }

    init() {
        tab = .chats
        chatsPath = []
        inboxPath = []
        botsPath = []
        workspacesPath = []
        savedPaths = [:]
    }

    init(restoring snapshot: AidenAppNavigationSnapshot, installations: [AidenInstallation]) {
        tab = snapshot.tab
        // One conversation, one screen, as `setPath` keeps it: the tab that
        // was showing keeps a conversation two tabs held, then the first.
        var paths: [AidenAppTab: [AidenAppRoute]] = [
            .chats: snapshot.chatsPath, .inbox: snapshot.inboxPath,
            .bots: snapshot.botsPath, .workspaces: snapshot.workspacesPath,
        ]
        var shown = Set<AidenAppRoute>()
        let showingFirst = AidenAppTab.listTabs.filter { $0 == snapshot.tab } + AidenAppTab.listTabs.filter { $0 != snapshot.tab }
        for tab in showingFirst {
            var path = paths[tab] ?? []
            if let repeated = path.firstIndex(where: { $0.isConversation && shown.contains($0.screen) }) {
                path.removeSubrange(repeated...)
            }
            shown.formUnion(path.filter(\.isConversation).map(\.screen))
            paths[tab] = path
        }
        chatsPath = paths[.chats] ?? []
        inboxPath = paths[.inbox] ?? []
        botsPath = paths[.bots] ?? []
        workspacesPath = paths[.workspaces] ?? []
        savedPaths = snapshot.savedPaths
        dropRoutes(outside: installations)
    }

    /// Whether a list tab's path holds the conversation, as a chat or a fork.
    /// Its screen keeps its state while one does (`AidenChatScreens`).
    func holdsConversation(_ id: AidenHostObjectID) -> Bool {
        AidenAppTab.listTabs.contains { path(of: $0).contains { $0.chatID == id } }
    }

    /// Whether a list tab's path holds the Bot's route. Its screen keeps its
    /// state while one does (`AidenChatScreens`).
    func holdsBot(_ id: AidenHostObjectID) -> Bool {
        AidenAppTab.listTabs.contains { path(of: $0).contains { $0 == .bot(id) } }
    }

    var snapshot: AidenAppNavigationSnapshot {
        AidenAppNavigationSnapshot(
            tab: tab,
            chatsPath: chatsPath,
            inboxPath: inboxPath.filter { if case .catchUpFinished = $0 { false } else { true } },
            botsPath: botsPath,
            workspacesPath: workspacesPath,
            savedPaths: savedPaths
        )
    }

    /// The chat on screen: the top of the tab that's showing.
    var openChat: AidenHostObjectID? {
        path(of: tab).last?.chatID
    }

    /// The chat the Inbox counts as open, which it keeps listed and never calls
    /// news. Beside the list that's also the selected chat under a page pushed
    /// over it, since its row is still highlighted and it's still the detail.
    var inboxOpenChat: AidenHostObjectID? {
        if let openChat { return openChat }
        guard besideList, tab == .inbox else { return nil }
        return inboxPath.first?.chatID
    }

    /// A chat or a Bot on top of the tab that's showing: either has a composer.
    var showsConversation: Bool {
        path(of: tab).last?.isConversation == true
    }

    /// The tab's path.
    func path(of tab: AidenAppTab) -> [AidenAppRoute] {
        switch tab {
        case .chats: chatsPath
        case .inbox: inboxPath
        case .bots: botsPath
        case .workspaces: workspacesPath
        }
    }

    /// A chat or Bot new to the tab's path leaves every other tab first, so
    /// one conversation never has two screens, however it got there: a pick,
    /// a push, or a link the stack followed.
    func setPath(_ path: [AidenAppRoute], of tab: AidenAppTab) {
        let current = self.path(of: tab)
        for route in path where route.isConversation && !current.contains(where: { $0.screen == route.screen }) {
            for other in AidenAppTab.listTabs where other != tab {
                var otherPath = self.path(of: other)
                Self.remove(route, from: &otherPath)
                if otherPath != self.path(of: other) { setPath(otherPath, of: other) }
            }
        }
        switch tab {
        case .chats: chatsPath = path
        case .inbox: inboxPath = path
        case .bots: botsPath = path
        case .workspaces: workspacesPath = path
        }
    }

    /// A write from a list tab's container: a stack beside the list or not
    /// (`besideList`) moved by Back or a push, or laid out. Opening or closing
    /// an iPhone Duo swaps the container, and the one going away can still
    /// write as it tears down, an empty path among them. A write from the
    /// layout that's no longer current is dropped, so the swap keeps the path.
    ///
    /// `widthIsRegular` is the width the container sees now, nil when it
    /// doesn't know. The container hears the new width an update before the
    /// shell moves `besideList`, so a split collapsing as the display closes
    /// writes while `besideList` still says regular: its own width says it's
    /// on the way out.
    func setPath(
        _ path: [AidenAppRoute],
        of tab: AidenAppTab,
        laidOutBesideList: Bool,
        widthIsRegular: Bool? = nil
    ) {
        guard laidOutBesideList == besideList,
              laidOutBesideList == (widthIsRegular ?? laidOutBesideList),
              path != self.path(of: tab) else { return }
        setPath(path, of: tab)
    }

    /// Selects the route's tab and shows the route there, or goes back to it
    /// wherever it's already open. A page with no tab of its own
    /// (`AidenAppRoute.ownTab`) goes on the tab that's showing. `startsVoice`
    /// and `startsCamera` belong to foreground shortcuts and widget buttons:
    /// the chat starts listening or opens its camera picker when it opens.
    func open(_ route: AidenAppRoute, startsVoice: Bool = false, startsCamera: Bool = false) {
        open(route, on: route.ownTab ?? tab)
        if case .chat(let id) = route {
            if startsVoice {
                chatStartingVoice = id
            } else if startsCamera {
                chatStartingCamera = id
            }
        }
    }

    func finishStartingVoice(_ id: AidenHostObjectID) {
        if chatStartingVoice == id { chatStartingVoice = nil }
    }

    func finishStartingCamera(_ id: AidenHostObjectID) {
        if chatStartingCamera == id { chatStartingCamera = nil }
    }

    /// Switches to `tab` at its root screen, used by Home Screen Quick Actions
    /// and widget buttons. Other tabs keep their stacks, so a Catch Up left
    /// on the Inbox is still there to go back to; emptying the Inbox ends it.
    func selectTabRoot(_ tab: AidenAppTab) {
        chatStartingVoice = nil
        chatStartingCamera = nil
        self.tab = tab
        switch tab {
        case .chats: chatsPath = []
        case .inbox: inboxPath = []
        case .bots: botsPath = []
        case .workspaces: workspacesPath = []
        }
    }

    /// Shows the route on `tab`, which needn't be its own: a chat started from the
    /// Workspaces tab stays there, so Back returns to where it was started. A route
    /// already open on another tab is gone back to there, so one chat never has
    /// two screens.
    func open(_ route: AidenAppRoute, on tab: AidenAppTab) {
        chatStartingVoice = nil
        chatStartingCamera = nil
        let holders = AidenAppTab.allCases.filter { path(of: $0).contains { $0.screen == route.screen } }
        let tab = holders.contains(tab) ? tab : holders.first ?? tab
        self.tab = tab
        show(route, onTab: tab)
    }

    /// A row chosen from `tab`'s own list. Beside the list it becomes that
    /// tab's selection, where the person chose it, and another tab holding the
    /// same route leaves it first, so one route still never has two screens.
    /// Otherwise it opens as `open(_:)` does.
    func pick(_ route: AidenAppRoute, fromListOf tab: AidenAppTab) {
        guard besideList, tab.listsRow(for: route) else { return open(route) }
        chatStartingVoice = nil
        chatStartingCamera = nil
        for other in AidenAppTab.listTabs where other != tab {
            var updated = path(of: other)
            Self.remove(route, from: &updated)
            if updated != self.path(of: other) { setPath(updated, of: other) }
        }
        self.tab = tab
        show(route, onTab: tab)
    }

    /// Pushes `route` over `parent` on the tab showing `parent`: a workspace's
    /// chat over its workspace, a fork over the chat it came from. Whatever
    /// was above `parent` goes, so Back from `route` returns to `parent`, and
    /// choosing another row beside the list takes both away. With `parent`
    /// on no path, `route` opens as `open(_:)` opens it.
    func push(_ route: AidenAppRoute, over parent: AidenAppRoute) {
        let holders = AidenAppTab.listTabs.filter { path(of: $0).contains(parent) }
        guard let holder = holders.contains(tab) ? tab : holders.first,
              let index = path(of: holder).firstIndex(of: parent) else { return open(route) }
        chatStartingVoice = nil
        chatStartingCamera = nil
        tab = holder
        let updated = Array(path(of: holder)[...index]) + [route]
        if updated != self.path(of: holder) { setPath(updated, of: holder) }
    }

    /// Goes back to just below the route, wherever it is. Nothing happens when
    /// it isn't on a path.
    func leave(_ route: AidenAppRoute) {
        Self.remove(route, from: &chatsPath)
        Self.remove(route, from: &inboxPath)
        Self.remove(route, from: &botsPath)
        Self.remove(route, from: &workspacesPath)
    }

    /// The selected machine changed. Scheduled tasks and Usage read the machine
    /// they opened on, so neither stays open on another.
    func leaveSelectedMachineRoutes() {
        leave(.scheduled)
        leave(.usage)
    }

    /// Swaps a route that turned out to be something else for the right one.
    func replace(_ route: AidenAppRoute, with replacement: AidenAppRoute) {
        leave(route)
        open(replacement)
    }

    /// Opens the queue's first chat and starts a run on it. Returns the chat
    /// opened, or nil when the queue was empty and the run is already over.
    ///
    /// Beside the list, the run replaces whatever the detail showed, as
    /// choosing a row does, rather than going on top of it.
    @discardableResult
    func startCatchUp(in queue: AidenCatchUpQueue) -> AidenHostObjectID? {
        if besideList { inboxPath = [] }
        guard let first = queue.first else {
            open(.catchUpFinished(queue.ending()))
            return nil
        }
        catchUp = AidenCatchUpRun(startingAt: first)
        openInInbox(queue.route(for: first))
        return first
    }

    /// Next. The chat on screen, with anything opened over it, makes way for
    /// the next one, so Back always leads
    /// to the Inbox and a long run holds one live chat, not all of them. Returns
    /// the chat opened, or nil when that was the last and the run is over.
    @discardableResult
    func advanceCatchUp(in queue: AidenCatchUpQueue) -> AidenHostObjectID? {
        guard var run = catchUp else { return nil }
        // The chat goes with whatever was opened over it, such as a fork.
        let leaving = inboxPath.firstIndex { run.holds($0) }
        let next = run.advance(in: queue)
        // Off for the swap, which would otherwise read as leaving the run.
        catchUp = nil
        if let leaving { inboxPath.removeSubrange(leaving...) }
        guard let next else {
            open(.catchUpFinished(run.ending(in: queue)))
            return nil
        }
        openInInbox(queue.route(for: next))
        catchUp = run
        return next
    }

    /// The run lasts while its chat is on the Inbox path, under a fork or a
    /// page opened over it too, so Back from those returns to it with Next.
    private func endCatchUpIfLeft() {
        guard let catchUp else { return }
        if !inboxPath.contains(where: { catchUp.holds($0) }) { self.catchUp = nil }
    }

    /// An Inbox, accessory or running-sheet row, chat or Bot, opens on the Inbox
    /// stack, so Back leads to the Inbox. Catch Up steps open the same way.
    /// Beside the list, the row becomes the selection.
    func openInboxRow(_ route: AidenAppRoute) {
        openInInbox(route)
    }

    /// A Catch Up step stays on the Inbox, Bot or not, so Back leads to the Inbox.
    private func openInInbox(_ route: AidenAppRoute) {
        chatStartingVoice = nil
        chatStartingCamera = nil
        tab = .inbox
        show(route, onTab: .inbox)
    }

    /// On a stack the route goes on top, or is gone back to. Beside the list a
    /// route the tab's list has a row for becomes the selection and the detail
    /// starts over on it, unless it's already on the path: a fork over its
    /// source is gone back to there, so its source keeps the highlight.
    private func show(_ route: AidenAppRoute, onTab tab: AidenAppTab) {
        var updated = path(of: tab)
        if besideList, tab.listsRow(for: route), !updated.contains(where: { $0.screen == route.screen }) {
            var split = AidenSplitNavigationPath(updated)
            split.select(route)
            updated = split.path
        } else {
            Self.show(route, on: &updated)
        }
        if updated != self.path(of: tab) { setPath(updated, of: tab) }
    }

    /// A tab holding a route to a machine that's gone goes back to the last
    /// screen before it: forgetting a machine from its own page leaves Machines
    /// showing, and a chat under Settings leaves Settings. A saved per-machine
    /// path with any such route goes whole.
    func dropRoutes(outside installations: [AidenInstallation]) {
        func reachable(_ path: [AidenAppRoute]) -> [AidenAppRoute] {
            Array(path.prefix { $0.isReachable(on: installations) })
        }
        for tab in AidenAppTab.listTabs {
            let updated = reachable(path(of: tab))
            if updated != self.path(of: tab) { setPath(updated, of: tab) }
        }
        savedPaths = savedPaths.filter { _, path in path.allSatisfy { $0.isReachable(on: installations) } }
    }

    /// Takes `route`'s screen off the path, with everything above it. A fork
    /// and its chat are the same screen.
    private static func remove(_ route: AidenAppRoute, from path: inout [AidenAppRoute]) {
        guard let index = path.firstIndex(where: { $0.screen == route.screen }) else { return }
        path.removeSubrange(index...)
    }

    private static func show(_ route: AidenAppRoute, on path: inout [AidenAppRoute]) {
        if let index = path.firstIndex(where: { $0.screen == route.screen }) {
            path.removeSubrange(path.index(after: index)...)
        } else {
            path.append(route)
        }
    }
}

/// `aiden.product-navigation.v1`, which builds before the tabs wrote.
/// What's left in it: each machine's last workspace, which a new-chat link or
/// Shortcut without one still starts in, and the per-machine paths the first tab-shell
/// write moves out (`AidenAppNavigationStore`). Anything else an older build
/// saved here is dropped on the next write.
@Observable
final class AidenProductNavigationStore {
    static let shared = AidenProductNavigationStore()

    private struct Snapshot: Codable {
        var selectedWorkspaceByInstance: [String: String] = [:]
        var compactWorkspacePathByInstance: [String: [String]] = [:]
        var compactBotPathByInstance: [String: [String]] = [:]

        init() {}

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            selectedWorkspaceByInstance = try container.decodeIfPresent([String: String].self, forKey: .selectedWorkspaceByInstance) ?? [:]
            compactWorkspacePathByInstance = try container.decodeIfPresent([String: [String]].self, forKey: .compactWorkspacePathByInstance) ?? [:]
            compactBotPathByInstance = try container.decodeIfPresent([String: [String]].self, forKey: .compactBotPathByInstance) ?? [:]
        }
    }

    private static let snapshotKey = "aiden.product-navigation.v1"
    @ObservationIgnored private let defaults: UserDefaults
    private var snapshot: Snapshot

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.snapshotKey),
           data.count <= 1_048_576,
           let decoded = try? JSONDecoder().decode(Snapshot.self, from: data) {
            snapshot = Self.sanitized(decoded)
        } else {
            snapshot = Snapshot()
        }
    }

    func selectedWorkspace(for instanceID: String?) -> String? {
        guard let instanceID = Self.safeID(instanceID) else { return nil }
        return snapshot.selectedWorkspaceByInstance[instanceID]
    }

    /// `AidenAppNavigationStore.save` writes it when a workspace is open on the
    /// Workspaces tab.
    func setSelectedWorkspace(_ workspaceID: String?, for instanceID: String?) {
        guard let instanceID = Self.safeID(instanceID) else { return }
        if let workspaceID = Self.safeID(workspaceID) {
            snapshot.selectedWorkspaceByInstance[instanceID] = workspaceID
        } else {
            snapshot.selectedWorkspaceByInstance.removeValue(forKey: instanceID)
        }
        persist()
    }

    func compactWorkspacePath(for instanceID: String?) -> [String] {
        guard let instanceID = Self.safeID(instanceID) else { return [] }
        return snapshot.compactWorkspacePathByInstance[instanceID] ?? []
    }

    /// What an older build saved. Nothing in this one writes it, except tests.
    func setCompactWorkspacePath(_ path: [String], for instanceID: String?) {
        setPath(path, in: \Snapshot.compactWorkspacePathByInstance, for: instanceID)
    }

    func compactBotPath(for instanceID: String?) -> [String] {
        guard let instanceID = Self.safeID(instanceID) else { return [] }
        return snapshot.compactBotPathByInstance[instanceID] ?? []
    }

    /// What an older build saved. Nothing in this one writes it, except tests.
    func setCompactBotPath(_ path: [String], for instanceID: String?) {
        setPath(path, in: \Snapshot.compactBotPathByInstance, for: instanceID)
    }

    /// The tab shell has these now. Its first saved write calls this.
    func forgetCompactPaths() {
        guard !snapshot.compactWorkspacePathByInstance.isEmpty || !snapshot.compactBotPathByInstance.isEmpty else { return }
        snapshot.compactWorkspacePathByInstance = [:]
        snapshot.compactBotPathByInstance = [:]
        persist()
    }

    func purge(instanceID: String) {
        snapshot.selectedWorkspaceByInstance.removeValue(forKey: instanceID)
        snapshot.compactWorkspacePathByInstance.removeValue(forKey: instanceID)
        snapshot.compactBotPathByInstance.removeValue(forKey: instanceID)
        persist()
    }

    private func setPath(
        _ path: [String],
        in keyPath: WritableKeyPath<Snapshot, [String: [String]]>,
        for instanceID: String?
    ) {
        guard let instanceID = Self.safeID(instanceID) else { return }
        let sanitized = Array(path.compactMap(Self.safeID).suffix(16))
        if sanitized.isEmpty {
            snapshot[keyPath: keyPath].removeValue(forKey: instanceID)
        } else {
            snapshot[keyPath: keyPath][instanceID] = sanitized
        }
        persist()
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(snapshot), data.count <= 1_048_576 else { return }
        defaults.set(data, forKey: Self.snapshotKey)
    }

    private static func sanitized(_ value: Snapshot) -> Snapshot {
        let instanceIDs = Set(
            value.selectedWorkspaceByInstance.keys.compactMap(safeID)
                + value.compactWorkspacePathByInstance.keys.compactMap(safeID)
                + value.compactBotPathByInstance.keys.compactMap(safeID)
        )
        return instanceIDs.prefix(64).reduce(into: Snapshot()) { result, instanceID in
            if let workspaceID = safeID(value.selectedWorkspaceByInstance[instanceID]) {
                result.selectedWorkspaceByInstance[instanceID] = workspaceID
            }
            let workspacePath = Array(
                (value.compactWorkspacePathByInstance[instanceID] ?? []).compactMap(safeID).suffix(16)
            )
            if !workspacePath.isEmpty {
                result.compactWorkspacePathByInstance[instanceID] = workspacePath
            }
            let botPath = Array(
                (value.compactBotPathByInstance[instanceID] ?? []).compactMap(safeID).suffix(16)
            )
            if !botPath.isEmpty {
                result.compactBotPathByInstance[instanceID] = botPath
            }
        }
    }

    private static func safeID(_ value: String?) -> String? {
        guard let value, !value.isEmpty, value.unicodeScalars.count <= 160,
              value.unicodeScalars.allSatisfy({ scalar in
                  CharacterSet.alphanumerics.contains(scalar)
                      || "._:-".unicodeScalars.contains(scalar)
              }) else { return nil }
        return value
    }
}

private extension AidenCatchUpRun {
    /// The route of the run's chat, as a chat, a fork or a Bot.
    func holds(_ route: AidenAppRoute) -> Bool {
        route.chatID == current || route == .bot(current)
    }
}
