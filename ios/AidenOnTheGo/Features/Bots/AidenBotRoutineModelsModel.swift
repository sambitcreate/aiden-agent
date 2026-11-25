import Foundation
import Observation

protocol AidenBotRoutineModelsTransport: Sendable {
    func routineModelSettings(botId: String, routineId: String) async throws -> AidenRoutineModelSettings
    func routineModelCatalog(botId: String, routineId: String) async throws -> AidenRoutineModelCatalog
    func routineModelRuns(botId: String, routineId: String) async throws -> [AidenRoutineModelRun]
    func saveRoutineModel(_ request: AidenRoutineModelSave) async throws -> AidenRoutineModelResult
}
extension AidenRemoteClient: AidenBotRoutineModelsTransport {}

extension AidenRoutineModelAttempt: AidenDurablePendingAttempt {
    var pendingAttemptID: UUID? { request.mutationId }
    var pendingAttemptCreatedAt: Date { createdAt }
}

@MainActor @Observable
final class AidenBotRoutineModelsModel {
    let botID: String; let routineID: String
    private let transport: any AidenBotRoutineModelsTransport
    private let isCurrent: @MainActor () -> Bool; private let mayWrite: @MainActor () -> Bool
    private let store: AidenBotRoutineControlStore?; private let scope: AidenBotRoutineControlStore.Scope?
    private let storageGeneration: String?
    private var mutation: AidenDurablePendingMutation<AidenRoutineModelAttempt>
    private(set) var settings: AidenRoutineModelSettings?
    private(set) var baseline: AidenRoutineModelSettings?
    var draft: AidenRoutineModelSelection? { didSet { if !restoring { persistDraft() } } }
    private(set) var catalog: AidenRoutineModelCatalog?
    private(set) var runs: [AidenRoutineModelRun] = []
    private(set) var loading = false; private(set) var needsReview = false
    var message: String?
    @ObservationIgnored private var restoring = true
    private var generation = 0

    var pending: AidenRoutineModelAttempt? { mutation.pending }
    var busy: Bool { mutation.isInFlight }

    init(botID: String, routineID: String, transport: any AidenBotRoutineModelsTransport,
         isCurrent: @escaping @MainActor () -> Bool = { true }, mayWrite: @escaping @MainActor () -> Bool = { true },
         store: AidenBotRoutineControlStore? = nil, scope: AidenBotRoutineControlStore.Scope? = nil) {
        self.botID = botID; self.routineID = routineID; self.transport = transport; self.isCurrent = isCurrent; self.mayWrite = mayWrite
        self.store = store; self.scope = scope
        let generation = scope.flatMap { store?.generation(for: $0) }
        self.storageGeneration = generation
        var saved: AidenBotRoutineControlStore.State?
        var readFailed = false
        var readErrorMessage: String?
        if let store, let scope {
            do { saved = try store.load(scope) }
            catch { readFailed = true; readErrorMessage = "This phone couldn’t read its saved model change. Inspect the computer before making changes." }
        }
        self.mutation = AidenDurablePendingMutation(
            restoredAttempt: saved?.attempt,
            storageReadFailed: readFailed,
            storageGeneration: generation,
            currentStorageGeneration: scope.flatMap { capturedScope in
                store.map { capturedStore in { capturedStore.generation(for: capturedScope) } }
            }
        )
        if let saved { baseline = saved.baseline; draft = saved.draft }
        if let readErrorMessage { message = readErrorMessage }
        restoring = false
    }

    private var scopeIsCurrent: Bool { isCurrent() && mutation.storageIsCurrent }
    var canWrite: Bool { scopeIsCurrent && mayWrite() && mutation.canWrite }
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
        if baseline == nil { baseline = loaded; draft = loaded.selection; persistDraft() }
        else if baseline?.revision != loaded.revision { needsReview = true }
    }

    /// Explicit owner review after CAS failure; keeps the authored selection.
    func keepDraft() {
        guard canEdit, let settings else { return }
        baseline = settings; needsReview = false; persistDraft()
    }
    func useSaved() {
        guard canEdit, let settings else { return }
        baseline = settings; draft = settings.selection; needsReview = false; persistDraft()
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
        guard mutation.begin(frozen, persist: { persistStore(pending: $0) }) == .started else { return }
        await send(frozen)
    }

    func retry(now: Date = Date()) async {
        guard canWrite, !busy else { return }
        switch mutation.beginRetry(now: now) {
        case let .started(attempt):
            await send(attempt)
        case .expired:
            message = "This request is too old to replay safely. Its outcome remains unknown; inspect the computer. A new request has not been created."
        case .unavailable, .rejectedBeforeWrite, .storageBlocked:
            return
        }
    }

    private func send(_ frozen: AidenRoutineModelAttempt) async {
        let nonce = frozen.request.mutationId
        defer { mutation.abandonInFlightIfUnsettled(matching: nonce) }
        do {
            let reply = try await aidenBotWithin(.seconds(12)) { [transport] in try await transport.saveRoutineModel(frozen.request) }
            guard scopeIsCurrent, mutation.isCurrentInFlight(matching: nonce) else { return }
            if let settings = reply.settings { guard settings.botId == botID, settings.routineId == routineID else { throw AidenRemoteClientError.invalidResponse } }
            switch reply {
            case let .accepted(settings, replyNonce, _):
                guard replyNonce == nonce else { throw AidenRemoteClientError.invalidResponse }
                settle(settings, nonce: replyNonce)
            case let .rejected(code, current):
                if let current { try apply(current) }
                let resolution = mutation.resolveRejection(matching: nonce, isUncertainOutcome: code == .unavailable) { settlingID in
                    persistStore(pending: nil, settling: settlingID)
                }
                guard resolution != .superseded else { return }
                if code == .conflict { needsReview = true }
                if case .clearedDefiniteRefusal(let storageBlocked) = resolution, storageBlocked { return }
                message = resolution == .retainedUncertain
                    ? "Your computer may have saved this change. Refresh or retry the same request before making another change."
                    : "This change wasn’t saved. Your draft is kept. Refresh and review the computer’s saved version before trying again."
            }
        } catch {
            guard scopeIsCurrent else { return }
            let resolution = mutation.resolveFailure(matching: nonce, error: error) { settlingID in
                persistStore(pending: nil, settling: settlingID)
            }
            switch resolution {
            case .superseded:
                return
            case let .clearedDefiniteRefusal(storageBlocked):
                if !storageBlocked {
                    message = "This change wasn’t saved. Your draft is kept."
                }
            case .retainedUncertain:
                message = "The response was lost. Refresh or retry the same request; its exact model selection is kept."
            }
        }
    }

    private func settle(_ loaded: AidenRoutineModelSettings, nonce: UUID) {
        restoring = true
        settings = loaded; baseline = loaded; draft = loaded.selection; needsReview = false
        restoring = false
        _ = mutation.settle(matching: nonce) { settlingID in
            persistStore(pending: nil, settling: settlingID)
        }
    }

    private func persistDraft() {
        let currentPending = mutation.pending
        if persistStore(pending: currentPending) == .storageFailed {
            mutation.recordStorageFailure()
        }
    }

    private func persistStore(pending: AidenRoutineModelAttempt?, settling nonce: UUID? = nil) -> AidenDurablePendingMutation<AidenRoutineModelAttempt>.PersistOutcome {
        guard !restoring else { return .saved }
        guard let store, let scope else { return .saved }
        do {
            try store.save(.init(baseline: baseline, draft: draft, attempt: pending), scope: scope, settling: nonce, generation: storageGeneration)
            return .saved
        } catch {
            message = "This phone couldn’t safely retain the request. No new change can be sent until its saved state is recovered."
            return .storageFailed
        }
    }
}
