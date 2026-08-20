import AppIntents
import Foundation

struct AidenIntentInstallationRecord: Codable, Equatable, Sendable {
    let id: String
    let name: String
}

struct AidenIntentWorkspaceRecord: Codable, Equatable, Sendable {
    let id: String
    let instanceId: String
    let name: String
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

struct NewChatIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat"
    static let description = IntentDescription("Open Aiden On The Go on a new chat.")

    func perform() async throws -> some IntentResult & OpensIntent {
        guard let url = AidenDeepLink.newChatURL else { throw AidenIntentError.invalidDestination }
        return .result(opensIntent: OpenURLIntent(url))
    }
}

struct NewChatVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat with Voice"
    static let description = IntentDescription("Open a new Aiden chat and start on-device dictation.")

    func perform() async throws -> some IntentResult & OpensIntent {
        guard let url = AidenDeepLink.newChatVoiceURL else { throw AidenIntentError.invalidDestination }
        return .result(opensIntent: OpenURLIntent(url))
    }
}

struct NewChatInWorkspaceIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat in Workspace"
    static let description = IntentDescription("Open a new chat in a cached Aiden workspace.")

    @Parameter(title: "Workspace") var workspace: AidenWorkspaceIntentEntity

    static var parameterSummary: some ParameterSummary {
        Summary("New chat in \(\.$workspace)")
    }

    func perform() async throws -> some IntentResult & OpensIntent {
        guard let url = AidenDeepLink.newChatURL(
            instanceId: workspace.instanceId,
            workspaceId: workspace.workspaceId,
            startsVoice: false
        ) else { throw AidenIntentError.invalidDestination }
        return .result(opensIntent: OpenURLIntent(url))
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
