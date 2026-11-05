import Foundation
import XCTest
@testable import AidenOnTheGo

@MainActor
final class AidenBotPlanTests: XCTestCase {
    func section() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "contract", withExtension: "json"))
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(root["contractRevision"] as? Int, 58)
        return try XCTUnwrap(root["botPlans"] as? [String: Any])
    }
    func decode<T: Decodable>(_ type: T.Type, _ value: Any) throws -> T {
        try AidenRemoteJSONDecoder.decode(type, from: JSONSerialization.data(withJSONObject: value))
    }
    func testCanonicalSnapshotAndOrderedPlanFramesDecode() throws {
        let fixture = try section()
        let session = try decode(AidenBotSession.self, fixture["session"]!)
        XCTAssertEqual(session.seq, 0)
        assertHostFolderReview(try XCTUnwrap(session.plan))
        assertHostFolderReview(try decode(AidenRemoteBotPlan.self, fixture["pending"]!))
        assertHostFolderReview(try decode(AidenRemoteBotPlan.self, fixture["active"]!))
        let events = try XCTUnwrap(fixture["events"] as? [Any]).map { try decode(AidenBotSessionEvent.self, $0) }
        XCTAssertEqual(events.map(\.seq), [0, 1, 2])
        guard case let .snapshot(first) = events[0].kind,
              case let .plan(active) = events[1].kind,
              case let .plan(cleared) = events[2].kind else {
            XCTFail("Expected the canonical snapshot, active-plan update, and clear")
            return
        }
        assertHostFolderReview(try XCTUnwrap(first.plan))
        assertHostFolderReview(try XCTUnwrap(active))
        XCTAssertNil(cleared)
    }
}

extension AidenBotPlanTests {
    /// Independent expected review text: these are the strings the native card renders verbatim.
    private func assertHostFolderReview(_ plan: AidenRemoteBotPlan, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(plan.items.map(\.line), [
            "Google Calendar · create events (up to 5)",
            "Commands · in its own folder",
            "Files · change /Volumes/Backup/Family Photos for this plan",
            "Files · read ~/Documents/Tax Records",
        ], file: file, line: line)
        XCTAssertEqual(plan.items.map(\.details), [
            ["Create event"], [],
            ["/Volumes/Backup/Family Photos", "Read and change · allowed once, for this plan only"],
            ["~/Documents/Tax Records"],
        ], file: file, line: line)
        XCTAssertEqual(plan.items.first?.used, 0, file: file, line: line)
        XCTAssertEqual(plan.items.first?.max, 5, file: file, line: line)
        for item in plan.items.dropFirst() {
            XCTAssertNil(item.used, file: file, line: line)
            XCTAssertNil(item.max, file: file, line: line)
        }
    }
    private func assertReadOnlyFolderReview(_ plan: AidenRemoteBotPlan) {
        XCTAssertEqual(plan.planId, "plan-read-only-folder-56")
        XCTAssertEqual(plan.status, .pending)
        XCTAssertEqual(plan.items.map(\.line), ["Files · read /Volumes/Archive/Tax Records for this plan"])
        XCTAssertEqual(plan.items.map(\.details), [["/Volumes/Archive/Tax Records", "Read only · allowed once, for this plan only"]])
        XCTAssertNil(plan.items.first?.used)
        XCTAssertNil(plan.items.first?.max)
    }
    func snapshot() throws -> AidenBotSession { try decode(AidenBotSession.self, section()["session"]!) }
    func plan(_ key: String = "pending") throws -> AidenRemoteBotPlan { try decode(AidenRemoteBotPlan.self, section()[key]!) }
    func frame(_ value: Any, seq: Int = 1) throws -> AidenBotSessionEvent {
        let session = try snapshot()
        return try decode(AidenBotSessionEvent.self, ["protocolVersion": 1, "botId": session.botId, "epoch": session.epoch, "seq": seq, "type": "plan", "payload": ["plan": value]])
    }
    private func loaded(supported: Bool = true) async throws -> (AidenBotSessionModel, PlanTestTransport) {
        let transport = PlanTestTransport(snapshot: try snapshot())
        let model = AidenBotSessionModel(botID: transport.snapshot.botId, transport: transport, plansSupported: supported)
        await model.load()
        return (model, transport)
    }
    func testCanonicalPendingActiveClearAndLegacyAreHostAuthoritative() async throws {
        let (model, _) = try await loaded()
        XCTAssertEqual(model.plan, try plan())
        assertHostFolderReview(try XCTUnwrap(model.plan))
        XCTAssertTrue(model.composerHeldForPlan)
        let sent = await model.send("Keep this draft")
        XCTAssertFalse(sent)
        let events = try XCTUnwrap(section()["events"] as? [Any])
        _ = await model.apply(try decode(AidenBotSessionEvent.self, events[1]))
        XCTAssertEqual(model.plan, try plan("active"))
        assertHostFolderReview(try XCTUnwrap(model.plan))
        XCTAssertEqual(model.plan?.completedSteps, 1)
        XCTAssertFalse(model.composerHeldForPlan)
        _ = await model.apply(try decode(AidenBotSessionEvent.self, events[2]))
        XCTAssertNil(model.plan)
        let legacy = try XCTUnwrap(section()["legacy"] as? [String: Any])
        XCTAssertNil(try decode(AidenBotSession.self, legacy["session"]!).plan)
        for event in try XCTUnwrap(legacy["events"] as? [Any]) { _ = try decode(AidenBotSessionEvent.self, event) }
        let readOnly = try plan("readOnlyFolderPlan")
        assertReadOnlyFolderReview(readOnly)
        _ = await model.apply(try frame(section()["readOnlyFolderPlan"]!, seq: 3))
        assertReadOnlyFolderReview(try XCTUnwrap(model.plan))
        XCTAssertTrue(model.composerHeldForPlan, "The exact outside read grant still requires a person's answer")
    }
    func testStrictShapeBoundsCountersNullAndPrivateFields() throws {
        let base = try XCTUnwrap(section()["pending"] as? [String: Any])
        var bad: [[String: Any]] = []
        for key in ["planId", "status", "title", "why", "steps", "items"] { var copy = base; copy.removeValue(forKey: key); bad.append(copy) }
        for key in ["expiresAt", "from"] { var copy = base; copy[key] = NSNull(); bad.append(copy) }
        for key in ["botId", "revision", "authorization", "proposal", "id"] { var copy = base; copy[key] = "private"; bad.append(copy) }
        for (key, value): (String, Any) in [("title", String(repeating: "x", count: 81)), ("why", " "), ("planId", "../plan"), ("status", "approved"), ("from", "a\u{202E}b"), ("why", "a\u{2028}b"), ("steps", []), ("items", []), ("expiresAt", "2026-02-30T12:00:00Z")] {
            var copy = base; copy[key] = value; bad.append(copy)
        }
        let step: [String: Any] = ["text": "Do this", "status": "pending"]
        for steps: Any in [Array(repeating: step, count: 11), [["text": "Do this", "status": "done", "id": "private"]], [["text": String(repeating: "x", count: 201), "status": "pending"]]] { var copy = base; copy["steps"] = steps; bad.append(copy) }
        let item: [String: Any] = ["line": "Calendar", "details": []]
        for fields: [String: Any] in [["used": 0], ["max": 1], ["used": NSNull(), "max": 1], ["used": "1", "max": 2], ["used": true, "max": 2], ["used": -1, "max": 2], ["used": 3, "max": 2], ["used": 0, "max": 26], ["used": 0, "max": 0], ["id": "private"], ["fileScope": ["path": "/private/host-only"]], ["details": Array(repeating: "detail", count: 7)], ["details": [NSNull()]], ["line": String(repeating: "x", count: 121)]] {
            var copy = base; copy["items"] = [item.merging(fields) { _, new in new }]; bad.append(copy)
        }
        for object in bad { XCTAssertThrowsError(try decode(AidenRemoteBotPlan.self, object), "\(object.keys.sorted())") }
        var maximum = base
        maximum["title"] = String(repeating: "🙂", count: 80)
        maximum["why"] = String(repeating: "w", count: 300)
        maximum["steps"] = Array(repeating: ["text": String(repeating: "s", count: 200), "status": "pending"], count: 10)
        maximum["items"] = Array(repeating: ["line": String(repeating: "i", count: 120), "details": Array(repeating: String(repeating: "d", count: 160), count: 6), "used": 25, "max": 25] as [String: Any], count: 8)
        let decoded = try decode(AidenRemoteBotPlan.self, maximum)
        XCTAssertEqual(decoded.steps.count, 10)
        XCTAssertEqual(decoded.items.last?.used, 25)
        for payload: [String: Any] in [[:], ["plan": NSNull(), "extra": 1], ["plan": "invalid"]] {
            let session = try snapshot()
            XCTAssertThrowsError(try decode(AidenBotSessionEvent.self, ["protocolVersion": 1, "botId": session.botId, "epoch": session.epoch, "seq": 1, "type": "plan", "payload": payload]))
        }
    }
    func testStrictDatesMatchHostFullOffsetRangeAndCalendar() throws {
        let base = try XCTUnwrap(section()["active"] as? [String: Any])
        for date in ["2026-11-04T13:00:00.123456789012+23:59", "2026-11-04T13:00:00-23:59", "0000-02-29T00:00:00Z"] {
            var value = base; value["expiresAt"] = date
            let plan = try decode(AidenRemoteBotPlan.self, value)
            XCTAssertEqual(plan.expiresAt, date)
            XCTAssertNotNil(plan.expiry)
        }
        for date in ["2026-02-30T12:00:00Z", "2026-11-04T24:00:00Z", "2026-11-04T13:00:60Z", "2026-11-04T13:00:00+24:00", "2026-11-04T13:00:00+00:60", "2026-11-04 13:00:00Z"] {
            var value = base; value["expiresAt"] = date
            XCTAssertThrowsError(try decode(AidenRemoteBotPlan.self, value))
        }
    }
    func testSameChoiceUnknownOutcomeKeepsKeyAndDifferentChoiceUsesNewBody() async throws {
        for failure in [URLError(.networkConnectionLost) as Error, try serverError(503, code: "internal_error")] {
            let (model, transport) = try await loaded()
            transport.failure = failure
            let failed = await model.respondToPlan(.approve)
            XCTAssertFalse(failed)
            XCTAssertEqual(model.plan, try plan())
            XCTAssertNotNil(model.planError)
            let retry = await model.respondToPlan(.approve)
            XCTAssertTrue(retry)
            XCTAssertEqual(transport.calls.map(\.decision), [.approve, .approve])
            XCTAssertEqual(transport.calls[0].key, transport.calls[1].key)
            XCTAssertEqual(model.plan?.status, .pending, "A receipt must not invent a host state")
        }
        let (model, transport) = try await loaded()
        transport.failure = URLError(.networkConnectionLost)
        _ = await model.respondToPlan(.approve)
        transport.receipt = "{\"planId\":\"plan-fixture-56\",\"status\":\"stopped\"}"
        let declined = await model.respondToPlan(.notNow)
        XCTAssertTrue(declined)
        XCTAssertEqual(transport.calls.map(\.decision), [.approve, .notNow])
        XCTAssertNotEqual(transport.calls[0].key, transport.calls[1].key)
        XCTAssertEqual(model.plan?.status, .pending)
    }
    func serverError(_ status: Int = 409, code: String = "plan_expired") throws -> Error {
        let envelope = try decode(AidenRemoteErrorEnvelope.self, ["error": ["code": code, "message": "Gone", "requestId": "plan-test", "retryable": false]])
        return AidenRemoteClientError.server(statusCode: status, body: envelope.error)
    }
    func testExpiredRemovesOnlyMatchingUnchangedCardAndReplacementStaysAnswerable() async throws {
        let (model, transport) = try await loaded()
        transport.failure = try serverError()
        _ = await model.respondToPlan(.approve)
        XCTAssertNil(model.plan)
        var replacement = try XCTUnwrap(section()["pending"] as? [String: Any]); replacement["planId"] = "plan-replacement"
        _ = await model.apply(try frame(replacement))
        XCTAssertEqual(model.plan?.planId, "plan-replacement")
        transport.receipt = "{\"planId\":\"plan-replacement\",\"status\":\"active\"}"
        let accepted = await model.respondToPlan(.approve)
        XCTAssertTrue(accepted)
    }
    func testIdenticalPendingSnapshotDoesNotDiscardExpiredAnswer() async throws {
        for decision in [AidenBotPlanDecision.approve, .notNow] {
            let (model, transport) = try await loaded()
            let entered = expectation(description: "answer awaiting host")
            let barrier = PlanTestBarrier(entered: entered)
            transport.barrier = barrier
            transport.failure = try serverError()
            let answer = Task { await model.respondToPlan(decision) }
            await fulfillment(of: [entered], timeout: 3)
            var session = try XCTUnwrap(section()["session"] as? [String: Any])
            session["seq"] = 1
            let event = try decode(AidenBotSessionEvent.self, [
                "protocolVersion": 1, "botId": session["botId"]!, "epoch": session["epoch"]!,
                "seq": 1, "type": "snapshot", "payload": ["session": session],
            ])
            _ = await model.apply(event)
            XCTAssertEqual(model.plan, try plan())
            XCTAssertTrue(model.composerHeldForPlan)
            await barrier.release()
            _ = await answer.value
            XCTAssertNil(model.plan, "A matching host refusal must clear the unchanged card")
            XCTAssertFalse(model.composerHeldForPlan)
            XCTAssertTrue(model.respondingPlanIds.isEmpty)
            XCTAssertEqual(transport.calls.map(\.decision), [decision])
        }
    }
    func testLateFailureConflictOrSuccessCannotAlterReplacementOrClear() async throws {
        for outcome in ["failure", "conflict", "success", "clear", "same-id-active", "generation", "release"] {
            let (model, transport) = try await loaded()
            let entered = expectation(description: "request entered")
            let barrier = PlanTestBarrier(entered: entered)
            transport.barrier = barrier
            if outcome == "failure" { transport.failure = URLError(.networkConnectionLost) }
            if outcome == "conflict" || outcome == "same-id-active" { transport.failure = try serverError() }
            let task = Task { await model.respondToPlan(.approve) }
            await fulfillment(of: [entered], timeout: 3)
            let duplicate = await model.respondToPlan(.notNow)
            XCTAssertFalse(duplicate)
            if outcome == "release" { model.release() }
            else if outcome == "generation" { model.reopenFeed() }
            else if outcome == "clear" { _ = await model.apply(try frame(NSNull())) }
            else if outcome == "same-id-active" { _ = await model.apply(try frame(section()["active"]!)) }
            else {
                var replacement = try XCTUnwrap(section()["pending"] as? [String: Any]); replacement["planId"] = "plan-replacement"
                _ = await model.apply(try frame(replacement))
                XCTAssertTrue(model.canRespondToPlan(try XCTUnwrap(model.plan)))
            }
            let expected = model.plan
            await barrier.release()
            _ = await task.value
            XCTAssertEqual(model.plan, expected)
            XCTAssertNil(model.planError)
            XCTAssertTrue(model.respondingPlanIds.isEmpty)
            XCTAssertEqual(transport.calls.count, 1)
        }
    }
    func testHostWithoutCapabilityDoesNotHoldComposerOrAnswerAndActiveOnlyOffersStop() async throws {
        let (old, transport) = try await loaded(supported: false)
        XCTAssertNil(old.plan)
        XCTAssertFalse(old.composerHeldForPlan)
        let unsupported = await old.respondToPlan(.approve)
        XCTAssertFalse(unsupported)
        XCTAssertTrue(transport.calls.isEmpty)
        let (active, activeTransport) = try await loaded()
        _ = await active.apply(try frame(section()["active"]!))
        let approve = await active.respondToPlan(.approve)
        XCTAssertFalse(approve)
        activeTransport.receipt = "{\"planId\":\"plan-fixture-56\",\"status\":\"stopped\"}"
        let stop = await active.respondToPlan(.stop)
        XCTAssertTrue(stop)
        XCTAssertEqual(active.plan?.status, .active)
        XCTAssertEqual(activeTransport.calls.map(\.decision), [.stop])
    }
    func testReceiptWrongIdentityOrPendingIsRejectedWithoutSettlingCard() async throws {
        for receipt in ["{\"planId\":\"different-plan\",\"status\":\"active\"}", "{\"planId\":\"plan-fixture-56\",\"status\":\"pending\"}"] {
            let (model, transport) = try await loaded(); transport.receipt = receipt
            let result = await model.respondToPlan(.approve)
            XCTAssertFalse(result)
            XCTAssertEqual(model.plan, try plan())
            XCTAssertNotNil(model.planError)
        }
    }
}

private actor PlanTestBarrier {
    let entered: XCTestExpectation
    var continuation: CheckedContinuation<Void, Never>?
    init(entered: XCTestExpectation) { self.entered = entered }
    func wait() async { await withCheckedContinuation { continuation = $0; entered.fulfill() } }
    func release() { continuation?.resume(); continuation = nil }
}
private final class PlanTestTransport: AidenBotSessionTransport, @unchecked Sendable {
    struct Call { let planId: String; let decision: AidenBotPlanDecision; let key: UUID }
    let snapshot: AidenBotSession
    var calls: [Call] = []
    var failure: Error?
    var barrier: PlanTestBarrier?
    var receipt = "{\"planId\":\"plan-fixture-56\",\"status\":\"active\"}"
    init(snapshot: AidenBotSession) { self.snapshot = snapshot }
    func respondBotPlan(botId: String, planId: String, request: AidenBotPlanRespondRequest, idempotencyKey: UUID) async throws -> AidenBotPlanRespondReceipt {
        calls.append(Call(planId: planId, decision: request.decision, key: idempotencyKey))
        await barrier?.wait()
        if let failure { self.failure = nil; throw failure }
        return try AidenRemoteJSONDecoder.decode(AidenBotPlanRespondReceipt.self, from: Data(receipt.utf8))
    }
    func botSession(botId: String) async throws -> AidenBotSession { snapshot }
    func botSessionEvents(botId: String) -> AsyncThrowingStream<AidenBotSessionEvent, Error> { AsyncThrowingStream { $0.finish() } }
    func sendBotMessage(botId: String, request: AidenBotMessageRequest, idempotencyKey: UUID) async throws -> AidenBotMessageReceipt { throw URLError(.unsupportedURL) }
    func resumeBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView { throw URLError(.unsupportedURL) }
    func dismissBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView { throw URLError(.unsupportedURL) }
    func stopBotSession(botId: String, idempotencyKey: UUID) async throws -> AidenBotSessionStateView { throw URLError(.unsupportedURL) }
    func answerBotQuestion(botId: String, waitId: String, request: AidenQuestionRespondRequest, idempotencyKey: UUID) async throws -> AidenBotQuestionAnswerReceipt { throw URLError(.unsupportedURL) }
    func respondToApproval(id: String, decision: AidenApprovalDecision, scope: AidenApprovalScope?, idempotencyKey: UUID) async throws -> AidenApprovalResponse { throw URLError(.unsupportedURL) }
    func requestBotConnection(botId: String, request: AidenBotConnectionRequest, idempotencyKey: UUID) async throws -> AidenBotConnectionRequestReceipt { throw URLError(.unsupportedURL) }
    func respondToBotRoutineProposal(botId: String, proposalId: String, request: AidenBotRoutineProposalRespondRequest, idempotencyKey: UUID) async throws -> AidenBotRoutineProposalRespondResult { throw URLError(.unsupportedURL) }
}
