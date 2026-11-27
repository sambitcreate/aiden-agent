import Foundation

/// Protected device-only drafts and exact unresolved commands. The scope is
/// the host, paired device and Bot, never a display name or connector identity.
@MainActor
final class AidenBotOpenWorkDraftStore {
    struct Scope: Codable, Equatable {
        let instanceID: String
        let deviceID: String
        let botID: String
    }
    struct State: Codable {
        var draft: AidenOpenWorkDraft?
        var baseline: AidenOpenWorkItem?
        var draftRevision: String?
        var attempt: AidenOpenWorkAttempt?
    }

    static let shared = AidenBotOpenWorkDraftStore()
    let root: URL
    private let fileManager: FileManager
    private let maximumBytes = 128 * 1024

    init(root: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        self.root = root ?? AidenBotJournal.appSupportDirectory("AidenOnTheGo/OpenWorkDrafts-v1", fileManager: fileManager)
        prepareExistingStorage()
    }

    /// Called on every launch, even if no Open work page opens.
    func prepareExistingStorage() {
        AidenBotJournal.prepareExistingStorage(root, fileManager: fileManager)
    }

    func load(_ scope: Scope) throws -> State? {
        guard let state: State = try AidenBotJournal.read(
            fileURL(scope),
            scope: scope,
            maximumBytes: maximumBytes,
            fileManager: fileManager
        ) else { return nil }
        guard (state.draft == nil) == (state.draftRevision == nil) else {
            throw AidenRemoteClientError.invalidResponse
        }
        if let revision = state.draftRevision { try AidenOpenWorkWire.id(revision) }
        if let attempt = state.attempt {
            try attempt.mutation.validate()
            if let itemID = attempt.itemID { try AidenOpenWorkWire.id(itemID) }
            guard attempt.mutation.id == nil || attempt.mutation.id == attempt.itemID else { throw AidenRemoteClientError.invalidResponse }
        }
        return state
    }

    func save(_ state: State, scope: Scope, settling mutationID: UUID? = nil) throws {
        if let existing = try load(scope)?.attempt, existing != state.attempt,
           existing.mutation.mutationId != mutationID {
            // A second window cannot overwrite another window’s unresolved command.
            throw AidenRemoteClientError.invalidResponse
        }
        let toWrite: State? = (state.draft == nil && state.attempt == nil) ? nil : state
        try AidenBotJournal.write(
            toWrite,
            scope: scope,
            to: fileURL(scope),
            maximumBytes: maximumBytes,
            root: root,
            fileManager: fileManager
        )
    }

    func purge(instanceID: String) {
        try? fileManager.removeItem(at: root.appending(path: AidenBotJournal.digest(instanceID), directoryHint: .isDirectory))
    }

    func fileURL(_ scope: Scope) -> URL {
        root.appending(path: AidenBotJournal.digest(scope.instanceID), directoryHint: .isDirectory)
            .appending(path: "\(AidenBotJournal.digest(scope.deviceID + "|" + scope.botID)).json")
    }
}
