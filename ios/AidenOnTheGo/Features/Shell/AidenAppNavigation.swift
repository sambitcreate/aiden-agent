import Foundation
import Observation

enum AidenAppTab: String, Codable, CaseIterable, Hashable {
    case inbox, bots, workspaces, search

    /// The tabs drawn as a list beside a detail at regular width.
    static let listTabs: [AidenAppTab] = [.inbox, .bots, .workspaces]

    /// True for a route this tab's list has a row for. Beside the list such a
    /// route becomes the selection rather than going on top: the Inbox's chats
    /// and Bots, the Bots tab's Bots and the Workspaces tab's workspaces.
    func listsRow(for route: AidenAppRoute) -> Bool {
        switch (self, route) {
        case (.inbox, _): route.isConversation
        case (.bots, .bot), (.workspaces, .workspace): true
        default: false
        }
    }
}

enum AidenAppRoute: Hashable, Codable {
    case chat(AidenHostObjectID), bot(AidenHostObjectID), workspace(AidenHostObjectID)
    case machines, machine(instanceId: String), settings, scheduled, usage
    /// Where a Catch Up run ends. It means nothing after a relaunch, so it's never saved.
    case catchUpFinished(AidenCatchUpEnding)

    /// The tab whose stack holds this route.
    var tab: AidenAppTab {
        switch self {
        case .chat, .machines, .machine, .settings, .scheduled, .usage, .catchUpFinished: .inbox
        case .bot: .bots
        case .workspace: .workspaces
        }
    }

    /// A chat or a Bot: a row the Inbox list can select.
    var isConversation: Bool {
        switch self {
        case .chat, .bot: true
        default: false
        }
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
        case .chat(let id), .bot(let id), .workspace(let id): id.instanceId
        case .machine(let instanceId): instanceId
        case .machines, .settings, .scheduled, .usage, .catchUpFinished: nil
        }
    }

    /// False for a route to a machine that's gone, or to an older pairing of it.
    func isReachable(on installations: [AidenInstallation]) -> Bool {
        switch self {
        case .chat(let id), .bot(let id), .workspace(let id):
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
        case .chat(let id), .bot(let id), .workspace(let id): id.instanceId == instanceId
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
    var inboxPath: [AidenAppRoute]
    var botsPath: [AidenAppRoute]
    var workspacesPath: [AidenAppRoute]
    /// Where a machine that isn't on a tab's path had got to, by `savedPathKey`.
    /// Each tab has one path, and v1 kept one per machine, so this is where
    /// the others wait instead of being lost.
    var savedPaths: [String: [AidenAppRoute]]

    init(
        tab: AidenAppTab = .inbox,
        inboxPath: [AidenAppRoute] = [],
        botsPath: [AidenAppRoute] = [],
        workspacesPath: [AidenAppRoute] = [],
        savedPaths: [String: [AidenAppRoute]] = [:]
    ) {
        self.tab = tab
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
    /// value, not the whole snapshot.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tab = (try? container.decode(AidenAppTab.self, forKey: .tab)) ?? .inbox
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
            inboxPath: kept(inboxPath),
            botsPath: kept(botsPath),
            workspacesPath: kept(workspacesPath),
            savedPaths: savedPaths.filter { !$0.value.contains { $0.belongs(to: instanceId) } }
        )
    }
}

/// The tab shell's routes, in `aiden.product-navigation.v2`. A saved v2 stands
/// for itself, readable or not: only its absence means v1 hasn't moved yet.
///
/// `AidenProductNavigationStore` keeps `aiden.product-navigation.v1`: each
/// machine's last workspace stays there, and the menu shell's per-machine paths
/// until the first v2 write lands.
struct AidenAppNavigationStore {
    static let snapshotKey = "aiden.product-navigation.v2"
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
        guard defaults.object(forKey: Self.snapshotKey) != nil else {
            return migrated(installations: installations, selected: selected)
        }
        guard let data = defaults.data(forKey: Self.snapshotKey),
              data.count <= Self.sizeLimit,
              let snapshot = try? JSONDecoder().decode(AidenAppNavigationSnapshot.self, from: data) else {
            return AidenAppNavigationSnapshot()
        }
        return snapshot
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
        if isFirstWrite { legacy.forgetCompactPaths() }
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

    /// Takes a forgotten machine's routes out of what's saved. Before the first
    /// v2 write there are none, and v1's own purge has its paths.
    func purge(instanceID: String) {
        guard defaults.object(forKey: Self.snapshotKey) != nil else { return }
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
/// the same path as one stack, so closing or opening the display keeps the same
/// route on screen.
///
/// Everything on screen is on the path, a workspace's chats and the forks
/// pushed over a chat included, so a size-class change, Back and a relaunch
/// all see it. Per-view state such as unsent attachments isn't carried across
/// a rebuilt screen; draft text is kept by the composer's own store.
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
    /// it, and rows it was opened over, go. A path with no such route is kept
    /// as it is.
    static func takingOver(_ path: [AidenAppRoute], on tab: AidenAppTab) -> [AidenAppRoute] {
        guard let index = path.lastIndex(where: tab.listsRow) else { return path }
        return Array(path[index...])
    }

    /// Collapsed to one stack, the split shows the list while the path is
    /// empty and the detail once it holds something.
    static func compactShowsList(_ path: [AidenAppRoute]) -> Bool {
        path.isEmpty
    }

    /// The path after the split shows the list or the detail. Collapsed,
    /// showing the list is Back, which takes one screen off: from the detail's
    /// root that empties the path, and from a screen pushed over it, such as a
    /// workspace's chat, it returns to the one underneath. A closed iPhone Duo
    /// reports either Back this way, without writing the detail stack's path.
    /// Beside the list the split's writes are its own and change nothing, and
    /// so does showing the detail, which only a chosen route does.
    static func path(
        _ path: [AidenAppRoute],
        afterShowingList showsList: Bool,
        besideList: Bool
    ) -> [AidenAppRoute] {
        besideList || !showsList ? path : Array(path.dropLast())
    }

    /// The route the detail column draws at its root. Collapsed, Back empties
    /// the path before the detail has slid away, so the route that was there
    /// is drawn until another is chosen. Beside the list, nothing selected is
    /// the empty state.
    static func detailRoot(
        selection: AidenAppRoute?,
        lastSelection: AidenAppRoute?,
        besideList: Bool
    ) -> AidenAppRoute? {
        selection ?? (besideList ? nil : lastSelection)
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

/// Which tab is showing and what each tab has pushed. Search has no path.
@MainActor @Observable
final class AidenAppNavigation {
    var tab: AidenAppTab
    var inboxPath: [AidenAppRoute] {
        didSet {
            endCatchUpIfLeft()
            rememberSelection(of: .inbox)
        }
    }
    var botsPath: [AidenAppRoute] {
        didSet { rememberSelection(of: .bots) }
    }
    var workspacesPath: [AidenAppRoute] {
        didSet { rememberSelection(of: .workspaces) }
    }
    private var savedPaths: [String: [AidenAppRoute]]
    /// Each list tab's last selection: the first route its path held. A
    /// collapsed split draws it while Back slides the detail away, after the
    /// path has emptied. Not saved.
    private var lastSelections: [AidenAppTab: AidenAppRoute] = [:]

    /// Not saved: a relaunch must not open the microphone.
    private(set) var chatStartingVoice: AidenHostObjectID?
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
                let path = AidenSplitNavigationPath.takingOver(path(of: tab), on: tab)
                if path != self.path(of: tab) { setPath(path, of: tab) }
            }
        }
    }

    init() {
        tab = .inbox
        inboxPath = []
        botsPath = []
        workspacesPath = []
        savedPaths = [:]
    }

    init(restoring snapshot: AidenAppNavigationSnapshot, installations: [AidenInstallation]) {
        tab = snapshot.tab
        inboxPath = snapshot.inboxPath
        botsPath = snapshot.botsPath
        workspacesPath = snapshot.workspacesPath
        savedPaths = snapshot.savedPaths
        for tab in AidenAppTab.listTabs { rememberSelection(of: tab) }
        dropRoutes(outside: installations)
    }

    /// The route a collapsed split draws in its detail once Back has emptied
    /// the tab's path, while the detail slides away: the selection it last
    /// had. Nil once that's gone (`forgetLastSelection`), or was never there.
    func lastSelection(of tab: AidenAppTab) -> AidenAppRoute? {
        lastSelections[tab]
    }

    /// The outgoing detail has left the screen. Its route isn't drawn any
    /// more, so its screen and model can go. A tab with a selection keeps it.
    func forgetLastSelection(of tab: AidenAppTab) {
        guard path(of: tab).isEmpty, lastSelections[tab] != nil else { return }
        lastSelections[tab] = nil
    }

    /// A deleted chat, or the like, isn't drawn again on its way out.
    func forget(_ route: AidenAppRoute) {
        for (tab, last) in lastSelections where last == route {
            lastSelections[tab] = nil
        }
    }

    private func rememberSelection(of tab: AidenAppTab) {
        guard let first = path(of: tab).first, lastSelections[tab] != first else { return }
        lastSelections[tab] = first
    }

    var snapshot: AidenAppNavigationSnapshot {
        AidenAppNavigationSnapshot(
            tab: tab,
            inboxPath: inboxPath.filter { if case .catchUpFinished = $0 { false } else { true } },
            botsPath: botsPath,
            workspacesPath: workspacesPath,
            savedPaths: savedPaths
        )
    }

    /// The chat on screen: the top of the tab that's showing.
    var openChat: AidenHostObjectID? {
        guard case .chat(let id)? = path(of: tab).last else { return nil }
        return id
    }

    /// The chat the Inbox counts as open, which it keeps listed and never calls
    /// news. Beside the list that's also the selected chat under a page pushed
    /// over it, since its row is still highlighted and it's still the detail.
    var inboxOpenChat: AidenHostObjectID? {
        if let openChat { return openChat }
        guard besideList, tab == .inbox, case .chat(let id)? = inboxPath.first else { return nil }
        return id
    }

    /// A chat or a Bot on top of the tab that's showing: either has a composer.
    var showsConversation: Bool {
        switch path(of: tab).last {
        case .chat?, .bot?: true
        default: false
        }
    }

    /// The tab's path. Search has none.
    func path(of tab: AidenAppTab) -> [AidenAppRoute] {
        switch tab {
        case .inbox: inboxPath
        case .bots: botsPath
        case .workspaces: workspacesPath
        case .search: []
        }
    }

    /// A chat or Bot new to the tab's path leaves every other tab first, so
    /// one conversation never has two screens, however it got there: a pick,
    /// a push, or a link the stack followed.
    func setPath(_ path: [AidenAppRoute], of tab: AidenAppTab) {
        let current = self.path(of: tab)
        for route in path where route.isConversation && !current.contains(route) {
            for other in AidenAppTab.listTabs where other != tab {
                var otherPath = self.path(of: other)
                Self.remove(route, from: &otherPath)
                if otherPath != self.path(of: other) { setPath(otherPath, of: other) }
            }
        }
        switch tab {
        case .inbox: inboxPath = path
        case .bots: botsPath = path
        case .workspaces: workspacesPath = path
        case .search: break
        }
    }

    /// The tab bar or side rail chose a tab. Choosing the tab already showing
    /// takes a collapsed split back to its list, which SwiftUI reports only as
    /// a write showing the list, the same as Back, which takes one screen off.
    /// So the path empties here, before that write. Beside the list the list
    /// is already in view, and the path is left as it is.
    func chooseTab(_ chosen: AidenAppTab) {
        if chosen == tab, !besideList, AidenAppTab.listTabs.contains(chosen) {
            setPath([], of: chosen)
        }
        tab = chosen
    }

    /// Selects the route's tab and shows the route there, or goes back to it
    /// wherever it's already open. `startsVoice` is a voice shortcut's: the chat starts listening when it opens.
    func open(_ route: AidenAppRoute, startsVoice: Bool = false) {
        open(route, on: route.tab)
        if startsVoice, case .chat(let id) = route {
            chatStartingVoice = id
        }
    }

    func finishStartingVoice(_ id: AidenHostObjectID) {
        if chatStartingVoice == id { chatStartingVoice = nil }
    }

    /// Shows the route on `tab`, which needn't be its own: a chat started from the
    /// Workspaces tab stays there, so Back returns to where it was started. A route
    /// already open on another tab is gone back to there, so one chat never has
    /// two screens.
    func open(_ route: AidenAppRoute, on tab: AidenAppTab) {
        chatStartingVoice = nil
        let holders = AidenAppTab.allCases.filter { path(of: $0).contains(route) }
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
        for other in AidenAppTab.listTabs where other != tab {
            var path = path(of: other)
            Self.remove(route, from: &path)
            if path != self.path(of: other) { setPath(path, of: other) }
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
        tab = holder
        let path = Array(path(of: holder)[...index]) + [route]
        if path != self.path(of: holder) { setPath(path, of: holder) }
    }

    /// Goes back to just below the route, wherever it is. Nothing happens when
    /// it isn't on a path.
    func leave(_ route: AidenAppRoute) {
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

    /// Next. The chat on screen makes way for the next one, so Back always leads
    /// to the Inbox and a long run holds one live chat, not all of them. Returns
    /// the chat opened, or nil when that was the last and the run is over.
    @discardableResult
    func advanceCatchUp(in queue: AidenCatchUpQueue) -> AidenHostObjectID? {
        guard var run = catchUp else { return nil }
        let next = run.advance(in: queue)
        // Off for the swap, which would otherwise read as leaving the run.
        catchUp = nil
        inboxPath.removeLast()
        guard let next else {
            open(.catchUpFinished(run.ending(in: queue)))
            return nil
        }
        openInInbox(queue.route(for: next))
        catchUp = run
        return next
    }

    private func endCatchUpIfLeft() {
        guard let catchUp else { return }
        if inboxPath.last != .chat(catchUp.current), inboxPath.last != .bot(catchUp.current) { self.catchUp = nil }
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
        tab = .inbox
        show(route, onTab: .inbox)
    }

    /// On a stack the route goes on top, or is gone back to. Beside the list a
    /// route the tab's list has a row for becomes the selection and the detail
    /// starts over on it.
    private func show(_ route: AidenAppRoute, onTab tab: AidenAppTab) {
        var path = path(of: tab)
        if besideList, tab.listsRow(for: route) {
            var split = AidenSplitNavigationPath(path)
            split.select(route)
            path = split.path
        } else {
            Self.show(route, on: &path)
        }
        if path != self.path(of: tab) { setPath(path, of: tab) }
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
            let path = reachable(path(of: tab))
            if path != self.path(of: tab) { setPath(path, of: tab) }
        }
        savedPaths = savedPaths.filter { _, path in path.allSatisfy { $0.isReachable(on: installations) } }
        lastSelections = lastSelections.filter { $0.value.isReachable(on: installations) }
    }

    private static func remove(_ route: AidenAppRoute, from path: inout [AidenAppRoute]) {
        guard let index = path.firstIndex(of: route) else { return }
        path.removeSubrange(index...)
    }

    private static func show(_ route: AidenAppRoute, on path: inout [AidenAppRoute]) {
        if let index = path.firstIndex(of: route) {
            path.removeSubrange(path.index(after: index)...)
        } else {
            path.append(route)
        }
    }
}

/// `aiden.product-navigation.v1`, which builds before the tabs wrote.
/// What's left in it: each machine's last workspace, which a new-chat link or
/// Shortcut without one still starts in, and the per-machine paths the first v2
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

    /// v2 has these now. Its first saved write calls this.
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
