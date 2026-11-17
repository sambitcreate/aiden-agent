import CryptoKit
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
    private struct Envelope: Codable { let version: Int; let scope: Scope; let state: State }
    static let shared = AidenBotPeerControlStore()
    let root: URL
    private var epochs: [String: UInt] = [:]
    func generation(for scope: Scope) -> String { "\(epochs[scope.instanceID, default: 0]):\(epochs[scope.instanceID + "|" + scope.deviceID + "|" + scope.botID, default: 0])" }
    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "AidenOnTheGo/PeerControls-v1", directoryHint: .isDirectory)
        prepareExistingStorage()
    }
    func prepareExistingStorage() {
        guard FileManager.default.fileExists(atPath: root.path) else { return }
        do { try prepare(root) } catch { AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown) }
    }
    func load(_ scope: Scope) throws -> State? {
        let url = fileURL(scope)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let bytes = try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber,
              bytes.intValue <= 1024 * 1024 else { throw AidenRemoteContractError.payloadTooLarge }
        let e = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
        guard e.version == 1, e.scope == scope else { throw AidenRemoteClientError.invalidResponse }
        try validate(e.state, scope: scope)
        return e.state
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
        let url = fileURL(scope)
        guard let state else {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            return
        }
        try validate(state, scope: scope)
        let data = try JSONEncoder().encode(Envelope(version: 1, scope: scope, state: state))
        guard data.count <= 1024 * 1024 else { throw AidenRemoteContractError.payloadTooLarge }
        try prepare(root); try prepare(url.deletingLastPathComponent())
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func purge(instanceID: String) { epochs[instanceID, default: 0] += 1; try? FileManager.default.removeItem(at: root.appending(path: digest(instanceID))) }
    func purge(instanceID: String, deviceID: String, botID: String) {
        epochs[instanceID + "|" + deviceID + "|" + botID, default: 0] += 1
        try? FileManager.default.removeItem(at: root.appending(path: digest(instanceID)).appending(path: digest(deviceID + "|" + botID)))
    }
    func fileURL(_ scope: Scope) -> URL {
        root.appending(path: digest(scope.instanceID), directoryHint: .isDirectory)
            .appending(path: digest(scope.deviceID + "|" + scope.botID), directoryHint: .isDirectory)
            .appending(path: digest(scope.exchangeID.map { "exchange:" + $0 } ?? "settings") + ".json")
    }
    private func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func prepare(_ url: URL) throws {
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: attributes)
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
        var url = url; var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
    }
}
