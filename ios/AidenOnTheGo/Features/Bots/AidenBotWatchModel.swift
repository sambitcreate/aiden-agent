import Foundation
import Observation

protocol AidenBotWatchTransport: Sendable {
    func botWatches(botId: String) async throws -> AidenBotWatchList
    func discoverBotWatchSources(botId: String) async throws -> AidenBotWatchSources
    func saveBotWatch(botId: String, id: String?, request: AidenBotWatchSaveRequest) async throws -> AidenBotWatch
    func setBotWatchEnabled(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatch
    func removeBotWatch(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatchRemoval
    func testBotWatch(botId: String, request: AidenBotWatchTestRequest) async throws -> AidenBotWatchTestResult
    func runBotWatch(botId: String, id: String, request: AidenBotWatchActionRequest) async throws -> AidenBotWatchRunResult
}
extension AidenRemoteClient: AidenBotWatchTransport {}

struct AidenBotWatchDraft: Codable, Equatable {
    var name = ""
    var prompt = ""
    var templateID: AidenBotWatchTemplateID = .mailMessages
    var sourceChoiceID: String?
    var everyMinutes = 30
    var sender = ""
    var subject = ""
    var unreadOnly = false
    var lookAheadMinutes = 60
    var timezone = TimeZone.current.identifier

    init() {}
    init(watch: AidenBotWatch) {
        name = watch.name
        prompt = watch.prompt
        templateID = watch.templateId
        everyMinutes = watch.everyMinutes
        switch watch.condition {
        case let .email(sender, subject, unread):
            self.sender = sender ?? ""
            self.subject = subject ?? ""
            unreadOnly = unread
        case let .calendar(minutes, zone):
            lookAheadMinutes = minutes
            timezone = zone
        }
    }
    var condition: AidenBotWatchCondition {
        if templateID == .mailMessages {
            return .email(sender: trimmed(sender), subject: trimmed(subject), unreadOnly: unreadOnly)
        }
        return .calendar(lookAheadMinutes: lookAheadMinutes, timezone: timezone)
    }
    var valid: Bool {
        (try? request(revision: nil, mutationID: UUID(), requireSource: false)) != nil
    }
    func request(revision: String?, mutationID: UUID, requireSource: Bool = true) throws -> AidenBotWatchSaveRequest {
        let request = AidenBotWatchSaveRequest(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines), condition: condition,
            everyMinutes: everyMinutes, sourceChoiceId: sourceChoiceID, expectedRevision: revision, mutationId: mutationID)
        // A draft without a source can still be edited before foreground discovery.
        try AidenBotWatchWire.text(request.name, "name", limit: 120)
        try AidenBotWatchWire.text(request.prompt, "prompt", limit: 32_768)
        try condition.validate()
        guard AidenBotWatchWire.intervals.contains(everyMinutes), !requireSource || revision != nil || sourceChoiceID != nil else {
            throw AidenBotContractError.invalidField("source")
        }
        return request
    }
    private func trimmed(_ value: String) -> String? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

/// A frozen command survives an unknown outcome. It can only be replayed with
/// the original mutation identity, revision and fields, never an edited draft.
enum AidenBotWatchMutation: Codable, Equatable {
    case save(id: String?, request: AidenBotWatchSaveRequest)
    case enabled(id: String, request: AidenBotWatchActionRequest)
    case remove(id: String, request: AidenBotWatchActionRequest)
    case run(id: String, request: AidenBotWatchActionRequest)
    var mutationID: UUID {
        switch self {
        case let .save(_, request): request.mutationId
        case let .enabled(_, request), let .remove(_, request), let .run(_, request): request.mutationId
        }
    }
}

private struct AidenBotWatchAttempt: AidenDurablePendingAttempt {
    let mutation: AidenBotWatchMutation
    let createdAt: Date

    var pendingAttemptID: UUID? { mutation.mutationID }
    var pendingAttemptCreatedAt: Date { createdAt }
}

@MainActor
@Observable
final class AidenBotWatchModel {
    let botID: String
    private let transport: any AidenBotWatchTransport
    private let isCurrent: @MainActor () -> Bool
    private let mayWrite: @MainActor () -> Bool
    private var mutation: AidenDurablePendingMutation<AidenBotWatchAttempt>
    private(set) var list: AidenBotWatchList?
    private(set) var sources: AidenBotWatchSources?
    private(set) var isLoading = false
    private var auxiliaryBusy = false
    private(set) var loadError: String?
    var message: String?
    var draft: AidenBotWatchDraft? { didSet { persistDraft() } }
    private(set) var baseline: AidenBotWatch?
    private(set) var conflict: AidenBotWatch?
    private(set) var wasRemoved = false
    private(set) var testResult: AidenBotWatchTestResult?
    @ObservationIgnored private var isRestoring = true
    private let draftStore: AidenBotWatchDraftStore?
    private let draftScope: AidenBotWatchDraftStore.Scope?
    private var loadGeneration = 0
    private var editorGeneration = 0

    var isBusy: Bool { auxiliaryBusy || mutation.isInFlight }
    var uncertain: Bool { mutation.isUncertain }

    init(botID: String, transport: any AidenBotWatchTransport,
         isCurrent: @escaping @MainActor () -> Bool = { true },
         mayWrite: @escaping @MainActor () -> Bool = { true },
         draftStore: AidenBotWatchDraftStore? = nil, draftScope: AidenBotWatchDraftStore.Scope? = nil) {
        self.botID = botID
        self.transport = transport
        self.isCurrent = isCurrent
        self.mayWrite = mayWrite
        self.draftStore = draftStore
        self.draftScope = draftScope
        var retained: AidenBotWatchDraftStore.State?
        var restored: AidenBotWatchAttempt?
        var readFailed = false
        var readErrorMessage: String?
        if let draftStore, let draftScope {
            do {
                if let loaded = try draftStore.load(draftScope) {
                    retained = loaded
                    if let pending = loaded.pending, let pendingSince = loaded.pendingSince {
                        restored = AidenBotWatchAttempt(mutation: pending, createdAt: pendingSince)
                    }
                }
            } catch {
                readFailed = true
                readErrorMessage = "The saved watch draft couldn’t be read. Inspect watches on your computer before making changes."
            }
        }
        self.mutation = AidenDurablePendingMutation(
            restoredAttempt: restored,
            storageReadFailed: readFailed
        )
        if let retained {
            draft = retained.draft
            baseline = retained.baseline
        }
        if let readErrorMessage { message = readErrorMessage }
        isRestoring = false
    }

    var canWrite: Bool { mutation.canWrite && isCurrent() && mayWrite() && list?.supported == true }
    var canEditDraft: Bool { canWrite && !isBusy && !uncertain }
    var selectedTemplate: AidenBotWatchTemplate? { list?.templates.first { $0.id == draft?.templateID } }
    var eligibleSources: [AidenBotWatchSourceChoice] { sources?.choices.filter { $0.templateId == draft?.templateID } ?? [] }
    var canSave: Bool {
        canEditDraft && conflict == nil && !wasRemoved && draft?.valid == true
            && selectedTemplate?.available == true
            && (draft?.sourceChoiceID != nil || baseline?.templateId == draft?.templateID)
            && selectedTemplate?.intervals.contains(draft?.everyMinutes ?? 0) == true
            && (draft?.sourceChoiceID == nil || eligibleSources.contains { $0.id == draft?.sourceChoiceID && $0.available })
    }
    var canTestDraft: Bool {
        canEditDraft && conflict == nil && !wasRemoved && selectedTemplate?.available == true
            && (draft?.sourceChoiceID != nil || baseline?.condition == draft?.condition)
    }

    func load() async {
        guard isCurrent() else { return }
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }
        do {
            let loaded = try await transport.botWatches(botId: botID)
            guard generation == loadGeneration, isCurrent(), loaded.watches.allSatisfy({ $0.botId == botID }) else { return }
            list = loaded
            loadError = nil
            if let baseline {
                let current = loaded.watches.first { $0.id == baseline.id }
                wasRemoved = current == nil
                if let current, current.revision == baseline.revision {
                    self.baseline = current
                    conflict = nil
                } else {
                    conflict = current
                }
            }
            reconcile(loaded)
        } catch {
            guard generation == loadGeneration, isCurrent() else { return }
            loadError = "Watches couldn’t be loaded. Connect to your paired computer and try again."
        }
    }

    func begin(watch: AidenBotWatch? = nil) {
        guard !isBusy, !uncertain else { return }
        editorGeneration += 1
        baseline = watch
        conflict = nil
        wasRemoved = false
        testResult = nil
        draft = watch.map(AidenBotWatchDraft.init) ?? AidenBotWatchDraft()
        if watch == nil, let first = list?.templates.first(where: \.available) {
            draft?.templateID = first.id
            draft?.everyMinutes = first.intervals.first ?? 30
        }
    }

    /// The draft remains in this model when the sheet closes or connectivity changes.
    func discardDraft() {
        guard !isBusy, !uncertain else { return }
        editorGeneration += 1
        draft = nil
        baseline = nil
        conflict = nil
        wasRemoved = false
        testResult = nil
    }

    func selectTemplate(_ id: AidenBotWatchTemplateID) {
        guard canEditDraft else { return }
        draft?.templateID = id
        draft?.sourceChoiceID = nil
        let interval = selectedTemplate?.intervals.first ?? 30
        draft?.everyMinutes = interval
        testResult = nil
    }

    func useLatestRevision() {
        guard canEditDraft, let conflict else { return }
        baseline = conflict
        self.conflict = nil
        wasRemoved = false
        testResult = nil
        persistDraft()
    }

    func discover() async {
        guard canEditDraft, selectedTemplate?.available == true else { return }
        auxiliaryBusy = true
        let generation = editorGeneration
        defer { auxiliaryBusy = false }
        do {
            let loaded = try await transport.discoverBotWatchSources(botId: botID)
            guard isCurrent(), generation == editorGeneration else { return }
            sources = loaded
            if let selected = draft?.sourceChoiceID, !loaded.choices.contains(where: { $0.id == selected && $0.available }) {
                draft?.sourceChoiceID = nil
            }
        } catch {
            if isCurrent(), generation == editorGeneration {
                message = "Sources couldn’t be found. Connect the provider or grant access on your computer, then try again."
            }
        }
    }

    func saveDraft() async {
        guard canSave, let draft, let request = try? draft.request(revision: baseline?.revision, mutationID: UUID()) else { return }
        await performNew(.save(id: baseline?.id, request: request))
    }

    func setEnabled(_ watch: AidenBotWatch, _ enabled: Bool) async {
        guard canWrite, !isBusy, !uncertain else { return }
        await performNew(.enabled(id: watch.id, request: .init(expectedRevision: watch.revision, mutationId: UUID(), enabled: enabled)))
    }

    func remove(_ watch: AidenBotWatch) async {
        guard canWrite, !isBusy, !uncertain else { return }
        await performNew(.remove(id: watch.id, request: .init(expectedRevision: watch.revision, mutationId: UUID())))
    }

    func run(_ watch: AidenBotWatch) async {
        guard canWrite, !isBusy, !uncertain else { return }
        await performNew(.run(id: watch.id, request: .init(expectedRevision: watch.revision, mutationId: UUID())))
    }

    func testDraft() async {
        guard canTestDraft, let draft else { return }
        let request: AidenBotWatchTestRequest
        if let source = draft.sourceChoiceID {
            request = .draft(sourceChoiceId: source, condition: draft.condition)
        } else if let baseline {
            request = .saved(id: baseline.id, expectedRevision: baseline.revision)
        } else { return }
        await test(request)
    }

    func testSaved(_ watch: AidenBotWatch) async {
        guard canWrite, !isBusy, !uncertain else { return }
        await test(.saved(id: watch.id, expectedRevision: watch.revision))
    }

    private func test(_ request: AidenBotWatchTestRequest) async {
        auxiliaryBusy = true
        let generation = editorGeneration
        defer { auxiliaryBusy = false }
        do {
            let result = try await transport.testBotWatch(botId: botID, request: request)
            guard isCurrent(), generation == editorGeneration else { return }
            testResult = result
        } catch {
            guard isCurrent(), generation == editorGeneration else { return }
            message = "The test check couldn’t finish. It didn’t run the Bot or change the saved baseline."
            await load()
        }
    }

    func retryPending(now: Date = Date()) async {
        guard canWrite, !isBusy else { return }
        switch mutation.beginRetry(now: now, persist: { persistStore(pending: $0) }) {
        case let .started(attempt):
            await dispatch(attempt)
        case .expired:
            message = "This outcome is still unknown. Inspect the watch on your computer before making another change."
        case .storageBlocked:
            message = "The request couldn’t be saved safely on this phone. No new request was sent."
        case .unavailable, .rejectedBeforeWrite:
            return
        }
    }

    private func performNew(_ command: AidenBotWatchMutation) async {
        guard isCurrent(), mayWrite(), !isBusy else { return }
        let attempt = AidenBotWatchAttempt(mutation: command, createdAt: Date())
        switch mutation.begin(attempt, persist: { persistStore(pending: $0) }) {
        case .started:
            await dispatch(attempt)
        case .storageBlocked:
            message = "The request couldn’t be saved safely on this phone. No new request was sent."
        case .unavailable, .rejectedBeforeWrite:
            return
        }
    }

    private func dispatch(_ attempt: AidenBotWatchAttempt) async {
        let command = attempt.mutation
        let nonce = command.mutationID
        auxiliaryBusy = true
        // Reject loads begun before the write. A fresh GET follows every outcome.
        loadGeneration += 1
        defer {
            mutation.abandonInFlightIfUnsettled(matching: nonce)
            auxiliaryBusy = false
        }
        do {
            switch command {
            case let .save(id, request):
                let updated = try await transport.saveBotWatch(botId: botID, id: id, request: request)
                guard isCurrent(), updated.botId == botID else { return }
                isRestoring = true
                draft = nil
                baseline = nil
                isRestoring = false
                let settled = settlePending(matching: nonce)
                conflict = nil
                wasRemoved = false
                if settled { message = "Watch saved." }
            case let .enabled(id, request):
                let updated = try await transport.setBotWatchEnabled(botId: botID, id: id, request: request)
                guard isCurrent(), updated.botId == botID, updated.id == id else { return }
                if baseline?.id == id { baseline = updated }
                if settlePending(matching: nonce) {
                    message = updated.enabled ? "Watch resumed." : "Watch paused."
                }
            case let .remove(id, request):
                let result = try await transport.removeBotWatch(botId: botID, id: id, request: request)
                guard isCurrent(), result.id == id else { return }
                if result.removed, baseline?.id == id {
                    isRestoring = true
                    draft = nil
                    baseline = nil
                    isRestoring = false
                }
                if settlePending(matching: nonce) {
                    message = result.removed ? "Watch deleted." : "The watch wasn’t deleted. Refresh and try again."
                }
            case let .run(id, request):
                let result = try await transport.runBotWatch(botId: botID, id: id, request: request)
                guard isCurrent(), result.id == id else { return }
                if settlePending(matching: nonce) {
                    message = result.admitted ? "Run requested on your computer." : "Run was not started. Check the Bot’s current policy and limits on your computer."
                }
            }
        } catch {
            guard isCurrent() else { return }
            // A concurrent authoritative read may already have settled this
            // command. Its late retry failure cannot make it unknown again.
            let resolution = mutation.resolveFailure(matching: nonce, error: error) { settlingID in
                persistStore(pending: nil, settling: settlingID)
            }
            switch resolution {
            case .superseded:
                return
            case .retainedUncertain:
                message = "The computer may have accepted this change. Refresh to check, or retry the same request. Your draft is kept."
            case let .clearedDefiniteRefusal(blocked):
                if !blocked {
                    if case let AidenRemoteClientError.server(status, _) = error, status == 409 {
                        message = "This watch changed on your computer. Your draft is kept. Review the latest saved version before saving again."
                    } else {
                        message = "That change wasn’t confirmed. Refresh and review the watch before trying again. Your draft is kept."
                    }
                }
            }
        }
        await load()
    }

    @discardableResult
    private func settlePending(matching id: UUID) -> Bool {
        mutation.settle(matching: id) { settlingID in
            persistStore(pending: nil, settling: settlingID)
        }
    }

    private func persistDraft() {
        let currentAttempt = mutation.pending
        if persistStore(pending: currentAttempt) == .storageFailed {
            mutation.recordStorageFailure()
        }
    }

    private func persistStore(pending: AidenBotWatchAttempt?, settling mutationID: UUID? = nil) -> AidenDurablePendingMutation<AidenBotWatchAttempt>.PersistOutcome {
        guard !isRestoring else { return .saved }
        guard isCurrent() else { return .rejectedBeforeWrite }
        guard let draftStore, let draftScope else { return .saved }
        do {
            try draftStore.save(.init(draft: draft, baseline: baseline, pending: pending?.mutation, pendingSince: pending?.createdAt), scope: draftScope, settling: mutationID)
            return .saved
        } catch {
            message = "This phone couldn’t retain the watch draft safely. Inspect the watch on your computer before making changes."
            return .storageFailed
        }
    }

    private func reconcile(_ loaded: AidenBotWatchList) {
        guard mutation.isUncertain, let pending = mutation.pending?.mutation else { return }
        switch pending {
        case let .save(nil, request):
            // Creation uses its mutation UUID as the resource ID. Never match by labels or text.
            if loaded.watches.contains(where: { UUID(uuidString: $0.id) == request.mutationId }) {
                isRestoring = true
                draft = nil; baseline = nil; conflict = nil
                isRestoring = false
                if settlePending(matching: request.mutationId) {
                    message = "Watch saved on your computer."
                }
            }
        case let .remove(id, request):
            if !loaded.watches.contains(where: { $0.id == id }) {
                if baseline?.id == id {
                    isRestoring = true
                    draft = nil; baseline = nil
                    isRestoring = false
                }
                if settlePending(matching: request.mutationId) {
                    message = "Watch deleted on your computer."
                }
            }
        case .save, .enabled, .run:
            // Another client can publish the same values at a newer revision.
            // Only the frozen command's successful response/replay settles it.
            break
        }
    }
}
