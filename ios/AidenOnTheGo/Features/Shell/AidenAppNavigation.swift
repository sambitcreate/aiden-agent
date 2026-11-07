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

    init(
        tab: AidenAppTab = .inbox,
        inboxPath: [AidenAppRoute] = [],
        botsPath: [AidenAppRoute] = [],
        workspacesPath: [AidenAppRoute] = []
    ) {
        self.tab = tab
        self.inboxPath = inboxPath
        self.botsPath = botsPath
        self.workspacesPath = workspacesPath
    }

    /// Read per field: a tab or route only a later build knows costs that one
    /// value, not the whole snapshot.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tab = (try? container.decode(AidenAppTab.self, forKey: .tab)) ?? .inbox
        inboxPath = (try? container.decode([AidenAppRoute].self, forKey: .inboxPath)) ?? []
        botsPath = (try? container.decode([AidenAppRoute].self, forKey: .botsPath)) ?? []
        workspacesPath = (try? container.decode([AidenAppRoute].self, forKey: .workspacesPath)) ?? []
    }
}

struct AidenAppNavigationStore {
    static let snapshotKey = "aiden.app-navigation.v1"
    private static let sizeLimit = 1_048_576

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> AidenAppNavigationSnapshot {
        guard let data = defaults.data(forKey: Self.snapshotKey),
              data.count <= Self.sizeLimit,
              let snapshot = try? JSONDecoder().decode(AidenAppNavigationSnapshot.self, from: data) else {
            return AidenAppNavigationSnapshot()
        }
        return snapshot
    }

    func save(_ snapshot: AidenAppNavigationSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot), data.count <= Self.sizeLimit else { return }
        defaults.set(data, forKey: Self.snapshotKey)
    }
}

/// Which tab is showing and what each tab has pushed. Search has no path.
@MainActor @Observable
final class AidenAppNavigation {
    var tab: AidenAppTab
    var inboxPath: [AidenAppRoute]
    var botsPath: [AidenAppRoute]
    var workspacesPath: [AidenAppRoute]

    /// Not saved: a relaunch must not open the microphone.
    private(set) var chatStartingVoice: AidenHostObjectID?

    init() {
        tab = .inbox
        inboxPath = []
        botsPath = []
        workspacesPath = []
    }

    init(restoring snapshot: AidenAppNavigationSnapshot, installations: [AidenInstallation]) {
        tab = snapshot.tab
        inboxPath = snapshot.inboxPath
        botsPath = snapshot.botsPath
        workspacesPath = snapshot.workspacesPath
        dropRoutes(outside: installations)
    }

    var snapshot: AidenAppNavigationSnapshot {
        AidenAppNavigationSnapshot(
            tab: tab,
            inboxPath: inboxPath,
            botsPath: botsPath,
            workspacesPath: workspacesPath
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
    }

    private static func show(_ route: AidenAppRoute, on path: inout [AidenAppRoute]) {
        if let index = path.firstIndex(of: route) {
            path.removeSubrange(path.index(after: index)...)
        } else {
            path.append(route)
        }
    }
}
