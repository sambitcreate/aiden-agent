import SwiftUI
import XCTest
@testable import AidenOnTheGo

/// Holds scripted requests until the test lets them go. A latch: a release
/// that comes before its request is kept for it, several requests can wait at
/// once, a cancelled request stops waiting, and none waits longer than
/// `limit`, so no test can hang on it.
private final class TestGate: @unchecked Sendable {
    private let lock = NSLock()
    private let limit: Duration
    private var armed = false
    private var permits = 0
    private var order: [UUID] = []
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    /// Waits that ended (cancelled or timed out) before they began.
    private var ended: Set<UUID> = []

    init(limit: Duration = .seconds(10)) { self.limit = limit }

    var isHolding: Bool { lock.withLock { !waiters.isEmpty } }
    var holdingCount: Int { lock.withLock { waiters.count } }
    /// Whether requests wait for a `release()`.
    var isArmed: Bool { lock.withLock { armed } }

    /// From now on, each request waits for a `release()`. Arming starts with no
    /// releases kept, so none carries over from an earlier hold.
    func hold() {
        lock.withLock {
            if !armed { permits = 0 }
            armed = true
        }
    }

    func pass() async {
        let id = UUID()
        let limit = limit
        let timer = Task { [weak self] in
            try? await Task.sleep(for: limit)
            self?.end(id)
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let goNow = lock.withLock { () -> Bool in
                    if !armed || ended.remove(id) != nil { return true }
                    if permits > 0 {
                        permits -= 1
                        return true
                    }
                    order.append(id)
                    waiters[id] = continuation
                    return false
                }
                if goNow { continuation.resume() }
            }
        } onCancel: {
            self.end(id)
        }
        timer.cancel()
    }

    /// Lets the oldest waiting request go, or the next one if none waits yet.
    /// Unarmed, nothing waits and nothing is kept.
    func release() {
        let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard !order.isEmpty else {
                if armed { permits += 1 }
                return nil
            }
            return waiters.removeValue(forKey: order.removeFirst())
        }
        waiting?.resume()
    }

    /// Stops holding and lets every waiting request go.
    func releaseAll() {
        let waiting = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            armed = false
            permits = 0
            defer {
                order = []
                waiters = [:]
            }
            return order.compactMap { waiters[$0] }
        }
        for continuation in waiting { continuation.resume() }
    }

    private func end(_ id: UUID) {
        let waiting = lock.withLock { () -> CheckedContinuation<Void, Never>? in
            guard let continuation = waiters.removeValue(forKey: id) else {
                ended.insert(id)
                return nil
            }
            order.removeAll { $0 == id }
            return continuation
        }
        waiting?.resume()
    }
}

/// A scripted host for `AidenBotSessionModel`. Every request is recorded so a
/// test can assert what reached the Mac.
private final class FakeBotSessionTransport: AidenBotSessionTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _sessions: [Result<AidenBotSession, Error>] = []
    private var _streams: [(events: [AidenBotSessionEvent], staysOpen: Bool)] = []
    private var _sessionRequests = 0
    private var _streamRequests = 0
    private var _resumeKeys: [UUID] = []
    private var _sendKeys: [UUID] = []
    private var _sendTexts: [String] = []
    private var _sendModes: [AidenStreamInputMode?] = []
    private var _sendAttachmentIds: [[String]?] = []
    private var _uploads: [AidenAttachmentUpload] = []
    private var _uploadFailures: Set<Int> = []
    private var _removedAttachmentIds: [String] = []
    private var _streamErrors: [Error] = []
    private var _sendErrors: [Error] = []
    private var _keyErrors: [UUID: Error] = [:]
    private var _connectionKeys: [UUID] = []
    private var _resumeResults: [Result<AidenBotSessionStateView, Error>] = []
    private var _connectionError: Error?
    private var _proposalRequests: [(proposalId: String, decision: AidenBotRoutineProposalDecision, key: UUID)] = []
    private var _proposalResults: [Result<AidenBotRoutineProposalRespondResult, Error>] = []
    let resumeGate = TestGate()
    let sendGate = TestGate()
    let stopGate = TestGate()
    /// Holds each Resume until `releaseResume()`.
    var holdResume: Bool {
        get { resumeGate.isArmed }
        set { if newValue { resumeGate.hold() } else { resumeGate.releaseAll() } }
    }
    /// Holds each message request until `releaseSend()`.
    var holdSend: Bool {
        get { sendGate.isArmed }
        set { if newValue { sendGate.hold() } else { sendGate.releaseAll() } }
    }
    /// Holds each Stop until `releaseStop()`.
    var holdStop: Bool {
        get { stopGate.isArmed }
        set { if newValue { stopGate.hold() } else { stopGate.releaseAll() } }
    }
    private var _stopResults: [Result<AidenBotSessionStateView, Error>] = []
    private var _stopKeys: [UUID] = []
    private var _receiptIDs: [String] = []
    private var _dismissResults: [Result<AidenBotSessionStateView, Error>] = []
    let dismissGate = TestGate()
    let proposalGate = TestGate()
    /// Holds `GET /session` while armed.
    let sessionGate = TestGate()

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func queueSession(_ result: Result<AidenBotSession, Error>) { locked { _sessions.append(result) } }
    func queueStream(_ events: [AidenBotSessionEvent], staysOpen: Bool = false) { locked { _streams.append((events, staysOpen)) } }
    /// The next stream fails at once with `error`.
    func queueStreamFailure(_ error: Error) {
        locked {
            _streams.append(([], false))
            _streamErrors.append(error)
        }
    }
    func queueResume(_ result: Result<AidenBotSessionStateView, Error>) { locked { _resumeResults.append(result) } }
    func failConnections(with error: Error) { locked { _connectionError = error } }
    func failNextSend(with error: Error) { locked { _sendErrors.append(error) } }
    /// Every request under `key` fails with `error` from now on, as the Mac's ledger replays it.
    func answerKey(_ key: UUID, with error: Error) { locked { _keyErrors[key] = error } }
    func queueStop(_ result: Result<AidenBotSessionStateView, Error>) { locked { _stopResults.append(result) } }
    var isHoldingSend: Bool { sendGate.isHolding }
    var isHoldingResume: Bool { resumeGate.isHolding }
    /// The submission ids the next receipts carry, in order; "17" once they run out.
    func queueReceiptID(_ id: String) { locked { _receiptIDs.append(id) } }
    func queueDismiss(_ result: Result<AidenBotSessionStateView, Error>) { locked { _dismissResults.append(result) } }
    var isHoldingStop: Bool { stopGate.isHolding }
    var stopKeys: [UUID] { locked { _stopKeys } }
    func queueProposalResult(_ result: Result<AidenBotRoutineProposalRespondResult, Error>) {
        locked { _proposalResults.append(result) }
    }
    var proposalRequests: [(proposalId: String, decision: AidenBotRoutineProposalDecision, key: UUID)] {
        locked { _proposalRequests }
    }

    var sessionRequests: Int { locked { _sessionRequests } }
    var streamRequests: Int { locked { _streamRequests } }
    var resumeKeys: [UUID] { locked { _resumeKeys } }
    var sendKeys: [UUID] { locked { _sendKeys } }
    var sendTexts: [String] { locked { _sendTexts } }
    var sendModes: [AidenStreamInputMode?] { locked { _sendModes } }
    var sendAttachmentIds: [[String]?] { locked { _sendAttachmentIds } }
    var uploads: [AidenAttachmentUpload] { locked { _uploads } }
    var removedAttachmentIds: [String] { locked { _removedAttachmentIds } }
    /// The upload at this zero-based position fails.
    func failUpload(at index: Int) { locked { _ = _uploadFailures.insert(index) } }
    var connectionKeys: [UUID] { locked { _connectionKeys } }

    func releaseResume() { resumeGate.release() }
    func releaseSend() { sendGate.release() }
    func releaseStop() { stopGate.release() }

    func botSession(botId: String) async throws -> AidenBotSession {
        locked { _sessionRequests += 1 }
        await sessionGate.pass()
        let next = locked { () -> Result<AidenBotSession, Error>? in
            return _sessions.isEmpty ? nil : _sessions.removeFirst()
        }
        guard let next else { throw URLError(.notConnectedToInternet) }
        return try next.get()
    }

    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> {
        let (next, failure) = locked { () -> ((events: [AidenBotSessionEvent], staysOpen: Bool), Error?) in
            _streamRequests += 1
            let next: (events: [AidenBotSessionEvent], staysOpen: Bool) = _streams.isEmpty ? ([], false) : _streams.removeFirst()
            let failure: Error? = next.events.isEmpty && !next.staysOpen && !_streamErrors.isEmpty ? _streamErrors.removeFirst() : nil
            return (next, failure)
        }
        return AsyncThrowingStream { continuation in
            for event in next.events { continuation.yield(event) }
            // A stream that stays open ends only when its listener is cancelled.
            if next.staysOpen { return }
            if next.events.isEmpty {
                continuation.finish(throwing: failure ?? URLError(.networkConnectionLost))
            } else {
                continuation.finish()
            }
        }
    }

    func sendBotMessage(
        botId: String,
        request: AidenBotMessageRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotMessageReceipt {
        let error = locked { () -> Error? in
            _sendKeys.append(idempotencyKey)
            _sendTexts.append(request.text)
            _sendModes.append(request.whenBusy)
            _sendAttachmentIds.append(request.attachmentIds)
            if let replayed = _keyErrors[idempotencyKey] { return replayed }
            return _sendErrors.isEmpty ? nil : _sendErrors.removeFirst()
        }
        await sendGate.pass()
        if let error { throw error }
        let id = locked { _receiptIDs.isEmpty ? "17" : _receiptIDs.removeFirst() }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotMessageReceipt.self,
            from: Data(#"{"submissionId":"\#(id)","deduped":false,"state":"running","interrupted":false}"#.utf8)
        )
    }

    func uploadBotAttachment(botId: String, upload: AidenAttachmentUpload) async throws -> AidenAttachmentReference {
        let (index, fails) = locked { () -> (Int, Bool) in
            _uploads.append(upload)
            return (_uploads.count - 1, _uploadFailures.contains(_uploads.count - 1))
        }
        if fails { throw URLError(.networkConnectionLost) }
        let (name, mimeType, kind, size): (String, String, String, Int) = switch upload {
        case let .image(name, mimeType, data): (name, mimeType, "image", data.count)
        case let .text(name, mimeType, text): (name, mimeType, "text", text.utf8.count)
        }
        let id = "att_" + String(repeating: Character(String(UnicodeScalar(UInt8(65 + index)))), count: 43)
        return try AidenRemoteJSONDecoder.decode(
            AidenAttachmentReference.self,
            from: Data(#"{"id":"\#(id)","name":"\#(name)","mimeType":"\#(mimeType)","kind":"\#(kind)","size":\#(size),"expiresAt":"2099-01-01T00:00:00.000Z"}"#.utf8)
        )
    }

    func removeBotAttachment(botId: String, attachmentId: String) async throws {
        locked { _removedAttachmentIds.append(attachmentId) }
    }

    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        locked { _resumeKeys.append(idempotencyKey) }
        await resumeGate.pass()
        let next = locked { _resumeResults.isEmpty ? nil : _resumeResults.removeFirst() }
        return try (next ?? .success(try AidenBotSessionStateView(state: .running))).get()
    }

    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        await dismissGate.pass()
        let next = locked { _dismissResults.isEmpty ? nil : _dismissResults.removeFirst() }
        return try (next ?? .success(try AidenBotSessionStateView(state: .idle))).get()
    }

    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        locked { _stopKeys.append(idempotencyKey) }
        await stopGate.pass()
        let next = locked { _stopResults.isEmpty ? nil : _stopResults.removeFirst() }
        return try (next ?? .success(try AidenBotSessionStateView(state: .idle))).get()
    }

    func answerBotQuestion(
        botId: String,
        waitId: String,
        request: AidenQuestionRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotQuestionAnswerReceipt {
        throw URLError(.unsupportedURL)
    }

    func respondToApproval(
        id: String,
        decision: AidenApprovalDecision,
        scope: AidenApprovalScope?,
        idempotencyKey: UUID
    ) async throws -> AidenApprovalResponse {
        throw URLError(.unsupportedURL)
    }

    func requestBotConnection(
        botId: String,
        request: AidenBotConnectionRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotConnectionRequestReceipt {
        let error = locked { () -> Error? in
            _connectionKeys.append(idempotencyKey)
            return _connectionError
        }
        if let error { throw error }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotConnectionRequestReceipt.self,
            from: Data(#"{"pluginId":"\#(request.pluginId)","name":"Gmail","status":"sent"}"#.utf8)
        )
    }

    func respondToBotRoutineProposal(
        botId: String,
        proposalId: String,
        request: AidenBotRoutineProposalRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotRoutineProposalRespondResult {
        let next = locked { () -> Result<AidenBotRoutineProposalRespondResult, Error>? in
            _proposalRequests.append((proposalId, request.decision, idempotencyKey))
            return _proposalResults.isEmpty ? nil : _proposalResults.removeFirst()
        }
        await proposalGate.pass()
        guard let next else { throw URLError(.notConnectedToInternet) }
        return try next.get()
    }
}

@MainActor
final class AidenBotSessionTests: XCTestCase {
    private let botID = "bot_fixture_01"

    // MARK: Builders

    private func message(_ id: String, _ role: AidenBotSessionMessageRole, _ text: String, interrupted: Bool = false) -> AidenBotSessionEntry {
        .message(AidenBotSessionMessage(id: id, role: role, text: text, createdAt: nil, label: nil, interrupted: interrupted))
    }

    private func session(
        epoch: String = "epoch_a",
        seq: Int,
        state: AidenBotSessionStateKind = .idle,
        blocked: AidenBotSessionBlockedReason? = nil,
        partial: String? = nil,
        entries: [AidenBotSessionEntry]
    ) throws -> AidenBotSession {
        AidenBotSession(
            botId: botID,
            epoch: epoch,
            seq: seq,
            stateView: try AidenBotSessionStateView(state: state, blocked: blocked),
            partial: partial,
            entries: entries,
            hasOlder: false
        )
    }

    private func event(epoch: String = "epoch_a", seq: Int, _ kind: AidenBotSessionEvent.Kind) -> AidenBotSessionEvent {
        AidenBotSessionEvent(botId: botID, epoch: epoch, seq: seq, kind: kind)
    }

    private func loadedModel(
        _ transport: FakeBotSessionTransport,
        _ initial: AidenBotSession
    ) async -> AidenBotSessionModel {
        transport.queueSession(.success(initial))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        return model
    }

    private func serverError(status: Int, code: String, message: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"\#(message)","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    private func object(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func decodes<T: Decodable>(_ type: T.Type, _ object: Any) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return false }
        return (try? AidenRemoteJSONDecoder.decode(type, from: data)) != nil
    }

    private func sharedFixture() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    // MARK: (epoch, seq) ordering

    func testFramesApplyInOrderAndStaleOrRepeatedFramesAreIgnored() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 4, entries: [message("m1", .user, "Hi")]))

        let partial = await model.apply(event(seq: 5, .partial("Hel")))
        XCTAssertEqual(partial, .applied)
        XCTAssertEqual(model.partial, "Hel")

        let answer = message("m2", .assistant, "Hello")
        let appended = await model.apply(event(seq: 6, .entry(answer)))
        XCTAssertEqual(appended, .applied)
        XCTAssertEqual(model.entries.map(\.id), ["m1", "m2"])
        XCTAssertNil(model.partial, "A new assistant answer replaces the streamed text.")

        let repeated = await model.apply(event(seq: 6, .entry(message("m3", .user, "duplicate"))))
        XCTAssertEqual(repeated, .ignored)
        let stale = await model.apply(event(seq: 2, .partial("old")))
        XCTAssertEqual(stale, .ignored)
        XCTAssertEqual(model.entries.map(\.id), ["m1", "m2"])
        XCTAssertNil(model.partial)
        XCTAssertEqual(model.seq, 6)
        XCTAssertEqual(transport.sessionRequests, 1, "Ordered and stale frames never refetch.")
    }

    func testGapRefetchesTheSessionAndAdoptsItsCursor() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 4, entries: [message("m1", .user, "Hi")]))
        transport.queueSession(.success(try session(seq: 9, entries: [
            message("m1", .user, "Hi"), message("m2", .assistant, "Hello"),
        ])))

        let outcome = await model.apply(event(seq: 7, .partial("skipped ahead")))

        XCTAssertEqual(outcome, .refetched)
        XCTAssertEqual(transport.sessionRequests, 2)
        XCTAssertEqual(model.seq, 9)
        XCTAssertEqual(model.entries.map(\.id), ["m1", "m2"])
        XCTAssertNil(model.partial, "The gapped frame itself is not applied.")
        let next = await model.apply(event(seq: 10, .partial("Next")))
        XCTAssertEqual(next, .applied)
        XCTAssertEqual(model.partial, "Next")
    }

    func testFrameFromAnotherEpochRefetchesEvenWithTheNextSeq() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 4, entries: [message("m1", .user, "Hi")]))
        transport.queueSession(.success(try session(epoch: "epoch_b", seq: 1, entries: [
            .notice(id: "n1", notice: .sessionReset),
        ])))

        let outcome = await model.apply(event(epoch: "epoch_b", seq: 5, .partial("Reopened")))

        XCTAssertEqual(outcome, .refetched)
        XCTAssertEqual(model.epoch, "epoch_b")
        XCTAssertEqual(model.seq, 1)
        XCTAssertEqual(model.entries.map(\.id), ["n1"])
        let oldEpoch = await model.apply(event(epoch: "epoch_a", seq: 5, .partial("late")))
        XCTAssertNotEqual(oldEpoch, .applied, "A frame from the previous epoch cannot be applied.")
        XCTAssertNil(model.partial)
        XCTAssertEqual(transport.sessionRequests, 3)
    }

    func testFailedRefetchKeepsTheTranscriptAndEndsTheConnection() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 4, entries: [message("m1", .user, "Hi")]))

        let outcome = await model.apply(event(seq: 8, .partial("gap")))

        XCTAssertEqual(outcome, .closed, "The next connection starts with a snapshot.")
        XCTAssertEqual(model.entries.map(\.id), ["m1"], "The chat does not go blank.")
        XCTAssertNotNil(model.errorMessage)
    }

    func testMidStreamSnapshotReplacesEntriesPartialStateAndCursor() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(
            seq: 20,
            state: .running,
            partial: "Working",
            entries: [message("m1", .user, "routine input"), message("m2", .assistant, "[SILENT]")]
        ))

        let rewritten = try session(seq: 21, state: .idle, entries: [message("m0", .user, "Hi")])
        let outcome = await model.apply(event(seq: 21, .snapshot(rewritten)))

        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(model.entries.map(\.id), ["m0"])
        XCTAssertNil(model.partial)
        XCTAssertEqual(model.state, .idle)
        XCTAssertEqual(model.seq, 21)
        XCTAssertEqual(transport.sessionRequests, 1, "A snapshot frame never needs a refetch.")
    }

    func testEntryWithAKnownIDReplacesItInPlaceAndEmptyPartialClears() async throws {
        let transport = FakeBotSessionTransport()
        let card = AidenBotConnectCard(
            id: "c1", pluginId: "gmail", name: "Gmail", iconId: "gmail",
            reason: "Read your mail.", status: .pending
        )
        let model = await loadedModel(transport, try session(
            seq: 1,
            state: .running,
            partial: "Still typing",
            entries: [message("m1", .assistant, "Part"), .connectCard(card)]
        ))

        let connected = AidenBotConnectCard(
            id: "c1", pluginId: "gmail", name: "Gmail", iconId: "gmail",
            reason: "Read your mail.", status: .connected
        )
        _ = await model.apply(event(seq: 2, .entry(.connectCard(connected))))
        XCTAssertEqual(model.entries.count, 2)
        XCTAssertEqual(model.entries.last, .connectCard(connected))
        XCTAssertEqual(model.partial, "Still typing", "A card update does not drop the streamed text.")

        _ = await model.apply(event(seq: 3, .entry(message("m1", .assistant, "Part", interrupted: true))))
        XCTAssertEqual(model.entries.map(\.id), ["m1", "c1"])
        XCTAssertEqual(model.entries.first, message("m1", .assistant, "Part", interrupted: true))

        _ = await model.apply(event(seq: 4, .partial("")))
        XCTAssertNil(model.partial)
    }

    func testSlowerSnapshotFetchCannotRollBackAppliedFrames() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 4, entries: [message("m1", .user, "Hi")]))
        _ = await model.apply(event(seq: 5, .entry(message("m2", .assistant, "Hello"))))

        transport.queueSession(.success(try session(seq: 4, entries: [message("m1", .user, "Hi")])))
        await model.load()

        XCTAssertEqual(model.seq, 5)
        XCTAssertEqual(model.entries.map(\.id), ["m1", "m2"])
    }

    func testClosedEndsTheConnectionAndListenReconnectsForANewSnapshot() async throws {
        let transport = FakeBotSessionTransport()
        transport.queueStream([
            event(seq: 3, .snapshot(try session(seq: 3, entries: [message("m1", .user, "Hi")]))),
            event(seq: 4, .closed),
            event(seq: 5, .partial("never applied")),
        ])
        transport.queueStream([
            event(epoch: "epoch_b", seq: 1, .snapshot(try session(epoch: "epoch_b", seq: 1, entries: []))),
        ])
        let model = AidenBotSessionModel(botID: botID, transport: transport)

        let listener = Task { await model.listen() }
        let deadline = Date().addingTimeInterval(5)
        while model.epoch != "epoch_b", Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        listener.cancel()
        await listener.value

        XCTAssertEqual(model.epoch, "epoch_b")
        XCTAssertGreaterThanOrEqual(transport.streamRequests, 2)
    }

    func testListenStopsWhenItsTaskIsCancelled() async throws {
        let transport = FakeBotSessionTransport()
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        let listener = Task { await model.listen() }
        try await Task.sleep(for: .milliseconds(50))
        listener.cancel()
        await listener.value
        let requests = transport.streamRequests
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertEqual(transport.streamRequests, requests, "A cancelled chat stops reconnecting.")
    }

    // MARK: Turn controls

    func testResumeDoubleTapSendsOneRequestAndEachTapGetsItsOwnKey() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 1, state: .interrupted, entries: []))
        transport.holdResume = true

        let first = Task { await model.resume() }
        let deadline = Date().addingTimeInterval(5)
        while !transport.isHoldingResume {
            guard Date() < deadline else { return XCTFail("Timed out waiting for the Resume request") }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(model.inFlight.contains(.resume), "The card disables its buttons while resuming.")
        await model.resume()
        XCTAssertEqual(transport.resumeKeys.count, 1, "A second tap while in flight sends nothing.")
        transport.releaseResume()
        await first.value
        XCTAssertEqual(model.state, .running)

        transport.holdResume = false
        transport.queueSession(.success(try session(seq: 2, state: .interrupted, entries: [])))
        await model.load()
        await model.resume()
        XCTAssertEqual(transport.resumeKeys.count, 2)
        XCTAssertNotEqual(transport.resumeKeys[0], transport.resumeKeys[1])
    }

    func testAmbiguousResumeFailureRetriesWithTheSameKey() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 1, state: .interrupted, entries: []))
        transport.queueResume(.failure(URLError(.networkConnectionLost)))

        await model.resume()
        XCTAssertNotNil(model.errorMessage)
        await model.resume()

        XCTAssertEqual(transport.resumeKeys.count, 2)
        XCTAssertEqual(transport.resumeKeys[0], transport.resumeKeys[1])
    }

    func testResumeIsNotSentWhenAccessChanged() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(
            transport,
            try session(seq: 1, state: .interrupted, blocked: .accessChanged, entries: [])
        )
        XCTAssertTrue(model.isAccessBlocked)
        await model.resume()
        XCTAssertTrue(transport.resumeKeys.isEmpty)
        XCTAssertEqual(AidenBotSessionCopy.accessChanged, "This Bot's access changed. Review it in Advanced.")
    }

    func testSendingWhileInterruptedIsAllowedAndANeedsModelBotSendsNothing() async throws {
        let paused = FakeBotSessionTransport()
        let pausedModel = await loadedModel(paused, try session(seq: 1, state: .interrupted, entries: []))
        let sent = await pausedModel.send("Never mind, do this instead")
        XCTAssertTrue(sent)
        XCTAssertEqual(paused.sendKeys.count, 1)
        XCTAssertEqual(pausedModel.state, .running)

        let noModel = FakeBotSessionTransport()
        let noModelModel = await loadedModel(noModel, try session(seq: 1, state: .needsModel, entries: []))
        let refused = await noModelModel.send("Hello")
        XCTAssertFalse(refused)
        XCTAssertTrue(noModel.sendKeys.isEmpty)
    }

    func testConnectionRequestForAnUnknownAppShowsTheMacReasonAndCanBeTriedAgain() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 1, entries: []))
        transport.failConnections(with: try serverError(status: 404, code: "not_found", message: "Aiden can't connect that app."))

        await model.requestConnection(pluginId: "unknown-app")

        XCTAssertEqual(model.errorMessage, "Aiden can't connect that app.")
        XCTAssertFalse(model.sentConnectionRequests.contains("unknown-app"), "Finish on your Mac is offered again.")
        await model.requestConnection(pluginId: "unknown-app")
        XCTAssertEqual(transport.connectionKeys.count, 2)
        XCTAssertNotEqual(transport.connectionKeys[0], transport.connectionKeys[1], "A definitive 404 does not pin the key.")
    }

    // MARK: Failed turns

    private func failedTurn(_ id: String, retryText: String?) -> AidenBotSessionEntry {
        .failedTurn(AidenBotFailedTurn(id: id, createdAt: nil, retryText: retryText))
    }

    func testRetrySendsTheFailedTextAsANewSubmission() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 1, entries: [
            message("m1", .user, "Plan my week, please."),
            failedTurn("m1:failed", retryText: "Plan my week, please."),
        ]))
        // The original message went out under its own key earlier.
        _ = await model.send("Plan my week, please.")
        let originalKey = try XCTUnwrap(transport.sendKeys.first)

        XCTAssertEqual(model.retryableFailedTurn?.id, "m1:failed")
        let retried = await model.retry()

        XCTAssertTrue(retried)
        XCTAssertEqual(transport.sendTexts.last, "Plan my week, please.")
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertNotEqual(transport.sendKeys[1], originalKey, "A Retry never reuses the original message's key.")
        XCTAssertEqual(model.state, .running)
    }

    func testALostRetryKeepsItsKeyUntilTheMacIsBackAndAnotherFailedTurnGetsANewOne() async throws {
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(seq: 1, entries: [failedTurn("t1:failed", retryText: "First")])))
        let model = AidenBotSessionModel(botID: botID, transport: transport, retryDelays: [.seconds(60)])
        await model.load()
        transport.failNextSend(with: URLError(.networkConnectionLost))
        transport.failNextSend(with: URLError(.networkConnectionLost))

        let taken = await model.retry()
        XCTAssertTrue(taken, "the Retry shows at once and waits for the Mac")
        XCTAssertEqual(model.outgoing.map(\.text), ["First"])
        XCTAssertNil(model.retryableFailedTurn, "one Retry at a time")
        let again = await model.retry()
        XCTAssertFalse(again)
        for seq in 2...3 {
            transport.queueSession(.success(try session(seq: seq, entries: [failedTurn("t1:failed", retryText: "First")])))
            await model.load()
        }
        XCTAssertEqual(transport.sendKeys.count, 3)
        XCTAssertEqual(Set(transport.sendKeys).count, 1, "every attempt of the Retry replays one request")

        await model.apply(event(seq: 4, .entry(failedTurn("t2:failed", retryText: "Second"))))
        _ = await model.retry()
        XCTAssertEqual(transport.sendTexts.last, "Second")
        XCTAssertNotEqual(transport.sendKeys[3], transport.sendKeys[2], "a different failed turn is a new request")
    }

    func testOnlyTheNewestFailedTurnWithTextCanBeRetried() async throws {
        let transport = FakeBotSessionTransport()
        let superseded = await loadedModel(transport, try session(seq: 1, entries: [
            failedTurn("t1:failed", retryText: "Hello"),
            message("m2", .user, "Something else"),
        ]))
        XCTAssertNil(superseded.retryableFailedTurn)
        let sentSuperseded = await superseded.retry()
        XCTAssertFalse(sentSuperseded)

        let noText = await loadedModel(transport, try session(seq: 1, entries: [
            failedTurn("t2:failed", retryText: nil),
        ]))
        XCTAssertNil(noText.retryableFailedTurn)
        let sentNoText = await noText.retry()
        XCTAssertFalse(sentNoText)
        XCTAssertTrue(transport.sendKeys.isEmpty)
    }

    func testFailedTurnDecoderMatchesTheSharedFixtureAndRejectsWhatTheHostRejects() throws {
        let fixture = try sharedFixture()
        let turns = try XCTUnwrap(fixture["botSessionFailedTurns"] as? [[String: Any]])
        XCTAssertEqual(turns.count, 2)
        let decoded = try turns.map {
            try AidenRemoteJSONDecoder.decode(AidenBotSessionEntry.self, from: JSONSerialization.data(withJSONObject: $0))
        }
        guard case let .failedTurn(first) = decoded[0], case let .failedTurn(second) = decoded[1] else {
            return XCTFail("Both fixture entries are failed turns.")
        }
        XCTAssertEqual(first.retryText, "Plan my week, please.")
        XCTAssertNotNil(first.createdAt)
        XCTAssertEqual(second.id, turns[1]["id"] as? String)
        XCTAssertNil(second.retryText)
        XCTAssertNil(second.createdAt)

        // Round trip keeps the shape the host accepts.
        let reencoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded[1])) as? [String: Any]
        XCTAssertEqual(Set((reencoded ?? [:]).keys), ["type", "id"])
        XCTAssertEqual(try AidenRemoteJSONDecoder.decode(
            AidenBotSessionEntry.self,
            from: JSONEncoder().encode(decoded[0])
        ), decoded[0])

        var emptyText = turns[0]
        emptyText["retryText"] = ""
        XCTAssertFalse(decodes(AidenBotSessionEntry.self, emptyText))
        var extraKey = turns[0]
        extraKey["errorMessage"] = "Model overloaded"
        XCTAssertFalse(decodes(AidenBotSessionEntry.self, extraKey))
        var badID = turns[1]
        badID["id"] = ""
        XCTAssertFalse(decodes(AidenBotSessionEntry.self, badID))
        var tooLong = turns[0]
        tooLong["retryText"] = String(repeating: "a", count: AidenBotSessionWire.maxTextLength + 1)
        XCTAssertFalse(decodes(AidenBotSessionEntry.self, tooLong))

        // The older entry kinds still decode beside it.
        XCTAssertTrue(decodes(AidenBotSessionEntry.self, try object(#"{"type":"message","id":"m1","role":"user","text":"Hi"}"#)))
        XCTAssertTrue(decodes(AidenBotSessionEntry.self, try object(#"{"type":"notice","id":"n1","notice":"session_reset"}"#)))
        XCTAssertTrue(decodes(AidenBotSessionEntry.self, try object(
            #"{"type":"connect_card","id":"c1","pluginId":"gmail","name":"Gmail","iconId":"gmail","reason":"To read mail","status":"pending"}"#
        )))
    }

    // MARK: Files in the chat menu

    private func conversation(chatID: String, botID: String, updatedAt: String) throws -> AidenBotConversationItem {
        let object: [String: Any] = [
            "chatId": chatID,
            "botId": botID,
            "title": "",
            "activityState": "idle",
            "canRespondToApproval": false,
            "createdAt": "2026-08-18T17:00:00.000Z",
            "updatedAt": updatedAt,
            "revision": "rev-\(chatID)",
        ]
        return try AidenRemoteJSONDecoder.decode(
            AidenBotConversationItem.self,
            from: JSONSerialization.data(withJSONObject: object)
        )
    }

    func testFilesOpenThisBotsCanonicalConversation() throws {
        let conversations = [
            try conversation(chatID: "chat_other", botID: "bot_other", updatedAt: "2026-08-19T12:00:00.000Z"),
            try conversation(chatID: "chat_old", botID: botID, updatedAt: "2026-08-18T18:00:00.000Z"),
            try conversation(chatID: "chat_new", botID: botID, updatedAt: "2026-08-19T09:00:00.000Z"),
        ]
        XCTAssertEqual(aidenBotSessionConversationChatID(botID: botID, conversations: conversations), "chat_new")
        XCTAssertNil(
            aidenBotSessionConversationChatID(botID: botID, conversations: [conversations[0]]),
            "Another Bot's conversation is never opened."
        )
        XCTAssertNil(aidenBotSessionConversationChatID(botID: botID, conversations: []))
    }

    // MARK: Feature gating

    func testOlderHostsKeepTheChatPathWithoutTheDurableSessionToken() {
        XCTAssertEqual(AidenBotChatRoute.resolve(botID: botID, hostFeatures: nil), .legacyChat)
        XCTAssertEqual(AidenBotChatRoute.resolve(botID: botID, hostFeatures: ["bot-delete-v1"]), .legacyChat)
        XCTAssertEqual(
            AidenBotChatRoute.resolve(botID: botID, hostFeatures: ["bot-durable-session-v1"]),
            .durableSession(botID: botID)
        )
    }

    // MARK: Live stream framing

    func testSessionStreamParserAcceptsTheHostEpochSeqCursor() throws {
        let fixture = try sharedFixture()
        let frames = try XCTUnwrap(fixture["botSessionEvents"] as? [[String: Any]])
        let partial = try XCTUnwrap(frames.first { $0["type"] as? String == "partial" })
        let json = String(decoding: try JSONSerialization.data(withJSONObject: partial), as: UTF8.self)
        let epoch = try XCTUnwrap(partial["epoch"] as? String)
        let seq = try XCTUnwrap(partial["seq"] as? Int)

        func parse(id: String?, event name: String = "partial") throws -> AidenBotSessionEvent? {
            var parser = AidenBotSessionSSEParser()
            var lines = [String]()
            if let id { lines.append("id: \(id)") }
            lines += ["event: \(name)", "data: \(json)", ""]
            var parsed: AidenBotSessionEvent?
            for line in lines { parsed = try parser.consume(line: line) ?? parsed }
            return parsed
        }

        let parsed = try XCTUnwrap(try parse(id: "\(epoch):\(seq)"))
        XCTAssertEqual(parsed.seq, seq)
        XCTAssertEqual(parsed.epoch, epoch)
        XCTAssertNotNil(try parse(id: nil))
        XCTAssertThrowsError(try parse(id: "\(epoch):\(seq + 1)"))
        XCTAssertThrowsError(try parse(id: "other_epoch:\(seq)"))
        XCTAssertThrowsError(try parse(id: "\(epoch):\(seq)", event: "entry"))
    }

    // MARK: Strict wire parity with the host parsers

    func testSessionDecoderRejectsWhatTheHostRejects() throws {
        let fixture = try sharedFixture()
        let base = try XCTUnwrap(fixture["botSession"] as? [String: Any])
        XCTAssertTrue(decodes(AidenBotSession.self, base))

        func rejects(_ label: String, _ mutate: (inout [String: Any]) -> Void) {
            var copy = base
            mutate(&copy)
            XCTAssertFalse(decodes(AidenBotSession.self, copy), label)
        }
        let entries = try XCTUnwrap(base["entries"] as? [[String: Any]])
        let userMessage = try XCTUnwrap(entries.first { $0["role"] as? String == "user" })

        rejects("unknown key") { $0["future"] = true }
        rejects("negative seq") { $0["seq"] = -1 }
        rejects("fractional seq") { $0["seq"] = 1.5 }
        rejects("bad epoch") { $0["epoch"] = "epoch with spaces" }
        rejects("long epoch") { $0["epoch"] = String(repeating: "e", count: 65) }
        rejects("interrupted disagrees with state") { $0["interrupted"] = false }
        rejects("blocked outside interrupted") {
            $0["state"] = "idle"; $0["interrupted"] = false; $0["blocked"] = "access_changed"
        }
        rejects("unknown blocked reason") { $0["blocked"] = "quota" }
        rejects("unknown state") { $0["state"] = "paused"; $0["interrupted"] = false }
        rejects("too many entries") { session in
            session["entries"] = (0...AidenBotSessionWire.maxEntries).map { index in
                ["type": "notice", "id": "n\(index)", "notice": "session_reset"]
            }
        }
        rejects("duplicate entry ids") { $0["entries"] = [userMessage, userMessage] }
        rejects("oversized partial") { $0["partial"] = String(repeating: "a", count: 100_001) }
        rejects("missing hasOlder") { $0["hasOlder"] = nil }
        XCTAssertTrue(base.keys.contains("approval"), "the fixture carries the required approval key")
        rejects("missing approval") { $0["approval"] = nil }

        let approval: [String: Any] = [
            "waitId": "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6", "toolCallId": "call_1",
            "toolName": "mcp__mail__send_email", "summary": "Send an email", "canAllow": false,
        ]
        XCTAssertTrue(decodes(AidenBotSession.self, base.merging(["approval": approval]) { $1 }))
        func rejectsApproval(_ label: String, _ change: [String: Any]) {
            rejects(label) { $0["approval"] = approval.merging(change) { $1 } }
        }
        rejectsApproval("approval extra key", ["scope": "once"])
        rejectsApproval("approval wait id grammar", ["waitId": "wait_1"])
        rejectsApproval("approval wait id bound", ["waitId": String(repeating: "a", count: 65)])
        rejectsApproval("empty tool call id", ["toolCallId": ""])
        rejectsApproval("tool call id bound", ["toolCallId": String(repeating: "c", count: 129)])
        rejectsApproval("tool name bound", ["toolName": String(repeating: "t", count: 121)])
        rejectsApproval("empty summary", ["summary": ""])
        rejectsApproval("summary bound", ["summary": String(repeating: "s", count: 2_001)])
        rejectsApproval("canAllow is a boolean", ["canAllow": "yes"])
        rejects("approval missing canAllow") { session in
            var partialApproval = approval
            partialApproval["canAllow"] = nil
            session["approval"] = partialApproval
        }

        func rejectsEntry(_ label: String, _ entry: [String: Any]) {
            var copy = base
            copy["entries"] = [entry]
            XCTAssertFalse(decodes(AidenBotSession.self, copy), label)
        }
        var interruptedUser = userMessage
        interruptedUser["interrupted"] = true
        rejectsEntry("only assistant messages are interrupted", interruptedUser)
        var falseInterrupted = userMessage
        falseInterrupted["role"] = "assistant"
        falseInterrupted["interrupted"] = false
        rejectsEntry("interrupted is only ever true", falseInterrupted)
        var badID = userMessage
        badID["id"] = "entry/1"
        rejectsEntry("entry id grammar", badID)
        var longText = userMessage
        longText["text"] = String(repeating: "a", count: 100_001)
        rejectsEntry("message text bound", longText)
        var emptyLabel = userMessage
        emptyLabel["label"] = ""
        rejectsEntry("empty routine label", emptyLabel)
        rejectsEntry("unknown notice", ["type": "notice", "id": "n1", "notice": "deleted"])
        // Revision 27: an entry type this client does not know is skipped,
        // and the known entries around it still decode.
        let futureEntry: [String: Any] = ["type": "tool", "id": "t1", "anything": ["nested": true]]
        let mixedEntries: [[String: Any]] = [futureEntry, userMessage]
        let skipped = try AidenRemoteJSONDecoder.decode(
            AidenBotSession.self,
            from: JSONSerialization.data(withJSONObject: base.merging(["entries": mixedEntries]) { $1 })
        )
        XCTAssertEqual(skipped.entries.map(\.id), [try XCTUnwrap(userMessage["id"] as? String)])
        rejects("an unknown entry still needs a string type") { session in
            session["entries"] = [["id": "t1"]]
        }

        let proposal: [String: Any] = [
            "type": "routine_proposal", "id": "p1", "proposalId": "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11",
            "name": "Daily check-in", "prompt": "Check in briefly.", "label": "Every day at 9:00 AM",
            "status": "pending",
        ]
        XCTAssertTrue(decodes(AidenBotSession.self, base.merging(["entries": [proposal]]) { $1 }))
        rejectsEntry("proposal id grammar", proposal.merging(["proposalId": "proposal_1"]) { $1 })
        rejectsEntry("uppercase proposal id", proposal.merging(["proposalId": "7D0C5C8E-2F0B-4C4E-9A59-3B6F1F0E9A11"]) { $1 })
        rejectsEntry("only an accepted proposal names a routine", proposal.merging(["routineId": "task_1"]) { $1 })
        rejectsEntry("proposal status", proposal.merging(["status": "expired"]) { $1 })
        rejectsEntry("empty proposal prompt", proposal.merging(["prompt": ""]) { $1 })
        rejectsEntry("proposal extra key", proposal.merging(["schedule": ["kind": "daily", "time": "09:00"]]) { $1 })
        XCTAssertTrue(decodes(AidenBotSession.self, base.merging(["entries": [
            proposal.merging(["status": "accepted", "routineId": "task_fixture_routine_02"]) { $1 },
        ]]) { $1 }))
        let memoryUpdate: [String: Any] = ["type": "memory_update", "id": "mu1", "createdAt": "2026-08-19T15:02:00.000Z"]
        XCTAssertTrue(decodes(AidenBotSession.self, base.merging(["entries": [memoryUpdate]]) { $1 }))
        rejectsEntry("memory update extra key", memoryUpdate.merging(["text": "Prefers tea"]) { $1 })
        rejectsEntry("memory update id grammar", memoryUpdate.merging(["id": "mu 1"]) { $1 })
        let card: [String: Any] = [
            "type": "connect_card", "id": "c1", "pluginId": "gmail", "name": "Gmail",
            "iconId": "gmail", "reason": "Mail", "status": "pending",
        ]
        XCTAssertTrue(decodes(AidenBotSession.self, base.merging(["entries": [card]]) { $1 }))
        rejectsEntry("card status", card.merging(["status": "failed"]) { $1 })
        rejectsEntry("plugin id grammar", card.merging(["pluginId": "Gmail"]) { $1 })
        rejectsEntry("reason bound", card.merging(["reason": String(repeating: "r", count: 281)]) { $1 })
        rejectsEntry("card extra key", card.merging(["url": "https://example.com"]) { $1 })
    }

    func testSessionEventDecoderRejectsWhatTheHostRejects() throws {
        let fixture = try sharedFixture()
        let frames = try XCTUnwrap(fixture["botSessionEvents"] as? [[String: Any]])
        XCTAssertTrue(frames.allSatisfy { decodes(AidenBotSessionEvent.self, $0) })
        let snapshot = try XCTUnwrap(frames.first { $0["type"] as? String == "snapshot" })
        let partial = try XCTUnwrap(frames.first { $0["type"] as? String == "partial" })

        XCTAssertFalse(decodes(AidenBotSessionEvent.self, snapshot.merging(["seq": 99]) { $1 }),
                       "A snapshot frame must carry its session's cursor.")
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, partial.merging(["protocolVersion": 2]) { $1 }))
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, partial.merging(["type": "delta"]) { $1 }))
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, partial.merging(["future": 1]) { $1 }))
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, partial.merging(["payload": ["text": "a", "x": 1]]) { $1 }))
        var closed = partial
        closed["type"] = "closed"
        closed["payload"] = [String: Any]()
        XCTAssertTrue(decodes(AidenBotSessionEvent.self, closed))
        closed["payload"] = ["reason": "deleted"]
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, closed))
        var state = partial
        state["type"] = "state"
        state["payload"] = ["state": "idle", "interrupted": false]
        XCTAssertTrue(decodes(AidenBotSessionEvent.self, state))
        state["payload"] = ["state": "idle", "interrupted": false, "partial": "x"]
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, state))

        // The approval frames at the end of the fixture: one shows a card, the
        // next settles it, and both survive an encode/decode round trip.
        let approvalFrames = frames.filter { $0["type"] as? String == "approval" }
        XCTAssertEqual(approvalFrames.count, 2)
        let decoded = try approvalFrames.map {
            try AidenRemoteJSONDecoder.decode(AidenBotSessionEvent.self, from: JSONSerialization.data(withJSONObject: $0))
        }
        guard case let .approval(shown?) = decoded[0].kind, case .approval(nil) = decoded[1].kind else {
            return XCTFail("approval frames decode to a card and then a settlement")
        }
        XCTAssertEqual(shown.waitId, "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6")
        XCTAssertTrue(shown.canAllow)
        for event in decoded {
            let reencoded = try AidenRemoteJSONDecoder.decode(AidenBotSessionEvent.self, from: JSONEncoder().encode(event))
            XCTAssertEqual(reencoded, event)
            XCTAssertEqual(reencoded.wireType, "approval")
        }
        let snapshotEvent = try AidenRemoteJSONDecoder.decode(
            AidenBotSessionEvent.self,
            from: JSONSerialization.data(withJSONObject: snapshot)
        )
        guard case let .snapshot(snapshotSession) = snapshotEvent.kind else {
            return XCTFail("the fixture snapshot frame carries a session")
        }
        XCTAssertNil(snapshotSession.approval)
        let sessionWithApproval = AidenBotSession(
            botId: snapshotSession.botId, epoch: snapshotSession.epoch, seq: snapshotSession.seq,
            stateView: snapshotSession.stateView, partial: snapshotSession.partial,
            entries: snapshotSession.entries, hasOlder: snapshotSession.hasOlder, approval: shown
        )
        XCTAssertEqual(
            try AidenRemoteJSONDecoder.decode(AidenBotSession.self, from: JSONEncoder().encode(sessionWithApproval)),
            sessionWithApproval
        )
        var approvalFrame = approvalFrames[0]
        approvalFrame["payload"] = ["approval": NSNull(), "reason": "expired"]
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, approvalFrame))
        approvalFrame["payload"] = [String: Any]()
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, approvalFrame), "approval is required, even when null")
    }

    func testRoutinePresetAndReceiptDecodersRejectWhatTheHostRejects() throws {
        let fixture = try sharedFixture()
        let routines = try XCTUnwrap(fixture["botRoutines"] as? [String: Any])
        let routine = try XCTUnwrap((routines["routines"] as? [[String: Any]])?.first)
        XCTAssertTrue(decodes(AidenBotRoutine.self, routine))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["cron": "0 8 * * 1-5"]) { $1 }))
        var noSchedule = routine
        noSchedule["schedule"] = nil
        XCTAssertFalse(decodes(AidenBotRoutine.self, noSchedule), "schedule is required, even if null")
        XCTAssertTrue(decodes(AidenBotRoutine.self, routine.merging(["schedule": NSNull()]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["schedule": ["kind": "monthly", "day": 32, "time": "08:00"]]) { $1 }))
        // Cron skips the 29th–31st in shorter months, so monthly routines stop at the 28th.
        XCTAssertTrue(decodes(AidenBotRoutine.self, routine.merging(["schedule": ["kind": "monthly", "day": 28, "time": "08:00"]]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["schedule": ["kind": "monthly", "day": 29, "time": "08:00"]]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["schedule": ["kind": "daily", "time": "8:00"]]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["schedule": ["kind": "once", "date": "2026-02-30", "time": "08:00"]]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["schedule": ["kind": "weekly", "days": [7], "time": "08:00"]]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["lastResult": "crashed"]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["label": ""]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutine.self, routine.merging(["timezone": " UTC"]) { $1 }))
        XCTAssertFalse(decodes(AidenBotRoutineList.self, ["routines": [routine, routine]]), "duplicate ids")

        // Like the host, weekly days are normalized rather than refused.
        let weekly = try XCTUnwrap(try? AidenRemoteJSONDecoder.decode(
            AidenBotRoutine.self,
            from: JSONSerialization.data(withJSONObject: routine.merging([
                "schedule": ["kind": "weekly", "days": [5, 1, 5], "time": "08:00"],
            ]) { $1 })
        ))
        XCTAssertEqual(weekly.schedule, .weekly(days: [1, 5], time: "08:00"))

        let presets = try XCTUnwrap(fixture["botPresets"] as? [String: Any])
        let preset = try XCTUnwrap((presets["presets"] as? [[String: Any]])?.first)
        XCTAssertTrue(decodes(AidenBotPresetList.self, presets))
        XCTAssertFalse(decodes(AidenBotPresetList.self, ["presets": Array(repeating: preset, count: 9)]))
        XCTAssertFalse(decodes(AidenBotPresetList.self, ["presets": [preset.merging(["avatar": [
            "version": 1, "shape": "hex", "color": "periwinkle", "accessory": "hat",
        ]]) { $1 }]]), "Preset avatars are exact")
        XCTAssertFalse(decodes(AidenBotPresetList.self, ["presets": [preset.merging(["avatar": [
            "version": 1, "shape": "star", "color": "periwinkle",
        ]]) { $1 }]]))
        XCTAssertFalse(decodes(AidenBotPresetList.self, ["presets": [preset.merging(["subtitle": ""]) { $1 }]]))

        let receipt = try object(#"{"pluginId":"gmail","name":"Gmail","status":"sent"}"#)
        XCTAssertTrue(decodes(AidenBotConnectionRequestReceipt.self, receipt))
        XCTAssertFalse(decodes(AidenBotConnectionRequestReceipt.self, receipt.merging(["status": "queued"]) { $1 }))
        let created = try XCTUnwrap(fixture["botPresetCreate"] as? [String: Any])
        let result = try XCTUnwrap(created["response"] as? [String: Any])
        XCTAssertTrue(decodes(AidenBotPresetCreateResult.self, result))
        XCTAssertTrue(decodes(AidenBotPresetCreateResult.self, result.merging(["created": false]) { $1 }),
                      "A repeated Start Chat (200) returns the same Bot")
        XCTAssertFalse(decodes(AidenBotPresetCreateResult.self, result.merging(["chatId": "c1"]) { $1 }))

        let messageReceipt = try object(#"{"submissionId":"17","deduped":true,"state":"running","interrupted":false}"#)
        XCTAssertTrue(decodes(AidenBotMessageReceipt.self, messageReceipt))
        XCTAssertFalse(decodes(AidenBotMessageReceipt.self, messageReceipt.merging(["interrupted": true]) { $1 }))
        XCTAssertFalse(decodes(AidenBotMessageReceipt.self, messageReceipt.merging(["submissionId": ""]) { $1 }))
    }

    func testRevision24BotListFailsWithAnUpdateMessageInsteadOfCrashing() throws {
        let fixture = try sharedFixture()
        let list = try XCTUnwrap(fixture["botList"] as? [String: Any])
        XCTAssertTrue(decodes(AidenBotList.self, list))
        let bots = try XCTUnwrap(list["bots"] as? [[String: Any]])

        var withFavorites = list
        withFavorites["favorites"] = ["botIds": [], "revision": "fav_1"]
        XCTAssertThrowsError(try AidenRemoteJSONDecoder.decode(
            AidenBotList.self,
            from: JSONSerialization.data(withJSONObject: withFavorites)
        )) { error in
            XCTAssertTrue(error.localizedDescription.contains("Update Aiden Agent"), error.localizedDescription)
        }
        var archived = list
        archived["bots"] = bots.map { $0.merging(["health": "archived"]) { $1 } }
        XCTAssertFalse(decodes(AidenBotList.self, archived))
        let summary = try XCTUnwrap(bots.first)
        XCTAssertFalse(decodes(AidenBotSummary.self, summary.merging(["archivedAt": "2026-08-18T19:00:00.000Z"]) { $1 }))
        var olderAvatar = summary
        olderAvatar["avatar"] = ["semantic": ["version": 1, "shape": "orb", "color": "sky", "eyes": "sleepy", "detail": "none"]]
        XCTAssertTrue(decodes(AidenBotSummary.self, olderAvatar), "Retired eyes and detail are ignored")
        XCTAssertFalse(decodes(AidenBotSummary.self, summary.merging(["sessionState": "paused"]) { $1 }))
    }

    // MARK: Revision 27 cards

    private let proposalID = "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11"

    private func proposal(_ id: String = "p1", status: AidenBotRoutineProposalStatus = .pending) throws -> AidenBotSessionEntry {
        var json: [String: Any] = [
            "type": "routine_proposal", "id": id, "proposalId": proposalID, "name": "Daily check-in",
            "prompt": "Check in briefly.", "label": "Every day at 9:00 AM", "status": status.rawValue,
        ]
        if status == .accepted { json["routineId"] = "task_9" }
        return try AidenRemoteJSONDecoder.decode(AidenBotSessionEntry.self, from: JSONSerialization.data(withJSONObject: json))
    }

    private func card(_ entry: AidenBotSessionEntry?) -> AidenBotRoutineProposalCard? {
        if case let .routineProposal(card)? = entry { return card }
        return nil
    }

    func testUnknownEntryFrameAdvancesTheSequenceWithoutChangingTheTranscript() async throws {
        let fixture = try sharedFixture()
        let frames = try XCTUnwrap(fixture["botSessionEvents"] as? [[String: Any]])
        let partial = try XCTUnwrap(frames.first { $0["type"] as? String == "partial" })
        var frame = partial
        frame["type"] = "entry"
        let pollCard: [String: Any] = ["type": "poll_card", "id": "x1", "options": ["a", "b"]]
        frame["payload"] = ["entry": pollCard]
        let decoded = try AidenRemoteJSONDecoder.decode(
            AidenBotSessionEvent.self,
            from: JSONSerialization.data(withJSONObject: frame)
        )
        XCTAssertEqual(decoded.kind, .unknownEntry(type: "poll_card"))
        XCTAssertEqual(decoded.wireType, "entry")
        var malformedKnown = frame
        malformedKnown["payload"] = ["entry": ["type": "memory_update", "id": "x1", "text": "secret"]]
        XCTAssertFalse(decodes(AidenBotSessionEvent.self, malformedKnown), "known types still fail closed")

        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 4, entries: [message("m1", .user, "Hi")]))
        let unknown = await model.apply(event(seq: 5, .unknownEntry(type: "poll_card")))
        XCTAssertEqual(unknown, .applied)
        XCTAssertEqual(model.seq, 5)
        XCTAssertEqual(model.entries.map(\.id), ["m1"])
        let next = await model.apply(event(seq: 6, .entry(message("m2", .assistant, "Hello"))))
        XCTAssertEqual(next, .applied, "the following frame is not a gap")
        XCTAssertEqual(model.entries.map(\.id), ["m1", "m2"])
        XCTAssertEqual(transport.sessionRequests, 1, "an unknown entry never refetches")
    }

    func testConsecutiveMemoryUpdatesRenderAsOneCaption() throws {
        let entries: [AidenBotSessionEntry] = [
            message("m1", .user, "I'm vegetarian"),
            .memoryUpdate(id: "u1", createdAt: nil),
            .memoryUpdate(id: "u2", createdAt: nil),
            message("m2", .assistant, "Noted."),
            .memoryUpdate(id: "u3", createdAt: nil),
        ]
        let rows = AidenBotTranscriptRow.rows(for: entries)
        XCTAssertEqual(rows.map(\.id), ["m1", "u1", "m2", "u3"])
        XCTAssertEqual(rows[1], .memoryUpdated(id: "u1"))
        XCTAssertEqual(rows[3], .memoryUpdated(id: "u3"))
        XCTAssertEqual(AidenBotSessionCopy.memoryUpdated, "Memory updated")
    }

    func testAcceptingAProposalShowsTheSettledCardFromTheResponse() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 3, entries: [message("m1", .user, "Hi"), try proposal()]))
        transport.queueProposalResult(.success(try AidenBotRoutineProposalRespondResult(status: .accepted, routineId: "task_9")))

        let settled = await model.respondToProposal(proposalID, decision: .accept)

        XCTAssertTrue(settled)
        XCTAssertEqual(transport.proposalRequests.map(\.decision), [.accept])
        let card = try XCTUnwrap(card(model.entries.last))
        XCTAssertEqual(card.status, .accepted)
        XCTAssertEqual(card.routineId, "task_9")
        XCTAssertEqual(AidenBotSessionCopy.proposalAdded(label: card.label), "Added ✓ · Every day at 9:00 AM")
        XCTAssertTrue(model.respondingProposals.isEmpty)
        let again = await model.respondToProposal(proposalID, decision: .accept)
        XCTAssertFalse(again, "a settled card has no actions")
        XCTAssertEqual(transport.proposalRequests.count, 1)
    }

    func testNotNowShowsWhateverTheMacSettled() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 3, entries: [try proposal()]))
        // Already accepted from the Mac: the repeat returns that answer.
        transport.queueProposalResult(.success(try AidenBotRoutineProposalRespondResult(status: .accepted, routineId: "task_9")))

        await model.respondToProposal(proposalID, decision: .dismiss)

        XCTAssertEqual(card(model.entries.first)?.status, .accepted)
        XCTAssertEqual(card(model.entries.first)?.routineId, "task_9")
    }

    func testDismissSettlesTheCardAsNotAdded() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 3, entries: [try proposal()]))
        transport.queueProposalResult(.success(try AidenBotRoutineProposalRespondResult(status: .dismissed)))

        await model.respondToProposal(proposalID, decision: .dismiss)

        let card = try XCTUnwrap(card(model.entries.first))
        XCTAssertEqual(card.status, .dismissed)
        XCTAssertNil(card.routineId)
        XCTAssertEqual(transport.proposalRequests.map(\.decision), [.dismiss])
    }

    func testAFailedAnswerKeepsTheProposalPendingAndRetriesUnderTheSameKey() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 3, entries: [try proposal()]))
        transport.queueProposalResult(.failure(URLError(.networkConnectionLost)))

        let first = await model.respondToProposal(proposalID, decision: .accept)

        XCTAssertFalse(first)
        XCTAssertEqual(card(model.entries.first)?.status, .pending, "the actions stay")
        XCTAssertNotNil(model.errorMessage)
        transport.queueProposalResult(.success(try AidenBotRoutineProposalRespondResult(status: .accepted, routineId: "task_9")))
        await model.respondToProposal(proposalID, decision: .accept)
        XCTAssertEqual(card(model.entries.first)?.status, .accepted)
        let keys = transport.proposalRequests.map(\.key)
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1], "a lost response is retried under the same key, so the Mac adds one routine")
    }

    func testAMissingProposalRefetchesTheSession() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 3, entries: [try proposal()]))
        transport.queueProposalResult(.failure(try serverError(
            status: 404, code: "routine_proposal_not_found", message: "That suggestion is gone."
        )))
        transport.queueSession(.success(try session(seq: 4, entries: [try proposal(status: .dismissed)])))

        await model.respondToProposal(proposalID, decision: .accept)

        XCTAssertEqual(transport.sessionRequests, 2)
        XCTAssertEqual(card(model.entries.first)?.status, .dismissed)
        XCTAssertNotNil(model.errorMessage)
    }

    // MARK: Routine conflicts

    func testRoutineConflictsAndRemovalsReloadInsteadOfRetrying() throws {
        let conflict = AidenBotRoutineFailure(try serverError(
            status: 409, code: "revision_conflict", message: "This routine changed. Refresh it before trying again."
        ))
        XCTAssertEqual(conflict, .changedOnMac)
        XCTAssertTrue(conflict.needsReload)

        let removed = AidenBotRoutineFailure(try serverError(status: 404, code: "not_found", message: "Gone"))
        XCTAssertEqual(removed, .removedOnMac)
        XCTAssertTrue(removed.needsReload)

        let offline = AidenBotRoutineFailure(URLError(.notConnectedToInternet))
        XCTAssertFalse(offline.needsReload)
        XCTAssertFalse(offline.message.isEmpty)
    }
}

/// The Bot chat's quick-reply question: the snapshot and `question` events show
/// it, and answering posts once and clears it.
@MainActor
final class AidenBotSessionQuestionTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let waitID = "5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c"
    private let questionJSON = """
    {"waitId":"5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c","toolCallId":"call_1","questions":[{"question":"Which colour should the banner use?","header":"Colour","multiSelect":false,"options":[{"label":"Blue","description":"Calm and cool."},{"label":"Red","description":"Loud and warm."}]}]}
    """

    private func session(question: String) throws -> AidenBotSession {
        let json = """
        {"botId":"bot_fixture_01","epoch":"epoch_1","seq":0,"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":\(question),"approval":null}
        """
        return try JSONDecoder().decode(AidenBotSession.self, from: Data(json.utf8))
    }

    private func event(question: String, seq: Int) throws -> AidenBotSessionEvent {
        let json = """
        {"protocolVersion":1,"botId":"bot_fixture_01","epoch":"epoch_1","seq":\(seq),"type":"question","payload":{"question":\(question)}}
        """
        return try JSONDecoder().decode(AidenBotSessionEvent.self, from: Data(json.utf8))
    }

    func testSnapshotQuestionIsAnsweredOnceAndClearsWhenTheMacReceipts() async throws {
        let transport = QuestionTransport(snapshot: try session(question: questionJSON))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        XCTAssertEqual(model.question?.waitId, waitID)
        XCTAssertTrue(model.canAnswerQuestion)

        let answer = AidenQuestionRespondRequest(cancelled: false, answers: [.option(questionIndex: 0, answer: "Blue")])
        await model.answerQuestion(answer)

        XCTAssertEqual(transport.answers.map(\.waitId), [waitID])
        XCTAssertEqual(transport.answers.first?.request, answer)
        XCTAssertNil(model.question)
        XCTAssertFalse(model.canAnswerQuestion)
    }

    func testALostAnswerIsRetriedUnderItsKeyAndAnotherAnswerIsANewRequest() async throws {
        let transport = QuestionTransport(snapshot: try session(question: questionJSON))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        let blue = AidenQuestionRespondRequest(cancelled: false, answers: [.option(questionIndex: 0, answer: "Blue")])
        let red = AidenQuestionRespondRequest(cancelled: false, answers: [.option(questionIndex: 0, answer: "Red")])

        transport.nextAnswerError = URLError(.networkConnectionLost)
        await model.answerQuestion(blue)
        XCTAssertEqual(model.question?.waitId, waitID, "the card stays until the Mac confirms")
        transport.nextAnswerError = URLError(.networkConnectionLost)
        await model.answerQuestion(blue)
        await model.answerQuestion(red)

        XCTAssertEqual(transport.answers.count, 3)
        XCTAssertEqual(transport.answers[0].key, transport.answers[1].key, "the same answer replays under one key")
        XCTAssertNotEqual(transport.answers[1].key, transport.answers[2].key, "another answer is another request")
        XCTAssertNil(model.question)
    }

    func testQuestionEventsShowAndSettleTheWaitingQuestion() async throws {
        let transport = QuestionTransport(snapshot: try session(question: "null"))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        XCTAssertNil(model.question)

        await model.apply(try event(question: questionJSON, seq: 1))
        XCTAssertEqual(model.question?.waitId, waitID)

        await model.apply(try event(question: "null", seq: 2))
        XCTAssertNil(model.question)
        XCTAssertTrue(transport.answers.isEmpty, "a settled question is not answered by the phone")
    }
}

/// The Bot chat's tool approval: the snapshot and `approval` events show it,
/// and Allow/Deny go once through the generic approval route.
@MainActor
final class AidenBotSessionApprovalTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let waitID = "8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6"

    private func approvalJSON(canAllow: Bool = true) -> String {
        #"{"waitId":"8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6","toolCallId":"call_2","toolName":"mcp__mail__send_email","summary":"Send an email to dana@example.com","canAllow":\#(canAllow)}"#
    }

    private func session(approval: String, epoch: String = "epoch_1", seq: Int = 0) throws -> AidenBotSession {
        let json = """
        {"botId":"bot_fixture_01","epoch":"\(epoch)","seq":\(seq),"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":null,"approval":\(approval)}
        """
        return try JSONDecoder().decode(AidenBotSession.self, from: Data(json.utf8))
    }

    private func loadedModel(approval: String) async throws -> (AidenBotSessionModel, QuestionTransport) {
        let transport = QuestionTransport(snapshot: try session(approval: approval))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        return (model, transport)
    }

    private func serverError(status: Int, code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"No.","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    func testSnapshotApprovalIsAllowedOnceByItsWaitIDAndClearsOnTheReceipt() async throws {
        let (model, transport) = try await loadedModel(approval: approvalJSON())
        XCTAssertEqual(model.approval?.waitId, waitID)
        XCTAssertEqual(model.approval?.toolName, "mcp__mail__send_email")
        XCTAssertTrue(model.canAnswerApproval)

        await model.answerApproval(.allow)

        XCTAssertEqual(transport.approvals.count, 1)
        XCTAssertEqual(transport.approvals.first?.waitId, waitID)
        XCTAssertEqual(transport.approvals.first?.decision, .allow)
        XCTAssertNil(transport.approvals.first?.scope, "a Bot approval is answered once, with no scope")
        XCTAssertNil(model.approval)
        XCTAssertFalse(model.canAnswerApproval)

        await model.answerApproval(.deny)
        XCTAssertEqual(transport.approvals.count, 1, "nothing is waiting, so nothing more is sent")
    }

    func testFixtureApprovalFramesShowAndSettleTheCard() async throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let frames = try XCTUnwrap(fixture["botSessionEvents"] as? [[String: Any]])
            .filter { $0["type"] as? String == "approval" }
            .map { try AidenRemoteJSONDecoder.decode(AidenBotSessionEvent.self, from: JSONSerialization.data(withJSONObject: $0)) }
        let first = try XCTUnwrap(frames.first)
        let transport = QuestionTransport(
            snapshot: try session(approval: "null", epoch: first.epoch, seq: first.seq - 1)
        )
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        XCTAssertNil(model.approval)

        let shown = await model.apply(first)
        XCTAssertEqual(shown, .applied)
        XCTAssertEqual(model.approval?.waitId, waitID)

        let settled = await model.apply(try XCTUnwrap(frames.last))
        XCTAssertEqual(settled, .applied)
        XCTAssertNil(model.approval)
        XCTAssertTrue(transport.approvals.isEmpty, "a settled approval is not answered by the phone")
    }

    func testALostDecisionIsRetriedUnderItsKeyAndAnotherDecisionIsANewRequest() async throws {
        let (model, transport) = try await loadedModel(approval: approvalJSON())

        transport.nextApprovalError = URLError(.networkConnectionLost)
        await model.answerApproval(.allow)
        XCTAssertEqual(model.approval?.waitId, waitID, "the card stays until the Mac confirms")
        XCTAssertNotNil(model.errorMessage)
        transport.nextApprovalError = URLError(.networkConnectionLost)
        await model.answerApproval(.allow)
        await model.answerApproval(.deny)

        XCTAssertEqual(transport.approvals.map(\.decision), [.allow, .allow, .deny])
        XCTAssertEqual(transport.approvals[0].key, transport.approvals[1].key, "the same decision replays under one key")
        XCTAssertNotEqual(transport.approvals[1].key, transport.approvals[2].key, "another decision is another request")
        XCTAssertNil(model.approval)
    }

    func testAllowIsRefusedWhenThePhoneMayOnlyDeny() async throws {
        let (model, transport) = try await loadedModel(approval: approvalJSON(canAllow: false))
        XCTAssertEqual(model.approval?.canAllow, false)

        await model.answerApproval(.allow)
        XCTAssertTrue(transport.approvals.isEmpty, "Allow never reaches the Mac for a deny-only approval")
        XCTAssertNotNil(model.approval)

        await model.answerApproval(.deny)
        XCTAssertEqual(transport.approvals.map(\.decision), [.deny])
        XCTAssertNil(model.approval)
    }

    func testNothingWaitingClearsTheCardButARefusalKeepsIt() async throws {
        for code in ["approval_expired", "approval_already_resolved"] {
            let (model, transport) = try await loadedModel(approval: approvalJSON())
            transport.nextApprovalError = try serverError(status: 409, code: code)
            await model.answerApproval(.deny)
            XCTAssertNil(model.approval, "\(code) means nothing is waiting any more")
            XCTAssertNil(model.errorMessage, code)
        }

        let (model, transport) = try await loadedModel(approval: approvalJSON())
        transport.nextApprovalError = try serverError(status: 403, code: "capability_denied")
        await model.answerApproval(.allow)
        XCTAssertEqual(model.approval?.waitId, waitID, "a refused answer leaves the approval waiting")
        XCTAssertNotNil(model.errorMessage)
        await model.answerApproval(.allow)
        XCTAssertNotEqual(transport.approvals[0].key, transport.approvals[1].key, "a definite refusal is not replayed")
    }
}

/// A transport that serves one snapshot and records quick-reply answers.
private final class QuestionTransport: AidenBotSessionTransport, @unchecked Sendable {
    let snapshot: AidenBotSession
    private(set) var answers: [(waitId: String, key: UUID, request: AidenQuestionRespondRequest)] = []
    /// Thrown by the next answer instead of a receipt.
    var nextAnswerError: Error?
    private(set) var approvals: [(waitId: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, key: UUID)] = []
    /// Thrown by the next approval response instead of a resolution.
    var nextApprovalError: Error?
    let answerGate = TestGate()

    init(snapshot: AidenBotSession) {
        self.snapshot = snapshot
    }

    func botSession(botId: String) async throws -> AidenBotSession { snapshot }

    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> {
        AsyncThrowingStream { continuation in continuation.finish() }
    }

    func sendBotMessage(
        botId: String,
        request: AidenBotMessageRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotMessageReceipt {
        throw URLError(.unsupportedURL)
    }

    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw URLError(.unsupportedURL)
    }

    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw URLError(.unsupportedURL)
    }

    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        throw URLError(.unsupportedURL)
    }

    func answerBotQuestion(
        botId: String,
        waitId: String,
        request: AidenQuestionRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotQuestionAnswerReceipt {
        answers.append((waitId, idempotencyKey, request))
        await answerGate.pass()
        if let error = nextAnswerError {
            nextAnswerError = nil
            throw error
        }
        return try JSONDecoder().decode(
            AidenBotQuestionAnswerReceipt.self,
            from: Data("{\"waitId\":\"\(waitId)\"}".utf8)
        )
    }

    func respondToApproval(
        id: String,
        decision: AidenApprovalDecision,
        scope: AidenApprovalScope?,
        idempotencyKey: UUID
    ) async throws -> AidenApprovalResponse {
        approvals.append((id, decision, scope, idempotencyKey))
        await answerGate.pass()
        if let error = nextApprovalError {
            nextApprovalError = nil
            throw error
        }
        return AidenApprovalResponse(approvalId: id, decision: decision, resolvedAt: Date())
    }

    func requestBotConnection(
        botId: String,
        request: AidenBotConnectionRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotConnectionRequestReceipt {
        throw URLError(.unsupportedURL)
    }

    func respondToBotRoutineProposal(
        botId: String,
        proposalId: String,
        request: AidenBotRoutineProposalRespondRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotRoutineProposalRespondResult {
        throw URLError(.unsupportedURL)
    }
}

/// Contract revision 30: the activity wire, read from the fixture every client shares.
final class AidenBotActivityContractTests: XCTestCase {
    private func shared() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func section(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(try shared()[name] as? [String: Any])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: object))
    }

    private func encoded<T: Encodable>(_ value: T) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? NSDictionary)
    }

    /// Expands a fixture `{unit, count}` descriptor: `count` repetitions of `unit`,
    /// counted in code points.
    private func expand(_ descriptor: Any?) throws -> String {
        let value = try XCTUnwrap(descriptor as? [String: Any])
        let unit = try XCTUnwrap(value["unit"] as? String)
        let count = try XCTUnwrap(value["count"] as? Int)
        return String(repeating: unit, count: count)
    }

    func testActivitySessionFramesAndDetailDecodeAsTheMacSendsThem() throws {
        let activity = try section("botActivity")
        let started = 1_760_450_000_000
        let session = try decode(AidenBotSession.self, try XCTUnwrap(activity["session"]))
        XCTAssertEqual(session.activity, AidenBotSessionActivity(phase: "app", app: "Notion", startedAt: started))
        XCTAssertEqual(session.queued.map(\.submissionId), ["18", "19"])
        XCTAssertEqual(session.queued.map(\.mode), [.queue, .steer])

        let events = try XCTUnwrap(activity["events"] as? [Any]).map { try decode(AidenBotSessionEvent.self, $0) }
        XCTAssertEqual(events.map(\.kind), [
            .activity(AidenBotSessionActivity(phase: "searching", startedAt: started)),
            .queued([AidenBotQueuedMessage(submissionId: "18", mode: .queue, text: "Also add a shopping list.")]),
            .activity(AidenBotSessionActivity(phase: "teleporting", startedAt: started)),
            .activity(nil),
        ])
        // A newer Mac's phase decodes and reads as Working.
        XCTAssertEqual(
            AidenBotActivityPhase.display(phase: "teleporting", wording: .follows, app: nil),
            AidenBotActivityPhase.display(phase: "working", wording: .follows, app: nil)
        )

        let detail = try decode(AidenBotDetail.self, try XCTUnwrap(activity["detail"]))
        XCTAssertEqual(detail.chatActivity, AidenBotChatActivity(level: .summary, wording: .thinking))
        let older = try decode(AidenBotDetail.self, try XCTUnwrap(try shared()["botDetail"]))
        XCTAssertNil(older.chatActivity, "a revision-29 detail has no choice to show")
    }

    func testEveryPrivacySampleIsRefused() throws {
        let privacy = try section("botActivityPrivacy")
        for sample in try XCTUnwrap(privacy["rejectedActivities"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, sample), "\(sample)")
        }
        for sample in try XCTUnwrap(privacy["rejectedQueued"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotQueuedMessage.self, sample), "\(sample)")
        }
        for sample in try XCTUnwrap(privacy["rejectedChatActivity"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotChatActivity.self, sample), "\(sample)")
        }
        for list in try XCTUnwrap(privacy["rejectedQueuedLists"] as? [Any]) {
            // A list is refused wherever it arrives: a snapshot and a queued frame.
            var session = try XCTUnwrap(try section("botActivity")["session"] as? [String: Any])
            session["queued"] = list
            XCTAssertThrowsError(try decode(AidenBotSession.self, session), "snapshot: \(list)")
            let frame: [String: Any] = [
                "protocolVersion": 1, "botId": "bot_fixture_01", "epoch": "epoch_fixture_02", "seq": 9,
                "type": "queued", "payload": ["queued": list],
            ]
            XCTAssertThrowsError(try decode(AidenBotSessionEvent.self, frame), "frame: \(list)")
        }
    }

    /// An optional key sent as the literal null is refused, never read as absent (TS and Android parity).
    func testEveryNullLiteralSampleIsRefused() throws {
        let nulls = try XCTUnwrap(try section("botActivityPrivacy")["rejectedNullLiterals"] as? [String: Any])
        let activities = try XCTUnwrap(nulls["activities"] as? [Any])
        let sessions = try XCTUnwrap(nulls["sessions"] as? [Any])
        let events = try XCTUnwrap(nulls["events"] as? [Any])
        let entries = try XCTUnwrap(nulls["entries"] as? [Any])
        XCTAssertFalse(activities.isEmpty || sessions.isEmpty || events.isEmpty || entries.isEmpty)
        for sample in activities {
            XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, sample), "\(sample)")
        }
        for sample in sessions {
            XCTAssertThrowsError(try decode(AidenBotSession.self, sample), "\(sample)")
        }
        for sample in events {
            XCTAssertThrowsError(try decode(AidenBotSessionEvent.self, sample), "\(sample)")
        }
        for sample in entries {
            XCTAssertThrowsError(try decode(AidenBotSessionEntry.self, sample), "\(sample)")
        }
        // Each refusal is the null itself: the same sample without it decodes.
        var activity = try XCTUnwrap(activities.first as? [String: Any])
        activity["app"] = "Notion"
        XCTAssertEqual(try decode(AidenBotSessionActivity.self, activity).app, "Notion")
        var session = try XCTUnwrap(sessions.first as? [String: Any])
        session["queued"] = [Any]()
        XCTAssertEqual(try decode(AidenBotSession.self, session).queued, [])
        var entry = try XCTUnwrap(entries.first as? [String: Any])
        entry.removeValue(forKey: "label")
        guard case let .message(message) = try decode(AidenBotSessionEntry.self, entry) else { return XCTFail("a message") }
        XCTAssertEqual(message.submissionId, "17")
    }

    func testThePersonsMessageCarriesItsSubmissionIdAndEveryMisuseIsRefused() throws {
        let activity = try section("botActivity")
        let session = try decode(AidenBotSession.self, try XCTUnwrap(activity["session"]))
        guard case let .message(sent) = try XCTUnwrap(session.entries.first) else { return XCTFail("a message") }
        XCTAssertEqual(sent.submissionId, "17")

        // The queued message 18 was placed in the turn: its bubble now names the same submission.
        let frame = try decode(AidenBotSessionEvent.self, try XCTUnwrap(activity["entryEvent"]))
        guard case let .entry(.message(placed)) = frame.kind else { return XCTFail("an entry frame") }
        XCTAssertEqual(placed.submissionId, session.queued.first?.submissionId)
        XCTAssertEqual(placed.submissionId, "18")

        // A device without bot:activity is sent the same session and frame without the key.
        let nonHolder = try XCTUnwrap(try section("botActivityPrivacy")["nonHolder"] as? [String: Any])
        let legacy = try decode(AidenBotSession.self, try XCTUnwrap(nonHolder["session"]))
        guard case let .message(untagged) = try XCTUnwrap(legacy.entries.first) else { return XCTFail("a message") }
        XCTAssertNil(untagged.submissionId)
        XCTAssertEqual(untagged.text, sent.text)
        let legacyFrame = try decode(AidenBotSessionEvent.self, try XCTUnwrap(nonHolder["entryEvent"]))
        guard case let .entry(.message(untaggedPlaced)) = legacyFrame.kind else { return XCTFail("an entry frame") }
        XCTAssertNil(untaggedPlaced.submissionId)
        XCTAssertEqual(legacyFrame.seq, frame.seq)

        let rejected = try XCTUnwrap(try section("botActivityPrivacy")["rejectedSubmissionIdEntries"] as? [Any])
        XCTAssertFalse(rejected.isEmpty)
        for sample in rejected {
            XCTAssertThrowsError(try decode(AidenBotSessionEntry.self, sample), "\(sample)")
        }
    }

    func testTextBoundsAreCountedInCodePoints() throws {
        let bounds = try XCTUnwrap(try section("botActivityPrivacy")["textBounds"] as? [String: Any])
        let queuedText = try XCTUnwrap(bounds["queuedText"] as? [String: Any])
        func queued(_ text: String) -> [String: Any] {
            ["submissionId": "18", "mode": "queue", "text": text]
        }
        for sample in try XCTUnwrap(queuedText["rejected"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotQueuedMessage.self, queued(try expand(sample))), "\(sample)")
        }
        for sample in try XCTUnwrap(queuedText["accepted"] as? [Any]) {
            let text = try expand(sample)
            XCTAssertEqual(try decode(AidenBotQueuedMessage.self, queued(text)).text, text, "\(sample)")
        }
        let app = try XCTUnwrap(bounds["app"] as? [String: Any])
        func activity(_ app: String) -> [String: Any] {
            ["phase": "app", "app": app, "startedAt": 1_760_450_000_000]
        }
        for sample in try XCTUnwrap(app["rejected"] as? [Any]) {
            XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, activity(try expand(sample))), "\(sample)")
        }
        for sample in try XCTUnwrap(app["accepted"] as? [Any]) {
            let label = try expand(sample)
            XCTAssertEqual(try decode(AidenBotSessionActivity.self, activity(label)).app, label, "\(sample)")
        }
    }

    func testPhaseIdsOutsideTheWireShapeAreRefusedAndOthersDecode() throws {
        for id in ["teleporting", "a", "a_b", String(repeating: "a", count: 32)] {
            XCTAssertEqual(
                try decode(AidenBotSessionActivity.self, ["phase": id, "startedAt": 0]).phase, id)
        }
        for id in ["", "Reading", "1abc", "_abc", "a-b", "a b", String(repeating: "a", count: 33), "reading\u{FF21}"] {
            XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, ["phase": id, "startedAt": 0]), id)
        }
        // startedAt spans every integer JavaScript represents exactly, 0 through 2^53 − 1.
        let latest = 9_007_199_254_740_991
        XCTAssertEqual(try decode(AidenBotSessionActivity.self, ["phase": "reading", "startedAt": latest]).startedAt, latest)
        XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, ["phase": "reading", "startedAt": latest + 1]))
        XCTAssertThrowsError(try decode(AidenBotSessionActivity.self, ["phase": "reading", "startedAt": -1]))
    }

    func testRequestsEncodeExactlyTheFixtureBodies() throws {
        let activity = try section("botActivity")
        let send = try XCTUnwrap((activity["send"] as? [String: Any])?["request"] as? NSDictionary)
        XCTAssertEqual(try encoded(try AidenBotMessageRequest(text: "Keep it vegetarian.", whenBusy: .steer)), send)
        XCTAssertEqual(try encoded(try AidenBotMessageRequest(text: "Hi")), ["text": "Hi"] as NSDictionary, "no whenBusy unless one was chosen")
        let patch = try XCTUnwrap((activity["identityPatch"] as? [String: Any])?["request"] as? NSDictionary)
        XCTAssertEqual(try encoded(try AidenBotIdentityPatch(chatActivity: AidenBotChatActivity(level: .detailed, wording: .follows))), patch)
    }

    func testThePhaseTableIsTheOneTheMacDraws() throws {
        let activity = try section("botActivity")
        let phases = try XCTUnwrap(activity["phases"] as? [[String: String]])
        let keeps = Set(try XCTUnwrap(activity["thinkingKeeps"] as? [String]))
        XCTAssertEqual(Set(AidenBotActivityPhase.table.keys), Set(phases.compactMap { $0["id"] }))
        for row in phases {
            let id = try XCTUnwrap(row["id"])
            let shown = AidenBotActivityPhase.display(phase: id, wording: .follows, app: nil)
            XCTAssertEqual(shown.phase, id)
            XCTAssertEqual(shown.word, row["word"], id)
            XCTAssertEqual(shown.mark.rawValue, row["mark"], id)
            XCTAssertEqual(
                AidenBotActivityPhase.display(phase: id, wording: .thinking, app: nil).phase,
                keeps.contains(id) ? id : "thinking",
                id
            )
        }
        let app = try XCTUnwrap(activity["app"] as? [String: String])
        XCTAssertEqual(AidenBotActivityPhase.display(phase: "app", wording: .follows, app: app["app"]).word, app["word"])
    }

    func testElapsedTimeMatchesTheMacIncludingAPhoneWhoseClockIsBehind() throws {
        let rows = try XCTUnwrap(try section("botActivity")["elapsed"] as? [[String: Any]])
        for row in rows {
            let startedAt = try XCTUnwrap(row["startedAt"] as? NSNumber).intValue
            let now = try XCTUnwrap(row["now"] as? NSNumber).intValue
            XCTAssertEqual(AidenBotElapsed.label(startedAt: startedAt, nowMs: now), row["label"] as? String, "\(row)")
        }
    }

    // Revision 33 (`bot-attachments-v1`).
    func testBotAttachmentRequestsMatchTheFixtureAndBadOnesAreRefused() throws {
        let attachments = try section("botAttachments")
        let send = try XCTUnwrap((attachments["send"] as? [String: Any])?["request"] as? [String: Any])
        let ids = try XCTUnwrap(send["attachmentIds"] as? [String])
        XCTAssertEqual(
            try encoded(try AidenBotMessageRequest(text: try XCTUnwrap(send["text"] as? String), attachmentIds: ids)),
            send as NSDictionary
        )
        let only = try XCTUnwrap(attachments["attachmentsOnly"] as? [String: Any])
        XCTAssertEqual(
            try encoded(try AidenBotMessageRequest(text: "", attachmentIds: try XCTUnwrap(only["attachmentIds"] as? [String]))),
            only as NSDictionary,
            "photos alone are a message"
        )
        XCTAssertEqual(try decode(AidenBotMessageRequest.self, only).attachmentIds, only["attachmentIds"] as? [String])
        for rejected in try XCTUnwrap(attachments["rejectedSends"] as? [[String: Any]]) {
            XCTAssertThrowsError(try decode(AidenBotMessageRequest.self, rejected), "\(rejected)")
        }
        XCTAssertThrowsError(
            try AidenBotMessageRequest(text: "Hi", attachmentIds: (0...AidenBotSessionWire.maxMessageAttachments).map { "att_" + String(repeating: Character(UnicodeScalar(UInt8(65 + $0))), count: 43) }),
            "more than the Mac takes in one message"
        )
    }

    func testBotUploadsUseTheChatAttachmentBodyAndReference() throws {
        let attachments = try section("botAttachments")
        let image = try XCTUnwrap(attachments["imageUpload"] as? [String: Any])
        let imageRequest = try XCTUnwrap(image["request"] as? [String: Any])
        let png = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(imageRequest["data"] as? String)))
        XCTAssertEqual(try encoded(AidenAttachmentUpload.image(name: "receipt.png", mimeType: "image/png", data: png)), imageRequest as NSDictionary)
        let text = try XCTUnwrap(attachments["textUpload"] as? [String: Any])
        XCTAssertEqual(
            try encoded(AidenAttachmentUpload.text(name: "notes.md", mimeType: "text/markdown", text: "# Groceries\n- oats")),
            try XCTUnwrap(text["request"] as? NSDictionary)
        )
        let imageReference = try decode(AidenAttachmentReference.self, try XCTUnwrap(image["response"]))
        XCTAssertEqual(imageReference.kind, .image)
        XCTAssertEqual(imageReference.size, png.count)
        XCTAssertEqual(try decode(AidenAttachmentReference.self, try XCTUnwrap(text["response"])).kind, .text)
        _ = try decode(AidenBotMessageReceipt.self, try XCTUnwrap((attachments["send"] as? [String: Any])?["response"]))
    }
}

/// Contract revision 30 in the session model: the status line, Reconnecting,
/// Queued messages and Steer/Queue.
@MainActor
final class AidenBotSessionActivityTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let started = 1_760_450_000_000

    private func running(
        _ activity: AidenBotSessionActivity?,
        epoch: String = "epoch_a",
        seq: Int = 4,
        partial: String? = nil,
        queued: [AidenBotQueuedMessage] = []
    ) throws -> AidenBotSession {
        AidenBotSession(
            botId: botID,
            epoch: epoch,
            seq: seq,
            stateView: try AidenBotSessionStateView(state: .running),
            partial: partial,
            entries: [],
            hasOlder: false,
            activity: activity,
            queued: queued
        )
    }

    private func idle() throws -> AidenBotSession {
        AidenBotSession(
            botId: botID,
            epoch: "epoch_a",
            seq: 4,
            stateView: try AidenBotSessionStateView(state: .idle),
            partial: nil,
            entries: [],
            hasOlder: false
        )
    }

    private func event(epoch: String = "epoch_a", seq: Int, _ kind: AidenBotSessionEvent.Kind) -> AidenBotSessionEvent {
        AidenBotSessionEvent(botId: botID, epoch: epoch, seq: seq, kind: kind)
    }

    private func loaded(
        _ transport: FakeBotSessionTransport,
        _ session: AidenBotSession,
        supported: Bool = true
    ) async -> AidenBotSessionModel {
        transport.queueSession(.success(session))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        model.activitySupported = supported
        await model.load()
        return model
    }

    private func waitUntil(_ condition: () -> Bool, what: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    // Test 1
    func testTheLineShowsUntilTheReplyStreamsAndFollowsTheChosenWording() async throws {
        let model = await loaded(FakeBotSessionTransport(), try running(AidenBotSessionActivity(phase: "reading", startedAt: started)))
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Reading")
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.mark, .scanGrid)
        model.wording = .thinking
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Thinking")
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "waiting", startedAt: started))))
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Waiting for you", "a card that needs the person keeps its word")
        _ = await model.apply(event(seq: 6, .partial("Here is")))
        XCTAssertEqual(
            model.statusLine(nowMs: started + 1_000)?.display.word, "Waiting for you",
            "text from before a running step does not hide the step"
        )
        _ = await model.apply(event(seq: 7, .activity(AidenBotSessionActivity(phase: "writing", startedAt: started))))
        XCTAssertNil(model.statusLine(nowMs: started + 1_000), "the reply's words are the signal")
        _ = await model.apply(event(seq: 8, .state(try AidenBotSessionStateView(state: .idle))))
        _ = await model.apply(event(seq: 9, .partial("")))
        XCTAssertNil(model.statusLine(nowMs: started + 1_000), "nothing shows once the turn ended")
    }

    // R7: the line hides only while reply text streams with no active tool.
    func testStreamingTextHidesTheLineOnlyWhileNoToolRuns() async throws {
        let model = await loaded(FakeBotSessionTransport(), try running(nil, partial: "Let me check"))
        XCTAssertNil(model.statusLine(nowMs: started), "words streaming before the first frame are the signal")
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "searching", startedAt: started))))
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Searching the web", "a tool that starts mid-narration shows")
        _ = await model.apply(event(seq: 6, .activity(AidenBotSessionActivity(phase: "thinking", startedAt: started))))
        XCTAssertNil(model.statusLine(nowMs: started))
        _ = await model.apply(event(seq: 7, .activity(AidenBotSessionActivity(phase: "browsing", startedAt: started))))
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Working", "a newer Mac's phase is not reply text")

        let blank = await loaded(FakeBotSessionTransport(), try running(nil, partial: "  \n"))
        XCTAssertEqual(blank.statusLine(nowMs: started)?.display.word, "Getting ready", "whitespace is not a reply")
    }

    // Test 2 (Review Focus 3)
    func testAnUnknownPhaseReadsAsWorkingAndElapsedTimeAppearsAfterTwentySeconds() async throws {
        let model = await loaded(FakeBotSessionTransport(), try running(AidenBotSessionActivity(phase: "browsing", startedAt: started)))
        let early = try XCTUnwrap(model.statusLine(nowMs: started + 19_000))
        XCTAssertEqual(early.display.word, "Working")
        XCTAssertEqual(early.display.mark, .quadShuffle)
        XCTAssertNil(early.elapsed)
        XCTAssertEqual(early.accessibilityLabel, "Working")
        let later = try XCTUnwrap(model.statusLine(nowMs: started + 72_000))
        XCTAssertEqual(later.elapsed, "1m 12s")
        XCTAssertEqual(later.accessibilityLabel, "Working, 1m 12s")
    }

    // Test 3
    func testBeforeTheFirstActivityFrameItSaysGettingReadyAndOlderMacsShowNothing() async throws {
        let fresh = await loaded(FakeBotSessionTransport(), try running(nil))
        XCTAssertEqual(fresh.statusLine(nowMs: started)?.display.word, "Getting ready")
        let older = await loaded(
            FakeBotSessionTransport(),
            try running(AidenBotSessionActivity(phase: "reading", startedAt: started)),
            supported: false
        )
        XCTAssertNil(older.statusLine(nowMs: started))
        XCTAssertFalse(older.offersBusyModes)
    }

    // Test 4 (Review Focus 2)
    func testADroppedStreamReadsReconnectingUntilTheNextConnection() async throws {
        let transport = FakeBotSessionTransport()
        transport.queueStream([]) // the first connection drops at once
        transport.queueStream(
            [event(epoch: "epoch_b", seq: 1, .snapshot(try running(AidenBotSessionActivity(phase: "searching", startedAt: started), epoch: "epoch_b", seq: 1)))],
            staysOpen: true
        )
        let model = await loaded(
            transport,
            try running(AidenBotSessionActivity(phase: "writing", startedAt: started), partial: "Here is")
        )
        XCTAssertNil(model.statusLine(nowMs: started + 1_000), "the reply streams before the drop")
        let listener = Task { await model.listen() }

        try await waitUntil({ model.isStreamDown }, what: "the drop")
        XCTAssertEqual(
            model.statusLine(nowMs: started + 1_000)?.display.word, "Reconnecting to your Mac",
            "a dropped stream says so even over streamed text"
        )
        model.wording = .thinking
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Reconnecting to your Mac")
        model.wording = .follows
        try await waitUntil({ !model.isStreamDown && model.epoch == "epoch_b" }, what: "the next connection")
        XCTAssertEqual(model.statusLine(nowMs: started + 1_000)?.display.word, "Searching the web")

        listener.cancel()
        await listener.value
    }

    func testAReloadedSnapshotRestoresTheLineAndTheQueuedMessages() async throws {
        let waiting = [
            AidenBotQueuedMessage(submissionId: "18", mode: .queue, text: "Also add a shopping list."),
            AidenBotQueuedMessage(submissionId: "19", mode: .steer, text: "Keep it vegetarian."),
        ]
        let model = await loaded(
            FakeBotSessionTransport(),
            try running(AidenBotSessionActivity(phase: "app", app: "Notion", startedAt: started), queued: waiting)
        )
        XCTAssertEqual(model.activity, AidenBotSessionActivity(phase: "app", app: "Notion", startedAt: started))
        XCTAssertEqual(model.queued, waiting)
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Using Notion")
        _ = await model.apply(event(seq: 5, .activity(nil)))
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Getting ready", "a cleared activity never leaves the old phase showing")
    }

    // Test 5
    func testSteerAndQueueGoOutOnlyWhileTheBotWorksOnAMacThatOffersThem() async throws {
        let transport = FakeBotSessionTransport()
        let supported = await loaded(transport, try running(nil))
        XCTAssertTrue(supported.offersBusyModes)
        let steered = await supported.send("Keep it vegetarian.", whenBusy: .steer)
        XCTAssertTrue(steered)
        let older = await loaded(transport, try running(nil), supported: false)
        let queuedOnOlder = await older.send("Also a list.", whenBusy: .queue)
        XCTAssertTrue(queuedOnOlder)
        let resting = await loaded(transport, try idle())
        XCTAssertFalse(resting.offersBusyModes)
        let sentIdle = await resting.send("Hello.", whenBusy: .steer)
        XCTAssertTrue(sentIdle)
        XCTAssertEqual(transport.sendModes, [.steer, nil, nil], "an older Mac would refuse whenBusy, and an idle Bot has nothing to steer")
    }

    // Test 6
    func testQueuedMessagesFollowTheirFramesAndAFreshSnapshotReplacesThem() async throws {
        let waiting = [AidenBotQueuedMessage(submissionId: "18", mode: .queue, text: "Also add a shopping list.")]
        let model = await loaded(FakeBotSessionTransport(), try running(nil))
        _ = await model.apply(event(seq: 5, .queued(waiting)))
        XCTAssertEqual(model.queued, waiting)
        _ = await model.apply(event(seq: 6, .snapshot(try running(nil, seq: 6))))
        XCTAssertEqual(model.queued, [])
    }

    /// FR-m1: an idle chat runs no once-a-second timer for a line that can't show.
    func testTheLineClockTicksOnlyWhileTheLineCanShow() async throws {
        let idleChat = await loaded(FakeBotSessionTransport(), try idle())
        XCTAssertFalse(idleChat.statusLineTicks, "an idle chat runs no timer")
        let working = await loaded(FakeBotSessionTransport(), try running(AidenBotSessionActivity(phase: "reading", startedAt: started)))
        XCTAssertTrue(working.statusLineTicks)
        let olderMac = await loaded(
            FakeBotSessionTransport(), try running(AidenBotSessionActivity(phase: "reading", startedAt: started)), supported: false
        )
        XCTAssertFalse(olderMac.statusLineTicks, "no line on a Mac without bot-activity-v1")

        // A message sent from idle ticks at once, before the Mac's state catches up.
        let transport = FakeBotSessionTransport()
        let sending = await loaded(transport, try idle())
        transport.holdSend = true
        let sent = Task { await sending.send("Hi") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        XCTAssertTrue(sending.statusLineTicks)
        transport.releaseSend()
        _ = await sent.value
    }

    func testAWordIsAnnouncedAtOnceAfterTheLineHid() {
        var announcer = AidenBotStatusAnnouncer()
        XCTAssertEqual(announcer.offer("Reading", at: 0).announce, "Reading")
        XCTAssertNil(announcer.offer("Reading", at: 0.5).announce)
        announcer.reset()
        XCTAssertEqual(announcer.offer("Reading", at: 0.6).announce, "Reading", "a new run's first word is news, with no wait")
    }

    // Test 7
    func testScreenReadersHearAStatusChangeAtMostEveryTwoSeconds() {
        var announcer = AidenBotStatusAnnouncer()
        XCTAssertEqual(announcer.offer("Reading", at: 0).announce, "Reading")
        XCTAssertNil(announcer.offer("Reading", at: 0.5).announce, "the same word is not repeated")
        let early = announcer.offer("Searching the web", at: 1)
        XCTAssertNil(early.announce)
        XCTAssertEqual(early.retryAfter ?? 0, 1, accuracy: 0.001)
        XCTAssertEqual(announcer.offer("Searching the web", at: 2).announce, "Searching the web")
        XCTAssertNil(announcer.offer("Writing", at: 3.9).announce)
        XCTAssertEqual(announcer.offer("Writing", at: 4).announce, "Writing")
    }
}

/// R14, R16–R18: every phone Bot action applies at once and reconciles with the Mac later.
@MainActor
final class AidenBotSessionOptimisticTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let started = 1_760_450_000_000
    private var roots: [URL] = []

    override func tearDown() {
        for root in roots { try? FileManager.default.removeItem(at: root) }
        roots = []
        super.tearDown()
    }

    private func session(
        _ state: AidenBotSessionStateKind,
        seq: Int = 4,
        blocked: AidenBotSessionBlockedReason? = nil,
        entries: [AidenBotSessionEntry] = [],
        activity: AidenBotSessionActivity? = nil,
        queued: [AidenBotQueuedMessage] = []
    ) throws -> AidenBotSession {
        AidenBotSession(
            botId: botID,
            epoch: "epoch_a",
            seq: seq,
            stateView: try AidenBotSessionStateView(state: state, blocked: blocked),
            partial: nil,
            entries: entries,
            hasOlder: false,
            activity: activity,
            queued: queued
        )
    }

    private func user(_ id: String, _ text: String, submissionId: String? = nil) -> AidenBotSessionEntry {
        .message(AidenBotSessionMessage(
            id: id, role: .user, text: text, createdAt: nil, label: nil, interrupted: false, submissionId: submissionId
        ))
    }

    private func assistant(_ id: String, _ text: String) -> AidenBotSessionEntry {
        .message(AidenBotSessionMessage(id: id, role: .assistant, text: text, createdAt: nil, label: nil, interrupted: false))
    }

    private func event(seq: Int, _ kind: AidenBotSessionEvent.Kind) -> AidenBotSessionEvent {
        AidenBotSessionEvent(botId: botID, epoch: "epoch_a", seq: seq, kind: kind)
    }

    /// Retries while connected wait a minute unless a test asks otherwise.
    private func model(
        _ transport: FakeBotSessionTransport,
        supported: Bool = true,
        key: AidenBotSessionKey? = nil,
        cache: AidenBotSessionCache? = nil,
        store: AidenBotOutboxStore? = nil,
        retryDelays: [Duration] = [.seconds(60)],
        requestLimit: Duration = .seconds(12),
        now: @escaping () -> Date = { Date() }
    ) -> AidenBotSessionModel {
        let model = AidenBotSessionModel(
            botID: botID,
            transport: transport,
            cacheKey: key,
            cache: cache ?? AidenBotSessionCache(),
            outboxStore: store,
            retryDelays: retryDelays,
            requestLimit: requestLimit,
            now: now
        )
        model.activitySupported = supported
        return model
    }

    private func loaded(
        _ transport: FakeBotSessionTransport,
        _ snapshot: AidenBotSession,
        supported: Bool = true,
        retryDelays: [Duration] = [.seconds(60)]
    ) async -> AidenBotSessionModel {
        transport.queueSession(.success(snapshot))
        let model = model(transport, supported: supported, retryDelays: retryDelays)
        await model.load()
        return model
    }

    private func temporaryStore(now: @escaping @Sendable () -> Date = { Date() }) -> (AidenBotOutboxStore, URL) {
        let root = FileManager.default.temporaryDirectory.appending(path: "bot-outbox-\(UUID().uuidString)", directoryHint: .isDirectory)
        roots.append(root)
        return (AidenBotOutboxStore(root: root, now: now), root)
    }

    private func serverError(status: Int, code: String) throws -> AidenRemoteClientError {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"\#(code)","message":"No.","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        return .server(statusCode: status, body: body)
    }

    private func waitUntil(_ condition: () -> Bool, what: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    private func stored(_ store: AidenBotOutboxStore, _ key: AidenBotSessionKey, count: Int) async throws {
        let deadline = Date().addingTimeInterval(5)
        while await store.load(key).count != count {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(count) stored messages") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// Every bubble of one text the chat would draw: transcript, the Mac's Queued, and outgoing.
    private func bubbles(_ text: String, in model: AidenBotSessionModel) -> Int {
        let transcript = model.entries.filter { entry in
            if case let .message(message) = entry { return message.role == .user && message.text == text }
            return false
        }.count
        return transcript + model.queued.filter { $0.text == text }.count + model.outgoing.filter { $0.text == text }.count
    }

    // MARK: Sending

    func testAMessageShowsAtOnceAndTheLineSaysGettingReadyBeforeTheMacAnswers() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.holdSend = true
        let sending = Task { await model.send("Plan my week.") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")

        let shown = try XCTUnwrap(model.outgoing.first)
        XCTAssertEqual(shown.text, "Plan my week.")
        XCTAssertEqual(model.look(of: shown), .sending)
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Getting ready")

        transport.releaseSend()
        let taken = await sending.value
        XCTAssertTrue(taken)
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sent, "it is the turn the Bot now works on, not a queued message")
        XCTAssertEqual(model.state, .running)
    }

    func testOnAnOlderMacAMessageNeverReadsQueuedAndNoLineShows() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.running), supported: false)
        transport.holdSend = true
        let sending = Task { await model.send("Also a list.") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sending)
        XCTAssertNil(model.statusLine(nowMs: started))
        transport.releaseSend()
        _ = await sending.value
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sent)
        XCTAssertNil(model.statusLine(nowMs: started))
        XCTAssertEqual(transport.sendModes, [nil])
    }

    func testOneSendAndItsEntryFromTheMacLeaveExactlyOneBubble() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle, entries: [user("entry_1", "Hi")]))
        _ = await model.send("Hi")
        XCTAssertEqual(bubbles("Hi", in: model), 2, "the earlier Hi and this one")

        _ = await model.apply(event(seq: 5, .entry(user("entry_2", "Hi"))))
        XCTAssertEqual(model.outgoing, [], "the Mac's entry stands in for it")
        XCTAssertEqual(bubbles("Hi", in: model), 2)
        _ = await model.apply(event(seq: 6, .entry(user("entry_2", "Hi"))))
        XCTAssertEqual(bubbles("Hi", in: model), 2, "a repeated entry is still one bubble")

        // A fresh snapshot reconciles the same way.
        _ = await model.send("Thanks")
        _ = await model.apply(event(seq: 7, .snapshot(try session(.running, seq: 7, entries: [
            user("entry_1", "Hi"), user("entry_2", "Hi"), user("entry_3", "Thanks"),
        ]))))
        XCTAssertEqual(bubbles("Thanks", in: model), 1)
    }

    func testATakenMessageSettlesOnlyOnTheEntryWithItsSubmissionId() async throws {
        let transport = FakeBotSessionTransport()
        transport.queueReceiptID("17")
        transport.queueReceiptID("18")
        let model = await loaded(transport, try session(.idle))
        _ = await model.send("Hi")
        _ = await model.send("Hi")
        let first = try XCTUnwrap(model.outgoing.first)
        XCTAssertEqual(model.outgoing.map(\.status), [.sent(submissionId: "17"), .sent(submissionId: "18")])

        _ = await model.apply(event(seq: 5, .entry(user("entry_9", "Hi", submissionId: "99"))))
        XCTAssertEqual(model.outgoing.count, 2, "another submission's Hi settles neither")
        _ = await model.apply(event(seq: 6, .entry(user("entry_10", "Hi", submissionId: "18"))))
        XCTAssertEqual(model.outgoing.map(\.key), [first.key], "the second Hi settled, though the first came first")
        _ = await model.apply(event(seq: 7, .entry(user("entry_11", "Hi", submissionId: "17"))))
        XCTAssertEqual(model.outgoing, [])
        XCTAssertEqual(bubbles("Hi", in: model), 3)
    }

    func testTwoIdenticalTextsKeepTwoBubblesAndTheDeferredOneStillGoesOut() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle), supported: false)
        _ = await model.send("Hi")
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await model.send("Hi")
        let second = try XCTUnwrap(model.outgoing.last)
        XCTAssertEqual(bubbles("Hi", in: model), 2)

        // An older Mac's entries carry no submission id: text settles the first Hi only.
        _ = await model.apply(event(seq: 5, .entry(user("entry_1", "Hi"))))
        XCTAssertEqual(bubbles("Hi", in: model), 2)
        _ = await model.apply(event(seq: 6, .entry(assistant("entry_2", "Hello!"))))
        XCTAssertEqual(bubbles("Hi", in: model), 2, "an entry settles one message for good")
        XCTAssertEqual(model.outgoing.map(\.key), [second.key])

        transport.queueSession(.success(try session(.running, seq: 6, entries: [user("entry_1", "Hi"), assistant("entry_2", "Hello!")])))
        await model.load()
        XCTAssertEqual(transport.sendKeys.suffix(2), [second.key, second.key], "the deferred Hi went out under its key")
        XCTAssertEqual(bubbles("Hi", in: model), 2)
        _ = await model.apply(event(seq: 7, .entry(user("entry_3", "Hi"))))
        XCTAssertEqual(model.outgoing, [])
        XCTAssertEqual(bubbles("Hi", in: model), 2)
    }

    func testADeferredMessageHoldsBackTheOnesBehindIt() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await model.send("First")
        _ = await model.send("Second")
        XCTAssertEqual(transport.sendTexts, ["First"], "nothing overtakes a message waiting to retry")
        XCTAssertEqual(model.outgoing.map(\.text), ["First", "Second"])

        transport.queueSession(.success(try session(.idle, seq: 5)))
        await model.load()
        XCTAssertEqual(transport.sendTexts, ["First", "First", "Second"])
        XCTAssertEqual(model.outgoing.map { model.look(of: $0) }, [.sent, .sent])
    }

    func testWhileTheBotWorksAMessageIsQueuedInItsModeAndTheMacsBubbleReplacesIt() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.running, activity: AidenBotSessionActivity(phase: "reading", startedAt: started)))
        transport.holdSend = true
        let sending = Task { await model.send("Keep it vegetarian.", whenBusy: .steer) }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .queued(.steer), "Queued at once, before the Mac answers")
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Reading", "the running turn keeps its line")

        // The Mac's Queued frame can arrive before its receipt.
        let onMac = AidenBotQueuedMessage(submissionId: "17", mode: .steer, text: "Keep it vegetarian.")
        _ = await model.apply(event(seq: 5, .queued([onMac])))
        XCTAssertEqual(bubbles("Keep it vegetarian.", in: model), 1)
        transport.releaseSend()
        _ = await sending.value
        XCTAssertEqual(bubbles("Keep it vegetarian.", in: model), 1)

        // The turn takes it in: the queue empties, and then its entry lands.
        _ = await model.apply(event(seq: 6, .queued([])))
        XCTAssertEqual(bubbles("Keep it vegetarian.", in: model), 1, "between the Mac's frames it keeps its bubble")
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sent)
        _ = await model.apply(event(seq: 7, .entry(user("entry_9", "Keep it vegetarian.", submissionId: "17"))))
        XCTAssertEqual(bubbles("Keep it vegetarian.", in: model), 1)
        XCTAssertEqual(model.outgoing, [])
    }

    /// FR-m5: the queued list caps at 20 and the Mac leaves out what it can't
    /// classify, so one snapshot that doesn't show a taken message is no proof.
    func testATakenMessageASnapshotDoesNotShowStaysThroughTheGraceAndThenGoes() async throws {
        var clock = Date()
        let reading = AidenBotSessionActivity(phase: "reading", startedAt: started)
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.running, activity: reading)))
        let model = model(transport, now: { clock })
        await model.load()
        _ = await model.send("Also add a shopping list.", whenBusy: .queue)
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"))

        let full = (1...20).map { AidenBotQueuedMessage(submissionId: "q\($0)", mode: .queue, text: "Other \($0)") }
        _ = await model.apply(event(seq: 5, .snapshot(try session(.running, seq: 5, activity: reading, queued: full))))
        XCTAssertEqual(bubbles("Also add a shopping list.", in: model), 1, "a full queue may simply not list it")
        clock = clock.addingTimeInterval(AidenBotSessionModel.unheldGrace / 2)
        _ = await model.apply(event(seq: 6, .snapshot(try session(.running, seq: 6, activity: reading, queued: full))))
        XCTAssertEqual(bubbles("Also add a shopping list.", in: model), 1, "a later snapshot inside the grace keeps it")

        clock = clock.addingTimeInterval(AidenBotSessionModel.unheldGrace)
        _ = await model.apply(event(seq: 7, .activity(AidenBotSessionActivity(phase: "searching", startedAt: started))))
        XCTAssertEqual(bubbles("Also add a shopping list.", in: model), 0, "nothing held it for the whole grace: it goes")
    }

    func testATakenMessageTheMacShowsAgainAfterAMissIsHeldAgain() async throws {
        var clock = Date()
        let reading = AidenBotSessionActivity(phase: "reading", startedAt: started)
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.running, activity: reading)))
        let model = model(transport, now: { clock })
        await model.load()
        _ = await model.send("Also add a shopping list.", whenBusy: .queue)

        _ = await model.apply(event(seq: 5, .snapshot(try session(.running, seq: 5, activity: reading))))
        XCTAssertEqual(bubbles("Also add a shopping list.", in: model), 1)
        // The Mac lists it after all, then the turn takes it in.
        let onMac = AidenBotQueuedMessage(submissionId: "17", mode: .queue, text: "Also add a shopping list.")
        _ = await model.apply(event(seq: 6, .queued([onMac])))
        _ = await model.apply(event(seq: 7, .queued([])))
        clock = clock.addingTimeInterval(AidenBotSessionModel.unheldGrace * 2)
        _ = await model.apply(event(seq: 8, .activity(AidenBotSessionActivity(phase: "searching", startedAt: started))))
        XCTAssertEqual(bubbles("Also add a shopping list.", in: model), 1, "held again: its entry is on the way")
        _ = await model.apply(event(seq: 9, .entry(user("entry_9", "Also add a shopping list.", submissionId: "17"))))
        XCTAssertEqual(bubbles("Also add a shopping list.", in: model), 1)
        XCTAssertEqual(model.outgoing, [])
    }

    /// R21: a request frozen while the cached capability said Steer/Queue goes
    /// again byte for byte, even after `/server` says this Mac doesn't offer them.
    func testASendFrozenUnderTheCachedCapabilityReplaysExactly() async throws {
        let reading = AidenBotSessionActivity(phase: "reading", startedAt: started)
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.running, activity: reading))
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await model.send("Keep it vegetarian.", whenBusy: .steer)
        XCTAssertEqual(transport.sendModes, [.steer])

        model.activitySupported = false
        _ = await model.apply(event(seq: 5, .snapshot(try session(.running, seq: 5, activity: reading))))
        try await waitUntil({ transport.sendKeys.count == 2 }, what: "the replay")
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "the same key")
        XCTAssertEqual(transport.sendModes, [.steer, .steer], "the same body, whenBusy included")
        XCTAssertEqual(transport.sendTexts, ["Keep it vegetarian.", "Keep it vegetarian."])
    }

    func testAnEntryThatArrivesBeforeTheReceiptHidesTheMessageUntilTheReceiptSettlesIt() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.holdSend = true
        let sending = Task { await model.send("Hi") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        _ = await model.apply(event(seq: 5, .entry(user("entry_1", "Hi"))))
        XCTAssertEqual(bubbles("Hi", in: model), 1, "the entry stands in while the request is unsettled")
        XCTAssertTrue(model.isAwaitingTurn, "the unsettled message is kept until its receipt")
        transport.releaseSend()
        _ = await sending.value
        XCTAssertEqual(bubbles("Hi", in: model), 1)
        XCTAssertFalse(model.isAwaitingTurn)
    }

    // MARK: The outbox

    func testBeforeTheConnectionAMessageWaitsAndGoesOutOnConnectWithItsKey() async throws {
        let transport = FakeBotSessionTransport()
        let model = model(transport)
        XCTAssertTrue(model.showsSkeleton, "skeleton bubbles, not a spinner")
        XCTAssertTrue(model.isConnecting)
        XCTAssertTrue(model.canSend, "the composer never waits for the connection")

        let taken = await model.send("Plan my week.")
        XCTAssertTrue(taken)
        XCTAssertEqual(model.outgoing.map(\.text), ["Plan my week."])
        XCTAssertEqual(transport.sendKeys, [], "nothing goes out before the Mac answers")
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Getting ready")

        transport.queueSession(.success(try session(.idle)))
        await model.load()
        XCTAssertFalse(model.showsSkeleton)
        XCTAssertFalse(model.isConnecting)
        XCTAssertEqual(transport.sendKeys.count, 1)
        XCTAssertEqual(model.outgoing.first?.key, transport.sendKeys.first)
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testAMessageForABotThatNeedsAModelIsMarkedNotSentOnConnect() async throws {
        let transport = FakeBotSessionTransport()
        let model = model(transport)
        _ = await model.send("Hello")
        transport.queueSession(.success(try session(.needsModel)))
        await model.load()
        XCTAssertEqual(transport.sendKeys, [])
        XCTAssertEqual(model.outgoing.map { model.look(of: $0) }, [.failed], "never dropped silently")
        let again = await model.send("Again")
        XCTAssertFalse(again, "a Bot that needs a model takes nothing new")
    }

    func testALostConnectionKeepsTheMessageAndItsKeyUntilTheMacIsBack() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await model.send("Plan my week.")
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sending, "it keeps its place")
        XCTAssertEqual(transport.sendKeys.count, 1)

        transport.queueSession(.success(try session(.idle, seq: 5)))
        await model.load()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "the same message, the same key")
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testWhileConnectedAMessageRetriesAFewTimesUnderItsKeyAndThenSaysSo() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle), retryDelays: [.milliseconds(20)])
        for _ in 0..<AidenBotSessionModel.maxConnectionAttempts {
            transport.failNextSend(with: try serverError(status: 500, code: "internal_error"))
        }
        _ = await model.send("Plan my week.")
        try await waitUntil({ model.outgoing.first.map { model.look(of: $0) } == .failed }, what: "the last try")
        XCTAssertEqual(transport.sendKeys.count, AidenBotSessionModel.maxConnectionAttempts, "no reconnect was needed")
        XCTAssertEqual(Set(transport.sendKeys).count, 1)

        let retried = await model.retrySend(try XCTUnwrap(model.outgoing.first).id)
        XCTAssertTrue(retried)
        XCTAssertEqual(Set(transport.sendKeys).count, 1, "the Mac may hold it, so Try again replays the key")
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testClosingTheChatCancelsTheRetryTimer() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle), retryDelays: [.milliseconds(50)])
        transport.failNextSend(with: URLError(.timedOut))
        _ = await model.send("Plan my week.")
        model.release()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(transport.sendKeys.count, 1)
    }

    func testARefusedMessageSaysCouldntSendAndTryAgainIsANewRequestThatCanBeRemoved() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.failNextSend(with: try serverError(status: 400, code: "invalid_request"))
        _ = await model.send("First")
        let refused = try XCTUnwrap(model.outgoing.first)
        XCTAssertEqual(model.look(of: refused), .failed)
        model.discardSend(refused.id)
        XCTAssertEqual(model.outgoing, [], "a message that couldn't be sent can be removed")

        transport.failNextSend(with: try serverError(status: 400, code: "invalid_request"))
        _ = await model.send("Second")
        let again = try XCTUnwrap(model.outgoing.first)
        let retried = await model.retrySend(again.id)
        XCTAssertTrue(retried)
        XCTAssertEqual(transport.sendKeys.count, 3)
        XCTAssertNotEqual(transport.sendKeys[2], transport.sendKeys[1], "the Mac never took it, so it is a new request")
        model.discardSend(try XCTUnwrap(model.outgoing.first).id)
        XCTAssertEqual(model.outgoing.count, 1, "only a message that couldn't be sent can be removed")
    }

    func testUnsentMessagesOutliveLeavingTheChatAndGoOutOnReturn() async throws {
        let transport = FakeBotSessionTransport()
        let cache = AidenBotSessionCache()
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        transport.queueSession(.success(try session(.idle)))
        let first = model(transport, key: key, cache: cache)
        await first.load()
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await first.send("Plan my week.")
        first.release()

        let reopened = model(transport, key: key, cache: cache)
        XCTAssertEqual(reopened.outgoing.map(\.text), ["Plan my week."], "it shows at once on return")
        transport.queueSession(.success(try session(.idle)))
        await reopened.load()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1])
        XCTAssertEqual(reopened.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testUnsentMessagesSurviveARelaunchForADay() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let beforeRelaunch = model(transport, key: key, store: store)
        _ = await beforeRelaunch.send("Plan my week.")
        let sentKey = try XCTUnwrap(beforeRelaunch.outgoing.first?.key)
        try await stored(store, key, count: 1)

        // A new launch: a fresh memory cache, the same disk.
        let relaunched = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
        transport.queueSession(.success(try session(.idle)))
        await relaunched.load()
        XCTAssertEqual(transport.sendKeys, [sentKey])
        XCTAssertEqual(relaunched.outgoing.first?.status, .sent(submissionId: "17"))

        // A day later the Mac has it: a taken message isn't kept.
        let deadline = Date().addingTimeInterval(5)
        while await store.load(key).first?.status != .sent(submissionId: "17") {
            guard Date() < deadline else { return XCTFail("Timed out waiting for the taken message on disk") }
            try await Task.sleep(for: .milliseconds(10))
        }
        let later = AidenBotOutboxStore(root: root, now: { Date().addingTimeInterval(25 * 60 * 60) })
        let laterLoad = await later.load(key)
        XCTAssertEqual(laterLoad, [])

        // The unsent messages stay on this device, never in a backup.
        let values = try root.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testASendBeforeTheRestoreKeepsTheLastLaunchesUnsentMessagesOnDiskAndInMemory() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        // The last launch left one unsent message on disk (never connected, so never sent).
        let lastLaunch = model(FakeBotSessionTransport(), key: key, cache: AidenBotSessionCache(), store: store)
        _ = await lastLaunch.send("Left last launch")
        try await stored(store, key, count: 1)
        lastLaunch.release()

        // A new launch: the composer takes a message before the restore has read the file.
        let transport = FakeBotSessionTransport()
        let relaunched = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
        _ = await relaunched.send("Plan my week.")
        try await Task.sleep(for: .milliseconds(100))
        // The send's write has had time to land; it must not have replaced the previous launch's file.
        let beforeLoad = await store.load(key)
        XCTAssertTrue(
            beforeLoad.map(\.text).contains("Left last launch"),
            "a write before the restore would replace the previous launch's file"
        )

        transport.queueSession(.success(try session(.idle)))
        await relaunched.load()
        XCTAssertEqual(
            relaunched.outbox.map(\.text), ["Left last launch", "Plan my week."],
            "both messages are in memory, oldest first"
        )
        try await stored(store, key, count: 2)
        let onDisk = await store.load(key)
        XCTAssertEqual(onDisk.map(\.text), ["Left last launch", "Plan my week."], "both survive a relaunch")
    }

    func testARestoreThatLandsAfterAnAccessLossPurgeIsDropped() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        // The last launch left one unsent message on disk.
        let lastLaunch = model(FakeBotSessionTransport(), key: key, cache: AidenBotSessionCache(), store: store)
        _ = await lastLaunch.send("Left last launch")
        try await stored(store, key, count: 1)
        lastLaunch.release()

        // A new launch reads the file, and is held before the read reaches the chat.
        let gate = TestGate()
        gate.hold()
        await store.setAfterRead { await gate.pass() }
        let relaunched = model(FakeBotSessionTransport(), key: key, cache: AidenBotSessionCache(), store: store)
        _ = await relaunched.send("Plan my week.")
        try await waitUntil({ gate.isHolding }, what: "the restore to read the file")

        // Access is lost while the restore is held.
        let blocked = try session(.interrupted, blocked: .accessChanged)
        _ = await relaunched.apply(AidenBotSessionEvent(botId: botID, epoch: "epoch_a", seq: 4, kind: .snapshot(blocked)))
        XCTAssertEqual(relaunched.outbox, [])

        gate.releaseAll()
        await relaunched.restoreOutbox()
        XCTAssertEqual(relaunched.outbox, [], "the restore lands after the purge and brings nothing back")
        XCTAssertEqual(relaunched.errorMessage, "That message wasn’t sent. Please try again.")
        XCTAssertTrue(relaunched.isAccessBlocked)
        try await stored(store, key, count: 0)
    }

    func testAMessageStillUnsentAfterADaySaysCouldntSendInsteadOfGoingOutLate() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let beforeRelaunch = model(transport, key: key, store: store)
        _ = await beforeRelaunch.send("Plan my week.")
        try await stored(store, key, count: 1)

        // Restored a day later: shown as not sent, never dropped and never sent late.
        let later = AidenBotOutboxStore(root: root, now: { Date().addingTimeInterval(25 * 60 * 60) })
        let relaunched = model(transport, key: key, cache: AidenBotSessionCache(), store: later)
        transport.queueSession(.success(try session(.idle)))
        await relaunched.load()
        XCTAssertEqual(relaunched.outgoing.map { relaunched.look(of: $0) }, [.failed])
        XCTAssertEqual(transport.sendKeys, [])
        let retried = await relaunched.retrySend(try XCTUnwrap(relaunched.outgoing.first).id)
        XCTAssertTrue(retried)
        XCTAssertEqual(relaunched.outgoing.first?.status, .sent(submissionId: "17"), "Try again sends it")

        // The same in memory: a chat left open a day doesn't send a day-old message.
        var clock = Date()
        let open = model(transport, now: { clock })
        _ = await open.send("Remind me at noon.")
        clock = clock.addingTimeInterval(25 * 60 * 60)
        transport.queueSession(.success(try session(.idle)))
        await open.load()
        XCTAssertEqual(open.outgoing.map { open.look(of: $0) }, [.failed])
        XCTAssertEqual(transport.sendKeys.count, 1, "only the Try again above went out")
    }

    func testABadRecordCostsOnlyItselfAndAFullOutboxRefusesVisibly() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let writer = model(transport, key: key, store: store)
        _ = await writer.send("First")
        _ = await writer.send("Second")
        try await stored(store, key, count: 2)

        // Damage the first record on disk.
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "json" }
        let file = try XCTUnwrap(files.first)
        XCTAssertEqual(files.count, 1)
        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var messages = try XCTUnwrap(envelope["messages"] as? [[String: Any]])
        messages[0]["key"] = "not a uuid"
        envelope["messages"] = messages
        try JSONSerialization.data(withJSONObject: envelope).write(to: file)
        let survivors = await store.load(key)
        XCTAssertEqual(survivors.map(\.text), ["Second"])

        // A chat holds at most so many unsent messages; the next is refused, and says so.
        let full = model(transport)
        for index in 0..<AidenBotOutboxStore.maxMessages {
            let taken = await full.send("Message \(index)")
            XCTAssertTrue(taken)
        }
        let refused = await full.send("One too many")
        XCTAssertFalse(refused)
        XCTAssertEqual(full.errorMessage, AidenBotSessionModel.outboxFull)
        XCTAssertEqual(full.outgoing.count, AidenBotOutboxStore.maxMessages)
    }

    func testARepairedPhoneNeverRestoresTheOldPairingsMessages() async throws {
        let (store, _) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let old = model(transport, key: AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID), store: store)
        _ = await old.send("Plan my week.")
        try await stored(store, AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID), count: 1)

        let repaired = model(
            transport,
            key: AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_2", botID: botID),
            cache: AidenBotSessionCache(),
            store: store
        )
        transport.queueSession(.success(try session(.idle)))
        await repaired.load()
        XCTAssertEqual(repaired.outgoing, [])
        XCTAssertEqual(transport.sendKeys, [])
    }

    func testReopeningWhileTheOldChatsRequestIsInFlightNeverLosesTheNewMessage() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        let cache = AidenBotSessionCache()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle)))
        let old = model(transport, key: key, cache: cache, store: store)
        await old.load()
        transport.holdSend = true
        let oldSend = Task { await old.send("First") }
        try await waitUntil({ transport.isHoldingSend }, what: "the old chat's request")

        // The chat is reopened before the old one lets go; the new one owns the outbox.
        let reopened = model(transport, key: key, cache: cache, store: store)
        _ = await reopened.send("Second")
        transport.releaseSend()
        _ = await oldSend.value
        old.release()

        // The new chat writes once it has read the file; adopting its outbox below takes the chat from it.
        try await stored(store, key, count: 2)
        let onDisk = await store.load(key)
        XCTAssertEqual(onDisk.map(\.text), ["First", "Second"])
        XCTAssertEqual(cache.adoptOutbox(for: key, owner: ObjectIdentifier(self)).map(\.text), ["First", "Second"])
    }

    func testLosingAccessPurgesTheOutboxFromMemoryAndDisk() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        let cache = AidenBotSessionCache()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle)))
        let model = model(transport, key: key, cache: cache, store: store)
        await model.load()
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await model.send("Plan my week.")
        try await stored(store, key, count: 1)

        transport.failNextSend(with: try serverError(status: 403, code: "capability_denied"))
        transport.queueSession(.success(try session(.idle, seq: 5)))
        await model.load()
        XCTAssertEqual(model.outgoing, [])
        XCTAssertNotNil(model.errorMessage, "the person is told it wasn't sent")
        try await stored(store, key, count: 0)
        XCTAssertEqual(cache.adoptOutbox(for: key, owner: ObjectIdentifier(self)), [])

        // A Bot whose access changed loses what waited for it too.
        let other = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: "bot_fixture_02")
        let blockedTransport = FakeBotSessionTransport()
        let blocked = AidenBotSessionModel(botID: botID, transport: blockedTransport, cacheKey: other, cache: cache, outboxStore: store)
        _ = await blocked.send("Hello")
        try await stored(store, other, count: 1)
        blockedTransport.queueSession(.success(try session(.interrupted, blocked: .accessChanged)))
        await blocked.load()
        XCTAssertEqual(blocked.outgoing, [])
        XCTAssertNotNil(blocked.errorMessage, "the person is told it wasn't sent")
        XCTAssertEqual(blockedTransport.sendKeys, [])
        try await stored(store, other, count: 0)
    }

    func testAChatOpensOnItsLastTranscriptWhileTheMacAnswers() async throws {
        let cache = AidenBotSessionCache()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle, entries: [user("entry_1", "Hi")])))
        let first = model(transport, key: AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID), cache: cache)
        await first.load()
        _ = await first.apply(event(seq: 5, .entry(assistant("entry_2", "Hello!"))))

        let reopened = model(transport, key: AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID), cache: cache)
        XCTAssertEqual(reopened.entries.map(\.id), ["entry_1", "entry_2"], "frames update the cache too")
        XCTAssertFalse(reopened.showsSkeleton)
        XCTAssertFalse(reopened.hasLoaded, "cards and answers wait for the Mac")
        XCTAssertTrue(reopened.isConnecting)

        let otherMac = model(transport, key: AidenBotSessionKey(instanceId: "mac_b", deviceId: "device_1", botID: botID), cache: cache)
        XCTAssertTrue(otherMac.showsSkeleton)
        cache.purge(instanceId: "mac_a")
        XCTAssertTrue(model(transport, key: AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID), cache: cache).showsSkeleton, "unpairing forgets it")
    }

    // MARK: Turn controls

    func testStopSaysStoppingAtOnceAndGoesBackWhenItFails() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.running, activity: AidenBotSessionActivity(phase: "reading", startedAt: started)))
        transport.holdStop = true
        transport.queueStop(.failure(URLError(.notConnectedToInternet)))
        let stopping = Task { await model.stop() }
        try await waitUntil({ transport.isHoldingStop }, what: "the Stop request")
        XCTAssertTrue(model.isStopping)
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Stopping")
        transport.releaseStop()
        await stopping.value
        XCTAssertFalse(model.isStopping)
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Reading", "a Stop the Mac didn't take goes back")

        // Taken while the turn winds down: "Stopping" holds until the Mac speaks.
        transport.holdStop = false
        transport.queueStop(.success(try AidenBotSessionStateView(state: .running)))
        await model.stop()
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Stopping")
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "stopping", startedAt: started))))
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Stopping")
        _ = await model.apply(event(seq: 6, .state(try AidenBotSessionStateView(state: .idle))))
        _ = await model.apply(event(seq: 7, .activity(nil)))
        _ = await model.apply(event(seq: 8, .state(try AidenBotSessionStateView(state: .running))))
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Getting ready", "the next turn never starts at Stopping")
    }

    func testAStopPressedAsANewRunStartsLeavesTheNewRunAlone() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.running, activity: AidenBotSessionActivity(phase: "reading", startedAt: started)))
        transport.holdStop = true
        transport.queueStop(.success(try AidenBotSessionStateView(state: .running)))
        let stopping = Task { await model.stop() }
        try await waitUntil({ transport.isHoldingStop }, what: "the Stop request")
        // A queued follow-up replaced the run while the state stayed running.
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "searching", startedAt: started + 9_000))))
        XCTAssertFalse(model.isStopping)
        XCTAssertEqual(model.statusLine(nowMs: started + 9_000)?.display.word, "Searching the web")
        transport.releaseStop()
        await stopping.value
        XCTAssertEqual(model.statusLine(nowMs: started + 9_000)?.display.word, "Searching the web")
    }

    func testAReceiptFromBeforeNewerFramesDoesNotRollTheStateBack() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.holdSend = true
        let sending = Task { await model.send("Hi") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        _ = await model.apply(event(seq: 5, .state(try AidenBotSessionStateView(state: .running))))
        _ = await model.apply(event(seq: 6, .state(try AidenBotSessionStateView(state: .idle))))
        transport.releaseSend() // the receipt says running
        _ = await sending.value
        XCTAssertEqual(model.state, .idle, "the frames are newer than the receipt")
    }

    func testRetryShowsAtOnceThroughTheOutbox() async throws {
        let transport = FakeBotSessionTransport()
        let turn = AidenBotSessionEntry.failedTurn(AidenBotFailedTurn(id: "t1:failed", createdAt: nil, retryText: "Plan my week."))
        let model = await loaded(transport, try session(.idle, entries: [turn]))
        transport.holdSend = true
        let retrying = Task { await model.retry() }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        XCTAssertEqual(model.outgoing.map(\.text), ["Plan my week."])
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Getting ready")
        XCTAssertNil(model.retryableFailedTurn, "its Retry is on its way")
        XCTAssertTrue(model.inFlight.contains(.retry))
        transport.releaseSend()
        let retried = await retrying.value
        XCTAssertTrue(retried)
    }

    func testResumeShowsPickingUpAtOnceAndGoesBackWhenItFails() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.interrupted))
        XCTAssertTrue(model.isInterrupted)
        transport.holdResume = true
        transport.queueResume(.failure(try serverError(status: 409, code: "invalid_request")))
        let resuming = Task { await model.resume() }
        try await waitUntil({ transport.isHoldingResume }, what: "the Resume request")
        XCTAssertFalse(model.isInterrupted, "the paused card goes at once")
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Picking up where it left off")
        transport.releaseResume()
        await resuming.value
        XCTAssertTrue(model.isInterrupted, "a Resume the Mac didn't take goes back")
        XCTAssertNil(model.statusLine(nowMs: started))
        XCTAssertNotNil(model.errorMessage)
    }

    func testDismissClearsThePausedCardAtOnceAndBringsItBackOnFailure() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.interrupted))
        transport.dismissGate.hold()
        transport.queueDismiss(.failure(URLError(.notConnectedToInternet)))
        let dismissing = Task { await model.dismiss() }
        try await waitUntil({ transport.dismissGate.isHolding }, what: "the Dismiss request")
        XCTAssertFalse(model.isInterrupted)
        transport.dismissGate.release()
        await dismissing.value
        XCTAssertTrue(model.isInterrupted)
        XCTAssertNotNil(model.errorMessage)
    }

    func testARoutineAnswerSettlesTheCardAtOnceAndGoesBackOnFailure() async throws {
        let transport = FakeBotSessionTransport()
        let card = AidenBotRoutineProposalCard(
            id: "entry_p", proposalId: "7d0c5c8e-2f0b-4c4e-9a59-3b6f1f0e9a11", name: "Plan", prompt: "Plan my day.",
            label: "Every day at 9:00 AM", status: .pending, routineId: nil, createdAt: nil
        )
        let model = await loaded(transport, try session(.idle, entries: [.routineProposal(card)]))
        transport.proposalGate.hold()
        transport.queueProposalResult(.failure(URLError(.notConnectedToInternet)))
        let answering = Task { await model.respondToProposal(card.proposalId, decision: .accept) }
        try await waitUntil({ transport.proposalGate.isHolding }, what: "the answer")
        guard case let .routineProposal(shown) = model.entries.first else { return XCTFail("the card") }
        XCTAssertEqual(shown.status, .accepted, "Added at once")
        transport.proposalGate.release()
        _ = await answering.value
        guard case let .routineProposal(back) = model.entries.first else { return XCTFail("the card") }
        XCTAssertEqual(back.status, .pending, "the actions come back")
        XCTAssertNotNil(model.errorMessage)
    }

    func testQuestionAndApprovalAnswersApplyAtOnceAndComeBackOnFailure() async throws {
        let question = #"{"waitId":"5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c","toolCallId":"call_1","questions":[{"question":"Which colour should the banner use?","header":"Colour","multiSelect":false,"options":[{"label":"Blue","description":"Calm and cool."},{"label":"Red","description":"Loud and warm."}]}]}"#
        let json = """
        {"botId":"bot_fixture_01","epoch":"epoch_1","seq":0,"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":\(question),"approval":null}
        """
        let transport = QuestionTransport(snapshot: try JSONDecoder().decode(AidenBotSession.self, from: Data(json.utf8)))
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        await model.load()
        XCTAssertNotNil(model.question)
        transport.answerGate.hold()
        transport.nextAnswerError = URLError(.notConnectedToInternet)
        let answering = Task {
            await model.answerQuestion(AidenQuestionRespondRequest(cancelled: false, answers: [.option(questionIndex: 0, answer: "Blue")]))
        }
        try await waitUntil({ transport.answerGate.isHolding }, what: "the answer")
        XCTAssertNil(model.question, "the card goes at once")
        transport.answerGate.release()
        await answering.value
        XCTAssertNotNil(model.question, "and comes back when the answer didn't arrive")
        XCTAssertNotNil(model.errorMessage)
    }

    // MARK: Fix round 2

    func testAFailedResumeOrDismissGoesBackEvenAfterAnUnrelatedFrame() async throws {
        for action in ["resume", "dismiss"] {
            let transport = FakeBotSessionTransport()
            let model = await loaded(transport, try session(.interrupted))
            let task: Task<Void, Never>
            if action == "resume" {
                transport.holdResume = true
                transport.queueResume(.failure(try serverError(status: 409, code: "invalid_request")))
                task = Task { await model.resume() }
                try await waitUntil({ transport.isHoldingResume }, what: "the Resume request")
            } else {
                transport.dismissGate.hold()
                transport.queueDismiss(.failure(try serverError(status: 409, code: "invalid_request")))
                task = Task { await model.dismiss() }
                try await waitUntil({ transport.dismissGate.isHolding }, what: "the Dismiss request")
            }
            XCTAssertFalse(model.isInterrupted, action)
            _ = await model.apply(event(seq: 5, .entry(assistant("entry_1", "Still here."))))
            if action == "resume" { transport.releaseResume() } else { transport.dismissGate.release() }
            await task.value
            XCTAssertTrue(model.isInterrupted, "\(action): an unrelated frame doesn't keep a failed action's look")
            XCTAssertNotNil(model.errorMessage, action)
        }

        // A state the Mac wrote meanwhile is its truth, and stays.
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.interrupted))
        transport.holdResume = true
        transport.queueResume(.failure(URLError(.notConnectedToInternet)))
        let resuming = Task { await model.resume() }
        try await waitUntil({ transport.isHoldingResume }, what: "the Resume request")
        _ = await model.apply(event(seq: 5, .state(try AidenBotSessionStateView(state: .running))))
        transport.releaseResume()
        await resuming.value
        XCTAssertEqual(model.state, .running)
        XCTAssertFalse(model.isInterrupted)
    }

    func testAFailedQuestionOrApprovalAnswerComesBackEvenAfterAnUnrelatedFrame() async throws {
        let question = #"{"waitId":"5f0c1a2e-7b3d-4e9a-8c61-0d2e3f4a5b6c","toolCallId":"call_1","questions":[{"question":"Which colour should the banner use?","header":"Colour","multiSelect":false,"options":[{"label":"Blue","description":"Calm and cool."},{"label":"Red","description":"Loud and warm."}]}]}"#
        let approval = #"{"waitId":"8d1e2f3a-4b5c-4d6e-9f70-a1b2c3d4e5f6","toolCallId":"call_2","toolName":"mcp__mail__send_email","summary":"Send an email to dana@example.com","canAllow":true}"#
        for card in ["question", "approval"] {
            let json = """
            {"botId":"bot_fixture_01","epoch":"epoch_1","seq":0,"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":\(card == "question" ? question : "null"),"approval":\(card == "approval" ? approval : "null")}
            """
            let transport = QuestionTransport(snapshot: try JSONDecoder().decode(AidenBotSession.self, from: Data(json.utf8)))
            let model = AidenBotSessionModel(botID: botID, transport: transport)
            await model.load()
            transport.answerGate.hold()
            let task: Task<Void, Never>
            if card == "question" {
                transport.nextAnswerError = URLError(.notConnectedToInternet)
                task = Task {
                    await model.answerQuestion(AidenQuestionRespondRequest(cancelled: false, answers: [.option(questionIndex: 0, answer: "Blue")]))
                }
            } else {
                transport.nextApprovalError = URLError(.notConnectedToInternet)
                task = Task { await model.answerApproval(.allow) }
            }
            try await waitUntil({ transport.answerGate.isHolding }, what: "the answer")
            XCTAssertNil(card == "question" ? model.question?.waitId : model.approval?.waitId, "\(card) goes at once")
            _ = await model.apply(AidenBotSessionEvent(botId: botID, epoch: "epoch_1", seq: 1, kind: .partial("Working on it")))
            transport.answerGate.release()
            await task.value
            if card == "question" {
                XCTAssertNotNil(model.question, "the question comes back after an unrelated frame")
            } else {
                XCTAssertNotNil(model.approval, "the approval comes back after an unrelated frame")
            }
            XCTAssertNotNil(model.errorMessage, card)
        }
    }

    func testAStreamThatLosesAccessPurgesAndSaysSoWithoutTheRefreshOverwritingIt() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let model = model(transport, key: key, store: store)
        _ = await model.send("Plan my week.")
        try await stored(store, key, count: 1)
        transport.queueStreamFailure(try serverError(status: 401, code: "authentication_required"))
        let listener = Task { await model.listen() }
        try await waitUntil({ model.outgoing.isEmpty }, what: "the purge")
        listener.cancel()
        await listener.value
        XCTAssertEqual(model.errorMessage, "That message wasn’t sent. Please try again.")
        try await stored(store, key, count: 0)

        transport.queueSession(.failure(try serverError(status: 401, code: "authentication_required")))
        await model.load() // the refresh fails with 401 too: the notice stays
        XCTAssertEqual(model.errorMessage, "That message wasn’t sent. Please try again.")
    }

    func testAnEchoNamingAnotherSubmissionGivesWayWhenTheReceiptDisagrees() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.holdSend = true
        let sending = Task { await model.send("Hi") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        _ = await model.apply(event(seq: 5, .entry(user("entry_1", "Hi", submissionId: "99"))))
        XCTAssertEqual(bubbles("Hi", in: model), 1)
        transport.releaseSend() // the receipt names 17
        _ = await sending.value
        XCTAssertEqual(model.outgoing.map(\.status), [.sent(submissionId: "17")], "entry_1 was submission 99's")
        XCTAssertEqual(bubbles("Hi", in: model), 2)
        _ = await model.apply(event(seq: 6, .entry(user("entry_2", "Hi", submissionId: "17"))))
        XCTAssertEqual(model.outgoing, [])
        XCTAssertEqual(bubbles("Hi", in: model), 2)
    }

    func testAMessageTheMacIsStillTakingKeepsItsKey() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.failNextSend(with: try serverError(status: 409, code: "idempotency_in_flight"))
        _ = await model.send("Plan my week.")
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sending, "not Couldn't send")
        transport.queueSession(.success(try session(.idle, seq: 5)))
        await model.load()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1])
    }

    func testAStopPressedBeforeAnyActivityClearsOnTheNewRunsFirstActivity() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.running))
        transport.holdStop = true
        transport.queueStop(.success(try AidenBotSessionStateView(state: .running)))
        let stopping = Task { await model.stop() }
        try await waitUntil({ transport.isHoldingStop }, what: "the Stop request")
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Stopping")
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "searching", startedAt: started))))
        XCTAssertFalse(model.isStopping)
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Searching the web")
        transport.releaseStop()
        await stopping.value
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Searching the web")
    }

    // MARK: Fix round 3

    func testOutOfTriesAMessageEchoedByAnotherSubmissionSaysCouldntSendAndStays() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle), retryDelays: [.milliseconds(20)])
        for _ in 0..<AidenBotSessionModel.maxConnectionAttempts {
            transport.failNextSend(with: try serverError(status: 500, code: "internal_error"))
        }
        transport.holdSend = true
        let sending = Task { await model.send("Hi") }
        try await waitUntil({ transport.isHoldingSend }, what: "the first try")
        // Another submission's Hi lands while this one is unsettled.
        _ = await model.apply(event(seq: 5, .entry(user("entry_1", "Hi", submissionId: "99"))))
        XCTAssertEqual(bubbles("Hi", in: model), 1)
        transport.holdSend = false
        _ = await sending.value
        try await waitUntil({ model.outgoing.first.map { model.look(of: $0) } == .failed }, what: "the last try")
        XCTAssertEqual(bubbles("Hi", in: model), 2, "the bubble says Couldn't send instead of vanishing")

        // The same tagged entry again doesn't settle it.
        _ = await model.apply(event(seq: 6, .entry(user("entry_1", "Hi", submissionId: "99"))))
        _ = await model.apply(event(seq: 7, .partial("Typing")))
        XCTAssertEqual(model.outgoing.map { model.look(of: $0) }, [.failed])
        let retried = await model.retrySend(try XCTUnwrap(model.outgoing.first).id)
        XCTAssertTrue(retried)
        XCTAssertEqual(Set(transport.sendKeys).count, 1, "Try again keeps the key: the Mac may hold it")
    }

    func testTwentyOfTheLargestMessagesAllSurviveOnDisk() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let model = model(transport, key: key, store: store)
        let largest = String(repeating: "😀", count: AidenBotSessionWire.maxMessageLength)
        for index in 0..<AidenBotOutboxStore.maxMessages {
            let taken = await model.send("\(index)" + largest.dropFirst(String(index).count))
            XCTAssertTrue(taken, "message \(index)")
        }
        try await stored(store, key, count: AidenBotOutboxStore.maxMessages)
        let restored = await store.load(key)
        XCTAssertEqual(restored.map(\.text), model.outgoing.map(\.text), "none dropped for size")
        let refused = await model.send("One more")
        XCTAssertFalse(refused)
        XCTAssertEqual(model.errorMessage, "Too many messages are waiting. Send or remove some, then try again.")
    }

    func testLeavingDuringTheFirstLoadSpendsNoTry() async throws {
        let transport = FakeBotSessionTransport()
        let model = model(transport)
        _ = await model.send("Plan my week.")
        transport.holdSend = true
        transport.queueSession(.success(try session(.idle)))
        let loading = Task { await model.load() }
        try await waitUntil({ transport.isHoldingSend }, what: "the first try")
        loading.cancel() // the chat is dismissed
        await loading.value
        transport.holdSend = false
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sending)

        // All of its tries are still left.
        for seq in 5..<(5 + AidenBotSessionModel.maxConnectionAttempts - 1) {
            transport.failNextSend(with: URLError(.networkConnectionLost))
            transport.queueSession(.success(try session(.idle, seq: seq)))
            await model.load()
            XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sending, "try \(seq - 4)")
        }
        transport.queueSession(.success(try session(.idle, seq: 9)))
        await model.load()
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"))
        XCTAssertEqual(Set(transport.sendKeys).count, 1)
    }

    func testClosingTheChatCancelsTheRequestAFrameStarted() async throws {
        let transport = FakeBotSessionTransport()
        let model = model(transport)
        _ = await model.send("Plan my week.")
        transport.holdSend = true
        _ = await model.apply(event(seq: 4, .snapshot(try session(.idle))))
        try await waitUntil({ transport.isHoldingSend }, what: "the request the snapshot started")
        XCTAssertTrue(model.inFlight.contains(.send))
        model.release()
        try await waitUntil({ !model.inFlight.contains(.send) }, what: "the cancelled request")
        XCTAssertEqual(model.look(of: try XCTUnwrap(model.outgoing.first)), .sending, "it waits for the next visit")
        transport.holdSend = false
    }

    func testAMessageThatExpiresWhileItsEchoWaitsLeavesOneBubble() async throws {
        var clock = Date()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle)))
        let model = model(transport, supported: false, now: { clock })
        await model.load()
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await model.send("Hi")
        // An older Mac's entry with its text lands while it waits to retry.
        _ = await model.apply(event(seq: 5, .entry(user("entry_1", "Hi"))))
        XCTAssertEqual(bubbles("Hi", in: model), 1)
        clock = clock.addingTimeInterval(25 * 60 * 60)
        transport.queueSession(.success(try session(.idle, seq: 5, entries: [user("entry_1", "Hi")])))
        await model.load()
        _ = await model.apply(event(seq: 6, .partial("…")))
        XCTAssertEqual(bubbles("Hi", in: model), 1, "the entry still stands for it, not a second failed bubble")
        XCTAssertEqual(transport.sendKeys.count, 1, "nothing a day old goes out")
    }

    func testTheMacsAnswerToResumeStandsAfterAnUnrelatedFrame() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.interrupted))
        transport.holdResume = true
        transport.queueResume(.success(try AidenBotSessionStateView(state: .idle)))
        let resuming = Task { await model.resume() }
        try await waitUntil({ transport.isHoldingResume }, what: "the Resume request")
        _ = await model.apply(event(seq: 5, .entry(assistant("entry_1", "Still here."))))
        transport.releaseResume()
        await resuming.value
        XCTAssertEqual(model.state, .idle, "the Mac's answer replaces the optimistic state")
    }

    func testResumeFollowsTheMacsFirstWordAboutTheResumedRun() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.interrupted))
        transport.holdResume = true
        let resuming = Task { await model.resume() }
        try await waitUntil({ transport.isHoldingResume }, what: "the Resume request")
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Picking up where it left off")
        _ = await model.apply(event(seq: 5, .activity(AidenBotSessionActivity(phase: "searching", startedAt: started))))
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Searching the web")
        transport.releaseResume()
        await resuming.value
        XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Searching the web")
    }

    func testAHungRequestBecomesARetryNotEndlessSending() async throws {
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.running, activity: AidenBotSessionActivity(phase: "reading", startedAt: started))))
        let model = model(transport, retryDelays: [.milliseconds(20)], requestLimit: .milliseconds(100))
        await model.load()
        transport.holdSend = true // the link is dead: no request ever answers
        let began = ContinuousClock.now
        _ = await model.send("Plan my week.")
        try await waitUntil({ model.outgoing.first.map { model.look(of: $0) } == .failed }, what: "the tries to run out")
        XCTAssertLessThan(ContinuousClock.now - began, .seconds(3))
        XCTAssertEqual(transport.sendKeys.count, AidenBotSessionModel.maxConnectionAttempts)
        XCTAssertEqual(Set(transport.sendKeys).count, 1, "a hung request may have arrived: the key is kept")

        // Stop is bounded too, and keeps its key for the next tap.
        transport.holdStop = true
        await model.stop()
        XCTAssertFalse(model.isStopping, "a Stop that never answers goes back")
        XCTAssertNotNil(model.errorMessage)
        await model.stop()
        XCTAssertEqual(transport.stopKeys.count, 2)
        XCTAssertEqual(transport.stopKeys[0], transport.stopKeys[1])
        transport.holdSend = false
        transport.holdStop = false
    }

    func testAnUnpairedChatIsNeverWrittenAgainAndAQueuedRemovalAlwaysRuns() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, _) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let open = model(transport, key: key, store: store)
        _ = await open.send("First")
        try await stored(store, key, count: 1)

        await store.purge(instanceId: "mac_a")
        _ = await open.send("Second") // a chat still on screen after the unpair
        try await Task.sleep(for: .milliseconds(200))
        let afterUnpair = await store.load(key)
        XCTAssertEqual(afterUnpair, [], "a late write never brings the file back")

        // A removal handed to the store runs even after the chat that asked for it is gone.
        let other = AidenBotSessionKey(instanceId: "mac_b", deviceId: "device_1", botID: botID)
        var closing: AidenBotSessionModel? = model(transport, key: other, store: store)
        transport.queueSession(.success(try session(.idle)))
        await closing?.load()
        transport.failNextSend(with: URLError(.networkConnectionLost))
        _ = await closing?.send("Plan my week.")
        try await stored(store, other, count: 1)
        transport.failNextSend(with: try serverError(status: 403, code: "capability_denied"))
        transport.queueSession(.success(try session(.idle, seq: 5)))
        await closing?.load()
        closing = nil
        try await stored(store, other, count: 0)
    }

    func testAMessageCutOffByLeavingAndThenRefusedForAStateReasonKeepsItsKey() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.holdSend = true
        let sending = Task { await model.send("Plan my week.") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        sending.cancel() // leaving the chat cuts the request off; it may have arrived
        _ = await sending.value
        transport.holdSend = false

        // On the next connection the Bot needs a model: the message says it couldn't be sent.
        _ = await model.apply(event(seq: 5, .snapshot(try session(.needsModel, seq: 5))))
        try await waitUntil({ model.outgoing.first.map { model.look(of: $0) } == .failed }, what: "the failure")
        _ = await model.apply(event(seq: 6, .state(try AidenBotSessionStateView(state: .idle))))
        let retried = await model.retrySend(try XCTUnwrap(model.outgoing.first).id)
        XCTAssertTrue(retried)
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "Try again replays the key the cut-off request used")
    }

    func testARefusedMessageRetriesOnANewKeyOnceTheBotIsFixed() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.failNextSend(with: URLError(.timedOut))
        _ = await model.send("Plan my week.")
        // Meanwhile the Bot was paused: the Mac refuses the replay before running it.
        transport.failNextSend(with: try serverError(status: 409, code: "operation_stale"))
        transport.queueSession(.success(try session(.idle, seq: 5)))
        await model.load()
        let refused = try XCTUnwrap(model.outgoing.first)
        XCTAssertEqual(model.look(of: refused), .failed)
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "the timed-out try was replayed under its key")
        // The Mac's ledger now answers that key with an error, whatever the Bot's state.
        transport.answerKey(transport.sendKeys[0], with: try serverError(status: 500, code: "internal_error"))

        // The person fixes the Bot and taps Try again.
        _ = await model.apply(event(seq: 6, .state(try AidenBotSessionStateView(state: .idle))))
        let retried = await model.retrySend(refused.id)
        XCTAssertTrue(retried)
        XCTAssertEqual(transport.sendKeys.count, 3)
        XCTAssertNotEqual(transport.sendKeys[2], transport.sendKeys[0], "Try again is a new request")
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"), "and it goes through")
    }

    func testAGateReleasedBeforeItsRequestKeepsTheRelease() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle))
        transport.holdSend = true
        transport.releaseSend() // before the request arrives
        let taken = await model.send("Hi")
        XCTAssertTrue(taken)
        XCTAssertEqual(model.outgoing.first?.status, .sent(submissionId: "17"), "the early release was not lost")
        transport.holdSend = false
    }

    // MARK: Fix round 4

    /// The records of the one chat file under `root`, as stored.
    private func diskRecords(_ root: URL) throws -> [[String: Any]] {
        let files = (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? [])
            .filter { $0.pathExtension == "json" }
        guard let file = files.first,
              let envelope = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else { return [] }
        return envelope["messages"] as? [[String: Any]] ?? []
    }

    private func waitForDisk(_ root: URL, what: String, _ condition: ([[String: Any]]) -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition((try? diskRecords(root)) ?? []) {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(what) on disk") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    /// Runs one message out of tries while another submission's same-text entry lands mid-flight.
    private func failBesideAnotherSubmission(_ model: AidenBotSessionModel, _ transport: FakeBotSessionTransport) async throws {
        for _ in 0..<AidenBotSessionModel.maxConnectionAttempts {
            transport.failNextSend(with: try serverError(status: 500, code: "internal_error"))
        }
        transport.holdSend = true
        let sending = Task { await model.send("Hi") }
        try await waitUntil({ transport.isHoldingSend }, what: "the first try")
        _ = await model.apply(event(seq: 5, .entry(user("entry_1", "Hi", submissionId: "99"))))
        transport.holdSend = false
        _ = await sending.value
        try await waitUntil({ model.outgoing.first.map { model.look(of: $0) } == .failed }, what: "the last try")
    }

    func testAFailedMessageIsNeverSettledByAnEntryNamingAnotherSubmission() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loaded(transport, try session(.idle), retryDelays: [.milliseconds(20)])
        try await failBesideAnotherSubmission(model, transport)

        // Yet another device sends the same words; its entry names its own submission.
        _ = await model.apply(event(seq: 6, .entry(user("entry_2", "Hi", submissionId: "100"))))
        XCTAssertEqual(model.outgoing.map { model.look(of: $0) }, [.failed], "it still says Couldn't send")
        XCTAssertEqual(bubbles("Hi", in: model), 3)

        // An older Mac's untagged entry may still be this message: the Mac may hold it.
        _ = await model.apply(event(seq: 7, .entry(user("entry_3", "Hi"))))
        XCTAssertEqual(model.outgoing, [], "an entry without a submission stands for it")
    }

    func testAFailedMessageStaysItsOwnAfterARelaunchBesideAnotherSubmission() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle)))
        let first = model(transport, key: key, store: store, retryDelays: [.milliseconds(20)])
        await first.load()
        try await failBesideAnotherSubmission(first, transport)
        try await waitForDisk(root, what: "the failure") { $0.first?["failed"] as? Bool == true }
        first.release()

        let relaunched = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
        transport.queueSession(.success(try session(.idle, seq: 9, entries: [user("entry_1", "Hi", submissionId: "99")])))
        await relaunched.load()
        XCTAssertEqual(relaunched.outgoing.map { relaunched.look(of: $0) }, [.failed], "the other submission's entry doesn't settle it")

        // Try again: while it is on its way, the other submission's entry still isn't it.
        transport.holdSend = true
        let retrying = Task { await relaunched.retrySend(try XCTUnwrap(relaunched.outgoing.first).id) }
        try await waitUntil({ transport.isHoldingSend }, what: "Try again")
        _ = await relaunched.apply(event(seq: 10, .entry(user("entry_1", "Hi", submissionId: "99"))))
        XCTAssertEqual(bubbles("Hi", in: relaunched), 2, "the other device's Hi and this one, still sending")
        transport.holdSend = false
        _ = try await retrying.value
        XCTAssertEqual(Set(transport.sendKeys).count, 1, "Try again replays the key")
    }

    func testARequestCutOffByLeavingIsReplayedAfterARelaunchAndARefusalRetriesOnANewKey() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle)))
        let first = model(transport, key: key, store: store)
        await first.load()
        transport.holdSend = true
        let sending = Task { await first.send("Plan my week.") }
        try await waitUntil({ transport.isHoldingSend }, what: "the request")
        sending.cancel() // leaving the chat cuts the request off; it may have arrived
        _ = await sending.value
        transport.holdSend = false
        try await waitForDisk(root, what: "the request") { $0.first?["request"] is [String: Any] }
        first.release()

        let relaunched = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
        transport.failNextSend(with: try serverError(status: 400, code: "invalid_request"))
        transport.queueSession(.success(try session(.idle, seq: 9)))
        await relaunched.load()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "the next launch replays the key the cut-off request used")
        let refused = try XCTUnwrap(relaunched.outgoing.first)
        XCTAssertEqual(relaunched.look(of: refused), .failed)
        _ = await relaunched.retrySend(refused.id)
        XCTAssertEqual(transport.sendKeys.count, 3)
        XCTAssertNotEqual(transport.sendKeys[2], transport.sendKeys[1], "a refusal is definite: Try again is a new request")
        XCTAssertEqual(relaunched.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testARequestThatTimedOutIsReplayedAfterARelaunchAndARefusalRetriesOnANewKey() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        transport.queueSession(.success(try session(.idle)))
        let first = model(transport, key: key, store: store)
        await first.load()
        transport.failNextSend(with: URLError(.timedOut))
        _ = await first.send("Plan my week.")
        try await waitForDisk(root, what: "the timed-out try") { $0.first?["connectionAttempts"] as? Int == 1 }
        first.release()

        let relaunched = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
        transport.failNextSend(with: try serverError(status: 400, code: "invalid_request"))
        transport.queueSession(.success(try session(.idle, seq: 9)))
        await relaunched.load()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "the next launch replays the key the timed-out request used")
        let refused = try XCTUnwrap(relaunched.outgoing.first)
        XCTAssertEqual(relaunched.look(of: refused), .failed)
        _ = await relaunched.retrySend(refused.id)
        XCTAssertEqual(transport.sendKeys.count, 3)
        XCTAssertNotEqual(transport.sendKeys[2], transport.sendKeys[1], "a refusal is definite: Try again is a new request")
        XCTAssertEqual(relaunched.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testARequestCutOffByClosingTheChatIsReplayedOnTheNextVisitAndARefusalRetriesOnANewKey() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let cache = AidenBotSessionCache()
        let transport = FakeBotSessionTransport()
        let first = model(transport, key: key, cache: cache)
        _ = await first.send("Plan my week.")
        transport.holdSend = true
        _ = await first.apply(event(seq: 4, .snapshot(try session(.idle))))
        try await waitUntil({ transport.isHoldingSend }, what: "the request the snapshot started")
        first.release()
        try await waitUntil({ !first.inFlight.contains(.send) }, what: "the cancelled request")
        transport.holdSend = false

        let second = model(transport, key: key, cache: cache)
        transport.failNextSend(with: try serverError(status: 400, code: "invalid_request"))
        transport.queueSession(.success(try session(.idle, seq: 9)))
        await second.load()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "the next visit replays the key the cut-off request used")
        let refused = try XCTUnwrap(second.outgoing.first)
        XCTAssertEqual(second.look(of: refused), .failed)
        _ = await second.retrySend(refused.id)
        XCTAssertEqual(transport.sendKeys.count, 3)
        XCTAssertNotEqual(transport.sendKeys[2], transport.sendKeys[1], "a refusal is definite: Try again is a new request")
        XCTAssertEqual(second.outgoing.first?.status, .sent(submissionId: "17"))
    }

    func testACancelledCallerNeverLeavesItsRequestRunning() async throws {
        // An already-cancelled caller never starts the request.
        let untouched = LiveRequests()
        let early = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await aidenBotWithin(.seconds(30)) { await untouched.run() }
        }
        _ = try? await early.value
        let live = LiveRequests()
        // A caller cancelled while it starts never leaves the request behind.
        for round in 0..<400 {
            let caller = Task { try await aidenBotWithin(.seconds(30)) { await live.run() } }
            if round.isMultiple(of: 2) {
                Task.detached { caller.cancel() }
            } else {
                caller.cancel()
            }
            _ = try? await caller.value
        }
        let deadline = Date().addingTimeInterval(2)
        while await live.running > 0, Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        let running = await live.running
        XCTAssertEqual(running, 0, "every request a cancelled caller started was cancelled with it")
        try await Task.sleep(for: .milliseconds(50))
        let neverStarted = await untouched.started
        XCTAssertEqual(neverStarted, 0, "an already-cancelled caller never starts the request")
    }

    func testAnUnpairStopsAPairingWhoseOnlyWriteIsStillWaiting() async throws {
        let (store, _) = temporaryStore()
        let transport = FakeBotSessionTransport()
        var keys: [AidenBotSessionKey] = []
        for index in 0..<40 {
            let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_\(index)", botID: botID)
            keys.append(key)
            let open = model(transport, key: key, store: store)
            _ = await open.send("First") // handed to the store, maybe not made yet
            await store.purge(instanceId: "mac_a")
            _ = await open.send("Second") // the chat is still on screen after the unpair
        }
        try await Task.sleep(for: .milliseconds(300))
        for key in keys {
            let left = await store.load(key)
            XCTAssertEqual(left, [], "\(key.deviceId): a late write never brings the file back")
        }
    }

    func testAnOutboxFileThatCantBeReadIsSetAsideAndTheChatSaysSo() async throws {
        let transport = FakeBotSessionTransport()
        let damages: [(String, (Data) throws -> Data)] = [
            ("garbage", { _ in Data("not an outbox".utf8) }),
            ("a newer version", { original in
                var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
                envelope["version"] = 2
                return try JSONSerialization.data(withJSONObject: envelope)
            }),
            ("oversized", { _ in Data(repeating: 0x20, count: 2 * AidenBotOutboxStore.maxBytes + 1) }),
        ]
        for (name, damage) in damages {
            let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
            let (store, root) = temporaryStore()
            let writer = model(transport, key: key, store: store)
            _ = await writer.send("Plan my week.")
            try await stored(store, key, count: 1)
            writer.release()
            let files = { (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? [])
                .filter { !$0.hasDirectoryPath } }
            let file = try XCTUnwrap(files().first, name)
            let damaged = try damage(Data(contentsOf: file))
            try damaged.write(to: file)

            let reader = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
            await reader.load()
            XCTAssertEqual(reader.restoreNotice, AidenBotSessionCopy.outboxUnrestorable, name)
            XCTAssertEqual(reader.outgoing, [], name)
            let aside = files().filter { $0.pathExtension != "json" }
            XCTAssertEqual(aside.count, 1, "\(name): set aside, never deleted")
            XCTAssertEqual(try aside.first.map { try Data(contentsOf: $0) }, damaged, "\(name): kept as it was")

            // The chat writes its own outbox afresh beside it.
            _ = await reader.send("Again")
            try await stored(store, key, count: 1)
            XCTAssertEqual(files().filter { $0.pathExtension != "json" }.count, 1, name)
        }
    }

    func testAnOutboxFileThatCantBeOpenedIsSetAsideAndNeverOverwritten() async throws {
        let key = AidenBotSessionKey(instanceId: "mac_a", deviceId: "device_1", botID: botID)
        let (store, root) = temporaryStore()
        let transport = FakeBotSessionTransport()
        let writer = model(transport, key: key, store: store)
        _ = await writer.send("Plan my week.")
        try await stored(store, key, count: 1)
        writer.release()
        let files = { (FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL } ?? [])
            .filter { !$0.hasDirectoryPath } }
        let file = try XCTUnwrap(files().first)
        let size = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
        defer {
            for unreadable in files() { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: unreadable.path) }
        }

        let reader = model(transport, key: key, cache: AidenBotSessionCache(), store: store)
        await reader.load()
        XCTAssertEqual(reader.restoreNotice, AidenBotSessionCopy.outboxUnrestorable)
        XCTAssertEqual(reader.outgoing, [])
        let aside = try XCTUnwrap(files().first { $0.pathExtension != "json" }, "set aside, never deleted")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: aside.path)[.size] as? Int, size)

        // The chat's next write starts a new file; the one it couldn't read is left as it was.
        _ = await reader.send("Again")
        try await stored(store, key, count: 1)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: aside.path)[.size] as? Int, size)
        XCTAssertEqual(files().filter { $0.pathExtension != "json" }.count, 1)
    }

    func testAHungSessionRequestGivesUpInTime() async throws {
        let transport = FakeBotSessionTransport()
        transport.sessionGate.hold()
        transport.queueSession(.success(try session(.idle)))
        let model = model(transport, requestLimit: .milliseconds(200))
        let began = Date()
        await model.load()
        XCTAssertLessThan(Date().timeIntervalSince(began), 3, "the chat doesn't wait on URLSession's timeout")
        XCTAssertFalse(model.hasLoaded)
        XCTAssertNotNil(model.errorMessage)
        transport.sessionGate.releaseAll()
    }
}

/// A working Bot's face follows the shared `glance` keyframes (docs/activity-marks.md).
final class AidenBotFaceGlanceTests: XCTestCase {
    /// R19: a working Bot always keeps a visible cue, and only a face that may move glances.
    func testAWorkingBotAlwaysShowsACueAndOnlyAMovingFaceGlances() {
        XCTAssertEqual(aidenBotWorkingCue(working: true, hasPhoto: false, motionAllowed: true), AidenBotWorkingCue(glances: true, badge: false))
        XCTAssertEqual(
            aidenBotWorkingCue(working: true, hasPhoto: false, motionAllowed: false),
            AidenBotWorkingCue(glances: false, badge: true),
            "under Reduce Motion or Low Power a face wears the still badge"
        )
        XCTAssertEqual(aidenBotWorkingCue(working: true, hasPhoto: true, motionAllowed: true), AidenBotWorkingCue(glances: false, badge: true))
        XCTAssertEqual(aidenBotWorkingCue(working: true, hasPhoto: true, motionAllowed: false), AidenBotWorkingCue(glances: false, badge: true))
        XCTAssertEqual(aidenBotWorkingCue(working: false, hasPhoto: false, motionAllowed: true), .none)
        XCTAssertEqual(aidenBotWorkingCue(working: false, hasPhoto: true, motionAllowed: false), .none)
    }

    func testTheEyesLookLeftThenRightAndBlinkOnTheGlanceTimeline() {
        XCTAssertEqual(aidenBotFaceGlancePose(at: 0), .still, "t = 0 is the still pose Reduce Motion shows")
        // 1.28 s is 32% of the 4 s period: held at translateX −2.6 of 24.
        XCTAssertEqual(aidenBotFaceGlancePose(at: 1.28).dx, -2.6 / 24, accuracy: 0.0005)
        // 2.4 s is 60%: held at +2.6.
        XCTAssertEqual(aidenBotFaceGlancePose(at: 2.4).dx, 2.6 / 24, accuracy: 0.0005)
        // 3.6 s is 90%: the blink's lowest point.
        XCTAssertEqual(aidenBotFaceGlancePose(at: 3.6).blink, 0.1, accuracy: 0.0005)
        XCTAssertEqual(aidenBotFaceGlancePose(at: 4).dx, 0, accuracy: 0.0005, "the timeline loops")
    }
}

/// The chat's quiet connection hint (R14): it never blocks the chat, and it
/// stays out of the way while the status line already says "Reconnecting".
@MainActor
final class AidenBotConnectionHintTests: XCTestCase {
    private let botID = "bot_fixture_01"
    private let started = 1_760_450_000_000

    private func session(_ state: AidenBotSessionStateKind, epoch: String = "epoch_a", seq: Int = 4) throws -> AidenBotSession {
        AidenBotSession(
            botId: botID,
            epoch: epoch,
            seq: seq,
            stateView: try AidenBotSessionStateView(state: state),
            partial: nil,
            entries: [],
            hasOlder: false,
            activity: state == .running ? AidenBotSessionActivity(phase: "reading", startedAt: started) : nil,
            queued: []
        )
    }

    private func waitUntil(_ condition: () -> Bool, what: String) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { return XCTFail("Timed out waiting for \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    func testAChatSaysConnectingUntilTheMacAnswersAndAFailedFirstLoadOffersTryAgain() async throws {
        let transport = FakeBotSessionTransport()
        let model = AidenBotSessionModel(botID: botID, transport: transport)
        XCTAssertEqual(aidenBotConnectionHint(for: model, nowMs: started), .connecting, "before the first snapshot")

        await model.load() // nothing queued: the Mac can't be reached
        guard case .unreachable = aidenBotConnectionHint(for: model, nowMs: started) else {
            return XCTFail("a failed first load is a quiet hint with Try again, not a blocking screen")
        }

        transport.queueSession(.success(try session(.idle)))
        await model.load()
        XCTAssertNil(aidenBotConnectionHint(for: model, nowMs: started), "connected: no hint")
    }

    func testADroppedStreamSaysConnectingOnlyWhenTheStatusLineDoesNotAlreadySayReconnecting() async throws {
        for (state, expected) in [(AidenBotSessionStateKind.running, nil), (.idle, AidenBotConnectionHint.connecting)] {
            let transport = FakeBotSessionTransport()
            transport.queueSession(.success(try session(state)))
            transport.queueStream([]) // the first connection drops at once
            transport.queueStream([], staysOpen: true)
            let model = AidenBotSessionModel(botID: botID, transport: transport)
            model.activitySupported = true
            await model.load()
            let listener = Task { await model.listen() }
            try await waitUntil({ model.isStreamDown }, what: "the drop")
            XCTAssertEqual(aidenBotConnectionHint(for: model, nowMs: started), expected, "\(state)")
            if state == .running {
                XCTAssertEqual(model.statusLine(nowMs: started)?.display.word, "Reconnecting to your Mac")
            }
            listener.cancel()
            await listener.value
        }
    }
}

@MainActor
final class AidenBotChatActivityTests: XCTestCase {
    private struct SaveFailure: Error {}

    private func detail(revision: String, _ activity: AidenBotChatActivity?) throws -> AidenBotDetail {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let shared = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var object = try XCTUnwrap(shared["botDetail"] as? [String: Any])
        object["revision"] = revision
        if let activity { object["chatActivity"] = ["level": activity.level.rawValue, "wording": activity.wording.rawValue] }
        return try AidenRemoteJSONDecoder.decode(AidenBotDetail.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func conflict() throws -> Error {
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"revision_conflict","message":"changed","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        return AidenRemoteClientError.server(statusCode: 409, body: body)
    }

    /// Waits, at most 5 seconds, for a save to reach its hold.
    private func untilSaving(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("Timed out waiting for the save to start")
                throw SaveFailure()
            }
            try await Task.sleep(for: .milliseconds(5))
        }
    }

    /// Where a scripted save waits until the test lets it go, at most 5 seconds,
    /// so a test that fails before letting it go never leaves a save hanging.
    @MainActor
    private final class Hold {
        private(set) var isHeld = false
        private var isReleased = false

        func wait() async throws {
            isHeld = true
            let deadline = Date().addingTimeInterval(5)
            while !isReleased {
                guard Date() < deadline else {
                    XCTFail("Timed out waiting for the test to let the save go")
                    throw SaveFailure()
                }
                try await Task.sleep(for: .milliseconds(5))
            }
        }

        func release() { isReleased = true }
    }

    /// A model whose Mac accepts every save, with the calls it saw.
    private func model(
        revision: String = "rev_1",
        _ activity: AidenBotChatActivity? = nil,
        save: @escaping @MainActor (AidenBotChatActivity, String) async throws -> AidenBotDetail,
        refresh: @escaping @MainActor () async throws -> AidenBotDetail = { throw SaveFailure() },
        onSaved: @escaping @MainActor (AidenBotDetail) -> Void = { _ in },
        waitForConnection: (@MainActor (Duration) async -> Bool)? = nil,
        isCurrent: @escaping @MainActor () -> Bool = { true },
        connectionHold: Duration = .seconds(8),
        requestLimit: Duration = .seconds(12)
    ) throws -> AidenBotChatActivityModel {
        AidenBotChatActivityModel(
            bot: try detail(revision: revision, activity), save: save, refresh: refresh, onSaved: onSaved,
            waitForConnection: waitForConnection, isCurrent: isCurrent,
            connectionHold: connectionHold, requestLimit: requestLimit
        )
    }

    func testAPickWaitingForTheMacIsNeverSentToAnotherPairingThatConnects() async throws {
        var paired = true
        var saves = 0
        var saved: [AidenBotDetail] = []
        let model = try model(save: { next, _ in
            saves += 1
            return try self.detail(revision: "rev_2", next)
        }, onSaved: { saved.append($0) }, waitForConnection: { _ in
            // The person switches Macs during the hold; the new pairing comes up connected.
            paired = false
            return true
        }, isCurrent: { paired })

        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(saves, 0, "nothing reaches the Mac that replaced the one this pick was for")
        XCTAssertEqual(saved.count, 0)
        XCTAssertEqual(model.value, .standard, "the pick goes back")
        XCTAssertNil(model.errorMessage, "silently: that Bot is no longer on screen")
        XCTAssertFalse(model.isSaving)
    }

    func testASaveThatReturnsAfterThePairingChangedIsNeitherKeptNorReported() async throws {
        var paired = true
        let hold = Hold()
        var saved: [AidenBotDetail] = []
        var refreshes = 0
        let model = try model(save: { next, _ in
            try await hold.wait()
            return try self.detail(revision: "rev_2", next)
        }, refresh: {
            refreshes += 1
            return try self.detail(revision: "rev_3", .standard)
        }, onSaved: { saved.append($0) }, isCurrent: { paired })

        let pick = Task { await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows)) }
        try await untilSaving { hold.isHeld }
        paired = false
        hold.release()
        await pick.value

        XCTAssertEqual(saved.count, 0, "the old Mac's Bot is never cached or reported under the new pairing")
        XCTAssertEqual(refreshes, 0, "nothing more is asked of either Mac")
        XCTAssertEqual(model.value, .standard)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isSaving)
    }

    func testAPickSavesAtOnceWithTheBotsRevisionAndTheNextPickUsesTheNewOne() async throws {
        var calls: [(AidenBotChatActivity, String)] = []
        var saved: [AidenBotDetail] = []
        let model = try model(save: { next, revision in
            calls.append((next, revision))
            return try self.detail(revision: revision == "rev_1" ? "rev_2" : "rev_3", next)
        }, onSaved: { saved.append($0) })
        XCTAssertEqual(model.value, .standard, "a Bot that never chose reads as Quiet, Follows the work")

        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        await model.pick(AidenBotChatActivity(level: .summary, wording: .thinking))
        XCTAssertEqual(calls.map(\.1), ["rev_1", "rev_2"])
        XCTAssertEqual(model.value, AidenBotChatActivity(level: .summary, wording: .thinking))
        XCTAssertEqual(saved.map(\.revision), ["rev_2", "rev_3"])

        await model.pick(AidenBotChatActivity(level: .summary, wording: .thinking))
        XCTAssertEqual(calls.count, 2, "picking the current choice sends nothing")
    }

    func testAFailedSaveReturnsToTheSavedChoiceAndSaysSo() async throws {
        var revisions: [String] = []
        var fail = true
        let model = try model(AidenBotChatActivity(level: .quiet, wording: .follows), save: { next, revision in
            revisions.append(revision)
            if fail { throw SaveFailure() }
            return try self.detail(revision: "rev_2", next)
        })
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(model.value, AidenBotChatActivity(level: .quiet, wording: .follows))
        XCTAssertEqual(model.errorMessage, "Aiden couldn’t save that choice.")
        XCTAssertFalse(model.isSaving)

        fail = false
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(revisions, ["rev_1", "rev_1"], "a failed save leaves the revision where it was")
        XCTAssertEqual(model.value.level, .detailed)
    }

    func testAConflictRefreshesTheBotAndTheNextPickCarriesTheRefreshedRevision() async throws {
        var revisions: [String] = []
        var adopted: [AidenBotDetail] = []
        var conflicts = true
        let macsChoice = AidenBotChatActivity(level: .summary, wording: .thinking)
        let model = try model(save: { next, revision in
            revisions.append(revision)
            if conflicts { conflicts = false; throw try self.conflict() }
            return try self.detail(revision: "rev_6", next)
        }, refresh: { try self.detail(revision: "rev_5", macsChoice) }, onSaved: { adopted.append($0) })

        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(model.value, macsChoice, "the radio shows what the Mac has now")
        XCTAssertEqual(model.saveFailure, .conflict)
        XCTAssertEqual(model.errorMessage, "This changed on your Mac. Showing what it has now.")
        XCTAssertEqual(adopted.map(\.revision), ["rev_5"], "the screens behind hear about the Mac's version")
        XCTAssertFalse(model.isSaving)

        await model.pick(AidenBotChatActivity(level: .detailed, wording: .thinking))
        XCTAssertEqual(revisions, ["rev_1", "rev_5"])
        XCTAssertEqual(model.value.level, .detailed)
    }

    func testAConflictWhoseRefreshFailsStillRollsBack() async throws {
        let model = try model(AidenBotChatActivity(level: .quiet, wording: .follows), save: { _, _ in throw try self.conflict() })
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(model.value.level, .quiet)
        XCTAssertEqual(model.saveFailure, .conflict)
    }

    func testAPickShowsAtOnceAndASecondTapWhileSavingIsNeitherLostNorSentOnAStaleRevision() async throws {
        var calls: [(AidenBotChatActivity, String)] = []
        let hold = Hold()
        let model = try model(save: { next, revision in
            calls.append((next, revision))
            if calls.count == 1 { try await hold.wait() }
            return try self.detail(revision: "rev_\(calls.count + 1)", next)
        })

        let first = Task { await model.pick(AidenBotChatActivity(level: .summary, wording: .follows)) }
        try await untilSaving { hold.isHeld }
        XCTAssertEqual(model.value.level, .summary, "the choice shows before the Mac answers")
        XCTAssertTrue(model.isSaving)

        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(model.value.level, .detailed, "a tap during a save shows at once too")
        XCTAssertEqual(calls.count, 1, "it waits for the save in flight")

        hold.release()
        await first.value
        XCTAssertEqual(calls.map(\.1), ["rev_1", "rev_2"], "the follow-up carries the revision the first save returned")
        XCTAssertEqual(model.value.level, .detailed)
        XCTAssertFalse(model.isSaving)
        XCTAssertNil(model.errorMessage)
    }

    func testThreeTapsDuringOneSaveSendTheFirstAndTheLastOnly() async throws {
        var calls: [AidenBotChatActivity] = []
        let hold = Hold()
        let model = try model(save: { next, _ in
            calls.append(next)
            if calls.count == 1 { try await hold.wait() }
            return try self.detail(revision: "rev_\(calls.count + 1)", next)
        })
        let first = Task { await model.pick(AidenBotChatActivity(level: .summary, wording: .follows)) }
        try await untilSaving { hold.isHeld }
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .thinking))
        await model.pick(AidenBotChatActivity(level: .quiet, wording: .thinking))
        hold.release()
        await first.value
        XCTAssertEqual(calls, [
            AidenBotChatActivity(level: .summary, wording: .follows),
            AidenBotChatActivity(level: .quiet, wording: .thinking),
        ])
        XCTAssertEqual(model.value, AidenBotChatActivity(level: .quiet, wording: .thinking))
    }

    func testPickingBackToTheSavedChoiceMidFlightEndsOnThatChoiceOnTheMacToo() async throws {
        var calls: [AidenBotChatActivity] = []
        let hold = Hold()
        let original = AidenBotChatActivity(level: .quiet, wording: .follows)
        let model = try model(original, save: { next, _ in
            calls.append(next)
            if calls.count == 1 { try await hold.wait() }
            return try self.detail(revision: "rev_\(calls.count + 1)", next)
        })
        let first = Task { await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows)) }
        try await untilSaving { hold.isHeld }
        await model.pick(original)
        XCTAssertEqual(model.value, original, "the page already shows the choice they went back to")
        hold.release()
        await first.value
        XCTAssertEqual(calls.last, original, "the Mac ends on it too, not on the abandoned pick")
        XCTAssertEqual(model.value, original)
    }

    func testAFailedFollowUpReturnsToTheLastSavedChoice() async throws {
        var count = 0
        let model = try model(save: { next, _ in
            count += 1
            if count == 2 { throw SaveFailure() }
            return try self.detail(revision: "rev_2", next)
        })
        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        await model.pick(AidenBotChatActivity(level: .detailed, wording: .follows))
        XCTAssertEqual(model.value.level, .summary, "back to what the Mac last confirmed")
        XCTAssertEqual(model.errorMessage, "Aiden couldn’t save that choice.")
    }

    func testAPickMadeWhileConnectingGoesOutOnceTheMacIsReachable() async throws {
        var asked: [Duration] = []
        var calls = 0
        let model = try model(save: { next, _ in
            calls += 1
            return try self.detail(revision: "rev_2", next)
        }, waitForConnection: { hold in asked.append(hold); return true }, connectionHold: .seconds(8))
        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        XCTAssertEqual(asked, [.seconds(8)], "it holds the pick for about 8 seconds")
        XCTAssertEqual(calls, 1)
        XCTAssertNil(model.errorMessage)
    }

    func testAPickThatNeverGetsAConnectionRollsBackWithoutSending() async throws {
        var calls = 0
        let model = try model(save: { next, _ in
            calls += 1
            return try self.detail(revision: "rev_2", next)
        }, waitForConnection: { _ in false })
        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(model.value, .standard)
        XCTAssertEqual(model.saveFailure, .offline)
        XCTAssertEqual(model.errorMessage, "Aiden couldn’t reach your Mac to save that choice.", "offline says so, not a generic failure")
    }

    func testARequestOnADeadLinkIsBoundedAndTheNextPickStillUsesTheSameRevision() async throws {
        var revisions: [String] = []
        var hang = true
        let model = try model(save: { next, revision in
            revisions.append(revision)
            if hang { try await Task.sleep(for: .seconds(60)) }
            return try self.detail(revision: "rev_2", next)
        }, requestLimit: .milliseconds(50))
        let started = ContinuousClock.now
        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(5), "it does not wait out the URLSession timeout")
        XCTAssertEqual(model.value, .standard)
        XCTAssertEqual(model.saveFailure, .offline)

        hang = false
        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        XCTAssertEqual(revisions, ["rev_1", "rev_1"])
        XCTAssertEqual(model.value.level, .summary)
    }

    func testPreviewsShowWhatEachLevelLooksLikeOnTheMac() {
        let reading = 1
        let searching = 2
        let reply = AidenBotChatActivityPreview.durations.count - 1
        for level in AidenBotChatActivityLevel.allCases {
            XCTAssertEqual(AidenBotChatActivityPreview.frame(index: reading, level: level).phase, "reading")
            XCTAssertNil(AidenBotChatActivityPreview.frame(index: reply, level: level).phase, "the reply has landed")
        }
        XCTAssertEqual(AidenBotChatActivityPreview.frame(index: reading, level: .quiet).steps, [])
        XCTAssertNil(AidenBotChatActivityPreview.frame(index: searching, level: .quiet).running)
        XCTAssertEqual(AidenBotChatActivityPreview.frame(index: searching, level: .summary).steps, [])
        // Detailed lists each finished step and the one in progress, which is the one the line names.
        for index in 1...3 {
            let frame = AidenBotChatActivityPreview.frame(index: index, level: .detailed)
            XCTAssertEqual(frame.steps.count, index - 1, "finished steps")
            XCTAssertNotNil(frame.running, "the step in progress shows as running")
        }
        XCTAssertNil(AidenBotChatActivityPreview.frame(index: 0, level: .detailed).running, "thinking has no step yet")
        XCTAssertNil(AidenBotChatActivityPreview.frame(index: reply, level: .detailed).running)

        XCTAssertNil(AidenBotChatActivityPreview.frame(index: reply, level: .quiet).recap)
        let summary = AidenBotChatActivityPreview.frame(index: reply, level: .summary)
        XCTAssertNotNil(summary.recap)
        XCTAssertFalse(summary.recapOpen)
        XCTAssertTrue(summary.steps.isEmpty)
        let detailed = AidenBotChatActivityPreview.frame(index: reply, level: .detailed)
        XCTAssertNotNil(detailed.recap)
        XCTAssertTrue(detailed.recapOpen)
        XCTAssertEqual(detailed.steps.count, 3)

        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 0), 0)
        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 1.5), 1)
        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 6.5), reply)
        XCTAssertEqual(AidenBotChatActivityPreview.frameIndex(elapsed: 8.8), 0, "the turn loops")
    }

    func testReduceMotionStillFramesShowWhatMakesEachLevelDifferent() {
        func still(_ level: AidenBotChatActivityLevel) -> AidenBotChatActivityPreview.Frame {
            AidenBotChatActivityPreview.frame(index: AidenBotChatActivityPreview.stillIndex(for: level), level: level)
        }
        XCTAssertNotNil(still(.quiet).phase, "Quiet holds the line mid-turn")
        XCTAssertNil(still(.quiet).recap)
        XCTAssertNil(still(.summary).phase, "Summary holds the reply")
        XCTAssertNotNil(still(.summary).recap, "with its recap above it, so it never looks like Quiet")
        XCTAssertNotNil(still(.detailed).phase)
        XCTAssertFalse(still(.detailed).steps.isEmpty && still(.detailed).running == nil, "Detailed shows its steps")
        XCTAssertNotEqual(still(.quiet), still(.summary))
        XCTAssertNotEqual(still(.quiet), still(.detailed))
        XCTAssertNotEqual(still(.summary), still(.detailed))
    }

    func testTheAdvancedRowSummarizesTheChoice() {
        XCTAssertEqual(AidenBotChatActivityCopy.summary(nil), "Quiet · Follows the work")
        XCTAssertEqual(AidenBotChatActivityCopy.summary(AidenBotChatActivity(level: .detailed, wording: .thinking)), "Detailed · Always “Thinking”")
    }

    func testAdvancedOffersChatActivityOnlyForAMacThatAnnouncesItAndAGrantedPhoneWithABot() {
        func server(features: [String], grants: [AidenRemoteCapability]) -> AidenServer {
            AidenServer(
                protocolVersion: 1, instanceId: "i", name: "Mac", appVersion: "1.0", capabilities: grants,
                serverCapabilities: grants, connectionMode: .lan, minimumClientVersion: nil,
                serverTime: Date(timeIntervalSince1970: 0), features: features
            )
        }
        let announced = [AidenServer.botActivityFeature]
        XCTAssertTrue(aidenBotShowsChatActivity(server: server(features: announced, grants: [.botActivity]), installation: nil, hasBaseline: true))
        XCTAssertFalse(aidenBotShowsChatActivity(server: server(features: [], grants: [.botActivity]), installation: nil, hasBaseline: true), "an older Mac")
        XCTAssertFalse(aidenBotShowsChatActivity(server: server(features: announced, grants: []), installation: nil, hasBaseline: true), "no grant")
        XCTAssertFalse(aidenBotShowsChatActivity(server: nil, installation: nil, hasBaseline: true), "no server read and nothing known")
        XCTAssertFalse(aidenBotShowsChatActivity(server: server(features: announced, grants: [.botActivity]), installation: nil, hasBaseline: false), "no Bot detail yet")
    }

    // MARK: Timeouts, offline copy and late saves

    func testASaveThatTimedOutButLandedShowsAsSavedWithNoError() async throws {
        var reported: [String] = []
        let picked = AidenBotChatActivity(level: .detailed, wording: .follows)
        let model = try model(save: { _, _ in
            try await Task.sleep(for: .seconds(60))
            throw SaveFailure()
        }, refresh: { try self.detail(revision: "rev_9", picked) }, onSaved: { reported.append($0.revision) }, requestLimit: .milliseconds(50))
        await model.pick(picked)
        XCTAssertEqual(model.value, picked, "the Mac took it after all: no rollback")
        XCTAssertNil(model.errorMessage)
        XCTAssertNil(model.saveFailure)
        XCTAssertEqual(reported, ["rev_9"], "the screens behind hear the Mac's version")
    }

    func testAPickMadeWhileASaveTimedOutGoesOutOnceTheRefreshShowsThatSaveLanded() async throws {
        var calls: [(AidenBotChatActivity, String)] = []
        let first = AidenBotChatActivity(level: .summary, wording: .follows)
        let second = AidenBotChatActivity(level: .detailed, wording: .thinking)
        let model = try model(save: { next, revision in
            calls.append((next, revision))
            if calls.count == 1 { try await Task.sleep(for: .seconds(60)) }
            return try self.detail(revision: "rev_3", next)
        }, refresh: { try self.detail(revision: "rev_2", first) }, requestLimit: .milliseconds(400))

        let pick = Task { await model.pick(first) }
        try await untilSaving { calls.count == 1 }
        await model.pick(second)
        await pick.value

        XCTAssertEqual(calls.map(\.0), [first, second], "the second pick is not lost when the first one landed")
        XCTAssertEqual(calls.map(\.1), ["rev_1", "rev_2"], "it goes out on the revision the refresh read")
        XCTAssertEqual(model.value, second)
        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isSaving)
    }

    func testASaveThatTimedOutAndDidNotLandRollsBackAndSaysTheMacWasUnreachable() async throws {
        let model = try model(AidenBotChatActivity(level: .quiet, wording: .follows), save: { _, _ in
            try await Task.sleep(for: .seconds(60))
            throw SaveFailure()
        }, refresh: { try self.detail(revision: "rev_2", AidenBotChatActivity(level: .quiet, wording: .follows)) }, requestLimit: .milliseconds(50))
        await model.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        XCTAssertEqual(model.value.level, .quiet)
        XCTAssertEqual(model.saveFailure, .offline)
        XCTAssertEqual(model.errorMessage, "Aiden couldn’t reach your Mac to save that choice.")

        // A refusal from the Mac is not "offline": it keeps the generic copy.
        let refused = try self.model(save: { _, _ in throw SaveFailure() })
        await refused.pick(AidenBotChatActivity(level: .summary, wording: .follows))
        XCTAssertEqual(refused.saveFailure, .generic)
        XCTAssertEqual(refused.errorMessage, "Aiden couldn’t save that choice.")
    }

    func testASaveThatLandsAfterAdvancedClosedStillReachesTheScreensBehind() throws {
        let report = AidenBotChatActivityReport()
        var behind: [String] = []
        let first = try detail(revision: "rev_2", AidenBotChatActivity(level: .summary, wording: .follows))
        let second = try detail(revision: "rev_3", AidenBotChatActivity(level: .detailed, wording: .follows))
        let late = try detail(revision: "rev_4", AidenBotChatActivity(level: .quiet, wording: .thinking))

        report.saved(first, reportBehind: { behind.append($0.revision) })
        report.saved(second, reportBehind: { behind.append($0.revision) })
        XCTAssertEqual(behind, [], "while Advanced is open it holds the newest")
        report.disappeared(.advanced, reportBehind: { behind.append($0.revision) })
        XCTAssertEqual(behind, ["rev_3"], "closing reports the newest once")
        report.saved(late, reportBehind: { behind.append($0.revision) })
        XCTAssertEqual(behind, ["rev_3", "rev_4"], "a pick confirmed after leaving still reports")

        // Advanced's own Save already reported the newest: closing reports nothing older.
        let own = AidenBotChatActivityReport()
        own.saved(first, reportBehind: { behind.append($0.revision) })
        own.reportedByAdvanced()
        own.disappeared(.advanced, reportBehind: { behind.append($0.revision) })
        XCTAssertEqual(behind, ["rev_3", "rev_4"])
    }

    func testAPickConfirmedAfterTheSheetClosedFromChatActivityStillReachesTheScreensBehind() throws {
        var behind: [String] = []
        let record: (AidenBotDetail) -> Void = { behind.append($0.revision) }
        let picked = try detail(revision: "rev_2", AidenBotChatActivity(level: .summary, wording: .follows))
        let late = try detail(revision: "rev_3", AidenBotChatActivity(level: .detailed, wording: .follows))

        // Chat activity is pushed over Advanced: still open, so the pick is held.
        let report = AidenBotChatActivityReport()
        report.appeared(.advanced)
        report.disappeared(.advanced, replacedBy: .chatActivity, reportBehind: record)
        report.appeared(.chatActivity)
        report.saved(picked, reportBehind: record)
        XCTAssertEqual(behind, [])

        // The sheet closes from Chat activity; Advanced never shows again.
        report.disappeared(.chatActivity, reportBehind: record)
        XCTAssertEqual(behind, ["rev_2"], "the held pick reaches the screens behind")
        report.saved(late, reportBehind: record)
        XCTAssertEqual(behind, ["rev_2", "rev_3"], "and one confirmed later goes straight behind")

        // Back from Chat activity to Advanced, then closing Advanced: reported once, at the end.
        let back = AidenBotChatActivityReport()
        behind = []
        back.disappeared(.advanced, replacedBy: .chatActivity, reportBehind: record)
        back.appeared(.chatActivity)
        back.appeared(.advanced)
        back.disappeared(.chatActivity, reportBehind: record)
        back.saved(picked, reportBehind: record)
        XCTAssertEqual(behind, [], "Advanced still shows")
        back.disappeared(.advanced, reportBehind: record)
        XCTAssertEqual(behind, ["rev_2"])
    }

    func testTheRunningStepReadsInTheMacsPhaseWords() {
        let running = (1...3).compactMap { AidenBotChatActivityPreview.frame(index: $0, level: .detailed).running }
        XCTAssertEqual(running, ["Reading", "Searching the web", "Editing files"])
    }
}

/// Counts the requests that started and those still running, for the request-race test.
private actor LiveRequests {
    private(set) var running = 0
    private(set) var started = 0

    /// A request that runs until it is cancelled.
    func run() async {
        started += 1
        running += 1
        try? await Task.sleep(for: .seconds(30))
        running -= 1
    }
}

/// The Bot chat's small rules (Task 6 review): the Steer/Queue pill's mode,
/// following the transcript's end, and the waiting bubbles' text contrast.
final class AidenBotChatPolishTests: XCTestCase {
    func testThePillStartsOnQueueKeepsItsChoiceWhileWorkingAndResetsWhenTheTurnEnds() {
        XCTAssertEqual(aidenBotBusyMode(nil, isRunning: false), .queue)
        XCTAssertEqual(aidenBotBusyMode(nil, isRunning: true), .queue, "a turn starts on Queue")
        XCTAssertEqual(aidenBotBusyMode(.steer, isRunning: true), .steer, "a choice holds while the Bot works")
        XCTAssertEqual(aidenBotBusyMode(.steer, isRunning: false), .queue, "and goes back to Queue when it ends")
    }

    func testNewRowsFollowOnlyAReaderAtTheEnd() {
        XCTAssertTrue(aidenBotFollowsTranscriptEnd(distanceFromEnd: 0))
        XCTAssertTrue(aidenBotFollowsTranscriptEnd(distanceFromEnd: -12), "an overscrolled end is the end")
        XCTAssertTrue(aidenBotFollowsTranscriptEnd(distanceFromEnd: 60), "near the end counts")
        XCTAssertFalse(aidenBotFollowsTranscriptEnd(distanceFromEnd: 600), "someone reading back stays put")
    }

    /// WCAG 2 relative luminance, computed here from the hex, as the oracle.
    private func contrast(_ a: String, _ b: String) -> Double {
        func channel(_ hex: String, _ shift: Int) -> Double {
            let value = Double((Int(hex.dropFirst(), radix: 16)! >> shift) & 0xFF) / 255
            return value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        func luminance(_ hex: String) -> Double {
            0.2126 * channel(hex, 16) + 0.7152 * channel(hex, 8) + 0.0722 * channel(hex, 0)
        }
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    func testWaitingBubblesKeepReadableTextInEveryThemeAndContrastSetting() {
        for preset in AidenThemePresetID.allCases {
            for scheme in [ColorScheme.light, .dark] {
                let base = AidenThemeCatalog.palette(preset: preset, scheme: scheme)
                // Settings' contrast slider runs 0–100 around a baseline of 45 (light) or 60 (dark).
                for setting in [0, 25, 50, 75, 100] {
                    let palette = base.applyingContrast(setting, baseline: scheme == .dark ? 60 : 45)
                    let text = aidenBotPendingTextHex(palette)
                    XCTAssertGreaterThanOrEqual(contrast(text, palette.raisedHex), 4.5, "\(preset) \(scheme) \(setting)")
                    XCTAssertNotEqual(text.uppercased(), palette.foregroundHex.uppercased(), "still reads as waiting, not as sent")
                }
            }
        }
    }
}

extension AidenBotOutboxStore {
    /// Test seam: what a chat would restore, without the unreadable flag.
    func load(_ key: AidenBotSessionKey) async -> [AidenBotOutgoingMessage] { await restore(key).messages }
}

/// Revision 33 in the session model: photos and files staged under the +.
@MainActor
final class AidenBotSessionAttachmentTests: XCTestCase {
    private let botID = "bot_fixture_attach"

    private final class Clock: @unchecked Sendable { var now = Date() }

    private func loaded(
        _ transport: FakeBotSessionTransport,
        supported: Bool = true,
        clock: Clock? = nil
    ) async throws -> AidenBotSessionModel {
        transport.queueSession(.success(AidenBotSession(
            botId: botID,
            epoch: "epoch_a",
            seq: 4,
            stateView: try AidenBotSessionStateView(state: .idle),
            partial: nil,
            entries: [],
            hasOlder: false
        )))
        let model = clock.map { clock in
            AidenBotSessionModel(botID: botID, transport: transport, now: { clock.now })
        } ?? AidenBotSessionModel(botID: botID, transport: transport)
        model.attachmentsSupported = supported
        await model.load()
        return model
    }

    private let photo: @MainActor () async throws -> AidenAttachmentUpload = {
        .image(name: "receipt.png", mimeType: "image/png", data: Data([0x89, 0x50, 0x4e, 0x47]))
    }
    private let notes: @MainActor () async throws -> AidenAttachmentUpload = {
        .text(name: "notes.md", mimeType: "text/markdown", text: "# Groceries")
    }

    func testStagedPhotosAndFilesGoWithTheNextMessageOnly() async throws {
        let transport = FakeBotSessionTransport()
        let model = try await loaded(transport)
        XCTAssertTrue(model.canAttach)
        let failures = await model.attach([photo, notes])
        XCTAssertEqual(failures, 0)
        XCTAssertEqual(transport.uploads.count, 2)
        let staged = model.pendingAttachments.map(\.id)
        XCTAssertEqual(staged.count, 2)
        XCTAssertNotNil(model.attachmentImageData(staged[0]), "the photo shows as a thumbnail")
        XCTAssertNil(model.attachmentImageData(staged[1]), "a file has no thumbnail")

        let sent = await model.send("What did I spend?")
        XCTAssertTrue(sent)
        XCTAssertEqual(transport.sendAttachmentIds, [staged])
        XCTAssertTrue(model.pendingAttachments.isEmpty)
        XCTAssertEqual(model.outbox.last?.attachments.map(\.id), staged, "the bubble keeps its chips")

        _ = await model.send("And yesterday?")
        XCTAssertEqual(transport.sendAttachmentIds.last, .some(nil), "the next message carries none")
    }

    func testPhotosAloneSendButAnEmptyMessageDoesNot() async throws {
        let transport = FakeBotSessionTransport()
        let model = try await loaded(transport)
        let empty = await model.send("   ")
        XCTAssertFalse(empty)
        await model.attach([photo])
        let sent = await model.send("  ")
        XCTAssertTrue(sent)
        XCTAssertEqual(transport.sendTexts, [""])
        XCTAssertEqual(transport.sendAttachmentIds.first??.count, 1)
    }

    func testAFailedUploadKeepsTheOthersAndSaysSo() async throws {
        let transport = FakeBotSessionTransport()
        transport.failUpload(at: 1)
        let model = try await loaded(transport)
        let failures = await model.attach([photo, notes, photo])
        XCTAssertEqual(failures, 1)
        XCTAssertEqual(model.pendingAttachments.count, 2)
        XCTAssertNotNil(model.errorMessage)
    }

    func testRemovingAStagedFileTakesItOffTheMacToo() async throws {
        let transport = FakeBotSessionTransport()
        let model = try await loaded(transport)
        await model.attach([photo, notes])
        let removed = try XCTUnwrap(model.pendingAttachments.first?.id)
        await model.removeAttachment(removed)
        XCTAssertEqual(transport.removedAttachmentIds, [removed])
        XCTAssertFalse(model.pendingAttachments.contains { $0.id == removed })
        _ = await model.send("Just the notes")
        XCTAssertEqual(transport.sendAttachmentIds.first??.contains(removed), false)
    }

    func testAMessageWhoseUploadsExpiredAsksForThemAgainAndKeepsItsWords() async throws {
        let transport = FakeBotSessionTransport()
        let clock = Clock()
        let model = try await loaded(transport, clock: clock)
        await model.attach([photo])
        // The uploads outlive their ten minutes on the Mac before the message goes.
        clock.now = Date(timeIntervalSince1970: 4_102_444_800 + 1)
        _ = await model.send("Read this")
        XCTAssertTrue(transport.sendKeys.isEmpty, "a send the Mac would refuse never goes out")
        let failed = try XCTUnwrap(model.outbox.last)
        XCTAssertTrue(model.attachmentsExpired(failed))
        let retried = await model.retrySend(failed.id)
        XCTAssertFalse(retried, "Try again can't succeed with uploads that are gone")
        XCTAssertEqual(model.reattach(failed.id, into: "  "), "Read this")
        XCTAssertTrue(model.outbox.isEmpty)
    }

    func testAMacThatNoLongerHoldsTheUploadsLeadsToAttachAgain() async throws {
        let transport = FakeBotSessionTransport()
        let model = try await loaded(transport)
        await model.attach([notes])
        let body = try AidenRemoteJSONDecoder.decode(
            AidenRemoteErrorEnvelope.Body.self,
            from: Data(#"{"code":"handle_invalid","message":"gone","requestId":"req_test_1","retryable":false}"#.utf8)
        )
        transport.failNextSend(with: AidenRemoteClientError.server(statusCode: 409, body: body))
        _ = await model.send("Summarise")
        let failed = try XCTUnwrap(model.outbox.last)
        XCTAssertTrue(model.attachmentsExpired(failed))
        // Something typed since stays, after the message's own words.
        XCTAssertEqual(model.reattach(failed.id, into: "Also the totals"), "Summarise\n\nAlso the totals")
        XCTAssertNil(model.reattach(failed.id, into: ""), "it comes back once")
    }

    func testAMacWithoutBotAttachmentsOffersNoPlus() async throws {
        let transport = FakeBotSessionTransport()
        let model = try await loaded(transport, supported: false)
        XCTAssertFalse(model.canAttach)
        let failures = await model.attach([photo])
        XCTAssertEqual(failures, 1)
        XCTAssertTrue(transport.uploads.isEmpty)
    }
}
