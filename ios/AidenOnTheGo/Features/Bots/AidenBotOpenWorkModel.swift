import Foundation
import Observation

protocol AidenBotOpenWorkTransport: Sendable {
    func botOpenWork(botId: String) async throws -> AidenOpenWorkSnapshot
    func mutateBotOpenWork(botId: String, mutation: AidenOpenWorkMutation) async throws -> AidenOpenWorkResult
    func botOpenWorkEvidence(botId: String, itemId: String, kind: AidenOpenWorkEvidenceKind) async throws -> AidenOpenWorkEvidence
}
extension AidenRemoteClient: AidenBotOpenWorkTransport {}

struct AidenOpenWorkDraft: Codable, Equatable {
    var title = ""
    var note = ""
    var state: AidenOpenWorkState = .open
    var waitingReason = ""
    init() {}
    init(item: AidenOpenWorkItem) {
        title = item.title; note = item.note; state = item.state; waitingReason = item.waitingReason ?? ""
    }
    var patch: AidenOpenWorkPatch {
        .init(title: title.trimmingCharacters(in: .whitespacesAndNewlines), note: note, state: state,
              waitingReason: state == .waiting ? waitingReason.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
    }
    var valid: Bool { (try? patch.validate()) != nil }
}

struct AidenOpenWorkAttempt: Codable, Equatable {
    let mutation: AidenOpenWorkMutation
    let itemID: String?
    let consumesDraft: Bool
    let createdAt: Date
}

extension AidenOpenWorkAttempt: AidenDurablePendingAttempt {
    var pendingAttemptID: UUID? { mutation.mutationId }
    var pendingAttemptCreatedAt: Date { createdAt }
}

@MainActor
@Observable
final class AidenBotOpenWorkModel {
    let botID: String
    private let transport: any AidenBotOpenWorkTransport
    private let isCurrent: @MainActor () -> Bool
    private let mayWrite: @MainActor () -> Bool
    private let store: AidenBotOpenWorkDraftStore?
    private let scope: AidenBotOpenWorkDraftStore.Scope?
    private var mutation: AidenDurablePendingMutation<AidenOpenWorkAttempt>
    private(set) var snapshot: AidenOpenWorkSnapshot?
    private(set) var isLoading = false
    private var isSending = false
    private(set) var loadError: String?
    var message: String?
    var draft: AidenOpenWorkDraft? { didSet { persistDraft() } }
    private(set) var baseline: AidenOpenWorkItem?
    private(set) var draftRevision: String?
    private(set) var conflict: AidenOpenWorkItem?
    private(set) var wasRemoved = false
    private(set) var addNeedsReview = false
    private(set) var evidence: AidenOpenWorkEvidence?
    private(set) var evidenceError: String?
    private(set) var isLoadingEvidence = false
    @ObservationIgnored private var isRestoring = true
    private var loadGeneration = 0
    private var evidenceGeneration = 0

    var isBusy: Bool { isSending || mutation.isInFlight }
    var uncertain: Bool { mutation.isUncertain }

    init(botID: String, transport: any AidenBotOpenWorkTransport,
         isCurrent: @escaping @MainActor () -> Bool = { true }, mayWrite: @escaping @MainActor () -> Bool = { true },
         store: AidenBotOpenWorkDraftStore? = nil, scope: AidenBotOpenWorkDraftStore.Scope? = nil) {
        self.botID = botID; self.transport = transport; self.isCurrent = isCurrent; self.mayWrite = mayWrite
        self.store = store; self.scope = scope
        var retained: AidenBotOpenWorkDraftStore.State?
        var readFailed = false
        var readErrorMessage: String?
        if let store, let scope {
            do { retained = try store.load(scope) }
            catch {
                readFailed = true
                readErrorMessage = "This phone couldn’t read its saved Open work request. Inspect the computer before making changes."
            }
        }
        self.mutation = AidenDurablePendingMutation(
            restoredAttempt: retained?.attempt,
            storageReadFailed: readFailed
        )
        if let retained {
            baseline = retained.baseline; draftRevision = retained.draftRevision; draft = retained.draft
        }
        if let readErrorMessage { message = readErrorMessage }
        isRestoring = false
    }

    var canWrite: Bool { isCurrent() && mayWrite() && snapshot != nil && mutation.canWrite }
    var canMutate: Bool { canWrite && !isBusy && !uncertain }
    var canEditDraft: Bool { canMutate }
    var canSave: Bool {
        canEditDraft && draft?.valid == true && draftRevision != nil && conflict == nil && !wasRemoved && !addNeedsReview
            && baseline?.hasPendingStop != true
    }
    var isCheckingStop: Bool { uncertain && mutation.pending?.mutation.action.isStop == true }
    var countSummary: String {
        let count = snapshot?.items.filter { $0.state.isActive }.count ?? 0
        return count == 1 ? "1 active item" : "\(count) active items"
    }

    func load() async {
        guard isCurrent() else { return }
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }
        do {
            let loaded = try await transport.botOpenWork(botId: botID)
            guard generation == loadGeneration, isCurrent(), loaded.botId == botID else { return }
            apply(loaded)
            loadError = nil
        } catch {
            guard generation == loadGeneration, isCurrent() else { return }
            loadError = "Open work couldn’t be loaded. Connect to your paired computer and try again."
        }
    }

    private func apply(_ loaded: AidenOpenWorkSnapshot) {
        // Revisions describe stored metadata; execution can change at equal revision.
        snapshot = loaded
        if draft != nil {
            if let baseline {
                let current = loaded.items.first { $0.id == baseline.id }
                wasRemoved = current == nil
                if let current, current.revision == baseline.revision {
                    self.baseline = current; conflict = nil
                } else { conflict = current }
            } else {
                addNeedsReview = draftRevision != loaded.revision
            }
        }
        reconcile(loaded)
    }

    func begin(item: AidenOpenWorkItem? = nil) {
        guard !isBusy, !uncertain, let snapshot else { return }
        baseline = item; draftRevision = item?.revision ?? snapshot.revision
        conflict = nil; wasRemoved = false; addNeedsReview = false
        draft = item.map(AidenOpenWorkDraft.init) ?? AidenOpenWorkDraft()
    }

    func discardDraft() {
        guard !isBusy, !uncertain else { return }
        baseline = nil; draftRevision = nil; conflict = nil; wasRemoved = false; addNeedsReview = false
        draft = nil
    }

    func useLatestRevision() {
        guard canEditDraft else { return }
        if baseline != nil {
            guard let conflict else { return }
            baseline = conflict; draftRevision = conflict.revision
        } else {
            guard let snapshot else { return }
            draftRevision = snapshot.revision
        }
        conflict = nil; wasRemoved = false; addNeedsReview = false
        persistDraft()
    }

    func saveDraft() async {
        guard canSave, let draft, let draftRevision else { return }
        let mutationRequest: AidenOpenWorkMutation
        do {
            if let baseline {
                mutationRequest = try .init(action: .edit, expectedRevision: draftRevision, id: baseline.id, patch: draft.patch)
            } else {
                mutationRequest = try .init(action: .add, expectedRevision: draftRevision, title: draft.patch.title, note: draft.note)
            }
        } catch { return }
        await beginNew(.init(mutation: mutationRequest, itemID: baseline?.id, consumesDraft: true, createdAt: Date()))
    }

    func setState(_ item: AidenOpenWorkItem, _ state: AidenOpenWorkState) async {
        guard canMutate, !item.hasPendingStop, state != .waiting,
              let mutationRequest = try? AidenOpenWorkMutation(action: .edit, expectedRevision: item.revision, id: item.id,
                patch: .init(state: state)) else { return }
        await beginNew(.init(mutation: mutationRequest, itemID: item.id, consumesDraft: false, createdAt: Date()))
    }

    func act(_ action: AidenOpenWorkMutation.Action, on item: AidenOpenWorkItem) async {
        guard canMutate, !item.hasPendingStop, action == .dismiss || action.isStop,
              !action.isStop || item.execution.canStop,
              let mutationRequest = try? AidenOpenWorkMutation(action: action, expectedRevision: item.revision, id: item.id) else { return }
        await beginNew(.init(mutation: mutationRequest, itemID: item.id, consumesDraft: false, createdAt: Date()))
    }

    func undo(_ option: AidenOpenWorkUndo, now: Date = Date()) async {
        guard canMutate, option.isAvailable(at: now), snapshot?.undo.contains(option) == true,
              let item = snapshot?.items.first(where: { $0.id == option.itemId }), !item.hasPendingStop,
              let mutationRequest = try? AidenOpenWorkMutation(action: .undo, expectedRevision: option.expectedRevision, undoOf: option.mutationId) else { return }
        await beginNew(.init(mutation: mutationRequest, itemID: option.itemId, consumesDraft: false, createdAt: Date()))
    }

    func retryPending(now: Date = Date()) async {
        guard canWrite, !isBusy, let attempt = mutation.pending else { return }
        let policy: AidenDurablePendingMutation<AidenOpenWorkAttempt>.ReplayPolicy =
            attempt.mutation.action.isStop ? .unrestricted : .bounded()
        switch mutation.beginRetry(now: now, policy: policy, persist: { persistStore(attempt: $0) }) {
        case let .started(command):
            await dispatch(command)
        case .expired:
            message = "This request’s outcome is still unknown. Inspect Open work on your computer before making another change."
        case .storageBlocked:
            message = "This phone couldn’t safely retain the request. No new request was sent."
        case .unavailable, .rejectedBeforeWrite:
            return
        }
    }

    private func beginNew(_ command: AidenOpenWorkAttempt) async {
        guard canWrite, !isBusy else { return }
        switch mutation.begin(command, persist: { persistStore(attempt: $0) }) {
        case .started:
            await dispatch(command)
        case .storageBlocked:
            message = "This phone couldn’t safely retain the request. No new request was sent."
        case .unavailable, .rejectedBeforeWrite:
            return
        }
    }

    private func dispatch(_ command: AidenOpenWorkAttempt) async {
        let nonce = command.mutation.mutationId
        isSending = true
        loadGeneration += 1
        defer {
            mutation.abandonInFlightIfUnsettled(matching: nonce)
            isSending = false
        }
        do {
            let result = try await transport.mutateBotOpenWork(botId: botID, mutation: command.mutation)
            guard isCurrent(), mutation.isCurrentInFlight(matching: nonce) else { return }
            guard result.snapshot == nil || result.snapshot?.botId == botID else { throw AidenRemoteClientError.invalidResponse }
            switch result {
            case let .accepted(receipt):
                guard receipt.mutationId == nonce,
                      receipt.itemId == nil || command.itemID == nil || receipt.itemId == command.itemID,
                      receipt.stop == nil || command.mutation.action.isStop else { throw AidenRemoteClientError.invalidResponse }
                if command.mutation.action.isStop {
                    if let stop = receipt.stop, stop.state.isTerminal {
                        if settle(command) { message = stop.description }
                    } else {
                        mutation.markUncertain(matching: nonce)
                        message = receipt.stop?.description ?? "Stop is awaiting acknowledgement. Check the same request to confirm its outcome."
                    }
                } else {
                    if settle(command) { message = command.mutation.action == .undo ? "Change undone." : "Open work saved." }
                }
                apply(receipt.snapshot)
            case let .rejected(refusal):
                let resolution = mutation.resolveRejection(matching: nonce, isUncertainOutcome: refusal.code == .unavailable) { settlingID in
                    persistStore(attempt: nil, settling: settlingID)
                }
                guard resolution != .superseded else { return }
                if case let .clearedDefiniteRefusal(blocked) = resolution {
                    if refusal.code == .stale, command.mutation.action == .add { addNeedsReview = true }
                    if !blocked { message = refusal.code.explanation }
                } else {
                    message = refusal.code.explanation
                }
                if let snapshot = refusal.snapshot { apply(snapshot) }
            }
        } catch {
            guard isCurrent() else { return }
            let resolution = mutation.resolveFailure(matching: nonce, error: error) { settlingID in
                persistStore(attempt: nil, settling: settlingID)
            }
            switch resolution {
            case .superseded:
                return
            case .retainedUncertain:
                message = "The computer may have accepted this request. Check its state or retry the exact same request. Your draft is kept."
            case let .clearedDefiniteRefusal(blocked):
                if !blocked {
                    message = "This change wasn’t confirmed. Refresh and review Open work before trying again. Your draft is kept."
                }
            }
        }
        await load()
    }

    @discardableResult
    private func settle(_ command: AidenOpenWorkAttempt, consumeDraft: Bool = true) -> Bool {
        if consumeDraft && command.consumesDraft {
            isRestoring = true
            baseline = nil; draftRevision = nil; conflict = nil; wasRemoved = false; addNeedsReview = false
            draft = nil
            isRestoring = false
        }
        return mutation.settle(matching: command.mutation.mutationId) { settlingID in
            persistStore(attempt: nil, settling: settlingID)
        }
    }

    private func reconcile(_ loaded: AidenOpenWorkSnapshot) {
        guard mutation.isUncertain, let attempt = mutation.pending else { return }
        if attempt.mutation.action.isReversible,
           let option = loaded.undo.first(where: { $0.mutationId == attempt.mutation.mutationId }),
           attempt.itemID == nil || option.itemId == attempt.itemID {
            if settle(attempt) { message = "Change saved on your computer." }
        } else if attempt.mutation.action.isStop,
                  let item = loaded.items.first(where: { $0.id == attempt.itemID }),
                  let stop = item.lastStop, stop.mutationId == attempt.mutation.mutationId, stop.state.isTerminal {
            if settle(attempt) { message = stop.description }
        }
        // Undo disappearance and matching text/revisions prove no mutation identity.
    }

    private func persistDraft() {
        let currentAttempt = mutation.pending
        if persistStore(attempt: currentAttempt) == .storageFailed {
            mutation.recordStorageFailure()
        }
    }

    private func persistStore(attempt: AidenOpenWorkAttempt?, settling mutationID: UUID? = nil) -> AidenDurablePendingMutation<AidenOpenWorkAttempt>.PersistOutcome {
        guard !isRestoring else { return .saved }
        guard isCurrent() else { return .rejectedBeforeWrite }
        guard let store, let scope else { return .saved }
        do {
            try store.save(.init(draft: draft, baseline: baseline, draftRevision: draftRevision, attempt: attempt), scope: scope, settling: mutationID)
            return .saved
        } catch {
            message = "This phone couldn’t retain the Open work draft safely. Inspect the computer before making changes."
            return .storageFailed
        }
    }

    func loadEvidence(item: AidenOpenWorkItem, kind: AidenOpenWorkEvidenceKind) async {
        guard isCurrent() else { return }
        evidenceGeneration += 1
        let generation = evidenceGeneration
        evidence = nil; evidenceError = nil; isLoadingEvidence = true
        defer { if generation == evidenceGeneration { isLoadingEvidence = false } }
        do {
            let value = try await transport.botOpenWorkEvidence(botId: botID, itemId: item.id, kind: kind)
            guard isCurrent(), generation == evidenceGeneration else { return }
            guard value.itemId == item.id, value.kind == kind else { throw AidenRemoteClientError.invalidResponse }
            let link = item.links.first { $0.kind.rawValue == kind.rawValue }
            let expectedSubmission = kind == .source ? item.source.submissionId ?? link?.submissionId : item.completion?.result?.submissionId ?? link?.submissionId
            let expectedEntry = kind == .source ? item.source.entryId ?? link?.entryId : item.completion?.result?.entryId ?? link?.entryId
            guard expectedSubmission == nil || value.submissionId == expectedSubmission,
                  expectedEntry == nil || value.entryId == expectedEntry else { throw AidenRemoteClientError.invalidResponse }
            evidence = value
        } catch {
            guard isCurrent(), generation == evidenceGeneration else { return }
            evidenceError = "This retained source or result isn’t available from your computer."
        }
    }

    func closeEvidence() {
        evidenceGeneration += 1; evidence = nil; evidenceError = nil; isLoadingEvidence = false
    }
}
