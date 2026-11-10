import Foundation
import Observation

enum AidenAppTab: String, Codable, CaseIterable, Hashable {
    case inbox, bots, workspaces, search
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

    /// What a link asks for, on the machine it names or else the selected one.
    /// Nil for a new chat, which isn't a place to go, and for a machine that
    /// isn't paired.
    init?(
        request: AidenNavigationRequest,
        installations: [AidenInstallation],
        activeInstanceId: String?
    ) {
        let instanceId = request.instanceId ?? activeInstanceId
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
    /// Each tab has one path, and the old shell kept one per machine, so this
    /// is where the others wait instead of being lost.
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

    /// Without this machine's routes. A tab it was on returns to its root.
    fileprivate func removing(instanceId: String) -> AidenAppNavigationSnapshot {
        func kept(_ path: [AidenAppRoute]) -> [AidenAppRoute] {
            path.contains { $0.belongs(to: instanceId) } ? [] : path
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
/// `AidenProductNavigationStore` keeps `aiden.product-navigation.v1`: the old
/// shell's preferences stay there for good, and its per-machine paths until the
/// first v2 write lands.
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
    /// doesn't land, whether too big or refused, leaves them where they are.
    func save(_ snapshot: AidenAppNavigationSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot), data.count <= Self.sizeLimit else { return }
        let isFirstWrite = defaults.object(forKey: Self.snapshotKey) == nil
        defaults.set(data, forKey: Self.snapshotKey)
        guard isFirstWrite, defaults.data(forKey: Self.snapshotKey) == data else { return }
        legacy.forgetCompactPaths()
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

/// Which tab is showing and what each tab has pushed. Search has no path.
@MainActor @Observable
final class AidenAppNavigation {
    var tab: AidenAppTab
    var inboxPath: [AidenAppRoute] {
        didSet { endCatchUpIfLeft() }
    }
    var botsPath: [AidenAppRoute]
    var workspacesPath: [AidenAppRoute]
    private var savedPaths: [String: [AidenAppRoute]]

    /// Not saved: a relaunch must not open the microphone.
    private(set) var chatStartingVoice: AidenHostObjectID?
    /// The Catch Up under way, while its chat is on top of the Inbox. Not saved:
    /// a relaunch restores the chat, as an ordinary chat.
    private(set) var catchUp: AidenCatchUpRun?

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
        dropRoutes(outside: installations)
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

    /// A chat or a Bot on top of the tab that's showing: either has a composer.
    var showsConversation: Bool {
        switch path(of: tab).last {
        case .chat?, .bot?: true
        default: false
        }
    }

    private func path(of tab: AidenAppTab) -> [AidenAppRoute] {
        switch tab {
        case .inbox: inboxPath
        case .bots: botsPath
        case .workspaces: workspacesPath
        case .search: []
        }
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
        switch tab {
        case .inbox: Self.show(route, on: &inboxPath)
        case .bots: Self.show(route, on: &botsPath)
        case .workspaces: Self.show(route, on: &workspacesPath)
        case .search: break
        }
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
    @discardableResult
    func startCatchUp(in queue: AidenCatchUpQueue) -> AidenHostObjectID? {
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
    func openInboxRow(_ route: AidenAppRoute) {
        openInInbox(route)
    }

    /// A Catch Up step stays on the Inbox, Bot or not, so Back leads to the Inbox.
    private func openInInbox(_ route: AidenAppRoute) {
        chatStartingVoice = nil
        tab = .inbox
        Self.show(route, on: &inboxPath)
    }

    /// A tab holding a route to a machine that's gone returns to its root.
    func dropRoutes(outside installations: [AidenInstallation]) {
        func reachable(_ path: [AidenAppRoute]) -> [AidenAppRoute] {
            path.allSatisfy { $0.isReachable(on: installations) } ? path : []
        }
        inboxPath = reachable(inboxPath)
        botsPath = reachable(botsPath)
        workspacesPath = reachable(workspacesPath)
        savedPaths = savedPaths.filter { _, path in path.allSatisfy { $0.isReachable(on: installations) } }
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
