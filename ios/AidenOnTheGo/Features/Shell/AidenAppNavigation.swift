import Foundation
import Observation

enum AidenAppTab: String, Codable, CaseIterable, Hashable {
    case inbox, bots, workspaces, search
}

enum AidenAppRoute: Hashable, Codable {
    case chat(AidenHostObjectID), bot(AidenHostObjectID), workspace(AidenHostObjectID)
    case machines, machine(instanceId: String), settings, scheduled, usage

    /// The tab whose stack holds this route.
    var tab: AidenAppTab {
        switch self {
        case .chat, .machines, .machine, .settings, .scheduled, .usage: .inbox
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
        case .machines, .settings, .scheduled, .usage: nil
        }
    }

    /// False for a route to a machine that's gone, or to an older pairing of it.
    func isReachable(on installations: [AidenInstallation]) -> Bool {
        switch self {
        case .chat(let id), .bot(let id), .workspace(let id):
            installations.contains { $0.id == id.instanceId && $0.deviceId == id.deviceId }
        case .machine(let instanceId):
            installations.contains { $0.id == instanceId }
        case .machines, .settings, .scheduled, .usage:
            true
        }
    }

    /// True for a route to something on this machine.
    fileprivate func belongs(to instanceId: String) -> Bool {
        switch self {
        case .chat(let id), .bot(let id), .workspace(let id): id.instanceId == instanceId
        case .machine(let id): id == instanceId
        case .machines, .settings, .scheduled, .usage: false
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
    var inboxPath: [AidenAppRoute]
    var botsPath: [AidenAppRoute]
    var workspacesPath: [AidenAppRoute]
    private var savedPaths: [String: [AidenAppRoute]]

    /// Not saved: a relaunch must not open the microphone.
    private(set) var chatStartingVoice: AidenHostObjectID?

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
            inboxPath: inboxPath,
            botsPath: botsPath,
            workspacesPath: workspacesPath,
            savedPaths: savedPaths
        )
    }

    /// Selects the route's tab and shows the route there. A route already on
    /// that path is gone back to, so one chat never has two screens.
    /// `startsVoice` is a voice intent's: the chat starts listening when it opens.
    func open(_ route: AidenAppRoute, startsVoice: Bool = false) {
        chatStartingVoice = nil
        if startsVoice, case .chat(let id) = route {
            chatStartingVoice = id
        }
        tab = route.tab
        switch route.tab {
        case .inbox: Self.show(route, on: &inboxPath)
        case .bots: Self.show(route, on: &botsPath)
        case .workspaces: Self.show(route, on: &workspacesPath)
        case .search: break
        }
    }

    func finishStartingVoice(_ id: AidenHostObjectID) {
        if chatStartingVoice == id { chatStartingVoice = nil }
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

    private static func show(_ route: AidenAppRoute, on path: inout [AidenAppRoute]) {
        if let index = path.firstIndex(of: route) {
            path.removeSubrange(path.index(after: index)...)
        } else {
            path.append(route)
        }
    }
}
