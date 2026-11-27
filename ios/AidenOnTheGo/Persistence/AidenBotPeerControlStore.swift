import Foundation

struct AidenPeerAttempt: Codable, Equatable, Sendable {
    var mutation: AidenPeerMutation? = nil; var stop: AidenPeerStopMutation? = nil; let createdAt: Date
    var nonce: UUID? { mutation?.mutationId ?? stop?.mutationId }
    func validate(botID: String, exchangeID: String?) throws {
        guard (mutation != nil) != (stop != nil), createdAt.timeIntervalSince1970.isFinite else { throw AidenRemoteClientError.invalidResponse }
        if let mutation { try mutation.validate(); guard mutation.botId == botID, exchangeID == nil else { throw AidenRemoteClientError.invalidResponse } }
        if let stop { try stop.validate(); guard stop.botId == botID, stop.exchangeId == exchangeID else { throw AidenRemoteClientError.invalidResponse } }
    }
}

/// Protected, backup-excluded journal shared by windows; frozen before transport.
@MainActor
final class AidenBotPeerControlStore {
    struct Scope: Codable, Equatable {
        let instanceID: String; let deviceID: String; let botID: String; var exchangeID: String? = nil
    }
    struct State: Codable, Equatable {
        var baseline: AidenPeerSettings? = nil
        var draft: String? = nil
        var attempt: AidenPeerAttempt? = nil
        var nonce: UUID? { attempt?.nonce }
    }
    static let shared = AidenBotPeerControlStore()
    let root: URL
    private var epochs: [String: UInt] = [:]
    func generation(for scope: Scope) -> String { "\(epochs[scope.instanceID, default: 0]):\(epochs[scope.instanceID + "|" + scope.deviceID + "|" + scope.botID, default: 0])" }
    init(root: URL? = nil) {
        self.root = root ?? AidenBotJournal.appSupportDirectory("AidenOnTheGo/PeerControls-v1")
        prepareExistingStorage()
    }
    func prepareExistingStorage() { AidenBotJournal.prepareExistingStorage(root) }
    func load(_ scope: Scope) throws -> State? {
        guard let state: State = try AidenBotJournal.read(fileURL(scope), scope: scope, maximumBytes: 1024 * 1024) else { return nil }
        try validate(state, scope: scope)
        return state
    }
    private func validate(_ state: State, scope: Scope) throws {
        try state.attempt?.validate(botID: scope.botID, exchangeID: scope.exchangeID)
        if scope.exchangeID != nil {
            guard state.baseline == nil, state.draft == nil else { throw AidenRemoteClientError.invalidResponse }
        } else {
            guard (state.baseline == nil) == (state.draft == nil), state.baseline == nil || state.baseline?.botId == scope.botID else { throw AidenRemoteClientError.invalidResponse }
            if let draft = state.draft { try AidenPeerWire.text(draft, scalars: 1000, bytes: 2048, empty: true) }
        }
    }
    func save(_ state: State?, scope: Scope, settling nonce: UUID? = nil, generation expected: String? = nil) throws {
        guard expected == nil || expected == generation(for: scope) else { throw AidenRemoteClientError.invalidResponse }
        if let existing = try load(scope), let old = existing.nonce, existing.attempt != state?.attempt, old != nonce {
            throw AidenRemoteClientError.invalidResponse
        }
        if let state { try validate(state, scope: scope) }
        try AidenBotJournal.write(state, scope: scope, to: fileURL(scope), maximumBytes: 1024 * 1024, root: root)
    }
    func purge(instanceID: String) { epochs[instanceID, default: 0] += 1; try? FileManager.default.removeItem(at: root.appending(path: AidenBotJournal.digest(instanceID))) }
    func purge(instanceID: String, deviceID: String, botID: String) {
        epochs[instanceID + "|" + deviceID + "|" + botID, default: 0] += 1
        try? FileManager.default.removeItem(at: root.appending(path: AidenBotJournal.digest(instanceID)).appending(path: AidenBotJournal.digest(deviceID + "|" + botID)))
    }
    func fileURL(_ scope: Scope) -> URL {
        root.appending(path: AidenBotJournal.digest(scope.instanceID), directoryHint: .isDirectory)
            .appending(path: AidenBotJournal.digest(scope.deviceID + "|" + scope.botID), directoryHint: .isDirectory)
            .appending(path: AidenBotJournal.digest(scope.exchangeID.map { "exchange:" + $0 } ?? "settings") + ".json")
    }
}
