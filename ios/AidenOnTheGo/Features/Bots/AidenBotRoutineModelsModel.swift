import Foundation
import Observation

protocol AidenBotRoutineModelsTransport: Sendable {
    func routineModelSettings(botId: String, routineId: String) async throws -> AidenRoutineModelSettings
    func routineModelCatalog(botId: String, routineId: String) async throws -> AidenRoutineModelCatalog
    func routineModelRuns(botId: String, routineId: String) async throws -> [AidenRoutineModelRun]
    func saveRoutineModel(_ request: AidenRoutineModelSave) async throws -> AidenRoutineModelResult
}
extension AidenRemoteClient: AidenBotRoutineModelsTransport {}

@MainActor @Observable
final class AidenBotRoutineModelsModel {
    let botID: String; let routineID: String
    private let transport: any AidenBotRoutineModelsTransport
    private let isCurrent: @MainActor () -> Bool; private let mayWrite: @MainActor () -> Bool
    private let store: AidenBotRoutineControlStore?; private let scope: AidenBotRoutineControlStore.Scope?
    private let storageGeneration: String?
    private(set) var settings: AidenRoutineModelSettings?
    private(set) var baseline: AidenRoutineModelSettings?
    var draft: AidenRoutineModelSelection? { didSet { if !restoring { persist() } } }
    private(set) var catalog: AidenRoutineModelCatalog?
    private(set) var runs: [AidenRoutineModelRun] = []
    private(set) var pending: AidenRoutineModelAttempt?
    private(set) var busy = false; private(set) var loading = false; private(set) var needsReview = false
    var message: String?
    @ObservationIgnored private var restoring = true
    private var storageBlocked = false
    private var generation = 0
    init(botID: String, routineID: String, transport: any AidenBotRoutineModelsTransport,
         isCurrent: @escaping @MainActor () -> Bool = { true }, mayWrite: @escaping @MainActor () -> Bool = { true },
         store: AidenBotRoutineControlStore? = nil, scope: AidenBotRoutineControlStore.Scope? = nil) {
        self.botID = botID; self.routineID = routineID; self.transport = transport; self.isCurrent = isCurrent; self.mayWrite = mayWrite
        self.store = store; self.scope = scope
        self.storageGeneration = scope.flatMap { store?.generation(for: $0) }
        if let store, let scope {
            do { if let saved = try store.load(scope) { baseline = saved.baseline; draft = saved.draft; pending = saved.attempt } }
            catch { storageBlocked = true; message = "This phone couldn’t read its saved model change. Inspect the host before making changes." }
        }
        restoring = false
    }
    private var scopeIsCurrent: Bool {
        isCurrent() && (scope.flatMap { store?.generation(for: $0) } == storageGeneration)
    }
    var canWrite: Bool { scopeIsCurrent && mayWrite() && !storageBlocked }
    var canEdit: Bool { canWrite && settings != nil && !busy && pending == nil }
    var canSave: Bool {
        guard canEdit, !needsReview, let draft, let catalog, draft != baseline?.selection else { return false }
        return [draft.primary, draft.fallback].compactMap { $0 }.allSatisfy(catalog.admits)
    }
    /// Only called while the foreground model sheet is open. No global catalogs or credentials.
    func load() async {
        guard scopeIsCurrent else { return }
        generation += 1; let current = generation; loading = true
        defer { if generation == current { loading = false } }
        do {
            let loaded = try await transport.routineModelSettings(botId: botID, routineId: routineID)
            guard scopeIsCurrent, generation == current else { return }
            try apply(loaded)
            let recent = try await transport.routineModelRuns(botId: botID, routineId: routineID)
            guard scopeIsCurrent, generation == current else { return }
            guard recent.count <= 64, Set(recent.map(\.runId)).count == recent.count else { throw AidenRemoteClientError.invalidResponse }
            runs = recent
            if mayWrite() {
                let offered = try await transport.routineModelCatalog(botId: botID, routineId: routineID)
                guard scopeIsCurrent, mayWrite(), generation == current else { return }
                catalog = offered
            } else { catalog = nil }
        } catch { if scopeIsCurrent, generation == current { message = "Routine models couldn’t be loaded. Your draft and pending request are kept." } }
    }
    private func apply(_ loaded: AidenRoutineModelSettings) throws {
        guard loaded.botId == botID, loaded.routineId == routineID else { throw AidenRemoteClientError.invalidResponse }
        settings = loaded
        if let pending, loaded.lastMutationId == pending.request.mutationId {
            settle(loaded, nonce: pending.request.mutationId); return
        }
        if baseline == nil { baseline = loaded; draft = loaded.selection; persist() }
        else if baseline?.revision != loaded.revision { needsReview = true }
    }
    /// Explicit owner review after CAS failure; keeps the authored selection.
    func keepDraft() {
        guard canEdit, let settings else { return }
        baseline = settings; needsReview = false; persist()
    }
    func useSaved() {
        guard canEdit, let settings else { return }
        baseline = settings; draft = settings.selection; needsReview = false; persist()
    }
    func select(_ choice: AidenRoutineModelChoice, fallback: Bool) {
        guard canEdit, catalog?.admits(choice) == true else { return }
        if fallback { guard let primary = draft?.primary else { return }; draft = .selected(primary: primary, fallback: choice) }
        else { draft = .selected(primary: choice, fallback: draft?.fallback) }
    }
    func inherit() { guard canEdit else { return }; draft = .inherit }
    func clearFallback() { guard canEdit, let primary = draft?.primary else { return }; draft = .selected(primary: primary, fallback: nil) }
    func save() async {
        guard canSave, let baseline, let catalog, let draft else { return }
        let frozen = AidenRoutineModelAttempt(request: .init(botId: botID, routineId: routineID, mutationId: UUID(), expectedRevision: baseline.revision, catalogRevision: catalog.revision, selection: draft), createdAt: Date())
        pending = frozen
        guard persist() else { pending = nil; return }
        await send(frozen, previouslyUnknown: false)
    }
    func retry(now: Date = Date()) async {
        guard canWrite, !busy, let pending else { return }
        let age = now.timeIntervalSince(pending.createdAt)
        guard age >= 0, age < 23 * 3600 else { message = "This request is too old to replay safely. Its outcome remains unknown; inspect the host. A new request has not been created."; return }
        await send(pending, previouslyUnknown: true)
    }
    private func send(_ frozen: AidenRoutineModelAttempt, previouslyUnknown: Bool) async {
        guard canWrite, !busy else { return }
        busy = true; defer { busy = false }
        do {
            let reply = try await aidenBotWithin(.seconds(12)) { [transport] in try await transport.saveRoutineModel(frozen.request) }
            guard scopeIsCurrent, pending?.request.mutationId == frozen.request.mutationId else { return }
            if let settings = reply.settings { guard settings.botId == botID, settings.routineId == routineID else { throw AidenRemoteClientError.invalidResponse } }
            switch reply {
            case let .accepted(settings, nonce, _):
                guard nonce == frozen.request.mutationId else { throw AidenRemoteClientError.invalidResponse }
                settle(settings, nonce: nonce)
            case let .rejected(code, current):
                if let current { try apply(current) }
                guard pending?.request.mutationId == frozen.request.mutationId else { return }
                if code != .unavailable, !previouslyUnknown { pending = nil; persist(settling: frozen.request.mutationId) }
                if code == .conflict { needsReview = true }
                message = code == .unavailable || previouslyUnknown
                    ? "Your host may have saved this change. Refresh or retry the same request before making another change."
                    : "This change wasn’t saved. Your draft is kept. Refresh and review the host’s saved version before trying again."
            }
        } catch {
            guard scopeIsCurrent, pending?.request.mutationId == frozen.request.mutationId else { return }
            if !previouslyUnknown, !aidenBotSessionFailureIsAmbiguous(error) { pending = nil; persist(settling: frozen.request.mutationId) }
            message = pending == nil ? "This change wasn’t saved. Your draft is kept." : "The response was lost. Refresh or retry the same request; its exact model selection is kept."
        }
    }
    private func settle(_ loaded: AidenRoutineModelSettings, nonce: UUID) {
        restoring = true
        pending = nil; settings = loaded; baseline = loaded; draft = loaded.selection; needsReview = false
        restoring = false
        persist(settling: nonce)
    }
    @discardableResult private func persist(settling nonce: UUID? = nil) -> Bool {
        guard !restoring else { return true }
        guard let store, let scope else { return true }
        do { try store.save(.init(baseline: baseline, draft: draft, attempt: pending), scope: scope, settling: nonce, generation: storageGeneration); return true }
        catch { storageBlocked = true; message = "This phone couldn’t safely retain the request. No new change can be sent until its saved state is recovered."; return false }
    }
}
