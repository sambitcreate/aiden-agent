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
    static let shared = AidenBotRoutineControlStore()
    let root: URL
    private var epochs: [String: UInt] = [:]
    func generation(for scope: Scope) -> String { "\(epochs[scope.instanceID, default: 0]):\(epochs[scope.instanceID + "|" + scope.deviceID + "|" + scope.botID, default: 0])" }
    init(root: URL? = nil) {
        self.root = root ?? AidenBotJournal.appSupportDirectory("AidenOnTheGo/RoutineControls-v1")
        prepareExistingStorage()
    }
    func prepareExistingStorage() { AidenBotJournal.prepareExistingStorage(root) }
    func load(_ scope: Scope) throws -> State? {
        guard let state: State = try AidenBotJournal.read(fileURL(scope), scope: scope, maximumBytes: 128 * 1024) else { return nil }
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
        try AidenBotJournal.write(state, scope: scope, to: fileURL(scope), maximumBytes: 128 * 1024, root: root)
    }
    func purge(instanceID: String) { epochs[instanceID, default: 0] += 1; try? FileManager.default.removeItem(at: root.appending(path: AidenBotJournal.digest(instanceID))) }
    func purge(instanceID: String, deviceID: String, botID: String) {
        epochs[instanceID + "|" + deviceID + "|" + botID, default: 0] += 1
        try? FileManager.default.removeItem(at: root.appending(path: AidenBotJournal.digest(instanceID)).appending(path: AidenBotJournal.digest(deviceID + "|" + botID)))
    }
    func fileURL(_ scope: Scope) -> URL {
        root.appending(path: AidenBotJournal.digest(scope.instanceID), directoryHint: .isDirectory)
            .appending(path: AidenBotJournal.digest(scope.deviceID + "|" + scope.botID), directoryHint: .isDirectory)
            .appending(path: AidenBotJournal.digest(scope.routineID ?? "__resume") + ".json")
    }
}

enum AidenBotJournal {
    private struct Envelope<Scope: Codable, State: Codable>: Codable {
        let version: Int
        let scope: Scope
        let state: State
    }

    static func appSupportDirectory(_ relativePath: String, fileManager: FileManager = .default) -> URL {
        (fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory)
            .appending(path: relativePath, directoryHint: .isDirectory)
    }

    static func prepareExistingStorage(_ root: URL, fileManager: FileManager = .default) {
        guard fileManager.fileExists(atPath: root.path) else { return }
        do { try prepare(root, fileManager: fileManager) }
        catch { AidenDiagnostics.record(.cache, event: .cacheFailed, outcome: .failed, code: .unknown) }
    }

    static func read<Scope: Codable & Equatable, State: Codable>(
        _ url: URL,
        scope: Scope,
        maximumBytes: Int,
        fileManager: FileManager = .default
    ) throws -> State? {
        guard fileManager.fileExists(atPath: url.path) else { return nil }
        guard let bytes = try fileManager.attributesOfItem(atPath: url.path)[.size] as? NSNumber,
              bytes.intValue <= maximumBytes else {
            throw AidenRemoteContractError.payloadTooLarge
        }
        let envelope = try JSONDecoder().decode(Envelope<Scope, State>.self, from: Data(contentsOf: url))
        guard envelope.version == 1, envelope.scope == scope else {
            throw AidenRemoteClientError.invalidResponse
        }
        return envelope.state
    }

    static func write<Scope: Codable, State: Codable>(
        _ state: State?,
        scope: Scope,
        to url: URL,
        maximumBytes: Int,
        root: URL,
        fileManager: FileManager = .default
    ) throws {
        guard let state else {
            if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
            return
        }
        let data = try JSONEncoder().encode(Envelope(version: 1, scope: scope, state: state))
        guard data.count <= maximumBytes else { throw AidenRemoteContractError.payloadTooLarge }
        try prepare(root, fileManager: fileManager)
        try prepare(url.deletingLastPathComponent(), fileManager: fileManager)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func prepare(_ url: URL, fileManager: FileManager = .default) throws {
        let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true, attributes: attributes)
        try fileManager.setAttributes(attributes, ofItemAtPath: url.path)
        var excluded = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }

    static func digest(_ value: String) -> String {
        aidenSHA256Hex(value)
    }
}
