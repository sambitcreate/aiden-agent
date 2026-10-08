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
    private var _connectionKeys: [UUID] = []
    private var _resumeResults: [Result<AidenBotSessionStateView, Error>] = []
    private var _connectionError: Error?
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

    var sessionRequests: Int { locked { _sessionRequests } }
    var streamRequests: Int { locked { _streamRequests } }
    var resumeKeys: [UUID] { locked { _resumeKeys } }
    var sendKeys: [UUID] { locked { _sendKeys } }
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
        locked { _sendKeys.append(idempotencyKey) }
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
        rejectsEntry("unknown entry type", ["type": "tool", "id": "t1"])
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
        {"botId":"bot_fixture_01","epoch":"epoch_1","seq":0,"state":"running","interrupted":false,"entries":[],"hasOlder":false,"question":\(question)}
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

/// A transport that serves one snapshot and records quick-reply answers.
private final class QuestionTransport: AidenBotSessionTransport, @unchecked Sendable {
    let snapshot: AidenBotSession
    private(set) var answers: [(waitId: String, key: UUID, request: AidenQuestionRespondRequest)] = []
    /// Thrown by the next answer instead of a receipt.
    var nextAnswerError: Error?

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

    func requestBotConnection(
        botId: String,
        request: AidenBotConnectionRequest,
        idempotencyKey: UUID
    ) async throws -> AidenBotConnectionRequestReceipt {
        throw URLError(.unsupportedURL)
    }
}
