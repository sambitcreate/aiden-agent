import Foundation
import Observation

protocol AidenBotPeersTransport: Sendable {
    func botPeerSettings(botId: String) async throws -> AidenPeerSettings
    func botPeerCatalog(botId: String) async throws -> AidenPeerCatalog
    func mutateBotPeers(_ request: AidenPeerMutation) async throws -> AidenPeerMutationResult
    func botPeerExchanges(botId: String) async throws -> AidenPeerExchangeList
    func botPeerExchange(botId: String, exchangeId: String) async throws -> AidenPeerExchangeDetail
    func stopBotPeerExchange(_ request: AidenPeerStopMutation) async throws -> AidenPeerStopResult
    func botPeerEvidence(botId: String, exchangeId: String, kind: AidenOpenWorkEvidenceKind) async throws -> AidenPeerEvidence
}
extension AidenRemoteClient: AidenBotPeersTransport {}

/// Unknown typed outcomes, malformed replies and transport loss may follow publication.
/// Reuse the conservative code-aware control classifier, never HTTP status alone.
func aidenPeerFailureIsAmbiguous(_ error: Error) -> Bool { aidenBotResumeFailureIsAmbiguous(error) }

@MainActor @Observable
final class AidenBotPeersModel {
    let botID: String
    private let transport: any AidenBotPeersTransport
    private let isCurrent: @MainActor () -> Bool; private let mayWrite: @MainActor () -> Bool
    private let mayReadExchanges: @MainActor () -> Bool
    private let store: AidenBotPeerControlStore?; private let scope: AidenBotPeerControlStore.Scope?; private let storageGeneration: String?
    private(set) var settings: AidenPeerSettings?; private(set) var baseline: AidenPeerSettings?
    var draft = "" { didSet { if !restoring { persist() } } }
    private(set) var catalog: AidenPeerCatalog?; private(set) var exchanges: [AidenPeerExchangeSummary] = []
    private(set) var pending: AidenPeerAttempt?; private(set) var loading = false; private(set) var busy = false
    private(set) var needsReview = false; var message: String?
    @ObservationIgnored private(set) var persistenceFailure: String?
    private var storageBlocked = false; private var restoring = true; private var generation = 0
    private var active = true
    init(botID: String, transport: any AidenBotPeersTransport, isCurrent: @escaping @MainActor () -> Bool = { true }, mayWrite: @escaping @MainActor () -> Bool = { true }, mayReadExchanges: @escaping @MainActor () -> Bool = { true }, store: AidenBotPeerControlStore? = nil, scope: AidenBotPeerControlStore.Scope? = nil) {
        self.botID = botID; self.transport = transport; self.isCurrent = isCurrent; self.mayWrite = mayWrite; self.mayReadExchanges = mayReadExchanges
        self.store = store; self.scope = scope; storageGeneration = scope.flatMap { store?.generation(for: $0) }
        if let store, let scope {
            do { if let state = try store.load(scope) { baseline = state.baseline; draft = state.draft ?? ""; pending = state.attempt } }
            catch { storageBlocked = true; message = "This phone couldn’t read its saved peer change. Inspect the host before making changes." }
        }
        restoring = false
    }
    private var current: Bool { active && isCurrent() && scope.flatMap { store?.generation(for: $0) } == storageGeneration }
    var visitToken: Int { generation }
    var canReadExchanges: Bool { mayReadExchanges() }
    var canWrite: Bool { current && mayWrite() && !storageBlocked }
    var canEdit: Bool { canWrite && settings != nil && pending == nil && !busy }
    var canSaveDescription: Bool { canEdit && !needsReview && baseline != nil && draft != baseline?.routingDescription && (try? AidenPeerWire.text(draft, scalars: 1000, bytes: 2048, empty: true)) != nil }
    func setActive(_ value: Bool) { if value != active { active = value; generation += 1; loading = false } }
    func load() async {
        guard current else { return }; generation += 1; let visit = generation; loading = true
        defer { if visit == generation { loading = false } }
        do {
            let snapshot = try await transport.botPeerSettings(botId: botID)
            guard current, visit == generation else { return }; try apply(snapshot)
            let offered = try await transport.botPeerCatalog(botId: botID)
            guard current, visit == generation, offered.botId == botID else { return }; catalog = offered
            if mayReadExchanges() {
                let list = try await transport.botPeerExchanges(botId: botID)
                guard current, visit == generation, mayReadExchanges(), list.botId == botID else { return }; exchanges = list.exchanges
            } else { exchanges = [] }
        } catch { if current, visit == generation { message = "Peers couldn’t be loaded. Your draft and pending change are kept." } }
    }
    private func apply(_ snapshot: AidenPeerSettings) throws {
        guard snapshot.botId == botID else { throw AidenRemoteClientError.invalidResponse }; settings = snapshot
        if let nonce = pending?.nonce, snapshot.lastMutationId == nonce { settle(snapshot, nonce: nonce); return }
        if baseline == nil { baseline = snapshot; draft = snapshot.routingDescription; persist() }
        else if baseline?.revision != snapshot.revision { needsReview = true }
    }
    func keepDraft() { guard canEdit, let settings else { return }; baseline = settings; needsReview = false; persist() }
    func useSaved() { guard canEdit, let settings else { return }; baseline = settings; draft = settings.routingDescription; needsReview = false; persist() }
    func describe() async {
        guard canSaveDescription, let baseline else { return }
        await begin(.init(action: .describe, botId: botID, expectedRevision: baseline.revision, routingDescription: draft.trimmingCharacters(in: .whitespacesAndNewlines)))
    }
    func canApprove(_ choice: AidenPeerCatalog.Bot) -> Bool {
        canEdit && !needsReview && choice.available && catalog?.bots.contains(choice) == true && settings?.pairs.contains(where: { $0.peer.botId == choice.botId }) == false
    }
    /// The UI confirms current names; catalog identity/revision is rechecked at this action.
    func approve(_ choice: AidenPeerCatalog.Bot, catalogRevision: String, visit: Int) async {
        guard visit == generation, canApprove(choice), let baseline, catalog?.revision == catalogRevision else { return }
        await begin(.init(action: .approve, botId: botID, expectedRevision: baseline.revision, catalogRevision: catalogRevision, peerBotId: choice.botId))
    }
    func revoke(_ pair: AidenPeerPair, visit: Int) async {
        guard visit == generation, canEdit, !needsReview, let baseline, settings?.pairs.contains(pair) == true else { return }
        await begin(.init(action: .revoke, botId: botID, expectedRevision: baseline.revision, pairId: pair.id, pairRevision: pair.revision))
    }
    private func begin(_ request: AidenPeerMutation) async {
        guard canEdit, (try? request.validate()) != nil else { return }
        let attempt = AidenPeerAttempt(mutation: request, createdAt: Date()); pending = attempt
        guard persist() else { pending = nil; return }; await send(attempt, previousUnknown: false)
    }
    func retry(now: Date = Date()) async {
        guard canWrite, !busy, let pending else { return }
        guard now.timeIntervalSince(pending.createdAt) >= 0, now.timeIntervalSince(pending.createdAt) < 23 * 3600 else { message = "This change is too old to replay safely. Its outcome remains unknown. Refresh the host; no new request has been created."; return }
        await send(pending, previousUnknown: true)
    }
    private func send(_ attempt: AidenPeerAttempt, previousUnknown: Bool) async {
        guard canWrite, !busy, let request = attempt.mutation else { return }; let visit = generation
        busy = true; defer { busy = false }
        do {
            let result = try await aidenBotWithin(.seconds(12)) { [transport] in try await transport.mutateBotPeers(request) }
            guard current, visit == generation, pending == attempt else { return }
            if let snapshot = result.snapshot { guard snapshot.botId == botID else { throw AidenRemoteClientError.invalidResponse } }
            switch result {
            case let .accepted(snapshot, nonce, _):
                guard nonce == request.mutationId else { throw AidenRemoteClientError.invalidResponse }; settle(snapshot, nonce: nonce)
            case let .rejected(code, _, snapshot):
                if let snapshot { try apply(snapshot) }; guard pending == attempt else { return }
                if code != .unavailable && !previousUnknown { pending = nil; persist(settling: request.mutationId) }
                if code == .conflict { needsReview = true }
                message = pending == nil ? "This change wasn’t saved. Refresh and review the current settings. Your draft is kept." : "The host may have saved this change. Refresh or retry the same request before making another change."
            }
        } catch {
            guard current, visit == generation, pending == attempt else { return }
            if !previousUnknown && !aidenPeerFailureIsAmbiguous(error) { pending = nil; persist(settling: request.mutationId) }
            message = pending == nil ? "This change wasn’t saved. Your draft is kept." : "The outcome is unknown. Your exact change is kept for refresh or same-request retry."
        }
    }
    private func settle(_ snapshot: AidenPeerSettings, nonce: UUID) {
        // Pair changes do not save the separately authored routing description.
        // Capture the action before clearing its durable receipt, including GET recovery.
        let descriptionWasSaved = pending?.mutation?.action == .describe
        let hasDraft = baseline.map { draft != $0.routingDescription } ?? false
        let overlappingDescription = !descriptionWasSaved && hasDraft && baseline?.routingDescription != snapshot.routingDescription
        restoring = true
        pending = nil; settings = snapshot
        if !overlappingDescription { baseline = snapshot }
        if descriptionWasSaved || !hasDraft { draft = snapshot.routingDescription }
        needsReview = overlappingDescription; restoring = false
        persist(settling: nonce)
    }
    @discardableResult private func persist(settling nonce: UUID? = nil) -> Bool {
        guard !restoring, let store, let scope else { return true }
        // Invalid drafts stay in memory; they never replace a valid durable draft.
        guard (try? AidenPeerWire.text(draft, scalars: 1000, bytes: 2048, empty: true)) != nil else { return false }
        do { try store.save(.init(baseline: baseline, draft: baseline == nil ? nil : draft, attempt: pending), scope: scope, settling: nonce, generation: storageGeneration); return true }
        catch { let failure = error as NSError; persistenceFailure = "\(failure.domain):\(failure.code)"; storageBlocked = true; message = "This phone couldn’t safely retain the change. New changes are blocked until its saved state is recovered."; return false }
    }
}

@MainActor @Observable
final class AidenBotPeerExchangeModel {
    let botID: String; let exchangeID: String
    private let transport: any AidenBotPeersTransport
    private let isCurrent: @MainActor () -> Bool; private let mayWrite: @MainActor () -> Bool
    private let store: AidenBotPeerControlStore?; private let scope: AidenBotPeerControlStore.Scope?; private let storageGeneration: String?
    private(set) var detail: AidenPeerExchangeDetail?; private(set) var evidence: AidenPeerEvidence?
    private(set) var pending: AidenPeerAttempt?; private(set) var busy = false; private(set) var loading = false; private(set) var needsRefresh = false; var message: String?
    private var generation = 0; private var active = true; private var storageBlocked = false
    private var readGeneration = 0; private var evidenceGeneration = 0
    @ObservationIgnored private(set) var persistenceFailure: String?
    /// A protected pending receipt must have been observed in this foreground visit.
    private var protectedPendingNonce: UUID?
    init(botID: String, exchangeID: String, transport: any AidenBotPeersTransport, isCurrent: @escaping @MainActor () -> Bool = { true }, mayWrite: @escaping @MainActor () -> Bool = { true }, store: AidenBotPeerControlStore? = nil, scope: AidenBotPeerControlStore.Scope? = nil) {
        self.botID = botID; self.exchangeID = exchangeID; self.transport = transport; self.isCurrent = isCurrent; self.mayWrite = mayWrite
        self.store = store; self.scope = scope; storageGeneration = scope.flatMap { store?.generation(for: $0) }
        if let store, let scope { do { pending = try store.load(scope)?.attempt } catch { storageBlocked = true; message = "This phone couldn’t read its saved Stop. Inspect the host before making changes." } }
    }
    private var current: Bool { active && isCurrent() && scope.flatMap { store?.generation(for: $0) } == storageGeneration }
    var canWrite: Bool { current && mayWrite() && !storageBlocked }
    var hasHostPendingStop: Bool {
        detail?.summary.state == .stopping || detail?.summary.lastStop.map { !$0.state.terminal } == true
    }
    var canStop: Bool { canWrite && !busy && !needsRefresh && pending == nil && !hasHostPendingStop && detail?.summary.canStop == true }
    func setActive(_ value: Bool) { if value != active { active = value; generation += 1; loading = false; evidence = nil; protectedPendingNonce = nil } }
    func load() async {
        guard current else { return }; let visit = generation; readGeneration += 1; let read = readGeneration; loading = true; defer { if read == readGeneration { loading = false } }
        do { let value = try await transport.botPeerExchange(botId: botID, exchangeId: exchangeID); guard current, visit == generation, read == readGeneration else { return }; try apply(value, authoritative: true) }
        catch { if current, visit == generation { message = "The exchange couldn’t be loaded. Any pending Stop is kept." } }
    }
    private func apply(_ value: AidenPeerExchangeDetail, authoritative: Bool) throws {
        guard value.id == exchangeID, AidenPeerWire.owns(value.summary, botID: botID) else { throw AidenRemoteClientError.invalidResponse }
        detail = value
        if authoritative { needsRefresh = false }
        guard let nonce = pending?.nonce, let receipt = value.summary.lastStop, receipt.mutationId == nonce else { protectedPendingNonce = nil; return }
        if receipt.state.terminal { pending = nil; protectedPendingNonce = nil; persist(settling: nonce); message = receipt.state == .blocked ? "Stop was blocked. This exchange remains unfinished; effects have not been undone." : receipt.state == .notRunning ? "No linked work was running." : "The host acknowledged Stop." }
        else { if authoritative { protectedPendingNonce = nonce }; message = receipt.state == .requested ? "Stop requested. Waiting for the host to acknowledge the linked work." : "Stop is uncertain. The exchange has not been reported as cancelled." }
    }
    func stop() async {
        guard canStop, let detail else { return }
        let attempt = AidenPeerAttempt(stop: .init(botId: botID, exchangeId: exchangeID, expectedRevision: detail.summary.revision), createdAt: Date())
        pending = attempt; guard persist() else { pending = nil; return }; await send(attempt, previousUnknown: false)
    }
    func retry(now: Date = Date()) async {
        guard canWrite, !busy, let pending else { return }
        let age = now.timeIntervalSince(pending.createdAt)
        if age >= 23 * 3600 { protectedPendingNonce = nil; await load() }
        guard self.pending == pending else { return }
        guard age >= 0, age < 23 * 3600 || protectedPendingNonce == pending.nonce else { message = "This Stop is too old to replay without the host’s matching pending receipt. Its outcome remains unknown; no new Stop was sent."; return }
        await send(pending, previousUnknown: true)
    }
    private func send(_ attempt: AidenPeerAttempt, previousUnknown: Bool) async {
        guard canWrite, !busy, let request = attempt.stop else { return }; let visit = generation; busy = true; defer { busy = false }
        do {
            let result = try await aidenBotWithin(.seconds(12)) { [transport] in try await transport.stopBotPeerExchange(request) }
            guard current, visit == generation, pending == attempt else { return }
            if let exchange = result.exchange { guard exchange.id == exchangeID, AidenPeerWire.owns(exchange.summary, botID: botID) else { throw AidenRemoteClientError.invalidResponse } }
            switch result {
            case let .accepted(exchange, nonce, _):
                guard nonce == request.mutationId, exchange.summary.lastStop?.mutationId == nonce else { throw AidenRemoteClientError.invalidResponse }
                try apply(exchange, authoritative: false)
            case let .rejected(code, _, exchange):
                needsRefresh = true
                if let exchange { try apply(exchange, authoritative: false) }; guard pending == attempt else { return }
                if code != .unavailable && !previousUnknown { pending = nil; persist(settling: request.mutationId) }
                message = pending == nil ? "Stop wasn’t accepted. Refresh the exchange before trying again." : "Stop may have been accepted. Refresh or check the same Stop; its original identity is kept."
            }
        } catch {
            guard current, visit == generation, pending == attempt else { return }
            if !previousUnknown && !aidenPeerFailureIsAmbiguous(error) { pending = nil; persist(settling: request.mutationId) }
            message = pending == nil ? "Stop wasn’t accepted." : "The Stop outcome is unknown. Refresh or check the same Stop before another action."
        }
    }
    func loadEvidence(_ kind: AidenOpenWorkEvidenceKind) async {
        guard current else { return }; let visit = generation; evidenceGeneration += 1; let read = evidenceGeneration; evidence = nil
        do {
            let value = try await transport.botPeerEvidence(botId: botID, exchangeId: exchangeID, kind: kind)
            guard current, visit == generation, read == evidenceGeneration else { return }
            guard value.exchangeId == exchangeID, value.kind == kind, let detail,
                  value.botId == (kind == .source ? detail.summary.sender.botId : detail.summary.recipient.botId) else { throw AidenRemoteClientError.invalidResponse }
            evidence = value
        } catch { if current, visit == generation { message = "The host couldn’t provide this evidence. It may no longer be retained." } }
    }
    func clearEvidence() { evidenceGeneration += 1; evidence = nil }
    @discardableResult private func persist(settling nonce: UUID? = nil) -> Bool {
        guard let store, let scope else { return true }
        do { try store.save(pending == nil ? nil : .init(attempt: pending), scope: scope, settling: nonce, generation: storageGeneration); return true }
        catch { let failure = error as NSError; persistenceFailure = "\(failure.domain):\(failure.code)"; storageBlocked = true; message = "This phone couldn’t safely retain Stop. New changes are blocked until its saved state is recovered."; return false }
    }
}
