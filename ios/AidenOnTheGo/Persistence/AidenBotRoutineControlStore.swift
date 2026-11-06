import CryptoKit
import Foundation

struct AidenRoutineModelAttempt: Codable, Equatable, Sendable { let request: AidenRoutineModelSave; let createdAt: Date }
struct AidenBotResumeAttempt: Codable, Equatable, Sendable { let key: UUID; let acknowledgeUnknownCost: Bool; let createdAt: Date; var expectedSubmissionId: String? = nil; var expectedCostReceiptId: String? = nil }

/// Protected, backup-excluded journal shared by windows; frozen before transport.
@MainActor
final class AidenBotRoutineControlStore {
    struct Scope: Codable, Equatable {
        let instanceID: String; let deviceID: String; let botID: String; var routineID: String? = nil
    }
    struct State: Codable, Equatable {
        var baseline: AidenRoutineModelSettings?
        var draft: AidenRoutineModelSelection?
        var attempt: AidenRoutineModelAttempt?
        var resume: AidenBotResumeAttempt?
        var nonce: UUID? { attempt?.request.mutationId ?? resume?.key }
    }
    private struct Envelope: Codable { let version: Int; let scope: Scope; let state: State }
    static let shared = AidenBotRoutineControlStore()
    let root: URL
    private var epochs: [String: UInt] = [:]
    func generation(for scope: Scope) -> String { "\(epochs[scope.instanceID, default: 0]):\(epochs[scope.instanceID + "|" + scope.deviceID + "|" + scope.botID, default: 0])" }
    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appending(path: "AidenOnTheGo/RoutineControls-v1", directoryHint: .isDirectory)
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
              bytes.intValue <= 128 * 1024 else { throw AidenRemoteContractError.payloadTooLarge }
        let e = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: url))
        guard e.version == 1, e.scope == scope else { throw AidenRemoteClientError.invalidResponse }
        let state = e.state
        if let routineID = scope.routineID {
            guard state.resume == nil, (state.baseline == nil) == (state.draft == nil) else { throw AidenRemoteClientError.invalidResponse }
            if let baseline = state.baseline { guard baseline.botId == scope.botID, baseline.routineId == routineID else { throw AidenRemoteClientError.invalidResponse } }
            try state.draft?.validate()
            if let attempt = state.attempt {
                try attempt.request.validate()
                guard attempt.request.botId == scope.botID, attempt.request.routineId == routineID else { throw AidenRemoteClientError.invalidResponse }
            }
        } else {
            guard state.baseline == nil, state.draft == nil, state.attempt == nil, let resume = state.resume else { throw AidenRemoteClientError.invalidResponse }
            _ = try AidenOpenWorkWire.uuid(resume.key.uuidString)
            try AidenBotResumeRequest(acknowledgeUnknownCost: resume.acknowledgeUnknownCost, expectedSubmissionId: resume.expectedSubmissionId, expectedCostReceiptId: resume.expectedCostReceiptId).validate()
        }
        return state
    }
    func save(_ state: State?, scope: Scope, settling nonce: UUID? = nil, generation expected: String? = nil) throws {
        guard expected == nil || expected == generation(for: scope) else { throw AidenRemoteClientError.invalidResponse }
        if let existing = try load(scope), let old = existing.nonce, existing != state, old != nonce {
            throw AidenRemoteClientError.invalidResponse
        }
        let url = fileURL(scope)
        guard let state else {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            return
        }
        let data = try JSONEncoder().encode(Envelope(version: 1, scope: scope, state: state))
        guard data.count <= 128 * 1024 else { throw AidenRemoteContractError.payloadTooLarge }
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
            .appending(path: digest(scope.routineID ?? "__resume") + ".json")
    }
    private func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func prepare(_ url: URL) throws {
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: attributes)
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
        var url = url; var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
    }
}
