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

@MainActor
@Observable
final class AidenBotOpenWorkModel {
    let botID: String
    private let transport: any AidenBotOpenWorkTransport
    private let isCurrent: @MainActor () -> Bool
    private let mayWrite: @MainActor () -> Bool
    private let store: AidenBotOpenWorkDraftStore?
    private let scope: AidenBotOpenWorkDraftStore.Scope?
    private(set) var snapshot: AidenOpenWorkSnapshot?
    private(set) var isLoading = false
    private(set) var isBusy = false
    private(set) var loadError: String?
    var message: String?
    var draft: AidenOpenWorkDraft? { didSet { persist() } }
    private(set) var baseline: AidenOpenWorkItem?
    private(set) var draftRevision: String?
    private(set) var conflict: AidenOpenWorkItem?
    private(set) var wasRemoved = false
    private(set) var addNeedsReview = false
    private(set) var uncertain = false
    private(set) var evidence: AidenOpenWorkEvidence?
    private(set) var evidenceError: String?
    private(set) var isLoadingEvidence = false
    private var attempt: AidenOpenWorkAttempt?
    private var storageBlocked = false
    @ObservationIgnored private var isRestoring = true
    private var loadGeneration = 0
    private var evidenceGeneration = 0

    init(botID: String, transport: any AidenBotOpenWorkTransport,
         isCurrent: @escaping @MainActor () -> Bool = { true }, mayWrite: @escaping @MainActor () -> Bool = { true },
         store: AidenBotOpenWorkDraftStore? = nil, scope: AidenBotOpenWorkDraftStore.Scope? = nil) {
        self.botID = botID; self.transport = transport; self.isCurrent = isCurrent; self.mayWrite = mayWrite
        self.store = store; self.scope = scope
        if let store, let scope {
            do {
                if let retained = try store.load(scope) {
                    baseline = retained.baseline; draftRevision = retained.draftRevision
                    attempt = retained.attempt; draft = retained.draft; uncertain = attempt != nil
                }
            } catch {
                storageBlocked = true
                message = "This phone couldn’t read its saved Open work request. Inspect the host before making changes."
            }
        }
        isRestoring = false
    }
    var canWrite: Bool { isCurrent() && mayWrite() && snapshot != nil && !storageBlocked }
    var canMutate: Bool { canWrite && !isBusy && !uncertain }
    var canEditDraft: Bool { canMutate }
    var canSave: Bool {
        canEditDraft && draft?.valid == true && draftRevision != nil && conflict == nil && !wasRemoved && !addNeedsReview
            && baseline?.hasPendingStop != true
    }
    var isCheckingStop: Bool { uncertain && attempt?.mutation.action.isStop == true }
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
            loadError = "Open work couldn’t be loaded. Connect to your paired host and try again."
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
        persist()
    }
    func saveDraft() async {
        guard canSave, let draft, let draftRevision else { return }
        let mutation: AidenOpenWorkMutation
        do {
            if let baseline {
                mutation = try .init(action: .edit, expectedRevision: draftRevision, id: baseline.id, patch: draft.patch)
            } else {
                mutation = try .init(action: .add, expectedRevision: draftRevision, title: draft.patch.title, note: draft.note)
            }
        } catch { return }
        await send(.init(mutation: mutation, itemID: baseline?.id, consumesDraft: true, createdAt: Date()))
    }
    func setState(_ item: AidenOpenWorkItem, _ state: AidenOpenWorkState) async {
        guard canMutate, !item.hasPendingStop, state != .waiting,
              let mutation = try? AidenOpenWorkMutation(action: .edit, expectedRevision: item.revision, id: item.id,
                patch: .init(state: state)) else { return }
        await send(.init(mutation: mutation, itemID: item.id, consumesDraft: false, createdAt: Date()))
    }
    func act(_ action: AidenOpenWorkMutation.Action, on item: AidenOpenWorkItem) async {
        guard canMutate, !item.hasPendingStop, action == .dismiss || action.isStop,
              !action.isStop || item.execution.canStop,
              let mutation = try? AidenOpenWorkMutation(action: action, expectedRevision: item.revision, id: item.id) else { return }
        await send(.init(mutation: mutation, itemID: item.id, consumesDraft: false, createdAt: Date()))
    }
    func undo(_ option: AidenOpenWorkUndo, now: Date = Date()) async {
        guard canMutate, option.isAvailable(at: now), snapshot?.undo.contains(option) == true,
              let item = snapshot?.items.first(where: { $0.id == option.itemId }), !item.hasPendingStop,
              let mutation = try? AidenOpenWorkMutation(action: .undo, expectedRevision: option.expectedRevision, undoOf: option.mutationId) else { return }
        await send(.init(mutation: mutation, itemID: option.itemId, consumesDraft: false, createdAt: Date()))
    }
    func retryPending(now: Date = Date()) async {
        guard canWrite, !isBusy, let attempt else { return }
        let age = now.timeIntervalSince(attempt.createdAt)
        guard attempt.mutation.action.isStop || (0..<(23 * 3600)).contains(age) else {
            message = "This request’s outcome is still unknown. Inspect Open work on your host before making another change."
            return
        }
        await send(attempt)
    }
    private func send(_ command: AidenOpenWorkAttempt) async {
        guard canWrite, !isBusy else { return }
        let hadUnknownOutcome = uncertain
        isBusy = true; attempt = command
        persist()
        guard !storageBlocked else {
            isBusy = false
            message = "This phone couldn’t safely retain the request. No new request was sent."
            return
        }
        loadGeneration += 1
        defer { isBusy = false }
        do {
            let result = try await transport.mutateBotOpenWork(botId: botID, mutation: command.mutation)
            guard isCurrent(), attempt?.mutation.mutationId == command.mutation.mutationId else { return }
            guard result.snapshot == nil || result.snapshot?.botId == botID else { throw AidenRemoteClientError.invalidResponse }
            switch result {
            case let .accepted(receipt):
                guard receipt.mutationId == command.mutation.mutationId,
                      receipt.itemId == nil || command.itemID == nil || receipt.itemId == command.itemID,
                      receipt.stop == nil || command.mutation.action.isStop else { throw AidenRemoteClientError.invalidResponse }
                if command.mutation.action.isStop {
                    if let stop = receipt.stop, stop.state.isTerminal {
                        settle(command); message = stop.description
                    } else {
                        uncertain = true
                        message = receipt.stop?.description ?? "Stop is awaiting acknowledgement. Check the same request to confirm its outcome."
                    }
                } else {
                    settle(command); message = command.mutation.action == .undo ? "Change undone." : "Open work saved."
                }
                apply(receipt.snapshot)
            case let .rejected(refusal):
                if hadUnknownOutcome || refusal.code == .unavailable {
                    uncertain = true
                } else {
                    settle(command, consumeDraft: false)
                    if refusal.code == .stale, command.mutation.action == .add { addNeedsReview = true }
                }
                message = refusal.code.explanation
                if let snapshot = refusal.snapshot { apply(snapshot) }
            }
        } catch {
            guard isCurrent(), attempt?.mutation.mutationId == command.mutation.mutationId else { return }
            if hadUnknownOutcome || aidenBotSessionFailureIsAmbiguous(error) {
                uncertain = true
                message = "The host may have accepted this request. Check its state or retry the exact same request. Your draft is kept."
            } else {
                settle(command, consumeDraft: false)
                message = "This change wasn’t confirmed. Refresh and review Open work before trying again. Your draft is kept."
            }
        }
        await load()
    }
    private func settle(_ command: AidenOpenWorkAttempt, consumeDraft: Bool = true) {
        if consumeDraft && command.consumesDraft {
            baseline = nil; draftRevision = nil; conflict = nil; wasRemoved = false; addNeedsReview = false
            draft = nil
        }
        attempt = nil; uncertain = false
        persist(settling: command.mutation.mutationId)
    }
    private func reconcile(_ loaded: AidenOpenWorkSnapshot) {
        guard uncertain, let attempt else { return }
        if attempt.mutation.action.isReversible,
           let option = loaded.undo.first(where: { $0.mutationId == attempt.mutation.mutationId }),
           attempt.itemID == nil || option.itemId == attempt.itemID {
            settle(attempt); message = "Change saved on your host."
        } else if attempt.mutation.action.isStop,
                  let item = loaded.items.first(where: { $0.id == attempt.itemID }),
                  let stop = item.lastStop, stop.mutationId == attempt.mutation.mutationId, stop.state.isTerminal {
            settle(attempt); message = stop.description
        }
        // Undo disappearance and matching text/revisions prove no mutation identity.
    }
    private func persist(settling mutationID: UUID? = nil) {
        guard !isRestoring, isCurrent(), let store, let scope else { return }
        do {
            try store.save(.init(draft: draft, baseline: baseline, draftRevision: draftRevision, attempt: attempt), scope: scope, settling: mutationID)
        } catch {
            storageBlocked = true
            message = "This phone couldn’t retain the Open work draft safely. Inspect the host before making changes."
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
            evidenceError = "This retained source or result isn’t available from your host."
        }
    }
    func closeEvidence() {
        evidenceGeneration += 1; evidence = nil; evidenceError = nil; isLoadingEvidence = false
    }
}
