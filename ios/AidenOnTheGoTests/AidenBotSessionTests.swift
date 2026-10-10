import XCTest
@testable import AidenOnTheGo

/// A scripted host for `AidenBotSessionModel`. Every request is recorded so a
/// test can assert what reached the Mac.
private final class FakeBotSessionTransport: AidenBotSessionTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var _sessions: [Result<AidenBotSession, Error>] = []
    private var _streams: [[AidenBotSessionEvent]] = []
    private var _sessionRequests = 0
    private var _streamRequests = 0
    private var _resumeKeys: [UUID] = []
    private var _sendKeys: [UUID] = []
    private var _sendTexts: [String] = []
    private var _sendErrors: [Error] = []
    private var _connectionKeys: [UUID] = []
    private var _resumeResults: [Result<AidenBotSessionStateView, Error>] = []
    private var _connectionError: Error?
    private var _proposalRequests: [(proposalId: String, decision: AidenBotRoutineProposalDecision, key: UUID)] = []
    private var _proposalResults: [Result<AidenBotRoutineProposalRespondResult, Error>] = []
    private var resumeGate: CheckedContinuation<Void, Never>?
    var holdResume = false

    private func locked<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func queueSession(_ result: Result<AidenBotSession, Error>) { locked { _sessions.append(result) } }
    func queueStream(_ events: [AidenBotSessionEvent]) { locked { _streams.append(events) } }
    func queueResume(_ result: Result<AidenBotSessionStateView, Error>) { locked { _resumeResults.append(result) } }
    func failConnections(with error: Error) { locked { _connectionError = error } }
    func failNextSend(with error: Error) { locked { _sendErrors.append(error) } }
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
    var connectionKeys: [UUID] { locked { _connectionKeys } }

    func releaseResume() {
        let gate = locked { () -> CheckedContinuation<Void, Never>? in
            defer { resumeGate = nil }
            return resumeGate
        }
        gate?.resume()
    }

    func botSession(botId: String) async throws -> AidenBotSession {
        let next = locked { () -> Result<AidenBotSession, Error>? in
            _sessionRequests += 1
            return _sessions.isEmpty ? nil : _sessions.removeFirst()
        }
        guard let next else { throw URLError(.notConnectedToInternet) }
        return try next.get()
    }

    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> {
        let events = locked { () -> [AidenBotSessionEvent] in
            _streamRequests += 1
            return _streams.isEmpty ? [] : _streams.removeFirst()
        }
        return AsyncThrowingStream { continuation in
            for event in events { continuation.yield(event) }
            if events.isEmpty {
                continuation.finish(throwing: URLError(.networkConnectionLost))
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
            return _sendErrors.isEmpty ? nil : _sendErrors.removeFirst()
        }
        if let error { throw error }
        return try AidenRemoteJSONDecoder.decode(
            AidenBotMessageReceipt.self,
            from: Data(#"{"submissionId":"17","deduped":false,"state":"running","interrupted":false}"#.utf8)
        )
    }

    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        locked { _resumeKeys.append(idempotencyKey) }
        if holdResume {
            await withCheckedContinuation { continuation in
                locked { resumeGate = continuation }
            }
        }
        let next = locked { _resumeResults.isEmpty ? nil : _resumeResults.removeFirst() }
        return try (next ?? .success(try AidenBotSessionStateView(state: .running))).get()
    }

    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        try AidenBotSessionStateView(state: .idle)
    }

    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView {
        try AidenBotSessionStateView(state: .idle)
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
        while transport.resumeKeys.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
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

    func testAmbiguousRetryFailureReusesItsKeyAndAnotherFailedTurnGetsANewOne() async throws {
        let transport = FakeBotSessionTransport()
        let model = await loadedModel(transport, try session(seq: 1, entries: [
            failedTurn("t1:failed", retryText: "First"),
        ]))
        transport.failNextSend(with: URLError(.networkConnectionLost))
        transport.failNextSend(with: URLError(.networkConnectionLost))

        let lost = await model.retry()
        XCTAssertFalse(lost)
        XCTAssertNotNil(model.errorMessage)
        _ = await model.retry()
        XCTAssertEqual(transport.sendKeys.count, 2)
        XCTAssertEqual(transport.sendKeys[0], transport.sendKeys[1], "Tapping Retry again replays the same request.")

        await model.apply(event(seq: 2, .entry(failedTurn("t2:failed", retryText: "Second"))))
        _ = await model.retry()
        XCTAssertEqual(transport.sendTexts.last, "Second")
        XCTAssertNotEqual(transport.sendKeys[2], transport.sendKeys[1], "A different failed turn is a new request.")
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
