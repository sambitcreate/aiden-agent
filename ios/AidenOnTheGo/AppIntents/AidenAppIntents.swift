import AppIntents
import Foundation
import Observation

struct AidenIntentInstallationRecord: Codable, Equatable, Sendable {
    let id: String
    let name: String
}

struct AidenIntentWorkspaceRecord: Codable, Equatable, Sendable {
    let id: String
    let instanceId: String
    let name: String
    /// For the Chats entry: the hidden No workspace folders it stands for, so a link or Shortcut
    /// that remembers one of them still finds Chats on a Mac that isn't the active one.
    var groupedIDs: [String]? = nil

    /// The catalog id a remembered workspace id is listed under: a hidden folder maps to Chats.
    static func listedID(for workspaceID: String, in records: [AidenIntentWorkspaceRecord]) -> String {
        records.first { $0.groupedIDs?.contains(workspaceID) == true }?.id ?? workspaceID
    }
}

struct AidenIntentCatalogSnapshot: Codable, Equatable, Sendable {
    let installations: [AidenIntentInstallationRecord]
    let workspaces: [AidenIntentWorkspaceRecord]
    let activeInstallationId: String?
}

/// App-Group cache intentionally contains display names and stable IDs only.
/// The intent process never receives endpoints, credentials, pins, permissions, or paths.
struct AidenIntentCatalogStore: @unchecked Sendable {
    static let shared = AidenIntentCatalogStore()
    private static let key = "aiden.intent-catalog.v1"
    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = nil) {
        if let defaults {
            self.defaults = defaults
        } else {
            let identifier = Bundle.main.object(forInfoDictionaryKey: "AidenAppGroupIdentifier") as? String
                ?? "group.sbtbiswas.AidenOnTheGo"
            self.defaults = UserDefaults(suiteName: identifier)
        }
    }

    func load() -> AidenIntentCatalogSnapshot {
        guard let data = defaults?.data(forKey: Self.key), data.count <= 1_048_576,
              let value = try? JSONDecoder().decode(AidenIntentCatalogSnapshot.self, from: data) else {
            return AidenIntentCatalogSnapshot(installations: [], workspaces: [], activeInstallationId: nil)
        }
        let installations = unique(value.installations.filter {
            Self.safeID($0.id) && Self.safeName($0.name)
        }, id: \.id)
        let installationIDs = Set(installations.map(\.id))
        let workspaces = uniqueWorkspaces(value.workspaces.filter {
            Self.safeID($0.id) && Self.safeID($0.instanceId)
                && Self.safeName($0.name) && installationIDs.contains($0.instanceId)
        })
        let active = value.activeInstallationId.flatMap { installationIDs.contains($0) ? $0 : nil }
        return AidenIntentCatalogSnapshot(
            installations: installations,
            workspaces: workspaces,
            activeInstallationId: active
        )
    }

    func update(
        installations: [AidenIntentInstallationRecord],
        activeInstallationId: String?,
        workspaces: [AidenIntentWorkspaceRecord],
        for instanceId: String?
    ) throws {
        let existing = load()
        let sanitizedInstallations = unique(installations.filter {
            Self.safeID($0.id) && Self.safeName($0.name)
        }, id: \.id)
        let installationIDs = Set(sanitizedInstallations.map(\.id))
        var retained = existing.workspaces.filter {
            installationIDs.contains($0.instanceId) && $0.instanceId != instanceId
        }
        retained.append(contentsOf: workspaces.filter {
            Self.safeID($0.id) && Self.safeID($0.instanceId)
                && Self.safeName($0.name) && installationIDs.contains($0.instanceId)
        })
        let snapshot = AidenIntentCatalogSnapshot(
            installations: sanitizedInstallations,
            workspaces: uniqueWorkspaces(retained),
            activeInstallationId: activeInstallationId.flatMap { installationIDs.contains($0) ? $0 : nil }
        )
        let data = try JSONEncoder().encode(snapshot)
        guard data.count <= 1_048_576 else { throw CocoaError(.fileWriteOutOfSpace) }
        defaults?.set(data, forKey: Self.key)
    }

    private func unique<Value>(_ values: [Value], id: KeyPath<Value, String>) -> [Value] {
        var seen = Set<String>()
        return values.filter { seen.insert($0[keyPath: id]).inserted }
    }

    private func uniqueWorkspaces(_ values: [AidenIntentWorkspaceRecord]) -> [AidenIntentWorkspaceRecord] {
        var seen = Set<String>()
        return values.filter { seen.insert("\($0.instanceId)\u{1F}\($0.id)").inserted }
    }

    private static func safeID(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 160
            && value.unicodeScalars.allSatisfy { scalar in
                CharacterSet.alphanumerics.contains(scalar) || "._:-".unicodeScalars.contains(scalar)
            }
    }

    private static func safeName(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.count <= 256
    }
}

struct AidenInstallationIntentEntity: AppEntity, Equatable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Aiden Installation")
    static let defaultQuery = AidenInstallationIntentQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct AidenInstallationIntentQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AidenInstallationIntentEntity] {
        let wanted = Set(identifiers)
        return AidenIntentCatalogStore.shared.load().installations
            .filter { wanted.contains($0.id) }
            .map { AidenInstallationIntentEntity(id: $0.id, name: $0.name) }
    }

    func suggestedEntities() async throws -> [AidenInstallationIntentEntity] {
        AidenIntentCatalogStore.shared.load().installations
            .map { AidenInstallationIntentEntity(id: $0.id, name: $0.name) }
    }
}

struct AidenWorkspaceIntentEntity: AppEntity, Equatable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Aiden Workspace")
    static let defaultQuery = AidenWorkspaceIntentQuery()

    let workspaceId: String
    let instanceId: String
    let name: String

    var id: String { "\(instanceId)|\(workspaceId)" }

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct AidenWorkspaceIntentQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AidenWorkspaceIntentEntity] {
        let wanted = Set(identifiers)
        return AidenIntentCatalogStore.shared.load().workspaces
            .map(Self.entity)
            .filter { wanted.contains($0.id) }
    }

    func suggestedEntities() async throws -> [AidenWorkspaceIntentEntity] {
        let snapshot = AidenIntentCatalogStore.shared.load()
        return snapshot.workspaces
            .filter { snapshot.activeInstallationId == nil || $0.instanceId == snapshot.activeInstallationId }
            .map(Self.entity)
    }

    private static func entity(_ value: AidenIntentWorkspaceRecord) -> AidenWorkspaceIntentEntity {
        AidenWorkspaceIntentEntity(workspaceId: value.id, instanceId: value.instanceId, name: value.name)
    }
}

/// In-process delivery survives a cold foreground launch before ContentView mounts.
/// Nothing in a URL, App Group, saved state, or notification can claim this provenance.
@MainActor @Observable
final class AidenForegroundIntentRouter {
    struct Action: Equatable {
        let id = UUID()
        let instanceID: String?
        let workspaceID: String?
        let startsVoice: Bool
        let createdAt: Date
    }

    /// A place waiting for the tab shell. `startsVoice` rides beside the route,
    /// because routes are saved between launches and this must never be.
    struct QueuedRoute: Equatable {
        let route: AidenAppRoute
        let startsVoice: Bool
    }

    static let shared = AidenForegroundIntentRouter()
    private(set) var actions: [Action] = []
    /// Kept until the shell takes them, so a tap or an intent can arrive before
    /// it mounts. The tab shell is the only reader.
    private(set) var routes: [QueuedRoute] = []
    var pending: Action? { actions.first }

    /// False keeps the shipping rule: one intent at a time, and any other
    /// arriving meanwhile is ignored.
    @ObservationIgnored private let queuesActions: Bool
    @ObservationIgnored private var isOpeningChats = false

    init(queuesActions: Bool = AppConfig.tabShellEnabled) {
        self.queuesActions = queuesActions
    }

    func submit(instanceID: String?, workspaceID: String?, startsVoice: Bool, now: Date = Date()) {
        guard queuesActions || actions.isEmpty else { return }
        actions.append(Action(instanceID: instanceID, workspaceID: workspaceID, startsVoice: startsVoice, createdAt: now))
    }

    func take(now: Date = Date()) -> Action? {
        guard !actions.isEmpty else { return nil }
        let action = actions.removeFirst()
        return Self.isFresh(action, now: now) ? action : nil
    }

    /// For what ends an intent's claim on the foreground. Routes stay: they only
    /// say where to go, and a tap is still owed its screen.
    func discardActions() {
        actions = []
    }

    func submit(route: AidenAppRoute, startsVoice: Bool = false) {
        routes.append(QueuedRoute(route: route, startsVoice: startsVoice))
    }

    /// Empties the queue, so each route reaches exactly one shell. A route whose
    /// machine left or was revoked while it waited is dropped here.
    func takeRoutes(openableOn coordinator: AidenRemoteCoordinator) -> [QueuedRoute] {
        defer { routes = [] }
        return routes.filter { coordinator.canOpen($0.route) }
    }

    /// Leaves nothing behind for a machine that's gone.
    func dropUnopenable(on coordinator: AidenRemoteCoordinator) {
        routes.removeAll { !coordinator.canOpen($0.route) }
        actions.removeAll { machine(for: $0, on: coordinator) == nil }
    }

    /// The tab shell's way through the queue. Each chat is created on the
    /// intent's own machine, one at a time and in order, and leaves a route.
    /// The selection never moves. An intent whose machine is still connecting
    /// stays queued and holds up nobody else.
    func openWaitingChats(
        coordinator: AidenRemoteCoordinator,
        isForeground: @MainActor () -> Bool = { AidenRunAlertNotifier.currentAppState() == .active },
        now: @MainActor () -> Date = { Date() }
    ) async {
        guard !isOpeningChats else { return }
        isOpeningChats = true
        defer { isOpeningChats = false }
        while isForeground(), let (action, connection) = nextReadyAction(on: coordinator, now: now()) {
            await openChat(for: action, on: connection, coordinator: coordinator, isForeground: isForeground)
        }
    }

    private func nextReadyAction(
        on coordinator: AidenRemoteCoordinator,
        now: Date
    ) -> (Action, AidenHostConnection)? {
        actions.removeAll { !Self.isFresh($0, now: now) || machine(for: $0, on: coordinator) == nil }
        for (index, action) in actions.enumerated() {
            if let connection = machine(for: action, on: coordinator), connection.connectionState == .connected {
                actions.remove(at: index)
                return (action, connection)
            }
        }
        return nil
    }

    /// Nil once the intent's machine has been forgotten or revoked.
    private func machine(for action: Action, on coordinator: AidenRemoteCoordinator) -> AidenHostConnection? {
        guard let instanceID = action.instanceID ?? coordinator.activeInstanceId,
              let connection = coordinator.hosts.connection(for: instanceID),
              !connection.isRevoked else { return nil }
        return connection
    }

    private func openChat(
        for action: Action,
        on connection: AidenHostConnection,
        coordinator: AidenRemoteCoordinator,
        isForeground: @MainActor () -> Bool
    ) async {
        guard connection.installation.hasNegotiatedAccess(to: .chatWrite),
              let owner = try? coordinator.ownerContext(for: connection.instanceId) else { return }
        guard let workspace = Self.workspace(for: action, on: connection, coordinator: coordinator) else {
            coordinator.presentedError = String(localized: "Open this installation and choose an available workspace before starting a chat.")
            return
        }
        do {
            let chat = try await coordinator.remoteClient(for: owner)
                .createChat(workspaceId: workspace.id, noWorkspace: workspace.noWorkspace)
            guard coordinator.isLive(owner), !chat.isBotChat,
                  chat.workspaceId == workspace.id || workspace.noWorkspace else { return }
            // The chat exists either way, but the microphone only opens in front of the person.
            submit(
                route: .chat(AidenHostObjectID(instanceId: owner.instanceId, deviceId: owner.deviceId, objectId: chat.id)),
                startsVoice: action.startsVoice && isForeground()
            )
        } catch where aidenIsCancellation(error) {
            return
        } catch {
            if await coordinator.handleCredentialRevocation(error, context: owner) { return }
            // A mutation is never retried after an uncertain result.
            if coordinator.isLive(owner) { coordinator.presentedError = error.localizedDescription }
        }
    }

    /// The workspace the intent named, else the one last used on that machine,
    /// else its first. A chat's own hidden folder is listed under the Chats home.
    private static func workspace(
        for action: Action,
        on connection: AidenHostConnection,
        coordinator: AidenRemoteCoordinator
    ) -> AidenWorkspace? {
        let instanceID = connection.instanceId
        let archived = coordinator.workspaceArchiveStore.archivedWorkspaceIDs(for: instanceID)
        let available = AidenNoWorkspace.grouped(connection.workspaces).filter { !archived.contains($0.id) }
        let selected = (action.workspaceID ?? AidenProductNavigationStore.shared.selectedWorkspace(for: instanceID))
            .map { AidenNoWorkspace.groupID(for: $0, in: connection.workspaces) }
        return selected.flatMap { id in available.first { $0.id == id } }
            ?? (action.workspaceID == nil ? available.first : nil)
    }

    private static func isFresh(_ action: Action, now: Date) -> Bool {
        (0..<60).contains(now.timeIntervalSince(action.createdAt))
    }
}

struct NewChatIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat"
    static let description = IntentDescription("Open Aiden On The Go on a new chat.")
    static var openAppWhenRun: Bool { true }

    @MainActor func perform() async throws -> some IntentResult {
        AidenForegroundIntentRouter.shared.submit(instanceID: AidenIntentCatalogStore.shared.load().activeInstallationId,
            workspaceID: nil, startsVoice: false)
        return .result()
    }
}

struct NewChatVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat with Voice"
    static let description = IntentDescription("Open a new Aiden chat and start your selected dictation mode.")
    static var openAppWhenRun: Bool { true }

    @MainActor func perform() async throws -> some IntentResult {
        AidenForegroundIntentRouter.shared.submit(instanceID: AidenIntentCatalogStore.shared.load().activeInstallationId,
            workspaceID: nil, startsVoice: true)
        return .result()
    }
}

struct NewChatInWorkspaceIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat in Workspace"
    static let description = IntentDescription("Open a new chat in a cached Aiden workspace.")
    static var openAppWhenRun: Bool { true }
    @Parameter(title: "Workspace") var workspace: AidenWorkspaceIntentEntity
    static var parameterSummary: some ParameterSummary { Summary("New chat in \(\.$workspace)") }

    @MainActor func perform() async throws -> some IntentResult {
        AidenForegroundIntentRouter.shared.submit(instanceID: workspace.instanceId, workspaceID: workspace.workspaceId,
            startsVoice: false)
        return .result()
    }
}

enum AidenIntentError: Error { case invalidDestination }

struct AidenShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: NewChatIntent(),
            phrases: ["New chat in \(.applicationName)", "Start a new \(.applicationName) chat"],
            shortTitle: "New Chat",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: NewChatVoiceIntent(),
            phrases: ["New voice chat in \(.applicationName)", "Start voice in \(.applicationName)"],
            shortTitle: "New Chat with Voice",
            systemImageName: "mic.badge.plus"
        )
        AppShortcut(
            intent: NewChatInWorkspaceIntent(),
            phrases: ["New \(.applicationName) chat in \(\.$workspace)"],
            shortTitle: "Chat in Workspace",
            systemImageName: "folder.badge.plus"
        )
    }
}
